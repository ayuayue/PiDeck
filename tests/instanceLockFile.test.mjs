import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 回归背景（Linux 用户反馈，0.7.4 → 0.7.5 应用内更新后）：
 * 升级过程中被 kill，`will-quit` 的清理没跑，锁文件残留；旧实现只做
 * `process.kill(pid, 0)` 存活探测，遇到「PID 被复用」或「僵尸进程」时判定
 * 「主实例还在运行」，次实例写完 focus 就 `app.exit(0)` —— 用户看到的是
 * 「双击图标没反应」。
 *
 * 这里用真实临时目录 + /proc 夹具（JSON/stat 文本）验证判定规则，
 * 不依赖真实 /proc、不启动 Electron，也不依赖执行顺序。
 */
const { assessLockOwner, claimVersionLock, collectStaleLockFiles, focusPathIn, inspectInstanceLocks, lockPathIn, locksDirIn, markLockReady, readLockPayload, sanitizeVersion } = loadTsCommonJs("src/main/instanceLockFile.ts");

/** 夹具里的系统启动时刻（秒）；所有 payload.at 都以它为基准，避免依赖真实时钟。 */
const BOOT_SECONDS = 1_700_000_000;
const USER_HZ = 100;

function ticksFor(secondsAfterBoot) {
	return secondsAfterBoot * USER_HZ;
}

function writeProcStat(procRoot, pid, { state = "S", startTicks }) {
	const entryDir = join(procRoot, String(pid));
	mkdirSync(entryDir, { recursive: true });
	// 字段 3..22；starttime 是第 22 字段（comm 之后下标 19）
	const afterComm = [state, ...Array(19).fill("0")];
	afterComm[19] = String(startTicks);
	writeFileSync(join(entryDir, "stat"), `${pid} (node) ${afterComm.join(" ")}\n`, "utf8");
}

function makeFixture(t) {
	const root = mkdtempSync(join(tmpdir(), "pideck-instance-lock-"));
	const procRoot = join(root, "proc");
	const locksDir = join(root, "userData", "instance-locks");
	mkdirSync(procRoot, { recursive: true });
	mkdirSync(locksDir, { recursive: true });
	writeFileSync(join(procRoot, "stat"), `cpu  0 0 0 0 0 0 0 0 0 0\nbtime ${BOOT_SECONDS}\n`, "utf8");
	writeProcStat(procRoot, 1, { startTicks: 1 });
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return { root, procRoot, locksDir };
}

function linuxOptions(procRoot, extra = {}) {
	return { procRoot, platform: "linux", ...extra };
}

function writeLockFile(lockPath, payload) {
	writeFileSync(lockPath, JSON.stringify(payload), "utf8");
}

test("proc 里已经没有该 pid 时判定为 dead（残留锁可抢占）", (t) => {
	const { procRoot } = makeFixture(t);
	const assessment = assessLockOwner({ pid: 424242, version: "0.7.5", at: BOOT_SECONDS * 1000 + 60_000 }, linuxOptions(procRoot));
	assert.equal(assessment.verdict, "dead");
});

test("僵尸进程即使 signal 0 能命中也算死锁", (t) => {
	const { procRoot } = makeFixture(t);
	writeProcStat(procRoot, 777, { state: "Z", startTicks: ticksFor(10) });
	const assessment = assessLockOwner({ pid: 777, version: "0.7.5", at: BOOT_SECONDS * 1000 + 30_000, procStartTicks: ticksFor(10) }, linuxOptions(procRoot, { isPidAlive: () => true }));
	assert.equal(assessment.verdict, "zombie");
});

test("startTicks 与锁里记录不一致时判定为 recycled（PID 复用）", (t) => {
	const { procRoot } = makeFixture(t);
	writeProcStat(procRoot, 888, { startTicks: ticksFor(9_999) });
	const assessment = assessLockOwner({ pid: 888, version: "0.7.5", at: BOOT_SECONDS * 1000 + 30_000, procStartTicks: ticksFor(10) }, linuxOptions(procRoot));
	assert.equal(assessment.verdict, "recycled");
});

