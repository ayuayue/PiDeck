/**
 * 在系统默认浏览器中打开 URL，绕过应用的"应用内窗口"设置。
 *
 * 只要应用运行在 Electron 主窗口（非 web service 预览），
 * `window.piDesktop` 就可用；此处通过类型断言确保两侧都能编译。
 */
export function openInSystemBrowser(url: string): void {
	const api = (window as unknown as {
		piDesktop?: { app?: { openExternal: (u: string, force?: boolean) => Promise<void> } };
	}).piDesktop;
	if (api?.app?.openExternal) {
		void api.app.openExternal(url, true);
	}
}
