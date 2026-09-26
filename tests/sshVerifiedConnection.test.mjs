import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildPinnedSshInvocation } = loadTsCommonJs("src/main/remote/SshVerifiedConnection.ts");
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
	const { directory: identityDirectory, profile: identityProfile } = await fixture(t, { identityFile: join(tmpdir(), "id%h") });
	const identityRunner = configRunner(identityProfile.id);
	await assert.rejects(buildBatch(identityDirectory, identityProfile.id, { client: identityRunner.client }), /INVALID_SSH_LOCAL_PATH/);
	assert.equal(identityRunner.calls.length, 0);
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
