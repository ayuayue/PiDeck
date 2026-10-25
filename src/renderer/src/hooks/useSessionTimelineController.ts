import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { atom, useAtomValue, useSetAtom, useStore } from "jotai";
import { toast } from "sonner";
import { latestUserMessageId, SendScrollPositioner } from "./timeline/sendScroll";
import { ROOT_ROW_SELECTOR, useVisibleTimelineRows, type VisibleTimelineRow } from "./timeline/useVisibleTimelineRows";
import { selectAtom } from "jotai/utils";
import { desktopApi } from "../desktopApi";
import type { AgentRuntimeState, ChatMessage, SessionMessagePage, SessionRecord } from "../../../shared/types";
import { t } from "../i18n";
import { sessionHistoryUnavailableState } from "../utils/sessionHistoryAvailability";
import { sessionDiskPageCursor } from "../utils/sessionDiskPageCursor";
import {
	cacheSessionMessagesAtom,
	clearSessionHistoryAtom,
	prependSessionHistoryPageAtom,
	prependSessionMessagePageAtom,
	sessionMessageLoadStateAtom,
	sessionMessagesCacheAtom,
	sessionMessageCacheBySessionIdAtomFamily,
	sessionRecordByIdAtomFamily,
	saveSessionScrollAnchorAtom,
	sessionScrollAnchorByIdAtom,
	scrollToLatestOnSendAtom,
	sessionSendStateByIdAtom,
	sendPinAnimatingByIdAtom,
	setSessionMessageLoadStateAtom,
	touchSessionMessagesAtom,
	type SessionLoadState,
	type SessionScrollAnchor,
} from "../atoms";
import { clearTimelineRevealAtom, requestTimelineRevealAtom } from "../atoms/timeline-reveal-atoms";
import type { MessageScrollerScrollApi } from "../components/agents/message-scroller";
import { TURN_WINDOW_AUTO_EXPAND_THRESHOLD, resolveAutoExpandThreshold } from "./timeline/autoExpandThreshold";
import { shouldAutoExpandRenderWindow, shouldApplyDelayedHistoryResult } from "./timeline/scrollHistoryPolicy";
import { beginProgrammaticScroll, clearProgrammaticScroll, createProgrammaticScrollGuard, finishProgrammaticScrollFrame, isProgrammaticScrollActive } from "./timeline/programmaticScrollGuard";
import { browsePinScrollTop, followBrowsePinAfterUserScroll, pickVisibleRootRow, shouldCompensateBrowsePin, type BrowsePin } from "./timeline/browsePin";
import { countUserTurns, TIMELINE_MOUNTED_TURN_LIMIT, TIMELINE_SCROLLED_TURN_LIMIT, TIMELINE_WINDOW_EXPAND_STEP } from "../components/session/timeline/turnRenderWindow";
import { estimateJumpExpandTurns, resolveJumpFallbackEntry, resolveJumpPendingAction } from "../components/session/timeline/jumpWindowPolicy";
import { shouldDeferJumpUntilLoaded } from "./timeline/timelineRevealChannel";
import { resolveJumpMessageIndex, resolveJumpScrollTarget } from "../components/session/timeline/jumpTarget";

/** 滚动接近顶部自动加载历史的阈值（px，2026-11 轮次模型）：
 *  贴顶（≤8px）才触发翻页——「滑到底才翻」，避免在顶部附近任何滚动都连翻历史页。
 *  同时用作「顶部不补偿」阈值：视口顶部 prepend/展开新内容时保持原位可见，
 *  补偿会把新内容推出视口（点击「加载更多/显示更早」无反馈根因，2026-02 修复）。 */
export const HISTORY_AUTO_LOAD_THRESHOLD = 8;
/** 翻页冷却（ms）：加载完成后立即再滚到顶不连翻，需停顿后重新触发（防惯性滚动连翻多页）。 */
const HISTORY_AUTO_LOAD_COOLDOWN_MS = 300;
/** 自动扩窗口冷却（ms）：防惯性滚动接近顶部时连扩多轮（与翻页冷却同量级）。 */
const TURN_WINDOW_AUTO_EXPAND_COOLDOWN_MS = 300;
/** 分批扩展：每帧最多挂载的轮数。
 *  一个 3 轮 cohort 拆成 2+1 两帧，避免本地 DOM 扩展在同一帧集中渲染。 */
const TURN_WINDOW_EXPAND_BATCH_TURNS = 2;

let nextLoadSequence = 0;
/** 新建空会话的跨挂载粘性：切 Tab 时 ChatSessionPane/hook 会销毁重建，useRef 粘性会丢失导致切回闪骨架。
 *  模块级 Set 跨实例保持：某会话一旦被判定为空，则在出现第一条消息前始终视为空，即使预热写入 filePath/dshSessionId 也不翻回。 */
const stickyEmptySessionIds = new Set<string>();
/** sticky 空会话集上限（LRU 裁剪）：会话从 catalog 删除后条目无人清理，
 *  桌面进程长运行下无界增长；与 latestLoadBySession 同构，超限删最早插入键。 */
const STICKY_EMPTY_SESSION_LRU_LIMIT = 100;
function addStickyEmptySession(sessionId: string) {
	stickyEmptySessionIds.add(sessionId);
	if (stickyEmptySessionIds.size <= STICKY_EMPTY_SESSION_LRU_LIMIT) return;
	// 超限：删最早插入的键（Set 迭代序 = 插入序）；重新 add 保证波及的当前会话不在淘汰位
	const oldest = stickyEmptySessionIds.keys().next().value;
	if (oldest !== undefined && oldest !== sessionId) stickyEmptySessionIds.delete(oldest);
}
// stickyEmptyRef 已迁移为 stickyEmptySessionIds（全局跨挂载，兼容旧测试断言）
/** 会话加载请求序号（防迟到响应串台）。键按 sessionId 累积，LRU 裁剪防无界增长（2026-10）。 */
const latestLoadBySession = new Map<string, number>();
const LATEST_LOAD_LRU_LIMIT = 20;
function trackLatestLoad(sessionId: string, sequence: number) {
	latestLoadBySession.set(sessionId, sequence);
	if (latestLoadBySession.size <= LATEST_LOAD_LRU_LIMIT) return;
	// 超限：删最早 set 的键（Map 迭代序 = 插入序）
	const oldest = latestLoadBySession.keys().next().value;
	if (oldest !== undefined) latestLoadBySession.delete(oldest);
}
/** sessionId 为空时的占位 atom：恒 undefined（无会话不订缓存条目）。 */
const NO_CACHE_ENTRY_ATOM = atom(undefined);

// 用户主动向上滚超过此阈值后停止自动跟底。值设很小是为了让用户稍微滚一点就能挣脱自动滚动，
// 避免流式消息频繁触发 ResizeObserver/MutationObserver 把用户弹回底部造成"颤抖"。
const BOTTOM_THRESHOLD = 16;
const LEGACY_OWNER_KEY = "legacy";
/** runtime 窗口会话「加载更多对话」的单页轮数（与主进程 DEFAULT_TURN_PAGE_SIZE 对齐） */
const RUNTIME_HISTORY_TURN_PAGE_SIZE = 3;
/** 历史会话（disk 路径）首开加载的轮数：与运行时窗口 DISPLAY_WINDOW_TURNS(9) 对齐，
 *  首次上滚 9 轮内零延迟；翻页与 runtime 同用 3 轮 cohort。
 *  2026-09 统一轮次协议：废除旧的「按消息条数(100)」页大小，页大小只以轮次计。 */
const DISK_INITIAL_TURN_PAGE_SIZE = 9;
/** 翻页成功后仅开放实际带回的 cohort，防止消息页大小与 DOM 窗口脱节。
 *  disk 消息页不一定以 user 消息开头（可能在长回答中间切断）；只要页非空就至少开放 1 轮，
 *  否则新增 agent-run 会被尾部窗口裁掉，出现「数据已加载但看不见」的无反馈。 */
function resolvePageWindowGrowth(messages: readonly ChatMessage[]): number {
	if (messages.length === 0) return 0;
	const turns = countUserTurns(messages);
	return Math.min(TIMELINE_WINDOW_EXPAND_STEP, Math.max(1, turns));
}

type Tagged<T> = { ownerKey: string; value: T };
type TimelineAnchor = {
	height: number;
	top: number;
	/** 发起请求时的历史浏览代数：回底/切会话后到达的响应不得恢复旧锚点。 */
	generation: number;
	/** 保持旧视口：即使原视口在顶部也只让新历史出现在上方。 */
	preserveAtTop?: boolean;
};

export function isTimelineAtBottom(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
	return scrollHeight - scrollTop - clientHeight < BOTTOM_THRESHOLD;
}

export function restoreTimelineAnchor(previousTop: number, heightDelta: number): number {
	return previousTop + heightDelta;
}
/**
 * 视口顶基准（相对 page）：IO 的 root 相交矩形以 padding box 为界（不含 border），
 * 快路径 origin 也加了 clientTop；全量回落与 pin 测量必须同基准，否则一旦
 * .message-timeline 加 border，两条路径会差一个 border 宽度（#401 终审 P2）。
 */
function timelineViewportTop(timeline: HTMLElement): number {
	// clientTop 在真实 DOM 里一定是数字；替身/异常节点缺失时按 0 处理，避免 NaN 毒化整个锚点。
	const clientTop = Number.isFinite(timeline.clientTop) ? timeline.clientTop : 0;
	return timeline.getBoundingClientRect().top + clientTop;
}

