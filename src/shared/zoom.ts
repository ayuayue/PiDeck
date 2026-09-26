/**
 * 窗口整体缩放（zoomFactor）的档位定义与纯计算。
 *
 * 单一数据源：设置页「外观 → 窗口缩放」的加减按钮与全局快捷键（shared/shortcuts.ts
 * 的 zoomIn/zoomOut）共用同一套边界与步长，避免「按钮能到 150%、快捷键到 155%」这类漂移。
 * 只放纯函数与常量，主进程按此结果调用 webContents.setZoomFactor，不依赖 electron 运行时。
 */

/** 缩放下限（80%）：再小会让主界面图标与正文难以辨认 */
export const ZOOM_FACTOR_MIN = 0.8;
/** 缩放上限（150%）：再大在 1080p 上会严重挤压会话与侧栏 */
export const ZOOM_FACTOR_MAX = 1.5;
/** 每一档的步长（5%），与设置页加减按钮一致 */
export const ZOOM_FACTOR_STEP = 0.05;

/**
 * 把任意值钳制到合法档位并保留两位小数。
 * 非有限值（NaN/Infinity）回落 100%，避免把坏值写进 settings.json；
 * 取整到百分位是防浮点误差累积（0.05 连续相加会得到 1.0500000000000003）。
 */
export function clampZoomFactor(value: number): number {
	const safe = Number.isFinite(value) ? value : 1;
	return Math.min(ZOOM_FACTOR_MAX, Math.max(ZOOM_FACTOR_MIN, Math.round(safe * 100) / 100));
}

/** 在当前比例上加减一档（in=放大，out=缩小），结果已钳制到 [MIN, MAX]。 */
export function nextZoomFactor(current: number, direction: "in" | "out"): number {
	const safe = Number.isFinite(current) ? current : 1;
	return clampZoomFactor(safe + (direction === "in" ? ZOOM_FACTOR_STEP : -ZOOM_FACTOR_STEP));
}
