import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { runPreparedBootstrap } = loadTsCommonJs("src/main/remote/RemoteBootstrapSession.ts");
const { frozenHelperBundleManifest } = loadTsCommonJs("src/main/remote/RemoteBootstrapDeployment.ts");
const HOST_ID = "b145de8c-6330-45be-8752-f20e8e270150";
const NONCE = "abc12345678901234567";
const SSH = { executable: "/usr/bin/ssh", args: ["-o", `HostKeyAlias=pideck-${HOST_ID}`, "-o", "BatchMode=yes"], env: { PATH: "/usr/bin" }, destination: "10.81.2.15", openSshVersion: "OpenSSH_9.5p1" };
const SCP = { ...SSH, executable: "/usr/bin/scp" };

function fakeBootstrapSession(manifest, overrides = {}) {
	const listeners = new Set();
	const exitListeners = new Set();
	const written = [];
	const stopped = [];
	const emit = (frame) => {
		for (const listener of [...listeners]) listener(JSON.stringify({ v: 1, ...frame }));
	};
	return {
		written,
		stopped,
		emit,
		onStdoutLine(listener) {
			listeners.add(listener);
			if (!overrides.exitBeforeReady || overrides.ready?.op === "error")
				queueMicrotask(() => {
					if (listeners.has(listener)) emit(overrides.ready ?? { op: "ready", protocolVersion: 1, bundleSha256: manifest.bundleSha256, nonce: NONCE, deployRoot: "/home/test/.pideck/remote-host", staging: `.staging-${NONCE}`, stagingMode: "0700" });
				});
			return () => listeners.delete(listener);
		},
		onExit(listener) {
			exitListeners.add(listener);
			if (overrides.exitBeforeReady)
				queueMicrotask(() => {
					for (const cb of exitListeners) cb({ kind: "exited", code: 1, signal: null });
				});
			return () => exitListeners.delete(listener);
		},
		onStderrLine(listener) {
			if (overrides.stderrBeforeExit) queueMicrotask(() => listener("sensitive remote output"));
			return () => {};
		},
		write(line) {
			const frame = JSON.parse(line);
			written.push(frame);
			if (frame.op === "finalize-commit")
				queueMicrotask(() => {
					if (overrides.exitAfterCommit) {
						for (const listener of [...exitListeners]) listener({ kind: "exited", code: 1, signal: null });
					} else emit({ op: "finalized", active: `./bundles/${manifest.bundleSha256}`, files: manifest.files.length });
				});
		},
		async stop(reason) {
			stopped.push(reason);
		},
	};
}

function fakeUploadExit() {
	return {
		onExit(listener) {
			queueMicrotask(() => listener({ kind: "exited", code: 0, signal: null }));
			return () => {};
		},
		onStdoutLine() {
			return () => {};
		},
		onStderrLine() {
			return () => {};
		},
		write() {
			assert.fail("scp has no stdin");
		},
		async stop() {},
	};
}

