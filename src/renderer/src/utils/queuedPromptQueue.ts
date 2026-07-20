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

export function replaceAgentQueue(
  current: QueuedPromptMap,
  agentId: string,
  updater: (queue: QueuedPromptSnapshot[]) => QueuedPromptSnapshot[],
): QueuedPromptMap {
  const nextQueue = updater(current[agentId] ?? []);
  const next = { ...current };
  if (nextQueue.length > 0) next[agentId] = nextQueue;
  else delete next[agentId];
  return next;
}

/**
 * 入队；已达 QUEUED_PROMPT_LIMIT 时返回原 map 且不追加。
 * 调用方应检查返回值 length 是否增加，以决定是否 toast / 保留输入。
 */
export function enqueuePrompt(
  current: QueuedPromptMap,
  agentId: string,
  prompt: QueuedPromptSnapshot,
  limit: number = QUEUED_PROMPT_LIMIT,
): QueuedPromptMap {
  const existing = current[agentId] ?? [];
  if (existing.length >= limit) return current;
  return replaceAgentQueue(current, agentId, (queue) => [
    ...queue,
    { ...prompt, status: "pending", error: undefined },
  ]);
}

/** 面板只展示前 visibleLimit 条，其余用 +N 提示。 */
export function getQueuedPromptView(
  queue: QueuedPromptSnapshot[],
  visibleLimit: number = QUEUED_PROMPT_VISIBLE,
): { visible: QueuedPromptSnapshot[]; hiddenCount: number } {
  const limit = Math.max(0, visibleLimit);
  return {
    visible: queue.slice(0, limit),
    hiddenCount: Math.max(0, queue.length - limit),
  };
}

/** 撤回输入框：sending/unknown 禁用（可能已提交，防双发/误导）。 */
export function canRetractQueuedPromptToInput(
  status?: QueuedPromptStatus,
): boolean {
  return status !== "sending" && status !== "unknown";
}

/** 丢弃：sending 禁用；unknown 仅清提示，pending/failed 真正移除。 */
export function canDiscardQueuedPrompt(status?: QueuedPromptStatus): boolean {
  return status !== "sending";
}

export function retryFailedPrompt(
  current: QueuedPromptMap,
  agentId: string,
  promptId: string,
): QueuedPromptMap {
  return replaceAgentQueue(current, agentId, (queue) =>
    queue.map((prompt) =>
      prompt.id === promptId && prompt.status === "failed"
        ? { ...prompt, status: "pending", error: undefined }
        : prompt,
    ),
  );
}

/**
 * 只有尚未提交或已被 pi 明确拒绝的消息可撤回。sending 可能已经被接收，unknown
 * 更明确表示结果不可判定；删除这两类快照会让用户误以为消息肯定没有送达。
 */
export function retractPrompt(
  current: QueuedPromptMap,
  agentId: string,
  promptId: string,
): QueuedPromptMap {
  return replaceAgentQueue(current, agentId, (queue) =>
    queue.filter(
      (prompt) =>
        prompt.id !== promptId ||
        prompt.status === "sending" ||
        prompt.status === "unknown",
    ),
  );
}

/** 用户检查会话后仅移除未知结果提示；该操作永远不重新提交原快照。 */
export function acknowledgeUnknownPrompt(
  current: QueuedPromptMap,
  agentId: string,
  promptId: string,
): QueuedPromptMap {
  return replaceAgentQueue(current, agentId, (queue) =>
    queue.filter(
      (prompt) => prompt.id !== promptId || prompt.status !== "unknown",
    ),
  );
}

/** 原子 claim 指定快照；只有 pending 能进入 sending。 */
export function claimPrompt(
  current: QueuedPromptMap,
  agentId: string,
  promptId: string,
): { queues: QueuedPromptMap; prompt?: QueuedPromptSnapshot } {
  const prompt = current[agentId]?.find((item) => item.id === promptId);
  if (!prompt || (prompt.status != null && prompt.status !== "pending")) {
    return { queues: current };
  }
  return {
    queues: replaceAgentQueue(current, agentId, (queue) =>
      queue.map((item) =>
        item.id === promptId
          ? { ...item, status: "sending", error: undefined }
          : item,
      ),
    ),
    prompt,
  };
}

/** idle drain 严格只查看队首；失败/未知队首会阻止越过它发送后续消息。 */
export function claimIdleHead(
  current: QueuedPromptMap,
  agentId: string,
): { queues: QueuedPromptMap; prompt?: QueuedPromptSnapshot } {
  const head = current[agentId]?.[0];
  if (!head) return { queues: current };
  return claimPrompt(current, agentId, head.id);
}

export function resolveClaimedPrompt(
  current: QueuedPromptMap,
  agentId: string,
  promptId: string,
  outcome:
    | { type: "accepted" }
    | { type: "failed" | "unknown"; error: string },
): QueuedPromptMap {
  return replaceAgentQueue(current, agentId, (queue) => {
    const live = queue.find((prompt) => prompt.id === promptId);
    if (!live || live.status !== "sending") return queue;
    if (outcome.type === "accepted") {
      return queue.filter((prompt) => prompt.id !== promptId);
    }
    return queue.map((prompt) =>
      prompt.id === promptId
        ? { ...prompt, status: outcome.type, error: outcome.error }
        : prompt,
    );
  });
}

/** 同一 final tool-end 窗口按队列顺序原子 claim 第一个 pending steer。 */
export function claimNextSteerPrompt(
  current: QueuedPromptMap,
  agentId: string,
): { queues: QueuedPromptMap; prompt?: QueuedPromptSnapshot } {
  for (const prompt of current[agentId] ?? []) {
    // Any indeterminate/in-flight predecessor is an ordering barrier, regardless of its delivery
    // mode. Pending follow-up entries may be skipped intentionally so a later steer can still join
    // the current turn, but rejected/unknown predecessors require explicit user resolution first.
    if (
      prompt.status === "failed" ||
      prompt.status === "unknown" ||
      prompt.status === "sending"
    ) {
      return { queues: current };
    }
    if (prompt.behavior !== "steer") continue;
    return claimPrompt(current, agentId, prompt.id);
  }
  return { queues: current };
}

/**
 * 重启只迁移确定尚未投递的 pending/failed 项。sending/unknown 可能已被旧进程接收，
 * 复制到 replacement agent 会造成重复发送，因此必须丢弃。
 */
export function migrateQueuedPrompts(
  current: QueuedPromptMap,
  replacementById: Map<string, string>,
  liveIds: Set<string>,
): QueuedPromptMap {
  const next: QueuedPromptMap = {};
  for (const [agentId, queue] of Object.entries(current)) {
    const replacementId = replacementById.get(agentId);
    const targetAgentId = replacementId ?? agentId;
    if (!liveIds.has(targetAgentId)) continue;
      const safeQueue = replacementId
      ? queue.filter(
          (prompt) =>
            prompt.status !== "sending" && prompt.status !== "unknown",
        )
      : queue;
    if (safeQueue.length > 0) next[targetAgentId] = safeQueue;
  }
  return next;
}

