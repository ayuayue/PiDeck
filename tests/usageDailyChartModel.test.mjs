import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { barMinPointSize, buildBuckets } from "../src/renderer/src/components/app/usageStats/usageDailyChartModel.ts";

/**
 * 每日用量柱状图数据变换：0 tokens 的天/供应商不占柱。
 * 约定：日键按本地时区 "YYYY-MM-DD"；now 用本地 Date 保证窗口边界确定。
 */

function totals(tokens) {
	return {
		tokens,
		input: tokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turns: tokens > 0 ? 1 : 0,
		sessions: tokens > 0 ? ["s1"] : [],
	};
}

function row(day, tokenByProvider) {
	const byProvider = Object.entries(tokenByProvider).map(([provider, tokens]) => ({
		provider,
		tokens,
		cost: 0,
		turns: tokens > 0 ? 1 : 0,
	}));
	const tokens = byProvider.reduce((sum, p) => sum + p.tokens, 0);
	return {
		day,
		totals: totals(tokens),
		byProvider,
		byModel: [],
		byProject: [],
	};
}

test("barMinPointSize keeps 3px for positive usage and 0 for zeros", () => {
	assert.equal(barMinPointSize(0), 0);
	assert.equal(barMinPointSize(-1), 0);
	assert.equal(barMinPointSize(null), 0);
	assert.equal(barMinPointSize(undefined), 0);
	assert.equal(barMinPointSize(1), 3);
	assert.equal(barMinPointSize(999), 3);
});

test("day mode drops zero-token days and zero provider slices", () => {
	const now = new Date(2026, 6, 15, 18, 0, 0);
	const buckets = buildBuckets([row("2026-07-14", { anthropic: 0, openai: 0 }), row("2026-07-15", { anthropic: 100, openai: 0 })], "day", now);
	assert.equal(buckets.length, 1);
	assert.equal(buckets[0].label, "07-15");
	assert.equal(buckets[0].tokens, 100);
	assert.deepEqual(
		buckets[0].byProvider.map((p) => [p.provider, p.tokens]),
		[["anthropic", 100]],
	);
});

test("day mode ignores rows older than the 30-day window", () => {
	const now = new Date(2026, 6, 15, 18, 0, 0);
	const buckets = buildBuckets([row("2026-06-01", { anthropic: 50 }), row("2026-07-15", { anthropic: 10 })], "day", now);
	assert.equal(buckets.length, 1);
	assert.equal(buckets[0].label, "07-15");
});

test("week and month modes drop empty buckets after aggregation", () => {
	const now = new Date(2026, 6, 15, 18, 0, 0);
	// 2026-07-13 周一；07-14 同周但 0 tokens，不应单独成柱，也不应把周总量拉成 0
	const weekBuckets = buildBuckets([row("2026-07-13", { anthropic: 40 }), row("2026-07-14", { openai: 0 })], "week", now);
	assert.equal(weekBuckets.length, 1);
	assert.equal(weekBuckets[0].tokens, 40);
	assert.deepEqual(
		weekBuckets[0].byProvider.map((p) => p.provider),
		["anthropic"],
	);

	const monthBuckets = buildBuckets([row("2026-06-30", { anthropic: 0 }), row("2026-07-01", { openai: 25 })], "month", now);
	assert.equal(monthBuckets.length, 1);
	assert.equal(monthBuckets[0].label, "2026-07");
	assert.equal(monthBuckets[0].tokens, 25);
});

test("UsageDailyChart hides zero bars in tooltip and minPointSize", () => {
	const source = readFileSync("src/renderer/src/components/app/usageStats/UsageDailyChart.tsx", "utf8");
	assert.match(source, /minPointSize=\{barMinPointSize\}/);
	assert.doesNotMatch(source, /minPointSize=\{3\}/);
	assert.match(source, /Number\(item\.value\) > 0/);
	assert.match(source, /from "\.\/usageDailyChartModel"/);
});

test("UsageDayDetail provider bar does not keep a 1% floor for zeros", () => {
	const source = readFileSync("src/renderer/src/components/app/usageStats/UsageDayDetail.tsx", "utf8");
	assert.doesNotMatch(source, /Math\.max\(1,\s*\(p\.tokens \/ total\) \* 100\)/);
	assert.match(source, /agg\.byProvider\.filter\(\(p\) => p\.tokens > 0\)/);
	assert.match(source, /width: `\$\{\(p\.tokens \/ total\) \* 100}%`/);
});
