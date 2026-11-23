import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { BINARY_IDENTITY, BINARY_PATH, HOST, createFakeTextHost } from "./helpers/fakeRemoteTextHost.mjs";

const execute = promisify(execFile);
const { createRemoteProjectFileService } = loadTsCommonJs("src/main/remote/RemoteProjectFileService.ts");
const { createRemoteProjectTextTransfer } = loadTsCommonJs("src/main/remote/RemoteProjectTextTransfer.ts");
const POSIX = process.platform === "linux";
const TEXT_MAX = 8 * 1024 * 1024;

/**
 * 这条 BOM 用例走的也是远端文本链路，而快照是一条 Linux 远端命令：buildRemoteProjectFileCommand 只接受
 * POSIX 绝对路径与 `<node>/node` 解释器，脚本本身还依赖 /proc/self/fd、Linux 的 O_NOFOLLOW 与
 * `process.platform === "linux"` 守卫。Windows 上连命令都构造不出来，macOS 上脚本以
 * REMOTE_FILE_PLATFORM_UNSUPPORTED 拒绝，所以与其余用例一样跳过；Linux 上仍会执行。
 */
test("UTF-8 BOM is preserved as text rather than silently discarded by decoding", { skip: !POSIX }, async (t) => {
	const content = "\ufeffexport const value = 1;\n";
	const f = await fixture(t, { content });
	const doc = await f.open();
	assert.equal(doc.content, content);
	await f.save(doc.version, doc.content + "// edited\n");
	assert.equal(await readFile(f.path, "utf8"), content + "// edited\n");
});

