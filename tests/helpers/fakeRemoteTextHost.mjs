import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * 远端文本链路的**假宿主**：一个假的 helper 会话 + 一个假 SFTP 执行器，全在本机文件系统上实现
 * 契约语义（prepare 的 policy/expected、commit 的原子替换与回执形状、abort 的 spool 清理）。
 *
 * 为什么不用真 helper：`policy: "replace"` 这条契约与文本链路并行落地，单测不能等远端二进制；
 * 但测试仍必须走**真的** SFTP 编排（probe → withSftpInvocation → stage/download → commit），
 * 所以假的是会话与执行器这两层，不是被测代码。
 */

export const HOST = "11111111-1111-4111-8111-111111111111";
export const BINARY_PATH = process.platform === "win32" ? "C:\\tools\\remote-sftp.exe" : "/opt/pideck/remote-sftp";
export const BINARY_IDENTITY = "sha256:" + "c".repeat(64);
export const INVOCATION = Object.freeze({ executable: "/usr/bin/ssh", args: Object.freeze(["-s", "host", "sftp"]), env: Object.freeze({}) });
export const UPLOAD_CAPABILITIES = Object.freeze(["fs.uploadPrepare", "fs.uploadCommit", "fs.uploadAbort"]);

export function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

/** 与远端快照脚本逐字段同形的身份 + 摘要：这是令牌里那枚 revision 的唯一来源。 */
export async function revisionOf(path) {
	const stats = await lstat(path, { bigint: true });
	const bytes = await readFile(path);
	return { mode: Number(stats.mode & 4095n), size: Number(stats.size), dev: String(stats.dev), ino: String(stats.ino), uid: String(stats.uid), gid: String(stats.gid), mtimeNs: String(stats.mtimeNs), ctimeNs: String(stats.ctimeNs), digest: sha256(bytes) };
}

function identity(revision) {
	const { mode, size, dev, ino, uid, gid, mtimeNs, ctimeNs } = revision;
	return { mode, size, dev, ino, uid, gid, mtimeNs, ctimeNs };
}

function stable(error, fallback) {
	const code = error?.code;
	if (code === "EACCES" || code === "EPERM") return new Error("PERMISSION_DENIED");
	if (code === "ENOENT") return new Error("FILE_UPLOAD_SOURCE_CHANGED");
	return new Error(fallback);
}

