import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 主窗口大小记忆（startupWindowMode="last" 的存储层）。
 * 关闭窗口/退出应用时保存 normal bounds（最大化/全屏时取 getNormalBounds），
 * 下次启动按记录尺寸打开；文件放在 userData/last-window-bounds.json，
 * 与用户设置（settings.json）分离——这是运行时状态而非用户显式配置。
 */

export type LastWindowBounds = {
	width: number;
	height: number;
};

/** BrowserWindow 当前的最小产品尺寸；workArea 不足时仍优先保留这两个下限。 */
export const MIN_WINDOW_WIDTH = 880;
export const MIN_WINDOW_HEIGHT = 640;

/**
 * 普通还原窗口相对显示器 workArea 的安全内边距（DIP）。
 * Windows 原生 resize frame 可能在 Electron bounds 外扩，整 workArea 尺寸会因此越界。
 */
export const WINDOW_WORK_AREA_INSET = 16;

export type WindowWorkArea = {
	x: number;
	y: number;
	width: number;
	height: number;
};

export type WindowStartupBounds = WindowWorkArea;

function normalizeRequestedDimension(value: number, minimum: number): number {
	if (!Number.isFinite(value)) return minimum;
	return Math.max(minimum, Math.round(value));
}

function normalizeWorkAreaDimension(value: number): number | null {
	if (!Number.isFinite(value) || value <= 0) return null;
	const dimension = Math.floor(value);
	return dimension > 0 ? dimension : null;
}

/**
 * 将启动尺寸收敛到目标显示器的 workArea，并在可行时居中留出安全内边距。
 *
 * 没有持久化 x/y 时，调用方使用主显示器作为确定的目标显示器。workArea 某一维
 * 小于最小窗口尺寸时无法同时满足「完全适配」和现有最小窗口约束，因此保留最小值，
 * 仍按该维居中，避免额外引入会改变产品行为的动态 minWidth/minHeight。
 */
export function constrainWindowBoundsToWorkArea(bounds: LastWindowBounds, workArea: WindowWorkArea): WindowStartupBounds {
	const requestedWidth = normalizeRequestedDimension(bounds.width, MIN_WINDOW_WIDTH);
	const requestedHeight = normalizeRequestedDimension(bounds.height, MIN_WINDOW_HEIGHT);
	const areaX = Number.isFinite(workArea.x) ? Math.round(workArea.x) : 0;
	const areaY = Number.isFinite(workArea.y) ? Math.round(workArea.y) : 0;
	const areaWidth = normalizeWorkAreaDimension(workArea.width);
	const areaHeight = normalizeWorkAreaDimension(workArea.height);

	if (areaWidth === null || areaHeight === null) {
		return { x: 0, y: 0, width: requestedWidth, height: requestedHeight };
	}

	const availableWidth = areaWidth - WINDOW_WORK_AREA_INSET * 2;
	const availableHeight = areaHeight - WINDOW_WORK_AREA_INSET * 2;
	const width = availableWidth >= MIN_WINDOW_WIDTH ? Math.min(requestedWidth, availableWidth) : MIN_WINDOW_WIDTH;
	const height = availableHeight >= MIN_WINDOW_HEIGHT ? Math.min(requestedHeight, availableHeight) : MIN_WINDOW_HEIGHT;

	return {
		x: areaX + Math.round((areaWidth - width) / 2),
		y: areaY + Math.round((areaHeight - height) / 2),
		width,
		height,
	};
}

/** 读取上次窗口大小；文件缺失/损坏/尺寸过小（小于最小窗口 880×640）时返回 null，由调用方顺延默认 */
export function readLastWindowBounds(dir: string): LastWindowBounds | null {
	try {
		const raw = readFileSync(join(dir, "last-window-bounds.json"), "utf8");
		const data = JSON.parse(raw) as Partial<LastWindowBounds>;
		if (typeof data.width === "number" && typeof data.height === "number" && Number.isFinite(data.width) && Number.isFinite(data.height) && data.width >= MIN_WINDOW_WIDTH && data.height >= MIN_WINDOW_HEIGHT) {
			return { width: Math.round(data.width), height: Math.round(data.height) };
		}
	} catch {
		// 文件不存在或 JSON 损坏：按无记录处理
	}
	return null;
}

/** 保存上次窗口大小（宽高取整，防抖由调用方控制） */
export function saveLastWindowBounds(dir: string, bounds: LastWindowBounds): void {
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "last-window-bounds.json"), JSON.stringify({ width: Math.round(bounds.width), height: Math.round(bounds.height) }), "utf8");
	} catch {
		// 磁盘/权限失败静默：窗口记忆是可选的体验增强，不影响主流程
	}
}
