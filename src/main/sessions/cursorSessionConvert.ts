import { createHash, randomUUID } from "node:crypto";
import type { SessionImportCopy } from "./SessionImportCopy";
import { asArray, extractCursorUserText, joinCursorTextBlocks, parseCursorTimestampFromText, readRecord, readString, type CursorRecord, type ParsedCursorSession } from "./cursorSessionSource";
import { normalizeImportedToolArguments } from "./importToolArguments";
import { importedContentHasToolCall, importedUnknownBlockAsText, normalizeImportedStopReason, tryImportedImageBlock } from "./importNormalize";

export type ConvertedCursorSession = {
	/** 转换结果元数据；`raw` 仅在内存模式（scan 摘要）下由调用方拼装 */
	raw?: string;
	title: string;
	preview: string;
	messageCount: number;
};

export type ConvertCursorInput = {
	projectPath: string;
	session: ParsedCursorSession;
	translate: SessionImportCopy;
};

/**
 * 内存版转换：把结果拼成完整文本返回。
 *
 * 仅供**扫描**使用（entries 是头部小数组，体积有上界）；
 * 导入路径请走 convertCursorSessionTo（流式写盘）。
 */
export async function convertCursorSession(input: ConvertCursorInput): Promise<ConvertedCursorSession> {
	const lines: string[] = [];
	const result = await convertCursorSessionTo({
		...input,
		entries: input.session.entries,
		sink: (line) => {
			lines.push(line);
		},
	});
	return { ...result, raw: `${lines.join("\n")}\n` };
}

type PiContent = Record<string, unknown>;

export function zeroUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function extractPiText(content: PiContent[]): string {
	return content
		.map((item) => readString(item.text) || readString(item.thinking) || readString(item.name))
		.filter(Boolean)
		.join(" ");
}

export function cleanCursorTitle(value?: string): string {
	const text = value?.replace(/\s+/g, " ").trim();
	if (!text || /^untitled$/i.test(text)) return "";
	return text.length > 40 ? `${text.slice(0, 40)}...` : text;
}

function makeId(sessionId: string, sequence: number): string {
	return createHash("sha1").update(`${sessionId}:${sequence}`).digest("hex").slice(0, 8);
}

function toolCallId(sessionId: string, sequence: number, name: string, explicitId: string): string {
	if (explicitId) return explicitId;
	return `cursor_${makeId(`${sessionId}:tool:${name}`, sequence)}`;
}

function contentBlocksOf(entry: CursorRecord): unknown[] {
	const message = readRecord(entry.message);
	const content = message.content ?? entry.content;
	if (typeof content === "string") return [{ type: "text", text: content }];
	return asArray(content);
}

/**
 * 把 Cursor 内容块转成 pi content。
 * 已知类型：text / thinking / tool_use；其余块 JSON 原文落成 text，避免静默丢内容。
 *
 * Cursor agent-transcripts 几乎不写 tool_result。pi 原生会话要靠独立的
 * toolResult 行画工具卡，所以每个 tool_use 在没有配对结果时补一条空输出
 * 的 toolResult（参数仍在 assistant.toolCall 里）。源里若已有 tool_result，不重复。
 */
