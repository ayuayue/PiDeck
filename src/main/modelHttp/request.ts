/**
 * 主进程模型/供应商 API 的 HTTP 传输（裸请求统一层）。
 *
 * 承载两类请求：
 *   1. 供应商管理接口（模型列表探测、用量/余额探针）——走 Electron `net`，
 *      即 Chromium 网络栈，自动服从系统代理、桌面代理全局开关与系统根证书。
 *   2. 后续需要显式代理策略的请求——通过 `proxyTarget` 使用独立内存 session，
 *      不改动全局代理（见下方 modelListProxySession 注释）。
 *
 * 为什么保留 `net.request` 这条路：Electron 的 `net.fetch` 基于 fetch 规范，
 * Cookie 是 forbidden header——手动设置在 init.headers 里的 Cookie 会被静默丢弃，
 * 只从 session cookie jar 自动携带。Cookie 模板（如 Token Rhythm /api/wallet/summary）
 * 的登录态接口没有 jar 内容，服务端收到「无 Cookie」请求并返回 401 未认证
 * （实测：curl 带相同 Cookie 返回 200 余额，net.fetch 返回 401 UNAUTHORIZED）。
 * `net.request`（ClientRequest）的 setHeader 不受此限制，故带 Cookie 头走 `net.request`。
 *
 * 统一行为（各调用点原先各写一份）：
 *   - 超时与外部取消归并为同一个 abort 源；
 *   - 响应体按 maxBytes 上界读取（truncate 语义，见 bounded.ts）；
 *   - 3xx 不跟随重定向：带凭据的请求不允许被 3xx 带到第三方域（fail-closed）；
 *   - 失败只归为 timeout / network 两类，原始异常文本放在 detail 里仅供日志与分类，
 *     **不得**回传渲染层（message 可能裹挟 URL 中的 key 或网关回显正文）。
 */
import { net, session, type Session } from "electron";
import { createBoundedAccumulator, readBoundedBody } from "./bounded";

/** 大小写不敏感判断 headers 是否含 Cookie 头——决定走 net.request 还是 net.fetch。 */
export function hasCookieHeader(headers: Record<string, string> | undefined): boolean {
	return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === "cookie");
}

/** 显式代理策略：follow = 跟随全局 session（默认）；on/off = 独立 session 临时设代理。 */
export type ModelHttpProxyTarget = {
	mode: "follow" | "on" | "off";
	url?: string;
	bypass?: string;
};

export type ModelHttpRequestInit = {
	method?: "GET" | "POST";
	headers?: Record<string, string>;
	body?: string;
	timeoutMs: number;
	maxBytes: number;
	proxyTarget?: ModelHttpProxyTarget;
	/** 外部取消信号；与 timeoutMs 归并，任一触发即 abort。 */
	signal?: AbortSignal;
};

export type ModelHttpOk = {
	status: number;
	statusText: string;
	raw: string;
	/** 正文因超过 maxBytes 被截断——调用方不应把截断结果当完整响应解析。 */
	truncated: boolean;
	/** 大小写不敏感取响应头（两条传输通道归一）。 */
	header(name: string): string | null;
};

export type ModelHttpFailure = {
	error: "timeout" | "network";
	/** 原始异常文本（`name: message`），仅供主进程日志与网络故障分类。 */
	detail?: string;
};

export type ModelHttpResult = ModelHttpOk | ModelHttpFailure;

// 模型列表拉取的"显式代理"专用 session。
// 为什么不用 defaultSession + session.setProxy 全局改：桌面代理全局开关是用户
// 手动控制的，这里按单个请求临时开启/关闭代理，改全局会影响用户在跑的会话流量；
// 所以用独立内存 partition（非 persist 前缀 = 不落盘），代理规则只影响本模块的请求。
let modelListProxySession: Session | null = null;
function getModelListProxySession(): Session {
	if (!modelListProxySession) {
		modelListProxySession = session.fromPartition("pideck-config-proxy", {
			cache: false,
		});
	}
	return modelListProxySession;
}

/**
 * 发送一次请求，返回归一后的结果。
 * 判定用 `"error" in result`：拿到 HTTP 响应（任意状态码）都算 success 分支。
 */
export async function modelHttpRequest(url: string, init: ModelHttpRequestInit): Promise<ModelHttpResult> {
	if (hasCookieHeader(init.headers)) return netRequestSend(url, init);
	return netFetchSend(url, init);
}

