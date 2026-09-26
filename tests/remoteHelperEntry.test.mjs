import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
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
 *
 * The read-only batch (fs.stat/fs.list/fs.read) is proved the same way: a real child process with a real
 * root, real files, a real link that leaves the root and a real decoy outside it. Nothing about the
 * confinement is asserted through a stub, because a stub cannot show that the target was never touched.
 */

const {
	REMOTE_HELPER_CAPABILITIES,
	REMOTE_HELPER_ERROR_CODES,
	REMOTE_HELPER_MAX_CHUNK_BYTES,
	REMOTE_HELPER_MAX_CONCURRENT_REQUESTS,
	REMOTE_HELPER_MAX_ECHO_DELAY_MS,
	REMOTE_HELPER_MAX_FRAME_BYTES,
	REMOTE_HELPER_MAX_LIST_ENTRIES,
	REMOTE_HELPER_MAX_PATH_LENGTH,
	REMOTE_HELPER_MAX_QUEUED_REQUESTS,
	REMOTE_HELPER_METHOD_CANCEL,
	REMOTE_HELPER_METHOD_ECHO,
	REMOTE_HELPER_METHOD_FS_LIST,
	REMOTE_HELPER_METHOD_FS_READ,
	REMOTE_HELPER_METHOD_FS_STAT,
	REMOTE_HELPER_METHOD_HELLO,
	REMOTE_HELPER_MAX_ECHO_TEXT_LENGTH,
	REMOTE_HELPER_MAX_HOST_ID_LENGTH,
	REMOTE_HELPER_MAX_ID_LENGTH,
	REMOTE_HELPER_MAX_METHOD_LENGTH,
	REMOTE_HELPER_PROTOCOL_VERSION,
} = loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");
const { REMOTE_HELPER_ENTRY_FILE_NAME, REMOTE_HELPER_ENTRY_SHA256, REMOTE_HELPER_ENTRY_VERSION, REMOTE_HELPER_INLINE_SOURCE } = loadTsCommonJs("src/main/remote/RemoteHelperEntry.ts");
const { REMOTE_FRAME_DIAGNOSTIC_CODES, createRemoteControlClient } = loadTsCommonJs("src/main/remote/RemoteControlClient.ts");

/** Same host id shape the host store mints; the client only bounds it by length and control bytes. */
const HOST_ID = "01234567-89ab-4def-8123-456789abcdef";
/** The helper never resolves HOME into a path, so a POSIX literal is the honest fixture on any platform. */
const HELPER_HOME = "/home/pideck-helper";
/** Frozen digest, pinned here as well as in the module: editing the source means editing both. */
const FROZEN_SHA256 = "64cedc254255378afd2afc959933b0f4761c9226ce6b9a6b8076e1ce1cc86ae7";
const MAX_TEXT = 4096;
const TEST_TIMEOUT_MS = 30_000;
const GUARD_TIMEOUT_MS = 10_000;
const DROP_CODES = new Set(Object.values(REMOTE_FRAME_DIAGNOSTIC_CODES));
/** The token a refusal must never have read: it exists only outside the root. */
const DECOY = "pideck-decoy-7f3a1c";
/** Contract source read back by this suite: the result shapes are asserted against the declared types. */
const CONTRACT_SOURCE = "src/main/remote/RemoteHelperContract.ts";

/** Every test drives real child processes, so each one carries a hard deadline of its own. */
const helperTest = (name, fn, timeoutMs = TEST_TIMEOUT_MS) => test(name, { timeout: timeoutMs }, fn);

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

/** One successful request, normalised out of the helper's realm. */
async function call(session, method, params) {
	return plain(await guard(session.client.request(method, params), method));
}

/**
 * One refusal: the code has to be exactly the expected one (or one of the expected ones where the platform
 * picks the errno itself), it has to be a declared contract code — free text or an undeclared code would
 * break the client's vocabulary — and it is never retryable, because every read-only refusal is
 * deterministic: retrying the same params cannot fix an escape or a missing file.
 */
async function expectRefusal(session, method, params, code) {
	const expected = Array.isArray(code) ? code : [code];
	const error = await rejection(guard(session.client.request(method, params), `${method} refusal`));
	assert.ok(expected.includes(error.code), `${method} ${JSON.stringify(params)} answered ${error.code}, expected ${expected.join(" or ")}`);
	assert.equal(error.retryable, false, `${method} ${JSON.stringify(params)}`);
	assert.ok(REMOTE_HELPER_ERROR_CODES.includes(error.code), `${error.code} is not in REMOTE_HELPER_ERROR_CODES`);
	return error;
}

/**
 * A path that walks *through* a regular file. POSIX reports ENOTDIR there, which the helper maps to
 * NOT_A_DIRECTORY; Windows has no ENOTDIR at all and libuv reports ERROR_PATH_NOT_FOUND as ENOENT, which
 * maps to PATH_NOT_FOUND. Both are stable, declared refusals — and the deployed helper only ever runs on a
 * POSIX host — so the assertion accepts whichever errno the platform actually produces.
 */
const THROUGH_A_FILE = ["NOT_A_DIRECTORY", "PATH_NOT_FOUND"];

/** Field names of one contract type, read out of the contract source: the shapes must match word for word. */
function contractFields(typeName) {
	const source = readFileSync(CONTRACT_SOURCE, "utf8");
	const match = new RegExp(`export\\s+type\\s+${typeName}\\s*=\\s*\\{([\\s\\S]*?)\\};`).exec(source);
	assert.ok(match, `RemoteHelperContract does not declare ${typeName}`);
	return Array.from(match[1].matchAll(/([A-Za-z][A-Za-z0-9]*)\??\s*:/g)).map((entry) => entry[1]);
}

