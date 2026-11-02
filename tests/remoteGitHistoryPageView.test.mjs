import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteGitViewController } = loadTsCommonJs("src/renderer/src/utils/remoteGitViewState.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

const commit = (oid, authorTimeMs) => ({
	oid,
	parents: [],
	subject: `commit ${oid}`,
	authorName: "Dev",
	authorEmail: "dev@example.com",
	authorTimeMs,
});

function harness(historyPage) {
	const calls = [];
	const states = [];
	const api = {
		historyPage: async (options, repo) => {
			calls.push({ options, repo });
			return historyPage(options, repo);
		},
	};
	const controller = createRemoteGitViewController("project-1", "key-1", api, (state) => states.push(state), "");
	const last = () => states.at(-1);
	return { controller, calls, states, last };
}

test("公共 historyPage 的 authorTimeMs 转成面板使用的秒，分页 skip 原样透传", async () => {
	const testHarness = harness(async () => ({ ok: true, value: { commits: [commit("a".repeat(40), 1_700_000_123_456)], hasMore: true } }));
	await testHarness.controller.loadHistory();
	assert.deepEqual(plain(testHarness.calls[0].options), { maxCount: 50 });
	assert.equal(testHarness.calls[0].repo, "");
	assert.equal(testHarness.last().history.commits[0].authorTimeSec, 1_700_000_123);
	assert.equal(testHarness.last().history.hasMore, true);

	await testHarness.controller.loadMoreHistory();
	assert.deepEqual(plain(testHarness.calls[1].options), { maxCount: 50, skip: 1 });
});

test("增量页失败保留已显示的行；下一次整页加载才替换", async () => {
	let fail = false;
	const testHarness = harness(async (_options) => {
		if (fail) return { ok: false, code: "SSH_HOST_DISCONNECTED" };
		return { ok: true, value: { commits: [commit("b".repeat(40), 1_700_000_000_000)], hasMore: _options.skip === undefined } };
	});
	await testHarness.controller.loadHistory();
	fail = true;
	await testHarness.controller.loadMoreHistory();
	assert.equal(testHarness.last().historyErrorCode, "SSH_HOST_DISCONNECTED");
	assert.equal(testHarness.last().history.commits.length, 1);
	assert.equal(testHarness.last().historyLoading, false);
	assert.equal(testHarness.last().historyMoreLoading, false);
});

test("历史只有公共 historyPage 一个读法：没有第二通道，也不会换一条兼容壳重读", async () => {
	const states = [];
	const controller = createRemoteGitViewController("project-1", "key-1", {}, (state) => states.push(state), "");
	await controller.loadHistory();
	assert.equal(states.at(-1).historyErrorCode, "GIT_COMMAND_FAILED", "a missing read entry is a bounded failure, not a silent fallback");
	assert.equal(states.at(-1).history, undefined);
});
