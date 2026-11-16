import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import type { MessageScrollerScrollApi } from "../../../components/agents/message-scroller";
import { resolveMissingAnchorNextStep } from "../../../components/session/timeline/restoreAnchorPolicy";
import { TIMELINE_WINDOW_EXPAND_STEP } from "../../../components/session/timeline/turnRenderWindow";
import type { ChatMessage } from "../../../../../shared/types";
import type { SessionScrollAnchor } from "../../../atoms";
import { ROOT_ROW_SELECTOR, type VisibleTimelineRow } from "../../timeline/useVisibleTimelineRows";
import { followBrowsePinAfterUserScroll, pickVisibleRootRow, type BrowsePin } from "../../timeline/browsePin";
import { isProgrammaticScrollActive, type ProgrammaticScrollGuard } from "../../timeline/programmaticScrollGuard";
import type { SendScrollPositioner } from "../../timeline/sendScroll";

export interface TimelineScrollAnchorOptions {
	messages: ChatMessage[];
	ownerKey: string;
	legacyOwnerKey: string;
	controllerEnabled: boolean;
	effectiveWindowTurns: number;
	/** 主 hook 渲染期同步写入：锚点保存必须与 DOM 实际渲染的窗口一致。 */
	renderedWindowTurnsRef: RefObject<number>;
	timelineRef: RefObject<HTMLElement | null>;
	ownerKeyRef: RefObject<string>;
	autoScrollRef: RefObject<boolean>;
	setAutoScroll: (following: boolean) => void;
	setShowScrollToBottom: (show: boolean) => void;
	restoreAnchor: SessionScrollAnchor | undefined;
	setRestoreAnchor: (anchor: SessionScrollAnchor | undefined) => void;
	restorePhase: "pending" | "complete";
	setRestorePhase: (phase: "pending" | "complete") => void;
	scrolledWindowTurns: number;
	setScrolledWindowTurns: (updater: number | ((turns: number) => number)) => void;
	isSurfaceLoading: boolean;
	hasEarlierPages: boolean;
	isLoadingMessagePage: boolean;
	loadMoreMessages: (source?: "scroll" | "button" | "backfill") => void;
	markProgrammaticScroll: (durationMs?: number) => void;
	scrollerScrollApiRef: RefObject<MessageScrollerScrollApi | null>;
	browsePinRef: RefObject<BrowsePin | null>;
	browsePinFrozenRef: RefObject<boolean>;
	pinFallbackHeightRef: RefObject<number>;
	programmaticScrollGuardRef: RefObject<ProgrammaticScrollGuard>;
	sendScrollRef: RefObject<SendScrollPositioner>;
	settleScrollCancelRef: RefObject<(() => void) | undefined>;
	windowExpandableRef: RefObject<boolean>;
	/** 视口内行快照的读取器（主 hook 与浏览钉共用同一份）。 */
	readVisibleRowsRef: RefObject<() => VisibleTimelineRow[]>;
	measurePinnedRowTop: (timeline: HTMLElement, messageId: string) => number | null;
	/** 浏览钉行查找归主 hook（它也用同一份实现处理扩窗/翻页）。 */
	findBrowsePin: (timeline: HTMLElement | null, visibleRows?: readonly VisibleTimelineRow[]) => BrowsePin | null;
	isTimelineAtBottom: (scrollTop: number, scrollHeight: number, clientHeight: number) => boolean;
	timelineViewportTop: (timeline: HTMLElement) => number;
	/** 贴底判定与「跟流滞后」阈值：判定归主 hook 所有，子 hook 不复制字面量。 */
	bottomThreshold: number;
	followingAnchorSkipPx: number;
	saveScrollAnchor: (input: { sessionId: string; anchor: SessionScrollAnchor | null }) => void;
}

export interface TimelineScrollAnchorState {
	handleTimelineScroll: () => void;
	cancelSettledRepositionForNewRun: () => void;
	scrollFinalAnswerToUpperMiddle: (runId: string) => void;
}

/**
 * 滚动锚点：滚动时同步记录阅读位置（rAF 合并 + 节流落盘）、切会话恢复、切走时的兜底落盘。
 *
 * 只搬「记录/恢复阅读位置」这一域；贴底跟随、扩窗、跳转仍在主 hook。
 * 恢复失败的补救顺序（扩窗 → 补历史页 → 回实时尾部）由 restoreAnchorPolicy 决定。
 */
