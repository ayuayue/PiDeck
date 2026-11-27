import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// #603：Git 面板的自动 fetch 与用户点的「拉取」会并发更新同一个远程跟踪引用，
// 后加锁的一方报 `cannot lock ref`，pull 在合并前就退出（HEAD 不动）。
// 修法一：主进程按仓库 cwd 串行化 fetch / pull / push（本文件的队列）；
// 修法二：命中 cannot lock ref 时重跑一次（isRefLockError 判定）。
const { withRepoRefLock, isRefLockError, withRefLockRetry } = loadTsCommonJs("src/main/git/gitRefQueue.ts");

function tracker() {
	let running = 0;
	let maxConcurrent = 0;
	const order = [];
	const run = (label, settle) => async () => {
		running += 1;
		maxConcurrent = Math.max(maxConcurrent, running);
		order.push(`start:${label}`);
		try {
			await settle();
			return label;
		} finally {
			running -= 1;
			order.push(`end:${label}`);
		}
	};
	return {
		run,
		get maxConcurrent() {
			return maxConcurrent;
		},
		get order() {
			return order;
		},
	};
}

/** 一个手动放行的 Promise。 */
function gate() {
	let release;
	const promise = new Promise((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

test("同一仓库的操作串行执行，不会同时加远程引用锁", async () => {
	const t = tracker();
	const first = gate();
	const fetch = withRepoRefLock(
		"/repo",
		t.run("fetch", () => first.promise),
	);
	const pull = withRepoRefLock(
		"/repo",
		t.run("pull", () => Promise.resolve()),
	);

	// fetch 还没结束，pull 不允许开始
	await Promise.resolve();
	assert.deepEqual(t.order, ["start:fetch"]);
	first.release();
	assert.equal(await fetch, "fetch");
	assert.equal(await pull, "pull");
	assert.deepEqual(t.order, ["start:fetch", "end:fetch", "start:pull", "end:pull"]);
	assert.equal(t.maxConcurrent, 1);
});

test("不同仓库互不排队", async () => {
	const t = tracker();
	const blocked = gate();
	withRepoRefLock(
		"/repo-a",
		t.run("a-fetch", () => blocked.promise),
	);
	const other = await withRepoRefLock(
		"/repo-b",
		t.run("b-pull", () => Promise.resolve()),
	);
	assert.equal(other, "b-pull");
	blocked.release();
});

test("前一个操作失败不连坐后面排队的操作", async () => {
	const t = tracker();
	const failing = withRepoRefLock(
		"/repo",
		t.run("fetch", () => Promise.reject(new Error("network down"))),
	);
	const pulling = withRepoRefLock(
		"/repo",
		t.run("pull", () => Promise.resolve()),
	);

	await assert.rejects(failing, /network down/);
	assert.equal(await pulling, "pull");
	// 排空后队列不再占 key：下一笔操作仍能正常执行（不会因残留的 rejected Promise 直接失败）
	assert.equal(await withRepoRefLock("/repo", async () => "push"), "push");
});

test("isRefLockError 只认并发抢锁的报错", () => {
	assert.equal(isRefLockError("error: cannot lock ref 'refs/remotes/origin/dev': is at 7b5d28df but expected 81dfd2b8"), true);
	assert.equal(isRefLockError("From https://gitee.com/x/y\n !  81dfd2b8..7b5d28df  dev -> origin/dev  (unable to update local ref)"), false);
	assert.equal(isRefLockError("fatal: not a git repository (or any of the parent directories): .git"), false);
});

test("withRefLockRetry 只在撞锁时重跑一次，其它错误直接上抛", async () => {
	let attempts = 0;
	const locked = await withRefLockRetry(async () => {
		attempts += 1;
		if (attempts === 1) throw new Error("error: cannot lock ref 'refs/remotes/origin/dev': is at 7b5d28df but expected 81dfd2b8");
		return "pulled";
	});
	assert.equal(locked, "pulled");
	assert.equal(attempts, 2);

	// 连撞两次不再重跑（重跑不收敛就该上抛，不能无限重试）
	let stuck = 0;
	await assert.rejects(
		withRefLockRetry(async () => {
			stuck += 1;
			throw new Error("error: cannot lock ref 'refs/remotes/origin/dev'");
		}),
		/cannot lock ref/,
	);
	assert.equal(stuck, 2);

	// 非撞锁错误（无上游 / 认证失败 / 冲突）不重跑：重跑只会再阻塞一次
	let blocked = 0;
	await assert.rejects(
		withRefLockRetry(async () => {
			blocked += 1;
			throw new Error("fatal: unable to access 'https://example.invalid/repo': 403");
		}),
		/403/,
	);
	assert.equal(blocked, 1);
});

test("push / pull / fetch 的 IPC 都走同一个仓库串行队列，pull 失败写日志", async () => {
	const { registerGitSyncIpc } = loadTsCommonJs("src/main/ipc/gitSyncIpc.ts");
	const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
	const handlers = new Map();
	const logs = [];
	const calls = [];
	let running = 0;
	let maxConcurrent = 0;
	let blockFetch;
	let failNextPull = null;
	const gitOp = (name) => async () => {
		running += 1;
		maxConcurrent = Math.max(maxConcurrent, running);
		calls.push(name);
		try {
			if (blockFetch) await blockFetch;
			if (name === "pull" && failNextPull) {
				const error = new Error(failNextPull);
				failNextPull = null;
				throw error;
			}
		} finally {
			running -= 1;
		}
	};
	registerGitSyncIpc({
		handleProjectGit: (channel, listener) => handlers.set(channel, listener),
		requireGitCwd: async () => "/repo",
		gitService: { push: gitOp("push"), pull: gitOp("pull"), fetch: gitOp("fetch"), isGitRepo: async () => true },
		appLogger: { info: (scope, message, detail) => logs.push({ level: "info", scope, message, detail }), warn: (scope, message, detail) => logs.push({ level: "warn", scope, message, detail }) },
	});
	const invoke = (channel) => handlers.get(ipcChannels[channel])(null, "project-1");

	// 两个 git 进程不能同时更新远程跟踪引用：先排队进入的那个占着锁，另一个不开始
	let releaseFetch;
	blockFetch = new Promise((resolve) => {
		releaseFetch = resolve;
	});
	const fetching = invoke("gitFetch");
	const pulling = invoke("gitPull");
	// 两个 handler 都过了前置 await（isGitRepo / requireGitCwd）后，只能有一个真正进 git。
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.length, 1, "另一个操作必须排队（同时在跑就会抢 refs/remotes 的锁）");
	releaseFetch();
	await Promise.all([fetching, pulling]);
	assert.deepEqual(calls.slice().sort(), ["fetch", "pull"]);
	assert.equal(maxConcurrent, 1);

	// 外部 git 抢先更新引用：pull 报 cannot lock ref 时重跑一次就成功
	blockFetch = null;
	calls.length = 0;
	failNextPull = "error: cannot lock ref 'refs/remotes/origin/dev': is at 7b5d28df but expected 81dfd2b8";
	await invoke("gitPull");
	assert.deepEqual(calls, ["pull", "pull"]);
	assert.equal(logs.at(-1).message, "Pulled");
	assert.equal(logs.at(-1).level, "info");

	// 拉取真失败（认证 / 冲突）：只重跑撞锁，其余直接上抛并写 warn 日志
	calls.length = 0;
	failNextPull = "fatal: unable to access 'https://example.invalid/repo': 403";
	await assert.rejects(invoke("gitPull"), /403/);
	assert.deepEqual(calls, ["pull"]);
	const failure = logs.at(-1);
	assert.equal(failure.level, "warn");
	assert.equal(failure.message, "Pull failed");
	assert.match(failure.detail.error, /403/);

	// 非仓库目录的 fetch 直接跳过（面板首次挂载时 status 与 fetch 并行）
	calls.length = 0;
	handlers.clear();
	registerGitSyncIpc({
		handleProjectGit: (channel, listener) => handlers.set(channel, listener),
		requireGitCwd: async () => "/repo",
		gitService: { push: gitOp("push"), pull: gitOp("pull"), fetch: gitOp("fetch"), isGitRepo: async () => false },
		appLogger: { info: () => {}, warn: () => {} },
	});
	await invoke("gitFetch");
	assert.deepEqual(calls, []);
});
