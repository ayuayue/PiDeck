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

// 折叠项目行的运行黄点回归守卫（用户反馈）：旧口径「Agent 进程存活（starting/idle/running）」
// 在会话跑完/停止但 pi 进程未退出（idle）时仍亮黄点，误导为还在跑；展开后黄点不渲染，
// 子行显示蓝色 idle 点，两处口径不一致。锁定为「会话真的在跑」（starting/running 且无待确认
// ask，与 simple 模式活动指示及子行黄点同口径），禁止回退到 isLiveRuntimeStatus 判定。
test("project running dot only lights when a session is actually running", () => {
	const src = read("src/renderer/src/components/sidebar/ProjectTree.tsx");
	assert.doesNotMatch(src, /hasLiveAgent/);
	assert.doesNotMatch(src, /isLiveRuntimeStatus/);
	// 折叠黄点与 simple 模式活动指示共用同一 hasRunningAgent 判定
	assert.match(src, /collapsed\s*&&\s*hasRunningAgent\s*&&/);
	assert.match(src, /hasRunningAgent\s*\?\s*"running"\s*:\s*undefined/);
});

test("project running hint copy no longer claims process-alive semantics", () => {
	assert.doesNotMatch(read("src/renderer/src/i18n/rendererCopy.zh-CN.ts"), /Agent 进程未退出/);
	assert.doesNotMatch(read("src/renderer/src/i18n/rendererCopy.en-US.ts"), /agent process is still alive/);
	assert.doesNotMatch(read("src/renderer/src/i18n/rendererCopy.zh-TW.ts"), /Agent 程序未退出/);
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
