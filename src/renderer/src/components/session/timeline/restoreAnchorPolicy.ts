/**
 * 会话切回时锚点行没挂载，恢复链的下一步（纯决策；DOM 操作留在 controller）。
 *
 * 顺序是承重结构，不是风格问题：
 * 1. 先扩已加载数据的渲染窗口 —— 无 I/O，一帧内完成，扩到数据上限才知道锚点是否
 *    真的不在手里（v0.9.9 已修，见 #477）。
 * 2. 窗口覆盖已加载数据仍找不到，就补更早的历史页 —— 首屏只读 9 轮，切走期间上游
 *    追加会把锚点挤出尾部；锚点行明明存在，不能因为「没读进内存」就判死。
 * 3. 补页有界：一页已是 host 上限（200 轮），补不到就放弃。
 * 4. 放弃交回无锚点路径（滚到实时尾部）。**不再回顶部** —— 那是 #477 的症状：
 *    切回后视口被钉在历史开头，用户得手动滑回来。
 */

export type MissingAnchorNextStep = "expand" | "load" | "wait" | "bottom";

/** 恢复时最多补几页。backfill 一页 200 轮，正常会话一页覆盖全部更早历史；
 *  给 3 页是留给 host 夹到 10 轮的会话（DSH）与 8000 条消息上限的分页。 */
export const RESTORE_ANCHOR_PAGE_LIMIT = 3;

/**
 * 页在途时必须先等，不能因为尝试次数用完就提前落底：
 * 第 3 次补页刚发出时 attempts 已等于上限，此时落底会让迟到的页白读，
 * 用户也已经离开恢复流程。
 */
export function resolveMissingAnchorNextStep(input: {
	windowExpandable: boolean;
	hasEarlierPages: boolean;
	loadingEarlier: boolean;
	loadAttempts: number;
	pageLimit?: number;
}): MissingAnchorNextStep {
	if (input.windowExpandable) return "expand";
	if (input.loadingEarlier) return "wait";
	const pageLimit = input.pageLimit ?? RESTORE_ANCHOR_PAGE_LIMIT;
	if (input.hasEarlierPages && input.loadAttempts < pageLimit) return "load";
	return "bottom";
}
