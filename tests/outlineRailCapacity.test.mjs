import assert from "node:assert/strict";
import test from "node:test";

import { RAIL_TICK_LIMIT, RAIL_TICK_MIN_SIZE, railBuckets, railCapacity } from "../src/renderer/src/components/session/timeline/outlineRailTicks.ts";

/**
 * 刻度条数按可用高度自适应（2026-11 真机：85 轮会话点刻度「定位到别的地方」）。
 * 固定 30 段时一根代表好几条提问，只能落到段首；能一条一根时点哪根到哪条。
 */
test("容量 = 可用高度 / 最小间距，且不低于 30", () => {
	assert.equal(railCapacity(700), Math.floor(700 / RAIL_TICK_MIN_SIZE));
	assert.equal(railCapacity(700) >= RAIL_TICK_LIMIT, true);
	assert.equal(railCapacity(120), Math.floor(120 / RAIL_TICK_MIN_SIZE));
	assert.equal(railCapacity(0), RAIL_TICK_LIMIT);
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
