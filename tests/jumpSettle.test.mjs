import assert from "node:assert";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox();
const settle = load("src/renderer/src/components/session/timeline/jumpSettle.ts");

const step = (input) => settle.planJumpSettleStep({ frames: 0, elapsedMs: 0, interrupted: false, ...input });

test("已经对齐（|漂移| <= 1px）就停：不许再多滚一下", () => {
	// 若实现忽略漂移、每帧都补，用户会看到跳转后画面自己抖一下 —— 这条会红。
	assert.deepEqual(step({ driftPx: 0 }), { kind: "settled" });
	assert.deepEqual(step({ driftPx: 1 }), { kind: "settled" });
	assert.deepEqual(step({ driftPx: -1 }), { kind: "settled" });
});

test("1.5px 不算对齐：容差只吃亚像素抗锯齿", () => {
	// 把容差调大到 8px 的写法会让这条红 —— 那正是「看着还差一行也不动了」的形状。
	assert.deepEqual(step({ driftPx: 1.5 }), { kind: "scroll", delta: 1.5 });
	assert.deepEqual(step({ driftPx: -1.5001 }), { kind: "scroll", delta: -1.5001 });
});

test("漂移 240px 补 240px（正 = 目标在视口下方，要往下滚）", () => {
	const decision = step({ driftPx: 240 });
	assert.equal(decision.kind, "scroll");
	assert.equal(decision.delta, 240, "补的必须是实测漂移本身，不是估算或固定步长");
});

test("负漂移照样补，方向由符号决定", () => {
	assert.deepEqual(step({ driftPx: -35 }), { kind: "scroll", delta: -35 });
});

test("第 24 帧一定收手（帧数上限）", () => {
	assert.equal(settle.JUMP_SETTLE_MAX_FRAMES, 24);
	assert.deepEqual(step({ driftPx: 300, frames: 23 }), { kind: "scroll", delta: 300 }, "第 23 帧还得继续补");
	assert.deepEqual(step({ driftPx: 300, frames: 24 }), { kind: "give-up", reason: "frames" });
});

test("600ms 一定收手（低帧率设备的兜底）", () => {
	assert.equal(settle.JUMP_SETTLE_MAX_MS, 600);
	assert.deepEqual(step({ driftPx: 300, elapsedMs: 599 }), { kind: "scroll", delta: 300 });
	assert.deepEqual(step({ driftPx: 300, elapsedMs: 600 }), { kind: "give-up", reason: "timeout" });
});

test("用户动手优先于一切：哪怕已经对齐也不再补", () => {
	assert.deepEqual(step({ driftPx: 0, interrupted: true }), { kind: "give-up", reason: "interrupted" });
	assert.deepEqual(step({ driftPx: 500, interrupted: true }), { kind: "give-up", reason: "interrupted" });
	assert.deepEqual(step({ driftPx: 500, frames: 99, elapsedMs: 9999, interrupted: true }), { kind: "give-up", reason: "interrupted" }, "动手判断必须排在上限判断之前，否则 600ms 后会先报 timeout，用户看到的提示就错了");
});

test("目标行不在 DOM（null）→ 放弃，不空转", () => {
	assert.deepEqual(step({ driftPx: null }), { kind: "give-up", reason: "target-missing" });
});

test("漂移很小时收敛而不是给 up：3 帧内不会无限循环", () => {
	// 模拟：第 0 帧漂移 40，第 1 帧 0.6 → 收敛。若实现永远返回 scroll，这里会看出来。
	let frames = 0;
	let elapsedMs = 0;
	let drift = 40;
	const trace = [];
	for (;;) {
		const decision = settle.planJumpSettleStep({ driftPx: drift, frames, elapsedMs, interrupted: false });
		trace.push(decision.kind);
		if (decision.kind !== "scroll") break;
		frames += 1;
		elapsedMs += 16;
		drift = frames === 1 ? 0.6 : drift;
	}
	assert.deepEqual(trace, ["scroll", "settled"]);
});
