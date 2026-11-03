/**
 * 远端 Git provider（G1–G3）的行为测试。
 *
 * 断言的是 provider 的真实路由与授权边界，不是源码形状：
 * - 读面走公共 git:* 通道；repoPath 越界在触达 IPC 前拒绝；
 * - refresh 是真正的纯事实强刷（refreshRemoteSnapshot），失败绝不冒充空 groups；
 * - 强刷签出的授权令牌留在 provider 内，被紧随其后的写复用，且期间不产生第二次 snapshot；
 * - 写前缺令牌 = helper 未授权 → unsupported 且零写调用；
 * - 写后快照桶作废，下一次写重新确认；
 * - GIT_WRITE_RESULT_UNCONFIRMED 是 unknown 且只调用一次（不重放）；授权拒绝是 rejected；
 * - fetch/pull/push 只在显式调用时联网；remotes 为空/多个、分支未知时拒绝且零写；
 * - 强刷与同一 scope 的写串行：写未完成时强刷不会插入并撤销 grant；
 * - worktree/deleteFiles 在远端仍显式 unsupported。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createProjectServices, PROJECT_SERVICE_CODES, ProjectServiceError } = loadTsCommonJs("src/renderer/src/services/projectServices.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

const remoteProject = { id: "p2", name: "p2", lastOpenedAt: 0, locator: { kind: "ssh", hostId: "h1", remotePath: "/srv/p2" } };
const FULL_HELPER = [
	"fs.watch",
	"fs.searchNames",
	"fs.searchContent",
	"git.status",
	"git.workspaceDiff",
	"git.log",
	"git.repos",
	"git.refs",
	"git.compare",
	"git.stage",
	"git.unstage",
	"git.commit",
	"git.discard",
	"git.createBranch",
	"git.switchBranch",
	"git.fetch",
	"git.push",
	"git.pull",
	"git.syncFacts",
	"git.init",
	"git.recoveryList",
	"git.recoveryRestore",
	"git.recoveryDrop",
];

function remoteFacts(overrides = {}) {
	return { projectId: "p2", locationKind: "ssh", hostId: "h1", hostState: "ready", rootStatus: "ok", helperCapabilities: FULL_HELPER, trust: "approved", generation: "g1", ...overrides };
}

function groups(overrides = {}) {
	return { merge: [], index: [], workingTree: [], untracked: [], ...overrides };
}

function resource(projectId, path) {
	return { path, displayPath: path, target: { projectId, relativePath: path }, status: "modified", letter: "M" };
}

const OID = "a".repeat(40);
const REPO = { projectId: "p2", relativePath: "" };
const NESTED_REPO = { projectId: "p2", relativePath: "packages/a" };
const TARGET = { projectId: "p2", relativePath: "src/a.ts" };

function snapshot(overrides = {}) {
	return {
		groups: groups(),
		head: OID,
		branch: "main",
		mutationToken: "mutation-token",
		commitToken: "commit-token",
		branchToken: "branch-token",
		switchToken: "switch-token",
		discardToken: "discard-token",
		restoreToken: "restore-token",
		dropToken: "drop-token",
		fetchToken: "fetch-token",
		pushToken: "push-token",
		pullToken: "pull-token",
		...overrides,
	};
}

const SYNC_FACTS = { branch: "main", upstream: "refs/remotes/origin/main", ahead: 2, behind: 1, remotes: ["origin"] };
const COMMIT_DETAIL = {
	oid: OID,
	parents: [],
	authorName: "A",
	authorEmail: "a@example.com",
	authorTimeSec: 1,
	committerName: "A",
	committerEmail: "a@example.com",
	committerTimeSec: 1,
	subject: "subject",
	message: "subject\n",
	files: [],
};
const REF_FILE_DIFF = {
	path: TARGET.relativePath,
	target: TARGET,
	displayPath: TARGET.relativePath,
	base: null,
	head: OID,
	originalContent: "",
	modifiedContent: "next\n",
};

/** 远端 provider 的假 api：公共读通道 + main 的远端 Git 通道；本机专属通道一旦被误用会立刻抛错。 */
function makeApi(options = {}) {
	const calls = [];
	const record = (name, args) => calls.push({ name, args });
	const api = {
		git: {
			status: async (projectId, repoPath) => {
				record("git.status", [projectId, repoPath]);
				return groups();
			},
			historyPage: async (projectId, opts, repoPath) => {
				record("git.historyPage", [projectId, opts, repoPath]);
				return { ok: true, value: { commits: [], hasMore: false } };
			},
			repositoryList: async (projectId) => {
				record("git.repositoryList", [projectId]);
				return { ok: true, value: { repos: [], truncated: true, revision: 2, generation: "g1" } };
			},
			refs: async (projectId, repoPath) => {
				record("git.refs", [projectId, repoPath]);
				return [];
			},
			compareRefs: async (projectId, base, head, repoPath) => {
				record("git.compareRefs", [projectId, base, head, repoPath]);
				return { ok: true, value: { mode: "trees", base: { ref: base, oid: OID }, head: { ref: head, oid: OID }, files: [] } };
			},
			remoteCommitDetail: async (projectId, oid, repo) => {
				record("git.remoteCommitDetail", [projectId, oid, repo]);
				if (options.commitDetailDeferred) return options.commitDetailDeferred.promise;
				return options.commitDetailResult ?? { ok: true, detail: COMMIT_DETAIL };
			},
			remoteRefFileDiff: async (projectId, base, head, target, repo) => {
				record("git.remoteRefFileDiff", [projectId, base, head, target, repo]);
				if (options.refFileDiffDeferred) return options.refFileDiffDeferred.promise;
				return options.refFileDiffResult ?? { ok: true, diff: REF_FILE_DIFF };
			},
			cancelRemoteReads: async (projectId) => {
				record("git.cancelRemoteReads", [projectId]);
				if (options.cancelDeferred) return options.cancelDeferred.promise;
				return undefined;
			},
			workspaceFileDiff: async (projectId, group, file, repoPath) => {
				record("git.workspaceFileDiff", [projectId, group, file, repoPath]);
				return { path: file.relativePath, target: file, displayPath: file.relativePath, originalContent: "", modifiedContent: "" };
			},
			remoteSnapshot: async (projectId, repo) => {
				record("git.remoteSnapshot", [projectId, repo]);
				if (options.remoteSnapshotThrows) throw new Error(options.remoteSnapshotThrows);
				if (options.remoteSnapshotResult) return options.remoteSnapshotResult;
				return { ok: true, snapshot: snapshot(options.snapshotOverrides) };
			},
			refreshRemoteSnapshot: async (projectId, repo) => {
				record("git.refreshRemoteSnapshot", [projectId, repo]);
				if (options.refreshResult) return options.refreshResult;
				return { ok: true, snapshot: snapshot(options.refreshSnapshotOverrides ?? { commitToken: "refresh-commit-token" }) };
			},
			// 主进程的 facts-only 强刷（可选能力）：只读事实，不撤/不签授权；缺省不提供 = 旧装配回落到 refreshRemoteSnapshot。
			...(options.withFactsOnly === true
				? {
						refreshRemoteGitFacts: async (projectId, repo) => {
							record("git.refreshRemoteGitFacts", [projectId, repo]);
							if (options.refreshFactsResult) return options.refreshFactsResult;
							return { ok: true, snapshot: { groups: groups({ workingTree: [resource("p2", "fresh.txt")] }), head: OID, branch: "main" } };
						},
					}
				: {}),
			mutateRemoteIndex: async (...args) => {
				record("git.mutateRemoteIndex", args);
				if (options.mutateDeferred) return options.mutateDeferred.promise;
				return options.mutateResult ?? { ok: true };
			},
			commitRemote: async (...args) => {
				record("git.commitRemote", args);
				if (options.commitThrows) throw new Error(options.commitThrows);
				return options.commitResult ?? { ok: true };
			},
			createRemoteBranch: async (...args) => {
				record("git.createRemoteBranch", args);
				if (options.createBranchResult) return options.createBranchResult;
				return { ok: true };
			},
			switchRemoteBranch: async (...args) => {
				record("git.switchRemoteBranch", args);
				return options.switchResult ?? { ok: true };
			},
			discardRemote: async (...args) => {
				record("git.discardRemote", args);
				return options.discardResult ?? { ok: true, recoveryRef: "refs/pideck/recovery/r1" };
			},
			fetchRemote: async (...args) => {
				record("git.fetchRemote", args);
				return options.fetchResult ?? { ok: true, outcome: { upToDate: false, updated: [] } };
			},
			pullRemote: async (...args) => {
				record("git.pullRemote", args);
				return options.pullResult ?? { ok: true, outcome: { mode: "fast-forward", head: OID } };
			},
			pushRemote: async (...args) => {
				record("git.pushRemote", args);
				return options.pushResult ?? { ok: true, outcome: { outcome: "pushed", refspec: "refs/heads/main:refs/heads/main" } };
			},
			syncFacts: async (projectId, repo) => {
				record("git.syncFacts", [projectId, repo]);
				return options.syncFactsResult ?? { ok: true, facts: SYNC_FACTS };
			},
			recoveryList: async (projectId, repo) => {
				record("git.recoveryList", [projectId, repo]);
				return options.recoveryListResult ?? { ok: true, entries: [{ ref: "refs/pideck/recovery/r1", oid: OID, path: "src/a.ts", bytes: 12, at: 1 }], truncated: false };
			},
			recoveryRestore: async (...args) => {
				record("git.recoveryRestore", args);
				return { ok: true, path: args[3], bytes: 12 };
			},
			recoveryDrop: async (...args) => {
				record("git.recoveryDrop", args);
				return { ok: true };
			},
			remoteRefs: async (projectId, repo) => {
				record("git.remoteRefs", [projectId, repo]);
				return {
					ok: true,
					refs: {
						head: OID,
						branch: "main",
						refs: [
							{ fullName: "refs/heads/main", name: "main", oid: OID, kind: "branch" },
							{ fullName: "refs/heads/topic", name: "topic", oid: OID, kind: "branch" },
							{ fullName: "refs/tags/v1", name: "v1", oid: OID, kind: "tag" },
						],
					},
				};
			},
			initRemote: async (projectId) => {
				record("git.initRemote", [projectId]);
				return options.initResult ?? { ok: true, branch: "main" };
			},
			// 本机专属通道：远端 provider 若误用，测试会在这里立刻失败。
			branches: async () => {
				record("git.branches", []);
				throw new Error("remote provider must not call the local git:branches channel");
			},
			stage: async () => {
				record("git.stage", []);
				throw new Error("remote provider must not call the local git:stage channel");
			},
			commit: async () => {
				record("git.commit", []);
				throw new Error("remote provider must not call the local git:commit channel");
			},
			discardFiles: async () => {
				record("git.discardFiles", []);
				throw new Error("remote provider must not call the local git:discard-files channel");
			},
			fetch: async () => {
				record("git.fetch", []);
				throw new Error("remote provider must not call the local git:fetch channel");
			},
			pull: async () => {
				record("git.pull", []);
				throw new Error("remote provider must not call the local git:pull channel");
			},
			push: async () => {
				record("git.push", []);
				throw new Error("remote provider must not call the local git:push channel");
			},
			init: async () => {
				record("git.init", []);
				throw new Error("remote provider must not call the local git:init channel");
			},
			createBranch: async () => {
				record("git.createBranch", []);
				throw new Error("remote provider must not call the local git:createBranch channel");
			},
			checkout: async () => {
				record("git.checkout", []);
				throw new Error("remote provider must not call the local git:checkout channel");
			},
			deleteFiles: async () => {
				record("git.deleteFiles", []);
				throw new Error("remote provider must not call the local git:delete-files channel");
			},
			worktreeList: async () => {
				record("git.worktreeList", []);
				throw new Error("remote provider must not call the local worktree channel");
			},
			aheadBehind: async () => {
				record("git.aheadBehind", []);
				throw new Error("remote provider must not call the local aheadBehind channel");
			},
		},
		files: {},
		remoteHosts: {},
		remoteTrust: {},
	};
	return { api, calls };
}

