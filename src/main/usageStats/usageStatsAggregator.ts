/**
 * 用量聚合（纯函数，无 IO）：UsageRecord[] → 中间态 → UsageAggregated。
 *
 * 三段式设计：
 *  - intermediateFromRecords：扫描记录产出可序列化中间态（天/模型/项目桶）
 *  - mergeIntermediates：增量刷新时合并新旧中间态（精确，无近似）
 *  - buildAggregatedView：从中间态派生完整视图（today/周/月/热力图按 now 重建）
 *
 * 约定：
 *  - 日键/周/月均为本地时区（用户视角的「一天」）
 *  - 热力图 53 列 × 7 行（周一起始），以 now 所在周为最后一周
 *  - level 固定阈值、跨天可比：0 / 1..99 / 100..999 / 1000..99999 / ≥100000
 */

import type { DayTotals, HeatmapCell, ProviderSlice, UsageAggregated, UsageDayModelSlice, UsageDayProjectSlice, UsageDayRow, UsageModelRow, UsageProjectRow, UsageRecord } from "../../shared/types/usageStats";

const DAY_MS = 24 * 3600 * 1000;
const HEATMAP_WEEKS = 53;
const HEATMAP_CELLS = HEATMAP_WEEKS * 7;

/** 可序列化中间态（缓存与增量合并用；sessions 用数组）。 */
export type UsageStatsIntermediate = {
	dayBuckets: Array<{
		day: string;
		totals: DayTotals;
		sessions: string[];
		byProvider: ProviderSlice[];
		byModel: UsageDayModelSlice[];
		byProject: UsageDayProjectSlice[];
	}>;
	modelBuckets: Array<{
		model: string;
		provider: string;
		tokens: number;
		cost: number;
		turns: number;
		sessions: string[];
	}>;
	projectBuckets: Array<{
		project: string;
		tokens: number;
		cost: number;
		turns: number;
		sessions: string[];
	}>;
	totals: DayTotals;
	window: { since: number; to: number };
	costKnown: boolean;
	recordCount: number;
};

