import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { createManualTimers, createPinnedClient, createPinnedHostFixture, fakeEnv, fakeSshPath, flushMicrotasks, waitFor } from "./helpers/sshPinnedHostFixture.mjs";

const { createSshConnectionManager } = loadTsCommonJs("src/main/remote/SshConnectionManager.ts");
const { createSshProcessLauncher, SSH_LAUNCHER_MAX_OUTPUT_BYTES, SSH_LAUNCHER_MAX_TIMEOUT_MS } = loadTsCommonJs("src/main/remote/SshProcessLauncher.ts");
const { buildHelperRemoteCommand } = loadTsCommonJs("src/main/remote/RemoteHelperCommand.ts");

/**
 * The verified bootstrap result every production call site has to pass on: `deployRoot` comes from the
 * bootstrap ready frame, never from a guessed remote HOME, and the address only has to be a content hash.
 */
const HELPER_SESSION = { nodePath: "/usr/bin/node", deployRoot: "/home/dev/.pideck/remote-host", bundleSha256: "a".repeat(64) };

/**
 * Every manager in this suite is built here, so the mandatory handshake session is stated once; a test
 * that wants the fail-closed path overrides it explicitly (`helperSession: undefined`).
 */
function createManager(options) {
	return createSshConnectionManager({ helperSession: HELPER_SESSION, ...options });
}

/** A legal `hello` result: the manager only has to agree on the protocol version and the platform fields. */
function helloResult(protocolVersion = 1) {
	return { protocolVersion, platform: "linux", arch: "x64", home: "/home/dev", capabilities: ["echo"], helperVersion: "1.0.4", nodeVersion: "v22.14.0", pid: 321 };
}

/** The response frame a fake helper sends for one request frame the manager wrote. */
function helloFrame(request, result) {
	return { v: 1, hostId: request.hostId, generation: request.generation, id: request.id, ok: true, result };
}

/**
 * Waits for a request frame the test itself sent. The manager's own `hello` handshake is recorded too, so
 * a frame is addressed by method (plus an optional index fence) instead of by its position in the array.
 */
async function waitForFrame(protocol, match, label = "the request frame") {
	await waitFor(() => protocol.frames.some(match), { label });
	return protocol.frames.find(match);
}

/**
 * Fake launcher: records requests and hands out controllable handles with manual lifecycle. The handle
 * speaks just enough of the helper protocol for the manager's handshake — `write()` answers the first
 * `hello` of the attempt through the handle's own emitter — so a silent helper is modelled by turning
 * that answer off (`answerHello: false`) rather than by leaving the manager without a transport.
 */
function createFakeLauncher({ answerHello = true, protocolVersion = 1 } = {}) {
	const requests = [];
	const handles = [];
	return {
		requests,
		handles,
		launcher: {
			async start(request) {
				requests.push(request);
				const emitter = new EventEmitter();
				const exits = [];
				const lateCallbacks = [];
				// The manager's handshake is the first `hello` a fresh attempt sends; a later `hello` belongs to a
				// test's own request, so only the first one is answered here.
				let handshakeAnswered = false;
				const handle = {
					pid: 4321,
					stopCalls: [],
					writes: [],
					onExit(listener) {
						exits.push(listener);
						// Survives unsubscribe, like a native "exit" that was already queued when the manager
						// detached: this is what the generation/latch fence has to absorb.
						lateCallbacks.push(listener);
						return () => {
							const index = exits.indexOf(listener);
							if (index >= 0) exits.splice(index, 1);
						};
					},
					onStdoutLine(listener) {
						emitter.on("stdout", listener);
						return () => emitter.off("stdout", listener);
					},
					onStderrLine() {
						return () => undefined;
					},
					write(line) {
						handle.writes.push(line);
						const request = JSON.parse(line);
						if (!answerHello || request.method !== "hello" || handshakeAnswered) return;
						handshakeAnswered = true;
						const frame = helloFrame(request, helloResult(protocolVersion));
						// A real helper answers on stdout asynchronously; a queued microtask keeps the manager from
						// ever observing the answer before the request left.
						queueMicrotask(() => emitter.emit("stdout", JSON.stringify(frame)));
					},
					async stop(reason) {
						handle.stopCalls.push(reason);
						handle.exit({ kind: "stopped", code: null, signal: null });
					},
					exit(exit) {
						for (const listener of [...exits]) listener(exit);
					},
					emitLate(exit) {
						for (const listener of [...lateCallbacks]) listener(exit);
					},
					emitter,
				};
				handles.push(handle);
				return handle;
			},
		},
	};
}

