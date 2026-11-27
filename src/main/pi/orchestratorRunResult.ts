import type { PiSubagentStatus } from "../../shared/types";

/**
 * 编排插件（orchestrator）的结果投影：`custom_message` 里 `orchestrator-run-result`
 * 一类条目的**摘要级**解析（issue #598）。
 *
 * 为什么不能直接渲染：这条 custom_message 的 `results[].messages` 带着每个子代理的
 * 完整对话，用户实测单条约 381 KB。把它塞进时间线/子代理卡片会让面板卡顿，而且这些
 * 内容本来就能在子会话里看到（`tasks[].sessionFile` → 打开子会话）。
 * 所以本模块只读**标量与计数**：runId、动作/状态、每个任务的 agent / 状态 / 耗时 /
 * 轮数 / 会话文件路径。`results[].messages` 这个字段**从不读取**（载荷 JSON 会解一次
 * 以便取标量，但该字段既不引用也不复制，投影结果里没有它），输出体积有硬上限（见
 * MAX_SUMMARY_CHARS / MAX_TASKS），因此可以安全地作为卡片正文并跨 IPC 下发。
 *
 * 容错优先：插件字段名未定稿（runId/run_id、action/status/phase），解析不出来就返回
 * undefined，调用方保持原条目状态（推导链已有的 running→stopped 对账兜底）。
 */

/** 认得的 customType（插件历史/命名风格差异都在这里收口）。 */
export const ORCHESTRATOR_RESULT_CUSTOM_TYPES: ReadonlySet<string> = new Set(["orchestrator-run-result", "orchestrator_run_result", "orchestrator-result"]);

/** 卡片正文上限：再多的任务也不再往里加（宁可少信息，也不让卡片顶爆）。 */
const MAX_SUMMARY_CHARS = 2000;
const MAX_TASKS = 20;
const MAX_FIELD_CHARS = 160;

export type OrchestratorTaskSummary = {
	agent: string;
	status: PiSubagentStatus;
	durationMs?: number;
	turns?: number;
	/** 子会话文件（绝对路径）：渲染层据此跳到完整子 agent 会话。 */
	sessionFile?: string;
	/** 任务级一句话说明（截断）。 */
	summary?: string;
};

export type OrchestratorRunUpdate = {
	runId: string;
	/** 运行整体状态（由 action/status/phase 归一）。 */
	status: PiSubagentStatus;
	action?: string;
	tasks: OrchestratorTaskSummary[];
	/** 卡片正文：整体计数 + 每任务一行（有上限）。 */
	summary: string;
	/** 终态时间戳（条目 timestamp 或载荷里的完成时间）。 */
	completedAtMs?: number;
	turns?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
	return undefined;
}

function clip(value: string | undefined, limit = MAX_FIELD_CHARS): string | undefined {
	if (!value) return undefined;
	const single = value.replace(/\s+/g, " ").trim();
	if (!single) return undefined;
	return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}

/** 状态词归一：插件用 done/cancelled/pending，PiDeck 用自己的七态。 */
const STATUS_WORDS: ReadonlyArray<{ status: PiSubagentStatus; pattern: RegExp }> = [
	{ status: "error", pattern: /^(fail|failed|failure|error|errored)$/i },
	{ status: "stopped", pattern: /^(cancel|cancelled|canceled|abort|aborted|stopped|killed|skipped)$/i },
	{ status: "completed", pattern: /^(done|complete|completed|success|succeeded|finished|ok)$/i },
	{ status: "steered", pattern: /^(steer|steered|redirected)$/i },
	{ status: "running", pattern: /^(running|started|start|in[_-]?progress|inflight|dispatched|delegated|active)$/i },
	{ status: "queued", pattern: /^(queued|pending|waiting|scheduled)$/i },
];

export function normalizeOrchestratorStatus(value: unknown): PiSubagentStatus | undefined {
	const text = asText(value);
	if (!text) return undefined;
	for (const candidate of STATUS_WORDS) {
		if (candidate.pattern.test(text)) return candidate.status;
	}
	return undefined;
}

/** 内容块数组只拼 text 项；其它块（图片/工具）一律忽略。 */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const item of content) {
		if (isRecord(item) && item.type === "text" && typeof item.text === "string") out += item.text;
	}
	return out;
}

function payloadOf(entry: unknown): Record<string, unknown> | undefined {
	if (!isRecord(entry)) return undefined;
	// 正文可能是 JSON 字符串、内容块数组，或直接是对象（插件写法差异）
	const text = contentText(entry.content);
	if (text.trim().startsWith("{")) {
		try {
			const parsed: unknown = JSON.parse(text);
			if (isRecord(parsed)) return parsed;
		} catch {
			// 落到下面的结构兜底
		}
	}
	if (isRecord(entry.data)) return entry.data;
	if (isRecord(entry.payload)) return entry.payload;
	// content 不是 JSON 时，条目自身可能就是载荷（custom_message 的正文在顶层）
	return "runId" in entry || "tasks" in entry || "results" in entry ? entry : undefined;
}

