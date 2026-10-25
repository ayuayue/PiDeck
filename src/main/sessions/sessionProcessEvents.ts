import type { SessionProcessEvent, SessionProcessEventKind } from "../../shared/types/trajectory";
import { PromptSnapshotReplay, promptSnapshotSummary } from "../pi/promptSnapshotReplay";

/** 账本最多回传的事件条数（按文件顺序取前 N 条）。 */
export const MAX_EVENTS = 240;
const DETAIL_LIMIT = 12_000;

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function parseTimestamp(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return 0;
}

function clipDetail(value: string): string {
	if (value.length <= DETAIL_LIMIT) return value;
	return `${value.slice(0, DETAIL_LIMIT)}\n…`;
}

function stringifyUnknown(value: unknown): string | undefined {
	if (value == null) return undefined;
	if (typeof value === "string") return value.trim() ? clipDetail(value) : undefined;
	try {
		return clipDetail(JSON.stringify(value, null, 2));
	} catch {
		return undefined;
	}
}

function eventId(entry: Record<string, unknown>, index: number, kind: SessionProcessEventKind): string {
	return asString(entry.id) ?? `process-${kind}-${index}`;
}

function kindFromType(type: string, customType?: string): SessionProcessEventKind | undefined {
	if (type === "session") return "session";
	if (type === "session_info") return "sessionInfo";
	if (type === "model_change") return "modelChange";
	if (type === "thinking_level_change") return "thinkingChange";
	if (type === "compaction") return "compaction";
	if (type === "custom") return "custom";
	if (type === "usage") return "usage";
	if (type.endsWith("_import") || customType?.endsWith(".child-session")) return "import";
	return undefined;
}

/** 单条 JSONL 条目 → 过程事件（不含提示词重放；system 消息与压缩快照由收集器处理）。 */
export function parseSessionProcessEntry(entry: Record<string, unknown>, index: number): SessionProcessEvent | undefined {
	const type = asString(entry.type);
	if (!type || type === "message") return undefined;
	const customType = asString(entry.customType);
	const kind = kindFromType(type, customType);
	if (!kind) return undefined;

	const cwd = asString(entry.cwd) ?? asString((entry.header as Record<string, unknown> | undefined)?.cwd);
	const parentSession = asString(entry.parentSession) ?? asString((entry.header as Record<string, unknown> | undefined)?.parentSession);
	const provider = asString(entry.provider);
	const modelId = asString(entry.modelId);
	const thinkingLevel = asString(entry.thinkingLevel);
	const name = asString(entry.name) ?? asString((entry.data as Record<string, unknown> | undefined)?.name);
	const tokensBefore = asNumber(entry.tokensBefore);
	const summaryText = asString(entry.summary);
	const customContent = asString(entry.content) ?? stringifyUnknown(entry.data) ?? stringifyUnknown(entry.customData);
	const usageRecord = isRecord(entry.usage) ? entry.usage : undefined;
	const inputTokens = asNumber(usageRecord?.input);
	const outputTokens = asNumber(usageRecord?.output);

	let summary = type;
	if (kind === "session") summary = cwd ? `cwd ${cwd}` : "session";
	else if (kind === "sessionInfo") summary = name ?? "session_info";
	else if (kind === "modelChange") summary = [provider, modelId].filter(Boolean).join("/") || "model_change";
	else if (kind === "thinkingChange") summary = thinkingLevel ? `thinking ${thinkingLevel}` : "thinking_level_change";
	else if (kind === "compaction") summary = summaryText ?? "compaction";
	else if (kind === "custom") summary = customType ?? "custom";
	else if (kind === "import") summary = customType ?? type;
	else if (kind === "usage") summary = [asString(entry.kind), inputTokens !== undefined ? `in ${inputTokens}` : undefined, outputTokens !== undefined ? `out ${outputTokens}` : undefined].filter(Boolean).join(" · ") || "usage";

	return {
		id: eventId(entry, index, kind),
		kind,
		timestamp: parseTimestamp(entry.timestamp),
		summary,
		detail: customContent ?? summaryText,
		cwd,
		parentSession,
		provider,
		modelId,
		thinkingLevel,
		customType,
		tokensBefore,
		...(kind === "usage" ? { usageKind: asString(entry.kind) } : {}),
	};
}

