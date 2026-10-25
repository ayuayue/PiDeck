/**
 * Web 端会话内消息搜索（纯函数，供 WebSearchDialog 使用）。
 *
 * 只搜「已加载」的消息（流式消息 + 已拉取的历史页）——全会话磁盘搜索
 * 需要后端索引，超出第二批范围；未加载部分由 UI 提示「加载更早消息可扩大范围」。
 */
import type { UIMessage } from "ai";

export type WebSearchHit = {
	/** UIMessage.id（跳转滚动锚点） */
	id: string;
	role: string;
	/** 匹配处前后各 ~40 字符的片段 */
	snippet: string;
};

const SNIPPET_RADIUS = 40;
const MAX_HITS = 50;

/** 提取一条消息的纯文本（text parts 拼接；工具/思考等非正文不参与搜索）。 */
export function webMessageText(message: UIMessage): string {
	const parts = Array.isArray(message.parts) ? message.parts : [];
	return parts
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

export function searchWebMessages(messages: UIMessage[], query: string, limit = MAX_HITS): WebSearchHit[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [];
	const hits: WebSearchHit[] = [];
	for (const message of messages) {
		const text = webMessageText(message);
		if (!text) continue;
		const lower = text.toLowerCase();
		const index = lower.indexOf(needle);
		if (index < 0) continue;
		const start = Math.max(0, index - SNIPPET_RADIUS);
		const end = Math.min(text.length, index + needle.length + SNIPPET_RADIUS);
		hits.push({
			id: message.id,
			role: message.role,
			snippet: `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
		});
		if (hits.length >= limit) break;
	}
	return hits;
}
