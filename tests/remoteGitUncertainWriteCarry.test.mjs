import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * A write that was still in flight when its renderer generation retired (disconnect / rebind / root change) must not
 * come back as a clean repository. The controller publishes "unconfirmed", keeps the code while the next read loads,
 * and only a successful fact read retires it. The hook carries the same marker across generations (it is keyed
 * without the connection generation) and never replays the write.
 */
const { createRemoteGitViewController } = loadTsCommonJs("src/renderer/src/utils/remoteGitViewState.ts");
const HOOK = "src/renderer/src/hooks/useRemoteGitView.ts";
const projectId = "project";
const target = { projectId, relativePath: "file.txt" };
const snapshot = { head: null, branch: "main", groups: { merge: [], index: [], workingTree: [], untracked: [] } };

function fixture(api = {}) {
	const states = [];
	const reads = createRemoteGitViewController(
		projectId,
		"identity",
		{
			cancelRemoteReads: async () => {},
			status: async () => ({ ok: true, snapshot }),
			refresh: async () => ({ ok: true, snapshot }),
			branches: async () => ({ ok: true, info: { current: "main", branches: ["main"] } }),
			workspaceFileDiff: async () => ({ target, path: target.relativePath, displayPath: target.relativePath, originalContent: "old", modifiedContent: "new" }),
			...api,
		},
		(state) => states.push(state),
	);
	return { reads, states, current: () => states.at(-1) };
}

test("a retired generation publishes the unconfirmed write before anything else", () => {
	const f = fixture();
	f.reads.setUncertain();
	assert.equal(f.current().loading, false);
	assert.equal(f.current().errorCode, "GIT_WRITE_RESULT_UNCONFIRMED");
	const published = f.states.length;
	f.reads.setUncertain();
	assert.equal(f.states.length, published + 1, "the carry is idempotent: one explicit publish per call");
});

test("the next read keeps the unconfirmed code while it loads and clears it only on success", async () => {
	let settle;
	const pending = new Promise((accept) => {
		settle = accept;
	});
	const f = fixture({ status: () => pending, refresh: () => pending });
	f.reads.setUncertain();
	const request = f.reads.refresh();
	await Promise.resolve();
	// The loading state must not look like a clean repository.
	assert.equal(f.current().loading, true);
	assert.equal(f.current().errorCode, "GIT_WRITE_RESULT_UNCONFIRMED");
	settle({ ok: true, snapshot });
	await request;
	assert.equal(f.current().loading, false);
	assert.equal(f.current().errorCode, undefined);
	assert.deepEqual(f.current().snapshot.groups, snapshot.groups);
});

test("a failed read cannot retire the unconfirmed write", async () => {
	const f = fixture({ refresh: async () => ({ ok: false, code: "REMOTE_CONNECTION_LOST" }) });
	f.reads.setUncertain();
	await f.reads.refresh(true);
	assert.equal(f.current().errorCode, "GIT_WRITE_RESULT_UNCONFIRMED");
	assert.equal(f.current().snapshot, undefined);
});

test("a disconnect during an in-flight write is carried by the identity, not by the retired generation", () => {
	const hook = readFileSync(HOOK, "utf8");
	// Module-level carry keyed WITHOUT the connection generation (the generation is what changes underneath it).
	assert.match(hook, /const uncertainWrites = new Set<string>\(\);/);
	assert.match(hook, /const identityKey = JSON\.stringify\(\[project\.id, project\.locator\.hostId, project\.locator\.remotePath, repoPath\]\)/);
	assert.match(hook, /const projectKey = JSON\.stringify\(\[[^\]]*services\.generation\]\)/);
	// The retired controller records an in-flight/unknown write before it is disposed...
	const cleanup = hook.slice(hook.indexOf("return () => {", hook.indexOf("useEffect(() => {")));
	assert.ok(cleanup.indexOf("last.mutating === true") >= 0, "an in-flight write must be carried");
	assert.ok(cleanup.indexOf("GIT_WRITE_RESULT_UNCONFIRMED") >= 0, "an already unknown write must be carried");
	assert.ok(cleanup.indexOf("uncertainWrites.add(identityKey)") >= 0);
	assert.ok(cleanup.indexOf("reads.dispose()") > cleanup.indexOf("uncertainWrites.add(identityKey)"), "record before dispose");
	// ...and the next generation adopts it before its first read, never replaying the write.
	const effect = hook.slice(hook.indexOf("const reads = createRemoteGitViewController"));
	assert.ok(effect.indexOf("if (uncertainWrites.has(identityKey)) reads.setUncertain();") >= 0);
	assert.ok(effect.indexOf("reads.setUncertain()") < effect.indexOf("reads.refresh()"), "adopt the carry before the first read");
	// Only a confirmed fact read retires it.
	assert.match(hook, /next\.loading === false && next\.errorCode === undefined && next\.snapshot !== undefined\) uncertainWrites\.delete\(identityKey\)/);
	// No replay path: the carry only publishes a state, it never calls a write verb.
	assert.ok(!/setUncertain[\s\S]{0,400}?api\.(?:mutateIndex|commit|discard|createBranch|switchBranch|fetch|push|pull)\(/.test(hook), "adopting the carry must not replay the write");
});
