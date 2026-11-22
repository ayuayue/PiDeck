/**
 * Session-maintain scope: the in-place edit / delete / resend-truncate the remote helper runs on the host.
 *
 * The artifact under test is the frozen string that ships as session-maintain.mjs, so it is loaded here the way
 * a host deploy loads it (written to a temp file and `import()`ed, see helpers/sessionMaintainFixture.mjs) and
 * driven against a real temp tree with real session files. The judgement is not "looks like the local editor":
 * every mutation that changes history is also run through the real `SessionFileEditor` on the same fixture and
 * compared line by line, with only the values the two runs cannot share (random record ids, and the wall clock,
 * which the artifact reads from `Date.now`) held fixed or normalized away.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import {
	ASSISTANT_TARGET,
	contextEditTargets,
	EARLIER_ASSISTANT_TARGET,
	REMOTE_HELPER_SESSION_MAINTAIN_SHA256,
	REMOTE_SESSION_MAINTAIN_FILE_NAME,
	REMOTE_SESSION_MAINTAIN_SOURCE,
	RESEND_TARGET,
	createFixture,
	codeOf,
	entriesOf,
	fixtureDocument,
	leftovers,
	linuxOnly,
	localMutation,
	normalizeGeneratedIds,
	params,
	revisionOf,
	run,
	sha256,
	sideBranchDocument,
	withFrozenClock,
	LIMITS,
	FILE_NAME,
	STAMP,
	USER_TARGET,
} from "./helpers/sessionMaintainFixture.mjs";

const { extractResendContent } = loadTsCommonJs("src/main/pi/sessionReader/sessionMessageProjection.ts");

test("the frozen artifact is one file name and one reviewed digest", () => {
	assert.equal(REMOTE_SESSION_MAINTAIN_FILE_NAME, "session-maintain.mjs");
	assert.equal(sha256(Buffer.from(REMOTE_SESSION_MAINTAIN_SOURCE, "utf8")), REMOTE_HELPER_SESSION_MAINTAIN_SHA256);
	assert.equal(/^[0-9a-f]{64}$/.test(REMOTE_HELPER_SESSION_MAINTAIN_SHA256), true);
	// Standalone scroll: only the injected modules and the two globals a host node always has.
	assert.equal(/^"use strict";/u.test(REMOTE_SESSION_MAINTAIN_SOURCE), true);
	assert.equal(/\bimport\b/u.test(REMOTE_SESSION_MAINTAIN_SOURCE), false);
	assert.equal(/\brequire\s*\(/u.test(REMOTE_SESSION_MAINTAIN_SOURCE), false);
});

test("edit appends one context_edit, keeps every other line byte-identical and reports the published revision", linuxOnly, (t) => {
	const fixture = createFixture(t);
	const original = fs.readFileSync(fixture.file);
	const result = run(fixture, "edit", { candidateIds: ["u1"], newText: "edited text" });

	assert.equal(result.draft, null);
	const published = fs.readFileSync(fixture.file);
	const originalLines = original.toString("utf8").split("\n");
	const publishedLines = published.toString("utf8").split("\n");
	assert.deepEqual(publishedLines.slice(0, originalLines.length - 1), originalLines.slice(0, -1), "the history is not rewritten, the edit is appended");
	assert.equal(publishedLines.length, originalLines.length + 1);
	const appended = JSON.parse(publishedLines[originalLines.length - 1]);
	assert.deepEqual(Object.keys(appended), ["type", "id", "parentId", "timestamp", "targetId", "replacement"]);
	assert.equal(appended.type, "context_edit");
	assert.equal(appended.targetId, "u1");
	// The parent is the current leaf (u2), not the edited entry: an edit must extend the branch, not fork it.
	assert.equal(appended.parentId, "u2");
	assert.deepEqual(appended.replacement, { content: [{ type: "text", text: "edited text" }] });
	assert.equal(Number.isNaN(Date.parse(appended.timestamp)), false);

	// The returned revision describes what is on disk and keeps the caller's mode.
	const disk = revisionOf(fixture.file);
	assert.deepEqual(result.revision, disk);
	assert.equal(result.revision.mode, 0o640);
	assert.equal(result.revision.size, published.length);
	assert.deepEqual(leftovers(fixture), []);
});

test("edit writes the same bytes as the local SessionFileEditor", linuxOnly, async (t) => {
	const document = fixtureDocument();
	const fixture = createFixture(t, { document });
	withFrozenClock(() => run(fixture, "edit", { candidateIds: ["u1"], newText: "edited text" }));
	const expected = await localMutation(t, document, "edit", USER_TARGET, "edited text");
	assert.equal(normalizeGeneratedIds(fs.readFileSync(fixture.file)), normalizeGeneratedIds(expected));
});

test("delete appends replacement:null for the answer and its process chain (same bytes as local)", linuxOnly, async (t) => {
	const document = fixtureDocument();
	const fixture = createFixture(t, { document });
	withFrozenClock(() => run(fixture, "delete", { candidateIds: ["a3"] }));
	const expected = await localMutation(t, document, "delete", ASSISTANT_TARGET);
	assert.equal(normalizeGeneratedIds(fs.readFileSync(fixture.file)), normalizeGeneratedIds(expected));

	const entries = entriesOf(fs.readFileSync(fixture.file));
	const edits = entries.filter((entry) => entry.type === "context_edit");
	assert.deepEqual(contextEditTargets(fs.readFileSync(fixture.file)), ["a3", "tr1", "a2"], "the thinking-only answer and the toolResult serve the deleted answer and leave the context with it");
	for (const entry of edits) assert.equal(entry.replacement, null);
	// The chain is sequential, not parallel: a sibling parent would make every record but the last a side branch.
	assert.deepEqual(
		edits.map((entry) => entry.parentId),
		["u2", edits[0].id, edits[1].id],
	);
	assert.equal(entries.filter((entry) => entry.type === "deleted").length, 0, "delete appends context edits instead of tombstones");
});

test("deleting an answer with no process chain appends exactly one record (same bytes as local)", linuxOnly, async (t) => {
	const document = fixtureDocument();
	const fixture = createFixture(t, { document });
	withFrozenClock(() => run(fixture, "delete", { candidateIds: ["a1"] }));
	const expected = await localMutation(t, document, "delete", EARLIER_ASSISTANT_TARGET);
	assert.equal(normalizeGeneratedIds(fs.readFileSync(fixture.file)), normalizeGeneratedIds(expected));
	assert.deepEqual(contextEditTargets(fs.readFileSync(fixture.file)), ["a1"], "a2 is the next visible answer, not a process node of a1");
});

test("a corrupt parent chain terminates instead of looping", linuxOnly, (t) => {
	// The artifact deliberately does not validate the entry graph (that is the local scan's job), so the one walk
	// that could follow a cycle forever has to stop on its own rather than hang the helper.
	const looped = [
		JSON.stringify({ type: "session", id: "sess-1", timestamp: STAMP }),
		JSON.stringify({ type: "message", id: "tr1", parentId: "tr1", timestamp: STAMP, message: { role: "toolResult", content: [] } }),
		JSON.stringify({ type: "message", id: "a3", parentId: "tr1", timestamp: STAMP, message: { role: "assistant", content: [{ type: "text", text: "answer" }] } }),
	];
	const fixture = createFixture(t, { document: `${looped.join("\n")}\n` });
	run(fixture, "delete", { candidateIds: ["a3"] });
	assert.deepEqual(contextEditTargets(fs.readFileSync(fixture.file)), ["a3", "tr1"]);
});

test("resend tombstones the subtree, returns the draft and matches the local truncation byte for byte", linuxOnly, async (t) => {
	const document = fixtureDocument();
	const fixture = createFixture(t, { document });
	const result = withFrozenClock(() => run(fixture, "resend", { candidateIds: ["u2"] }));

	assert.deepEqual(result.draft, {
		text: "again",
		images: [
			{ mime: "image/png", dataBase64: "AAAA" },
			{ mime: "image/jpeg", dataBase64: "BBBB" },
		],
	});
	const expected = await localMutation(t, document, "resend", RESEND_TARGET);
	assert.equal(normalizeGeneratedIds(fs.readFileSync(fixture.file)), normalizeGeneratedIds(expected));

	const entries = entriesOf(fs.readFileSync(fixture.file));
	const tombstones = entries.filter((entry) => entry.type === "deleted");
	assert.deepEqual(
		tombstones.map((entry) => entry.id),
		["u2"],
		"u2 is the last entry, so only it leaves the branch",
	);
	assert.deepEqual(Object.keys(tombstones[0]), ["type", "id", "originalEntryId", "parentId", "ts", "reason"]);
	assert.equal(tombstones[0].reason, "resend-truncate");
	assert.equal(tombstones[0].originalEntryId, "u2");
	assert.equal(tombstones[0].parentId, "a3", "a tombstone keeps id and parentId, or pi's leaf walk breaks");
	assert.equal(entries.filter((entry) => entry.type === "context_edit").length, 0, "resend truncates, it does not edit the context");
	assert.equal(entries.find((entry) => entry.id === "a3").type, "message", "the untouched history keeps its records");
});

test("resend drafts the same text and images the local reader extracts", linuxOnly, (t) => {
	const content = [
		{ type: "text", text: "line one" },
		{ type: "image", source: { type: "base64", media_type: "image/webp", data: "ZZZZ" } },
		{ type: "text", text: "line two" },
		{ type: "image", mimeType: "image/gif", data: "YYYY" },
		{ type: "image", source: { type: "base64", media_type: "image/png" } },
	];
	const document = `${[JSON.stringify({ type: "session", id: "sess-1", timestamp: STAMP }), JSON.stringify({ type: "message", id: "u9", parentId: null, timestamp: STAMP, message: { role: "user", content } })].join("\n")}\n`;
	const fixture = createFixture(t, { document });
	const draft = run(fixture, "resend", { candidateIds: ["u9"] }).draft;
	const expected = extractResendContent(content);
	assert.equal(draft.text, expected.text);
	// The wire shape is `{ mime, dataBase64 }` while the content blocks keep the pi shape; the loaded local
	// reader returns objects from another realm, so the comparison is rebuilt in this one.
	assert.deepEqual(
		draft.images,
		Array.from(expected.images ?? [], (image) => ({ mime: image.mimeType, dataBase64: image.data })),
	);
	// An image block without data is dropped on both sides, and the surviving records keep the pi media type.
	assert.deepEqual(
		draft.images.map((image) => image.mime),
		["image/webp", "image/gif"],
	);
});

test("the returned revision is the next compare-and-swap token, so chained operations chain", linuxOnly, (t) => {
	const fixture = createFixture(t);
	const edited = run(fixture, "edit", { candidateIds: ["u1"], newText: "first edit" });
	const deleted = run(fixture, "delete", { candidateIds: ["a3"], expected: edited.revision });
	assert.deepEqual(deleted.revision, revisionOf(fixture.file));
	const entries = entriesOf(fs.readFileSync(fixture.file));
	assert.deepEqual(
		entries.filter((entry) => entry.type === "context_edit").map((entry) => entry.targetId),
		["u1", "a3", "tr1", "a2"],
	);
	// Replaying the first revision is a stale token: the file moved on.
	assert.equal(
		codeOf(() => run(fixture, "edit", { candidateIds: ["a1"], newText: "again", expected: edited.revision })),
		"SESSION_MAINTAIN_FILE_CHANGED",
	);
});

test("a stale revision is refused before anything is written and the file keeps the user's bytes", linuxOnly, (t) => {
	const fixture = createFixture(t);
	const stale = revisionOf(fixture.file);
	fs.writeFileSync(fixture.file, fixtureDocument().replace("first answer", "user typed this"), { mode: 0o640 });
	const current = fs.readFileSync(fixture.file);

	for (const overrides of [{ expected: stale }, { expected: { ...stale, digest: sha256(Buffer.from("something else")) } }, { expected: { ...stale, size: stale.size + 1 } }, { expected: { ...stale, mode: 0o600 } }]) {
		assert.equal(
			codeOf(() => run(fixture, "delete", { candidateIds: ["a3"], ...overrides })),
			"SESSION_MAINTAIN_FILE_CHANGED",
		);
		assert.deepEqual(fs.readFileSync(fixture.file), current);
		assert.deepEqual(leftovers(fixture), []);
	}
	// A file deleted after the read is the same refusal, and nothing is created in its place.
	fs.unlinkSync(fixture.file);
	assert.equal(
		codeOf(() => run(fixture, "delete", { candidateIds: ["a3"], expected: stale })),
		"SESSION_MAINTAIN_FILE_CHANGED",
	);
	assert.equal(fs.existsSync(fixture.file), false);
});

test("a file that changes while the copy is being prepared is refused before the rename", linuxOnly, (t) => {
	// The wrapper appends to the session file right after the temp has been written and synced, i.e. between
	// pass 2 and the pre-publish compare-and-swap: the published revision must catch it and never rename.
	const appender = Object.create(fs);
	appender.fchmodSync = (descriptor, mode) => {
		fs.fchmodSync(descriptor, mode);
		fs.appendFileSync(fixture.file, `${JSON.stringify({ type: "message", id: "late", parentId: "u2", timestamp: STAMP, message: { role: "user", content: [] } })}\n`);
	};
	const fixture = createFixture(t, { fs: appender });
	const result = codeOf(() => run(fixture, "edit", { candidateIds: ["u1"], newText: "edited" }));

	assert.equal(result, "SESSION_MAINTAIN_FILE_CHANGED");
	assert.equal(fs.readFileSync(fixture.file, "utf8").includes('"id":"late"'), true, "the concurrent write survives");
	assert.deepEqual(leftovers(fixture), [], "the temp is removed");
});

test("a publish whose published file does not match the temp is unconfirmed, never 'untouched'", linuxOnly, (t) => {
	// The rename is atomic, so the only way to reach the post-publish verification is the file being swapped:
	// report the identity of a different inode and the artifact must not claim the rename did not happen.
	const liar = Object.create(fs);
	liar.lstatSync = (target, options) => {
		const stats = fs.lstatSync(target, options);
		const forged = Object.create(stats);
		forged.ino = stats.ino + 1n;
		return forged;
	};
	const fixture = createFixture(t, { fs: liar });
	const result = codeOf(() => run(fixture, "edit", { candidateIds: ["u1"], newText: "edited" }));

	assert.equal(result, "SESSION_MAINTAIN_COMMIT_UNCONFIRMED");
	assert.equal(fs.readFileSync(fixture.file, "utf8").includes('"text":"edited"'), true, "the rename really happened");
	assert.deepEqual(leftovers(fixture), [], "an unconfirmed publish leaves no temp behind either");
});

test("the target must be on the active branch and not already tombstoned", linuxOnly, (t) => {
	const side = createFixture(t, { document: sideBranchDocument() });
	// b1 is the branch leaf, so the u2 / a3 / tr1 / a2 chain is a side branch now.
	for (const candidateIds of [["a3"], ["u2"], ["a3", "tr1"], ["missing"]]) {
		assert.equal(
			codeOf(() => run(side, "delete", { candidateIds })),
			"SESSION_MAINTAIN_MESSAGE_NOT_FOUND",
			candidateIds.join(","),
		);
		assert.deepEqual(leftovers(side), []);
	}
	// Hints are ordered most specific first: an off-branch id falls through to the next one.
	const falling = createFixture(t, { document: sideBranchDocument() });
	run(falling, "delete", { candidateIds: ["a3", "u1"] });
	assert.deepEqual(contextEditTargets(fs.readFileSync(falling.file)), ["u1"]);
	// A tombstone is not a target: after the resend, u2 is skipped and the next hint resolves.
	const fixture = createFixture(t);
	run(fixture, "resend", { candidateIds: ["u2"] });
	assert.equal(
		codeOf(() => run(fixture, "delete", { candidateIds: ["u2"] })),
		"SESSION_MAINTAIN_MESSAGE_NOT_FOUND",
	);
	run(fixture, "delete", { candidateIds: ["u2", "a3"] });
	assert.deepEqual(contextEditTargets(fs.readFileSync(fixture.file)), ["a3", "tr1", "a2"]);
});

test("role rules match the local chain: edit takes user/assistant, resend takes user only", linuxOnly, (t) => {
	const fixture = createFixture(t);
	const original = fs.readFileSync(fixture.file);
	// tr1 is a toolResult: editable by neither role rule.
	assert.equal(
		codeOf(() => run(fixture, "edit", { candidateIds: ["tr1"], newText: "x" })),
		"SESSION_MAINTAIN_ROLE_INVALID",
	);
	// Resend must be a user turn; an assistant answer would truncate the wrong side of the branch.
	assert.equal(
		codeOf(() => run(fixture, "resend", { candidateIds: ["a3"] })),
		"SESSION_MAINTAIN_ROLE_INVALID",
	);
	assert.equal(
		codeOf(() => run(fixture, "resend", { candidateIds: ["tr1"] })),
		"SESSION_MAINTAIN_ROLE_INVALID",
	);
	assert.deepEqual(fs.readFileSync(fixture.file), original);
	assert.deepEqual(leftovers(fixture), []);
	// Delete has no role rule: it takes the process nodes as well as the answers.
	assert.equal(typeof run(fixture, "delete", { candidateIds: ["tr1"] }).revision, "object");
});

test("file, line and entry bounds are refusals, never truncation", linuxOnly, (t) => {
	const fixture = createFixture(t);
	const original = fs.readFileSync(fixture.file);
	const size = original.length;
	for (const [overrides, label] of [
		[{ limits: { ...LIMITS, maxFileBytes: size - 1 } }, "file size"],
		[{ limits: { ...LIMITS, maxFileBytes: 1 } }, "file size with a tiny bound"],
		[{ limits: { ...LIMITS, maxLineBytes: 16 } }, "line size"],
		[{ limits: { ...LIMITS, maxEntries: 3 } }, "entry count"],
	]) {
		assert.equal(
			codeOf(() => run(fixture, "edit", { candidateIds: ["u1"], newText: "x", ...overrides })),
			"SESSION_MAINTAIN_FILE_TOO_LARGE",
			label,
		);
		assert.deepEqual(fs.readFileSync(fixture.file), original, label);
		assert.deepEqual(leftovers(fixture), [], label);
	}
	// Exactly at the bounds is legal: an off-by-one here would refuse a real session.
	assert.equal(typeof run(fixture, "edit", { candidateIds: ["u1"], newText: "", limits: { ...LIMITS, maxFileBytes: size, maxEntries: 7 } }).revision, "object");
});

test("allowedRoots containment is required; no root reaches nothing", linuxOnly, (t) => {
	const fixture = createFixture(t);
	const other = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "pideck-maintain-other-")));
	t.after(() => fs.rmSync(other, { recursive: true, force: true }));
	const original = fs.readFileSync(fixture.file);
	for (const allowedRoots of [[], [other], [path.join(fixture.base, "nested")], [other, "/definitely/not/here"]]) {
		assert.equal(
			codeOf(() => run(fixture, "edit", { candidateIds: ["u1"], newText: "x", allowedRoots })),
			"SESSION_MAINTAIN_PATH_INVALID",
			JSON.stringify(allowedRoots),
		);
		assert.deepEqual(fs.readFileSync(fixture.file), original);
	}
	// Equality with the root itself, and a root that needs its realpath resolved, both contain the file.
	assert.equal(typeof run(fixture, "edit", { candidateIds: ["u1"], newText: "", allowedRoots: [fixture.workspace, fixture.base] }).revision, "object");
	const link = path.join(fixture.base, "linked-root");
	fs.symlinkSync(fixture.base, link);
	assert.equal(typeof run(fixture, "edit", { candidateIds: ["u1"], newText: "", allowedRoots: [link] }).revision, "object");
});

test("a symlinked session file or a symlinked parent is refused, never followed", linuxOnly, (t) => {
	const fixture = createFixture(t);
	const original = fs.readFileSync(fixture.file);

	const linkFile = path.join(fixture.workspace, "link.jsonl");
	fs.symlinkSync(fixture.file, linkFile);
	assert.equal(
		codeOf(() => run(fixture, "edit", { candidateIds: ["u1"], newText: "x", path: linkFile })),
		"SESSION_MAINTAIN_PATH_INVALID",
	);
	assert.deepEqual(fs.readFileSync(fixture.file), original);

	// A link above the entry would make the anchored walk answer about another directory's file.
	const outside = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "pideck-maintain-outside-")));
	t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
	fs.writeFileSync(path.join(outside, FILE_NAME), original, { mode: 0o640 });
	fs.symlinkSync(outside, path.join(fixture.base, "escape"));
	assert.equal(
		codeOf(() => run(fixture, "edit", { candidateIds: ["u1"], newText: "x", path: path.join(fixture.base, "escape", FILE_NAME) })),
		"SESSION_MAINTAIN_PATH_INVALID",
	);
	assert.deepEqual(fs.readFileSync(path.join(outside, FILE_NAME)), original);

	// A directory named as the target is not a session file either.
	assert.equal(
		codeOf(() => run(fixture, "edit", { candidateIds: ["u1"], newText: "x", path: fixture.workspace })),
		"SESSION_MAINTAIN_PATH_INVALID",
	);
	assert.deepEqual(leftovers(fixture), ["link.jsonl"]);
});

test("a draft over the budget is refused before the publish and leaves the file untouched", linuxOnly, (t) => {
	const fixture = createFixture(t);
	const original = fs.readFileSync(fixture.file);
	assert.equal(
		codeOf(() => run(fixture, "resend", { candidateIds: ["u2"], limits: { ...LIMITS, maxDraftBytes: 3 } })),
		"SESSION_MAINTAIN_DRAFT_TOO_LARGE",
	);
	assert.deepEqual(fs.readFileSync(fixture.file), original);
	assert.deepEqual(leftovers(fixture), []);
	// The budget is a byte budget over text plus image payload, and it can be met.
	assert.equal(typeof run(fixture, "resend", { candidateIds: ["u2"], limits: { ...LIMITS, maxDraftBytes: 32 } }).draft.text, "string");
});

test("the deadline is honoured before the read and inside both passes", linuxOnly, (t) => {
	const fixture = createFixture(t);
	const original = fs.readFileSync(fixture.file);
	assert.equal(
		codeOf(() => run(fixture, "edit", { candidateIds: ["u1"], newText: "x" }, Date.now() - 1)),
		"REQUEST_TIMEOUT",
	);
	assert.deepEqual(fs.readFileSync(fixture.file), original);

	// A clock that only jumps once the temp exists stops pass 2 at its next chunk boundary: a rewrite that
	// cannot finish in time must not publish, and must not leave the temp behind.
	let createdTemp = false;
	const watcher = Object.create(fs);
	watcher.openSync = (target, flags, mode) => {
		if (typeof target === "string" && target.endsWith(".pideck-session")) createdTemp = true;
		return fs.openSync(target, flags, mode);
	};
	const slow = createFixture(t, { fs: watcher });
	const base = Date.now();
	const originalNow = Date.now;
	Date.now = () => (createdTemp ? base + 60_000 : base);
	try {
		assert.equal(
			codeOf(() => slow.scope.maintain(params(slow, "edit", { candidateIds: ["u1"], newText: "x" }), base + 1000)),
			"REQUEST_TIMEOUT",
		);
	} finally {
		Date.now = originalNow;
	}
	assert.deepEqual(fs.readFileSync(slow.file), original);
	assert.deepEqual(leftovers(slow), []);
});

test("the caller must own the file it is about to rename over", linuxOnly, (t) => {
	const fixture = createFixture(t);
	const original = fs.readFileSync(fixture.file);
	const expected = revisionOf(fixture.file);
	for (const forged of [
		{ ...expected, uid: String(Number(expected.uid) + 1) },
		{ ...expected, gid: String(Number(expected.gid) + 1) },
	]) {
		assert.equal(
			codeOf(() => run(fixture, "edit", { candidateIds: ["u1"], newText: "x", expected: forged })),
			"PERMISSION_DENIED",
		);
		assert.deepEqual(fs.readFileSync(fixture.file), original);
	}
	assert.deepEqual(leftovers(fixture), []);
});

test("malformed parameters are refused as input errors before the file is touched", linuxOnly, (t) => {
	const fixture = createFixture(t);
	const original = fs.readFileSync(fixture.file);
	const base = params(fixture, "edit", { candidateIds: ["u1"], newText: "x" });
	const inputCode = (overrides) => codeOf(() => fixture.scope.maintain({ ...base, ...overrides }, 0));

	for (const [label, overrides] of [
		["a missing key", { expected: undefined }],
		["an extra key", { extra: 1 }],
		["an unknown operation", { operation: "truncate" }],
		["a numeric operation", { operation: 1 }],
		["a non-string newText", { newText: null }],
		["an empty candidate list", { candidateIds: [] }],
		["more than three candidates", { candidateIds: ["a", "b", "c", "d"] }],
		["an empty candidate", { candidateIds: [""] }],
		["a numeric candidate", { candidateIds: [1] }],
		["more than four roots", { allowedRoots: ["/a", "/b", "/c", "/d", "/e"] }],
		["a non-array root list", { allowedRoots: "/root" }],
		["a fractional mode", { expected: { ...revisionOf(fixture.file), mode: 420.5 } }],
		["a mode past 4095", { expected: { ...revisionOf(fixture.file), mode: 4096 } }],
		["a negative size", { expected: { ...revisionOf(fixture.file), size: -1 } }],
		["an uppercase digest", { expected: { ...revisionOf(fixture.file), digest: "A".repeat(64) } }],
		["a numeric ino", { expected: { ...revisionOf(fixture.file), ino: 1 } }],
		["a hex dev", { expected: { ...revisionOf(fixture.file), dev: "0a" } }],
		["an over-long mtime", { expected: { ...revisionOf(fixture.file), mtimeNs: "1".repeat(41) } }],
		["a revision extra key", { expected: { ...revisionOf(fixture.file), extra: "1" } }],
		["a zero limit", { limits: { ...LIMITS, maxEntries: 0 } }],
		["a fractional limit", { limits: { ...LIMITS, maxDraftBytes: 1.5 } }],
		["a limit extra key", { limits: { ...LIMITS, maxOther: 1 } }],
		["a non-object", { limits: "limits" }],
	]) {
		assert.equal(inputCode(overrides), "SESSION_MAINTAIN_INPUT_INVALID", label);
	}
	for (const [label, overrides] of [
		["a relative path", { path: "ws/x.jsonl" }],
		["a non-canonical path", { path: `${fixture.workspace}//${FILE_NAME}` }],
		["a parent segment", { path: `${fixture.workspace}/../ws/${FILE_NAME}` }],
		["a trailing separator", { path: `${fixture.workspace}/` }],
		["a single quoted path", { path: `${fixture.workspace}/it's.jsonl` }],
		["a backslash path", { path: `${fixture.workspace}\\x.jsonl` }],
		["a control character", { path: `${fixture.workspace}/x\u0000.jsonl` }],
		["a relative root", { allowedRoots: ["ws"] }],
		["a root with a parent segment", { allowedRoots: ["/a/../b"] }],
	]) {
		assert.equal(inputCode(overrides), "SESSION_MAINTAIN_PATH_INVALID", label);
	}
	assert.equal(fixture.scope.maintain.length, 2, "the scope exposes maintain(params, deadlineAt)");
	assert.deepEqual(fs.readFileSync(fixture.file), original, "no refused input ever rewrites the session");
	assert.deepEqual(leftovers(fixture), []);
});

test("a non-negative deadline argument must be a safe integer", linuxOnly, (t) => {
	const fixture = createFixture(t);
	const original = fs.readFileSync(fixture.file);
	for (const deadlineAt of [-1, 1.5, "1", null]) {
		assert.equal(
			codeOf(() => fixture.scope.maintain(params(fixture, "edit", { candidateIds: ["u1"], newText: "x" }), deadlineAt)),
			"SESSION_MAINTAIN_INPUT_INVALID",
			String(deadlineAt),
		);
	}
	assert.deepEqual(fs.readFileSync(fixture.file), original);
});

test("a broken document is refused with the same inputs the local editor refuses", linuxOnly, (t) => {
	const cases = {
		empty: "",
		headerOnly: `${JSON.stringify({ type: "session", id: "sess-1", timestamp: STAMP })}\n`,
		twoHeaders: `${JSON.stringify({ type: "session", id: "sess-1", timestamp: STAMP })}\n${JSON.stringify({ type: "session", id: "sess-2", timestamp: STAMP })}\n`,
		noHeader: `${JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: STAMP, message: { role: "user", content: [] } })}\n`,
		invalidJson: `${JSON.stringify({ type: "session", id: "sess-1", timestamp: STAMP })}\nnot-json\n`,
		nonObject: `${JSON.stringify({ type: "session", id: "sess-1", timestamp: STAMP })}\n[1,2]\n`,
		duplicate: `${JSON.stringify({ type: "session", id: "sess-1", timestamp: STAMP })}\n${JSON.stringify({ type: "message", id: "x", parentId: null, timestamp: STAMP, message: { role: "user", content: [] } })}\n${JSON.stringify({ type: "message", id: "x", parentId: null, timestamp: STAMP, message: { role: "user", content: [] } })}\n`,
		invalidUtf8: Buffer.concat([Buffer.from(`${JSON.stringify({ type: "session", id: "sess-1", timestamp: STAMP })}\n{"type":"message","id":"x","message":{"role":"user","content":[{"type":"text","text":"", "x":"`, "utf8"), Buffer.from([0xff]), Buffer.from('"}]}}\n', "utf8")]),
	};
	for (const [label, document] of Object.entries(cases)) {
		const fixture = createFixture(t, { document });
		const code = codeOf(() => run(fixture, "edit", { candidateIds: ["u1"], newText: "x" }));
		// A well-formed file without a target, or with exactly one header and nothing to match, is not the same
		// refusal: only the structural failures are FILE_INVALID.
		assert.equal(code, label === "headerOnly" ? "SESSION_MAINTAIN_MESSAGE_NOT_FOUND" : "SESSION_MAINTAIN_FILE_INVALID", label);
		assert.deepEqual(typeof document === "string" ? fs.readFileSync(fixture.file, "utf8") : fs.readFileSync(fixture.file), typeof document === "string" ? document : document, label);
		assert.deepEqual(leftovers(fixture), [], label);
	}
});

test("a document mid-reload (a `_reloadMarker` header) is refused instead of being rewritten", linuxOnly, (t) => {
	const fixture = createFixture(t);
	const document = fixtureDocument().replace('"type":"session"', '"type":"session","_reloadMarker":"marker-1"');
	fs.writeFileSync(fixture.file, document, { mode: 0o640 });
	assert.equal(
		codeOf(() => run(fixture, "edit", { candidateIds: ["u1"], newText: "x" })),
		"SESSION_MAINTAIN_FILE_CHANGED",
	);
	assert.equal(fs.readFileSync(fixture.file, "utf8"), document);
	assert.deepEqual(leftovers(fixture), []);
});

test("CRLF records and a missing final newline survive the copy", linuxOnly, (t) => {
	const crlf = fixtureDocument().replaceAll("\n", "\r\n");
	const crlfFixture = createFixture(t, { document: crlf });
	withFrozenClock(() => run(crlfFixture, "edit", { candidateIds: ["u1"], newText: "edited" }));
	const crudeBytes = fs.readFileSync(crlfFixture.file, "utf8");
	assert.equal(crudeBytes.split("\r\n").length, crlf.split("\r\n").length + 1, "one record is appended with the file's own line ending");
	assert.equal(crudeBytes.replaceAll("\r\n", "").includes("\n"), false, "no bare LF is introduced");

	// A file whose last record has no newline must not have the new record glued onto it.
	const noEol = fixtureDocument().trimEnd();
	const noEolFixture = createFixture(t, { document: noEol });
	withFrozenClock(() => run(noEolFixture, "edit", { candidateIds: ["u1"], newText: "edited" }));
	const repaired = fs.readFileSync(noEolFixture.file, "utf8");
	assert.equal(repaired.startsWith(`${noEol}\n`), true, "the missing final newline is inserted before the new record");
	const appended = repaired.slice(noEol.length + 1);
	assert.equal(appended.endsWith("\n"), true);
	assert.equal(appended.trimEnd().includes("\n"), false, "one record, on its own line");
	assert.equal(JSON.parse(appended.trimEnd()).type, "context_edit");
});

test("performance shape: a large session is indexed, not loaded, and still rewrites correctly", linuxOnly, (t) => {
	const lines = [JSON.stringify({ type: "session", id: "sess-big", timestamp: STAMP })];
	let parentId = null;
	for (let index = 0; index < 1200; index += 1) {
		const id = `m${String(index).padStart(4, "0")}`;
		lines.push(JSON.stringify({ type: "message", id, parentId, timestamp: STAMP, message: { role: "user", content: [{ type: "text", text: `message-${index}` }] } }));
		parentId = id;
	}
	const document = `${lines.join("\n")}\n`;
	const fixture = createFixture(t, { document });
	const result = run(fixture, "delete", { candidateIds: ["m0600"] });
	assert.equal(result.draft, null);
	const entries = entriesOf(fs.readFileSync(fixture.file));
	assert.deepEqual(
		entries.filter((entry) => entry.type === "context_edit").map((entry) => entry.targetId),
		["m0600"],
	);
	// Every original record survives untouched and the new one is appended last.
	assert.equal(fs.readFileSync(fixture.file, "utf8").startsWith(document), true);
	assert.equal(entries.length, lines.length + 1);
	assert.deepEqual(leftovers(fixture), []);
});
