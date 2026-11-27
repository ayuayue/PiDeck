/**
 * 内置浏览器安全策略共享模块：webview 宿主（旧管线）与 WebContentsView
 * 管理器（UI 2.0 / issue #115 U4）必须使用完全一致的 URL 白名单与 partition，
 * 任何一处修改都要同时生效，故收敛到单一事实源。
 */

import { browserHtmlPreviewFileName } from "../../shared/htmlPreview";

export const BROWSER_PANEL_PARTITION = "persist:pideck-browser-panel";

/** 通常的浏览器及 Agent 导航仅允许 HTTP(S) 和空白页。 */
export function isAllowedBrowserPanelUrl(targetUrl: string): boolean {
	if (targetUrl === "about:blank") return true;
	try {
		const protocol = new URL(targetUrl).protocol;
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

/** 只有浏览器宿主主框架可加载 PiDeck 自己生成的 HTML 预览。 */
export function isAllowedBrowserPanelFrameUrl(url: string, isMainFrame: boolean): boolean {
	return isAllowedBrowserPanelUrl(url) || (isMainFrame && browserHtmlPreviewFileName(url) !== null);
}
