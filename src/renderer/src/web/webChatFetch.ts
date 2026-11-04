/**
 * `/api/chat` 的 fetch 中间件：网络层「一个字节都没回来」时用同一份请求体重试一次。
 *
 * 为什么需要：跨网访问（隧道 / 虚拟网，如 EasyTier）下，浏览器复用到一条对端已丢弃的空闲
 * 连接时，TCP 会静默重传到十几秒后才抛 `TypeError: Failed to fetch`。换一条新连接重发通常
 * 立刻成功——用户看到的「偶发启动不了」正是这条死连接，而不是 pi 起不来。
 *
 * 为什么安全：请求体里带着前端生成的 messageId，服务端按 `sessionId + requestId` 去重
 * （见 WebApiRoutes 的投递缓存，TTL 10 分钟），同体重放不会让 pi 收到第二条 prompt。
 *
 * 边界：用户主动中止（`init.signal` 已 abort 或 AbortError）不重试；流式请求体（非字符串）
 * 不可重放，直接抛原错误；HTTP 4xx/5xx 不是 throw，不归这里管。
 */
import type { DefaultChatTransport } from "ai";

/** 重试前的等待：给浏览器一点时间丢弃死连接、建立新连接，又不至于让用户觉得卡住。 */
export const WEB_CHAT_RETRY_DELAY_MS = 800;

function isAborted(error: unknown, signal: AbortSignal | null | undefined): boolean {
	if (signal?.aborted) return true;
	return error instanceof Error && error.name === "AbortError";
}

function isReplayableBody(body: RequestInit["body"]): boolean {
	return body === undefined || body === null || typeof body === "string";
}

/**
 * 包一层 fetch：只在「请求抛错且可重放」时重试一次，第二次仍失败就把原错误抛给调用方。
 * 默认参数让调用侧零配置，测试侧可注入 baseFetch 与 delayMs。
 */
export function createRetryingChatFetch(baseFetch?: typeof fetch, delayMs: number = WEB_CHAT_RETRY_DELAY_MS): typeof fetch {
	return async function retryingChatFetch(input, init) {
		// 默认实现延迟到调用时再取：模块加载期就 `globalThis.fetch.bind` 会让没有 fetch 的环境
		// （浏览器主线程外的测试沙箱、隐藏 worker）在 import 阶段就炸，而本中间件本身无状态。
		const send = baseFetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
		try {
			return await send(input, init);
		} catch (error) {
			if (isAborted(error, init?.signal) || !isReplayableBody(init?.body)) throw error;
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			// 等待期间用户可能点了停止：此时再发就是把已取消的 prompt 又塞回去。
			if (init?.signal?.aborted) throw error;
			return send(input, init);
		}
	} as typeof fetch;
}

/** 单例：DefaultChatTransport 每次渲染都新建，中间件本身无状态，复用同一个函数即可。 */
export const webChatFetch = createRetryingChatFetch();

/** DefaultChatTransport 的 fetch 选项类型（供调用侧做类型收敛，避免 any）。 */
export type WebChatFetch = NonNullable<ConstructorParameters<typeof DefaultChatTransport>[0]>["fetch"];
