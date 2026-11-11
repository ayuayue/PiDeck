import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteGitViewController } = loadTsCommonJs("src/renderer/src/utils/remoteGitViewState.ts");
const HOOK = "src/renderer/src/hooks/useRemoteGitView.ts";

/**
 * G4a capability gates: capabilities are the only entry decision. A closed capability means zero API calls — never a
 * “try and see” request — and no effect may ever start a fetch. The source scans pin the two polling gates (statusPoll
 * at the hook, refsWatch at the controller/hook) and the fact that the hook no longer subscribes to preload directly.
 */

const projectId = "project";
const oid = (char) => char.repeat(40);
const target = { projectId, relativePath: "one.txt" };
const resource = { target, path: target.relativePath, displayPath: target.relativePath, status: 5, letter: "M" };
const snapshot = { head: null, branch: "main", groups: { merge: [], index: [], workingTree: [resource], untracked: [{ target: { projectId, relativePath: "junk.txt" }, path: "junk.txt", displayPath: "junk.txt", status: 7, letter: "U" }] } };
const recoveryEntry = { ref: "refs/pideck/recovery/20261016120000-ab12cd34", oid: oid("c"), path: "one.txt", bytes: 10, at: 1792138005 };

function caps(overrides = {}) {
	return {
		read: true,
		diff: true,
		branchRead: true,
		history: true,
		repos: true,
		refs: true,
		write: true,
		branchWrite: true,
		branchCreateMode: "both",
		sync: true,
		syncFacts: true,
		aheadBehind: true,
		compare: true,
		recovery: true,
		worktree: true,
		init: true,
		forceRefresh: true,
		autoFetch: false,
		statusPoll: true,
		refsWatch: true,
		deleteFiles: true,
		...overrides,
	};
}

function fakeApi() {
	const calls = [];
	const record =
		(name, value) =>
		async (...args) => {
			calls.push(name);
			return typeof value === "function" ? value(...args) : value;
		};
	const api = {
		cancelRemoteReads: record("cancelRemoteReads"),
		status: record("status", { ok: true, snapshot }),
		refresh: record("refresh", { ok: true, snapshot }),
		branches: record("branches", { ok: true, info: { current: "main", branches: ["main"] } }),
		historyPage: record("historyPage", { ok: true, value: { commits: [{ oid: oid("a"), parents: [], subject: "s", authorName: "A", authorEmail: "a@e", authorTimeMs: 1_700_000_000_000 }], hasMore: false } }),
		commitDetail: record("commitDetail", { ok: true, detail: { oid: oid("a"), parents: [], authorName: "A", authorEmail: "a@e", authorTimeSec: 1, committerName: "A", committerEmail: "a@e", committerTimeSec: 1, subject: "s", message: "s\n", files: [] } }),
		refs: record("refs", { ok: true, refs: { head: null, branch: "main", refs: [] } }),
		refFileDiff: record("refFileDiff", { ok: true, diff: { path: target.relativePath, target, displayPath: target.relativePath, base: null, head: oid("a"), originalContent: "", modifiedContent: "" } }),
		compareRefs: record("compareRefs", { ok: true, value: { mode: "trees", base: { ref: "refs/heads/main", oid: oid("a") }, head: { ref: "refs/tags/v1", oid: oid("b") }, files: [] } }),
		workspaceFileDiff: record("workspaceFileDiff", { path: target.relativePath, target, displayPath: target.relativePath, originalContent: "old", modifiedContent: "new" }),
		syncFacts: record("syncFacts", { ok: true, facts: { branch: "main", upstream: null, ahead: 0, behind: 0, remotes: ["origin"] } }),
		repos: record("repos", { repos: [], truncated: false, revision: 1, generation: "g" }),
		mutateIndex: record("mutateIndex", { ok: true }),
		commit: record("commit", { ok: true }),
		discard: record("discard", { ok: true, recoveryRef: null }),
		createBranch: record("createBranch", { ok: true }),
		switchBranch: record("switchBranch", { ok: true }),
		recoveryList: record("recoveryList", { ok: true, entries: [recoveryEntry], truncated: false }),
		recoveryRestore: record("recoveryRestore", { ok: true }),
		recoveryDrop: record("recoveryDrop", { ok: true }),
		fetch: record("fetch", { ok: true }),
		push: record("push", { ok: true }),
		pull: record("pull", { ok: true }),
		init: record("init", { ok: true, branch: "main" }),
	};
	return { api, calls };
}

