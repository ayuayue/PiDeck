import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture, successful, options } from "./helpers/remoteGitFixture.mjs";

test("remote Git status negotiates read-only methods and preserves index bytes and metadata", options, async (t) => {
	const { root, git, request } = fixture(t);
	writeFileSync(join(root, "tracked.txt"), "base\n");
	git("add", "--", "tracked.txt");
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "baseline");
	writeFileSync(join(root, "tracked.txt"), "staged\n");
	git("add", "--", "tracked.txt");
	writeFileSync(join(root, "tracked.txt"), "working\n");
	writeFileSync(join(root, "中文 file.txt"), "untracked\n");
	const index = join(root, ".git", "index");
	const before = statSync(index, { bigint: true });
	const digest = createHash("sha256").update(readFileSync(index)).digest("hex");
	const hello = successful(await request("hello"));
	assert.ok(hello.capabilities.includes("git.status"));
	assert.ok(hello.capabilities.includes("git.workspaceDiff"));
	const result = successful(await request("git.status"));
	const raw = Buffer.from(result.status, "base64").toString("utf8");
	assert.ok(raw.includes("MM tracked.txt\0"));
	assert.ok(raw.includes("?? 中文 file.txt\0"));
	assert.equal(result.head, git("rev-parse", "HEAD").trim());
	assert.equal(result.branch, git("symbolic-ref", "--short", "HEAD").trim());
	assert.equal(createHash("sha256").update(readFileSync(index)).digest("hex"), digest);
	const after = statSync(index, { bigint: true });
	assert.equal(after.ino, before.ino);
	assert.equal(after.mtimeNs, before.mtimeNs);
	assert.equal(after.ctimeNs, before.ctimeNs);
});

test("remote Git workspace diff distinguishes HEAD, index and working-tree content", options, async (t) => {
	const { root, git, request } = fixture(t);
	writeFileSync(join(root, "tracked.txt"), "base\n");
	git("add", "--", "tracked.txt");
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "baseline");
	writeFileSync(join(root, "tracked.txt"), "staged\n");
	git("add", "--", "tracked.txt");
	writeFileSync(join(root, "tracked.txt"), "working\n");
	const staged = successful(await request("git.workspaceDiff", { group: "index", path: "tracked.txt" }));
	assert.equal(staged.originalContent, "base\n");
	assert.equal(staged.modifiedContent, "staged\n");
	const working = successful(await request("git.workspaceDiff", { group: "workingTree", path: "tracked.txt" }));
	assert.equal(working.originalContent, "staged\n");
	assert.equal(working.modifiedContent, "working\n");
});

test("remote Git status distinguishes an unborn repository from a directory without Git", options, async (t) => {
	const unborn = fixture(t);
	writeFileSync(join(unborn.root, "new.txt"), "new\n");
	const result = successful(await unborn.request("git.status"));
	assert.equal(result.head, null);
	assert.equal(result.branch, unborn.git("symbolic-ref", "--short", "HEAD").trim());
	assert.ok(Buffer.from(result.status, "base64").toString("utf8").includes("?? new.txt\0"));
	const directory = fixture(t, false);
	const refused = await directory.request("git.status");
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "GIT_NOT_REPOSITORY");
});

test("remote Git diff refuses lexical escapes instead of reading outside the project", options, async (t) => {
	const { request } = fixture(t);
	const refused = await request("git.workspaceDiff", { group: "untracked", path: "../outside.txt" });
	assert.equal(refused.ok, false);
	assert.equal(refused.error.code, "PATH_OUTSIDE_ROOT");
});

/** Build only an owned baseline, with identity passed on this command rather than persisted globally. */
function baseline(root, git) {
	writeFileSync(join(root, "tracked.txt"), "base\n");
	git("add", "--", "tracked.txt");
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "baseline");
}

test("remote Git index diff handles rename and deletion without consulting the local filesystem", options, async (t) => {
	const { root, git, request } = fixture(t);
	baseline(root, git);
	git("mv", "--", "tracked.txt", "renamed.txt");
	const renamed = successful(await request("git.workspaceDiff", { group: "index", path: "renamed.txt" }));
	assert.equal(renamed.originalContent, "base\n");
	assert.equal(renamed.modifiedContent, "base\n");
	git("reset", "--hard", "HEAD");
	git("rm", "--", "tracked.txt");
	const deleted = successful(await request("git.workspaceDiff", { group: "index", path: "tracked.txt" }));
	assert.equal(deleted.originalContent, "base\n");
	assert.equal(deleted.modifiedContent, "");
});

