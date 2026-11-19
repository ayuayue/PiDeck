import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 会话跳转落位前「先把目标从嵌套窗口里露出来」。
 *
 * 背景（2026-11）：过程组组体是限高视口，组内成员可能被滚出可视区。跳转只移动会话这层
 * scrollTop 时，目标行**布局是有的**（矩形正常，所以不会退到轮次行），却被组体裁掉——
 * Chromium 实测可见高度 0px，用户看到的是「跳到一条空白」。这组用例钉住两件事：
 * 内层按 nearest 露出，并且必须走组体注册的 restoreAt（裸写 scrollTop 不解锁锁底，
 * 下一帧增长又会把视口拽回底部）。
 */
const MODULE = "src/renderer/src/components/session/timeline/nestedScrollerReveal.ts";

const reveal = (() => {
	const load = createTsSandbox({ globals: { getComputedStyle: (element) => ({ overflowY: element.overflowY ?? "visible" }) } });
	return load(MODULE);
})();

/** 目标在窗口里完全可见时不动。 */
test("目标已完整可见：nearest 露出返回 null，不动滚动位置", () => {
	assert.equal(reveal.nearestRevealScrollTop({ targetTop: 40, targetBottom: 80, viewTop: 0, viewBottom: 300, scrollTop: 120, scrollHeight: 1000, clientHeight: 300 }), null);
});

test("目标在窗口下方：贴底而不是随便滚一段", () => {
	// 目标底边超出的量 = 360 - 300 = 60 → 新 scrollTop = 120 + 60
	assert.equal(reveal.nearestRevealScrollTop({ targetTop: 320, targetBottom: 360, viewTop: 0, viewBottom: 300, scrollTop: 120, scrollHeight: 1000, clientHeight: 300 }), 180);
});

test("目标在窗口上方：贴顶", () => {
	// 目标顶边在 -50，比视口顶多 50 → 新 scrollTop = 200 - 50
	assert.equal(reveal.nearestRevealScrollTop({ targetTop: -50, targetBottom: 10, viewTop: 0, viewBottom: 300, scrollTop: 200, scrollHeight: 1000, clientHeight: 300 }), 150);
});

test("贴着窗口边界与亚像素偏差不触发移动", () => {
	assert.equal(reveal.nearestRevealScrollTop({ targetTop: 0, targetBottom: 300, viewTop: 0, viewBottom: 300, scrollTop: 0, scrollHeight: 1000, clientHeight: 300 }), null);
	assert.equal(reveal.nearestRevealScrollTop({ targetTop: -0.4, targetBottom: 300.4, viewTop: 0, viewBottom: 300, scrollTop: 10, scrollHeight: 1000, clientHeight: 300 }), null);
});

test("新位置被夹在 [0, scrollHeight - clientHeight] 之内", () => {
	assert.equal(reveal.nearestRevealScrollTop({ targetTop: 900, targetBottom: 940, viewTop: 0, viewBottom: 300, scrollTop: 690, scrollHeight: 1000, clientHeight: 300 }), 700);
	assert.equal(reveal.nearestRevealScrollTop({ targetTop: -900, targetBottom: -860, viewTop: 0, viewBottom: 300, scrollTop: 10, scrollHeight: 1000, clientHeight: 300 }), 0);
});

test("非法几何值不写入滚动位置", () => {
	assert.equal(reveal.nearestRevealScrollTop({ targetTop: Number.NaN, targetBottom: 10, viewTop: 0, viewBottom: 300, scrollTop: 0, scrollHeight: 1000, clientHeight: 300 }), null);
	assert.equal(reveal.nearestRevealScrollTop({ targetTop: 0, targetBottom: 10, viewTop: 0, viewBottom: 300, scrollTop: 0, scrollHeight: 0, clientHeight: Number.POSITIVE_INFINITY }), null);
});

/**
 * 一棵最小 DOM 树：timeline（边界，本身可滚） ← scroller（限高窗） ← row。
 * `row` 在内容里的偏移是 200；随 scroller.scrollTop 移动。
 */
function harness({ overflowY = "auto", registered = true } = {}) {
	const ROLE_OFFSET = 200;
	const ROW_HEIGHT = 40;
	const timeline = { overflowY: "auto", parentElement: null, scrollTop: 500, scrollHeight: 5000, clientHeight: 400, clientTop: 0, getBoundingClientRect: () => ({ top: 0, bottom: 400 }) };
	const scroller = { overflowY, parentElement: timeline, scrollTop: 0, scrollHeight: 1000, clientHeight: 300, clientTop: 0, getBoundingClientRect: () => ({ top: 0, bottom: 300 }) };
	const row = {
		overflowY: "visible",
		parentElement: scroller,
		getBoundingClientRect: () => {
			const top = ROLE_OFFSET - scroller.scrollTop;
			return { top, bottom: top + ROW_HEIGHT };
		},
	};
	const restored = [];
	if (registered)
		reveal.registerNestedScrollerRestore(scroller, (scrollTop) => {
			restored.push(scrollTop);
			scroller.scrollTop = scrollTop;
		});
	return { timeline, scroller, row, restored };
}

test("内层窗口把目标裁在下方时：经注册的 restoreAt 露出目标（不是裸写 scrollTop）", () => {
	const h = harness();
	h.scroller.scrollTop = 0; // 目标在 200..240，窗口 0..300 —— 可见
	assert.equal(reveal.revealInNestedScrollers(h.row, h.timeline), false);
	// 先把窗口滚到目标之下（模拟用户把组体滚到别处）：目标跑到 -700..-660
	h.scroller.scrollTop = 900;
	assert.equal(reveal.revealInNestedScrollers(h.row, h.timeline), true);
	assert.deepEqual(h.restored, [200], "必须走组体注册的引擎定位入口");
	assert.equal(h.scroller.scrollTop, 200);
});

test("裸容器没有注册定位入口时退化为直接赋值", () => {
	const h = harness({ registered: false });
	h.scroller.scrollTop = 900;
	assert.equal(reveal.revealInNestedScrollers(h.row, h.timeline), true);
	assert.equal(h.scroller.scrollTop, 200);
});

test("不可滚的祖代与边界（会话滚动区）都不碰", () => {
	const h = harness({ overflowY: "visible" });
	h.scroller.scrollTop = 900;
	assert.equal(reveal.revealInNestedScrollers(h.row, h.timeline), false);
	assert.equal(h.scroller.scrollTop, 900);
	assert.equal(h.timeline.scrollTop, 500, "边界由调用方自己定位，这里不得改写");
});