/**
 * 有状态的行收集器：过程事件 + 系统提示词快照。
 *
 * 为什么要状态：pi 的系统消息是**可累积的表面**（sections 补丁 / 工具增删），
 * 只有按顺序重放才能还原「这一条把提示词变成了什么」，逐行纯函数拿不到装载。
 *
 * 为什么提示词快照延到 `finish()`：文件里可能有多条分支（回退后重写），
 * 哪些系统条目属于**当前装载**取决于活动父链，而活动叶子是最后一条条目。
 * 流式阶段只能看到「文件序」，据此重放会把旁支补丁打进当前装载（计划 §8.3 B1）。
 */
/**
 * 保留策略：提示词快照与会话头是**固定项**，普通事件按最近优先填剩余名额。
 *
 * 为什么不能「凑够 240 就停」：系统提示词的变化点往往在长会话后段，扫到第 240 条
 * 普通事件就返回会让账本永远停在当时的旧装载（2026-10 计划 §8.3 B2）。
 * 为什么不直接返回全部：IPC 载荷与渲染成本要和会话长度脱钩。
 */
export function retainProcessEvents(events: SessionProcessEvent[], limit: number): SessionProcessEvent[] {
	if (events.length <= limit) return events;
	const keep = new Set<SessionProcessEvent>();
	let sessionKept = false;
	for (const event of events) {
		if (event.kind === "systemPrompt") keep.add(event);
		else if (event.kind === "session" && !sessionKept) {
			keep.add(event);
			sessionKept = true;
		}
	}
	if (keep.size === 0) return events.slice(-limit);
	// 提示词自身就超上限：按文件序保留最早的 limit 条（初始提示词优先）。
	if (keep.size >= limit) {
		const trimmed = new Set<SessionProcessEvent>();
		for (const event of events) {
			if (!keep.has(event)) continue;
			trimmed.add(event);
			if (trimmed.size >= limit) break;
		}
		return events.filter((event) => trimmed.has(event));
	}
	const ordinaryBudget = limit - keep.size;
	const ordinary = events.filter((event) => !keep.has(event));
	for (const event of ordinary.slice(-ordinaryBudget)) keep.add(event);
	return events.filter((event) => keep.has(event));
}

/** 提示词重放候选上限：防畸形会话靠“很多小系统消息”吃光内存（计划 §3.2）。 */
export const MAX_PROMPT_CANDIDATES = 512;
/** 提示词重放候选正文字节上限（与计划 §3.2 的 8MiB 同口径）。 */
export const MAX_PROMPT_CANDIDATE_BYTES = 8 * 1024 * 1024;

type PromptCandidate = {
	id: string | undefined;
	parentId: string | undefined;
	entry: Record<string, unknown>;
	index: number;
	/** 压缩条目的体积快照（systemMessage）；系统消息为 undefined。 */
	compaction?: Record<string, unknown>;
};

export type SessionProcessCollector = {
	/** 喂一行；返回本行产出的过程事件（不含提示词快照，它们要等活动父链确定）。 */
	push: (rawLine: string, index: number) => SessionProcessEvent[];
	/** 扫完后调用：按活动父链、链序重放出提示词快照。 */
	finish: () => SessionProcessEvent[];
};

