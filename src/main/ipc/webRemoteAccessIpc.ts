/**
 * 外网访问 IPC 域：cloudflare quick tunnel / tailscale serve 的状态查询与启停。
 * 只做输入校验和适配，业务全部在 RemoteAccessManager；
 * 状态推送由装配层经构造函数 pushState 注入（指向主窗口 webContents.send）。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { isRemoteAccessChannelId } from "../../shared/types/remoteAccess";
import type { RemoteAccessManager } from "../web/remoteAccess/RemoteAccessManager";

export function registerWebRemoteAccessIpc(deps: { remoteAccessManager: RemoteAccessManager }): void {
	const { remoteAccessManager } = deps;

	ipcMain.handle(ipcChannels.webRemoteAccessState, () => remoteAccessManager.getState());

	ipcMain.handle(ipcChannels.webRemoteAccessStart, (_event, channel: unknown) => {
		if (!isRemoteAccessChannelId(channel)) {
			return { ok: false as const, error: `无效的外网访问渠道: ${String(channel)}` };
		}
		return remoteAccessManager.start(channel).then((state) => ({ ok: true as const, state }));
	});

	ipcMain.handle(ipcChannels.webRemoteAccessStop, (_event, channel: unknown) => {
		if (!isRemoteAccessChannelId(channel)) {
			return { ok: false as const, error: `无效的外网访问渠道: ${String(channel)}` };
		}
		return remoteAccessManager.stop(channel).then((state) => ({ ok: true as const, state }));
	});

	ipcMain.handle(ipcChannels.webRemoteAccessRefresh, () => remoteAccessManager.refresh());
}
