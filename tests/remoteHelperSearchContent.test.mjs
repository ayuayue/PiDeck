import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { materializeRemoteHelperArtifacts } from "./helpers/remoteHelperArtifacts.mjs";
import { fileSymlinkSkipReason } from "./helpers/symlinkSupport.mjs";

/*
 * Wire proof for bounded remote content search (fs.searchContent, helper build 1.26.1).
 *
 * The contract half pins the method, every ceiling and the result shape against the frozen sibling artifact; the
 * behaviour half drives the frozen bundle as a real child process with a real --root and the production
 * RemoteControlClient. Expectations are computed from the disk in this process, never read back out of an answer:
 * line/column/snippet are asserted against the fixture text, scannedFiles/scannedBytes against lstat sizes, and a
 * link outside the root must never appear in any frame. Cancellation is proven by withdrawing a running walk and
 * requiring exactly one REQUEST_CANCELLED terminal frame instead of a partial answer.
 */

const contract = loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");
const entry = loadTsCommonJs("src/main/remote/RemoteHelperEntry.ts");
const sibling = loadTsCommonJs("src/main/remote/RemoteSearchContentSource.ts");
const {
	REMOTE_HELPER_CAPABILITIES,
	REMOTE_HELPER_ERROR_CODES,
	REMOTE_HELPER_MAX_CONTENT_BINARY_PROBE_BYTES,
	REMOTE_HELPER_MAX_CONTENT_DEPTH,
	REMOTE_HELPER_MAX_CONTENT_FILE_BYTES,
	REMOTE_HELPER_MAX_CONTENT_MATCHES,
	REMOTE_HELPER_MAX_CONTENT_SCANNED_BYTES,
	REMOTE_HELPER_MAX_CONTENT_SCANNED_FILES,
	REMOTE_HELPER_MAX_CONTENT_SNIPPET_LENGTH,
	REMOTE_HELPER_MAX_CONTENT_TIME_MS,
	REMOTE_HELPER_METHOD_CANCEL,
	REMOTE_HELPER_METHOD_ECHO,
	REMOTE_HELPER_METHOD_FS_SEARCH_CONTENT,
	REMOTE_HELPER_PROTOCOL_VERSION,
} = contract;
const { createRemoteControlClient } = loadTsCommonJs("src/main/remote/RemoteControlClient.ts");

const HOST_ID = "6f1d2c3b-4a59-4e8d-9f70-1a2b3c4d5e6f";
const HELPER_HOME = "/home/pideck-content";
const REQUEST_TIMEOUT_MS = 20_000;
const GUARD_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 90_000;
const DECOY = "pideck-content-decoy-91b7";
const CONTRACT_SOURCE = "src/main/remote/RemoteHelperContract.ts";

const searchTest = (name, fn, timeoutMs = TEST_TIMEOUT_MS) => test(name, { timeout: timeoutMs }, fn);
const linkSearchTest = (name, fn, timeoutMs = TEST_TIMEOUT_MS) => test(name, { timeout: timeoutMs, skip: fileSymlinkSkipReason() }, fn);

const plain = (value) => JSON.parse(JSON.stringify(value));

function delay(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function guard(promise, label, timeoutMs = GUARD_TIMEOUT_MS) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timed out waiting for " + label)), timeoutMs);
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

async function rejection(promise, label) {
	try {
		await guard(promise, label);
	} catch (error) {
		return error;
	}
	throw new Error(label + " answered a result where a refusal was expected");
}

function frozenCapabilities() {
	const match = /const CAPABILITIES = \[([^\]]*)\]/.exec(entry.REMOTE_HELPER_INLINE_SOURCE);
	assert.ok(match, "the frozen body must declare its capability list");
	return match[1].split(",").map((part) => part.trim().replace(/^"|"$/g, ""));
}

function contractTypeFields(typeName) {
	const source = readFileSync(CONTRACT_SOURCE, "utf8");
	const match = new RegExp("export\\s+type\\s+" + typeName + "\\s*=\\s*\\{([\\s\\S]*?)\\};").exec(source);
	assert.ok(match, "RemoteHelperContract does not declare " + typeName);
	return Array.from(match[1].matchAll(/([A-Za-z][A-Za-z0-9]*)\??\s*:/g)).map((entry) => entry[1]);
}

