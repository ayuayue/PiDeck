import { t } from "../i18n";

/**
 * 相对时间格式化（会话行/面板共用）：输入时间戳（ms），输出「刚刚 / n分钟 / n小时 / n天 / n个月」。
 *
 * 分档（2027-03 用户要求，与侧栏计时点配套）：不足 1 分钟统一显示「刚刚」（秒级跳动对会话列表
 * 没有信息量，还会让整行随时在变），不足 1 小时显示分钟、不足 30 天显示天数，更早一律折成月数
 * （不再有「年」档：列表里出现「2年」对「多久前用过」没有帮助）。未来时间戳按 0 处理。
 */
export function formatRelativeTime(ms: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
	if (seconds < 60) return t("session.relativeJustNow");
	if (seconds < 3600) return t("session.relativeMinutes", { count: Math.floor(seconds / 60) });
	if (seconds < 86400) return t("session.relativeHours", { count: Math.floor(seconds / 3600) });
	if (seconds < 2592000) return t("session.relativeDays", { count: Math.floor(seconds / 86400) });
	return t("session.relativeMonths", { count: Math.floor(seconds / 2592000) });
}

/**
 * 绝对时间（用于 hover 详情，避免相对时间歧义）。
 * 走系统 locale（toLocaleString），供 title 等次要提示使用。
 */
export function formatAbsoluteTime(ms: number): string {
	return new Date(ms).toLocaleString();
}

/**
 * 完整日期时间（用于会话悬浮卡片等需要精确、紧凑展示的场景）：
 * 格式为「YYYY-MM-DD HH:mm:ss」，对月日时分秒补零，跨平台输出稳定一致。
 */
export function formatFullDateTime(ms: number): string {
	const d = new Date(ms);
	if (Number.isNaN(d.getTime())) return "";
	const pad = (n: number) => String(n).padStart(2, "0");
	const year = d.getFullYear();
	const month = pad(d.getMonth() + 1);
	const date = pad(d.getDate());
	const hours = pad(d.getHours());
	const minutes = pad(d.getMinutes());
	const seconds = pad(d.getSeconds());
	return `${year}-${month}-${date} ${hours}:${minutes}:${seconds}`;
}
