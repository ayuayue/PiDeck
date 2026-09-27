import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 浏览根目录的 canonical 化。
 *
 * 为什么必须在**用户确认之前**做：helper 启动时 realpath 它的 `--root` 并在 `hello` 里回报结果，
 * 握手会拒绝不一致的值。所以一个以符号链接形式送达 helper 的路径**永远不能成为可用会话**——
 * 用户会确认一个随后被拒的路径，而且看不出原因（P3-1 真机已实测到这个现象）。
 *
 * 这些用例锁定两件事：命令行不被注入，以及「不存在」与「不是目录」保持可区分。
 */

const { buildResolveBrowseRootCommand, readCanonicalBrowseRoot, resolveRemoteBrowseRoot, REMOTE_BROWSE_ROOT_CODES } = loadTsCommonJs("src/main/remote/RemoteBrowseRoot.ts");

/** 在本机 POSIX shell 上跑同一段命令：远端是同类 shell，因此语义可在此验证。 */
function runLocally(path) {
	try {
		return { stdout: execFileSync("/bin/sh", ["-c", buildResolveBrowseRootCommand(path)], { encoding: "utf8" }), exitCode: 0 };
	} catch (error) {
		return { stdout: String(error.stdout ?? ""), exitCode: error.status ?? -1 };
	}
}

test("the probe quotes its argument so a path cannot become a second word", () => {
	const command = buildResolveBrowseRootCommand("/home/a b/c");
	// 空格必须留在同一个词里：未引用会让 shell 把它拆成两个参数。
	assert.ok(command.includes("'/home/a b/c'"), command);
	// 单引号按 POSIX 规则转义，不会提前结束引用。
	assert.ok(buildResolveBrowseRootCommand("/o'brien/x").includes("'/o'\\''brien/x'"));
	// `--` 终止选项解析：以 - 开头的路径是路径，不是选项。
	assert.ok(command.includes("readlink -f -- "), command);
});

test("paths that must never reach the remote shell are refused before quoting", () => {
	for (const bad of ["", "relative/path", "./x", "/home/user/", "/", "/home/../etc", "/home/./x", "/home//x", "/home/\u0000x", "/home/\nx", `/${"a".repeat(5000)}`, null, 42]) {
		assert.throws(() => buildResolveBrowseRootCommand(bad), /REMOTE_BROWSE_ROOT_/, `expected ${JSON.stringify(bad)} to be refused`);
	}
	// 相对路径与不安全字符是两个不同的原因，界面要说不同的话。
	assert.throws(
		() => buildResolveBrowseRootCommand("relative/path"),
		(error) => error.message === REMOTE_BROWSE_ROOT_CODES.notAbsolute,
	);
	assert.throws(
		() => buildResolveBrowseRootCommand("/home/x\n"),
		(error) => error.message === REMOTE_BROWSE_ROOT_CODES.invalidPath,
	);
});

