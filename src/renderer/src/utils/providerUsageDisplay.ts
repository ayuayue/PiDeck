/**
 * Provider 用量展示纯函数（无 React）：三处（圆球面板 / 模型卡片 / 模型选择器行）
 * 共用的格式化、状态档位与相对时间。视觉规则学自 cc-switch UsageFooter/TierBadge：
 * - 百分比档位：≥90% 红、≥70% 橙、其余绿（utilizationColor 同款阈值）；
 * - 余额/剩余量：≤0 红、不足总额 10% 橙、其余绿；
 * - 查询失败/无可用数值 → null（三处统一「不渲染」，避免报错噪音）。
 */
import type { TranslationKey } from "../i18n";
import type { I18nParams } from "../../../shared/types";
import type { ProviderUsageResult } from "../../../shared/types/providerUsage";

/** 用量状态档位（cc-switch utilizationColor 语义）。 */
export type UsageTone = "ok" | "low" | "empty" | "neutral";

/** tone → 文字色（cc-switch text-green-600/orange-500/red-500 同款，含暗色变体）。 */
export const USAGE_TONE_TEXT_CLASS: Record<UsageTone, string> = {
	ok: "text-green-600 dark:text-green-400",
	low: "text-orange-500 dark:text-orange-400",
	empty: "text-red-500 dark:text-red-400",
	neutral: "text-text-tertiary",
};

/** tone → 进度条填充色（TierBar 同款：绿/橙/红）。 */
export const USAGE_TONE_BAR_CLASS: Record<UsageTone, string> = {
	ok: "bg-green-500",
	low: "bg-orange-500",
	empty: "bg-red-500",
	neutral: "bg-text-tertiary",
};

/** 币种代码 → 常用符号（未知代码原样展示，避免硬编码映射丢失币种）。 */
export function currencySymbol(code?: string): string {
	switch ((code ?? "").toUpperCase()) {
		case "CNY":
		case "RMB":
			return "¥";
		case "USD":
			return "$";
		case "EUR":
			return "€";
		case "GBP":
			return "£";
		default:
			return (code ?? "").trim();
	}
}

/** 金额/点数格式化：最多两位小数，整数不显示小数点。 */
export function formatAmount(n: number): string {
	const rounded = Math.round(n * 100) / 100;
	return String(rounded);
}

/** 有常用符号映射的币种代码（其余代码作为后缀展示，避免「XYZ3.5」这类粘连）。 */
const KNOWN_CURRENCY_CODES = new Set(["CNY", "RMB", "USD", "EUR", "GBP"]);

/** 余额展示：已知币种用「¥110」符号前缀，未知代码用「110 XYZ」后缀，无币种只用数字。 */
export function formatBalance(balance: { value: number; currency?: string }): string {
	const code = (balance.currency ?? "").trim();
	const amount = formatAmount(balance.value);
	if (code && KNOWN_CURRENCY_CODES.has(code.toUpperCase())) {
		return `${currencySymbol(code)}${amount}`;
	}
	if (code) return `${amount} ${code}`;
	return amount;
}

/**
 * 结果里可推导出的最高用量百分比（0-100，封顶）。
 * - periods：取 rolling/weekly/monthly 中已上报的最大值（任一窗口吃紧都要警示）；
 * - credits：优先 windows 逐窗算 used/total（total>0），否则主值 used/total（remaining 可反推 used）；
 * - balance：无上限概念，返回 null。
 */
export function usagePercent(result: ProviderUsageResult): number | null {
	if (!result.success) return null;
	if (result.kind === "periods" && result.periods) {
		const values = Object.values(result.periods)
			.map((period) => period?.percent)
			.filter((value): value is number => typeof value === "number");
		if (values.length === 0) return null;
		return Math.min(100, Math.max(...values));
	}
	if (result.kind === "credits" && result.credits) {
		const credits = result.credits;
		const fromWindow = (total?: number, used?: number): number | null => {
			if (total == null || used == null || total <= 0) return null;
			return Math.min(100, Math.round((used / total) * 100));
		};
		const usedOf = (total?: number, used?: number, remaining?: number): number | undefined =>
			used ?? (remaining != null && total != null ? total - remaining : undefined);
		const windowPercents = (credits.windows ?? [])
			.map((window) => fromWindow(window.total, usedOf(window.total, window.used, window.remaining)))
			.filter((value): value is number => value != null);
		if (windowPercents.length > 0) return Math.max(...windowPercents);
		const mainPercent = fromWindow(credits.total, usedOf(credits.total, credits.used, credits.remaining));
		if (mainPercent != null) return mainPercent;
		return null;
	}
	return null;
}

