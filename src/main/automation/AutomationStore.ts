import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
	AutomationBudget,
	AutomationChangedEvent,
	AutomationRun,
	AutomationRunEvent,
	AutomationRunEventType,
	AutomationRunStatus,
	AutomationSettings,
	AutomationSnapshot,
	AutomationTask,
	AutomationTaskMode,
	AutomationTaskSummary,
	CreateAutomationTaskInput,
	UpdateAutomationSettingsInput,
	UpdateAutomationTaskInput,
} from "../../shared/types";
import { isAutomationRunTerminal } from "../../shared/types";
import { nextAutomationCronOccurrence, parseAutomationCron } from "./automationCron";
import { trimAutomationRunHistory } from "./automationPolicy";

const SCHEMA_VERSION = 1;
const MAX_RUN_EVENTS = 200;

export const DEFAULT_AUTOMATION_BUDGET: AutomationBudget = {
	timeoutMs: 30 * 60_000,
	maxTokens: 200_000,
	maxCostUsd: 2,
	maxSteps: 200,
};

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
	maxConcurrentRuns: 1,
	historyLimit: 200,
};

type PersistedAutomationState = {
	version: number;
	revision: number;
	settings: AutomationSettings;
	tasks: AutomationTask[];
	runs: AutomationRun[];
};

type RunPatch = Partial<Omit<AutomationRun, "id" | "taskId" | "taskName" | "projectId" | "events">>;

/**
 * Owns PiDeck's automation.json. All mutations are serialized so rapid scheduler/runtime
 * events cannot let an older write overwrite a newer in-memory revision.
 */
export class AutomationStore {
	private state: PersistedAutomationState = createEmptyState();
	private saveQueue: Promise<void> = Promise.resolve();
	private readonly listeners = new Set<(event: AutomationChangedEvent) => void>();

	constructor(private readonly filePath: string) {}

	async load(now = Date.now()): Promise<AutomationSnapshot> {
		let shouldPersist = false;
		try {
			const raw = await readFile(this.filePath, "utf8");
			const normalized = normalizePersistedState(JSON.parse(raw) as unknown);
			this.state = normalized.state;
			shouldPersist = normalized.changed;
		} catch {
			this.state = createEmptyState();
			shouldPersist = true;
		}

		// A process restart loses the live runtime binding. Never pretend a persisted
		// queued/running run can resume safely; keep the session for audit and mark it.
		for (const run of this.state.runs) {
			if (isAutomationRunTerminal(run.status)) continue;
			const endedAt = now;
			run.status = "interrupted";
			run.endedAt = endedAt;
			run.durationMs = run.startedAt ? Math.max(0, endedAt - run.startedAt) : undefined;
			run.updatedAt = endedAt;
			run.error = "PiDeck stopped before this automation run completed";
			run.events = appendRunEvent(run.events, "interrupted", endedAt, run.error);
			shouldPersist = true;
		}
		this.state.runs = trimAutomationRunHistory(this.state.runs, this.state.settings.historyLimit);
		if (shouldPersist) await this.persist();
		return this.getSnapshot(now);
	}

	getSnapshot(now = Date.now()): AutomationSnapshot {
		return cloneSerializable({
			revision: this.state.revision,
			settings: this.state.settings,
			tasks: this.state.tasks
				.map((task) => summarizeTask(task, now))
				.sort((left, right) => left.name.localeCompare(right.name)),
			runs: [...this.state.runs].sort((left, right) => right.updatedAt - left.updatedAt),
		});
	}

	getTask(taskId: string): AutomationTask | undefined {
		const task = this.state.tasks.find((candidate) => candidate.id === taskId);
		return task ? cloneSerializable(task) : undefined;
	}

	getRun(runId: string): AutomationRun | undefined {
		const run = this.state.runs.find((candidate) => candidate.id === runId);
		return run ? cloneSerializable(run) : undefined;
	}

	listTasks(): AutomationTask[] {
		return cloneSerializable(this.state.tasks);
	}

	listRuns(): AutomationRun[] {
		return cloneSerializable(this.state.runs);
	}

