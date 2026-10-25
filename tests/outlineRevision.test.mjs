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

const outlineRevision = compile("src/renderer/src/atoms/outlineRevision.ts");

const message = (id, role, text = id) => ({
	id,
	agentId: "agent",
	role,
	text,
	timestamp: 1,
});

test("assistant tail updates preserve the outline revision", () => {
	const current = [message("question", "user"), message("answer", "assistant", "partial")];

	assert.equal(outlineRevision.shouldRefreshOutlineForRuntimeUpsert(current, 0, 1, [message("answer", "assistant", "completed")]), false);
});

test("a runtime upsert touching an earlier user checkpoint refreshes the outline", () => {
	const current = [message("first", "user", "First"), message("first-answer", "assistant"), message("last", "user", "Last"), message("last-answer", "assistant")];

	assert.equal(outlineRevision.shouldRefreshOutlineForRuntimeUpsert(current, 2, 0, [message("first", "user", "Edited first"), ...current.slice(1)]), true);
});

test("a newly appended user checkpoint refreshes the outline", () => {
	const current = [message("question", "user"), message("answer", "assistant")];

	assert.equal(outlineRevision.shouldRefreshOutlineForRuntimeUpsert(current, 0, 2, [message("follow-up", "user")]), true);
});

test("an invalid incremental boundary refreshes the outline conservatively", () => {
	const current = [message("question", "user")];

	assert.equal(outlineRevision.shouldRefreshOutlineForRuntimeUpsert(current, 0, 2, [message("answer", "assistant")]), true);
});
