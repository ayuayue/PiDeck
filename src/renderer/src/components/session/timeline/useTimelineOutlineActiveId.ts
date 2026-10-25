import { type Dispatch, type RefObject, type SetStateAction, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { resolveActiveOutlineItemId, type OutlineItemPosition } from "./outlineRailActive";
import { ROOT_ROW_SELECTOR } from "../../../hooks/timeline/useVisibleTimelineRows";

const OUTLINE_VIEWPORT_ANCHOR_OFFSET = 28;
const CONTENT_MEASURE_INTERVAL_MS = 120;
/**
 * `.message-list` 的 childList 观察选项：必须带 subtree。
 *
 * 历史轮虚拟化后，行在 VirtualRunList 的虚拟容器内部挂载/回收（比 `.message-list` 深两层），
 * 只观察直接子节点（childList 无 subtree）收不到这些变化：positions 会一直停留在上一次
 * 全量测量时的行上，rail 高亮在虚拟区滚动时不跟随（#401 复审）。
 */
export const TIMELINE_MESSAGE_LIST_OBSERVER_OPTIONS: MutationObserverInit = Object.freeze({ childList: true, subtree: true });

type TimelineOutlineItem = {
	id: string;
};

/**
 * 测量大纲项的内容坐标。只扫已挂载行根（.user-turn / .turn-row），不再对每个
 * `[data-message-id]`（行内工具卡/中间回复）逐个 rect：虚拟化滚动期间观察器每 120ms
 * 触发一次，逐子卡扫描会随工具卡数量线性增长，与 #400 的去 O(N) 方向相反。
 * 大纲项本来就是消息行根；未命中行根的 id 精确回落一次，保持旧全量扫描的覆盖面。
 */
export function measureOutlineItemPositions(timeline: HTMLElement, ids: ReadonlySet<string>): OutlineItemPosition[] {
	const contentOrigin = timeline.getBoundingClientRect().top - timeline.scrollTop;
	const positions: OutlineItemPosition[] = [];
	const seen = new Set<string>();
	for (const element of timeline.querySelectorAll<HTMLElement>(ROOT_ROW_SELECTOR)) {
		const id = element.dataset.messageId;
		if (!id || !ids.has(id) || seen.has(id)) continue;
		seen.add(id);
		const top = element.getBoundingClientRect().top - contentOrigin;
		if (Number.isFinite(top)) positions.push({ id, top });
	}
	// 回落只针对行根选择器没覆盖到的少量大纲项（历史数据/扩展卡）。CSS.escape 缺失的
	// 环境（Node 测试）跳过，不因此报错。
	if (seen.size < ids.size && typeof CSS !== "undefined" && typeof CSS.escape === "function") {
		for (const id of ids) {
			if (seen.has(id)) continue;
			const element = timeline.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
			if (!element) continue;
			const top = element.getBoundingClientRect().top - contentOrigin;
			if (Number.isFinite(top)) positions.push({ id, top });
		}
	}
	positions.sort((left, right) => left.top - right.top);
	return positions;
}
/**
 * Synchronizes the outline rail with the user-message checkpoint at the top of
 * the timeline. Message geometry is measured only after layout changes; scroll
 * frames use cached content offsets and a binary search.
 */
export function useTimelineOutlineActiveId(timelineRef: RefObject<HTMLElement | null> | undefined, items: readonly TimelineOutlineItem[]): readonly [string | undefined, Dispatch<SetStateAction<string | undefined>>] {
	const [activeId, setActiveId] = useState<string | undefined>(undefined);
	const activeIdRef = useRef(activeId);
	activeIdRef.current = activeId;
	const itemIdKey = useMemo(() => items.map((item) => item.id).join("\u0000"), [items]);
	const itemIds = useMemo(() => new Set(items.map((item) => item.id)), [itemIdKey]);
	const itemIdsRef = useRef<ReadonlySet<string>>(itemIds);
	itemIdsRef.current = itemIds;
	const positionsRef = useRef<readonly OutlineItemPosition[]>([]);

	const updateActiveId = useCallback((nextActiveId: string | undefined) => {
		if (activeIdRef.current === nextActiveId) return;
		activeIdRef.current = nextActiveId;
		setActiveId(nextActiveId);
	}, []);

	const setTrackedActiveId = useCallback<Dispatch<SetStateAction<string | undefined>>>(
		(next) => {
			updateActiveId(typeof next === "function" ? next(activeIdRef.current) : next);
		},
		[updateActiveId],
	);

	const measurePositions = useCallback(() => {
		const timeline = timelineRef?.current;
		const ids = itemIdsRef.current;
		if (!timeline || ids.size === 0) {
			positionsRef.current = [];
			return;
		}
		positionsRef.current = measureOutlineItemPositions(timeline, ids);
	}, [timelineRef]);

	const syncActiveId = useCallback(() => {
		const timeline = timelineRef?.current;
		const ids = itemIdsRef.current;
		if (ids.size === 0) {
			positionsRef.current = [];
			updateActiveId(undefined);
			return;
		}
		if (!timeline) return;

		updateActiveId(resolveActiveOutlineItemId(positionsRef.current, timeline.scrollTop + OUTLINE_VIEWPORT_ANCHOR_OFFSET));
	}, [timelineRef, updateActiveId]);

	useLayoutEffect(() => {
		measurePositions();
		syncActiveId();
	}, [itemIdKey, measurePositions, syncActiveId]);

	useEffect(() => {
		const timeline = timelineRef?.current;
		if (!timeline) return;

		const content = timeline.querySelector<HTMLElement>('[role="log"]');
		const messageList = content?.querySelector<HTMLElement>(".message-list");
		let frame: number | undefined;
		let measureBeforeSync = false;
		let contentMeasureTimer: number | undefined;
		let lastContentMeasureAt = performance.now();

		const flush = () => {
			frame = undefined;
			if (measureBeforeSync) {
				measureBeforeSync = false;
				measurePositions();
				lastContentMeasureAt = performance.now();
			}
			syncActiveId();
		};
		const scheduleSync = (measure = false) => {
			measureBeforeSync ||= measure;
			if (frame !== undefined) return;
			frame = window.requestAnimationFrame(flush);
		};
		const scheduleContentMeasurement = () => {
			const remaining = CONTENT_MEASURE_INTERVAL_MS - (performance.now() - lastContentMeasureAt);
			if (remaining <= 0) {
				scheduleSync(true);
				return;
			}
			if (contentMeasureTimer !== undefined) return;
			contentMeasureTimer = window.setTimeout(() => {
				contentMeasureTimer = undefined;
				scheduleSync(true);
			}, remaining);
		};

		const handleScroll = () => scheduleSync();
		timeline.addEventListener("scroll", handleScroll, { passive: true });
		const viewportResizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => scheduleSync(true));
		viewportResizeObserver?.observe(timeline);
		const contentResizeObserver = typeof ResizeObserver === "undefined" || !content ? undefined : new ResizeObserver(scheduleContentMeasurement);
		if (content) contentResizeObserver?.observe(content);
		// 虚拟行替换（virtualizer 回收/挂载）只改虚拟容器内部子节点，必须走 subtree；
		// 回调复用 120ms 节流入口；测量本身只扫行根（见 measureOutlineItemPositions），
		// 不会随行内工具卡数量线性增长。
		const messageListObserver = typeof MutationObserver === "undefined" || !messageList ? undefined : new MutationObserver(scheduleContentMeasurement);
		const handleMessageAnimationEnd = (event: AnimationEvent) => {
			if (event.animationName === "message-enter" || event.animationName === "top-enter") {
				scheduleSync(true);
			}
		};
		if (messageList) {
			messageListObserver?.observe(messageList, TIMELINE_MESSAGE_LIST_OBSERVER_OPTIONS);
			// Transform animations do not notify ResizeObserver; refresh their final layout position.
			messageList.addEventListener("animationend", handleMessageAnimationEnd, true);
		}
		scheduleSync(true);

		return () => {
			timeline.removeEventListener("scroll", handleScroll);
			viewportResizeObserver?.disconnect();
			contentResizeObserver?.disconnect();
			messageListObserver?.disconnect();
			messageList?.removeEventListener("animationend", handleMessageAnimationEnd, true);
			if (frame !== undefined) window.cancelAnimationFrame(frame);
			if (contentMeasureTimer !== undefined) window.clearTimeout(contentMeasureTimer);
		};
	}, [itemIdKey, measurePositions, syncActiveId, timelineRef]);

	return [activeId, setTrackedActiveId];
}
