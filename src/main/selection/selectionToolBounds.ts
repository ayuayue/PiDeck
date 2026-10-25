/**
 * 系统级划词浮窗的定位/尺寸纯策略（无 electron 依赖，node:test 直接加载：
 * tests/selectionToolWindowBounds.test.mjs）。
 *
 * 产品规则：浮窗像浏览器插件的 popup 一样出现在系统光标右下方，但必须**完整**落在
 * 光标所在显示器的 workArea 内——任务栏、屏幕右/下边缘、多显示器的负坐标
 * （副屏在主屏左侧/上方时 workArea.x/y 为负）都会让「直接按光标算坐标」的窗口
 * 跑到屏幕外：用户看到快捷键没反应，实际是浮窗渲染在看不见的地方。
 */

export type SelectionToolPoint = { x: number; y: number };
export type SelectionToolSize = { width: number; height: number };

/** 浮窗与光标之间的右下偏移：贴住光标但不压住它（与右键菜单同向语义）。 */
export const SELECTION_TOOL_CURSOR_OFFSET = 14;
/** 浮窗与显示器可用区边缘的最小留白：留出圆角/阴影呼吸，避免贴边被裁。 */
export const SELECTION_TOOL_SCREEN_MARGIN = 8;

// 尺寸的唯一来源在 shared/types/selectionTool；这里 re-export 供窗口与旧测试继续使用。
export {
	SELECTION_TOOL_WINDOW_COLLAPSED_HEIGHT,
	SELECTION_TOOL_WINDOW_COLLAPSED_WIDTH,
	SELECTION_TOOL_WINDOW_EXPANDED_HEIGHT,
	SELECTION_TOOL_WINDOW_WIDTH,
} from "../../shared/types/selectionTool";
import { SELECTION_TOOL_WINDOW_EXPANDED_HEIGHT } from "../../shared/types/selectionTool";

/** 兼容旧命名：展开态高度（结果面板）。 */
export const SELECTION_TOOL_WINDOW_HEIGHT = SELECTION_TOOL_WINDOW_EXPANDED_HEIGHT;

/** 非聚焦浮窗的自动收起时间：不抢焦点，也不能一直悬在目标应用上方。 */
export const SELECTION_TOOL_AUTO_HIDE_MS = 30_000;

/**
 * 依次尝试「首选位置」与「翻转位置」，两者都不在允许区间时贴最近边界。
 * 单独抽出来是因为 x/y 规则完全对称，复制两份逻辑迟早漂移。
 */
function pickAxis(primary: number, flipped: number, min: number, max: number): number {
	if (primary >= min && primary <= max) return primary;
	if (flipped >= min && flipped <= max) return flipped;
	// 极端情况（显示器比浮窗还窄/光标贴在最外侧）：宁可盖住光标也不能出屏。
	return primary > max ? max : min;
}

/**
 * 计算浮窗左上角屏幕坐标（纯函数）。
 *
 * 规则：
 * - 首选光标右下 offset；右侧放不下翻到光标左侧，下方放不下翻到光标上方；
 * - 两侧都放不下时夹紧到 workArea + margin 内，保证任何屏幕尺寸/缩放/多屏布局都不出界；
 * - 数值一律取整：BrowserWindow.setPosition 接受浮点但高分屏下会出现半像素模糊。
 */
export function clampSelectionToolPosition(input: { cursor: SelectionToolPoint; workArea: { x: number; y: number; width: number; height: number }; size: SelectionToolSize; offset?: number; margin?: number }): SelectionToolPoint {
	const offset = input.offset ?? SELECTION_TOOL_CURSOR_OFFSET;
	const margin = input.margin ?? SELECTION_TOOL_SCREEN_MARGIN;
	const width = Math.max(0, input.size.width);
	const height = Math.max(0, input.size.height);
	const { cursor, workArea } = input;
	const minX = workArea.x + margin;
	const minY = workArea.y + margin;
	const maxX = Math.max(minX, workArea.x + workArea.width - margin - width);
	const maxY = Math.max(minY, workArea.y + workArea.height - margin - height);
	const x = pickAxis(cursor.x + offset, cursor.x - offset - width, minX, maxX);
	const y = pickAxis(cursor.y + offset, cursor.y - offset - height, minY, maxY);
	return { x: Math.round(x), y: Math.round(y) };
}
