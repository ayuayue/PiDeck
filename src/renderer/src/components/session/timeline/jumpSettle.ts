/**
 * 跳转落位之后的收敛纠偏（纯函数，可单测；DOM 循环在 useSessionTimelineController）。
 *
 * 为什么需要：落位只能读到「那一帧」目标行相对视口的位置，然后写一次 scrollTop。
 * 而那一帧的布局一定还没稳，至少三条：
 *  1. 上方未挂载行用的是估算高度（虚拟化），目标一挂载、估值被实测高度替换，整段高度会变；
 *  2. 扩窗/补页批次还在往上插行，文档高度逐帧变大；
 *  3. 浏览器会把 scrollTop 截断到「当时的」maxScrollTop —— 文档还没长够，写多了也滚不过去。
 * 三种情况的共同结果都是「跳了一段、没到」，用户只能再点一次刻度，再点一次。
 * （2026-11/12 真机原话：「都要点很多次」「我希望一次性跳转过去」。）
 *
 * 修法是把一次写入变成闭环：每帧重测漂移，偏了就补，直到收敛。
 * 这不是「多试几次」——每次都按实测漂移修正，误差单调收敛；停不停有判据（见 planJumpSettleStep）。
 *
 * 适用范围下界：driftPx 的量级要远大于 1px 的容差。容差取 1px 是因为亚像素抗锯齿会让
 * 「完全对齐」读成 0.3~0.8px；若将来把容差调到 8px 以上，会出现「看着还差一行也不动了」。
 */

/** 帧数上限：24 帧 ≈ 400ms（60Hz）。够覆盖「扩窗分帧 + 估值替换 + 一次浏览器截断回弹」。 */
export const JUMP_SETTLE_MAX_FRAMES = 24;
/** 时间上限：低帧率设备（滚动卡顿时 20fps）用时间兜底，避免帧数上限被拖成两秒。 */
export const JUMP_SETTLE_MAX_MS = 600;
/** 收敛容差（px）：亚像素对齐误差不算漂移。 */
export const JUMP_SETTLE_TOLERANCE_PX = 1;

export type JumpSettleDecision =
	| { kind: "settled" }
	/** 需要把 scrollTop 加上 delta（正 = 往下滚）。 */
	| { kind: "scroll"; delta: number }
	| { kind: "give-up"; reason: "interrupted" | "target-missing" | "frames" | "timeout" };

/**
 * 每帧一次的判定。
 *
 * 顺序有意为之：用户动手 > 帧/时间上限 > 目标消失 > 已收敛 > 继续补。
 * 用户动手排第一：他一旦滚轮/触摸，任何自动补位都是「跟你抢」；
 * 上限排在收敛之前：到点就收手，宁可留 2px 偏差，也不让一次跳转变成 600ms 的自动滚动。
 *
 * driftPx 为 null 表示目标行此刻不在 DOM（虚拟化把它卸载了 / 折叠区收起）：
 * 此时无从测量，继续空转只会白烧帧，直接放弃并交给 pendingJump 的重试循环。
 */
export function planJumpSettleStep(input: { driftPx: number | null; frames: number; elapsedMs: number; interrupted: boolean }): JumpSettleDecision {
	if (input.interrupted) return { kind: "give-up", reason: "interrupted" };
	if (input.frames >= JUMP_SETTLE_MAX_FRAMES) return { kind: "give-up", reason: "frames" };
	if (input.elapsedMs >= JUMP_SETTLE_MAX_MS) return { kind: "give-up", reason: "timeout" };
	if (input.driftPx === null) return { kind: "give-up", reason: "target-missing" };
	if (Math.abs(input.driftPx) <= JUMP_SETTLE_TOLERANCE_PX) return { kind: "settled" };
	return { kind: "scroll", delta: input.driftPx };
}
