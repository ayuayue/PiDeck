import { useCallback, useContext, useLayoutEffect, useRef, useState } from "react";
import { MessageScrollerGeometryContext, usePauseSessionFollow } from "../../agents/message-scroller-context";
import { useInsideProcessGroupBody, useProcessGroupScrollControls } from "./processGroupScrollContext";
import { processEntryStartOffset, resolveProcessEntryStickyState, type ProcessEntryStickyState } from "./processEntryStickyPolicy";

/**
 * 工具与思考的标题吸顶状态；行只订阅一个滚动容器，不另建滚动/尺寸监听。
 *
 * 视口归属按「最近的滚动容器」：组体内由组体限高视口提供几何（`position: sticky`
 * 绑定的就是它，「回到本项开头」也改组体的 scrollTop）；组外仍用会话视口几何。
 */
export function useProcessEntryStickyHeader(expanded: boolean) {
	const geometry = useContext(MessageScrollerGeometryContext);
	const insideProcessGroup = useInsideProcessGroupBody();
	const groupControls = useProcessGroupScrollControls();
	const controls = groupControls ?? (insideProcessGroup ? geometry : null);
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

	/**
	 * 展开/收起这类「会当场长高」的动作前停跟底：先停组体，再停会话。
	 *
	 * 为什么两层都要停：组体还没到限高时，展开一个成员会把**会话**也一起撑高，
	 * 只停内层盖不住（实测外层的跟底引擎会把刚展开的标题拽出视口）。组外是 no-op
	 * （扁平路径保持既有行为，不为一次展开改会话滚动）。
	 */
	const pauseSessionFollow = usePauseSessionFollow();
	const pauseFollowForGrowth = useCallback(() => {
		if (!insideProcessGroup) return;
		const scroll = groupControls?.scrollRef.current;
		if (scroll) groupControls?.restoreAt(scroll.scrollTop);
		pauseSessionFollow();
	}, [groupControls, insideProcessGroup, pauseSessionFollow]);

	/** 开合成员前的统一入口：变大才停跟底，标题已滚走则先回本项开头。 */
	const prepareToggle = useCallback(
		(expanding: boolean) => {
			if (expanding) pauseFollowForGrowth();
			prepareCollapse();
		},
		[pauseFollowForGrowth, prepareCollapse],
	);

	return { ...state, entryRef, headerRef, returnToStart, prepareCollapse, prepareToggle, insideProcessGroup };
}
