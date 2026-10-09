import { createHash, randomUUID } from "node:crypto";
import type { SessionImportCopy } from "./SessionImportCopy";
import { importedContentHasToolCall, importedUnknownBlockAsText, normalizeImportedStopReason, safeIsoTimestamp } from "./importNormalize";
import { normalizeImportedToolArguments } from "./importToolArguments";
import { asArray, readNumber, readRecord, readString, type KimiRecord, type ParsedKimiSession } from "./kimiSessionSource";

export type ConvertedKimiSession = {
	/** 转换结果元数据；`raw` 仅在内存模式（scan 摘要）下由调用方拼装 */
	raw?: string;
	title: string;
	preview: string;
	messageCount: number;
};

export type ConvertKimiInput = {
	projectPath: string;
	session: ParsedKimiSession;
	translate: SessionImportCopy;
};

type PiContent = Record<string, unknown>;

/**
 * 两种 wire 记录归一后的消息视图。
 * - `context.append_message`：消息进入上下文时的快照（无 usage/meta）；
 * - `agent.message.appended`：agent 产出消息时的事件（带 usage/finish，**优先采用**）。
 * 同一条消息常以两种记录各出现一次，去重策略见 collectKimiAppendedKeys。
 */
export type NormalizedKimiMessage = {
	kind: "context" | "appended";
	id: string;
	role: string;
	time: number;
	content: unknown[];
	toolCalls: unknown[];
	toolCallId: string;
	usage: { inputOther: number; output: number; inputCacheRead: number; inputCacheCreation: number } | undefined;
	finishReason: string;
};

/** 从一条 wire 记录中提取消息；非消息记录返回 null。 */
export function extractKimiMessage(record: KimiRecord): NormalizedKimiMessage | null {
	const type = readString(record.type);
	const time = readNumber(record.time);

	if (type === "context.append_message") {
		const message = readRecord(record.message);
		const role = readString(message.role);
		if (!role) return null;
		return {
			kind: "context",
			id: readString(message.id),
			role,
			time,
			content: asArray(message.content),
			toolCalls: asArray(message.toolCalls),
			toolCallId: readString(message.toolCallId),
			usage: undefined,
			finishReason: "",
		};
	}

	if (type === "agent.message.appended") {
		const envelope = readRecord(record.message);
		const message = readRecord(envelope.message);
		const role = readString(message.role);
		if (!role) return null;
		const meta = readRecord(envelope.meta);
		const usageRaw = readRecord(meta.usage);
		const hasUsage = Object.keys(usageRaw).length > 0;
		return {
			kind: "appended",
			id: readString(message.id),
			role,
			time,
			content: asArray(message.content),
			toolCalls: asArray(message.toolCalls),
			toolCallId: readString(message.toolCallId),
			usage: hasUsage
				? {
						inputOther: readNumber(usageRaw.inputOther),
						output: readNumber(usageRaw.output),
						inputCacheRead: readNumber(usageRaw.inputCacheRead),
						inputCacheCreation: readNumber(usageRaw.inputCacheCreation),
					}
				: undefined,
			finishReason: readString(readRecord(meta.finish).finishReason),
		};
	}

	return null;
}

/**
 * 消息去重键：有 id 用 id；缺 id 时用 role + toolCallId + 内容哈希
 *（同一条消息在两种记录里的 content/toolCalls 一致，哈希稳定）。
 */
export function kimiMessageKey(message: NormalizedKimiMessage): string {
	if (message.id) return `id:${message.id}`;
	const hash = createHash("sha1")
		.update(JSON.stringify({ content: message.content, toolCalls: message.toolCalls }))
		.digest("hex")
		.slice(0, 12);
	return `sig:${message.role}:${message.toolCallId}:${hash}`;
}

/**
 * 第一遍扫描：收集所有 `agent.message.appended` 记录的去重键。
 *
 * 去重策略（可单测的纯函数）：同一条消息若两种记录都存在，**只保留 appended 版本**
 *（带 usage/finish 元数据）。做法是转换前先收集 appended 键集合，转换主循环里
 * 遇到键命中集合的 context 记录直接跳过；appended 自身重复出现则靠 seen 集合挡掉。
 *
 * 流式导入时由调用方先以本函数消费一遍流，再重新开流做转换（读两遍但内存 O(单行)）。
 */
export async function collectKimiAppendedKeys(entries: Iterable<KimiRecord> | AsyncIterable<KimiRecord>): Promise<Set<string>> {
	const keys = new Set<string>();
	for await (const entry of entries) {
		const message = extractKimiMessage(entry);
		if (message?.kind === "appended") keys.add(kimiMessageKey(message));
	}
	return keys;
}

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

