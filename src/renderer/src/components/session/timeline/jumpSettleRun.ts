import { planJumpSettleStep, type JumpSettleDecision } from "./jumpSettle";

/**
 * 落位之后的收敛循环（纯函数，DOM 由 ports 注入）。
 *
 * 为什么从 hook 里搬出来：策略判定（`planJumpSettleStep`）早就是纯函数也有测试，但**驱动它的
 * 循环**在 `useTimelineJumpNavigation` 里，与 `querySelector` / `getBoundingClientRect` /
 * `requestAnimationFrame` 缠在一起，于是「漂移够了就停」「目标消失就放弃」「用户动手立刻收手」
 * 这三条只能靠真机验。搬出来之后这三条都能用假 ports 断言：喂一个漂移序列，看它调用了几次
 * `scrollBy`、在第几帧停、回调带什么 reason。
 *
 * 行为与搬出前逐行一致：
 * - 每帧先量漂移，再把判定交给 `planJumpSettleStep`（顺序、上限、容差都在那里）
 * - 只有 `scroll` 才真的写一次滚动，并把帧计数 +1
 * - 停手时按 reason 分两类交给 `onStop`：settled 保留钉行，interrupted / target-missing 交还钉行，
 *   frames / timeout 保留钉行（那是「没追完」不是「追不到」，下一次点击能接上）
 */
export type JumpSettleMeasure = { height: number; top: number; viewportTop: number } | null;

export interface JumpSettleRunPorts {
	/** 量目标行相对视口的位置。返回 null 表示量不到（未布局 / 已卸载 / 折叠区 display:none）。 */
	measure: () => JumpSettleMeasure;
	/**
	 * 在当前滚动位置上叠一个增量。
	 *
	 * 契约：**调用方负责把结果夹到 [0, 滚动上限]**，本函数只报 delta、不碰边界。
	 * 边界是视口的知识，不是收敛判定的知识；放进这里会让实现方以为已夹过而省掉自己那一次。
	 */
	scrollBy: (delta: number) => void;
	nextFrame: (callback: () => void) => number;
	cancelFrame: (handle: number) => void;
	now: () => number;
	/** 用户真的动手了（引擎判定的 wheel / 触摸 / 键盘），下一帧就收手。 */
	interrupted: () => boolean;
}

export type JumpSettleStopReason = Extract<JumpSettleDecision, { kind: "give-up" }>["reason"];

export interface JumpSettleRunCallbacks {
	onSettled?: () => void;
	onStop?: (reason: JumpSettleStopReason) => void;
}

/** 启动收敛循环，返回取消函数（取消后不再写滚动、不再排帧）。 */
export function runJumpSettle(ports: JumpSettleRunPorts, callbacks: JumpSettleRunCallbacks = {}): () => void {
	const startedAt = ports.now();
	let frames = 0;
	let handle = 0;
	let stopped = false;

	// 两层取消，各自保证的东西不同（实测能分开：只删 cancelFrame 全绿，只删 stopped 就红）：
	// - stopped 保证**正确性**：即使已排队的回调仍被执行、或外部持句柄重入，也不再测量、
	//   不再写滚动、不再报 reason。换任何取消机制（AbortController 等）都必须有等价守卫，
	//   因为「被取消方主动检查 aborted」与「撤销已排队的回调」是两件事。
	// - cancelFrame 只省一次无用回调，是**性能**层。
	const stop = () => {
		stopped = true;
		if (handle) {
			ports.cancelFrame(handle);
			handle = 0;
		}
	};

	const step = () => {
		handle = 0;
		if (stopped) return;
		const measured = ports.measure();
		// height <= 0 = 没被布局：rect 全是 0，拿去算漂移会得出一个巨大的负数，把视口滚到莫名其妙的位置。
		const driftPx = measured && measured.height > 0 ? measured.top - measured.viewportTop : null;
		const decision = planJumpSettleStep({
			driftPx,
			frames,
			elapsedMs: ports.now() - startedAt,
			interrupted: ports.interrupted(),
		});
		if (decision.kind !== "scroll") {
			stop();
			if (decision.kind === "settled") callbacks.onSettled?.();
			else callbacks.onStop?.(decision.reason);
			return;
		}
		frames += 1;
		ports.scrollBy(decision.delta);
		handle = ports.nextFrame(step);
	};

	handle = ports.nextFrame(step);
	return stop;
}
