import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { growImportListWindow, IMPORT_LIST_PAGE_SIZE, resolveImportListWindow, type ImportListWindow } from "../utils/importSessionList";

/**
 * 列表的增量渲染窗口：先渲染首屏 pageSize 行，滚动到列表底部时再追加一批。
 *
 * 目的不是分页，而是把 DOM 行数压在上百以内——导入列表可能上千行，
 * 一次性全渲染会让弹窗打开时明显卡顿（选中态更新也要重排整表）。
 *
 * root 取列表的滚动容器（弹窗主体）而不是视口：列表在弹窗内部滚动，
 * root = null 时哨兵只有在滚动容器整体进入视口时才会触发，判定不可靠。
 */
export function useLazyListWindow<T>(items: readonly T[], options: { pageSize?: number; scrollRef?: RefObject<HTMLElement | null> } = {}) {
	const { pageSize = IMPORT_LIST_PAGE_SIZE, scrollRef } = options;
	const sentinelRef = useRef<HTMLDivElement | null>(null);
	const [windowState, setWindowState] = useState<ImportListWindow>(() => ({ source: items, count: pageSize }));

	// 数据或关键字变化后必须回到首屏窗口：沿用旧窗口会让新结果一次性渲染上百行。
	// 在渲染期同步收敛（React 支持的「按 props 调整 state」），避免先按旧窗口渲染一大帧再重渲染。
	const resolved = resolveImportListWindow(windowState, items, pageSize);
	if (resolved !== windowState) setWindowState(resolved);

	const visibleCount = Math.min(windowState.count, items.length);
	// 已经能整表渲染时复用原数组引用，避免下游 memo（行、分组）被无意义地打断。
	const visible = useMemo<readonly T[]>(() => (visibleCount >= items.length ? items : items.slice(0, visibleCount)), [items, visibleCount]);
	const hasMore = visibleCount < items.length;

	const loadMore = useCallback(() => {
		setWindowState((current) => growImportListWindow(current, items.length, pageSize));
	}, [items.length, pageSize]);

	useEffect(() => {
		// 依赖 visibleCount：每追加一批都重新观察，若哨兵仍在视口内（首屏还没填满）就再追加一批，
		// 直到填满滚动容器或数据取完为止；不依赖 scroll 事件可以少一层节流与监听清理。
		if (!hasMore || typeof IntersectionObserver === "undefined") return;
		const sentinel = sentinelRef.current;
		if (!sentinel) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) loadMore();
			},
			{ root: scrollRef?.current ?? null, rootMargin: "160px" },
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [hasMore, visibleCount, loadMore, scrollRef]);

	return { visible, visibleCount, totalCount: items.length, hasMore, loadMore, sentinelRef };
}
