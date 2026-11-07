import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const projectId = "remote-project";
const locator = { kind: "ssh", hostId: "remote-host", remotePath: "/workspace/project" };
const oid = (char) => char.repeat(40);
const snapshot = { status: Buffer.from(" M tracked.txt\0").toString("base64"), head: oid("a"), branch: "main" };
const hello = { protocolVersion: 1, root: locator.remotePath, capabilities: ["git.status", "git.workspaceDiff", "git.log", "git.commitDetail", "git.refs", "git.refFileDiff"] };
const detailValue = {
	parents: [oid("b")],
	authorName: "Fixture",
	authorEmail: "fixture@example.invalid",
	authorTimeSec: 1700000000,
	committerName: "Fixture",
	committerEmail: "fixture@example.invalid",
	committerTimeSec: 1700000000,
	subject: "subject",
	message: "subject\n\nbody\n",
	files: [{ status: "R100", path: "renamed.txt", oldPath: "old.txt" }],
};
const refsValue = {
	head: oid("a"),
	branch: "main",
	refs: [
		{ fullName: "refs/heads/main", name: "main", oid: oid("a"), kind: "branch" },
		{ fullName: "refs/tags/v1", name: "v1", oid: oid("c"), kind: "tag" },
	],
};
const plain = (value) => JSON.parse(JSON.stringify(value));

const otherProjectId = "remote-project-other";
const otherLocator = { kind: "ssh", hostId: locator.hostId, remotePath: "/workspace/other-project" };

/** Drive registered IPC handlers with the real remote service, no network and no local Git fallback. */
function fixture(overrides = {}) {
	const handlers = new Map();
	const calls = [];
	const factsCalls = [];
	const hostFactsCalls = [];
	const { projectFacts, ...rest } = overrides;
	const { registerRemoteGitReadIpc } = loadTsCommonJs("src/main/ipc/remoteGitReadIpc.ts", { stubs: { electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } } } });
	const sender = new EventEmitter();
	sender.id = 1;
	sender.isDestroyed = () => false;
	const session = {
		request: async (method, params, options) => {
			calls.push({ method, params, ...(options?.repo === undefined ? {} : { repo: options.repo }) });
			options?.onRequestId?.("request-id");
			if (method === "hello") return hello;
			if (method === "git.status") return snapshot;
			if (method === "git.commitDetail") return { ...detailValue, oid: params.oid };
			if (method === "git.refs") return refsValue;
			return { originalContent: "base\n", modifiedContent: "working\n" };
		},
		cancel: async (id) => {
			calls.push({ method: "cancel", id });
		},
	};
	const input = {
		enabled: true,
		locator: (id) => (id === projectId ? locator : undefined),
		trusted: async () => true,
		service: async () => ({
			withProjectSession: async (hostId, root, work, options) => {
				assert.equal(options.requireReady, true);
				assert.ok(options.signal instanceof AbortSignal);
				return { ok: true, value: await work(session) };
			},
			// 主机级事实：只为证明「主机连上了」不再是项目读的身份来源；新契约下它必须一次都不被问到。
			connectionFacts: (hostId) => {
				hostFactsCalls.push(hostId);
				return { connectionId: "conn-host", state: "ready" };
			},
			// 项目读的事实入口按 (host, root) 回答；未注入时端口没有该方法 = 没有稳定项目身份。
			...(projectFacts === undefined
				? {}
				: {
						projectConnectionFacts: (hostId, root) => {
							factsCalls.push({ hostId, root });
							return projectFacts(hostId, root);
						},
					}),
		}),
		...rest,
	};
	const port = registerRemoteGitReadIpc(input);
	return { port, handlers, calls, factsCalls, hostFactsCalls, sender, session, input, event: { sender } };
}

