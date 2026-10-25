import type { FavoriteEntry, FavoriteKind } from "../../../../shared/types";

/** 收藏页的筛选维度：全部 / 只回复 / 只划选片段。 */
export type FavoriteFilter = "all" | FavoriteKind;

/**
 * 收藏列表的本地筛选（纯函数，可离开 React 单测）：
 * query 同时匹配正文与来源会话标题（不区分大小写），filter 按 kind 收窄。
 */
export function filterFavorites(entries: readonly FavoriteEntry[], query: string, filter: FavoriteFilter): FavoriteEntry[] {
	const keyword = query.trim().toLowerCase();
	return entries.filter((entry) => {
		if (filter !== "all" && entry.kind !== filter) return false;
		if (!keyword) return true;
		if (entry.text.toLowerCase().includes(keyword)) return true;
		return (entry.sessionTitle ?? "").toLowerCase().includes(keyword);
	});
}

/**
 * 把拖拽后的可见顺序套回完整列表（纯函数）：可见条目按新顺序依次占据它们原本的槽位，
 * 被搜索/筛选隐藏的条目留在原位不动。
 *
 * 为什么不让列表直接整体重排：收藏页搜索时只看得见一部分，若按「可见顺序 + 隐藏追加」重排，
 * 隐藏条目会在用户搜索状态下被无声挪到末尾，清空搜索后顺序已经变了。
 * 无过滤时可见顺序就是完整顺序，本函数等价于按 ids 重排。
 */
export function applyFavoriteOrder(entries: readonly FavoriteEntry[], orderedIds: readonly string[]): FavoriteEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	// 未知 id（已被并发删除）直接跳过：主进程列表才是权威，落盘时会把它们剔掉。
	const ordered = orderedIds.map((id) => byId.get(id)).filter((entry): entry is FavoriteEntry => entry !== undefined);
	if (ordered.length === 0) return [...entries];
	const visibleIds = new Set(ordered.map((entry) => entry.id));
	let cursor = 0;
	return entries.map((entry) => (visibleIds.has(entry.id) ? (ordered[cursor++] as FavoriteEntry) : entry));
}
