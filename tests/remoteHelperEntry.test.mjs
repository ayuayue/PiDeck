import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/*
 * Integration proof for the frozen remote helper (plan §7.1). The helper is a real child process
 * started from REMOTE_HELPER_INLINE_SOURCE and the client is the production RemoteControlClient: the
 * two sides are only ever driven through each other, so a frame shape that one side changes without
 * the other fails here. Raw writes cover the frames the client is required to refuse to send (a
 * malformed frame, an over-cap frame), and every wait is bounded, because "the helper stopped
 * answering" has to fail the test instead of hanging it.
 */

const { REMOTE_HELPER_CAPABILITIES, REMOTE_HELPER_MAX_CONCURRENT_REQUESTS, REMOTE_HELPER_MAX_ECHO_DELAY_MS, REMOTE_HELPER_MAX_FRAME_BYTES, REMOTE_HELPER_MAX_QUEUED_REQUESTS, REMOTE_HELPER_METHOD_CANCEL, REMOTE_HELPER_METHOD_ECHO, REMOTE_HELPER_METHOD_HELLO, REMOTE_HELPER_PROTOCOL_VERSION } =
	loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");
const { REMOTE_HELPER_ENTRY_FILE_NAME, REMOTE_HELPER_ENTRY_SHA256, REMOTE_HELPER_ENTRY_VERSION, REMOTE_HELPER_INLINE_SOURCE } = loadTsCommonJs("src/main/remote/RemoteHelperEntry.ts");
const { REMOTE_FRAME_DIAGNOSTIC_CODES, createRemoteControlClient } = loadTsCommonJs("src/main/remote/RemoteControlClient.ts");

/** Same host id shape the host store mints; the client only bounds it by length and control bytes. */
const HOST_ID = "01234567-89ab-4def-8123-456789abcdef";
/** The helper never resolves HOME into a path, so a POSIX literal is the honest fixture on any platform. */
const HELPER_HOME = "/home/pideck-helper";
/** Frozen digest, pinned here as well as in the module: editing the source means editing both. */
const FROZEN_SHA256 = "a03c9e3f46a56adc162bde0a8e7b57ec616c57fef0fe96114d38fcd2d548b061";
const MAX_TEXT = 4096;
const TEST_TIMEOUT_MS = 30_000;
const GUARD_TIMEOUT_MS = 10_000;
const DROP_CODES = new Set(Object.values(REMOTE_FRAME_DIAGNOSTIC_CODES));

/** Every test drives real child processes, so each one carries a hard deadline of its own. */
const helperTest = (name, fn) => test(name, { timeout: TEST_TIMEOUT_MS }, fn);

/** Production objects live in another VM realm, so deep comparisons are normalised through JSON. */
const plain = (value) => JSON.parse(JSON.stringify(value));

