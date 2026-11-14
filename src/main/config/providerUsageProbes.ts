/**
 * 用量查询：逐候选、逐 URL 的探测执行层（从 ConfigManager 原样搬出，方法体未改）。
 *
 * 链式 preflight、64KB 响应截断、redirect:"error" fail-closed 与单候选异常捕获都在此层，
 * 整体查询与弹窗单条测试走同一条执行路径。
 */
import { getAppLogger } from "../logging/sharedLogger";
import type { ProviderUsageResult } from "../../shared/types/providerUsage";
import type { UsageProbeAttempt, UsageProbeCandidate } from "./providerUsageProbe";
import { buildProbeFailureDetail, buildProbeHeaders, getByPath, parseUsageResponseBody, usageProbeUrls } from "./providerUsageProbe";
import type { Sub2ApiPanelContext } from "./providerUsageHost";
import { ProviderUsageEndpoint } from "./providerUsageEndpoint";
import { fetchSub2ApiPanelBalanceWithRefresh, type Sub2ApiPanelTokens } from "./sub2apiPanelSession";
import { usageProbeRequest } from "./usageProbeTransport";
import { updateUsageProbeSub2ApiTokens } from "./userUsageProbes";

// Provider 用量探针响应体上限：用量接口返回 JSON，正常远小于此值；超限截断
// （而非整体丢弃），防止恶意/异常网关用超大响应体拖垮内存，同时保留诊断信息。
const MAX_USAGE_RESPONSE_BYTES = 64 * 1024;

/** 用量查询编排的探测执行层。 */
export class ProviderUsageProbes extends ProviderUsageEndpoint {
	/** 带统一错误包装的探测执行：无 key 快速失败，其余走 runUsageProbes；成功时带上生效间隔。 */
	protected async runProviderUsageProbes(baseUrl: string, apiKey: string, requestHeaders: Record<string, string> | undefined, candidates: UsageProbeCandidate[], timeoutMs: number, intervalMinutes: number, panel?: Sub2ApiPanelContext): Promise<ProviderUsageResult> {
		// 无 key 时只可能 401，快速失败并给出提示。
		if (!apiKey) {
			return { success: false, error: this.translate("mainConfig.providerUsageNoKey") };
		}
		const result = (await this.runUsageProbes(baseUrl, apiKey, this.normalizeRequestHeaders(requestHeaders), candidates, timeoutMs, panel)) ?? {
			success: false,
			error: this.translate("mainConfig.providerUsageFailed"),
		};
		return result.success ? { ...result, intervalMinutes } : result;
	}

