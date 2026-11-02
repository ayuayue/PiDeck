import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteGitViewController } = loadTsCommonJs("src/renderer/src/utils/remoteGitViewState.ts");
const projectId = "project";
const target = { projectId, relativePath: "renamed.txt" };
const oid = (char) => char.repeat(40);
const baseRef = "refs/heads/main";
const headRef = "refs/tags/v2.0";
const compare = {
	mode: "trees",
	base: { ref: baseRef, oid: oid("a") },
	head: { ref: headRef, oid: oid("b") },
	files: [
		{ status: "M", path: "tracked.txt" },
		{ status: "R100", path: "renamed.txt", oldPath: "old.txt" },
	],
};
const groups = { merge: [], index: [], workingTree: [], untracked: [] };
const snapshot = { head: null, branch: "main", groups };
function deferred() {
	let resolve;
	const promise = new Promise((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}
function fixture(api = {}) {
	const states = [];
	const reads = createRemoteGitViewController(
		projectId,
		"identity",
		{
			cancelRemoteReads: async () => {},
			status: async () => ({ ok: true, snapshot }),
			branches: async () => ({ ok: true, info: { current: "main", branches: ["main"] } }),
			compareRefs: async () => ({ ok: true, value: compare }),
			...api,
		},
		(state) => states.push(state),
	);
	return { reads, states, current: () => states.at(-1) };
}
const plain = (value) => JSON.parse(JSON.stringify(value));

test("compare names the two full refs and publishes the bounded list", async () => {
	const calls = [];
	const f = fixture({
		compareRefs: async (...args) => {
			calls.push(args);
			return { ok: true, value: compare };
		},
	});
	await f.reads.refresh();
	await f.reads.runCompare(baseRef, headRef);
	assert.deepEqual(plain(calls), [[baseRef, headRef, ""]]);
	assert.deepEqual(plain(f.current().compare.files), compare.files);
	assert.equal(f.current().compare.mode, "trees");
	assert.equal(f.current().compareLoading, false);
	assert.equal(f.current().compareErrorCode, undefined);
});

test("the last click wins: a slower earlier answer cannot replace the newer pair", async () => {
	const first = deferred();
	const second = deferred();
	const calls = [];
	const f = fixture({
		compareRefs: () => {
			calls.push(calls.length);
			return calls.length === 1 ? first.promise : second.promise;
		},
	});
	await f.reads.refresh();
	const earlier = f.reads.runCompare("refs/heads/main", "refs/tags/v1.0");
	const later = f.reads.runCompare(baseRef, headRef);
	second.resolve({ ok: true, value: compare });
	await later;
	assert.equal(f.current().compare.head.ref, headRef);
	// The first answer arrives after the second one was published: it must be dropped, not applied late.
	first.resolve({ ok: true, value: { ...compare, head: { ref: "refs/tags/v1.0", oid: oid("c") } } });
	await earlier;
	assert.equal(f.current().compare.head.ref, headRef, "a slow earlier compare must never win");
});

test("option-like, malformed and non-local refs never reach the API", async () => {
	const calls = [];
	const f = fixture({
		compareRefs: async (...args) => {
			calls.push(args);
			return { ok: true, value: compare };
		},
	});
	await f.reads.refresh();
	for (const [base, head] of [
		["refs/heads/-x", headRef],
		["refs/heads/@", headRef],
		["HEAD", headRef],
		["refs/remotes/origin/main", headRef],
		["refs/tags/v1.0{}", headRef],
		[baseRef, "refs/heads/x..y"],
		[baseRef, "refs/heads/a b"],
		[oid("c"), headRef],
		[baseRef, undefined],
	]) {
		await f.reads.runCompare(base, head);
	}
	assert.deepEqual(calls, [], "an unusable pair is refused locally before any read");
});

test("a refusal drops compare facts; refresh and connection loss keep them in step with the snapshot", async () => {
	const refused = fixture({ compareRefs: async () => ({ ok: false, code: "GIT_REF_NOT_FOUND" }) });
	await refused.reads.refresh();
	await refused.reads.runCompare(baseRef, headRef);
	assert.equal(refused.current().compareErrorCode, "GIT_REF_NOT_FOUND");
	assert.equal(refused.current().compare, undefined);
	// A successful compare is a fact of one snapshot generation: refresh and a connection loss clear it.
	const f = fixture();
	await f.reads.refresh();
	await f.reads.runCompare(baseRef, headRef);
	assert.ok(f.current().compare);
	await f.reads.refresh();
	assert.equal(f.current().compare, undefined, "compare facts die with the snapshot facts");
	await f.reads.runCompare(baseRef, headRef);
	f.reads.invalidateConnection();
	assert.equal(f.current().compare, undefined);
	assert.equal(f.current().errorCode, "REMOTE_CONNECTION_LOST");
});

test("a helper answer whose echoed refs differ is a resource change, not a substitute list", async () => {
	const f = fixture({ compareRefs: async () => ({ ok: true, value: { ...compare, head: { ref: "refs/tags/other", oid: oid("b") } } }) });
	await f.reads.refresh();
	await f.reads.runCompare(baseRef, headRef);
	assert.equal(f.current().compare, undefined);
	assert.equal(f.current().compareErrorCode, "GIT_RESOURCE_CHANGED");
});

test("the OIDs carried by the compare answer (not the ref names) reach the per-file refFileDiff", async () => {
	const calls = [];
	const f = fixture({
		refFileDiff: async (base, head, fileTarget, repo) => {
			calls.push([base, head, fileTarget, repo]);
			return { ok: true, diff: { path: fileTarget.relativePath, target: fileTarget, displayPath: fileTarget.relativePath, base, head, originalContent: "old side", modifiedContent: "new side" } };
		},
	});
	await f.reads.refresh();
	await f.reads.runCompare(baseRef, headRef);
	const answer = f.current().compare;
	await f.reads.openHistoryFileDiff(answer.base.oid, answer.head.oid, target);
	assert.deepEqual(plain(calls), [[oid("a"), oid("b"), target, ""]]);
	assert.equal(f.current().diffKind, "revision");
	assert.equal(f.current().diff.originalContent, "old side");
	// The panel must pass the answer's OIDs; a ref name would make the per-file read resolve a moving ref again.
	const section = readFileSync("src/renderer/src/components/workspace/RemoteGitCompareSection.tsx", "utf8");
	assert.match(section, /props\.compare\?\.base\.oid/);
	assert.match(section, /props\.compare\?\.head\.oid/);
	const panel = readFileSync("src/renderer/src/components/workspace/RemoteGitPanel.tsx", "utf8");
	assert.match(panel, /onOpenFile=\{\(baseOid, headOid, path\) => openHistoryFileDiff\(baseOid, headOid,/);
});

test("compare and polling copy is present in both locales", () => {
	const zh = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts").zhCN;
	const en = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.en-US.ts").enUS;
	for (const key of ["remoteGit.compareTitle", "remoteGit.compareBase", "remoteGit.compareHead", "remoteGit.compareRun", "remoteGit.compareHint", "remoteGit.compareSameRef", "remoteGit.compareEmpty", "remoteGit.refsAutoRefresh"]) {
		assert.equal(typeof zh[key], "string", key + " zh");
		assert.equal(typeof en[key], "string", key + " en");
	}
});