test("git:refs 的远端实现返回与本地同形的 GitRef[]（W5 单通道族第一个读动词）", async () => {
	const f = fixture();
	const refs = plain(await f.port.refs({ sender: f.sender }, projectId, ""));
	assert.deepEqual(refs, [
		{ name: "main", fullName: "refs/heads/main", hash: oid("a"), type: "head" },
		{ name: "v1", fullName: "refs/tags/v1", hash: oid("c"), type: "tag" },
	]);
	// 远端只报本地分支与 tag：不会凭空造出 remote-tracking 那一档。
	assert.ok(!refs.some((ref) => ref.type === "remote"));
});

test("remote Git snapshot IPC resolves only the main-owned target and returns branch/status facts", async () => {
	const f = fixture();
	const result = await f.handlers.get(ipcChannels.gitRemoteSnapshot)(f.event, projectId);
	assert.equal(result.ok, true);
	assert.equal(result.snapshot.branch, "main");
	assert.equal(result.snapshot.groups.workingTree[0].path, "tracked.txt");
	assert.deepEqual(plain(result.snapshot.groups.workingTree[0].target), { projectId, relativePath: "tracked.txt" });
	assert.deepEqual(
		f.calls.map((call) => call.method),
		["hello", "git.status"],
	);
	assert.equal(f.sender.listenerCount("destroyed"), 0);
});

test("remote Git status/diff ports retain existing IPC shapes without any local cwd", async () => {
	const f = fixture();
	const groups = await f.port.status(f.event, projectId);
	assert.equal(groups.workingTree.length, 1);
	const diff = await f.port.workspaceDiff(f.event, projectId, "workingTree", { projectId, relativePath: "tracked.txt" });
	assert.equal(diff.originalContent, "base\n");
	assert.equal(diff.modifiedContent, "working\n");
	assert.deepEqual(plain(f.calls.at(-1).params), { group: "workingTree", path: "tracked.txt" });
});

test("disabled remote Git refuses snapshot and compatibility ports with zero helper work", async () => {
	const f = fixture({ enabled: false });
	const result = await f.handlers.get(ipcChannels.gitRemoteSnapshot)(f.event, projectId);
	assert.equal(result.ok, false);
	assert.equal(result.code, "REMOTE_FEATURE_DISABLED");
	await assert.rejects(f.port.status(f.event, projectId), /REMOTE_FEATURE_DISABLED/);
	assert.equal(f.calls.length, 0);
});

test("remote Git boundary rejects escaping/cross-project scopes before connecting and accepts a nested repo", async () => {
	const f = fixture();
	// G5d: a project-relative nested path is a legal read scope (the helper anchors and checks the repository).
	await f.port.status(f.event, projectId, { projectId, relativePath: "nested" });
	assert.deepEqual(plain(f.calls.at(-1)), { method: "git.status", params: {}, repo: "nested" });
	f.calls.length = 0;
	for (const repo of [{ projectId: "other", relativePath: "" }, "/local/absolute", "../outside", "nested/../root", "a\\b", "dir/.git", "x.lock/y"]) await assert.rejects(f.port.status(f.event, projectId, repo));
	await assert.rejects(f.port.workspaceDiff(f.event, projectId, "workingTree", { projectId: "other", relativePath: "tracked.txt" }));
	await assert.rejects(f.port.workspaceDiff(f.event, projectId, "workingTree", { projectId, relativePath: "../outside" }));
	await assert.rejects(f.port.workspaceDiff(f.event, projectId, "invalid", { projectId, relativePath: "tracked.txt" }));
	assert.equal(f.calls.length, 0);
});

test("destroying the IPC sender cancels the exact active read and discards late success", async () => {
	const f = fixture();
	f.session.request = async (method, params, options) => {
		if (method === "hello") return hello;
		options.onRequestId("active-request");
		f.sender.emit("destroyed");
		return snapshot;
	};
	const result = await f.handlers.get(ipcChannels.gitRemoteSnapshot)(f.event, projectId);
	assert.equal(result.ok, false);
	assert.equal(result.code, "REQUEST_CANCELLED");
	assert.deepEqual(f.calls, [{ method: "cancel", id: "active-request" }]);
	assert.equal(f.sender.listenerCount("destroyed"), 0);
});

