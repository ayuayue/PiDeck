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

const policy = compile("src/renderer/src/components/session/timeline/historyPagePolicy.ts");

test("定位跳转用专用小页：不得沿用 backfill 的 200 轮", () => {
	// 反例（2026-11-25 真机，12754 条消息）：跳转沿用 backfill 的 200 轮 = 5565 条，
	// 每次跳都要投影 5565 条再合并 —— 用户看到的是「点了要等很久」。
	// 锚点窗口只挂 1 前 3 后共 5 轮，多拿的轮既不显示又要付投影代价。
	assert.equal(policy.resolveHistoryPageSize("jump"), 5, "跳转页必须是 5 轮");
	assert.ok(policy.resolveHistoryPageSize("jump") < policy.resolveHistoryPageSize("backfill"), "必须小于 backfill");
	assert.equal(policy.resolveHistoryPageSize("backfill"), 200, "backfill 保持 200（滚动预取要一次多拿）");
});

test("页大小四个来源互不相同，跳转不吃 backfill 的值", () => {
	const sizes = ["button", "scroll", "backfill", "jump"].map((s) => policy.resolveHistoryPageSize(s));
	assert.deepEqual(sizes, [10, 3, 200, 5], "四档：按钮 10 / 滚动 3 / 预取 200 / 跳转 5");
});
