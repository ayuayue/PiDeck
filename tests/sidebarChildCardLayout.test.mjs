import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

/**
 * pure official P2-2：子行尺寸/hover 由组件 Tailwind 承担。
 * 仍保留 session-card 透明容器与状态徽标契约。
 */

const styles = readRendererStyles();
const titleScrollText = readFileSync(
  "src/renderer/src/components/sidebar/TitleScrollText.tsx",
  "utf8",
);
const sessionTree = readFileSync(
  "src/renderer/src/components/sidebar/SessionTree.tsx",
  "utf8",
);
const activeSessionsTree = readFileSync(
  "src/renderer/src/components/sidebar/ActiveSessionsTree.tsx",
  "utf8",
);
const dshSearchResults = readFileSync(
  "src/renderer/src/components/sidebar/DshSearchResults.tsx",
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
  // 选中态对标 dsh-web：只有叶子会话灰底，无 accent / 描边 / 阴影。
  assert.match(sessionTree, /selectedRowClass = "active bg-bg-active text-foreground"/);
  assert.doesNotMatch(sessionTree, /bg-accent\/20/);
  assert.match(sessionTree, /sessionRowClass/);
  assert.match(projectTree, /treeRowClass/);
  assert.match(projectTree, /flex min-h-8 w-full/);
  assert.match(projectTree, /project-fold grid size-6/);
  assert.match(projectTree, /hover:border-border-subtle hover:bg-muted\/60 hover:text-foreground/);
  // 父项目行永不挂选中底，避免和当前会话双高亮。
  assert.doesNotMatch(projectTree, /isCurrent && "active/);
  assert.doesNotMatch(projectTree, /bg-accent\/20/);
  // legacy 层把会话选中底收成灰，不得再混 accent-soft / 内描边。
  const sessionActive = styles.match(/\.session-row\.active \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(sessionActive, /background:\s*var\(--color-bg-active\)/);
  assert.match(sessionActive, /box-shadow:\s*none/);
  assert.doesNotMatch(sessionActive, /accent-soft/);
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

test("sidebar child titles use the shared width clamp and hover-scroll component", () => {
  assert.match(sessionTree, /import \{ TitleScrollText \} from "\.\/TitleScrollText"/);
  assert.match(sessionTree, /<TitleScrollText text=\{child\.agent\.title\} className="font-medium" \/>/);
  assert.match(sessionTree, /标题被截断时 hover 滚动展示全文/);
  assert.match(activeSessionsTree, /import \{ TitleScrollText \} from "\.\/TitleScrollText"/);
  assert.match(activeSessionsTree, /<TitleScrollText text=\{displayTitle\} className="font-medium" \/>/);
  assert.match(dshSearchResults, /import \{ TitleScrollText \} from "\.\/TitleScrollText"/);
  assert.match(dshSearchResults, /text=\{record\.title\}/);
  assert.doesNotMatch(titleScrollText, /title=\{overflowing \? text : undefined\}/);
  assert.match(titleScrollText, /TITLE_SCROLL_PIXELS_PER_SECOND = 20/);
  assert.match(titleScrollText, /TITLE_SCROLL_MIN_DURATION_MS = 1_800/);
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
  // Tab 同样未启动不显示徽章，已启动按状态映射渲染（beui AnimatedBadge 替换裸圆点）。
  assert.match(tabBar, /import \{ sessionStatusBadge \} from "\.\.\/\.\.\/utils\/sessionStatusBadge"/);
  assert.match(tabBar, /const badge = sessionStatusBadge\(status, \{/);
  assert.match(tabBar, /AnimatedBadge/);
  assert.match(tabBar, /badge &&/);
  assert.doesNotMatch(tabBar, /dotClass &&/);
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
  // 项目标签不再作为独立分组标题，而是收拢到 Chats/项目分段 beUI Tab 的 trigger 文案
  assert.match(sidebarContent, /<TabsTrigger[\s\S]{0,500}value="projects"[\s\S]{0,500}\{t\("app\.sidebarProjects"\)\}/);
  // 固定 Tab 与普通 Tab 同宽策略：不再用 w-20 固定宽度（Pin 图标挤占标题空间）
  assert.match(tabBar, /"w-fit max-w-32",/);
  assert.doesNotMatch(tabBar, /pinned \? "w-20"/);
  assert.match(tabBar, /session-tabs-scroll (?:relative )?flex (?:h-full )?min-w-0 flex-1/);
  assert.match(tabBar, /session-tabs-actions flex shrink-0/);
  assert.match(sidebarContent, /sidebar-body flex min-h-0 flex-1 flex-col gap-2 px-2 pt-2 pb-1/);
  assert.match(sessionTree, /min-h-8 w-full/);
  assert.match(sessionTree, /history-session-row mx-0 min-h-8 pl-2 pr-2 py-0/);
  assert.match(sessionTree, /历史会话不是运行中的 Agent/);
  assert.match(sessionTree, /flex flex-col gap-0/);
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

test("text backend badge keeps its width instead of covering tab actions", () => {
  // DSH 标记是文字徽标，不能继续复用图标徽标的固定正方形宽度；否则文本会溢出并覆盖右侧操作按钮。
  assert.doesNotMatch(tabBar, /SessionBackendBadge className=\"size-4 shrink-0\"/);
  assert.match(sourceBadge, /h-4 rounded px-1/);
});

test("session tabs stay outside SessionView; header is standalone in pane", () => {
  assert.match(tabBar, /actions\?: ReactNode/);
  assert.match(tabBar, /props\.onToggleDrawer \? \(/);
  // Tab 栏外置后，SessionView 只渲染独立 Header，不再把操作嵌入 Tab 的 actions 槽。
  assert.doesNotMatch(sessionView, /SessionTabsBar/);
  // header 不再接收 widget chips（2026-08 移除：待办统一走输入框上方常驻条）
  assert.doesNotMatch(sessionView, /widgetChips/);
  assert.doesNotMatch(sessionView, /embedded/);
});
