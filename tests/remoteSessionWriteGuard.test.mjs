import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 会话写面的 pinned SSH 守卫脚本（`buildRemoteSessionWriteGuardCommand` + `parseRemoteSessionWriteGuardResult`）。
 *
 * 只测脚本本身：命令串由生产构造函数生成，用真实 `/bin/sh -c` 执行，不手写 Node/sh 语义模拟器。
 * 会话改写不再是「本机改完整份再上传」，所以这里没有分块读写/临时文件按序上传的用例——那条路径已经
 * 不存在（远端在同一份文件上流式改写）；main 侧仍在使用的是 `snapshot`（revision 基线），
 * `commit` 的 CAS 语义仍是脚本的一部分，因此一并以直接调用钉住。
 */
const { buildRemoteSessionWriteGuardCommand, parseRemoteSessionWriteGuardResult, REMOTE_SESSION_WRITE_MAX_BYTES } = loadTsCommonJs("src/main/remote/RemoteSessionWriteGuard.ts");
const execute = promisify(execFile);
const POSIX = process.platform !== "win32";
const MAX_BYTES = 256 * 1024;
const COMMAND_FAILED = "REMOTE_SESSION_HISTORY_WRITER_COMMAND_FAILED";
const CHANGED = "REMOTE_SESSION_HISTORY_WRITER_FILE_CHANGED";
const TRANSFER_INVALID = "REMOTE_SESSION_HISTORY_WRITER_TRANSFER_INVALID";
const FILE_TOO_LARGE = "REMOTE_SESSION_HISTORY_WRITER_FILE_TOO_LARGE";

const document = () =>
	[
		{ type: "session", id: "s", timestamp: "2026-01-01T00:00:00.000Z" },
		{ type: "message", id: "u", parentId: null, message: { role: "user", content: [{ type: "text", text: "prompt" }] } },
		{ type: "message", id: "a", parentId: "u", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } },
	]
		.map((entry) => JSON.stringify(entry))
		.join("\n") + "\n";

/** 守卫命令的标记：脚本把它写在结果最前面（`'snapshot' '<marker>'`）。 */
const markerOf = (command) => command.match(/'(?:snapshot|commit)' '([^']+)'/)[1];
const isCommit = (command) => command.includes(" 'commit' ");

