import { mkdtempSync } from "./helpers/tempDir.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

/**
 * 本机可还原丢弃（`refs/pideck/recovery/*`）：丢弃先写快照，之后能列出/还原/删除。
 * 全部用例跑真实临时 git 仓库 + 真实 GitService，断言用原生 git 复核——
 * 「还能拿回来」这句话必须逐字节成立（含二进制、含 CRLF）。
 */

const require = createRequire(import.meta.url);
const buildDir = mkdtempSync(join(tmpdir(), "pideck-git-recovery-build-"));
const MAX_BYTES = 8 * 1024 * 1024;
let GitService;
let listRecovery, restoreRecovery, dropRecovery;

/** 一个只有 baseline 提交的仓库；git() 用原生 git 复核产品写下的东西。 */
function repository(files = { "a.txt": "base\n", "sub/dir/nested.txt": "nested base\n" }) {
	const root = mkdtempSync(join(tmpdir(), "pideck-git-recovery-repo-"));
	const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "-q");
	git("config", "core.autocrlf", "false");
	git("config", "user.name", "PiDeck Test");
	git("config", "user.email", "test@example.com");
	for (const [path, content] of Object.entries(files)) write(path, content);
	git("add", "--", ".");
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "baseline");
	function write(relativePath, content) {
		const absolute = join(root, relativePath);
		mkdirSync(resolve(absolute, ".."), { recursive: true });
		writeFileSync(absolute, content);
	}
	return { root, git, write, path: (relativePath) => join(root, relativePath) };
}

const recoveryRefs = (f) =>
	f
		.git("for-each-ref", "--format=%(refname)", "refs/pideck/recovery")
		.split("\n")
		.filter((name) => name.length > 0);
const leftovers = (f) => readdirSync(f.root).filter((name) => name.startsWith(".merge_file_"));

before(() => {
	// GitService 的依赖链本地 import 带 .ts 扩展名（Node type stripping 直跑测试的约定），
	// CLI tsc 需在 emit 时重写为 .js；LocalGitRecovery 经 GitService 一起编译。
	execFileSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "src/main/git/GitService.ts", "src/shared/types.ts", "--module", "commonjs", "--target", "es2022", "--moduleResolution", "node", "--esModuleInterop", "--skipLibCheck", "--rewriteRelativeImportExtensions", "--outDir", buildDir], {
		cwd: resolve("."),
		stdio: "pipe",
	});
	// ../fs/trash 懒加载 electron.shell.trashItem：这里让它真的把文件移走，才能断言「丢弃后文件不见了」。
	const stubElectronDir = join(buildDir, "node_modules", "electron");
	mkdirSync(stubElectronDir, { recursive: true });
	writeFileSync(join(stubElectronDir, "package.json"), JSON.stringify({ name: "electron", main: "index.js" }));
	writeFileSync(join(stubElectronDir, "index.js"), `const fs = require("node:fs"); exports.shell = { trashItem: async (path) => fs.unlinkSync(path) };`);
	({ GitService } = require(join(buildDir, "main/git/GitService.js")));
	// 恢复区三个动作由模块直接导出（gitIpc 也这么接）；GitService 只负责 discard 前的快照。
	({ listRecovery, restoreRecovery, dropRecovery } = require(join(buildDir, "main/git/LocalGitRecovery.js")));
});

after(() => {
	// 临时目录由 helpers/tempDir.mjs 在退出时回收（含失败早退）。
});

