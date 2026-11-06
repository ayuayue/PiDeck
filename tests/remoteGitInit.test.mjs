import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture, options, successful } from "./helpers/remoteGitFixture.mjs";

/*
 * G5c explicit init: the only Git write that runs before a repository exists. Every success is checked against
 * native Git on disk (not against the helper's own wording), and every refusal is checked against a byte witness of
 * the root and .git, because "the helper said no" is not the same as "nothing changed". Windows is skipped: the
 * frozen worker refuses Git work off Linux.
 */

const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function sha256(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Recursive identity+content witness of one tree; enough to prove that a refusal wrote nothing at all. */
function witness(directory) {
	const entries = [];
	const walk = (current, prefix) => {
		for (const name of readdirSync(current).sort()) {
			const absolute = join(current, name);
			const stats = lstatSync(absolute, { bigint: true });
			if (stats.isSymbolicLink()) entries.push(prefix + name + ":link:" + readlinkSync(absolute));
			else if (stats.isDirectory()) {
				entries.push(prefix + name + "/");
				walk(absolute, prefix + name + "/");
			} else entries.push(prefix + name + ":ino" + String(stats.ino) + ":" + sha256(absolute));
		}
	};
	walk(directory, "");
	return entries;
}

async function refusal(f, params) {
	const frame = await f.request("git.init", params);
	assert.equal(frame.ok, false, "expected a refusal, got " + JSON.stringify(frame.result));
	return frame.error?.code;
}

function helperStatusText(statusResult) {
	return Buffer.from(statusResult.status, "base64").toString("utf8");
}

function nativeStatus(f) {
	return f.git("status", "--porcelain=v1", "-z", "--untracked-files=all");
}

test("the helper advertises the init capability it implements", options, async (t) => {
	const f = fixture(t, false);
	const hello = successful(await f.request("hello"));
	assert.ok(Array.from(hello.capabilities).includes("git.init"));
});

test("an empty root is initialized: .git is a directory, the branch is the native one, and status serves the repository", options, async (t) => {
	const f = fixture(t, false);
	assert.equal(existsSync(join(f.root, ".git")), false);
	const created = successful(await f.request("git.init", {}));
	assert.equal(typeof created.branch, "string");
	assert.ok(created.branch.length > 0, "init must report the default branch");
	assert.equal(lstatSync(join(f.root, ".git")).isDirectory(), true);
	assert.equal(lstatSync(join(f.root, ".git")).isSymbolicLink(), false);
	// Native Git is the oracle for "this really is the repository", not the helper's self-report.
	assert.equal(f.git("rev-parse", "--git-dir").trim(), ".git");
	assert.equal(f.git("symbolic-ref", "--short", "HEAD").trim(), created.branch);
	assert.equal(f.git("rev-parse", "--is-inside-work-tree").trim(), "true");
	// The read side now serves the created repository and reports a new file as untracked.
	writeFileSync(join(f.root, "hello.txt"), "hello\n");
	const status = successful(await f.request("git.status", {}));
	assert.equal(helperStatusText(status), "?? hello.txt\0");
	assert.equal(helperStatusText(status), nativeStatus(f));
	// A second init is the existing-repository refusal, not a silent no-op.
	assert.equal(await refusal(f, {}), "GIT_REPO_EXISTS");
	assert.equal(f.git("symbolic-ref", "--short", "HEAD").trim(), created.branch);
	// No lock and no scratch artifact of our own survives the write.
	assert.equal(existsSync(join(f.root, ".git", "index.lock")), false);
	assert.deepEqual(
		readdirSync(join(f.root, ".git")).filter((name) => name.startsWith("pideck-index-")),
		[],
	);
});

test("a non-empty root is initialized without touching existing files, which stay byte-identical", options, async (t) => {
	const f = fixture(t, false);
	mkdirSync(join(f.root, "sub"));
	writeFileSync(join(f.root, "keep.txt"), "KEEP-内容\n");
	writeFileSync(join(f.root, "sub", "nested.txt"), "NESTED\n");
	const files = [join(f.root, "keep.txt"), join(f.root, "sub", "nested.txt")];
	const snapshot = () =>
		files.map((file) => {
			const stats = lstatSync(file, { bigint: true });
			return [sha256(file), String(stats.ino), String(stats.mode), String(stats.size), String(stats.mtimeNs), String(stats.ctimeNs)].join(":");
		});
	const before = snapshot();
	const created = successful(await f.request("git.init", {}));
	assert.ok(created.branch === null || created.branch.length > 0);
	assert.deepEqual(snapshot(), before, "init must not rewrite the user's existing files");
	// Both files are now untracked, and the helper's status agrees with native Git byte for byte.
	const helperStatus = helperStatusText(successful(await f.request("git.status", {})));
	const native = nativeStatus(f);
	assert.match(native, /\?\? keep\.txt/);
	assert.match(native, /\?\? sub\/nested\.txt/);
	assert.equal(helperStatus, native);
	assert.equal(existsSync(join(f.root, ".git", "index.lock")), false);
});

test("a repository that already exists is refused before any Git work and nothing changes", options, async (t) => {
	const f = fixture(t);
	writeFileSync(join(f.root, "tracked.txt"), "TRACKED\n");
	f.git("add", "-A");
	const before = witness(f.root);
	assert.equal(await refusal(f, {}), "GIT_REPO_EXISTS");
	assert.deepEqual(witness(f.root), before, "the refusal must neither create nor rewrite anything");
});

test("an empty directory named .git is already a repository claim", options, async (t) => {
	const f = fixture(t, false);
	mkdirSync(join(f.root, ".git"));
	const before = witness(f.root);
	assert.equal(await refusal(f, {}), "GIT_REPO_EXISTS");
	assert.deepEqual(witness(f.root), before);
	assert.deepEqual(readdirSync(join(f.root, ".git")), [], "the refusal must not initialize into that directory");
});

test("a .git gitfile is an existing repository, not an empty root", options, async (t) => {
	const f = fixture(t, false);
	const pointer = "gitdir: " + join(f.directory, "actual-gitdir") + "\n";
	writeFileSync(join(f.root, ".git"), pointer);
	const before = witness(f.root);
	assert.equal(await refusal(f, {}), "GIT_REPO_EXISTS");
	assert.equal(readFileSync(join(f.root, ".git"), "utf8"), pointer);
	assert.deepEqual(witness(f.root), before);
});

test("a .git symlink (live or dangling) is an existing repository and is never followed", options, async (t) => {
	const f = fixture(t, false);
	const target = join(f.directory, "decoy-gitdir");
	mkdirSync(target);
	symlinkSync(target, join(f.root, ".git"), "dir");
	const before = witness(f.root);
	assert.equal(await refusal(f, {}), "GIT_REPO_EXISTS");
	assert.equal(lstatSync(join(f.root, ".git")).isSymbolicLink(), true);
	assert.deepEqual(readdirSync(target), [], "the helper must not follow the link and write through it");
	assert.deepEqual(witness(f.root), before);
	// A dangling link is refused the same way: it is a .git entry in some form, not an empty root.
	// fs.rmSync stats through the link and refuses a directory target (ERR_FS_EISDIR); unlink removes the link itself.
	unlinkSync(join(f.root, ".git"));
	symlinkSync(join(f.directory, "missing-target"), join(f.root, ".git"), "dir");
	assert.equal(await refusal(f, {}), "GIT_REPO_EXISTS");
	assert.equal(existsSync(join(f.directory, "missing-target")), false);
});

test("a root inside an enclosing repository is refused and no nested .git is created", options, async (t) => {
	const f = fixture(t, false);
	// The parent directory becomes a worktree; the helper root is a subdirectory without its own .git.
	f.git("init", "-q", "..");
	const hooks = join(f.directory, "parent-hooks");
	const marker = join(f.directory, "PARENT-HOOK-RAN");
	mkdirSync(hooks);
	writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\ntouch " + marker + "\n");
	chmodSync(join(hooks, "pre-commit"), 0o755);
	f.git("config", "core.hooksPath", hooks);
	const rootBefore = witness(f.root);
	const outerBefore = witness(join(f.directory, ".git"));
	assert.equal(await refusal(f, {}), "GIT_REPO_EXISTS");
	assert.equal(existsSync(join(f.root, ".git")), false, "a parent repository governs the root; it must not be nested into");
	assert.deepEqual(witness(f.root), rootBefore);
	assert.deepEqual(witness(join(f.directory, ".git")), outerBefore, "the refusal is read-only for the parent repository");
	assert.equal(existsSync(marker), false, "no configured hook may run during the refusal");
});

test("configured hooks are never executed by the init write", options, async (t) => {
	const f = fixture(t, false);
	const hooks = join(f.directory, "configured-hooks");
	const marker = join(f.directory, "HOOK-RAN");
	mkdirSync(hooks);
	for (const name of ["pre-commit", "post-checkout", "post-merge", "pre-push"]) {
		writeFileSync(join(hooks, name), "#!/bin/sh\ntouch " + marker + "\n");
		chmodSync(join(hooks, name), 0o755);
	}
	// The remote account's own config points at executable hooks: init has no hook execution point, and no hook runs.
	writeFileSync(join(f.directory, "home", ".gitconfig"), "[core]\n\thooksPath = " + hooks + "\n");
	const created = successful(await f.request("git.init", {}));
	assert.ok(created.branch === null || created.branch.length > 0);
	assert.equal(existsSync(marker), false, "init must not execute any configured hook");
	assert.equal(f.git("rev-parse", "--git-dir").trim(), ".git", "the refusal to run hooks is not a failed init");
});

test("git.init takes no parameters: every extra or malformed field is a protocol refusal", options, async (t) => {
	const f = fixture(t, false);
	for (const params of [{ extra: 1 }, { path: "" }, { branch: "main" }, null, [], "init"]) {
		const frame = await f.request("git.init", params);
		assert.equal(frame.ok, false, JSON.stringify(params));
		assert.equal(frame.error?.code, "GIT_RESULT_INVALID", JSON.stringify(params));
	}
	assert.equal(existsSync(join(f.root, ".git")), false, "a refused request must not create anything");
	// The helper stays usable after the refusals.
	const created = successful(await f.request("git.init", {}));
	assert.ok(created.branch === null || created.branch.length > 0);
});

test("the init branch result is a bounded native branch name", options, async (t) => {
	const f = fixture(t, false);
	const created = successful(await f.request("git.init", {}));
	const branch = f.git("symbolic-ref", "--short", "HEAD").trim();
	assert.equal(created.branch, branch);
	assert.ok(branch.length > 0 && Buffer.byteLength(branch, "utf8") < 4096);
	assert.equal(HASH.test(created.branch ?? ""), false, "a branch is a name, not an object id");
});
