import { animateScrollTop, pinScrollDurationMs } from "../../lib/pinTurnScroll";

const TARGET_GAP_PX = 24;
const SKIP_EPSILON_PX = 8;
const CANCEL_INPUTS = ["wheel", "pointerdown", "touchstart", "keydown"] as const;

type SendScrollCallbacks = {
	/** 解锁引擎并作废旧历史浏览事务；必须先于垫片增高。 */
	onStart: () => void;
	onComplete: () => void;
	isFollowing: () => boolean;
	markProgrammaticScroll: (durationMs: number) => void;
	clearProgrammaticScroll: () => void;
	/** 动画被用户输入/切会话/下一次 pin 打断（不会走 onComplete）。 */
	onCancel?: () => void;
};

/** 最新 user 身份不依赖后端 ID 格式，也不要求它仍是数组最后一条。 */
export function latestUserMessageId(messages: readonly { id: string; role: string }[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index].role === "user") return messages[index].id;
	}
	return undefined;
}

/**
 * 一次发送定位的 DOM 生命周期。滚动帧只写 scrollTop，不更新 React state；
 * 流式内容只在 ResizeObserver 中测量，底部留白随回复增高等量消耗。
 * 普通流式跟随仍归 MessageScroller，历史浏览/切会话不触发定位。
 */
export class SendScrollPositioner {
	private timeline: HTMLElement | null = null;
	private spacer: HTMLElement | null = null;
	private messageId: string | undefined;
	private targetTop = 0;
	private observer: ResizeObserver | undefined;
	private stopAnimation: (() => void) | undefined;
	private callbacks: SendScrollCallbacks | undefined;
	private generation = 0;
	isAnimating = false;

	/** 排除 user 气泡入场 transform，使用布局位置而不是动画中的视觉偏移。 */
	private measureTarget(): number | undefined {
		const timeline = this.timeline;
		const row = timeline?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(this.messageId ?? "")}"]`);
		if (!timeline || !row) return undefined;
		const transform = typeof getComputedStyle === "function" ? getComputedStyle(row).transform : "none";
		const translateY = transform === "none" ? 0 : Number.parseFloat(transform.match(/^matrix\([^,]+,[^,]+,[^,]+,[^,]+,[^,]+,([^\)]+)\)$/)?.[1] ?? "0") || 0;
		return Math.max(0, timeline.scrollTop + row.getBoundingClientRect().top - translateY - timeline.getBoundingClientRect().top - TARGET_GAP_PX);
	}

	/** 后排版/折叠改变上方高度时同步换坐标，不重启缓动或与浏览钉行抢位置。 */
	private syncSpace = (): void => {
		const timeline = this.timeline;
		const spacer = this.spacer;
		const target = this.measureTarget();
		if (!timeline || !spacer || target === undefined) return;
		const previousTarget = this.targetTop;
		this.targetTop = target;
		const naturalHeight = timeline.scrollHeight - spacer.offsetHeight;
		const space = Math.max(0, Math.ceil(target + timeline.clientHeight - naturalHeight));
		if (spacer.offsetHeight !== space) spacer.style.height = `${space}px`;
		// 跟随引擎负责正常增高；这里只补动画中（或仍有留白时）的上方漂移。
		// 已手动上翻不补，避免继续把用户焊在刚发送的消息上。
		const shift = target - previousTarget;
		if (shift !== 0 && this.isAnimating) {
			this.callbacks?.markProgrammaticScroll(900);
			timeline.scrollTop += shift;
		} else if (space > 0 && this.callbacks?.isFollowing() && Math.abs(timeline.scrollTop - target) > SKIP_EPSILON_PX) {
			this.callbacks.markProgrammaticScroll(0);
			timeline.scrollTop = target;
		}
	};

	/** 取消运动但保留剩余留白：直接拆垫片会让浏览器 clamp，反而抢用户滚动。 */
	cancel = (): void => {
		this.generation += 1;
		this.stopAnimation?.();
		this.stopAnimation = undefined;
		const wasAnimating = this.isAnimating;
		this.isAnimating = false;
		this.detachInputs();
		this.callbacks?.clearProgrammaticScroll();
		// 被打断 = 接收方要自己结算（controller 据此撤掉「置顶动画进行中」标记），
		// 否则标记会永远挂着，新一轮折叠被无限期推迟。
		if (wasAnimating) this.callbacks?.onCancel?.();
	};

	private detachInputs(): void {
		for (const input of CANCEL_INPUTS) this.timeline?.removeEventListener(input, this.cancel, true);
	}

	/** 切会话/卸载才彻底清掉垫片与 observer，不把旧动画带到新 DOM。 */
	reset(): void {
		this.cancel();
		this.observer?.disconnect();
		this.observer = undefined;
		if (this.spacer) this.spacer.style.height = "0px";
		this.timeline = null;
		this.spacer = null;
		this.messageId = undefined;
		this.callbacks = undefined;
	}

	/** 有溢出才置顶；短会话保持原有位置与跟随，不制造空白和滚动条。 */
	pin(timeline: HTMLElement, messageId: string, callbacks: SendScrollCallbacks): void {
		this.cancel();
		this.observer?.disconnect();
		this.observer = undefined;
		this.timeline = timeline;
		this.spacer = timeline.querySelector<HTMLElement>("[data-send-scroll-spacer]");
		this.messageId = messageId;
		this.callbacks = callbacks;
		const spacerHeight = this.spacer?.offsetHeight ?? 0;
		if (timeline.scrollHeight - spacerHeight <= timeline.clientHeight + SKIP_EPSILON_PX) return;
		const target = this.measureTarget();
		if (target === undefined) return;

		this.targetTop = target;
		callbacks.onStart();
		this.isAnimating = true;
		// onStart 会恢复原 scrollTop/解锁 stick-to-bottom，必须在这里之后首次测量；
		// 否则目标会基于解锁前的 stale scrollTop，动画只走到旧坐标。
		const refreshedTarget = this.measureTarget();
		if (refreshedTarget !== undefined) this.targetTop = refreshedTarget;
		this.syncSpace();
		const content = timeline.querySelector<HTMLElement>('[role="log"]');
		if (content && typeof ResizeObserver !== "undefined") {
			this.observer = new ResizeObserver(this.syncSpace);
			this.observer.observe(content);
			this.observer.observe(timeline);
		}
		for (const input of CANCEL_INPUTS) timeline.addEventListener(input, this.cancel, { capture: true, passive: true });
		const generation = this.generation;
		const distance = this.targetTop - timeline.scrollTop;
		callbacks.markProgrammaticScroll(pinScrollDurationMs(distance) + 120);
		const finish = () => {
			if (this.generation !== generation) return;
			this.isAnimating = false;
			this.stopAnimation = undefined;
			this.detachInputs();
			callbacks.clearProgrammaticScroll();
			callbacks.onComplete();
		};
		if (Math.abs(distance) <= SKIP_EPSILON_PX) {
			finish();
			return;
		}
		const stop = animateScrollTop(timeline, this.targetTop, {
			reduceMotion: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
			getTargetTop: () => this.targetTop,
			isCancelled: () => this.generation !== generation,
			onComplete: finish,
		});
		if (this.isAnimating) this.stopAnimation = stop;
	}
}
