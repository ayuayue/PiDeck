/**
 * 上滚时间线「接近顶部自动扩展/翻页」的触发阈值（纯函数，2026-12）。
 *
 * 预取原则：内容永远比滚动快一步——用户滚到接近顶部时就该扩窗口/翻页，
 * 让数据在触顶前就位。触发区间限定在
 * (HISTORY_AUTO_LOAD_THRESHOLD, resolveAutoExpandThreshold(视口高度)]：
 * - 下限避开「顶部不补偿」区（≤8px 时 prepend 后视口会直接显示新内容，
 *   滚动浏览时会把用户「跳」到更早对话——该策略只适合按钮点击场景，2026-02 修复）；
 * - 上限按视口高度比例计算：大视口需要更远的提前量（高屏滚一屏距离大），
 *   小视口由下限兜底不过早触发。
 */

/** 触发阈值下限（px）：小视口兜底，避免过度提前。 */
export const TURN_WINDOW_AUTO_EXPAND_THRESHOLD = 120;

/** 触发阈值按视口高度的比例系数：视口越高，提前量越大。 */
const AUTO_EXPAND_VIEWPORT_RATIO = 0.4;

/** 计算自动扩展/翻页的实际触发阈值（px）：视口高度 × 比例，下限 120px 兜底。 */
export function resolveAutoExpandThreshold(viewportHeight: number): number {
	return Math.max(TURN_WINDOW_AUTO_EXPAND_THRESHOLD, Math.round(viewportHeight * AUTO_EXPAND_VIEWPORT_RATIO));
}