	onChanged(listener: (event: AutomationChangedEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async createTask(input: CreateAutomationTaskInput, now = Date.now()): Promise<AutomationTask> {
		const normalized = normalizeTaskInput(input, now);
		const task: AutomationTask = {
			id: randomUUID(),
			...normalized,
			createdAt: now,
			updatedAt: now,
			// Starting at creation prevents a newly-created task from backfilling an
			// occurrence that happened earlier in the same minute.
			lastScheduledAt: now,
		};
		await this.mutate(() => {
			this.state.tasks.push(task);
		});
		return cloneSerializable(task);
	}

	async updateTask(
		taskId: string,
		patch: UpdateAutomationTaskInput,
		now = Date.now(),
	): Promise<AutomationTask> {
		const index = this.state.tasks.findIndex((candidate) => candidate.id === taskId);
		if (index < 0) throw new Error("Automation task not found");
		const current = this.state.tasks[index];
		const merged = normalizeTaskInput({
			name: patch.name ?? current.name,
			projectId: patch.projectId ?? current.projectId,
			prompt: patch.prompt ?? current.prompt,
			schedule: patch.schedule ?? current.schedule,
			enabled: patch.enabled ?? current.enabled,
			backend: patch.backend === undefined ? current.backend : patch.backend,
			model: patch.model === undefined ? current.model : patch.model,
			thinkingLevel: patch.thinkingLevel === undefined ? current.thinkingLevel : patch.thinkingLevel,
			mode: patch.mode === undefined ? current.mode : patch.mode,
			permissionPreset: patch.permissionPreset === undefined
				? current.permissionPreset
				: patch.permissionPreset,
			budget: { ...current.budget, ...(patch.budget ?? {}) },
		}, now);
		const scheduleChanged = JSON.stringify(current.schedule) !== JSON.stringify(merged.schedule);
		const reEnabled = !current.enabled && merged.enabled;
		// 不能先铺 current 再铺 merged：model / thinkingLevel 被清空时 merged 会省略该键，
		// 铺 current 会把旧值留住，编辑器「恢复默认模型」就写不进去。
		const updated: AutomationTask = {
			id: current.id,
			...merged,
			createdAt: current.createdAt,
			updatedAt: now,
			// A schedule edit or resume starts a fresh scheduling window; intentionally
			// do not catch up occurrences from the old expression or paused interval.
			...(scheduleChanged || reEnabled
				? { lastScheduledAt: now }
				: current.lastScheduledAt !== undefined
					? { lastScheduledAt: current.lastScheduledAt }
					: {}),
		};
		await this.mutate(() => {
			this.state.tasks[index] = updated;
		});
		return cloneSerializable(updated);
	}

	async deleteTask(taskId: string): Promise<boolean> {
		let deleted = false;
		await this.mutate(() => {
			const before = this.state.tasks.length;
			this.state.tasks = this.state.tasks.filter((task) => task.id !== taskId);
			deleted = this.state.tasks.length !== before;
		}, false);
		return deleted;
	}

	async updateSettings(patch: UpdateAutomationSettingsInput): Promise<AutomationSettings> {
		const settings = normalizeSettings({ ...this.state.settings, ...patch });
		await this.mutate(() => {
			this.state.settings = settings;
			this.state.runs = trimAutomationRunHistory(this.state.runs, settings.historyLimit);
		});
		return cloneSerializable(settings);
	}

	async acknowledgeSchedule(taskId: string, scheduledAt: number): Promise<void> {
		const task = this.state.tasks.find((candidate) => candidate.id === taskId);
		if (!task) return;
		await this.mutate(() => {
			task.lastScheduledAt = Math.max(task.lastScheduledAt ?? 0, scheduledAt);
			task.updatedAt = Math.max(task.updatedAt, scheduledAt);
		});
	}

	async createRun(input: {
		task: AutomationTask;
		trigger: AutomationRun["trigger"];
		scheduledFor?: number;
		status?: AutomationRunStatus;
		error?: string;
		skippedReason?: AutomationRun["skippedReason"];
	}, now = Date.now()): Promise<AutomationRun> {
		const status = input.status ?? "queued";
		const run: AutomationRun = {
			id: randomUUID(),
			taskId: input.task.id,
			taskName: input.task.name,
			projectId: input.task.projectId,
			trigger: input.trigger,
			status,
			...(input.scheduledFor === undefined ? {} : { scheduledFor: input.scheduledFor }),
			queuedAt: now,
			...(isAutomationRunTerminal(status) ? { endedAt: now, durationMs: 0 } : {}),
			updatedAt: now,
			inputTokens: 0,
			outputTokens: 0,
			costUsd: 0,
			stepCount: 0,
			...(input.error ? { error: input.error } : {}),
			...(input.skippedReason ? { skippedReason: input.skippedReason } : {}),
			events: [createRunEvent(statusToEventType(status), now, input.error)],
		};
		await this.mutate(() => {
			this.state.runs.unshift(run);
			this.state.runs = trimAutomationRunHistory(this.state.runs, this.state.settings.historyLimit);
		});
		return cloneSerializable(run);
	}

	/**
	 * 删除已结束的运行历史。进行中的 queued/starting/running 一律跳过，
	 * 避免把还在跑的任务从看板抹掉后无法中止。
	 */
	async deleteRuns(runIds: string[]): Promise<number> {
		const idSet = new Set(runIds.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()));
		if (idSet.size === 0) return 0;
		let deleted = 0;
		await this.mutate(() => {
			const next = this.state.runs.filter((run) => {
				if (!idSet.has(run.id) || !isAutomationRunTerminal(run.status)) return true;
				deleted += 1;
				return false;
			});
			this.state.runs = next;
		});
		return deleted;
	}

	/** 清空全部已结束记录，保留正在跑的任务。 */
	async clearTerminalRuns(): Promise<number> {
		let deleted = 0;
		await this.mutate(() => {
			const next = this.state.runs.filter((run) => !isAutomationRunTerminal(run.status));
			deleted = this.state.runs.length - next.length;
			this.state.runs = next;
		});
		return deleted;
	}

	async updateRun(
		runId: string,
		patch: RunPatch,
		event?: { type: AutomationRunEventType; message?: string; at?: number },
	): Promise<AutomationRun | undefined> {
		let updated: AutomationRun | undefined;
		await this.mutate(() => {
			const run = this.state.runs.find((candidate) => candidate.id === runId);
			if (!run) return;
			Object.assign(run, patch);
			if (event) {
				run.events = appendRunEvent(run.events, event.type, event.at ?? Date.now(), event.message);
			}
			run.updatedAt = patch.updatedAt ?? event?.at ?? Date.now();
			updated = cloneSerializable(run);
		}, false);
		return updated;
	}

	async flush(): Promise<void> {
		await this.saveQueue;
	}

	private async mutate(mutator: () => void, alwaysNotify = true): Promise<void> {
		const beforeRevision = this.state.revision;
		mutator();
		// Callers can use alwaysNotify=false for idempotent operations. Detecting a
		// deep mutation is deliberately avoided; they leave revision unchanged when no-op.
		if (!alwaysNotify && beforeRevision === this.state.revision) {
			// Mutation functions do not touch revision directly. For no-op-aware callers,
			// cheaply compare the serialized business state before deciding is impossible
			// after mutation, so they should simply tolerate an extra revision/persist.
		}
		this.state.revision += 1;
		await this.persist();
		this.emitChanged();
	}

	private persist(): Promise<void> {
		const snapshot = JSON.stringify(this.state, null, 2);
		this.saveQueue = this.saveQueue
			.catch(() => undefined)
			.then(async () => {
				await mkdir(dirname(this.filePath), { recursive: true });
				await writeFile(this.filePath, snapshot, "utf8");
			});
		return this.saveQueue;
	}

	private emitChanged(): void {
		const event = { revision: this.state.revision };
		for (const listener of this.listeners) listener(event);
	}
}

function createEmptyState(): PersistedAutomationState {
	return {
		version: SCHEMA_VERSION,
		revision: 0,
		settings: { ...DEFAULT_AUTOMATION_SETTINGS },
		tasks: [],
		runs: [],
	};
}

function normalizePersistedState(value: unknown): { state: PersistedAutomationState; changed: boolean } {
	if (!isRecord(value)) return { state: createEmptyState(), changed: true };
	const tasks = Array.isArray(value.tasks)
		? value.tasks.map(normalizePersistedTask).filter((task): task is AutomationTask => task !== undefined)
		: [];
	const runs = Array.isArray(value.runs)
		? value.runs.map(normalizePersistedRun).filter((run): run is AutomationRun => run !== undefined)
		: [];
	const state: PersistedAutomationState = {
		version: SCHEMA_VERSION,
		revision: finiteInteger(value.revision, 0, 0),
		settings: normalizeSettings(value.settings),
		tasks,
		runs,
	};
	const changed = value.version !== SCHEMA_VERSION
		|| tasks.length !== (Array.isArray(value.tasks) ? value.tasks.length : 0)
		|| runs.length !== (Array.isArray(value.runs) ? value.runs.length : 0);
	return { state, changed };
}

function normalizePersistedTask(value: unknown): AutomationTask | undefined {
	if (!isRecord(value) || typeof value.id !== "string") return undefined;
	try {
		const createdAt = finiteNumber(value.createdAt, Date.now(), 0);
		const normalized = normalizeTaskInput({
			name: value.name,
			projectId: value.projectId,
			prompt: value.prompt,
			schedule: value.schedule,
			enabled: value.enabled,
			backend: value.backend,
			model: value.model,
			thinkingLevel: value.thinkingLevel,
			mode: value.mode,
			permissionPreset: value.permissionPreset,
			budget: value.budget,
		}, createdAt);
		return {
			id: value.id,
			...normalized,
			createdAt,
			updatedAt: finiteNumber(value.updatedAt, createdAt, 0),
			...(typeof value.lastScheduledAt === "number" && Number.isFinite(value.lastScheduledAt)
				? { lastScheduledAt: value.lastScheduledAt }
				: {}),
		};
	} catch {
		return undefined;
	}
}

function normalizePersistedRun(value: unknown): AutomationRun | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.id !== "string" || typeof value.taskId !== "string"
		|| typeof value.taskName !== "string" || typeof value.projectId !== "string") return undefined;
	if (!isRunStatus(value.status) || !isRunTrigger(value.trigger)) return undefined;
	const queuedAt = finiteNumber(value.queuedAt, Date.now(), 0);
	const updatedAt = finiteNumber(value.updatedAt, queuedAt, 0);
	return {
		id: value.id,
		taskId: value.taskId,
		taskName: value.taskName,
		projectId: value.projectId,
		trigger: value.trigger,
		status: value.status,
		...(finiteOptional(value.scheduledFor) === undefined ? {} : { scheduledFor: finiteOptional(value.scheduledFor) }),
		...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
		...(typeof value.agentId === "string" ? { agentId: value.agentId } : {}),
		...(finiteOptional(value.runtimeGeneration) === undefined ? {} : { runtimeGeneration: finiteOptional(value.runtimeGeneration) }),
		queuedAt,
		...(finiteOptional(value.startedAt) === undefined ? {} : { startedAt: finiteOptional(value.startedAt) }),
		...(finiteOptional(value.endedAt) === undefined ? {} : { endedAt: finiteOptional(value.endedAt) }),
		...(finiteOptional(value.durationMs) === undefined ? {} : { durationMs: finiteOptional(value.durationMs) }),
		updatedAt,
		inputTokens: finiteInteger(value.inputTokens, 0, 0),
		outputTokens: finiteInteger(value.outputTokens, 0, 0),
		costUsd: finiteNumber(value.costUsd, 0, 0),
		stepCount: finiteInteger(value.stepCount, 0, 0),
		...(finiteOptional(value.changedFiles) === undefined ? {} : { changedFiles: finiteInteger(value.changedFiles, 0, 0) }),
		...(typeof value.error === "string" ? { error: value.error } : {}),
		...(value.skippedReason === "task-already-running" || value.skippedReason === "task-disabled"
			? { skippedReason: value.skippedReason }
			: {}),
		...(value.budgetReason === "tokens" || value.budgetReason === "cost" || value.budgetReason === "steps"
			? { budgetReason: value.budgetReason }
			: {}),
		events: Array.isArray(value.events)
			? value.events.map(normalizeRunEvent).filter((event): event is AutomationRunEvent => event !== undefined).slice(-MAX_RUN_EVENTS)
			: [],
	};
}