test("remote Git reports detached HEAD without fabricating a branch", options, async (t) => {
	const { root, git, request } = fixture(t);
	baseline(root, git);
	git("checkout", "--detach", "-q");
	const result = successful(await request("git.status"));
	assert.equal(result.head, git("rev-parse", "HEAD").trim());
	assert.equal(result.branch, null);
});

test("remote Git raw-text diff rejects binary, invalid UTF-8 and over-budget bodies", options, async (t) => {
	const { root, request } = fixture(t);
	for (const [name, content, expected] of [
		["binary.bin", Buffer.from([0, 1, 2]), "GIT_NOT_TEXT"],
		["invalid.txt", Buffer.from([0xc3, 0x28]), "GIT_NOT_TEXT"],
		["large.txt", Buffer.alloc(256 * 1024 + 1, 65), "RESULT_TOO_LARGE"],
	]) {
		writeFileSync(join(root, name), content);
		const result = await request("git.workspaceDiff", { group: "untracked", path: name });
		assert.equal(result.ok, false);
		assert.equal(result.error.code, expected);
	}
});

test("remote Git never follows a worktree symlink while previewing its contents", options, async (t) => {
	const { root, directory, request } = fixture(t);
	const outside = join(directory, "outside.txt");
	writeFileSync(outside, "private-outside-oracle\n");
	symlinkSync(outside, join(root, "link.txt"));
	const result = await request("git.workspaceDiff", { group: "untracked", path: "link.txt" });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "NOT_A_FILE");
	assert.ok(!JSON.stringify(result).includes("private-outside-oracle"));
});

test("remote Git refuses gitfile and external metadata before executing repository operations", options, async (t) => {
	const gitfile = fixture(t, false);
	writeFileSync(join(gitfile.root, ".git"), "gitdir: ../other\n");
	assert.equal((await gitfile.request("git.status")).error.code, "GIT_UNSUPPORTED_REPOSITORY");
	const alternate = fixture(t);
	writeFileSync(join(alternate.root, ".git", "objects", "info", "alternates"), "/unreachable/objects\n");
	assert.equal((await alternate.request("git.status")).error.code, "GIT_UNSUPPORTED_REPOSITORY");
	const linked = fixture(t);
	symlinkSync(join(linked.directory, "home"), join(linked.root, ".git", "linked"));
	assert.equal((await linked.request("git.status")).error.code, "GIT_UNSUPPORTED_REPOSITORY");
});

test("remote Git refuses configured clean/process filters instead of running or bypassing them", options, async (t) => {
	const { git, request } = fixture(t);
	git("config", "filter.fixture.clean", "unavailable-fixture-filter");
	git("config", "filter.fixture.required", "true");
	const result = await request("git.status");
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "GIT_CONFIG_UNSUPPORTED");
});

/**
 * 宿主级（system/global）filter 不该让远端 Git 读整体失效：GitHub runner 与很多远端开发机
 * 都用 system 级 git-lfs 写 `filter.lfs.*`，而只读命令（show/status/diff/ls-files）不做
 * smudge/clean，不会因此给出错误内容。这条用例把 global 配置写进夹具的隔离 HOME，钉住
 * validateConfiguration 只按 --local 判定；本地 filter 仍必须拒绝（上一条用例）。
 */
test("remote Git only treats repository-local configuration as unsupported", options, async (t) => {
	const { directory, root, request } = fixture(t);
	writeFileSync(join(directory, "home", ".gitconfig"), '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n');
	writeFileSync(join(root, "ordinary.txt"), "ordinary\n");
	const result = successful(await request("git.status"));
	assert.ok(Buffer.from(result.status, "base64").toString("utf8").includes("?? ordinary.txt\0"));
});

