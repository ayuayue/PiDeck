import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const execute = promisify(execFile);
const POSIX = process.platform === "linux";
const commands = loadTsCommonJs("src/main/remote/RemoteProjectEntryCommands.ts");
const NODE = realpathSync(process.execPath);
const squash = (script) => script.replace(/\s+/g, " ").trim().length;
const TRASH = ".pideck-trash";

/** 一次性 POSIX 临时项目根；所有生产命令都在 /bin/sh -c 里真实执行（与文本保存测试同一 fixture 纪律）。 */
async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "pideck-entry-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return { root };
}

let nonceCounter = 0;
function nextNonce() {
	nonceCounter += 1;
	return nonceCounter.toString(16).padStart(32, "0");
}
function entry(root, command) {
	return commands.buildRemoteProjectEntryCommand({ nodePath: NODE, root, nonce: nextNonce(), command });
}
function trashCommand(root, command) {
	return commands.buildRemoteProjectTrashCommand({ nodePath: NODE, root, nonce: nextNonce(), command });
}
/** 执行生产命令并从 marker 后取唯一一个 JSON（与 main 的解析口径一致）。 */
async function run(built, env) {
	const result = await execute("/bin/sh", ["-c", built.command], { maxBuffer: 4 * 1024 * 1024, ...(env ? { env } : {}) });
	const index = result.stdout.indexOf(built.marker);
	assert.ok(index >= 0, "命令 stdout 必须包含 marker: " + result.stdout.slice(0, 400));
	return JSON.parse(result.stdout.slice(index + built.marker.length));
}
const statEntry = async (root, relative) => run(entry(root, { operation: "stat", relative }));
const createEntry = async (root, parent, name, kind) => run(entry(root, { operation: kind === "file" ? "create-file" : "create-dir", parent, name }));
const renameEntry = async (root, source, target, revision) => run(entry(root, { operation: "rename", source, target, revision }));
const deleteEntry = async (root, relative, revision, trashId) => run(trashCommand(root, { operation: "delete", relative, revision, trashId, deletedAt: "2026-10-17T09:30:12.000Z", expiresAt: "2026-11-16T09:30:12.000Z" }));
const listTrash = async (root) => run(trashCommand(root, { operation: "list" }));
const restoreTrash = async (root, trashId) => run(trashCommand(root, { operation: "restore", trashId }));
const pruneTrash = async (root, trashIds) => run(trashCommand(root, { operation: "prune", trashIds }));

let trashCounter = 0;
function nextTrashId() {
	trashCounter += 1;
	return "20261017T0930" + String(trashCounter % 100).padStart(2, "0") + "Z-" + trashCounter.toString(16).padStart(8, "0");
}
async function deleteForTrash(root, relative) {
	const observed = await statEntry(root, relative);
	assert.equal(observed.ok, true);
	const trashId = nextTrashId();
	const deleted = await deleteEntry(root, relative, observed.revision, trashId);
	return { trashId, deleted, revision: observed.revision };
}

function assertCode(result, code) {
	assert.equal(result.ok, false, JSON.stringify(result));
	assert.equal(result.code, code, JSON.stringify(result));
}