/**
 * Launcher whose processes fail as soon as the manager subscribes. Reporting the exit from a queued
 * microtask keeps the sequence deterministic without racing the preflight's real file I/O.
 */
function createFailingLauncher() {
	const requests = [];
	return {
		requests,
		launcher: {
			async start(request) {
				requests.push(request);
				return {
					pid: 99,
					onExit(listener) {
						void Promise.resolve().then(() => listener({ kind: "failed", code: 255, signal: null }));
						return () => undefined;
					},
					onStdoutLine() {
						return () => undefined;
					},
					onStderrLine() {
						return () => undefined;
					},
					write() {},
					async stop() {},
				};
			},
		},
	};
}

/** Launcher whose start() stays pending until the test releases it, exposing the spawn/abort race. */
function createDeferredLauncher() {
	let releaseStart;
	const started = new Promise((resolve) => (releaseStart = resolve));
	let releaseHandle;
	const handleReady = new Promise((resolve) => (releaseHandle = resolve));
	return {
		started,
		launcher: {
			async start() {
				releaseStart();
				return handleReady;
			},
		},
		release() {
			const handle = {
				pid: 7,
				stopCalls: [],
				onExit() {
					return () => undefined;
				},
				onStdoutLine() {
					return () => undefined;
				},
				onStderrLine() {
					return () => undefined;
				},
				write() {},
				async stop(reason) {
					handle.stopCalls.push(reason);
				},
			};
			releaseHandle(handle);
			return handle;
		},
	};
}

/**
 * Launcher that speaks the helper protocol: it records written frames, lets the test answer them on
 * stdout and keeps the stream subscriptions so teardown paths can be exercised.
 */
function createProtocolLauncher() {
	const frames = [];
	const stdoutListeners = new Set();
	const stderrListeners = new Set();
	const handles = [];
	const emit = (listeners, line) => {
		for (const listener of [...listeners]) listener(line);
	};
	return {
		frames,
		handles,
		launcher: {
			async start() {
				const exitListeners = new Set();
				// One handshake per attempt: the manager's own `hello` is answered here, a test's `hello` is not.
				let handshakeAnswered = false;
				// Kept beyond unsubscribe: a native "exit" that was already queued still reaches the manager,
				// which is exactly the case the attempt-ownership fence has to survive.
				const lateExitListeners = [];
				const handle = {
					pid: 11,
					writes: [],
					stopCalls: [],
					lateDeliveries: 0,
					write(line) {
						handle.writes.push(line);
						const request = JSON.parse(line);
						frames.push(request);
						// Same rule as the plain fake launcher: answer the attempt's own handshake and leave every
						// later frame (including a test's own `hello` request) to the test.
						if (request.method !== "hello" || handshakeAnswered) return;
						handshakeAnswered = true;
						const frame = helloFrame(request, helloResult());
						queueMicrotask(() => emit(stdoutListeners, JSON.stringify(frame)));
					},
					onExit(listener) {
						exitListeners.add(listener);
						lateExitListeners.push(listener);
						return () => exitListeners.delete(listener);
					},
					onStdoutLine(listener) {
						stdoutListeners.add(listener);
						return () => stdoutListeners.delete(listener);
					},
					onStderrLine(listener) {
						stderrListeners.add(listener);
						return () => stderrListeners.delete(listener);
					},
					async stop(reason) {
						handle.stopCalls.push(reason);
					},
					exit(exit) {
						for (const listener of [...exitListeners]) listener(exit);
					},
					emitLate(exit) {
						for (const listener of [...lateExitListeners]) {
							handle.lateDeliveries += 1;
							listener(exit);
						}
					},
				};
				handles.push(handle);
				return handle;
			},
		},
		stdout: (frame) => emit(stdoutListeners, typeof frame === "string" ? frame : JSON.stringify(frame)),
		stderr: (line) => emit(stderrListeners, line),
	};
}

async function connectAndSettle(manager, hostId) {
	const pending = manager.connect(hostId);
	await flushMicrotasks();
	await pending;
	await flushMicrotasks();
	return manager.getState(hostId);
}