async function fixture(t, overrides) {
	const root = await mkdtemp(join(tmpdir(), "pideck-bootstrap-session-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const manifest = frozenHelperBundleManifest();
	const session = fakeBootstrapSession(manifest, overrides);
	const starts = [];
	const launcher = {
		async start(request) {
			starts.push(request);
			return request.invocation.executable === "/usr/bin/ssh" ? session : fakeUploadExit();
		},
	};
	const input = { hostId: HOST_ID, generation: 1, nonce: NONCE, expectedBundleSha256: manifest.bundleSha256, sshConnection: SSH, scpConnection: SCP, launcher };
	return { manifest, session, starts, input };
}

test("ready matches nonce and helper manifest before pinned scp and finalize", async (t) => {
	const { manifest, session, starts, input } = await fixture(t);
	const result = await runPreparedBootstrap(input);
	assert.equal(result.bundleSha256, manifest.bundleSha256);
	assert.equal(result.deployRoot, "/home/test/.pideck/remote-host");
	assert.deepEqual(
		starts.map((request) => request.invocation.executable),
		["/usr/bin/ssh", "/usr/bin/scp"],
	);
	assert.equal(starts[0].stdin, true);
	assert.ok(starts[0].timeoutMs >= 270_000, "entry lifetime must cover ready, upload and finalize budgets");
	assert.deepEqual(
		session.written.map((frame) => frame.op),
		["finalize-begin", "finalize-file", "finalize-commit"],
	);
	assert.deepEqual(session.stopped, ["shutdown"]);
});

test("entry exit after finalize commit aborts deployment without awaiting its deadline", async (t) => {
	const { session, starts, input } = await fixture(t, { exitAfterCommit: true });
	await assert.rejects(runPreparedBootstrap(input), /BOOTSTRAP_FINALIZE_UNCONFIRMED/);
	assert.equal(starts.length, 2, "upload completed before the entry exited");
	assert.deepEqual(session.stopped, ["abort"]);
});

test("an scp invocation for another host is rejected before starting the entry", async (t) => {
	const { starts, input } = await fixture(t);
	await assert.rejects(runPreparedBootstrap({ ...input, scpConnection: { ...SCP, destination: "pideck-other-host" } }), /BOOTSTRAP_INPUT_INVALID/);
	assert.equal(starts.length, 0);
});

test("a paired scp invocation with a different pin alias is rejected before starting the entry", async (t) => {
	const { starts, input } = await fixture(t);
	await assert.rejects(runPreparedBootstrap({ ...input, scpConnection: { ...SCP, args: ["-o", "HostKeyAlias=pideck-other-host"] } }), /BOOTSTRAP_INPUT_INVALID/);
	assert.equal(starts.length, 0);
});

test("a wrong ready nonce refuses upload and stops the bootstrap entry", async (t) => {
	const { manifest, session, starts, input } = await fixture(t, { ready: { op: "ready", protocolVersion: 1, bundleSha256: frozenHelperBundleManifest().bundleSha256, nonce: "different123456789012", deployRoot: "/home/test/.pideck/remote-host", staging: ".staging-different123456789012", stagingMode: "0700" } });
	await assert.rejects(runPreparedBootstrap(input), /BOOTSTRAP_READY_INVALID/);
	assert.equal(starts.length, 1);
	assert.deepEqual(session.stopped, ["abort"]);
	assert.equal(manifest.files.length, 1);
});

test("a known entry error before ready keeps its stable code without uploading", async (t) => {
	const { session, starts, input } = await fixture(t, { ready: { op: "error", code: "BOOTSTRAP_DEPLOY_ROOT_INVALID" } });
	await assert.rejects(runPreparedBootstrap(input), /BOOTSTRAP_DEPLOY_ROOT_INVALID/);
	assert.equal(starts.length, 1);
	assert.deepEqual(session.stopped, ["abort"]);
});

test("an unknown entry error before ready is not passed through", async (t) => {
	const { session, starts, input } = await fixture(t, { ready: { op: "error", code: "UNRECOGNIZED_REMOTE_CODE" } });
	await assert.rejects(runPreparedBootstrap(input), /BOOTSTRAP_READY_INVALID/);
	assert.equal(starts.length, 1);
	assert.deepEqual(session.stopped, ["abort"]);
});

test("a queued entry error wins over a queued exit after the child has settled", async (t) => {
	const { session, starts, input } = await fixture(t, { ready: { op: "error", code: "BOOTSTRAP_DEPLOY_ROOT_INVALID" }, exitBeforeReady: true });
	await assert.rejects(runPreparedBootstrap(input), /BOOTSTRAP_DEPLOY_ROOT_INVALID/);
	assert.equal(starts.length, 1);
	assert.deepEqual(session.stopped, ["abort"]);
});

test("an entry exit without a frame reports only bounded exit metadata", async (t) => {
	const { session, starts, input } = await fixture(t, { exitBeforeReady: true, stderrBeforeExit: true });
	await assert.rejects(runPreparedBootstrap(input), (error) => {
		assert.equal(error.message, "BOOTSTRAP_READY_UNCONFIRMED");
		assert.equal(error.exitKind, "exited");
		assert.equal(error.exitCode, 1);
		assert.equal(error.stderrSeen, true);
		assert.ok(!JSON.stringify(error).includes("sensitive remote output"));
		return true;
	});
	assert.equal(starts.length, 1);
	assert.deepEqual(session.stopped, ["abort"]);
});

test("an entry exit before ready prevents any scp launch", async (t) => {
	const { session, starts, input } = await fixture(t, { exitBeforeReady: true });
	await assert.rejects(runPreparedBootstrap(input), /BOOTSTRAP_READY_UNCONFIRMED/);
	assert.equal(starts.length, 1);
	assert.deepEqual(session.stopped, ["abort"]);
});
