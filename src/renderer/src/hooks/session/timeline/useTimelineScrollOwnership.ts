import { type Atom } from "jotai";
import { type RefObject, useCallback, useEffect, useLayoutEffect } from "react";
import type { ChatMessage } from "../../../../../shared/types";
import { type SessionScrollAnchor, type SessionSendState } from "../../../atoms";
import type { MessageScrollerScrollApi } from "../../../components/agents/message-scroller";
import { browsePinScrollTop, resolvePinnedRowFallback, shouldCompensateBrowsePin, type BrowsePin } from "../../timeline/browsePin";
import { latestUserMessage, type SendScrollPositioner } from "../../timeline/sendScroll";
import { shouldIgnoreFollowReport } from "../../timelineJumpGuard";
import type { VisibleTimelineRow } from "../../timeline/useVisibleTimelineRows";
import { findBrowsePin } from "./timelineSurfacePolicy";

/** 只需读能力的 jotai store（与 useStore() 的返回值结构兼容）。 */
export type TimelineAtomStore = { get: <Value>(atom: Atom<Value>) => Value };

export interface TimelineScrollOwnershipOptions {
	ownerKey: string;
	ownerKeyRef: RefObject<string>;
	timelineRef: RefObject<HTMLElement | null>;
	messages: ChatMessage[];
	scrollerScrollApiRef: RefObject<MessageScrollerScrollApi | null>;
	autoScrollRef: RefObject<boolean>;
	setAutoScroll: (following: boolean) => void;
	setShowScrollToBottom: (show: boolean) => void;
	browsePinRef: RefObject<BrowsePin | null>;
	browsePinFrozenRef: RefObject<boolean>;
	skipBrowsePinRef: RefObject<boolean>;
	/** 本提交里刚插入过扩窗行（一次性标记，pinBrowseRow 消费式读取）。 */
	expandInsertedRef: RefObject<boolean>;
	pinFallbackHeightRef: RefObject<number>;
	readVisibleRowsRef: RefObject<() => VisibleTimelineRow[]>;
	measurePinnedRowTop: (timeline: HTMLElement, messageId: string) => number | null;
	pendingJumpRef: RefObject<unknown>;
	settleScrollCancelRef: RefObject<(() => void) | undefined>;
	sendScrollRef: RefObject<SendScrollPositioner>;
	sendMessageBaselineRef: RefObject<{ ownerKey: string; messageId: string | undefined; entryId: string | undefined } | undefined>;
	pendingSendScrollRef: RefObject<{ ownerKey: string; messageId: string } | undefined>;
	positionedSendMessageRef: RefObject<string | undefined>;
	restoreAnchor: SessionScrollAnchor | undefined;
	restorePhase: "pending" | "complete";
	/** 发送态快照按会话归属：恢复完成后用它判「这条 user 消息就是本次提交」。 */
	sessionId: string | undefined;
	invalidateHistoryBrowsing: () => void;
	markProgrammaticScroll: (durationMs?: number) => void;
	clearProgrammaticTimelineScroll: () => void;
	/**
	 * jotai store 与两个 atom 由主 hook 传入，子 hook 不直接 import 它们：单测按 specifier
	 * stub 掉 ../atoms，子 hook 自己 import 会变成「真实 atom 对替身 store」，
	 * 发送态判据（requestId === 消息 id）会静默失效。
	 */
	store: TimelineAtomStore;
	scrollToLatestOnSendAtom: Atom<boolean> | undefined;
	sessionSendStateByIdAtom: Atom<Record<string, SessionSendState>> | undefined;
	/** 发送置顶动画进行中标记（session 级 atom），TurnRow 的折叠延迟读它。 */
	setSendPinAnimating: (active: boolean) => void;
}

export interface TimelineScrollOwnership {
	scrollToBottom: () => void;
	scrollTimelineBy: (deltaY: number) => void;
	pinViewportAfterPrepend: (nextTop: number) => void;
	captureBrowsePin: (freeze: boolean) => void;
	pinBrowseRow: () => void;
	setAutoScrollFromScroller: (following: boolean) => void;
}

/**
 * 滚动所有权：谁在写视口位置（2026-12 从 useSessionTimelineController 提出）。
 *
 * 三组入口共用同一套「浏览钉 / 程序化滚动标记 / 跟底状态」：
 *   - 回底与回底引擎（scrollToBottom / scrollTimelineBy）；
 *   - 顶部插入后的钉行补偿（pinViewportAfterPrepend / captureBrowsePin / pinBrowseRow）；
 *   - 引擎跟底上报（setAutoScrollFromScroller）与发送那一刻的置顶定位（useLayoutEffect）。
 * 判据仍是纯函数（browsePin / timelineJumpGuard / sendScroll），这里只做编排；
 * hook 调用顺序、依赖数组与搬迁前逐行一致。
 */
export function useTimelineScrollOwnership(options: TimelineScrollOwnershipOptions): TimelineScrollOwnership {
	const {
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
		sessionId,
		invalidateHistoryBrowsing,
		markProgrammaticScroll,
		clearProgrammaticTimelineScroll,
		store,
		scrollToLatestOnSendAtom,
		sessionSendStateByIdAtom,
		setSendPinAnimating,
	} = options;

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
		const sendState = sessionId && sessionSendStateByIdAtom != null ? store.get(sessionSendStateByIdAtom)[sessionId] : undefined;
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
	}, [clearProgrammaticTimelineScroll, invalidateHistoryBrowsing, markProgrammaticScroll, sessionId, ownerKey, restoreAnchor, restorePhase, sendMessageId, setSendPinAnimating]);
	useEffect(
		() => () => {
			pendingSendScrollRef.current = undefined;
			positionedSendMessageRef.current = undefined;
			sendScrollRef.current.reset();
		},
		[],
	);

	return { scrollToBottom, scrollTimelineBy, pinViewportAfterPrepend, captureBrowsePin, pinBrowseRow, setAutoScrollFromScroller };
}
