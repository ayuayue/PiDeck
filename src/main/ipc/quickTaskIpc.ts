import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { QuickTaskController } from "../quickTask/QuickTaskController";

export interface QuickTaskIpcDeps {
	/** 任务模式 → 小窗：退出 quick-task 后由装配层隐藏主窗口并展开极简浮窗。 */
	onSwitchToMiniOverlay?: () => Promise<void>;
}

/** Presentation API: cannot create sessions, start agents or send prompts. */
export function registerQuickTaskIpc(controller: QuickTaskController, deps: QuickTaskIpcDeps = {}): void {
	ipcMain.handle(ipcChannels.quickTaskGetState, () => controller.getState());
	ipcMain.handle(ipcChannels.quickTaskExit, () => controller.exit());
	ipcMain.handle(ipcChannels.quickTaskSwitchToMiniOverlay, async () => {
		// 先恢复正常工作台几何，再由装配层决定隐藏主窗口 + 展开小窗；
		// 顺序不能反——exit() 里会 setBounds 恢复工作台尺寸。
		controller.exit();
		await deps.onSwitchToMiniOverlay?.();
	});
}
