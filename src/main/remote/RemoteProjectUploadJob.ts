import { createHash } from "node:crypto";
import { lstat, open, type FileHandle } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { basename, isAbsolute } from "node:path";
import type { RemoteHostConnectionService } from "./RemoteHostConnectionService";
import { REMOTE_UPLOAD_TEMP_NAME } from "./RemoteProjectUploadNames";
import {
	checkAbort,
	jobError,
	readExpected,
	REMOTE_PROJECT_UPLOAD_JOB_CODES,
	REMOTE_PROJECT_UPLOAD_MAX_BYTES,
	requireUploadHelper,
	runUploadTransaction,
	type LocalSnapshot,
	type RemoteProjectUploadExpected,
	type RemoteProjectUploadJobDependencies,
	type RemoteProjectUploadJobReceipt,
	type RemoteProjectUploadSftp,
	type RemoteProjectUploadSession,
} from "./RemoteProjectUploadTransaction";

export { REMOTE_PROJECT_UPLOAD_JOB_CODES, REMOTE_PROJECT_UPLOAD_MAX_BYTES } from "./RemoteProjectUploadTransaction";
export type { LocalSnapshot, RemoteProjectUploadExpected, RemoteProjectUploadJobDependencies, RemoteProjectUploadJobReceipt, RemoteProjectUploadSession, RemoteRevision } from "./RemoteProjectUploadTransaction";

/**
 * 远端上传的两个入口：**创建**（`uploadOneRemoteProjectFile`，目标名来自本地文件名、绝不覆盖）
 * 与**替换**（`replaceOneRemoteProjectFile`，整份正文原子替换一个已存在的目标）。
 *
 * 两者只差 prepare 的 policy/expected，事务本身（prepare → SFTP stage → commit）只有一份实现，
 * 见 `RemoteProjectUploadTransaction`。这里只剩本地证据、目标路径解算与入口装配。
 */

const HASH_CHUNK_BYTES = 1024 * 1024;
const CONTROL = /[\u0000-\u001f\u007f]/;

export type RemoteProjectUploadJobInput = {
	readonly service: RemoteHostConnectionService;
	readonly hostId: string;
	readonly canonicalRoot: string;
	readonly binaryPath: string;
	readonly sftp: RemoteProjectUploadSftp;
	readonly directory: string;
	readonly localPath: string;
	readonly signal?: AbortSignal;
	readonly onProgress?: (transferred: number, total: number) => void;
};

/** 替换模式：会话已经由调用方建立（文本服务在一次项目会话里完成快照 + 替换）。 */
export type RemoteProjectReplaceJobInput = {
	readonly session: RemoteProjectUploadSession;
	readonly capabilities: readonly string[] | undefined;
	readonly canonicalRoot: string;
	readonly binaryPath: string;
	readonly sftp: RemoteProjectUploadSftp;
	/** 项目相对的**目标文件**路径（不是本地文件名）。 */
	readonly relative: string;
	readonly localPath: string;
	readonly expected: RemoteProjectUploadExpected;
	readonly signal?: AbortSignal;
};

function identityOf(stats: BigIntStats): LocalSnapshot["identity"] {
	return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs, mode: stats.mode, uid: stats.uid, gid: stats.gid };
}

function sameIdentity(left: LocalSnapshot["identity"], right: LocalSnapshot["identity"]): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid;
}

/** Hash one stable local regular file without loading it into memory. */
export async function inspectLocalUploadFile(path: string, signal?: AbortSignal): Promise<LocalSnapshot> {
	if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096 || CONTROL.test(path)) throw jobError(REMOTE_PROJECT_UPLOAD_JOB_CODES.localPathInvalid);
	let before: BigIntStats;
	try {
		before = await lstat(path, { bigint: true });
	} catch {
		throw jobError(REMOTE_PROJECT_UPLOAD_JOB_CODES.localReadFailed);
	}
	if (!before.isFile() || before.isSymbolicLink()) throw jobError(REMOTE_PROJECT_UPLOAD_JOB_CODES.localNotFile);
	if (before.size < 0n || before.size > BigInt(REMOTE_PROJECT_UPLOAD_MAX_BYTES)) throw jobError(REMOTE_PROJECT_UPLOAD_JOB_CODES.tooLarge);

	let handle: FileHandle | undefined;
	try {
		handle = await open(path, "r");
		const opened = await handle.stat({ bigint: true });
		const expected = identityOf(before);
		if (!opened.isFile() || !sameIdentity(expected, identityOf(opened))) throw jobError(REMOTE_PROJECT_UPLOAD_JOB_CODES.localChanged);

		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
		let read = 0;
		for (;;) {
			checkAbort(signal);
			const result = await handle.read(buffer, 0, buffer.length, null);
			if (result.bytesRead === 0) break;
			hash.update(buffer.subarray(0, result.bytesRead));
			read += result.bytesRead;
			if (BigInt(read) > before.size) throw jobError(REMOTE_PROJECT_UPLOAD_JOB_CODES.localChanged);
		}
		const openedAfter = await handle.stat({ bigint: true });
		const pathAfter = await lstat(path, { bigint: true });
		if (!sameIdentity(expected, identityOf(openedAfter)) || !sameIdentity(expected, identityOf(pathAfter)) || BigInt(read) !== before.size) throw jobError(REMOTE_PROJECT_UPLOAD_JOB_CODES.localChanged);
		return { bytes: read, sha256: hash.digest("hex"), identity: expected };
	} catch (error) {
		if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test((error as Error & { code?: string }).code ?? error.message)) throw error;
		if (signal?.aborted === true) checkAbort(signal);
		throw jobError(REMOTE_PROJECT_UPLOAD_JOB_CODES.localReadFailed);
	} finally {
		try {
			await handle?.close();
		} catch {
			// The source is already closed; a failed close cannot change the snapshot we computed.
		}
	}
}

