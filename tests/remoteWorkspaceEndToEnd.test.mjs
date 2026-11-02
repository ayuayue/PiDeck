import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { fileSymlinkSkipReason } from "./helpers/symlinkSupport.mjs";

/*
 * End-to-end seam proof for the remote read-only workspace chain (plan §7.1 / §168, phase 3).
 *
 * The suites next door each hold one layer still with a stub: `remoteWorkspaceReader.test.mjs` drives the
 * reader against hand-made answers, `remoteHelperEntry.test.mjs` drives the frozen helper with raw frames,
 * and `remoteBootstrapUpload.test.mjs` checks the private snapshot against its own manifest. None of them can show that
 * the *chain* is wired, and that is the only thing this file asserts:
 *
 *   hello handshake -> private upload snapshot -> finalize frames -> real child process -> fs.stat/fs.list/fs.read
 *   (and fs.searchNames, exercised straight through the port) -> RemoteWorkspaceReader
 *
 * Every layer is the production one: the frozen helper body (REMOTE_HELPER_INLINE_SOURCE, build 1.6.0)
 * runs as a real child process with a real `--root`, stdout is fed line by line into the real
 * RemoteControlClient, and the real RemoteWorkspaceReader speaks through a port that is nothing but that
 * client. No stub answers a frame anywhere.
 *
 * Expected values are never taken from the code under test: bytes, sizes, mtimes, sha256 digests, the
 * directory listing and the bundle content address are read or computed straight from the disk in this
 * process, frame *names* come from the contract sources (or are byte-equal to a contract constant), and the
 * finalize frames are additionally matched against the field lists the frozen bootstrap entry itself
 * validates with `exact(frame, [...])`. A misspelled method, op or field therefore fails here instead of
 * quietly turning into METHOD_NOT_FOUND (or a silently ignored manifest) later.
 *
 * Every await is bounded: a helper that stops answering has to fail the test, not stall the runner.
 */

const {
	REMOTE_BOOTSTRAP_FILE_MODES,
	REMOTE_BOOTSTRAP_MAX_FRAME_BYTES,
	REMOTE_BOOTSTRAP_PROTOCOL_VERSION,
	REMOTE_BUNDLE_MANIFEST_SCHEMA_VERSION,
	REMOTE_HELPER_CAPABILITIES,
	REMOTE_HELPER_ERROR_CODES,
	REMOTE_HELPER_MAX_CHUNK_BYTES,
	REMOTE_HELPER_MAX_SEARCH_MATCHES,
	REMOTE_HELPER_MAX_SEARCH_QUERY_LENGTH,
	REMOTE_HELPER_METHOD_CANCEL,
	REMOTE_HELPER_METHOD_FS_LIST,
	REMOTE_HELPER_METHOD_FS_READ,
	REMOTE_HELPER_METHOD_FS_SEARCH_NAMES,
	REMOTE_HELPER_METHOD_FS_STAT,
	REMOTE_HELPER_METHOD_HELLO,
	REMOTE_HELPER_METHOD_FS_UPLOAD_ABORT,
	REMOTE_HELPER_METHOD_FS_UPLOAD_COMMIT,
	REMOTE_HELPER_METHOD_FS_UPLOAD_PREPARE,
	REMOTE_HELPER_PROTOCOL_VERSION,
} = loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");
const { REMOTE_HELPER_ARTIFACTS, REMOTE_HELPER_ENTRY_FILE_NAME, REMOTE_HELPER_ENTRY_VERSION, REMOTE_HELPER_INLINE_SOURCE } = loadTsCommonJs("src/main/remote/RemoteHelperEntry.ts");
const { createRemoteControlClient } = loadTsCommonJs("src/main/remote/RemoteControlClient.ts");
const { createRemoteWorkspaceReader, REMOTE_WORKSPACE_DIAGNOSTIC_CODES } = loadTsCommonJs("src/main/remote/RemoteWorkspaceReader.ts");
const { REMOTE_BUNDLE_HASH_PREFIX, REMOTE_BUNDLE_HASH_SEPARATOR, buildBundleManifest, observeBundleFiles, withPrivateBundleUploadPlan } = loadTsCommonJs("src/main/remote/RemoteBootstrapUpload.ts");
const { buildFinalizeFrames } = loadTsCommonJs("src/main/remote/RemoteBootstrapTransfer.ts");
const { REMOTE_BOOTSTRAP_STAGING_PREFIX } = loadTsCommonJs("src/main/remote/RemoteBootstrapContract.ts");

/** Contract source read back by this suite: frame field names are asserted against the declared types. */
const CONTRACT_SOURCE = "src/main/remote/RemoteHelperContract.ts";
/** Frozen bootstrap entry source: its `exact(frame, [...])` lists are the remote side's own acceptance rule. */
const BOOTSTRAP_CONTRACT_SOURCE = "src/main/remote/RemoteBootstrapContract.ts";
/** Same host id shape the host store mints; the client bounds it by length and control bytes only. */
const HOST_ID = "6f1d2c3b-4a59-4e8d-9f70-1a2b3c4d5e6f";
/** The helper never resolves HOME into a path, so a POSIX literal is the honest fixture on any platform. */
const HELPER_HOME = "/home/pideck-e2e";
/** The contract's own chunk ceiling, spelled once so every expectation below is stated in those units. */
const CHUNK = REMOTE_HELPER_MAX_CHUNK_BYTES;
/** One chunk plus a remainder: a read that only ever sent one frame cannot pass the assertions below. */
const OVERSIZE_BYTES = CHUNK + 4096;
const REQUEST_TIMEOUT_MS = 20_000;
const GUARD_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 60_000;
/** A token that exists only outside the root: no frame, error or diagnostic may ever carry it. */
const DECOY = "pideck-e2e-decoy-4c1f9a";
/** A nonce and deploy root in the exact shapes the bootstrap contract accepts. */
const NONCE = "b0a1c2d3e4f5a607";
const DEPLOY_ROOT = "/home/pideck/.pideck/remote-host";
/** A pinned client context: an SFTP-era OpenSSH, so the remote path travels unquoted. */
const CONNECTION = {
	executable: "/usr/bin/scp",
	destination: "pideck-verified-host",
	args: ["-F", "/home/pideck/.pideck/ssh-config", "-o", "BatchMode=yes"],
	env: { PATH: "/usr/bin" },
	openSshVersion: "OpenSSH_9.6p1 Ubuntu-3ubuntu13",
};