function normalizeRunEvent(value: unknown): AutomationRunEvent | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || !isEventType(value.type)) return undefined;
	return {
		id: value.id,
		type: value.type,
		at: finiteNumber(value.at, Date.now(), 0),
		...(typeof value.message === "string" ? { message: value.message } : {}),
	};
}

function normalizeTaskInput(input: CreateAutomationTaskInput | Record<string, unknown>, now: number) {
	const name = requireTrimmedString(input.name, "Task name", 120);
	const projectId = requireTrimmedString(input.projectId, "Project", 200);
	const prompt = requireTrimmedString(input.prompt, "Prompt", 100_000);
	const schedule = normalizeSchedule(input.schedule);
	const backend = input.backend === "dsh" ? "dsh" as const : input.backend === "pi" ? "pi" as const : undefined;
	const model = normalizeModel(input.model);
	const thinkingLevel = optionalTrimmedString(input.thinkingLevel, 100);
	const permissionPreset = optionalTrimmedString(input.permissionPreset, 100);
	const mode = normalizeTaskMode(input.mode);
	return {
		name,
		projectId,
		prompt,
		schedule,
		enabled: input.enabled !== false,
		...(backend ? { backend } : {}),
		...(model ? { model } : {}),
		...(thinkingLevel ? { thinkingLevel } : {}),
		// 普通模式是缺省语义：不落盘 mode 键，旧数据与新建默认任务结构一致，
		// 也避免 automation.json 里出现一堆冗余的 "mode": "normal"。
		...(mode && mode !== "normal" ? { mode } : {}),
		...(permissionPreset ? { permissionPreset } : {}),
		budget: normalizeBudget(input.budget, now),
	};
}