async function loaded(overrides = {}) {
	const { api, calls } = fakeApi();
	const states = [];
	const controller = createRemoteGitViewController(projectId, "key", api, (state) => states.push(state), "", caps(overrides));
	if (caps(overrides).read) await controller.refresh();
	else controller.setUnavailable("PROJECT_SERVICE_CAPABILITY_TRUST_REQUIRED");
	calls.length = 0;
	return { controller, calls, current: () => states.at(-1) };
}

test("read 关闭：refresh/refreshStatus 零读、setUnavailable 只发布稳定原因", async () => {
	const { controller, calls, current } = await loaded({ read: false });
	assert.equal(current().blockedReason, "PROJECT_SERVICE_CAPABILITY_TRUST_REQUIRED");
	assert.equal(current().snapshot, undefined);
	assert.equal(current().loading, false);
	await controller.refresh();
	await controller.refresh(true);
	await controller.refreshStatus();
	assert.deepEqual(calls, [], "a closed read capability must not start any read");
	// Nothing was in flight, so there is nothing to cancel either: closing read is a zero-call state.
	controller.dispose();
	assert.deepEqual(calls, []);
});

test("write/branchWrite/diff/history/refs/compare/sync/recovery/init 各自关闭时零调用", async () => {
	const cases = [
		{
			caps: { write: false },
			action: async (controller) => {
				await controller.mutate("stage", "workingTree", target);
				await controller.commit("subject");
				await controller.discard("workingTree", target);
			},
			names: ["mutateIndex", "commit", "discard"],
		},
		{
			caps: { branchWrite: false },
			action: async (controller) => {
				await controller.createBranch("topic");
				await controller.switchBranch("topic");
			},
			names: ["createBranch", "switchBranch"],
		},
		{
			caps: { diff: false },
			action: async (controller) => {
				await controller.openDiff("workingTree", target);
				await controller.openHistoryFileDiff(oid("a"), oid("b"), target);
			},
			names: ["workspaceFileDiff", "refFileDiff"],
		},
		{
			caps: { history: false },
			action: async (controller) => {
				await controller.loadHistory();
				await controller.loadMoreHistory();
				await controller.openCommitDetail(oid("a"));
			},
			names: ["historyPage", "commitDetail"],
		},
		{
			caps: { refs: false },
			action: async (controller) => {
				await controller.loadRefs();
				await controller.pollRefs();
			},
			names: ["refs"],
		},
		{
			caps: { compare: false },
			action: async (controller) => controller.runCompare("refs/heads/main", "refs/tags/v1"),
			names: ["compareRefs"],
		},
		{
			caps: { sync: false, syncFacts: false },
			action: async (controller) => {
				await controller.loadSync();
				await controller.fetch("origin");
				await controller.push("origin", "main");
				await controller.pull("origin", "main");
			},
			names: ["syncFacts", "fetch", "push", "pull"],
		},
		{
			caps: { syncFacts: false },
			action: async (controller) => controller.loadSync(),
			names: ["syncFacts"],
		},
		{
			caps: { recovery: false },
			action: async (controller) => {
				await controller.loadRecovery();
				await controller.restoreRecovery(recoveryEntry);
				await controller.dropRecovery(recoveryEntry);
			},
			names: ["recoveryList", "recoveryRestore", "recoveryDrop"],
		},
	];
	for (const entry of cases) {
		const { controller, calls } = await loaded(entry.caps);
		await entry.action(controller);
		assert.deepEqual(
			calls.filter((name) => entry.names.includes(name)),
			[],
			JSON.stringify(entry.caps) + " must make zero calls",
		);
	}
	const initClosed = await loaded({ init: false });
	assert.equal(await initClosed.controller.initRepository(), false);
	assert.deepEqual(initClosed.calls, [], "init 关闭时连一次 init 调用都不发");
});

