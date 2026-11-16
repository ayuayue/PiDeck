import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/*
 * F4 independent verification of remote session discovery (task-15, G3) plus the bounded head primitive
 * it depends on.
 *
 * Three claims are attacked with instruments rather than by reading a result:
 *
 * 1. readHead never reads more than it was asked for. The port is a counter: every fs.read frame is
 *    recorded with the byte count it requested, and the assertions are on the sum and the maximum. A
 *    whole-file read is exactly the shape this catches.
 * 2. Every ceiling is a refusal, not a truncation, and the ceiling that triggered is the one reported. The
 *    frame log additionally shows that a ceiling checked before an I/O step really did stop before it.
 * 3. Registration is idempotent per remote identity, including the two-pass match order (a remoteSessionId
 *    hit anywhere in the table outranks a remotePath hit earlier in it), and no result carries a file body.
 */

const { createRemoteWorkspaceReader, REMOTE_WORKSPACE_MAX_HEAD_BYTES } = loadTsCommonJs("src/main/remote/RemoteWorkspaceReader.ts");
const scannerModule = loadTsCommonJs("src/main/sessions/RemoteSessionScanner.ts");
const { SessionCatalog, remoteSessionLocatorMatch, findRemoteSessionEntry } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
	stubs: { "../logging/sharedLogger": { getAppLogger: () => null } },
});
const { SUBAGENT_ARTIFACTS_DIR_NAME } = loadTsCommonJs("src/shared/sessionIdentity.ts");

const HOST_ID = "6f1d2c3b-4a59-4e8d-9f70-1a2b3c4d5e6f";
const OTHER_HOST_ID = "0e0f18ba-6f0e-4bd8-9f6c-1c8f6f2a7d31";
const HOME = "/home/dev";
const SESSION_ROOT = HOME + "/.pi/agent/sessions";

/** Production modules live in another VM realm, so deep comparisons are normalised through JSON. */
const plain = (value) => JSON.parse(JSON.stringify(value));

async function failureOf(promise) {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return error;
	}
}