test("旧版锁（无 procStartTicks）遇到启动更晚的同 PID 进程也判定为 recycled", (t) => {
	const { procRoot } = makeFixture(t);
	// 0.7.5 及以前写入的锁没有进程身份字段，只能靠「写锁时刻 vs 进程启动时刻」反推
	writeProcStat(procRoot, 3679, { startTicks: ticksFor(3_000) });
	const assessment = assessLockOwner({ pid: 3679, version: "0.7.5", at: BOOT_SECONDS * 1000 + 1_000 }, linuxOptions(procRoot));
	assert.equal(assessment.verdict, "recycled");
});

test("身份自洽的持有者判定为 live", (t) => {
	const { procRoot } = makeFixture(t);
	writeProcStat(procRoot, 555, { startTicks: ticksFor(5) });
	const assessment = assessLockOwner({ pid: 555, version: "0.7.5", at: BOOT_SECONDS * 1000 + 600_000, procStartTicks: ticksFor(5) }, linuxOptions(procRoot));
	assert.equal(assessment.verdict, "live");
});

test("首次抢锁写入 pid / version，且不预设 ready", (t) => {
	const { locksDir, procRoot } = makeFixture(t);
	const lockPath = lockPathIn(locksDir, "0.7.5");
	const outcome = claimVersionLock(lockPath, "0.7.5", linuxOptions(procRoot));
	assert.equal(outcome.status, "acquired");
	assert.equal(outcome.tookOver, false);
	const stored = readLockPayload(lockPath);
	assert.equal(stored.pid, process.pid);
	assert.equal(stored.version, "0.7.5");
	assert.equal(stored.ready, undefined);
});

test("升级残留锁（PID 被无关进程复用）当场抢占，而不是让本进程退出", (t) => {
	const { locksDir, procRoot } = makeFixture(t);
	const lockPath = lockPathIn(locksDir, "0.7.5");
	// 复现用户现场：0.7.5.lock 里 pid=3679，而该 PID 现在属于另一个更晚启动的进程
	writeProcStat(procRoot, 3679, { startTicks: ticksFor(3_000) });
	writeLockFile(lockPath, { pid: 3679, version: "0.7.5", at: BOOT_SECONDS * 1000 + 1_000 });
	const outcome = claimVersionLock(lockPath, "0.7.5", linuxOptions(procRoot));
	assert.equal(outcome.status, "acquired");
	assert.equal(outcome.tookOver, true);
	assert.match(outcome.reason, /stale owner/);
	assert.equal(readLockPayload(lockPath).pid, process.pid);
});

test("活着且身份自洽的持有者才返回 busy", (t) => {
	const { locksDir, procRoot } = makeFixture(t);
	const lockPath = lockPathIn(locksDir, "0.7.5");
	writeProcStat(procRoot, 666, { startTicks: ticksFor(4_000) });
	writeLockFile(lockPath, {
		pid: 666,
		version: "0.7.5",
		at: BOOT_SECONDS * 1000 + 4_500_000,
		procStartTicks: ticksFor(4_000),
		ready: true,
	});
	const outcome = claimVersionLock(lockPath, "0.7.5", linuxOptions(procRoot));
	assert.equal(outcome.status, "busy");
	assert.equal(outcome.assessment.verdict, "live");
	assert.equal(outcome.payload.pid, 666);
});

test("锁文件损坏时接管（旧行为会把用户挡在门外）", (t) => {
	const { locksDir, procRoot } = makeFixture(t);
	const lockPath = lockPathIn(locksDir, "0.7.5");
	writeFileSync(lockPath, "{ this is not json", "utf8");
	const outcome = claimVersionLock(lockPath, "0.7.5", linuxOptions(procRoot));
	assert.equal(outcome.status, "acquired");
	assert.equal(outcome.tookOver, true);
});