const ENTRY_DIRECTORY = mkdtempSync(join(tmpdir(), "pideck-content-entry-"));
const ENTRY_PATH = join(ENTRY_DIRECTORY, entry.REMOTE_HELPER_ENTRY_FILE_NAME);
materializeRemoteHelperArtifacts(ENTRY_DIRECTORY);
after(() => rmSync(ENTRY_DIRECTORY, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

function tempDirectory(t, prefix) {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
	return directory;
}

function link(target, path, kind) {
	symlinkSync(target, path, process.platform === "win32" ? kind : kind === "junction" ? "dir" : undefined);
}

// 文件符号链接在无特权的 Windows 上不可用（EPERM）；需要链接的用例已用 linkSearchTest 跳过，
// fixture 里降级为不建文件链接，让 refusal 类用例仍能在这些机器上验证协议语义。
const fileSymlinksUsable = fileSymlinkSkipReason() === undefined;
function linkFile(target, path) {
	if (fileSymlinksUsable) link(target, path, "file");
}

function startHelper(t, options = {}) {
	const env = { ...process.env, HOME: HELPER_HOME };
	const rootArgs = options.root === null ? [] : ["--root", options.root === undefined ? tempDirectory(t, "pideck-content-root-") : options.root];
	const child = spawn(process.execPath, [ENTRY_PATH, ...rootArgs], { env, stdio: ["pipe", "pipe", "pipe"] });
	const sent = [];
	const lines = [];
	const frames = [];
	const diagnostics = [];
	const frameWaiters = new Set();
	let buffered = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdin.on("error", () => {});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const client = createRemoteControlClient({
		hostId: HOST_ID,
		send: (line) => {
			sent.push(line);
			child.stdin.write(line + "\n");
		},
		onDiagnostic: (entryValue) => {
			diagnostics.push(plain(entryValue));
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
				// A non-JSON stdout line stays in lines and fails the final "frames only" assertion.
			}
			client.handleLine(line);
			for (const waiter of [...frameWaiters]) waiter();
		}
	});
	t.after(() => {
		client.closeConnection();
		child.stdin.destroy();
		child.kill();
	});
	function waitForFrame(predicate, label, timeoutMs = GUARD_TIMEOUT_MS) {
		const found = frames.find(predicate);
		if (found !== undefined) return Promise.resolve(found);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				frameWaiters.delete(waiter);
				reject(new Error("timed out waiting for " + label));
			}, timeoutMs);
			const waiter = () => {
				const frame = frames.find(predicate);
				if (frame === undefined) return;
				clearTimeout(timer);
				frameWaiters.delete(waiter);
				resolve(frame);
			};
			frameWaiters.add(waiter);
		});
	}
	return {
		child,
		client,
		sent,
		lines,
		frames,
		diagnostics,
		root: rootArgs.length > 0 ? rootArgs[1] : null,
		stderr: () => stderr,
		requestIdAt(index) {
			const frame = JSON.parse(sent[index]);
			assert.ok(typeof frame.id === "string" && frame.id.length > 0, "no id in outbound frame " + index);
			return frame.id;
		},
		writeLine(text) {
			child.stdin.write(text + "\n");
		},
		waitForFrame,
	};
}

function contentRequestsOf(session) {
	return session.sent.map((line) => JSON.parse(line)).filter((frame) => frame.method === REMOTE_HELPER_METHOD_FS_SEARCH_CONTENT);
}

async function searchContent(session, params) {
	return plain(await guard(session.client.request(REMOTE_HELPER_METHOD_FS_SEARCH_CONTENT, params, { timeoutMs: REQUEST_TIMEOUT_MS }), "fs.searchContent"));
}

/* ── contract / frozen-artifact parity ─────────────────────────────────────────────────────────── */

