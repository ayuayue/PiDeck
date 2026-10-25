import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadLayoutModule() {
	const source = readFileSync("src/renderer/src/hooks/useSessionLayout.ts", "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		require: () => ({}),
	});
	return module.exports;
}

test("layout reserves queue and terminal space before sizing the composer", () => {
	const { calculateSessionLayout } = loadLayoutModule();
	const layout = calculateSessionLayout({
		chatPaneHeight: 900,
		headerHeight: 80,
		composerChromeHeight: 20,
		terminalRequestedHeight: 320,
		terminalOpen: true,
		terminalClosing: false,
		terminalCollapsed: false,
		queuedPromptCount: 2,
	});
	assert.equal(layout.queuedBudget, 106);
	assert.equal(layout.terminalRowHeight, 320);
	assert.equal(layout.maxComposerHeight, 320);
});

test("layout removes terminal reservation while its close animation runs", () => {
	const { calculateSessionLayout } = loadLayoutModule();
	const layout = calculateSessionLayout({
		chatPaneHeight: 700,
		headerHeight: 78,
		composerChromeHeight: 0,
		terminalRequestedHeight: 400,
		terminalOpen: true,
		terminalClosing: true,
		terminalCollapsed: false,
		queuedPromptCount: 0,
	});
	assert.equal(layout.terminalRowHeight, 0);
	assert.equal(layout.maxComposerHeight, 462);
});