test("renderer cancellation is scoped to the sender and project, then cancels the exact helper request", async () => {
	const f = fixture();
	let resolve;
	const pending = new Promise((accept) => {
		resolve = accept;
	});
	f.session.request = async (method, params, options) => {
		if (method === "hello") return hello;
		options.onRequestId("active-read");
		return pending;
	};
	const request = f.handlers.get(ipcChannels.gitRemoteSnapshot)(f.event, projectId);
	await new Promise((accept) => setImmediate(accept));
	const cancel = f.handlers.get(ipcChannels.gitRemoteCancelReads);
	cancel({ sender: { id: 2 } }, projectId);
	cancel(f.event, "other-project");
	assert.equal(f.calls.length, 0);
	cancel(f.event, projectId);
	assert.deepEqual(f.calls, [{ method: "cancel", id: "active-read" }]);
	resolve(snapshot);
	const result = await request;
	assert.equal(result.ok, false);
	assert.equal(result.code, "REQUEST_CANCELLED");
});

test("remote Git IPC disposal cancels reads and admits no further operations", async () => {
	const f = fixture();
	f.port.dispose();
	const result = await f.handlers.get(ipcChannels.gitRemoteSnapshot)(f.event, projectId);
	assert.equal(result.ok, false);
	assert.equal(result.code, "REQUEST_CANCELLED");
	assert.equal(f.calls.length, 0);
});

test("remote history IPC answers detail, refs and ref-file diff through the real service", async () => {
	const f = fixture();
	const detail = await f.handlers.get(ipcChannels.gitRemoteCommitDetail)(f.event, projectId, oid("d"));
	assert.equal(detail.ok, true);
	assert.equal(detail.detail.oid, oid("d"));
	assert.equal(detail.detail.message, "subject\n\nbody\n");
	assert.deepEqual(plain(detail.detail.files), [{ status: "R100", path: "renamed.txt", oldPath: "old.txt" }]);
	const refs = await f.handlers.get(ipcChannels.gitRemoteRefs)(f.event, projectId);
	assert.equal(refs.ok, true);
	assert.equal(refs.refs.branch, "main");
	assert.deepEqual(
		refs.refs.refs.map((entry) => entry.kind),
		["branch", "tag"],
	);
	const diff = await f.handlers.get(ipcChannels.gitRemoteRefFileDiff)(f.event, projectId, null, oid("d"), { projectId, relativePath: "renamed.txt" });
	assert.equal(diff.ok, true);
	assert.equal(diff.diff.originalContent, "base\n");
	assert.equal(diff.diff.modifiedContent, "working\n");
	assert.deepEqual(plain(diff.diff.target), { projectId, relativePath: "renamed.txt" });
	assert.deepEqual(plain(f.calls.at(-1)), { method: "git.refFileDiff", params: { base: null, head: oid("d"), path: "renamed.txt" } });
});

test("remote history IPC rejects invalid parameters before any helper session is opened", async () => {
	const f = fixture();
	for (const value of ["abc", oid("d").toUpperCase(), 42, null]) {
		const result = await f.handlers.get(ipcChannels.gitRemoteCommitDetail)(f.event, projectId, value);
		assert.equal(result.ok, false, String(value));
		assert.equal(result.code, "GIT_RESULT_INVALID");
	}
	const cross = await f.handlers.get(ipcChannels.gitRemoteRefFileDiff)(f.event, projectId, null, oid("d"), { projectId: "other", relativePath: "renamed.txt" });
	assert.equal(cross.code, "GIT_RESULT_INVALID");
	const escape = await f.handlers.get(ipcChannels.gitRemoteRefFileDiff)(f.event, projectId, null, oid("d"), { projectId, relativePath: "../outside" });
	assert.equal(escape.code, "PATH_OUTSIDE_ROOT");
	const namedBase = await f.handlers.get(ipcChannels.gitRemoteRefFileDiff)(f.event, projectId, "main", oid("d"), { projectId, relativePath: "renamed.txt" });
	assert.equal(namedBase.code, "GIT_RESULT_INVALID");
	assert.equal(f.calls.length, 0, "refused parameters must not open a helper session");
});

