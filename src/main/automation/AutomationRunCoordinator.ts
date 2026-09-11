import { randomUUID } from "node:crypto";
import type {
	AutomationRun,
	AutomationRunStatus,
	AutomationTask,
	SessionRuntimeEvent,
	SessionRuntimeTarget,
} from "../../shared/types";
import { isAutomationRunTerminal } from "../../shared/types";
/**
 * 复用渲染层发送链路的模式标记构造函数，让「普通/计划/目标」的隐藏标记格式只有一份
 * 定义，避免主进程与渲染进程各写一套后悄悄漂移。
 *
 * 允许从 renderer 深层路径 import 的原因：该模块唯一的本地依赖已下沉到
 * `shared/expandedRefBlocks`（主进程本就可用），所以它不依赖任何 renderer 运行时。
 */
import { buildComposerPromptSubmission } from "../../renderer/src/composerBehavior";
import type { GitService } from "../git/GitService";
import type { AppLogger } from "../logging/AppLogger";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SessionCatalog } from "../sessions/SessionCatalog";
import type { SessionRuntimeCoordinator } from "../sessions/SessionRuntimeCoordinator";
import { compareQueuedAutomationRuns, hasActiveAutomationRun } from "./automationPolicy";
import type { AutomationStore } from "./AutomationStore";

const RUNTIME_METRIC_THROTTLE_MS = 1_000;

type ActiveRunTracker = {
	runId: string;
	taskId: string;
	projectId: string;
	timeoutMs: number;
	maxTokens?: number;
	maxCostUsd?: number;
	maxSteps?: number;
	target?: SessionRuntimeTarget;
	timeoutHandle?: NodeJS.Timeout;
	stepCount: number;
	/** 上次落库的步数，用于避免节流周期内重复写入相同值制造无效 revision */
	persistedStepCount: number;
	wasExecutingTool: boolean;
	lastMetricUpdate: number;
	completed: boolean;
	/**
	 * 完成收尾进行中（completeRun 已接管）：阻断 timeout/budget 竞态，
	 * 防止指标采集 await 期间被并发置为 timed-out/budget-exhausted。
	 */
	settling?: boolean;
	/**
	 * 回合确实开始过的证据（agent_start 边沿 isTurnActive=true 或工具调用边沿）。
	 * agents:state idle 只有在此标志置位后才允许判定为成功完成，
	 * 避免把 dispatch 前残留的空闲快照误判成「回合已结束」。
	 */
	turnStarted: boolean;
};

export type AutomationRunCoordinatorDeps = {
	store: AutomationStore;
	catalog: SessionCatalog;
	sessionRuntimeCoordinator: SessionRuntimeCoordinator;
	projectStore: ProjectStore;
	gitService?: GitService;
	logger?: AppLogger;
	notifyRunFinished?: (run: AutomationRun, task: AutomationTask) => void;
};

/**
 * Manages automation queue execution, creates fresh draft sessions in SessionCatalog,
 * dispatches prompts through SessionRuntimeCoordinator, enforces budgets, and audits runs.
 */
export class AutomationRunCoordinator {
	private readonly store: AutomationStore;
	private readonly catalog: SessionCatalog;
	private readonly sessionRuntimeCoordinator: SessionRuntimeCoordinator;
	private readonly projectStore: ProjectStore;
	private readonly gitService?: GitService;
	private readonly logger?: AppLogger;
	private readonly notifyRunFinished?: (run: AutomationRun, task: AutomationTask) => void;

	private activeTrackers = new Map<string, ActiveRunTracker>();
	/**
	 * 正在执行 finalizeRun 的 runId 集合：finalizeRun 内部有 await（git 统计/停 runtime/落库），
	 * 并发入口（completeRun vs abortRun/timeout）可能同时进入，用互斥集防止双重终态 + 双重通知。
	 */
	private readonly finalizing = new Set<string>();
	private draining = false;

	constructor(deps: AutomationRunCoordinatorDeps) {
		this.store = deps.store;
		this.catalog = deps.catalog;
		this.sessionRuntimeCoordinator = deps.sessionRuntimeCoordinator;
		this.projectStore = deps.projectStore;
		this.gitService = deps.gitService;
		this.logger = deps.logger;
		this.notifyRunFinished = deps.notifyRunFinished;
	}