test("a pinned session that stays alive reaches ready through the staged phases", async (t) => {
	const { directory, profile } = await createPinnedHostFixture(t);
	const { client, calls } = createPinnedClient(profile.id);
	const fake = createFakeLauncher();
	const manager = createManager({ userDataDir: directory, client, launcher: fake.launcher, stabilityWindowMs: 0, timers: createManualTimers().timers, random: () => 0 });
	t.after(() => manager.dispose());

	const state = await connectAndSettle(manager, profile.id);
	assert.equal(state.state, "ready");
	assert.equal(state.generation, 1);
	assert.equal(fake.requests.length, 1);
	// The launched process is the exact pinned invocation: absolute client path plus sanitized env.
	assert.equal(fake.requests[0].invocation.executable, fakeSshPath);
	assert.deepEqual(JSON.parse(JSON.stringify(fake.requests[0].invocation.env)), fakeEnv);
	assert.equal(fake.requests[0].hostId, profile.id);
	assert.equal(calls.length, 2, "candidate and strict -G queries precede the launch");
	const diagnostics = Array.from(manager.listDiagnostics(profile.id));
	const codes = diagnostics.map((entry) => entry.code);
	assert.ok(codes.includes("SSH_CONNECTION_PREFLIGHT"));
	assert.ok(codes.includes("SSH_PHASE_AUTHENTICATE"));
	// The helper phase is entered with evidence, and `ready` is applied only after the handshake answered.
	assert.ok(codes.includes("SSH_PHASE_HELPER"));
	assert.ok(codes.includes("SSH_HELPER_HANDSHAKE_OK"));
	assert.ok(codes.indexOf("SSH_HELPER_HANDSHAKE_OK") < codes.indexOf("SSH_CONNECTION_READY"), "ready follows the handshake");
	assert.ok(codes.includes("SSH_CONNECTION_READY"));
	// Redaction: nothing recorded may contain a filesystem path or a command line.
	for (const entry of diagnostics) assert.equal((JSON.stringify(entry).match(/[\\/]|ssh -|ProxyCommand/g) ?? []).length, 0, JSON.stringify(entry));
});

test("fatal preflight failures stop at needs-attention without launching a process", async (t) => {
	for (const code of ["SSH_HOST_ROUTE_CHANGED", "SSH_CLIENT_MISSING"]) {
		const { directory, profile } = await createPinnedHostFixture(t);
		const { client } = createPinnedClient(profile.id, () => {
			throw new Error(code);
		});
		const fake = createFakeLauncher();
		const manager = createManager({ userDataDir: directory, client, launcher: fake.launcher, stabilityWindowMs: 0, timers: createManualTimers().timers, random: () => 0 });
		t.after(() => manager.dispose());
		const state = await connectAndSettle(manager, profile.id);
		assert.equal(state.state, "needs-attention", code);
		assert.equal(state.lastCode, code);
		assert.equal(fake.requests.length, 0, code);
		// needs-attention is terminal: an automatic retry event must not move it.
		const again = await connectAndSettle(manager, profile.id);
		assert.equal(again.state, "needs-attention", code);
	}
});

test("transient launch failures retry on the documented ladder and stop when exhausted", async (t) => {
	const { directory, profile } = await createPinnedHostFixture(t);
	const { client } = createPinnedClient(profile.id);
	const failing = createFailingLauncher();
	const manual = createManualTimers();
	const manager = createManager({ userDataDir: directory, client, launcher: failing.launcher, stabilityWindowMs: 0, timers: manual.timers, random: () => 0 });
	t.after(() => manager.dispose());

	const first = await manager.connect(profile.id);
	assert.equal(first.state, "reconnecting");
	assert.equal(manual.live()[0].delayMs, 1000, "first rung of the ladder");
	const exits = Array.from(manager.listDiagnostics(profile.id));
	assert.equal(
		exits.some((entry) => entry.code === "SSH_CONNECTION_LOST" && entry.exitCode === 255),
		true,
	);

	// Fire the ladder: every rung schedules the next one until the retry budget is spent.
	const delays = [];
	for (let index = 0; index < 5; index += 1) {
		const delay = await manual.fireNext();
		if (delay !== undefined) delays.push(delay);
		// Wait for the attempt this rung started to settle back into a new schedule (or the terminal state).
		await waitFor(() => manual.live().length > 0 || manager.getState(profile.id).state === "needs-attention", { label: `rung ${index} to settle` });
	}
	assert.deepEqual(delays, [1000, 2000, 5000, 10000, 30000]);
	assert.equal(manager.getState(profile.id).state, "needs-attention");
	assert.equal(manager.getState(profile.id).lastCode, "SSH_CONNECTION_RETRIES_EXHAUSTED");
	assert.equal(manual.live().length, 0, "no timer may stay armed after giving up");
	assert.equal(failing.requests.length, 6, "one launch per attempt, never more");
});

