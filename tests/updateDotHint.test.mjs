/**
 * 更新圆点首次解释气泡（coachmark）显示判定测试。
 * 规则：hasPendingUpdate 从 false → true 的上升沿，且用户从未看过解释，才显示。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadUpdateDotHint() {
	const filePath = "src/renderer/src/utils/updateDotHint.ts";
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: () => {
				throw new Error("unexpected require");
			},
		},
		{ filename: filePath },
	);
	return module.exports;
}

const { shouldShowUpdateDotHint } = loadUpdateDotHint();

test("shows on the rising edge when the hint has never been seen", () => {
	assert.equal(shouldShowUpdateDotHint({ hasPendingUpdate: true, prevHasPendingUpdate: false, hintSeen: false }), true);
});

test("does not show when the dot was already lit in the previous frame", () => {
	// 持续亮着（用户已在上一次变化时被告知）不重复弹。
	assert.equal(shouldShowUpdateDotHint({ hasPendingUpdate: true, prevHasPendingUpdate: true, hintSeen: false }), false);
});

test("does not show when there is no pending update", () => {
	assert.equal(shouldShowUpdateDotHint({ hasPendingUpdate: false, prevHasPendingUpdate: false, hintSeen: false }), false);
	// 更新消失（false 沿）也不是展示时机。
	assert.equal(shouldShowUpdateDotHint({ hasPendingUpdate: false, prevHasPendingUpdate: true, hintSeen: false }), false);
});

test("does not show again once the explanation has been seen", () => {
	assert.equal(shouldShowUpdateDotHint({ hasPendingUpdate: true, prevHasPendingUpdate: false, hintSeen: true }), false);
});

test("a new pending update after a seen explanation stays silent", () => {
	// 已看过一次解释（持久化标记），后续任何新版本出现都不再打扰。
	assert.equal(shouldShowUpdateDotHint({ hasPendingUpdate: true, prevHasPendingUpdate: false, hintSeen: true }), false);
});
