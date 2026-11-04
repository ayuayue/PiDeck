import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// Phase 0 渲染层探针（docs/acp-replay-batching-plan.md）：默认关闭，开启只做观察。
const probe = loadTsCommonJs("src/renderer/src/utils/perfProbe.ts");

const storageWith = (value) => ({ getItem: (key) => (key === probe.PERF_PROBE_STORAGE_KEY ? value : null) });

test("probe is off unless the local flag says otherwise", () => {
	assert.equal(probe.isPerfProbeEnabled(storageWith("1")), true);
	assert.equal(probe.isPerfProbeEnabled(storageWith("0")), false);
	assert.equal(probe.isPerfProbeEnabled(storageWith(null)), false);
	assert.equal(probe.isPerfProbeEnabled(null), false);
	// 存储被禁用（隐私模式）时抛错：当作关闭，不让探针变成新的失败源
	assert.equal(
		probe.isPerfProbeEnabled({
			getItem: () => {
				throw new Error("denied");
			},
		}),
		false,
	);
});

test("disabled probe installs nothing", () => {
	const lines = [];
	const uninstall = probe.installPerfProbe({ log: (line) => lines.push(line), storage: storageWith(null) });
	uninstall();
	assert.equal(lines.length, 0);
});

test("formatters stay one line and carry the numbers", () => {
	assert.match(probe.formatLongTaskLine(120.4, 3456.7), /^\[perf\] longtask 120ms @3457ms$/);
	assert.match(probe.formatLongTaskSummary({ count: 3, maxMs: 210, totalMs: 330, windowMs: 5000 }), /tasks=3 max=210ms avg=110ms total=330ms window=5000ms/);
});
