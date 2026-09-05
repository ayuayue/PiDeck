import { ipcMain, shell } from "electron";
import { ipcChannels } from "../../shared/ipc";
import {
	CATALOG_UPDATE_ALLOWED_BRANCHES,
	CATALOG_UPDATE_DEFAULT_BRANCH,
	type PiAiCatalogUpdater,
} from "../pi/PiAiCatalogUpdater";

/**
 * 模型目录更新 IPC：输入校验在边界——分支只接受白名单字面量（main/dev），
 * 拒绝任意字符串（防 URL/路径注入），非法值回退默认分支 main。
 */
export function registerCatalogIpc(updater: PiAiCatalogUpdater): void {
	ipcMain.handle(ipcChannels.catalogUpdateStatus, () => updater.getStatus());
	ipcMain.handle(ipcChannels.catalogUpdateCheck, (_event, branch: unknown) => {
		return updater.checkRemote(sanitizeBranch(branch));
	});
	ipcMain.handle(ipcChannels.catalogUpdateFromGithub, (_event, branch: unknown) => {
		return updater.update(sanitizeBranch(branch));
	});
	ipcMain.handle(ipcChannels.catalogUpdateRestore, () => updater.restoreBuiltin());
	ipcMain.handle(ipcChannels.catalogUpdateRestorePrevious, () => updater.restorePrevious());
	// 打开当前生效目录文件（覆盖层或内置）：路径由主进程解析，渲染层只发意图，不传路径。
	ipcMain.handle(ipcChannels.catalogOpenFile, async () => {
		const catalogPath = updater.resolveEffectiveCatalogPath();
		if (!catalogPath) throw new Error("catalog artifact not found");
		const error = await shell.openPath(catalogPath);
		// Electron 通过返回字符串报告打开失败；显式抛出后前端才能提示路径不存在或系统无法打开。
		if (error) throw new Error(error);
	});
}

/** 白名单分支校验：只允许 main/dev，非法值回退 main（防 URL/路径注入）。 */
function sanitizeBranch(branch: unknown): string {
	return typeof branch === "string"
		&& (CATALOG_UPDATE_ALLOWED_BRANCHES as readonly string[]).includes(branch)
		? branch
		: CATALOG_UPDATE_DEFAULT_BRANCH;
}
