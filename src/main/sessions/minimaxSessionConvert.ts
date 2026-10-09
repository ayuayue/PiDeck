import { createHash } from "node:crypto";
import type { SessionImportCopy } from "./SessionImportCopy";
import { safeIsoTimestamp } from "./importNormalize";
import { zeroUsage } from "./kimiSessionConvert";
import type { MinimaxSessionMeta } from "./minimaxSessionSource";

/** messages.jsonl 行的外层形状：{message_id, turn_id, message:{role, content[], timestamp}}。 */
export type MinimaxMessageRecord = Record<string, unknown>;

function makeId(sessionId: string, sequence: number): string {
	return createHash("sha1").update(`${sessionId}:${sequence}`).digest("hex").slice(0, 8);
}

/**
 * content block 归一化：text/thinking 直通，tool_use/tool_result 保留原形状
 * （minimax 的消息体与 Anthropic 块结构同源），未知形状降级为 JSON 占位文本
 * ——渲染层不会因未知块崩，用户至少能看到原文（与 importNormalize 同思路）。
 */
function toContentBlocks(content: unknown): unknown[] {
	const blocks = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
	return blocks.map((block) => {
		if (block && typeof block === "object" && "type" in block) {
			const type = String((block as { type: unknown }).type);
			if (type === "text" || type === "thinking" || type === "tool_use" || type === "tool_result") return block;
		}
		return { type: "text", text: safeStringify(block) };
	});
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function extractPreviewText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (block && typeof block === "object" && "text" in block && typeof (block as { text: unknown }).text === "string" ? (block as { text: string }).text : ""))
		.filter(Boolean)
		.join(" ")
		.slice(0, 200)
		.replace(/\s+/g, " ")
		.trim();
}

export type ConvertMinimaxSessionInput = {
	projectPath: string;
	meta: MinimaxSessionMeta;
	translate: SessionImportCopy;
	/** 消息记录流（扫描摘要传 headLines 小数组，正式导入传逐行异步流）。 */
	entries: AsyncIterable<MinimaxMessageRecord> | MinimaxMessageRecord[];
	/** 行接收器（导入时写临时文件，扫描时压到小数组）。 */
	sink: (line: string) => void;
};

export type ConvertMinimaxSessionResult = {
	title: string;
	preview: string;
	messageCount: number;
};

/**
 * minimax messages.jsonl → pi 原生会话 JSONL（session 头 + minimax_import 标记 + message 行）。
 * 行格式与 Codex/Kimi 导入器同构（version:3 session 头、message:{role,content,timestamp}），
 * 这样 SessionScanner / 渲染层零特判。纯函数（sink 注入），扫描摘要与正式导入共用，
 * 标题/预览口径一致。
 */
export async function convertMinimaxSessionTo(input: ConvertMinimaxSessionInput): Promise<ConvertMinimaxSessionResult> {
	const { meta, sink } = input;
	// 先转换消息行算出标题，再回头写 session 头（头必须在文件首位，且带 name 才能让
	// SessionScanner 直接命中会话名；否则 scanner 回退「首条 user 文本」，会把 minimax
	// 注入的 <system-reminder> 上下文块当成标题（issue：标题匹配上了提示词））。
	const bodyLines: string[] = [];
	const emit = (line: string): void => {
		bodyLines.push(line);
	};

	let title = "";
	let preview = "";
	let messageCount = 0;
	let sequence = 0;
	let parentId: string | undefined;
	let lastTimestamp = meta.createdAt;
	for await (const record of input.entries) {
		const message = (record as { message?: { role?: unknown; content?: unknown; timestamp?: unknown } }).message;
		if (!message || typeof message !== "object") continue;
		const role = String(message.role ?? "user");
		if (role !== "user" && role !== "assistant") continue;
		const content = toContentBlocks(message.content);
		if (content.length === 0) continue;

		const tsNumber = Number(message.timestamp);
		if (Number.isFinite(tsNumber) && tsNumber > 0) lastTimestamp = tsNumber;
		const id = makeId(meta.sessionId, sequence++);
		const ts = safeIsoTimestamp(lastTimestamp);
		const messageBody: Record<string, unknown> = { role, content, timestamp: lastTimestamp };
		if (role === "assistant") messageBody.usage = zeroUsage();
		emit(JSON.stringify({ type: "message", id, parentId, timestamp: ts, message: messageBody }));
		parentId = id;

		messageCount += 1;
		// 标题取首条真实用户输入：minimax 会话首条 user 常是 <system-reminder> 注入上下文，直接当标题无意义
		if (!title && role === "user") {
			const candidate = extractPreviewText(message.content);
			if (candidate && !candidate.startsWith("<system-reminder>")) {
				preview = candidate;
				title = candidate.slice(0, 80);
			}
		}
	}
	// 标题优先级：sqlite 索引里的会话名（minimaxcode UI 同款，如「打招呼」）> 首条真实
	// 首问（循环内提取，跳过 <system-reminder> 注入块）> i18n 兜底
	if (meta.sourceTitle) title = meta.sourceTitle.slice(0, 80);
	if (!title) title = input.translate("session.importedTitle", { source: "MinimaxCode" });
	// 顺序：session 头（带 name）→ 溯源标记 → 消息行。name 让 scanner 直接命中会话名。
	const startTime = safeIsoTimestamp(meta.createdAt);
	sink(JSON.stringify({ type: "session", version: 3, id: meta.sessionId, name: title, timestamp: startTime, cwd: meta.cwd || input.projectPath }));
	sink(
		JSON.stringify({
			type: "minimax_import",
			version: 1,
			sourcePath: meta.messagesPath,
			sourceMtime: meta.sourceMtime,
			sourceSize: meta.sourceSize,
			importedAt: new Date().toISOString(),
		}),
	);
	for (const line of bodyLines) sink(line);
	return { title, preview, messageCount };
}
