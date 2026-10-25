/**
 * 定时任务 Cron 的可视化状态 ↔ 5 段表达式。
 *
 * 只覆盖常见调度（每 N 分钟 / 每小时 / 每天 / 工作日 / 每周 / 每月）；
 * 解析不了的表达式一律落到 custom，避免把用户手写的复杂规则「猜错」成另一种频率。
 * 主进程仍用 automationCron.ts 做合法性校验；这里只负责 UI 往返。
 */

export const CRON_MINUTE_INTERVALS = [1, 2, 5, 10, 15, 20, 30] as const;

export type CronVisualKind = "every-minutes" | "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "custom";

export type CronVisualState =
	| { kind: "every-minutes"; interval: number }
	| { kind: "hourly"; minute: number }
	| { kind: "daily"; hour: number; minute: number }
	| { kind: "weekdays"; hour: number; minute: number }
	| { kind: "weekly"; days: number[]; hour: number; minute: number }
	| { kind: "monthly"; day: number; hour: number; minute: number }
	| { kind: "custom"; expression: string };

const DEFAULT_HOUR = 9;
const DEFAULT_MINUTE = 0;
const DEFAULT_MONTH_DAY = 1;
const WEEKDAYS = [1, 2, 3, 4, 5];

export const CRON_VISUAL_KINDS: readonly CronVisualKind[] = ["every-minutes", "hourly", "daily", "weekdays", "weekly", "monthly", "custom"];

/** 把可视化状态编成 5 段 cron（分 时 日 月 周）。 */
export function buildCronExpression(state: CronVisualState): string {
	switch (state.kind) {
		case "every-minutes":
			return state.interval <= 1 ? "* * * * *" : `*/${clamp(state.interval, 1, 59)} * * * *`;
		case "hourly":
			return `${clamp(state.minute, 0, 59)} * * * *`;
		case "daily":
			return `${clamp(state.minute, 0, 59)} ${clamp(state.hour, 0, 23)} * * *`;
		case "weekdays":
			return `${clamp(state.minute, 0, 59)} ${clamp(state.hour, 0, 23)} * * 1-5`;
		case "weekly": {
			const days = normalizeDays(state.days);
			return `${clamp(state.minute, 0, 59)} ${clamp(state.hour, 0, 23)} * * ${days.join(",")}`;
		}
		case "monthly":
			return `${clamp(state.minute, 0, 59)} ${clamp(state.hour, 0, 23)} ${clamp(state.day, 1, 31)} * *`;
		case "custom":
			return state.expression.trim();
	}
}

/**
 * 把已保存的表达式尽量还原成可视化状态。
 * 无法安全对应到某一种频率时返回 custom，保留原文给高级输入框。
 */
export function parseCronVisualState(expression: string): CronVisualState {
	const trimmed = expression.trim();
	const parts = trimmed.split(/\s+/);
	if (parts.length !== 5) return { kind: "custom", expression: trimmed };

	const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
	if (month !== "*") return { kind: "custom", expression: trimmed };

	const everyMinutes = matchEveryMinutes(minute);
	if (everyMinutes !== undefined && hour === "*" && dayOfMonth === "*" && dayOfWeek === "*") {
		return { kind: "every-minutes", interval: everyMinutes };
	}

	const minuteValue = parseSingle(minute, 0, 59);
	if (minuteValue === undefined) return { kind: "custom", expression: trimmed };

	if (hour === "*" && dayOfMonth === "*" && dayOfWeek === "*") {
		return { kind: "hourly", minute: minuteValue };
	}

	const hourValue = parseSingle(hour, 0, 23);
	if (hourValue === undefined) return { kind: "custom", expression: trimmed };

	if (dayOfMonth === "*" && dayOfWeek === "*") {
		return { kind: "daily", hour: hourValue, minute: minuteValue };
	}
	if (dayOfMonth === "*" && isWeekdaysField(dayOfWeek)) {
		return { kind: "weekdays", hour: hourValue, minute: minuteValue };
	}
	if (dayOfMonth === "*") {
		const days = parseDayOfWeekList(dayOfWeek);
		if (days && days.length > 0) {
			return { kind: "weekly", days, hour: hourValue, minute: minuteValue };
		}
	}

	const monthDay = parseSingle(dayOfMonth, 1, 31);
	if (monthDay !== undefined && dayOfWeek === "*") {
		return { kind: "monthly", day: monthDay, hour: hourValue, minute: minuteValue };
	}

	return { kind: "custom", expression: trimmed };
}

