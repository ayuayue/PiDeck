import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteGitPanelBridge, REMOTE_GIT_LOG_PAGE_LIMIT } = loadTsCommonJs("src/renderer/src/components/workspace/remoteGitPanelBridge.ts");
const { REMOTE_GIT_LOG_MAX_COUNT } = loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");
const { zhCN } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts");

const projectId = "project-1";
const root = { projectId, relativePath: "" };
const oid = (letter) => letter.repeat(40);
const plain = (value) => JSON.parse(JSON.stringify(value));

/** 远端服务假实现：`helperCapabilities` 决定走新版协议还是旧版降级。 */
function fakeService({ capabilities = ["git.stagedDiff"], overrides = {} } = {}) {
	const calls = [];
	const record =
		(name, result) =>
		async (...args) => {
			calls.push([name, ...args]);
			return typeof result === "function" ? result(...args) : result;
		};
	const git = {
		status: record("status", { merge: [], index: [], workingTree: [], untracked: [] }),
		refresh: record("refresh", { merge: [], index: [], workingTree: [], untracked: [] }),
		history: record("history", { commits: [], hasMore: false }),
		refs: record("refs", [
			{ name: "main", fullName: "refs/heads/main", hash: oid("a"), type: "head" },
			{ name: "release", fullName: "refs/heads/release", hash: oid("b"), type: "head" },
			{ name: "v1.0", fullName: "refs/tags/v1.0", hash: oid("c"), type: "tag" },
		]),
		branches: record("branches", { current: "main", branches: ["main", "release"] }),
		compare: record("compare", { mode: "merge-base", base: { ref: "refs/heads/main", oid: oid("a") }, head: { ref: "refs/heads/release", oid: oid("b") }, files: [], ahead: 1, behind: 2 }),
		commitDetail: record("commitDetail", { oid: oid("a"), parents: [], authorName: "A", authorEmail: "a@e", authorTimeSec: 1, committerName: "A", committerEmail: "a@e", committerTimeSec: 1, subject: "s", message: "s\n", files: [] }),
		commit: record("commit", undefined),
		cherryPick: record("cherryPick", undefined),
		revert: record("revert", undefined),
		reset: record("reset", undefined),
		dropCommit: record("dropCommit", undefined),
		stage: record("stage", undefined),
		unstage: record("unstage", undefined),
		discard: record("discard", { recoveryRef: null }),
		fetch: record("fetch", undefined),
		pull: record("pull", undefined),
		push: record("push", undefined),
		init: record("init", { branch: "main" }),
		aheadBehind: record("aheadBehind", { ahead: 0, behind: 0 }),
		stagedDiff: record("stagedDiff", "diff --git a/x b/x"),
		...overrides,
	};
	const services = {
		projectId,
		kind: "remote",
		generation: "g1",
		facts: { helperCapabilities: capabilities },
		capabilities: { git: {}, blocked: {} },
		files: { deleteEntry: async () => ({ target: root }) },
		git,
	};
	return { services, calls, names: () => calls.map(([name]) => name) };
}

test("比较：下拉的短名先补成全名，分支优先于同名 tag", async () => {
	const f = fakeService();
	const bridge = createRemoteGitPanelBridge(f.services, root);
	await bridge.branchCompare(projectId, "release", "v1.0");
	const compare = f.calls.find(([name]) => name === "compare");
	assert.deepEqual(plain(compare.slice(1)), ["refs/heads/release", "refs/tags/v1.0", root, "threeDot"]);
});

test("比较：全名原样透传，未知名字在触达服务前拒绝", async () => {
	const f = fakeService();
	const bridge = createRemoteGitPanelBridge(f.services, root);
	await bridge.branchCompare(projectId, "refs/heads/main", "refs/tags/v1.0");
	assert.equal(f.names().filter((name) => name === "compare").length, 1);
	assert.deepEqual(plain(f.calls.find(([name]) => name === "compare").slice(1)), ["refs/heads/main", "refs/tags/v1.0", root, "threeDot"]);
	await assert.rejects(
		() => bridge.branchCompare(projectId, "nope", "release"),
		(error) => error.code === "GIT_REF_NOT_FOUND",
	);
});

