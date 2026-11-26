import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function compile(filePath) {
	const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, { module, exports: module.exports, require: () => ({}) });
	return module.exports;
}

const J = compile("src/renderer/src/components/session/timeline/jumpSettle.ts");
const plan = J.planJumpSettleStep;
const MAX_EXPANDS = J.JUMP_SETTLE_MAX_EXPANDS;
const base = { frames: 2, elapsedMs: 50, interrupted: false, expandAttempts: 0 };

/** vm 里造出来的对象原型不同，strict deepEqual 会因「结构相同但引用不等」失败，所以逐字段比。 */
function expect(d, kind, extra) {
	assert.equal(d.kind, kind, "kind: got " + d.kind + " want " + kind);
	if (extra !== undefined) assert.equal(d.kind === "scroll" ? d.delta : d.reason, extra);
}

test("可滚动的常规情形仍是 scroll，行为不变", () => {
	expect(plan({ ...base, driftPx: 269, canScrollPx: 1850 }), "scroll", 269);
});

test("内容比视口矮：必须 expand，不能空转写 scrollTop", () => {
	// 反例（2026-11-25 日志实证）：settle scrollHeight=858 clientHeight=858 →
	// scrollTop 恒被钳在 0，drift 恒 269，24 帧后 give-up「frames」。
	// 用户看到的是「跳到第 1 条之后，100/200/300 全部跳不动」。
	expect(plan({ ...base, driftPx: 269, canScrollPx: 0 }), "expand");
	expect(plan({ ...base, driftPx: -800, canScrollPx: 2 }), "expand");
});

test("方向无关：向上跳（负漂移）与向下跳（正漂移）走同一条判据", () => {
	expect(plan({ ...base, driftPx: -1674, canScrollPx: 0 }), "expand");
	expect(plan({ ...base, driftPx: 1674, canScrollPx: 0 }), "expand");
});

test("可滚动空间够（>4px）就照常滚，不能被 expand 抢走", () => {
	expect(plan({ ...base, driftPx: 300, canScrollPx: 5 }), "scroll", 300);
});

test("扩窗次数用尽后如实报 no-scroll-room，不拖到帧数上限", () => {
	expect(plan({ ...base, driftPx: 300, canScrollPx: 0, expandAttempts: MAX_EXPANDS }), "give-up", "no-scroll-room");
});

/**
 * 末条目标在结构上滚不到视口顶：它下方没有内容，scrollTop 被钳在 maxScroll，
 * 缺口恒等于「目标下方残留高度」。扩窗无效（内容已到底），give-up 会触发重试 ——
 * 用户看到的就是「点了没反应，要点好几次」。
 *
 * 真机：2026-11-26 07:46:58 `no-scroll-room frames=8 driftPx=24`。
 */
test("扩窗用尽但只差不到一行（末条目标）→ 收下，不报 give-up", () => {
	expect(plan({ ...base, driftPx: 24, canScrollPx: 0, expandAttempts: MAX_EXPANDS }), "settled");
});

test("扩窗用尽、负方向的同样缺口也收下（向上跳）", () => {
	expect(plan({ ...base, driftPx: -24, canScrollPx: 0, expandAttempts: MAX_EXPANDS }), "settled");
});

test("扩窗用尽、缺口超出一行（目标没到附近）→ 仍然 give-up，不掩盖真失败", () => {
	expect(plan({ ...base, driftPx: 33, canScrollPx: 0, expandAttempts: MAX_EXPANDS }), "give-up", "no-scroll-room");
});

// 缺口大小取决于「目标离会话末尾多远」：真机 24 / 61 / 269 / 501px 都有样本。
// 固定像素阈值救不了这些，判据必须是「目标在不在视口里」。
const VIEWPORT = { viewportHeightPx: 900 };

test("缺口 269px 但目标已落在视口内（900px）→ 收下", () => {
	expect(plan({ ...base, ...VIEWPORT, driftPx: 269, canScrollPx: 0, expandAttempts: MAX_EXPANDS }), "settled");
});

test("缺口 501px 但仍在视口内 → 收下（目标接近会话末尾）", () => {
	expect(plan({ ...base, ...VIEWPORT, driftPx: 501, canScrollPx: 0, expandAttempts: MAX_EXPANDS }), "settled");
});

