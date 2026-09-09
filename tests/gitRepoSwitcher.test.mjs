import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const host = readFileSync("src/renderer/src/components/workspace/GitDrawerHost.tsx", "utf8");
const scope = readFileSync("src/renderer/src/hooks/useGitRepoScope.ts", "utf8");
const drawer = readFileSync("src/renderer/src/components/workspace/DrawerSurface.tsx", "utf8");
const ipc = readFileSync("src/shared/ipc.ts", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");
const gitIpc = readFileSync("src/main/ipc/gitIpc.ts", "utf8");
const panel = readFileSync("src/renderer/src/components/app/GitPanel.tsx", "utf8");
const graph = readFileSync("src/renderer/src/components/app/git/GitGraph.tsx", "utf8");
const resourceTree = readFileSync("src/renderer/src/components/app/git/GitResourceTree.tsx", "utf8");
const gitService = readFileSync("src/main/git/GitService.ts", "utf8");

// 文件名保留，确保从旧切换器实现迁移时仍会运行这组多仓契约测试。
test("Git drawer renders every discovered repository instead of selecting one active repository", () => {
  assert.match(drawer, /<GitDrawerHost/);
  assert.doesNotMatch(drawer, /<GitPanel/);
  assert.match(host, /useGitRepoScope/);
  assert.match(host, /scope\.repos\.map\(\(repo\)/);
  assert.match(host, /repositoryLabel=\{repositoryLabel\}/);
  assert.doesNotMatch(host, /GitRepoSwitcher/);
  assert.doesNotMatch(host, /activeRepo/);
});

test("repo discovery no longer persists or exposes a selected repository", () => {
  assert.match(scope, /hasMultipleRepos: repos\.length > 1/);
  assert.doesNotMatch(scope, /active-repo/);
  assert.doesNotMatch(scope, /selectRepo/);
  assert.doesNotMatch(scope, /localStorage/);
});

test("each repository panel keeps its Git operations and branch state bound to its own path", () => {
  assert.match(host, /function createScopedGitApi/);
  assert.match(host, /gitApi\.status\(id, repoPath\)/);
  assert.match(host, /gitInfoByRepoPath/);
  assert.match(host, /gitApi\s*\.checkout\(projectId, branch, repoPath\)/);
  assert.match(host, /repoScopeKey=\{repoPath \?\? projectRoot\}/);
  assert.match(host, /onOpenWorkspaceFileDiff\(group, path, repoPath\)/);
  assert.match(host, /onOpenCommitFileDiff\(commit, file, repoPath\)/);
});

test("multi-repository panes share one Graph/Compare and only stack change lists", () => {
  assert.match(host, /renderPanel\(repo, repoLabel\(repo\), "changesOnly"\)/);
  assert.match(host, /renderPanel\(historyRepo, undefined, "historyOnly"\)/);
  assert.match(host, /selectHistoryRepo/);
  assert.match(host, /historyRepoOptions/);
  assert.doesNotMatch(host, /h-\[420px\] min-h-\[320px\]/);
  assert.doesNotMatch(host, /basis-\[42%\]/);
  assert.match(panel, /layout\?: "full" \| "changesOnly" \| "historyOnly"/);
  assert.match(panel, /layout !== "changesOnly" && <SourceControlGraph/);
  assert.match(panel, /layout !== "changesOnly" && <CompareChanges/);
  assert.match(panel, /historyRepoOptions=\{props\.historyRepoOptions\}/);
  assert.match(panel, /variant="ghost"/);
  assert.match(panel, /max-w-\[26%\]/);
  assert.match(panel, /layout === "changesOnly" \|\| paneState\.open\.changes/);
  assert.match(panel, /layout !== "changesOnly" && \(/);
  assert.match(graph, /historyRepoOptions/);
});

test("multi-repository panes have isolated persisted state and unique pane ids", () => {
  assert.match(panel, /pane-state:\$\{suffix\}/);
  assert.match(panel, /const paneIdPrefix = useId\(\)/);
  assert.match(panel, /id=\{`git-pane-\$\{paneIdPrefix\}-changes`\}/);
  assert.match(panel, /paneIdPrefix=\{paneIdPrefix\}/);
  assert.match(graph, /paneIdPrefix: string/);
  assert.match(graph, /id=\{`git-pane-\$\{props\.paneIdPrefix\}-graph`\}/);
});

test("directory actions stage and discard only their grouped resource paths", () => {
  assert.match(resourceTree, /stageDir\?: \(paths: string\[\]\) => void/);
  assert.match(resourceTree, /discardDir\?: \(resources: Array/);
  assert.match(resourceTree, /props\.stageDir\?\.\(stageable\.map/);
  assert.match(resourceTree, /props\.discardDir\?\.\(discardable, dir \|\| "\/"\)/);
  assert.match(panel, /setDirectoryDiscardTarget\(\{ resources, label \}\)/);
  assert.match(panel, /props\.discardFiles\(props\.projectId, target\.resources\)/);
  assert.match(ipc, /gitDiscardFiles: "git:discard-files"/);
  assert.match(preload, /discardFiles: \(projectId: string, resources: GitDiscardResource\[\]/);
  assert.match(gitIpc, /ipcChannels\.gitDiscardFiles/);
  assert.match(gitService, /async discardFiles\(cwd: string, resources:/);
  assert.match(gitService, /"git:discard-files"/);
});

test("git IPC and preload accept an optional repoPath without changing init/worktree roots", () => {
  assert.match(ipc, /gitListRepos: "git:list-repos"/);
  assert.match(preload, /listRepos:/);
  assert.match(preload, /branches: \(projectId: string, repoPath\?: string\)/);
  assert.match(gitIpc, /resolveGitCwd/);
  assert.match(gitIpc, /listGitRepos\(projectHostPath\(project\)\)/);
  // git init 走 currentGitExecutable()（用户可在设置页指定路径），root 仍是项目宿主路径、不随 repoPath 变
  assert.match(gitIpc, /currentGitExecutable\(\), \["init"\], \{ cwd: projectHostPath\(project\) \}\)/);
  assert.match(gitIpc, /worktreeService\.list\(projectHostPath\(project\)\)/);
});