/** 切换频率时尽量保留已选的时间/星期，避免用户改「每天 → 每周」时把 9:00 丢掉。 */
export function switchCronKind(current: CronVisualState, kind: CronVisualKind): CronVisualState {
	if (kind === current.kind) return current;
	if (kind === "custom") {
		return { kind: "custom", expression: buildCronExpression(current) };
	}
	const time = extractTime(current);
	switch (kind) {
		case "every-minutes":
			return { kind, interval: current.kind === "every-minutes" ? current.interval : 30 };
		case "hourly":
			return { kind, minute: time.minute };
		case "daily":
			return { kind, hour: time.hour, minute: time.minute };
		case "weekdays":
			return { kind, hour: time.hour, minute: time.minute };
		case "weekly":
			return {
				kind,
				days: current.kind === "weekly" ? normalizeDays(current.days) : [...WEEKDAYS],
				hour: time.hour,
				minute: time.minute,
			};
		case "monthly":
			return {
				kind,
				day: current.kind === "monthly" ? current.day : DEFAULT_MONTH_DAY,
				hour: time.hour,
				minute: time.minute,
			};
	}
}

function extractTime(state: CronVisualState): { hour: number; minute: number } {
	if (state.kind === "every-minutes" || state.kind === "custom") {
		return { hour: DEFAULT_HOUR, minute: DEFAULT_MINUTE };
	}
	if (state.kind === "hourly") {
		return { hour: DEFAULT_HOUR, minute: state.minute };
	}
	return { hour: state.hour, minute: state.minute };
}

function matchEveryMinutes(minute: string): number | undefined {
	if (minute === "*") return 1;
	const matched = /^\*\/(\d+)$/.exec(minute);
	if (!matched) return undefined;
	return parseSingle(matched[1], 1, 59);
}

function isWeekdaysField(dayOfWeek: string): boolean {
	if (dayOfWeek === "1-5") return true;
	const days = parseDayOfWeekList(dayOfWeek);
	return Boolean(days && days.length === WEEKDAYS.length && days.every((day, index) => day === WEEKDAYS[index]));
}

function parseDayOfWeekList(source: string): number[] | undefined {
	if (!source || source === "*") return undefined;
	const days = new Set<number>();
	for (const segment of source.split(",")) {
		if (!segment) return undefined;
		const range = segment.split("-");
		if (range.length === 1) {
			const value = parseDayOfWeek(range[0]);
			if (value === undefined) return undefined;
			days.add(value);
			continue;
		}
		if (range.length !== 2) return undefined;
		const start = parseDayOfWeek(range[0]);
		const end = parseDayOfWeek(range[1]);
		if (start === undefined || end === undefined || start > end) return undefined;
		for (let value = start; value <= end; value += 1) {
			days.add(value === 7 ? 0 : value);
		}
	}
	if (days.size === 0) return undefined;
	return [...days].sort((left, right) => left - right);
}

function parseDayOfWeek(source: string): number | undefined {
	const value = parseSingle(source, 0, 7);
	if (value === undefined) return undefined;
	return value === 7 ? 0 : value;
}

function parseSingle(source: string, min: number, max: number): number | undefined {
	if (!/^\d+$/.test(source)) return undefined;
	const value = Number(source);
	if (!Number.isInteger(value) || value < min || value > max) return undefined;
	return value;
}

function normalizeDays(days: number[]): number[] {
	const unique = [...new Set(days.map((day) => (day === 7 ? 0 : day)).filter((day) => day >= 0 && day <= 6))];
	unique.sort((left, right) => left - right);
	return unique.length > 0 ? unique : [1];
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.round(value)));
}
