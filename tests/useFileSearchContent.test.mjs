/**
 * 文件抽屉搜索（useFileSearch）的内容检索状态回归测试。
 *
 * 名字检索与内容检索共用一次防抖、同一代次：名字毫秒级先出、内容扫盘后到，
 * 两者必须各自落态且互不覆盖；迟到内容结果按代次丢弃；查询词太短不扫内容；
 * 空查询清两态；内容失败只影响内容分区（名字结果照常可用）。
 * 用确定性 React 宿主（无 DOM）+ window.piDesktop 替身驱动，不依赖真实扫盘。
 *
 * 读状态前必须 h.render()：宿主把 state 快照进返回值，setState 不触发重渲染。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function hookHarness() {
	const host = quickMessageHookHost();
	const seen = { name: [], content: [] };
	// 每个调用返回一个可外部结算的 promise，方便制造「内容比名字晚到」与迟到竞态
	const nameCalls = [];
	const contentCalls = [];
	const windowStub = {
		piDesktop: {
			files: {
				search: (projectId, query) => {
					const call = { projectId, query };
					nameCalls.push(call);
					seen.name.push(query);
					return new Promise((resolve, reject) => {
						call.resolve = resolve;
						call.reject = reject;
					});
				},
				searchContent: (projectId, query) => {
					const call = { projectId, query };
					contentCalls.push(call);
					seen.content.push(query);
					return new Promise((resolve, reject) => {
						call.resolve = resolve;
						call.reject = reject;
					});
				},
			},
		},
	};

	const { useFileSearch } = loadTsCommonJs("src/renderer/src/hooks/useFileSearch.ts", {
		stubs: { react: host.react },
		globals: { window: windowStub },
	});

	let state = null;
	const render = (projectId = "p1") => (state = host.render(() => useFileSearch({ projectId })));
	/** 直接驱动一次检索（不等防抖）：查询词先落到 state 再调 searchNow */
	const drive = (query) => {
		state.setQuery(query);
		render();
		state.searchNow(query);
	};
	return { host, render, view: () => state, drive, nameCalls, contentCalls, seen };
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
	h.nameCalls[0].resolve(NAME_RESULT);
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

test("空查询：名字与内容两态一起清空（退出搜索不留残留）", async () => {
	const h = hookHarness();
	h.render();
	h.drive("alpha");
	await flush();
	h.nameCalls[0].resolve(NAME_RESULT);
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
	h.nameCalls[0].resolve(NAME_RESULT);
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
	h.nameCalls[0].resolve(NAME_RESULT);
	h.contentCalls[0].resolve(CONTENT_RESULT);
	await flush();
	h.render();
	assert.equal(h.view().results.length, 1);
	assert.equal(h.view().contentResults.hits.length, 1);
	h.host.unmount();
});
