import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * P0-1：远端 Git 写成功后，文件树必须失效——但**不能**把它做成「根目录事件」。
 *
 * 三个断言面：
 * 1. `lazyDirTree` 收到 `{kind:"tree"}`：重读根与**全部已加载目录**，保留展开集/currentDir，不清空树；
 *    根目录 `dir` 事件只重读根，不连带深层目录。
 * 2. `remoteGitReadIpc` 的写成功与 `GIT_WRITE_RESULT_UNCONFIRMED` 两条路径都发布 status + tree。
 * 3. 主进程目录事实缓存暴露 `invalidateTree(projectId)`：只标脏该项目的目录键，不装载、不碰别的项目。
 */
const { createLazyDirTreeController } = loadTsCommonJs("src/renderer/src/utils/lazyDirTree.ts");
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/* --------------------------------------------------------------- 文件树 */

function file(name) {
	return { name, path: name, relativePath: name, type: "file" };
}
function dir(name, hasChildren = true) {
	return { name, path: name, relativePath: name, type: "directory", hasChildren };
}
function page(nodes, { revision = 1, generation = "g1" } = {}) {
	return { ok: true, page: { nodes, revision, generation } };
}
function deferred() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function treeHarness() {
	const calls = [];
	const pending = [];
	const loader = (path, force) => {
		calls.push({ dir: path, force });
		const request = deferred();
		pending.push({ dir: path, force, request });
		return request.promise;
	};
	return { loader, calls, pending };
}

/** 根 + 一个已展开目录：`a` 已加载、`b` 只在根层可见（未加载）。 */
async function loadedTree(h) {
	const controller = createLazyDirTreeController(h.loader);
	const root = controller.load("");
	h.pending[0].request.resolve(page([dir("a"), dir("b")]));
	await root;
	controller.toggle("a");
	h.pending[1].request.resolve(page([file("x")]));
	await tick();
	controller.setCurrentDir("a");
	h.calls.length = 0;
	h.pending.length = 0;
	return controller;
}

test("tree scope：重读根与全部已加载目录，保留展开集与 currentDir，不清空树", async () => {
	const h = treeHarness();
	const controller = await loadedTree(h);
	const before = controller.getState();

	controller.applyFactsChange({ projectId: "p", generation: "g1", scopes: [{ kind: "tree" }] });
	assert.deepEqual(
		h.calls.map((call) => [call.dir, call.force]),
		[
			["", true],
			["a", true],
		],
		"重读根与已加载目录；未加载的 b 不产生请求",
	);
	const during = controller.getState();
	assert.equal(during.listed, true, "重读期间不得把树清空");
	assert.deepEqual(
		during.nodes.map((node) => node.name),
		["a", "b"],
		"tree scope 不是整树重置：旧内容在重读落地前仍在",
	);
	assert.deepEqual([...during.expanded], ["a"], "展开集必须保留");
	assert.equal(during.currentDir, "a", "当前目录必须保留");
	assert.equal(during.nodes, before.nodes, "重读开始不重建 nodes：内容代次不空转");

	h.pending[0].request.resolve(page([dir("a"), dir("b"), file("new")]));
	h.pending[1].request.resolve(page([file("y")]));
	await tick();
	const after = controller.getState();
	assert.deepEqual(
		after.nodes.map((node) => node.name),
		["a", "b", "new"],
		"新事实必须落地",
	);
	assert.deepEqual(
		after.nodes[0].children.map((node) => node.name),
		["y"],
		"已加载目录也要换成新内容",
	);
	assert.deepEqual([...after.expanded], ["a"]);
	assert.equal(after.currentDir, "a");
});

test("根目录 dir scope 只重读根，不连带重读已加载的深层目录", async () => {
	const h = treeHarness();
	const controller = await loadedTree(h);

	controller.applyFactsChange({ projectId: "p", generation: "g1", scopes: [{ kind: "dir", path: "" }] });
	assert.deepEqual(
		h.calls.map((call) => [call.dir, call.force]),
		[["", true]],
		"根事件不是全树失效：深层目录的事件由自己的 dir scope 负责",
	);
	h.pending[0].request.resolve(page([dir("a"), dir("b")]));
	await tick();
	// 根重读不影响已加载的 a：它的子项仍来自自己的事实。
	assert.deepEqual(
		controller.getState().nodes[0].children.map((node) => node.name),
		["x"],
	);
});

