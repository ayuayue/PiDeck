import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildPinnedSshInvocation } = loadTsCommonJs("src/main/remote/SshVerifiedConnection.ts");
const { buildBootstrapCommand } = loadTsCommonJs("src/main/remote/RemoteBootstrapContract.ts");
const { RemoteHostStore } = loadTsCommonJs("src/main/remote/RemoteHostStore.ts");
const { SshHostPinStore } = loadTsCommonJs("src/main/remote/SshHostPinStore.ts");
const { parseSshResolvedRoute, sshRouteDigest } = loadTsCommonJs("src/main/remote/SshRouteDigest.ts");

function buildBatch(directory, hostId, options) {
	return buildPinnedSshInvocation(directory, hostId, "ssh-batch", options);
}

function sshString(value) {
	const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
	const size = Buffer.alloc(4);
	size.writeUInt32BE(bytes.length);
	return Buffer.concat([size, bytes]);
}

function candidateConfig(id, extra = "") {
	return `hostname server.example.invalid\nuser alice\nport 2222\nhostkeyalias pideck-${id}\ncanonicalizehostname false\n${extra}`;
}

function candidate(id, proxyJump) {
	const alias = `pideck-${id}`;
	const key = Buffer.concat([sshString("ssh-ed25519"), sshString(Buffer.alloc(32, 23))]);
	const bytes = Buffer.from(`${alias} ssh-ed25519 ${key.toString("base64")}\n`);
	return {
		hostName: "server.example.invalid",
		user: "alice",
		port: 2222,
		pinAlias: alias,
		routeDigest: sshRouteDigest(parseSshResolvedRoute({ exitCode: 0, stdout: candidateConfig(id, proxyJump ? `proxyjump ${proxyJump}\n` : "") })),
		knownHostsBase64: bytes.toString("base64"),
		knownHostsSha256: createHash("sha256").update(bytes).digest("hex"),
		hostKeyFingerprints: [`SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`],
	};
}

