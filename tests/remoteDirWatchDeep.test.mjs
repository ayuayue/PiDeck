import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * P0-4：深层目录订阅（helper 非递归 fs.watch）。
 *
 * 旧实现只在根目录读到时 ensure(paths: [""])，深层目录永远监听不到。而 helper 的预算是
 * 4 watcher × 32 路径，且 `ensure` 只能为「未被任何 watcher 覆盖的路径」新建 watcher——逐目录
 * ensure 会在第 4 次后静默触顶。正确形状：按 (host, project) 维护**期望路径集**，合并窗口后
 * 一次性 ensure/rewatch；超限留可断言的降级状态，不静默假装覆盖。
 *
 * 池化 B3 之后登记按**项目会话**（connectionId）走：覆盖只查本会话；同一项目在新会话重新登记时不
 * 复用旧会话的登记，换代只清本项目在旧会话的订阅（同主机别的 root、别的项目一概不碰）。这组用例钉：
 * 分片、第 5 个 watcher 拒绝并降级、逐目录读取不产生每目录一个 watcher、换会话不认旧 watchId、
 * 迟到 watchId 不登记到新会话、项目关闭只退订该项目、兄弟会话的覆盖不冒充自己。
 */
const { createDirWatchRegistry, DIR_WATCH_LIMITS } = loadTsCommonJs("src/main/remote/RemoteDirWatchRegistry.ts");
const { createDeepDirWatch } = loadTsCommonJs("src/main/remote/RemoteDeepDirWatch.ts");
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

const HOST = "11111111-1111-4111-8111-111111111111";
/** 会话身份 = `RemoteProjectSession.connectionId`。 */
const connOf = (generation) => HOST + "#m1#" + generation;
const PROJECT = "project-remote-1";
const PROJECT_2 = "project-remote-2";
const plain = (value) => JSON.parse(JSON.stringify(value));

function fakeTimer() {
	const timers = [];
	return {
		timers,
		set(callback, intervalMs) {
			timers.push({ callback, intervalMs, cleared: false });
			return timers.length - 1;
		},
		clear(handle) {
			if (timers[handle] !== undefined) timers[handle].cleared = true;
		},
		/** 触发所有未清理的窗口（模拟合并窗口到期）。 */
		fire() {
			for (const timer of timers) if (!timer.cleared) timer.callback();
		},
	};
}

function sessionHarness(connectionId, calls) {
	const state = { seq: 0 };
	return {
		connectionId,
		async request(method, params) {
			if (method === "fs.watch") {
				state.seq += 1;
				const watchId = "w-" + connectionId + "-" + state.seq;
				calls.push({ kind: "watch", paths: [...params.paths], connectionId, watchId });
				return { watchId };
			}
			if (method === "fs.unwatch") {
				calls.push({ kind: "unwatch", watchId: params.watchId });
				return { ok: true };
			}
			throw new Error("UNEXPECTED_METHOD");
		},
	};
}

function planner(options = {}) {
	const registry = createDirWatchRegistry(options.keepAlive === undefined ? {} : { keepAlive: options.keepAlive });
	const timer = fakeTimer();
	const logs = [];
	const watch = createDeepDirWatch({ registry, timer, log: (degraded) => logs.push(degraded), ...(options.maxPaths === undefined ? {} : { maxPaths: options.maxPaths }) });
	const calls = [];
	return { registry, timer, logs, watch, calls, session: (connectionId) => sessionHarness(connectionId, calls) };
}
const watchesOf = (calls) => calls.filter((call) => call.kind === "watch");
const unwatchesOf = (calls) => calls.filter((call) => call.kind === "unwatch").map((call) => call.watchId);

test("33 条路径按 32 分片成两个 watcher，一次全量 ensure 而不是逐目录", async () => {
	const p = planner();
	const session = p.session("conn-1");
	await p.watch.record(PROJECT, HOST, "", session);
	assert.deepEqual(
		watchesOf(p.calls).map((call) => call.paths),
		[[""]],
		"根目录读到就订阅（与旧时机一致）",
	);
	for (let index = 0; index < 32; index += 1) p.watch.record(PROJECT, HOST, "dir" + index, session);
	assert.equal(watchesOf(p.calls).length, 1, "合并窗口内不逐目录发请求");
	await p.watch.flush();
	const requests = watchesOf(p.calls).map((call) => call.paths);
	assert.equal(requests.length, 3, "一次 rewatch：32 + 1 两片");
	assert.equal(requests[1].length, DIR_WATCH_LIMITS.pathsPerWatcher);
	assert.equal(requests[2].length, 1);
	assert.equal(p.registry.sizeOfSession(HOST, "conn-1"), 2, "33 条路径两个 watcher");
	assert.deepEqual(plain(p.watch.status(PROJECT).covered).sort(), ["", ...Array.from({ length: 32 }, (_, index) => "dir" + index)].sort());
	assert.equal(p.watch.status(PROJECT).degraded, undefined);
});