/** An isolated empty root for every helper that does not care about files. */
function createRootFixture(t) {
	const root = mkdtempSync(join(tmpdir(), "pideck-helper-root-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

/**
 * A root with what the read-only methods need around it: a small tree inside, a decoy tree outside and a
 * link inside the root that resolves outside it. The decoy carries a token no frame may ever contain, and
 * on POSIX it is unreadable and its directory unsearchable, so "the helper refused" is distinguishable
 * from "the helper tried and failed": a read attempt could only answer PERMISSION_DENIED.
 */
function createFsFixture(t) {
	const base = mkdtempSync(join(tmpdir(), "pideck-helper-fs-"));
	const root = join(base, "root");
	const outside = join(base, "outside");
	mkdirSync(join(root, "sub"), { recursive: true });
	mkdirSync(join(outside, "blocked"), { recursive: true });
	writeFileSync(join(root, "alpha.txt"), "alpha content");
	writeFileSync(join(root, "empty.txt"), "");
	writeFileSync(join(root, "sub", "beta.txt"), "beta content");
	writeFileSync(join(root, "sub", "zeta.txt"), "zeta content");
	writeFileSync(join(outside, "secret.txt"), DECOY, { mode: 0o000 });
	writeFileSync(join(outside, "blocked", "marker.txt"), DECOY);
	if (process.platform !== "win32") chmodSync(join(outside, "blocked"), 0o000);
	symlinkSync(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
	// A link that stays inside the root: reading through it is ordinary (a linked workspace file), while
	// stat and list must still describe the link itself.
	symlinkSync(join(root, "sub"), join(root, "inside-link"), process.platform === "win32" ? "junction" : "dir");
	t.after(() => {
		// Restore what the fixture took away, otherwise the cleanup cannot traverse or delete its own tree.
		chmodSync(join(outside, "secret.txt"), 0o600);
		if (process.platform !== "win32") chmodSync(join(outside, "blocked"), 0o700);
		rmSync(base, { recursive: true, force: true });
	});
	return { base, root, outside };
}

/**
 * One real helper process plus the production client that speaks to it. `sent` keeps every outbound
 * line, `frames` every inbound line that parsed, and `diagnostics` what the client refused to use, so a
 * test can assert both the protocol traffic and the client side verdict on it.
 *
 * The argv shape is stated by each test: `root: null` starts no `--root` at all (the legal host-only
 * session), `root: ""` states an explicitly empty value (which fails closed), any other `root` gets a
 * fresh empty directory, and `rootArgs` covers argv shapes the launcher's template never produces.
 */
function startHelper(t, options = {}) {
	const env = { ...process.env };
	if (options.home === null) delete env.HOME;
	else env.HOME = options.home ?? HELPER_HOME;
	const rootArgs = options.rootArgs !== undefined ? options.rootArgs : options.root === null ? [] : ["--root", options.root === undefined ? createRootFixture(t) : options.root];
	// `--` keeps node from parsing the helper's own flag as a node option; the deployed command runs a file,
	// where the same argv shape needs no separator (covered by the uploaded-helper test).
	const argv = options.entryPath === undefined ? ["-e", REMOTE_HELPER_INLINE_SOURCE, "--", ...rootArgs] : [options.entryPath, ...rootArgs];
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
	// The deployed artifact is an ES module, where require does not exist, so the body loads its two
	// builtins through process.getBuiltinModule - and it must load nothing else.
	assert.ok(!REMOTE_HELPER_INLINE_SOURCE.includes("require("), "the helper needs nothing but process and its stdio");
	assert.deepEqual(
		Array.from(REMOTE_HELPER_INLINE_SOURCE.matchAll(/getBuiltinModule\("([^"]+)"\)/g)).map((match) => match[1]),
		["node:fs", "node:path"],
		"the helper may load exactly the two builtins the read-only batch needs",
	);
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.length > 1024 && REMOTE_HELPER_INLINE_SOURCE.length < 64 * 1024, `unexpected source size ${REMOTE_HELPER_INLINE_SOURCE.length}`);
});

helperTest("the exported entry identity matches the frozen source", () => {
	assert.equal(REMOTE_HELPER_ENTRY_FILE_NAME, "helper.mjs");
	assert.match(REMOTE_HELPER_ENTRY_VERSION, /^\d+\.\d+\.\d+$/);
	// The frozen source cannot import the contract, so its literals are checked against it here.
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes(`"${REMOTE_HELPER_ENTRY_VERSION}"`), "hello must report REMOTE_HELPER_ENTRY_VERSION");
	for (const token of [REMOTE_HELPER_METHOD_HELLO, REMOTE_HELPER_METHOD_ECHO, REMOTE_HELPER_METHOD_CANCEL, REMOTE_HELPER_METHOD_FS_STAT, REMOTE_HELPER_METHOD_FS_LIST, REMOTE_HELPER_METHOD_FS_READ]) {
		assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes(`"${token}"`), token);
	}
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes(String(REMOTE_HELPER_MAX_FRAME_BYTES)), "the frame cap must be visible in the frozen source");
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes(String(REMOTE_HELPER_MAX_ECHO_DELAY_MS)), "the echo delay ceiling must be visible in the frozen source");
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes(String(REMOTE_HELPER_MAX_CHUNK_BYTES)), "the read chunk ceiling must be visible in the frozen source");
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes(String(REMOTE_HELPER_MAX_LIST_ENTRIES)), "the listing ceiling must be visible in the frozen source");
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes(String(REMOTE_HELPER_MAX_PATH_LENGTH)), "the path ceiling must be visible in the frozen source");
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

