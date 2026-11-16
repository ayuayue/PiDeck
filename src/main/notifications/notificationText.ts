/**
 * 通知文本长度收口。
 *
 * 会话标题由首条消息自动生成，实测可出现上万字符的超长标题；系统 toast 与宠物气泡的
 * 展示位都只有一两行，超长文本不会多显示，却会让 toast XML / 气泡文本测量膨胀，
 * Windows Shell 处理大 XML 期间主进程的 `Notification.show()` 会明显卡顿。
 *
 * 统一按**码点**截断（不拆 emoji 代理对），标题与正文分别设上限。
 */
export const NOTIFICATION_TITLE_MAX_CHARS = 64;
export const NOTIFICATION_BODY_MAX_CHARS = 256;

export function clampNotificationText(text: string, maxChars: number): string {
	const trimmed = text.trim();
	const chars = Array.from(trimmed);
	return chars.length <= maxChars ? trimmed : `${chars.slice(0, maxChars).join("")}…`;
}

export const clampNotificationTitle = (text: string): string => clampNotificationText(text, NOTIFICATION_TITLE_MAX_CHARS);
export const clampNotificationBody = (text: string): string => clampNotificationText(text, NOTIFICATION_BODY_MAX_CHARS);