/** Production objects live in another VM realm, so deep comparisons are normalised through JSON. */
const plain = (value) => JSON.parse(JSON.stringify(value));

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Deterministic, non-repeating bytes: the cycle covers 0, 10 and the high range, so no encoding is assumed. */
function patternBytes(length) {
	const bytes = Buffer.alloc(length);
	for (let index = 0; index < length; index += 1) bytes[index] = (index * 37 + 11) % 253;
	return bytes;
}

/** Bound one await: a child that stops answering must fail the test, never stall the runner. */
function guard(promise, label, timeoutMs = GUARD_TIMEOUT_MS) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
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

/** `await` on a rejecting promise: the refusal is returned instead of thrown, so a code can be asserted. */
async function rejection(promise, label) {
	try {
		await guard(promise, label);
	} catch (error) {
		return error;
	}
	throw new Error(`${label} answered a result where a refusal was expected`);
}

/** Bounded polling for an event that arrives on the transport's own schedule (a diagnostic, an exit). */
async function waitFor(predicate, label, timeoutMs = GUARD_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${label}`);
}

/** The `{...}` body of one contract type declaration, read from the source the two sides share. */
function contractTypeDeclaration(typeName) {
	const source = readFileSync(CONTRACT_SOURCE, "utf8");
	const match = new RegExp(`export\\s+type\\s+${typeName}\\s*=\\s*\\{([\\s\\S]*?)\\};`).exec(source);
	assert.ok(match, `RemoteHelperContract does not declare ${typeName}`);
	return match[1];
}

/** Field names of one contract type: the wire shape asserted word for word, never a prefix of it. */
function contractTypeFields(typeName) {
	return Array.from(contractTypeDeclaration(typeName).matchAll(/([A-Za-z][A-Za-z0-9]*)\??\s*:/g)).map((match) => match[1]);
}

/** Literal members of one contract type (`v: 1; op: "finalize-begin"`), as values instead of type names. */
function contractTypeLiterals(typeName) {
	const literals = {};
	for (const match of contractTypeDeclaration(typeName).matchAll(/([A-Za-z][A-Za-z0-9]*)\??\s*:\s*("([^"]*)"|-?\d+)/g)) literals[match[1]] = match[3] === undefined ? Number(match[2]) : match[3];
	return literals;
}

/** The fields a frame must carry: the contract's members minus the optional ones this shape omits. */
function frameFields(all, omitted = []) {
	return all.filter((field) => !omitted.includes(field)).sort();
}

/**
 * The inbound shapes the frozen bootstrap entry accepts, read out of its own source. It validates every
 * frame with `exact(frame, [...])`, so those lists — not this test's opinion — are the acceptance rule of
 * the side the finalize frames are written for. Starting the entry itself needs a writable POSIX deploy
 * root and a HOME it may create; the frames are therefore checked against the rule, which is the seam that
 * actually breaks when a field name drifts.
 */
function readBootstrapEntryAcceptance() {
	const source = readFileSync(BOOTSTRAP_CONTRACT_SOURCE, "utf8");
	const lists = [...source.matchAll(/exact\(frame,\[([^\]]*)\]\)/g)].map((match) => match[1].split(",").map((field) => field.replace(/"/g, "").trim()));
	const begin = lists.find((fields) => fields.includes("bundleSha256"));
	const file = lists.find((fields) => fields.includes("sha256"));
	const minimal = lists.filter((fields) => fields.length === 2);
	assert.ok(begin !== undefined && file !== undefined && minimal.length >= 2, "the frozen bootstrap entry must still validate finalize-begin/finalize-file/finalize-commit with exact(...) field lists");
	for (const fields of minimal) assert.deepEqual(fields, ["v", "op"], "the entry's minimal inbound frames carry exactly v and op");
	return { begin, file };
}

/**
 * The disk truth of one bundle directory, computed here and nowhere else: the digest of the actual bytes,
 * the byte count from an independent lstat, and the mode the deployment policy must declare for it.
 */
function bundleTruth(directory, names, executableNames) {
	const truth = new Map();
	for (const name of names) truth.set(name, { sha256: sha256(readFileSync(join(directory, name))), bytes: lstatSync(join(directory, name)).size, mode: executableNames.includes(name) ? "0700" : "0600" });
	return truth;
}

/**
 * The content address of a declared file set, recomputed here from the wire definition the two sides
 * share (tag, then name/sha256/bytes/mode per file in name order). It is deliberately *not* read back from
 * `bundleContentHash`: a deployment identity that only the producing side can check is not an identity.
 */
function expectedBundleSha256(truth) {
	const digest = createHash("sha256");
	digest.update(`${REMOTE_BUNDLE_HASH_PREFIX}${REMOTE_BUNDLE_HASH_SEPARATOR}`, "utf8");
	for (const name of [...truth.keys()].sort()) {
		const file = truth.get(name);
		digest.update(`${name}${REMOTE_BUNDLE_HASH_SEPARATOR}${file.sha256}${REMOTE_BUNDLE_HASH_SEPARATOR}${file.bytes}${REMOTE_BUNDLE_HASH_SEPARATOR}${file.mode}${REMOTE_BUNDLE_HASH_SEPARATOR}`, "utf8");
	}
	return digest.digest("hex");
}

/**
 * A real workspace around the root: a small tree inside, links of both shapes, and a decoy outside. The
 * decoy is a file the helper must never open, which is what makes "refused" distinguishable from "tried
 * and failed" on the failure path.
 */
function createWorkspaceFixture(t) {
	const base = mkdtempSync(join(tmpdir(), "pideck-e2e-"));
	const root = join(base, "root");
	const outside = join(base, "outside");
	mkdirSync(join(root, "sub"), { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(root, "notes.txt"), "notes content\n");
	writeFileSync(join(root, "sub", "inner.txt"), "inner content\n");
	writeFileSync(join(outside, "secret.txt"), DECOY);
	// Windows needs the link type spelled out (a junction for a directory) and cannot infer it; POSIX
	// infers both from the target.
	symlinkSync(join(root, "notes.txt"), join(root, "notes-link"), process.platform === "win32" ? "file" : undefined);
	symlinkSync(join(root, "sub"), join(root, "sub-link"), process.platform === "win32" ? "junction" : "dir");
	// The child is killed by its own hook (the helper's stdin EOF does the same), and a Windows directory
	// removal can still lose a race against a closing handle, hence the retries.
	t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
	return { root };
}

/**
 * The helper entry every test in this suite starts: the frozen bytes under the file name the deploy bundle
 * uploads them as, written once per run.
 *
 * The deployed helper is a file, and a file costs no command line. `node -e <source>` would have to carry
 * the whole body on one, and Windows rejects a CreateProcess command line past 32767 characters - so this
 * suite would silently become a second place where the size of the frozen body decides whether the chain
 * can be tested at all. `remoteHelperEntry.test.mjs` keeps the `-e` shape covered, and asserts the budget it
 * has to fit, on purpose. The file-scope hook removes the directory after the last child has read it; a test
 * hook could delete it while a child is still starting.
 */
import { materializeRemoteHelperArtifacts } from "./helpers/remoteHelperArtifacts.mjs";

const ENTRY_DIRECTORY = mkdtempSync(join(tmpdir(), "pideck-e2e-entry-"));
const ENTRY_PATH = join(ENTRY_DIRECTORY, REMOTE_HELPER_ENTRY_FILE_NAME);
materializeRemoteHelperArtifacts(ENTRY_DIRECTORY);
after(() => rmSync(ENTRY_DIRECTORY, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

/**
 * One real helper process plus the production client that speaks to it, wired the way the connection layer
 * wires it: the client writes through `send` into the child's stdin and every stdout line is fed back
 * through `handleLine`. The reader is created over the port built here, so the three layers under test are
 * the three real ones and nothing else.
 *
 * The argv is the launcher's fixed template, `<node> <entry> [--root <root>]` - the deployed shape, with the
 * frozen bytes in a real file. The `-e` shape (entry path absent, `--` before the helper's own flag, argv
 * shifted by one) is pinned by remoteHelperEntry.test.mjs; the helper scans argv for `--root` instead of
 * indexing it so that both shapes are served.
 */
function startHelper(t, root) {
	const env = { ...process.env, HOME: HELPER_HOME };
	const child = spawn(process.execPath, [ENTRY_PATH, "--root", root], { env, stdio: ["pipe", "pipe", "pipe"] });
	const frames = [];
	const lines = [];
	const inbound = [];
	const diagnostics = [];
	const readerDiagnostics = [];
	const exitWaiters = new Set();
	let captureRequestId = null;
	let buffered = "";
	let stderr = "";
	let exitCode = null;
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	// A helper that already exited turns the next write into an EPIPE event; without this listener the test
	// process itself would crash instead of reporting the protocol failure under test.
	child.stdin.on("error", () => {});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const client = createRemoteControlClient({
		hostId: HOST_ID,
		send(line) {
			const frame = JSON.parse(line);
			frames.push(frame);
			// The client mints request ids itself and only exposes cancellation *by id*, so the frame being
			// written is the only place the id can be read back; the port hands it to the reader here.
			if (captureRequestId !== null) {
				const notify = captureRequestId;
				captureRequestId = null;
				notify(frame.id);
			}
			child.stdin.write(`${line}\n`);
		},
		onDiagnostic(entry) {
			diagnostics.push(plain(entry));
		},
	});
	client.openConnection();
	child.stdout.on("data", (chunk) => {
		buffered += chunk;
		let index = buffered.indexOf("\n");
		while (index >= 0) {
			const line = buffered.slice(0, index);
			buffered = buffered.slice(index + 1);
			lines.push(line);
			try {
				inbound.push(JSON.parse(line));
			} catch {
				// A stdout line that is not JSON is a finding of its own; the raw line stays in `lines`.
			}
			client.handleLine(line);
			index = buffered.indexOf("\n");
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

	const port = {
		request(hostId, method, params, options) {
			// The reader validates the host id before it calls; a mismatch here would be this harness's bug.
			if (hostId !== client.hostId) return Promise.reject(new Error("REMOTE_WORKSPACE_REQUEST_FAILED"));
			let requestId;
			captureRequestId = (id) => {
				requestId = id;
			};
			const started = client.request(method, params, options?.timeoutMs === undefined ? undefined : { timeoutMs: options.timeoutMs });
			captureRequestId = null;
			if (requestId !== undefined) options?.onRequestId?.(requestId);
			return started;
		},
		async cancel(hostId, requestId) {
			if (hostId !== client.hostId) throw new Error("REMOTE_WORKSPACE_REQUEST_FAILED");
			return client.cancel(requestId);
		},
	};
	const reader = createRemoteWorkspaceReader({
		port,
		onDiagnostic(entry) {
			readerDiagnostics.push(plain(entry));
		},
	});

	/** Resolves with the exit code; a helper that never exits fails instead of hanging. */
	function waitForExit(timeoutMs = GUARD_TIMEOUT_MS) {
		if (exitCode !== null) return Promise.resolve(exitCode);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				exitWaiters.delete(onExit);
				reject(new Error("timed out waiting for the helper to exit"));
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
		client,
		port,
		reader,
		frames,
		lines,
		inbound,
		/** What the *client* refused to use (bad host, stale generation, duplicate id, ...). */
		diagnostics,
		/** What the *reader* refused: closed vocabulary only, one entry per failure. */
		readerDiagnostics,
		ofMethod: (method) => frames.filter((frame) => frame.method === method),
		wireCodes: () => inbound.filter((frame) => frame.ok === false).map((frame) => frame.error.code),
		stderrText: () => stderr,
		endStdin: () => child.stdin.end(),
		waitForExit,
	};
}

/** Every test drives a real child process, so each one carries a hard deadline of its own. */
const seamTest = (name, fn) => test(name, { timeout: TEST_TIMEOUT_MS }, fn);

/** 需要真实「文件符号链接」夹具的用例：平台造不出文件链接时跳过（见 tests/helpers/symlinkSupport.mjs）。 */
const linkSeamTest = (name, fn) => test(name, { timeout: TEST_TIMEOUT_MS, skip: fileSymlinkSkipReason() }, fn);

/** The wire shapes of the request and response frames, read from the contract the two sides share. */
const REQUEST_FIELDS = contractTypeFields("RemoteHelperRequestFrame");
const RESPONSE_FIELDS = contractTypeFields("RemoteHelperResponseFrame");

linkSeamTest("the frozen helper's hello frame is the handshake the connection layer waits for", async (t) => {
	const fixture = createWorkspaceFixture(t);
	const helper = startHelper(t, fixture.root);

	// The handshake goes through the very port the reader uses, so a port that only carries fs.* would fail
	// here — and this is the frame SshConnectionManager's readiness verdict is built on.
	const hello = plain(await guard(helper.port.request(HOST_ID, REMOTE_HELPER_METHOD_HELLO, undefined, {}), "hello"));

	// The manager's own criteria, in its own order: version first, then the four members it insists on.
	assert.equal(hello.protocolVersion, REMOTE_HELPER_PROTOCOL_VERSION, "a different protocol version is the one mismatch a retry cannot fix");
	assert.equal(typeof hello.platform, "string");
	assert.equal(typeof hello.arch, "string");
	assert.equal(typeof hello.home, "string");
	assert.equal(Array.isArray(hello.capabilities), true);
	// This suite runs the flat/dev helper shape, whose argv has no bundle deploy facts. Upload methods are
	// therefore deliberately withheld; every other contract capability must still be advertised verbatim.
	const deployOnlyCapabilities = [REMOTE_HELPER_METHOD_FS_UPLOAD_PREPARE, REMOTE_HELPER_METHOD_FS_UPLOAD_COMMIT, REMOTE_HELPER_METHOD_FS_UPLOAD_ABORT];
	const expectedCapabilities = Array.from(REMOTE_HELPER_CAPABILITIES).filter((capability) => !deployOnlyCapabilities.includes(capability));
	assert.deepEqual(hello.capabilities, expectedCapabilities, "the flat helper advertises the contract capabilities except deploy-only upload methods");
	for (const method of deployOnlyCapabilities) assert.ok(!hello.capabilities.includes(method), `${method} must not be advertised without bundle deploy facts`);
	assert.equal(hello.home, HELPER_HOME, "HOME is reported, never resolved into a path");
	assert.equal(hello.helperVersion, REMOTE_HELPER_ENTRY_VERSION);
	assert.equal(hello.nodeVersion, process.versions.node, "the helper runs on the node this suite started it with");
	assert.equal(Number.isSafeInteger(hello.pid), true);
	// The three filesystem methods the reader needs must be advertised under their contract names.
	for (const method of [REMOTE_HELPER_METHOD_FS_STAT, REMOTE_HELPER_METHOD_FS_LIST, REMOTE_HELPER_METHOD_FS_READ, REMOTE_HELPER_METHOD_FS_SEARCH_NAMES]) assert.ok(hello.capabilities.includes(method), `${method} must be advertised`);
	assert.deepEqual(Object.keys(hello).sort(), ["arch", "capabilities", "helperVersion", "home", "nodeVersion", "pid", "platform", "protocolVersion", "root"]);
	// The root is part of the handshake because the connection layer compares it against the root it asked
	// for: it is the only evidence that the confinement boundary is the directory the caller named.
	assert.equal(hello.root, fixture.root, "the helper reports the canonical root it confined itself to");

	// Outbound: the method is the contract constant exactly, and the frame carries the contract's request
	// fields minus `params`, which a handshake does not send.
	assert.equal(helper.frames.length, 1);
	const request = helper.frames[0];
	assert.equal(request.method, REMOTE_HELPER_METHOD_HELLO);
	assert.equal(request.v, REMOTE_HELPER_PROTOCOL_VERSION);
	assert.equal(request.hostId, HOST_ID);
	assert.equal(request.generation, helper.client.connectionGeneration);
	assert.equal(request.timeoutMs > 0, true);
	// `repo` is optional on the contract and only repository-scoped reads send it; a handshake carries neither
	// `params` nor `repo`, so the required-only shape is the honest assertion here.
	assert.deepEqual(Object.keys(request).sort(), frameFields(REQUEST_FIELDS, ["params", "repo"]));

	// Inbound: one ok frame, the identity echoed unchanged, and exactly the contract's response fields.
	assert.equal(helper.inbound.length, 1);
	const answer = helper.inbound[0];
	assert.equal(answer.ok, true);
	assert.equal(answer.hostId, HOST_ID);
	assert.equal(answer.generation, request.generation);
	assert.equal(answer.id, request.id, "the id is echoed unchanged, which is what makes the pending table work");
	assert.deepEqual(Object.keys(answer).sort(), frameFields(RESPONSE_FIELDS, ["error"]));
	assert.deepEqual(helper.diagnostics, [], "no inbound frame was dropped, misrouted or fenced off");

	// Termination is part of the protocol: stdin EOF exits 0 immediately and stdout stays protocol-only.
	helper.endStdin();
	assert.equal(await guard(helper.waitForExit(), "helper exit after stdin EOF"), 0);
	assert.equal(helper.stderrText(), "", "the helper writes protocol frames only — a log line would corrupt the stream");
});

seamTest("the upload plan's finalize frames match the manifest, the contract and the entry's own acceptance rule", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "pideck-e2e-bundle-"));
	t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
	// Names are deliberately declared out of order and include a dash, so name sorting and the segment rule
	// are both exercised; the first file is the reviewed helper artifact itself.
	const names = [...REMOTE_HELPER_ARTIFACTS.map((artifact) => artifact.name), "run-helper.sh", "aaa.txt"];
	const executableNames = ["helper.mjs"];
	for (const artifact of REMOTE_HELPER_ARTIFACTS) writeFileSync(join(directory, artifact.name), artifact.source);
	writeFileSync(join(directory, "run-helper.sh"), "#!/bin/sh\nexec node ./helper.mjs\n");
	writeFileSync(join(directory, "aaa.txt"), "first file by name\n");
	const truth = bundleTruth(directory, names, executableNames);
	for (const artifact of REMOTE_HELPER_ARTIFACTS) {
		assert.equal(truth.get(artifact.name).sha256, artifact.sha256, `the bundle ships the reviewed ${artifact.name} bytes, not a copy of them`);
		assert.equal(truth.get(artifact.name).bytes, Buffer.byteLength(artifact.source, "utf8"));
	}

	// The manifest's own hash is the input the entry announced, so it has to be built once; its *value* is
	// asserted below against the address this test computes from the disk. Only the hashing of the files is
	// asynchronous, so that is the one step with a deadline of its own.
	const observed = await guard(observeBundleFiles(directory, names), "observeBundleFiles");
	const declared = buildBundleManifest(observed, { executableNames });
	const ready = { op: "ready", protocolVersion: REMOTE_BOOTSTRAP_PROTOCOL_VERSION, bundleSha256: declared.bundleSha256, nonce: NONCE, deployRoot: DEPLOY_ROOT, staging: `${REMOTE_BOOTSTRAP_STAGING_PREFIX}${NONCE}` };
	await guard(
		withPrivateBundleUploadPlan({ connection: CONNECTION, ready, directory, names, executableNames }, async (plan) => {
			const files = plain(plan.manifest.files);
			const address = expectedBundleSha256(truth);

			assert.equal(plan.manifest.schemaVersion, REMOTE_BUNDLE_MANIFEST_SCHEMA_VERSION);
			assert.equal(address, declared.bundleSha256, "the manifest's content address must be the documented wire definition");
			assert.equal(plan.manifest.bundleSha256, address);
			assert.deepEqual(plain(plan.executableNames), executableNames);
			// The pinned scp call resolves bare names against the private snapshot, and targets the exact
			// staging directory the entry announced. The names sit in front of the single target operand, where a
			// `--` terminator keeps a name that begins with a dash from being read as an option.
			assert.equal(plan.invocation.executable, CONNECTION.executable);
			assert.notEqual(plan.invocation.cwd, directory, "scp must read the private snapshot, not the mutable source");
			for (const artifact of REMOTE_HELPER_ARTIFACTS) assert.equal(readFileSync(join(plan.invocation.cwd, artifact.name), "utf8"), artifact.source);
			const argv = plain(plan.invocation.args);
			assert.deepEqual(argv.slice(-(names.length + 1), -1), names);
			assert.equal(argv.at(-1), `${CONNECTION.destination}:${DEPLOY_ROOT}/${REMOTE_BOOTSTRAP_STAGING_PREFIX}${NONCE}`);
			assert.equal(argv.includes("--"), true);

			const lines = buildFinalizeFrames(plan.manifest, { executableNames: [...plan.executableNames] });
			const frames = lines.map((line) => JSON.parse(line));
			const beginFields = contractTypeFields("RemoteBootstrapFinalizeBeginFrame");
			const beginLiterals = contractTypeLiterals("RemoteBootstrapFinalizeBeginFrame");
			const fileFields = contractTypeFields("RemoteBootstrapFinalizeFileFrame");
			const fileLiterals = contractTypeLiterals("RemoteBootstrapFinalizeFileFrame");
			const commitFields = contractTypeFields("RemoteBootstrapFinalizeCommitFrame");
			const commitLiterals = contractTypeLiterals("RemoteBootstrapFinalizeCommitFrame");
			const entry = readBootstrapEntryAcceptance();

			assert.equal(frames.length, files.length + 2, "one finalize-begin, one frame per declared file, one finalize-commit");
			for (const line of lines) assert.ok(Buffer.byteLength(line, "utf8") <= REMOTE_BOOTSTRAP_MAX_FRAME_BYTES, "every frame must fit the entry's 4096 byte inbound cap");

			// finalize-begin: the field names of the contract type *and* of the entry's `exact(...)` list, and the
			// op/v values taken from the contract's own literals instead of being retyped here.
			assert.deepEqual(Object.keys(frames[0]).sort(), [...beginFields].sort());
			assert.deepEqual(Object.keys(frames[0]).sort(), [...entry.begin].sort());
			assert.equal(frames[0].op, beginLiterals.op);
			assert.equal(frames[0].v, beginLiterals.v);
			assert.equal(frames[0].files, files.length);
			assert.equal(frames[0].bundleSha256, address);

			// One finalize-file per manifest entry, in the manifest's name order, carrying this test's own digests.
			const order = [...truth.keys()].sort();
			files.forEach((file, index) => {
				const frame = frames[index + 1];
				assert.deepEqual(Object.keys(frame).sort(), [...fileFields].sort());
				assert.deepEqual(Object.keys(frame).sort(), [...entry.file].sort());
				assert.equal(frame.op, fileLiterals.op);
				assert.equal(frame.v, fileLiterals.v);
				assert.equal(file.name, order[index], "the frames follow the manifest's name-sorted order");
				assert.equal(frame.name, file.name);
				assert.equal(frame.sha256, truth.get(file.name).sha256, "the digest is the one computed from disk in this process");
				assert.equal(frame.bytes, truth.get(file.name).bytes);
				assert.equal(frame.mode, truth.get(file.name).mode);
				assert.ok(REMOTE_BOOTSTRAP_FILE_MODES.includes(frame.mode), "only the two declared octal modes may travel");
			});
			assert.equal(frames.at(-1).op, commitLiterals.op);
			assert.equal(frames.at(-1).v, commitLiterals.v);
			assert.deepEqual(Object.keys(frames.at(-1)).sort(), [...commitFields].sort());
			assert.deepEqual(Object.keys(frames.at(-1)).sort(), ["op", "v"], "finalize-commit and abort are the entry's two minimal frames");
		}),
		"withPrivateBundleUploadPlan",
	);
});

linkSeamTest("a file larger than one chunk comes back byte for byte through the real helper", async (t) => {
	const fixture = createWorkspaceFixture(t);
	const content = patternBytes(OVERSIZE_BYTES);
	writeFileSync(join(fixture.root, "big.bin"), content);
	// Disk truth, read here and not through the helper: size, mtime and the bytes themselves.
	const truthStat = statSync(join(fixture.root, "big.bin"));
	const truthDigest = sha256(content);
	const helper = startHelper(t, fixture.root);

	const file = await guard(helper.reader.readFile(HOST_ID, "big.bin", { timeoutMs: REQUEST_TIMEOUT_MS }), "readFile big.bin");
	assert.equal(file.bytes, OVERSIZE_BYTES);
	assert.equal(file.bytes, truthStat.size, "the byte count is the size on disk, not a value derived from the answer");
	assert.equal(file.mtimeMs, truthStat.mtimeMs, "the mtime is the one an independent stat reports");
	const assembled = Buffer.from(file.content);
	assert.equal(assembled.length, OVERSIZE_BYTES);
	assert.ok(assembled.equals(content), "the assembled bytes must equal the file on disk byte for byte");
	assert.equal(sha256(assembled), truthDigest);

	// The chunk seam itself: the request side is the contract's, one frame per chunk, ceiling first.
	const reads = helper.ofMethod(REMOTE_HELPER_METHOD_FS_READ);
	assert.equal(reads.length, 2, "one chunk at the ceiling plus a remainder, and no more");
	assert.deepEqual(
		reads.map((frame) => frame.params),
		[
			{ path: "big.bin", offset: 0, bytes: CHUNK },
			{ path: "big.bin", offset: CHUNK, bytes: OVERSIZE_BYTES - CHUNK },
		],
	);
	for (const frame of reads) {
		assert.equal(frame.method, REMOTE_HELPER_METHOD_FS_READ);
		assert.equal(frame.v, REMOTE_HELPER_PROTOCOL_VERSION);
		assert.deepEqual(Object.keys(frame.params).sort(), ["bytes", "offset", "path"]);
	}
	const descriptions = helper.ofMethod(REMOTE_HELPER_METHOD_FS_STAT);
	assert.equal(descriptions.length, 2, "the entry is described before and after the chunks");
	for (const frame of descriptions) {
		assert.equal(frame.method, REMOTE_HELPER_METHOD_FS_STAT);
		assert.deepEqual(Object.keys(frame.params), ["path"]);
	}
	assert.deepEqual(helper.wireCodes(), [], "the helper refused nothing during the read");
	assert.deepEqual(helper.diagnostics, []);
	assert.deepEqual(helper.readerDiagnostics, []);
	// The read is a read: the version on disk is the one that was returned, still untouched afterwards.
	assert.equal(statSync(join(fixture.root, "big.bin")).mtimeMs, truthStat.mtimeMs);
});

linkSeamTest("list matches the directory on disk and stat classifies file, directory and link", async (t) => {
	const fixture = createWorkspaceFixture(t);
	const helper = startHelper(t, fixture.root);

	const listing = plain(await guard(helper.reader.list(HOST_ID, ".", { timeoutMs: REQUEST_TIMEOUT_MS }), "list ."));
	const listFrame = helper.ofMethod(REMOTE_HELPER_METHOD_FS_LIST)[0];
	assert.equal(listFrame.method, REMOTE_HELPER_METHOD_FS_LIST);
	assert.deepEqual(Object.keys(listFrame.params), ["path"]);
	assert.equal(listFrame.params.path, ".");
	assert.deepEqual(Object.keys(listing).sort(), ["entries"]);

	// Every entry is compared against an independent readdir plus lstat of the same directory.
	assert.deepEqual(
		listing.entries.map((entry) => entry.name),
		readdirSync(fixture.root).sort(),
		"the listing is the directory's own entry set, name-sorted",
	);
	for (const entry of listing.entries) {
		const stats = lstatSync(join(fixture.root, entry.name));
		const kind = stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "other";
		assert.equal(entry.kind, kind, `${entry.name} must be classified from its own entry`);
		if (kind === "file") assert.equal(entry.bytes, stats.size, `${entry.name} carries its own size`);
		else assert.equal(Object.hasOwn(entry, "bytes"), false, `${entry.name} may not carry a size`);
	}
	// The two links are the interesting ones: they are `other`, which is what a stat that never follows a
	// link has to report for them.
	for (const name of ["notes-link", "sub-link"]) {
		assert.equal(listing.entries.find((entry) => entry.name === name).kind, "other", `${name} is a link: the entry itself is classified, never its target`);
	}

	// stat of the three kinds the contract declares, each against its own independent lstat.
	const fileStat = plain(await guard(helper.reader.stat(HOST_ID, "notes.txt", { timeoutMs: REQUEST_TIMEOUT_MS }), "stat notes.txt"));
	assert.deepEqual(Object.keys(fileStat).sort(), ["bytes", "kind", "mtimeMs"]);
	assert.equal(fileStat.kind, "file");
	assert.equal(fileStat.bytes, statSync(join(fixture.root, "notes.txt")).size);
	assert.equal(fileStat.mtimeMs, statSync(join(fixture.root, "notes.txt")).mtimeMs);
	const directoryStat = plain(await guard(helper.reader.stat(HOST_ID, "sub", { timeoutMs: REQUEST_TIMEOUT_MS }), "stat sub"));
	assert.equal(directoryStat.kind, "directory");
	const linkStat = plain(await guard(helper.reader.stat(HOST_ID, "notes-link", { timeoutMs: REQUEST_TIMEOUT_MS }), "stat notes-link"));
	assert.equal(linkStat.kind, "other", "a link is classified as itself, never as its target");
	assert.equal(linkStat.bytes, lstatSync(join(fixture.root, "notes-link")).size, "the link's own size, never the target's");
	assert.deepEqual(helper.ofMethod(REMOTE_HELPER_METHOD_FS_STAT).at(-1).params, { path: "notes-link" });

	// A link is not readable as a file — and the reader refuses it from the sizing description it already
	// has, so the helper is never asked to open it (its own answer would be NOT_A_FILE as well). This is the
	// seam the reader's comment at readRegularFile describes: lstat semantics on both sides, no resolution.
	const readsBefore = helper.ofMethod(REMOTE_HELPER_METHOD_FS_READ).length;
	const linkRead = await rejection(helper.reader.readFile(HOST_ID, "notes-link", { timeoutMs: REQUEST_TIMEOUT_MS }), "readFile notes-link");
	assert.equal(linkRead.code, "NOT_A_FILE");
	assert.equal(linkRead.message, "NOT_A_FILE");
	assert.equal(helper.ofMethod(REMOTE_HELPER_METHOD_FS_READ).length, readsBefore, "no chunk was requested for a link");
	assert.deepEqual(helper.wireCodes(), [], "the refusal came from the description the reader already had");
	assert.deepEqual(plain(helper.readerDiagnostics.at(-1)), { hostId: HOST_ID, method: REMOTE_HELPER_METHOD_FS_READ, code: "NOT_A_FILE" });
	// The target is reachable only by naming the resolved path explicitly, which is the whole point.
	const target = await guard(helper.reader.readFile(HOST_ID, "notes.txt", { timeoutMs: REQUEST_TIMEOUT_MS }), "readFile notes.txt");
	assert.equal(Buffer.from(target.content).toString("utf8"), "notes content\n");

	// A directory is not a listing and a file is not a file to read: the helper's own codes cross unchanged.
	const fileListing = await rejection(helper.reader.list(HOST_ID, "notes.txt", { timeoutMs: REQUEST_TIMEOUT_MS }), "list notes.txt");
	assert.equal(fileListing.code, "NOT_A_DIRECTORY");
	assert.equal(helper.wireCodes().includes("NOT_A_DIRECTORY"), true, "that refusal is the helper's, not the reader's");
	const directoryRead = await rejection(helper.reader.readFile(HOST_ID, "sub", { timeoutMs: REQUEST_TIMEOUT_MS }), "readFile sub");
	assert.equal(directoryRead.code, "NOT_A_FILE");
	for (const code of helper.wireCodes()) assert.ok(REMOTE_HELPER_ERROR_CODES.includes(code), `${code} is not in the contract's closed vocabulary`);
});

