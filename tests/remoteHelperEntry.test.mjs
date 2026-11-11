import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { fileSymlinkSkipReason } from "./helpers/symlinkSupport.mjs";

/*
 * Integration proof for the frozen remote helper (plan §7.1). The helper is a real child process
 * started from REMOTE_HELPER_INLINE_SOURCE and the client is the production RemoteControlClient: the
 * two sides are only ever driven through each other, so a frame shape that one side changes without
 * the other fails here. Raw writes cover the frames the client is required to refuse to send (a
 * malformed frame, an over-cap frame), and every wait is bounded, because "the helper stopped
 * answering" has to fail the test instead of hanging it.
 *
 * The read-only batch (fs.stat/fs.list/fs.read) is proved the same way: a real child process with a real
 * root, real files, real links — to a file, to a directory, with a relative target, dangling, out of the
 * root once with a target that exists and once without — and a real decoy outside it. Nothing about the
 * confinement is asserted through a stub, because a stub cannot show that the target was never touched,
 * and no method of the batch is allowed to follow a link: stat and list describe the link itself as
 * `other`, and read refuses the same entry as NOT_A_FILE instead of resolving it.
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
	REMOTE_HELPER_MAX_SEARCH_DEPTH,
	REMOTE_HELPER_MAX_SEARCH_MATCHES,
	REMOTE_HELPER_MAX_SEARCH_QUERY_LENGTH,
	REMOTE_HELPER_MAX_SEARCH_SCANNED,
	REMOTE_HELPER_MAX_STAT_MANY_PATHS,
	REMOTE_HELPER_MAX_QUEUED_REQUESTS,
	REMOTE_HELPER_METHOD_CANCEL,
	REMOTE_HELPER_METHOD_ECHO,
	REMOTE_HELPER_METHOD_FS_LIST,
	REMOTE_HELPER_METHOD_FS_READ,
	REMOTE_HELPER_METHOD_FS_SEARCH_NAMES,
	REMOTE_HELPER_METHOD_FS_STAT,
	REMOTE_HELPER_METHOD_FS_STAT_MANY,
	REMOTE_HELPER_METHOD_GIT_REPOS,
	REMOTE_HELPER_METHOD_HELLO,
	REMOTE_HELPER_MAX_ECHO_TEXT_LENGTH,
	REMOTE_HELPER_MAX_HOST_ID_LENGTH,
	REMOTE_HELPER_MAX_ID_LENGTH,
	REMOTE_HELPER_MAX_METHOD_LENGTH,
	REMOTE_HELPER_PROTOCOL_VERSION,
	REMOTE_HELPER_MAX_REQUEST_TIMEOUT_MS,
	REMOTE_GIT_READ_TIMEOUT_MS,
	REMOTE_GIT_REPO_READ_METHODS,
	REMOTE_GIT_REPO_WRITE_METHODS,
	REMOTE_GIT_SYNC_TIMEOUT_MS,
	REMOTE_TERMINAL_TICKET_TTL_MS,
	REMOTE_TERMINAL_TICKET_CLAIM_PATTERN,
} = loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");
const {
	REMOTE_HELPER_ARTIFACTS,
	REMOTE_HELPER_ENTRY_FILE_NAME,
	REMOTE_HELPER_ENTRY_SHA256,
	REMOTE_HELPER_ENTRY_VERSION,
	REMOTE_HELPER_CONFIG_SHA256,
	REMOTE_HELPER_SEARCH_CONTENT_SHA256,
	REMOTE_HELPER_UPLOAD_COMMIT_SHA256,
	REMOTE_UPLOAD_COMMIT_FILE_NAME,
	REMOTE_HELPER_GIT_READ_SHA256,
	REMOTE_HELPER_GIT_SYNC_SHA256,
	REMOTE_HELPER_GIT_WRITE_SHA256,
	REMOTE_HELPER_INLINE_SOURCE,
} = loadTsCommonJs("src/main/remote/RemoteHelperEntry.ts");
const { REMOTE_TERMINAL_RUNNER_ENTRY_SHA256 } = loadTsCommonJs("src/main/remote/RemoteTerminalRunnerEntry.ts");
const { REMOTE_GIT_READ_SOURCE } = loadTsCommonJs("src/main/remote/RemoteGitReadSource.ts");
const { materializeRemoteHelperArtifacts } = await import("./helpers/remoteHelperArtifacts.mjs");
const { REMOTE_FRAME_DIAGNOSTIC_CODES, createRemoteControlClient } = loadTsCommonJs("src/main/remote/RemoteControlClient.ts");

/** Same host id shape the host store mints; the client only bounds it by length and control bytes. */
const HOST_ID = "01234567-89ab-4def-8123-456789abcdef";
/** The helper never resolves HOME into a path, so a POSIX literal is the honest fixture on any platform. */
const HELPER_HOME = "/home/pideck-helper";
/** Frozen digest, pinned here as well as in the module: editing the source means editing both. */
const FROZEN_SHA256 = "303cd19b3e98eef25eab6921bcffc7c10632f7af0e21ef56840c78cf0d308373";
const MAX_TEXT = 4096;
const TEST_TIMEOUT_MS = 30_000;
const GUARD_TIMEOUT_MS = 10_000;
const DROP_CODES = new Set(Object.values(REMOTE_FRAME_DIAGNOSTIC_CODES));
const UPLOAD_CAPABILITIES = new Set(["fs.uploadPrepare", "fs.uploadCommit", "fs.uploadAbort"]);
const withoutUploadCapabilities = (capabilities) => Array.from(capabilities).filter((capability) => UPLOAD_CAPABILITIES.has(capability) === false);
/** The token a refusal must never have read: it exists only outside the root. */
const DECOY = "pideck-decoy-7f3a1c";
/** Contract source read back by this suite: the result shapes are asserted against the declared types. */
const CONTRACT_SOURCE = "src/main/remote/RemoteHelperContract.ts";

/** Every test drives real child processes, so each one carries a hard deadline of its own. */
const helperTest = (name, fn, timeoutMs = TEST_TIMEOUT_MS) => test(name, { timeout: timeoutMs }, fn);

/** 需要真实「文件符号链接」夹具的用例：平台造不出文件链接时跳过（见 tests/helpers/symlinkSupport.mjs）。
 *  目录 junction 不需要特权，所以只跳过依赖文件链接的这批，其余 helper 用例照常跑。 */
const linkHelperTest = (name, fn, timeoutMs = TEST_TIMEOUT_MS) => test(name, { timeout: timeoutMs, skip: fileSymlinkSkipReason() }, fn);

/**
 * The entry nearly every test starts: the frozen bytes written under the file name the deploy bundle
 * uploads them as, once per run, inside the platform temp directory.
 *
 * Starting a file is how the helper is deployed, and unlike `node -e <source>` it costs no command line at
 * all - which is what keeps a body of tens of kilobytes startable on Windows, where a whole CreateProcess
 * command line is capped at 32767 characters and going over is a spawn failure rather than a helper that
 * misbehaves (the source-size test states that budget and measures the `-e` shape against it). Two tests
 * still start the `-e` shape on purpose; everything else starts this file.
 *
 * One copy per run instead of one per test, because every test starts the same bytes and the file has to
 * outlive the last child that reads it - hence the file-scope hook rather than a test hook. The retries
 * absorb a Windows directory removal racing a closing handle.
 */
