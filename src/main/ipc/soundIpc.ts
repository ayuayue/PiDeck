/**
 * 声音提醒 IPC：主进程 → 渲染层推送播放事件；渲染层 → 主进程管理自定义音频。
 * 输入校验在边界：文件名/引用由 shared 的 isAllowedCustomSoundName 与
 * SoundFileStore 的路径白名单双重把关，渲染层数据一律不可信。
 */
import { ipcMain, type BrowserWindow } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { isAllowedCustomSoundName } from "../../shared/types/soundAlert";
import { importCustomSound, listCustomSounds, removeCustomSound } from "../sounds/SoundFileStore";

export function registerSoundIpc(): void {
	ipcMain.handle(ipcChannels.soundsListCustom, () => listCustomSounds());

	ipcMain.handle(ipcChannels.soundsImportCustom, (event) =>
		importCustomSound(event.sender as unknown as BrowserWindow | null),
	);

	ipcMain.handle(ipcChannels.soundsRemoveCustom, (_event, name: unknown) => {
		// 入参不可信：只接受字符串 + 合法文件名，其余静默失败（返回 false）。
		if (typeof name !== "string" || !isAllowedCustomSoundName(name)) return false;
		return removeCustomSound(name);
	});
}
