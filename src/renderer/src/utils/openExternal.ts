import { desktopApi } from "../desktopApi";

/**
 * 在系统默认浏览器中打开 URL，绕过应用的"应用内窗口"设置。
 *
 * 返回「是否真的交给了系统浏览器」：登录弹框要据此决定「已打开」的提示是否站得住脚。
 * 主进程在 `shell.openExternal` 失败时会 reject，这里收敛成 false（顺带避免未捕获的
 * promise rejection），调用方才有机会对用户说实情。
 */
export function openInSystemBrowser(url: string): Promise<boolean> {
	return desktopApi.app.openExternal(url, true).then(
		() => true,
		() => false,
	);
}
