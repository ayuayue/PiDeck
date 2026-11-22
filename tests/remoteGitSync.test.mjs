import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fixture, options, successful } from "./helpers/remoteGitFixture.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { REMOTE_GIT_SYNC_SOURCE } = loadTsCommonJs("src/main/remote/RemoteGitSyncSource.ts");

/*
 * G5a sync verbs against a bare repository created inside this run: no external network, no credentials, and every
 * side effect checked natively. The identity-chain rules (no GIT_SSH/ASKPASS injection, no host-key meddling, no
 * config writes) are asserted against the frozen text at the end, because a test cannot observe an injection that
 * never happens.
 */

const IDENTITY = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];
const native = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
const nativeIn = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });

function baseline(f) {
	writeFileSync(join(f.root, "a.txt"), "base\n");
	f.git("add", "--", ".");
	f.git(...IDENTITY, "commit", "-qm", "baseline");
}
/** A bare "origin" plus a second working copy that plays the remote side of the story. */
function withRemote(f) {
	baseline(f);
	const origin = join(f.directory, "origin.git");
	nativeIn(f.directory, "init", "-q", "--bare", origin);
	const branch = f.git("symbolic-ref", "--short", "HEAD").trim();
	// A merge needs a committer identity, and this repository's own config is the only place it may come from.
	f.git("config", "user.name", "Fixture");
	f.git("config", "user.email", "fixture@example.invalid");
	f.git("remote", "add", "origin", origin);
	f.git(...IDENTITY, "push", "-q", "-u", "origin", branch);
	const other = join(f.directory, "other");
	native("", "clone", "-q", origin, other);
	native(other, "config", "user.name", "Other");
	native(other, "config", "user.email", "other@example.invalid");
	return {
		origin,
		branch,
		other,
		remoteHead: () => native(origin, "rev-parse", "refs/heads/" + branch).trim(),
		publish: (file, content) => {
			// The other side synchronises first, so its commit lands on top of whatever this side published.
			native(other, "fetch", "-q", "origin");
			native(other, "reset", "-q", "--hard", "origin/" + branch);
			writeFileSync(join(other, file), content);
			native(other, "add", "--", file);
			native(other, "commit", "-qm", "remote " + file);
			native(other, "push", "-q", "origin", "HEAD:refs/heads/" + branch);
		},
		commitHere: (file, content) => {
			writeFileSync(join(f.root, file), content);
			f.git("add", "--", file);
			f.git(...IDENTITY, "commit", "-qm", "local " + file);
		},
	};
}
function configureHooks(f) {
	const hooks = join(f.root, ".githooks");
	mkdirSync(hooks);
	writeFileSync(join(hooks, "pre-push"), "#!/bin/sh\nprintf 'pre-push\\n' > pre-push-ran\n", { mode: 0o755 });
	writeFileSync(join(hooks, "post-merge"), "#!/bin/sh\nprintf 'post-merge\\n' > post-merge-ran\n", { mode: 0o755 });
	f.git("config", "core.hooksPath", ".githooks");
}

async function code(f, method, params) {
	const frame = await f.request(method, params);
	assert.equal(frame.ok, false, `expected ${method} to refuse, got ${JSON.stringify(frame.result)}`);
	return frame.error?.code;
}
async function revision(f) {
	const status = successful(await f.request("git.status"));
	assert.ok(status.revision);
	return status.revision;
}
/** index bytes, HEAD, refs and the whole worktree: what a fetch or push must leave exactly as it was. */
function witness(f) {
	return {
		index: readFileSync(join(f.root, ".git/index")).toString("base64"),
		head: f.git("rev-parse", "HEAD"),
		refs: f.git("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags"),
		worktree: f.git("status", "--porcelain=v1", "--untracked-files=all"),
		files: ["a.txt"].map((name) => readFileSync(join(f.root, name), "utf8")).join("|"),
	};
}

