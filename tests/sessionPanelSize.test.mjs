import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadPanelSizeModule() {
	const source = readFileSync("src/renderer/src/components/session/sessionPanelSize.ts", "utf8");
	const output = ts.transpileModule(source, {
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

// vm 沙箱内创建的对象原型与测试上下文不同，逐字段断言避免原型比较干扰。
function expectFallback(result, fallback) {
	assert.equal(result.pixels, fallback);
	assert.equal(result.ready, false);
}

function expectReady(result, pixels) {
	assert.equal(result.pixels, pixels);
	assert.equal(result.ready, true);
}

test("readPanelPixels returns fallback when getSize throws Group not found", () => {
	const { readPanelPixels } = loadPanelSizeModule();
	const panel = {
		getSize: () => {
			throw new Error("Group _r_cf_ not found");
		},
	};
	expectFallback(readPanelPixels(panel, 112), 112);
});

test("readPanelPixels returns fallback for a null panel handle", () => {
	const { readPanelPixels } = loadPanelSizeModule();
	expectFallback(readPanelPixels(null, 112), 112);
	expectFallback(readPanelPixels(undefined, 112), 112);
});

test("readPanelPixels returns fallback for non-finite pixels", () => {
	const { readPanelPixels } = loadPanelSizeModule();
	const panel = { getSize: () => ({ inPixels: Number.NaN }) };
	expectFallback(readPanelPixels(panel, 112), 112);
});

test("readPanelPixels rounds a valid pixel size and reports ready", () => {
	const { readPanelPixels } = loadPanelSizeModule();
	const panel = { getSize: () => ({ inPixels: 123.6 }) };
	expectReady(readPanelPixels(panel, 112), 124);
});

test("readPanelPixels passes through an integer pixel size", () => {
	const { readPanelPixels } = loadPanelSizeModule();
	const panel = { getSize: () => ({ inPixels: 120 }) };
	expectReady(readPanelPixels(panel, 112), 120);
});
