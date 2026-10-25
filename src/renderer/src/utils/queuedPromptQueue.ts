import type { ComposerAgentMode, ImageContent } from "../../../shared/types";

/** Renderer 中仍未被 pi 明确接收的消息快照。 */
export type QueuedPromptStatus = "pending" | "sending" | "failed" | "unknown";

export interface QueuedPromptSnapshot {
	id: string;
	message: string;
	displayText: string;
	images?: ImageContent[];
	/** Original delivery intent; direct submissions use "direct" for neutral card copy. */
	behavior: "steer" | "followUp" | "direct";
	agentMode: ComposerAgentMode;
	templateDescription?: string;
	timestamp: number;
	status?: QueuedPromptStatus;
	error?: string;
}

export type QueuedPromptMap = Record<string, QueuedPromptSnapshot[]>;

/** 单会话待发送队列上限；超出时拒绝入队，保留输入框内容。 */
export const QUEUED_PROMPT_LIMIT = 10;
/** 队列面板默认最多展示的行数，超出以 +N 提示。 */
export const QUEUED_PROMPT_VISIBLE = 3;

export function replaceSessionQueue(current: QueuedPromptMap, sessionId: string, updater: (queue: QueuedPromptSnapshot[]) => QueuedPromptSnapshot[]): QueuedPromptMap {
	const nextQueue = updater(current[sessionId] ?? []);
	const next = { ...current };
	if (nextQueue.length > 0) next[sessionId] = nextQueue;
	else delete next[sessionId];
	return next;
}

/**
 * 入队；已达 QUEUED_PROMPT_LIMIT 时返回原 map 且不追加。
 * 调用方应检查返回值 length 是否增加，以决定是否 toast / 保留输入。
 */
export function enqueuePrompt(current: QueuedPromptMap, sessionId: string, prompt: QueuedPromptSnapshot, limit: number = QUEUED_PROMPT_LIMIT): QueuedPromptMap {
	const existing = current[sessionId] ?? [];
	if (existing.length >= limit) return current;
	return replaceSessionQueue(current, sessionId, (queue) => [...queue, { ...prompt, status: "pending", error: undefined }]);
}

/** 面板只展示前 visibleLimit 条，其余用 +N 提示。 */
export function getQueuedPromptView(queue: QueuedPromptSnapshot[], visibleLimit: number = QUEUED_PROMPT_VISIBLE): { visible: QueuedPromptSnapshot[]; hiddenCount: number } {
	const limit = Math.max(0, visibleLimit);
	return {
		visible: queue.slice(0, limit),
		hiddenCount: Math.max(0, queue.length - limit),
	};
}

/** 撤回输入框：sending/unknown 禁用（可能已提交，防双发/误导）。 */
export function canRetractQueuedPromptToInput(status?: QueuedPromptStatus): boolean {
	return status !== "sending" && status !== "unknown";
}

/** 丢弃：sending 禁用；unknown 仅清提示，pending/failed 真正移除。 */
export function canDiscardQueuedPrompt(status?: QueuedPromptStatus): boolean {
	return status !== "sending";
}

/** 矩阵项的可用性提示：disabled=false 可操作；disabled=true 时给出禁用原因，供 UI 渲染 tooltip/aria。 */
export type QueueControlHint = { disabled: false; reason?: undefined } | { disabled: true; reason: "sending" | "unknown" };

/** 撤回（撤回修改）的可用性：sending/unknown 禁用，原因用于展示禁用提示。 */
export function retractControlHint(status?: QueuedPromptStatus): QueueControlHint {
	if (status === "sending") return { disabled: true, reason: "sending" };
	if (status === "unknown") return { disabled: true, reason: "unknown" };
	return { disabled: false };
}

/** 丢弃的可用性：仅 sending 禁用，原因用于展示禁用提示。 */
export function discardControlHint(status?: QueuedPromptStatus): QueueControlHint {
	if (status === "sending") return { disabled: true, reason: "sending" };
	return { disabled: false };
}

/** 改投递方式（插入/排队）：sending/unknown 已离开关闭窗口，不能再改。 */
export function canChangeQueuedPromptBehavior(status?: QueuedPromptStatus): boolean {
	return status !== "sending" && status !== "unknown";
}

