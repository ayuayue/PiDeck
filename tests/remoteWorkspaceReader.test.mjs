import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteWorkspaceReader, REMOTE_WORKSPACE_DIAGNOSTIC_CODES, REMOTE_WORKSPACE_MAX_READ_BYTES, REMOTE_WORKSPACE_MAX_READ_CHUNKS, REMOTE_WORKSPACE_READER_CODES } = loadTsCommonJs("src/main/remote/RemoteWorkspaceReader.ts");
const { REMOTE_HELPER_ERROR_CODES, REMOTE_HELPER_MAX_CHUNK_BYTES, REMOTE_HELPER_MAX_LIST_ENTRIES, REMOTE_HELPER_MAX_PATH_LENGTH, REMOTE_HELPER_METHOD_CANCEL, REMOTE_HELPER_METHOD_FS_LIST, REMOTE_HELPER_METHOD_FS_READ, REMOTE_HELPER_METHOD_FS_STAT, REMOTE_HELPER_PROTOCOL_VERSION } =
	loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");
const { createRemoteControlClient } = loadTsCommonJs("src/main/remote/RemoteControlClient.ts");

const HOST = "host-1";
/** The contract's chunk ceiling, spelled once so every expectation below is stated in those units. */
const CHUNK = REMOTE_HELPER_MAX_CHUNK_BYTES;
/** A fixed modification time: it makes the "the entry did not move" comparison an exact assertion. */
const FIXED_MTIME = 1_700_000_000_000;

/** Production objects live in another VM realm, so deep comparisons are normalised through JSON. */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** Deterministic, non-repeating bytes: a wrong offset or a lost chunk cannot pass a hash comparison. */
function patternBytes(length) {
	const bytes = Buffer.alloc(length);
	for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + 7) % 251;
	return bytes;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Lets the real client's promise chain and the reader's continuations progress. */
async function settle(rounds = 8) {
	for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

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
	assert.equal(typeof outcome.code, "string", "a reader failure always carries a stable code");
	assert.equal(outcome.message, outcome.code, "the message is the code, never free text");
	return outcome;
}

/**
 * Deadline timers are captured instead of armed: a frame the test holds back must stay unanswered for as long
 * as the test needs, and a real 30s deadline per held frame would both settle the fixture early and keep the
 * test process alive for half a minute.
 */
function createManualScheduler() {
	return {
		setTimeout(handler, delayMs) {
			return { handler, delayMs };
		},
		clearTimeout() {
			return undefined;
		},
	};
}

/**
 * A controllable helper. The reader speaks to the **real** `RemoteControlClient` through the port below, so
 * framing, host/generation fencing, id minting and cancellation are production code; this harness only
 * decides which answers are fed back on stdout.
 *
 * A frame with a queued answer or a served path is answered from a microtask (a real helper answers
 * asynchronously); every other frame simply stays unanswered, which is what a request still in flight looks
 * like from the reader's side.
 */