/** 钉行相对视口顶的偏移；行未挂载时返回 null。 */
export function measureBrowsePinViewportTop(timeline: HTMLElement | null, messageId: string): number | null {
	if (!timeline || !messageId) return null;
	const el = timeline.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`) as HTMLElement | null;
	if (!el) return null;
	return el.getBoundingClientRect().top - timelineViewportTop(timeline);
}

/**
 * 视口里第一条底部仍在视口内的轮根节点（user-turn / turn-row）；不要求整行都在视口里。
 * 浏览钉行用：即使物理上仍接近底部（短 3 轮窗口）也要能钉住，所以不走 isTimelineAtBottom。
 */
export function findBrowsePin(timeline: HTMLElement | null, visibleRows?: readonly VisibleTimelineRow[]): BrowsePin | null {
	if (!timeline) return null;
	// 快路径：可见行已按 top 升序，取第一条还没被视口顶切掉的行即可。
	// 命中轮根才走快路径；可见集合里没有轮根（长回答内部、只有子元素）时必须回落到
	// 下面的全量遍历 —— 原实现会继续找「视口下方最近的轮根」，直接 return null 会丢 pin
	// 导致插页后位置漂移（2026-10-23 评审实测回归）。
	if (visibleRows && visibleRows.length > 0) {
		// 与原逻辑一致：findBrowsePin 只认轮根，不做卡类降级（降级是 computeCurrentAnchor 的两级策略）
		const row = pickVisibleRootRow(visibleRows);
		if (row) return { messageId: row.id, expectedViewportTop: row.top };
	}
	const viewportTop = timelineViewportTop(timeline);
	const rows = timeline.querySelectorAll<HTMLElement>(ROOT_ROW_SELECTOR);
	for (const row of rows) {
		const rect = row.getBoundingClientRect();
		if (rect.bottom < viewportTop + 1) continue;
		const messageId = row.dataset.messageId ?? "";
		if (!messageId) continue;
		return {
			messageId,
			expectedViewportTop: rect.top - viewportTop,
		};
	}
	return null;
}

/**
 * Session switching reuses the same controller instance in the solo pane. The
 * restored anchor therefore has to initialize both follow mode and the DOM
 * window before MessageScroller commits its layout effects.
 */
export function resolveSessionTimelineRestoreState(anchor: SessionScrollAnchor | undefined): {
	autoScroll: boolean;
	showScrollToBottom: boolean;
	scrolledWindowTurns: number;
} {
	return {
		autoScroll: anchor === undefined,
		showScrollToBottom: anchor !== undefined,
		scrolledWindowTurns: Math.max(TIMELINE_SCROLLED_TURN_LIMIT, anchor?.windowTurns ?? TIMELINE_SCROLLED_TURN_LIMIT),
	};
}

/** 顶部补偿决策（数据 prepend / turn 窗口扩大共用，2026-02 修复）：
 *  视口在顶部（≤阈值）时不补偿，保持原位让新加载/展开的内容直接出现在视口顶部——
 *  容器 overflow-anchor:none，插入内容不会自动调整滚动位置，补偿反而把新内容推出视口，
 *  表现为「点击加载更多/显示更早无反馈」。视口中部时按高度差补偿以保持视口内容不动。
 *  返回补偿后的 scrollTop；null = 不补偿（保持原位）。 */
export function resolveTimelineTopCompensation(previousTop: number, heightDelta: number, threshold = HISTORY_AUTO_LOAD_THRESHOLD): number | null {
	if (previousTop <= threshold) return null;
	return restoreTimelineAnchor(previousTop, heightDelta);
}

export function matchesTimelineOwner(taggedOwnerKey: string, currentOwnerKey: string): boolean {
	return taggedOwnerKey === currentOwnerKey;
}

export function isSessionRuntimeBusy(status: string | undefined, state: AgentRuntimeState | undefined): boolean {
	// idle/error/closed 是停止的权威边沿；旧 runtime-state 可能稍后到达，
	// 不能让滞后的 isStreaming/isExecutingTool 把页面继续显示为运行中。
	if (status === "idle" || status === "error" || status === "closed" || status === "detached") return false;
	return Boolean(status === "running" || state?.isStreaming || state?.isExecutingTool);
}

/** 用户主动发送才算「正在启动」。输入预热也会把 runtime 打成 starting，但不能锁输入框。 */
export function isUserFacingSessionStart(sendStatus: string | undefined): boolean {
	return sendStatus === "activating";
}

/** catalog 已确认无磁盘历史：空草稿、从未落文件的 pi 会话、尚无 host id 的新 DSH。
 * 预热会写 filePath / dshSessionId，但草稿在真正开聊前仍算空——见控制器 sticky。 */
export function isKnownEmptySessionRecord(record: Pick<SessionRecord, "status" | "filePath" | "messageCount" | "backend" | "dshSessionId"> | undefined): boolean {
	if (!record) return false;
	if (record.status === "draft") return true;
	if ((record.messageCount ?? 0) > 0) return false;
	if (record.filePath) return false;
	if (record.backend === "dsh" && record.dshSessionId) return false;
	// imagegen 会话历史独立存 ImageSessionStore，不体现在 filePath/messageCount：
	// 已 promote 为 active 的生图会话不能判为空，否则重启后打开会跳过历史加载显示空引导页。
	// 新建生图草稿仍为 draft，已在上面 return true，不受影响。
	// videogen 同理（VideoSessionStore 独立存储，任务占位也不在 filePath/messageCount 里）。
	if (record.backend === "imagegen" || record.backend === "videogen") return false;
	return true;
}

export function deriveSessionSurfaceRuntime(
	messageCount: number,
	messageLoadStatus: string | undefined,
	sendStatus: string | undefined,
	runtimeStatus: string | undefined,
	runtimeState: AgentRuntimeState | undefined,
	hasCachedEntry?: boolean,
	/**
	 * catalog 已确认是空草稿（draft / 无会话文件且 messageCount=0）。
	 * 不能把 undefined/loading 钉成骨架：否则新建会话先挂底部输入栏再卸掉改居中起始页
	 * （输入框上跳），切回空会话还闪「正在加载历史」。有 filePath 的历史仍走下方规则。
	 */
	knownEmpty?: boolean,
) {
	const activating = isUserFacingSessionStart(sendStatus);
	const status = activating ? "starting" : runtimeStatus;
	return {
		status,
		isLoading:
			!knownEmpty &&
			messageCount === 0 &&
			(messageLoadStatus === "loading" ||
				// 挂载首帧 loadState 尚未写入（passive effect 在 paint 后才置 loading），
				// undefined 一律视为加载中——否则有历史的会话会被误判为「空会话」，
				// 闪出 SessionStartSurface 起始页（打开/切回大会话闪屏根因）。
				messageLoadStatus === undefined ||
				// ready 但缓存条目不存在（从未写入或被 LRU 淘汰）＝ disk 读取结果尚未到达
				// （cacheMessages 对 disk 读取无论空/非空都会创建条目）：必须钉在骨架屏。
				// 缓存条目已存在（即使 messages 为空）说明 disk 已返回——空会话显示起始页
				// 是合法终态，不会进入加载死循环。读取失败（error）不在此列。
				// 预热/发送 activating 不能再钉骨架：空会话应留在起始页，避免「输入一半整页闪骨架」。
				(messageLoadStatus === "ready" && !hasCachedEntry)),
		isStarting: activating,
		isBusy: activating || sendStatus === "sending" || isSessionRuntimeBusy(status, runtimeState),
	};
}

export function canLoadSessionTimelineMore(isStarting: boolean, messageCount: number): boolean {
	// 只在初始加载（无消息）时隐藏按钮；runtime 创建期间已有消息则不隐藏
	return !(isStarting && messageCount === 0);
}

/**
 * 挂载时是否可跳过初始磁盘历史读取。
 *
 * 背景（2026-10-08 fork/copy 现场）：主进程把坏路径读盘失败当「空历史」返回，
 * runtime 下发 0 条的全量 flush，渲染层写入 source="runtime"、messages=[] 的缓存
 * 条目。旧逻辑把这条**空 runtime 投影**当「已加载」跳过磁盘读取，loadState 永远停在
 * undefined，deriveSessionSurfaceRuntime 把 undefined 钉成 loading → 骨架屏永驻。
 *
 * 契约：跳过条件必须是「已拿到真实内容」——
 *   - knownEmpty（草稿/无文件无消息）→ 跳过，起始页是合法终态；
 *   - 条目非空（runtime/disk 来源都算真实内容）→ 跳过；
 *   - 条目为空但来源是 disk → 跳过（磁盘已应答，空即空会话终态）；
 *   - 条目为空且来源是 runtime → 不跳过：这是唯一能区分「会话本来就空」与
 *     「读盘还没应答/失败」的状态，必须读盘让磁盘给出 ready（起始页）或
 *     error（错误卡片 + 重试），否则失败被伪装成空历史且骨架永驻。
 */
export function shouldSkipInitialDiskLoad(cachedEntry: { source: "disk" | "runtime"; messages: readonly unknown[] } | undefined, knownEmpty: boolean): boolean {
	if (knownEmpty) return true;
	if (!cachedEntry) return false;
	if (cachedEntry.messages.length > 0) return true;
	// 空条目只有磁盘亲自返回的才算终态；runtime 空投影必须读盘核实。
	return cachedEntry.source === "disk";
}

/**
 * 挂载 effect 是否跳过初始磁盘读取（在 shouldSkipInitialDiskLoad 之上叠加「本次挂载已经
 * 发起或拿到读盘结论」的去重条件）。
 *
 * 为什么需要去重：runtime 节流 flush 每次都重建缓存条目对象（cacheSessionMessagesAtom
 * 整体重建 entry），effect 依赖 cachedEntry 会随之重跑；不去重就会对同一会话反复读盘。
 *
 * 但「会话挂载过一次」不等于「已经读过盘」，两者必须分开：
 *   - loadState 仍是 undefined（本次挂载从未发起/拿到读盘结论）→ 不得跳过。缓存里的空
 *     runtime 投影不是终态：重启换代把旧窗口替换成空数组后，只有读盘能把它推到
 *     ready（历史/空会话）或 error（错误卡片），否则骨架屏永驻（Issue #350）。
 *   - loadState 已 settled 且缓存条目被 8-LRU 整体淘汰（undefined）→ 不得跳过，重读自愈
 *     （2026-12 回归修复）；条目仍在时以已有磁盘结论为准，不因 runtime 重写条目重读。
 */
export function shouldSkipInitialDiskRead(input: { previouslyLoaded: boolean; cachedEntry: { source: "disk" | "runtime"; messages: readonly unknown[] } | undefined; knownEmpty: boolean; loadStateStatus: SessionLoadState["status"] | undefined }): boolean {
	if (shouldSkipInitialDiskLoad(input.cachedEntry, input.knownEmpty)) return true;
	// 首次挂载到本会话：是否读盘完全由缓存权威性决定（与旧行为一致）。
	if (!input.previouslyLoaded) return false;
	// 从未读盘：空 runtime 投影必须核实（Issue #350 的核心）。
	if (input.loadStateStatus === undefined) return false;
	// 读盘在途：等结果，不重复发起（缓存条目可能已被 runtime flush 重建）。
	if (input.loadStateStatus === "loading") return true;
	// 已 settled：条目消失（LRU 淘汰）→ 重读自愈；条目仍在 → 以磁盘结论为准。
	return input.cachedEntry !== undefined;
}

export function isLatestTimelineRunBusy(isAgentBusy: boolean, index: number, runCount: number): boolean {
	return isAgentBusy && index === runCount - 1;
}

export type SessionTimelineController = {
	timelineRef: RefObject<HTMLElement | null>;
	messages: ChatMessage[];
	visibleMessages: ChatMessage[];
	totalMessageCount: number;
	hasMoreMessages: boolean;
	/** 下一次「加载更多」触发 disk 轮次分页（渲染窗口已耗尽且窗口前还有历史） */
	nextLoadIsHistory: boolean;
	isLoadingMoreMessages: boolean;
	/** 上一次「加载更多」失败原因（原始 IPC 文案）；null = 无错误。时间线在按钮下方出失败行并允许直接重试。 */
	loadMoreError: string | null;
	/** 补页后保持当前视口（新历史只出现在上方）。所有入口统一，不再有「新页直接出现」的跳动。 */
	loadMoreMessages: (source?: "scroll" | "button") => void;
	/** 标记一次程序化滚动（turn 窗口展开补偿等组件内补偿用），抑制历史意图消费。
	 *  durationMs > 0 时按时间窗口抑制（连续 smooth scroll 会派发多个 scroll 事件）。 */
	markProgrammaticScroll: (durationMs?: number) => void;
	/**
	 * 顶部插入（扩窗/翻页）后钉住当前视口：走引擎 restoreAt（定位 + 解锁 + ignoreScrollToTop）。
	 * 引擎未挂上时回退原生 scrollTop。
	 */
	pinViewportAfterPrepend: (nextTop: number) => void;
	/**
	 * 浏览态：按钉住的那一轮相对视口顶的漂移补 scrollTop。
	 * 扩窗 / 翻页 / Markdown 后排版共用；跟随时无操作。人手滚动不会走这条。
	 */
	pinBrowseRow: () => void;
	jumpToMessage: (messageId: string) => void;
	scrollToBottom: () => void;
	/** Receives wheel input from the sibling outline rail without bypassing timeline scroll ownership. */
	scrollTimelineBy: (deltaY: number) => void;
	/** 最新轮自动收起后，不再自动调整滚动位置——历史滚动只发生在「发送那一刻」，
	 *   保持这个 API 只是为兼容旧调用处；实现为空操作。 */
	scrollFinalAnswerToUpperMiddle: (runId: string) => void;
	/** 滚动回调（MessageScroller viewport 接线）：维护会话切换的滚动锚点。 */
	handleTimelineScroll: () => void;
	autoScroll: boolean;
	showScrollToBottom: boolean;
	/** 由 MessageScroller 汇报用户是否仍在实时尾部，避免两套滚动监听互相抢占。 */
	setAutoScrollFromScroller: (following: boolean) => void;
	/**
	 * 引擎上报的用户滚动意图（wheel/触摸/滚动条真实输入）：
	 * 近顶部自动扩窗/预取只消费该意图，布局 resize/clamp 不算用户上滑。
	 * source 区分真实输入与 scroll 派生：只有真实输入才终止在途定位动画。
	 */
	setUserScrollIntent: (intent: "up" | "down", source?: "scroll" | "input") => void;
	/** 新 run 开始（busy 边沿）：旧实现用来取消完结定位动画；现已删除该动画，
	 *  保留同签名避免外部调用处崩溃。 */
	cancelSettledRepositionForNewRun: () => void;
	/**
	 * 挂到 MessageScroller 的 stick-to-bottom 引擎 API（回底弹簧）。
	 * 未挂上时 scrollToBottom 退化为原生 scrollTo。
	 */
	scrollerScrollApiRef: RefObject<MessageScrollerScrollApi | null>;
	/** 上滚查看历史时的渲染窗口轮数（贴底时渲染层用 TIMELINE_MOUNTED_TURN_LIMIT，忽略此值）。
	 *  2026-08 黑屏治理：历史不再全量放开挂载，窗口随「显示更早」逐步扩大。 */
	scrolledWindowTurns: number;
	/** 扩大上滚渲染窗口（每次最多 +3 轮）；数据翻页与本地 DOM 扩展使用同一 cohort。 */
	expandWindow: () => void;
	/**
	 * 上滚渲染窗口是否仍可扩展（由渲染层同步 turnWindowActive：已加载数据未被全部挂载）。
	 * 滚动监听读它决定「先扩窗口」还是「翻数据页」（方案 C 渐进扩展，2026-12）。
	 */
	windowExpandableRef: RefObject<boolean>;
	/**
	 * 磁盘消息尚未就绪（含挂载首帧 loadStatus 未写入）。
	 * SessionView 用它在历史会话加载期仍挂底部 composer，避免 1 面板 Group 吃到 2 值布局缓存。
	 */
	isSurfaceLoading: boolean;
	/**
	 * 恢复锚点 / 挂起跳转在途时为 true：这两条路径按 [data-message-id] 查 DOM，
	 * 虚拟区外的行不在 DOM 里 —— 期间必须整表真实渲染。
	 */
	navBlockingVirtualization: boolean;
	/** 本栏粘住的空会话：预热写 filePath/dshSessionId 后仍不闪历史骨架。 */
	knownEmpty: boolean;
	/**
	 * 强制从磁盘重载本会话时间线（编辑/删除/重发改 JSONL 后）。
	 * 绕过「已加载 + 有缓存就跳过」和 runtime 缓存守卫。
	 */
	reloadFromDisk: () => Promise<void>;
	/**
	 * DSH host 被手动停止时的恢复入口：先显式启动 host（唯一能解开手动停止标记的
	 * 路径），再重载本会话历史。返回是否启动成功；false 时调用方给用户提示。
	 */
	startDshHostAndReload: () => Promise<boolean>;
};

export function useSessionTimelineController(options: { sessionId?: string; messages?: ChatMessage[] }): SessionTimelineController {
	const ownerKey = options.sessionId ?? LEGACY_OWNER_KEY;
	const timelineRef = useRef<HTMLElement | null>(null);
	const ownerKeyRef = useRef(ownerKey);
	ownerKeyRef.current = ownerKey;
	// 切换恢复时读滚动锚点快照用（不订阅：恢复后滚动写 atom 不打扰已恢复的视口）
	const store = useStore();
	const cacheSliceAtom = useMemo(() => selectAtom(sessionMessagesCacheAtom, (cache) => (options.sessionId ? cache[options.sessionId]?.messages : undefined), Object.is), [options.sessionId]);
	const cachedMessages = useAtomValue(cacheSliceAtom);
	const messages = options.messages ?? cachedMessages ?? [];
	const controllerEnabled = options.sessionId !== undefined && options.messages === undefined;

	// ── 会话切换滚动位置保持（状态即真相）──
	// 滚动节流直接写 per-session atom（内容不变跳过 → 引用稳定 → 零订阅重渲染）；
	// 恢复 = 切换时从 atom 读一次快照执行，不订阅（后续滚动写 atom 不打扰已恢复的视口）。
	const saveScrollAnchor = useSetAtom(saveSessionScrollAnchorAtom);
	// 最后已知锚点缓存：供 cleanup 兜底落盘（250ms 节流窗口内切走不丢）。
	// 不能用 cleanup 读 DOM——会话切换复用同一组件实例（无 key），cleanup 执行时
	// timeline 的 children 可能已替换为新会话消息，读 DOM 会串数据。
	const currentAnchorRef = useRef<SessionScrollAnchor | null>(null);
	/** 与锚点一起保存：DOM 裁剪窗口是阅读位置的一部分，而非瞬时 UI 状态。 */
	const renderedWindowTurnsRef = useRef(TIMELINE_SCROLLED_TURN_LIMIT);
	const scrollAnchorFrameRef = useRef<number | undefined>(undefined);
	/** 最近一次 scroll 事件的可见行快照：rAF 里的锚点重算复用它，不再读第二遍布局。 */
	const scrollVisibleRowsRef = useRef<readonly VisibleTimelineRow[]>([]);
	const scrollSaveTimerRef = useRef<number | undefined>(undefined);

	// 浏览钉行元素缓存（2027-02 性能审计）：measureBrowsePinViewportTop 走全子树
	// 属性选择器（O(挂载子树)），而浏览态 ResizeObserver 在内容每次增高（流式正文、
	// 图片加载、Markdown 轻量→全量）时都回调 pinBrowseRow——等于每帧一次全子树扫描。
	// 钉行期间行元素不变，缓存后热路径只读两处 rect；行被卸载（折叠/扩窗重建/切会话）
	// 时 isConnected 失效，自动回退一次重查。与 issue #400 的「可见行缓存」互补：
	// 那是找新钉行（findBrowsePin），这是盯住已钉行，互不重叠。
	const pinnedRowElRef = useRef<{ id: string; element: HTMLElement } | null>(null);
	const measurePinnedRowTop = useCallback((timeline: HTMLElement, messageId: string): number | null => {
		const cached = pinnedRowElRef.current;
		if (cached && cached.id === messageId && cached.element.isConnected) {
			return cached.element.getBoundingClientRect().top - timeline.getBoundingClientRect().top;
		}
		const element = timeline.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`) as HTMLElement | null;
		if (!element) return null;
		pinnedRowElRef.current = { id: messageId, element };
		return element.getBoundingClientRect().top - timeline.getBoundingClientRect().top;
	}, []);

	/**
	 * 计算当前视口锚点（纯读取，不落盘）。
	 * 规则：在底部跟流 → null（切回继续跟底）；查看历史 → 记录
	 * 「视口顶部的第一条消息行 + 距视口顶偏移 + 分页窗口」。
	 * 优先选 user-turn / turn-row 根节点：工具卡、思考步骤等嵌套 data-message-id
	 * 会在执行过程自动收起时卸载；把它们作为锚点会使切回只能降级到顶部。
	 */
	// 视口内的行（O(视口)）：滚动热路径只读这一份缓存，不再全量遍历 DOM
	const { readVisibleRows } = useVisibleTimelineRows(timelineRef);
	const readVisibleRowsRef = useRef<() => VisibleTimelineRow[]>(() => []);
	useEffect(() => {
		readVisibleRowsRef.current = readVisibleRows;
	}, [readVisibleRows]);

	/**
	 * @param visibleRowsArg 本次 scroll 事件已读好的可见行快照。undefined = 自己读一次；
	 *   同一事件里锚点与浏览钉共用一份，避免每帧两次 O(视口) 布局读取。
	 */
	const computeCurrentAnchor = useCallback((visibleRowsArg?: readonly VisibleTimelineRow[]): SessionScrollAnchor | null => {
		const timeline = timelineRef.current;
		if (!timeline) return null;
		if (isTimelineAtBottom(timeline.scrollTop, timeline.scrollHeight, timeline.clientHeight)) {
			return null;
		}
		// 快路径：只对视口内的行取布局（O(视口)）。原来这里要跑两轮 querySelectorAll +
		// 每行 getBoundingClientRect，窗口越大越慢——「越滚越慢」的直接来源。
		const visibleRows = visibleRowsArg ?? readVisibleRowsRef.current();
		// 只有「视口内有轮根」才走快路径。没有轮根时必须回落到下面的全量扫描：
		// 原实现是在**全文档**里找第一条底部进入视口的轮根（可能在视口下方）；
		// 直接降级到视口内的任意非轮根行（系统消息、日期分隔）会改变锚点语义，
		// 且这类行更容易被窗口裁剪，恢复时只能降级到顶部（评审 d#1）。
		const anchorRow = pickVisibleRootRow(visibleRows);
		if (anchorRow) {
			return {
				messageId: anchorRow.id,
				offsetTop: anchorRow.top,
				windowTurns: renderedWindowTurnsRef.current,
				savedAt: Date.now(),
			};
		}
		const viewportTop = timelineViewportTop(timeline);
		const findAnchor = (rows: NodeListOf<HTMLElement>): SessionScrollAnchor | null => {
			for (const row of rows) {
				const rect = row.getBoundingClientRect();
				if (rect.bottom < viewportTop + 1) continue;
				const messageId = row.dataset.messageId ?? "";
				if (!messageId) continue;
				return {
					messageId,
					// 保留负偏移：视口顶部常被上一行底部占据（行顶在视口上方），
					// 截断为 0 会导致恢复时把行顶对齐视口顶、整体位置偏下（高大行偏差明显）。
					// 恢复侧 scrollTop = max(0, elTop - offsetTop) 已兜底负值。
					offsetTop: rect.top - viewportTop,
					// 当前轮次窗口必须随锚点保存。切回时只恢复 scrollTop 而不先挂回这些
					// turn，会导致 querySelector 找不到锚点并错误降级到底部。
					windowTurns: renderedWindowTurnsRef.current,
					savedAt: Date.now(),
				};
			}
			return null;
		};
		const stableAnchor = findAnchor(timeline.querySelectorAll<HTMLElement>(ROOT_ROW_SELECTOR));
		if (stableAnchor) return stableAnchor;
		// 诊断卡等没有稳定轮根节点时仍可恢复，避免空会话/特殊事件完全失去锚点。
		return findAnchor(timeline.querySelectorAll<HTMLElement>("[data-message-id]"));
	}, []);

	/** 把当前锚点写入 atom（节流）。内容未变化由 atom 侧跳过，引用保持稳定。 */
	const persistCurrentAnchor = useCallback(
		(sessionId: string) => {
			scrollSaveTimerRef.current = undefined;
			saveScrollAnchor({ sessionId, anchor: currentAnchorRef.current });
		},
		[saveScrollAnchor],
	);

	/** 透传给 MessageScroller viewport 的滚动回调（SessionMessageTimeline 接线）。
	 *  同步快照保证同一事件帧切走时仍有旧 DOM 的锚点；rAF 只合并后续重算与
	 *  250ms 持久化，避免将性能节流错误地用在跨会话正确性边界上。 */
	const handleTimelineScroll = useCallback(() => {
		const sessionId = ownerKeyRef.current;
		if (!sessionId || sessionId === LEGACY_OWNER_KEY) return;
		// A tab/sidebar selection can synchronously replace this timeline before the
		// next animation frame. Capture the old DOM while the scroll event still
		// owns it; the layout-effect cleanup must never inspect post-switch nodes.
		// The rAF below still coalesces the settled position and atom persistence.
		// 同一 scroll 事件只读一次可见行：锚点与浏览钉共用这份快照，rAF 里的
		// 第二次锚点计算也复用它，不再重复读布局。
		// 贴底跟流时 computeCurrentAnchor 直接返回 null，此时不读缓存——流式输出的
		// 每个 scroll 都不能为一份用不上的快照付 O(视口) 的布局读取。
		const timeline = timelineRef.current;
		const visibleRows = timeline && !isTimelineAtBottom(timeline.scrollTop, timeline.scrollHeight, timeline.clientHeight) ? readVisibleRowsRef.current() : [];
		scrollVisibleRowsRef.current = visibleRows;
		currentAnchorRef.current = computeCurrentAnchor(visibleRows);
		// restoreAt / 扩窗补偿派发的 scroll：只更新冻住那一行的 expected，不改钉到新的第一可见行。
		if (!isProgrammaticScrollActive(programmaticScrollGuardRef.current, performance.now()) && !autoScrollRef.current) {
			if (browsePinFrozenRef.current && browsePinRef.current) {
				const pinnedTimeline = timelineRef.current;
				const top = pinnedTimeline ? measurePinnedRowTop(pinnedTimeline, browsePinRef.current.messageId) : null;
				browsePinRef.current = followBrowsePinAfterUserScroll(browsePinRef.current, top);
			} else {
				browsePinRef.current = findBrowsePin(timelineRef.current, visibleRows);
			}
		}
		if (scrollAnchorFrameRef.current != null) return;
		scrollAnchorFrameRef.current = requestAnimationFrame(() => {
			scrollAnchorFrameRef.current = undefined;
			// 回调执行时若已切走（ownerKeyRef 已更新），丢弃——旧会话状态由 cleanup 落盘。
			if (ownerKeyRef.current !== sessionId) return;
			// 快照是 scroll 事件那一刻的几何；rAF 在本帧提交 / 流式增量之后才跑，行高与
			// 插入位置可能已经变了 —— 直接复用会把过期坐标写成锚点（切回会话时位置偏）。
			// 这里重读当前可见行；事件内「锚点 + 浏览钉共用一份快照」的优化仍然保留。
			scrollVisibleRowsRef.current = readVisibleRowsRef.current();
			currentAnchorRef.current = computeCurrentAnchor(scrollVisibleRowsRef.current);
			// 节流写 atom：只排一个 timer，期间连续滚动不重复写；
			// 内容未变时 atom 侧跳过（引用稳定，订阅者零重渲染）。
			if (scrollSaveTimerRef.current != null) return;
			scrollSaveTimerRef.current = window.setTimeout(() => {
				persistCurrentAnchor(sessionId);
			}, 250);
		});
	}, [computeCurrentAnchor, persistCurrentAnchor]);

	// ── Load messages from disk when sessionId changes ──
	// 只订本会话缓存条目（family selectAtom 隔离）：其它会话的消息到达/分页不拖着重渲染本栏。
	const cachedEntry = useAtomValue(options.sessionId ? sessionMessageCacheBySessionIdAtomFamily(options.sessionId) : NO_CACHE_ENTRY_ATOM);
	const cacheMessages = useSetAtom(cacheSessionMessagesAtom);
	const prependMessagePage = useSetAtom(prependSessionMessagePageAtom);
	const prependHistoryPage = useSetAtom(prependSessionHistoryPageAtom);
	const setLoadState = useSetAtom(setSessionMessageLoadStateAtom);
	const touchMessages = useSetAtom(touchSessionMessagesAtom);
	// 订阅收窄：整表订阅 sessionMessageLoadStateAtom 会让本栏在**任何**会话的加载
	// 状态变化时重渲染（分屏下每栏各放大一次）；只取本会话 status 切片
	// （与上方 cacheSliceAtom 同一模式，status 为原始值，Object.is 相等即不重渲染）。
	const loadStateStatusAtom = useMemo(() => selectAtom(sessionMessageLoadStateAtom, (states) => (options.sessionId ? states[options.sessionId]?.status : undefined)), [options.sessionId]);
	const loadStateStatus = useAtomValue(loadStateStatusAtom);
	const lastLoadedSessionRef = useRef<string | undefined>(undefined);
	const sessionRecord = useAtomValue(sessionRecordByIdAtomFamily(options.sessionId ?? ""));
	const knownEmptyFromRecord = isKnownEmptySessionRecord(sessionRecord);
	// 空会话粘性（跨挂载）：新建会话输入一半切走再切回时，hook 实例已销毁重建，
	// 旧的 useRef 粘性会丢失。若此时预热已写入 filePath/dshSessionId，knownEmptyFromRecord
	// 仍为 true（draft 始终 true），但对非 draft 的匿名/活跃空会话也需保持起始页，
	// 避免切回时变骨架、输入框从居中跳到底部（用户反馈）。
	const stickySessionId = options.sessionId;
	if (stickySessionId) {
		if (messages.length > 0) {
			stickyEmptySessionIds.delete(stickySessionId);
		} else if (knownEmptyFromRecord) {
			addStickyEmptySession(stickySessionId);
		}
	}
	const knownEmpty = Boolean(stickySessionId && (knownEmptyFromRecord || stickyEmptySessionIds.has(stickySessionId)));
	// 与 SessionMessageTimeline 同一套 deriveSessionSurfaceRuntime：历史会话首帧
	// messages 仍为空时视为加载中，底部 composer 不能卸掉。空草稿除外——
	// 新建/切回空会话必须留在起始页，不能先挂底部栏再卸（输入框上跳）。
	const isSurfaceLoading = deriveSessionSurfaceRuntime(messages.length, loadStateStatus, undefined, undefined, undefined, Boolean(cachedEntry), knownEmpty).isLoading;

	// useLayoutEffect 而非 useEffect：loading 状态必须在首帧 paint 之前写入，
	// 否则被动 effect 先于 loading 绘制一帧「空会话」→ 有历史的会话会闪出起始页。
	useLayoutEffect(() => {
		const sessionId = options.sessionId;
		if (!sessionId) return;
		// 触达缓存条目时提升 LRU 活跃度：读缓存不会自 touch（只有写会），
		// 不 touch 会让显示中的会话长期停在 LRU 尾部，稍几次其它会话写入就被挤出，
		// 切回时重读盘闪骨架（历史行为 155338e5 引入，缓存结构重建时丢失）。
		if (cachedEntry) touchMessages(sessionId);
		const previouslyLoaded = lastLoadedSessionRef.current === sessionId;
		if (!previouslyLoaded) lastLoadedSessionRef.current = sessionId;
		// 跳过初始读盘 = 缓存已是权威终态（草稿/非空内容/磁盘空应答），或本次挂载已经发起/
		// 拿到读盘结论（runtime 节流 flush 会不断重建缓存条目，不能每次都重读）。
		// 切会话复用同一 hook 实例（solo 栏无 sessionId key）：已有**真实内容**时不要把
		// loadState 打成 loading；但空 runtime 投影（主进程读盘失败/重启换代下发 0 条、
		// 或历史加载被取消）覆盖旧窗口后必须读盘核实，否则骨架屏永驻
		// （2026-10-08 fork/copy 现场、Issue #350）。
		if (shouldSkipInitialDiskRead({ previouslyLoaded, cachedEntry, knownEmpty, loadStateStatus })) return;

		const sequence = ++nextLoadSequence;
		trackLatestLoad(sessionId, sequence);
		setLoadState({ sessionId, state: { status: "loading" } });

		void desktopApi.sessions
			.readRecordMessagePage(sessionId, undefined, DISK_INITIAL_TURN_PAGE_SIZE)
			.then((page: SessionMessagePage) => {
				if (latestLoadBySession.get(sessionId) !== sequence) return;
				// DSH host 被手动停止：历史暂时读不了——不是空历史、也不是会话文件失效。
				// 必须进专态而不是写空缓存，写缓存会把它显示成空会话 + 起始页，
				// 用户看到「这个会话没了」而真实原因是运行时被自己停了（2026-09 反馈）。
				const unavailable = sessionHistoryUnavailableState(page);
				if (unavailable) {
					setLoadState({ sessionId, state: unavailable });
					return;
				}
				cacheMessages({
					sessionId,
					messages: page.messages,
					source: "disk",
					expectedRevision: 0,
					page: sessionDiskPageCursor(page),
				});
				setLoadState({ sessionId, state: { status: "ready" } });
			})
			.catch((error: unknown) => {
				if (latestLoadBySession.get(sessionId) !== sequence) return;
				setLoadState({
					sessionId,
					state: {
						status: "error",
						error: error instanceof Error ? error.message : String(error),
					},
				});
			});
	}, [options.sessionId, cachedEntry, knownEmpty, loadStateStatus]);

	const reloadFromDisk = useCallback(async () => {
		const sessionId = options.sessionId;
		if (!sessionId) return;
		const sequence = ++nextLoadSequence;
		trackLatestLoad(sessionId, sequence);
		setLoadState({ sessionId, state: { status: "loading" } });
		try {
			const page = await desktopApi.sessions.readRecordMessagePage(sessionId, undefined, DISK_INITIAL_TURN_PAGE_SIZE);
			if (latestLoadBySession.get(sessionId) !== sequence) return;
			// 与首屏同源：手动停止态下重试仍不会成功，保持专态
			//（否则「重试」会把错误态洗成空会话，又回到用户看到的错误方向）。
			const unavailable = sessionHistoryUnavailableState(page);
			if (unavailable) {
				setLoadState({ sessionId, state: unavailable });
				return;
			}
			cacheMessages({
				sessionId,
				messages: page.messages,
				source: "disk",
				expectedRevision: 0,
				page: sessionDiskPageCursor(page),
				force: true,
			});
			setLoadState({ sessionId, state: { status: "ready" } });
		} catch (error: unknown) {
			if (latestLoadBySession.get(sessionId) !== sequence) return;
			setLoadState({
				sessionId,
				state: {
					status: "error",
					error: error instanceof Error ? error.message : String(error),
				},
			});
			throw error;
		}
	}, [cacheMessages, options.sessionId, setLoadState]);

	/**
	 * DSH host 被手动停止时的恢复入口（时间线专态的「启动 host 并重试」）。
	 *
	 * 为什么不能只重试读盘：手动停止态不会自愈——预热 / 按需兜底 / 崩溃重启 /
	 * runtime 安装恢复全被 isManualStopped 门控拒掉（见 dshManualStop），只有用户
	 * 显式 startDshHost（主进程清标记后 boot）才能恢复。所以先启动、再重载。
	 */
	const startDshHostAndReload = useCallback(async () => {
		// 启动失败不抛：保持专态等用户再点（真正原因会由后续读盘的错误态/日志暴露）。
		const started = await desktopApi.sessions.startDshHost().catch(() => false);
		if (!started) return false;
		// reloadFromDisk 失败会自行写 error 态并 rethrow，这里不重复上报。
		await reloadFromDisk().catch(() => undefined);
		return true;
	}, [reloadFromDisk]);

	const diskPage = controllerEnabled && cachedEntry?.source === "disk" ? cachedEntry.page : undefined;
	// ── 激活显示窗口（2026-08 激活分页）──
	// runtime 窗口会话：显示数组 = disk 历史前缀（轮次页 prepend）+ 运行时窗口段。
	// 前缀与窗口段是两个下标空间，仅在渲染层按顺序拼接，合并/去重由 atoms 保证。
	const runtimeHistory = controllerEnabled && cachedEntry?.source === "runtime" ? cachedEntry.history : undefined;
	const combinedMessages = useMemo(() => (runtimeHistory ? [...runtimeHistory.messages, ...messages] : messages), [runtimeHistory, messages]);
	// 窗口前还有历史可加载：已加载前缀看游标（数值或 entryId），未加载看窗口起点（>0 说明激活时被截断）。
	// slideOut 单独重建前缀时 nextBefore 可能为 null，但 nextBeforeEntryId 仍指向更早锚点，
	// 不能把这种前缀误判为「已经到最早」。
	const historyHasMore = controllerEnabled && cachedEntry?.source === "runtime" ? (runtimeHistory ? runtimeHistory.nextBefore !== null || Boolean(runtimeHistory.nextBeforeEntryId) : (cachedEntry.windowStart ?? 0) > 0) : false;
	// 2026-11 轮次模型：不再按 100 条分页器切片，显示数组 = 已加载全部（历史前缀 + 运行时窗口段）。
	// 内存预算由主进程 12 轮缓存 + 回底临时历史清理承担，渲染层不再有第二道条数窗口。
	const visibleMessages = combinedMessages;
	const [isLoadingMessagePage, setIsLoadingMessagePage] = useState(false);
	/**
	 * 「加载更多对话」失败态：IPC 抛错（DSH host 不可用 / 会话文件失效）原先没人接，
	 * finally 只复位 loading，表现为「点了没反应」。这里留原始文案给时间线出错误行。
	 */
	const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
	// This snapshot is intentionally read during render. In the reused solo pane,
	// waiting for a passive effect would let MessageScroller commit the previous
	// session's follow mode before the target session's anchor is materialized.
	const sessionAnchorSnapshot = options.sessionId ? store.get(sessionScrollAnchorByIdAtom)[options.sessionId] : undefined;
	const initialRestoreState = resolveSessionTimelineRestoreState(sessionAnchorSnapshot);
	const [autoScroll, setAutoScroll] = useState(() => initialRestoreState.autoScroll);
	const [showScrollToBottom, setShowScrollToBottom] = useState(() => initialRestoreState.showScrollToBottom);
	/** Anchor snapshot is frozen for one session-switch restoration attempt. */
	const [restoreAnchor, setRestoreAnchor] = useState<SessionScrollAnchor | undefined>(() => sessionAnchorSnapshot);
	const [restorePhase, setRestorePhase] = useState<"pending" | "complete">("pending");
	// 与 autoScroll 初始值保持一致（有锚点的会话首帧即不跟底），避免首帧 ref/state 不一致
	const autoScrollRef = useRef(autoScroll);
	const programmaticScrollGuardRef = useRef(createProgrammaticScrollGuard());
	/**
	 * 历史浏览代数：回底/切会话时递增。在途历史分页与扩窗任务捕获发起时代数，
	 * 返回时若已过期只允许写缓存，不得再驱动 DOM 扩窗/锚点恢复（迟到结果
	 * 把刚回底的视口重新拉回历史模式的根因防护）。
	 */
	const historyBrowseGenerationRef = useRef(0);
	/**
	 * 已确认的向上输入在下一帧消费：wheel 回调早于浏览器默认滚动，而
	 * scrollbar/touch 的回调晚于 scroll；统一到一帧后读取位置，避免事件顺序竞态。
	 */
	const userScrollIntentFrameRef = useRef<number | undefined>(undefined);
	const settleScrollCancelRef = useRef<(() => void) | undefined>(undefined);
	/** 发送定位只比较 user 身份变化；首帧/切会话取基线，不重播历史消息。 */
	const sendScrollRef = useRef(new SendScrollPositioner());
	const sendMessageBaselineRef = useRef<{ ownerKey: string; messageId: string | undefined } | undefined>(undefined);
	/**
	 * 恢复阶段收到的用户提交：先挂起，等 restorePhase 完成再补一次发送定位。
	 *
	 * DSH 新会话（引导页首发 / host 冷启动）会在面板完成历史恢复前就把乐观气泡写进
	 * 缓存——旧实现只在这一帧记基线，之后 id 不再变化，整段「发送平滑置顶」被吞掉。
	 * 只登记发送态 in-flight（activating/sending）的变化，避免把冷会话读盘塞进来的
	 * 历史末条误当成一次发送（那会重播历史定位）。
	 */
	const pendingSendScrollRef = useRef<{ ownerKey: string; messageId: string } | undefined>(undefined);
	/** 已做过发送定位的消息：in-flight 发送态会在多次 render 里持续成立，不能重复播动画。 */
	const positionedSendMessageRef = useRef<string | undefined>(undefined);
	/**
	 * 发送置顶动画进行中标记（session 级 atom）：TurnRow 的「新一轮折叠」据此等动画
	 * 结束再收起上一轮——动画中收起会让上方内容骤缩，视口补偿把 scrollTop 往回带，
	 * 用户看到「先向上再向下」的来回滚动（2026-10 反馈）。
	 */
	const setSendPinAnimating = useCallback(
		(active: boolean) => {
			const sessionId = options.sessionId;
			if (!sessionId) return;
			store.set(sendPinAnimatingByIdAtom, (prev) => (prev[sessionId] === active ? prev : { ...prev, [sessionId]: active }));
		},
		[options.sessionId, store],
	);
	const scrollerScrollApiRef = useRef<MessageScrollerScrollApi | null>(null);
	const loadMoreAnchorRef = useRef<Tagged<TimelineAnchor> | undefined>(undefined);
	/** 浏览态钉行：扩窗/翻页前冻住正在看的那一轮，布局变高时按漂移补位置。 */
	const browsePinRef = useRef<BrowsePin | null>(null);
	/** 钉行的 messageId 冻结中：补偿完成前不要改钉到「当前第一可见行」（那会是刚插进来的更早轮）。 */
	const browsePinFrozenRef = useRef(false);
	/** 刻度跳转进行中：不要钉浏览行，否则会把刚跳到的目标拽回旧视口。 */
	const skipBrowsePinRef = useRef(false);
	/**
	 * 挂起的跳转：expandAttempts/loadAttempts 分别驱动指数兜底扩窗与补页防呆
	 * （策略见 timeline/jumpWindowPolicy）。必须是 state 而非 ref——ref 赋值不会
	 * 调度 effect，第二跳时（autoScroll 已断、状态无变化）点击会完全无反应；
	 * nonce 保证连续点击同一目标也会重跑。
	 */
	const [pendingJump, setPendingJump] = useState<Tagged<{ messageId: string; expandAttempts: number; loadAttempts: number; nonce: number }> | undefined>(undefined);
	const jumpNonceRef = useRef(0);
	/**
	 * 跳转揭示：目标消息已加载但 DOM 节点没挂载时（命中在已完成轮的执行过程折叠区里，
	 * 折叠收起会把中间回答/工具整块卸载），先让包含它的 TurnRow 展开折叠，再走既有
	 * pendingJump 重试循环完成落位。按会话隔离，切会话/跳转结算后清空。
	 */
	const revealSessionId = options.sessionId;
	const requestRevealWrite = useSetAtom(requestTimelineRevealAtom);
	const clearRevealWrite = useSetAtom(clearTimelineRevealAtom);
	const requestTimelineReveal = useCallback(
		(messageId: string) => {
			if (!revealSessionId || !messageId) return;
			requestRevealWrite({ sessionId: revealSessionId, messageId });
		},
		[requestRevealWrite, revealSessionId],
	);
	const clearTimelineReveal = useCallback(() => {
		if (!revealSessionId) return;
		clearRevealWrite(revealSessionId);
	}, [clearRevealWrite, revealSessionId]);
	/** 旧实现中新增 run 开始的「取消完结动画并立即跟随」逻辑已随服务完结定位一起删除。
	 *  保留同名为 no-op，防调用处崩溃；所有自动滚动只在发送那一刻。 */
	const cancelSettledRepositionForNewRun = useCallback(() => {
		settleScrollCancelRef.current?.();
		settleScrollCancelRef.current = undefined;
	}, []);
	const highlightTimersRef = useRef(new Map<number, number>());
	// ── 上滚渲染窗口（2026-08 黑屏治理）──
	// 贴底和上滚初始都只挂 3 轮；每次接近顶部最多扩一个 3 轮 cohort，
	// 先消费 atom 已有的尾部 9 轮，再进入主进程缓存/文件分页。回底开始新的浏览周期。
	const [scrolledWindowTurns, setScrolledWindowTurns] = useState(() => initialRestoreState.scrolledWindowTurns);
	const [viewStateOwnerKey, setViewStateOwnerKey] = useState(ownerKey);
	/**
	 * 锚点保存的窗口必须与当前 DOM 使用的窗口完全一致：跟随态始终是尾部 3 轮，
	 * 即使 scrolledWindowTurns 尚未被回底 effect 复位，也不能把过期的大窗口写进锚点。
	 */
	const effectiveWindowTurns = autoScroll ? TIMELINE_MOUNTED_TURN_LIMIT : scrolledWindowTurns;
	/** 保存旧 owner 时不能读已经指向新会话的 render ref，故保留最后一次 layout 提交值。 */
	const ownerWindowTurnsRef = useRef(new Map<string, number>());
	// owner 切换的 render 里 DOM 还是旧会话；此时把 ref 改成新会话的窗口，
	// cleanup 保存旧会话锚点就会带错窗口（实测 9 → 3，切回只挂 3 轮，虚拟区锚点行不在 DOM）。
	// 只在 owner 已同步时更新：ref 的语义是「当前 DOM 会话实际渲染的窗口」。
	if (viewStateOwnerKey === ownerKey) renderedWindowTurnsRef.current = effectiveWindowTurns;

	// React re-renders this owner before committing children, so the target
	// session's follow mode and turn window reach MessageScroller atomically.
	if (viewStateOwnerKey !== ownerKey) {
		const nextRestoreState = resolveSessionTimelineRestoreState(sessionAnchorSnapshot);
		// 被复用的 pane 在 passive effect 前就可能收到旧分页结果；generation 必须
		// 与目标会话的 follow 快照一起在 render 阶段切换，旧 owner 只能继续写缓存。
		historyBrowseGenerationRef.current += 1;
		loadMoreAnchorRef.current = undefined;
		setViewStateOwnerKey(ownerKey);
		setRestoreAnchor(sessionAnchorSnapshot);
		setRestorePhase("pending");
		autoScrollRef.current = nextRestoreState.autoScroll;
		setAutoScroll(nextRestoreState.autoScroll);
		setShowScrollToBottom(nextRestoreState.showScrollToBottom);
		setScrolledWindowTurns(nextRestoreState.scrolledWindowTurns);
		// 会话切换：发送定位与任何残留动画一律作废，不得把旧会话的动画带到新会话。
		sendScrollRef.current.reset();
		pendingSendScrollRef.current = undefined;
		positionedSendMessageRef.current = undefined;
		settleScrollCancelRef.current?.();
		settleScrollCancelRef.current = undefined;
	}
	/** 窗口是否仍可扩展（由 SessionMessageTimeline 按 turnWindowActive 同步，渲染期写入）。 */
	const windowExpandableRef = useRef(false);
	/** 自动扩窗口冷却时间戳（防惯性滚动接近顶部时连扩多轮）。 */
	const lastWindowExpandAtRef = useRef(0);
	/** 自动翻页冷却时间戳；回底开始新浏览事务时同步清零。 */
	const lastHistoryLoadAtRef = useRef(0);
	/** 分批扩展（2026-12 层次 1）：滚动触发的扩展拆成多帧小批挂载，避免 3 轮 cohort 同步渲染掉帧。
	 *  pendingTurns = 待消费的扩展轮数；rAF 每帧消费一小批直到归零；
	 *  新请求到来时累加（不丢、不重复计数）。滚动监听与刻度跳转共用：
	 *  跳转按目标轮次一次排满批次（estimateJumpExpandTurns）分帧挂载，不卡单帧，
	 *  批次消费完前 pendingJump effect 挂起等待；「显示更早」按钮仍走原子 expandWindow（低频操作）。 */
	const pendingExpandTurnsRef = useRef(0);
	const expandBatchFrameRef = useRef<number | undefined>(undefined);
	const consumeExpandBatch = useCallback(() => {
		expandBatchFrameRef.current = undefined;
		if (pendingExpandTurnsRef.current <= 0) return;
		// 已回底（回底按钮/手动滚回底部）：批次作废。回底会触发窗口 6→3 轮收回，
		// 是一次大幅内容收缩；若此时继续消费批次，会把刚收回的窗口又扩回去
		// （回底后按钮反复出现、滚到底跟着就掉开的根因之一）。
		if (autoScrollRef.current) {
			pendingExpandTurnsRef.current = 0;
			return;
		}
		const batch = Math.min(TURN_WINDOW_EXPAND_BATCH_TURNS, pendingExpandTurnsRef.current);
		pendingExpandTurnsRef.current -= batch;
		setScrolledWindowTurns((prev) => prev + batch);
		if (pendingExpandTurnsRef.current > 0) {
			// 还有剩余：下一帧继续消费，摊平布局/渲染压力
			expandBatchFrameRef.current = window.requestAnimationFrame(consumeExpandBatch);
		}
	}, []);
	/**
	 * 结束当前历史浏览事务。回底按钮和手动下滚重锁共用这条同步路径，确保
	 * 在 React effect 前便作废迟到分页、锚点、扩窗 rAF 与待处理的上滚意图。
	 */
	const invalidateHistoryBrowsing = useCallback(() => {
		browsePinRef.current = null;
		pinnedRowElRef.current = null;
		browsePinFrozenRef.current = false;
		skipBrowsePinRef.current = false;
		historyBrowseGenerationRef.current += 1;
		sendScrollRef.current.cancel();
		// 历史浏览事务结束（回底/重锁）同样作废在途的「最终回答安静定位」动画：
		// 回底后视口应停在底部，不能让动画把刚回底的位置再拉到 30% 高度。
		settleScrollCancelRef.current?.();
		settleScrollCancelRef.current = undefined;
		pendingExpandTurnsRef.current = 0;
		if (expandBatchFrameRef.current !== undefined) {
			window.cancelAnimationFrame(expandBatchFrameRef.current);
			expandBatchFrameRef.current = undefined;
		}
		if (userScrollIntentFrameRef.current !== undefined) {
			window.cancelAnimationFrame(userScrollIntentFrameRef.current);
			userScrollIntentFrameRef.current = undefined;
		}
		loadMoreAnchorRef.current = undefined;
		setPendingJump(undefined);
		lastWindowExpandAtRef.current = 0;
		lastHistoryLoadAtRef.current = 0;
	}, []);
	const escapeAutoScroll = useCallback(() => {
		// 先解引擎：只改 React autoScroll 会留下 isAtBottom=true，扩窗增高时 RO 钉底。
		// autoScroll 已是 false 也要 stopScroll——两套状态可能已经分叉。
		scrollerScrollApiRef.current?.stopScroll();
		sendScrollRef.current.cancel();
		// 进入历史浏览（用户上滚/点「显示更早」）：在途的定位动画立即作废，
		// 程序化滚动不得继续覆盖用户正在做的滚动。
		settleScrollCancelRef.current?.();
		settleScrollCancelRef.current = undefined;
		if (!autoScrollRef.current) return;
		autoScrollRef.current = false;
		setAutoScroll(false);
		setShowScrollToBottom(true);
	}, []);
	const expandWindowBatched = useCallback(
		(turns = TIMELINE_WINDOW_EXPAND_STEP) => {
			escapeAutoScroll();
			if (!skipBrowsePinRef.current && !autoScrollRef.current) {
				const next = findBrowsePin(timelineRef.current, readVisibleRowsRef.current());
				if (next) {
					browsePinRef.current = next;
					browsePinFrozenRef.current = true;
				}
			}
			if (turns <= 0) return;
			pendingExpandTurnsRef.current += turns;
			if (expandBatchFrameRef.current === undefined) {
				expandBatchFrameRef.current = window.requestAnimationFrame(consumeExpandBatch);
			}
		},
		[consumeExpandBatch, escapeAutoScroll],
	);
	// 单栏无 key 复用：切会话时取消上一会话未完成的扩窗任务。窗口值本身由
	// restoreAnchor 的快照在 render 阶段初始化，不能在此处无条件重置为 3 轮。
	useEffect(() => {
		setIsLoadingMessagePage(false);
		// 失败提示是会话级状态：切会话不能把上一会话的加载失败带过来显示
		setLoadMoreError(null);
		pendingExpandTurnsRef.current = 0;
		lastWindowExpandAtRef.current = 0;
		if (expandBatchFrameRef.current !== undefined) {
			window.cancelAnimationFrame(expandBatchFrameRef.current);
			expandBatchFrameRef.current = undefined;
		}
	}, [ownerKey]);
	const expandWindow = useCallback(
		(turns = TIMELINE_WINDOW_EXPAND_STEP) => {
			// 跟底状态（内容短于视口、按钮可见）下点击「显示更早」：先解锁跟随，
			// 否则 turnWindowTurns 恒取贴底窗口 3 轮，扩大 scrolledWindowTurns 不生效，
			// 按钮点击表现为无反应（2026-02 修复）。escapeAutoScroll 同时 stopScroll。
			escapeAutoScroll();
			if (!skipBrowsePinRef.current && !autoScrollRef.current) {
				const next = findBrowsePin(timelineRef.current, readVisibleRowsRef.current());
				if (next) {
					browsePinRef.current = next;
					browsePinFrozenRef.current = true;
				}
			}
			setScrolledWindowTurns((prev) => prev + Math.max(1, turns));
		},
		[escapeAutoScroll],
	);
	// 回底/卸载时取消未消费的分批扩展（窗口重置回基础大小，pending 作废）
	useEffect(() => {
		if (autoScroll) {
			pendingExpandTurnsRef.current = 0;
			browsePinRef.current = null;
			pinnedRowElRef.current = null;
			browsePinFrozenRef.current = false;
			skipBrowsePinRef.current = false;
			if (expandBatchFrameRef.current !== undefined) {
				window.cancelAnimationFrame(expandBatchFrameRef.current);
				expandBatchFrameRef.current = undefined;
			}
			// 回底 = 新的浏览周期：冷却清零，避免「刚到底又立刻上滚」被上一次扩窗冷却吞掉。
			lastWindowExpandAtRef.current = 0;
			setScrolledWindowTurns(TIMELINE_SCROLLED_TURN_LIMIT);
			loadMoreAnchorRef.current = undefined;
			if (userScrollIntentFrameRef.current !== undefined) {
				window.cancelAnimationFrame(userScrollIntentFrameRef.current);
				userScrollIntentFrameRef.current = undefined;
			}
		}
	}, [autoScroll]);
	useEffect(
		() => () => {
			if (expandBatchFrameRef.current !== undefined) {
				window.cancelAnimationFrame(expandBatchFrameRef.current);
			}
			if (userScrollIntentFrameRef.current !== undefined) {
				window.cancelAnimationFrame(userScrollIntentFrameRef.current);
			}
		},
		[],
	);

	const clearHighlightTimers = useCallback(() => {
		for (const timer of highlightTimersRef.current.values()) {
			window.clearTimeout(timer);
		}
		highlightTimersRef.current.clear();
	}, []);

	const highlightMessage = useCallback((element: HTMLElement, expectedOwnerKey: string) => {
		if (ownerKeyRef.current !== expectedOwnerKey) return;
		element.classList.remove("message-jump-highlight");
		void element.offsetWidth;
		element.classList.add("message-jump-highlight");
		const timer = window.setTimeout(() => {
			highlightTimersRef.current.delete(timer);
			if (ownerKeyRef.current === expectedOwnerKey) {
				element.classList.remove("message-jump-highlight");
			}
		}, 2000);
		highlightTimersRef.current.set(timer, timer);
	}, []);

	const clearProgrammaticTimelineScroll = useCallback(() => {
		clearProgrammaticScroll(programmaticScrollGuardRef.current);
	}, []);
	/**
	 * Mark controller-owned movement so its resulting scroll events cannot be
	 * consumed as history intent. Timed windows expire from the deadline itself;
	 * one-frame windows use a generation token so stale rAF cleanup is harmless.
	 */
	const markProgrammaticScroll = useCallback((durationMs = 0) => {
		const guard = programmaticScrollGuardRef.current;
		const generation = beginProgrammaticScroll(guard, performance.now(), durationMs);
		if (durationMs > 0) return;
		window.requestAnimationFrame(() => {
			finishProgrammaticScrollFrame(guard, generation);
		});
	}, []);

	const scrollToBottom = useCallback(() => {
		const requestOwnerKey = ownerKey;
		if (ownerKeyRef.current !== requestOwnerKey) return;
		// 原子回底事务：旧历史浏览周期的扩窗批次、锚点与迟到分页的呈现动作全部作废。
		// 必须同步完成，不能依赖下一帧的 state effect——回底收回 6→3 轮窗口会立刻
		// 触发一次大幅 scrollTop clamp 并派发 scroll；若此刻仍有在途 rAF 扩窗或
		// 待消费批次，会把刚收回的窗口又扩回去（「回底按钮连点无效」的直接根因）。
		invalidateHistoryBrowsing();
		settleScrollCancelRef.current?.();
		settleScrollCancelRef.current = undefined;
		markProgrammaticScroll();
		autoScrollRef.current = true;
		setAutoScroll(true);
		setShowScrollToBottom(false);
		const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
		const animation = reduceMotion ? "instant" : "smooth";
		const api = scrollerScrollApiRef.current;
		if (api) {
			// 走 stick-to-bottom 弹簧（mergeAnimations 修好后 "smooth" = 默认弹簧）
			void api.scrollToBottom({ animation });
			return;
		}
		// 引擎尚未挂上时的兜底（会话切换首帧等）
		const timeline = timelineRef.current;
		if (!timeline) return;
		timeline.scrollTo({
			top: timeline.scrollHeight,
			behavior: reduceMotion ? "instant" : "smooth",
		});
	}, [invalidateHistoryBrowsing, markProgrammaticScroll, ownerKey]);

	/**
	 * The outline rail is a sibling of the scroll viewport, so its wheel event
	 * needs to be forwarded here for the existing scroll lifecycle to observe it.
	 */
	const scrollTimelineBy = useCallback(
		(deltaY: number) => {
			const requestOwnerKey = ownerKey;
			if (!Number.isFinite(deltaY) || deltaY === 0 || ownerKeyRef.current !== requestOwnerKey) return;
			const api = scrollerScrollApiRef.current;
			if (api) {
				api.scrollByWheel(deltaY);
				return;
			}
			const timeline = timelineRef.current;
			if (!timeline) return;
			timeline.scrollBy({ top: deltaY });
		},
		[ownerKey],
	);

	/**
	 * 顶部插入内容后钉住当前视口。必须走 restoreAt：原生 scrollTop 赋值不会解锁引擎，
	 * ResizeObserver 在 isAtBottom 时会把视口钉回底部（上滑扩窗跳到最新一轮的根因）。
	 */
	const pinViewportAfterPrepend = useCallback(
		(nextTop: number) => {
			markProgrammaticScroll(120);
			const api = scrollerScrollApiRef.current;
			if (api?.restoreAt) {
				api.restoreAt(nextTop);
				return;
			}
			const timeline = timelineRef.current;
			if (timeline) timeline.scrollTop = nextTop;
		},
		[markProgrammaticScroll],
	);

	const captureBrowsePin = useCallback((freeze: boolean) => {
		if (skipBrowsePinRef.current || autoScrollRef.current) return;
		const next = findBrowsePin(timelineRef.current, readVisibleRowsRef.current());
		if (!next) return;
		browsePinRef.current = next;
		if (freeze) browsePinFrozenRef.current = true;
	}, []);

	/**
	 * 浏览态钉行：上方长高后把冻住的那一轮拉回 expectedViewportTop。
	 * 必须走 restoreAt。人手滚动不走这里（只更新 expected，见 handleTimelineScroll）。
	 */
	const pinBrowseRow = useCallback(() => {
		if (skipBrowsePinRef.current || autoScrollRef.current || sendScrollRef.current.isAnimating) return;
		const pin = browsePinRef.current;
		const timeline = timelineRef.current;
		if (!pin || !timeline) return;
		const currentTop = measurePinnedRowTop(timeline, pin.messageId);
		if (
			!shouldCompensateBrowsePin({
				following: autoScrollRef.current,
				currentViewportTop: currentTop,
				expectedViewportTop: pin.expectedViewportTop,
			})
		) {
			return;
		}
		if (currentTop === null) return;
		pinViewportAfterPrepend(browsePinScrollTop(timeline.scrollTop, currentTop, pin.expectedViewportTop));
		const after = measurePinnedRowTop(timeline, pin.messageId);
		if (after !== null) {
			browsePinRef.current = { messageId: pin.messageId, expectedViewportTop: after };
		}
	}, [pinViewportAfterPrepend]);

	/**
	 * 最新轮结束 1.5s 且用户无操作、执行过程自动收起后，把该轮最终回答开头放到视口中上方。
	 * - 仅用户仍在跟随时执行；已上滚阅读历史不拽回；
	 * - 先解锁 stick-to-bottom 再滚动，避免引擎把视口钉回底部；
	 * - 用户 wheel/pointerdown/touch/keydown 会取消在途动画（不抢用户操作）；
	 * - 回底按钮仍走 MessageScroller 弹簧，这里只负责这次「安静收起」定位。
	 */
	const scrollFinalAnswerToUpperMiddle = useCallback((_runId: string) => {
		// 旧实现的完结定位动画已被项目决策移除。保留同名 API 为 no-op，
		// 防既有调用处崩溃；所有自动滚动都只在「发送那一刻」触发。
		settleScrollCancelRef.current?.();
		settleScrollCancelRef.current = undefined;
	}, []);

	const setAutoScrollFromScroller = useCallback(
		(following: boolean) => {
			// stopScroll 的迟到 onFollowChange(false) 不得覆盖发送动画的恢复跟随。
			if (sendScrollRef.current.isAnimating) return;
			// 从历史浏览回到跟随时，先同步关闭旧浏览事务；不能等 autoScroll effect，
			// 否则同一帧内的扩窗 rAF 或迟到分页仍可覆盖这次重锁。
			if (following && !autoScrollRef.current) invalidateHistoryBrowsing();
			autoScrollRef.current = following;
			setAutoScroll(following);
			setShowScrollToBottom(!following);
		},
		[invalidateHistoryBrowsing],
	);

	const sendMessageId = latestUserMessageId(messages);
	useLayoutEffect(() => {
		const baseline = sendMessageBaselineRef.current;
		sendMessageBaselineRef.current = { ownerKey, messageId: sendMessageId };
		if (!baseline || baseline.ownerKey !== ownerKey) return;
		// 用户关掉「发送消息后自动滚动到最新」：发送不动视口，也不登记挂起定位。
		// baseline 仍照常推进（上面已写），否则重新打开开关后会把这条旧发送误判成新消息再拽一次。
		// 停在底部时仍由跟底引擎按内容增长跟随新回复——这里只禁止「发送那一刻的强制定位」。
		// 沙箱兜底：部分单测整体 stub ../atoms（见下方 sendState 同款处理），缺该 atom 时按默认「开启」。
		if (scrollToLatestOnSendAtom != null && store.get(scrollToLatestOnSendAtom) === false) {
			pendingSendScrollRef.current = undefined;
			positionedSendMessageRef.current = sendMessageId;
			return;
		}
		const changed = Boolean(sendMessageId) && baseline.messageId !== sendMessageId;
		// 发送态用于区分「用户提交」和「读盘/投影填充历史」：部分单测沙箱会整体 stub
		// ../atoms 后单独加载真实模块，缺这个 atom 时按「无在途发送」处理（生产恒存在）。
		const sendState = options.sessionId && sessionSendStateByIdAtom != null ? store.get(sessionSendStateByIdAtom)[options.sessionId] : undefined;
		const sendingRequestId = sendState && (sendState.status === "activating" || sendState.status === "sending") ? sendState.requestId : undefined;
		if (restorePhase !== "complete") {
			// 恢复/激活期间的用户提交暂存，恢复完成后补定位（DSH 新会话首发就走这条窗口）。
			// 仅在发送态 in-flight 时登记：读盘/投影填充历史也会改变末条 user id，
			// 没有在途提交时不能误判为一次发送（否则会重播历史定位）。
			if (sendMessageId) {
				const pending = pendingSendScrollRef.current;
				if (pending?.ownerKey === ownerKey) {
					// 宿主回填把乐观 id 换成投影 id 时沿用同一条挂起项。
					if (changed) pending.messageId = sendMessageId;
				} else if (sendingRequestId) {
					pendingSendScrollRef.current = { ownerKey, messageId: sendMessageId };
				}
			}
			return;
		}
		if (!sendMessageId) {
			pendingSendScrollRef.current = undefined;
			return;
		}
		if (positionedSendMessageRef.current === sendMessageId) return;
		const pending = pendingSendScrollRef.current;
		const pendingMatches = Boolean(pending && pending.ownerKey === ownerKey && pending.messageId === sendMessageId);
		// 面板挂载时乐观气泡已在缓存（引导页首发 / 切页回来）：此前的 id 变化没人观察到，
		// 但发送态仍 in-flight 且 requestId 就是这条 user 消息，恢复完成后补一次定位。
		const submissionMatches = sendingRequestId === sendMessageId && !changed;
		if (!changed && !pendingMatches && !submissionMatches) {
			if (pending?.ownerKey === ownerKey) pendingSendScrollRef.current = undefined;
			return;
		}
		pendingSendScrollRef.current = undefined;
		const timeline = timelineRef.current;
		if (!timeline) return;
		positionedSendMessageRef.current = sendMessageId;
		sendScrollRef.current.pin(timeline, sendMessageId, {
			onStart: () => {
				// 先立标记再滚：TurnRow 的折叠 effect 与本动画跑在同一帧窗口里，
				// 标记晚一步就会漏掉这次折叠。
				setSendPinAnimating(true);
				invalidateHistoryBrowsing();
				scrollerScrollApiRef.current?.restoreAt(timeline.scrollTop);
				autoScrollRef.current = false;
				setAutoScroll(false);
				setShowScrollToBottom(false);
			},
			onComplete: () => {
				setSendPinAnimating(false);
				if (ownerKeyRef.current !== ownerKey) return;
				autoScrollRef.current = true;
				setAutoScroll(true);
				setShowScrollToBottom(false);
				void scrollerScrollApiRef.current?.scrollToBottom({ animation: "instant" });
			},
			// 用户滚动 / 切会话 / 下一次 pin 打断：不留标记，否则折叠会被无限期推迟。
			onCancel: () => setSendPinAnimating(false),
			isFollowing: () => autoScrollRef.current,
			markProgrammaticScroll,
			clearProgrammaticScroll: clearProgrammaticTimelineScroll,
		});
		// 短会话 / 行未挂载 / 距离为 0 时 pin 可能一次都不动画就返回（不触发 onStart）：
		// 同步结算标记，避免残留 true。
		if (!sendScrollRef.current.isAnimating) setSendPinAnimating(false);
	}, [clearProgrammaticTimelineScroll, invalidateHistoryBrowsing, markProgrammaticScroll, options.sessionId, ownerKey, restorePhase, sendMessageId, store, setSendPinAnimating]);
	useEffect(
		() => () => {
			pendingSendScrollRef.current = undefined;
			positionedSendMessageRef.current = undefined;
			sendScrollRef.current.reset();
		},
		[],
	);

	const loadMoreMessages = useCallback(
		(source: "scroll" | "button" = "scroll") => {
			const requestOwnerKey = ownerKey;
			const timeline = timelineRef.current;
			if (source === "scroll") captureBrowsePin(true);
			if (timeline && ownerKeyRef.current === requestOwnerKey) {
				loadMoreAnchorRef.current = {
					ownerKey: requestOwnerKey,
					value: {
						height: timeline.scrollHeight,
						top: timeline.scrollTop,
						generation: historyBrowseGenerationRef.current,
						...(source === "scroll" ? { preserveAtTop: true } : {}),
					},
				};
			}
			if (diskPage) {
				const sessionId = options.sessionId;
				const before = diskPage.nextBefore;
				if (!sessionId || before === null || isLoadingMessagePage) return;
				const browseGeneration = historyBrowseGenerationRef.current;
				const sequence = ++nextLoadSequence;
				trackLatestLoad(sessionId, sequence);
				const expectedRevision = cachedEntry?.revision ?? 0;
				setIsLoadingMessagePage(true);
				// 重试时先清掉上一次的错误行
				setLoadMoreError(null);
				void desktopApi.sessions
					.readRecordMessagePage(sessionId, before, RUNTIME_HISTORY_TURN_PAGE_SIZE)
					.then((page: SessionMessagePage) => {
						if (latestLoadBySession.get(sessionId) !== sequence) return;
						// 翻页期间 host 被停：保留已加载内容，出可辨识的失败行（静默丢弃这一页
						// 会让「加载更多」看起来没反应），下次点击仍可重试。
						if (sessionHistoryUnavailableState(page)) {
							setLoadMoreError(t("timeline.dshHostStopped"));
							return;
						}
						if (prependMessagePage({ sessionId, before, expectedRevision, page })) {
							// 历史消息页最多只开放一个 3 轮 cohort；数据页可能按消息数返回很多轮，
							// 不能再固定 +10 把 DOM 一次性解锁，剩余已加载数据交给本地扩窗。
							// 回底/切会话后到达（跟随或代数过期）只写缓存，不得扩窗——否则
							// 迟到分页会把刚回底的视口重新拉进历史模式。
							if (
								shouldApplyDelayedHistoryResult({
									following: autoScrollRef.current,
									generationAtRequest: browseGeneration,
									currentGeneration: historyBrowseGenerationRef.current,
								})
							) {
								const growth = resolvePageWindowGrowth(page.messages);
								if (growth > 0) expandWindowBatched(growth);
							}
						}
					})
					.catch((error: unknown) => {
						// 失败必须可见：没有 catch 时 IPC 抛错被吞掉，按钮弹回但页面无提示（2026-09 反馈）。
						if (latestLoadBySession.get(sessionId) !== sequence) return;
						setLoadMoreError(error instanceof Error ? error.message : String(error));
					})
					.finally(() => {
						if (latestLoadBySession.get(sessionId) === sequence) setIsLoadingMessagePage(false);
					});
				return;
			}
			// runtime 窗口会话：直接按轮次补历史（2026-11 轮次模型，不再有 100 条渲染窗口）。
			// 首次加载以运行时窗口段首条消息的 entryId 为锚点（两个下标空间唯一的对齐点），
			// 续页用上一页最旧条目的 entryId（nextBeforeEntryId）——主进程缓存命中路径依赖它。
			if (historyHasMore) {
				const sessionId = options.sessionId;
				if (!sessionId || isLoadingMessagePage) return;
				const before = runtimeHistory?.nextBefore;
				// 首次补历史锚点：窗口首条可能是无 entryId 的系统摘要卡片（compaction/branchSummary），
				// 必须取第一条有 entryId 的消息，否则锚点解析失败导致首次上翻静默放弃。
				const anchorMessage = !runtimeHistory ? messages.find((m) => typeof m.meta?.entryId === "string") : undefined;
				const anchorEntryId = typeof anchorMessage?.meta?.entryId === "string" ? anchorMessage.meta.entryId : undefined;
				// 大历史窗口（skipEntries 路径）消息可能整体缺 entryId：退化为窗口首条消息的
				// 文件消息下标（windowStartFilePos）作为数值游标——主进程缓存路径先把它解析成
				// entryId 再查缓存，磁盘路径直接消费文件下标。两者都没有才放弃补历史。
				const anchorFilePos = !runtimeHistory && !anchorEntryId ? (typeof cachedEntry?.windowStartFilePos === "number" ? cachedEntry.windowStartFilePos : undefined) : undefined;
				if (!runtimeHistory && !anchorEntryId && anchorFilePos === undefined) return;
				const browseGeneration = historyBrowseGenerationRef.current;
				const sequence = ++nextLoadSequence;
				trackLatestLoad(sessionId, sequence);
				const expectedRevision = cachedEntry?.revision ?? 0;
				setIsLoadingMessagePage(true);
				// 重试时先清掉上一次的错误行
				setLoadMoreError(null);
				void desktopApi.sessions
					.readRecordMessagePage(sessionId, before ?? (anchorFilePos !== undefined ? anchorFilePos : undefined), RUNTIME_HISTORY_TURN_PAGE_SIZE, {
						beforeEntryId: anchorEntryId ?? runtimeHistory?.nextBeforeEntryId ?? undefined,
					})
					.then((page: SessionMessagePage) => {
						if (latestLoadBySession.get(sessionId) !== sequence) return;
						// 与 disk 翻页同一语义：host 被停时不把空页当新历史，出失败行
						if (sessionHistoryUnavailableState(page)) {
							setLoadMoreError(t("timeline.dshHostStopped"));
							return;
						}
						if (prependHistoryPage({ sessionId, expectedRevision, before, page })) {
							// runtime history 页与 DOM 使用同一 3 轮 cohort；缓存命中和文件回退
							// 都只开放实际带回的轮数，避免数据 +3、窗口却 +10。
							// 回底/切会话后到达（跟随或代数过期）只写缓存，不得扩窗。
							if (
								shouldApplyDelayedHistoryResult({
									following: autoScrollRef.current,
									generationAtRequest: browseGeneration,
									currentGeneration: historyBrowseGenerationRef.current,
								})
							) {
								const growth = resolvePageWindowGrowth(page.messages);
								if (growth > 0) expandWindowBatched(growth);
							}
						}
					})
					.catch((error: unknown) => {
						// 失败必须可见：没有 catch 时 IPC 抛错被吞掉，按钮弹回但页面无提示（2026-09 反馈）。
						if (latestLoadBySession.get(sessionId) !== sequence) return;
						setLoadMoreError(error instanceof Error ? error.message : String(error));
					})
					.finally(() => {
						if (latestLoadBySession.get(sessionId) === sequence) setIsLoadingMessagePage(false);
					});
				return;
			}
		},
		[cachedEntry?.revision, captureBrowsePin, diskPage, expandWindowBatched, historyHasMore, isLoadingMessagePage, messages, options.sessionId, ownerKey, prependHistoryPage, prependMessagePage, runtimeHistory],
	);

	// ── 回底清理临时历史（2026-11 轮次模型）──
	// 贴底稳定 1.5s 后清掉翻过的历史前缀（atom 只留运行时窗口段），渲染层内存回到最小；
	// 再次上翻走「atom → 主进程缓存 → 文件」重新拉取（主进程 12 轮内命中，无感）。
	// 上滚/加载历史中会取消待执行的清理；清理后 history 置空，后续再翻再拉。
	const clearHistory = useSetAtom(clearSessionHistoryAtom);
	const historyClearTimerRef = useRef<number | undefined>(undefined);
	useEffect(() => {
		if (!controllerEnabled) return;
		const sessionId = options.sessionId;
		if (!sessionId) return;
		if (autoScroll && runtimeHistory) {
			if (historyClearTimerRef.current != null) return;
			const clearNow = () => {
				historyClearTimerRef.current = undefined;
				if (!clearHistory(sessionId)) return;
				// 清理后丢弃在途历史页响应：迟到页会把已释放的 history 复活并携带旧滚动锚点
				const sequence = ++nextLoadSequence;
				trackLatestLoad(sessionId, sequence);
				setIsLoadingMessagePage(false);
			};
			historyClearTimerRef.current = window.setTimeout(() => {
				const timeline = timelineRef.current;
				// autoScroll 只是「逻辑跟随」，可能还在平滑回底/弹簧动画途中；
				// 物理上没到底就清历史会把用户正在看的页摘掉，延后 500ms 再确认。
				if (timeline && !isTimelineAtBottom(timeline.scrollTop, timeline.scrollHeight, timeline.clientHeight)) {
					historyClearTimerRef.current = window.setTimeout(clearNow, 500);
					return;
				}
				clearNow();
			}, 1500);
			return () => {
				if (historyClearTimerRef.current != null) {
					window.clearTimeout(historyClearTimerRef.current);
					historyClearTimerRef.current = undefined;
				}
			};
		}
		// 上滚看历史 / 无历史可清：取消待执行清理
		if (historyClearTimerRef.current != null) {
			window.clearTimeout(historyClearTimerRef.current);
			historyClearTimerRef.current = undefined;
		}
	}, [autoScroll, clearHistory, controllerEnabled, options.sessionId, runtimeHistory]);

	/**
	 * 跳转落位：计算目标相对时间线的偏移并原子定位（restoreAt = 定位 + 解锁锁底
	 * + 取消在途动画）。不用 scrollIntoView：它会级联滚动所有祖先容器，且 smooth
	 * 动画会与贴底引擎/扩窗布局竞争——跟随态下点刻度「看似没反应、再点一次才生效」
	 * 的直接根因就是贴底引擎把 smooth 滚动拽了回去。
	 */
	const scrollJumpTargetIntoView = useCallback(
		(timeline: HTMLElement, element: HTMLElement) => {
			const elementTop = element.getBoundingClientRect().top - timeline.getBoundingClientRect().top + timeline.scrollTop;
			markProgrammaticScroll();
			const api = scrollerScrollApiRef.current;
			if (api?.restoreAt) {
				api.restoreAt(Math.max(0, elementTop));
			} else {
				// 引擎尚未挂上（会话切换首帧等）时回退原生定位
				timeline.scrollTop = Math.max(0, elementTop);
			}
		},
		[markProgrammaticScroll],
	);

	const jumpToMessage = useCallback(
		(messageId: string) => {
			const requestOwnerKey = ownerKey;
			const timeline = timelineRef.current;
			if (!timeline || ownerKeyRef.current !== requestOwnerKey) return;
			// 跟随态点击刻度必须先解锁贴底：目标已在挂载窗口内时（如最新一条）引擎
			// 会把滚动拽回底部；目标在窗口外时 unlock 也是扩窗生效的前提。
			escapeAutoScroll();
			skipBrowsePinRef.current = true;
			browsePinRef.current = null;
			browsePinFrozenRef.current = false;
			// 命中 id 可能是**会话文件条目 id**（会话内查找的命中）而不是投影消息 id：
			// 先归一到当前消息列表再查 DOM，否则永远查不到节点、点击无任何反应。
			const index = resolveJumpMessageIndex(combinedMessages, messageId);
			const targetNodeId = index >= 0 ? combinedMessages[index].id : messageId;
			const existing = timeline.querySelector(`[data-message-id="${CSS.escape(targetNodeId)}"]`) as HTMLElement | null;
			if (existing) {
				skipBrowsePinRef.current = false;
				// 轮内中间回答在折叠区里是 display:none（几何全 0），落位退到所属轮次行
				const target = resolveJumpScrollTarget(existing);
				scrollJumpTargetIntoView(timeline, target);
				highlightMessage(target, requestOwnerKey);
				clearTimelineReveal();
				return;
			}
			// 命中可能在已完成轮的「执行过程」折叠区里：Radix 收起会把中间回答/工具整块卸载，
			// 扩窗（只多挂轮次）永远挂不出这些节点。先请求包含它的 TurnRow 展开折叠，
			// 再由下面的 pendingJump 重试循环完成落位。
			if (index >= 0) requestTimelineReveal(targetNodeId);
			const hasMorePages = diskPage ? diskPage.nextBefore !== null : historyHasMore;
			// 冷会话（消息还没上屏 / 首屏仍在加载）里 index<0 不等于「目标不存在」：挂起跳转，
			// 等数据到达后由 pendingJump effect 落位。旧实现这里直接 return，宿主插件按 entryId
			// 导航到尚未加载完消息的会话时静默失效（#401 复审 P0）。
			if (index < 0 && !hasMorePages && !shouldDeferJumpUntilLoaded({ targetIndex: index, messageCount: combinedMessages.length, surfaceLoading: isSurfaceLoading })) return;
			// 目标可能在贴底 turn 窗口外（先取消跟随以展开挂载），也可能在尚未加载的
			// 历史页里：挂起跳转，由 pendingJump effect 按策略补页/扩窗直到完成。
			setShowScrollToBottom(true);
			if (index >= 0) {
				// 一次到位：按目标轮次估算窗口需求并整批排入分帧扩窗（避免单帧全量渲染）。
				// 批次消费完前 pendingJump effect 挂起等待（见 effect 内 pendingExpandTurnsRef 守卫）。
				expandWindowBatched(estimateJumpExpandTurns(combinedMessages, index));
			}
			jumpNonceRef.current += 1;
			setPendingJump({
				ownerKey: requestOwnerKey,
				value: { messageId, expandAttempts: 0, loadAttempts: 0, nonce: jumpNonceRef.current },
			});
		},
		[clearTimelineReveal, combinedMessages, diskPage, escapeAutoScroll, expandWindowBatched, highlightMessage, historyHasMore, isSurfaceLoading, ownerKey, requestTimelineReveal, scrollJumpTargetIntoView],
	);

	/**
	 * 目标节点挂不出来时的兜底落点：在已渲染的 [data-message-id] 里找包含目标（或离它最近且
	 * 在其之前）的那一轮，落到轮次行——折叠区没展开/超出单轮挂载预算时，至少停在正确的一轮，
	 * 而不是弹「未能跳转」。行长取子树里最靠前的消息下标：run.id 可能是思考组 id
	 * （msg-thinking-*）而不是消息 id，但行内渲染的节点一定是消息。
	 */
	const findFallbackJumpRow = useCallback(
		(messageId: string): HTMLElement | null => {
			const timeline = timelineRef.current;
			if (!timeline) return null;
			const targetIndex = resolveJumpMessageIndex(combinedMessages, messageId);
			if (targetIndex < 0) return null;
			const indexById = new Map<string, number>();
			for (let index = 0; index < combinedMessages.length; index += 1) indexById.set(combinedMessages[index].id, index);
			const rows = new Map<HTMLElement, number>();
			for (const node of timeline.querySelectorAll<HTMLElement>("[data-message-id]")) {
				const id = node.getAttribute("data-message-id");
				if (!id) continue;
				// 思考组 id = msg-thinking-<消息 id>：降级到消息本身，避免整轮缺席兜底索引。
				const index = indexById.get(id) ?? (id.startsWith("msg-thinking-") ? indexById.get(id.slice("msg-thinking-".length)) : undefined);
				if (index === undefined) continue;
				const row = node.closest<HTMLElement>(".turn-row, .user-turn") ?? node;
				const current = rows.get(row);
				if (current === undefined || index < current) rows.set(row, index);
			}
			const entries = [...rows].map(([row, index]) => ({ row, index }));
			const picked = resolveJumpFallbackEntry(entries, targetIndex);
			return picked >= 0 ? entries[picked].row : null;
		},
		[combinedMessages],
	);

	useEffect(() => {
		loadMoreAnchorRef.current = undefined;
		browsePinRef.current = null;
		browsePinFrozenRef.current = false;
		skipBrowsePinRef.current = false;
		// 切会话：取消旧会话遗留的挂起跳转与动画状态（揭示请求也一并清掉，
		// 否则切回来的第一帧会把上一轮的折叠自动撑开）。
		setPendingJump(undefined);
		clearTimelineReveal();
		clearProgrammaticTimelineScroll();
		settleScrollCancelRef.current?.();
		settleScrollCancelRef.current = undefined;
		// 会话切换：清掉上一会话的置顶垫片与动画标记
		clearHighlightTimers();
		// owner 的 generation 已在 render 快照切换时递增；这里仅清理上一会话的帧。
		if (userScrollIntentFrameRef.current !== undefined) {
			window.cancelAnimationFrame(userScrollIntentFrameRef.current);
			userScrollIntentFrameRef.current = undefined;
		}
		return clearHighlightTimers;
	}, [clearHighlightTimers, clearProgrammaticTimelineScroll, clearTimelineReveal, ownerKey]);

	useLayoutEffect(() => {
		if (ownerKey === LEGACY_OWNER_KEY) return;
		ownerWindowTurnsRef.current.set(ownerKey, effectiveWindowTurns);
	}, [effectiveWindowTurns, ownerKey]);

	// 切走落盘：cleanup 把滚动时已算好的 ref 锚点写入 atom，不读 DOM
	// （会话切换复用同一组件实例，cleanup 时 timeline children 可能已是新会话）。
	// 在底部跟流时 ref 为 null → 清除锚点，切回继续跟底。
	useLayoutEffect(() => {
		const sessionId = ownerKey;
		return () => {
			if (scrollAnchorFrameRef.current != null) {
				cancelAnimationFrame(scrollAnchorFrameRef.current);
				scrollAnchorFrameRef.current = undefined;
			}
			if (scrollSaveTimerRef.current != null) {
				window.clearTimeout(scrollSaveTimerRef.current);
				scrollSaveTimerRef.current = undefined;
			}
			if (sessionId && sessionId !== LEGACY_OWNER_KEY) {
				const anchor = currentAnchorRef.current;
				const windowTurns = ownerWindowTurnsRef.current.get(sessionId);
				// 锚点自带「滚动那一刻」的窗口（computeCurrentAnchor 写入）。切走瞬间，回底 effect
				// 可能已先把 scrolledWindowTurns 复位成 3 并覆盖 map；再拿 map 覆盖锚点会让切回
				// 只挂 3 轮——用户原来读的那一行不在 DOM，虚拟区恢复落位直接失效（#401 实测）。
				const restoredAnchor = anchor && anchor.windowTurns === undefined && windowTurns !== undefined ? { ...anchor, windowTurns } : anchor;
				saveScrollAnchor({
					sessionId,
					anchor: restoredAnchor,
				});
				ownerWindowTurnsRef.current.delete(sessionId);
			}
			currentAnchorRef.current = null;
		};
	}, [ownerKey, saveScrollAnchor]);

	useEffect(() => {
		if (!controllerEnabled || restorePhase !== "pending") return;
		const anchor = restoreAnchor;
		if (anchor) {
			// 上滚阅读状态必须在首个 child commit 前关闭跟随；窗口尚在读盘时先等待，
			// 不把「锚点暂未挂载」误判成永久失效。
			autoScrollRef.current = false;
			setAutoScroll(false);
			setShowScrollToBottom(true);
		}
		// 无锚点路径也必须等首批消息上屏：冷会话切入时 DOM 只有骨架（scrollHeight≈0），
		// 过早 scrollTo + restorePhase=complete 会把视口永久钉在顶部第一条。
		if (isSurfaceLoading) return;

		const requestOwnerKey = ownerKey;
		if (!anchor) {
			// 无锚点（切走时在底部或从未保存）：默认滚到底、恢复跟底。
			autoScrollRef.current = true;
			setAutoScroll(true);
			setShowScrollToBottom(false);
			setRestorePhase("complete");
			const frame = requestAnimationFrame(() => {
				const timeline = timelineRef.current;
				if (!timeline || ownerKeyRef.current !== requestOwnerKey) return;
				markProgrammaticScroll();
				const api = scrollerScrollApiRef.current;
				if (api?.scrollToBottom) {
					void api.scrollToBottom({ animation: "instant" });
				} else {
					timeline.scrollTo({ top: timeline.scrollHeight, behavior: "instant" });
				}
			});
			return () => cancelAnimationFrame(frame);
		}

		const frame = requestAnimationFrame(() => {
			const timeline = timelineRef.current;
			if (!timeline || ownerKeyRef.current !== requestOwnerKey) return;
			const el = timeline.querySelector(`[data-message-id="${CSS.escape(anchor.messageId)}"]`) as HTMLElement | null;
			if (el) {
				const elTop = el.getBoundingClientRect().top - timeline.getBoundingClientRect().top + timeline.scrollTop;
				markProgrammaticScroll();
				// 原子恢复：定位 + 解锁锁底 + 取消在途动画一次完成。
				// busy 会话的 ResizeObserver（instant 贴底）看到 isAtBottom=false 不再拽回。
				const api = scrollerScrollApiRef.current;
				const targetTop = Math.max(0, elTop - anchor.offsetTop);
				if (api?.restoreAt) {
					api.restoreAt(targetTop);
				} else {
					// 引擎未挂上（会话切换首帧等）时回退原生定位
					timeline.scrollTop = targetTop;
				}
				// 恢复后的位置即当前锚点：即使恢复后用户未滚动就切走，cleanup
				// 落盘的也是这份锚点（而不是误判为底部/空）。恢复前后的渲染窗口都
				// 由 anchor.windowTurns 决定，因此 complete 不会再收缩 DOM 并截断 targetTop。
				currentAnchorRef.current = anchor;
				setRestorePhase("complete");
				return;
			}

			// 数据仍在 atom 但被 turn 窗口裁掉时，先扩窗重试。不能立刻回底：
			// 这正是长历史会话切回后位置丢失的根因。窗口已覆盖当前数据后才降级。
			if (windowExpandableRef.current) {
				setScrolledWindowTurns((turns) => turns + TIMELINE_WINDOW_EXPAND_STEP);
				return;
			}

			// 锚点确实不可再物化（压缩/删除等）：保留历史阅读语义并通过引擎解锁，
			// 不能只写原生 scrollTop，否则 ResizeObserver 会重新把视口钉到底部。
			markProgrammaticScroll();
			const api = scrollerScrollApiRef.current;
			if (api?.restoreAt) {
				api.restoreAt(0);
			} else {
				timeline.scrollTop = 0;
			}
			setRestorePhase("complete");
		});
		return () => cancelAnimationFrame(frame);
	}, [controllerEnabled, isSurfaceLoading, markProgrammaticScroll, ownerKey, restoreAnchor, restorePhase, scrolledWindowTurns]);

	// ── 用户上滚接近顶部时自动加载历史（2026-11 轮次模型）──
	// 历史扩窗只消费 stick 引擎确认的用户意图。普通 scroll 事件仍由
	// handleTimelineScroll 保存锚点，但不再拥有跟随/浏览状态的切换权限：内容收缩、
	// ResizeObserver、动画和程序化定位因此不能借 scrollTop 变化触发历史呈现。
	const setUserScrollIntent = useCallback(
		(intent: "up" | "down", source?: "scroll" | "input") => {
			if (userScrollIntentFrameRef.current !== undefined) {
				window.cancelAnimationFrame(userScrollIntentFrameRef.current);
				userScrollIntentFrameRef.current = undefined;
			}
			// 引擎确认的真实 wheel/touch 输入（source="input"）：立即终止在途的
			// 「最终回答安静定位」动画——动画自激发的 scroll 派生意图带 source="scroll"，
			// 且被 programmaticScroll 窗口抑制，不会把自己取消掉（状态驱动取消）。
			if (source === "input") {
				sendScrollRef.current.cancel();
				settleScrollCancelRef.current?.();
				settleScrollCancelRef.current = undefined;
			}
			// down 只取消同帧尚未消费的 up；实际重锁由 stick 引擎决定，并经
			// setAutoScrollFromScroller 进入 invalidateHistoryBrowsing。
			if (intent !== "up") return;

			const requestOwnerKey = ownerKey;
			userScrollIntentFrameRef.current = window.requestAnimationFrame(() => {
				userScrollIntentFrameRef.current = undefined;
				if (!controllerEnabled || ownerKeyRef.current !== requestOwnerKey) return;
				if (isProgrammaticScrollActive(programmaticScrollGuardRef.current, performance.now())) return;
				const timeline = timelineRef.current;
				if (!timeline) return;

				const layoutPending = pendingExpandTurnsRef.current > 0 || expandBatchFrameRef.current !== undefined || loadMoreAnchorRef.current !== undefined;
				if (source === "input" && !layoutPending) {
					// 扩窗已落稳后用户继续滑：换钉当前第一可见行，不要焊在扩窗前那一条上。
					browsePinFrozenRef.current = false;
					captureBrowsePin(false);
				}

				const now = Date.now();
				const hasMore = diskPage ? diskPage.nextBefore !== null : historyHasMore;
				// wheel 意图在浏览器默认滚动前上报，scrollbar/touch 意图在 scroll 后上报；
				// 下一帧读取统一后的最终位置，因此不再依赖监听器注册顺序或 sticky 方向标记。
				const expandThreshold = resolveAutoExpandThreshold(timeline.clientHeight);
				if (
					shouldAutoExpandRenderWindow({
						intent,
						scrollTop: timeline.scrollTop,
						expandThreshold,
						windowExpandable: windowExpandableRef.current,
						hasPendingExpand: pendingExpandTurnsRef.current > 0 || expandBatchFrameRef.current !== undefined,
						cooldownElapsed: now - lastWindowExpandAtRef.current >= TURN_WINDOW_AUTO_EXPAND_COOLDOWN_MS,
					})
				) {
					lastWindowExpandAtRef.current = now;
					expandWindowBatched();
					return;
				}

				// 本地 cohort 已耗尽后，在近顶部预取一页；真正触顶同样只翻一页。
				if (timeline.scrollTop <= expandThreshold && hasMore && !isLoadingMessagePage) {
					if (now - lastHistoryLoadAtRef.current < HISTORY_AUTO_LOAD_COOLDOWN_MS) return;
					lastHistoryLoadAtRef.current = now;
					escapeAutoScroll();
					loadMoreMessages("scroll");
				}
			});
		},
		[captureBrowsePin, controllerEnabled, diskPage, escapeAutoScroll, expandWindowBatched, historyHasMore, isLoadingMessagePage, loadMoreMessages, ownerKey],
	);

	useLayoutEffect(() => {
		if (!controllerEnabled) return;
		const anchor = loadMoreAnchorRef.current;
		const timeline = timelineRef.current;
		if (!anchor || !timeline || !matchesTimelineOwner(anchor.ownerKey, ownerKey)) return;
		// 跟底中 / 浏览代数已过期（回底、切会话）：恢复会把用户拽回旧位置或把刚收回的
		// 窗口重新插页——迟到分页只允许写缓存，不恢复锚点。
		if (autoScrollRef.current || anchor.value.generation !== historyBrowseGenerationRef.current) {
			loadMoreAnchorRef.current = undefined;
			return;
		}
		// 滚动翻页：钉住正在看的那一轮（不是整页 scrollHeight 差）。
		// 跳转驱动的补页（preserveAtTop 为空）仍走顶部阈值：点刻度时不要把视口焊回旧行。
		if (anchor.value.preserveAtTop) {
			pinBrowseRow();
			loadMoreAnchorRef.current = undefined;
			return;
		}
		const heightDelta = timeline.scrollHeight - anchor.value.height;
		const nextScrollTop = resolveTimelineTopCompensation(anchor.value.top, heightDelta);
		if (nextScrollTop === null) {
			loadMoreAnchorRef.current = undefined;
			markProgrammaticScroll();
			return;
		}
		pinViewportAfterPrepend(nextScrollTop);
		loadMoreAnchorRef.current = undefined;
	}, [controllerEnabled, markProgrammaticScroll, ownerKey, pinBrowseRow, pinViewportAfterPrepend, visibleMessages.length]);

	// 浏览态内容后增高（历史 Markdown 轻量→全量、图片、mermaid）：扩窗那一帧的补偿不够，
	// 按钉住的行继续补漂移。跟随时不碰——吸底引擎负责下方增长。
	useLayoutEffect(() => {
		if (!controllerEnabled) return;
		const timeline = timelineRef.current;
		if (!timeline || typeof ResizeObserver === "undefined") return;
		const content = timeline.querySelector('[role="log"]');
		const target = content ?? timeline;
		const observer = new ResizeObserver(() => {
			if (autoScrollRef.current || skipBrowsePinRef.current) return;
			pinBrowseRow();
		});
		observer.observe(target);
		return () => observer.disconnect();
	}, [controllerEnabled, ownerKey, pinBrowseRow]);

	useEffect(() => {
		if (!controllerEnabled || !pendingJump) return;
		if (!matchesTimelineOwner(pendingJump.ownerKey, ownerKey)) return;
		const timeline = timelineRef.current;
		if (!timeline) return;
		// 分批扩窗在途（点击时一次到位排满的批次 / 补页增长）：等批次消费完再评估，
		// 避免目标刚挂载就落位、随后被后续批次推移。
		if (pendingExpandTurnsRef.current > 0) return;
		// 挂起期间每轮重新归一：目标可能是文件条目 id（会话内查找命中），补页把它
		// 载入 combinedMessages 之后投影 id 才确定。
		const targetIndex = resolveJumpMessageIndex(combinedMessages, pendingJump.value.messageId);
		const targetNodeId = targetIndex >= 0 ? combinedMessages[targetIndex].id : pendingJump.value.messageId;
		const element = timeline.querySelector(`[data-message-id="${CSS.escape(targetNodeId)}"]`) as HTMLElement | null;
		if (element) {
			skipBrowsePinRef.current = false;
			setPendingJump(undefined);
			// 折叠区里的命中节点不可见：落位退到所属轮次行（见 timeline/jumpTarget）
			const target = resolveJumpScrollTarget(element);
			scrollJumpTargetIntoView(timeline, target);
			highlightMessage(target, ownerKey);
			clearTimelineReveal();
			return;
		}
		// 目标未挂载：按策略兜底扩窗（指数步长）/ 跳转驱动补页 / 放弃（防呆上限）。
		// give-up 保留旧行为兜底：目标已不在数据（压缩清理/删除）时不无限扩窗（2026-08 黑屏治理）。
		const stillInData = targetIndex >= 0;
		const hasMorePages = diskPage ? diskPage.nextBefore !== null : historyHasMore;
		// 冷会话等待：目标还没进数据，但消息尚未上屏（首批未到 / 首屏加载中）。
		// 这不是「目标不存在」—— give-up 会误报「跳转失败」并把插件导航丢掉（#401 复审 P0）。
		// effect 依赖 combinedMessages：数据到达后自动重跑并落位。
		if (!stillInData && shouldDeferJumpUntilLoaded({ targetIndex, messageCount: combinedMessages.length, surfaceLoading: isSurfaceLoading })) return;
		const action = resolveJumpPendingAction({
			targetInLoadedData: stillInData,
			hasMorePages,
			isLoadingPage: isLoadingMessagePage,
			expandAttempts: pendingJump.value.expandAttempts,
			loadAttempts: pendingJump.value.loadAttempts,
		});
		if (action.kind === "give-up") {
			skipBrowsePinRef.current = false;
			setPendingJump(undefined);
			clearTimelineReveal();
			// 目标在已加载数据里、只是折叠区没挂出来（超出单轮挂载预算/特殊条目）：
			// 退到包含它的那一轮，而不是报「跳不到」——用户至少落在正确的位置。
			const fallbackRow = findFallbackJumpRow(pendingJump.value.messageId);
			if (fallbackRow) {
				scrollJumpTargetIntoView(timeline, fallbackRow);
				highlightMessage(fallbackRow, ownerKey);
				return;
			}
			// 静默放弃会被当成「点了没反应」（本次 bug 的原始反馈）：补页/扩窗都到上限时
			// 必须给一句反馈，要么历史太远加载不到，要么这条已被 context_edit 移出展示。
			toast(t("sessionFind.jumpFailed"));
			return;
		}
		if (action.kind === "wait") return;
		setPendingJump({
			ownerKey: pendingJump.ownerKey,
			value: {
				messageId: pendingJump.value.messageId,
				expandAttempts: action.kind === "expand" ? pendingJump.value.expandAttempts + 1 : pendingJump.value.expandAttempts,
				loadAttempts: action.kind === "load-page" ? pendingJump.value.loadAttempts + 1 : pendingJump.value.loadAttempts,
				nonce: pendingJump.value.nonce + 1,
			},
		});
		if (action.kind === "load-page") {
			loadMoreMessages("button");
			return;
		}
		expandWindow(action.turns);
	}, [clearTimelineReveal, combinedMessages, controllerEnabled, diskPage, expandWindow, findFallbackJumpRow, highlightMessage, historyHasMore, isLoadingMessagePage, isSurfaceLoading, loadMoreMessages, ownerKey, pendingJump, scrollJumpTargetIntoView, scrolledWindowTurns]);

	return {
		timelineRef,
		messages,
		visibleMessages: diskPage ? messages : visibleMessages,
		totalMessageCount: diskPage ? diskPage.total : combinedMessages.length,
		hasMoreMessages: diskPage ? diskPage.nextBefore !== null : historyHasMore,
		// 下一次「加载更多」是否触发 disk 轮次分页（窗口前还有历史）：
		// 2026-11 轮次模型：runtime 会话一律按轮补页（无内存扩窗阶段），文案恒为「加载更多对话」
		nextLoadIsHistory: controllerEnabled && !diskPage && historyHasMore,
		isLoadingMoreMessages: diskPage || historyHasMore ? isLoadingMessagePage : false,
		/** 上一次「加载更多」失败原因（原始 IPC 文案，渲染层错误行 title）；null = 无错误。 */
		loadMoreError,
		loadMoreMessages,
		markProgrammaticScroll,
		pinViewportAfterPrepend,
		pinBrowseRow,
		jumpToMessage,
		scrollToBottom,
		scrollTimelineBy,
		scrollFinalAnswerToUpperMiddle,
		/** 新 run 开始（busy 边沿）：取消在途 settle 定位动画并恢复跟随贴底。 */
		cancelSettledRepositionForNewRun,
		/** 滚动回调：维护会话切换用的滚动锚点（rAF 合并，不触发渲染） */
		handleTimelineScroll,
		autoScroll,
		showScrollToBottom,
		setAutoScrollFromScroller,
		setUserScrollIntent,
		scrollerScrollApiRef,
		scrolledWindowTurns,
		expandWindow,
		windowExpandableRef,
		isSurfaceLoading,
		navBlockingVirtualization: restorePhase !== "complete" || pendingJump !== undefined,
		knownEmpty,
		reloadFromDisk,
		startDshHostAndReload,
	};
}