function delay(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/** Bound one await: a helper that stops answering must fail the test, never stall the runner. */
function guard(promise, label, timeoutMs = GUARD_TIMEOUT_MS) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/** `await` on a rejecting promise: the outcome is returned instead of thrown (cross-realm safe). */
async function rejection(promise) {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the promise to reject");
}

/**
 * One real helper process plus the production client that speaks to it. `sent` keeps every outbound
 * line, `frames` every inbound line that parsed, and `diagnostics` what the client refused to use, so a
 * test can assert both the protocol traffic and the client side verdict on it.
 */
function startHelper(t, options = {}) {
	const env = { ...process.env };
	if (options.home === null) delete env.HOME;
	else env.HOME = options.home ?? HELPER_HOME;
	const argv = options.entryPath === undefined ? ["-e", REMOTE_HELPER_INLINE_SOURCE] : [options.entryPath];
	const child = spawn(process.execPath, argv, { env, stdio: ["pipe", "pipe", "pipe"] });
	const sent = [];
	const lines = [];
	const frames = [];
	const diagnostics = [];
	const frameWaiters = new Set();
	const exitWaiters = new Set();
	let buffered = "";
	let stderr = "";
	let exitCode = null;
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	// A helper that has already exited turns the next write into an EPIPE event; without this listener
	// the test process would crash instead of reporting the protocol failure under test.
	child.stdin.on("error", () => {});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const client = createRemoteControlClient({
		hostId: HOST_ID,
		send: (line) => {
			sent.push(line);
			child.stdin.write(`${line}\n`);
		},
		onDiagnostic: (entry) => {
			diagnostics.push(plain(entry));
		},
	});
	client.openConnection();
	child.stdout.on("data", (chunk) => {
		buffered += chunk;
		let index;
		while ((index = buffered.indexOf("\n")) >= 0) {
			const line = buffered.slice(0, index);
			buffered = buffered.slice(index + 1);
			lines.push(line);
			try {
				frames.push(JSON.parse(line));
			} catch {
				// A stdout line that is not JSON is itself a finding; the raw line stays in `lines`.
			}
			client.handleLine(line);
			for (const waiter of [...frameWaiters]) waiter();
		}
	});
	child.on("exit", (code) => {
		exitCode = code;
		for (const waiter of [...exitWaiters]) waiter();
	});
	t.after(() => {
		client.closeConnection();
		child.stdin.destroy();
		child.kill();
	});

	/** Resolves once at least `count` frames were received; the caller asserts on the new ones. */
	function waitForFrames(count, label, timeoutMs = GUARD_TIMEOUT_MS) {
		if (frames.length >= count) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				frameWaiters.delete(onFrame);
				reject(new Error(`timed out waiting for ${label}`));
			}, timeoutMs);
			const onFrame = () => {
				if (frames.length < count) return;
				clearTimeout(timer);
				frameWaiters.delete(onFrame);
				resolve();
			};
			frameWaiters.add(onFrame);
		});
	}

	/** Resolves with the exit code; a helper that never exits fails instead of hanging. */
	function waitForExit(timeoutMs = GUARD_TIMEOUT_MS) {
		if (exitCode !== null) return Promise.resolve(exitCode);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				exitWaiters.delete(onExit);
				reject(new Error("the helper did not exit in time"));
			}, timeoutMs);
			const onExit = () => {
				clearTimeout(timer);
				exitWaiters.delete(onExit);
				resolve(exitCode);
			};
			exitWaiters.add(onExit);
		});
	}

	return {
		child,
		client,
		sent,
		lines,
		frames,
		diagnostics,
		stderr: () => stderr,
		/** Nth outbound frame (0 based), which is how a test learns the id the client minted. */
		requestIdAt(index) {
			const frame = JSON.parse(sent[index]);
			assert.ok(typeof frame.id === "string" && frame.id.length > 0, `no id in outbound frame ${index}`);
			return frame.id;
		},
		/** Raw protocol access: exactly one frame followed by its terminator. */
		writeLine(text) {
			child.stdin.write(`${text}\n`);
		},
		/** Raw protocol access without a terminator: the framing cap has to catch this on its own. */
		writeChunk(text) {
			child.stdin.write(text);
		},
		endStdin() {
			child.stdin.end();
		},
		waitForFrames,
		waitForExit,
	};
}

helperTest("the frozen helper source is one byte-frozen ASCII line", () => {
	// The helper is uploaded as a content-addressed artifact, so its bytes are the deployment identity:
	// an edit is only legitimate together with a deliberate update of both digests below.
	const digest = createHash("sha256").update(REMOTE_HELPER_INLINE_SOURCE, "utf8").digest("hex");
	assert.equal(digest, FROZEN_SHA256, "the frozen helper source changed: update REMOTE_HELPER_ENTRY_SHA256 and this digest in the same commit");
	assert.equal(digest, REMOTE_HELPER_ENTRY_SHA256, "the exported digest must describe the exported source");
	assert.equal(Buffer.byteLength(REMOTE_HELPER_INLINE_SOURCE, "utf8"), REMOTE_HELPER_INLINE_SOURCE.length, "the source stays printable ASCII");
	assert.ok(!/[\r\n]/.test(REMOTE_HELPER_INLINE_SOURCE), "the source is one line");
	assert.ok(!/[\u0000-\u001f\u007f]/.test(REMOTE_HELPER_INLINE_SOURCE), "no control byte may reach stdin or an argv token");
	assert.ok(!REMOTE_HELPER_INLINE_SOURCE.includes("console."), "stdout carries protocol frames only");
	assert.ok(!REMOTE_HELPER_INLINE_SOURCE.includes("require("), "the helper needs nothing but process and its stdio");
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.length > 1024 && REMOTE_HELPER_INLINE_SOURCE.length < 64 * 1024, `unexpected source size ${REMOTE_HELPER_INLINE_SOURCE.length}`);
});

