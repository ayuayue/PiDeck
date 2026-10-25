/**
 * webMarkdown — Web 端会话导出/复制为 Markdown（P3）。
 *
 * 输入 useChat 的 UIMessage[]（含 SSE 与历史两种来源的 parts），输出与桌面
 * 消息分享同风格的 Markdown：用户/助手轮次 + 折叠的工具调用块。
 * 纯函数（不碰 DOM/clipboard），单测见 tests/webMarkdown.test.mjs。
 */
import type { UIMessage } from "ai";

/** 单条 UIMessage → Markdown 片段；无法识别的内容安全跳过。 */
export function sessionUiMessagesToMarkdown(messages: UIMessage[]): string {
	const blocks: string[] = [];
	for (const message of messages) {
		const lines: string[] = [];
		for (const part of message.parts ?? []) {
			if (part.type === "text" && part.text.trim()) {
				lines.push(part.text.trim());
			} else if (part.type === "reasoning" && typeof part.text === "string" && part.text.trim()) {
				lines.push(`<details>\n<summary>Thinking</summary>\n\n${part.text.trim()}\n\n</details>`);
			} else if (part.type.startsWith("tool-")) {
				const tool = part as { toolCallId?: string; state?: string; input?: unknown; output?: unknown; errorText?: string };
				const name = part.type.slice("tool-".length);
				const body = [tool.input !== undefined ? `Input:\n\`\`\`json\n${safeJson(tool.input)}\n\`\`\`` : null, tool.errorText ? `Error: ${tool.errorText}` : tool.output !== undefined ? `Output:\n\`\`\`json\n${safeJson(tool.output)}\n\`\`\`` : null].filter(Boolean).join("\n\n");
				lines.push(`<details>\n<summary>Tool: ${name}${tool.state === "output-error" ? " (error)" : ""}</summary>\n\n${body || "—"}\n\n</details>`);
			} else if (part.type === "file") {
				const file = part as { mediaType?: string; data?: string };
				if (typeof file.data === "string" && file.data.startsWith("data:")) {
					lines.push(`![${file.mediaType ?? "image"}](${truncate(file.data, 64)})`);
				}
			}
		}
		if (lines.length === 0) continue;
		const speaker = message.role === "user" ? "🧑 **User**" : "🤖 **Assistant**";
		blocks.push(`### ${speaker}\n\n${lines.join("\n\n")}`);
	}
	return blocks.join("\n\n---\n\n");
}

function safeJson(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max)}…`;
}
