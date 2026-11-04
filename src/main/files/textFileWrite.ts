import { randomUUID } from "node:crypto";
import { lstat, open, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { assertTrustedStatSize, looksNonText, normalizeFileAccessError } from "./textFileRead";

const pendingWrites = new Map<string, Promise<void>>();
const INSPECT_BUFFER_BYTES = 256 * 1024;

/** 保留跟随链接写入目标的语义；同一目标顺序替换，失败不回退截断写。 */
export async function writeTextFileGuarded(path: string, content: string): Promise<void> {
	try {
		const key = writeQueueKey(resolve(path));
		await enqueueWrite(key, async () => {
			const target = await resolveWriteTarget(path);
			const replace = async () => replaceFileAtomically(target, content, await inspectExisting(target));
			// 先登记原路径以保调用顺序，再按真实目标合并别名，避免链接和目标各写各的。
			if (writeQueueKey(target) === key) await replace();
			else await enqueueWrite(writeQueueKey(target), replace);
		});
	} catch (error) {
		throw normalizeFileAccessError(error);
	}
}

function writeQueueKey(path: string): string {
	return process.platform === "win32" ? path.toLowerCase() : path;
}

/** 失败只影响本次调用，不阻塞后续保存；尾请求结束后释放队列。 */
async function enqueueWrite(key: string, write: () => Promise<void>): Promise<void> {
	const pending = (pendingWrites.get(key) ?? Promise.resolve()).catch(() => undefined).then(write);
	pendingWrites.set(key, pending);
	try {
		await pending;
	} finally {
		if (pendingWrites.get(key) === pending) pendingWrites.delete(key);
	}
}

/** rename 必须指向真实文件而不是 symlink 目录项；死链不能当作新文件替换。 */
async function resolveWriteTarget(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		if (!isMissingPath(error)) throw error;
		const entry = await lstat(path).catch((entryError: unknown) => {
			if (!isMissingPath(entryError)) throw entryError;
			return undefined;
		});
		if (entry) throw error;
		return join(await realpath(dirname(path)), basename(path));
	}
}

function isMissingPath(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** 分块校验整份现有文件，避免只验文件头而漏掉后续非法字节，也不整读大文件。 */
async function inspectExisting(path: string): Promise<number | undefined> {
	const fileStat = await stat(path).catch((error: unknown) => {
		if (isMissingPath(error)) return undefined;
		throw error;
	});
	if (!fileStat) return undefined;
	assertTrustedStatSize(fileStat.size);
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(Math.min(Math.max(fileStat.size, 1), INSPECT_BUFFER_BYTES));
		const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
		while (true) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
			let text: string;
			try {
				// stream 保留跨块 UTF-8 字符；EOF 必须 flush，以拒绝截断的多字节序列。
				text = decoder.decode(buffer.subarray(0, bytesRead), { stream: bytesRead > 0 });
			} catch {
				throw new Error(`FILE_WRITE_BLOCKED_ENCRYPTED:${fileStat.size}`);
			}
			if (looksNonText(text)) throw new Error(`FILE_WRITE_BLOCKED_ENCRYPTED:${fileStat.size}`);
			if (bytesRead === 0) break;
		}
		return fileStat.mode & 0o777;
	} finally {
		await handle.close();
	}
}

/** 临时文件独占创建在原目录；不在 userData 等受管目录外保存明文备份。 */
async function replaceFileAtomically(path: string, content: string, mode: number | undefined): Promise<void> {
	const tempPath = join(dirname(path), `.${basename(path)}.pideck-${randomUUID()}.tmp`);
	// open 失败时不能清理该路径：EEXIST 可能属于另一个写者或预置 symlink。
	const handle = await open(tempPath, "wx", 0o600);
	try {
		try {
			await handle.writeFile(content, "utf8");
			if (mode !== undefined) await handle.chmod(mode);
		} finally {
			await handle.close();
		}
		// 安全软件/占用句柄拒绝 rename 时直接失败，绝不以原位 writeFile 绕过。
		await rename(tempPath, path);
	} finally {
		await rm(tempPath, { force: true });
	}
}