helperTest("the exported entry identity matches the frozen source", () => {
	assert.equal(REMOTE_HELPER_ENTRY_FILE_NAME, "helper.mjs");
	assert.match(REMOTE_HELPER_ENTRY_VERSION, /^\d+\.\d+\.\d+$/);
	// The frozen source cannot import the contract, so its literals are checked against it here.
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes(`"${REMOTE_HELPER_ENTRY_VERSION}"`), "hello must report REMOTE_HELPER_ENTRY_VERSION");
	for (const token of [REMOTE_HELPER_METHOD_HELLO, REMOTE_HELPER_METHOD_ECHO, REMOTE_HELPER_METHOD_CANCEL]) {
		assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes(`"${token}"`), token);
	}
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes(String(REMOTE_HELPER_MAX_FRAME_BYTES)), "the frame cap must be visible in the frozen source");
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes(String(REMOTE_HELPER_MAX_ECHO_DELAY_MS)), "the echo delay ceiling must be visible in the frozen source");
});

helperTest("hello answers the contract handshake through the production client", async (t) => {
	const session = startHelper(t);
	const result = plain(await guard(session.client.request(REMOTE_HELPER_METHOD_HELLO), "hello"));
	assert.deepEqual(result, {
		protocolVersion: REMOTE_HELPER_PROTOCOL_VERSION,
		platform: process.platform,
		arch: process.arch,
		home: HELPER_HOME,
		capabilities: Array.from(REMOTE_HELPER_CAPABILITIES),
		helperVersion: REMOTE_HELPER_ENTRY_VERSION,
		nodeVersion: process.versions.node,
		pid: session.child.pid,
	});
	// One request, one frame: stdout carries protocol frames and nothing else.
	assert.equal(session.frames.length, 1);
	assert.equal(session.lines.length, session.frames.length, "every stdout line has to be a protocol frame");
	assert.equal(session.frames[0].id, session.requestIdAt(0));
	assert.equal(session.stderr(), "", "the helper never writes stderr text");
});

helperTest("hello fails closed when HOME is not an absolute POSIX path", async (t) => {
	for (const [label, home] of [
		["a relative path", "tmp/pideck-helper-home"],
		["no HOME at all", null],
	]) {
		const session = startHelper(t, { home });
		const error = await rejection(guard(session.client.request(REMOTE_HELPER_METHOD_HELLO), `hello with ${label}`));
		assert.equal(error.code, "HELPER_INTERNAL", label);
		assert.equal(error.retryable, false, label);
		assert.equal(session.frames.length, 1, `${label}: exactly one refusal frame`);
		assert.equal(session.frames[0].error.code, "HELPER_INTERNAL", label);
		assert.equal(session.frames[0].id, session.requestIdAt(0), label);
		const code = await session.waitForExit(6000);
		assert.equal(typeof code, "number", `${label}: the helper must exit on its own`);
		assert.notEqual(code, 0, `${label}: an unusable helper must fail closed`);
	}
});

helperTest("echo round-trips text and defaults through the production client", async (t) => {
	const session = startHelper(t);
	const { client } = session;
	assert.deepEqual(plain(await guard(client.request(REMOTE_HELPER_METHOD_ECHO), "echo without params")), { text: "", delayMs: 0 });
	assert.deepEqual(plain(await guard(client.request(REMOTE_HELPER_METHOD_ECHO, {}), "echo with empty params")), { text: "", delayMs: 0 });
	const text = "协议回显".repeat(4);
	assert.deepEqual(plain(await guard(client.request(REMOTE_HELPER_METHOD_ECHO, { text }), "echo with text")), { text, delayMs: 0 });
	assert.deepEqual(plain(await guard(client.request(REMOTE_HELPER_METHOD_ECHO, { text: "x".repeat(MAX_TEXT) }), "echo at the text ceiling")), { text: "x".repeat(MAX_TEXT), delayMs: 0 });
	// Unknown params stay ignored: forward compatibility is the client's business, not a refusal.
	assert.deepEqual(plain(await guard(client.request(REMOTE_HELPER_METHOD_ECHO, { text: "kept", futureField: 7 }), "echo with an unknown param")), { text: "kept", delayMs: 0 });
	for (const params of [{ text: "x".repeat(MAX_TEXT + 1) }, { text: 7 }, { delayMs: -1 }, { delayMs: 1.5 }, { delayMs: REMOTE_HELPER_MAX_ECHO_DELAY_MS + 1 }, { delayMs: "100" }, { delayMs: null }]) {
		const error = await rejection(guard(client.request(REMOTE_HELPER_METHOD_ECHO, params), `echo with ${JSON.stringify(params)}`));
		assert.equal(error.code, "PROTOCOL_INVALID", JSON.stringify(params));
		assert.equal(error.retryable, false, JSON.stringify(params));
	}
	assert.equal(session.stderr(), "");
});

