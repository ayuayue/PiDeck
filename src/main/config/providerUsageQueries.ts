/**
 * 用量查询：对外编排（从 ConfigManager 原样搬出，方法体未改）。
 *
 * 三层模型：门控（providers[name].enabled）→ 模板路由（声明式模板优先，否则内置候选 +
 * 旧 probes 数组按 baseUrl/apiType 自动匹配）→ 超时（per-provider timeoutSecs，默认 10s）。
 * backend="dsh" 时配置/凭据走 DSH 链路（$DSH_HOME），未配置时回退 Pi 侧同 provider 配置
 * （display parity，见 loadUsageSettingsWithFallback）。
 */
import { normalizeDshDeepseekProvider } from "../../shared/dshProviderNames";
import type { ProviderUsageResult, UsageProbeBackend, UsageProbeProviderState, UsageProbeRecognition, UsageProbeSettingsResult, UsageProbeStatesResult, UsageProbeTestInput } from "../../shared/types/providerUsage";
import { getAppLogger } from "../logging/sharedLogger";
import { getPiAiCatalogIndex } from "../pi/piAiBuiltinCatalog";
import { piBuiltinSnapshotFromCatalog } from "./providerMigration";
import type { Sub2ApiPanelContext } from "./providerUsageHost";
import { ProviderUsageProbes } from "./providerUsageProbes";
import { candidateApplies, USAGE_PROBE_CANDIDATES } from "./providerUsageProbe";
import { resolveProviderUsageEndpoint } from "./providerUsageResolver";
import { buildDeclarativeUsageProbeTemplate, isDeclarativeTemplateId, USAGE_PROBE_CATEGORY_BY_TEMPLATE_ID } from "./usageProbeTemplates";
import type { UserUsageProbe } from "./userUsageProbes";
import { loadUsageProbeProviderConfigs, loadUserUsageProbes, loadUserUsageProbesDetailed } from "./userUsageProbes";

// 用量查询默认自动间隔（5 分钟；可被 per-provider 配置覆盖，0 = 不自动）。
const USAGE_PROBE_DEFAULT_INTERVAL_MINUTES = 5;