function readDirectory(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length > 4096 || CONTROL.test(value) || value.startsWith("/") || value.includes("\\")) return undefined;
	if (value === "") return "";
	const segments = value.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
	if (segments[0] === ".pideck-trash") return undefined;
	return value;
}

function targetRelative(directory: unknown, localPath: string): { relative: string; name: string } {
	const parsed = readDirectory(directory);
	const name = basename(localPath);
	if (parsed === undefined || name.length === 0 || name.includes("\\") || CONTROL.test(name) || name === "." || name === ".." || REMOTE_UPLOAD_TEMP_NAME.test(name)) throw jobError(REMOTE_PROJECT_UPLOAD_JOB_CODES.pathInvalid);
	const relative = parsed === "" ? name : parsed + "/" + name;
	if (Buffer.byteLength(relative, "utf8") > 4096) throw jobError(REMOTE_PROJECT_UPLOAD_JOB_CODES.pathInvalid);
	return { relative, name };
}

function replaceTarget(relative: unknown): { relative: string; name: string } {
	const parsed = readDirectory(relative);
	if (parsed === undefined || parsed === "") throw jobError(REMOTE_PROJECT_UPLOAD_JOB_CODES.pathInvalid);
	const name = parsed.slice(parsed.lastIndexOf("/") + 1);
	if (REMOTE_UPLOAD_TEMP_NAME.test(name)) throw jobError(REMOTE_PROJECT_UPLOAD_JOB_CODES.pathInvalid);
	return { relative: parsed, name };
}

/** 创建：目标名来自本地文件名，绝不覆盖已存在的远端文件。 */
export async function uploadOneRemoteProjectFile(input: RemoteProjectUploadJobInput, dependencies: RemoteProjectUploadJobDependencies = {}): Promise<RemoteProjectUploadJobReceipt> {
	if (typeof input.localPath !== "string" || !isAbsolute(input.localPath)) throw jobError(REMOTE_PROJECT_UPLOAD_JOB_CODES.localPathInvalid);
	const target = targetRelative(input.directory, input.localPath);
	checkAbort(input.signal);
	const local = await (dependencies.inspectLocal ?? inspectLocalUploadFile)(input.localPath, input.signal);
	checkAbort(input.signal);
	const outcome = await input.service.withProjectSession(
		input.hostId,
		input.canonicalRoot,
		async (session) => {
			requireUploadHelper(input.service.projectHelperCapabilities(input.hostId, input.canonicalRoot));
			return runUploadTransaction({ session, target, local, localPath: input.localPath, canonicalRoot: input.canonicalRoot, binaryPath: input.binaryPath, sftp: input.sftp, signal: input.signal, onProgress: input.onProgress }, dependencies, { policy: "create" });
		},
		{ requireReady: true, signal: input.signal },
	);
	if (!outcome.ok) throw jobError(outcome.code === "REQUEST_CANCELLED" ? "REQUEST_CANCELLED" : outcome.code);
	return outcome.value;
}

/**
 * 替换：整份正文原子替换一个**已存在**的目标，乐观锁用 `expected` 表达。
 *
 * 目标缺失或不再是那一版时 helper 以 `FILE_UPLOAD_SOURCE_CHANGED` 明确拒绝；调用方据此报冲突，
 * 绝不重试。本地 spool 的摘要必须等于 `expected.digest`，否则这次替换连发都不用发出去。
 */
export async function replaceOneRemoteProjectFile(input: RemoteProjectReplaceJobInput, dependencies: RemoteProjectUploadJobDependencies = {}): Promise<RemoteProjectUploadJobReceipt> {
	const target = replaceTarget(input.relative);
	const expected = readExpected(input.expected);
	requireUploadHelper(input.capabilities);
	checkAbort(input.signal);
	const local = await (dependencies.inspectLocal ?? inspectLocalUploadFile)(input.localPath, input.signal);
	return runUploadTransaction({ session: input.session, target, local, localPath: input.localPath, canonicalRoot: input.canonicalRoot, binaryPath: input.binaryPath, sftp: input.sftp, signal: input.signal }, dependencies, { policy: "replace", expected });
}
