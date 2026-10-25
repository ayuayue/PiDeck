/**
 * rewind checkpoint 健壮性（#372 / #373）。
 *
 * #372：createCheckpoint 先对「用户真实 index」执行 git write-tree，
 *       而 write-tree 会刷新 cache-tree 并写回 index → 需要 .git/index.lock。
 *       agent 或用户同时在跑 git 时就会撞锁，checkpoint 直接失败（实测日 14–22 次）。
 * #373：非 git 仓库的会话每轮重试 write-tree，全部失败并刷屏（占失败 70%）。
 *
 * 本文件用真实 git 复现两个场景；Windows 上强制 core.autocrlf=false，同 rewindCheckpointCore.test.mjs。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

import { createCheckpoint } from "../src/main/rewind/checkpointCore.ts";
// coordinator 用构造函数参数属性（private readonly host），Node 的 TS 剥离不支持，走 tsc 转换
const { RewindCheckpointCoordinator } = loadTsCommonJs("src/main/pi/RewindCheckpointCoordinator.ts");

const UUID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function makeRepo() {
	const dir = mkdtempSync(join(tmpdir(), "rewind-robust-"));
	const git = (args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
	git(["init", "-q"]);
	git(["config", "user.name", "test"]);
	git(["config", "user.email", "test@example.com"]);
	git(["config", "core.autocrlf", "false"]);
	git(["config", "commit.gpgsign", "false"]);
	return { dir, git };
}

function commitAll(git, msg) {
	git(["add", "-A"]);
	git(["commit", "-q", "-m", msg]);
}

/**
 * 带重试的临时仓库删除：2027-02 起 runCheckpoint 成功后会异步触发 pruneCurrentFor
 *（后台 git for-each-ref/update-ref），t.after 的 rmSync 可能与在途 git 子进程的
 * 目录句柄竞争（Windows EPERM）。这与生产行为一致——后台裁剪本来就是 fire-and-forget；
 * 清理侧按 Windows 惯例退避重试，而不是让用例闪烁。
 */
function rmRepoRetry(dir) {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		try {
			rmSync(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			if (attempt === 9) throw error;
			const slept = Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
			void slept;
		}
	}
}

const cpId = (turn) => `turn-${UUID}-${turn}-${Date.now()}`;

test("#372 用户 index 被锁（.git/index.lock 存在）时 checkpoint 仍应成功", async (t) => {
	const { dir, git } = makeRepo();
	t.after(() => rmRepoRetry(dir));

	writeFileSync(join(dir, "a.txt"), "v1\n");
	commitAll(git, "init");
	// 暂存区有真实内容：indexTreeSha 必须能反映它，而不是退化成 HEAD
	writeFileSync(join(dir, "a.txt"), "v2\n");
	git(["add", "a.txt"]);
	const stagedTree = git(["write-tree"]).toString().trim();
	const headTree = git(["rev-parse", "HEAD^{tree}"]).toString().trim();

	// 模拟「用户/agent 的 git 正在写 index」：锁文件存在
	const lockPath = join(dir, ".git", "index.lock");
	writeFileSync(lockPath, "");

	const cp = await createCheckpoint({ root: dir, id: cpId(1), sessionId: UUID, trigger: "turn", turnIndex: 1 });

	// 关键断言：不再因为抢不到锁而失败
	assert.ok(cp, "checkpoint should succeed even when user index is locked");
	// 且 index 树仍是「暂存后的真实状态」，没有偷懒退化成 HEAD 树
	assert.ok(!cp.indexTreeDegraded, "index tree must not degrade when only the lock is the obstacle");
	assert.equal(cp.indexTreeSha, stagedTree, "必须准确捕获暂存树");
	assert.notEqual(cp.indexTreeSha, headTree, "暂存树不能降级为 HEAD 树");

	rmSync(lockPath, { force: true });
});

test("#372 未暂存的工作区修改不影响 index 树语义", async (t) => {
	const { dir, git } = makeRepo();
	t.after(() => rmRepoRetry(dir));

	writeFileSync(join(dir, "a.txt"), "v1\n");
	commitAll(git, "init");
	// 只改工作区，不 add：index 树应等于 HEAD 树
	writeFileSync(join(dir, "a.txt"), "v2\n");

	const headTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: dir, stdio: "pipe" }).toString().trim();
	const cp = await createCheckpoint({ root: dir, id: cpId(1), sessionId: UUID, trigger: "turn", turnIndex: 1 });
	// index 树 = HEAD 树（工作区修改未暂存，不该进 index 树）
	assert.equal(cp.indexTreeSha, headTree, "unstaged edits must not appear in the index tree");
	// worktree 树必须捕获工作区修改，与 index 树不同
	assert.notEqual(cp.worktreeTreeSha, headTree, "worktree tree must still capture the edit");
});

