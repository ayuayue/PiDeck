/**
 * 通知历史 IPC 域：只做装配，入参清洗在 NoticeHistoryStore.append 内完成。
 * 通道：noticeHistory:get / notice-history:record / notice-history:clear / notice-history:get-size。
 *
 * 数据落在独立文件 userData/notice-history.json（NoticeHistoryStore 读写），
 * 渲染层只推送记录与拉取历史，不碰文件路径。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { NoticeHistoryStore } from "../notices/NoticeHistoryStore";

export function registerNoticeHistoryIpc(store: NoticeHistoryStore): void {
	ipcMain.handle(ipcChannels.noticeHistoryGet, () => store.load());
	ipcMain.handle(ipcChannels.noticeHistoryRecord, (_event, input: unknown) => {
		store.append(input);
	});
	ipcMain.handle(ipcChannels.noticeHistoryClear, () => store.clear());
	ipcMain.handle(ipcChannels.noticeHistoryGetSize, () => store.getSize());
}
