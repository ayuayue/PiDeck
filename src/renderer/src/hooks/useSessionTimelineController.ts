import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { atom, useAtomValue, useSetAtom, useStore } from "jotai";
import { showNotice } from "../utils/notice";
import { SendScrollPositioner } from "./timeline/sendScroll";
import { useVisibleTimelineRows, type VisibleTimelineRow } from "./timeline/useVisibleTimelineRows";
import { capWindowTurns, planWindowExpandBatch } from "../components/session/timeline/windowExpandPlan";
import { useTimelineHistoryPaging, type TaggedTimelinePrependAnchor } from "./session/timeline/useTimelineHistoryPaging";
import { useTimelineScrollAnchor } from "./session/timeline/useTimelineScrollAnchor";
import { selectAtom } from "jotai/utils";
import { desktopApi } from "../desktopApi";
import type { ChatMessage, SessionMessagePage } from "../../../shared/types";
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
	type SessionScrollAnchor,
} from "../atoms";
import { clearTimelineRevealAtom, requestTimelineRevealAtom } from "../atoms/timeline-reveal-atoms";
import type { MessageScrollerScrollApi } from "../components/agents/message-scroller";
import { TURN_WINDOW_AUTO_EXPAND_THRESHOLD, resolveAutoExpandThreshold } from "./timeline/autoExpandThreshold";
import { shouldAutoExpandRenderWindow } from "./timeline/scrollHistoryPolicy";
import { beginProgrammaticScroll, clearProgrammaticScroll, createProgrammaticScrollGuard, finishProgrammaticScrollFrame, isProgrammaticScrollActive } from "./timeline/programmaticScrollGuard";
import type { BrowsePin } from "./timeline/browsePin";
import { countUserTurns, TIMELINE_MOUNTED_TURN_LIMIT, TIMELINE_SCROLLED_TURN_LIMIT, TIMELINE_WINDOW_EXPAND_STEP } from "../components/session/timeline/turnRenderWindow";
import { readSessionFirstScreenPage } from "../components/session/sessionSubagentTranscript";
import { resolveJumpPendingAction } from "../components/session/timeline/jumpWindowPolicy";
import { resolveMissingAnchorNextStep } from "../components/session/timeline/restoreAnchorPolicy";
import { shouldDeferJumpUntilLoaded } from "./timeline/timelineRevealChannel";
import { resolveJumpMessageIndex, resolveJumpScrollTarget } from "../components/session/timeline/jumpTarget";
import { shouldResetExpandBudget } from "./timelineJumpGuard";
import { BOTTOM_THRESHOLD, deriveSessionSurfaceRuntime, findBrowsePin, isKnownEmptySessionRecord, isTimelineAtBottom, matchesTimelineOwner, resolveSessionTimelineRestoreState, resolveTimelineTopCompensation, shouldSkipInitialDiskRead, timelineViewportTop } from "./session/timeline/timelineSurfacePolicy";
import type { SessionTimelineController } from "./session/timeline/sessionTimelineControllerContract";
import { type TaggedTimelineJumpRequest, useTimelineJumpNavigation } from "./session/timeline/useTimelineJumpNavigation";
import { useTimelineScrollOwnership } from "./session/timeline/useTimelineScrollOwnership";

/**
 * 时间线控制器的**装配点**：状态归属与 hook 调用顺序都在这里，按域拆出的子 hook 负责
 * 具体编排（历史分页 / 滚动锚点 / 跳转 / 滚动所有权），纯策略与公开契约见同目录
 * `session/timeline/timelineSurfacePolicy.ts` 与 `sessionTimelineControllerContract.ts`。
 */

// 纯策略模块的对外导出面在拆分前就是本模块的导出面（组件与测试按此路径 import），
// 原样再导出，避免拆文件改变调用方的 import 来源。
export {
	HISTORY_AUTO_LOAD_THRESHOLD,
	canLoadSessionTimelineMore,
	deriveSessionSurfaceRuntime,
	findBrowsePin,
	isKnownEmptySessionRecord,
	isLatestTimelineRunBusy,
	isSessionRuntimeBusy,
	isTimelineAtBottom,
	isUserFacingSessionStart,
	matchesTimelineOwner,
	measureBrowsePinViewportTop,
	resolveSessionTimelineRestoreState,
	resolveTimelineTopCompensation,
	restoreTimelineAnchor,
	shouldSkipInitialDiskLoad,
	shouldSkipInitialDiskRead,
} from "./session/timeline/timelineSurfacePolicy";
export type { SessionTimelineController } from "./session/timeline/sessionTimelineControllerContract";
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

/** 跟底跟流时落盘阅读锚点的跳过距离。流式增长时跟随动画天然滞后（实测 SLOW 流式稳定
 *  48–93px），这段滞后仍属于「在跟底」，不能当成用户上滚：否则切回会话时
 *  anchor !== undefined → autoScroll=false → 正文继续输出却不再跟随、还冒出回底按钮。
 *  取跟底引擎回底窗口（followState STICK_TO_BOTTOM_OFFSET_PX = 70）的两倍，
 *  仍远小于真实上滚阅读的距离。 */
const FOLLOWING_ANCHOR_SKIP_PX = 140;
const LEGACY_OWNER_KEY = "legacy";

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
	const [pendingJump, setPendingJump] = useState<TaggedTimelineJumpRequest | undefined>(undefined);

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

	// ── 滚动所有权（子 hook：回底 / 顶部插入钉行 / 引擎跟底上报 / 发送置顶）──
	const { scrollToBottom, scrollTimelineBy, pinViewportAfterPrepend, captureBrowsePin, pinBrowseRow, setAutoScrollFromScroller } = useTimelineScrollOwnership({
		ownerKey,
		ownerKeyRef,
		timelineRef,
		messages,
		scrollerScrollApiRef,
		autoScrollRef,
		setAutoScroll,
		setShowScrollToBottom,
		browsePinRef,
		browsePinFrozenRef,
		skipBrowsePinRef,
		expandInsertedRef,
		pinFallbackHeightRef,
		readVisibleRowsRef,
		measurePinnedRowTop,
		pendingJumpRef,
		settleScrollCancelRef,
		sendScrollRef,
		sendMessageBaselineRef,
		pendingSendScrollRef,
		positionedSendMessageRef,
		restoreAnchor,
		restorePhase,
		sessionId: options.sessionId,
		invalidateHistoryBrowsing,
		markProgrammaticScroll,
		clearProgrammaticTimelineScroll,
		store,
		scrollToLatestOnSendAtom,
		sessionSendStateByIdAtom,
		setSendPinAnimating,
	});

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

	/** 用户在跳转收敛期间真动手了（引擎上报的真实输入），循环下一帧就收手。 */
	const jumpSettleInterruptedRef = useRef(false);
	// ── 跳转落位与收敛（子 hook：定位 → 逐帧纠偏 → 兜底落点）──
	const { jumpToMessage, scrollJumpTargetIntoView, settleJumpTarget, findFallbackJumpRow } = useTimelineJumpNavigation({
		ownerKey,
		ownerKeyRef,
		timelineRef,
		combinedMessages,
		scrollerScrollApiRef,
		browsePinRef,
		browsePinFrozenRef,
		skipBrowsePinRef,
		jumpSettleInterruptedRef,
		jumpNonceRef,
		hasEarlierPages,
		isSurfaceLoading,
		escapeAutoScroll,
		markProgrammaticScroll,
		highlightMessage,
		requestTimelineReveal,
		clearTimelineReveal,
		expandWindowBatched,
		setShowScrollToBottom,
		setPendingJump,
	});

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
