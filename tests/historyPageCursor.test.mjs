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

const { resolveHistoryPageCursorDecision: d } = compile("src/renderer/src/atoms/historyPageCursor.ts");

test("首屏：不带数值游标（文件头 / entryId 锚点）永远放行", () => {
	assert.equal(d({ hasHistory: false }), "ok");
	assert.equal(d({ hasHistory: false, windowStart: 44 }), "ok");
});

test("首屏：runtime 给的 nextBefore 与 windowStart 不同时也必须放行", () => {
	// 反例（2026-11-25 真机，12754 条会话）：首屏只认 windowStart，而 resolveEarlierHistoryCursor
	// 走 runtime 分支返回的是 runtime.nextBefore（日志实测 12326），两者不等 →
	// 首次点「加载更多」就 rejected-cursor → 用户看到「更早的历史加载失败」，重试永远同样失败。
	assert.equal(d({ hasHistory: false, windowStart: 44, pageNextBefore: 12326, before: 12326 }), "ok");
	assert.equal(d({ hasHistory: false, windowStart: 44, before: 12326, pageNextBefore: 12326 }), "ok");
});

test("首屏：windowStart 那条老路径不能因为放宽而失效", () => {
	assert.equal(d({ hasHistory: false, windowStart: 720, before: 720 }), "ok");
});

test("首屏：与任何已记录游标都不等的数值必须拒绝（防止拼进窗口前那段）", () => {
	assert.equal(d({ hasHistory: false, windowStart: 44, pageNextBefore: 12326, before: 999 }), "rejected-cursor");
	assert.equal(d({ hasHistory: false, before: 999 }), "rejected-cursor");
});

test("已翻过页：必须严格等于上一页写回的续页游标", () => {
	assert.equal(d({ hasHistory: true, historyNextBefore: 500, before: 500 }), "ok");
	assert.equal(d({ hasHistory: true, historyNextBefore: 500, before: 600 }), "rejected-cursor");
	assert.equal(d({ hasHistory: true, historyNextBefore: null, before: undefined }), "rejected-cursor");
});