/**
 * 展示档位（cc-switch 语义）：
 * - 百分比可得 → ≥90 empty（红）/ ≥70 low（橙）/ 其余 ok（绿）；
 * - balance → 余额 ≤0 empty；credits 剩余 ≤0 empty、不足总额 10% low、其余 ok；
 * - 无任何可判定数值 → neutral（灰）。
 */
export function usageTone(result: ProviderUsageResult): UsageTone {
	const percent = usagePercent(result);
	if (percent != null) {
		if (percent >= 90) return "empty";
		if (percent >= 70) return "low";
		return "ok";
	}
	if (result.kind === "balance" && result.balance) {
		if (result.balance.value <= 0) return "empty";
		return "ok";
	}
	if (result.kind === "credits" && result.credits) {
		const credits = result.credits;
		const remaining = credits.remaining ?? (credits.total != null && credits.used != null ? credits.total - credits.used : undefined);
		if (remaining != null) {
			if (remaining <= 0) return "empty";
			if (credits.total != null && credits.total > 0 && remaining / credits.total < 0.1) return "low";
			return "ok";
		}
		// 只有已用量：无总额可判，中性灰。
		return "neutral";
	}
	return "neutral";
}

/** 档位对应的彩字类（含 dark 变体）。 */
export function usageToneTextClass(result: ProviderUsageResult): string {
	return USAGE_TONE_TEXT_CLASS[usageTone(result)];
}

/** 单个百分比 → 档位（TierBar/逐窗口行用；与 usageTone 同阈值）。 */
export function usageToneForPercent(percent: number | null): UsageTone {
	if (percent == null) return "neutral";
	if (percent >= 90) return "empty";
	if (percent >= 70) return "low";
	return "ok";
}

/**
 * 徽标主值文本：periods/credits-windows → 最高窗口百分比（如 "86%"）；
 * balance → 余额（如 "¥86.3"）；credits 主值 → 剩余优先、已用兜底（如 "120.5"）。
 * 返回 null 表示没有可展示的数值（调用方不渲染）。
 */
export function formatUsageBadgeText(result: ProviderUsageResult): string | null {
	if (!result.success) return null;
	if (result.kind === "periods") {
		const percent = usagePercent(result);
		return percent != null ? `${Math.round(percent)}%` : null;
	}
	if (result.kind === "balance" && result.balance) {
		return formatBalance(result.balance);
	}
	if (result.kind === "credits" && result.credits) {
		const credits = result.credits;
		if ((credits.windows?.length ?? 0) > 0) {
			const percent = usagePercent(result);
			return percent != null ? `${Math.round(percent)}%` : null;
		}
		if (credits.remaining != null) return formatAmount(credits.remaining);
		if (credits.total != null && credits.used != null) return formatAmount(credits.total - credits.used);
		if (credits.used != null) return formatAmount(credits.used);
		return null;
	}
	return null;
}

// ── 多段用量徽标（卡片底部 inline 行）：百分比/金额自带语义标签，多档全部展示 ──

/** 翻译函数形态（与 renderer i18n 的 t 同签名子集）；纯函数不直接依赖 i18n 模块，测试可注入替身。 */
export type UsageTranslate = (key: TranslationKey, params?: I18nParams) => string;

/**
 * 内置候选多窗口 key → i18n key（与详情面板同表——inline 与详情的窗口叫法保持一致）。
 * 未知 key（用户自定义探针的 windows）由 usageWindowLabel 原样展示。
 */