export function convertCursorContentBlocks(blocks: unknown[], sessionId: string, toolSeq: { n: number }): { content: PiContent[]; toolResults: Array<{ id: string; name: string; text: string; isError: boolean }> } {
	const content: PiContent[] = [];
	const toolResults: Array<{ id: string; name: string; text: string; isError: boolean }> = [];

	for (const block of blocks) {
		if (typeof block === "string") {
			if (block) content.push({ type: "text", text: block });
			continue;
		}
		const record = readRecord(block);
		const type = readString(record.type);

		if (type === "text") {
			const text = readString(record.text);
			if (text) content.push({ type: "text", text });
			continue;
		}

		if (type === "thinking" || type === "reasoning") {
			const thinking = readString(record.thinking) || readString(record.text);
			if (thinking) {
				content.push({
					type: "thinking",
					thinking,
					thinkingSignature: "cursor_thinking",
				});
			}
			continue;
		}

		if (type === "tool_use") {
			const name = readString(record.name) || "tool";
			const id = toolCallId(sessionId, toolSeq.n++, name, readString(record.id));
			const input = record.input ?? record.arguments;
			content.push({
				type: "toolCall",
				id,
				name,
				arguments: normalizeImportedToolArguments(input),
			});
			continue;
		}

		if (type === "tool_result") {
			const output = record.content ?? record.output ?? record.text;
			let text = "";
			if (typeof output === "string") text = output;
			else if (Array.isArray(output)) text = joinCursorTextBlocks(output);
			else if (output && typeof output === "object") {
				try {
					text = JSON.stringify(output, null, 2);
				} catch {
					text = String(output);
				}
			}
			toolResults.push({
				id: readString(record.tool_use_id) || readString(record.toolCallId) || readString(record.id),
				name: readString(record.name) || "tool",
				text,
				isError: Boolean(record.is_error ?? record.isError),
			});
			continue;
		}

		const image = tryImportedImageBlock(record);
		if (image) {
			content.push(image);
			continue;
		}

		// 未知块原样序列化：宁可多一段 JSON，也不要在转写时丢掉。
		content.push(importedUnknownBlockAsText(record));
	}

	const resultIds = new Set(toolResults.map((result) => result.id).filter(Boolean));
	for (const item of content) {
		if (item.type !== "toolCall") continue;
		const id = readString(item.id);
		if (!id || resultIds.has(id)) continue;
		toolResults.push({
			id,
			name: readString(item.name) || "tool",
			text: "",
			isError: false,
		});
		resultIds.add(id);
	}

	return { content, toolResults };
}

/**
 * 把 Cursor Agent JSONL 转成 pi 原生会话文件。
 *
 * 转写原则：每个 user/assistant 行变成一条 pi message，content 块按序保留；
 * 每个 tool_use 写成 assistant.toolCall，并紧跟一条 toolResult（Cursor 源常缺输出，
 * 结果正文可为空）。连续多条 assistant 行不合并。turn_ended 是控制标记，丢掉。
 */