/** 用量查询对外的编排层（IPC / web / 徽章状态表共用的入口）。 */
export class ProviderUsageQueries extends ProviderUsageProbes {
	/**
	 * 查询 provider 用量/余额（三层模型，全部按 provider 名路由）：
	 * 1. 门控：providers[name].enabled === false → 不查（返回「未启用」结构化结果，
	 *    UI 据此显示小按钮引导配置）；
	 * 2. 模板路由：配置了声明式模板（general/newapi）→ 用模板构建候选（覆盖字段生效）；
	 *    未配置 → 内置候选表 + 旧 probes 数组按 baseUrl/apiType 自动匹配（内置默认开）；
	 * 3. 超时：per-provider timeoutSecs（默认 10s）。
	 * backend="dsh" 时配置/凭据走 DSH 链路（$DSH_HOME）：DSH 侧已配置则该配置为准；
	 * 未配置时回退 Pi 侧同 provider 配置（display parity，见 loadUsageSettingsWithFallback）。
	 * 全部失败时返回结构化错误，并对响应做密钥脱敏，避免把 token 回传给渲染层。
	 */
	async fetchProviderUsage(provider: string, backend: UsageProbeBackend = "pi"): Promise<ProviderUsageResult> {
		// DSH 官方 DeepSeek 的 provider 名归一化：llm.models 组 id（deepseek-official）与
		// 配置面规范名（deepseek）不一致，不归一就读不到 DSH 卡片保存的探针配置/端点。
		if (backend === "dsh") provider = normalizeDshDeepseekProvider(provider);
		const settingsDir = this.usageProbeSettingsDir(backend);
		// 1) 门控：未显式开启（enabled !== true）→ 快速返回，不发请求。
		// 「默认关」是刻意设计：内置识别/已配模板只表示有可查询路径，自动查询必须用户显式开启；
		// DSH 未单独配置时回退 Pi 同 provider 配置（display parity：Pi 已配置并显示 → DSH 卡片默认也显示）。
		const { settings, effectiveDir } = await this.loadUsageSettingsWithFallback(backend, provider, settingsDir);
		for (const error of settings.errors) {
			void getAppLogger()?.warn("config", "Usage probe config ignored", { error });
		}
		if (settings.config?.enabled !== true) {
			return {
				success: false,
				disabled: true,
				error: this.translate("mainConfig.providerUsageDisabled"),
			};
		}

		// 2) 解析 provider 端点（models.json → catalog 兜底；DSH backend 额外读 DSH 凭据库）。
		const resolved = await this.resolveUsageEndpoint(provider, backend);
		if (!resolved.matched || !resolved.baseUrl) {
			return { success: false, error: this.translate("mainConfig.providerUsageUnsupported") };
		}
		// 属性收窄在 await 后失效：立即取局部 const 供后续模板路由使用。
		const resolvedBaseUrl = resolved.baseUrl;
		const resolvedApiKey = resolved.apiKey ?? "";
		const api = this.normalizeApiType(resolved.apiType);
		const timeoutMs = (settings.config?.timeoutSecs ?? 10) * 1000;
		const intervalMinutes = settings.config?.intervalMinutes ?? USAGE_PROBE_DEFAULT_INTERVAL_MINUTES;
		// 面板登录态续期上下文：续期成功后把新 token 对写回「本次实际读取的配置目录」
		// （回退到 Pi 侧配置时 effectiveDir 指向 Pi 目录，回来仍读同一份）。
		const panelContext: Sub2ApiPanelContext = {
			provider,
			configDir: effectiveDir,
			...(settings.config?.panelRefreshToken ? { refreshToken: settings.config.panelRefreshToken } : {}),
			persist: true,
		};

		// 3) 模板路由：声明式模板优先（用户显式选择），否则内置 + 旧探针自动匹配。
		const template = settings.config?.template;
		if (template !== undefined && isDeclarativeTemplateId(template)) {
			const built = buildDeclarativeUsageProbeTemplate(template, settings.config ?? {}, {
				baseUrl: resolvedBaseUrl,
				apiKey: resolvedApiKey,
			});
			if ("error" in built) {
				return { success: false, error: built.error };
			}
			// candidates 而不是 candidate：火山方舟是双 Action 候选（Agent Plan / Coding Plan
			// 自动探测），其余模板 candidates 长度也是 1，走同一条执行路径。
			return this.runProviderUsageProbes(built.baseUrl, built.apiKey, resolved.headers, built.candidates, timeoutMs, intervalMinutes, panelContext);
		}

		const userProbes = await loadUserUsageProbes(effectiveDir);
		for (const error of userProbes.errors) {
			void getAppLogger()?.warn("config", "User usage probe config ignored", { error });
		}
		const applicable = [...USAGE_PROBE_CANDIDATES, ...userProbes.candidates].filter((c) => candidateApplies(c, resolvedBaseUrl, api));
		if (applicable.length === 0) {
			return { success: false, error: this.translate("mainConfig.providerUsageUnsupported") };
		}
		return this.runProviderUsageProbes(resolvedBaseUrl, resolvedApiKey, resolved.headers, applicable, timeoutMs, intervalMinutes, panelContext);
	}

	/**
	 * 打开探针配置弹窗时的数据：该 provider 已保存配置 + 内置模板自动识别结果。
	 * 识别 = 解析端点后按 baseUrl/apiType 匹配内置候选（带 templateId 的），
	 * 未命中返回 null（弹窗回落到声明式模板选择）。backend 决定配置目录（pi/dsh）。
	 */
	async getUsageProbeSettings(provider: string, backend: UsageProbeBackend = "pi"): Promise<UsageProbeSettingsResult> {
		// 同 fetchProviderUsage：DSH 组 id 别名先归一，才能读回以规范名保存的配置。
		if (backend === "dsh") provider = normalizeDshDeepseekProvider(provider);
		const { settings: loaded, effectiveDir } = await this.loadUsageSettingsWithFallback(backend, provider, this.usageProbeSettingsDir(backend));
		// 旧版 probes 数组命中回显：手写/历史探针没有声明式配置，弹窗据此预填 Cookie 模板字段迁移。
		// 回退语义下旧版 probes 也来自 effectiveDir（Pi 目录），弹窗看到的迁移源与实际查询一致。
		const legacyProbes = await this.matchLegacyProbesForProvider(provider, backend, effectiveDir);
		return {
			...(loaded.config ? { config: loaded.config } : {}),
			recognized: await this.recognizeUsageTemplate(provider, backend),
			templates: [],
			errors: loaded.errors,
			...(legacyProbes.length > 0 ? { legacyProbes } : {}),
		};
	}

