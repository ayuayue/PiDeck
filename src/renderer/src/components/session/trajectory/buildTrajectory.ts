/**
 * 将会话消息折叠成轨迹账本（turn + 3-lane 时间线）。
 *
 * 业务规则：
 * - 用户消息开启新 turn；其后的 assistant / thinking / tool 归入该 turn。
 * - system / error 不拆 turn，挂到当前 turn；若还没有 turn 则单独成 turn。
 * - 工具起止优先用 meta.startedAt + meta.durationMs（与 AgentManager 写入约定一致），
 *   不用 message.timestamp（update/end 会刷新，历史恢复后耗时不可还原）。
 * - in-flight（running / pending）不伪造 duration：endedAt 留空，时间列显示为进行中。
 * - assistant 耗时：meta.durationMs（pi 落盘的真实响应时长，timestamp = 请求开始）
 *   存在时直接用；缺失（旧数据/其它后端）才回退到邻居锚点回推。
 * - JSONL / DSH 过程事件按墙钟落入最近 turn；轮内顺序对齐 dsh-web layout.ts：
 *   初始系统提示最先，其余按 seq，无 seq 退回墙钟。重试（llm/retry）是过程记录，
 *   不得因 timestamp=0 被插到轮首。
 * - 系统提示词来自会话事实：pi 的 `message.role==="system"` 条目（按文件顺序重放）与压缩
 *   快照、dsh 的 `system/message` + `request/header`，两后端统一由 processEvents 快照
 *   （kind=systemPrompt）带进来。初始一份固定排轮首，中途变更留在真实位置；
 *   不再用 pi-system 模板充当「系统提示」。
 * - 模型请求快照（extras.modelTraces）按请求时刻落入所在用户轮：时间点记录，
 *   不伪造区间；检查器凭 modelTrace.traceId 回读完整请求体。
 */

import type { ChatMessage } from "../../../../../shared/types";
import type { SessionProcessEvent, SessionPromptSnapshot } from "../../../../../shared/types/trajectory";
import { toolViewDetail, toolViewInput, toolViewOutput, toolViewTitle, type DshToolViewEnvelope } from "./dshToolView";
import { compareTrajectoryRecords, seqOfMessage, sortTurnRecords, wallTime } from "./trajectoryOrder";

export { compareTrajectoryRecords };

export type TrajectoryLane = "input" | "model" | "tools" | "process";

export type TrajectoryRecordKind = "user" | "assistant" | "thinking" | "tool" | "system" | "error" | "process" | "systemPrompt" | "modelRequest";

/** 模型请求快照摘要（rpcLogs direction:"model" 的 request 条目，hook 层拉取后传入）。 */
export type TrajectoryModelTraceSummary = {
	traceId: string;
	/** 快照归属的 pi 子进程 agent（回读完整请求体需要；RpcLogEntry.agentId）。 */
	agentId?: string;
	/** 请求发起时刻（RpcLogEntry.time，毫秒墙钟）。 */
	time: number;
	model?: string;
	provider?: string;
	messageCount?: number;
	toolCount?: number;
	payloadBytes?: number;
	truncated?: boolean;
};

export type TrajectoryRecord = {
	id: string;
	kind: TrajectoryRecordKind;
	lane: TrajectoryLane;
	turnIndex: number;
	title: string;
	summary: string;
	startedAt: number;
	/** 缺省 = in-flight，时间线可投影到 now，账本不得编造耗时。 */
	endedAt?: number;
	durationMs?: number;
	status?: string;
	toolName?: string;
	toolCallId?: string;
	text?: string;
	detail?: string;
	/** dsh-web inputDetail：工具入参 / 用户正文。 */
	inputDetail?: string;
	/** dsh-web outputDetail：工具结果 / 助手正文。 */
	outputDetail?: string;
	/** 首条用户消息 = 本会话初始提示词（DSH 的 user 开轮语义）。 */
	isInitialPrompt?: boolean;
	processKind?: SessionProcessEvent["kind"];
	cwd?: string;
	provider?: string;
	modelId?: string;
	thinkingLevel?: string;
	customType?: string;
	/** DSH SessionEvent.seq；账本按 seq 排序（dsh-web layoutEntryOrder）。 */
	seq?: number;
	/** llm/retry 或 pi auto_retry：第几次重试。 */
	retry?: number;
	maxRetries?: number;
	retryDelayMs?: number;
	/** 本条 assistant 消息的 token 用量（pi 会话文件的 usage / DSH adapter 上报，均存 meta.usage）。 */
	usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number };
	/** systemPrompt 记录的快照种类（初始 / 变更 / 压缩快照）。 */
	promptKind?: SessionPromptSnapshot["kind"];
	/** systemPrompt 记录的系统提示词快照（含工具目录与变更）。 */
	prompt?: SessionPromptSnapshot;
	/** modelRequest 记录的快照指针：检查器凭它回读完整请求体并展示体积/截断标记。 */
	modelTrace?: { traceId: string; agentId?: string; messageCount?: number; toolCount?: number; payloadBytes?: number; truncated?: boolean };
};