searchTest("the contract, the entry and the frozen sibling declare the same op and every ceiling", () => {
	assert.equal(REMOTE_HELPER_METHOD_FS_SEARCH_CONTENT, "fs.searchContent");
	assert.ok(REMOTE_HELPER_CAPABILITIES.includes("fs.searchContent"), "the capability must be advertised");
	assert.deepEqual(Array.from(REMOTE_HELPER_CAPABILITIES), frozenCapabilities(), "contract and frozen hello capabilities are one list");
	const source = sibling.REMOTE_SEARCH_CONTENT_SOURCE;
	for (const literal of [
		"const MAX_MATCHES = " + REMOTE_HELPER_MAX_CONTENT_MATCHES + ";",
		"const MAX_SCANNED_FILES = " + REMOTE_HELPER_MAX_CONTENT_SCANNED_FILES + ";",
		"const MAX_SCANNED_BYTES = " + REMOTE_HELPER_MAX_CONTENT_SCANNED_BYTES + ";",
		"const MAX_FILE_BYTES = " + REMOTE_HELPER_MAX_CONTENT_FILE_BYTES + ";",
		"const MAX_BINARY_PROBE = " + REMOTE_HELPER_MAX_CONTENT_BINARY_PROBE_BYTES + ";",
		"const MAX_SNIPPET = " + REMOTE_HELPER_MAX_CONTENT_SNIPPET_LENGTH + ";",
		"const MAX_DEPTH = " + REMOTE_HELPER_MAX_CONTENT_DEPTH + ";",
		"const MAX_TIME = " + REMOTE_HELPER_MAX_CONTENT_TIME_MS + ";",
	])
		assert.ok(source.includes(literal), literal + " must be a literal of the frozen sibling");
	for (const reason of ["matches", "files", "bytes", "time", "depth", "file-size"]) assert.ok(source.includes('"' + reason + '"'), reason + " must be a reason the frozen sibling can report");
	assert.ok(source.includes("new Set([" + contract.REMOTE_HELPER_CONTENT_SKIPPED_DIRECTORIES.map((name) => '"' + name + '"').join(", ") + "])"), "the frozen sibling skips exactly the contract's fixed directories");
	assert.ok(source.includes('new TextDecoder("utf-8", { fatal: true })'), "the frozen sibling decodes UTF-8 strictly");
	assert.ok(source.includes("O_NOFOLLOW"), "the frozen sibling opens with O_NOFOLLOW");
	assert.ok(source.includes("indexOf(0) >= 0"), "the frozen sibling skips a file whose probe contains NUL");
	// The entry dispatches the method, imports the sibling and advertises the capability.
	assert.ok(entry.REMOTE_HELPER_INLINE_SOURCE.includes('"' + REMOTE_HELPER_METHOD_FS_SEARCH_CONTENT + '"'), "the entry must dispatch fs.searchContent");
	assert.ok(entry.REMOTE_HELPER_INLINE_SOURCE.includes('from"./search-content.mjs"'), "the entry imports the frozen sibling");
	assert.equal(entry.REMOTE_HELPER_INLINE_SOURCE.split('"fs.searchContent"').length - 1, 2, "one capability declaration and one dispatch arm");
	// A result field that is not in the contract is not part of the wire.
	assert.deepEqual(contractTypeFields("RemoteHelperSearchContentParams").sort(), ["maxMatches", "path", "query"]);
	assert.deepEqual(contractTypeFields("RemoteHelperSearchContentMatch").sort(), ["column", "line", "name", "path", "snippet"]);
	assert.deepEqual(contractTypeFields("RemoteHelperSearchContentResult").sort(), ["matchedFiles", "matches", "reason", "scannedBytes", "scannedFiles", "truncated"]);
});

