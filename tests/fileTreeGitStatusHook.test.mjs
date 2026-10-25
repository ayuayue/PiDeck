/**
 * 文件树 Git 着色 hook（useFileTreeGitStatus）的行为测试。
 *
 * 这个状态域里真正会出错的是「取数范围决策」与「失败/竞态下的结算」，
 * 纯函数测试覆盖不到，所以每个 IPC 都由测试自己手工结算（deferred），断言查表结果：
 * - 取数范围：多仓逐个取 + 项目根不是仓库时回退默认 scope（项目目录位于更大仓库内部）；
 * - 失败容忍：单仓失败、发现仓库失败、默认 scope 抛错都只丢自己那份；
 * - 占位过滤：嵌套仓取数失败时，外层仓的未跟踪占位必须留着（否则子树整片无色）；
 * - 生命周期：切项目丢弃迟到响应、卸载后不再写状态、同项目重渲染不重复取数。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const ROOT = process.cwd();
const { GitStatus } = loadTsCommonJs(`${ROOT}/src/shared/types/git.ts`);

/** 手工结算的 promise：hook 的每个 IPC 何时返回由测试决定，不依赖真实定时器或顺序。 */
function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** 只喂四组里用到的组，业务断言一律走 statusOf 查表 */
const groups = ({ index = [], workingTree = [], untracked = [] } = {}) => ({ merge: [], index, workingTree, untracked });
const resource = (path, status) => ({ path, status, letter: "M" });
const repo = (path, relativePath) => ({ path, name: path.split("/").pop() ?? path, relativePath });

/** 让 hook 的 await 链跑完（resolve 后至少两跳：listRepos → Promise.all(状态) → 结算） */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function createHarness() {
	const host = quickMessageHookHost();
	let writes = 0;
	// 包一层 useState：统计状态写入次数，用于断言「迟到响应/卸载后不得再写状态」
	const react = {
		...host.react,
		useState(initial) {
			const [value, setValue] = host.react.useState(initial);
			return [
				value,
				(next) => {
					writes += 1;
					setValue(next);
				},
			];
		},
	};
	const requests = [];
	const git = {
		listRepos(projectId) {
			const d = deferred();
			requests.push({ kind: "listRepos", projectId, d });
			return d.promise;
		},
		status(projectId, repoPath) {
			const d = deferred();
			requests.push({ kind: "status", projectId, repoPath, d });
			return d.promise;
		},
	};
	const { useFileTreeGitStatus } = loadTsCommonJs(`${ROOT}/src/renderer/src/hooks/files/useFileTreeGitStatus.ts`, {
		stubs: { react },
		globals: { window: { piDesktop: { git } } },
	});
	const of = (kind) => requests.filter((request) => request.kind === kind);
	return {
		requests,
		listReposCalls: () => of("listRepos"),
		statusCalls: () => of("status"),
		writes: () => writes,
		render: (options) => host.render(() => useFileTreeGitStatus(options)),
		unmount: () => host.unmount(),
	};
}

test("多仓：根仓与嵌套仓状态合并；嵌套仓根取数成功时外层仓的未跟踪占位被丢弃", async () => {
	const h = createHarness();
	h.render({ projectId: "p1", projectRoot: "/p" });
	await flush();
	await h.listReposCalls()[0].d.resolve([repo("/p", ""), repo("/p/packages/app", "packages/app")]);
	await flush();
	assert.deepEqual(
		h.statusCalls().map((call) => call.repoPath),
		["/p", "/p/packages/app"],
		"已有项目根仓时不再重复查默认 scope",
	);
	await h.statusCalls()[0].d.resolve(groups({ untracked: [resource("/p/packages/app", GitStatus.UNTRACKED)], workingTree: [resource("/p/src/a.ts", GitStatus.MODIFIED)] }));
	await h.statusCalls()[1].d.resolve(groups({ index: [resource("/p/packages/app/main.ts", GitStatus.INDEX_ADDED)] }));
	await flush();
	const view = h.render({ projectId: "p1", projectRoot: "/p" });
	assert.equal(view.statusOf("/p/src/a.ts")?.status, "modified", "根仓改动上色");
	assert.equal(view.statusOf("/p/packages/app/main.ts")?.status, "added", "嵌套仓改动上色");
	assert.equal(view.statusOf("/p/packages/app")?.status, "added", "占位被丢弃后，嵌套仓目录按自己的子树聚合");
});

test("项目根不在任何已发现仓库内（子目录当项目）：回退默认 scope，否则整盘无色", async () => {
	const h = createHarness();
	h.render({ projectId: "p2", projectRoot: "/outer/sub" });
	await flush();
	await h.listReposCalls()[0].d.resolve([]);
	await flush();
	assert.deepEqual(
		h.statusCalls().map((call) => call.repoPath),
		[undefined],
		"listRepos 为空时必须按项目根取一次（项目目录位于更大仓库内部的情形）",
	);
	await h.statusCalls()[0].d.resolve(groups({ workingTree: [resource("/outer/sub/a.ts", GitStatus.MODIFIED)] }));
	await flush();
	assert.equal(h.render({ projectId: "p2", projectRoot: "/outer/sub" }).statusOf("/outer/sub/a.ts")?.status, "modified");
});

