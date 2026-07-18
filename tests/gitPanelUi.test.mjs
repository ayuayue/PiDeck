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
    assert.match(panel, /request === statusRequestRef\.current && projectId === props\.projectId/);
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
});
