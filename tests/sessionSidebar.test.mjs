import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadTsModule(path, fileName, requireStub) {
  const output = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    JSON,
    Object,
    Set,
    Map,
    require: requireStub,
  }, { filename: fileName });
  return module.exports;
}

function loadExpandedProjectsModule() {
  return loadTsModule(
    "src/renderer/src/utils/sidebarExpandedProjects.ts",
    "sidebarExpandedProjects.ts",
    (specifier) => {
      throw new Error(`Unexpected import: ${specifier}`);
    },
  );
}

function loadControllerModule() {
  return loadTsModule(
    "src/renderer/src/hooks/useSidebarController.ts",
    "useSidebarController.ts",
    (specifier) => {
      if (specifier === "react") return {};
      if (specifier === "jotai") return {};
      if (specifier === "../atoms") return {};
      if (specifier === "../utils/sidebarExpandedProjects") return loadExpandedProjectsModule();
      throw new Error(`Unexpected import: ${specifier}`);
    },
  );
}

test("source filters preserve all sources until the user narrows a project", () => {
  const { filterSidebarSessions, serializeSidebarSourceFilters, readSidebarSourceFilters } = loadControllerModule();
  const sessions = [{ source: "pi" }, { source: "codex" }, { source: "claude" }];
  assert.equal(filterSidebarSessions(sessions, null).length, 3);
  assert.deepEqual(
    filterSidebarSessions(sessions, new Set(["codex"])),
    [{ source: "codex" }],
  );
  const saved = new Map();
  const storage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  storage.setItem("pideck-session-source-filter", serializeSidebarSourceFilters({ project: new Set(["pi", "codex"]) }));
  assert.deepEqual([...readSidebarSourceFilters(storage).project], ["pi", "codex"]);
});

test("Sidebar controller derives catalog data from canonical atoms without a writable SessionSummary cache", () => {
  const source = readFileSync("src/renderer/src/hooks/useSidebarController.ts", "utf8");
  assert.match(source, /useAtomValue\(sessionRecordsAtom\)/);
  assert.match(source, /useAtomValue\(sessionIdsByProjectAtom\)/);
  assert.match(source, /useAtomValue\(sidebarRuntimeAtom\)/);
  assert.doesNotMatch(source, /useState<[^>]*SessionSummary\[\]/);
});

test("Session tree keys use catalog SessionRecord identity, including child rows", () => {
  const source = readFileSync("src/renderer/src/components/sidebar/SessionTree.tsx", "utf8");
  assert.match(source, /key=\{session\.id\}/);
  assert.match(source, /key=\{child\.session\.id\}/);
  assert.doesNotMatch(source, /key=\{session\.filePath\}/);
  assert.doesNotMatch(source, /key=\{child\.session\.filePath\}/);
});

test("runtime context authorization uses the record binding instead of a same-path agent", () => {
  const { getBoundSidebarRuntimeAgent } = loadControllerModule();
  const catalog = {
    runtimeBySessionId: {
      "session-a": { agentId: "stale", status: "running" },
      "session-b": { agentId: "detached", status: "detached" },
      "session-c": { agentId: "live", status: "running" },
    },
    agents: [
      { id: "stale", status: "closed", sessionPath: "C:/same.jsonl" },
      { id: "same-path-but-unbound", status: "running", sessionPath: "C:/same.jsonl" },
      { id: "detached", status: "running", sessionPath: "C:/other.jsonl" },
      { id: "live", status: "running", sessionPath: "C:/live.jsonl" },
    ],
  };
  assert.equal(getBoundSidebarRuntimeAgent(catalog, "session-a"), undefined);
  assert.equal(getBoundSidebarRuntimeAgent(catalog, "session-b"), undefined);
  assert.equal(getBoundSidebarRuntimeAgent(catalog, "session-c").id, "live");
  const source = readFileSync("src/renderer/src/components/sidebar/SessionTree.tsx", "utf8");
  assert.match(source, /getBoundSidebarRuntimeAgent\(props\.controller\.catalog, session\.id\)/);
  assert.doesNotMatch(source, /getAgentForSessionPath/);
});