test("tree scope 与 dir scope 同时到达只重读一次（不叠加请求）", async () => {
	const h = treeHarness();
	const controller = await loadedTree(h);
	controller.applyFactsChange({
		projectId: "p",
		generation: "g1",
		scopes: [{ kind: "tree" }, { kind: "dir", path: "a" }],
	});
	assert.deepEqual(h.calls.map((call) => call.dir).sort(), ["", "a"], "tree 已覆盖全部已加载目录，dir 不应再发第二次");
	for (const request of h.pending) request.request.resolve(page([file("z")]));
	await tick();
});

/* ------------------------------------------------- 远端 Git 写的发布路径 */

const PROJECT = "remote-project";
const HOST = "remote-host";
const locator = { kind: "ssh", hostId: HOST, remotePath: "/workspace/project" };
const oid = (char) => char.repeat(40);
const statusAnswer = { status: Buffer.from("").toString("base64"), head: oid("a"), branch: "main", revision: "a".repeat(64) };
const capabilities = ["git.status", "git.switchBranch"];

/** 与 remoteGitReadIpc.test.mjs 同一套驱动方式：真 handler + 假 helper 会话 + 记录的 facts hub。 */
function gitFixture(overrides = {}) {
	const handlers = new Map();
	const published = [];
	const { registerRemoteGitReadIpc } = loadTsCommonJs("src/main/ipc/remoteGitReadIpc.ts", { stubs: { electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) } } } });
	const sender = new (class extends EventEmitter {
		constructor() {
			super();
			this.id = 1;
		}
		isDestroyed() {
			return this.destroyed === true;
		}
	})();
	sender.destroyed = false;
	const state = { destroyDuringWrite: false, factLookups: [] };
	const session = {
		hostRevision: 1,
		request: async (method, params, options) => {
			options?.onRequestId?.("request-id");
			if (method === "hello") return { protocolVersion: 1, root: locator.remotePath, capabilities };
			if (method === "git.status") return statusAnswer;
			if (method === "git.switchBranch") {
				if (state.destroyDuringWrite) {
					sender.destroyed = true;
					sender.emit("destroyed");
				}
				return { applied: true, branch: params.name, head: oid("a") };
			}
			throw new Error("UNEXPECTED_METHOD");
		},
		cancel: async () => undefined,
	};
	const port = registerRemoteGitReadIpc({
		enabled: true,
		locator: (id) => (id === PROJECT ? locator : undefined),
		trusted: async () => true,
		service: async () => ({
			// 项目读的事实入口按 (hostId, 项目 root) 查询：通知里的代必须来自这个项目的 root 会话；
			// root 不匹配一律 undefined（兄弟 root 的会话不能替本项目担保）。
			projectConnectionFacts: (hostId, root) => {
				state.factLookups.push([hostId, root]);
				return hostId === HOST && root === locator.remotePath ? { connectionId: "conn-1", state: "ready" } : undefined;
			},
			withProjectSession: async (_hostId, _root, work) => ({ ok: true, value: await work(session) }),
		}),
		factsEvents: { publish: (change) => published.push(change) },
		...overrides,
	});
	const event = { sender };
	return { port, handlers, published, sender, state, event };
}

async function switchBranch(f) {
	const snap = await f.handlers.get(ipcChannels.gitRemoteSnapshot)(f.event, PROJECT);
	assert.equal(snap.ok, true);
	assert.ok(snap.snapshot.switchToken, "快照必须签发 switch 授权");
	return await f.handlers.get(ipcChannels.gitRemoteSwitchBranch)(f.event, PROJECT, "feature", snap.snapshot.switchToken, undefined);
}

test("Git 写成功：发布 status + tree 两个事实 scope", async () => {
	const f = gitFixture();
	const result = await switchBranch(f);
	assert.equal(result.ok, true);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(f.published.length, 1);
	assert.equal(f.published[0].projectId, PROJECT);
	assert.equal(f.published[0].generation, "conn-1", "通知携带连接代");
	assert.deepEqual([...new Set(f.state.factLookups.map(([, root]) => root))], [locator.remotePath], "事实只按项目自己的 root 查询（兄弟 root 不参与）");
	const scopes = plain(f.published[0].scopes);
	assert.deepEqual(
		scopes.find((scope) => scope.kind === "status"),
		{ kind: "status", repoPath: "" },
	);
	assert.deepEqual(
		scopes.find((scope) => scope.kind === "tree"),
		{ kind: "tree" },
	);
});

