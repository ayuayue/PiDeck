/**
 * rewind checkpoint 核心集成测试（真实 git，不 mock）。
 *
 * 覆盖：快照捕获（tracked 修改/删除 + 未跟踪 + node_modules 忽略 + 大文件跳过）、
 * 恢复（回退 + 清理新未跟踪 + 保护已存在未跟踪/忽略目录/大文件）、分支守卫、
 * 暂存区恢复、元数据往返、按会话过滤、prune（含 before-restore 保护）、
 * 旧会话清理、diff、空仓库、纯过滤函数。
 *
 * Windows 注意：测试仓库强制 core.autocrlf=false，否则 git 检出会把 LF 转 CRLF，
 * 与 writeFileSync 写入的字节不一致导致等值断言失败（开发机默认 autocrlf=true）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createCheckpoint, addPathsToIndex, restoreCheckpoint, loadCheckpointFromRef, loadAllCheckpoints, listCheckpointRefs, deleteCheckpoint, deleteCheckpoints, pruneCheckpoints, pruneOldSessions, diffCheckpoints, currentIndexTree } from "../src/main/rewind/checkpointCore.ts";
import { shouldIgnoreForSnapshot, normalizeGitPath, isSafeId, sanitizeForRef, findClosestCheckpoint } from "../src/main/rewind/checkpointFilter.ts";
import { MAX_UNTRACKED_TOTAL_BYTES } from "../src/main/rewind/checkpointConstants.ts";

const LARGE_BYTES = 10 * 1024 * 1024 + 1;
const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UUID_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

/** 建一个干净的临时 git 仓库并返回 { dir, git }；git 为同步执行封装。 */
function makeRepo() {
	const dir = mkdtempSync(join(tmpdir(), "rewind-test-"));
	const git = (args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
	git(["init", "-q", "-b", "main"]); // 显式指定分支名：不依赖本机 init.defaultBranch（CI 与本机的默认值不同）
	git(["config", "user.name", "test"]);
	git(["config", "user.email", "test@example.com"]);
	// autocrlf=false：保证工作区字节 = 提交字节（见文件头注释）。
	git(["config", "core.autocrlf", "false"]);
	// 全局若开了 gpg 签名，commit-tree 会尝试签名导致失败。
	git(["config", "commit.gpgsign", "false"]);
	return { dir, git };
}

function commitAll(git, msg) {
	git(["add", "-A"]);
	git(["commit", "-q", "-m", msg]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cpId(sessionId, turn) {
	return `turn-${sessionId}-${turn}-${Date.now()}`;
}

test("快照捕获：tracked 修改 + 未跟踪文件 + node_modules 忽略 + 大文件跳过", async (t) => {
	const { dir, git } = makeRepo();
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	writeFileSync(join(dir, "a.txt"), "v1\n");
	writeFileSync(join(dir, "del.txt"), "x\n");
	commitAll(git, "init");

	// 快照前状态：a.txt 修改、b.txt 未跟踪、node_modules 忽略、大文件跳过
	writeFileSync(join(dir, "a.txt"), "v2\n");
	writeFileSync(join(dir, "b.txt"), "new\n");
	mkdirSync(join(dir, "node_modules"));
	writeFileSync(join(dir, "node_modules", "dep.txt"), "dep\n");
	writeFileSync(join(dir, "big.bin"), Buffer.alloc(LARGE_BYTES, 0x61));

	const cp = await createCheckpoint({
		root: dir,
		id: cpId(UUID_A, 1),
		sessionId: UUID_A,
		trigger: "turn",
		turnIndex: 1,
		description: "user prompt",
	});

	assert.equal(cp.headSha.length, 40);
	assert.match(cp.branch, /^(master|main)$/);
	assert.ok(cp.indexTreeSha && cp.worktreeTreeSha, "两种树都要有");
	assert.ok(cp.skippedLargeFiles.includes("big.bin"), `大文件应进跳过名单，实际: ${cp.skippedLargeFiles}`);
	assert.ok(!cp.preexistingUntrackedFiles.includes("node_modules/dep.txt"), "忽略目录不进保护名单");
	assert.ok(cp.preexistingUntrackedFiles.includes("b.txt"), "未跟踪文件进保护名单");

	const refs = await listCheckpointRefs(dir);
	assert.ok(refs.includes(cp.id), "ref 应存在");

	// 快照之后工作区再被改动：删了 del.txt / b.txt、改 a.txt、新增 new.txt
	rmSync(join(dir, "del.txt"));
	rmSync(join(dir, "b.txt"));
	writeFileSync(join(dir, "a.txt"), "v3\n");
	writeFileSync(join(dir, "new.txt"), "new\n");

	await restoreCheckpoint(dir, cp);
	assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "v2\n", "tracked 修改应回退");
	assert.ok(existsSync(join(dir, "del.txt")), "快照后被删的跟踪文件应恢复");
	assert.ok(existsSync(join(dir, "b.txt")), "恢复应带回快照时的未跟踪文件");
	assert.ok(!existsSync(join(dir, "new.txt")), "快照后新出现的文件应清理");
	assert.ok(existsSync(join(dir, "node_modules", "dep.txt")), "忽略目录不被误删");
	assert.ok(existsSync(join(dir, "big.bin")), "大文件不被误删");
});

test("恢复：回退 tracked + 清理新未跟踪 + 保护快照时已存在未跟踪文件", async (t) => {
	const { dir, git } = makeRepo();
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	writeFileSync(join(dir, "a.txt"), "v1\n");
	commitAll(git, "init");

	// 快照前已有的未跟踪文件（恢复时必须保留）
	writeFileSync(join(dir, "keep.txt"), "keep\n");
	const cp = await createCheckpoint({
		root: dir,
		id: cpId(UUID_A, 1),
		sessionId: UUID_A,
		trigger: "turn",
		turnIndex: 1,
	});

	// 快照后工作区被改动 + 出现新未跟踪文件
	writeFileSync(join(dir, "a.txt"), "v2\n");
	writeFileSync(join(dir, "new.txt"), "new\n");

	await restoreCheckpoint(dir, cp);

	assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "v1\n", "tracked 应回退");
	assert.ok(existsSync(join(dir, "keep.txt")), "快照时已存在的未跟踪文件要保留");
	assert.ok(!existsSync(join(dir, "new.txt")), "快照后新出现的未跟踪文件应清理");
});

test("分支守卫：不在创建分支上恢复抛错，不破坏工作区", async (t) => {
	const { dir, git } = makeRepo();
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	writeFileSync(join(dir, "a.txt"), "v1\n");
	commitAll(git, "init");
	const cp = await createCheckpoint({
		root: dir,
		id: cpId(UUID_A, 1),
		sessionId: UUID_A,
		trigger: "turn",
		turnIndex: 1,
	});

	git(["checkout", "-b", "feature"]);
	writeFileSync(join(dir, "a.txt"), "feature-work\n");

	await assert.rejects(restoreCheckpoint(dir, cp), /Branch mismatch/, "不同分支上恢复必须抛分支不匹配");
	assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "feature-work\n", "守卫失败时工作区不得被动");
});

