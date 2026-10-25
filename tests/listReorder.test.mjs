import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 列表重排纯函数（智能体卡片网格 + 收藏单列共用）：
 * - moveKeyRelative / moveKeyByStep：拖拽与手柄方向键的位移规则；
 * - neighborKey：过滤视图里取「看得见」的邻居；
 * - resolveReorderDropTarget：指针 → 落点（网格按左右半区、列表按上下半区）。
 *
 * 落点几何是拖拽手感的核心：这里用显式矩形断言位置，避免依赖 jsdom/DOM。
 */
const { sameOrder, moveKeyRelative, neighborKey, moveKeyByStep, resolveReorderDropTarget } = loadTsCommonJs("src/renderer/src/utils/listReorder.ts");

const ids = (value) => Array.from(value);
// 生产模块在 vm 沙箱里创建的对象原型属于另一个 realm：深度比较前转成本 realm 的普通对象。
const plain = (value) => JSON.parse(JSON.stringify(value));

test("moveKeyRelative：插到锚点前/后，摘除后重新定位锚点", () => {
	assert.deepEqual(ids(moveKeyRelative(["a", "b", "c"], "c", "a", "before")), ["c", "a", "b"]);
	assert.deepEqual(ids(moveKeyRelative(["a", "b", "c"], "a", "c", "after")), ["b", "c", "a"]);
	assert.deepEqual(ids(moveKeyRelative(["a", "b", "c", "d"], "b", "d", "before")), ["a", "c", "b", "d"]);
});

test("moveKeyRelative：自身/未知 key 不改顺序，且不改动入参", () => {
	const current = ["a", "b", "c"];
	assert.deepEqual(ids(moveKeyRelative(current, "b", "b", "after")), ["a", "b", "c"]);
	assert.deepEqual(ids(moveKeyRelative(current, "ghost", "a", "after")), ["a", "b", "c"]);
	assert.deepEqual(ids(moveKeyRelative(current, "a", "ghost", "after")), ["a", "b", "c"]);
	assert.deepEqual(current, ["a", "b", "c"]);
});

test("neighborKey：边界返回 null，未知 key 返回 null", () => {
	assert.equal(neighborKey(["a", "b"], "a", -1), null);
	assert.equal(neighborKey(["a", "b"], "b", 1), null);
	assert.equal(neighborKey(["a", "b"], "ghost", 1), null);
	assert.equal(neighborKey(["a", "b"], "a", 1), "b");
});

test("moveKeyByStep：过滤视图里用可见邻居做锚点，隐藏条目保持相对位置", () => {
	// 搜索只显示 a 和 c：c 按 ↑ 应插到 a 之前（而不是完整顺序里的 b 之前）。
	assert.deepEqual(ids(moveKeyByStep(["a", "b", "c", "d"], ["a", "c"], "c", -1)), ["c", "a", "b", "d"]);
	assert.deepEqual(ids(moveKeyByStep(["a", "b", "c"], ["a", "c"], "a", 1)), ["b", "c", "a"], "a 按 ↓ 落到 c 之后（隐藏的 b 保持原位）");
	assert.equal(moveKeyByStep(["a", "b"], ["a", "b"], "a", -1), null, "已在边界：返回 null，调用方不写盘");
});

test("sameOrder：逐项比较，长度不同也算变化", () => {
	assert.equal(sameOrder(["a", "b"], ["a", "b"]), true);
	assert.equal(sameOrder(["a", "b"], ["b", "a"]), false);
	assert.equal(sameOrder(["a"], ["a", "b"]), false);
});

const gridItems = [
	{ key: "a", left: 0, top: 0, width: 100, height: 50 },
	{ key: "b", left: 110, top: 0, width: 100, height: 50 },
	{ key: "c", left: 0, top: 60, width: 100, height: 50 },
];

test("resolveReorderDropTarget（网格）：卡片内按左右半区判前后", () => {
	assert.deepEqual(plain(resolveReorderDropTarget(gridItems, { x: 20, y: 25 }, "grid")), { key: "a", position: "before" });
	assert.deepEqual(plain(resolveReorderDropTarget(gridItems, { x: 80, y: 25 }, "grid")), { key: "a", position: "after" });
	assert.deepEqual(plain(resolveReorderDropTarget(gridItems, { x: 160, y: 25 }, "grid")), { key: "b", position: "after" });
});

test("resolveReorderDropTarget（网格）：行间缝隙按最近卡片 + 上下半区判定", () => {
	// (50,55) 在 a 下方、c 上方：最近的是 a，纵向已出卡片 → 判 a 之后（跨行落点）。
	assert.deepEqual(plain(resolveReorderDropTarget(gridItems, { x: 50, y: 55 }, "grid")), { key: "a", position: "after" });
	// 容器留白（右下角外）：退到最近的 b，纵向出卡片 → 判 b 之后。
	assert.deepEqual(plain(resolveReorderDropTarget(gridItems, { x: 260, y: 40 }, "grid")), { key: "b", position: "after" });
});

test("resolveReorderDropTarget（单列）：按上下半区判前后", () => {
	const listItems = [
		{ key: "a", left: 0, top: 0, width: 200, height: 40 },
		{ key: "b", left: 0, top: 50, width: 200, height: 40 },
	];
	assert.deepEqual(plain(resolveReorderDropTarget(listItems, { x: 100, y: 10 }, "list")), { key: "a", position: "before" });
	assert.deepEqual(plain(resolveReorderDropTarget(listItems, { x: 100, y: 35 }, "list")), { key: "a", position: "after" });
	assert.deepEqual(plain(resolveReorderDropTarget(listItems, { x: 100, y: 55 }, "list")), { key: "b", position: "before" });
});

test("resolveReorderDropTarget：零尺寸条目（隐藏/折叠）不参与落点，空列表返回 null", () => {
	const withHidden = [
		{ key: "hidden", left: 0, top: 0, width: 0, height: 0 },
		{ key: "real", left: 200, top: 200, width: 100, height: 50 },
	];
	assert.deepEqual(plain(resolveReorderDropTarget(withHidden, { x: 0, y: 0 }, "grid")), { key: "real", position: "before" });
	assert.equal(resolveReorderDropTarget([], { x: 0, y: 0 }, "grid"), null);
	assert.equal(resolveReorderDropTarget([{ key: "hidden", left: 0, top: 0, width: 0, height: 0 }], { x: 0, y: 0 }, "list"), null);
});
