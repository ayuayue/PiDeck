import { app, dialog, ipcMain } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FileManagerInfo } from "../../shared/types/project";
import { ipcChannels } from "../../shared/ipc";
import { MAX_BROWSER_HTML_PREVIEW_BYTES } from "../../shared/htmlPreview";
import { stageBrowserHtmlSnapshot } from "../browser/browserHtmlSnapshots";
import { detectFileManager, openFileManagerAt } from "../files/FileManager";
import { expandHomeForFileAccess } from "../fs/homePathExpansion";
import { openSystemPath } from "../fs/openPath";
import type { SettingsStore } from "../settings/SettingsStore";
import { parseWslUncPath, toWindowsHostPath } from "../wsl/WslPaths";

export type FilesSystemIpcDeps = {
	settingsStore: SettingsStore;
	openExternalUrl: (url: string, forceSystem?: boolean) => Promise<void>;
};

export function registerFilesSystemIpc({ settingsStore, openExternalUrl }: FilesSystemIpcDeps): void {
	const toWindowsPath = (path: string): string => {
		if (!path || process.platform !== "win32") return path;
		const unc = parseWslUncPath(path);
		// UNC 自带发行版；/mnt/<drive> 与发行版无关。其余 Linux 绝对路径没有项目上下文，
		// 不能猜一个发行版（猜错会把文件写到另一个发行版的 home）。
		if (unc !== null) return toWindowsHostPath(path, { distro: unc.distro });
		if (/^\/mnt\/[A-Za-z](?:\/|$)/.test(path)) return toWindowsHostPath(path, { distro: "Ubuntu" });
		return path;
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
		// issue #426：`~/x` 形态先展开家目录（WSL 会话用发行版内 home），再转宿主路径。
		const target = path.trim() ? toWindowsPath(expandHomeForFileAccess(path, settingsStore.get())) : homedir();
		if (process.platform !== "linux") {
			// 走受保护的统一入口：Linux 上 Electron 的 shell.openPath 永不 settle（issue #396）。
			const error = await openSystemPath(target);
			if (error) throw new Error(error);
			return;
		}
		await openFileManagerAt(target);
	});

	ipcMain.handle(ipcChannels.browserStageHtmlPreview, (_event, fileName: unknown, html: unknown) => {
		if (typeof fileName !== "string" || fileName.length > 1024 || typeof html !== "string" || html.length > MAX_BROWSER_HTML_PREVIEW_BYTES) return null;
		return stageBrowserHtmlSnapshot(fileName, html);
	});

	ipcMain.handle(ipcChannels.browserOpenExternal, async (_event, url: string) => {
		await openExternalUrl(url, true);
	});
}
