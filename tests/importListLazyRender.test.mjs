import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 导入弹窗列表的性能契约：搜索 + 增量渲染是「长列表不卡」的唯一保障，
 * 一旦有人把列表改回全量渲染（或把哨兵 root 换成视口），这里必须先红。
 * 断言全部按源码正则做空白容忍匹配（见 AGENTS.md 格式化纪律），改缩进不该影响结论。
 */
const MODALS_SOURCE = readFileSync("src/renderer/src/components/app/ImportModals.tsx", "utf8");
const WINDOW_HOOK_SOURCE = readFileSync("src/renderer/src/hooks/useLazyListWindow.ts", "utf8");
const SOURCE_LIST_SOURCE = readFileSync("src/renderer/src/components/app/DirectoryImportSourceList.tsx", "utf8");

const count = (source, pattern) => [...source.matchAll(pattern)].length;

test("导入来源首屏（目录列表）同样走搜索 + 增量渲染", () => {
	assert.match(SOURCE_LIST_SOURCE, /useImportSessionFilter\(/);
	assert.match(SOURCE_LIST_SOURCE, /useLazyListWindow\(/);
	// 目录卡片只能来自窗口切片，禁止直接遍历 props.sources 全量渲染。
	assert.match(SOURCE_LIST_SOURCE, /listWindow\s*\.\s*visible\s*\.\s*map\(/);
	assert.equal(count(SOURCE_LIST_SOURCE, /props\s*\.\s*sources\s*\.\s*map\(/g), 0);
	// 搜索行必须渲染在自带滚动区之外（否则列表滚动时搜索框会跟着滚走）。
	assert.match(SOURCE_LIST_SOURCE, /<ImportListSearchRow[\s\S]{0,600}?ref=\{scrollRef\}/);
});

test("导入弹窗的会话行只来自增量渲染窗口", () => {
	// Codex 父行 / 未关联子代理 / 通用列表：三处都必须走窗口切片。
	assert.equal(count(MODALS_SOURCE, /\.visible\s*\.\s*map\(/g), 3);
	// 直接遍历 props.sessions 渲染整表是这次要消除的卡顿源，不允许回潮。
	assert.equal(count(MODALS_SOURCE, /props\s*\.\s*sessions\s*\.\s*map\(/g), 0);
});

test("搜索行、命中空态与窗口页脚在两个弹窗里都接上了", () => {
	assert.equal(count(MODALS_SOURCE, /useImportSessionFilter\s*</g), 2);
	assert.equal(count(MODALS_SOURCE, /useLazyListWindow\(/g), 3);
	assert.equal(count(MODALS_SOURCE, /<ImportListSearchRow\s/g), 2);
	assert.equal(count(MODALS_SOURCE, /<ImportListNoMatch\s/g), 2);
	assert.equal(count(MODALS_SOURCE, /<ImportListWindowFooter\s/g), 3);
});

test("增量窗口的哨兵挂载在列表滚动容器上，并在数据源变化时回到首屏", () => {
	// root = null 会让哨兵只在滚动容器整体进入视口时触发，弹窗内滚动永远等不到「加载更多」。
	assert.match(WINDOW_HOOK_SOURCE, /root:\s*scrollRef\?\.\s*current\s*\?\?\s*null/);
	assert.match(WINDOW_HOOK_SOURCE, /resolveImportListWindow\(/);
	assert.match(WINDOW_HOOK_SOURCE, /growImportListWindow\(/);
});

test("全选在搜索态只作用于命中行", () => {
	// 子集语义由 utils 的 toggleSelectedPaths 保证：未命中的已选行不能被悄悄清空。
	// （Codex 传父行、通用弹窗传命中行的 sourcePath；非搜索态传 undefined 退回控制器自己的可选集。）
	assert.equal(count(MODALS_SOURCE, /onToggleAll\(\s*filter\s*\.\s*isSearching\s*\?/g), 2);
});
