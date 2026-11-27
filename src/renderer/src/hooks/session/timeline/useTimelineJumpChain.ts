import { useCallback, useEffect, useRef, useState } from "react";
import { showNotice } from "../../../utils/notice";
import { logFromRenderer } from "../../../utils/rendererLog";
import { t } from "../../../i18n";
import { TURN_WINDOW_EXPAND_BATCH_TURNS } from "../../../components/session/timeline/windowExpandPlan";
import { nextJumpTick, nextStalledAttempts, toPendingAction } from "../../../components/session/timeline/jumpMachine";
import { resolveStaleTargetReason } from "../../../components/session/timeline/jumpWindowPolicy";
import { resolveJumpMessageIndex, resolveJumpScrollTarget } from "../../../components/session/timeline/jumpTarget";
import { JUMP_WINDOW_RUNS_EACH_SIDE, JUMP_WINDOW_RUNS_MAX } from "../../../components/session/timeline/turnRenderWindow";
import { shouldDeferJumpUntilLoaded } from "../../timeline/timelineRevealChannel";
import type { ChatMessage } from "../../../../../shared/types";
import type { TaggedTimelineJumpRequest } from "./useTimelineJumpNavigation";

/** 取页结果：状态机只关心「有没有拿回可命中的锚点」和「目标是不是只到得了位置」。 */
export interface JumpPageOutcome {
	outcome: string;
	anchorEntryId?: string | null;
}

export interface TimelineJumpChainOptions {
	controllerEnabled: boolean;
	pendingJump: TaggedTimelineJumpRequest | undefined;
	setPendingJump: (next: TaggedTimelineJumpRequest | undefined | ((previous: TaggedTimelineJumpRequest | undefined) => TaggedTimelineJumpRequest | undefined)) => void;
	timelineRef: { current: HTMLElement | null };
	combinedMessages: ChatMessage[];
	ownerKey: string;
	ownerKeyRef: { current: string };
	jumpNonceRef: { current: number };
	hasEarlierPages: boolean;
	isSurfaceLoading: boolean;
	isLoadingMessagePage: boolean;
	loadMoreError: unknown;
	loadMoreMessages: () => void;
	scrolledWindowTurns: number;
	skipBrowsePinRef: { current: boolean };
	pendingExpandTurnsRef: { current: number };
	jumpAnchorMessageId: string | null;
	setJumpAnchorMessageId: (next: string | null) => void;
	scrollJumpTargetIntoView: (timeline: HTMLElement, target: HTMLElement) => void;
	settleJumpTarget: (timeline: HTMLElement, messageId: string) => void;
	highlightMessage: (element: HTMLElement, expectedOwnerKey: string) => void;
	clearTimelineReveal: () => void;
	requestTimelineReveal: (messageId: string) => void;
	findFallbackJumpRow: (messageId: string) => HTMLElement | null;
	readLastJumpOutcome: () => string | undefined;
	loadPageAroundEntry: (entryId: string, isCurrent?: () => boolean) => Promise<JumpPageOutcome>;
	waitForJumpRow: (timeline: HTMLElement, entryId: string, isCurrent?: () => boolean) => void;
	expandWindow: (turns?: number) => void;
}

/**
 * 跳转链的挂起状态机与锚点窗口半径。
 *
 * 分出来两个理由，都是行数以外的东西：
 * ① 状态机与窗口半径是同一件事的两半 —— 「目标进没进数据」决定要不要取页，
 *    「目标进没进窗口」决定要不要扩窗，两半分开放会各改各的、谁也不知道对方改了。
 * ② 装配点（控制器）只该有 hook 调用顺序与状态归属，不该有 230 行判定链。
 */
