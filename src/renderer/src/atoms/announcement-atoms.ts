/**
 * 应用公告 atoms（session-first 之外的轻量全局域：公告是应用级而非会话级信息）。
 * 快照由主进程推送（useAnnouncementsSync 订阅），渲染层只做未读差集这类纯派生。
 */
import { atom } from "jotai";
import type { AnnouncementItem, AnnouncementState } from "../../../shared/types/announcement";

/** 主进程公告快照（含已读集合）；null = 尚未收到任何快照（启动极早期）。 */
export const announcementStateAtom = atom<AnnouncementState | null>(null);

/**
 * 未读公告列表（快照 items 与 readIds 的差集，保持快照顺序 = 发布时间倒序）。
 * 仅统计 flash 临时通知 + notice 公告：guide 指南是常驻参考、不打扰用户，不参与未读角标/红点/弹窗提醒。
 * 红点/角标与弹窗未读标记共用此派生，避免两处各算一遍。
 *
 * 注意：这里是「未读」，不是「未提醒」。已弹过 toast 的条目仍会留在这里，直到用户真正
 * 打开公告中心（markAllRead）——弹窗提醒的去重靠 notifiedIds，两者语义不同不可混用。
 */
export const unreadAnnouncementsAtom = atom<AnnouncementItem[]>((get) => {
	const state = get(announcementStateAtom);
	if (!state) return [];
	const read = new Set(state.readIds);
	return state.items.filter((item) => !read.has(item.id) && item.category !== "guide");
});

/**
 * 公告中心弹窗开关（atom 驱动而非组件内 useState）：
 * toast「查看」按钮在任意位置都能打开公告中心，状态必须提升为全局单一 owner。
 */
export const announcementCenterOpenAtom = atom(false);

/**
 * 「公告通知」开关的渲染层镜像（App.tsx 在 settings 变化时同步写入）。
 * 通知调度 hook 与侧栏入口显隐共用同一数据源，设置保存后即时生效。
 * 默认 true 与主进程 SettingsStore 出厂默认一致（首屏未拉到真实设置前不误隐）。
 */
export const announcementNotificationEnabledAtom = atom(true);