test("嵌套仓取数失败：外层仓的未跟踪占位保留，子树仍提示「有东西没进 git」", async () => {
	const h = createHarness();
	h.render({ projectId: "p3", projectRoot: "/p" });
	await flush();
	await h.listReposCalls()[0].d.resolve([repo("/p", ""), repo("/p/vendor/sub", "vendor/sub")]);
	await flush();
	await h.statusCalls()[0].d.resolve(groups({ untracked: [resource("/p/vendor/sub", GitStatus.UNTRACKED)] }));
	await h.statusCalls()[1].d.reject(new Error("repository missing"));
	await flush();
	const view = h.render({ projectId: "p3", projectRoot: "/p" });
	assert.equal(view.statusOf("/p/vendor/sub")?.status, "untracked", "失败的嵌套仓不能连占位一起丢掉");
	assert.equal(view.statusOf("/p/vendor")?.status, "untracked", "占位仍沿祖先目录上染（项目根本身不标记）");
});

test("单仓失败不拖垮其余：另一仓的状态照常上色，不抛错", async () => {
	const h = createHarness();
	h.render({ projectId: "p4", projectRoot: "/p" });
	await flush();
	await h.listReposCalls()[0].d.resolve([repo("/p", ""), repo("/p/sub", "sub")]);
	await flush();
	await h.statusCalls()[0].d.reject(new Error("permission denied"));
	await h.statusCalls()[1].d.resolve(groups({ workingTree: [resource("/p/sub/a.ts", GitStatus.MODIFIED)] }));
	await flush();
	const view = h.render({ projectId: "p4", projectRoot: "/p" });
	assert.equal(view.statusOf("/p/sub/a.ts")?.status, "modified", "失败仓被跳过，成功仓照常着色");
});

test("发现仓库失败（非 git 项目）：静默退化为无着色且不抛", async () => {
	const h = createHarness();
	h.render({ projectId: "p5", projectRoot: "/p" });
	await flush();
	await h.listReposCalls()[0].d.reject(new Error("not a git repository"));
	await flush();
	assert.equal(h.render({ projectId: "p5", projectRoot: "/p" }).statusOf("/p/a.ts"), undefined);
});

test("项目不在任何 git 仓库内：默认 scope 抛错也只静默退场，不污染旧表", async () => {
	const h = createHarness();
	h.render({ projectId: "p6", projectRoot: "/p" });
	await flush();
	await h.listReposCalls()[0].d.resolve([]);
	await flush();
	await h.statusCalls()[0].d.reject(new Error("fatal: not a git repository"));
	await flush();
	assert.equal(h.render({ projectId: "p6", projectRoot: "/p" }).statusOf("/p/a.ts"), undefined);
});

test("切项目：迟到响应被代次守卫丢弃，新项目着色不被冲掉", async () => {
	const h = createHarness();
	h.render({ projectId: "old", projectRoot: "/old" });
	await flush();
	const staleList = h.listReposCalls()[0];
	h.render({ projectId: "new", projectRoot: "/new" });
	await flush();
	await h.listReposCalls()[1].d.resolve([repo("/new", "")]);
	await flush();
	await h.statusCalls()[0].d.resolve(groups({ workingTree: [resource("/new/a.ts", GitStatus.MODIFIED)] }));
	await flush();
	assert.equal(h.render({ projectId: "new", projectRoot: "/new" }).statusOf("/new/a.ts")?.status, "modified");
	const writes = h.writes();
	// 旧项目的两跳请求此刻才回来
	await staleList.d.resolve([repo("/old", "")]);
	await flush();
	await h.statusCalls()[1].d.resolve(groups({ workingTree: [resource("/old/a.ts", GitStatus.MODIFIED)] }));
	await flush();
	const view = h.render({ projectId: "new", projectRoot: "/new" });
	assert.equal(view.statusOf("/old/a.ts"), undefined, "旧项目着色不得落地");
	assert.equal(view.statusOf("/new/a.ts")?.status, "modified", "新项目着色保持");
	assert.equal(h.writes(), writes, "迟到响应不得再写状态");
});

test("卸载后在途响应作废：不再写状态", async () => {
	const h = createHarness();
	h.render({ projectId: "p7", projectRoot: "/p" });
	await flush();
	h.unmount();
	const writes = h.writes();
	await h.listReposCalls()[0].d.resolve([repo("/p", "")]);
	await flush();
	await h.statusCalls()[0].d.resolve(groups({ workingTree: [resource("/p/a.ts", GitStatus.MODIFIED)] }));
	await flush();
	assert.equal(h.writes(), writes, "卸载后不得 setState");
});

test("无 projectId：不发任何 IPC，查表为空", async () => {
	const h = createHarness();
	const view = h.render({});
	assert.equal(h.requests.length, 0);
	assert.equal(view.statusOf("/p/a.ts"), undefined);
});

test("同项目重渲染不重复取数（refresh 引用恒定）", async () => {
	const h = createHarness();
	h.render({ projectId: "p8", projectRoot: "/p" });
	await flush();
	await h.listReposCalls()[0].d.resolve([repo("/p", "")]);
	await flush();
	await h.statusCalls()[0].d.resolve(groups({ workingTree: [resource("/p/a.ts", GitStatus.MODIFIED)] }));
	await flush();
	const before = h.requests.length;
	h.render({ projectId: "p8", projectRoot: "/p" });
	h.render({ projectId: "p8", projectRoot: "/p" });
	await flush();
	assert.equal(h.requests.length, before, "重渲染不得重新发 IPC（着色靠显式 refresh 驱动）");
});
