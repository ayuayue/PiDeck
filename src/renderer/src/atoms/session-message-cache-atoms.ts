/**
 * 会话消息缓存的**写入路径**：整快照写入、revision 守卫、LRU + 字节预算淘汰、
 * 引导页虚拟会话搬移、单会话 selectAtom 隔离、outline 修订号分配。
 *
 * 从 `session-atoms.ts` 原样搬家而来（拆分，行为零变化）。容器
 *（sessionMessagesCacheAtom / LRU / 记录表）在 `session-state-atoms.ts`，
 * 历史分页在 `session-history-atoms.ts`；本模块只负责写。
 * 入口 `session-atoms.ts` 用 `export *` 转出，所有既有 import 不变。
 */
import { atom } from "jotai";
import { atomFamily, selectAtom } from "jotai/utils";
import type { ChatMessage, SessionMessagePage } from "../../../shared/types";
import { findLastUserMessageIndex } from "./outlineRevision";
import { releaseSessionOutlineProjection } from "./outlineProjectionCache";
import type { SessionMessageCacheEntry } from "./session-atoms-types";
import { SESSION_CACHE_CLOSED_ENTRY_BYTE_BUDGET, SESSION_MESSAGE_CACHE_LIMIT, estimateSessionCacheEntryBytes, planSessionCacheTrim, selectByteBudgetEvictions, selectRetainedCacheEntryIds, selectSessionCacheProtectedIds } from "./session-cache-policy";
import { currentSessionIdAtom, sessionMessageLruAtom, sessionMessagesCacheAtom, sessionRecordsAtom, sessionTabIdsAtom, stoppedSessionIdsAtom } from "./session-state-atoms";

// Cache entries can be evicted and recreated, so outline revisions must not restart per session.
let nextSessionMessageOutlineRevision = 0;
export function allocateSessionMessageOutlineRevision(): number {
	nextSessionMessageOutlineRevision += 1;
	return nextSessionMessageOutlineRevision;
}
/**
 * 单会话消息缓存条目（selectAtom 隔离）：其它会话的消息到达/分页/失效
 * 都整体重建 cache 对象，但本会话条目引用不变 → Object.is 相等 → 订阅者不重渲染。
 * 2026-10 性能修复：此前 controller 直接订全局缓存，分屏/多开时
 * 任一会话的流式消息或分页都会拖着重渲染所有分屏栏。
 */
