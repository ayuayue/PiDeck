import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 批量选中的纯逻辑（收藏 / 智能体两个页面共用）：
 * 切换、按可见项全选、列表变化后裁剪。全部返回新 Set，React 才看得到变化。
 */
const { toggleSelection, setSelectionFor, pruneSelection, areAllSelected } = loadTsCommonJs("src/renderer/src/utils/selectionSet.ts");

/** vm 沙箱里的数组/Set 与宿主 realm 不同源，统一转成逗号串再比较。 */
const ids = (set) => [...set].sort().join(",");

test("toggleSelection：加入/移除都返回新 Set，原集合不变", () => {
	const base = new Set(["a"]);
	const added = toggleSelection(base, "b");
	const removed = toggleSelection(base, "a");
	assert.equal(ids(base), "a", "原集合必须保持不变");
	assert.equal(ids(added), "a,b");
	assert.equal(ids(removed), "");
	assert.notEqual(added, base);
	assert.notEqual(removed, base);
});

test("setSelectionFor：全选只作用于给定可见项，已选的不可见项保留", () => {
	const base = new Set(["hidden"]);
	const all = setSelectionFor(base, ["v1", "v2"], true);
	assert.equal(ids(all), "hidden,v1,v2", "搜索过滤时全选不能清掉过滤掉的已选项");
	const none = setSelectionFor(all, ["v1", "v2"], false);
	assert.equal(ids(none), "hidden");
});

test("setSelectionFor：空可见列表是安全的 no-op", () => {
	const base = new Set(["a"]);
	assert.equal(ids(setSelectionFor(base, [], true)), "a");
	assert.equal(ids(setSelectionFor(base, [], false)), "a");
});

test("pruneSelection：删除后收缩到现存 id", () => {
	const base = new Set(["a", "b", "c"]);
	assert.equal(ids(pruneSelection(base, ["a", "c"])), "a,c");
	assert.equal(ids(pruneSelection(base, [])), "");
});

test("pruneSelection：选区没变时返回原引用（避免每次列表刷新都触发重渲染）", () => {
	const base = new Set(["a"]);
	assert.equal(pruneSelection(base, ["a", "b"]), base);
});

test("areAllSelected：空列表不算全选，部分选中为 false", () => {
	assert.equal(areAllSelected(new Set(), []), false);
	assert.equal(areAllSelected(new Set(["a"]), ["a", "b"]), false);
	assert.equal(areAllSelected(new Set(["a", "b"]), ["a", "b"]), true);
});