searchTest("the content-search artifact is one byte-frozen ASCII line with its own pin", () => {
	const source = sibling.REMOTE_SEARCH_CONTENT_SOURCE;
	const digest = createHash("sha256").update(source, "utf8").digest("hex");
	assert.equal(digest, sibling.REMOTE_HELPER_SEARCH_CONTENT_SHA256, "search-content.mjs changed without updating its pin");
	assert.equal(Buffer.byteLength(source, "utf8"), source.length, "frozen content search stays printable ASCII");
	assert.ok(!/[\r\n]/.test(source), "frozen content search is one line");
	assert.ok(!/[\u0000-\u001f\u007f]/.test(source), "no control byte may reach the helper command");
	assert.ok(!source.includes("console."), "stdout carries protocol frames only");
	assert.ok(!/\b(?:eval|Function)\s*\(/.test(source), "no evaluated code");
	assert.ok(!source.includes("require("), "the artifact needs nothing but its parameters and stdlib globals");
	assert.ok(source.length > 1024 && source.length < 96 * 1024, "unexpected artifact size " + source.length);
});

searchTest("the entry pins the sibling, the bundle list and helper build 1.26.1", () => {
	assert.equal(entry.REMOTE_HELPER_ENTRY_VERSION, "1.26.1");
	assert.ok(entry.REMOTE_HELPER_INLINE_SOURCE.includes('"1.26.1"'), "hello must report the new build");
	assert.equal(entry.REMOTE_HELPER_ENTRY_SHA256, createHash("sha256").update(entry.REMOTE_HELPER_INLINE_SOURCE, "utf8").digest("hex"));
	assert.deepEqual(
		Array.from(entry.REMOTE_HELPER_ARTIFACTS, (artifact) => artifact.name),
		["helper.mjs", "git-read.mjs", "git-write.mjs", "git-sync.mjs", "config.mjs", "search-content.mjs", "upload-commit.mjs", "terminal-runner.mjs"],
	);
	const packed = entry.REMOTE_HELPER_ARTIFACTS.find((artifact) => artifact.name === "search-content.mjs");
	assert.equal(packed.sha256, sibling.REMOTE_HELPER_SEARCH_CONTENT_SHA256);
	assert.equal(packed.source, sibling.REMOTE_SEARCH_CONTENT_SOURCE);
});

/* ── real child process: semantics ─────────────────────────────────────────────────────────────── */

function createContentFixture(t) {
	const base = tempDirectory(t, "pideck-content-fixture-");
	const root = join(base, "root");
	const outside = join(base, "outside");
	mkdirSync(join(root, "sub"), { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(root, "alpha.txt"), "Alpha line\nneedle here\n");
	writeFileSync(join(root, "mixed.txt"), "Mixed NEEDLE case\n");
	writeFileSync(join(root, "sub", "beta.md"), "first\r\nNEEDLE second\r\n");
	writeFileSync(join(root, "bin.dat"), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x0a]));
	writeFileSync(join(root, "latin1.txt"), Buffer.concat([Buffer.from([0xff]), Buffer.from("needle\n")]));
	writeFileSync(join(root, "empty.txt"), "");
	writeFileSync(join(outside, "secret.txt"), DECOY + " needle\n");
	// Fixed directories are skipped by name: their contents are not project text sources.
	for (const skipped of contract.REMOTE_HELPER_CONTENT_SKIPPED_DIRECTORIES) {
		mkdirSync(join(root, skipped), { recursive: true });
		writeFileSync(join(root, skipped, "hidden.txt"), DECOY + " needle\n");
	}
	linkFile(join(root, "alpha.txt"), join(root, "link-to-alpha"));
	link(outside, join(root, "outside-link"), "junction");
	return { base, root, outside };
}

