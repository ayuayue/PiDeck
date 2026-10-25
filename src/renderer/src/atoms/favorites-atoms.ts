import { atom } from "jotai";
import type { FavoriteEntry } from "../../../shared/types";
import { closeWorkspacePageAtom, openWorkspacePageAtom, workspacePageTabStateAtom } from "./workspace-page-atoms";

/**
 * 收藏列表（本机快照，顺序即主进程落盘的顺序：新增前插 + 用户拖拽排序）；null = 尚未从主进程读到。
 * 页面与各收藏入口共用这一个 atom：任意入口收藏/删除后列表立即同步，不用整页刷新。
 */
export const favoriteEntriesAtom = atom<FavoriteEntry[] | null>(null);

/** 「收藏」页面 Tab 是否打开（会话 Tab 栏里的页面式工作区，见 workspace-page-atoms）。 */
export const favoritesPageOpenAtom = atom((get) => get(workspacePageTabStateAtom).tabs.includes("favorites"));

/**
 * 详情抽屉是否打开。页面级的 Esc（关 Tab）要据此让路：抽屉自己响应 Esc 关自己，
 * 否则一次 Esc 会同时关掉抽屉和整个收藏页。
 */
export const favoriteDetailOpenAtom = atom(false);

/** 打开「收藏」页面 Tab（侧栏入口 / 命令面板共用）。 */
export const openFavoritesPageAtom = atom(null, (_get, set) => {
	set(openWorkspacePageAtom, "favorites");
});

/** 关闭「收藏」页面 Tab（页面子树卸载，下次打开回到列表顶部）。 */
export const closeFavoritesPageAtom = atom(null, (_get, set) => {
	set(closeWorkspacePageAtom, "favorites");
});
