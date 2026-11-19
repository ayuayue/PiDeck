import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteGitHistoryMethods } = loadTsCommonJs("src/main/git/RemoteGitHistoryService.ts");
const { REMOTE_GIT_HISTORY_METHODS, REMOTE_GIT_RESET_MODES } = loadTsCommonJs("src/main/remote/RemoteGitHistoryContract.ts");

const HEAD = "a".repeat(40);
const TARGET = "b".repeat(40);
const grant = (kind, head = HEAD) => ({ kind, revision: "c".repeat(64), hostRevision: 3, target: { hostId: "host", remotePath: "/owned/project" }, repoPath: "", head });

/** 记录 run 收到的参数，并用同一份回执形状返回。 */
function fakeRun(reply = (params) => ({ applied: true, head: params.expectedHead })) {
	const calls = [];
	return {
		calls,
		run: async (projectId, method, params, signal, parse, expectedGrant, repo) => {
			calls.push({ projectId, method, params, signal, expectedGrant, repo });
			return parse(reply(params));
		},
	};
}

test("every verb names its own helper method and sends the confirmed head", async () => {
	const fake = fakeRun();
	const history = createRemoteGitHistoryMethods({ run: fake.run });
	await history.cherryPick("project", TARGET, grant("cherryPick"), "");
	await history.revert("project", TARGET, grant("revert"), "");
	await history.reset("project", TARGET, "hard", grant("reset"), "");
	await history.dropCommit("project", TARGET, grant("dropCommit"), "");
	assert.deepEqual(
		fake.calls.map((call) => call.method),
		[...REMOTE_GIT_HISTORY_METHODS],
	);
	// vm 上下文里的对象原型与宿主不同，比较序列化结果而不是引用结构。
	assert.equal(
		JSON.stringify(fake.calls.map((call) => call.params)),
		JSON.stringify([
			{ hash: TARGET, expectedHead: HEAD },
			{ hash: TARGET, expectedHead: HEAD },
			{ hash: TARGET, expectedHead: HEAD, mode: "hard" },
			{ hash: TARGET, expectedHead: HEAD },
		]),
	);
	assert.equal(fake.calls[2].expectedGrant.kind, "reset");
});

test("a grant for another action never reaches the helper", () => {
	const fake = fakeRun();
	const history = createRemoteGitHistoryMethods({ run: fake.run });
	// 令牌种类与动作不一致是调用方 bug：在触达会话前拒绝，且不消耗任何东西。
	assert.throws(() => history.cherryPick("project", TARGET, grant("revert"), ""), /GIT_RESULT_INVALID/);
	assert.throws(() => history.dropCommit("project", TARGET, grant("drop"), ""), /GIT_RESULT_INVALID/);
	assert.equal(fake.calls.length, 0);
});

test("a grant without a confirmed head cannot start a history write", () => {
	const fake = fakeRun();
	const history = createRemoteGitHistoryMethods({ run: fake.run });
	assert.throws(() => history.cherryPick("project", TARGET, grant("cherryPick", null), ""), /GIT_COMMIT_HEAD_CHANGED/);
	assert.throws(() => history.reset("project", TARGET, "soft", { ...grant("reset"), head: undefined }, ""), /GIT_COMMIT_HEAD_CHANGED/);
	assert.equal(fake.calls.length, 0);
});

test("only full object ids are accepted, and only the three reset modes", async () => {
	const fake = fakeRun();
	const history = createRemoteGitHistoryMethods({ run: fake.run });
	for (const value of [TARGET.slice(0, 7), "HEAD", `${TARGET} `, "", null, 42]) {
		assert.throws(() => history.cherryPick("project", value, grant("cherryPick"), ""), /GIT_RESULT_INVALID/);
	}
	assert.deepEqual([...REMOTE_GIT_RESET_MODES], ["soft", "mixed", "hard"]);
	for (const mode of ["keep", "", "HARD", null]) {
		assert.throws(() => history.reset("project", TARGET, mode, grant("reset"), ""), /GIT_RESULT_INVALID/);
	}
	assert.equal(fake.calls.length, 0);
	await history.reset("project", TARGET, "mixed", grant("reset"), "");
	assert.equal(fake.calls.length, 1);
});

test("the helper's reply must be exactly the confirmed commit it promised", async () => {
	const history = (reply) => createRemoteGitHistoryMethods({ run: fakeRun(reply).run });
	// 回执在异步路径里校验，所以用 rejects 而不是 throws。
	await assert.rejects(history(() => ({ applied: true, head: "abc" })).revert("project", TARGET, grant("revert"), ""), /GIT_RESULT_INVALID/);
	await assert.rejects(history(() => ({ applied: true, head: HEAD, extra: 1 })).revert("project", TARGET, grant("revert"), ""), /GIT_RESULT_INVALID/);
	await assert.rejects(history(() => ({ applied: false, head: HEAD })).revert("project", TARGET, grant("revert"), ""), /GIT_RESULT_INVALID/);
	await assert.doesNotReject(history(() => ({ applied: true, head: HEAD })).revert("project", TARGET, grant("revert"), ""));
});