test("frozen script budgets and command shape hold (entry/put/list <=5120; restore/prune <=6100 exception)", { skip: !POSIX }, async (t) => {
	const { root } = await fixture(t);
	const budgets = [
		["REMOTE_PROJECT_ENTRY_SCRIPT", commands.REMOTE_PROJECT_ENTRY_SCRIPT_MAX_CHARS],
		["REMOTE_PROJECT_TRASH_PUT_SCRIPT", commands.REMOTE_PROJECT_ENTRY_SCRIPT_MAX_CHARS],
		["REMOTE_PROJECT_TRASH_LIST_SCRIPT", commands.REMOTE_PROJECT_ENTRY_SCRIPT_MAX_CHARS],
		["REMOTE_PROJECT_TRASH_RESTORE_SCRIPT", commands.REMOTE_PROJECT_TRASH_ADMIN_SCRIPT_MAX_CHARS],
		["REMOTE_PROJECT_TRASH_PRUNE_SCRIPT", commands.REMOTE_PROJECT_TRASH_ADMIN_SCRIPT_MAX_CHARS],
	];
	for (const [name, budget] of budgets) {
		const length = squash(commands[name]);
		assert.ok(length > 0 && length <= budget, name + " squash=" + length + " budget=" + budget);
		assert.ok(length < 8192, name + " must leave room inside the frozen 8192 command budget");
	}
	// argv 全部单引号字面量：空格/引号/中文路径只作为数据参与 execFile("/bin/sh", ["-c", …])，不成为 shell 语法。
	const built = entry(root, { operation: "stat", relative: "quotes ' $ ; 中文.txt" });
	assert.ok(built.command.length <= 8192);
	assert.match(built.marker, /^PIDECK_ENTRY_[a-f0-9]{32}$/);
	assert.ok(built.command.includes("quotes '\\'' $ ; 中文.txt"), "路径必须被 quotePosixArgument 单引号包裹");
	// 最长合法相对路径仍留在 8192 预算内。
	const longRelative = "a".repeat(300) + "/" + "b".repeat(300) + "/file.txt";
	assert.ok(entry(root, { operation: "stat", relative: longRelative }).command.length <= 8192);
});

