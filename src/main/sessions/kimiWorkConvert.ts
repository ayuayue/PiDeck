import { createHash, randomUUID } from "node:crypto";
import type { SessionImportCopy } from "./SessionImportCopy";
import { importedContentHasToolCall, importedUnknownBlockAsText, normalizeImportedStopReason } from "./importNormalize";
import { normalizeImportedToolArguments } from "./importToolArguments";
import { asArray, readNumber, readRecord, readString, type KimiRecord } from "./kimiSessionSource";
import { cleanKimiTitle, convertKimiAssistantContent, extractKimiMessage, joinKimiTextBlocks, kimiUsageToPi, type NormalizedKimiMessage } from "./kimiSessionConvert";

/**
 * Kimi Work（kimi-desktop 桌面版）wire.jsonl → pi 原生会话 JSONL 转换。
 *
 * 与 Kimi Code CLI 版（kimiSessionConvert）的差异：
 * - 助手输出没有快照式记录（agent.message.appended / append_message(role:assistant) 都不存在），
 *   只以 context.append_loop_event 事件流存在：step.begin 开步 → content.part 追加分片 →
 *   step.end 收尾（带 usage / finishReason）。必须由 KimiWorkLoopAggregator 聚合。
 * - user / tool 消息仍是 context.append_message（与 CLI 同形态），复用 extractKimiMessage。
 * - 消息源单一（无快照+事件双写），不需要 CLI 版的两遍去重——单遍流式。
 */

export type ConvertedKimiWorkSession = {
	title: string;
	preview: string;
	messageCount: number;
};

type PiContent = Record<string, unknown>;

/**
 * loop event 聚合器：把 step.begin / content.part / step.end 事件流装配成
 * 一条 assistant 消息（content parts + usage + finishReason）。
 *
 * 跨行状态（stepUuid → parts）是必须的：分片与收尾分散在多行。
 * 乱序/孤儿事件保守处理：没见过 stepUuid 的 content.part 开隐式步（不丢内容）；
 * step.end 匹配不到已开步则丢弃（end 本身无内容）。乱序在追加式日志里罕见。
 */
export class KimiWorkLoopAggregator {
	private readonly steps = new Map<string, { parts: unknown[]; beganAt: number }>();

	/**
	 * 喂入一条 wire 记录；当某个 step 收到 step.end 时返回聚合出的 assistant 消息。
	 * 非 loop event / 非完整步返回 null。
	 */
	feed(record: KimiRecord): NormalizedKimiMessage | null {
		if (readString(record.type) !== "context.append_loop_event") return null;
		const event = readRecord(record.event);
		const time = readNumber(record.time);
		const eventType = readString(event.type);

		if (eventType === "step.begin") {
			const stepUuid = readString(event.uuid);
			if (stepUuid) this.steps.set(stepUuid, { parts: [], beganAt: time });
			return null;
		}

		if (eventType === "content.part") {
			const stepUuid = readString(event.stepUuid);
			const part = event.part;
			if (part === undefined || part === null) return null;
			const step = this.steps.get(stepUuid) ?? this.ensureStep(stepUuid || `orphan:${this.steps.size}`);
			step.parts.push(part);
			return null;
		}

		if (eventType === "step.end") {
			const stepUuid = readString(event.uuid);
			const step = this.steps.get(stepUuid);
			this.steps.delete(stepUuid);
			if (!step) return null;
			const usageRaw = readRecord(event.usage);
			const hasUsage = Object.keys(usageRaw).length > 0;
			return {
				kind: "appended",
				id: readString(event.messageId) || stepUuid,
				role: "assistant",
				time: time || step.beganAt,
				content: step.parts,
				toolCalls: [],
				toolCallId: "",
				usage: hasUsage
					? {
							inputOther: readNumber(usageRaw.inputOther),
							output: readNumber(usageRaw.output),
							inputCacheRead: readNumber(usageRaw.inputCacheRead),
							inputCacheCreation: readNumber(usageRaw.inputCacheCreation),
						}
					: undefined,
				finishReason: readString(event.finishReason),
			};
		}

		return null;
	}