	/**
	 * 按 provider 查找命中的旧版探针（usage-probes.json 的 probes 数组）。
	 * 匹配规则与运行时合并探测一致（candidateApplies：baseUrlContains / apiTypes），
	 * 保证「弹窗看到的迁移源」与「实际查询时生效的探针」是同一批。
	 */
	private async matchLegacyProbesForProvider(provider: string, backend: UsageProbeBackend = "pi", dir = this.usageProbeSettingsDir(backend)): Promise<UserUsageProbe[]> {
		const resolved = await this.resolveUsageEndpoint(provider, backend);
		if (!resolved.matched || !resolved.baseUrl) return [];
		const api = this.normalizeApiType(resolved.apiType);
		const loaded = await loadUserUsageProbesDetailed(dir);
		const hits: UserUsageProbe[] = [];
		for (let index = 0; index < loaded.candidates.length; index += 1) {
			const probe = loaded.probes[index];
			const candidate = loaded.candidates[index];
			if (probe && candidate && candidateApplies(candidate, resolved.baseUrl, api)) {
				hits.push(probe);
			}
		}
		return hits;
	}

	/** 内置模板自动识别（零配置生效路径）：命中返回 templateId + 面向用户的类别。 */
	async recognizeUsageTemplate(provider: string, backend: UsageProbeBackend = "pi"): Promise<UsageProbeRecognition | null> {
		const resolved = await this.resolveUsageEndpoint(provider, backend);
		if (!resolved.matched || !resolved.baseUrl) return null;
		return this.matchBuiltinRecognition(resolved.baseUrl, resolved.apiType);
	}

	/**
	 * 由已解析的端点判定内置候选命中（recognizeUsageTemplate 与批量状态表共用同一规则，
	 * 避免两处各自维护一份「哪些算内置」而漂移）。
	 */
	private matchBuiltinRecognition(baseUrl: string, apiType: string | undefined): UsageProbeRecognition | null {
		const api = this.normalizeApiType(apiType);
		for (const candidate of USAGE_PROBE_CANDIDATES) {
			if (!candidate.templateId) continue;
			if (candidateApplies(candidate, baseUrl, api)) {
				const category = USAGE_PROBE_CATEGORY_BY_TEMPLATE_ID[candidate.templateId];
				return { templateId: candidate.templateId, category: category ?? "balance" };
			}
		}
		return null;
	}

	/**
	 * 批量读取用量查询状态表（徽章开关 + 启动预热选源）：
	 * 每个 provider 给出「生效开关 / 是否已配置 / 是否内置识别 / 生效模板 / 生效间隔」。
	 *
	 * 生效开关 = 显式 enabled ?? false（默认关，显式开启才真正查询）：
	 * - 内置识别/已配模板只说明「有可查询路径」，不代表自动开；
	 * - 只有用户自己打开（徽章里的开关或用量查询弹窗的「是否启用」）才写 enabled=true；
	 * - 好处：升级后不会因为内置识别命中而默默对一批网关扇出请求。
	 * 只回状态，绝不回传 apiKey/accessToken/cookie。
	 */
	async listUsageProbeStates(backend: UsageProbeBackend = "pi", providers: string[] = []): Promise<UsageProbeStatesResult> {
		const settingsDir = this.usageProbeSettingsDir(backend);
		const [saved, modelsRes, authRes] = await Promise.all([loadUsageProbeProviderConfigs(settingsDir), this.getModelsConfig(), this.getAuthConfig()]);
		// DSH 未单独配置时回退 Pi 侧同 provider 配置（与 loadUsageSettingsWithFallback 同语义，
		// 否则 DSH 卡片会显示「未配置/关闭」而实际查询走 Pi 配置——两处不一致）。
		const piSaved = backend === "dsh" ? (await loadUsageProbeProviderConfigs(this.configDir)).providers : undefined;

		const names = new Set<string>();
		if (backend === "pi") {
			// 卡片来源 = 模型页（models.json）+ 认证页（auth.json）并集，两边都要有徽章状态。
			for (const name of Object.keys(modelsRes.parsed?.providers ?? {})) names.add(name);
			for (const name of Object.keys(authRes.parsed ?? {})) names.add(name);
		}
		for (const name of Object.keys(saved.providers)) names.add(name);
		for (const name of providers) {
			const trimmed = name.trim();
			if (trimmed) names.add(trimmed);
		}

		// pi 侧一次读盘喂给全部 provider 的端点解析，避免逐条重复读 models/auth。
		const catalog = getPiAiCatalogIndex();
		const lookup = {
			getModelsConfig: async () => modelsRes,
			getAuthConfig: async () => authRes,
			catalogProvider: (name: string) => piBuiltinSnapshotFromCatalog(name, undefined, catalog),
		};

		const states: Record<string, UsageProbeProviderState> = {};
		for (const name of names) {
			const config = saved.providers[name] ?? piSaved?.[name];
			let recognized: UsageProbeRecognition | null;
			if (backend === "pi") {
				const resolved = await resolveProviderUsageEndpoint(lookup, name);
				recognized = resolved.matched && resolved.baseUrl ? this.matchBuiltinRecognition(resolved.baseUrl, resolved.apiType) : null;
			} else {
				recognized = await this.recognizeUsageTemplate(name, backend);
			}
			const template = config?.template ?? recognized?.templateId;
			states[name] = {
				enabled: config?.enabled ?? false,
				configured: config != null,
				recognized: recognized != null,
				...(template ? { template } : {}),
				intervalMinutes: config?.intervalMinutes ?? USAGE_PROBE_DEFAULT_INTERVAL_MINUTES,
			};
		}
		return { providers: states, errors: saved.errors };
	}

