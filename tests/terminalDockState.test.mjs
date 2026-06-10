import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadTerminalDockStateModule() {
	const source = readFileSync("src/renderer/src/terminalDockState.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	});
	const sandbox = { exports: {} };
	vm.runInNewContext(outputText, sandbox, {
		filename: "terminalDockState.ts",
	});
	return sandbox.exports;
}

test("remembers collapsed terminal dock state for each agent", () => {
	const { setTerminalDockCollapsed } = loadTerminalDockStateModule();
	const current = {
		agentA: { open: true, collapsed: false },
		agentB: { open: true, collapsed: false },
	};

	const next = setTerminalDockCollapsed(current, "agentA", true);

	assert.equal(next.agentA.collapsed, true);
	assert.equal(next.agentA.open, true);
	assert.equal(next.agentB.collapsed, false);
});

test("preserves collapsed state when toggling terminal open state", () => {
	const { setTerminalDockOpen } = loadTerminalDockStateModule();
	const current = {
		agentA: { open: true, collapsed: true },
	};

	const closed = setTerminalDockOpen(current, "agentA", false);
	const reopened = setTerminalDockOpen(closed, "agentA", true);

	assert.equal(closed.agentA.open, false);
	assert.equal(closed.agentA.collapsed, true);
	assert.equal(reopened.agentA.open, true);
	assert.equal(reopened.agentA.collapsed, true);
});

test("prunes terminal dock state for removed agents", () => {
	const { pruneTerminalDockState } = loadTerminalDockStateModule();
	const current = {
		agentA: { open: true, collapsed: true },
		agentB: { open: true, collapsed: false },
	};

	const next = pruneTerminalDockState(current, new Set(["agentB"]));

	assert.equal(next.agentA, undefined);
	assert.equal(next.agentB.open, true);
	assert.equal(next.agentB.collapsed, false);
});