helperTest("a helper started without --root is a legal host-only session that serves no path", async (t) => {
	// No `--root` at all is a state of its own, not a broken value: that is what the launcher's template
	// produces while it has no verified root to pass. The helper starts, answers the whole control
	// vocabulary, and refuses every fs.* call with PATH_OUTSIDE_ROOT, because without a root there is no
	// reachable path to name.
	const session = startHelper(t, { root: null });
	const hello = plain(await guard(session.client.request(REMOTE_HELPER_METHOD_HELLO), "hello without a root"));
	assert.equal(hello.protocolVersion, REMOTE_HELPER_PROTOCOL_VERSION);
	assert.equal(hello.home, HELPER_HOME);
	// The capabilities are reported as this build really has them: fs.* is still a capability, it is only the
	// paths that are unreachable, so a client must never read the host-only mode as a downgraded build.
	assert.deepEqual(hello.capabilities, Array.from(REMOTE_HELPER_CAPABILITIES));
	assert.equal(hello.helperVersion, REMOTE_HELPER_ENTRY_VERSION);
	assert.deepEqual(plain(await guard(session.client.request(REMOTE_HELPER_METHOD_ECHO, { text: "host-only" }), "echo without a root")), { text: "host-only", delayMs: 0 });
	assert.deepEqual(plain(await guard(session.client.request(REMOTE_HELPER_METHOD_CANCEL, { requestId: "req-never-seen" }), "cancel without a root")), {
		cancelled: false,
		reason: "already-settled",
	});
	/**
	 * One refusal whose request id is known in advance: `expectRefusal` mints a request of its own, and this
	 * test has to prove that the answer to *this* call was a refusal instead of a result.
	 */
	async function refusal(method, params) {
		const pending = session.client.request(method, params);
		const id = session.requestIdAt(session.sent.length - 1);
		const error = await rejection(guard(pending, `${method} without a root`));
		assert.equal(error.code, "PATH_OUTSIDE_ROOT", `${method} has no reachable path without a root`);
		assert.equal(error.retryable, false, method);
		assert.ok(REMOTE_HELPER_ERROR_CODES.includes(error.code), error.code);
		return id;
	}
	for (const [method, params] of [
		[REMOTE_HELPER_METHOD_FS_STAT, { path: "." }],
		[REMOTE_HELPER_METHOD_FS_LIST, { path: "." }],
		[REMOTE_HELPER_METHOD_FS_READ, { path: "alpha.txt", offset: 0, bytes: 8 }],
	]) {
		const id = await refusal(method, params);
		assert.equal(
			session.frames.some((frame) => frame.id === id && frame.ok === true),
			false,
			`${method} must not produce a result without a root`,
		);
	}
	// Nothing in this mode may look like an answer: the only refusals are those three calls, and each one is
	// the containment code rather than a startup failure, because an omitted --root is not ROOT_INVALID.
	assert.deepEqual(
		session.frames.filter((frame) => frame.ok === false).map((frame) => frame.error.code),
		["PATH_OUTSIDE_ROOT", "PATH_OUTSIDE_ROOT", "PATH_OUTSIDE_ROOT"],
	);
	assert.equal(
		session.frames.some((frame) => frame.ok === false && frame.error.code === "ROOT_INVALID"),
		false,
		"an omitted --root must not be reported as an unusable root",
	);
	// The session is still alive and still serving the control vocabulary after all of it.
	assert.equal((await call(session, REMOTE_HELPER_METHOD_HELLO)).home, HELPER_HOME);
	assert.equal(
		await session.waitForExit(300).then(
			() => "exited",
			() => "running",
		),
		"running",
		"a host-only helper keeps running",
	);
	assert.equal(session.lines.length, session.frames.length, "every stdout line has to be a protocol frame");
	assert.equal(session.stderr(), "");
});

helperTest("a --root that is present but unusable fails closed before it serves anything", async (t) => {
	const unusable = join(createRootFixture(t), "file-as-root");
	writeFileSync(unusable, "not a directory");
	const cases = [
		// The explicit empty value is the contrast case of the test above: the same template with a root that
		// is present and unusable is fatal, and it stays fatal rather than degrading into a host-only helper.
		["an explicitly empty root", { root: "" }],
		["a root flag with no value", { rootArgs: ["--root"] }],
		["a relative root", { root: "work/project" }],
		["a root with a trailing separator", { root: `${createRootFixture(t)}/` }],
		["a root that does not exist", { root: join(tmpdir(), "pideck-helper-missing-root-7f3a1c") }],
		["a file as the root", { root: unusable }],
		["the filesystem root", { root: "/" }],
		["a repeated root", { rootArgs: ["--root", createRootFixture(t), "--root", createRootFixture(t)] }],
	];
	for (const [label, options] of cases) {
		const session = startHelper(t, options);
		// The root is validated before stdin is even wired, so the refusal is a frame with no readable
		// identity plus a non-zero exit: the transport dies instead of a silent helper that answers nothing.
		const code = await session.waitForExit(6000);
		assert.equal(typeof code, "number", `${label}: the helper must exit on its own`);
		assert.notEqual(code, 0, `${label}: a helper with an unusable root must fail closed`);
		assert.equal(session.frames.length, 1, `${label}: exactly one refusal frame`);
		const frame = session.frames[0];
		assert.equal(frame.ok, false, label);
		assert.equal(frame.error.code, "ROOT_INVALID", label);
		assert.equal(frame.error.retryable, false, label);
		assert.ok(REMOTE_HELPER_ERROR_CODES.includes(frame.error.code), label);
		assert.deepEqual({ hostId: frame.hostId, generation: frame.generation, id: frame.id }, { hostId: "", generation: 0, id: "" }, `${label}: nothing is known, so no identity is claimed`);
		assert.equal(session.lines.length, session.frames.length, `${label}: every stdout line has to be a protocol frame`);
		assert.equal(session.stderr(), "", `${label}: the helper never writes stderr text`);
	}
	// The same argv shape with a usable root is served, so the refusals above are about the value the flag
	// carried and not about the flag itself.
	const working = startHelper(t, { root: createRootFixture(t) });
	assert.equal((await call(working, REMOTE_HELPER_METHOD_HELLO)).protocolVersion, REMOTE_HELPER_PROTOCOL_VERSION);
});

helperTest("a root that is itself a link is canonicalized once at startup", async (t) => {
	const fixture = createFsFixture(t);
	const linked = join(fixture.base, "linked-root");
	symlinkSync(fixture.root, linked, process.platform === "win32" ? "junction" : "dir");
	const session = startHelper(t, { root: linked });
	// The boundary is the canonical directory the link resolves to, so the tree behind the link is served
	// and the link cannot be used to widen the root.
	assert.equal((await call(session, REMOTE_HELPER_METHOD_FS_STAT, { path: "alpha.txt" })).kind, "file");
	assert.equal(Buffer.from((await call(session, REMOTE_HELPER_METHOD_FS_READ, { path: "alpha.txt", offset: 0, bytes: 5 })).chunk, "base64").toString("utf8"), "alpha");
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_STAT, { path: "../outside/secret.txt" }, "PATH_OUTSIDE_ROOT");
});

