import { createHash, randomBytes } from "node:crypto";
import { lstat, open, type FileHandle } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { basename, isAbsolute, posix } from "node:path";
import { codeOf } from "../../shared/op";
import type { RemoteHostConnectionService, RemoteProjectSession } from "./RemoteHostConnectionService";
import { runRemoteSftpJob } from "./RemoteSftpAdapter";
import type { RemoteSftpCapabilityCache } from "./RemoteSftpCapabilityCache";
import type { RemoteSftpCapabilityProbe } from "./RemoteSftpCapabilityProbe";
import type { RemoteSftpProbe } from "./RemoteSftpAdapter";
import { REMOTE_UPLOAD_TEMP_NAME } from "./RemoteProjectUploadNames";

export const REMOTE_PROJECT_UPLOAD_JOB_CODES = {
	pathInvalid: "REMOTE_UPLOAD_PATH_INVALID",
	localPathInvalid: "REMOTE_UPLOAD_LOCAL_PATH_INVALID",
	localNotFile: "REMOTE_UPLOAD_LOCAL_NOT_A_FILE",
	tooLarge: "REMOTE_FILE_TOO_LARGE",
	localReadFailed: "REMOTE_UPLOAD_LOCAL_READ_FAILED",
	localChanged: "REMOTE_UPLOAD_LOCAL_CHANGED",
	helperUnsupported: "REMOTE_UPLOAD_HELPER_UNSUPPORTED",
	prepareInvalid: "REMOTE_UPLOAD_PREPARE_INVALID",
	stageInvalid: "REMOTE_UPLOAD_STAGE_INVALID",
	failed: "REMOTE_UPLOAD_FAILED",
	commitUnconfirmed: "REMOTE_UPLOAD_COMMIT_UNCONFIRMED",
} as const;

export const REMOTE_PROJECT_UPLOAD_MAX_BYTES = 8 * 1024 * 1024 * 1024;

const HASH_CHUNK_BYTES = 1024 * 1024;
const CONTROL = /[\u0000-\u001f\u007f]/;
const REF = /^[0-9a-f]{32}$/;
const HASH = /^[0-9a-f]{64}$/;
const REQUIRED_METHODS = ["fs.uploadPrepare", "fs.uploadCommit", "fs.uploadAbort"] as const;
const DEFINITE_COMMIT_REFUSALS = new Set(["FILE_UPLOAD_INPUT_INVALID", "FILE_UPLOAD_TOKEN_INVALID", "FILE_UPLOAD_TARGET_EXISTS", "FILE_UPLOAD_STAGE_INVALID", "FILE_UPLOAD_PATH_INVALID", "FILE_UPLOAD_ROOT_CHANGED", "FILE_UPLOAD_UNSUPPORTED", "TOO_MANY_REQUESTS", "PERMISSION_DENIED", "IO_ERROR"]);

type RemoteRevision = {
	readonly mode: number;
	readonly size: number;
	readonly dev: string;
	readonly ino: string;
	readonly uid: string;
	readonly gid: string;
	readonly mtimeNs: string;
	readonly ctimeNs: string;
};

export type RemoteProjectUploadJobReceipt = {
	readonly name: string;
	readonly bytes: number;
	readonly sha256: string;
	readonly relativePath: string;
	readonly revision: RemoteRevision;
};

export type RemoteProjectUploadJobInput = {
	readonly service: RemoteHostConnectionService;
	readonly hostId: string;
	readonly canonicalRoot: string;
	readonly binaryPath: string;
	readonly sftp: {
		readonly binaryIdentity: string;
		readonly cache: RemoteSftpCapabilityCache<RemoteSftpProbe>;
		readonly probe: RemoteSftpCapabilityProbe;
	};
	readonly directory: string;
	readonly localPath: string;
	readonly signal?: AbortSignal;
	readonly onProgress?: (transferred: number, total: number) => void;
};

type LocalSnapshot = {
	readonly bytes: number;
	readonly sha256: string;
	readonly identity: {
		readonly dev: bigint;
		readonly ino: bigint;
		readonly size: bigint;
		readonly mtimeNs: bigint;
		readonly ctimeNs: bigint;
		readonly mode: bigint;
		readonly uid: bigint;
		readonly gid: bigint;
	};
};

