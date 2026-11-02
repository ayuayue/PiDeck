import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox();
const policy = load("src/renderer/src/hooks/timeline/scrollHistoryPolicy.ts");
const plan = policy.planLoadMorePinSteps;

test("贴底点按钮：先脱离跟随，再抓钉行", () => {
	assert.deepEqual([...plan("button")], ["escapeFollow", "capturePin"]);
});

test("滚动触发的自动扩窗：只抓钉行，不脱离跟随", () => {
	assert.deepEqual([...plan("scroll")], ["capturePin"]);
});

test("回填不碰跟随态、也不抓钉行", () => {
	assert.deepEqual([...plan("backfill")], []);
});

test("顺序被调反必须能被抓到", () => {
	const steps = plan("button");
	const escapeAt = steps.indexOf("escapeFollow");
	const captureAt = steps.indexOf("capturePin");
	assert.ok(escapeAt >= 0, `缺少 escapeFollow，实际 ${JSON.stringify(steps)}`);
	assert.ok(captureAt >= 0, `缺少 capturePin，实际 ${JSON.stringify(steps)}`);
	assert.ok(escapeAt < captureAt, `escapeFollow 必须排在 capturePin 之前，实际 ${JSON.stringify(steps)}`);
});

test("同一来源反复调用结果稳定（无内部状态）", () => {
	assert.deepEqual([...plan("button")], [...plan("button")]);
	assert.deepEqual([...plan("scroll")], [...plan("scroll")]);
	assert.deepEqual([...plan("backfill")], [...plan("backfill")]);
});
