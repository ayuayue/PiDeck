/**
 * Sub2API 面板登录态的续期与余额查询（主进程，无 IO、传输层注入）。
 *
 * 背景：用量查询除了网关 apiKey（/v1/usage）之外，还能用网页后台登录态 JWT 追加查账户钱包
 * 余额（GET /api/v1/auth/me）。JWT 会过期，过期后余额段消失、用户得回浏览器重新复制——而
 * Sub2API 上游本来就提供 `POST /api/v1/auth/refresh`（body `{refresh_token}`，响应
 * `{code,message,data:{access_token,refresh_token,expires_in,token_type}}`）。
 *
 * 为什么是「到期才续」而不是「后台定时续」：
 * - refresh token 在服务端是**单次轮转**的（用过即删、同家族签发新的），定时续会把轮转次数和
 *   并发窗口放大到与用户无关的时段，两个用量查询（徽章轮询 + 弹窗测试）撞在一起时还会互相
 *   把对方的 token 变成「已被使用」；
 * - PiDeck 的用量查询本身就是按 intervalMinutes 低频触发的，把续期挂在「马上要发 /auth/me」
 *   这一刻，等价于定时续却零空闲网络请求，App 关着很久也不会白转 token；
 * - 续期只在两种信号下发生：本地 JWT exp 已过期（提前 60s 视作过期，抵消时钟偏差），或
 *   /auth/me 真的返回 401。二者都没发生就绝不调 refresh。
 *
 * 所有网络请求与凭据落盘都在调用方（ConfigManager）注入：本模块只做纯判定 + 编排，便于单测。
 */

import type { ProviderUsageResult } from "../../shared/types/providerUsage";
import { parseSub2ApiPanelBalance } from "./providerUsageCustom";
import type { UsageProbeHttpResult, UsageProbeRequestInit } from "./usageProbeTransport";

/** 面板登录态：access token（JWT）+ 可选的 refresh token（上游形如 rt_xxx）。 */
export type Sub2ApiPanelTokens = { accessToken: string; refreshToken?: string };

/** 续期返回的新 token 对；refreshToken 缺省表示上游未轮转（旧值仍可用）。 */
export type Sub2ApiTokenPair = { accessToken: string; refreshToken?: string; expiresInSeconds?: number };

/** 注入的请求函数（生产为 usageProbeRequest，测试为假实现）。 */
export type Sub2ApiPanelRequest = (url: string, init: UsageProbeRequestInit) => Promise<UsageProbeHttpResult>;

export type Sub2ApiPanelBalanceOutcome = { ok: true; balance: NonNullable<ProviderUsageResult["balance"]>; tokens: Sub2ApiPanelTokens } | { ok: false; reason: "unauthorized" | "failed"; tokens: Sub2ApiPanelTokens };

/**
 * 提前量：本地判定还差 60s 到期就当作已过期。
 * 传输 + 服务端处理有耗时，掐着 exp 发请求会稳定换来一次 401（多一轮往返）。
 */
export const PANEL_TOKEN_REFRESH_SKEW_MS = 60_000;

const asRecord = (value: unknown): Record<string, unknown> | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

/**
 * 取 JWT 的 exp（毫秒时间戳）。只认 `"exp":<数字>` 字面量，不做整段 JSON 解析——payload 常含
 * 非 ASCII 的邮箱等字段，整段解码后 JSON.parse 容易在编码边界上失败，而这里只需要一个数字。
 * 非 JWT（不透明 token）、缺 exp、段不是合法 base64url 一律返回 undefined。
 */
export function decodeJwtExpiryMs(token: string): number | undefined {
	const segment = token.split(".")[1];
	if (!segment) return undefined;
	let payload: string;
	try {
		payload = Buffer.from(segment, "base64url").toString("latin1");
	} catch {
		return undefined;
	}
	const match = /"exp"\s*:\s*(\d+)/.exec(payload);
	if (!match) return undefined;
	const seconds = Number(match[1]);
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

/** JWT 是否已到（或已过）续期时刻；没有 exp 的令牌不下判断，交给服务端 401 兜底。 */
export function panelTokenNeedsRefresh(token: string, nowMs: number, skewMs = PANEL_TOKEN_REFRESH_SKEW_MS): boolean {
	const expiry = decodeJwtExpiryMs(token);
	if (expiry === undefined) return false;
	return expiry - skewMs <= nowMs;
}

/**
 * 解析续期响应。上游走 `response.Success` 包一层 `{code,message,data}`，个别反代/版本会直接
 * 返回扁平结构，两处都接受；access_token 必须是非空字符串，否则视为未命中。
 */
export function parseSub2ApiRefreshResponse(body: unknown): Sub2ApiTokenPair | undefined {
	const root = asRecord(body);
	if (!root) return undefined;
	const data = asRecord(root.data) ?? root;
	const accessToken = typeof data.access_token === "string" ? data.access_token.trim() : "";
	if (!accessToken) return undefined;
	const refreshTokenRaw = typeof data.refresh_token === "string" ? data.refresh_token.trim() : "";
	const expiresIn = typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in > 0 ? data.expires_in : undefined;
	return {
		accessToken,
		...(refreshTokenRaw ? { refreshToken: refreshTokenRaw } : {}),
		...(expiresIn ? { expiresInSeconds: expiresIn } : {}),
	};
}

/**
 * 用 refresh token 换新的 token 对。逐个候选 URL 尝试（baseUrl 带不带版本段都能试）。
 * 401 单独归因（refresh token 过期/已被轮转/被撤销），其余状态码与网络错误都算 failed。
 */
export async function refreshSub2ApiPanelToken(input: { urls: string[]; refreshToken: string; timeoutMs: number; maxBytes: number; request: Sub2ApiPanelRequest; headers: Record<string, string> }): Promise<{ ok: true; pair: Sub2ApiTokenPair } | { ok: false; reason: "unauthorized" | "failed" }> {
	const body = JSON.stringify({ refresh_token: input.refreshToken });
	let unauthorized = false;
	for (const url of input.urls) {
		const result = await input.request(url, {
			method: "POST",
			headers: { ...input.headers, "Content-Type": "application/json" },
			body,
			timeoutMs: input.timeoutMs,
			maxBytes: input.maxBytes,
		});
		if ("error" in result) continue;
		if (result.status === 401) {
			unauthorized = true;
			continue;
		}
		if (result.status < 200 || result.status >= 300) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(result.raw);
		} catch {
			continue;
		}
		const pair = parseSub2ApiRefreshResponse(parsed);
		if (pair) return { ok: true, pair };
	}
	return { ok: false, reason: unauthorized ? "unauthorized" : "failed" };
}