const ENTRY_DIRECTORY = mkdtempSync(join(tmpdir(), "pideck-helper-entry-"));
// The bundle is several files, so the whole reviewed set is written: the entry imports its siblings, and an
// entry-only directory would fail to start at all.
const ENTRY_PATH = materializeRemoteHelperArtifacts(ENTRY_DIRECTORY).entryPath;
after(() => rmSync(ENTRY_DIRECTORY, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

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
 * deterministic: retrying the same params cannot fix an escape or a missing file. The request id is read
 * before the answer arrives, so the same request can also be proved never to have produced a result: a
 * refusal that came with an ok frame would mean the helper did the work and then declined to admit it.
 */
async function expectRefusal(session, method, params, code) {
	const expected = Array.isArray(code) ? code : [code];
	const pending = session.client.request(method, params);
	const id = session.requestIdAt(session.sent.length - 1);
	const error = await rejection(guard(pending, `${method} refusal`));
	assert.ok(expected.includes(error.code), `${method} ${JSON.stringify(params)} answered ${error.code}, expected ${expected.join(" or ")}`);
	assert.equal(error.retryable, false, `${method} ${JSON.stringify(params)}`);
	assert.ok(REMOTE_HELPER_ERROR_CODES.includes(error.code), `${error.code} is not in REMOTE_HELPER_ERROR_CODES`);
	assert.equal(
		session.frames.some((frame) => frame.id === id && frame.ok === true),
		false,
		`${method} ${JSON.stringify(params)} was refused and still answered with a result`,
	);
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
 * A root with what the read-only methods need around it: a small tree inside, a decoy tree outside and the
 * links of both directions described below. The decoy carries a token no frame may ever contain, and on
 * POSIX it is unreadable and its directory unsearchable, so "the helper refused" is distinguishable from
 * "the helper tried and failed": a read attempt could only answer PERMISSION_DENIED.
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
	// 文件符号链接在无特权的 Windows 上不可用（EPERM）；需要链接的用例已用 linkHelperTest 跳过，
	// fixture 里降级为不建文件链接，让 refusal/协议形状类用例仍能在这些机器上验证。
	const fileSymlinksUsable = fileSymlinkSkipReason() === undefined;
	// The links the three read-only methods have to agree about: a target that is a file, one that is a
	// directory, one written as a relative target, one that does not exist, and targets outside the root —
	// once pointing at something that exists and once dangling. None of them is ever followed: stat and
	// list describe the link itself (`other`), and read refuses the path instead of resolving it. Only the
	// two that point out of the root are answered by the containment check rather than by read, and even
	// then the code differs with the target: PATH_OUTSIDE_ROOT while it exists, and read's own NOT_A_FILE
	// while it does not, so neither answer ever depends on opening the target.
	if (fileSymlinksUsable) symlinkSync(join(outside, "secret.txt"), join(root, "outside-file"), process.platform === "win32" ? "file" : undefined);
	symlinkSync(join(root, "sub"), join(root, "inside-link"), process.platform === "win32" ? "junction" : "dir");
	if (fileSymlinksUsable) symlinkSync(join(root, "alpha.txt"), join(root, "alpha-link"), process.platform === "win32" ? "file" : undefined);
	if (fileSymlinksUsable) symlinkSync(join("sub", "zeta.txt"), join(root, "rel-link"), process.platform === "win32" ? "file" : undefined);
	if (fileSymlinksUsable) symlinkSync(join(root, "nothing.txt"), join(root, "gone-link"), process.platform === "win32" ? "file" : undefined);
	if (fileSymlinksUsable) symlinkSync(join(outside, "gone.txt"), join(root, "outside-gone"), process.platform === "win32" ? "file" : undefined);
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
 *
 * The startup shape is stated the same way. By default the body runs from a file - `node <entry> [--root
 * <root>]`, the deployed shape, and the one no command line length can bound. `argvSeparator: true` starts
 * that same file as `node <entry> -- [--root <root>]`, so the helper's own flag sits one argument further
 * along and the argv scan is exercised without the `node -e <source>` shape: helper build 1.6.0 outgrew the
 * Windows command line that shape needs, which the entry-size test below records in full.
 */
function startHelper(t, options = {}) {
	const env = { ...process.env };
	if (options.home === null) delete env.HOME;
	else env.HOME = options.home ?? HELPER_HOME;
	const rootArgs = options.rootArgs !== undefined ? options.rootArgs : options.root === null ? [] : ["--root", options.root === undefined ? createRootFixture(t) : options.root];
	// `--` keeps node from parsing the helper's own flag as a node option in the `-e` shape; a file entry
	// needs no separator, because everything after the script path is already a script argument.
	// Everything after `--` is a script argument, so the separator shifts argv exactly the way `node -e
	// <source> -- ...` used to - without a command line that carries the whole frozen body.
	const entryPath = options.entryPath ?? ENTRY_PATH;
	const argv = options.argvSeparator === true ? [entryPath, "--", ...rootArgs] : [entryPath, ...rootArgs];
	const child = spawn(process.execPath, argv, { env, stdio: ["pipe", "pipe", "pipe"] });
	const sent = [];
	const lines = [];
	const frames = [];
	const diagnostics = [];
	const events = [];
	const eventWaiters = new Set();
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
		// W6-b：变更事件走无 id 帧，客户端把它们交给这个观察者（与请求应答永不相混）。
		onEvent: (event) => {
			events.push(plain(event));
			for (const waiter of [...eventWaiters]) {
				if (waiter.predicate(event)) {
					eventWaiters.delete(waiter);
					waiter.resolve(plain(event));
				}
			}
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
		events,
		/** Resolves with the first event frame matching the predicate (W6-b: 无 id 的推送帧). */
		waitForEvent(predicate, timeoutMs = GUARD_TIMEOUT_MS) {
			const already = events.find(predicate);
			if (already !== undefined) return Promise.resolve(already);
			return new Promise((resolve, reject) => {
				const entry = {
					predicate,
					resolve: (event) => {
						clearTimeout(timer);
						resolve(event);
					},
				};
				const timer = setTimeout(() => {
					eventWaiters.delete(entry);
					reject(new Error("timed out waiting for a helper event"));
				}, timeoutMs);
				eventWaiters.add(entry);
			});
		},
		/** The root this helper was started with, or null for a host-only session. */
		root: rootArgs.length > 0 ? rootArgs[1] : null,
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

test("the terminal ticket lifetime is 60 s everywhere and cannot drift from the frozen helper", () => {
	// R2-2: the frozen plan allows an unconsumed ticket at most 60 s. Main's constant and the helper's literal
	// are two separate sources of truth, so equality is asserted instead of assumed.
	assert.equal(REMOTE_TERMINAL_TICKET_TTL_MS, 60_000);
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes("TERMINAL_TICKET_TTL = 60000"), "the frozen helper literal must be 60 s");
	assert.equal(REMOTE_HELPER_INLINE_SOURCE.includes("TERMINAL_TICKET_TTL = 120000"), false, "the pre-R2-2 120 s literal must be gone");
	assert.equal(REMOTE_TERMINAL_TICKET_TTL_MS, Number(REMOTE_HELPER_INLINE_SOURCE.match(/TERMINAL_TICKET_TTL = (\d+)/)[1]), "main TTL and the helper literal must stay equal");
	// The bounded sweep must know both temp shapes; the runner's claim name stays in the runner artifact.
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes("claim-[0-9a-f]{32}-[1-9][0-9]{0,9}"), "the helper sweep matches .claim-<ref>-<pid>");
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes("sweepTerminalTicketsAtStartup();"), "the helper sweeps at startup as well as on mint");
	assert.ok(REMOTE_TERMINAL_TICKET_CLAIM_PATTERN.test(".claim-" + "a".repeat(32) + "-4242"));
	assert.equal(REMOTE_TERMINAL_TICKET_CLAIM_PATTERN.test(".claim-" + "a".repeat(31) + "-4242"), false);
});

helperTest("every frozen bundle artifact is one byte-frozen ASCII line with its own pin", () => {
	// The deploy bundle ships several reviewed files - the protocol entry, the Git worker it imports and the write
	// programs that worker imports - and each one is content-addressed and pinned on its own. A change is only
	// legitimate together with a deliberate update of that file's digest.
	const expected = new Map([
		["helper.mjs", { sha256: FROZEN_SHA256, builtins: ["node:fs", "node:path", "node:crypto"], imports: ["upload-commit.mjs", "git-read.mjs", "config.mjs", "search-content.mjs"] }],
		["git-read.mjs", { sha256: REMOTE_HELPER_GIT_READ_SHA256, builtins: ["node:child_process", "node:crypto"], imports: ["git-write.mjs", "git-sync.mjs"] }],
		["git-write.mjs", { sha256: REMOTE_HELPER_GIT_WRITE_SHA256, builtins: [], imports: [] }],
		["git-sync.mjs", { sha256: REMOTE_HELPER_GIT_SYNC_SHA256, builtins: [], imports: [] }],
		["config.mjs", { sha256: REMOTE_HELPER_CONFIG_SHA256, builtins: [], imports: [] }],
		["search-content.mjs", { sha256: REMOTE_HELPER_SEARCH_CONTENT_SHA256, builtins: [], imports: [] }],
		[REMOTE_UPLOAD_COMMIT_FILE_NAME, { sha256: REMOTE_HELPER_UPLOAD_COMMIT_SHA256, builtins: [], imports: [] }],
		["terminal-runner.mjs", { sha256: REMOTE_TERMINAL_RUNNER_ENTRY_SHA256, builtins: ["node:fs", "node:path", "node:child_process"], imports: [] }],
	]);
	assert.deepEqual(
		Array.from(REMOTE_HELPER_ARTIFACTS, (artifact) => artifact.name),
		[...expected.keys()],
		"the bundle's file list is part of the reviewed surface",
	);
	for (const artifact of REMOTE_HELPER_ARTIFACTS) {
		const pins = expected.get(artifact.name);
		assert.ok(pins, `${artifact.name} must be pinned in this test`);
		const digest = createHash("sha256").update(artifact.source, "utf8").digest("hex");
		assert.equal(digest, pins.sha256, `${artifact.name} changed: update its pin in RemoteHelperEntry.ts and this digest in the same commit`);
		assert.equal(digest, artifact.sha256, `the exported digest of ${artifact.name} must describe the exported source`);
		assert.equal(Buffer.byteLength(artifact.source, "utf8"), artifact.source.length, `${artifact.name} stays printable ASCII`);
		assert.ok(!/[\r\n]/.test(artifact.source), `${artifact.name} is one line`);
		assert.ok(!/[\u0000-\u001f\u007f]/.test(artifact.source), `${artifact.name}: no control byte may reach stdin or an argv token`);
		assert.ok(!artifact.source.includes("console."), `${artifact.name}: stdout carries protocol frames only`);
		assert.ok(!/\b(?:eval|Function)\s*\(/.test(artifact.source), `${artifact.name} must not evaluate assembled code`);
		assert.ok(!artifact.source.includes("require("), `${artifact.name} needs nothing but process and its stdio`);
		// A review bound on one readable artifact, not a startup constraint: the entry is started from the deploy
		// bundle, where no command line carries it at all. Keeping every file this small is what makes each one
		// auditable as a single line, and the review surface of a change the file that changed.
		assert.ok(artifact.source.length > 1024 && artifact.source.length < 96 * 1024, `${artifact.name}: unexpected size ${artifact.source.length}`);
		assert.deepEqual(
			Array.from(artifact.source.matchAll(/getBuiltinModule\("([^"]+)"\)/g), (match) => match[1]),
			pins.builtins,
			`${artifact.name} may load exactly the builtins its batch needs`,
		);
		// The only modules a bundle file may import are its reviewed siblings: never a package, never an absolute path.
		const imports = Array.from(artifact.source.matchAll(/\bfrom"\.\/([A-Za-z0-9._-]+)"/g), (match) => match[1]);
		assert.deepEqual(imports, pins.imports, `${artifact.name} may import exactly ${pins.imports.join(", ") || "nothing"}`);
		for (const target of imports) assert.ok(expected.has(target), `${artifact.name} imports ${target}, which is not part of the reviewed bundle`);
	}
	// Every advertised capability must have exactly one dispatch arm, so a capability can never be advertised
	// without an implementation, or implemented twice.
	for (const capability of REMOTE_HELPER_CAPABILITIES) {
		const mentions = REMOTE_HELPER_INLINE_SOURCE.split(`"${capability}"`).length - 1;
		assert.ok(mentions >= 2, `${capability} must appear in CAPABILITIES and in the dispatch`);
	}
	// The terminal launch-ticket capability likewise has exactly one declaration and one dispatch arm.
	assert.equal(REMOTE_HELPER_INLINE_SOURCE.split('"terminal.prepare"').length - 1, 2, "terminal.prepare appears exactly once in CAPABILITIES and once in the dispatch");
	// G5c: the init capability has no other literal occurrence, so "one declaration + one dispatch arm" is exact.
	assert.equal(REMOTE_HELPER_INLINE_SOURCE.split('"git.init"').length - 1, 2, "git.init appears exactly once in CAPABILITIES and once in the dispatch");
	// G5d: discovery is advertised and dispatched exactly once, and the entry validates the optional repo scope itself.
	assert.equal(REMOTE_HELPER_INLINE_SOURCE.split('"git.repos"').length - 1, 2, "git.repos appears exactly once in CAPABILITIES and once in the dispatch");
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes("function readRepoValue("), "the entry must validate the per-request repo scope before forwarding it");
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes("parsed.repo"), "the dispatch must read the scope from the request frame");
	// G5e: the entry and the frozen worker accept the repository scope for exactly the read batch plus every write verb;
	// the contract states the same two lists, and init/discovery stay root-only.
	const repoMethods = /const REPO_METHODS = new Set\(\[([^\]]*)\]\);/.exec(REMOTE_HELPER_INLINE_SOURCE);
	assert.ok(repoMethods, "the entry must enforce the repository-scope acceptance face");
	assert.deepEqual(
		Array.from(repoMethods[1].matchAll(/"([^"]+)"/g), (match) => match[1]),
		[...REMOTE_GIT_REPO_READ_METHODS, ...REMOTE_GIT_REPO_WRITE_METHODS],
		"the entry's accepted scope methods must equal the contract's read + write lists",
	);
	const readRepoSet = /const READ_REPO = new Set\(\[([^\]]*)\]\)/.exec(REMOTE_GIT_READ_SOURCE);
	const writeRepoSet = /const WRITE_REPO = new Set\(\[([^\]]*)\]\)/.exec(REMOTE_GIT_READ_SOURCE);
	assert.ok(readRepoSet && writeRepoSet, "the frozen worker must keep both scope lists");
	assert.deepEqual(
		Array.from(readRepoSet[1].matchAll(/"([^"]+)"/g), (match) => match[1]),
		[...REMOTE_GIT_REPO_READ_METHODS],
		"worker read scope list",
	);
	assert.deepEqual(
		Array.from(writeRepoSet[1].matchAll(/"([^"]+)"/g), (match) => match[1]),
		[...REMOTE_GIT_REPO_WRITE_METHODS],
		"worker write scope list",
	);
	assert.ok(REMOTE_GIT_READ_SOURCE.includes("!READ_REPO.has(method) && !WRITE_REPO.has(method)"), "the frozen prepare must accept exactly the read + write batch");
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes("!REPO_METHODS.has(method)"), "the entry must refuse a scope for any other method before forwarding");
	// A stable code must be registered inside the frozen worker itself, or the helper's own mapping collapses it to IO_ERROR.
	const stableSet = /const stable = new Set\(\[([^\]]*)\]\)/.exec(REMOTE_GIT_READ_SOURCE);
	assert.ok(stableSet, "the frozen Git worker must keep its literal stable-code set");
	assert.ok(stableSet[1].includes('"GIT_REPO_EXISTS"'), "GIT_REPO_EXISTS must be a stable code of the frozen worker");
	assert.ok(REMOTE_HELPER_ERROR_CODES.includes("GIT_REPO_EXISTS"), "GIT_REPO_EXISTS must be in the contract's closed error vocabulary");
	// The multi-file bundle replaced the single-artifact `node -e <source>` shape: the entry imports a sibling it
	// needs to run, so a command line carrying only the entry cannot work at all. That is deliberate - the single
	// artifact had already outgrown the Windows command line budget and had no room left for the next batch - and
	// it is asserted here so the shape cannot come back by accident.
	assert.match(REMOTE_HELPER_INLINE_SOURCE, /from"\.\/git-read\.mjs"/, "the entry is the protocol half of a bundle, not a standalone script");
});

