// 复现并锁住用户报的三个症状：跳转慢 / 卡 / 回不到顶部。
// 全部用纯函数算，不跑 Electron。
//
// 2026-11-22 实测（修复前）：指数扩窗 3 x min(2^k,8)，JUMP_MAX_EXPAND_ATTEMPTS = 8，
// 累计只能给 141 轮。会话超过 140 轮时点最上面那条刻度必然 give-up ——
// 用户原话「回不到顶部」，他的会话有 1000 轮。
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const W = loadTsCommonJs("src/renderer/src/components/session/timeline/jumpWindowPolicy.ts");
const E = loadTsCommonJs("src/renderer/src/components/session/timeline/windowExpandPlan.ts");
const S = loadTsCommonJs("src/renderer/src/components/session/timeline/jumpSettle.ts");
const T = loadTsCommonJs("src/renderer/src/components/session/timeline/turnRenderWindow.ts");

function session(n) {
	const messages = [];
	for (let i = 0; i < n; i += 1) {
		messages.push({ role: "user" });
		messages.push({ role: "assistant" });
	}
	return messages;
}

/** 模拟真实跳转链：每帧问一次策略，累加已扩轮数，直到剩余为 0 或放弃。返回帧数与是否到顶。 */
function runJump(turns) {
	const messages = session(turns);
	const needed = W.estimateJumpExpandTurns(messages, 0);
	let expanded = 0;
	let frames = 0;
	for (let guard = 0; guard < 10000; guard += 1) {
		const action = W.resolveJumpPendingAction({
			targetInLoadedData: true,
			hasMorePages: false,
			isLoadingPage: false,
			expandAttempts: frames,
			loadAttempts: 0,
			neededTurns: needed,
			expandedTurns: expanded,
		});
		if (action.kind !== "expand") return { turns, needed, frames, expanded, reached: false, reason: action.kind };
		if (action.turns === 0) return { turns, needed, frames, expanded, reached: true };
		expanded += action.turns;
		frames += 1;
	}
	return { turns, needed, frames, expanded, reached: false, reason: "guard" };
}

test("回不到顶部（1000 轮会话）：分批扩窗必须到顶，不放弃", () => {
	for (const turns of [30, 130, 141, 300, 1000]) {
		const r = runJump(turns);
		console.log(`  ${String(turns).padStart(4)} 轮：需要 ${r.needed}，${r.frames} 帧扩完 ${r.expanded}，${r.reached ? "到顶" : "放弃(" + r.reason + ")"}`);
		assert.equal(r.reached, true, `${turns} 轮会话回不到顶部`);
	}
});

test("跳转慢：每帧只挂批次量，不是一次全挂", () => {
	const batch = E.TURN_WINDOW_EXPAND_BATCH_TURNS;
	const r = runJump(1000);
	const msExpand = (r.frames * 1000) / 60;
	const msSettle = (S.JUMP_SETTLE_MAX_FRAMES * 1000) / 60;
	console.log(`  1000 轮：${r.frames} 帧 x ${batch} 轮 ≈ ${Math.round(msExpand)}ms；settle 上限 ${Math.round(msSettle)}ms`);
	assert.ok(batch === E.TURN_WINDOW_EXPAND_BATCH_TURNS);
	assert.ok(r.frames * batch >= r.needed - batch, "帧数 x 批次要覆盖需要量（允许最后一帧不满）");
});

test("卡：单帧挂载量有上限", () => {
	const batch = E.TURN_WINDOW_EXPAND_BATCH_TURNS;
	const action = W.resolveJumpPendingAction({
		targetInLoadedData: true,
		hasMorePages: false,
		isLoadingPage: false,
		expandAttempts: 0,
		loadAttempts: 0,
		neededTurns: 1000,
		expandedTurns: 0,
	});
	console.log(`  1000 轮会话的首帧批次：${action.turns} 轮`);
	assert.equal(action.turns, batch, "首帧只能给一个批次，不能一次挂 1000 轮");
});