test("第 5 个 watcher 被拒绝，并留下可断言的降级状态（不偷超限）", async () => {
	const p = planner();
	// 同一个 helper 会话里的别的项目先占满 4 个 watcher（预算按会话计）。
	for (let index = 0; index < DIR_WATCH_LIMITS.watchersPerSession; index += 1) await p.registry.ensure(HOST, "conn-1", "other-" + index, async () => "x" + index, { paths: [""] });
	assert.equal(p.registry.sizeOfSession(HOST, "conn-1"), DIR_WATCH_LIMITS.watchersPerSession);

	await p.watch.record(PROJECT, HOST, "", p.session("conn-1"));
	assert.equal(p.registry.sizeOfSession(HOST, "conn-1"), DIR_WATCH_LIMITS.watchersPerSession, "超限拒绝，不挤掉别人的 watcher");
	const status = p.watch.status(PROJECT);
	assert.equal(status.degraded?.reason, "watcher-capacity");
	assert.deepEqual(plain(status.covered), []);
	assert.equal(p.logs.length, 1, "降级必须有结构化日志");
	assert.equal(p.logs[0].reason, "watcher-capacity");
	assert.equal(p.logs[0].desired, 1);
});

test("fs.watch 抛错：covered 为空也必须降级，真实失败码进入状态与日志；恢复后状态清除", async () => {
	const p = planner();
	const state = { fail: true, seq: 0 };
	const session = {
		connectionId: "conn-1",
		async request(method, params) {
			if (method === "fs.watch") {
				p.calls.push({ kind: "watch", paths: [...params.paths] });
				if (state.fail) throw new Error("REMOTE_WORKSPACE_UNSUPPORTED");
				state.seq += 1;
				return { watchId: "w-recovered-" + state.seq };
			}
			if (method === "fs.unwatch") return { ok: true };
			throw new Error("UNEXPECTED_METHOD");
		},
	};

	await p.watch.record(PROJECT, HOST, "", session);
	const failed = p.watch.status(PROJECT);
	assert.deepEqual(plain(failed.covered), [], "订阅失败时没有任何覆盖");
	assert.equal(failed.degraded?.reason, "watch-failed", "covered 为空不能伪装成正常");
	assert.equal(failed.degraded?.code, "REMOTE_WORKSPACE_UNSUPPORTED", "真实失败原因必须带出来");
	assert.equal(failed.degraded?.desired, 1);
	assert.equal(failed.degraded?.dropped, 1);
	assert.deepEqual(
		p.logs.map((entry) => [entry.reason, entry.code]),
		[["watch-failed", "REMOTE_WORKSPACE_UNSUPPORTED"]],
		"降级必须有结构化日志且带失败码",
	);

	// 失败条件消失后再次冲刷：覆盖恢复，降级状态必须清掉（不是永久贴标签）。
	state.fail = false;
	await p.watch.record(PROJECT, HOST, "", session);
	const recovered = p.watch.status(PROJECT);
	assert.deepEqual(plain(recovered.covered), [""]);
	assert.equal(recovered.degraded, undefined, "恢复后不得残留旧降级");
	assert.equal(watchesOf(p.calls).length, 2, "一次失败 + 一次成功，各自只发一次请求");
});

test("helper 以 TOO_MANY_REQUESTS 拒绝：归到 watcher-capacity 并保留真实码", async () => {
	const p = planner();
	const session = {
		connectionId: "conn-1",
		async request(method) {
			if (method === "fs.watch") throw new Error("TOO_MANY_REQUESTS");
			if (method === "fs.unwatch") return { ok: true };
			throw new Error("UNEXPECTED_METHOD");
		},
	};
	await p.watch.record(PROJECT, HOST, "", session);
	const status = p.watch.status(PROJECT);
	assert.equal(status.degraded?.reason, "watcher-capacity", "helper 的预算拒绝与登记表预判同一语义");
	assert.equal(status.degraded?.code, "TOO_MANY_REQUESTS");
	assert.deepEqual(plain(status.covered), []);
});

