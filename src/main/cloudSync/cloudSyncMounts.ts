/**
 * Cloud project mount registry (pure, electron-free).
 *
 * Implements the manual-mount strategy (§12.5 of docs/cloud-sync-plan.md):
 * each remote project is mapped to one local directory on first pull, and the
 * mapping persists across restarts in `${baseDir}/cloud-sync-mounts.json`.
 * One remote project may be mounted to exactly one local directory, and one
 * directory may serve only one remote project.
 */

import { readFileSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, posix, resolve, win32 } from "node:path";

import type { CloudSyncMount } from "../../shared/types/cloudSync.ts";

export const CLOUD_SYNC_MOUNTS_FILE = "cloud-sync-mounts.json";

export interface CloudSyncMountInput {
	remoteProjectId: string;
	remoteProjectName: string;
	localPath: string;
}

export interface CloudSyncMountRegistry {
	list(): CloudSyncMount[];
	get(remoteProjectId: string): CloudSyncMount | undefined;
	mount(input: CloudSyncMountInput): Promise<CloudSyncMount>;
	unmount(remoteProjectId: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMountRecord(value: unknown): value is CloudSyncMount {
	if (!isRecord(value)) return false;
	const { remoteProjectId, remoteProjectName, localPath, mountedAt } = value;
	return (
		typeof remoteProjectId === "string" &&
		remoteProjectId.length > 0 &&
		typeof remoteProjectName === "string" &&
		remoteProjectName.length > 0 &&
		typeof localPath === "string" &&
		localPath.length > 0 &&
		typeof mountedAt === "number" &&
		Number.isFinite(mountedAt)
	);
}

function isMissingError(error: unknown): boolean {
	return Boolean(
		error &&
			typeof error === "object" &&
			"code" in error &&
			(error as { code?: unknown }).code === "ENOENT",
	);
}

/** 跨平台绝对路径判定：当前平台 + win32（C:\ / \\server\share）+ posix（/）。 */
function isAbsolutePath(value: string): boolean {
	return isAbsolute(value) || win32.isAbsolute(value) || posix.isAbsolute(value);
}

async function resolveExistingDirectory(value: string): Promise<string> {
	const resolved = resolve(value);
	let info;
	try {
		info = await stat(resolved);
	} catch (error) {
		if (isMissingError(error)) throw new TypeError(`Mount target does not exist: ${value}`);
		throw new TypeError(`Unable to access mount target: ${value}`);
	}
	if (!info.isDirectory()) throw new TypeError(`Mount target is not a directory: ${value}`);
	return normalize(resolved);
}

/** 缺失或损坏的挂载文件按空处理；损坏文件在下次挂载时被重建。 */
function loadMounts(baseDir: string): CloudSyncMount[] {
	try {
		const raw = readFileSync(join(baseDir, CLOUD_SYNC_MOUNTS_FILE), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isMountRecord);
	} catch {
		return [];
	}
}

async function saveMounts(baseDir: string, mounts: CloudSyncMount[]): Promise<void> {
	await mkdir(baseDir, { recursive: true });
	await writeFile(join(baseDir, CLOUD_SYNC_MOUNTS_FILE), JSON.stringify(mounts, null, 2), "utf8");
}

export function createMountRegistry(baseDir: string): CloudSyncMountRegistry {
	let mounts = loadMounts(baseDir);

	return {
		list() {
			return [...mounts];
		},

		get(remoteProjectId) {
			return mounts.find((mount) => mount.remoteProjectId === remoteProjectId);
		},

		async mount(input) {
			if (typeof input.remoteProjectId !== "string" || input.remoteProjectId.trim().length === 0) {
				throw new TypeError("Remote project id must be a non-empty string");
			}
			if (typeof input.remoteProjectName !== "string" || input.remoteProjectName.trim().length === 0) {
				throw new TypeError("Remote project name must be a non-empty string");
			}
			if (typeof input.localPath !== "string" || input.localPath.trim().length === 0) {
				throw new TypeError("Mount target path must be a non-empty string");
			}
			if (!isAbsolutePath(input.localPath)) {
				throw new TypeError(`Mount target must be an absolute path: ${input.localPath}`);
			}
			if (mounts.some((mount) => mount.remoteProjectId === input.remoteProjectId)) {
				throw new TypeError(`Remote project is already mounted: ${input.remoteProjectId}`);
			}
			const normalized = await resolveExistingDirectory(input.localPath);
			if (mounts.some((mount) => mount.localPath === normalized)) {
				throw new TypeError(`Mount target is already in use: ${input.localPath}`);
			}
			const mount: CloudSyncMount = {
				remoteProjectId: input.remoteProjectId,
				remoteProjectName: input.remoteProjectName,
				localPath: normalized,
				mountedAt: Date.now(),
			};
			mounts = [...mounts, mount];
			await saveMounts(baseDir, mounts);
			return mount;
		},

		async unmount(remoteProjectId) {
			const next = mounts.filter((mount) => mount.remoteProjectId !== remoteProjectId);
			if (next.length === mounts.length) return; // 未挂载：静默 no-op
			mounts = next;
			await saveMounts(baseDir, mounts);
		},
	};
}
