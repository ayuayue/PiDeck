/**
 * TokenDance OAuth 式 API Key 授权（主进程，PKCE S256）。
 *
 * 两种接收一次性 code 的模式（对应 https://tokendance.space/docs/api-key-oauth.md）：
 * - **callback（默认，桌面应用推荐）**：主进程在 127.0.0.1 随机空闲端口起一个一次性
 *   HTTP 服务，把 `callback_url` 带进授权页；用户在浏览器点确认后平台直接重定向回本地，
 *   code 自动送达→自动交换 Key。用户无需复制粘贴任何东西（「一个操作完成」的前提）。
 * - **headless（兼容降级）**：不带 callback_url，授权页展示一次性 code，用户手动粘回。
 *   用于端口绑定失败（防火墙/沙箱）或浏览器在另一台设备的场景。
 *
 * 设计要点：
 * - verifier 只在主进程内存存活（flowId → verifier），渲染层只拿到 flowId；
 *   code 交换后立即删除；应用重启即失效（重新走授权），符合「一次性 code 不可重放」。
 * - 回环服务只监听 127.0.0.1、只接受预期路径（带随机 token）的 GET，收到一次 code 即关闭；
 *   不反射任何查询参数到响应页，不输出 code/key 到日志。
 * - 交换请求必须带 S256 声明（无 PKCE 的有回调模式只提交 code，本实现统一带 PKCE）。
 */
import { createServer, type Server } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { TOKENDANCE_APP_URL, TOKENDANCE_AUTH_URL, TOKENDANCE_EXCHANGE_URL, TOKENDANCE_KEY_NAME, type TokendanceAuthMode } from "../../shared/tokendance";

// 跨层契约类型定义在 shared（preload/渲染层共用），主进程只负责实现。
export type { TokendanceAuthMode } from "../../shared/tokendance";

/** 交换响应中的完整 Key 只在首次成功交换出现；错误 verifier 不消费 code。 */
export type TokendanceAuthExchangeResult = { ok: true; key: string } | { ok: false; error: string };

/** 授权模式：callback = 本地回环自动收 code；headless = 用户手动粘贴一次性 code（见 shared/tokendance）。 */

export type TokendanceAuthStartResult = {
	/** 渲染层凭证，complete()/awaitKey() 时原样带回（不暴露 verifier 本身）。 */
	flowId: string;
	/** 授权页 URL（PKCE S256 + app_url 归因 + key_name；callback 模式额外带 callback_url）。 */
	authUrl: string;
	/** 实际生效的模式（请求 callback 但绑定失败时会降级成 headless）。 */
	mode: TokendanceAuthMode;
	/** 降级原因（仅诊断用，不含敏感数据）。 */
	fallbackReason?: string;
};

/** 交换请求的最小 fetch 形状（默认 net.fetch；测试注入 stub）。 */
export type TokendanceFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;

export type TokendanceAuthStoreDeps = {
	/** 拉取函数（默认 electron net.fetch，走系统代理会话）；测试注入 stub。 */
	fetchFn?: TokendanceFetch;
	/** 时钟（测试注入固定时间）。 */
	now?: () => number;
	/** 回环服务实现（测试注入假服务，不起真端口）。 */
	createCallbackServer?: CallbackServerFactory;
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
export function buildTokendanceAuthUrl(options: { codeChallenge: string; appUrl?: string; keyName?: string; callbackUrl?: string }): URL {
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
		const key = body && typeof body === "object" ? (body as { key?: unknown }).key : undefined;
		if (typeof key !== "string" || key.length === 0) {
			return { ok: false, error: "TokenDance auth exchange empty key" };
		}
		return { ok: true, key };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `TokenDance auth exchange failed: ${message}` };
	}
}

/** 等待交换的流程记录：verifier + 创建时刻（用于过期清理）+ 回环监听器。 */
type PendingFlow = {
	verifier: string;
	at: number;
	mode: TokendanceAuthMode;
	/** callback 模式的一次性本地监听器（headless 无）。 */
	listener?: LoopbackCallbackListener;
};

/**
 * 一次性回环回调监听器（桌面端 OAuth 标准做法，见 RFC 8252 §7.3）。
 * 只监听 127.0.0.1 随机空闲端口，路径带随机 token；收到带 code 的请求即解析并关闭。
 */
export type LoopbackCallbackListener = {
	/** 注册给授权页的 callback_url（平台会保留路径与查询参数并追加 code）。 */
	callbackUrl: string;
	/** 等待 code：超时 / 被关闭时返回 null。 */
	waitForCode: (timeoutMs: number) => Promise<string | null>;
	close: () => void;
};

