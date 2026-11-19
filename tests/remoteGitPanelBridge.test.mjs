import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteGitPanelBridge } = loadTsCommonJs("src/renderer/src/components/workspace/remoteGitPanelBridge.ts");
const { zhCN } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

const projectId = "project-1";
const root = { projectId, relativePath: "" };
const nested = { projectId, relativePath: "packages/nested" };
const target = { projectId, relativePath: "src/a.ts" };
const oid = (letter) => letter.repeat(40);

/** ProjectGitService 的假实现：记录每次调用的完整参数，默认全部成功。 */
function fakeService(overrides = {}) {
	const calls = [];
	const record =
		(name, result) =>
		async (...args) => {
			calls.push([name, ...args]);
			return result;
		};
	const git = {
		status: record("status", { merge: [], index: [], workingTree: [], untracked: [] }),
		refresh: record("refresh", { merge: [], index: [], workingTree: [], untracked: [] }),
		history: record("history", { commits: [], hasMore: false }),
		commitDetail: record("commitDetail", { oid: oid("a"), parents: [], authorName: "A", authorEmail: "a@e", authorTimeSec: 10, committerName: "A", committerEmail: "a@e", committerTimeSec: 10, subject: "s", message: "s\n", files: [] }),
		compare: record("compare", { mode: "trees", base: { ref: "refs/heads/a", oid: oid("a") }, head: { ref: "refs/heads/b", oid: oid("b") }, files: [] }),
		stage: record("stage", undefined),
		unstage: record("unstage", undefined),
		commit: record("commit", undefined),
		discard: record("discard", { recoveryRef: null }),
		fetch: record("fetch", undefined),
		pull: record("pull", undefined),
		push: record("push", undefined),
		init: record("init", { branch: "main" }),
		aheadBehind: record("aheadBehind", { ahead: 1, behind: 2 }),
		...overrides,
	};
	const services = { projectId, generation: "g1", capabilities: { git: {}, blocked: {} }, git };
	return { services, calls, names: () => calls.map(([name]) => name) };
}

test("读面区分显式刷新与静默轮询：只有显式刷新越缓存", async () => {
	const f = fakeService();
	const bridge = createRemoteGitPanelBridge(f.services, nested);
	await bridge.getStatus(projectId, { force: true });
	await bridge.getStatus(projectId, { force: false });
	await bridge.getStatus(projectId);
	assert.deepEqual(plain(f.calls.map(([name]) => name)), ["refresh", "status", "status"]);
	// 作用域绑死在桥里：每次读都带同一个 repo target（嵌套仓不是空串）。
	for (const call of f.calls) assert.deepEqual(plain(call[1]), nested);
});

test("写面把数组与 repo target 原样交给服务，不在面板里做逐文件循环", async () => {
	const f = fakeService();
	const bridge = createRemoteGitPanelBridge(f.services, nested);
	await bridge.stageFiles(projectId, [target]);
	await bridge.unstageFiles(projectId, [target]);
	await bridge.commit(projectId, "msg");
	await bridge.discardFiles(projectId, [{ group: "workingTree", target }]);
	assert.deepEqual(plain(f.calls), [
		["stage", [target], nested],
		["unstage", [target], nested],
		["commit", "msg", nested],
		["discard", [{ group: "workingTree", target }], nested],
	]);
});

test("历史只有 HEAD 游标分页：只传 maxCount，不向服务要 ref/allBranches/总数", async () => {
	const f = fakeService({
		history: async (...args) => {
			f.calls.push(["history", ...args]);
			return {
				commits: [{ oid: oid("c"), parents: [oid("b")], subject: "subject", authorName: "A", authorEmail: "a@e", authorTimeMs: 1234, shortHash: "ccccccc", refNames: ["HEAD"], graph: ["*"] }],
				hasMore: true,
			};
		},
	});
	const bridge = createRemoteGitPanelBridge(f.services, root);
	const commits = await bridge.commitLog(projectId, { maxEntries: 30, ref: "refs/heads/main", allBranches: true });
	assert.deepEqual(plain(f.calls), [["history", { maxCount: 30 }, root]]);
	assert.deepEqual(plain(commits), [
		{
			hash: oid("c"),
			shortHash: "ccccccc",
			message: "subject",
			authorName: "A",
			authorEmail: "a@e",
			authorDate: 1234,
			parents: [oid("b")],
			refNames: ["HEAD"],
			graph: ["*"],
		},
	]);
});

