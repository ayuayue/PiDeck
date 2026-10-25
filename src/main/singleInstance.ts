import { app } from "electron";
import { existsSync, readFileSync, unlinkSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename } from "node:path";
import { getAppLogger } from "./logging/sharedLogger";
import { claimVersionLock, collectStaleLockFiles, ensureLocksDir, focusPathIn, lockPathIn, locksDirIn, markLockReady, readLockPayload, sleepSync, takeOverVersionLock, type ClaimOutcome } from "./instanceLockFile";

/**
 * 按「应用版本」隔离的单实例锁。
 *
 * 业务规则：
 * - 同一版本只允许一个主实例（再次启动时唤起已有窗口）
 * - 不同版本可并行运行（0.6.7 与 0.6.8 可同时开）
 * - 与 Electron 内置 requestSingleInstanceLock 不同：后者按 userData 全局一把锁，
 *   会导致所有版本互斥，开发态也会被正式版抢走。
 *
 * 实现：userData/instance-locks/<version>.lock 记录主实例 pid；
 * 次实例写入 .focus 文件并**等待主实例确认**，主实例 fs.watch 后前置窗口。
 *
 * 「等待确认」是 0.7.5 Linux 反馈的直接修复：旧实现只要锁文件里 PID 存活就
 * 直接 `app.exit(0)`，遇到残留锁（升级时被 kill）或僵尸主实例时用户看到的是
 * 「双击图标没反应」——没有窗口、没有报错、没有日志。
 * 现在次实例只有在主实例消费掉 focus 文件后才退出；超时则抢占锁继续启动。
 */

export type VersionSingleInstanceResult = {
	/** true = 本进程应继续启动；false = 应立即退出 */
	isPrimary: boolean;
	/** 释放锁与 watcher（主实例退出时调用） */
	dispose: () => void;
};

/**
 * 次实例通过 .focus 文件传给主实例的信息。
 * argv：次实例的完整命令行参数，用于识别「点击系统通知」激活场景
 * （通知 toast 的 launch 参数会附加到被唤起实例的 argv 中）。
 */
export type FocusPayload = {
	at: number;
	fromPid: number;
	argv?: string[];
};

/** 主实例已 ready 时的确认等待上限：正常唤起是毫秒级，1.5s 足够，超时说明它不响应。 */
const FOCUS_ACK_READY_MS = 1_500;
/** 主实例尚未 ready（仍在启动）时的等待上限：不能因为它还在初始化就抢锁。 */
const FOCUS_ACK_BOOT_MS = 8_000;
/** 等待确认时的轮询间隔。用轮询而非定时器：次实例马上就要退出，不值得引入异步状态机。 */
const FOCUS_ACK_POLL_MS = 60;
/** fs.watch 不可用（如 inotify 句柄耗尽）时的兜底轮询间隔：宁可慢一点，也不能丢了唤起。 */
const FOCUS_FALLBACK_POLL_MS = 1_000;

type FocusHandshake = "acked" | "released" | "timeout";

/**
 * 次实例请求主实例前置窗口，并等待它「确实收到」的证据。
 *
 * 三种结论：
 * - acked：主实例删掉了 focus 文件，说明请求已被消费 → 可以安全退出；
 * - released：锁文件没了，主实例正在退出 → 本实例回去抢锁；
 * - timeout：主实例没响应（无响应/身份无法判定/写不进 focus）→ 由调用方抢占。
 */
