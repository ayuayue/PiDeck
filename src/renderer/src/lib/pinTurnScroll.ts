/**
 * 时间线尾部工具：
 * - 给「发送当下的新增消息」计算入场动画的 fresh id 集合；
 * - 通用 scrollTop 缓动（最新轮自动收起后的定位使用，可被用户操作取消）。
 * 发送置顶（pin-to-top）清屏动画曾因与流式跟随冲突、偶发抖动而移除，不在此恢复。
 */

export type PinTurnMessage = {
	id: string;
	role: string;
};

/** 尾部新增消息 id（入场动画用）。历史首帧不闪；只有发送当下才给当前尾一条入场。 */
export function resolveFreshTailIds(messages: readonly PinTurnMessage[], previousTail: string | undefined, nextTail: string, pendingRequestId?: string): string[] {
	if (!previousTail) return pendingRequestId ? [nextTail] : [];
	if (nextTail === previousTail) return [];
	const baselineIndex = messages.findIndex((message) => message.id === previousTail);
	return baselineIndex < 0 ? [nextTail] : messages.slice(baselineIndex + 1).map((message) => message.id);
}

/** 按滚动距离估算时长：短距离干脆，长距离封顶，避免整页滚太久。 */
export function pinScrollDurationMs(distancePx: number): number {
	const distance = Math.abs(distancePx);
	return Math.round(Math.min(720, Math.max(320, 240 + distance * 0.28)));
}

/** ease-in-out cubic：起步与收尾速度连续，长距离不在首帧猛跳。 */
export function pinScrollEase(progress: number): number {
	const t = Math.min(1, Math.max(0, progress));
	return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
}

export type AnimateScrollTopOptions = {
	reduceMotion?: boolean;
	/** Re-read the target while layout grows, without restarting the easing clock. */
	getTargetTop?: () => number;
	isCancelled?: () => boolean;
	onComplete?: () => void;
};

/**
 * 把 scrollTop 缓动到目标。返回取消函数。
 * 不用 CSS scroll-behavior:smooth：时长/曲线不可控，且无法在用户介入时同步清理
 * 程序化滚动抑制标记。
 */
export function animateScrollTop(element: HTMLElement, targetTop: number, options: AnimateScrollTopOptions = {}): () => void {
	const reduceMotion = options.reduceMotion ?? false;
	const isCancelled = options.isCancelled ?? (() => false);
	const target = Math.max(0, targetTop);
	if (reduceMotion || Math.abs(element.scrollTop - target) < 2) {
		element.scrollTop = target;
		options.onComplete?.();
		return () => undefined;
	}

	const startTop = element.scrollTop;
	let currentTarget = target;
	const distance = target - startTop;
	const duration = pinScrollDurationMs(distance);
	const startedAt = performance.now();
	let frameId = 0;
	let stopped = false;

	const stop = () => {
		if (stopped) return;
		stopped = true;
		cancelAnimationFrame(frameId);
	};

	const step = () => {
		if (stopped || isCancelled()) {
			stop();
			return;
		}
		currentTarget = Math.max(0, options.getTargetTop?.() ?? currentTarget);
		const progress = pinScrollEase((performance.now() - startedAt) / duration);
		element.scrollTop = startTop + (currentTarget - startTop) * progress;
		if (progress >= 1) {
			stop();
			options.onComplete?.();
			return;
		}
		frameId = requestAnimationFrame(step);
	};

	frameId = requestAnimationFrame(step);
	return stop;
}
