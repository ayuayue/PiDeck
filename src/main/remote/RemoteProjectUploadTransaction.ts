import { randomBytes } from "node:crypto";
import { codeOf } from "../../shared/op";
import type { RemoteProjectSession } from "./RemoteHostConnectionService";
import { runRemoteSftpJob } from "./RemoteSftpAdapter";
import type { RemoteSftpCapabilityCache } from "./RemoteSftpCapabilityCache";
import type { RemoteSftpCapabilityProbe } from "./RemoteSftpCapabilityProbe";
import type { RemoteSftpProbe } from "./RemoteSftpAdapter";

/**
 * 远端上传事务的**唯一**一份实现：`fs.uploadPrepare` → SFTP `stage` → `fs.uploadCommit`。
 *
 * 创建（`policy: "create"`，绝不覆盖已存在目标）与替换（`policy: "replace"` + `expected` 乐观锁）
 * 只差 prepare 的一个字段，所以两条入口共用这个函数：正文永远走 SFTP spool，绝不进 shell 命令；
 * prepare 签发的一次性 token 由 abort 独占清理；提交之后任何非确定失败都按 unknown 处理且绝不重放。
 * 稳定码与回执校验也在这里，只有一份契约。
 */

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

const REF = /^[0-9a-f]{32}$/;
const HASH = /^[0-9a-f]{64}$/;
const REQUIRED_METHODS = ["fs.uploadPrepare", "fs.uploadCommit", "fs.uploadAbort"] as const;
/** 提交阶段的**确定拒绝**：helper 明确说没替换，重放不会改变结果。其余一律按未知处理。 */
const DEFINITE_COMMIT_REFUSALS = new Set([
	"FILE_UPLOAD_INPUT_INVALID",
	"FILE_UPLOAD_TOKEN_INVALID",
	"FILE_UPLOAD_TARGET_EXISTS",
	"FILE_UPLOAD_SOURCE_CHANGED",
	"FILE_UPLOAD_STAGE_INVALID",
	"FILE_UPLOAD_PATH_INVALID",
	"FILE_UPLOAD_ROOT_CHANGED",
	"FILE_UPLOAD_UNSUPPORTED",
	"TOO_MANY_REQUESTS",
	"PERMISSION_DENIED",
	"IO_ERROR",
]);

/** 上传事务需要的会话切片：SFTP 探测与 spool/提交都只要这些成员。 */
export type RemoteProjectUploadSession = Pick<RemoteProjectSession, "hostId" | "connectionId" | "hostRevision" | "deployRoot" | "request" | "withSftpInvocation">;

export type RemoteProjectUploadSftp = {
	readonly binaryIdentity: string;
	readonly cache: RemoteSftpCapabilityCache<RemoteSftpProbe>;
	readonly probe: RemoteSftpCapabilityProbe;
};

/** 一个稳定且大小已知的本地正文快照（上传事务只吃这份证据，不重新读本地文件）。 */
export type LocalSnapshot = {
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

export type RemoteRevision = {
	readonly mode: number;
	readonly size: number;
	readonly dev: string;
	readonly ino: string;
	readonly uid: string;
	readonly gid: string;
	readonly mtimeNs: string;
	readonly ctimeNs: string;
};

/** 替换模式的乐观锁凭据：打开文本时签出的那一份身份 + 摘要（字段与 revision 同形再加 digest）。 */
export type RemoteProjectUploadExpected = RemoteRevision & { readonly digest: string };

export type RemoteProjectUploadJobReceipt = {
	readonly name: string;
	readonly bytes: number;
	readonly sha256: string;
	readonly relativePath: string;
	readonly revision: RemoteRevision;
};

export type RemoteProjectUploadJobDependencies = {
	readonly adapter?: typeof runRemoteSftpJob;
	readonly inspectLocal?: (path: string, signal?: AbortSignal) => Promise<LocalSnapshot>;
};

export type UploadTransaction = {
	readonly session: RemoteProjectUploadSession;
	readonly canonicalRoot: string;
	readonly binaryPath: string;
	readonly sftp: RemoteProjectUploadSftp;
	readonly target: { relative: string; name: string };
	readonly localPath: string;
	readonly local: LocalSnapshot;
	readonly signal?: AbortSignal;
	readonly onProgress?: (transferred: number, total: number) => void;
};

export type UploadPolicy = { readonly policy: "create" } | { readonly policy: "replace"; readonly expected: RemoteProjectUploadExpected };

export function jobError(code: string, outcome: "rejected" | "unknown" = "rejected"): Error & { code: string; outcome: "rejected" | "unknown" } {
	const error = new Error(code) as Error & { code: string; outcome: "rejected" | "unknown" };
	error.code = code;
	error.outcome = outcome;
	return error;
}

export function cancelled(): never {
	throw jobError("REQUEST_CANCELLED");
}

export function checkAbort(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) cancelled();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringDigits(value: unknown): value is string {
	return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value);
}

