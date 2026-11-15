/**
 * 会话 / 目录 / 消息缓存的**状态容器**与目录写入动作。
 *
 * 从 `session-atoms.ts` 原样搬家而来（拆分，行为零变化）：记录表、项目索引、当前会话、
 * Tab 栏、已停止标记、消息缓存与 LRU、加载态，以及 replace/upsert/setLoadState 这类
 * 不依赖运行时事件的写 atom。运行时视图状态（sessionRuntimeByIdAtom 等）仍留在入口，
 * 因为入口的运行时事件机是它们的唯一写入方。
 * 入口 `session-atoms.ts` 用 `export *` 转出，所有既有 import 不变。
 */
import { atom } from "jotai";
import type { SessionRecord } from "../../../shared/types";
import { sameProjectSessionList } from "../utils/sessionRecordIdentity";
import type { SessionLoadState, SessionMessageCacheEntry } from "./session-atoms-types";

export const sessionRecordsAtom = atom<Record<string, SessionRecord>>({});
/** IDs detached from an in-memory runtime; rejects late catalog refreshes for them. */
export const discardedTransientSessionIdsAtom = atom<Set<string>>(new Set<string>());
export const sessionIdsByProjectAtom = atom<Record<string, string[]>>({});
export const currentSessionIdAtom = atom<string | undefined>(undefined);
/** 会话 Tab 栏（浏览器式多 Tab）：按打开顺序排列的会话 id 列表。
 *  关闭 Tab 只从列表移除，不 kill Agent；再次打开同一会话时复用已绑定运行时。 */
export const sessionTabIdsAtom = atom<string[]>([]);
/**
 * 运行时已停止（detach）的会话 id：消息缓存不再享受「打开 Tab 无条件保护」。
 * 重新绑定运行时（懒启动 / 重启 / 发送前绑定）或删除会话时清除。
 */
export const stoppedSessionIdsAtom = atom<Set<string>>(new Set<string>());
export const sessionMessagesCacheAtom = atom<Record<string, SessionMessageCacheEntry>>({});
export const sessionMessageLruAtom = atom<string[]>([]);
export const sessionMessageLoadStateAtom = atom<Record<string, SessionLoadState>>({});
export const sessionCatalogLoadStateAtom = atom<Record<string, SessionLoadState>>({});
export const currentSessionAtom = atom((get) => {
	const sessionId = get(currentSessionIdAtom);
	return sessionId ? get(sessionRecordsAtom)[sessionId] : undefined;
});
export const currentSessionMessagesAtom = atom((get) => {
	const sessionId = get(currentSessionIdAtom);
	return sessionId ? (get(sessionMessagesCacheAtom)[sessionId]?.messages ?? []) : [];
});
export const replaceProjectSessionsAtom = atom(null, (get, set, input: { projectId: string; sessions: SessionRecord[] }) => {
	const discardedTransientIds = get(discardedTransientSessionIdsAtom);
	// A close can race a catalog scan that started before the runtime detached.
	// Do not let that stale response resurrect a no-session row in the sidebar.
	const sessions = input.sessions.filter((session) => !session.noSession || !discardedTransientIds.has(session.id));
	const previousIds = get(sessionIdsByProjectAtom)[input.projectId] ?? [];
	// 轮询刷新绝大多数轮次内容未变；此时保持 atom 引用稳定，避免整棵侧栏重渲染。
	if (sameProjectSessionList(previousIds, get(sessionRecordsAtom), sessions)) return;
	const nextIds = sessions.map((session) => session.id);
	const nextIdSet = new Set(nextIds);
	const nextRecords = { ...get(sessionRecordsAtom) };
	// 当前选中会话的记录被目录刷新移除（删除/归档/外部同步）时，同步清空选中：
	// 否则 stale currentSessionId 会让后续 catalog-update（切换后端/来源、发送）在
	// 主进程查不到会话而报「会话不存在」。与 removeSessionStateAtom 的清理对齐。
	const currentSessionId = get(currentSessionIdAtom);
	for (const previousId of previousIds) {
		if (!nextIdSet.has(previousId)) {
			delete nextRecords[previousId];
			if (previousId === currentSessionId) {
				set(currentSessionIdAtom, undefined);
			}
		}
	}
	for (const session of sessions) nextRecords[session.id] = session;
	set(sessionRecordsAtom, nextRecords);
	set(sessionIdsByProjectAtom, {
		...get(sessionIdsByProjectAtom),
		[input.projectId]: nextIds,
	});
});

export const upsertSessionAtom = atom(null, (get, set, session: SessionRecord) => {
	if (session.noSession && get(discardedTransientSessionIdsAtom).has(session.id)) {
		const nextDiscarded = new Set(get(discardedTransientSessionIdsAtom));
		nextDiscarded.delete(session.id);
		set(discardedTransientSessionIdsAtom, nextDiscarded);
	}
	set(sessionRecordsAtom, {
		...get(sessionRecordsAtom),
		[session.id]: session,
	});
	const projectIds = get(sessionIdsByProjectAtom)[session.projectId] ?? [];
	if (!projectIds.includes(session.id)) {
		set(sessionIdsByProjectAtom, {
			...get(sessionIdsByProjectAtom),
			[session.projectId]: [session.id, ...projectIds],
		});
	}
});

export const setSessionCatalogLoadStateAtom = atom(null, (get, set, input: { projectId: string; state: SessionLoadState }) => {
	set(sessionCatalogLoadStateAtom, {
		...get(sessionCatalogLoadStateAtom),
		[input.projectId]: input.state,
	});
});

export const setSessionMessageLoadStateAtom = atom(null, (get, set, input: { sessionId: string; state: SessionLoadState }) => {
	set(sessionMessageLoadStateAtom, {
		...get(sessionMessageLoadStateAtom),
		[input.sessionId]: input.state,
	});
});
