import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 远程项目生命周期收尾（目录监听 + 池化回收）。
 *
 * 真实模块：RemoteRootSessionPool 负责 TTL/LRU/显式退休，remoteProjectIpc 负责目录事实缓存与
 * generation/host 归属；只把远端传输（reader / request）换成记账假端口。这样能验证：
 *
 * - 读目录形成缓存 → 关闭项目 → root 被 TTL/LRU 回收 → 重新打开必须建立新会话并成功读取；
 * - 正常回收只影响这一条 root，兄弟 root 的缓存/会话不受影响；用户显式断开不允许后台读复活；
 * - 关闭后才回来的目录读以 REQUEST_CANCELLED 收尾、旧写不把已清理的项目状态重新写回。
 */
const { createRootSessionPool } = loadTsCommonJs("src/main/remote/RemoteRootSessionPool.ts");

const HOST = "6f1b7c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const ROOT_A = "/srv/app-a";
const ROOT_B = "/srv/app-b";
const PROJECT_A = "project-remote-a";
const PROJECT_B = "project-remote-b";
const TTL_MS = 60_000;

const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
	let resolve;
	const promise = new Promise((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function harness(options = {}) {
	const calls = { list: [], watches: [], unwatches: [] };
	const published = [];
	const handlers = new Map();
	const established = [];
	const retired = [];
	const disconnected = { value: false };
	let gate = options.listGate;
	let clock = 1_000_000;
	let sequence = 0;
	let factsHandle;

	const { registerRemoteProjectIpc } = loadTsCommonJs("src/main/ipc/remoteProjectIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
			"../remote/RemoteBrowseRoot": {
				async resolveRemoteBrowseRoot() {
					return { canonicalPath: ROOT_A };
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
						if (gate !== undefined) {
							const pending = gate;
							gate = undefined;
							await pending.promise;
						}
						return { entries: options.entries ?? [{ name: "src", kind: "directory" }] };
					},
					async readFile() {
						return { content: Buffer.from("x"), bytes: 1, mtimeMs: 1 };
					},
				}),
			},
		},
	});

	const pool = createRootSessionPool({
		policy: { idleCapacity: 2, idleTtlMs: TTL_MS, maxEntries: 4, acquireTimeoutMs: 100, ...(options.policy ?? {}) },
		now: () => clock,
		establish: async ({ hostId, root }) => {
			sequence += 1;
			const session = {
				connectionId: hostId + "#m" + sequence + "#1",
				hostId,
				root,
				active: true,
				requests: [],
				async request(method, params) {
					session.requests.push({ method, params });
					// 退休后旧会话必须 fail closed：任何帧都不再到达 helper，更不会被重放到新会话。
					if (!session.active) throw new Error("SSH_HOST_NOT_READY");
					if (method === "fs.watch") {
						calls.watches.push({ sessionKey: session.connectionId, paths: [...params.paths] });
						return { watchId: "w-" + sequence + "-" + session.requests.filter((entry) => entry.method === "fs.watch").length };
					}
					if (method === "fs.unwatch") {
						calls.unwatches.push(params.watchId);
						return { ok: true };
					}
					return { ok: true };
				},
				async cancel() {
					return { ok: true };
				},
			};
			established.push(session);
			return session;
		},
		identity: (session) => session.connectionId,
		retire: async ({ value }) => {
			value.active = false;
			retired.push(value);
		},
		onRetired: (event) => factsHandle?.onRootRetired({ hostId: event.hostId, root: event.root, sessionKey: event.connectionId }),
	});

	const service = {
		async withProjectSession(hostId, root, task) {
			if (disconnected.value) return { ok: false, code: "SSH_HOST_DISCONNECTED" };
			const acquired = await pool.acquire({ hostId, root });
			if (!acquired.ok) return acquired;
			try {
				return { ok: true, value: await task(acquired.lease.value) };
			} finally {
				acquired.lease.release();
			}
		},
		projectConnectionFacts(hostId, root) {
			if (disconnected.value) return undefined;
			const entry = pool.peek(hostId, root);
			return entry === undefined ? undefined : { connectionId: entry.connectionId, state: "ready" };
		},
		projectHelperCapabilities(hostId, root) {
			return pool.peek(hostId, root) === undefined ? undefined : ["fs.watch"];
		},
		retainProjectSessionWatch(hostId, root, sessionKey) {
			pool.retainWatch(hostId, root, sessionKey);
		},
		releaseProjectSessionWatch(hostId, root, sessionKey) {
			pool.releaseWatch(hostId, root, sessionKey);
		},
	};

	const factsEvents = {
		publish(change) {
			published.push(change);
		},
		subscribe() {},
		unsubscribe() {},
		unsubscribeSender() {},
		subscriberCount() {
			return 0;
		},
	};

	factsHandle = registerRemoteProjectIpc({
		enabled: true,
		userDataDir: "/tmp/unused",
		service: async () => {
			// 需要验证「关闭恰好落在解析 target 的窗口」时，把服务工厂也变成可等待点。
			if (options.serviceGate !== undefined) await options.serviceGate.promise;
			return service;
		},
		factsEvents,
		projects: {
			enroll: async () => ({ projectId: PROJECT_A }),
			locator: (projectId) => (projectId === PROJECT_A ? { kind: "ssh", hostId: HOST, remotePath: ROOT_A } : projectId === PROJECT_B ? { kind: "ssh", hostId: HOST, remotePath: ROOT_B } : undefined),
		},
	});

	return {
		calls,
		pool,
		facts: factsHandle,
		service,
		published,
		established,
		retired,
		disconnected,
		list: (projectId, path = "") => handlers.get("remote:project-list")({}, projectId, path),
		advance: (ms) => {
			clock += ms;
		},
		now: () => clock,
	};
}

