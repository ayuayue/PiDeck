import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture, options, successful } from "./helpers/remoteGitFixture.mjs";

/*
 * G3a read-only history batch: bounded log pages, one commit's byte-exact detail, local refs and one file
 * between two revisions. These tests drive the real deployed helper as a child process and check every
 * claim with native Git, so "the history is correct" never rests on the helper's own wording.
 */

const IDENTITY = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];
const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function baseline(f) {
	writeFileSync(join(f.root, "one.txt"), "base\n");
	f.git("add", "--", "one.txt");
	f.git(...IDENTITY, "commit", "-qm", "baseline");
}
function identity(f, name = "Repo Local", email = "repo@example.invalid") {
	f.git("config", "user.name", name);
	f.git("config", "user.email", email);
}
async function code(f, method, params, timeoutMs) {
	const frame = await f.request(method, params, timeoutMs);
	assert.equal(frame.ok, false, `expected ${method} to refuse, got ${JSON.stringify(frame.result)}`);
	return frame.error?.code;
}
/** The read batch must not write anything: this is the witness around every call below. */
function readOnlyWitness(f) {
	const stats = statSync(join(f.root, ".git/index"), { bigint: true });
	return {
		index: createHash("sha256")
			.update(readFileSync(join(f.root, ".git/index")))
			.digest("hex"),
		ino: String(stats.ino),
		mtimeNs: String(stats.mtimeNs),
		refs: f.git("for-each-ref", "--format=%(refname) %(objectname)"),
	};
}
function assertReadOnly(f, before) {
	const stats = statSync(join(f.root, ".git/index"), { bigint: true });
	assert.equal(
		createHash("sha256")
			.update(readFileSync(join(f.root, ".git/index")))
			.digest("hex"),
		before.index,
		"history reads must not rewrite the index",
	);
	assert.equal(String(stats.ino), before.ino);
	assert.equal(String(stats.mtimeNs), before.mtimeNs);
	assert.equal(f.git("for-each-ref", "--format=%(refname) %(objectname)"), before.refs, "history reads must not move a ref");
	assert.equal(existsSync(join(f.root, ".git/index.lock")), false);
	assert.deepEqual(
		readdirSync(join(f.root, ".git")).filter((name) => name.startsWith("pideck-index-")),
		[],
	);
}

test("the helper advertises the read-only history capabilities it implements", options, async (t) => {
	const f = fixture(t);
	const hello = successful(await f.request("hello"));
	for (const capability of ["git.log", "git.commitDetail", "git.refs", "git.refFileDiff"]) assert.ok(Array.from(hello.capabilities).includes(capability), capability);
});

test("log pages are bounded, ordered and report hasMore from native Git's own history", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	identity(f);
	for (let index = 1; index <= 120; index++) f.git(...IDENTITY, "commit", "--allow-empty", "-qm", `empty ${index}`);
	const expected = f.git("log", "--format=%H").trim().split("\n");
	assert.equal(expected.length, 121);
	const before = readOnlyWitness(f);
	const page1 = successful(await f.request("git.log", { maxCount: 50 }));
	assert.equal(page1.commits.length, 50);
	assert.equal(page1.hasMore, true);
	assert.deepEqual(
		page1.commits.map((commit) => commit.oid),
		expected.slice(0, 50),
	);
	assert.equal(page1.commits[0].subject, "empty 120");
	assert.deepEqual(Array.from(page1.commits[0].parents), [expected[1]]);
	assert.equal(page1.commits[0].authorEmail, "fixture@example.invalid");
	assert.equal(page1.commits[0].authorTimeSec, Number(f.git("log", "-1", "--format=%at", expected[0]).trim()));
	const page2 = successful(await f.request("git.log", { maxCount: 50, skip: 50 }));
	assert.deepEqual(
		page2.commits.map((commit) => commit.oid),
		expected.slice(50, 100),
	);
	const page3 = successful(await f.request("git.log", { maxCount: 50, skip: 100 }));
	assert.equal(page3.commits.length, 21);
	assert.equal(page3.hasMore, false);
	const rootCommit = page3.commits[20];
	assert.deepEqual(Array.from(rootCommit.parents), [], "the first commit has no parent");
	assertReadOnly(f, before);
});