const BASE = mkdtempSync(join(tmpdir(), "pideck-session-scan-"));
after(() => rmSync(BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

/* readHead: a scripted port is the counter. */

function readHeadHarness(respond) {
	const frames = [];
	const reader = createRemoteWorkspaceReader({
		port: {
			request(hostId, method, params) {
				frames.push({ hostId, method, params: plain(params ?? {}) });
				return Promise.resolve(respond(method, params));
			},
		},
	});
	const reads = () => frames.filter((frame) => frame.method === "fs.read");
	const requestedBytes = () => reads().reduce((total, frame) => total + frame.params.bytes, 0);
	return { reader, frames, reads, requestedBytes };
}

/** A well-formed 10 MiB remote file whose chunks are generated from the requested range. */
const BIG_SIZE = 10 * 1024 * 1024;
function bigFileRespond(method, params) {
	if (method === "fs.stat") return { kind: "file", bytes: BIG_SIZE, mtimeMs: 7 };
	if (method === "fs.read") {
		const offset = params.offset;
		const size = Math.max(0, Math.min(params.bytes, BIG_SIZE - offset));
		return { chunk: Buffer.alloc(size, 65).toString("base64"), bytes: size, eof: offset + size >= BIG_SIZE };
	}
	throw new Error("unexpected method " + method);
}

test("readHead requests at most the head it was asked for, never the whole file", async () => {
	const { reader, frames, reads, requestedBytes } = readHeadHarness(bigFileRespond);
	const head = await reader.readHead(HOST_ID, "ws/big.jsonl", REMOTE_WORKSPACE_MAX_HEAD_BYTES);
	assert.equal(head.bytes, REMOTE_WORKSPACE_MAX_HEAD_BYTES);
	assert.equal(head.content.length, REMOTE_WORKSPACE_MAX_HEAD_BYTES);
	assert.equal(head.size, BIG_SIZE, "size comes from the sizing stat");
	assert.equal(head.truncated, true, "a file larger than the head is truncated by definition");
	// The counter is the evidence: the sum of every requested range is the head ceiling, and no single frame
	// asked for the whole 10 MiB.
	assert.equal(requestedBytes(), REMOTE_WORKSPACE_MAX_HEAD_BYTES);
	for (const frame of reads()) assert.ok(frame.params.bytes <= REMOTE_WORKSPACE_MAX_HEAD_BYTES, "frame asked for " + frame.params.bytes);
	assert.ok(requestedBytes() < head.size, "the request must not be the file size");
	assert.equal(frames.filter((frame) => frame.method === "fs.stat").length, 1, "one sizing stat, no closing stat");
	assert.equal(reads().length, 1, "64 KiB fits one contract chunk");
});

test("readHead stops at the file end for a small file and sends no read at all for an empty one", async () => {
	const small = 100;
	const smallHarness = readHeadHarness((method, params) => {
		if (method === "fs.stat") return { kind: "file", bytes: small, mtimeMs: 1 };
		const size = Math.max(0, Math.min(params.bytes, small - params.offset));
		return { chunk: Buffer.alloc(size, 66).toString("base64"), bytes: size, eof: params.offset + size >= small };
	});
	const head = await smallHarness.reader.readHead(HOST_ID, "ws/small.jsonl", REMOTE_WORKSPACE_MAX_HEAD_BYTES);
	assert.equal(head.bytes, small);
	assert.equal(head.truncated, false, "a complete prefix is not a truncation");
	assert.equal(head.size, small);
	assert.equal(smallHarness.requestedBytes(), small, "exactly the file size is requested");

	const emptyHarness = readHeadHarness((method) => {
		if (method === "fs.stat") return { kind: "file", bytes: 0, mtimeMs: 1 };
		throw new Error("an empty file must not be read");
	});
	const empty = await emptyHarness.reader.readHead(HOST_ID, "ws/empty.jsonl", REMOTE_WORKSPACE_MAX_HEAD_BYTES);
	assert.equal(empty.bytes, 0);
	assert.equal(empty.truncated, false);
	assert.deepEqual(emptyHarness.reads(), [], "a zero-byte head needs no read frame");
});

test("readHead refuses an out-of-range or nonsensical maxBytes before sending any frame", async () => {
	const tooLarge = readHeadHarness(() => {
		throw new Error("no frame may be sent");
	});
	const over = await failureOf(tooLarge.reader.readHead(HOST_ID, "ws/a.jsonl", REMOTE_WORKSPACE_MAX_HEAD_BYTES + 1));
	assert.equal(over.code, "RESULT_TOO_LARGE", "a ceiling above the local cap is refused, never clamped");
	assert.deepEqual(tooLarge.frames, []);
	for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "64", undefined, null]) {
		const harness = readHeadHarness(() => {
			throw new Error("no frame may be sent");
		});
		const failure = await failureOf(harness.reader.readHead(HOST_ID, "ws/a.jsonl", value));
		assert.ok(failure !== undefined, String(value) + " must be refused");
		assert.equal(failure.code, "PROTOCOL_INVALID", String(value) + " answered " + failure.code);
		assert.deepEqual(harness.frames, [], String(value) + " must not reach the wire");
	}
	// The exact ceiling is inclusive, so the boundary itself is legal.
	const atLimit = readHeadHarness(bigFileRespond);
	const head = await atLimit.reader.readHead(HOST_ID, "ws/big.jsonl", REMOTE_WORKSPACE_MAX_HEAD_BYTES);
	assert.equal(head.bytes, REMOTE_WORKSPACE_MAX_HEAD_BYTES);
});

test("readHead refuses a non-regular entry and a remote that contradicts itself", async () => {
	for (const kind of ["directory", "other"]) {
		const harness = readHeadHarness(() => ({ kind, bytes: 0, mtimeMs: 1 }));
		const failure = await failureOf(harness.reader.readHead(HOST_ID, "ws/a.jsonl", 1024));
		assert.equal(failure.code, "NOT_A_FILE", kind + " must not be read as a file");
		assert.deepEqual(harness.reads(), []);
	}
	// A chunk longer than asked, and a short chunk that claims more is coming: both are self-contradictions.
	const hostile = [
		{ chunk: Buffer.alloc(2048, 67).toString("base64"), bytes: 2048, eof: true },
		{ chunk: Buffer.alloc(10, 67).toString("base64"), bytes: 10, eof: false },
		{ chunk: Buffer.alloc(10, 67).toString("base64"), bytes: 11, eof: true },
	];
	for (const answer of hostile) {
		const harness = readHeadHarness((method) => (method === "fs.stat" ? { kind: "file", bytes: BIG_SIZE, mtimeMs: 1 } : answer));
		const failure = await failureOf(harness.reader.readHead(HOST_ID, "ws/big.jsonl", 1024));
		assert.equal(failure.code, "PROTOCOL_INVALID", JSON.stringify(answer) + " must be refused");
	}
});