/**
 * 查 /auth/me 拿钱包余额，必要时先用 refresh token 续期：
 * 1. 本地 exp 已过期 → 先续期（省掉必然失败的 401 往返）；
 * 2. 仍返回 401（无 exp / 时钟偏差 / 服务端提前失效）→ 续一次再重试同一个 URL；
 * 3. 续期成功立刻回调 onTokensRefreshed（上游轮转，不落盘下次就废了）。
 *
 * 续期最多尝试一次：失败就到此为止，避免 401 → 续期 → 401 的循环。
 * 余额段是锦上添花，任何失败都只降级为 reason，绝不影响主用量结果。
 */
export async function fetchSub2ApiPanelBalanceWithRefresh(input: {
	balanceUrls: string[];
	refreshUrls: string[];
	tokens: Sub2ApiPanelTokens;
	timeoutMs: number;
	maxBytes: number;
	request: Sub2ApiPanelRequest;
	/** /auth/me 的请求头（Bearer + UA），按传入的 access token 构造。 */
	buildAuthHeaders: (accessToken: string) => Record<string, string>;
	/** /auth/refresh 的请求头（不带 Bearer，凭据在 body 里）。 */
	refreshHeaders: () => Record<string, string>;
	now?: number;
	onTokensRefreshed?: (pair: Sub2ApiTokenPair) => void | Promise<void>;
}): Promise<Sub2ApiPanelBalanceOutcome> {
	let tokens: Sub2ApiPanelTokens = { ...input.tokens };
	let refreshAttempted = false;

	const refreshOnce = async (): Promise<boolean> => {
		if (refreshAttempted || !tokens.refreshToken) return false;
		refreshAttempted = true;
		const refreshed = await refreshSub2ApiPanelToken({
			urls: input.refreshUrls,
			refreshToken: tokens.refreshToken,
			timeoutMs: input.timeoutMs,
			maxBytes: input.maxBytes,
			request: input.request,
			headers: input.refreshHeaders(),
		});
		if (!refreshed.ok) return false;
		// 上游未轮转（响应不带 refresh_token）时保留旧值：有些版本只下发新的 access_token，
		// 直接把 refresh token 丢掉会让下一次过期彻底无法续期。
		const nextRefreshToken = refreshed.pair.refreshToken ?? tokens.refreshToken;
		tokens = {
			accessToken: refreshed.pair.accessToken,
			...(nextRefreshToken ? { refreshToken: nextRefreshToken } : {}),
		};
		try {
			await input.onTokensRefreshed?.(refreshed.pair);
		} catch {
			// 落盘失败不影响本次查询：新 token 已在内存里，下次过期还能靠旧凭据再试一次。
		}
		return true;
	};

	if (tokens.refreshToken && panelTokenNeedsRefresh(tokens.accessToken, input.now ?? Date.now())) {
		await refreshOnce();
	}

	let unauthorized = false;
	const requestProfile = (url: string) =>
		input.request(url, {
			method: "GET",
			headers: input.buildAuthHeaders(tokens.accessToken),
			timeoutMs: input.timeoutMs,
			maxBytes: input.maxBytes,
		});

	for (const url of input.balanceUrls) {
		let result = await requestProfile(url);
		if (!("error" in result) && result.status === 401 && (await refreshOnce())) {
			result = await requestProfile(url);
		}
		if ("error" in result) continue;
		if (result.status === 401) {
			unauthorized = true;
			continue;
		}
		if (result.status < 200 || result.status >= 300) continue;
		let body: unknown;
		try {
			body = JSON.parse(result.raw);
		} catch {
			continue;
		}
		// 只取余额数值：profile 里还有邮箱等账号信息，绝不把响应体透传给渲染层。
		const parsed = parseSub2ApiPanelBalance(body, "");
		if (parsed.matched && parsed.balance) return { ok: true, balance: parsed.balance, tokens };
	}
	return { ok: false, reason: unauthorized ? "unauthorized" : "failed", tokens };
}
