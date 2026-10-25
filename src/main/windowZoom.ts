/**
 * 窗口整体缩放快捷键的执行器（主窗口与内置浏览器 webview guest 共用）。
 *
 * 键位匹配仍由 appShortcuts.isShortcutInput 负责（注册表 + 用户覆盖 + 等价键兜底），
 * 本模块只做「命中后干什么」：按 shared/zoom 的档位算出下一档 → 立即 setZoomFactor
 * 生效 → 异步持久化到 settings.json（用户选择持久化，重启后保持）。
 *
 * 为什么单独成模块：index.ts 只做装配。缩放要写盘，长按自动重复（isAutoRepeat）
 * 必须跳过，否则一次长按会触发几十次磁盘写入与配置审计日志。
 */
import type { BrowserWindow } from "electron";
import { isShortcutInput } from "./appShortcuts";
import { nextZoomFactor } from "../shared/zoom";
import type { ShortcutInput } from "../shared/shortcuts";

export type WindowZoomHost = {
	/** 当前主窗口（可能尚未创建或已销毁） */
	getWindow: () => BrowserWindow | null;
	/** 读取当前缩放比例（settingsStore.get().zoomFactor） */
	getZoomFactor: () => number;
	/** 持久化缩放比例（settingsStore.update({ zoomFactor })），失败由实现方兜底 */
	persistZoomFactor: (value: number) => void;
	/**
	 * 应用后的通知（可选）：把新比例推给渲染层同步设置态。
	 * 主进程已直接 setZoomFactor，这里不是「让渲染层应用缩放」，而是避免
	 * 设置页「外观 → 窗口缩放」一直显示快捷键改动前的旧百分比。
	 */
	notifyZoomFactor?: (value: number) => void;
};

/** 绑定依赖，返回「命中缩放快捷键则应用并返回 true」的判定函数（调用方负责 preventDefault）。 */
export function createWindowZoomShortcutHandler(host: WindowZoomHost): (input: ShortcutInput) => boolean {
	return function handleWindowZoomShortcut(input: ShortcutInput): boolean {
		const zoomIn = isShortcutInput("zoomIn", input);
		if (!zoomIn && !isShortcutInput("zoomOut", input)) return false;
		// 长按自动重复：命中但不再改档/写盘，避免高频落盘与审计刷屏
		if (input.isAutoRepeat) return true;
		const next = nextZoomFactor(host.getZoomFactor(), zoomIn ? "in" : "out");
		const target = host.getWindow();
		if (target && !target.isDestroyed()) target.webContents.setZoomFactor(next);
		host.persistZoomFactor(next);
		host.notifyZoomFactor?.(next);
		return true;
	};
}
