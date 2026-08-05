import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

/**
 * pure official P2-2：子行尺寸/hover 由组件 Tailwind 承担。
 * 仍保留 session-card 透明容器与状态徽标契约。
 */

const styles = readRendererStyles();
const sessionTree = readFileSync(
  "src/renderer/src/components/sidebar/SessionTree.tsx",
  "utf8",
);
const projectTree = readFileSync(
  "src/renderer/src/components/sidebar/ProjectTree.tsx",
  "utf8",
);
const agentListDisplay = readFileSync(
  "src/renderer/src/agentListDisplay.ts",
  "utf8",
);
const tabBar = readFileSync(
  "src/renderer/src/components/session/SessionTabsBar.tsx",
  "utf8",
);
const sessionView = readFileSync(
  "src/renderer/src/components/session/SessionView.tsx",
  "utf8",
);
const sourceBadge = readFileSync(
  "src/renderer/src/components/session/SessionSourceBadge.tsx",
  "utf8",
);

test("sidebar child rows use shared official hover/active classes", () => {
  assert.match(sessionTree, /hover:border-border-subtle hover:bg-muted\/60 hover:text-foreground/);
  assert.match(sessionTree, /active border-border-strong bg-accent\/20 text-foreground/);
  assert.match(sessionTree, /sessionRowClass/);
  assert.match(projectTree, /treeRowClass/);
  assert.match(projectTree, /flex min-h-7 w-full/);
  assert.match(projectTree, /project-fold grid size-6/);
  assert.match(projectTree, /hover:border-border-subtle hover:bg-muted\/60 hover:text-foreground/);
});

test("sidebar workspace wrapper stays transparent", () => {
  const workspaceCard = styles.match(
    /\.chat-list-pane\.v3-braun \.sidebar-body \.session-card \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(workspaceCard, "sidebar workspace card styles must exist");
  assert.match(workspaceCard, /background:\s*transparent;/);
  assert.match(workspaceCard, /border:\s*0;/);
  assert.match(workspaceCard, /overflow:\s*visible;/);
});

test("sidebar child titles truncate via component classes", () => {
  assert.match(sessionTree, /truncate font-medium/);
  assert.match(projectTree, /truncate font-medium/);
});

test("session status indicators stay on the concrete session row", () => {
  // Tab 与侧栏会话行共享蓝/黄/红状态点语义。
  assert.match(agentListDisplay, /export function sessionStatusDotClass/);
  assert.match(agentListDisplay, /case "idle"/);
  assert.match(agentListDisplay, /return "bg-info"/);
  assert.match(agentListDisplay, /case "error"/);
  assert.match(agentListDisplay, /return "bg-danger"/);
  assert.match(agentListDisplay, /case "running"/);
  assert.match(agentListDisplay, /return "bg-warning"/);
  // 未启动/无 runtime（含 detached）不渲染色点。
  assert.match(agentListDisplay, /if \(!status \|\| status === "detached"\) return undefined/);
  // SessionTree 不再渲染带文本的状态徽标；无 runtime 的历史记录不显示状态点。
  assert.doesNotMatch(sessionTree, /\/agent-status-indicator/);
  assert.match(sessionTree, /function renderRuntimeStatusDot/);
  assert.match(sessionTree, /sessionStatusDotClass\(status\)/);
  assert.match(sessionTree, /renderRuntimeStatusDot\(child\.agent\.status\)/);
  assert.match(sessionTree, /renderRuntimeStatusDot\(runtimeSnapshot\?\.status\)/);
  // Tab 同样未启动不显示点，已启动按状态点渲染。
  assert.match(tabBar, /sessionStatusDotClass\(status\)/);
  assert.match(tabBar, /dotClass &&/);
});

test("project children use spacing without connector lines and chat uses the shared row", () => {
  assert.doesNotMatch(projectTree, /border-l/);
  assert.match(styles, /\.worktree-children \{[\s\S]*?border-left:\s*0;/);
  assert.doesNotMatch(projectTree, /chat-project-guide/);
  assert.doesNotMatch(styles, /\.project-group\.chat-project-group/);
});

test("sidebar omits the redundant projects heading and tabs shrink to their titles", () => {
  const sidebarContent = readFileSync(
    "src/renderer/src/components/sidebar/SidebarContent.tsx",
    "utf8",
  );

  assert.doesNotMatch(sidebarContent, /FolderTree/);
  assert.doesNotMatch(sidebarContent, /app\.sidebarProjects/);
  assert.match(tabBar, /pinned \? "w-20" : "w-fit max-w-32"/);
  assert.doesNotMatch(tabBar, /pinned \? "w-20" : "w-32"/);
  assert.match(tabBar, /session-tabs-scroll flex min-w-0 flex-1/);
  assert.match(tabBar, /session-tabs-actions flex shrink-0/);
  assert.match(sidebarContent, /sidebar-body flex min-h-0 flex-1 flex-col gap-2 px-1\.5 py-1/);
  assert.match(sessionTree, /min-h-11 items-center/);
  assert.match(sessionTree, /history-session-row mx-0 mb-1 last:mb-0 min-h-11 pl-3 pr-3 py-2/);
  assert.match(sessionTree, /历史会话不是运行中的 Agent/);
  assert.match(sessionTree, /flex flex-col gap-2 py-1/);
  assert.match(styles, /\.chat-list-pane\.v3-braun \.sidebar-body \.session-row[\s\S]*?margin: 0;/);
  const conversationTitleSpan = styles.match(
    /\.conversation-title span \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(conversationTitleSpan, "conversation title span styles must exist");
  assert.doesNotMatch(conversationTitleSpan, /color:/);
  assert.match(styles, /\.conversation-title span\.running \{[\s\S]*color:/);
  assert.match(sourceBadge, /<Badge[\s\S]*variant="outline"/);
  assert.match(sourceBadge, /<SourceLogo source=\{props\.source\} \/>/);
  assert.match(sourceBadge, /aria-label=\{label\}/);
  assert.doesNotMatch(sourceBadge, />\{label\}<\//);
  assert.doesNotMatch(sessionTree, /session-source-badge/);
  assert.doesNotMatch(sourceBadge, /bg-(?:indigo|amber|emerald)-/);
});

test("session actions render below the tab bar so tabs keep their full width", () => {
  assert.match(tabBar, /actions\?: ReactNode/);
  assert.match(tabBar, /props\.actions !== null/);
  assert.match(tabBar, /props\.actions \?\?/);
  assert.match(sessionView, /<SessionTabsBar \{\.\.\.sessionTabs\} actions=\{null\} \/>[\s\S]*<SessionHeader\s*\n\s*headerRef=/);
  assert.doesNotMatch(sessionView, /<SessionTabsBar[\s\S]*actions=\{[\s\S]*<SessionHeader[\s\S]*embedded/);
});
