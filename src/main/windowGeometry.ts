import type { BrowserWindow } from "electron";

/** 窗口尺寸（DIP）。 */
export interface WindowSize {
	width: number;
	height: number;
}

/**
 * 移动窗口并强制回到设计尺寸。
 *
 * 透明/无边框窗口在 Windows 上会被系统放大 bounds（2026-11 实测悬浮球 224×104 → 690×632），
 * 只调 `setPosition` 时后续位置按放大后的 bounds 计算，窗口内可视内容的锚点会持续漂移。
 * 所有高频移动一律走这里，用设计尺寸覆盖本次 setBounds。
 */
export function moveWindowWithSize(win: BrowserWindow, x: number, y: number, size: WindowSize): void {
	win.setBounds({ x: Math.round(x), y: Math.round(y), width: size.width, height: size.height });
}

/** 尺寸偏离设计值时只纠正尺寸，不改当前位置。 */
export function ensureWindowSize(win: BrowserWindow, size: WindowSize): void {
	const [width, height] = win.getSize();
	if (width === size.width && height === size.height) return;
	const [x, y] = win.getPosition();
	win.setBounds({ x, y, width: size.width, height: size.height });
}

/**
 * 窗口尺寸守卫：按固定间隔把被系统放大的透明/无边框窗口拉回设计尺寸。
 * 定时器 unref，不阻止进程退出；窗口销毁后自动停止，调用方不必配对 stop。
 */
export class WindowSizeGuard {
	private timer: NodeJS.Timeout | null = null;

	constructor(
		private readonly getWindow: () => BrowserWindow | null,
		private readonly getSize: () => WindowSize,
		private readonly intervalMs = 1000,
	) {}

	start(): void {
		this.stop();
		this.timer = setInterval(() => this.ensure(), this.intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	/** 立即纠正一次；窗口已销毁时顺带停止定时器。 */
	ensure(): void {
		const win = this.getWindow();
		if (!win || win.isDestroyed()) {
			this.stop();
			return;
		}
		ensureWindowSize(win, this.getSize());
	}
}