test("remote history IPC re-validates helper answers and refuses anything outside the frozen shape", async () => {
	const f = fixture();
	f.session.request = async (method, params) => {
		if (method === "hello") return hello;
		if (method === "git.commitDetail") return { ...detailValue, oid: oid("e") };
		if (method === "git.refs") return { head: oid("a"), branch: "main", refs: [{ fullName: "refs/remotes/origin/main", name: "origin/main", oid: oid("b"), kind: "branch" }] };
		return { originalContent: "a\0b", modifiedContent: "" };
	};
	// An answer for a different commit, a remote-tracking ref and a NUL byte.
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteCommitDetail)(f.event, projectId, oid("d"))).code, "GIT_RESULT_INVALID");
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteRefs)(f.event, projectId)).code, "GIT_RESULT_INVALID");
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteRefFileDiff)(f.event, projectId, null, oid("d"), { projectId, relativePath: "x.txt" })).code, "GIT_RESULT_INVALID");
});

test("disabled remote history IPC refuses with zero helper work", async () => {
	const f = fixture({ enabled: false });
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteCommitDetail)(f.event, projectId, oid("d"))).code, "REMOTE_FEATURE_DISABLED");
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteRefs)(f.event, projectId)).code, "REMOTE_FEATURE_DISABLED");
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteRefFileDiff)(f.event, projectId, null, oid("d"), { projectId, relativePath: "x.txt" })).code, "REMOTE_FEATURE_DISABLED");
	assert.equal(f.calls.length, 0);
});

test("every read channel carries the repository scope into the helper frame", async () => {
	const f = fixture();
	const readCapabilities = ["git.status", "git.commitDetail", "git.refs", "git.refFileDiff", "git.recoveryList", "git.syncFacts"];
	f.session.request = async (method, params, options) => {
		f.calls.push({ method, params, repo: options?.repo });
		options?.onRequestId?.("request-" + f.calls.length);
		if (method === "hello") return { protocolVersion: 1, root: locator.remotePath, capabilities: readCapabilities };
		if (method === "git.status") return snapshot;
		if (method === "git.commitDetail") return { ...detailValue, oid: params.oid };
		if (method === "git.refs") return refsValue;
		if (method === "git.recoveryList") return { entries: [], truncated: false };
		if (method === "git.syncFacts") return { branch: "main", upstream: null, ahead: 0, behind: 0, remotes: [] };
		return { originalContent: "base\n", modifiedContent: "working\n" };
	};
	const scoped = "packages/nested";
	// T5：公共 target 是**项目相对**的——嵌套仓库里的文件是 `packages/nested/x.txt`，不是 `x.txt`。
	const scopedFile = { projectId, relativePath: "packages/nested/x.txt" };
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteSnapshot)(f.event, projectId, scoped)).ok, true);
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteCommitDetail)(f.event, projectId, oid("d"), scoped)).ok, true);
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteRefs)(f.event, projectId, scoped)).ok, true);
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteRefFileDiff)(f.event, projectId, null, oid("d"), scopedFile, scoped)).ok, true);
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteRecoveryList)(f.event, projectId, scoped)).ok, true);
	assert.equal((await f.handlers.get(ipcChannels.gitRemoteSyncFacts)(f.event, projectId, scoped)).ok, true);
	const scopedCalls = f.calls.filter((call) => call.method !== "hello");
	assert.equal(scopedCalls.length, 6, "six scoped reads reach the helper");
	for (const call of scopedCalls) assert.equal(call.repo, scoped, call.method + " must carry the selected repository");
	// helper 只看到仓库内路径：项目相对的公共 target 在边界处被削回仓库内。
	assert.equal(f.calls.find((call) => call.method === "git.refFileDiff").params.path, "x.txt", "the helper boundary only ever sees a repository-relative path");
});

