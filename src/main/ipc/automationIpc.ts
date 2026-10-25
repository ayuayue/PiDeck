import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { AutomationChangedEvent, AutomationCronPreview, AutomationRun, AutomationSettings, AutomationSnapshot, AutomationTask, CreateAutomationTaskInput, UpdateAutomationSettingsInput, UpdateAutomationTaskInput } from "../../shared/types";
import { parseAutomationCron, previewAutomationCron } from "../automation/automationCron";
import type { AutomationRunCoordinator } from "../automation/AutomationRunCoordinator";
import type { AutomationScheduler } from "../automation/AutomationScheduler";
import type { AutomationStore } from "../automation/AutomationStore";
import type { AppLogger } from "../logging/AppLogger";

export type AutomationIpcDeps = {
	automationStore: AutomationStore;
	automationScheduler: AutomationScheduler;
	automationRunCoordinator: AutomationRunCoordinator;
	appLogger: AppLogger;
	onNotifyChanged: (event: AutomationChangedEvent) => void;
};

/**
 * Registers automation IPC handlers under the automation:* domain.
 * Validates inputs at the process boundary and delegates state mutations to AutomationStore
 * or run execution to AutomationRunCoordinator.
 */
export function registerAutomationIpc(deps: AutomationIpcDeps): () => void {
	const { automationStore, automationScheduler, automationRunCoordinator, appLogger, onNotifyChanged } = deps;

	// Forward store change events to renderer windows via onNotifyChanged
	const unsubscribeStore = automationStore.onChanged((event) => {
		onNotifyChanged(event);
	});

	ipcMain.handle(ipcChannels.automationGetSnapshot, async (): Promise<AutomationSnapshot> => {
		return automationStore.getSnapshot();
	});

	ipcMain.handle(ipcChannels.automationCreateTask, async (_event, input: CreateAutomationTaskInput): Promise<AutomationTask> => {
		if (!input || typeof input !== "object") {
			throw new Error("Invalid automation task input");
		}
		try {
			const task = await automationStore.createTask(input);
			void appLogger.info("automation", "Created task", { taskId: task.id, name: task.name });
			// Evaluate scheduler immediately so any due task is scheduled
			void automationScheduler.tick();
			return task;
		} catch (err) {
			void appLogger.error("automation", "Failed to create task", {
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}
	});

	ipcMain.handle(ipcChannels.automationUpdateTask, async (_event, taskId: string, patch: UpdateAutomationTaskInput): Promise<AutomationTask> => {
		if (typeof taskId !== "string" || !taskId.trim()) {
			throw new Error("Valid task ID is required");
		}
		if (!patch || typeof patch !== "object") {
			throw new Error("Invalid automation task patch");
		}
		try {
			const task = await automationStore.updateTask(taskId.trim(), patch);
			void appLogger.info("automation", "Updated task", { taskId: task.id, name: task.name });
			void automationScheduler.tick();
			return task;
		} catch (err) {
			void appLogger.error("automation", "Failed to update task", {
				taskId,
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}
	});

	ipcMain.handle(ipcChannels.automationDeleteTask, async (_event, taskId: string): Promise<boolean> => {
		if (typeof taskId !== "string" || !taskId.trim()) {
			throw new Error("Valid task ID is required");
		}
		try {
			const deleted = await automationStore.deleteTask(taskId.trim());
			void appLogger.info("automation", "Deleted task", { taskId, deleted });
			return deleted;
		} catch (err) {
			void appLogger.error("automation", "Failed to delete task", {
				taskId,
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}
	});

	ipcMain.handle(ipcChannels.automationRunNow, async (_event, taskId: string): Promise<AutomationRun> => {
		if (typeof taskId !== "string" || !taskId.trim()) {
			throw new Error("Valid task ID is required");
		}
		try {
			const run = await automationRunCoordinator.runNow(taskId.trim());
			void appLogger.info("automation", "Manual run triggered", { taskId, runId: run.id });
			return run;
		} catch (err) {
			void appLogger.error("automation", "Manual run failed", {
				taskId,
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}
	});

	ipcMain.handle(ipcChannels.automationAbortRun, async (_event, runId: string): Promise<boolean> => {
		if (typeof runId !== "string" || !runId.trim()) {
			throw new Error("Valid run ID is required");
		}
		try {
			const aborted = await automationRunCoordinator.abortRun(runId.trim(), "User aborted");
			void appLogger.info("automation", "Run abort requested", { runId, aborted });
			return aborted;
		} catch (err) {
			void appLogger.error("automation", "Run abort failed", {
				runId,
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}
	});

	ipcMain.handle(ipcChannels.automationDeleteRuns, async (_event, runIds: unknown): Promise<number> => {
		if (!Array.isArray(runIds)) {
			throw new Error("Run IDs must be an array");
		}
		const ids = runIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map((id) => id.trim());
		try {
			const deleted = await automationStore.deleteRuns(ids);
			void appLogger.info("automation", "Deleted run history", { requested: ids.length, deleted });
			return deleted;
		} catch (err) {
			void appLogger.error("automation", "Failed to delete run history", {
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}
	});

	ipcMain.handle(ipcChannels.automationClearRuns, async (): Promise<number> => {
		try {
			const deleted = await automationStore.clearTerminalRuns();
			void appLogger.info("automation", "Cleared terminal run history", { deleted });
			return deleted;
		} catch (err) {
			void appLogger.error("automation", "Failed to clear run history", {
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}
	});

	ipcMain.handle(ipcChannels.automationUpdateSettings, async (_event, patch: UpdateAutomationSettingsInput): Promise<AutomationSettings> => {
		if (!patch || typeof patch !== "object") {
			throw new Error("Invalid automation settings patch");
		}
		try {
			const settings = await automationStore.updateSettings(patch);
			void appLogger.info("automation", "Updated settings", { settings });
			void automationRunCoordinator.drainQueue();
			return settings;
		} catch (err) {
			void appLogger.error("automation", "Failed to update settings", {
				error: err instanceof Error ? err.message : String(err),
			});
			throw err;
		}
	});

	ipcMain.handle(ipcChannels.automationPreviewCron, async (_event, expression: string, count = 5): Promise<AutomationCronPreview> => {
		if (typeof expression !== "string" || !expression.trim()) {
			return { valid: false, error: "Cron expression is required" };
		}
		try {
			parseAutomationCron(expression.trim());
			const runs = previewAutomationCron(expression.trim(), new Date(), Math.min(10, Math.max(1, count)));
			return {
				valid: true,
				nextRuns: runs.map((d) => d.getTime()),
			};
		} catch (err) {
			return {
				valid: false,
				error: err instanceof Error ? err.message : "Invalid cron expression",
			};
		}
	});

	return () => {
		unsubscribeStore();
		ipcMain.removeHandler(ipcChannels.automationGetSnapshot);
		ipcMain.removeHandler(ipcChannels.automationCreateTask);
		ipcMain.removeHandler(ipcChannels.automationUpdateTask);
		ipcMain.removeHandler(ipcChannels.automationDeleteTask);
		ipcMain.removeHandler(ipcChannels.automationRunNow);
		ipcMain.removeHandler(ipcChannels.automationAbortRun);
		ipcMain.removeHandler(ipcChannels.automationDeleteRuns);
		ipcMain.removeHandler(ipcChannels.automationClearRuns);
		ipcMain.removeHandler(ipcChannels.automationUpdateSettings);
		ipcMain.removeHandler(ipcChannels.automationPreviewCron);
	};
}
