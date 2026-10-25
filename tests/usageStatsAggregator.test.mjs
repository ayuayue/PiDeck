import assert from "node:assert/strict";
import test from "node:test";
import { aggregateUsage, buildAggregatedView, intermediateFromRecords, mergeIntermediates } from "../src/main/usageStats/usageStatsAggregator.ts";

/**
 * usageStatsAggregator：记录 → 聚合视图（纯函数，无 IO）。
 * 约定：
 *  - 日键/周/月均为本地时区（测试用本地构造的 Date 保证确定性）
 *  - 热力图 53 列 × 7 行，周一起始，以 now 所在周为最后一周
 *  - level 固定阈值（跨天可比）：0 / 1..9 / 10..99 / 100..999 / ≥1000
 */

const MODEL_A = "anthropic/claude-sonnet-4";
const MODEL_B = "openai/gpt-4o";

/** 构造一条记录（本地时区日期） */
function rec(overrides = {}) {
	const base = {
		ts: new Date(2026, 6, 15, 12, 0, 0).getTime(), // 2026-07-15 12:00 本地
		sid: "sess-1",
		cwd: "/home/user/proj",
		model: MODEL_A,
		input: 100,
		output: 50,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 150,
		cost: 0.01,
		costKnown: true,
	};
	return { ...base, ...overrides };
}

test("empty input produces zeroed aggregate with no daily rows", () => {
	const now = new Date(2026, 6, 15, 18, 0, 0);
	const a = aggregateUsage([], now);
	assert.equal(a.totals.tokens, 0);
	assert.equal(a.activeDays, 0);
	assert.equal(a.daily.length, 0);
	assert.equal(a.byModel.length, 0);
	assert.equal(a.byProject.length, 0);
	assert.equal(a.costKnown, true);
	assert.equal(a.recordCount, 0);
	assert.ok(a.window.since > a.window.to, "empty window should be inverted");
	assert.equal(a.heatmap.length, 53 * 7);
	assert.ok(a.heatmap.every((c) => c.level === 0 && c.tokens === 0));
});

test("single record lands in totals, today, daily and heatmap", () => {
	const now = new Date(2026, 6, 15, 18, 0, 0);
	const a = aggregateUsage([rec()], now);
	assert.equal(a.totals.tokens, 150);
	assert.equal(a.totals.input, 100);
	assert.equal(a.totals.output, 50);
	assert.equal(a.totals.turns, 1);
	assert.equal(a.activeDays, 1);
	assert.equal(a.today.tokens, 150);
	assert.equal(a.thisWeek.tokens, 150);
	assert.equal(a.thisMonth.tokens, 150);
	assert.equal(a.daily.length, 1);
	assert.equal(a.daily[0].day, "2026-07-15");
	assert.equal(a.daily[0].byProvider.length, 1);
	assert.equal(a.daily[0].byProvider[0].provider, "anthropic");
	// 热力图最后一周 = now 所在周；2026-07-15 是周三（weekday 3）→ dayIndex 2
	const lastWeekStart = new Date(2026, 6, 13); // 周一
	const cell = a.heatmap[52 * 7 + 2];
	assert.equal(cell.tokens, 150);
	assert.equal(cell.level, 2); // 150 tokens → 100..999 档
	assert.equal(a.byModel[0].model, MODEL_A);
	assert.equal(a.byProject[0].project, "/home/user/proj");
	assert.deepEqual(a.window, { since: rec().ts, to: rec().ts });
});

test("multiple records on same day merge into one daily row", () => {
	const now = new Date(2026, 6, 15, 18, 0, 0);
	const a = aggregateUsage([rec({ sid: "s1" }), rec({ sid: "s2", totalTokens: 50, input: 30, output: 20, cost: 0.005 })], now);
	assert.equal(a.daily.length, 1);
	assert.equal(a.totals.tokens, 200);
	assert.equal(a.totals.turns, 2);
	assert.equal(a.totals.cost, 0.015);
	assert.equal(a.today.sessions.length, 2);
});

test("records on different days produce multiple rows and activeDays", () => {
	const now = new Date(2026, 6, 17, 12, 0, 0);
	const a = aggregateUsage([rec(), rec({ ts: new Date(2026, 6, 16, 9).getTime(), sid: "s2" })], now);
	assert.equal(a.daily.length, 2);
	assert.equal(a.activeDays, 2);
});

