import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { previewApiSource } from "./helpers/previewApiSources.mjs";
import { preloadSource } from "./helpers/preloadSources.mjs";

const { createRemoteGitViewController } = loadTsCommonJs("src/renderer/src/utils/remoteGitViewState.ts");
const { remoteGitErrorMessage } = loadTsCommonJs("src/renderer/src/utils/gitErrorPresentation.ts");
const projectId = "project";
const untrackedSnapshot = {
	head: null,
	branch: "master",
	groups: {
		merge: [],
		index: [],
		workingTree: [],
		untracked: [{ path: "hello.txt", target: { projectId, relativePath: "hello.txt" }, displayPath: "hello.txt", status: 7, letter: "U" }],
	},
};
const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture(api = {}) {
	const states = [];
	const reads = createRemoteGitViewController(
		projectId,
		"identity",
		{
			cancelRemoteReads: async () => {},
			status: async () => ({ ok: false, code: "GIT_NOT_REPOSITORY" }),
			refresh: async () => ({ ok: false, code: "GIT_NOT_REPOSITORY" }),
			branches: async () => ({ ok: true, info: { current: "master", branches: ["master"] } }),
			init: async () => ({ ok: true, branch: "master" }),
			...api,
		},
		(state) => states.push(state),
	);
	return { reads, states, current: () => states.at(-1) };
}
function deferred() {
	let resolve;
	const promise = new Promise((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

test("init starts from a confirmed non-repository and only reports itself after a fresh snapshot", async () => {
	const calls = { snapshot: 0, init: 0 };
	const f = fixture({
		status: async () => {
			calls.snapshot += 1;
			return calls.snapshot === 1 ? { ok: false, code: "GIT_NOT_REPOSITORY" } : { ok: true, snapshot: untrackedSnapshot };
		},
		init: async () => {
			calls.init += 1;
			return { ok: true, branch: "master" };
		},
	});
	await f.reads.refresh();
	assert.equal(f.current().errorCode, "GIT_NOT_REPOSITORY");
	assert.equal(f.current().snapshot, undefined);
	await f.reads.initRepository();
	assert.equal(calls.init, 1);
	assert.equal(calls.snapshot, 2, "a successful init is reported by re-reading the repository");
	assert.equal(f.current().errorCode, undefined, "the not-repository error must disappear after the refresh");
	assert.ok(!f.current().initializing, "the initializing state must be cleared after the refresh");
	assert.equal(f.current().mutating, undefined);
	assert.deepEqual(plain(f.current().initNotice), { branch: "master" });
	// The refreshed facts are the new repository: the pre-existing file is the untracked change the user sees.
	assert.deepEqual(plain(f.current().snapshot.groups.untracked.map((resource) => resource.path)), ["hello.txt"]);
});

test("init only runs for a confirmed non-repository", async () => {
	const calls = { init: 0 };
	const f = fixture({
		status: async () => ({ ok: true, snapshot: untrackedSnapshot }),
		init: async () => {
			calls.init += 1;
			return { ok: true, branch: "master" };
		},
	});
	await f.reads.refresh();
	await f.reads.initRepository();
	assert.equal(calls.init, 0, "an ordinary repository must not offer the init write");
	const refused = fixture({ status: async () => ({ ok: false, code: "GIT_TRUST_REQUIRED" }) });
	await refused.reads.refresh();
	await refused.reads.initRepository();
	assert.equal(calls.init, 0, "a trust refusal is not a non-repository confirmation");
});

test("a refusal drops the stale facts and exposes the stable code instead of refreshing", async () => {
	const calls = { snapshot: 0, init: 0 };
	const f = fixture({
		status: async () => {
			calls.snapshot += 1;
			return { ok: false, code: "GIT_NOT_REPOSITORY" };
		},
		init: async () => {
			calls.init += 1;
			return { ok: false, code: "GIT_REPO_EXISTS" };
		},
	});
	await f.reads.refresh();
	await f.reads.initRepository();
	assert.equal(f.current().errorCode, "GIT_REPO_EXISTS");
	assert.equal(f.current().snapshot, undefined);
	assert.equal(f.current().initNotice, undefined);
	assert.equal(calls.snapshot, 1, "a refusal must not be disguised by a refresh");
});

test("an unknown result keeps the uncertainty warning, never retries, and only an explicit successful refresh clears it", async () => {
	const calls = { init: 0, snapshot: 0 };
	let snapshotOk = false;
	const f = fixture({
		status: async () => {
			calls.snapshot += 1;
			return snapshotOk ? { ok: true, snapshot: untrackedSnapshot } : { ok: false, code: "GIT_NOT_REPOSITORY" };
		},
		init: async () => {
			calls.init += 1;
			throw new Error("REMOTE_CONNECTION_LOST");
		},
	});
	await f.reads.refresh();
	await f.reads.initRepository();
	assert.equal(f.current().errorCode, "GIT_WRITE_RESULT_UNCONFIRMED");
	assert.equal(f.current().initNotice, undefined);
	assert.equal(calls.init, 1, "a write is never replayed");
	assert.equal(calls.snapshot, 1, "an unknown result is not auto-refreshed");
	// A refresh that also fails must retain the uncertainty; the warning is not downgraded to a read failure.
	await f.reads.refresh();
	assert.equal(f.current().errorCode, "GIT_WRITE_RESULT_UNCONFIRMED");
	// Only fresh repository facts clear it.
	snapshotOk = true;
	await f.reads.refresh();
	assert.equal(f.current().errorCode, undefined);
	assert.deepEqual(plain(f.current().snapshot.groups.untracked.map((resource) => resource.path)), ["hello.txt"]);
	assert.equal(calls.init, 1);
});

test("init is single-flight: a second click while one request is in flight is ignored", async () => {
	const pending = deferred();
	let initCalls = 0;
	let snapshotCalls = 0;
	const f = fixture({
		status: async () => {
			snapshotCalls += 1;
			return snapshotCalls === 1 ? { ok: false, code: "GIT_NOT_REPOSITORY" } : { ok: true, snapshot: untrackedSnapshot };
		},
		init: () => {
			initCalls += 1;
			return pending.promise;
		},
	});
	await f.reads.refresh();
	const first = f.reads.initRepository();
	const second = f.reads.initRepository();
	pending.resolve({ ok: true, branch: "master" });
	await Promise.all([first, second]);
	assert.equal(initCalls, 1);
});

test("a slow init answer arriving after a connection loss is retired, never published", async () => {
	const pending = deferred();
	let initCalls = 0;
	let snapshotCalls = 0;
	const f = fixture({
		status: async () => {
			snapshotCalls += 1;
			return { ok: false, code: "GIT_NOT_REPOSITORY" };
		},
		init: () => {
			initCalls += 1;
			return pending.promise;
		},
	});
	await f.reads.refresh();
	const flight = f.reads.initRepository();
	f.reads.invalidateConnection();
	pending.resolve({ ok: true, branch: "master" });
	await flight;
	assert.equal(initCalls, 1);
	assert.equal(snapshotCalls, 1, "a stale init answer must not trigger a refresh");
	assert.equal(f.current().errorCode, "GIT_WRITE_RESULT_UNCONFIRMED", "the uncertainty survives the connection transition");
	assert.equal(f.current().initNotice, undefined);
});

test("the panel and the dictionaries carry the explicit init action without pretending it is automatic", () => {
	const panel = readFileSync("src/renderer/src/components/workspace/RemoteGitPanel.tsx", "utf8");
	// The not-repository anchor is attached conditionally (the same testid e2e locates); the init anchors are static.
	assert.ok(panel.includes('"remote-git-not-repository"'), "remote-git-not-repository");
	for (const id of ["remote-git-init", "remote-git-init-confirm", "remote-git-init-cancel", "remote-git-init-outcome"]) assert.match(panel, new RegExp('data-testid="' + id + '"'), id);
	assert.match(panel, /GIT_NOT_REPOSITORY[\s\S]{0,1200}?initRepository\(/, "the init section is gated on the confirmed non-repository state");
	const zh = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts").zhCN;
	const en = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.en-US.ts").enUS;
	assert.equal(remoteGitErrorMessage("GIT_REPO_EXISTS"), zh["remoteGit.repoExists"], "the refusal has its own copy");
	for (const key of ["remoteGit.initHint", "remoteGit.initAction", "remoteGit.initConfirm", "remoteGit.initConfirmAction", "remoteGit.initCancel", "remoteGit.initializing", "remoteGit.initCreated", "remoteGit.repoExists"]) {
		assert.equal(typeof zh[key], "string", key + " zh");
		assert.equal(typeof en[key], "string", key + " en");
	}
	// The existing copy stays honest: no automatic initialization, no parent discovery - now plus the explicit action.
	assert.match(zh["remoteGit.notRepository"], /不会自动初始化/);
	assert.match(zh["remoteGit.notRepository"], /不.*搜索父目录/);
	assert.match(zh["remoteGit.notRepository"], /显式初始化/);
	assert.match(en["remoteGit.notRepository"], /never initializes automatically/);
	assert.match(en["remoteGit.notRepository"], /parent director/i);
	assert.match(en["remoteGit.notRepository"], /explicitly/i);
});

test("the init channel is wired through all four layers", () => {
	assert.match(readFileSync("src/shared/ipc.ts", "utf8"), /gitRemoteInit:\s*"git:remote-init"/);
	assert.match(preloadSource, /initRemote:\s*\(projectId: string\)\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.gitRemoteInit/);
	assert.match(previewApiSource, /initRemote:\s*async \(\) => \(\{ ok: false, code: "REMOTE_FEATURE_DISABLED" \}\)/);
	assert.match(readFileSync("src/main/ipc/remoteGitReadIpc.ts", "utf8"), /ipcMain\.handle\(ipcChannels\.gitRemoteInit/);
});