function createHelperHarness() {
	const frames = [];
	const diagnostics = [];
	const answers = []; // per-method FIFO of { result } / { error }
	const served = new Map();
	const delivered = new Set();
	let onFrame = () => undefined;
	const client = createRemoteControlClient({
		hostId: HOST,
		send: (line) => {
			const frame = JSON.parse(line);
			frames.push(frame);
			// The hook runs while the frame is being written, so a test can change the world (a file) before the
			// answer for this exact frame is produced.
			onFrame(frame, frames.filter((candidate) => candidate.method === frame.method).length);
			const queued = answers.findIndex((entry) => entry.method === frame.method);
			if (queued >= 0) {
				const [entry] = answers.splice(queued, 1);
				deliver(frame, entry);
				return;
			}
			const file = served.get(frame.params?.path);
			if (file === undefined) return;
			if (frame.method === REMOTE_HELPER_METHOD_FS_STAT) deliver(frame, { result: { kind: "file", bytes: file.content.length, mtimeMs: file.mtimeMs } });
			else if (frame.method === REMOTE_HELPER_METHOD_FS_READ) deliver(frame, { result: readFrom(file, frame.params) });
		},
		scheduler: createManualScheduler(),
	});
	client.openConnection();

	/** One answer frame, fed back at most once per request whatever asked for it. */
	function deliver(frame, payload) {
		if (delivered.has(frame)) return;
		delivered.add(frame);
		queueMicrotask(() => {
			const body = payload.error === undefined ? { v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: HOST, generation: frame.generation, id: frame.id, ok: true, result: payload.result } : { v: REMOTE_HELPER_PROTOCOL_VERSION, hostId: HOST, generation: frame.generation, id: frame.id, ok: false, error: payload.error };
			client.handleLine(JSON.stringify(body));
		});
	}

	/** The frozen helper's own read answer: the requested slice, with eof against the size at open time. */
	function readFrom(file, params) {
		const size = file.content.length;
		const wanted = params.offset >= size ? 0 : Math.min(params.bytes, size - params.offset);
		const slice = file.content.subarray(params.offset, params.offset + wanted);
		return { chunk: slice.toString("base64"), bytes: slice.length, eof: slice.length < wanted || params.offset + slice.length >= size };
	}

	const port = {
		request(hostId, method, params, options = {}) {
			assert.equal(hostId, HOST, "the reader addresses the host it was asked for");
			const written = frames.length;
			const result = client.request(method, params, options.timeoutMs === undefined ? undefined : { timeoutMs: options.timeoutMs });
			assert.equal(frames.length, written + 1, "one frame per port call");
			options.onRequestId?.(frames.at(-1).id);
			return result;
		},
		cancel(hostId, requestId) {
			return client.cancel(requestId);
		},
	};

	return {
		client,
		frames,
		diagnostics,
		reader: createRemoteWorkspaceReader({ port, onDiagnostic: (entry) => diagnostics.push(plain(entry)) }),
		ofMethod: (method) => frames.filter((frame) => frame.method === method),
		reads: () => frames.filter((frame) => frame.method === REMOTE_HELPER_METHOD_FS_READ),
		codes: () => diagnostics.map((entry) => entry.code),
		onFrame: (hook) => {
			onFrame = hook;
		},
		nextResult: (method, result) => answers.push({ method, result }),
		nextError: (method, error) => answers.push({ method, error }),
		reply: (frame, result) => deliver(frame, { result }),
		/** Serve one path the way the helper does; `replace` is how a test makes it change under a read. */
		serveFile(path, content, mtimeMs = FIXED_MTIME) {
			const file = {
				content: Buffer.from(content),
				mtimeMs,
				replace(next, nextMtimeMs = mtimeMs + 1000) {
					file.content = Buffer.from(next);
					file.mtimeMs = nextMtimeMs;
					return file;
				},
			};
			served.set(path, file);
			return file;
		},
		close: () => client.closeConnection(),
	};
}

/** A reader over a hand-made transport, for the failure paths that never reach a result. */
function createReaderOver(port) {
	const diagnostics = [];
	return {
		diagnostics,
		reader: createRemoteWorkspaceReader({ port, onDiagnostic: (entry) => diagnostics.push(plain(entry)) }),
	};
}

test("reads a file larger than one chunk back byte for byte", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	const content = patternBytes(CHUNK + 1234);
	helper.serveFile("big.bin", content);

	const file = await helper.reader.readFile(HOST, "big.bin");
	assert.equal(file.bytes, CHUNK + 1234);
	assert.equal(Buffer.from(file.content).length, CHUNK + 1234);
	assert.equal(sha256(Buffer.from(file.content)), sha256(content), "the chunks must reassemble the original bytes");
	assert.equal(file.mtimeMs, FIXED_MTIME);
	// The request side is the contract's, verbatim: one chunk at the ceiling, then the remainder.
	assert.deepEqual(
		helper.reads().map((frame) => frame.params),
		[
			{ path: "big.bin", offset: 0, bytes: CHUNK },
			{ path: "big.bin", offset: CHUNK, bytes: 1234 },
		],
	);
	assert.deepEqual(Object.keys(helper.reads()[0].params), ["path", "offset", "bytes"]);
	assert.equal(helper.ofMethod(REMOTE_HELPER_METHOD_FS_STAT).length, 2, "the entry is described before and after the chunks");
});