test("a live session that drops after ready returns to reconnecting", async (t) => {
	const { directory, profile } = await createPinnedHostFixture(t);
	const { client } = createPinnedClient(profile.id);
	const fake = createFakeLauncher();
	const manual = createManualTimers();
	const manager = createManager({ userDataDir: directory, client, launcher: fake.launcher, stabilityWindowMs: 0, timers: manual.timers, random: () => 0 });
	t.after(() => manager.dispose());
	assert.equal((await connectAndSettle(manager, profile.id)).state, "ready");
	fake.handles[0].exit({ kind: "failed", code: 255, signal: null });
	await flushMicrotasks();
	assert.equal(manager.getState(profile.id).state, "reconnecting");
	// A drop from ready starts the ladder at its first rung, because a healthy host reset the counter.
	assert.equal(manual.live()[0].delayMs, 1000);
});

test("abort returns the host to idle without accepting the old attempt, shutdown latches it", async (t) => {
	const { directory, profile } = await createPinnedHostFixture(t);
	const { client } = createPinnedClient(profile.id);
	const fake = createFakeLauncher();
	const manual = createManualTimers();
	const manager = createManager({ userDataDir: directory, client, launcher: fake.launcher, stabilityWindowMs: 0, timers: manual.timers, random: () => 0 });
	assert.equal((await connectAndSettle(manager, profile.id)).state, "ready");
	const generation = manager.getState(profile.id).generation;
	await manager.disconnect(profile.id, "abort");
	assert.deepEqual(fake.handles[0].stopCalls, ["abort"]);
	assert.equal(manual.live().length, 0);
	// Idle again, but the generation moved on so the aborted attempt stays fenced out.
	assert.equal(manager.getState(profile.id).state, "disconnected");
	assert.equal(manager.getState(profile.id).generation, generation);
	// A late native exit that was queued before the unsubscribe must be absorbed by the fence.
	const before = Array.from(manager.listDiagnostics(profile.id)).length;
	fake.handles[0].emitLate({ kind: "failed", code: 255, signal: null });
	await flushMicrotasks();
	assert.equal(manager.getState(profile.id).state, "disconnected");
	assert.equal(Array.from(manager.listDiagnostics(profile.id)).length, before, "a fenced exit adds no diagnostic");
	// ...and the user can simply connect again.
	assert.equal((await connectAndSettle(manager, profile.id)).state, "ready");
	assert.equal(manager.getState(profile.id).generation, generation + 1);

	// App shutdown is different: it latches, so nothing may start a connection afterwards.
	await manager.disconnect(profile.id, "shutdown");
	assert.deepEqual(fake.handles.at(-1).stopCalls, ["shutdown"]);
	const latched = manager.getState(profile.id);
	fake.handles.at(-1).emitLate({ kind: "failed", code: 255, signal: null });
	await flushMicrotasks();
	assert.equal(manager.getState(profile.id).state, latched.state);
	await manager.connect(profile.id);
	assert.equal(manager.getState(profile.id).state, latched.state);
	await manager.dispose();
});

test("aborting while the process is still spawning stops the late handle", async (t) => {
	const { directory, profile } = await createPinnedHostFixture(t);
	const { client } = createPinnedClient(profile.id);
	const deferred = createDeferredLauncher();
	const manager = createManager({ userDataDir: directory, client, launcher: deferred.launcher, stabilityWindowMs: 0, timers: createManualTimers().timers, random: () => 0 });
	t.after(() => manager.dispose());
	const connecting = manager.connect(profile.id);
	await deferred.started;
	await manager.disconnect(profile.id, "abort");
	const handle = deferred.release();
	await connecting;
	// The process started after the caller aborted, so nobody else would ever stop it.
	await waitFor(() => handle.stopCalls.length === 1, { label: "late handle to be stopped" });
	assert.deepEqual(Array.from(handle.stopCalls), ["abort"]);
	assert.equal(manager.getState(profile.id).state, "disconnected");
});

