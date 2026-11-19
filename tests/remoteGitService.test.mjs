import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteGitService, readRemoteGitStatus, readRemoteGitRepos, validateRemoteGitPath, validateRemoteGitRepoPath } = loadTsCommonJs("src/main/git/RemoteGitService.ts");
const { REMOTE_GIT_READ_TIMEOUT_MS, REMOTE_GIT_SYNC_TIMEOUT_MS } = loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");
const { GitStatus } = loadTsCommonJs("src/shared/types/git.ts");
const projectId = "project-a";
const oid = "a".repeat(40);
const locator = { hostId: "host-a", remotePath: "/work/project-a" };
const encode = (raw) => ({ status: Buffer.from(raw).toString("base64"), head: oid, branch: "main" });
const plain = (value) => JSON.parse(JSON.stringify(value));
/** A main-owned grant; repoPath is part of its identity (G5e). */
const expectation = (kind, repoPath = "") => ({ kind, revision: "f".repeat(64), hostRevision: 1, target: locator, repoPath });

/** Bound substitute records protocol traffic; it never exposes a local cwd or fs operation. */
function fixture(overrides = {}) {
	const calls = [];
	const session = {
		request: async (method, params, options) => {
			calls.push({ method, params, timeoutMs: options?.timeoutMs });
			options?.onRequestId?.(`request-${calls.length}`);
			if (method === "hello") return { protocolVersion: 1, root: locator.remotePath, capabilities: ["git.status", "git.workspaceDiff"] };
			if (method === "git.workspaceDiff") return { originalContent: "old\n", modifiedContent: "new\n" };
			return encode("MM tracked.txt\0?? 中文 file.txt\0");
		},
		cancel: async (id) => {
			calls.push({ method: "cancel", id });
		},
	};
	const ports = { locator: () => locator, trusted: async () => true, withProject: async (target, task) => task(session), ...overrides };
	return { calls, ports, session, service: createRemoteGitService(ports) };
}

/**
 * push/pull 的 upstream 模式：与本机 `git push` / `git pull` 一致——不给 remote/branch 就跟随分支已配置的
 * 上游（多 remote 或 detached HEAD 时不再替用户拒绝）。显式模式仍然是「恰好 <remote> <branch>」。
 */
test("push/pull upstream mode sends null remote/branch and accepts a renamed remote-side refspec", async () => {
	const calls = [];
	const session = {
		// 授权绑定的是「读出快照时的那一代」；假会话必须报同一代，否则 run 会先拒绝。
		hostRevision: 1,
		request: async (method, params) => {
			calls.push({ method, params });
			if (method === "hello") return { protocolVersion: 1, root: locator.remotePath, capabilities: ["git.push", "git.pull"] };
			if (method === "git.push") return { applied: true, outcome: "pushed", refspec: "refs/heads/main:refs/heads/release" };
			if (method === "git.pull") return { applied: true, mode: "fast-forward", head: oid };
			throw new Error("unexpected method " + method);
		},
		cancel: async () => {},
	};
	const service = createRemoteGitService({ locator: () => locator, trusted: async () => true, withProject: async (target, task) => task(session) });
	const pushed = await service.push(projectId, null, null, expectation("push"), "");
	assert.equal(pushed.refspec, "refs/heads/main:refs/heads/release");
	assert.deepEqual(plain(calls.find((call) => call.method === "git.push").params), { remote: null, branch: null, expectedRevision: expectation("push").revision });
	const pulled = await service.pull(projectId, null, null, expectation("pull"), "");
	assert.equal(pulled.mode, "fast-forward");
	assert.deepEqual(plain(calls.find((call) => call.method === "git.pull").params), { remote: null, branch: null, expectedRevision: expectation("pull").revision });
	// 混合 null/字符串是调用方 bug：在触达会话之前就拒绝。
	await assert.rejects(async () => service.push(projectId, null, "main", expectation("push"), ""), /GIT_RESULT_INVALID/);
	await assert.rejects(async () => service.pull(projectId, "origin", null, expectation("pull"), ""), /GIT_RESULT_INVALID/);
});

