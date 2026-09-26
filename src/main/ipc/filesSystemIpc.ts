import { app, dialog, ipcMain, shell } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FileManagerInfo } from "../../shared/types/project";
import { ipcChannels } from "../../shared/ipc";
import { detectFileManager, openFileManagerAt } from "../files/FileManager";
import type { SettingsStore } from "../settings/SettingsStore";
import { parseWslUncPath, toWindowsHostPath } from "../wsl/WslPaths";

export type FilesSystemIpcDeps = {
	settingsStore: SettingsStore;
	openExternalUrl: (url: string, forceSystem?: boolean) => Promise<void>;
};

export function registerFilesSystemIpc({ settingsStore, openExternalUrl }: FilesSystemIpcDeps): void {
	const toWindowsPath = (path: string): string => {
		if (!path || process.platform !== "win32") return path;
		const settings = settingsStore.get();
		if (!settings.wslEnabled || !settings.wslDistro) return path;
		if (!path.startsWith("/") && !parseWslUncPath(path)) return path;
		return toWindowsHostPath(path, { distro: settings.wslDistro });
	};

	ipcMain.handle(ipcChannels.dialogPickFiles, async (_event, options?: { title?: string; includeDirectories?: boolean }) => {
		const result = await dialog.showOpenDialog({
			title: options?.title,
			properties: options?.includeDirectories ? ["openFile", "openDirectory", "multiSelections"] : ["openFile", "multiSelections"],
		});
		return result.canceled ? [] : result.filePaths;
	});

	ipcMain.handle(ipcChannels.filesDetectFileManager, async (): Promise<FileManagerInfo | null> => {
		const info = detectFileManager();
		if (info?.id === "windows-explorer") {
			const explorerPath = join(process.env.SystemRoot ?? "C:\\Windows", "explorer.exe");
			const icon = await app.getFileIcon(explorerPath, { size: "large" });
			if (!icon.isEmpty()) info.iconDataUrl = icon.toDataURL();
		}
		return info;
	});

	ipcMain.handle(ipcChannels.filesOpenFileManager, async (_event, path: unknown) => {
		if (typeof path !== "string" || path.length > 32_768) throw new Error("Invalid file manager path");
		const target = path.trim() ? toWindowsPath(path) : homedir();
		if (process.platform !== "linux") {
			const error = await shell.openPath(target);
			if (error) throw new Error(error);
			return;
		}
		await openFileManagerAt(target);
	});

	ipcMain.handle(ipcChannels.browserOpenExternal, async (_event, url: string) => {
		await openExternalUrl(url, true);
	});
}