test("level thresholds are fixed and cross-day comparable", () => {
	const now = new Date(2026, 6, 15, 12, 0, 0);
	const cases = [
		[0, 0],
		[5, 1],
		[50, 1],
		[100, 2],
		[500, 2],
		[1000, 3],
		[99999, 3],
		[100000, 4],
	];
	for (const [tokens, level] of cases) {
		const a = aggregateUsage([rec({ totalTokens: tokens, input: tokens })], now);
		assert.equal(a.heatmap[52 * 7 + 2].level, level, `tokens=${tokens}`);
	}
});

test("provider breakdown groups by provider prefix and sorts by tokens desc", () => {
	const now = new Date(2026, 6, 15, 12, 0, 0);
	const a = aggregateUsage([rec({ model: MODEL_A, totalTokens: 10, input: 10 }), rec({ model: MODEL_B, totalTokens: 200, input: 200, sid: "s2" }), rec({ model: "openai/gpt-4o-mini", totalTokens: 50, input: 50, sid: "s3" })], now);
	const byProvider = a.daily[0].byProvider;
	assert.deepEqual(
		byProvider.map((p) => [p.provider, p.tokens]),
		[
			["openai", 250],
			["anthropic", 10],
		],
	);
});

test("byModel and byProject sort by tokens desc and count distinct sessions", () => {
	const now = new Date(2026, 6, 15, 12, 0, 0);
	const a = aggregateUsage([rec({ model: MODEL_B, totalTokens: 200, input: 200, cwd: "/a" }), rec({ model: MODEL_A, totalTokens: 10, input: 10, cwd: "/a", sid: "s2" }), rec({ model: MODEL_A, totalTokens: 20, input: 20, cwd: "/b", sid: "s3" })], now);
	assert.deepEqual(
		a.byModel.map((m) => [m.model, m.tokens, m.sessions]),
		[
			[MODEL_B, 200, 1],
			[MODEL_A, 30, 2],
		],
	);
	assert.deepEqual(
		a.byProject.map((p) => [p.project, p.tokens]),
		[
			["/a", 210],
			["/b", 20],
		],
	);
});

test("costKnown propagates false when any record lacks pricing", () => {
	const now = new Date(2026, 6, 15, 12, 0, 0);
	const a = aggregateUsage([rec(), rec({ sid: "s2", cost: 0, costKnown: false })], now);
	assert.equal(a.costKnown, false);
});

test("today/thisWeek/thisMonth respect local boundaries", () => {
	// 记录在 7 月 15 日（周三）；now 在 7 月 16 日（周四）：
	//  same week → thisWeek 包含；不同天 → today 不含
	const recTs = new Date(2026, 6, 15, 12).getTime();
	const now = new Date(2026, 6, 16, 12, 0, 0);
	const a = aggregateUsage([rec({ ts: recTs })], now);
	assert.equal(a.today.tokens, 0);
	assert.equal(a.thisWeek.tokens, 150, "7/15 与 7/16 同属 7/13 起的周");
	assert.equal(a.thisMonth.tokens, 150);
});

test("cross-week boundary: previous week record not counted in thisWeek", () => {
	const recTs = new Date(2026, 6, 19, 12).getTime(); // 周日（7/13 起那周的周末）
	const now = new Date(2026, 6, 20, 12, 0, 0); // 下周一
	const a = aggregateUsage([rec({ ts: recTs })], now);
	assert.equal(a.thisWeek.tokens, 0);
	assert.equal(a.totals.tokens, 150);
});

test("cross-month boundary: previous month record not counted in thisMonth", () => {
	const recTs = new Date(2026, 5, 30, 12).getTime(); // 6 月 30 日
	const now = new Date(2026, 6, 1, 12, 0, 0); // 7 月 1 日
	const a = aggregateUsage([rec({ ts: recTs })], now);
	assert.equal(a.thisMonth.tokens, 0);
	assert.equal(a.totals.tokens, 150);
});

test("heatmap spans 53 weeks ending at current week, Monday-aligned", () => {
	const now = new Date(2026, 6, 15, 12, 0, 0); // 周三
	const a = aggregateUsage([rec()], now);
	// 网格起点 = 最后一周周一往前 52 周
	const lastWeekMonday = new Date(2026, 6, 13).getTime();
	const firstWeekMonday = lastWeekMonday - 52 * 7 * 24 * 3600 * 1000;
	assert.equal(a.heatmap.length, 53 * 7);
	// 记录日映射：firstWeekMonday + 52*7 + 2
	const cell = a.heatmap[52 * 7 + 2];
	assert.equal(cell.tokens, 150);
	// 越界周（更早）应为 0
	assert.equal(a.heatmap[0].tokens, 0);
});

