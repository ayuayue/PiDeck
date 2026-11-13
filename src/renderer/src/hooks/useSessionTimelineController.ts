import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { atom, useAtomValue, useSetAtom, useStore } from "jotai";
import { showNotice } from "../utils/notice";
import { latestUserMessage, SendScrollPositioner } from "./timeline/sendScroll";
import { ROOT_ROW_SELECTOR, useVisibleTimelineRows, type VisibleTimelineRow } from "./timeline/useVisibleTimelineRows";
import { capWindowTurns, planWindowExpandBatch } from "../components/session/timeline/windowExpandPlan";
import { useTimelineHistoryPaging, type TaggedTimelinePrependAnchor } from "./session/timeline/useTimelineHistoryPaging";
import { useTimelineScrollAnchor } from "./session/timeline/useTimelineScrollAnchor";
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
import { shouldAutoExpandRenderWindow } from "./timeline/scrollHistoryPolicy";
import { beginProgrammaticScroll, clearProgrammaticScroll, createProgrammaticScrollGuard, finishProgrammaticScrollFrame, isProgrammaticScrollActive } from "./timeline/programmaticScrollGuard";
import { browsePinScrollTop, followBrowsePinAfterUserScroll, pickVisibleRootRow, resolvePinnedRowFallback, shouldCompensateBrowsePin, type BrowsePin } from "./timeline/browsePin";
import { countUserTurns, TIMELINE_MOUNTED_TURN_LIMIT, TIMELINE_SCROLLED_TURN_LIMIT, TIMELINE_WINDOW_EXPAND_STEP } from "../components/session/timeline/turnRenderWindow";
import { readSessionFirstScreenPage } from "../components/session/sessionSubagentTranscript";
import { estimateJumpExpandTurns, resolveJumpFallbackEntry, resolveJumpPendingAction } from "../components/session/timeline/jumpWindowPolicy";
import { resolveMissingAnchorNextStep } from "../components/session/timeline/restoreAnchorPolicy";
import { shouldDeferJumpUntilLoaded } from "./timeline/timelineRevealChannel";
import { resolveJumpMessageIndex, resolveJumpScrollTarget } from "../components/session/timeline/jumpTarget";
import { planJumpSettleStep } from "../components/session/timeline/jumpSettle";
import { shouldIgnoreFollowReport, shouldResetExpandBudget } from "./timelineJumpGuard";

/** 滚动接近顶部自动加载历史的阈值（px，2026-11 轮次模型）：
 *  贴顶（≤8px）才触发翻页——「滑到底才翻」，避免在顶部附近任何滚动都连翻历史页。
 *  同时用作「顶部不补偿」阈值：视口顶部 prepend/展开新内容时保持原位可见，
 *  补偿会把新内容推出视口（点击「加载更多/显示更早」无反馈根因，2026-02 修复）。 */
export const HISTORY_AUTO_LOAD_THRESHOLD = 8;
/** 翻页冷却（ms）：加载完成后立即再滚到顶不连翻，需停顿后重新触发（防惯性滚动连翻多页）。 */
const HISTORY_AUTO_LOAD_COOLDOWN_MS = 300;
/** 自动扩窗口冷却（ms）：防惯性滚动接近顶部时连扩多轮（与翻页冷却同量级）。 */
const TURN_WINDOW_AUTO_EXPAND_COOLDOWN_MS = 300;
/** 分批扩窗的轮数预算与封顶算法在 windowExpandPlan（纯函数，便于行为测试）。 */

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
/** 首屏读盘与后续分页共用一个序号计数器：谁发起新请求，谁的旧响应就算迟到。 */
function allocateLoadSequence(): number {
	return ++nextLoadSequence;
}
function getLatestLoad(sessionId: string): number | undefined {
	return latestLoadBySession.get(sessionId);
}
/** sessionId 为空时的占位 atom：恒 undefined（无会话不订缓存条目）。 */
const NO_CACHE_ENTRY_ATOM = atom(undefined);

// 用户主动向上滚超过此阈值后停止自动跟底。值设很小是为了让用户稍微滚一点就能挣脱自动滚动，
// 避免流式消息频繁触发 ResizeObserver/MutationObserver 把用户弹回底部造成"颤抖"。
const BOTTOM_THRESHOLD = 16;
/** 跟底跟流时落盘阅读锚点的跳过距离。流式增长时跟随动画天然滞后（实测 SLOW 流式稳定
 *  48–93px），这段滞后仍属于「在跟底」，不能当成用户上滚：否则切回会话时
 *  anchor !== undefined → autoScroll=false → 正文继续输出却不再跟随、还冒出回底按钮。
 *  取跟底引擎回底窗口（followState STICK_TO_BOTTOM_OFFSET_PX = 70）的两倍，
 *  仍远小于真实上滚阅读的距离。 */
const FOLLOWING_ANCHOR_SKIP_PX = 140;
const LEGACY_OWNER_KEY = "legacy";

type Tagged<T> = { ownerKey: string; value: T };

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

