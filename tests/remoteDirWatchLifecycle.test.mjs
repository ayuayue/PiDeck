import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createDirWatchRegistry, DIR_WATCH_LIMITS, dirKeysAfterWrite } = loadTsCommonJs("src/main/remote/RemoteDirWatchRegistry.ts");

const HOST = "11111111-1111-4111-8111-111111111111";
const PROJECT = "project-remote-1";
const PROJECT_2 = "project-remote-2";
/** 会话身份 = `RemoteProjectSession.connectionId`：`hostId#managerToken#generation`。 */
const connOf = (managerToken, generation) => HOST + "#" + managerToken + "#" + generation;

const plain = (value) => JSON.parse(JSON.stringify(value));

function deferred() {
	let resolve;
	const promise = new Promise((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

/**
 * T2（v5 §10.3）+ 池化 B3：目录订阅的身份必须来自真实 helper 生命周期，而不是每次读新建的 session 包装对象。
 *
 * 旧实现的洞（F6）：`ensure(host, session, ...)` 把包装对象本身当会话身份。`establishProjectSession`
 * 每次读都返回新对象，于是同一 helper 的根目录重读被当成「换了会话」，反复 `fs.watch`；helper 只有
 * 4 个 watcher，第 5 次申请被拒后登记表已被清，后续事件全部失效。
 *
 * 池化后同主机可以同时存在多条 helper 会话，所以登记表从「host → 一代」升级为「host → sessionKey →
 * 一代」，上界也从「每主机 4 个」变成「每会话 4 个」。这组用例按新契约演进旧断言：
 * - 「换代清登记」不再是登记表的职责：登记表无法分辨「同一 root 的新一代」与「兄弟 root 的并行会话」
 *   （两者在 sessionKey 上同样只是另一个 id），自动丢弃会误杀池里其它 root 的登记。换代由持有
 *   generation 的调用方表达（`releaseHost(hostId, 旧sessionKey)` / deep watch 的
 *   `releaseProjectInSession`），登记表保证：旧会话的 watchId **只**属于旧会话，新会话绝不认它，
 *   清理也绝不跨会话。
 * - 「在途订阅不跨代登记」保留并加强：在途订阅只能登记到发起它的会话；会话先被释放时，迟到的
 *   watchId 会被成对收回（见 remoteDirWatchSessionIsolation.test.mjs 最后一条）。
 * - 「32 路径分块」不变，只是预算按会话计（见 remoteDirWatchSessionIsolation.test.mjs）。
 * 这里同时钉登记表本身的并发合并/换代隔离/成对退订/拒绝超限，以及生产接线（remoteProjectIpc）。
 */
test("同 key 并发 ensure 只发一次订阅；路径去重后不重复订阅", async () => {
	const registry = createDirWatchRegistry();
	const conn = connOf("m1", 1);
	const gate = deferred();
	let subscriptions = 0;
	const subscribe = async () => {
		subscriptions += 1;
		return await gate.promise;
	};
	const first = registry.ensure(HOST, conn, PROJECT, subscribe);
	const second = registry.ensure(HOST, conn, PROJECT, subscribe);
	assert.equal(subscriptions, 1, "同 (连接, 项目) 的并发 ensure 必须合并成一次请求");
	gate.resolve("w1");
	await Promise.all([first, second]);
	await registry.ensure(HOST, conn, PROJECT, subscribe);
	assert.equal(subscriptions, 1, "已登记的项目不重复订阅");
	assert.deepEqual(plain(registry.scopesForEvent(HOST, conn, "w1")), [{ projectId: PROJECT, paths: [""] }]);
});

test("换会话不串：新会话不认旧会话的 watchId，旧会话的登记仍只属于旧会话", async () => {
	const registry = createDirWatchRegistry();
	const oldConn = connOf("m1", 1);
	const newConn = connOf("m1", 2);
	await registry.ensure(HOST, oldConn, PROJECT, async () => "w1");
	await registry.ensure(HOST, newConn, PROJECT, async () => "w2");
	assert.deepEqual(plain(registry.scopesForEvent(HOST, newConn, "w2")), [{ projectId: PROJECT, paths: [""] }]);
	assert.equal(registry.scopesForEvent(HOST, newConn, "w1"), undefined, "旧 helper 的 watchId 在新会话里必须失效");
	assert.deepEqual(plain(registry.scopesForEvent(HOST, oldConn, "w1")), [{ projectId: PROJECT, paths: [""] }], "旧登记只属于旧会话，等它的释放来清");
	assert.equal(registry.sizeOfSession(HOST, newConn), 1);
	assert.equal(registry.sizeOfSession(HOST, oldConn), 1);
});

test("清理不跨会话：释放旧会话只退订它自己的 watcher，不动新会话", async () => {
	const registry = createDirWatchRegistry();
	const oldConn = connOf("m1", 1);
	const newConn = connOf("m1", 2);
	const unwatched = [];
	const unwatch = async (watchId) => {
		unwatched.push(watchId);
	};
	await registry.ensure(HOST, oldConn, PROJECT, async () => "w1", { unwatch });
	await registry.ensure(HOST, newConn, PROJECT, async () => "w2", { unwatch });

	await registry.releaseHost(HOST, oldConn);
	assert.deepEqual(unwatched, ["w1"], "只退订被释放会话自己的 watcher");
	assert.equal(registry.scopesForEvent(HOST, oldConn, "w1"), undefined);
	assert.deepEqual(plain(registry.scopesForEvent(HOST, newConn, "w2")), [{ projectId: PROJECT, paths: [""] }]);

	await registry.releaseHost(HOST, newConn);
	assert.deepEqual(unwatched, ["w1", "w2"], "各自释放时才成对退订");
	assert.equal(registry.sizeOf(HOST), 0);
});

test("releaseProject / closeProject 只退订对应项目；clearHost 丢弃但不发退订", async () => {
	const registry = createDirWatchRegistry();
	const conn = connOf("m1", 1);
	const unwatched = [];
	const unwatch = async (watchId) => {
		unwatched.push(watchId);
	};
	await registry.ensure(HOST, conn, PROJECT, async () => "w1", { unwatch });
	await registry.ensure(HOST, conn, PROJECT_2, async () => "w2", { unwatch });

	await registry.releaseProject(HOST, PROJECT);
	assert.deepEqual(unwatched, ["w1"]);
	assert.equal(registry.scopesForEvent(HOST, conn, "w1"), undefined);
	assert.deepEqual(plain(registry.scopesForEvent(HOST, conn, "w2")), [{ projectId: PROJECT_2, paths: [""] }]);

	registry.clearHost(HOST);
	assert.equal(registry.sizeOf(HOST), 0, "断连后登记直接丢弃");
	assert.deepEqual(unwatched, ["w1"], "helper 已死时不再发退订");
});

test("超限拒绝而不是排队：每会话最多 4 个 watcher，每个最多 32 条路径（33 条拆成两个）", async () => {
	const registry = createDirWatchRegistry();
	const conn = connOf("m1", 1);
	const requests = [];
	let seq = 0;
	const subscribe = async (paths) => {
		seq += 1;
		requests.push([...paths]);
		return "w" + seq;
	};
	const paths = Array.from({ length: 33 }, (_, index) => "dir" + index);
	await registry.ensure(HOST, conn, PROJECT, subscribe, { paths: ["root", ...paths] });
	assert.equal(requests.length, 2, "34 条路径 = 32 + 2，两次请求，每次都不超 32");
	assert.equal(requests[0].length, DIR_WATCH_LIMITS.pathsPerWatcher);
	assert.equal(requests[1].length, 2);

	// 到上限后再要新的项目：不发请求、不登记（订阅是降级能力，不能假装成功）。
	for (let index = 0; index < 2; index += 1) await registry.ensure(HOST, conn, "extra-" + index, subscribe);
	assert.equal(registry.sizeOfSession(HOST, conn), DIR_WATCH_LIMITS.watchersPerSession);
	const before = requests.length;
	const over = await registry.ensure(HOST, conn, "one-more", subscribe);
	assert.equal(over.rejected, 1, "第 5 个 watcher 必须是拒绝，不是排队");
	assert.equal(requests.length, before, "拒绝时一个请求都不该发");
	assert.equal(registry.sizeOfSession(HOST, conn), DIR_WATCH_LIMITS.watchersPerSession);
});

test("dirKeysAfterWrite 仍用项目与目录的真实键（NUL 分隔），不退回空格", () => {
	const key = (path) => PROJECT + String.fromCharCode(0) + path;
	assert.deepEqual(plain(dirKeysAfterWrite(PROJECT, ["src/a.ts"])).sort(), [key(""), key("src")].sort());
});

/* ---------------------------------------------------------------- 生产接线 */

function ipcHarness() {
	const calls = { list: [], watches: [], unwatches: [], keepAlive: [] };
	const handlers = new Map();
	const state = { connectionId: "conn-1", seq: 0, watchFails: false, watchGate: undefined };
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
					async list(_hostId, path) {
						calls.list.push(path);
						return { entries: [{ name: "src", kind: "directory" }] };
					},
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
		service: async () => ({
			withProjectSession: async (_hostId, _root, task) => ({
				ok: true,
				// 真实服务每次读都返回一个新的 session 包装；身份只由 connectionId 表达。
				value: await task({
					connectionId: state.connectionId,
					request: async (method, params) => {
						if (method === "fs.watch") {
							calls.watches.push({ paths: [...params.paths], connectionId: state.connectionId });
							if (state.watchFails) throw new Error("REMOTE_WORKSPACE_UNSUPPORTED");
							if (state.watchGate !== undefined) await state.watchGate.promise;
							state.seq += 1;
							return { watchId: "w" + state.seq };
						}
						if (method === "fs.unwatch") {
							calls.unwatches.push(params.watchId);
							return { ok: true };
						}
						throw new Error("UNEXPECTED_METHOD");
					},
					cancel: async () => undefined,
				}),
			}),
			// 项目事实/能力按本项目的 root 查询（同主机兄弟 root 不冒充）。
			projectConnectionFacts: (hostId, root) => (hostId === HOST && root === "/srv/app" ? { connectionId: state.connectionId, state: "ready" } : undefined),
			projectHelperCapabilities: (hostId, root) => (hostId === HOST && root === "/srv/app" ? ["fs.watch"] : undefined),
			// 池化保活端口（真实服务按 (hostId, canonicalRoot) 记账；这里只记录调用，断言保活配对）。
			retainProjectSessionWatch: (hostId, root) => calls.keepAlive.push({ kind: "retain", hostId, root }),
			releaseProjectSessionWatch: (hostId, root) => calls.keepAlive.push({ kind: "release", hostId, root }),
		}),
		projects: {
			enroll: async () => ({ projectId: PROJECT }),
			locator: (projectId) => ([PROJECT, PROJECT_2].includes(projectId) ? { kind: "ssh", hostId: HOST, remotePath: "/srv/app" } : undefined),
		},
	});

	const list = (projectId, path) => handlers.get("remote:project-list")({}, projectId, path);
	return { calls, state, facts, list };
}

test("同 connectionId 的新 session 包装只订阅一次（F6：不再被 4 watcher 上限打成失效）", async () => {
	const h = ipcHarness();
	await h.list(PROJECT, "");
	assert.equal(h.calls.watches.length, 1, "根目录第一次读到就订阅");
	assert.deepEqual(h.calls.watches[0].paths, [""]);
	assert.deepEqual(h.calls.keepAlive, [{ kind: "retain", hostId: HOST, root: "/srv/app" }], "会话第一次有 watch 时向池保活一次");

	// 每次重读都是一个新包装对象：这正是旧实现误判为“换了会话”的地方。
	for (let index = 0; index < 4; index += 1) {
		h.facts.afterWrite(PROJECT, ["src/a.ts"]);
		await h.list(PROJECT, "");
	}
	assert.equal(h.calls.list.length, 5);
	assert.equal(h.calls.watches.length, 1, "同一 helper 会话只允许一个 watcher，不能被包装对象骗出 5 个");
	assert.equal(h.calls.keepAlive.length, 1, "watcher 仍挂着时重复读不再 retain（保活计数不漂）");
});

test("换 connectionId 才重新订阅；事件按会话身份路由，绝不串到别的会话", async () => {
	const h = ipcHarness();
	await h.list(PROJECT, "");
	assert.equal(h.calls.watches.length, 1);

	h.state.connectionId = "conn-2";
	h.facts.afterWrite(PROJECT, ["src/a.ts"]);
	await h.list(PROJECT, "");
	assert.equal(h.calls.watches.length, 2, "重连/换代后要在新 helper 上重新订阅");
	assert.deepEqual(
		h.calls.keepAlive.map((entry) => entry.kind),
		["retain", "release", "retain"],
		"旧会话的保活随换代归还，新会话重新保活（严格配对）",
	);

	const listCalls = h.calls.list.length;
	// 同主机两条会话（旧 helper 的登记还没被 releaseHost 清掉）：事件必须带会话身份，旧会话 id 在新会话里无效。
	h.facts.onHelperEvent({ hostId: HOST, sessionKey: "conn-1", watchId: "w2", paths: [""] });
	await h.list(PROJECT, "");
	assert.equal(h.calls.list.length, listCalls, "别的会话的 watchId 不得标脏本项目");

	h.facts.onHelperEvent({ hostId: HOST, sessionKey: "conn-2", watchId: "w1", paths: [""] });
	await h.list(PROJECT, "");
	assert.equal(h.calls.list.length, listCalls, "旧会话的 watchId 在新会话里不得标脏");

	h.facts.onHelperEvent({ hostId: HOST, sessionKey: "conn-2", watchId: "w2", paths: [""] });
	await h.list(PROJECT, "");
	assert.equal(h.calls.list.length, listCalls + 1, "当前会话的事件只标脏，下一次读才装载");
});

test("dispose 成对退订；onHostDisconnected 丢弃登记且不发退订", async () => {
	const h = ipcHarness();
	await h.list(PROJECT, "");
	await h.facts.dispose();
	assert.deepEqual(h.calls.unwatches, ["w1"], "进程退出前退订已登记的 watcher");
	assert.deepEqual(
		h.calls.keepAlive.map((entry) => entry.kind),
		["retain", "release"],
		"进程退出时归还保活计数",
	);

	const second = ipcHarness();
	await second.list(PROJECT, "");
	second.facts.onHostDisconnected(HOST);
	assert.deepEqual(second.calls.unwatches, [], "helper 已死时不能把退订发给新会话");
	assert.deepEqual(
		second.calls.keepAlive.map((entry) => entry.kind),
		["retain", "release"],
		"断连丢弃登记时也要归还保活计数，否则池的 watchers 计数会漂",
	);
	second.facts.afterWrite(PROJECT, ["src/a.ts"]);
	await second.list(PROJECT, "");
	assert.equal(second.calls.watches.length, 2, "断连后下一次读重新订阅");
});

test("closeProject 只退订该项目；订阅失败不把目录读取变成失败", async () => {
	const h = ipcHarness();
	await h.list(PROJECT, "");
	await h.list(PROJECT_2, "");
	const [first, second] = h.calls.watches.map((watch) => watch.connectionId);
	assert.equal(first, second);
	await h.facts.closeProject(PROJECT);
	assert.deepEqual(h.calls.unwatches, ["w1"]);
	assert.deepEqual(
		h.calls.keepAlive.map((entry) => entry.kind),
		["retain"],
		"另一个项目还在监听时不能提前 release",
	);
	assert.equal(h.facts.dirLoads(), 2);

	const failing = ipcHarness();
	failing.state.watchFails = true;
	const listed = await failing.list(PROJECT, "");
	assert.equal(listed.ok, true, "订阅不是读的前置条件：helper 不支持 watch 时列表仍然成功");
	assert.equal(failing.calls.watches.length, 1, "订阅请求发过一次");
	assert.deepEqual(failing.calls.unwatches, [], "没有 watchId 就不登记、也不退订");
});
