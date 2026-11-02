import assert from "node:assert";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const require$readFileSync = readFileSync;

const load = createTsSandbox();
const active = load("src/renderer/src/components/session/timeline/outlineRailActive.ts");
const ticks = load("src/renderer/src/components/session/timeline/outlineRailTicks.ts");

/** 造 n 条提问，id 为 q0..q(n-1)。 */
function makeItems(n) {
	return Array.from({ length: n }, (_, i) => ({ id: "q" + i, role: "user", title: "标题" + i, time: "" }));
}

test("窗口内的高亮：返回它自己那一根", () => {
	const all = makeItems(147);
	const windowItems = all.slice(117);
	const index = active.createOutlineItemIndex(windowItems);
	// 窗口是 117..146：q120 在窗口里，第 100 条（q99）已经不在窗口内——两件事一起钉住。
	assert.equal(active.resolveVisibleRailActiveId("q120", index, windowItems), "q120");
	assert.equal(active.resolveVisibleRailActiveId("q99", index, windowItems), undefined);
});

test("窗口外的高亮必须消失，不能退到边界那根", () => {
	// 回归靶子，也是这一版的真缺陷：resolveVisibleRailActiveId 遍历 railItems 取
	// distance 最小的，越界时**不返回 undefined**，而是返回最靠近边界的那一根。
	// 索引表若用全量（0..146）建、railItems 只含 117..146，用户在看第 21 条时会
	// 高亮到第 88 条 —— 指示「你在一百条以外的地方」，比没有高亮更坏。
	const all = makeItems(147);
	const windowItems = all.slice(117);
	const index = active.createOutlineItemIndex(windowItems);
	assert.equal(active.resolveVisibleRailActiveId("q20", index, windowItems), undefined);
});

test("索引表用全量建时，越界会被错位成边界那根（把旧行为固定下来）", () => {
	// 这条不是断言我们想要的行为，是钉住「为什么会错」——
	// 以后谁把 windowItemIndex 改回 createOutlineItemIndex(props.items)，
	// 上面那条「必须消失」会红，这条会继续绿，两者一起说明问题出在索引表与集合不同源。
	const all = makeItems(147);
	const windowItems = all.slice(117);
	const fullIndex = active.createOutlineItemIndex(all);
	assert.equal(active.resolveVisibleRailActiveId("q20", fullIndex, windowItems), "q117");
});

test("用户在看第 21 条时，窗口内没有它 —— 这就是切片后的真实场景", () => {
	const all = makeItems(147);
	const start = Math.max(0, all.length - ticks.RAIL_RECENT_TICK_ITEMS);
	assert.equal(start, 117);
	const windowItems = all.slice(start);
	assert.equal(windowItems.length, 30);
	assert.equal(windowItems[0].id, "q117");
	assert.equal(windowItems[29].id, "q146");
});

test("不足 30 条时窗口就是全部", () => {
	const all = makeItems(30);
	const start = Math.max(0, all.length - ticks.RAIL_RECENT_TICK_ITEMS);
	assert.equal(start, 0);
	assert.equal(all.slice(start).length, 30);
});

test("顶端占位 id 不是消息 id，且不会被当成 outline-pending 前缀", () => {
	assert.equal(ticks.OUTLINE_WINDOW_HEAD_ID, "outline-window-head");
	assert.equal(ticks.isPendingRailItemId(ticks.OUTLINE_WINDOW_HEAD_ID), false);
	// 交给 pendingRailJump 会走 jumpToMessage、查不到节点弹「跳转失败」，
	// 所以 onItemSelect 必须先判它并改成打开面板。这里只钉住 id 的形态。
	assert.equal(ticks.pendingEntryIdOf(ticks.OUTLINE_WINDOW_HEAD_ID), undefined);
});

test("源码级：切割后的索引表必须与被压缩集合同源", () => {
	// 纯函数测试锁不住这一条 —— 上面三条测的是「同源之后行为对」，但改动可能在
	// SurfaceComponents 里把 windowItemIndex 换回全量索引表，纯函数照样全绿。
	// 这里直接读源码，钉住三个必须同时成立的点。
	const source = require$readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");
	assert.match(source, /createOutlineItemIndex\(windowItems\)/, "索引表必须用 windowItems 建");
	assert.doesNotMatch(source, /createOutlineItemIndex\(props\.items\)/, "不得再用全量 props.items 建索引表");
	assert.match(source, /windowStart > 0 \? props\.items\.slice\(windowStart\) : props\.items/, "切片必须是尾部窗口");
	assert.match(source, /if \(item\.id === OUTLINE_WINDOW_HEAD_ID\)/, "占位项必须被 onItemSelect 拦下");
});