test("新版 helper：历史带 ref/all、总数走同一条过滤，提交按 OID 补 ref 装饰", async () => {
	const f = fakeService({
		overrides: {
			history: async (options) => {
				f.calls.push(["history", options]);
				return {
					commits: [
						{ oid: oid("a"), parents: [], subject: "tip", authorName: "A", authorEmail: "a@e", authorTimeMs: 10 },
						{ oid: oid("c"), parents: [], subject: "tagged", authorName: "A", authorEmail: "a@e", authorTimeMs: 9 },
					],
					hasMore: false,
					...(options.withCount === true ? { totalCount: 42 } : {}),
				};
			},
		},
	});
	const bridge = createRemoteGitPanelBridge(f.services, root);
	const commits = await bridge.commitLog(projectId, { maxEntries: 30, allBranches: true });
	assert.deepEqual(plain(f.calls.find(([name]) => name === "history")[1]), { maxCount: 30, all: true });
	// HEAD -> main 只给当前分支；tag 用 `tag: ` 前缀（与 git log %D 同一套写法）。
	assert.deepEqual(plain(commits[0].refNames), ["HEAD -> main"]);
	assert.deepEqual(plain(commits[1].refNames), ["tag: v1.0"]);
	const total = await bridge.commitCount(projectId, { allBranches: true });
	assert.equal(total, 42);
	assert.equal(f.calls.filter(([name]) => name === "history").at(-1)[1].withCount, true);
});

test("历史过滤：下拉短名同样补成全名，避免 helper 拒绝整块历史", async () => {
	const f = fakeService();
	const bridge = createRemoteGitPanelBridge(f.services, root);
	await bridge.commitLog(projectId, { maxEntries: 30, ref: "release", allBranches: false });
	assert.deepEqual(plain(f.calls.find(([name]) => name === "history")[1]), { maxCount: 30, ref: "refs/heads/release", all: false });
});

test("分页请求夹在 git.log 的 maxCount 上限内：连续点「加载更多」不会把整页打成失败", async () => {
	const f = fakeService();
	const bridge = createRemoteGitPanelBridge(f.services, root);
	// 面板每点一次 +30，第 4 次是 120；helper 上限 100，超了整页 GIT_RESULT_INVALID。
	await bridge.commitLog(projectId, { maxEntries: 120 });
	assert.equal(plain(f.calls.find(([name]) => name === "history")[1]).maxCount, REMOTE_GIT_LOG_PAGE_LIMIT);
	assert.equal(REMOTE_GIT_LOG_PAGE_LIMIT, REMOTE_GIT_LOG_MAX_COUNT, "上限必须与 main/helper 的常量一致");
	// 未指定页大小时不补默认值，交给 helper 自己的缺省。
	await bridge.commitLog(projectId, {});
	assert.equal(f.calls.filter(([name]) => name === "history").at(-1)[1].maxCount, undefined);
});

test("旧版 helper：不发送新参数、不显示总数，历史保持 HEAD-only", async () => {
	const f = fakeService({ capabilities: [] });
	const bridge = createRemoteGitPanelBridge(f.services, root);
	await bridge.commitLog(projectId, { maxEntries: 30, ref: "refs/heads/release", allBranches: false });
	assert.deepEqual(plain(f.calls.find(([name]) => name === "history")[1]), { maxCount: 30 });
	await bridge.branchCompare(projectId, "main", "release");
	assert.equal(f.calls.find(([name]) => name === "compare").at(-1), "trees");
});

