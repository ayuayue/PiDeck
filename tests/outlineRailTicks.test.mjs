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

test("再挤也不低于可点击下限（30 条 × 6px = 180px 覆盖极小窗口）", () => {
	assert.equal(railTicks.RAIL_TICK_MIN_SIZE, 6);
	// 30 条只给 120px → fitted=4，钳到下限 6
	const plan = railTicks.planRailTicks(makeItems(30), 120);
	assert.equal(plan.itemSize, 6);
	// 小窗 + 终端坞（消息列约 194px）仍能一次放下 30 条
	assert.ok(railTicks.RAIL_TICK_LIMIT * railTicks.RAIL_TICK_MIN_SIZE <= 194);
});

test("条数不超上限：原样返回（短会话完全不受窗口影响）", () => {
	assert.equal(railTicks.RAIL_TICK_LIMIT, 30);
	for (const count of [0, 1, 7, 29, 30]) {
		const items = makeItems(count);
		assert.deepEqual(idsOf(railTicks.windowRailItems(items, -1)), idsOf(items));
		assert.deepEqual(idsOf(railTicks.windowRailItems(items, count - 1)), idsOf(items));
	}
});

test("当前位置未知（首帧）：取最新的 30 条", () => {
	const windowed = railTicks.windowRailItems(makeItems(120), -1);
	assert.equal(windowed.length, 30);
	assert.equal(windowed[0].id, "msg-90");
	assert.equal(windowed[29].id, "msg-119");
});

test("停在底部：窗口就是「最新的 30 条」（用户想要的默认形态）", () => {
	const windowed = railTicks.windowRailItems(makeItems(120), 119);
	assert.equal(windowed[0].id, "msg-90");
	assert.equal(windowed[29].id, "msg-119");
});

test("往上翻：窗口跟着上移，更早的提问进入窗口（上滑即显示更多）", () => {
	const up = railTicks.windowRailItems(makeItems(120), 60);
	assert.equal(up.length, 30);
	// 当前位置必须落在窗口内
	assert.ok(
		up.some((item) => item.id === "msg-60"),
		"窗口必须包含当前检查点",
	);
	// 比「底部窗口」更早的提问已经进入窗口（上翻后才有的那批）
	assert.ok(up.some((item) => indexOfId(item.id) < 88));
	// 底部窗口（msg-90..msg-119）里的最新几条已不在窗口内
	assert.ok(!up.some((item) => indexOfId(item.id) >= 90));
	// 窗口整体比底部窗口更早
	assert.ok(indexOfId(up[0].id) < 90);
});

test("贴到会话开头：窗口不产生空位，取最早 30 条", () => {
	const windowed = railTicks.windowRailItems(makeItems(120), 0);
	assert.equal(windowed.length, 30);
	assert.equal(windowed[0].id, "msg-0");
	assert.equal(windowed[29].id, "msg-29");
});

test("窗口内条目下标严格递增、无重复、条数恒不超上限", () => {
	for (const anchor of [0, 5, 40, 60, 100, 119]) {
		const windowed = railTicks.windowRailItems(makeItems(300), anchor);
		assert.ok(windowed.length <= railTicks.RAIL_TICK_LIMIT);
		const indexes = windowed.map((item) => indexOfId(item.id));
		assert.equal(new Set(indexes).size, indexes.length);
		for (let i = 1; i < indexes.length; i += 1) assert.ok(indexes[i] > indexes[i - 1]);
		assert.ok(indexes.includes(anchor), `窗口必须包含 activeIndex=${anchor}`);
	}
});

test("补页预算是个有限的时间盒（不是页数保证）", () => {
	// 每次轮询 60ms；预算必须有限，否则补不到时会永远轮询下去
	assert.ok(Number.isInteger(railTicks.RAIL_PENDING_MAX_ATTEMPTS));
	assert.ok(railTicks.RAIL_PENDING_MAX_ATTEMPTS > 0 && railTicks.RAIL_PENDING_MAX_ATTEMPTS <= 20);
});