test("a file whose size is exactly a chunk multiple ends on the chunk that reaches it", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	const content = patternBytes(2 * CHUNK);
	helper.serveFile("boundary.bin", content);

	const file = await helper.reader.readFile(HOST, "boundary.bin");
	assert.equal(file.bytes, 2 * CHUNK);
	assert.equal(sha256(Buffer.from(file.content)), sha256(content));
	// The last full chunk is the one that reaches the declared size, so the reader must stop there instead of
	// asking for a third chunk.
	assert.deepEqual(
		helper.reads().map((frame) => [frame.params.offset, frame.params.bytes]),
		[
			[0, CHUNK],
			[CHUNK, CHUNK],
		],
	);
});

test("a single-chunk file is read with one request sized exactly as the entry", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	helper.serveFile("notes.txt", "alpha");

	const file = await helper.reader.readFile(HOST, "notes.txt");
	assert.equal(Buffer.from(file.content).toString("utf8"), "alpha");
	assert.equal(file.bytes, 5);
	assert.deepEqual(
		helper.reads().map((frame) => frame.params),
		[{ path: "notes.txt", offset: 0, bytes: 5 }],
	);
});

test("a zero-byte file completes without asking for a chunk and is still confirmed", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	helper.serveFile("empty.txt", Buffer.alloc(0));

	const file = await helper.reader.readFile(HOST, "empty.txt");
	assert.equal(file.bytes, 0);
	assert.equal(Buffer.from(file.content).length, 0);
	// A zero-byte *request* would be answered with eof:false, so a completed range is never requested at all.
	assert.equal(helper.reads().length, 0);
	assert.equal(helper.ofMethod(REMOTE_HELPER_METHOD_FS_STAT).length, 2, "even an empty read is bracketed by two descriptions");
});

test("every helper request carries the contract version, the host and the caller's deadline", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	helper.serveFile("notes.txt", "alpha");

	await helper.reader.readFile(HOST, "notes.txt", { timeoutMs: 1234 });
	assert.deepEqual(
		helper.frames.map((frame) => frame.method),
		[REMOTE_HELPER_METHOD_FS_STAT, REMOTE_HELPER_METHOD_FS_READ, REMOTE_HELPER_METHOD_FS_STAT],
	);
	for (const frame of helper.frames) {
		assert.equal(frame.v, REMOTE_HELPER_PROTOCOL_VERSION);
		assert.equal(frame.hostId, HOST);
		assert.equal(frame.timeoutMs, 1234);
	}
});

test("stat returns the validated contract shape for every kind", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	helper.serveFile("notes.txt", "alpha");
	assert.deepEqual(plain(await helper.reader.stat(HOST, "notes.txt")), { kind: "file", bytes: 5, mtimeMs: FIXED_MTIME });
	// A queued answer wins over the served path, so each description is stated right before its own call.
	helper.nextResult(REMOTE_HELPER_METHOD_FS_STAT, { kind: "directory", bytes: 4096, mtimeMs: FIXED_MTIME });
	assert.deepEqual(plain(await helper.reader.stat(HOST, "sub")), { kind: "directory", bytes: 4096, mtimeMs: FIXED_MTIME });
	// lstat semantics: a link is `other`, and its own size is what travels.
	helper.nextResult(REMOTE_HELPER_METHOD_FS_STAT, { kind: "other", bytes: 11, mtimeMs: FIXED_MTIME });
	assert.deepEqual(plain(await helper.reader.stat(HOST, "inside-link")), { kind: "other", bytes: 11, mtimeMs: FIXED_MTIME });
	assert.deepEqual(
		helper.ofMethod(REMOTE_HELPER_METHOD_FS_STAT).map((frame) => Object.keys(frame.params)),
		[["path"], ["path"], ["path"]],
	);
});

