import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { clampTurnWindowStart, resolveTurnPageBefore } = loadTsCommonJs("src/main/pi/SessionHistoryReader.ts");

test("有更早历史时，窗口起点必须严格小于 before（否则空页 + 游标不前进 = 死循环）", () => {
	assert.equal(clampTurnWindowStart(5, 5), 4);
	assert.equal(clampTurnWindowStart(9, 5), 4);
	assert.equal(clampTurnWindowStart(2, 5), 2);
});

test("before 为 0 时起点只能是 0，靠 nextBefore=null 收尾而不是钳制", () => {
	assert.equal(clampTurnWindowStart(0, 0), 0);
	assert.equal(clampTurnWindowStart(3, 0), 0);
});

test("数值游标正常解析，并按 total 截断", () => {
	assert.equal(resolveTurnPageBefore(10, undefined, [], 100), 10);
	assert.equal(resolveTurnPageBefore(1000, undefined, [], 100), 100);
	assert.equal(resolveTurnPageBefore(undefined, undefined, [], 100), 100);
	assert.equal(resolveTurnPageBefore(-5, undefined, [], 100), 0);
});

test("entryId 解析成功时以它的下标为准（两个下标空间的唯一锚点）", () => {
	const entries = [{ id: "a" }, { id: "b" }, { id: "c" }];
	assert.equal(resolveTurnPageBefore(undefined, "b", entries, 3), 1);
	assert.equal(resolveTurnPageBefore(2, "a", entries, 3), 0);
});

test("entryId 解析失败且没有数值游标：返回 null，不得回退到尾部", () => {
	const entries = [{ id: "a" }, { id: "b" }];
	assert.equal(resolveTurnPageBefore(undefined, "not-in-index", entries, 2), null);
});

test("entryId 解析失败但带着数值游标：沿用数值游标", () => {
	const entries = [{ id: "a" }];
	assert.equal(resolveTurnPageBefore(1, "not-in-index", entries, 1), 1);
});
