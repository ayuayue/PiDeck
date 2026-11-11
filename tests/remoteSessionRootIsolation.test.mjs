import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/*
 * F4 independent verification of the remote session root (task-27, J2).
 *
 * Three things must stay true while a custom sessionDir is supported:
 * 1. the frozen helper protocol stays pinned - version, the digest of the exact uploaded bytes, and the
 *    operation vocabulary. The J2 freeze was taken at helper build 1.6.0; the merged dev-sync branch then
 *    advanced the helper deliberately through builds 1.7.0-1.21.2 (Git, terminal and config batches), so
 *    this pin tracks the current build: any byte change has to move the module's version/digest and the
 *    literals below in the same commit;
 * 2. the root stays derived from the remote home through the port, never from a local path, and a home that
 *    is not an absolute POSIX path still fails closed before any frame;
 * 3. every consumer (scan / title / register) agrees on that one root - including the configuration probe,
 *    which is an extra session on <home>/.pi/agent and must not become the root the work happens on.
 *
 * The custom-sessionDir half follows pi 1.0.4: <agentDir>/settings.json with agentDir = <home>/.pi/agent,
 * field "sessionDir" naming the directory directly (no cwd encoding).
 */

const { createRemoteSessionScanner, REMOTE_SESSION_ROOT_SUFFIX } = loadTsCommonJs("src/main/sessions/RemoteSessionScanner.ts");
const { REMOTE_HELPER_ENTRY_VERSION, REMOTE_HELPER_ENTRY_SHA256, REMOTE_HELPER_INLINE_SOURCE } = loadTsCommonJs("src/main/remote/RemoteHelperEntry.ts");

const HOST_ID = "6f1d2c3b-4a59-4e8d-9f70-1a2b3c4d5e6f";
const HOME = "/home/dev";
const CONTROL = String.fromCharCode(0);
/** Current frozen build (helper 1.28.0); it was 1.6.0 when the J2 feature was verified. */
const FROZEN_HELPER_SHA256 = "2ff269fb6b5ceb303b8b59a3292d3936abcdd2d665ae396dcbb83a7d1d41ff08";
const CONFIG_ROOT = HOME + "/.pi/agent";
const CONFIG_PATH = "settings.json";
const DEFAULT_ROOT = HOME + "/.pi/agent/sessions";
const SETTINGS_READ_CEILING = 65536;
/** The frozen helper's advertised vocabulary (build 1.28.0); the session-root code may use the fs batch only. */
const FROZEN_CAPABILITIES = [
	"echo",
	"fs.stat",
	"fs.statMany",
	"fs.list",
	"fs.read",
	"fs.searchNames",
	"fs.searchContent",
	"fs.watch",
	"fs.unwatch",
	"fs.uploadPrepare",
	"fs.uploadCommit",
	"fs.uploadAbort",
	"git.status",
	"git.workspaceDiff",
	"git.stage",
	"git.unstage",
	"git.commit",
	"git.log",
	"git.commitDetail",
	"git.refs",
	"git.refFileDiff",
	"git.compare",
	"git.createBranch",
	"git.switchBranch",
	"git.discard",
	"git.recoveryList",
	"git.recoveryRestore",
	"git.recoveryDrop",
	"git.syncFacts",
	"git.fetch",
	"git.push",
	"git.pull",
	"git.init",
	"git.repos",
	"git.checkIgnore",
	"terminal.prepare",
	"config.read",
	"config.patch",
	"config.readAuth",
];

test("the helper protocol is byte-for-byte the frozen 1.28.0 artifact", () => {
	assert.equal(REMOTE_HELPER_ENTRY_VERSION, "1.28.0", "the helper version must match the frozen artifact");
	assert.equal(REMOTE_HELPER_ENTRY_SHA256, FROZEN_HELPER_SHA256, "the declared digest must stay the frozen one");
	const recomputed = createHash("sha256").update(Buffer.from(REMOTE_HELPER_INLINE_SOURCE, "utf8")).digest("hex");
	assert.equal(recomputed, REMOTE_HELPER_ENTRY_SHA256, "the uploaded body must hash to the declared digest");
	assert.equal(recomputed, FROZEN_HELPER_SHA256, "the uploaded body must still be the frozen artifact");
});

