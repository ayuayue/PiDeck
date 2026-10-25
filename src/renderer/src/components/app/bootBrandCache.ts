/**
 * 启动画面品牌缓存：开屏在 React 挂载前渲染（src/renderer/index.html 的内联脚本），读不到设置，
 * 只能读 localStorage。键名在 index.html 里逐字镜像（内联脚本不能 import）——
 * 改任一侧都要同步另一侧，tests/piTuiLogo.test.mjs 会核对。
 */

/** 应用显示名称（品牌区/关于弹层同源值）。 */
export const BOOT_APP_NAME_STORAGE_KEY = "pideck:app-name:v1";
/** 自定义 logo 图（data URL）；仅在 logo 风格为 custom 时写入。 */
export const BOOT_CUSTOM_LOGO_STORAGE_KEY = "pideck:custom-logo:v1";

/**
 * 写入开屏品牌缓存。
 *
 * customLogoDataUrl 为空（未使用自定义风格/已清除）时必须删掉旧图：只靠 class 判断的话，
 * 用户从自定义切回内置风格后，开屏仍会显示上一张图（图还在缓存里）。
 * localStorage 不可用（隐私模式）或超出配额时静默降级：只影响下次开屏的品牌位，不影响应用本身。
 */
export function writeBootBrandCache(displayName: string, customLogoDataUrl: string): void {
	try {
		window.localStorage.setItem(BOOT_APP_NAME_STORAGE_KEY, displayName);
		if (customLogoDataUrl === "") {
			window.localStorage.removeItem(BOOT_CUSTOM_LOGO_STORAGE_KEY);
		} else {
			window.localStorage.setItem(BOOT_CUSTOM_LOGO_STORAGE_KEY, customLogoDataUrl);
		}
	} catch {
		// 配额/权限失败：开屏回落默认品牌
	}
}
