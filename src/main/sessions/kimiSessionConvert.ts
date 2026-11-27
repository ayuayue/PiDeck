import { createHash, randomUUID } from "node:crypto";
import type { SessionImportCopy } from "./SessionImportCopy";
import { safeIsoTimestamp } from "./importNormalize";
import { kimiAssistantSegments, kimiSnapshotEvents, makeId, type KimiAssistantEvent, type KimiLoopResult, type PiContent } from "./kimiAssistantSegments";
import { KimiCodeLoop, type KimiLoopStep } from "./kimiCodeLoop";
import { asArray, readNumber, readRecord, readString, type KimiRecord, type ParsedKimiSession } from "./kimiSessionSource";
import { cleanImportTitle as cleanKimiTitle, zeroUsage } from "./importShared";

export const KIMI_IMPORT_VERSION = 3;
const KIMI_CODE_MODEL = "kimi code";
export { convertKimiAssistantContent } from "./kimiAssistantSegments";

// 标题清洗与 usage 占位实现统一在 importShared；仍从本模块转出旧名字。
export { cleanKimiTitle, zeroUsage };

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

/**
 * 两种 wire 记录归一后的消息视图。
 * - `context.append_message`：消息进入上下文时的快照（无 usage/meta）；
 * - `agent.message.appended`：agent 产出消息时的事件（带 usage/finish，**优先采用**）。
 * 同一条消息常以两种记录各出现一次，去重策略见 indexKimiMessages。
 */
export type NormalizedKimiMessage = {
	kind: "context" | "appended";
	id: string;
	/** agent.message.appended 可能把 step 的消息 ID 放在 meta，独立于旧快照去重键。 */
	wireId?: string;
	origin?: string;
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
			origin: readString(readRecord(message.origin).kind),
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
		return {
			kind: "appended",
			id: readString(message.id) || (role === "user" ? readString(meta.userMessageId) : ""),
			wireId: readString(meta.messageId),
			origin: readString(readRecord(message.origin).kind) || readString(readRecord(meta.origin).kind),
			role,
			time,
			content: asArray(message.content),
			toolCalls: asArray(message.toolCalls),
			toolCallId: readString(message.toolCallId),
			usage: readKimiUsage(meta.usage),
			finishReason: readString(readRecord(meta.finish).finishReason),
		};
	}

	return null;
}

function readKimiUsage(value: unknown): NormalizedKimiMessage["usage"] {
	const usage = readRecord(value);
	if (Object.keys(usage).length === 0) return;
	return {
		inputOther: readNumber(usage.inputOther),
		output: readNumber(usage.output),
		inputCacheRead: readNumber(usage.inputCacheRead),
		inputCacheCreation: readNumber(usage.inputCacheCreation),
	};
}

const INTERNAL_USER_ORIGINS = new Set(["injection", "task", "skill_activation"]);