test("model with provider prefix only keeps full model string", () => {
	const now = new Date(2026, 6, 15, 12, 0, 0);
	const a = aggregateUsage([rec({ model: "anthropic/claude-sonnet-4" })], now);
	assert.equal(a.byModel[0].model, "anthropic/claude-sonnet-4");
	assert.equal(a.byModel[0].provider, "anthropic");
});

// ─────────────────────────────────────────────────────────────────────────
// 中间态 / 增量合并（缓存与增量刷新路径）
// ─────────────────────────────────────────────────────────────────────────

test("intermediateFromRecords + buildAggregatedView round-trips through JSON", () => {
	const now = new Date(2026, 6, 15, 12, 0, 0);
	const state = JSON.parse(JSON.stringify(intermediateFromRecords([rec(), rec({ sid: "s2", model: MODEL_B })])));
	const view = buildAggregatedView(state, now);
	assert.equal(view.totals.tokens, 300);
	assert.equal(view.recordCount, 2);
	assert.equal(view.byModel.length, 2);
});

test("mergeIntermediates combines same-day and different-day buckets exactly", () => {
	const now = new Date(2026, 6, 15, 12, 0, 0);
	const base = intermediateFromRecords([rec(), rec({ ts: new Date(2026, 6, 14, 10).getTime(), sid: "s2" })]);
	const delta = intermediateFromRecords([
		rec({ sid: "s1", totalTokens: 50, input: 50 }), // 同天（7/15）同模型
		rec({ ts: new Date(2026, 6, 16, 9).getTime(), sid: "s3", model: MODEL_B }), // 新的一天
	]);
	const merged = mergeIntermediates(base, delta);
	assert.equal(merged.recordCount, 4);
	assert.equal(merged.dayBuckets.length, 3);
	// 7/15 天：base 150 + delta 50，sessions 并集 {sess-1, s1}
	const day15 = merged.dayBuckets.find((b) => b.day === "2026-07-15");
	assert.equal(day15.totals.tokens, 200);
	assert.deepEqual(day15.sessions, ["sess-1", "s1"]);
	// byProvider 同 provider 合并
	assert.equal(day15.byProvider[0].tokens, 200);
	// 模型桶合并：base 两条（7/14 + 7/15）+ delta 一条（7/15）= 350，sessions 并集 3 个
	const modelA = merged.modelBuckets.find((m) => m.model === MODEL_A);
	assert.equal(modelA.tokens, 350);
	assert.deepEqual(modelA.sessions, ["sess-1", "s2", "s1"]);
	// window 扩展
	assert.equal(merged.window.since, new Date(2026, 6, 14, 10).getTime());
	assert.equal(merged.window.to, new Date(2026, 6, 16, 9).getTime());
});

test("mergeIntermediates propagates costKnown AND and totals", () => {
	const base = intermediateFromRecords([rec()]);
	const delta = intermediateFromRecords([rec({ sid: "s2", cost: 0, costKnown: false })]);
	const merged = mergeIntermediates(base, delta);
	assert.equal(merged.costKnown, false);
	assert.equal(merged.totals.tokens, 300);
	assert.equal(merged.totals.sessions.length, 2);
});

test("buildAggregatedView rebuilds today/week/month from merged state at new now", () => {
	// 模拟：昨天（7/15）聚合并缓存，今天（7/16）增量刷新后重建视图
	const state = intermediateFromRecords([rec()]); // ts 7/15 12:00
	const yesterdayView = buildAggregatedView(state, new Date(2026, 6, 15, 18, 0, 0));
	assert.equal(yesterdayView.today.tokens, 150);
	// 今天重建：today 应为空（记录在昨天），thisWeek 仍包含
	const todayView = buildAggregatedView(state, new Date(2026, 6, 16, 10, 0, 0));
	assert.equal(todayView.today.tokens, 0);
	assert.equal(todayView.thisWeek.tokens, 150);
	assert.equal(todayView.activeDays, 1);
});

test("mergeIntermediates handles empty delta (no-op merge)", () => {
	const base = intermediateFromRecords([rec()]);
	const merged = mergeIntermediates(base, intermediateFromRecords([]));
	assert.equal(merged.recordCount, 1);
	assert.equal(merged.totals.tokens, 150);
	assert.deepEqual(merged.window, base.window);
});