export async function convertCursorSessionTo(input: { projectPath: string; session: ParsedCursorSession; translate: SessionImportCopy; entries: Iterable<CursorRecord> | AsyncIterable<CursorRecord>; sink: (line: string) => Promise<void> | void }): Promise<ConvertedCursorSession> {
	const { projectPath, session, translate, entries, sink } = input;
	const sessionId = session.meta.sessionId;
	const timestamp = new Date(session.meta.firstTimestamp).toISOString();
	const titleState = { title: "", preview: "" };
	let parentId: string | null = null;
	let sequence = 0;
	let messageCount = 0;
	const toolSeq = { n: 0 };
	let lastTimestamp = session.meta.firstTimestamp;

	const pushEntry = async (entry: Record<string, unknown>) => {
		await sink(JSON.stringify(entry));
	};

	const pushMessage = async (role: "user" | "assistant" | "toolResult", content: PiContent[], extra: Record<string, unknown> = {}, timestampValue?: number) => {
		if (content.length === 0) return;
		const id = makeId(sessionId, sequence++);
		const ts = new Date(timestampValue ?? lastTimestamp).toISOString();
		await pushEntry({
			type: "message",
			id,
			parentId,
			timestamp: ts,
			message: {
				role,
				content,
				timestamp: new Date(ts).getTime(),
				...(role === "assistant" ? { usage: zeroUsage(), ...extra } : extra),
			},
		});
		parentId = id;
		messageCount += 1;

		const text = extractPiText(content).trim();
		if (text && !titleState.preview) titleState.preview = text.slice(0, 160);
		if (role === "user" && text && !titleState.title) {
			titleState.title = cleanCursorTitle(text);
		}
	};

	await pushEntry({ type: "session", version: 3, id: sessionId, timestamp, cwd: projectPath });
	await pushEntry({
		type: "cursor_import",
		version: 1,
		cursorSessionId: sessionId,
		sourcePath: session.sourcePath,
		sourceMtime: session.sourceMtime,
		sourceSize: session.sourceSize,
		importedAt: new Date().toISOString(),
	});

	const modelChangeId = makeId(sessionId, sequence++);
	await pushEntry({
		type: "model_change",
		id: modelChangeId,
		parentId,
		timestamp,
		provider: "cursor",
		modelId: "cursor-import",
	});
	parentId = modelChangeId;

	for await (const entry of entries) {
		const type = readString(entry.type);
		if (type === "turn_ended") continue;

		const role = readString(entry.role);
		const blocks = contentBlocksOf(entry);

		if (role === "user") {
			const raw = joinCursorTextBlocks(blocks);
			const text = extractCursorUserText(raw);
			const at = parseCursorTimestampFromText(raw) || lastTimestamp;
			if (at > 0) lastTimestamp = at;
			const converted = convertCursorContentBlocks(blocks, sessionId, toolSeq);
			const content: PiContent[] = [];
			let wrapperReplaced = false;
			for (const item of converted.content) {
				if (item.type === "text") {
					const original = readString(item.text);
					const isUserWrapper = original === raw || (Boolean(text) && original.includes("<user_query>") && original.includes(text));
					if (isUserWrapper) {
						if (!wrapperReplaced) {
							wrapperReplaced = true;
							if (text) content.push({ type: "text", text });
						}
						continue;
					}
				}
				content.push(item);
			}
			if (!wrapperReplaced && text) content.push({ type: "text", text });
			await pushMessage("user", content, {}, at);
			for (const result of converted.toolResults) {
				await pushMessage(
					"toolResult",
					[{ type: "text", text: result.text }],
					{
						toolCallId: result.id,
						toolName: result.name,
						isError: result.isError,
					},
					at,
				);
			}
			continue;
		}

		if (role === "assistant") {
			const converted = convertCursorContentBlocks(blocks, sessionId, toolSeq);
			await pushMessage(
				"assistant",
				converted.content,
				{
					api: "cursor-import",
					provider: "cursor",
					model: "cursor-import",
					stopReason: normalizeImportedStopReason({
						hasToolCall: importedContentHasToolCall(converted.content),
					}),
				},
				lastTimestamp,
			);
			for (const result of converted.toolResults) {
				await pushMessage(
					"toolResult",
					[{ type: "text", text: result.text }],
					{
						toolCallId: result.id,
						toolName: result.name,
						isError: result.isError,
					},
					lastTimestamp,
				);
			}
			continue;
		}

		if (type === "tool_result") {
			const converted = convertCursorContentBlocks(blocks.length > 0 ? blocks : [entry], sessionId, toolSeq);
			for (const result of converted.toolResults) {
				await pushMessage(
					"toolResult",
					[{ type: "text", text: result.text }],
					{
						toolCallId: result.id,
						toolName: result.name,
						isError: result.isError,
					},
					lastTimestamp,
				);
			}
		}
	}

	const title = cleanCursorTitle(titleState.title) || translate("session.importedTitle", { source: "Cursor" });
	// 使用 pi 原生 session_info 格式追加在末尾，避免旧版 sessionName 行（无 type 字段）
	// 在文件头破坏 pi 的首行校验导致会话无法加载（见 #114）。
	await pushEntry({
		type: "session_info",
		id: randomUUID().slice(0, 8),
		parentId,
		timestamp: new Date().toISOString(),
		name: title,
		cwd: projectPath,
	});

	return {
		title,
		preview: titleState.preview || translate("session.importedPreview", { source: "Cursor" }),
		messageCount,
	};
}
