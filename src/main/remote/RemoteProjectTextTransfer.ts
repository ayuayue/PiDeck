import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeOf } from "../../shared/op";
import type { RemoteSessionFileRevision } from "./RemoteSessionWriteGuard";
import type { RemoteSftpBinaryIdentity } from "./RemoteSftpBinary";
import type { RemoteSftpCapabilityCache } from "./RemoteSftpCapabilityCache";
import type { RemoteSftpCapabilityProbe } from "./RemoteSftpCapabilityProbe";
import { runRemoteSftpJob, type RemoteSftpProbe } from "./RemoteSftpAdapter";
import { replaceOneRemoteProjectFile } from "./RemoteProjectUploadJob";
import type { RemoteProjectUploadSession } from "./RemoteProjectUploadTransaction";

/**
 * 远端文本**正文**的唯一搬运层：读一次、写一次，都经 SFTP spool 与本地私有临时文件。
 *
 * 为什么必须这样：正文留在 shell 命令里只能按 3 KiB 分块发（1 MiB 就是 342 条远端命令），
 * 读回来则要先算远端摘要再整份重读。这里把两条路都收敛成「元数据走命令、字节走 SFTP」：
 * - 读：调用方先取 revision 快照（size/digest/身份），这里下载**一次**到 0700 临时目录，
 *   本地算摘要与快照比对，不符即 `REMOTE_FILE_CHANGED`；
 * - 写：本地 0600 临时文件 → SFTP stage → `fs.uploadCommit` 以 `policy: "replace"` 原子替换，
 *   helper 复核 `expected`，目标已变则明确拒绝。
 * 临时目录在 finally 里整块删除；凭证（一次性 token）始终留在 main。
 */

export const REMOTE_PROJECT_TEXT_TRANSFER_CODES = {
	binaryUnavailable: "REMOTE_SFTP_BINARY_UNAVAILABLE",
	commandFailed: "REMOTE_FILE_COMMAND_FAILED",
	commitUnconfirmed: "REMOTE_FILE_COMMIT_UNCONFIRMED",
	changed: "REMOTE_FILE_CHANGED",
	transferInvalid: "REMOTE_FILE_TRANSFER_INVALID",
} as const;

/** 上传事务的拒绝码 → 编辑器稳定码。未列出的码原样透出（仍是闭集里的稳定码）。 */
const REPLACE_FAILURE_CODES: Readonly<Record<string, string>> = {
	FILE_UPLOAD_SOURCE_CHANGED: REMOTE_PROJECT_TEXT_TRANSFER_CODES.changed,
	FILE_UPLOAD_ROOT_CHANGED: REMOTE_PROJECT_TEXT_TRANSFER_CODES.changed,
	FILE_UPLOAD_PATH_INVALID: "REMOTE_FILE_PATH_INVALID",
	FILE_UPLOAD_UNSUPPORTED: "REMOTE_FILE_PLATFORM_UNSUPPORTED",
	REMOTE_UPLOAD_HELPER_UNSUPPORTED: "REMOTE_FILE_PLATFORM_UNSUPPORTED",
	PERMISSION_DENIED: "REMOTE_FILE_PERMISSION_DENIED",
	REMOTE_UPLOAD_COMMIT_UNCONFIRMED: REMOTE_PROJECT_TEXT_TRANSFER_CODES.commitUnconfirmed,
};

export type RemoteProjectTextTransferDeps = {
	readonly binary: () => Promise<RemoteSftpBinaryIdentity | undefined>;
	readonly cache: RemoteSftpCapabilityCache<RemoteSftpProbe>;
	readonly probe: RemoteSftpCapabilityProbe;
	readonly adapter?: typeof runRemoteSftpJob;
};

type TextTarget = { readonly session: RemoteProjectUploadSession; readonly canonicalRoot: string; readonly relative: string };

