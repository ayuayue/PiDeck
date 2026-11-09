import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteFactsHub } = loadTsCommonJs("src/main/remote/RemoteFactsNotifications.ts");
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
const CHANNEL = "remote:project-facts-changed";

const HOST = "6f1b7c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const PROJECT = "project-remote-1";
const PROJECT_ROOT = "/srv/app";
const plain = (value) => JSON.parse(JSON.stringify(value));

function fakeSender(id) {
	const sender = new EventEmitter();
	sender.id = id;
	sender.sent = [];
	sender.isDestroyed = () => false;
	sender.send = (channel, payload) => sender.sent.push({ channel, payload });
	return sender;
}

/**
 * T4（v5 §10.3）：唯一事实 owner 与通知闭环。
 *
 * 钉三件事：
 * 1. 事件**只标脏、只通知**：任何一次 helper 事件/写面都不去找远端装载；
 * 2. 订阅绑定 sender + project：没订阅的窗口、别的项目、已销毁/已退订的窗口都收不到；
 * 3. 通知携带 projectId + generation + scopes，退订即停止（隐藏/收起/关闭走同一条路）。
 */
test("hub：只把通知发给订阅了该项目的 sender；退订/销毁即停止", () => {
	const hub = createRemoteFactsHub(CHANNEL);
	const one = fakeSender(1);
	const two = fakeSender(2);
	hub.subscribe(one, PROJECT);
	hub.subscribe(two, PROJECT);
	hub.subscribe(two, "project-other");
	assert.equal(hub.subscriberCount(PROJECT), 2);

	hub.publish({ projectId: PROJECT, generation: "conn-1", scopes: [{ kind: "dir", path: "src" }] });
	assert.equal(one.sent.length, 1);
	assert.equal(two.sent.length, 1, "一次事件只发一个载荷，不按 scope 拆成多条");
	assert.deepEqual(plain(one.sent[0]), { channel: CHANNEL, payload: { projectId: PROJECT, generation: "conn-1", scopes: [{ kind: "dir", path: "src" }] } });

	// 别的项目的变化不会串到这个订阅上。
	hub.publish({ projectId: "project-other", generation: "conn-1", scopes: [{ kind: "repos" }] });
	assert.equal(one.sent.length, 1, "没订阅别的项目就收不到");
	assert.equal(two.sent.length, 2);

	hub.unsubscribe(1, PROJECT);
	hub.publish({ projectId: PROJECT, generation: "conn-1", scopes: [{ kind: "dir", path: "" }] });
	assert.equal(one.sent.length, 1, "退订后不再收到（隐藏/收起/关闭走同一个入口）");
	assert.equal(two.sent.length, 3);

	// 窗口销毁：登记一起消失，后续 publish 不再往死掉的 webContents 发送。
	hub.unsubscribeSender(2);
	assert.equal(hub.subscriberCount(PROJECT), 0);
	hub.publish({ projectId: PROJECT, generation: "conn-1", scopes: [{ kind: "dir", path: "" }] });
	assert.equal(two.sent.length, 3);

	// destroyed 事件同样清登记（不是只有显式 unsubscribe 才清）。
	const three = fakeSender(3);
	hub.subscribe(three, PROJECT);
	three.emit("destroyed");
	hub.publish({ projectId: PROJECT, generation: "conn-1", scopes: [{ kind: "dir", path: "" }] });
	assert.equal(three.sent.length, 0);
});

test("hub：非法订阅/空 scopes 被忽略，发送失败不影响调用方", () => {
	const hub = createRemoteFactsHub(CHANNEL);
	const sender = fakeSender(4);
	hub.subscribe(sender, "");
	hub.subscribe(sender, "bad\nproject");
	hub.subscribe(sender, PROJECT);
	assert.equal(hub.subscriberCount(""), 0);
	assert.equal(hub.subscriberCount(PROJECT), 1);

	hub.publish({ projectId: PROJECT, generation: "conn-1", scopes: [] });
	assert.equal(sender.sent.length, 0, "空 scopes 不是一次变化");

	sender.send = () => {
		throw new Error("renderer exploded");
	};
	assert.doesNotThrow(() => hub.publish({ projectId: PROJECT, generation: "conn-1", scopes: [{ kind: "repos" }] }));
});

