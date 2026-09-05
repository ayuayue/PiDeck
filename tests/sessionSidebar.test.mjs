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

function loadPillsModule() {
  return loadTsModule(
    "src/renderer/src/sessionFilterPills.ts",
    "sessionFilterPills.ts",
    (specifier) => {
      throw new Error(`Unexpected import: ${specifier}`);
    },
  );
}

function loadNavTabModule() {
  return loadTsModule(
    "src/renderer/src/utils/sidebarNavTab.ts",
    "sidebarNavTab.ts",
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
      if (specifier === "../utils/sidebarNavTab") return loadNavTabModule();
      if (specifier === "../sessionFilterPills") return loadPillsModule();
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

test("sidebar filter attributes DSH sessions by backend, not by their pi source", () => {
  const { filterSidebarSessions } = loadControllerModule();
  const sessions = [
    { id: "pi-1", source: "pi", backend: "pi" },
    { id: "dsh-1", source: "pi", backend: "dsh" },
  ];
  assert.equal(filterSidebarSessions(sessions, new Set(["pi"])).map((s) => s.id).join(","), "pi-1");
  assert.equal(filterSidebarSessions(sessions, new Set(["dsh"])).map((s) => s.id).join(","), "dsh-1");
  assert.equal(filterSidebarSessions(sessions, new Set(["pi", "dsh"])).length, 2);
});

test("legacy v1 filter storage migrates dsh in for projects that included pi", () => {
  const { readSidebarSourceFilters } = loadControllerModule();
  const saved = new Map();
  const storage = { getItem: (key) => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  // v1 格式：{ [projectId]: string[] | null }
  storage.setItem("pideck-session-source-filter", JSON.stringify({ project: ["pi", "codex"] }));
  assert.deepEqual([...readSidebarSourceFilters(storage).project].sort(), ["codex", "dsh", "pi"]);
  storage.setItem("pideck-session-source-filter", JSON.stringify({ project: ["codex"] }));
  assert.deepEqual([...readSidebarSourceFilters(storage).project], ["codex"]);
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

test("request gate rejects stale menu results after a newer request or close", () => {
  const { createSidebarRequestGate } = loadControllerModule();
  const gate = createSidebarRequestGate();
  const menuA = gate.beginMenu();
  const menuB = gate.beginMenu();
  assert.equal(gate.isCurrentMenu(menuA), false);
  assert.equal(gate.isCurrentMenu(menuB), true);
  gate.cancelMenu();
  assert.equal(gate.isCurrentMenu(menuB), false);
  // RPC 日志弹窗自持数据订阅（打开/关闭只切换 agentId），不再需要独立请求门
  assert.equal(typeof gate.beginRpcLogs, "undefined");
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
  assert.match(sessionTree, /onContextMenu=\{\(event\) => openDraftContext\(event, session\)\}/);
  assert.match(sessionTree, /<Button variant="ghost" size="icon"[\s\S]*className="draft-session-delete"/);
  assert.doesNotMatch(sessionTree, /<span className="project-action" role="button"/);
  assert.match(parts, /DraftSessionContextMenu/);
  assert.match(components, /export function DraftSessionContextMenu/);
  assert.match(content, /menu\?\.kind === "draft"/);
  assert.match(content, /onDeleteSession/);
  assert.match(content, /<DraftSessionContextMenu/);
  // draft 行布局改由 SessionTree Tailwind 承担（pure official P2-2）
  assert.match(sessionTree, /grid-cols-\[minmax\(0,1fr\)_2rem\]/);
  assert.match(styles, /\.draft-session-delete/);
});

test("session context menu exposes archive and restores refresh the manager project", () => {
  const components = readFileSync("src/renderer/src/components/sidebar/SidebarComponents.tsx", "utf8");
  const content = readFileSync("src/renderer/src/components/sidebar/SidebarContent.tsx", "utf8");
  const app = readFileSync("src/renderer/src/App.tsx", "utf8");

  assert.match(components, /onArchiveSession: \(\) => void/);
  assert.match(components, /onSelect=\{props\.onArchiveSession\}/);
  assert.match(content, /actions\.sessions\.archive\(menu\.projectId, menuSession\)/);
  assert.match(content, /actions\.sessions\.unarchive\(archived, managerProject\.id\)/);
  assert.match(app, /unarchiveSidebarSession\(archivedPath: string, projectId = activeProjectId\)/);
  assert.match(app, /unarchiveSidebarSession\(archived\.filePath, projectId\)/);
  assert.match(app, /archivedSessionToastMessage\(session\)/);
  assert.match(app, /ARCHIVED_SESSION_TOAST_MS/);
});

function appFunctionBlock(source, name, nextName) {
  const start = source.indexOf(`  async function ${name}(`);
  const end = source.indexOf(`  async function ${nextName}(`, start + 1);
  assert.notEqual(start, -1, `${name} implementation should be discoverable`);
  assert.notEqual(end, -1, `${nextName} boundary should be discoverable`);
  return source.slice(start, end);
}

// 侧栏归档/删除与历史抽屉同一契约：先关 Tab 再清状态，并带走子 agent 树。
// 只 removeSessionState(session.id) 会在 currentSessionId 被清空后留下空态 Composer。
test("sidebar archive and delete dismiss nested subagent chats instead of leaving a composer", () => {
  const app = readFileSync("src/renderer/src/App.tsx", "utf8");
  const chrome = readFileSync("src/renderer/src/hooks/useSessionWorkspaceChrome.ts", "utf8");
  const ipc = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");

  assert.match(chrome, /const closeTabs = useCallback\(\(sessionIds: string\[\]\)/);
  assert.match(chrome, /closeTab = useCallback\(\(sessionId: string\) => \{\s*closeTabs\(\[sessionId\]\)/);
  assert.match(app, /closeTabs: workspaceChrome\.closeTabs/);

  const remove = appFunctionBlock(app, "deleteSidebarSession", "archiveSidebarSession");
  const archive = appFunctionBlock(app, "archiveSidebarSession", "unarchiveSidebarSession");
  for (const [name, block] of [["delete", remove], ["archive", archive]]) {
    assert.match(block, /dismissSessionTree\(/, `${name} should dismiss the whole session tree`);
  }

  assert.match(ipc, /sessionsCatalogArchive[\s\S]*removeWithDescendants\(sessionId\)/);
  assert.match(ipc, /sessionsCatalogDelete[\s\S]*removeWithDescendants\(sessionId\)/);
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
  assert.match(sessionTree, /displayedSessionIds\.has\(session\.id\)/);
  assert.match(sessionTree, /collectDisplayedSessionIds/);
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
  assert.match(content, /RpcLogViewer/);
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
  const newSessionMenu = readFileSync("src/renderer/src/components/sidebar/NewSessionMenu.tsx", "utf8");
  const header = readFileSync("src/renderer/src/components/session/SessionHeader.tsx", "utf8");
  assert.doesNotMatch(projectTree, /sourceFilterOpenProjectId|session-source-filter-menu/);
  assert.match(projectTree, /sourceFilter !== null/);
  // 普通/匿名新建已合并到 NewSessionMenu 下拉按钮，匿名入口在其中保留
  assert.match(newSessionMenu, /createAnonymous\(projectId\)/);
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

  // 内置 Chat 没有可点击的父项目行，折叠入口必须外露为显式按钮（否则展开后无法从标题栏恢复）。
  assert.match(chatSection, /isProjectCollapsed\(project\.id\)/);
  assert.match(chatSection, /aria-expanded=\{!collapsed\}/);
  assert.match(chatSection, /onClick=\{\(\) => props\.controller\.toggleProject\(project\.id\)\}/);
  assert.match(chatSection, /title=\{collapsed \? t\("app\.projectExpand"\) : t\("app\.projectCollapse"\)\}/);
  assert.match(chatSection, /<ChevronsDownUp size=\{14\} aria-hidden="true" \/>/);
  // 显式「+ 新建会话」按钮外露（最常用入口），匿名会话收进 ⋯ 菜单
  assert.match(chatSection, /aria-label=\{t\("app\.newNormalSession"\)\}/);
  assert.match(chatSection, /void props\.actions\.sessions\.createDraft\(project\.id\)/);
  assert.match(chatSection, /createAnonymous\(project\.id\)/);
  assert.match(chatSection, /changeChatPath/);
  assert.match(chatSection, /t\("app\.chatProjectSettings"\)/);
  // 新建 DSH 会话入口已收敛到会话内的后端选择器，Chat 标题栏不再提供独立机器人按钮
  assert.doesNotMatch(chatSection, /createDraftDsh\(project\.id\)/);
  assert.doesNotMatch(chatSection, /t\("app\.projectNewDshAgent"\)/);
  assert.match(chatSection, /!collapsed && \([\s\S]*?<SessionTree/);
});

test("Projects section header provides batch collapse and refresh-all actions", () => {
  const projectTree = readFileSync("src/renderer/src/components/sidebar/ProjectTree.tsx", "utf8");
  const sidebarContent = readFileSync("src/renderer/src/components/sidebar/SidebarContent.tsx", "utf8");
  const app = readFileSync("src/renderer/src/App.tsx", "utf8");
  const controller = readFileSync("src/renderer/src/hooks/useSidebarController.ts", "utf8");

  // 标题栏全部折叠/展开按钮外露，调用 controller 的批量切换，并给出折叠/展开文案。
  assert.match(projectTree, /toggleCollapseAllProjects\(\)/);
  assert.match(projectTree, /anyWorkspaceExpanded/);
  assert.match(projectTree, /title=\{anyWorkspaceExpanded \? t\("app\.projectCollapseAll"\) : t\("app\.projectExpandAll"\)\}/);
  assert.match(projectTree, /<ChevronsDownUp size=\{14\} aria-hidden="true" \/>/);
  // 显式「+ 添加项目」按钮外露（最常用入口）
  assert.match(projectTree, /aria-label=\{t\("app\.addProject"\)\}/);
  assert.match(projectTree, /void props\.actions\.projects\.add\(\)/);
  // 目录存在性重扫是低频维护动作：放入 ⋯ 菜单，并经窄 action port 回到 App/hook。
  assert.match(projectTree, /<DropdownMenuItem onSelect=\{\(\) => void props\.actions\.projects\.refreshAll\(\)\}>/);
  assert.match(projectTree, /t\("app\.projectRefreshAll"\)/);
  assert.match(projectTree, /<RefreshCw className="size-3\.5" aria-hidden="true" \/>/);
  assert.match(sidebarContent, /refreshAll: \(\) => Promise<void>;/);
  assert.match(app, /refreshAll: refreshAllProjects/);
  // 搜索无结果/清单为空时仍保留刷新入口，不能因 workspaceProjects.length === 0 隐藏维护动作。
  const emptySection = projectTree.slice(projectTree.indexOf("{workspaceProjects.length === 0"));
  assert.match(emptySection, /props\.actions\.projects\.refreshAll\(\)/);
  // controller 批量切换只作用于根工作区项目（排除 chat 与 worktree 子项目）。
  assert.match(controller, /toggleCollapseAllProjects/);
  assert.match(controller, /project\.kind !== "chat" && !project\.worktreeParentId/);
});

test("narrow project tree keeps root names from losing avoidable width", () => {
  const projectTree = readFileSync("src/renderer/src/components/sidebar/ProjectTree.tsx", "utf8");

  // 工作区根节点需要保留折叠层级，但不应把标题栏和名称再向右推一档；
  // 展开后的 SessionTree 不在这里断言，避免改变会话层级的视觉语义。
  assert.match(projectTree, /treeRowClass =\n  "[^"]*items-center[^\"]*px-1 /);
  assert.match(projectTree, /className="flex min-w-0 flex-1 items-center gap-1 py-0 pr-1 text-left"/);
  // 无标题父块：工具行保持 px-1 pb-1 布局，不把名称向右推一档
  assert.match(projectTree, /className="flex items-center justify-between px-1 pb-1"/);
});

test("ProjectTree shows the project directory name like the dev reference", () => {
  const projectTree = readFileSync("src/renderer/src/components/sidebar/ProjectTree.tsx", "utf8");
  const rendererUtils = readFileSync("src/renderer/src/rendererUtils.ts", "utf8");
  // 显示名解析已收敛到 rendererUtils 单一来源（含重命名别名逻辑，见 projectDisplayName.test.mjs）；
  // ProjectTree 直接复用，保证侧栏/面包屑/搜索处处一致。
  assert.match(projectTree, /import \{ displayProjectDirectoryName, isChatProject \} from "\.\.\/\.\.\/rendererUtils"/);
  assert.match(projectTree, /const projectDirectoryName = displayProjectDirectoryName\(project\)/);
  assert.match(rendererUtils, /export function displayProjectDirectoryName\(project: Project\)/);
  assert.match(rendererUtils, /project\.path\.replace\(/);
  // 悬浮路径气泡已移除（仅能展示不能复制，且 bug 多）；项目行直接渲染目录名。
  assert.doesNotMatch(projectTree, /<PathTooltip/);
  assert.doesNotMatch(projectTree, /PathTooltip/);
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
  // 选中高亮只画在会话叶子上，不再把 selectedProjectId 传给工作区行。
  assert.doesNotMatch(content, /selectedProjectId/);


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

test("sidebar splits Chats/Projects by navTab without duplicating list logic", () => {
  const content = readFileSync("src/renderer/src/components/sidebar/SidebarContent.tsx", "utf8");
  const projectTree = readFileSync("src/renderer/src/components/sidebar/ProjectTree.tsx", "utf8");
  const controller = readFileSync("src/renderer/src/hooks/useSidebarController.ts", "utf8");

  // 分段切换入口：SidebarContent 的 Tabs 按 controller.navTab 驱动，值经 parseSidebarNavTab 收窄
  assert.match(content, /value=\{controller\.navTab\}/);
  assert.match(content, /parseSidebarNavTab\(value\)/);
  assert.match(content, /value="chats"/);
  assert.match(content, /value="projects"/);
  // ProjectTree 按 navTab 分流：active 渲染活动 Agent 页，chats 渲染 Chat 区，projects 渲染项目区
  assert.match(projectTree, /navTab === "active" \? \(\s*<ActiveSessionsTree/);
  assert.match(projectTree, /navTab === "chats" \? chatSection : projectsSection/);
  assert.match(projectTree, /const chatSection = chatProjects\.map/);
  assert.match(projectTree, /const projectsSection = \(/);
  // 两区都不复制列表逻辑：会话树/项目行只出现一份
  assert.match(projectTree, /renderProject/);
  // controller 暴露 navTab + setNavTab
  assert.match(controller, /navTab: SidebarNavTab;/);
  assert.match(controller, /setNavTab: \(tab: SidebarNavTab\) => void/);
});

test("expanded children can be collapsed back via sidebar controller", () => {
  const controller = readFileSync("src/renderer/src/hooks/useSidebarController.ts", "utf8");
  const sessionTree = readFileSync("src/renderer/src/components/sidebar/SessionTree.tsx", "utf8");
  const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
  const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

  // 收起 = 删除该项目的显式计数（回落到默认页大小），与 showMoreChildren 配对。
  assert.match(controller, /collapseChildren/);
  assert.match(controller, /delete next\[projectId\]/);
  // 展开过「查看更多」（存在显式计数）才显示收起入口，避免无谓的收起按钮。
  assert.match(controller, /hasExpandedChildren/);
  assert.match(controller, /visibleChildCountByProject\[projectId\] !== undefined/);
  // 还有隐藏项时也必须同时保留「查看更多」和「收起」，不能等到全部加载完才出现收起。
  assert.match(sessionTree, /const canCollapseChildren = props\.controller\.hasExpandedChildren\(props\.project\.id\)/);
  assert.match(sessionTree, /display\.hiddenChildCount > 0 \|\| canCollapseChildren/);
  assert.match(sessionTree, /const showMoreLabel = props\.nested[\s\S]*?app\.projectShowMoreChildren/);
  assert.match(sessionTree, /display\.hiddenChildCount > 0 && \([\s\S]*?onClick=\{props\.onShowMore/);
  assert.match(sessionTree, /canCollapseChildren && \([\s\S]*?collapseChildren\(props\.project\.id\)/);
  assert.match(sessionTree, /<ChevronUp size=\{12\}/);
  assert.match(sessionTree, /app\.projectCollapseChildren/);
  // 双语文案同步。
  assert.match(zh, /"app\.projectCollapseChildren": "收起"/);
  assert.match(en, /"app\.projectCollapseChildren": "Collapse"/);
});