/** 监听器工厂（测试注入假实现，避免依赖真实端口）。 */
export type CallbackServerFactory = () => Promise<LoopbackCallbackListener>;

/** 回调页文案：主进程无法走渲染层 i18n，中英双语一行带过（不反射任何查询参数）。 */
const CALLBACK_DONE_HTML = "<!doctype html><meta charset=utf-8><title>PiDeck</title>" + '<p style="font:14px system-ui;max-width:28rem;margin:6rem auto;text-align:center">' + "授权已完成，可以关闭本页面返回 PiDeck。<br>Authorization complete — you can close this page.</p>";
const CALLBACK_ERROR_HTML = "<!doctype html><meta charset=utf-8><title>PiDeck</title>" + '<p style="font:14px system-ui;max-width:28rem;margin:6rem auto;text-align:center">' + "回调地址无效，请回到 PiDeck 重新发起授权。Invalid callback — please restart authorization in PiDeck.</p>";

/**
 * 默认监听器实现：node:http + 127.0.0.1:0（系统分配空闲端口）。
 * 安全边界：仅回环地址、仅预期路径、一次性（收到 code 或关闭后不再服务）、不记录 code。
 *
 * code 与 awaitKey 的到达顺序不确定（用户可能秒授权，也可能先于本调用送达），
 * 所以收到的 code 先缓存在 receivedCode，waiter 存在则立即唤醒，不存在则等下次取。
 */
function createLoopbackCallbackServer(): Promise<LoopbackCallbackListener> {
	const token = randomBytes(16).toString("base64url");
	const path = `/callback/${token}`;
	let receivedCode: string | null = null;
	let waiter: ((code: string | null) => void) | null = null;
	let closed = false;

	/** 唤醒等待者（无等待者时结果留在 receivedCode 里等 awaitKey 取）。 */
	const wake = () => {
		const pending = waiter;
		waiter = null;
		pending?.(receivedCode);
	};

	const server = createServer((request, response) => {
		const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
		// 路径带随机 token：同端口上的其它本地页面拿不到正确路径，一律 400 不处理。
		const code = requestUrl.pathname === path ? requestUrl.searchParams.get("code") : null;
		response.writeHead(code ? 200 : 400, {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store",
			Connection: "close",
		});
		response.end(code ? CALLBACK_DONE_HTML : CALLBACK_ERROR_HTML);
		if (!code || receivedCode !== null) return;
		receivedCode = code;
		wake();
		close();
	});

	function close() {
		if (closed) return;
		closed = true;
		wake();
		server.close();
		// 浏览器 keep-alive 会让 close() 一直挂着，强制断开保证弹窗关闭后端口立即释放。
		server.closeAllConnections?.();
	}

	return new Promise<LoopbackCallbackListener>((resolve, reject) => {
		const onError = (error: Error) => reject(error);
		server.once("error", onError);
		server.listen(0, "127.0.0.1", () => {
			server.removeListener("error", onError);
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			resolve({
				callbackUrl: `http://127.0.0.1:${port}${path}`,
				waitForCode: (timeoutMs) =>
					new Promise<string | null>((done) => {
						if (receivedCode !== null || closed) {
							done(receivedCode);
							return;
						}
						const timer = setTimeout(() => {
							waiter = null;
							close();
							done(null);
						}, timeoutMs);
						// 超时定时器不能让事件循环空转挂住退出流程。
						timer.unref?.();
						waiter = (code) => {
							clearTimeout(timer);
							done(code);
						};
					}),
				close,
			});
		});
	});
}

/**
 * TokenDance 授权流程 store：start 保存 verifier，complete/awaitKey 交换即删。
 * verifier 仅主进程内存持有；过期清理兜底（授权页 code 10 分钟有效，远超够用）。
 */
export class TokendanceAuthStore {
	private fetchFn: TokendanceFetch;
	private now: () => number;
	private createListener: CallbackServerFactory;
	/** flowId → 待交换流程（verifier）。start 后未 complete 的流程随时间自然过期。 */
	private pending = new Map<string, PendingFlow>();

	constructor(deps: TokendanceAuthStoreDeps = {}) {
		this.fetchFn = deps.fetchFn ?? ((url, init) => import("electron").then(({ net }) => net.fetch(url, init)));
		this.now = deps.now ?? Date.now;
		this.createListener = deps.createCallbackServer ?? createLoopbackCallbackServer;
	}