	/**
	 * 单条模板测试（配置弹窗「测试」按钮）：按模板 id 构建候选后直接探测。
	 * template 省略 = 自动识别内置模板；无内置且未给模板时返回错误。
	 * 密钥只在主进程发请求（配置覆盖字段经 buildDeclarativeUsageProbeTemplate 合并）。
	 */
	async testUsageProbe(input: UsageProbeTestInput): Promise<ProviderUsageResult> {
		const backend = input.backend ?? "pi";
		const resolved = await this.resolveUsageEndpoint(input.provider, backend);
		if (!resolved.matched || !resolved.baseUrl) {
			return { success: false, error: this.translate("mainConfig.providerUsageUnsupported") };
		}
		// 属性收窄在 await 后失效：立即取局部 const。
		const resolvedBaseUrl = resolved.baseUrl;
		const resolvedApiKey = resolved.apiKey ?? "";
		const timeoutMs = (input.timeoutSecs ?? 10) * 1000;

		// 显式模板优先；否则走内置自动识别（测「识别命中」这条零配置路径）。
		// 注意 backend 必须透传：DSH 弹窗测的是 DSH 链路的识别结果。
		const template = input.template?.trim() || (await this.recognizeUsageTemplate(input.provider, backend))?.templateId;
		if (!template) {
			return { success: false, error: this.translate("mainConfig.providerUsageUnsupported") };
		}

		// 声明式模板（general/newapi/cookie/volcengine/sub2api）：构建候选时可携带覆盖字段。
		if (template !== undefined && isDeclarativeTemplateId(template)) {
			const built = buildDeclarativeUsageProbeTemplate(
				template,
				{
					apiKey: input.apiKey,
					baseUrl: input.baseUrl,
					accessToken: input.accessToken,
					userId: input.userId,
					cookie: input.cookie,
					cookiePath: input.cookiePath,
					valuePath: input.valuePath,
					currencyPath: input.currencyPath,
					accessKeyId: input.accessKeyId,
					secretAccessKey: input.secretAccessKey,
					// 面板登录态不做主用量鉴权，但弹窗测试也要能看到钱包余额段（否则测出来总比真实查少一段）。
					// refresh token 不经过模板构建（模板只管挂 panelBalance 候选），由 panelContext 传给执行层。
					panelJwt: input.panelJwt,
				},
				{ baseUrl: resolvedBaseUrl, apiKey: resolvedApiKey },
			);
			if ("error" in built) {
				return { success: false, error: built.error };
			}
			// candidates：火山方舟双 Action 探测（Agent Plan / Coding Plan）依次尝试。
			// 弹窗测试也允许面板登录态就地续期，但 persist=false：用户未保存前不得静默改盘上的配置。
			const panelContext: Sub2ApiPanelContext = {
				provider: input.provider,
				configDir: "",
				...(input.panelRefreshToken ? { refreshToken: input.panelRefreshToken } : {}),
				persist: false,
			};
			return this.runProviderUsageProbes(built.baseUrl, built.apiKey, resolved.headers, built.candidates, timeoutMs, 0, panelContext);
		}

		// 内置模板：按 templateId 找候选（不可改写结构，测的是零配置路径本身）。
		const candidate = USAGE_PROBE_CANDIDATES.find((c) => c.templateId === template);
		if (!candidate) {
			return { success: false, error: this.translate("mainConfig.providerUsageUnsupported") };
		}
		return this.runProviderUsageProbes(resolvedBaseUrl, resolvedApiKey, resolved.headers, [candidate], timeoutMs, 0);
	}
}