test("恢复暂存区态：checkpoint 时已暂存的内容恢复后仍在 index", async (t) => {
	const { dir, git } = makeRepo();
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	writeFileSync(join(dir, "a.txt"), "v1\n");
	commitAll(git, "init");

	writeFileSync(join(dir, "b.txt"), "staged\n");
	git(["add", "b.txt"]);
	const cp = await createCheckpoint({
		root: dir,
		id: cpId(UUID_A, 1),
		sessionId: UUID_A,
		trigger: "tool",
		turnIndex: 1,
		toolName: "write",
	});

	// 快照后把 index 和磁盘都改了：b.txt 从磁盘删掉、取消暂存
	rmSync(join(dir, "b.txt"));
	git(["reset", "-q"]);

	await restoreCheckpoint(dir, cp);

	const staged = git(["diff", "--cached", "--name-only"]).toString().trim();
	assert.ok(staged.includes("b.txt"), `b.txt 应回到暂存区，实际: ${staged}`);
	assert.ok(existsSync(join(dir, "b.txt")), "b.txt 应回到磁盘");
});

test("元数据往返：loadCheckpointFromRef 还原全部字段", async (t) => {
	const { dir, git } = makeRepo();
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	writeFileSync(join(dir, "a.txt"), "v1\n");
	commitAll(git, "init");
	writeFileSync(join(dir, "extra.txt"), "x\n");

	await sleep(3); // 让 timestamp 有区分度
	const cp = await createCheckpoint({
		root: dir,
		id: cpId(UUID_A, 7),
		sessionId: UUID_A,
		trigger: "tool",
		turnIndex: 7,
		toolName: "edit",
		description: "fix the thing",
	});

	const loaded = await loadCheckpointFromRef(dir, cp.id);
	assert.ok(loaded, "ref 存在时必能加载");
	assert.equal(loaded.id, cp.id);
	assert.equal(loaded.sessionId, UUID_A);
	assert.equal(loaded.trigger, "tool");
	assert.equal(loaded.turnIndex, 7);
	assert.equal(loaded.toolName, "edit");
	assert.equal(loaded.description, "fix the thing");
	assert.equal(loaded.headSha, cp.headSha);
	assert.equal(loaded.indexTreeSha, cp.indexTreeSha);
	assert.equal(loaded.worktreeTreeSha, cp.worktreeTreeSha);
	assert.ok(Math.abs(loaded.timestamp - cp.timestamp) < 5000, "时间戳近似一致");
	assert.deepEqual(loaded.preexistingUntrackedFiles, cp.preexistingUntrackedFiles);
});

