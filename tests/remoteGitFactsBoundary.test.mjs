import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

const projectId = "remote-project";
const locator = { kind: "ssh", hostId: "remote-host", remotePath: "/workspace/project" };
const oid = (char) => char.repeat(40);
const plain = (value) => JSON.parse(JSON.stringify(value));
const okayStatus = (branch = "main") => ({ status: Buffer.from(" M tracked.txt\0").toString("base64"), head: oid("a"), branch, revision: "c".repeat(64) });
const CAPABILITIES = ["git.status", "git.workspaceDiff", "git.stage", "git.unstage", "git.commit", "git.log", "git.refs"];

function deferred() {
	let resolve;
	const promise = new Promise((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

const settle = async () => {
	for (let index = 0; index < 8; index += 1) await new Promise((accept) => setImmediate(accept));
};

/**
 * T3（v5 §10.3 R5–R10）：缓存不是权限旁路。
 *
 * 审核基线（§4.2 F1/F2）的两个洞：
 * - snapshot/status 的 cache hit 完全绕过 `read()` 边界：撤销 trust、移除项目、销毁窗口、dispose IPC、
 *   host 离线之后仍能拿到暖缓存成功，并**重新签发**写授权；
 * - 显式刷新读写前缓存；unknown 写不标脏；helper 重连后旧代缓存仍然可发布。
 *
 * 这组用例用真正的 `registerRemoteGitReadIpc` + 内存 helper 端口，把每个洞变成可重复断言。
 */
function fixture() {
	const handlers = new Map();
	const calls = [];
	const state = {
		branch: "main",
		connectionId: "conn-1",
		ready: "ready",
		trusted: true,
		hasLocator: true,
		statusGate: null,
		statusReply: null,
		writeTimeout: false,
		entries: ["main"],
	};
	const { registerRemoteGitReadIpc } = loadTsCommonJs("src/main/ipc/remoteGitReadIpc.ts", { stubs: { electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } } } });
	const makeSender = (id) => {
		const sender = new EventEmitter();
		sender.id = id;
		let destroyed = false;
		sender.isDestroyed = () => destroyed;
		sender.destroyNow = () => {
			destroyed = true;
			sender.emit("destroyed");
		};
		return sender;
	};
	const session = {
		hostRevision: 1,
		async request(method, params, options) {
			calls.push({ method, params, ...(options?.repo === undefined ? {} : { repo: options.repo }) });
			options?.onRequestId?.("request-" + calls.length);
			if (method === "hello") return { protocolVersion: 1, root: locator.remotePath, capabilities: CAPABILITIES };
			if (method === "git.status") {
				if (state.statusGate !== null) await state.statusGate.promise;
				return state.statusReply === null ? okayStatus(state.branch) : state.statusReply();
			}
			if (method === "git.stage") {
				if (state.writeTimeout) throw new Error("REQUEST_TIMEOUT");
				return { applied: true };
			}
			throw new Error("UNEXPECTED_METHOD");
		},
		async cancel(id) {
			calls.push({ method: "cancel", id });
		},
	};
	const service = {
		async withProjectSession(hostId, root, work, options) {
			assert.equal(options.requireReady, true);
			return { ok: true, value: await work(session) };
		},
		// 项目读的事实入口按 (hostId, 项目 root) 查询：主机当前 manager 不再给项目缓存背书。
		projectConnectionFacts(hostId, root) {
			assert.equal(root, locator.remotePath);
			if (state.connectionId === undefined) return undefined;
			return { connectionId: state.connectionId, state: state.ready };
		},
	};
	const port = registerRemoteGitReadIpc({
		enabled: true,
		locator: (id) => (id === projectId && state.hasLocator ? locator : undefined),
		trusted: async () => state.trusted,
		service: async () => service,
	});
	const sender = makeSender(1);
	const snapshot = (targetSender = sender, repo = "", force = undefined) => handlers.get(ipcChannels.gitRemoteSnapshot)({ sender: targetSender }, projectId, repo, force);
	const status = (targetSender = sender, repo = "") => port.status({ sender: targetSender }, projectId, repo);
	const statusLoads = () => calls.filter((call) => call.method === "git.status").length;
	const helloLoads = () => calls.filter((call) => call.method === "hello").length;
	return { handlers, calls, state, port, session, sender, makeSender, snapshot, status, statusLoads, helloLoads };
}

test("R5：暖缓存后 trust 撤销 / 项目移除 / sender 销毁 / dispose / host 离线都稳定拒绝，不返回缓存成功也不签 grant", async () => {
	// trust 撤销：缓存里已有 main，但没有“信任”这份授权。
	{
		const f = fixture();
		const first = await f.snapshot();
		assert.equal(first.ok, true);
		assert.ok(first.snapshot.mutationToken, "first snapshot mints a grant");
		const loads = f.statusLoads();
		f.state.trusted = false;
		const revoked = await f.snapshot();
		assert.deepEqual(plain(revoked), { ok: false, code: "GIT_TRUST_REQUIRED" });
		assert.equal(f.statusLoads(), loads, "暖缓存不得绕过 trust：拒绝时不读也不重签");
		assert.equal(f.state.branch, "main");
	}
	// 项目移除 / locator 改变：GIT_TARGET_CHANGED，不是缓存成功。
	{
		const f = fixture();
		await f.snapshot();
		const loads = f.statusLoads();
		f.state.hasLocator = false;
		assert.deepEqual(plain(await f.snapshot()), { ok: false, code: "GIT_TARGET_CHANGED" });
		assert.equal(f.statusLoads(), loads);
	}
	// sender 销毁：REQUEST_CANCELLED。
	{
		const f = fixture();
		await f.snapshot();
		const loads = f.statusLoads();
		f.sender.destroyNow();
		assert.deepEqual(plain(await f.snapshot()), { ok: false, code: "REQUEST_CANCELLED" });
		assert.equal(f.statusLoads(), loads);
	}
	// IPC dispose：REQUEST_CANCELLED，且不再打开 helper。
	{
		const f = fixture();
		await f.snapshot();
		const loads = f.statusLoads();
		const hello = f.helloLoads();
		f.port.dispose();
		assert.deepEqual(plain(await f.snapshot()), { ok: false, code: "REQUEST_CANCELLED" });
		assert.equal(f.statusLoads(), loads);
		assert.equal(f.helloLoads(), hello);
	}
	// host 离线：SSH_HOST_NOT_READY，不返回暖缓存、不自动重连。
	{
		const f = fixture();
		await f.snapshot();
		const loads = f.statusLoads();
		const hello = f.helloLoads();
		f.state.ready = "offline";
		assert.deepEqual(plain(await f.snapshot()), { ok: false, code: "SSH_HOST_NOT_READY" });
		assert.equal(f.statusLoads(), loads);
		assert.equal(f.helloLoads(), hello, "拒绝不得触发任何 helper 往返");
		// 没有 manager（connectionFacts undefined）同样拒绝。
		f.state.connectionId = undefined;
		assert.deepEqual(plain(await f.snapshot()), { ok: false, code: "SSH_HOST_NOT_READY" });
		assert.equal(f.helloLoads(), hello);
	}
});

test("R6：同一 host store revision 下换代（重连/换 root）后旧缓存与迟到读都不能发布", async () => {
	const f = fixture();
	await f.snapshot();
	assert.equal(f.statusLoads(), 1);

	// 迟到的旧代装载：gate 住 status，等它真正发出后再换代。
	const gate = deferred();
	f.state.statusGate = gate;
	const late = f.snapshot(f.sender, "", true);
	await settle();
	assert.equal(f.statusLoads(), 2, "旧代读已经发出");

	f.state.connectionId = "conn-2";
	f.state.branch = "feature";
	f.state.statusGate = null;
	const fresh = await f.snapshot();
	assert.equal(fresh.ok, true);
	assert.equal(fresh.snapshot.branch, "feature", "旧代缓存不得代表新代");
	assert.equal(f.statusLoads(), 3);

	gate.resolve();
	const retired = await late;
	assert.equal(retired.ok, false);
	assert.equal(retired.code, "REQUEST_CANCELLED", "退休的旧代读不发布旧成功");
});

test("R7：显式 refresh 越过已完成缓存；并发刷新合并成一次同 scope 装载", async () => {
	const f = fixture();
	await f.snapshot();
	assert.equal(f.statusLoads(), 1);

	// 外部改了文件：普通读仍命中缓存（旧事实），显式 refresh 才重新核对。
	f.state.branch = "feature";
	const cached = await f.snapshot();
	assert.equal(cached.snapshot.branch, "main");
	assert.equal(f.statusLoads(), 1);

	const refreshed = await f.snapshot(f.sender, "", true);
	assert.equal(refreshed.ok, true);
	assert.equal(refreshed.snapshot.branch, "feature");
	assert.equal(f.statusLoads(), 2);

	// 刷新后的同一份事实仍可被树/面板共享：普通读命中，不重复打远端。
	f.state.branch = "feature";
	const shared = await f.status();
	assert.equal(shared.workingTree[0].path, "tracked.txt");
	assert.equal(f.statusLoads(), 2);

	// 两个消费者同时显式刷新：超过缓存后仍合并成一次装载。
	const gate = deferred();
	f.state.statusGate = gate;
	const first = f.snapshot(f.sender, "", true);
	const second = f.snapshot(f.makeSender(2), "", true);
	await settle();
	assert.equal(f.statusLoads(), 3, "并发刷新只付一次往返");
	gate.resolve();
	f.state.statusGate = null;
	const [a, b] = await Promise.all([first, second]);
	assert.equal(a.ok, true);
	assert.equal(b.ok, true);
	assert.equal(f.statusLoads(), 3);
});

test("R8：写已发出但超时 → 保留 unknown、标脏而不重放，下一次明确读新事实", async () => {
	const f = fixture();
	const snapshot = await f.snapshot();
	assert.equal(snapshot.ok, true);
	const token = snapshot.snapshot.mutationToken;
	assert.ok(token, "write fixture needs an index grant");

	f.state.writeTimeout = true;
	const loads = f.statusLoads();
	const written = await f.handlers.get(ipcChannels.gitRemoteMutateIndex)({ sender: f.sender }, projectId, "stage", "workingTree", { projectId, relativePath: "tracked.txt" }, token);
	assert.deepEqual(plain(written), { ok: false, code: "GIT_WRITE_RESULT_UNCONFIRMED" });
	assert.equal(f.calls.filter((call) => call.method === "git.stage").length, 1, "unknown 写绝不重放");
	assert.equal(f.statusLoads(), loads, "unknown 只标脏，不自动读");

	// 下一次明确核对：重新装载，拿到新事实。
	f.state.writeTimeout = false;
	f.state.branch = "after-write";
	const checked = await f.snapshot();
	assert.equal(checked.ok, true);
	assert.equal(checked.snapshot.branch, "after-write");
	assert.equal(f.statusLoads(), loads + 1);
});

test("R9：两个 sender 共享一次读，一人取消拿不到成功，另一人仍可完成（不扩大撤销）", async () => {
	const f = fixture();
	const a = f.makeSender(11);
	const b = f.makeSender(12);
	const gate = deferred();
	f.state.statusGate = gate;

	const first = f.snapshot(a);
	const second = f.snapshot(b);
	await settle();
	assert.equal(f.statusLoads(), 1, "同 scope 两个读者只装载一次");
	f.handlers.get(ipcChannels.gitRemoteCancelReads)({ sender: { id: 11 } }, projectId);
	gate.resolve();
	f.state.statusGate = null;

	const [cancelled, completed] = await Promise.all([first, second]);
	assert.equal(cancelled.ok, false);
	assert.equal(cancelled.code, "REQUEST_CANCELLED", "取消者拿不到成功");
	assert.equal(cancelled.snapshot, undefined, "取消者不可能拿到 token");
	assert.equal(completed.ok, true);
	assert.equal(completed.snapshot.branch, "main", "另一个窗口的读不被撤销");
	assert.equal(f.calls.filter((call) => call.method === "cancel").length, 0, "取消不扩大为共享装载的撤销");
});

test("R10：畸形 status 或非法 revision 不入缓存；后续合法回复可以恢复", async () => {
	const f = fixture();
	f.state.statusReply = () => ({ status: "not-base64", head: oid("a"), branch: "main", revision: "c".repeat(64) });
	assert.deepEqual(plain(await f.snapshot()), { ok: false, code: "GIT_RESULT_INVALID" });
	assert.equal(f.statusLoads(), 1);

	f.state.statusReply = () => ({ ...okayStatus("main"), revision: "not-a-revision" });
	assert.deepEqual(plain(await f.snapshot()), { ok: false, code: "GIT_RESULT_INVALID" });
	assert.equal(f.statusLoads(), 2, "失败不缓存为事实，下一次会重新询问");

	f.state.statusReply = null;
	const recovered = await f.snapshot();
	assert.equal(recovered.ok, true);
	assert.equal(recovered.snapshot.branch, "main");
	assert.equal(f.statusLoads(), 3);
	// 恢复后的合法事实被缓存起来（不再反复拒绝）。
	await f.snapshot();
	assert.equal(f.statusLoads(), 3);
});

/* ------------------------------------------------------------ 目录 list 的暖缓存门禁 */

function dirFixture() {
	const handlers = new Map();
	const calls = { list: [] };
	const state = { connectionId: "conn-1", ready: "ready", hasLocator: true, entries: [{ name: "src", kind: "directory" }] };
	const { registerRemoteProjectIpc } = loadTsCommonJs("src/main/ipc/remoteProjectIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
			"../remote/RemoteBrowseRoot": {
				async resolveRemoteBrowseRoot() {
					return { canonicalPath: "/srv/app" };
				},
			},
			"../remote/RemoteSearchReader": {
				REMOTE_SEARCH_READER_CODES: { queryInvalid: "QUERY_INVALID", requestFailed: "REMOTE_WORKSPACE_REQUEST_FAILED", optionsInvalid: "REMOTE_WORKSPACE_READER_OPTIONS_INVALID" },
				createRemoteSearchReader: () => ({
					async search() {
						return { entries: [], scanned: 0, truncated: false };
					},
				}),
			},
			"../remote/RemoteWorkspaceReader": {
				createRemoteWorkspaceReader: () => ({
					async readFile() {
						return { content: Buffer.from("x"), bytes: 1, mtimeMs: 1 };
					},
				}),
			},
		},
	});
	const service = {
		async withProjectSession(_hostId, _root, task) {
			return { ok: true, value: await task({ request: async () => ({ watchId: "w1" }), cancel: async () => undefined }) };
		},
		// 项目事实与能力都按本项目 root 回答：主机在线或兄弟 root 的会话都不能替这个项目背书。
		projectConnectionFacts(_hostId, root) {
			if (state.connectionId === undefined) return undefined;
			if (root !== locator.remotePath) return undefined;
			return { connectionId: state.connectionId, state: state.ready };
		},
		projectHelperCapabilities() {
			return ["fs.watch"];
		},
	};
	registerRemoteProjectIpc({
		enabled: true,
		userDataDir: "/tmp/unused",
		service: async () => service,
		directoryReader: {
			async read({ relative }) {
				calls.list.push(relative === "" ? "." : relative);
				return { ok: true, value: { entries: state.entries, scanned: state.entries.length, truncated: false } };
			},
		},
		projects: {
			enroll: async () => ({ projectId: "p1" }),
			locator: (id) => (id === "p1" && state.hasLocator ? { kind: "ssh", hostId: locator.hostId, remotePath: locator.remotePath } : undefined),
		},
	});
	const list = (path) => handlers.get("remote:project-list")({}, "p1", path);
	return { calls, state, list };
}

