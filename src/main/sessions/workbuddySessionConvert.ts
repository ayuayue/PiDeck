import { createHash, randomUUID } from "node:crypto";
import type { SessionImportCopy } from "./SessionImportCopy";
import { importedContentHasToolCall, normalizeImportedStopReason, safeIsoTimestamp } from "./importNormalize";
import { asArray, parseWorkBuddyArguments, readNumber, readRecord, readString, readWorkBuddyModel, stripInjectedContext, type ParsedWorkBuddySession, type WorkBuddyRecord } from "./workbuddySessionSource";

export type ConvertedWorkBuddySession = {
	/** 转换结果元数据；`raw` 仅在内存模式（scan 摘要）下由调用方拼装 */
	raw?: string;
	title: string;
	preview: string;
	messageCount: number;
};

export type ConvertWorkBuddyInput = {
	projectPath: string;
	session: ParsedWorkBuddySession;
	translate: SessionImportCopy;
};

/**
 * 内存版转换：把结果拼成完整文本返回。
 *
 * 仅供**扫描**使用（entries 是头部小数组，体积有上界）；
 * 导入路径请走 convertWorkBuddySessionTo（流式写盘）。
 */
export async function convertWorkBuddySession(input: ConvertWorkBuddyInput): Promise<ConvertedWorkBuddySession> {
	const lines: string[] = [];
	const result = await convertWorkBuddySessionTo({
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

function pickText(content: unknown, type: string): string {
	return asArray(content)
		.map((item) => {
			const record = readRecord(item);
			return readString(record.type) === type ? readString(record.text) : "";
		})
		.filter(Boolean)
		.join("\n\n");
}

function joinedReasoning(entry: WorkBuddyRecord): string {
	const fromRaw = asArray(entry.rawContent)
		.map((item) => readString(readRecord(item).text))
		.filter(Boolean)
		.join("\n");
	if (fromRaw) return fromRaw;
	return asArray(entry.content)
		.map((item) => readString(readRecord(item).text))
		.filter(Boolean)
		.join("\n");
}

function extractToolOutput(entry: WorkBuddyRecord): string {
	const output = entry.output;
	if (typeof output === "string") return output;
	const record = readRecord(output);
	const text = readString(record.text) || readString(record.content);
	if (text) return text;
	if (Object.keys(record).length === 0) return "";
	try {
		return JSON.stringify(record, null, 2);
	} catch {
		return "";
	}
}

function extractPiText(content: PiContent[]): string {
	return content
		.map((item) => readString(item.text) || readString(item.thinking) || readString(item.name))
		.filter(Boolean)
		.join(" ");
}

export function cleanWorkBuddyTitle(value?: string): string {
	const text = value?.replace(/\s+/g, " ").trim();
	if (!text || /^untitled$/i.test(text)) return "";
	return text.length > 40 ? `${text.slice(0, 40)}...` : text;
}

function makeId(sessionId: string, sequence: number): string {
	return createHash("sha1").update(`${sessionId}:${sequence}`).digest("hex").slice(0, 8);
}

/**
 * 把 WorkBuddy 会话记录流转换为 pi 原生 JSONL 会话文件。
 *
 * 关键差异：WorkBuddy 把 reasoning / function_call 写成独立的顶层记录，
 * 而 pi 要求它们挂在同一个 assistant 消息的 content 数组里，因此这里用
 * pending 缓冲区聚合同一轮的推理与工具调用，遇到文本消息或工具结果时再 flush。
 */
export async function convertWorkBuddySessionTo(input: { projectPath: string; session: ParsedWorkBuddySession; translate: SessionImportCopy; entries: Iterable<WorkBuddyRecord> | AsyncIterable<WorkBuddyRecord>; sink: (line: string) => Promise<void> | void }): Promise<ConvertedWorkBuddySession> {
	const { projectPath, session, translate, entries, sink } = input;
	const sessionId = session.meta.sessionId;
	const timestamp = safeIsoTimestamp(session.meta.firstTimestamp);
	const titleState = { title: session.meta.aiTitle, preview: "" };
	let pending: PiContent[] = [];
	let parentId: string | null = null;
	let sequence = 0;
	let messageCount = 0;

	const modelId = session.meta.modelId || "unknown";

	const pushEntry = async (entry: Record<string, unknown>) => {
		await sink(JSON.stringify(entry));
	};

	const pushMessage = async (role: "user" | "assistant" | "toolResult", content: PiContent[], extra: Record<string, unknown> = {}, timestampValue?: number) => {
		if (content.length === 0) return;
		const id = makeId(sessionId, sequence++);
		const ts = safeIsoTimestamp(timestampValue ?? session.meta.firstTimestamp);
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
			titleState.title = cleanWorkBuddyTitle(text);
		}
	};

	const flushPending = async (fallbackTimestamp: number) => {
		if (pending.length === 0) return;
		const content = pending;
		pending = [];
		await pushMessage(
			"assistant",
			content,
			{
				api: "workbuddy-import",
				provider: "workbuddy",
				model: modelId,
				stopReason: normalizeImportedStopReason({
					hasToolCall: importedContentHasToolCall(content),
				}),
			},
			fallbackTimestamp,
		);
	};

	await pushEntry({ type: "session", version: 3, id: sessionId, timestamp, cwd: projectPath });
	await pushEntry({
		type: "workbuddy_import",
		version: 1,
		workbuddySessionId: sessionId,
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
		provider: "workbuddy",
		modelId,
	});
	parentId = modelChangeId;

	for await (const entry of entries) {
		const type = readString(entry.type);
		const at = readNumber(entry.timestamp) || session.meta.firstTimestamp;

		// 快照流与标题行不参与正文：标题单独用于 session_info.name。
		if (type === "file-history-snapshot" || type === "ai-title") continue;

		if (type === "message") {
			// 文本消息标志新一轮开始，先把上一轮的推理/工具调用落盘。
			await flushPending(at);
			if (readString(entry.role) === "assistant") {
				const content: PiContent[] = [];
				const text = pickText(entry.content, "output_text");
				if (text) content.push({ type: "text", text });
				await pushMessage(
					"assistant",
					content,
					{
						api: "workbuddy-import",
						provider: "workbuddy",
						model: readWorkBuddyModel(entry) || modelId,
						stopReason: "stop",
					},
					at,
				);
				continue;
			}
			if (readString(entry.role) === "user") {
				const raw = pickText(entry.content, "input_text");
				const text = stripInjectedContext(raw);
				if (text) await pushMessage("user", [{ type: "text", text }], {}, at);
				continue;
			}
			continue;
		}

		if (type === "reasoning") {
			const thinking = joinedReasoning(entry);
			if (thinking) {
				pending.push({
					type: "thinking",
					thinking,
					thinkingSignature: "workbuddy_thinking",
				});
			}
			continue;
		}

		if (type === "function_call") {
			pending.push({
				type: "toolCall",
				id: readString(entry.callId),
				name: readString(entry.name),
				arguments: parseWorkBuddyArguments(entry.arguments),
			});
			continue;
		}

		if (type === "function_call_result") {
			// 工具结果必须晚于承载 toolCall 的 assistant 消息，先 flush 再写结果。
			await flushPending(at);
			await pushMessage(
				"toolResult",
				[{ type: "text", text: extractToolOutput(entry) }],
				{
					toolCallId: readString(entry.callId),
					toolName: readString(entry.name) || "tool",
					isError: readString(entry.status) !== "completed",
				},
				at,
			);
		}
	}

	await flushPending(session.meta.lastTimestamp);

	const title = cleanWorkBuddyTitle(titleState.title) || translate("session.importedTitle", { source: "WorkBuddy" });
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
		preview: titleState.preview || translate("session.importedPreview", { source: "WorkBuddy" }),
		messageCount,
	};
}
