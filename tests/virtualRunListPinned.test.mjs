import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox();
const policy = load("src/renderer/src/components/session/timeline/virtualTimelinePolicy.ts");

// 沙箱里的数组来自另一个 VM 上下文，assert.deepEqual 会因原型不同判不等；
// 先展开成主上下文数组再比较。
function merged(base, pinned, limit) {
	return [...policy.mergePinnedRange(base, pinned, limit)];
}

test("没有钉行时原样返回同一引用（虚拟器不能因引用变化重算全部行起点）", () => {
	const base = [3, 4, 5];
	assert.equal(policy.mergePinnedRange(base, []), base);
});

test("钉行已在可见范围内时原样返回", () => {
	const base = [3, 4, 5];
	assert.equal(policy.mergePinnedRange(base, [4]), base);
});

test("钉行在范围外时并入，且保持升序", () => {
	assert.deepEqual(merged([3, 4, 5], [1]), [1, 3, 4, 5]);
	assert.deepEqual(merged([3, 4, 5], [9]), [3, 4, 5, 9]);
	assert.deepEqual(merged([3, 4, 5], [9, 1]), [1, 3, 4, 5, 9]);
});

test("重复的钉行不产生重复下标", () => {
	assert.deepEqual(merged([3, 4], [7, 7, 7]), [3, 4, 7]);
});

test("非法下标被忽略（负数 / 小数 / NaN）", () => {
	const base = [3, 4];
	assert.equal(policy.mergePinnedRange(base, [-1, 1.5, Number.NaN]), base);
});

test("结果永远是升序且无重复（库的硬要求）", () => {
	const out = merged([5, 6], [9, 2, 7, 2]);
	for (let i = 1; i < out.length; i += 1) assert.ok(out[i] > out[i - 1], "必须严格升序");
	assert.equal(new Set(out).size, out.length);
});

test("越界下标被跳过（limit = 行数）", () => {
	// 纯函数不该依赖调用方自律：越界下标一旦进 rangeExtractor，
	// tanstack 会按它取 virtualEntries[undefined] 渲染空行。
	assert.deepEqual(merged([1, 2], [5], 5), [1, 2]);
	assert.deepEqual(merged([1, 2], [4], 5), [1, 2, 4]);
	assert.deepEqual(merged([1, 2], [4, 9], 5), [1, 2, 4]);
	// 0 是合法下标（< limit），-1 才是非法
	assert.deepEqual(merged([1, 2], [-1, 0, 1], 5), [0, 1, 2]);
});

test("rangeExtractor 自证：越界 / 乱序 / 重复都会抛，但只在开发期跑", () => {
	// 两层判据，缺一不可：
	//  ① 行为层（下面三条）：给坏样本必须抛，给好样本必须不抛 —— 这是「坏样本会红」的那条；
	//  ② 接线层（本条）：断言自证被开发期开关包着，不许裸 throw。
	// 为什么必须门控：throw 会被根级 AppErrorBoundary 兜住，生产环境违约 = 整个应用降级
	// 成错误页（用户丢全部会话），而不是时间线里少一行。mergePinnedRange 本身保证
	// 升序/去重/不越界，所以自证一旦触发就是它坏了 —— 开发期炸、生产期忍。
	const source = readFileSync("src/renderer/src/components/session/timeline/VirtualRunList.tsx", "utf8");
	assert.match(source, /mergePinnedRange\(defaultRangeExtractor\(range\), pinnedIndexesRef\.current, count\)/, "必须把 count 传给 mergePinnedRange");
	assert.match(source, /if \(IS_DEV_BUILD\) assertRangeIndexes\(merged, count\);/, "自证必须在开发期开关里调用");
	// 反向判据：rangeExtractor 里不许出现裸 throw（改回无条件抛就必须让这条红）。
	assert.doesNotMatch(source, /rangeExtractor = useCallback[\s\S]*?throw new Error/, "rangeExtractor 里不许裸 throw：生产环境会整页白屏");
	assert.doesNotMatch(source, /import\.meta\.env\.DEV/, "不许用开发期环境常量（沙箱里是语法错误）");
});

test("assertRangeIndexes：坏样本必须抛，好样本必须不抛", () => {
	const ok = (indexes, limit) => policy.assertRangeIndexes(indexes, limit);
	ok([0, 2, 5], 6);
	ok([], 0);
	assert.throws(() => ok([0, 6], 6), /越界/, "等于 limit 也算越界");
	assert.throws(() => ok([-1, 0], 3), /越界/, "负数越界");
	assert.throws(() => ok([1.5], 3), /越界/, "非整数越界");
	assert.throws(() => ok([2, 1], 5), /未严格升序/, "乱序");
	assert.throws(() => ok([2, 2], 5), /未严格升序/, "重复");
});
