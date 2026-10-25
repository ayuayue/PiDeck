// 项目拖拽重排纯函数测试（2027-03 用户反馈「拖动判定不好用」回归）：
// 落点由指针在目标行的上/下半区显式决定 before/after，不再按新旧索引猜插入点。
// 注意：函数经 loadTsCommonJs 在 vm realm 里执行，返回数组原型不同，
// deepStrictEqual 会因 realm 差异失败，统一用展开运算符转回本地数组再断言。
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { reorderProjectList } = loadTsCommonJs("src/renderer/src/utils/projectOrder.ts");

const idOf = (item) => item;
const items = ["chat", "a", "b", "c"];
const moved = (source, target, position) => [...reorderProjectList(items, idOf, source, target, position)];

test("before：source 插到目标之前（上边缘落点）", () => {
	assert.deepEqual(moved("c", "a", "before"), ["chat", "c", "a", "b"]);
});

test("after：source 插到目标之后（下边缘落点）", () => {
	assert.deepEqual(moved("a", "c", "after"), ["chat", "b", "c", "a"]);
});

test("向上拖与向下拖在同一落点语义下结果一致", () => {
	// b 拖到 a 下边缘 = 插在 a 之后（原位）；a 拖到 b 上边缘 = 插在 b 之前（原位）
	assert.deepEqual(moved("b", "a", "after"), ["chat", "a", "b", "c"]);
	assert.deepEqual(moved("a", "b", "before"), ["chat", "a", "b", "c"]);
});

test("source === target 或 id 不存在时原样返回同一引用（调用方跳过持久化）", () => {
	assert.equal(reorderProjectList(items, idOf, "a", "a", "before"), items);
	assert.equal(reorderProjectList(items, idOf, "missing", "a", "before"), items);
	assert.equal(reorderProjectList(items, idOf, "a", "missing", "after"), items);
});

test("相邻交换：before/after 各自表达目标的前后侧", () => {
	assert.deepEqual(moved("b", "a", "before"), ["chat", "b", "a", "c"]);
	assert.deepEqual(moved("a", "b", "after"), ["chat", "b", "a", "c"]);
});
