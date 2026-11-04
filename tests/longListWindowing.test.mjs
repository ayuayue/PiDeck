import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 长列表「只挂一屏」契约（issue #481 的全局排查）。
 *
 * 三个地方原来都是一次性 map 出全部行，行数随数据增长（供应商模型目录、会话消息、
 * 远端公告 feed）。这里钉住它们都走 useLazyListWindow 的增量窗口，而不是「先全渲染，
 * 卡了再说」——守卫只认滚动容器，认不出「容器里塞了多少行」。
 */

const read = (path) => readFileSync(path, "utf8");

test("模型选择：/models 结果按窗口渲染，不再整表上屏", () => {
	const source = read("src/renderer/src/config/FetchedModelCombobox.tsx");
	assert.match(source, /useLazyListWindow\(visibleModels/, "模型目录可达数百条：必须走增量窗口");
	assert.match(source, /listWindow\.visible\.map/, "渲染窗口内的行，而不是 visibleModels 全量");
	assert.match(source, /listWindow\.sentinelRef/, "触底哨兵缺失 = 永远只显示第一页");
	assert.doesNotMatch(source, /\{visibleModels\.map\(/, "不得再直接全量 map（回归点）");
});

test("消息多选树：顶层条目按窗口渲染，勾选状态留在父组件", () => {
	const source = read("src/renderer/src/components/session/MessageSelectionTree.tsx");
	assert.match(source, /useLazyListWindow\(props\.items/, "长会话上千条消息：必须走增量窗口");
	assert.match(source, /listWindow\.visible\.map/);
	assert.match(source, /listWindow\.hasMore/);
	assert.doesNotMatch(source, /\{props\.items\.map\(/, "不得再直接全量 map（回归点）");
});

test("公告中心：「展示更多」按页追加，不再一次性展开全部", () => {
	const source = read("src/renderer/src/components/sidebar/AnnouncementCenter.tsx");
	assert.doesNotMatch(source, /showAllActive/, "布尔「展开全部」会让远端 feed 的整份列表同时上屏");
	assert.match(source, /activeItems\.slice\(0, activeLimit\)/);
	assert.match(source, /setActiveLimit\(\(limit\) => limit \+ ANNOUNCEMENT_PAGE_SIZE\)/);
});