helperTest("the exported entry identity matches the frozen source", () => {
	assert.equal(REMOTE_HELPER_ENTRY_FILE_NAME, "helper.mjs");
	assert.match(REMOTE_HELPER_ENTRY_VERSION, /^\d+\.\d+\.\d+$/);
	assert.equal(REMOTE_HELPER_ENTRY_VERSION, "1.29.0", "fs.uploadPrepare/Commit 从 1.26.0 起提供；1.26.1 修 dispatch 漏发 git.checkIgnore；1.28.0 增加 config.readAuth（远端认证只读派生视图）；1.29.0 远端 config.mjs 的数组深拷贝改用 structuredClone");
	// The frozen source cannot import the contract, so its literals are checked against it here.
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes(`"${REMOTE_HELPER_ENTRY_VERSION}"`), "hello must report REMOTE_HELPER_ENTRY_VERSION");
	for (const token of [REMOTE_HELPER_METHOD_HELLO, REMOTE_HELPER_METHOD_ECHO, REMOTE_HELPER_METHOD_CANCEL, REMOTE_HELPER_METHOD_FS_STAT, REMOTE_HELPER_METHOD_FS_STAT_MANY, REMOTE_HELPER_METHOD_FS_LIST, REMOTE_HELPER_METHOD_FS_READ]) {
		assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes(`"${token}"`), token);
	}
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes(String(REMOTE_HELPER_MAX_FRAME_BYTES)), "the frame cap must be visible in the frozen source");
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes(String(REMOTE_HELPER_MAX_ECHO_DELAY_MS)), "the echo delay ceiling must be visible in the frozen source");
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes(String(REMOTE_HELPER_MAX_CHUNK_BYTES)), "the read chunk ceiling must be visible in the frozen source");
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes(String(REMOTE_HELPER_MAX_LIST_ENTRIES)), "the listing ceiling must be visible in the frozen source");
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes(String(REMOTE_HELPER_MAX_PATH_LENGTH)), "the path ceiling must be visible in the frozen source");
	// The bounded search repeats the same way: the method it answers to, its own refusal code and all four of
	// its ceilings are literals of the body that runs, not values it reads from anywhere.
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes(`"${REMOTE_HELPER_METHOD_FS_SEARCH_NAMES}"`), "the search method must be dispatched in the frozen body");
	for (const ceiling of [REMOTE_HELPER_MAX_SEARCH_MATCHES, REMOTE_HELPER_MAX_SEARCH_SCANNED, REMOTE_HELPER_MAX_SEARCH_DEPTH, REMOTE_HELPER_MAX_SEARCH_QUERY_LENGTH]) assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes(String(ceiling)), `${ceiling} must be visible in the frozen source`);
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes('"QUERY_INVALID"'), "the search refusal code must be a literal of the frozen body");
});