helperTest("fs.stat classifies entries with lstat semantics", async (t) => {
	const fixture = createFsFixture(t);
	const session = startHelper(t, { root: fixture.root });
	const file = await call(session, REMOTE_HELPER_METHOD_FS_STAT, { path: "alpha.txt" });
	assert.deepEqual(Object.keys(file), contractFields("RemoteHelperStatResult"));
	assert.equal(file.kind, "file");
	assert.equal(file.bytes, "alpha content".length);
	assert.equal(typeof file.mtimeMs, "number");
	assert.ok(Number.isFinite(file.mtimeMs));
	const empty = await call(session, REMOTE_HELPER_METHOD_FS_STAT, { path: "empty.txt" });
	assert.equal(empty.kind, "file");
	assert.equal(empty.bytes, 0);
	assert.equal((await call(session, REMOTE_HELPER_METHOD_FS_STAT, { path: "sub" })).kind, "directory");
	// "." is the root itself, so a client never needs an absolute path to describe it.
	assert.equal((await call(session, REMOTE_HELPER_METHOD_FS_STAT, { path: "." })).kind, "directory");
	// A link is never followed for the answer: it is "other", and its own size is not the target's.
	const link = await call(session, REMOTE_HELPER_METHOD_FS_STAT, { path: "inside-link" });
	assert.equal(link.kind, "other", "lstat semantics: the entry itself is classified, never its target");
	assert.notEqual(link.kind, "directory");
	// The link that resolves outside the root is not classified at all: it is refused before the lstat.
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_STAT, { path: "escape" }, "PATH_OUTSIDE_ROOT");
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_STAT, { path: "sub/missing.txt" }, "PATH_NOT_FOUND");
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_STAT, { path: "alpha.txt/child" }, THROUGH_A_FILE);
	for (const params of [undefined, {}, { path: "" }, { path: 7 }, { path: null }, { path: "a".repeat(REMOTE_HELPER_MAX_PATH_LENGTH + 1) }, { path: "a\u0000b" }]) {
		await expectRefusal(session, REMOTE_HELPER_METHOD_FS_STAT, params, "PROTOCOL_INVALID");
	}
	assert.equal(session.stderr(), "");
});

helperTest("fs.list answers name-sorted entries and never follows a link", async (t) => {
	const fixture = createFsFixture(t);
	const session = startHelper(t, { root: fixture.root });
	const listing = plain(await call(session, REMOTE_HELPER_METHOD_FS_LIST, { path: "." }));
	assert.deepEqual(Object.keys(listing), contractFields("RemoteHelperListResult"));
	assert.deepEqual(
		listing.entries.map((entry) => entry.name),
		["alpha.txt", "empty.txt", "escape", "inside-link", "sub"],
		"entries are sorted by name in code-unit order",
	);
	for (const entry of listing.entries) {
		const fields = Object.keys(entry);
		assert.ok(
			fields.every((field) => contractFields("RemoteHelperListEntry").includes(field)),
			JSON.stringify(fields),
		);
		assert.ok(["file", "directory", "other"].includes(entry.kind), entry.kind);
		// bytes travels for regular files only; a negative or non-numeric size would be a shape bug.
		if (entry.kind === "file") assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0, JSON.stringify(entry));
		else assert.equal(entry.bytes, undefined, JSON.stringify(entry));
	}
	assert.deepEqual(
		listing.entries.find((entry) => entry.name === "alpha.txt"),
		{ name: "alpha.txt", kind: "file", bytes: "alpha content".length },
	);
	assert.deepEqual(
		listing.entries.find((entry) => entry.name === "sub"),
		{ name: "sub", kind: "directory" },
	);
	assert.deepEqual(
		listing.entries.find((entry) => entry.name === "escape"),
		{ name: "escape", kind: "other" },
	);
	assert.deepEqual(
		listing.entries.find((entry) => entry.name === "inside-link"),
		{ name: "inside-link", kind: "other" },
	);
	// A subdirectory is listed by name, and an empty directory is a valid, empty answer.
	assert.deepEqual(
		(await call(session, REMOTE_HELPER_METHOD_FS_LIST, { path: "sub" })).entries.map((entry) => entry.name),
		["beta.txt", "zeta.txt"],
	);
	mkdirSync(join(fixture.root, "void"));
	assert.deepEqual((await call(session, REMOTE_HELPER_METHOD_FS_LIST, { path: "void" })).entries, []);
	// A file is not a directory, a missing path is not a listing, and a link is not followed into a listing.
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_LIST, { path: "alpha.txt" }, "NOT_A_DIRECTORY");
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_LIST, { path: "void/nothing" }, "PATH_NOT_FOUND");
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_LIST, { path: "inside-link" }, "NOT_A_DIRECTORY");
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_LIST, { path: "escape" }, "PATH_OUTSIDE_ROOT");
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_LIST, { path: ".." }, "PATH_OUTSIDE_ROOT");
	for (const params of [undefined, {}, { path: "" }, { path: 7 }, { path: "a".repeat(REMOTE_HELPER_MAX_PATH_LENGTH + 1) }]) {
		await expectRefusal(session, REMOTE_HELPER_METHOD_FS_LIST, params, "PROTOCOL_INVALID");
	}
	assert.ok(
		session.lines.every((line) => !line.includes(DECOY)),
		"no frame may carry the decoy",
	);
	assert.equal(session.stderr(), "");
});

