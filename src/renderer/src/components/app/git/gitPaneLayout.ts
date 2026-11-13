/**
 * Git 面板三段式分区（更改 / 图谱 / 对比）的布局模型。
 *
 * 从 `GitPanel.tsx` 原样搬出：高度分配、可见相邻分区查找与折叠/高度偏好持久化。
 * 这里只做纯计算与 localStorage 读写，不依赖 React 与 UI 原语，便于单测和复用。
 */

/** 面板布局模式：与 `GitPanelProps["layout"]` 同义（独立声明，避免类型层反向依赖入口文件）。 */
export type GitPanelLayoutMode = "full" | "changesOnly" | "historyOnly";

export type PaneId = "changes" | "graph" | "compare";
export type PaneHeights = Record<PaneId, number>;
export type PaneOpenState = Record<PaneId, boolean>;
export type PaneState = { heights: PaneHeights; open: PaneOpenState };

export const PANE_IDS: PaneId[] = ["changes", "graph", "compare"];
export const PANE_MIN_BODY_HEIGHT = 24;
// 头部实际高度 h-8 = 32px（Tailwind rem 基准 16px）。早期按 26px 预算：
// 折叠时溢出 6px 被 overflow-hidden 裁掉，折叠按钮视觉偏下且底部被切。
export const PANE_HEADER_HEIGHT = 32;
/* 分支栏大约高度，用于 fitPaneHeights 中从可用空间预减，避免未计入分支栏高度导致 pane body 溢出 */
export const BRANCH_BAR_HEIGHT = 36;
export const PANE_RESIZE_STEP = 20;
export const PANE_RESIZE_LARGE_STEP = 60;

export function visiblePaneIds(open: PaneOpenState, layout: GitPanelLayoutMode = "full"): PaneId[] {
	return PANE_IDS.filter((id) => {
		if (layout === "historyOnly" && id === "changes") return false;
		if (layout === "changesOnly" && id !== "changes") return false;
		return open[id];
	});
}

export function resizePair(state: PaneState, beforeId: PaneId, afterId: PaneId, beforeHeight: number, afterHeight: number): PaneState {
	return {
		...state,
		heights: {
			...state.heights,
			[beforeId]: Math.max(PANE_MIN_BODY_HEIGHT, Math.round(beforeHeight)),
			[afterId]: Math.max(PANE_MIN_BODY_HEIGHT, Math.round(afterHeight)),
		},
	};
}

/**
 * Allocate every visible body against the real drawer budget. Collapsed panes still
 * consume their header row; the last visible pane receives spare room, matching the
 * way VS Code keeps its view container filled without destroying persisted sizes.
 */
export function fitPaneHeights(state: PaneState, availableHeight: number, chromeHeight = BRANCH_BAR_HEIGHT, layout: GitPanelLayoutMode = "full"): PaneHeights {
	const visible = visiblePaneIds(state.open, layout);
	const heights = { ...state.heights };
	if (!visible.length) return heights;

	const bodyBudget = Math.max(PANE_MIN_BODY_HEIGHT * visible.length, availableHeight - PANE_IDS.length * PANE_HEADER_HEIGHT - chromeHeight);
	const requestedTotal = visible.reduce((sum, id) => sum + heights[id], 0);
	if (requestedTotal < bodyBudget) {
		// 仅当只有一个 pane 可见时才把剩余空间灌入该 pane（保持 VS Code SCM 视图行为）；
		// 多个 pane 同时可见时保持各自请求高度，多余空间由抽屉底部自然留白，
		// 避免第一个 pane 过度膨胀把后续 pane 挤出可视区。
		if (visible.length === 1) {
			heights[visible[0]] += bodyBudget - requestedTotal;
		}
		return heights;
	}
	if (requestedTotal === bodyBudget) return heights;

	const minimumTotal = PANE_MIN_BODY_HEIGHT * visible.length;
	const distributable = Math.max(0, bodyBudget - minimumTotal);
	const requestedAboveMinimum = visible.reduce((sum, id) => sum + Math.max(0, heights[id] - PANE_MIN_BODY_HEIGHT), 0);
	for (const id of visible) {
		const requested = Math.max(0, heights[id] - PANE_MIN_BODY_HEIGHT);
		heights[id] = PANE_MIN_BODY_HEIGHT + (requestedAboveMinimum > 0 ? Math.round((distributable * requested) / requestedAboveMinimum) : 0);
	}
	return heights;
}

export function adjacentVisiblePane(open: PaneOpenState, pane: PaneId, direction: -1 | 1): PaneId | null {
	const start = PANE_IDS.indexOf(pane);
	for (let index = start + direction; index >= 0 && index < PANE_IDS.length; index += direction) {
		const candidate = PANE_IDS[index];
		if (open[candidate]) return candidate;
	}
	return null;
}

export function paneStateStorageKey(projectId: string, repoScopeKey: string, layout: GitPanelLayoutMode = "full"): string {
	// 多仓同时挂载时，项目级 key 会让其中一个面板覆盖另一个的折叠和高度偏好。
	// historyOnly 必须与各仓 changesOnly 隔离，否则共享 Graph 会把某个仓的折叠态写回去。
	const suffix = layout === "full" ? "v4" : `v4-${layout}`;
	return `pideck:git-panel:${projectId}:${encodeURIComponent(repoScopeKey)}:pane-state:${suffix}`;
}

export function defaultPaneState(): PaneState {
	return {
		heights: { changes: 100, graph: 200, compare: 160 },
		open: { changes: true, graph: false, compare: false },
	};
}

export function readPaneState(projectId: string, repoScopeKey: string, layout: GitPanelLayoutMode = "full"): PaneState {
	const fallback = defaultPaneState();
	try {
		const raw = localStorage.getItem(paneStateStorageKey(projectId, repoScopeKey, layout));
		if (!raw) return fallback;
		const value = JSON.parse(raw) as Partial<PaneState>;
		const heights = PANE_IDS.reduce((result, id) => {
			const height = value.heights?.[id];
			result[id] = typeof height === "number" && Number.isFinite(height) ? Math.max(PANE_MIN_BODY_HEIGHT, Math.round(height)) : fallback.heights[id];
			return result;
		}, {} as PaneHeights);
		const open = PANE_IDS.reduce((result, id) => {
			result[id] = typeof value.open?.[id] === "boolean" ? value.open[id] : fallback.open[id];
			return result;
		}, {} as PaneOpenState);
		return { heights, open };
	} catch {
		return fallback;
	}
}
