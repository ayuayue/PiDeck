/**
 * Local sync-folder object storage (第 6 类 provider).
 *
 * Writes already-encrypted objects into a user-chosen local folder. If that
 * folder is itself synced by the user's cloud-drive client (OneDrive, Nutstore,
 * Baidu Netdisk, ...), the drive client handles upload/download, so PiDeck gets
 * cloud sync without any new account or provider API.
 *
 * Safety notes:
 * - Object keys are validated by assertSafeCloudObjectKey and resolved inside
 *   the folder; `..`/absolute escapes are rejected before any filesystem call.
 * - Writes go through a temporary file + rename so a half-written object is
 *   never visible to the drive client (atomic replacement).
 * - Revisions are file mtimes (ms); conditional writes compare the current
 *   mtime and throw CloudSyncConditionalWriteError on mismatch, mirroring the
 *   S3 adapter's guard so the merge layer can detect concurrent edits.
 */

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { LocalFolderConfig, ProviderAccount } from "../../../shared/types/cloudSync.ts";
import {
	assertSafeCloudObjectKey,
	CloudSyncConditionalWriteError,
	type CloudSyncObjectDeleteOptions,
	type CloudSyncObjectReadResult,
	type CloudSyncObjectStorageCapabilities,
	type CloudSyncObjectWriteOptions,
	type CloudSyncObjectWriteResult,
	type PiDeckCloudObjectStorage,
} from "../objectStorage.ts";
import { normalizeLocalFolderConfig } from "../providerConfig.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class LocalFolderObjectStorage implements PiDeckCloudObjectStorage {
	readonly providerId = "local" as const;

	private readonly root: string;
	private readonly account: ProviderAccount;
	private connected = false;

	constructor(config: unknown) {
		const normalized = normalizeLocalFolderConfig(config);
		// 统一为绝对路径；连接时创建目录，避免配置阶段对文件系统有任何副作用。
		this.root = resolve(normalized.folderPath);
		this.account = { id: "local", name: this.root };
	}

	async connect(options?: { signal?: AbortSignal }): Promise<{ account: ProviderAccount }> {
		// 幂等创建：folderPath 可能尚不存在（用户在网盘客户端新建同步目录时常见）。
		await mkdir(this.root, { recursive: true });
		this.assertNotAborted(options?.signal);
		this.connected = true;
		return { account: { ...this.account } };
	}

	async disconnect(): Promise<void> {
		this.connected = false;
	}

	async getAccount(): Promise<ProviderAccount | null> {
		return this.connected ? { ...this.account } : null;
	}

	async getCapabilities(): Promise<CloudSyncObjectStorageCapabilities> {
		return {
			// 本地文件系统天然支持 revision（mtime）与条件写；临时文件 + rename 原子替换。
			revisions: true,
			conditionalWrites: true,
			atomicReplacement: true,
		};
	}

	async readObject(key: string, options?: { signal?: AbortSignal }): Promise<CloudSyncObjectReadResult> {
		assertSafeCloudObjectKey(key);
		this.requireConnected();
		const path = this.objectPath(key);
		this.assertNotAborted(options?.signal);
		let stat;
		try {
			stat = await lstat(path);
		} catch (error) {
			if (this.isNotFound(error)) return { found: false, key, bytes: null };
			throw error;
		}
		if (!stat.isFile()) return { found: false, key, bytes: null };
		const bytes = await readFile(path);
		return {
			found: true,
			key,
			bytes,
			revision: String(stat.mtimeMs),
			contentType: "application/octet-stream",
		};
	}

	async writeObject(
		key: string,
		bytes: Uint8Array,
		options?: CloudSyncObjectWriteOptions,
	): Promise<CloudSyncObjectWriteResult> {
		assertSafeCloudObjectKey(key);
		this.requireConnected();
		const path = this.objectPath(key);
		this.assertNotAborted(options?.signal);

		const current = await this.statOrNull(path);
		if (options?.expectedRevision === null && current) {
			throw new CloudSyncConditionalWriteError("Local folder object already exists");
		}
		if (typeof options?.expectedRevision === "string") {
			if (!current) {
				throw new CloudSyncConditionalWriteError("Local folder object was deleted concurrently");
			}
			if (String(current.mtimeMs) !== options.expectedRevision) {
				throw new CloudSyncConditionalWriteError("Local folder object changed concurrently");
			}
		}

		// 临时文件 + rename：网盘客户端永远不会看到半写入的对象；临时文件与目标同目录保证 rename 原子。
		const directory = dirname(path);
		await mkdir(directory, { recursive: true });
		const temporaryPath = join(directory, `.${basename(key)}.tmp-${randomUUID()}`);
		try {
			await writeFile(temporaryPath, Buffer.from(bytes), { flag: "wx" });
			await rename(temporaryPath, path);
		} catch (error) {
			await unlink(temporaryPath).catch(() => undefined);
			throw error;
		}

		const stored = await this.statOrNull(path);
		return {
			created: !current,
			revision: stored ? String(stored.mtimeMs) : undefined,
		};
	}

	async deleteObject(key: string, options?: CloudSyncObjectDeleteOptions): Promise<{ deleted: boolean }> {
		assertSafeCloudObjectKey(key);
		this.requireConnected();
		const path = this.objectPath(key);
		this.assertNotAborted(options?.signal);

		const current = await this.statOrNull(path);
		if (!current) return { deleted: false };
		if (typeof options?.expectedRevision === "string" && String(current.mtimeMs) !== options.expectedRevision) {
			throw new CloudSyncConditionalWriteError("Local folder object changed concurrently");
		}
		await unlink(path);
		return { deleted: true };
	}

	/** Resolve a validated object key to an absolute path inside the folder. */
	private objectPath(key: string): string {
		assertSafeCloudObjectKey(key);
		const resolved = resolve(this.root, key);
		const relativePath = relative(this.root, resolved);
		if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
			throw new TypeError("Cloud sync object key escapes the local folder");
		}
		return resolved;
	}

	private async statOrNull(path: string): Promise<{ mtimeMs: number } | null> {
		try {
			const stat = await lstat(path);
			return stat.isFile() ? { mtimeMs: stat.mtimeMs } : null;
		} catch (error) {
			if (this.isNotFound(error)) return null;
			throw error;
		}
	}

	private requireConnected(): void {
		if (!this.connected) throw new Error("Local folder storage is not connected");
	}

	private assertNotAborted(signal?: AbortSignal): void {
		if (signal?.aborted) throw new Error("Cloud sync operation was aborted");
	}

	private isNotFound(error: unknown): boolean {
		return isRecord(error) && (error as { code?: unknown }).code === "ENOENT";
	}
}