test("commit detail carries the byte-exact message, both identities and the changed files", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	identity(f);
	writeFileSync(join(f.root, "two.txt"), "second\n");
	f.git("add", "--", "two.txt");
	f.git("mv", "--", "one.txt", "renamed.txt");
	const message = "subject line\n\nbody line with двойной space\n\n# kept verbatim\n";
	const messageFile = join(f.directory, "message.txt");
	writeFileSync(messageFile, message);
	f.git(...IDENTITY, "commit", "-qF", messageFile);
	const oid = f.git("rev-parse", "HEAD").trim();
	const before = readOnlyWitness(f);
	const detail = successful(await f.request("git.commitDetail", { oid }));
	assert.equal(detail.oid, oid);
	assert.equal(detail.message, message, "cat-file parsing must not add or strip a newline");
	assert.equal(detail.subject, "subject line");
	// This commit was created with the -c overrides, which win over the repository identity set below it.
	assert.equal(detail.authorName, "Fixture");
	assert.equal(detail.authorEmail, "fixture@example.invalid");
	assert.equal(detail.authorTimeSec, Number(f.git("log", "-1", "--format=%at").trim()));
	assert.equal(detail.committerName, "Fixture");
	assert.deepEqual(Array.from(detail.parents), [f.git("rev-parse", "HEAD^").trim()]);
	const files = Array.from(detail.files);
	// 文件项现在还带 numstat 行数（二进制为缺席）：这里只钉协议骨架，行数在下一段单独核对。
	const shape = (file) => ({ status: file.status, path: file.path, ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }) });
	assert.deepEqual(files.filter((file) => file.oldPath !== undefined).map(shape), [{ status: "R100", path: "renamed.txt", oldPath: "one.txt" }]);
	assert.deepEqual(files.filter((file) => file.oldPath === undefined).map(shape), [{ status: "A", path: "two.txt" }]);
	// shortStat 与逐文件行数同源：文件数一致，合计等于逐文件相加（缺席按 0 计）。
	assert.equal(detail.shortStat.files, files.length);
	const summed = files.reduce((total, file) => ({ insertions: total.insertions + (file.additions ?? 0), deletions: total.deletions + (file.deletions ?? 0) }), { insertions: 0, deletions: 0 });
	assert.deepEqual({ insertions: detail.shortStat.insertions, deletions: detail.shortStat.deletions }, summed);
	assertReadOnly(f, before);
});

test("a root commit has no parents and lists its files against nothing", options, async (t) => {
	const f = fixture(t);
	identity(f);
	writeFileSync(join(f.root, "first.txt"), "first\n");
	f.git("add", "--", "first.txt");
	f.git(...IDENTITY, "commit", "-qm", "root commit");
	const oid = f.git("rev-parse", "HEAD").trim();
	const detail = successful(await f.request("git.commitDetail", { oid }));
	assert.deepEqual(Array.from(detail.parents), []);
	assert.deepEqual(
		Array.from(detail.files).map((file) => ({ status: file.status, path: file.path })),
		[{ status: "A", path: "first.txt" }],
	);
	const diff = successful(await f.request("git.refFileDiff", { base: null, head: oid, path: "first.txt" }));
	assert.equal(diff.originalContent, "");
	assert.equal(diff.modifiedContent, "first\n");
});

