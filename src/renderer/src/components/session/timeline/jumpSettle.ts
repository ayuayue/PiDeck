/**
 * 跳转落位之后的收敛纠偏（纯函数，可单测；DOM 循环在 useTimelineJumpNavigation）。
 *
 * 为什么需要：落位只能读到「那一帧」目标行相对视口的位置，然后写一次 scrollTop。
 * 而那一帧的布局一定还没稳，至少三条：
 *  1. 上方未挂载行用的是估算高度（虚拟化），目标一挂载、估值被实测高度替换，整段高度会变；
 *  2. 扩窗/补页批次还在往上插行，文档高度逐帧变大；
 *  3. 浏览器会把 scrollTop 截断到「当时的」maxScrollTop —— 文档还没长够，写多了也滚不过去。
 * 三种情况的共同结果都是「跳了一段、没到」，用户只能再点一次刻度，再点一次。
 *
 * **双向**（2026-11-25 真机，日志实证）：只做「写 scrollTop 再测」的闭环，隐含一个前提——
 * 时间线可滚动。跳到第 1 条之后，锚点窗口只有 1 前 3 后共 5 轮，5 轮内容高度 858px
 * 恰好等于视口高度 858px（日志 settle: scrollHeight=858 clientHeight=858），
 * 于是 scrollTop 恒被钳在 0，drift 恒为 269px，24 帧后 give-up —— 之后每一次往下跳，
 * 窗口还钉在顶部那 5 轮，内容依旧刷不满视口，**从 1 往下全部跳不动**。
 * 所以「不可滚动」不是「滚得不够」，而是「内容不够」，必须换一个动作：继续扩窗。
 * 上跳（目标更早）与下跳（目标更晚）都要走这条判据，不能只朝一个方向补。
 */

/** 帧数上限：24 帧 ≈ 400ms（60Hz）。够覆盖「扩窗分帧 + 估值替换 + 一次浏览器截断回弹」。 */
export const JUMP_SETTLE_MAX_FRAMES = 24;
/** 时间上限：低帧率设备（滚动卡顿时 20fps）用时间兜底，避免帧数上限被拖成两秒。 */
export const JUMP_SETTLE_MAX_MS = 600;
/** 布局宽限帧数：目标行挂载当帧量不到时，等这么多帧再判「挂不出来」。 */
export const JUMP_SETTLE_LAYOUT_GRACE_FRAMES = 3;

/** 收敛容差（px）：亚像素对齐误差不算漂移。 */
export const JUMP_SETTLE_TOLERANCE_PX = 1;
/** 收敛期间最多为「内容不够高」补几次窗。每次 3 轮，8 次 = 24 轮，足够刷满一屏。 */
export const JUMP_SETTLE_MAX_EXPANDS = 8;
/** 可滚动余量阈值（px）：小于它就当「滚不动」。1px 的亚像素余量没有实际滚动能力。 */
export const JUMP_SETTLE_MIN_SCROLL_ROOM_PX = 4;
/**
 * 钳位接受上限（px）：扩窗用尽、滚到底也还差的这一点余量，按「已到」收下。
 *
 * 为什么需要：会话**最后一条**目标在结构上永远滚不到视口顶 —— 它下方没有内容可滚，
 * 浏览器把 scrollTop 钳在 maxScroll，缺口正好是「目标下方残留的那一点高度」。
 * 这种缺口扩窗无效（内容已经到底），旧实现连扩 8 次再 give-up，而 give-up 会触发
 * pendingJump 重试，用户看到的是「点了没反应、要点好几次」。
 *
 * 32px 的来由：真机 2026-11-26 07:46:58 那条 `no-scroll-room frames=8 driftPx=24`，
 * 相差不到一行（视口高度约 900px）。超过这个量级说明目标根本没到附近，仍应 give-up。
 */
export const JUMP_SETTLE_CLAMP_ACCEPT_PX = 32;

