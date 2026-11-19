import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const remotePanelSource = readFileSync("src/renderer/src/components/workspace/RemoteGitPanel.tsx", "utf8");
const remoteBridgeSource = readFileSync("src/renderer/src/components/workspace/remoteGitPanelBridge.ts", "utf8");
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { preloadSource } from "./helpers/preloadSources.mjs";

/*
 * G5d read-only repository scope at the view layer. The controller is created per selected repository, so every read
 * call has to name it: a single missed argument would silently read the project-root repository under a nested scope.
 * The tests below assert the exact argument on every read path, that writes name it too, and that a nested scope
 * never offers init. The panel/hook source scans pin the selector, the capability entry and the four-layer wiring.
 *
 * G4a: the API is the project-bound panel API (no project id, no token); "" is the root scope and a nested scope is the
 * project-relative path. The service does the target conversion.
 */

const { createRemoteGitViewController } = loadTsCommonJs("src/renderer/src/utils/remoteGitViewState.ts");
const projectId = "project";
const scoped = "packages/nested";
const oid = (char) => char.repeat(40);
const target = { projectId, relativePath: "tracked.txt" };
const groups = { merge: [], index: [], workingTree: [], untracked: [] };
const snapshot = { head: null, branch: "main", groups };
const branchInfo = { current: "main", branches: ["main"] };
const page = { commits: [{ oid: oid("a"), parents: [], subject: "one", authorName: "A", authorEmail: "a@e.invalid", authorTimeMs: 1_700_000_000_000 }], hasMore: true };
const detail = { oid: oid("a"), parents: [oid("b")], authorName: "A", authorEmail: "a@e.invalid", authorTimeSec: 1700000000, committerName: "A", committerEmail: "a@e.invalid", committerTimeSec: 1700000000, subject: "s", message: "s\n", files: [{ status: "M", path: "tracked.txt" }] };
const refs = { head: null, branch: "main", refs: [{ fullName: "refs/heads/main", name: "main", oid: oid("a"), kind: "branch" }] };
const compare = { mode: "trees", base: { ref: "refs/heads/main", oid: oid("a") }, head: { ref: "refs/tags/v1", oid: oid("b") }, files: [{ status: "M", path: "tracked.txt" }] };
const recoveryEntry = { ref: "refs/pideck/recovery/20261017120000-ab12cd34", oid: oid("c"), path: "tracked.txt", bytes: 10, at: 1792138005 };
const syncFacts = { branch: "main", upstream: null, ahead: 0, behind: 0, remotes: ["origin"] };
const plain = (value) => JSON.parse(JSON.stringify(value));

/** One controller per scope: every read fake records its full argument list. */
function fixture(repoPath = scoped, api = {}) {
	const states = [];
	const calls = [];
	const record = (name, args) => {
		calls.push([name, ...args]);
	};
	const controller = createRemoteGitViewController(
		projectId,
		"identity",
		{
			cancelRemoteReads: async () => {},
			status: async (...args) => {
				record("status", args);
				return { ok: true, snapshot };
			},
			refresh: async (...args) => {
				record("refresh", args);
				return { ok: true, snapshot };
			},
			branches: async (...args) => {
				record("branches", args);
				return { ok: true, info: branchInfo };
			},
			workspaceFileDiff: async (...args) => {
				record("workspaceDiff", args);
				return { path: target.relativePath, target, displayPath: target.relativePath, originalContent: "old", modifiedContent: "new" };
			},
			historyPage: async (...args) => {
				record("history", args);
				return { ok: true, value: page };
			},
			commitDetail: async (...args) => {
				record("detail", args);
				return { ok: true, detail: { ...detail, oid: args[0] } };
			},
			refs: async (...args) => {
				record("refs", args);
				return { ok: true, refs };
			},
			refFileDiff: async (...args) => {
				record("refFileDiff", args);
				return { ok: true, diff: { path: target.relativePath, target, displayPath: target.relativePath, base: args[0], head: args[1], originalContent: "old", modifiedContent: "new" } };
			},
			compareRefs: async (...args) => {
				record("compare", args);
				return { ok: true, value: compare };
			},
			recoveryList: async (...args) => {
				record("recoveryList", args);
				return { ok: true, entries: [recoveryEntry], truncated: false };
			},
			syncFacts: async (...args) => {
				record("syncFacts", args);
				return { ok: true, facts: syncFacts };
			},
			...api,
		},
		(state) => states.push(state),
		repoPath,
	);
	return { controller, calls, states, current: () => states.at(-1) };
}