test("按会话过滤 + deleteCheckpoint", async (t) => {
	const { dir, git } = makeRepo();
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	writeFileSync(join(dir, "a.txt"), "v1\n");
	commitAll(git, "init");

	const cpA = await createCheckpoint({
		root: dir,
		id: cpId(UUID_A, 1),
		sessionId: UUID_A,
		trigger: "turn",
		turnIndex: 1,
	});
	const cpB = await createCheckpoint({
		root: dir,
		id: cpId(UUID_B, 1),
		sessionId: UUID_B,
		trigger: "turn",
		turnIndex: 1,
	});

	const onlyA = await loadAllCheckpoints(dir, UUID_A);
	assert.equal(onlyA.length, 1);
	assert.equal(onlyA[0].id, cpA.id);

	await deleteCheckpoint(dir, cpB.id);
	const all = await loadAllCheckpoints(dir);
	assert.deepEqual(
		all.map((c) => c.id),
		[cpA.id],
	);
});

test("800+ refs（远超 Windows 命令行上限）时 loadAllCheckpoints 仍全量读取（回归）", async (t) => {
	// 回归背景：实现曾把全部 SHA 拼进 `git log --no-walk <shas>`——多会话共享仓库
	// 时 refs 积累到数百/上千，Windows 32767 字符上限被超（Node spawn ENAMETOOLONG），
	// 整批失败被 catch 吞成 []，任何会话的检查点列表都显示「暂无」。
	// 修复：SHA 改经 stdin 传给 git cat-file --batch（无命令行长度限制）。
	const { dir, git } = makeRepo();
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	writeFileSync(join(dir, "a.txt"), "v1\n");
	commitAll(git, "init");

	const cp = await createCheckpoint({
		root: dir,
		id: cpId(UUID_A, 1),
		sessionId: UUID_A,
		trigger: "tool",
		turnIndex: 1,
		toolName: "bash",
	});
	const sha = String(git(["rev-parse", `refs/pi-checkpoints/${cp.id}`])).trim();
	// 同一 commit 对象挂 800 个 ref（refs 可多对一，2 次 git 调用即完成注入）；
	// 800×41 字符 ≈ 33KB，超过 Windows CreateProcess 32767 上限。
	const lines = [];
	for (let i = 0; i < 800; i++) {
		lines.push(`create refs/pi-checkpoints/extra-${UUID_A}-1-${i} ${sha}`);
	}
	execFileSync("git", ["update-ref", "--stdin"], {
		cwd: dir,
		input: lines.join("\n") + "\n",
	});

	const all = await loadAllCheckpoints(dir, UUID_A);
	assert.equal(all.length, 801, "800+ refs 时必须全量读取（回归：命令行超长时代码返回 []）");
});

