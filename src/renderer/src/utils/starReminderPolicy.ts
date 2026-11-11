/**
 * 「给项目点个 Star」提醒的判定逻辑（纯函数，可单测；调度与弹窗见 hooks/useStarReminder.ts）。
 *
 * 这是一条营销式提示，属于最容易招人烦的一类打扰，所以克制条件全部收在这里，
 * 调松/调紧只改下面的常量：
 * - 用满一天才开口：firstSeenAt 距今不足 STAR_REMINDER_MIN_AGE_MS 不提醒（当天安装当天不打扰）；
 * - 本次运行先跑满 STAR_REMINDER_MIN_UPTIME_MS：不在启动期抢注意力；
 * - 一天最多一次：STAR_REMINDER_INTERVAL_MS 由 localStorage 的 lastShownAt 跨重启/跨天保证；
 * - 用户点过「不再提醒」或「去点 Star」后永不再弹（dismissed，本机永久）；
 * - 模态框打开 / 窗口不在前台时不弹（blocked），等下一次检查。
 *
 * 状态只存渲染层 localStorage：它不是功能设置，而是「这条提示已经打扰过你几次」的
 * 本地记账，与 settings.json（用户配置，会随备份/同步迁移）语义不同。
 */

/** localStorage 键（带版本号）：结构变更时换 v2，旧键自然失效，不做迁移。 */
export const STAR_REMINDER_STORAGE_KEY = "pideck:star-reminder:v1";

/** 首次记录距今至少要满多久才允许开口（1 天）：新用户当天安装当天不被打扰。 */
export const STAR_REMINDER_MIN_AGE_MS = 24 * 60 * 60_000;

/** 本次运行至少持续多久才允许开口（15 分钟）：避开启动、恢复会话、装依赖这些忙时。 */
export const STAR_REMINDER_MIN_UPTIME_MS = 15 * 60_000;

/** 两次提醒的最小间隔（24 小时）：需求口径是「一天最多一次」。 */
export const STAR_REMINDER_INTERVAL_MS = 24 * 60 * 60_000;

/** 达到可提醒时间后的复查间隔（5 分钟）：用于等待「窗口回到前台」「模态框关掉」等时机。 */
export const STAR_REMINDER_POLL_INTERVAL_MS = 5 * 60_000;

/** 单次检查的最小延迟（ms）：防止时间差为负时 0 延迟自旋。 */
export const STAR_REMINDER_MIN_CHECK_MS = 1_000;

export type StarReminderState = {
	/** 用户已经明确不需要这条提醒：点过「不再提醒」，或已经点过「去点 Star」。 */
	dismissed: boolean;
	/** 首次记录时间（epoch ms）：MIN_AGE 的计时起点，写入后不再变动。 */
	firstSeenAt: number;
	/** 上次弹出的时间（epoch ms）：0 = 从未弹过。 */
	lastShownAt: number;
};

/** 读一个时间戳字段：非法/非正数回落到 fallback，未来值（时钟回拨）封顶到 now。 */
function readTimestamp(value: unknown, fallback: number, now: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	// 未来值会让「已经过去多久」永久为负 = 永远不提醒，所以封顶到当前时间（最坏晚一天）
	return Math.min(value, now);
}

/**
 * 解析 localStorage 里的原始 JSON：缺字段、坏 JSON、脏类型一律回落默认值，
 * 保证「读不出来」只会变成「重新计时」，而不是永不提醒或每次都提醒。
 * 首次读取（raw 为 null）时 firstSeenAt = now，调用方应立即写回。
 */
export function parseStarReminderState(raw: string | null, now: number): StarReminderState {
	if (!raw) return { dismissed: false, firstSeenAt: now, lastShownAt: 0 };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { dismissed: false, firstSeenAt: now, lastShownAt: 0 };
	}
	if (!parsed || typeof parsed !== "object") return { dismissed: false, firstSeenAt: now, lastShownAt: 0 };
	const record = parsed as Record<string, unknown>;
	return {
		dismissed: record.dismissed === true,
		firstSeenAt: readTimestamp(record.firstSeenAt, now, now),
		lastShownAt: readTimestamp(record.lastShownAt, 0, now),
	};
}

export type StarReminderContext = {
	state: StarReminderState;
	/** 当前时间（epoch ms）。 */
	now: number;
	/** 本次运行已持续时长（ms）。 */
	uptimeMs: number;
	/** 当前是否处于「不该打扰」状态：模态框打开 / 窗口不在前台。 */
	blocked: boolean;
};

/** 是否该弹这条提醒（全部条件同时满足才弹，任一不满足就等下一次检查）。 */
export function shouldPromptStarReminder(ctx: StarReminderContext): boolean {
	if (ctx.state.dismissed) return false;
	if (ctx.blocked) return false;
	if (ctx.uptimeMs < STAR_REMINDER_MIN_UPTIME_MS) return false;
	if (ctx.now - ctx.state.firstSeenAt < STAR_REMINDER_MIN_AGE_MS) return false;
	if (ctx.now - ctx.state.lastShownAt < STAR_REMINDER_INTERVAL_MS) return false;
	return true;
}

/**
 * 下一次检查的延迟：未到 15 分钟时按复查间隔逐步靠近（不会早弹，也不会睡死到错过时机），
 * 到点后固定按复查间隔轮询（等前台/模态关闭，也能在跑了一夜后跨天自动补弹）。
 */
export function nextStarReminderCheckDelayMs(uptimeMs: number): number {
	const remaining = STAR_REMINDER_MIN_UPTIME_MS - uptimeMs;
	// 已过 15 分钟：固定复查间隔（不能返回 0/负数，否则变成 1s 级自旋轮询）
	if (remaining <= 0) return STAR_REMINDER_POLL_INTERVAL_MS;
	return Math.max(STAR_REMINDER_MIN_CHECK_MS, Math.min(STAR_REMINDER_POLL_INTERVAL_MS, remaining));
}
