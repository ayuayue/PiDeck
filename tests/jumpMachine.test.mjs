import assert from "node:assert/strict";
import test from "node:test";
import { JUMP_BUDGET_MS, JUMP_MAX_EXPAND_ATTEMPTS, JUMP_MAX_LOAD_ATTEMPTS, JUMP_MAX_STALLED_ATTEMPTS, JUMP_WAIT_FRAMES_BEFORE_EXPAND, nextJumpTick } from "../src/renderer/src/components/session/timeline/jumpMachine.ts";

const base = {
	targetMounted: false,
	targetInData: false,
	hasMorePages: true,
	isLoadingPage: false,
	waitFrames: 0,
	loadAttempts: 0,
	stalledAttempts: 0,
	expandAttempts: 0,
	elapsedMs: 0,
	// 默认：入口已请求揭示、没有取页在途（老断言语义不变）。
	revealRequested: true,
	pageInFlight: false,
};
test("已挂载就落位——优先于超时和一切其他判断", () => {
	assert.deepEqual(nextJumpTick({ ...base, targetMounted: true }), { kind: "settle" });
	assert.deepEqual(nextJumpTick({ ...base, targetMounted: true, elapsedMs: JUMP_BUDGET_MS * 10 }), { kind: "settle" });
});

test("数据里有、还没挂载：先等两帧，再扩窗", () => {
	assert.deepEqual(nextJumpTick({ ...base, targetInData: true }), { kind: "wait" });
	assert.deepEqual(nextJumpTick({ ...base, targetInData: true, waitFrames: JUMP_WAIT_FRAMES_BEFORE_EXPAND }), { kind: "expand" });
});

test("数据里没有、还有页：补页；页在途就等", () => {
	assert.deepEqual(nextJumpTick(base), { kind: "load-page" });
	assert.deepEqual(nextJumpTick({ ...base, isLoadingPage: true }), { kind: "wait" });
});

test("三种放弃原因各自可达，且分得开", () => {
	assert.deepEqual(nextJumpTick({ ...base, targetInData: true, waitFrames: 2, expandAttempts: JUMP_MAX_EXPAND_ATTEMPTS }), { kind: "fail", reason: "target-not-mountable" });
	assert.deepEqual(nextJumpTick({ ...base, hasMorePages: false }), { kind: "fail", reason: "no-earlier-pages" });
	assert.deepEqual(nextJumpTick({ ...base, loadAttempts: JUMP_MAX_LOAD_ATTEMPTS }), { kind: "fail", reason: "load-attempts-exhausted" });
});

test("有界：超时必给结论，不会无限空转", () => {
	assert.deepEqual(nextJumpTick({ ...base, elapsedMs: JUMP_BUDGET_MS }), { kind: "fail", reason: "load-attempts-exhausted" });
	assert.deepEqual(nextJumpTick({ ...base, targetInData: true, elapsedMs: JUMP_BUDGET_MS }), { kind: "fail", reason: "target-not-mountable" });
	assert.deepEqual(nextJumpTick({ ...base, hasMorePages: false, elapsedMs: JUMP_BUDGET_MS }), { kind: "fail", reason: "no-earlier-pages" });
});

test("是函数：同样输入两次给出同样输出", () => {
	const input = { ...base, targetInData: true, waitFrames: 1 };
	assert.deepEqual(nextJumpTick(input), nextJumpTick(input));
});

test("任何输入都有结论，没有未定义分支", () => {
	const kinds = new Set();
	for (const targetMounted of [true, false])
		for (const targetInData of [true, false])
			for (const hasMorePages of [true, false])
				for (const isLoadingPage of [true, false])
					for (const pageInFlight of [true, false])
						for (const revealRequested of [true, false])
							for (const waitFrames of [0, JUMP_WAIT_FRAMES_BEFORE_EXPAND]) {
								const tick = nextJumpTick({ ...base, targetMounted, targetInData, hasMorePages, isLoadingPage, pageInFlight, revealRequested, waitFrames });
								assert.ok(tick && typeof tick.kind === "string");
								kinds.add(tick.kind);
							}
	assert.deepEqual([...kinds].sort(), ["expand", "fail", "load-page", "reveal", "settle", "wait"]);
});

test("H4：连续两次「发出但数据没长」立刻报，不等 40 次", () => {
	// 这是本次重构的核心判据：进度用可观测的不变量（数据有没有变长）度量，
	// 不用意图（发了几次请求）。旧实现只数发出次数 → 40 次全打在 prepend 被拒上。
	assert.deepEqual(nextJumpTick({ ...base, stalledAttempts: JUMP_MAX_STALLED_ATTEMPTS }), { kind: "fail", reason: "backfill-not-advancing" });
	// 一次没进展还允许再试一次
	assert.deepEqual(nextJumpTick({ ...base, stalledAttempts: 1 }), { kind: "load-page" });
	// 与「补页次数用完」是两个不同原因，必须分得开
	assert.notDeepEqual(nextJumpTick({ ...base, stalledAttempts: JUMP_MAX_STALLED_ATTEMPTS }), nextJumpTick({ ...base, loadAttempts: JUMP_MAX_LOAD_ATTEMPTS }));
});

test("取页在途不判死：hasMorePages 是取页之前的过期快照", () => {
	// 反例（2026-11-25 真机日志，同一条链 14ms 内）：
	//   tick    stillInData=false hasMorePages=false pageRequested=true
	//   give-up reason=no-earlier-pages
	//   merge   pageMessages=58 merged=918 pageHasTarget=true
	// 状态机在取页 promise 落地之前就判了死，用户看到提示时页其实已经取到了。
	assert.deepEqual(nextJumpTick({ ...base, targetInData: false, hasMorePages: false, pageInFlight: true }), { kind: "wait" });
	// 不在途时同一个输入仍必须判死（否则会变成无限等待）
	assert.deepEqual(nextJumpTick({ ...base, targetInData: false, hasMorePages: false, pageInFlight: false }), { kind: "fail", reason: "no-earlier-pages" });
});

test("目标在数据里却没挂载：先请求揭示，再等，最后才扩窗", () => {
	// 折叠区（已完成轮的执行过程）收起时子树整块卸载，扩窗只多挂轮次、永远挂不出节点。
	// 旧顺序 wait→expand→H1 让「搜到了却跳不过去」变成常态（2026-11-25：19 条 H1）。
	assert.deepEqual(nextJumpTick({ ...base, targetInData: true, revealRequested: false }), { kind: "reveal" });
	assert.deepEqual(nextJumpTick({ ...base, targetInData: true, revealRequested: true, waitFrames: 0 }), { kind: "wait" });
	assert.deepEqual(nextJumpTick({ ...base, targetInData: true, revealRequested: true, waitFrames: JUMP_WAIT_FRAMES_BEFORE_EXPAND }), { kind: "expand" });
	// 揭示过一次就不再重复请求（否则每帧刷 nonce，TurnRow 的 effect 会被打爆）
	assert.notDeepEqual(nextJumpTick({ ...base, targetInData: true, revealRequested: true }), { kind: "reveal" });
});
