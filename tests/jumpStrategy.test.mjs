import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { planJumpStrategy } = loadTsCommonJs("src/renderer/src/components/session/timeline/jumpStrategy.ts");

test("目标在实心区：扩窗路径（其实不用动窗口）", () => {
	const shape = { total: 100, virtualCount: 90, solidStart: 90 };
	assert.equal(planJumpStrategy(shape, 95), "expand");
	assert.equal(planJumpStrategy(shape, 99), "expand");
});

test("目标在虚拟区：钉住，不扩窗", () => {
	const shape = { total: 1000, virtualCount: 997, solidStart: 997 };
	assert.equal(planJumpStrategy(shape, 0), "pinned", "跳到最上面那条：钉一行 vs 扩 997 轮");
	assert.equal(planJumpStrategy(shape, 500), "pinned");
	assert.equal(planJumpStrategy(shape, 996), "pinned");
	assert.equal(planJumpStrategy(shape, 997), "expand", "边界：第一个实心条目走扩窗");
});

test("不虚拟化时一律扩窗（没有虚拟区可钉）", () => {
	assert.equal(planJumpStrategy({ total: 5, virtualCount: 0, solidStart: 0 }, 0), "expand");
});

test("非法下标走扩窗，不抛", () => {
	const shape = { total: 10, virtualCount: 5, solidStart: 5 };
	assert.equal(planJumpStrategy(shape, -1), "expand");
	assert.equal(planJumpStrategy(shape, 10), "expand");
	assert.equal(planJumpStrategy(shape, Number.NaN), "expand");
});