test("request gate rejects stale menu and RPC results after a newer request or close", () => {
  const { createSidebarRequestGate } = loadControllerModule();
  const gate = createSidebarRequestGate();
  const menuA = gate.beginMenu();
  const menuB = gate.beginMenu();
  assert.equal(gate.isCurrentMenu(menuA), false);
  assert.equal(gate.isCurrentMenu(menuB), true);
  gate.cancelMenu();
  assert.equal(gate.isCurrentMenu(menuB), false);
  const rpcA = gate.beginRpcLogs();
  const rpcB = gate.beginRpcLogs();
  assert.equal(gate.isCurrentRpcLogs(rpcA), false);
  assert.equal(gate.isCurrentRpcLogs(rpcB), true);
  gate.cancelRpcLogs();
  assert.equal(gate.isCurrentRpcLogs(rpcB), false);
});

test("unstarted drafts have an independent delete control and context menu", () => {
  const sessionTree = readFileSync("src/renderer/src/components/sidebar/SessionTree.tsx", "utf8");
  const content = readFileSync("src/renderer/src/components/sidebar/SidebarContent.tsx", "utf8");
  const controller = readFileSync("src/renderer/src/hooks/useSidebarController.ts", "utf8");
  const parts = readFileSync("src/renderer/src/components/sidebar/SidebarParts.tsx", "utf8");
  const components = readFileSync("src/renderer/src/components/sidebar/SidebarComponents.tsx", "utf8");
  const styles = readFileSync("src/renderer/src/styles/workspace.css", "utf8");

  assert.match(controller, /kind: "draft"/);
  assert.match(sessionTree, /const openDraftContext/);
  assert.match(sessionTree, /getBoundSidebarRuntimeAgent\(props\.controller\.catalog, session\.id\)/);
  assert.match(sessionTree, /kind: "agent",\s*agentId: runtimeAgent\.id/);
  assert.match(sessionTree, /draft-session-row/);
  assert.match(sessionTree, /has-runtime/);
  assert.match(sessionTree, /onContextMenu=\{\(event\) => openDraftContext\(event, session\)\}/);
  assert.match(sessionTree, /canDelete && \([\s\S]*<Button variant="ghost" size="icon"[\s\S]*className="draft-session-delete"/);
  assert.doesNotMatch(sessionTree, /<span className="project-action" role="button"/);
  assert.match(parts, /DraftSessionContextMenu/);
  assert.match(components, /export function DraftSessionContextMenu/);
  assert.match(content, /menu\?\.kind === "draft"/);
  assert.match(content, /!hasLiveSidebarRuntime\(menuDraftRuntime\)/);
  assert.match(content, /<DraftSessionContextMenu/);
  // draft 行布局改由 SessionTree Tailwind 承担（pure official P2-2）
  assert.match(sessionTree, /grid-cols-\[minmax\(0,1fr\)_2rem\]/);
  assert.match(sessionTree, /has-runtime/);
  assert.match(styles, /\.draft-session-delete/);
});

test("worktree rows expose their child project context menu and loading projects keep a surface", () => {
  const worktree = readFileSync("src/renderer/src/components/sidebar/WorktreeTree.tsx", "utf8");
  const sessionTree = readFileSync("src/renderer/src/components/sidebar/SessionTree.tsx", "utf8");
  const controller = readFileSync("src/renderer/src/hooks/useSidebarController.ts", "utf8");
  assert.match(worktree, /kind: "project",\s*projectId: childProject\.id/);
  assert.match(worktree, /className=\{cn\([\s\S]*worktree-workspace-header/);
  assert.match(worktree, /workspace-tree-row/);
  assert.match(worktree, /workspace-tree-expand/);
  assert.match(worktree, /workspace-tree-select/);
  assert.doesNotMatch(worktree, /toggleProjectExpanded/);
  assert.match(controller, /useAtomValue\(sessionCatalogLoadStateAtom\)/);
  assert.match(sessionTree, /catalogLoadStateByProject\[props\.project\.id\]\?\.status === "loading"/);
  assert.match(sessionTree, /catalogLoading \|\| draftSessions\.length/);
  assert.match(sessionTree, /project-session-loading/);
});

test("sidebar expansion migration waits for authoritative settings before pruning projects", () => {
  const controller = readFileSync("src/renderer/src/hooks/useSidebarController.ts", "utf8");
  assert.match(controller, /if \(projects\.length === 0 \|\| !options\.settingsLoaded\) return;/);
  assert.match(controller, /commitExpandedProjectIds\(pruned\)/);
});

test("Sidebar leaf remains independent from App and keeps RPC logging query local", () => {
  const controller = readFileSync("src/renderer/src/hooks/useSidebarController.ts", "utf8");
  const content = readFileSync("src/renderer/src/components/sidebar/SidebarContent.tsx", "utf8");
  assert.doesNotMatch(controller, /App\.tsx/);
  assert.doesNotMatch(content, /from "\.\.\/\.\.\/App"/);
  assert.match(controller, /getRpcLogging/);
  assert.match(controller, /setAgentRpcLoggingById/);
  assert.match(content, /RpcLogModal/);
  assert.match(content, /SessionManagerModal/);
  assert.match(content, /WorktreeCreateDialog/);
});

test("AppSidebar owns the controller while App keeps business actions as ports", () => {
  const app = readFileSync("src/renderer/src/App.tsx", "utf8");
  const root = readFileSync("src/renderer/src/components/sidebar/AppSidebar.tsx", "utf8");
  const controller = readFileSync("src/renderer/src/hooks/useSidebarController.ts", "utf8");
  const projectTree = readFileSync("src/renderer/src/components/sidebar/ProjectTree.tsx", "utf8");
  assert.doesNotMatch(app, /useSidebarController/);
  assert.match(root, /const controller = useSidebarController\(/);
  assert.match(root, /getRpcLogging: props\.actions\.rpc\.getLogging/);
  assert.match(root, /controller=\{controller\}/);
  assert.match(app, /const sidebarActions: SidebarActions/);
  assert.match(app, /useAtomValue\(sidebarExpandedProjectIdsAtom\)/);
  assert.match(controller, /useAtom\(sidebarExpandedProjectIdsAtom\)/);
  assert.match(projectTree, /if \(props\.controller\.search\.trim\(\)\) return;/);
});

test("sidebar uses the dev-style source filter overlay and anonymous Session entry", () => {
  const projectTree = readFileSync("src/renderer/src/components/sidebar/ProjectTree.tsx", "utf8");
  const sessionTree = readFileSync("src/renderer/src/components/sidebar/SessionTree.tsx", "utf8");
  const content = readFileSync("src/renderer/src/components/sidebar/SidebarContent.tsx", "utf8");
  const controller = readFileSync("src/renderer/src/hooks/useSidebarController.ts", "utf8");
  const header = readFileSync("src/renderer/src/components/session/SessionHeader.tsx", "utf8");
  assert.doesNotMatch(projectTree, /sourceFilterOpenProjectId|session-source-filter-menu/);
  assert.match(projectTree, /sourceFilter !== null/);
  assert.match(projectTree, /createAnonymous\(project\.id\)/);
  assert.match(content, /SessionSourceFilterMenu/);
  assert.match(controller, /toggleSourceFilter/);
  assert.match(sessionTree, /anonymous-indicator/);
  assert.match(sessionTree, /runtimeBySessionId\[session\.id\]\?\.agentId === child\.agent\.id/);
  assert.match(header, /anonymous-badge/);
});

test("Chat section keeps an independent collapse control after the parent project row is hidden", () => {
  const projectTree = readFileSync("src/renderer/src/components/sidebar/ProjectTree.tsx", "utf8");
  const chatSection = projectTree.slice(
    projectTree.indexOf("const chatProjects"),
    projectTree.indexOf("    {workspaceProjects.length > 0"),
  );

  // 内置 Chat 没有可点击的父项目行，标题自身必须成为唯一的折叠入口。
  assert.match(chatSection, /isProjectCollapsed\(project\.id\)/);
  assert.match(chatSection, /onClick=\{\(\) => props\.controller\.toggleProject\(project\.id\)\}/);
  assert.match(chatSection, /title=\{collapsed \? t\("app\.projectExpand"\) : t\("app\.projectCollapse"\)\}/);
  assert.match(chatSection, /<ChevronsDownUp size=\{14\} aria-hidden="true" \/>/);
  assert.match(chatSection, /!collapsed && \([\s\S]*?<SessionTree/);
});

test("ProjectTree shows the project directory name like the dev reference", () => {
  const projectTree = readFileSync("src/renderer/src/components/sidebar/ProjectTree.tsx", "utf8");
  assert.match(projectTree, /function displayProjectDirectoryName\(project: Project\)/);
  assert.match(projectTree, /project\.path\.replace\(/);
  assert.match(projectTree, /const projectDirectoryName = displayProjectDirectoryName\(project\)/);
  assert.match(projectTree, /<PathTooltip content=\{project\.path\}>/);
  assert.match(projectTree, /\{projectDirectoryName\}/);
  assert.match(projectTree, /const relatedProjects = controller\.catalog\.projects\.filter/);
  assert.match(projectTree, /const rootProjectSessions = props\.controller\.catalog\.sessionsByProject\[project\.id\]/);
  assert.doesNotMatch(projectTree, /project-running-badge|project-session-count/);
});

test("sidebar uses one persisted project accordion without duplicating current project details", () => {
  const content = readFileSync("src/renderer/src/components/sidebar/SidebarContent.tsx", "utf8");
  const projectTree = readFileSync("src/renderer/src/components/sidebar/ProjectTree.tsx", "utf8");
  const sessionTree = readFileSync("src/renderer/src/components/sidebar/SessionTree.tsx", "utf8");

  // SidebarContent owns one scroll surface only; every project and its content
  // are rendered together by ProjectTree instead of duplicating the selection below.
  assert.match(content, /conversation-list min-h-0 flex-1 overflow-x-hidden overflow-y-auto/);
  assert.match(content, /currentProjectId=\{currentRootProject\?\.id\}/);
  assert.doesNotMatch(content, /max-h-\[38%\]|<WorktreeTree|<SessionTree/);
  assert.match(content, /selectedProjectId=\{props\.currentProjectId\}/);

  // 项目主行与左侧箭头都可以展开/折叠；名称点击同时保持选择项目语义。
  assert.match(projectTree, /toggleProject\(project\.id\)/);
  assert.match(projectTree, /props\.actions\.projects\.select\(project\.id\)/);
  assert.doesNotMatch(projectTree, /setProjectExpanded\(project\.id, true\)/);
  assert.match(projectTree, /project\.worktreeEnabled[\s\S]*<WorktreeTree/);
  assert.match(projectTree, /<SessionTree/);
  assert.match(projectTree, /!collapsed && \(/);
  assert.doesNotMatch(projectTree, /grouped=|grouped\n/);

  // main 简单语义：项目下统一列表，不再拆“运行中/历史会话”分组标题；
  // Tab 栏同款状态点绑定具体 Agent/历史会话行，不显示项目级数量徽标。
  assert.doesNotMatch(sessionTree, /runningChildren|historyChildren|renderGroupLabel/);
  assert.doesNotMatch(sessionTree, /app\.sidebarActiveSessions/);
  assert.doesNotMatch(sessionTree, /app\.sidebarHistory/);
  // 易碎点：未启动的 catalog Agent/无 runtime 的会话行不得渲染状态点；
  // 已启动的会话行复用 Tab 栏蓝/黄/红状态点，而不是回退到项目头像。
  assert.doesNotMatch(sessionTree, /\?\? \"bg-muted-foreground\/50\"/);
  assert.doesNotMatch(sessionTree, /\?\? \"bg-border\"/);
  assert.match(sessionTree, /function renderRuntimeStatusDot/);
  assert.match(sessionTree, /if \(!dotClass\) return null/);
  assert.match(sessionTree, /sessionStatusDotClass\(status\)/);
  assert.match(sessionTree, /renderRuntimeStatusDot\(child\.agent\.status\)/);
  assert.match(sessionTree, /renderRuntimeStatusDot\(runtimeSnapshot\?\.status\)/);
  assert.match(sessionTree, /display\.visibleChildren\.map\(renderChild\)/);
  assert.match(sessionTree, /renderSubagents\(groupKey, child\.codexSubagents, child\.piSubagents\)/);
});
