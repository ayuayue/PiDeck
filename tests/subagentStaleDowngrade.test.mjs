import assert from "node:assert/strict";
import test from "node:test";
import { downgradeRunningStartedBefore, downgradeStaleRunning } from "../src/main/pi/derivedSubagents.ts";

const entry = (overrides = {}) => ({
	id: "a1",
	type: "worker",
	description: "demo",
	status: "running",
	startedAt: 1_000,
	source: "toolcall",
	...overrides,
});

test("downgradeRunningStartedBefore 降级本代 runtime 启动前的 running/queued", () => {
	const result = downgradeRunningStartedBefore(
		[
			// 上一代 runtime 的遗留（启动阈值之前）→ stopped
			entry({ id: "old", startedAt: 500 }),
			// 本代启动之后派发的异步运行 → 保持 running
			entry({ id: "live", startedAt: 2_000 }),
			// 恰好等于启动时刻 → 不降级（保守：可能是本代首批运行）
			entry({ id: "edge", startedAt: 1_000 }),
		],
		1_000,
	);
	assert.deepEqual(
		result.map((e) => [e.id, e.status]),
		[
			["old", "stopped"],
			["live", "running"],
			["edge", "running"],
		],
	);
});

test("downgradeRunningStartedBefore 对 record 源同样生效", () => {
	const result = downgradeRunningStartedBefore([entry({ id: "rec", source: "record", startedAt: 100 })], 1_000);
	assert.equal(result[0].status, "stopped");
});

test("downgradeRunningStartedBefore 不动终态、queued 同样降级、缺 startedAt 保守保留", () => {
	const result = downgradeRunningStartedBefore([entry({ id: "done", status: "completed", startedAt: 100 }), entry({ id: "queued", status: "queued", startedAt: 100 }), entry({ id: "unknown-start", startedAt: undefined })], 1_000);
	assert.deepEqual(
		result.map((e) => [e.id, e.status]),
		[
			["done", "completed"],
			["queued", "stopped"],
			["unknown-start", "running"],
		],
	);
});

test("downgradeRunningStartedBefore 无变化时返回原数组（引用相等）", () => {
	const entries = [entry({ status: "completed" })];
	assert.equal(downgradeRunningStartedBefore(entries, 1_000), entries);
});

test("downgradeStaleRunning 对全部来源生效：无 runtime 时不可能还有活着的子代理", () => {
	const result = downgradeStaleRunning([entry({ id: "t1" }), entry({ id: "r1", source: "record" }), entry({ id: "b1", source: "bridge" }), entry({ id: "done", status: "completed" })]);
	// 历史遗留的 running/queued 不可能还在跑（不是本代 runtime 派发的），一律 stopped；
	// 终态保持原样。这是「几千分钟僵尸时长」的主要止血点。
	assert.deepEqual(
		result.map((e) => [e.id, e.status]),
		[
			["t1", "stopped"],
			["r1", "stopped"],
			["b1", "stopped"],
			["done", "completed"],
		],
	);
});

test("downgradeStaleRunning 无变化时返回原数组（引用相等）", () => {
	const entries = [entry({ status: "completed" })];
	assert.equal(downgradeStaleRunning(entries), entries);
});
