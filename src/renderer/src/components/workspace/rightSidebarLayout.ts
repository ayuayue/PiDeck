/**
 * 右侧边栏上下分区的纯函数与常量（无 React 依赖，node 单测直接加载）。
 *
 * 尺寸语义与 react-resizable-panels v4 一致：数字为像素，无单位字符串为百分比。
 * 偏好只记录用户主动操作（拖拽/点按钮）的结果；「高度不足自动收起」是派生状态，
 * 不写入偏好，窗口恢复高度后自动回到用户偏好。
 */
export const RIGHT_SIDEBAR_STACK_STORAGE_KEY = "pid:right-sidebar-stack-v1";
export const SIDEBAR_TOP_PANEL_ID = "sidebar-top";
export const SIDEBAR_BOTTOM_PANEL_ID = "sidebar-bottom";
/** 上半区（原抽屉）最小高度：保证活动栏 + 面板标题 + 至少几行内容可见。 */
export const SIDEBAR_TOP_MIN_PX = 160;
/** 下半区展开时的最小高度：tab 栏 + 约三行内容。 */
export const SIDEBAR_BOTTOM_MIN_PX = 120;
/** 下半区收起后只保留 tab 栏。 */
export const SIDEBAR_BOTTOM_COLLAPSED_PX = 32;
export const SIDEBAR_SEPARATOR_PX = 1;
export const DEFAULT_BOTTOM_PCT = 45;
export const BOTTOM_PCT_MIN = 15;
export const BOTTOM_PCT_MAX = 80;

export type RightSidebarStackPrefs = { collapsed: boolean; bottomPct: number };

function defaultPrefs(): RightSidebarStackPrefs {
	return { collapsed: false, bottomPct: DEFAULT_BOTTOM_PCT };
}

/** 百分比收敛到 [MIN, MAX] 并保留一位小数；非有限数字回退默认。 */
export function clampBottomPct(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_BOTTOM_PCT;
	return Math.min(BOTTOM_PCT_MAX, Math.max(BOTTOM_PCT_MIN, Math.round(value * 10) / 10));
}

export function parseRightSidebarStackPrefs(raw: string | null | undefined): RightSidebarStackPrefs {
	if (!raw) return defaultPrefs();
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaultPrefs();
		const record = parsed as Record<string, unknown>;
		return { collapsed: record.collapsed === true, bottomPct: clampBottomPct(record.bottomPct) };
	} catch {
		return defaultPrefs();
	}
}

export function serializeRightSidebarStackPrefs(prefs: RightSidebarStackPrefs): string {
	return JSON.stringify({ collapsed: prefs.collapsed, bottomPct: clampBottomPct(prefs.bottomPct) });
}

/** 侧栏高度放不下「上半区最小 + 下半区展开最小 + 分隔条」时自动收起；未测量（0）不判定。 */
export function shouldAutoCollapseBottom(containerHeight: number): boolean {
	if (!Number.isFinite(containerHeight) || containerHeight <= 0) return false;
	return containerHeight < SIDEBAR_TOP_MIN_PX + SIDEBAR_BOTTOM_MIN_PX + SIDEBAR_SEPARATOR_PX;
}

export function resolveBottomCollapsed(prefs: RightSidebarStackPrefs, autoCollapsed: boolean): boolean {
	return prefs.collapsed || autoCollapsed;
}
