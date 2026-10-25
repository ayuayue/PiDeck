/**
 * pi-deck-model-trace —— 模型请求快照采集扩展（RPC 日志「模型」视图的数据源）。
 *
 * **为什么需要**：PiDeck 的 RPC 日志只覆盖 stdio 两个方向，而 pi 真正发给供应商的
 * 请求体（system prompt / 上下文消息 / 工具表）在 pi 进程内组装后直接走 HTTP，
 * 从不经过 stdio —— 排查「模型到底收到了什么」时是盲区。
 * pi 的扩展钩子 `before_provider_request` 能在请求发出**之前**拿到完整 payload，
 * 这是唯一观测点；本扩展把它转发给 PiDeck 的模型快照端点落盘。
 *
 * **协议**（宿主侧唯一来源 `src/shared/types/modelTrace.ts` 的 `ModelTraceInput`，逐字段对齐；
 * 宿主处理见 `src/main/pi/modelTrace/ModelTraceServer.ts`）：
 * - 请求帧：POST `<PIDECK_MODEL_TRACE_URL>`，头带 `x-pideck-model-trace-token`
 *   `{kind:"request", traceId, ts, model?, provider?, sessionId?, payloadJson, payloadBytes, truncated, messageCount?, toolCount?}`
 * - 响应帧：`{kind:"response", traceId, ts, status, durationMs}`
 *
 * **硬约束**：
 * 1. handler 必须**快速返回且返回 undefined**：pi 的 runner 串行 await 每个 handler，
 *    且非 undefined 返回值会**替换 payload**（`runner.js` emitBeforeProviderRequest）。
 *    fetch 一律 fire-and-forget，绝不 await。
 * 2. fail-safe：本扩展的任何失败只表现为「这一条快照缺席」，绝不影响 pi 会话。
 *    env 缺失（纯终端跑 pi / 宿主端点未就绪）→ 整体不工作。
 * 3. 只推 payload 本体：请求头（含鉴权）**从不采集**；payload 里的系统提示词与消息
 *    是本地诊断数据，只发回本机回环端点（127.0.0.1，同一 token）。
 * 4. payload 超 1.5MB（UTF-8 字节）按**头部**截断：桥端点 body 上限 4MB，而 JSON
 *    转义（引号/换行）会让体积再膨胀，留足余量。截断后 `payloadJson` 不是合法 JSON
 *    （面板按原文展示并标注 truncated）；`payloadBytes` 始终是截断前的真实大小。
 * 5. `after_provider_response` 只在**重试结束后的最终响应**触发一次，`durationMs` 是
 *    到响应头到达的耗时（不含流式消费）；终态失败（重试耗尽/网络错误）**没有该事件**
 *    —— 时间线上只有请求行、没有响应行本身就是「这次调用失败了」的信号
 *    （错误详情看 RPC 日志 recv 侧）。
 * 6. 关闭 RPC 日志（主进程 rpcLoggingAgents）时宿主会丢弃快照：本扩展不做开关同步，
 *    照常采集 —— 一次 stringify + 回环 POST 的代价远小于引入一条状态查询通道。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const log = (message: string): void => {
	process.stderr.write(`[pi-deck-model-trace] ${message}\n`);
};

/** 单条 payload 的 UTF-8 字节上限（见文件头约束 4）。 */
export const MAX_PAYLOAD_BYTES = 1_536_000; // 1.5MB
/** 单次回环 POST 超时：本地通信，超时即认为 PiDeck 不可用。 */
const REQUEST_TIMEOUT_MS = 2_000;
/**
 * 并发上限：正常一次只有一个 provider 请求在飞；超过说明宿主严重迟滞，
 * 此时丢弃快照（诊断数据不值得拖慢 pi）。
 */
const MAX_IN_FLIGHT = 4;
/** 每会话未配对请求的排队上限（响应事件不带 traceId，只能按到达顺序配对）。 */
const MAX_PENDING_PER_SESSION = 8;

type PendingRequest = {
	traceId: string;
	/** 请求发出时刻（compute durationMs 用）。 */
	startedAt: number;
	/** 请求帧是否真的发出去了：没发出去就不要再补一条孤儿响应行。 */
	sent: boolean;
};

/**
 * 生成 traceId：时间戳 36 进制 + 随机后缀。
 * 形态必须匹配宿主侧 `ModelTraceStore` 的 `TRACE_ID_PATTERN`（`[A-Za-z0-9_-]{1,64}`）——
 * traceId 会进文件名，宿主用白名单正则挡路径穿越。
 */
export function makeTraceId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 按 UTF-8 字节保留 JSON 前缀（截断点可能落在多字节字符中间，尾字符会变成 U+FFFD）。
 * 先按字符切再按字节收口：字符数 ≤ 上限时字节数最多 3 倍，避免为几十 MB 的
 * payload（含图片 base64 时）分配等长 Buffer。
 */