async function driveAllReads(f) {
	await f.controller.refresh();
	await f.controller.openDiff("workingTree", target);
	await f.controller.loadHistory();
	await f.controller.loadMoreHistory();
	await f.controller.openCommitDetail(oid("a"));
	await f.controller.loadRefs();
	await f.controller.pollRefs();
	await f.controller.runCompare("refs/heads/main", "refs/tags/v1");
	await f.controller.openHistoryFileDiff(oid("a"), oid("b"), target);
	await f.controller.loadRecovery();
	await f.controller.loadSync();
}

test("every read path names the selected repository scope", async () => {
	const f = fixture(scoped);
	await driveAllReads(f);
	const byName = new Map();
	for (const [name, ...args] of f.calls) {
		if (!byName.has(name)) byName.set(name, []);
		byName.get(name).push(args);
	}
	// The controller is created per scope, so it must name it on every read; a missing one silently reads the root.
	// 分支不再单独读：它随 `status` 的答案一起回来，下发在第一个参数（仓库 scope）。
	const scopeIndex = { status: 0, history: 1, detail: 1, refs: 0, compare: 2, recoveryList: 0, syncFacts: 0 };
	for (const [name, index] of Object.entries(scopeIndex)) {
		assert.ok(byName.has(name), name + " must be read by the driven actions");
		for (const args of byName.get(name)) assert.equal(args[index], scoped, name + " must carry the repository scope");
	}
	// The per-file revision diff names the scope right after the file target.
	assert.ok(!byName.has("branches"), "分支不另发一轮往返：它跟着 status 一起读");
	for (const args of byName.get("refFileDiff")) {
		assert.deepEqual(plain(args[2]), target, "refFileDiff keeps the file target in place");
		assert.equal(args[3], scoped, "refFileDiff must carry the repository scope");
	}
	// The workspace diff names the scope as its last argument.
	for (const args of byName.get("workspaceDiff")) assert.equal(args[2], scoped, "workspaceDiff must scope the repository");
	// The refs reads happen at least twice (manual + quiet poll) and both are scoped.
	assert.ok(byName.get("refs").length >= 2, "manual and polled refs reads both run");
	// Root scope keeps the exact pre-G4a shape: an empty string is still passed by this controller, never dropped.
	const root = fixture("");
	await driveAllReads(root);
	for (const [name, ...args] of root.calls) {
		if (name === "refFileDiff") assert.equal(args[3], "", "the root per-file diff passes the root scope");
		else if (name === "detail" || name === "compare" || name === "workspaceDiff") assert.equal(args[name === "detail" ? 1 : name === "compare" ? 2 : 2], "", name + " must pass the root scope explicitly");
		else if (name === "history") assert.equal(args[1], "", "the root history page passes the root scope");
		else assert.equal(args[0], "", name + " must pass the root scope explicitly");
	}
});

test("a nested scope still never offers the explicit init", async () => {
	const calls = [];
	const f = fixture(scoped, {
		status: async () => ({ ok: false, code: "GIT_NOT_REPOSITORY" }),
		init: async (...args) => {
			calls.push(["init", ...args]);
			return { ok: true, branch: "main" };
		},
	});
	await f.controller.refresh();
	assert.equal(await f.controller.initRepository(), false, "a nested scope must not report a successful init");
	assert.equal(calls.length, 0, "a nested scope must never call init");
});