/**
 * 归一化定时任务工作模式。
 * 只接受正常/计划/目标：imagegen 不适用（backend 已排除生图），非法值一律降级为
 * 「未设置」（调用方按普通模式解释），避免手工编辑 automation.json 注入未知模式后
 * 在 dispatch 时产出无法识别的隐藏标记。
 */
function normalizeTaskMode(value: unknown): AutomationTaskMode | undefined {
	if (value === "plan" || value === "goal" || value === "normal") return value;
	return undefined;
}

function normalizeSchedule(value: unknown): AutomationTask["schedule"] {
	if (!isRecord(value) || (value.type !== "cron" && value.type !== "manual")) {
		throw new Error("Automation schedule is invalid");
	}
	if (value.type === "manual") return { type: "manual" };
	const expression = requireTrimmedString(value.expression, "Cron expression", 200);
	parseAutomationCron(expression);
	return { type: "cron", expression };
}

function normalizeBudget(value: unknown, _now: number): AutomationBudget {
	const record = isRecord(value) ? value : {};
	const timeoutMs = boundedNumber(record.timeoutMs, DEFAULT_AUTOMATION_BUDGET.timeoutMs, 10_000, 7 * 24 * 60 * 60_000);
	const maxTokens = optionalBoundedNumber(record.maxTokens, 1, 100_000_000, DEFAULT_AUTOMATION_BUDGET.maxTokens);
	const maxCostUsd = optionalBoundedNumber(record.maxCostUsd, 0.000001, 1_000_000, DEFAULT_AUTOMATION_BUDGET.maxCostUsd);
	const maxSteps = optionalBoundedNumber(record.maxSteps, 1, 100_000, DEFAULT_AUTOMATION_BUDGET.maxSteps);
	return {
		timeoutMs,
		...(maxTokens === undefined ? {} : { maxTokens: Math.floor(maxTokens) }),
		...(maxCostUsd === undefined ? {} : { maxCostUsd }),
		...(maxSteps === undefined ? {} : { maxSteps: Math.floor(maxSteps) }),
	};
}

