import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { verifyDraftSshHost } = loadTsCommonJs("src/main/remote/SshHostVerifier.ts");
const pinAlias = "pideck-host-a";
const route = { sshHost: "work", user: "alice", port: 2222 };
const config = `host work\nuser alice\nhostname example.invalid\nport 2222\ncanonicalizehostname false\nhostkeyalias ${pinAlias}\n`;
const fakeSshPath = process.platform === "win32" ? "C:\\OpenSSH\\ssh.exe" : "/usr/bin/ssh";

/**
 * Bind each mock runner to a fake client context. The `-V` self-check is answered here so the
 * individual tests only model route and probe behavior.
 */
function clientFor(run) {
	return {
		sshPath: fakeSshPath,
		scpPath: process.platform === "win32" ? "C:\\OpenSSH\\scp.exe" : "/usr/bin/scp",
		env: {},
		run: async (executable, args) => {
			assert.equal(executable, fakeSshPath, "every command must use the bound ssh path");
			if (args.length === 1 && args[0] === "-V") return { exitCode: 0, stdout: "", stderr: "OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2" };
			return run(executable, args);
		},
	};
}

function sshString(value) {
	const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	return Buffer.concat([length, data]);
}

const key = Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.alloc(32, 17))]);
const validLine = `${pinAlias} ssh-ed25519 ${key.toString("base64")}\n`;
const fingerprint = `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;

function pinFile(args) {
	const value = args.find((arg) => arg.startsWith("UserKnownHostsFile="));
	assert.ok(value, "probe must use an isolated UserKnownHostsFile");
	return value.slice("UserKnownHostsFile=".length);
}

async function assertRemoved(filePath) {
	await assert.rejects(stat(dirname(filePath)), (error) => error.code === "ENOENT");
}

test("returns a candidate only after authenticated command success and removes its temporary pin", async () => {
	let queries = 0;
	let probeFile;
	const run = async (executable, args) => {
		assert.equal(executable, fakeSshPath);
		if (args[0] === "-G") {
			queries += 1;
			assert.equal(args.at(-1), route.sshHost);
			assert.ok(args.includes(`HostKeyAlias=${pinAlias}`));
			assert.ok(args.includes("SendEnv=-*"));
			assert.ok(args.includes("ForwardX11=no"));
			return { exitCode: 0, stdout: config };
		}
		assert.equal(args.at(-2), route.sshHost);
		assert.equal(args.at(-1), "true");
		for (const option of ["StrictHostKeyChecking=accept-new", `HostKeyAlias=${pinAlias}`, "BatchMode=yes", "SendEnv=-*", "ForwardX11=no", "ForwardAgent=no", "ClearAllForwardings=yes", "ControlMaster=no", "ControlPath=none", "HashKnownHosts=no"]) assert.ok(args.includes(option), option);
		assert.ok(args.includes(`GlobalKnownHostsFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`));
		probeFile = pinFile(args);
		await writeFile(probeFile, validLine, "utf8");
		return { exitCode: 0, stdout: "" };
	};
	const candidate = await verifyDraftSshHost(route, pinAlias, { client: clientFor(run) });
	assert.equal(queries, 2, "route is rechecked after authentication");
	assert.equal(candidate.hostName, "example.invalid");
	assert.equal(candidate.user, "alice");
	assert.equal(candidate.port, 2222);
	assert.equal(candidate.pinAlias, pinAlias);
	assert.deepEqual(Array.from(candidate.hostKeyFingerprints), [fingerprint]);
	assert.equal(candidate.knownHostsSha256, createHash("sha256").update(Buffer.from(validLine)).digest("hex"));
	assert.equal(Buffer.from(candidate.knownHostsBase64, "base64").toString("utf8"), validLine);
	await assertRemoved(probeFile);
});

test("rejects effective environment forwarding before and after draft authentication", async () => {
	for (const directive of ["sendenv PIDECK_SECRET", "setenv TOKEN=hidden"]) {
		let calls = 0;
		const run = async () => {
			calls += 1;
			return { exitCode: 0, stdout: `${config}${directive}\n` };
		};
		await assert.rejects(verifyDraftSshHost(route, pinAlias, { client: clientFor(run) }), /SSH_HOST_ENV_UNVERIFIED/);
		assert.equal(calls, 1, "unsafe config must not trigger a network probe");
	}
	let queries = 0;
	let probeFile;
	const run = async (_executable, args) => {
		if (args[0] === "-G") return { exitCode: 0, stdout: queries++ === 0 ? config : `${config}sendenv PIDECK_SECRET\n` };
		probeFile = pinFile(args);
		await writeFile(probeFile, validLine, "utf8");
		return { exitCode: 0, stdout: "" };
	};
	await assert.rejects(verifyDraftSshHost(route, pinAlias, { client: clientFor(run) }), /SSH_HOST_ENV_UNVERIFIED/);
	await assertRemoved(probeFile);
});

test("does not accept a key written before user authentication fails", async () => {
	let probeFile;
	const run = async (_executable, args) => {
		if (args[0] === "-G") return { exitCode: 0, stdout: config };
		probeFile = pinFile(args);
		await writeFile(probeFile, validLine, "utf8");
		return { exitCode: 255, stdout: "" };
	};
	await assert.rejects(verifyDraftSshHost(route, pinAlias, { client: clientFor(run) }), /SSH_HOST_AUTHENTICATION_FAILED/);
	await assertRemoved(probeFile);
});

test("rejects probe stdout pollution and runner failures while removing the temporary pin", async () => {
	for (const failure of ["stdout", "timeout"]) {
		let probeFile;
		const run = async (_executable, args) => {
			if (args[0] === "-G") return { exitCode: 0, stdout: config };
			probeFile = pinFile(args);
			await writeFile(probeFile, validLine, "utf8");
			if (failure === "timeout") throw new Error("SSH_HOST_COMMAND_TIMEOUT");
			return { exitCode: 0, stdout: "unexpected banner" };
		};
		await assert.rejects(verifyDraftSshHost(route, pinAlias, { client: clientFor(run) }), /SSH_HOST_AUTHENTICATION_FAILED|SSH_HOST_COMMAND_TIMEOUT/);
		await assertRemoved(probeFile);
	}
});

test("requires a nonempty, single, exact-alias raw host key after authentication", async () => {
	const malformedRsa = Buffer.concat([sshString("ssh-rsa"), sshString(Buffer.from([1, 0, 1])), sshString(Buffer.alloc(256, 1))]);
	const malformedEcdsa = Buffer.concat([sshString("ecdsa-sha2-nistp256"), sshString("nistp256"), sshString("NOT-A-POINT")]);
	const invalidLines = [
		"",
		`other ssh-ed25519 ${key.toString("base64")}\n`,
		`@cert-authority ${validLine}`,
		`@revoked ${validLine}`,
		`|1|hashed ssh-ed25519 ${key.toString("base64")}\n`,
		`${validLine}${validLine}`,
		`${pinAlias} ssh-ed25519 !!!\n`,
		`${pinAlias} ssh-ed25519-cert-v01@openssh.com ${key.toString("base64")}\n`,
		`${pinAlias} ssh-rsa ${key.toString("base64")}\n`,
		`${pinAlias} ssh-rsa ${malformedRsa.toString("base64")}\n`,
		`${pinAlias} ecdsa-sha2-nistp256 ${malformedEcdsa.toString("base64")}\n`,
	];
	for (const content of invalidLines) {
		let probeFile;
		const run = async (_executable, args) => {
			if (args[0] === "-G") return { exitCode: 0, stdout: config };
			probeFile = pinFile(args);
			await writeFile(probeFile, content, "utf8");
			return { exitCode: 0, stdout: "" };
		};
		await assert.rejects(verifyDraftSshHost(route, pinAlias, { client: clientFor(run) }), /SSH_HOST_KEY_INVALID/, content);
		await assertRemoved(probeFile);
	}
});

test("rejects oversized temporary host keys and removes the file", async () => {
	let probeFile;
	const run = async (_executable, args) => {
		if (args[0] === "-G") return { exitCode: 0, stdout: config };
		probeFile = pinFile(args);
		await writeFile(probeFile, Buffer.alloc(16 * 1024 + 1, 65));
		return { exitCode: 0, stdout: "" };
	};
	await assert.rejects(verifyDraftSshHost(route, pinAlias, { client: clientFor(run) }), /SSH_HOST_KEY_INVALID/);
	await assertRemoved(probeFile);
});

test("rejects a symlinked temporary host key", { skip: process.platform === "win32" }, async () => {
	let probeFile;
	const run = async (_executable, args) => {
		if (args[0] === "-G") return { exitCode: 0, stdout: config };
		probeFile = pinFile(args);
		const target = join(dirname(probeFile), "real_key");
		await writeFile(target, validLine, "utf8");
		await symlink(target, probeFile);
		return { exitCode: 0, stdout: "" };
	};
	await assert.rejects(verifyDraftSshHost(route, pinAlias, { client: clientFor(run) }), /SSH_HOST_KEY_INVALID/);
	await assertRemoved(probeFile);
});

test("does not open a temporary pin reported as a symlink", async () => {
	const realFs = await import("node:fs/promises");
	let opened = false;
	const { verifyDraftSshHost: verify } = loadTsCommonJs("src/main/remote/SshHostVerifier.ts", {
		stubs: {
			"node:fs/promises": {
				...realFs,
				lstat: async () => ({ isFile: () => false, isSymbolicLink: () => true, size: validLine.length }),
				open: async () => {
					opened = true;
					throw new Error("must not open a symlink");
				},
			},
		},
	});
	let probeFile;
	const run = async (_executable, args) => {
		if (args[0] === "-G") return { exitCode: 0, stdout: config };
		probeFile = pinFile(args);
		await writeFile(probeFile, validLine, "utf8");
		return { exitCode: 0, stdout: "" };
	};
	await assert.rejects(verify(route, pinAlias, { client: clientFor(run) }), /SSH_HOST_KEY_INVALID/);
	assert.equal(opened, false);
	await assertRemoved(probeFile);
});

test("rejects a config query that did not resolve PiDeck's fixed pin alias", async () => {
	const run = async () => ({ exitCode: 0, stdout: config.replace(`hostkeyalias ${pinAlias}`, "hostkeyalias config-alias") });
	await assert.rejects(verifyDraftSshHost(route, pinAlias, { client: clientFor(run) }), /SSH_HOST_ROUTE_CHANGED/);
});

test("rejects route changes between config resolution and authentication", async () => {
	let queries = 0;
	let probeFile;
	const run = async (_executable, args) => {
		if (args[0] === "-G") return { exitCode: 0, stdout: queries++ === 0 ? config : config.replace("hostname example.invalid", "hostname changed.invalid") };
		probeFile = pinFile(args);
		await writeFile(probeFile, validLine, "utf8");
		return { exitCode: 0, stdout: "" };
	};
	await assert.rejects(verifyDraftSshHost(route, pinAlias, { client: clientFor(run) }), /SSH_HOST_ROUTE_CHANGED/);
	await assertRemoved(probeFile);
});

test("maps OpenSSH execution failures to stable, redacted errors", async () => {
	for (const [code, expected] of [
		["ETIMEDOUT", "SSH_HOST_COMMAND_TIMEOUT"],
		["ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "SSH_HOST_COMMAND_OUTPUT_TOO_LARGE"],
		["ENOENT", "SSH_CLIENT_UNAVAILABLE"],
	]) {
		const realFs = await import("node:fs");
		// execFile now lives in the client runtime, together with the fs checks that accept the path.
		const stubs = {
			"node:child_process": { execFile: (_executable, _args, _options, callback) => callback(Object.assign(new Error("sensitive stderr"), { code }), "", "sensitive stderr") },
			"node:fs": { ...realFs, lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }), openSync: () => 3, closeSync: () => undefined },
		};
		const { createSshClientRuntime } = loadTsCommonJs("src/main/remote/SshClientRuntime.ts", { stubs });
		const { verifyDraftSshHost: verify } = loadTsCommonJs("src/main/remote/SshHostVerifier.ts", { stubs });
		const client = createSshClientRuntime({ sshPath: fakeSshPath });
		await assert.rejects(client.run(client.sshPath, ["-G", "work"]), (error) => error.message === expected);
		await assert.rejects(verify(route, pinAlias, { client }), (error) => error.message === expected);
	}
});

test("refuses to return a candidate when temporary pin cleanup reports failure", async () => {
	const realFs = await import("node:fs/promises");
	const { verifyDraftSshHost: verify } = loadTsCommonJs("src/main/remote/SshHostVerifier.ts", {
		stubs: {
			"node:fs/promises": {
				...realFs,
				rm: async (...args) => {
					await realFs.rm(...args);
					throw new Error("sensitive temp location");
				},
			},
		},
	});
	let probeFile;
	const run = async (_executable, args) => {
		if (args[0] === "-G") return { exitCode: 0, stdout: config };
		probeFile = pinFile(args);
		await writeFile(probeFile, validLine, "utf8");
		return { exitCode: 0, stdout: "" };
	};
	await assert.rejects(verify(route, pinAlias, { client: clientFor(run) }), (error) => error.message === "SSH_HOST_TEMP_CLEANUP_FAILED");
	await assertRemoved(probeFile);
});

test("refuses invalid aliases, failed config queries, and missing pins", async () => {
	let invoked = false;
	await assert.rejects(
		verifyDraftSshHost(route, "-oProxyCommand=evil", {
			client: clientFor(async () => {
				invoked = true;
				return { exitCode: 0, stdout: config };
			}),
		}),
		/INVALID_SSH_PIN_ALIAS/,
	);
	assert.equal(invoked, false);
	await assert.rejects(verifyDraftSshHost(route, pinAlias, { client: clientFor(async () => ({ exitCode: 255, stdout: config })) }), /INVALID_SSH_ROUTE/);
	let probeFile;
	const run = async (_executable, args) => {
		if (args[0] === "-G") return { exitCode: 0, stdout: config };
		probeFile = pinFile(args);
		return { exitCode: 0, stdout: "" };
	};
	await assert.rejects(verifyDraftSshHost(route, pinAlias, { client: clientFor(run) }), /SSH_HOST_KEY_INVALID/);
	await assertRemoved(probeFile);
});