linkSearchTest("searchContent matches lines case-insensitively, skips binary/UTF-8/link entries and never leaves the root", async (t) => {
	const fixture = createContentFixture(t);
	const session = startHelper(t, { root: fixture.root });
	const hello = plain(await guard(session.client.request("hello"), "hello"));
	assert.equal(hello.helperVersion, "1.26.1");
	assert.ok(hello.capabilities.includes(REMOTE_HELPER_METHOD_FS_SEARCH_CONTENT), "hello must advertise the content search");

	const answer = await searchContent(session, { path: ".", query: "needle" });
	assert.deepEqual(Object.keys(answer).sort(), ["matchedFiles", "matches", "scannedBytes", "scannedFiles", "truncated"]);
	assert.equal(answer.truncated, false);
	assert.equal(answer.reason, undefined);
	assert.equal(answer.matchedFiles, 3);
	// Exactly the text files, with disk-computed line/column/snippet.
	assert.deepEqual(answer.matches, [
		{ path: "alpha.txt", name: "alpha.txt", line: 2, column: 0, snippet: "needle here" },
		{ path: "mixed.txt", name: "mixed.txt", line: 1, column: 6, snippet: "NEEDLE case" },
		{ path: "sub/beta.md", name: "beta.md", line: 2, column: 0, snippet: "NEEDLE second" },
	]);
	// Every regular file below the root had its bytes read once; links (file and directory) were never read.
	const sizes = ["alpha.txt", "bin.dat", "empty.txt", "latin1.txt", "mixed.txt", "sub/beta.md"].map((relative) => lstatSync(join(fixture.root, ...relative.split("/"))).size);
	assert.equal(answer.scannedFiles, sizes.length);
	assert.equal(
		answer.scannedBytes,
		sizes.reduce((total, size) => total + size, 0),
	);
	for (const match of answer.matches) {
		assert.ok(match.snippet.length <= REMOTE_HELPER_MAX_CONTENT_SNIPPET_LENGTH, "a snippet stays inside its ceiling");
		assert.equal(Object.keys(match).sort().join(","), "column,line,name,path,snippet");
	}
	const request = contentRequestsOf(session)[0];
	assert.equal(request.v, REMOTE_HELPER_PROTOCOL_VERSION);
	assert.equal(request.hostId, HOST_ID);
	assert.deepEqual(Object.keys(request.params), ["path", "query"]);
	for (const match of answer.matches)
		assert.equal(
			contract.REMOTE_HELPER_CONTENT_SKIPPED_DIRECTORIES.some((name) => match.path === name || match.path.startsWith(name + "/")),
			false,
			"a skipped directory never contributes a match",
		);
	for (const text of [session.lines.join("\n"), session.stderr(), JSON.stringify(session.diagnostics)]) assert.equal(text.includes(DECOY), false, "the decoy outside the root and the skipped directories must never be read");
	assert.deepEqual(session.diagnostics, []);
	assert.equal(session.lines.length, session.frames.length, "every stdout line is a protocol frame");
});

searchTest("the match ceiling answers a deterministic prefix and says so", async (t) => {
	const root = tempDirectory(t, "pideck-content-wide-");
	for (let index = 0; index < REMOTE_HELPER_MAX_CONTENT_MATCHES + 25; index += 1) writeFileSync(join(root, "match-" + String(index).padStart(4, "0") + ".txt"), "needle line\n");
	const session = startHelper(t, { root });
	const answer = await searchContent(session, { path: ".", query: "needle" });
	assert.equal(answer.matches.length, REMOTE_HELPER_MAX_CONTENT_MATCHES);
	assert.equal(answer.matchedFiles, REMOTE_HELPER_MAX_CONTENT_MATCHES);
	assert.equal(answer.truncated, true);
	assert.equal(answer.reason, "matches");
	assert.deepEqual(
		answer.matches.map((match) => match.path),
		Array.from({ length: REMOTE_HELPER_MAX_CONTENT_MATCHES }, (_value, index) => "match-" + String(index).padStart(4, "0") + ".txt"),
		"a truncated answer is a deterministic name-order prefix",
	);
	// maxMatches is clamped on the helper side: a small value truncates earlier, 0 becomes 1.
	const small = await searchContent(session, { path: ".", query: "needle", maxMatches: 3 });
	assert.equal(small.matches.length, 3);
	assert.equal(small.truncated, true);
	assert.equal(small.reason, "matches");
	const zero = await searchContent(session, { path: ".", query: "needle", maxMatches: 0 });
	assert.equal(zero.matches.length, 1);
	assert.equal(zero.truncated, true);
});

searchTest("an oversized file is skipped without reading and the answer says why", async (t) => {
	const root = tempDirectory(t, "pideck-content-large-");
	writeFileSync(join(root, "aaa-large.txt"), "needle\n" + "x".repeat(REMOTE_HELPER_MAX_CONTENT_FILE_BYTES));
	writeFileSync(join(root, "zzz-small.txt"), "needle\n");
	const session = startHelper(t, { root });
	const answer = await searchContent(session, { path: ".", query: "needle" });
	assert.deepEqual(
		answer.matches.map((match) => match.path),
		["zzz-small.txt"],
		"the oversized file was never searched",
	);
	assert.equal(answer.truncated, true);
	assert.equal(answer.reason, "file-size");
	// Its bytes were never read: the budget only counts the small file.
	assert.equal(answer.scannedBytes, lstatSync(join(root, "zzz-small.txt")).size);
});