test("the frozen helper body loads exactly three builtins and exposes exactly the frozen operations", () => {
	const body = REMOTE_HELPER_INLINE_SOURCE;
	const builtins = Array.from(body.matchAll(/getBuiltinModule\("([^"]+)"\)/g), (match) => match[1]).sort();
	// node:crypto arrived with the config scope the merged branch ships; the entry still loads no package.
	assert.deepEqual(builtins, ["node:crypto", "node:fs", "node:path"], "the body may load no fourth builtin");
	const capabilities = /const CAPABILITIES = \[([^\]]*)\]/.exec(body);
	assert.ok(capabilities !== null, "the capability list must stay declarative");
	assert.deepEqual(
		capabilities[1].split(",").map((part) => part.trim().replace(/^"|"$/g, "")),
		FROZEN_CAPABILITIES,
		"the advertised vocabulary is frozen; the session-root code resolves roots with the fs primitives only",
	);
	for (const method of Array.from(body.matchAll(/frame\.method === "([^"]+)"/g), (match) => match[1])) {
		assert.ok(["hello", "cancel", ...FROZEN_CAPABILITIES].includes(method), "unexpected protocol method " + method);
	}
});

/* The remote is a map keyed by "<established root>|<path>", because the configuration probe and the real
 * session are two different roots. */
function fileOf(text) {
	return { kind: "file", bytes: Buffer.from(text, "utf8") };
}

function directoryOf(entries) {
	return { kind: "directory", entries };
}

/** `options.home` is read with hasOwn so an explicitly undefined home is testable (it means "no home"). */
function remoteHarness(tree, options = {}) {
	const home = Object.hasOwn(options, "home") ? options.home : HOME;
	const frames = [];
	const roots = [];
	function makeSession(root) {
		return {
			async request(method, params) {
				frames.push({ root, method, params });
				if (method === "fs.statMany") {
					// One batch, request order, all-or-nothing — exactly the helper's rule.
					return {
						entries: params.paths.map((path) => {
							const described = tree[root + "|" + path];
							if (described === undefined) throw Object.assign(new Error("PATH_NOT_FOUND"), { code: "PATH_NOT_FOUND" });
							return described.kind === "directory" ? { path, kind: "directory", bytes: 0, mtimeMs: 1 } : { path, kind: "file", bytes: described.bytes.length, mtimeMs: 1 };
						}),
					};
				}
				const entry = tree[root + "|" + params.path];
				if (entry === undefined) throw Object.assign(new Error("PATH_NOT_FOUND"), { code: "PATH_NOT_FOUND" });
				if (method === "fs.stat") return entry.kind === "directory" ? { kind: "directory", bytes: 0, mtimeMs: 1 } : { kind: "file", bytes: entry.bytes.length, mtimeMs: 1 };
				if (method === "fs.list") {
					if (entry.kind !== "directory") throw Object.assign(new Error("NOT_A_DIRECTORY"), { code: "NOT_A_DIRECTORY" });
					return { entries: entry.entries.map((name) => ({ name, kind: "file", bytes: 10 })) };
				}
				if (method === "fs.read") {
					const bytes = entry.bytes;
					const length = Math.max(0, Math.min(params.bytes, bytes.length - params.offset));
					return { chunk: bytes.subarray(params.offset, params.offset + length).toString("base64"), bytes: length, eof: params.offset + length >= bytes.length };
				}
				throw Object.assign(new Error("METHOD_NOT_FOUND"), { code: "METHOD_NOT_FOUND" });
			},
			async cancel() {
				return { cancelled: true };
			},
		};
	}
	const port = {
		remoteHome: async () => home,
		async withProjectSession(hostId, root, task) {
			roots.push(root);
			return { ok: true, value: await task(makeSession(root)) };
		},
	};
	const catalog = {
		async ensureRemoteSession() {
			return { created: true, record: { id: "local-1" } };
		},
	};
	return { scanner: createRemoteSessionScanner({ port, catalog, projectIdForHost: () => "project-1" }), frames, roots };
}

/** A tree with no usable configuration: the settings path is absent and the default root is listable. */
function plainTree(settingsText) {
	const tree = {
		[CONFIG_ROOT + "|."]: directoryOf(["settings.json", "sessions"]),
		[DEFAULT_ROOT + "|."]: directoryOf(["ws"]),
		[DEFAULT_ROOT + "|ws/a.jsonl"]: fileOf('{"type":"session_info","name":"A"}\n'),
	};
	if (settingsText !== undefined) tree[CONFIG_ROOT + "|" + CONFIG_PATH] = fileOf(settingsText);
	return tree;
}

test("the default root is the frozen home suffix and every consumer works on it", async () => {
	assert.equal(REMOTE_SESSION_ROOT_SUFFIX, ".pi/agent/sessions", "the default layout is part of the contract");
	const harness = remoteHarness(plainTree());
	const results = [await harness.scanner.scan(HOST_ID), await harness.scanner.title({ hostId: HOST_ID, remoteSessionId: "ws/a.jsonl" }), await harness.scanner.register({ hostId: HOST_ID, remoteSessionId: "ws/a.jsonl" })];
	// Each call probes <home>/.pi/agent for settings and then works on the resolved root.
	assert.deepEqual(harness.roots, [CONFIG_ROOT, DEFAULT_ROOT, CONFIG_ROOT, DEFAULT_ROOT, CONFIG_ROOT, DEFAULT_ROOT], "one configuration probe plus one work session per call, in that order");
	for (const result of results) assert.equal(result.ok, true, JSON.stringify(result));
	assert.ok(harness.frames.length > 0, "the work happened over the port");
});

