import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteSftpCapabilityProbe, REMOTE_SFTP_CAPABILITY_PROBE_CODES } = loadTsCommonJs("src/main/remote/RemoteSftpCapabilityProbe.ts");
const { createRemoteSftpCapabilityCache } = loadTsCommonJs("src/main/remote/RemoteSftpCapabilityCache.ts");

const ROOT = "/srv/project";
const BINARY = process.platform === "win32" ? "C:\\tools\\remote-sftp.exe" : "/opt/pideck/remote-sftp";
const BINARY_IDENTITY = "sha256:" + "a".repeat(64);
const INVOCATION = Object.freeze({
	executable: process.platform === "win32" ? "C:\\Windows\\System32\\OpenSSH\\ssh.exe" : "/usr/bin/ssh",
	args: Object.freeze(["-s", "host", "sftp"]),
	env: Object.freeze({}),
});

function success(overrides = {}) {
	return {
		ok: true,
		operation: "probe",
		value: {
			protocolVersion: 1,
			root: ROOT,
			home: "/home/test",
			extensions: { "fsync@openssh.com": "1" },
			...overrides,
		},
	};
}

function createHarness(respond) {
	const calls = { adapters: [], assertions: 0, invocations: 0, sessions: 0 };
	const session = {
		hostId: "11111111-1111-4111-8111-111111111111",
		hostRevision: 7,
		connectionId: "host#manager#1",
		async withSftpInvocation(launch) {
			calls.sessions += 1;
			calls.invocations += 1;
			return launch(INVOCATION, async () => {
				calls.assertions += 1;
				if (session.stale === true) throw new Error("SSH_HOST_NOT_READY");
			});
		},
		stale: false,
	};
	const adapter = async (binaryPath, input, dependencies) => {
		calls.adapters.push({ binaryPath, input, dependencies });
		return respond({ binaryPath, input, dependencies, session, calls });
	};
	const probe = createRemoteSftpCapabilityProbe({ adapter });
	return { adapter, calls, probe, session };
}

function input(harness, cache, overrides = {}) {
	return {
		canonicalRoot: ROOT,
		binaryPath: BINARY,
		binaryIdentity: BINARY_IDENTITY,
		session: harness.session,
		cache,
		...overrides,
	};
}

test("a positive probe is reused only for the exact connection, revision and binary identity", async () => {
	const harness = createHarness(() => success());
	const cache = createRemoteSftpCapabilityCache();

	const first = await harness.probe.ensureProbe(input(harness, cache));
	assert.equal(first.ok, true);
	assert.equal(first.value.root, ROOT);
	assert.equal(harness.calls.adapters.length, 1);
	assert.equal(harness.calls.adapters[0].input.operation, "probe");
	assert.equal(harness.calls.adapters[0].input.root, ROOT);
	assert.equal(harness.calls.adapters[0].input.invocation, INVOCATION);
	assert.equal(harness.calls.assertions, 2, "probe must be fenced before and after the adapter call");

	const cached = await harness.probe.ensureProbe(input(harness, cache));
	assert.deepEqual(cached, first);
	assert.equal(harness.calls.adapters.length, 1, "same-generation positive cache must skip the adapter");

	harness.session.hostRevision += 1;
	await harness.probe.ensureProbe(input(harness, cache));
	assert.equal(harness.calls.adapters.length, 2, "a new helper revision is a new generation");

	harness.session.connectionId = "host#manager#2";
	await harness.probe.ensureProbe(input(harness, cache));
	assert.equal(harness.calls.adapters.length, 3, "a new connection identity is a new generation");

	await harness.probe.ensureProbe(input(harness, cache, { binaryIdentity: "sha256:" + "b".repeat(64) }));
	assert.equal(harness.calls.adapters.length, 4, "a new sidecar build identity is a new capability key");
	assert.equal(cache.size(), 1, "only the current scope is retained");
});

