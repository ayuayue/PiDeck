import { ipcMain, dialog, type BrowserWindow } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { ExternalEditor, ExternalEditorId, ExternalEditorSetting } from "../../shared/types";
import type { SettingsStore } from "../settings/SettingsStore";
import type { AppLogger } from "../logging/AppLogger";
import { listConfiguredExternalEditors, mergeDetectedExternalEditors, detectExternalEditors, validateExternalEditorCommand, openProjectInEditor } from "../editors/EditorDetector";

export type EditorsIpcDeps = {
	settingsStore: SettingsStore;
	appLogger: AppLogger;
	getMainWindow: () => BrowserWindow | null;
};

export function registerEditorsIpc(deps: EditorsIpcDeps): void {
	const { settingsStore, appLogger, getMainWindow } = deps;

	ipcMain.handle(ipcChannels.editorsList, async () => listConfiguredExternalEditors(settingsStore.get()));
	ipcMain.handle(ipcChannels.editorsChooseExecutable, async () => {
		const options = {
			properties: ["openFile"],
			filters:
				process.platform === "win32"
					? [
							{ name: "Applications", extensions: ["exe", "cmd", "bat"] },
							{ name: "All Files", extensions: ["*"] },
						]
					: [{ name: "All Files", extensions: ["*"] }],
		} satisfies Electron.OpenDialogOptions;
		const mainWindow = getMainWindow();
		const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
		return result.canceled ? null : (result.filePaths[0] ?? null);
	});
	ipcMain.handle(ipcChannels.editorsRedetect, async () => {
		const detected = await detectExternalEditors();
		const settings = await settingsStore.update({
			externalEditors: mergeDetectedExternalEditors(settingsStore.get().externalEditors, detected),
		});
		void appLogger.info("editor", "External editors redetected", { count: detected.length });
		return settings;
	});
	ipcMain.handle(ipcChannels.editorsUpdate, async (_event, editorId: ExternalEditorId, patch: Partial<ExternalEditorSetting>) => {
		const current = settingsStore.get().externalEditors;
		const existing = current[editorId];
		if (!existing) throw new Error(`Unsupported editor: ${editorId}`);
		const command = typeof patch.command === "string" ? patch.command.trim() : existing.command;
		if (command) {
			const validation = await validateExternalEditorCommand(command);
			if (!validation.valid) throw new Error(`Editor path does not exist: ${command}`);
		}
		const settings = await settingsStore.update({
			externalEditors: {
				...current,
				[editorId]: {
					...existing,
					...patch,
					command,
					detectedFrom: patch.command !== undefined ? "manual" : (patch.detectedFrom ?? existing.detectedFrom),
					updatedAt: Date.now(),
				},
			},
		});
		void appLogger.info("editor", "External editor settings updated", { editorId, keys: Object.keys(patch) });
		return settings;
	});
	ipcMain.handle(ipcChannels.editorsOpenProject, async (_event, editor: ExternalEditor, projectPath: string) => {
		// 只接收已检测到的编辑器配置；打开项目不经过 shell 拼接命令,降低路径含空格时失败的概率。
		// 渲染层不可信：editor 对象里的 command/args 可被篡改成任意进程启动器，
		// 这里只取 editorId，command/name 一律以主进程配置为准。
		if (typeof editor?.id !== "string" || typeof projectPath !== "string" || !projectPath.trim()) {
			throw new Error("Invalid editor open request");
		}
		// listConfiguredExternalEditors 只返回 enabled 且可启动（resolveLaunchableCommand+exists）
		// 的编辑器，与渲染层下拉框同一数据源，天然排除未配置/失效 command。
		const configured = (await listConfiguredExternalEditors(settingsStore.get())).find((candidate) => candidate.id === editor.id);
		if (!configured) throw new Error(`Unsupported editor: ${editor.id}`);
		await openProjectInEditor(configured, projectPath);
		void appLogger.info("editor", "Project opened in external editor", {
			editorId: configured.id,
			editorName: configured.name,
			command: configured.command,
			args: configured.args,
			projectPath,
		});
	});
}