helperTest("echo honours delayMs as a scheduling probe", async (t) => {
	const session = startHelper(t);
	const startedAt = Date.now();
	const result = plain(await guard(session.client.request(REMOTE_HELPER_METHOD_ECHO, { text: "slow", delayMs: 200 }), "delayed echo"));
	const elapsed = Date.now() - startedAt;
	assert.deepEqual(result, { text: "slow", delayMs: 200 });
	assert.ok(elapsed >= 150, `a 200 ms echo must not answer immediately (took ${elapsed} ms)`);
	// A zero delay is the boundary case of the same field, not a different code path.
	assert.deepEqual(plain(await guard(session.client.request(REMOTE_HELPER_METHOD_ECHO, { delayMs: 0 }), "zero delay echo")), { text: "", delayMs: 0 });
});

helperTest("an unknown method is refused with METHOD_NOT_FOUND", async (t) => {
	const session = startHelper(t);
	const error = await rejection(guard(session.client.request("file.stat", { path: "." }), "unknown method"));
	assert.equal(error.code, "METHOD_NOT_FOUND");
	assert.equal(error.retryable, false);
	const frame = session.frames.at(-1);
	assert.equal(frame.ok, false);
	assert.equal(frame.error.code, "METHOD_NOT_FOUND");
	assert.equal(frame.id, session.requestIdAt(0));
	assert.equal(frame.hostId, HOST_ID);
	// The helper stays usable after a refusal.
	assert.equal(plain(await guard(session.client.request(REMOTE_HELPER_METHOD_HELLO), "hello after a refusal")).protocolVersion, REMOTE_HELPER_PROTOCOL_VERSION);
});

helperTest("a malformed frame is refused with an identity the client drops", async (t) => {
	const session = startHelper(t);
	const generation = session.client.connectionGeneration;
	const cases = [
		{ label: "a line that is not JSON", text: "not json at all", identity: { v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: "", generation: 0, id: "" } },
		{ label: "JSON that is not an object", text: JSON.stringify([1, 2, 3]), identity: { v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: "", generation: 0, id: "" } },
		{ label: "a JSON scalar", text: "42", identity: { v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: "", generation: 0, id: "" } },
		{ label: "a frame without id and method", text: JSON.stringify({ v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: HOST_ID, generation }), identity: { v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: HOST_ID, generation, id: "" } },
		{ label: "another protocol version", text: JSON.stringify({ v: 2, hostId: HOST_ID, generation, id: "req-910", method: REMOTE_HELPER_METHOD_HELLO }), identity: { v: 2, hostId: HOST_ID, generation, id: "req-910" } },
		{ label: "an overlong id", text: JSON.stringify({ v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: HOST_ID, generation, id: "r".repeat(129), method: REMOTE_HELPER_METHOD_HELLO }), identity: { v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: HOST_ID, generation, id: "" } },
		{ label: "a control byte inside the id", text: JSON.stringify({ v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: HOST_ID, generation, id: "req-91\u00071", method: REMOTE_HELPER_METHOD_HELLO }), identity: { v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: HOST_ID, generation, id: "" } },
		{ label: "an empty method", text: JSON.stringify({ v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: HOST_ID, generation, id: "req-911", method: "" }), identity: { v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: HOST_ID, generation, id: "req-911" } },
		{ label: "an overlong method", text: JSON.stringify({ v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: HOST_ID, generation, id: "req-912", method: "m".repeat(65) }), identity: { v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: HOST_ID, generation, id: "req-912" } },
		{ label: "a hostId that is not a string", text: JSON.stringify({ v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: 7, generation, id: "req-913", method: REMOTE_HELPER_METHOD_HELLO }), identity: { v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: "", generation, id: "req-913" } },
		{ label: "an overlong hostId", text: JSON.stringify({ v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: "h".repeat(65), generation, id: "req-914", method: REMOTE_HELPER_METHOD_HELLO }), identity: { v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: "", generation, id: "req-914" } },
		{ label: "a negative generation", text: JSON.stringify({ v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: HOST_ID, generation: -1, id: "req-915", method: REMOTE_HELPER_METHOD_HELLO }), identity: { v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: HOST_ID, generation: 0, id: "req-915" } },
	];
	for (const item of cases) {
		const before = session.frames.length;
		session.writeLine(item.text);
		await session.waitForFrames(before + 1, `a refusal for ${item.label}`);
		const frame = session.frames[before];
		assert.equal(frame.ok, false, item.label);
		assert.equal(frame.error.code, "PROTOCOL_INVALID", item.label);
		assert.equal(frame.error.retryable, false, item.label);
		assert.deepEqual({ v: frame.v, hostId: frame.hostId, generation: frame.generation, id: frame.id }, item.identity, item.label);
	}
	// The client must drop every one of those frames: identity mismatch is how a refusal with no
	// readable identity stays out of a live generation's pending table.
	assert.ok(session.diagnostics.length >= cases.length, `the client recorded ${session.diagnostics.length} drops for ${cases.length} refusals`);
	for (const entry of session.diagnostics) assert.ok(DROP_CODES.has(entry.code), entry.code);
	assert.equal(session.client.pendingCount(), 0);
	assert.equal(session.lines.length, session.frames.length, "every stdout line has to be a protocol frame");
	// One malformed frame can never take the helper down.
	assert.equal(plain(await guard(session.client.request(REMOTE_HELPER_METHOD_HELLO), "hello after malformed frames")).protocolVersion, REMOTE_HELPER_PROTOCOL_VERSION);
	assert.equal(session.stderr(), "");
});