test("a file's two sides between revisions match native Git, including add and delete sides", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	identity(f);
	const base = f.git("rev-parse", "HEAD").trim();
	writeFileSync(join(f.root, "one.txt"), "changed\r\n");
	writeFileSync(join(f.root, "added.txt"), "added\n");
	f.git("add", "--", "one.txt", "added.txt");
	f.git(...IDENTITY, "commit", "-qm", "second");
	const head = f.git("rev-parse", "HEAD").trim();
	// A delete is the same shape read the other way round: absent on the base side.
	f.git("rm", "-q", "--", "one.txt");
	f.git(...IDENTITY, "commit", "-qm", "delete one");
	const deleted = f.git("rev-parse", "HEAD").trim();
	const before = readOnlyWitness(f);
	const changed = successful(await f.request("git.refFileDiff", { base: base, head: head, path: "one.txt" }));
	assert.equal(changed.originalContent, "base\n");
	assert.equal(changed.modifiedContent, "changed\r\n");
	assert.equal(changed.originalContent, f.git("show", base + ":one.txt"));
	assert.equal(changed.modifiedContent, f.git("show", head + ":one.txt"));
	const added = successful(await f.request("git.refFileDiff", { base: base, head: head, path: "added.txt" }));
	assert.equal(added.originalContent, "", "a side where the file does not exist reads as empty");
	assert.equal(added.modifiedContent, "added\n");
	const reversed = successful(await f.request("git.refFileDiff", { base: deleted, head: head, path: "one.txt" }));
	assert.equal(reversed.originalContent, "", "the file does not exist in the base revision");
	assert.equal(reversed.modifiedContent, "changed\r\n");
	assertReadOnly(f, before);
});

test("refs list local branches and tags with the peeled commit, and never remote-tracking refs", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	identity(f);
	const head = f.git("rev-parse", "HEAD").trim();
	f.git("branch", "--", "feature/x");
	f.git("tag", "--", "v1.0");
	f.git("tag", "-a", "-m", "annotated", "v2.0");
	// A remote-tracking ref must not appear: this batch has no sync state to describe.
	f.git("update-ref", "refs/remotes/origin/main", head);
	const before = readOnlyWitness(f);
	const refs = successful(await f.request("git.refs"));
	assert.equal(refs.branch, f.git("symbolic-ref", "--short", "HEAD").trim());
	assert.equal(refs.head, head);
	const byName = new Map(Array.from(refs.refs).map((entry) => [entry.fullName, entry]));
	assert.equal(byName.size, 4, "three local refs plus the current branch");
	assert.deepEqual(
		[...byName.keys()].filter((name) => name.startsWith("refs/remotes/")),
		[],
		"remote-tracking refs are not part of this batch",
	);
	const v2 = byName.get("refs/tags/v2.0");
	assert.equal(v2.oid, f.git("rev-parse", "v2.0^{commit}").trim(), "an annotated tag reports the commit a caller can use");
	assert.equal(v2.kind, "tag");
	assert.equal(byName.get("refs/tags/v1.0").kind, "tag");
	assert.equal(byName.get("refs/heads/feature/x").kind, "branch");
	assert.equal(byName.get("refs/heads/feature/x").name, "feature/x");
	assertReadOnly(f, before);
});