test("input boundary rejects traversal/absolute/control/reserved names before building a command", { skip: !POSIX }, async (t) => {
	const { root } = await fixture(t);
	for (const relative of ["", "../x", "/etc/passwd", "a//b", "a/./b", "a/../b", "a\\b", "a\nb"]) assert.throws(() => entry(root, { operation: "stat", relative }), /REMOTE_FILE_(PATH|INPUT)_INVALID/);
	for (const relative of [`${TRASH}/x`, ".git/config", ".pi/x"]) assert.throws(() => entry(root, { operation: "stat", relative }), /REMOTE_FILE_PROTECTED_PATH/);
	for (const name of ["", ".", "..", "a/b", "a\\b", "x\ny", TRASH, "x.pideck-tmp", "a".repeat(256)]) assert.throws(() => entry(root, { operation: "create-file", parent: "", name }), /REMOTE_FILE_NAME_INVALID/);
	for (const name of [".git", ".pi"]) assert.throws(() => entry(root, { operation: "create-dir", parent: "", name }), /REMOTE_FILE_PROTECTED_PATH/);
	assert.throws(() => entry(root, { operation: "create-dir", parent: "", name: TRASH }), /REMOTE_FILE_NAME_INVALID/);
	assert.throws(() => entry(root, { operation: "create-file", parent: `.git/x`, name: "a" }), /REMOTE_FILE_PROTECTED_PATH/);
	assert.throws(() => trashCommand(root, { operation: "delete", relative: "a", revision: { mode: 33188, size: 0, dev: "1", ino: "2", uid: "1", gid: "1", mtimeNs: "1", ctimeNs: "1" }, trashId: "bad", deletedAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-01T00:00:00Z" }), /REMOTE_FILE_(INPUT|TRANSFER)_INVALID/);
	assert.throws(() => trashCommand(root, { operation: "prune", trashIds: Array.from({ length: 33 }, () => nextTrashId()) }), /REMOTE_FILE_INPUT_INVALID/);
	const duplicatedId = nextTrashId();
	assert.throws(() => trashCommand(root, { operation: "prune", trashIds: [duplicatedId, duplicatedId] }), /REMOTE_FILE_INPUT_INVALID/);
	assert.throws(() => commands.assertRemoteProjectEntryMove("a", "a/b", "directory"), /REMOTE_FILE_MOVE_INTO_SELF/);
	assert.doesNotThrow(() => commands.assertRemoteProjectEntryMove("a", "a/b", "file"));
	assert.throws(() => commands.assertRemoteProjectEntryMove("a", "a", "file"), /REMOTE_FILE_INPUT_INVALID/);
	const fileRevision = { mode: 420, size: 1, dev: "1", ino: "2", uid: "1", gid: "1", mtimeNs: "1", ctimeNs: "1" };
	assert.throws(() => entry(root, { operation: "rename", source: `${TRASH}/a`, target: "b", revision: fileRevision }), /REMOTE_FILE_PROTECTED_PATH/);
});

test("create-file is create-only, zero bytes, and never creates parents", { skip: !POSIX }, async (t) => {
	const { root } = await fixture(t);
	const made = await createEntry(root, "", "new.txt", "file");
	assert.equal(made.ok, true);
	assert.equal(made.kind, "file");
	assert.equal(made.relativePath, "new.txt");
	const info = await stat(join(root, "new.txt"));
	assert.equal(info.size, 0);
	assert.equal(info.isFile(), true);
	assertCode(await createEntry(root, "", "new.txt", "file"), "REMOTE_FILE_TARGET_EXISTS");
	assertCode(await createEntry(root, "missing", "x.txt", "file"), "REMOTE_FILE_PARENT_NOT_FOUND");
	await writeFile(join(root, "plain"), "x");
	assertCode(await createEntry(root, "plain", "x.txt", "file"), "REMOTE_FILE_PARENT_NOT_DIRECTORY");
	const createdDir = await createEntry(root, "", "dir", "directory");
	assert.equal(createdDir.ok, true);
	assert.equal((await stat(join(root, "dir"))).isDirectory(), true);
	assertCode(await createEntry(root, "", "dir", "directory"), "REMOTE_FILE_TARGET_EXISTS");
	assert.equal(existsSync(join(root, "missing")), false);
});

test("stat classifies entries, rejects symlinks and missing leaves, and returns a binding revision", { skip: !POSIX }, async (t) => {
	const { root } = await fixture(t);
	await writeFile(join(root, "file.txt"), "original\n", { mode: 0o640 });
	await mkdir(join(root, "dir"));
	const file = await statEntry(root, "file.txt");
	assert.equal(file.ok, true);
	assert.equal(file.stat.kind, "file");
	assert.equal(file.stat.bytes, 9);
	assert.ok(file.stat.mtimeMs > 0);
	assert.match(file.revision.dev, /^\d+$/);
	const dir = await statEntry(root, "dir");
	assert.equal(dir.stat.kind, "directory");
	assert.equal(dir.stat.bytes, undefined);
	const outside = await mkdtemp(join(tmpdir(), "pideck-entry-out-"));
	t.after(() => rm(outside, { recursive: true, force: true }));
	await writeFile(join(outside, "secret"), "x");
	await symlink(join(outside, "secret"), join(root, "link"));
	assertCode(await statEntry(root, "link"), "REMOTE_FILE_ENTRY_UNSUPPORTED");
	assertCode(await statEntry(root, "nope"), "REMOTE_FILE_NOT_FOUND");
	await renameFile(join(root, "file.txt"), join(root, "file.old"));
	await symlink(outside, join(root, "file.txt"));
	assertCode(await statEntry(root, "file.txt"), "REMOTE_FILE_ENTRY_UNSUPPORTED");
	await renameFile(join(root, "file.old"), join(root, "file.txt"));
	// 根被替换成软链：每条命令都重新 realpath 校验，不信任旧快照。
	const moved = root + "-moved";
	await renameFile(root, moved);
	t.after(() => rm(moved, { recursive: true, force: true }));
	await symlink(outside, root);
	assertCode(await statEntry(root, "file.txt"), "REMOTE_FILE_PATH_INVALID");
});
async function renameFile(from, to) {
	const { rename } = await import("node:fs/promises");
	await rename(from, to);
}

test("rename/move keeps inode and bytes, refuses overwrite, and reports case-only honestly", { skip: !POSIX }, async (t) => {
	const { root } = await fixture(t);
	await mkdir(join(root, "a"));
	await mkdir(join(root, "b"));
	await writeFile(join(root, "a", "file.txt"), "payload\n", { mode: 0o640 });
	const before = await stat(join(root, "a", "file.txt"));
	const revision = (await statEntry(root, "a/file.txt")).revision;
	const moved = await renameEntry(root, "a/file.txt", "b/moved.txt", revision);
	assert.equal(moved.ok, true);
	assert.equal(moved.relativePath, "b/moved.txt");
	const after = await stat(join(root, "b", "moved.txt"));
	assert.equal(after.ino, before.ino);
	assert.equal(after.mode, before.mode);
	assert.equal(await readFile(join(root, "b", "moved.txt"), "utf8"), "payload\n");
	assert.equal(existsSync(join(root, "a", "file.txt")), false);
	// 目标已存在：link EEXIST ⇒ TARGET_EXISTS，两侧都不动。
	await writeFile(join(root, "a", "other.txt"), "other\n");
	const otherRevision = (await statEntry(root, "a/other.txt")).revision;
	await writeFile(join(root, "b", "existing.txt"), "keep\n");
	assertCode(await renameEntry(root, "a/other.txt", "b/existing.txt", otherRevision), "REMOTE_FILE_TARGET_EXISTS");
	assert.equal(await readFile(join(root, "a", "other.txt"), "utf8"), "other\n");
	assert.equal(await readFile(join(root, "b", "existing.txt"), "utf8"), "keep\n");
	// 源在 stat 后被外部改动 ⇒ CHANGED 且零副作用。
	await writeFile(join(root, "a", "other.txt"), "changed\n");
	assertCode(await renameEntry(root, "a/other.txt", "b/target.txt", otherRevision), "REMOTE_FILE_CHANGED");
	assert.equal(await readFile(join(root, "a", "other.txt"), "utf8"), "changed\n");
	assert.equal(existsSync(join(root, "b", "target.txt")), false);
	// 目录移动：整树移动且 inode 保留。
	await mkdir(join(root, "tree", "inner"), { recursive: true });
	await writeFile(join(root, "tree", "inner", "deep.txt"), "deep\n");
	const treeBefore = await stat(join(root, "tree"));
	const treeRevision = (await statEntry(root, "tree")).revision;
	assert.equal((await renameEntry(root, "tree", "moved-tree", treeRevision)).ok, true);
	assert.equal((await stat(join(root, "moved-tree"))).ino, treeBefore.ino);
	assert.equal(await readFile(join(root, "moved-tree", "inner", "deep.txt"), "utf8"), "deep\n");
	// case-only：Linux 大小写敏感，正常 rename 成功。
	const caseRevision = (await statEntry(root, "b/moved.txt")).revision;
	assert.equal((await renameEntry(root, "b/moved.txt", "b/Moved.txt", caseRevision)).ok, true);
	assert.equal(existsSync(join(root, "b", "moved.txt")), false);
	assert.equal(existsSync(join(root, "b", "Moved.txt")), true);
	// 目标与源是同一 inode 的硬链接：不是 create-only 改名 ⇒ TARGET_EXISTS。
	await writeFile(join(root, "hard-a"), "hard\n");
	const { link } = await import("node:fs/promises");
	await link(join(root, "hard-a"), join(root, "hard-b"));
	// link 会改 inode 的 ctime，因此令牌必须在建立硬链接之后签发；目标与源同 inode ⇒ 非 case-only ⇒ TARGET_EXISTS。
	const hardRevision = (await statEntry(root, "hard-a")).revision;
	assertCode(await renameEntry(root, "hard-a", "hard-b", hardRevision), "REMOTE_FILE_TARGET_EXISTS");
});

test("delete moves the original inode into .pideck-trash with a strict manifest", { skip: !POSIX }, async (t) => {
	const { root } = await fixture(t);
	await mkdir(join(root, "dir"));
	await writeFile(join(root, "dir", "file.txt"), "keep me\n", { mode: 0o640 });
	const before = await stat(join(root, "dir", "file.txt"));
	const { trashId, deleted, revision } = await deleteForTrash(root, "dir/file.txt");
	assert.equal(deleted.ok, true);
	assert.equal(deleted.trashId, trashId);
	const entryDir = join(root, TRASH, trashId);
	const payload = await stat(join(entryDir, "payload"));
	assert.equal(payload.ino, before.ino);
	assert.equal(await readFile(join(entryDir, "payload"), "utf8"), "keep me\n");
	const manifest = JSON.parse(await readFile(join(entryDir, "entry.json"), "utf8"));
	assert.equal(manifest.schemaVersion, 1);
	assert.equal(manifest.id, trashId);
	assert.equal(manifest.originalPath, "dir/file.txt");
	assert.equal(manifest.name, "file.txt");
	assert.equal(manifest.kind, "file");
	assert.equal(manifest.bytes, 8);
	assert.deepEqual(manifest.revision, revision);
	assert.equal((await stat(join(entryDir, "entry.json"))).mode & 0o777, 0o600);
	assert.equal((await stat(join(root, TRASH))).mode & 0o777, 0o700);
	assert.equal(existsSync(join(root, "dir", "file.txt")), false);
	// 目录整树进入回收站。
	await writeFile(join(root, "dir", "a.txt"), "a\n");
	await mkdir(join(root, "dir", "nested"));
	await writeFile(join(root, "dir", "nested", "b.txt"), "b\n");
	const tree = await deleteForTrash(root, "dir");
	assert.equal(tree.deleted.ok, true);
	assert.equal((await stat(join(root, TRASH, tree.trashId, "payload"))).isDirectory(), true);
	assert.equal(existsSync(join(root, "dir")), false);
	// stat 后外部改动 ⇒ CHANGED 且不产生新的回收站条目。
	await writeFile(join(root, "race.txt"), "one\n");
	const race = await statEntry(root, "race.txt");
	await writeFile(join(root, "race.txt"), "two\n");
	const beforeCount = (await readdir(join(root, TRASH))).length;
	assertCode(await deleteEntry(root, "race.txt", race.revision, nextTrashId()), "REMOTE_FILE_CHANGED");
	assert.equal((await readdir(join(root, TRASH))).length, beforeCount);
	assert.equal(await readFile(join(root, "race.txt"), "utf8"), "two\n");
	// 符号链接/特殊文件不可删除。
	await symlink("/etc/hostname", join(root, "symlink"));
	assertCode(await statEntry(root, "symlink"), "REMOTE_FILE_ENTRY_UNSUPPORTED");
	// .pideck-trash 被同名文件占用 ⇒ TRASH_UNAVAILABLE，不回退 unlink。
	const other = await mkdtemp(join(tmpdir(), "pideck-entry-occupied-"));
	t.after(() => rm(other, { recursive: true, force: true }));
	await writeFile(join(other, "file.txt"), "x\n");
	await writeFile(join(other, TRASH), "occupied");
	const otherStat = await statEntry(other, "file.txt");
	assertCode(await deleteEntry(other, "file.txt", otherStat.revision, nextTrashId()), "REMOTE_FILE_TRASH_UNAVAILABLE");
	assert.equal(await readFile(join(other, "file.txt"), "utf8"), "x\n");
});

test("trash list is bounded, hides foreign dirs, reports invalid states, and never creates the trash", { skip: !POSIX }, async (t) => {
	const { root } = await fixture(t);
	assert.deepEqual(await listTrash(root), { ok: true, entries: [], truncated: false });
	assert.equal(existsSync(join(root, TRASH)), false);
	await writeFile(join(root, "keep.txt"), "hello\n");
	const { trashId } = await deleteForTrash(root, "keep.txt");
	const listed = await listTrash(root);
	assert.equal(listed.ok, true);
	assert.equal(listed.truncated, false);
	assert.equal(listed.entries.length, 1);
	assert.equal(listed.entries[0].id, trashId);
	assert.equal(listed.entries[0].raw.originalPath, "keep.txt");
	assert.equal(listed.entries[0].raw.kind, "file");
	assert.equal(listed.entries[0].state, "intact");
	// payload 被外部改写（尺寸变化）⇒ payload-changed；仍如实列出。
	await writeFile(join(root, TRASH, trashId, "payload"), "changed content\n");
	assert.equal((await listTrash(root)).entries[0].state, "payload-changed");
	// 外来目录名忽略；非法 manifest / 未知文件 ⇒ invalid。
	await mkdir(join(root, TRASH, "not-an-id"));
	assert.equal((await listTrash(root)).entries.length, 1);
	const invalidId = nextTrashId();
	await mkdir(join(root, TRASH, invalidId));
	await writeFile(join(root, TRASH, invalidId, "entry.json"), "{broken");
	const invalid = (await listTrash(root)).entries.find((entry) => entry.id === invalidId);
	assert.equal(invalid.state, "invalid");
	assert.equal(invalid.raw, undefined);
	// payload-missing：删掉 payload。
	await writeFile(join(root, "gone.txt"), "gone\n");
	const removed = await deleteForTrash(root, "gone.txt");
	await unlink(join(root, TRASH, removed.trashId, "payload"));
	assert.equal((await listTrash(root)).entries.find((entry) => entry.id === removed.trashId).state, "payload-missing");
});

test("trash list truncates at 256 entries without pretending completeness", { skip: !POSIX }, async (t) => {
	const { root } = await fixture(t);
	await mkdir(join(root, TRASH), { recursive: true, mode: 0o700 });
	for (let index = 0; index < 257; index += 1) await mkdir(join(root, TRASH, nextTrashId()));
	const listed = await listTrash(root);
	assert.equal(listed.ok, true);
	assert.equal(listed.truncated, true);
	assert.ok(listed.entries.length <= 256);
	assert.ok(JSON.stringify(listed.entries).length <= 64 * 1024);
});

test("restore returns files/directories byte-identically and refuses unsafe targets", { skip: !POSIX }, async (t) => {
	const { root } = await fixture(t);
	await writeFile(join(root, "file.txt"), "restore me\n", { mode: 0o640 });
	const fileBefore = await stat(join(root, "file.txt"));
	const fileDelete = await deleteForTrash(root, "file.txt");
	const restored = await restoreTrash(root, fileDelete.trashId);
	assert.equal(restored.ok, true);
	assert.equal(restored.relativePath, "file.txt");
	const fileAfter = await stat(join(root, "file.txt"));
	assert.equal(fileAfter.ino, fileBefore.ino);
	assert.equal(fileAfter.mode, fileBefore.mode);
	assert.equal(await readFile(join(root, "file.txt"), "utf8"), "restore me\n");
	assert.equal(existsSync(join(root, TRASH, fileDelete.trashId)), false);
	// 目录整树还原。
	await mkdir(join(root, "tree", "inner"), { recursive: true });
	await writeFile(join(root, "tree", "inner", "a.txt"), "tree\n");
	const treeDelete = await deleteForTrash(root, "tree");
	assert.equal((await restoreTrash(root, treeDelete.trashId)).ok, true);
	assert.equal(await readFile(join(root, "tree", "inner", "a.txt"), "utf8"), "tree\n");
	// 目标已存在 ⇒ TARGET_EXISTS，回收站条目保持原样。
	const conflictDelete = await deleteForTrash(root, "file.txt");
	await writeFile(join(root, "file.txt"), "occupied\n");
	assertCode(await restoreTrash(root, conflictDelete.trashId), "REMOTE_FILE_TARGET_EXISTS");
	assert.equal(await readFile(join(root, "file.txt"), "utf8"), "occupied\n");
	assert.equal((await stat(join(root, TRASH, conflictDelete.trashId, "payload"))).isFile(), true);
	// 父目录缺失 ⇒ PARENT_NOT_FOUND。
	await mkdir(join(root, "dir2"));
	await writeFile(join(root, "dir2", "b.txt"), "b\n");
	const parentDelete = await deleteForTrash(root, "dir2/b.txt");
	await rm(join(root, "dir2"), { recursive: true, force: true });
	assertCode(await restoreTrash(root, parentDelete.trashId), "REMOTE_FILE_PARENT_NOT_FOUND");
	// 身份失配（payload 被更大内容替换）⇒ TRASH_ENTRY_INVALID。
	const tamperedDelete = await deleteForTrash(root, "file.txt");
	await writeFile(join(root, TRASH, tamperedDelete.trashId, "payload"), "much longer content\n");
	assertCode(await restoreTrash(root, tamperedDelete.trashId), "REMOTE_FILE_TRASH_ENTRY_INVALID");
	assertCode(await restoreTrash(root, "20261017T093012Z-deadbeef"), "REMOTE_FILE_TRASH_ENTRY_NOT_FOUND");
});

test("prune deletes only recoverable states, keeps invalid entries, and enforces bounded walks", { skip: !POSIX }, async (t) => {
	const { root } = await fixture(t);
	await writeFile(join(root, "a.txt"), "a\n");
	const a = await deleteForTrash(root, "a.txt");
	await writeFile(join(root, "b.txt"), "b\n");
	const b = await deleteForTrash(root, "b.txt");
	await unlink(join(root, TRASH, b.trashId, "payload"));
	const invalidId = nextTrashId();
	await mkdir(join(root, TRASH, invalidId));
	const result = await pruneTrash(root, [a.trashId, b.trashId, invalidId, "20261017T093012Z-deadbeef"]);
	assert.equal(result.ok, true);
	assert.deepEqual([...result.removed].sort(), [a.trashId, b.trashId].sort());
	const keptIds = result.kept.map((entry) => entry.id);
	assert.ok(keptIds.includes(invalidId));
	assert.ok(keptIds.includes("20261017T093012Z-deadbeef"));
	assert.equal(result.kept.find((entry) => entry.id === invalidId).code, "REMOTE_FILE_TRASH_ENTRY_INVALID");
	assert.equal(result.kept.find((entry) => entry.id.endsWith("deadbeef")).code, "REMOTE_FILE_TRASH_ENTRY_NOT_FOUND");
	assert.equal(existsSync(join(root, TRASH, a.trashId)), false);
	assert.equal(existsSync(join(root, TRASH, b.trashId)), false);
	assert.equal(existsSync(join(root, TRASH, invalidId)), true);
	// payload 目录超过深度上限：拒绝删除且条目仍在。
	await mkdir(join(root, "deep"), { recursive: true });
	let current = join(root, "deep");
	for (let depth = 0; depth < 34; depth += 1) {
		current = join(current, "d" + depth);
		await mkdir(current);
	}
	const deepDelete = await deleteForTrash(root, "deep");
	const limited = await pruneTrash(root, [deepDelete.trashId]);
	assert.equal(limited.ok, true);
	assert.equal(limited.kept[0].code, "REMOTE_FILE_ENTRY_LIMIT");
	assert.equal(existsSync(join(root, TRASH, deepDelete.trashId, "payload")), true);
});

test("mutable-path guard refuses the project root itself, in any call order", () => {
	// 根路径不是「条目」：不论调用方有没有先跑 validate，这个断言都必须拒绝它。
	for (const value of ["", "/", "//", "a/", "/a", "a//b"]) {
		assert.throws(() => commands.assertRemoteProjectEntryMutablePath(value), /REMOTE_FILE_PROTECTED_PATH/, "mutable-path 必须拒绝 " + JSON.stringify(value));
		assert.throws(() => commands.validateRemoteProjectEntryPath(value), /REMOTE_FILE_(PATH_INVALID|INPUT_INVALID|PROTECTED_PATH)/, "validate 必须拒绝 " + JSON.stringify(value));
	}
	assert.doesNotThrow(() => commands.assertRemoteProjectEntryMutablePath("docs/notes.txt"));
	assert.throws(() => commands.assertRemoteProjectEntryMutablePath(".pideck-trash/x"), /REMOTE_FILE_PROTECTED_PATH/);
	assert.throws(() => commands.assertRemoteProjectEntryMutablePath(".git/config"), /REMOTE_FILE_PROTECTED_PATH/);
});

test("permission denial fails closed without retry or silent fallback", { skip: !POSIX || process.getuid?.() === 0 }, async (t) => {
	const { root } = await fixture(t);
	await writeFile(join(root, "keep.txt"), "keep\n");
	const observed = await statEntry(root, "keep.txt");
	await chmod(root, 0o500);
	try {
		assertCode(await createEntry(root, "", "new.txt", "file"), "REMOTE_FILE_PERMISSION_DENIED");
		assertCode(await deleteEntry(root, "keep.txt", observed.revision, nextTrashId()), "REMOTE_FILE_TRASH_UNAVAILABLE");
	} finally {
		await chmod(root, 0o700);
	}
	assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "keep\n");
	assert.equal(existsSync(join(root, "new.txt")), false);
	assert.equal(existsSync(join(root, TRASH)), false);
});