/** 把外部取消与超时归并成一个 abort 源，返回清理函数。 */
function combineAbort(external: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	const onAbort = () => controller.abort();
	if (external) {
		if (external.aborted) controller.abort();
		else external.addEventListener("abort", onAbort, { once: true });
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeout);
			external?.removeEventListener("abort", onAbort);
		},
	};
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function describeError(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** net.fetch 路径：跟随全局代理，或按 proxyTarget 使用独立 session。 */
async function netFetchSend(url: string, init: ModelHttpRequestInit): Promise<ModelHttpResult> {
	const { signal, cleanup } = combineAbort(init.signal, init.timeoutMs);
	try {
		const target = init.proxyTarget;
		const useDedicated = target?.mode === "on" || target?.mode === "off";
		const fetcher = useDedicated ? await configureProxySession(target) : net.fetch;
		const response = await fetcher(url, {
			method: init.method ?? "GET",
			...(init.headers ? { headers: init.headers } : {}),
			...(init.body !== undefined ? { body: init.body } : {}),
			// 拒绝重定向：带凭据的请求不允许被 3xx 带到第三方域（fail-closed）。
			redirect: "error",
			signal,
		});
		const body = await readBoundedBody(response, init.maxBytes, "truncate");
		return {
			status: response.status,
			statusText: response.statusText ?? "",
			raw: body ? body.bytes.toString("utf8") : "",
			truncated: body?.truncated ?? false,
			header: (name) => response.headers?.get?.(name) ?? null,
		};
	} catch (error) {
		return {
			error: isAbortError(error) ? "timeout" : "network",
			detail: describeError(error),
		};
	} finally {
		cleanup();
	}
}

/** 给独立 session 设好代理策略并返回它的 fetch（this 已绑定到 session）。 */
async function configureProxySession(target: ModelHttpProxyTarget): Promise<typeof net.fetch> {
	const proxySession = getModelListProxySession();
	await proxySession.setProxy(
		target.mode === "on"
			? {
					mode: "fixed_servers",
					proxyRules: target.url,
					proxyBypassRules: target.bypass,
				}
			: { mode: "direct" },
	);
	return proxySession.fetch.bind(proxySession);
}

/** net.request（ClientRequest）路径：支持 Cookie 头，事件流手动收集响应体。 */
function netRequestSend(url: string, init: ModelHttpRequestInit): Promise<ModelHttpResult> {
	return new Promise((resolve) => {
		const accumulator = createBoundedAccumulator(init.maxBytes);
		const request = net.request({
			method: init.method ?? "GET",
			url,
			...(init.headers ? { headers: init.headers } : {}),
		});
		let settled = false;
		const settle = (result: ModelHttpResult) => {
			if (!settled) {
				settled = true;
				clearTimeout(timeout);
				init.signal?.removeEventListener("abort", onAbort);
				resolve(result);
			}
		};
		// 超时/外部取消：先 settle 再 abort——abort 会同步触发 request error（ERR_ABORTED），
		// 若先 abort，error 处理器会抢先归为 network。
		const timeout = setTimeout(() => {
			settle({ error: "timeout", detail: "AbortError: probe timed out" });
			request.abort();
		}, init.timeoutMs);
		const onAbort = () => {
			settle({ error: "timeout", detail: "AbortError: probe aborted" });
			request.abort();
		};
		if (init.signal) {
			if (init.signal.aborted) {
				onAbort();
				return;
			}
			init.signal.addEventListener("abort", onAbort, { once: true });
		}

		request.on("response", (response) => {
			response.on("data", (chunk: Buffer) => accumulator.push(chunk));
			response.on("end", () => {
				const body = accumulator.finish();
				settle({
					status: response.statusCode,
					statusText: "",
					raw: body.bytes.toString("utf8"),
					truncated: body.truncated,
					header: (name) => {
						const headers = response.headers ?? {};
						const wanted = name.toLowerCase();
						for (const [key, value] of Object.entries(headers)) {
							if (key.toLowerCase() !== wanted) continue;
							return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
						}
						return null;
					},
				});
			});
			response.on("error", () => settle({ error: "network", detail: "response stream error" }));
		});
		request.on("error", (error) => settle({ error: "network", detail: describeError(error) }));
		if (init.body !== undefined) request.write(init.body);
		request.end();
	});
}
