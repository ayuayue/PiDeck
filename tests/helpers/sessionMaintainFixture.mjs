/**
 * Fixture plumbing for the frozen session-maintain artifact (src/main/remote/RemoteSessionMaintainSource.ts).
 *
 * The artifact ships as session-maintain.mjs inside the helper bundle, so it is loaded here exactly the way a
 * host deploy loads it: the frozen bytes are written to a temp file and `import()`ed. Everything else in this
 * module is the real temp tree a `maintain` call needs, plus the small vocabulary the tests assert with — a
 * revision read from disk, the stable error code the artifact throws, the names a rewrite must not leave
 * behind, and the local `SessionFileEditor` run that produces the bytes to compare against.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { loadTsCommonJs } from "./loadTsCommonJs.mjs";
import { mkdtempSync } from "./tempDir.mjs";

const artifact = loadTsCommonJs("src/main/remote/RemoteSessionMaintainSource.ts");
export const REMOTE_SESSION_MAINTAIN_FILE_NAME = artifact.REMOTE_SESSION_MAINTAIN_FILE_NAME;
export const REMOTE_SESSION_MAINTAIN_SOURCE = artifact.REMOTE_SESSION_MAINTAIN_SOURCE;
export const REMOTE_HELPER_SESSION_MAINTAIN_SHA256 = artifact.REMOTE_HELPER_SESSION_MAINTAIN_SHA256;

const ARTIFACT_DIRECTORY = mkdtempSync(path.join(tmpdir(), "pideck-maintain-artifact-"));
const artifactFile = path.join(ARTIFACT_DIRECTORY, REMOTE_SESSION_MAINTAIN_FILE_NAME);
fs.writeFileSync(artifactFile, REMOTE_SESSION_MAINTAIN_SOURCE);
export const createSessionMaintainScope = (await import(pathToFileURL(artifactFile).href)).createSessionMaintainScope;

/** The scope is anchored through /proc/self/fd; every behavioural test is Linux-only by construction. */
export const linuxOnly = { skip: process.platform !== "linux" ? "the session scope is anchored through /proc/self/fd" : false };

export const STAMP = "2026-01-01T00:00:00.000Z";
/** The local editor takes an injected clock; the artifact reads Date.now, so both sides use this value. */
export const FIXED_TS = 1_700_000_100_000;
export const LIMITS = { maxFileBytes: 8 * 1024 * 1024, maxLineBytes: 1024 * 1024, maxEntries: 5000, maxDraftBytes: 1024 * 1024 };
export const FILE_NAME = "x.jsonl";

export const USER_TARGET = { entryId: "u1", role: "user", text: "hello world" };
export const RESEND_TARGET = { entryId: "u2", role: "user", text: "again" };
export const ASSISTANT_TARGET = { entryId: "a3", role: "assistant", text: "second answer" };
export const EARLIER_ASSISTANT_TARGET = { entryId: "a1", role: "assistant", text: "first answer" };