async function fixture(t, { content = "original\n", mode = 0o600, hostOptions } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pideck-remote-file-"));
	const deployRoot = await mkdtemp(join(tmpdir(), "pideck-remote-deploy-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	t.after(() => rm(deployRoot, { recursive: true, force: true }));
	const path = join(root, "code.ts");
	await writeFile(path, content, { mode });
	let time = 0;
	let revision = 1;
	const commands = [];
	const target = { hostId: HOST, remotePath: root };
	const host = createFakeTextHost({ root, deployRoot, ...hostOptions });
	const transfer = createRemoteProjectTextTransfer({ binary: async () => ({ path: BINARY_PATH, identity: BINARY_IDENTITY }), cache: host.cache, probe: host.probe, adapter: host.adapter });
	const service = createRemoteProjectFileService({
		locator: (id) => (id === "project" ? target : id === "other" ? { ...target, remotePath: root + "/other" } : undefined),
		withProject: async (_target, work) =>
			work(
				{
					...host.session,
					hostRevision: revision,
					runCommand: async (command) => {
						commands.push(command);
						assert.ok(command.length <= 8192);
						const result = await execute("/bin/sh", ["-c", command], { maxBuffer: 256 * 1024 });
						return { exitCode: 0, stdout: result.stdout };
					},
				},
				host.capabilities,
			),
		transfer,
		now: () => time,
	});
	return {
		root,
		path,
		service,
		commands,
		host,
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

/** 项目目录里不该留下任何传输残留（helper 的私有同目录兄弟或旧式临时名）。 */
async function residuals(root) {
	return (await readdir(root)).filter((name) => name.endsWith(".pideck-tmp") || name.endsWith(".pideck-put"));
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
		assert.deepEqual(await residuals(f.root), []);
	});

test("remote text documents above the former 256 KiB ceiling can be opened and saved", { skip: !POSIX }, async (t) => {
	const original = "a".repeat(300 * 1024);
	const f = await fixture(t, { content: original });
	const opened = await f.open();
	assert.equal(opened.content, original);
	const next = "b".repeat(300 * 1024);
	await f.save(opened.version, next);
	assert.equal(await readFile(f.path, "utf8"), next);
});

test("the interactive text limit is 8 MiB and the body never travels in a shell command", { skip: !POSIX }, async (t) => {
	const f = await fixture(t);
	const doc = await f.open();
	await assert.rejects(f.save(doc.version, "x".repeat(TEXT_MAX + 1)), /REMOTE_FILE_TOO_LARGE/);
	// 正文与 base64 分块脚本都已删除：剩下的命令只有 revision 快照。
	assert.equal(f.commands.length, 1);
	assert.ok(f.commands.every((command) => command.includes("'snapshot'")));
	await f.save(doc.version, "still valid");
	assert.equal(await readFile(f.path, "utf8"), "still valid");
	// 超过上限的远端文件在**传输之前**就被拒绝（快照带 size）。
	const downloads = f.host.calls.downloads.length;
	await writeFile(f.path, "y".repeat(TEXT_MAX + 1));
	await assert.rejects(f.open(), /REMOTE_FILE_TOO_LARGE/);
	assert.equal(f.host.calls.downloads.length, downloads, "超限在传输之前拒绝");
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
		assert.deepEqual(await residuals(f.root), []);
		assert.equal(f.host.calls.commit.length, 0, "冲突在 prepare 之前就被快照拦下");
	});

test("upload-period external change is rejected by the commit re-check and never replayed", { skip: !POSIX }, async (t) => {
	const f = await fixture(t, {
		hostOptions: {
			stageBytes: async (bytes) => {
				// prepare 已经带着 expected 通过；stage 之后、commit 之前远端被改写。
				await writeFile(f.path, "external update\n");
				return bytes;
			},
		},
	});
	const doc = await f.open();
	await assert.rejects(f.save(doc.version, "x".repeat(9000)), /REMOTE_FILE_CHANGED/);
	assert.equal(await readFile(f.path, "utf8"), "external update\n");
	assert.equal(f.host.calls.prepare.length, 1);
	assert.equal(f.host.calls.commit.length, 1, "提交只发生一次：明确拒绝不重放");
	assert.deepEqual(await residuals(f.root), []);
});

test("a lost commit reply is REMOTE_FILE_COMMIT_UNCONFIRMED, not a conflict and not a retry", { skip: !POSIX }, async (t) => {
	const f = await fixture(t, {
		hostOptions: {
			afterPublish: async ({ target }) => {
				await writeFile(target, "external after commit\n");
			},
		},
	});
	const doc = await f.open();
	await assert.rejects(f.save(doc.version, "replacement"), /REMOTE_FILE_COMMIT_UNCONFIRMED/);
	assert.equal(await readFile(f.path, "utf8"), "external after commit\n");
	assert.equal(f.host.calls.commit.length, 1);
	await assert.rejects(f.save(doc.version, "retry"), /REMOTE_FILE_VERSION_INVALID/);
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
	await assert.rejects(f.save(doc.version, "x".repeat(TEXT_MAX + 1)), /REMOTE_FILE_TOO_LARGE/);
	await assert.rejects(f.save(doc.version, "null\0byte"), /REMOTE_FILE_NOT_TEXT/);
	await f.save(doc.version, "still valid");
	await writeFile(f.path, Buffer.from([0xff]));
	await assert.rejects(f.open(), /REMOTE_FILE_NOT_TEXT/);
	await writeFile(f.path, "\0");
	await assert.rejects(f.open(), /REMOTE_FILE_NOT_TEXT/);
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

test("long but valid project-relative paths still support full saves within the command budget", { skip: !POSIX }, async (t) => {
	const f = await fixture(t);
	const relative = `${"a".repeat(200)}/${"b".repeat(200)}/code.ts`;
	await mkdir(join(f.root, "a".repeat(200), "b".repeat(200)), { recursive: true });
	const path = join(f.root, relative);
	await writeFile(path, "original\n", { mode: 0o600 });
	const opened = await f.service.open(1, "project", relative);
	await f.service.save(1, "project", relative, "x".repeat(12000), opened.version);
	assert.equal(await readFile(path, "utf8"), "x".repeat(12000));
});

test("permission denial leaves the source unchanged without retry", { skip: !POSIX || process.getuid?.() === 0 }, async (t) => {
	const f = await fixture(t);
	const doc = await f.open();
	await chmod(f.root, 0o500);
	try {
		await assert.rejects(f.save(doc.version, "replacement"), /REMOTE_FILE_PERMISSION_DENIED/);
	} finally {
		await chmod(f.root, 0o700);
	}
	assert.equal(await readFile(f.path, "utf8"), "original\n");
	assert.deepEqual(await residuals(f.root), []);
	assert.equal(f.host.calls.prepare.length, 1);
	assert.equal(f.host.calls.commit.length, 1, "明确拒绝不重放");
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

test("releasing a window revokes its save tokens", { skip: !POSIX }, async (t) => {
	const f = await fixture(t);
	const doc = await f.open();
	f.service.releaseSender(1);
	await assert.rejects(f.save(doc.version, "bad"), /REMOTE_FILE_VERSION_INVALID/);
});

test("binary preview downloads once and refuses over-limit before transferring", { skip: !POSIX }, async (t) => {
	const f = await fixture(t);
	// 二进制内容不做 UTF-8 解码：PNG 魔数原样回裸 base64（渲染层据此转 Blob URL）。
	const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	await writeFile(f.path, png);
	assert.equal(await f.service.readBase64(1, "project", "code.ts", 1024), png.toString("base64"));
	assert.equal(f.host.calls.downloads.length, 1, "一次通过：不再先算摘要再整份重读");
	assert.equal(f.commands.filter((command) => command.includes("'snapshot'")).length, 1);
	// 超限在**传输之前**拒绝：与本地 backend 同一个 FILE_TOO_LARGE:size:max 前缀。
	await assert.rejects(f.service.readBase64(1, "project", "code.ts", 4), /FILE_TOO_LARGE:8:4/);
	await assert.rejects(f.service.readBase64(1, "project", "code.ts", 0), /REMOTE_FILE_INPUT_INVALID/);
	assert.equal(f.host.calls.downloads.length, 1);
});

test("a download whose bytes no longer match the snapshot is a conflict, never served", { skip: !POSIX }, async (t) => {
	const f = await fixture(t, { hostOptions: { downloadBytes: (bytes) => Buffer.concat([bytes, Buffer.from("tampered")]) } });
	await assert.rejects(f.open(), /REMOTE_FILE_CHANGED/);
});

test("missing SFTP executor fails closed instead of falling back to shell bodies", { skip: !POSIX }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pideck-remote-file-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "code.ts");
	await writeFile(path, "original\n", { mode: 0o600 });
	const host = createFakeTextHost({ root, deployRoot: root });
	const transfer = createRemoteProjectTextTransfer({ binary: async () => undefined, cache: host.cache, probe: host.probe, adapter: host.adapter });
	const service = createRemoteProjectFileService({
		locator: () => ({ hostId: HOST, remotePath: root }),
		withProject: async (_target, work) =>
			work(
				{
					...host.session,
					runCommand: async (command) => ({ exitCode: 0, stdout: (await execute("/bin/sh", ["-c", command], { maxBuffer: 256 * 1024 })).stdout }),
				},
				host.capabilities,
			),
		transfer,
	});
	await assert.rejects(service.open(1, "project", "code.ts"), /REMOTE_SFTP_BINARY_UNAVAILABLE/);
	assert.equal(host.calls.downloads.length, 0);
});