test("目录暖缓存也要逐次过边界：host 离线、项目移除、换代都不返回旧目录成功", async () => {
	const f = dirFixture();
	const first = await f.list("");
	assert.equal(first.ok, true);
	assert.equal(f.calls.list.length, 1);

	// host 离线：暖缓存不得冒充成功。
	f.state.ready = "offline";
	assert.equal((await f.list("")).code, "SSH_HOST_NOT_READY");
	assert.equal(f.calls.list.length, 1, "拒绝不触发远端往返");
	// 没有 manager（connectionFacts undefined）同样拒绝。
	f.state.connectionId = undefined;
	assert.equal((await f.list("")).code, "SSH_HOST_NOT_READY");
	assert.equal(f.calls.list.length, 1);

	// 项目移除：当前项目解析失败，旧目录不能继续服务。
	f.state.hasLocator = false;
	assert.equal((await f.list("")).ok, false);
	assert.equal(f.calls.list.length, 1);

	// 换连接代：旧目录事实不发布，下一次读重新装载。
	f.state.hasLocator = true;
	f.state.connectionId = "conn-2";
	f.state.ready = "ready";
	f.state.entries = [{ name: "docs", kind: "directory" }];
	const next = await f.list("");
	assert.equal(next.ok, true);
	assert.equal(f.calls.list.length, 2);
	assert.deepEqual(plain(next.value.entries), [{ name: "docs", kind: "directory" }]);
	assert.ok(next.value.revision > first.value.revision);
});

/* ------------------------------------------------------------ renderer 显式刷新接线 */

test("renderer 控制器的显式刷新走 force 通道；普通刷新仍走缓存读", async () => {
	const { createRemoteGitViewController } = loadTsCommonJs("src/renderer/src/utils/remoteGitViewState.ts");
	const snapshot = { head: oid("a"), branch: "main", groups: { merge: [], index: [], workingTree: [], untracked: [] } };
	const calls = [];
	const controller = createRemoteGitViewController(
		projectId,
		"identity",
		{
			cancelRemoteReads: async () => {},
			status: async () => {
				calls.push("cached");
				return { ok: true, snapshot };
			},
			refresh: async () => {
				calls.push("forced");
				return { ok: true, snapshot: { ...snapshot, branch: "feature" } };
			},
			branches: async () => ({ ok: true, info: { current: "main", branches: ["main"] } }),
		},
		() => undefined,
	);
	await controller.refresh();
	assert.deepEqual(calls, ["cached"], "普通读不越过缓存");
	await controller.refresh(true);
	assert.deepEqual(calls, ["cached", "forced"], "显式刷新必须走 force");
});
