import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteGitPanelApi } = loadTsCommonJs("src/renderer/src/utils/remoteGitPanelApi.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));
const projectId = "project";
const target = { projectId, relativePath: "one.txt" };
const groups = { merge: [], index: [], workingTree: [], untracked: [] };
const nestedScope = { projectId, relativePath: "packages/nested" };
const detail = {
	oid: "e".repeat(40),
	parents: [],
	authorName: "A",
	authorEmail: "a@e",
	authorTimeSec: 1,
	committerName: "A",
	committerEmail: "a@e",
	committerTimeSec: 1,
	subject: "s",
	message: "s\n",
	files: [],
};
const refDiff = { path: target.relativePath, target, displayPath: target.relativePath, base: null, head: detail.oid, originalContent: "old", modifiedContent: "new" };

/**
 * G4a bridge: the panel's only data entry is the project-bound service. These tests pin
 * delegation (including commit detail, revision diff and cancellation), repository scope,
 * and failure normalization (`unknown` stays unknown). The bridge never receives preload.
 */

function capabilities(overrides = {}) {
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

/** A ProjectServices-shaped fake: every call is recorded with its full argument list. */
function fakeServices(git = {}, serviceOverrides = {}) {
	const calls = [];
	const record =
		(name, implementation) =>
		async (...args) => {
			calls.push([name, ...args]);
			return implementation(...args);
		};
	const service = {
		status: record("status", async () => groups),
		refresh: record("refresh", async () => groups),
		branches: record("branches", async () => ({ current: "main", branches: ["main"] })),
		history: record("history", async () => ({ commits: [], hasMore: false })),
		repos: record("repos", async () => ({ repos: [], truncated: false, revision: 1, generation: "g" })),
		refs: record("refs", async () => []),
		compare: record("compare", async () => ({ mode: "trees", base: { ref: "refs/heads/main", oid: "a".repeat(40) }, head: { ref: "refs/heads/topic", oid: "b".repeat(40) }, files: [] })),
		commitDetail: record("commitDetail", async () => detail),
		refFileDiff: record("refFileDiff", async () => refDiff),
		cancelRemoteReads: record("cancelRemoteReads", async () => undefined),
		workspaceDiff: record("workspaceDiff", async () => ({ path: target.relativePath, target, displayPath: target.relativePath, originalContent: "old", modifiedContent: "new" })),
		createBranch: record("createBranch", async () => undefined),
		checkout: record("checkout", async () => ({ current: "topic", branches: ["main", "topic"] })),
		stage: record("stage", async () => undefined),
		unstage: record("unstage", async () => undefined),
		commit: record("commit", async () => undefined),
		discard: record("discard", async () => ({})),
		fetch: record("fetch", async () => undefined),
		pull: record("pull", async () => undefined),
		push: record("push", async () => undefined),
		syncFacts: record("syncFacts", async () => ({ branch: "main", upstream: "origin/main", ahead: 0, behind: 0, remotes: ["origin"] })),
		recoveryList: record("recoveryList", async () => ({ entries: [], truncated: false })),
		recoveryRestore: record("recoveryRestore", async () => undefined),
		recoveryDrop: record("recoveryDrop", async () => undefined),
		init: record("init", async () => ({ branch: "main" })),
		...git,
	};
	let current = true;
	const services = {
		projectId,
		kind: "remote",
		generation: "ssh:host:1:main",
		facts: { projectId, locationKind: "ssh", hostId: "host", hostState: "ready", rootStatus: "ok", trust: "approved", generation: "ssh:host:1:main" },
		capabilities: { projectId, locationKind: "ssh", generation: "ssh:host:1:main", trust: "approved", files: {}, git: capabilities(), blocked: {} },
		isCurrent: () => current,
		refresh: async () => undefined,
		...serviceOverrides,
		git: service,
	};
	return { services, calls, setCurrent: (value) => (current = value) };
}

test("status/refresh delegate to the project-bound service and name the repository scope", async () => {
	const { services, calls } = fakeServices();
	const api = createRemoteGitPanelApi(services);
	const root = await api.status();
	assert.deepEqual(plain(root), { ok: true, snapshot: { groups, head: null, branch: "main" } });
	assert.deepEqual(plain(calls[0]), ["status", null], "the fact read comes first; the root scope passes no repo target");
	assert.deepEqual(plain(calls[1]), ["branches", null]);

	const scoped = await api.status("packages/nested");
	assert.equal(scoped.snapshot.branch, "main");
	assert.deepEqual(plain(calls.at(-2)), ["status", nestedScope], "a nested scope is a project-relative target");
	assert.deepEqual(plain(calls.at(-1)), ["branches", nestedScope]);

	await api.refresh("packages/nested");
	assert.deepEqual(plain(calls.at(-2)), ["refresh", nestedScope], "force refresh goes through ProjectGitService.refresh");
	assert.equal(calls.at(-1)[0], "branches");
});

test("a branch read failure keeps the facts and reports the branch as unknown", async () => {
	const { services } = fakeServices({
		branches: async () => {
			throw Object.assign(new Error("branch read failed"), { code: "GIT_REF_NOT_FOUND", outcome: "rejected" });
		},
	});
	const api = createRemoteGitPanelApi(services);
	const result = await api.status();
	assert.equal(result.ok, true, "the groups read succeeded: it must not be replaced by the branch failure");
	assert.deepEqual(plain(result.snapshot.groups), groups);
	assert.equal(result.snapshot.branch, null);
	// The capability says branchRead is closed: zero branch calls, still a successful fact read.
	const closed = fakeServices({}, { capabilities: { projectId, locationKind: "ssh", generation: "g", trust: "approved", files: {}, git: capabilities({ branchRead: false }), blocked: {} } });
	const closedApi = createRemoteGitPanelApi(closed.services);
	await closedApi.status();
	assert.deepEqual(
		closed.calls.map((call) => call[0]),
		["status"],
		"a closed branchRead capability never calls branches",
	);
});

test("service failures keep their stable code, and an unknown write stays unknown", async () => {
	const refused = fakeServices({
		commit: async () => {
			throw Object.assign(new Error("Trust required"), { code: "GIT_TRUST_REQUIRED", outcome: "rejected" });
		},
	});
	const api = createRemoteGitPanelApi(refused.services);
	const rejected = await api.commit("subject");
	assert.equal(rejected.ok, false);
	assert.equal(rejected.code, "GIT_TRUST_REQUIRED");
	assert.equal(rejected.outcome, "rejected");

	let commitCalls = 0;
	const unknown = fakeServices({
		commit: async () => {
			commitCalls += 1;
			throw Object.assign(new Error("socket closed"), { code: "GIT_WRITE_RESULT_UNCONFIRMED", outcome: "unknown" });
		},
	});
	const unknownApi = createRemoteGitPanelApi(unknown.services);
	const unconfirmed = await unknownApi.commit("subject");
	assert.equal(unconfirmed.ok, false);
	assert.equal(unconfirmed.code, "GIT_WRITE_RESULT_UNCONFIRMED", "an unknown outcome never degrades to a definite failure");
	assert.equal(unconfirmed.outcome, "unknown");
	assert.equal(commitCalls, 1, "the write is reported once and never replayed");
});

test("raw non-service failures reduce to the bounded code regex (no invoke wrapper, no free text)", async () => {
	const raw = fakeServices({
		status: async () => {
			throw new Error("Error invoking remote method 'git:status': Error: GIT_NOT_REPOSITORY");
		},
	});
	const rawApi = createRemoteGitPanelApi(raw.services);
	const result = await rawApi.status();
	assert.deepEqual(plain({ ok: result.ok, code: result.code }), { ok: false, code: "GIT_NOT_REPOSITORY" });

	const unknownMessage = fakeServices({
		status: async () => {
			throw new Error("GIT_WRITE_RESULT_UNCONFIRMED");
		},
	});
	const unknownApi = createRemoteGitPanelApi(unknownMessage.services);
	const unknownResult = await unknownApi.status();
	assert.equal(unknownResult.code, "GIT_WRITE_RESULT_UNCONFIRMED");
	assert.equal(unknownResult.outcome, "unknown", "the closed unknown-code set decides the outcome");

	const opaque = fakeServices({
		status: async () => {
			throw new Error("socket closed");
		},
	});
	const opaqueApi = createRemoteGitPanelApi(opaque.services);
	assert.equal((await opaqueApi.status()).code, "GIT_COMMAND_FAILED", "a neutral fallback, not remote failure prose");
});

test("stage/unstage/commit/discard delegate the exact target list and repository scope", async () => {
	const { services, calls } = fakeServices();
	const api = createRemoteGitPanelApi(services);
	assert.deepEqual(plain(await api.mutateIndex("stage", "workingTree", target, "packages/nested")), { ok: true });
	assert.deepEqual(plain(calls.at(-1)), ["stage", [target], nestedScope]);
	assert.deepEqual(plain(await api.mutateIndex("unstage", "index", target)), { ok: true });
	assert.deepEqual(plain(calls.at(-1)), ["unstage", [target], null]);
	assert.deepEqual(plain(await api.commit("subject\n")), { ok: true });
	assert.deepEqual(plain(calls.at(-1)), ["commit", "subject\n", null]);
	assert.deepEqual(plain(await api.discard("workingTree", target)), { ok: true, recoveryRef: null });
	assert.deepEqual(plain(calls.at(-1)), ["discard", [{ group: "workingTree", target }], null]);
});

test("a discard keeps the recovery ref the provider returned", async () => {
	const ref = "refs/pideck/recovery/20261016120000-ab12cd34";
	const { services } = fakeServices({ discard: async () => ({ recoveryRef: ref }) });
	const api = createRemoteGitPanelApi(services);
	assert.deepEqual(plain(await api.discard("untracked", target)), { ok: true, recoveryRef: ref });
});

test("branch creation mode comes from the capability table and switch uses checkout", async () => {
	const remote = fakeServices();
	const remoteApi = createRemoteGitPanelApi(remote.services);
	await remoteApi.createBranch("feature/one");
	assert.deepEqual(plain(remote.calls.at(-1)), ["createBranch", "feature/one", "create", null], "a remote create never silently checks out");

	const local = fakeServices({}, { capabilities: { projectId, kind: "local", generation: "local", trust: "none", files: {}, git: capabilities({ branchCreateMode: "create-and-checkout" }), blocked: {} } });
	const localApi = createRemoteGitPanelApi(local.services);
	await localApi.createBranch("feature/one");
	assert.deepEqual(plain(local.calls.at(-1)), ["createBranch", "feature/one", "create-and-checkout", null], "the local provider only supports create-and-checkout");

	assert.deepEqual(plain(await remoteApi.switchBranch("topic")), { ok: true });
	assert.deepEqual(plain(remote.calls.at(-1)), ["checkout", "topic", null]);
});

test("refs map GitRef{hash,type} onto the panel's RemoteGitRef{oid,kind}", async () => {
	const hash = "c".repeat(40);
	const { services } = fakeServices({
		refs: async () => [
			{ name: "main", fullName: "refs/heads/main", hash, type: "head" },
			{ name: "origin/main", fullName: "refs/remotes/origin/main", hash, type: "remote" },
			{ name: "v1.0", fullName: "refs/tags/v1.0", hash, type: "tag" },
		],
	});
	const api = createRemoteGitPanelApi(services);
	const result = await api.refs();
	assert.deepEqual(plain(result), {
		ok: true,
		refs: {
			head: null,
			branch: null,
			refs: [
				{ fullName: "refs/heads/main", name: "main", oid: hash, kind: "branch" },
				{ fullName: "refs/remotes/origin/main", name: "origin/main", oid: hash, kind: "branch" },
				{ fullName: "refs/tags/v1.0", name: "v1.0", oid: hash, kind: "tag" },
			],
		},
	});
});

test("compare/history/syncFacts/recovery/init/repos are wrapped in the existing envelopes", async () => {
	const { services, calls } = fakeServices();
	const api = createRemoteGitPanelApi(services);
	const compare = await api.compareRefs("refs/heads/main", "refs/heads/topic", "packages/nested");
	assert.equal(compare.ok, true);
	assert.equal(compare.value.mode, "trees");
	assert.deepEqual(plain(calls.at(-1)), ["compare", "refs/heads/main", "refs/heads/topic", nestedScope]);

	const history = await api.historyPage({ maxCount: 50 });
	assert.deepEqual(plain(history), { ok: true, value: { commits: [], hasMore: false } });
	assert.deepEqual(plain(calls.at(-1)), ["history", { maxCount: 50 }, null]);

	const facts = await api.syncFacts();
	assert.deepEqual(plain(facts), { ok: true, facts: { branch: "main", upstream: "origin/main", ahead: 0, behind: 0, remotes: ["origin"] } });

	assert.deepEqual(plain(await api.recoveryList()), { ok: true, entries: [], truncated: false });
	assert.deepEqual(plain(calls.at(-1)), ["recoveryList", null]);
	assert.deepEqual(plain(await api.recoveryRestore("refs/pideck/recovery/x", "d".repeat(40), "one.txt", "packages/nested")), { ok: true });
	assert.deepEqual(plain(calls.at(-1)), ["recoveryRestore", { ref: "refs/pideck/recovery/x", oid: "d".repeat(40), path: "one.txt" }, nestedScope]);
	assert.deepEqual(plain(await api.recoveryDrop("refs/pideck/recovery/x", "d".repeat(40))), { ok: true });
	assert.deepEqual(plain(calls.at(-1)), ["recoveryDrop", { ref: "refs/pideck/recovery/x", oid: "d".repeat(40) }, null]);

	const init = await api.init();
	assert.deepEqual(plain(init), { ok: true, branch: "main" });
	const repos = await api.repos();
	assert.equal(repos.truncated, false);
	assert.deepEqual(calls.at(-1), ["repos"]);
});

test("workspaceFileDiff returns the service diff and throws the stable code on failure", async () => {
	const { services } = fakeServices();
	const api = createRemoteGitPanelApi(services);
	const diff = await api.workspaceFileDiff("workingTree", target);
	assert.equal(diff.originalContent, "old");
	const failing = fakeServices({
		workspaceDiff: async () => {
			throw Object.assign(new Error("hidden"), { code: "GIT_NOT_TEXT", outcome: "rejected" });
		},
	});
	const failingApi = createRemoteGitPanelApi(failing.services);
	await assert.rejects(failingApi.workspaceFileDiff("workingTree", target), (error) => error.message === "GIT_NOT_TEXT");
});

test("explicit sync re-checks the facts and refuses a remote/branch it does not have", async () => {
	const { services, calls } = fakeServices();
	const api = createRemoteGitPanelApi(services);
	assert.deepEqual(plain(await api.fetch("origin", "packages/nested")), { ok: true });
	assert.deepEqual(plain(calls.at(-1)), ["fetch", nestedScope], "only the provider verb is called after the check");

	const unknown = await api.fetch("elsewhere");
	assert.equal(unknown.ok, false);
	assert.equal(unknown.code, "GIT_SYNC_REMOTE_UNKNOWN");
	assert.equal(calls.filter((call) => call[0] === "fetch").length, 1, "an unknown remote never reaches the network verb");

	const branchChanged = await api.push("origin", "other");
	assert.equal(branchChanged.code, "GIT_RESOURCE_CHANGED");
	assert.equal(calls.filter((call) => call[0] === "push").length, 0, "a branch that is not checked out is never pushed");
	assert.deepEqual(plain(await api.push("origin", "main")), { ok: true });
	assert.deepEqual(plain(calls.at(-1)), ["push", null]);
	assert.deepEqual(plain(await api.pull("origin", "main")), { ok: true });
	assert.deepEqual(plain(calls.at(-1)), ["pull", null]);
});

test("commit detail, revision file diff and read cancellation now delegate only to ProjectGitService", async () => {
	const { services, calls } = fakeServices();
	const api = createRemoteGitPanelApi(services);
	const oid = "e".repeat(40);
	const detailResult = await api.commitDetail(oid, "packages/nested");
	assert.equal(detailResult.ok, true);
	assert.deepEqual(plain(calls.at(-1)), ["commitDetail", oid, nestedScope]);

	const diffResult = await api.refFileDiff(null, oid, target);
	assert.equal(diffResult.ok, true);
	assert.deepEqual(plain(calls.at(-1)), ["refFileDiff", null, oid, target, null]);

	await api.cancelRemoteReads();
	assert.deepEqual(calls.at(-1), ["cancelRemoteReads"]);
});

test("the bridge preserves a stale service generation as a rejected result and cancel remains best-effort", async () => {
	const stale = Object.assign(new Error("stale"), { code: "PROJECT_SERVICE_GENERATION_STALE", outcome: "rejected" });
	const calls = [];
	const { services } = fakeServices({
		commitDetail: async () => {
			calls.push("commitDetail");
			throw stale;
		},
		refFileDiff: async () => {
			calls.push("refFileDiff");
			throw stale;
		},
		cancelRemoteReads: async () => {
			calls.push("cancelRemoteReads");
			throw stale;
		},
	});
	const api = createRemoteGitPanelApi(services);
	const detail = await api.commitDetail("f".repeat(40));
	assert.equal(detail.ok, false);
	assert.equal(detail.code, "PROJECT_SERVICE_GENERATION_STALE");
	assert.equal((await api.refFileDiff(null, "f".repeat(40), target)).code, "PROJECT_SERVICE_GENERATION_STALE");
	await api.cancelRemoteReads();
	assert.deepEqual(calls, ["commitDetail", "refFileDiff", "cancelRemoteReads"], "cancel is attempted only through the service and its failure is intentionally swallowed");
});