function normalizeSettings(value: unknown): AutomationSettings {
	const record = isRecord(value) ? value : {};
	return {
		maxConcurrentRuns: Math.floor(boundedNumber(record.maxConcurrentRuns, 1, 1, 8)),
		historyLimit: Math.floor(boundedNumber(record.historyLimit, 200, 20, 2_000)),
	};
}

function normalizeModel(value: unknown): AutomationTask["model"] | undefined {
	if (!isRecord(value)) return undefined;
	const provider = optionalTrimmedString(value.provider, 200);
	const modelId = optionalTrimmedString(value.modelId, 300);
	return provider && modelId ? { provider, modelId } : undefined;
}

function summarizeTask(task: AutomationTask, now: number): AutomationTaskSummary {
	if (!task.enabled || task.schedule.type !== "cron") return cloneSerializable(task);
	try {
		const next = nextAutomationCronOccurrence(task.schedule.expression, new Date(now));
		return { ...cloneSerializable(task), ...(next ? { nextRunAt: next.getTime() } : {}) };
	} catch {
		return cloneSerializable(task);
	}
}

function appendRunEvent(
	events: readonly AutomationRunEvent[],
	type: AutomationRunEventType,
	at: number,
	message?: string,
): AutomationRunEvent[] {
	return [...events, createRunEvent(type, at, message)].slice(-MAX_RUN_EVENTS);
}

