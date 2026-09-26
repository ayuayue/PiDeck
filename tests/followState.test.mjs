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

const follow = compile("src/renderer/src/lib/stick-to-bottom/followState.ts");

function assertDecision(actual, action, report) {
	assert.equal(actual.action, action);
	assert.equal(actual.report, report);
}

test("up escape uses reader displacement, not spring-lag distance from bottom", () => {
	// 贴底、无自身位移：不算浏览
	assertDecision(
		follow.decideFollowFromUserInput({
			direction: "up",
			readerDisplacementPx: 0,
			distanceFromBottom: 0,
		}),
		"none",
	);
	assertDecision(
		follow.decideFollowFromUserInput({
			direction: "up",
			readerDisplacementPx: 25,
			distanceFromBottom: 25,
		}),
		"none",
	);
	// 流式弹簧欠 36px 时 1px 触控板抖动：距底 37 但读者只走了 1px
	assertDecision(
		follow.decideFollowFromUserInput({
			direction: "up",
			readerDisplacementPx: 1,
			distanceFromBottom: 37,
		}),
		"none",
	);
	// 读者自己走过带宽：逃逸，即使此刻距底碰巧很小
	assertDecision(
		follow.decideFollowFromUserInput({
			direction: "up",
			readerDisplacementPx: 26,
			distanceFromBottom: 10,
		}),
		"escape",
		"up",
	);
	assertDecision(
		follow.decideFollowFromUserInput({
			direction: "up",
			readerDisplacementPx: 160,
			distanceFromBottom: 160,
		}),
		"escape",
		"up",
	);
});

test("down input relocks only inside the physical bottom band", () => {
	assert.equal(follow.shouldRelockFromDownInput(0, 25), true);
	assert.equal(follow.shouldRelockFromDownInput(10), true);
	assert.equal(follow.shouldRelockFromDownInput(25), true);
	assert.equal(follow.shouldRelockFromDownInput(26), false);
	assert.equal(follow.shouldRelockFromDownInput(100), false);

	assertDecision(
		follow.decideFollowFromUserInput({
			direction: "down",
			readerDisplacementPx: 0,
			distanceFromBottom: 10,
		}),
		"relock",
		"down",
	);
	assertDecision(
		follow.decideFollowFromUserInput({
			direction: "down",
			readerDisplacementPx: 0,
			distanceFromBottom: 80,
		}),
		"intent",
		"down",
	);
});

test("forced follow animations ignore user escapes", () => {
	assertDecision(
		follow.decideFollowFromUserInput({
			direction: "up",
			readerDisplacementPx: 200,
			distanceFromBottom: 200,
			ignoreEscapes: true,
		}),
		"none",
	);
});

test("empty rendered overflow reports up intent without escaping follow mode", () => {
	assertDecision(
		follow.decideFollowFromUserInput({
			direction: "up",
			readerDisplacementPx: 40,
			distanceFromBottom: 40,
			canScroll: false,
		}),
		"intent",
		"up",
	);
});

test("wheel decisions use the distance the gesture will land on for relock", () => {
	assert.equal(follow.distanceAfterWheelDelta(0, -160), 160);
	assert.equal(follow.distanceAfterWheelDelta(10, -20), 30);
	assert.equal(follow.distanceAfterWheelDelta(80, 160), 0);
	assertDecision(
		follow.decideFollowFromUserInput({
			direction: "up",
			readerDisplacementPx: 160,
			distanceFromBottom: follow.distanceAfterWheelDelta(0, -160),
		}),
		"escape",
		"up",
	);
	assertDecision(
		follow.decideFollowFromUserInput({
			direction: "down",
			readerDisplacementPx: 0,
			distanceFromBottom: follow.distanceAfterWheelDelta(10, 160),
		}),
		"relock",
		"down",
	);
});

