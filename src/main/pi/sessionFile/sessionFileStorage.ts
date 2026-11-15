/**
 * 会话文件落盘适配层：注入的 fs 端口、备份、原子替换（temp + rename 重试）。
 *
 * 这里是全会话编辑链路唯一直接写盘的地方，顺序与策略**不能**改动：
 * 备份先落盘并读回校验 → 临时文件 writeFile + sync + close → rename 前比对
 * 期望内容 → rename（EPERM/EBUSY 按 0/20/75/200ms 退避重试）→ 失败清理临时文件。
 * 任何改动都直接是用户会话数据的风险，因此搬迁时函数体一字未改。
 *
 * 依赖以窄切片传入（宿主 SessionFileEditor 实例天然满足），因此不需要把宿主的
 * 字段（fs / now / createUuid / sleep / maxBackups / logger）复制一份。
 */
import { open as openFile, readFile, realpath, readdir, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, posix, win32 } from "node:path";
import { SessionFileEditorError } from "./sessionFileEditorError";

type WritableFileHandle = Pick<FileHandle, "writeFile" | "sync" | "close">;

export type SessionFileEditorFs = {
	readFile(path: string): Promise<Buffer>;
	/** 体量护栏用的 stat；测试替身可省（缺省时跳过护栏，不影响行为） */
	stat(path: string): Promise<{ size: number }>;
	realpath(path: string): Promise<string>;
	open(path: string, flags: "wx"): Promise<WritableFileHandle>;
	readdir(path: string): Promise<string[]>;
	rename(from: string, to: string): Promise<void>;
	unlink(path: string): Promise<void>;
};

export type SessionFileEditorLogger = {
	warn(message: string, details?: Record<string, unknown>): void | Promise<void>;
};

/** 落盘层用到的宿主字段（结构同形，宿主直接传 `this`）。 */
export type SessionFileStorageDeps = {
	readonly fs: SessionFileEditorFs;
	readonly logger?: SessionFileEditorLogger | undefined;
	readonly now: () => number;
	readonly createUuid: () => string;
	readonly sleep: (milliseconds: number) => Promise<void>;
	readonly maxBackups: number;
};

export const defaultFs: SessionFileEditorFs = {
	stat,
	readFile: (path) => readFile(path),
	realpath,
	open: (path, flags) => openFile(path, flags),
	readdir,
	rename,
	unlink,
};

/** rename 重试判据：只吞 Windows 的占用类错误，其它立即上抛。 */
export function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : undefined;
}

/**
 * 文件锁的物理路径归一化：同一份文件经 host 路径 / WSL UNC 路径 / 大小写差异
 * 进来时必须归一成同一个 key，否则同一文件会被两个「锁」并行改写。
 */
export function normalizePhysicalPath(path: string): string {
	const slashed = path.replaceAll("\\", "/");
	const wslUnc = slashed.match(/^\/\/wsl(?:\.localhost|\$)\/([^/]+)(\/.*)?$/i);
	if (wslUnc) {
		return `wsl-unc\u0000${wslUnc[1].toLowerCase()}\u0000${posix.normalize(wslUnc[2] || "/")}`;
	}
	return `host\u0000${win32.normalize(path).replaceAll("\\", "/").toLowerCase()}`;
}

export async function createSessionBackup(deps: SessionFileStorageDeps, path: string, original: Buffer): Promise<string> {
	const directory = dirname(path);
	const filename = basename(path);
	const stamp = String(deps.now()).padStart(13, "0");
	const backupPath = join(directory, `${filename}.${stamp}-${deps.createUuid()}.edit-backup`);
	let handle: WritableFileHandle | undefined;
	try {
		handle = await deps.fs.open(backupPath, "wx");
		await handle.writeFile(original);
		await handle.sync();
		await handle.close();
		handle = undefined;
	} catch (cause) {
		await handle?.close().catch(() => undefined);
		await deps.fs.unlink(backupPath).catch(() => undefined);
		throw new SessionFileEditorError("SESSION_BACKUP_FAILED", "Session backup could not be created", { cause, backupPath });
	}

	await pruneSessionBackups(deps, directory, filename, basename(backupPath));
	try {
		const verified = await deps.fs.readFile(backupPath);
		if (!verified.equals(original)) throw new Error("Backup content mismatch");
	} catch (cause) {
		throw new SessionFileEditorError("SESSION_BACKUP_FAILED", "Session backup could not be verified", { cause, backupPath });
	}
	return backupPath;
}

export async function pruneSessionBackups(deps: SessionFileStorageDeps, directory: string, filename: string, protectedBackup: string): Promise<void> {
	try {
		const prefix = `${filename}.`;
		const suffix = ".edit-backup";
		const backups = (await deps.fs.readdir(directory)).filter((candidate) => candidate.startsWith(prefix) && candidate.endsWith(suffix)).sort();
		while (backups.length > deps.maxBackups) {
			const oldestIndex = backups.findIndex((candidate) => candidate !== protectedBackup);
			if (oldestIndex < 0) break;
			const [oldest] = backups.splice(oldestIndex, 1);
			if (oldest) await deps.fs.unlink(join(directory, oldest));
		}
	} catch (error) {
		void deps.logger?.warn("Session backup pruning failed", {
			directory,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export async function atomicReplaceFile(deps: SessionFileStorageDeps, path: string, next: Buffer, backupPath?: string, expected?: Buffer): Promise<void> {
	const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${deps.createUuid()}.tmp`);
	let handle: WritableFileHandle | undefined;
	let renamed = false;
	try {
		handle = await deps.fs.open(tempPath, "wx");
		await handle.writeFile(next);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await renameWithRetry(deps, tempPath, path, expected, backupPath);
		renamed = true;
	} catch (cause) {
		if (cause instanceof SessionFileEditorError) throw cause;
		throw new SessionFileEditorError("SESSION_ATOMIC_WRITE_FAILED", "Session file could not be replaced atomically", { cause, backupPath });
	} finally {
		await handle?.close().catch(() => undefined);
		if (!renamed) await deps.fs.unlink(tempPath).catch(() => undefined);
	}
}

async function renameWithRetry(deps: SessionFileStorageDeps, from: string, to: string, expected?: Buffer, backupPath?: string): Promise<void> {
	const delays = [0, 20, 75, 200];
	let lastError: unknown;
	for (const delay of delays) {
		if (delay) await deps.sleep(delay);
		try {
			if (expected) {
				const current = await deps.fs.readFile(to).catch((cause) => {
					throw new SessionFileEditorError("SESSION_FILE_CHANGED", "Session file could not be verified before committing", { cause, backupPath });
				});
				if (!current.equals(expected)) {
					throw new SessionFileEditorError("SESSION_FILE_CHANGED", "Session file changed while the replacement was being committed", { backupPath });
				}
			}
			await deps.fs.rename(from, to);
			return;
		} catch (error) {
			lastError = error;
			if (errorCode(error) !== "EPERM" && errorCode(error) !== "EBUSY") throw error;
		}
	}
	throw lastError;
}