test("remote Git ignores inherited Git worktree/index/config injection and refuses free argv", options, async (t) => {
	const { root, request } = fixture(t, true, { GIT_DIR: "/unreachable/injected-gitdir", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "filter.injected.clean", GIT_CONFIG_VALUE_0: "unavailable" });
	writeFileSync(join(root, "ordinary.txt"), "ordinary\n");
	assert.ok(successful(await request("git.status")).status);
	const rejected = await request("git.status", { argv: ["commit"] });
	assert.equal(rejected.ok, false);
	assert.equal(rejected.error.code, "GIT_RESULT_INVALID");
});

test("remote Git resource budget refuses the entire list rather than returning partial clean status", options, async (t) => {
	const { root, request } = fixture(t);
	for (let i = 0; i < 4097; i += 1) writeFileSync(join(root, `entry-${i}.txt`), "");
	const result = await request("git.status");
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "RESULT_TOO_LARGE");
	assert.equal(result.result, undefined);
});

/** A benign executable substitute lets a real child prove cancel/timeout without hooks or a network. */
function slowGit(f) {
	const binaryDirectory = join(f.directory, "bin");
	mkdirSync(binaryDirectory);
	const executable = join(binaryDirectory, "git");
	const pidFile = join(f.directory, "git.pid");
	writeFileSync(executable, `#!${process.execPath}\nconst { writeFileSync } = require('node:fs');\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
	// This substitute lives outside the project and is owned by this fixture; production never takes an argv executable.
	chmodSync(executable, 0o700);
	return { executable, binaryDirectory, pidFile };
}

/** Poll only a fixture-owned PID file/process; the wait has an explicit deadline. */
async function eventually(predicate) {
	const until = Date.now() + 2_000;
	while (Date.now() < until) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail("bounded child-process observation expired");
}

function dead(pid) {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return error.code === "ESRCH";
	}
}

test("remote Git deadline settles once and kills the actual remote child process", options, async (t) => {
	let slow;
	const f = fixture(t, true, (paths) => {
		slow = slowGit(paths);
		return { PATH: slow.binaryDirectory };
	});
	const result = await f.request("git.status", {}, 250);
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "REQUEST_TIMEOUT");
	const pid = Number(readFileSync(slow.pidFile, "utf8"));
	await eventually(() => dead(pid));
	assert.equal(successful(await f.request("echo", { text: "alive" })).text, "alive");
});

test("remote Git cancellation reaches an active process and retains control-helper responsiveness", options, async (t) => {
	let slow;
	const f = fixture(t, true, (paths) => {
		slow = slowGit(paths);
		return { PATH: slow.binaryDirectory };
	});
	let id;
	const pending = f.request("git.status", {}, 3_000, (value) => {
		id = value;
	});
	await eventually(() => {
		try {
			return !!readFileSync(slow.pidFile, "utf8");
		} catch {
			return false;
		}
	});
	const pid = Number(readFileSync(slow.pidFile, "utf8"));
	assert.equal(successful(await f.request("cancel", { requestId: id })).cancelled, true);
	const outcome = await pending;
	assert.equal(outcome.ok, false);
	assert.equal(outcome.error.code, "REQUEST_CANCELLED");
	await eventually(() => dead(pid));
	assert.equal(successful(await f.request("cancel", { requestId: id })).reason, "already-settled");
});

test("remote Git stdin EOF cleans the remote process and lets helper exit", options, async (t) => {
	let slow;
	const f = fixture(t, true, (paths) => {
		slow = slowGit(paths);
		return { PATH: slow.binaryDirectory };
	});
	const pending = f.request("git.status");
	const observed = pending.catch(() => undefined);
	await eventually(() => {
		try {
			return !!readFileSync(slow.pidFile, "utf8");
		} catch {
			return false;
		}
	});
	const pid = Number(readFileSync(slow.pidFile, "utf8"));
	f.child.stdin.end();
	await observed;
	await eventually(() => dead(pid) && f.child.exitCode !== null);
	assert.equal(f.child.exitCode, 0);
});

test("remote Git intent-to-add previews an empty index baseline and exact worktree text", options, async (t) => {
	const { root, git, request } = fixture(t);
	baseline(root, git);
	writeFileSync(join(root, "intent.txt"), "intent body\n");
	git("add", "-N", "--", "intent.txt");
	const status = successful(await request("git.status"));
	assert.ok(Buffer.from(status.status, "base64").toString("utf8").includes(" A intent.txt\0"));
	const diff = successful(await request("git.workspaceDiff", { group: "workingTree", path: "intent.txt" }));
	assert.equal(diff.originalContent, "");
	assert.equal(diff.modifiedContent, "intent body\n");
});

test("remote Git preserves BOM and CRLF in raw-text preview", options, async (t) => {
	const { root, request } = fixture(t);
	const content = "\ufeffline1\r\nline2\r\n";
	writeFileSync(join(root, "bom.txt"), content);
	const diff = successful(await request("git.workspaceDiff", { group: "untracked", path: "bom.txt" }));
	assert.equal(diff.originalContent, "");
	assert.equal(diff.modifiedContent, content);
});

test("remote Git disables fsmonitor and never executes configured external diff or textconv", options, async (t) => {
	const { root, git, request, directory } = fixture(t);
	baseline(root, git);
	const executable = join(directory, "benign-monitor");
	const marker = join(directory, "executed.marker");
	writeFileSync(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`);
	chmodSync(executable, 0o700);
	git("config", "core.fsmonitor", executable);
	git("config", "diff.external", executable);
	git("config", "diff.fixture.textconv", executable);
	writeFileSync(join(root, ".gitattributes"), "tracked.txt diff=fixture\n");
	writeFileSync(join(root, "tracked.txt"), "changed\n");
	successful(await request("git.status"));
	const diff = successful(await request("git.workspaceDiff", { group: "workingTree", path: "tracked.txt" }));
	assert.equal(diff.originalContent, "base\n");
	assert.equal(diff.modifiedContent, "changed\n");
	assert.throws(
		() => readFileSync(marker),
		(error) => error.code === "ENOENT",
	);
});

