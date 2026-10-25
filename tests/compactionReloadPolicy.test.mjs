import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// shouldReloadMessagesAfterCompaction：压缩结束后是否需要全量重载消息（2026-08 #213）。
//
// 回归背景：#213 里压缩失败（willRetry:false）后仍无条件重载，把同一份巨型 JSONL
// 重读一遍并全量下发，与紧随其后的发消息重载叠加，把渲染进程推到 OOM。
//
// 契约来源（pi docs/rpc.md「compaction_start / compaction_end」）：
// - 成功：result 是对象 {summary, firstKeptEntryId, tokensBefore, usage}
// - 中止：result: null, aborted: true
// - 失败：result: null, aborted: false, errorMessage: "..."
// 因此判定必须是「result 为真」，写成 `result === true` 会永远不重载——
// 前端停在压缩前分支，下一轮继续对话时看起来像“断在旧会话”。

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

const { shouldReloadMessagesAfterCompaction } = compile("src/main/pi/agentUtils.ts");

test("压缩成功（result 为对象）必须重载：前端要切到压缩后的新分支", () => {
	assert.equal(
		shouldReloadMessagesAfterCompaction({
			result: {
				summary: "Summary of conversation...",
				firstKeptEntryId: "abc123",
				tokensBefore: 150000,
			},
		}),
		true,
	);
});

test("压缩失败（result:null + errorMessage）不重载：文件没被改写，重读是纯开销", () => {
	assert.equal(
		shouldReloadMessagesAfterCompaction({
			result: null,
			aborted: false,
			errorMessage: "context window exceeded",
		}),
		false,
	);
});

test("压缩被中止（result:null + aborted）不重载", () => {
	assert.equal(shouldReloadMessagesAfterCompaction({ result: null, aborted: true }), false);
});

test("result 缺失（旧版 pi 不上报结果）按不重载处理（未知成败不用全量读盘赌内存）", () => {
	assert.equal(shouldReloadMessagesAfterCompaction({}), false);
	assert.equal(shouldReloadMessagesAfterCompaction({ result: undefined }), false);
});