export function isSessionRuntimeBusy(status: string | undefined, state: AgentRuntimeState | undefined, backend?: string): boolean {
	// ACP：status 只会随 tab 快照更新，可能比回合结算晚一拍；isTurnActive 已显式落回 false
	// （此时输入预测 ghost 已经出现）却仍报 running 时，按空闲处理。否则 Tab 采纳预测后的
	// 发送会被误判成「忙碌」排进 followUp 队列，输入框上方凭空多出一条队列行。
	if (backend === "acp" && state?.isTurnActive === false) return false;
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
export function isKnownEmptySessionRecord(record: Pick<SessionRecord, "status" | "filePath" | "messageCount" | "backend" | "dshSessionId" | "locator"> | undefined): boolean {
	if (!record) return false;
	if (record.status === "draft") return true;
	if ((record.messageCount ?? 0) > 0) return false;
	if (record.filePath) return false;
	// SSH 的 messageCount=0 是未读取摘要，不是磁盘无历史；归档恢复的新记录没有内存缓存。
	// 只要已有远端文件身份就必须读页。草稿仍由上面的 draft 分支保留空态。
	if (record.locator?.kind === "ssh" && (record.locator.remoteSessionId || record.locator.remotePath)) return false;
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
export function shouldSkipInitialDiskLoad(cachedEntry: { source: "disk" | "runtime" | "remote"; messages: readonly unknown[]; history?: { messages: readonly unknown[] } } | undefined, knownEmpty: boolean): boolean {
	if (knownEmpty) return true;
	if (!cachedEntry) return false;
	if (cachedEntry.messages.length > 0 || (cachedEntry.source === "runtime" && Boolean(cachedEntry.history?.messages.length))) return true;
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
 *   - loadState 已是终态错误（读盘失败 / 文件缺失 / DSH 专态）→ 不得自动重读：错误态没有
 *     缓存条目，跳过条件会退化成「effect 每次重跑都读盘」，而 effect 依赖 loadStateStatus，
 *     形成 loading↔error 的读盘死循环（2026-11 现场：Windows 模式点开 WSL 路径会话，
 *     48 次/秒 IPC，页面一直闪）。错误由 UI 呈现并支持手动重试，自动恢复只靠重新挂载。
 */
export function shouldSkipInitialDiskRead(input: { previouslyLoaded: boolean; cachedEntry: { source: "disk" | "runtime" | "remote"; messages: readonly unknown[]; history?: { messages: readonly unknown[] } } | undefined; knownEmpty: boolean; loadStateStatus: SessionLoadState["status"] | undefined }): boolean {
	if (shouldSkipInitialDiskLoad(input.cachedEntry, input.knownEmpty)) return true;
	// 首次挂载到本会话：是否读盘完全由缓存权威性决定（与旧行为一致）。
	if (!input.previouslyLoaded) return false;
	// 读盘已给出终态错误：等用户手动重试，不能让 effect 自己再发一次（死循环，见函数注释）。
	if (input.loadStateStatus === "error") return true;
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
	loadMoreMessages: (source?: "scroll" | "button" | "backfill") => void;
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
	/**
	 * 需要「整表真实渲染」的时机（三处，同一套机制）：
	 * 1. 恢复锚点 / 挂起跳转在途 —— 这两条路径按 [data-message-id] 查 DOM；
	 * 2. 顶部插入（扩窗 / 数据翻页）在途 —— 插入会把视口里的行推走、被虚拟化卸载，
	 *    之后 pinBrowseRow 拿不到 currentTop，补不了位移（用户看到内容跳一下）；
	 * 3. 多选导出（渲染层自己的 state，不在这里）。
	 * 虚拟区外的行不在 DOM 里，上述场景必须整表挂载。
	 */
	navBlockingVirtualization: boolean;
	/** 当前钉住行的 messageId（浏览态）；无钉行时为 null。读 ref，不触发渲染。 */
	readPinnedMessageId: () => string | null;
	/** 跳转在途：贴底跟随的窗口压缩要让位，否则流式期间目标轮挂不上。 */
	jumpPending: boolean;
	/** 顶部插入收尾：渲染层做完 pin 补偿后调用，解除整表渲染。 */
	endPrependSolid: () => void;
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

	/** 与锚点一起保存：DOM 裁剪窗口是阅读位置的一部分，而非瞬时 UI 状态。 */
	const renderedWindowTurnsRef = useRef(TIMELINE_SCROLLED_TURN_LIMIT);
	const saveScrollAnchor = useSetAtom(saveSessionScrollAnchorAtom);

	// 浏览钉行元素缓存（2027-02 性能审计）：measureBrowsePinViewportTop 走全子树
	// 属性选择器（O(挂载子树)），而浏览态 ResizeObserver 在内容每次增高（流式正文、
	// 图片加载、Markdown 轻量→全量）时都回调 pinBrowseRow——等于每帧一次全子树扫描。
	// 钉行期间行元素不变，缓存后热路径只读两处 rect；行被卸载（折叠/扩窗重建/切会话）
	// 时 isConnected 失效，自动回退一次重查。与 issue #400 的「可见行缓存」互补：
	// 那是找新钉行（findBrowsePin），这是盯住已钉行，互不重叠。
	const pinnedRowElRef = useRef<{ id: string; element: HTMLElement } | null>(null);
	/** 上一次成功补偿时的容器总高：钉行查不到 DOM 时用它做高度差兜底。
	 *  扩窗分帧（每帧 setScrolledWindowTurns）在虚拟化开启时会把钉行推出 overscan，
	 *  measurePinnedRowTop 返回 null。此时按容器高度差补一次，精度低于按行对齐，
	 *  但好过完全不补（不补 = 视口往下掉，用户看到内容整体上窜）。 */
	const pinFallbackHeightRef = useRef(0);
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

	// 视口内的行（O(视口)）：滚动热路径只读这一份缓存，不再全量遍历 DOM
	const { readVisibleRows } = useVisibleTimelineRows(timelineRef);
	const readVisibleRowsRef = useRef<() => VisibleTimelineRow[]>(() => []);
	useEffect(() => {
		readVisibleRowsRef.current = readVisibleRows;
	}, [readVisibleRows]);

	// ── Load messages from disk when sessionId changes ──
	// 只订本会话缓存条目（family selectAtom 隔离）：其它会话的消息到达/分页不拖着重渲染本栏。
	const cachedEntry = useAtomValue(options.sessionId ? sessionMessageCacheBySessionIdAtomFamily(options.sessionId) : NO_CACHE_ENTRY_ATOM);
	// 预热空窗口期间历史仍在前缀；加载/空态必须看完整显示数组，不能只看 runtime 窗口。
	const runtimeHistory = controllerEnabled && cachedEntry?.source === "runtime" ? cachedEntry.history : undefined;
	const combinedMessages = useMemo(() => (runtimeHistory ? [...runtimeHistory.messages, ...messages] : messages), [runtimeHistory, messages]);
	const cacheMessages = useSetAtom(cacheSessionMessagesAtom);
	const prependMessagePage = useSetAtom(prependSessionMessagePageAtom);
	const prependHistoryPage = useSetAtom(prependSessionHistoryPageAtom);
	const setLoadState = useSetAtom(setSessionMessageLoadStateAtom);
	const touchMessages = useSetAtom(touchSessionMessagesAtom);
	const clearHistory = useSetAtom(clearSessionHistoryAtom);
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
		if (combinedMessages.length > 0) {
			stickyEmptySessionIds.delete(stickySessionId);
		} else if (knownEmptyFromRecord) {
			addStickyEmptySession(stickySessionId);
		}
	}
	const knownEmpty = Boolean(stickySessionId && (knownEmptyFromRecord || stickyEmptySessionIds.has(stickySessionId)));
	// 与 SessionMessageTimeline 同一套 deriveSessionSurfaceRuntime：历史会话首帧
	// messages 仍为空时视为加载中，底部 composer 不能卸掉。空草稿除外——
	// 新建/切回空会话必须留在起始页，不能先挂底部栏再卸（输入框上跳）。
	const isSurfaceLoading = deriveSessionSurfaceRuntime(combinedMessages.length, loadStateStatus, undefined, undefined, undefined, Boolean(cachedEntry), knownEmpty).isLoading;

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

		// 子代理子会话（parentSessionPath）首开把数据窗口补拉到 40 轮：上滚/「显示更早」
		// 在缓存内零延迟；DOM 挂载窗口仍按贴底治理渐进展开，不受影响。
		void readSessionFirstScreenPage((id, before, pageSize) => desktopApi.sessions.readRecordMessagePage(id, before, pageSize), sessionId, sessionRecord?.parentSessionPath)
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
	/**
	 * 顶部插入（扩窗 / 数据翻页）在途：期间整表真实渲染，与锚点恢复同一套机制。
	 *
	 * 为什么必须这样：插入把视口里的那一轮整体推走，虚拟化会顺手把它卸载；之后
	 * pinBrowseRow 读到 currentTop === null 就再也补不了位移 —— 用户看到的是「点一下
	 * 显示更早，内容整体跳一下」。整表挂载期间 DOM 稳定，按行补偿照常工作。
	 * e2e/timeline-virtualization.spec.ts 的「showing earlier turns keeps the pinned row
	 * at the same viewport offset」就是这条的回归锁（2026-10 复审抓到的真回归）。
	 *
	 * 用超时兜底：分页失败 / 没有新内容时也必须解除，否则整表一直挂着。
	 */
	const [prependSolid, setPrependSolid] = useState(false);
	const prependSolidTimeoutRef = useRef<number | undefined>(undefined);
	// 整表渲染的「代数」：begin/end 都递增，end 排下的 rAF 回调比对代数，过期即放弃。
	// 没有它时，上一页的 end 会在下一帧无条件 setPrependSolid(false)——若同一帧内又 begin 过
	// （连点按钮、或多条路径同时补页），整表渲染被提前撤掉，插进来的行随即被虚拟化卸载，
	// pinBrowseRow 找不到钉住的行、位移补不上，表现为「内容变多了，但视口轻轻跳一下」。
	const prependSolidTokenRef = useRef(0);
	// 与 autoScroll 初始值保持一致（有锚点的会话首帧即不跟底），避免首帧 ref/state 不一致
	const autoScrollRef = useRef(autoScroll);
	/** 顶部插入期间开整表渲染；插入被消费（pin 补偿做完）或超时后关。 */
	const beginPrependSolid = useCallback(() => {
		prependSolidTokenRef.current += 1;
		setPrependSolid(true);
		if (prependSolidTimeoutRef.current !== undefined) window.clearTimeout(prependSolidTimeoutRef.current);
		// 1.5s 兜底：请求失败、或这一页恰好没有新轮次时不会有「消费」事件，必须自己解除。
		prependSolidTimeoutRef.current = window.setTimeout(() => {
			prependSolidTimeoutRef.current = undefined;
			setPrependSolid(false);
		}, 1500);
	}, []);
	const endPrependSolid = useCallback(() => {
		if (prependSolidTimeoutRef.current !== undefined) {
			window.clearTimeout(prependSolidTimeoutRef.current);
			prependSolidTimeoutRef.current = undefined;
		}
		// 推迟一帧：pin 补偿写在 useLayoutEffect 里，同帧关掉会让 React 立刻把行换回虚拟行，
		// 补偿结果随之作废（切回虚拟行会重新挂载不同 DOM）。
		// 取代数后再排帧：回调执行时若代数已变（期间又 begin 过），说明这次插入还没被消费，
		// 必须放弃关闭，否则整表渲染被提前撤掉、pin 补偿落空。
		const token = ++prependSolidTokenRef.current;
		window.requestAnimationFrame(() => {
			if (prependSolidTokenRef.current !== token) return;
			setPrependSolid(false);
		});
	}, []);
	// 卸载时清掉兜底定时器：会话切走/面板关闭后它还会 fire 一次 setState（React 18 静默忽略，
	// 但那是「靠框架宽容活着」，不是我们想要的状态机）。
	useEffect(
		() => () => {
			if (prependSolidTimeoutRef.current !== undefined) {
				window.clearTimeout(prependSolidTimeoutRef.current);
				prependSolidTimeoutRef.current = undefined;
			}
		},
		[],
	);
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
	/** 发送定位只比较 user 身份变化；首帧/切会话取基线，不重播历史消息。
	 * entryId 随基线记录：预热重投影把同一消息换 id 时，靠它判等避免误触发定位。 */
	const sendScrollRef = useRef(new SendScrollPositioner());
	const sendMessageBaselineRef = useRef<{ ownerKey: string; messageId: string | undefined; entryId: string | undefined } | undefined>(undefined);
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
	const loadMoreAnchorRef = useRef<TaggedTimelinePrependAnchor | undefined>(undefined);
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
	 * 跳转事务的同步镜像。滚动回调是引擎每帧上报的，读 state 会读到「跳转已开始但渲染未落地」
	 * 的旧值；用 ref 才能在同一个 cascade 里挡住贴底上报。
	 *
	 * 为什么需要挡（用户三次反馈「输出时点刻度跳不回去」）：流式输出时引擎每帧都在 resize，
	 * 一旦它上报 following=true，autoScroll 变 true 的 effect 会清空 pendingExpandTurnsRef
	 * 并 cancel 扩窗帧——挂起中的跳转永远等不到目标轮挂载，表现就是「点了没反应」，
	 * 而停止输出后再点就正常（这时没有新的 resize 上报）。跳转期间不接受引擎的跟底上报，
	 * 用户真的自己滚回底部时走 setUserScrollIntent/handleTimelineScroll，不受这条影响。
	 */
	const pendingJumpRef = useRef(pendingJump);
	// 渲染期同步（不做成 effect）：跳转与贴底上报常发生在同一帧，effect 太晚。
	pendingJumpRef.current = pendingJump;
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
	const highlightTimersRef = useRef(new Map<number, number>());
	// ── 上滚渲染窗口（2026-08 黑屏治理）──
	// 贴底和上滚初始都只挂 3 轮；每次接近顶部最多扩一个 3 轮 cohort，
	// 先消费 atom 已有的尾部 9 轮，再进入主进程缓存/文件分页。回底开始新的浏览周期。
	/** 已加载消息条数（渲染期同步）：渲染窗口的轮数不可能超过它，超过就是无效膨胀。 */
	const loadedMessageCountRef = useRef(0);
	loadedMessageCountRef.current = combinedMessages.length;
	const [scrolledWindowTurns, setScrolledWindowTurns] = useState(() => initialRestoreState.scrolledWindowTurns);
	const [viewStateOwnerKey, setViewStateOwnerKey] = useState(ownerKey);
	/**
	 * 锚点保存的窗口必须与当前 DOM 使用的窗口完全一致：跟随态始终是尾部 3 轮，
	 * 即使 scrolledWindowTurns 尚未被回底 effect 复位，也不能把过期的大窗口写进锚点。
	 */
	const effectiveWindowTurns = autoScroll ? TIMELINE_MOUNTED_TURN_LIMIT : scrolledWindowTurns;
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
	/** 这一提交里刚插入过扩窗行（一次性标记，读完即清）。
	 *
	 * 为什么不用 pendingExpandTurnsRef > 0 判断：consumeExpandBatch 第一行就把
	 * expandBatchFrameRef 置空，最后一帧把 pending 减到 0 且不再排帧。等比补偿跑到
	 * pinBrowseRow 时两个条件都是假 —— **恰是最该补的那一帧**被判成「没在扩窗」。 */
	const expandInsertedRef = useRef(false);
	const expandBatchFrameRef = useRef<number | undefined>(undefined);
	const consumeExpandBatch = useCallback(() => {
		expandBatchFrameRef.current = undefined;
		if (pendingExpandTurnsRef.current <= 0) return;
		// 已回底（回底按钮/手动滚回底部）：批次作废。回底会触发窗口 6→3 轮收回，
		// 是一次大幅内容收缩；若此时继续消费批次，会把刚收回的窗口又扩回去
		// （回底后按钮反复出现、滚到底跟着就掉开的根因之一）。
		if (autoScrollRef.current && !pendingJumpRef.current) {
			pendingExpandTurnsRef.current = 0;
			// 不再在这里收整表渲染：扩窗不再打开它（begin 只在 loadMoreMessages 的
			// needsSolid 分支里）。这里若调 end，会 ++token 排一帧 setPrependSolid(false)，
			// 把 scroll 路径刚打开、还在等锚点消费的整表渲染提前撤掉 —— 与 651701300 修的是
			// 同一个形状，只是主角换成了扩窗。回底作废批次的收口由锚点消费点承担：
			// autoScroll 为真时 useLayoutEffect 会走「跟底中」分支并 end。
			return;
		}
		// 待扩量可能远超单帧预算：每条补页都会排一批，补到很早的历史可累计上百轮。
		// 一律按 planWindowExpandBatch 切片（8 轮/帧）：既不卡单帧，也不会在一条 rAF
		// 链上连发上百次 setState（旧实现在 backlog > 24 时一帧挂满整批，那一帧必掉）。
		const batch = planWindowExpandBatch(pendingExpandTurnsRef.current);
		pendingExpandTurnsRef.current -= batch;
		// 轮数上限 = 已加载消息数：到顶就不再涨（封顶与不缩回的取舍见 windowExpandPlan）。
		const windowCap = Math.max(loadedMessageCountRef.current, TIMELINE_SCROLLED_TURN_LIMIT);
		// 一次性标记：pinBrowseRow 读到后立刻清，同一帧只补一次。
		expandInsertedRef.current = true;
		setScrolledWindowTurns((prev) => capWindowTurns(prev, batch, windowCap));
		if (pendingExpandTurnsRef.current > 0) {
			// 还有剩余：下一帧继续消费，摊平布局/渲染压力
			expandBatchFrameRef.current = window.requestAnimationFrame(consumeExpandBatch);
		} else {
			// 不再在这里收整表渲染：扩窗全程不再打开它。钉住的行由 rangeExtractor
			// 强制挂载（VirtualRunList 的 pinnedRunKeys），不需要整表真实渲染就能查到行。
		}
		// 函数体已不再用 endPrependSolid：留着依赖会让它一变就重建 consumeExpandBatch，
		// 进而重建 expandWindowBatched 和一串下游 useCallback。
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
			// 不再打开整表渲染：钉住的行由 VirtualRunList 的 pinnedRunKeys + rangeExtractor
			// 强制挂载，插入后那一行仍在 DOM 里，pinBrowseRow 查得到。原来这里 begin 是
			// 「为了能查到行」，代价是扩窗期间全部已加载轮次真实挂载（用户 137 轮时必然掉帧）。
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
	// 回底/卸载时取消未消费的分批扩展（窗口重置回基础大小，pending 作废）。
	// 跳转在途时**不执行**：流式输出期间贴底引擎每帧把 autoScroll 设回 true，这里一跑就
	// 把刚排上的扩窗清空、窗口压回 3 轮，目标轮永远挂不上——「吐 token 时点刻度没反应」。
	useEffect(() => {
		// pendingJump 存在时不清预算：跳转靠分批扩窗把目标轮挂出来，清了就永远挂不出来。
		if (shouldResetExpandBudget(autoScroll, Boolean(pendingJumpRef.current))) {
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
		// 消费式读取放在最前面：本函数任何一条出口都算结算了这一帧的插入标记。
		// 标记由 consumeExpandBatch 每帧置 true（只要有 pending），所以这里清掉不会
		// 永久丢信号 —— 下一帧还在扩窗就会重新置上。
		// 清在出口之外是必须的：只清某几条分支，正常路径（扩窗帧最常见）和
		// skip/autoScroll 提前 return 都会把 true 留到下一帧，那一帧若因 Markdown 异步
		// 长高把钉行挤出虚拟区，就会把「内容自己长高」误判成「正在扩窗插入」并补一次。
		// 贴底（autoScroll）与 skip 本来就不该补偿，清标记正是结算这件事的写法。
		const expanding = expandInsertedRef.current;
		expandInsertedRef.current = false;
		if (skipBrowsePinRef.current || autoScrollRef.current || sendScrollRef.current.isAnimating) return;
		const pin = browsePinRef.current;
		const timeline = timelineRef.current;
		if (!pin || !timeline) return;
		const currentTop = measurePinnedRowTop(timeline, pin.messageId);
		const nextHeight = timeline.scrollHeight;
		// 钉行不在 DOM（虚拟区外的行不渲染，扩窗分帧期间常见）：按容器高度差兜底。
		// 必须放在 shouldCompensateBrowsePin 之前 —— 它在 currentViewportTop === null
		// 时返回 false（browsePin.ts:shouldCompensateBrowsePin），放在后面就是死代码。
		if (currentTop === null) {
			const delta = resolvePinnedRowFallback({
				expanding,
				previousHeight: pinFallbackHeightRef.current,
				nextHeight,
				viewportHeight: timeline.clientHeight,
			});
			// 更新点必须在所有出口之前，否则 shouldCompensate 早退后高度基准停在很早的值，
			// 下一次 null 会把已经补过的量再补一遍。
			pinFallbackHeightRef.current = nextHeight;
			if (delta !== null) pinViewportAfterPrepend(timeline.scrollTop + delta);
			return;
		}
		pinFallbackHeightRef.current = nextHeight;
		if (
			!shouldCompensateBrowsePin({
				following: autoScrollRef.current,
				currentViewportTop: currentTop,
				expectedViewportTop: pin.expectedViewportTop,
			})
		) {
			return;
		}
		pinViewportAfterPrepend(browsePinScrollTop(timeline.scrollTop, currentTop, pin.expectedViewportTop));
		const after = measurePinnedRowTop(timeline, pin.messageId);
		if (after !== null) {
			browsePinRef.current = { messageId: pin.messageId, expectedViewportTop: after };
		}
	}, [pinViewportAfterPrepend]);

	const setAutoScrollFromScroller = useCallback(
		(following: boolean) => {
			// 跳转事务进行中：不接受引擎的跟底上报（见 pendingJumpRef 注释）。
			// 第三维是浏览 pin：跳转落位后目标行已在 DOM、没有 pendingJump，此时若不看 pin，
			// 引擎在流式期间的 following=true 上报会把 autoScroll 拉回 true，下一帧就滚回底部（「跳了又弹回」）。
			if (shouldIgnoreFollowReport(following, Boolean(pendingJumpRef.current), browsePinRef.current !== null)) return;
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

	const sendMessage = latestUserMessage(messages);
	const sendMessageId = sendMessage?.id;
	useLayoutEffect(() => {
		const baseline = sendMessageBaselineRef.current;
		sendMessageBaselineRef.current = { ownerKey, messageId: sendMessageId, entryId: sendMessage?.entryId };
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
		// 预热激活后 pi 运行时首次全量 flush 会把磁盘页投影（_viewer-history-X）换成运行时投影
		//（<agentId>-history-X）：同一条消息改写 id，不是一次新发送。若按 changed 触发发送定位，
		// 历史会话在输入框打字预热时会整页跳动到末条消息再回底。新旧两侧都有 entryId 且相等
		// 才判等：乐观气泡无 entryId、无 entryId 的后端（DSH 等）保持原 changed 语义。
		const reprojectedSameMessage = sendMessageId !== undefined && Boolean(changed) && baseline.entryId !== undefined && sendMessage?.entryId !== undefined && baseline.entryId === sendMessage.entryId;
		if (reprojectedSameMessage) {
			// 只把既有定位/挂起状态迁到新 id，不触发 pin、不登记新挂起。
			if (positionedSendMessageRef.current === baseline.messageId) positionedSendMessageRef.current = sendMessageId;
			const pending = pendingSendScrollRef.current;
			if (pending?.ownerKey === ownerKey && pending.messageId === baseline.messageId) pending.messageId = sendMessageId;
			return;
		}
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
		// 无历史锚点的面板挂载时乐观气泡已在缓存（如引导页首发）：此前的 id 变化没人观察到，
		// 但发送态仍 in-flight 且 requestId 就是这条 user 消息，恢复完成后补一次定位。
		const submissionMatches = !restoreAnchor && sendingRequestId === sendMessageId && !changed;
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
	}, [clearProgrammaticTimelineScroll, invalidateHistoryBrowsing, markProgrammaticScroll, options.sessionId, ownerKey, restoreAnchor, restorePhase, sendMessageId, store, setSendPinAnimating]);
	useEffect(
		() => () => {
			pendingSendScrollRef.current = undefined;
			positionedSendMessageRef.current = undefined;
			sendScrollRef.current.reset();
		},
		[],
	);

	// ── 历史窗口加载与分页（子 hook：请求编排 + 游标 + 失败文案）──
	const { diskPage, earlierHistoryCursor, historyHasMore, hasEarlierPages, visibleMessages, isLoadingMessagePage, setIsLoadingMessagePage, loadMoreError, setLoadMoreError, loadMoreMessages, reloadFromDisk, startDshHostAndReload } = useTimelineHistoryPaging({
		sessionId: options.sessionId,
		controllerEnabled,
		messages,
		combinedMessages,
		runtimeHistory,
		cachedEntry,
		parentSessionPath: sessionRecord?.parentSessionPath,
		timelineRef,
		ownerKey,
		ownerKeyRef,
		autoScroll,
		autoScrollRef,
		historyBrowseGenerationRef,
		loadMoreAnchorRef,
		windowExpandableRef,
		escapeAutoScroll,
		captureBrowsePin,
		expandWindowBatched,
		beginPrependSolid,
		endPrependSolid,
		allocateLoadSequence,
		trackLatestLoad,
		getLatestLoad,
		isTimelineAtBottom,
		ports: {
			readRecordMessagePage: desktopApi.sessions.readRecordMessagePage,
			startDshHost: () => desktopApi.sessions.startDshHost(),
			setLoadState,
			cacheMessages,
			prependMessagePage,
			prependHistoryPage,
			clearHistory,
			translate: t,
		},
	});

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
	/**
	 * 落位之后的收敛纠偏（闭环）。
	 *
	 * 落位那一刻读到的位置只反映「当时的」布局：上方未挂载行的估算高度还没被实测替换、
	 * 扩窗/补页批次还在往上插行、浏览器还把 scrollTop 截在旧的 maxScrollTop 上。
	 * 于是用户看到的是「跳了一段、没到」，只能再点一次刻度、再点一次（真机原话：
	 * 「都要点很多次」「我希望一次性跳转过去」）。
	 *
	 * 这里每帧重测目标行相对视口顶的漂移（正 = 目标在下面），偏了就把 scrollTop 加上漂移
	 * 再落一次，直到 |漂移| <= 1px。位移量不是瞎试：每一帧都按实测值修正，误差单调收敛。
	 * 停的判据有三条（帧数 24 / 600ms / 用户动手），判定本身是纯函数见 jumpSettle.ts。
	 */
	const jumpSettleCancelRef = useRef<(() => void) | null>(null);
	/** 用户在跳转收敛期间真动手了（引擎上报的真实输入），循环下一帧就收手。 */
	const jumpSettleInterruptedRef = useRef(false);
	const cancelJumpSettle = useCallback(() => {
		const cancel = jumpSettleCancelRef.current;
		jumpSettleCancelRef.current = null;
		cancel?.();
	}, []);
	const settleJumpTarget = useCallback(
		(timeline: HTMLElement, messageId: string) => {
			cancelJumpSettle();
			const startedAt = performance.now();
			let frames = 0;
			let frame = 0;
			// 「人动手了」只认引擎判定过的真实输入（wheel/触摸/键盘），见 setUserScrollIntent。
			// 不在这里自己挂 wheel/pointer 监听：那是 2026-09 已经拆掉的完结定位取消链的形状，
			// 而且分不清「用户滚了」与「浏览器为锚定自行修正了 scrollTop」——后者恰恰是本循环
			// 要补的那种漂移，误判成用户动手就等于这次跳转不修了。
			jumpSettleInterruptedRef.current = false;
			// 先把浏览钉钉在目标行：钉行会被 VirtualRunList 的 pinnedRunKeys 强制挂载
			// （rangeExtractor），收敛期间目标行不会因为视口重算被卸载 —— 卸载就等于
			// 再也测不到漂移，这次跳转半途而废。钉的期望偏移 0 与本循环同一个不动点
			// （目标行对齐视口顶），两者的补偿方向一致，不会互相拉扯。
			browsePinRef.current = { messageId, expectedViewportTop: 0 };
			browsePinFrozenRef.current = true;
			const stop = () => {
				if (frame) cancelAnimationFrame(frame);
				frame = 0;
			};
			const step = () => {
				frame = 0;
				const row = timeline.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`) as HTMLElement | null;
				// height <= 0 = 没被布局（折叠区里 display:none、或正在卸载）：它的 rect 全是 0，
				// 拿去算漂移会得出一个巨大的负数，把视口滚到莫名其妙的位置。当作量不到处理。
				const rowRect = row?.getBoundingClientRect() ?? null;
				const driftPx = rowRect && rowRect.height > 0 ? rowRect.top - timeline.getBoundingClientRect().top : null;
				const decision = planJumpSettleStep({
					driftPx,
					frames,
					elapsedMs: performance.now() - startedAt,
					interrupted: jumpSettleInterruptedRef.current,
				});
				if (decision.kind !== "scroll") {
					if (jumpSettleCancelRef.current === stop) jumpSettleCancelRef.current = null;
					stop();
					// 收敛：钉留在目标行（偏移 0）——漂移修正期间行在动，钉若还指着旧偏移，
					// 下一次布局增高就会按旧值把视口拽走。
					if (decision.kind === "settled" && row) {
						browsePinRef.current = { messageId, expectedViewportTop: 0 };
						browsePinFrozenRef.current = true;
					} else if (decision.kind === "give-up" && (decision.reason === "interrupted" || decision.reason === "target-missing")) {
						// 两条出口都要交还钉行：
						// - interrupted：用户自己动手停了这次跳转，钉着会把他在下一次布局增高时
						//   （流式 token、图片加载）拽回目标行，变成「想滚不让滚」。
						// - target-missing：落位后目标行还是从 DOM 消失，说明它挂不出来（context_edit
						//   移出展示 / 折叠区收起）。钉一条永远挂不出来的行没有意义，反而会让
						//   pinBrowseRow 的「按容器高度差兜底」在下次增高时把视口挪一下。
						browsePinRef.current = null;
						browsePinFrozenRef.current = false;
					}
					// frames / timeout 保留钉行：那是「没追完」而不是「追不到」，下一次点击能接上。
					return;
				}
				frames += 1;
				markProgrammaticScroll();
				const apiAfter = scrollerScrollApiRef.current;
				const next = Math.max(0, timeline.scrollTop + decision.delta);
				if (apiAfter?.restoreAt) apiAfter.restoreAt(next);
				else timeline.scrollTop = next;
				frame = requestAnimationFrame(step);
			};
			jumpSettleCancelRef.current = stop;
			frame = requestAnimationFrame(step);
		},
		[cancelJumpSettle, markProgrammaticScroll],
	);
	// 切会话/卸载时别让上一段收敛循环继续改写新会话的滚动位置。
	useEffect(() => cancelJumpSettle, [ownerKey, cancelJumpSettle]);

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
				settleJumpTarget(timeline, target.dataset.messageId ?? targetNodeId);
				highlightMessage(target, requestOwnerKey);
				clearTimelineReveal();
				// 浏览钉交给 settleJumpTarget：它在收敛后把钉钉到目标行（偏移 0）。
				// 这里同步建钉会用到上一帧的可见行快照（新挂载的行还没进 IO 集合），
				// 钉错行反而会在下一次布局增高时把视口拽回跳转前的位置。
				return;
			}
			// 命中可能在已完成轮的「执行过程」折叠区里：Radix 收起会把中间回答/工具整块卸载，
			// 扩窗（只多挂轮次）永远挂不出这些节点。先请求包含它的 TurnRow 展开折叠，
			// 再由下面的 pendingJump 重试循环完成落位。
			if (index >= 0) requestTimelineReveal(targetNodeId);
			const hasMorePages = hasEarlierPages;
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
		[clearTimelineReveal, combinedMessages, escapeAutoScroll, expandWindowBatched, hasEarlierPages, highlightMessage, isSurfaceLoading, ownerKey, requestTimelineReveal, scrollJumpTargetIntoView, settleJumpTarget],
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

	// ── 滚动锚点（子 hook：记录阅读位置 + 切会话恢复 + 切走兜底落盘）──
	const { handleTimelineScroll, cancelSettledRepositionForNewRun, scrollFinalAnswerToUpperMiddle } = useTimelineScrollAnchor({
		messages,
		ownerKey,
		legacyOwnerKey: LEGACY_OWNER_KEY,
		controllerEnabled,
		effectiveWindowTurns,
		renderedWindowTurnsRef,
		timelineRef,
		ownerKeyRef,
		autoScrollRef,
		setAutoScroll,
		setShowScrollToBottom,
		restoreAnchor,
		setRestoreAnchor,
		restorePhase,
		setRestorePhase,
		scrolledWindowTurns,
		setScrolledWindowTurns,
		isSurfaceLoading,
		hasEarlierPages,
		isLoadingMessagePage,
		loadMoreMessages,
		markProgrammaticScroll,
		scrollerScrollApiRef,
		browsePinRef,
		browsePinFrozenRef,
		pinFallbackHeightRef,
		programmaticScrollGuardRef,
		sendScrollRef,
		settleScrollCancelRef,
		windowExpandableRef,
		readVisibleRowsRef,
		measurePinnedRowTop,
		findBrowsePin,
		isTimelineAtBottom,
		timelineViewportTop,
		bottomThreshold: BOTTOM_THRESHOLD,
		followingAnchorSkipPx: FOLLOWING_ANCHOR_SKIP_PX,
		saveScrollAnchor,
	});

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
				// 跳转收敛循环（settleJumpTarget）也一并收手：用户用滚轮/触摸真动手了，
				// 再按实测漂移补一次就是跟他抢滚动位置。
				jumpSettleInterruptedRef.current = true;
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
				const hasMore = hasEarlierPages;
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
		[captureBrowsePin, controllerEnabled, escapeAutoScroll, expandWindowBatched, hasEarlierPages, isLoadingMessagePage, loadMoreMessages, ownerKey],
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
			// 插入已被消费（跟底中或代数过期，不恢复锚点），必须在这里释放：否则
			// prependSolid 只能靠 beginPrependSolid 的 1.5s 超时解除，期间强制整表渲染。
			if (anchor.value.solidOpened) endPrependSolid();
			return;
		}
		// 滚动翻页：钉住正在看的那一轮（不是整页 scrollHeight 差）。
		// 跳转驱动的补页（preserveAtTop 为空）仍走顶部阈值：点刻度时不要把视口焊回旧行。
		if (anchor.value.preserveAtTop) {
			pinBrowseRow();
			loadMoreAnchorRef.current = undefined;
			// 插入已被消费：解除整表渲染（推迟一帧，让这次补偿先落定）。
			if (anchor.value.solidOpened) endPrependSolid();
			return;
		}
		const heightDelta = timeline.scrollHeight - anchor.value.height;
		const nextScrollTop = resolveTimelineTopCompensation(anchor.value.top, heightDelta);
		if (nextScrollTop === null) {
			// 视口贴顶（top <= HISTORY_AUTO_LOAD_THRESHOLD=8px）：**有意不补偿**——插入的内容留在上方，
			// 用户点「加载更多」要看的就是这批更早的消息；补偿反而会让画面停在原地、像「点了没反应」。
			// 但「不补偿」不等于「不结束整表渲染」：锚点已在下面置空、这次插入算消费完，按 beginPrependSolid
			// 的约定就该关。漏掉这一行会让整表渲染拖到 1.5s 兜底超时，超时那一刻虚拟化接管、未挂载行
			// 从实测高度回退估算、总高度突变 → 重排 → 视口轻跳（用户报的「点了几次，内容变多了，但有点抖」）。
			loadMoreAnchorRef.current = undefined;
			markProgrammaticScroll();
			if (anchor.value.solidOpened) endPrependSolid();
			return;
		}
		pinViewportAfterPrepend(nextScrollTop);
		// 探针：默认静默，在控制台执行 window.__PIDECK_PREPEND_DEBUG__ = true 后生效。
		// 用户报「跳/不跳」是主观描述；有了 delta 与写入前后的 scrollTop 才能判断
		// 是估算高度差还是时序问题。（不用 import.meta.env.DEV：测试沙箱按 CJS 转译，
		// import.meta 在那里不可用，会让整份 controller 加载失败。）
		if ((window as { __PIDECK_PREPEND_DEBUG__?: boolean }).__PIDECK_PREPEND_DEBUG__ === true) {
			console.info("[prepend-compensation]", {
				delta: heightDelta,
				prevTop: anchor.value.top,
				nextTop: nextScrollTop,
				afterTop: timeline.scrollTop,
			});
		}
		loadMoreAnchorRef.current = undefined;
		if (anchor.value.solidOpened) endPrependSolid();
	}, [controllerEnabled, endPrependSolid, markProgrammaticScroll, ownerKey, pinBrowseRow, pinViewportAfterPrepend, visibleMessages.length]);

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
			settleJumpTarget(timeline, target.dataset.messageId ?? targetNodeId);
			highlightMessage(target, ownerKey);
			clearTimelineReveal();
			// 浏览钉交给 settleJumpTarget（收敛后钉到目标行）：这里的可见行快照
			// 还是落位前那一帧的，据此建钉会把视口钉回跳转前的位置。
			return;
		}
		// 目标还没挂上：批次在途（跳远时一次排满几十轮）就等它继续消费。
		// 反过来的顺序很重要——**目标一旦挂载就先落位，不等整段历史挂完**：跳远时
		// 一次推开几十轮，DOM 与布局要几百毫秒到几秒，先落位能让用户立刻到那儿；
		// 后续批次在上方插入时，ResizeObserver 的 pinBrowseRow 维持这一行不动。
		if (pendingExpandTurnsRef.current > 0) return;
		// 目标未挂载：按策略兜底扩窗（指数步长）/ 跳转驱动补页 / 放弃（防呆上限）。
		// give-up 保留旧行为兜底：目标已不在数据（压缩清理/删除）时不无限扩窗（2026-08 黑屏治理）。
		const stillInData = targetIndex >= 0;
		const hasMorePages = hasEarlierPages;
		// 冷会话等待：目标还没进数据，但消息尚未上屏（首批未到 / 首屏加载中）。
		// 这不是「目标不存在」—— give-up 会误报「跳转失败」并把插件导航丢掉（#401 复审 P0）。
		// effect 依赖 combinedMessages：数据到达后自动重跑并落位。
		if (!stillInData && shouldDeferJumpUntilLoaded({ targetIndex, messageCount: combinedMessages.length, surfaceLoading: isSurfaceLoading })) return;
		// 补页失败：不推进预算、不自动重发。错误行已由 loadMoreMessages 弹给用户，
		// 他点「加载更多」重试成功后 loadMoreError 清空，本 effect 重跑并继续落位。
		// 放在 resolveJumpPendingAction 之前：失败要吃掉一次 loadAttempts 的话，
		// 保险丝会被空转烧断，用户连点几次之后彻底跳不动。
		if (!stillInData && loadMoreError) return;
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
				settleJumpTarget(timeline, fallbackRow.dataset.messageId ?? pendingJump.value.messageId);
				highlightMessage(fallbackRow, ownerKey);
				return;
			}
			// 静默放弃会被当成「点了没反应」（本次 bug 的原始反馈）：补页/扩窗都到上限时
			// 必须给一句反馈，要么历史太远加载不到，要么这条已被 context_edit 移出展示。
			showNotice(t("sessionFind.jumpFailed"));
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
			loadMoreMessages("backfill");
			return;
		}
		expandWindow(action.turns);
	}, [clearTimelineReveal, combinedMessages, controllerEnabled, expandWindow, findFallbackJumpRow, hasEarlierPages, highlightMessage, isLoadingMessagePage, isSurfaceLoading, loadMoreError, loadMoreMessages, ownerKey, pendingJump, scrollJumpTargetIntoView, scrolledWindowTurns, settleJumpTarget]);

	return {
		timelineRef,
		messages,
		visibleMessages: diskPage ? messages : visibleMessages,
		totalMessageCount: diskPage ? diskPage.total : combinedMessages.length,
		hasMoreMessages: hasEarlierPages,
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
		navBlockingVirtualization: restorePhase !== "complete" || pendingJump !== undefined || prependSolid,
		/** 当前钉住的行（浏览态）。渲染层用它把所在 run 交给 VirtualRunList 的
		 *  pinnedRunKeys，让 rangeExtractor 强制挂载 —— 扩窗/翻页在顶部插入后这一行会
		 *  被推出 overscan，查不到就补不了位移。读 ref，不触发渲染。 */
		readPinnedMessageId: () => browsePinRef.current?.messageId ?? null,
		/** 顶部插入（扩窗/翻页）收尾通知：渲染层的 pin 补偿做完后调用，解除整表渲染。 */
		/** 跳转在途：渲染层据此暂停贴底窗口压缩（流式期间点刻度时目标轮必须能挂上）。 */
		jumpPending: pendingJump !== undefined,
		endPrependSolid,
		knownEmpty,
		reloadFromDisk,
		startDshHostAndReload,
	};
}