export type TrajectoryTurn = {
	index: number;
	id: string;
	startedAt: number;
	endedAt?: number;
	inFlight: boolean;
	/** 本轮首条到末条的墙钟跨度；in-flight 时缺省，UI 用 now 显示已过时间。 */
	durationMs?: number;
	records: TrajectoryRecord[];
};

export type TrajectoryModel = {
	turns: TrajectoryTurn[];
	records: TrajectoryRecord[];
	domainStart: number;
	domainEnd: number;
};

export type TrajectoryBuildExtras = {
	processEvents?: SessionProcessEvent[];
	/** 模型请求快照摘要（升序传入即可，内部按时间落轮）。 */
	modelTraces?: TrajectoryModelTraceSummary[];
};

const SUMMARY_LIMIT = 96;

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function summarize(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= SUMMARY_LIMIT) return flat;
	return `${flat.slice(0, SUMMARY_LIMIT - 1)}…`;
}

function toolNameOf(message: ChatMessage): string {
	const fromMeta = asString(message.meta?.toolName);
	if (fromMeta) return fromMeta;
	const text = message.text.replace(/^[\u25b6\u2713\u2717]\s*/u, "").trim();
	return text.split(/\s+/)[0] || "tool";
}

function laneOf(kind: TrajectoryRecordKind): TrajectoryLane {
	if (kind === "user") return "input";
	if (kind === "tool") return "tools";
	if (kind === "process" || kind === "systemPrompt") return "process";
	return "model";
}

function isThinkingOnly(message: ChatMessage): boolean {
	return message.role === "assistant" && Boolean(message.thinking?.trim()) && !message.text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
}

function isInFlightTool(message: ChatMessage): boolean {
	return asString(message.meta?.status) === "running";
}

function isInFlightAssistant(message: ChatMessage): boolean {
	return message.stopReason === "pending";
}

/** 从消息 meta.usage 提取 token 用量（pi 会话文件/DSH adapter 同形；无效/全零返回 undefined）。 */
function usageOf(message: ChatMessage): TrajectoryRecord["usage"] | undefined {
	const usage = message.meta?.usage;
	if (!usage || typeof usage !== "object") return undefined;
	const u = usage as Record<string, unknown>;
	const inputTokens = typeof u.inputTokens === "number" ? u.inputTokens : 0;
	const outputTokens = typeof u.outputTokens === "number" ? u.outputTokens : 0;
	if (inputTokens <= 0 && outputTokens <= 0) return undefined;
	return {
		inputTokens,
		outputTokens,
		...(typeof u.cacheReadTokens === "number" ? { cacheReadTokens: u.cacheReadTokens } : {}),
		...(typeof u.cacheWriteTokens === "number" ? { cacheWriteTokens: u.cacheWriteTokens } : {}),
		...(typeof u.reasoningTokens === "number" ? { reasoningTokens: u.reasoningTokens } : {}),
	};
}

function pushRecord(records: TrajectoryRecord[], record: TrajectoryRecord): void {
	records.push(record);
}

function flushTurn(turns: TrajectoryTurn[], records: TrajectoryRecord[], startedAt: number, id: string): void {
	if (records.length === 0) return;
	const endedCandidates = records.map((record) => record.endedAt).filter((value): value is number => typeof value === "number");
	const inFlight = records.some((record) => record.endedAt === undefined);
	const endedAt = inFlight ? undefined : endedCandidates.length > 0 ? Math.max(...endedCandidates) : startedAt;
	turns.push({
		index: turns.length,
		id,
		startedAt,
		endedAt,
		inFlight,
		durationMs: endedAt !== undefined && endedAt >= startedAt ? endedAt - startedAt : undefined,
		records,
	});
}

function isPointKind(kind: TrajectoryRecordKind): boolean {
	return kind === "user" || kind === "process" || kind === "systemPrompt" || kind === "system" || kind === "error" || kind === "modelRequest";
}

