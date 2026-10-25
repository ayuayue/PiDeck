/**
 * RPC 日志契约层。
 * pi 与桌面端之间一条请求/响应/事件的摘要记录，由主进程 RpcLogger 生成，
 * 同时用于文件落盘（JSONL）、主进程环形缓冲（实时历史）与渲染层实时查看弹窗。
 */

/** 一条 RPC 通信日志（direction: "send" 为桌面端→pi 的请求，"recv" 为 pi 侧响应/事件） */
export interface RpcLogEntry {
	id: string;
	agentId: string;
	direction: string;
	summary: string;
	time: number;
	data?: unknown;
}

/**
 * 主进程批量推送的实时日志批次。
 * RPC 通信在流式阶段可能非常高频，逐条 IPC 会打爆渲染进程；
 * 主进程按 agent 聚合、节流（~80ms）后一次性推送。
 */
export interface RpcLogBatch {
	agentId: string;
	entries: RpcLogEntry[];
}

/**
 * 模型请求快照在 RPC 日志条目里的**紧凑摘要**（direction: "model"）。
 *
 * 完整请求体（可能上百 KB）不进环形缓冲与 IPC 批次，另存
 * userData/logs/model-traces/<agentId>-<traceId>.json，面板展开时按 traceId 回读。
 */
export interface ModelTraceLogData {
	/** request = pi 发出的供应商请求；response = 该请求的最终 HTTP 状态。 */
	kind: "request" | "response";
	traceId: string;
	model?: string;
	provider?: string;
	messageCount?: number;
	toolCount?: number;
	payloadBytes?: number;
	truncated?: boolean;
	status?: number;
	durationMs?: number;
}

/** 判断一条日志条目的 data 是否为模型快照摘要（渲染层按 kind 区分请求/响应行）。 */
export function isModelTraceLogData(value: unknown): value is ModelTraceLogData {
	if (typeof value !== "object" || value === null) return false;
	const data = value as Record<string, unknown>;
	return (data.kind === "request" || data.kind === "response") && typeof data.traceId === "string";
}