export function truncateJsonHead(json: string, maxBytes: number): string {
	const head = Buffer.from(json.slice(0, maxBytes), "utf8");
	return head.length <= maxBytes ? head.toString("utf8") : head.subarray(0, maxBytes).toString("utf8");
}

/** 从供应商原生 payload 里数条数（各家字段名不同，取第一个命中的数组）。 */
export function countArrayField(payload: unknown, keys: readonly string[]): number | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const record = payload as Record<string, unknown>;
	for (const key of keys) {
		const value = record[key];
		if (Array.isArray(value)) return value.length;
	}
	return undefined;
}

/** 会话 key：sessionId 优先；取不到时退化为进程 pid（同进程内配对仍自洽）。 */
function resolveSessionKey(ctx: ExtensionContext): string {
	try {
		const id = ctx.sessionManager?.getSessionId();
		if (typeof id === "string" && id.length > 0) return id;
	} catch {
		// 上下文实现差异兜底：拿到 pid key 继续
	}
	return `pid-${process.pid}`;
}

export default function piDeckModelTrace(pi: ExtensionAPI): void {
	const url = process.env.PIDECK_MODEL_TRACE_URL?.trim();
	const token = process.env.PIDECK_MODEL_TRACE_TOKEN?.trim();
	// 纯终端跑 pi / 宿主端点未就绪：整体不工作（fail-safe）
	if (!url || !token) return;
	const endpoint = url.replace(/\/+$/, "");

	const pendingBySession = new Map<string, PendingRequest[]>();
	let inFlight = 0;
	let droppedCount = 0;

	/** 发一帧（fire-and-forget）。返回是否真的发出去了。 */
	function post(frame: Record<string, unknown>): boolean {
		if (inFlight >= MAX_IN_FLIGHT) {
			droppedCount += 1;
			// 只在首次丢弃时提示，避免刷 pi 的 stderr
			if (droppedCount === 1) log(`快照发送积压超过 ${MAX_IN_FLIGHT} 条，忙时丢弃（不影响 pi 会话）`);
			return false;
		}
		inFlight += 1;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		timer.unref?.();
		void fetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json", "x-pideck-model-trace-token": token },
			body: JSON.stringify(frame),
			signal: controller.signal,
		})
			// PiDeck 不在（应用已退出等）：静默；这是诊断数据，不重试
			.catch(() => undefined)
			.finally(() => {
				clearTimeout(timer);
				inFlight -= 1;
			});
		return true;
	}

	pi.on("before_provider_request", (event, ctx) => {
		try {
			const payload = event.payload;
			if (payload === undefined || payload === null) return undefined;
			// 同步快照：payload 引用随后交给 SDK 序列化/发送，延迟 stringify 有被后续
			// 改动污染的风险（含缓存预热等路径），这里宁可付一次 stringify 的代价。
			const json = JSON.stringify(payload);
			if (typeof json !== "string") return undefined;
			const payloadBytes = Buffer.byteLength(json, "utf8");
			const truncated = payloadBytes > MAX_PAYLOAD_BYTES;
			const sessionKey = resolveSessionKey(ctx);
			const model = ctx.model;
			const pending: PendingRequest = { traceId: makeTraceId(), startedAt: Date.now(), sent: false };

			// 先入队再发送：响应事件一定晚于本 handler 返回，入队顺序即配对顺序
			const queue = pendingBySession.get(sessionKey) ?? [];
			if (queue.length >= MAX_PENDING_PER_SESSION) queue.shift();
			queue.push(pending);
			pendingBySession.set(sessionKey, queue);

			pending.sent = post({
				kind: "request",
				traceId: pending.traceId,
				ts: pending.startedAt,
				model: typeof model?.id === "string" ? model.id : undefined,
				provider: typeof model?.provider === "string" ? model.provider : undefined,
				sessionId: sessionKey,
				payloadJson: truncated ? truncateJsonHead(json, MAX_PAYLOAD_BYTES) : json,
				payloadBytes,
				truncated,
				messageCount: countArrayField(payload, ["messages", "input", "contents"]),
				toolCount: countArrayField(payload, ["tools", "functions"]),
			});
		} catch (error) {
			// 循环引用等极端 payload：这一条缺席，pi 照常
			log(`采集失败（已忽略）: ${error instanceof Error ? error.message : String(error)}`);
		}
		return undefined;
	});

	pi.on("after_provider_response", (event, ctx) => {
		try {
			const sessionKey = resolveSessionKey(ctx);
			const queue = pendingBySession.get(sessionKey);
			const pending = queue?.shift();
			if (queue && queue.length === 0) pendingBySession.delete(sessionKey);
			if (!pending?.sent) return undefined;
			post({
				kind: "response",
				traceId: pending.traceId,
				ts: Date.now(),
				status: event.status,
				durationMs: Date.now() - pending.startedAt,
			});
		} catch {
			// 同上：单条缺席
		}
		return undefined;
	});
}
