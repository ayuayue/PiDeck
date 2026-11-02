import { AGENT_ICON_LUCIDE_PREFIX } from "../../../../shared/types/agentProfile";

/**
 * icon 字段的三种形态：内置组件图标（`lucide:<id>`）、文本（emoji）、空（渲染层回退机器人图标）。
 * 解析放纯函数模块里：渲染组件和标题拼接共用一套判定，node:test 也能直接加载。
 */
export type AgentIconRef = { kind: "lucide"; id: string } | { kind: "text"; text: string } | { kind: "empty" };

export function parseAgentIcon(icon: string | null | undefined): AgentIconRef {
	const value = icon?.trim() ?? "";
	if (!value) return { kind: "empty" };
	// 编码可能来自手输、MCP 工具或旧数据，大小写不强制（lucide id 本身全小写，这里统一收小写）。
	if (value.toLowerCase().startsWith(AGENT_ICON_LUCIDE_PREFIX)) {
		const id = value.slice(AGENT_ICON_LUCIDE_PREFIX.length).trim().toLowerCase();
		return id ? { kind: "lucide", id } : { kind: "empty" };
	}
	return { kind: "text", text: value };
}

/** 选择器选中内置图标时写入 icon 字段的编码。 */
export function agentIconValueOfLucide(id: string): string {
	return `${AGENT_ICON_LUCIDE_PREFIX}${id}`;
}

/**
 * 会话标题前缀：只有 emoji 能进标题（侧栏一眼识别）；组件图标没有文本形态，直接省略。
 */
export function buildAgentSessionTitle(agent: { name: string; icon: string }): string {
	const parsed = parseAgentIcon(agent.icon);
	return `${parsed.kind === "text" ? `${parsed.text} ` : ""}${agent.name}`.trim();
}
