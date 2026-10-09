import type { AgentRuntimeState } from "../../../shared/types";

/**
 * 合并异步 runtime 快照。完整状态查询可能晚于原始 tool start/end 事件返回，
 * 因此迟到快照不能倒灌旧工具状态或拆散最近一次回复的整组性能指标。
 */
export function mergeAgentRuntimeState(current: AgentRuntimeState | undefined, incoming: AgentRuntimeState): AgentRuntimeState {
	const merged = { ...current, ...incoming };
	if (current?.toolStateSequence != null && incoming.toolStateSequence != null && incoming.toolStateSequence < current.toolStateSequence) {
		merged.isExecutingTool = current.isExecutingTool;
		merged.executingToolName = current.executingToolName;
		merged.toolStateSequence = current.toolStateSequence;
	}
	if (current?.perfAt != null && (incoming.perfAt == null || incoming.perfAt < current.perfAt)) {
		merged.ttftMs = current.ttftMs;
		merged.totalMs = current.totalMs;
		merged.endToEndTps = current.endToEndTps;
		merged.tps = current.tps;
		merged.perfAt = current.perfAt;
	}
	if (current && Object.keys(merged).every((key) => current[key as keyof AgentRuntimeState] === merged[key as keyof AgentRuntimeState])) {
		return current;
	}
	return merged;
}