test("non-UTF-8 history is refused instead of guessed at", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	identity(f);
	writeFileSync(join(f.root, "two.txt"), "two\n");
	f.git("add", "--", "two.txt");
	f.git(...IDENTITY, "commit", "-qm", "before the odd message");
	// `git commit` rewrites the message it is given, so the odd commit is crafted byte-for-byte instead:
	// tree, parent, ident lines and then a latin1 byte Git is never asked to convert.
	const parent = f.git("rev-parse", "HEAD").trim();
	const tree = f.git("rev-parse", "HEAD^{tree}").trim();
	const rawFile = join(f.directory, "odd-message.bin");
	writeFileSync(rawFile, Buffer.concat([Buffer.from(`tree ${tree}\nparent ${parent}\nauthor Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n\nca`, "utf8"), Buffer.from([0x66, 0xe9, 0x0a])]));
	const oid = f.git("hash-object", "-t", "commit", "-w", "--literally", rawFile).trim();
	f.git("update-ref", "HEAD", oid);
	// Not text is not the same as not history: the batch refuses rather than guessing at an encoding.
	assert.equal(await code(f, "git.log", { maxCount: 10 }), "GIT_NOT_TEXT");
	assert.equal(await code(f, "git.commitDetail", { oid }), "GIT_NOT_TEXT");
	// A binary blob in the history is not text either.
	writeFileSync(join(f.root, "bin.dat"), Buffer.from([0x00, 0x01, 0x02]));
	f.git("add", "--", "bin.dat");
	f.git(...IDENTITY, "commit", "-qm", "binary");
	const binary = f.git("rev-parse", "HEAD").trim();
	// Revisions travel as full OIDs only, so the parent is resolved natively here.
	assert.equal(await code(f, "git.refFileDiff", { base: f.git("rev-parse", binary + "~1").trim(), head: binary, path: "bin.dat" }), "GIT_NOT_TEXT");
});

test("a missing or unusable object is reported, and both-missing sides are a refusal", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	const head = f.git("rev-parse", "HEAD").trim();
	const missing = "f".repeat(40);
	assert.equal(await code(f, "git.commitDetail", { oid: missing }), "GIT_OBJECT_NOT_FOUND");
	assert.equal(await code(f, "git.refFileDiff", { base: null, head: missing, path: "one.txt" }), "GIT_OBJECT_NOT_FOUND");
	assert.equal(await code(f, "git.refFileDiff", { base: missing, head: head, path: "one.txt" }), "GIT_OBJECT_NOT_FOUND");
	// The path exists in neither revision, with both sides named: the caller's assumption is stale.
	assert.equal(await code(f, "git.refFileDiff", { base: head, head: head, path: "never-existed.txt" }), "GIT_RESOURCE_CHANGED");
	// A blob is not a commit.
	writeFileSync(join(f.root, "two.txt"), "two\n");
	f.git("add", "--", "two.txt");
	const blob = f.git("rev-parse", ":two.txt").trim();
	assert.equal(await code(f, "git.commitDetail", { oid: blob }), "GIT_RESULT_INVALID");
});

test("every parameter bound and extra field is refused before any Git call", options, async (t) => {
	const f = fixture(t);
	baseline(f);
	const head = f.git("rev-parse", "HEAD").trim();
	const cases = [
		["git.log", { maxCount: 0 }],
		["git.log", { maxCount: 101 }],
		["git.log", { maxCount: 1.5 }],
		["git.log", { skip: -1 }],
		["git.log", { skip: 100001 }],
		["git.log", { maxCount: 10, extra: 1 }],
		["git.log", { maxCount: "10" }],
		["git.commitDetail", { oid: head, extra: 1 }],
		["git.commitDetail", { oid: head.toUpperCase() }],
		["git.commitDetail", { oid: "abc" }],
		["git.refs", { extra: 1 }],
		["git.refFileDiff", { head: head, path: "one.txt" }],
		["git.refFileDiff", { base: null, head: head }],
		["git.refFileDiff", { base: null, head: head, path: "one.txt", extra: 1 }],
		["git.refFileDiff", { base: null, head: head, path: "sub/na:me.txt" }],
		["git.refFileDiff", { base: null, head: head, path: "../escape.txt" }, "PATH_OUTSIDE_ROOT"],
		["git.refFileDiff", { base: null, head: head, path: "/absolute.txt" }, "PATH_OUTSIDE_ROOT"],
	];
	for (const [method, params, expected] of cases) assert.equal(await code(f, method, params), expected ?? "GIT_RESULT_INVALID", `${method} ${JSON.stringify(params)}`);
	const before = readOnlyWitness(f);
	assert.ok(successful(await f.request("git.log", { maxCount: 1 })).commits.length === 1, "a refused request must not poison the next one");
	assertReadOnly(f, before);
});
