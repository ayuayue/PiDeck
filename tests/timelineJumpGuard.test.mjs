import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 跳转事务与贴底引擎的仲裁契约（用户四次反馈「输出时点刻度跳不回去、停手后又能跳」）。
 *
 * 要挡的是这条链：流式输出 → 引擎每帧 resize 并上报 following=true → autoScroll 变 true
 * → 该 effect 清空 pendingExpandTurnsRef 并 cancel 扩窗帧 → 挂起中的跳转等不到目标轮挂载。
 * 表现就是「点了没反应」。
 *
 * 第二条链（2026-11 补）：**跳转落位后**目标行本来就在 DOM 里（流式时用户点的常常就是最新
 * 那几轮），没有 pendingJump，于是没有任何事务标记在挡上报；目标恰在底部附近时引擎判定
 * following=true，autoScroll 被拉回 true，下一帧跟着新内容滚回底部——「跳过去了又弹回来」。
 * 所以判据要以**浏览 pin 存在**为准：pin 存在 = 视口被钉在某一行，引擎的「已跟底」是过期判定。
 *
 * 下面每组都覆盖两侧（该忽略 / 不该忽略）。只测「该忽略」一侧等于没测：把条件写成恒 true
 * 也能全绿。
 */

const { shouldIgnoreFollowReport, shouldResetExpandBudget } = loadTsCommonJs("src/renderer/src/hooks/timelineJumpGuard.ts");

test("跳转挂起时忽略引擎的跟底上报", () => {
	assert.equal(shouldIgnoreFollowReport(true, true), true, "跳转中 + 上报跟底 → 必须忽略");
});

test("没有跳转、也没有浏览 pin 时跟底上报照常接（否则用户滚回底部不再跟随）", () => {
	assert.equal(shouldIgnoreFollowReport(true, false), false);
	assert.equal(shouldIgnoreFollowReport(true, false, false), false);
});

test("跳转落位后只剩浏览 pin：仍要忽略跟底上报（否则跳了又弹回底部）", () => {
	assert.equal(shouldIgnoreFollowReport(true, false, true), true, "pin 存在 + 上报跟底 → 必须忽略");
});

test("引擎上报「不跟底」时永远不忽略（与跳转、pin 无关）", () => {
	assert.equal(shouldIgnoreFollowReport(false, true), false);
	assert.equal(shouldIgnoreFollowReport(false, false, true), false);
	assert.equal(shouldIgnoreFollowReport(false, true, true), false);
});

test("回底时清空扩窗预算；跳转在途时不清", () => {
	assert.equal(shouldResetExpandBudget(true, false), true);
	assert.equal(shouldResetExpandBudget(true, true), false);
	assert.equal(shouldResetExpandBudget(false, false), false);
});
