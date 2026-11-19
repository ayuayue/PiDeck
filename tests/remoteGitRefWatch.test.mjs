/**
 * 远端 refs 变化订阅（`git:remote-watch-refs`）的登记表契约。
 *
 * 这组用例钉的是「订阅只标脏」这条边界：一次订阅只发一个 `fs.watch`（4 条 `.git` 路径）、事件只产生
 * 一条 `{ kind: "status", repoPath }` 通知、任何降级都返回稳定码而不是抛错，以及每条清理路径都成对。
 * 远端读一次都不该因为事件而发生——所以断言的是 `session.request` 只收到 `fs.watch`/`fs.unwatch`。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteGitRefWatch, gitRefWatchPaths } = loadTsCommonJs("src/main/remote/RemoteGitRefWatch.ts");

const HOST = "11111111-1111-4111-8111-111111111111";
const ROOT = "/srv/project";
const PROJECT = "project-remote-1";
/** 会话身份 = `RemoteProjectSession.connectionId`，同时就是通知里的 generation。 */
const CONN = HOST + "#m1#3";
const REF_SUBPATHS = [".git", ".git/refs", ".git/refs/heads", ".git/refs/tags"];
/** 生产模块在 vm 沙箱里求值：跨 realm 的数组/对象要用同一 realm 的值比较。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

function harness(options = {}) {
	const calls = { watch: [], unwatch: [], sessions: 0, sessionOptions: [], retain: [], release: [], other: [] };
	const published = [];
	const helperIds = [];
	const locators = new Map([[PROJECT, { hostId: HOST, remotePath: ROOT }]]);
	let helperSequence = 0;
	let connectionId = options.connectionId ?? CONN;

	const session = () => ({
		connectionId,
		request: async (method, params) => {
			if (method === "fs.watch") {
				calls.watch.push(params.paths);
				if (options.watchFailure !== undefined) throw new Error(options.watchFailure);
				if (options.watchAnswer !== undefined) return options.watchAnswer;
				helperSequence += 1;
				const watchId = "w" + helperSequence + "-req-1";
				helperIds.push(watchId);
				return { watchId, paths: params.paths.length };
			}
			if (method === "fs.unwatch") {
				calls.unwatch.push(params.watchId);
				if (options.unwatchFailure !== undefined) throw new Error(options.unwatchFailure);
				return { closed: true };
			}
			// 事件路径绝不该触发任何别的 helper 方法：这里记账，测试断言它为空。
			calls.other.push(method);
			throw new Error("METHOD_NOT_FOUND");
		},
	});

	const service = {
		withProjectSession: async (_hostId, _root, task, readOptions) => {
			calls.sessions += 1;
			calls.sessionOptions.push(readOptions);
			if (options.sessionFailure !== undefined) return options.sessionFailure;
			return { ok: true, value: await task(session()) };
		},
		projectHelperCapabilities: () => options.capabilities ?? ["fs.watch", "fs.unwatch"],
		projectConnectionFacts: options.connectionFacts === false ? undefined : () => (options.disconnected === true ? undefined : { connectionId, state: "ready" }),
		retainProjectSessionWatch: (...args) => calls.retain.push(args),
		releaseProjectSessionWatch: (...args) => calls.release.push(args),
	};

	const watch = createRemoteGitRefWatch({
		enabled: options.enabled ?? true,
		locator: (projectId) => locators.get(projectId),
		trusted: async () => options.trusted ?? true,
		service: () => service,
		factsEvents: { publish: (change) => published.push(change) },
	});
	const eventOf = (helperWatchId, sessionKey = connectionId) => ({ hostId: HOST, watchId: helperWatchId, paths: [".git"], sessionKey });
	return {
		watch,
		calls,
		published,
		locators,
		helperIds,
		eventOf,
		setConnectionId(next) {
			connectionId = next;
		},
	};
}

test("一次订阅只占 1 个 watcher：4 条 .git 路径放进同一个 fs.watch", async () => {
	const h = harness();
	const outcome = await h.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 7 });
	assert.equal(outcome.ok, true);
	assert.equal(typeof outcome.watchId, "string");
	// 预算：helper 每会话 4 个 watchId，分四次订会把预算烧光。
	assert.deepEqual(plain(h.calls.watch), [REF_SUBPATHS]);
	assert.deepEqual(plain(h.calls.watch[0]), plain(gitRefWatchPaths("")));
	assert.equal(h.calls.sessions, 1);
	// 与 Git 读同一套边界：requireReady 必须显式传。
	assert.deepEqual(plain(h.calls.sessionOptions), [{ requireReady: true }]);
	// 池保活：登记期间这条会话不能被 TTL 回收，否则 watcher 静默消失。
	assert.deepEqual(h.calls.retain, [[HOST, ROOT, CONN]]);
	assert.equal(h.watch.size(), 1);
});

test("repoPath 前缀：嵌套仓库订阅自己的 .git，事件只标脏该仓库 status", async () => {
	const h = harness();
	const outcome = await h.watch.watch({ projectId: PROJECT, repoPath: "packages/a", senderId: 1 });
	assert.equal(outcome.ok, true);
	assert.deepEqual(plain(h.calls.watch), [plain(gitRefWatchPaths("packages/a"))]);
	assert.deepEqual(plain(h.calls.watch[0]), ["packages/a/.git", "packages/a/.git/refs", "packages/a/.git/refs/heads", "packages/a/.git/refs/tags"]);

	h.watch.onHelperEvent(h.eventOf(h.helperIds[0]));
	assert.deepEqual(plain(h.published), [{ projectId: PROJECT, generation: CONN, scopes: [{ kind: "status", repoPath: "packages/a" }] }]);
	// 事件不装载：没有第二次 fs.watch，也没有任何别的 helper 方法。
	assert.equal(h.calls.watch.length, 1);
	assert.equal(h.calls.sessions, 1);
	assert.deepEqual(h.calls.other, []);
});

test("多仓库各自一条登记，事件按 watchId 路由到自己的仓库", async () => {
	const h = harness();
	const root = await h.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 1 });
	const nested = await h.watch.watch({ projectId: PROJECT, repoPath: "packages/a", senderId: 1 });
	assert.notEqual(root.watchId, nested.watchId);
	assert.equal(h.watch.size(), 2);
	h.watch.onHelperEvent(h.eventOf(h.helperIds[1]));
	assert.deepEqual(plain(h.published), [{ projectId: PROJECT, generation: CONN, scopes: [{ kind: "status", repoPath: "packages/a" }] }]);
});

test("未登记的事件被忽略：别的会话、旧会话、未知 watchId 都不产生通知", async () => {
	const h = harness();
	await h.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 1 });
	const helperId = h.helperIds[0];
	// 兄弟 root 的会话（同主机、同 hostId）拿到同名 watchId 也不能冒领。
	h.watch.onHelperEvent(h.eventOf(helperId, HOST + "#m2#1"));
	h.watch.onHelperEvent({ hostId: "22222222-2222-4222-8222-222222222222", watchId: helperId, paths: [".git"], sessionKey: CONN });
	h.watch.onHelperEvent(h.eventOf("w999-req-9"));
	assert.deepEqual(h.published, []);
});

test("同键重复订阅复用同一个 watcher，退订按窗口引用计数", async () => {
	const h = harness();
	const first = await h.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 1 });
	const second = await h.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 2 });
	// 双挂载/分屏各订一次也只消耗 1 个 helper watcher。
	assert.equal(first.watchId, second.watchId);
	assert.equal(h.calls.watch.length, 1);
	assert.equal(h.calls.retain.length, 1);

	await h.watch.unwatch(first.watchId, 1);
	assert.deepEqual(h.calls.unwatch, []);
	assert.equal(h.watch.size(), 1, "还有别的窗口订阅同一个仓库时不得退订");

	h.watch.onHelperEvent(h.eventOf(h.helperIds[0]));
	assert.equal(h.published.length, 1, "事件仍然要发给剩下的订阅者");

	await h.watch.unwatch(first.watchId, 2);
	assert.deepEqual(h.calls.unwatch, ["w1-req-1"]);
	assert.deepEqual(h.calls.release, [[HOST, ROOT, CONN]]);
	assert.equal(h.watch.size(), 0);
	h.watch.onHelperEvent(h.eventOf(h.helperIds[0]));
	assert.equal(h.published.length, 1, "退订之后不再有通知");
});

test("unwatch 幂等：未知 id、重复退订都是无声的成功", async () => {
	const h = harness();
	await h.watch.unwatch("gitref-404", 1);
	const outcome = await h.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 1 });
	await h.watch.unwatch(outcome.watchId, 1);
	await h.watch.unwatch(outcome.watchId, 1);
	assert.deepEqual(h.calls.unwatch, ["w1-req-1"]);
	assert.deepEqual(h.calls.release, [[HOST, ROOT, CONN]]);
	// 别人的 id 不能替别人退订（引用计数归零才真退订）。
	const other = await h.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 5 });
	await h.watch.unwatch(other.watchId, 6);
	assert.equal(h.watch.size(), 1);
});

test("端口没有 projectConnectionFacts 时按未换代复用：不能每次 acquire 都再烧一个 watcher", async () => {
	const h = harness({ connectionFacts: false });
	const first = await h.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 1 });
	const second = await h.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 1 });
	assert.equal(first.watchId, second.watchId);
	assert.equal(h.calls.watch.length, 1);
});

test("并发同键订阅只发一次 fs.watch", async () => {
	const h = harness();
	const [left, right] = await Promise.all([h.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 1 }), h.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 2 })]);
	assert.equal(left.ok, true);
	assert.equal(right.ok, true);
	assert.equal(left.watchId, right.watchId);
	assert.equal(h.calls.watch.length, 1);
	assert.equal(h.calls.retain.length, 1);
});

test("降级：能力缺失、路径不存在、预算触顶、连接未就绪都返回稳定码而不抛", async () => {
	assert.deepEqual(plain(await harness({ enabled: false }).watch.watch({ projectId: PROJECT, repoPath: "", senderId: 1 })), { ok: false, code: "REMOTE_FEATURE_DISABLED" });

	const untrusted = harness({ trusted: false });
	assert.deepEqual(plain(await untrusted.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 1 })), { ok: false, code: "GIT_TRUST_REQUIRED" });
	assert.equal(untrusted.calls.sessions, 0, "未确认的项目不得开会话");

	const unknownProject = harness();
	assert.deepEqual(plain(await unknownProject.watch.watch({ projectId: "not-a-project", repoPath: "", senderId: 1 })), { ok: false, code: "GIT_TARGET_CHANGED" });

	// helper 未声明 fs.watch（老 helper）：不必先建会话再让远端拒一次。
	const unsupported = harness({ capabilities: ["echo", "fs.read"] });
	assert.deepEqual(plain(await unsupported.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 1 })), { ok: false, code: "GIT_REF_WATCH_UNAVAILABLE" });
	assert.equal(unsupported.calls.sessions, 0);

	// 裸仓库 / worktree 的 .git 是文件：helper 用 NOT_A_DIRECTORY 拒绝，这里如实透出。
	const notADirectory = harness({ watchFailure: "NOT_A_DIRECTORY" });
	assert.deepEqual(plain(await notADirectory.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 1 })), { ok: false, code: "NOT_A_DIRECTORY" });
	assert.equal(notADirectory.watch.size(), 0);

	// watcher 预算触顶：面板据此退回 5 秒轮询，不假装订阅成功。
	const capacity = harness({ watchFailure: "TOO_MANY_REQUESTS" });
	assert.deepEqual(plain(await capacity.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 1 })), { ok: false, code: "TOO_MANY_REQUESTS" });
	assert.equal(capacity.watch.size(), 0);

	const notReady = harness({ sessionFailure: { ok: false, code: "SSH_HOST_NOT_READY" } });
	assert.deepEqual(plain(await notReady.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 1 })), { ok: false, code: "SSH_HOST_NOT_READY" });

	// helper 声称成功却没有 watchId：没有可路由的身份，等同失败。
	const noId = harness({ watchAnswer: { paths: 4 } });
	assert.deepEqual(plain(await noId.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 1 })), { ok: false, code: "GIT_REF_WATCH_UNAVAILABLE" });
	assert.equal(noId.watch.size(), 0);
});

test("降级之后重试成功：失败不留下半个登记", async () => {
	const h = harness({ watchFailure: "IO_ERROR" });
	assert.deepEqual(plain(await h.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 1 })), { ok: false, code: "IO_ERROR" });
	assert.equal(h.watch.size(), 0);
	assert.deepEqual(h.calls.retain, [], "失败不得占用池保活");
});

test("换代：旧会话的登记被丢弃，新会话重新订阅且 generation 跟着换", async () => {
	const h = harness();
	const first = await h.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 1 });
	h.setConnectionId(HOST + "#m1#4");
	const second = await h.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 1 });
	assert.notEqual(first.watchId, second.watchId);
	assert.equal(h.calls.watch.length, 2);
	// 旧 helper 已经不在：退订只会失败，所以不发请求，但保活要成对归还。
	assert.deepEqual(h.calls.unwatch, []);
	assert.equal(h.calls.release.length, 1);
	assert.equal(h.watch.size(), 1);

	h.watch.onHelperEvent(h.eventOf(h.helperIds[0], HOST + "#m1#3"));
	assert.deepEqual(plain(h.published), [], "旧会话的事件不得再标脏");
	h.watch.onHelperEvent(h.eventOf(h.helperIds[1], HOST + "#m1#4"));
	assert.deepEqual(plain(h.published), [{ projectId: PROJECT, generation: HOST + "#m1#4", scopes: [{ kind: "status", repoPath: "" }] }]);
});

test("sender 销毁：只退它自己的订阅，并成对 fs.unwatch", async () => {
	const h = harness();
	const mine = await h.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 7 });
	const other = await h.watch.watch({ projectId: PROJECT, repoPath: "packages/a", senderId: 8 });
	await h.watch.forgetSender(7);
	assert.deepEqual(h.calls.unwatch, [h.helperIds[0]]);
	assert.deepEqual(h.calls.release, [[HOST, ROOT, CONN]]);
	assert.equal(h.watch.size(), 1, "别的窗口的仓库订阅必须留着");
	h.watch.onHelperEvent(h.eventOf(h.helperIds[0]));
	assert.deepEqual(h.published, [], "被销毁窗口的订阅不再产生通知");
	h.watch.onHelperEvent(h.eventOf(h.helperIds[1]));
	assert.equal(h.published.length, 1);
	assert.notEqual(mine.watchId, other.watchId);
});

test("主机断开与 root 退休：helper 已死，只丢登记不发退订", async () => {
	const disconnected = harness();
	await disconnected.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 1 });
	disconnected.watch.forgetHost(HOST);
	assert.deepEqual(disconnected.calls.unwatch, []);
	assert.deepEqual(disconnected.calls.release, [[HOST, ROOT, CONN]], "保活必须成对归还，否则池永远不回收这条会话");
	assert.equal(disconnected.watch.size(), 0);
	disconnected.watch.onHelperEvent(disconnected.eventOf(disconnected.helperIds[0]));
	assert.deepEqual(disconnected.published, []);

	const retired = harness();
	await retired.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 1 });
	// 兄弟 root 的会话退休不能误杀本项目。
	retired.watch.forgetSession(HOST, HOST + "#m2#1");
	assert.equal(retired.watch.size(), 1);
	retired.watch.forgetSession(HOST, CONN);
	assert.deepEqual(retired.calls.unwatch, []);
	assert.equal(retired.watch.size(), 0);
});

test("项目关闭：pruneClosed 与迟到的事件都不再为已关闭项目产生通知", async () => {
	const h = harness();
	await h.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 1 });
	h.locators.clear();
	await h.watch.pruneClosed();
	assert.deepEqual(h.calls.unwatch, ["w1-req-1"]);
	assert.equal(h.watch.size(), 0);
	h.watch.onHelperEvent(h.eventOf(h.helperIds[0]));
	assert.deepEqual(h.published, []);

	const late = harness();
	await late.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 1 });
	// 项目先从 store 消失、登记还在（prune 尚未跑）：事件到达时也不得发通知。
	late.locators.clear();
	late.watch.onHelperEvent(late.eventOf(late.helperIds[0]));
	assert.deepEqual(late.published, []);
	assert.equal(late.watch.size(), 0);
	assert.deepEqual(late.calls.unwatch, ["w1-req-1"]);
});

test("dispose 全清：成对退订后不再接受订阅", async () => {
	const h = harness();
	await h.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 1 });
	await h.watch.dispose();
	assert.deepEqual(h.calls.unwatch, ["w1-req-1"]);
	assert.equal(h.watch.size(), 0);
	assert.deepEqual(plain(await h.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 1 })), { ok: false, code: "REQUEST_CANCELLED" });
});

test("退订失败不影响登记：helper 已死时 unwatch 静默收敛", async () => {
	const h = harness({ unwatchFailure: "PROTOCOL_INVALID" });
	const outcome = await h.watch.watch({ projectId: PROJECT, repoPath: "", senderId: 1 });
	await h.watch.unwatch(outcome.watchId, 1);
	assert.equal(h.watch.size(), 0);
	assert.deepEqual(h.calls.release, [[HOST, ROOT, CONN]]);
});