test("carries helper requests over the pinned session and rejects them when the session is not ready", async (t) => {
	const { directory, profile } = await createPinnedHostFixture(t);
	const { client } = createPinnedClient(profile.id);
	const protocol = createProtocolLauncher();
	const manager = createManager({ userDataDir: directory, client, launcher: protocol.launcher, stabilityWindowMs: 0, timers: createManualTimers().timers, random: () => 0 });
	t.after(() => manager.dispose());

	await assert.rejects(manager.request(profile.id, "hello"), /SSH_CONNECTION_NOT_READY/);
	assert.equal((await connectAndSettle(manager, profile.id)).state, "ready");

	// Connect sent exactly one frame — the manager's own handshake — and it was answered before `ready`.
	assert.equal(protocol.frames.length, 1, "only the handshake is sent during connect");
	assert.equal(protocol.frames[0].method, "hello");

	const pending = manager.request(profile.id, "hello", { clientVersion: "0.7.7" });
	// The handshake is a `hello` too, so the test's own frame is located by its params, not by its index.
	const frame = await waitForFrame(protocol, (candidate) => candidate.method === "hello" && candidate.params?.clientVersion === "0.7.7");
	assert.equal(frame.v, 1);
	assert.equal(frame.hostId, profile.id);
	assert.equal(frame.method, "hello");
	assert.deepEqual(frame.params, { clientVersion: "0.7.7" });
	protocol.stdout({ v: 1, hostId: profile.id, generation: frame.generation, id: frame.id, ok: true, result: { protocolVersion: 1, platform: "linux" } });
	assert.deepEqual(JSON.parse(JSON.stringify(await pending)), { protocolVersion: 1, platform: "linux" });

	// The helper may complain on stderr; the text must never reach the redacted diagnostics.
	protocol.stderr("Permission denied: /home/u/.ssh/id_ed25519");
	await flushMicrotasks();
	const diagnostics = Array.from(manager.listDiagnostics(profile.id));
	assert.equal(
		diagnostics.some((entry) => entry.code === "SSH_HELPER_STDERR"),
		true,
	);
	assert.equal(
		diagnostics.some((entry) => JSON.stringify(entry).includes("id_ed25519")),
		false,
	);
	assert.equal(
		diagnostics.some((entry) => JSON.stringify(entry).includes("/home/u")),
		false,
	);

	// A dropped request must not hang: losing the session settles every pending promise once.
	const lost = manager.request(profile.id, "path.list", { root: "/home/u" });
	await waitForFrame(protocol, (candidate) => candidate.method === "path.list", "the second request frame");
	protocol.handles[0].exit({ kind: "failed", code: 255, signal: null });
	await assert.rejects(lost, /REMOTE_CONNECTION_LOST/);
	assert.equal(manager.getState(profile.id).state, "reconnecting");
});

test("a late exit from an aborted attempt cannot tear down the session that replaced it", async (t) => {
	const { directory, profile } = await createPinnedHostFixture(t);
	const { client } = createPinnedClient(profile.id);
	const protocol = createProtocolLauncher();
	const manager = createManager({ userDataDir: directory, client, launcher: protocol.launcher, stabilityWindowMs: 0, timers: createManualTimers().timers, random: () => 0 });
	t.after(() => manager.dispose());

	await connectAndSettle(manager, profile.id);
	const aborted = protocol.handles[0];
	await manager.disconnect(profile.id, "abort");
	assert.equal((await connectAndSettle(manager, profile.id)).state, "ready");
	const live = protocol.handles.at(-1);
	assert.notEqual(live, aborted);

	// A request on the replacement session is in flight while the aborted attempt reports its exit.
	// Both attempts sent their own handshake first, so only a frame after those can be this request.
	const answered = protocol.frames.length;
	const pending = manager.request(profile.id, "hello");
	const frame = await waitForFrame(protocol, (candidate, index) => index >= answered && candidate.method === "hello");
	aborted.emitLate({ kind: "failed", code: 255, signal: null });
	await flushMicrotasks();
	// The late event must actually have reached the manager's exit handler for this test to mean anything.
	assert.equal(aborted.lateDeliveries, 1, "the late exit reached the attempt's exit listener");
	// The replacement must be untouched: still ready, still usable, still stoppable.
	assert.equal(manager.getState(profile.id).state, "ready");
	assert.equal(live.stopCalls.length, 0, "the live process was not stopped by the late exit");
	protocol.stdout({ v: 1, hostId: profile.id, generation: frame.generation, id: frame.id, ok: true, result: { alive: true } });
	assert.deepEqual(JSON.parse(JSON.stringify(await pending)), { alive: true });
	await manager.disconnect(profile.id, "shutdown");
	assert.deepEqual(Array.from(live.stopCalls), ["shutdown"]);
});

test("repeated helper noise cannot flush the connection history", async (t) => {
	const { directory, profile } = await createPinnedHostFixture(t);
	const { client } = createPinnedClient(profile.id);
	const protocol = createProtocolLauncher();
	const manager = createManager({ userDataDir: directory, client, launcher: protocol.launcher, stabilityWindowMs: 0, timers: createManualTimers().timers, random: () => 0 });
	t.after(() => manager.dispose());
	await connectAndSettle(manager, profile.id);
	for (let index = 0; index < 500; index += 1) protocol.stderr(`noise line ${index}`);
	await flushMicrotasks();
	const diagnostics = Array.from(manager.listDiagnostics(profile.id));
	assert.equal(diagnostics.filter((entry) => entry.code === "SSH_HELPER_STDERR").length, 1, "stderr noise is recorded once per generation");
	assert.equal(
		diagnostics.some((entry) => entry.code === "SSH_CONNECTION_READY"),
		true,
		"the ready marker survives the noise",
	);
});