test("reader up accumulation expires across gestures and ignores 1px stream jitter", () => {
	const first = follow.nextReaderUpPx({
		previous: 0,
		previousAt: 0,
		now: 1000,
		direction: "up",
		thisInputPx: 1,
	});
	assert.equal(first.readerUpPx, 1);
	const second = follow.nextReaderUpPx({
		previous: first.readerUpPx,
		previousAt: first.at,
		now: 1080,
		direction: "up",
		thisInputPx: 1,
	});
	assert.equal(second.readerUpPx, 2);
	assertDecision(
		follow.decideFollowFromUserInput({
			direction: "up",
			readerDisplacementPx: second.readerUpPx,
			distanceFromBottom: 38,
		}),
		"none",
	);
	const burst = follow.nextReaderUpPx({
		previous: 20,
		previousAt: 2000,
		now: 2100,
		direction: "up",
		thisInputPx: 10,
	});
	assert.equal(burst.readerUpPx, 30);
	assertDecision(
		follow.decideFollowFromUserInput({
			direction: "up",
			readerDisplacementPx: burst.readerUpPx,
			distanceFromBottom: 66,
		}),
		"escape",
		"up",
	);
	const stale = follow.nextReaderUpPx({
		previous: 20,
		previousAt: 1000,
		now: 1000 + follow.READER_UP_ACCUMULATE_MS + 1,
		direction: "up",
		thisInputPx: 1,
	});
	assert.equal(stale.readerUpPx, 1);
	const down = follow.nextReaderUpPx({
		previous: 20,
		previousAt: 3000,
		now: 3010,
		direction: "down",
		thisInputPx: 40,
	});
	assert.equal(down.readerUpPx, 0);
});

test("slow real notches accumulate across 250ms gaps until escape", () => {
	let acc = { readerUpPx: 0, at: 0 };
	for (let i = 0; i < 6; i += 1) {
		acc = follow.nextReaderUpPx({
			previous: acc.readerUpPx,
			previousAt: acc.at,
			now: 1000 + i * 300,
			direction: "up",
			thisInputPx: 5,
		});
	}
	assert.equal(acc.readerUpPx, 30);
	assertDecision(
		follow.decideFollowFromUserInput({
			direction: "up",
			readerDisplacementPx: acc.readerUpPx,
			distanceFromBottom: 30,
		}),
		"escape",
		"up",
	);
});

test("far-from-bottom up input escapes; near-bottom 1px jitter does not", () => {
	assertDecision(
		follow.decideFollowFromUserInput({
			direction: "up",
			readerDisplacementPx: 1,
			distanceFromBottom: 71,
		}),
		"none",
	);
	assertDecision(
		follow.decideFollowFromUserInput({
			direction: "up",
			readerDisplacementPx: 1,
			distanceFromBottom: follow.FAR_FROM_BOTTOM_PX + 1,
		}),
		"escape",
		"up",
	);
});

test("keyboard and scrollbar helpers classify real input only", () => {
	assert.equal(follow.followDirectionFromKey("ArrowUp"), "up");
	assert.equal(follow.followDirectionFromKey("PageUp"), "up");
	assert.equal(follow.followDirectionFromKey("Home"), "up");
	assert.equal(follow.followDirectionFromKey("ArrowDown"), "down");
	assert.equal(follow.followDirectionFromKey("PageDown"), "down");
	assert.equal(follow.followDirectionFromKey("End"), "down");
	assert.equal(follow.followDirectionFromKey("Enter"), undefined);
	assert.equal(follow.followDirectionFromKey(" "), undefined);

	assert.equal(follow.readerDisplacementFromKey("ArrowUp", 800), 40);
	assert.equal(follow.readerDisplacementFromKey("PageUp", 800), 800);
	assert.equal(follow.readerDisplacementFromKey("Home", 800), Number.POSITIVE_INFINITY);

	// 经典槽在 clientWidth 外侧；overlay / stable gutter 命中右缘 12px
	assert.equal(follow.isScrollbarGutterHit(180, 100, 80), true);
	assert.equal(follow.isScrollbarGutterHit(168, 100, 80), true);
	assert.equal(follow.isScrollbarGutterHit(167, 100, 80), false);
});

test("vertical scroll walk matches overflowY, not the overflow shorthand", () => {
	// .message-timeline computed overflow is "hidden auto"
	assert.equal(follow.isVerticallyScrollableOverflow("auto"), true);
	assert.equal(follow.isVerticallyScrollableOverflow("scroll"), true);
	assert.equal(follow.isVerticallyScrollableOverflow("hidden"), false);
	assert.equal(follow.isVerticallyScrollableOverflow("visible"), false);
	assert.equal(follow.isVerticallyScrollableOverflow("hidden auto"), false);
	assert.equal(["scroll", "auto"].includes("hidden auto"), false);
});