/**
 * 目标行是否**可量**：既有高度、也有文字。
 *
 * 只看高度不够。真机（2026-11-26 13:53，694 轮会话，搜索面板第 500 条）：
 * `jump/settle {rectTop: 897, rectHeight: 197, clientHeight: 828}`、`row-found frames: 0`、
 * 两次 `settle-end kind: settled` —— 几何全对，用户看到的却是**一片空白**。
 *
 * 因为那一轮是刚被扩窗挂进来的：轮容器已占位（高度算得出来），但 run 的内容还没渲染
 * （VirtualRunList 先把高度写进 spacer，内容随后填充）。此时把它当「已到」收手，
 * 用户停在空白处，只能再点一次。
 */
export function isSettleRowReady(rect: { height: number } | null, textLength: number): boolean {
	return rect !== null && rect.height > 0 && textLength > 0;
}

/**
 * 目标行之后**还有没有下文**（同一屏里后续轮是否已挂载）。
 *
 * 真机（2026-11-26 14:40，694 轮会话，搜索面板第 400 条）：跳到了目标用户提问，
 * 该轮的回答和后续轮次一片空白 —— 行本身量得到、settled 也打了，但视口里只有那一行。
 *
 * 虚拟列表按范围挂载：范围若只覆盖到目标行，之下全是占位空白。此时继续等一帧并扩窗，
 * 比立刻收手更接近用户要的「跳过去能看到那一轮的上下文」。有上限，不会无限等。
 */
export function shouldAwaitFollowingRow(input: { hasFollowingRow: boolean; followingWaitFrames: number; graceFrames?: number }): boolean {
	if (input.hasFollowingRow) return false;
	const grace = input.graceFrames ?? JUMP_SETTLE_FOLLOWING_GRACE_FRAMES;
	return input.followingWaitFrames < grace;
}

/** 等下文的最大帧数（12 帧约 200ms）：超过就收手，不把一次跳转拖成两秒的自动滚动。 */
export const JUMP_SETTLE_FOLLOWING_GRACE_FRAMES = 12;

/** 行已挂载但**还没长内容**时的宽限帧数：等布局填内容，别立刻判「挂不出来」。 */
export const JUMP_SETTLE_EMPTY_GRACE_FRAMES = 12;

export type JumpSettleDecision =
	| { kind: "settled" }
	/** 需要把 scrollTop 加上 delta（正 = 往下滚）。 */
	| { kind: "scroll"; delta: number }
	/** 内容比视口矮，写 scrollTop 没有意义：先扩窗拿更多轮次，下一帧再测。 */
	| { kind: "expand" }
	/** 目标行还没被布局（挂载当帧量不到）：原地等一帧，别急着判失败。 */
	| { kind: "wait" }
	| { kind: "give-up"; reason: "interrupted" | "target-missing" | "frames" | "timeout" | "no-scroll-room" };

/**
 * 每帧一次的判定。
 *
 * 顺序有意为之：用户动手 > 帧/时间上限 > 目标消失 > 已收敛 > 滚不动先扩窗 > 继续补。
 * 用户动手排第一：他一旦滚轮/触摸，任何自动补位都是「跟你抢」；
 * 上限排在收敛之前：到点就收手，宁可留 2px 偏差，也不让一次跳转变成 600ms 的自动滚动。
 *
 * driftPx 为 null 表示目标行此刻不在 DOM（虚拟化把它卸载了 / 折叠区收起）：
 * 此时无从测量，继续空转只会白烧帧，直接放弃并交给 pendingJump 的重试循环。
 *
 * canScrollPx = scrollHeight - clientHeight。它 ≤ 0 时 scrollTop 写不进去（浏览器钳位），
 * 再算 drift 也是白算 —— 这时唯一有效的动作是扩窗（expand），不是重算 delta。
 * expandAttempts 用尽后如实报 no-scroll-room，而不是拖到 frames 上限再说「帧数用完」。
 */
