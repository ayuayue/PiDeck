import { REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH, REMOTE_SESSION_MAINTAIN_MAX_FILE_BYTES } from "./RemoteHelperContract";
import { quotePosixArgument } from "./RemoteBootstrapContract";
import { remoteSessionHistoryMarker, validateRemoteSessionHistoryPath } from "./RemoteSessionHistoryReader";

/**
 * 快照的摘要上界。它不再是「可改写的文件大小」：写面已改成远端就地维护，本机只为 compare-and-swap
 * 算一次身份与摘要，所以上界与会话维护的文件上界同源；守卫仍拒绝无界读取。
 */
export const REMOTE_SESSION_WRITE_MAX_BYTES = REMOTE_SESSION_MAINTAIN_MAX_FILE_BYTES;
export const REMOTE_SESSION_WRITE_GUARD_CODES = {
	fileChanged: "REMOTE_SESSION_HISTORY_WRITER_FILE_CHANGED",
	fileInvalid: "REMOTE_SESSION_HISTORY_WRITER_FILE_INVALID",
	fileTooLarge: "REMOTE_SESSION_HISTORY_WRITER_FILE_TOO_LARGE",
	transferInvalid: "REMOTE_SESSION_HISTORY_WRITER_TRANSFER_INVALID",
	commandFailed: "REMOTE_SESSION_HISTORY_WRITER_COMMAND_FAILED",
	optionsInvalid: "REMOTE_SESSION_HISTORY_WRITER_OPTIONS_INVALID",
} as const;

/** 不含路径/正文的身份快照；ns 时间与 inode 能识别同长度改写和同内容文件替换。 */
export type RemoteSessionFileRevision = {
	mode: number;
	size: number;
	dev: string;
	ino: string;
	uid: string;
	gid: string;
	mtimeNs: string;
	ctimeNs: string;
	digest: string;
};

/** 固定 Node 文件守卫，不 import pi、不新增 helper op；仅由已验证 Node 经 pinned SSH 执行。 */
const GUARD_SCRIPT = `
const fs = require("node:fs"), crypto = require("node:crypto");
const [action, marker, path, temporary, expectedJson, rawLimit] = process.argv.slice(1);
const limit = Number(rawLimit);
function fail(code, details) { const error = new Error(code); error.details = details; throw error; }
function identity(st) { return { mode: Number(st.mode & 4095n), size: Number(st.size), dev: String(st.dev), ino: String(st.ino), uid: String(st.uid), gid: String(st.gid), mtimeNs: String(st.mtimeNs), ctimeNs: String(st.ctimeNs) }; }
function revision(file) {
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) fail("commandFailed");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const first = fs.fstatSync(fd, { bigint: true });
    if (!first.isFile()) fail("fileInvalid");
    const before = identity(first);
    if (first.size > BigInt(limit)) fail("fileTooLarge", { size: Number(first.size), limit });
    const hash = crypto.createHash("sha256"), buffer = Buffer.alloc(32768);
    let total = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, limit - total + 1), null);
      if (!count) break;
      total += count;
      if (total > limit) fail("fileChanged");
      hash.update(buffer.subarray(0, count));
    }
    const after = identity(fs.fstatSync(fd, { bigint: true }));
    const named = fs.lstatSync(file, { bigint: true });
    if (!named.isFile() || JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(before) !== JSON.stringify(identity(named)) || total !== before.size) fail("fileChanged");
    return { ...before, digest: hash.digest("hex") };
  } finally { fs.closeSync(fd); }
}
let result;
try {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ${REMOTE_SESSION_WRITE_MAX_BYTES}) fail("optionsInvalid");
  if (action === "snapshot") result = { ok: true, revision: revision(path) };
  else if (action === "commit") {
    const expected = JSON.parse(expectedJson);
    const uploaded = revision(temporary);
    if (uploaded.mode !== 384 || uploaded.size !== expected.nextSize || uploaded.digest !== expected.nextDigest) fail("transferInvalid");
    if (uploaded.uid !== expected.source.uid || uploaded.gid !== expected.source.gid) fail("commandFailed");
    let current;
    try { current = revision(path); } catch { fail("fileChanged"); }
    if (JSON.stringify(current) !== JSON.stringify(expected.source)) fail("fileChanged");
    const tempFd = fs.openSync(temporary, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let committed = false;
    try {
      const opened = fs.fstatSync(tempFd, { bigint: true });
      if (String(opened.dev) !== uploaded.dev || String(opened.ino) !== uploaded.ino) fail("transferInvalid");
      fs.fchmodSync(tempFd, expected.source.mode);
      const tempNow = fs.lstatSync(temporary, { bigint: true });
      if (!tempNow.isFile() || String(tempNow.dev) !== uploaded.dev || String(tempNow.ino) !== uploaded.ino) fail("transferInvalid");
      fs.renameSync(temporary, path);
      committed = true;
      result = { ok: true };
    } finally {
      try { if (!committed) fs.fchmodSync(tempFd, 384); } finally { fs.closeSync(tempFd); }
    }
  } else fail("optionsInvalid");
} catch (error) {
  const codes = ["fileChanged", "fileInvalid", "fileTooLarge", "transferInvalid", "commandFailed", "optionsInvalid"];
  result = { ok: false, code: codes.includes(error.message) ? error.message : "commandFailed", ...(error.details ? { details: error.details } : {}) };
}
process.stdout.write(marker + JSON.stringify(result));
`
	.replace(/\s+/g, " ")
	.trim();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function refuse(code: string): never {
	throw new Error(code);
}
/**
 * 标记「这次失败是**输出不可信**」（缺标记 / JSON 撕裂 / 结果形状非法 / 远端 revision 畸形），
 * 而不是「守卫脚本亲自报告了一个确定码」。提交路径必须区分两者：
 * - 确定码（fileChanged/transferInvalid/... 由脚本写在 result 里）⇒ rename 没有发生，报告原码；
 * - 输出不可信 ⇒ 脚本可能已经 rename 后才丢失回执，只能报「结果未确认」（F5）。
 * message 仍是既有稳定码，跨模块/稳定码断言不受影响。
 */