function requestFocusFromPrimary(lockPath: string, focusPath: string, version: string): FocusHandshake {
	const startedAt = Date.now();
	try {
		// 附带完整 argv：通知激活启动的实例 argv 里有 toast launch 参数，
		// 主实例据此识别要跳转的 agent（Electron 自身无法完成该转发，因为次实例随即退出）。
		writeFileSync(
			focusPath,
			JSON.stringify({
				at: startedAt,
				fromPid: process.pid,
				argv: process.argv.slice(1),
			}),
			"utf8",
		);
	} catch (error) {
		// 写不进去就没有「主实例已收到」的证据；此时静默退出正是历史故障的形态
		void getAppLogger()?.warn("single-instance", "Focus request write failed", {
			version,
			fromPid: process.pid,
			error: error instanceof Error ? error.message : String(error),
		});
		return "timeout";
	}

	// 未 ready 说明主实例还在启动（它会先消费积压的 focus 文件再置 ready），
	// 给足冷启动预算，避免两个进程同时启动时互相抢锁。
	const owner = readLockPayload(lockPath);
	const budgetMs = owner?.ready === true ? FOCUS_ACK_READY_MS : FOCUS_ACK_BOOT_MS;
	while (Date.now() - startedAt < budgetMs) {
		if (!existsSync(focusPath)) return "acked";
		if (!existsSync(lockPath)) return "released";
		sleepSync(FOCUS_ACK_POLL_MS);
	}
	return "timeout";
}

function noopDispose(): void {
	// 次实例/未启用单实例时不持有任何资源
}

/**
 * 尝试成为当前版本的主实例。
 * @param enabled 设置项 singleInstance；false 时允许多开（不写锁）
 * @param version app.getVersion()
 * @param onFocusRequest 同版本次实例请求前置窗口时回调（携带次实例的 argv，可解析通知激活参数）
 */
