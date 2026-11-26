import assert from "node:assert/strict";
import test from "node:test";

import { RAIL_TICK_LIMIT, RAIL_TICK_MIN_SIZE, railBuckets, railCapacity } from "../src/renderer/src/components/session/timeline/outlineRailTicks.ts";

/**
 * 刻度条数按可用高度自适应（2026-11 真机：85 轮会话点刻度「定位到别的地方」）。
 * 固定 30 段时一根代表好几条提问，只能落到段首；能一条一根时点哪根到哪条。
 */
test("容量 = 可用高度 / 可点间距（12），高度 0 时退回下限", () => {
	// 期望值写字面数，不写 700 / RAIL_TICK_MIN_SIZE。
	// 后者等于把同一个常量算两遍：常量从 12 改成 6 时两边一起变，测试照样绿
	// （2026-11-22 变异实测：分母改 6，67 条刻度测试全绿）。
	assert.equal(RAIL_TICK_MIN_SIZE, 12, "可点间距是 12；6 时 1000px 画 104 根，2px 线 + 4px 空隙连成虚线");
	assert.equal(railCapacity(700), 58, "floor(700 / 12)");
	assert.equal(railCapacity(120), 10, "floor(120 / 12)");
	assert.equal(railCapacity(0), RAIL_TICK_LIMIT, "高度 0 时取条数上限，不返回 0（0 根刻度等于没有导航）");
	assert.equal(railCapacity(-5), RAIL_TICK_LIMIT, "负高度同上");
});

test("85 条提问在 1100px 里一条一根，不合并", () => {
	const items = Array.from({ length: 85 }, (_, index) => ({ id: "m" + index }));
	const capacity = railCapacity(1100);
	assert.equal(capacity >= 85, true);
	assert.deepEqual(railBuckets(items, capacity), items);
});

test("条数超过容量才均分，且段首递增不重复", () => {
	const items = Array.from({ length: 500 }, (_, index) => ({ id: "m" + index }));
	const capacity = railCapacity(400);
	assert.equal(capacity < 500, true);
	const buckets = railBuckets(items, capacity);
	assert.equal(buckets.length, capacity);
	const indexes = buckets.map((item) => Number(item.id.slice(1)));
	for (let index = 1; index < indexes.length; index += 1) assert.equal(indexes[index] > indexes[index - 1], true);
});

test("高度为 0（首帧未测量）时退回 30 段，不抛错", () => {
	const items = Array.from({ length: 85 }, (_, index) => ({ id: "m" + index }));
	assert.equal(railBuckets(items, railCapacity(0)).length, RAIL_TICK_LIMIT);
});