test("readHead is bound to the call options like every other reader call", async () => {
	const harness = readHeadHarness(bigFileRespond);
	const controller = new AbortController();
	controller.abort();
	const cancelled = await failureOf(harness.reader.readHead(HOST_ID, "ws/big.jsonl", 1024, { signal: controller.signal }));
	assert.equal(cancelled.code, "REQUEST_CANCELLED", "an aborted call must not start a frame");
	assert.deepEqual(harness.frames, []);
	const badPath = await failureOf(harness.reader.readHead(HOST_ID, "", 1024));
	assert.equal(badPath.code, "PROTOCOL_INVALID");
});

/* Scanner: a fake remote whose frame log is the instrument. */

function remoteDirectory(children) {
	return { kind: "directory", children };
}
function remoteFile(bytes, mtimeMs) {
	return { kind: "file", bytes, mtimeMs, content: "SECRET-BODY".repeat(Math.ceil(bytes / 11) + 1) };
}

/**
 * Resolve a remote POSIX path against the fixture tree. Directories are registered under their full path
 * (".", "ws", "d0", ...), so a nested file ("ws/a.jsonl") is found by walking segment by segment; a
 * shallow map lookup would answer PATH_NOT_FOUND for every nested entry.
 */
function resolveRemoteNode(tree, path) {
	if (path === ".") return tree["."];
	const segments = path.split("/");
	let current = ".";
	let node = tree["."];
	for (let index = 0; index < segments.length; index += 1) {
		if (node === undefined || node.kind !== "directory") return undefined;
		const child = node.children.find((candidate) => candidate.name === segments[index]);
		if (child === undefined) return undefined;
		current = current === "." ? segments[index] : current + "/" + segments[index];
		// A directory child is only a descriptor inside its parent; the children live on the node registered
		// under the full path, which is what a listing needs.
		if (index === segments.length - 1) return child.kind === "directory" ? tree[current] : child;
		node = tree[current];
	}
	return node;
}

function fakeRemote(tree, options = {}) {
	const frames = [];
	let inFlight = 0;
	let peak = 0;
	const session = {
		async request(method, params) {
			frames.push({ method, params: plain(params ?? {}) });
			if (method === "fs.list") {
				inFlight += 1;
				peak = Math.max(peak, inFlight);
				try {
					if (typeof options.listOverride === "function") {
						const custom = options.listOverride(params);
						if (custom !== undefined) return custom;
					}
					if (options.listDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, options.listDelayMs));
					const node = resolveRemoteNode(tree, params.path);
					if (node === undefined) throw Object.assign(new Error("PATH_NOT_FOUND"), { code: "PATH_NOT_FOUND" });
					if (node.kind !== "directory") throw Object.assign(new Error("NOT_A_DIRECTORY"), { code: "NOT_A_DIRECTORY" });
					return { entries: node.children.map((child) => (child.kind === "file" ? { name: child.name, kind: "file", bytes: child.bytes } : { name: child.name, kind: child.kind })) };
				} finally {
					inFlight -= 1;
				}
			}
			if (method === "fs.stat" || method === "fs.statMany") {
				const paths = method === "fs.stat" ? [params.path] : params.paths;
				const described = [];
				for (const path of paths) {
					if (typeof options.statOverride === "function") {
						const custom = options.statOverride({ path });
						if (custom !== undefined) {
							described.push({ path, kind: custom.kind, bytes: custom.bytes, mtimeMs: custom.mtimeMs });
							continue;
						}
					}
					const node = resolveRemoteNode(tree, path);
					if (node === undefined) throw Object.assign(new Error("PATH_NOT_FOUND"), { code: "PATH_NOT_FOUND" });
					described.push(node.kind === "file" ? { path, kind: "file", bytes: node.bytes, mtimeMs: node.mtimeMs } : { path, kind: node.kind, bytes: 0, mtimeMs: 1 });
				}
				// The batch answers in request order, exactly like N single calls would have.
				return method === "fs.stat" ? { kind: described[0].kind, bytes: described[0].bytes, mtimeMs: described[0].mtimeMs } : { entries: described };
			}
			if (method === "fs.read") {
				const node = resolveRemoteNode(tree, params.path);
				const total = node === undefined || node.kind !== "file" ? 0 : node.bytes;
				const size = Math.max(0, Math.min(params.bytes, total - params.offset));
				return { chunk: Buffer.alloc(size, 90).toString("base64"), bytes: size, eof: params.offset + size >= total };
			}
			throw new Error("unexpected method " + method);
		},
		async cancel() {
			return { cancelled: true };
		},
	};
	return { session, frames, peakConcurrency: () => peak };
}

