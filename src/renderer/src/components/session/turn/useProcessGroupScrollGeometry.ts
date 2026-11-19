import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import type { MessageScrollerGeometry } from "../../agents/message-scroller-context";

/**
 * 组体限高视口的几何通知（`MessageScrollerGeometry` 的组内版本）。
 *
 * 与会话侧的 `useMessageScrollerGeometry` 同形同一套语义：一条 scroll 监听、一份尺寸观察、
 * 一帧调度，组内所有展开行共享；行只订阅，不各自建监听。
 *
 * 唯一的差别是 `open`：组体收起时 DOM 不存在，ref 为空，必须等展开后重新挂监听与观察，
 * 收起时配对清理。所以这里按 `open` 作依赖，而不是像会话侧那样一次挂到底。
 */
export function useProcessGroupScrollGeometry(open: boolean, scrollRef: RefObject<HTMLElement | null>, contentRef: RefObject<HTMLElement | null>, restoreAt: (scrollTop: number) => void): MessageScrollerGeometry {
	const listeners = useRef(new Set<() => void>());
	const frame = useRef<number | null>(null);
	const active = useRef(false);
	const schedule = useCallback(() => {
		if (!active.current || frame.current !== null || listeners.current.size === 0) return;
		frame.current = requestAnimationFrame(() => {
			frame.current = null;
			for (const listener of listeners.current) listener();
		});
	}, []);
	const subscribeGeometry = useCallback(
		(listener: () => void) => {
			listeners.current.add(listener);
			// 开合/新增项也会改变其他行的位置，即使内容总高度恰好没有变化。
			schedule();
			return () => {
				listeners.current.delete(listener);
				schedule();
			};
		},
		[schedule],
	);

	useLayoutEffect(() => {
		const scroll = scrollRef.current;
		const content = contentRef.current;
		if (!open || !scroll || !content) return;
		active.current = true;
		const observer = new ResizeObserver(schedule);
		observer.observe(scroll);
		observer.observe(content);
		// 组体滚到底是「手势交给会话」的边界：滚动条拖动/触摸也要在这里被读到。
		scroll.addEventListener("scroll", schedule, { passive: true });
		schedule();
		return () => {
			// 父级先清理时，子项随后的退订不得重新排入卸载后的帧。
			active.current = false;
			scroll.removeEventListener("scroll", schedule);
			observer.disconnect();
			if (frame.current !== null) cancelAnimationFrame(frame.current);
			frame.current = null;
		};
	}, [open, scrollRef, contentRef, schedule]);

	return useMemo(() => ({ scrollRef, restoreAt, subscribeGeometry }), [scrollRef, restoreAt, subscribeGeometry]);
}