helperTest("network verbs own the long request budget while other Git methods keep the read deadline", () => {
	// G5a follow-up (plan §5.16.2): the client cap and the helper's per-method clamp are both literals of the
	// deployed bytes, and both used to truncate the sync budget to 30s. Keep all three numbers in step.
	assert.ok(REMOTE_HELPER_MAX_REQUEST_TIMEOUT_MS >= REMOTE_GIT_SYNC_TIMEOUT_MS, "the frame ceiling must not truncate the sync budget");
	assert.equal(REMOTE_GIT_READ_TIMEOUT_MS, 30_000);
	assert.equal(REMOTE_GIT_SYNC_TIMEOUT_MS, 600_000);
	assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes("Math.min(value, " + REMOTE_HELPER_MAX_REQUEST_TIMEOUT_MS + ")"), "the frame deadline ceiling must equal the contract value");
	const budget = /const budget = method === "git\.fetch" \|\| method === "git\.push" \|\| method === "git\.pull" \? (\d+) : (\d+);/.exec(REMOTE_HELPER_INLINE_SOURCE);
	assert.ok(budget, "the per-method budget split must be a literal of the frozen body");
	assert.equal(Number(budget[1]), REMOTE_GIT_SYNC_TIMEOUT_MS, "only the network verbs take the sync budget");
	assert.equal(Number(budget[2]), REMOTE_GIT_READ_TIMEOUT_MS, "every other Git method keeps the read deadline");
	// The methods that take it are exactly the three network verbs, never a read.
	for (const method of ["git.fetch", "git.push", "git.pull"]) assert.ok(REMOTE_HELPER_INLINE_SOURCE.includes('"' + method + '"'), method);
});

