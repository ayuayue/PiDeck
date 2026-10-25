import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);

function loadMergeAnimationsModule() {
	const output = ts.transpileModule(readFileSync("src/renderer/src/lib/stick-to-bottom/mergeAnimations.ts", "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: "mergeAnimations.ts",
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		require: nodeRequire,
	});
	return module.exports;
}

test("mergeAnimations cache does not let instant poison smooth", () => {
	const mod = loadMergeAnimationsModule();
	mod.clearMergeAnimationsCacheForTests();

	// 模拟 MessageScroller mount：先 instant，再 smooth（弹簧）
	assert.equal(mod.mergeAnimations({}, "instant"), "instant");
	const spring = mod.mergeAnimations({}, "smooth");
	assert.notEqual(spring, "instant");
	assert.equal(typeof spring, "object");
	assert.equal(spring.damping, 0.7);
});

test("mergeAnimations cache does not let smooth poison instant", () => {
	const mod = loadMergeAnimationsModule();
	mod.clearMergeAnimationsCacheForTests();

	const spring = mod.mergeAnimations({}, "smooth");
	assert.equal(typeof spring, "object");
	assert.equal(mod.mergeAnimations({}, "instant"), "instant");
});

test("mergeAnimations later instant wins over earlier options object", () => {
	const mod = loadMergeAnimationsModule();
	mod.clearMergeAnimationsCacheForTests();
	assert.equal(mod.mergeAnimations({ damping: 0.5 }, "instant"), "instant");
});
