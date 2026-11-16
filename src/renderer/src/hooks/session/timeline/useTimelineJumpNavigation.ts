import { type Dispatch, type RefObject, type SetStateAction, useCallback, useEffect, useRef } from "react";
import type { ChatMessage } from "../../../../../shared/types";
import type { MessageScrollerScrollApi } from "../../../components/agents/message-scroller";
import { estimateJumpExpandTurns, resolveJumpFallbackEntry } from "../../../components/session/timeline/jumpWindowPolicy";
import { planJumpSettleStep } from "../../../components/session/timeline/jumpSettle";
import { resolveJumpMessageIndex, resolveJumpScrollTarget } from "../../../components/session/timeline/jumpTarget";
import type { BrowsePin } from "../../timeline/browsePin";
import { shouldDeferJumpUntilLoaded } from "../../timeline/timelineRevealChannel";

/** 挂起跳转的请求：expandAttempts / loadAttempts 是两套防呆预算，nonce 保证重复点击也重跑 effect。 */
export type TimelineJumpRequest = { messageId: string; expandAttempts: number; loadAttempts: number; nonce: number };
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
	expandWindowBatched: (turns?: number) => void;
	setShowScrollToBottom: (show: boolean) => void;
	setPendingJump: Dispatch<SetStateAction<TaggedTimelineJumpRequest | undefined>>;
}

export interface TimelineJumpNavigation {
	jumpToMessage: (messageId: string) => void;
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
	} = options;

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

	return { jumpToMessage, scrollJumpTargetIntoView, settleJumpTarget, findFallbackJumpRow };
}