test("the probe resolves a real directory, and tells 'missing' apart from 'not a directory'", (t) => {
	const base = mkdtempSync(join(tmpdir(), "pideck-root-probe-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const real = join(base, "real");
	const file = join(base, "a-file");
	const link = join(base, "link-to-real");
	execFileSync("mkdir", [real]);
	writeFileSync(file, "x");
	symlinkSync(real, link, "dir");

	// 真实目录：原样返回。
	assert.equal(runLocally(real).stdout.trim(), real);
	// 符号链接：返回**目标**——这正是让握手能通过的原因（它比对的就是 canonical 值）。
	assert.equal(runLocally(link).stdout.trim(), real, "a symlinked root must resolve to its target");
	// 退出码区分两种失败，且**实测语义**是：
	//   3 = readlink -f 解不出（路径中某个**父级**不存在）
	//   5 = 解出了但不是一个已存在的目录（叶子不存在、是文件、或断链都落在这里）
	// 这符合 GNU `readlink -f` 的定义（除最后一段外都必须存在），界面因此能说清是哪一类。
	assert.equal(runLocally(join(base, "ghost-parent", "child")).exitCode, 3, "a missing parent is unresolvable");
	assert.equal(runLocally(join(base, "missing-leaf")).exitCode, 5, "a missing leaf resolves but is not a directory");
	assert.equal(runLocally(file).exitCode, 5);
});

test("the canonical value is re-validated on the way back, because it comes from the remote", () => {
	assert.deepEqual(JSON.parse(JSON.stringify(readCanonicalBrowseRoot("/home/user/proj\n"))), { canonicalPath: "/home/user/proj" });
	for (const bad of ["", "relative", "/", "/home/user/", "/home/../etc", "/home//x", "/home\n/user", "/x\u0000y", "/" + "a".repeat(5000), null, 42, ["/x"]]) {
		assert.throws(() => readCanonicalBrowseRoot(bad), /REMOTE_BROWSE_ROOT_UNRESOLVED/, `expected ${JSON.stringify(bad)} to be refused`);
	}
	// 多行输出（例如被警告污染）必须被拒，而不是取第一行当答案。
	assert.throws(() => readCanonicalBrowseRoot("/home/user\nwarning text\n"), /REMOTE_BROWSE_ROOT_UNRESOLVED/);
});

/** 用桩替换 pinned 预检与客户端，只验退出码映射与参数传递。 */
function loadWithProbe(result) {
	const calls = [];
	const { resolveRemoteBrowseRoot: resolve } = loadTsCommonJs("src/main/remote/RemoteBrowseRoot.ts", {
		stubs: {
			"./SshVerifiedConnection": {
				async buildPinnedSshInvocation(userDataDir, hostId, kind, options) {
					calls.push({ userDataDir, hostId, kind, remoteCommand: options.remoteCommand });
					return { executable: "/usr/bin/ssh", args: ["--", `pideck-${hostId}`, options.remoteCommand], env: {}, openSshVersion: "OpenSSH_10.0p2" };
				},
			},
		},
	});
	return { resolve, calls };
}

const clientReturning = (result) => ({ sshPath: "/usr/bin/ssh", scpPath: "/usr/bin/scp", env: {}, run: async () => result });

test("exit codes map to distinct stable codes so the ui can say what went wrong", async () => {
	const cases = [
		[3, "REMOTE_BROWSE_ROOT_UNRESOLVED"],
		[4, "REMOTE_BROWSE_ROOT_UNRESOLVED"],
		[5, "REMOTE_BROWSE_ROOT_NOT_A_DIRECTORY"],
		[1, "REMOTE_BROWSE_ROOT_PROBE_FAILED"],
		[255, "REMOTE_BROWSE_ROOT_PROBE_FAILED"],
	];
	for (const [exitCode, code] of cases) {
		const { resolve } = loadWithProbe();
		await assert.rejects(() => resolve({ userDataDir: "/ignored", hostId: "b145de8c-6330-45be-8752-f20e8e270150", client: clientReturning({ exitCode, stdout: "" }), userPath: "/home/user" }), new RegExp(code), `exit ${exitCode}`);
	}
});

test("a transport failure is reported as a probe failure, not as a bad path", async () => {
	const { resolve } = loadWithProbe();
	const client = {
		sshPath: "/usr/bin/ssh",
		scpPath: "/usr/bin/scp",
		env: {},
		run: async () => {
			throw new Error("SSH_LAUNCHER_STREAM_FAILED");
		},
	};
	await assert.rejects(() => resolve({ userDataDir: "/ignored", hostId: "b145de8c-6330-45be-8752-f20e8e270150", client, userPath: "/home/user" }), /REMOTE_BROWSE_ROOT_PROBE_FAILED/);
});

test("a successful probe goes through the pinned invocation and returns the canonical path", async () => {
	const { resolve, calls } = loadWithProbe();
	const client = clientReturning({ exitCode: 0, stdout: "/srv/real-project\n" });
	const resolved = await resolve({ userDataDir: "/ignored", hostId: "b145de8c-6330-45be-8752-f20e8e270150", client, userPath: "/srv/link-project" });
	assert.deepEqual(JSON.parse(JSON.stringify(resolved)), { canonicalPath: "/srv/real-project" });
	// 必须走 pinned 预检（不是裸 ssh），且命令形态与构造器一致。
	assert.equal(calls.length, 1);
	assert.equal(calls[0].kind, "ssh-batch");
	assert.equal(calls[0].remoteCommand, buildResolveBrowseRootCommand("/srv/link-project"));
});
