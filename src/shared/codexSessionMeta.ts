export type CodexSessionThreadSource = "user" | "subagent";

export type CodexSessionThreadInfo = {
	threadSource: CodexSessionThreadSource;
	parentThreadId?: string;
	agentRole?: string;
	agentNickname?: string;
};

function stringValue(value: unknown) {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** unknown 值收窄为可选对象记录（codex 会话 meta 的嵌套 source/subagent 结构）。 */
function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

export function getCodexSessionThreadInfo(meta: Record<string, unknown>): CodexSessionThreadInfo {
	const source = recordValue(meta.source);
	const spawn = recordValue(recordValue(source?.subagent)?.thread_spawn);
	// 子代理判断：thread_source 明确标记、或旧格式缺字段时靠 parent_thread_id 回退检测。
	// 显式为 "user" 时即使有 parent_thread_id 也不判定为子代理，避免误判。
	const isSubagent = meta.thread_source === "subagent" || (meta.thread_source !== "user" && Boolean(meta.parent_thread_id)) || Boolean(source?.subagent);

	if (!isSubagent) {
		return {
			threadSource: "user",
			parentThreadId: undefined,
			agentRole: undefined,
			agentNickname: undefined,
		};
	}

	return {
		threadSource: "subagent",
		parentThreadId: stringValue(meta.parent_thread_id) ?? stringValue(spawn?.parent_thread_id) ?? stringValue(meta.session_id),
		agentRole: stringValue(meta.agent_role) ?? stringValue(spawn?.agent_role),
		agentNickname: stringValue(meta.agent_nickname) ?? stringValue(spawn?.agent_nickname),
	};
}
