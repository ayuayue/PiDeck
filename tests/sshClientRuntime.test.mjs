import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createSshClientRuntime, runSshClientSelfCheck, sanitizeSshClientEnv } = loadTsCommonJs("src/main/remote/SshClientRuntime.ts");

const isWindows = process.platform === "win32";

async function windowsInstall(t) {
	const directory = await mkdtemp(join(tmpdir(), "pideck openssh-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const sshPath = join(directory, "ssh.exe");
	const scpPath = join(directory, "scp.exe");
	await writeFile(sshPath, "");
	await writeFile(scpPath, "");
	return { directory, sshPath, scpPath };
}

function fakeClient(overrides = {}) {
	return {
		sshPath: isWindows ? "C:\\OpenSSH\\ssh.exe" : "/usr/bin/ssh",
		scpPath: isWindows ? "C:\\OpenSSH\\scp.exe" : "/usr/bin/scp",
		env: { PATH: "C:\\Windows\\System32" },
		run: async () => ({ exitCode: 0, stdout: "", stderr: "OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2" }),
		...overrides,
	};
}

test("resolves the installed OpenSSH pair without consulting PATH", { skip: !isWindows }, async (t) => {
	const spoof = await windowsInstall(t);
	const client = createSshClientRuntime({ platform: "win32", systemRoot: process.env.SystemRoot, env: { ...process.env, PATH: spoof.directory } });
	assert.match(client.sshPath, /[\\/]System32[\\/]OpenSSH[\\/]ssh\.exe$/i);
	assert.notEqual(client.sshPath, spoof.sshPath);
	assert.equal(client.scpPath, client.sshPath.replace(/ssh\.exe$/i, "scp.exe"));
	assert.equal(Object.isFrozen(client.env), true);
});

test("an explicit windows installation resolves its sibling SCP and rejects shims or missing pairs", { skip: !isWindows }, async (t) => {
	const { directory, sshPath, scpPath } = await windowsInstall(t);
	const client = createSshClientRuntime({ platform: "win32", sshPath });
	assert.equal(client.sshPath, sshPath);
	assert.equal(client.scpPath, scpPath);

	await rm(scpPath);
	assert.throws(() => createSshClientRuntime({ platform: "win32", sshPath }), /SSH_CLIENT_MISSING/);

	const shim = join(directory, "ssh.cmd");
	await writeFile(shim, "@echo off\n");
	assert.throws(() => createSshClientRuntime({ platform: "win32", sshPath: shim }), /SSH_CLIENT_SCRIPT_SHIM/);

	assert.throws(() => createSshClientRuntime({ platform: "win32", sshPath: "ssh.exe" }), /SSH_CLIENT_PATH_INVALID/);
	assert.throws(() => createSshClientRuntime({ platform: "win32", sshPath: `${sshPath}\u0000` }), /SSH_CLIENT_PATH_INVALID/);
	assert.throws(() => createSshClientRuntime({ platform: "win32", sshPath: join(directory, "missing.exe") }), /SSH_CLIENT_MISSING/);
});

test("unvalidated client platforms fail closed unless an explicit path is given", () => {
	for (const platform of ["darwin", "linux"]) {
		assert.throws(() => createSshClientRuntime({ platform }), /SSH_CLIENT_UNSUPPORTED_PLATFORM/);
	}
});

test("environment allowlist keeps SSH/agent needs and drops application secrets", () => {
	const source = {
		SystemRoot: "C:\\Windows",
		windir: "C:\\Windows",
		ProgramData: "C:\\ProgramData",
		USERPROFILE: "C:\\Users\\dev",
		APPDATA: "C:\\Users\\dev\\AppData\\Roaming",
		LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
		PATH: "C:\\Windows\\System32",
		SSH_AUTH_SOCK: "/tmp/agent.sock",
		PI_PROXY_TOKEN: "secret-pi",
		PIDECK_SECURITY_CONFIG: "secret-config",
		NODE_OPTIONS: "--require evil",
		NODE_PATH: "C:\\evil",
		ELECTRON_RUN_AS_NODE: "1",
		OPENAI_API_KEY: "sk-secret",
		DEEPSEEK_API_KEY: "sk-secret",
		HTTP_PROXY: "http://127.0.0.1:8080",
		HTTPS_PROXY: "http://127.0.0.1:8080",
		ALL_PROXY: "socks5://127.0.0.1:1080",
		SSH_ASKPASS: "C:\\evil\\askpass.exe",
		GIT_SSH_COMMAND: "evil",
		EMPTY_VALUE: "",
	};
	const next = sanitizeSshClientEnv(source, "win32");
	assert.deepEqual(Object.keys(next).sort(), ["APPDATA", "LOCALAPPDATA", "PATH", "Path", "ProgramData", "SSH_AUTH_SOCK", "SystemRoot", "USERPROFILE", "windir"]);
	assert.equal(next.Path, source.PATH);
	for (const leaked of ["PI_PROXY_TOKEN", "PIDECK_SECURITY_CONFIG", "NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "SSH_ASKPASS", "GIT_SSH_COMMAND", "EMPTY_VALUE"]) {
		assert.equal(next[leaked], undefined, leaked);
	}
	const posix = sanitizeSshClientEnv({ HOME: "/home/dev", PATH: "/usr/bin", SSH_AUTH_SOCK: "/tmp/agent.sock", SystemRoot: "C:\\Windows", NODE_OPTIONS: "--require evil" }, "linux");
	assert.deepEqual(Object.keys(posix).sort(), ["HOME", "PATH", "SSH_AUTH_SOCK"]);
});

test("version self-check runs through the bound client and rejects unknown or ancient clients", async () => {
	const seen = [];
	const client = fakeClient({
		run: async (executable, args) => {
			seen.push({ executable, args });
			return { exitCode: 0, stdout: "", stderr: "OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2" };
		},
	});
	assert.deepEqual(JSON.parse(JSON.stringify(await runSshClientSelfCheck(client))), { version: "OpenSSH_for_Windows_9.5p2" });
	assert.equal(seen.length, 1);
	assert.deepEqual(Array.from(seen[0].args), ["-V"]);
	assert.equal(seen[0].executable, client.sshPath);

	for (const [result, expected] of [
		[{ exitCode: 0, stdout: "", stderr: "unknown client banner" }, "SSH_CLIENT_VERSION_UNSUPPORTED"],
		[{ exitCode: 0, stdout: "", stderr: "OpenSSH_7.9p1, LibreSSL 2.7.3" }, "SSH_CLIENT_VERSION_UNSUPPORTED"],
		[{ exitCode: 255, stdout: "", stderr: "OpenSSH_9.5p1" }, "SSH_CLIENT_VERSION_UNSUPPORTED"],
	]) {
		await assert.rejects(runSshClientSelfCheck(fakeClient({ run: async () => result })), (error) => error.message === expected);
	}
	await assert.rejects(runSshClientSelfCheck(undefined), /SSH_CLIENT_CONTEXT_REQUIRED/);
});

test("the sanitized environment still lets the real client answer -V", { skip: !isWindows }, async () => {
	const client = createSshClientRuntime({ platform: "win32", systemRoot: process.env.SystemRoot });
	// Guards the ProgramData/SystemRoot/PATH essentials: a too-narrow allowlist makes ssh.exe exit
	// 255 with empty output instead of reporting a usable version.
	const { version } = await runSshClientSelfCheck(client);
	assert.match(version, /^OpenSSH_for_Windows_\d+\.\d+/);
});

test("a bound runner refuses to execute any other executable path", { skip: !isWindows }, async (t) => {
	const { sshPath } = await windowsInstall(t);
	const client = createSshClientRuntime({ platform: "win32", sshPath });
	// Argument/executable validation is synchronous so a mismatch cannot become an unhandled rejection.
	assert.throws(() => client.run("ssh.exe", ["-G", "work"]), /SSH_CLIENT_EXECUTABLE_MISMATCH/);
	assert.throws(() => client.run(childOf(sshPath), ["-G", "work"]), /SSH_CLIENT_EXECUTABLE_MISMATCH/);
	assert.throws(() => client.run(client.sshPath, ["-G", 7]), /SSH_CLIENT_ARGUMENT_INVALID/);
});

function childOf(sshPath) {
	return join(sshPath, "..");
}

/**
 * POSIX 客户端的能力探测。
 *
 * 背景（2026-09 实跑）：装配直接调用 `createSshClientRuntime()`，在 Linux 上撞到
 * `SSH_CLIENT_UNSUPPORTED_PLATFORM` —— 一道按平台名拒绝的门禁。但门禁真正要保证的
 * 不是「操作系统是 Windows」，而是「这个客户端的 `ssh -G` 输出能被严格解析器读懂」。
 * 平台名只是这条属性的粗糙代理：它会拒绝有能力客户端，也会放行没能力的。
 *
 * 这些用例把「支持」变成可测量的断言：真的探测二进制，真的解析一次 `-G`。
 */
const { resolvePosixSshClient } = loadTsCommonJs("src/main/remote/SshClientRuntime.ts");

test("a capable POSIX client is discovered and accepted", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX-only discovery");
	// 真实探测本机：标准路径 + OpenSSH >= 8 + `-G` 输出可被严格解析器接受。
	const client = await resolvePosixSshClient();
	assert.equal(client.sshPath, "/usr/bin/ssh");
	assert.equal(client.scpPath, "/usr/bin/scp");
	// 环境必须是白名单快照，绝不把应用密钥带进 OpenSSH 进程。
	assert.equal(client.env.PI_PROXY_TOKEN, undefined);
	assert.ok(client.env.HOME !== undefined, "POSIX 客户端需要 HOME 才能读 ~/.ssh/config");
});

test("discovery fails closed with a stable code instead of falling back to an unverified client", async () => {
	// 候选全不可用时必须抛稳定码，绝不能「找不到就随便用一个」。
	await assert.rejects(() => resolvePosixSshClient({ candidates: ["/nonexistent/ssh"] }), /SSH_CLIENT_MISSING/);
	// 存在但不是 OpenSSH 客户端的二进制：由既有的 `ssh -V` 自检拦下。
	await assert.rejects(() => resolvePosixSshClient({ candidates: ["/bin/ls"] }), /SSH_CLIENT_VERSION_UNSUPPORTED/);
});

test("the route probe uses the real parser, so 'supported' means the parser actually reads it", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX-only discovery");
	// 造一个假的 ssh：版本自检能过、但 `-G` 输出解析器读不懂（缺 hostname/user/port）。
	// 这类客户端必须被拒绝——否则路由校验会在真实连接时静默失效。
	const directory = await mkdtemp(join(tmpdir(), "pideck-ssh-fake-"));
	try {
		const fake = join(directory, "ssh");
		await writeFile(fake, `#!/bin/sh\nif [ "$1" = "-V" ]; then echo "OpenSSH_9.0p1 Fake" >&2; exit 0; fi\necho "not a route"\nexit 0\n`, { mode: 0o755 });
		await writeFile(join(directory, "scp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		await assert.rejects(() => resolvePosixSshClient({ candidates: [fake] }), /SSH_CLIENT_ROUTE_UNSUPPORTED/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("windows discovery is not attempted by the POSIX resolver", async () => {
	// 两个平台的发现路径完全不同；把它显式拒绝，避免有人误以为它是通用入口。
	await assert.rejects(() => resolvePosixSshClient({ platform: "win32" }), /SSH_CLIENT_UNSUPPORTED_PLATFORM/);
});

test("a failing `-G` query is reported distinctly from an unreadable one", async (t) => {
	if (process.platform === "win32") return t.skip("POSIX-only discovery");
	const directory = await mkdtemp(join(tmpdir(), "pideck-ssh-fail-"));
	try {
		const fake = join(directory, "ssh");
		// 版本过得去，但 `-G` 以非零退出：这是「探测失败」，与「输出读不懂」是两回事。
		await writeFile(fake, `#!/bin/sh\nif [ "$1" = "-V" ]; then echo "OpenSSH_9.0p1 Fake" >&2; exit 0; fi\nexit 1\n`, { mode: 0o755 });
		await writeFile(join(directory, "scp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		await assert.rejects(() => resolvePosixSshClient({ candidates: [fake] }), /SSH_CLIENT_PROBE_FAILED/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
