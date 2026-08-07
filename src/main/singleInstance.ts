import { app } from "electron";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	watch,
	writeFileSync,
	type FSWatcher,
} from "node:fs";
import { basename, join } from "node:path";

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
 * 次实例写入 .focus 文件，主实例 fs.watch 后前置窗口。
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

type LockPayload = {
	pid: number;
	version: string;
	at: number;
};

function sanitizeVersion(version: string): string {
	// 文件名安全：保留语义字符，避免路径穿越
	return version.replace(/[^\w.-]+/g, "_") || "unknown";
}

function locksDir(): string {
	return join(app.getPath("userData"), "instance-locks");
}

function lockPathFor(version: string): string {
	return join(locksDir(), `${sanitizeVersion(version)}.lock`);
}

function focusPathFor(version: string): string {
	return join(locksDir(), `${sanitizeVersion(version)}.focus`);
}

/** 检测 pid 是否仍存活（Windows/Unix 均可用 signal 0） */
function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function readLock(lockPath: string): LockPayload | null {
	try {
		const raw = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockPayload>;
		if (typeof raw.pid !== "number") return null;
		return {
			pid: raw.pid,
			version: typeof raw.version === "string" ? raw.version : "",
			at: typeof raw.at === "number" ? raw.at : 0,
		};
	} catch {
		return null;
	}
}

function writeLockAtomic(lockPath: string, payload: LockPayload): boolean {
	// wx：文件已存在则失败，避免双主实例竞态
	try {
		const fd = openSync(lockPath, "wx");
		try {
			writeFileSync(fd, JSON.stringify(payload), "utf8");
		} finally {
			closeSync(fd);
		}
		return true;
	} catch {
		return false;
	}
}

function tryClaimLock(lockPath: string, version: string): boolean {
	const payload: LockPayload = {
		pid: process.pid,
		version,
		at: Date.now(),
	};
	if (writeLockAtomic(lockPath, payload)) return true;

	const existing = readLock(lockPath);
	// 锁文件损坏或持有者已死：抢占
	if (!existing || !isPidAlive(existing.pid) || existing.pid === process.pid) {
		try {
			unlinkSync(lockPath);
		} catch {
			// 并发删除忽略
		}
		return writeLockAtomic(lockPath, payload);
	}
	return false;
}

/**
 * 尝试成为当前版本的主实例。
 * @param enabled 设置项 singleInstance；false 时允许多开（不写锁）
 * @param version app.getVersion()
 * @param onFocusRequest 同版本次实例请求前置窗口时回调（携带次实例的 argv，可解析通知激活参数）
 */
export function acquireVersionSingleInstance(
	enabled: boolean,
	version: string,
	onFocusRequest: (payload: FocusPayload) => void,
): VersionSingleInstanceResult {
	if (!enabled) {
		return { isPrimary: true, dispose: () => undefined };
	}

	mkdirSync(locksDir(), { recursive: true });
	const lockPath = lockPathFor(version);
	const focusPath = focusPathFor(version);
	const focusName = basename(focusPath);

	if (!tryClaimLock(lockPath, version)) {
		// 次实例：通知主实例聚焦后自行退出。
		// 附带完整 argv：通知激活启动的实例 argv 里有 toast launch 参数，
		// 主实例据此识别要跳转的 agent（Electron 自身无法完成该转发，因为次实例随即退出）。
		try {
			writeFileSync(
				focusPath,
				JSON.stringify({
					at: Date.now(),
					fromPid: process.pid,
					argv: process.argv.slice(1),
				}),
				"utf8",
			);
		} catch {
			// 主实例仍在但 focus 写失败时，次实例照常退出，避免双开
		}
		return { isPrimary: false, dispose: () => undefined };
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
			// 读完即删，避免重复触发
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
	try {
		watcher = watch(locksDir(), (_event, filename) => {
			// filename 在部分平台可能为 Buffer/null
			const name = filename == null ? "" : String(filename);
			if (!name || name === focusName || name.endsWith(".focus")) {
				handleFocusSignal();
			}
		});
	} catch {
		// watch 失败时退化为无热唤起（锁仍有效，仅无法 second-instance 聚焦）
	}

	// 启动时若残留 focus 文件，清一次
	handleFocusSignal();

	const dispose = () => {
		try {
			watcher?.close();
		} catch {
			// ignore
		}
		watcher = null;
		try {
			const current = readLock(lockPath);
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