test("negative capability results use the short cache TTL and expose normalized stable codes", async () => {
	let now = 1_000;
	let calls = 0;
	const harness = createHarness(() => {
		calls += 1;
		return { ok: false, code: "SFTP_SUBSYSTEM_UNAVAILABLE" };
	});
	const cache = createRemoteSftpCapabilityCache({ negativeTtlMs: 50, now: () => now });

	const first = await harness.probe.ensureProbe(input(harness, cache));
	assert.deepEqual(JSON.parse(JSON.stringify(first)), { ok: false, code: REMOTE_SFTP_CAPABILITY_PROBE_CODES.subsystemUnavailable });
	assert.equal(cache.size(), 1);
	const second = await harness.probe.ensureProbe(input(harness, cache));
	assert.deepEqual(second, first);
	assert.equal(calls, 1, "negative cache must suppress repeated probes inside the TTL");

	now = 1_050;
	await harness.probe.ensureProbe(input(harness, cache));
	assert.equal(calls, 2, "an expired negative probe is retried");
});

test("subsystem, executor, malformed protocol and other stable failures remain distinguishable", async () => {
	const cases = [
		{ raw: { ok: false, code: "SFTP_SUBSYSTEM_UNAVAILABLE" }, expected: REMOTE_SFTP_CAPABILITY_PROBE_CODES.subsystemUnavailable },
		{ raw: { ok: false, code: "SFTP_BINARY_START_FAILED" }, expected: "SFTP_BINARY_START_FAILED" },
		{ raw: { ok: false, code: "SFTP_PERMISSION_DENIED" }, expected: "SFTP_PERMISSION_DENIED" },
		{ raw: { ok: false, code: "SFTP_RESULT_INVALID" }, expected: REMOTE_SFTP_CAPABILITY_PROBE_CODES.probeInvalid },
		{ raw: { ok: false, code: "not a stable code" }, expected: REMOTE_SFTP_CAPABILITY_PROBE_CODES.probeInvalid },
		{ raw: success({ root: "/srv/other" }), expected: REMOTE_SFTP_CAPABILITY_PROBE_CODES.probeInvalid },
		{ raw: { ok: true, operation: "list", value: { entries: [] } }, expected: REMOTE_SFTP_CAPABILITY_PROBE_CODES.probeInvalid },
	];
	for (const [index, entry] of cases.entries()) {
		const harness = createHarness(() => entry.raw);
		const cache = createRemoteSftpCapabilityCache();
		const result = await harness.probe.ensureProbe(input(harness, cache, { binaryIdentity: "case-" + index }));
		assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: false, code: entry.expected });
	}
});

test("cancellation never writes a positive cache entry, even if the adapter races with success", async () => {
	let resolveAdapter;
	let adapterStarted;
	const started = new Promise((resolve) => {
		adapterStarted = resolve;
	});
	const harness = createHarness(
		() =>
			new Promise((resolve) => {
				resolveAdapter = resolve;
				adapterStarted();
			}),
	);
	const cache = createRemoteSftpCapabilityCache();
	const controller = new AbortController();
	const pending = harness.probe.ensureProbe(input(harness, cache, { signal: controller.signal }));
	await started;
	controller.abort();
	resolveAdapter(success());

	const result = await pending;
	assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: false, code: "SFTP_JOB_CANCELLED" });
	assert.equal(cache.size(), 0, "a cancelled probe is not positive evidence");
	assert.equal(harness.calls.assertions, 2, "the post-probe generation check still runs");
});

test("a generation change during the probe returns the host fence code and writes no positive entry", async () => {
	const harness = createHarness(() => {
		harness.session.stale = true;
		return success();
	});
	const cache = createRemoteSftpCapabilityCache();
	const result = await harness.probe.ensureProbe(input(harness, cache));
	assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: false, code: "SSH_HOST_NOT_READY" });
	assert.equal(cache.size(), 0);
});

test("invalid local input is rejected before a session or adapter is created", async () => {
	const harness = createHarness(() => success());
	const cache = createRemoteSftpCapabilityCache();
	const result = await harness.probe.ensureProbe(input(harness, cache, { binaryPath: "relative/remote-sftp" }));
	assert.deepEqual(JSON.parse(JSON.stringify(result)), { ok: false, code: REMOTE_SFTP_CAPABILITY_PROBE_CODES.inputInvalid });
	assert.equal(harness.calls.sessions, 0);
	assert.equal(harness.calls.adapters.length, 0);
});