searchTest("a target that is not a directory, an escaping path and a bad query are refused before any walk", async (t) => {
	const fixture = createContentFixture(t);
	const session = startHelper(t, { root: fixture.root });
	const cases = [
		[{ path: "alpha.txt", query: "needle" }, "NOT_A_DIRECTORY"],
		[{ path: "../outside", query: "needle" }, "PATH_OUTSIDE_ROOT"],
		[{ path: "/etc", query: "needle" }, "PATH_OUTSIDE_ROOT"],
		[{ path: ".", query: "" }, "QUERY_INVALID"],
		[{ path: ".", query: "needle\u0000" }, "QUERY_INVALID"],
		[{ path: ".", query: "x".repeat(129) }, "QUERY_INVALID"],
	];
	for (const [params, code] of cases) {
		const error = await rejection(session.client.request(REMOTE_HELPER_METHOD_FS_SEARCH_CONTENT, params, { timeoutMs: REQUEST_TIMEOUT_MS }), JSON.stringify(params));
		assert.equal(error.code, code, JSON.stringify(params));
	}
	assert.ok(REMOTE_HELPER_ERROR_CODES.includes("QUERY_INVALID"));
	assert.equal(session.frames.filter((frame) => frame.ok === true).length, 0, "none of the refused calls answered a result");
});

searchTest("a host-only helper refuses content search like every other fs method", async (t) => {
	const session = startHelper(t, { root: null });
	const hello = plain(await guard(session.client.request("hello"), "hello"));
	assert.equal(hello.root, null);
	assert.ok(hello.capabilities.includes(REMOTE_HELPER_METHOD_FS_SEARCH_CONTENT), "the capability is advertised even when no root is set");
	const error = await rejection(session.client.request(REMOTE_HELPER_METHOD_FS_SEARCH_CONTENT, { path: ".", query: "needle" }, { timeoutMs: REQUEST_TIMEOUT_MS }), "a host-only content search");
	assert.equal(error.code, "PATH_OUTSIDE_ROOT");
});

/** Wide enough that the walk spans many slices: 40 directories x 64 files of real text. */
function createSlowContentFixture(t) {
	const root = tempDirectory(t, "pideck-content-slow-");
	for (let directory = 0; directory < 40; directory += 1) {
		const nested = join(root, "dir-" + String(directory).padStart(2, "0"));
		mkdirSync(nested, { recursive: true });
		for (let file = 0; file < 64; file += 1) writeFileSync(join(nested, "match-" + String(file).padStart(3, "0") + ".txt"), "needle line number " + file + "\n" + "padding ".repeat(40) + "\n");
	}
	return root;
}

searchTest("a running content search is cancelled at an entry boundary and never answers a partial result", async (t) => {
	const root = createSlowContentFixture(t);
	const session = startHelper(t, { root });
	const pending = session.client.request(REMOTE_HELPER_METHOD_FS_SEARCH_CONTENT, { path: ".", query: "needle" });
	const outcome = rejection(pending, "the aborted content search");
	const requestId = session.requestIdAt(session.sent.length - 1);
	assert.equal(session.frames.filter((frame) => frame.id === requestId).length, 0, "the walk spans many slices, so nothing settled yet");
	const withdrawn = plain(await guard(session.client.cancel(requestId), "cancel of a running content search"));
	assert.deepEqual(withdrawn, { cancelled: true });
	const error = await outcome;
	assert.equal(error.code, "REQUEST_CANCELLED");
	assert.equal(error.retryable, false);
	const terminal = await guard(
		session.waitForFrame((frame) => frame.id === requestId, "the aborted walk's terminal frame"),
		"the aborted walk's terminal frame",
	);
	assert.equal(terminal.ok, false);
	assert.equal(terminal.error.code, "REQUEST_CANCELLED");
	for (const frame of session.frames) assert.equal(frame.id === requestId && frame.ok === true, false, "a cancelled search may not answer a result, partial or not");
	assert.equal(session.frames.filter((frame) => frame.id === requestId).length, 1, "exactly one terminal frame");
	// The slot is free again: four zero-delay echoes all answer.
	await Promise.all(Array.from({ length: 4 }, (_value, index) => guard(session.client.request(REMOTE_HELPER_METHOD_ECHO, { text: "after-" + index }), "echo after the abort " + index)));
	assert.equal(session.sent.map((line) => JSON.parse(line)).filter((frame) => frame.method === REMOTE_HELPER_METHOD_CANCEL).length, 1, "the withdraw was written exactly once");
});