linkSeamTest("a path outside the root converges on PATH_OUTSIDE_ROOT at every layer", async (t) => {
	const fixture = createWorkspaceFixture(t);
	const helper = startHelper(t, fixture.root);
	const outsidePath = "../outside/secret.txt";

	// Layer one: the client. The helper's own refusal reaches it with its code and retry hint intact, and
	// without a message, because the frozen helper never sends one.
	const wireError = await rejection(helper.port.request(HOST_ID, REMOTE_HELPER_METHOD_FS_STAT, { path: outsidePath }, {}), "raw fs.stat outside the root");
	assert.equal(wireError.code, "PATH_OUTSIDE_ROOT");
	assert.equal(wireError.retryable, false);
	assert.equal(wireError.remoteMessage, undefined, "the helper sent no text and the client must not invent one");

	// Layer two: the wire. The code on the frame is the same one, and the error body carries no free text.
	const refusal = helper.inbound.at(-1);
	assert.equal(refusal.ok, false);
	assert.equal(refusal.error.code, "PATH_OUTSIDE_ROOT");
	assert.equal(refusal.error.retryable, false);
	assert.equal(Object.hasOwn(refusal.error, "message"), false);
	assert.deepEqual(Object.keys(refusal).sort(), frameFields(RESPONSE_FIELDS, ["result"]));

	// Layer three: the reader. The same code again — no rewrite, no wrapping, no relayed remote text.
	const readerError = await rejection(helper.reader.readFile(HOST_ID, outsidePath, { timeoutMs: REQUEST_TIMEOUT_MS }), "readFile outside the root");
	assert.equal(readerError.code, "PATH_OUTSIDE_ROOT");
	assert.equal(readerError.message, "PATH_OUTSIDE_ROOT", "the message is the stable code, never the helper's text");
	assert.equal(readerError.retryable, false);
	assert.equal(Object.hasOwn(readerError, "remoteMessage"), false);
	assert.ok(REMOTE_HELPER_ERROR_CODES.includes(readerError.code));
	// The sizing stat is the request that failed, which is the method the diagnostic names.
	assert.deepEqual(plain(helper.readerDiagnostics.at(-1)), { hostId: HOST_ID, method: REMOTE_HELPER_METHOD_FS_STAT, code: "PATH_OUTSIDE_ROOT" });
	assert.deepEqual(helper.ofMethod(REMOTE_HELPER_METHOD_FS_READ), [], "no chunk is ever asked for after the refusal");

	// The same convergence for the other two methods: the escape is refused before anything is opened.
	const listError = await rejection(helper.reader.list(HOST_ID, "../outside", { timeoutMs: REQUEST_TIMEOUT_MS }), "list outside the root");
	assert.equal(listError.code, "PATH_OUTSIDE_ROOT");
	const absoluteError = await rejection(helper.reader.stat(HOST_ID, "/etc/hosts", { timeoutMs: REQUEST_TIMEOUT_MS }), "stat an absolute path");
	assert.equal(absoluteError.code, "PATH_OUTSIDE_ROOT");
	assert.equal(
		helper.wireCodes().every((code) => code === "PATH_OUTSIDE_ROOT"),
		true,
		"every refusal on the wire is that one code",
	);

	// Nothing about the outside world travelled: not the decoy's content, not the path that named it.
	const observed = JSON.stringify({ diagnostics: helper.diagnostics, readerDiagnostics: helper.readerDiagnostics, codes: helper.wireCodes() });
	for (const text of [helper.lines.join("\n"), helper.stderrText(), observed, `${readerError.code} ${readerError.message}`]) {
		assert.equal(text.includes(DECOY), false, "the decoy outside the root must never be read");
		assert.equal(text.includes("secret.txt"), false, "no remote text or requested path may travel back through an error");
	}
});