test("user retry leaves needs-attention once the cause is fixed, and skips the armed wait", async (t) => {
	const { directory, profile } = await createPinnedHostFixture(t);
	let broken = true;
	const { client } = createPinnedClient(profile.id, () => {
		if (broken) throw new Error("SSH_CLIENT_MISSING");
	});
	const fake = createFakeLauncher();
	const manual = createManualTimers();
	const manager = createManager({ userDataDir: directory, client, launcher: fake.launcher, stabilityWindowMs: 0, timers: manual.timers, random: () => 0 });
	t.after(() => manager.dispose());

	// needs-attention is terminal: retrying before the cause is fixed must not spawn a process either.
	assert.equal((await connectAndSettle(manager, profile.id)).state, "needs-attention");
	assert.equal(fake.requests.length, 0);
	broken = false;
	const recovered = await manager.retry(profile.id);
	assert.equal(recovered.state, "ready");
	assert.equal(recovered.generation, 2, "the user retry starts a fresh fenced attempt");

	// A ready host that drops arms the ladder; the first retry click may skip that wait entirely.
	fake.handles.at(-1).exit({ kind: "failed", code: 255, signal: null });
	await flushMicrotasks();
	assert.equal(manager.getState(profile.id).state, "reconnecting");
	assert.equal(manual.live().length, 1, "the backoff timer is armed");
	const generation = manager.getState(profile.id).generation;
	const retryPromise = manager.retry(profile.id);
	await flushMicrotasks();
	assert.equal(manager.getState(profile.id).generation, generation + 1, "the retry does not wait for the timer");
	assert.equal(manual.live().length, 0, "the armed timer is cancelled by the immediate retry");
	await retryPromise;
	assert.equal(manager.getState(profile.id).state, "ready");
});

test("a crashed session with a Windows exit code is diagnosed instead of crashing the exit callback", async (t) => {
	const { directory, profile } = await createPinnedHostFixture(t);
	const { client } = createPinnedClient(profile.id);
	const fake = createFakeLauncher();
	const manual = createManualTimers();
	const manager = createManager({ userDataDir: directory, client, launcher: fake.launcher, stabilityWindowMs: 0, timers: manual.timers, random: () => 0 });
	t.after(() => manager.dispose());
	assert.equal((await connectAndSettle(manager, profile.id)).state, "ready");
	// 0xC0000005 is a real Windows crash code and far outside the [-1,255] diagnostic domain.
	fake.handles.at(-1).exit({ kind: "failed", code: 3221225477, signal: null });
	await flushMicrotasks();
	const state = manager.getState(profile.id);
	assert.equal(state.state, "reconnecting", "the loss must still be handled");
	assert.equal(manual.live().length, 1);
	const lost = Array.from(manager.listDiagnostics(profile.id)).filter((entry) => entry.code === "SSH_CONNECTION_LOST");
	assert.ok(lost.length >= 1, "the crash is recorded");
	assert.equal(
		Array.from(manager.listDiagnostics(profile.id)).some((entry) => entry.exitCode !== undefined),
		false,
		"an out-of-domain exit code is dropped, not thrown",
	);
});

test("a session that only ever dies shortly after ready escalates instead of flapping forever", async (t) => {
	const { directory, profile } = await createPinnedHostFixture(t);
	const { client } = createPinnedClient(profile.id);
	const fake = createFakeLauncher();
	const manual = createManualTimers();
	// A frozen clock means every session has ~0 uptime, so all of them count as flaps.
	const manager = createManager({ userDataDir: directory, client, launcher: fake.launcher, stabilityWindowMs: 0, timers: manual.timers, random: () => 0, now: () => 1_000_000 });
	t.after(() => manager.dispose());
	assert.equal((await connectAndSettle(manager, profile.id)).state, "ready");
	for (let round = 0; round < 6; round += 1) {
		fake.handles.at(-1).exit({ kind: "failed", code: 255, signal: null });
		await flushMicrotasks();
		const state = manager.getState(profile.id);
		if (state.state === "needs-attention") break;
		assert.equal(state.state, "reconnecting", `round ${round}`);
		const delay = await manual.fireNext();
		assert.equal(delay, 1000, "a successful connect keeps resetting the ladder, which is why flaps are counted");
		await waitFor(() => manager.getState(profile.id).state === "ready" || manager.getState(profile.id).state === "needs-attention", { label: `round ${round} to settle` });
	}
	const final = manager.getState(profile.id);
	assert.equal(final.state, "needs-attention");
	assert.equal(final.lastCode, "SSH_CONNECTION_UNSTABLE");
	assert.equal(manual.live().length, 0, "escalating must leave no timer armed");
});