export const sessionMessageCacheBySessionIdAtomFamily = atomFamily((sessionId: string) => selectAtom(sessionMessagesCacheAtom, (cache) => cache[sessionId], Object.is));
export const cacheSessionMessagesAtom = atom(
	null,
	(
		get,
		set,
		input: {
			sessionId: string;
			messages: ChatMessage[];
			// "remote"：远端会话文件经主进程有界窗口读回的历史（游标是字节偏移，与本地磁盘页不同）；
			// 本地页与 runtime 更新只写 disk/runtime，这里放宽是为了让远端历史页能原样转存。
			source: "disk" | "runtime" | "remote";
			expectedRevision?: number;
			page?: Pick<SessionMessagePage, "total" | "nextBefore">;
			/** runtime 窗口协议字段（2026-08 激活分页） */
			windowStart?: number;
			/** 窗口段头部的系统摘要卡片数（全量 flush 推导，增量合并偏移用） */
			cardCount?: number;
			/** 窗口首条消息的文件消息下标（2026-11）：窗口缺 entryId 时作为首次补历史的数值游标 */
			windowStartFilePos?: number;
			history?: SessionMessageCacheEntry["history"];
			/** Runtime tail updates can opt out only after verifying no user checkpoint changed. */
			outlineChanged?: boolean;
			/**
			 * 强制用 disk 快照覆盖当前缓存（含 runtime 源）。
			 * 编辑/删除/重发改 JSONL 并停掉 Agent 后必须走这条：否则「disk 条数不多于 runtime」守卫会丢掉刚改过的文件。
			 */
			force?: boolean;
		},
	) => {
		const historySource = input.source === "disk" && get(sessionRecordsAtom)[input.sessionId]?.locator?.kind === "ssh" ? ("remote" as const) : input.source;
		const cache = get(sessionMessagesCacheAtom);
		// 远端记录的「磁盘页」其实是远端有界窗口读回的结果：来源要标成 "remote"，否则下游那条
		// 「超限裁剪时把数值游标前移」的算术会把字节偏移算坏（静默跳内容）。
		const current = cache[input.sessionId];
		// Revision 守卫仅在「上一次与本次均为 disk 来源」时生效——
		// 防止慢一拍的历史分页响应覆盖后续新快照。
		//
		// 为什么不能把此守卫扩大到 runtime 来源：
		// - runtime 写会递增 revision，disk 写不递增 revision
		// - 匿名会话（无 filePath）runtime 消息只从 runtime 事件进 cache，disk 读取永远返回 []
		// - 切走→切回时 disk 空响应会因 revision 相等直接覆盖掉 runtime 已写入的消息，
		//   导致切回显示空引导页
		//
		// force 必须豁免：编辑/删除/重发后的 reloadTimelineFromDisk 恒传 expectedRevision: 0
		// （调用方不追踪 revision），而运行过的会话 disk 缓存继承 runtime 递增的 revision，
		// 首次 mutation 后 current.source 已切到 disk 但 revision 不清零——若不豁免，
		// 之后的每一次编辑/删除都会被守卫吞掉：文件已改、时间线永不刷新（「删了没反应」）。
		// force 语义即「disk 是权威快照」，必须无条件生效。
		if (!input.force && input.expectedRevision !== undefined && input.source === "disk" && current?.source === "disk" && (current.revision ?? 0) !== input.expectedRevision) {
			return false;
		}

		// 防止空/较少 disk 响应清空或退化已有 runtime 缓存（匿名会话切回场景）：
		// 当 disk 来源的消息数 ≤ cache 中已有消息数时，视为 stale 空读或退化读，直接跳过；
		// 仅当 disk 携带严格更多的消息（如补齐窗口前的历史）时才允许写入。
		// force：用户刚改过 JSONL（编辑/删除/重发），disk 才是权威，必须覆盖 runtime。
		if (!input.force && input.source === "disk" && current?.source !== "disk" && current?.messages?.length >= input.messages.length) {
			return false;
		}
		const outlineChanged = input.outlineChanged !== false;
		const shouldReplaceOutlineProjection = outlineChanged || current?.outlineRevision === undefined;
		const outlineRevision = shouldReplaceOutlineProjection ? allocateSessionMessageOutlineRevision() : current.outlineRevision;
		const outlineLastUserIndex = outlineChanged ? findLastUserMessageIndex(input.messages) : (current?.outlineLastUserIndex ?? findLastUserMessageIndex(input.messages));
		if (shouldReplaceOutlineProjection) releaseSessionOutlineProjection(input.sessionId);
		const revision = input.source === "runtime" ? (current?.revision ?? 0) + 1 : (current?.revision ?? 0);
		// runtime 窗口语义（2026-08 激活分页）：entry 每次整体重建，调用方必须显式给出
		// windowStart/history（undefined = 清除，如版本失效丢前缀）；disk 来源无窗口概念。
		const storedHistory = input.source === "runtime" ? input.history : undefined;
		const nextCache = {
			...cache,
			[input.sessionId]: {
				messages: input.messages,
				revision,
				source: historySource,
				updatedAt: Date.now(),
				outlineRevision,
				outlineLastUserIndex,
				// 条目驻留字节估算（2026-10 内存轮）：随本次重建刷新，供已关闭 Tab
				// 条目的字节预算淘汰用（下方 selectByteBudgetEvictions）。
				bytes: estimateSessionCacheEntryBytes(input.messages, storedHistory?.messages),
				// page 只属于 disk/remote 来源（runtime 窗口走下方 windowStart/history）；
				// historySource 已把远端 disk 改写成 "remote"，不能再用 input.source 判。
				...(historySource !== "runtime" && input.page ? { page: input.page } : {}),
				...(input.source === "runtime"
					? {
							windowStart: input.windowStart && input.windowStart > 0 ? input.windowStart : undefined,
							history: storedHistory,
							// 卡片数只在全量 flush 推导（增量 flush 不携带 → 保留旧值，合并偏移依赖它）
							...(typeof input.cardCount === "number" ? { cardCount: input.cardCount } : {}),
							// 未显式提供时保留旧值（增量 flush 不携带该字段，不应清掉有效游标）
							...(typeof input.windowStartFilePos === "number" ? { windowStartFilePos: input.windowStartFilePos } : {}),
						}
					: {}),
			},
		};
		const lru = [input.sessionId, ...get(sessionMessageLruAtom).filter((id) => id !== input.sessionId)];
		// LRU 裁剪提保护：打开着 Tab 的会话（预览/常驻）优先保留，其余按最近写入补足名额。
		// 打开中的会话若被挤出，切回时缓存条目消失 → 重读盘 + 闪「正在加载历史」骨架
		// （生图等无 runtime 事件持续 touch 的会话最易中招，2026 用户反馈）。
		const openedTabs = new Set(get(sessionTabIdsAtom));
		let retainedIds = selectRetainedCacheEntryIds(lru, openedTabs, SESSION_MESSAGE_CACHE_LIMIT);
		// 字节预算（closed-only，2026-10 内存轮）：条目数封顶不管内容体积，超预算的
		// 已关闭条目按最旧先淘汰；旧形状条目（本版本前写入、无 bytes）在判定前补算
		// （落成新对象，不原地改旧缓存里的引用）。
		const bytesById = new Map<string, number>();
		for (const id of retainedIds) {
			const entry = nextCache[id];
			if (!entry) continue;
			if (entry.bytes === undefined) {
				nextCache[id] = { ...entry, bytes: estimateSessionCacheEntryBytes(entry.messages, entry.history?.messages) };
			}
			bytesById.set(id, nextCache[id].bytes ?? 0);
		}
		const byteTrim = selectByteBudgetEvictions(retainedIds, bytesById, openedTabs, SESSION_CACHE_CLOSED_ENTRY_BYTE_BUDGET);
		retainedIds = byteTrim.retained;
		for (const cachedSessionId of Object.keys(nextCache)) {
			if (!retainedIds.includes(cachedSessionId)) {
				delete nextCache[cachedSessionId];
				releaseSessionOutlineProjection(cachedSessionId);
			}
		}
		set(sessionMessagesCacheAtom, nextCache);
		set(sessionMessageLruAtom, retainedIds);
		return true;
	},
);
export const touchSessionMessagesAtom = atom(null, (get, set, sessionId: string) => {
	if (!get(sessionMessagesCacheAtom)[sessionId]) return;
	set(sessionMessageLruAtom, [sessionId, ...get(sessionMessageLruAtom).filter((id) => id !== sessionId)].slice(0, SESSION_MESSAGE_CACHE_LIMIT));
});
/**
 * 非写入时机的缓存裁剪（issue #519）：运行时停止、切走会话、关 Tab 时立刻按保护集回收，
 * 不必等下一次缓存写入。运行中会话的打开 Tab 仍受无条件保护（语义不变）。
 * 返回是否真的淘汰了条目，便于调用方/测试断言。
 */
