import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox();
const plan = load("src/renderer/src/components/session/timeline/windowExpandPlan.ts");

test("backlog 为 0 或负数时不扩窗", () => {
	assert.equal(plan.planWindowExpandBatch(0), 0);
	assert.equal(plan.planWindowExpandBatch(-5), 0);
});

test("单帧最多 8 轮：不论 backlog 多大都不整批推开", () => {
	for (const backlog of [1, 7, 8, 9, 24, 25, 130, 300, 1000]) {
		const batch = plan.planWindowExpandBatch(backlog);
		assert.ok(batch <= 8, "backlog=" + backlog + " 单帧扩了 " + batch + " 轮，超了单帧预算");
		assert.ok(batch >= 1, "backlog=" + backlog + " 没扩任何轮，会停在原地");
	}
});

test("跳 130 轮：分 17 帧推完，不是 1 帧", () => {
	let backlog = 130;
	let frames = 0;
	while (backlog > 0 && frames < 1000) {
		backlog -= plan.planWindowExpandBatch(backlog);
		frames += 1;
	}
	assert.equal(frames, Math.ceil(130 / 8));
	assert.equal(backlog, 0);
});

test("逐帧消费的总量等于待扩量，不漏也不多", () => {
	for (const total of [3, 8, 9, 100, 233]) {
		let backlog = total;
		let grown = 0;
		while (backlog > 0) {
			const batch = plan.planWindowExpandBatch(backlog);
			grown += batch;
			backlog -= batch;
		}
		assert.equal(grown, total);
	}
});

test("窗口封顶：到顶不再涨，但已超出的值不被缩回去", () => {
	// 未到顶：正常相加
	assert.equal(plan.capWindowTurns(10, 8, 30), 18);
	// 相加会越界：钳到上限
	assert.equal(plan.capWindowTurns(10, 8, 12), 12);
	// 已经超过上限：保持原值（既不涨也不缩——缩回会触发一次大幅内容收缩）
	assert.equal(plan.capWindowTurns(50, 8, 30), 50);
	assert.equal(plan.capWindowTurns(40, 8, 30), 40);
});

test("每次扩窗都必须真的排下一帧，不允许在 while 里同步消费完", () => {
	// 纯函数测试证明不了「是否真的分帧」：把 planWindowExpandBatch 写对、调用方却用
	// while 循环同步跑完，测试照样全绿而界面照样卡一帧。所以钉消费端的形状。
	const source = readFileSync("src/renderer/src/hooks/useSessionTimelineController.ts", "utf8");
	const start = source.indexOf("const consumeExpandBatch = useCallback(");
	assert.ok(start > 0, "找不到 consumeExpandBatch");
	const end = source.indexOf("}, [", start);
	const body = source.slice(start, end);
	assert.match(body, /if \(pendingExpandTurnsRef\.current > 0\)/, "必须显式判断剩余待扩量");
	assert.match(body, /requestAnimationFrame\(consumeExpandBatch\)/, "剩余待扩量必须排下一帧，不能同步 while 消费完");
	assert.doesNotMatch(body, /while\s*\(/, "不允许 while 循环同步消费");
});