test("helper 声称成功却不给 watchId：按 watch-failed 降级，不假装覆盖", async () => {
	const p = planner();
	const session = {
		connectionId: "conn-1",
		async request(method) {
			if (method === "fs.watch") return {};
			if (method === "fs.unwatch") return { ok: true };
			throw new Error("UNEXPECTED_METHOD");
		},
	};
	await p.watch.record(PROJECT, HOST, "", session);
	const status = p.watch.status(PROJECT);
	assert.deepEqual(plain(status.covered), []);
	assert.equal(status.degraded?.reason, "watch-failed");
	assert.equal(status.degraded?.code, "WATCH_UNAVAILABLE");
});

test("超过 128 条路径：只覆盖上限内的路径并明确降级（paths-over-limit）", async () => {
	const p = planner();
	const session = p.session("conn-1");
	await p.watch.record(PROJECT, HOST, "", session);
	for (let index = 0; index < 128; index += 1) p.watch.record(PROJECT, HOST, "d" + index, session);
	await p.watch.flush();
	const status = p.watch.status(PROJECT);
	assert.equal(status.degraded?.reason, "paths-over-limit");
	assert.equal(status.desired.length, 129);
	assert.equal(status.covered.length, DIR_WATCH_LIMITS.watchersPerSession * DIR_WATCH_LIMITS.pathsPerWatcher);
	assert.equal(status.degraded.dropped, 1);
	assert.equal(p.registry.sizeOfSession(HOST, "conn-1"), DIR_WATCH_LIMITS.watchersPerSession);
});

test("逐目录读取合并成一个 watcher；重复登记不重复订阅", async () => {
	const p = planner();
	const session = p.session("conn-1");
	await p.watch.record(PROJECT, HOST, "", session);
	for (const dir of ["a", "b", "c", "d", "e"]) {
		p.watch.record(PROJECT, HOST, dir, session);
		p.watch.record(PROJECT, HOST, dir, session);
	}
	await p.watch.flush();
	const requests = watchesOf(p.calls).map((call) => call.paths);
	assert.equal(requests.length, 2, "根一次 + 一次全量 ensure");
	assert.deepEqual(requests[1], ["", "a", "b", "c", "d", "e"]);
	assert.equal(p.registry.sizeOfSession(HOST, "conn-1"), 1, "5 个目录不产生 5 个 watcher");
	// 已覆盖的重复登记不再发请求。
	await p.watch.record(PROJECT, HOST, "a", session);
	await p.watch.flush();
	assert.equal(watchesOf(p.calls).length, 2);
});

test("换会话：旧 watchId 不再认，只清本项目在旧会话的订阅并在新会话重新订阅", async () => {
	const p = planner();
	const first = p.session("conn-1");
	await p.watch.record(PROJECT, HOST, "", first);
	p.watch.record(PROJECT, HOST, "src", first);
	await p.watch.flush();
	const oldIds = p.registry.watchIdsOfSession(HOST, "conn-1");
	assert.equal(oldIds.length, 1);

	const second = p.session("conn-2");
	const unwatchedBefore = unwatchesOf(p.calls);
	await p.watch.record(PROJECT, HOST, "", second);
	assert.deepEqual(unwatchesOf(p.calls).slice(unwatchedBefore.length), plain(oldIds), "换代只退订旧会话里本项目的 watcher");
	for (const watchId of oldIds) assert.equal(p.registry.scopesForEvent(HOST, "conn-1", watchId), undefined, "旧 helper 的 watcher 已随会话死亡");
	assert.equal(p.registry.sizeOfSession(HOST, "conn-1"), 0);
	const fresh = p.registry.watchIdsOfSession(HOST, "conn-2");
	assert.equal(fresh.length, 1);
	assert.deepEqual(plain(p.registry.scopesForEvent(HOST, "conn-2", fresh[0])), [{ projectId: PROJECT, paths: ["", "src"] }], "新代覆盖全部期望路径");
	assert.deepEqual(plain(p.watch.status(PROJECT).covered).sort(), ["", "src"]);
});

