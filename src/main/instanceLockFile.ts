import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * 版本单实例锁的「锁文件 + 进程身份」机制。
 *
 * 为什么单独成模块：singleInstance.ts 负责“锁到手之后的窗口唤起/监听”这条生命周期，
 * 而“这个锁文件到底还算不算数”是一组可以脱离 Electron、脱离 fs.watch 单独验证的判定规则。
 * 把判定拆出来后可以对着临时目录直接单测（tests/instanceLockFile.test.mjs），
 * 不需要启动 Electron。
 *
 * 历史故障（Linux 用户反馈，0.7.5）：
 * 升级重启时崩溃/被 kill，`will-quit` 里的清理没跑，锁文件残留。旧实现只用
 * `process.kill(pid, 0)` 判断“主人是否还活着”，于是出现两种静默退出：
 *   1. PID 复用——残留锁里的 PID 被无关进程占用，判定“主实例还在运行”，
 *      次实例写完 focus 文件就 `app.exit(0)`，用户看到的是「双击图标没反应」；
 *   2. 僵尸进程（defunct）同样能通过 signal 0 检测，但根本不会响应 focus 请求。
 * 这里通过「进程身份校验 + 可抢占的陈旧锁」把这两种情况都收敛掉。
 */

/** 锁目录名（相对 userData）。三处磁盘根（锁、诊断、测试）统一从这里取，避免各拼一份路径。 */
export const LOCKS_DIR_NAME = "instance-locks";
export const LOCK_SUFFIX = ".lock";
export const FOCUS_SUFFIX = ".focus";

/** Linux /proc 默认挂载点；测试通过 options.procRoot 指向夹具目录。 */
const DEFAULT_PROC_ROOT = "/proc";
/** /proc/<pid>/stat 的 starttime 以 USER_HZ 为单位，Linux 上恒为 100（与 CONFIG_HZ 无关）。 */
const USER_HZ = 100;
/** 允许的时钟偏差：写锁时间与进程启动时间的比较留出这个余量，
 *  避免 NTP 微调/容器时钟误差把「同一个进程」误判成 PID 复用。 */
const CLOCK_SKEW_MS = 10_000;
/** 锁文件半截/损坏多久后可清理（避免删掉另一进程刚 open 还没写完的文件）。 */
export const CORRUPT_LOCK_GRACE_MS = 60_000;
/** 孤儿 focus 文件（主实例没来得及消费就退出了）多久后可清理。 */
export const ORPHAN_FOCUS_GRACE_MS = 5 * 60_000;

export type LockPayload = {
	pid: number;
	version: string;
	at: number;
	/** 锁持有进程的启动时刻（/proc/<pid>/stat 第 22 字段）。仅用于识别 PID 复用，
	 *  非 Linux 平台不写，读取时缺失也不会导致误杀。 */
	procStartTicks?: number;
	/** 主实例装好 focus 监听后才置 true。次实例据此选择等待时长：
	 *  ready=false 说明主实例还在启动，不能过早认定它「无响应」。 */
	ready?: boolean;
};

export type ProcIdentity = { state: string; startTicks: number | null };

export type LockOwnerVerdict =
	/** 进程存在且身份自洽：真主实例 */
	| "live"
	/** /proc 里没有这个 PID（或 signal 0 失败）：残留锁，可抢占 */
	| "dead"
	/** 僵尸/已退出态（Z/X）：不会响应 focus，按死锁处理 */
	| "zombie"
	/** PID 被复用：当前占着该 PID 的进程不是写锁的人 */
	| "recycled"
	/** 平台无法读取进程身份（Windows/macOS）但 signal 0 说进程存在：交由握手超时决定 */
	| "unverified";

export type LockOwnerAssessment = { verdict: LockOwnerVerdict; detail: string };

export type LockProbeOptions = {
	procRoot?: string;
	platform?: NodeJS.Platform;
	/** 覆盖存活探测（测试注入用；默认 process.kill(pid, 0)） */
	isPidAlive?: (pid: number) => boolean;
	now?: number;
};

