/** 当前 agent 的并行工具调用集合，以及本次事件是否结束了整个工具批次。 */
export interface ActiveToolCallState {
	calls: Map<string, string>;
	isExecutingTool: boolean;
	executingToolName?: string;
	completedBatch: boolean;
}

/**
 * 解析 end 事件应移除的 key。
 *
 * pi 的 tool_execution_start 在缺少 toolCallId 时由调用方合成 `${toolName}-${timestamp}` 兜底 key，
 * 而 tool_execution_end 缺 id 时只能拿到空串——按空串删除永远删不掉，该工具会永久停在
 * 「执行中」：底栏一直显示工具名，且 AgentManager.markIdleIfPiReportsNoWork 的兜底判空闲
 * 也被同一个标志挡住，会话再也不会回到 idle（2026-09 用户报「工具返回后卡住」的一类成因）。
 * 因此 id 缺失时按 toolName 回退匹配（同名并行取最后一个），再不行且只剩一个在跑时按唯一项删除。
 */
function resolveEndToolCallKey(calls: ReadonlyMap<string, string>, toolCallId: string, toolName: string | undefined): string | undefined {
	// id 明确且仍被追踪：正常路径
	if (toolCallId && calls.has(toolCallId)) return toolCallId;
	// id 明确但不在集合里（重复/迟到的 end）：不动任何条目，保持原 delete 的 no-op 语义
	if (toolCallId) return undefined;
	if (toolName) {
		const matched = Array.from(calls.entries())
			.filter(([, name]) => name === toolName)
			.at(-1);
		if (matched) return matched[0];
	}
	// 无 id 也无名字可匹配：仅当在跑的工具唯一时才敢归属，避免误删并行批次里的其他工具
	if (calls.size === 1) return Array.from(calls.keys())[0];
	return undefined;
}

/**
 * 以 toolCallId 归并并行工具事件。只有已追踪集合从非空变为空时才产生 final-end，
 * 防止首个并行工具结束或迟到的重复 end 被误判成可投递 steer 的窗口。
 */
export function updateActiveToolCalls(current: ReadonlyMap<string, string>, event: { type: "start"; toolCallId: string; toolName: string } | { type: "end"; toolCallId: string; toolName?: string }): ActiveToolCallState {
	const calls = new Map(current);
	if (event.type === "start") {
		calls.set(event.toolCallId, event.toolName);
	} else {
		// key 无法归属时宁可不删：保留「仍有工具在跑」比误判成 steer 窗口安全
		const key = resolveEndToolCallKey(calls, event.toolCallId, event.toolName);
		if (key !== undefined) calls.delete(key);
	}
	const executingToolName = Array.from(calls.values()).at(-1);
	return {
		calls,
		isExecutingTool: calls.size > 0,
		executingToolName,
		completedBatch: event.type === "end" && current.size > 0 && calls.size === 0,
	};
}
