/**
 * DevTools 快捷键与窗口工具。
 *
 * 主窗口 before-input-event、内置浏览器 webview guest 转发、设置页 IPC 三处共用
 * 同一份开关逻辑（isDevToolsShortcut + toggleMainWindowDevTools），避免各自维护
 * 一套快捷键判断；同时兜底 DevTools 窗口落到屏幕外的问题：换屏/分辨率变化后
 * Chromium 会恢复上次的 DevTools 窗口位置，若已不在任何显示器可视区内，
 * 表现为「F12 有反应但看不到窗口」。
 */

import { BrowserWindow, screen } from "electron";
import type { WebContents } from "electron";

/** before-input-event 的输入形状（Electron.Input 的窄化子集，便于单测） */
export type DevToolsInput = {
	key: string;
	type: string;
	control?: boolean;
	meta?: boolean;
	shift?: boolean;
	alt?: boolean;
};

/**
 * 判断输入是否为 DevTools 快捷键。
 * Windows/Linux：F12、Ctrl+Shift+I、Ctrl+Shift+J；macOS：Cmd+Option+I / J
 * （macOS 上 Option 即 Alt，F12 通用）。与浏览器默认快捷键一致。
 */
export function isDevToolsShortcut(input: DevToolsInput): boolean {
	if (input.type !== "keyDown") return false;
	if (input.key === "F12") return true;
	const isMac = process.platform === "darwin";
	const ctrlOrCmd = isMac ? input.meta : input.control;
	const shiftOrOption = input.shift || (isMac && input.alt);
	if (!ctrlOrCmd || !shiftOrOption) return false;
	const key = input.key.toLowerCase();
	return key === "i" || key === "j";
}

export type DisplayArea = { x: number; y: number; width: number; height: number };

/**
 * 纯函数：bounds 是否与任一显示器 workArea 相交。
 * 完全不相交 = 窗口整个落在屏幕外（可见区域为空）。
 */
export function intersectsAnyDisplay(bounds: DisplayArea, displays: readonly DisplayArea[]): boolean {
	return displays.some((area) => {
		return bounds.x < area.x + area.width && bounds.x + bounds.width > area.x && bounds.y < area.y + area.height && bounds.y + bounds.height > area.y;
	});
}

/**
 * 切换主窗口 DevTools 开/关。返回 true 表示已打开，false 表示已关闭或失败。
 * 打开时若 DevTools 窗口完全落在屏幕外（上次位置失效），自动拉回主显示器居中，
 * 窗口尺寸同时收敛到可视区内（保留最小可用的 320×240）。
 */
export function toggleMainWindowDevTools(win: BrowserWindow | null | undefined): boolean {
	if (!win || win.isDestroyed()) return false;
	const wc = win.webContents;
	if (wc.isDevToolsOpened()) {
		wc.closeDevTools();
		return false;
	}
	wc.openDevTools({ mode: "detach" });
	repositionOffscreenDevToolsWindow(wc);
	return true;
}

/** openDevTools 后监听窗口就绪，若落在屏幕外则拉回主屏（一次性的兜底，失败静默跳过）。 */
function repositionOffscreenDevToolsWindow(wc: WebContents): void {
	wc.once("devtools-opened", () => {
		const devToolsWc = wc.devToolsWebContents;
		const devToolsWin = devToolsWc ? BrowserWindow.fromWebContents(devToolsWc) : null;
		if (!devToolsWin || devToolsWin.isDestroyed()) return;
		const bounds = devToolsWin.getBounds();
		const displays = screen.getAllDisplays().map((d) => d.workArea);
		if (intersectsAnyDisplay(bounds, displays)) return;
		const work = screen.getPrimaryDisplay().workArea;
		const width = Math.min(bounds.width, Math.max(320, work.width - 80));
		const height = Math.min(bounds.height, Math.max(240, work.height - 80));
		devToolsWin.setBounds({
			x: work.x + Math.max(0, Math.round((work.width - width) / 2)),
			y: work.y + Math.max(0, Math.round((work.height - height) / 2)),
			width,
			height,
		});
	});
}