export type ClaimOutcome =
	/** 拿到锁；tookOver=true 表示抢占了陈旧锁 */
	| { status: "acquired"; tookOver: boolean; reason: string }
	/** 有活着的持有者，本进程应作为次实例 */
	| { status: "busy"; payload: LockPayload | null; assessment: LockOwnerAssessment | null }
	/** 锁文件写不进去（权限/只读盘等）：不能当成「已有实例」而静默退出，调用方应降级继续启动 */
	| { status: "degraded"; reason: string };

/** 文件名安全：保留语义字符，避免路径穿越。 */
export function sanitizeVersion(version: string): string {
	return version.replace(/[^\w.-]+/g, "_") || "unknown";
}

export function locksDirIn(userDataDir: string): string {
	return join(userDataDir, LOCKS_DIR_NAME);
}

export function lockPathIn(locksDir: string, version: string): string {
	return join(locksDir, `${sanitizeVersion(version)}${LOCK_SUFFIX}`);
}

export function focusPathIn(locksDir: string, version: string): string {
	return join(locksDir, `${sanitizeVersion(version)}${FOCUS_SUFFIX}`);
}

function procRootOf(options?: LockProbeOptions): string {
	return options?.procRoot ?? DEFAULT_PROC_ROOT;
}

function isPidAliveDefault(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		// signal 0 只做权限与存在性探测；EPERM 会在 catch 里被当成「不存在」——
		// 对同名用户进程以外的 PID（例如 root 遗留进程）正是我们要的结论。
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * 读取 /proc/<pid>/stat 的身份字段。
 * 解析要点：第 2 字段 comm 可能含空格与括号，必须从**最后一个 ')'** 之后开始切分，
 * 否则进程名里带括号时字段会整体错位（starttime 会读到别的字段）。
 */
export function readProcIdentity(pid: number, options?: LockProbeOptions): ProcIdentity | null {
	if (!Number.isInteger(pid) || pid <= 0) return null;
	let raw: string;
	try {
		raw = readFileSync(join(procRootOf(options), String(pid), "stat"), "utf8");
	} catch {
		// ENOENT：进程不存在；ENOTDIR/EACCES：/proc 不可用，都按「读不到身份」处理
		return null;
	}
	const close = raw.lastIndexOf(")");
	if (close < 0) return null;
	const fields = raw
		.slice(close + 1)
		.trim()
		.split(/\s+/);
	const state = fields[0];
	if (!state) return null;
	// starttime 是第 22 字段；comm 之后的 tokens 从第 3 字段开始，故下标为 22 - 3
	const startRaw = fields[19];
	const startTicks = startRaw !== undefined && /^\d+$/.test(startRaw) ? Number(startRaw) : null;
	return { state, startTicks };
}

/** 读取系统启动时刻（/proc/stat 的 btime，单位秒）；用于把 starttime 换算成墙钟时间。 */
export function readBootTimeSeconds(options?: LockProbeOptions): number | null {
	let raw: string;
	try {
		raw = readFileSync(join(procRootOf(options), "stat"), "utf8");
	} catch {
		return null;
	}
	for (const line of raw.split("\n")) {
		if (!line.startsWith("btime ")) continue;
		const value = Number(line.slice("btime ".length).trim());
		return Number.isFinite(value) && value > 0 ? value : null;
	}
	return null;
}

/** 进程启动的墙钟时间（ms）。缺 btime 或 starttime 时返回 null（此时只能退化为存活探测）。 */
export function procStartWallClockMs(pid: number, options?: LockProbeOptions): number | null {
	const identity = readProcIdentity(pid, options);
	const bootSeconds = readBootTimeSeconds(options);
	if (!identity || identity.startTicks === null || bootSeconds === null) return null;
	return (bootSeconds + identity.startTicks / USER_HZ) * 1000;
}

/**
 * 判定锁持有者是否还算数。
 *
 * 判定顺序（Linux）：
 *  1. /proc 里没有该 PID → dead；
 *  2. 状态为 Z/X（僵尸/已退出）→ zombie。僵尸能被 signal 0 命中但永远不会响应 focus，
 *     历史上正因此让用户「点了没反应」；
 *  3. 锁里记了 procStartTicks 且与当前同 PID 进程不一致 → recycled（PID 复用）；
 *  4. 没记 procStartTicks 的旧版本锁（0.7.5 及以前）：用「进程启动时间晚于写锁时间」反推
 *     ——写锁的进程必定早于写锁时刻启动，所以启动更晚的进程绝不可能是写锁人 → recycled。
 *     这一条让历史遗留锁（正是用户反馈里的 0.7.4/0.7.5 残留锁）也能被安全回收；
 *  5. 其余情况按 live。
 *
 * 非 Linux（无 /proc）：只能 signal 0，返回 live/unverified 由上层用握手超时兜底。
 */
export function assessLockOwner(payload: LockPayload, options?: LockProbeOptions): LockOwnerAssessment {
	const platform = options?.platform ?? process.platform;
	if (platform !== "linux") {
		const alive = (options?.isPidAlive ?? isPidAliveDefault)(payload.pid);
		return alive ? { verdict: "unverified", detail: `pid ${payload.pid} alive (no /proc identity)` } : { verdict: "dead", detail: `pid ${payload.pid} not alive` };
	}

	const identity = readProcIdentity(payload.pid, options);
	if (!identity) {
		return { verdict: "dead", detail: `pid ${payload.pid} missing in /proc` };
	}
	if (identity.state === "Z" || identity.state === "X") {
		return { verdict: "zombie", detail: `pid ${payload.pid} state ${identity.state}` };
	}
	if (payload.procStartTicks !== undefined && identity.startTicks !== null && payload.procStartTicks !== identity.startTicks) {
		return {
			verdict: "recycled",
			detail: `pid ${payload.pid} start ticks ${identity.startTicks} != lock ${payload.procStartTicks}`,
		};
	}
	const startMs = procStartWallClockMs(payload.pid, options);
	if (startMs !== null && startMs > payload.at + CLOCK_SKEW_MS) {
		return {
			verdict: "recycled",
			detail: `pid ${payload.pid} started ${Math.round((startMs - payload.at) / 1000)}s after lock write`,
		};
	}
	return { verdict: "live", detail: `pid ${payload.pid} alive` };
}

function isStaleVerdict(verdict: LockOwnerVerdict): boolean {
	return verdict === "dead" || verdict === "zombie" || verdict === "recycled";
}

export function readLockPayload(lockPath: string): LockPayload | null {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(lockPath, "utf8"));
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const record = raw as Record<string, unknown>;
	const pid = record.pid;
	if (typeof pid !== "number" || !Number.isFinite(pid)) return null;
	const at = record.at;
	const ticks = record.procStartTicks;
	return {
		pid,
		version: typeof record.version === "string" ? record.version : "",
		at: typeof at === "number" && Number.isFinite(at) ? at : 0,
		...(typeof ticks === "number" && Number.isFinite(ticks) ? { procStartTicks: ticks } : {}),
		...(record.ready === true ? { ready: true } : {}),
	};
}