describe("discard then recovery list", () => {
	test("a discarded worktree change is snapshotted with its path, size and time", async () => {
		const f = repository();
		f.write("a.txt", "my uncommitted work\n");
		const svc = new GitService();
		await svc.discardFile(f.root, "workingTree", f.path("a.txt"));
		assert.equal(readFileSync(f.path("a.txt"), "utf8"), "base\n", "discard still restores the index version");

		const listing = await listRecovery(f.root);
		assert.equal(listing.truncated, false);
		assert.equal(listing.entries.length, 1);
		const entry = listing.entries[0];
		assert.match(entry.ref, /^refs\/pideck\/recovery\/[A-Za-z0-9._-]+$/);
		assert.equal(entry.path, "a.txt");
		assert.equal(entry.bytes, Buffer.byteLength("my uncommitted work\n"));
		assert.ok(Number.isSafeInteger(entry.at) && entry.at > 1_600_000_000_000, `millisecond commit time, got ${entry.at}`);
		assert.equal(f.git("rev-parse", entry.ref), entry.oid);
		assert.equal(f.git("status", "--porcelain=v1"), "", "listing/discard leave no pending change behind");
		assert.deepEqual(recoveryRefs(f).length, 1);
	});

	test("a file already deleted in the worktree needs no snapshot and still comes back", async () => {
		const f = repository();
		unlinkSync(f.path("a.txt"));
		const svc = new GitService();
		await svc.discardFile(f.root, "workingTree", f.path("a.txt"));
		assert.equal(readFileSync(f.path("a.txt"), "utf8"), "base\n", "restore of a deleted resource recreates it");
		assert.deepEqual((await listRecovery(f.root)).entries, [], "nothing to preserve, nothing listed");
		assert.deepEqual(recoveryRefs(f), []);
	});

	test("a directory batch snapshots every file before touching the working tree", async () => {
		const f = repository();
		f.write("a.txt", "batch tracked\n");
		f.write("sub/dir/nested.txt", "batch nested\n");
		f.write("fresh.txt", "batch untracked\n");
		const svc = new GitService();
		await svc.discardFiles(f.root, [
			{ group: "workingTree", path: f.path("a.txt") },
			{ group: "workingTree", path: f.path("sub/dir/nested.txt") },
			{ group: "untracked", path: f.path("fresh.txt") },
		]);
		assert.equal(readFileSync(f.path("a.txt"), "utf8"), "base\n");
		assert.equal(readFileSync(f.path("sub/dir/nested.txt"), "utf8"), "nested base\n");
		assert.equal(existsSync(f.path("fresh.txt")), false, "untracked discard still removes the file");

		const paths = (await listRecovery(f.root)).entries.map((entry) => entry.path).sort();
		assert.deepEqual(paths, ["a.txt", "fresh.txt", "sub/dir/nested.txt"]);
	});
});