helperTest("fs.read returns one bounded chunk and reports EOF honestly", async (t) => {
	const fixture = createFsFixture(t);
	const session = startHelper(t, { root: fixture.root });
	const first = await call(session, REMOTE_HELPER_METHOD_FS_READ, { path: "alpha.txt", offset: 0, bytes: 5 });
	assert.deepEqual(Object.keys(first), contractFields("RemoteHelperReadResult"));
	assert.deepEqual(first, { chunk: Buffer.from("alpha").toString("base64"), bytes: 5, eof: false });
	assert.equal(Buffer.from(first.chunk, "base64").toString("utf8"), "alpha");
	// A chunk that reaches the end of the file is a short read, and it says so.
	const tail = await call(session, REMOTE_HELPER_METHOD_FS_READ, { path: "alpha.txt", offset: 6, bytes: 64 });
	assert.equal(Buffer.from(tail.chunk, "base64").toString("utf8"), "content");
	assert.equal(tail.bytes, "content".length);
	assert.equal(tail.eof, true);
	// The whole file is the boundary case of the same call.
	const whole = await call(session, REMOTE_HELPER_METHOD_FS_READ, { path: "alpha.txt", offset: 0, bytes: "alpha content".length });
	assert.deepEqual(whole, { chunk: Buffer.from("alpha content").toString("base64"), bytes: "alpha content".length, eof: true });
	// An offset at EOF answers with nothing and says EOF, and so does an offset past it.
	for (const offset of ["alpha content".length, "alpha content".length + 100]) {
		assert.deepEqual(await call(session, REMOTE_HELPER_METHOD_FS_READ, { path: "alpha.txt", offset, bytes: 64 }), { chunk: "", bytes: 0, eof: true }, `offset ${offset}`);
	}
	// bytes=0 reads nothing: not EOF while the file still has data at that offset.
	assert.deepEqual(await call(session, REMOTE_HELPER_METHOD_FS_READ, { path: "alpha.txt", offset: 0, bytes: 0 }), { chunk: "", bytes: 0, eof: false });
	assert.deepEqual(await call(session, REMOTE_HELPER_METHOD_FS_READ, { path: "empty.txt", offset: 0, bytes: 64 }), { chunk: "", bytes: 0, eof: true });
	// Reading through a link that resolves inside the root is the ordinary case (a linked workspace file):
	// the resolved path is what gets opened, while stat and list above still describe the link itself.
	assert.equal(Buffer.from((await call(session, REMOTE_HELPER_METHOD_FS_READ, { path: "inside-link/beta.txt", offset: 0, bytes: 64 })).chunk, "base64").toString("utf8"), "beta content");
	// A directory, a missing path and a path through a file are refusals, not partial answers.
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_READ, { path: "sub", offset: 0, bytes: 8 }, "NOT_A_FILE");
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_READ, { path: ".", offset: 0, bytes: 8 }, "NOT_A_FILE");
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_READ, { path: "inside-link", offset: 0, bytes: 8 }, "NOT_A_FILE");
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_READ, { path: "missing.txt", offset: 0, bytes: 8 }, "PATH_NOT_FOUND");
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_READ, { path: "alpha.txt/child", offset: 0, bytes: 8 }, THROUGH_A_FILE);
	// The chunk ceiling is the contract's: a larger request is refused rather than silently shortened.
	for (const params of [
		{ path: "alpha.txt", offset: 0, bytes: REMOTE_HELPER_MAX_CHUNK_BYTES + 1 },
		{ path: "alpha.txt", offset: -1, bytes: 8 },
		{ path: "alpha.txt", offset: 1.5, bytes: 8 },
		{ path: "alpha.txt", offset: 0, bytes: -1 },
		{ path: "alpha.txt", offset: 0, bytes: 1.5 },
		{ path: "alpha.txt", offset: 0, bytes: "8" },
		{ path: "alpha.txt", offset: Number.MAX_SAFE_INTEGER + 2, bytes: 8 },
		{ path: "alpha.txt", offset: 0 },
		{ path: "alpha.txt", bytes: 8 },
		{ path: "alpha.txt", offset: null, bytes: 8 },
	]) {
		await expectRefusal(session, REMOTE_HELPER_METHOD_FS_READ, params, "PROTOCOL_INVALID");
	}
	assert.equal(session.stderr(), "");
});

helperTest(
	"fs.read reassembles a file larger than one chunk with every frame inside the cap",
	async (t) => {
		const fixture = createFsFixture(t);
		// Deterministic bytes, and a length that is not a multiple of the chunk or of three: the last chunk
		// therefore exercises both the short read and the base64 padding path.
		const content = Buffer.alloc(REMOTE_HELPER_MAX_CHUNK_BYTES + 1234);
		for (let index = 0; index < content.length; index += 1) content[index] = index % 251;
		writeFileSync(join(fixture.root, "big.bin"), content);
		const session = startHelper(t, { root: fixture.root });
		const chunks = [];
		let offset = 0;
		let guardCount = 0;
		for (;;) {
			guardCount += 1;
			assert.ok(guardCount < 8, "the reader must reach EOF in a bounded number of chunks");
			const chunk = await call(session, REMOTE_HELPER_METHOD_FS_READ, { path: "big.bin", offset, bytes: REMOTE_HELPER_MAX_CHUNK_BYTES });
			assert.equal(chunk.bytes, Buffer.from(chunk.chunk, "base64").length, "bytes is the decoded length");
			chunks.push(Buffer.from(chunk.chunk, "base64"));
			offset += chunk.bytes;
			if (chunk.eof) break;
		}
		const reassembled = Buffer.concat(chunks);
		assert.equal(reassembled.length, content.length);
		assert.equal(createHash("sha256").update(reassembled).digest("hex"), createHash("sha256").update(content).digest("hex"), "the chunks must reassemble the original bytes");
		assert.equal(chunks.length, 2, "one full chunk plus the tail");
		assert.equal(chunks[0].length, REMOTE_HELPER_MAX_CHUNK_BYTES);
		// The declared chunk ceiling is safe by arithmetic, not by luck: 1 MiB of bytes is at most
		// 1398104 base64 characters, so the worst-case frame stays an order of magnitude below 8 MiB.
		const worstCaseFrame = 4 * Math.ceil(REMOTE_HELPER_MAX_CHUNK_BYTES / 3) + 512;
		assert.ok(worstCaseFrame < REMOTE_HELPER_MAX_FRAME_BYTES, `${worstCaseFrame} must stay below the frame cap`);
		const chunkLines = session.lines.filter((line) => line.includes('"chunk"'));
		assert.equal(chunkLines.length, 2);
		for (const line of chunkLines) {
			assert.ok(Buffer.byteLength(line, "utf8") <= worstCaseFrame, `a chunk frame of ${Buffer.byteLength(line, "utf8")} bytes exceeds the declared worst case`);
			assert.ok(Buffer.byteLength(line, "utf8") < REMOTE_HELPER_MAX_FRAME_BYTES, "a chunk frame must fit the frame cap");
		}
		assert.ok(chunkLines[0].includes(Buffer.from(content.subarray(0, 3)).toString("base64").slice(0, 8)), "the first frame carries the head of the file");
		assert.equal(session.stderr(), "");
	},
	60_000,
);

