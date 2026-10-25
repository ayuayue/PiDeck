import { useAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { AddFavoriteInput, FavoriteEntry } from "../../../shared/types";
import { favoriteEntriesAtom } from "../atoms/favorites-atoms";
import { collectFavoritedMessageKeys, findMessageFavorite } from "../components/favorites/favoriteIdentity";
import { applyFavoriteOrder } from "../components/favorites/favoriteFilters";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";

/** 首次读取去重：时间线、右键菜单钩子、收藏页可能同时挂载，只发一次 favorites:list。 */
let loadInFlight: Promise<FavoriteEntry[]> | null = null;

function loadFavoritesOnce(): Promise<FavoriteEntry[]> {
	loadInFlight ??= desktopApi.favorites.list().finally(() => {
		loadInFlight = null;
	});
	return loadInFlight;
}

export type FavoriteActions = {
	/** null = 还没读到主进程列表（首次挂载时异步拉取）。 */
	entries: FavoriteEntry[] | null;
	/** 已收藏的「整条消息」身份键集合（sessionId::messageId），供入口显示/切换已收藏态。 */
	favoritedMessageKeys: ReadonlySet<string>;
	refresh: () => Promise<void>;
	/** 收藏成功返回条目（入口用于判断是否要收起浮层），失败返回 null 并 toast。 */
	addFavorite: (input: AddFavoriteInput) => Promise<FavoriteEntry | null>;
	removeFavorite: (favoriteId: string) => Promise<boolean>;
	/** 批量删除：一次 IPC 落盘，返回实际删除条数（未知 id 忽略）；失败返回 0 并 toast。 */
	removeFavorites: (favoriteIds: readonly string[]) => Promise<number>;
	/**
	 * 拖拽排序：传入新的完整顺序（或被过滤视图下的可见顺序，隐藏条目会保持原槽位）。
	 * 先乐观更新 atom 让卡片立即落位，再交给主进程落盘；失败回滚到主进程列表。
	 */
	reorderFavorites: (orderedIds: string[]) => Promise<void>;
	/**
	 * 整条消息收藏开关：同一条消息（sessionId + messageId）已有收藏则删除，否则新增。
	 * 没有 messageId（live 流式正文）无法去重，退化为「只新增」。
	 */
	toggleMessageFavorite: (input: AddFavoriteInput) => Promise<boolean>;
};

/**
 * 收藏域的读写入口（页面 / 右键菜单 / 划选浮层 / 回合动作条共用）。
 *
 * 数据源单一：列表存在 favoriteEntriesAtom，写入成功后原地更新 atom，任何入口收藏/取消收藏都能
 * 让已打开的收藏页与入口的「已收藏」状态立即同步；首次挂载才向主进程拉一次。
 * 失败一律 toast，不抛出——收藏是旁路能力，不能打断复制/提问等主流程。
 */
export function useFavorites(): FavoriteActions {
	const [entries, setEntries] = useAtom(favoriteEntriesAtom);
	// 切换动作要读「最新收藏表」，但回调本身必须保持引用稳定（TurnRow 自定义 memo 不比较回调）。
	const entriesRef = useRef<FavoriteEntry[] | null>(null);
	entriesRef.current = entries;

	const refresh = useCallback(async () => {
		try {
			setEntries(await loadFavoritesOnce());
		} catch {
			// 读失败保留已有列表：收藏页宁可显示上次内容，也不要清空成「没有收藏」。
		}
	}, [setEntries]);

	useEffect(() => {
		if (entries === null) void refresh();
	}, [entries, refresh]);

	const favoritedMessageKeys = useMemo(() => collectFavoritedMessageKeys(entries ?? []), [entries]);

	const addFavorite = useCallback(
		async (input: AddFavoriteInput): Promise<FavoriteEntry | null> => {
			try {
				const entry = await desktopApi.favorites.add(input);
				setEntries((current) => [entry, ...(current ?? [])]);
				showNotice(t("favorites.saved"), 1200);
				return entry;
			} catch {
				showNotice(t("favorites.saveFailed"), 2400, "error");
				return null;
			}
		},
		[setEntries],
	);

	const removeFavorite = useCallback(
		async (favoriteId: string): Promise<boolean> => {
			try {
				const removed = await desktopApi.favorites.remove(favoriteId);
				if (removed) setEntries((current) => (current ?? []).filter((entry) => entry.id !== favoriteId));
				showNotice(removed ? t("favorites.removed") : t("favorites.removeFailed"), removed ? 1200 : 2400, removed ? undefined : "error");
				return removed;
			} catch {
				showNotice(t("favorites.removeFailed"), 2400, "error");
				return false;
			}
		},
		[setEntries],
	);

	const removeFavorites = useCallback(
		async (favoriteIds: readonly string[]): Promise<number> => {
			const ids = [...new Set(favoriteIds)].filter((id) => typeof id === "string" && id.trim().length > 0);
			if (ids.length === 0) return 0;
			try {
				const removed = await desktopApi.favorites.removeMany(ids);
				const removedSet = new Set(ids);
				// 即使主进程报告 0（都已被并发删掉）也从本地列表剔除：用户看到的选区就该消失。
				// 这种情况不算失败，不弹错误提示——列表已经和磁盘一致了。
				setEntries((current) => (current ?? []).filter((entry) => !removedSet.has(entry.id)));
				if (removed > 0) showNotice(t("favorites.batchRemoved", { count: removed }), 1600);
				return removed;
			} catch {
				showNotice(t("favorites.removeFailed"), 2400, "error");
				return 0;
			}
		},
		[setEntries],
	);

	const reorderFavorites = useCallback(
		async (orderedIds: string[]): Promise<void> => {
			const current = entriesRef.current ?? [];
			const next = applyFavoriteOrder(current, orderedIds);
			// 乐观更新：松手后卡片立即按新顺序显示，不等 IPC 往返。
			setEntries(next);
			try {
				// 主进程返回权威列表（可能已剔除并发删除的条目）；顺序写盘成功后再对齐一次。
				setEntries(await desktopApi.favorites.reorder(next.map((entry) => entry.id)));
			} catch {
				showNotice(t("favorites.reorderFailed"), 2400, "error");
				await refresh();
			}
		},
		[refresh, setEntries],
	);

	const toggleMessageFavorite = useCallback(
		async (input: AddFavoriteInput): Promise<boolean> => {
			const existing = findMessageFavorite(entriesRef.current ?? [], input.sessionId ?? null, input.messageId ?? null);
			if (existing) return removeFavorite(existing.id);
			return (await addFavorite(input)) !== null;
		},
		[addFavorite, removeFavorite],
	);

	return { entries, favoritedMessageKeys, refresh, addFavorite, removeFavorite, removeFavorites, reorderFavorites, toggleMessageFavorite };
}