test("chain cut is decided by overscroll-behavior-y contain/none", () => {
	assert.equal(follow.isScrollChainCut("contain"), true);
	assert.equal(follow.isScrollChainCut("none"), true);
	// auto 时手势会物理链到外层，不能当断链
	assert.equal(follow.isScrollChainCut("auto"), false);
	assert.equal(follow.isScrollChainCut("visible"), false);
});

test("scroll container vs scroller: hidden 也是滚动容器（overscroll-behavior 对它生效）", () => {
	assert.equal(follow.isScrollContainerOverflow("auto"), true);
	assert.equal(follow.isScrollContainerOverflow("scroll"), true);
	// hidden 不参与「能不能滚」，但仍是滚动容器：overscroll-behavior 对它照样生效
	assert.equal(follow.isScrollContainerOverflow("hidden"), true);
	assert.equal(follow.isScrollContainerOverflow("visible"), false);
	assert.equal(follow.isScrollContainerOverflow("hidden auto"), false);
});

test("hasRoomAlong separates the direction, with a 1px device-scaling tolerance", () => {
	const box = (scrollTop, scrollHeight, clientHeight) => ({ scrollTop, scrollHeight, clientHeight });
	// 组体已到顶：往上没余量，往下有
	assert.equal(follow.hasRoomAlong(box(0, 900, 320), "up"), false);
	assert.equal(follow.hasRoomAlong(box(0, 900, 320), "down"), true);
	// 中部：两向都有
	assert.equal(follow.hasRoomAlong(box(300, 900, 320), "up"), true);
	assert.equal(follow.hasRoomAlong(box(300, 900, 320), "down"), true);
	// 已到底：往上还有，往下没有
	assert.equal(follow.hasRoomAlong(box(580, 900, 320), "up"), true);
	assert.equal(follow.hasRoomAlong(box(580, 900, 320), "down"), false);
	// Windows 125%/150% 缩放：浮点舍入余 0.5px 不能算「还能滚」，否则手势被吞
	assert.equal(follow.hasRoomAlong(box(0.5, 900, 320), "up"), false);
	assert.equal(follow.hasRoomAlong(box(579.5, 900, 320), "down"), false);
	// 内容不足（不可滚）时两向都没余量，靠 scrollableOverflow 先过滤掉
	assert.equal(follow.hasRoomAlong(box(0, 100, 320), "up"), false);
	assert.equal(follow.hasRoomAlong(box(0, 100, 320), "down"), false);
});

test("gesture owner: 只给时间线手势改跟随态", () => {
	const link = (over) => ({ isTimeline: false, isScrollContainer: true, canScrollAlong: false, chainCut: false, ...over });
	// 代码块到顶 ⊂ 已上滚的组体（探针 B）：浏览器滚组体，不是时间线
	assert.equal(follow.resolveGestureOwner([link({ canScrollAlong: true }), link({ isTimeline: true })]), "nested");
	// 组体到顶且 overscroll-contain（探针 B 的 cbA 位置）：谁都不得滚
	assert.equal(follow.resolveGestureOwner([link({ chainCut: true }), link({ isTimeline: true })]), "nobody");
	// 滚动容器（含 overflow:hidden）内容不溢出但 contain：链依旧断，不能外溢
	assert.equal(follow.resolveGestureOwner([link({ canScrollAlong: false, chainCut: true }), link({ isTimeline: true })]), "nobody");
	// 代码块到顶、链畅通（无 contain）：浏览器真的会链到时间线——既有行为不能丢
	assert.equal(follow.resolveGestureOwner([link(), link({ isTimeline: true })]), "timeline");
	// 手目录内无嵌套容器：时间线手势
	assert.equal(follow.resolveGestureOwner([link({ isTimeline: true })]), "timeline");
	// 非滚动容器（visible）只是过客：overscroll-behavior 对它不生效
	assert.equal(follow.resolveGestureOwner([link({ isScrollContainer: false, chainCut: true }), link({ isTimeline: true })]), "timeline");
	// 已到边不可滚 + 外层还有余量：浏览器滚外层
	assert.equal(follow.resolveGestureOwner([link({ canScrollAlong: false }), link({ canScrollAlong: true }), link({ isTimeline: true })]), "nested");
	// 起点不在时间线内（外部路由）由调用方补一个 timeline 尾巴，这里验证补法语义
	assert.equal(follow.resolveGestureOwner([]), "timeline");
});
