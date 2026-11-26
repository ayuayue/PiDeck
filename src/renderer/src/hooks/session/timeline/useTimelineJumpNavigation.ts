import { type Dispatch, type RefObject, type SetStateAction, useCallback, useEffect, useRef } from "react";
import type { ChatMessage } from "../../../../../shared/types";
import type { MessageScrollerScrollApi } from "../../../components/agents/message-scroller";
import { estimateJumpExpandTurns, resolveJumpFallbackEntry } from "../../../components/session/timeline/jumpWindowPolicy";
import { isSettleRowReady, JUMP_SETTLE_EMPTY_GRACE_FRAMES, planJumpSettleStep, shouldAwaitFollowingRow } from "../../../components/session/timeline/jumpSettle";
import { resolveJumpMessageIndex, resolveJumpScrollTarget } from "../../../components/session/timeline/jumpTarget";
import { revealInNestedScrollers } from "../../../components/session/timeline/nestedScrollerReveal";
import type { BrowsePin } from "../../timeline/browsePin";
import { shouldDeferJumpUntilLoaded } from "../../timeline/timelineRevealChannel";

import { logFromRenderer } from "../../../utils/rendererLog";
/** 挂起跳转的请求：expandAttempts / loadAttempts 是两套防呆预算，nonce 保证重复点击也重跑 effect。 */
/**
 * 跳转入口的结果。**不用 boolean**：调用方要知道的是「为什么没开始」，
 * 而不是「有没有成功」——「正在落位」和「被挡掉」都不是成功，但处理方式完全不同。
 */
export type JumpStartResult =
	/** 已接受：落位或挂起由 pendingJump effect 继续 */
	| "started"
	/** 时间线还没挂（会话切换首帧） */
	| "skipped-no-timeline"
	/** 请求来自另一个会话（ownerKey 不匹配），丢弃 */
	| "skipped-owner"
	/** 目标既不在数据里也没有更早的页：已挂起，由 effect 报 H2/H3/H4 */
	| "pending-unresolved";
export type TimelineJumpRequest = {
	messageId: string;
	/** 点击代数与重试nonce分开：重试不会让旧点击变成新点击。 */
	requestId: number;
	expandAttempts: number;
	loadAttempts: number;
	/** 已经扩出去的轮数。与 estimateJumpExpandTurns 的估算配对：够了就停，不够就继续，
	 *  不设固定次数上限（1000 轮会话时指数试探 8 次只能给 141 轮，必然放弃）。 */
	expandedTurns: number;
	nonce: number;
	/** 点击时刻（performance.now()）。状态机据此判硬超时——没有它就无法区分「正在等」和「卡死」。 */
	startedAt: number;
	/** 目标在数据里但还没挂载，已经等了多少帧。两帧还不出现就交给扩窗兜底。 */
	waitFrames: number;
	/** 上一轮补页后观测到的 combinedMessages 长度（进度基准）。 */
	observedCount: number;
	/** 连续「请求发出但数据没长」的次数（进度度量，见 jumpMachine）。 */
	stalledAttempts: number;
	/** 本次跳转是否已经发过「定位取页」请求。跳转只取一次页，不随滚动补页重试。 */
	pageRequested?: boolean;
	/** 是否已经请求渲染层揭示（展开目标所在轮的执行过程折叠栏）。入口 index≥0 时已请求。 */
	revealRequested?: boolean;
};
export type TaggedTimelineJumpRequest = { ownerKey: string; value: TimelineJumpRequest };

