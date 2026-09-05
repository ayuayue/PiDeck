// 回归测试：侧栏 worktree 工作区行的四个行为契约。
// 背景问题：
// 1) 选中某个工作区时整个区块（含会话列表）被压暗——active 只能挂在分支名行上；
// 2) 主工作区没有折叠入口；
// 3) 新建/匿名按钮只在项目行上，worktree 模式下入口不明显——挪到工作区行。
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const worktreeTree = readFileSync("src/renderer/src/components/sidebar/WorktreeTree.tsx", "utf8");
const sessionTree = readFileSync("src/renderer/src/components/sidebar/SessionTree.tsx", "utf8");
const workspaceStyles = readFileSync("src/renderer/src/styles/workspace.css", "utf8");
const projectTree = readFileSync("src/renderer/src/components/sidebar/ProjectTree.tsx", "utf8");
const sidebarContent = readFileSync("src/renderer/src/components/sidebar/SidebarContent.tsx", "utf8");
const sidebarComponents = readFileSync("src/renderer/src/components/sidebar/SidebarComponents.tsx", "utf8");

test("main workspace is collapsible via the shared worktree expand set", () => {
  assert.match(worktreeTree, /mainCollapsed/);
  assert.match(worktreeTree, /toggleWorktreeSessions\(mainSessionsKey\)/);
  // 折叠时不渲染会话列表
  assert.match(worktreeTree, /\{!mainCollapsed && \(/);
});

test("workspace title actions match the normal project toolbar", () => {
  const mainSection = worktreeTree.slice(
    worktreeTree.indexOf("workspace-tree-main"),
    worktreeTree.indexOf("workspace-tree-list"),
  );
  assert.doesNotMatch(mainSection, /<NewSessionMenu/);
  assert.match(mainSection, /<Ellipsis/);
  assert.match(mainSection, /createDraft\(props\.project\.id\)/);
  assert.match(mainSection, /projectId: props\.project\.id/);

  const rowView = worktreeTree.slice(worktreeTree.lastIndexOf("WorkspaceTreeRowView"));
  assert.doesNotMatch(rowView, /<NewSessionMenu/);
  assert.match(rowView, /<Ellipsis/);
  assert.match(rowView, /createDraft\(childProject\.id\)/);
  assert.match(rowView, /projectId: childProject\.id/);
  assert.match(rowView, /<WorkspaceRowActions/);
  // 根项目操作保持原样；工作区展开后也不能因为内部工作区行而消失。
  assert.match(projectTree, /<div className=\{cn\(dimmedActionsClass/);
  assert.doesNotMatch(projectTree, /\{\(!project\.worktreeEnabled \|\| collapsed\) && \(/);
  // 工作区标题按会话栏的方式通过右侧留白动画为 + / ⋯ 让位，而不是隐藏文字。
  assert.match(worktreeTree, /transition-\[padding-right\]/);
  assert.match(worktreeTree, /group-hover\/workspace-row:pr-\[52px\]/);
  assert.match(worktreeTree, /group-focus-within\/workspace-row:pr-\[52px\]/);
  assert.doesNotMatch(mainSection, /@max-\[255px\]/);
  assert.doesNotMatch(rowView, /@max-\[255px\]/);
});

test("workspace title more-actions keeps safe worktree removal in the menu", () => {
  assert.match(sidebarContent, /const menuProjectWorktreeParent = menuProject\?\.worktreeParentId/);
  assert.match(sidebarContent, /onRemoveWorktree=\{menuProjectWorktreeParent/);
  assert.match(sidebarComponents, /onRemoveWorktree\?: \(\) => void/);
  assert.match(sidebarComponents, /onRemoveWorktree \?\? props\.onRemoveProject/);
  assert.match(sidebarComponents, /t\("app\.worktreeRemoveConfirmTitle"\)/);
});

test("worktree rows never take a selected surface; only session leaves do", () => {
  // 对标 dsh-web：父工作区/分支是容器，选中灰底只给 SessionTree 叶子。
  assert.doesNotMatch(worktreeTree, /bg-accent\/60/);
  assert.doesNotMatch(worktreeTree, /isActive &&/);
  assert.doesNotMatch(worktreeTree, /currentProjectId/);
});

test("child worktree labels use a smaller hierarchy than their parent project", () => {
  const childRow = worktreeTree.slice(worktreeTree.indexOf("WorkspaceTreeRowView"));
  // 父项目和主工作区保持 text-body；只有其他 worktree 降为辅助导航字号。
  assert.match(childRow, /workspace-tree-select",[\s\S]{0,200}"text-control"/);
});

test("worktree auxiliary labels stay at the compact micro size", () => {
  // 这些是层级提示而非主要导航项；使用 caption 会随 medium 档位放大到 13px，
  // 导致“其他工作区”和“还有 N 个会话/查看更多子项”抢过会话行的视觉层级。
  assert.match(worktreeTree, /workspace-tree-section-header[^\n]*text-micro/);
  // 「查看更多 / 收起子项」按钮：紧凑 micro 行（布局类历史上有 min-w-0 w-auto flex-1 等前缀，
  // 断言只锁 text-micro 与紧凑起始段，不锁布局类顺序）
  assert.match(sessionTree, /className=\{`h-auto[^`]*?justify-start px-2 text-micro /);
  assert.match(sessionTree, /worktree-sessions-more/);
  assert.match(workspaceStyles, /\.session-more-row,[\s\S]*?font-size: var\(--font-size-micro\)/);
  assert.match(workspaceStyles, /\.worktree-sessions-more[\s\S]*?font-size: var\(--font-size-micro\)/);
});

test("child worktree labels keep a stable weight without a selected-state swap", () => {
  const childRow = worktreeTree.slice(worktreeTree.indexOf("WorkspaceTreeRowView"));
  // 父分支不再用字重冒充选中；标题始终 font-medium。
  assert.match(childRow, /className="min-w-0 flex-1 truncate font-medium"/);
  assert.doesNotMatch(childRow, /isActive \? "font-normal"/);
});

test("project row routes new-session into the more-actions menu", () => {
  // 新建会话/匿名从项目行的 + 下拉收敛进右侧「⋯」更多操作菜单（ProjectContextMenu），
  // 项目行不再单独渲染 NewSessionMenu，避免入口零散且视觉上与搜索/分段重复。
  assert.doesNotMatch(projectTree, /<NewSessionMenu/);
  assert.match(projectTree, /<Ellipsis/);
});

test("worktree removal keeps a fade-out animation (removingWorktreePaths -> worktree-removing)", () => {
  // 契约：删除 worktree 时先淡出再移除。removingWorktreePaths 必须沿
  // App → AppSidebar → SidebarContent → ProjectTree → WorktreeTree 透传，
  // 行在命中集合时挂 worktree-removing 类（foundation.css 提供淡出动画）。
  // 历史回归：removingWorktreePaths 曾只在 useWorktreeActions 里维护却从不传入 UI，
  // 导致行直接消失、动画永远不生效。
  assert.match(worktreeTree, /removingWorktreePaths\?: ReadonlySet<string>/);
  assert.match(worktreeTree, /removing=\{removingPaths\.has\(row\.key\)\}/);
  assert.match(worktreeTree, /props\.removing && "worktree-removing"/);
  assert.match(worktreeTree, /normalizeWorkspacePath/);
  assert.match(projectTree, /removingWorktreePaths\?: ReadonlySet<string>/);
  assert.match(projectTree, /removingWorktreePaths=\{props\.removingWorktreePaths\}/);
  assert.match(sidebarContent, /removingWorktreePaths=\{props\.removingWorktreePaths\}/);
  assert.match(
    workspaceStyles + readFileSync("src/renderer/src/styles/foundation.css", "utf8"),
    /\.workspace-tree-row\.worktree-removing\s*\{[\s\S]*?opacity: 0;/,
  );
});
