/**
 * 本机可还原丢弃（本地版 G4b）：语义对齐 `src/main/remote/RemoteGitWriteSource.ts` 的
 * `createGitRecoveryProgram`——丢弃前的字节进对象库，快照 commit 挂在
 * `refs/pideck/recovery/<stamp>`；list 只读，restore 把字节写回，drop 是带旧 oid 的 CAS 删除。
 *
 * 一个快照 commit 的 tree 里**恰好一个文件**：就是那次丢弃要覆盖/删除的那一份内容。
 * 于是「还原」= 把这一份字节写回同一路径，别的文件一个都不动（不做拿快照 commit  checkout 全树这种会
 * 连带覆盖其它文件的动作）。
 */
import { randomBytes } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { GitRecoveryListing } from "../../shared/types";
import { execGit, runGitCommand } from "./gitRun";

/** 与远端 helper 同名的上限：单文件快照/还原 8 MiB，列表最多 64 条。 */
export const RECOVERY_MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_LISTED = 64;
const GIT_TIMEOUT_MS = 30_000;
const RECOVERY_REF_RE = /^refs\/pideck\/recovery\/[A-Za-z0-9._-]+$/;
const OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/**
 * commit-tree 必须有作者身份；这里用 `-c` 临时注入而不是读写任何配置——
 * 仓库没配 user.name 时丢弃仍能拿到快照，且不改动用户的 git 配置。
 */
const RECOVERY_IDENTITY = ["-c", "user.name=PiDeck Recovery", "-c", "user.email=pideck@localhost"];
/** `git unpack-file` 在仓库根写入的临时名（`.merge_file_XXXXXX`）；只认这个名字，绝不移动别的文件。 */
const UNPACKED_FILE_RE = /^\.merge_file_[A-Za-z0-9]{6}$/;

export type RecoverySnapshot = { ref: string; oid: string; path: string; bytes: number };
export type RecoveryEntryRef = { ref: string; oid: string; path: string };
export type RecoveryEntryKey = { ref: string; oid: string };

type SnapshotFile = { mode: string; blob: string; path: string; bytes: number };

function fail(message: string): Error {
	return new Error(message);
}

function git(repoRoot: string, args: string[], maxBuffer = 64 * 1024) {
	return execGit(args, { cwd: repoRoot, maxBuffer, timeoutMs: GIT_TIMEOUT_MS });
}

/** `refs/pideck/recovery/<UTC 秒级时戳>-<8 hex>`：同秒内也不会撞名，撞名由调用方换戳重试。 */
function stamp(): string {
	return (
		new Date()
			.toISOString()
			.replace(/[-:TZ.]/g, "")
			.slice(0, 14) +
		"-" +
		randomBytes(4).toString("hex")
	);
}

function requireRecoveryRef(value: string): string {
	if (typeof value !== "string" || !RECOVERY_REF_RE.test(value)) throw fail("Only refs/pideck/recovery/* can be listed, restored or dropped");
	return value;
}

/** 快照里的路径一律是仓库内 POSIX 相对路径：绝对路径、盘符、反斜杠、`..` 一律拒绝。 */
function requireRepoRelativePath(value: string): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 32_768 || value.includes("\0")) throw fail("Invalid Git recovery path");
	if (value.includes("\\") || isAbsolute(value) || /^[A-Za-z]:/.test(value)) throw fail("Invalid Git recovery path");
	const segments = value.split("/");
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) throw fail("Invalid Git recovery path");
	return value;
}

/** 乐观路径校验之后的第二道门：用 realpath 确认文件确实在仓库内（软链/大小写/短路径都由此收敛）。 */
async function repoRelativePath(repoRoot: string, absolutePath: string): Promise<string> {
	const [root, target] = await Promise.all([realpath(repoRoot), realpath(absolutePath)]);
	const scoped = relative(root, target);
	if (scoped.length === 0 || scoped === ".." || scoped.startsWith(`..${sep}`) || isAbsolute(scoped)) throw fail("Only files inside the repository can be snapshotted");
	return scoped.split(sep).join("/");
}