test("push 拒绝非法 refspec：显式模式必须同名，upstream 模式只允许合法的 refs/heads 形态", async () => {
	const make = (refspec) =>
		createRemoteGitService({
			locator: () => locator,
			trusted: async () => true,
			withProject: async (target, task) =>
				task({
					hostRevision: 1,
					request: async (method) => {
						if (method === "hello") return { protocolVersion: 1, root: locator.remotePath, capabilities: ["git.push"] };
						return { applied: true, outcome: "pushed", refspec };
					},
					cancel: async () => {},
				}),
		});
	// 显式模式只接受同名 refspec；答案不可解析时同样只能报 UNCONFIRMED（写已发出）。
	await assert.rejects(async () => make("refs/heads/other:refs/heads/other").push(projectId, "origin", "main", expectation("push"), ""), /GIT_WRITE_RESULT_UNCONFIRMED/);
	// upstream 模式允许远端侧重命名；答案不可解析时写已经发出，只能是 UNCONFIRMED（绝不重放）。
	await assert.rejects(async () => make("main:release").push(projectId, null, null, expectation("push"), ""), /GIT_WRITE_RESULT_UNCONFIRMED/);
	await assert.rejects(async () => make("refs/heads/main").push(projectId, null, null, expectation("push"), ""), /GIT_WRITE_RESULT_UNCONFIRMED/);
	assert.equal((await make("refs/heads/main:refs/heads/release").push(projectId, null, null, expectation("push"), "")).refspec, "refs/heads/main:refs/heads/release");
});

test("remote status reuses local SCM semantics and emits only project-relative targets", () => {
	const result = readRemoteGitStatus(encode("MM tracked.txt\0R  current.txt\0old.txt\0?? 中文 file.txt\0UU conflict.txt\0"), projectId);
	assert.equal(result.groups.index.length, 2);
	assert.equal(result.groups.workingTree.length, 1);
	assert.equal(result.groups.merge[0].status, GitStatus.BOTH_MODIFIED);
	assert.equal(result.groups.index[0].status, GitStatus.INDEX_MODIFIED);
	assert.equal(result.groups.workingTree[0].status, GitStatus.MODIFIED);
	assert.deepEqual(plain(result.groups.index[1].oldTarget), { projectId, relativePath: "old.txt" });
	assert.deepEqual(plain(result.groups.untracked[0].target), { projectId, relativePath: "中文 file.txt" });
	assert.equal(result.head, oid);
	assert.equal(result.branch, "main");
});

test("remote intent-to-add appears in workingTree without confusing rename old paths", () => {
	const result = readRemoteGitStatus(encode(" A intent.txt\0R  renamed.txt\0 A old-name\0"), projectId);
	assert.equal(result.groups.workingTree.length, 1);
	assert.equal(result.groups.workingTree[0].path, "intent.txt");
	assert.equal(result.groups.workingTree[0].status, GitStatus.INTENT_TO_ADD);
	assert.equal(result.groups.index[0].oldPath, " A old-name");
});

test("remote status rejects truncated records, invalid base64, UTF-8 and path escapes", () => {
	for (const value of [
		encode(" M missing-terminator"),
		encode("R  only-current.txt\0"),
		encode("?? ../outside\0"),
		encode("ZZ unknown.txt\0"),
		{ ...encode(""), status: "%%%%" },
		{ ...encode(""), status: Buffer.from([0xc3, 0x28]).toString("base64") },
		{ ...encode(""), head: "HEAD" },
		{ ...encode(""), branch: undefined },
	]) {
		assert.throws(() => readRemoteGitStatus(value, projectId));
	}
});

test("remote filenames retain literal pathspec punctuation while control and option-like paths are refused", () => {
	assert.equal(validateRemoteGitPath("dir/[literal]* file.txt"), "dir/[literal]* file.txt");
	for (const value of ["-option.txt", "/absolute", "../outside", "dir/../file", "dir\\file", "a\nline", "C:/file", ".", "", "%2e%2e/file"]) assert.throws(() => validateRemoteGitPath(value), /PATH_OUTSIDE_ROOT/);
});

test("untrusted remote repository issues no helper request and does not connect", async () => {
	let entered = false;
	const { calls, service } = fixture({
		trusted: async () => false,
		withProject: async () => {
			entered = true;
		},
	});
	await assert.rejects(service.status(projectId), /GIT_TRUST_REQUIRED/);
	assert.equal(entered, false);
	assert.equal(calls.length, 0);
});

