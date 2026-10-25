import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { growImportListWindow, IMPORT_LIST_PAGE_SIZE, resolveImportListWindow } from "../utils/importSessionList";

interface LazyListWindowState {
	count: number;
	/** 数据源引用：resetKey 缺省时用于判断「数据换了」（搜索/重扫后回到首屏窗口）。 */
	source: readonly unknown[];
	/** 显式重置键：传了就只认它（例如文件树只跟项目走，树刷新/展开不得把已滚出的行收回去）。 */
	resetKey: unknown;
}

/**
 * 列表的增量渲染窗口：先渲染首屏 pageSize 行，滚动到列表底部时再追加一批。
 *
 * 目的不是分页，而是把 DOM 行数压在上百以内——导入列表可能上千行，
 * 一次性全渲染会让弹窗打开时明显卡顿（选中态更新也要重排整表）。
 *
 * root 取列表的滚动容器（弹窗主体）而不是视口：列表在弹窗内部滚动，
 * root = null 时哨兵只有在滚动容器整体进入视口时才会触发，判定不可靠。
 *
 * 重置语义：
 * - 缺省（导入列表）：数据源数组引用变化即回到首屏，避免新搜索结果一次挂上百行；
 * - 传 resetKey（文件树）：只在该键变化（切项目）时回到首屏。树刷新/懒加载会给
 *   children 新数组引用，若也重置窗口，用户滚动加载出的行会被收回、视口跳动。
 */
export function useLazyListWindow<T>(items: readonly T[], options: { pageSize?: number; scrollRef?: RefObject<HTMLElement | null>; resetKey?: unknown } = {}) {
	const { pageSize = IMPORT_LIST_PAGE_SIZE, scrollRef, resetKey } = options;
	const sentinelRef = useRef<HTMLDivElement | null>(null);
	const [windowState, setWindowState] = useState<LazyListWindowState>(() => ({ count: pageSize, source: items, resetKey }));

	// 数据或关键字变化后必须回到首屏窗口：沿用旧窗口会让新结果一次性渲染上百行。
	// 在渲染期同步收敛（React 支持的「按 props 调整 state」），避免先按旧窗口渲染一大帧再重渲染。
	const shouldReset = resetKey === undefined ? windowState.source !== items : windowState.resetKey !== resetKey;
	if (shouldReset) {
		// resetKey 缺省复用导入列表的成熟收敛逻辑（source 引用比较）；显式 resetKey 时只跟键走。
		const reset = resetKey === undefined ? resolveImportListWindow(windowState, items, pageSize) : { source: items, count: pageSize };
		setWindowState({ ...reset, resetKey });
	}

	const visibleCount = Math.min(windowState.count, items.length);
	// 已经能整表渲染时复用原数组引用，避免下游 memo（行、分组）被无意义地打断。
	const visible = useMemo<readonly T[]>(() => (visibleCount >= items.length ? items : items.slice(0, visibleCount)), [items, visibleCount]);
	const hasMore = visibleCount < items.length;

	const loadMore = useCallback(() => {
		setWindowState((current) => {
			const grown = growImportListWindow({ source: current.source, count: current.count }, items.length, pageSize);
			return grown.count === current.count ? current : { ...current, count: grown.count };
		});
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