	async enqueueRun(
		task: AutomationTask,
		scheduledFor?: number,
		trigger: AutomationRun["trigger"] = "schedule",
		now = Date.now(),
	): Promise<AutomationRun> {
		const runs = this.store.listRuns();
		if (hasActiveAutomationRun(runs, task.id)) {
			return this.store.createRun({
				task,
				trigger,
				scheduledFor,
				status: "skipped",
				skippedReason: "task-already-running",
				error: "Task already has an active run",
			}, now);
		}

		const run = await this.store.createRun({
			task,
			trigger,
			scheduledFor,
			status: "queued",
		}, now);

		void this.drainQueue();
		return run;
	}

	async runNow(taskId: string, now = Date.now()): Promise<AutomationRun> {
		const task = this.store.getTask(taskId);
		if (!task) throw new Error("Automation task not found");
		return this.enqueueRun(task, undefined, "manual", now);
	}

	async abortRun(runId: string, reason = "Manual abort"): Promise<boolean> {
		const run = this.store.getRun(runId);
		if (!run || isAutomationRunTerminal(run.status)) return false;

		const tracker = this.activeTrackers.get(runId);
		if (tracker?.timeoutHandle) clearTimeout(tracker.timeoutHandle);

		if (tracker?.target) {
			try {
				await this.sessionRuntimeCoordinator.abortRuntime(tracker.target);
			} catch (err) {
				void this.logger?.warn("automation", "Failed to abort runtime target", {
					runId,
					target: tracker.target,
					error: String(err),
				});
			}
		}

		await this.finalizeRun(runId, "aborted", reason, { at: Date.now() });
		return true;
	}

	observeRuntimeEvent(event: SessionRuntimeEvent): void {
		if (this.activeTrackers.size === 0) return;

		for (const [runId, tracker] of this.activeTrackers.entries()) {
			if (tracker.target && tracker.target.sessionId === event.sessionId) {
				this.handleTrackerEvent(runId, tracker, event);
				break;
			}
		}
	}