function recordAnchor(record: TrajectoryRecord): number {
	return (record.endedAt && record.endedAt > 0 ? record.endedAt : record.startedAt) || 0;
}

/**
 * 历史 JSONL 里 assistant/thinking 常只有结束时刻。用轮内上一条锚点回推区间。
 * 已有实测 duration（工具、live thinking）不覆盖；同一条消息拆出的 thinking
 * 若没有独立起止，把整段算在 assistant 上，避免两条各算一遍。
 */
function inferWorkDurations(turns: TrajectoryTurn[]): void {
	for (const turn of turns) {
		for (let index = 0; index < turn.records.length; index += 1) {
			const record = turn.records[index];
			if (isPointKind(record.kind) || record.durationMs !== undefined || record.endedAt === undefined) {
				continue;
			}
			if (record.kind !== "thinking" && record.kind !== "assistant") continue;

			const next = turn.records[index + 1];
			// 同一轮 assistant 已有实测 durationMs（pi 落盘的真实区间）时，不要再给
			// 它的 thinking 回推区间：否则同一段耗时在两条记录上各算一次。
			const measuredNeighbour = record.kind === "thinking" && next?.kind === "assistant" && next.durationMs !== undefined;
			if (measuredNeighbour) continue;

			const sameStampAsAssistant = record.kind === "thinking" && next?.kind === "assistant" && next.startedAt === record.startedAt && (record.endedAt === undefined || record.endedAt === record.startedAt);
			if (sameStampAsAssistant) continue;

			const prev = turn.records
				.slice(0, index)
				.reverse()
				.find((item) => {
					const at = recordAnchor(item);
					return at > 0 && at < record.startedAt;
				});
			const prevAt = prev ? recordAnchor(prev) : 0;
			// 历史 assistant 的 timestamp 是落盘时刻 ≈ 结束；优先用它，不要伸到下一个工具。
			const ownEnd = record.endedAt > record.startedAt ? record.endedAt : 0;
			const ownStamp = record.startedAt;
			const nextAt = next && next.startedAt > 0 ? next.startedAt : 0;
			const end = ownEnd || (prevAt > 0 && ownStamp > prevAt ? ownStamp : 0) || nextAt;
			const start = prevAt > 0 && prevAt < end ? prevAt : record.startedAt;
			if (!(end > start)) continue;
			record.startedAt = start;
			record.endedAt = end;
			record.durationMs = end - start;
		}

		const endedCandidates = turn.records.map((record) => record.endedAt).filter((value): value is number => typeof value === "number");
		turn.inFlight = turn.records.some((record) => record.endedAt === undefined);
		if (!turn.inFlight && endedCandidates.length > 0) {
			turn.endedAt = Math.max(...endedCandidates);
			turn.durationMs = Math.max(0, turn.endedAt - turn.startedAt);
		}
	}
}

function processRecord(event: SessionProcessEvent, turnIndex: number): TrajectoryRecord {
	const startedAt = wallTime(event.timestamp);
	// 系统提示词快照：账本里要与其它过程记录区分开（初始/变更/压缩快照），
	// 并在检查器里展示全文与工具目录（见 TrajectoryRecord.prompt）。
	if (event.kind === "systemPrompt" && event.prompt) {
		return {
			id: `process:${event.id}`,
			kind: "systemPrompt",
			lane: "process",
			turnIndex,
			title: event.prompt.kind,
			summary: summarize(event.summary),
			startedAt,
			endedAt: startedAt || undefined,
			seq: event.seq,
			promptKind: event.prompt.kind,
			prompt: event.prompt,
		};
	}
	return {
		id: `process:${event.id}`,
		kind: "process",
		lane: "process",
		turnIndex,
		title: event.kind,
		summary: summarize(event.summary),
		startedAt,
		endedAt: startedAt || undefined,
		// 过程事件是时间点，没有可测区间；0 会在 UI 上伪装成「瞬间完成」。
		text: event.summary,
		detail: event.detail,
		processKind: event.kind,
		cwd: event.cwd,
		provider: event.provider,
		modelId: event.modelId,
		thinkingLevel: event.thinkingLevel,
		customType: event.customType,
		seq: event.seq,
		retry: event.retry,
		maxRetries: event.maxRetries,
		retryDelayMs: event.retryDelayMs,
		status: event.tokensBefore !== undefined ? String(event.tokensBefore) : undefined,
	};
}