helperTest("a frame above the 8 MiB cap fails closed with PROTOCOL_INVALID", async (t) => {
	const session = startHelper(t);
	const generation = session.client.connectionGeneration;
	const line = `{"v":${REMOTE_HELPER_PROTOCOL_VERSION},"hostId":"${HOST_ID}","generation":${generation},"id":"req-920","method":"${REMOTE_HELPER_METHOD_ECHO}","params":{"text":"x","pad":"${"y".repeat(REMOTE_HELPER_MAX_FRAME_BYTES)}"}}`;
	assert.ok(Buffer.byteLength(line, "utf8") > REMOTE_HELPER_MAX_FRAME_BYTES);
	session.writeLine(line);
	await session.waitForFrames(1, "the over-cap refusal");
	assert.equal(session.frames.length, 1, "an out-of-frame stream is not parsed any further");
	assert.equal(session.frames[0].error.code, "PROTOCOL_INVALID");
	assert.equal(session.frames[0].error.retryable, false);
	assert.equal(session.frames[0].id, "", "nothing could be read from the frame, so no identity is claimed");
	const code = await session.waitForExit(10_000);
	assert.equal(typeof code, "number");
	assert.notEqual(code, 0, "an over-cap frame must end the helper");
	assert.equal(session.stderr(), "");
});

helperTest("an unterminated tail above the cap fails closed without waiting for a newline", async (t) => {
	const session = startHelper(t);
	// stdin stays open on purpose: the cap has to be enforced while the frame is still being read,
	// otherwise a peer that never sends a terminator could grow the buffer without bound.
	session.writeChunk("z".repeat(REMOTE_HELPER_MAX_FRAME_BYTES + 4096));
	await session.waitForFrames(1, "the tail refusal");
	assert.equal(session.frames[0].error.code, "PROTOCOL_INVALID");
	const code = await session.waitForExit(10_000);
	assert.equal(typeof code, "number");
	assert.notEqual(code, 0, "an unbounded tail must end the helper");
});

helperTest("a frame of exactly the cap size is still accepted", async (t) => {
	const session = startHelper(t);
	const frame = JSON.stringify({ v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: HOST_ID, generation: session.client.connectionGeneration, id: "req-930", method: REMOTE_HELPER_METHOD_ECHO, params: { text: "boundary" } });
	const padded = `${frame}${" ".repeat(REMOTE_HELPER_MAX_FRAME_BYTES - Buffer.byteLength(frame, "utf8"))}`;
	assert.equal(Buffer.byteLength(padded, "utf8"), REMOTE_HELPER_MAX_FRAME_BYTES);
	session.writeLine(padded);
	await session.waitForFrames(1, "the answer to a frame at the cap");
	assert.deepEqual(session.frames[0], { v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: HOST_ID, generation: session.client.connectionGeneration, id: "req-930", ok: true, result: { text: "boundary", delayMs: 0 } });
	const code = await session.waitForExit(1500).then(
		() => "exited",
		() => "running",
	);
	assert.equal(code, "running", "an at-the-cap frame is not fatal");
});

