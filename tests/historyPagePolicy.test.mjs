import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const load = createTsSandbox();
const policy = load("src/renderer/src/components/session/timeline/historyPagePolicy.ts");

const user = { role: "user" };
const assistant = { role: "assistant" };
/** 造 n 轮「user + assistant」，与主进程按 turn 起点计数的口径一致。 */
function turns(n) {
	const out = [];
	for (let i = 0; i < n; i += 1) out.push(user, assistant);
	return out;
}

test("按钮翻页取 host 上限 10 轮，不是旧的 3 轮", () => {
	// 回归靶子：改回 3 时这条必红（真机症状「点一次只多一屏不到」）。
	assert.equal(policy.HISTORY_TURN_PAGE_SIZE, 10);
	assert.equal(policy.resolveHistoryPageSize("button"), 10);
});

test("滚动仍走 3 轮小步，跳转补页取满 10", () => {
	// 滚动是连续事件：一次 10 轮会把视口顶出去，所以按钮的 10 不能顺手给滚动用。
	assert.equal(policy.resolveHistoryPageSize("scroll"), 3);
	assert.notEqual(policy.resolveHistoryPageSize("scroll"), policy.resolveHistoryPageSize("button"));
});

test("跳转补页（backfill）取 host 上限 200，一次覆盖整份长会话", () => {
	// 回归靶子：改回 3 或 10 时这条必红。
	// 真机症状（两轮）：147 轮会话点最上面的刻度，一根刻度背后差几十轮 ——
	// 每次补 3 轮要点十几次；改成 10 之后仍要 16 次，每次约 0.5s 读盘，
	// 用户看到的是「一直在加载、加载不出来」（2026-11）。
	// backfill 只有跳转这一个用途 —— 两个调用方都是刻度/pendingJump 补页。
	// 200 的推演见常量注释：156 轮会话 = 5156 条消息 = 每轮约 33 条，
	// 200 轮 ≈ 6600 条 ≈ 13-26MB，仍在渲染层 8000 条预算之内 —— 一次读盘读完整份会话。
	assert.equal(policy.HISTORY_BACKFILL_TURN_PAGE_SIZE, 200);
	assert.equal(policy.resolveHistoryPageSize("backfill"), 200);
});

test("窗口增长按页内实际轮数放，不再被钳到 3 轮", () => {
	// 页里带了 20 轮，窗口必须能开 10（不超过页大小），而不是旧的恒 ≤3。
	assert.equal(policy.resolvePageWindowGrowth(turns(20), 10), 10);
	assert.equal(policy.resolvePageWindowGrowth(turns(7), 10), 7);
});

test("窗口增长不超过页大小：数据只有 2 轮时不多开空窗口", () => {
	assert.equal(policy.resolvePageWindowGrowth(turns(2), 10), 2);
	assert.equal(policy.resolvePageWindowGrowth(turns(2), 3), 2);
});

test("空页不扩窗（0 轮）", () => {
	assert.equal(policy.resolvePageWindowGrowth([], 10), 0);
});

test("页非空但不由 user 开头时仍至少开 1 轮", () => {
	// disk 消息页可能在长回答中间切断：整页没有 user 消息，turn 计数为 0。
	// 若这里返回 0，新加载的轮会被尾部窗口裁掉——数据已加载但看不见。
	assert.equal(policy.resolvePageWindowGrowth([assistant, assistant], 10), 1);
});

test("growth 默认页大小与按钮一致（漏传参数时不会退回旧的 3）", () => {
	assert.equal(policy.resolvePageWindowGrowth(turns(20)), 10);
});

test("页大小 200 轮时 DOM 挂载仍封顶 10 轮（否则一次挂 200 轮 = 点了就卡死）", () => {
	// 回归靶子：把 mountedLimit 那一项从 min(...) 里去掉，这条必红。
	// 这是「数据」与「窗口」的分界：backfill 现在一次拿 200 轮数据，
	// 但真实挂载必须留在个位数，否则就是「点一次刻度整页卡住」。
	assert.equal(policy.HISTORY_MOUNTED_TURN_GROWTH_LIMIT, 10);
	assert.equal(policy.resolvePageWindowGrowth(turns(200), 200), 10);
	assert.equal(policy.resolvePageWindowGrowth(turns(3), 200), 3, "页内轮数比上限少时按实际轮数");
});
