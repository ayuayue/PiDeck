/**
 * 模型请求快照（pi-deck-model-trace → `POST <PIDECK_MODEL_TRACE_URL>`）的跨进程契约。
 *
 * 这是「pi 实际发给模型供应商的请求体」的只读快照 —— 它不走 RPC 通道（在 pi 进程内
 * 就进了 provider SDK），只能靠 `before_provider_request` 扩展钩子取到。
 * **不含鉴权头**（那些在 `before_provider_headers`，明确不采集）。
 *
 * 桥侧镜像在 `resources/extensions/pi-deck-model-trace.ts`（自包含 .ts，不能 import
 * 本仓库 TS），字段一致性由 `tests/modelTraceExtension.test.mjs` 兜底。
 */

/** 一次 provider 请求的完整快照（截断后仍是「原样发送」的 JSON 文本）。 */
export type ModelTraceRequestInput = {
	kind: "request";
	/** 扩展侧生成（毫秒时间戳 + 随机后缀），同时用作落盘文件名的一部分。 */
	traceId: string;
	ts: number;
	/** 请求体里的模型名（payload.model，缺失时回退 ctx.model.id）。 */
	model?: string;
	provider?: string;
	/** pi 的会话 id（跨重启稳定，用于把 trace 归到会话）。 */
	sessionId?: string;
	/** 供应商请求体的 JSON 文本；超上限按字节截断（truncated=true）。 */
	payloadJson: string;
	/** 截断前原始 UTF-8 字节数。 */
	payloadBytes: number;
	truncated: boolean;
	messageCount?: number;
	toolCount?: number;
};

/** provider 响应（只记状态码与耗时，响应体与响应头都不采集）。 */
export type ModelTraceResponseInput = {
	kind: "response";
	traceId: string;
	ts: number;
	status: number;
	durationMs?: number;
};

/** 扩展推给宿主的一条模型快照消息。 */
export type ModelTraceInput = ModelTraceRequestInput | ModelTraceResponseInput;

/** 落盘/回读的请求快照（落盘形态在请求体上补 agentId 归属）。 */
export type ModelTraceRecord = ModelTraceRequestInput & { agentId: string };
