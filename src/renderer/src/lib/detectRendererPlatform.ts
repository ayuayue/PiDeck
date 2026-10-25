/**
 * 渲染进程同步判定平台。
 * appInfo.platform 要等 IPC，首帧若默认 win32，Mac 会先画出右侧 Win 窗口按钮再消失。
 */
export function detectRendererPlatform(userAgent = navigator.userAgent): NodeJS.Platform {
	if (/Mac/i.test(userAgent) && !/iPhone|iPad|iPod/i.test(userAgent)) return "darwin";
	if (/Linux/i.test(userAgent) && !/Android/i.test(userAgent)) return "linux";
	return "win32";
}
