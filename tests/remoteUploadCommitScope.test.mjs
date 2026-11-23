/**
 * Upload-commit scope: the compare-and-swap `policy: "replace"` transaction next to the create-only one.
 *
 * The artifact under test is the frozen string that ships as upload-commit.mjs, and it is exercised here
 * against a real temp tree: a project root, the helper-owned `upload-spool` beside it, and real files. The
 * spool file is written by the caller (the SFTP side), exactly like on a host, so every assertion is about
 * what the helper itself publishes and what it refuses to touch.
 */
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { REMOTE_UPLOAD_COMMIT_FILE_NAME, REMOTE_UPLOAD_COMMIT_SOURCE } = loadTsCommonJs("src/main/remote/RemoteUploadCommitSource.ts");

// The artifact is deployed as its own ES module, so the test loads the exact frozen bytes that way too.
const ARTIFACT_DIRECTORY = fs.mkdtempSync(path.join(tmpdir(), "pideck-upload-artifact-"));
after(() => fs.rmSync(ARTIFACT_DIRECTORY, { recursive: true, force: true }));
const artifactFile = path.join(ARTIFACT_DIRECTORY, REMOTE_UPLOAD_COMMIT_FILE_NAME);
fs.writeFileSync(artifactFile, REMOTE_UPLOAD_COMMIT_SOURCE);
const { createUploadCommitScope } = await import(pathToFileURL(artifactFile).href);

const linuxOnly = { skip: process.platform !== "linux" ? "the upload scope is anchored through /proc/self/fd" : false };
const IDENTITY = { hostId: "3f2a1c40-0000-4000-8000-000000000001", generation: 7 };
const TARGET = "sub/notes.txt";

function sha256(bytes) {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** The revision shape the wire contract uses: mode/size as numbers, every other identity field as a decimal string. */
function revisionOf(file) {
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

function newUploadId() {
	return crypto.randomBytes(16).toString("hex");
}

function createFixture(t) {
	const base = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "pideck-upload-scope-")));
	t.after(() => fs.rmSync(base, { recursive: true, force: true }));
	const deployRoot = path.join(base, "deploy");
	const root = path.join(base, "root");
	fs.mkdirSync(deployRoot, { mode: 0o700 });
	fs.mkdirSync(root, { mode: 0o755 });
	fs.mkdirSync(path.join(root, "sub"), { mode: 0o755 });
	const scope = createUploadCommitScope(root, deployRoot, fs, path, crypto);
	t.after(() => scope.close());
	assert.equal(scope.supported(), true, "the scope must be usable on this platform");
	return { base, deployRoot, root, scope, uploadId: "" };
}

