import { app, nativeImage, type BrowserWindow, type NativeImage, type Tray } from "electron";
import { getAppLogger } from "./logging/sharedLogger";
import { resolveLogoStyle, type LogoStyle } from "../shared/types/settings";
// electron-vite ?asset：构建时复制到输出目录并返回运行时路径（与 index.ts 的 iconPath 同模式）
import classicIconPath from "../../build/icon.png?asset";
import piTuiIconPath from "../../build/icon-pi-tui.png?asset";

/** 托盘图标渲染尺寸：源图是 256/512，直接塞给 Tray 在 Windows 上糊、在 Linux 上撑爆面板行高。 */
const TRAY_ICON_SIZE = 16;

/**
 * 解析 logo 风格对应的图标位图；资源缺失（打包漏带/清理工具误删）返回 null，由调用方保持当前图标。
 *
 * 窗口与托盘共用这一条解析路径：两处各自 createFromPath 会在新增风格时漏改其中一处。
 * custom 风格读 logoCustomImage（data URL）；图缺失/解不开时回落默认位图，不出现「无图标」。
 */
export function resolveLogoImage(style: LogoStyle | string | null | undefined, customLogoDataUrl?: string | null): { resolved: LogoStyle; image: NativeImage } | null {
	let resolved = resolveLogoStyle(style);
	let image: NativeImage | null = null;
	if (resolved === "custom") {
		image = createCustomLogoImage(customLogoDataUrl);
		// 回落档与渲染层 LogoMark 保持一致（都走默认标），否则同一设置下窗口图标与界面会各显一个标
		if (!image) resolved = "pi-tui";
	}
	if (!image) image = nativeImage.createFromPath(resolved === "pi-tui" ? piTuiIconPath : classicIconPath);
	if (image.isEmpty()) {
		// 图标资源缺失只影响本风格图标不生效，降级日志不抛
		void getAppLogger()?.warn("app-logo", "Logo style icon image is empty, keeping current icon", { resolved });
		return null;
	}
	return { resolved, image };
}

/** 自定义 logo 位图：只收内联 data:image/*（挡住路径/远程 URL），解不开返回 null 由调用方回落默认位图。 */
function createCustomLogoImage(dataUrl: string | null | undefined): NativeImage | null {
	if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) return null;
	try {
		const image = nativeImage.createFromDataURL(dataUrl);
		return image.isEmpty() ? null : image;
	} catch (error) {
		void getAppLogger()?.warn("app-logo", "Failed to decode custom logo image, falling back to default mark", { error: error instanceof Error ? error.message : String(error) });
		return null;
	}
}

/**
 * 应用窗口/任务栏/Dock 图标的 logo 风格切换。
 *
 * 边界：安装包与 exe 的静态图标（build/icon.ico|icns）在构建期烘进二进制，运行时改不了——
 * 这里只管运行时 setIcon：Windows 任务栏/标题栏、Linux 任务栏走 BrowserWindow.setIcon，
 * macOS 走 app.dock.setIcon（窗口左上角是交通灯，无窗口图标概念）。
 * 托盘不在此函数内：Tray 实例归 index.ts 持有，见下方 applyTrayLogoStyle。
 */
export function applyWindowLogoStyle(style: LogoStyle | string | null | undefined, getMainWindow: () => BrowserWindow | null, customLogoDataUrl?: string | null): void {
	const entry = resolveLogoImage(style, customLogoDataUrl);
	if (!entry) return;
	const { resolved, image } = entry;
	const win = getMainWindow();
	if (win && !win.isDestroyed()) {
		try {
			win.setIcon(image);
		} catch (error) {
			void getAppLogger()?.warn("app-logo", "Failed to set window icon", { resolved, error: error instanceof Error ? error.message : String(error) });
		}
	}
	if (process.platform === "darwin" && app.dock) {
		try {
			app.dock.setIcon(image);
		} catch (error) {
			void getAppLogger()?.warn("app-logo", "Failed to set dock icon", { resolved, error: error instanceof Error ? error.message : String(error) });
		}
	}
}

/**
 * 应用托盘图标的 logo 风格切换；Tray 实例归 index.ts 持有，这里按 getTray 取当前实例。
 *
 * 托盘可能尚未创建（setupTray 在 whenReady 之后）或已被退出清理销毁，两种情况都静默跳过——
 * 下次 setupTray 会按当时的设置值重新建出正确风格。
 */
export function applyTrayLogoStyle(style: LogoStyle | string | null | undefined, getTray: () => Tray | null, customLogoDataUrl?: string | null): void {
	const entry = resolveLogoImage(style, customLogoDataUrl);
	if (!entry) return;
	const { resolved, image } = entry;
	const tray = getTray();
	if (!tray || tray.isDestroyed()) return;
	try {
		tray.setImage(image.resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE }));
	} catch (error) {
		void getAppLogger()?.warn("app-logo", "Failed to set tray icon", { resolved, error: error instanceof Error ? error.message : String(error) });
	}
}