test("提交详情把秒换成毫秒，并把文件映射成面板的行类型", async () => {
	const f = fakeService({
		commitDetail: async () => ({
			oid: oid("a"),
			parents: [oid("b")],
			authorName: "A",
			authorEmail: "a@e",
			authorTimeSec: 10,
			committerName: "A",
			committerEmail: "a@e",
			committerTimeSec: 10,
			subject: "s",
			message: "s\n\nbody",
			files: [
				{ status: "M", path: "src/a.ts" },
				{ status: "R", path: "src/b.ts", oldPath: "src/old.ts" },
			],
		}),
	});
	const bridge = createRemoteGitPanelBridge(f.services, root);
	const detail = await bridge.commitDetail(projectId, oid("a"));
	assert.equal(detail.commit.authorDate, 10_000, "authorDate is milliseconds in the panel");
	assert.equal(detail.commit.fullMessage, "s\n\nbody");
	assert.deepEqual(plain(detail.files), [
		{ path: "src/a.ts", target, displayPath: "src/a.ts", status: "modified" },
		{ path: "src/b.ts", target: { projectId, relativePath: "src/b.ts" }, displayPath: "src/b.ts", status: "renamed", originalPath: "src/old.ts", originalTarget: { projectId, relativePath: "src/old.ts" } },
	]);
});

test("对比透传 ahead/behind：两树语义缺省时浏览器区不显示 0/0", async () => {
	const trees = fakeService();
	const treesBridge = createRemoteGitPanelBridge(trees.services, root);
	const treesResult = await treesBridge.branchCompare(projectId, "refs/heads/a", "refs/heads/b");
	assert.equal(treesResult.ahead, undefined);
	assert.equal(treesResult.behind, undefined);

	const mergeBase = fakeService({
		compare: async () => ({ mode: "merge-base", base: { ref: "refs/heads/a", oid: oid("a") }, head: { ref: "refs/heads/b", oid: oid("b") }, files: [], ahead: 3, behind: 4 }),
	});
	const mergeBaseBridge = createRemoteGitPanelBridge(mergeBase.services, root);
	const mergeBaseResult = await mergeBaseBridge.branchCompare(projectId, "refs/heads/a", "refs/heads/b");
	assert.deepEqual([mergeBaseResult.ahead, mergeBaseResult.behind], [3, 4]);
});

test("稳定码折成本地文案，同时保留 code/outcome 供展示层判定（unknown 不重放）", async () => {
	const failing = fakeService({
		commit: async () => {
			throw Object.assign(new Error("remote git commit failed"), { code: "GIT_WRITE_RESULT_UNCONFIRMED", outcome: "unknown" });
		},
	});
	const bridge = createRemoteGitPanelBridge(failing.services, root);
	await assert.rejects(
		() => bridge.commit(projectId, "msg"),
		(error) => {
			assert.equal(error.message, zhCN["remoteGit.writeUnknown"]);
			assert.equal(error.code, "GIT_WRITE_RESULT_UNCONFIRMED");
			assert.equal(error.outcome, "unknown");
			return true;
		},
	);
});

test("没有稳定码的异常保留原文，不吞成一句泛化失败", async () => {
	const failing = fakeService({
		status: async () => {
			throw new Error("boom");
		},
	});
	const bridge = createRemoteGitPanelBridge(failing.services, root);
	await assert.rejects(
		() => bridge.getStatus(projectId),
		(error) => error.message === "boom",
	);
});

test("初始化固定项目根：桥不接受嵌套 scope", async () => {
	const f = fakeService();
	const bridge = createRemoteGitPanelBridge(f.services, nested);
	await bridge.gitInit();
	assert.deepEqual(plain(f.calls), [["init"]]);
});

test("同步动词只暴露给用户动作，桥自己不触发任何网络写", async () => {
	const f = fakeService();
	createRemoteGitPanelBridge(f.services, root);
	assert.deepEqual(f.names(), [], "constructing the bridge must not call anything");
});

test("ahead/behind 缓存 30 秒：5 秒轮询不会每次打一次 helper，显式刷新/写动作立即作废", async () => {
	let reads = 0;
	const f = fakeService({
		aheadBehind: async () => {
			reads += 1;
			return { ahead: reads, behind: 0 };
		},
	});
	const bridge = createRemoteGitPanelBridge(f.services, root);
	assert.deepEqual(plain(await bridge.aheadBehind()), { ahead: 1, behind: 0 });
	assert.deepEqual(plain(await bridge.aheadBehind()), { ahead: 1, behind: 0 }, "the polling cadence reads the cache");
	assert.equal(reads, 1);
	// 显式刷新手势要求一次新的答案。
	await bridge.getStatus(projectId, { force: true });
	assert.deepEqual(plain(await bridge.aheadBehind()), { ahead: 2, behind: 0 });
	assert.equal(reads, 2);
	// 写动作（这里用 commit）之后旧计数不再可信。
	await bridge.commit(projectId, "msg");
	await bridge.aheadBehind();
	assert.equal(reads, 3);
});