test("关闭项目后 root 经 TTL 退休：重新打开建立新会话并成功读取（旧缓存不得拦住）", async () => {
	const h = harness();
	const first = await h.list(PROJECT_A);
	assert.equal(first.ok, true);
	assert.equal(h.calls.list.length, 1);
	const firstSession = h.pool.peek(HOST, ROOT_A);
	assert.equal(firstSession.watchers, 1, "读根目录后 watcher 保活这条 root");
	const warm = await h.facts.directoryPage(PROJECT_A, "", false);
	assert.equal(warm.value.generation, firstSession.connectionId);

	await h.facts.closeProject(PROJECT_A);
	assert.equal(h.pool.peek(HOST, ROOT_A).watchers, 0, "关闭项目成对归还 watcher 保活");
	h.advance(TTL_MS + 1);
	await h.pool.sweep(h.now());
	assert.equal(h.pool.peek(HOST, ROOT_A), undefined, "空闲 root 被 TTL 回收");
	assert.equal(h.retired.length, 1);
	const establishedBefore = h.established.length;

	const loadsBeforeReopen = h.calls.list.length;
	const reopened = await h.list(PROJECT_A);
	assert.equal(reopened.ok, true, "重新打开必须重建会话并读成功，而不是 SSH_HOST_NOT_READY");
	assert.equal(h.established.length, establishedBefore + 1);
	assert.equal(h.calls.list.length, loadsBeforeReopen + 1, "旧目录缓存已清理，重新打开重新装载");
	assert.equal(h.calls.watches.length, 2, "新会话重新登记订阅");
	const fresh = await h.facts.directoryPage(PROJECT_A, "", false);
	assert.equal(fresh.value.generation, h.pool.peek(HOST, ROOT_A).connectionId);

	// 旧会话在退休后 fail closed；重新打开建立的新会话没有收到任何重放。
	const stale = h.established[0];
	await assert.rejects(stale.request("fs.write", { path: "src/a.ts" }), /SSH_HOST_NOT_READY/);
	assert.equal(
		h.established.at(-1).requests.some((entry) => entry.method === "fs.write"),
		false,
		"旧写不得重放到新会话",
	);
});