export type RemoteProjectTextTransfer = {
	/** 下载一次并本地校验；返回的字节一定等于传入的 revision。 */
	download(input: TextTarget & { readonly revision: RemoteSessionFileRevision }): Promise<Buffer>;
	/** 用整份正文原子替换目标；返回替换后的 revision（digest = 实际写入字节的摘要）。 */
	replace(input: TextTarget & { readonly capabilities: readonly string[] | undefined; readonly bytes: Buffer; readonly expected: RemoteSessionFileRevision }): Promise<{ readonly revision: RemoteSessionFileRevision }>;
};

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** 0700 唯一临时目录 + finally 整块删除：崩溃之外的任何路径都不留正文残片。 */
async function withPrivateTempDirectory<T>(work: (directory: string) => Promise<T>): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), "pideck-remote-text-"));
	try {
		return await work(directory);
	} finally {
		await rm(directory, { recursive: true, force: true }).catch(() => undefined);
	}
}

export function createRemoteProjectTextTransfer(deps: RemoteProjectTextTransferDeps): RemoteProjectTextTransfer {
	const adapter = deps.adapter ?? runRemoteSftpJob;
	async function requireBinary(): Promise<RemoteSftpBinaryIdentity> {
		const binary = await deps.binary();
		if (binary === undefined) throw new Error(REMOTE_PROJECT_TEXT_TRANSFER_CODES.binaryUnavailable);
		return binary;
	}
	async function ensureProbe(target: TextTarget, binary: RemoteSftpBinaryIdentity): Promise<void> {
		const probe = await deps.probe.ensureProbe({ canonicalRoot: target.canonicalRoot, binaryPath: binary.path, binaryIdentity: binary.identity, session: target.session, cache: deps.cache });
		if (!probe.ok) throw new Error(probe.code);
	}

	return {
		async download({ session, canonicalRoot, relative, revision }) {
			const binary = await requireBinary();
			await ensureProbe({ session, canonicalRoot, relative }, binary);
			return withPrivateTempDirectory(async (directory) => {
				const localPath = join(directory, "download.bin");
				const result = await session.withSftpInvocation(async (invocation, assertCurrent) => {
					await assertCurrent();
					const value = await adapter(binary.path, { operation: "download", invocation, root: canonicalRoot, relative, localPath });
					await assertCurrent();
					return value;
				});
				if (!result.ok) throw new Error(result.code);
				const bytes = await readFile(localPath);
				// 快照与传输之间远端可能已经变了：摘要不符是冲突，不是「读坏了」。
				if (bytes.length !== revision.size || sha256(bytes) !== revision.digest) throw new Error(REMOTE_PROJECT_TEXT_TRANSFER_CODES.changed);
				if (result.operation !== "download" || result.value.bytes !== bytes.length) throw new Error(REMOTE_PROJECT_TEXT_TRANSFER_CODES.transferInvalid);
				return bytes;
			});
		},
		async replace({ session, canonicalRoot, relative, capabilities, bytes, expected }) {
			const binary = await requireBinary();
			return withPrivateTempDirectory(async (directory) => {
				const localPath = join(directory, "replace.txt");
				await writeFile(localPath, bytes, { mode: 0o600, flag: "wx" });
				try {
					const receipt = await replaceOneRemoteProjectFile({ session, capabilities, canonicalRoot, binaryPath: binary.path, sftp: { binaryIdentity: binary.identity, cache: deps.cache, probe: deps.probe }, relative, localPath, expected }, { adapter });
					if (receipt.sha256 !== sha256(bytes) || receipt.revision.size !== bytes.length) throw new Error(REMOTE_PROJECT_TEXT_TRANSFER_CODES.transferInvalid);
					return { revision: { ...receipt.revision, digest: receipt.sha256 } };
				} catch (error) {
					const code = codeOf(error, REMOTE_PROJECT_TEXT_TRANSFER_CODES.commandFailed);
					throw new Error(REPLACE_FAILURE_CODES[code] ?? code);
				}
			});
		},
	};
}