/**
 * Scanner harness over the fake remote. withProjectSession mirrors the production service: a task that
 * throws propagates (the scanner folds it), and an establishment failure is a stable code.
 */
function scannerHarness(options = {}) {
	const remote = fakeRemote(options.tree ?? {}, options);
	const roots = [];
	let sessionCalls = 0;
	const port = {
		// Object.hasOwn, not an undefined check: an explicitly undefined home is a case under test.
		remoteHome: async () => (typeof options.home === "function" ? options.home() : Object.hasOwn(options, "home") ? options.home : HOME),
		async withProjectSession(hostId, root, task) {
			sessionCalls += 1;
			// J2：会话根解析会先用 root=<home>/.pi/agent 探测 settings.json。这份 fixture 没有该文件，
			// 所以探测固定答 PATH_NOT_FOUND ⇒ 退回默认根；探测不记 roots/frames，下面这些「会话阶段」
			// 断言（根来自握手 home、上限在对应 I/O 之前、不读正文）保持原意。
			if (root === HOME + "/.pi/agent") {
				const probe = {
					async request() {
						throw Object.assign(new Error("PATH_NOT_FOUND"), { code: "PATH_NOT_FOUND" });
					},
					async cancel() {
						return { cancelled: true };
					},
				};
				return { ok: true, value: await task(probe) };
			}
			roots.push(root);
			if (options.establishFails !== undefined) return { ok: false, code: options.establishFails };
			return { ok: true, value: await task(remote.session) };
		},
	};
	const scanner = scannerModule.createRemoteSessionScanner({
		port,
		...(options.catalog === undefined ? {} : { catalog: options.catalog }),
		...(options.projectIdForHost === undefined ? {} : { projectIdForHost: options.projectIdForHost }),
		...(options.limits === undefined ? {} : { limits: options.limits }),
	});
	return { scanner, remote, roots, sessionCalls: () => sessionCalls };
}

const JSONL_TREE = {
	".": remoteDirectory([
		{ name: "ws", kind: "directory" },
		{ name: "root.jsonl", kind: "file", bytes: 200, mtimeMs: 11 },
		{ name: "notes.txt", kind: "file", bytes: 10, mtimeMs: 12 },
		{ name: "link.jsonl", kind: "other" },
		// A symlinked directory: the helper reports it as other and never follows it, so nothing behind it may
		// ever appear in a scan even though the fixture registers a session file there.
		{ name: "linkdir", kind: "other" },
		{ name: ".pideck-archive", kind: "directory" },
		{ name: ".trash", kind: "directory" },
		{ name: SUBAGENT_ARTIFACTS_DIR_NAME, kind: "directory" },
	]),
	ws: remoteDirectory([
		{ name: "a.jsonl", kind: "file", bytes: 300, mtimeMs: 21 },
		{ name: "b.txt", kind: "file", bytes: 5, mtimeMs: 22 },
		{ name: "link.jsonl", kind: "other" },
	]),
	".pideck-archive": remoteDirectory([{ name: "old.jsonl", kind: "file", bytes: 1, mtimeMs: 1 }]),
	".trash": remoteDirectory([{ name: "trashed.jsonl", kind: "file", bytes: 1, mtimeMs: 1 }]),
};
JSONL_TREE[SUBAGENT_ARTIFACTS_DIR_NAME] = remoteDirectory([{ name: "artifact.jsonl", kind: "file", bytes: 1, mtimeMs: 1 }]);
JSONL_TREE.linkdir = remoteDirectory([{ name: "escaped.jsonl", kind: "file", bytes: 1, mtimeMs: 1 }]);

