/**
 * 系统通知（Windows toast）的统一构造：品牌字标 + 点击跳转 URL。
 *
 * 两件事收口在这里，避免 AgentManager / index.ts 各拼一份 XML 后漂移：
 * 1. `appLogoOverride` 用**透明底字标**（resources/notification-logo.png），而不是应用图标。
 *    应用图标是「近黑圆角底板 + 彩色字标」：深色 toast 下底板比背景更暗、浅色 toast 下是明显方块，
 *    视觉上就是用户反馈的「logo 外一层边框」；通知里只需要字标本身。
 * 2. launch 统一走 `pideck://session/<id>`，点击后由深链处理聚焦窗口并跳到该会话。
 *
 * 资源缺失（老包/裁剪包）时静默去掉 image 元素，退回系统默认图标，绝不让通知构造失败。
 * 本模块不 import electron：路径信息由调用方传入，便于单测。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { APP_DEEP_LINK_SCHEME } from "../utils/deepLinkScheme";

/** extraResources 的 `to` 名（打包态 resources/notification-logo.png；dev 态仓库 resources/） */
export const NOTIFICATION_LOGO_FILENAME = "notification-logo.png";

let cachedLogoUri: string | null | undefined;

/**
 * 字标 file:// URI（进程内缓存）。
 * @param input.isPackaged app.isPackaged
 * @param input.resourcesPath process.resourcesPath（打包态）
 * @param input.appPath app.getAppPath()（dev 态仓库根）
 */
export function resolveNotificationLogoUri(input: { isPackaged: boolean; resourcesPath: string; appPath: string }): string | null {
	if (cachedLogoUri !== undefined) return cachedLogoUri;
	try {
		const logoPath = input.isPackaged ? join(input.resourcesPath, NOTIFICATION_LOGO_FILENAME) : join(input.appPath, "resources", NOTIFICATION_LOGO_FILENAME);
		cachedLogoUri = existsSync(logoPath) ? pathToFileURL(logoPath).href : null;
	} catch {
		cachedLogoUri = null;
	}
	return cachedLogoUri;
}

/** 仅测试用：清掉进程内路径缓存 */
export function resetNotificationLogoCacheForTest(): void {
	cachedLogoUri = undefined;
}

/** toast 点击后的跳转 URL：有会话则直达该会话，否则只唤起应用。 */
export function notificationLaunchUrl(sessionId?: string): string {
	return sessionId ? `${APP_DEEP_LINK_SCHEME}://session/${sessionId}` : `${APP_DEEP_LINK_SCHEME}://`;
}

/**
 * 构造 toast XML。
 * `activationType="protocol"` + `launch` 让点击经深链回到主进程；字标为可选的 appLogoOverride。
 */
export function buildToastXml(input: { title: string; body: string; launch: string; logoUri?: string | null }): string {
	const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	const logo = input.logoUri ? `\n      <image placement="appLogoOverride" hint-crop="none" src="${esc(input.logoUri)}" />` : "";
	return `<toast activationType="protocol" launch="${esc(input.launch)}">
  <visual>
    <binding template="ToastGeneric">
      <text>${esc(input.title)}</text>
      <text>${esc(input.body)}</text>${logo}
    </binding>
  </visual>
  <audio src="ms-winsoundevent:Notification.Default" />
</toast>`;
}
