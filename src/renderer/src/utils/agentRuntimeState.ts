import type { AgentRuntimeState } from "../../../shared/types";

/**
 * 合并异步 runtime 快照。完整状态查询可能晚于原始 tool start/end 事件返回，
 * 因此迟到快照只更新模型/token 等字段，不能倒灌旧的工具执行状态。
 */
export function mergeAgentRuntimeState(
  current: AgentRuntimeState | undefined,
  incoming: AgentRuntimeState,
): AgentRuntimeState {
  if (
    current?.toolStateSequence != null &&
    incoming.toolStateSequence != null &&
    incoming.toolStateSequence < current.toolStateSequence
  ) {
    const {
      isExecutingTool: _staleToolFlag,
      executingToolName: _staleToolName,
      toolStateSequence: _staleToolSequence,
      ...nonToolState
    } = incoming;
    return { ...current, ...nonToolState };
  }
  return { ...current, ...incoming };
}
