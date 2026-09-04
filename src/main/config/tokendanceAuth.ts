/**
 * TokenDance OAuth 式 API Key 授权（主进程，PKCE S256 Headless 流程）。
 *
 * 流程（对应 https://tokendance.space/docs/api-key-oauth.md#headless）：
 * 1. start(): 生成 verifier + challenge，保存 verifier 到内存（只出 challenge 给授权页），
 *    返回授权 URL（无 callback_url → 授权页确认后展示一次性 code，10 分钟有效）；
 * 2. 用户从授权页复制 code，UI 粘贴回来；
 * 3. complete(flowId, code): 用 verifier + code 调 /portal/api/v1/auth/keys 交换 API Key。
 *
 * 设计要点：
 * - verifier 只在主进程内存存活（flowId → verifier），渲染层只拿到 flowId，
 *   code 交换后立即删除；应用重启即失效（重新走授权），符合「一次性 code 不可重放」。
 * - verifier 是敏感材料：日志、IPC 返回值一律不输出 verifier/challenge 明文。
 * - 交换请求必须带 S256 声明（无 PKCE 的有回调模式只提交 code，Headless 必须 S256）。
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	TOKENDANCE_APP_URL,
	TOKENDANCE_AUTH_URL,
	TOKENDANCE_EXCHANGE_URL,
	TOKENDANCE_KEY_NAME,
} from "../../shared/tokendance";

/** 交换响应中的完整 Key 只在首次成功交换出现；错误 verifier 不消费 code。 */
export type TokendanceAuthExchangeResult =
	| { ok: true; key: string }
	| { ok: false; error: string };

export type TokendanceAuthStartResult = {
	/** 渲染层凭证，complete() 时原样带回（不暴露 verifier 本身）。 */
	flowId: string;
	/** 授权页 URL（PKCE S256 + app_url 归因 + key_name；headless 无 callback_url）。 */
	authUrl: string;
};

/** 交换请求的最小 fetch 形状（默认 net.fetch；测试注入 stub）。 */
export type TokendanceFetch = (
	url: string,
	init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;

export type TokendanceAuthStoreDeps = {
	/** 拉取函数（默认 electron net.fetch，走系统代理会话）；测试注入 stub。 */
	fetchFn?: TokendanceFetch;
	/** 时钟（测试注入固定时间）。 */
	now?: () => number;
};

/** 生成 S256 verifier：43 字符 base64url 随机串（满足 43–128 字母数字-._~ 约束）。 */
export function generateTokendancePkceVerifier(rand: (size: number) => Uint8Array = randomBytes): string {
	return Buffer.from(rand(32)).toString("base64url");
}

/** 计算 S256 challenge：base64url(SHA-256(verifier))。 */
export function generateTokendancePkceChallenge(verifier: string): string {
	return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

/**
 * 构造授权页 URL（纯函数，可单测）。
 * callbackUrl 可选：传了走「有回调」模式（授权后重定向带 ?code=）；
 * 不传走 headless 模式（页面直接展示一次性 code，桌面应用用这个）。
 */
export function buildTokendanceAuthUrl(options: {
	codeChallenge: string;
	appUrl?: string;
	keyName?: string;
	callbackUrl?: string;
}): URL {
	const url = new URL(TOKENDANCE_AUTH_URL);
	const { codeChallenge, appUrl, keyName, callbackUrl } = options;
	if (callbackUrl) url.searchParams.set("callback_url", callbackUrl);
	// PKCE 参数固定 S256：headless 无 callback 时是必填，有 callback 时也推荐。
	url.searchParams.set("code_challenge", codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	// app_url 才是稳定的归因维度（callback 端口不应写入 Key 归因）。
	url.searchParams.set("app_url", appUrl ?? TOKENDANCE_APP_URL);
	url.searchParams.set("key_name", keyName ?? TOKENDANCE_KEY_NAME);
	return url;
}

/**
 * 用一次性 code 交换 API Key（纯函数，可单测）。
 * 成功返回完整 key；失败返回脱敏错误文案（响应体可能含 server 错误细节，仅暴露状态码）。
 * 注意：完整 Key 只出现在首次成功交换的响应中，丢失后必须重新授权，不能重试。
 */
export async function exchangeTokendanceAuthCode(
	options: {
		code: string;
		verifier: string;
		now?: number;
	},
	fetchFn: TokendanceFetch,
): Promise<TokendanceAuthExchangeResult> {
	const { code, verifier } = options;
	try {
		const response = await fetchFn(TOKENDANCE_EXCHANGE_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				code,
				code_verifier: verifier,
				code_challenge_method: "S256",
			}),
		});
		if (!response.ok) {
			// 403 = code 无效/过期/已使用或 verifier 不匹配；400 = 参数不完整。不泄露响应体。
			const status = response.status ? `HTTP ${response.status}` : "failed";
			return { ok: false, error: `TokenDance auth exchange ${status}` };
		}
		const body = (await response.json()) as unknown;
		const key =
			body && typeof body === "object"
				? (body as { key?: unknown }).key
				: undefined;
		if (typeof key !== "string" || key.length === 0) {
			return { ok: false, error: "TokenDance auth exchange empty key" };
		}
		return { ok: true, key };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `TokenDance auth exchange failed: ${message}` };
	}
}