export interface TimelineJumpNavigationOptions {
	ownerKey: string;
	ownerKeyRef: RefObject<string>;
	timelineRef: RefObject<HTMLElement | null>;
	combinedMessages: ChatMessage[];
	scrollerScrollApiRef: RefObject<MessageScrollerScrollApi | null>;
	browsePinRef: RefObject<BrowsePin | null>;
	browsePinFrozenRef: RefObject<boolean>;
	skipBrowsePinRef: RefObject<boolean>;
	/** 用户在跳转收敛期间真动手了（引擎上报的真实输入），循环下一帧就收手。主 hook 的
	 *  滚动意图入口也会置它（用户真动手就该放弃纠偏），所以 ref 由主 hook 持有。 */
	jumpSettleInterruptedRef: RefObject<boolean>;
	jumpNonceRef: RefObject<number>;
	hasEarlierPages: boolean;
	isSurfaceLoading: boolean;
	escapeAutoScroll: () => void;
	markProgrammaticScroll: (durationMs?: number) => void;
	highlightMessage: (element: HTMLElement, expectedOwnerKey: string) => void;
	requestTimelineReveal: (messageId: string) => void;
	clearTimelineReveal: () => void;
	expandWindowBatched: (turns?: number, growJumpWindow?: boolean) => void;
	setShowScrollToBottom: (show: boolean) => void;
	setPendingJump: Dispatch<SetStateAction<TaggedTimelineJumpRequest | undefined>>;
	/** 把「当前跳转锚点」同步给渲染层。ref 不够：useMemo 的依赖不含 ref，写 pin 不会触发重算，
	 *  窗口就永远停在旧切片上 —— 这就是「点远处刻度没反应」的真正原因。state 才会重算。 */
	setJumpAnchorMessageId: (id: string | null) => void;
}

export interface TimelineJumpNavigation {
	/**
	 * 跳转入口。返回**为什么没开始**，而不是 void：
	 * 六个调用方（刻度 / 查找面板 / 插件导航 / 待定 reveal）现在都能区分
	 * 「已经在落位」与「被 ownerKey 挡掉」「时间线还没挂」，不必靠界面猜。
	 */
	jumpToMessage: (messageId: string) => JumpStartResult;
	/** 落位到目标行（定位 + 交给收敛循环），pendingJump effect 与刻度点击共用。 */
	scrollJumpTargetIntoView: (timeline: HTMLElement, element: HTMLElement) => void;
	settleJumpTarget: (timeline: HTMLElement, messageId: string) => void;
	/** 目标节点挂不出来时的兜底落点（落到包含它的那一轮）。 */
	findFallbackJumpRow: (messageId: string) => HTMLElement | null;
}

/**
 * 刻度跳转的落位与收敛（2026-12 从 useSessionTimelineController 提出）。
 *
 * 三件事：把目标滚到视口顶（restoreAt，不用 scrollIntoView）、落位后逐帧按实测漂移
 * 纠偏直到收敛、以及目标挂不出来时退到包含它的轮次行。策略判据仍是纯函数
 * （jumpTarget / jumpSettle / jumpWindowPolicy），这里只做 DOM 编排；行为与搬迁前逐行一致。
 */