/** 造一个只记录日志的 host，session 固定指向给定 cwd。 */
function makeCoordinator(cwd, onWarn = () => {}) {
	const warns = [];
	const infos = [];
	const host = {
		getSessionInfo: () => ({ cwd, sessionId: UUID }),
		hostRoot: (value) => value,
		listAgentSessions: () => [{ cwd, sessionId: UUID }],
		logInfo: (message, meta) => infos.push({ message, meta }),
		logWarn: (message, meta) => {
			warns.push({ message, meta });
			onWarn();
		},
	};
	return { coordinator: new RewindCheckpointCoordinator(host), warns, infos };
}

const freshState = () => ({ lastAt: 0, inFlight: false, pending: false, timer: null });

test("#373 非 git 目录：首次失败说明原因，后续轮次不再刷屏", async (t) => {
	// 普通临时目录，不 git init
	const dir = mkdtempSync(join(tmpdir(), "rewind-nogit-"));
	t.after(() => rmRepoRetry(dir));

	const { coordinator, warns } = makeCoordinator(dir);

	await coordinator.runCheckpoint("a1", freshState(), "bash", 1);
	const firstRound = warns.length;
	assert.equal(firstRound, 1, "首次失败应该有一条说明");
	assert.match(warns[0].message, /not a git repository/i);
	assert.equal(coordinator.healthForRoot(dir)?.lastErrorKind, "no-git");

	// 同一目录再来三轮：应全部跳过（冷却期内），日志不再增长
	await coordinator.runCheckpoint("a1", freshState(), "bash", 2);
	await coordinator.runCheckpoint("a1", freshState(), "bash", 3);
	await coordinator.runCheckpoint("a1", freshState(), "bash", 4);
	assert.equal(warns.length, firstRound, "冷却期内不应再写日志");
	assert.equal(coordinator.healthForRoot(dir)?.consecutiveFailures, 1, "跳过时不应累计失败次数");
});

test("#373 公开调度入口：同 root 的不同 agent 共享冷却，只告警一次", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "rewind-schedule-"));
	t.after(() => rmRepoRetry(dir));
	let notify;
	const warned = new Promise((resolve) => {
		notify = resolve;
	});
	const { coordinator, warns } = makeCoordinator(dir, () => notify());
	t.after(() => {
		coordinator.clearAgent("a1");
		coordinator.clearAgent("a2");
	});
	coordinator.scheduleToolCheckpoint("a1", "bash", 1);
	await Promise.race([
		warned,
		new Promise((_, reject) => {
			const timer = setTimeout(() => reject(new Error("等待自动打点告警超时")), 15000);
			timer.unref();
			t.after(() => clearTimeout(timer));
		}),
	]);
	// a2 的新调度状态没有时间节流，必须由 root 级冷却直接跳过。
	coordinator.scheduleToolCheckpoint("a2", "write", 2);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(warns.length, 1);
	assert.equal(coordinator.healthForRoot(dir)?.consecutiveFailures, 1);
});

test("#373 冷却期结束后重新尝试，成功即恢复打点", async (t) => {
	const { dir, git } = makeRepo();
	t.after(() => rmRepoRetry(dir));

	writeFileSync(join(dir, "a.txt"), "v1\n");
	commitAll(git, "init");

	const { coordinator, warns } = makeCoordinator(dir);
	// 模拟「之前这个目录不是 git 仓库，已失败过一次并进入冷却」
	coordinator.healthByRoot.set(dir, { consecutiveFailures: 1, lastErrorKind: "no-git" });
	coordinator.noGitRetryAt.set(dir, Date.now() - 1); // 冷却已过期

	await coordinator.runCheckpoint("a1", freshState(), "bash", 1);

	assert.equal(warns.length, 0, "冷却过期后应真正执行并成功，不再写失败日志");
	assert.equal(coordinator.healthForRoot(dir)?.lastErrorKind, undefined, "成功后应清空错误类型");
	assert.equal(coordinator.healthForRoot(dir)?.consecutiveFailures, 0);
	assert.ok(!coordinator.noGitRetryAt.has(dir), "成功后应清除冷却标记");
});

test("#372 多次 checkpoint 后用户暂存内容保持不变", async (t) => {
	const { dir, git } = makeRepo();
	t.after(() => rmRepoRetry(dir));

	writeFileSync(join(dir, "a.txt"), "v1\n");
	commitAll(git, "init");
	writeFileSync(join(dir, "b.txt"), "staged\n");
	git(["add", "b.txt"]);

	const stagedTreeBefore = git(["write-tree"]).toString().trim();

	await createCheckpoint({ root: dir, id: cpId(1), sessionId: UUID, trigger: "turn", turnIndex: 1 });
	await createCheckpoint({ root: dir, id: cpId(2), sessionId: UUID, trigger: "turn", turnIndex: 2 });

	// status 可能刷新 index 字节；比较树和 blob 内容，不把缓存更新误判为暂存区改动。
	assert.equal(git(["write-tree"]).toString().trim(), stagedTreeBefore);
	assert.equal(git(["show", ":b.txt"]).toString(), "staged\n");
});
