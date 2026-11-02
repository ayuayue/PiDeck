import assert from "node:assert/strict";
import test from "node:test";

import { planRailJump } from "../src/renderer/src/components/session/timeline/outlineRailTicks.ts";

/**
 * 占位刻度的方向判定（2026-11 真机）。
 *
 * 反馈原话：「我是从第一条，点最后一条出现的」「从上到下，从下到上，两个方向」。
 * 旧实现把所有占位刻度都当成「在更早的历史里」，从顶部点最新那条也会一路向上补页，
 * 补到会话开头后弹「这条提问还在更早的历史里」——方向反了。
 */
const item = (id, pending) => ({ id, role: "user", title: id, time: "", pending });

test("目标在已加载区间之前：向上补页", () => {
	const items = [item("outline-pending:a", true), item("outline-pending:b", true), item("m1", false), item("m2", false)];
	assert.deepEqual(planRailJump(items, "outline-pending:b"), { kind: "fill-earlier" });
});

test("目标在已加载区间之后（最新一条占位）：直接跳，落到最近的已加载项", () => {
	const items = [item("m1", false), item("m2", false), item("outline-pending:live", true)];
	assert.deepEqual(planRailJump(items, "outline-pending:live"), { kind: "jump", id: "m2" });
});

test("中间夹着占位：已加载项之后仍算「不需要补页」", () => {
	const items = [item("m1", false), item("outline-pending:x", true), item("m2", false), item("outline-pending:y", true)];
	assert.deepEqual(planRailJump(items, "outline-pending:y"), { kind: "jump", id: "m2" });
});

test("冷会话（一条都没加载）仍然走补页", () => {
	const items = [item("outline-pending:a", true), item("outline-pending:b", true)];
	assert.deepEqual(planRailJump(items, "outline-pending:b"), { kind: "fill-earlier" });
});

test("非占位刻度原样跳转", () => {
	const items = [item("m1", false), item("m2", false)];
	assert.deepEqual(planRailJump(items, "m1"), { kind: "jump", id: "m1" });
});