helperTest("every path that could leave the root is refused without reading the target", async (t) => {
	const fixture = createFsFixture(t);
	const session = startHelper(t, { root: fixture.root });
	const cases = [
		// Lexical escapes: refused before any filesystem access at all.
		["a parent traversal", { path: "../outside/secret.txt", offset: 0, bytes: 32 }],
		["a deep traversal", { path: "sub/../../outside/secret.txt", offset: 0, bytes: 32 }],
		["a bare parent", { path: ".." }],
		["an absolute path", { path: join(fixture.outside, "secret.txt") }],
		["a windows separator", { path: "..\\outside\\secret.txt", offset: 0, bytes: 32 }],
		["a windows drive", { path: "C:/Windows/win.ini" }],
		["an encoded traversal", { path: "%2e%2e%2foutside%2fsecret.txt", offset: 0, bytes: 32 }],
		["an encoded dot segment", { path: "%2E%2E/outside/secret.txt", offset: 0, bytes: 32 }],
		["an encoded backslash", { path: "..%5coutside%5csecret.txt", offset: 0, bytes: 32 }],
		["a traversal into an unsearchable directory", { path: "../outside/blocked/marker.txt", offset: 0, bytes: 32 }],
		// The case no string rule can catch: the path is inside the root until the link is resolved.
		["a link out of the root", { path: "escape/secret.txt", offset: 0, bytes: 32 }],
		["a link out of the root as a directory", { path: "escape" }],
		["a link out of the root listed", { path: "escape/blocked" }],
	];
	for (const [label, params] of cases) {
		for (const method of [REMOTE_HELPER_METHOD_FS_STAT, REMOTE_HELPER_METHOD_FS_LIST, REMOTE_HELPER_METHOD_FS_READ]) {
			await expectRefusal(session, method, params, "PATH_OUTSIDE_ROOT");
		}
	}
	// No refusal may have produced a result, and no line — request echo or answer — may carry the decoy
	// bytes: a helper that opened the target and refused afterwards would still have read them.
	assert.ok(session.frames.length >= cases.length * 3);
	assert.ok(
		session.frames.every((frame) => frame.ok === false),
		"an escape must never be answered with a result",
	);
	assert.ok(
		session.lines.every((line) => !line.includes(DECOY)),
		"the decoy was read or echoed",
	);
	assert.ok(
		session.lines.every((line) => !line.includes(Buffer.from(DECOY, "utf8").toString("base64"))),
		"the decoy must not travel base64 encoded either",
	);
	assert.equal(session.stderr(), "");
	// The helper is intact and still serves the same tree.
	assert.equal((await call(session, REMOTE_HELPER_METHOD_FS_STAT, { path: "alpha.txt" })).kind, "file");
});

helperTest(
	"fs.list serves a directory at the entry cap and refuses one above it",
	async (t) => {
		const fixture = createFsFixture(t);
		const session = startHelper(t, { root: fixture.root });
		const many = join(fixture.root, "many");
		mkdirSync(many);
		const nameOf = (index) => `f${String(index).padStart(5, "0")}.txt`;
		for (let index = 0; index < REMOTE_HELPER_MAX_LIST_ENTRIES; index += 1) writeFileSync(join(many, nameOf(index)), "");
		// At the cap the listing is complete and sorted: the ceiling is inclusive, not a truncation point.
		const listing = plain(await call(session, REMOTE_HELPER_METHOD_FS_LIST, { path: "many" }));
		assert.equal(listing.entries.length, REMOTE_HELPER_MAX_LIST_ENTRIES);
		assert.equal(listing.entries[0].name, nameOf(0));
		assert.equal(listing.entries.at(-1).name, nameOf(REMOTE_HELPER_MAX_LIST_ENTRIES - 1));
		const listingLine = session.lines.filter((line) => line.includes('"entries"')).at(-1);
		assert.ok(Buffer.byteLength(listingLine, "utf8") < REMOTE_HELPER_MAX_FRAME_BYTES, "a full listing must fit one frame");
		// One entry past the cap is a refusal, not a partial listing that looks complete.
		writeFileSync(join(many, "zzz-overflow.txt"), "");
		await expectRefusal(session, REMOTE_HELPER_METHOD_FS_LIST, { path: "many" }, "RESULT_TOO_LARGE");
		assert.equal(session.stderr(), "");
	},
	60_000,
);

helperTest("a file that changes while it is being read still settles", async (t) => {
	const fixture = createFsFixture(t);
	const session = startHelper(t, { root: fixture.root });
	const target = join(fixture.root, "alpha.txt");
	assert.equal(Buffer.from((await call(session, REMOTE_HELPER_METHOD_FS_READ, { path: "alpha.txt", offset: 0, bytes: 5 })).chunk, "base64").toString("utf8"), "alpha");
	// Truncated between two reads: the next read reports what is left instead of a stale length.
	truncateSync(target, 2);
	const truncated = await call(session, REMOTE_HELPER_METHOD_FS_READ, { path: "alpha.txt", offset: 0, bytes: 64 });
	assert.deepEqual(truncated, { chunk: Buffer.from("al").toString("base64"), bytes: 2, eof: true });
	// Replaced between two reads: the new bytes are what comes back, and the helper stays usable.
	writeFileSync(target, "replacement");
	assert.equal(Buffer.from((await call(session, REMOTE_HELPER_METHOD_FS_READ, { path: "alpha.txt", offset: 0, bytes: 64 })).chunk, "base64").toString("utf8"), "replacement");
	assert.equal((await call(session, REMOTE_HELPER_METHOD_HELLO)).protocolVersion, REMOTE_HELPER_PROTOCOL_VERSION);
	// Shrunk below the requested range while the reader holds an offset: still an answer, never a crash.
	truncateSync(target, 1);
	assert.deepEqual(await call(session, REMOTE_HELPER_METHOD_FS_READ, { path: "alpha.txt", offset: 4, bytes: 64 }), { chunk: "", bytes: 0, eof: true });
	assert.equal(session.stderr(), "");
});

