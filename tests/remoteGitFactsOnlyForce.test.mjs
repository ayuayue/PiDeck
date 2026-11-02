/**
 * 纯事实强刷（git:remote-snapshot 的 facts-only 模式）的主进程契约。
 *
 * 与带授权副作用的 force 的区别是**授权副作用**：普通 snapshot 每次都会撤销该 sender+project 的全部旧令牌并
 * 现签新令牌；facts-only 只重读事实。因此这里锁定：
 * - 越过事实缓存（普通读命中缓存，facts-only 仍会向 helper 重新取事实）；
 * - 返回体没有任何 *Token 字段，也不签新令牌；
 * - 已签出的 grant 在 facts-only 强刷之后仍然可用（写不会被一次刷新打断）；
 * - 旧的 force（无 mode）行为不变：仍然撤/重签，旧令牌随即失效；
 * - 非法 mode、失效 trust、已销毁 sender 的边界不放松，且都在排队 SSH 之前拒绝；
 * - 一次失败的强刷不会把坏值写进事实缓存（下一次普通读仍是上一份好事实）。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const projectId = "remote-project";
const locator = { kind: "ssh", hostId: "remote-host", remotePath: "/workspace/project" };
const oid = (char) => char.repeat(40);
const REVISION = "a".repeat(64);
const WRITE_CAPABILITIES = ["git.status", "git.stage", "git.unstage", "git.commit"];
const WRITE_TOKENS = ["mutationToken", "commitToken", "branchToken", "switchToken", "discardToken", "restoreToken", "dropToken", "fetchToken", "pushToken", "pullToken"];
const plain = (value) => JSON.parse(JSON.stringify(value));

/** 真实 handler 注册 + 假 helper 会话：没有网络、没有本机 Git、没有真实 SSH。 */
function fixture(overrides = {}) {
	const handlers = new Map();
	const calls = [];
	const { registerRemoteGitReadIpc } = loadTsCommonJs("src/main/ipc/remoteGitReadIpc.ts", { stubs: { electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } } } });
	const sender = new EventEmitter();
	sender.id = 1;
	sender.isDestroyed = () => false;
	const state = { statusFile: "tracked.txt", failStatus: false };
	const session = {
		hostRevision: 1,
		request: async (method, params, options) => {
			calls.push({ method, params, ...(options?.repo === undefined ? {} : { repo: options.repo }) });
			options?.onRequestId?.("request-" + calls.length);
			if (method === "hello") return { protocolVersion: 1, root: locator.remotePath, capabilities: [...WRITE_CAPABILITIES] };
			if (method === "git.status") {
				if (state.failStatus) throw new Error("REMOTE_CONNECTION_LOST");
				return { status: Buffer.from(" M " + state.statusFile + "\0").toString("base64"), head: oid("a"), branch: "main", revision: REVISION };
			}
			return { applied: true };
		},
		cancel: async () => {},
	};
	const input = {
		enabled: true,
		locator: (id) => (id === projectId ? locator : undefined),
		trusted: async () => true,
		service: async () => ({
			withProjectSession: async (hostId, root, work, options) => {
				assert.equal(options.requireReady, true);
				return { ok: true, value: await work(session) };
			},
			projectConnectionFacts: () => ({ connectionId: "conn-1", state: "ready" }),
		}),
		...overrides,
	};
	registerRemoteGitReadIpc(input);
	return {
		handlers,
		calls,
		sender,
		state,
		event: { sender },
		statusReads: () => calls.filter((call) => call.method === "git.status").length,
		snapshot: (force, mode) => handlers.get(ipcChannels.gitRemoteSnapshot)({ sender }, projectId, undefined, force, mode),
		stage: (token) => handlers.get(ipcChannels.gitRemoteMutateIndex)({ sender }, projectId, "stage", "workingTree", { projectId, relativePath: "tracked.txt" }, token),
	};
}

test("facts-only 强刷越过已完成事实缓存：普通读命中缓存，facts 模式重新向 helper 取事实", async () => {
	const f = fixture();
	const first = await f.snapshot();
	assert.equal(first.ok, true);
	assert.equal(f.statusReads(), 1);
	// 普通读：第二次直接命中已完成的事实缓存，不再问 helper。
	f.state.statusFile = "second.txt";
	const cached = await f.snapshot();
	assert.equal(cached.ok, true);
	assert.equal(f.statusReads(), 1, "普通读必须继续复用事实缓存");
	// facts-only：越过缓存，读到新事实。
	const fresh = await f.snapshot(true, "facts");
	assert.equal(fresh.ok, true);
	assert.equal(f.statusReads(), 2);
	assert.deepEqual(plain(fresh.snapshot.groups.workingTree.map((item) => item.path)), ["second.txt"]);
});