function isInternalUserMessage(message: NormalizedKimiMessage): boolean {
	return message.role === "user" && INTERNAL_USER_ORIGINS.has(message.origin ?? "");
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

type KimiMessageIndex = {
	appendedKeys: Set<string>;
	assistantIds: Set<string>;
	assistantCallIds: Set<string>;
	toolResultIds: Set<string>;
	loopResultIds: Set<string>;
};

/** 第一遍只索引消息键和 ID。第二遍优先写直接消息，循环事件用来补缺。 */
export async function indexKimiMessages(entries: Iterable<KimiRecord> | AsyncIterable<KimiRecord>): Promise<KimiMessageIndex> {
	const index: KimiMessageIndex = { appendedKeys: new Set(), assistantIds: new Set(), assistantCallIds: new Set(), toolResultIds: new Set(), loopResultIds: new Set() };
	for await (const entry of entries) {
		if (entry.type === "context.append_loop_event") {
			const event = readRecord(entry.event);
			const id = readString(event.toolCallId);
			if (event.type === "tool.result" && id && event.result && typeof event.result === "object") index.loopResultIds.add(id);
			continue;
		}
		const message = extractKimiMessage(entry);
		if (!message || isInternalUserMessage(message)) continue;
		if (message.kind === "appended") index.appendedKeys.add(kimiMessageKey(message));
		if (message.role === "assistant") {
			if (message.id) index.assistantIds.add(message.id);
			if (message.wireId) index.assistantIds.add(message.wireId);
			for (const call of message.toolCalls) {
				const id = readString(readRecord(call).id);
				if (id) index.assistantCallIds.add(id);
			}
		}
		if (message.role === "tool" && message.toolCallId) index.toolResultIds.add(message.toolCallId);
	}
	return index;
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
 * 内存版转换：把结果拼成完整文本返回。
 *
 * 仅供**扫描**使用（entries 是头部小数组，体积有上界）；
 * 导入路径请走 convertKimiSessionTo（流式写盘）。
 */
export async function convertKimiSession(input: ConvertKimiInput): Promise<ConvertedKimiSession> {
	const lines: string[] = [];
	const messageIndex = await indexKimiMessages(input.session.entries);
	const result = await convertKimiSessionTo({
		...input,
		entries: input.session.entries,
		messageIndex,
		sink: (line) => {
			lines.push(line);
		},
	});
	return { ...result, raw: `${lines.join("\n")}\n` };
}

/**
 * 把 Kimi Code wire.jsonl 记录流转成 pi 原生 JSONL 会话文件。
 *
 * 文本独立成段，首个结果之前的连续调用共用一条 toolUse，供 pi 继续聊天时按 ID 配对。
 */
export async function convertKimiSessionTo(input: { projectPath: string; session: ParsedKimiSession; translate: SessionImportCopy; entries: Iterable<KimiRecord> | AsyncIterable<KimiRecord>; messageIndex: KimiMessageIndex; sink: (line: string) => Promise<void> | void }): Promise<ConvertedKimiSession> {
	const { projectPath, session, translate, entries, messageIndex, sink } = input;
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
		version: KIMI_IMPORT_VERSION,
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
		modelId: KIMI_CODE_MODEL,
	});
	parentId = modelChangeId;

	const loop = new KimiCodeLoop();
	const deferredResults = new Map<string, { result: KimiLoopResult; order: number }>();
	let resultOrder = 0;
	const emittedLoopResults = new Set<string>();
	type AssistantEntry = { content: PiContent[]; time: number; stopReason: string; usage: ReturnType<typeof kimiUsageToPi> };
	const writeAssistant = ({ content, time, stopReason, usage }: AssistantEntry) => pushMessage("assistant", content, { api: "kimi-import", provider: "kimi", model: KIMI_CODE_MODEL, stopReason, usage }, time);
	let calls: AssistantEntry | undefined;
	const waiting = new Set<string>();
	const afterCalls: AssistantEntry[] = [];

	// 跨快照/step 合并尚未收到结果的连续调用。pi 在每个新 assistant 上重置待配对 ID。
	function bufferCall(id: string, entry: AssistantEntry) {
		if (messageIndex.loopResultIds.has(id) || messageIndex.toolResultIds.has(id)) waiting.add(id);
		if (!calls) {
			calls = entry;
			return;
		}
		calls.content.push(...entry.content);
		for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) calls.usage[field] += entry.usage[field];
	}
	async function flushCalls() {
		if (calls) await writeAssistant(calls);
		calls = undefined;
	}
	async function finishCalls() {
		await flushCalls();
		waiting.clear();
		for (const text of afterCalls) await writeAssistant(text);
		afterCalls.length = 0;
	}
	async function writeResult(result: KimiLoopResult) {
		const { toolCallId, output, isError, time } = result;
		await flushCalls();
		const text = typeof output === "string" ? output : joinKimiTextBlocks(asArray(output)) || (output == null ? "" : JSON.stringify(output));
		await pushMessage("toolResult", [{ type: "text", text }], { toolCallId, toolName: toolNameById.get(toolCallId) || "tool", isError }, time || lastTimestamp);
		waiting.delete(toolCallId);
		if (!waiting.size) await finishCalls();
	}

	async function emitResult(result: KimiLoopResult, snapshot = false) {
		const { toolCallId } = result;
		if (!snapshot) {
			if (messageIndex.toolResultIds.has(toolCallId) || emittedLoopResults.has(toolCallId)) return;
			emittedLoopResults.add(toolCallId);
		}
		if (!toolNameById.has(toolCallId)) {
			// 混合格式可能先给结果，再给带调用的完整快照。
			if (messageIndex.assistantCallIds.has(toolCallId)) {
				deferredResults.set(toolCallId, { result, order: resultOrder++ });
				return;
			}
			if (!snapshot) return;
		}
		await writeResult(result);
	}

	async function emitSegments(events: Iterable<KimiAssistantEvent>, usage: NormalizedKimiMessage["usage"], finishReason: string, fallbackTime: number) {
		for (const segment of kimiAssistantSegments(events, finishReason)) {
			if (segment.type === "snapshot") {
				await emitSnapshot(segment.message);
				continue;
			}
			if (segment.type === "result") {
				await emitResult(segment.result);
				continue;
			}
			const at = segment.time || fallbackTime || lastTimestamp;
			lastTimestamp = at;
			const entry = { content: segment.content, time: at, stopReason: segment.stopReason, usage: kimiUsageToPi(usage) };
			usage = undefined;
			if (segment.type === "call") {
				toolNameById.set(segment.call.id, segment.call.name);
				bufferCall(segment.call.id, entry);
			} else if (waiting.size) {
				// 调用后、结果前的文本仍独立可见，写在成对结果之后，保留原始时间戳。
				afterCalls.push(entry);
			} else {
				await flushCalls();
				await writeAssistant(entry);
			}
		}
	}

	async function emitSnapshot(message: NormalizedKimiMessage) {
		const at = message.time || lastTimestamp;
		if (message.role === "assistant") {
			await emitSegments(kimiSnapshotEvents(message), message.usage, message.finishReason, at);
			// 一组调用都已登记，再按结果抵达顺序（可以与调用顺序相反）释放。
			const ready = message.toolCalls
				.flatMap((call) => {
					const id = readString(readRecord(call).id);
					const value = deferredResults.get(id);
					if (!value) return [];
					deferredResults.delete(id);
					return [value];
				})
				.sort((a, b) => a.order - b.order);
			for (const { result } of ready) await writeResult(result);
			return;
		}
		lastTimestamp = at;
		const text = joinKimiTextBlocks(message.content);
		if (message.role === "user") {
			await finishCalls();
			if (text) await pushMessage("user", [{ type: "text", text }], {}, at);
		} else if (message.role === "tool") {
			await emitResult({ toolCallId: message.toolCallId, output: text, isError: false, time: at }, true);
		}
	}

	async function emitLoopStep(step?: KimiLoopStep) {
		if (!step) return;
		const { end, events } = step;
		const hasSnapshot = messageIndex.assistantIds.has(readString(end?.messageId)) || [...step.callPositions.keys()].some((id) => messageIndex.assistantCallIds.has(id));
		const remaining = hasSnapshot ? events.filter((event) => event.type === "snapshot" || event.type === "result") : events;
		await emitSegments(remaining, readKimiUsage(end?.usage), readString(end?.finishReason), step.time);
	}

	for await (const entry of entries) {
		const message = extractKimiMessage(entry);
		if (!message) {
			await emitLoopStep(loop.feed(entry));
			continue;
		}
		if (isInternalUserMessage(message)) continue;

		const key = kimiMessageKey(message);
		if (message.kind === "context" && messageIndex.appendedKeys.has(key)) continue;
		if (seen.has(key)) continue;
		seen.add(key);

		if (message.role === "user") await emitLoopStep(loop.flush());
		else if (loop.bufferSnapshot(message)) continue;
		await emitSnapshot(message);
	}
	await emitLoopStep(loop.flush());
	await finishCalls();

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