test("prune：按时间裁最旧，before-restore 永不裁剪", async (t) => {
	const { dir, git } = makeRepo();
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	writeFileSync(join(dir, "a.txt"), "v1\n");
	commitAll(git, "init");

	const ids = [];
	for (let i = 1; i <= 4; i++) {
		await sleep(3);
		// 每轮改一点内容，避免相同树（时间戳靠 sleep 区分）
		writeFileSync(join(dir, "a.txt"), `v${i}\n`);
		const cp = await createCheckpoint({
			root: dir,
			id: cpId(UUID_A, i),
			sessionId: UUID_A,
			trigger: "turn",
			turnIndex: i,
		});
		ids.push(cp.id);
	}
	// before-restore 安全网（最旧，本应被裁）
	await sleep(3);
	const safety = await createCheckpoint({
		root: dir,
		id: `before-restore-${UUID_A}-0-${Date.now()}`,
		sessionId: UUID_A,
		trigger: "before-restore",
		turnIndex: 0,
	});

	const deleted = await pruneCheckpoints(dir, UUID_A, 2);
	assert.equal(deleted, 2, "保留 2 个普通点，应裁 2 个");

	const remaining = await loadAllCheckpoints(dir, UUID_A);
	const remainingIds = remaining.map((c) => c.id);
	// 普通点留最新的 2 个 + 安全网永远在
	assert.ok(remainingIds.includes(ids[2]) && remainingIds.includes(ids[3]), "留最新两个");
	assert.ok(remainingIds.includes(safety.id), "before-restore 不被裁剪");
});

test("pruneOldSessions：清理其他会话的 checkpoint", async (t) => {
	const { dir, git } = makeRepo();
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	writeFileSync(join(dir, "a.txt"), "v1\n");
	commitAll(git, "init");

	const cpA = await createCheckpoint({
		root: dir,
		id: cpId(UUID_A, 1),
		sessionId: UUID_A,
		trigger: "turn",
		turnIndex: 1,
	});
	const cpB1 = await createCheckpoint({
		root: dir,
		id: cpId(UUID_B, 1),
		sessionId: UUID_B,
		trigger: "turn",
		turnIndex: 1,
	});
	const cpB2 = await createCheckpoint({
		root: dir,
		id: cpId(UUID_B, 2),
		sessionId: UUID_B,
		trigger: "turn",
		turnIndex: 2,
	});

	const deleted = await pruneOldSessions(dir, UUID_A, 0);
	assert.equal(deleted, 2, "会话 B 的 2 个点应被清掉");

	const remaining = await loadAllCheckpoints(dir);
	assert.deepEqual(
		remaining.map((c) => c.id),
		[cpA.id],
	);
});

test("pruneOldSessions：keep 集合为数组时保留全部活跃会话", async (t) => {
	const { dir, git } = makeRepo();
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	writeFileSync(join(dir, "a.txt"), "v1\n");
	commitAll(git, "init");

	const cpA = await createCheckpoint({
		root: dir,
		id: cpId(UUID_A, 1),
		sessionId: UUID_A,
		trigger: "turn",
		turnIndex: 1,
	});
	const cpB = await createCheckpoint({
		root: dir,
		id: cpId(UUID_B, 1),
		sessionId: UUID_B,
		trigger: "turn",
		turnIndex: 1,
	});
	await createCheckpoint({
		root: dir,
		id: cpId(UUID_C, 1),
		sessionId: UUID_C,
		trigger: "turn",
		turnIndex: 1,
	});

	const deleted = await pruneOldSessions(dir, [UUID_A, UUID_B], 0);
	assert.equal(deleted, 1, "只清非活跃会话 C");

	const remaining = await loadAllCheckpoints(dir);
	assert.deepEqual(remaining.map((c) => c.id).sort(), [cpA.id, cpB.id].sort(), "活跃会话 A/B 的点全部保留");
});

test("deleteCheckpoints：批量删除 ref，缺失 id 容忍", async (t) => {
	const { dir, git } = makeRepo();
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	writeFileSync(join(dir, "a.txt"), "v1\n");
	commitAll(git, "init");

	const ids = [];
	for (let i = 1; i <= 3; i++) {
		const cp = await createCheckpoint({
			root: dir,
			id: cpId(UUID_A, i),
			sessionId: UUID_A,
			trigger: "turn",
			turnIndex: i,
		});
		ids.push(cp.id);
	}

	// 混入一个不存在的 id（并发裁剪场景），批次不应失败
	await deleteCheckpoints(dir, [ids[0], "no-such-id", ids[2]]);

	const remaining = await loadAllCheckpoints(dir);
	assert.deepEqual(
		remaining.map((c) => c.id),
		[ids[1]],
		"仅中间那个点保留",
	);
	assert.equal(
		String(git(["for-each-ref", "refs/pi-checkpoints", "--format=%(refname)"]))
			.trim()
			.split("\n").length,
		1,
	);
});

