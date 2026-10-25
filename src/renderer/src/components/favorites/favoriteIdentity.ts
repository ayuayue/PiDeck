import type { FavoriteEntry } from "../../../../shared/types";

/**
 * 「整条消息收藏」的身份键：sessionId + messageId。
 *
 * 为什么需要：同一入口（回合星标 / 右键菜单）要能识别「已经收藏过」并切换成取消收藏，
 * 再去重置「是不是已收藏」只看收藏表里的键集合；用快照正文做身份会在流式/编辑后误判。
 * 没有 messageId（live 流式正文）的收藏无法稳定去重，返回 null（只允许新增）。
 */
export function favoriteMessageKey(sessionId: string | null | undefined, messageId: string | null | undefined): string | null {
	if (!messageId) return null;
	return `${sessionId ?? ""}::${messageId}`;
}

/** 收藏列表里所有「整条消息」收藏的键集合（渲染层 lightweight index，供入口显示已收藏态）。 */
export function collectFavoritedMessageKeys(entries: readonly FavoriteEntry[]): Set<string> {
	const keys = new Set<string>();
	for (const entry of entries) {
		if (entry.kind !== "message") continue;
		const key = favoriteMessageKey(entry.sessionId, entry.messageId);
		if (key) keys.add(key);
	}
	return keys;
}

/** 按消息身份查找已有收藏（同一消息只认第一条：历史重复数据也不影响切换语义）。 */
export function findMessageFavorite(entries: readonly FavoriteEntry[], sessionId: string | null | undefined, messageId: string | null | undefined): FavoriteEntry | undefined {
	const key = favoriteMessageKey(sessionId, messageId);
	if (!key) return undefined;
	return entries.find((entry) => entry.kind === "message" && favoriteMessageKey(entry.sessionId, entry.messageId) === key);
}