export function useTimelineJumpNavigation(options: TimelineJumpNavigationOptions): TimelineJumpNavigation {
	const {
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
		setJumpAnchorMessageId,
	} = options;

	/**
	 * 跳转落位：计算目标相对时间线的偏移并原子定位（restoreAt = 定位 + 解锁锁底
	 * + 取消在途动画）。不用 scrollIntoView：它会级联滚动所有祖先容器，且 smooth
	 * 动画会与贴底引擎/扩窗布局竞争——跟随态下点刻度「看似没反应、再点一次才生效」
	 * 的直接根因就是贴底引擎把 smooth 滚动拽了回去。
	 *
	 * 但「不走 scrollIntoView」不等于「可以忽略嵌套窗口」：过程组组体是限高视口，目标行
	 * 即使布局正常也可能被组体裁掉（实测可见高度 0px）。所以先由内向外把目标露出来，
	 * 再算会话偏移——否则就是「跳到一条空白」。内层必须走它自己注册的 restoreAt（见
	 * nestedScrollerReveal 的头注释），不能裸写 scrollTop。
	 */
	const scrollJumpTargetIntoView = useCallback(
		(timeline: HTMLElement, element: HTMLElement) => {
			revealInNestedScrollers(element, timeline);
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
			let expandAttempts = 0;
			/** 行已挂载但内容为空的连续帧数（见 row-empty 判据）。 */
			let emptyFrames = 0;
			/** 目标行之后还没挂出下文时的等待帧数（见 shouldAwaitFollowingRow）。 */
			let followingWaitFrames = 0;
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
				// 每帧先重露内层：收敛期间组体里的内容可能长高，把目标重新顶出可视窗；
				// 只改外层 scrollTop 修不了「被组体裁掉」，那会停在一个漂移为 0 的空白上。
				if (row) revealInNestedScrollers(row, timeline);
				// height <= 0 = 没被布局（折叠区里 display:none、或正在卸载）：它的 rect 全是 0，
				// 拿去算漂移会得出一个巨大的负数，把视口滚到莫名其妙的位置。当作量不到处理。
				const rowRect = row?.getBoundingClientRect() ?? null;
				// 行挂上了但**内容还没长出来**（扩窗刚把这一轮挂进来，VirtualRunList 先写高度、
				// 后填内容）。此时几何是对的、视觉是空白 —— 真机 13:53 两次 settled 却什么都看不到。
				// 给它独立宽限：等内容，别把它当「已到」收手，也别立刻判 target-missing。
				const rowTextLength = row?.innerText?.trim().length ?? 0;
				if (row && !isSettleRowReady(rowRect, rowTextLength) && emptyFrames < JUMP_SETTLE_EMPTY_GRACE_FRAMES) {
					emptyFrames += 1;
					frames += 1;
					if (emptyFrames === 1) {
						logFromRenderer("info", "jump", "row-empty", { messageId, frames, rectHeight: rowRect ? Math.round(rowRect.height) : null });
					}
					revealInNestedScrollers(row, timeline);
					frame = requestAnimationFrame(step);
					return;
				}
				const driftPx = rowRect && rowRect.height > 0 && rowTextLength > 0 ? rowRect.top - timeline.getBoundingClientRect().top : null;
				// 可滚上限：目标在它之外时，写 scrollTop 会被浏览器钳位，漂移永久剩余。
				const maxScroll = timeline.scrollHeight - timeline.clientHeight;
				const decision = planJumpSettleStep({
					driftPx,
					frames,
					elapsedMs: performance.now() - startedAt,
					interrupted: jumpSettleInterruptedRef.current,
					// 余量 = maxScroll - 目标的文档坐标（= scrollTop + drift）。
					// 目标在下方远处时该值为负 → expand（滚到底也够不到）：日志里
					// 「目标绝对 16303 / maxScroll 15826 / drift 恒 400」就是这一类。
					canScrollPx: driftPx === null ? maxScroll : maxScroll - Math.max(0, timeline.scrollTop + driftPx),
					expandAttempts,
					// 滚到底也够不到视口顶时（末条目标），判「看没看见」而不是「差几像素」。
					viewportHeightPx: timeline.clientHeight,
				});
				// 布局宽限：目标行还没量到，等一帧再看（frames 照样自增，宽限有限）。
				if (decision.kind === "wait") {
					frames += 1;
					frame = requestAnimationFrame(step);
					return;
				}
				if (decision.kind === "expand") {
					expandAttempts += 1;
					frames += 1;
					logFromRenderer("info", "jump", "settle-expand", {
						messageId,
						frames,
						expandAttempts,
						scrollHeight: Math.round(timeline.scrollHeight),
						clientHeight: Math.round(timeline.clientHeight),
					});
					// 节流长半径：每两次尝试长一次。
					// 全不涨（上一版传 false）会让「目标在锚点窗口之外」永远挂不出来 —— 日志实证
					// 2026-11-25：8 次 expand 之后 scrollHeight 恒 10393（一轮都没加进去）→
					// give-up no-scroll-room、drift 恒 501px。每帧都涨则是放大环（6→40，一帧 81 轮）。
					// 奇数次长 = 既不放大、又真的能把窗口推到目标处。
					expandWindowBatched(2, expandAttempts % 2 === 1);
					frame = requestAnimationFrame(step);
					return;
				}
				// 收敛结论：settled = 目标行到了视口顶；give-up 带原因。
				// 目标行在、但之后没有下文（虚拟范围只覆盖到它）：继续等一帧并扩窗，
				// 而不是立刻 settled —— 真机表现是「跳过去一片空白」（2026-11-26 14:40）。
				if (decision.kind === "settled" && row) {
					const hasFollowingRow = Boolean(row.nextElementSibling) || Boolean(row.parentElement?.nextElementSibling);
					if (shouldAwaitFollowingRow({ hasFollowingRow, followingWaitFrames })) {
						if (followingWaitFrames === 0) {
							logFromRenderer("info", "jump", "row-blank-after", { messageId, frames });
						}
						followingWaitFrames += 1;
						frames += 1;
						expandWindowBatched(2, followingWaitFrames % 2 === 1);
						frame = requestAnimationFrame(step);
						return;
					}
				}
				if (decision.kind !== "scroll" && frames > 0) {
					logFromRenderer(decision.kind === "settled" ? "info" : "warn", "jump", "settle-end", {
						messageId,
						kind: decision.kind,
						reason: "reason" in decision ? decision.reason : undefined,
						frames,
						driftPx: driftPx === null ? null : Math.round(driftPx),
					});
				}
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
				const scrollBefore = timeline.scrollTop;
				// 目标可能一次在几千像素之外（日志实测：目标行在视口下方 15247px，
				// 每帧只补 400px，24 帧共 9600px —— 追不上，漂移恒 400 到 give-up）。
				// 所以按绝对值落位，不做增量累加；再按实测漂移补一次即可收敛。
				const next = Math.max(0, scrollBefore + decision.delta);
				if (apiAfter?.restoreAt) apiAfter.restoreAt(next);
				// 直写兜底：引擎 restoreAt 维护自己的基准位置，目标超出它记的基准范围时
				// 写入会被还原成基准（表现为「写了 24 次、scrollTop 一次都没变」）。
				timeline.scrollTop = next;
				const scrollAfter = timeline.scrollTop;
				if (frames <= 3) {
					logFromRenderer("info", "jump", "settle-step", {
						messageId,
						frames,
						driftPx: driftPx === null ? null : Math.round(driftPx),
						delta: Math.round(decision.delta),
						scrollBefore: Math.round(scrollBefore),
						requested: Math.round(next),
						scrollAfter: Math.round(scrollAfter),
						maxScroll: Math.round(timeline.scrollHeight - timeline.clientHeight),
					});
				}
				frame = requestAnimationFrame(step);
			};
			jumpSettleCancelRef.current = stop;
			frame = requestAnimationFrame(step);
		},
		[cancelJumpSettle, markProgrammaticScroll, expandWindowBatched],
	);
	// 切会话/卸载时别让上一段收敛循环继续改写新会话的滚动位置。
	useEffect(() => cancelJumpSettle, [ownerKey, cancelJumpSettle]);

	const jumpToMessage = useCallback(
		(messageId: string): JumpStartResult => {
			const requestOwnerKey = ownerKey;
			const timeline = timelineRef.current;
			if (!timeline) return "skipped-no-timeline";
			if (ownerKeyRef.current !== requestOwnerKey) return "skipped-owner";
			// 已挂载目标也开启新事务，取消旧取页、等待帧与落位动画。
			jumpNonceRef.current += 1;
			cancelJumpSettle();
			setPendingJump(undefined);
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
			// 入口诊断：搜索面板交来的 id 在已加载数据里找不找得到，决定后面走哪条路
			// （找不到 → 挂起 → 按 entryId 取页）。这条日志是「点了没反应」的第一现场。
			logFromRenderer("info", "jump", "entry", {
				requested: messageId,
				foundIndex: index,
				nodeId: targetNodeId,
				messages: combinedMessages.length,
			});
			// 立刻把浏览钉钉到目标：锚点窗口（selectTimelineTurnWindow 的 anchorRunIndex）读的就是
			// 这个钉，所以下一帧窗口就以目标为中心，不需要从尾部扩 350 轮。
			// 目标还不在已加载数据里时这里也安全 —— findAgentRunIndexByItemId 返回 -1，窗口不动。
			if (index >= 0) {
				browsePinRef.current = { messageId: targetNodeId, expectedViewportTop: 0 };
				browsePinFrozenRef.current = true;
				// 同时写 state：ref 不触发渲染，锚点窗口的 useMemo 依赖不到它，窗口就不会重算。
				setJumpAnchorMessageId(targetNodeId);
			} else {
				// 目标还没进数据：必须清掉上一次跳转留下的锚点。
				// 否则窗口仍锚在旧目标上，取页把新目标带进来之后窗口按旧锚选轮，
				// 目标轮挂不出来 —— 连续点不同刻度时表现为「第一次要等很久、第二次才到」。
				setJumpAnchorMessageId(null);
			}
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
				return "started";
			}
			// 命中可能在已完成轮的「执行过程」折叠区里：Radix 收起会把中间回答/工具整块卸载，
			// 扩窗（只多挂轮次）永远挂不出这些节点。先请求包含它的 TurnRow 展开折叠，
			// 再由下面的 pendingJump 重试循环完成落位。
			if (index >= 0) requestTimelineReveal(targetNodeId);
			const hasMorePages = hasEarlierPages;
			// 目标不在已加载数据里、也没有更早的页可补时，**不能静默 return**：
			// 用户点的是查找面板里很靠前的一条，界面上什么都不会发生（2026-11 真机原话：
			// 「点比较远的跳转，没反应了」）。旧实现在这里 return，连一句提示都没有，
			// 比弹「未能跳转」更糟——弹窗至少说明系统收到了这次点击。
			// 现在一律挂起，由 pendingJump effect 按 resolveJumpPendingAction 给出
			// H1/H2/H3 之一；冷会话（消息还没上屏）也因此自动恢复（#401 复审 P0 同一条路）。
			// 目标可能在贴底 turn 窗口外（先取消跟随以展开挂载），也可能在尚未加载的
			// 历史页里：挂起跳转，由 pendingJump effect 按策略补页/扩窗直到完成。
			setShowScrollToBottom(true);
			if (index >= 0) {
				// 一次到位：按目标轮次估算窗口需求并整批排入分帧扩窗（避免单帧全量渲染）。
				// 批次消费完前 pendingJump effect 挂起等待（见 effect 内 pendingExpandTurnsRef 守卫）。
				expandWindowBatched(estimateJumpExpandTurns(combinedMessages, index));
			}
			setPendingJump({
				ownerKey: requestOwnerKey,
				value: { messageId, requestId: jumpNonceRef.current, expandAttempts: 0, loadAttempts: 0, expandedTurns: 0, nonce: jumpNonceRef.current, startedAt: performance.now(), waitFrames: 0, observedCount: -1, stalledAttempts: 0, revealRequested: index >= 0 },
			});
			return index >= 0 ? "started" : "pending-unresolved";
		},
		[cancelJumpSettle, clearTimelineReveal, combinedMessages, escapeAutoScroll, expandWindowBatched, hasEarlierPages, highlightMessage, isSurfaceLoading, ownerKey, requestTimelineReveal, scrollJumpTargetIntoView, settleJumpTarget],
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

	return { jumpToMessage, scrollJumpTargetIntoView, settleJumpTarget, findFallbackJumpRow };
}
