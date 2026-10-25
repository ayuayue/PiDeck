import { useCallback, useContext, useLayoutEffect, useRef, useState } from "react";
import { ProcessGroupScrollControlsContext } from "./processGroupScrollContext";
import { processEntryStartOffset, resolveProcessEntryStickyState, type ProcessEntryStickyState } from "./processEntryStickyPolicy";

/** 工具与思考共用标题吸顶状态；行只订阅组体，不另建滚动/尺寸监听。 */
export function useProcessEntryStickyHeader(expanded: boolean) {
	const controls = useContext(ProcessGroupScrollControlsContext);
	const entryRef = useRef<HTMLElement | null>(null);
	const headerRef = useRef<HTMLDivElement | null>(null);
	const [state, setState] = useState<ProcessEntryStickyState>({ sticky: false, pinned: false });

	useLayoutEffect(() => {
		const measure = () => {
			const scroll = controls?.scrollRef.current;
			const entry = entryRef.current;
			const header = headerRef.current;
			let next: ProcessEntryStickyState = { sticky: false, pinned: false };
			if (expanded && scroll && entry && header && scroll.contains(entry)) {
				const bounds = entry.getBoundingClientRect();
				next = resolveProcessEntryStickyState({ expanded, viewportTop: scroll.getBoundingClientRect().top + scroll.clientTop, viewportHeight: scroll.clientHeight, entryTop: bounds.top, entryBottom: bounds.bottom, entryHeight: entry.offsetHeight, headerHeight: header.offsetHeight });
			}
			// 滚动每帧只读几何；仅进入/离开吸顶或尺寸资格变化才更新此行。
			setState((previous) => (previous.sticky === next.sticky && previous.pinned === next.pinned ? previous : next));
		};
		measure();
		if (expanded && controls) return controls.subscribeGeometry(measure);
	}, [expanded, controls]);

	const returnToStart = useCallback(() => {
		const scroll = controls?.scrollRef.current;
		const entry = entryRef.current;
		if (!controls || !scroll || !entry || !scroll.contains(entry)) return;
		const offset = processEntryStartOffset({ entryTop: entry.getBoundingClientRect().top, viewportTop: scroll.getBoundingClientRect().top + scroll.clientTop, scrollTop: scroll.scrollTop });
		if (offset === null) return;
		// 复用跟底引擎：同时解锁锁底、取消在途动画，不让下一帧又把阅读者拽回底部。
		controls.restoreAt(offset);
		headerRef.current?.querySelector<HTMLButtonElement>("button[aria-expanded]")?.focus({ preventScroll: true });
	}, [controls]);

	const prepareCollapse = useCallback(() => {
		const scroll = controls?.scrollRef.current;
		const entry = entryRef.current;
		if (expanded && scroll && entry && entry.getBoundingClientRect().top < scroll.getBoundingClientRect().top + scroll.clientTop) returnToStart();
	}, [expanded, controls, returnToStart]);

	return { ...state, entryRef, headerRef, returnToStart, prepareCollapse, insideProcessGroup: controls !== null };
}
