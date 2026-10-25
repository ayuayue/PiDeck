import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const projectTree = readFileSync("src/renderer/src/components/sidebar/ProjectTree.tsx", "utf8");
const worktreeTree = readFileSync("src/renderer/src/components/sidebar/WorktreeTree.tsx", "utf8");
const webSidebar = readFileSync("src/renderer/src/web/WebSidebar.tsx", "utf8");
const projectAvatar = readFileSync("src/renderer/src/components/sidebar/SidebarComponents.tsx", "utf8");
const agentAvatar = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");
const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
const workspaceStyles = readFileSync("src/renderer/src/styles/workspace.css", "utf8");
const themePresets = readFileSync("src/renderer/src/themePresets.ts", "utf8");

test("project Avatar does not aggregate session runtime state", () => {
	assert.doesNotMatch(projectTree, /const projectAgents = props\.controller\.catalog\.agents\.filter/);
	assert.doesNotMatch(projectTree, /const projectStatus =/);
	assert.doesNotMatch(projectTree, /ProjectAvatar/);
	assert.match(projectTree, /t\("app\.chatProject"\)/);
	assert.match(projectTree, /t\("app\.sidebarProjects"\)/);
	assert.doesNotMatch(projectTree, /project-running-badge|project-session-count/);
});

test("no workspace projects renders an empty-state add-directory guide", () => {
	// issue #149 同类反馈：新用户只有内置 Chat 时侧边栏此前不渲染「项目」分组，
	// 只剩搜索行一个 24px + 图标，用户不知道可以添加自己的项目目录。
	// 现在无工作区项目时渲染「项目」分组标题 + 空态引导卡片 + 显眼添加按钮。
	assert.match(projectTree, /workspaceProjects\.length === 0 && \(/);
	assert.match(projectTree, /t\("sidebar\.emptyProjectsTitle"\)/);
	assert.match(projectTree, /t\("sidebar\.emptyProjectsDesc"\)/);
	assert.match(projectTree, /border-dashed border-border-subtle/);
	// 空态按钮必须真正触发添加项目（与标题栏/搜索行同一 actions.projects.add）
	assert.match(projectTree, /onClick=\{\(\) => void props\.actions\.projects\.add\(\)\}/);
});

test("all project rows omit aggregate running and history counts", () => {
	// 数量徽标会把项目容器伪装成运行实体；桌面、worktree、Web 三种入口都保持同一语义。
	for (const source of [projectTree, worktreeTree, webSidebar]) {
		assert.doesNotMatch(source, /project-running-badge|project-session-count|workspace-tree-count/);
	}
});

test("default theme is neutral while green remains an explicit option", () => {
	// 默认 neutral accent = shadcn zinc primary（浅色近黑 #18181b），保证主按钮不是中灰
	assert.match(themePresets, /\{ id: "default", labelKey: "settings\.accent\.default", preview: "#18181b" \}/);
	assert.match(themePresets, /\{ id: "green", labelKey: "settings\.accent\.green", preview: "#4a7854" \}/);
	assert.match(foundation, /--color-accent: #18181b;/);
	assert.match(foundation, /:root\[data-accent="green"\][\s\S]*--color-accent: #4a7854;/);
});

test("sidebar project groups and splitters use soft neutral boundaries", () => {
	const projectGroupStyles = workspaceStyles.match(/\.chat-list-pane\.v3-braun \.sidebar-body \.project-group \{([\s\S]*?)\n\}/)?.[1] ?? "";
	assert.doesNotMatch(projectGroupStyles, /border-bottom:/);
	assert.match(foundation, /\.splitter::before \{[\s\S]*?box-shadow: 0 0 6px/);
	assert.match(foundation, /\.splitter:hover::before,[\s\S]*?box-shadow: 0 0 6px/);
	assert.doesNotMatch(foundation, /\.splitter:hover::before,[\s\S]*--color-accent\) 32%/);
});

test("ProjectAvatar exposes status as an accessible, theme-aware indicator", () => {
	assert.match(projectAvatar, /status\?: "idle" \| "running" \| "starting" \| "error"/);
	assert.match(projectAvatar, /data-avatar-status=\{props\.status \?\? "idle"\}/);
	assert.match(projectAvatar, /avatar-status-indicator/);
	assert.match(foundation, /\.avatar-status-running \.avatar-status-indicator/);
});

test("AgentAvatar uses the same four status states", () => {
	assert.match(agentAvatar, /normalizedStatus = props\.status === "running"/);
	assert.match(agentAvatar, /data-avatar-status=\{normalizedStatus\}/);
	assert.match(agentAvatar, /normalizedStatus === "error"/);
	assert.match(agentAvatar, /normalizedStatus === "starting"/);
	assert.match(agentAvatar, /normalizedStatus === "running"/);
});

test("Avatar status indicator keeps fixed geometry and semantic tokens", () => {
	assert.match(foundation, /\.avatar-status-indicator \{/);
	assert.match(foundation, /width: 11px/);
	assert.match(foundation, /height: 11px/);
	assert.match(foundation, /var\(--color-accent\)/);
	assert.match(foundation, /var\(--color-warning\)/);
	assert.match(foundation, /var\(--color-danger\)/);
});
