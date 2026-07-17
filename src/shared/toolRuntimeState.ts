/** 当前 agent 的并行工具调用集合，以及本次事件是否结束了整个工具批次。 */
export interface ActiveToolCallState {
  calls: Map<string, string>;
  isExecutingTool: boolean;
  executingToolName?: string;
  completedBatch: boolean;
}

/**
 * 以 toolCallId 归并并行工具事件。只有已追踪集合从非空变为空时才产生 final-end，
 * 防止首个并行工具结束或迟到的重复 end 被误判成可投递 steer 的窗口。
 */
export function updateActiveToolCalls(
  current: ReadonlyMap<string, string>,
  event:
    | { type: "start"; toolCallId: string; toolName: string }
    | { type: "end"; toolCallId: string },
): ActiveToolCallState {
  const calls = new Map(current);
  if (event.type === "start") {
    calls.set(event.toolCallId, event.toolName);
  } else {
    calls.delete(event.toolCallId);
  }
  const executingToolName = Array.from(calls.values()).at(-1);
  return {
    calls,
    isExecutingTool: calls.size > 0,
    executingToolName,
    completedBatch: event.type === "end" && current.size > 0 && calls.size === 0,
  };
}
