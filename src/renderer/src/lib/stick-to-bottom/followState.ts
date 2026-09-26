/**
 * 吸底跟随的唯一状态机（纯函数，无 DOM / React）。
 *
 * 跟随态只有两种：following / browsing。
 * 能改状态的入口只有两类：
 * 1. 用户输入：wheel / touch / 键盘 / 滚动条拖动 / 非折叠拖选；
 * 2. 显式命令：scrollToBottom（回底）、stopScroll / restoreAt（解锁）。
 *
 * 布局 scroll、ResizeObserver、弹簧动画只校正几何，不改跟随态。
 * 上滚逃逸两档：
 * - 近底带内（弹簧常欠 30–40px）：只看读者自己的位移累计，不看距物理底，
 *   避免 1px 触控板抖动被当成浏览；
 * - 明确离开近底带：任意上滚输入立即逃逸（慢速滚轮假锁：间隔 >250ms 时
 *   近底累计会被清零，但人已经离开尾巴）。
 */

/** 距底 <= 该值仍视为贴在实时尾部。下滚重锁、上滚累计逃逸共用这一带宽。 */
export const AT_BOTTOM_TOLERANCE_PX = 25;

/** 近底带：只用于几何判断（是否还看得到尾部），不单独决定跟随态。 */
export const STICK_TO_BOTTOM_OFFSET_PX = 70;

/**
 * 明确离底：必须高于近底带，弹簧滞后到不了这里。
 * 用近底带本身（70）当逃逸线会让 71px 处 1px 触控板永久脱锁。
 */
export const FAR_FROM_BOTTOM_PX = STICK_TO_BOTTOM_OFFSET_PX * 2;

/** 上滚累计窗口：间隔超过此时长视为一次新手势，避免流式里 1px 噪声慢慢加满。 */
export const READER_UP_ACCUMULATE_MS = 250;

/** 真实滚轮刻度（≥该值）跨手势累计窗口。慢速 5px/300ms 必须能加满逃逸阈值。 */
export const READER_UP_GESTURE_MS = 2000;

/** 小于等于该位移视为触控板/流式抖动，仍走 250ms 短窗。 */
export const READER_UP_JITTER_PX = 2;

/** 方向键一次约等于一行；Page/Home/End 另算。 */
export const KEYBOARD_LINE_PX = 40;

/** overlay / scrollbar-gutter 预留槽：命中视口右缘这一带宽即视为拖滚动条。 */
export const SCROLLBAR_HIT_SLOP_PX = 12;

/** 滚动容器贴边容差：Windows 125%/150% 缩放下的浮点舍入会留下不到 1px 的余量。 */
export const SCROLL_EDGE_TOLERANCE_PX = 1;

/**
 * 滚动链是否被 CSS 切断：`overscroll-behavior-y: contain | none` 时，内层到边后
 * 手势**不会**继续传给外层滚动容器（`auto` 才会）。
 *
 * 引擎必须据此判断「手势到底滚了谁」，否则会出现幽灵状态变更：
 * 过程组组体是 `overflow-y-auto overscroll-contain`，到边后滚轮/键盘一律不外溢，
 * 但事件照旧冒泡到时间线 → 时间线一像素没动却被静默解锁（上滚）或拽回底部（下滚）。
 */
export function isScrollChainCut(overscrollBehaviorY: string): boolean {
	return overscrollBehaviorY === "contain" || overscrollBehaviorY === "none";
}

/**
 * 是否为**滚动容器**（CSS 语义，不看内容够不够）：`auto | scroll | hidden`。
 *
 * 与 `isVerticallyScrollableOverflow`（只看 auto|scroll）分开的两个原因：
 * 1. `hidden` 仍是滚动容器，`overscroll-behavior` 对它**照样生效**（会切断滚动链）；
 * 2. 滚动链上的归属判定需要区分「这个环根本不参与滚动链」与「参与但当前没余量」。
 */
export function isScrollContainerOverflow(overflowY: string): boolean {
	return overflowY === "auto" || overflowY === "scroll" || overflowY === "hidden";
}

/**
 * 滚动容器在该方向上是否还有余量（能不能真的滚）。
 * 不能只看 `scrollHeight > clientHeight`：链上某一环可能整体可滚，
 * 但手势方向那一端已经到边了。
 */
export function hasRoomAlong(scroll: { scrollTop: number; scrollHeight: number; clientHeight: number }, direction: FollowDirection): boolean {
	if (direction === "up") return scroll.scrollTop > SCROLL_EDGE_TOLERANCE_PX;
	return scroll.scrollTop + scroll.clientHeight < scroll.scrollHeight - SCROLL_EDGE_TOLERANCE_PX;
}

/** 手势归属：时间线 / 某个嵌套滚动容器 / 谁都不滚（链被切断）。 */
export type GestureOwner = "timeline" | "nested" | "nobody";

/** 滚动链上的一环（由内向外），最后一环是引擎自己的 scroller。 */
export type ScrollChainLink = {
	/** 是否就是引擎自己的 scroller（时间线）。 */
	isTimeline: boolean;
	/**
	 * 该环是不是滚动容器（`overflow-y: auto | scroll | hidden`）。
	 * 非滚动容器（visible）不参与滚动链，`overscroll-behavior` 对它也不生效，直接跳过。
	 */
	isScrollContainer: boolean;
	/** 该环在手势方向上是否还有余量。 */
	canScrollAlong: boolean;
	/** 该环是否切断滚动链（`overscroll-behavior-y: contain | none`）。 */
	chainCut: boolean;
};