function option(args, name) {
	return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

const fakeSshPath = process.platform === "win32" ? "C:\\Program Files\\OpenSSH\\ssh.exe" : "/usr/bin/ssh";
const fakeScpPath = process.platform === "win32" ? "C:\\Program Files\\OpenSSH\\scp.exe" : "/usr/bin/scp";
const fakeEnv = { PATH: "C:\\Windows\\System32", USERPROFILE: "C:\\Users\\Tester" };

/** Bind a mock runner to a fake client context; the `-V` self-check is answered centrally. */
function clientFor(run) {
	return {
		sshPath: fakeSshPath,
		scpPath: fakeScpPath,
		env: fakeEnv,
		run: async (executable, args) => {
			assert.equal(executable, fakeSshPath, "preflight must use the resolved ssh path");
			if (args.length === 1 && args[0] === "-V") return { exitCode: 0, stdout: "", stderr: "OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2" };
			return run(executable, args);
		},
	};
}

function strictConfig(id, args, extra = "") {
	const globalFile = process.platform === "win32" ? "NUL" : "/dev/null";
	const identityIndex = args.indexOf("-i");
	const identity = identityIndex === -1 ? "" : `identityfile ${args[identityIndex + 1]}\nidentitiesonly yes\n`;
	return `${candidateConfig(id)}userknownhostsfile ${option(args, "UserKnownHostsFile")}\nglobalknownhostsfile ${globalFile}\nstricthostkeychecking true\ncontrolmaster false\nforwardagent no\nforwardx11 no\nclearallforwardings yes\npermitlocalcommand no\nverifyhostkeydns false\nupdatehostkeys false\nhostkeyalgorithms ssh-ed25519\nbatchmode yes\nnumberofpasswordprompts 0\nconnecttimeout 15\nconnectionattempts 1\nserveraliveinterval 15\nserveralivecountmax 3\n${identity}${extra}`;
}

async function fixture(t, extra = {}, prefix = "pideck pin route-") {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const pinStore = new SshHostPinStore(directory, { verifier: async (route, alias) => candidate(alias.slice("pideck-".length), route.proxyJump) });
	t.after(() => pinStore.dispose());
	const store = await RemoteHostStore.open(directory, { pinStore });
	const profile = await store.createDraft({ label: "Build Pi", sshHost: "work", user: "alice", port: 2222, connectTimeoutMs: 15000, ...extra }, 0);
	const offer = await store.offerPin(profile.id, 7, 1);
	await store.confirmPin({ hostId: profile.id, senderId: 7, requestId: offer.requestId, choice: "approve" }, 1);
	return { directory, profile };
}

function configRunner(id, mutate = () => undefined) {
	const calls = [];
	const run = async (executable, args) => {
		calls.push({ executable, args });
		const strict = option(args, "UserKnownHostsFile") !== undefined;
		const result = await mutate({ executable, args, strict, call: calls.length });
		return result ?? { exitCode: 0, stdout: strict ? strictConfig(id, args) : candidateConfig(id) };
	};
	return { calls, run, client: clientFor(run) };
}

test("fresh candidate and strict queries build pinned SSH/SCP argv per request", async (t) => {
	const { directory, profile } = await fixture(t);
	await assert.rejects(buildPinnedSshInvocation(directory, profile.id, "ssh-batch"), /SSH_HOST_CLIENT_CONTEXT_REQUIRED/);
	const { client, calls } = configRunner(profile.id);
	const invocation = await buildBatch(directory, profile.id, { client });
	assert.equal(invocation.executable, fakeSshPath);
	assert.equal(invocation.env, fakeEnv);
	assert.equal(invocation.openSshVersion, "OpenSSH_for_Windows_9.5p2");
	assert.equal(calls.length, 2);
	assert.equal(calls[0].executable, fakeSshPath);
	assert.equal(calls[0].args[0], "-G");
	assert.equal(calls[0].args.includes(`HostKeyAlias=pideck-${profile.id}`), true);
	assert.equal(
		calls[0].args.some((arg) => arg.startsWith("HostName=")),
		false,
	);
	assert.equal(calls[1].args[0], "-G");
	assert.equal(calls[1].args.includes("StrictHostKeyChecking=yes"), true);
	const sshArgs = Array.from(invocation.args);
	assert.deepEqual(sshArgs.slice(-2), ["--", "work"]);
	assert.equal(sshArgs[0], "-T");
	assert.ok(sshArgs.includes("HostName=server.example.invalid"));
	assert.ok(sshArgs.includes("User=alice"));
	assert.ok(sshArgs.includes("Port=2222"));
	assert.ok(sshArgs.includes("HostKeyAlgorithms=ssh-ed25519"));
	assert.ok(sshArgs.includes("ControlMaster=no"));
	assert.ok(sshArgs.includes("ControlPath=none"));
	assert.ok(sshArgs.includes("StrictHostKeyChecking=yes"));
	assert.ok(sshArgs.includes(`UserKnownHostsFile=${join(directory, "ssh-host-keys", profile.id)}`));
	assert.ok(sshArgs.includes(`GlobalKnownHostsFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`));
	assert.ok(sshArgs.includes("SendEnv=-*"));
	const next = await buildPinnedSshInvocation(directory, profile.id, "scp", { client });
	assert.equal(next.executable, fakeScpPath);
	const scp = Array.from(next.args);
	assert.deepEqual(scp, sshArgs.slice(1, -2));
	assert.equal(scp.includes("-T"), false);
	assert.equal(scp.includes("-tt"), false);
	assert.equal(scp.includes("-O"), false);
	assert.ok(scp.includes("Port=2222"));
	assert.ok(scp.includes("StrictHostKeyChecking=yes"));
	const terminal = await buildPinnedSshInvocation(directory, profile.id, "ssh-terminal", { client });
	assert.equal(terminal.args[0], "-tt");
	assert.deepEqual(Array.from(terminal.args.slice(1, 3)), ["-e", "none"], "terminal bytes must not enter OpenSSH's local escape/forwarding console");
	const command = "cd -- '/repo' && exec /bin/sh -i";
	const interactive = await buildPinnedSshInvocation(directory, profile.id, "ssh-terminal", { client, remoteCommand: command });
	assert.deepEqual(Array.from(interactive.args.slice(-3)), ["--", "work", command]);
	await assert.rejects(buildPinnedSshInvocation(directory, profile.id, "ssh-terminal", { client, remoteCommand: "invalid\ncommand" }), /SSH_REMOTE_COMMAND_INVALID/);
});

test("SFTP requests the subsystem while keeping transport-only flags out of the strict route query", async (t) => {
	const { directory, profile } = await fixture(t);
	const { client, calls } = configRunner(profile.id);
	const invocation = await buildPinnedSshInvocation(directory, profile.id, "ssh-sftp", { client });
	const args = Array.from(invocation.args);
	assert.equal(args[0], "-T");
	assert.equal(args[1], "-s");
	assert.deepEqual(args.slice(-3), ["--", "work", "sftp"]);
	assert.ok(args.includes("StrictHostKeyChecking=yes"));
	const strictQueries = calls.filter((call) => call.args.includes("-G") && option(call.args, "UserKnownHostsFile") !== undefined);
	assert.equal(strictQueries.length, 1);
	assert.equal(strictQueries[0].args.includes("-s"), false);
	assert.equal(strictQueries[0].args.includes("sftp"), false);
	assert.deepEqual(Array.from(strictQueries[0].args.slice(-2)), ["--", "work"]);
	await assert.rejects(buildPinnedSshInvocation(directory, profile.id, "ssh-sftp", { client, remoteCommand: "echo" }), /SSH_REMOTE_COMMAND_NOT_ALLOWED/);
});

test("strict config accepts omitted UpdateHostKeys but never an enabled value", async (t) => {
	const { directory, profile } = await fixture(t);
	const { client: omitted } = configRunner(profile.id, ({ args, strict }) => (strict ? { exitCode: 0, stdout: strictConfig(profile.id, args).replace("updatehostkeys false\n", "") } : undefined));
	await buildPinnedSshInvocation(directory, profile.id, "ssh-batch", { client: omitted });
	const { client: enabled } = configRunner(profile.id, ({ args, strict }) => (strict ? { exitCode: 0, stdout: strictConfig(profile.id, args).replace("updatehostkeys false\n", "updatehostkeys true\n") } : undefined));
	await assert.rejects(buildPinnedSshInvocation(directory, profile.id, "ssh-batch", { client: enabled }), /SSH_HOST_STRICT_CONFIG_INVALID/);
});

test("strict config accepts mixed-case OpenSSH -G directive names", async (t) => {
	const { directory, profile } = await fixture(t);
	const { client } = configRunner(profile.id, ({ args, strict }) => (strict ? { exitCode: 0, stdout: `${strictConfig(profile.id, args)}canonicalizePermittedcnames none\n` } : undefined));
	await buildPinnedSshInvocation(directory, profile.id, "ssh-batch", { client });
});

test("a helper command rides after the destination and only on a batch session", async (t) => {
	const { directory, profile } = await fixture(t);
	const { client, calls } = configRunner(profile.id, ({ args, strict }) => ({ exitCode: 0, stdout: strict ? strictConfig(profile.id, args) : candidateConfig(profile.id) }));
	const command = "'/usr/bin/node' '/home/dev/.pideck/remote-host/bundles/abc/helper.mjs'";
	const batch = await buildPinnedSshInvocation(directory, profile.id, "ssh-batch", { client, remoteCommand: command });
	// The destination stays the operand right after `--`, and the command is one element after it: ssh
	// joins the trailing operands into the remote command, so it must never precede the host.
	const destination = batch.args.indexOf("--");
	assert.equal(batch.args[destination + 1], profile.sshHost);
	assert.equal(batch.args[destination + 2], command);
	assert.equal(batch.args.length, destination + 3);
	// The resolved-config query verifies the route, not the command, so it must not carry it.
	const queries = calls.filter((call) => call.args.includes("-G"));
	assert.equal(queries.length > 0, true);
	for (const query of queries) assert.equal(query.args.includes(command), false, "the strict query must stay command-free");

	// A command on a transfer would silently become another ssh operand; it is refused instead.
	await assert.rejects(buildPinnedSshInvocation(directory, profile.id, "scp", { client, remoteCommand: command }), /SSH_REMOTE_COMMAND_NOT_ALLOWED/);
	for (const bad of ["", "line\nbreak", "nul\u0000byte", "x".repeat(8193)]) {
		await assert.rejects(buildPinnedSshInvocation(directory, profile.id, "ssh-batch", { client, remoteCommand: bad }), /SSH_REMOTE_COMMAND_INVALID/, JSON.stringify(bad.slice(0, 10)));
	}
});

test("a frozen bootstrap command may exceed the helper limit, but arbitrary batch commands cannot", async (t) => {
	const { directory, profile } = await fixture(t);
	const { client } = configRunner(profile.id);
	// target 是冻结的闭集（helper | extensions）：远端扩展快照部署与 helper 共用同一入口。
	const bootstrap = { nodeExecutable: "/usr/bin/node", protocolVersion: 1, bundleSha256: "a".repeat(64), nonce: "0123456789abcdef0123456789abcdef", target: "helper" };
	const expected = buildBootstrapCommand(bootstrap);
	assert.ok(expected.length > 8192);
	const invocation = await buildPinnedSshInvocation(directory, profile.id, "ssh-batch", { client, bootstrap });
	assert.ok(invocation.args.at(-1) === expected);
	await assert.rejects(buildPinnedSshInvocation(directory, profile.id, "ssh-batch", { client, remoteCommand: expected }), /SSH_REMOTE_COMMAND_INVALID/);
	await assert.rejects(buildPinnedSshInvocation(directory, profile.id, "scp", { client, bootstrap }), /SSH_REMOTE_COMMAND_NOT_ALLOWED/);
	await assert.rejects(buildPinnedSshInvocation(directory, profile.id, "ssh-batch", { client, remoteCommand: "echo", bootstrap }), /SSH_REMOTE_COMMAND_INVALID/);
});

test("explicit jump and identity stay in both SSH and SCP without claiming exclusive key selection", async (t) => {
	const identityDirectory = await mkdtemp(join(tmpdir(), "pideck ssh identity-"));
	t.after(() => rm(identityDirectory, { recursive: true, force: true }));
	const identityFile = join(identityDirectory, "id with spaces");
	await writeFile(identityFile, "test-only private-key placeholder\n");
	const { directory, profile } = await fixture(t, { proxyJump: "ops@jump:2200", identityFile });
	const { client, calls } = configRunner(profile.id, ({ args, strict }) => ({ exitCode: 0, stdout: strict ? strictConfig(profile.id, args, "proxyjump ops@jump:2200\n") : candidateConfig(profile.id, "proxyjump ops@jump:2200\n") }));
	const ssh = await buildBatch(directory, profile.id, { client });
	assert.ok(calls[0].args.includes("ops@jump:2200"));
	const sshArgs = Array.from(ssh.args);
	assert.ok(sshArgs.includes("-J"));
	assert.ok(sshArgs.includes("ops@jump:2200"));
	assert.ok(sshArgs.includes("-i"));
	assert.ok(sshArgs.includes(identityFile));
	assert.ok(sshArgs.includes("IdentitiesOnly=yes"));
	const scp = await buildPinnedSshInvocation(directory, profile.id, "scp", { client });
	const scpArgs = Array.from(scp.args);
	assert.ok(scpArgs.includes("-J"));
	assert.ok(scpArgs.includes("ops@jump:2200"));
	assert.ok(scpArgs.includes("IdentitiesOnly=yes"));
});

test("missing or disappearing explicit identity never falls back to config or agent", async (t) => {
	const identityDirectory = await mkdtemp(join(tmpdir(), "pideck ssh key check-"));
	t.after(() => rm(identityDirectory, { recursive: true, force: true }));
	const identityFile = join(identityDirectory, "id with spaces");
	const { directory, profile } = await fixture(t, { identityFile });
	const missing = configRunner(profile.id);
	await assert.rejects(buildBatch(directory, profile.id, { client: missing.client }), /SSH_HOST_IDENTITY_UNAVAILABLE/);
	assert.equal(missing.calls.length, 0);
	await writeFile(identityFile, "test-only private-key placeholder\n");
	const ignored = configRunner(profile.id, ({ args, strict }) => (strict ? { exitCode: 0, stdout: strictConfig(profile.id, args).replace(`identityfile ${identityFile}\n`, "") } : undefined));
	await assert.rejects(buildBatch(directory, profile.id, { client: ignored.client }), /SSH_HOST_STRICT_CONFIG_INVALID/);
	const vanished = configRunner(profile.id, async ({ strict }) => {
		if (strict) await rm(identityFile);
	});
	await assert.rejects(buildBatch(directory, profile.id, { client: vanished.client }), /SSH_HOST_IDENTITY_UNAVAILABLE/);
	assert.equal(vanished.calls.length, 2);
});

test("rejects draft, disabled and unknown profiles before invoking SSH", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pideck ssh draft-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const store = await RemoteHostStore.open(directory);
	const draft = await store.createDraft({ label: "Draft", sshHost: "work", connectTimeoutMs: 15000 }, 0);
	let called = 0;
	const client = clientFor(async () => {
		called += 1;
		throw new Error("unexpected SSH");
	});
	await assert.rejects(buildBatch(directory, draft.id, { client }), /SSH_HOST_NOT_READY/);
	await assert.rejects(buildBatch(directory, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { client }), /SSH_HOST_NOT_READY/);
	const active = await fixture(t);
	const persisted = await RemoteHostStore.open(active.directory);
	await persisted.disable(active.profile.id, 2);
	await assert.rejects(buildBatch(active.directory, active.profile.id, { client }), /SSH_HOST_NOT_READY/);
	assert.equal(called, 0);
});

