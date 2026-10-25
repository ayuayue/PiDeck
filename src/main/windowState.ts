import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 主窗口几何记忆（startupWindowMode="last" 的存储层）。
 * 关闭窗口/退出应用时保存 normal bounds（最大化/全屏时取 getNormalBounds）及是否最大化，
 * 下次启动按记录的位置与尺寸打开；文件放在 userData/last-window-bounds.json，
 * 与用户设置（settings.json）分离——这是运行时状态而非用户显式配置。
 *
 * x/y/maximized 为可选：早期版本只存宽高，旧文件读出来没有位置时回退到主显示器居中，
 * 不要求用户清理记录。
 */

export type LastWindowBounds = {
	width: number;
	height: number;
	x?: number;
	y?: number;
	maximized?: boolean;
	workArea?: WindowWorkArea;
};

/** BrowserWindow 当前的最小产品尺寸；workArea 不足时仍优先保留这两个下限。 */
export const MIN_WINDOW_WIDTH = 880;
export const MIN_WINDOW_HEIGHT = 640;

/**
 * 无位置记录或需要纠正离屏几何时，相对 workArea 的安全内边距（DIP）。
 * 已记录的可见窗口不套用内边距，否则贴边/吸附位置与尺寸会被改写。
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
 * 将启动几何收敛到目标显示器的 workArea。
 *
 * 已记录的位置和尺寸在 workArea 内时直接还原；工作区未变时也保留与其相交的原生外框，
 * 因为 Windows 的不可见 resize border 可伸出 workArea，并不表示可见窗口越界。
 * https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowrect
 *
 * 其余情况按 workArea 减安全内边距裁到可容纳；workArea 某一维小于最小窗口尺寸时无法同时
 * 满足「完全适配」和现有最小窗口约束，因此保留最小值，避免额外引入会改变产品行为的动态
 * minWidth/minHeight。
 *
 * 位置：记录带 x/y 时钳制到 workArea 内（显示器拔掉/分辨率变化后窗口不会落到看不见的地方，
 * 但仍尽量贴近用户上次放的位置）；没有 x/y（旧记录或预设模式）时在 workArea 内居中，
 * 由调用方用主显示器作为确定的目标显示器。
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

	if (typeof bounds.x === "number" && typeof bounds.y === "number" && Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) {
		const x = Math.round(bounds.x);
		const y = Math.round(bounds.y);
		const right = x + requestedWidth;
		const bottom = y + requestedHeight;
		const areaRight = areaX + areaWidth;
		const areaBottom = areaY + areaHeight;
		const fits = x >= areaX && y >= areaY && right <= areaRight && bottom <= areaBottom;
		const sameWorkArea = bounds.workArea?.x === areaX && bounds.workArea.y === areaY && bounds.workArea.width === areaWidth && bounds.workArea.height === areaHeight;
		const intersects = x < areaRight && y < areaBottom && right > areaX && bottom > areaY;
		if (fits || (sameWorkArea && intersects)) return { x, y, width: requestedWidth, height: requestedHeight };
	}

	const availableWidth = areaWidth - WINDOW_WORK_AREA_INSET * 2;
	const availableHeight = areaHeight - WINDOW_WORK_AREA_INSET * 2;
	const width = availableWidth >= MIN_WINDOW_WIDTH ? Math.min(requestedWidth, availableWidth) : MIN_WINDOW_WIDTH;
	const height = availableHeight >= MIN_WINDOW_HEIGHT ? Math.min(requestedHeight, availableHeight) : MIN_WINDOW_HEIGHT;

	return {
		x: resolveAxisPosition(bounds.x, width, areaX, areaWidth),
		y: resolveAxisPosition(bounds.y, height, areaY, areaHeight),
		width,
		height,
	};
}

/**
 * 单轴定位：有记录位置则钳制到 [areaStart+inset, areaEnd-inset-size]；窗口比可用区还大
 * （最小尺寸兜底触发）时只能贴左/上边。无记录则居中。
 */
function resolveAxisPosition(recorded: number | undefined, size: number, areaStart: number, areaSize: number): number {
	if (typeof recorded !== "number" || !Number.isFinite(recorded)) {
		return areaStart + Math.round((areaSize - size) / 2);
	}
	const minimum = areaStart + WINDOW_WORK_AREA_INSET;
	const maximum = areaStart + areaSize - WINDOW_WORK_AREA_INSET - size;
	if (maximum < minimum) return areaStart;
	return Math.min(Math.max(Math.round(recorded), minimum), maximum);
}

/**
 * 读取上次窗口几何；文件缺失/损坏/尺寸过小（小于最小窗口 880×640）时返回 null，由调用方顺延默认。
 * x/y 缺失或非有限数时整体丢弃位置（不允许只有一个轴），maximized 非 true 一律按 false。
 */
export function readLastWindowBounds(dir: string): LastWindowBounds | null {
	try {
		const raw = readFileSync(join(dir, "last-window-bounds.json"), "utf8");
		const data = JSON.parse(raw) as Partial<LastWindowBounds>;
		if (typeof data.width === "number" && typeof data.height === "number" && Number.isFinite(data.width) && Number.isFinite(data.height) && data.width >= MIN_WINDOW_WIDTH && data.height >= MIN_WINDOW_HEIGHT) {
			return {
				width: Math.round(data.width),
				height: Math.round(data.height),
				...readPosition(data.x, data.y),
				...(data.maximized === true ? { maximized: true } : {}),
				...readWorkArea(data.workArea),
			};
		}
	} catch {
		// 文件不存在或 JSON 损坏：按无记录处理
	}
	return null;
}

/** 保存上次窗口几何（坐标与宽高取整，防抖由调用方控制） */
export function saveLastWindowBounds(dir: string, bounds: LastWindowBounds): void {
	try {
		mkdirSync(dir, { recursive: true });
		const payload: LastWindowBounds = {
			width: Math.round(bounds.width),
			height: Math.round(bounds.height),
			...readPosition(bounds.x, bounds.y),
			...(bounds.maximized === true ? { maximized: true } : {}),
			...readWorkArea(bounds.workArea),
		};
		writeFileSync(join(dir, "last-window-bounds.json"), JSON.stringify(payload), "utf8");
	} catch {
		// 磁盘/权限失败静默：窗口记忆是可选的体验增强，不影响主流程
	}
}

/** 两轴都是有限数才算有位置记录；只有一轴时丢弃，避免半截坐标把窗口摆到奇怪的地方。 */
function readPosition(x: unknown, y: unknown): { x: number; y: number } | Record<string, never> {
	if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) {
		return { x: Math.round(x), y: Math.round(y) };
	}
	return {};
}

/** 工作区快照用于判断是否可以精确恢复原生外框；旧记录或无效快照仍走原有离屏纠正。 */
function readWorkArea(value: unknown): { workArea: WindowWorkArea } | Record<string, never> {
	if (!value || typeof value !== "object" || !("x" in value) || !("y" in value) || !("width" in value) || !("height" in value)) return {};
	if (typeof value.x !== "number" || typeof value.y !== "number" || !Number.isFinite(value.x) || !Number.isFinite(value.y) || typeof value.width !== "number" || typeof value.height !== "number") return {};
	const width = normalizeWorkAreaDimension(value.width);
	const height = normalizeWorkAreaDimension(value.height);
	if (width === null || height === null) return {};
	return { workArea: { x: Math.round(value.x), y: Math.round(value.y), width, height } };
}