/** The SFTP executor's half: it can only write `<deployRoot>/upload-spool/<uploadId>.part`. */
function stage(fixture, bytes) {
	fs.mkdirSync(path.join(fixture.deployRoot, "upload-spool"), { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(fixture.deployRoot, "upload-spool", fixture.uploadId + ".part"), bytes, { mode: 0o600 });
}

/** Every name a transaction must not leave behind: the spool file and the sibling temp. */
function leftovers(fixture) {
	const spoolDirectory = path.join(fixture.deployRoot, "upload-spool");
	const spool = fs.existsSync(spoolDirectory) ? fs.readdirSync(spoolDirectory) : [];
	const temp = fs.readdirSync(path.join(fixture.root, "sub")).filter((name) => /^\.[0-9a-f]{32}\.pideck-put$/.test(name));
	return [...spool, ...temp];
}

function uploadCode(run) {
	try {
		run();
	} catch (error) {
		return typeof error.uploadCode === "string" ? error.uploadCode : `${error.message}`;
	}
	return null;
}

function replaceParams(fixture, content, expected) {
	return { uploadId: fixture.uploadId, path: TARGET, policy: "replace", size: Buffer.byteLength(content), sha256: sha256(Buffer.from(content, "utf8")), expected };
}

/** prepare + spool write for one replacement of TARGET. */
function planReplace(fixture, content, expected) {
	fixture.uploadId = newUploadId();
	const prepared = fixture.scope.prepare(replaceParams(fixture, content, expected), IDENTITY);
	stage(fixture, content);
	return prepared;
}

function createFile(fixture, content, mode) {
	const file = path.join(fixture.root, TARGET);
	fs.writeFileSync(file, content, { mode });
	fs.chmodSync(file, mode);
	return file;
}

test("replace publishes the staged bytes with the revision's mode and reports the published revision", linuxOnly, (t) => {
	const fixture = createFixture(t);
	const file = createFile(fixture, "first revision\n", 0o640);
	const prepared = planReplace(fixture, "second revision\n", revisionOf(file));
	assert.deepEqual(Object.keys(prepared).sort(), ["expiresAt", "stageRef", "token"]);

	const result = fixture.scope.commit({ uploadId: fixture.uploadId, token: prepared.token }, IDENTITY, 0);
	assert.equal(result.committed, true);
	assert.equal(fs.readFileSync(file, "utf8"), "second revision\n");
	// The replacement keeps the revision's mode instead of the create path's 0600.
	assert.equal(fs.statSync(file).mode & 0o7777, 0o640);
	assert.equal(result.path, TARGET);
	assert.equal(result.size, Buffer.byteLength("second revision\n"));
	assert.equal(result.sha256, sha256(Buffer.from("second revision\n", "utf8")));
	const published = revisionOf(file);
	delete published.digest;
	assert.deepEqual(result.revision, published, "the answer describes the published file");
	assert.equal(result.fsync, true);
	assert.equal(result.stageCleaned, true);
	assert.deepEqual(leftovers(fixture), [], "no spool file and no temp may survive a successful commit");
});

test("a target the user changed between prepare and commit is refused and keeps the new bytes", linuxOnly, (t) => {
	const fixture = createFixture(t);
	const file = createFile(fixture, "first revision\n", 0o644);
	const prepared = planReplace(fixture, "staged replacement\n", revisionOf(file));
	fs.writeFileSync(file, "user typed this\n");

	assert.equal(
		uploadCode(() => fixture.scope.commit({ uploadId: fixture.uploadId, token: prepared.token }, IDENTITY, 0)),
		"FILE_UPLOAD_SOURCE_CHANGED",
	);
	assert.equal(fs.readFileSync(file, "utf8"), "user typed this\n", "a lost compare-and-swap must not overwrite the user's edit");
	assert.deepEqual(leftovers(fixture), [], "the temp and the spool are cleaned up as well");
});

test("a target deleted between prepare and commit is refused as SOURCE_CHANGED", linuxOnly, (t) => {
	const fixture = createFixture(t);
	const file = createFile(fixture, "first revision\n", 0o644);
	const prepared = planReplace(fixture, "staged replacement\n", revisionOf(file));
	fs.unlinkSync(file);

	assert.equal(
		uploadCode(() => fixture.scope.commit({ uploadId: fixture.uploadId, token: prepared.token }, IDENTITY, 0)),
		"FILE_UPLOAD_SOURCE_CHANGED",
	);
	assert.equal(fs.existsSync(file), false, "nothing may be created where the file used to be");
	assert.deepEqual(leftovers(fixture), []);
});

test("a revision owned by another account is refused before anything is staged", linuxOnly, (t) => {
	const fixture = createFixture(t);
	const file = createFile(fixture, "someone else's file\n", 0o644);
	const expected = revisionOf(file);
	fixture.uploadId = newUploadId();
	// A rename would hand a foreign file to this account, so the replacement is refused up front.
	assert.equal(
		uploadCode(() => fixture.scope.prepare(replaceParams(fixture, "mine\n", { ...expected, uid: String(Number(expected.uid) + 1) }), IDENTITY)),
		"PERMISSION_DENIED",
	);
	assert.equal(
		uploadCode(() => fixture.scope.prepare(replaceParams(fixture, "mine\n", { ...expected, gid: String(Number(expected.gid) + 1) }), IDENTITY)),
		"PERMISSION_DENIED",
	);
	assert.equal(fs.readFileSync(file, "utf8"), "someone else's file\n");
});

test("prepare refuses an expected revision that does not describe the target", linuxOnly, (t) => {
	const fixture = createFixture(t);
	const file = createFile(fixture, "first revision\n", 0o644);
	const revision = revisionOf(file);
	const content = "staged replacement\n";
	const codeOf = (expected) => {
		fixture.uploadId = newUploadId();
		return uploadCode(() => fixture.scope.prepare(replaceParams(fixture, content, expected), IDENTITY));
	};
	assert.equal(codeOf(revision), null, "the unmodified revision must be accepted");

	// Every field of the revision is part of the comparison, so a stale value in any one of them is a refusal.
	for (const [label, mutate] of [
		["a different content digest", (value) => ({ ...value, digest: sha256(Buffer.from("something else")) })],
		["a stale mtime", (value) => ({ ...value, mtimeNs: String(BigInt(value.mtimeNs) - 1n) })],
		["a stale inode", (value) => ({ ...value, ino: String(BigInt(value.ino) + 1n) })],
		["a different mode", (value) => ({ ...value, mode: 0o600 })],
		["a different size", (value) => ({ ...value, size: value.size + 1 })],
	]) {
		assert.equal(codeOf(mutate(revision)), "FILE_UPLOAD_SOURCE_CHANGED", label);
	}
	// A missing target is the same refusal: nothing was read, so nothing can be replaced.
	fs.unlinkSync(file);
	assert.equal(codeOf(revision), "FILE_UPLOAD_SOURCE_CHANGED", "a missing target");
	assert.equal(fs.existsSync(file), false);
});

test("a malformed expected revision is an input refusal, not a compare-and-swap failure", linuxOnly, (t) => {
	const fixture = createFixture(t);
	const file = createFile(fixture, "first revision\n", 0o644);
	const revision = revisionOf(file);
	const content = "staged replacement\n";
	const codeOf = (params) => {
		fixture.uploadId = newUploadId();
		return uploadCode(() => fixture.scope.prepare({ ...params, uploadId: fixture.uploadId }, IDENTITY));
	};
	const base = replaceParams(fixture, content, revision);

	for (const [label, mutate] of [
		["an extra key", (value) => ({ ...value, extra: "1" })],
		["a missing key", ({ digest, ...rest }) => rest],
		["a non-hex digest", (value) => ({ ...value, digest: "z".repeat(64) })],
		["a short digest", (value) => ({ ...value, digest: "a".repeat(63) })],
		["an uppercase digest", (value) => ({ ...value, digest: "A".repeat(64) })],
		["a negative size", (value) => ({ ...value, size: -1 })],
		["a fractional size", (value) => ({ ...value, size: 1.5 })],
		["a size past the ceiling", (value) => ({ ...value, size: 8589934593 })],
		["a negative mode", (value) => ({ ...value, mode: -1 })],
		["a mode past 4095", (value) => ({ ...value, mode: 4096 })],
		["a fractional mode", (value) => ({ ...value, mode: 420.5 })],
		["a numeric ino", (value) => ({ ...value, ino: Number(value.ino) })],
		["a negative uid", (value) => ({ ...value, uid: "-1" })],
		["a hex dev", (value) => ({ ...value, dev: "0a" })],
		["an over-long mtime", (value) => ({ ...value, mtimeNs: "1".repeat(41) })],
		["a missing ctime", ({ ctimeNs, ...rest }) => rest],
		["a non-object", () => "revision"],
		["null", () => null],
	]) {
		assert.equal(codeOf({ ...base, expected: mutate(revision) }), "FILE_UPLOAD_INPUT_INVALID", label);
	}
	// The same checks apply to the whole prepare object: `expected` is only legal under `policy: "replace"`.
	assert.equal(codeOf({ ...base, policy: "create" }), "FILE_UPLOAD_INPUT_INVALID", "expected under create");
	assert.equal(codeOf({ ...base, expected: undefined }), "FILE_UPLOAD_INPUT_INVALID", "replace without expected");
	assert.equal(codeOf({ ...base, policy: "append" }), "FILE_UPLOAD_INPUT_INVALID", "an unknown policy");
	assert.equal(fs.readFileSync(file, "utf8"), "first revision\n", "a refused prepare never writes");
});

test("a staged body with the wrong digest is a stage failure and cleans up", linuxOnly, (t) => {
	const fixture = createFixture(t);
	const file = createFile(fixture, "first revision\n", 0o644);
	fixture.uploadId = newUploadId();
	const prepared = fixture.scope.prepare({ uploadId: fixture.uploadId, path: TARGET, policy: "replace", size: 8, sha256: sha256(Buffer.from("expected")), expected: revisionOf(file) }, IDENTITY);
	stage(fixture, "tampered");

	assert.equal(
		uploadCode(() => fixture.scope.commit({ uploadId: fixture.uploadId, token: prepared.token }, IDENTITY, 0)),
		"FILE_UPLOAD_STAGE_INVALID",
	);
	assert.equal(fs.readFileSync(file, "utf8"), "first revision\n", "the target keeps its bytes");
	assert.deepEqual(leftovers(fixture), []);
});

test("a commit token is single use, so a replay is refused", linuxOnly, (t) => {
	const fixture = createFixture(t);
	const file = createFile(fixture, "first revision\n", 0o644);
	const prepared = planReplace(fixture, "staged replacement\n", revisionOf(file));

	assert.equal(fixture.scope.commit({ uploadId: fixture.uploadId, token: prepared.token }, IDENTITY, 0).committed, true);
	assert.equal(
		uploadCode(() => fixture.scope.commit({ uploadId: fixture.uploadId, token: prepared.token }, IDENTITY, 0)),
		"FILE_UPLOAD_TOKEN_INVALID",
	);
	assert.equal(fs.readFileSync(file, "utf8"), "staged replacement\n");
});

test("a refusal while another upload is still pending reports its own code, and close sweeps it", linuxOnly, (t) => {
	// Regression: the scope's shutdown helper once shared its name with close(descriptor), so every failure
	// path re-entered the pending sweeper instead of closing a descriptor and a second upload blew the stack.
	const fixture = createFixture(t);
	createFile(fixture, "already here\n", 0o644);
	const body = Buffer.from("created body\n", "utf8");
	fixture.uploadId = newUploadId();
	const first = fixture.scope.prepare({ uploadId: fixture.uploadId, path: "sub/fresh.txt", policy: "create", size: body.length, sha256: sha256(body) }, IDENTITY);
	stage(fixture, body);

	// The pending record is still there, so this refusal runs beside it and must answer with its own code.
	assert.equal(
		uploadCode(() => fixture.scope.prepare({ uploadId: newUploadId(), path: TARGET, policy: "create", size: body.length, sha256: sha256(body) }, IDENTITY)),
		"FILE_UPLOAD_TARGET_EXISTS",
	);

	// Shutdown sweeps the pending stage: the spool file is gone and the token no longer commits.
	fixture.scope.close();
	assert.deepEqual(leftovers(fixture), []);
	assert.equal(
		uploadCode(() => fixture.scope.commit({ uploadId: fixture.uploadId, token: first.token }, IDENTITY, 0)),
		"FILE_UPLOAD_TOKEN_INVALID",
	);
	assert.equal(fs.existsSync(path.join(fixture.root, "sub/fresh.txt")), false);
});

test("the create policy still refuses an existing target and publishes a new one with 0600", linuxOnly, (t) => {
	const fixture = createFixture(t);
	const file = createFile(fixture, "already here\n", 0o644);
	const body = Buffer.from("created body\n", "utf8");
	const prepareCreate = () => fixture.scope.prepare({ uploadId: fixture.uploadId, path: TARGET, policy: "create", size: body.length, sha256: sha256(body) }, IDENTITY);

	// An existing target is refused at prepare, before any spool file is written.
	fixture.uploadId = newUploadId();
	assert.equal(uploadCode(prepareCreate), "FILE_UPLOAD_TARGET_EXISTS");
	assert.equal(fs.readFileSync(file, "utf8"), "already here\n");

	// And a target that appears between prepare and commit is refused at commit.
	fs.unlinkSync(file);
	fixture.uploadId = newUploadId();
	const prepared = prepareCreate();
	stage(fixture, body);
	fs.writeFileSync(file, "raced in\n");
	assert.equal(
		uploadCode(() => fixture.scope.commit({ uploadId: fixture.uploadId, token: prepared.token }, IDENTITY, 0)),
		"FILE_UPLOAD_TARGET_EXISTS",
	);
	assert.equal(fs.readFileSync(file, "utf8"), "raced in\n");
	assert.deepEqual(leftovers(fixture), []);

	// A clean create publishes the body 0600 and reports the revision it published.
	fs.unlinkSync(file);
	fixture.uploadId = newUploadId();
	const created = prepareCreate();
	stage(fixture, body);
	const result = fixture.scope.commit({ uploadId: fixture.uploadId, token: created.token }, IDENTITY, 0);
	assert.equal(result.committed, true);
	assert.equal(fs.readFileSync(file, "utf8"), "created body\n");
	assert.equal(result.revision.mode, 0o600);
	assert.equal(result.revision.size, body.length);
	assert.equal(result.stageCleaned, true);
	assert.deepEqual(leftovers(fixture), []);
});