/** 只在一次性本机目录模拟远端：执行的正是生产命令。 */
async function harness(t, options = {}) {
	const directory = await mkdtemp(join(tmpdir(), "pideck-write-guard-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "session.jsonl");
	await writeFile(path, options.document ?? document(), { mode: options.mode ?? 0o600 });
	await chmod(path, options.mode ?? 0o600);
	const run = async (command) => {
		await options.before?.({ command, path, directory });
		let result;
		try {
			const output = await execute("/bin/sh", ["-c", "umask 022; " + command], { timeout: 10_000, maxBuffer: MAX_BYTES });
			result = { exitCode: 0, stdout: output.stdout };
		} catch (error) {
			result = { exitCode: typeof error.code === "number" ? error.code : 1, stdout: error.stdout ?? "" };
		}
		await options.after?.({ command, path, directory });
		return result;
	};
	const common = { nodePath: process.execPath, remotePath: path, nonce: "abc123def456", maxBytes: MAX_BYTES };
	const snapshot = async () => {
		const command = buildRemoteSessionWriteGuardCommand({ ...common, operation: "snapshot" });
		return { revision: parseRemoteSessionWriteGuardResult((await run(command)).stdout, markerOf(command)), command };
	};
	/** 同目录 0600 临时文件 + 守卫的原子提交（rename 之前复核 source 与上传内容）。 */
	const commit = async (source, content) => {
		const temporaryPath = join(directory, ".probe.abc123def456.pideck-tmp");
		await writeFile(temporaryPath, content, { mode: 0o600 });
		const command = buildRemoteSessionWriteGuardCommand({ ...common, operation: "commit", temporaryPath, source, nextDigest: createHash("sha256").update(content).digest("hex"), nextSize: Buffer.byteLength(content) });
		return { ...(await run(command)), marker: markerOf(command), temporaryPath };
	};
	return { path, directory, run, snapshot, commit };
}

const rejection = async (run) => {
	try {
		await run();
	} catch (error) {
		return error.message;
	}
	throw new Error("EXPECTED_REJECTION");
};

test("snapshot describes exactly the bytes on disk and stays inside the pinned command budget", { skip: !POSIX }, async (t) => {
	const fixture = await harness(t);
	const content = Buffer.from(document(), "utf8");
	const { revision, command } = await fixture.snapshot();

	assert.equal(revision.size, content.length);
	assert.equal(revision.digest, createHash("sha256").update(content).digest("hex"));
	assert.equal(revision.mode, 0o600);
	// 身份字段是字符串化的整数（跨语言比较没有浮点误差，也不会被 JSON 折叠成科学计数法）。
	for (const field of ["dev", "ino", "uid", "gid", "mtimeNs", "ctimeNs"]) assert.match(revision[field], /^\d{1,40}$/, field);
	// argv 只有单引号字面量：用户可控的只是一个已校验过的绝对路径。
	assert.equal(/["`$\\\n]/.test(command.replace(/'[^']*'/g, "''")), false, `用户参数不得逃出单引号 argv: ${command}`);
	assert.equal(/[\r\n]/.test(command), false, "单命令禁止换行");
});

test("snapshot refuses a symlink source instead of describing the referent", { skip: !POSIX }, async (t) => {
	const fixture = await harness(t);
	const real = fixture.path + ".real";
	await writeFile(real, document(), { mode: 0o600 });
	await unlink(fixture.path);
	await symlink(real, fixture.path);
	// O_NOFOLLOW：符号链接不是普通文件 ⇒ 快照拒绝（ELOOP 不在脚本已知码里，折叠为 commandFailed）；
	// 引用对象既没被读成基线，也没被改动。
	assert.equal(await rejection(() => fixture.snapshot()), COMMAND_FAILED);
	assert.equal(await readFile(real, "utf8"), document());
});

test("snapshot refuses a file over the byte bound before hashing it", { skip: !POSIX }, async (t) => {
	const fixture = await harness(t, { document: "x".repeat(MAX_BYTES + 1) });
	assert.equal(await rejection(() => fixture.snapshot()), FILE_TOO_LARGE);
});

test("a session past the old 256 KiB bound is snapshot-able, because the bound now only sizes the digest", { skip: !POSIX }, async (t) => {
	// 写面改成远端就地维护后，这条界只决定「摘要最多算多大」，不再等于可维护的文件大小：
	// 大会话付一次 O(文件) 的摘要，而不是整文往返。
	const big = document() + "y".repeat(300 * 1024) + "\n";
	const fixture = await harness(t, { document: big });
	const command = buildRemoteSessionWriteGuardCommand({ nodePath: process.execPath, remotePath: fixture.path, nonce: "abc123def456", maxBytes: REMOTE_SESSION_WRITE_MAX_BYTES, operation: "snapshot" });
	const { exitCode, stdout } = await fixture.run(command);
	assert.equal(exitCode, 0, "the raised bound admits a session the old 256 KiB bound refused");
	assert.equal(parseRemoteSessionWriteGuardResult(stdout, markerOf(command)).size, Buffer.byteLength(big));
});

test("temporary uid/gid mismatch is refused before changing mode or source", { skip: !POSIX }, async (t) => {
	const fixture = await harness(t);
	const { revision } = await fixture.snapshot();
	const content = document().replace("reply", "edited reply");
	for (const identity of ["uid", "gid"]) {
		// 构造归属不一致的反例：必须在 chmod/rename 前拒绝，不能悄悄换成当前默认组。
		const { stdout, marker, temporaryPath } = await fixture.commit({ ...revision, [identity]: revision[identity] === "0" ? "1" : "0" }, content);
		assert.equal(await rejection(async () => parseRemoteSessionWriteGuardResult(stdout, marker)), COMMAND_FAILED);
		assert.equal(await readFile(fixture.path, "utf8"), document());
		assert.equal((await stat(temporaryPath)).mode & 0o7777, 0o600);
	}
});

for (const mode of [0o600, 0o640, 0o644]) {
	test(`commit replaces the file atomically and preserves ${mode.toString(8)} mode`, { skip: !POSIX }, async (t) => {
		const fixture = await harness(t, { mode });
		const { revision } = await fixture.snapshot();
		const content = document().replace("reply", "edited reply");
		const { stdout, marker } = await fixture.commit(revision, content);

		assert.equal(parseRemoteSessionWriteGuardResult(stdout, marker), undefined, "commit 的成功应答没有 revision");
		assert.equal(await readFile(fixture.path, "utf8"), content);
		assert.equal((await stat(fixture.path)).mode & 0o7777, mode);
		assert.deepEqual(await readdir(fixture.directory), ["session.jsonl"], "临时文件必须已被 rename 消费");
	});
}

for (const change of ["same-size content", "append", "replace with identical bytes", "permissions", "delete"]) {
	test(`commit refuses external ${change} changes without overwriting or retrying`, { skip: !POSIX }, async (t) => {
		let altered = false;
		let external;
		const fixture = await harness(t, {
			before: async ({ command, path }) => {
				if (!isCommit(command) || altered) return;
				altered = true;
				external = document();
				if (change === "same-size content") external = document().replace("reply", "other");
				if (change === "append") external += JSON.stringify({ type: "message", id: "extra", parentId: "a", message: { role: "user", content: "external" } }) + "\n";
				if (change === "replace with identical bytes") {
					await writeFile(path + ".external", external, { mode: 0o600 });
					await rename(path + ".external", path);
				} else if (change === "permissions") await chmod(path, 0o640);
				else if (change === "delete") await unlink(path);
				else await writeFile(path, external);
			},
		});
		const { revision } = await fixture.snapshot();
		const { stdout, marker } = await fixture.commit(revision, document().replace("reply", "edited reply"));
		assert.equal(await rejection(async () => parseRemoteSessionWriteGuardResult(stdout, marker)), CHANGED);
		if (change === "delete") await assert.rejects(readFile(fixture.path), { code: "ENOENT" });
		else assert.equal(await readFile(fixture.path, "utf8"), external);
		if (change === "permissions") assert.equal((await stat(fixture.path)).mode & 0o7777, 0o640);
		for (const name of await readdir(fixture.directory)) if (name.endsWith(".pideck-tmp")) assert.equal((await stat(join(fixture.directory, name))).mode & 0o7777, 0o600);
	});
}

test("same-size temporary content tampering is rejected before replacing source", { skip: !POSIX }, async (t) => {
	const fixture = await harness(t, {
		before: async ({ command, directory }) => {
			if (!isCommit(command)) return;
			const name = (await readdir(directory)).find((file) => file.endsWith(".pideck-tmp"));
			const path = join(directory, name);
			await writeFile(path, (await readFile(path, "utf8")).replace("edited reply", "other! reply"));
		},
	});
	const { revision } = await fixture.snapshot();
	const { stdout, marker } = await fixture.commit(revision, document().replace("reply", "edited reply"));
	assert.equal(await rejection(async () => parseRemoteSessionWriteGuardResult(stdout, marker)), TRANSFER_INVALID);
	assert.equal(await readFile(fixture.path, "utf8"), document());
});

test("rename failure restores residual temporary permissions to 0600", { skip: !POSIX || process.getuid?.() === 0 }, async (t) => {
	const fixture = await harness(t, {
		mode: 0o644,
		before: async ({ command, directory }) => {
			if (isCommit(command)) await chmod(directory, 0o555);
		},
	});
	try {
		const { revision } = await fixture.snapshot();
		const { stdout, marker } = await fixture.commit(revision, document().replace("reply", "edited reply"));
		assert.equal(await rejection(async () => parseRemoteSessionWriteGuardResult(stdout, marker)), COMMAND_FAILED);
		assert.equal(await readFile(fixture.path, "utf8"), document());
		assert.equal((await stat(fixture.path)).mode & 0o7777, 0o644);
		for (const name of await readdir(fixture.directory)) if (name.endsWith(".pideck-tmp")) assert.equal((await stat(join(fixture.directory, name))).mode & 0o7777, 0o600);
	} finally {
		await chmod(fixture.directory, 0o755);
	}
});
