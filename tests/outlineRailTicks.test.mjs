import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function compile(filePath) {
	const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, { module, exports: module.exports, require: () => ({}) });
	return module.exports;
}

const railTicks = compile("src/renderer/src/components/session/timeline/outlineRailTicks.ts");

const makeItems = (count) => Array.from({ length: count }, (_, index) => ({ id: `msg-${index}` }));
const idsOf = (items) => [...items].map((item) => item.id);
const indexOfId = (id) => Number(id.slice(4));

test("空条目：空规划", () => {
	const plan = railTicks.planRailTicks([], 800);
	assert.equal(plan.items.length, 0);
});

test("未测量（高度 ≤ 0）：上限间距，不阻塞首帧", () => {
	const plan = railTicks.planRailTicks(makeItems(30), 0);
	assert.equal(plan.items.length, 30);
	assert.equal(plan.itemSize, railTicks.RAIL_TICK_MAX_SIZE);
});

test("空间充裕：全量渲染，间距取上限", () => {
	const plan = railTicks.planRailTicks(makeItems(20), 800);
	assert.equal(plan.items.length, 20);
	assert.equal(plan.itemSize, railTicks.RAIL_TICK_MAX_SIZE);
});

test("放不下就按条数收缩，间距 = floor(可用高度 / 条数)", () => {
	// 30 条 / 380px → fitted=12，落在 [MIN=6, MAX=14) 区间
	const plan = railTicks.planRailTicks(makeItems(30), 380);
	assert.equal(plan.items.length, 30);
	assert.equal(plan.itemSize, 12);
	assert.ok(plan.items.length * plan.itemSize <= 380);
});

test("再挤也不低于可点击下限（12px 间距是密度目标，不是能塞多密的极限）", () => {
	assert.equal(railTicks.RAIL_TICK_MIN_SIZE, 12);
	// 30 条只给 120px → fitted=4，钳到下限 12
	const plan = railTicks.planRailTicks(makeItems(30), 120);
	assert.equal(plan.itemSize, 12);
	// 小窗 + 终端坞（消息列约 194px）：容量也按高度算，刻度总高不再溢出容器
	assert.ok(railTicks.railCapacity(194) * railTicks.RAIL_TICK_MIN_SIZE <= 194);
});

test("条数不超上限：一根一条（短会话完全不受分段影响）", () => {
	assert.equal(railTicks.RAIL_TICK_LIMIT, 30);
	for (const count of [0, 1, 7, 29, 30]) {
		assert.deepEqual(idsOf(railTicks.railBuckets(makeItems(count))), idsOf(makeItems(count)));
	}
});

test("超过 30 条：切成 30 段覆盖整段会话，首段必是会话开头", () => {
	for (const count of [31, 66, 73, 120, 300]) {
		const buckets = railTicks.railBuckets(makeItems(count));
		assert.equal(buckets.length, 30, `count=${count} 必须切成 30 段`);
		assert.equal(buckets[0].id, "msg-0", `count=${count} 第一段必须是会话开头`);
	}
});

test("末段落在会话末尾附近：整个会话都在刻度覆盖范围内", () => {
	for (const count of [31, 66, 73, 120, 300]) {
		const buckets = railTicks.railBuckets(makeItems(count));
		const lastIndex = indexOfId(buckets[buckets.length - 1].id);
		const bucketWidth = Math.ceil(count / 30);
		assert.ok(lastIndex >= count - bucketWidth, `count=${count} 末段下标 ${lastIndex} 离末尾太远`);
		assert.ok(lastIndex <= count - 1);
	}
});

test("段首严格递增、无重复（不会两段指向同一条）", () => {
	const indexes = railTicks.railBuckets(makeItems(300)).map((item) => indexOfId(item.id));
	assert.equal(new Set(indexes).size, indexes.length);
	for (let i = 1; i < indexes.length; i += 1) {
		assert.ok(indexes[i] > indexes[i - 1], `下标 ${indexes[i - 1]} → ${indexes[i]} 不是递增`);
	}
});

test("条数恒定：会话再长，刻度也不涨（真机 73 轮把右缘拉满）", () => {
	assert.equal(railTicks.railBuckets(makeItems(30)).length, 30);
	assert.equal(railTicks.railBuckets(makeItems(500)).length, 30);
	assert.equal(railTicks.railBuckets(makeItems(5000)).length, 30);
});

test("分段的选取与阅读位置无关（只收 items，不再按 activeIndex 滑动）", () => {
	// 旧实现按 activeIndex 截窗口，翻上翻下整列平移（2026-11「退化」）
	assert.equal(railTicks.railBuckets.length, 1);
	const items = makeItems(73);
	assert.deepEqual(idsOf(railTicks.railBuckets(items)), idsOf(railTicks.railBuckets(items)));
});

test("分段后仍需规划间距：段数由可用高度决定，刻度总高不溢出容器", () => {
	// 段数不再固定 30：30 x 12px = 360px 会把 194px 的小窗撑出容器（用户报的「长度快溢出」）。
	const capacity = railTicks.railCapacity(194);
	const buckets = railTicks.railBuckets(makeItems(200), capacity);
	assert.equal(buckets.length, capacity);
	assert.ok(buckets.length * railTicks.RAIL_TICK_MIN_SIZE <= 194);
	const plan = railTicks.planRailTicks(buckets, 194);
	assert.equal(plan.items.length, capacity);
	assert.ok(plan.items.length * plan.itemSize <= 194);
});

test("补页次数是防死循环的保险丝，不再按 600ms 时间盒计数", () => {
	// 渲染层现在等上一页落地再发下一页，次数只统计真正发起的补页（旧实现每 60ms 轮询，
	// in-flight 守卫让这些轮询全部空转）。一页 3 轮：60 页 ≈ 180 轮，覆盖长会话；
	// 旧值 10 页 ≈ 30 轮不够，62 轮会话里点最上面的刻度必弹「继续向上翻一会儿再点」。
	assert.ok(Number.isInteger(railTicks.RAIL_PENDING_MAX_ATTEMPTS));
	assert.ok(railTicks.RAIL_PENDING_MAX_ATTEMPTS >= 40 && railTicks.RAIL_PENDING_MAX_ATTEMPTS <= 200);
});