	async drainQueue(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			const snapshot = this.store.getSnapshot();
			const maxConcurrent = snapshot.settings.maxConcurrentRuns;
			const runningCount = Array.from(this.activeTrackers.values()).length;
			const availableSlots = Math.max(0, maxConcurrent - runningCount);
			if (availableSlots <= 0) return;

			const queuedRuns = snapshot.runs
				.filter((r) => r.status === "queued")
				.sort(compareQueuedAutomationRuns);

			for (const run of queuedRuns) {
				if (this.activeTrackers.size >= maxConcurrent) break;
				// Single-flight check: ensure no other run for this task is running
				const isTaskRunning = Array.from(this.activeTrackers.values()).some((t) => t.taskId === run.taskId);
				if (isTaskRunning) continue;

				const task = this.store.getTask(run.taskId);
				if (!task) {
					await this.finalizeRun(run.id, "failed", "Task definition was deleted", { at: Date.now() });
					continue;
				}

				if (!task.enabled && run.trigger !== "manual") {
					await this.finalizeRun(run.id, "skipped", "Task is disabled", {
						at: Date.now(),
						skippedReason: "task-disabled",
					});
					continue;
				}

				void this.executeRun(run, task);
			}
		} finally {
			this.draining = false;
		}
	}

	dispose(): void {
		for (const tracker of this.activeTrackers.values()) {
			if (tracker.timeoutHandle) clearTimeout(tracker.timeoutHandle);
		}
		this.activeTrackers.clear();
	}

	private async executeRun(run: AutomationRun, task: AutomationTask): Promise<void> {
		const runId = run.id;
		const now = Date.now();
		const tracker: ActiveRunTracker = {
			runId,
			taskId: task.id,
			projectId: task.projectId,
			timeoutMs: task.budget.timeoutMs,
			maxTokens: task.budget.maxTokens,
			maxCostUsd: task.budget.maxCostUsd,
			maxSteps: task.budget.maxSteps,
			stepCount: 0,
			persistedStepCount: 0,
			wasExecutingTool: false,
			lastMetricUpdate: now,
			completed: false,
			turnStarted: false,
		};
		this.activeTrackers.set(runId, tracker);

		await this.store.updateRun(runId, {
			status: "starting",
			startedAt: now,
			updatedAt: now,
		}, { type: "starting", at: now });

		const project = this.projectStore.get(task.projectId);
		if (!project) {
			await this.finalizeRun(runId, "failed", "Project not found", { at: Date.now() });
			return;
		}

		const dateLabel = new Date(now).toLocaleString("zh-CN", { hour12: false });
		const title = `[定时] ${task.name} (${dateLabel})`;
		const environment = project.environment === "wsl" ? "wsl" : "native";

		let sessionDraft: import("../../shared/types").SessionRecord;
		try {
			sessionDraft = await this.catalog.createDraft({
				projectId: project.id,
				title,
				environment,
				source: "pi",
				backend: task.backend ?? "pi",
				model: task.model,
				thinkingLevel: task.thinkingLevel,
				permissionPreset: task.permissionPreset,
			});
		} catch (err) {
			await this.finalizeRun(runId, "failed", `Failed to create session: ${err instanceof Error ? err.message : String(err)}`, { at: Date.now() });
			return;
		}

		const sessionId = sessionDraft.id;
		await this.store.updateRun(runId, {
			sessionId,
			updatedAt: Date.now(),
		}, { type: "session-created", message: `Session ${sessionId} created`, at: Date.now() });

		// Setup timeout watch
		tracker.timeoutHandle = setTimeout(() => {
			void this.handleTimeout(runId);
		}, tracker.timeoutMs);
		if (typeof tracker.timeoutHandle.unref === "function") {
			tracker.timeoutHandle.unref();
		}

		const requestId = randomUUID();
		try {
			// message 是用户可见原文（会话气泡），agentMessage 是实际发给 pi 的载荷。
			// AgentManager.sendPrompt 里 agentMessage 非空时会**整体替换** message，
			// 所以宿主指令必须与任务提示词拼接，不能只放指令——否则定时任务的提示词
			// 会被整个丢掉，AI 只看到任务名和一句「请自主完成」而无从下手。
			// 与飞书（FeishuBridge）和 index.ts 的 agentInstruction 拼接写法保持一致。
			const agentInstruction = `[Automation: ${task.name}] Please complete this task autonomously without waiting for follow-up inputs.`;

			// 工作模式复用渲染层发送链路的同一个纯函数，产出 plan/goal 的隐藏标记，
			// 不在主进程复刻第二套标记格式（标记由 pi-deck-plan-mode / pi-deck-goal-mode
			// 内置扩展在 pi 的 input 事件里识别）。normal 时该函数原样返回 message。
			const mode = task.mode ?? "normal";
			const submission = buildComposerPromptSubmission(task.prompt, mode);
			// DSH 显式拒绝 agentMessage（DshAgentManager.sendPrompt →
			// session.sendDshUnsupportedPayload），且宿主指令/模式标记都是 pi 扩展，
			// DSH 无等价物——DSH 任务直接发任务提示词原文（时间线即所见）。
			const isDsh = task.backend === "dsh";

			const result = await this.sessionRuntimeCoordinator.send({
				sessionId,
				requestId,
				message: task.prompt,
				description: `Automation: ${task.name}`,
				// 顺序即优先级：宿主指令置顶（模式标记不能在首行，否则被指令挡住），
				// 其次是对应模式的隐藏载荷，最后是任务提示词原文。
				...(isDsh ? {} : {
					agentMessage: `${agentInstruction}\n\n${submission.agentMessage ?? submission.message}`,
				}),
			});

			if (!result.accepted) {
				await this.finalizeRun(runId, "failed", result.error || "Prompt dispatch rejected", { at: Date.now() });
				return;
			}

			if (result.agentId && result.runtimeGeneration !== undefined) {
				tracker.target = {
					sessionId,
					agentId: result.agentId,
					runtimeGeneration: result.runtimeGeneration,
				};
				await this.store.updateRun(runId, {
					status: "running",
					agentId: result.agentId,
					runtimeGeneration: result.runtimeGeneration,
					updatedAt: Date.now(),
				}, { type: "prompt-accepted", at: Date.now() });
			} else {
				// Query target if omitted from result
				const target = this.sessionRuntimeCoordinator.getTarget(sessionId);
				if (target) {
					tracker.target = target;
					await this.store.updateRun(runId, {
						status: "running",
						agentId: target.agentId,
						runtimeGeneration: target.runtimeGeneration,
						updatedAt: Date.now(),
					}, { type: "prompt-accepted", at: Date.now() });
				}
			}
		} catch (err) {
			await this.finalizeRun(runId, "failed", err instanceof Error ? err.message : String(err), { at: Date.now() });
		}
	}

	/**
	 * Run 事件状态机（终态判定契约）。
	 *
	 * 为什么不能用 isTurnActive 缺失/false 判定完成：agents:runtime-state 事件大多是
	 * 「局部补丁」——emitStreamingStatePatch（消息 flush 时 50ms 节流）与工具边沿事件
	 * 只带 isStreaming/isExecutingTool，不带 isTurnActive；若把缺失字段当作 false，
	 * run 会在首个流式补丁/首个工具结束时被误判为「回合已结束」→ 立即 finalize(succeeded)
	 * 并 stopRuntime 杀掉 pi 进程，会话文件来不及落盘（表现为历史会话打开空白、0 token）。
	 *
	 * 因此终态只信 agents:state（AgentTab 快照，emitState 在 agent_settled/error/退出时发出）：
	 *   idle    → 回合真正完成（settled 是 pi 的最终稳定点，无重试/压缩排队）→ succeeded
	 *   error   → 回合出错（agent_end 带 error 时 tab.status 置 error）→ failed
	 *   closed  → pi 进程在回合结束前退出 → failed（防止 run 挂到 timeoutMs）
	 *   running → 回合开始证据（turnStarted）。DSH 控制态只有 idle/running 两值
	 *             （dshRuntimeControl：turn/start → running），applyControl 在状态变化时
	 *             必发 agents:state 快照；pi 只在 agent_settled/error/退出时发快照，
	 *             收到 running 快照同样说明回合已开始。DSH 纯对话回合没有工具边沿、
	 *             runtime-state 也没有 isTurnActive，只能靠 running 快照确认「回合开始过」
	 *             ——否则 dispatch 后残留的 idle 快照会把 run 误判成完成。
	 * runtime-state 只用于 turnStarted 记账、工具步数、预算校验与指标采集。
	 */
	private handleTrackerEvent(runId: string, tracker: ActiveRunTracker, event: SessionRuntimeEvent): void {
		if (tracker.completed || tracker.settling) return;
		const now = Date.now();
		const channel = typeof event.sourceChannel === "string" ? event.sourceChannel : "";
		const payload = isRecord(event.payload) ? event.payload : undefined;
		if (!channel || !payload) return;

		// agents:state（AgentTab 快照）：emitState 发的是全量 tab 列表，
		// 桥接层已拆成单 tab 事件转发到这里；这是终态判定的唯一依据。
		if (channel.includes("state") && !channel.includes("runtime-state")) {
			const status = payload.status;
			if (status === "error") {
				const errorMsg = typeof payload.error === "string" ? payload.error : "Runtime error";
				void this.completeRun(runId, "failed", errorMsg);
				return;
			}
			if (status === "closed") {
				void this.completeRun(runId, "failed", "Runtime process exited before the run finished");
				return;
			}
			if (status === "running") {
				// DSH 回合开始证据：applyControl 在 idle→running 状态变化时必发快照
				// （turn/start 触发）；pi 侧若发出 running 快照同样说明回合已开始（无害）。
				// 不能放在 idle 分支兜底——DSH 没有其他 turnStarted 来源。
				tracker.turnStarted = true;
				return;
			}
			if (status === "idle" && tracker.turnStarted) {
				// 必须确认回合真的开始过：否则 dispatch 前残留的空闲快照会被误判成完成。
				// willRetry/自动压缩期间 status 保持 running，不会走到这里。
				void this.completeRun(runId, "succeeded");
				return;
			}
			return;
		}

		// agents:runtime-state：局部补丁与完整快照混合，只做记账，不做终态判定。
		if (!channel.includes("runtime-state")) return;
		const state = isRecord(payload.state) ? payload.state : undefined;
		if (!state) return;
		const isExecutingTool = state.isExecutingTool === true;

		// 工具步数在 false → true 边沿 +1；工具调用只发生在回合内，
		// 因此它同时是「回合确实开始」的证据（agent_start 边沿丢失时的兜底）。
		if (!tracker.wasExecutingTool && isExecutingTool) {
			tracker.stepCount += 1;
			tracker.turnStarted = true;
		}
		tracker.wasExecutingTool = isExecutingTool;

		// isTurnActive 只有显式 boolean 才可信（见方法注释）；true 记回合开始，
		// false 仅作状态记录——绝不作为完成信号。
		if (typeof state.isTurnActive === "boolean" && state.isTurnActive) {
			tracker.turnStarted = true;
		}

		// 指标只在补丁带值时采集：流式补丁不含 token/cost 字段，
		// 若按 0 兜底会把完整快照写入的真实值反复清零（历史 bug：run 记录恒为 0 token）。
		const inputTokens = typeof state.inputTokens === "number" ? state.inputTokens : undefined;
		const outputTokens = typeof state.outputTokens === "number" ? state.outputTokens : undefined;
		const costUsd = typeof state.cost === "number" ? state.cost : undefined;

		// 预算校验：仅在有真实值时评估，避免 0 值误触发。
		const totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0);
		if (tracker.maxTokens && inputTokens !== undefined && outputTokens !== undefined && totalTokens >= tracker.maxTokens) {
			void this.handleBudgetExhausted(runId, "tokens", `Exceeded token budget (${totalTokens} >= ${tracker.maxTokens})`);
			return;
		}
		if (tracker.maxCostUsd && costUsd !== undefined && costUsd >= tracker.maxCostUsd) {
			void this.handleBudgetExhausted(runId, "cost", `Exceeded cost budget ($${costUsd} >= $${tracker.maxCostUsd})`);
			return;
		}
		if (tracker.maxSteps && tracker.stepCount >= tracker.maxSteps) {
			void this.handleBudgetExhausted(runId, "steps", `Exceeded tool step budget (${tracker.stepCount} >= ${tracker.maxSteps})`);
			return;
		}

		// 节流落库：只写补丁实际携带的字段 + 步数变化，避免空补丁每秒制造无效 revision 刷屏渲染层。
		const stepChanged = tracker.stepCount !== tracker.persistedStepCount;
		const hasMetrics = inputTokens !== undefined || outputTokens !== undefined || costUsd !== undefined;
		if (now - tracker.lastMetricUpdate >= RUNTIME_METRIC_THROTTLE_MS && (hasMetrics || stepChanged)) {
			tracker.lastMetricUpdate = now;
			tracker.persistedStepCount = tracker.stepCount;
			void this.store.updateRun(runId, {
				...(inputTokens !== undefined ? { inputTokens } : {}),
				...(outputTokens !== undefined ? { outputTokens } : {}),
				...(costUsd !== undefined ? { costUsd } : {}),
				stepCount: tracker.stepCount,
				updatedAt: now,
			});
		}
	}

	/**
	 * 终态收尾：先置 settling 阻断 timeout/budget/重复事件竞态，再尽力补采最终指标
	 * （终态边沿事件只带 isTurnActive，token/cost 需从完整 runtime state 读取），最后 finalize。
	 */
	private async completeRun(runId: string, status: "succeeded" | "failed", error?: string): Promise<void> {
		const tracker = this.activeTrackers.get(runId);
		if (!tracker || tracker.completed || tracker.settling) return;
		tracker.settling = true;

		try {
			let inputTokens: number | undefined;
			let outputTokens: number | undefined;
			let costUsd: number | undefined;
			if (tracker.target) {
				try {
					const result = await this.sessionRuntimeCoordinator.getRuntimeState(tracker.target);
					if (result.ok) {
						const state = result.value.value;
						inputTokens = state.inputTokens;
						outputTokens = state.outputTokens;
						costUsd = state.cost;
					}
				} catch {
					// 指标采集失败不阻塞收尾，沿用节流期间已落库的值
				}
			}

			await this.finalizeRun(runId, status, error, {
				at: Date.now(),
				inputTokens,
				outputTokens,
				costUsd,
				stepCount: tracker.stepCount,
			});
		} catch {
			// 收尾链路异常不允许抛成 unhandled rejection；
			// 若 finalizeRun 未完成，timeoutHandle 仍在走，超时兜底会接管
		}
	}

	private async handleTimeout(runId: string): Promise<void> {
		const tracker = this.activeTrackers.get(runId);
		// settling：completeRun 正在收尾（终态已定），不能被 timeout 抢杀成 timed-out
		if (!tracker || tracker.completed || tracker.settling) return;
		if (tracker.target) {
			try {
				await this.sessionRuntimeCoordinator.abortRuntime(tracker.target);
			} catch {
				// Ignore abort errors on timeout
			}
		}
		await this.finalizeRun(runId, "timed-out", `Execution timed out after ${tracker.timeoutMs}ms`, { at: Date.now() });
	}

	private async handleBudgetExhausted(runId: string, reason: "tokens" | "cost" | "steps", message: string): Promise<void> {
		const tracker = this.activeTrackers.get(runId);
		if (!tracker || tracker.completed || tracker.settling) return;
		if (tracker.target) {
			try {
				await this.sessionRuntimeCoordinator.abortRuntime(tracker.target);
			} catch {
				// Ignore abort errors
			}
		}
		await this.finalizeRun(runId, "budget-exhausted", message, {
			at: Date.now(),
			budgetReason: reason,
		});
	}

	private async finalizeRun(
		runId: string,
		status: AutomationRunStatus,
		error?: string,
		extra?: {
			at?: number;
			budgetReason?: "tokens" | "cost" | "steps";
			skippedReason?: "task-already-running" | "task-disabled";
			inputTokens?: number;
			outputTokens?: number;
			costUsd?: number;
			stepCount?: number;
		},
	): Promise<void> {
		// 并发终态互斥：finalizeRun 内部有多个 await，两个入口同时进入会双重落库 + 双重通知
		if (this.finalizing.has(runId)) return;
		this.finalizing.add(runId);
		const tracker = this.activeTrackers.get(runId);
		if (tracker) {
			tracker.completed = true;
			if (tracker.timeoutHandle) clearTimeout(tracker.timeoutHandle);
			this.activeTrackers.delete(runId);
		}

		const run = this.store.getRun(runId);
		const endedAt = extra?.at ?? Date.now();
		const durationMs = run?.startedAt ? Math.max(0, endedAt - run.startedAt) : undefined;

		try {
			let changedFiles: number | undefined;
			if (tracker && this.gitService) {
				const project = this.projectStore.get(tracker.projectId);
				if (project) {
					try {
						const statusRes = await this.gitService.getStatus(project.path);
						changedFiles = statusRes.workingTree.length + statusRes.untracked.length + statusRes.merge.length + statusRes.index.length;
					} catch {
						// Ignore non-git or inaccessible project directories
					}
				}
			}

			// 成功完成后停掉该会话的 runtime 释放 pi 子进程；失败时保留现场，便于用户打开会话排查
			if (tracker?.target && status === "succeeded") {
				try {
					await this.sessionRuntimeCoordinator.stopRuntime(tracker.target);
				} catch {
					// Non-fatal if runtime stop fails
				}
			}

			const updatedRun = await this.store.updateRun(runId, {
				status,
				endedAt,
				durationMs,
				updatedAt: endedAt,
				...(error ? { error } : {}),
				...(extra?.budgetReason ? { budgetReason: extra.budgetReason } : {}),
				...(extra?.skippedReason ? { skippedReason: extra.skippedReason } : {}),
				...(extra?.inputTokens !== undefined ? { inputTokens: extra.inputTokens } : {}),
				...(extra?.outputTokens !== undefined ? { outputTokens: extra.outputTokens } : {}),
				...(extra?.costUsd !== undefined ? { costUsd: extra.costUsd } : {}),
				...(extra?.stepCount !== undefined ? { stepCount: extra.stepCount } : {}),
				...(changedFiles !== undefined ? { changedFiles } : {}),
			}, {
				type: statusToEventType(status),
				at: endedAt,
				message: error || (status === "succeeded" ? "Run completed successfully" : undefined),
			});

			// Trigger desktop notification when configured
			if (this.notifyRunFinished && updatedRun) {
				const task = this.store.getTask(updatedRun.taskId);
				if (task) {
					try {
						this.notifyRunFinished(updatedRun, task);
					} catch {
						// Ignore notification errors
					}
				}
			}
		} finally {
			// 无论成败都要释放互斥锁，否则同一 runId 的后续终态会被永久阻塞
			this.finalizing.delete(runId);
		}

		void this.drainQueue();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statusToEventType(status: AutomationRunStatus): import("../../shared/types").AutomationRunEventType {
	if (status === "budget-exhausted") return "budget-exhausted";
	if (status === "timed-out") return "timed-out";
	if (status === "interrupted") return "interrupted";
	if (status === "skipped") return "skipped";
	if (status === "aborted") return "aborted";
	if (status === "failed") return "failed";
	if (status === "succeeded") return "completed";
	return "completed";
}
