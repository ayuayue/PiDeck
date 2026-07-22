import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const panel = readFileSync("src/renderer/src/components/app/GitPanel.tsx", "utf8");
const styles = readFileSync("src/renderer/src/styles.css", "utf8");
const i18n = readFileSync("src/renderer/src/i18n.ts", "utf8");
const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");
const main = readFileSync("src/main/index.ts", "utf8");
const gitService = readFileSync("src/main/git/GitService.ts", "utf8");

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
    assert.match(panel, /function Twistie/);
    assert.match(styles, /\.git-twistie::before\s*\{\s*content:\s*"\\25B6"/);
    assert.doesNotMatch(panel, /ChevronDown|ChevronRight|GitBranch|GitCommit|GitCompare|GitGraph|Ellipsis|Minus|Plus/);
  });

  test("uses exactly three independently collapsible persisted panes with Changes open by default", () => {
    assert.match(panel, /type PaneId = "changes" \| "graph" \| "compare"/);
    assert.match(panel, /open: \{ changes: true, graph: false, compare: false \}/);
    assert.match(panel, /\[id\]: !current\.open\[id\]/);
    assert.doesNotMatch(panel, /id === "changes" \? true/);
    assert.match(panel, /pideck:git-panel:\$\{projectId\}:pane-state:v2/);
    assert.match(panel, /id="git-pane-changes"/);
    assert.match(panel, /id="git-pane-graph"/);
    assert.match(panel, /id="git-pane-compare"/);
    assert.match(styles, /\.git-panel\s*\{[\s\S]*?overflow:\s*hidden/);
    assert.match(styles, /\.git-pane-body\s*\{[\s\S]*?overflow:\s*auto/);
  });

  test("provides visible-adjacent pointer and keyboard-accessible resize sashes", () => {
    assert.match(panel, /function PaneSash/);
    assert.match(panel, /role="separator"/);
    assert.match(panel, /aria-orientation="horizontal"/);
    assert.match(panel, /setPointerCapture/);
    assert.match(panel, /pointercancel/);
    assert.match(panel, /ArrowUp/);
    assert.match(panel, /ArrowDown/);
    assert.match(panel, /adjacentVisiblePane\(paneState\.open, "changes", 1\)/);
    assert.match(panel, /renderSash\("changes", visibleSashAfterChanges\)/);
    assert.match(panel, /renderSash\("graph", visibleSashAfterGraph\)/);
    assert.match(styles, /\.git-pane-sash\s*\{/);
    assert.match(styles, /cursor:\s*row-resize/);
  });

  test("keeps resource groups inside Changes and retains VS Code decorations", () => {
    assert.match(panel, /\[\.\.\.groups\.workingTree, \.\.\.groups\.untracked\]/);
    assert.match(panel, /groups\.merge\.length \+ stagedCount \+ workingChanges\.length/);
    assert.match(panel, /function GitStageGlyph/);
    assert.match(panel, /git-stage-action/);
    assert.match(styles, /\.git-stage-glyph\s*\{[\s\S]*?font-size:\s*20px/);
    assert.match(styles, /\.git-stage-action\s*\{\s*width:\s*26px;\s*height:\s*24px/);
    assert.match(styles, /\.git-decoration\s*\{[\s\S]*?width:\s*16px/);
    assert.match(styles, /margin-left:\s*5px/);
    assert.match(panel, /case GitStatus\.INDEX_ADDED:/);
    assert.match(panel, /case GitStatus\.BOTH_MODIFIED:/);
    assert.doesNotMatch(panel, /status === [0-9]/);
  });

  test("renders SVG graph lanes and does not retain the old fixed graph height", () => {
    assert.match(panel, /function GraphLanes/);
    assert.match(panel, /function buildGraphRows/);
    assert.match(panel, /<svg className="git-graph-svg"/);
    assert.match(panel, /const GRAPH_ROW_HEIGHT = 28/);
    assert.match(panel, /lastNodeIndex\(output, commit\.parents\[parentIndex\]\)/);
    assert.match(gitService, /"--topo-order"/);
    assert.doesNotMatch(panel, /graphPrefix/);
    assert.doesNotMatch(panel, /<pre className="git-commit-graph"/);
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
    assert.match(main, /app\.getPreferredSystemLanguages\(\)/);
    assert.match(preload, /preferredSystemLanguages/);
    assert.match(app, /api\.app\s*\.preferredSystemLanguages\(\)/);
    assert.match(i18n, /navigator\.languages\?\.\[0\]/);
    assert.match(i18n, /mode === "zh-CN" \|\| mode === "en-US" \|\| mode === "pseudo"/);
    assert.match(i18n, /normalized === "zh" \|\| normalized\.startsWith\("zh-"\)/);
  });

  test("aligns the commit-log IPC boundary with allBranches filtering", () => {
    assert.match(preload, /allBranches\?: boolean/);
    assert.match(main, /allBranches\?: boolean/);
    assert.match(panel, /allBranches:\s*!ref/);
    assert.doesNotMatch(panel, /setAllBranches/);
    assert.doesNotMatch(panel, /git-branch-filter-icon/);
  });

  test("guards async state and constrains visible pane heights", () => {
    assert.match(panel, /function fitPaneHeights/);
    assert.match(panel, /ResizeObserver/);
    assert.match(panel, /statusRequestRef/);
    assert.match(panel, /request === statusRequestRef\.current && projectId === projectIdRef\.current/);
    assert.match(panel, /requestSequence/);
    assert.match(panel, /const PANE_MIN_BODY_HEIGHT = 24/);
    assert.match(panel, /availableHeight - PANE_IDS\.length \* PANE_HEADER_HEIGHT/);
    assert.match(panel, /Math\.min\(requestedBefore, startBeforeHeight \+ startAfterHeight - PANE_MIN_BODY_HEIGHT\)/);
    assert.match(panel, /flushPendingHeights\(\)/);
    assert.match(panel, /const hasChangesToCommit = stagedCount > 0 \|\| \(workingChanges\.length > 0/);
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
    assert.match(panel, /git-history-author/);
    assert.doesNotMatch(panel, /git-history-date/);
    assert.doesNotMatch(panel, /selectedHash/);
    assert.doesNotMatch(panel, /git-commit-detail/);
    assert.match(styles, /grid-template-columns:\s*auto minmax\(0, 1fr\) auto/);
    assert.match(styles, /font-size:\s*var\(--font-size-body\)/);
    assert.match(styles, /\.git-pane-header \.git-compact-select\s*\{[\s\S]*?width:\s*160px/);
    assert.match(styles, /min-width:\s*120px/);
  });

  test("runs silent refreshes without overlapping slow status requests", () => {
    assert.match(panel, /const statusRunningRequestRef = useRef<\{ projectId: string; request: number \} \| null>\(null\)/);
    assert.match(panel, /statusRunningRequestRef\.current\?\.projectId === props\.projectId/);
    assert.match(panel, /statusRunningRequestRef\.current = runningRequest/);
    assert.match(panel, /statusRunningRequestRef\.current = null/);
  });

  test("keeps mutation locked until IPC settles and times out the real git commands", () => {
    assert.doesNotMatch(panel, /mutationTimerRef/);
    assert.doesNotMatch(panel, /setTimeout\([\s\S]*?mutationRunningRef\.current = false/);
    assert.match(gitService, /const GIT_MUTATION_TIMEOUT_MS = 30_000;/);
    assert.ok(
      (gitService.match(/timeout: GIT_MUTATION_TIMEOUT_MS/g) ?? []).length >= 7,
      "all mutation and mutation-validation git commands should have a process timeout",
    );
  });

  test("shows details only after a short mouse hover and lazily expands files on click", () => {
    assert.match(panel, /function CommitHoverCard/);
    assert.match(panel, /createPortal\([\s\S]*?document\.body/);
    assert.match(panel, /const COMMIT_HOVER_OPEN_DELAY_MS = 500/);
    assert.match(panel, /window\.setTimeout\([\s\S]*?COMMIT_HOVER_OPEN_DELAY_MS/);
    assert.match(panel, /const COMMIT_HOVER_DISMISS_DELAY_MS = 400/);
    assert.match(panel, /window\.setTimeout\([\s\S]*?COMMIT_HOVER_DISMISS_DELAY_MS/);
    assert.match(panel, /onClick=\{\(\) => \{[\s\S]*?dismissHover\(\);[\s\S]*?toggleCommit\(commit\.hash\);/);
    assert.doesNotMatch(panel, /onFocus=\{\(event\) => scheduleHover/);
    assert.match(panel, /void loadCommitDetail\(commit\.hash\)/);
    assert.match(panel, /detailRequests\.current\.get\(hash\)/);
    assert.match(styles, /\.git-commit-hover\s*\{[\s\S]*?pointer-events:\s*auto/);
    assert.match(panel, /onMouseEnter=\{handleCardMouseEnter\}/);
    assert.match(panel, /onMouseLeave=\{handleCardMouseLeave\}/);
    assert.match(panel, /role="list"/);
    assert.match(panel, /role="listitem"/);
    assert.match(panel, /className=\{`git-history-row/);
    assert.match(panel, /type="button"/);
    assert.match(panel, /aria-expanded=\{expanded\}/);
    assert.doesNotMatch(panel, /role="tree"/);
    assert.doesNotMatch(panel, /role="treeitem"/);
    assert.match(panel, /function CommitFileRow/);
    assert.match(panel, /function GraphContinuation/);
    assert.match(panel, /getFileIconSeti\(name\)/);
    assert.doesNotMatch(panel, /title=\{`\$\{commit\.message\}/);
    assert.match(app, /commitDetail=\{api\.git\.commitDetail\}/);
    assert.match(preload, /Promise<CommitDetail \| null>/);
    assert.match(styles, /\.git-commit-hover\s*\{/);
    assert.match(styles, /\.git-history-file-row/);
  });

  test("opens committed files as isolated read-only first-parent diffs", () => {
    assert.match(panel, /onOpenCommitFileDiff/);
    assert.match(panel, /aria-label=\{t\("git\.openFileDiff"/);
    assert.match(panel, /props\.onOpenCommitFileDiff\(commit, file\)/);
    assert.match(app, /api\.git\.commitFileDiff/);
    assert.match(app, /setGitDrawerDiff\(\{/);
    assert.match(app, /label: `\$\{diff\.path\.split[\s\S]*?\$\{commit\.shortHash\}/);
    assert.match(app, /<FileDiffViewer[\s\S]*?displayMode="drawer"[\s\S]*?gitDrawerDiff\.originalContent/);
    assert.match(preload, /gitCommitFileDiff/);
    assert.match(main, /gitCommitFileDiff/);
    assert.match(gitService, /async getCommitFileDiff/);
    assert.match(gitService, /detail\.commit\.parents\[0\]/);
    assert.match(gitService, /4b825dc642cb6eb9a060e54bf8d69288fbee4904/);
    assert.match(gitService, /file\.originalPath \?\? file\.path/);
    assert.match(i18n, /"git\.openFileDiff"/);
    assert.match(styles, /\.git-history-file-row:focus-visible/);
  });

  test("opens workspace resources lazily without replacing the Git drawer", () => {
    assert.match(panel, /className="git-resource-open"/);
    assert.match(panel, /onOpenWorkspaceFileDiff\("merge", resource\.path\)/);
    assert.match(panel, /onOpenWorkspaceFileDiff\("index", resource\.path\)/);
    assert.match(panel, /resource\.status === GitStatus\.UNTRACKED \? "untracked" : "workingTree"/);
    assert.match(panel, /actions=\{\[\{ kind: "stage", label: t\("git\.stage"\)/);
    assert.match(app, /api\.git\.workspaceFileDiff/);
    assert.match(app, /setGitDrawerDiff\(\{[\s\S]*?projectId,[\s\S]*?filePath: diff\.path/);
    assert.match(app, /className="git-drawer-stack"/);
    assert.match(app, /className="git-drawer-source"/);
    assert.match(app, /className="git-drawer-detail"/);
    assert.match(app, /setGitDrawerDiff\(null\)/);
    const commitOpen = app.match(/async function openCommitFileDiff[\s\S]*?async function refreshSessionHistory/)?.[0] ?? "";
    assert.doesNotMatch(commitOpen, /setDrawer\(null\)/);
    assert.match(preload, /workspaceFileDiff:/);
    assert.match(main, /gitWorkspaceFileDiff/);
    assert.match(gitService, /async getWorkspaceFileDiff/);
    assert.match(gitService, /group === "untracked"/);
    assert.match(gitService, /group === "index"/);
    assert.match(gitService, /group === "workingTree"/);
    assert.match(styles, /\.git-resource-open:focus-visible/);
    assert.match(i18n, /"git\.openWorkspaceDiff"/);
  });

  test("fills the Git detail drawer and reuses FileDiffViewer for real modal expansion", () => {
    assert.match(styles, /\.file-diff-viewer\s*\{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?width:\s*100%/);
    assert.match(styles, /\.git-drawer-detail > \.file-diff-viewer\s*\{[\s\S]*?flex:\s*1 1 100%;[\s\S]*?width:\s*100%/);
    assert.match(app, /const \[gitDiffDisplayMode, setGitDiffDisplayMode\] = useState<"modal" \| "drawer">\("drawer"\)/);
    assert.match(app, /const toggleGitDiffDisplayMode = useCallback/);
    assert.match(app, /setDrawer\("git"\);[\s\S]*?setDrawerCollapsed\(false\);[\s\S]*?setGitDiffDisplayMode\("drawer"\)/);
    assert.match(app, /editorMode === "modal" && activeTab && gitDiffDisplayMode !== "modal"/);
    assert.match(app, /gitDiffDisplayMode === "drawer"[\s\S]*?<FileDiffViewer[\s\S]*?displayMode="drawer"[\s\S]*?onToggleMode=\{toggleGitDiffDisplayMode\}/);
    assert.match(app, /gitDiffDisplayMode === "modal"[\s\S]*?<FileDiffViewer[\s\S]*?displayMode="modal"[\s\S]*?onToggleMode=\{toggleGitDiffDisplayMode\}/);
  });

  test("keeps only the newest Git diff request and invalidates pending work on every close", () => {
    assert.match(app, /const gitDiffRequestSequenceRef = useRef\(0\)/);
    assert.match(app, /const request = \+\+gitDiffRequestSequenceRef\.current/g);
    assert.match(app, /request !== gitDiffRequestSequenceRef\.current/g);
    assert.match(app, /const closeGitDiff = useCallback\(\(\) => \{[\s\S]*?gitDiffRequestSequenceRef\.current \+= 1;[\s\S]*?setGitDrawerDiff\(null\)/);
    const gitAction = app.match(/gitAction=\{[\s\S]*?\} : undefined\}/)?.[0] ?? "";
    assert.match(gitAction, /if \(gitDrawerDiff\) \{\s*closeGitDiff\(\);\s*return;/);
  });

  test("wires single-file discard through the narrow IPC boundary", () => {
    assert.match(preload, /discard: \(projectId: string, group: "workingTree" \| "untracked", filePath: string\)/);
    assert.match(main, /ipcChannels\.gitDiscard/);
    assert.match(gitService, /async discardFile/);
    assert.match(gitService, /"--literal-pathspecs", "add"/);
    assert.match(gitService, /"--literal-pathspecs", "restore", "--staged"/);
    assert.match(gitService, /"--literal-pathspecs", "restore", "--worktree"/);
    assert.match(gitService, /await unlink\(resource\.path\)/);
    assert.match(panel, /kind: "discard"/);
    assert.match(panel, /<ConfirmDialog/);
    assert.match(i18n, /"git\.discardConfirmMessage"/);
    assert.match(i18n, /"git\.discardUntrackedConfirmMessage"/);
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
