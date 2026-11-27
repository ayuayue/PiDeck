import test from "node:test";
import assert from "node:assert/strict";
import { calculateTokensPerSecond, calculateIntervalUnionDurationMs, calculateSessionTokensPerSecond, hasIncrementalDeltaStream } from "../src/shared/tps.ts";

test("hasIncrementalDeltaStream distinguishes incremental streaming from one-shot delivery", () => {
	// 真增量流式：一个 delta 几个 token
	assert.equal(hasIncrementalDeltaStream(1481, 1481), true);
	assert.equal(hasIncrementalDeltaStream(1000, 20), true);
	// 整段送达（#602 实测 1481 token / 2 个 delta = 5610 tok/s）：窗口不反映解码速度
	assert.equal(hasIncrementalDeltaStream(1481, 2), false);
	assert.equal(hasIncrementalDeltaStream(1917, 3), false);
	// delta 数未知（子代理区间等外部来源）按旧口径放行
	assert.equal(hasIncrementalDeltaStream(500, undefined), true);
	assert.equal(hasIncrementalDeltaStream(500, 0), true);
	assert.equal(hasIncrementalDeltaStream(undefined, 2), true);
});

test("calculateSessionTokensPerSecond skips windows that were not incremental streaming", () => {
	const spans = [
		// 整段送达：窗口 264 ms、1481 token → 不得进流式分母
		{ startedAt: 1000, firstDeltaAt: 2000, completedAt: 2264, outputTokens: 1481, deltaCount: 2 },
		// 真增量流式：1.0 s、400 token / 400 delta
		{ startedAt: 4000, firstDeltaAt: 5000, completedAt: 6000, outputTokens: 400, deltaCount: 400 },
	];
	const res = calculateSessionTokensPerSecond(spans);
	// 流式只统计第二段（端到端两段都算）
	assert.equal(res.activeStreamingDurationMs, 1000);
	assert.equal(Math.round(res.sessionTps), 400);
	// 端到端两段都算：1881 token ÷ union([1000,2264],[4000,6000]) = 1881 / 3.264 ≈ 576
	assert.equal(res.activeDurationMs, 3264);
	assert.equal(Math.round(res.sessionEndToEndTps), Math.round(1881 / 3.264));
});

test("calculateIntervalUnionDurationMs handles empty or invalid intervals", () => {
	assert.equal(calculateIntervalUnionDurationMs([]), 0);
	assert.equal(calculateIntervalUnionDurationMs([[100, 100]]), 0);
	assert.equal(calculateIntervalUnionDurationMs([[200, 100]]), 0);
	assert.equal(calculateIntervalUnionDurationMs([[Number.NaN, 100]]), 0);
});

test("calculateIntervalUnionDurationMs computes non-overlapping intervals", () => {
	const intervals = [
		[1000, 2000], // 1000ms
		[3000, 4500], // 1500ms
	];
	assert.equal(calculateIntervalUnionDurationMs(intervals), 2500);
});

test("calculateIntervalUnionDurationMs merges overlapping intervals", () => {
	// Subagent 1: 1000 -> 3000 (2000ms)
	// Subagent 2: 2000 -> 4000 (2000ms)
	// Without union: 4000ms (inflated)
	// With union: 1000 -> 4000 = 3000ms
	const intervals = [
		[1000, 3000],
		[2000, 4000],
	];
	assert.equal(calculateIntervalUnionDurationMs(intervals), 3000);
});

test("calculateIntervalUnionDurationMs merges fully contained intervals", () => {
	const intervals = [
		[1000, 5000],
		[2000, 3000],
		[2500, 4000],
	];
	assert.equal(calculateIntervalUnionDurationMs(intervals), 4000);
});

test("calculateIntervalUnionDurationMs handles unsorted intervals", () => {
	const intervals = [
		[5000, 6000], // 1000ms
		[1000, 3000], // 2000ms
		[2500, 3500], // merges with [1000, 3000] -> [1000, 3500] (2500ms)
	];
	// Total: 2500 + 1000 = 3500ms
	assert.equal(calculateIntervalUnionDurationMs(intervals), 3500);
});

test("calculateSessionTokensPerSecond computes session streaming and e2e tps with union", () => {
	// Turn 1 (main reply):
	// startedAt: 1000, firstDeltaAt: 1200, completedAt: 2200 (total: 1200ms, decode: 1000ms), tokens: 50
	// Turn 2 (subagent 1 & 2 run concurrently):
	// subagent 1: startedAt: 3000, firstDeltaAt: 3200, completedAt: 5200 (total: 2200ms, decode: 2000ms), tokens: 100
	// subagent 2: startedAt: 3500, firstDeltaAt: 3700, completedAt: 5500 (total: 2000ms, decode: 1800ms), tokens: 80
	//
	// E2E:
	// intervals: [1000, 2200] (1200ms), [3000, 5200] & [3500, 5500] -> union [3000, 5500] (2500ms)
	// total active E2E duration: 1200 + 2500 = 3700ms
	// total tokens: 50 + 100 + 80 = 230 tokens
	// E2E TPS: 230 / (3700 / 1000) = 62.162...
	//
	// Streaming:
	// streaming intervals: [1200, 2200] (1000ms), [3200, 5200] & [3700, 5500] -> union [3200, 5500] (2300ms)
	// total active streaming duration: 1000 + 2300 = 3300ms
	// total streaming tokens: 230 tokens
	// Streaming TPS: 230 / (3300 / 1000) = 69.696...
	const spans = [
		{ startedAt: 1000, firstDeltaAt: 1200, completedAt: 2200, outputTokens: 50 },
		{ startedAt: 3000, firstDeltaAt: 3200, completedAt: 5200, outputTokens: 100 },
		{ startedAt: 3500, firstDeltaAt: 3700, completedAt: 5500, outputTokens: 80 },
	];

	const res = calculateSessionTokensPerSecond(spans);
	assert.equal(res.totalOutputTokens, 230);
	assert.equal(res.activeDurationMs, 3700);
	assert.equal(res.activeStreamingDurationMs, 3300);
	assert.equal(Math.round(res.sessionEndToEndTps), 62);
	assert.equal(Math.round(res.sessionTps), 70);
});

test("calculateSessionTokensPerSecond handles non-streaming subagents gracefully", () => {
	// Subagent without firstDeltaAt only counts towards E2E
	const spans = [
		{ startedAt: 1000, firstDeltaAt: 1200, completedAt: 2200, outputTokens: 50 },
		{ startedAt: 3000, completedAt: 4000, outputTokens: 100 },
	];
	const res = calculateSessionTokensPerSecond(spans);
	assert.equal(res.totalOutputTokens, 150);
	assert.equal(res.activeDurationMs, 2200); // 1200 + 1000
	assert.equal(res.activeStreamingDurationMs, 1000); // only first span has firstDeltaAt
	// streaming output only includes span 1 (50 tokens / 1.0s = 50 TPS)
	assert.equal(Math.round(res.sessionTps), 50);
	// e2e output includes both (150 tokens / 2.2s = 68.18 TPS)
	assert.equal(Math.round(res.sessionEndToEndTps), 68);
});
