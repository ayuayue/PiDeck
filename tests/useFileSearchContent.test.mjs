/**
 * 文件抽屉搜索（useFileSearch）的内容检索状态回归测试（Phase B：数据入口为 ProjectServices）。
 *
 * 名字检索与内容检索共用一次防抖、同一代次：名字毫秒级先出、内容扫盘后到，
 * 两者必须各自落态且互不覆盖；迟到内容结果按代次丢弃；查询词太短不扫内容；
 * 空查询清两态；内容失败只影响内容分区（名字结果照常可用）。
 * 能力由 services.capabilities.files.contentSearch 决定；能力关闭时一个内容 IPC 都不发。
 *
 * 用确定性 React 宿主（无 DOM）+ 假 ProjectServices 驱动，不依赖真实扫盘。
 *
 * 读状态前必须 h.render()：宿主把 state 快照进返回值，setState 不触发重渲染。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function hookHarness(options = {}) {
	const host = quickMessageHookHost();
	const seen = { name: [], content: [] };
	const nameCalls = [];
	const contentCalls = [];
	const services = {
		projectId: options.projectId ?? "p1",
		generation: options.generation ?? "ssh:h:0:g1",
		kind: "remote",
		capabilities: { files: { contentSearch: options.contentSearch !== false } },
		files: {
			searchFiles: (query) => {
				const call = { query };
				nameCalls.push(call);
				seen.name.push(query);
				call.promise = new Promise((resolve, reject) => {
					call.resolve = resolve;
					call.reject = reject;
				});
				return call.promise;
			},
			searchContent: (query) => {
				const call = { query };
				contentCalls.push(call);
				seen.content.push(query);
				call.promise = new Promise((resolve, reject) => {
					call.resolve = resolve;
					call.reject = reject;
				});
				return call.promise;
			},
		},
	};

	const { useFileSearch } = loadTsCommonJs("src/renderer/src/hooks/useFileSearch.ts", { stubs: { react: host.react } });

	let state = null;
	const render = (nextServices = services) => (state = host.render(() => useFileSearch({ services: nextServices })));
	/** 直接驱动一次检索（不等防抖）：查询词先落到 state 再调 searchNow */
	const drive = (query) => {
		state.setQuery(query);
		render();
		state.searchNow(query);
	};
	return { host, render, view: () => state, drive, nameCalls, contentCalls, seen, services };
}

const NAME_RESULT = [{ name: "alpha.ts", path: "D:/p/alpha.ts", relativePath: "alpha.ts", type: "file" }];
const CONTENT_RESULT = { hits: [{ name: "gamma.ts", path: "D:/p/gamma.ts", relativePath: "gamma.ts", line: 12, column: 3, snippet: "alpha 命中" }], matchedFiles: 1, scannedFiles: 3, scannedBytes: 1024, truncated: false };

test("名字与内容并行发出、各自落态（内容后到不覆盖名字结果）", async () => {
	const h = hookHarness();
	h.render();
	h.drive("alpha");
	await flush();
	assert.equal(h.seen.name.length, 1);
	assert.equal(h.seen.content.length, 1);
	h.render();
	assert.equal(h.view().isSearching, true);
	assert.equal(h.view().isContentSearching, true);
	// 名字先回
	h.nameCalls[0].resolve({ results: NAME_RESULT });
	await flush();
	h.render();
	assert.equal(h.view().results.length, 1);
	assert.equal(h.view().isSearching, false);
	assert.equal(h.view().isContentSearching, true, "内容仍在扫盘时不能提前收尾");
	// 内容后回
	h.contentCalls[0].resolve(CONTENT_RESULT);
	await flush();
	h.render();
	assert.equal(h.view().contentResults.hits[0].line, 12);
	assert.equal(h.view().isContentSearching, false);
	h.host.unmount();
});

test("查询词短于 2 字符：只发名字检索，不扫内容", async () => {
	const h = hookHarness();
	h.render();
	h.drive("a");
	await flush();
	assert.equal(h.seen.name.length, 1);
	assert.equal(h.seen.content.length, 0);
	h.render();
	assert.equal(h.view().contentResults, null);
	assert.equal(h.view().isContentSearching, false);
	h.host.unmount();
});