test("提交详情：把行计数字段带进面板行类型，缺省时不伪造", async () => {
	const f = fakeService({
		overrides: {
			commitDetail: async () => ({
				oid: oid("a"),
				parents: [],
				authorName: "A",
				authorEmail: "a@e",
				authorTimeSec: 1,
				committerName: "A",
				committerEmail: "a@e",
				committerTimeSec: 1,
				subject: "s",
				message: "s\n",
				files: [{ status: "M", path: "src/a.ts", additions: 3, deletions: 1 }],
				shortStat: { files: 1, insertions: 3, deletions: 1 },
			}),
		},
	});
	const bridge = createRemoteGitPanelBridge(f.services, root);
	const detail = await bridge.commitDetail(projectId, oid("a"));
	assert.deepEqual(plain(detail.commit.shortStat), { files: 1, insertions: 3, deletions: 1 });
	assert.equal(detail.files.length, 1);
});

test("删除走文件服务回收站：整批交给 git.deleteFiles，不碰 git discard", async () => {
	const f = fakeService({
		overrides: {
			deleteFiles: async (...args) => {
				f.calls.push(["deleteFiles", ...args]);
			},
		},
	});
	const bridge = createRemoteGitPanelBridge(f.services, root);
	const targets = [
		{ projectId, relativePath: "a.ts" },
		{ projectId, relativePath: "b.ts" },
	];
	await bridge.deleteFiles(projectId, targets);
	assert.deepEqual(plain(f.calls.find(([name]) => name === "deleteFiles").slice(1)), [targets, root]);
	assert.ok(!f.names().includes("discard"), "删除绝不能被映射成 discard");
});

test("事实推送只认本仓库的 status scope；订阅随退订消失", async () => {
	let push;
	const f = fakeService();
	f.services.subscribeFacts = (listener) => {
		push = listener;
		return () => {
			push = undefined;
		};
	};
	const bridge = createRemoteGitPanelBridge(f.services, { projectId, relativePath: "packages/a" });
	const seen = [];
	const off = bridge.onRefsChanged((id) => seen.push(id));
	// 没有订阅成功前不投递：watchId 是事件过滤的唯一凭据。
	push({ kind: "status", repoPath: "packages/a" });
	assert.deepEqual(seen, []);
	off();
	assert.equal(push, undefined);
});

test("远端原文优先：helper 带回的 stderr 摘要直接展示，没有原文才回落到词典", async () => {
	const withDetail = fakeService({
		overrides: {
			push: async () => {
				throw Object.assign(new Error("GIT_HOOK_REJECTED"), { code: "GIT_HOOK_REJECTED", outcome: "rejected", detail: "husky - pre-commit hook failed (add --no-verify to bypass)" });
			},
		},
	});
	await assert.rejects(
		() => createRemoteGitPanelBridge(withDetail.services, root).push(),
		(error) => {
			assert.equal(error.message, "husky - pre-commit hook failed (add --no-verify to bypass)");
			assert.equal(error.code, "GIT_HOOK_REJECTED");
			return true;
		},
	);
	const withoutDetail = fakeService({
		overrides: {
			push: async () => {
				throw Object.assign(new Error("GIT_HOOK_REJECTED"), { code: "GIT_HOOK_REJECTED", outcome: "rejected" });
			},
		},
	});
	await assert.rejects(
		() => createRemoteGitPanelBridge(withoutDetail.services, root).push(),
		(error) => {
			// 新契约：未入词典的码要附在兜底文案后面（渲染层拦下的失败不会进主进程日志）。
			assert.equal(error.message, `${zhCN["remoteGit.failed"]}（GIT_HOOK_REJECTED）`);
			assert.equal(error.code, "GIT_HOOK_REJECTED");
			return true;
		},
	);
});