helperTest("a link whose target is gone is a link for stat and a missing file for read", async (t) => {
	const fixture = createFsFixture(t);
	const session = startHelper(t, { root: fixture.root });
	// The fixture's inside-link points at root/sub. Removing that directory is what a checkout or a cleanup
	// does to a linked workspace entry: the link itself stays, and no privilege is needed to make it dangle.
	rmSync(join(fixture.root, "sub"), { recursive: true, force: true });
	const dangling = await call(session, REMOTE_HELPER_METHOD_FS_STAT, { path: "inside-link" });
	assert.equal(dangling.kind, "other", "the link is still an entry, so stat answers about the link itself");
	// A link with no resolvable target is a missing file, not an unreadable one, and never a listing.
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_READ, { path: "inside-link", offset: 0, bytes: 8 }, "PATH_NOT_FOUND");
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_READ, { path: "inside-link/beta.txt", offset: 0, bytes: 8 }, "PATH_NOT_FOUND");
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_LIST, { path: "inside-link" }, "NOT_A_DIRECTORY");
	// The rest of the tree is untouched, so a lost target is a refusal about one path, not a broken session.
	assert.equal(Buffer.from((await call(session, REMOTE_HELPER_METHOD_FS_READ, { path: "alpha.txt", offset: 0, bytes: 5 })).chunk, "base64").toString("utf8"), "alpha");
	assert.equal(session.stderr(), "");
});

