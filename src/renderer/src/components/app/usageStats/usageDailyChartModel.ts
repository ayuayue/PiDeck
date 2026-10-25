/**
 * 每日用量柱状图的纯数据变换（与 Recharts 解耦，方便单测）。
 *
 * 业务规则：0 tokens 的天/周/月不占 X 轴；低用量（>0）仍保留最小柱高，方便 hover。
 */

import type { UsageDayRow } from "../../../../../shared/types";

export type RangeMode = "day" | "week" | "month";

/** 近 N 天/周/月聚合桶：label + 总量 + provider 分解。 */
export type UsageChartBucket = {
	label: string;
	tokens: number;
	byProvider: Array<{ provider: string; tokens: number }>;
};

const DAY_MS = 24 * 3600 * 1000;

/** 低用量柱保留 3px 可悬停高度；0 / 空值必须返回 0，否则 Recharts 会画出占位小柱。 */
export function barMinPointSize(value: number | null | undefined): number {
	return (value ?? 0) > 0 ? 3 : 0;
}

/** 构造日/周/月桶；tokens===0 的桶丢弃，避免空柱占轴。 */
export function buildBuckets(rows: UsageDayRow[], mode: RangeMode, now: Date): UsageChartBucket[] {
	if (rows.length === 0) return [];
	const last = new Date(rows[rows.length - 1].day + "T00:00:00");
	if (Number.isNaN(last.getTime())) return [];
	const end = Math.min(now.getTime(), last.getTime() + DAY_MS);

	if (mode === "day") {
		const start = end - 30 * DAY_MS;
		return rows
			.filter((r) => {
				const ts = new Date(r.day + "T00:00:00").getTime();
				// 近 30 天窗口内，无用量的天不画柱（含 tokens 为 0 的脏行）
				return ts >= start && r.totals.tokens > 0;
			})
			.map((r) => ({
				label: r.day.slice(5),
				tokens: r.totals.tokens,
				byProvider: r.byProvider.filter((p) => p.tokens > 0).map((p) => ({ provider: p.provider, tokens: p.tokens })),
			}));
	}

	// 周 / 月：按本地周一起始 / 月起始聚合成桶（升序）
	const buckets = new Map<string, UsageChartBucket>();
	for (const r of rows) {
		const d = new Date(r.day + "T00:00:00");
		let key: string;
		let label: string;
		if (mode === "week") {
			const monday = new Date(d);
			monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
			// 本地日期键（不用 toISOString，避免 UTC 偏移导致标签错位一天）
			const m = String(monday.getMonth() + 1).padStart(2, "0");
			const day = String(monday.getDate()).padStart(2, "0");
			key = `${monday.getFullYear()}-${m}-${day}`;
			label = key.slice(5);
		} else {
			key = r.day.slice(0, 7);
			label = key;
		}
		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = { label, tokens: 0, byProvider: [] };
			buckets.set(key, bucket);
		}
		bucket.tokens += r.totals.tokens;
		for (const p of r.byProvider) {
			if (p.tokens <= 0) continue;
			const existing = bucket.byProvider.find((b) => b.provider === p.provider);
			if (existing) {
				existing.tokens += p.tokens;
			} else {
				bucket.byProvider.push({ provider: p.provider, tokens: p.tokens });
			}
		}
	}
	const sorted = [...buckets.values()].filter((bucket) => bucket.tokens > 0);
	const limit = 12;
	return sorted.slice(Math.max(0, sorted.length - limit));
}
