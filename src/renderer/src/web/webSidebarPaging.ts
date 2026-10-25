/**
 * Web 侧栏项目会话列表的分页窗口策略（纯函数，无 React / DOM，vm 沙箱可单测）。
 *
 * 为什么要有它：早先实现是「初始 5 条 + IntersectionObserver 哨兵自动补 50」，而哨兵在
 * 移动端抽屉首次布局时就落在 rootMargin 内，于是展开一个项目会被连续补页成几十上百行
 * （实测「聊天」115 条展开即 57 行）——用户体感是「一打开就全都在了」，也和桌面端
 * 「最近会话 10 条/页 + 点『加载更多』再放一页」的语义不一致。
 *
 * 这里改成显式分页：初始一页、点「查看更多（剩余 N）」按页增、可「收起」回首页；
 * 不再随滚动自动加载，条数与剩余量全部由 total 推出，避免再存一份布尔标记。
 */

/** 首页显示条数（对齐桌面 RECENT_SESSIONS_INITIAL_VISIBLE = 10）。 */
export const WEB_SIDEBAR_INITIAL_VISIBLE = 10;
/** 每次「查看更多」追加的条数（桌面 RECENT_SESSIONS_PAGE_SIZE = 10 的两倍：手机点击成本更高）。 */
export const WEB_SIDEBAR_PAGE_STEP = 20;

export type SidebarWindow = {
	/** 实际渲染条数（不超过总数）。 */
	visibleCount: number;
	/** 尚未显示的条数（0 表示已全部展开）。 */
	remaining: number;
	/** 是否值得给「收起」入口（已超出首页才有意义）。 */
	canCollapse: boolean;
};

/**
 * 计算当前窗口。
 * requested 是「用户点了几次查看更多后希望看到的条数」，允许超过总数（钳到 total）；
 * searching 时一次显示全部命中：命中集合通常很小，且用户预期「搜到即列出」。
 */
export function resolveSidebarWindow(input: { total: number; requested: number; searching: boolean }): SidebarWindow {
	const total = Math.max(0, Math.trunc(input.total));
	if (input.searching) return { visibleCount: total, remaining: 0, canCollapse: false };
	const visibleCount = Math.min(total, Math.max(WEB_SIDEBAR_INITIAL_VISIBLE, Math.trunc(input.requested)));
	return { visibleCount, remaining: total - visibleCount, canCollapse: visibleCount > WEB_SIDEBAR_INITIAL_VISIBLE };
}

/** 点「查看更多」：当前已显示条数 → 下一页希望显示的条数。 */
export function growSidebarWindow(visibleCount: number): number {
	return Math.max(WEB_SIDEBAR_INITIAL_VISIBLE, Math.trunc(visibleCount)) + WEB_SIDEBAR_PAGE_STEP;
}