/**
 * 一次滚轮 / 键盘手势到底滚了谁——按浏览器滚动链判定，而非只看事件起点：
 *
 * 1. 从手势起点沿祖先链**继续往上走**，不是只看第一个 overflow 容器：
 *    代码块到顶但外层组体还能滚时，浏览器滚的是**组体**（第一个在该方向上真有余量的一环），
 *    只看第一环会把这次手势当成时间线手势 → 时间线没动却改了跟随态。
 * 2. 中途遇到 `overscroll-behavior-y: contain` 且已到边的环 → 链断，**谁都不滚**：
 *    画面一像素不动，引擎更不能动跟随态。
 *    实测：即使该环内容并不溢出（`overflow-y: auto` 但高度不够），contain 依旧切断链。
 * 3. 链走完都没人认领（或走到时间线）→ 才是时间线手势。
 *    「代码块到边后继续滚时间线」的既有行为属于这一类，必须保留。
 *
 * 只有 `timeline` 才允许改跟随态；`nested` / `nobody` 都必须原地不动。
 */
export function resolveGestureOwner(chain: readonly ScrollChainLink[]): GestureOwner {
	for (const link of chain) {
		if (link.isTimeline) return "timeline";
		if (!link.isScrollContainer) continue;
		if (link.canScrollAlong) return "nested";
		if (link.chainCut) return "nobody";
	}
	return "timeline";
}

export type FollowDirection = "up" | "down";

export type FollowDecision = { action: "none" } | { action: "escape"; report: "up" } | { action: "relock"; report: "down" } | { action: "intent"; report: FollowDirection };

/** wheel 在位移前触发：用这次 delta 将到达的距底做下滚重锁。 */
export function distanceAfterWheelDelta(distanceFromBottom: number, deltaY: number): number {
	return Math.max(0, distanceFromBottom - deltaY);
}

export function shouldRelockFromDownInput(distanceFromBottom: number, tolerancePx = AT_BOTTOM_TOLERANCE_PX): boolean {
	return distanceFromBottom <= tolerancePx;
}

/**
 * 把本次输入折进读者上滚累计。下滚清零；间隔超过窗口也清零。
 * 抖动走短窗；真实刻度走长窗，这样慢速上滚不会因为 250ms 间隔被清零。
 */
export function nextReaderUpPx(input: { previous: number; previousAt: number; now: number; direction: FollowDirection; thisInputPx: number; windowMs?: number }): { readerUpPx: number; at: number } {
	if (input.direction === "down") {
		return { readerUpPx: 0, at: input.now };
	}
	const windowMs = input.windowMs ?? (input.thisInputPx <= READER_UP_JITTER_PX ? READER_UP_ACCUMULATE_MS : READER_UP_GESTURE_MS);
	const fresh = input.now - input.previousAt > windowMs;
	return {
		readerUpPx: (fresh ? 0 : input.previous) + Math.max(0, input.thisInputPx),
		at: input.now,
	};
}

export function readerDisplacementFromKey(key: string, clientHeight: number): number {
	if (key === "PageUp" || key === "PageDown") {
		return Math.max(1, clientHeight);
	}
	if (key === "Home" || key === "End") {
		return Number.POSITIVE_INFINITY;
	}
	return KEYBOARD_LINE_PX;
}

/**
 * 由一次已确认的用户输入决定是否逃逸 / 重锁。
 * 布局滚动不得调用本函数。
 *
 * 上滚：近底带内只看 readerDisplacementPx；明确离底后任意上滚即逃逸。
 * 下滚：只看 distanceFromBottom（是否已经回到物理底）。
 */
export function decideFollowFromUserInput(input: { direction: FollowDirection; readerDisplacementPx: number; distanceFromBottom: number; ignoreEscapes?: boolean; canScroll?: boolean }): FollowDecision {
	if (input.ignoreEscapes) {
		return { action: "none" };
	}
	if (input.direction === "up") {
		if (input.canScroll === false) {
			// The mounted tail window may fit inside the viewport while older turns are
			// virtualized. Report the gesture so the timeline can reveal that history,
			// but keep the engine locked until the controller confirms an expansion.
			return { action: "intent", report: "up" };
		}
		if (input.distanceFromBottom > FAR_FROM_BOTTOM_PX || input.readerDisplacementPx > AT_BOTTOM_TOLERANCE_PX) {
			return { action: "escape", report: "up" };
		}
		return { action: "none" };
	}
	if (shouldRelockFromDownInput(input.distanceFromBottom)) {
		return { action: "relock", report: "down" };
	}
	return { action: "intent", report: "down" };
}

const SCROLL_UP_KEYS = new Set(["ArrowUp", "PageUp", "Home"]);
const SCROLL_DOWN_KEYS = new Set(["ArrowDown", "PageDown", "End"]);

/** 键盘滚动键映射为输入方向；其它键不参与跟随态。 */
export function followDirectionFromKey(key: string): FollowDirection | undefined {
	if (SCROLL_UP_KEYS.has(key)) return "up";
	if (SCROLL_DOWN_KEYS.has(key)) return "down";
	return undefined;
}

/**
 * 竖直方向是否可滚。必须看 overflowY 长写，不能看 overflow 简写：
 * `.message-timeline` 是 overflow-x:hidden + overflow-y:auto，
 * computed overflow 为 "hidden auto"，includes("auto") 永远失败，
 * 真实滚轮打在正文上会整段丢掉。
 */
export function isVerticallyScrollableOverflow(overflowY: string): boolean {
	return overflowY === "auto" || overflowY === "scroll";
}

/**
 * 经典滚动条槽在 clientWidth 外侧；overlay / stable gutter 画在右缘内侧。
 * 两种都认，避免 macOS overlay 下拖滚动条永远无法改跟随态。
 */
export function isScrollbarGutterHit(clientX: number, viewportLeft: number, clientWidth: number, slopPx = SCROLLBAR_HIT_SLOP_PX): boolean {
	return clientX >= viewportLeft + clientWidth - slopPx;
}