const resource = { target, path: target.relativePath, displayPath: target.relativePath, status: 5, letter: "M" };
const writableSnapshot = { ...snapshot, groups: { ...groups, workingTree: [resource] } };

/** Drive all ten write APIs through one controller and record the full argument list each fake receives. */
async function driveWrites(repoPath) {
	const writes = [];
	const record =
		(name) =>
		async (...args) => {
			writes.push([name, ...args]);
			if (name === "discard") return { ok: true, recoveryRef: "refs/pideck/recovery/x" };
			if (name === "restore" || name === "drop" || name === "create" || name === "switch" || name === "mutate" || name === "commit") return { ok: true };
			return { ok: true };
		};
	const f = fixture(repoPath, {
		status: async () => ({ ok: true, snapshot: writableSnapshot }),
		branches: async () => ({ ok: true, info: { current: "main", branches: ["main"] } }),
		mutateIndex: record("mutate"),
		commit: record("commit"),
		createBranch: record("create"),
		switchBranch: record("switch"),
		discard: record("discard"),
		recoveryRestore: record("restore"),
		recoveryDrop: record("drop"),
		fetch: record("fetch"),
		push: record("push"),
		pull: record("pull"),
	});
	await f.controller.refresh();
	await f.controller.loadSync();
	await f.controller.mutate("stage", "workingTree", target);
	await f.controller.loadSync();
	await f.controller.commit("message");
	await f.controller.loadSync();
	await f.controller.createBranch("feature");
	await f.controller.loadSync();
	await f.controller.switchBranch("feature");
	await f.controller.loadSync();
	await f.controller.discard("workingTree", target);
	await f.controller.loadSync();
	await f.controller.restoreRecovery(recoveryEntry);
	await f.controller.loadSync();
	await f.controller.dropRecovery(recoveryEntry);
	await f.controller.loadSync();
	await f.controller.fetch("origin");
	await f.controller.loadSync();
	await f.controller.push("origin", "main");
	await f.controller.loadSync();
	await f.controller.pull("origin", "main");
	return writes;
}

/** The exact shape each write API is called with: the repository scope is always the trailing argument. */
function expectedWriteCalls(scope) {
	return [
		["mutate", "stage", "workingTree", target, scope],
		["commit", "message", scope],
		["create", "feature", scope],
		["switch", "feature", scope],
		["discard", "workingTree", target, scope],
		["restore", recoveryEntry.ref, recoveryEntry.oid, recoveryEntry.path, scope],
		["drop", recoveryEntry.ref, recoveryEntry.oid, scope],
		["fetch", "origin", scope],
		["push", "origin", "main", scope],
		["pull", "origin", "main", scope],
	];
}

test("every write API receives the controller's exact repository scope", async () => {
	assert.deepEqual(plain(await driveWrites(scoped)), expectedWriteCalls(scoped), "a nested controller must name its repository on every write");
	// A root controller still sends the empty string explicitly: never undefined, so a missing argument cannot silently
	// mean the root repository.
	assert.deepEqual(plain(await driveWrites("")), expectedWriteCalls(""), "a root controller must name the root scope explicitly");
});