test("a stat result that adds, drops or retypes a field is a protocol violation", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	const cases = [
		["a missing field", { kind: "file", bytes: 5 }],
		["an extra field", { kind: "file", bytes: 5, mtimeMs: FIXED_MTIME, size: 5 }],
		["an unknown kind", { kind: "link", bytes: 5, mtimeMs: FIXED_MTIME }],
		["a negative size", { kind: "file", bytes: -1, mtimeMs: FIXED_MTIME }],
		["a fractional size", { kind: "file", bytes: 5.5, mtimeMs: FIXED_MTIME }],
		["a string size", { kind: "file", bytes: "5", mtimeMs: FIXED_MTIME }],
		["a non-numeric mtime", { kind: "file", bytes: 5, mtimeMs: "now" }],
		["a null mtime", { kind: "file", bytes: 5, mtimeMs: null }],
		["no result at all", undefined],
		["a null result", null],
	];
	for (const [label, result] of cases) {
		helper.nextResult(REMOTE_HELPER_METHOD_FS_STAT, result);
		const failure = await rejection(helper.reader.stat(HOST, "notes.txt"));
		assert.equal(failure.code, "PROTOCOL_INVALID", label);
		assert.ok(REMOTE_HELPER_ERROR_CODES.includes(failure.code), label);
	}
});

test("list returns the validated entries the contract describes", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	helper.nextResult(REMOTE_HELPER_METHOD_FS_LIST, {
		entries: [
			{ name: "alpha.txt", kind: "file", bytes: 5 },
			{ name: "sub", kind: "directory" },
			{ name: "inside-link", kind: "other" },
		],
	});

	assert.deepEqual(plain(await helper.reader.list(HOST, ".")), {
		entries: [
			{ name: "alpha.txt", kind: "file", bytes: 5 },
			{ name: "sub", kind: "directory" },
			{ name: "inside-link", kind: "other" },
		],
	});
	assert.deepEqual(Object.keys(helper.ofMethod(REMOTE_HELPER_METHOD_FS_LIST)[0].params), ["path"]);
});

test("a listing entry that does not match the contract is a protocol violation", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	const cases = [
		["a missing kind", { name: "a.txt", bytes: 3 }],
		["an unknown kind", { name: "a.txt", kind: "link", bytes: 3 }],
		["a size on a directory", { name: "sub", kind: "directory", bytes: 4096 }],
		["a missing size on a file", { name: "a.txt", kind: "file" }],
		["a string name", { name: 7, kind: "file", bytes: 3 }],
		["an empty name", { name: "", kind: "file", bytes: 3 }],
		["a name with a separator", { name: "a/b.txt", kind: "file", bytes: 3 }],
		["a parent name", { name: "..", kind: "file", bytes: 3 }],
		["an extra field", { name: "a.txt", kind: "file", bytes: 3, mode: 420 }],
		["a negative size", { name: "a.txt", kind: "file", bytes: -3 }],
	];
	for (const [label, entry] of cases) {
		helper.nextResult(REMOTE_HELPER_METHOD_FS_LIST, { entries: [entry] });
		const failure = await rejection(helper.reader.list(HOST, "."));
		assert.equal(failure.code, "PROTOCOL_INVALID", label);
	}
	// The listing result itself is exactly one field.
	helper.nextResult(REMOTE_HELPER_METHOD_FS_LIST, { entries: [], total: 0 });
	assert.equal((await rejection(helper.reader.list(HOST, "."))).code, "PROTOCOL_INVALID");
});

test("a listing past the contract cap is refused instead of truncated", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	const entry = (index) => ({ name: `f${index}`, kind: "file", bytes: 0 });
	helper.nextResult(REMOTE_HELPER_METHOD_FS_LIST, { entries: Array.from({ length: REMOTE_HELPER_MAX_LIST_ENTRIES + 1 }, (_, index) => entry(index)) });
	const failure = await rejection(helper.reader.list(HOST, "."));
	assert.equal(failure.code, "RESULT_TOO_LARGE");
	// At the cap the listing is complete and accepted: the ceiling is inclusive, not a truncation point.
	helper.nextResult(REMOTE_HELPER_METHOD_FS_LIST, { entries: Array.from({ length: REMOTE_HELPER_MAX_LIST_ENTRIES }, (_, index) => entry(index)) });
	assert.equal((await helper.reader.list(HOST, ".")).entries.length, REMOTE_HELPER_MAX_LIST_ENTRIES);
});

