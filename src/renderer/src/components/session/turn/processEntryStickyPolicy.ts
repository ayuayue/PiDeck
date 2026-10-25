/** 过程项吸顶的几何规则，与 React、DOM 和滚动引擎解耦。 */
export type ProcessEntryStickyMetrics = {
	expanded: boolean;
	viewportTop: number;
	viewportHeight: number;
	entryTop: number;
	entryBottom: number;
	entryHeight: number;
	headerHeight: number;
};

export type ProcessEntryStickyState = { sticky: boolean; pinned: boolean };

/** 仅长展开项启用原生 sticky；标题还在原位或正离开本项时，不显示附加入口。 */
export function resolveProcessEntryStickyState(metrics: ProcessEntryStickyMetrics): ProcessEntryStickyState {
	const { expanded, viewportTop, viewportHeight, entryTop, entryBottom, entryHeight, headerHeight } = metrics;
	const valid = [viewportTop, viewportHeight, entryTop, entryBottom, entryHeight, headerHeight].every(Number.isFinite);
	const sticky = valid && expanded && viewportHeight > 0 && headerHeight > 0 && entryHeight > viewportHeight;
	// 1px 容差吸收缩放/高 DPI 的亚像素偏差，避免原位标题反复闪出图标。
	return { sticky, pinned: sticky && entryTop < viewportTop - 1 && entryBottom > viewportTop + headerHeight };
}

/** 原始 section 的组内偏移；已吸顶 header 的坐标不再代表本项开头。 */
export function processEntryStartOffset(metrics: { entryTop: number; viewportTop: number; scrollTop: number }): number | null {
	const { entryTop, viewportTop, scrollTop } = metrics;
	return [entryTop, viewportTop, scrollTop].every(Number.isFinite) ? Math.max(0, entryTop - viewportTop + scrollTop) : null;
}
