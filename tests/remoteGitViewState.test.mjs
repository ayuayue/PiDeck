import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteGitViewController } = loadTsCommonJs("src/renderer/src/utils/remoteGitViewState.ts");
const projectId = "project";
const target = { projectId, relativePath: "file.txt" };
const groups = { merge: [], index: [], workingTree: [], untracked: [] };
/** What the panel API answers for one read: the service bridge maps groups + branch and never a token. */
const snapshot = { head: null, branch: "main", groups };
const branchInfo = { current: "main", branches: ["main"] };
const plain = (value) => JSON.parse(JSON.stringify(value));
const oid = (char) => char.repeat(40);
function deferred() {
	let resolve;
	const promise = new Promise((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}
function fixture(api = {}) {
	const states = [];
	const reads = createRemoteGitViewController(
		projectId,
		"identity",
		{
			cancelRemoteReads: async () => {},
			status: async () => ({ ok: true, snapshot }),
			refresh: async () => ({ ok: true, snapshot }),
			branches: async () => ({ ok: true, info: branchInfo }),
			workspaceFileDiff: async () => ({ target, path: target.relativePath, displayPath: target.relativePath, originalContent: "old", modifiedContent: "new" }),
			...api,
		},
		(state) => states.push(state),
	);
	return { reads, states, current: () => states.at(-1) };
}

test("remote Git refresh exposes the groups and the branch and performs no implicit write", async () => {
	const writes = [];
	let reads = 0;
	const f = fixture({
		status: async () => {
			reads += 1;
			return { ok: true, snapshot };
		},
		mutateIndex: async (...args) => {
			writes.push(args);
			return { ok: true };
		},
		commit: async (...args) => {
			writes.push(args);
			return { ok: true };
		},
	});
	await f.reads.refresh();
	assert.deepEqual(plain(f.current().snapshot.groups), groups);
	assert.equal(f.current().snapshot.branch, "main");
	assert.equal(f.current().snapshot.head, undefined, "the panel snapshot has no head field");
	assert.equal(reads, 1);
	assert.equal(f.reads.stage, undefined, "no convenience alias may act without an explicit call");
	assert.deepEqual(writes, [], "a refresh never writes; both write actions stay explicit and separate");
	// An empty commit message is refused locally; main re-validates the same rule.
	await f.reads.commit("message\n");
	assert.equal(writes.length, 1, "a valid commit is a write the user explicitly asked for");
	await f.reads.commit("   \n");
	await f.reads.commit("");
	assert.equal(writes.length, 1, "an empty message never reaches the write API");
});

test("concurrent refresh cannot start a second read", async () => {
	const pending = deferred();
	let count = 0;
	const f = fixture({
		status: () => {
			count++;
			return pending.promise;
		},
	});
	const first = f.reads.refresh();
	await f.reads.refresh();
	assert.equal(count, 1);
	pending.resolve({ ok: true, snapshot });
	await first;
});

test("failed refresh clears previous facts instead of showing stale clean status", async () => {
	let count = 0;
	const f = fixture({
		status: async () => (++count === 1 ? { ok: true, snapshot } : { ok: false, code: "SSH_HOST_DISCONNECTED" }),
	});
	await f.reads.refresh();
	await f.reads.refresh();
	assert.equal(f.current().snapshot, undefined);
	assert.equal(f.current().errorCode, "SSH_HOST_DISCONNECTED");
});

test("unmount/project change discards a late status result", async () => {
	const pending = deferred();
	const f = fixture({ status: () => pending.promise });
	const request = f.reads.refresh();
	f.reads.dispose();
	pending.resolve({ ok: true, snapshot });
	await request;
	assert.equal(f.states.length, 1);
	assert.equal(f.current().snapshot, undefined);
});

test("connection invalidation clears facts and discards in-flight success without refreshing", async () => {
	const pending = deferred();
	const f = fixture({ status: () => pending.promise });
	const request = f.reads.refresh();
	f.reads.invalidateConnection();
	pending.resolve({ ok: true, snapshot });
	await request;
	assert.equal(f.current().snapshot, undefined);
	assert.equal(f.current().errorCode, "REMOTE_CONNECTION_LOST");
});

test("single diff flight retains group semantics and prevents overlapping refresh or close", async () => {
	const pending = deferred();
	const f = fixture({ workspaceFileDiff: () => pending.promise });
	await f.reads.refresh();
	const request = f.reads.openDiff("index", target);
	assert.equal(f.current().diffLoading, true);
	assert.equal(f.current().diffGroup, "index");
	await f.reads.refresh();
	f.reads.closeDiff();
	assert.equal(f.current().diffLoading, true);
	pending.resolve({ target, path: target.relativePath, displayPath: target.relativePath, originalContent: "old", modifiedContent: "new" });
	await request;
	assert.equal(f.current().diff.originalContent, "old");
	f.reads.closeDiff();
	assert.equal(f.current().diff, undefined);
});

test("invalid diff identity and cross-project targets cannot enter the view", async () => {
	let calls = 0;
	const f = fixture({
		workspaceFileDiff: async () => {
			calls++;
			return { target: { projectId: "other", relativePath: target.relativePath } };
		},
	});
	await f.reads.refresh();
	await f.reads.openDiff("index", { ...target, projectId: "other" });
	assert.equal(calls, 0);
	await f.reads.openDiff("index", target);
	assert.equal(f.current().diff, undefined);
	assert.equal(f.current().diffErrorCode, "GIT_RESOURCE_CHANGED");
});

test("invoke diagnostics reduce to a stable code rather than leaking remote details", async () => {
	const f = fixture({
		workspaceFileDiff: async () => {
			throw new Error("Error invoking remote method 'git:workspace-file-diff': Error: GIT_NOT_TEXT");
		},
	});
	await f.reads.refresh();
	await f.reads.openDiff("workingTree", target);
	assert.equal(f.current().diffErrorCode, "GIT_NOT_TEXT");
});

const historyRow = (value, subject) => ({ oid: value, parents: [oid("2")], authorName: "A", authorEmail: "a@e.invalid", authorTimeMs: 1_700_000_000_000, subject });
const detailFor = (value) => ({ oid: value, parents: [oid("2")], authorName: "A", authorEmail: "a@e.invalid", authorTimeSec: 1700000000, committerName: "A", committerEmail: "a@e.invalid", committerTimeSec: 1700000000, subject: "s", message: "s\n", files: [{ status: "M", path: "file.txt" }] });

test("history pages append on demand and a failed page keeps the rows already on screen", async () => {
	const calls = [];
	let failOnce = true;
	const f = fixture({
		historyPage: async (...args) => {
			calls.push(args);
			return calls.length === 1 ? { ok: true, value: { commits: [historyRow(oid("1"), "first")], hasMore: true } } : failOnce ? { ok: false, code: "GIT_COMMAND_FAILED" } : { ok: true, value: { commits: [historyRow(oid("3"), "second")], hasMore: false } };
		},
	});
	await f.reads.loadHistory();
	assert.deepEqual(plain(calls), [[{ maxCount: 50 }, ""]]);
	assert.equal(f.current().history.commits.length, 1);
	assert.equal(f.current().history.hasMore, true);
	await f.reads.loadMoreHistory();
	assert.deepEqual(plain(calls.at(-1)), [{ maxCount: 50, skip: 1 }, ""]);
	assert.equal(f.current().history.commits.length, 1, "a failed page keeps the visible rows");
	assert.equal(f.current().historyErrorCode, "GIT_COMMAND_FAILED");
	failOnce = false;
	await f.reads.loadMoreHistory();
	assert.deepEqual(plain(f.current().history.commits.map((commit) => commit.subject)), ["first", "second"]);
	assert.equal(f.current().history.hasMore, false);
	assert.equal(f.current().historyErrorCode, undefined);
	// With no next page there is no further flight, however often the button is pressed.
	await f.reads.loadMoreHistory();
	assert.equal(calls.length, 3);
});

test("a refresh drops history, refs and detail facts without reloading them", async () => {
	const calls = [];
	const f = fixture({
		historyPage: async (...args) => {
			calls.push(args);
			return { ok: true, value: { commits: [historyRow(oid("1"), "first")], hasMore: false } };
		},
		refs: async () => {
			calls.push(["refs"]);
			return { ok: true, refs: { head: null, branch: "main", refs: [{ fullName: "refs/heads/main", name: "main", oid: oid("1"), kind: "branch" }] } };
		},
		commitDetail: async (...args) => {
			calls.push(args);
			return { ok: true, detail: detailFor(oid("1")) };
		},
	});
	await f.reads.loadHistory();
	await f.reads.loadRefs();
	await f.reads.openCommitDetail(oid("1"));
	assert.ok(f.current().history && f.current().refs && f.current().detail);
	await f.reads.refresh();
	assert.equal(f.current().history, undefined, "facts die with the snapshot facts; the panel never mixes generations");
	assert.equal(f.current().refs, undefined);
	assert.equal(f.current().detail, undefined);
	assert.equal(f.current().detailOid, undefined);
	assert.equal(calls.length, 3, "the refresh itself reloads nothing");
});

test("a silent status refresh updates facts without dropping diff, history, refs or the selection", async () => {
	// P0-3：5 秒轮询必须走 refreshStatus，而不是 refresh——后者会整体替换 state（loading=true）
	// 并清掉 history/refs/diff 与选中行，等于每隔 5 秒把用户正在看的东西收走一次。
	// 分支随事实读一起回来（`git.status` 的答案里就有），不再是单独一次 branches 往返。
	let branch = "main";
	const f = fixture({
		status: async () => ({ ok: true, snapshot: { ...snapshot, branch } }),
		refresh: async () => ({ ok: true, snapshot: { ...snapshot, branch } }),
		historyPage: async () => ({ ok: true, value: { commits: [historyRow(oid("1"), "first")], hasMore: false } }),
		refs: async () => ({ ok: true, refs: { head: null, branch: "main", refs: [] } }),
		commitDetail: async (value) => ({ ok: true, detail: detailFor(value) }),
	});
	await f.reads.refresh();
	await f.reads.loadHistory();
	await f.reads.loadRefs();
	await f.reads.openCommitDetail(oid("1"));
	await f.reads.openDiff("index", target);
	const before = f.current();

	branch = "feature";
	await f.reads.refreshStatus();
	const after = f.current();
	// 静默 tick 只刷新事实：分支是展示信息，沿用上次确认值；分支变化由显式刷新带回（见本用例末尾）。
	assert.equal(after.snapshot.branch, "main");
	assert.deepEqual(plain(after.snapshot.groups), plain(before.snapshot.groups));
	assert.equal(after.loading, false, "a silent tick never flashes loading");
	assert.equal(after.diffLoading, false);
	assert.deepEqual(plain(after.history), plain(before.history), "history rows stay");
	assert.deepEqual(plain(after.refs), plain(before.refs), "refs stay");
	assert.equal(after.detailOid, oid("1"), "the selected commit stays selected");
	assert.deepEqual(plain(after.diff), plain(before.diff), "an open diff stays open");
	await f.reads.refresh();
	assert.equal(f.current().snapshot.branch, "feature", "an explicit refresh brings the new branch back");
});

test("a connection invalidation pauses the silent status refresh until a successful explicit refresh", async () => {
	// 语义来源：显式重连不得自己重放一次读（e2e 断言「重连后 workingTree 仍为 0，用户点刷新才出现」）。
	// 暂停位由 invalidateConnection 置上；只有一次成功快照读的 refresh() 才解除。
	let result = { ok: true, snapshot };
	let reads = 0;
	const read = async () => {
		reads += 1;
		return result;
	};
	const f = fixture({ status: read, refresh: read, branches: async () => ({ ok: true, info: { current: result.ok ? result.snapshot.branch : null, branches: [] } }) });
	await f.reads.refresh();
	assert.equal(reads, 1);

	f.reads.invalidateConnection();
	await f.reads.refreshStatus();
	assert.equal(reads, 1, "被作废的连接不得自己读回来");

	result = { ok: false, code: "SSH_HOST_DISCONNECTED" };
	await f.reads.refresh();
	assert.equal(reads, 2, "显式刷新只读它自己那一次");
	await f.reads.refreshStatus();
	assert.equal(reads, 2, "失败的显式刷新不解除暂停");

	result = { ok: true, snapshot: { ...snapshot, branch: "feature" } };
	await f.reads.refresh();
	assert.equal(reads, 3);
	await f.reads.refreshStatus();
	assert.equal(reads, 4, "成功的显式刷新之后静默轮询恢复");
	assert.equal(f.current().snapshot.branch, "feature");
});

test("commit detail answers the last click, and an answer for another commit is refused", async () => {
	const f = fixture({ commitDetail: async (value) => ({ ok: true, detail: detailFor(value) }) });
	await Promise.all([f.reads.openCommitDetail(oid("a")), f.reads.openCommitDetail(oid("b"))]);
	assert.equal(f.current().detailOid, oid("b"));
	assert.equal(f.current().detail.oid, oid("b"));
	const swapped = fixture({ commitDetail: async () => ({ ok: true, detail: detailFor(oid("c")) }) });
	await swapped.reads.openCommitDetail(oid("b"));
	assert.equal(swapped.current().detail, undefined);
	assert.equal(swapped.current().detailErrorCode, "GIT_RESOURCE_CHANGED");
});

test("a refused or crashed detail read reports its own code and keeps the selection", async () => {
	const f = fixture({ commitDetail: async () => ({ ok: false, code: "GIT_OBJECT_NOT_FOUND" }) });
	await f.reads.openCommitDetail(oid("b"));
	assert.equal(f.current().detailOid, oid("b"));
	assert.equal(f.current().detailErrorCode, "GIT_OBJECT_NOT_FOUND");
	const thrown = fixture({
		commitDetail: async () => {
			throw new Error("invoke failed with SSH_HOST_DISCONNECTED");
		},
	});
	await thrown.reads.openCommitDetail(oid("b"));
	assert.equal(thrown.current().detailErrorCode, "SSH_HOST_DISCONNECTED");
});

test("refs load once at a time and a late answer after invalidation is discarded", async () => {
	let resolve;
	const f = fixture({
		refs: async () =>
			new Promise((accept) => {
				resolve = accept;
			}),
	});
	const pending = f.reads.loadRefs();
	assert.equal(f.current().refsLoading, true);
	await f.reads.loadRefs();
	f.reads.invalidateConnection();
	resolve({ ok: true, refs: { head: null, branch: "main", refs: [] } });
	await pending;
	assert.equal(f.current().refs, undefined, "an answer from before the connection loss cannot publish");
	assert.equal(f.current().errorCode, "REMOTE_CONNECTION_LOST");
});

test("a revision file diff uses the shared diff surface and its identity is checked", async () => {
	const calls = [];
	const f = fixture({
		refFileDiff: async (base, head, fileTarget, repo) => {
			calls.push([base, head, fileTarget, repo]);
			return { ok: true, diff: { path: fileTarget.relativePath, target: fileTarget, displayPath: fileTarget.relativePath, base, head, originalContent: "old side", modifiedContent: "new side" } };
		},
	});
	await f.reads.refresh();
	await f.reads.openHistoryFileDiff(oid("a"), oid("b"), target);
	assert.deepEqual(plain(calls), [[oid("a"), oid("b"), target, ""]]);
	assert.equal(f.current().diffKind, "revision");
	assert.equal(f.current().diff.originalContent, "old side");
	assert.equal(f.current().diffGroup, undefined);
	// A workspace diff replaces the revision diff on the same surface.
	await f.reads.closeDiff();
	await f.reads.openDiff("workingTree", target);
	assert.equal(f.current().diffKind, "workspace");
	// A target from another project never starts a flight.
	calls.length = 0;
	await f.reads.closeDiff();
	await f.reads.openHistoryFileDiff(oid("a"), oid("b"), { projectId: "other", relativePath: "file.txt" });
	assert.deepEqual(calls, []);
	// An answer for a different file is a refusal, not a substitute diff.
	const swapped = fixture({
		refFileDiff: async (_base, _head, _target, _repo) => ({ ok: true, diff: { path: "other.txt", target: { projectId, relativePath: "other.txt" }, displayPath: "other.txt", base: oid("a"), head: oid("b"), originalContent: "x", modifiedContent: "y" } }),
	});
	await swapped.reads.refresh();
	await swapped.reads.openHistoryFileDiff(oid("a"), oid("b"), target);
	assert.equal(swapped.current().diff, undefined);
	assert.equal(swapped.current().diffErrorCode, "GIT_RESOURCE_CHANGED");
});

test("creating a branch calls the provider once, refreshes only after confirmation and never replays an unknown result", async () => {
	const calls = [];
	let resolve;
	const f = fixture({
		createBranch: async (...args) => {
			calls.push(args);
			return new Promise((accept) => {
				resolve = accept;
			});
		},
	});
	await f.reads.refresh();
	const pending = f.reads.createBranch("feature/one");
	assert.equal(f.current().mutating, true);
	assert.equal(f.current().mutatingKind, "branch");
	// One action at a time: a second click while the first is in flight never reaches the API.
	await f.reads.createBranch("feature/two");
	assert.equal(calls.length, 1);
	assert.deepEqual(plain(calls[0]), ["feature/one", ""], "the capability, not a token, is what unlocks the action");
	resolve({ ok: true });
	await pending;
	assert.equal(f.current().mutating, undefined);
	// A refusal reports its own code and drops the facts.
	const refused = fixture({ createBranch: async () => ({ ok: false, code: "GIT_REF_EXISTS" }) });
	await refused.reads.refresh();
	await refused.reads.createBranch("taken");
	assert.equal(refused.current().errorCode, "GIT_REF_EXISTS");
	assert.equal(refused.current().snapshot, undefined);
	// An unknown outcome is a warning, not a success, and is never replayed.
	let attempts = 0;
	const unknown = fixture({
		createBranch: async () => {
			attempts += 1;
			return { ok: false, code: "GIT_WRITE_RESULT_UNCONFIRMED" };
		},
	});
	await unknown.reads.refresh();
	await unknown.reads.createBranch("maybe");
	assert.equal(unknown.current().errorCode, "GIT_WRITE_RESULT_UNCONFIRMED");
	assert.equal(attempts, 1, "an unknown outcome is never retried");
});

test("an invalid branch name or the already checked-out branch never reaches the API", async () => {
	const calls = [];
	const f = fixture({
		createBranch: async (...args) => {
			calls.push(args);
			return { ok: true };
		},
		switchBranch: async (...args) => {
			calls.push(args);
			return { ok: true };
		},
	});
	await f.reads.refresh();
	for (const name of ["", "@", "-feature", "HEAD", "FETCH_HEAD", "refs/heads/x", "a@{b}", "a\\b", "x".repeat(1025), "d".repeat(40)]) await f.reads.createBranch(name);
	await f.reads.switchBranch("main");
	assert.deepEqual(calls, [], "names main would refuse and the branch already current are refused locally");
});

test("switching calls the provider, refreshes on confirmation and reports a conflict without touching facts twice", async () => {
	const calls = [];
	const f = fixture({
		switchBranch: async (...args) => {
			calls.push(args);
			return { ok: true };
		},
	});
	await f.reads.refresh();
	await f.reads.switchBranch("feature");
	assert.deepEqual(plain(calls), [["feature", ""]]);
	// The confirmed switch re-read the repository, so the next action works from fresh facts.
	const readsBefore = f.states.filter((entry) => entry.snapshot !== undefined).length;
	await f.reads.switchBranch("feature");
	assert.equal(calls.length, 2);
	assert.ok(f.states.filter((entry) => entry.snapshot !== undefined).length > readsBefore, "a confirmed switch re-reads the repository");
	const conflict = fixture({ switchBranch: async () => ({ ok: false, code: "GIT_SWITCH_CONFLICT" }) });
	await conflict.reads.refresh();
	await conflict.reads.switchBranch("feature");
	assert.equal(conflict.current().errorCode, "GIT_SWITCH_CONFLICT");
	assert.equal(conflict.current().mutating, undefined);
});

const discardGroups = { merge: [], index: [], workingTree: [{ target, path: target.relativePath, displayPath: target.relativePath, status: 5, letter: "M" }], untracked: [{ target: { projectId, relativePath: "junk.txt" }, path: "junk.txt", displayPath: "junk.txt", status: 7, letter: "?" }] };

test("discarding a file asks the provider for the backup, keeps the recovery ref and re-reads the repository", async () => {
	const calls = [];
	const f = fixture({
		status: async () => ({ ok: true, snapshot: { ...snapshot, groups: discardGroups } }),
		discard: async (...args) => {
			calls.push(args);
			return { ok: true, recoveryRef: "refs/pideck/recovery/20261016120000-ab12cd34" };
		},
	});
	await f.reads.refresh();
	await f.reads.discard("workingTree", target);
	assert.deepEqual(plain(calls), [["workingTree", target, ""]]);
	assert.deepEqual(plain(f.current().discardRecovery), { ref: "refs/pideck/recovery/20261016120000-ab12cd34", path: "file.txt" });
	// The note is what tells the user how to get the bytes back, so a later read must not erase it.
	await f.reads.refresh();
	assert.ok(f.current().discardRecovery, "the recovery note survives a refresh");
	// A second discard replaces the note instead of accumulating stale ones.
	await f.reads.discard("untracked", { projectId, relativePath: "junk.txt" });
	assert.deepEqual(plain(f.current().discardRecovery), { ref: "refs/pideck/recovery/20261016120000-ab12cd34", path: "junk.txt" });
	assert.deepEqual(plain(calls.at(-1)), ["untracked", { projectId, relativePath: "junk.txt" }, ""]);
});

test("a discard that has nothing to back up reports that honestly", async () => {
	const f = fixture({ status: async () => ({ ok: true, snapshot: { ...snapshot, groups: discardGroups } }), discard: async () => ({ ok: true, recoveryRef: null }) });
	await f.reads.refresh();
	await f.reads.discard("workingTree", target);
	assert.deepEqual(plain(f.current().discardRecovery), { ref: null, path: "file.txt" });
	assert.equal(f.current().errorCode, undefined);
});

test("a refused or unknown discard drops the facts, keeps the warning and is never replayed", async () => {
	const refused = fixture({ status: async () => ({ ok: true, snapshot: { ...snapshot, groups: discardGroups } }), discard: async () => ({ ok: false, code: "RESULT_TOO_LARGE" }) });
	await refused.reads.refresh();
	await refused.reads.discard("workingTree", target);
	assert.equal(refused.current().errorCode, "RESULT_TOO_LARGE");
	assert.equal(refused.current().snapshot, undefined, "a refusal drops facts rather than showing a half-true tree");
	assert.equal(refused.current().discardRecovery, undefined);
	let attempts = 0;
	const unknown = fixture({
		status: async () => ({ ok: true, snapshot: { ...snapshot, groups: discardGroups } }),
		discard: async () => {
			attempts += 1;
			throw new Error("socket closed");
		},
	});
	await unknown.reads.refresh();
	await unknown.reads.discard("workingTree", target);
	assert.equal(unknown.current().errorCode, "GIT_WRITE_RESULT_UNCONFIRMED");
	assert.equal(unknown.current().discardRecovery, undefined, "an unknown outcome promises no backup");
	assert.equal(attempts, 1, "an unknown discard is never replayed");
});

test("a discard with the wrong group or for another project never reaches the API", async () => {
	const calls = [];
	const f = fixture({
		status: async () => ({ ok: true, snapshot: { ...snapshot, groups: discardGroups } }),
		discard: async (...args) => {
			calls.push(args);
			return { ok: true, recoveryRef: null };
		},
	});
	await f.reads.refresh();
	await f.reads.discard("index", target);
	await f.reads.discard("workingTree", { projectId: "other", relativePath: "file.txt" });
	await f.reads.discard("workingTree", { projectId, relativePath: "not-in-snapshot.txt" });
	assert.deepEqual(calls, []);
	// One action at a time: the second click while the first is in flight is ignored.
	const busy = fixture({
		status: async () => ({ ok: true, snapshot: { ...snapshot, groups: discardGroups } }),
		discard: async (...args) => {
			calls.push(args);
			return new Promise(() => {});
		},
	});
	await busy.reads.refresh();
	void busy.reads.discard("workingTree", target);
	await busy.reads.discard("workingTree", target);
	assert.equal(calls.length, 1);
});

const recoveryEntry = { ref: "refs/pideck/recovery/20261016120000-ab12cd34", oid: "e".repeat(40), path: "file.txt", bytes: 2048, at: 1792138005 };

test("the recovery listing loads on demand and its truncation flag travels with it", async () => {
	const calls = [];
	const f = fixture({
		recoveryList: async (...args) => {
			calls.push(args);
			return { ok: true, entries: [recoveryEntry], truncated: true };
		},
	});
	await f.reads.loadRecovery();
	assert.deepEqual(plain(calls), [[""]]);
	assert.deepEqual(plain(f.current().recovery), { entries: [recoveryEntry], truncated: true });
	assert.equal(f.current().recoveryLoading, false);
	const failed = fixture({ recoveryList: async () => ({ ok: false, code: "GIT_COMMAND_FAILED" }) });
	await failed.reads.loadRecovery();
	assert.equal(failed.current().recoveryErrorCode, "GIT_COMMAND_FAILED");
	assert.equal(failed.current().recovery, undefined);
	const thrown = fixture({
		recoveryList: async () => {
			throw new Error("invoke failed with SSH_HOST_DISCONNECTED");
		},
	});
	await thrown.reads.loadRecovery();
	assert.equal(thrown.current().recoveryErrorCode, "SSH_HOST_DISCONNECTED");
});

test("restoring a snapshot keeps the recovery store and answers with its own outcome", async () => {
	const calls = [];
	const f = fixture({
		recoveryList: async () => ({ ok: true, entries: [], truncated: false }),
		recoveryRestore: async (...args) => {
			calls.push(args);
			return { ok: true };
		},
	});
	await f.reads.refresh();
	await f.reads.restoreRecovery(recoveryEntry);
	assert.deepEqual(plain(calls), [[recoveryEntry.ref, recoveryEntry.oid, recoveryEntry.path, ""]]);
	assert.deepEqual(plain(f.current().recoveryNotice), { kind: "restored", path: "file.txt" });
	assert.equal(f.current().mutating, undefined);
	// The listing is reloaded after a restore, and the notice survives the refresh that follows it.
	assert.ok(f.current().recovery, "the store is listed again");
	await f.reads.refresh();
	assert.deepEqual(plain(f.current().recoveryNotice), { kind: "restored", path: "file.txt" }, "an outcome the user still needs is not erased by a read");
});

test("deleting a snapshot is its own action with its own outcome", async () => {
	const calls = [];
	const f = fixture({
		recoveryList: async () => ({ ok: true, entries: [], truncated: false }),
		recoveryDrop: async (...args) => {
			calls.push(args);
			return { ok: true };
		},
	});
	await f.reads.refresh();
	await f.reads.dropRecovery(recoveryEntry);
	assert.deepEqual(plain(calls), [[recoveryEntry.ref, recoveryEntry.oid, ""]]);
	assert.deepEqual(plain(f.current().recoveryNotice), { kind: "dropped", path: "file.txt" });
	// The repository facts come back with the outcome: a drop must not leave the panel looking empty.
	assert.ok(f.current().snapshot, "the panel re-reads the repository after a drop");
	// A refused drop reports its code and drops the facts; an unknown one says so and is never replayed.
	const refused = fixture({ recoveryDrop: async () => ({ ok: false, code: "GIT_RECOVERY_ENTRY_NOT_FOUND" }) });
	await refused.reads.refresh();
	await refused.reads.dropRecovery(recoveryEntry);
	assert.equal(refused.current().errorCode, "GIT_RECOVERY_ENTRY_NOT_FOUND");
	assert.equal(refused.current().snapshot, undefined);
	let attempts = 0;
	const unknown = fixture({
		recoveryDrop: async () => {
			attempts += 1;
			throw new Error("socket closed");
		},
	});
	await unknown.reads.refresh();
	await unknown.reads.dropRecovery(recoveryEntry);
	assert.equal(unknown.current().errorCode, "GIT_WRITE_RESULT_UNCONFIRMED");
	assert.equal(attempts, 1, "an unknown drop is never replayed");
});

test("recovery actions with a foreign ref or for another project never reach the API", async () => {
	const calls = [];
	const f = fixture({
		recoveryRestore: async (...args) => {
			calls.push(args);
			return { ok: true };
		},
		recoveryDrop: async (...args) => {
			calls.push(args);
			return { ok: true };
		},
	});
	await f.reads.refresh();
	for (const bad of [{ ...recoveryEntry, ref: "refs/heads/main" }, { ...recoveryEntry, ref: "HEAD" }, { ...recoveryEntry, oid: "nope" }, null]) {
		await f.reads.restoreRecovery(bad);
		await f.reads.dropRecovery(bad);
	}
	assert.deepEqual(calls, [], "a foreign ref is refused locally, exactly as main would refuse it");
});

test("a listing that finishes after a drop cannot erase the drop's outcome", async () => {
	let release;
	let listings = 0;
	const f = fixture({
		// The first listing hangs (the panel is still loading it); the reload the drop triggers answers at once.
		recoveryList: () => {
			listings += 1;
			return listings === 1
				? new Promise((accept) => {
						release = accept;
					})
				: Promise.resolve({ ok: true, entries: [], truncated: false });
		},
		recoveryDrop: async () => ({ ok: true }),
	});
	await f.reads.refresh();
	// The user expands the section (a listing starts), then drops a snapshot from the listing already on screen.
	const slowListing = f.reads.loadRecovery();
	const drop = f.reads.dropRecovery(recoveryEntry);
	await drop;
	release({ ok: true, entries: [], truncated: false });
	await slowListing;
	assert.deepEqual(plain(f.current().recoveryNotice), { kind: "dropped", path: "file.txt" }, "a read must never decide what an action reported");
	assert.deepEqual(plain(f.current().recovery), { entries: [], truncated: false });
});

const syncFacts = { branch: "main", upstream: "refs/remotes/origin/main", ahead: 1, behind: 2, remotes: ["origin"] };

test("sync facts load on demand and the three verbs report their own outcome", async () => {
	const calls = [];
	const f = fixture({
		syncFacts: async (...args) => {
			calls.push(["facts", ...args]);
			return { ok: true, facts: syncFacts };
		},
		fetch: async (...args) => {
			calls.push(["fetch", ...args]);
			return { ok: true };
		},
		push: async (...args) => {
			calls.push(["push", ...args]);
			return { ok: true };
		},
		pull: async (...args) => {
			calls.push(["pull", ...args]);
			return { ok: true };
		},
	});
	await f.reads.loadSync();
	assert.deepEqual(plain(f.current().sync), syncFacts);
	await f.reads.refresh();
	await f.reads.loadSync();
	await f.reads.fetch("origin");
	assert.deepEqual(plain(calls.filter((call) => call[0] === "fetch").at(-1)), ["fetch", "origin", ""]);
	assert.deepEqual(plain(f.current().syncNotice), { kind: "fetch", outcome: "fetched" });
	await f.reads.loadSync();
	await f.reads.push("origin", "main");
	assert.deepEqual(plain(calls.filter((call) => call[0] === "push").at(-1)), ["push", "origin", "main", ""]);
	assert.deepEqual(plain(f.current().syncNotice), { kind: "push", outcome: "pushed" });
	await f.reads.loadSync();
	await f.reads.pull("origin", "main");
	assert.deepEqual(plain(calls.filter((call) => call[0] === "pull").at(-1)), ["pull", "origin", "main", ""]);
	assert.deepEqual(plain(f.current().syncNotice), { kind: "pull", outcome: "pulled" });
	// The notice survives the refresh the verb performs, and the facts are re-read with it.
	await f.reads.refresh();
	assert.deepEqual(plain(f.current().syncNotice), { kind: "pull", outcome: "pulled" });
});

test("sync refusals and unknown outcomes are never replayed or guessed", async () => {
	const refused = fixture({ syncFacts: async () => ({ ok: true, facts: syncFacts }), push: async () => ({ ok: false, code: "GIT_PUSH_REJECTED" }) });
	await refused.reads.refresh();
	await refused.reads.loadSync();
	await refused.reads.push("origin", "main");
	assert.equal(refused.current().errorCode, "GIT_PUSH_REJECTED");
	assert.equal(refused.current().snapshot, undefined, "a refused verb drops the facts instead of showing a stale tree");
	let attempts = 0;
	const unknown = fixture({
		syncFacts: async () => ({ ok: true, facts: syncFacts }),
		pull: async () => {
			attempts += 1;
			throw new Error("socket closed");
		},
	});
	await unknown.reads.refresh();
	await unknown.reads.loadSync();
	await unknown.reads.pull("origin", "main");
	assert.equal(unknown.current().errorCode, "GIT_WRITE_RESULT_UNCONFIRMED");
	assert.equal(unknown.current().syncNotice, undefined, "an unknown outcome promises nothing");
	assert.equal(attempts, 1, "an unknown verb is never replayed");
	const failing = fixture({ syncFacts: async () => ({ ok: false, code: "GIT_SYNC_FAILED" }) });
	await failing.reads.loadSync();
	assert.equal(failing.current().syncErrorCode, "GIT_SYNC_FAILED");
});

test("a sync verb with an unknown remote, the wrong branch or no loaded facts never reaches the API", async () => {
	const calls = [];
	const f = fixture({
		syncFacts: async () => ({ ok: true, facts: syncFacts }),
		fetch: async (...args) => {
			calls.push(["fetch", ...args]);
			return { ok: true };
		},
		push: async (...args) => {
			calls.push(["push", ...args]);
			return { ok: true };
		},
	});
	await f.reads.refresh();
	// No sync facts yet: the panel must not guess a remote.
	await f.reads.fetch("origin");
	assert.deepEqual(calls, [], "a verb needs the loaded sync facts");
	await f.reads.loadSync();
	await f.reads.fetch("elsewhere");
	await f.reads.push("origin", "other");
	assert.deepEqual(calls, [], "only a remote this repository has, and only the checked-out branch, may be synced");
});

test("同步事实跨 refresh 保留：打开面板时同步链与仓库读并行，不会各等一次往返", async () => {
	// 真机：同步条与仓库读原来串行（refresh 之后才 loadSync），而且 refresh 会把已到的同步事实清掉，
	// 面板上就长期停在「正在读取远端 Git…」。事实属于项目身份，不由快照代决定。
	const order = [];
	const f = fixture({
		status: async () => {
			order.push("status");
			return { ok: true, snapshot };
		},
		syncFacts: async () => {
			order.push("syncFacts");
			return { ok: true, facts: syncFacts };
		},
	});
	// 与 hook 的启动顺序同形：两个读同时发起。
	const refresh = f.reads.refresh();
	const sync = f.reads.loadSync().then(() => undefined);
	await Promise.all([refresh, sync]);
	assert.deepEqual(order, ["status", "syncFacts"]);
	assert.deepEqual(plain(f.current().sync), syncFacts, "先到的同步事实不被后到的快照覆盖");
	await f.reads.refresh();
	assert.deepEqual(plain(f.current().sync), syncFacts, "显式刷新也保留同一份在线同步事实");
});

test("读失败时同步事实一起作废，不把旧数字挂在错误旁边", async () => {
	let factsOk = true;
	const f = fixture({
		status: async () => (factsOk ? { ok: true, snapshot } : { ok: false, code: "GIT_COMMAND_FAILED" }),
		syncFacts: async () => ({ ok: true, facts: syncFacts }),
	});
	await f.reads.refresh();
	await f.reads.loadSync();
	assert.deepEqual(plain(f.current().sync), syncFacts);
	factsOk = false;
	await f.reads.refresh();
	assert.equal(f.current().errorCode, "GIT_COMMAND_FAILED");
	assert.equal(f.current().sync, undefined, "失败的读不能留下与错误并排的旧同步数字");
});

test("提交成功后重读同步事实：ahead 数字跟着提交走，不停在旧值", async () => {
	let head = 0;
	const reads = [];
	const f = fixture({
		status: async () => ({ ok: true, snapshot }),
		commit: async () => {
			head += 1;
			return { ok: true };
		},
		syncFacts: async () => {
			reads.push(head);
			return { ok: true, facts: { ...syncFacts, ahead: head } };
		},
	});
	await f.reads.refresh();
	await f.reads.loadSync();
	assert.equal(f.current().sync.ahead, 0);
	await f.reads.commit("subject");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(reads, [0, 1], "提交落地后重读一次，并带上新的 ahead");
	assert.equal(f.current().sync.ahead, 1);
});