	/**
	 * 逐候选、逐 URL 尝试探测；命中的首个成功结果即返回，全部未命中返回 undefined
	 * （文案由调用方决定：整体查询 vs 单条测试）。链式 preflight、64KB 响应截断、
	 * redirect:"error" fail-closed 与单候选异常捕获都在此层，探测行为对两条入口完全一致。
	 * timeoutMs 由 per-provider 配置（默认 10s）传入：用量查询首包超时按用户设定收紧，
	 * 不再固定 45s（那只对模型连接探测合理）。
	 */
	private async runUsageProbes(baseUrl: string, apiKey: string, extraHeaders: Record<string, string>, candidates: UsageProbeCandidate[], timeoutMs: number, panel?: Sub2ApiPanelContext): Promise<ProviderUsageResult | undefined> {
		const startedAt = Date.now();
		// 收集每次失败尝试，全部未命中时拼进 detail（URL + 状态码 + 摘要 + 归纳提示），
		// 让用户在弹窗里能直接排查（地址对不对 / 鉴权失效 / 接口变更）。
		const attempts: UsageProbeAttempt[] = [];
		// 逐候选、逐 URL 尝试；命中的首个成功即返回。
		for (const candidate of candidates) {
			// 链式预检（如 xAI 需先查 identity 拿 userId）：先请求预检端点，把响应里
			// 的字段注入主请求头（x-userid）。预检失败（不可达/非 JSON/无字段）则整个候选跳过。
			const preflightHeaders: Record<string, string> = {};
			if (candidate.preflight) {
				const preflightUrls = usageProbeUrls({ path: candidate.preflight.path, absoluteUrl: candidate.preflight.absoluteUrl, rootPath: false }, baseUrl, (url) => this.ensureVersionPath(url));
				let captured: unknown;
				for (const preflightUrl of preflightUrls) {
					const preflightResult = await usageProbeRequest(preflightUrl, {
						method: "GET",
						headers: this.withOpenAiSdkUserAgent(buildProbeHeaders(candidate.preflight.headers, apiKey)),
						timeoutMs,
						maxBytes: MAX_USAGE_RESPONSE_BYTES,
					});
					if ("error" in preflightResult) continue;
					if (preflightResult.status < 200 || preflightResult.status >= 300) continue;
					let preflightBody: unknown = null;
					try {
						preflightBody = JSON.parse(preflightResult.raw);
					} catch {
						// 非 JSON：不是预期的预检端点，换下一个 URL。
					}
					captured = getByPath(preflightBody, candidate.preflight.capture.path);
					if (typeof captured === "string" && captured.trim() !== "") break;
				}
				if (typeof captured !== "string" || captured.trim() === "") continue;
				preflightHeaders[candidate.preflight.capture.header] = captured.trim();
			}

			const urls = usageProbeUrls(candidate, baseUrl, (url) => this.ensureVersionPath(url));
			for (const requestUrl of urls) {
				const result = await usageProbeRequest(requestUrl, {
					method: candidate.method ?? "GET",
					headers: this.withOpenAiSdkUserAgent({
						...buildProbeHeaders(candidate.headers, apiKey, {
							// 候选自带 Cookie 等独立鉴权时不能自动补 Bearer（双凭证可能被服务端拒绝，
							// 如 Token Rhythm 的 AMBIGUOUS_CREDENTIALS 400），由候选/用户探针显式声明。
							noBearer: candidate.noBearer === true,
						}),
						...preflightHeaders,
						...extraHeaders,
					}),
					...(candidate.method === "POST" && candidate.body !== undefined ? { body: JSON.stringify(candidate.body) } : {}),
					timeoutMs,
					maxBytes: MAX_USAGE_RESPONSE_BYTES,
				});
				if ("error" in result) {
					// 网络错误/超时/重定向拒绝：单个候选失败不阻断其它候选，记录后继续。
					// usageProbeRequest 已按 AbortError/TimeoutError 归一为 timeout，其余为 network。
					attempts.push({
						url: requestUrl,
						method: candidate.method ?? "GET",
						error: result.error,
					});
					continue;
				}
				const safeRaw = this.redactSecret(result.raw, apiKey);
				if (result.status < 200 || result.status >= 300) {
					// 非 2xx：可能是端点不存在，换下一个 URL/候选继续；记一笔尝试明细供失败时归因。
					attempts.push({
						url: requestUrl,
						method: candidate.method ?? "GET",
						status: result.status,
						// 只留前 240 字符的脱敏响应摘要，足够定位「路径不对/非法请求」类问题。
						...(safeRaw ? { body: safeRaw.slice(0, 240) } : {}),
					});
					continue;
				}
				let body: unknown;
				try {
					body = JSON.parse(result.raw);
				} catch {
					body = null;
				}
				const parsed = parseUsageResponseBody(body, safeRaw, candidate.parse);
				if (parsed.matched) {
					const result: ProviderUsageResult = {
						success: true,
						kind: parsed.kind,
						periods: parsed.periods,
						balance: parsed.balance,
						credits: parsed.credits,
						booster: parsed.booster,
						at: startedAt,
					};
					// Sub2API 面板余额合并：主端点 /v1/usage 解析出 credits（订阅/Key 额度形态，
					// 无钱包余额）且候选带面板 JWT 时，追加请求 /api/v1/auth/me 把账户钱包余额
					// 并进结果（与已用并列展示）；JWT 过期/接口异常只丢余额段，主结果照常返回，
					// 但带上失败原因（401=过期最常见），UI 显式提示而不是无感消失。
					if (candidate.panelBalance && parsed.kind !== "balance" && !parsed.balance) {
						// 面板 JWT 可能在两次查询之间过期：按 exp/401 就地续期（不后台定时转 token，
						// 上游 refresh 是单次轮转的），续期成功的新 token 对由 fetchSub2ApiPanelBalance 回写。
						const merged = await this.fetchSub2ApiPanelBalance(baseUrl, { accessToken: candidate.panelBalance.token, ...(panel?.refreshToken ? { refreshToken: panel.refreshToken } : {}) }, timeoutMs, panel);
						if (merged.ok) result.balance = merged.balance;
						else result.panelBalanceError = merged.reason;
					}
					return result;
				}
				// 2xx 但结构不匹配：不是预期的 usage 端点，继续探测；记一笔供失败归因（接口变更信号）。
				attempts.push({ url: requestUrl, method: candidate.method ?? "GET", kind: "shape" });
			}
		}

		// 全部候选未命中：拼上尝试明细返回失败结果（比通用文案多给「试了哪些 URL、为什么失败」），
		// 无任何尝试（如 preflight 全部失败）时仍返回 undefined 交由调用方决定最终文案。
		if (attempts.length === 0) {
			return undefined;
		}
		return {
			success: false,
			error: this.translate("mainConfig.providerUsageFailed"),
			detail: buildProbeFailureDetail(attempts, (key) => this.translate(key)),
		};
	}