test("forceRefresh 关闭时显式刷新退回普通事实读；分支跟着事实读一次拿回，不另发往返", async () => {
	const plain = await loaded({ forceRefresh: false });
	await plain.controller.refresh(true);
	assert.deepEqual(plain.calls, ["status"], "the force channel is never touched without git.forceRefresh, and no second branch round trip is spent");
	const noBranch = await loaded({ branchRead: false });
	await noBranch.controller.refresh();
	assert.deepEqual(noBranch.calls, ["status"], "分支不是单独一轮往返");
	// branchRead 关闭时的 null 由面板桥结出（见 remoteGitPanelApi 用例），控制器不自己猜。
});

test("能力齐全时，关闭的只是对应动作：读仍可用，静默读也走同一套能力判定", async () => {
	const { controller, calls, current } = await loaded();
	assert.deepEqual(calls, [], "the setup read is not part of the assertions");
	await controller.refreshStatus();
	assert.deepEqual(calls, ["refresh"], "a silent tick prefers the force read and does not spend a second round trip on the branch");
	assert.equal(current().snapshot.branch, "main", "the branch is display-only: the tick keeps the last confirmed value");
	// Dispose still retires in-flight reads through the bounded cancel call.
	controller.dispose();
	assert.deepEqual(calls.at(-1), "cancelRemoteReads");
});

test("hook 源码：status 轮询受 capabilities.statusPoll 约束、refs 轮询受 refsWatch 约束", () => {
	const hook = readFileSync(HOOK, "utf8");
	assert.match(hook, /useProjectServices\(project\)/, "the only data entry is the project service");
	assert.match(hook, /createRemoteGitPanelApi\(services\)/, "the hook builds the bridge from the project-bound service");
	assert.match(hook, /repoPath, services\.generation\]/, "the connection generation is part of the controller key");
	assert.match(hook, /capabilities\.statusPoll && remoteGitStatusPollingEnabled/, "status polling is gated by the capability");
	assert.match(hook, /capabilities\.refsWatch \? \(?controller\.current\?\.pollRefs\(\)/, "refs polling is gated by refsWatch");
	// The initial read is a capability decision: closed read never calls refresh, it publishes the stable reason.
	assert.match(hook, /if \(!capabilities\.read\) reads\.setUnavailable\(blocked\["git\.read"\] \?\? "PROJECT_CAPABILITY_HOST_NOT_READY"\)/, "a closed read does not read and shows the reason");
	assert.match(hook, /void reads\.refresh\(\);\s*reads\.loadSync\(\);/, "the facts are read once, in parallel with the first repository read");
});

test("hook 源码：不再直订 preload 事实/主机订阅，也不需要令牌", () => {
	const hook = readFileSync(HOOK, "utf8");
	assert.ok(!hook.includes("subscribeRemoteGitFacts"), "the preload facts subscription is gone");
	assert.ok(!hook.includes("onProjectFactsChanged"), "no direct preload facts subscription");
	assert.ok(!hook.includes("remoteHosts.onStateChange"), "no direct host state subscription");
	assert.ok(!hook.includes("desktopApi.git"), "the hook no longer carries a panel-private Git preload entry");
	for (const token of ["mutationToken", "commitToken", "branchToken", "switchToken", "discardToken", "restoreToken", "dropToken", "fetchToken", "pushToken", "pullToken"]) {
		assert.ok(!hook.includes(token), "the hook never mentions the " + token);
	}
});

test("任何 effect 都不调用 fetch（也绝不自动 push/pull）", () => {
	const hook = readFileSync(HOOK, "utf8");
	for (const effect of hook.split("useEffect(").slice(1)) {
		const body = effect.split("\n\t},")[0];
		assert.ok(!/fetchRemote|\.fetch\(|pushRemote|pullRemote/.test(body), "an effect must never start a network verb: " + body.trim().slice(0, 80));
	}
	const controllerSource = readFileSync("src/renderer/src/utils/remoteGitViewState.ts", "utf8");
	// The controller may only reach the verbs through the explicit sync()/fetch()/push()/pull() user actions.
	assert.ok(controllerSource.includes("autoFetch: false"), "the default capability table keeps autoFetch off");
});