function untrusted(): never {
	const error = new Error(REMOTE_SESSION_WRITE_GUARD_CODES.transferInvalid) as Error & { untrustedOutput?: true };
	error.untrustedOutput = true;
	throw error;
}

/** 只读判据：`true` 表示「输出不可信」（与脚本明确报告的码区分）。 */
export function isRemoteSessionWriteGuardUntrustedOutput(error: unknown): boolean {
	return isRecord(error) && error.untrustedOutput === true;
}
const DIGEST = /^[0-9a-f]{64}$/;
const INTEGER_ID = /^\d{1,40}$/;

/** 严格重建快照，远端多余字段和不可信类型永不进入期望值。 */
export function readRemoteSessionFileRevision(value: unknown, maxBytes = REMOTE_SESSION_WRITE_MAX_BYTES): RemoteSessionFileRevision {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !isRecord(value) || typeof value.mode !== "number" || !Number.isSafeInteger(value.mode) || value.mode < 0 || value.mode > 0o7777 || typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > maxBytes)
		refuse(REMOTE_SESSION_WRITE_GUARD_CODES.transferInvalid);
	const { dev, ino, uid, gid, mtimeNs, ctimeNs, digest } = value;
	if (
		typeof dev !== "string" ||
		!INTEGER_ID.test(dev) ||
		typeof ino !== "string" ||
		!INTEGER_ID.test(ino) ||
		typeof uid !== "string" ||
		!INTEGER_ID.test(uid) ||
		typeof gid !== "string" ||
		!INTEGER_ID.test(gid) ||
		typeof mtimeNs !== "string" ||
		!INTEGER_ID.test(mtimeNs) ||
		typeof ctimeNs !== "string" ||
		!INTEGER_ID.test(ctimeNs) ||
		typeof digest !== "string" ||
		!DIGEST.test(digest)
	)
		refuse(REMOTE_SESSION_WRITE_GUARD_CODES.transferInvalid);
	return { mode: value.mode, size: value.size, dev, ino, uid, gid, mtimeNs, ctimeNs, digest };
}

