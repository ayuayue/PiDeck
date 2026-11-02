/**
 * 文件搜索的能力边界（WS3）：内容检索只存在于本机 file-index。
 *
 * 远端 helper 只有名字搜索，WSL 项目的索引根为空。旧实现仍会发 files.searchContent，
 * 失败/空结果被 UI 当成「没有匹配」，用户看不出「这个位置不支持内容搜索」。这里锁定四条：
 * - 不支持时不发内容 IPC、不进入内容 loading、内容结果保持 null；
 * - 支持时（缺省）行为不变；
 * - 从支持切到不支持时清掉旧命中与在途回包；
 * - 结果面板只在「不支持 + 已输入查询」时显示仅文件名提示，且绝不渲染内容分区/spinner。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function hookHarness() {
	const host = quickMessageHookHost();
	const nameCalls = [];
	const contentCalls = [];
	// Phase B：能力来自 ProjectServices；用同一代假服务模拟切项目/切能力。
	const makeServices = (contentSearch) => ({
		projectId: "p1",
		kind: "local",
		generation: "local",
		capabilities: { files: { contentSearch } },
		files: {
			searchFiles: (query) => {
				const call = { projectId: "p1", query };
				nameCalls.push(call);
				return new Promise((resolve, reject) => {
					call.resolve = resolve;
					call.reject = reject;
				});
			},
			searchContent: (query) => {
				const call = { projectId: "p1", query };
				contentCalls.push(call);
				return new Promise((resolve, reject) => {
					call.resolve = resolve;
					call.reject = reject;
				});
			},
		},
	});

	const { useFileSearch } = loadTsCommonJs("src/renderer/src/hooks/useFileSearch.ts", {
		stubs: { react: host.react },
	});

	let state = null;
	/** 当前 view 选项（模拟切项目/切能力）；状态槽位按 hook 调用顺序保留。 */
	let currentOptions = {};
	const render = (next) => {
		if (next !== undefined) currentOptions = next;
		const services = makeServices(currentOptions.contentSearchSupported !== false);
		state = host.render(() => useFileSearch({ services }));
		return state;
	};
	const drive = (query) => {
		state.setQuery(query);
		render();
		state.searchNow(query);
	};
	return { host, render, view: () => state, drive, nameCalls, contentCalls };
}

const NAME_RESULT = [{ name: "alpha.ts", path: "D:/p/alpha.ts", relativePath: "alpha.ts", type: "file" }];
const CONTENT_RESULT = { hits: [{ name: "gamma.ts", path: "D:/p/gamma.ts", relativePath: "gamma.ts", line: 12, column: 3, snippet: "alpha 命中" }], matchedFiles: 1, scannedFiles: 3, scannedBytes: 1024, truncated: false };

test("内容搜索不受支持的位置：只发名字检索，不进入内容 loading，内容结果保持 null", async () => {
	const h = hookHarness();
	h.render({ contentSearchSupported: false });
	h.drive("alpha");
	await flush();
	assert.equal(h.nameCalls.length, 1, "文件名检索照常发起");
	assert.equal(h.contentCalls.length, 0, "不支持的位置绝不发 files.searchContent");
	h.render();
	assert.equal(h.view().isSearching, true);
	assert.equal(h.view().isContentSearching, false, "不显示内容 spinner");
	assert.equal(h.view().contentResults, null);
	h.nameCalls[0].resolve({ results: NAME_RESULT });
	await flush();
	h.render();
	assert.equal(h.view().results.length, 1);
	assert.equal(h.view().isSearching, false);
	assert.equal(h.view().contentResults, null);
	h.host.unmount();
});

test("内容搜索支持（缺省 true）：名字与内容仍并行，原有行为不变", async () => {
	const h = hookHarness();
	h.render();
	h.drive("alpha");
	await flush();
	assert.equal(h.nameCalls.length, 1);
	assert.equal(h.contentCalls.length, 1);
	h.render();
	assert.equal(h.view().isContentSearching, true);
	h.contentCalls[0].resolve(CONTENT_RESULT);
	await flush();
	h.render();
	assert.equal(h.view().contentResults.hits[0].line, 12);
	assert.equal(h.view().isContentSearching, false);
	h.host.unmount();
});