function readPrepare(value: unknown, uploadId: string): { token: string; expiresAt: number } | undefined {
	if (!isRecord(value) || Object.keys(value).sort().join(",") !== "expiresAt,stageRef,token" || typeof value.token !== "string" || !REF.test(value.token) || value.stageRef !== uploadId || !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= Date.now()) return undefined;
	return { token: value.token, expiresAt: value.expiresAt as number };
}

function readRevision(value: unknown): RemoteRevision | undefined {
	if (!isRecord(value) || Object.keys(value).sort().join(",") !== "ctimeNs,dev,gid,ino,mode,mtimeNs,size,uid".split(",").sort().join(",")) return undefined;
	if (!Number.isSafeInteger(value.mode) || (value.mode as number) < 0 || (value.mode as number) > 0o7777 || !Number.isSafeInteger(value.size) || (value.size as number) < 0) return undefined;
	if (!stringDigits(value.dev) || !stringDigits(value.ino) || !stringDigits(value.uid) || !stringDigits(value.gid) || !stringDigits(value.mtimeNs) || !stringDigits(value.ctimeNs)) return undefined;
	return { mode: value.mode as number, size: value.size as number, dev: value.dev, ino: value.ino, uid: value.uid, gid: value.gid, mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs };
}

function readCommit(value: unknown, input: { relative: string; bytes: number; sha256: string }): RemoteRevision | undefined {
	if (!isRecord(value) || Object.keys(value).sort().join(",") !== "committed,fsync,path,revision,sha256,size,stageCleaned".split(",").sort().join(",")) return undefined;
	if (value.committed !== true || value.path !== input.relative || value.size !== input.bytes || value.sha256 !== input.sha256 || value.fsync !== true || typeof value.stageCleaned !== "boolean") return undefined;
	return readRevision(value.revision);
}

/** 只按契约的九个字段重新组一次，绝不把调用方对象里的其他字段带出进程。 */
export function readExpected(value: RemoteProjectUploadExpected): RemoteProjectUploadExpected {
	const revision = readRevision({ mode: value.mode, size: value.size, dev: value.dev, ino: value.ino, uid: value.uid, gid: value.gid, mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs });
	if (revision === undefined || typeof value.digest !== "string" || !HASH.test(value.digest)) throw jobError(REMOTE_PROJECT_UPLOAD_JOB_CODES.pathInvalid);
	return { ...revision, digest: value.digest };
}

async function abortPrepared(session: RemoteProjectUploadSession, uploadId: string, token: string): Promise<void> {
	try {
		await session.request("fs.uploadAbort", { uploadId, token }, { timeoutMs: 10_000 });
	} catch {
		// Best effort: an expired prepare or a lost generation may already have swept the spool.
	}
}

export function requireUploadHelper(capabilities: readonly string[] | undefined): void {
	if (capabilities === undefined || REQUIRED_METHODS.some((method) => !capabilities.includes(method))) throw jobError(REMOTE_PROJECT_UPLOAD_JOB_CODES.helperUnsupported);
}

export async function runUploadTransaction(input: UploadTransaction, dependencies: RemoteProjectUploadJobDependencies, policy: UploadPolicy): Promise<RemoteProjectUploadJobReceipt> {
	const { session, local } = input;
	checkAbort(input.signal);
	const adapter = dependencies.adapter ?? runRemoteSftpJob;
	const uploadId = randomBytes(16).toString("hex");
	const probe = await input.sftp.probe.ensureProbe({ canonicalRoot: input.canonicalRoot, binaryPath: input.binaryPath, binaryIdentity: input.sftp.binaryIdentity, session, cache: input.sftp.cache, signal: input.signal });
	if (!probe.ok) throw jobError(probe.code);
	checkAbort(input.signal);
	let preparedRaw: unknown;
	try {
		preparedRaw = await session.request("fs.uploadPrepare", { uploadId, path: input.target.relative, policy: policy.policy, size: local.bytes, sha256: local.sha256, ...(policy.policy === "replace" ? { expected: readExpected(policy.expected) } : {}) }, { timeoutMs: 30_000 });
	} catch (error) {
		if (input.signal?.aborted === true) cancelled();
		throw jobError(codeOf(error, REMOTE_PROJECT_UPLOAD_JOB_CODES.failed));
	}
	const prepared = readPrepare(preparedRaw, uploadId);
	if (prepared === undefined) throw jobError(REMOTE_PROJECT_UPLOAD_JOB_CODES.prepareInvalid);
	let stageFinished = false;
	try {
		checkAbort(input.signal);
		await session.withSftpInvocation(async (invocation, assertCurrent) => {
			await assertCurrent();
			checkAbort(input.signal);
			const result = await adapter(
				input.binaryPath,
				{ operation: "stage", invocation, root: session.deployRoot, relative: `upload-spool/${uploadId}.part`, localPath: input.localPath },
				{
					signal: input.signal,
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
		});
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
	const revision = readCommit(committedRaw, { relative: input.target.relative, bytes: local.bytes, sha256: local.sha256 });
	if (revision === undefined || input.signal?.aborted === true) throw jobError(REMOTE_PROJECT_UPLOAD_JOB_CODES.commitUnconfirmed, "unknown");
	return { name: input.target.name, bytes: local.bytes, sha256: local.sha256, relativePath: input.target.relative, revision };
}
