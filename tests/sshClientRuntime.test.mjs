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