test("共用面板里多仓并排：每仓一份桥与分支，Graph/Compare 只挂一份并带仓库切换", () => {
	const panel = remotePanelSource;
	const bridge = remoteBridgeSource;
	assert.match(panel, /data-testid="remote-git-repos-truncated"/, "discovery truncation stays visible");
	assert.ok(!panel.includes("remote-git-repo-select"), "the single active-scope selector is gone: every repository gets its own panel");
	assert.ok(!panel.includes("remote-git-repo-readonly-note"), "the G5d read-only note is gone: a nested scope writes its own repository");
	// 多仓判定与并排布局：每个仓一个 changesOnly，Graph/Compare 只有 historyOnly 那一份。
	assert.match(panel, /repos\.length > 1[\s\S]{0,160}?repos\.some\(\(repo\) => repo\.path === ""\)/, "multi-repo is true for several repositories or rootless nested ones");
	assert.match(panel, /layout="changesOnly"/);
	assert.match(panel, /layout="historyOnly"/);
	assert.match(panel, /history=\{\{ path: historyRepo\.path/, "the single graph carries the repository switcher");
	// 每个仓一份桥：作用域绑死在那个仓，切换仓库不是换全局选中项。
	assert.match(panel, /createRemoteGitPanelBridge\(services, repoTarget\)/);
	assert.match(panel, /repoScopeKey=\{repoPath\}/, "each panel resets its own state with its own scope");
	assert.match(bridge, /services\.git\.(status|refresh)\(repo\)/);
	assert.match(bridge, /services\.git\.commit\(message, repo\)/);
	// init 没有 repo 参数：嵌套 scope 不允许把初始化打到子仓。
	assert.match(bridge, /services\.git\.init\(\)/);
	assert.ok(!bridge.includes("services.git.init(repo)"), "init is offered only from the root scope");
});

test("the repository-scope API is wired through all four layers and the dictionaries", () => {
	// Read channels carry a trailing repo argument in preload; write channels carry one too since G5e.
	const preload = preloadSource;
	for (const signature of [
		"remoteSnapshot: (projectId: string, repo?: string)",
		"remoteCommitDetail: (projectId: string, oid: string, repo?: string)",
		"remoteRefs: (projectId: string, repo?: string)",
		"remoteRefFileDiff: (projectId: string, base: string | null, head: string, target: ProjectFileTarget, repo?: string)",
		"recoveryList: (projectId: string, repo?: string)",
		"syncFacts: (projectId: string, repo?: string)",
	])
		assert.ok(preload.includes(signature), signature);
	// The write channels keep their existing arguments and append the scope after the token (or after all args).
	assert.match(preload, /commitRemote: \(projectId: string, message: string, token: string, repo\?: string\)/, "commit appends the scope after the token");
	assert.match(preload, /mutateRemoteIndex: \(projectId: string, operation: "stage" \| "unstage", group: import\("\.\.\/shared\/types"\)\.GitResourceGroupType, target: ProjectFileTarget, token: string, repo\?: string\)/, "index mutations append the scope after the token");
	for (const name of ["createRemoteBranch", "switchRemoteBranch", "discardRemote", "recoveryRestore", "recoveryDrop", "fetchRemote", "pushRemote", "pullRemote"]) assert.match(preload, new RegExp(name + ": \\([^)]*token: string, repo\\?: string\\)"), name + " appends the scope after the token");
	const ipc = readFileSync("src/main/ipc/remoteGitReadIpc.ts", "utf8");
	for (const channel of ["gitRemoteMutateIndex", "gitRemoteCommit", "gitRemoteCreateBranch", "gitRemoteSwitchBranch", "gitRemoteDiscard", "gitRemoteRecoveryRestore", "gitRemoteRecoveryDrop", "gitRemoteFetch", "gitRemotePush", "gitRemotePull"]) {
		const at = ipc.indexOf("ipcChannels." + channel + ", async (");
		assert.ok(at >= 0, channel + " is registered");
		assert.ok(ipc.slice(at, at + 900).includes("token: unknown, repo: unknown"), channel + " must take the trailing scope after the token");
	}
	const zh = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts").zhCN;
	const en = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.en-US.ts").enUS;
	for (const key of ["remoteGit.repoScope", "remoteGit.repoScopeRoot", "remoteGit.repoReposTruncated", "remoteGit.repoNotFound"]) {
		assert.equal(typeof zh[key], "string", key + " zh");
		assert.equal(typeof en[key], "string", key + " en");
	}
	assert.equal(zh["remoteGit.repoReadOnlyNote"], undefined, "the G5d read-only note key is deleted");
	assert.equal(en["remoteGit.repoReadOnlyNote"], undefined, "the G5d read-only note key is deleted");
});