export function acquireVersionSingleInstance(enabled: boolean, version: string, onFocusRequest: (payload: FocusPayload) => void): VersionSingleInstanceResult {
	if (!enabled) {
		return { isPrimary: true, dispose: noopDispose };
	}

	const locksDir = locksDirIn(app.getPath("userData"));
	ensureLocksDir(locksDir);

	// 先回收「主人已死」的锁：升级被 kill / 崩溃留下的锁文件不该阻塞下一次启动
	const reclaimed = collectStaleLockFiles(locksDir);
	if (reclaimed.length > 0) {
		void getAppLogger()?.info("single-instance", "Stale instance locks reclaimed", {
			version,
			files: reclaimed.map((item) => item.fileName).join(","),
			reasons: reclaimed.map((item) => `${item.fileName}: ${item.reason}`).join("; "),
		});
	}

	const lockPath = lockPathIn(locksDir, version);
	const focusPath = focusPathIn(locksDir, version);
	const focusName = basename(focusPath);
	const exitAsSecondary = (reason: string): VersionSingleInstanceResult => {
		void getAppLogger()?.info("single-instance", "Secondary instance exiting; focus requested", {
			version,
			fromPid: process.pid,
			reason,
		});
		return { isPrimary: false, dispose: noopDispose };
	};

	let claim: ClaimOutcome = claimVersionLock(lockPath, version);
	if (claim.status === "busy") {
		// 锁里有活着的持有者，但「活着」不等于「会响应」：残留锁的 PID 复用、
		// 僵尸主实例、无响应的主实例都会通过存活探测。所以先握手，再决定去留。
		const verdict = claim.assessment?.verdict ?? "unknown";
		const handshake = requestFocusFromPrimary(lockPath, focusPath, version);
		if (handshake === "acked") {
			return exitAsSecondary(`focus acked by pid ${claim.payload?.pid ?? 0}`);
		}
		if (handshake === "released") {
			// 主实例正在退出，锁已经让位：重新抢一次即可
			claim = claimVersionLock(lockPath, version);
		} else {
			void getAppLogger()?.warn("single-instance", "Focus request unacknowledged; taking over lock", {
				version,
				ownerPid: claim.payload?.pid ?? 0,
				ownerVerdict: verdict,
			});
			claim = takeOverVersionLock(lockPath, version, `focus unacknowledged (${verdict})`);
			// 自己写下的 focus 请求不会再有主实例来消费，必须先删掉：
			// 否则下面 handleFocusSignal 会把自己写的 argv 当成「次实例的跳转请求」重复执行一次
			try {
				if (existsSync(focusPath)) unlinkSync(focusPath);
			} catch {
				// ignore
			}
		}
		if (claim.status === "busy") {
			// 极窄竞态：抢的过程中又被别的进程拿到锁，仍按次实例退出（同版本只能一个主实例）
			return exitAsSecondary(`lock re-claimed by pid ${claim.payload?.pid ?? 0}`);
		}
	}

	if (claim.status === "degraded") {
		// 锁文件写不进去（权限、只读盘、同名目录等）：不能当成「已有实例在运行」而退出，
		// 否则用户看到的就是「点了没反应」。降级为无锁启动，只记一条 warn 供诊断。
		void getAppLogger()?.warn("single-instance", "Instance lock unavailable; continuing without lock", {
			version,
			pid: process.pid,
			reason: claim.reason,
		});
	} else if (claim.tookOver) {
		void getAppLogger()?.warn("single-instance", "Stale instance lock taken over", {
			version,
			pid: process.pid,
			reason: claim.reason,
		});
	} else {
		void getAppLogger()?.info("single-instance", "Primary instance lock acquired", {
			version,
			pid: process.pid,
		});
	}

	const handleFocusSignal = () => {
		try {
			if (!existsSync(focusPath)) return;
			let payload: FocusPayload = { at: Date.now(), fromPid: 0 };
			try {
				payload = JSON.parse(readFileSync(focusPath, "utf8")) as FocusPayload;
			} catch {
				// 旧格式或损坏时退化为空 payload
			}
			void getAppLogger()?.info("single-instance", "Focus request received from secondary instance", {
				fromPid: payload.fromPid,
			});
			// 读完即删，避免重复触发；次实例把「文件消失」当作确认信号
			try {
				unlinkSync(focusPath);
			} catch {
				// ignore
			}
			onFocusRequest(payload);
		} catch {
			// ignore
		}
	};

	let watcher: FSWatcher | null = null;
	let fallbackTimer: ReturnType<typeof setInterval> | null = null;
	try {
		watcher = watch(locksDir, (_event, filename) => {
			// filename 在部分平台可能为 Buffer/null
			const name = filename == null ? "" : String(filename);
			if (!name || name === focusName || name.endsWith(".focus")) {
				handleFocusSignal();
			}
		});
	} catch (error) {
		// fs.watch 失败常见于 Linux inotify 句柄耗尽：退化为定时轮询，
		// 否则次实例的 focus 永远没人处理，表现为「点了没反应」。
		void getAppLogger()?.warn("single-instance", "Focus watcher unavailable; polling focus requests", {
			version,
			error: error instanceof Error ? error.message : String(error),
		});
		fallbackTimer = setInterval(handleFocusSignal, FOCUS_FALLBACK_POLL_MS);
		fallbackTimer.unref?.();
	}

	// 启动时若残留 focus 文件，清一次（同时也算对上次启动积压请求的确认）
	handleFocusSignal();

	// 监听就绪后才声明 ready：次实例据此区分「在启动」与「不响应」。
	// 只有真的持有锁时才写：降级启动（锁目录不可写）没有锁文件可改，不必报 warn。
	if (claim.status === "acquired" && !markLockReady(lockPath, process.pid)) {
		void getAppLogger()?.warn("single-instance", "Instance lock ownership changed before ready", {
			version,
			pid: process.pid,
		});
	}

	const dispose = () => {
		try {
			watcher?.close();
		} catch {
			// ignore
		}
		watcher = null;
		if (fallbackTimer) {
			clearInterval(fallbackTimer);
			fallbackTimer = null;
		}
		try {
			const current = readLockPayload(lockPath);
			if (current?.pid === process.pid && existsSync(lockPath)) {
				unlinkSync(lockPath);
			}
		} catch {
			// ignore
		}
		try {
			if (existsSync(focusPath)) unlinkSync(focusPath);
		} catch {
			// ignore
		}
	};

	// 正常退出时释放，避免下次启动被当成「仍在运行」
	app.once("will-quit", dispose);

	return { isPrimary: true, dispose };
}