export function createFakeTextHost(options) {
	const { root, deployRoot } = options;
	const capabilities = options.capabilities ?? UPLOAD_CAPABILITIES;
	const calls = { abort: [], commit: [], downloads: [], prepare: [], stages: [] };
	const pending = new Map();
	const spool = join(deployRoot, "upload-spool");

	const session = {
		hostId: HOST,
		connectionId: "connection-1",
		hostRevision: 1,
		deployRoot,
		nodePath: process.execPath,
		async request(method, params) {
			if (method === "fs.uploadPrepare") {
				calls.prepare.push(params);
				if (!capabilities.includes(method)) throw new Error("HELPER_METHOD_UNSUPPORTED");
				return prepare(params);
			}
			if (method === "fs.uploadCommit") {
				calls.commit.push(params);
				return commit(params);
			}
			if (method === "fs.uploadAbort") {
				calls.abort.push(params);
				await rm(join(spool, `${params.uploadId}.part`), { force: true });
				pending.delete(params.uploadId);
				return { cleaned: true };
			}
			throw new Error("unexpected method");
		},
		async withSftpInvocation(launch) {
			return launch(INVOCATION, async () => undefined);
		},
	};

	async function prepare(params) {
		const target = join(root, params.path);
		if (params.policy === "create") {
			if (
				await lstat(target).then(
					() => true,
					() => false,
				)
			)
				throw new Error("FILE_UPLOAD_TARGET_EXISTS");
		} else {
			let current;
			try {
				current = await revisionOf(target);
			} catch {
				throw new Error("FILE_UPLOAD_SOURCE_CHANGED");
			}
			if (params.expected === undefined || current.digest !== params.expected.digest || JSON.stringify(identity(current)) !== JSON.stringify(identity(params.expected))) throw new Error("FILE_UPLOAD_SOURCE_CHANGED");
		}
		await mkdir(spool, { recursive: true, mode: 0o700 });
		const token = randomBytes(16).toString("hex");
		pending.set(params.uploadId, { token, path: params.path, size: params.size, sha256: params.sha256, expected: params.expected });
		return { token, stageRef: params.uploadId, expiresAt: Date.now() + 120_000 };
	}

	async function commit(params) {
		const record = pending.get(params.uploadId);
		if (!record || record.token !== params.token) throw new Error("FILE_UPLOAD_TOKEN_INVALID");
		pending.delete(params.uploadId);
		const stagedPath = join(spool, `${params.uploadId}.part`);
		const staged = await readFile(stagedPath).catch(() => undefined);
		await rm(stagedPath, { force: true });
		if (staged === undefined || staged.length !== record.size || sha256(staged) !== record.sha256) throw new Error("FILE_UPLOAD_STAGE_INVALID");
		const target = join(root, record.path);
		if (record.expected !== undefined) {
			const current = await revisionOf(target).catch(() => undefined);
			if (current === undefined || current.digest !== record.expected.digest || JSON.stringify(identity(current)) !== JSON.stringify(identity(record.expected))) throw new Error("FILE_UPLOAD_SOURCE_CHANGED");
		}
		const sibling = join(dirname(target), `.${randomBytes(16).toString("hex")}.pideck-put`);
		try {
			await writeFile(sibling, staged, { mode: 0o600 });
			await chmod(sibling, record.expected?.mode ?? 0o600);
			await rename(sibling, target);
		} catch (error) {
			await rm(sibling, { force: true });
			throw stable(error, "FILE_UPLOAD_STAGE_INVALID");
		}
		if (options.afterPublish !== undefined) {
			await options.afterPublish({ target });
			throw new Error("HELPER_POST_PUBLISH_UNCONFIRMED");
		}
		const after = await revisionOf(target);
		if (after.digest !== record.sha256 || after.size !== record.size) throw new Error("HELPER_POST_PUBLISH_UNCONFIRMED");
		return { committed: true, path: record.path, size: record.size, sha256: record.sha256, revision: identity(after), fsync: true, stageCleaned: true };
	}

	const adapter = async (binaryPath, input) => {
		if (binaryPath !== BINARY_PATH) return { ok: false, code: "SFTP_REQUEST_INVALID" };
		if (input.operation === "stage") {
			calls.stages.push(input);
			await mkdir(spool, { recursive: true, mode: 0o700 });
			const source = await readFile(input.localPath);
			const bytes = options.stageBytes === undefined ? source : await options.stageBytes(source);
			await writeFile(join(deployRoot, input.relative), bytes, { mode: 0o600 });
			return { ok: true, operation: "stage", value: { bytes: bytes.length, sha256: options.stageSha ?? sha256(bytes), fsync: true } };
		}
		if (input.operation === "download") {
			calls.downloads.push(input);
			const bytes = await readFile(join(root, input.relative));
			const written = options.downloadBytes === undefined ? bytes : options.downloadBytes(bytes);
			await writeFile(input.localPath, written, { mode: 0o600 });
			return { ok: true, operation: "download", value: { bytes: written.length, fsync: true, atomicRename: false } };
		}
		return { ok: false, code: "SFTP_REQUEST_INVALID" };
	};

	const probe = {
		async ensureProbe() {
			return options.probeResult ?? { ok: true, value: { protocolVersion: 1, root, extensions: {} } };
		},
	};
	return { adapter, calls, capabilities, probe, session, cache: { clear() {}, get: () => undefined, set: () => undefined } };
}