test("迟到 watchId 不会登记到新会话（旧会话先登记，换代时只清本项目）", async () => {
	const p = planner();
	let release;
	const gated = {
		connectionId: "conn-2",
		async request(method, params) {
			if (method !== "fs.watch") return { ok: true };
			p.calls.push({ kind: "watch", paths: [...params.paths], connectionId: "conn-2", watchId: "w-late" });
			await new Promise((resolve) => {
				release = resolve;
			});
			return { watchId: "w-late" };
		},
	};
	const pendingFirst = p.watch.record(PROJECT, HOST, "", gated);
	// 让第一个冲刷真正进入 fs.watch（冲刷链在微任务里启动）。
	await new Promise((resolve) => setImmediate(resolve));
	const pendingSecond = p.watch.record(PROJECT, HOST, "", p.session("conn-3"));
	await new Promise((resolve) => setImmediate(resolve));
	release();
	await pendingFirst;
	await pendingSecond;
	assert.equal(p.registry.scopesForEvent(HOST, "conn-3", "w-late"), undefined, "迟到的旧会话 watchId 不得登记到新会话");
	assert.equal(p.registry.scopesForEvent(HOST, "conn-2", "w-late"), undefined, "换代后旧会话里本项目的登记被清掉");
	const current = p.registry.watchIdsOfSession(HOST, "conn-3");
	assert.equal(current.length, 1);
	assert.equal(plain(p.registry.scopesForEvent(HOST, "conn-3", current[0]))[0].projectId, PROJECT);
});

test("同一项目在新会话重新登记：只清本项目在旧会话的订阅，旧会话的其它项目不受影响", async () => {
	const p = planner();
	const first = p.session("conn-1");
	await p.watch.record(PROJECT, HOST, "", first);
	await p.watch.record(PROJECT_2, HOST, "", first);
	const [projectWatch, otherWatch] = p.registry.watchIdsOfSession(HOST, "conn-1");
	assert.ok(projectWatch !== undefined && otherWatch !== undefined);

	const second = p.session("conn-2");
	await p.watch.record(PROJECT, HOST, "", second);
	assert.deepEqual(unwatchesOf(p.calls), [projectWatch], "只退订本项目在旧会话的 watcher");
	assert.deepEqual(plain(p.registry.scopesForEvent(HOST, "conn-1", otherWatch)), [{ projectId: PROJECT_2, paths: [""] }], "旧会话里别的项目继续被监听");
	assert.equal(p.registry.scopesForEvent(HOST, "conn-1", projectWatch), undefined);
	const fresh = p.registry.watchIdsOfSession(HOST, "conn-2");
	assert.equal(fresh.length, 1, "新会话只订本项目，不复用旧会话的登记");
	assert.equal(plain(p.registry.scopesForEvent(HOST, "conn-2", fresh[0]))[0].projectId, PROJECT);
});

test("兄弟会话的覆盖不冒充自己：本会话仍要发订阅", async () => {
	const p = planner();
	// 另一个会话（同主机不同 root）恰好已经覆盖了同样的路径：那是别的 helper 的 watcher，收不到本会话的事件。
	await p.registry.ensure(HOST, "conn-other", PROJECT, async () => "foreign", { paths: ["", "src"] });
	await p.watch.record(PROJECT, HOST, "", p.session("conn-1"));
	assert.deepEqual(
		watchesOf(p.calls).map((call) => call.paths),
		[[""]],
		"本会话没有覆盖就必须自己订阅",
	);
	assert.equal(p.registry.sizeOfSession(HOST, "conn-1"), 1);
	assert.equal(p.registry.sizeOfSession(HOST, "conn-other"), 1, "别的会话的登记保持原样");
});

test("换代把旧会话的保活租约还回池（keepAlive：1→0 release，新会话 retain）", async () => {
	const events = [];
	const p = planner({ keepAlive: { retain: (sessionKey) => events.push(["retain", sessionKey]), release: (sessionKey) => events.push(["release", sessionKey]) } });
	await p.watch.record(PROJECT, HOST, "", p.session("conn-1"));
	assert.deepEqual(events, [["retain", "conn-1"]]);
	// 同一会话的深层目录登记不再 retain。
	p.watch.record(PROJECT, HOST, "src", p.session("conn-1"));
	await p.watch.flush();
	assert.deepEqual(events, [["retain", "conn-1"]]);
	// 换代：旧会话本项目的登记被清掉 → 旧会话 watch 变空 → 还租约；新会话重新登记 → 新租约。
	await p.watch.record(PROJECT, HOST, "", p.session("conn-2"));
	assert.deepEqual(events, [
		["retain", "conn-1"],
		["release", "conn-1"],
		["retain", "conn-2"],
	]);
});