test("facts-only 强刷不签任何令牌，且不撤销已签出的 grant（写不会被一次刷新打断）", async () => {
	const f = fixture();
	const granted = await f.snapshot();
	for (const field of ["mutationToken", "commitToken"]) assert.match(granted.snapshot[field] ?? "", /^[0-9a-f]{32}$/, field + " must be issued");
	const callsBefore = f.calls.length;
	const facts = await f.snapshot(true, "facts");
	assert.equal(facts.ok, true);
	for (const field of WRITE_TOKENS) assert.equal(facts.snapshot[field], undefined, field + " must not be minted by a facts-only read");
	// 旧令牌仍然可用：强刷没有 revoke 它，写直接落到 helper（不是 GIT_WRITE_SNAPSHOT_EXPIRED）。
	const staged = await f.stage(granted.snapshot.mutationToken);
	assert.equal(staged.ok, true, "a facts-only refresh must not invalidate a live grant");
	assert.equal(f.calls.at(-1).method, "git.stage", "the grant reached the write frame instead of expiring");
	assert.ok(f.calls.length > callsBefore + 1, "the facts read ran after the grant was issued");
});

test("旧的 force 行为不变：无 mode 的强刷仍撤/重签令牌，旧令牌随即失效", async () => {
	const f = fixture();
	const granted = await f.snapshot();
	const forced = await f.snapshot(true);
	assert.equal(forced.ok, true);
	assert.match(forced.snapshot.mutationToken ?? "", /^[0-9a-f]{32}$/);
	assert.notEqual(forced.snapshot.mutationToken, granted.snapshot.mutationToken);
	const callsBefore = f.calls.length;
	const replayed = await f.stage(granted.snapshot.mutationToken);
	assert.equal(replayed.ok, false);
	assert.equal(replayed.code, "GIT_WRITE_SNAPSHOT_EXPIRED");
	assert.equal(f.calls.length, callsBefore, "an expired grant must be refused before any helper work");
});

test("非法 mode 在排队 SSH 之前拒绝，且零 helper 调用", async () => {
	const f = fixture();
	const result = await f.snapshot(true, "tokens");
	assert.equal(result.ok, false);
	assert.equal(result.code, "GIT_RESULT_INVALID");
	assert.equal(f.calls.length, 0);
});

test("facts-only 不放松授权边界：trust 失效 / sender 已销毁 都在读之前拒绝", async () => {
	const denied = fixture({ trusted: async () => false });
	const untrusted = await denied.snapshot(true, "facts");
	assert.equal(untrusted.ok, false);
	assert.equal(untrusted.code, "GIT_TRUST_REQUIRED");
	assert.equal(denied.calls.length, 0, "trust is re-read on every read, cache or not");

	const f = fixture();
	f.sender.isDestroyed = () => true;
	const cancelled = await f.snapshot(true, "facts");
	assert.equal(cancelled.ok, false);
	assert.equal(cancelled.code, "REQUEST_CANCELLED");
	assert.equal(f.calls.length, 0);
});

test("失败的强刷不污染事实缓存：下一次普通读仍是上一份好事实，恢复后强刷拿到新事实", async () => {
	const f = fixture();
	const good = await f.snapshot();
	assert.equal(good.ok, true);
	assert.equal(f.statusReads(), 1);
	f.state.failStatus = true;
	const failed = await f.snapshot(true, "facts");
	assert.equal(failed.ok, false);
	assert.equal(failed.code, "REMOTE_CONNECTION_LOST");
	// 失败没有被当成事实写进缓存：普通读仍给出上一份（未被污染）的好事实。
	f.state.failStatus = false;
	f.state.statusFile = "after-recovery.txt";
	const recovered = await f.snapshot(true, "facts");
	assert.equal(recovered.ok, true);
	assert.deepEqual(plain(recovered.snapshot.groups.workingTree.map((item) => item.path)), ["after-recovery.txt"]);
});