function createRunEvent(type: AutomationRunEventType, at: number, message?: string): AutomationRunEvent {
	return { id: randomUUID(), type, at, ...(message ? { message } : {}) };
}

function statusToEventType(status: AutomationRunStatus): AutomationRunEventType {
	if (status === "budget-exhausted") return "budget-exhausted";
	if (status === "timed-out") return "timed-out";
	if (status === "interrupted") return "interrupted";
	if (status === "skipped") return "skipped";
	if (status === "aborted") return "aborted";
	if (status === "failed") return "failed";
	if (status === "succeeded") return "completed";
	if (status === "running") return "prompt-accepted";
	return status;
}

function isRunStatus(value: unknown): value is AutomationRunStatus {
	return value === "queued" || value === "starting" || value === "running"
		|| value === "succeeded" || value === "failed" || value === "aborted"
		|| value === "timed-out" || value === "budget-exhausted" || value === "skipped"
		|| value === "interrupted";
}

function isRunTrigger(value: unknown): value is AutomationRun["trigger"] {
	return value === "manual" || value === "schedule" || value === "catch-up";
}

function isEventType(value: unknown): value is AutomationRunEventType {
	return value === "queued" || value === "starting" || value === "session-created"
		|| value === "prompt-accepted" || value === "metrics" || value === "completed"
		|| value === "failed" || value === "aborted" || value === "skipped"
		|| value === "interrupted" || value === "budget-exhausted" || value === "timed-out";
}

function requireTrimmedString(value: unknown, label: string, maxLength: number): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
	const trimmed = value.trim();
	if (trimmed.length > maxLength) throw new Error(`${label} is too long`);
	return trimmed;
}

function optionalTrimmedString(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.min(max, Math.max(min, value))
		: fallback;
}

function optionalBoundedNumber(
	value: unknown,
	min: number,
	max: number,
	fallback: number | undefined,
): number | undefined {
	if (value === null) return undefined;
	if (value === undefined) return fallback;
	return typeof value === "number" && Number.isFinite(value)
		? Math.min(max, Math.max(min, value))
		: fallback;
}

function finiteNumber(value: unknown, fallback: number, min: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(min, value) : fallback;
}

function finiteInteger(value: unknown, fallback: number, min: number): number {
	return Math.floor(finiteNumber(value, fallback, min));
}

function finiteOptional(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneSerializable<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