test("remote Git exposes unresolved conflict as read-only HEAD-to-worktree content", options, async (t) => {
	const { root, git, request } = fixture(t);
	baseline(root, git);
	const original = git("symbolic-ref", "--short", "HEAD").trim();
	git("checkout", "-qb", "fixture-neighbor");
	writeFileSync(join(root, "tracked.txt"), "neighbor\n");
	git("add", "--", "tracked.txt");
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "neighbor");
	git("checkout", "-q", original);
	writeFileSync(join(root, "tracked.txt"), "current\n");
	git("add", "--", "tracked.txt");
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "current");
	assert.throws(() => git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "merge", "--no-edit", "fixture-neighbor"));
	assert.ok(
		Buffer.from(successful(await request("git.status")).status, "base64")
			.toString("utf8")
			.includes("UU tracked.txt\0"),
	);
	const diff = successful(await request("git.workspaceDiff", { group: "merge", path: "tracked.txt" }));
	assert.equal(diff.originalContent, "current\n");
	assert.equal(diff.modifiedContent, readFileSync(join(root, "tracked.txt"), "utf8"));
});

test("remote Git refuses a stale resource group instead of inventing empty diff", options, async (t) => {
	const { root, request } = fixture(t);
	writeFileSync(join(root, "untracked.txt"), "body\n");
	const result = await request("git.workspaceDiff", { group: "index", path: "untracked.txt" });
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "GIT_RESOURCE_CHANGED");
});

test("remote Git reports missing executable without borrowing local Git", options, async (t) => {
	const { request } = fixture(t, true, { PATH: "" });
	const result = await request("git.status");
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "GIT_NOT_FOUND");
});

test("remote Git kills an overflowing subprocess and leaves the control helper usable", options, async (t) => {
	let pidFile;
	const f = fixture(t, true, (paths) => {
		const slow = slowGit(paths);
		pidFile = slow.pidFile;
		writeFileSync(slow.executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.stdout.write(Buffer.alloc(2048, 65));\nsetInterval(() => {}, 1000);\n`);
		return { PATH: slow.binaryDirectory };
	});
	const result = await f.request("git.status");
	assert.equal(result.ok, false);
	assert.equal(result.error.code, "RESULT_TOO_LARGE");
	await eventually(() => dead(Number(readFileSync(pidFile, "utf8"))));
	assert.equal(successful(await f.request("echo", { text: "after-overflow" })).text, "after-overflow");
});
