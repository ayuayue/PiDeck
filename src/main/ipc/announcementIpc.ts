/**
 * 应用公告 IPC：渲染层读快照 / 手动刷新 / 已读标记 / 已提醒标记。
 * 入参校验在边界：markRead 的 id 只接受长度合规的字符串（渲染层数据不可信）；
 * markNotified 只接受数组（元素级校验在 service）；list/refresh/markAllRead 无入参。
 * AnnouncementService 内部已做防重入，这里不做额外的并发控制。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { AnnouncementService } from "../announcements/AnnouncementService";

export function registerAnnouncementIpc(getService: () => AnnouncementService | null): void {
	ipcMain.handle(ipcChannels.announcementList, () => {
		// 服务未装配（启动极早期）时返回空快照而非抛错，渲染层按空态处理
		return getService()?.getState() ?? { items: [], fetchedAt: null, source: "cache", readIds: [], notifiedIds: [] };
	});

	ipcMain.handle(ipcChannels.announcementRefresh, () => {
		const service = getService();
		if (!service) return { items: [], fetchedAt: null, source: "cache", readIds: [], notifiedIds: [] };
		return service.refresh("manual");
	});

	ipcMain.handle(ipcChannels.announcementMarkRead, (_event, id: unknown) => {
		// 边界校验：只接受合理长度字符串；非法入参静默忽略（公告已读不是关键操作）
		if (typeof id !== "string" || id.length === 0 || id.length > 128) return false;
		getService()?.markRead(id);
		return true;
	});

	ipcMain.handle(ipcChannels.announcementMarkAllRead, () => {
		getService()?.markAllRead();
		return true;
	});

	// 已提醒标记：入参是 id 数组（渲染层可能在一次跳过里批量提交未读的旧公告）。
	// 这里只做形状筛选（元素级长度/类型校验在 service 里做），非数组直接拒绝。
	ipcMain.handle(ipcChannels.announcementMarkNotified, (_event, ids: unknown) => {
		if (!Array.isArray(ids)) return false;
		getService()?.markNotified(ids);
		return true;
	});
}