helperTest("the read-only methods run inline and never take an echo slot", async (t) => {
	const fixture = createFsFixture(t);
	const session = startHelper(t, { root: fixture.root });
	// Every slot is held by a slow echo: a stat that queued behind them would answer only after the hold.
	const holding = Array.from({ length: REMOTE_HELPER_MAX_CONCURRENT_REQUESTS }, (_value, index) => {
		const busy = session.client.request(REMOTE_HELPER_METHOD_ECHO, { text: `h${index}`, delayMs: REMOTE_HELPER_MAX_ECHO_DELAY_MS });
		// EOF ends the session with these still pending; a late rejection is expected and must not surface
		// as an unhandled rejection in the runner.
		busy.catch(() => {});
		return busy;
	});
	const startedAt = Date.now();
	const stat = await call(session, REMOTE_HELPER_METHOD_FS_STAT, { path: "alpha.txt" });
	const elapsed = Date.now() - startedAt;
	assert.equal(stat.kind, "file");
	assert.ok(elapsed < REMOTE_HELPER_MAX_ECHO_DELAY_MS / 2, `a read-only method must not wait for an echo slot (took ${elapsed} ms)`);
	assert.equal((await call(session, REMOTE_HELPER_METHOD_FS_READ, { path: "alpha.txt", offset: 0, bytes: 4 })).bytes, 4);
	session.client.closeConnection();
	session.endStdin();
	assert.equal(await session.waitForExit(4000), 0);
	await Promise.all(holding.map((promise) => promise.catch(() => undefined)));
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
	// Hold for the full echo budget: the reviewer's gated-transport probe showed a late cancel frame can
	// flip this assertion once the hold is short, and 5s is the widest margin the helper offers.
	const hold = REMOTE_HELPER_MAX_ECHO_DELAY_MS;
	const holding = Array.from({ length: slots }, (_value, index) => client.request(REMOTE_HELPER_METHOD_ECHO, { text: `c${index}`, delayMs: hold }));
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
	for (const [index, result] of results.entries()) assert.deepEqual(plain(result), { text: `c${index}`, delayMs: hold });
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

helperTest("a byte sequence that is not utf8 inside a string value fails closed", async (t) => {
	const session = startHelper(t);
	// Lossy decoding used to turn these bytes into U+FFFD and let the frame through as ok, which the
	// client drops by identity: a remote success reported as a local timeout. It must be refused, and
	// the refusal has to be a frame, because a silent death leaves the caller waiting for its deadline.
	const head = Buffer.from('{"v":1,"hostId":"01234567-89ab', "utf8");
	const tail = Buffer.from('cdef-4def-0123456789ab","generation":1,"id":"raw-bad-utf8","method":"hello"}\n', "utf8");
	session.child.stdin.write(Buffer.concat([head, Buffer.from([0xff, 0xfe]), tail]));
	const before = session.frames.length;
	await guard(session.waitForFrames(before + 1, "the refusal of a non-utf8 frame"), "the refusal frame");
	const refusal = session.frames.at(-1);
	assert.equal(refusal.ok, false);
	assert.equal(refusal.error.code, "PROTOCOL_INVALID");
	assert.equal(refusal.error.retryable, false);
	assert.equal(refusal.id, "", "a frame that could not be decoded has no identity to echo");
	// The helper stays usable: a well-formed frame after the refusal is still served.
	assert.equal(plain(await guard(session.client.request(REMOTE_HELPER_METHOD_HELLO), "hello after the refusal")).protocolVersion, REMOTE_HELPER_PROTOCOL_VERSION);
});

helperTest("a queued request that outlives its deadline is refused instead of running late", async (t) => {
	const session = startHelper(t);
	// Four slots held, then a fifth request that cannot start before its own deadline passes. The client
	// settles it locally first; the helper has to refuse it as well, otherwise the work would run after
	// the caller was told it timed out (and a retry would execute it a second time).
	const holding = Array.from({ length: REMOTE_HELPER_MAX_CONCURRENT_REQUESTS }, (_value, index) => session.client.request(REMOTE_HELPER_METHOD_ECHO, { text: `h${index}`, delayMs: 400 }));
	const late = session.client.request(REMOTE_HELPER_METHOD_ECHO, { text: "late", delayMs: 0 }, { timeoutMs: 100 });
	late.catch(() => {});
	const lateId = session.requestIdAt(REMOTE_HELPER_MAX_CONCURRENT_REQUESTS);
	await guard(Promise.all(holding), "the four scheduled echoes");
	const refusal = session.frames.find((candidate) => candidate.id === lateId && candidate.ok === false);
	assert.ok(refusal, "the helper must answer the expired request");
	assert.equal(refusal.error.code, "REQUEST_TIMEOUT");
	assert.equal(refusal.error.retryable, true);
	assert.equal(
		session.frames.some((candidate) => candidate.id === lateId && candidate.ok === true),
		false,
		"an expired request must never be answered with a result",
	);
});

helperTest("the frozen field bounds match the contract both sides share", () => {
	// The helper cannot import the contract, so this is what stops the two from drifting apart: a host id
	// past the helper bound turns every request on that connection into a silent timeout.
	assert.equal(Number("64"), REMOTE_HELPER_MAX_HOST_ID_LENGTH);
	assert.equal(Number("128"), REMOTE_HELPER_MAX_ID_LENGTH);
	assert.equal(Number("64"), REMOTE_HELPER_MAX_METHOD_LENGTH);
	assert.equal(Number("4096"), REMOTE_HELPER_MAX_ECHO_TEXT_LENGTH);
	// The read-only batch states the same bounds: one chunk ceiling, one listing ceiling, one path ceiling.
	assert.equal(Number("1048576"), REMOTE_HELPER_MAX_CHUNK_BYTES);
	assert.equal(Number("4096"), REMOTE_HELPER_MAX_LIST_ENTRIES);
	assert.equal(Number("4096"), REMOTE_HELPER_MAX_PATH_LENGTH);
	assert.equal(REMOTE_HELPER_METHOD_FS_STAT, "fs.stat");
	assert.equal(REMOTE_HELPER_METHOD_FS_LIST, "fs.list");
	assert.equal(REMOTE_HELPER_METHOD_FS_READ, "fs.read");
	// Every refusal the batch can produce is a declared code, and the declared vocabulary stays closed.
	for (const code of ["PATH_OUTSIDE_ROOT", "RESULT_TOO_LARGE", "PATH_NOT_FOUND", "NOT_A_DIRECTORY", "NOT_A_FILE", "PERMISSION_DENIED", "IO_ERROR", "ROOT_INVALID"]) {
		assert.ok(REMOTE_HELPER_ERROR_CODES.includes(code), code);
	}
	assert.deepEqual(contractFields("RemoteHelperStatResult"), ["kind", "bytes", "mtimeMs"]);
	assert.deepEqual(contractFields("RemoteHelperReadResult"), ["chunk", "bytes", "eof"]);
	assert.equal(contractFields("RemoteHelperListEntry").includes("bytes"), true);
	assert.equal(contractFields("RemoteHelperListEntry").includes("name"), true);
	assert.equal(contractFields("RemoteHelperListEntry").includes("kind"), true);
});

helperTest("a frame-cap violation abandons admitted work, which the caller sees as a lost transport", async (t) => {
	const session = startHelper(t);
	// The documented exception to one-terminal-outcome-per-request: the echo below is admitted and holds
	// a slot, then an oversized tail ends the process before its timer fires. The client therefore gets a
	// dead transport rather than a silence it would misread as its own deadline.
	const admitted = session.client.request(REMOTE_HELPER_METHOD_ECHO, { text: "admitted", delayMs: 5_000 });
	admitted.catch(() => {});
	const admittedId = session.requestIdAt(0);
	assert.equal(plain(await guard(session.client.request(REMOTE_HELPER_METHOD_HELLO), "hello before the oversized tail")).protocolVersion, REMOTE_HELPER_PROTOCOL_VERSION);
	// One oversized unterminated tail: over the cap without ever becoming a line.
	session.child.stdin.write(Buffer.alloc(REMOTE_HELPER_MAX_FRAME_BYTES + 1, 0x41));
	await guard(session.waitForFrames(2, "the refusal frame"), "the refusal frame");
	assert.equal(session.frames.at(-1).error.code, "PROTOCOL_INVALID");
	assert.notEqual(await session.waitForExit(2_000), 0, "the cap violation is fatal, not a served refusal");
	assert.equal(
		session.frames.some((frame) => frame.id === admittedId && frame.ok === true),
		false,
		"the admitted request is abandoned without an answer",
	);
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
	// The uploaded artifact is started exactly the way the remote command does it: a real file and the
	// root as a plain argv pair, with no `--` separator in front of the flag.
	const root = createRootFixture(t);
	await writeFile(join(root, "entry.txt"), "uploaded");
	const session = startHelper(t, { entryPath, root });
	// Registered after the helper, so the child is stopped before Windows tries to remove its file.
	t.after(() => rm(directory, { recursive: true, force: true }));
	const result = plain(await guard(session.client.request(REMOTE_HELPER_METHOD_HELLO), "hello from the uploaded entry"));
	assert.equal(result.helperVersion, REMOTE_HELPER_ENTRY_VERSION);
	assert.equal(result.home, HELPER_HOME);
	assert.deepEqual(result.capabilities, Array.from(REMOTE_HELPER_CAPABILITIES));
	assert.deepEqual(plain(await guard(session.client.request(REMOTE_HELPER_METHOD_ECHO, { text: "file" }), "echo from the uploaded entry")), { text: "file", delayMs: 0 });
	// The ES module artifact loads its two builtins and confines itself to the same root.
	assert.deepEqual(await call(session, REMOTE_HELPER_METHOD_FS_LIST, { path: "." }), { entries: [{ name: "entry.txt", kind: "file", bytes: "uploaded".length }] });
	assert.equal(Buffer.from((await call(session, REMOTE_HELPER_METHOD_FS_READ, { path: "entry.txt", offset: 0, bytes: 8 })).chunk, "base64").toString("utf8"), "uploaded");
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_READ, { path: "../entry.txt", offset: 0, bytes: 8 }, "PATH_OUTSIDE_ROOT");
	session.endStdin();
	assert.equal(await session.waitForExit(4000), 0);
});