linkSeamTest("an aborted call withdraws the very request the client minted", async (t) => {
	const fixture = createWorkspaceFixture(t);
	const helper = startHelper(t, fixture.root);
	const controller = new AbortController();

	// The reader writes its sizing frame synchronously, so the request exists — and is still pending —
	// before the abort lands: an abort that arrived any later would be a different test.
	const pending = helper.reader.readFile(HOST_ID, "notes.txt", { signal: controller.signal, timeoutMs: REQUEST_TIMEOUT_MS });
	const sizing = helper.ofMethod(REMOTE_HELPER_METHOD_FS_STAT).at(-1);
	assert.ok(sizing !== undefined, "the sizing request must be on the wire before the abort");
	controller.abort();

	const error = await rejection(pending, "an aborted readFile");
	assert.equal(error.code, "REQUEST_CANCELLED");
	// The withdraw names the id the *client* minted, which is the only thing that makes it reachable at all.
	const withdraw = helper.ofMethod(REMOTE_HELPER_METHOD_CANCEL).at(-1);
	assert.ok(withdraw !== undefined, "an in-flight request must leave a cancel frame behind");
	assert.equal(withdraw.method, REMOTE_HELPER_METHOD_CANCEL);
	assert.deepEqual(Object.keys(withdraw.params), ["requestId"]);
	assert.equal(withdraw.params.requestId, sizing.id);
	assert.equal(withdraw.hostId, HOST_ID);
	assert.equal(withdraw.generation, sizing.generation);

	// The helper answers `already-settled` for work that already ran, and that answer is read as "the
	// withdraw did not take effect" — a diagnostic, never a rollback of the call's own outcome.
	await waitFor(() => helper.readerDiagnostics.some((entry) => entry.code === REMOTE_WORKSPACE_DIAGNOSTIC_CODES.cancelRefused), "the withdraw's answer to be read");
	const codes = helper.readerDiagnostics.map((entry) => entry.code);
	assert.equal(codes.includes(REMOTE_WORKSPACE_DIAGNOSTIC_CODES.cancelRequested), true);
	assert.equal(codes.includes(REMOTE_WORKSPACE_DIAGNOSTIC_CODES.cancelFailed), false);
	for (const entry of helper.readerDiagnostics) assert.equal(entry.hostId, HOST_ID);
	assert.deepEqual(helper.wireCodes(), [], "a withdrawal is not a refusal of the call's work");
});

