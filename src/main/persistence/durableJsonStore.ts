import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { renameWithRetry } from "../utils/fsRetry";

export type DurableJsonWriteOptions = {
	backupPath?: string;
	skipBackup?: boolean;
	backupFailurePolicy?: "throw" | "continue";
};

export type DurableJsonWriteResult = {
	backupError?: unknown;
	directorySynced: boolean;
};

/** Flushes a temp snapshot before replacing the primary and optionally rotating its backup. */
export async function writeDurableJsonFile(filePath: string, content: string, options: DurableJsonWriteOptions = {}): Promise<DurableJsonWriteResult> {
	const backupPath = options.backupPath;
	const nonce = randomUUID();
	const tempPath = `${filePath}.${nonce}.tmp`;
	const backupTempPath = backupPath ? `${backupPath}.${nonce}.tmp` : undefined;
	await mkdir(dirname(filePath), { recursive: true });
	let backupError: unknown;
	try {
		const handle = await open(tempPath, "wx");
		try {
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}

		if (backupPath && backupTempPath && !options.skipBackup) {
			try {
				await copyFile(filePath, backupTempPath);
				const backupHandle = await open(backupTempPath, "r+");
				try {
					await backupHandle.sync();
				} finally {
					await backupHandle.close();
				}
				await renameWithRetry(backupTempPath, backupPath);
			} catch (error) {
				await unlink(backupTempPath).catch(() => undefined);
				if (isMissingFileError(error)) {
					// First write has no previous primary to preserve.
				} else if (options.backupFailurePolicy === "continue") {
					backupError = error;
				} else {
					throw error;
				}
			}
		}

		await renameWithRetry(tempPath, filePath);
		const directorySynced = await syncDirectory(dirname(filePath));
		return { ...(backupError ? { backupError } : {}), directorySynced };
	} finally {
		await unlink(tempPath).catch(() => undefined);
		if (backupTempPath) await unlink(backupTempPath).catch(() => undefined);
	}
}

async function syncDirectory(directory: string): Promise<boolean> {
	if (process.platform === "win32") return false;
	let handle: FileHandle | undefined;
	try {
		handle = await open(directory, "r");
		await handle.sync();
		return true;
	} catch (error) {
		const code = errorCode(error);
		if (code === "EINVAL" || code === "ENOTSUP" || code === "EISDIR") return false;
		throw error;
	} finally {
		await handle?.close();
	}
}

function isMissingFileError(error: unknown): boolean {
	return errorCode(error) === "ENOENT";
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}
