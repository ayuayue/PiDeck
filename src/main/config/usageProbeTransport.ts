/**
 * 用量探针 HTTP 传输层（主进程）。
 *
 * 为什么需要两层传输：Electron 的 net.fetch 基于 Chromium 网络栈，遵循 fetch 规范，
 * Cookie 是 forbidden header——手动设置在 init.headers 里的 Cookie 会被静默丢弃，
 * 只从 session cookie jar 自动携带。Cookie 模板（如 Token Rhythm /api/wallet/summary）
 * 的登录态接口没有 jar 内容，服务端因此收到「无 Cookie」请求并返回 401 未认证
 * （实测：curl 带相同 Cookie 返回 200 余额，net.fetch 返回 401 UNAUTHORIZED）。
 * net.request（ClientRequest）的 setHeader 不受此限制，故带 Cookie 头的探针走
 * net.request，其余保持 net.fetch（行为与代理设置一致、回归风险最小）。
 *
 * 两类传输统一输出 { status, raw } 或 { error }，超时经 AbortController abort，
 * 3xx 不跟随重定向（fail-closed，与原先 redirect:"error" 语义一致）。
 */
import { net } from "electron";

export type UsageProbeHttpResult =
	| { status: number; raw: string }
	| { error: "timeout" | "network" };

/** headers 里是否含 Cookie 头（大小写不敏感）——决定走 net.request 还是 net.fetch。 */
export function hasCookieHeader(headers: Record<string, string> | undefined): boolean {
	return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === "cookie");
}

export type UsageProbeRequestInit = {
	method?: "GET" | "POST";
	headers?: Record<string, string>;
	body?: string;
	timeoutMs: number;
	maxBytes: number;
};

/**
 * 发送一次用量探针请求：带 Cookie 头走 net.request（见文件头注释），
 * 否则走 net.fetch（保持既有代理/行为）。返回统一结果结构。
 */
export function usageProbeRequest(
	url: string,
	init: UsageProbeRequestInit,
): Promise<UsageProbeHttpResult> {
	const headers = init.headers ?? {};
	if (hasCookieHeader(headers)) {
		return netRequestProbe(url, init);
	}
	return netFetchProbe(url, init);
}

/** net.fetch 路径：与既有探测逻辑一致（redirect 拒绝、响应体截断由调用方处理）。 */
async function netFetchProbe(
	url: string,
	init: UsageProbeRequestInit,
): Promise<UsageProbeHttpResult> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), init.timeoutMs);
	try {
		const res = await net.fetch(url, {
			method: init.method ?? "GET",
			headers: init.headers,
			...(init.body !== undefined ? { body: init.body } : {}),
			// 拒绝重定向：带凭据的探针请求不允许被 3xx 带到第三方域（fail-closed）。
			redirect: "error",
			signal: controller.signal,
		});
		return { status: res.status, raw: await readBoundedText(res, init.maxBytes) };
	} catch (error) {
		const isTimeout =
			error instanceof Error &&
			(error.name === "AbortError" || error.name === "TimeoutError");
		return { error: isTimeout ? "timeout" : "network" };
	} finally {
		clearTimeout(timeout);
	}
}

/** net.request（ClientRequest）路径：支持 Cookie 头，事件流手动收集响应体。 */
function netRequestProbe(
	url: string,
	init: UsageProbeRequestInit,
): Promise<UsageProbeHttpResult> {
	return new Promise((resolve) => {
		const request = net.request({
			method: init.method ?? "GET",
			url,
			headers: init.headers,
		});
		let settled = false;
		const settle = (result: UsageProbeHttpResult) => {
			if (!settled) {
				settled = true;
				resolve(result);
			}
		};
		// 超时：abort 会触发 request error（ERR_ABORTED），标记后归为 timeout。
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			request.abort();
		}, init.timeoutMs);

		request.on("response", (response) => {
			const status = response.statusCode;
			const chunks: Buffer[] = [];
			let total = 0;
			let truncated = false;
			response.on("data", (chunk: Buffer) => {
				if (truncated) return;
				total += chunk.length;
				if (total <= init.maxBytes) {
					chunks.push(chunk);
				} else {
					// 超限截断（与 net.fetch 路径的 readBoundedText 一致）：只留前 maxBytes。
					const remaining = init.maxBytes - (total - chunk.length);
					if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
					truncated = true;
				}
			});
			response.on("end", () => {
				clearTimeout(timeout);
				settle({ status, raw: Buffer.concat(chunks).toString("utf8") });
			});
			response.on("error", () => {
				clearTimeout(timeout);
				settle({ error: "network" });
			});
		});
		request.on("error", () => {
			clearTimeout(timeout);
			settle({ error: timedOut ? "timeout" : "network" });
		});
		if (init.body !== undefined) request.write(init.body);
		request.end();
	});
}

/** 流式读取 fetch Response 文本，最多 maxBytes 字节后截断（多读部分丢弃）。 */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const remaining = maxBytes - total;
			if (value.byteLength > remaining) {
				if (remaining > 0) chunks.push(value.subarray(0, remaining));
				total = maxBytes;
				await reader.cancel();
				break;
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks).toString("utf8");
}