/** 独占创建锁文件；EEXIST 与「写不进去」必须区分对待，前者是正常竞态，后者是环境故障。 */
function writeLockExclusive(lockPath: string, payload: LockPayload): { ok: true } | { ok: false; code: string } {
	try {
		// wx：文件已存在则失败，避免双主实例竞态
		const fd = openSync(lockPath, "wx");
		try {
			writeFileSync(fd, JSON.stringify(payload), "utf8");
		} finally {
			closeSync(fd);
		}
		return { ok: true };
	} catch (error) {
		const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "UNKNOWN";
		return { ok: false, code };
	}
}

function buildPayload(version: string, options?: LockProbeOptions, ready = false): LockPayload {
	const identity = readProcIdentity(process.pid, options);
	const startTicks = identity?.startTicks;
	const payload: LockPayload = {
		pid: process.pid,
		version,
		at: options?.now ?? Date.now(),
		...(typeof startTicks === "number" ? { procStartTicks: startTicks } : {}),
	};
	// ready=false 显式省略，保持锁文件干净；次实例按「未 ready」处理。
	if (ready) payload.ready = true;
	return payload;
}

/**
 * 抢锁。只有「确认持有者还活着」才返回 busy。
 *
 * 返回 degraded 的场景：锁文件不可写（权限、只读盘、同名目录等）。
 * 旧实现把这些情况也当成「已有实例在运行」，配合次实例的 `app.exit(0)`
 * 就变成用户完全看不到反馈的启动失败——这里改为让调用方降级继续启动。
 */