test("a remote home that is not an absolute POSIX path is refused before any frame", async () => {
	const badHomes = [
		["an empty home", ""],
		["a relative home", "home/dev"],
		["a Windows-shaped home", "C:\\Users\\dev"],
		["a home with a control byte", "/home/de" + CONTROL + "v"],
		["a numeric home", 42],
		["an undefined home", undefined],
	];
	for (const pair of badHomes) {
		const harness = remoteHarness(plainTree(), { home: pair[1] });
		for (const call of [() => harness.scanner.scan(HOST_ID), () => harness.scanner.title({ hostId: HOST_ID, remoteSessionId: "ws/a.jsonl" })]) {
			const result = await call();
			assert.equal(result.ok, false, pair[0] + " must be refused");
			assert.equal(result.code, "REMOTE_SESSION_HOME_UNAVAILABLE", pair[0] + " answered " + result.code);
		}
		assert.deepEqual(harness.roots, [], pair[0] + ": no session may be established for an unusable home");
		assert.deepEqual(harness.frames, [], pair[0] + ": nothing may reach the wire");
	}
});

test("a trailing separator on the remote home does not leak into the derived root", async () => {
	const harness = remoteHarness(plainTree(), { home: HOME + "/" });
	await harness.scanner.scan(HOST_ID);
	assert.ok(harness.roots.includes(DEFAULT_ROOT), "the root must be normalized to a single separator: " + JSON.stringify(harness.roots));
	assert.ok(!harness.roots.some((root) => root.includes("//")), "no doubled separator may survive normalization");
});

/* Remote paths must not reach the local filesystem. */