test("a directory, a symlink or any non-regular entry is refused as NOT_A_FILE before a chunk", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	for (const [label, kind] of [
		["a directory", "directory"],
		["a symlink", "other"],
	]) {
		helper.nextResult(REMOTE_HELPER_METHOD_FS_STAT, { kind, bytes: 4096, mtimeMs: FIXED_MTIME });
		const failure = await rejection(helper.reader.readFile(HOST, "target"));
		assert.equal(failure.code, "NOT_A_FILE", label);
	}
	assert.equal(helper.reads().length, 0, "nothing but a regular file may be opened");
});

test("a file past the local read ceiling is refused instead of streamed", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	// The chunk budget is the byte ceiling expressed in contract chunks, not a second magic number.
	assert.equal(REMOTE_WORKSPACE_MAX_READ_CHUNKS, Math.ceil(REMOTE_WORKSPACE_MAX_READ_BYTES / CHUNK));
	helper.nextResult(REMOTE_HELPER_METHOD_FS_STAT, { kind: "file", bytes: REMOTE_WORKSPACE_MAX_READ_BYTES + 1, mtimeMs: FIXED_MTIME });
	const failure = await rejection(helper.reader.readFile(HOST, "huge.bin"));
	assert.equal(failure.code, "RESULT_TOO_LARGE");
	assert.equal(helper.reads().length, 0, "an over-limit file must be refused before the first chunk");
});

test("a file of exactly the local ceiling is read within the chunk budget", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	const content = patternBytes(REMOTE_WORKSPACE_MAX_READ_BYTES);
	helper.serveFile("ceiling.bin", content);

	const file = await helper.reader.readFile(HOST, "ceiling.bin");
	assert.equal(file.bytes, REMOTE_WORKSPACE_MAX_READ_BYTES);
	assert.equal(sha256(Buffer.from(file.content)), sha256(content));
	// The ceiling is inclusive on both bounds: exactly the byte cap in exactly the chunk budget.
	assert.equal(helper.reads().length, REMOTE_WORKSPACE_MAX_READ_CHUNKS);
	assert.deepEqual(
		helper.reads().map((frame) => frame.params.offset),
		Array.from({ length: REMOTE_WORKSPACE_MAX_READ_CHUNKS }, (_, index) => index * CHUNK),
	);
});

test("a chunk whose declared length disagrees with its bytes is a protocol violation", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	helper.serveFile("notes.txt", "abcdef");
	// "YWJjZGVm" is base64("abcdef"), so this frame claims three bytes and carries six.
	helper.nextResult(REMOTE_HELPER_METHOD_FS_READ, { chunk: "YWJjZGVm", bytes: 3, eof: false });
	const failure = await rejection(helper.reader.readFile(HOST, "notes.txt"));
	assert.equal(failure.code, "PROTOCOL_INVALID");
	assert.equal(helper.reads().length, 1, "the read stops at the first contradictory chunk");
});

test("a chunk that carries more than it was asked for is a protocol violation", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	// The entry is three bytes, so the chunk request asks for three; six bytes back is not a longer answer.
	helper.nextResult(REMOTE_HELPER_METHOD_FS_STAT, { kind: "file", bytes: 3, mtimeMs: FIXED_MTIME });
	helper.nextResult(REMOTE_HELPER_METHOD_FS_READ, { chunk: "YWJjZGVm", bytes: 6, eof: true });
	const failure = await rejection(helper.reader.readFile(HOST, "notes.txt"));
	assert.equal(failure.code, "PROTOCOL_INVALID");
	assert.equal(helper.reads().length, 1);
});

test("a chunk that is not canonical base64 is a protocol violation", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	helper.serveFile("notes.txt", "abcdef");
	helper.nextResult(REMOTE_HELPER_METHOD_FS_READ, { chunk: "YWJjZGVm!!!!", bytes: 6, eof: true });
	const failure = await rejection(helper.reader.readFile(HOST, "notes.txt"));
	assert.equal(failure.code, "PROTOCOL_INVALID");
	assert.equal(helper.reads().length, 1);
});