/** `ls-tree -l -r -z <commit>` → 唯一那个文件（mode / blob / 路径 / 字节数）。 */
async function readSnapshotFile(repoRoot: string, treeish: string): Promise<SnapshotFile> {
	const { stdout } = await git(repoRoot, ["ls-tree", "-l", "-r", "-z", treeish], 65536);
	const records = stdout.split("\0").filter((record) => record.length > 0);
	if (records.length !== 1) throw fail("A Git recovery snapshot holds exactly one file");
	const record = records[0]!;
	const tab = record.indexOf("\t");
	const meta = (tab < 0 ? "" : record.slice(0, tab)).trim().split(/\s+/);
	const path = tab < 0 ? "" : record.slice(tab + 1);
	if (meta.length !== 4 || (meta[0] !== "100644" && meta[0] !== "100755") || meta[1] !== "blob" || !OBJECT_ID_RE.test(meta[2]!) || !/^\d+$/.test(meta[3]!) || path.length === 0) {
		throw fail("Invalid Git recovery snapshot entry");
	}
	return { mode: meta[0], blob: meta[2]!, path, bytes: Number(meta[3]) };
}

/**
 * 由单文件 blob 生成只含该文件的 tree。`mktree` 只建一层，所以多级路径要从最深的一段往上逐层合成父 tree。
 */
async function writeSnapshotTree(repoRoot: string, repoRelative: string, mode: string, blob: string): Promise<string> {
	const segments = repoRelative.split("/");
	let tree = "";
	for (let depth = segments.length - 1; depth >= 0; depth -= 1) {
		const name = segments[depth]!;
		const record = depth === segments.length - 1 ? `${mode} blob ${blob}\t${name}` : `040000 tree ${tree}\t${name}`;
		const written = (await runGitCommand(["mktree", "-z"], { cwd: repoRoot, input: record + "\0", timeoutMs: GIT_TIMEOUT_MS, maxBuffer: 4096 })).stdout.trim();
		if (!OBJECT_ID_RE.test(written)) throw fail(`Cannot discard ${repoRelative}: Git did not store the snapshot tree`);
		tree = written;
	}
	return tree;
}

/**
 * 丢弃前的快照：把 `absolutePath` 当前的字节写进对象库，再挂一条只含该文件的只读快照。
 *
 * @returns 快照标识；文件已不存在（如工作区删除 ` D`）时返回 null——没有字节可保留，丢弃只会重建 index 版本。
 * @throws 文件超过 8 MiB 或写不进对象库时抛错，调用方必须在**动文件之前**把它上抛：
 *         宁可直接失败也不做「没快照的丢弃」——那等于静默丢数据。
 */
/**
 * 批量丢弃前的快照：先把每一份都写进去，任何一份失败就在这里抛出——调用方因此还一个字节都没动。
 * 符号链接跳过：未跟踪链接的丢弃只 unlink 链接自身，目标内容不在丢失范围内。
 */
export async function snapshotRecoveryFiles(repoRoot: string, paths: readonly string[]): Promise<void> {
	const { lstat } = await import("node:fs/promises");
	for (const filePath of paths) {
		const metadata = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return null;
			throw error;
		});
		if (metadata === null || metadata.isSymbolicLink()) continue;
		await snapshotRecoveryFile(repoRoot, filePath);
	}
}