helperTest("four requests hold the slots and the rest wait in the queue", async (t) => {
	const session = startHelper(t);
	const { client } = session;
	const slots = REMOTE_HELPER_MAX_CONCURRENT_REQUESTS;
	// Deterministic probe instead of a wall-clock threshold: the helper can only cancel a request that is
	// still waiting, so its cancel answers say where a request sits without relying on scheduling.
	const holding = Array.from({ length: slots }, (_value, index) => client.request(REMOTE_HELPER_METHOD_ECHO, { text: `c${index}`, delayMs: 3_000 }));
	const queued = client.request(REMOTE_HELPER_METHOD_ECHO, { text: "queued", delayMs: 0 });
	queued.catch(() => {});
	const queuedId = session.requestIdAt(slots);
	assert.deepEqual(plain(await guard(client.cancel(queuedId), "cancel of a waiting request")), { cancelled: true });
	const error = await rejection(guard(queued, "the cancelled request"));
	assert.equal(error.code, "REQUEST_CANCELLED");
	// The helper said so itself: a client-side settle is not proof that the request left the remote queue.
	const frame = session.frames.find((candidate) => candidate.id === queuedId && candidate.ok === false);
	assert.equal(frame.error.code, "REQUEST_CANCELLED");

	// A request that already holds a slot cannot be cancelled: the same bound seen from the other side.
	assert.deepEqual(plain(await guard(client.cancel(session.requestIdAt(0)), "cancel of a running request")), { cancelled: false, reason: "already-settled" });

	// Everything that held a slot still answers normally afterwards.
	const results = await guard(Promise.all(holding), "the four scheduled echoes");
	for (const [index, result] of results.entries()) assert.deepEqual(plain(result), { text: `c${index}`, delayMs: 3_000 });
});

helperTest("the waiting room is bounded at 64 and the overflow is refused", async (t) => {
	const session = startHelper(t);
	const total = REMOTE_HELPER_MAX_CONCURRENT_REQUESTS + REMOTE_HELPER_MAX_QUEUED_REQUESTS + 1;
	const promises = [];
	for (let index = 0; index < total; index += 1) {
		promises.push(
			session.client.request(REMOTE_HELPER_METHOD_ECHO, { text: `q${index}`, delayMs: 2000 }).then(
				(result) => ({ index, ok: true, result: plain(result) }),
				(error) => ({ index, ok: false, code: error.code, retryable: error.retryable }),
			),
		);
	}
	const refused = await guard(promises[total - 1], "the overflow refusal", 4000);
	assert.deepEqual(refused, { index: total - 1, ok: false, code: "TOO_MANY_REQUESTS", retryable: true });
	const frame = session.frames.find((candidate) => candidate.id === session.requestIdAt(total - 1));
	assert.equal(frame.ok, false);
	assert.equal(frame.error.code, "TOO_MANY_REQUESTS");
	assert.equal(frame.error.retryable, true);
	// The request just under the limit was queued, not refused: the bound is the queue, not the arrival.
	const queued = await Promise.race([promises[total - 2].then(() => "settled"), delay(150).then(() => "pending")]);
	assert.equal(queued, "pending", "the 68th request must be queued");
	// EOF ends the helper with 68 requests still pending: queued work dies with the process.
	session.client.closeConnection();
	session.endStdin();
	assert.equal(await session.waitForExit(4000), 0);
});

