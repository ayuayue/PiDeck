import type { WorkspaceContentOpenMode } from "../../../shared/types";

/**
 * 中间栏「谁在前台」的纯判定：会话面 与 文件/Git Diff 内容面互斥。
 *
 * 之所以只有这两条规则：中间栏此前只有「内容面在不在」（activeTab / gitDrawerDiff），
 * 于是 files 面 maximize 之后点会话 Tab / 点侧栏当前会话行都只改 currentSessionId，
 * 内容面继续铺满、点上去毫无反应。前台面是补上的那份状态。
 */
export type WorkbenchFront = "session" | "content";

export type WorkbenchSurfaceState = {
	/** 简洁模式：内容面靠 expanded 开关撑满会话列，没有 split/maximize 的让位语义 */
	simpleMode: boolean;
	/** 内容面存在（文件 Tab 或 Git Diff）——存在不等于在前台 */
	hasContent: boolean;
	/** 内容面当前布局 */
	layout: WorkspaceContentOpenMode;
	/** 此刻谁在前台 */
	front: WorkbenchFront;
};

/**
 * 内容面是否让位给会话。
 *
 * 只发生在 maximize：那时会话面板已 collapse(0)，让位才有意义；split 下两面同屏，
 * 折叠反而会把用户正在对照的文件藏起来。
 */
export function workbenchContentFolded(state: WorkbenchSurfaceState): boolean {
	return !state.simpleMode && state.hasContent && state.front === "session" && state.layout === "maximize";
}

/** 工作台此刻是否呈现内容面（存在 且 没有让位）。 */
export function workbenchShowsContent(state: WorkbenchSurfaceState): boolean {
	return state.hasContent && !workbenchContentFolded(state);
}

/**
 * 内容面 Tab 的选中态：让位给会话时整个内容面都在后台，任何内容 Tab 都不能画选中态
 * （否则会话 Tab 与文件 Tab 同时像当前 Tab）。`matchesActive` 由各 Tab 自己算。
 */
export function workbenchTabActive(folded: boolean, matchesActive: boolean): boolean {
	return !folded && matchesActive;
}