	/** 兜底输出（流结束时）：仍有未收尾的步（wire 被截断/缺 step.end）按已有 parts 产出，不丢内容。 */
	flush(): NormalizedKimiMessage | null {
		const first = this.steps.keys().next();
		if (first.done) return null;
		const stepUuid = first.value;
		const step = this.steps.get(stepUuid);
		this.steps.delete(stepUuid);
		if (!step || step.parts.length === 0) return null;
		return {
			kind: "appended",
			id: stepUuid,
			role: "assistant",
			time: step.beganAt,
			content: step.parts,
			toolCalls: [],
			toolCallId: "",
			usage: undefined,
			finishReason: "",
		};
	}

	private ensureStep(stepUuid: string): { parts: unknown[]; beganAt: number } {
		let step = this.steps.get(stepUuid);
		if (!step) {
			step = { parts: [], beganAt: 0 };
			this.steps.set(stepUuid, step);
		}
		return step;
	}
}

/** 仅供测试：确认聚合器行为可脱离 importer 单测。 */
export function aggregateKimiWorkLoopEvents(records: KimiRecord[]): NormalizedKimiMessage[] {
	const aggregator = new KimiWorkLoopAggregator();
	const messages: NormalizedKimiMessage[] = [];
	for (const record of records) {
		const message = aggregator.feed(record);
		if (message) messages.push(message);
	}
	let flushed = aggregator.flush();
	while (flushed) {
		messages.push(flushed);
		flushed = aggregator.flush();
	}
	return messages;
}

function makeId(sessionId: string, sequence: number): string {
	return createHash("sha1").update(`${sessionId}:${sequence}`).digest("hex").slice(0, 8);
}

function extractPiText(content: PiContent[]): string {
	return content
		.map((item) => readString(item.text) || readString(item.thinking) || readString(item.name))
		.filter(Boolean)
		.join(" ");
}

export type ConvertKimiWorkInput = {
	projectPath: string;
	/** sqlite 行白名单投影（title 等）；scan 摘要也复用同一元数据来源。 */
	conversation: {
		conversationId: string;
		title: string;
		firstUserText: string;
		createdAtMs: number;
		updatedAtMs: number;
	};
	/** 源文件 stat（新鲜度判据 + 导入标记回写）。 */
	sourcePath: string;
	sourceSize: number;
	sourceMtime: number;
	translate: SessionImportCopy;
	entries: Iterable<KimiRecord> | AsyncIterable<KimiRecord>;
	sink: (line: string) => Promise<void> | void;
};

/**
 * 把 Kimi Work wire.jsonl 记录流转成 pi 原生 JSONL 会话文件（流式写盘，内存 O(单行)）。
 *
 * 行序保持 wire 原始顺序：append_message（user）与 loop 聚合（assistant）按 time 交错输出。
 * 标题优先用 conversations.sqlite 的 title（桌面版有原生标题，比 CLI 的回退链可靠），
 * 空时回退 first_user_text → 转换中首条 user 消息。
 */
