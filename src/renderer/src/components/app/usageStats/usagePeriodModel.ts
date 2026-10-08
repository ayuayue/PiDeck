import type { DayTotals, ProviderSlice, UsageDayModelSlice, UsageDayProjectSlice, UsageDayRow } from "../../../../../shared/types";

export type UsagePeriodMode = "day" | "week" | "month" | "year";
export type UsagePeriod = { start: string; end: string }; // YYYY-MM-DD 闭区间

export type UsageRangeAggregate = {
	days: number; // 区间内命中的 UsageDayRow 行数（空状态判定用）
	totals: DayTotals; // 累加；sessions 跨天并集去重
	byProvider: ProviderSlice[]; // 按 provider 合并累加，tokens 降序
	byModel: UsageDayModelSlice[]; // 按 model 合并累加（provider 取首次出现值），tokens 降序
	byProject: UsageDayProjectSlice[]; // 按 project 合并累加，tokens 降序
};

function pad2(n: number): string {
	return n.toString().padStart(2, "0");
}

export function dayKeyOf(d: Date): string {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function parseDayKey(dayKey: string): Date {
	const [year, month, day] = dayKey.split("-").map((part) => Number.parseInt(part, 10));
	return new Date(year, month - 1, day);
}

export function resolvePeriod(mode: UsagePeriodMode, anchor: string): UsagePeriod {
	const anchorDate = parseDayKey(anchor);
	switch (mode) {
		case "day":
			return { start: anchor, end: anchor };
		case "week": {
			const monday = new Date(anchorDate);
			monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
			const sunday = new Date(monday);
			sunday.setDate(sunday.getDate() + 6);
			return { start: dayKeyOf(monday), end: dayKeyOf(sunday) };
		}
		case "month": {
			const start = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1);
			const end = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + 1, 0);
			return { start: dayKeyOf(start), end: dayKeyOf(end) };
		}
		case "year": {
			const year = anchorDate.getFullYear();
			return {
				start: `${year}-01-01`,
				end: `${year}-12-31`,
			};
		}
	}
}

export function isCurrentPeriod(mode: UsagePeriodMode, anchor: string, now: Date): boolean {
	return resolvePeriod(mode, dayKeyOf(now)).start === resolvePeriod(mode, anchor).start;
}

function emptyTotals(): DayTotals {
	return { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, sessions: [] };
}

function addTotals(acc: DayTotals, rowTotals: DayTotals): void {
	acc.tokens += rowTotals.tokens;
	acc.input += rowTotals.input;
	acc.output += rowTotals.output;
	acc.cacheRead += rowTotals.cacheRead;
	acc.cacheWrite += rowTotals.cacheWrite;
	acc.cost += rowTotals.cost;
	acc.turns += rowTotals.turns;
	for (const sid of rowTotals.sessions) {
		if (!acc.sessions.includes(sid)) {
			acc.sessions.push(sid);
		}
	}
}

function mergeSlices<T extends { tokens: number; cost: number; turns: number }, K extends keyof T>(slices: T[], key: K, merge: (existing: T, incoming: T) => void): T[] {
	const map = new Map<string, T>();
	for (const slice of slices) {
		const k = String(slice[key]);
		const existing = map.get(k);
		if (existing) {
			merge(existing, slice);
		} else {
			map.set(k, { ...slice });
		}
	}
	return [...map.values()].sort((a, b) => b.tokens - a.tokens);
}

export function aggregateRange(rows: UsageDayRow[], period: UsagePeriod): UsageRangeAggregate {
	const matched = rows.filter((r) => r.day >= period.start && r.day <= period.end);
	const totals = emptyTotals();
	const allByProvider: ProviderSlice[] = [];
	const allByModel: UsageDayModelSlice[] = [];
	const allByProject: UsageDayProjectSlice[] = [];

	for (const row of matched) {
		addTotals(totals, row.totals);
		allByProvider.push(...row.byProvider);
		allByModel.push(...row.byModel);
		allByProject.push(...row.byProject);
	}

	const byProvider = mergeSlices(allByProvider, "provider", (existing, incoming) => {
		existing.tokens += incoming.tokens;
		existing.cost += incoming.cost;
		existing.turns += incoming.turns;
	});

	const byModel = mergeSlices(allByModel, "model", (existing, incoming) => {
		existing.tokens += incoming.tokens;
		existing.cost += incoming.cost;
		existing.turns += incoming.turns;
	});

	const byProject = mergeSlices(allByProject, "project", (existing, incoming) => {
		existing.tokens += incoming.tokens;
		existing.cost += incoming.cost;
		existing.turns += incoming.turns;
	});

	return { days: matched.length, totals, byProvider, byModel, byProject };
}

export function earliestYear(rows: UsageDayRow[]): number {
	if (rows.length === 0) {
		return new Date().getFullYear();
	}
	return rows.reduce((min, row) => Math.min(min, parseDayKey(row.day).getFullYear()), Number.POSITIVE_INFINITY);
}

export function formatPeriodTitle(mode: UsagePeriodMode, period: UsagePeriod, localeTag: "zh-CN" | "zh-TW" | "en-US"): string {
	switch (mode) {
		case "day":
			return period.start;
		case "week": {
			const start = parseDayKey(period.start);
			const end = parseDayKey(period.end);
			// 只有英文用短月名；zh-CN / zh-TW 都用「10月8日」这类中文写法
			const options: Intl.DateTimeFormatOptions = localeTag === "en-US" ? { month: "short", day: "numeric" } : { month: "long", day: "numeric" };
			const fmt = new Intl.DateTimeFormat(localeTag, options);
			return `${fmt.format(start)} – ${fmt.format(end)}`;
		}
		case "month": {
			const start = parseDayKey(period.start);
			const options: Intl.DateTimeFormatOptions = localeTag === "en-US" ? { year: "numeric", month: "short" } : { year: "numeric", month: "long" };
			return new Intl.DateTimeFormat(localeTag, options).format(start);
		}
		case "year": {
			const year = parseDayKey(period.start).getFullYear();
			return localeTag === "en-US" ? String(year) : `${year}年`;
		}
	}
}
