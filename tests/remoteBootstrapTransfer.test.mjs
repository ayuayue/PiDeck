import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildFinalizeFrames, decodeBootstrapResult, runBootstrapFinalize } = loadTsCommonJs("src/main/remote/RemoteBootstrapTransfer.ts");
const { REMOTE_BOOTSTRAP_MAX_FRAME_BYTES } = loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const BUNDLE = "c".repeat(64);

/** Values produced inside the loaded module live in another realm; compare them by structure. */
const plain = (value) => JSON.parse(JSON.stringify(value));

function manifestOf(files = [{ name: "helper.mjs", sha256: SHA_A, bytes: 128 }], bundleSha256 = BUNDLE) {
	return { schemaVersion: 1, bundleSha256, files };
}

/** Session stub: records written frames and lets the test answer with result lines. */
function createSession() {
	const listeners = new Set();
	return {
		frames: [],
		write(line) {
			this.frames.push(JSON.parse(line));
		},
		onStdoutLine(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		emit(frame) {
			const line = typeof frame === "string" ? frame : JSON.stringify(frame);
			for (const listener of [...listeners]) listener(line);
		},
		listenerCount() {
			return listeners.size;
		},
	};
}

test("builds begin/file/commit frames with modes derived from the executable list", () => {
	const frames = buildFinalizeFrames(
		manifestOf([
			{ name: "helper.mjs", sha256: SHA_A, bytes: 128 },
			{ name: "bootstrap.mjs", sha256: SHA_B, bytes: 64 },
		]),
		{ executableNames: ["bootstrap.mjs"] },
	);
	assert.deepEqual(plain(frames.map((line) => JSON.parse(line))), [
		{ v: 1, op: "finalize-begin", files: 2, bundleSha256: BUNDLE },
		{ v: 1, op: "finalize-file", name: "helper.mjs", sha256: SHA_A, bytes: 128, mode: "0600" },
		{ v: 1, op: "finalize-file", name: "bootstrap.mjs", sha256: SHA_B, bytes: 64, mode: "0700" },
		{ v: 1, op: "finalize-commit" },
	]);
	for (const line of frames) {
		assert.equal(line.includes("\n"), false, "the transport appends the newline");
		assert.ok(Buffer.byteLength(line, "utf8") <= REMOTE_BOOTSTRAP_MAX_FRAME_BYTES);
	}
});

test("the largest manifest the codec accepts still fits the entry's frame cap", () => {
	// The framing only works because every accepted entry stays far below the entry's 4096-byte line
	// bound; this proves it for the whole accepted space instead of for one small example.
	const files = Array.from({ length: 256 }, (_value, index) => ({ name: `${"n".repeat(124)}${String(index).padStart(4, "0")}`, sha256: SHA_A, bytes: 1024 }));
	const frames = buildFinalizeFrames(manifestOf(files), { executableNames: [] });
	assert.equal(frames.length, 258, "begin + one frame per file + commit");
	const largest = Math.max(...frames.map((line) => Buffer.byteLength(line, "utf8")));
	assert.ok(largest <= REMOTE_BOOTSTRAP_MAX_FRAME_BYTES, `largest frame was ${largest} bytes`);
});

test("refuses a malformed manifest or an unusable executable list", () => {
	for (const bad of [{ schemaVersion: 2 }, { schemaVersion: 1, bundleSha256: "short", files: [] }, { schemaVersion: 1, bundleSha256: BUNDLE, files: [{ name: "../escape", sha256: SHA_A, bytes: 1 }] }]) {
		assert.throws(() => buildFinalizeFrames(bad), /BUNDLE_MANIFEST_INVALID|BOOTSTRAP_INPUT_INVALID/);
	}
	assert.throws(() => buildFinalizeFrames(manifestOf(), { executableNames: [7] }), /BOOTSTRAP_INPUT_INVALID/);
});

test("decodes result frames strictly and ignores forward-compatible noise", () => {
	const nonce = "0123456789abcdef0123456789abcdef";
	const ready = { v: 1, op: "ready", protocolVersion: 1, bundleSha256: BUNDLE, nonce, deployRoot: "/home/u/.pideck/remote-host", staging: `.staging-${nonce}`, stagingMode: "0700" };
	assert.deepEqual(plain(decodeBootstrapResult(JSON.stringify(ready))), { op: "ready", protocolVersion: 1, bundleSha256: BUNDLE, nonce, deployRoot: "/home/u/.pideck/remote-host", staging: `.staging-${nonce}` });
	assert.deepEqual(plain(decodeBootstrapResult(JSON.stringify({ v: 1, op: "finalized", active: `./bundles/${BUNDLE}`, files: 2 }))), { op: "finalized", active: `./bundles/${BUNDLE}`, files: 2 });
	assert.deepEqual(plain(decodeBootstrapResult(JSON.stringify({ v: 1, op: "aborted", reason: "eof" }))), { op: "aborted", reason: "eof" });
	assert.deepEqual(plain(decodeBootstrapResult(JSON.stringify({ v: 1, op: "error", code: "BOOTSTRAP_FILE_MISMATCH" }))), { op: "error", code: "BOOTSTRAP_FILE_MISMATCH" });
	for (const line of [
		"",
		"not json",
		"[]",
		JSON.stringify({ v: 2, op: "finalized", active: `./bundles/${BUNDLE}`, files: 1 }),
		JSON.stringify({ v: 1, op: "error", code: "not a code" }),
		JSON.stringify({ v: 1, op: "aborted", reason: "because" }),
		JSON.stringify({ v: 1, op: "future-op" }),
		// The ready payload is what tells the upload where to land, so it is validated field by field.
		JSON.stringify({ v: 1, op: "ready" }),
		JSON.stringify({ ...ready, staging: "../../.." }),
		JSON.stringify({ ...ready, deployRoot: "relative/root" }),
		JSON.stringify({ ...ready, nonce: "short" }),
		// A remote must not be able to name another active path or smuggle extra fields.
		JSON.stringify({ v: 1, op: "finalized", active: "/etc", files: 1 }),
		JSON.stringify({ v: 1, op: "finalized", active: `./bundles/${"c".repeat(64)}/../..`, files: 1 }),
		JSON.stringify({ v: 1, op: "finalized", active: `./bundles/${BUNDLE}`, files: 1, extra: true }),
		JSON.stringify({ v: 1, op: "finalized", active: `./bundles/${BUNDLE}`, files: 1.5 }),
	]) {
		assert.equal(decodeBootstrapResult(line), null, line);
	}
});

test("sends the frames in order and resolves on the terminal frame", async () => {
	const session = createSession();
	const pending = runBootstrapFinalize(session, manifestOf());
	assert.equal(session.frames.length, 3, "begin, one file and commit are written immediately");
	assert.equal(session.listenerCount(), 1);
	session.emit({ v: 1, op: "ready" });
	session.emit("garbage");
	session.emit({ v: 1, op: "finalized", active: "./bundles/" + BUNDLE, files: 1 });
	assert.deepEqual(plain(await pending), { status: "finalized", active: "./bundles/" + BUNDLE, files: 1 });
	assert.equal(session.listenerCount(), 0, "the subscription is always released");
});

test("maps the entry's error and abort frames onto outcomes", async () => {
	const failing = createSession();
	const failingRun = runBootstrapFinalize(failing, manifestOf());
	failing.emit({ v: 1, op: "error", code: "BOOTSTRAP_FILE_MISMATCH" });
	assert.deepEqual(plain(await failingRun), { status: "error", code: "BOOTSTRAP_FILE_MISMATCH" });

	const aborted = createSession();
	const abortedRun = runBootstrapFinalize(aborted, manifestOf());
	aborted.emit({ v: 1, op: "aborted", reason: "requested" });
	assert.deepEqual(plain(await abortedRun), { status: "aborted", reason: "requested" });
});

test("times out without leaking the subscription when the entry never answers", async () => {
	const session = createSession();
	const pending = [];
	const timers = {
		setTimeout(handler) {
			pending.push(handler);
			return pending.length;
		},
		clearTimeout() {},
	};
	const run = runBootstrapFinalize(session, manifestOf(), { timers });
	assert.equal(pending.length, 1, "the deadline is armed");
	pending[0]();
	assert.deepEqual(plain(await run), { status: "timeout" });
	assert.equal(session.listenerCount(), 0);
	// A terminal frame that arrives after the deadline must not revive the finished run.
	session.emit({ v: 1, op: "finalized", active: "late", files: 1 });
});

test("a terminal frame that disagrees with the manifest we sent is refused", async () => {
	const other = createSession();
	const otherRun = runBootstrapFinalize(other, manifestOf());
	// Another active path than the one this run declared.
	other.emit({ v: 1, op: "finalized", active: `./bundles/${"d".repeat(64)}`, files: 1 });
	assert.deepEqual(plain(await otherRun), { status: "error", code: "BOOTSTRAP_ACTIVE_CONFLICT" });

	const wrongCount = createSession();
	const wrongCountRun = runBootstrapFinalize(wrongCount, manifestOf());
	wrongCount.emit({ v: 1, op: "finalized", active: `./bundles/${BUNDLE}`, files: 7 });
	assert.deepEqual(plain(await wrongCountRun), { status: "error", code: "BOOTSTRAP_FINALIZE_INCOMPLETE" });
});

test("refuses an executable name that is not part of the manifest", () => {
	// A typo here would silently deploy the entry point as 0600 and only fail later at exec time.
	assert.throws(() => buildFinalizeFrames(manifestOf(), { executableNames: ["typo.mjs"] }), /BOOTSTRAP_INPUT_INVALID/);
	assert.throws(() => buildFinalizeFrames(manifestOf(), { executableNames: ["helper.mjs", "helper.mjs"] }), /BOOTSTRAP_INPUT_INVALID/);
});

test("arming the deadline before subscribing leaves no timer behind for a synchronous answer", async () => {
	const armed = [];
	const timers = {
		setTimeout(handler, delayMs) {
			armed.push({ handler, delayMs });
			return armed.length;
		},
		clearTimeout(handle) {
			armed[handle - 1].cleared = true;
		},
	};
	const session = createSession();
	// Answer inside the subscription call itself, the earliest possible terminal frame.
	session.onStdoutLine = (listener) => {
		listener(JSON.stringify({ v: 1, op: "finalized", active: `./bundles/${BUNDLE}`, files: 1 }));
		return () => undefined;
	};
	const outcome = await runBootstrapFinalize(session, manifestOf(), { timers });
	assert.deepEqual(plain(outcome), { status: "finalized", active: `./bundles/${BUNDLE}`, files: 1 });
	assert.equal(armed.length, 1);
	assert.equal(armed[0].cleared, true, "the deadline is cleared even when the answer arrives synchronously");
});

test("a refused frame rejects with a stable code and releases the subscription", async () => {
	const session = createSession();
	session.write = () => {
		throw new Error("SSH_LAUNCHER_STDIN_UNAVAILABLE");
	};
	await assert.rejects(runBootstrapFinalize(session, manifestOf()), /SSH_LAUNCHER_STDIN_UNAVAILABLE/);
	assert.equal(session.listenerCount(), 0);

	// Text that is not a stable code must never surface as the rejection message.
	const noisy = createSession();
	noisy.write = () => {
		throw new Error("EPIPE writing to C:\\Users\\me\\.ssh\\key");
	};
	await assert.rejects(runBootstrapFinalize(noisy, manifestOf()), (error) => error.message === "BOOTSTRAP_INPUT_INVALID");
});
