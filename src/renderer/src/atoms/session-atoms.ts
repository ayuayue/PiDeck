import { atom } from "jotai";
import type { Getter, Setter } from "jotai";
import { atomFamily, selectAtom } from "jotai/utils";
import type {
  AgentBackend,
  AgentRuntimeState,
  AgentStatus,
  AgentUiBatchQuestion,
  AgentUiRequest,
  ChatMessage,
  SessionMessagePage,
  SessionRecord,
  SessionRuntimeEvent,
  SessionRuntimeInfo,
} from "../../../shared/types";
import { mergeAgentRuntimeState } from "../utils/agentRuntimeState";
import { findLastUserMessageIndex, shouldRefreshOutlineForRuntimeUpsert } from "./outlineRevision";
import { releaseSessionOutlineProjection } from "./outlineProjectionCache";
import { sameProjectSessionList } from "../utils/sessionRecordIdentity";
import {
  resolveStreamingTextUpdate,
  shouldHoldLiveText,
  shouldReleaseHeldLiveText,
} from "../utils/liveTextHandoff";

/**
 * 渲染层会话消息缓存上限（LRU）。
 * 6 → 8（2026-12 会话切换闪屏修复）：4 个分屏常驻 + 3 个预览 + 1 个切换缓冲；
 * 切回被淘汰的会话要重新走磁盘读取，大会话（几十 MB）会先闪骨架屏/起始页，
 * 放宽到 8 在内存可接受范围内减少淘汰频次；
 * 淘汰的会话切回时走激活分页（尾部 9 轮）重新拉取，成本可控。
 */
export const SESSION_MESSAGE_CACHE_LIMIT = 8;

/**
 * 会话消息缓存 LRU 裁剪策略：打开着的会话 Tab（预览/常驻）永不裁剪，
 * 其余按最近写入顺序补足剩余名额（未打开部分受 limit 约束）。
 *
 * 为什么：渲染层把「缓存条目存在」视为「内容已加载」（见 deriveSessionSurfaceRuntime
 * 的 ready && !hasCachedEntry 判据）。打开中的会话若因其它会话写入被挤出 8 槽，
 * 切回瞬间会重读盘并闪「正在加载历史」骨架——生图会话等没有 runtime 事件持续
 * touch 的会话最容易被挤出，且重读期间只要再被挤出就会形成「挤掉→重读→再挤掉」
 * 循环闪（重启后多个 Tab 恢复、大会话读盘慢时最明显）。Tab 关闭后不再受保护
 * （用户已不引用），按 limit 正常回收。
 */
export function selectRetainedCacheEntryIds(
  lru: readonly string[],
  openedTabIds: ReadonlySet<string>,
  limit: number,
): string[] {
  // 打开着的 Tab 全部保留（即使数量超过 limit：已打开的会话是用户在看的，
  // 宁可在内存上稍微超额，也绝不挤掉正在显示的会话）；
  // 未打开的按最近写入顺序占剩余名额（不足时一个不留）。
  const open = lru.filter((id) => openedTabIds.has(id));
  const closed = lru.filter((id) => !openedTabIds.has(id));
  const closedBudget = Math.max(0, limit - open.length);
  return [...open, ...closed.slice(0, closedBudget)];
}

export type SessionRuntimeViewState = {
  agentId?: string;
  runtimeGeneration: number;
  status: AgentStatus | "detached";
  state?: AgentRuntimeState;
  updatedAt: number;
  projectId?: string;
  cwd?: string;
  title?: string;
  piSessionId?: string;
  sessionPath?: string;
  createdAt?: number;
  compactionCount?: number;
  noSession?: boolean;
  /** 运行时后端（pi/dsh）：agents:state 事件透传，侧栏徽章/配对用。 */
  backend?: AgentBackend;
};

/** Live 思考段（按稳定 id 索引，与 History msg-thinking-* 同一身份）。 */
export type StreamingThinkingEntry = {
  sessionId: string;
  text: string;
  startedAt: number;
  endedAt: number;
  streaming: boolean;
};

export type SessionLoadState = {
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
};

export type SessionMessageCacheEntry = {
	messages: ChatMessage[];
	revision: number;
	source: "disk" | "runtime";
	updatedAt: number;
	/** Changes only when the user-message outline can change. */
	outlineRevision?: number;
	/** Last user-message index in messages (not the separate history prefix). */
	outlineLastUserIndex?: number;
	/** Present only for paged historical reads; runtime owns an authoritative full snapshot. */
	page?: Pick<SessionMessagePage, "total" | "nextBefore">;
	/** 激活显示窗口起点（runtime 数组下标空间，2026-08 激活分页）；>0 表示窗口前还有历史。 */
	windowStart?: number;
	/**
	 * 窗口段头部的系统摘要卡片数（全量 flush 时推导：本地长度 − (totalLength − windowStart)）。
	 * 增量合并时 upsertFrom 是 runtime 绝对下标，须 +cardCount 才等于本地下标（卡片占据本地头部）。
	 */
	cardCount?: number;
	/** 窗口首条消息的文件消息下标（2026-11）：窗口缺 entryId 时作为首次补历史的数值游标 */
	windowStartFilePos?: number;
	/**
	 * disk 历史前缀（仅 runtime 窗口会话）：prepend-only 轮次页，
	 * 与运行时窗口段的接缝按 meta.entryId 去重；fileVersion 变化（压缩改写）即整段失效。
	 */
	history?: {
		messages: ChatMessage[];
		nextBefore: number | null;
		/** 下一页续页锚点（页最旧条目的 entryId，2026-11 缓存优先路径用） */
		nextBeforeEntryId?: string | null;
		version?: string;
	};
};

export type SessionRuntimeUiRequestState = {
  request: AgentUiRequest;
  status: "pending" | "responding" | "completed" | "cancelled";
};

export type SessionRuntimeUiState = {
  agentId: string;
  runtimeGeneration: number;
  requests: Record<string, SessionRuntimeUiRequestState>;
  widgets: Record<string, string[]>;
  notification?: {
    requestId: string;
    message: string;
    notifyType?: "info" | "warning" | "error";
    revision: number;
  };
  editorText?: {
    requestId: string;
    text: string;
    revision: number;
  };
  revision: number;
};

export const sessionRecordsAtom = atom<Record<string, SessionRecord>>({});
/** IDs detached from an in-memory runtime; rejects late catalog refreshes for them. */
export const discardedTransientSessionIdsAtom = atom<Set<string>>(new Set<string>());
export const sessionIdsByProjectAtom = atom<Record<string, string[]>>({});
export const currentSessionIdAtom = atom<string | undefined>(undefined);
/** 会话 Tab 栏（浏览器式多 Tab）：按打开顺序排列的会话 id 列表。
 *  关闭 Tab 只从列表移除，不 kill Agent；再次打开同一会话时复用已绑定运行时。 */
export const sessionTabIdsAtom = atom<string[]>([]);
export const sessionRuntimeByIdAtom = atom<Record<string, SessionRuntimeViewState>>({});
export const sidebarRuntimeAtom = selectAtom(
  sessionRuntimeByIdAtom,
  (full) => {
    const slim: Record<string, { agentId?: string; status: string }> = {};
    for (const [id, rt] of Object.entries(full)) {
      slim[id] = { agentId: rt.agentId, status: rt.status ?? "detached" };
    }
    return slim;
  },
);
export const sessionRuntimeUiByIdAtom = atom<Record<string, SessionRuntimeUiState>>({});
/**
 * 会话级缓存命中率快照历史（仅存数值，最多 50 条）：
 * 用于展示「当前会话平均缓存命中率」，弥补只显示最新一次 assistant 命中率的不足。
 */
export const sessionCacheStatsAtom = atom<Record<string, { cacheHitHistory: number[] }>>({});
export const SESSION_CACHE_STATS_LIMIT = 50;
export const sessionMessagesCacheAtom = atom<Record<string, SessionMessageCacheEntry>>({});

// Cache entries can be evicted and recreated, so outline revisions must not restart per session.
let nextSessionMessageOutlineRevision = 0;
function allocateSessionMessageOutlineRevision(): number {
  nextSessionMessageOutlineRevision += 1;
  return nextSessionMessageOutlineRevision;
}

/** 时间线改写过程遮罩：停 Agent / 写 JSONL / 重载 / 激活 / fork，按 sessionId 隔离。 */
export type SessionHistoryMutationOverlayKind =
  | "stopping"
  | "mutating"
  | "reloading"
  | "activating"
  | "forking";

export const sessionHistoryMutationOverlayByIdAtom = atom<
  Record<string, SessionHistoryMutationOverlayKind>
>({});