export async function snapshotRecoveryFile(repoRoot: string, absolutePath: string): Promise<RecoverySnapshot | null> {
	const metadata = await lstat(absolutePath).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	if (metadata === null) return null;
	const repoRelative = await repoRelativePath(repoRoot, absolutePath);
	/* 只快照普通文件：
	   - 目录 / 子模块（gitlink）不是本仓库里的字节，`git restore` 丢不掉这里的内容；
	   - 符号链接的指向存在 index/HEAD 里，跟踪链接由 `git restore` 从 index 重建；未跟踪链接的丢弃在
	     discardFile 里只 unlink 链接自身（目标内容不受影响）。
	   两者都没有「被覆盖后找不回来」的字节，所以返回 null，而不是把它们当异常拒掉（否则子模块无法丢弃）。 */
	if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
	if (metadata.size > RECOVERY_MAX_FILE_BYTES) {
		throw fail(`Cannot discard ${repoRelative}: ${metadata.size} bytes exceeds the ${RECOVERY_MAX_FILE_BYTES}-byte recovery snapshot limit`);
	}
	const mode = (metadata.mode & 0o111) === 0 ? "100644" : "100755";
	/* 读字节交给 git 自己（hash-object 直接读文件、--no-filters 禁掉 clean 过滤器）：
	   runGitCommand 的 stdin 是 JS 字符串、按 UTF-8 写入，二进制/非 UTF-8 内容经 stdin 会被替换成 U+FFFD，
	   那样存进对象库的就已经不是用户的字节了。 */
	const blob = (await git(repoRoot, ["hash-object", "-w", "--no-filters", "--", absolutePath], 4096)).stdout.trim();
	if (!OBJECT_ID_RE.test(blob)) throw fail(`Cannot discard ${repoRelative}: Git did not store the snapshot content`);
	const tree = await writeSnapshotTree(repoRoot, repoRelative, mode, blob);
	const commit = (await runGitCommand([...RECOVERY_IDENTITY, "commit-tree", tree, "-m", `discard: ${repoRelative}`], { cwd: repoRoot, timeoutMs: GIT_TIMEOUT_MS, maxBuffer: 4096 })).stdout.trim();
	if (!OBJECT_ID_RE.test(commit)) throw fail(`Cannot discard ${repoRelative}: Git did not create the snapshot commit`);
	let failure: unknown = null;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const ref = "refs/pideck/recovery/" + stamp();
		try {
			/* 空旧值 = 只允许创建：ref 名被占用时 git 拒绝，换一个新戳重试，绝不覆盖已有的快照。 */
			await git(repoRoot, ["update-ref", "-m", `discard: ${repoRelative}`, ref, commit, ""], 4096);
			return { ref, oid: commit, path: repoRelative, bytes: metadata.size };
		} catch (error) {
			failure = error;
		}
	}
	throw failure instanceof Error ? failure : fail(`Cannot discard ${repoRelative}: no recovery reference could be created`);
}

/**
 * 只读列举：一次 `for-each-ref` 拿 ref/commit/时间，再逐个 `ls-tree -l` 拿那唯一文件的路径与字节数。
 * 不是我们写的那一份（多个文件、坏对象、超大）一律跳过，既不展示错路径也不误报字节数。
 */
export async function listRecovery(repoRoot: string): Promise<GitRecoveryListing> {
	const { stdout } = await git(repoRoot, ["for-each-ref", "--sort=-creatordate", "--format=%(refname)%09%(objectname)%09%(creatordate:unix)", "refs/pideck/recovery"], 1024 * 1024);
	const rows = stdout
		.split("\n")
		.map((line) => line.split("\t"))
		.filter((fields) => fields.length === 3 && RECOVERY_REF_RE.test(fields[0]!) && OBJECT_ID_RE.test(fields[1]!) && /^\d+$/.test(fields[2]!));
	const entries: GitRecoveryListing["entries"] = [];
	for (const [ref, oid, seconds] of rows.slice(0, MAX_LISTED)) {
		const file = await readSnapshotFile(repoRoot, oid!).catch(() => null);
		if (file === null || file.bytes > RECOVERY_MAX_FILE_BYTES) continue;
		entries.push({ ref: ref!, oid: oid!, path: file.path, bytes: file.bytes, at: Number(seconds) * 1000 });
	}
	return { entries, truncated: rows.length > MAX_LISTED };
}

/** `git unpack-file` 把 blob 原样写进仓库根下的临时文件（不经 smudge/eol 过滤器）并回显文件名。 */
async function unpackBlob(repoRoot: string, blob: string): Promise<string> {
	const { stdout } = await runGitCommand(["unpack-file", blob], { cwd: repoRoot, timeoutMs: GIT_TIMEOUT_MS, maxBuffer: 4096 });
	const name = stdout.trim();
	if (!UNPACKED_FILE_RE.test(name)) throw fail("Git did not report an unpacked recovery file");
	return resolve(repoRoot, name);
}

/**
 * 目标已存在时的覆盖判定：只有「没有更新的用户内容」才写。
 * - 跟踪文件：工作区必须与 index 一致（丢弃后的正常状态）；用户又改过 → 拒绝。
 * - 不在 index 里的路径（未跟踪快照）：内容必须与快照完全相同，否则视为别人/后来的文件 → 拒绝。
 * 不存在的目标直接写（父目录按需创建）。
 */