test("dispose waits for an in-flight spawn and refuses later connects", async (t) => {
	const { directory, profile } = await createPinnedHostFixture(t);
	const { client } = createPinnedClient(profile.id);
	const deferred = createDeferredLauncher();
	const manager = createManager({ userDataDir: directory, client, launcher: deferred.launcher, stabilityWindowMs: 0, timers: createManualTimers().timers, random: () => 0 });
	const connecting = manager.connect(profile.id).catch(() => undefined);
	await deferred.started;
	// A bare method reference is how app-lifecycle hooks are usually wired; it must still tear down.
	const dispose = manager.dispose;
	let settled = false;
	const disposing = dispose().then(() => {
		settled = true;
	});
	await flushMicrotasks();
	assert.equal(settled, false, "dispose waits for the attempt that is still spawning");
	const handle = deferred.release();
	await disposing;
	await connecting;
	assert.deepEqual(Array.from(handle.stopCalls), ["abort"], "the late process is stopped before dispose resolves");
	await assert.rejects(manager.connect(profile.id), /SSH_CONNECTION_MANAGER_DISPOSED/);
	await assert.rejects(manager.retry(profile.id), /SSH_CONNECTION_MANAGER_DISPOSED/);
});

test("composes with the real launcher: explicit session deadline and exit classification", async (t) => {
	const { directory, profile } = await createPinnedHostFixture(t);
	const { client } = createPinnedClient(profile.id);
	const children = [];
	const real = createSshProcessLauncher({
		spawn: () => {
			const child = new EventEmitter();
			child.pid = 4242;
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			// The manager opens the helper protocol on this session, so the pinned child needs a writable stdin:
			// without one the handshake could not leave and the session could never become ready.
			child.stdin = new EventEmitter();
			child.stdin.write = () => true;
			child.stdin.end = () => undefined;
			child.kill = () => {
				queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
				return true;
			};
			children.push(child);
			queueMicrotask(() => child.emit("spawn"));
			return child;
		},
	});
	const requests = [];
	const launcher = {
		start(request) {
			requests.push(request);
			return real.start(request);
		},
	};
	const manual = createManualTimers();
	const manager = createManager({ userDataDir: directory, client, launcher, stabilityWindowMs: 0, timers: manual.timers, random: () => 0 });
	t.after(() => manager.dispose());
	const connecting = manager.connect(profile.id);
	await waitFor(() => children.length === 1, { label: "the real launcher to spawn" });
	children[0].emit("exit", 255, null);
	await connecting;
	assert.equal(manager.getState(profile.id).state, "reconnecting");
	assert.equal(requests.length, 1);
	// The launcher's own default is a 30s command deadline; a control session must state a longer bound.
	assert.equal(requests[0].timeoutMs, SSH_LAUNCHER_MAX_TIMEOUT_MS);
	assert.equal(requests[0].maxOutputBytes, SSH_LAUNCHER_MAX_OUTPUT_BYTES);
	assert.equal(requests[0].invocation.executable, fakeSshPath);
	// The helper command is the one remote token sequence and travels as the last argv element, directly
	// after the destination: the pinned arguments before it are unchanged, so this asserts the tail.
	assert.equal(requests[0].invocation.args.at(-2), profile.sshHost);
	assert.equal(requests[0].invocation.args.at(-1), buildHelperRemoteCommand(HELPER_SESSION));
	const lost = Array.from(manager.listDiagnostics(profile.id)).filter((entry) => entry.code === "SSH_CONNECTION_LOST");
	assert.ok(lost.length >= 1);
	assert.equal(
		lost.some((entry) => entry.exitCode === 255),
		true,
		"the real launcher's exit code reaches the diagnostic",
	);
});

test("a helper that never answers the handshake is never reported as ready", async (t) => {
	const { directory, profile } = await createPinnedHostFixture(t);
	const { client } = createPinnedClient(profile.id);
	// The process stays alive and simply never answers, so only the manager's own deadline can end it.
	const fake = createFakeLauncher({ answerHello: false });
	const manual = createManualTimers();
	const manager = createManager({ userDataDir: directory, client, launcher: fake.launcher, stabilityWindowMs: 0, handshakeTimeoutMs: 25, timers: manual.timers, random: () => 0 });
	t.after(() => manager.dispose());

	const state = await connectAndSettle(manager, profile.id);
	assert.notEqual(state.state, "ready", "a silent helper must not produce a ready connection");
	assert.equal(state.state, "reconnecting");
	assert.equal(state.lastCode, "REQUEST_TIMEOUT");
	const codes = Array.from(manager.listDiagnostics(profile.id)).map((entry) => entry.code);
	assert.equal(codes.includes("SSH_HELPER_HANDSHAKE_OK"), false);
	assert.equal(codes.includes("SSH_CONNECTION_READY"), false);
	assert.ok(codes.includes("REQUEST_TIMEOUT"), "the local deadline is what ends the attempt");
	// Silence is transient like any other lost session: the ladder's first rung is armed.
	assert.deepEqual(
		manual.live().map((handle) => handle.delayMs),
		[1000],
	);
});