test("内容检索能力关闭：即使查询词够长也不发内容请求", async () => {
	const h = hookHarness({ contentSearch: false });
	h.render();
	h.drive("alpha");
	await flush();
	assert.equal(h.seen.name.length, 1);
	assert.equal(h.seen.content.length, 0);
	h.render();
	assert.equal(h.view().isContentSearching, false);
	h.host.unmount();
});

test("迟到内容结果按代次丢弃：先发的慢请求不覆盖后发的结果", async () => {
	const h = hookHarness();
	h.render();
	h.drive("alpha");
	await flush();
	h.drive("beta");
	await flush();
	assert.equal(h.contentCalls.length, 2);
	// 第二次（新代次）先回
	h.contentCalls[1].resolve({ ...CONTENT_RESULT, hits: [{ ...CONTENT_RESULT.hits[0], line: 99 }] });
	await flush();
	h.render();
	assert.equal(h.view().contentResults.hits[0].line, 99);
	// 第一次（旧代次）后回：必须被丢弃
	h.contentCalls[0].resolve(CONTENT_RESULT);
	await flush();
	h.render();
	assert.equal(h.view().contentResults.hits[0].line, 99);
	h.host.unmount();
});

test("防抖窗口内换词：旧名字与内容回包立即作废，不落入新查询", async () => {
	const h = hookHarness();
	h.render();
	h.drive("alpha");
	h.view().setQuery("beta");
	h.render();
	assert.equal(h.nameCalls.length, 1, "新查询仍在防抖中");
	assert.equal(h.view().isSearching, true, "防抖期间也要给出正在搜索的反馈");
	h.nameCalls[0].resolve({ results: NAME_RESULT });
	h.contentCalls[0].resolve(CONTENT_RESULT);
	await flush();
	h.render();
	assert.equal(h.view().results, null, "旧名字结果不能显示在新词下");
	assert.equal(h.view().contentResults, null, "旧内容片段不能显示在新词下");
	assert.equal(h.view().isSearching, true, "旧请求收尾不能关闭新查询的 loading");
	assert.equal(h.view().error, null);
	h.host.unmount();
});

test("换词立即清掉旧命中，清空查询立即停止等待并忽略迟到失败", async () => {
	const h = hookHarness();
	h.render();
	h.drive("alpha");
	h.nameCalls[0].resolve({ results: NAME_RESULT });
	h.contentCalls[0].resolve(CONTENT_RESULT);
	await flush();
	h.render();
	h.view().setQuery("beta");
	h.render();
	assert.equal(h.view().results, null);
	assert.equal(h.view().contentResults, null);
	h.view().searchNow("beta");
	h.render();
	h.view().clearSearch();
	h.render();
	assert.equal(h.view().query, "");
	assert.equal(h.view().isSearching, false);
	assert.equal(h.view().isContentSearching, false);
	h.nameCalls[1].reject(new Error("PROJECT_FILE_SEARCH_FAILED"));
	h.contentCalls[1].resolve(CONTENT_RESULT);
	await flush();
	h.render();
	assert.equal(h.view().error, null);
	assert.equal(h.view().results, null);
	assert.equal(h.view().contentResults, null);
	h.host.unmount();
});

test("缩短查询后继续输入：先过滤最近成功的查询，随后采用最新服务结果", async () => {
	const h = hookHarness({ contentSearch: false });
	h.render();
	h.drive("alpha");
	h.nameCalls[0].resolve({ results: NAME_RESULT });
	await flush();
	h.render();
	h.drive("a");
	const added = { ...NAME_RESULT[0], name: "alpine.ts", path: "D:/p/alpine.ts", relativePath: "alpine.ts" };
	h.nameCalls[1].resolve({ results: [...NAME_RESULT, added] });
	await flush();
	h.render();
	assert.deepEqual(
		h.view().results.map((item) => item.name),
		["alpha.ts", "alpine.ts"],
	);
	h.view().setQuery("al");
	h.render();
	assert.deepEqual(
		h.view().results.map((item) => item.name),
		["alpha.ts", "alpine.ts"],
		"防抖期间过滤最近成功的快照",
	);
	h.view().searchNow("al");
	h.nameCalls[2].resolve({ results: [added] });
	await flush();
	h.render();
	assert.deepEqual(
		h.view().results.map((item) => item.name),
		["alpine.ts"],
		"服务回包替换临时过滤结果",
	);
	h.host.unmount();
});

