import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { stampIdleSessionDuration } = loadTsCommonJs("src/renderer/src/rendererUtils.ts");

function stamp(input) {
	// TypeScript loader 在独立 VM realm 执行，normalize 后再和 Node 断言 realm 比较。
	return JSON.parse(JSON.stringify(stampIdleSessionDuration(input)));
}

test("idle duration stamps only on the running → idle edge", () => {
	const started = stamp({
		previousStatus: "idle",
		status: "running",
		startedAt: undefined,
		now: 1000,
	});
	assert.deepEqual(started, { startedAt: 1000 });

	const stillRunning = stamp({
		previousStatus: "running",
		status: "running",
		startedAt: 1000,
		now: 1500,
	});
	assert.deepEqual(stillRunning, { startedAt: 1000 });

	const finished = stamp({
		previousStatus: "running",
		status: "idle",
		startedAt: 1000,
		now: 1800,
	});
	assert.equal(finished.durationMs, 800);
	assert.equal(finished.clearStart, true);

	// 已经 idle 后再被 displayAgents 新引用戳一次，不得反复 Date.now() setState。
	const stillIdle = stamp({
		previousStatus: "idle",
		status: "idle",
		startedAt: 1000,
		now: 2500,
	});
	assert.deepEqual(stillIdle, { startedAt: 1000 });
});