test("锁路径不可写（目录/权限）时返回 degraded，交由调用方降级启动", (t) => {
	const { locksDir, procRoot } = makeFixture(t);
	const lockPath = lockPathIn(locksDir, "0.7.5");
	mkdirSync(lockPath);
	const outcome = claimVersionLock(lockPath, "0.7.5", linuxOptions(procRoot));
	assert.equal(outcome.status, "degraded");
	assert.equal(typeof outcome.reason, "string");
});

test("markLockReady 只标记自己的锁", (t) => {
	const { locksDir, procRoot } = makeFixture(t);
	const lockPath = lockPathIn(locksDir, "0.7.5");
	claimVersionLock(lockPath, "0.7.5", linuxOptions(procRoot));
	assert.equal(markLockReady(lockPath, process.pid + 1), false);
	assert.equal(readLockPayload(lockPath).ready, undefined);
	assert.equal(markLockReady(lockPath, process.pid), true);
	assert.equal(readLockPayload(lockPath).ready, true);
	assert.equal(readLockPayload(lockPath).pid, process.pid);
});

test("collectStaleLockFiles 只回收死锁与过期孤儿文件", (t) => {
	const { locksDir, procRoot } = makeFixture(t);
	const deadLock = lockPathIn(locksDir, "0.7.5");
	const liveLock = lockPathIn(locksDir, "0.7.4");
	const corruptLock = lockPathIn(locksDir, "0.6.9");
	const oldCorruptLock = lockPathIn(locksDir, "0.6.8");
	const orphanFocus = focusPathIn(locksDir, "0.7.5");
	const past = new Date(Date.now() - 60 * 60 * 1000);

	writeLockFile(deadLock, { pid: 424242, version: "0.7.5", at: BOOT_SECONDS * 1000 });
	writeProcStat(procRoot, 666, { startTicks: ticksFor(4_000) });
	writeLockFile(liveLock, {
		pid: 666,
		version: "0.7.4",
		at: BOOT_SECONDS * 1000 + 4_500_000,
		procStartTicks: ticksFor(4_000),
	});
	writeFileSync(corruptLock, "half writ", "utf8");
	writeFileSync(oldCorruptLock, "half writ", "utf8");
	utimesSync(oldCorruptLock, past, past);
	writeFileSync(orphanFocus, JSON.stringify({ at: Date.now(), fromPid: 1 }), "utf8");
	utimesSync(orphanFocus, past, past);

	const removed = collectStaleLockFiles(locksDir, linuxOptions(procRoot));
	const removedNames = removed.map((item) => item.fileName).sort();

	// loadTsCommonJs 在独立 VM realm 执行，跨 realm 数组原型不同，统一用 JSON 比较
	assert.deepEqual(JSON.parse(JSON.stringify(removedNames)), ["0.6.8.lock", "0.7.5.focus", "0.7.5.lock"].sort());
	// 活着的其它版本实例（并行运行能力）不能被误删
	assert.equal(inspectInstanceLocks(locksDir, linuxOptions(procRoot)).locks.find((item) => item.fileName === "0.7.4.lock").stale, false);
	// 刚写坏的文件处于宽限期内，不删（可能是别的进程正在写）
	const corruptState = inspectInstanceLocks(locksDir, linuxOptions(procRoot))
		.locks.filter((item) => item.fileName === "0.6.9.lock")
		.map((item) => item.stale);
	assert.deepEqual(JSON.parse(JSON.stringify(corruptState)), [false]);
	assert.equal(existsSync(liveLock), true);
});

test("sanitizeVersion 不产生路径穿越字符", () => {
	assert.equal(sanitizeVersion("../evil"), ".._evil");
	assert.equal(sanitizeVersion("0.7.5-beta.1"), "0.7.5-beta.1");
	assert.equal(sanitizeVersion(""), "unknown");
});