export function useTimelineJumpChain(options: TimelineJumpChainOptions) {
	const {
		controllerEnabled,
		pendingJump,
		setPendingJump,
		timelineRef,
		combinedMessages,
		ownerKey,
		ownerKeyRef,
		jumpNonceRef,
		hasEarlierPages,
		isSurfaceLoading,
		isLoadingMessagePage,
		loadMoreError,
		loadMoreMessages,
		scrolledWindowTurns,
		skipBrowsePinRef,
		pendingExpandTurnsRef,
		jumpAnchorMessageId,
		setJumpAnchorMessageId,
		scrollJumpTargetIntoView,
		settleJumpTarget,
		highlightMessage,
		clearTimelineReveal,
		requestTimelineReveal,
		findFallbackJumpRow,
		readLastJumpOutcome,
		loadPageAroundEntry,
		waitForJumpRow,
		expandWindow,
	} = options;
	/**
	 * 跳转锚点窗口的半径（每侧轮数）。锚点窗口是固定半径切片，扩窗改的 scrolledWindowTurns
	 * 在有锚点时不起作用 —— 扩窗必须同时长这个半径，否则「数据里有目标、窗口里没有」只能等超时。
	 * 跳转结束后回到默认：半径只影响切片，不改变用户看到的位置。
	 */
	const [jumpWindowRuns, setJumpWindowRuns] = useState(JUMP_WINDOW_RUNS_EACH_SIDE);
	// 跳转结束立刻把半径缩回默认：半径只服务于「把目标挂出来」，留着会把每侧 40 轮
	// 常驻挂载（大会话掉帧）。缩到默认仍在目标 +-6 轮内，落位结果不会被卸载。
	useEffect(() => {
		if (pendingJump === undefined) setJumpWindowRuns(JUMP_WINDOW_RUNS_EACH_SIDE);
	}, [pendingJump]);
	/** 最新一次点击的请求（代数判据）：迟到的取页结果与等待帧据此作废。 */
	const latestJumpRef = useRef<TaggedTimelineJumpRequest | undefined>(pendingJump);
	latestJumpRef.current = pendingJump;
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);
	/** 扩窗批次等待起点 / 上一次「卡住」告警时刻：批次不推进时状态机被无限挂起，要能看见。 */
	const expandWaitSinceRef = useRef(0);
	const expandStallLogRef = useRef(0);
	/** 定位取页是否在途：状态机读它，在途时 hasMorePages 是取页之前的快照，不能当判据。 */
	const jumpPageInFlightRef = useRef<number | null>(null);
	/** 扩窗同时长半径：只在跳转在途时生效，且有上界（整表挂载是另一类事故）。 */
	const growJumpWindowRuns = useCallback((turns: number) => {
		setJumpWindowRuns((current) => Math.min(JUMP_WINDOW_RUNS_MAX, current + turns));
	}, []);

	useEffect(() => {
		if (!controllerEnabled || !pendingJump) return;
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
			// 落位现场：节点在 DOM 里 ≠ 用户看得见。记下该行的几何与滚动位置，
			// 「点了没反应」和「跳到空白」才能区分开（高度 0 = 落在折叠区）。
			logFromRenderer("info", "jump", "settle", {
				target: pendingJump.value.messageId,
				targetNodeId,
				rectTop: Math.round(element.getBoundingClientRect().top),
				rectHeight: Math.round(element.getBoundingClientRect().height),
				scrollTop: Math.round(timeline.scrollTop),
				scrollHeight: Math.round(timeline.scrollHeight),
				clientHeight: Math.round(timeline.clientHeight),
			});
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
		if (pendingExpandTurnsRef.current > 0) {
			// 批次在途。正常几十毫秒消费完；超过 1.2 秒说明 consumeExpandBatch 没在推进
			// （异常帧、rAF 被节流），状态机就被无限挂起 —— 界面上正是「点了没反应」。
			// 不改控制流（放行会让窗口与状态机打架），只把这一件事变成可读的一行。
			const nowMs = performance.now();
			if (expandWaitSinceRef.current === 0) expandWaitSinceRef.current = nowMs;
			const waitedMs = nowMs - expandWaitSinceRef.current;
			if (waitedMs > 1200 && nowMs - expandStallLogRef.current > 1200) {
				expandStallLogRef.current = nowMs;
				logFromRenderer("warn", "jump", "expand-stall", { pendingTurns: pendingExpandTurnsRef.current, waitedMs: Math.round(waitedMs) });
			}
			return;
		}
		expandWaitSinceRef.current = 0;
		const stillInData = targetIndex >= 0;
		const hasMorePages = hasEarlierPages;
		if (stillInData) setJumpAnchorMessageId(targetNodeId);
		// 冷会话等待：目标还没进数据，但消息尚未上屏（首批未到 / 首屏加载中）。
		// 这不是「目标不存在」—— give-up 会误报「跳转失败」并把插件导航丢掉（#401 复审 P0）。
		// effect 依赖 combinedMessages：数据到达后自动重跑并落位。
		if (!stillInData && shouldDeferJumpUntilLoaded({ targetIndex, messageCount: combinedMessages.length, surfaceLoading: isSurfaceLoading })) return;
		// 补页失败：不推进预算、不自动重发。错误行已由 loadMoreMessages 弹给用户，
		// 他点「加载更多」重试成功后 loadMoreError 清空，本 effect 重跑并继续落位。
		// 放在 resolveJumpPendingAction 之前：失败要吃掉一次 loadAttempts 的话，
		// 保险丝会被空转烧断，用户连点几次之后彻底跳不动。
		if (!stillInData && loadMoreError) return;
		// **跳转的核心：一次定位取页，不等滚动补页。**
		// 反例（2026-11 真机，722 轮）：滚动引擎在飞 → isLoadingPage 恒为 true → tick 一直返回 wait，
		// 补页只往前翻、目标在中间永远翻不到 → 数据从 5617 长到 8393 却始终没有目标 →
		// 两次「没增长」后报 H4，而 loadPageAroundEntry 一次都没被调用（提示里 page=idle）。
		// 所以这里不看 isLoadingPage：目标不在数据里就立刻按 entryId 定位取页。
		// 跳转诊断：落位链有七道静默 return，「点了没反应」看不出挡在哪一步。
		// 只在状态机真正跑起来的那一帧记一条（不是每帧），detail 带齐可判定的量。
		logFromRenderer("info", "jump", "tick", {
			target: pendingJump.value.messageId,
			targetIndex,
			nodeId: targetNodeId,
			messages: combinedMessages.length,
			stillInData,
			hasMorePages,
			pageRequested: pendingJump.value.pageRequested,
			pageInFlight: jumpPageInFlightRef.current === pendingJump.value.requestId,
			revealRequested: pendingJump.value.revealRequested ?? false,
			loadAttempts: pendingJump.value.loadAttempts,
			expandAttempts: pendingJump.value.expandAttempts,
			stalledAttempts: pendingJump.value.stalledAttempts,
			elapsedMs: Math.round(performance.now() - pendingJump.value.startedAt),
			anchor: jumpAnchorMessageId,
		});
		if (!stillInData && !pendingJump.value.pageRequested) {
			setPendingJump({
				...pendingJump,
				value: { ...pendingJump.value, pageRequested: true, nonce: pendingJump.value.nonce + 1 },
			});
			const wanted = pendingJump.value.messageId;
			const requestId = pendingJump.value.requestId;
			const isCurrent = () => mountedRef.current && ownerKeyRef.current === ownerKey && jumpNonceRef.current === requestId && latestJumpRef.current?.ownerKey === ownerKey && latestJumpRef.current?.value.requestId === requestId;
			// 在途标记：状态机据此不把「取页之前的 hasMorePages」当判据（见 jumpMachine ③′）。
			jumpPageInFlightRef.current = requestId;
			void loadPageAroundEntry(wanted, isCurrent)
				.then(({ outcome, anchorEntryId }) => {
					if (!isCurrent()) return;
					logFromRenderer(outcome === "missing" ? "warn" : "info", "jump", "page", { wanted, outcome, anchorEntryId });
					if (outcome === "missing") {
						setPendingJump(undefined);
						showNotice(t("sessionFind.jumpFailed.not-in-branch"));
						return;
					}
					// 只用**能命中**的锚点。positioned 时目标是空 content / system / 被 context_edit 移出的
					// 条目，渲染层根本没有它的消息；拿它当锚点会一条都匹配不上，窗口退回有界尾部。
					if (anchorEntryId) setJumpAnchorMessageId(anchorEntryId);
					if (outcome === "positioned") showNotice(t("sessionFind.jumpFailed.positioned-only"));
					// 取页成功不等于落位成功：数据进缓存后目标行要等虚拟列表下一帧才挂出来。
					// 旧实现在这里 return，把「继续落位」全押在 pendingJump effect 重跑上，而它依赖
					// combinedMessages 的快照——错位时根本不重跑，用户必须再点一次（日志实证：
					// 取页 exact 之后 1.17 秒内没有任何 tick，第二次点击才发现数据到了）。
					// 这里自己盯 DOM：按 entryId 后缀找目标行，出现即落位，最多 120 帧。
					waitForJumpRow(timeline, outcome === "positioned" ? (anchorEntryId ?? wanted) : wanted, isCurrent);
				})
				.catch((error: unknown) => {
					if (!isCurrent()) return;
					// 取页抛错（IPC/缓存写入失败）时也必须给结论：否则 pendingJump 永远挂着，
					// 界面既不落位也不报错 —— 比报错更糟（用户只会说「点了没反应」）。
					logFromRenderer("warn", "jump", "page-failed", { wanted, error: error instanceof Error ? error.message : String(error) });
					setPendingJump((previous) => (previous ? { ...previous, value: { ...previous.value, nonce: previous.value.nonce + 1 } } : previous));
					// 顺序要紧：先 bump 再复位。setState 触发的那次 effect 在本次回调之后才跑，
					// 那时在途标记必须已经是 false，否则状态机会再判一次 wait 并继续挂着。
					jumpPageInFlightRef.current = null;
				})
				.finally(() => {
					if (jumpPageInFlightRef.current === requestId) jumpPageInFlightRef.current = null;
				});
			return;
		}
		const action = toPendingAction(
			nextJumpTick({
				targetMounted: false,
				targetInData: stillInData,
				hasMorePages,
				// 揭示/在途：都是「还没到该判死的时候」，见 jumpMachine ③ 与 ③′。
				revealRequested: pendingJump.value.revealRequested ?? false,
				pageInFlight: jumpPageInFlightRef.current === pendingJump.value.requestId,
				isLoadingPage: isLoadingMessagePage,
				waitFrames: pendingJump.value.waitFrames,
				loadAttempts: pendingJump.value.loadAttempts,
				expandAttempts: pendingJump.value.expandAttempts,
				stalledAttempts: pendingJump.value.stalledAttempts,
				elapsedMs: performance.now() - pendingJump.value.startedAt,
			}),
			TURN_WINDOW_EXPAND_BATCH_TURNS,
		);
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
			// 诊断必须报**本次跳转**的结果。以前这里报 readLastPrependResult()，那是 loadMoreMessages
			// 的残留值：跳转根本不走那条路，屏幕上却显示 [committed] —— 看着像补页成功，其实与本次无关。
			const jumpOutcome = readLastJumpOutcome();
			const jumpDiag = ` [data=${combinedMessages.length} target=${stillInData ? 1 : 0} page=${jumpOutcome}]`;
			logFromRenderer("warn", "jump", "give-up", {
				reason: action.reason,
				target: pendingJump.value.messageId,
				targetNodeId,
				messages: combinedMessages.length,
				stillInData,
				hasMorePages,
				pageOutcome: jumpOutcome,
				loadAttempts: pendingJump.value.loadAttempts,
				expandAttempts: pendingJump.value.expandAttempts,
				stalledAttempts: pendingJump.value.stalledAttempts,
			});
			showNotice(t(`sessionFind.jumpFailed.${action.reason}`) + jumpDiag);
			return;
		}
		if (action.kind === "wait") return;
		if (action.kind === "reveal") {
			// 目标在数据里却没挂载：多半在已完成轮的执行过程折叠区里（Radix 收起是整块卸载）。
			// 请渲染层把那一轮展开，再等挂载——扩窗只多挂轮次，永远挂不出折叠区里的节点，
			// 旧顺序（wait→8 次扩窗→H1）就是这样把「搜到了却跳不过去」变成常态的（2026-11-25）。
			logFromRenderer("info", "jump", "reveal", { target: pendingJump.value.messageId, targetNodeId });
			requestTimelineReveal(targetNodeId);
			setPendingJump({
				ownerKey: pendingJump.ownerKey,
				value: { ...pendingJump.value, revealRequested: true, waitFrames: 0, nonce: pendingJump.value.nonce + 1 },
			});
			return;
		}
		setPendingJump({
			ownerKey: pendingJump.ownerKey,
			value: {
				...pendingJump.value,
				expandAttempts: action.kind === "expand" ? pendingJump.value.expandAttempts + 1 : pendingJump.value.expandAttempts,
				expandedTurns: action.kind === "expand" ? pendingJump.value.expandedTurns + action.turns : pendingJump.value.expandedTurns,
				startedAt: pendingJump.value.startedAt,
				observedCount: combinedMessages.length,
				stalledAttempts: nextStalledAttempts(pendingJump.value.stalledAttempts, combinedMessages.length > pendingJump.value.observedCount),
				waitFrames: 0,
				loadAttempts: action.kind === "load-page" ? pendingJump.value.loadAttempts + 1 : pendingJump.value.loadAttempts,
				requestId: pendingJump.value.requestId,
				nonce: pendingJump.value.nonce + 1,
			},
		});
		// 落到 load-page 只可能是「已经取过一次页、目标仍不在数据里」：不能再取第二次。
		// 旧实现在这里弹 target-not-mountable（H1「这条在已加载内容里」），而本分支的前置恰是
		// stillInData=false —— 文案与判据相反，而且这里一条日志都不留（2026-11-25：通知历史
		// 里 19 条 H1，分不出哪条来自这条无日志的路）。现在如实报原因，并先试兜底落点。
		if (action.kind === "load-page") {
			skipBrowsePinRef.current = false;
			setPendingJump(undefined);
			clearTimelineReveal();
			const staleRow = findFallbackJumpRow(pendingJump.value.messageId);
			// 原因由**可观测的判据**决定，不硬编码：还有更早的页却报「已到文件头」，
			// 文案就与同一行日志里的 hasMorePages=true 相反（2026-11-26 真机，entryId cd9540b6，
			// 同一形状 4 次；用户拿到的提示是「没有更早的历史页可补」）。
			const staleReason = resolveStaleTargetReason({ hasMorePages });
			logFromRenderer("warn", "jump", "give-up", {
				reason: staleReason,
				route: "load-page-after-fetch",
				target: pendingJump.value.messageId,
				targetNodeId,
				// 目标 id 的形状：认不出时先看它有没有投影标记、有多长。
				// 有 -history- 就能剥前缀归一；没有就是运行时 UUID（两通道 id 永不相同）。
				targetShape: {
					hasHistoryMarker: pendingJump.value.messageId.includes("-history-"),
					length: pendingJump.value.messageId.length,
				},
				messages: combinedMessages.length,
				hasMorePages,
				pageRequested: pendingJump.value.pageRequested,
				pageOutcome: readLastJumpOutcome(),
			});
			if (staleRow) {
				scrollJumpTargetIntoView(timeline, staleRow);
				settleJumpTarget(timeline, staleRow.dataset.messageId ?? pendingJump.value.messageId);
				highlightMessage(staleRow, ownerKey);
				return;
			}
			showNotice(t(`sessionFind.jumpFailed.${staleReason}`) + ` [data=${combinedMessages.length} target=0 page=${readLastJumpOutcome()}]`);
			return;
		}
		expandWindow(action.turns);
	}, [clearTimelineReveal, combinedMessages, controllerEnabled, expandWindow, findFallbackJumpRow, hasEarlierPages, highlightMessage, isLoadingMessagePage, isSurfaceLoading, loadMoreError, loadMoreMessages, ownerKey, pendingJump, requestTimelineReveal, scrollJumpTargetIntoView, scrolledWindowTurns, settleJumpTarget]);

	return { jumpWindowRuns, growJumpWindowRuns };
}
