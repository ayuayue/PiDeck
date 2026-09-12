import { ipcMain, shell } from "electron";
import { ipcChannels } from "../../shared/ipc";
import {
	BUILT_IN_EXTENSIONS_UPDATE_ALLOWED_BRANCHES,
	BUILT_IN_EXTENSIONS_UPDATE_DEFAULT_BRANCH,
	type BuiltInExtensionsUpdater,
} from "../extensions/builtInExtensionsUpdater";

/**
 * 内置扩展热更新 IPC（扩展设置页的「内置扩展」更新入口）。
 *
 * 与模型目录更新（catalogIpc）同构：状态/检测/更新/还原/恢复上一版 + 打开目录。
 * 检测与更新都走 AtomGit OpenAPI（默认）或 GitHub raw（用户切源后），
 * 磁盘落点是 `<userData>/builtin-extensions` 覆盖层——打包态 resources 不可写。
 *
 * 输入校验在边界：分支只接受 main/dev 字面量（防 URL 注入），非法值回退默认分支。
 */
export function registerBuiltInExtensionIpc(updater: BuiltInExtensionsUpdater): void {
	ipcMain.handle(ipcChannels.extensionsBuiltInUpdateStatus, () => updater.getStatus());
	ipcMain.handle(ipcChannels.extensionsBuiltInUpdateCheck, (_event, branch: unknown) => {
		return updater.checkRemote(sanitizeBranch(branch));
	});
	ipcMain.handle(ipcChannels.extensionsBuiltInUpdateApply, (_event, branch: unknown) => {
		return updater.update(sanitizeBranch(branch));
	});
	ipcMain.handle(ipcChannels.extensionsBuiltInUpdateRestore, () => updater.restoreBuiltin());
	ipcMain.handle(ipcChannels.extensionsBuiltInUpdateRestorePrevious, () => updater.restorePrevious());
	// 打开当前生效的扩展目录（覆盖层优先，否则内置）：路径由主进程解析，渲染层不传路径。
	ipcMain.handle(ipcChannels.extensionsBuiltInOpenDir, async () => {
		const error = await shell.openPath(updater.resolveEffectiveExtensionsDir());
		// Electron 用返回字符串报告打开失败；显式抛出后前端才能提示路径不存在或系统无法打开。
		if (error) throw new Error(error);
	});
}

/** 白名单分支校验：只允许 main/dev，非法值回退 main（防 URL 注入）。 */
function sanitizeBranch(branch: unknown): string {
	return typeof branch === "string"
		&& (BUILT_IN_EXTENSIONS_UPDATE_ALLOWED_BRANCHES as readonly string[]).includes(branch)
		? branch
		: BUILT_IN_EXTENSIONS_UPDATE_DEFAULT_BRANCH;
}