const WRITE_CAPABILITIES = ["git.status", "git.stage", "git.unstage", "git.commit", "git.createBranch", "git.switchBranch", "git.discard", "git.recoveryRestore", "git.recoveryDrop", "git.fetch", "git.push", "git.pull"];
const WRITE_TOKENS = ["mutationToken", "commitToken", "branchToken", "switchToken", "discardToken", "restoreToken", "dropToken", "fetchToken", "pushToken", "pullToken"];

/** Every write handler, in call order: the trailing scope is the last argument, exactly like preload sends it. */
function writeInvocations(grants, repo) {
	// T5：公共 target/路径是项目相对的（嵌套 scope 下带 `packages/nested/` 前缀）。
	const file = { projectId, relativePath: repo === undefined || repo === "" ? "a.txt" : repo + "/a.txt" };
	return [
		["gitRemoteMutateIndex", projectId, "stage", "workingTree", file, grants.mutationToken, repo],
		["gitRemoteCommit", projectId, "message", grants.commitToken, repo],
		["gitRemoteCreateBranch", projectId, "feature", grants.branchToken, repo],
		["gitRemoteSwitchBranch", projectId, "feature", grants.switchToken, repo],
		["gitRemoteDiscard", projectId, "workingTree", file, grants.discardToken, repo],
		["gitRemoteRecoveryRestore", projectId, "refs/pideck/recovery/x", oid("a"), file.relativePath, grants.restoreToken, repo],
		["gitRemoteRecoveryDrop", projectId, "refs/pideck/recovery/x", oid("a"), grants.dropToken, repo],
		["gitRemoteFetch", projectId, "origin", grants.fetchToken, repo],
		["gitRemotePush", projectId, "origin", "main", grants.pushToken, repo],
		["gitRemotePull", projectId, "origin", "main", grants.pullToken, repo],
	];
}

/** One write reply per helper method; shapes are the ones RemoteGitService re-validates. */
function writeReply(method, params) {
	if (method === "git.commit") return { applied: true, head: oid("a"), tree: oid("b") };
	if (method === "git.createBranch" || method === "git.switchBranch") return { applied: true, branch: params.name, ...(method === "git.switchBranch" ? { head: oid("a") } : {}) };
	if (method === "git.discard") return { applied: true, recoveryRef: null, path: params.path, mode: "restored" };
	if (method === "git.recoveryRestore") return { applied: true, path: params.path, bytes: 1 };
	if (method === "git.recoveryDrop") return { applied: true };
	if (method === "git.fetch") return { applied: true, upToDate: true, updated: [] };
	if (method === "git.push") return { applied: true, outcome: "up-to-date", refspec: "refs/heads/main:refs/heads/main" };
	if (method === "git.pull") return { applied: true, mode: "up-to-date", head: oid("a") };
	return { applied: true };
}

/** A fixture whose helper answers the whole write batch, with the snapshot carrying every grant. */
function writeFixture() {
	const f = fixture();
	f.session.hostRevision = 1;
	f.session.request = async (method, params, options) => {
		f.calls.push({ method, params, ...(options?.repo === undefined ? {} : { repo: options.repo }) });
		options?.onRequestId?.("request-" + f.calls.length);
		if (method === "hello") return { protocolVersion: 1, root: locator.remotePath, capabilities: [...WRITE_CAPABILITIES, "git.init"] };
		if (method === "git.status") return { ...snapshot, revision: "a".repeat(64) };
		return writeReply(method, params);
	};
	return f;
}