const USAGE_WINDOW_LABEL_KEYS: Record<string, TranslationKey> = {
	fiveHour: "sessionContext.usageWindowFiveHour",
	weekly: "sessionContext.usageWindowWeekly",
	mcpMonthly: "sessionContext.usageWindowMcpMonthly",
	included: "sessionContext.usageWindowIncluded",
	onDemand: "sessionContext.usageWindowOnDemand",
	// Command Code 月度额度池窗口复用 periods 的「本月/Monthly」叫法（i18n 两语言已存在）。
	monthly: "sessionContext.usageMonthly",
};

/** 窗口 key → 标签：内置 key 给 i18n key，未知 key 原样文本（用户自定义窗口名）。 */
export function usageWindowLabel(key: string): { key: TranslationKey } | { text: string } {
	const mapped = USAGE_WINDOW_LABEL_KEYS[key];
	return mapped ? { key: mapped } : { text: key };
}

/** 窗口 key → 已翻译标签文本（inline 段渲染用）。 */
export function usageWindowLabelText(key: string, translate: UsageTranslate): string {
	const label = usageWindowLabel(key);
	return "key" in label ? translate(label.key) : label.text;
}

/** periods 三档 → 标签 i18n key（复用详情面板的「滚动/本周/本月」叫法）。 */
const PERIOD_LABEL_KEYS: Record<"rolling" | "weekly" | "monthly", TranslationKey> = {
	rolling: "sessionContext.usageRolling",
	weekly: "sessionContext.usageWeekly",
	monthly: "sessionContext.usageMonthly",
};

/** 一段带语义标签的用量展示：label（已用/剩/余额/窗口名）+ 数值 + 档位色。 */
export type UsageBadgeSegment = {
	/** i18n key 与原样文本二选一（未知窗口名没有对应 key）。 */
	labelKey?: TranslationKey;
	labelText?: string;
	text: string;
	tone: UsageTone;
};

/** 档位严重度（主段挑选用）：红 > 橙 > 绿 > 灰——选择器行只放一段时优先示警。 */
const TONE_SEVERITY: Record<UsageTone, number> = { empty: 3, low: 2, ok: 1, neutral: 0 };

/** 单窗口的已用百分比（0-100 封顶）：used 缺失时用 total-remaining 反推；无 total 不产生百分比。 */
function usageWindowPercent(window: { total?: number; used?: number; remaining?: number }): number | null {
	const used = window.used ??
		(window.remaining != null && window.total != null ? window.total - window.remaining : undefined);
	if (window.total == null || used == null || window.total <= 0) return null;
	return Math.min(100, (used / window.total) * 100);
}

/**
 * inline 用量段列表（卡片底部多档全展示、选择器行取主段，共用同一份数据形状）：
 * - periods / credits-windows：逐档「窗口名 + 已用百分比」，各档独立档位色；
 *   窗口无总额但有剩余量时退化为「窗口名 + 剩余数值」（灰，避免臆造百分比）；
 * - balance：「余额 + 金额」；
 * - credits 主值：「剩 + 剩余量」（total-used 反推），只有已用量时「已用 + 已用」；
 * booster 不进 inline（点数明细在详情面板展示，inline 保持单行紧凑）。
 * 返回 null = 无可展示数值（调用方不渲染）。
 */
