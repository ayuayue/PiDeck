import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const execute = promisify(execFile);
const { createRemoteProjectFileService } = loadTsCommonJs("src/main/remote/RemoteProjectFileService.ts");
const POSIX = process.platform === "linux";

/**
 * 这条 BOM 用例走的也是远端文本链路，而它是一条 Linux 远端命令：buildRemoteProjectFileCommand 只接受
 * POSIX 绝对路径与 `<node>/node` 解释器，脚本本身还依赖 /proc/self/fd、Linux 的 O_NOFOLLOW 与
 * `process.platform === "linux"` 守卫。Windows 上夹具连命令都构造不出来（REMOTE_FILE_PATH_INVALID），
 * macOS 上命令能构造但脚本以 REMOTE_FILE_PLATFORM_UNSUPPORTED 拒绝，所以与下面 21 条用例一样跳过；
 * Linux 上这条断言仍会执行。
 */
test("UTF-8 BOM is preserved as text rather than silently discarded by decoding", { skip: !POSIX }, async (t) => {
	const content = "\ufeffexport const value = 1;\n";
	const f = await fixture(t, { content });
	const doc = await f.open();
	assert.equal(doc.content, content);
	await f.save(doc.version, doc.content + "// edited\n");
	assert.equal(await readFile(f.path, "utf8"), content + "// edited\n");
});