export function claimVersionLock(lockPath: string, version: string, options?: LockProbeOptions): ClaimOutcome {
	const payload = buildPayload(version, options);
	const first = writeLockExclusive(lockPath, payload);
	if (first.ok) return { status: "acquired", tookOver: false, reason: "fresh lock" };
	if (first.code !== "EEXIST") {
		return { status: "degraded", reason: `lock write failed: ${first.code}` };
	}

	const existing = readLockPayload(lockPath);
	if (!existing) {
		// 读不出来：半截文件或非本格式内容，直接接管
		return takeOverVersionLock(lockPath, version, "unreadable lock file", options);
	}
	if (existing.pid === process.pid) {
		// 同一个 PID 一般是上次运行留下的锁（例如热重载/上一次 dispose 未跑完），直接改写所有权
		return takeOverVersionLock(lockPath, version, "lock held by current pid", options);
	}
	// 只有「可证明持有者还活着」才算 busy；残留锁（死进程/僵尸/PID 复用）当场抢占，
	// 不依赖上层握手超时——那会让 Linux 用户多等好几秒才看到窗口。
	const assessment = assessLockOwner(existing, options);
	if (isStaleVerdict(assessment.verdict)) {
		return takeOverVersionLock(lockPath, version, `stale owner: ${assessment.detail}`, options);
	}
	return { status: "busy", payload: existing, assessment };
}

/** 强制接管：删掉现有锁文件后重新独占创建（陈旧锁回收与「无响应主实例」抢占共用）。
 *
 * 用有界重试代替递归：锁路径可能是个目录、或被别的进程反复重建，
 * 无界递归会把「启动卡死」换成「启动栈溢出」。 */
export function takeOverVersionLock(lockPath: string, version: string, reason: string, options?: LockProbeOptions): ClaimOutcome {
	let detail = reason;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			unlinkSync(lockPath);
		} catch {
			// 并发删除/文件不存在都无妨；删不掉（如路径是目录）时下面的 wx 会继续失败
		}
		const payload = buildPayload(version, options);
		const write = writeLockExclusive(lockPath, payload);
		if (write.ok) return { status: "acquired", tookOver: true, reason: detail };
		if (write.code !== "EEXIST") {
			return { status: "degraded", reason: `lock write failed: ${write.code}` };
		}
		// EEXIST：抢的过程中被别的进程重建了锁
		const raced = readLockPayload(lockPath);
		if (!raced) continue;
		const assessment = assessLockOwner(raced, options);
		if (assessment.verdict === "live") {
			return { status: "busy", payload: raced, assessment };
		}
		detail = `${reason}; reclaim ${assessment.verdict}`;
	}
	return { status: "degraded", reason: `lock reclaim failed: ${detail}` };
}

/**
 * 主实例装好 focus 监听后把自己的锁标记为 ready（原子替换）。
 * 返回 false 表示锁已被别人接管（本进程沦为重复实例），调用方只需记日志。
 */
export function markLockReady(lockPath: string, pid: number): boolean {
	const current = readLockPayload(lockPath);
	if (!current || current.pid !== pid) return false;
	const next: LockPayload = { ...current, ready: true };
	const tmpPath = `${lockPath}.tmp-${pid}`;
	try {
		writeFileSync(tmpPath, JSON.stringify(next), "utf8");
		// rename 覆盖：POSIX 原子，Windows 走 MoveFileEx(REPLACE_EXISTING)
		renameSync(tmpPath, lockPath);
		return true;
	} catch {
		try {
			if (existsSync(tmpPath)) unlinkSync(tmpPath);
		} catch {
			// 残留 tmp 由 collectStaleLockFiles 的宽限期清理
		}
		return false;
	}
}

export type LockFileInspection = {
	fileName: string;
	lockPath: string;
	version: string;
	payload: LockPayload | null;
	assessment: LockOwnerAssessment | null;
	/** true = 可安全回收（死进程/僵尸/PID 复用/损坏且超过宽限期） */
	stale: boolean;
	detail: string;
	ageMs: number;
};

function fileAgeMs(path: string, now: number): number {
	try {
		return Math.max(0, now - statSync(path).mtimeMs);
	} catch {
		return 0;
	}
}

