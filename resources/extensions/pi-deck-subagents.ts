/**
 * PiDeck Subagents Bridge Extension
 *
 * 订阅 @tintinweb/pi-subagents 插件的生命周期事件，累积快照，经 setWidget 推
 * 送给 PiDeck 渲染层。桥接失效不影响主功能（面板回落为 record + 工具调用推导）。
 *
 * 另桥接 billion-context-pi 的 acp_delegate 委托链（独立 spawn 子进程，不发插件
 * 事件、不落 record、运行状态 widget 仅 TUI 模式激活）：监听工具执行事件与终态
 * 系统通知，并入同一快照；派发即落 start 锚点、终态落 subagents:record，读取侧
 * （SessionHistoryReader）与 pi-subagents 数据同通道复用。
 *
 * 再补 nicobailon pi-subagents 的异步链（`subagent` 工具 async 派发）：该链不落任何
 * 会话文件记录，终态只活在插件自己的 `subagent-async` widget 里，而插件对已完成的
 * job 只保留 10s（async-job-tracker 的 completionRetentionMs）——widget 一被清空，
 * 渲染层就回退到「工具调用推导 = 永远运行中」。这里从派发 args 与异步回执里识别
 * asyncId，终态事件到达时落 subagents:record（持久）并并入桥接快照（实时保持）。
 *
 * @packageDocumentation
 */

/* ------------------------------------------------------------------ */
/* 纯函数快照累积器（可独立单测）                                      */
/* ------------------------------------------------------------------ */

type AgentSnapshot = {
	id: string;
	type: string;
	description: string;
	status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error";
	toolUses: number;
	tokens: number;
	startedAt: number;
	/** 终态时间：completed/failed payload 无绝对时间，用 startedAt + durationMs 换算（缺失时退化为事件到达时刻）。 */
	completedAt?: number;
	/** 终态结果预览：事件 payload 携带的 result/error 文本，截断控制 widget 体积；完整文本走 record（会话文件）。 */
	result?: string;
	error?: string;
	/** 产出来源通道：acp-delegate = billion-context-pi 的 acp_delegate 委托链。 */
	via?: "acp-delegate";
};

type SnapshotState = Map<string, AgentSnapshot>;

function cloneState(state: SnapshotState): SnapshotState {
	return new Map(state);
}

const VALID_STATUSES = new Set([
	"queued", "running", "completed", "steered", "aborted", "stopped", "error",
]);

