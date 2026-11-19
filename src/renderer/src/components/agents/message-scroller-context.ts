import { createContext, useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from "react";

/** 会话内的长内容共用滚动几何与定位入口，不创建额外视口或跟随状态。 */
export type MessageScrollerGeometry = {
	scrollRef: RefObject<HTMLElement | null>;
	restoreAt: (scrollTop: number) => void;
	subscribeGeometry: (listener: () => void) => () => void;
};

export const MessageScrollerGeometryContext = createContext<MessageScrollerGeometry | null>(null);

/** 一个会话共用一条 scroll 监听、一份尺寸观察与一帧调度。 */
export function useMessageScrollerGeometry(scrollRef: RefObject<HTMLElement | null>, contentRef: RefObject<HTMLElement | null>, restoreAt: (scrollTop: number) => void): MessageScrollerGeometry {
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
		if (!scroll || !content) return;
		active.current = true;
		const observer = new ResizeObserver(schedule);
		observer.observe(scroll);
		observer.observe(content);
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
	}, [scrollRef, contentRef, schedule]);

	return useMemo(() => ({ scrollRef, restoreAt, subscribeGeometry }), [scrollRef, restoreAt, subscribeGeometry]);
}
