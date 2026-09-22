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
