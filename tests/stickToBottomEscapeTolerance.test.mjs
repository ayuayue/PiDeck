import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const engineSource = readFileSync("src/renderer/src/lib/stick-to-bottom/useStickToBottom.ts", "utf8");

// 跟随态只由 applyUserInput / 显式命令改变。普通 scroll 方向、内容增减、
// 视口 resize 都不得 setEscapedFromLock / setIsAtBottom。
test("layout scroll and resize never change follow state", () => {
	assert.match(engineSource, /if \(!isUserDrivenScroll\(\)\) \{\s*return;/);
	assert.match(engineSource, /applyUserInput\(/);
	assert.match(engineSource, /decideFollowFromUserInput\(/);
	assert.match(engineSource, /readerDisplacementPx/);
	assert.match(engineSource, /nextReaderUpPx/);
	assert.match(engineSource, /isScrollContainer: isScrollContainerOverflow\(style\.overflowY\)/);
	assert.doesNotMatch(engineSource, /getComputedStyle\(element\)\.overflow\)/);
	// 逐环向上；不能只看第一个 overflow 容器（否则误判手势归属，见上一用例）
	assert.match(engineSource, /element = element\.parentElement;/);
	assert.doesNotMatch(engineSource, /const POSITIVE_RESIZE_ESCAPE_LOCKOUT_MS/);
	assert.doesNotMatch(engineSource, /const GROWTH_ESCAPE_GUARD_PX/);
	assert.doesNotMatch(engineSource, /isWithinGrowthGuardBand/);
	assert.doesNotMatch(engineSource, /lastPositiveResizeAt/);
	// 已确认的拖动不得被流式 resize 守卫丢弃（探针 B）
	assert.doesNotMatch(engineSource, /if \(state\.resizeDifference \|\| scrollTop === ignoreScrollToTop\)/);
});

test("escaped scroll is never dragged back by content growth", () => {
	assert.match(engineSource, /这里不再自动恢复已逃逸的锁底/);
	assert.doesNotMatch(engineSource, /if \(difference >= 0\) \{[\s\S]*?setEscapedFromLock\(false\);[\s\S]*?const requested = mergeAnimations\(/);
});

test("re-lock is only available from confirmed down input", () => {
	assert.match(engineSource, /if \(decision\.action === "relock"\) \{/);
	assert.match(engineSource, /followDirectionFromKey/);
	assert.match(engineSource, /isScrollbarGutterHit/);
	// 负增长不再偷偷重锁已浏览用户
	assert.doesNotMatch(engineSource, /if \(!state\.escapedFromLock && state\.isNearBottom\) \{\s*setEscapedFromLock\(false\);\s*setIsAtBottom\(true\);/);
});

test("gesture ownership follows the real browser scroll chain, not the first overflow box", () => {
	// 旧启发式（只看第一个 overflow-y 容器 + canChildScroll）已删除：它把「代码块到顶但外层
	// 组体还能滚」误判成时间线手势，也会把 contain 断链后的死手势当成时间线手势。
	assert.doesNotMatch(engineSource, /const canChildScroll =/);
	// 滚轮与键盘两条路径都必须先过归属判定，只有 timeline 才允许改跟随态。
	assert.match(engineSource, /resolveGestureOwner\(collectScrollChain\(scroll, target, deltaY < 0 \? "up" : "down"\)\) !== "timeline"\) return;/);
	assert.match(engineSource, /resolveGestureOwner\(collectScrollChain\(scroll, event\.target, direction\)\) !== "timeline"\) return;/);
	// 链要一路向外走到引擎自己的 scroller，并逐环取 overflowY / overscroll-behavior-y。
	assert.match(engineSource, /function collectScrollChain\(scroll: HTMLElement, target: EventTarget \| null, direction: FollowDirection\): ScrollChainLink\[\]/);
	assert.match(engineSource, /chainCut: isScrollChainCut\(style\.overscrollBehaviorY\)/);
	// overflow:hidden 仍能程序化滚动，却不能接收 wheel/键盘滚动；不能据其余量把外层手势误归属给它。
	assert.match(engineSource, /canScrollAlong: isVerticallyScrollableOverflow\(style\.overflowY\) && hasRoomAlong\(element, direction\)/);
	assert.match(engineSource, /element = element\.parentElement;/);
	// 代码块到边后继续滚时间线的既有行为必须保留：链走完没人认领即算时间线手势。
	assert.match(engineSource, /applyWheelOnScroll\(scroll, deltaY\)/);
	assert.match(engineSource, /preserveScrollPosition,/);
});