describe("restore", () => {
	test("restoring writes the discarded bytes back and keeps the snapshot", async () => {
		const f = repository();
		f.write("sub/dir/nested.txt", "my nested work\r\nsecond\r\n");
		const svc = new GitService();
		await svc.discardFile(f.root, "workingTree", f.path("sub/dir/nested.txt"));
		const entry = (await listRecovery(f.root)).entries[0];

		const restored = await restoreRecovery(f.root, entry);
		assert.deepEqual(restored, { path: "sub/dir/nested.txt", bytes: Buffer.byteLength("my nested work\r\nsecond\r\n") });
		assert.equal(readFileSync(f.path("sub/dir/nested.txt"), "utf8"), "my nested work\r\nsecond\r\n");
		assert.equal(f.git("status", "--porcelain=v1"), "M sub/dir/nested.txt", "git sees the restored bytes as a modification again");
		assert.equal((await listRecovery(f.root)).entries.length, 1, "restore is not a delete");
		assert.deepEqual(leftovers(f), [], "the unpacked temporary file is cleaned up");
	});

	test("binary bytes survive the round trip unchanged", async () => {
		const f = repository();
		const bytes = Buffer.from([0x00, 0xff, 0xfe, 0x01, 0x00, 0x80, 0x7f, 0x0a, 0xc3, 0x28]);
		writeFileSync(f.path("a.txt"), bytes);
		const svc = new GitService();
		await svc.discardFile(f.root, "workingTree", f.path("a.txt"));
		assert.deepEqual(readFileSync(f.path("a.txt")), Buffer.from("base\n"));
		const entry = (await listRecovery(f.root)).entries[0];
		assert.equal(entry.bytes, bytes.length);
		await restoreRecovery(f.root, entry);
		assert.deepEqual(readFileSync(f.path("a.txt")), bytes);
	});

	test("an untracked discard is restorable, recreating its parent directories", async () => {
		const f = repository();
		f.write("fresh/dir/file.txt", "untracked work\n");
		const svc = new GitService();
		await svc.discardFile(f.root, "untracked", f.path("fresh/dir/file.txt"));
		assert.equal(existsSync(f.path("fresh/dir/file.txt")), false);
		const entry = (await listRecovery(f.root)).entries[0];
		assert.equal(entry.path, "fresh/dir/file.txt");
		rmdirSync(f.path("fresh/dir"));
		rmdirSync(f.path("fresh"));
		await restoreRecovery(f.root, entry);
		assert.equal(readFileSync(f.path("fresh/dir/file.txt"), "utf8"), "untracked work\n");
		assert.equal(f.git("status", "--porcelain=v1"), "?? fresh/");
	});

	test("restore refuses to overwrite changes made after the discard", async () => {
		const f = repository();
		f.write("a.txt", "discarded\n");
		const svc = new GitService();
		await svc.discardFile(f.root, "workingTree", f.path("a.txt"));
		const entry = (await listRecovery(f.root)).entries[0];
		f.write("a.txt", "edited later\n");
		await assert.rejects(() => restoreRecovery(f.root, entry), /changes made after the discard/);
		assert.equal(readFileSync(f.path("a.txt"), "utf8"), "edited later\n", "the newer work is untouched");
	});

	test("restore refuses a path now occupied by a different untracked file", async () => {
		const f = repository();
		f.write("fresh.txt", "first\n");
		const svc = new GitService();
		await svc.discardFile(f.root, "untracked", f.path("fresh.txt"));
		const entry = (await listRecovery(f.root)).entries[0];
		f.write("fresh.txt", "someone else\n");
		await assert.rejects(() => restoreRecovery(f.root, entry), /different file now occupies/);
		assert.equal(readFileSync(f.path("fresh.txt"), "utf8"), "someone else\n");
	});
});

describe("drop", () => {
	test("dropping removes exactly that snapshot and the oid must match", async () => {
		const f = repository();
		f.write("a.txt", "discarded\n");
		const svc = new GitService();
		await svc.discardFile(f.root, "workingTree", f.path("a.txt"));
		const entry = (await listRecovery(f.root)).entries[0];

		const wrongOid = f.git("rev-parse", "HEAD");
		await assert.rejects(() => dropRecovery(f.root, { ref: entry.ref, oid: wrongOid }), /no longer matches/);
		assert.deepEqual(recoveryRefs(f), [entry.ref], "a mismatched oid deletes nothing");

		await dropRecovery(f.root, entry);
		assert.deepEqual(recoveryRefs(f), []);
		assert.deepEqual((await listRecovery(f.root)).entries, []);
		await assert.rejects(() => dropRecovery(f.root, entry), /no longer matches/, "the same entry cannot be dropped twice");
	});
});