helperTest("cancel takes a queued request out and settles it as REQUEST_CANCELLED", async (t) => {
	const session = startHelper(t);
	const { client } = session;
	const inFlight = [];
	for (let index = 0; index < REMOTE_HELPER_MAX_CONCURRENT_REQUESTS; index += 1) {
		const busy = client.request(REMOTE_HELPER_METHOD_ECHO, { text: `busy${index}`, delayMs: 800 });
		// The connection is closed after this test whether it passed or failed; a late rejection must not
		// surface as an unhandled rejection in the runner.
		busy.catch(() => {});
		inFlight.push(busy);
	}
	const target = client.request(REMOTE_HELPER_METHOD_ECHO, { text: "queued", delayMs: 800 });
	target.catch(() => {});
	const targetId = session.requestIdAt(REMOTE_HELPER_MAX_CONCURRENT_REQUESTS);
	assert.deepEqual(plain(await guard(client.cancel(targetId), "cancel of a queued request")), { cancelled: true });
	const error = await rejection(guard(target, "the cancelled request"));
	assert.equal(error.code, "REQUEST_CANCELLED");
	assert.equal(error.retryable, false);
	// The helper has to have said so itself: the client settling its own pending entry is not proof
	// that the request left the remote queue.
	const frame = session.frames.find((candidate) => candidate.id === targetId && candidate.ok === false);
	assert.equal(frame.error.code, "REQUEST_CANCELLED");
	assert.equal(frame.hostId, HOST_ID);
	await guard(Promise.all(inFlight), "the four in-flight echoes");
});

helperTest("cancel refuses to fake a rollback for an in-flight or settled request", async (t) => {
	const session = startHelper(t);
	const { client } = session;
	const echo = client.request(REMOTE_HELPER_METHOD_ECHO, { text: "kept", delayMs: 400 });
	const echoId = session.requestIdAt(0);
	assert.deepEqual(plain(await guard(client.cancel(echoId), "cancel of an in-flight request")), { cancelled: false, reason: "already-settled" });
	// The refusal must leave the real result intact.
	assert.deepEqual(plain(await guard(echo, "the in-flight echo")), { text: "kept", delayMs: 400 });
	// The same target, now settled: a late cancel is answered by the helper itself, and the client
	// short-circuits that case locally, so this frame is written raw to prove the remote answer.
	session.writeLine(JSON.stringify({ v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: HOST_ID, generation: client.connectionGeneration, id: "req-940", method: REMOTE_HELPER_METHOD_CANCEL, timeoutMs: 1000, params: { requestId: echoId } }));
	await session.waitForFrames(session.frames.length + 1, "the late cancel answer");
	assert.deepEqual(session.frames.at(-1), { v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: HOST_ID, generation: client.connectionGeneration, id: "req-940", ok: true, result: { cancelled: false, reason: "already-settled" } });
});

helperTest("stdin EOF ends the helper with code 0 and drops its pending work", async (t) => {
	const session = startHelper(t);
	const pending = session.client.request(REMOTE_HELPER_METHOD_ECHO, { text: "slow", delayMs: REMOTE_HELPER_MAX_ECHO_DELAY_MS });
	pending.catch(() => {});
	assert.equal(plain(await guard(session.client.request(REMOTE_HELPER_METHOD_HELLO), "hello before EOF")).protocolVersion, REMOTE_HELPER_PROTOCOL_VERSION);
	const startedAt = Date.now();
	session.endStdin();
	// The pending echo asked for 5000 ms: an immediate exit is the proof that no timer outlives stdin.
	assert.equal(await session.waitForExit(2000), 0);
	assert.ok(Date.now() - startedAt < 2000, "EOF must end the helper immediately");
	session.client.closeConnection();
});

helperTest("the uploaded helper.mjs runs the same frozen source", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pideck-helper-entry-"));
	const entryPath = join(directory, REMOTE_HELPER_ENTRY_FILE_NAME);
	await writeFile(entryPath, REMOTE_HELPER_INLINE_SOURCE, "utf8");
	const session = startHelper(t, { entryPath });
	// Registered after the helper, so the child is stopped before Windows tries to remove its file.
	t.after(() => rm(directory, { recursive: true, force: true }));
	const result = plain(await guard(session.client.request(REMOTE_HELPER_METHOD_HELLO), "hello from the uploaded entry"));
	assert.equal(result.helperVersion, REMOTE_HELPER_ENTRY_VERSION);
	assert.equal(result.home, HELPER_HOME);
	assert.deepEqual(result.capabilities, Array.from(REMOTE_HELPER_CAPABILITIES));
	assert.deepEqual(plain(await guard(session.client.request(REMOTE_HELPER_METHOD_ECHO, { text: "file" }), "echo from the uploaded entry")), { text: "file", delayMs: 0 });
	session.endStdin();
	assert.equal(await session.waitForExit(4000), 0);
});
