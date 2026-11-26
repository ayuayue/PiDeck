import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox();
const W = load("src/renderer/src/components/session/timeline/turnRenderWindow.ts");
const window6 = W.JUMP_WINDOW_RUNS_EACH_SIDE;
const maxRuns = W.JUMP_WINDOW_RUNS_MAX;

// 造一份 runs：n 个 agent-run，每个带一条消息 id。
const runs = (n) => Array.from({ length: n }, (_, i) => ({ kind: "agent-run", id: "run-" + i, items: [{ id: "m-" + i }] }));

// 锚点窗口半径必须能被扩窗改大。
// 反例（2026-11-25 数学组2，路径 1 → 100 → 200 → 300）：
//   锚点窗口是固定 12 轮的切片，而 expandWindowBatched 改的是 scrolledWindowTurns。
//   有锚点时渲染层走切片分支，scrolledWindowTurns 根本不参与 → 等待循环按节拍扩窗 3 次，
//   窗口一轮都没变 → 目标轮始终不在 DOM → 干等到 120 帧超时 → 用户「要点好几次」。
test("默认半径就是双侧各 6 轮（不能悄悄退回固定窗口）", () => {
	const out = W.resolveAnchoredTurnWindow(runs(40), 3, "m-20");
	assert.equal(out.length, window6 * 2 + 1, "40 轮数据、锚点居中时应切 13 轮，实际 " + out.length);
	assert.equal(out[0].id, "run-14");
});

test("半径变大，切片必须跟着变大（这是扩窗生效的唯一通道）", () => {
	const big = W.resolveAnchoredTurnWindow(runs(40), 3, "m-20", 20);
	assert.equal(big.length, 40, "半径 20 时上下都够，应覆盖全部 40 轮，实际 " + big.length);
	const mid = W.resolveAnchoredTurnWindow(runs(40), 3, "m-20", 10);
	assert.equal(mid.length, 21, "半径 10 → 21 轮，实际 " + mid.length);
});

test("半径有上界：不能靠一次跳转把整份会话挂进 DOM", () => {
	const huge = W.resolveAnchoredTurnWindow(runs(200), 3, "m-100", 1000);
	assert.equal(huge.length, maxRuns * 2 + 1, "应被上限夹住（" + maxRuns + "），实际 " + huge.length);
	assert.ok(maxRuns <= 80, "上限应在几十轮量级，实际 " + maxRuns);
});

test("半径给非法值时退化为最小可用窗口，不返回空切片", () => {
	for (const bad of [0, -5, Number.NaN]) {
		const out = W.resolveAnchoredTurnWindow(runs(40), 3, "m-20", bad);
		assert.ok(out.length >= 3, "半径 " + bad + " 时至少要有锚点前后一轮，实际 " + out.length);
	}
});

test("锚点命不中时退回有界尾部窗口（不能变成全量）", () => {
	const out = W.resolveAnchoredTurnWindow(runs(40), 3, "m-not-there", 20);
	assert.equal(out.length, 3, "应退回尾部窗口轮数，实际 " + out.length);
});

test("接线：扩窗时同时长锚点半径，跳转结束缩回（源码契约）", () => {
	// 半径状态与缩回都搬进 useTimelineJumpChain（巨文件只准降）；长半径唯一入口是 growJumpWindowRuns。
	const ctl = readFileSync("src/renderer/src/hooks/session/timeline/useTimelineJumpChain.ts", "utf8");
	// 长半径的实现在那个 hook 里（setJumpWindowRuns + 上界夹取）；控制器只经 ref 调用它，
	// 且必须仍然只在跳转在途时调用（否则贴底滚动也会把半径撑大，大会话掉帧）。
	const controller = readFileSync("src/renderer/src/hooks/useSessionTimelineController.ts", "utf8");
	assert.match(controller, /if \(growJumpWindow && pendingJumpRef\.current\) growJumpWindowRunsRef\.current\?\.\(turns\)/, "扩窗必须长半径，且只在跳转在途 + 允许时");
	const nav = readFileSync("src/renderer/src/hooks/session/timeline/useTimelineJumpNavigation.ts", "utf8");
	// 落位对齐的扩窗必须「节流长半径」：全不涨会让目标在锚点窗口外时永远挂不出来
	// （日志：8 次 expand 后 scrollHeight 恒不变 → no-scroll-room）；每帧都涨则是放大环。
	assert.match(nav, /expandWindowBatched\(2, expandAttempts % 2 === 1\)/, "落位扩窗必须每隔一次长半径");
	assert.match(controller, /growJumpWindowRunsRef\.current = growJumpWindowRuns/, "控制器必须接上 hook 给的写入口");
	assert.match(ctl, /if \(pendingJump === undefined\) setJumpWindowRuns\(JUMP_WINDOW_RUNS_EACH_SIDE\)/, "跳转结束必须缩回默认");
	const smt = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
	assert.match(smt, /resolveAnchoredTurnWindow\(reconciledRuns, turnWindowTurns, windowAnchorId, props\.controller\.jumpWindowRuns\)/, "渲染层必须把半径传进切片");
	const ctr = readFileSync("src/renderer/src/hooks/session/timeline/sessionTimelineControllerContract.ts", "utf8");
	assert.match(ctr, /jumpWindowRuns: number;/, "契约必须暴露半径");
});