/* ------------------------------------------------------------ 生产接线 */

function harness(options = {}) {
	const calls = { list: 0, watches: [], keepAlive: [] };
	const handlers = new Map();
	const state = { connectionId: "conn-1" };
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
	const hub = createRemoteFactsHub(ipcChannels.remoteProjectFactsChanged);
	const service = {
		async withProjectSession(_hostId, _root, task) {
			return {
				ok: true,
				value: await task({
					connectionId: state.connectionId,
					request: async (method, params) => {
						if (method === "fs.watch") {
							calls.watches.push([...params.paths]);
							if (options.watchFails === true) throw new Error("REMOTE_WORKSPACE_UNSUPPORTED");
							return { watchId: "w1" };
						}
						return { ok: true };
					},
					cancel: async () => undefined,
				}),
			};
		},
		// 项目事实/能力按本项目的 root 查询：主机级 connectionFacts 证明不了这份缓存属于哪个 root，
		// 同主机可能同时挂着另一个 root 的会话（池化 B3）。
		projectConnectionFacts: (hostId, root) => (hostId === HOST && root === PROJECT_ROOT ? { connectionId: state.connectionId, state: "ready" } : undefined),
		projectHelperCapabilities: (hostId, root) => (hostId === HOST && root === PROJECT_ROOT ? ["fs.watch"] : undefined),
		// 目录订阅保活：0→1 记 retain、退订清空记 release（池的 watchers 计数只是加减法）。
		retainProjectSessionWatch: (hostId, root) => calls.keepAlive.push({ kind: "retain", hostId, root }),
		releaseProjectSessionWatch: (hostId, root) => calls.keepAlive.push({ kind: "release", hostId, root }),
	};
	const facts = registerRemoteProjectIpc({
		enabled: true,
		userDataDir: "/tmp/unused",
		service: async () => service,
		factsEvents: hub,
		directoryReader: {
			async read() {
				calls.list += 1;
				const entries = [{ name: "src", kind: "directory" }];
				return { ok: true, value: { entries, scanned: entries.length, truncated: false } };
			},
		},
		projects: {
			enroll: async () => ({ projectId: PROJECT }),
			locator: (id) => (id === PROJECT ? { kind: "ssh", hostId: HOST, remotePath: "/srv/app" } : undefined),
		},
	});
	const list = () => handlers.get(ipcChannels.remoteProjectList)({}, PROJECT, "");
	const subscribe = (sender) => handlers.get(ipcChannels.remoteProjectFactsSubscribe)({ sender }, PROJECT);
	const unsubscribe = (sender) => handlers.get(ipcChannels.remoteProjectFactsUnsubscribe)({ sender }, PROJECT);
	return { calls, state, hub, facts, list, subscribe, unsubscribe };
}

test("写面与 helper 事件只标脏并通知：事件本身不装载，读的人决定何时重读", async () => {
	const h = harness();
	const sender = fakeSender(1);
	h.subscribe(sender);
	const first = await h.list();
	assert.equal(h.calls.list, 1);
	assert.equal(first.ok, true);

	// 写面：目录被标脏 + 一条通知，不产生远端往返。
	h.facts.afterWrite(PROJECT, ["src/a.ts"]);
	assert.equal(h.calls.list, 1, "写只标脏：没有事件驱动的装载");
	assert.equal(sender.sent.length, 1);
	const write = plain(sender.sent[0].payload);
	assert.equal(write.projectId, PROJECT);
	assert.equal(write.generation, "conn-1", "通知携带当前连接代");
	assert.deepEqual(
		write.scopes.sort((a, b) => a.path.localeCompare(b.path)),
		[
			{ kind: "dir", path: "" },
			{ kind: "dir", path: "src" },
		],
	);

	// helper 事件：同一个通知形状（根目录 watcher），仍旧不装载。
	// 事件必须带会话身份：同主机另一条会话返回同一个 watchId 时，它的事件不得标脏本项目。
	h.facts.onHelperEvent({ hostId: HOST, sessionKey: "conn-other", watchId: "w1", paths: [""] });
	assert.equal(sender.sent.length, 1, "别的 sessionKey 的同一 watchId 不通知、不标脏");
	h.facts.onHelperEvent({ hostId: HOST, sessionKey: "conn-1", watchId: "w1", paths: [""] });
	assert.equal(h.calls.list, 1, "事件不是装载触发器");
	assert.equal(sender.sent.length, 2);
	assert.deepEqual(plain(sender.sent[1].payload.scopes), [{ kind: "dir", path: "" }]);

	// 活跃读者重读时才付一次往返，并拿到新 revision。
	const after = await h.list();
	assert.equal(h.calls.list, 2);
	assert.ok(after.value.revision > first.value.revision);
});