test("diff：两个 checkpoint 之间的变更摘要", async (t) => {
	const { dir, git } = makeRepo();
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	writeFileSync(join(dir, "a.txt"), "v1\n");
	commitAll(git, "init");

	const cp1 = await createCheckpoint({
		root: dir,
		id: cpId(UUID_A, 1),
		sessionId: UUID_A,
		trigger: "turn",
		turnIndex: 1,
	});
	writeFileSync(join(dir, "a.txt"), "v2\n");
	writeFileSync(join(dir, "new.txt"), "n\n");
	const cp2 = await createCheckpoint({
		root: dir,
		id: cpId(UUID_A, 2),
		sessionId: UUID_A,
		trigger: "turn",
		turnIndex: 2,
	});

	const diff = await diffCheckpoints(dir, cp1.worktreeTreeSha, cp2.worktreeTreeSha);
	assert.match(diff, /a\.txt/);
	assert.match(diff, /new\.txt/);
});

test("空仓库：无 HEAD 也能创建并恢复 checkpoint", async (t) => {
	const { dir } = makeRepo();
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	writeFileSync(join(dir, "draft.txt"), "draft\n");

	const cp = await createCheckpoint({
		root: dir,
		id: cpId(UUID_A, 1),
		sessionId: UUID_A,
		trigger: "turn",
		turnIndex: 1,
	});
	assert.equal(cp.headSha, "0".repeat(40), "空仓库 headSha 应为 ZEROS");

	writeFileSync(join(dir, "junk.txt"), "junk\n");
	await restoreCheckpoint(dir, cp);
	assert.ok(!existsSync(join(dir, "junk.txt")), "新未跟踪应清理");
	assert.ok(existsSync(join(dir, "draft.txt")), "快照时未跟踪文件应保留");
});

test("纯过滤函数", () => {
	assert.ok(shouldIgnoreForSnapshot("src/node_modules/x/y.js"));
	assert.ok(shouldIgnoreForSnapshot("build/out.js"));
	assert.ok(!shouldIgnoreForSnapshot("src/app.ts"));
	assert.ok(!shouldIgnoreForSnapshot("docs/README.md"));
	// PiDeck 侧扩展的产物目录（2026-09-13 用户报告的 .runs 类场景）
	assert.ok(shouldIgnoreForSnapshot(".runs/shot-1.png"));
	assert.ok(shouldIgnoreForSnapshot("sub/.runs/deep/file.bin"));
	assert.ok(shouldIgnoreForSnapshot("out/app.js"));
	assert.ok(shouldIgnoreForSnapshot("target/debug/thing"));
	assert.ok(shouldIgnoreForSnapshot("shots/001.png"));
	assert.ok(!shouldIgnoreForSnapshot("src/main.rs"));

	assert.equal(normalizeGitPath(".\\foo\\bar"), "foo/bar");
	assert.equal(normalizeGitPath("foo/"), "foo");
	assert.equal(normalizeGitPath("./x/y"), "x/y");

	assert.ok(isSafeId("turn-abc-1-1719000000000"));
	assert.ok(!isSafeId("../evil"));
	assert.ok(!isSafeId("a b"));
	assert.ok(!isSafeId("a/b"));

	assert.equal(sanitizeForRef("my prompt / 2"), "my_prompt___2");

	const cps = [{ timestamp: 100 }, { timestamp: 200 }, { timestamp: 300 }];
	assert.equal(findClosestCheckpoint(cps, 250).timestamp, 200);
	assert.equal(findClosestCheckpoint(cps, 100).timestamp, 100);
	assert.equal(findClosestCheckpoint([], 100), undefined);
});