test("every snapshot mints grants bound to its own scope, and a cross-scope token is refused without host work", async () => {
	const f = writeFixture();
	const nested = await f.handlers.get(ipcChannels.gitRemoteSnapshot)(f.event, projectId, "packages/nested");
	assert.equal(nested.ok, true);
	for (const field of WRITE_TOKENS) assert.match(nested.snapshot[field] ?? "", /^[0-9a-f]{32}$/, field + " must be issued for a nested snapshot");
	// The nested token names the nested repository: using it for a root write is a scope mismatch, not a host request.
	const callsBefore = f.calls.length;
	const crossed = await f.handlers.get(ipcChannels.gitRemoteMutateIndex)(f.event, projectId, "stage", "workingTree", { projectId, relativePath: "a.txt" }, nested.snapshot.mutationToken);
	assert.equal(crossed.code, "GIT_WRITE_SNAPSHOT_EXPIRED");
	assert.equal(f.calls.length, callsBefore, "a cross-scope token must never reach the helper");
	// The same grant still works in the scope it was minted for.
	const scoped = await f.handlers.get(ipcChannels.gitRemoteMutateIndex)(f.event, projectId, "stage", "workingTree", { projectId, relativePath: "packages/nested/a.txt" }, nested.snapshot.mutationToken, "packages/nested");
	assert.equal(scoped.ok, true);
	assert.equal(f.calls.at(-1).repo, "packages/nested");
	// helper 边界只看仓库内路径：项目相对 target 的前缀在这里被剥掉。
	assert.equal(f.calls.at(-1).params.path, "a.txt");
});

test("write channels carry the trailing repository scope into the helper frame", async () => {
	const f = writeFixture();
	const scoped = "packages/nested";
	const nested = await f.handlers.get(ipcChannels.gitRemoteSnapshot)(f.event, projectId, scoped);
	const grants = nested.snapshot;
	f.calls.length = 0;
	for (const [channel, ...args] of writeInvocations(grants, scoped)) {
		const result = await f.handlers.get(ipcChannels[channel])(f.event, ...args);
		assert.equal(result.ok, true, channel + " must reach the helper with its scope");
		assert.equal(f.calls.at(-1).repo, scoped, channel + " must carry the repository scope in its frame");
	}
	// A root-scope write keeps the old frame shape: no repo field at all.
	f.calls.length = 0;
	const root = await f.handlers.get(ipcChannels.gitRemoteSnapshot)(f.event, projectId);
	for (const [channel, ...args] of writeInvocations(root.snapshot, undefined)) {
		const result = await f.handlers.get(ipcChannels[channel])(f.event, ...args);
		assert.equal(result.ok, true, channel + " root write");
		assert.equal(Object.prototype.hasOwnProperty.call(f.calls.at(-1), "repo"), false, channel + " root frame names no repository");
	}
});

test("a write channel refuses an unsafe scope before any host work", async () => {
	const f = writeFixture();
	const nested = await f.handlers.get(ipcChannels.gitRemoteSnapshot)(f.event, projectId);
	const callsBefore = f.calls.length;
	for (const repo of ["../outside", "/absolute", "a\\b", "nested/.git", "x.lock/y"]) {
		for (const [channel, ...args] of writeInvocations(nested.snapshot, repo)) {
			const result = await f.handlers.get(ipcChannels[channel])(f.event, ...args);
			assert.equal(result.code, "GIT_RESULT_INVALID", channel + " " + repo);
		}
	}
	assert.equal(f.calls.length, callsBefore, "an unsafe scope never reaches the helper");
	// Init stays root-only: a trailing argument is still refused before any host work.
	const init = await f.handlers.get(ipcChannels.gitRemoteInit)(f.event, projectId, "packages/nested");
	assert.equal(init.code, "GIT_RESULT_INVALID");
	assert.equal(f.calls.length, callsBefore);
});

/** 同主机、不同 root 的两个项目：能力/事实必须按项目自己的 root 回答。 */
const projectLocators = {
	[projectId]: locator,
	[otherProjectId]: otherLocator,
};

