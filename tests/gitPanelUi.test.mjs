import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

const panel = readFileSync("src/renderer/src/components/app/GitPanel.tsx", "utf8");
const resourceTree = readFileSync(
  "src/renderer/src/components/app/git/GitResourceTree.tsx",
  "utf8",
);
const graph = readFileSync(
  "src/renderer/src/components/app/git/GitGraph.tsx",
  "utf8",
);
const panelControls = readFileSync(
  "src/renderer/src/components/app/git/GitPanelControls.tsx",
  "utf8",
);
const gitSurface = [panel, resourceTree, graph, panelControls].join("\n");
const styles = readRendererStyles();
const i18n = [
  readFileSync("src/renderer/src/i18n.ts", "utf8"),
  readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8"),
  readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8"),
].join("\n");
const app = [
  readFileSync("src/renderer/src/hooks/useFileEditor.ts", "utf8"),
  readFileSync("src/renderer/src/App.tsx", "utf8"),
  readFileSync("src/renderer/src/components/app/AppShell.tsx", "utf8"),
  readFileSync("src/renderer/src/components/workspace/DrawerSurface.tsx", "utf8"),
].join("\n");
const preload = readFileSync("src/preload/index.ts", "utf8");
const main = readFileSync("src/main/index.ts", "utf8");
const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
const gitIpc = readFileSync("src/main/ipc/gitIpc.ts", "utf8");
const gitService = readFileSync("src/main/git/GitService.ts", "utf8");

function sourceBetween(startMarker, endMarker) {
  const start = gitSurface.indexOf(startMarker);
  const end = gitSurface.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `${startMarker} must exist`);
  assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
  return gitSurface.slice(start, end);
}

function cssRule(selector) {
  return styles.match(new RegExp(`${selector} \\{([^}]*)\\}`))?.[1] ?? "";
}

const gitKeys = [
  "git.sourceControl",
  "git.changes",
  "git.mergeChanges",
  "git.stagedChanges",
  "git.sourceControlGraph",
  "git.compareChanges",
  "git.commit",
  "git.resizePanes",
  "git.relativeSeconds",
  "git.loadingCommitDetails",
  "git.loadingCommitFiles",
  "git.renamedFrom",
];