test("图谱写动词：四个动作各自委派，失败时把 helper 的原文原样带给面板", async () => {
	const { services, calls } = fakeService();
	const bridge = createRemoteGitPanelBridge(services, undefined);
	await bridge.cherryPick("p", oid("a"));
	await bridge.revert("p", oid("b"));
	await bridge.reset("p", oid("c"), "hard");
	await bridge.dropCommit("p", oid("a"));
	assert.equal(
		JSON.stringify(calls),
		JSON.stringify([
			["cherryPick", oid("a"), undefined],
			["revert", oid("b"), undefined],
			["reset", oid("c"), "hard", undefined],
			["dropCommit", oid("a"), undefined],
		]),
	);
	// 冲突被 helper 回滚后仍带着 git 的 stderr：面板要看到真正的原因，而不是一句分类文案。
	const failing = fakeService({
		overrides: {
			cherryPick: async () => {
				throw Object.assign(new Error("GIT_COMMAND_FAILED"), { code: "GIT_COMMAND_FAILED", detail: "error: could not apply abc1234" });
			},
		},
	});
	await assert.rejects(createRemoteGitPanelBridge(failing.services, undefined).cherryPick("p", oid("a")), (error) => error.message.includes("could not apply") && error.code === "GIT_COMMAND_FAILED");
});

test("冷启动：主机还在连（SSH_HOST_NOT_READY）时历史读会等预热，不把图谱永久打成空白", async () => {
	let attempts = 0;
	const f = fakeService({
		overrides: {
			history: async (options) => {
				attempts += 1;
				f.calls.push(["history", options]);
				// 前的两次正好落在窗口打开到 SSH ready 之间（实测差 4 秒）。
				if (attempts <= 2) throw Object.assign(new Error("SSH_HOST_NOT_READY"), { code: "SSH_HOST_NOT_READY", outcome: "rejected" });
				return { commits: [{ oid: oid("a"), parents: [], subject: "tip", authorName: "A", authorEmail: "a@e", authorTimeMs: 10 }], hasMore: false };
			},
		},
	});
	const commits = await createRemoteGitPanelBridge(f.services, root).commitLog(projectId, { maxEntries: 30, allBranches: true });
	assert.equal(commits.length, 1);
	assert.equal(attempts, 3, "连接类失败要重试到成功");
});

test("非连接类失败不重试：参数/回包形状错误立刻上抛，稳定码原样保留", async () => {
	let attempts = 0;
	const f = fakeService({
		overrides: {
			history: async () => {
				attempts += 1;
				throw Object.assign(new Error("GIT_RESULT_INVALID"), { code: "GIT_RESULT_INVALID", outcome: "rejected" });
			},
		},
	});
	await assert.rejects(
		() => createRemoteGitPanelBridge(f.services, root).commitLog(projectId, { maxEntries: 30 }),
		(error) => error.code === "GIT_RESULT_INVALID",
	);
	assert.equal(attempts, 1, "非连接类失败不能靠重试掩盖");
});

test("未入词典的稳定码要附在文案后面：这类失败常在渲染层被拦下，日志里没有记录", async () => {
	const f = fakeService({
		overrides: {
			history: async () => {
				// 服务换代后旧实例的调用会在触达 IPC 之前被拒：主进程日志里什么都不会留下。
				throw Object.assign(new Error("PROJECT_SERVICE_GENERATION_STALE"), { code: "PROJECT_SERVICE_GENERATION_STALE", outcome: "rejected" });
			},
		},
	});
	await assert.rejects(
		() => createRemoteGitPanelBridge(f.services, root).commitLog(projectId, { maxEntries: 30 }),
		(error) => error.code === "PROJECT_SERVICE_GENERATION_STALE" && error.message.includes("PROJECT_SERVICE_GENERATION_STALE") && error.message.includes(zhCN["remoteGit.failed"]),
	);
});

test("已入词典的码保持原文案，不把码拼进用户文案", async () => {
	const f = fakeService({
		overrides: {
			history: async () => {
				throw Object.assign(new Error("GIT_TRUST_REQUIRED"), { code: "GIT_TRUST_REQUIRED", outcome: "rejected" });
			},
		},
	});
	await assert.rejects(
		() => createRemoteGitPanelBridge(f.services, root).commitLog(projectId, { maxEntries: 30 }),
		(error) => error.message === zhCN["remoteGit.trustRequired"],
	);
});