/**
 * 扫描锁目录，给出每个锁文件的持有者判定。
 * 体检报告与启动时的陈旧锁回收共用同一份判定，避免两处规则漂移。
 */
export function inspectInstanceLocks(locksDir: string, options?: LockProbeOptions): { locks: LockFileInspection[]; orphanFocusFiles: string[] } {
	const now = options?.now ?? Date.now();
	let entries: string[] = [];
	try {
		entries = readdirSync(locksDir);
	} catch {
		return { locks: [], orphanFocusFiles: [] };
	}

	const locks: LockFileInspection[] = [];
	const orphanFocusFiles: string[] = [];
	for (const fileName of entries) {
		const fullPath = join(locksDir, fileName);
		if (fileName.endsWith(FOCUS_SUFFIX)) {
			// focus 文件是「一次性请求」，超过宽限期还没被消费说明主实例那次启动没接住
			if (fileAgeMs(fullPath, now) > ORPHAN_FOCUS_GRACE_MS) orphanFocusFiles.push(fileName);
			continue;
		}
		if (fileName.endsWith(".tmp-") || /\.tmp-\d+$/.test(fileName)) {
			if (fileAgeMs(fullPath, now) > CORRUPT_LOCK_GRACE_MS) orphanFocusFiles.push(fileName);
			continue;
		}
		if (!fileName.endsWith(LOCK_SUFFIX)) continue;

		const payload = readLockPayload(fullPath);
		const ageMs = fileAgeMs(fullPath, now);
		if (!payload) {
			const expired = ageMs > CORRUPT_LOCK_GRACE_MS;
			locks.push({
				fileName,
				lockPath: fullPath,
				version: basename(fileName, LOCK_SUFFIX),
				payload: null,
				assessment: null,
				stale: expired,
				detail: expired ? "corrupt lock file" : "corrupt lock file (recent)",
				ageMs,
			});
			continue;
		}
		const assessment = assessLockOwner(payload, options);
		locks.push({
			fileName,
			lockPath: fullPath,
			version: payload.version || basename(fileName, LOCK_SUFFIX),
			payload,
			assessment,
			stale: isStaleVerdict(assessment.verdict),
			detail: assessment.detail,
			ageMs,
		});
	}
	return { locks, orphanFocusFiles };
}

/**
 * 启动时回收陈旧锁：崩溃/被 kill 留下的锁文件不会再阻塞下一次启动。
 * 只删「可证明主人已死」的锁（见 assessLockOwner），活着的其它版本实例不受影响
 * ——不同版本并行是产品的既有能力。
 */
export function collectStaleLockFiles(locksDir: string, options?: LockProbeOptions): Array<{ fileName: string; reason: string }> {
	const { locks, orphanFocusFiles } = inspectInstanceLocks(locksDir, options);
	const removed: Array<{ fileName: string; reason: string }> = [];
	for (const lock of locks) {
		if (!lock.stale) continue;
		try {
			unlinkSync(lock.lockPath);
			removed.push({ fileName: lock.fileName, reason: lock.detail });
		} catch {
			// 删除失败不阻断启动；下次启动再试
		}
	}
	for (const fileName of orphanFocusFiles) {
		try {
			unlinkSync(join(locksDir, fileName));
			removed.push({ fileName, reason: "orphan focus/tmp file" });
		} catch {
			// ignore
		}
	}
	return removed;
}

/** 确保锁目录存在（写锁前调用；失败不抛出，交由写锁的 degraded 分支处理）。 */
export function ensureLocksDir(locksDir: string): boolean {
	try {
		mkdirSync(locksDir, { recursive: true });
		return true;
	} catch {
		return false;
	}
}

/**
 * 同步睡眠：次实例在「等主实例确认 focus」时尚未 ready，
 * 用异步定时器会让退出路径变成异步状态机，反而更难保证「不静默退出」。
 */
export function sleepSync(ms: number): void {
	if (ms <= 0) return;
	try {
		// Node 主线程允许 Atomics.wait（限制只存在于浏览器渲染主线程）
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {
		const end = Date.now() + Math.min(ms, 1_000);
		// 兜底自旋有上限，避免极端环境下把 8s 全花在烧 CPU 上
		while (Date.now() < end) {
			/* spin */
		}
	}
}
