import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { preloadSource } from "./helpers/preloadSources.mjs";
import { gitPanelSource } from "./helpers/gitPanelSources.mjs";

const host = readFileSync("src/renderer/src/components/workspace/GitDrawerHost.tsx", "utf8");
const scope = readFileSync("src/renderer/src/hooks/useGitRepoScope.ts", "utf8");
const drawer = readFileSync("src/renderer/src/components/workspace/DrawerSurface.tsx", "utf8");
const ipc = readFileSync("src/shared/ipc.ts", "utf8");
const preload = preloadSource;
const gitIpc = readFileSync("src/main/ipc/gitIpc.ts", "utf8");
const panel = gitPanelSource;
const graph = readFileSync("src/renderer/src/components/app/git/GitGraph.tsx", "utf8");
const resourceTree = readFileSync("src/renderer/src/components/app/git/GitResourceTree.tsx", "utf8");
const gitService = readFileSync("src/main/git/GitService.ts", "utf8");

// 文件名保留，确保从旧切换器实现迁移时仍会运行这组多仓契约测试。
test("Git drawer renders every discovered repository instead of selecting one active repository", () => {
	assert.match(drawer, /<ProjectGitDrawer/);
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
	assert.match(host, /gitApi\s*\.checkout\(projectId, branch, repo\.target\)/);
	assert.match(host, /repoScopeKey=\{repoKey \?\? ""\}/);
	assert.match(host, /onOpenWorkspaceFileDiff\(group, target, repoTarget\)/);
	assert.match(host, /onOpenCommitFileDiff\(commit, file, repoTarget\)/);
});

test("multi-repository panes share one Graph/Compare and only stack change lists", () => {
	assert.match(host, /renderPanel\(repo, repoLabel\(repo\), "changesOnly"\)/);
	assert.match(host, /renderPanel\(historyRepo, undefined, "historyOnly"\)/);
	assert.match(host, /selectHistoryRepo/);
	assert.match(host, /historyRepoOptions/);
	assert.doesNotMatch(host, /h-\[420px\] min-h-\[320px\]/);
	assert.doesNotMatch(host, /basis-\[42%\]/);
	assert.match(panel, /layout\?: "full" \| "changesOnly" \| "historyOnly"/);
	assert.match(panel, /layout !== "changesOnly"[\s\S]{0,200}?<SourceControlGraph/);
	// 条件与 JSX 之间可能被格式化换行：容忍空白。
	assert.match(panel, /layout !== "changesOnly" &&\s*\(?\s*<CompareChanges/);
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
	assert.match(resourceTree, /stageDir\?: \(targets: ProjectFileTarget\[\]\) => void/);
	assert.match(resourceTree, /discardDir\?: \(resources: GitDiscardResource\[\], label: string\) => void/);
	assert.match(resourceTree, /const stageable = dirResources\.filter/);
	assert.match(resourceTree, /ctx\.stageDir\?\.\(stageable\.map/);
	assert.match(resourceTree, /ctx\.discardDir\?\.\(discardable, dir \|\| "\/"\)/);
	assert.match(panel, /const changeGroupSpecs = useMemo/);
	assert.match(panel, /stageDir: gitCapabilities\.write \? stageFiles : undefined/);
	assert.match(panel, /discardDir: gitCapabilities\.write \? discardDir : undefined/);
	assert.match(panel, /setDirectoryDiscardTarget\(\{ resources, label \}\)/);
	assert.match(panel, /props\.discardFiles\(props\.projectId, target\.resources\)/);
	assert.match(ipc, /gitDiscardFiles: "git:discard-files"/);
	assert.match(preload, /discardFiles: \(projectId: string, resources: GitDiscardResource\[\]/);
	assert.match(gitIpc, /ipcChannels\.gitDiscardFiles/);
	assert.match(gitService, /async discardFiles\(cwd: string, resources:/);
	assert.match(gitService, /"git:discard-files"/);
});

test("Git IPC and preload use repository targets without changing init/worktree roots", () => {
	assert.match(ipc, /gitListRepos: "git:list-repos"/);
	assert.match(preload, /listRepos:/);
	assert.match(preload, /branches: \(projectId: string, repoPath\?: ProjectFileTarget\)/);
	assert.match(gitIpc, /gitBackendRouter\.forProject\(projectId\)\.listRepositories\(\{ projectId, relativePath: "" \}\)/);
	// repo cwd 仍经统一解析：preload 传 ProjectFileTarget，主进程在 backend 边界解析成本机 cwd。
	assert.match(gitIpc, /resolveGitCwd/);
	// git init 收口到 gitService.init(context.projectRoot)（backend 已解析出项目根）；
	// root 仍是项目宿主路径、不随 repoPath 变；windowsHide/wsl.exe 细节由执行层统一处理。
	assert.match(gitIpc, /await gitService\.init\(context\.projectRoot\)/);
	assert.match(gitIpc, /worktreeService\.list\(repository\.projectRoot\)/);
});