/**
 * A real search tree for fs.searchNames: matches of both cases, a directory whose own name takes part, a
 * wide directory that only exists to reach the match ceiling, and three links - to a directory inside the
 * root, to a file inside it, and out of it - each of which must be described as itself and never entered.
 */
function createSearchFixture(t) {
	const base = mkdtempSync(join(tmpdir(), "pideck-e2e-search-"));
	const root = join(base, "root");
	const outside = join(base, "outside");
	mkdirSync(join(root, "nested-report-dir"), { recursive: true });
	mkdirSync(join(root, "bulk"), { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(root, "Alpha-report.txt"), "alpha report\n");
	writeFileSync(join(root, "beta-report.TXT"), "beta report\n");
	writeFileSync(join(root, "notes.md"), "notes\n");
	writeFileSync(join(root, "nested-report-dir", "deep-report.txt"), "deep report\n");
	for (let index = 0; index < 600; index += 1) writeFileSync(join(root, "bulk", "bulk-" + String(index).padStart(3, "0") + ".txt"), "");
	writeFileSync(join(outside, "secret-report.txt"), DECOY);
	symlinkSync(join(root, "nested-report-dir"), join(root, "report-dir-link"), process.platform === "win32" ? "junction" : "dir");
	symlinkSync(join(root, "Alpha-report.txt"), join(root, "report-file-link"), process.platform === "win32" ? "file" : undefined);
	symlinkSync(outside, join(root, "report-outside-link"), process.platform === "win32" ? "junction" : "dir");
	t.after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
	return { base, root, outside };
}

linkSeamTest("fs.searchNames walks a real tree within its ceilings and its containment rules", async (t) => {
	const fixture = createSearchFixture(t);
	const helper = startHelper(t, fixture.root);
	const search = (params) => guard(helper.port.request(HOST_ID, REMOTE_HELPER_METHOD_FS_SEARCH_NAMES, params, {}), "fs.searchNames " + JSON.stringify(params));

	// Real matches, computed from the disk here: the query name in both cases, the directory that carries
	// it, the file inside that directory, and the three links as the entries they are.
	const answer = plain(await search({ path: ".", query: "report" }));
	assert.deepEqual(Object.keys(answer).sort(), ["entries", "scanned", "truncated"]);
	assert.deepEqual(
		answer.entries.map((entry) => ({ path: entry.path, name: entry.name, kind: entry.kind, bytes: entry.bytes })),
		[
			{ path: "Alpha-report.txt", name: "Alpha-report.txt", kind: "file", bytes: lstatSync(join(fixture.root, "Alpha-report.txt")).size },
			{ path: "beta-report.TXT", name: "beta-report.TXT", kind: "file", bytes: lstatSync(join(fixture.root, "beta-report.TXT")).size },
			{ path: "nested-report-dir", name: "nested-report-dir", kind: "directory", bytes: undefined },
			{ path: "nested-report-dir/deep-report.txt", name: "deep-report.txt", kind: "file", bytes: lstatSync(join(fixture.root, "nested-report-dir", "deep-report.txt")).size },
			{ path: "report-dir-link", name: "report-dir-link", kind: "other", bytes: undefined },
			{ path: "report-file-link", name: "report-file-link", kind: "other", bytes: undefined },
			{ path: "report-outside-link", name: "report-outside-link", kind: "other", bytes: undefined },
		],
	);
	assert.equal(answer.truncated, false);
	// Nothing was cut short: the root's eight entries, the nested directory's one and the wide directory's
	// 600 are all visited, and the two links are the only entries that are not entered.
	assert.equal(answer.scanned, 609);
	assert.equal(
		answer.entries.some((entry) => entry.path.startsWith("report-dir-link/") || entry.path.startsWith("report-outside-link/")),
		false,
		"a link is an entry, never a door",
	);
	// The request side is the contract's method and params, and it travelled as one frame.
	const request = helper.ofMethod(REMOTE_HELPER_METHOD_FS_SEARCH_NAMES).at(-1);
	assert.equal(request.method, REMOTE_HELPER_METHOD_FS_SEARCH_NAMES);
	assert.deepEqual(Object.keys(request.params), ["path", "query"]);
	assert.equal(request.params.path, ".");
	assert.equal(request.params.query, "report");

	// The match ceiling: 600 entries answer to "bulk" - the directory's own name included - so the walk
	// stops at the ceiling and says so instead of looking like the whole tree.
	const capped = plain(await search({ path: ".", query: "bulk" }));
	assert.equal(capped.entries.length, REMOTE_HELPER_MAX_SEARCH_MATCHES);
	assert.equal(capped.truncated, true);
	assert.equal(capped.entries[0].path, "bulk");
	assert.equal(capped.entries[1].path, "bulk/bulk-000.txt");
	assert.equal(capped.entries.at(-1).path, "bulk/bulk-510.txt");
	assert.equal(capped.scanned, 8 + 511, "eight root entries and the 511 matches that filled the ceiling");
	// A caller's own ceiling truncates earlier, and the entry that fills it is part of the answer.
	const small = plain(await search({ path: ".", query: "bulk", maxMatches: 2 }));
	assert.deepEqual(
		small.entries.map((entry) => entry.path),
		["bulk", "bulk/bulk-000.txt"],
	);
	assert.equal(small.truncated, true);
	assert.equal(small.scanned, 9);
	// A huge maxMatches is clamped to the contract's ceiling, not honoured.
	const huge = plain(await search({ path: ".", query: "bulk", maxMatches: 999 }));
	assert.equal(huge.entries.length, REMOTE_HELPER_MAX_SEARCH_MATCHES);

	// The containment rules are the batch's: an escape is refused before anything is opened, and an
	// unusable query is refused under its own code.
	const escaped = await rejection(helper.port.request(HOST_ID, REMOTE_HELPER_METHOD_FS_SEARCH_NAMES, { path: "../outside", query: "report" }, {}), "fs.searchNames outside the root");
	assert.equal(escaped.code, "PATH_OUTSIDE_ROOT");
	assert.equal(escaped.retryable, false);
	const absolute = await rejection(helper.port.request(HOST_ID, REMOTE_HELPER_METHOD_FS_SEARCH_NAMES, { path: fixture.outside, query: "report" }, {}), "fs.searchNames of an absolute path");
	assert.equal(absolute.code, "PATH_OUTSIDE_ROOT");
	const empty = await rejection(helper.port.request(HOST_ID, REMOTE_HELPER_METHOD_FS_SEARCH_NAMES, { path: ".", query: "" }, {}), "fs.searchNames with an empty query");
	assert.equal(empty.code, "QUERY_INVALID");
	const overlong = await rejection(helper.port.request(HOST_ID, REMOTE_HELPER_METHOD_FS_SEARCH_NAMES, { path: ".", query: "r".repeat(REMOTE_HELPER_MAX_SEARCH_QUERY_LENGTH + 1) }, {}), "fs.searchNames with an over-long query");
	assert.equal(overlong.code, "QUERY_INVALID");
	for (const code of helper.wireCodes()) assert.ok(REMOTE_HELPER_ERROR_CODES.includes(code), code + " is not in the contract's closed vocabulary");
	for (const text of [helper.lines.join("\n"), helper.stderrText()]) {
		assert.equal(text.includes(DECOY), false, "the decoy outside the root must never be read");
		assert.equal(text.includes("secret-report.txt"), false, "no remote text or requested path may travel back through an error");
	}
});