test("rejects alias retargeting, jump changes, malformed config and forwarded environment", async (t) => {
	const { directory, profile } = await fixture(t);
	for (const changed of [
		candidateConfig(profile.id).replace("server.example.invalid", "attacker.example.invalid"),
		candidateConfig(profile.id).replace("user alice", "user eve"),
		candidateConfig(profile.id).replace("port 2222", "port 2200"),
		candidateConfig(profile.id, "proxyjump jump\n"),
		candidateConfig(profile.id, "proxycommand ssh -W %h:%p jump\n"),
		candidateConfig(profile.id, "sendenv SECRET\n"),
		candidateConfig(profile.id, "setenv SECRET=1\n"),
		"bad config\n",
	]) {
		const runner = configRunner(profile.id, () => ({ exitCode: 0, stdout: changed }));
		await assert.rejects(buildBatch(directory, profile.id, { client: runner.client }));
		assert.equal(runner.calls.length, 1);
	}
	const rotated = configRunner(profile.id, ({ strict, args }) => ({ exitCode: 0, stdout: `${strict ? strictConfig(profile.id, args) : candidateConfig(profile.id)}identityfile /new/key\n` }));
	await buildBatch(directory, profile.id, { client: rotated.client });
});

test("rejects effective strict-setting drift and percent-token local paths", async (t) => {
	const { directory, profile } = await fixture(t);
	for (const config of ["sendenv SECRET\n", "setenv SECRET=1\n", "controlmaster yes\n", "stricthostkeychecking no\n", "userknownhostsfile /tmp/other\n", "batchmode no\n", "numberofpasswordprompts 3\n", "connecttimeout 0\n", "serveraliveinterval 0\n"]) {
		const runner = configRunner(profile.id, ({ args, strict }) => (strict ? { exitCode: 0, stdout: strictConfig(profile.id, args, config) } : undefined));
		await assert.rejects(buildBatch(directory, profile.id, { client: runner.client }));
		assert.equal(runner.calls.length, 2);
	}
	// identityFile 含 ssh token（如 %h）会在首次握手（offerPin）就被拒绝：私钥路径会原样交给 ssh，
	// 不能等到建连时才校验。
	await assert.rejects(fixture(t, { identityFile: join(tmpdir(), "id%h") }), /INVALID_SSH_LOCAL_PATH/);
	const { directory: tokenDirectory, profile: tokenProfile } = await fixture(t, {}, "pideck pin%h-");
	const tokenRunner = configRunner(tokenProfile.id);
	await assert.rejects(buildBatch(tokenDirectory, tokenProfile.id, { client: tokenRunner.client }), /INVALID_SSH_LOCAL_PATH/);
	assert.equal(tokenRunner.calls.length, 0);
});

