import type { AgentProfile } from "../../../shared/types";

/**
 * 解析会话绑定的智能体（「使用」智能体时写入 sessionAgentBindings）。
 *
 * 悬空 id（智能体已删除 / 绑定表被手改）返回 null —— 与会话绑定主进程侧读盘归一化同语义，
 * 渲染层不抛错、不展示半个提示条。
 */
export function resolveBoundSessionAgent(bindings: Readonly<Record<string, string>> | undefined, agents: readonly AgentProfile[], sessionId: string | undefined): AgentProfile | null {
	if (!bindings || !sessionId) return null;
	const agentId = bindings[sessionId];
	if (!agentId) return null;
	return agents.find((agent) => agent.id === agentId) ?? null;
}
