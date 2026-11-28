import { sessionTimelineControllerSource } from "./helpers/sessionTimelineControllerSources.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function compile(filePath) {
	const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, { module, exports: module.exports, require: () => ({}) });
	return module.exports;
}

const windowing = compile("src/renderer/src/components/session/timeline/turnRenderWindow.ts");

function runs(...ids) {
	return ids.map((id) => ({ kind: "agent-run", id, items: [] }));
}

test("sliceLastAgentRuns keeps only the trailing maxTurns agent-runs", () => {
	const items = [{ kind: "message", id: "sys" }, ...runs("r1", "r2", "r3", "r4", "r5")];
	const sliced = windowing.sliceLastAgentRuns(items, 3);
	assert.deepEqual(
		sliced.map((item) => item.id),
		["r3", "r4", "r5"],
	);
});

test("sliceLastAgentRuns preserves trailing non-run items after the cut", () => {
	const items = [...runs("r1", "r2", "r3"), { kind: "message", id: "diag" }];
	const sliced = windowing.sliceLastAgentRuns(items, 2);
	assert.deepEqual(
		sliced.map((item) => item.id ?? item.kind),
		["r2", "r3", "diag"],
	);
});

test("sliceLastAgentRuns returns same reference when under the limit", () => {
	const items = runs("r1", "r2");
	assert.equal(windowing.sliceLastAgentRuns(items, 10), items);
});

test("selectTimelineTurnWindow slices past the window turns regardless of following", () => {
	const items = runs("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k");
	assert.equal(windowing.countAgentRunItems(items), 11);
	assert.equal(windowing.shouldWindowTimelineTurns(11, 10), true);
	assert.equal(windowing.shouldWindowTimelineTurns(11, 15), false);
	// 2026-08 治理：非贴底（上滚看历史）同样裁剪，只是窗口更大

	const scrolled = windowing.selectTimelineTurnWindow(items, 10);
	assert.equal(scrolled.length, 10);
	assert.equal(scrolled[0].id, "b");
	assert.equal(scrolled.at(-1).id, "k");
});

test("selectTimelineTurnWindow returns same reference when under the window", () => {
	const items = runs("a", "b", "c");
	assert.equal(windowing.selectTimelineTurnWindow(items, 15), items);
});

test("zero turn-window keeps the entire loaded set available to the virtualizer", () => {
	const items = runs("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k");
	const visible = windowing.resolveAnchoredTurnWindow(items, 0, null);
	assert.equal(visible.length, items.length);
	assert.deepEqual(
		visible.map((item) => item.id),
		items.map((item) => item.id),
	);
});

test("resolveAutoExpandThreshold scales with viewport but floors at 120px", () => {
	// 纯函数文件无依赖，直接编译即可
	const threshold = compile("src/renderer/src/hooks/timeline/autoExpandThreshold.ts");
	// 小视口：下限 120px 兜底，不过早触发
	assert.equal(threshold.resolveAutoExpandThreshold(200), 120);
	// 常规视口（约 800px）：0.4 比例 ≈ 320px，比固定 120px 提前 2.7 倍
	assert.equal(threshold.resolveAutoExpandThreshold(800), 320);
	// 大视口（分屏/全屏）：提前量随视口继续放大
	assert.equal(threshold.resolveAutoExpandThreshold(1600), 640);
});

test("countUserTurns merges consecutive user messages into one turn (speaker-hold semantics)", () => {
	// 连发 3 条 user 无回复 = 1 轮；assistant 回复后下一条 user 才开新轮。
	assert.equal(windowing.countUserTurns([{ role: "user" }, { role: "user" }, { role: "user" }, { role: "assistant" }, { role: "user" }, { role: "assistant" }]), 2);
	// system 诊断卡夹在连发 user 之间不拆轮。
	assert.equal(windowing.countUserTurns([{ role: "user" }, { role: "system" }, { role: "user" }, { role: "assistant" }]), 1);
	// 纯连发无任何回复：整段 1 轮（发言权未交还）。
	assert.equal(windowing.countUserTurns([{ role: "user" }, { role: "user" }, { role: "user" }]), 1);
});