export function planJumpSettleStep(input: {
	driftPx: number | null;
	frames: number;
	elapsedMs: number;
	interrupted: boolean;
	/** scrollHeight - clientHeight；负数按 0 处理。缺省视为「够滚」（老调用点不传也不改变行为）。 */
	/** 「把目标滚到视口顶的剩余余量」= maxScroll - 目标的文档坐标。
	 *  <= 0 表示滚到底也够不到（内容不够高，或目标超出可滚上限），唯一有效的动作是扩窗。
	 *  缺省视为「够滚」：老调用点不传也不改变行为。 */
	canScrollPx?: number;
	/** 本次收敛已经补了几次窗。 */
	expandAttempts?: number;
	/**
	 * 视口高度（px）。用来判「目标是否已经出现在视口里」：
	 * 末条目标滚不到视口顶（下方没有内容），但**看得见**就是用户要的「到了」。
	 * 缺省视为未知：退回 JUMP_SETTLE_CLAMP_ACCEPT_PX 的保守判法。
	 */
	viewportHeightPx?: number;
}): JumpSettleDecision {
	if (input.interrupted) return { kind: "give-up", reason: "interrupted" };
	if (input.frames >= JUMP_SETTLE_MAX_FRAMES) return { kind: "give-up", reason: "frames" };
	if (input.elapsedMs >= JUMP_SETTLE_MAX_MS) return { kind: "give-up", reason: "timeout" };
	// 目标行刚被挂载时，那一帧还没有布局盒：rect 全 0，量出的漂移是垃圾值。
	// 旧实现立刻判 target-missing 并静默收手（连 settle-end 都不打，因为 frames=0），
	// 用户看到「点了一次没反应，再点一次才到」——2026-11-25 日志里那次 settle 之后
	// 10 秒内没有任何 settle-end，就是这条。容忍前几帧，给布局一点时间。
	if (input.driftPx === null) {
		if (input.frames < JUMP_SETTLE_LAYOUT_GRACE_FRAMES) return { kind: "wait" };
		return { kind: "give-up", reason: "target-missing" };
	}
	if (Math.abs(input.driftPx) <= JUMP_SETTLE_TOLERANCE_PX) return { kind: "settled" };
	// scrollRoom = 「把目标滚到视口顶还剩多少余量」= maxScroll - 目标的文档坐标。
	//
	// 一个量同时表达两种失败（日志实证，2026-11-25 数学组2）：
	//   ① 内容比视口矮：maxScroll ≈ 0 → 余量为负 → expand
	//      日志 settle scrollHeight=858 clientHeight=858
	//   ② 目标超出可滚上限：maxScroll=15826 而目标在 16303 → 余量 -477 → 必须 expand
	//      日志 settle 目标绝对=16303 maxScroll=15826 drift 恒 400 → give-up frames
	// ②曾被当成「写足就行」，其实滚到底也够不到：浏览器把 scrollTop 钳在 maxScroll，
	// 漂移永久剩那几百像素，24 帧后放弃，用户看到的是「定位错到别处」。
	const scrollRoom = input.canScrollPx ?? Number.POSITIVE_INFINITY;
	if (scrollRoom <= JUMP_SETTLE_MIN_SCROLL_ROOM_PX) {
		if ((input.expandAttempts ?? 0) >= JUMP_SETTLE_MAX_EXPANDS) {
			// 滚到底也到不了视口顶，唯一的出头条件是「目标已经看得见」。
			//
			// 缺口大小 = 视口高度 − 目标下方剩余内容：目标越靠近会话末尾，缺口越大
			// （真机 2026-11-26 实测：24 / 61 / 269 / 501px 各有样本）。所以判据不是固定
			// 像素阈值，而是「目标有没有落在视口里」 —— 看得见就是用户要的「到了」。
			const viewport = input.viewportHeightPx;
			const visibleInViewport = typeof viewport === "number" && viewport > 0 && Math.abs(input.driftPx) < viewport;
			if (visibleInViewport) return { kind: "settled" };
			// 视口高未知（老调用点）时退回保守阈值：只收下一行以内的缺口，不掩盖真失败。
			if (Math.abs(input.driftPx) <= JUMP_SETTLE_CLAMP_ACCEPT_PX) return { kind: "settled" };
			return { kind: "give-up", reason: "no-scroll-room" };
		}
		return { kind: "expand" };
	}
	return { kind: "scroll", delta: input.driftPx };
}
