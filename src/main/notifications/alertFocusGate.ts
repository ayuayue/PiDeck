/**
 * 「仅失焦时提醒」（AppSettings.alertOnlyWhenUnfocused）的统一门控。
 *
 * 背景：系统通知与提示音此前无条件触发，用户一直盯着 PiDeck 也会被响铃打扰。
 * 打开该开关后，只在主窗口没有焦点（被其他窗口遮挡、托盘隐藏、切到别的应用）时才提醒；
 * 窗口在前台时保持安静。应用内 toast 与时间线不受影响（它们本来就只在窗口里可见）。
 *
 * 调用点共用本模块，避免各站点各写一份判断而漂移：
 * - AgentManager.notifySessionEnd / notifyAskPending（会话完成 / Ask 提问）
 * - index.ts 定时任务完成通知
 * - SoundAlertService（提示音，主进程判定后推 `sounds:play`）
 */
import type { BrowserWindow } from "electron";

/**
 * 现在是否应该提醒。
 * 开关关闭（默认）→ 永远提醒；开关打开 → 只在窗口失焦时提醒。
 */
export function shouldAlertNow(alertOnlyWhenUnfocused: boolean, isWindowFocused: boolean): boolean {
	return !alertOnlyWhenUnfocused || !isWindowFocused;
}

/**
 * 取主窗口焦点（窗口不存在/已销毁时按「失焦」处理）。
 * 拿不到窗口说明提醒本来也发不出去；提示音路径宁可多响一次，也不要静默丢掉提醒。
 */
export function isMainWindowFocused(window: BrowserWindow | null | undefined): boolean {
	try {
		return window?.isFocused() ?? false;
	} catch {
		// 窗口已销毁时 isFocused 可能抛错：按失焦处理，不影响主流程
		return false;
	}
}