	/**
	 * Sub2API 面板余额：GET {origin}/api/v1/auth/me（网页后台 JWT 鉴权，上游通用路由
	 * auth_handler.GetCurrentUser → userProfileResponse 内嵌 dto.User，余额在 data.balance）。
	 * 管理面挂在网关 host 根而非 OpenAI 兼容 base（/v1），故 rootPath 只取 origin；
	 * 请求头以 JWT 作为 Bearer 凭据（与 apiKey 同一形式）。
	 *
	 * 登录态过期由 sub2apiPanelSession 处理：本地 JWT exp 到点或 /auth/me 返 401 时，用
	 * refresh token 调 POST /api/v1/auth/refresh 换新令牌再重试一次，成功后（只有在 persist
	 * 上下文下）把轮转后的 token 对写回 usage-probes.json。失败时返回 { ok:false, reason }：
	 * 401 归因为 unauthorized（续期不可用 = 登录态真失效，需用户重贴），其余归为 failed；
	 * 面板余额是锦上添花段，绝不能拖垮主用量结果。
	 */
	private async fetchSub2ApiPanelBalance(baseUrl: string, tokens: Sub2ApiPanelTokens, timeoutMs: number, panel?: Sub2ApiPanelContext): Promise<{ ok: true; balance: ProviderUsageResult["balance"] } | { ok: false; reason: "unauthorized" | "failed" }> {
		// rootPath：跳过版本化补齐与路径段拼接，只取 origin + /api/v1/...。
		const balanceUrls = usageProbeUrls({ path: "/api/v1/auth/me", rootPath: true }, baseUrl, (url) => this.ensureVersionPath(url));
		const refreshUrls = usageProbeUrls({ path: "/api/v1/auth/refresh", rootPath: true }, baseUrl, (url) => this.ensureVersionPath(url));
		const outcome = await fetchSub2ApiPanelBalanceWithRefresh({
			balanceUrls,
			refreshUrls,
			tokens,
			timeoutMs,
			maxBytes: MAX_USAGE_RESPONSE_BYTES,
			request: usageProbeRequest,
			// 凭据一律走 Bearer（noBearer 不适用）；UA 仍由 OpenAI SDK 伪装，避免被网关拦截。
			buildAuthHeaders: (accessToken) => this.withOpenAiSdkUserAgent(buildProbeHeaders(undefined, accessToken)),
			refreshHeaders: () => this.withOpenAiSdkUserAgent({}),
			...(panel?.persist
				? {
						onTokensRefreshed: async (pair) => {
							// 上游轮转：旧 refresh token 已作废，不立即落盘就会把用户的登录态彻底弄丢。
							const saved = await updateUsageProbeSub2ApiTokens(panel.configDir, panel.provider, {
								panelJwt: pair.accessToken,
								...(pair.refreshToken ? { panelRefreshToken: pair.refreshToken } : {}),
							});
							if (!saved.ok) void getAppLogger()?.warn("config", "Sub2API panel token refresh not persisted", { provider: panel.provider, error: saved.error });
							else void getAppLogger()?.info("config", "Sub2API panel token refreshed", { provider: panel.provider });
						},
					}
				: {}),
		});
		if (outcome.ok) return { ok: true, balance: outcome.balance };
		return { ok: false, reason: outcome.reason };
	}
}
