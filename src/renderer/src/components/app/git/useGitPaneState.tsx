/**
 * Git 面板三段式分区的高度/折叠状态机（从 `GitPanel.tsx` 原样搬出）。
 *
 * 高度分配由 `fitPaneHeights` 按真实抽屉预算计算；开合后 180ms 内才给分区挂 height 过渡，
 * sash 拖拽期间不挂（否则橡皮筋）。折叠与高度偏好按「项目 + 仓库 + 布局」落盘，
 * 切项目/仓库时由 `resetPaneState` 恢复该作用域的偏好。
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { useAnimationWindow } from "../../../hooks/useAnimationWindow";
import { PaneSash } from "./GitPaneSash";
import { adjacentVisiblePane, fitPaneHeights, type GitPanelLayoutMode, PANE_MIN_BODY_HEIGHT, paneStateStorageKey, type PaneId, type PaneOpenState, type PaneState, readPaneState, resizePair } from "./gitPaneLayout";

export function useGitPaneState(input: { projectId: string; repoScopeKey: string; layout: GitPanelLayoutMode; panelChromeHeight: number; panelRef: RefObject<HTMLDivElement | null> }) {
	const { projectId, repoScopeKey, layout, panelChromeHeight, panelRef } = input;
	const [paneAnimSeq, setPaneAnimSeq] = useState(0);
	// 开合动画窗口：只在 toggle 后 180ms 内给分区挂 height 过渡（挂在 .git-panel[data-pane-animating]），
	// sash 拖拽改 --git-pane-height 时窗口不在，避免拖拽橡皮筋。定时器收口在 hook（面板源码有 setTimeout 守卫）。
	const paneAnimating = useAnimationWindow(paneAnimSeq, 180);
	const [availableHeight, setAvailableHeight] = useState(720);
	const [paneState, setPaneState] = useState<PaneState>(() => readPaneState(projectId, repoScopeKey, layout));

	useEffect(() => {
		const element = panelRef.current;
		if (!element) return;
		const updateHeight = () => setAvailableHeight(Math.max(PANE_MIN_BODY_HEIGHT, Math.round(element.clientHeight)));
		updateHeight();
		if (typeof ResizeObserver === "undefined") {
			window.addEventListener("resize", updateHeight);
			return () => window.removeEventListener("resize", updateHeight);
		}
		const observer = new ResizeObserver(updateHeight);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		if (layout === "historyOnly") return;
		setPaneState((current) => ({
			...current,
			heights: fitPaneHeights(current, availableHeight, panelChromeHeight, layout),
		}));
	}, [availableHeight, layout, panelChromeHeight]);

	useEffect(() => {
		try {
			localStorage.setItem(paneStateStorageKey(projectId, repoScopeKey, layout), JSON.stringify(paneState));
		} catch {
			// Storage can be blocked in preview/web mode; pane interaction must still work for this session.
		}
	}, [layout, paneState, projectId, repoScopeKey]);

	/** 切项目/仓库：恢复该作用域持久化的折叠与高度偏好。 */
	const resetPaneState = () => {
		const next = readPaneState(projectId, repoScopeKey, layout);
		setPaneState({
			...next,
			// historyOnly 底部按内容收缩：不能用自身 clientHeight 回填，否则一展开就被反向压扁。
			heights: layout === "historyOnly" ? next.heights : fitPaneHeights(next, availableHeight, panelChromeHeight, layout),
		});
	};

	const togglePane = (id: PaneId) => {
		setPaneAnimSeq((v) => v + 1);
		setPaneState((current) => {
			const open = { ...current.open, [id]: !current.open[id] };
			const next = { ...current, open };
			return {
				...next,
				heights: layout === "historyOnly" ? next.heights : fitPaneHeights(next, availableHeight, panelChromeHeight, layout),
			};
		});
	};
	const resizePanes = (before: PaneId, after: PaneId, beforeHeight: number, afterHeight: number) => {
		setPaneState((current) => resizePair(current, before, after, beforeHeight, afterHeight));
	};

	const visibleOpen: PaneOpenState = layout === "historyOnly" ? { ...paneState.open, changes: false } : paneState.open;
	const visibleSashAfterChanges = adjacentVisiblePane(visibleOpen, "changes", 1);
	const visibleSashAfterGraph = adjacentVisiblePane(visibleOpen, "graph", 1);
	const paneStyle = (id: PaneId): React.CSSProperties =>
		({
			"--git-pane-height": `${paneState.heights[id]}px`,
		}) as React.CSSProperties;

	const renderSash = (before: PaneId, after: PaneId) => <PaneSash before={before} after={after} beforeHeight={paneState.heights[before]} afterHeight={paneState.heights[after]} onResize={(beforeHeight, afterHeight) => resizePanes(before, after, beforeHeight, afterHeight)} />;

	return { paneAnimating, paneState, resetPaneState, togglePane, paneStyle, renderSash, visibleSashAfterChanges, visibleSashAfterGraph };
}
