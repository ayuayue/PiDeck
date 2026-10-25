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
		"gitListRepos",
		"gitBranches",
		"gitCheckout",
		"gitCreateBranch",
		"gitOriginalContent",
		"gitWorktreeList",
		"gitWorktreeCreate",
		"gitWorktreeRemove",
		"gitCommitLog",
		"gitCommitCount",
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
	assert.match(gitIpc, /if \(!\(await gitService\.isGitRepo\(cwd\)\)\) return;/);
});

test("QuickGen spawn 必须挂 error 监听（ENOENT 无监听会崩主进程）且清理后挂起请求能结算", () => {
	const spawnAt = gitIpc.indexOf("const childProcess = spawn(");
	const errorListenerAt = gitIpc.indexOf('childProcess.on("error"');
	assert.ok(spawnAt > 0, "QuickGen spawn 调用存在");
	assert.ok(errorListenerAt > spawnAt, "spawn 后必须挂 error 监听");
	// 监听必须先于首个 RPC 请求（set_model）：否则 ENOENT 请求挂起期间无人清理
	assert.ok(errorListenerAt < gitIpc.indexOf("await genRpcClient.request("), "error 监听必须在首个 RPC 请求之前注册");
	assert.match(gitIpc, /if \(genProcess === childProcess\) stopGenProcess\(\);/, "只清理当前实例，旧进程的迟到 error 不得抹掉新进程全局态");
	// 兑底链完整性：genBusy 复位靠 quickGenerate 的 finally，挂起请求靠 PiRpcClient.close 拒绝
	const quickGen = gitIpc.slice(gitIpc.indexOf("async function quickGenerate"));
	assert.match(quickGen, /finally\s*\{[\s\S]*?genBusy = false/, "genBusy 必须在 finally 复位（spawn 失败不锁死后续生成）");
});