export type RemoteProjectUploadJobDependencies = {
	readonly adapter?: typeof runRemoteSftpJob;
	readonly inspectLocal?: (path: string, signal?: AbortSignal) => Promise<LocalSnapshot>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validText(value: unknown, maximum: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maximum && !CONTROL.test(value);
}

function jobError(code: string, outcome: "rejected" | "unknown" = "rejected"): Error & { code: string; outcome: "rejected" | "unknown" } {
	const error = new Error(code) as Error & { code: string; outcome: "rejected" | "unknown" };
	error.code = code;
	error.outcome = outcome;
	return error;
}

function cancelled(): never {
	throw jobError("REQUEST_CANCELLED");
}

function checkAbort(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) cancelled();
}

function identityOf(stats: BigIntStats): LocalSnapshot["identity"] {
	return {
		dev: stats.dev,
		ino: stats.ino,
		size: stats.size,
		mtimeNs: stats.mtimeNs,
		ctimeNs: stats.ctimeNs,
		mode: stats.mode,
		uid: stats.uid,
		gid: stats.gid,
	};
}

function sameIdentity(left: LocalSnapshot["identity"], right: LocalSnapshot["identity"]): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid;
}

async function closeQuietly(handle: FileHandle | undefined): Promise<void> {
	try {
		await handle?.close();
	} catch {
		// The source is already closed or the remote phase owns its own descriptors.
	}
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
		if (signal?.aborted === true) cancelled();
		throw jobError(REMOTE_PROJECT_UPLOAD_JOB_CODES.localReadFailed);
	} finally {
		await closeQuietly(handle);
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

function readPrepare(value: unknown, uploadId: string): { token: string; expiresAt: number } | undefined {
	if (!isRecord(value) || Object.keys(value).sort().join(",") !== "expiresAt,stageRef,token" || typeof value.token !== "string" || !REF.test(value.token) || value.stageRef !== uploadId || !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= Date.now()) return undefined;
	return { token: value.token, expiresAt: value.expiresAt as number };
}

function stringDigits(value: unknown): value is string {
	return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value);
}

function readRevision(value: unknown): RemoteRevision | undefined {
	if (!isRecord(value) || Object.keys(value).sort().join(",") !== "ctimeNs,dev,gid,ino,mode,mtimeNs,size,uid".split(",").sort().join(",")) return undefined;
	if (!Number.isSafeInteger(value.mode) || (value.mode as number) < 0 || (value.mode as number) > 0o7777 || !Number.isSafeInteger(value.size) || (value.size as number) < 0) return undefined;
	if (!stringDigits(value.dev) || !stringDigits(value.ino) || !stringDigits(value.uid) || !stringDigits(value.gid) || !stringDigits(value.mtimeNs) || !stringDigits(value.ctimeNs)) return undefined;
	return {
		mode: value.mode as number,
		size: value.size as number,
		dev: value.dev,
		ino: value.ino,
		uid: value.uid,
		gid: value.gid,
		mtimeNs: value.mtimeNs,
		ctimeNs: value.ctimeNs,
	};
}

function readCommit(value: unknown, input: { relative: string; bytes: number; sha256: string }): RemoteRevision | undefined {
	if (!isRecord(value) || Object.keys(value).sort().join(",") !== "committed,fsync,path,revision,sha256,size,stageCleaned".split(",").sort().join(",")) return undefined;
	if (value.committed !== true || value.path !== input.relative || value.size !== input.bytes || value.sha256 !== input.sha256 || value.fsync !== true || typeof value.stageCleaned !== "boolean") return undefined;
	return readRevision(value.revision);
}

async function abortPrepared(session: RemoteProjectSession, uploadId: string, token: string): Promise<void> {
	try {
		await session.request("fs.uploadAbort", { uploadId, token }, { timeoutMs: 10_000 });
	} catch {
		// Best effort: an expired prepare or a lost generation may already have swept the spool.
	}
}