test("damaged pin inventory, held locks and backup recovery block SSH before a query", async (t) => {
	for (const situation of ["missing-pin", "changed-pin", "orphan-pin", "held-lock", "invalid-backup", "backup-only"]) {
		const { directory, profile } = await fixture(t);
		const pinPath = join(directory, "ssh-host-keys", profile.id);
		if (situation === "missing-pin") await rm(pinPath);
		if (situation === "changed-pin") await writeFile(pinPath, "tampered\n");
		if (situation === "orphan-pin") await writeFile(join(directory, "ssh-host-keys", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), "orphan\n");
		if (situation === "held-lock") await writeFile(join(directory, "remote-hosts.json.lock"), "busy\n");
		if (situation === "invalid-backup") await writeFile(join(directory, "remote-hosts.json.bak"), "broken backup");
		if (situation === "backup-only") await writeFile(join(directory, "remote-hosts.json"), "broken primary");
		const runner = configRunner(profile.id);
		await assert.rejects(buildBatch(directory, profile.id, { client: runner.client }), /SSH_HOST_NOT_READY/, situation);
		assert.equal(runner.calls.length, 0, situation);
	}
});

test("a pending rebind journal or transaction lock blocks pinned SSH before config queries", async (t) => {
	for (const blocker of ["remote-host-rebind.json", "remote-host-rebind.lock"]) {
		const { directory, profile } = await fixture(t);
		const hostFile = join(directory, "remote-hosts.json");
		const pinFile = join(directory, "ssh-host-keys", profile.id);
		await writeFile(join(directory, blocker), "pending\n");
		const beforeHost = await readFile(hostFile);
		const beforePin = await readFile(pinFile);
		const runner = configRunner(profile.id);
		await assert.rejects(buildBatch(directory, profile.id, { client: runner.client }), /SSH_HOST_NOT_READY/, blocker);
		assert.equal(runner.calls.length, 0, blocker);
		assert.deepEqual(await readFile(hostFile), beforeHost);
		assert.deepEqual(await readFile(pinFile), beforePin);
	}
});