test("a chunk that came up short while claiming more is a protocol violation", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	// The helper's own rule makes a short chunk the end of the file, so this answer cannot come from it: a
	// remote that stretched a read this way would otherwise keep the transfer open one answer at a time.
	helper.serveFile("notes.txt", "0123456789");
	helper.nextResult(REMOTE_HELPER_METHOD_FS_READ, { chunk: "MDE=", bytes: 2, eof: false });
	const failure = await rejection(helper.reader.readFile(HOST, "notes.txt"));
	assert.equal(failure.code, "PROTOCOL_INVALID");
	assert.equal(helper.reads().length, 1, "the read stops at the first chunk that cannot be the helper's");
});

test("a read that ends before the size it declared fails closed", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	// The entry is ten bytes and does not change, while the chunk carries four and claims the end of the read.
	helper.serveFile("notes.txt", "0123456789");
	helper.nextResult(REMOTE_HELPER_METHOD_FS_READ, { chunk: "MDEyMw==", bytes: 4, eof: true });
	const failure = await rejection(helper.reader.readFile(HOST, "notes.txt"));
	assert.equal(failure.code, "PROTOCOL_INVALID", "the file did not move, so only the remote can be wrong");
	assert.equal(helper.reads().length, 1, "the read stops: no later chunk may make up the difference");
});

test("a file that grows while it is being read is refused as changed", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	const file = helper.serveFile("notes.txt", "0123456789");
	// The closing description is the one that sees the new version: twenty bytes at a new mtime.
	helper.onFrame((frame, occurrence) => {
		if (frame.method === REMOTE_HELPER_METHOD_FS_STAT && occurrence === 2) file.replace(patternBytes(20));
	});

	const failure = await rejection(helper.reader.readFile(HOST, "notes.txt"));
	assert.equal(failure.code, REMOTE_WORKSPACE_READER_CODES.fileChanged);
	assert.equal(helper.reads().length, 1, "a changed file must not be streamed any further");
});

test("a file rewritten at the same size but a new mtime is refused as changed", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	const file = helper.serveFile("notes.txt", "0123456789");
	helper.onFrame((frame, occurrence) => {
		if (frame.method === REMOTE_HELPER_METHOD_FS_STAT && occurrence === 2) file.replace("0123456789", FIXED_MTIME + 5);
	});

	const failure = await rejection(helper.reader.readFile(HOST, "notes.txt"));
	assert.equal(failure.code, REMOTE_WORKSPACE_READER_CODES.fileChanged);
	assert.equal(helper.reads().length, 1);
});

test("an entry that vanishes before the closing description relays the remote's own code", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	helper.serveFile("notes.txt", "0123456789");
	helper.onFrame((frame, occurrence) => {
		if (frame.method === REMOTE_HELPER_METHOD_FS_STAT && occurrence === 2) helper.nextError(REMOTE_HELPER_METHOD_FS_STAT, { code: "PATH_NOT_FOUND", retryable: false });
	});

	const failure = await rejection(helper.reader.readFile(HOST, "notes.txt"));
	assert.equal(failure.code, "PATH_NOT_FOUND", "the remote's stable code is more truthful than a local guess");
	assert.equal(helper.reads().length, 1);
});

test("a remote refusal is relayed unchanged and its message never travels", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	helper.nextError(REMOTE_HELPER_METHOD_FS_STAT, { code: "PATH_OUTSIDE_ROOT", retryable: false, message: "ENOENT: no such file, open '/home/dev/secret.txt'" });

	const failure = await rejection(helper.reader.stat(HOST, "../outside/secret.txt"));
	assert.equal(failure.code, "PATH_OUTSIDE_ROOT");
	assert.ok(REMOTE_HELPER_ERROR_CODES.includes(failure.code));
	assert.equal(failure.retryable, false);
	assert.equal(JSON.stringify(failure).includes("secret.txt"), false, "the helper's text is dropped, not logged");
	assert.deepEqual(helper.codes(), ["PATH_OUTSIDE_ROOT"]);
});