test("old helper lacking Git capability is refused without issuing a Git operation", async () => {
	const f = fixture();
	f.session.request = async (method) => {
		f.calls.push({ method });
		return { protocolVersion: 1, root: locator.remotePath, capabilities: ["fs.read"] };
	};
	await assert.rejects(f.service.status(projectId), /UNSUPPORTED_CAPABILITY/);
	assert.deepEqual(
		f.calls.map((call) => call.method),
		["hello"],
	);
});

test("queued host operation rechecks trust at the actual Git request boundary", async () => {
	let checks = 0;
	const f = fixture({ trusted: async () => ++checks === 1 });
	await assert.rejects(f.service.status(projectId), /GIT_TRUST_REQUIRED/);
	assert.deepEqual(
		f.calls.map((call) => call.method),
		["hello"],
	);
});

test("project locator drift during trust resolution refuses the host operation", async () => {
	const current = { ...locator };
	let entered = false;
	const f = fixture({
		locator: () => current,
		trusted: async () => {
			current.hostId = "host-b";
			return true;
		},
		withProject: async () => {
			entered = true;
		},
	});
	await assert.rejects(f.service.status(projectId), /GIT_TARGET_CHANGED/);
	assert.equal(entered, false);
});

test("project locator drift while helper responds discards the stale result", async () => {
	const current = { ...locator };
	const f = fixture({ locator: () => current });
	const original = f.session.request;
	f.session.request = async (...args) => {
		const value = await original(...args);
		if (args[0] === "git.status") current.remotePath = "/work/replaced";
		return value;
	};
	await assert.rejects(f.service.status(projectId), /GIT_TARGET_CHANGED/);
});

test("remote workspace diff preserves the requested scope and verifies response byte budgets", async () => {
	const f = fixture();
	const file = { projectId, relativePath: "dir/space name.txt" };
	const result = await f.service.workspaceDiff(projectId, "index", file);
	assert.deepEqual(plain(result.target), file);
	assert.equal(result.originalContent, "old\n");
	assert.deepEqual(plain(f.calls[1].params), { group: "index", path: file.relativePath });
	f.session.request = async (method) => (method === "hello" ? { protocolVersion: 1, root: locator.remotePath, capabilities: ["git.workspaceDiff"] } : { originalContent: "a".repeat(262145), modifiedContent: "" });
	await assert.rejects(f.service.workspaceDiff(projectId, "index", file), /GIT_RESULT_INVALID/);
	assert.throws(() => f.service.workspaceDiff(projectId, "index", { ...file, projectId: "other" }), /GIT_RESULT_INVALID/);
});

test("raw remote diagnostics cannot become IPC error messages", async () => {
	const f = fixture({
		withProject: async () => {
			throw new Error("private path or credential diagnostic");
		},
	});
	await assert.rejects(f.service.status(projectId), (error) => error.message === "GIT_COMMAND_FAILED");
});

test("aborting a read cancels its exact request and discards any late success", async () => {
	const f = fixture();
	const controller = new AbortController();
	f.session.request = async (method, params, options) => {
		f.calls.push({ method });
		if (method === "hello") return { protocolVersion: 1, root: locator.remotePath, capabilities: ["git.status"] };
		options.onRequestId("exact-read-id");
		controller.abort();
		return encode("");
	};
	await assert.rejects(f.service.status(projectId, "", controller.signal), /REQUEST_CANCELLED/);
	assert.deepEqual(
		f.calls.filter((call) => call.method === "cancel"),
		[{ method: "cancel", id: "exact-read-id" }],
	);
	f.calls.length = 0;
	await assert.rejects(f.service.status(projectId, "", controller.signal), /REQUEST_CANCELLED/);
	assert.equal(f.calls.length, 0);
});