test("a rebind journal appearing during route checks blocks the final invocation", async (t) => {
	const { directory, profile } = await fixture(t);
	const hostFile = join(directory, "remote-hosts.json");
	const beforeHost = await readFile(hostFile);
	const runner = configRunner(profile.id, async ({ strict }) => {
		if (strict) await writeFile(join(directory, "remote-host-rebind.json"), "pending\n");
	});
	await assert.rejects(buildBatch(directory, profile.id, { client: runner.client }), /SSH_HOST_NOT_READY/);
	assert.equal(runner.calls.length, 2);
	assert.deepEqual(await readFile(hostFile), beforeHost);
});

test("rejects pin and profile changes during or before config queries", async (t) => {
	const { directory, profile } = await fixture(t);
	const pinPath = join(directory, "ssh-host-keys", profile.id);
	const badPin = await readFile(pinPath);
	badPin[badPin.length - 2] ^= 1;
	const tamper = configRunner(profile.id, async ({ strict }) => {
		if (strict) await writeFile(pinPath, badPin);
	});
	await assert.rejects(buildBatch(directory, profile.id, { client: tamper.client }), /SSH_HOST_NOT_READY/);
	assert.equal(tamper.calls.length, 2);
	const { directory: secondDirectory, profile: secondProfile } = await fixture(t);
	const disable = configRunner(secondProfile.id, async ({ strict }) => {
		if (!strict) {
			const other = await RemoteHostStore.open(secondDirectory);
			await other.disable(secondProfile.id, 2);
		}
	});
	await assert.rejects(buildBatch(secondDirectory, secondProfile.id, { client: disable.client }), /SSH_HOST_NOT_READY/);
});