test("addPathsToIndex：批次内坏路径被剔除，好路径不受牵连（回归：坏 pathspec fatal 整条命令丢快照）", async (t) => {
	const { dir, git } = makeRepo();
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	writeFileSync(join(dir, "good.txt"), "good\n");
	writeFileSync(join(dir, "good2.txt"), "good2\n");
	writeFileSync(join(dir, ".gitignore"), "ignore-me.txt\n");
	// ghost.txt 不存在（枚举后被删除的场景）

	const dropped = await addPathsToIndex(dir, {}, ["good.txt", "good2.txt", "ignore-me.txt", "ghost.txt"]);
	assert.deepEqual([...dropped].sort(), ["ghost.txt", "ignore-me.txt"], "被 .gitignore 命中与不存在的路径应被剔除，其余保留");
	const staged = git(["diff", "--cached", "--name-only"]).toString().trim();
	assert.ok(staged.includes("good.txt"), "好路径 1 应被暂存");
	assert.ok(staged.includes("good2.txt"), "好路径 2 应被暂存");
	assert.ok(!staged.includes("ignore-me.txt"), "忽略路径不得进 index");
});

test("未跟踪总字节预算：超预算文件跳过快照、受恢复保护、元数据可往返（回归：.runs 类大量小文件读满磁盘）", async (t) => {
	const { dir, git } = makeRepo();
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	writeFileSync(join(dir, "a.txt"), "v1\n");
	commitAll(git, "init");

	// 70 个 1MiB 文件 = 70MiB > 64MiB 预算：排在后面的文件被整体跳过。
	// 每个文件 1MiB，远低于单文件 10MiB 阈值（旧闸门挡不住的场景）。
	const FILE_COUNT = 70;
	for (let i = 0; i < FILE_COUNT; i++) {
		writeFileSync(join(dir, `f${String(i).padStart(3, "0")}.bin`), Buffer.alloc(1024 * 1024, 0x61));
	}

	const cp = await createCheckpoint({
		root: dir,
		id: cpId(UUID_A, 1),
		sessionId: UUID_A,
		trigger: "turn",
		turnIndex: 1,
	});

	assert.ok(cp.skippedOverBudgetFiles, "超预算跳过名单应有值");
	const skipped = cp.skippedOverBudgetFiles;
	assert.ok(skipped.length > 0 && skipped.length < FILE_COUNT, `应部分跳过，实际 ${skipped.length}/${FILE_COUNT}`);
	// 实际进快照树的 f*.bin（ls-tree 数）+ 跳过的 = 全部未跟踪文件（无遗漏）。
	// 注意 preexistingUntrackedFiles 是恢复保护名单，超预算文件也在其中（设计如此），
	// 不能用它数"进了快照树"的数量。
	const treeOut = git(["ls-tree", "-r", "--name-only", cp.worktreeTreeSha]).toString();
	const indexedInTree = treeOut.split("\n").filter((p) => /^f\d+\.bin$/.test(p)).length;
	assert.equal(indexedInTree + skipped.length, FILE_COUNT);
	// 实际纳入 index 的字节量不超预算：跳过名单之外每个文件都是 1MiB
	assert.ok(indexedInTree * 1024 * 1024 <= MAX_UNTRACKED_TOTAL_BYTES + 1024 * 1024, "纳入总量应贴近且不超过预算");
	// 但保护名单必须覆盖全部 70 个（恢复时不许删任何一个）
	const protectedCount = cp.preexistingUntrackedFiles.filter((p) => /^f\d+\.bin$/.test(p)).length;
	assert.equal(protectedCount, FILE_COUNT);

	// 元数据往返：loadCheckpointFromRef 还原 skippedOverBudgetFiles
	const loaded = await loadCheckpointFromRef(dir, cp.id);
	assert.deepEqual(loaded.skippedOverBudgetFiles, skipped);

	// 恢复：超预算文件存在于快照时刻，必须受保护不被 safeClean 误删
	await restoreCheckpoint(dir, cp);
	for (const p of skipped) {
		assert.ok(existsSync(join(dir, p)), `超预算文件 ${p} 恢复时不被误删`);
	}
	for (let i = 0; i < FILE_COUNT; i++) {
		const p = `f${String(i).padStart(3, "0")}.bin`;
		assert.ok(existsSync(join(dir, p)), `全部未跟踪文件恢复后都应存在（含纳入与跳过）：${p}`);
	}
});

