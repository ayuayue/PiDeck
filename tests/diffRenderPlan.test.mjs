import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * diffRenderPlan 分档策略单测：大文件 diff 不再一刀切降级，
 * 而是按行数分为 hunk（完整能力）/ hunk-limited（降质）/ fallback（放弃）三档。
 */

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

function loadModule() {
	const sandbox = { exports: {} };
	vm.runInNewContext(transpile("src/renderer/src/utils/diffRenderPlan.ts"), sandbox, { filename: "diffRenderPlan.ts" });
	return sandbox.exports;
}

const { getDiffRenderPlan } = loadModule();
const HUNK = 50_000;
const LIMITED = 200_000;

test("small files get the full hunk plan", () => {
	const plan = getDiffRenderPlan(100, 100);
	assert.equal(plan.mode, "hunk");
});

test("empty contents (0 lines) still get the full plan", () => {
	const plan = getDiffRenderPlan(0, 0);
	assert.equal(plan.mode, "hunk");
});

test("the 17k-line case that used to fall back now renders", () => {
	// 回归锚点：17,294 / 17,266 行 —— 旧实现（>5000 行）直接降级提示，
	// 新实现应在 hunk 档完整渲染（差异行少，折叠 + 虚拟化后开销极小）。
	const plan = getDiffRenderPlan(17_294, 17_266);
	assert.equal(plan.mode, "hunk");
});

test("boundary: one side exactly at the full limit stays hunk", () => {
	const plan = getDiffRenderPlan(HUNK, 10);
	assert.equal(plan.mode, "hunk");
});

test("one side slightly over the full limit downgrades to hunk-limited", () => {
	const plan = getDiffRenderPlan(HUNK + 1, 10);
	assert.equal(plan.mode, "hunk-limited");
	// 降质档：高亮额度收窄、单次展开行数减半
	assert.ok(plan.tokenizeMaxLength < 100_000);
	assert.ok(plan.expansionLineCount < 200);
});

test("hunk-limited keeps both sides bounded by the same limit", () => {
	const plan = getDiffRenderPlan(10, HUNK + 1);
	assert.equal(plan.mode, "hunk-limited");
});

test("boundary: exactly at the limited limit stays hunk-limited", () => {
	const plan = getDiffRenderPlan(LIMITED, 10);
	assert.equal(plan.mode, "hunk-limited");
});

test("beyond the safety limit falls back to the git-diff hint", () => {
	const plan = getDiffRenderPlan(LIMITED + 1, 10);
	assert.equal(plan.mode, "fallback");
});

test("fallback triggers on either side", () => {
	const plan = getDiffRenderPlan(10, LIMITED + 1);
	assert.equal(plan.mode, "fallback");
});

test("hunk-limited plans carry sane memory-bounded values", () => {
	const plan = getDiffRenderPlan(HUNK + 1, HUNK + 1);
	assert.equal(plan.mode, "hunk-limited");
	assert.ok(plan.tokenizeMaxLength <= 30_000, "tokenize quota bounded");
	assert.ok(plan.expansionLineCount <= 100, "expansion step bounded");
});