test("scan lists only real session files, skips archive/trash/artifacts and never reads a body", async () => {
	const { scanner, remote, roots } = scannerHarness({ tree: JSONL_TREE });
	const result = await scanner.scan(HOST_ID);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.deepEqual(roots, [SESSION_ROOT], "the session root is derived from the handshake home");
	assert.deepEqual(
		plain(result.entries).map((entry) => entry.remoteSessionId),
		["root.jsonl", "ws/a.jsonl"],
		"only the two real session files, in a stable order",
	);
	for (const entry of result.entries) {
		assert.deepEqual(Object.keys(entry).sort(), ["mtimeMs", "name", "remotePath", "remoteSessionId", "size"], "exactly the five metadata fields");
		assert.equal(entry.remotePath, entry.remoteSessionId);
		assert.equal(entry.name, entry.remoteSessionId.slice(entry.remoteSessionId.lastIndexOf("/") + 1).replace(/\.jsonl$/, ""));
		assert.match(entry.remoteSessionId, /\.jsonl$/);
	}
	assert.equal(result.entries[1].size, 300, "the size comes from the stat");
	assert.equal(result.entries[1].mtimeMs, 21);
	assert.ok(!plain(result.entries).some((entry) => entry.remoteSessionId.includes("linkdir") || entry.remoteSessionId.includes("escaped")), "a linked directory must never be entered");
	assert.ok(!JSON.stringify(result).includes("SECRET-BODY"), "no remote body may appear in a scan result");
	assert.deepEqual(
		remote.frames.filter((frame) => frame.method === "fs.read"),
		[],
		"a metadata scan must not read any file",
	);
});

test("scan skips an entry whose kind changed between the listing and the stat", async () => {
	const { scanner } = scannerHarness({ tree: JSONL_TREE, statOverride: (params) => (params.path === "ws/a.jsonl" ? { kind: "directory", bytes: 0, mtimeMs: 1 } : undefined) });
	const result = await scanner.scan(HOST_ID);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.deepEqual(
		plain(result.entries).map((entry) => entry.remoteSessionId),
		["root.jsonl"],
		"a path that is no longer a regular file is skipped, not registered as a session",
	);
});

test("the directory, file and byte ceilings are refusals with their own codes", async () => {
	// Directory ceiling: three workspace directories against a ceiling of two. The trigger must be the
	// directory code, and the directories must never have been listed.
	const manyDirs = {
		".": remoteDirectory([
			{ name: "d1", kind: "directory" },
			{ name: "d2", kind: "directory" },
			{ name: "d3", kind: "directory" },
		]),
	};
	const dirCap = scannerHarness({ tree: manyDirs, limits: { maxWorkspaceDirs: 2 } });
	const dirFailure = await dirCap.scanner.scan(HOST_ID);
	assert.equal(dirFailure.ok, false, JSON.stringify(dirFailure));
	assert.equal(dirFailure.code, "REMOTE_SESSION_DIR_LIMIT_EXCEEDED");
	assert.deepEqual(
		dirCap.remote.frames.filter((frame) => frame.method === "fs.list").map((frame) => frame.params.path),
		["."],
		"the ceiling is checked before the workspace directories are listed",
	);

	// File ceiling: two candidates against a ceiling of one, checked before any stat.
	const files = {
		".": remoteDirectory([{ name: "ws", kind: "directory" }]),
		ws: remoteDirectory([
			{ name: "a.jsonl", kind: "file", bytes: 1, mtimeMs: 1 },
			{ name: "b.jsonl", kind: "file", bytes: 1, mtimeMs: 1 },
		]),
	};
	const fileCap = scannerHarness({ tree: files, limits: { maxFiles: 1 } });
	const fileFailure = await fileCap.scanner.scan(HOST_ID);
	assert.equal(fileFailure.ok, false, JSON.stringify(fileFailure));
	assert.equal(fileFailure.code, "REMOTE_SESSION_FILE_LIMIT_EXCEEDED");
	assert.deepEqual(
		fileCap.remote.frames.filter((frame) => frame.method === "fs.stat"),
		[],
		"the ceiling is checked before the stats",
	);

	// Byte budget: one long directory entry already exceeds a tiny budget.
	const budget = scannerHarness({ tree: manyDirs, limits: { maxTotalBytes: 40 } });
	const budgetFailure = await budget.scanner.scan(HOST_ID);
	assert.equal(budgetFailure.ok, false, JSON.stringify(budgetFailure));
	assert.equal(budgetFailure.code, "REMOTE_SESSION_BUDGET_EXCEEDED");
});

