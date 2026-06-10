import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadComposerBehaviorModule() {
	const source = readFileSync("src/renderer/src/composerBehavior.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = { exports: {} };
	vm.runInNewContext(outputText, sandbox, {
		filename: "composerBehavior.ts",
	});
	return sandbox.exports;
}

test("ignores Enter while an IME composition is being confirmed", () => {
	const { getComposerEnterIntent } = loadComposerBehaviorModule();

	const intent = getComposerEnterIntent(
		{
			key: "Enter",
			ctrlKey: false,
			metaKey: false,
			shiftKey: false,
			nativeEvent: { isComposing: true },
		},
		"enter-send",
	);

	assert.equal(intent, "ignore");
});

test("sends on plain Enter when Enter-to-send is enabled", () => {
	const { getComposerEnterIntent } = loadComposerBehaviorModule();

	const intent = getComposerEnterIntent(
		{
			key: "Enter",
			ctrlKey: false,
			metaKey: false,
			shiftKey: false,
			nativeEvent: { isComposing: false },
		},
		"enter-send",
	);

	assert.equal(intent, "send");
});

test("inserts newline on Ctrl+Enter when Enter-to-send is enabled", () => {
	const { getComposerEnterIntent } = loadComposerBehaviorModule();

	const intent = getComposerEnterIntent(
		{
			key: "Enter",
			ctrlKey: true,
			metaKey: false,
			shiftKey: false,
			nativeEvent: { isComposing: false },
		},
		"enter-send",
	);

	assert.equal(intent, "newline");
});