test("关闭项目后 root 经 LRU 退休（未到 TTL）：重新打开同样能成功读取", async () => {
	const h = harness({ policy: { idleCapacity: 0 } });
	await h.list(PROJECT_A);
	await h.facts.closeProject(PROJECT_A);
	assert.equal(h.pool.peek(HOST, ROOT_A).watchers, 0);
	// 没推进 TTL，只让空闲容量为 0：sweep 按 LRU 回收空闲条目。
	await h.pool.sweep(h.now());
	assert.equal(h.pool.peek(HOST, ROOT_A), undefined, "空闲容量 0 时按 LRU 退休");
	assert.equal(h.retired.length, 1);
	const loadsBefore = h.calls.list.length;
	const reopened = await h.list(PROJECT_A);
	assert.equal(reopened.ok, true, "LRU 正常回收后重新打开必须能读");
	assert.equal(h.calls.list.length, loadsBefore + 1);
	assert.notEqual(h.pool.peek(HOST, ROOT_A), undefined, "重新打开重新建立 root 会话");
});

test("正常回收只退休空闲 root：兄弟 root 的缓存与会话不受影响；显式断开不复活", async () => {
	const h = harness();
	await h.list(PROJECT_A);
	await h.list(PROJECT_B);
	// 第二次读让事实缓存记下当前 root 的连接代（首次冷读时还没有会话，缓存代为空）。
	await h.list(PROJECT_B);
	const sessionB = h.pool.peek(HOST, ROOT_B).value;
	assert.equal(h.pool.peek(HOST, ROOT_B).watchers, 1);

	await h.facts.closeProject(PROJECT_A);
	h.advance(TTL_MS + 1);
	await h.pool.sweep(h.now());
	assert.equal(h.pool.peek(HOST, ROOT_A), undefined, "A 是空闲 root，按 TTL 回收");
	assert.equal(h.pool.peek(HOST, ROOT_B).value, sessionB, "B 仍被 watcher 保活，TTL 不得动它");
	assert.equal(h.retired.length, 1);

	const listCallsBefore = h.calls.list.length;
	const b = await h.list(PROJECT_B);
	assert.equal(b.ok, true);
	assert.equal(h.calls.list.length, listCallsBefore, "兄弟 root 的暖缓存仍然有效，不得被 A 的退休清掉");

	// 用户显式断开：后台读只能报告断开，不能建立新会话把主机偷偷连回来。
	h.disconnected.value = true;
	await h.pool.retireHost(HOST, "explicit");
	const establishedBefore = h.established.length;
	const denied = await h.list(PROJECT_B);
	assert.equal(denied.ok, false);
	assert.equal(denied.code, "SSH_HOST_DISCONNECTED");
	assert.equal(h.established.length, establishedBefore, "显式断开后不得因一次读重新建会话");
});

test("关闭项目后迟到的目录读被取消，旧写不得把已清理状态写回", async () => {
	const gate = deferred();
	const h = harness({ listGate: gate });
	const pending = h.list(PROJECT_A);
	await tick();
	assert.equal(h.calls.list.length, 1, "读已经进入 reader");

	await h.facts.closeProject(PROJECT_A);
	gate.resolve();
	const late = await pending;
	assert.equal(late.ok, false);
	assert.equal(late.code, "REQUEST_CANCELLED", "关闭项目后迟到的读不得发布旧事实");

	// 旧写面完成时项目已经关闭：不得重新制造目录缓存或事实通知。
	h.facts.afterWrite(PROJECT_A, ["src/a.ts"]);
	assert.deepEqual(h.published, [], "旧写不得为已关闭的项目重新发布事实");

	const reopened = await h.list(PROJECT_A);
	assert.equal(reopened.ok, true, "关闭后重新打开仍能读");
	assert.equal(h.calls.list.length, 2);
	h.facts.afterWrite(PROJECT_A, ["src/b.ts"]);
	assert.equal(h.published.length, 1, "新会话的写面通知正常发布");
	assert.equal(h.published[0].generation, h.pool.peek(HOST, ROOT_A).connectionId);
	assert.deepEqual(
		plain(h.published[0].scopes)
			.map((scope) => scope.path)
			.sort(),
		["", "src"],
	);
});

