import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadGuardModule() {
	const output = ts.transpileModule(readFileSync("src/renderer/src/lib/stick-to-bottom/resizeScrollGuard.ts", "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		require: () => ({}),
	});
	return module.exports;
}

const guard = loadGuardModule();

test("an older equal-sized resize cannot clear the latest scroll guard", () => {
	const state = { resizeDifference: 0, resizeGeneration: 0 };

	const first = guard.markResizeScrollGuard(state, 28);
	const second = guard.markResizeScrollGuard(state, 28);

	guard.clearResizeScrollGuard(state, first);
	assert.equal(state.resizeDifference, 28);

	guard.clearResizeScrollGuard(state, second);
	assert.equal(state.resizeDifference, 0);
});

test("only the latest resize generation can clear the guard", () => {
	const state = { resizeDifference: 0, resizeGeneration: 0 };

	const first = guard.markResizeScrollGuard(state, -120);
	const second = guard.markResizeScrollGuard(state, 36);

	guard.clearResizeScrollGuard(state, first);
	assert.equal(state.resizeDifference, 36);

	guard.clearResizeScrollGuard(state, second);
	assert.equal(state.resizeDifference, 0);
});
