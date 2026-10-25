import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// boundTurnWindowStart：轮数窗口之上再叠一层条目预算（2026-08 #213）。
// 核心契约：预算只决定「一次展示多少轮」，页边界永远对齐完整轮次，
// 单轮自身超预算也必须整轮保留（至少保最后一轮），不允许返回空页。
// 回归背景：#213 里「12 轮」= 2162 条消息，一次读盘 + 全量 IPC 把渲染进程推到 OOM。

function compile(filePath) {
	const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: () => ({}),
		},
		{ filename: filePath },
	);
	return module.exports;
}

const { boundTurnWindowStart, findTurnPageStart } = compile("src/main/pi/SessionHistoryReader.ts");

/** 构造轮次：每个 user 后面跟 steps 条造轮内容，角色序列决定轮次边界。 */
function buildTurns(turns, stepsPerTurn) {
	const entries = [];
	for (let turn = 0; turn < turns; turn += 1) {
		entries.push({ role: "user", byteLength: 0 });
		for (let step = 0; step < stepsPerTurn; step += 1) {
			entries.push({ role: step % 2 === 0 ? "assistant" : "toolResult", byteLength: 0 });
		}
	}
	return entries;
}

test("未启用预算（maxEntries<=0 或非有限值）时与 findTurnPageStart 完全一致", () => {
	const entries = buildTurns(8, 40);
	const expected = findTurnPageStart(entries, entries.length, 3);
	for (const maxEntries of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
		assert.equal(boundTurnWindowStart(entries, entries.length, 3, maxEntries), expected, `maxEntries=${maxEntries} 应退回轮数窗口结果`);
	}
});

test("未超预算时结果与纯轮数窗口一致（不无谓缩小窗口）", () => {
	const entries = buildTurns(9, 20);
	assert.equal(boundTurnWindowStart(entries, entries.length, 3, 1600), findTurnPageStart(entries, entries.length, 3));
});

test("超预算时按完整轮次收紧，起点仍落在轮次起点（user）上", () => {
	// 12 轮 × 100 条 = 1200 条；预算 250 只能留整轮，最多 3 轮（250/100）
	const entries = buildTurns(12, 100);
	const start = boundTurnWindowStart(entries, entries.length, 12, 250);
	assert.equal(entries[start].role, "user", "页起点必须是轮次起点");
	const windowed = entries.length - start;
	assert.ok(windowed <= 250, `窗口 ${windowed} 条应不超预算 250`);
	assert.ok(windowed > 150, `窗口 ${windowed} 条应尽量用满预算（不止保 1 轮）`);
	// 不向更早扩：不会超出轮数窗口允许的范围
	assert.ok(start >= findTurnPageStart(entries, entries.length, 12));
});

test("单轮自身超预算时至少保留最后一轮（不返回空页、不切半轮）", () => {
	const entries = buildTurns(6, 100);
	let lastTurnStart = 0;
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		if (entries[i].role === "user") {
			lastTurnStart = i;
			break;
		}
	}
	const start = boundTurnWindowStart(entries, entries.length, 12, 5);
	assert.equal(start, lastTurnStart, "预算小于单轮体量时保最后一轮起点");
	assert.equal(entries.length - start, 101, "最后一轮（1 user + 100 步）整轮保留");
});

test("没有 user 轮次边界（纯 assistant/system 片段）时不裁剪", () => {
	const entries = buildTurns(4, 30).filter((entry) => entry.role !== "user");
	const start = boundTurnWindowStart(entries, entries.length, 2, 10);
	assert.equal(start, findTurnPageStart(entries, entries.length, 2), "无边界时退回轮数窗口结果");
});

test("空输入与 before<=0 安全返回会话头", () => {
	assert.equal(boundTurnWindowStart([], 0, 3, 10), 0);
	assert.equal(boundTurnWindowStart(buildTurns(3, 5), 0, 3, 10), 0);
});