export function createSessionProcessCollector(): SessionProcessCollector {
	const candidates: PromptCandidate[] = [];
	const parentById = new Map<string, string | undefined>();
	let leafId: string | undefined;
	let previousId: string | undefined;
	let candidateBytes = 0;
	return {
		push(rawLine, index) {
			const line = rawLine.trim();
			if (!line) return [];
			let entry: Record<string, unknown>;
			try {
				const parsed: unknown = JSON.parse(line);
				if (!isRecord(parsed)) return [];
				entry = parsed;
			} catch {
				return [];
			}
			// 父链只跟 message/custom/context_edit 这类有身份条目有关，但 pi 会把 id 写到所有条目上，
			// 这里统一记，叶子才能沿 user/assistant 回溯到系统条目的插入点。
			const id = asString(entry.id);
			const parentId = asString(entry.parentId);
			if (id) {
				// 老会话/合成夹具没有 parentId：按文件序串成线性链，不能因缺字段把整段历史当旁支丢掉。
				parentById.set(id, parentId ?? previousId);
				leafId = id;
				previousId = id;
			}
			const events: SessionProcessEvent[] = [];
			// 系统消息条目：不参与对话投影（AgentMessageProjector 主动过滤），但它是
			// 提示词装载的唯一持久化事实，轨迹账本据此还原「初始提示词 + 每次变更」。
			if (entry.type === "message") {
				const message = isRecord(entry.message) ? entry.message : undefined;
				if (message?.role !== "system") return [];
				queueCandidate({ id, parentId, entry, index });
				return [];
			}
			const event = parseSessionProcessEntry(entry, index);
			if (event) events.push(event);
			// 压缩条目自带 boundary 全量快照：压缩后装载以它为准。
			if (entry.type === "compaction" && isRecord(entry.systemMessage)) {
				queueCandidate({ id, parentId, entry, index, compaction: entry.systemMessage });
			}
			return events;
		},
		finish() {
			const ordered = orderCandidatesByActiveChain(candidates, parentById, leafId);
			const replay = new PromptSnapshotReplay();
			const snapshots: SessionProcessEvent[] = [];
			for (const candidate of ordered) {
				const prompt = candidate.compaction ? replay.applyCompactionSnapshot(candidate.compaction) : replay.applySystemMessage(candidate.entry.message);
				if (prompt) snapshots.push(promptEvent(candidate.entry, candidate.index, prompt));
			}
			return snapshots;
		},
	};

	function queueCandidate(candidate: PromptCandidate): void {
		if (candidates.length >= MAX_PROMPT_CANDIDATES) return;
		// 用条目 JSON 长度估体积（含 message 正文），超预算就不再收：宁可覆盖不足并标记，也不吃满内存。
		const bytes = JSON.stringify(candidate.compaction ?? candidate.entry.message ?? "").length;
		if (candidateBytes + bytes > MAX_PROMPT_CANDIDATE_BYTES) return;
		candidateBytes += bytes;
		candidates.push(candidate);
	}
}

/**
 * 候选 → 活动父链顺序。
 *
 * 叶子沿 parentId 回溯到根，得到活动链集合；只重放落在链上的候选，
 * 并按链序（根→叶子）排列——旁支条目既不参与装载，也不进当前账本。
 * 没有任何 id 信息时退回文件序（旧会话/合成 fixture 无父链）。
 */
function orderCandidatesByActiveChain(candidates: PromptCandidate[], parentById: Map<string, string | undefined>, leafId: string | undefined): PromptCandidate[] {
	if (parentById.size === 0 || !leafId) return candidates;
	const chain: string[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined = leafId;
	while (cursor && !seen.has(cursor)) {
		seen.add(cursor);
		chain.push(cursor);
		cursor = parentById.get(cursor);
	}
	const position = new Map<string, number>();
	for (let index = chain.length - 1; index >= 0; index -= 1) position.set(chain[index], chain.length - 1 - index);
	const onChain = candidates.filter((candidate) => candidate.id !== undefined && position.has(candidate.id));
	if (onChain.length === 0) return candidates;
	return onChain.sort((left, right) => (position.get(left.id as string) ?? 0) - (position.get(right.id as string) ?? 0));
}

function promptEvent(entry: Record<string, unknown>, index: number, prompt: NonNullable<SessionProcessEvent["prompt"]>): SessionProcessEvent {
	return {
		id: `${eventId(entry, index, "systemPrompt")}:prompt`,
		kind: "systemPrompt",
		timestamp: parseTimestamp(entry.timestamp),
		summary: promptSnapshotSummary(prompt),
		prompt,
	};
}

/**
 * 从会话 JSONL 抽出过程事件。坏行跳过；普通对话 message 条目不进账本
 * （对话已由 ChatMessage 覆盖），系统提示词条目例外（只有账本用得上它们）。
 *
 * 本模块保持**零运行时依赖**（纯函数 + pi 提示词重放，便于单测）。需要从磁盘流式读取的
 * 调用方走 sessionProcessEventsFile.ts 的 parseSessionProcessEventsFromFile。
 */
export function parseSessionProcessEvents(raw: string): SessionProcessEvent[] {
	const collector = createSessionProcessCollector();
	let events: SessionProcessEvent[] = [];
	const lines = raw.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		events.push(...collector.push(lines[index], index));
		if (events.length > MAX_EVENTS) events = retainProcessEvents(events, MAX_EVENTS);
	}
	return retainProcessEvents([...events, ...collector.finish()], MAX_EVENTS);
}
