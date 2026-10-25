/**
 * 收藏 IPC：只做边界适配（入参校验 / 日志），业务在 FavoritesStore。
 *
 * 渲染层数据一律不可信：正文按共享上限挡超长载荷，kind/role 走白名单，
 * 其余元信息按上限收窄。日志只记 id / 形态 / 来源会话 id，**绝不落正文**（用户内容）。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { FAVORITE_ENTRY_LIMIT, FAVORITE_META_MAX_CHARS, type FavoriteEntry } from "../../shared/types";
import type { FavoritesStore } from "../favorites/FavoritesStore";
import { parseAddFavoriteInput } from "../favorites/favoriteInput";
import type { AppLogger } from "../logging/AppLogger";

export type FavoritesIpcDeps = {
	store: FavoritesStore;
	appLogger: AppLogger;
};

const LOG_SCOPE = "favorites";

function parseFavoriteId(value: unknown): string {
	const id = typeof value === "string" ? value.trim() : "";
	if (!id || id.length > FAVORITE_META_MAX_CHARS) throw new Error("Invalid favorite id");
	return id;
}

/**
 * 批量 id 入参（批量删除 / 排序）：上限与存储上限一致；未知/重复 id 交给 store 过滤
 * （渲染层可能拿着旧快照，其中包含刚被删除的收藏）。
 */
function parseFavoriteIdList(value: unknown): string[] {
	if (!Array.isArray(value)) throw new Error("Invalid favorite id list");
	if (value.length > FAVORITE_ENTRY_LIMIT) throw new Error("Favorite id list is too long");
	return value.map((entry) => parseFavoriteId(entry));
}

/** 注册收藏 IPC；返回清理函数（卸载时摘掉全部 handler）。 */
export function registerFavoritesIpc(deps: FavoritesIpcDeps): () => void {
	const { store, appLogger } = deps;

	ipcMain.handle(ipcChannels.favoritesList, async (): Promise<FavoriteEntry[]> => {
		return store.list();
	});

	ipcMain.handle(ipcChannels.favoritesAdd, async (_event, input: unknown): Promise<FavoriteEntry> => {
		const parsed = parseAddFavoriteInput(input);
		const entry = await store.add(parsed);
		// 只记形态与来源：正文是用户内容，不进日志。
		void appLogger.info(LOG_SCOPE, "Saved favorite", { favoriteId: entry.id, kind: entry.kind, sessionId: entry.sessionId });
		return entry;
	});

	ipcMain.handle(ipcChannels.favoritesRemove, async (_event, favoriteId: unknown): Promise<boolean> => {
		const id = parseFavoriteId(favoriteId);
		const removed = await store.remove(id);
		void appLogger.info(LOG_SCOPE, "Removed favorite", { favoriteId: id, removed });
		return removed;
	});

	ipcMain.handle(ipcChannels.favoritesRemoveMany, async (_event, favoriteIds: unknown): Promise<number> => {
		const ids = parseFavoriteIdList(favoriteIds);
		const removed = await store.removeMany(ids);
		void appLogger.info(LOG_SCOPE, "Removed favorites", { requested: ids.length, removed });
		return removed;
	});

	ipcMain.handle(ipcChannels.favoritesReorder, async (_event, favoriteIds: unknown): Promise<FavoriteEntry[]> => {
		const order = parseFavoriteIdList(favoriteIds);
		const entries = await store.reorder(order);
		void appLogger.info(LOG_SCOPE, "Reordered favorites", { count: entries.length });
		return entries;
	});

	return () => {
		ipcMain.removeHandler(ipcChannels.favoritesList);
		ipcMain.removeHandler(ipcChannels.favoritesAdd);
		ipcMain.removeHandler(ipcChannels.favoritesRemove);
		ipcMain.removeHandler(ipcChannels.favoritesRemoveMany);
		ipcMain.removeHandler(ipcChannels.favoritesReorder);
	};
}