/** Kimi usage 四字段 → pi usage 形状；缺省时全零（与 zeroUsage 同口径）。 */
export function kimiUsageToPi(usage: NormalizedKimiMessage["usage"]) {
	if (!usage) return zeroUsage();
	return {
		input: usage.inputOther,
		output: usage.output,
		cacheRead: usage.inputCacheRead,
		cacheWrite: usage.inputCacheCreation,
		totalTokens: usage.inputOther + usage.output + usage.inputCacheRead + usage.inputCacheCreation,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function extractPiText(content: PiContent[]): string {
	return content
		.map((item) => readString(item.text) || readString(item.thinking) || readString(item.name))
		.filter(Boolean)
		.join(" ");
}

export function cleanKimiTitle(value?: string): string {
	const text = value?.replace(/\s+/g, " ").trim();
	if (!text || /^untitled$/i.test(text)) return "";
	return text.length > 40 ? `${text.slice(0, 40)}...` : text;
}

function makeId(sessionId: string, sequence: number): string {
	return createHash("sha1").update(`${sessionId}:${sequence}`).digest("hex").slice(0, 8);
}

/** content 数组里的文本块拼接（user/tool 消息的 text 块）；Kimi Work 导入器共用。 */
export function joinKimiTextBlocks(content: unknown[]): string {
	return asArray(content)
		.map((item) => {
			if (typeof item === "string") return item;
			const record = readRecord(item);
			return readString(record.text);
		})
		.filter(Boolean)
		.join("\n");
}

/**
 * assistant 消息的 content + toolCalls → pi content 块。
 * think → thinking；text → text；toolCalls 追加为 toolCall 块
 * （arguments 是 JSON 字符串，经 normalizeImportedToolArguments 解析成对象，失败保留原文）。
 * 返回内容块与该轮的工具名表（toolCallId → name，供 tool 结果消息配对）。
 */
export function convertKimiAssistantContent(message: NormalizedKimiMessage): { content: PiContent[]; toolNames: Array<{ id: string; name: string }> } {
	const content: PiContent[] = [];
	const toolNames: Array<{ id: string; name: string }> = [];

	for (const block of message.content) {
		if (typeof block === "string") {
			if (block) content.push({ type: "text", text: block });
			continue;
		}
		const record = readRecord(block);
		const type = readString(record.type);

		if (type === "think" || type === "thinking" || type === "reasoning") {
			const thinking = readString(record.think) || readString(record.thinking) || readString(record.text);
			if (thinking) {
				content.push({
					type: "thinking",
					thinking,
					thinkingSignature: "kimi_thinking",
				});
			}
			continue;
		}

		if (type === "text") {
			const text = readString(record.text);
			if (text) content.push({ type: "text", text });
			continue;
		}

		// 未知块原样序列化：宁可多一段 JSON，也不要在转写时丢掉。
		content.push(importedUnknownBlockAsText(record));
	}

	for (const call of message.toolCalls) {
		const record = readRecord(call);
		// 兼容两种形态：{id, name, arguments} 与 OpenAI 风格 {id, function:{name, arguments}}
		const fn = readRecord(record.function);
		const name = readString(record.name) || readString(fn.name) || "tool";
		const id = readString(record.id) || `kimi_${makeId(name, toolNames.length)}`;
		toolNames.push({ id, name });
		content.push({
			type: "toolCall",
			id,
			name,
			arguments: normalizeImportedToolArguments(record.arguments ?? fn.arguments),
		});
	}

	return { content, toolNames };
}

/**
 * 内存版转换：把结果拼成完整文本返回。
 *
 * 仅供**扫描**使用（entries 是头部小数组，体积有上界）；
 * 导入路径请走 convertKimiSessionTo（流式写盘）。
 */
export async function convertKimiSession(input: ConvertKimiInput): Promise<ConvertedKimiSession> {
	const lines: string[] = [];
	const appendedKeys = await collectKimiAppendedKeys(input.session.entries);
	const result = await convertKimiSessionTo({
		...input,
		entries: input.session.entries,
		appendedKeys,
		sink: (line) => {
			lines.push(line);
		},
	});
	return { ...result, raw: `${lines.join("\n")}\n` };
}

/**
 * 把 Kimi Code wire.jsonl 记录流转成 pi 原生 JSONL 会话文件。
 *
 * 转写原则：user/assistant/tool 三种角色各成一条 pi message；assistant 的
 * think/text/toolCalls 合并在同一 content 数组；tool 结果单独一条 toolResult，
 * toolName 从前面已发出的 toolCall 配对查得（查不到回退 "tool"）。
 */
export async function convertKimiSessionTo(input: {
	projectPath: string;
	session: ParsedKimiSession;
	translate: SessionImportCopy;
	entries: Iterable<KimiRecord> | AsyncIterable<KimiRecord>;
	/** collectKimiAppendedKeys 的预扫描结果；缺省时 context 记录不做降级跳过 */
	appendedKeys?: Set<string>;
	sink: (line: string) => Promise<void> | void;
}): Promise<ConvertedKimiSession> {
	const { projectPath, session, translate, entries, sink } = input;
	const appendedKeys = input.appendedKeys ?? new Set<string>();
	const sessionId = session.meta.sessionId;
	const timestamp = safeIsoTimestamp(session.meta.firstTimestamp);
	// 标题回退链：state.title → state.lastPrompt → 首条 user 消息（见 titleState 更新处）
	const titleState = { title: session.meta.title || session.meta.lastPrompt, preview: "" };
	let parentId: string | null = null;
	let sequence = 0;
	let messageCount = 0;
	let lastTimestamp = session.meta.firstTimestamp;
	/** toolCallId → 工具名：tool 结果消息只有 toolCallId，名字要从前面的 toolCall 配对查。 */
	const toolNameById = new Map<string, string>();
	const seen = new Set<string>();

	const pushEntry = async (entry: Record<string, unknown>) => {
		await sink(JSON.stringify(entry));
	};

	const pushMessage = async (role: "user" | "assistant" | "toolResult", content: PiContent[], extra: Record<string, unknown> = {}, timestampValue?: number) => {
		if (content.length === 0) return;
		const id = makeId(sessionId, sequence++);
		const ts = safeIsoTimestamp(timestampValue ?? lastTimestamp);
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
			titleState.title = cleanKimiTitle(text);
		}
	};

	await pushEntry({ type: "session", version: 3, id: sessionId, timestamp, cwd: projectPath });
	await pushEntry({
		type: "kimi_import",
		version: 1,
		sourceSessionId: sessionId,
		sourcePath: session.sourcePath,
		sourceMtime: session.sourceMtime,
		sourceSize: session.sourceSize,
		importedAt: new Date().toISOString(),
	});

	// wire 记录里没有可靠的模型字段（meta 只有 usage/finish/source），用占位值保持行结构同构。
	const modelChangeId = makeId(sessionId, sequence++);
	await pushEntry({
		type: "model_change",
		id: modelChangeId,
		parentId,
		timestamp,
		provider: "kimi",
		modelId: "kimi-import",
	});
	parentId = modelChangeId;

	for await (const entry of entries) {
		const message = extractKimiMessage(entry);
		if (!message) continue;

		const key = kimiMessageKey(message);
		// 两种记录都存在的消息只留 appended 版本（带 usage/meta）
		if (message.kind === "context" && appendedKeys.has(key)) continue;
		if (seen.has(key)) continue;
		seen.add(key);

		const at = message.time > 0 ? message.time : lastTimestamp;
		if (at > 0) lastTimestamp = at;

		if (message.role === "user") {
			const text = joinKimiTextBlocks(message.content);
			if (text) await pushMessage("user", [{ type: "text", text }], {}, at);
			continue;
		}

		if (message.role === "assistant") {
			const converted = convertKimiAssistantContent(message);
			for (const tool of converted.toolNames) toolNameById.set(tool.id, tool.name);
			await pushMessage(
				"assistant",
				converted.content,
				{
					usage: kimiUsageToPi(message.usage),
					api: "kimi-import",
					provider: "kimi",
					model: "kimi-import",
					stopReason: normalizeImportedStopReason({
						raw: message.finishReason,
						hasToolCall: importedContentHasToolCall(converted.content),
					}),
				},
				at,
			);
			continue;
		}

		if (message.role === "tool") {
			const text = joinKimiTextBlocks(message.content);
			await pushMessage(
				"toolResult",
				[{ type: "text", text }],
				{
					toolCallId: message.toolCallId,
					toolName: toolNameById.get(message.toolCallId) || "tool",
					isError: false,
				},
				at,
			);
		}
	}

	const title = cleanKimiTitle(titleState.title) || translate("session.importedTitle", { source: "Kimi" });
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
		preview: titleState.preview || translate("session.importedPreview", { source: "Kimi" }),
		messageCount,
	};
}
