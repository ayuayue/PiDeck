import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (p) => readFileSync(p, "utf8");

// 侧栏项目行的 Git 分支徽标已按用户反馈移除（项目行信息过载、视觉噪音大）。
// 下面的断言是「不许长回来」的回归守卫：分支只在 worktree 主工作区行与 Git 抽屉里展示。

test("ProjectTree no longer renders a git branch badge on the project row", () => {
	const src = read("src/renderer/src/components/sidebar/ProjectTree.tsx");
	// 项目行不再取当前分支，也不再为徽标引入 GitBranch 图标
	assert.doesNotMatch(src, /const\s+branch\s*=\s*props\.branchByProject/);
	assert.doesNotMatch(src, /<GitBranch/);
	assert.doesNotMatch(src, /title=\{t\("app\.currentBranch"/);
});

test("ProjectTree still passes branchByProject to the worktree tree", () => {
	const src = read("src/renderer/src/components/sidebar/ProjectTree.tsx");
	// worktree 主工作区行的分支展示依赖这份字典，删徽标时不能顺手删掉
	assert.match(src, /branch=\{props\.branchByProject\?\.\[project\.id\]\}/);
});

test("i18n no longer ships the removed project-row branch copy", () => {
	const zh = read("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
	const en = read("src/renderer/src/i18n/rendererCopy.en-US.ts");
	assert.doesNotMatch(zh, /"app\.currentBranch"/);
	assert.doesNotMatch(en, /"app\.currentBranch"/);
});

test("useProjectSync keeps worktree branch lookup but drops per-project branch fetching", () => {
	const src = read("src/renderer/src/hooks/useProjectSync.ts");
	// 分支字典仍由 refreshWorktrees 写入（worktree 主工作区行显示分支）
	assert.match(src, /setBranchByProject\(\(prev\)\s*=>\s*\(\{\s*\.\.\.prev,\s*\[projectId\]:\s*branchInfo\.current\s*\}\)\)/);
	// 仅为项目行徽标存在的按项目拉取逻辑已删除，避免每次刷新多跑一轮 git
	assert.doesNotMatch(src, /refreshProjectBranch/);
});

test("App.tsx synchronizes branch changes to branchByProject", () => {
	const src = read("src/renderer/src/App.tsx");
	// 解构 setBranchByProject
	assert.match(src, /const\s*\{[^}]*setBranchByProject[^}]*\}\s*=\s*useProjectSync/);
	// handleProjectGitChanged 回写 setBranchByProject
	assert.match(src, /setBranchByProject\(\(prev\)\s*=>\s*\(prev\[projectId\]\s*===\s*info\.current\s*\?\s*prev\s*:\s*\{\s*\.\.\.prev,\s*\[projectId\]:\s*info\.current\s*\}\)\)/);
});