function services(api, factsOverrides = {}, fence) {
	return createProjectServices(remoteProject, api, { facts: remoteFacts(factsOverrides), ...(fence === undefined ? {} : { fence }) });
}

const names = (calls) => calls.map((call) => call.name);

function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function waitFor(predicate, label) {
	for (let index = 0; index < 200; index += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("timed out waiting for " + label);
}

/** 断言一次调用的稳定失败结果（code + outcome），不依赖跨 realm 的 instanceof。 */
function rejectsWith(code, outcome = "rejected") {
	return (error) => error instanceof ProjectServiceError && error.code === code && error.outcome === outcome;
}

test("读面走公共 git:* 通道；repoPath 越界在触达 IPC 前被拒（零调用）", async () => {
	const { api, calls } = makeApi();
	const service = services(api);
	await service.git.status(REPO);
	await service.git.history({ maxCount: 10 }, REPO);
	await service.git.repos();
	await service.git.refs(NESTED_REPO);
	await service.git.compare("refs/heads/main", "refs/heads/topic", NESTED_REPO);
	await service.git.workspaceDiff("workingTree", TARGET, REPO);
	assert.deepEqual(names(calls), ["git.status", "git.historyPage", "git.repositoryList", "git.refs", "git.compareRefs", "git.workspaceFileDiff"]);

	const foreign = makeApi();
	const guarded = services(foreign.api);
	await assert.rejects(() => guarded.git.status({ projectId: "p9", relativePath: "" }), rejectsWith(PROJECT_SERVICE_CODES.projectMismatch));
	await assert.rejects(() => guarded.git.refresh({ projectId: "p9", relativePath: "" }), rejectsWith(PROJECT_SERVICE_CODES.projectMismatch));
	await assert.rejects(() => guarded.git.stage([TARGET], { projectId: "p9", relativePath: "" }), rejectsWith(PROJECT_SERVICE_CODES.projectMismatch));
	await assert.rejects(() => guarded.git.fetch({ projectId: "p9", relativePath: "" }), rejectsWith(PROJECT_SERVICE_CODES.projectMismatch));
	await assert.rejects(() => guarded.git.branches({ projectId: "p9", relativePath: "" }), rejectsWith(PROJECT_SERVICE_CODES.projectMismatch));
	assert.deepEqual(foreign.calls, [], "越界 repoPath 不得触达任何通道");
});

test("commitDetail/refFileDiff/cancelRemoteReads route through the project-bound service with nested scope", async () => {
	const { api, calls } = makeApi();
	const service = services(api);

	assert.deepEqual(plain(await service.git.commitDetail(OID, NESTED_REPO)), COMMIT_DETAIL);
	assert.deepEqual(plain(await service.git.refFileDiff(null, OID, TARGET, NESTED_REPO)), REF_FILE_DIFF);
	await service.git.cancelRemoteReads();

	assert.deepEqual(names(calls), ["git.remoteCommitDetail", "git.remoteRefFileDiff", "git.cancelRemoteReads"]);
	assert.deepEqual(plain(calls[0].args), ["p2", OID, "packages/a"]);
	assert.deepEqual(plain(calls[1].args), ["p2", null, OID, TARGET, "packages/a"]);
	assert.deepEqual(plain(calls[2].args), ["p2"]);
});

test("commitDetail/refFileDiff preserve stable failures and never turn them into empty data", async () => {
	const detailFailure = makeApi({ commitDetailResult: { ok: false, code: "GIT_OBJECT_NOT_FOUND" } });
	await assert.rejects(() => services(detailFailure.api).git.commitDetail(OID, REPO), rejectsWith("GIT_OBJECT_NOT_FOUND"));
	assert.deepEqual(names(detailFailure.calls), ["git.remoteCommitDetail"]);

	const diffFailure = makeApi({ refFileDiffResult: { ok: false, code: "GIT_NOT_TEXT" } });
	await assert.rejects(() => services(diffFailure.api).git.refFileDiff(null, OID, TARGET, REPO), rejectsWith("GIT_NOT_TEXT"));
	assert.deepEqual(names(diffFailure.calls), ["git.remoteRefFileDiff"]);
});

test("the new read/cancel methods reject a retired generation before touching a channel", async () => {
	const { api, calls } = makeApi();
	const slot = { current: "g1" };
	const service = services(api, {}, slot);
	slot.current = "g2";

	await assert.rejects(() => service.git.commitDetail(OID, REPO), rejectsWith(PROJECT_SERVICE_CODES.generationStale));
	await assert.rejects(() => service.git.refFileDiff(null, OID, TARGET, REPO), rejectsWith(PROJECT_SERVICE_CODES.generationStale));
	await assert.rejects(() => service.git.cancelRemoteReads(), rejectsWith(PROJECT_SERVICE_CODES.generationStale));
	assert.deepEqual(calls, [], "a stale service generation must make zero preload calls");
});

test("a generation that changes during a detail/ref-diff/cancel read discards the late answer", async () => {
	const detailGate = deferred();
	const detailApi = makeApi({ commitDetailDeferred: detailGate });
	const detailSlot = { current: "g1" };
	const detail = services(detailApi.api, {}, detailSlot).git.commitDetail(OID, REPO);
	await waitFor(() => names(detailApi.calls).includes("git.remoteCommitDetail"), "commit detail dispatch");
	detailSlot.current = "g2";
	detailGate.resolve({ ok: true, detail: COMMIT_DETAIL });
	await assert.rejects(detail, rejectsWith(PROJECT_SERVICE_CODES.generationStale));

	const diffGate = deferred();
	const diffApi = makeApi({ refFileDiffDeferred: diffGate });
	const diffSlot = { current: "g1" };
	const diff = services(diffApi.api, {}, diffSlot).git.refFileDiff(null, OID, TARGET, REPO);
	await waitFor(() => names(diffApi.calls).includes("git.remoteRefFileDiff"), "ref file diff dispatch");
	diffSlot.current = "g2";
	diffGate.resolve({ ok: true, diff: REF_FILE_DIFF });
	await assert.rejects(diff, rejectsWith(PROJECT_SERVICE_CODES.generationStale));

	const cancelGate = deferred();
	const cancelApi = makeApi({ cancelDeferred: cancelGate });
	const cancelSlot = { current: "g1" };
	const cancel = services(cancelApi.api, {}, cancelSlot).git.cancelRemoteReads();
	await waitFor(() => names(cancelApi.calls).includes("git.cancelRemoteReads"), "cancel dispatch");
	cancelSlot.current = "g2";
	cancelGate.resolve();
	await assert.rejects(cancel, rejectsWith(PROJECT_SERVICE_CODES.generationStale));
});

test("refFileDiff rejects a foreign target and repo scope before IPC; cancel drops the grant bucket", async () => {
	const foreign = makeApi();
	const guarded = services(foreign.api);
	await assert.rejects(() => guarded.git.refFileDiff(null, OID, { projectId: "p9", relativePath: TARGET.relativePath }, REPO), rejectsWith(PROJECT_SERVICE_CODES.projectMismatch));
	await assert.rejects(() => guarded.git.refFileDiff(null, OID, TARGET, { projectId: "p9", relativePath: "" }), rejectsWith(PROJECT_SERVICE_CODES.projectMismatch));
	assert.deepEqual(foreign.calls, []);

	const { api, calls } = makeApi();
	const service = services(api);
	await service.git.refresh(REPO);
	await service.git.cancelRemoteReads();
	await service.git.commit("after cancel", REPO);
	assert.deepEqual(names(calls), ["git.refreshRemoteSnapshot", "git.cancelRemoteReads", "git.remoteSnapshot", "git.commitRemote"], "cancel revokes main-owned grants, so the provider cannot reuse the old bucket");
});

test("主进程支持 facts-only 强刷时，refresh 走它：零授权副作用，且不再调用带授权副作用的 refreshRemoteSnapshot", async () => {
	const { api, calls } = makeApi({ withFactsOnly: true });
	const services = createProjectServices(remoteProject, api, { facts: remoteFacts() });
	const groupsAfterRefresh = await services.git.refresh(REPO);
	assert.deepEqual(
		groupsAfterRefresh.workingTree.map((item) => item.path),
		["fresh.txt"],
		"facts-only 强刷返回的是新事实",
	);
	assert.deepEqual(
		calls.map((call) => call.name),
		["git.refreshRemoteGitFacts"],
		"强刷只走 facts-only 通道，不撤/不签令牌",
	);
	// 写仍然正常：授权由写前现取的快照提供，与强刷路径无关。
	await services.git.stage([TARGET], REPO);
	assert.deepEqual(
		calls.map((call) => call.name),
		["git.refreshRemoteGitFacts", "git.remoteSnapshot", "git.mutateRemoteIndex"],
	);
});

test("facts-only 强刷失败按稳定码 rejected，且绝不回落带授权副作用的强刷", async () => {
	const { api, calls } = makeApi({ withFactsOnly: true, refreshFactsResult: { ok: false, code: "GIT_TRUST_REQUIRED" } });
	const services = createProjectServices(remoteProject, api, { facts: remoteFacts() });
	await assert.rejects(
		() => services.git.refresh(REPO),
		(error) => error instanceof ProjectServiceError && error.code === "GIT_TRUST_REQUIRED" && error.outcome === "rejected",
	);
	assert.deepEqual(
		calls.map((call) => call.name),
		["git.refreshRemoteGitFacts"],
		"失败不得退回 refreshRemoteSnapshot（那会撤销并重签授权）",
	);
});

test("refresh 是纯事实强刷：走 refreshRemoteSnapshot（不是 status/remoteSnapshot），失败抛错且不返回空 groups", async () => {
	const { api, calls } = makeApi({ refreshSnapshotOverrides: { groups: groups({ untracked: [resource("p2", "new.ts")] }) } });
	const service = services(api);
	const refreshed = await service.git.refresh(REPO);
	assert.deepEqual(plain(refreshed), plain(groups({ untracked: [resource("p2", "new.ts")] })));
	assert.deepEqual(names(calls), ["git.refreshRemoteSnapshot"], "不得退化成缓存 status，也不得用普通 snapshot 充数");
	assert.deepEqual(calls[0].args, ["p2", ""]);

	const failing = makeApi({ refreshResult: { ok: false, code: "GIT_TRUST_REQUIRED" } });
	await assert.rejects(() => services(failing.api).git.refresh(REPO), rejectsWith("GIT_TRUST_REQUIRED", "rejected"));
	assert.deepEqual(names(failing.calls), ["git.refreshRemoteSnapshot"]);
	assert.deepEqual(failing.calls.length, 1, "失败不能返回空 groups 冒充干净仓库");
});

test("refresh 签出的 grant 被紧随其后的写复用：用 refresh 的令牌，期间没有第二次 snapshot", async () => {
	const { api, calls } = makeApi();
	const service = services(api);
	await service.git.refresh(REPO);
	await service.git.commit("message", REPO);
	assert.deepEqual(names(calls), ["git.refreshRemoteSnapshot", "git.commitRemote"]);
	assert.deepEqual(calls[1].args, ["p2", "message", "refresh-commit-token", ""], "写必须复用强刷快照里签出的 commitToken");
});

test("快照桶按 repoPath 分桶：任何一次现取都会让别的仓库的旧桶失效（main 撤销项目内全部旧令牌）", async () => {
	const { api, calls } = makeApi();
	const service = services(api);
	await service.git.refresh(REPO);
	// 嵌套仓库没有自己的桶：必须现取，而这次现取会让根桶（强刷签出的）失效。
	await service.git.commit("nested message", NESTED_REPO);
	assert.deepEqual(names(calls), ["git.refreshRemoteSnapshot", "git.remoteSnapshot", "git.commitRemote"]);
	assert.deepEqual(calls[2].args, ["p2", "nested message", "commit-token", "packages/a"]);
	await service.git.commit("root message", REPO);
	assert.deepEqual(names(calls).slice(3), ["git.remoteSnapshot", "git.commitRemote"], "根桶已被嵌套快照作废：必须重新确认");
	assert.deepEqual(calls[4].args, ["p2", "root message", "commit-token", ""]);
});

test("强刷失败也会让旧桶失效：下一次写重新确认，不使用可能已被撤销的令牌", async () => {
	const { api, calls } = makeApi();
	let failing = false;
	api.git.refreshRemoteSnapshot = async (projectId, repo) => {
		calls.push({ name: "git.refreshRemoteSnapshot", args: [projectId, repo] });
		return failing ? { ok: false, code: "GIT_TRUST_REQUIRED" } : { ok: true, snapshot: snapshot() };
	};
	const service = services(api);
	await service.git.refresh(REPO);
	failing = true;
	await assert.rejects(() => service.git.refresh(REPO), rejectsWith("GIT_TRUST_REQUIRED", "rejected"));
	await service.git.commit("message", REPO);
	assert.deepEqual(names(calls), ["git.refreshRemoteSnapshot", "git.refreshRemoteSnapshot", "git.remoteSnapshot", "git.commitRemote"]);
});

test("一次失败的快照确认也会推进序号：其他仓库的失败不会让本仓库复用已被 main 撤销的令牌", async () => {
	const { api, calls } = makeApi();
	const service = services(api);
	await service.git.refresh(REPO); // 本项目根仓库拿到一份确认快照
	// 另一仓库的确认在 IPC 层抛错：main 在读到事实之前就撤销了该 sender+project 的全部旧令牌。
	api.git.remoteSnapshot = async (projectId, repo) => {
		calls.push({ name: "git.remoteSnapshot", args: [projectId, repo] });
		if (repo === "packages/a") throw new Error("REMOTE_CONNECTION_LOST");
		return { ok: true, snapshot: snapshot() };
	};
	await assert.rejects(
		() => service.git.stage([TARGET], NESTED_REPO),
		(error) => error instanceof ProjectServiceError,
	);
	const rootSnapshotsBefore = calls.filter((call) => call.name === "git.remoteSnapshot" && call.args[1] === "").length;
	await service.git.stage([TARGET], REPO);
	const rootSnapshotsAfter = calls.filter((call) => call.name === "git.remoteSnapshot" && call.args[1] === "").length;
	assert.equal(rootSnapshotsAfter, rootSnapshotsBefore + 1, "the older confirmation must not be reused after another scope's failed confirm");
});

test("缺 grant 的快照会被作废：下一次写重新确认，而不是反复复用同一份无授权快照", async () => {
	const { api, calls } = makeApi();
	let snapshots = 0;
	api.git.remoteSnapshot = async (projectId, repo) => {
		calls.push({ name: "git.remoteSnapshot", args: [projectId, repo] });
		snapshots += 1;
		return { ok: true, snapshot: snapshots === 1 ? snapshot({ commitToken: undefined }) : snapshot() };
	};
	const service = services(api);
	await assert.rejects(
		() => service.git.commit("message", REPO),
		(error) => error instanceof ProjectServiceError && error.code === PROJECT_SERVICE_CODES.unsupported,
	);
	await service.git.commit("message", REPO);
	assert.equal(snapshots, 2, "a grant-less snapshot is never reused");
	assert.equal(calls.filter((call) => call.name === "git.commitRemote").length, 1, "only the confirmed commit reaches the write channel");
});

test("写前缺令牌：unsupported 且零写调用（快照没有该动作的授权）", async () => {
	const { api, calls } = makeApi({ refreshSnapshotOverrides: { commitToken: undefined } });
	const service = services(api);
	await service.git.refresh(REPO);
	await assert.rejects(
		() => service.git.commit("message", REPO),
		(error) => error instanceof ProjectServiceError && error.code === PROJECT_SERVICE_CODES.unsupported && error.outcome === "rejected",
	);
	assert.deepEqual(names(calls), ["git.refreshRemoteSnapshot"], "缺授权时不得调用任何写通道");
});

test("stage/unstage/commit 成功路径：既有通道 + 快照令牌；写后桶作废，下一次写重新确认", async () => {
	const { api, calls } = makeApi({ snapshotOverrides: { groups: groups({ workingTree: [resource("p2", "src/a.ts")] }) } });
	const service = services(api);
	await service.git.stage([TARGET], REPO);
	assert.deepEqual(names(calls), ["git.remoteSnapshot", "git.mutateRemoteIndex"]);
	assert.deepEqual(calls[1].args, ["p2", "stage", "workingTree", TARGET, "mutation-token", ""], "stage 组别来自同一份 grant 快照");

	await service.git.unstage([TARGET], REPO);
	assert.deepEqual(names(calls).slice(2), ["git.remoteSnapshot", "git.mutateRemoteIndex"], "写后桶作废：下一次写必须重新确认");
	assert.equal(calls[3].args[1], "unstage");
	assert.equal(calls[3].args[2], "index");

	await service.git.commit("message", REPO);
	assert.deepEqual(names(calls).slice(4), ["git.remoteSnapshot", "git.commitRemote"]);
	assert.deepEqual(calls[5].args, ["p2", "message", "commit-token", ""]);
});

test("discard 走 discardRemote：返回 recoveryRef（null 原样保留）", async () => {
	const { api, calls } = makeApi();
	const receipt = await services(api).git.discard([{ group: "workingTree", target: { projectId: "p2", relativePath: "src/b.ts" } }], REPO);
	assert.deepEqual(plain(receipt), { recoveryRef: "refs/pideck/recovery/r1" });
	assert.deepEqual(names(calls), ["git.remoteSnapshot", "git.discardRemote"]);
	assert.deepEqual(calls[1].args, ["p2", "workingTree", { projectId: "p2", relativePath: "src/b.ts" }, "discard-token", ""]);

	const absent = makeApi({ discardResult: { ok: true, recoveryRef: null } });
	assert.deepEqual(plain(await services(absent.api).git.discard([{ group: "untracked", target: { projectId: "p2", relativePath: "new.ts" } }], REPO)), { recoveryRef: null });
});

test("unknown：GIT_WRITE_RESULT_UNCONFIRMED（信封或抛出）→ outcome unknown 且只调用一次，不重放", async () => {
	const envelope = makeApi({ commitResult: { ok: false, code: "GIT_WRITE_RESULT_UNCONFIRMED" } });
	await assert.rejects(() => services(envelope.api).git.commit("message", REPO), rejectsWith("GIT_WRITE_RESULT_UNCONFIRMED", "unknown"));
	assert.deepEqual(names(envelope.calls), ["git.remoteSnapshot", "git.commitRemote"], "unknown 不得重放写，也不得自动补一次 snapshot 重试");

	const thrown = makeApi({ commitThrows: "GIT_WRITE_RESULT_UNCONFIRMED" });
	await assert.rejects(() => services(thrown.api).git.commit("message", REPO), rejectsWith("GIT_WRITE_RESULT_UNCONFIRMED", "unknown"));
	assert.equal(thrown.calls.filter((call) => call.name === "git.commitRemote").length, 1, "只发一次");
});

test("授权拒绝：trust 未批准 → rejected（不是 unknown）且零写调用", async () => {
	const onRefresh = makeApi({ refreshResult: { ok: false, code: "GIT_TRUST_REQUIRED" }, remoteSnapshotResult: { ok: false, code: "GIT_TRUST_REQUIRED" } });
	const service = services(onRefresh.api);
	await assert.rejects(() => service.git.refresh(REPO), rejectsWith("GIT_TRUST_REQUIRED", "rejected"));
	await assert.rejects(() => service.git.stage([TARGET], REPO), rejectsWith("GIT_TRUST_REQUIRED", "rejected"));
	assert.equal(onRefresh.calls.filter((call) => call.name === "git.mutateRemoteIndex").length, 0, "授权拒绝时不得发写");

	const onSnapshot = makeApi({ remoteSnapshotResult: { ok: false, code: "GIT_TRUST_REQUIRED" } });
	await assert.rejects(() => services(onSnapshot.api).git.commit("message", REPO), rejectsWith("GIT_TRUST_REQUIRED", "rejected"));
	assert.deepEqual(names(onSnapshot.calls), ["git.remoteSnapshot"]);
});

test("fetch/pull/push 只在显式调用时联网；remotes 为空/多个或分支未知时拒绝且零写", async () => {
	const idle = makeApi();
	const idleService = services(idle.api);
	await idleService.git.status(REPO);
	await idleService.git.branches(REPO);
	await idleService.git.syncFacts(REPO);
	await idleService.git.aheadBehind(REPO);
	await idleService.git.recoveryList(REPO);
	assert.deepEqual(
		idle.calls.filter((call) => ["git.fetchRemote", "git.pullRemote", "git.pushRemote"].includes(call.name)),
		[],
		"读面不得自动 fetch",
	);

	const none = makeApi({ syncFactsResult: { ok: true, facts: { ...SYNC_FACTS, remotes: [] } } });
	await assert.rejects(() => services(none.api).git.fetch(REPO), rejectsWith("GIT_SYNC_REMOTE_UNKNOWN", "rejected"));
	assert.deepEqual(names(none.calls), ["git.syncFacts"], "没有 remote 时不得发网络写");

	const many = makeApi({ syncFactsResult: { ok: true, facts: { ...SYNC_FACTS, remotes: ["origin", "upstream"] } } });
	await assert.rejects(
		() => services(many.api).git.push(REPO),
		(error) => error instanceof ProjectServiceError && error.code === PROJECT_SERVICE_CODES.unsupported,
	);
	assert.deepEqual(names(many.calls), ["git.syncFacts"], "多个 remote 是契约缺口：显式 unsupported，不替用户选");

	const detached = makeApi({ syncFactsResult: { ok: true, facts: { ...SYNC_FACTS, branch: null } } });
	await assert.rejects(
		() => services(detached.api).git.pull(REPO),
		(error) => error instanceof ProjectServiceError && error.code === PROJECT_SERVICE_CODES.unsupported,
	);
	assert.deepEqual(names(detached.calls), ["git.syncFacts"], "没有当前分支时 pull 不可命名");

	const explicit = makeApi();
	const explicitService = services(explicit.api);
	await explicitService.git.fetch(NESTED_REPO);
	await explicitService.git.pull(NESTED_REPO);
	await explicitService.git.push(NESTED_REPO);
	assert.deepEqual(names(explicit.calls), ["git.syncFacts", "git.remoteSnapshot", "git.fetchRemote", "git.syncFacts", "git.remoteSnapshot", "git.pullRemote", "git.syncFacts", "git.remoteSnapshot", "git.pushRemote"]);
	assert.deepEqual(explicit.calls[2].args, ["p2", "origin", "fetch-token", "packages/a"]);
	assert.deepEqual(explicit.calls[5].args, ["p2", "origin", "main", "pull-token", "packages/a"]);
	assert.deepEqual(explicit.calls[8].args, ["p2", "origin", "main", "push-token", "packages/a"]);
});

test("branches/aheadBehind/syncFacts 派生正确；recovery 列表只读、restore/drop 各用自己令牌", async () => {
	const { api, calls } = makeApi();
	const service = services(api);
	assert.deepEqual(plain(await service.git.branches(NESTED_REPO)), { current: "main", branches: ["main", "topic"] }, "只报本地分支，tag 不进列表");
	assert.deepEqual(calls[0].args, ["p2", "packages/a"]);

	assert.deepEqual(plain(await service.git.aheadBehind(REPO)), { ahead: 2, behind: 1 });
	assert.deepEqual(plain(await service.git.syncFacts(REPO)), SYNC_FACTS);

	const noUpstream = makeApi({ syncFactsResult: { ok: true, facts: { ...SYNC_FACTS, upstream: null } } });
	assert.equal(await services(noUpstream.api).git.aheadBehind(REPO), null, "没有上游时 aheadBehind 是 null，不是 0/0");

	const listing = await service.git.recoveryList(REPO);
	assert.deepEqual(plain(listing), { entries: [{ ref: "refs/pideck/recovery/r1", oid: OID, path: "src/a.ts", bytes: 12, at: 1 }], truncated: false });
	assert.equal(calls.filter((call) => call.name === "git.recoveryList").length, 1, "列表是只读的，不签令牌");

	await service.git.recoveryRestore({ ref: "refs/pideck/recovery/r1", oid: OID, path: "src/a.ts" }, REPO);
	await service.git.recoveryDrop({ ref: "refs/pideck/recovery/r1", oid: OID }, REPO);
	const restore = calls.find((call) => call.name === "git.recoveryRestore");
	const drop = calls.find((call) => call.name === "git.recoveryDrop");
	assert.deepEqual(restore.args, ["p2", "refs/pideck/recovery/r1", OID, "src/a.ts", "restore-token", ""], "restore 用自己的令牌");
	assert.deepEqual(drop.args, ["p2", "refs/pideck/recovery/r1", OID, "drop-token", ""], "drop 用自己的令牌");
});

test("createBranch 两种模式、checkout 读回，以及第二步失败不回滚", async () => {
	const createOnly = makeApi();
	await services(createOnly.api).git.createBranch("topic", "create", REPO);
	assert.deepEqual(names(createOnly.calls), ["git.remoteSnapshot", "git.createRemoteBranch"]);
	assert.equal(createOnly.calls[1].args[2], "branch-token");

	const both = makeApi();
	await services(both.api).git.createBranch("topic", "create-and-checkout", REPO);
	assert.deepEqual(names(both.calls), ["git.remoteSnapshot", "git.createRemoteBranch", "git.remoteSnapshot", "git.switchRemoteBranch"], "两步各取新 grant");
	assert.equal(both.calls[3].args[2], "switch-token");

	const secondFails = makeApi({ switchResult: { ok: false, code: "GIT_SWITCH_CONFLICT" } });
	await assert.rejects(() => services(secondFails.api).git.createBranch("topic", "create-and-checkout", REPO), rejectsWith("GIT_SWITCH_CONFLICT", "rejected"));
	assert.equal(secondFails.calls.filter((call) => call.name === "git.createRemoteBranch").length, 1, "分支已创建：不回滚、不重放");
	assert.equal(secondFails.calls.filter((call) => call.name === "git.switchRemoteBranch").length, 1);

	const checkout = makeApi();
	const info = await services(checkout.api).git.checkout("topic", NESTED_REPO);
	assert.deepEqual(plain(info), { current: "main", branches: ["main", "topic"] });
	assert.deepEqual(names(checkout.calls), ["git.remoteSnapshot", "git.switchRemoteBranch", "git.remoteRefs"]);
	assert.deepEqual(checkout.calls[1].args, ["p2", "topic", "switch-token", "packages/a"]);

	// 读回失败不得吞掉已确认的切换：checkout resolve（current=null），switch 只发生一次（不重放）。
	const readBackFails = makeApi();
	readBackFails.api.git.remoteRefs = async () => {
		readBackFails.calls.push({ name: "git.remoteRefs", args: [] });
		throw new Error("REMOTE_CONNECTION_LOST");
	};
	assert.deepEqual(plain(await services(readBackFails.api).git.checkout("topic", REPO)), { current: null, branches: [] });
	assert.equal(readBackFails.calls.filter((call) => call.name === "git.switchRemoteBranch").length, 1, "a confirmed switch is never replayed");
});

test("init 走 initRemote 并返回分支；失败按稳定码 rejected", async () => {
	const { api, calls } = makeApi();
	assert.deepEqual(plain(await services(api).git.init()), { branch: "main" });
	assert.deepEqual(names(calls), ["git.initRemote"]);

	const failing = makeApi({ initResult: { ok: false, code: "GIT_REPO_EXISTS" } });
	await assert.rejects(() => services(failing.api).git.init(), rejectsWith("GIT_REPO_EXISTS", "rejected"));
});

test("强刷与同 scope 的写串行：写未完成时 refresh 不会插入并撤销 grant", async () => {
	const gate = deferred();
	const { api, calls } = makeApi({ mutateDeferred: gate, snapshotOverrides: { groups: groups({ workingTree: [resource("p2", "src/a.ts")] }) } });
	const service = services(api);
	const staging = service.git.stage([TARGET], REPO);
	await waitFor(() => calls.some((call) => call.name === "git.mutateRemoteIndex"), "stage dispatch");
	const refreshing = service.git.refresh(REPO);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(names(calls), ["git.remoteSnapshot", "git.mutateRemoteIndex"], "写未完成时强刷必须等待，不得撤销在途写的 grant");
	gate.resolve({ ok: true });
	await staging;
	await refreshing;
	assert.deepEqual(names(calls), ["git.remoteSnapshot", "git.mutateRemoteIndex", "git.refreshRemoteSnapshot"], "写完成后强刷才执行");
});

test("worktree/deleteFiles 在远端仍显式 unsupported 且零调用", async () => {
	const { api, calls } = makeApi();
	const service = services(api);
	for (const action of [() => service.git.worktreeList(), () => service.git.worktreeCreate("topic"), () => service.git.worktreeRemove({ projectId: "p2", relativePath: "wt" }), () => service.git.deleteFiles([TARGET], REPO)]) {
		await assert.rejects(action, (error) => error instanceof ProjectServiceError && error.code === PROJECT_SERVICE_CODES.unsupported);
	}
	assert.deepEqual(calls, []);
});

test("能力位：远端 Git 写/分支/同步/恢复/强刷/轮询可用，autoFetch/worktree/deleteFiles 仍关", () => {
	const { api } = makeApi();
	const git = services(api).capabilities.git;
	for (const key of ["write", "branchWrite", "sync", "syncFacts", "branchRead", "aheadBehind", "recovery", "init", "forceRefresh", "statusPoll", "refsWatch"]) assert.equal(git[key], true, key);
	assert.equal(git.branchCreateMode, "both");
	for (const key of ["autoFetch", "deleteFiles", "worktree"]) assert.equal(git[key], false, key);
});