test("scan honours the concurrency ceiling", async () => {
	const tree = { ".": remoteDirectory([]) };
	for (let index = 0; index < 6; index += 1) {
		tree["."].children.push({ name: "d" + index, kind: "directory" });
		tree["d" + index] = remoteDirectory([{ name: "s" + index + ".jsonl", kind: "file", bytes: 1, mtimeMs: 1 }]);
	}
	const { scanner, remote } = scannerHarness({ tree, listDelayMs: 5, limits: { concurrency: 2 } });
	const result = await scanner.scan(HOST_ID);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.equal(result.entries.length, 6);
	assert.ok(remote.peakConcurrency() <= 2, "peak concurrent listings was " + remote.peakConcurrency());
	assert.ok(remote.peakConcurrency() >= 1);
});

test("a malformed remote listing is relayed as a protocol violation, not as an empty list", async () => {
	const malformed = scannerHarness({ tree: JSONL_TREE, listOverride: (params) => (params.path === "." ? { entries: [{ name: "x.jsonl" }] } : undefined) });
	const result = await malformed.scanner.scan(HOST_ID);
	assert.equal(result.ok, false, JSON.stringify(result));
	assert.equal(result.code, "PROTOCOL_INVALID", "an entry without a kind is a shape violation");

	const overflowing = scannerHarness({
		tree: JSONL_TREE,
		listOverride: (params) => (params.path === "." ? { entries: Array.from({ length: 4097 }, (_, index) => ({ name: "f" + index + ".jsonl", kind: "file", bytes: 1 })) } : undefined),
	});
	const overflow = await overflowing.scanner.scan(HOST_ID);
	assert.equal(overflow.ok, false, JSON.stringify(overflow));
	assert.equal(overflow.code, "RESULT_TOO_LARGE", "past the contract listing ceiling the reader refuses instead of truncating");
});

test("an establishment failure is relayed verbatim and an unusable home fails closed", async () => {
	const relayed = scannerHarness({ tree: JSONL_TREE, establishFails: "SSH_HOST_DISCONNECTED" });
	const failure = await relayed.scanner.scan(HOST_ID);
	assert.equal(failure.ok, false);
	assert.equal(failure.code, "SSH_HOST_DISCONNECTED", "the connection layer's own code must survive");
	for (const home of [undefined, "", "relative/home", "/home/de\u0000v", 42, "/home/" + "x".repeat(5000)]) {
		const harness = scannerHarness({ tree: JSONL_TREE, home });
		const refused = await harness.scanner.scan(HOST_ID);
		assert.equal(refused.ok, false, JSON.stringify(home));
		assert.equal(refused.code, "REMOTE_SESSION_HOME_UNAVAILABLE", JSON.stringify(home) + " answered " + refused.code);
		assert.equal(harness.sessionCalls(), 0, JSON.stringify(home) + " must not establish a session");
	}
	const badHost = scannerHarness({ tree: JSONL_TREE });
	const hostFailure = await badHost.scanner.scan("");
	assert.equal(hostFailure.code, "REMOTE_SESSION_HOST_ID_INVALID");
	assert.equal(badHost.sessionCalls(), 0);
});

