import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const worktree = readFileSync("src/renderer/src/components/sidebar/WorktreeTree.tsx", "utf8");
const projectTree = readFileSync("src/renderer/src/components/sidebar/ProjectTree.tsx", "utf8");

function loadModel() {
	const source = readFileSync("src/renderer/src/components/sidebar/workspaceTreeModel.ts", "utf8");
	const module = { exports: {} };
	vm.runInNewContext(
		ts.transpileModule(source, {
			compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		}).outputText,
		{ module, exports: module.exports },
		{ filename: "workspaceTreeModel.ts" },
	);
	return module.exports;
}

/**
 * 回归：工作区行不能在外层 button 内再嵌套展开/操作控件；浏览器会把这类
 * 非法交互树合并成不可预测的 click 传播，表现为展开、选择、删除互相串联。
 */
test("worktree rows keep expand and actions outside the selection control", () => {
	assert.doesNotMatch(worktree, /<span[\s\S]*role="button"[\s\S]*onClick/);
	assert.doesNotMatch(worktree, /className="project-action worktree-new-agent"/);
	assert.doesNotMatch(worktree, /className="project-action worktree-remove"/);
});

/**
 * 回归：折叠工作区时不应偷偷渲染前三个历史会话；否则用户点击箭头前就会
 * 看到另一层会话列表，并误以为这些会话属于项目根目录。
 */
test("collapsed worktrees do not mount a nested SessionTree", () => {
	assert.match(worktree, /expanded[\s\S]*&&[\s\S]*<SessionTree/);
	assert.doesNotMatch(worktree, /visibleChildCount=\{expanded \? Number\.MAX_SAFE_INTEGER : 3\}/);
});

test("worktree model deduplicates Windows path variants and keeps the project binding", () => {
	const { mergeWorkspaceTreeRows } = loadModel();
	const childProject = { id: "child-1", name: "T6", path: "c:/repo/T6", lastOpenedAt: 1 };
	const rows = mergeWorkspaceTreeRows([{ path: "C:\\\\repo\\\\T6", branch: "refs/heads/pideck/T6" }], [childProject]);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].project.id, "child-1");
	assert.equal(rows[0].branch, "T6");
});

test("main workspace owns root history and worktree presentation has no connector rail", () => {
	assert.match(worktree, /sessions: readonly SessionRecord\[\]/);
	assert.match(worktree, /<SessionTree[\s\S]*project=\{props\.project\}/);
	assert.match(projectTree, /project\.worktreeEnabled \? \(/);
	assert.match(projectTree, /<WorktreeTree[\s\S]*sessions=\{rootProjectSessions\}/);
	assert.doesNotMatch(worktree, /border-l/);
});