function safeString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function safeNumber(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 将插件事件 payload 收窄为快照所需字段；字段缺失时降级为默认值。 */
function extractFields(data: unknown): Partial<AgentSnapshot> & { durationMs?: number } {
	if (!data || typeof data !== "object") return {};
	const d = data as Record<string, unknown>;
	return {
		id: safeString(d.id),
		type: safeString(d.type),
		description: safeString(d.description),
		status: VALID_STATUSES.has(String(d.status ?? ""))
			? String(d.status ?? "") as AgentSnapshot["status"]
			: undefined,
		toolUses: safeNumber(d.toolUses),
		tokens: safeNumber(d.tokens),
		startedAt: safeNumber(d.startedAt),
		// completed/failed 的 payload 只带真实运行时长（durationMs），不带绝对完成时刻
		durationMs: typeof d.durationMs === "number" && Number.isFinite(d.durationMs) && d.durationMs > 0
			? d.durationMs
			: undefined,
		// 结果/错误预览截断：widget 每次事件全量推送快照 JSON，全文可能几十 KB；面板预览 2000 字符足够，完整文本由 record（会话文件）承载
		result: typeof d.result === "string" && d.result ? d.result.slice(0, 2000) : undefined,
		error: typeof d.error === "string" && d.error ? d.error.slice(0, 2000) : undefined,
	};
}

/** 终态时间推导：优先 startedAt + 插件真实时长 durationMs（桥接 startedAt 是事件到达近似值，
 *  加上真实时长可消除 created 事件传播延迟误差）；缺失时退化为终态事件到达时刻。 */
function resolveCompletedAt(startedAt: number | undefined, durationMs: number | undefined): number {
	if (startedAt && durationMs) return startedAt + durationMs;
	return Date.now();
}

export function reduceSnapshot(
	state: SnapshotState,
	eventName: string,
	data: unknown,
): { state: SnapshotState; changed: boolean } {
	switch (eventName) {
		case "subagents:created": {
			const fields = extractFields(data);
			if (!fields.id) return { state, changed: false };
			const existing = state.get(fields.id);
			if (existing) return { state, changed: false }; // 幂等
			const next = cloneState(state);
			next.set(fields.id, {
				id: fields.id,
				type: fields.type ?? "",
				description: fields.description ?? "",
				status: "queued",
				toolUses: fields.toolUses ?? 0,
				tokens: fields.tokens ?? 0,
				startedAt: fields.startedAt || Date.now(),

			});
			return { state: next, changed: true };
		}
		case "subagents:started": {
			const fields = extractFields(data);
			if (!fields.id) return { state, changed: false };
			const existing = state.get(fields.id);
			if (existing?.status === "running") return { state, changed: false }; // 重复 started 幂等
			const next = cloneState(state);
			if (!existing) {
				// 前台子代理（spawnAndWait，isBackground=false）不经过 created：插件只在后台派发时发 created。
				// 无此 upsert 时运行期间快照 agents 为空，面板整块不渲染，直到终态事件（自带完整字段的 upsert 分支）才出现条目。
				// started 载荷只有 {id,type,description}：startedAt 用到达时刻近似，与 created 分支 fields.startedAt || Date.now() 的口径一致。
				next.set(fields.id, {
					id: fields.id,
					type: fields.type ?? "",
					description: fields.description ?? "",
					status: "running",
					toolUses: fields.toolUses ?? 0,
					tokens: fields.tokens ?? 0,
					startedAt: fields.startedAt || Date.now(),
				});
				return { state: next, changed: true };
			}
			next.set(fields.id, { ...existing, status: "running" });
			return { state: next, changed: true };
		}
		case "subagents:completed":
		case "subagents:failed": {
			const fields = extractFields(data);
			if (!fields.id) return { state, changed: false };
			const existing = state.get(fields.id);
			// 终态优先采用事件 payload 里的真实 status（插件在 payload 中携带 record.status）；
			// 缺失时才按事件名兜底。否则 steered/stopped/aborted 会被错误折叠成 completed/error。
			const payloadTerminal = fields.status === "completed"
				|| fields.status === "error"
				|| fields.status === "stopped"
				|| fields.status === "aborted"
				|| fields.status === "steered";
			const terminalStatus = payloadTerminal
				? (fields.status as AgentSnapshot["status"])
				: eventName === "subagents:failed"
					? "error"
					: "completed";
			// created/started 事件丢失（桥接晚加载）时直接 upsert：终态事件自携全部展示字段，
			// 不入快照会让该子代理在面板彻底消失。
			if (!existing) {
				const next = cloneState(state);
				next.set(fields.id, {
					id: fields.id,
					type: fields.type ?? "",
					description: fields.description ?? "",
					status: terminalStatus,
					toolUses: fields.toolUses ?? 0,
					tokens: fields.tokens ?? 0,
					startedAt: fields.startedAt || Date.now(),
					completedAt: resolveCompletedAt(fields.startedAt || Date.now(), fields.durationMs),
					result: fields.result,
					error: fields.error,
				});
				return { state: next, changed: true };
			}
			if (existing.status === terminalStatus) return { state, changed: false };
			const next = cloneState(state);
			next.set(fields.id, {
				...existing,
				status: terminalStatus,
				toolUses: fields.toolUses !== undefined ? fields.toolUses : existing.toolUses,
				tokens: fields.tokens !== undefined ? fields.tokens : existing.tokens,
				completedAt: resolveCompletedAt(existing.startedAt, fields.durationMs),
				result: fields.result ?? existing.result,
				error: fields.error ?? existing.error,
			});
			return { state: next, changed: true };
		}
		case "subagents:steered": {
			const fields = extractFields(data);
			if (!fields.id) return { state, changed: false };
			const existing = state.get(fields.id);
			if (!existing) return { state, changed: false };
			if (existing.status === "steered") return { state, changed: false };
			const next = cloneState(state);
			next.set(fields.id, { ...existing, status: "steered" });
			return { state: next, changed: true };
		}
		default:
			// 未知事件忽略
			return { state, changed: false };
	}
}

/* ------------------------------------------------------------------ */
/* acp_delegate（billion-context-pi）桥接                               */
/* ------------------------------------------------------------------ */

const ACP_DELEGATE_TOOL = "acp_delegate";
const ACP_CANCEL_TOOL = "acp_delegate_cancel";
const ACP_VIA = "acp-delegate" as const;

/** 派发确认 / 终态通知文本中的 runId（形如 runId `del_xxx`）。 */
export function extractAcpRunId(text: string): string | undefined {
	const match = /runId `([^`]+)`/.exec(text);
	return match?.[1];
}

/** FAILED 通知中的错误摘录（Output: ~~~ 围栏块）；截断 2000 字符与 record 预览对齐。 */
export function extractAcpErrorExcerpt(text: string): string | undefined {
	const match = /Output:\s*\n?~~~\n?([\s\S]*?)~~~/.exec(text);
	const excerpt = match?.[1]?.trim();
	return excerpt ? excerpt.slice(0, 2000) : undefined;
}

function extractTextItems(items: unknown[]): string {
	let out = "";
	for (const item of items) {
		if (item && typeof item === "object" && (item as Record<string, unknown>).type === "text") {
			const text = (item as Record<string, unknown>).text;
			if (typeof text === "string") out += text;
		}
	}
	return out;
}

/** tool_execution_end 的 result（AgentToolResult | string | 文本数组）归一化为文本。 */
export function extractToolResultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (Array.isArray(result)) return extractTextItems(result);
	if (result && typeof result === "object") {
		const content = (result as Record<string, unknown>).content;
		if (Array.isArray(content)) return extractTextItems(content);
	}
	return "";
}

function isAcpTerminalStatus(status: AgentSnapshot["status"]): boolean {
	return status !== "queued" && status !== "running";
}

/**
 * 工具执行事件 → acp 委托快照条目（与插件快照共用同一 AgentSnapshot 状态集合，
 * 条目 id 固定为派发 toolCallId，与主进程推导/record 落盘对齐）。
 *
 * - start(acp_delegate)：running；幂等。
 * - start(acp_delegate_cancel)：runId 反查条目 → stopped（end 事件不带 args，
 *   取消意图在 start 已明确，容忍取消失败误报终态的边缘场景）。
 * - end(acp_delegate)：从结果文本提取 runId 记入反查表（派发 ≠ 终态，状态不变）。
 */
export function reduceAcpToolEvent(
	state: SnapshotState,
	runIds: ReadonlyMap<string, string>,
	eventName: string,
	data: unknown,
	now: number,
): { state: SnapshotState; runIds: Map<string, string>; changed: boolean } {
	if (!data || typeof data !== "object") return { state, runIds, changed: false };
	const event = data as Record<string, unknown>;
	const toolName = typeof event.toolName === "string" ? event.toolName : "";
	const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
	if (!toolCallId) return { state, runIds, changed: false };
	const args = event.args && typeof event.args === "object"
		? event.args as Record<string, unknown>
		: {};

	if (eventName === "tool_execution_start" && toolName === ACP_DELEGATE_TOOL) {
		if (state.has(toolCallId)) return { state, runIds, changed: false };
		const next = cloneState(state);
		next.set(toolCallId, {
			id: toolCallId,
			type: typeof args.agent === "string" && args.agent ? args.agent : ACP_DELEGATE_TOOL,
			description: typeof args.task === "string" ? args.task : "",
			status: "running",
			toolUses: 0,
			tokens: 0,
			startedAt: now,
			via: ACP_VIA,
		});
		return { state: next, runIds, changed: true };
	}

	if (eventName === "tool_execution_start" && toolName === ACP_CANCEL_TOOL) {
		const runId = typeof args.runId === "string" ? args.runId : "";
		const entryId = runId ? runIds.get(runId) : undefined;
		if (!entryId) return { state, runIds, changed: false };
		const existing = state.get(entryId);
		if (!existing || isAcpTerminalStatus(existing.status)) return { state, runIds, changed: false };
		const next = cloneState(state);
		next.set(entryId, { ...existing, status: "stopped", completedAt: now });
		return { state: next, runIds, changed: true };
	}

	if (eventName === "tool_execution_end" && toolName === ACP_DELEGATE_TOOL) {
		const runId = extractAcpRunId(extractToolResultText(event.result));
		if (!runId) return { state, runIds, changed: false };
		const nextRunIds = new Map(runIds);
		nextRunIds.set(runId, toolCallId);
		return { state, runIds: nextRunIds, changed: false };
	}

	return { state, runIds, changed: false };
}

/**
 * 终态系统通知（role=user，"[acp_delegate completed]" / "[acp_delegate FAILED ⚠️]"
 * 开头）→ 终态迁移。这是 acp 委托唯一可靠的完成信号（插件保证失败必达）。
 * terminalEntryId 供调用方落 subagents:record。
 */
export function reduceAcpNotification(
	state: SnapshotState,
	runIds: ReadonlyMap<string, string>,
	text: string,
	now: number,
): { state: SnapshotState; changed: boolean; terminalEntryId?: string } {
	const isCompleted = text.startsWith("[acp_delegate completed]");
	const isFailed = text.startsWith("[acp_delegate FAILED");
	if (!isCompleted && !isFailed) return { state, changed: false };
	const runId = extractAcpRunId(text);
	const entryId = runId ? runIds.get(runId) : undefined;
	if (!entryId) return { state, changed: false };
	const existing = state.get(entryId);
	if (!existing || isAcpTerminalStatus(existing.status)) return { state, changed: false };
	const next = cloneState(state);
	next.set(entryId, {
		...existing,
		status: isFailed ? "error" : "completed",
		completedAt: now,
		...(isFailed ? { error: extractAcpErrorExcerpt(text) ?? existing.error } : {}),
	});
	return { state: next, changed: true, terminalEntryId: entryId };
}

/* ------------------------------------------------------------------ */
/* pi-subagents（nicobailon）异步链桥接                                 */
/* ------------------------------------------------------------------ */

const SUBAGENT_TOOL = "subagent";
const ASYNC_COMPLETE_EVENT = "subagent:async-complete";

/** 异步派发回执里携带 asyncId 的行："Async: worker [uuid]"（与 `subagent-async` widget 的 run.id 同源，
 *  与主进程推导 `derivedSubagents.extractAsyncRunId` 同一正则，两边改动需同步）。 */
const ASYNC_ID_LINE_RE = /^Async[^\n]*\s\[([^\]\s]+)\]$/m;

/** 派发描述符：回执给出 asyncId 后，快照条目与终态 record 都用它补 type/description/startedAt。 */
export type AsyncRunDescriptor = { type: string; description: string; startedAt: number };

/** 异步链桥接状态：`pending` 按 toolCallId 暂存派发，`byRunId` 在回执到达后按 asyncId 存档。 */
export type AsyncRunBridgeState = { pending: Map<string, AsyncRunDescriptor>; byRunId: Map<string, AsyncRunDescriptor> };

/** 从异步派发回执文本提取 asyncId；非异步回执（前台派发的最终报告）返回 undefined。 */
export function extractAsyncRunId(text: string): string | undefined {
	return ASYNC_ID_LINE_RE.exec(text)?.[1];
}

/**
 * 工具执行事件 → 异步派发描述符。
 *
 * 只认「派发形态」（有 agent、无 action/workflowScript* 字段），与主进程推导
 * `deriveSubagentToolEntries` 同口径：action 管理查询与工作流脚本不是单次运行。
 * start 拿不到 asyncId（回执在 end 才到），所以按 toolCallId 暂存；end 解析出
 * asyncId 后搬进 byRunId——只有异步回执才留档，前台派发的最终报告不产生条目。
 */
export function reduceSubagentAsyncToolEvent(state: AsyncRunBridgeState, eventName: string, data: unknown, now: number): { state: AsyncRunBridgeState; asyncId?: string; descriptor?: AsyncRunDescriptor } {
	if (!data || typeof data !== "object") return { state };
	const event = data as Record<string, unknown>;
	if (event.toolName !== SUBAGENT_TOOL) return { state };
	const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
	if (!toolCallId) return { state };

	if (eventName === "tool_execution_start") {
		if (state.pending.has(toolCallId)) return { state };
		const args = event.args && typeof event.args === "object" ? event.args as Record<string, unknown> : {};
		if (typeof args.agent !== "string" || !args.agent) return { state };
		if (args.action != null || args.workflowScript != null || args.workflowScriptPath != null) return { state };
		const pending = new Map(state.pending);
		pending.set(toolCallId, {
			type: args.agent,
			description: typeof args.task === "string" ? args.task : "",
			startedAt: now,
		});
		return { state: { pending, byRunId: state.byRunId } };
	}

	if (eventName === "tool_execution_end") {
		const descriptor = state.pending.get(toolCallId);
		if (!descriptor) return { state };
		const pending = new Map(state.pending);
		pending.delete(toolCallId);
		const asyncId = extractAsyncRunId(extractToolResultText(event.result));
		// 有 asyncId 才是后台运行（登记终态落盘用）；无则前台派发已完成，描述符使命结束
		if (!asyncId) return { state: { pending, byRunId: state.byRunId } };
		const byRunId = new Map(state.byRunId);
		byRunId.set(asyncId, descriptor);
		return { state: { pending, byRunId }, asyncId, descriptor };
	}

	return { state };
}

/**
 * 插件 async 终态 → PiDeck record 状态。
 *
 * 只映射确定已结束的状态；`paused` / 未知状态不落终态（运行可能恢复，落终态会让
 * 面板把还在跑的 run 误标成已停止）。partial（部分失败）按失败类呈现引导关注，
 * 与渲染层 `SNAPSHOT_STATE_TO_STATUS` 同口径。
 */
const ASYNC_TERMINAL_STATUS_MAP: Record<string, AgentSnapshot["status"]> = {
	complete: "completed",
	completed: "completed",
	failed: "error",
	partial: "error",
	error: "error",
	stopped: "stopped",
	rejected: "stopped",
};

/**
 * 终态事件 payload → 桥接快照条目 + `subagents:record` 载荷（纯函数，可单测）。
 *
 * id 只认 payload 的 runId/id（= 派发回执的 asyncId）；取不到状态或状态未知返回
 * undefined（宁可不落，也不误报终态）。描述/类型优先用派发侧捕获的描述符（插件
 * 事件里的 task 是 PROMPT_REDACTED，只有会话文件里的 args 才有真文本）；描述符
 * 缺失时降级用 payload.agent、描述留空（读取侧 `mergeSubagentSources` 从派发 args 回填）。
 */
export function buildSubagentAsyncTerminal(payload: unknown, descriptor: AsyncRunDescriptor | undefined, now: number): { entry: AgentSnapshot; record: Record<string, unknown> } | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const data = payload as Record<string, unknown>;
	const id = typeof data.runId === "string" && data.runId ? data.runId : typeof data.id === "string" && data.id ? data.id : "";
	if (!id) return undefined;
	const status = ASYNC_TERMINAL_STATUS_MAP[String(data.state ?? data.status ?? "")];
	if (!status) return undefined;

	const durationMs = typeof data.durationMs === "number" && Number.isFinite(data.durationMs) && data.durationMs > 0 ? data.durationMs : undefined;
	const startedAt = descriptor?.startedAt ?? (durationMs !== undefined ? now - durationMs : now);
	// 完成时刻优先用 payload 自带的绝对时刻（result 文件 timestamp / endedAt），
	// 其次按真实时长反推，最后退化到事件到达时刻
	const payloadEndedAt = typeof data.timestamp === "number" && Number.isFinite(data.timestamp) ? data.timestamp : typeof data.endedAt === "number" && Number.isFinite(data.endedAt) ? data.endedAt : undefined;
	const completedAt = payloadEndedAt ?? (durationMs !== undefined ? startedAt + durationMs : now);
	const type = descriptor?.type || (typeof data.agent === "string" && data.agent ? data.agent : SUBAGENT_TOOL);
	const description = descriptor?.description ?? "";
	// 只写错误摘要：payload 的 summary/resultPreview 是截断预览，写进 record.result
	// 会被「查看完整结果」当成全文展示（完整文本在插件产出目录里）
	const error = status === "error" && typeof data.error === "string" && data.error ? data.error.slice(0, 2000) : undefined;
	const entry: AgentSnapshot = { id, type, description, status, toolUses: 0, tokens: 0, startedAt, completedAt, ...(error ? { error } : {}) };
	return { entry, record: { id, type, description, status, startedAt, completedAt, ...(error ? { error } : {}) } };
}

/* ------------------------------------------------------------------ */
/* 扩展主体                                                            */
/* ------------------------------------------------------------------ */

const WIDGET_KEY = "pi-deck-subagents";

/**
 * 子代理 start 锚点条目类型（会话文件 custom 条目）。
 * created 事件时立即落盘：运行中被重启终止的子代理没有 subagents:record
 * （插件只在完成时写），无此锚点则重启后彻底消失。
 * 读取侧（SessionHistoryReader.readSubagentRecords）同字符串过滤：
 * 残留锚点（无 record 覆盖）按活 runtime 对账合成——本代派发 → running，
 * 否则 stopped（详见 #300），改动需两侧同步。
 */
const START_ENTRY_TYPE = "pi-deck-subagent-start";

/**
 * pi-subagents 插件完成时落盘的 record 条目类型；acp_delegate 委托在终态通知
 * 到达时按同一形状落盘，读取侧（SessionHistoryReader.readSubagentRecords）
 * 同字符串过滤，两侧改动需同步。
 */
const RECORD_ENTRY_TYPE = "subagents:record";

export default function piDeckSubagentsBridge(pi: any): void {
	let snapshot: SnapshotState = new Map();
	let pluginActive = false;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	function pushSnapshot(ctx: any) {
		const agents = Array.from(snapshot.values()).map((a) => ({
			id: a.id,
			type: a.type,
			description: a.description,
			status: a.status,
			toolUses: a.toolUses,
			tokens: a.tokens,
			startedAt: a.startedAt,
			completedAt: a.completedAt,
			result: a.result,
				error: a.error,
			via: a.via,
		}));

		// line-based，首行机器可读 JSON（与 pi-deck-todo 同约定）
		const jsonLine = JSON.stringify({ v: 1, kind: "pi-deck-subagents-snapshot", pluginActive, agents });
		ctx.ui.setWidget(WIDGET_KEY, [jsonLine]);
	}

	function schedulePush(ctx: any) {
		if (debounceTimer !== null) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			pushSnapshot(ctx);
		}, 200);
	}

	// 保存一份 ctx.ui 引用；事件回调可能没有 ctx 参数（pi.events 模式），
	// 但 setWidget 需要 ctx.ui。
	// 注意：pi 扩展事件模式为 `pi.on("event", (data, ctx) => ...)`，第二参数含 ctx。
	let savedCtx: any = null;

	function handleEvent(eventName: string, data: unknown, ctx?: any) {
		if (ctx) savedCtx = ctx;
		const result = reduceSnapshot(snapshot, eventName, data);
		if (result.changed) {
			snapshot = result.state;
			// created 即落盘 start 锚点：为"运行中被重启终止"的子代理在会话文件里
			// 留下存在痕迹（完成时会被插件的 subagents:record 覆盖，读取侧按 offset
			// 后写覆盖先写）。持久化失败仅损失审计锚点，不影响实时桥接。
			if (eventName === "subagents:created") {
				const id = extractFields(data).id ?? "";
				const entry = id ? snapshot.get(id) : undefined;
				if (entry) {
					try {
						pi.appendEntry(START_ENTRY_TYPE, {
							id: entry.id,
							type: entry.type,
							description: entry.description,
							startedAt: entry.startedAt,
						});
					} catch {
						// appendEntry 失败不阻断桥接：面板实时数据不依赖锚点
					}
				}
			}
			if (savedCtx) schedulePush(savedCtx);
		}
	}

	// 插件在位探测：subagents:ready 由插件在首个 session_start 时经 pi.events（扩展事件总线）广播。
	// 注意必须用 pi.events.on 订阅：pi.on 是生命周期事件表（extensionRunner.emit 派发 session_start 等），
	// 与 pi.events 的 eventBus 互不相通——用 pi.on 订阅插件事件会永远收不到（曾导致面板误报插件未安装）。
	pi.events.on("subagents:ready", () => {
		pluginActive = true;
		// 立即推送快照，让 pluginActive=true 尽快到达渲染层；
		// savedCtx 可能尚未由本扩展的 session_start 处理器设置（插件扩展先于内置扩展加载），
		// 此时跳过，由 session_start 处理器末尾的兜底推送覆盖。
		if (savedCtx) pushSnapshot(savedCtx);
	});

	// pi.events 事件 handler 只有 data 参数（无 ctx），setWidget 统一走 savedCtx。
	const onSubagentEvent = (eventName: string) => (data: unknown) => handleEvent(eventName, data);
	pi.events.on("subagents:created", onSubagentEvent("subagents:created"));
	pi.events.on("subagents:started", onSubagentEvent("subagents:started"));
	pi.events.on("subagents:completed", onSubagentEvent("subagents:completed"));
	pi.events.on("subagents:failed", onSubagentEvent("subagents:failed"));
	pi.events.on("subagents:steered", onSubagentEvent("subagents:steered"));

	/* acp_delegate（billion-context-pi）桥接：
	 * 工具执行事件与终态系统通知走 pi.on 生命周期事件表（非 pi.events）。 */

	// runId → 快照条目 id（派发 toolCallId）：终态通知/取消只带 runId。
	let acpRunIds: Map<string, string> = new Map();

	function handleAcpToolEvent(eventName: string, data: unknown, ctx?: any) {
		if (ctx) savedCtx = ctx;
		const result = reduceAcpToolEvent(snapshot, acpRunIds, eventName, data, Date.now());
		acpRunIds = result.runIds;
		if (result.state !== snapshot) snapshot = result.state;
		if (!result.changed) return;
		// 派发即落 start 锚点：与 pi-subagents created 同语义（运行中被重启终止
		// → 残留锚点由读取侧合成 stopped）。落盘失败不影响实时桥接。
		if (eventName === "tool_execution_start") {
			const toolCallId = (data as any)?.toolCallId;
			const entry = typeof toolCallId === "string" ? snapshot.get(toolCallId) : undefined;
			if (entry) {
				try {
					pi.appendEntry(START_ENTRY_TYPE, {
						id: entry.id,
						type: entry.type,
						description: entry.description,
						startedAt: entry.startedAt,
					});
				} catch {
					// appendEntry 失败不阻断桥接：面板实时数据不依赖锚点
				}
			}
		}
		if (savedCtx) schedulePush(savedCtx);
	}

	// 终态系统通知以 user 消息注入会话（message_end 可捕获）：据此迁到终态并落
	// subagents:record（历史重建的权威数据，读取侧与 pi-subagents record 同通道）。
	pi.on("message_end", (event: unknown, ctx?: any) => {
		if (ctx) savedCtx = ctx;
		const message = event && typeof event === "object" ? (event as Record<string, unknown>).message : undefined;
		if (!message || typeof message !== "object") return;
		const record = message as Record<string, unknown>;
		if (record.role !== "user") return;
		const text = typeof record.content === "string"
			? record.content
			: Array.isArray(record.content) ? extractTextItems(record.content) : "";
		if (!text.startsWith("[acp_delegate ")) return;
		const result = reduceAcpNotification(snapshot, acpRunIds, text, Date.now());
		if (result.state !== snapshot) snapshot = result.state;
		if (!result.changed) return;
		const entry = result.terminalEntryId ? snapshot.get(result.terminalEntryId) : undefined;
		if (entry) {
			try {
				pi.appendEntry(RECORD_ENTRY_TYPE, {
					id: entry.id,
					type: entry.type,
					description: entry.description,
					status: entry.status,
					startedAt: entry.startedAt,
					completedAt: entry.completedAt,
					error: entry.error,
					via: ACP_VIA,
				});
			} catch {
				// 落盘失败仅损失历史重建（主进程推导兜底仍可从通知文本恢复），不影响实时桥接
			}
		}
		if (savedCtx) schedulePush(savedCtx);
	});

	/**
	 * 工具执行事件分发：acp_delegate（billion-context）与 subagent 异步链（nicobailon）
	 * 共用同两个 pi.on 注册点，各自 reducer 内部按工具名过滤。
	 */
	function handleToolEvent(eventName: string, data: unknown, ctx?: any) {
		handleAcpToolEvent(eventName, data, ctx);
		handleAsyncToolEvent(eventName, data);
	}

	/* pi-subagents（nicobailon）异步链：subagent 工具异步派发不落任何会话文件记录，
	 * 终态只活在插件自己的 `subagent-async` widget 里，而该 widget 在完成 10s 后被
	 * 插件清空（async-job-tracker 的 completionRetentionMs）→ 渲染层回退到工具推导的
	 * 「永远运行中」。这里把终态落成 subagents:record（持久）+ 并入桥接快照（实时）。 */
	let asyncBridge: AsyncRunBridgeState = { pending: new Map(), byRunId: new Map() };
	/** 已落盘的终态（id → status）：完成事件因投递重试/会话恢复重放时不重复写记录。 */
	let asyncRecorded = new Map<string, string>();

	function handleAsyncToolEvent(eventName: string, data: unknown) {
		const result = reduceSubagentAsyncToolEvent(asyncBridge, eventName, data, Date.now());
		asyncBridge = result.state;
	}

	/**
	 * 异步终态：落 subagents:record + 并入桥接快照。
	 *
	 * 快照那份是给实时面板看的——插件的 `subagent-async` widget 10s 后会消失，而桥接
	 * 快照里的终态会留到会话结束，否则渲染层会回退到推导条目的 running。
	 * 但只有派发被桥接看见（byRunId 有描述符）的异步 run 才落盘：工作流子 run 与
	 * 「桥接晚于派发加载」的 run 不并入，避免面板凭空多出无描述的条目（推导侧
	 * 读取时的描述回填另在 `mergeSubagentSources` 处理）。
	 */
	function handleAsyncComplete(data: unknown) {
		const payload = data && typeof data === "object" ? data as Record<string, unknown> : {};
		const runId = typeof payload.runId === "string" && payload.runId ? payload.runId : typeof payload.id === "string" ? payload.id : "";
		const descriptor = runId ? asyncBridge.byRunId.get(runId) : undefined;
		if (!descriptor) return;
		const built = buildSubagentAsyncTerminal(data, descriptor, Date.now());
		if (!built) return;
		const { entry, record } = built;
		if (asyncRecorded.get(entry.id) === entry.status) return;
		asyncRecorded.set(entry.id, entry.status);
		try {
			pi.appendEntry(RECORD_ENTRY_TYPE, record);
		} catch {
			// 落盘失败只损失历史重建（会话已收尾等）；实时快照仍然照常推送
		}
		snapshot.set(entry.id, entry);
		if (savedCtx) schedulePush(savedCtx);
	}

	pi.events.on(ASYNC_COMPLETE_EVENT, handleAsyncComplete);

	// 工具执行事件（acp 派发/取消 + subagent 异步派发回执）统一在两个注册点分发
	pi.on("tool_execution_start", (event: unknown, ctx?: any) => handleToolEvent("tool_execution_start", event, ctx));
	pi.on("tool_execution_end", (event: unknown, ctx?: any) => handleToolEvent("tool_execution_end", event, ctx));

	/**
	 * 会话关闭（pi 在 /new、resume、fork、quit 时触发 session_shutdown）：
	 * 给仍在 running/queued 的条目补一条终态 record。
	 *
	 * 为什么需要：子代理 runner 是 pi 的子进程，会话关闭后旧会话文件里永远停在
	 * running——后续终态通知属于新会话文件，旧文件再也等不到写入，面板就一直显示
	 * 「运行中」、时长无限增长（用户实测几千分钟）。这里按关闭时刻补 stopped；
	 * 读取侧按 offset「后写覆盖先写」，若 runner 事后真的完成了，插件的终态 record
	 * 会盖过这条近似值。
	 *
	 * appendEntry 必须容错：teardown 阶段会话已在收尾，落盘失败只是少一条审计
	 * 记录，不能让异常冒泡打断 pi 的会话切换。
	 */
	pi.on("session_shutdown", (_event: unknown, ctx?: any) => {
		if (ctx) savedCtx = ctx;
		if (debounceTimer !== null) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		const closedAt = Date.now();
		// 先收集再改写：同一进程内切回该会话（resume）时快照也必须是终态，
		// 否则面板会凭内存快照把已关闭的条目重新报成 running。
		const inflight = Array.from(snapshot.values()).filter(
			(entry) => entry.status === "running" || entry.status === "queued",
		);
		for (const entry of inflight) {
			try {
				pi.appendEntry(RECORD_ENTRY_TYPE, {
					id: entry.id,
					type: entry.type,
					description: entry.description,
					status: "stopped",
					startedAt: entry.startedAt,
					completedAt: closedAt,
					via: entry.via,
				});
			} catch {
				// 落盘失败仅损失审计记录，不影响 pi 的会话切换
			}
			snapshot.set(entry.id, { ...entry, status: "stopped", completedAt: closedAt });
		}
	});

	pi.on("session_start", (_event: unknown, ctx: any) => {
		// 重置快照（新会话开始，无存活后台代理）。
		// pluginActive 不重置：一个 pi 进程对应一个会话，插件加载状态进程级不变；
		// 且插件在首个 session_start 时广播 ready（其处理器先于本扩展执行），
		// 若在此重置会把 ready 置的 true 覆盖掉，导致插件在位却误报未安装。
		snapshot = new Map();
		acpRunIds = new Map();
		asyncBridge = { pending: new Map(), byRunId: new Map() };
		asyncRecorded = new Map();
		savedCtx = ctx;
		if (debounceTimer !== null) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		// 兜底推送一次：此时插件 ready 已在本处理器之前到达（扩展加载顺序保证），
		// 让最新 pluginActive 状态（含 true）写入 widget。
		pushSnapshot(ctx);
	});
}