/** 命令只含固定源码和校验后的 argv，正文不进入 shell；保留既有单命令长度门禁。 */
export function buildRemoteSessionWriteGuardCommand(input: { nodePath: string; remotePath: string; nonce: string; maxBytes: number } & ({ operation: "snapshot" } | { operation: "commit"; temporaryPath: string; source: RemoteSessionFileRevision; nextDigest: string; nextSize: number })): string {
	const nodePath = validateRemoteSessionHistoryPath(input.nodePath);
	const remotePath = validateRemoteSessionHistoryPath(input.remotePath);
	if (!nodePath || nodePath.split("/").at(-1) !== "node" || !remotePath || !/^[A-Za-z0-9]{8,64}$/.test(input.nonce) || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > REMOTE_SESSION_WRITE_MAX_BYTES) refuse(REMOTE_SESSION_WRITE_GUARD_CODES.optionsInvalid);
	let temporary = "",
		expected = "";
	if (input.operation === "commit") {
		const candidate = validateRemoteSessionHistoryPath(input.temporaryPath);
		if (!candidate || !DIGEST.test(input.nextDigest) || !Number.isSafeInteger(input.nextSize) || input.nextSize < 1 || input.nextSize > input.maxBytes || candidate.slice(0, candidate.lastIndexOf("/")) !== remotePath.slice(0, remotePath.lastIndexOf("/")) || !candidate.endsWith(".pideck-tmp") || candidate === remotePath)
			refuse(REMOTE_SESSION_WRITE_GUARD_CODES.optionsInvalid);
		temporary = candidate;
		expected = JSON.stringify({ source: readRemoteSessionFileRevision(input.source), nextDigest: input.nextDigest, nextSize: input.nextSize });
	} else if (input.operation !== "snapshot") refuse(REMOTE_SESSION_WRITE_GUARD_CODES.optionsInvalid);
	const command = [nodePath, "-e", GUARD_SCRIPT, input.operation, remoteSessionHistoryMarker(input.nonce), remotePath, temporary, expected, String(input.maxBytes)].map(quotePosixArgument).join(" ");
	if (command.length > REMOTE_HELPER_MAX_REMOTE_COMMAND_LENGTH) refuse(REMOTE_SESSION_WRITE_GUARD_CODES.optionsInvalid);
	return command;
}

/** 标记后只接受一个 JSON 结果；失败码与体积参数白名单化，不回传 errno/路径/命令。 */
export function parseRemoteSessionWriteGuardResult(stdout: string, marker: string): RemoteSessionFileRevision | undefined {
	const start = stdout.indexOf(marker);
	if (start < 0) untrusted();
	let value: unknown;
	try {
		value = JSON.parse(stdout.slice(start + marker.length));
	} catch {
		untrusted();
	}
	if (!isRecord(value)) untrusted();
	if (value.ok === true) {
		if (value.revision === undefined) return undefined;
		// 远端量到的 revision 形状非法 = 输出不可信，不是脚本报告的码。
		try {
			return readRemoteSessionFileRevision(value.revision);
		} catch {
			untrusted();
		}
	}
	if (value.ok !== false || typeof value.code !== "string" || !(value.code in REMOTE_SESSION_WRITE_GUARD_CODES) || !Object.prototype.hasOwnProperty.call(REMOTE_SESSION_WRITE_GUARD_CODES, value.code)) untrusted();
	const key = value.code;
	const code = Object.entries(REMOTE_SESSION_WRITE_GUARD_CODES).find(([name]) => name === key)?.[1];
	if (!code) untrusted();
	const error = new Error(code);
	if (
		value.code === "fileTooLarge" &&
		isRecord(value.details) &&
		typeof value.details.size === "number" &&
		Number.isSafeInteger(value.details.size) &&
		value.details.size >= 0 &&
		typeof value.details.limit === "number" &&
		Number.isSafeInteger(value.details.limit) &&
		value.details.limit > 0 &&
		value.details.limit <= REMOTE_SESSION_WRITE_MAX_BYTES
	)
		throw Object.assign(error, { details: { size: value.details.size, limit: value.details.limit } });
	throw error;
}