function taskSummaryOf(task: unknown): OrchestratorTaskSummary | undefined {
	if (!isRecord(task)) {
		// 允许 tasks: ["Explore"] 这种裸字符串写法
		const agent = asText(task);
		return agent ? { agent: clip(agent) ?? agent, status: "completed" } : undefined;
	}
	const agent = asText(task.agent) ?? asText(task.type) ?? asText(task.name) ?? asText(task.id);
	const status = normalizeOrchestratorStatus(task.status) ?? normalizeOrchestratorStatus(task.action) ?? normalizeOrchestratorStatus(task.state) ?? "completed";
	const durationMs = asNumber(task.durationMs) ?? asNumber(task.duration) ?? asNumber(task.elapsedMs) ?? asNumber(task.elapsed);
	const turns = asNumber(task.turns) ?? asNumber(task.turnCount) ?? asNumber(task.rounds);
	const sessionFile = asText(task.sessionFile) ?? asText(task.sessionPath) ?? asText(task.session_file);
	return {
		agent: clip(agent) ?? "delegate",
		status,
		...(durationMs != null ? { durationMs } : {}),
		...(turns != null ? { turns } : {}),
		// 只有绝对路径才当作可打开的子会话：相对路径/占位符打开必失败
		...(sessionFile && /^([a-zA-Z]:[\\/]|\/)/.test(sessionFile) ? { sessionFile } : {}),
		...(clip(asText(task.summary) ?? asText(task.title)) ? { summary: clip(asText(task.summary) ?? asText(task.title)) } : {}),
	};
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	return `${minutes}m${Math.round((ms % 60_000) / 1000)}s`;
}

/** 计数 + 每任务一行的紧凑正文（硬上限，绝不包含 messages 内容）。 */
function buildSummary(tasks: OrchestratorTaskSummary[], status: PiSubagentStatus, extra: { durationMs?: number; turns?: number }): string {
	const counts = new Map<PiSubagentStatus, number>();
	for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
	const head: string[] = [];
	if (tasks.length > 0) head.push(`${tasks.length} task${tasks.length === 1 ? "" : "s"}`);
	for (const [taskStatus, count] of counts) head.push(`${count} ${taskStatus}`);
	if (tasks.length === 0) head.push(status);
	if (extra.durationMs != null) head.push(formatDuration(extra.durationMs));
	if (extra.turns != null) head.push(`${extra.turns} turns`);

	const lines = [head.join(" · ")];
	for (const task of tasks.slice(0, MAX_TASKS)) {
		const parts = [task.agent, task.status];
		if (task.durationMs != null) parts.push(formatDuration(task.durationMs));
		if (task.turns != null) parts.push(`${task.turns} turns`);
		if (task.summary) parts.push(task.summary);
		lines.push(`— ${parts.join(" · ")}`);
	}
	if (tasks.length > MAX_TASKS) lines.push(`… +${tasks.length - MAX_TASKS} more`);
	const text = lines.join("\n");
	return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS - 1)}…` : text;
}

/**
 * 解析一条 `orchestrator-run-result` custom_message。
 *
 * 返回 undefined 的三种情况：不是这类条目、拿不到 runId、载荷里没有任何可判定字段。
 * 调用方应保持条目原状（历史会话由 running→stopped 对账兜底，不会永久亮「运行中」）。
 */
export function parseOrchestratorRunResult(entry: unknown): OrchestratorRunUpdate | undefined {
	if (!isRecord(entry)) return undefined;
	const customType = asText(entry.customType) ?? asText(isRecord(entry.data) ? entry.data.customType : undefined);
	if (!customType || !ORCHESTRATOR_RESULT_CUSTOM_TYPES.has(customType)) return undefined;
	const payload = payloadOf(entry);
	if (!payload) return undefined;

	const runId = asText(payload.runId) ?? asText(payload.run_id) ?? asText(payload.runID) ?? asText(payload.traceId);
	if (!runId) return undefined;

	const action = asText(payload.action) ?? asText(payload.status) ?? asText(payload.state) ?? asText(payload.phase);
	const rawTasks = Array.isArray(payload.tasks) ? payload.tasks : Array.isArray(payload.results) ? payload.results : [];
	const tasks = rawTasks.map(taskSummaryOf).filter((task): task is OrchestratorTaskSummary => Boolean(task));
	const totals = isRecord(payload.totals) ? payload.totals : undefined;
	const turns = asNumber(payload.turns) ?? asNumber(payload.turnCount) ?? (totals ? asNumber(totals.turns) : undefined) ?? (tasks.some((task) => task.turns != null) ? tasks.reduce((sum, task) => sum + (task.turns ?? 0), 0) : undefined);
	const durationMs = asNumber(payload.durationMs) ?? asNumber(payload.duration) ?? asNumber(payload.elapsedMs) ?? (totals ? asNumber(totals.durationMs) : undefined);

	// 整体状态：显式 action 优先；否则由任务状态归纳（全完成→completed，任一失败→error，
	// 有运行中→running，全取消→stopped）
	let status = normalizeOrchestratorStatus(action);
	if (!status && tasks.length > 0) {
		if (tasks.some((task) => task.status === "running" || task.status === "queued")) status = "running";
		else if (tasks.every((task) => task.status === "completed")) status = "completed";
		else if (tasks.some((task) => task.status === "error")) status = "error";
		else status = tasks[0]?.status ?? "completed";
	}
	if (!status) return undefined;

	const completedAtRaw = asText(payload.completedAt) ?? asText(payload.finishedAt) ?? asText(entry.timestamp);
	const completedAtMs = completedAtRaw ? Date.parse(completedAtRaw) : NaN;

	return {
		runId,
		status,
		...(action ? { action } : {}),
		tasks,
		summary: buildSummary(tasks, status, { ...(durationMs != null ? { durationMs } : {}), ...(turns != null ? { turns } : {}) }),
		...(Number.isFinite(completedAtMs) ? { completedAtMs } : {}),
		...(turns != null ? { turns } : {}),
	};
}

/** 该条目的 customType 是否属于编排结果（扫描侧预检用，不解析正文）。 */
export function isOrchestratorResultEntry(entry: unknown): boolean {
	if (!isRecord(entry)) return false;
	const customType = asText(entry.customType);
	return customType != null && ORCHESTRATOR_RESULT_CUSTOM_TYPES.has(customType);
}