test("a remote code that is free text is a protocol violation, not a message", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	helper.nextError(REMOTE_HELPER_METHOD_FS_LIST, { code: "ENOENT: /home/dev/secret.txt" });

	const failure = await rejection(helper.reader.list(HOST, "."));
	assert.equal(failure.code, "PROTOCOL_INVALID");
	assert.equal(JSON.stringify(helper.diagnostics).includes("secret.txt"), false);
});

test("a remote refusal in the middle of a read stops the transfer", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	helper.serveFile("big.bin", patternBytes(CHUNK + 10));
	helper.nextError(REMOTE_HELPER_METHOD_FS_READ, { code: "PATH_NOT_FOUND", retryable: false });

	const failure = await rejection(helper.reader.readFile(HOST, "big.bin"));
	assert.equal(failure.code, "PATH_NOT_FOUND");
	assert.equal(helper.reads().length, 1, "no further chunk is requested after a refusal");
});

test("a read cancelled while a chunk is in flight settles as cancelled and pulls no further chunk", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	// Only the sizing description is answered: the chunk that follows is left in flight on purpose.
	helper.nextResult(REMOTE_HELPER_METHOD_FS_STAT, { kind: "file", bytes: CHUNK + 10, mtimeMs: FIXED_MTIME });
	const controller = new AbortController();
	const pending = helper.reader.readFile(HOST, "big.bin", { signal: controller.signal });
	await settle();
	assert.equal(helper.ofMethod(REMOTE_HELPER_METHOD_FS_STAT).length, 1, "the sizing description arrived first");
	assert.equal(helper.reads().length, 1, "the first chunk is in flight");
	const inFlight = helper.reads()[0];

	controller.abort();
	const failure = await rejection(pending);
	assert.equal(failure.code, "REQUEST_CANCELLED");
	assert.equal(helper.reads().length, 1, "no further chunk may be requested after the abort");
	// The withdraw names the frame that was in flight, and it went through the real client's cancel().
	const cancels = helper.ofMethod(REMOTE_HELPER_METHOD_CANCEL);
	assert.equal(cancels.length, 1);
	assert.deepEqual(cancels[0].params, { requestId: inFlight.id });
	// The helper declines: the work had already started, so the cancel did not take effect. That is never read
	// as a rollback — the read is already settled as cancelled and the late chunk answer changes nothing.
	helper.reply(cancels[0], { cancelled: false, reason: "already-settled" });
	await settle();
	assert.deepEqual(helper.codes(), [REMOTE_WORKSPACE_DIAGNOSTIC_CODES.cancelRequested, "REQUEST_CANCELLED", REMOTE_WORKSPACE_DIAGNOSTIC_CODES.cancelRefused]);
	helper.reply(inFlight, { chunk: Buffer.from("late").toString("base64"), bytes: 4, eof: true });
	await settle();
	assert.equal(helper.client.pendingCount(), 0, "the abandoned request still settles exactly once");
	assert.equal(helper.reads().length, 1);
});

test("an abort before the first chunk cancels the read without asking for one", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	// The sizing description is held, so the read is suspended inside its first request when the abort lands.
	const controller = new AbortController();
	const pending = helper.reader.readFile(HOST, "big.bin", { signal: controller.signal });
	await settle();
	assert.equal(helper.ofMethod(REMOTE_HELPER_METHOD_FS_STAT).length, 1);

	controller.abort();
	const failure = await rejection(pending);
	assert.equal(failure.code, "REQUEST_CANCELLED");
	assert.equal(helper.reads().length, 0, "a cancelled read must not ask for a chunk");
	const cancels = helper.ofMethod(REMOTE_HELPER_METHOD_CANCEL);
	assert.deepEqual(
		cancels.map((frame) => frame.params),
		[{ requestId: helper.ofMethod(REMOTE_HELPER_METHOD_FS_STAT)[0].id }],
	);
	// The helper did abort the queued request, so there is no refusal to report.
	helper.reply(cancels[0], { cancelled: true });
	await settle();
	assert.deepEqual(helper.codes(), [REMOTE_WORKSPACE_DIAGNOSTIC_CODES.cancelRequested, "REQUEST_CANCELLED"]);
	assert.equal(helper.client.pendingCount(), 0);
});