test("network verbs carry the sync budget while every other Git method keeps the read budget", async () => {
	const f = fixture();
	f.session.hostRevision = 1;
	const capabilities = ["git.status", "git.log", "git.fetch", "git.push", "git.pull"];
	f.session.request = async (method, params, options) => {
		f.calls.push({ method, params, timeoutMs: options?.timeoutMs });
		options?.onRequestId?.("request-" + f.calls.length);
		if (method === "hello") return { protocolVersion: 1, root: locator.remotePath, capabilities };
		if (method === "git.status") return encode(" M tracked.txt\0");
		if (method === "git.log") return { commits: [], hasMore: false };
		if (method === "git.fetch") return { applied: true, upToDate: true, updated: [] };
		if (method === "git.push") return { applied: true, outcome: "up-to-date", refspec: "refs/heads/main:refs/heads/main" };
		if (method === "git.pull") return { applied: true, mode: "up-to-date", head: oid };
		throw new Error("unexpected method " + method);
	};
	await f.service.status(projectId);
	await f.service.log(projectId);
	await f.service.fetch(projectId, "origin", expectation("fetch"));
	await f.service.push(projectId, "origin", "main", expectation("push"));
	await f.service.pull(projectId, "origin", "main", expectation("pull"));
	const byMethod = new Map(f.calls.map((call) => [call.method, call.timeoutMs]));
	// G5a follow-up (plan §5.16.2): the 30s read deadline used to be passed to every method, truncating the
	// contract's 10-minute network budget before it ever left main.
	assert.equal(REMOTE_GIT_SYNC_TIMEOUT_MS, 600_000);
	assert.equal(byMethod.get("git.status"), REMOTE_GIT_READ_TIMEOUT_MS);
	assert.equal(byMethod.get("git.log"), REMOTE_GIT_READ_TIMEOUT_MS);
	assert.equal(byMethod.get("hello"), REMOTE_GIT_READ_TIMEOUT_MS);
	for (const method of ["git.fetch", "git.push", "git.pull"]) assert.equal(byMethod.get(method), REMOTE_GIT_SYNC_TIMEOUT_MS, method);
});

test("a repository scope travels on read and write frames but never on hello", async () => {
	const f = fixture();
	f.session.hostRevision = 1;
	const capabilities = ["git.status", "git.log", "git.fetch", "git.push"];
	f.session.request = async (method, params, options) => {
		f.calls.push({ method, params, repo: options?.repo, timeoutMs: options?.timeoutMs });
		options?.onRequestId?.("request-" + f.calls.length);
		if (method === "hello") return { protocolVersion: 1, root: locator.remotePath, capabilities };
		if (method === "git.status") return encode(" M tracked.txt\0");
		if (method === "git.log") return { commits: [], hasMore: false };
		if (method === "git.fetch") return { applied: true, upToDate: true, updated: [] };
		if (method === "git.push") return { applied: true, outcome: "up-to-date", refspec: "refs/heads/main:refs/heads/main" };
		throw new Error("unexpected method " + method);
	};
	const scoped = "packages/nested";
	await f.service.status(projectId, scoped);
	await f.service.log(projectId, {}, scoped);
	await f.service.fetch(projectId, "origin", expectation("fetch", scoped), scoped);
	await f.service.push(projectId, "origin", "main", expectation("push", scoped), scoped);
	const byMethod = new Map(f.calls.map((call) => [call.method, call.repo]));
	assert.equal(byMethod.get("hello"), undefined, "the handshake names no repository");
	for (const method of ["git.status", "git.log", "git.fetch", "git.push"]) assert.equal(byMethod.get(method), scoped, method + " must carry the selected repository");
	// A root scope keeps the pre-G5d frame: no repo option at all, and a root grant names "".
	f.calls.length = 0;
	await f.service.status(projectId);
	await f.service.fetch(projectId, "origin", expectation("fetch"), "");
	assert.equal(f.calls.find((call) => call.method === "git.status").repo, undefined);
	assert.equal(f.calls.find((call) => call.method === "git.fetch").repo, undefined);
});

test("every scope mints grants bound to its own repository, and a cross-scope grant is refused before any host work", async () => {
	const f = fixture();
	f.session.hostRevision = 1;
	const capabilities = ["git.status", "git.stage", "git.unstage", "git.commit", "git.createBranch", "git.switchBranch", "git.discard", "git.recoveryRestore", "git.recoveryDrop", "git.fetch", "git.push", "git.pull"];
	f.session.request = async (method) => {
		if (method === "hello") return { protocolVersion: 1, root: locator.remotePath, capabilities };
		return { ...encode(""), revision: "a".repeat(64) };
	};
	const nested = await f.service.status(projectId, "packages/nested");
	for (const field of ["writeExpectation", "commitExpectation", "branchExpectation", "switchExpectation", "discardExpectation", "restoreExpectation", "dropExpectation", "fetchExpectation", "pushExpectation", "pullExpectation"]) {
		assert.ok(nested[field], field + " must be issued for a nested snapshot");
		assert.equal(nested[field].repoPath, "packages/nested", field + " must name the nested scope");
		assert.equal(nested[field].kind, field.replace("Expectation", "").replace("write", "index"));
	}
	const root = await f.service.status(projectId, "");
	assert.ok(root.writeExpectation && root.commitExpectation && root.fetchExpectation, "the root scope keeps its grants");
	assert.equal(root.writeExpectation.repoPath, "", "the root grant names the project root");
	// A nested grant used against the root scope (and vice versa) is refused before the locator/trust/withProject boundary.
	f.calls.length = 0;
	await assert.rejects(f.service.fetch(projectId, "origin", { ...nested.fetchExpectation }, ""), /GIT_TARGET_CHANGED/);
	await assert.rejects(f.service.fetch(projectId, "origin", { ...root.fetchExpectation }, "packages/nested"), /GIT_TARGET_CHANGED/);
	assert.equal(f.calls.length, 0, "a cross-scope grant must not queue any host work");
});

