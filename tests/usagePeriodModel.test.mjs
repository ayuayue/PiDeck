import assert from "node:assert/strict";
import test from "node:test";
import { aggregateRange, dayKeyOf, earliestYear, formatPeriodTitle, isCurrentPeriod, parseDayKey, resolvePeriod } from "../src/renderer/src/components/app/usageStats/usagePeriodModel.ts";

function totals(tokens, sessions = []) {
	return {
		tokens,
		input: tokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turns: tokens > 0 ? 1 : 0,
		sessions,
	};
}

function providerSlice(provider, tokens) {
	return {
		provider,
		tokens,
		cost: 0,
		turns: tokens > 0 ? 1 : 0,
	};
}

function modelSlice(model, provider, tokens) {
	return {
		model,
		provider,
		tokens,
		cost: 0,
		turns: tokens > 0 ? 1 : 0,
	};
}

function projectSlice(project, tokens) {
	return {
		project,
		tokens,
		cost: 0,
		turns: tokens > 0 ? 1 : 0,
	};
}

function row(day, tokenByProvider, modelEntries = [], projectEntries = []) {
	const byProvider = Object.entries(tokenByProvider).map(([provider, tokens]) => providerSlice(provider, tokens));
	const tokens = byProvider.reduce((sum, p) => sum + p.tokens, 0);
	return {
		day,
		totals: totals(tokens),
		byProvider,
		byModel: modelEntries.map(([model, provider, t]) => modelSlice(model, provider, t)),
		byProject: projectEntries.map(([project, t]) => projectSlice(project, t)),
	};
}

function rowWithSessions(day, tokenByProvider, sessionsByProvider) {
	const byProvider = Object.entries(tokenByProvider).map(([provider, tokens]) => ({
		provider,
		tokens,
		cost: 0,
		turns: tokens > 0 ? 1 : 0,
	}));
	const tokens = byProvider.reduce((sum, p) => sum + p.tokens, 0);
	const sessions = Object.values(sessionsByProvider).flat();
	return {
		day,
		totals: totals(tokens, sessions),
		byProvider,
		byModel: [],
		byProject: [],
	};
}

test("resolvePeriodDay", () => {
	assert.deepEqual(resolvePeriod("day", "2026-10-01"), { start: "2026-10-01", end: "2026-10-01" });
});

test("resolvePeriodWeekMondayAnchor", () => {
	assert.deepEqual(resolvePeriod("week", "2026-09-28"), { start: "2026-09-28", end: "2026-10-04" });
});

test("resolvePeriodWeekMidWeek", () => {
	assert.deepEqual(resolvePeriod("week", "2026-10-01"), { start: "2026-09-28", end: "2026-10-04" });
});

test("resolvePeriodWeekSpansMonth", () => {
	assert.deepEqual(resolvePeriod("week", "2026-08-01"), { start: "2026-07-27", end: "2026-08-02" });
});

test("resolvePeriodWeekSpansYear", () => {
	assert.deepEqual(resolvePeriod("week", "2027-01-01"), { start: "2026-12-28", end: "2027-01-03" });
});

test("resolvePeriodMonthLeap", () => {
	assert.deepEqual(resolvePeriod("month", "2028-02-11"), { start: "2028-02-01", end: "2028-02-29" });
	assert.deepEqual(resolvePeriod("month", "2026-02-11"), { start: "2026-02-01", end: "2026-02-28" });
});

test("resolvePeriodYear", () => {
	assert.deepEqual(resolvePeriod("year", "2026-05-20"), { start: "2026-01-01", end: "2026-12-31" });
});

test("isCurrentPeriodSameWeekDifferentDays", () => {
	const now = new Date(2026, 9, 1);
	assert.equal(isCurrentPeriod("week", "2026-09-30", now), true);
	assert.equal(isCurrentPeriod("week", "2026-09-24", now), false);
});

test("isCurrentPeriodDay", () => {
	const now = new Date(2026, 9, 1);
	assert.equal(isCurrentPeriod("day", dayKeyOf(now), now), true);
	assert.equal(isCurrentPeriod("day", "2026-09-30", now), false);
});