test("register validates its identity before any frame and confirms the file on the remote", async () => {
	const catalog = { ensureRemoteSession: async () => ({ record: { id: "s1" }, created: true }) };
	const harness = scannerHarness({ tree: JSONL_TREE, catalog, projectIdForHost: () => "project-1" });
	// An empty stem is not a session file name: the last segment must be longer than ".jsonl", the same rule the
	// listing uses (isJsonlName). This was tightened after the first adversarial pass, so it is locked here.
	const invalidIds = ["", ".jsonl", "ws/.jsonl", "/abs/a.jsonl", "ws/../a.jsonl", "ws\\a.jsonl", "ws/a\u0000.jsonl", "ws/a.txt", "a".repeat(257) + ".jsonl", undefined, 7];
	for (const remoteSessionId of invalidIds) {
		const result = await harness.scanner.register({ hostId: HOST_ID, remoteSessionId });
		assert.equal(result.ok, false, JSON.stringify(remoteSessionId));
		assert.equal(result.code, "REMOTE_SESSION_ID_INVALID", JSON.stringify(remoteSessionId) + " answered " + result.code);
	}
	assert.equal(harness.remote.frames.length, 0, "an invalid identity must not put a frame on the wire");
	assert.equal(harness.sessionCalls(), 0);

	// A remote id that does not exist is refused with the reader's own code.
	const missing = await harness.scanner.register({ hostId: HOST_ID, remoteSessionId: "ws/gone.jsonl" });
	assert.equal(missing.code, "PATH_NOT_FOUND", "a missing remote file is relayed, not invented");

	const dirAsFile = scannerHarness({
		tree: { ".": remoteDirectory([{ name: "ws", kind: "directory" }]), ws: remoteDirectory([{ name: "dir.jsonl", kind: "directory" }]), "ws/dir.jsonl": remoteDirectory([]) },
		catalog,
		projectIdForHost: () => "project-1",
	});
	const refused = await dirAsFile.scanner.register({ hostId: HOST_ID, remoteSessionId: "ws/dir.jsonl" });
	assert.equal(refused.code, "NOT_A_FILE");
});

test("register fails closed without a catalog or a resolvable project", async () => {
	const noCatalog = scannerHarness({ tree: JSONL_TREE, projectIdForHost: () => "project-1" });
	const unavailable = await noCatalog.scanner.register({ hostId: HOST_ID, remoteSessionId: "ws/a.jsonl" });
	assert.equal(unavailable.code, "REMOTE_SESSION_CATALOG_UNAVAILABLE");
	assert.equal(noCatalog.sessionCalls(), 0, "nothing may be established without a place to record it");

	const noProject = scannerHarness({ tree: JSONL_TREE, catalog: { ensureRemoteSession: async () => ({ record: { id: "s1" }, created: true }) } });
	const unresolved = await noProject.scanner.register({ hostId: HOST_ID, remoteSessionId: "ws/a.jsonl" });
	assert.equal(unresolved.code, "REMOTE_SESSION_PROJECT_UNRESOLVED", "an unknown owner must not write a half record");
	assert.equal(noProject.sessionCalls(), 0);
});

/* Idempotency and stable-id matching against the real catalog. */

async function loadCatalog() {
	const catalogPath = join(BASE, "catalog-" + Math.random().toString(36).slice(2) + ".json");
	const catalog = new SessionCatalog(catalogPath);
	await catalog.load();
	return { catalog, catalogPath };
}

test("scanning twice writes nothing and registering twice keeps one stable id", async () => {
	const { catalog } = await loadCatalog();
	const harness = scannerHarness({ tree: JSONL_TREE, catalog, projectIdForHost: () => "project-1" });
	assert.equal((await harness.scanner.scan(HOST_ID)).ok, true);
	assert.equal((await harness.scanner.scan(HOST_ID)).ok, true);
	assert.equal(catalog.listEntries().length, 0, "a scan is read-only: only registration writes");

	const first = await harness.scanner.register({ hostId: HOST_ID, remoteSessionId: "ws/a.jsonl" });
	const second = await harness.scanner.register({ hostId: HOST_ID, remoteSessionId: "ws/a.jsonl" });
	assert.equal(first.ok, true, JSON.stringify(first));
	assert.equal(second.ok, true, JSON.stringify(second));
	assert.equal(first.created, true);
	assert.equal(second.created, false, "the second registration must not create a record");
	assert.equal(second.sessionId, first.sessionId, "the stable id must not move");
	assert.equal(catalog.listEntries().length, 1, "exactly one record exists after two registrations");
	const locator = catalog.getLocator(first.sessionId);
	assert.deepEqual(plain(locator), { kind: "ssh", hostId: HOST_ID, remoteSessionId: "ws/a.jsonl", remotePath: SESSION_ROOT + "/ws/a.jsonl" });
	assert.equal(catalog.get(first.sessionId).title, "a");
});