test("facts name the upstream, the counts and the remotes without ever leaking a URL", options, async (t) => {
	const f = fixture(t);
	const remote = withRemote(f);
	const facts = successful(await f.request("git.syncFacts"));
	assert.equal(facts.branch, remote.branch);
	assert.equal(facts.upstream, `refs/remotes/origin/${remote.branch}`);
	assert.equal(facts.ahead, 0);
	assert.equal(facts.behind, 0);
	assert.deepEqual(Array.from(facts.remotes), ["origin"]);
	// A remote URL can carry a user name and a token: the answer must never contain one, and not a local path either.
	const serialised = JSON.stringify(facts);
	assert.ok(!serialised.includes(remote.origin), "no remote URL or path may cross the protocol");
	assert.ok(!/:\/\//.test(serialised) && !serialised.includes("@"), "no URL-shaped text may cross the protocol");
});

test("fetch moves only the remote-tracking refs, and reports what moved", options, async (t) => {
	const f = fixture(t);
	const remote = withRemote(f);
	const before = witness(f);
	const refBefore = f.git("rev-parse", `refs/remotes/origin/${remote.branch}`).trim();
	remote.publish("remote.txt", "from the other side\n");
	const result = successful(await f.request("git.fetch", { remote: "origin", expectedRevision: await revision(f) }));
	assert.equal(result.applied, true);
	assert.equal(result.upToDate, false);
	const updated = Array.from(result.updated);
	// Git 2.53 (measured on this machine) materialises the remote's symbolic HEAD as refs/remotes/origin/HEAD
	// on the first fetch when it is absent. That ref is inside the allowed remote-tracking namespace and is
	// reported truthfully, so the contract assertion is "the branch moved and nothing else outside
	// refs/remotes/<remote>/* was reported" rather than "exactly one ref". Older Git never creates it and the
	// filter is empty there; this is a test-compat fix, not a product change (G5b batch, WSL git 2.53).
	const branchRef = `refs/remotes/origin/${remote.branch}`;
	assert.equal(updated.filter((entry) => entry.ref === branchRef).length, 1);
	for (const entry of updated) assert.ok(entry.ref === branchRef || entry.ref === "refs/remotes/origin/HEAD", `unexpected updated ref ${entry.ref}`);
	const branchUpdate = updated.find((entry) => entry.ref === branchRef);
	assert.equal(branchUpdate.before, refBefore);
	assert.equal(branchUpdate.after, remote.remoteHead());
	// index, HEAD, branches, tags and the worktree are exactly as they were: a fetch is a remote-tracking-ref update.
	assert.deepEqual(witness(f), before);
	const facts = successful(await f.request("git.syncFacts"));
	assert.equal(facts.behind, 1);
	assert.equal(facts.ahead, 0);
	// A second fetch has nothing to move and says so instead of pretending to have done work.
	const again = successful(await f.request("git.fetch", { remote: "origin", expectedRevision: await revision(f) }));
	assert.equal(again.upToDate, true);
	assert.deepEqual(Array.from(again.updated), []);
});

test("fetch refuses an unknown remote, a stale confirmation and an unreachable one without touching the repository", options, async (t) => {
	const f = fixture(t);
	const remote = withRemote(f);
	const before = witness(f);
	assert.equal(await code(f, "git.fetch", { remote: "nope", expectedRevision: await revision(f) }), "GIT_SYNC_REMOTE_UNKNOWN");
	assert.equal(await code(f, "git.fetch", { remote: "origin", expectedRevision: "f".repeat(64) }), "GIT_RESOURCE_CHANGED");
	assert.deepEqual(witness(f), before);
	// A remote that cannot be reached is a failure, never a silent success and never a retry.
	f.git("remote", "set-url", "origin", join(f.directory, "missing.git"));
	assert.equal(await code(f, "git.fetch", { remote: "origin", expectedRevision: await revision(f) }), "GIT_SYNC_FAILED");
	assert.deepEqual(witness(f), before);
	assert.ok(remote.origin.length > 0);
});

test("push is never forced: it publishes a new commit, reports up-to-date and refuses a non-fast-forward", options, async (t) => {
	const f = fixture(t);
	const remote = withRemote(f);
	// Up to date first: the local branch is exactly what the remote already has.
	const upToDate = successful(await f.request("git.push", { remote: "origin", branch: remote.branch, expectedRevision: await revision(f) }));
	assert.equal(upToDate.outcome, "up-to-date");
	assert.equal(upToDate.refspec, `refs/heads/${remote.branch}:refs/heads/${remote.branch}`);
	// Then a local commit: the bare repository must end up at exactly that commit.
	remote.commitHere("local.txt", "from this side\n");
	const localHead = f.git("rev-parse", "HEAD").trim();
	const before = witness(f);
	const pushed = successful(await f.request("git.push", { remote: "origin", branch: remote.branch, expectedRevision: await revision(f) }));
	assert.equal(pushed.outcome, "pushed");
	assert.equal(remote.remoteHead(), localHead);
	// A push may only move the remote-tracking ref it publishes to; the confirmed local state stays untouched.
	assert.equal(witness(f).head, before.head);
	assert.equal(witness(f).index, before.index);
	assert.equal(witness(f).files, before.files);
	assert.equal((await f.request("git.push", { remote: "origin", branch: remote.branch, expectedRevision: await revision(f) })).result.outcome, "up-to-date");
	// Now let the other side move the same branch: pushing would have to rewrite published history, so it is refused.
	remote.publish("theirs.txt", "the other side moved\n");
	const published = remote.remoteHead();
	assert.equal(await code(f, "git.push", { remote: "origin", branch: remote.branch, expectedRevision: await revision(f) }), "GIT_PUSH_REJECTED");
	assert.equal(remote.remoteHead(), published, "a refused push must not have moved the remote ref");
	assert.equal(f.git("rev-parse", "HEAD").trim(), localHead, "and it must not have rewritten local history either");
});

test("push refuses a branch that is not the one checked out, and an unknown remote", options, async (t) => {
	const f = fixture(t);
	const remote = withRemote(f);
	assert.equal(await code(f, "git.push", { remote: "origin", branch: "other", expectedRevision: await revision(f) }), "GIT_RESULT_INVALID");
	assert.equal(await code(f, "git.push", { remote: "nope", branch: remote.branch, expectedRevision: await revision(f) }), "GIT_SYNC_REMOTE_UNKNOWN");
	assert.equal(await code(f, "git.pull", { remote: "nope", branch: remote.branch, expectedRevision: await revision(f) }), "GIT_SYNC_REMOTE_UNKNOWN");
});

test("pull fast-forwards a clean tree and brings the remote file into the worktree", options, async (t) => {
	const f = fixture(t);
	const remote = withRemote(f);
	remote.publish("incoming.txt", "incoming\n");
	const result = successful(await f.request("git.pull", { remote: "origin", branch: remote.branch, expectedRevision: await revision(f) }));
	assert.equal(result.mode, "fast-forward");
	assert.equal(result.head, remote.remoteHead());
	assert.equal(readFileSync(join(f.root, "incoming.txt"), "utf8"), "incoming\n");
	assert.equal(f.git("rev-parse", "HEAD").trim(), remote.remoteHead());
	// Nothing left to pull: the verb says so instead of creating an empty merge.
	const again = successful(await f.request("git.pull", { remote: "origin", branch: remote.branch, expectedRevision: await revision(f) }));
	assert.equal(again.mode, "up-to-date");
});

test("pull honors hooks configured through core.hooksPath and runs them through native Git", options, async (t) => {
	const f = fixture(t);
	const remote = withRemote(f);
	remote.commitHere("mine.txt", "local only\n");
	remote.publish("theirs.txt", "remote only\n");
	f.git("config", "pull.rebase", "false");
	configureHooks(f);

	const expectedRevision = await revision(f);
	assert.equal(await code(f, "git.fetch", { remote: "origin", expectedRevision }), "GIT_WRITE_UNSUPPORTED", "fetch keeps its managed-write gate");
	assert.equal(await code(f, "git.push", { remote: "origin", branch: remote.branch, expectedRevision }), "GIT_WRITE_UNSUPPORTED", "push keeps its managed-write gate");

	const result = successful(await f.request("git.pull", { remote: "origin", branch: remote.branch, expectedRevision }));
	assert.equal(result.mode, "merge");
	assert.equal(readFileSync(join(f.root, "post-merge-ran"), "utf8"), "post-merge\n", "the configured post-merge hook must run");
	assert.equal(existsSync(join(f.root, "pre-push-ran")), false, "pull must not run an unrelated pre-push hook");
});

test("pull refuses a dirty tree and a divergence it would have to resolve on its own", options, async (t) => {
	const f = fixture(t);
	const remote = withRemote(f);
	remote.publish("incoming.txt", "incoming\n");
	f.git("config", "core.hooksPath", ".githooks");
	writeFileSync(join(f.root, "a.txt"), "my uncommitted work\n");
	const dirty = await code(f, "git.pull", { remote: "origin", branch: remote.branch, expectedRevision: await revision(f) });
	assert.equal(dirty, "GIT_SYNC_DIRTY");
	assert.equal(readFileSync(join(f.root, "a.txt"), "utf8"), "my uncommitted work\n", "a refused pull must not touch the worktree");
	// Make both sides move: now a merge would be needed, and picking that strategy is the user's decision.
	f.git("checkout", "-q", "--", "a.txt");
	remote.commitHere("mine.txt", "local only\n");
	const localHead = f.git("rev-parse", "HEAD").trim();
	remote.publish("theirs.txt", "remote only\n");
	assert.equal(await code(f, "git.pull", { remote: "origin", branch: remote.branch, expectedRevision: await revision(f) }), "GIT_PULL_STRATEGY_REQUIRED");
	assert.equal(f.git("rev-parse", "HEAD").trim(), localHead, "a refused pull must not have moved HEAD");
	assert.equal(f.git("status", "--porcelain=v1").trim(), "");
});

test("pull refuses an operation already in progress even when hooks are configured", options, async (t) => {
	const f = fixture(t);
	const remote = withRemote(f);
	remote.publish("pending.txt", "incoming\n");
	configureHooks(f);
	const head = f.git("rev-parse", "HEAD").trim();
	const trackingRef = `refs/remotes/origin/${remote.branch}`;
	const trackingBefore = f.git("rev-parse", trackingRef).trim();
	writeFileSync(join(f.root, ".git", "MERGE_HEAD"), head + "\n");
	const before = witness(f);

	assert.equal(await code(f, "git.pull", { remote: "origin", branch: remote.branch, expectedRevision: await revision(f) }), "GIT_WRITE_UNSUPPORTED");
	assert.deepEqual(witness(f), before, "an in-progress operation must be refused before network or repository changes");
	assert.equal(f.git("rev-parse", trackingRef).trim(), trackingBefore, "the in-progress gate must run before fetch");
});

test("pull merges when the repository itself configures a strategy", options, async (t) => {
	const f = fixture(t);
	const remote = withRemote(f);
	remote.commitHere("mine.txt", "local only\n");
	remote.publish("theirs.txt", "remote only\n");
	// The strategy is the repository's own setting, written by the user (the product never writes one).
	f.git("config", "pull.rebase", "false");
	const result = successful(await f.request("git.pull", { remote: "origin", branch: remote.branch, expectedRevision: await revision(f) }));
	assert.equal(result.mode, "merge");
	assert.equal(readFileSync(join(f.root, "mine.txt"), "utf8"), "local only\n");
	assert.equal(readFileSync(join(f.root, "theirs.txt"), "utf8"), "remote only\n");
	assert.equal(f.git("rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ").length, 3, "a merge commit with two parents");
});

test("the sync program never injects a credential, a host-key policy or a force", () => {
	// Comments are documentation, not code: the scan runs on the body with its comments removed.
	const code = REMOTE_GIT_SYNC_SOURCE.replace(/\/\*[\s\S]*?\*\//g, "");
	for (const forbidden of ["GIT_SSH", "SSH_COMMAND", "ASKPASS", "StrictHostKeyChecking", "HostKeyAlias", "credential", "user.name", "user.email", "--force", "force-with-lease", "--set-upstream", "prune", "--tags", "GIT_CONFIG_"]) {
		assert.ok(!code.includes(forbidden), `the sync program must not mention ${forbidden}`);
	}
	// ...and it must be the argv it claims to be: no tags, no prune, porcelain output, no editor, no strategy flag.
	for (const required of ['"--no-tags"', '"--porcelain"', '"--no-edit"']) assert.ok(code.includes(required), `the sync program must pass ${required}`);
	assert.ok(!code.includes('"--rebase"') && !code.includes('"--no-rebase"') && !code.includes('"--ff-only"'), "no pull strategy may be chosen by the helper");
});
