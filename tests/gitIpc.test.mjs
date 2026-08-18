import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const entry = readFileSync("src/main/index.ts", "utf8");
const gitIpc = readFileSync("src/main/ipc/gitIpc.ts", "utf8");

test("Git IPC is registered through one-way service dependencies", () => {
  assert.match(entry, /registerGitIpc\(\{[\s\S]*appLogger,[\s\S]*gitService,[\s\S]*piLocator,[\s\S]*projectStore,[\s\S]*settingsStore,[\s\S]*worktreeService,[\s\S]*\}\)/);
  assert.doesNotMatch(entry, /ipcMain\.handle\(ipcChannels\.git/);
  assert.doesNotMatch(gitIpc, /from\s+["']\.\.\/index["']/);
});

test("Git IPC keeps project lookup, bounded diffs, and stale-worktree cleanup", () => {
  for (const channel of [
    "gitBranches",
    "gitCheckout",
    "gitCreateBranch",
    "gitOriginalContent",
    "gitWorktreeList",
    "gitWorktreeCreate",
    "gitWorktreeRemove",
    "gitCommitLog",
    "gitRefs",
    "gitBranchCompare",
    "gitCommitDetail",
    "gitCommitFileDiff",
    "gitDiffFileBetween",
    "gitStatus",
    "gitWorkspaceFileDiff",
    "gitStage",
    "gitUnstage",
    "gitDiscard",
    "gitCommit",
    "gitCherryPick",
    "gitRevert",
    "gitPush",
    "gitPull",
    "gitReset",
    "gitDropCommit",
    "gitGenerateCommitMessage",
    "gitInit",
    "gitFetch",
    "gitAheadBehind",
    "gitDeleteFiles",
  ]) {
    assert.match(gitIpc, new RegExp(`ipcChannels\\.${channel}`));
  }
  assert.match(gitIpc, /maxEditorFileSizeMB/);
	assert.match(gitIpc, /const stillInGit = \(await worktreeService\.list\(hostProjectPath\)\)\.some/);
	assert.match(gitIpc, /if \(ok \|\| !stillInGit\)/);
	assert.match(gitIpc, /projectStore\.remove\(child\.id\)/);
	assert.match(gitIpc, /const projectHostPath = \(project: \{ path: string \}\) => hostPath\(project\.path\)/);
	assert.match(gitIpc, /paths\.map\(hostPath\)/);
});

test("git:fetch skips non-repositories instead of throwing", () => {
  const service = readFileSync("src/main/git/GitService.ts", "utf8");
  const fetchFn = service.slice(service.indexOf("async fetch(cwd: string)"), service.indexOf("async getAheadBehind"));
  assert.match(fetchFn, /not a git repository/);
  assert.match(fetchFn, /return;/);
	assert.match(gitIpc, /if \(!\(await gitService\.isGitRepo\(projectHostPath\(project\)\)\)\) return;/);
});