test("the two-pass match order picks the remoteSessionId hit over an earlier remotePath hit", () => {
	const earlierPathHit = { id: "old", locator: { kind: "ssh", hostId: HOST_ID, remotePath: "ws/a.jsonl" } };
	const laterIdHit = { id: "new", locator: { kind: "ssh", hostId: HOST_ID, remoteSessionId: "ws/a.jsonl", remotePath: "ws/old-name.jsonl" } };
	const identity = { hostId: HOST_ID, remoteSessionId: "ws/a.jsonl", remotePath: "ws/a.jsonl" };
	// A single-pass first-match would return the path-hit entry; the stable identity must come from the id hit.
	assert.equal(findRemoteSessionEntry([earlierPathHit, laterIdHit], identity), laterIdHit);
	assert.equal(findRemoteSessionEntry([laterIdHit, earlierPathHit], identity), laterIdHit);
	assert.equal(findRemoteSessionEntry([earlierPathHit], identity), earlierPathHit, "without an id hit the path hit is the fallback");
	assert.equal(findRemoteSessionEntry([], identity), undefined);

	assert.equal(remoteSessionLocatorMatch({ kind: "ssh", hostId: HOST_ID, remoteSessionId: "ws/a.jsonl", remotePath: "ws/other.jsonl" }, identity), "remoteSessionId");
	assert.equal(remoteSessionLocatorMatch({ kind: "ssh", hostId: HOST_ID, remotePath: "ws/a.jsonl" }, identity), "remotePath");
	assert.equal(remoteSessionLocatorMatch({ kind: "ssh", hostId: OTHER_HOST_ID, remoteSessionId: "ws/a.jsonl" }, identity), undefined, "another host is another session");
	assert.equal(remoteSessionLocatorMatch({ kind: "local", filePath: "/tmp/a.jsonl" }, identity), undefined);
	assert.equal(remoteSessionLocatorMatch(undefined, identity), undefined);
});

test("an identity that matches by the other field still resolves to the same record", async () => {
	const { catalog } = await loadCatalog();
	const base = { projectId: "project-1", hostId: HOST_ID, title: "a", updatedAt: 100 };
	const first = await catalog.ensureRemoteSession({ ...base, remoteSessionId: "ws/a.jsonl", remotePath: "ws/a.jsonl" });
	assert.equal(first.created, true);
	// The same file seen under a new id but the old path: the path match must reuse the record.
	const byPath = await catalog.ensureRemoteSession({ ...base, remoteSessionId: "ws/renamed.jsonl", remotePath: "ws/a.jsonl", updatedAt: 200 });
	assert.equal(byPath.created, false);
	assert.equal(byPath.record.id, first.record.id);
	assert.equal(catalog.listEntries().length, 1);
	// Then the new id wins: the move recorded under that id reuses the same record again.
	const byId = await catalog.ensureRemoteSession({ ...base, remoteSessionId: "ws/renamed.jsonl", remotePath: "ws/moved-again.jsonl", updatedAt: 300 });
	assert.equal(byId.created, false);
	assert.equal(byId.record.id, first.record.id);
	assert.equal(catalog.listEntries().length, 1, "no second stable id may appear");
	// The same identity on another host is a different session.
	const otherHost = await catalog.ensureRemoteSession({ ...base, hostId: OTHER_HOST_ID, remoteSessionId: "ws/a.jsonl", remotePath: "ws/a.jsonl" });
	assert.equal(otherHost.created, true);
	assert.notEqual(otherHost.record.id, first.record.id);
	assert.equal(catalog.listEntries().length, 2);
});

test("the scanner module cannot touch the local filesystem", () => {
	const source = readFileSync("src/main/sessions/RemoteSessionScanner.ts", "utf8");
	assert.ok(!source.includes('from "node:fs"') && !source.includes("from 'node:fs'"), "the scanner must not import node:fs");
	assert.ok(!/\brequire\s*\(/.test(source), "the scanner must not require anything");
	assert.ok(!/readFile|writeFile|statSync|readdirSync|existsSync/.test(source), "no local filesystem call may appear in the scanner");
	assert.ok(source.includes("withProjectSession"), "the only remote access is the controlled session boundary");
});