helperTest("hello answers the contract handshake through the production client", async (t) => {
	// The shifted-argv shape, on purpose: `node <entry> -- --root <root>`, where the helper's own flag is not
	// the argv pair the launcher's template produces and the argv scan has to find it anyway. The literal
	// `node -e <source>` shape it replaces is gone - the body outgrew the Windows command line, which the
	// entry-size test above records - and the file shape the bundle really deploys is covered by every other
	// test in this suite.
	const session = startHelper(t, { argvSeparator: true });
	const result = plain(await guard(session.client.request(REMOTE_HELPER_METHOD_HELLO), "hello"));
	assert.deepEqual(result, {
		protocolVersion: REMOTE_HELPER_PROTOCOL_VERSION,
		platform: process.platform,
		arch: process.arch,
		home: HELPER_HOME,
		// The canonical root it confined itself to: main uses this to prove the --root it asked for is the
		// one that took effect, instead of assuming the path was not a symlink to somewhere else.
		root: session.root,
		capabilities: withoutUploadCapabilities(REMOTE_HELPER_CAPABILITIES),
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

helperTest("a repository scope is validated by the entry and accepted for reads and writes", async (t) => {
	const session = startHelper(t);
	// The entry owns the first shape check: nothing malformed is forwarded to the worker at all.
	for (const repo of ["../escape", "/absolute", "a\\b", "C:/drive", "dir/.git", "x.lock/y", "-option", "a\u0000b", "a".repeat(REMOTE_HELPER_MAX_PATH_LENGTH + 1)]) {
		const error = await rejection(guard(session.client.request(REMOTE_HELPER_METHOD_GIT_REPOS, {}, { repo }), "invalid repo scope"));
		assert.equal(error.code, "GIT_RESULT_INVALID", JSON.stringify(repo));
	}
	// A well-formed scope reaches the worker, whose own prepare accepts it for a read method: the refusal that follows
	// comes from the worker's own environment (not a repository / no root / not Linux), never from the shape check.
	const forwarded = await rejection(guard(session.client.request("git.status", {}, { repo: "nested" }), "git.status with a scope"));
	assert.notEqual(forwarded.code, "GIT_RESULT_INVALID", "a read method must accept a well-formed scope shape");
	// G5e: every write verb accepts the same well-formed scope. The root here is an empty directory, so a request that
	// got past the entry/prepare acceptance face answers GIT_NOT_REPOSITORY (Linux) or GIT_PLATFORM_UNSUPPORTED instead
	// of the shape refusal the G5d batch produced.
	const revision = "a".repeat(64),
		writeParams = {
			"git.stage": { path: "a.txt", group: "workingTree", expectedRevision: revision },
			"git.unstage": { path: "a.txt", group: "index", expectedRevision: revision },
			"git.commit": { message: "message", expectedRevision: revision },
			"git.createBranch": { name: "feature", expectedHead: null },
			"git.switchBranch": { name: "feature", expectedHead: null },
			"git.discard": { path: "a.txt", group: "workingTree", expectedRevision: revision },
			"git.recoveryRestore": { ref: "refs/pideck/recovery/x", oid: "b".repeat(40), path: "a.txt", expectedRevision: revision },
			"git.recoveryDrop": { ref: "refs/pideck/recovery/x", oid: "b".repeat(40), expectedRevision: revision },
			"git.fetch": { remote: "origin", expectedRevision: revision },
			"git.push": { remote: "origin", branch: "main", expectedRevision: revision },
			"git.pull": { remote: "origin", branch: "main", expectedRevision: revision },
		};
	for (const [method, params] of Object.entries(writeParams)) {
		const error = await rejection(guard(session.client.request(method, params, { repo: "nested" }), method + " with a scope"));
		assert.notEqual(error.code, "GIT_RESULT_INVALID", method + " must accept a well-formed scope");
		assert.equal(error.code, process.platform === "linux" ? "GIT_NOT_REPOSITORY" : "GIT_PLATFORM_UNSUPPORTED", method);
	}
	// Init and discovery stay root-only: a non-empty scope is refused before any Git child.
	for (const method of ["git.init", REMOTE_HELPER_METHOD_GIT_REPOS]) {
		const error = await rejection(guard(session.client.request(method, {}, { repo: "nested" }), method + " with a scope"));
		assert.equal(error.code, "GIT_RESULT_INVALID", method);
	}
	// An absent or empty scope is the project root: on Linux discovery honestly answers an empty list for a plain
	// empty directory, while the frozen worker refuses Git work altogether on the other platforms.
	let empty;
	try {
		empty = plain(await guard(session.client.request(REMOTE_HELPER_METHOD_GIT_REPOS, {}), "empty scope repos"));
	} catch (error) {
		empty = { code: error.code };
	}
	if (process.platform === "linux") assert.deepEqual(empty, { repos: [], truncated: false });
	else assert.equal(empty.code, "GIT_PLATFORM_UNSUPPORTED");
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
	// A host-only helper claims no root: main must be able to tell "no root was asked for" apart from
	// "a root was asked for and resolved somewhere else".
	assert.equal(hello.root, null);
	// The capabilities are reported as this build really has them: fs.* is still a capability, it is only the
	// paths that are unreachable, so a client must never read the host-only mode as a downgraded build.
	assert.deepEqual(hello.capabilities, withoutUploadCapabilities(REMOTE_HELPER_CAPABILITIES), "a host-only helper advertises no filesystem write capability");
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

linkHelperTest("a root that is itself a link is canonicalized once at startup", async (t) => {
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

linkHelperTest("fs.stat classifies entries with lstat semantics", async (t) => {
	const fixture = createFsFixture(t);
	// The root is passed through argv, so a scan that missed the flag would leave the whole read-only batch
	// answering PATH_OUTSIDE_ROOT instead of serving the tree.
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

linkHelperTest("fs.stat classifies the entry itself and refuses a path that walks through a link", async (t) => {
	const fixture = createFsFixture(t);
	const session = startHelper(t, { root: fixture.root });
	// The three kinds the contract declares, unchanged by the walk: a regular file, a real directory (the
	// root included, which a client names as "." and never as an absolute path) and an entry that is a link.
	assert.equal((await call(session, REMOTE_HELPER_METHOD_FS_STAT, { path: "alpha.txt" })).kind, "file");
	assert.equal((await call(session, REMOTE_HELPER_METHOD_FS_STAT, { path: "empty.txt" })).kind, "file");
	assert.equal((await call(session, REMOTE_HELPER_METHOD_FS_STAT, { path: "sub" })).kind, "directory");
	assert.equal((await call(session, REMOTE_HELPER_METHOD_FS_STAT, { path: "." })).kind, "directory");
	for (const path of ["alpha-link", "inside-link", "gone-link", "rel-link"]) {
		const link = await call(session, REMOTE_HELPER_METHOD_FS_STAT, { path });
		assert.equal(link.kind, "other", `${path} is the entry itself, never its target`);
		// inside-link points at a directory, so reporting the target's kind is the exact regression here.
		assert.notEqual(link.kind, "directory", `${path} must not be described by what it points at`);
	}
	// What the walk refuses is the *request path*: the leaf named through a link is never classified, so stat
	// can no longer promise a `file` that read refuses for the very same path.
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_STAT, { path: "inside-link/beta.txt" }, "NOT_A_FILE");
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_READ, { path: "inside-link/beta.txt", offset: 0, bytes: 8 }, "NOT_A_FILE");
	// A component that exists but is not a directory is still its own errno, not a link verdict.
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_STAT, { path: "alpha.txt/child" }, THROUGH_A_FILE);
	assert.equal(session.stderr(), "");
});

linkHelperTest("fs.list answers name-sorted entries and never follows a link", async (t) => {
	const fixture = createFsFixture(t);
	const session = startHelper(t, { root: fixture.root });
	const listing = plain(await call(session, REMOTE_HELPER_METHOD_FS_LIST, { path: "." }));
	assert.deepEqual(Object.keys(listing), contractFields("RemoteHelperListResult"));
	assert.deepEqual(
		listing.entries.map((entry) => entry.name),
		["alpha-link", "alpha.txt", "empty.txt", "escape", "gone-link", "inside-link", "outside-file", "outside-gone", "rel-link", "sub"],
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

linkHelperTest("fs.list refuses a request path that walks through a link and still classifies link entries as other", async (t) => {
	const fixture = createFsFixture(t);
	// A real directory that is only reachable by walking through the fixture's inside-link, so the refusal
	// below cannot be confused with a path that simply does not exist.
	mkdirSync(join(fixture.root, "sub", "deep"));
	const session = startHelper(t, { root: fixture.root });
	// The directory path itself is walked the way stat walks an entry: a link above it refuses the whole
	// path, and the other two methods answer that same code for the same path - one verdict, three methods.
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_LIST, { path: "inside-link/deep" }, "NOT_A_FILE");
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_STAT, { path: "inside-link/deep" }, "NOT_A_FILE");
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_READ, { path: "inside-link/deep", offset: 0, bytes: 8 }, "NOT_A_FILE");
	// The resolved path is still served when the caller names it explicitly - that is the only way to it.
	assert.deepEqual((await call(session, REMOTE_HELPER_METHOD_FS_LIST, { path: "sub/deep" })).entries, []);
	// A link named directly is not a directory, and the entries of a real listing still classify every link
	// as itself: the walk changed which request paths are refused, never how an entry is classified.
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_LIST, { path: "inside-link" }, "NOT_A_DIRECTORY");
	const entries = (await call(session, REMOTE_HELPER_METHOD_FS_LIST, { path: "." })).entries;
	assert.deepEqual(
		entries.filter((entry) => entry.kind === "other").map((entry) => entry.name),
		["alpha-link", "escape", "gone-link", "inside-link", "outside-file", "outside-gone", "rel-link"],
		"a listing still describes every link entry as other",
	);
	assert.deepEqual(
		entries.find((entry) => entry.name === "inside-link"),
		{ name: "inside-link", kind: "other" },
	);
	assert.equal(session.stderr(), "");
});

linkHelperTest("fs.read returns one bounded chunk and reports EOF honestly", async (t) => {
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
	// A path that only resolves by walking through a link is refused like the link itself: no method of the
	// batch follows one, so this is NOT_A_FILE even though the leaf it names is a regular file. stat used to
	// answer `file` here from a single lstat of the whole path - lstat skips only the last component - so a
	// client could be told by one method that an entry is a readable file while the other refused it. Both
	// methods now walk the request path, and the two codes are pinned to be the same one.
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_READ, { path: "inside-link/beta.txt", offset: 0, bytes: 64 }, "NOT_A_FILE");
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_STAT, { path: "inside-link/beta.txt" }, "NOT_A_FILE");
	// A link to a file inside the root is the entry-shaped case of the same rule: the bytes behind it are
	// never returned, and stat of that very entry says `other` rather than `file`.
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_READ, { path: "alpha-link", offset: 0, bytes: 64 }, "NOT_A_FILE");
	assert.equal((await call(session, REMOTE_HELPER_METHOD_FS_STAT, { path: "alpha-link" })).kind, "other");
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

linkHelperTest(
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

linkHelperTest("every path that could leave the root is refused without reading the target", async (t) => {
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

linkHelperTest(
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

linkHelperTest("a file that changes while it is being read still settles", async (t) => {
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

linkHelperTest("a link whose target is gone is a link for stat and a link for read, never a missing file", async (t) => {
	const fixture = createFsFixture(t);
	const session = startHelper(t, { root: fixture.root });
	// The fixture's inside-link points at root/sub. Removing that directory is what a checkout or a cleanup
	// does to a linked workspace entry: the link itself stays, and no privilege is needed to make it dangle.
	rmSync(join(fixture.root, "sub"), { recursive: true, force: true });
	const dangling = await call(session, REMOTE_HELPER_METHOD_FS_STAT, { path: "inside-link" });
	assert.equal(dangling.kind, "other", "the link is still an entry, so stat answers about the link itself");
	// A dangling link is still a link, so read refuses it as NOT_A_FILE rather than reporting the target it
	// does not have: the verdict is about the entry, and it does not depend on whether the target exists.
	// That holds for the link itself and for a path that would only resolve by walking through it.
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_READ, { path: "inside-link", offset: 0, bytes: 8 }, "NOT_A_FILE");
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_READ, { path: "inside-link/beta.txt", offset: 0, bytes: 8 }, "NOT_A_FILE");
	// The fixture's gone-link never had a target at all, and the verdict is the same one.
	assert.equal((await call(session, REMOTE_HELPER_METHOD_FS_STAT, { path: "gone-link" })).kind, "other");
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_READ, { path: "gone-link", offset: 0, bytes: 8 }, "NOT_A_FILE");
	// A link is not a listing either, whether or not its target is gone.
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_LIST, { path: "inside-link" }, "NOT_A_DIRECTORY");
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_LIST, { path: "gone-link" }, "NOT_A_DIRECTORY");
	// The rest of the tree is untouched, so a lost target is a refusal about one path, not a broken session.
	assert.equal(Buffer.from((await call(session, REMOTE_HELPER_METHOD_FS_READ, { path: "alpha.txt", offset: 0, bytes: 5 })).chunk, "base64").toString("utf8"), "alpha");
	assert.equal(session.stderr(), "");
});

linkHelperTest("fs.read refuses every link instead of resolving it", async (t) => {
	const fixture = createFsFixture(t);
	const session = startHelper(t, { root: fixture.root });
	/**
	 * Every link shape the fixture carries, with the code read has to answer. A link the containment check
	 * resolves inside the root — a file target, a relative target, a directory target, a target that never
	 * existed, and one whose target string points out of the root without existing either — is refused by
	 * read itself as NOT_A_FILE, because read never resolves a link: nothing is opened, so no target can
	 * contribute a byte or a size. The one case answered earlier is a link whose target exists outside the
	 * root: the containment check every fs.* method runs first refuses it as PATH_OUTSIDE_ROOT — the same
	 * code stat and list answer, and one code for every outside target whatever it is — so read never even
	 * reaches the link.
	 */
	const cases = [
		["alpha-link", "NOT_A_FILE"],
		["rel-link", "NOT_A_FILE"],
		["inside-link", "NOT_A_FILE"],
		["gone-link", "NOT_A_FILE"],
		["outside-gone", "NOT_A_FILE"],
		["escape", "PATH_OUTSIDE_ROOT"],
		["outside-file", "PATH_OUTSIDE_ROOT"],
		// The shape one lstat of the whole path would have missed: only the last component is skipped by
		// lstat, so a link in the middle of the path is exactly what read has to walk past to refuse it.
		["inside-link/beta.txt", "NOT_A_FILE"],
	];
	for (const [path, code] of cases) {
		await expectRefusal(session, REMOTE_HELPER_METHOD_FS_READ, { path, offset: 0, bytes: 64 }, code);
	}
	// No request in this test has been answered with bytes, and the decoy exists only outside the root:
	// anything read through a link would have to show up here. Every stat and list call comes after this
	// point, so the transcript asserted about is exactly the refusals above.
	assert.equal(session.frames.length, cases.length);
	assert.ok(
		session.frames.every((frame) => frame.ok === false),
		"a link must never be answered with a result",
	);
	assert.ok(
		session.lines.every((line) => !line.includes(DECOY)),
		"the decoy was read or echoed",
	);
	assert.ok(
		session.lines.every((line) => !line.includes(Buffer.from(DECOY, "utf8").toString("base64"))),
		"the decoy must not travel base64 encoded either",
	);
	// The other two methods agree about the very same entries: every link is `other` for stat, and the
	// listing of the root classifies each one of them as `other` too — so a client that classifies an entry
	// and then reads it is answered consistently by all three methods.
	for (const path of ["alpha-link", "rel-link", "inside-link", "gone-link", "outside-gone"]) {
		assert.equal((await call(session, REMOTE_HELPER_METHOD_FS_STAT, { path })).kind, "other", `${path} is the link itself`);
	}
	assert.deepEqual(
		(await call(session, REMOTE_HELPER_METHOD_FS_LIST, { path: "." })).entries.filter((entry) => entry.kind === "other").map((entry) => entry.name),
		["alpha-link", "escape", "gone-link", "inside-link", "outside-file", "outside-gone", "rel-link"],
		"a listing describes every link as other as well",
	);
	assert.equal(session.stderr(), "");
});

linkHelperTest("the read-only methods run inline and never take an echo slot", async (t) => {
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
	// The whole bundle, not just the entry: the uploaded artifact imports its siblings by relative path.
	const entryPath = materializeRemoteHelperArtifacts(directory).entryPath;
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
	assert.deepEqual(result.capabilities, withoutUploadCapabilities(REMOTE_HELPER_CAPABILITIES), "the uploaded flat fixture has no deploy spool");
	assert.deepEqual(plain(await guard(session.client.request(REMOTE_HELPER_METHOD_ECHO, { text: "file" }), "echo from the uploaded entry")), { text: "file", delayMs: 0 });
	// The ES module artifact loads its two builtins and confines itself to the same root.
	assert.deepEqual(await call(session, REMOTE_HELPER_METHOD_FS_LIST, { path: "." }), { entries: [{ name: "entry.txt", kind: "file", bytes: "uploaded".length }] });
	assert.equal(Buffer.from((await call(session, REMOTE_HELPER_METHOD_FS_READ, { path: "entry.txt", offset: 0, bytes: 8 })).chunk, "base64").toString("utf8"), "uploaded");
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_READ, { path: "../entry.txt", offset: 0, bytes: 8 }, "PATH_OUTSIDE_ROOT");
	session.endStdin();
	assert.equal(await session.waitForExit(4000), 0);
});

helperTest("hello reports the canonical root, resolving a symlinked root to its target", async (t) => {
	// 这是主进程唯一能证明「我要求的 root 就是实际生效的 root」的方式：helper 启动时 realpath 一次，
	// 一个本身是符号链接的 root 会把 confinement 边界指到别处，而用户确认的是那条路径。
	const realRoot = createRootFixture(t);
	const linkParent = mkdtempSync(join(tmpdir(), "pideck-helper-link-"));
	t.after(() => rmSync(linkParent, { recursive: true, force: true }));
	const linkedRoot = join(linkParent, "root-link");
	symlinkSync(realRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");

	const session = startHelper(t, { root: linkedRoot });
	const result = plain(await guard(session.client.request(REMOTE_HELPER_METHOD_HELLO), "hello"));
	// 传入的是链接，回报的必须是解析后的真实目录 —— 这样 main 才能把它和自己确认过的路径比对。
	assert.notEqual(result.root, linkedRoot, "a symlinked root must not be reported as itself");
	assert.equal(result.root, realRoot, "the reported root is the resolved directory");
	assert.equal(session.root, linkedRoot, "the fixture still records what it actually passed");
});

/*
 * F4: `fs.statMany` is the batched form of `fs.stat` (docs/archive/remote/remote-functional-optimization-plan.md §3 F4).
 * Per-path rules are the single call's own rules; the batch adds nothing but framing.
 */

linkHelperTest("fs.statMany describes a bounded path list in request order", async (t) => {
	const fixture = createFsFixture(t);
	const session = startHelper(t, { root: fixture.root });
	const paths = ["alpha.txt", "sub", "inside-link", "empty.txt", "."];
	const batch = await call(session, REMOTE_HELPER_METHOD_FS_STAT_MANY, { paths });
	assert.deepEqual(Object.keys(batch), contractFields("RemoteHelperStatManyResult"));
	assert.deepEqual(
		batch.entries.map((entry) => entry.path),
		paths,
		"the answer is in request order and echoes every requested path",
	);
	const singles = [];
	for (const path of paths) singles.push(await call(session, REMOTE_HELPER_METHOD_FS_STAT, { path }));
	for (const [index, entry] of batch.entries.entries()) {
		assert.deepEqual(Object.keys(entry).sort(), ["bytes", "kind", "mtimeMs", "path"]);
		// Entry for entry identical to the single call: same classification, same bytes, same mtime.
		assert.deepEqual({ kind: entry.kind, bytes: entry.bytes, mtimeMs: entry.mtimeMs }, singles[index]);
	}
	assert.equal(batch.entries[2].kind, "other", "a link stays the link itself, exactly as fs.stat reports it");
	assert.equal(session.stderr(), "");
});

helperTest("fs.statMany refuses the whole batch when any single path is unusable", async (t) => {
	const fixture = createFsFixture(t);
	const session = startHelper(t, { root: fixture.root });
	// All-or-nothing: a partial list would look complete while one entry silently went undescribed.
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_STAT_MANY, { paths: ["alpha.txt", "sub/missing.txt"] }, "PATH_NOT_FOUND");
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_STAT_MANY, { paths: ["../outside/secret.txt"] }, "PATH_OUTSIDE_ROOT");
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_STAT_MANY, { paths: ["alpha.txt", "escape"] }, "PATH_OUTSIDE_ROOT");
	await expectRefusal(session, REMOTE_HELPER_METHOD_FS_STAT_MANY, { paths: ["alpha.txt/child"] }, THROUGH_A_FILE);
	// The list itself is part of the protocol shape.
	for (const params of [undefined, {}, { paths: [] }, { paths: "alpha.txt" }, { paths: [7] }, { paths: [null] }, { paths: ["a\u0000b"] }, { paths: ["a".repeat(REMOTE_HELPER_MAX_PATH_LENGTH + 1)] }, { paths: Array.from({ length: REMOTE_HELPER_MAX_STAT_MANY_PATHS + 1 }, () => "alpha.txt") }]) {
		await expectRefusal(session, REMOTE_HELPER_METHOD_FS_STAT_MANY, params, "PROTOCOL_INVALID");
	}
	// One path past the cap is the boundary: exactly the ceiling still answers.
	const atCap = await call(session, REMOTE_HELPER_METHOD_FS_STAT_MANY, { paths: Array.from({ length: REMOTE_HELPER_MAX_STAT_MANY_PATHS }, () => "alpha.txt") });
	assert.equal(atCap.entries.length, REMOTE_HELPER_MAX_STAT_MANY_PATHS);
	assert.equal(session.stderr(), "");
});

/**
 * W6-b：`fs.watch` 的推送路径。真实 helper 进程 + 生产客户端，断言「订阅 → 写文件 → 一个无 id 事件帧」，
 * 以及事件帧永远不会被当成某个请求的应答（它没有 id）。
 */
helperTest("fs.watch pushes one debounced event frame and never settles a request", async (t) => {
	// 只在 Linux 上跑真实 watcher：Windows 的 libuv fs-event 在临时目录里会触发断言（uv 的已知问题，
	// 与协议无关），那时这条用例失败的原因会是运行环境而不是实现。Linux 侧的等价验证在 serve 上做过。
	if (process.platform !== "linux") {
		t.skip("real fs.watch events are only exercised on Linux");
		return;
	}
	const helper = startHelper(t, { argvSeparator: true });
	await guard(helper.client.request(REMOTE_HELPER_METHOD_HELLO), "hello");

	const watched = await helper.client.request("fs.watch", { paths: ["", "."] });
	assert.equal(typeof watched.watchId, "string");
	assert.equal(watched.paths, 2);

	writeFileSync(join(helper.root, "created.txt"), "x");
	const event = await helper.waitForEvent((item) => item.watchId === watched.watchId);
	assert.equal(event.watchId, watched.watchId);
	assert.ok(event.paths.length >= 1, "事件必须带回请求时的路径标签");
	for (const path of event.paths) assert.ok(path === "" || path === ".", `unexpected label ${path}`);

	// 幂等关闭：第一次 closed:true，第二次 closed:false（不是错误）。
	assert.deepEqual(plain(await helper.client.request("fs.unwatch", { watchId: watched.watchId })), { closed: true });
	assert.deepEqual(plain(await helper.client.request("fs.unwatch", { watchId: watched.watchId })), { closed: false });
});

function uploadSha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function createUploadBundle(t) {
	const deployRoot = mkdtempSync(join(tmpdir(), "pideck-helper-upload-"));
	const bundleDirectory = join(deployRoot, "bundles", "a".repeat(64));
	const root = join(deployRoot, "project");
	mkdirSync(bundleDirectory, { recursive: true });
	mkdirSync(root);
	t.after(() => rmSync(deployRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
	return { deployRoot, entryPath: materializeRemoteHelperArtifacts(bundleDirectory).entryPath, root };
}

function writeUploadStage(deployRoot, uploadId, bytes) {
	const spool = join(deployRoot, "upload-spool");
	mkdirSync(spool, { recursive: true, mode: 0o700 });
	const target = join(spool, `${uploadId}.part`);
	writeFileSync(target, bytes, { mode: 0o600 });
	return target;
}

helperTest("fs.uploadPrepare and fs.uploadCommit stay narrow on a helper without a deploy root", async (t) => {
	const session = startHelper(t);
	const bytes = Buffer.from("upload");
	await expectRefusal(session, "fs.uploadPrepare", { uploadId: "1".repeat(32), path: "a.txt", policy: "create", size: bytes.length, sha256: uploadSha256(bytes) }, "FILE_UPLOAD_UNSUPPORTED");
	await expectRefusal(session, "fs.uploadCommit", { uploadId: "1".repeat(32), token: "2".repeat(32) }, "FILE_UPLOAD_TOKEN_INVALID");
	await expectRefusal(session, "fs.uploadAbort", { uploadId: "1".repeat(32), token: "2".repeat(32) }, "FILE_UPLOAD_TOKEN_INVALID");
	for (const params of [
		undefined,
		{},
		{ uploadId: "A".repeat(32), path: "a.txt", policy: "create", size: 1, sha256: uploadSha256(Buffer.from("x")) },
		{ uploadId: "1".repeat(32), path: "", policy: "create", size: 1, sha256: uploadSha256(Buffer.from("x")) },
		{ uploadId: "1".repeat(32), path: "a.txt", policy: "replace", size: 1, sha256: uploadSha256(Buffer.from("x")) },
		{ uploadId: "1".repeat(32), path: "a.txt", policy: "create", size: -1, sha256: uploadSha256(Buffer.from("x")) },
		{ uploadId: "1".repeat(32), path: "a.txt", policy: "create", size: 1, sha256: "0".repeat(63) },
	]) {
		await expectRefusal(session, "fs.uploadPrepare", params, "FILE_UPLOAD_INPUT_INVALID");
	}
	await expectRefusal(session, "fs.uploadCommit", { uploadId: "1".repeat(32) }, "FILE_UPLOAD_INPUT_INVALID");
	await expectRefusal(session, "fs.uploadCommit", { uploadId: "1".repeat(32), token: "A".repeat(32) }, "FILE_UPLOAD_INPUT_INVALID");
});

helperTest("fs.uploadCommit publishes a create-only file once and consumes the token", async (t) => {
	if (process.platform !== "linux") {
		t.skip("the upload commit requires Linux procfs and O_NOFOLLOW");
		return;
	}
	const fixture = createUploadBundle(t);
	const session = startHelper(t, { root: fixture.root, entryPath: fixture.entryPath });
	const hello = await call(session, REMOTE_HELPER_METHOD_HELLO);
	assert.ok(hello.capabilities.includes("fs.uploadPrepare"));
	assert.ok(hello.capabilities.includes("fs.uploadCommit"));
	assert.ok(hello.capabilities.includes("fs.uploadAbort"));
	const abortId = "0".repeat(32);
	const abortTicket = await call(session, "fs.uploadPrepare", { uploadId: abortId, path: "never.bin", policy: "create", size: 1, sha256: uploadSha256(Buffer.from("x")) });
	const abortStage = writeUploadStage(fixture.deployRoot, abortId, Buffer.from("x"));
	assert.deepEqual(await call(session, "fs.uploadAbort", { uploadId: abortId, token: abortTicket.token }), { cleaned: true });
	assert.equal(existsSync(abortStage), false);
	assert.equal(existsSync(join(fixture.root, "never.bin")), false);
	await expectRefusal(session, "fs.uploadAbort", { uploadId: abortId, token: abortTicket.token }, "FILE_UPLOAD_TOKEN_INVALID");
	const bytes = Buffer.from("streamed upload\n", "utf8");
	const uploadId = "1".repeat(32);
	const prepared = await call(session, "fs.uploadPrepare", {
		uploadId,
		path: "new.bin",
		policy: "create",
		size: bytes.length,
		sha256: uploadSha256(bytes),
	});
	assert.deepEqual(Object.keys(prepared).sort(), ["expiresAt", "stageRef", "token"]);
	assert.match(prepared.token, /^[0-9a-f]{32}$/);
	assert.equal(prepared.stageRef, uploadId);
	assert.ok(prepared.expiresAt > Date.now());
	const stage = writeUploadStage(fixture.deployRoot, uploadId, bytes);

	const committed = await call(session, "fs.uploadCommit", { uploadId, token: prepared.token });
	assert.deepEqual(Object.keys(committed).sort(), ["committed", "fsync", "path", "revision", "sha256", "size", "stageCleaned"]);
	assert.equal(committed.committed, true);
	assert.equal(committed.path, "new.bin");
	assert.equal(committed.size, bytes.length);
	assert.equal(committed.sha256, uploadSha256(bytes));
	assert.equal(committed.fsync, true);
	assert.equal(committed.stageCleaned, true);
	assert.equal(readFileSync(join(fixture.root, "new.bin"), "utf8"), bytes.toString("utf8"));
	assert.equal(statSync(join(fixture.root, "new.bin")).mode & 0o777, 0o600);
	assert.equal(existsSync(stage), false, "the spool file is removed after commit");
	assert.equal(existsSync(join(fixture.root, `.${uploadId}.pideck-put`)), false, "the staging name is removed after publish");

	// The result may be lost after commit, but a replay is always a deterministic refusal.
	await expectRefusal(session, "fs.uploadCommit", { uploadId, token: prepared.token }, "FILE_UPLOAD_TOKEN_INVALID");
	assert.equal(readFileSync(join(fixture.root, "new.bin"), "utf8"), bytes.toString("utf8"));
});

helperTest("fs.uploadCommit never clobbers and rejects mismatched or linked stages", async (t) => {
	if (process.platform !== "linux") {
		t.skip("the upload commit requires Linux procfs and O_NOFOLLOW");
		return;
	}
	const fixture = createUploadBundle(t);
	const session = startHelper(t, { root: fixture.root, entryPath: fixture.entryPath });
	const bytes = Buffer.from("replacement");
	const existing = "keep me";
	const firstId = "2".repeat(32);
	const first = await call(session, "fs.uploadPrepare", { uploadId: firstId, path: "existing.txt", policy: "create", size: bytes.length, sha256: uploadSha256(bytes) });
	writeFileSync(join(fixture.root, "existing.txt"), existing);
	const firstStage = writeUploadStage(fixture.deployRoot, firstId, bytes);
	await expectRefusal(session, "fs.uploadCommit", { uploadId: firstId, token: first.token }, "FILE_UPLOAD_TARGET_EXISTS");
	assert.equal(readFileSync(join(fixture.root, "existing.txt"), "utf8"), existing);
	assert.equal(existsSync(firstStage), false, "a refused create-only commit still cleans its spool");

	const secondId = "3".repeat(32);
	const second = await call(session, "fs.uploadPrepare", { uploadId: secondId, path: "mismatch.txt", policy: "create", size: bytes.length, sha256: uploadSha256(Buffer.from("different")) });
	const secondStage = writeUploadStage(fixture.deployRoot, secondId, bytes);
	await expectRefusal(session, "fs.uploadCommit", { uploadId: secondId, token: second.token }, "FILE_UPLOAD_STAGE_INVALID");
	assert.equal(existsSync(join(fixture.root, "mismatch.txt")), false);
	assert.equal(existsSync(secondStage), false);

	const outside = join(fixture.deployRoot, "outside.txt");
	writeFileSync(outside, bytes);
	const thirdId = "4".repeat(32);
	const third = await call(session, "fs.uploadPrepare", { uploadId: thirdId, path: "linked.txt", policy: "create", size: bytes.length, sha256: uploadSha256(bytes) });
	const thirdStage = writeUploadStage(fixture.deployRoot, thirdId, Buffer.from("placeholder"));
	rmSync(thirdStage);
	symlinkSync(outside, thirdStage);
	await expectRefusal(session, "fs.uploadCommit", { uploadId: thirdId, token: third.token }, "FILE_UPLOAD_STAGE_INVALID");
	assert.equal(readFileSync(outside, "utf8"), bytes.toString("utf8"));
	assert.equal(existsSync(join(fixture.root, "linked.txt")), false);

	const escape = join(fixture.root, "escape");
	symlinkSync(fixture.deployRoot, escape, "dir");
	await expectRefusal(
		session,
		"fs.uploadPrepare",
		{
			uploadId: "5".repeat(32),
			path: "escape/pwn.txt",
			policy: "create",
			size: bytes.length,
			sha256: uploadSha256(bytes),
		},
		"FILE_UPLOAD_PATH_INVALID",
	);
	assert.equal(existsSync(join(fixture.deployRoot, "pwn.txt")), false);
});

test("every declared capability is actually dispatched by the helper method table", () => {
	// 回归（2026-11-07）：CAPABILITIES 里声明了 git.checkIgnore，但 dispatch 的分发表漏了它，
	// 于是 helper 对已声明的方法回 METHOD_NOT_FOUND——能力声明与分发表必须同一个集合。
	// 2026-11-07 加固：按函数体括号配对整段取 dispatch，不再用固定字符窗口（窗口一超就假绿/假红）；
	// 覆盖全部能力（fs.* / config.* / terminal.*），不只 git.*。
	const source = REMOTE_HELPER_INLINE_SOURCE;
	const capabilities = JSON.parse(/const CAPABILITIES = (\[[^\]]*\]);/.exec(source)[1]);
	const start = source.indexOf("function dispatch(frame, parsed)");
	assert.ok(start > 0, "the helper method table must be findable");
	let depth = 0;
	let end = -1;
	for (let index = source.indexOf("{", start); index >= 0 && index < source.length; index += 1) {
		if (source[index] === "{") depth += 1;
		else if (source[index] === "}") {
			depth -= 1;
			if (depth === 0) {
				end = index + 1;
				break;
			}
		}
	}
	assert.ok(end > start, "the dispatch body must be brace-balanced");
	const body = source.slice(start, end);
	assert.ok(body.includes('refuse(identity, "METHOD_NOT_FOUND")'), "the capture must reach the fallthrough, not a truncated prefix");
	const dispatched = new Set(Array.from(body.matchAll(/frame\.method === "([A-Za-z.]+)"/g), (match) => match[1]));
	const missing = capabilities.filter((capability) => !dispatched.has(capability));
	assert.deepEqual(missing, [], "every declared capability must reach a handler (otherwise METHOD_NOT_FOUND)");
});