export async function uploadOneRemoteProjectFile(input: RemoteProjectUploadJobInput, dependencies: RemoteProjectUploadJobDependencies = {}): Promise<RemoteProjectUploadJobReceipt> {
	if (typeof input.localPath !== "string" || !isAbsolute(input.localPath)) throw jobError(REMOTE_PROJECT_UPLOAD_JOB_CODES.localPathInvalid);
	const target = targetRelative(input.directory, input.localPath);
	checkAbort(input.signal);
	const inspector = dependencies.inspectLocal ?? inspectLocalUploadFile;
	const t0 = Date.now();
	let local: LocalSnapshot;
	try {
		local = await inspector(input.localPath, input.signal);
	} finally {
		// Keep the local phase observable in tests without a second clock dependency.
		void t0;
	}
	checkAbort(input.signal);
	const adapter = dependencies.adapter ?? runRemoteSftpJob;
	const uploadId = randomBytes(16).toString("hex");
	const outcome = await input.service.withProjectSession(
		input.hostId,
		input.canonicalRoot,
		async (session) => {
			const capabilities = input.service.projectHelperCapabilities(input.hostId, input.canonicalRoot);
			if (capabilities === undefined || REQUIRED_METHODS.some((method) => !capabilities.includes(method))) throw jobError(REMOTE_PROJECT_UPLOAD_JOB_CODES.helperUnsupported);
			checkAbort(input.signal);
			const probe = await input.sftp.probe.ensureProbe({
				canonicalRoot: input.canonicalRoot,
				binaryPath: input.binaryPath,
				binaryIdentity: input.sftp.binaryIdentity,
				session,
				cache: input.sftp.cache,
				...(input.signal === undefined ? {} : { signal: input.signal }),
			});
			if (!probe.ok) throw jobError(probe.code);
			checkAbort(input.signal);
			let preparedRaw: unknown;
			try {
				preparedRaw = await session.request("fs.uploadPrepare", { uploadId, path: target.relative, policy: "create", size: local.bytes, sha256: local.sha256 }, { timeoutMs: 30_000 });
			} catch (error) {
				if (input.signal?.aborted === true) cancelled();
				throw jobError(codeOf(error, REMOTE_PROJECT_UPLOAD_JOB_CODES.failed));
			}
			const prepared = readPrepare(preparedRaw, uploadId);
			if (prepared === undefined) throw jobError(REMOTE_PROJECT_UPLOAD_JOB_CODES.prepareInvalid);
			let stageFinished = false;
			try {
				checkAbort(input.signal);
				const stage = await session.withSftpInvocation(async (invocation, assertCurrent) => {
					await assertCurrent();
					checkAbort(input.signal);
					const result = await adapter(
						input.binaryPath,
						{ operation: "stage", invocation, root: session.deployRoot, relative: `upload-spool/${uploadId}.part`, localPath: input.localPath },
						{
							...(input.signal === undefined ? {} : { signal: input.signal }),
							onProgress: (progress) => {
								if (progress.operation === "stage") input.onProgress?.(progress.transferred, progress.total);
							},
						},
					);
					await assertCurrent();
					if (input.signal?.aborted === true) cancelled();
					if (!result.ok) throw jobError(result.code === "SFTP_JOB_CANCELLED" ? "REQUEST_CANCELLED" : result.code);
					if (result.operation !== "stage" || result.value.bytes !== local.bytes || result.value.sha256 !== local.sha256 || typeof result.value.fsync !== "boolean") throw jobError(REMOTE_PROJECT_UPLOAD_JOB_CODES.stageInvalid);
					stageFinished = true;
					return result.value;
				});
				void stage;
				checkAbort(input.signal);
			} catch (error) {
				// prepare issued a one-use token; abort is the only path allowed to remove this upload's spool.
				await abortPrepared(session, uploadId, prepared.token);
				if (input.signal?.aborted === true) cancelled();
				throw error;
			}
			if (!stageFinished) {
				await abortPrepared(session, uploadId, prepared.token);
				throw jobError(REMOTE_PROJECT_UPLOAD_JOB_CODES.stageInvalid);
			}

			// From here, the helper may publish before any error reaches this process. Every
			// non-definite failure is therefore unknown and is never replayed.
			let committedRaw: unknown;
			try {
				checkAbort(input.signal);
				committedRaw = await session.request("fs.uploadCommit", { uploadId, token: prepared.token }, { timeoutMs: 120_000 });
			} catch (error) {
				const code = codeOf(error, REMOTE_PROJECT_UPLOAD_JOB_CODES.commitUnconfirmed);
				if (DEFINITE_COMMIT_REFUSALS.has(code)) throw jobError(code);
				throw jobError(REMOTE_PROJECT_UPLOAD_JOB_CODES.commitUnconfirmed, "unknown");
			}
			const revision = readCommit(committedRaw, { relative: target.relative, bytes: local.bytes, sha256: local.sha256 });
			if (revision === undefined || input.signal?.aborted === true) throw jobError(REMOTE_PROJECT_UPLOAD_JOB_CODES.commitUnconfirmed, "unknown");
			return { name: target.name, bytes: local.bytes, sha256: local.sha256, relativePath: target.relative, revision };
		},
		{ requireReady: true, ...(input.signal === undefined ? {} : { signal: input.signal }) },
	);
	if (!outcome.ok) throw jobError(outcome.code === "REQUEST_CANCELLED" ? "REQUEST_CANCELLED" : outcome.code);
	return outcome.value;
}
