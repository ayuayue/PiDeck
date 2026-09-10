import type { AgentBackend, ComposerAgentMode } from "./agent";

/**
 * 定时任务可配置的工作模式。
 *
 * 只开放 composer 三态里的普通/计划/目标：imagegen 是独立后端（无 LLM 回合概念，
 * 且 AutomationTask.backend 已排除 imagegen），计划/目标靠 PiDeck 内置扩展在 pi 的
 * input 事件里识别隐藏标记，因此这两个模式要求 pi 后端 + 对应扩展已启用。
 */
export type AutomationTaskMode = Extract<ComposerAgentMode, "normal" | "plan" | "goal">;

/** P0 scheduler supports local-time five-field cron plus explicitly manual tasks. */
export type AutomationSchedule =
	| { type: "cron"; expression: string }
	| { type: "manual" };

export type AutomationRunTrigger = "manual" | "schedule" | "catch-up";

export type AutomationRunStatus =
	| "queued"
	| "starting"
	| "running"
	| "succeeded"
	| "failed"
	| "aborted"
	| "timed-out"
	| "budget-exhausted"
	| "skipped"
	| "interrupted";

export type AutomationBudget = {
	/** Hard wall-clock limit for one agent turn. */
	timeoutMs: number;
	/** Cumulative input + output token limit reported by the runtime. */
	maxTokens?: number;
	/** Cumulative provider cost limit reported by the runtime. */
	maxCostUsd?: number;
	/** Number of tool-execution start edges allowed in one run. */
	maxSteps?: number;
};

export type AutomationTask = {
	id: string;
	name: string;
	projectId: string;
	prompt: string;
	schedule: AutomationSchedule;
	enabled: boolean;
	/** imagegen is intentionally excluded: scheduled runs must use a conversational runtime. */
	backend?: Exclude<AgentBackend, "imagegen">;
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
	/**
	 * 工作模式。缺省/未设置等价 "normal"（与旧数据兼容）。
	 * plan 先只读分析出计划；goal 围绕提示词自动连续推进到完成/阻塞。
	 */
	mode?: AutomationTaskMode;
	/** DSH-only permission preset; pi ignores this field through the existing session contract. */
	permissionPreset?: string;
	budget: AutomationBudget;
	createdAt: number;
	updatedAt: number;
	/** Last cron occurrence acknowledged by the scheduler, including skipped overlaps. */
	lastScheduledAt?: number;
};

/** Renderer-facing task with a local-time next occurrence computed at read time. */
export type AutomationTaskSummary = AutomationTask & {
	nextRunAt?: number;
};

export type AutomationRunEventType =
	| "queued"
	| "starting"
	| "session-created"
	| "prompt-accepted"
	| "metrics"
	| "completed"
	| "failed"
	| "aborted"
	| "skipped"
	| "interrupted"
	| "budget-exhausted"
	| "timed-out";

export type AutomationRunEvent = {
	id: string;
	type: AutomationRunEventType;
	at: number;
	message?: string;
};

export type AutomationRun = {
	id: string;
	taskId: string;
	/** Snapshot fields keep run history meaningful after a task is renamed or deleted. */
	taskName: string;
	projectId: string;
	trigger: AutomationRunTrigger;
	status: AutomationRunStatus;
	scheduledFor?: number;
	sessionId?: string;
	agentId?: string;
	runtimeGeneration?: number;
	queuedAt: number;
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	updatedAt: number;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	stepCount: number;
	changedFiles?: number;
	error?: string;
	skippedReason?: "task-already-running" | "task-disabled";
	budgetReason?: "tokens" | "cost" | "steps";
	events: AutomationRunEvent[];
};

export type AutomationSettings = {
	/** Global run concurrency; task overlap is independently prevented. */
	maxConcurrentRuns: number;
	/** Persisted history cap. Old terminal runs are trimmed first. */
	historyLimit: number;
};

export type AutomationSnapshot = {
	revision: number;
	settings: AutomationSettings;
	tasks: AutomationTaskSummary[];
	runs: AutomationRun[];
};

export type CreateAutomationTaskInput = {
	name: string;
	projectId: string;
	prompt: string;
	schedule: AutomationSchedule;
	enabled?: boolean;
	backend?: Exclude<AgentBackend, "imagegen">;
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
	/** 工作模式，缺省普通模式；见 AutomationTaskMode。 */
	mode?: AutomationTaskMode;
	permissionPreset?: string;
	budget?: Partial<AutomationBudget>;
};

export type UpdateAutomationTaskInput = Partial<CreateAutomationTaskInput>;
export type UpdateAutomationSettingsInput = Partial<AutomationSettings>;

export type AutomationCronPreview =
	| { valid: true; nextRuns: number[] }
	| { valid: false; error: string };

export type AutomationChangedEvent = {
	revision: number;
};

export function isAutomationRunTerminal(status: AutomationRunStatus): boolean {
	return status !== "queued" && status !== "starting" && status !== "running";
}
