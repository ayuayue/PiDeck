import { desktopApi } from "../desktopApi";
import { applyAppearanceAttributes } from "../themeAppearance";

/**
 * 浮窗主题：与主窗口共用同一份外观设置（明暗/外观主题/主色）。
 *
 * 浮窗是常驻窗口（隐藏复用，不重新加载页面），所以每次弹出前都重读一次设置：
 * 用户在主窗口换主题后，下一次划词就能看到新皮肤，不需要重启。
 * 读取失败时保留 foundation.css 的默认浅色 token——能用比皮肤一致更重要。
 */
export async function applySelectionWindowAppearance(): Promise<void> {
	try {
		const settings = await desktopApi.settings.get();
		applyAppearanceAttributes(document.documentElement, settings, window.matchMedia("(prefers-color-scheme: dark)").matches);
	} catch {
		// 设置不可读（主进程重启中/权限异常）：保持当前属性不变，不打断浮窗使用。
	}
}