export function usageBadgeSegments(
	result: ProviderUsageResult,
	translate: UsageTranslate,
): UsageBadgeSegment[] | null {
	if (!result.success) return null;
	if (result.kind === "periods" && result.periods) {
		const segments: UsageBadgeSegment[] = [];
		for (const key of ["rolling", "weekly", "monthly"] as const) {
			const period = result.periods[key];
			if (!period || period.percent == null) continue;
			segments.push({
				labelKey: PERIOD_LABEL_KEYS[key],
				text: `${Math.round(Math.min(100, period.percent))}%`,
				tone: usageToneForPercent(period.percent),
			});
		}
		return segments.length > 0 ? segments : null;
	}
	if (result.kind === "balance" && result.balance) {
		return [{ labelKey: "config.usage.balanceShort", text: formatBalance(result.balance), tone: usageTone(result) }];
	}
	if (result.kind === "credits" && result.credits) {
		const credits = result.credits;
		// 逐窗口段：算得出百分比出「窗口名+百分比」；无总额但有剩余量退化为「窗口名+剩余」；
		// 两者都算不出的窗口直接跳过（展示「窗口名 —」是噪音）。
		const windowSegments = (credits.windows ?? []).flatMap((window): UsageBadgeSegment[] => {
			const label = usageWindowLabel(window.key);
			const labelField = "key" in label
				? { labelKey: label.key }
				: { labelText: label.text };
			const percent = usageWindowPercent(window);
			if (percent != null) {
				return [{ ...labelField, text: `${Math.round(percent)}%`, tone: usageToneForPercent(percent) }];
			}
			if (window.remaining == null) return [];
			// 无总额（算不出百分比）但有剩余量：退化为剩余数值（灰），不臆造百分比。
			return [{ ...labelField, text: formatAmount(window.remaining), tone: "neutral" }];
		});
		if ((credits.windows?.length ?? 0) > 0) {
			// 窗口全跳过时落到主值分支（有剩余/已用就别整行消失）。
			if (windowSegments.length > 0) return windowSegments;
		}
		const remaining = credits.remaining ??
			(credits.total != null && credits.used != null ? credits.total - credits.used : undefined);
		if (remaining != null) {
			return [{ labelKey: "config.usage.remainingShort", text: formatAmount(remaining), tone: usageTone(result) }];
		}
		if (credits.used != null) {
			return [{ labelKey: "config.usage.usedShort", text: formatAmount(credits.used), tone: "neutral" }];
		}
		return null;
	}
	return null;
}

/**
 * inline 主段（选择器分组行的单值位）：多档里挑档位最严重的一段示警
 * （与旧「取最高百分比」语义一致——任一窗口吃紧都要先看到）。
 */
export function usageBadgePrimarySegment(
	result: ProviderUsageResult,
	translate: UsageTranslate,
): UsageBadgeSegment | null {
	const segments = usageBadgeSegments(result, translate);
	if (!segments || segments.length === 0) return null;
	return segments.reduce((worst, segment) =>
		TONE_SEVERITY[segment.tone] > TONE_SEVERITY[worst.tone] ? segment : worst,
	segments[0]);
}

/**
 * 相对更新时间（cc-switch inline 的 Clock 行）：刚刚 / n 分钟前 / n 小时前 / n 天前。
 * 超过 30 天或时钟异常回退短日期（避免出现「9999 天前」这类荒谬值）。
 */
export function formatRelativeTime(
	timestamp: number,
	now: number = Date.now(),
): string {
	const elapsed = now - timestamp;
	if (!Number.isFinite(elapsed) || elapsed < 0) return "justNow";
	const minutes = Math.floor(elapsed / 60_000);
	if (minutes < 1) return "justNow";
	if (minutes < 60) return `minutes:${minutes}`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `hours:${hours}`;
	const days = Math.floor(hours / 24);
	if (days <= 30) return `days:${days}`;
	return "stale";
}

/** 相对时间 i18n key 集合（与 rendererCopy 中 config.usage.time* 一一对应）。 */
export type RelativeTimeKey =
	| "config.usage.timeJustNow"
	| "config.usage.timeMinutesAgo"
	| "config.usage.timeHoursAgo"
	| "config.usage.timeDaysAgo"
	| "config.usage.timeStale";

/**
 * 把 formatRelativeTime 的标记翻成 i18n key 与参数（组件层用 t() 渲染）。
 * 独立成纯函数便于单测与复用（详情面板 / inline 卡头共用）。
 */
export function relativeTimeParts(
	timestamp: number,
	now: number = Date.now(),
): { key: RelativeTimeKey; params?: Record<string, number> } {
	const mark = formatRelativeTime(timestamp, now);
	if (mark === "justNow") return { key: "config.usage.timeJustNow" };
	if (mark === "stale") return { key: "config.usage.timeStale" };
	const [unit, raw] = mark.split(":");
	const n = Number(raw);
	if (unit === "minutes") return { key: "config.usage.timeMinutesAgo", params: { n } };
	if (unit === "hours") return { key: "config.usage.timeHoursAgo", params: { n } };
	return { key: "config.usage.timeDaysAgo", params: { n } };
}