test("dayKeyOfAndParseDayKeyRoundTrip", () => {
	const d = new Date(2026, 9, 1);
	assert.equal(dayKeyOf(d), "2026-10-01");
	const parsed = parseDayKey("2026-10-01");
	assert.equal(parsed.getFullYear(), 2026);
	assert.equal(parsed.getMonth(), 9);
	assert.equal(parsed.getDate(), 1);
	assert.equal(dayKeyOf(parsed), "2026-10-01");
});

test("aggregateRangeMergesTotalsAndDedupesSessions", () => {
	const r1 = rowWithSessions("2026-10-01", { openai: 100 }, { openai: ["s1", "s2"] });
	const r2 = rowWithSessions("2026-10-02", { openai: 50 }, { openai: ["s2", "s3"] });
	const agg = aggregateRange([r1, r2], { start: "2026-10-01", end: "2026-10-02" });
	assert.equal(agg.days, 2);
	assert.equal(agg.totals.tokens, 150);
	assert.deepEqual([...agg.totals.sessions].sort(), ["s1", "s2", "s3"]);
});

test("aggregateRangeMergesSlicesDesc", () => {
	const r1 = row("2026-10-01", { openai: 100, anthropic: 30 }, [["gpt-4", "openai", 100]], [["p1", 100]]);
	const r2 = row("2026-10-02", { openai: 50, anthropic: 70 }, [["gpt-4", "openai", 50]], [["p1", 50]]);
	const agg = aggregateRange([r1, r2], { start: "2026-10-01", end: "2026-10-02" });
	assert.deepEqual(
		agg.byProvider.map((p) => [p.provider, p.tokens]),
		[
			["openai", 150],
			["anthropic", 100],
		],
	);
	assert.deepEqual(
		agg.byModel.map((m) => [m.model, m.tokens]),
		[["gpt-4", 150]],
	);
	assert.deepEqual(
		agg.byProject.map((p) => [p.project, p.tokens]),
		[["p1", 150]],
	);
});

test("aggregateRangeEmpty", () => {
	const agg = aggregateRange([], { start: "2026-10-01", end: "2026-10-01" });
	assert.equal(agg.days, 0);
	assert.equal(agg.totals.tokens, 0);
	assert.equal(agg.totals.sessions.length, 0);
	assert.equal(agg.byProvider.length, 0);
	assert.equal(agg.byModel.length, 0);
	assert.equal(agg.byProject.length, 0);
});

test("aggregateRangeSingleDayEqualsRow", () => {
	const r = row("2026-10-01", { openai: 200, anthropic: 100 });
	const agg = aggregateRange([r], { start: "2026-10-01", end: "2026-10-01" });
	assert.equal(agg.days, 1);
	assert.equal(agg.totals.tokens, 300);
	assert.equal(agg.totals.input, 300);
	assert.deepEqual(
		agg.byProvider.map((p) => [p.provider, p.tokens]),
		[
			["openai", 200],
			["anthropic", 100],
		],
	);
});

test("earliestYearEmptyAndBound", () => {
	assert.equal(earliestYear([]), new Date().getFullYear());
	assert.equal(earliestYear([row("2024-03-05", { openai: 1 })]), 2024);
});

test("formatPeriodTitleZhEn", () => {
	const period = { start: "2026-08-03", end: "2026-08-09" };
	assert.equal(formatPeriodTitle("day", period, "zh-CN"), "2026-08-03");
	assert.equal(formatPeriodTitle("day", period, "en-US"), "2026-08-03");
	assert.equal(formatPeriodTitle("week", period, "zh-CN"), "8月3日 – 8月9日");
	assert.equal(formatPeriodTitle("week", period, "en-US"), "Aug 3 – Aug 9");
	assert.equal(formatPeriodTitle("month", { start: "2026-08-01", end: "2026-08-31" }, "zh-CN"), "2026年8月");
	assert.equal(formatPeriodTitle("month", { start: "2026-08-01", end: "2026-08-31" }, "en-US"), "Aug 2026");
	assert.equal(formatPeriodTitle("year", { start: "2026-01-01", end: "2026-12-31" }, "zh-CN"), "2026年");
	assert.equal(formatPeriodTitle("year", { start: "2026-01-01", end: "2026-12-31" }, "en-US"), "2026");
});