export const setSessionHistoryMutationOverlayAtom = atom(
  null,
  (
    get,
    set,
    input: { sessionId: string; kind: SessionHistoryMutationOverlayKind | null },
  ) => {
    const current = get(sessionHistoryMutationOverlayByIdAtom);
    if (input.kind === null) {
      if (!(input.sessionId in current)) return;
      const next = { ...current };
      delete next[input.sessionId];
      set(sessionHistoryMutationOverlayByIdAtom, next);
      return;
    }
    if (current[input.sessionId] === input.kind) return;
    set(sessionHistoryMutationOverlayByIdAtom, {
      ...current,
      [input.sessionId]: input.kind,
    });
  },
);

/**
 * 单会话消息缓存条目（selectAtom 隔离）：其它会话的消息到达/分页/失效
 * 都整体重建 cache 对象，但本会话条目引用不变 → Object.is 相等 → 订阅者不重渲染。
 * 2026-10 性能修复：此前 controller 直接订全局缓存，分屏/多开时
 * 任一会话的流式消息或分页都会拖着重渲染所有分屏栏。
 */
export const sessionMessageCacheBySessionIdAtomFamily = atomFamily(
  (sessionId: string) =>
    selectAtom(sessionMessagesCacheAtom, (cache) => cache[sessionId], Object.is),
);

/**
 * 会话切换时的滚动位置锚点（per-session，切走保存、切回恢复）。
 * 只保存「非跟底」状态：用户正在查看历史时切走，回来时停留在原位置；
 * 在底部跟流切走的会话不存锚点，切回继续跟底。
 */
export type SessionScrollAnchor = {
	/** 锚点行 id（timeline 内 [data-message-id] 的值：可能是 run id 或消息 id） */
	messageId: string;
	/** 锚点行顶边相对视口顶部的偏移（px），恢复时按此对齐 */
	offsetTop: number;
	/**
	 * 切走时实际用于裁剪 DOM 的尾部 agent-run 窗口轮数。恢复必须先采用相同窗口，
	 * 否则锚点行上方的文档高度会变化，按 offsetTop 恢复的位置会被截断或漂移。
	 * undefined 兼容热更新期间仍在内存中的旧锚点，恢复时退回基础窗口并按需扩窗。
	 */
	windowTurns?: number;
	/** 保存时间戳，防止乱序事件用陈旧状态覆盖新状态 */
	savedAt: number;
};

export const sessionScrollAnchorByIdAtom = atom<Record<string, SessionScrollAnchor>>({});

/** 锚点内容比较：messageId/offsetTop/windowTurns 相同视为未变化（savedAt 不计入）。
 *  滚动节流写入时，内容不变则跳过——引用稳定，订阅者不会因无效写入重渲染。 */
export function sameSessionScrollAnchor(
	a: SessionScrollAnchor | undefined,
	b: SessionScrollAnchor | undefined,
): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return (
		a.messageId === b.messageId &&
		a.offsetTop === b.offsetTop &&
		a.windowTurns === b.windowTurns
	);
}

/** 保存/清除某会话的滚动锚点。anchor 为 null 时清除（如回到底部或会话关闭）。
 *  内容未变化时不写（保持引用稳定，避免订阅者无谓重渲染）；savedAt 乱序保护防陈旧覆盖。 */
export const saveSessionScrollAnchorAtom = atom(
	null,
	(get, set, input: { sessionId: string; anchor: SessionScrollAnchor | null }) => {
		const { sessionId, anchor } = input;
		set(sessionScrollAnchorByIdAtom, (prevMap) => {
			if (anchor === null) {
				if (!(sessionId in prevMap)) return prevMap;
				const nextMap = { ...prevMap };
				delete nextMap[sessionId];
				return nextMap;
			}
			const prev = prevMap[sessionId];
			// 内容未变化：跳过写入（引用稳定，订阅者零重渲染）
			if (prev && sameSessionScrollAnchor(prev, anchor)) return prevMap;
			// 乱序写入保护：只有更新（时间戳更新）才覆盖，防止陈旧滚动事件覆盖新保存。
			if (prev && prev.savedAt > anchor.savedAt) return prevMap;
			return { ...prevMap, [sessionId]: anchor };
		});
	},
);
/**
 * 会话级独立流式正文（阶段1：学 Proma 独立存储）。
 * key: sessionId，value: { content, streaming }。
 * 流式期间 content 由 agents:text-stream 通道实时更新；
 * message_end 后由历史消息（sessionMessagesCacheAtom）接管，此处清空。
 */
export const streamingTextByIdAtom = atom<
	Record<string, { content: string; streaming: boolean; held?: boolean }>
>({});
/**
 * Live 思考正文通道（镜像 text-stream）：key = msg-thinking-${assistantMessageId}。
 * ThinkingStep 叶子订阅；timeline 只订 liveThinkingIdBySessionAtom，避免 50ms 戳醒整树。
 */
export const streamingThinkingByIdAtom = atom<Record<string, StreamingThinkingEntry>>({});
/** 会话当前 live 思考段 id；仅 id 变化时通知 timeline 挂载点。 */
export const liveThinkingIdBySessionAtom = atom<Record<string, string>>({});

function sameStreamingThinkingEntry(
  a: StreamingThinkingEntry | undefined,
  b: StreamingThinkingEntry | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.sessionId === b.sessionId &&
    a.text === b.text &&
    a.startedAt === b.startedAt &&
    a.endedAt === b.endedAt &&
    a.streaming === b.streaming
  );
}

/** ThinkingStep 叶子按稳定 id 订阅，避免整表 tick 戳醒所有思考卡。
 *  jotai atomFamily 无自动 GC：释放数据条目时必须同步 .remove(id)，否则长跑泄漏。 */
export const streamingThinkingEntryByIdAtomFamily = atomFamily((thinkingId: string) =>
  selectAtom(
    streamingThinkingByIdAtom,
    (map) => map[thinkingId],
    sameStreamingThinkingEntry,
  ),
);

/** Timeline 只订本会话 live id，不订思考正文。 */
export const liveThinkingIdBySessionIdAtomFamily = atomFamily((sessionId: string) =>
  selectAtom(
    liveThinkingIdBySessionAtom,
    (map) => map[sessionId],
    Object.is,
  ),
);

/**
 * 本会话「是否存在活动正文流」（streamingTextByIdAtom 单槽 streaming 位）。
 * 输出稳定 boolean：流式期间 content 每 50ms 变化但 streaming 不变 → 引用不变 →
 * TurnRow 零额外重渲染；仅在流开始/结束时触发订阅者。
 * 用途：liveInterimId 要求活动流才挂 live——中间回复 message_end 后槽删（streaming=false）
 * 立即落回容器内 settled，消除「双失明消失窗口」（live 读空 + 容器内被跳过）。
 */
export const liveTextStreamingBySessionAtom = atomFamily((sessionId: string) =>
  selectAtom(
    streamingTextByIdAtom,
    (map) => map[sessionId]?.streaming === true,
    Object.is,
  ),
);

/**
 * 本会话是否应继续挂 live 正文：推流中，或 done 已到、History 未到（held）。
 * 状态条只用 streaming 位；挂载用本 atom，避免交接空白。
 */
export const liveTextActiveBySessionAtom = atomFamily((sessionId: string) =>
  selectAtom(
    streamingTextByIdAtom,
    (map) => map[sessionId]?.streaming === true || map[sessionId]?.held === true,
    Object.is,
  ),
);

/**
 * 本会话 live 思考是否仍在推流（只订 streaming 位，不订思考正文）。
 * 状态条用它区分「回复中」和「残留 liveThinkingId 的空窗」。
 */
export const liveThinkingStreamingBySessionAtom = atomFamily((sessionId: string) =>
  atom((get) => {
    const liveId = get(liveThinkingIdBySessionAtom)[sessionId];
    if (!liveId) return false;
    return get(streamingThinkingByIdAtom)[liveId]?.streaming === true;
  }),
);

/** 正文流条目同值比较：content 与 streaming 位都相等才算同值。 */
function sameStreamingTextEntry(
  a: { content: string; streaming: boolean; held?: boolean } | undefined,
  b: { content: string; streaming: boolean; held?: boolean } | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.content === b.content && a.streaming === b.streaming && a.held === b.held;
}

/**
 * 单会话正文流内容（selectAtom 隔离）：其它会话的 token 更新不触发本订阅者。
 * 2026-10 性能修复：此前 LiveAnswerBody 直接订全局 streamingTextByIdAtom，
 * 分屏/多开时任一会话的流式 token 会拖着重渲染所有会话的正文实例。
 */
export const streamingTextBySessionIdAtomFamily = atomFamily((sessionId: string) =>
  selectAtom(
    streamingTextByIdAtom,
    (map) => map[sessionId],
    sameStreamingTextEntry,
  ),
);

/** 与 streamingThinkingByIdAtom 条目成对释放，避免 atomFamily Map 无限增长。 */
function disposeStreamingThinkingFamily(thinkingId: string) {
  streamingThinkingEntryByIdAtomFamily.remove(thinkingId);
}