test("项目关闭只退订该项目；迟到的冲刷不得把它订回来", async () => {
	const p = planner();
	const session = p.session("conn-1");
	await p.watch.record(PROJECT, HOST, "", session);
	await p.watch.record(PROJECT_2, HOST, "", session);
	const [firstId, secondId] = p.registry.watchIdsOfSession(HOST, "conn-1");
	p.watch.forgetProject(PROJECT);
	await p.registry.closeProject(PROJECT);
	assert.deepEqual(unwatchesOf(p.calls), [firstId], "只退订关闭的项目");
	assert.equal(plain(p.registry.scopesForEvent(HOST, "conn-1", secondId))[0].projectId, PROJECT_2);
	await p.watch.flush();
	assert.equal(p.registry.sizeOf(HOST), 1, "迟到的冲刷不能把关闭的项目订回来");
	assert.deepEqual(plain(p.watch.status(PROJECT)), { desired: [], covered: [] });
});

test("断连后忘记该主机：待冲刷的窗口不再发请求", async () => {
	const p = planner();
	const session = p.session("conn-1");
	await p.watch.record(PROJECT, HOST, "", session);
	p.watch.record(PROJECT, HOST, "src", session);
	const before = watchesOf(p.calls).length;
	p.watch.forgetHost(HOST);
	p.timer.fire();
	await p.watch.flush();
	assert.equal(watchesOf(p.calls).length, before, "断连后不再发订阅请求");
	assert.deepEqual(plain(p.watch.status(PROJECT)), { desired: [], covered: [] });
});

/* ---------------------------------------------------- 生产接线（remoteProjectIpc） */

function ipcHarness() {
	const calls = { list: [], watches: [], unwatches: [] };
	const handlers = new Map();
	const state = { connectionId: "conn-1", seq: 0 };
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
				value: await task({
					connectionId: state.connectionId,
					request: async (method, params) => {
						if (method === "fs.watch") {
							state.seq += 1;
							calls.watches.push({ paths: [...params.paths], connectionId: state.connectionId });
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
			// 池化保活端口：本文件只验证深层订阅结构，保活配对在 remoteDirWatchSessionIsolation 覆盖。
			retainProjectSessionWatch: () => undefined,
			releaseProjectSessionWatch: () => undefined,
		}),
		projects: {
			enroll: async () => ({ projectId: PROJECT }),
			locator: (projectId) => ([PROJECT, PROJECT_2].includes(projectId) ? { kind: "ssh", hostId: HOST, remotePath: "/srv/app" } : undefined),
		},
	});
	const list = (projectId, path) => handlers.get(ipcChannels.remoteProjectList)({}, projectId, path);
	return { calls, state, facts, list };
}

test("生产接线：根读订阅、深层目录按窗口 rewatch 成一份全量；关闭项目只退订该项目", async () => {
	const h = ipcHarness();
	await h.list(PROJECT, "");
	assert.equal(h.calls.watches.length, 1, "根目录读到就订阅（旧行为保持）");
	assert.deepEqual(h.calls.watches[0].paths, [""]);

	await h.list(PROJECT, "src");
	await h.list(PROJECT, "src/deep");
	assert.equal(h.calls.watches.length, 1, "深层目录不逐个建 watcher（窗口内合并）");
	await h.facts.flushDirWatch();
	assert.equal(h.calls.watches.length, 2, "一次全量 ensure");
	assert.deepEqual(h.calls.watches[1].paths, ["", "src", "src/deep"]);
	assert.deepEqual(h.calls.unwatches, ["w1"], "rewatch 先成对退订旧集合");
	const status = h.facts.dirWatchStatus(PROJECT);
	assert.deepEqual(plain(status.desired), ["", "src", "src/deep"]);
	assert.equal(status.degraded, undefined);

	await h.list(PROJECT_2, "");
	assert.equal(h.calls.watches.length, 3);
	await h.facts.closeProject(PROJECT);
	assert.deepEqual(h.calls.unwatches, ["w1", "w2"], "只退订关闭的项目，另一个项目的 watcher 留着");
	assert.deepEqual(plain(h.facts.dirWatchStatus(PROJECT)), { desired: [], covered: [] });
});