test("缺口超过视口高度（目标根本不在视口里）→ give-up，不假装到了", () => {
	expect(plan({ ...base, ...VIEWPORT, driftPx: 1200, canScrollPx: 0, expandAttempts: MAX_EXPANDS }), "give-up", "no-scroll-room");
});

test("视口高未知时退回保守阈值：269px 仍 give-up（不靠猜）", () => {
	expect(plan({ ...base, driftPx: 269, canScrollPx: 0, expandAttempts: MAX_EXPANDS }), "give-up", "no-scroll-room");
});

test("还没用尽扩窗次数时，同样 24px 应继续扩窗而不是收下", () => {
	expect(plan({ ...base, driftPx: 24, canScrollPx: 0, expandAttempts: 1 }), "expand");
});

test("已收敛优先于 expand：漂移 <= 1px 就是 settled", () => {
	expect(plan({ ...base, driftPx: 0.6, canScrollPx: 0 }), "settled");
});

test("不传 canScrollPx 的老调用点行为不变（默认视为够滚）", () => {
	expect(plan({ ...base, driftPx: 120 }), "scroll", 120);
});

test("用户动手 / 目标消失 / 超时 仍按原优先级", () => {
	expect(plan({ ...base, driftPx: 100, canScrollPx: 0, interrupted: true }), "give-up", "interrupted");
	expect(plan({ ...base, driftPx: null, canScrollPx: 0 }), "wait"); // 布局宽限
	expect(plan({ ...base, driftPx: null, canScrollPx: 0, frames: 3 }), "give-up", "target-missing");
	expect(plan({ frames: 0, elapsedMs: 700, interrupted: false, expandAttempts: 0, driftPx: 100, canScrollPx: 900 }), "give-up", "timeout");
});
/**
 * 真机（2026-11-26 13:53，694 轮会话，搜索面板第 500 条）：
 * `jump/settle {rectTop: 897, rectHeight: 197, clientHeight: 828}`、`row-found frames: 0`、
 * 两次 `settle-end kind: settled` —— 几何全对，画面一片空白。
 *
 * 那一轮是刚被扩窗挂进来的：轮容器已占位（高度算得出来），内容还没填。
 * 只看高度就收手，用户停在空白处，只能再点一次。
 */
const ready = J.isSettleRowReady;

test("可量判据：有高度也有文字才算就绪", () => {
	assert.equal(ready({ height: 197 }, 120), true);
	assert.equal(ready({ height: 197 }, 0), false, "有高度无文字 = 内容还没填");
	assert.equal(ready({ height: 0 }, 120), false, "无高度 = 没布局");
	assert.equal(ready(null, 120), false, "量不到 rect");
});

test("空白行宽限是有限帧数，不是无限等", () => {
	assert.equal(J.JUMP_SETTLE_EMPTY_GRACE_FRAMES > 0, true);
	assert.equal(J.JUMP_SETTLE_EMPTY_GRACE_FRAMES <= 30, true, "不能等成两秒");
});
/**
 * 真机（2026-11-26 14:40，694 轮会话，搜索面板第 400 条）：跳到目标用户提问，
 * 该轮回答与后续轮次一片空白 —— 行量得到、settled 也打了，视口里只有那一行。
 *
 * 虚拟列表按范围挂载：范围只覆盖到目标行时，之下全是占位空白。等一帧并扩窗，
 * 比立刻收手更接近「跳过去能看到那一轮上下文」。有上限，不拖成两秒。
 */
const awaitFollowing = J.shouldAwaitFollowingRow;

test("目标行之后没有下文 → 继续等（不立刻 settled）", () => {
	assert.equal(awaitFollowing({ hasFollowingRow: false, followingWaitFrames: 0 }), true);
});

test("目标行之后有下文 → 不等，直接 settle", () => {
	assert.equal(awaitFollowing({ hasFollowingRow: true, followingWaitFrames: 0 }), false);
});

test("等下文有上限：超过宽限帧数就不再等", () => {
	const grace = J.JUMP_SETTLE_FOLLOWING_GRACE_FRAMES;
	assert.equal(awaitFollowing({ hasFollowingRow: false, followingWaitFrames: grace }), false);
	assert.equal(grace > 0 && grace <= 30, true, "宽限必须有限且不超过约半秒");
});