export function useTimelineScrollAnchor(options: TimelineScrollAnchorOptions): TimelineScrollAnchorState {
	const {
		messages,
		ownerKey,
		legacyOwnerKey,
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
		bottomThreshold,
		followingAnchorSkipPx,
		saveScrollAnchor,
	} = options;

	// 锚点 id 归一映射：pi 预热激活运行时会把磁盘页投影 id `_viewer-history-X` 改写为
	// `<agentId>-history-X`（meta.entryId 不变，跨 incarnation 也稳定）。锚点按裸 id
	// 保存/恢复会在改写后 miss，扩窗重试后降级跳顶、丢阅读位置。保存时附 entryId，
	// 恢复 miss 时按它反查当前 id。ref 直写与 ownerKeyRef 同模式，热路径读不加依赖。
	const anchorEntryIdMapsRef = useRef<{ byId: Map<string, string>; byEntryId: Map<string, string> }>({ byId: new Map(), byEntryId: new Map() });
	const anchorEntryIdMaps = useMemo(() => {
		const byId = new Map<string, string>();
		const byEntryId = new Map<string, string>();
		for (const message of messages) {
			const entryId = message.meta?.entryId;
			if (typeof entryId !== "string" || !entryId) continue;
			byId.set(message.id, entryId);
			// 同 entryId 短暂多 id（重投影过渡帧）时保留最后写入者：flush 顺序即最新投影。
			byEntryId.set(entryId, message.id);
		}
		return { byId, byEntryId };
	}, [messages]);
	anchorEntryIdMapsRef.current = anchorEntryIdMaps;

	// ── 会话切换滚动位置保持（状态即真相）──
	// 最后已知锚点缓存：供 cleanup 兜底落盘（250ms 节流窗口内切走不丢）。
	// 不能用 cleanup 读 DOM——会话切换复用同一组件实例（无 key），cleanup 执行时
	// timeline 的 children 可能已替换为新会话消息，读 DOM 会串数据。
	const currentAnchorRef = useRef<SessionScrollAnchor | null>(null);
	const scrollAnchorFrameRef = useRef<number | undefined>(undefined);
	const bottomRestoreVerificationRef = useRef<number | undefined>(undefined);
	const bottomRestoreRequestRef = useRef(0);
	/** 最近一次 scroll 事件的可见行快照：rAF 里的锚点重算复用它，不再读第二遍布局。 */
	const scrollVisibleRowsRef = useRef<readonly VisibleTimelineRow[]>([]);
	const scrollSaveTimerRef = useRef<number | undefined>(undefined);
	/** 本次恢复已发起的历史补页次数。按锚点对象区分：会话再切一次就是新恢复。 */
	const restoreAnchorPagingRef = useRef<{ anchor: SessionScrollAnchor | undefined; attempts: number }>({ anchor: undefined, attempts: 0 });
	/** 保存旧 owner 的窗口时不能读已经指向新会话的 render ref，故保留最后一次 layout 提交值。 */
	const ownerWindowTurnsRef = useRef(new Map<string, number>());

	/**
	 * 计算当前视口锚点（纯读取，不落盘）。
	 * 规则：在底部跟流 → null（切回继续跟底）；查看历史 → 记录
	 * 「视口顶部的第一条消息行 + 距视口顶偏移 + 分页窗口」。
	 * 优先选 user-turn / turn-row 根节点：工具卡、思考步骤等嵌套 data-message-id
	 * 会在执行过程自动收起时卸载；把它们作为锚点会使切回只能降级到顶部。
	 */
	/**
	 * @param visibleRowsArg 本次 scroll 事件已读好的可见行快照。undefined = 自己读一次；
	 *   同一事件里锚点与浏览钉共用一份，避免每帧两次 O(视口) 布局读取。
	 */
	const computeCurrentAnchor = useCallback(
		(visibleRowsArg?: readonly VisibleTimelineRow[]): SessionScrollAnchor | null => {
			const timeline = timelineRef.current;
			if (!timeline) return null;
			// 发送定位动画期间视口是被程序挪走的，不是阅读位置。
			if (sendScrollRef.current.isAnimating) return null;
			const distanceFromBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
			if (distanceFromBottom < bottomThreshold) return null;
			// 跟流中的动画滞后（几十 px）不是阅读位置；真实上滚阅读的距离远大于此。
			if (autoScrollRef.current && distanceFromBottom <= followingAnchorSkipPx) return null;
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
					entryId: anchorEntryIdMapsRef.current.byId.get(anchorRow.id),
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
						entryId: anchorEntryIdMapsRef.current.byId.get(messageId),
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
		},
		[autoScrollRef, bottomThreshold, followingAnchorSkipPx, readVisibleRowsRef, renderedWindowTurnsRef, sendScrollRef, timelineRef, timelineViewportTop],
	);

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
		if (!sessionId || sessionId === legacyOwnerKey) return;
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
	}, [autoScrollRef, browsePinFrozenRef, browsePinRef, computeCurrentAnchor, findBrowsePin, isTimelineAtBottom, legacyOwnerKey, measurePinnedRowTop, ownerKeyRef, persistCurrentAnchor, programmaticScrollGuardRef, readVisibleRowsRef, timelineRef]);

	/** 旧实现中新增 run 开始的「取消完结动画并立即跟随」逻辑已随服务完结定位一起删除。
	 *  保留同名为 no-op，防调用处崩溃；所有自动滚动只在发送那一刻。 */
	const cancelSettledRepositionForNewRun = useCallback(() => {
		settleScrollCancelRef.current?.();
		settleScrollCancelRef.current = undefined;
	}, [settleScrollCancelRef]);

	/**
	 * 最新轮结束 1.5s 且用户无操作、执行过程自动收起后，把该轮最终回答开头放到视口中上方。
	 * - 仅用户仍在跟随时执行；已上滚阅读历史不拽回；
	 * - 先解锁 stick-to-bottom 再滚动，避免引擎把视口钉回底部；
	 * - 用户 wheel/pointerdown/touch/keydown 会取消在途动画（不抢用户操作）；
	 * - 回底按钮仍走 MessageScroller 弹簧，这里只负责这次「安静收起」定位。
	 */
	const scrollFinalAnswerToUpperMiddle = useCallback(
		(_runId: string) => {
			// 旧实现的完结定位动画已被项目决策移除。保留同名 API 为 no-op，
			// 防既有调用处崩溃；所有自动滚动都只在「发送那一刻」触发。
			settleScrollCancelRef.current?.();
			settleScrollCancelRef.current = undefined;
		},
		[settleScrollCancelRef],
	);

	useEffect(
		() => () => {
			if (bottomRestoreVerificationRef.current !== undefined) cancelAnimationFrame(bottomRestoreVerificationRef.current);
		},
		[],
	);

	useLayoutEffect(() => {
		if (ownerKey === legacyOwnerKey) return;
		ownerWindowTurnsRef.current.set(ownerKey, effectiveWindowTurns);
	}, [effectiveWindowTurns, legacyOwnerKey, ownerKey]);

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
			if (sessionId && sessionId !== legacyOwnerKey) {
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
	}, [legacyOwnerKey, ownerKey, saveScrollAnchor]);

	useEffect(() => {
		if (!controllerEnabled || restorePhase !== "pending") return;
		const anchor = restoreAnchor;
		if (restoreAnchorPagingRef.current.anchor !== anchor) restoreAnchorPagingRef.current = { anchor, attempts: 0 };
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
			const restoreRequest = ++bottomRestoreRequestRef.current;
			if (bottomRestoreVerificationRef.current !== undefined) cancelAnimationFrame(bottomRestoreVerificationRef.current);
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
				// 先发起恢复再完成；提前 complete 会让 effect cleanup 取消本帧。
				setRestorePhase("complete");
				// 恢复被同帧内容变化/旧动画取消时，引擎可能已上报 following，DOM 却不在底部。
				// 下一帧按真实几何对账；失败则退出跟底并露出回底按钮，避免无声卡在历史位置。
				const verificationFrame = requestAnimationFrame(() => {
					if (bottomRestoreVerificationRef.current === verificationFrame) bottomRestoreVerificationRef.current = undefined;
					const current = timelineRef.current;
					if (restoreRequest !== bottomRestoreRequestRef.current || !current || ownerKeyRef.current !== requestOwnerKey || !autoScrollRef.current) return;
					if (!isTimelineAtBottom(current.scrollTop, current.scrollHeight, current.clientHeight)) {
						autoScrollRef.current = false;
						setAutoScroll(false);
						setShowScrollToBottom(true);
					}
				});
				bottomRestoreVerificationRef.current = verificationFrame;
			});
			return () => cancelAnimationFrame(frame);
		}

		const frame = requestAnimationFrame(() => {
			const timeline = timelineRef.current;
			if (!timeline || ownerKeyRef.current !== requestOwnerKey) return;
			// 锚点 id 可能已被重投影改写（预热激活/pi 重启换投影前缀，entryId 不变）：
			// 先按保存的裸 id 找，miss 时按 entryId 反查当前 id 再试。
			let anchorRowId = anchor.messageId;
			if (anchor.entryId && !timeline.querySelector(`[data-message-id="${CSS.escape(anchorRowId)}"]`)) {
				const remapped = anchorEntryIdMapsRef.current.byEntryId.get(anchor.entryId);
				if (remapped && timeline.querySelector(`[data-message-id="${CSS.escape(remapped)}"]`)) anchorRowId = remapped;
			}
			const el = timeline.querySelector(`[data-message-id="${CSS.escape(anchorRowId)}"]`) as HTMLElement | null;
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
				// entryId 反查命中时同步落新 id，避免下次恢复再走一遍反查。
				currentAnchorRef.current = anchorRowId === anchor.messageId ? anchor : { ...anchor, messageId: anchorRowId };
				// 恢复成功即接管浏览钉：锚点上方之后仍会长高（图片解码、Markdown 重排），
				// 而 .message-timeline 是 overflow-anchor:none。没有钉行时增高只会把视口推走，
				// 用户下次看到的就是「恢复位置差了几百像素」（#477 的漂移变体）。
				// 期望偏移按真实几何取：targetTop 被文首夹到 0 时 elTop - targetTop 才是实际值。
				browsePinRef.current = { messageId: anchorRowId, expectedViewportTop: elTop - targetTop };
				pinFallbackHeightRef.current = timeline.scrollHeight;
				setRestorePhase("complete");
				return;
			}

			// 数据仍在 atom 但被 turn 窗口裁掉时，先扩窗重试。不能立刻回底：
			// 这正是长历史会话切回后位置丢失的根因。窗口已覆盖当前数据后才降级。
			// 窗口已覆盖、锚点却仍不在已加载数据里（首屏只读 9 轮 / 缓存被淘汰 / 切走
			// 期间上游追加把锚点挤出尾部）时补历史页，补不到才放弃（#477）。
			const paging = restoreAnchorPagingRef.current;
			const nextStep = resolveMissingAnchorNextStep({
				windowExpandable: windowExpandableRef.current,
				hasEarlierPages,
				loadingEarlier: isLoadingMessagePage,
				loadAttempts: paging.attempts,
			});
			if (nextStep === "expand") {
				setScrolledWindowTurns((turns) => turns + TIMELINE_WINDOW_EXPAND_STEP);
				return;
			}
			if (nextStep === "load") {
				paging.attempts += 1;
				loadMoreMessages("backfill");
				return;
			}
			if (nextStep === "wait") return;

			// 锚点确实不可再物化（压缩/删除/补页到底）：交回无锚点恢复路径，
			// 滚到实时尾部并跟底。不再落顶部 —— 否则用户回来看到的是历史开头，
			// 正是 #477 的原始症状。restoreAnchor 是依赖，置空会重跑上面的无锚点分支。
			setRestoreAnchor(undefined);
		});
		return () => cancelAnimationFrame(frame);
	}, [
		autoScrollRef,
		browsePinRef,
		controllerEnabled,
		hasEarlierPages,
		isLoadingMessagePage,
		isSurfaceLoading,
		isTimelineAtBottom,
		loadMoreMessages,
		markProgrammaticScroll,
		ownerKey,
		ownerKeyRef,
		pinFallbackHeightRef,
		restoreAnchor,
		restorePhase,
		scrollerScrollApiRef,
		scrolledWindowTurns,
		setAutoScroll,
		setRestoreAnchor,
		setRestorePhase,
		setScrolledWindowTurns,
		setShowScrollToBottom,
		timelineRef,
		windowExpandableRef,
	]);

	return {
		handleTimelineScroll,
		cancelSettledRepositionForNewRun,
		scrollFinalAnswerToUpperMiddle,
	};
}