/** 等待交换的流程记录：verifier + 创建时刻（用于过期清理）。 */
type PendingFlow = { verifier: string; at: number };

/**
 * TokenDance 授权流程 store：start 保存 verifier，complete 交换即删。
 * verifier 仅主进程内存持有；过期清理兜底（授权页 code 10 分钟有效，远超够用）。
 */
export class TokendanceAuthStore {
	private fetchFn: TokendanceFetch;
	private now: () => number;
	/** flowId → 待交换流程（verifier）。start 后未 complete 的流程随时间自然过期。 */
	private pending = new Map<string, PendingFlow>();

	constructor(deps: TokendanceAuthStoreDeps = {}) {
		this.fetchFn =
			deps.fetchFn ??
			((url, init) =>
				import("electron").then(({ net }) => net.fetch(url, init)));
		this.now = deps.now ?? Date.now;
	}

	/** 开始授权流程：返回授权 URL + flowId（verifier 不出主进程）。 */
	start(options?: { callbackUrl?: string }): TokendanceAuthStartResult {
		const verifier = generateTokendancePkceVerifier();
		const challenge = generateTokendancePkceChallenge(verifier);
		const flowId = randomUUID();
		this.pending.set(flowId, { verifier, at: this.now() });
		// 顺带清理过期流程（30 分钟），防止未完成的 start 堆积内存。
		const cutoff = this.now() - 30 * 60 * 1000;
		for (const [id, flow] of this.pending) {
			if (flow.at < cutoff) this.pending.delete(id);
		}
		return {
			flowId,
			authUrl: buildTokendanceAuthUrl({
				codeChallenge: challenge,
				...(options?.callbackUrl ? { callbackUrl: options.callbackUrl } : {}),
			}).toString(),
		};
	}

	/**
	 * 用用户粘贴的 code 完成授权交换。
	 * 成功返回 key 并删除流程；失败保留流程（允许用户重试粘贴，错误 verifier 不消费 code）。
	 */
	async complete(flowId: string, code: string): Promise<TokendanceAuthExchangeResult> {
		const flow = this.pending.get(flowId);
		if (!flow) {
			return { ok: false, error: "Tokendance auth flow expired or unknown" };
		}
		const result = await exchangeTokendanceAuthCode(
			{ code, verifier: flow.verifier, now: this.now() },
			this.fetchFn,
		);
		if (result.ok) {
			this.pending.delete(flowId);
			return { ok: true, key: result.key };
		}
		return result;
	}
}