describe("Git panel VS Code Source Control contract", () => {
  test("uses a CSS triangle twistie without structural icon imports", () => {
    const twistie = sourceBetween("function Twistie(", "function GitStageGlyph(");
    assert.match(twistie, /before:content-\['▶'\]/);
    assert.doesNotMatch(twistie, /\.git-twistie/);
assert.doesNotMatch(twistie, /ChevronDown|ChevronRight|GitBranch|GitCommit|GitCompare|GitGraph|Ellipsis|Minus|Plus/);
  });

  test("uses exactly three independently collapsible persisted panes with Changes open by default", () => {
    assert.match(panel, /type PaneId = "changes" \| "graph" \| "compare"/);
    assert.match(panel, /open: \{ changes: true, graph: false, compare: false \}/);
    assert.match(panel, /\[id\]: !current\.open\[id\]/);
    assert.doesNotMatch(panel, /id === "changes" \? true/);
    assert.match(panel, /pideck:git-panel:\$\{projectId\}:\$\{encodeURIComponent\(repoScopeKey\)\}:pane-state:\$\{suffix\}/);
    assert.match(panel, /id=\{`git-pane-\$\{paneIdPrefix\}-changes`\}/);
    assert.match(graph, /id=\{`git-pane-\$\{props\.paneIdPrefix\}-graph`\}/);
    assert.match(panel, /id=\{`git-pane-\$\{props\.paneIdPrefix\}-compare`\}/);
    assert.match(styles, /\.git-panel\s*\{[\s\S]*?overflow:\s*hidden/);
    assert.match(panel, /min-h-0 flex-1 overflow-x-hidden overflow-y-auto/);
  });

  test("provides visible-adjacent pointer and keyboard-accessible resize sashes", () => {
    assert.match(panel, /function PaneSash/);
    assert.match(panel, /role="separator"/);
    assert.match(panel, /aria-orientation="horizontal"/);
    assert.match(panel, /setPointerCapture/);
    assert.match(panel, /pointercancel/);
    assert.match(panel, /ArrowUp/);
    assert.match(panel, /ArrowDown/);
    assert.match(panel, /adjacentVisiblePane\(\s*visibleOpen,\s*"changes",\s*1,\s*\)/);
    assert.match(panel, /renderSash\(\s*"changes",\s*visibleSashAfterChanges\s*\)/);
    assert.match(panel, /renderSash\(\s*"graph",\s*visibleSashAfterGraph\s*\)/);
    assert.match(styles, /\.git-pane-sash\s*\{/);
    assert.match(styles, /cursor:\s*row-resize/);
  });

  test("keeps resource groups inside Changes and retains VS Code decorations", () => {
    // Changes 组始终显示全部变更（含已暂存），暂存后文件不会从 Changes 消失（VS Code 语义）
    assert.match(panel, /\.\.\.groups\.workingTree, \.\.\.groups\.untracked, \.\.\.groups\.index/);
    assert.match(panel, /groups\.merge\.length \+ stagedCount \+ workingChanges\.length/);
    assert.match(resourceTree, /function GitStageGlyph/);
    assert.match(resourceTree, /className=\{`size-6 rounded/);
    assert.match(resourceTree, /text-xl font-medium/);
    assert.match(resourceTree, /w-4 shrink-0/);
    assert.match(resourceTree, /ml-\[5px\]/);
    assert.match(resourceTree, /case GitStatus\.INDEX_ADDED:/);
    assert.match(resourceTree, /case GitStatus\.BOTH_MODIFIED:/);
    assert.doesNotMatch(gitSurface, /status === [0-9]/);
  });

  test("does not badge the source-control graph header with the loaded commit page size", () => {
    // 图默认一次只拉 30 条，徽章显示的是已加载条数而不是仓库提交总数，信息量低且容易误解。
    assert.doesNotMatch(graph, /count=\{commits\.length\}/);
    // 标题徽章改显示与当前过滤一致的仓库/分支提交总数。
    assert.match(graph, /count=\{totalCount\}/);
    assert.match(graph, /title=\{t\("git\.sourceControlGraph"\)\}/);
  });

  test("renders SVG graph lanes and does not retain the old fixed graph height", () => {
    assert.match(graph, /function GraphLanes/);
    assert.match(graph, /function buildGraphRows/);
    assert.match(graph, /<svg\s+className="block max-w-none/);
    assert.match(graph, /const GRAPH_ROW_HEIGHT = 28/);
    assert.match(graph, /lastNodeIndex\(\s*output,\s*commit\.parents\[parentIndex\],\s*\)/);
    assert.match(gitService, /"--topo-order"/);
    assert.doesNotMatch(graph, /graphPrefix/);
    assert.doesNotMatch(graph, /<pre className="git-commit-graph"/);
    assert.doesNotMatch(styles, /\.git-history-list\s*\{[^}]*max-height:\s*310px/);
  });

  test("localizes all Git drawer labels through i18n", () => {
    for (const key of gitKeys) {
      assert.match(i18n, new RegExp(`"${key}"`, "g"));
    }
    assert.match(panel, /from "\.\.\/\.\.\/i18n"/);
    assert.match(panel, /t\("git\.sourceControl"\)/);
    assert.match(panel, /t\("git\.compareChanges"\)/);
    assert.match(app, /t\("drawer\.sourceControl"\)/);
    assert.doesNotMatch(panel, />SOURCE CONTROL GRAPH</);
    assert.doesNotMatch(panel, />COMPARE CHANGES</);
  });

  test("prefers Electron system language data while preserving explicit locale choices", () => {
    assert.match(systemIpc, /app\.getPreferredSystemLanguages\(\)/);
    assert.match(preload, /preferredSystemLanguages/);
    assert.match(app, /api\.app\s*\.preferredSystemLanguages\(\)/);
    assert.match(i18n, /navigator\.languages\?\.\[0\]/);
    assert.match(i18n, /mode === "zh-CN" \|\| mode === "en-US" \|\| mode === "pseudo"/);
    assert.match(i18n, /normalized === "zh" \|\| normalized\.startsWith\("zh-"\)/);
  });

  test("aligns the commit-log IPC boundary with allBranches filtering", () => {
    assert.match(preload, /allBranches\?: boolean/);
    assert.match(gitIpc, /allBranches\?: boolean/);
    assert.match(graph, /allBranches:\s*!ref/);
    assert.doesNotMatch(graph, /setAllBranches/);
    assert.doesNotMatch(graph, /git-branch-filter-icon/);
  });

  test("guards async state and constrains visible pane heights", () => {
    assert.match(panel, /function fitPaneHeights/);
    assert.match(panel, /ResizeObserver/);
    assert.match(panel, /statusRequestRef/);
    assert.match(panel, /request === statusRequestRef\.current\s*&&\s*projectId === projectIdRef\.current/);
    assert.match(panel, /requestSequence/);
    assert.match(panel, /const PANE_MIN_BODY_HEIGHT = 24/);
    // 头部实际 h-8=32px；26px 旧预算会让折叠按钮被 overflow 裁切、视觉偏下
    assert.match(panel, /const PANE_HEADER_HEIGHT = 32/);
    assert.match(panel, /h-\[calc\(var\(--git-pane-height\)\+32px\)\]/);
    assert.match(panel, /h-\[32px\]/);
    assert.match(panel, /availableHeight - PANE_IDS\.length \* PANE_HEADER_HEIGHT/);
    assert.match(panel, /Math\.min\(\s*requestedBefore,\s*startBeforeHeight \+ startAfterHeight - PANE_MIN_BODY_HEIGHT,\s*\)/);
    assert.match(panel, /flushPendingHeights\(\)/);
    assert.match(panel, /const hasChangesToCommit\s*=\s*stagedCount > 0\s*\|\|\s*\(workingChanges\.length > 0/);
    assert.match(panel, /if \(stagedCount > 0\)[\s\S]*?runCommit\(false\)/);
    assert.match(panel, /smartCommitPreference\.enableSmartCommit[\s\S]*?runCommit\(true\)/);
    assert.match(panel, /setShowSmartCommitPrompt\(true\)/);
    assert.match(panel, /chooseSmartCommit\("yes"\)/);
    assert.match(panel, /chooseSmartCommit\("always"\)/);
    assert.match(panel, /chooseSmartCommit\("never"\)/);
    assert.match(panel, /await props\.stageFiles\(projectId, paths\)[\s\S]*?await props\.commit\(projectId, message\)/);
    assert.match(i18n, /"git\.smartCommitPrompt"/);
    assert.match(i18n, /"git\.smartCommitAlways"/);
    assert.match(i18n, /"git\.smartCommitNever"/);
    assert.match(graph, /min-w-\[48px\] flex-\[0_1_78px\]/);
    assert.doesNotMatch(graph, /git-history-date/);
    assert.doesNotMatch(graph, /selectedHash/);
    assert.doesNotMatch(graph, /git-commit-detail/);
    assert.match(styles, /grid-template-columns:\s*auto minmax\(0, 1fr\) auto/);
    assert.match(styles, /font-size:\s*var\(--font-size-body\)/);
    // Git 紧凑筛选下拉已迁移到 shadcn Select（#115 U5 交互原语统一）；手写定位契约只保留在 GitPanel 分支下拉。
    assert.match(panelControls, /value=\{toSelectValue\(props\.value\)\}/);
    assert.match(panelControls, /fromSelectValue\(next\)/);
    assert.doesNotMatch(panelControls, /className="fixed min-w-0 max-w-\[calc\(100vw-16px\)\]/);
    assert.doesNotMatch(panelControls, /menuRef\.current\?\.contains\(target\)/);
    assert.match(panel, /getViewportBoundMenuPlacement/);
    assert.match(panel, /const preferredWidth = Math\.max\(Math\.ceil\(rect\.width\),\s*160\)/);
    assert.match(panel, /\{\s*preferredWidth,\s*maxHeight:\s*300,\s*gap:\s*2\s*\}/);
    assert.doesNotMatch(panel, /preferredWidth:\s*240/);
    assert.doesNotMatch(panel, /git-branch-label[^"]*max-w-\[120px\]/);
    assert.match(panel, /git-branch-label min-w-0 flex-1 truncate/);
    assert.doesNotMatch(panel, /min-w-48 overflow-auto rounded-md border border-border bg-popover/);
    assert.match(panel, /branchDropdownRef\.current\?\.contains\(target\)/);
    assert.match(panelControls, /max-w-full min-w-0 gap-1 overflow-hidden/);
    assert.doesNotMatch(panelControls, /max-w-\[80px\]/);
    assert.match(panelControls, /SelectValue/);
    assert.match(panelControls, /position="popper"/);
    // 面板标题不截断，避免被右侧筛选挤成「源…」；且不用 mono，与 --git-ui-font / 项目中文栈对齐
    assert.match(panelControls, /whitespace-nowrap text-\[13px\] font-semibold/);
    assert.doesNotMatch(panelControls, /font-mono text-\[13px\] font-semibold/);
    assert.doesNotMatch(panelControls, /min-w-0 flex-1 truncate font-mono text-\[13px\] font-semibold/);
    // 路径 / 提交说明 / 作者 / 分支徽标走面板 UI 字体；仅 commit hash 保留 mono
    assert.doesNotMatch(resourceTree, /font-mono/);
    assert.doesNotMatch(panel, /font-mono/);
    assert.equal((graph.match(/font-mono/g) ?? []).length, 1);
    assert.match(graph, /font-mono text-xs text-\[var\(--git-desc-fg\)\]">\{commit\.hash\}/);
    assert.match(styles, /--git-ui-font:\s*var\(--font-family-base\)/);
    assert.match(cssRule("\\.git-commit-hover-avatar"), /font-family:\s*var\(--git-ui-font\)/);
  });

  test("runs silent refreshes without overlapping slow status requests", () => {
    assert.match(panel, /const statusRunningRequestRef = useRef<\{\s*projectId: string;\s*repoScopeKey: string;\s*request: number;\s*\} \| null>\(null\)/);
    assert.match(panel, /statusRunningRequestRef\.current\?\.projectId === props\.projectId/);
    assert.match(panel, /statusRunningRequestRef\.current = runningRequest/);
    assert.match(panel, /statusRunningRequestRef\.current = null/);
  });

  test("keeps mutation locked until IPC settles and times out the real git commands", () => {
    assert.doesNotMatch(panel, /mutationTimerRef/);
    assert.doesNotMatch(panel, /setTimeout\([\s\S]*?mutationRunningRef\.current = false/);
    assert.match(gitService, /const GIT_MUTATION_TIMEOUT_MS = 30_000;/);
    assert.ok(
      (gitService.match(/timeout(?:Ms)?: GIT_MUTATION_TIMEOUT_MS/g) ?? []).length >= 7,
      "all mutation and mutation-validation git commands should have a process timeout",
    );
  });

  test("shows details only after a short mouse hover and lazily expands files on click", () => {
    assert.match(graph, /function CommitHoverCard/);
    assert.match(graph, /createPortal\([\s\S]*?document\.body/);
    assert.match(graph, /const COMMIT_HOVER_OPEN_DELAY_MS = 500/);
    assert.match(graph, /window\.setTimeout\([\s\S]*?COMMIT_HOVER_OPEN_DELAY_MS/);
    assert.match(graph, /const COMMIT_HOVER_DISMISS_DELAY_MS = 400/);
    assert.match(graph, /window\.setTimeout\([\s\S]*?COMMIT_HOVER_DISMISS_DELAY_MS/);
    assert.match(graph, /onClick=\{\(\) => \{[\s\S]*?dismissHover\(\);[\s\S]*?toggleCommit\(commit\.hash\);/);
    assert.doesNotMatch(graph, /onFocus=\{\(event\) => scheduleHover/);
    assert.match(graph, /void loadCommitDetail\(commit\.hash\)/);
    assert.match(graph, /detailRequests\.current\.get\(hash\)/);
    assert.match(graph, /pointer-events-auto absolute z-\[1800\]/);
    assert.doesNotMatch(graph, /pointer-events-none absolute z-\[1800\]/);
    assert.match(graph, /role="dialog"/);
    assert.match(graph, /onMouseEnter=\{handleCardMouseEnter\}/);
    assert.match(graph, /onMouseLeave=\{handleCardMouseLeave\}/);
    assert.match(graph, /role="list"/);
    assert.match(graph, /role="listitem"/);
    assert.match(graph, /className=\{`git-history-row grid h-7/);
    assert.match(graph, /type="button"/);
    assert.match(graph, /aria-expanded=\{expanded\}/);
    assert.doesNotMatch(graph, /role="tree"/);
    assert.doesNotMatch(graph, /role="treeitem"/);
    assert.match(graph, /function CommitFileRow/);
    assert.match(graph, /function GraphContinuation/);
    assert.match(gitSurface, /getFileIconSeti\(name\)/);
    assert.doesNotMatch(graph, /title=\{`\$\{commit\.message\}/);
    assert.match(app, /gitApi:/);
    assert.match(app, /<GitDrawerHost/);
    assert.match(app, /gitApi=\{git\.gitApi\}/);
    assert.match(preload, /Promise<CommitDetail \| null>/);
    assert.match(graph, /\[--git-panel-bg:var\(--color-bg-panel\)\]/);
    assert.match(graph, /git-history-file-row grid min-h-\[26px\]/);
  });

  test("opens committed files as isolated read-only first-parent diffs", () => {
    assert.match(panel, /onOpenCommitFileDiff/);
    assert.match(graph, /aria-label=\{t\("git\.openFileDiff"/);
    assert.match(graph, /props\.onOpenCommitFileDiff\(commit, file\)/);
    assert.match(app, /api\.git\.commitFileDiff/);
    assert.match(app, /setGitDrawerDiff\(\{/);
    assert.match(app, /label: `\$\{diff\.path\.split[\s\S]*?\$\{commit\.shortHash\}/);
    assert.match(app, /WorkbenchContent/);
    assert.match(preload, /gitCommitFileDiff/);
    assert.match(gitIpc, /gitCommitFileDiff/);
    assert.match(gitService, /async getCommitFileDiff/);
    assert.match(gitService, /detail\.commit\.parents\[0\]/);
    assert.match(gitService, /4b825dc642cb6eb9a060e54bf8d69288fbee4904/);
    assert.match(gitService, /file\.originalPath \?\? file\.path/);
    assert.match(i18n, /"git\.openFileDiff"/);
    assert.match(graph, /focus-visible:shadow-\[inset_var\(--focus-ring\)\]/);
  });

  test("opens workspace resources into the middle workbench without drawer overlays", () => {
    assert.match(resourceTree, /focus-visible:shadow-\[inset_var\(--focus-ring\)\]/);
    // 未跟踪文件按实际状态传 untracked 组（否则服务端在 workingTree 组找不到而打不开）
    assert.match(resourceTree, /props\.groupType === "workingTree" && r\.status === GitStatus\.UNTRACKED/);
    assert.match(resourceTree, /"untracked"/);
    assert.match(panel, /groupType="merge"/);
    assert.match(panel, /groupType="index"/);
    assert.match(panel, /groupType="workingTree"/);
    assert.match(resourceTree, /groupType === "workingTree" \|\| props\.groupType === "untracked"/);
    assert.match(resourceTree, /kind: "stage"/);
    assert.match(app, /api\.git\.workspaceFileDiff/);
    assert.match(app, /setGitDrawerDiff\(\{[\s\S]*?projectId,[\s\S]*?filePath: diff\.path/);
    assert.match(app, /className="git-drawer-stack"/);
    assert.match(app, /className="git-drawer-source"/);
    assert.doesNotMatch(app, /className="git-drawer-detail"/);
    assert.match(app, /setGitDrawerDiff\(null\)/);
    assert.match(preload, /workspaceFileDiff:/);
    assert.match(gitIpc, /gitWorkspaceFileDiff/);
    assert.match(gitService, /async getWorkspaceFileDiff/);
    assert.match(gitService, /effectiveGroup === "untracked"/);
    assert.match(gitService, /effectiveGroup === "index"/);
    assert.match(gitService, /effectiveGroup === "workingTree"/);
    assert.match(resourceTree, /disabled:cursor-progress disabled:opacity-70/);
    assert.match(i18n, /"git\.openWorkspaceDiff"/);
  });

  test("hosts Git Diff in the middle workbench with split/maximize toggle", () => {
    assert.match(styles, /\.file-diff-viewer\s*\{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?width:\s*100%/);
    assert.match(app, /useState<WorkspaceContentOpenMode>/);
    assert.match(app, /const toggleGitDiffDisplayMode = useCallback/);
    assert.match(app, /setGitDiffDisplayMode\(\(mode\) => \(mode === "maximize" \? "split" : "maximize"\)\)/);
    const workbenchContent = readFileSync(
      "src/renderer/src/components/workspace/WorkbenchContent.tsx",
      "utf8",
    );
    assert.match(workbenchContent, /displayMode=\{props\.gitDiffDisplayMode\}/);
    assert.match(workbenchContent, /onToggleMode=\{props\.onToggleGitDiffMode\}/);
    assert.doesNotMatch(app, /gitDiffDisplayMode === "modal"/);
    assert.doesNotMatch(app, /gitDiffDisplayMode === "drawer"/);
  });

  test("keeps only the newest Git diff request and invalidates pending work on every close", () => {
    assert.match(app, /const gitDiffRequestSequenceRef = useRef\(0\)/);
    assert.match(app, /const request = \+\+gitDiffRequestSequenceRef\.current/g);
    assert.match(app, /request !== gitDiffRequestSequenceRef\.current/g);
    // 关闭 Git Diff 的 invalidate 逻辑已随重构收拢进 useFileEditor：
    // dismissGitDiffOnly（仅关 Diff 保留文件 tab）先递增 sequence 使在途请求失效，再清 drawer
    assert.match(app, /const dismissGitDiffOnly = useCallback\(\(\) => \{[\s\S]*?gitDiffRequestSequenceRef\.current \+= 1;[\s\S]*?setGitDrawerDiff\(null\)/);
    // Git 面板再次点击时优先关闭 diff 详情：该语义现收拢在共享的
    // handleToolDrawerAction 中（outline 与抽屉活动栏共用，见 workspaceDrawer 测试）。
    const toolDrawerAction = app.match(/handleToolDrawerAction = useCallback[\s\S]*?\},\s*\[[\s\S]*?workspace,[\s\S]*?gitDrawerDiff/)?.[0] ?? "";
    assert.match(toolDrawerAction, /if \(panel === "git" && gitDrawerDiff\) \{\s*closeGitDiff\(\);\s*return;/);
    // git 入口收进抽屉活动栏（rail，与 outline 一致走共享 handler，受同一开关门控）
    assert.match(app, /\.\.\.\(settings\.enableGitManagement && activeProjectId\s*\?\s*\[\s*\{[\s\S]*?id: "git"[\s\S]*?onClick: \(\) => handleToolDrawerAction\("git"\)/);
  });

  test("discard flows through literal-pathspec restore and trash for untracked files", () => {
    assert.match(preload, /discard: \(\s*projectId: string,\s*group: "workingTree" \| "untracked",\s*filePath: string,\s*repoPath\?: string,?\s*\)/);
    assert.match(gitIpc, /ipcChannels\.gitDiscard/);
    assert.match(gitService, /async discardFile/);
    assert.match(gitService, /"--literal-pathspecs", "add"/);
    assert.match(gitService, /"--literal-pathspecs", "restore", "--staged"/);
    assert.match(gitService, /"--literal-pathspecs", "restore", "--worktree"/);
    assert.match(gitService, /await unlink\(resource\.path\)/);
    // 回滚是行内 hover 按钮（label 用 discardChanges，避开 dev-divergent 的 discard label）
    assert.doesNotMatch(resourceTree, /label: t\("git\.discard"\)/);
    assert.match(resourceTree, /label: t\("git\.discardChanges"\)/);
    assert.match(resourceTree, /kind: "discard"/);
    // Changes 组始终显示全部变更（含已暂存），已暂存文件不再出现 stage/rollback 按钮
    assert.match(panel, /\.\.\.groups\.workingTree, \.\.\.groups\.untracked, \.\.\.groups\.index/);
    assert.match(resourceTree, /props\.stagedPaths\?\.has\(r\.path\)/);
    assert.match(panel, /from "\.\/git\/GitResourceTree"/);
    assert.match(panel, /<ConfirmDialog/);
    assert.match(i18n, /"git\.discardConfirmMessage"/);
    assert.match(i18n, /"git\.discardUntrackedConfirmMessage"/);
  });
  test("provides a right-click paste menu on the commit input", () => {
    // textarea 外包 ContextMenu，单一“粘贴”项走 i18n
    assert.match(panel, /<ContextMenu>/);
    assert.match(panel, /<ContextMenuTrigger asChild>/);
    assert.match(panel, /t\("common\.paste"\)/);
    assert.match(panel, /pasteCommitClipboard/);
    // 粘贴：有 HTML 时先转纯文本（textarea 只能纯文本），无 HTML 降级纯文本
    assert.match(panel, /htmlToPlainText\(html\)/);
    assert.doesNotMatch(panel, /pasteAsPlainText|pasteAsIs/);
    // 剪贴板读取走 preload 同步 API，不依赖 document focus
    assert.match(preload, /clipboard: \{[\s\S]*?readText: \(\) => clipboardSync\(ipcChannels\.clipboardReadText, ""\)/);
    assert.match(preload, /readHtml: \(\) => clipboardSync\(ipcChannels\.clipboardReadHtml, ""\)/);
    assert.match(i18n, /"common\.paste"/);
    assert.doesNotMatch(i18n, /"common\.pasteAsPlainText"|"common\.pasteAsIs"/);
  });

  test("bounds Git diff memory and validates renderer-controlled Git inputs", () => {
    assert.match(gitService, /commitDetailCacheLimit = 16/);
    assert.match(gitService, /commitDetailCacheByteLimit = 2 \* 1024 \* 1024/);
    assert.match(gitService, /maxBuffer:\s*limit \+ 1/);
    assert.match(gitService, /Buffer\.byteLength\(stdout, "utf8"\) > limit/);
    assert.match(gitService, /metadata\.size > limit/);
    assert.match(gitService, /stdout\.includes\("\\0"\)/);
    assert.match(gitService, /resolveCommitHash/);
    assert.match(gitService, /--end-of-options/);
    assert.match(gitService, /Math\.min\(500/);
    assert.match(gitService, /resolveMutationPaths/);
    assert.match(gitService, /"--porcelain", "-z", "--untracked-files=all", "--", "\."/);
  });

  test("loads commit files against the first parent and preserves rename origins", () => {
    assert.match(gitService, /commit\.parents\[0\]/);
    assert.match(gitService, /\["diff", "--name-status", "-z", "--find-renames", commit\.parents\[0\], commit\.hash\]/);
    assert.match(gitService, /\["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-z", "--find-renames", commit\.hash\]/);
    assert.match(gitService, /originalPath:\s*originalOrCurrentPath/);
    assert.match(gitService, /fullMessage:\s*message/);
    assert.match(i18n, /"git\.loadingCommitDetails"/);
    assert.match(i18n, /"git\.loadingCommitFiles"/);
    assert.match(i18n, /"git\.renamedFrom"/);
  });
});
