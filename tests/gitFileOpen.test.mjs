import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * Git 变更行内「打开文件」按钮的顺序契约（回归测试）：
 * 先前端 Git Diff 被清掉（Diff 在中间栏阅读面独占优先级，不清则新 Tab 被盖住、表现为
 * 「点击打开没反应」），再以可编辑的常驻 View Tab 打开文件。
 */

function loadGitFileOpen() {
	const source = readFileSync("src/renderer/src/utils/gitFileOpen.ts", "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
		fileName: "gitFileOpen.ts",
	}).outputText;
	const sandbox = { exports: {}, require: () => ({}) };
	vm.runInNewContext(output, sandbox, { filename: "gitFileOpen.ts" });
	return sandbox.exports;
}

test("openGitFileInEditor: 先 dismiss Git Diff，再以 view/permanent 打开", () => {
	const { openGitFileInEditor } = loadGitFileOpen();
	const calls = [];
	const dismiss = () => calls.push("dismiss");
	const openTab = (...args) => calls.push(["open", ...args]);

	openGitFileInEditor(dismiss, openTab, "/repo/docs-site/changelog.md");

	assert.deepEqual(calls, [
		"dismiss",
		["open", "/repo/docs-site/changelog.md", "view", undefined, undefined, true, undefined, undefined, undefined, "permanent"],
	]);
});

test("openGitFileInEditor: 无 Git Diff 打开也保持 dismiss→open 顺序（幂等清理）", () => {
	const { openGitFileInEditor } = loadGitFileOpen();
	const calls = [];
	const dismiss = () => calls.push("dismiss");
	const openTab = (...args) => calls.push(["open", ...args]);

	openGitFileInEditor(dismiss, openTab, "src/main.ts");
	openGitFileInEditor(dismiss, openTab, "src/renderer.ts");

	assert.equal(calls.length, 4);
	assert.equal(calls[0], "dismiss");
	assert.equal(calls[1][0], "open");
	assert.equal(calls[2], "dismiss");
	assert.equal(calls[3][0], "open");
});