test("mergeIntermediates with empty base takes delta as-is (window not polluted)", () => {
	const delta = intermediateFromRecords([rec()]);
	const merged = mergeIntermediates(intermediateFromRecords([]), delta);
	assert.deepEqual(merged.window, delta.window);
	assert.equal(merged.recordCount, 1);
	assert.equal(merged.totals.tokens, 150);
});

test("level boundaries 99/999/99999 are pinned", () => {
	const now = new Date(2026, 6, 15, 12, 0, 0);
	const cases = [
		[99, 1],
		[100, 2],
		[999, 2],
		[1000, 3],
		[99999, 3],
		[100000, 4],
	];
	for (const [tokens, level] of cases) {
		const a = aggregateUsage([rec({ totalTokens: tokens, input: tokens })], now);
		assert.equal(a.heatmap[52 * 7 + 2].level, level, `tokens=${tokens}`);
	}
});

test("model without provider separator falls back to whole string as provider", () => {
	const now = new Date(2026, 6, 15, 12, 0, 0);
	const a = aggregateUsage([rec({ model: "local-model" })], now);
	assert.equal(a.byModel[0].provider, "local-model");
});

test("heatmapStart is the first cell day key (Monday, local)", () => {
	const now = new Date(2026, 6, 15, 12, 0, 0); // 周三
	const a = aggregateUsage([rec()], now);
	// 最后一周起点 = 7/13 周一，往前 52 周
	const expected = new Date(2026, 6, 13);
	expected.setDate(expected.getDate() - 52 * 7);
	const em = String(expected.getMonth() + 1).padStart(2, "0");
	const ed = String(expected.getDate()).padStart(2, "0");
	assert.equal(a.heatmapStart, `${expected.getFullYear()}-${em}-${ed}`);
	assert.match(a.heatmapStart, /^(\d{4})-(\d{2})-(\d{2})$/);
});

test("daily rows carry per-day byModel/byProject detail sorted by tokens desc", () => {
	const now = new Date(2026, 6, 15, 12, 0, 0);
	const a = aggregateUsage([rec({ model: MODEL_B, totalTokens: 200, input: 200, cwd: "/a", cost: 0.2 }), rec({ model: MODEL_A, totalTokens: 10, input: 10, cwd: "/a", sid: "s2" }), rec({ model: MODEL_A, totalTokens: 20, input: 20, cwd: "/b", sid: "s3", cost: 0.01 })], now);
	const day = a.daily[0];
	assert.deepEqual(
		day.byModel.map((m) => [m.model, m.provider, m.tokens, m.cost, m.turns]),
		[
			[MODEL_B, "openai", 200, 0.2, 1],
			[MODEL_A, "anthropic", 30, 0.02, 2],
		],
	);
	assert.deepEqual(
		day.byProject.map((p) => [p.project, p.tokens, Math.round(p.cost * 100) / 100, p.turns]),
		[
			["/a", 210, 0.21, 2],
			["/b", 20, 0.01, 1],
		],
	);
});

test("mergeIntermediates merges per-day byModel/byProject buckets exactly", () => {
	const base = intermediateFromRecords([rec({ model: MODEL_A, totalTokens: 100, cwd: "/a", cost: 0.1 })]);
	const delta = intermediateFromRecords([
		rec({ model: MODEL_A, totalTokens: 50, cwd: "/b", cost: 0.05, sid: "s2" }), // 同天同模型、新项目
		rec({ model: MODEL_B, totalTokens: 30, cwd: "/a", cost: 0.03, sid: "s3" }), // 同天新模型
	]);
	const merged = mergeIntermediates(base, delta);
	const day = merged.dayBuckets.find((b) => b.day === "2026-07-15");
	assert.deepEqual(
		day.byModel.map((m) => [m.model, m.tokens, Math.round(m.cost * 100) / 100]),
		[
			[MODEL_A, 150, 0.15],
			[MODEL_B, 30, 0.03],
		],
	);
	assert.deepEqual(
		day.byProject.map((p) => [p.project, p.tokens, Math.round(p.cost * 100) / 100]),
		[
			["/a", 130, 0.13],
			["/b", 50, 0.05],
		],
	);
});

test("intermediate JSON round-trip preserves per-day byModel/byProject", () => {
	const state = JSON.parse(JSON.stringify(intermediateFromRecords([rec(), rec({ model: MODEL_B, cwd: "/b", sid: "s2" })])));
	const view = buildAggregatedView(state, new Date(2026, 6, 15, 12, 0, 0));
	assert.equal(view.daily[0].byModel.length, 2);
	assert.equal(view.daily[0].byProject.length, 2);
});