test("password mode allows exactly one askpass prompt and never claims batch mode", async (t) => {
	const { directory, profile } = await fixture(t);
	const passwordConfig = (args) => strictConfig(profile.id, args).replace("batchmode yes", "batchmode no").replace("numberofpasswordprompts 0", "numberofpasswordprompts 1");
	const { client, calls } = configRunner(profile.id, ({ args, strict }) => (strict ? { exitCode: 0, stdout: passwordConfig(args) } : undefined));
	const invocation = await buildPinnedSshInvocation(directory, profile.id, "ssh-batch", { client, password: true });
	const sshArgs = Array.from(invocation.args);
	assert.ok(sshArgs.includes("BatchMode=no"));
	assert.ok(sshArgs.includes("NumberOfPasswordPrompts=1"));
	assert.ok(sshArgs.includes("PreferredAuthentications=password"));
	// The pin, the strict config and the host-key policy are unchanged by the password method.
	assert.ok(sshArgs.includes("StrictHostKeyChecking=yes"));
	assert.ok(sshArgs.includes(`UserKnownHostsFile=${join(directory, "ssh-host-keys", profile.id)}`));
	// The strict query carries the same expectation, otherwise a batch-mode config would be accepted.
	assert.equal(calls[1].args.includes("NumberOfPasswordPrompts=1"), true);

	// A client that carries an askpass bridge selects the mode by itself: every invocation of that host must
	// ask, otherwise the bridge would never be used and the connection would fail as BatchMode.
	const wrapped = { ...client, env: { ...client.env, SSH_ASKPASS: "/tmp/askpass", SSH_ASKPASS_REQUIRE: "force" } };
	const implied = await buildPinnedSshInvocation(directory, profile.id, "ssh-batch", { client: wrapped });
	assert.ok(Array.from(implied.args).includes("BatchMode=no"));
	// The bridge variables ride in the invocation environment, never in argv.
	assert.equal(implied.env.SSH_ASKPASS, "/tmp/askpass");
	assert.equal(
		Array.from(implied.args).some((arg) => arg.includes("askpass")),
		false,
	);
});

// 旧版本会把 `~/.ssh/config` 里 `IdentityFile` 的原样值（含 OpenSSH token）写进 store。
// 这类数据只该让**这一条连接**不可用，不该把整份 host store 判成损坏。
test("已保存的 profile 里 identityFile 带 %h：读盘不算损坏，连接时按本机路径拒绝", async (t) => {
	const { directory, profile } = await fixture(t);
	const hostFile = join(directory, "remote-hosts.json");
	const snapshot = JSON.parse(await readFile(hostFile, "utf8"));
	snapshot.profiles.find((entry) => entry.id === profile.id).identityFile = join(tmpdir(), "id%h");
	await writeFile(hostFile, JSON.stringify(snapshot));
	const { client, calls } = configRunner(profile.id);
	await assert.rejects(buildBatch(directory, profile.id, { client }), /INVALID_SSH_LOCAL_PATH/);
	assert.equal(calls.length, 0, "拒绝必须发生在发起任何配置查询之前");
});