export const trimSessionMessageCacheAtom = atom(null, (get, set) => {
	const cache = get(sessionMessagesCacheAtom);
	const cacheIds = Object.keys(cache);
	if (cacheIds.length === 0) return false;
	const bytesById = new Map<string, number>();
	for (const id of cacheIds) {
		const entry = cache[id];
		bytesById.set(id, entry.bytes ?? estimateSessionCacheEntryBytes(entry.messages, entry.history?.messages));
	}
	const plan = planSessionCacheTrim({
		lruIds: get(sessionMessageLruAtom),
		cacheIds,
		protectedIds: selectSessionCacheProtectedIds({
			tabIds: get(sessionTabIdsAtom),
			stoppedIds: get(stoppedSessionIdsAtom),
			focusedSessionId: get(currentSessionIdAtom),
		}),
		limit: SESSION_MESSAGE_CACHE_LIMIT,
		bytesById,
		closedByteBudget: SESSION_CACHE_CLOSED_ENTRY_BYTE_BUDGET,
	});
	if (plan.evicted.length === 0) return false;
	const nextCache = { ...cache };
	for (const sessionId of plan.evicted) {
		delete nextCache[sessionId];
		releaseSessionOutlineProjection(sessionId);
	}
	set(sessionMessagesCacheAtom, nextCache);
	set(sessionMessageLruAtom, plan.retained);
	return true;
});
/**
 * 引导页虚拟会话首次发送：把乐观写入虚拟会话的用户气泡搬到刚创建的真实会话。
 * 必须是「搬」而不是「拷」——虚拟会话 ID 是 renderer 常量，永不经 removeSessionStateAtom
 * 清理，残留的缓存会在下一次引导页发送时被当作 previousMessages 追加，导致每个新会话
 * 一开始就带着此前所有从引导页发出的消息。目标会话是刚创建的 draft，正常无既有缓存；
 * 有则以 runtime 语义追加，不覆盖。
 */
export const promoteSessionMessagesCacheAtom = atom(null, (get, set, input: { fromSessionId: string; toSessionId: string }) => {
	if (input.fromSessionId === input.toSessionId) return;
	const source = get(sessionMessagesCacheAtom)[input.fromSessionId];
	if (!source) return;
	if (source.messages.length > 0) {
		const existing = get(sessionMessagesCacheAtom)[input.toSessionId]?.messages ?? [];
		set(cacheSessionMessagesAtom, {
			sessionId: input.toSessionId,
			messages: [...existing, ...source.messages],
			source: "runtime",
		});
	}
	releaseSessionOutlineProjection(input.fromSessionId);
	const cache = { ...get(sessionMessagesCacheAtom) };
	delete cache[input.fromSessionId];
	set(sessionMessagesCacheAtom, cache);
	set(
		sessionMessageLruAtom,
		get(sessionMessageLruAtom).filter((id) => id !== input.fromSessionId),
	);
});