export async function convertKimiWorkSessionTo(input: ConvertKimiWorkInput): Promise<ConvertedKimiWorkSession> {
	const { projectPath, conversation, entries, sink } = input;
	const sessionId = conversation.conversationId;
	const firstTimestamp = conversation.createdAtMs > 0 ? conversation.createdAtMs : Date.now();
	const timestamp = new Date(firstTimestamp).toISOString();
	const titleState = { title: conversation.title || conversation.firstUserText, preview: "" };
	let parentId: string | null = null;
	let sequence = 0;
	let messageCount = 0;
	let lastTimestamp = firstTimestamp;
	const toolNameById = new Map<string, string>();
	const aggregator = new KimiWorkLoopAggregator();

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
				...(role === "assistant" ? extra : extra),
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
		type: "kimi_work_import",
		version: 1,
		sourceSessionId: sessionId,
		sourcePath: input.sourcePath,
		sourceMtime: input.sourceMtime,
		sourceSize: input.sourceSize,
		importedAt: new Date().toISOString(),
	});

	// 模型字段 wire 里不可得（与 CLI 版同口径），占位保持行结构同构
	const modelChangeId = makeId(sessionId, sequence++);
	await pushEntry({
		type: "model_change",
		id: modelChangeId,
		parentId,
		timestamp,
		provider: "kimi-work",
		modelId: "kimi-work-import",
	});
	parentId = modelChangeId;

	const emitAssistant = async (message: NormalizedKimiMessage) => {
		const converted = convertKimiAssistantContent(message);
		for (const tool of converted.toolNames) toolNameById.set(tool.id, tool.name);
		await pushMessage(
			"assistant",
			converted.content,
			{
				usage: kimiUsageToPi(message.usage),
				api: "kimi-work-import",
				provider: "kimi-work",
				model: "kimi-work-import",
				stopReason: normalizeImportedStopReason({
					raw: message.finishReason,
					hasToolCall: importedContentHasToolCall(converted.content),
				}),
			},
			message.time > 0 ? message.time : undefined,
		);
	};

	for await (const entry of entries) {
		const at = readNumber(entry.time);

		// append_message（user/tool）与 CLI 同形态，复用现有提取器
		const direct = extractKimiMessage(entry);
		if (direct) {
			if (at > 0) lastTimestamp = at;
			if (direct.role === "user") {
				const text = joinKimiTextBlocks(direct.content);
				if (text) await pushMessage("user", [{ type: "text", text }], {}, at);
				continue;
			}
			if (direct.role === "tool") {
				const text = joinKimiTextBlocks(direct.content);
				await pushMessage(
					"toolResult",
					[{ type: "text", text }],
					{
						toolCallId: direct.toolCallId,
						toolName: toolNameById.get(direct.toolCallId) || "tool",
						isError: false,
					},
					at,
				);
				continue;
			}
			// assistant 角色的 append_message 在桌面版不存在；万一出现按 CLI 语义处理（快照）
			if (direct.role === "assistant") {
				await emitAssistant(direct);
				continue;
			}
			continue;
		}

		// loop event 流（桌面版助手输出的唯一载体）
		const aggregated = aggregator.feed(entry);
		if (aggregated) {
			if (at > 0) lastTimestamp = at;
			await emitAssistant(aggregated);
		}
	}

	// 流结束仍有未收尾的步（wire 截断/异常退出）：按已有分片兜底产出
	for (let flushed = aggregator.flush(); flushed; flushed = aggregator.flush()) {
		await emitAssistant(flushed);
	}

	const title = cleanKimiTitle(titleState.title) || input.translate("session.importedTitle", { source: "Kimi Work" });
	// pi 原生 session_info 收尾（不用旧版 sessionName 行，见 #114）
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
		preview: titleState.preview || input.translate("session.importedPreview", { source: "Kimi Work" }),
		messageCount,
	};
}

/** scan 摘要用：头部记录粗算标题/预览/消息数（体积有上界，不整读 wire）。 */
export async function convertKimiWorkHeadPreview(input: Omit<ConvertKimiWorkInput, "entries" | "sink"> & { entries: KimiRecord[] }): Promise<ConvertedKimiWorkSession> {
	const lines: string[] = [];
	const result = await convertKimiWorkSessionTo({
		...input,
		entries: input.entries,
		sink: (line) => {
			lines.push(line);
		},
	});
	return result;
}

// extractKimiMessage 的导入在扫描路径之外仍可能被 tree-shake 掉的防御：显式使用 asArray 语义
void asArray;
void importedUnknownBlockAsText;
void normalizeImportedToolArguments;