	/**
	 * 开始授权流程：返回授权 URL + flowId（verifier 不出主进程）。
	 *
	 * mode="callback"（默认）：先占用一个回环端口再拼 callback_url，浏览器授权完会直接
	 * 把 code 送回本地，渲染层 awaitKey() 就能拿到 Key —— 用户不需要复制粘贴任何东西。
	 * 绑定失败（防火墙/无可用端口）自动降级 headless，并在 fallbackReason 里说明。
	 */
	async start(options: { mode?: TokendanceAuthMode } = {}): Promise<TokendanceAuthStartResult> {
		const verifier = generateTokendancePkceVerifier();
		const challenge = generateTokendancePkceChallenge(verifier);
		const flowId = randomUUID();
		this.pruneExpired();

		if ((options.mode ?? "callback") === "callback") {
			try {
				const listener = await this.createListener();
				this.pending.set(flowId, { verifier, at: this.now(), mode: "callback", listener });
				return {
					flowId,
					mode: "callback",
					authUrl: buildTokendanceAuthUrl({
						codeChallenge: challenge,
						callbackUrl: listener.callbackUrl,
					}).toString(),
				};
			} catch (error) {
				// 降级不阻断：用户仍能按 headless 流程粘贴 code 完成授权。
				const message = error instanceof Error ? error.message : String(error);
				this.pending.set(flowId, { verifier, at: this.now(), mode: "headless" });
				return {
					flowId,
					mode: "headless",
					fallbackReason: message,
					authUrl: buildTokendanceAuthUrl({ codeChallenge: challenge }).toString(),
				};
			}
		}

		this.pending.set(flowId, { verifier, at: this.now(), mode: "headless" });
		return {
			flowId,
			mode: "headless",
			authUrl: buildTokendanceAuthUrl({ codeChallenge: challenge }).toString(),
		};
	}

	/**
	 * 等待 callback 模式自动送达的 code 并交换成 API Key。
	 * 超时（默认 5 分钟，覆盖“用户切去浏览器登录+确认”的真实耗时）后关闭监听器并返回失败，
	 * 由渲染层引导用户改用粘贴授权码或手动粘贴 Key。
	 */
	async awaitKey(flowId: string, timeoutMs = 5 * 60 * 1000): Promise<TokendanceAuthExchangeResult> {
		const flow = this.pending.get(flowId);
		if (!flow) {
			return { ok: false, error: "Tokendance auth flow expired or unknown" };
		}
		if (flow.mode !== "callback" || !flow.listener) {
			return { ok: false, error: "Tokendance auth flow is not in callback mode" };
		}

		const code = await flow.listener.waitForCode(timeoutMs);
		if (!code) {
			// 监听器超时不保证自己关（自定义实现可能只回 null），这里显式释放，保证端口不悬挂。
			flow.listener.close();
			this.pending.delete(flowId);
			return {
				ok: false,
				error: "Tokendance auth timed out waiting for the browser callback",
			};
		}
		// code 可能先于 awaitKey 到达（用户秒授权）：listener 内部已缓存，这里照样能取到。
		return this.complete(flowId, code);
	}

	/** 放弃授权（弹窗关闭/用户取消）：立即释放回环端口并丢弃 verifier。 */
	cancel(flowId: string): void {
		const flow = this.pending.get(flowId);
		if (!flow) return;
		flow.listener?.close();
		this.pending.delete(flowId);
	}

	/**
	 * 用一次性 code 完成授权交换（headless 由用户粘贴，callback 由 awaitKey 内部调用）。
	 * 成功返回 key 并删除流程；失败保留流程（允许用户重试粘贴，错误 verifier 不消费 code）。
	 */
	async complete(flowId: string, code: string): Promise<TokendanceAuthExchangeResult> {
		const flow = this.pending.get(flowId);
		if (!flow) {
			return { ok: false, error: "Tokendance auth flow expired or unknown" };
		}
		const result = await exchangeTokendanceAuthCode({ code, verifier: flow.verifier, now: this.now() }, this.fetchFn);
		if (result.ok) {
			flow.listener?.close();
			this.pending.delete(flowId);
			return { ok: true, key: result.key };
		}
		return result;
	}

	/** 清理过期流程（30 分钟）并释放其回环端口，防止未完成的 start 堆积。 */
	private pruneExpired(): void {
		const cutoff = this.now() - 30 * 60 * 1000;
		for (const [id, flow] of this.pending) {
			if (flow.at < cutoff) {
				flow.listener?.close();
				this.pending.delete(id);
			}
		}
	}
}
