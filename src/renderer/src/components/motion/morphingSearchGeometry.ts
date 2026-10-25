/**
 * MorphingSearch 面板落点的纯计算：锚点测量值 → 面板 top/left/width + 结果区高度。
 *
 * 面板是 `position: fixed` 且渲染在 body 上的 portal 里，落点完全由锚点的
 * `getBoundingClientRect()` 决定；而锚点自己可能落在带 transform 的祖先内
 * （AppShell 的侧栏入场动画 `.list-content-enter` → `translateX(8px)`，见
 * `src/renderer/src/components/app/AppShell.tsx:435` 与
 * `src/renderer/src/styles/foundation.css:1561`）。此时 fixed 元素会被当成相对
 * 那个祖先盒子定位，读出来的 left 是「锚点在祖先内的落点」——侧栏里约为
 * -(列表宽度) + 8（1200 宽窗口、280 宽侧栏、640 宽锚点 → -172）。旧实现直接拿
 * 它当落点，于是搜索面板整块被推出窗口左侧（「搜索弹框卡在屏幕外面」，2026-10
 * 用户反馈：窗口里只剩面板右半截和滚动条，多点几次（触发了后续测量）才自愈）。
 *
 * 这里做两件事：
 * 1. `isPlausibleAnchorRect`：锚点必须落在窗口内，否则视为不可信测量——调用方
 *    直接丢弃，保留上一次有效值，等动画结束后的事件再刷新；
 * 2. `resolveMorphingSearchGeometry`：把面板夹进窗口，任何来源的陈旧落点（窗口
 *    缩小过、测量失败保留了旧值）都不会把面板送到窗口外。
 * 正常路径（锚点在窗口内且放得下）返回值与夹取前逐值一致，视觉不变。
 */

/** 面板顶栏高度（h-12），夹取与高度预留都要算上。 */
export const MORPHING_SEARCH_HEADER_HEIGHT = 48;
/** 结果区最小高度：太矮的窗口也让面板留出可点的一片。 */
export const MORPHING_SEARCH_MIN_RESULTS_HEIGHT = 96;
/** 面板与窗口边缘的最小间距。 */
const VIEWPORT_MARGIN = 8;
/** 亚像素/动画抖动容忍：锚点略微越界不算异常测量。 */
const EDGE_TOLERANCE = 2;
/** 结果区底边到窗口底边预留的空间（顶栏之外的呼吸位），沿用原实现口径。 */
const RESULTS_TAIL_SPACE = 80;

export type MorphingSearchAnchorRect = {
	top: number;
	left: number;
	width: number;
};

export type MorphingSearchViewport = {
	width: number;
	height: number;
};

export type MorphingSearchGeometry = {
	top: number;
	left: number;
	/** 面板宽度（≥ 锚点宽度）。 */
	width: number;
	resultsHeight: number;
};

export type MorphingSearchGeometryInput = {
	anchor: MorphingSearchAnchorRect;
	viewport: MorphingSearchViewport;
	maxWidth: number;
	maxHeight: number;
};

function clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * 锚点测量是否可信。锚点（侧栏搜索框 / 会话内搜索框）必然整块落在窗口内；
 * 落在窗口外只可能来自坏掉的测量（祖先带 transform 的固定定位）或窗口刚缩过，
 * 这类值不能用来放置面板。
 */
export function isPlausibleAnchorRect(anchor: MorphingSearchAnchorRect, viewport: MorphingSearchViewport): boolean {
	if (!Number.isFinite(anchor.top) || !Number.isFinite(anchor.left) || !Number.isFinite(anchor.width)) return false;
	if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)) return false;
	if (anchor.width <= 0 || viewport.width <= 0) return false;
	const insideHorizontally = anchor.left >= -EDGE_TOLERANCE && anchor.left + anchor.width <= viewport.width + EDGE_TOLERANCE;
	const insideVertically = anchor.top >= -EDGE_TOLERANCE && anchor.top <= viewport.height + EDGE_TOLERANCE;
	return insideHorizontally && insideVertically;
}

/**
 * 面板几何：宽度不小于锚点、上限 maxWidth，并保证整块落在窗口内。
 * 视口高度小于「上下边距 + 顶栏 + 最小结果区」时（桌面窗口最小 880×640，正常到不了）
 * 保持最小结果区，允许纵向溢出——牺牲可见性还不如让用户能点。
 */
export function resolveMorphingSearchGeometry({ anchor, viewport, maxWidth, maxHeight }: MorphingSearchGeometryInput): MorphingSearchGeometry {
	const viewportWidth = Math.max(0, viewport.width);
	const viewportHeight = Math.max(0, viewport.height);
	const availableWidth = Math.max(0, viewportWidth - VIEWPORT_MARGIN * 2);

	// 面板至少与锚点同宽（视觉上从锚点长出来）；锚点本身宽过窗口时先按窗口收窄。
	const anchorWidth = Math.min(Math.max(anchor.width, 0), availableWidth);
	const left = clamp(anchor.left, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, viewportWidth - VIEWPORT_MARGIN - anchorWidth));
	const width = Math.max(anchorWidth, Math.min(maxWidth, viewportWidth - left - VIEWPORT_MARGIN * 2));
	// 变宽到 maxWidth 后右缘可能越过窗口，把落点往回收一段保证整块可见。
	const clampedLeft = clamp(left, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, viewportWidth - VIEWPORT_MARGIN - width));

	const resultsHeight = Math.max(MORPHING_SEARCH_MIN_RESULTS_HEIGHT, Math.min(maxHeight, viewportHeight - anchor.top - RESULTS_TAIL_SPACE));
	const top = clamp(anchor.top, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, viewportHeight - VIEWPORT_MARGIN - MORPHING_SEARCH_HEADER_HEIGHT - resultsHeight));

	return { top, left: clampedLeft, width, resultsHeight };
}