/**
 * 「新一轮开始」信号：composer 发送成功后 +1（sessionId 键）。
 * TurnRow 订阅本会话 tick：变化时非最新轮强制收起（设置② collapsePrevRunsOnNewTurn 开启时），
 * 含用户手动展开的轮次。tick 低频（每轮一次），跨会话订阅经 family selectAtom 隔离。
 */
export const newTurnCollapseTickByIdAtom = atom<Record<string, number>>({});

export const bumpNewTurnCollapseTickAtom = atom(null, (_get, set, sessionId: string) => {
  set(newTurnCollapseTickByIdAtom, (prev) => ({
    ...prev,
    [sessionId]: (prev[sessionId] ?? 0) + 1,
  }));
});

/** 单会话 tick 订阅（selectAtom 隔离：其它会话 bump 不触发本订阅者）。 */
export const newTurnCollapseTickBySessionIdAtomFamily = atomFamily((sessionId: string) =>
  selectAtom(
    newTurnCollapseTickByIdAtom,
    (map) => map[sessionId] ?? 0,
    Object.is,
  ),
);

/**
 * run 级「执行过程展开状态」的跨挂载记忆条目。
 * atTick 记录写入时的 newTurnCollapseTick：新一轮只压过早于它的旧记忆，
 * 从新一轮之后再次写入的记忆必须在下一次重挂载时恢复（用户明确的最新意愿）。
 */
export type RunStepsVisibleMemoryEntry = {
  /** 展开意愿：true = 展开，false = 明确折叠。 */
  visible: boolean;
  /** 写入时的新一轮 tick（session 级单调递增）。 */
  atTick: number;
};

/**
 * run 级「执行过程展开状态」的跨挂载记忆（内存级，重启清零）。
 *
 * 背景（2026 用户反馈）：stepsVisible 原本是 TurnRow 组件局部 state，
 * 切会话再切回时 TurnRow 以 run.id 重挂载、状态归零——「正在看 / 手动打开的
 * 中间过程」被初始态折叠规则收掉。此 family 按 runId 记住最近一次明确的
 * 展开意愿：手动开合 / 流式展开写 { visible, atTick }，
 * 新一轮强制折叠 / 1.5s 自动收起后清除（delete）。
 *
 * 语义边界：
 * - 只看历史的会话从未展开过任何轮 → 无记忆 → 走初始态折叠（规则①不变）；
 * - 新一轮已发生且本轮非最新 → 挂载时直接折叠，早于此轮的记忆作废（规则④优先）；
 *   新一轮之后用户再次手动展开写下的记忆（atTick >= 当前 tick）必须恢复；
 * - 重启后 atom 清零 → 全部回到折叠（内存级，不持久化）。
 */
export const runStepsVisibleMemoryBySessionIdAtomFamily = atomFamily(
  (sessionId: string) => atom<Record<string, RunStepsVisibleMemoryEntry>>({}),
);

export const sessionMessageLruAtom = atom<string[]>([]);
export const sessionMessageLoadStateAtom = atom<Record<string, SessionLoadState>>({});
export const sessionCatalogLoadStateAtom = atom<Record<string, SessionLoadState>>({});

export const currentSessionAtom = atom((get) => {
  const sessionId = get(currentSessionIdAtom);
  return sessionId ? get(sessionRecordsAtom)[sessionId] : undefined;
});

export const currentSessionRuntimeAtom = atom((get) => {
  const sessionId = get(currentSessionIdAtom);
  return sessionId ? get(sessionRuntimeByIdAtom)[sessionId] : undefined;
});

export const currentSessionRuntimeUiAtom = atom((get) => {
  const sessionId = get(currentSessionIdAtom);
  return sessionId ? get(sessionRuntimeUiByIdAtom)[sessionId] : undefined;
});

export const currentSessionMessagesAtom = atom((get) => {
  const sessionId = get(currentSessionIdAtom);
  return sessionId
    ? (get(sessionMessagesCacheAtom)[sessionId]?.messages ?? [])
    : [];
});

export const replaceSessionRuntimesAtom = atom(
  null,
  (get, set, runtimes: SessionRuntimeInfo[]) => {
    const current = get(sessionRuntimeByIdAtom);
    const next = { ...current };
    for (const runtime of runtimes) {
      const existing = current[runtime.sessionId];
      if (existing && existing.runtimeGeneration > runtime.runtimeGeneration) continue;
      const bindingChanged = existing?.agentId !== runtime.agentId ||
        existing.runtimeGeneration !== runtime.runtimeGeneration;
      next[runtime.sessionId] = {
        ...(bindingChanged ? {} : existing),
        agentId: runtime.agentId,
        runtimeGeneration: runtime.runtimeGeneration,
        status: runtime.status,
        state: bindingChanged ? undefined : existing?.state,
        updatedAt: Date.now(),
        projectId: runtime.projectId,
        cwd: runtime.cwd,
        sessionPath: runtime.sessionPath,
        createdAt: runtime.createdAt,
        compactionCount: runtime.compactionCount,
        noSession: runtime.noSession,
      };
    }
    set(sessionRuntimeByIdAtom, next);
  },
);

export const replaceProjectSessionsAtom = atom(
  null,
  (get, set, input: { projectId: string; sessions: SessionRecord[] }) => {
    const discardedTransientIds = get(discardedTransientSessionIdsAtom);
    // A close can race a catalog scan that started before the runtime detached.
    // Do not let that stale response resurrect a no-session row in the sidebar.
    const sessions = input.sessions.filter((session) => (
      !session.noSession || !discardedTransientIds.has(session.id)
    ));
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
  },
);

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

export const setSessionCatalogLoadStateAtom = atom(
  null,
  (get, set, input: { projectId: string; state: SessionLoadState }) => {
    set(sessionCatalogLoadStateAtom, {
      ...get(sessionCatalogLoadStateAtom),
      [input.projectId]: input.state,
    });
  },
);

export const setSessionMessageLoadStateAtom = atom(
  null,
  (get, set, input: { sessionId: string; state: SessionLoadState }) => {
    set(sessionMessageLoadStateAtom, {
      ...get(sessionMessageLoadStateAtom),
      [input.sessionId]: input.state,
    });
  },
);