test("关闭落在解析 target 的窗口：读不得在清理后重新开始一次装载", async () => {
	const gate = deferred();
	const h = harness({ serviceGate: gate });
	const pending = h.list(PROJECT_A);
	await tick();
	assert.equal(h.calls.list.length, 0, "此时还停在解析服务/target");

	await h.facts.closeProject(PROJECT_A);
	gate.resolve();
	const late = await pending;
	assert.equal(late.ok, false);
	assert.equal(late.code, "REQUEST_CANCELLED", "解析期间被关闭的读必须取消");
	assert.equal(h.calls.list.length, 0, "已清理的项目不得再发一次远端装载");

	const reopened = await h.list(PROJECT_A);
	assert.equal(reopened.ok, true);
	assert.equal(h.calls.list.length, 1, "重新打开才允许装载");
});

test("显式断开按生产顺序（先 onHostDisconnected 再 retireHost）：断连报 DISCONNECTED，重连后目录读自愈", async () => {
	const h = harness();
	// 形成带 generation 的暖事实：首次冷读 + 第二次带会话代的读。
	await h.list(PROJECT_B);
	await h.list(PROJECT_B);
	assert.equal((await h.facts.directoryPage(PROJECT_B, "", false)).ok, true);
	const establishedBefore = h.established.length;

	// disconnect() 的生产顺序：先 onDisconnect -> onHostDisconnected（generation 改写成 disconnected），
	// 再 retireHost("explicit")；onRootRetired 此时按 sessionKey 匹配不到，负责兜底的是 stale 暖值的放行。
	h.disconnected.value = true;
	h.facts.onHostDisconnected(HOST);
	await h.pool.retireHost(HOST, "explicit");
	assert.equal(h.pool.peek(HOST, ROOT_B), undefined, "root 会话已退休");

	const during = await h.list(PROJECT_B);
	assert.equal(during.ok, false);
	assert.equal(during.code, "SSH_HOST_DISCONNECTED", "断连后目录读要报真实断开码，而不是暖缓存挡出的 SSH_HOST_NOT_READY");

	// 用户显式重连：目录读必须自己建立新会话并恢复，不能被上一轮断连留下的暖值永久挡住。
	h.disconnected.value = false;
	const after = await h.list(PROJECT_B);
	assert.equal(after.ok, true, "重连后目录读必须自愈");
	assert.equal(h.established.length, establishedBefore + 1, "重连后由目录读建立一条新池会话");
});

test("主机断连时迟到的目录读被取消，后台读不能复活已断开的会话", async () => {
	const gate = deferred();
	const h = harness({ listGate: gate });
	const pending = h.list(PROJECT_A);
	await tick();
	assert.equal(h.calls.list.length, 1);

	h.disconnected.value = true;
	h.facts.onHostDisconnected(HOST);
	gate.resolve();
	const late = await pending;
	assert.equal(late.ok, false);
	assert.equal(late.code, "REQUEST_CANCELLED", "断连后迟到的读不得用旧 helper 的事实覆盖已断开代");

	const establishedBefore = h.established.length;
	const denied = await h.list(PROJECT_A);
	assert.equal(denied.ok, false);
	assert.equal(denied.code, "SSH_HOST_DISCONNECTED");
	assert.equal(h.established.length, establishedBefore, "显式断开后不得由后台读重建会话");
});