test("名字搜索失败给稳定错误码；原词重试清掉错误并恢复结果", async () => {
	const h = hookHarness({ contentSearch: false });
	h.render();
	h.drive("alpha");
	h.nameCalls[0].reject({ code: "PROJECT_DISCONNECTED", message: "private transport details" });
	await flush();
	h.render();
	assert.equal(h.view().error, "PROJECT_DISCONNECTED");
	assert.equal(h.view().isSearching, false);
	assert.equal(h.view().results, null);
	h.view().searchNow(h.view().query);
	h.render();
	assert.equal(h.view().error, null);
	assert.equal(h.view().isSearching, true);
	h.nameCalls[1].resolve({ results: NAME_RESULT });
	await flush();
	h.render();
	assert.equal(h.view().error, null);
	assert.equal(h.view().isSearching, false);
	assert.equal(h.view().results[0].name, "alpha.ts");
	h.host.unmount();
});

test("非稳定异常只显示通用搜索错误码，不泄露底层错误内容", async () => {
	const h = hookHarness({ contentSearch: false });
	h.render();
	h.drive("alpha");
	h.nameCalls[0].reject(new Error("private transport details"));
	await flush();
	h.render();
	assert.equal(h.view().error, "PROJECT_FILE_SEARCH_FAILED");
	h.host.unmount();
});

test("空查询：名字与内容两态一起清空（退出搜索不留残留）", async () => {
	const h = hookHarness();
	h.render();
	h.drive("alpha");
	await flush();
	h.nameCalls[0].resolve({ results: NAME_RESULT });
	h.contentCalls[0].resolve(CONTENT_RESULT);
	await flush();
	h.render();
	assert.equal(h.view().contentResults !== null, true);
	h.view().setQuery("   ");
	h.render();
	h.view().searchNow("   ");
	await flush();
	h.render();
	assert.equal(h.view().results, null);
	assert.equal(h.view().contentResults, null);
	assert.equal(h.view().isSearching, false);
	assert.equal(h.view().isContentSearching, false);
	h.host.unmount();
});

test("内容检索失败：内容分区回落 null，名字结果不受影响", async () => {
	const h = hookHarness();
	h.render();
	h.drive("alpha");
	await flush();
	h.nameCalls[0].resolve({ results: NAME_RESULT });
	h.contentCalls[0].reject(new Error("sidecar down"));
	await flush();
	h.render();
	assert.equal(h.view().results.length, 1);
	assert.equal(h.view().contentResults, null);
	assert.equal(h.view().isContentSearching, false);
	h.host.unmount();
});

test("防抖路径：输入后 250ms 才同时发起名字与内容检索", async () => {
	const h = hookHarness();
	h.render();
	h.view().setQuery("alpha");
	h.render();
	assert.equal(h.seen.name.length, 0, "防抖窗口内不请求");
	await new Promise((resolve) => setTimeout(resolve, 320));
	assert.equal(h.seen.name.length, 1);
	assert.equal(h.seen.content.length, 1);
	h.nameCalls[0].resolve({ results: NAME_RESULT });
	h.contentCalls[0].resolve(CONTENT_RESULT);
	await flush();
	h.render();
	assert.equal(h.view().results.length, 1);
	assert.equal(h.view().contentResults.hits.length, 1);
	h.host.unmount();
});

test("连接换代：在途结果作废，迟到回包不能写回新代状态", async () => {
	const h = hookHarness({ generation: "g1" });
	h.render();
	h.drive("alpha");
	await flush();
	assert.equal(h.nameCalls.length, 1);
	// 同一组件收到新代 services：reset 立即作废旧代在途请求。
	const next = { ...h.services, generation: "g2" };
	h.render(next);
	assert.equal(h.view().results, null);
	h.nameCalls[0].resolve({ results: NAME_RESULT });
	h.contentCalls[0].resolve(CONTENT_RESULT);
	await flush();
	h.render(next);
	assert.equal(h.view().results, null, "旧代回包不得写回新代状态");
	assert.equal(h.view().contentResults, null);
	// 新代查询照常工作。
	h.view().setQuery("beta");
	h.render(next);
	h.view().searchNow("beta");
	await flush();
	h.nameCalls[1].resolve({ results: [{ ...NAME_RESULT[0], name: "beta.ts", relativePath: "beta.ts" }] });
	await flush();
	h.render(next);
	assert.equal(h.view().results[0].name, "beta.ts");
	h.host.unmount();
});