export const cacheSessionMessagesAtom = atom(
  null,
  (get, set, input: {
    sessionId: string;
		messages: ChatMessage[];
		source: "disk" | "runtime";
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
  }) => {
    const cache = get(sessionMessagesCacheAtom);
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
    if (
      !input.force &&
      input.expectedRevision !== undefined &&
      input.source === "disk" &&
      current?.source === "disk" &&
      (current.revision ?? 0) !== input.expectedRevision
    ) {
      return false;
    }

    // 防止空/较少 disk 响应清空或退化已有 runtime 缓存（匿名会话切回场景）：
    // 当 disk 来源的消息数 ≤ cache 中已有消息数时，视为 stale 空读或退化读，直接跳过；
    // 仅当 disk 携带严格更多的消息（如补齐窗口前的历史）时才允许写入。
    // force：用户刚改过 JSONL（编辑/删除/重发），disk 才是权威，必须覆盖 runtime。
    if (
      !input.force &&
      input.source === "disk" &&
      current?.source !== "disk" &&
      current?.messages?.length >= input.messages.length
    ) {
      return false;
    }
    const outlineChanged = input.outlineChanged !== false;
    const shouldReplaceOutlineProjection =
      outlineChanged || current?.outlineRevision === undefined;
    const outlineRevision = shouldReplaceOutlineProjection
      ? allocateSessionMessageOutlineRevision()
      : current.outlineRevision;
    const outlineLastUserIndex = outlineChanged
      ? findLastUserMessageIndex(input.messages)
      : current?.outlineLastUserIndex ?? findLastUserMessageIndex(input.messages);
    if (shouldReplaceOutlineProjection) releaseSessionOutlineProjection(input.sessionId);
    const revision = input.source === "runtime"
      ? (current?.revision ?? 0) + 1
      : (current?.revision ?? 0);
    const nextCache = {
      ...cache,
      [input.sessionId]: {
			messages: input.messages,
			revision,
			source: input.source,
			updatedAt: Date.now(),
			outlineRevision,
			outlineLastUserIndex,
			...(input.source === "disk" && input.page ? { page: input.page } : {}),
			// runtime 窗口语义（2026-08 激活分页）：entry 每次整体重建，
			// 调用方必须显式给出 windowStart/history（undefined = 清除，如版本失效丢前缀）；
			// disk 来源无窗口概念，两字段缺省即不存在
			...(input.source === "runtime" ? {
				windowStart: input.windowStart && input.windowStart > 0 ? input.windowStart : undefined,
				history: input.history,
				// 卡片数只在全量 flush 推导（增量 flush 不携带 → 保留旧值，合并偏移依赖它）
				...(typeof input.cardCount === "number" ? { cardCount: input.cardCount } : {}),
				// 未显式提供时保留旧值（增量 flush 不携带该字段，不应清掉有效游标）
				...(typeof input.windowStartFilePos === "number"
					? { windowStartFilePos: input.windowStartFilePos }
					: {}),
			} : {}),
		},
    };
    const lru = [
      input.sessionId,
      ...get(sessionMessageLruAtom).filter((id) => id !== input.sessionId),
    ];
    // LRU 裁剪提保护：打开着 Tab 的会话（预览/常驻）优先保留，其余按最近写入补足名额。
    // 打开中的会话若被挤出，切回时缓存条目消失 → 重读盘 + 闪「正在加载历史」骨架
    // （生图等无 runtime 事件持续 touch 的会话最易中招，2026 用户反馈）。
    const retainedIds = selectRetainedCacheEntryIds(
      lru,
      new Set(get(sessionTabIdsAtom)),
      SESSION_MESSAGE_CACHE_LIMIT,
    );
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

export const prependSessionMessagePageAtom = atom(
  null,
  (get, set, input: {
    sessionId: string;
    before: number;
    expectedRevision: number;
    page: SessionMessagePage;
  }) => {
    const current = get(sessionMessagesCacheAtom)[input.sessionId];
    if (
      !current ||
      current.source !== "disk" ||
      current.revision !== input.expectedRevision ||
      current.page?.nextBefore !== input.before
    ) {
      return false;
    }
    const messages = [...input.page.messages, ...current.messages];
    releaseSessionOutlineProjection(input.sessionId);
    set(sessionMessagesCacheAtom, {
      ...get(sessionMessagesCacheAtom),
      [input.sessionId]: {
        ...current,
        messages,
        page: { total: input.page.total, nextBefore: input.page.nextBefore },
        updatedAt: Date.now(),
        outlineRevision: allocateSessionMessageOutlineRevision(),
        outlineLastUserIndex: findLastUserMessageIndex(messages),
      },
    });
    return true;
  },
);
export const touchSessionMessagesAtom = atom(null, (get, set, sessionId: string) => {
  if (!get(sessionMessagesCacheAtom)[sessionId]) return;
  set(sessionMessageLruAtom, [
    sessionId,
    ...get(sessionMessageLruAtom).filter((id) => id !== sessionId),
  ].slice(0, SESSION_MESSAGE_CACHE_LIMIT));
});

/** 历史前缀/窗口段的去重键：优先 pi entryId（跨下标空间稳定），缺省回退消息 id。 */
function messageEntryKey(message: ChatMessage): string {
  const entryId = message.meta?.entryId;
  return typeof entryId === "string" && entryId ? `e:${entryId}` : `m:${message.id}`;
}

/**
 * 运行时窗口段更新时调和 disk 历史前缀（2026-08 激活分页）：
 * - fileVersion 变化（压缩/外部改写 JSONL）→ 前缀绝对下标空间失效，整段丢弃；
 * - 窗口右移与前缀尾部重叠 → 按 entryId 去重（重叠部分以运行时窗口段为权威）；
 * - slideOut（trim 窗口右移滑出的旧窗口头部轮次）→ 并入前缀尾部，避免锚点轮空洞。
 */
function reconcileHistoryPrefix(
  history: SessionMessageCacheEntry["history"],
  segment: ChatMessage[],
  fileVersion?: string,
  slideOut?: ChatMessage[],
): SessionMessageCacheEntry["history"] {
  if (!history && (!slideOut || slideOut.length === 0)) return undefined;
  // fileVersion 变化 = 文件被改写（编辑/删除/压缩/外部变更）。此时前缀内容可能已失效：
  // 编辑落在窗口外时，全量 flush 只带尾部窗口段，若旧前缀（尤其无 version 的异常前缀）
  // 继续拼回去，用户会看到「编辑了不刷新，再编一条才看到」。故 version 缺失或不同都丢弃。
  if (fileVersion && (!history?.version || fileVersion !== history.version)) {
    history = undefined;
  }
  const segmentKeys = new Set(segment.map(messageEntryKey));
  // 滑出轮与窗口段去重（防御：理论上不重叠），再与既有前缀去重，避免接缝重复
  const slideMessages = (slideOut ?? []).filter(
    (message) => !segmentKeys.has(messageEntryKey(message)),
  );
  const slideKeys = new Set(slideMessages.map(messageEntryKey));
  // 前缀同时按「窗口段」与「滑出轮」去重：窗口右移时前缀尾部与新段首部重叠，
  // 重叠部分以运行时窗口段为权威；滑出轮同理（不重叠时无操作）
  const dropKeys = new Set([...segmentKeys, ...slideKeys]);
  const prefixMessages = (history?.messages ?? []).filter(
    (message) => !dropKeys.has(messageEntryKey(message)),
  );
  const messages = [...prefixMessages, ...slideMessages];
  if (messages.length === 0) return undefined;
  // 无滑出轮且前缀未被触碰：保留原对象引用，避免无谓的 atom 更新
  if (slideMessages.length === 0 && messages.length === (history?.messages.length ?? 0)) {
    return history;
  }
  // 仅 slideOut 重建前缀时，游标不是 null：下一页应从 slideOut 最旧消息继续向上翻。
  // 保留 nextBeforeEntryId（文件/主进程缓存路径都能消费），否则 historyHasMore 会把
  // 刚滑出的前缀误判为「已经到最早」，窗口右移后更早历史无法继续翻页。
  let nextBeforeEntryId = history?.nextBeforeEntryId;
  if (!history) {
    const slideAnchor = slideMessages.find(
      (message) => typeof message.meta?.entryId === "string" && Boolean(message.meta.entryId),
    );
    const slideAnchorEntryId = slideAnchor?.meta?.entryId;
    if (typeof slideAnchorEntryId === "string") nextBeforeEntryId = slideAnchorEntryId;
  }
  return {
    nextBefore: history?.nextBefore ?? null,
    ...(nextBeforeEntryId !== undefined
      ? { nextBeforeEntryId }
      : {}),
    version: history?.version ?? fileVersion,
    messages,
  };
}

/**
 * disk 轮次页 prepend（runtime 窗口会话的「加载更多对话」）。
 * 守卫：来源/revision/游标连续；版本漂移（压缩）时旧前缀整段作废、以新页为最新前缀起点。
 */
export const prependSessionHistoryPageAtom = atom(
  null,
  (get, set, input: {
    sessionId: string;
    expectedRevision: number;
    /** Continuation cursor; undefined denotes the first history page. */
    before?: number | null;
    page: SessionMessagePage;
  }) => {
    const current = get(sessionMessagesCacheAtom)[input.sessionId];
    if (
      !current ||
      current.source !== "runtime" ||
      current.revision !== input.expectedRevision
    ) {
      return false;
    }
    if (current.history && current.history.nextBefore !== input.before) return false;
    if (!current.history && input.before !== undefined) return false;

    const segmentKeys = new Set(current.messages.map(messageEntryKey));
    const pageMessages = input.page.messages.filter((message) => !segmentKeys.has(messageEntryKey(message)));
    const stalePrefix = Boolean(
      current.history?.version &&
      input.page.indexVersion &&
      current.history.version !== input.page.indexVersion,
    );
    const baseMessages = stalePrefix ? [] : (current.history?.messages ?? []);
    const baseKeys = new Set(baseMessages.map(messageEntryKey));
    const freshMessages = pageMessages.filter((message) => !baseKeys.has(messageEntryKey(message)));
    const merged = [...freshMessages, ...baseMessages];
    releaseSessionOutlineProjection(input.sessionId);

    set(sessionMessagesCacheAtom, {
      ...get(sessionMessagesCacheAtom),
      [input.sessionId]: {
        ...current,
        history: merged.length > 0 || input.page.nextBefore !== null
          ? {
              messages: merged,
              nextBefore: input.page.nextBefore,
              ...(input.page.nextBeforeEntryId ? { nextBeforeEntryId: input.page.nextBeforeEntryId } : {}),
              version: input.page.indexVersion ?? current.history?.version,
            }
          : undefined,
        updatedAt: Date.now(),
        outlineRevision: allocateSessionMessageOutlineRevision(),
        outlineLastUserIndex: current.outlineLastUserIndex ??
          findLastUserMessageIndex(current.messages),
      },
    });
    return true;
  },
);
/**
 * 回底清理临时历史（2026-11 轮次模型）：贴底稳定后把 runtime 会话翻过的历史前缀清掉，
 * 只保留运行时窗口段 —— atom 数据回到「最近 9 轮窗口」（DOM 3 / atom 9 / main 12 模型）；
 * 再次上翻走「atom → 主进程缓存 → 文件」三级递进重新拉取。
 * 仅 runtime 来源缓存生效；disk 来源（历史会话浏览）不清，避免打断按条分页游标。
 */
export const clearSessionHistoryAtom = atom(
  null,
  (get, set, sessionId: string) => {
    const current = get(sessionMessagesCacheAtom)[sessionId];
    if (!current || current.source !== "runtime" || !current.history) return false;
    releaseSessionOutlineProjection(sessionId);
    set(sessionMessagesCacheAtom, {
      ...get(sessionMessagesCacheAtom),
      [sessionId]: {
        ...current,
        history: undefined,
        updatedAt: Date.now(),
        outlineRevision: allocateSessionMessageOutlineRevision(),
        outlineLastUserIndex: current.outlineLastUserIndex ??
          findLastUserMessageIndex(current.messages),
      },
    });
    return true;
  },
);
function toAgentUiRequest(
  payload: Record<string, unknown>,
  agentId: string,
): AgentUiRequest | undefined {
  const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
  if (!requestId) return undefined;
  const batchQuestions: AgentUiBatchQuestion[] | undefined = Array.isArray(payload.batchQuestions)
    ? payload.batchQuestions.reduce<AgentUiBatchQuestion[]>((questions, question) => {
        if (!question || typeof question !== "object") return questions;
        const typed = question as Record<string, unknown>;
        if (
          typeof typed.id !== "string" ||
          typeof typed.question !== "string" ||
          // 与主进程/飞书 envelope 白名单同构：multi_select 也走批量信封，
          // 这里漏放行会导致选项组件整体不渲染（2026-09 回归）。
          !["select", "multi_select", "confirm", "input", "editor"].includes(String(typed.type))
        ) {
          return questions;
        }
        const options = Array.isArray(typed.options)
          ? typed.options.reduce<NonNullable<AgentUiBatchQuestion["options"]>>((items, option) => {
              if (typeof option === "string") {
                items.push(option);
                return items;
              }
              if (!option || typeof option !== "object") return items;
              const typedOption = option as Record<string, unknown>;
              if (typeof typedOption.label !== "string") return items;
              items.push({
                label: typedOption.label,
                ...(typeof typedOption.value === "string" ? { value: typedOption.value } : {}),
                ...(typeof typedOption.description === "string"
                  ? { description: typedOption.description }
                  : {}),
              });
              return items;
            }, [])
          : undefined;
        questions.push({
          id: typed.id,
          type: typed.type as AgentUiBatchQuestion["type"],
          question: typed.question,
          ...(options?.length ? { options } : {}),
          ...(typeof typed.allowOther === "boolean" ? { allowOther: typed.allowOther } : {}),
          ...(typeof typed.placeholder === "string" ? { placeholder: typed.placeholder } : {}),
          ...(typeof typed.prefill === "string" ? { prefill: typed.prefill } : {}),
        });
        return questions;
      }, [])
    : undefined;
  return {
    agentId,
    requestId,
    method: typeof payload.method === "string" ? payload.method : "",
    title: typeof payload.title === "string" ? payload.title : "",
    options: Array.isArray(payload.options)
      ? payload.options.filter((option): option is string => typeof option === "string")
      : undefined,
    placeholder: typeof payload.placeholder === "string" ? payload.placeholder : undefined,
    prefill: typeof payload.prefill === "string" ? payload.prefill : undefined,
    allowOther: payload.allowOther === true,
    completed: payload.completed === true,
    value: typeof payload.value === "string" || typeof payload.value === "boolean"
      ? payload.value
      : undefined,
    confirmed: typeof payload.confirmed === "boolean" ? payload.confirmed : undefined,
    cancelled: payload.cancelled === true,
    message: typeof payload.message === "string" ? payload.message : undefined,
    notifyType: payload.notifyType === "info" || payload.notifyType === "warning" || payload.notifyType === "error"
      ? payload.notifyType
      : undefined,
    text: typeof payload.text === "string" ? payload.text : undefined,
    widgetKey: typeof payload.widgetKey === "string" ? payload.widgetKey : undefined,
    widgetLines: Array.isArray(payload.widgetLines)
      ? payload.widgetLines.filter((line): line is string => typeof line === "string")
      : undefined,
    widgetPlacement: payload.widgetPlacement === "aboveEditor" || payload.widgetPlacement === "belowEditor"
      ? payload.widgetPlacement
      : undefined,
    batchQuestions: batchQuestions?.length ? batchQuestions : undefined,
    batchReview: payload.batchReview === true,
  };
}

/** 清除某会话的 live 思考通道（换绑 / 卸载 / detach）。 */
function clearSessionLiveThinking(get: Getter, set: Setter, sessionId: string) {
  const liveId = get(liveThinkingIdBySessionAtom)[sessionId];
  const idsToDispose: string[] = [];
  if (liveId) {
    idsToDispose.push(liveId);
    set(streamingThinkingByIdAtom, (prevMap) => {
      if (!(liveId in prevMap)) return prevMap;
      const nextMap = { ...prevMap };
      delete nextMap[liveId];
      return nextMap;
    });
  } else {
    // 兜底：按 sessionId 扫一遍，防止 liveId 映射丢失后残留段。
    const map = get(streamingThinkingByIdAtom);
    const leftoverIds = Object.entries(map)
      .filter(([, entry]) => entry.sessionId === sessionId)
      .map(([id]) => id);
    if (leftoverIds.length > 0) {
      idsToDispose.push(...leftoverIds);
      set(streamingThinkingByIdAtom, (prevMap) => {
        const nextMap = { ...prevMap };
        for (const id of leftoverIds) delete nextMap[id];
        return nextMap;
      });
    }
  }
  set(liveThinkingIdBySessionAtom, (prevMap) => {
    if (!(sessionId in prevMap)) return prevMap;
    const nextMap = { ...prevMap };
    delete nextMap[sessionId];
    return nextMap;
  });
  for (const id of idsToDispose) disposeStreamingThinkingFamily(id);
}

/**
 * History 已写入同段 thinking 后才卸 live 身份。
 * done 与 agents:message 跨通道可能乱序；若 done 先清，会在 message.thinking 仍空时
 * 拆掉 ThinkingStep，等 History 到达再 remount → 整段糊屏。
 */
/** History 已写入本轮助手正文（或用户已发下一问）后，卸掉 done 暂留的 live 槽。 */
function tryReleaseHeldLiveTextAfterHistory(get: Getter, set: Setter, sessionId: string) {
  const live = get(streamingTextByIdAtom)[sessionId];
  if (!live?.held) return;
  const messages = get(sessionMessagesCacheAtom)[sessionId]?.messages ?? [];
  if (!shouldReleaseHeldLiveText(messages)) return;
  set(streamingTextByIdAtom, (prevMap) => {
    if (!(sessionId in prevMap)) return prevMap;
    const nextMap = { ...prevMap };
    delete nextMap[sessionId];
    return nextMap;
  });
}

function tryReleaseLiveThinkingAfterHistory(get: Getter, set: Setter, sessionId: string) {
  const liveId = get(liveThinkingIdBySessionAtom)[sessionId];
  if (!liveId?.startsWith("msg-thinking-")) return;
  const messageId = liveId.slice("msg-thinking-".length);
  if (!messageId) return;
  const messages = get(sessionMessagesCacheAtom)[sessionId]?.messages ?? [];
  const ready = messages.some(
    (message) => message.id === messageId && Boolean(message.thinking?.trim()),
  );
  if (!ready) return;
  set(streamingThinkingByIdAtom, (prevMap) => {
    if (!(liveId in prevMap)) return prevMap;
    const nextMap = { ...prevMap };
    delete nextMap[liveId];
    return nextMap;
  });
  set(liveThinkingIdBySessionAtom, (prevMap) => {
    if (prevMap[sessionId] !== liveId) return prevMap;
    const nextMap = { ...prevMap };
    delete nextMap[sessionId];
    return nextMap;
  });
  // 数据条目与 family 实例成对释放（uuid 段 id 不复用，不 remove 会永久堆在 Map 里）。
  disposeStreamingThinkingFamily(liveId);
}

function applySessionRuntimeUiEvent(
  current: SessionRuntimeUiState | undefined,
  event: SessionRuntimeEvent,
  payload: Record<string, unknown>,
  bindingChanged: boolean,
): SessionRuntimeUiState | undefined {
  const base = !current || bindingChanged || current.agentId !== event.agentId ||
    current.runtimeGeneration !== event.runtimeGeneration
    ? {
        agentId: event.agentId,
        runtimeGeneration: event.runtimeGeneration,
        requests: {},
        widgets: {},
        revision: 0,
      }
    : current;
  if (
    (event.sourceChannel === "agents:state" || event.sourceChannel === "sessions:runtime") &&
    payload.status === "closed"
  ) {
    return {
      agentId: event.agentId,
      runtimeGeneration: event.runtimeGeneration,
      requests: {},
      widgets: {},
      revision: base.revision + 1,
    };
  }
  if (event.sourceChannel !== "agents:ui-request") return bindingChanged ? base : current;
  const request = toAgentUiRequest(payload, event.agentId);
  if (!request) return base;
  const revision = base.revision + 1;

  if (request.completed) {
    const existing = base.requests[request.requestId];
    if (!existing) return { ...base, revision };
    return {
      ...base,
      revision,
      requests: {
        ...base.requests,
        [request.requestId]: {
          request: { ...existing.request, ...request },
          status: request.cancelled ? "cancelled" : "completed",
        },
      },
    };
  }
  if (request.method === "notify") {
    return request.message
      ? {
          ...base,
          revision,
          notification: {
            requestId: request.requestId,
            message: request.message,
            notifyType: request.notifyType,
            revision,
          },
        }
      : { ...base, revision };
  }
  if (request.method === "set_editor_text") {
    return {
      ...base,
      revision,
      editorText: {
        requestId: request.requestId,
        text: request.text ?? "",
        revision,
      },
    };
  }
  if (request.method === "setWidget") {
    const widgetKey = request.widgetKey || request.requestId;
    const widgets = { ...base.widgets };
    if (request.widgetLines?.length) widgets[widgetKey] = request.widgetLines;
    else delete widgets[widgetKey];
    return { ...base, revision, widgets };
  }
  if (!["select", "confirm", "input", "editor", "batch_ask"].includes(request.method)) {
    return { ...base, revision };
  }
  return {
    ...base,
    revision,
    requests: {
      ...base.requests,
      [request.requestId]: { request, status: "pending" },
    },
  };
}

export const applySessionRuntimeEventAtom = atom(
  null,
  (get, set, event: SessionRuntimeEvent) => {
    const currentRuntime = get(sessionRuntimeByIdAtom)[event.sessionId] ?? {
      runtimeGeneration: 0,
      status: "detached" as const,
      updatedAt: 0,
    };
    if (event.kind === "detach") {
      if (
        event.runtimeGeneration < currentRuntime.runtimeGeneration ||
        (currentRuntime.agentId && currentRuntime.agentId !== event.agentId)
      ) {
        return;
      }
      // Anonymous records only exist while their --no-session runtime exists.
      // Remove every renderer cache at detach so a future catalog refresh cannot
      // leave a closed anonymous row selectable in the sidebar.
      if (get(sessionRecordsAtom)[event.sessionId]?.noSession) {
        set(
          discardedTransientSessionIdsAtom,
          new Set(get(discardedTransientSessionIdsAtom)).add(event.sessionId),
        );
        set(removeSessionStateAtom, event.sessionId);
        return;
      }
      const nextUiById = { ...get(sessionRuntimeUiByIdAtom) };
      delete nextUiById[event.sessionId];
      set(sessionRuntimeUiByIdAtom, nextUiById);
      clearSessionLiveThinking(get, set, event.sessionId);
      set(sessionRuntimeByIdAtom, {
        ...get(sessionRuntimeByIdAtom),
        [event.sessionId]: {
          runtimeGeneration: event.runtimeGeneration,
          status: "detached",
          updatedAt: Date.now(),
        },
      });
      return;
    }
    if (event.runtimeGeneration < currentRuntime.runtimeGeneration) return;
    if (
      event.runtimeGeneration === currentRuntime.runtimeGeneration &&
      currentRuntime.agentId &&
      currentRuntime.agentId !== event.agentId
    ) {
      return;
    }
    const bindingChanged =
      event.runtimeGeneration > currentRuntime.runtimeGeneration ||
      currentRuntime.agentId !== event.agentId;

    // 2026-08 治理：agents:event 是 pi 原始事件流（每 token 100+/s），桌面 UI
    // 无任何消费者（web SSE 走主进程内部订阅）。此前它落入下方兜底路径无条件
    // 写 sessionRuntimeByIdAtom，导致 timeline 等订阅者 100/s 全量重渲染——
    // 主进程侧已停止转发，这里双保险拦截（防其他生产者误发）。
    if (event.sourceChannel === "agents:event") return;

    let nextRuntime: SessionRuntimeViewState = {
      ...(bindingChanged
        ? {
            runtimeGeneration: event.runtimeGeneration,
            status: "detached" as const,
            updatedAt: 0,
            // 新绑定不能继承旧 agent 的运行时状态：清掉残留 state，
            // 否则底栏 state?.modelName 优先于 record 显示旧模型（模型切换后显示旧）。
            // 真实值由后续 agents:runtime-state 事件（含 applyPreferences 后的主动推送）填充。
            state: undefined,
          }
        : currentRuntime),
      agentId: event.agentId,
      runtimeGeneration: event.runtimeGeneration,
      updatedAt: Date.now(),
    };
    if (bindingChanged) {
      clearSessionLiveThinking(get, set, event.sessionId);
    }
    const payload = event.payload && typeof event.payload === "object"
      ? event.payload as Record<string, unknown>
      : undefined;

    if (
      (event.sourceChannel === "agents:state" || event.sourceChannel === "sessions:runtime") &&
      payload
    ) {
      const status = payload.status;
      if (
        status === "starting" ||
        status === "idle" ||
        status === "running" ||
        status === "error" ||
        status === "closed"
      ) {
        nextRuntime = {
          ...nextRuntime,
          status,
          // 终态（error/closed）会话不再需要运行时状态（goal/todos/model 上下文等），
          // 清空以释放渲染进程内存；历史消息在 sessionMessagesCacheAtom 中不受影响。
          state: status === "error" || status === "closed" ? undefined : nextRuntime.state,
          projectId: typeof payload.projectId === "string" ? payload.projectId : nextRuntime.projectId,
          cwd: typeof payload.cwd === "string" ? payload.cwd : nextRuntime.cwd,
          title: typeof payload.title === "string" ? payload.title : nextRuntime.title,
          piSessionId: typeof payload.sessionId === "string" ? payload.sessionId : nextRuntime.piSessionId,
          sessionPath: typeof payload.sessionPath === "string" ? payload.sessionPath : nextRuntime.sessionPath,
          createdAt: typeof payload.createdAt === "number" ? payload.createdAt : nextRuntime.createdAt,
          compactionCount: typeof payload.compactionCount === "number"
            ? payload.compactionCount
            : nextRuntime.compactionCount,
          noSession: payload.noSession === true || nextRuntime.noSession,
          backend: payload.backend === "dsh" ? "dsh" : (nextRuntime.backend ?? "pi"),
        };
      }
    } else if (event.sourceChannel === "agents:runtime-state" && payload?.state) {
      // 终态之后主进程仍可能有迟到的 runtime-state 事件回填旧 state；
      // 此时跳过 merge，避免刚被清空的 state 又被旧事件重新填回（占用内存）。
      // isSessionRuntimeBusy 已按 status 早退、不读 state，跳过不改变任何 UI 判断。
      const terminal = nextRuntime.status === "error" || nextRuntime.status === "closed";
      if (!terminal) {
        nextRuntime = {
          ...nextRuntime,
          state: mergeAgentRuntimeState(
            nextRuntime.state,
            payload.state as AgentRuntimeState,
          ),
        };
        // 缓存命中率快照入列：供「会话平均命中率」展示。
        // 只记有效百分比，避免把 undefined/瞬时抖动计入平均；
        // 连续相同的快照值跳过（流式期间 get_state 轮询会重复返回同一统计）。
        const hitPercent = (payload.state as AgentRuntimeState).cacheHitPercent;
        if (typeof hitPercent === "number" && Number.isFinite(hitPercent)) {
          const currentStats = get(sessionCacheStatsAtom)[event.sessionId] ?? { cacheHitHistory: [] };
          const history = currentStats.cacheHitHistory;
          if (history[history.length - 1] === hitPercent) {
            // 值未变化：不写 atom，避免 SessionHeader 无谓重渲染
          } else {
            const nextHistory = [...history, hitPercent].slice(-SESSION_CACHE_STATS_LIMIT);
            set(sessionCacheStatsAtom, {
              ...get(sessionCacheStatsAtom),
              [event.sessionId]: { cacheHitHistory: nextHistory },
            });
          }
        }
      }
    } else if (event.sourceChannel === "agents:thinking" && payload) {
      // Live 思考：只更新 streamingThinkingByIdAtom / liveThinkingIdBySessionAtom。
      // 绑定未变时不写 sessionRuntimeByIdAtom，避免每帧戳醒 timeline。
      const id = typeof payload.id === "string" ? payload.id : "";
      const fullText =
        typeof payload.text === "string"
          ? payload.text
          : typeof payload.thinking === "string"
            ? payload.thinking
            : "";
      const delta = typeof payload.delta === "string" ? payload.delta : "";
      const done = payload.done === true;
      const startedAt = typeof payload.startedAt === "number" ? payload.startedAt : Date.now();
      const endedAt = typeof payload.endedAt === "number" ? payload.endedAt : 0;
      if (id) {
        if (done) {
          // 只标终态，保留 id/文本；等 History 同段 thinking 可见后再卸身份（防跨通道乱序 remount）。
          const prev = get(streamingThinkingByIdAtom)[id];
          // 终态事件携带全量 text（见 finishThinkingChannel）；缺省时用本地累积
          const text = fullText || (delta && prev ? prev.text + delta : "") || prev?.text || "";
          const nextEntry: StreamingThinkingEntry = {
            sessionId: event.sessionId,
            text,
            startedAt: prev?.startedAt ?? startedAt,
            endedAt: endedAt > 0 ? endedAt : (prev?.endedAt && prev.endedAt > 0 ? prev.endedAt : Date.now()),
            streaming: false,
          };
          if (
            !prev ||
            prev.text !== nextEntry.text ||
            prev.startedAt !== nextEntry.startedAt ||
            prev.endedAt !== nextEntry.endedAt ||
            prev.streaming !== false ||
            prev.sessionId !== event.sessionId
          ) {
            set(streamingThinkingByIdAtom, {
              ...get(streamingThinkingByIdAtom),
              [id]: nextEntry,
            });
          }
          if (get(liveThinkingIdBySessionAtom)[event.sessionId] !== id) {
            set(liveThinkingIdBySessionAtom, {
              ...get(liveThinkingIdBySessionAtom),
              [event.sessionId]: id,
            });
          }
          tryReleaseLiveThinkingAfterHistory(get, set, event.sessionId);
        } else {
          const streaming = endedAt <= 0;
          const prev = get(streamingThinkingByIdAtom)[id];
          // 增量协议（2026-08 治理）：delta 追加到本地累积；text 全量替换
          const text = delta ? (prev?.text ?? "") + delta : fullText;
          if (
            !prev ||
            prev.text !== text ||
            prev.startedAt !== startedAt ||
            prev.endedAt !== endedAt ||
            prev.streaming !== streaming ||
            prev.sessionId !== event.sessionId
          ) {
            set(streamingThinkingByIdAtom, {
              ...get(streamingThinkingByIdAtom),
              [id]: {
                sessionId: event.sessionId,
                text,
                startedAt,
                endedAt,
                streaming,
              },
            });
          }
          if (get(liveThinkingIdBySessionAtom)[event.sessionId] !== id) {
            set(liveThinkingIdBySessionAtom, {
              ...get(liveThinkingIdBySessionAtom),
              [event.sessionId]: id,
            });
          }
        }
      }
      if (bindingChanged) {
        set(sessionRuntimeByIdAtom, {
          ...get(sessionRuntimeByIdAtom),
          [event.sessionId]: nextRuntime,
        });
      }
      return;
    } else if (event.sourceChannel === "agents:text-stream" && payload) {
      // Live 正文：只更新 streamingTextByIdAtom。
      // 绑定未变时不写 sessionRuntimeByIdAtom，避免每帧戳醒 timeline/composer 订阅者。
      const prev = get(streamingTextByIdAtom)[event.sessionId];
      // 增量协议（2026-08 治理）：主进程正常 append 只推 delta，渲染层追加到
      // 本地累积；text 全量快照（非 append 重置 / 2.5s 自愈）整体替换。
      const incoming = typeof payload.delta === "string"
        ? (prev?.content ?? "") + payload.delta
        : typeof payload.text === "string"
          ? payload.text
          : prev?.content ?? "";
      const done = payload.done === true;
      const reset = payload.reset === true;
      const text = resolveStreamingTextUpdate(prev?.content ?? "", incoming, done, reset);
      const historyReady = shouldReleaseHeldLiveText(
        get(sessionMessagesCacheAtom)[event.sessionId]?.messages ?? [],
      );
      const hold = shouldHoldLiveText({
        done,
        reset,
        liveText: text,
        historyHasAssistantText: historyReady,
      });
      const streaming = !done && text.length > 0;
      if (!prev || prev.content !== text || prev.streaming !== streaming || prev.held !== hold) {
        set(streamingTextByIdAtom, {
          ...get(streamingTextByIdAtom),
          [event.sessionId]: { content: text, streaming, held: hold || undefined },
        });
      }
      if (done && !hold) {
        set(streamingTextByIdAtom, (prevMap) => {
          if (!(event.sessionId in prevMap)) return prevMap;
          const nextMap = { ...prevMap };
          delete nextMap[event.sessionId];
          return nextMap;
        });
      }
      if (bindingChanged) {
        set(sessionRuntimeByIdAtom, {
          ...get(sessionRuntimeByIdAtom),
          [event.sessionId]: nextRuntime,
        });
      }
      return;
    } else if (
      (event.sourceChannel === "agents:message" || event.sourceChannel === "sessions:messages") &&
      payload
    ) {
      // 迟到快照守卫（2026-11）：stop 后主进程先发 detach（agentId 清除），节流 50ms 的
      // 最终 messages flush 可能晚于编辑/删除后的 force disk 重载到达，覆盖刚写回的缓存。
      // 同代际 + 绑定已消失 + terminal 才拦；新代际事件不受影响（detach 清 agentId 后
      // bindingChanged 会被重算成 true，不能拿它判定）。
      if (
        event.runtimeGeneration === currentRuntime.runtimeGeneration &&
        !currentRuntime.agentId &&
        (currentRuntime.status === "detached" || currentRuntime.status === "closed")
      ) {
        return;
      }
      const messages = payload.messages;
      // 增量 flush 协议（2026-08 渲染卡顿优化）：主进程节流 flush 只发尾部增量
      // （upsertFrom + totalLength），终态 immediate flush 永远全量。
      // 激活显示窗口（2026-08 激活分页）：全量快照只含窗口段 [windowStart..]，
      // 窗口前历史由 disk 轮次分页 prepend（history 字段）；下标运算一律换算窗口偏移。
      const upsertFrom = typeof payload.upsertFrom === "number" ? payload.upsertFrom : undefined;
      const totalLength = typeof payload.totalLength === "number" ? payload.totalLength : undefined;
      const payloadWindowStart = typeof payload.windowStart === "number" ? payload.windowStart : undefined;
      const payloadWindowStartFilePos = typeof payload.windowStartFilePos === "number"
        ? payload.windowStartFilePos
        : undefined;
      const fileVersion = typeof payload.fileVersion === "string" ? payload.fileVersion : undefined;
      if (Array.isArray(messages)) {
        const current = get(sessionMessagesCacheAtom)[event.sessionId];
        if (upsertFrom !== undefined && totalLength !== undefined) {
          // 增量合并：upsertFrom 为 runtime 数组绝对下标；本地数组 = [系统卡片(c), 窗口段]，
          // 窗口段首条对应 runtime 下标 W（windowStart），因此本地下标 = upsertFrom − W + c。
          // c（卡片数）由上一次全量 flush 推导并缓存（cardCount，见全量分支）；偏移无效
          // （缓存缺失/磁盘来源/漏事件）则丢弃，等终态窗口化全量校准——中间态滞后至多
          // 为本轮回答内的显示延迟，终态到达后完全纠正。
          const W = current?.windowStart ?? 0;
          const cardCount = current?.cardCount ?? 0;
          const offset = upsertFrom - W + cardCount;
          if (current?.source === "runtime" && offset >= 0 && current.messages.length >= offset) {
            const merged = [
              ...current.messages.slice(0, offset),
              ...(messages as ChatMessage[]),
            ];
            const outlineChanged = shouldRefreshOutlineForRuntimeUpsert(
              current.messages,
              current.outlineLastUserIndex,
              offset,
              messages,
            );
            // 长度校验：合并后本地长度 = 卡片 + (totalLength − W)；不满足说明增量已失序
            // （漏事件/trim 未校准），丢弃等待全量
            if (merged.length === totalLength - W + cardCount) {
              set(cacheSessionMessagesAtom, {
                sessionId: event.sessionId,
                messages: merged,
                source: "runtime",
                windowStart: W,
                outlineChanged,
                history: current.history,
                cardCount,
              });
            }
          }
        } else {
          // 窗口化全量 / 传统全量：替换运行时窗口段；
          // disk 前缀经版本守卫（压缩改写即失效）+ 接缝去重（窗口右移与前缀重叠）后保留
          const segment = messages as ChatMessage[];
          // 卡片数推导：全量载荷 = [卡片(c), 窗口段]，本地长度 = c + (totalLength − W)
          const W = payloadWindowStart ?? 0;
          const cardCount = Math.max(0, segment.length - (totalLength ?? segment.length) + W);
          // trim 窗口右移的滑出轮：主进程把旧窗口头部（不再被新窗口覆盖的轮次）
          // 随全量 flush 下发，并入历史前缀，避免「锚点轮从视口消失且翻不回来」
          const slideOut = Array.isArray(payload.slideOut)
            ? (payload.slideOut as ChatMessage[])
            : undefined;
          set(cacheSessionMessagesAtom, {
            sessionId: event.sessionId,
            messages: segment,
            source: "runtime",
            windowStart: payloadWindowStart,
            cardCount,
            history: reconcileHistoryPrefix(current?.history, segment, fileVersion, slideOut),
            ...(typeof payloadWindowStartFilePos === "number"
              ? { windowStartFilePos: payloadWindowStartFilePos }
              : {}),
          });
        }
        // message 到达后若已含同段 thinking，安全卸 live（覆盖 done 先到的情况）。
        tryReleaseLiveThinkingAfterHistory(get, set, event.sessionId);
        tryReleaseHeldLiveTextAfterHistory(get, set, event.sessionId);
      }
    }

    const terminalEnvelope = !bindingChanged && currentRuntime.status === "closed";
    const nextUi = payload && !(terminalEnvelope && event.sourceChannel === "agents:ui-request")
      ? applySessionRuntimeUiEvent(
          get(sessionRuntimeUiByIdAtom)[event.sessionId],
          event,
          payload,
          bindingChanged,
        )
      : undefined;
    if (nextUi) {
      set(sessionRuntimeUiByIdAtom, {
        ...get(sessionRuntimeUiByIdAtom),
        [event.sessionId]: nextUi,
      });
    }
    // 2026-08 治理：无实质变化的推送跳过 atom 写入（emitStreamingStatePatch 在
    // 流式期间每 50ms 一推且状态相同）。sessionRuntimeByIdAtom 的订阅者含整个
    // timeline，新对象写入 = 100/s 级全量重渲染（O(消息数) + 分配压力），
    // 是渲染进程 CPU 满载与 V8 committed 只涨不缩的根源。updatedAt 不参与比较
    // （始终变化），跳过更新时也不刷新它——真正的状态变化必然伴随上述字段变化。
    const runtimeUnchanged =
      !bindingChanged &&
      currentRuntime.agentId === nextRuntime.agentId &&
      currentRuntime.runtimeGeneration === nextRuntime.runtimeGeneration &&
      currentRuntime.status === nextRuntime.status &&
      currentRuntime.state === nextRuntime.state &&
      currentRuntime.projectId === nextRuntime.projectId &&
      currentRuntime.cwd === nextRuntime.cwd &&
      currentRuntime.title === nextRuntime.title &&
      currentRuntime.piSessionId === nextRuntime.piSessionId &&
      currentRuntime.sessionPath === nextRuntime.sessionPath &&
      currentRuntime.createdAt === nextRuntime.createdAt &&
      currentRuntime.compactionCount === nextRuntime.compactionCount &&
      currentRuntime.noSession === nextRuntime.noSession;
    if (!runtimeUnchanged) {
      set(sessionRuntimeByIdAtom, {
        ...get(sessionRuntimeByIdAtom),
        [event.sessionId]: nextRuntime,
      });
    }
  },
);

export const claimSessionRuntimeUiResponseAtom = atom(
  null,
  (get, set, input: {
    sessionId: string;
    requestId: string;
    agentId: string;
    runtimeGeneration: number;
    request?: AgentUiRequest;
  }) => {
    const current = get(sessionRuntimeUiByIdAtom)[input.sessionId];
    const request = current?.requests[input.requestId];
    if (
      !current ||
      current.agentId !== input.agentId ||
      current.runtimeGeneration !== input.runtimeGeneration ||
      request?.status !== "pending" ||
      (input.request !== undefined && request.request !== input.request)
    ) {
      return false;
    }
    set(sessionRuntimeUiByIdAtom, {
      ...get(sessionRuntimeUiByIdAtom),
      [input.sessionId]: {
        ...current,
        requests: {
          ...current.requests,
          [input.requestId]: { ...request, status: "responding" },
        },
      },
    });
    return true;
  },
);

export const rollbackSessionRuntimeUiResponseAtom = atom(
  null,
  (get, set, input: {
    sessionId: string;
    requestId: string;
    agentId: string;
    runtimeGeneration: number;
    request?: AgentUiRequest;
  }) => {
    const current = get(sessionRuntimeUiByIdAtom)[input.sessionId];
    const request = current?.requests[input.requestId];
    if (
      !current ||
      current.agentId !== input.agentId ||
      current.runtimeGeneration !== input.runtimeGeneration ||
      request?.status !== "responding" ||
      (input.request !== undefined && request.request !== input.request)
    ) {
      return false;
    }
    set(sessionRuntimeUiByIdAtom, {
      ...get(sessionRuntimeUiByIdAtom),
      [input.sessionId]: {
        ...current,
        requests: {
          ...current.requests,
          [input.requestId]: { ...request, status: "pending" },
        },
      },
    });
    return true;
  },
);

export const bindSessionRuntimeAtom = atom(
  null,
  (get, set, input: {
    sessionId: string;
    agentId: string;
    runtimeGeneration?: number;
    status?: AgentStatus;
  }) => {
    const current = get(sessionRuntimeByIdAtom)[input.sessionId];
    const currentGeneration = current?.runtimeGeneration ?? 0;
    if (
      input.runtimeGeneration !== undefined &&
      input.runtimeGeneration < currentGeneration
    ) {
      return;
    }
    const bindingChanged = Boolean(current?.agentId && current.agentId !== input.agentId);
    if (bindingChanged) {
      const ui = { ...get(sessionRuntimeUiByIdAtom) };
      delete ui[input.sessionId];
      set(sessionRuntimeUiByIdAtom, ui);
    }
    set(sessionRuntimeByIdAtom, {
      ...get(sessionRuntimeByIdAtom),
      [input.sessionId]: {
        agentId: input.agentId,
        runtimeGeneration: input.runtimeGeneration ?? currentGeneration,
        status: input.status ?? (bindingChanged ? "idle" : current?.status) ?? "idle",
        state: bindingChanged ? undefined : current?.state,
        updatedAt: Date.now(),
      },
    });
    if (bindingChanged) {
      clearSessionLiveThinking(get, set, input.sessionId);
    }
  },
);

export const removeSessionStateAtom = atom(null, (get, set, sessionId: string) => {
  const records = { ...get(sessionRecordsAtom) };
  const session = records[sessionId];
  delete records[sessionId];
  set(sessionRecordsAtom, records);
  if (session) {
    set(sessionIdsByProjectAtom, {
      ...get(sessionIdsByProjectAtom),
      [session.projectId]: (get(sessionIdsByProjectAtom)[session.projectId] ?? [])
        .filter((id) => id !== sessionId),
    });
  }
  const runtime = { ...get(sessionRuntimeByIdAtom) };
  delete runtime[sessionId];
  set(sessionRuntimeByIdAtom, runtime);
  const runtimeUi = { ...get(sessionRuntimeUiByIdAtom) };
  delete runtimeUi[sessionId];
  set(sessionRuntimeUiByIdAtom, runtimeUi);
  const cacheStats = { ...get(sessionCacheStatsAtom) };
  delete cacheStats[sessionId];
  set(sessionCacheStatsAtom, cacheStats);
  const cache = { ...get(sessionMessagesCacheAtom) };
  releaseSessionOutlineProjection(sessionId);
  delete cache[sessionId];
  set(sessionMessagesCacheAtom, cache);
  clearSessionLiveThinking(get, set, sessionId);
  liveTextStreamingBySessionAtom.remove(sessionId);
  liveTextActiveBySessionAtom.remove(sessionId);
  liveThinkingStreamingBySessionAtom.remove(sessionId);
  // atomFamily 无自动 GC：会话删除时必须同步 remove 各 family 实例，否则长期泄漏（2026-10）。
  liveThinkingIdBySessionIdAtomFamily.remove(sessionId);
  newTurnCollapseTickBySessionIdAtomFamily.remove(sessionId);
  runStepsVisibleMemoryBySessionIdAtomFamily.remove(sessionId);
  streamingTextBySessionIdAtomFamily.remove(sessionId);
  sessionMessageCacheBySessionIdAtomFamily.remove(sessionId);
  set(streamingTextByIdAtom, (prevMap) => {
    if (!(sessionId in prevMap)) return prevMap;
    const nextMap = { ...prevMap };
    delete nextMap[sessionId];
    return nextMap;
  });
  set(sessionScrollAnchorByIdAtom, (prevMap) => {
    if (!(sessionId in prevMap)) return prevMap;
    const nextMap = { ...prevMap };
    delete nextMap[sessionId];
    return nextMap;
  });
  set(sessionMessageLruAtom, get(sessionMessageLruAtom).filter((id) => id !== sessionId));
  const loadState = { ...get(sessionMessageLoadStateAtom) };
  delete loadState[sessionId];
  set(sessionMessageLoadStateAtom, loadState);
  if (get(currentSessionIdAtom) === sessionId) set(currentSessionIdAtom, undefined);
});
