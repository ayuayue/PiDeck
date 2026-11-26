import { atom } from "jotai";
import type { ChatMessage, SessionMessagePage } from "../../../shared/types";
import { jumpEntryKey } from "../../../shared/sessionJumpAnchor";
import { mergeInterleavedHistory } from "../components/session/timeline/mergeHistoryWindow";
import type { SessionMessageCacheEntry } from "./session-atoms-types";
import { sessionMessagesCacheAtom } from "./session-state-atoms";
import { allocateSessionMessageOutlineRevision } from "./session-message-cache-atoms";
import { DISK_HISTORY_MESSAGE_LIMIT, isSameSessionFileGeneration } from "./session-history-atoms";

/** 与事务同一实例的缓存原子：调用方据此准备初值或读取结果，避免出现第二份缓存对象。 */
export { sessionMessagesCacheAtom } from "./session-state-atoms";
import { estimateSessionCacheEntryBytes } from "./session-cache-policy";
import { findLastUserMessageIndex } from "./outlineRevision";
import { releaseSessionOutlineProjection } from "./outlineProjectionCache";

/** 不相邻页没有重叠锚点，必须按本次读页附带的同快照索引排序。 */
function orderJumpHistory(messages: ChatMessage[], entryOrder: string[] | undefined): ChatMessage[] {
	if (!entryOrder) return messages;
	const order = new Map(entryOrder.map((id, index) => [id, index]));
	let next = Number.POSITIVE_INFINITY;
	const ranked = messages.map((message) => ({ message, rank: order.get(jumpEntryKey(message)) }));
	for (let index = ranked.length - 1; index >= 0; index -= 1) {
		const item = ranked[index];
		if (item.rank !== undefined) next = item.rank;
		else item.rank = next - 0.5;
	}
	return ranked.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity)).map((item) => item.message);
}
/** 保留目标页；预算只回收其它旧页，不能刚取回目标又把目标裁掉。单轮超预算沿用完整轮契约。 */
function capJumpHistory(messages: ChatMessage[], page: SessionMessagePage): ChatMessage[] {
	let drop = messages.length - Math.max(DISK_HISTORY_MESSAGE_LIMIT, page.messages.length);
	if (drop <= 0) return messages;
	const retained = new Set(page.messages.map(jumpEntryKey));
	return messages.filter((message) => {
		if (drop > 0 && !retained.has(jumpEntryKey(message))) {
			drop -= 1;
			return false;
		}
		return true;
	});
}

/**
 * 跳转只增加只读历史，不接管实时窗口。读取最新缓存后原子合并，不能把请求前的闭包快照
 * force 写成 disk：那会抹掉等待期间的新输出、windowStart/cardCount，下一帧增量再按错误下标拼接。
 */
export function mergeJumpPageWithCurrent(current: SessionMessageCacheEntry | undefined, page: SessionMessagePage, requestedVersion?: string): SessionMessageCacheEntry | undefined {
	if (!current) return undefined;
	const currentVersion = current.source === "runtime" ? current.history?.version : current.page?.indexVersion;
	if (requestedVersion && currentVersion && !isSameSessionFileGeneration(requestedVersion, currentVersion)) return undefined;
	if (requestedVersion && page.indexVersion && !isSameSessionFileGeneration(requestedVersion, page.indexVersion)) return undefined;
	if (current.source === "runtime") {
		const liveKeys = new Set(current.messages.map(jumpEntryKey));
		const history = capJumpHistory(
			orderJumpHistory(
				mergeInterleavedHistory(page.messages, current.history?.messages ?? []).filter((message) => !liveKeys.has(jumpEntryKey(message))),
				page.entryOrder,
			),
			page,
		);
		const previousBefore = current.history?.nextBefore;
		const nextBefore = previousBefore === null || page.nextBefore === null ? null : Math.min(previousBefore ?? Infinity, page.nextBefore);
		return { ...current, history: { messages: history, nextBefore, ...(typeof history[0]?.meta?.entryId === "string" ? { nextBeforeEntryId: history[0].meta.entryId } : {}), version: currentVersion ?? page.indexVersion } };
	}
	const messages = capJumpHistory(orderJumpHistory(mergeInterleavedHistory(page.messages, current.messages), page.entryOrder), page);
	const previousBefore = current.page?.nextBefore;
	const nextBefore = previousBefore === null || page.nextBefore === null ? null : Math.min(previousBefore ?? Infinity, page.nextBefore);
	return { ...current, messages, page: { total: Math.max(current.page?.total ?? 0, page.total), nextBefore, ...(typeof messages[0]?.meta?.entryId === "string" ? { nextBeforeEntryId: messages[0].meta.entryId } : {}), indexVersion: currentVersion ?? page.indexVersion } };
}

/** 跳转提交不是消息全量替换；Jotai事务在写入时读最新值，流式更新不会被过期响应吃掉。 */
export const mergeSessionJumpPageAtom = atom(null, (get, set, input: { sessionId: string; page: SessionMessagePage; requestedVersion?: string }): boolean => {
	const cache = get(sessionMessagesCacheAtom);
	const next = mergeJumpPageWithCurrent(cache[input.sessionId], input.page, input.requestedVersion);
	if (!next) return false;
	releaseSessionOutlineProjection(input.sessionId);
	set(sessionMessagesCacheAtom, { ...cache, [input.sessionId]: { ...next, updatedAt: Date.now(), outlineRevision: allocateSessionMessageOutlineRevision(), outlineLastUserIndex: findLastUserMessageIndex(next.messages), bytes: estimateSessionCacheEntryBytes(next.messages, next.history?.messages) } });
	return true;
});