/** 把尚未投递的条目改成插入当前回合或排队到下一轮；非法状态原样返回。 */
export function updateQueuedPromptBehavior(current: QueuedPromptMap, sessionId: string, promptId: string, behavior: "steer" | "followUp"): QueuedPromptMap {
	return replaceSessionQueue(current, sessionId, (queue) =>
		queue.map((prompt) => {
			if (prompt.id !== promptId) return prompt;
			if (!canChangeQueuedPromptBehavior(prompt.status)) return prompt;
			if (prompt.behavior === behavior) return prompt;
			return { ...prompt, behavior };
		}),
	);
}

export function retryFailedPrompt(current: QueuedPromptMap, sessionId: string, promptId: string): QueuedPromptMap {
	return replaceSessionQueue(current, sessionId, (queue) => queue.map((prompt) => (prompt.id === promptId && prompt.status === "failed" ? { ...prompt, status: "pending", error: undefined } : prompt)));
}

/**
 * 只有尚未提交或已被 pi 明确拒绝的消息可撤回。sending 可能已经被接收，unknown
 * 更明确表示结果不可判定；删除这两类快照会让用户误以为消息肯定没有送达。
 */
export function retractPrompt(current: QueuedPromptMap, sessionId: string, promptId: string): QueuedPromptMap {
	return replaceSessionQueue(current, sessionId, (queue) => queue.filter((prompt) => prompt.id !== promptId || prompt.status === "sending" || prompt.status === "unknown"));
}

/** 用户检查会话后仅移除未知结果提示；该操作永远不重新提交原快照。 */
export function acknowledgeUnknownPrompt(current: QueuedPromptMap, sessionId: string, promptId: string): QueuedPromptMap {
	return replaceSessionQueue(current, sessionId, (queue) => queue.filter((prompt) => prompt.id !== promptId || prompt.status !== "unknown"));
}

/** 原子 claim 指定快照；只有 pending 能进入 sending。 */
export function claimPrompt(current: QueuedPromptMap, sessionId: string, promptId: string): { queues: QueuedPromptMap; prompt?: QueuedPromptSnapshot } {
	const prompt = current[sessionId]?.find((item) => item.id === promptId);
	if (!prompt || (prompt.status != null && prompt.status !== "pending")) {
		return { queues: current };
	}
	return {
		queues: replaceSessionQueue(current, sessionId, (queue) => queue.map((item) => (item.id === promptId ? { ...item, status: "sending", error: undefined } : item))),
		prompt,
	};
}

/** idle drain 严格只查看队首；失败/未知队首会阻止越过它发送后续消息。 */
export function claimIdleHead(current: QueuedPromptMap, sessionId: string): { queues: QueuedPromptMap; prompt?: QueuedPromptSnapshot } {
	const head = current[sessionId]?.[0];
	if (!head) return { queues: current };
	return claimPrompt(current, sessionId, head.id);
}

export function resolveClaimedPrompt(current: QueuedPromptMap, sessionId: string, promptId: string, outcome: { type: "accepted" } | { type: "failed" | "unknown"; error: string }): QueuedPromptMap {
	return replaceSessionQueue(current, sessionId, (queue) => {
		const live = queue.find((prompt) => prompt.id === promptId);
		if (!live || live.status !== "sending") return queue;
		if (outcome.type === "accepted") {
			return queue.filter((prompt) => prompt.id !== promptId);
		}
		return queue.map((prompt) => (prompt.id === promptId ? { ...prompt, status: outcome.type, error: outcome.error } : prompt));
	});
}

/** 同一 final tool-end 窗口按队列顺序原子 claim 第一个 pending steer。 */
export function claimNextSteerPrompt(current: QueuedPromptMap, sessionId: string): { queues: QueuedPromptMap; prompt?: QueuedPromptSnapshot } {
	for (const prompt of current[sessionId] ?? []) {
		// Any indeterminate/in-flight predecessor is an ordering barrier, regardless of its delivery
		// mode. Pending follow-up entries may be skipped intentionally so a later steer can still join
		// the current turn, but rejected/unknown predecessors require explicit user resolution first.
		if (prompt.status === "failed" || prompt.status === "unknown" || prompt.status === "sending") {
			return { queues: current };
		}
		if (prompt.behavior !== "steer") continue;
		return claimPrompt(current, sessionId, prompt.id);
	}
	return { queues: current };
}