test("listRepositories is a bounded read with no scope or token on the frame", async () => {
	const f = fixture();
	f.session.request = async (method, params, options) => {
		f.calls.push({ method, params, repo: options?.repo });
		options?.onRequestId?.("request-" + f.calls.length);
		if (method === "hello") return { protocolVersion: 1, root: locator.remotePath, capabilities: ["git.repos"] };
		if (method === "git.repos")
			return {
				repos: [
					{ path: "", name: "project" },
					{ path: "packages/nested", name: "nested" },
				],
				truncated: true,
			};
		throw new Error("unexpected method " + method);
	};
	assert.deepEqual(plain(await f.service.listRepositories(projectId)), {
		repos: [
			{ path: "", name: "project" },
			{ path: "packages/nested", name: "nested" },
		],
		truncated: true,
	});
	assert.deepEqual(
		f.calls.map((call) => call.method),
		["hello", "git.repos"],
	);
	assert.equal(f.calls[1].repo, undefined, "discovery has no repository scope");
	assert.deepEqual(plain(f.calls[1].params), {});
});

test("an old helper without git.repos is refused with zero discovery work", async () => {
	const f = fixture();
	f.session.request = async (method) => {
		f.calls.push({ method });
		return { protocolVersion: 1, root: locator.remotePath, capabilities: ["git.status"] };
	};
	await assert.rejects(f.service.listRepositories(projectId), /UNSUPPORTED_CAPABILITY/);
	assert.deepEqual(
		f.calls.map((call) => call.method),
		["hello"],
	);
});

test("discovery replies are re-validated: duplicates, escapes, bounds and shape are refused", async () => {
	const cases = [
		{
			repos: [
				{ path: "", name: "project" },
				{ path: "", name: "again" },
			],
			truncated: false,
		},
		{ repos: [{ path: "../outside", name: "escape" }], truncated: false },
		{ repos: [{ path: "nested/.git", name: "metadata" }], truncated: false },
		{ repos: [{ path: "nested", name: "" }], truncated: false },
		{ repos: [{ path: "nested", name: "a\0b" }], truncated: false },
		{ repos: [{ path: "nested", name: "nested", extra: true }], truncated: false },
		{ repos: [], truncated: "yes" },
		{ repos: Array.from({ length: 51 }, (_, index) => ({ path: "r" + index, name: "r" })), truncated: false },
		{ repos: [], truncated: false, extra: 1 },
	];
	for (const reply of cases) {
		const f = fixture();
		f.session.request = async (method) => (method === "hello" ? { protocolVersion: 1, root: locator.remotePath, capabilities: ["git.repos"] } : reply);
		await assert.rejects(f.service.listRepositories(projectId), (error) => error.message === "GIT_RESULT_INVALID", JSON.stringify(reply).slice(0, 80));
	}
});

test("the repository scope rule matches the frozen helper rule", () => {
	for (const value of ["", undefined, null, "packages/nested", "a/b/c", "目录 空格"]) assert.equal(validateRemoteGitRepoPath(value), value === undefined ? "" : value === null ? "" : value);
	for (const value of ["/absolute", "../outside", "a/../b", "a\\b", "C:/drive", "-option", "dir/.git", "x.lock/y", "a\0b", "a".repeat(4097), 7]) assert.throws(() => validateRemoteGitRepoPath(value), /GIT_RESULT_INVALID/, String(value));
	const valid = { repos: [{ path: "", name: "project" }], truncated: false };
	assert.deepEqual(plain(readRemoteGitRepos(valid)), valid);
});