test("预算未超时无跳过（正常小仓库行为不变）", async (t) => {
	const { dir, git } = makeRepo();
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	writeFileSync(join(dir, "a.txt"), "v1\n");
	commitAll(git, "init");
	writeFileSync(join(dir, "small.txt"), "s\n");

	const cp = await createCheckpoint({
		root: dir,
		id: cpId(UUID_A, 1),
		sessionId: UUID_A,
		trigger: "turn",
		turnIndex: 1,
	});
	assert.equal(cp.skippedOverBudgetFiles, undefined, "预算未超时不应有跳过名单");
	assert.ok(cp.preexistingUntrackedFiles.includes("small.txt"));
});

// ---------------------------------------------------------------------------
// merge 冲突（unmerged index）降级：2026-10 用户实锤——工作区 merge 冲突期间自动
// 打点 3 连败（git write-tree: error building trees），检查点整体不可用。降级语义：
// index 树记为 HEAD 树（恢复时把冲突态 index 重置回 HEAD），快照不中断。
// ---------------------------------------------------------------------------

/** 构造 merge 冲突仓库：main 与 side 分支改同一文件后 merge，index 进入 unmerged。 */
function makeConflictRepo() {
	const { dir, git } = makeRepo();
	writeFileSync(join(dir, "f.txt"), "base\n");
	commitAll(git, "base");
	git(["checkout", "-q", "-b", "side"]);
	writeFileSync(join(dir, "f.txt"), "side\n");
	commitAll(git, "side");
	git(["checkout", "-q", "main"]);
	writeFileSync(join(dir, "f.txt"), "master\n");
	commitAll(git, "main");
	try {
		git(["merge", "side"]);
	} catch {
		// 冲突时 git merge 非零退出，正是要构造的状态
	}
	const unmerged = git(["ls-files", "-u"]).toString().trim();
	assert.ok(unmerged.length > 0, "fixture 必须处于 unmerged 态");
	return { dir, git };
}

test("merge 冲突仓库：createCheckpoint 降级成功（index 树 = HEAD 树）而非整体失败", async (t) => {
	const { dir, git } = makeConflictRepo();
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const cp = await createCheckpoint({
		root: dir,
		id: cpId(UUID_A, 1),
		sessionId: UUID_A,
		trigger: "turn",
		turnIndex: 1,
	});
	const headSha = git(["rev-parse", "HEAD"]).toString().trim();
	assert.equal(cp.indexTreeDegraded, true, "应标记降级");
	assert.equal(cp.indexTreeSha, headSha, "index 树降级为 HEAD 树");
	assert.ok(cp.worktreeTreeSha, "worktree 树仍完整（临时 index 不受冲突影响）");

	// 恢复也应可用：冲突态 index 被重置回 HEAD，工作区回到快照时刻（含冲突标记文件内容）
	await restoreCheckpoint(dir, cp);
	const unmergedAfter = git(["ls-files", "-u"]).toString().trim();
	assert.equal(unmergedAfter, "", "恢复后 index 不再 unmerged");
});

test("merge 冲突仓库：currentIndexTree 降级为 HEAD 树（回退预览不整体报错）", async (t) => {
	const { dir, git } = makeConflictRepo();
	t.after(() => rmSync(dir, { recursive: true, force: true }));

	const headSha = git(["rev-parse", "HEAD"]).toString().trim();
	assert.equal(await currentIndexTree(dir), headSha);
});

test("非冲突的 write-tree 失败仍照常抛出（降级只针对 unmerged）", async (t) => {
	// 直接破坏 git 仓库对象库制造非冲突失败：目录当 .git 用会让 git 命令整体挂。
	// 用真实仓库 + rev-parse 校验为主的行为级断言成本高，这里用源码断言保证降级
	// 分支确实先探测 unmerged 再吞错（正则空白容忍，见 AGENTS.md 格式化纪律）。
	const source = readFileSync("src/main/rewind/checkpointCore.ts", "utf8");
	assert.match(source, /indexTreeDegraded = true;\s*return headSha;/);
	assert.match(source, /if \(await detectUnmerged\(root\)\)\s*\{\s*return \(await gitOp\(root, \["rev-parse", "HEAD"\]/);
});
