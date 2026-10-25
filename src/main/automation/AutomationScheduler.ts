import type { AutomationTask } from "../../shared/types";
import { missedAutomationCronOccurrences, nextAutomationCronOccurrence } from "./automationCron";
import { hasActiveAutomationRun } from "./automationPolicy";
import type { AutomationStore } from "./AutomationStore";
import { getAppLogger } from "../logging/sharedLogger";

const TICK_INTERVAL_MS = 1_000;
// Catch-up window: check missed runs if PiDeck was offline for at most 7 days.
const MAX_CATCH_UP_WINDOW_MS = 7 * 24 * 60 * 60_000;

export type AutomationSchedulerTriggerHandler = (task: AutomationTask, scheduledFor: number, trigger: "schedule" | "catch-up") => Promise<void>;

/**
 * Evaluates cron tasks every second, aligns with local minute boundaries, and dispatches
 * due occurrences. Overlapping runs for the same task are skipped and recorded to advance
 * the scheduling window without starving the scheduler.
 */
export class AutomationScheduler {
	private timer: NodeJS.Timeout | null = null;
	private ticking = false;
	private onTrigger: AutomationSchedulerTriggerHandler | null = null;

	constructor(private readonly store: AutomationStore) {}

	setTriggerHandler(handler: AutomationSchedulerTriggerHandler): void {
		this.onTrigger = handler;
	}

	start(now = Date.now()): void {
		if (this.timer) return;
		// Run initial tick asynchronously to process catch-up after startup
		queueMicrotask(() => {
			void this.tick(now);
		});
		this.timer = setInterval(() => {
			void this.tick(Date.now());
		}, TICK_INTERVAL_MS);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/** Public for deterministic unit testing. */
	async tick(now = Date.now()): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			const tasks = this.store.listTasks();
			const runs = this.store.listRuns();
			for (const task of tasks) {
				if (!task.enabled || task.schedule.type !== "cron") continue;
				await this.evaluateTask(task, runs, now);
			}
		} catch (error) {
			// 单个任务求值失败（如 cron 表达式损坏）不得炸掉调度器：记日志后等下个 tick 重试，
			// 否则 void tick() 会变成每分钟一次的 unhandledRejection 噪音。
			const logger = getAppLogger();
			void logger?.error("automation", "Scheduler tick failed", {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
		} finally {
			this.ticking = false;
		}
	}

	private async evaluateTask(task: AutomationTask, runs: readonly import("../../shared/types").AutomationRun[], now: number): Promise<void> {
		if (task.schedule.type !== "cron") return;

		const lastScheduled = task.lastScheduledAt ?? task.createdAt;
		// Only check if at least one minute has passed since last schedule
		if (now - lastScheduled > MAX_CATCH_UP_WINDOW_MS) {
			// Beyond maximum catch-up window, reset baseline to now to avoid huge backfill
			await this.store.acknowledgeSchedule(task.id, now);
			return;
		}

		// Find missed occurrences between lastScheduled and now
		const missed = missedAutomationCronOccurrences(
			task.schedule.expression,
			new Date(lastScheduled),
			new Date(now),
			1, // Latest-only catch-up policy
		);

		if (missed.length === 0) return;

		const scheduledOccurrence = missed[0];
		const scheduledTime = scheduledOccurrence.getTime();
		const isCatchUp = now - scheduledTime >= 60_000;
		const triggerType = isCatchUp ? "catch-up" : "schedule";

		// Advance lastScheduledAt immediately so subsequent ticks don't re-discover this occurrence
		await this.store.acknowledgeSchedule(task.id, scheduledTime);

		// Single-flight check: if an active run already exists for this task, skip this occurrence
		if (hasActiveAutomationRun(runs, task.id)) {
			getAppLogger()?.info("automation", "Scheduled run skipped (previous run still active)", { taskId: task.id, triggerType, scheduledTime });
			await this.store.createRun(
				{
					task,
					trigger: triggerType,
					scheduledFor: scheduledTime,
					status: "skipped",
					skippedReason: "task-already-running",
					error: "Skipped: previous run of this task is still active",
				},
				now,
			);
			return;
		}

		if (this.onTrigger) {
			// 无人值守自动触发会自起 agent 会话，必须留痕（手动触发已由 automationIpc 记录）
			getAppLogger()?.info("automation", "Scheduled run triggered", { taskId: task.id, triggerType, scheduledTime });
			try {
				await this.onTrigger(task, scheduledTime, triggerType);
			} catch (err) {
				getAppLogger()?.error("automation", "Scheduled run trigger failed", { taskId: task.id, error: err instanceof Error ? err.message : String(err) });
				// Failed to enqueue or start
				await this.store.createRun(
					{
						task,
						trigger: triggerType,
						scheduledFor: scheduledTime,
						status: "failed",
						error: err instanceof Error ? err.message : String(err),
					},
					now,
				);
			}
		}
	}
}