test("a helper that answers another protocol version stops at needs-attention", async (t) => {
	const { directory, profile } = await createPinnedHostFixture(t);
	const { client } = createPinnedClient(profile.id);
	// The uploaded bundle and this build disagree, so the version is the actionable cause: retrying the
	// same bundle could only produce the same answer.
	const fake = createFakeLauncher({ protocolVersion: 2 });
	const manual = createManualTimers();
	const manager = createManager({ userDataDir: directory, client, launcher: fake.launcher, stabilityWindowMs: 0, timers: manual.timers, random: () => 0 });
	t.after(() => manager.dispose());

	const state = await connectAndSettle(manager, profile.id);
	assert.equal(state.state, "needs-attention");
	assert.equal(state.lastCode, "SSH_HELPER_PROTOCOL_MISMATCH");
	const codes = Array.from(manager.listDiagnostics(profile.id)).map((entry) => entry.code);
	assert.ok(codes.includes("SSH_HELPER_PROTOCOL_MISMATCH"));
	assert.equal(codes.includes("SSH_HELPER_HANDSHAKE_OK"), false);
	assert.equal(codes.includes("SSH_CONNECTION_READY"), false);
	assert.equal(manual.live().length, 0, "a protocol mismatch must not arm a retry");
	assert.deepEqual(Array.from(fake.handles[0].stopCalls), ["shutdown"], "the incompatible helper is stopped");
});

test("an attempt without a verified bootstrap session fails closed before launching anything", async (t) => {
	const { directory, profile } = await createPinnedHostFixture(t);
	const { client } = createPinnedClient(profile.id);
	const fake = createFakeLauncher();
	const manual = createManualTimers();
	// `helperSession: undefined` is the unwired caller: a live ssh process must not be mistaken for a
	// verified connection, so the manager reports the missing bootstrap instead of ready.
	const manager = createManager({ userDataDir: directory, client, launcher: fake.launcher, stabilityWindowMs: 0, timers: manual.timers, random: () => 0, helperSession: undefined });
	t.after(() => manager.dispose());

	const state = await connectAndSettle(manager, profile.id);
	assert.equal(state.state, "needs-attention");
	assert.equal(state.lastCode, "SSH_HELPER_NOT_BOOTSTRAPPED");
	assert.equal(fake.requests.length, 0, "nothing may be launched without a bootstrap result");
	assert.equal(manual.live().length, 0);
	// needs-attention is terminal, so even an explicit retry must not start a process.
	await manager.retry(profile.id);
	assert.equal(manager.getState(profile.id).state, "needs-attention");
	assert.equal(fake.requests.length, 0);
});

test("aborting during the handshake is teardown, not a handshake failure", async (t) => {
	const { directory, profile } = await createPinnedHostFixture(t);
	const { client } = createPinnedClient(profile.id);
	// The helper stays silent, so the attempt is suspended inside the handshake when the caller aborts.
	const fake = createFakeLauncher({ answerHello: false });
	const manual = createManualTimers();
	const manager = createManager({ userDataDir: directory, client, launcher: fake.launcher, stabilityWindowMs: 0, timers: manual.timers, random: () => 0 });
	t.after(() => manager.dispose());

	const connecting = manager.connect(profile.id);
	await waitFor(() => fake.handles[0]?.writes.length === 1, { label: "the handshake frame to be written" });
	await manager.disconnect(profile.id, "abort");
	await connecting;

	assert.equal(manager.getState(profile.id).state, "disconnected", "an abort during the handshake returns the host to idle");
	const codes = Array.from(manager.listDiagnostics(profile.id)).map((entry) => entry.code);
	assert.equal(codes.includes("SSH_HELPER_HANDSHAKE_SUPERSEDED"), false, "teardown is not reported as a handshake failure");
	assert.equal(codes.includes("REQUEST_TIMEOUT"), false, "the abort must not wait for the local deadline");
	assert.ok(codes.includes("REQUEST_CANCELLED"), "the pending handshake is settled by the teardown exactly once");
	assert.deepEqual(Array.from(fake.handles[0].stopCalls), ["abort"]);
	assert.equal(manual.live().length, 0, "an abort leaves no retry armed");
});