describe("ref, oid and path guards", () => {
	test("only refs/pideck/recovery/* can be touched", async () => {
		const f = repository();
		const svc = new GitService();
		const oid = f.git("rev-parse", "HEAD");
		for (const ref of ["refs/heads/main", "refs/pideck/recovery/../heads/main", "refs/pideck/recovery/", "HEAD"]) {
			await assert.rejects(() => restoreRecovery(f.root, { ref, oid, path: "a.txt" }), /refs\/pideck\/recovery/);
			await assert.rejects(() => dropRecovery(f.root, { ref, oid }), /refs\/pideck\/recovery/);
		}
	});

	test("paths outside the repository and absolute paths are refused", async () => {
		const f = repository();
		f.write("a.txt", "discarded\n");
		const svc = new GitService();
		await svc.discardFile(f.root, "workingTree", f.path("a.txt"));
		const entry = (await listRecovery(f.root)).entries[0];
		const hostile = ["/etc/passwd", "../outside.txt", "sub/../../outside.txt", "C:/Windows/win.ini", "sub\\dir\\file.txt", ".", "./a.txt", "sub//dir"];
		for (const path of hostile) {
			await assert.rejects(() => restoreRecovery(f.root, { ref: entry.ref, oid: entry.oid, path }), /Invalid Git recovery path/, path);
		}
		assert.equal(readFileSync(f.path("a.txt"), "utf8"), "base\n");
	});

	test("a non-hex or truncated oid is refused", async () => {
		const f = repository();
		f.write("a.txt", "discarded\n");
		const svc = new GitService();
		await svc.discardFile(f.root, "workingTree", f.path("a.txt"));
		const entry = (await listRecovery(f.root)).entries[0];
		for (const oid of ["HEAD", entry.oid.slice(0, 39), `${entry.oid}0`, "z".repeat(40), " ".repeat(40)]) {
			await assert.rejects(() => restoreRecovery(f.root, { ref: entry.ref, oid, path: entry.path }), /Invalid Git recovery entry|no longer available/);
		}
		// 前缀对但 ref 不存在：拒绝，且没有写出任何文件。
		await assert.rejects(() => restoreRecovery(f.root, { ref: "refs/pideck/recovery/not-a-snapshot", oid: entry.oid, path: entry.path }), /no longer available/);
		assert.equal(readFileSync(f.path("a.txt"), "utf8"), "base\n");
	});

	test("a snapshot cannot be used to restore a path it does not hold", async () => {
		const f = repository();
		f.write("a.txt", "discarded\n");
		const svc = new GitService();
		await svc.discardFile(f.root, "workingTree", f.path("a.txt"));
		const entry = (await listRecovery(f.root)).entries[0];
		await assert.rejects(() => restoreRecovery(f.root, { ref: entry.ref, oid: entry.oid, path: "sub/dir/nested.txt" }), /does not hold that path/);
		assert.equal(readFileSync(f.path("sub/dir/nested.txt"), "utf8"), "nested base\n");
	});
});

describe("bounds", () => {
	test("a file above the 8 MiB snapshot limit is refused before anything is touched", async () => {
		const f = repository();
		const oversized = Buffer.alloc(MAX_BYTES + 1, 0x61);
		writeFileSync(f.path("a.txt"), oversized);
		const svc = new GitService();
		await assert.rejects(() => svc.discardFile(f.root, "workingTree", f.path("a.txt")), /recovery snapshot limit/);
		assert.deepEqual(readFileSync(f.path("a.txt")), oversized, "the working tree keeps its bytes");
		assert.deepEqual(recoveryRefs(f), [], "no half-written snapshot is left behind");
		assert.equal(f.git("status", "--porcelain=v1"), "M a.txt");
	});

	test("more than 64 snapshots are listed as truncated instead of silently cut", async () => {
		const f = repository({ "only.txt": "one file\n" });
		for (let index = 0; index < 65; index += 1) f.git("update-ref", `refs/pideck/recovery/20260101000000-${String(index).padStart(8, "0")}`, "HEAD");
		const svc = new GitService();
		const listing = await listRecovery(f.root);
		assert.equal(listing.truncated, true);
		assert.equal(listing.entries.length, 64);
		assert.ok(listing.entries.every((entry) => entry.path === "only.txt" && entry.bytes === Buffer.byteLength("one file\n")));
	});

	test("snapshots that are not ours are skipped, not shown with a wrong path", async () => {
		const f = repository({ "only.txt": "one file\n" });
		const single = f.git("rev-parse", "HEAD");
		// 一条 ref 指向 tree 里有两个文件的提交（不是我们写的那种快照），一条是我们自己的形状。
		f.write("second.txt", "extra\n");
		f.git("add", "--", "second.txt");
		f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "two files");
		f.git("update-ref", "refs/pideck/recovery/20260101000000-foreign", f.git("rev-parse", "HEAD"));
		f.git("update-ref", "refs/pideck/recovery/20260101000000-ours", single);
		const svc = new GitService();
		const listing = await listRecovery(f.root);
		assert.deepEqual(
			listing.entries.map((entry) => entry.path),
			["only.txt"],
		);
		assert.equal(listing.entries[0].oid, single);
		assert.equal(listing.truncated, false);
	});
});
