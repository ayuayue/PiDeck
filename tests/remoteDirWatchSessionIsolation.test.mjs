import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createDirWatchRegistry, DIR_WATCH_LIMITS } = loadTsCommonJs("src/main/remote/RemoteDirWatchRegistry.ts");

const HOST = "11111111-1111-4111-8111-111111111111";
const OTHER_HOST = "ffffffff-ffff-4fff-8fff-ffffffffffff";
/** 会话身份 = `RemoteProjectSession.connectionId`：`hostId#managerToken#generation`。 */
const connOf = (hostId, managerToken, generation) => hostId + "#" + managerToken + "#" + generation;
const plain = (value) => JSON.parse(JSON.stringify(value));

function deferred() {
	let resolve;
	const promise = new Promise((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

/** 同主机两条 helper 会话（两个 root 的池条目）。 */
function sessionPair() {
	return { A: connOf(HOST, "root-a", 1), B: connOf(HOST, "root-b", 2) };
}

/**
 * 保活计数器：池的 `watchers` 只是加减法，所以「retain/release 严格配对」是可判定的——
 * 每条会话的余额必须回到 0，且事件序列里 0→1 只能 retain 一次、1→0 只能 release 一次。
 */
function keepAliveRecorder() {
	const events = [];
	const balance = new Map();
	const bump = (sessionKey, delta) => balance.set(sessionKey, (balance.get(sessionKey) ?? 0) + delta);
	return {
		events,
		retain(sessionKey) {
			events.push(["retain", sessionKey]);
			bump(sessionKey, 1);
		},
		release(sessionKey) {
			events.push(["release", sessionKey]);
			bump(sessionKey, -1);
		},
		balanceOf: (sessionKey) => balance.get(sessionKey) ?? 0,
		total: () => [...balance.values()].reduce((sum, value) => sum + value, 0),
	};
}

/**
 * 目录订阅登记表的**会话隔离**（池化 B3）：登记表从「host → 一代」升级为「host → sessionKey → 一代」。
 *
 * 根因：root 池让同一台主机同时存在多条 helper 会话，每条的 `watchId` 只在它自己的会话里唯一。
 * 旧实现用 `watchId` 当全局键、用 `hostId` 当代数，于是 B 会话返回的同名 watchId 会解析到 A 会话的
 * 项目——事件把错的目录标脏，而真正的目录永远不刷新。这里钉住隔离、每会话预算、全主机清理与保活配对。
 */
test("同一 watchId 在两条会话里各自解析到自己的项目范围（事件不串会话）", async () => {
	const registry = createDirWatchRegistry();
	const { A, B } = sessionPair();
	// 两条 helper 各自返回同一个 watchId：watchId 是会话内序号，撞车完全可能。
	await registry.ensure(HOST, A, "project-a", async () => "shared-watch", { paths: ["src"] });
	await registry.ensure(HOST, B, "project-b", async () => "shared-watch", { paths: ["docs"] });
	assert.deepEqual(plain(registry.scopesForEvent(HOST, A, "shared-watch")), [{ projectId: "project-a", paths: ["src"] }]);
	assert.deepEqual(plain(registry.scopesForEvent(HOST, B, "shared-watch")), [{ projectId: "project-b", paths: ["docs"] }]);
	assert.equal(registry.scopesForEvent(HOST, connOf(HOST, "root-c", 3), "shared-watch"), undefined, "未知会话不得拿到任何范围");
	assert.deepEqual(plain(registry.pathsOf(HOST, "project-a")), ["src"], "host 级汇总只算该项目的会话");
	assert.deepEqual(plain(registry.pathsOf(HOST, "project-b")), ["docs"]);
	assert.deepEqual(plain(registry.pathsOfSession(HOST, A, "project-a")), ["src"]);
	assert.deepEqual(plain(registry.pathsOfSession(HOST, B, "project-a")), [], "兄弟会话的覆盖不算自己的");
	assert.equal(registry.sizeOf(HOST), 2);
});

test("releaseHost 只释放指定会话：另一会话的 watch 与 sizeOfSession 不受影响", async () => {
	const registry = createDirWatchRegistry();
	const { A, B } = sessionPair();
	const unwatched = [];
	const unwatch = async (watchId) => {
		unwatched.push(watchId);
	};
	await registry.ensure(HOST, A, "project-a", async () => "watch-a", { unwatch });
	await registry.ensure(HOST, B, "project-b", async () => "watch-b", { unwatch });
	await registry.releaseHost(HOST, A);
	assert.deepEqual(unwatched, ["watch-a"], "只退订被释放会话的 watcher");
	assert.equal(registry.scopesForEvent(HOST, A, "watch-a"), undefined);
	assert.deepEqual(plain(registry.scopesForEvent(HOST, B, "watch-b")), [{ projectId: "project-b", paths: [""] }]);
	assert.equal(registry.sizeOfSession(HOST, A), 0);
	assert.equal(registry.sizeOfSession(HOST, B), 1);
	assert.equal(registry.sizeOf(HOST), 1, "host 级计数只剩 B");

	// 迟到的清理：重复释放一条已不存在的会话不得动到 B。
	await registry.releaseHost(HOST, A);
	registry.clearSession(HOST, A);
	assert.deepEqual(unwatched, ["watch-a"]);
	assert.deepEqual(plain(registry.scopesForEvent(HOST, B, "watch-b")), [{ projectId: "project-b", paths: [""] }]);
	assert.equal(registry.sizeOfSession(HOST, B), 1);
});

test("clearHost 丢弃该主机全部会话且不发退订；别的 host 不受影响", async () => {
	const registry = createDirWatchRegistry();
	const { A, B } = sessionPair();
	const C = connOf(OTHER_HOST, "root-c", 1);
	const unwatched = [];
	const unwatch = async (watchId) => {
		unwatched.push(watchId);
	};
	await registry.ensure(HOST, A, "project-a", async () => "watch-a", { unwatch });
	await registry.ensure(HOST, B, "project-b", async () => "watch-b", { unwatch });
	await registry.ensure(OTHER_HOST, C, "project-c", async () => "watch-c", { unwatch });
	registry.clearHost(HOST);
	assert.equal(registry.sizeOf(HOST), 0, "断连后该主机全部会话直接丢弃");
	assert.equal(registry.sizeOfSession(HOST, A), 0);
	assert.equal(registry.sizeOfSession(HOST, B), 0);
	assert.equal(registry.scopesForEvent(HOST, A, "watch-a"), undefined);
	assert.equal(registry.scopesForEvent(HOST, B, "watch-b"), undefined);
	assert.deepEqual(unwatched, [], "helper 已死时不再发退订");
	assert.deepEqual(plain(registry.scopesForEvent(OTHER_HOST, C, "watch-c")), [{ projectId: "project-c", paths: [""] }], "别的 host 不受影响");
});

test("4 watcher 上限按会话计：A 的第 5 个被拒，B 仍可登记 4 个", async () => {
	const registry = createDirWatchRegistry();
	const { A, B } = sessionPair();
	let seq = 0;
	const subscribe = async () => "w" + (seq += 1);
	for (let index = 0; index < DIR_WATCH_LIMITS.watchersPerSession; index += 1) await registry.ensure(HOST, A, "a-" + index, subscribe);
	assert.equal(registry.sizeOfSession(HOST, A), DIR_WATCH_LIMITS.watchersPerSession);
	const over = await registry.ensure(HOST, A, "a-over", subscribe);
	assert.equal(over.rejected, 1, "第 5 个 watcher 必须拒绝而不是排队");
	assert.equal(registry.sizeOfSession(HOST, A), DIR_WATCH_LIMITS.watchersPerSession, "拒绝不偷偷超限");
	for (let index = 0; index < DIR_WATCH_LIMITS.watchersPerSession; index += 1) await registry.ensure(HOST, B, "b-" + index, subscribe);
	assert.equal(registry.sizeOfSession(HOST, B), DIR_WATCH_LIMITS.watchersPerSession, "B 的预算不受 A 已占满影响");
	assert.equal(registry.sizeOf(HOST), DIR_WATCH_LIMITS.watchersPerSession * 2, "host 级总数是两条会话之和");
});

test("32 路径分片按会话独立：A 的 33 条路径拆成两个 watcher，B 不受影响", async () => {
	const registry = createDirWatchRegistry();
	const { A, B } = sessionPair();
	const requests = [];
	let seq = 0;
	const subscribeOf = (sessionKey) => async (paths) => {
		seq += 1;
		requests.push({ sessionKey, paths: [...paths] });
		return "w" + seq;
	};
	await registry.ensure(HOST, A, "project-a", subscribeOf(A), { paths: ["root", ...Array.from({ length: 32 }, (_, index) => "dir" + index)] });
	assert.equal(requests.length, 2, "33 条路径 = 32 + 1，两次请求，每次都不超 32");
	assert.equal(requests[0].paths.length, DIR_WATCH_LIMITS.pathsPerWatcher);
	assert.equal(requests[1].paths.length, 1);
	assert.equal(registry.sizeOfSession(HOST, A), 2);
	await registry.ensure(HOST, B, "project-b", subscribeOf(B));
	assert.equal(registry.sizeOfSession(HOST, B), 1, "B 的登记与 A 的分片互不影响");
	assert.deepEqual(plain(requests[2].paths), [""]);
});

test("保活：0→1 retain 一次、1→0 release 一次；重复 ensure 不重复 retain", async () => {
	const keepAlive = keepAliveRecorder();
	const registry = createDirWatchRegistry({ keepAlive });
	const { A, B } = sessionPair();
	let seq = 0;
	const subscribe = async () => "w" + (seq += 1);
	await registry.ensure(HOST, A, "p1", subscribe);
	assert.deepEqual(keepAlive.events, [["retain", A]], "第一条 watch 让会话 0→1，retain 一次");
	await registry.ensure(HOST, A, "p2", subscribe);
	assert.deepEqual(keepAlive.events, [["retain", A]], "同一会话的第 2 个 watcher 不再 retain");
	await registry.ensure(HOST, A, "p1", subscribe);
	assert.deepEqual(keepAlive.events, [["retain", A]], "已覆盖的重复 ensure 不重复 retain");
	assert.equal(registry.sizeOfSession(HOST, A), 2);

	await registry.ensure(HOST, B, "p3", subscribe);
	assert.deepEqual(
		keepAlive.events,
		[
			["retain", A],
			["retain", B],
		],
		"保活按会话独立计数",
	);

	await registry.releaseProject(HOST, "p2");
	assert.deepEqual(
		keepAlive.events,
		[
			["retain", A],
			["retain", B],
		],
		"退掉一个项目后 A 仍有 watch，不 release",
	);
	await registry.releaseProject(HOST, "p1");
	assert.deepEqual(
		keepAlive.events,
		[
			["retain", A],
			["retain", B],
			["release", A],
		],
		"A 的 watch 变空才 release 一次",
	);
	assert.equal(registry.sizeOfSession(HOST, A), 0);
	assert.equal(keepAlive.balanceOf(A), 0);

	// 再次 0→1：重新 retain，与上一次 release 严格配对。
	await registry.ensure(HOST, A, "p1", subscribe);
	assert.deepEqual(keepAlive.events.slice(3), [["retain", A]]);
	await registry.releaseHost(HOST, A);
	assert.deepEqual(keepAlive.events.slice(3), [
		["retain", A],
		["release", A],
	]);
	assert.equal(keepAlive.balanceOf(A), 0);
	assert.equal(keepAlive.balanceOf(B), 1, "B 仍被保活");
	registry.clearHost(HOST);
	assert.equal(keepAlive.balanceOf(B), 0, "clearHost 也要还清保活计数");
	assert.equal(keepAlive.total(), 0);
});

test("保活：releaseHost / clearSession / releaseAll / clearAll 都成对 release", async () => {
	const keepAlive = keepAliveRecorder();
	const registry = createDirWatchRegistry({ keepAlive });
	const { A, B } = sessionPair();
	let seq = 0;
	const subscribe = async () => "w" + (seq += 1);
	await registry.ensure(HOST, A, "p1", subscribe);
	await registry.ensure(HOST, B, "p2", subscribe);
	await registry.releaseHost(HOST, A);
	assert.deepEqual(keepAlive.events, [
		["retain", A],
		["retain", B],
		["release", A],
	]);
	assert.equal(keepAlive.balanceOf(A), 0);

	// helper 已死：不发退订，但保活计数同样要还（池的 watchers 只是加减法）。
	registry.clearSession(HOST, B);
	assert.deepEqual(keepAlive.events.slice(3), [["release", B]]);
	assert.equal(keepAlive.total(), 0);

	const releaseAllKeepAlive = keepAliveRecorder();
	const releasing = createDirWatchRegistry({ keepAlive: releaseAllKeepAlive });
	const unwatched = [];
	const unwatch = async (watchId) => {
		unwatched.push(watchId);
	};
	await releasing.ensure(HOST, A, "p1", async () => "watch-a", { unwatch });
	await releasing.ensure(HOST, B, "p2", async () => "watch-b", { unwatch });
	await releasing.releaseAll();
	assert.deepEqual(releaseAllKeepAlive.events, [
		["retain", A],
		["retain", B],
		["release", A],
		["release", B],
	]);
	assert.deepEqual([...unwatched].sort(), ["watch-a", "watch-b"], "releaseAll 仍然成对退订");
	assert.equal(releaseAllKeepAlive.total(), 0);

	const clearAllKeepAlive = keepAliveRecorder();
	const clearing = createDirWatchRegistry({ keepAlive: clearAllKeepAlive });
	await clearing.ensure(HOST, A, "p1", async () => "watch-a");
	clearing.clearAll();
	assert.deepEqual(
		clearAllKeepAlive.events,
		[
			["retain", A],
			["release", A],
		],
		"全部丢弃同样要还清保活计数",
	);
});

test("扩路径 rewatch 不中断保活租约（同一次 ensure 里原子重订）", async () => {
	const keepAlive = keepAliveRecorder();
	const registry = createDirWatchRegistry({ keepAlive });
	const session = connOf(HOST, "root-a", 1);
	const unwatched = [];
	const unwatch = async (watchId) => {
		unwatched.push(watchId);
	};
	let seq = 0;
	const subscribe = async () => "w" + (seq += 1);
	await registry.ensure(HOST, session, "p1", subscribe, { paths: [""], unwatch });
	assert.deepEqual(keepAlive.events, [["retain", session]]);
	await registry.ensure(HOST, session, "p1", subscribe, { paths: ["", "src"], unwatch, replaceProject: true });
	assert.deepEqual(keepAlive.events, [["retain", session]], "rewatch 的中间态不算「变空」，不还租约（否则池可能恰好回收这条会话）");
	assert.deepEqual(unwatched, ["w1"], "旧 watcher 仍然成对退订");
	assert.equal(registry.sizeOfSession(HOST, session), 1);
	assert.deepEqual(plain(registry.pathsOfSession(HOST, session, "p1")).sort(), ["", "src"]);
	assert.equal(keepAlive.balanceOf(session), 1);
});

test("releaseProject 对全部会话生效；releaseProjectInSession 只动指定会话", async () => {
	const registry = createDirWatchRegistry();
	const { A, B } = sessionPair();
	const unwatched = [];
	const unwatch = async (watchId) => {
		unwatched.push(watchId);
	};
	let seq = 0;
	const subscribe = async () => "w" + (seq += 1);
	await registry.ensure(HOST, A, "shared-project", subscribe, { unwatch }); // w1
	await registry.ensure(HOST, A, "other-a", subscribe, { unwatch }); // w2
	await registry.ensure(HOST, B, "shared-project", subscribe, { unwatch }); // w3
	await registry.ensure(HOST, B, "other-b", subscribe, { unwatch }); // w4

	await registry.releaseProjectInSession(HOST, A, "shared-project");
	assert.deepEqual(unwatched, ["w1"], "只退订 A 会话里这个项目");
	assert.equal(registry.scopesForEvent(HOST, A, "w1"), undefined);
	assert.deepEqual(plain(registry.scopesForEvent(HOST, B, "w3")), [{ projectId: "shared-project", paths: [""] }], "B 会话里的同名项目不受影响");

	await registry.releaseProject(HOST, "shared-project");
	assert.deepEqual([...unwatched].sort(), ["w1", "w3"].sort(), "host 级释放对全部会话生效");
	assert.equal(registry.scopesForEvent(HOST, B, "w3"), undefined);
	assert.deepEqual(plain(registry.scopesForEvent(HOST, A, "w2")), [{ projectId: "other-a", paths: [""] }], "别的项目不受影响");
	assert.deepEqual(plain(registry.scopesForEvent(HOST, B, "w4")), [{ projectId: "other-b", paths: [""] }]);
});

test("closeProject 扫全部 host 的全部会话；只退订这个项目", async () => {
	const registry = createDirWatchRegistry();
	const { A, B } = sessionPair();
	const C = connOf(OTHER_HOST, "root-c", 1);
	const unwatched = [];
	const unwatch = async (watchId) => {
		unwatched.push(watchId);
	};
	let seq = 0;
	const subscribe = async () => "w" + (seq += 1);
	await registry.ensure(HOST, A, "p1", subscribe, { unwatch }); // w1
	await registry.ensure(HOST, B, "p1", subscribe, { unwatch }); // w2
	await registry.ensure(HOST, B, "p2", subscribe, { unwatch }); // w3
	await registry.ensure(OTHER_HOST, C, "p1", subscribe, { unwatch }); // w4
	await registry.closeProject("p1");
	assert.deepEqual([...unwatched].sort(), ["w1", "w2", "w4"].sort());
	assert.equal(registry.sizeOf(HOST), 1, "只留下同主机的 p2");
	assert.equal(registry.sizeOf(OTHER_HOST), 0);
	assert.deepEqual(plain(registry.scopesForEvent(HOST, B, "w3")), [{ projectId: "p2", paths: [""] }]);
});

test("在途订阅只登记到自己的会话；会话被释放后迟到的 watchId 成对收回", async () => {
	const { A, B } = sessionPair();
	const unwatched = [];
	const unwatch = async (watchId) => {
		unwatched.push(watchId);
	};
	const registry = createDirWatchRegistry();
	const gate = deferred();
	const late = registry.ensure(HOST, A, "p1", async () => await gate.promise, { unwatch });
	await registry.ensure(HOST, B, "p2", async () => "watch-b", { unwatch });
	gate.resolve("late-a");
	await late;
	assert.deepEqual(plain(registry.scopesForEvent(HOST, A, "late-a")), [{ projectId: "p1", paths: [""] }], "在途结果只能登记到自己发起的会话");
	assert.equal(registry.scopesForEvent(HOST, B, "late-a"), undefined, "绝不登记到同主机别的会话");
	assert.deepEqual(unwatched, [], "合法登记不退订");

	// 会话先被释放、订阅结果后到：这个 id 不属于任何仍登记的身份，必须成对收回。
	const released = createDirWatchRegistry();
	const gate2 = deferred();
	const orphan = released.ensure(HOST, A, "p1", async () => await gate2.promise, { unwatch });
	released.clearSession(HOST, A);
	gate2.resolve("orphan");
	await orphan;
	assert.equal(released.scopesForEvent(HOST, A, "orphan"), undefined);
	assert.deepEqual(unwatched, ["orphan"], "迟到的 watchId 不得成为无人登记的远端 watcher");
	assert.equal(released.sizeOf(HOST), 0);
});
