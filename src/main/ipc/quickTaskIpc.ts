import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { QuickTaskController } from "../quickTask/QuickTaskController";

/** Presentation API: cannot create sessions, start agents or send prompts. */
export function registerQuickTaskIpc(controller: QuickTaskController): void {
	ipcMain.handle(ipcChannels.quickTaskGetState, () => controller.getState());
	ipcMain.handle(ipcChannels.quickTaskExit, () => controller.exit());
}