test("从支持切到不支持：清掉旧命中，在途内容回包按代次丢弃", async () => {
	const h = hookHarness();
	h.render();
	h.drive("alpha");
	await flush();
	assert.equal(h.contentCalls.length, 1);
	// 切到不支持的位置（同一 hook 实例，能力入参变化）
	h.render({ contentSearchSupported: false });
	await flush();
	h.render();
	assert.equal(h.view().contentResults, null);
	assert.equal(h.view().isContentSearching, false);
	// 旧内容请求迟到：不能把上一位置的内容命中写回不支持的抽屉
	h.contentCalls[0].resolve(CONTENT_RESULT);
	await flush();
	h.render();
	assert.equal(h.view().contentResults, null);
	// 新位置继续输入：仍只发名字检索
	h.drive("beta");
	await flush();
	assert.equal(h.nameCalls.length, 2);
	assert.equal(h.contentCalls.length, 1);
	h.host.unmount();
});

test("能力判定：本机支持，WSL 与远端不支持，未知位置保持既有行为", () => {
	const { projectSupportsContentSearch } = loadTsCommonJs("src/renderer/src/utils/fileSearchCapability.ts");
	assert.equal(projectSupportsContentSearch(undefined), true);
	assert.equal(projectSupportsContentSearch({ id: "p", name: "P", lastOpenedAt: 1, path: "D:/p", environment: "windows" }), true);
	assert.equal(projectSupportsContentSearch({ id: "w", name: "W", lastOpenedAt: 1, path: "/home/u/w", environment: "wsl" }), false);
	assert.equal(projectSupportsContentSearch({ id: "r", name: "R", lastOpenedAt: 1, locator: { kind: "ssh", hostId: "11111111-1111-4111-8111-111111111111", remotePath: "/srv/app" } }), false);
});

test("仅文件名提示：只在「位置不支持 + 已输入查询」同时成立时出现", () => {
	const { shouldShowFileNameOnlyHint } = loadTsCommonJs("src/renderer/src/utils/fileSearchCapability.ts");
	const hint = (contentSearchSupported, query) => shouldShowFileNameOnlyHint({ contentSearchSupported, query });
	assert.equal(hint(false, "alpha"), true);
	assert.equal(hint(false, "  "), false, "空查询不显示能力提示");
	assert.equal(hint(true, "alpha"), false, "支持内容检索的位置不显示提示");
	assert.equal(hint(false, " a "), true, "查询词前后空白不改变判定");
});

function renderResults(overrides = {}) {
	// shadcn Button 走 bundler 的 `@/` 别名，node 测试无法解析：只替换这一个纯展示依赖。
	const Button = (props) => React.createElement("button", null, props.children);
	// seti 图标是 vendored TS，node 的 transpileModule 处理不了；搜索结果行本身不参与断言。
	const FileIcons = {
		getFileIconSeti: () => ({ svg: "", colorName: "default" }),
		getFileIconColor: () => "currentColor",
	};
	const { FileSearchResults } = loadTsCommonJs("src/renderer/src/components/session/FileSearchResults.tsx", {
		stubs: { react: React, "../ui-shadcn/button": { Button }, "../../fileIcons": FileIcons },
	});
	return renderToStaticMarkup(
		React.createElement(FileSearchResults, {
			query: "alpha",
			onQueryChange: () => {},
			results: NAME_RESULT,
			isSearching: false,
			contentResults: CONTENT_RESULT,
			isContentSearching: true,
			onViewFile: () => {},
			onFileContextMenu: () => {},
			onClear: () => {},
			...overrides,
		}),
	);
}

test("结果面板：不支持位置显示仅文件名提示，不渲染内容分区与内容 spinner", () => {
	const html = renderResults({ contentSearchSupported: false });
	assert.match(html, /data-testid="file-search-name-only-hint"/);
	assert.match(html, /此位置仅支持文件名搜索/);
	assert.doesNotMatch(html, /file-search-content/, "不能渲染内容分区容器");
	assert.doesNotMatch(html, /文件内容/, "不能渲染内容分区标题");
	assert.doesNotMatch(html, /正在扫描文件内容/, "不能渲染内容扫描态");
	assert.doesNotMatch(html, /animate-pideck-spin/, "名字检索也已结束，页面不应再有 spinner");
});

test("结果面板：支持位置仍渲染内容分区，不显示仅文件名提示", () => {
	const html = renderResults({ contentSearchSupported: true });
	assert.match(html, /文件内容/);
	assert.match(html, /gamma\.ts/);
	assert.doesNotMatch(html, /file-search-name-only-hint/);
});

test("结果面板：空查询时不显示仅文件名提示（能力提示不替代空态引导）", () => {
	const html = renderResults({ contentSearchSupported: false, query: "" });
	assert.doesNotMatch(html, /file-search-name-only-hint/);
	assert.doesNotMatch(html, /此位置仅支持文件名搜索/);
});
