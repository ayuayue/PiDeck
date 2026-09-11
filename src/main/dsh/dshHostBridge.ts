/**
 * DSH v2 传输桥协议（纯函数，可单测）。
 *
 * 形态（docs/dsh-agent-backend-plan.md §3.2 形态 b）：utilityProcess 承载 DSH host，
 * 主进程侧客户端把请求经 MessagePort（utilityProcess.postMessage / parentPort）桥接。
 *
 * 0.1.5 迁移（docs/dsh-0.1.5-typert-migration.md）：旧 dsh-host-apiproxy 已废，
 * unary RPC 走官方 Connection wire 协议（POST /api/<endpoint>，ClientRequest/
 * ServerResponse JSON 信封），仍用 fetch-* 帧；流式（Gateway Remote stream，
 * 含 $events 转发事件与瀑布）走新增 stream-* 帧，帧形状与官方
 * RemoteStreamMuxClient/Server 的 WebSocket 协议一致（item/end/error + open/cancel）。
 *
 * 协议（fetch-* 消息带 `id` 关联一次 fetch 调用；stream-* 带 `id` 关联一条逻辑流）：
 * - main → host：{ type: "fetch-request", id, method, path, headers?, body? }
 * - main → host：{ type: "fetch-abort", id }（外部 AbortSignal 触发）
 * - host → main：{ type: "fetch-response", id, status, headers?, body? }（unary 一次性）
 * - host → main：{ type: "fetch-stream-start", id, status, headers? }（SSE 流开始）
 * - host → main：{ type: "fetch-chunk", id, data }（流帧，文本）
 * - host → main：{ type: "fetch-end", id }（流结束）
 * - host → main：{ type: "fetch-error", id, message }（传输错误）
 * - main → host：{ type: "stream-open", id, endpoint, payload }（打开 Remote 流）
 * - main → host：{ type: "stream-cancel", id }（取消逻辑流）
 * - host → main：{ type: "stream-item", id, value }（流值，JSON 安全值）
 * - host → main：{ type: "stream-end", id }（流正常结束）
 * - host → main：{ type: "stream-error", id, code, message, details }（流失败）
 *
 * body 一律字符串（JSON/SSE 文本）；stream-item.value 为 JSON 安全值。
 */

export type DshFetchMessage =
	| { type: "fetch-request"; id: string; method: string; path: string; headers?: Record<string, string>; body?: string }
	| { type: "fetch-abort"; id: string }
	| { type: "fetch-response"; id: string; status: number; headers?: Record<string, string>; body?: string }
	| { type: "fetch-stream-start"; id: string; status: number; headers?: Record<string, string> }
	| { type: "fetch-chunk"; id: string; data: string }
	| { type: "fetch-end"; id: string }
	| { type: "fetch-error"; id: string; message: string }
	| { type: "stream-open"; id: string; endpoint: string; payload?: unknown }
	| { type: "stream-cancel"; id: string }
	| { type: "stream-item"; id: string; value: unknown }
	| { type: "stream-end"; id: string }
	| { type: "stream-error"; id: string; code: string; message: string; details?: unknown };

/** Gateway 流失败的三元组（对齐官方 RemoteStreamFailure 形状）。 */
export type DshStreamFailure = { code: string; message: string; details?: unknown };

/** 构造 Gateway 流的 stream-open 消息。 */
export function marshalStreamOpen(id: string, endpoint: string, payload?: unknown): DshFetchMessage {
	return { type: "stream-open", id, endpoint, ...(payload !== undefined ? { payload } : {}) };
}

/** 构造 fetch-request 消息（URL 拆成 path + query，headers 只保留字符串值）。
 *  E12：桥只承载 host 内部 ApiProxy 端点（http://dsh.internal）；外部 origin 是
 *  调用方误用，显式拒绝而不是静默重写成内部路径（host 侧重基会吞掉外部 URL）。 */
export function marshalFetchRequest(
	id: string,
	url: URL,
	init?: { method?: string; headers?: Record<string, string>; body?: string },
): DshFetchMessage {
	if (url.origin !== "http://dsh.internal") {
		throw new Error(`DSH bridge: unexpected origin "${url.origin}" (only http://dsh.internal is bridged)`);
	}
	return {
		type: "fetch-request",
		id,
		method: init?.method ?? "GET",
		path: `${url.pathname}${url.search}`,
		...(init?.headers && Object.keys(init.headers).length > 0
			? { headers: init.headers }
			: {}),
		...(init?.body !== undefined ? { body: init.body } : {}),
	};
}

/** 校验桥消息形状；未知/畸形消息返回 undefined（两侧都应静默跳过）。 */
export function parseDshFetchMessage(value: unknown): DshFetchMessage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const message = value as Record<string, unknown>;
	if (typeof message.type !== "string" || typeof message.id !== "string") return undefined;
	switch (message.type) {
		case "fetch-request": {
			if (typeof message.method !== "string" || typeof message.path !== "string") return undefined;
			return {
				type: "fetch-request",
				id: message.id,
				method: message.method,
				path: message.path,
				...(isStringRecord(message.headers) ? { headers: message.headers } : {}),
				...(typeof message.body === "string" ? { body: message.body } : {}),
			};
		}
		case "fetch-abort":
			return { type: "fetch-abort", id: message.id };
		case "fetch-response": {
			if (typeof message.status !== "number") return undefined;
			return {
				type: "fetch-response",
				id: message.id,
				status: message.status,
				...(isStringRecord(message.headers) ? { headers: message.headers } : {}),
				...(typeof message.body === "string" ? { body: message.body } : {}),
			};
		}
		case "fetch-stream-start": {
			if (typeof message.status !== "number") return undefined;
			return {
				type: "fetch-stream-start",
				id: message.id,
				status: message.status,
				...(isStringRecord(message.headers) ? { headers: message.headers } : {}),
			};
		}
		case "fetch-chunk":
			return typeof message.data === "string"
				? { type: "fetch-chunk", id: message.id, data: message.data }
				: undefined;
		case "fetch-end":
			return { type: "fetch-end", id: message.id };
	case "fetch-error":
		return typeof message.message === "string"
			? { type: "fetch-error", id: message.id, message: message.message }
			: undefined;
	case "stream-open":
		return typeof message.endpoint === "string"
			? { type: "stream-open", id: message.id, endpoint: message.endpoint, ...(message.payload !== undefined ? { payload: message.payload } : {}) }
			: undefined;
	case "stream-cancel":
		return { type: "stream-cancel", id: message.id };
	case "stream-item":
		return "value" in message
			? { type: "stream-item", id: message.id, value: message.value }
			: undefined;
	case "stream-end":
		return { type: "stream-end", id: message.id };
	case "stream-error":
		return typeof message.code === "string" && typeof message.message === "string"
			? {
					type: "stream-error",
					id: message.id,
					code: message.code,
					message: message.message,
					...(message.details !== undefined ? { details: message.details } : {}),
				}
			: undefined;
	default:
		return undefined;
	}
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return Object.entries(value).every(([key, item]) => typeof key === "string" && typeof item === "string");
}