/** 本地时区日键 "YYYY-MM-DD"。 */
function dayKeyOf(d: Date): string {
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${m}-${day}`;
}

/** 本地时区当天零点。 */
function localMidnight(d: Date): Date {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** 本地时区周一起始。 */
function localWeekStart(d: Date): Date {
	const monday = localMidnight(d);
	const weekday = (monday.getDay() + 6) % 7; // 0 = Monday
	monday.setDate(monday.getDate() - weekday);
	return monday;
}

function emptyTotals(): DayTotals {
	return {
		tokens: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turns: 0,
		sessions: [],
	};
}

/** 固定阈值分档（跨天可比；与测试约定一致）。 */
function levelFor(tokens: number): 0 | 1 | 2 | 3 | 4 {
	if (tokens <= 0) return 0;
	if (tokens < 100) return 1;
	if (tokens < 1000) return 2;
	if (tokens < 100000) return 3;
	return 4;
}

/** model "provider/model" → provider（第一个 "/" 前部分，无 "/" 时整体视为 provider）。 */
function providerOf(model: string): string {
	const idx = model.indexOf("/");
	return idx === -1 ? model : model.slice(0, idx);
}

type DayBucket = {
	totals: DayTotals;
	sessions: Set<string>;
	byProvider: Map<string, ProviderSlice>;
	byModel: Map<string, UsageDayModelSlice>;
	byProject: Map<string, UsageDayProjectSlice>;
};

function addToProvider(map: Map<string, ProviderSlice>, provider: string, r: UsageRecord): void {
	let slice = map.get(provider);
	if (!slice) {
		slice = { provider, tokens: 0, cost: 0, turns: 0 };
		map.set(provider, slice);
	}
	slice.tokens += r.totalTokens;
	slice.cost += r.cost;
	slice.turns += 1;
}

/** 累加单日模型桶（key = "provider/model"）。 */
function addToDayModel(map: Map<string, UsageDayModelSlice>, model: string, r: UsageRecord): void {
	let slice = map.get(model);
	if (!slice) {
		slice = { model, provider: providerOf(model), tokens: 0, cost: 0, turns: 0 };
		map.set(model, slice);
	}
	slice.tokens += r.totalTokens;
	slice.cost += r.cost;
	slice.turns += 1;
}

/** 累加单日项目桶（key = cwd）。 */
function addToDayProject(map: Map<string, UsageDayProjectSlice>, project: string, r: UsageRecord): void {
	let slice = map.get(project);
	if (!slice) {
		slice = { project, tokens: 0, cost: 0, turns: 0 };
		map.set(project, slice);
	}
	slice.tokens += r.totalTokens;
	slice.cost += r.cost;
	slice.turns += 1;
}

/** 合并两个单日模型桶（增量合并用）。 */
function mergeDayModelMaps(base: Map<string, UsageDayModelSlice>, delta: Map<string, UsageDayModelSlice>): UsageDayModelSlice[] {
	const merged = new Map(base);
	for (const [key, slice] of delta) {
		const existing = merged.get(key);
		if (existing) {
			existing.tokens += slice.tokens;
			existing.cost += slice.cost;
			existing.turns += slice.turns;
		} else {
			merged.set(key, slice);
		}
	}
	return [...merged.values()].sort((a, b) => b.tokens - a.tokens);
}

/** 合并两个单日项目桶（增量合并用）。 */
function mergeDayProjectMaps(base: Map<string, UsageDayProjectSlice>, delta: Map<string, UsageDayProjectSlice>): UsageDayProjectSlice[] {
	const merged = new Map(base);
	for (const [key, slice] of delta) {
		const existing = merged.get(key);
		if (existing) {
			existing.tokens += slice.tokens;
			existing.cost += slice.cost;
			existing.turns += slice.turns;
		} else {
			merged.set(key, slice);
		}
	}
	return [...merged.values()].sort((a, b) => b.tokens - a.tokens);
}

/** 合并两个 DayTotals（区间合计/增量合并用；sessions 取并集）。 */
function mergeTotals(a: DayTotals, b: DayTotals): DayTotals {
	return {
		tokens: a.tokens + b.tokens,
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		cost: a.cost + b.cost,
		turns: a.turns + b.turns,
		sessions: [...new Set([...a.sessions, ...b.sessions])],
	};
}

/** 扫描记录 → 中间态。 */
export function intermediateFromRecords(records: UsageRecord[]): UsageStatsIntermediate {
	const dayBuckets = new Map<string, DayBucket>();
	const totals = emptyTotals();
	const totalSessions = new Set<string>();
	const byModel = new Map<string, { provider: string; tokens: number; cost: number; turns: number; sessions: Set<string> }>();
	const byProject = new Map<string, { tokens: number; cost: number; turns: number; sessions: Set<string> }>();
	let firstTs = Number.POSITIVE_INFINITY;
	let lastTs = Number.NEGATIVE_INFINITY;
	let allCostKnown = true;

	for (const r of records) {
		const dayKey = dayKeyOf(new Date(r.ts));
		let bucket = dayBuckets.get(dayKey);
		if (!bucket) {
			bucket = {
				totals: emptyTotals(),
				sessions: new Set(),
				byProvider: new Map(),
				byModel: new Map(),
				byProject: new Map(),
			};
			dayBuckets.set(dayKey, bucket);
		}
		bucket.totals.tokens += r.totalTokens;
		bucket.totals.input += r.input;
		bucket.totals.output += r.output;
		bucket.totals.cacheRead += r.cacheRead;
		bucket.totals.cacheWrite += r.cacheWrite;
		bucket.totals.cost += r.cost;
		bucket.totals.turns += 1;
		bucket.sessions.add(r.sid);
		addToProvider(bucket.byProvider, providerOf(r.model), r);
		addToDayModel(bucket.byModel, r.model, r);
		addToDayProject(bucket.byProject, r.cwd, r);

		totals.tokens += r.totalTokens;
		totals.input += r.input;
		totals.output += r.output;
		totals.cacheRead += r.cacheRead;
		totals.cacheWrite += r.cacheWrite;
		totals.cost += r.cost;
		totals.turns += 1;
		totalSessions.add(r.sid);

		let modelRow = byModel.get(r.model);
		if (!modelRow) {
			modelRow = { provider: providerOf(r.model), tokens: 0, cost: 0, turns: 0, sessions: new Set() };
			byModel.set(r.model, modelRow);
		}
		modelRow.tokens += r.totalTokens;
		modelRow.cost += r.cost;
		modelRow.turns += 1;
		modelRow.sessions.add(r.sid);

		let projectRow = byProject.get(r.cwd);
		if (!projectRow) {
			projectRow = { tokens: 0, cost: 0, turns: 0, sessions: new Set() };
			byProject.set(r.cwd, projectRow);
		}
		projectRow.tokens += r.totalTokens;
		projectRow.cost += r.cost;
		projectRow.turns += 1;
		projectRow.sessions.add(r.sid);

		if (r.ts < firstTs) firstTs = r.ts;
		if (r.ts > lastTs) lastTs = r.ts;
		if (!r.costKnown) allCostKnown = false;
	}

	return {
		dayBuckets: [...dayBuckets.entries()]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([day, bucket]) => ({
				day,
				totals: { ...bucket.totals, sessions: [...bucket.sessions] },
				sessions: [...bucket.sessions],
				byProvider: [...bucket.byProvider.values()].sort((a, b) => b.tokens - a.tokens),
				byModel: [...bucket.byModel.values()].sort((a, b) => b.tokens - a.tokens),
				byProject: [...bucket.byProject.values()].sort((a, b) => b.tokens - a.tokens),
			})),
		modelBuckets: [...byModel.entries()]
			.sort(([, a], [, b]) => b.tokens - a.tokens)
			.map(([model, row]) => ({
				model,
				provider: row.provider,
				tokens: row.tokens,
				cost: row.cost,
				turns: row.turns,
				sessions: [...row.sessions],
			})),
		projectBuckets: [...byProject.entries()]
			.sort(([, a], [, b]) => b.tokens - a.tokens)
			.map(([project, row]) => ({
				project,
				tokens: row.tokens,
				cost: row.cost,
				turns: row.turns,
				sessions: [...row.sessions],
			})),
		totals: { ...totals, sessions: [...totalSessions] },
		window: {
			since: Number.isFinite(firstTs) ? firstTs : 0,
			to: Number.isFinite(lastTs) ? lastTs : -1,
		},
		costKnown: allCostKnown,
		recordCount: records.length,
	};
}

/** 合并两个中间态（增量刷新：新段 + 旧缓存）。纯合并，不重新扫描记录。 */
export function mergeIntermediates(base: UsageStatsIntermediate, delta: UsageStatsIntermediate): UsageStatsIntermediate {
	// 空增量 = no-op（避免空态的 window {0,-1} 污染 base）
	if (delta.recordCount === 0) return base;
	// 空 base = 直接取增量（避免空态 window.since=0 被 min 污染）
	if (base.recordCount === 0) return delta;

	const dayMap = new Map(base.dayBuckets.map((b) => [b.day, b]));
	for (const d of delta.dayBuckets) {
		const existing = dayMap.get(d.day);
		if (!existing) {
			dayMap.set(d.day, d);
			continue;
		}
		const byProvider = new Map(existing.byProvider.map((p) => [p.provider, p]));
		for (const p of d.byProvider) {
			const ep = byProvider.get(p.provider);
			if (ep) {
				ep.tokens += p.tokens;
				ep.cost += p.cost;
				ep.turns += p.turns;
			} else {
				byProvider.set(p.provider, p);
			}
		}
		dayMap.set(d.day, {
			day: d.day,
			totals: mergeTotals(existing.totals, d.totals),
			sessions: [...new Set([...existing.sessions, ...d.sessions])],
			byProvider: [...byProvider.values()].sort((a, b) => b.tokens - a.tokens),
			byModel: mergeDayModelMaps(new Map(existing.byModel.map((m) => [m.model, m])), new Map(d.byModel.map((m) => [m.model, m]))),
			byProject: mergeDayProjectMaps(new Map(existing.byProject.map((p) => [p.project, p])), new Map(d.byProject.map((p) => [p.project, p]))),
		});
	}

	const modelMap = new Map(base.modelBuckets.map((b) => [b.model, b]));
	for (const d of delta.modelBuckets) {
		const existing = modelMap.get(d.model);
		if (!existing) {
			modelMap.set(d.model, d);
			continue;
		}
		modelMap.set(d.model, {
			...existing,
			tokens: existing.tokens + d.tokens,
			cost: existing.cost + d.cost,
			turns: existing.turns + d.turns,
			sessions: [...new Set([...existing.sessions, ...d.sessions])],
		});
	}

	const projectMap = new Map(base.projectBuckets.map((b) => [b.project, b]));
	for (const d of delta.projectBuckets) {
		const existing = projectMap.get(d.project);
		if (!existing) {
			projectMap.set(d.project, d);
			continue;
		}
		projectMap.set(d.project, {
			...existing,
			tokens: existing.tokens + d.tokens,
			cost: existing.cost + d.cost,
			turns: existing.turns + d.turns,
			sessions: [...new Set([...existing.sessions, ...d.sessions])],
		});
	}

	return {
		dayBuckets: [...dayMap.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
		modelBuckets: [...modelMap.values()].sort((a, b) => b.tokens - a.tokens),
		projectBuckets: [...projectMap.values()].sort((a, b) => b.tokens - a.tokens),
		totals: mergeTotals(base.totals, delta.totals),
		window: {
			since: Math.min(base.window.since, delta.window.since),
			to: Math.max(base.window.to, delta.window.to),
		},
		costKnown: base.costKnown && delta.costKnown,
		recordCount: base.recordCount + delta.recordCount,
	};
}

/** 从中间态派生完整视图（today/周/月/热力图按 now 重建，跨刷新时间漂移安全）。 */
export function buildAggregatedView(state: UsageStatsIntermediate, now: Date = new Date()): UsageAggregated {
	const dayMap = new Map(state.dayBuckets.map((b) => [b.day, b]));

	const daily: UsageDayRow[] = state.dayBuckets.map((b) => ({
		day: b.day,
		totals: b.totals,
		byProvider: b.byProvider,
		byModel: b.byModel,
		byProject: b.byProject,
	}));

	// 热力图：以 now 所在周为最后一周，往前 52 周（共 53 列）。
	// 日历步进（setDate +1）而非固定 24h 毫秒步进：跨 DST 切换时毫秒步进会逐日漂移。
	const lastWeekStart = localWeekStart(now).getTime();
	const firstWeekStart = new Date(lastWeekStart - (HEATMAP_WEEKS - 1) * 7 * DAY_MS);
	const heatmap: HeatmapCell[] = new Array(HEATMAP_CELLS);
	const cursor = new Date(firstWeekStart);
	for (let i = 0; i < HEATMAP_CELLS; i++) {
		const bucket = dayMap.get(dayKeyOf(cursor));
		const tokens = bucket ? bucket.totals.tokens : 0;
		heatmap[i] = {
			tokens,
			turns: bucket ? bucket.totals.turns : 0,
			level: levelFor(tokens),
		};
		cursor.setDate(cursor.getDate() + 1);
	}
	// 首格日键（渲染层 tooltip/锚点单一来源，不再自行推算网格起点）
	const heatmapStart = dayKeyOf(firstWeekStart);

	const todayKey = dayKeyOf(now);
	const weekStartKey = dayKeyOf(localWeekStart(now));
	const monthStartKey = dayKeyOf(new Date(now.getFullYear(), now.getMonth(), 1));
	const today = dayMap.get(todayKey);
	const thisWeek = state.dayBuckets.filter((b) => b.day >= weekStartKey).reduce<DayTotals>((acc, b) => mergeTotals(acc, b.totals), emptyTotals());
	const thisMonth = state.dayBuckets.filter((b) => b.day >= monthStartKey).reduce<DayTotals>((acc, b) => mergeTotals(acc, b.totals), emptyTotals());

	return {
		window: state.window,
		totals: state.totals,
		activeDays: daily.filter((d) => d.totals.tokens > 0).length,
		today: today ? today.totals : emptyTotals(),
		thisWeek,
		thisMonth,
		daily,
		heatmap,
		heatmapStart,
		byModel: state.modelBuckets.map((row) => ({
			model: row.model,
			provider: row.provider,
			tokens: row.tokens,
			cost: row.cost,
			turns: row.turns,
			sessions: row.sessions.length,
		})),
		byProject: state.projectBuckets.map((row) => ({
			project: row.project,
			tokens: row.tokens,
			cost: row.cost,
			turns: row.turns,
		})),
		costKnown: state.costKnown,
		recordCount: state.recordCount,
	};
}

/** 便捷入口：记录 → 完整视图（一次性全量场景）。 */
export function aggregateUsage(records: UsageRecord[], now: Date = new Date()): UsageAggregated {
	return buildAggregatedView(intermediateFromRecords(records), now);
}
