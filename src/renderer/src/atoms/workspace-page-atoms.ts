import { atom } from "jotai";
import { closeWorkspacePage, deactivateWorkspacePage, EMPTY_WORKSPACE_PAGE_TAB_STATE, openWorkspacePage, type WorkspacePageId, type WorkspacePageTabState } from "../utils/workspacePageTabs";

/**
 * 页面式工作区（定时任务 / 智能体）的 Tab 状态：Tab 列表 + 当前呈现页面。
 *
 * 页面呈现挂在会话列上（覆盖层），Tab 挂在会话 Tab 栏；状态只存内存——
 * 关闭应用后重新打开是全新会话视图，不需要持久化（与会话 Tab 列表不同）。
 */
export const workspacePageTabStateAtom = atom<WorkspacePageTabState>(EMPTY_WORKSPACE_PAGE_TAB_STATE);

/** 已打开的页面 Tab（只读派生）。 */
export const openWorkspacePageIdsAtom = atom((get) => get(workspacePageTabStateAtom).tabs);

/** 当前呈现的页面；null = 呈现会话（只读派生）。 */
export const activeWorkspacePageAtom = atom((get) => get(workspacePageTabStateAtom).active);

/** 打开/激活页面 Tab（侧栏入口与 Tab 点击共用）。 */
export const openWorkspacePageAtom = atom(null, (_get, set, pageId: WorkspacePageId) => {
	set(workspacePageTabStateAtom, (state) => openWorkspacePage(state, pageId));
});

/** 切回会话：页面 Tab 保留，只失活。 */
export const deactivateWorkspacePageAtom = atom(null, (_get, set) => {
	set(workspacePageTabStateAtom, (state) => deactivateWorkspacePage(state));
});

/** 关闭页面 Tab（页面子树随之卸载）。 */
export const closeWorkspacePageAtom = atom(null, (_get, set, pageId: WorkspacePageId) => {
	set(workspacePageTabStateAtom, (state) => closeWorkspacePage(state, pageId));
});