test("订阅绑定 sender：没订阅的窗口、已退订的窗口都收不到通知", async () => {
	const h = harness();
	const subscribed = fakeSender(1);
	const observer = fakeSender(2);
	h.subscribe(subscribed);
	await h.list();

	h.facts.afterWrite(PROJECT, ["a.txt"]);
	assert.equal(subscribed.sent.length, 1);
	assert.equal(observer.sent.length, 0, "没有订阅这个项目的窗口收不到");

	h.unsubscribe(subscribed);
	h.facts.afterWrite(PROJECT, ["b.txt"]);
	assert.equal(subscribed.sent.length, 1, "退订后不再收到");

	// 窗口销毁由 hub 的 destroyed 监听清理，不会留下会发送的死登记。
	subscribed.emit("destroyed");
	h.facts.afterWrite(PROJECT, ["c.txt"]);
	assert.equal(h.hub.subscriberCount(PROJECT), 0);
});

test("订阅本身不发请求、不建会话；重复订阅幂等", async () => {
	const h = harness();
	const sender = fakeSender(1);
	const result = await h.subscribe(sender);
	assert.equal(result.ok, true);
	await h.subscribe(sender);
	assert.equal(h.hub.subscriberCount(PROJECT), 1, "重复订阅只登记一次");
	assert.equal(h.calls.list, 0, "订阅不是读取，不触发任何装载");
	assert.equal(h.calls.watches.length, 0);
});

test("目录订阅保活：0→1 retain 一次，关闭项目 release 恰好一次；订阅失败不 retain", async () => {
	const h = harness();
	await h.list();
	assert.deepEqual(h.calls.keepAlive, [{ kind: "retain", hostId: HOST, root: PROJECT_ROOT }], "第一次有 watch 时 retain");
	await h.list();
	assert.equal(h.calls.keepAlive.length, 1, "watcher 仍挂着：重复读取不再 retain（池的 watchers 计数不漂）");
	await h.facts.closeProject(PROJECT);
	assert.deepEqual(
		h.calls.keepAlive.map((entry) => entry.kind),
		["retain", "release"],
		"关闭项目成对 release 一次",
	);

	// helper 不支持 watch：没有登记，也就没有保活计数。
	const failing = harness({ watchFails: true });
	await failing.list();
	assert.deepEqual(failing.calls.keepAlive, [], "订阅失败不 retain");
});

test("订阅失败/无 watch 能力时：读取仍成功，显式失效仍能让下一次读刷新", async () => {
	const h = harness({ watchFails: true });
	const first = await h.list();
	assert.equal(first.ok, true, "订阅不是读的前置条件");
	assert.equal(h.calls.watches.length, 1, "订阅请求发过一次，失败被降级吸收");
	const afterWrite = await h.list();
	assert.equal(afterWrite.ok, true);

	// 没有 watcher 时，写面/显式失效仍然有效：下一次读重新装载。
	h.facts.afterWrite(PROJECT, ["a.txt"]);
	const refreshed = await h.list();
	assert.equal(refreshed.ok, true);
	assert.ok(refreshed.value.revision > first.value.revision);
	assert.ok(h.calls.watches.length <= h.calls.list, "订阅尝试不超过根目录读取次数：没有后台重试风暴");
});