/** 模型请求快照的体积标签（账本时长列与摘要共用）。 */
export function traceSizeLabel(bytes: number | undefined): string {
	if (bytes === undefined || bytes <= 0) return "";
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / 1024).toFixed(1)} KB`;
}

function modelRequestRecord(trace: TrajectoryModelTraceSummary, turnIndex: number): TrajectoryRecord {
	const parts = [trace.model ?? "model"];
	if (trace.messageCount !== undefined) parts.push(`${trace.messageCount} msgs`);
	if (trace.toolCount !== undefined) parts.push(`${trace.toolCount} tools`);
	const size = traceSizeLabel(trace.payloadBytes);
	if (size) parts.push(size);
	return {
		id: `model:${trace.traceId}`,
		kind: "modelRequest",
		lane: "model",
		turnIndex,
		title: "modelRequest",
		summary: parts.join(" · "),
		startedAt: trace.time,
		// 请求快照是时间点：起止同刻，不伪造区间（UI 时长列改显体积）。
		endedAt: trace.time,
		modelId: trace.model,
		provider: trace.provider,
		modelTrace: {
			traceId: trace.traceId,
			agentId: trace.agentId,
			messageCount: trace.messageCount,
			toolCount: trace.toolCount,
			payloadBytes: trace.payloadBytes,
			truncated: trace.truncated,
		},
	};
}

/** 按墙钟找墙钟时刻所属的用户轮（无 seq 的快照专用；轮列表按时间升序）。 */
function turnIndexAtTime(turns: TrajectoryTurn[], at: number): number {
	if (turns.length === 0) return -1;
	if (!(at > 0)) return turns.length - 1;
	if (at < turns[0].startedAt) return 0;
	for (let index = 0; index < turns.length; index += 1) {
		const nextStart = turns[index + 1]?.startedAt;
		if (nextStart === undefined || at < nextStart) return index;
	}
	return turns.length - 1;
}

function insertModelTraces(turns: TrajectoryTurn[], traces: TrajectoryModelTraceSummary[]): void {
	if (traces.length === 0) return;
	const ordered = [...traces].sort((left, right) => left.time - right.time);
	for (const trace of ordered) {
		const target = turnIndexAtTime(turns, trace.time);
		if (target < 0) {
			// 无消息可归轮（纯快照视图）：单独成轮，保证账本不空。
			const record = modelRequestRecord(trace, 0);
			flushTurn(turns, [record], record.startedAt, record.id);
			continue;
		}
		const turn = turns[target];
		turn.records.push(modelRequestRecord(trace, turn.index));
	}
}

/** 过程事件落轮：优先 seq（dsh-web 按 startSeq 挂 step），无 seq 再按墙钟。 */
function turnIndexForProcess(turns: TrajectoryTurn[], event: SessionProcessEvent): number {
	const seq = event.seq;
	if (seq !== undefined) {
		let target = 0;
		for (let index = 0; index < turns.length; index += 1) {
			const user = turns[index].records.find((record) => record.kind === "user");
			const userSeq = user?.seq;
			if (userSeq !== undefined && userSeq <= seq) target = index;
		}
		return target;
	}
	const at = wallTime(event.timestamp);
	if (!(at > 0)) return turns.length - 1;
	let target = 0;
	for (let index = 0; index < turns.length; index += 1) {
		const nextStart = turns[index + 1]?.startedAt;
		if (at >= turns[index].startedAt && (nextStart === undefined || at < nextStart)) {
			return index;
		}
		if (at < turns[0].startedAt) return 0;
		target = turns.length - 1;
	}
	return target;
}

function insertProcessEvents(turns: TrajectoryTurn[], events: SessionProcessEvent[]): void {
	if (events.length === 0) return;
	if (turns.length === 0) {
		const records = events.map((event) => processRecord(event, 0));
		flushTurn(turns, records, records[0]?.startedAt ?? 0, records[0]?.id ?? "process");
		return;
	}

	for (const event of events) {
		const target = turnIndexForProcess(turns, event);
		const turn = turns[target];
		const at = wallTime(event.timestamp) || turn.startedAt;
		const record = processRecord({ ...event, timestamp: at }, turn.index);
		// 先追加，收口时按 seq/墙钟统一排序（dsh-web layoutEntryOrder）。
		turn.records.push(record);
		if (record.startedAt > 0 && record.startedAt < turn.startedAt) turn.startedAt = record.startedAt;
	}
}

/**
 * 从 ChatMessage[] 构建轨迹。now 仅用于空会话兜底 domain，不写入 in-flight duration。
 */
export function buildTrajectory(messages: ChatMessage[], now = Date.now(), extras: TrajectoryBuildExtras = {}): TrajectoryModel {
	const turns: TrajectoryTurn[] = [];
	let current: TrajectoryRecord[] = [];
	let turnStartedAt = 0;
	let turnId = "";
	let sawUser = false;
	// dsh-web 先按 seq 排再折叠；历史页/窗口拼接若乱序，按数组走会把后到的重试/助手拆到轮首。
	const orderedMessages = [...messages].sort((left, right) => {
		const leftSeq = seqOfMessage(left);
		const rightSeq = seqOfMessage(right);
		if (leftSeq !== undefined && rightSeq !== undefined && leftSeq !== rightSeq) {
			return leftSeq - rightSeq;
		}
		return wallTime(left.timestamp) - wallTime(right.timestamp);
	});

	const startTurn = (id: string, startedAt: number) => {
		if (current.length > 0) flushTurn(turns, current, turnStartedAt, turnId || current[0].id);
		current = [];
		turnId = id;
		turnStartedAt = startedAt;
	};

	for (const message of orderedMessages) {
		const seq = seqOfMessage(message);
		if (message.role === "user") {
			const initial = !sawUser;
			sawUser = true;
			startTurn(message.id, wallTime(message.timestamp));
			pushRecord(current, {
				id: message.id,
				kind: "user",
				lane: laneOf("user"),
				turnIndex: turns.length,
				title: "user",
				summary: summarize(message.text),
				startedAt: wallTime(message.timestamp),
				endedAt: wallTime(message.timestamp),
				text: message.text,
				inputDetail: message.text,
				seq,
				isInitialPrompt: initial || undefined,
			});
			continue;
		}

		if (current.length === 0) {
			turnId = message.id;
			turnStartedAt = wallTime(message.timestamp);
		}

		if (message.role === "tool") {
			const startedAt = wallTime(asNumber(message.meta?.startedAt) ?? message.timestamp);
			const durationMs = asNumber(message.meta?.durationMs);
			const inFlight = isInFlightTool(message);
			const name = toolNameOf(message);
			const endedAt = inFlight ? undefined : durationMs !== undefined ? startedAt + durationMs : wallTime(message.timestamp);
			// DSH 工具视图（host ToolEventView，dsh-web 同数据源）：call/result 视图
			// 提供命令/输出/退出码/diff 等更完整的信息，标题用卡片头（如 "Write foo.txt"）。
			const meta = message.meta as { view?: DshToolViewEnvelope; resultView?: DshToolViewEnvelope; args?: unknown; [key: string]: unknown } | undefined;
			const viewTitle = toolViewTitle(meta);
			const viewDetail = toolViewDetail(meta);
			const inputDetail = toolViewInput(meta);
			const outputDetail = toolViewOutput(meta) ?? asString(message.meta?.detailText) ?? asString(message.meta?.result);
			pushRecord(current, {
				id: message.id,
				kind: "tool",
				lane: laneOf("tool"),
				turnIndex: turns.length,
				title: viewTitle ?? name,
				summary: summarize(viewTitle ?? asString(message.meta?.detailText) ?? message.text ?? name),
				startedAt,
				endedAt,
				durationMs: inFlight ? undefined : durationMs,
				status: asString(message.meta?.status) ?? (message.meta?.isError ? "error" : "done"),
				toolName: name,
				toolCallId: asString(message.meta?.toolCallId),
				text: message.text,
				detail: viewDetail ?? outputDetail ?? inputDetail,
				inputDetail,
				outputDetail,
				seq,
			});
			continue;
		}

		if (message.role === "assistant") {
			if (message.thinking?.trim()) {
				const startedAt = wallTime(message.thinkingStartedAt ?? message.timestamp);
				const hasSpan = message.thinkingStartedAt !== undefined && message.thinkingEndedAt !== undefined;
				const endedAt = isThinkingOnly(message) && isInFlightAssistant(message) ? undefined : wallTime(message.thinkingEndedAt ?? message.timestamp);
				pushRecord(current, {
					id: `${message.id}:thinking`,
					kind: "thinking",
					lane: laneOf("thinking"),
					turnIndex: turns.length,
					title: "thinking",
					summary: summarize(message.thinking),
					startedAt,
					endedAt,
					// 缺起止时间就不要用同一条 message.timestamp 相减得出 0ms。
					durationMs: endedAt === undefined || !hasSpan ? undefined : Math.max(0, endedAt - startedAt),
					text: message.thinking,
					seq,
				});
			}
			if (!isThinkingOnly(message)) {
				const inFlight = isInFlightAssistant(message);
				const usage = usageOf(message);
				// pi 的 assistant 消息 timestamp = 请求开始（ai/types.ts），配合 meta.durationMs
				// 得到真实区间；缺 durationMs 的旧数据/其它后端退回时间点 + 邻居锚点回推。
				const stamp = wallTime(message.timestamp);
				const measuredDurationMs = asNumber(message.meta?.durationMs);
				const startedAt = wallTime(asNumber(message.meta?.startedAt) ?? stamp);
				const endedAt = inFlight ? undefined : measuredDurationMs !== undefined && startedAt > 0 ? startedAt + measuredDurationMs : stamp;
				pushRecord(current, {
					id: message.id,
					kind: "assistant",
					lane: laneOf("assistant"),
					turnIndex: turns.length,
					title: "assistant",
					summary: summarize(message.text),
					startedAt,
					endedAt,
					durationMs: inFlight || measuredDurationMs === undefined ? undefined : Math.max(0, measuredDurationMs),
					status: message.stopReason,
					text: message.text,
					outputDetail: message.text,
					seq,
					...(usage ? { usage } : {}),
				});
			}
			continue;
		}

		const kind: TrajectoryRecordKind = message.role === "error" ? "error" : "system";
		const retry = asNumber(message.meta?.attempt);
		pushRecord(current, {
			id: message.id,
			kind,
			lane: laneOf(kind),
			turnIndex: turns.length,
			title: asString(message.meta?.type) ?? kind,
			summary: summarize(message.text),
			startedAt: wallTime(message.timestamp),
			endedAt: wallTime(message.timestamp),
			text: message.text,
			detail: asString(message.meta?.debugDetails) ?? asString(message.meta?.type),
			seq,
			status: asString(message.meta?.status),
			...(retry !== undefined ? { retry } : {}),
			...(asNumber(message.meta?.maxAttempts) !== undefined ? { maxRetries: asNumber(message.meta?.maxAttempts) } : {}),
			...(asNumber(message.meta?.delayMs) !== undefined ? { retryDelayMs: asNumber(message.meta?.delayMs) } : {}),
		});
	}

	if (current.length > 0) flushTurn(turns, current, turnStartedAt, turnId || current[0].id);
	insertProcessEvents(turns, extras.processEvents ?? []);
	insertModelTraces(turns, extras.modelTraces ?? []);
	// 系统提示词不再用「参考模板」冒充：快照全部来自会话事实（pi 会话文件的 system
	// 条目 / dsh 的 system.message 与请求头），无事实就不出记录。

	// 对齐 dsh-web layout.ts：轮内按 seq（无 seq 则墙钟）排，再回推耗时。
	// 耗时回推依赖邻居顺序；排完后再 infer，避免重试/过程事件插在轮首后把 assistant 区间拉歪。
	for (const turn of turns) sortTurnRecords(turn);
	inferWorkDurations(turns);

	const records = turns.flatMap((turn) => turn.records.map((record) => ({ ...record, turnIndex: turn.index })));
	const times = records
		.flatMap((record) => {
			const values = [record.startedAt];
			if (record.endedAt !== undefined) values.push(record.endedAt);
			return values;
		})
		.filter((value) => value > 0);
	const domainStart = times.length > 0 ? Math.min(...times) : now;
	const closedEnd = times.length > 0 ? Math.max(...times) : now;
	// domain 右端：有 in-flight 时伸到 now，让时间线开区间可见；账本本身仍不写 duration。
	const domainEnd = records.some((record) => record.endedAt === undefined) ? Math.max(closedEnd, now) : closedEnd;

	return { turns, records, domainStart, domainEnd };
}

export type TrajectoryTimeRange = { start: number; end: number };

/** 区间过滤：与 span 有重叠即保留；无区间则全量。 */
export function filterRecordsByRange(records: TrajectoryRecord[], range: TrajectoryTimeRange | undefined): TrajectoryRecord[] {
	if (!range) return records;
	const lo = Math.min(range.start, range.end);
	const hi = Math.max(range.start, range.end);
	return records.filter((record) => {
		const start = record.startedAt;
		const end = record.endedAt ?? start;
		return end >= lo && start <= hi;
	});
}