async function assertRestorable(repoRoot: string, absolute: string, target: string, file: SnapshotFile): Promise<void> {
	const metadata = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	if (metadata === null) return;
	if (!metadata.isFile() || metadata.isSymbolicLink()) throw fail("A directory or link already occupies the recovery target path");
	const tracked = await execGit(["cat-file", "-e", `:${target}`], { cwd: repoRoot, timeoutMs: GIT_TIMEOUT_MS, maxBuffer: 4096 })
		.then(() => true)
		.catch(() => false);
	if (tracked) {
		const clean = await execGit(["diff", "--quiet", "--no-ext-diff", "--no-textconv", "--", target], { cwd: repoRoot, timeoutMs: GIT_TIMEOUT_MS, maxBuffer: 4096 })
			.then(() => true)
			.catch(() => false);
		if (!clean) throw fail("The file has changes made after the discard; restoring would overwrite them");
		return;
	}
	const current = (await git(repoRoot, ["hash-object", "--no-filters", "--", absolute], 4096)).stdout.trim();
	if (current !== file.blob) throw fail("A different file now occupies the recovery target path");
}

/**
 * 还原一份快照：校验 ref 前缀、oid 形态、路径在仓库内，再把 blob 字节写回该路径（父目录按需创建）。
 * 返回实际写入的字节数。落盘后让 git 重新哈希一遍回读，字节不一致即视为失败。
 */
export async function restoreRecovery(repoRoot: string, entry: RecoveryEntryRef): Promise<{ path: string; bytes: number }> {
	const ref = requireRecoveryRef(entry.ref);
	if (typeof entry.oid !== "string" || !OBJECT_ID_RE.test(entry.oid)) throw fail("Invalid Git recovery entry");
	const target = requireRepoRelativePath(entry.path);
	const commit = await git(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], 4096)
		.then((result) => result.stdout.trim())
		.catch(() => "");
	if (commit !== entry.oid) throw fail("This Git recovery snapshot is no longer available");
	const file = await readSnapshotFile(repoRoot, commit);
	if (file.path !== target) throw fail("This Git recovery snapshot does not hold that path");
	if (file.bytes > RECOVERY_MAX_FILE_BYTES) throw fail("This Git recovery snapshot is too large to restore");
	const absolute = resolve(repoRoot, target);
	await assertRestorable(repoRoot, absolute, target, file);
	const temporary = await unpackBlob(repoRoot, file.blob);
	let moved = false;
	try {
		const metadata = await lstat(temporary);
		if (!metadata.isFile() || metadata.size !== file.bytes) throw fail("Git did not unpack the recovery snapshot");
		await mkdir(dirname(absolute), { recursive: true });
		try {
			await rename(temporary, absolute);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
			// 目标与仓库不在同一文件系统时才退化成复制（临时文件仍然删除）。
			await copyFile(temporary, absolute);
			await rm(temporary, { force: true });
		}
		moved = true;
		await chmod(absolute, file.mode === "100755" ? 0o755 : 0o644);
	} finally {
		if (!moved) await rm(temporary, { force: true }).catch(() => undefined);
	}
	// 回读校验：让 git 重新哈希已落盘的文件，必须与快照 blob 相同（等于逐字节比较，且不经过字符串解码）。
	const written = (await git(repoRoot, ["hash-object", "--no-filters", "--", absolute], 4096)).stdout.trim();
	if (written !== file.blob) throw fail("The restored file does not match the recovery snapshot");
	return { path: target, bytes: file.bytes };
}

/** CAS 删除：`update-ref -d <ref> <旧 oid>`，ref 已指向别的 commit 或已消失时拒绝，绝不顺手删掉另一份快照。 */
export async function dropRecovery(repoRoot: string, entry: RecoveryEntryKey): Promise<void> {
	const ref = requireRecoveryRef(entry.ref);
	if (typeof entry.oid !== "string" || !OBJECT_ID_RE.test(entry.oid)) throw fail("Invalid Git recovery entry");
	try {
		await git(repoRoot, ["update-ref", "-d", ref, entry.oid], 4096);
	} catch (error) {
		const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
		throw fail(`This Git recovery snapshot no longer matches; nothing was deleted (${detail})`);
	}
	const remaining = await git(repoRoot, ["rev-parse", "--verify", "--quiet", ref], 4096)
		.then((result) => result.stdout.trim())
		.catch(() => "");
	if (remaining === entry.oid) throw fail("The Git recovery snapshot was not deleted");
}