/** Comments quote pi's own source, so a substring check must look at code, not prose. */
function stripComments(source) {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("the session-root code cannot touch the local filesystem", () => {
	const files = ["src/main/sessions/RemoteSessionScanner.ts"];
	for (const name of readdirSync("src/main/sessions")) {
		const candidate = "src/main/sessions/" + name;
		if (candidate === files[0] || !name.endsWith(".ts")) continue;
		if (readFileSync(candidate, "utf8").includes("REMOTE_SESSION_ROOT_SUFFIX")) files.push(candidate);
	}
	for (const filePath of files) {
		const code = stripComments(readFileSync(filePath, "utf8"));
		assert.ok(!/from\s+"node:fs"/.test(code) && !/require\(\s*"node:fs"/.test(code), filePath + " must not import the local filesystem");
		assert.ok(!/from\s+"node:os"/.test(code), filePath + " must not read the local home directory");
		for (const forbidden of ["readFileSync", "existsSync", "readdirSync", "homedir(", "createReadStream"]) {
			assert.ok(!code.includes(forbidden), filePath + " must not call " + forbidden);
		}
	}
});

/*
 * Custom sessionDir: the configured value is used directly (pi does not encode a cwd under it), and only an
 * inside-the-home absolute POSIX path is accepted.
 */

const CUSTOM = HOME + "/team-sessions";

test("a configured sessionDir is really used as the session root", async () => {
	const tree = plainTree(JSON.stringify({ sessionDir: CUSTOM }));
	tree[CUSTOM + "|."] = directoryOf(["flat.jsonl"]);
	tree[CUSTOM + "|flat.jsonl"] = fileOf('{"type":"session_info","name":"Flat"}\n');
	const harness = remoteHarness(tree);
	const result = await harness.scanner.scan(HOST_ID);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.deepEqual(harness.roots, [CONFIG_ROOT, CUSTOM], "the configuration is probed once, then the work happens on the configured root");
});

test("a configured root applies to title and register too, with the identity still relative to it", async () => {
	const tree = plainTree(JSON.stringify({ sessionDir: CUSTOM }));
	tree[CUSTOM + "|flat.jsonl"] = fileOf('{"type":"session_info","name":"Flat Name"}\n');
	const harness = remoteHarness(tree);
	const title = await harness.scanner.title({ hostId: HOST_ID, remoteSessionId: "flat.jsonl" });
	assert.equal(title.ok, true, JSON.stringify(title));
	assert.equal(title.title, "Flat Name");
	const register = await harness.scanner.register({ hostId: HOST_ID, remoteSessionId: "flat.jsonl" });
	assert.equal(register.ok, true, JSON.stringify(register));
	assert.equal(register.remoteSessionId, "flat.jsonl", "the identity stays relative to the session root");
	assert.deepEqual(harness.roots, [CONFIG_ROOT, CUSTOM, CONFIG_ROOT, CUSTOM], "both calls resolve the configured root");
	const reads = harness.frames.filter((frame) => frame.method === "fs.read" && frame.params.path === "flat.jsonl");
	assert.ok(reads.length >= 1, "the helper must be asked for the relative path, not the absolute one");
	for (const frame of reads) assert.equal(frame.root, CUSTOM, "the relative path is resolved against the configured root");
});

test("a tilde sessionDir expands against the remote home", async () => {
	const expanded = HOME + "/.team/sessions";
	const tree = plainTree(JSON.stringify({ sessionDir: "~/.team/sessions/" }));
	tree[expanded + "|."] = directoryOf([]);
	const harness = remoteHarness(tree);
	await harness.scanner.scan(HOST_ID);
	assert.deepEqual(harness.roots, [CONFIG_ROOT, expanded], "~ must expand to the remote home and the trailing slash must go");
});

test("a relative or normalizable-in-place sessionDir is accepted the way pi resolves it", async () => {
	const dotted = HOME + "/team/nested";
	const tree = plainTree(JSON.stringify({ sessionDir: "~/team/./other/../nested" }));
	tree[dotted + "|."] = directoryOf([]);
	const harness = remoteHarness(tree);
	const result = await harness.scanner.scan(HOST_ID);
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.deepEqual(harness.roots, [CONFIG_ROOT, dotted], ". and .. segments normalize before the root is used");
});

test("a present but unusable sessionDir is refused with its own stable code", async () => {
	const cases = [
		["a relative value", "sessions-here"],
		["a whitespace-only value", "   "],
		["a control byte", "/srv/" + CONTROL + "sessions"],
		["an escape above the home", "../outside"],
		["an absolute escape out of home", "/srv/pi-sessions"],
		["an escape written with dot segments", "~/team/../../etc"],
		["a non-string value", 42],
		["an object value", { path: CUSTOM }],
	];
	for (const pair of cases) {
		const harness = remoteHarness(plainTree(JSON.stringify({ sessionDir: pair[1] })));
		const result = await harness.scanner.scan(HOST_ID);
		assert.equal(result.ok, false, pair[0] + " must be refused: " + JSON.stringify(result));
		assert.equal(result.code, "REMOTE_SESSION_SESSION_DIR_INVALID", pair[0] + " answered " + result.code);
		assert.deepEqual(harness.roots, [CONFIG_ROOT], pair[0] + ": the work must not start on an unusable root");
	}
});

test("an unusable settings file falls back to the default root instead of failing the scan", async () => {
	const cases = [
		["a missing configuration", undefined],
		["malformed JSON", "{not json"],
		["a non-object configuration", "[1,2,3]"],
		["a null configuration", "null"],
		["an empty sessionDir", JSON.stringify({ sessionDir: "" })],
		["a null sessionDir", JSON.stringify({ sessionDir: null })],
		["an oversized configuration", JSON.stringify({ sessionDir: CUSTOM, padding: "x".repeat(200 * 1024) })],
	];
	for (const pair of cases) {
		const harness = remoteHarness(plainTree(pair[1]));
		const result = await harness.scanner.scan(HOST_ID);
		assert.equal(result.ok, true, pair[0] + " must not fail the scan: " + JSON.stringify(result));
		assert.deepEqual(harness.roots, [CONFIG_ROOT, DEFAULT_ROOT], pair[0] + " must fall back to the default root");
	}
});

test("the configuration is read with the existing bounded primitives only", async () => {
	const tree = plainTree(JSON.stringify({ sessionDir: CUSTOM }));
	tree[CUSTOM + "|."] = directoryOf([]);
	const harness = remoteHarness(tree);
	await harness.scanner.scan(HOST_ID);
	const configReads = harness.frames.filter((frame) => frame.method === "fs.read" && frame.params.path === CONFIG_PATH);
	assert.equal(configReads.length, 1, "exactly one bounded read of the settings file");
	for (const frame of configReads) {
		assert.equal(frame.root, CONFIG_ROOT, "the probe reads settings.json under the agent directory");
		assert.ok(frame.params.bytes <= SETTINGS_READ_CEILING, "the read must stay inside the window ceiling: " + frame.params.bytes);
	}
	const probeStats = harness.frames.filter((frame) => frame.root === CONFIG_ROOT && frame.method === "fs.stat");
	assert.equal(probeStats.length, 1, "the probe sizes the settings file once");
	for (const frame of harness.frames) {
		assert.ok(["fs.stat", "fs.statMany", "fs.list", "fs.read", "fs.searchNames"].includes(frame.method), "unexpected helper method " + frame.method);
	}
});