test("a signal that is already aborted sends nothing at all", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	helper.serveFile("notes.txt", "alpha");
	const controller = new AbortController();
	controller.abort();

	const failure = await rejection(helper.reader.readFile(HOST, "notes.txt", { signal: controller.signal }));
	assert.equal(failure.code, "REQUEST_CANCELLED");
	assert.equal(helper.frames.length, 0);
});

test("an abort settles as cancelled even when the transport cannot withdraw the request", async () => {
	// A transport with no cancel member and an answer that never comes: the abandonment has to stay local.
	const { reader, diagnostics } = createReaderOver({ request: () => new Promise(() => undefined) });
	const controller = new AbortController();
	const pending = reader.readFile(HOST, "notes.txt", { signal: controller.signal });
	await settle();
	controller.abort();

	const failure = await rejection(pending);
	assert.equal(failure.code, "REQUEST_CANCELLED");
	assert.deepEqual(
		diagnostics.map((entry) => entry.code),
		["REQUEST_CANCELLED"],
	);
});

test("an invalid call is refused before a frame is written and without reporting it", async (t) => {
	const helper = createHelperHarness();
	t.after(() => helper.close());
	const cases = [
		["an empty host id", () => helper.reader.stat("", "notes.txt")],
		["an over-long path", () => helper.reader.readFile(HOST, "a".repeat(REMOTE_HELPER_MAX_PATH_LENGTH + 1))],
		["a path with a control byte", () => helper.reader.list(HOST, "a\u0000b")],
		["an option that is not a signal", () => helper.reader.readFile(HOST, "notes.txt", { signal: "now" })],
	];
	for (const [label, invoke] of cases) {
		const failure = await rejection(invoke());
		assert.equal(failure.code, "PROTOCOL_INVALID", label);
	}
	assert.equal(helper.frames.length, 0, "an invalid call must not reach the transport");
	assert.equal(helper.diagnostics.length, 0, "nothing is reported for an invalid call: the values may be secrets");
});

test("a transport failure that is not a stable code collapses instead of echoing free text", async () => {
	const { reader, diagnostics } = createReaderOver({
		request: () => {
			throw new Error("ENOENT: no such file, open '/home/dev/.ssh/id_ed25519'");
		},
	});
	const failure = await rejection(reader.stat(HOST, "notes.txt"));
	assert.equal(failure.code, REMOTE_WORKSPACE_READER_CODES.requestFailed);
	assert.equal(failure.message.includes("id_ed25519"), false);
	assert.equal(JSON.stringify(diagnostics).includes("id_ed25519"), false);
});

test("the connection layer's own refusal is relayed unchanged", async () => {
	// `SshConnectionManager.request` rejects with a bare Error whose message *is* the stable code.
	const { reader, diagnostics } = createReaderOver({ request: () => Promise.reject(new Error("SSH_CONNECTION_NOT_READY")) });

	const failure = await rejection(reader.stat(HOST, "notes.txt"));
	assert.equal(failure.code, "SSH_CONNECTION_NOT_READY");
	assert.equal(failure.retryable, false);
	assert.deepEqual(
		diagnostics.map((entry) => entry.code),
		["SSH_CONNECTION_NOT_READY"],
	);
});

test("a transport rejection with its own stable code and retryable flag is relayed as written", async () => {
	const { reader } = createReaderOver({ request: () => Promise.reject({ code: "REQUEST_TIMEOUT", retryable: true, message: "deadline at /home/dev/secret.txt" }) });

	const failure = await rejection(reader.readFile(HOST, "notes.txt"));
	assert.equal(failure.code, "REQUEST_TIMEOUT");
	assert.equal(failure.retryable, true);
	assert.equal(failure.message, "REQUEST_TIMEOUT");
});

test("the reader refuses to be built without a usable transport", () => {
	assert.throws(() => createRemoteWorkspaceReader({ port: {} }), /REMOTE_WORKSPACE_READER_OPTIONS_INVALID/);
	assert.throws(() => createRemoteWorkspaceReader({ port: { request: () => Promise.resolve(undefined) }, onDiagnostic: "later" }), /REMOTE_WORKSPACE_READER_OPTIONS_INVALID/);
});
