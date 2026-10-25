import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { openSystemPath } from "../fs/openPath";
import { BUILTIN_CONTENT_UPDATE_ALLOWED_BRANCHES, BUILTIN_CONTENT_UPDATE_DEFAULT_BRANCH, type BuiltinContentUpdater } from "../updates/builtinContentUpdater";
import type { PromptStoreUpdater } from "../prompts/promptStoreUpdater";
import type { SkillStoreUpdater } from "../skills/skillStoreUpdater";

type ChannelGroup = {
	status: string;
	check: string;
	apply: string;
	restore: string;
	restorePrevious: string;
	openDir: string;
};

/**
 * 提示词商店官方模板 / 内置技能热更新 IPC。
 *
 * 与内置扩展热更新（builtInExtensionIpc）同构：状态/检测/更新/还原/恢复上一版 + 打开目录，
 * 磁盘落点是 `<userData>/prompt-overlay` 或 `<userData>/skills-overlay` 覆盖层。
 * 模板/技能内容变化后，商店列表与技能安装无需重启即可看到新版本（查询侧覆盖层优先）。
 *
 * 输入校验在边界：分支只接受 main/dev 字面量（防 URL 注入），非法值回退默认分支。
 */
export function registerContentStoreIpc(updater: PromptStoreUpdater | SkillStoreUpdater, channels: ChannelGroup): void {
	ipcMain.handle(channels.status, () => updater.getStatus());
	ipcMain.handle(channels.check, (_event, branch: unknown) => {
		return updater.checkRemote(sanitizeBranch(branch));
	});
	ipcMain.handle(channels.apply, (_event, branch: unknown) => {
		return updater.update(sanitizeBranch(branch));
	});
	ipcMain.handle(channels.restore, () => updater.restoreBuiltin());
	ipcMain.handle(channels.restorePrevious, () => updater.restorePrevious());
	ipcMain.handle(channels.openDir, async () => {
		// 打开当前生效目录（覆盖层优先，否则内置）：路径由主进程解析，渲染层不传路径。
		const error = await openSystemPath(updater.resolveEffectiveDir());
		if (error) throw new Error(error);
	});
}

/** 白名单分支校验：只允许 main/dev，非法值回退 main（防 URL 注入）。 */
function sanitizeBranch(branch: unknown): string {
	return typeof branch === "string" && (BUILTIN_CONTENT_UPDATE_ALLOWED_BRANCHES as readonly string[]).includes(branch) ? branch : BUILTIN_CONTENT_UPDATE_DEFAULT_BRANCH;
}

/** 提示词商店官方模板更新的 IPC 通道组。 */
export const PROMPTS_STORE_CHANNELS: ChannelGroup = {
	status: ipcChannels.promptsStoreUpdateStatus,
	check: ipcChannels.promptsStoreUpdateCheck,
	apply: ipcChannels.promptsStoreUpdateApply,
	restore: ipcChannels.promptsStoreUpdateRestore,
	restorePrevious: ipcChannels.promptsStoreUpdateRestorePrevious,
	openDir: ipcChannels.promptsStoreOpenDir,
};

/** 内置技能更新的 IPC 通道组。 */
export const SKILLS_STORE_CHANNELS: ChannelGroup = {
	status: ipcChannels.skillsStoreUpdateStatus,
	check: ipcChannels.skillsStoreUpdateCheck,
	apply: ipcChannels.skillsStoreUpdateApply,
	restore: ipcChannels.skillsStoreUpdateRestore,
	restorePrevious: ipcChannels.skillsStoreUpdateRestorePrevious,
	openDir: ipcChannels.skillsStoreOpenDir,
};
