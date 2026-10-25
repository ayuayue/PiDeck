import type { AutomationRun, AutomationRunStatus } from "../../shared/types";
import { isAutomationRunTerminal } from "../../shared/types";

export const AUTOMATION_ACTIVE_STATUSES: ReadonlySet<AutomationRunStatus> = new Set(["queued", "starting", "running"]);

/** A task is single-flight even when global concurrency is greater than one. */
export function hasActiveAutomationRun(runs: readonly AutomationRun[], taskId: string): boolean {
	return runs.some((run) => run.taskId === taskId && !isAutomationRunTerminal(run.status));
}

/** Queue ordering is deterministic: scheduled time first, then persisted creation order. */
export function compareQueuedAutomationRuns(left: AutomationRun, right: AutomationRun): number {
	return (left.scheduledFor ?? left.queuedAt) - (right.scheduledFor ?? right.queuedAt) || left.queuedAt - right.queuedAt || left.id.localeCompare(right.id);
}

/** Keep all active runs, then newest terminal history up to the configured cap. */
export function trimAutomationRunHistory(runs: readonly AutomationRun[], historyLimit: number): AutomationRun[] {
	const active = runs.filter((run) => !isAutomationRunTerminal(run.status));
	const terminal = runs
		.filter((run) => isAutomationRunTerminal(run.status))
		.sort((left, right) => right.updatedAt - left.updatedAt)
		.slice(0, Math.max(1, Math.floor(historyLimit)));
	return [...active, ...terminal].sort((left, right) => right.updatedAt - left.updatedAt);
}