test("项目读的连接代按本项目 root 查询：主机级事实与兄弟 root 都不能冒充", async () => {
	const factsCalls = [];
	const hostFactsCalls = [];
	const f = fixture({
		locator: (id) => projectLocators[id],
		// 假 helper 会话按 --root 启动：hello 只回显它自己的 root（真实 helper 的语义）。
		service: async () => ({
			withProjectSession: async (hostId, root, work, options) => {
				assert.equal(options.requireReady, true);
				const bound = {
					request: async (method) => {
						if (method === "hello") return { protocolVersion: 1, root, capabilities: ["git.repos"] };
						if (method === "git.repos") return { repos: [], truncated: false };
						throw new Error("UNEXPECTED_METHOD");
					},
					cancel: async () => undefined,
				};
				return { ok: true, value: await work(bound) };
			},
			// 主机级事实：新契约下它不再是项目读的身份来源，必须一次都不被问到。
			connectionFacts: (hostId) => {
				hostFactsCalls.push(hostId);
				return { connectionId: "conn-host", state: "ready" };
			},
			projectConnectionFacts: (hostId, root) => {
				factsCalls.push({ hostId, root });
				return root === locator.remotePath ? { connectionId: "conn-a", state: "ready" } : undefined;
			},
		}),
	});
	const listingA = await f.port.repositoryListing(f.event, projectId);
	assert.equal(listingA.ok, true, JSON.stringify(listingA));
	assert.equal(listingA.value.generation, "conn-a", "generation 必须来自 A 自己 root 的会话");
	assert.deepEqual(factsCalls, [{ hostId: locator.hostId, root: locator.remotePath }]);
	// 同主机的兄弟 root 没有活会话：unknown 就是空代，既不是 A 的代，也不是「主机 ready」的代。
	const listingOther = await f.port.repositoryListing(f.event, otherProjectId);
	assert.equal(listingOther.ok, true, JSON.stringify(listingOther));
	assert.equal(listingOther.value.generation, "");
	assert.deepEqual(factsCalls.at(-1), { hostId: locator.hostId, root: otherLocator.remotePath });
	assert.deepEqual(hostFactsCalls, [], "主机级 connectionFacts 不得再为项目读提供身份");
});

test("暖事实之上，本项目 root 没有活会话时仍拒绝：主机 ready 不等于项目会话可用", async () => {
	const f = fixture({ projectFacts: () => undefined });
	const first = await f.handlers.get(ipcChannels.gitRemoteSnapshot)(f.event, projectId);
	assert.equal(first.ok, true, JSON.stringify(first));
	const loads = f.calls.filter((call) => call.method === "git.status").length;
	const second = await f.handlers.get(ipcChannels.gitRemoteSnapshot)(f.event, projectId);
	assert.deepEqual(plain(second), { ok: false, code: "SSH_HOST_NOT_READY" }, "unknown 的项目会话不得拿暖事实冒充成功");
	assert.equal(f.calls.filter((call) => call.method === "git.status").length, loads, "拒绝不得再读远端");
	assert.deepEqual(f.hostFactsCalls, [], "主机级 ready 不构成项目会话的证明");
});

test("事实通知的连接代按本项目 root 求值，unknown 时保持空串", async () => {
	const tick = () => new Promise((resolve) => setImmediate(resolve));
	const published = [];
	const scoped = fixture({
		factsEvents: { publish: (change) => published.push(change) },
		projectFacts: (hostId, root) => (root === locator.remotePath ? { connectionId: "conn-a", state: "ready" } : undefined),
	});
	assert.equal((await scoped.handlers.get(ipcChannels.gitRemoteSnapshot)(scoped.event, projectId)).ok, true);
	scoped.port.invalidateProject(projectId);
	await tick();
	assert.deepEqual(plain(published.map((change) => change.generation)), ["conn-a"]);
	assert.ok(scoped.factsCalls.length > 0);
	for (const call of scoped.factsCalls) assert.deepEqual(call, { hostId: locator.hostId, root: locator.remotePath });
	assert.deepEqual(scoped.hostFactsCalls, []);

	// 没有本项目 root 的会话：通知不猜代，也不回退主机代（主机级事实在假服务里是 ready）。
	const unknownPublished = [];
	const unknown = fixture({ factsEvents: { publish: (change) => unknownPublished.push(change) }, projectFacts: () => undefined });
	assert.equal((await unknown.handlers.get(ipcChannels.gitRemoteSnapshot)(unknown.event, projectId)).ok, true);
	unknown.port.invalidateProject(projectId);
	await tick();
	assert.deepEqual(plain(unknownPublished.map((change) => change.generation)), [""]);
	assert.deepEqual(unknown.hostFactsCalls, []);
});