async function fixture(t, { content = "original\n", mode = 0o600, before, afterRenameContent } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pideck-remote-file-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "code.ts");
	await writeFile(path, content, { mode });
	let time = 0;
	let revision = 1;
	const commands = [];
	const target = { hostId: "11111111-1111-4111-8111-111111111111", remotePath: root };
	const service = createRemoteProjectFileService({
		locator: (id) => (id === "project" ? target : id === "other" ? { ...target, remotePath: root + "/other" } : undefined),
		withProject: async (_target, work) =>
			work({
				hostRevision: revision,
				nodePath: process.execPath,
				runCommand: async (command) => {
					commands.push(command);
					assert.ok(command.length <= 8192);
					await before?.({ command, root, path });
					let env;
					if (afterRenameContent !== undefined && command.includes("'commit'")) {
						const shim = join(root, "post-rename.cjs");
						await writeFile(shim, `const fs = require("fs"); const rename = fs.renameSync; fs.renameSync = (from, to) => { rename(from, to); fs.writeFileSync(to, ${JSON.stringify(afterRenameContent)}); };`);
						env = { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(shim)}` };
					}
					const result = await execute("/bin/sh", ["-c", command], { maxBuffer: 256 * 1024, ...(env ? { env } : {}) });
					return { exitCode: 0, stdout: result.stdout };
				},
			}),
		now: () => time,
	});
	return {
		root,
		path,
		service,
		commands,
		target,
		advance: () => {
			time += 31 * 60 * 1000;
		},
		rebind: () => {
			revision++;
		},
		open: () => service.open(1, "project", "code.ts"),
		save: (version, next) => service.save(1, "project", "code.ts", next, version),
	};
}

for (const mode of [0o600, 0o640, 0o644])
	test(`remote text save preserves ${mode.toString(8)} and accepts repeated and empty saves`, { skip: !POSIX }, async (t) => {
		const f = await fixture(t, { mode });
		const opened = await f.open();
		assert.equal(opened.content, "original\n");
		assert.match(opened.version, /^[a-f0-9]{32}$/);
		const next = "中文\nquote ' and \\\n".repeat(500);
		const saved = await f.save(opened.version, next);
		assert.equal(await readFile(f.path, "utf8"), next);
		assert.equal((await stat(f.path)).mode & 0o7777, mode);
		assert.notEqual(saved.version, opened.version);
		await assert.rejects(f.save(opened.version, "old token"), /REMOTE_FILE_VERSION_INVALID/);
		await f.save(saved.version, "");
		assert.equal(await readFile(f.path, "utf8"), "");
		assert.equal((await stat(f.path)).mode & 0o7777, mode);
	});

for (const mutation of ["same-size", "append", "replace", "chmod", "delete"])
	test(`external ${mutation} after open is never silently overwritten`, { skip: !POSIX }, async (t) => {
		const f = await fixture(t);
		const opened = await f.open();
		if (mutation === "same-size") await writeFile(f.path, "external\n");
		if (mutation === "append") await writeFile(f.path, "original\nexternal\n");
		if (mutation === "replace") {
			await rename(f.path, f.path + ".old");
			await writeFile(f.path, "original\n", { mode: 0o600 });
		}
		if (mutation === "chmod") await chmod(f.path, 0o644);
		if (mutation === "delete") await unlink(f.path);
		const before = await readFile(f.path).catch(() => null);
		await assert.rejects(f.save(opened.version, "replacement"), /REMOTE_FILE_CHANGED/);
		assert.deepEqual(await readFile(f.path).catch(() => null), before);
		assert.equal((await readdir(f.root)).filter((name) => name.endsWith(".pideck-tmp")).length, 0);
	});

test("upload-period external change is rejected with private residual upload", { skip: !POSIX }, async (t) => {
	let injected = false;
	const f = await fixture(t, {
		before: async ({ command, root, path }) => {
			if (command.includes("'upload'") && !injected) {
				injected = true;
				await writeFile(path, "external update\n");
			}
			for (const name of await readdir(root)) if (name.endsWith(".pideck-tmp")) assert.equal((await stat(join(root, name))).mode & 0o7777, 0o600);
		},
	});
	const doc = await f.open();
	await assert.rejects(f.save(doc.version, "x".repeat(9000)), /REMOTE_FILE_CHANGED/);
	assert.equal(await readFile(f.path, "utf8"), "external update\n");
	const residual = (await readdir(f.root)).filter((name) => name.endsWith(".pideck-tmp"));
	assert.equal(residual.length, 1);
	assert.equal((await stat(join(f.root, residual[0]))).mode & 0o7777, 0o600);
});

test("tokens are bound to sender, project, host revision and path and expire", { skip: !POSIX }, async (t) => {
	const f = await fixture(t);
	const doc = await f.open();
	for (const args of [
		[2, "project", "code.ts"],
		[1, "other", "code.ts"],
		[1, "project", "other.ts"],
	])
		await assert.rejects(f.service.save(...args, "bad", doc.version), /REMOTE_FILE_VERSION_INVALID/);
	f.rebind();
	await assert.rejects(f.save(doc.version, "bad"), /REMOTE_FILE_VERSION_INVALID/);
	const fresh = await f.open();
	f.advance();
	await assert.rejects(f.save(fresh.version, "bad"), /REMOTE_FILE_VERSION_INVALID/);
	assert.equal(await readFile(f.path, "utf8"), "original\n");
});

test("root drift and leaf/parent symlinks never escape the project", { skip: !POSIX }, async (t) => {
	const f = await fixture(t);
	const outside = await mkdtemp(join(tmpdir(), "pideck-outside-"));
	t.after(() => rm(outside, { recursive: true, force: true }));
	await writeFile(join(outside, "secret"), "private");
	await symlink(join(outside, "secret"), join(f.root, "link"));
	await symlink(outside, join(f.root, "parent"));
	for (const path of ["link", "parent/secret"]) await assert.rejects(f.service.open(1, "project", path), /REMOTE_FILE_PATH_INVALID/);
	const doc = await f.open();
	await rename(f.root, f.root + ".old");
	t.after(() => rm(f.root + ".old", { recursive: true, force: true }));
	await symlink(outside, f.root);
	await assert.rejects(f.save(doc.version, "bad"), /REMOTE_FILE_PATH_INVALID/);
	assert.equal(await readFile(join(outside, "secret"), "utf8"), "private");
});

test("invalid targets, traversal, oversized and binary input fail closed", { skip: !POSIX }, async (t) => {
	const f = await fixture(t);
	for (const path of ["", "../secret", "/etc/passwd", "a//b", "a/./b", "a\\b", "x\n"]) await assert.rejects(f.service.open(1, "project", path), /REMOTE_FILE_PATH_INVALID/);
	await assert.rejects(f.service.open(1, "unknown", "code.ts"), /REMOTE_PROJECT_NOT_FOUND/);
	assert.equal(f.commands.length, 0);
	const doc = await f.open();
	await assert.rejects(f.save(doc.version, "x".repeat(262145)), /REMOTE_FILE_TOO_LARGE/);
	await assert.rejects(f.save(doc.version, "null\0byte"), /REMOTE_FILE_NOT_TEXT/);
	await f.save(doc.version, "still valid");
	await writeFile(f.path, Buffer.from([0xff]));
	await assert.rejects(f.open(), /REMOTE_FILE_NOT_TEXT/);
	await writeFile(f.path, "\0");
	await assert.rejects(f.open(), /REMOTE_FILE_NOT_TEXT/);
	await writeFile(f.path, "x".repeat(262145));
	await assert.rejects(f.open(), /REMOTE_FILE_TOO_LARGE/);
	await unlink(f.path);
	await assert.rejects(f.open(), /REMOTE_FILE_NOT_FOUND/);
	assert.equal((await readdir(f.root)).includes("code.ts"), false);
});

test("issued version freezes host identity even if the locator object is mutated in place", { skip: !POSIX }, async (t) => {
	const f = await fixture(t);
	const doc = await f.open();
	const count = f.commands.length;
	f.target.hostId = "22222222-2222-4222-8222-222222222222";
	await assert.rejects(f.save(doc.version, "bad"), /REMOTE_FILE_VERSION_INVALID/);
	assert.equal(f.commands.length, count);
	assert.equal(await readFile(f.path, "utf8"), "original\n");
});

for (const invalid of ["first\rsecond\r", "first\r\nsecond\n"])
	test("mixed/bare-CR line endings are refused instead of silently normalized", { skip: !POSIX }, async (t) => {
		const f = await fixture(t, { content: invalid });
		await assert.rejects(f.open(), /REMOTE_FILE_LINE_ENDING_UNSUPPORTED/);
	});

test("long but valid project-relative paths still support full chunked saves within the command budget", { skip: !POSIX }, async (t) => {
	const f = await fixture(t);
	const relative = `${"a".repeat(200)}/${"b".repeat(200)}/code.ts`;
	await mkdir(join(f.root, "a".repeat(200), "b".repeat(200)), { recursive: true });
	const path = join(f.root, relative);
	await writeFile(path, "original\n", { mode: 0o600 });
	const opened = await f.service.open(1, "project", relative);
	await f.service.save(1, "project", relative, "x".repeat(12000), opened.version);
	assert.equal(await readFile(path, "utf8"), "x".repeat(12000));
});

test("permission denial before upload leaves the source unchanged without retry", { skip: !POSIX || process.getuid?.() === 0 }, async (t) => {
	const f = await fixture(t);
	const doc = await f.open();
	await chmod(f.root, 0o500);
	try {
		await assert.rejects(f.save(doc.version, "replacement"), /REMOTE_FILE_PERMISSION_DENIED/);
	} finally {
		await chmod(f.root, 0o700);
	}
	assert.equal(await readFile(f.path, "utf8"), "original\n");
	assert.equal((await readdir(f.root)).filter((name) => name.endsWith(".pideck-tmp")).length, 0);
	assert.equal(f.commands.filter((command) => command.includes("'upload'")).length, 1);
});

test("rename denial restores private temporary mode and never exposes partial destination bytes", { skip: !POSIX || process.getuid?.() === 0 }, async (t) => {
	const f = await fixture(t, {
		mode: 0o644,
		before: async ({ command, root }) => {
			if (command.includes("'commit'")) await chmod(root, 0o500);
		},
	});
	const doc = await f.open();
	try {
		await assert.rejects(f.save(doc.version, "replacement"), /REMOTE_FILE_PERMISSION_DENIED/);
	} finally {
		await chmod(f.root, 0o700);
	}
	assert.equal(await readFile(f.path, "utf8"), "original\n");
	const residual = (await readdir(f.root)).filter((name) => name.endsWith(".pideck-tmp"));
	assert.equal(residual.length, 1);
	assert.equal((await stat(join(f.root, residual[0]))).mode & 0o7777, 0o600);
});

test("quoted project-relative file names are passed as data rather than shell syntax", { skip: !POSIX }, async (t) => {
	const f = await fixture(t);
	const relative = "quotes ' $ ;.ts";
	await writeFile(join(f.root, relative), "original\n", { mode: 0o600 });
	const doc = await f.service.open(1, "project", relative);
	await f.service.save(1, "project", relative, "saved\n", doc.version);
	assert.equal(await readFile(join(f.root, relative), "utf8"), "saved\n");
	assert.equal(await readFile(f.path, "utf8"), "original\n");
});

test("post-rename readback conflict is unconfirmed, not a false claim that overwrite was refused", { skip: !POSIX }, async (t) => {
	const f = await fixture(t, { afterRenameContent: "external after commit\n" });
	const doc = await f.open();
	await assert.rejects(f.save(doc.version, "replacement"), /REMOTE_FILE_COMMAND_FAILED/);
	assert.equal(await readFile(f.path, "utf8"), "external after commit\n");
	assert.equal(f.commands.filter((command) => command.includes("'commit'")).length, 1);
	await assert.rejects(f.save(doc.version, "retry"), /REMOTE_FILE_VERSION_INVALID/);
});

test("releasing a window revokes its save tokens", { skip: !POSIX }, async (t) => {
	const f = await fixture(t);
	const doc = await f.open();
	f.service.releaseSender(1);
	await assert.rejects(f.save(doc.version, "bad"), /REMOTE_FILE_VERSION_INVALID/);
});

test("binary preview reuses the chunked read channel and refuses over-limit before transferring", { skip: !POSIX }, async (t) => {
	const f = await fixture(t);
	// 二进制内容不做 UTF-8 解码：PNG 魔数原样回裸 base64（渲染层据此转 Blob URL）。
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	await writeFile(f.path, png);
	assert.equal(await f.service.readBase64(1, "project", "code.ts", 1024), png.toString("base64"));
	// 超限在**读第一个分块之前**拒绝：与本地 backend 同一个 FILE_TOO_LARGE:size:max 前缀，
	// 且只发生一次 snapshot 命令（先读完再判断等于把一个超大文件完整传两遍）。
	await assert.rejects(f.service.readBase64(1, "project", "code.ts", 4), /FILE_TOO_LARGE:8:4/);
	await assert.rejects(f.service.readBase64(1, "project", "code.ts", 0), /REMOTE_FILE_INPUT_INVALID/);
	assert.equal(f.commands.filter((command) => command.includes("'read'")).length, 1);
});