export function sha256(bytes) {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** The revision shape the wire contract uses: mode/size as numbers, every other identity field as a decimal string. */
export function revisionOf(file) {
	const stats = fs.statSync(file, { bigint: true });
	return {
		mode: Number(stats.mode & 4095n),
		size: Number(stats.size),
		dev: String(stats.dev),
		ino: String(stats.ino),
		uid: String(stats.uid),
		gid: String(stats.gid),
		mtimeNs: String(stats.mtimeNs),
		ctimeNs: String(stats.ctimeNs),
		digest: sha256(fs.readFileSync(file)),
	};
}

/** A real pi session: a user turn, a visible answer, and one process run (thinking-only answer + toolResult). */
export function fixtureDocument() {
	const lines = [
		{ type: "session", id: "sess-1", timestamp: STAMP },
		{ type: "message", id: "u1", parentId: null, timestamp: STAMP, message: { role: "user", content: [{ type: "text", text: "hello world" }] } },
		{ type: "message", id: "a1", parentId: "u1", timestamp: STAMP, message: { role: "assistant", content: [{ type: "text", text: "first answer" }] } },
		{ type: "message", id: "a2", parentId: "a1", timestamp: STAMP, message: { role: "assistant", content: [{ type: "thinking", thinking: "plan the work" }] } },
		{ type: "message", id: "tr1", parentId: "a2", timestamp: STAMP, message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] } },
		{ type: "message", id: "a3", parentId: "tr1", timestamp: STAMP, message: { role: "assistant", content: [{ type: "text", text: "second answer" }] } },
		{
			type: "message",
			id: "u2",
			parentId: "a3",
			timestamp: STAMP,
			message: {
				role: "user",
				content: [
					{ type: "text", text: "again" },
					{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
					{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } },
				],
			},
		},
	];
	return `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

/** The same history with a second leaf: `b1` branches off `u1`, so the u2 / a3 / tr1 / a2 chain is no longer active. */
export function sideBranchDocument() {
	const extra = JSON.stringify({ type: "message", id: "b1", parentId: "u1", timestamp: STAMP, message: { role: "assistant", content: [{ type: "text", text: "side answer" }] } });
	return `${fixtureDocument()}${extra}\n`;
}

/** A real temp tree: an owner-controlled root, the session directory inside it, and one 0640 session file. */
export function createFixture(t, options = {}) {
	const base = fs.realpathSync(mkdtempSync(path.join(tmpdir(), "pideck-maintain-scope-")));
	t.after(() => fs.rmSync(base, { recursive: true, force: true }));
	const workspace = path.join(base, "ws");
	fs.mkdirSync(workspace, { mode: 0o750 });
	const file = path.join(workspace, FILE_NAME);
	fs.writeFileSync(file, options.document ?? fixtureDocument(), { mode: 0o640 });
	fs.chmodSync(file, 0o640);
	return { base, workspace, file, scope: createSessionMaintainScope(options.fs ?? fs, path, crypto) };
}

export function params(fixture, operation, overrides = {}) {
	const base = { path: fixture.file, operation, candidateIds: ["u1"], newText: "", allowedRoots: [fixture.base], limits: LIMITS };
	// `expected` is read from disk only when the caller did not supply one: the stale and missing-file cases
	// still have to be able to name a revision.
	if (Object.hasOwn(overrides, "expected") === false) base.expected = revisionOf(fixture.file);
	return { ...base, ...overrides };
}

export function run(fixture, operation, overrides = {}, deadlineAt = 0) {
	return fixture.scope.maintain(params(fixture, operation, overrides), deadlineAt);
}

/** Stable code assertions: the artifact throws `new Error(code)` so the helper's whitelist can relay it. */
export function codeOf(attempt) {
	try {
		attempt();
	} catch (error) {
		return error?.message ?? String(error);
	}
	throw new Error("EXPECTED_REJECTION");
}

/** Every name a rewrite must not leave behind: the temp is a hidden 32-hex sibling of the session file. */
export function leftovers(fixture) {
	return fs.readdirSync(fixture.workspace).filter((name) => name !== FILE_NAME);
}

export function entriesOf(bytes) {
	const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes;
	return text
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}

/** The targetId of every appended context_edit, in file order: the record order is part of the contract. */
export function contextEditTargets(bytes) {
	return entriesOf(bytes)
		.filter((entry) => entry.type === "context_edit")
		.map((entry) => entry.targetId);
}

/** UUID-shaped ids are generated per run, so the two runs of a parity pair cannot share them. */
export function normalizeGeneratedIds(bytes) {
	const names = new Map();
	const isGenerated = (id) => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
	const nameOf = (id) => {
		if (!names.has(id)) names.set(id, `generated-${names.size + 1}`);
		return names.get(id);
	};
	return entriesOf(bytes)
		.map((entry) => {
			if (isGenerated(entry.id)) entry.id = nameOf(entry.id);
			if (isGenerated(entry.originalEntryId)) entry.originalEntryId = nameOf(entry.originalEntryId);
			if (isGenerated(entry.parentId)) entry.parentId = nameOf(entry.parentId);
			return JSON.stringify(entry);
		})
		.join("\n");
}

export function withFrozenClock(attempt) {
	const original = Date.now;
	Date.now = () => FIXED_TS;
	try {
		return attempt();
	} finally {
		Date.now = original;
	}
}

const { SessionFileEditor } = loadTsCommonJs("src/main/pi/SessionFileEditor.ts");
let localSequence = 0;
const localUuid = () => `00000000-0000-4000-8000-${String(++localSequence).padStart(12, "0")}`;

/** The local editor over the same fixture, for byte-level comparison against one remote rewrite. */
export async function localMutation(t, document, operation, target, newText) {
	const directory = fs.realpathSync(mkdtempSync(path.join(tmpdir(), "pideck-maintain-local-")));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const localFile = path.join(directory, FILE_NAME);
	fs.writeFileSync(localFile, document);
	const editor = new SessionFileEditor({ now: () => FIXED_TS, randomUUID: localUuid });
	const fileRef = { protocolPath: localFile, hostPath: localFile, environment: "native" };
	const reload = async () => undefined;
	if (operation === "edit") await editor.editMessage({ file: fileRef, target, newText, reload });
	else if (operation === "delete") await editor.deleteMessage({ file: fileRef, target, reload });
	else await editor.truncateForResend({ file: fileRef, target, reload });
	return fs.readFileSync(localFile);
}