test("Git 写结果未知（GIT_WRITE_RESULT_UNCONFIRMED）：同样失效树与 status，不重放写", async () => {
	const f = gitFixture();
	f.state.destroyDuringWrite = true;
	const result = await switchBranch(f);
	assert.equal(result.ok, false);
	assert.equal(result.code, "GIT_WRITE_RESULT_UNCONFIRMED");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(f.published.length, 1, "未知结果也要发一次失效");
	const scopes = plain(f.published[0].scopes);
	assert.deepEqual(
		scopes.find((scope) => scope.kind === "status"),
		{ kind: "status", repoPath: "" },
	);
	assert.deepEqual(
		scopes.find((scope) => scope.kind === "tree"),
		{ kind: "tree" },
	);
});

/* --------------------------------------------------- 主进程目录事实失效 */

const HOST_ID = "6f1b7c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const P1 = "project-remote-1";
const P2 = "project-remote-2";

function projectHarness() {
	const calls = { list: [], keepAlive: [] };
	const handlers = new Map();
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
	const facts = registerRemoteProjectIpc({
		enabled: true,
		userDataDir: "/tmp/unused",
		directoryReader: {
			async read({ relative }) {
				calls.list.push(relative === "" ? "." : relative);
				const entries = [{ name: "src", kind: "directory" }];
				return { ok: true, value: { entries, scanned: entries.length, truncated: false } };
			},
		},
		service: async () => ({
			withProjectSession: async (_hostId, _root, task) => ({
				ok: true,
				value: await task({
					connectionId: "conn-1",
					request: async (method) => (method === "fs.watch" ? { watchId: "w1" } : { ok: true }),
					cancel: async () => undefined,
				}),
			}),
			// 暖缓存围栏按本项目 root 的会话查询；root 不匹配是 undefined（同主机兄弟 root 不冒充）。
			projectConnectionFacts: (hostId, root) => (hostId === HOST_ID && root === "/srv/app" ? { connectionId: "conn-1", state: "ready" } : undefined),
			// 目录订阅保活：0→1 retain、退订清空 release（池的 watchers 计数是加减法）。
			retainProjectSessionWatch: (hostId, root) => calls.keepAlive.push({ kind: "retain", hostId, root }),
			releaseProjectSessionWatch: (hostId, root) => calls.keepAlive.push({ kind: "release", hostId, root }),
		}),
		projects: {
			enroll: async () => ({ projectId: P1 }),
			locator: (projectId) => ([P1, P2].includes(projectId) ? { kind: "ssh", hostId: HOST_ID, remotePath: "/srv/app" } : undefined),
		},
	});
	const list = (projectId, path) => handlers.get(ipcChannels.remoteProjectList)({}, projectId, path);
	return { calls, facts, list };
}

test("invalidateTree：只标脏该项目的目录事实，不装载、不碰别的项目", async () => {
	const h = projectHarness();
	await h.list(P1, "src");
	await h.list(P2, "src");
	assert.equal(h.calls.list.length, 2);
	h.facts.invalidateTree(P1);
	assert.equal(h.calls.list.length, 2, "失效只标脏，不装载");
	// 别的项目仍是命中。
	await h.list(P2, "src");
	assert.equal(h.calls.list.length, 2, "invalidateTree 不得波及其它项目");
	// 本项目下一次读才付往返。
	const after = await h.list(P1, "src");
	assert.equal(h.calls.list.length, 3);
	assert.equal(after.ok, true);
});

test("目录订阅保活：根目录首读 retain 一次，关闭项目 release 恰好一次", async () => {
	const h = projectHarness();
	await h.list(P1, "");
	assert.deepEqual(h.calls.keepAlive, [{ kind: "retain", hostId: HOST_ID, root: "/srv/app" }], "0→1 retain 一次");
	await h.list(P1, "");
	assert.equal(h.calls.keepAlive.length, 1, "watcher 仍挂着：重复读不再 retain");
	await h.facts.closeProject(P1);
	assert.deepEqual(
		h.calls.keepAlive.map((entry) => entry.kind),
		["retain", "release"],
		"关闭项目成对 release 一次",
	);
});
