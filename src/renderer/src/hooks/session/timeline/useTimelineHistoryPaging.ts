import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { readSessionFirstScreenPage } from "../../../components/session/sessionSubagentTranscript";
import { resolveEarlierHistoryCursor, resolveHistoryPageSize, resolvePageWindowGrowth } from "../../../components/session/timeline/historyPagePolicy";
import { TIMELINE_WINDOW_EXPAND_STEP } from "../../../components/session/timeline/turnRenderWindow";
import type { ChatMessage, SessionMessagePage } from "../../../../../shared/types";
import type { SessionLoadState, SessionMessageCacheEntry } from "../../../atoms";
import type { TranslationKey } from "../../../i18n";
import { sessionHistoryUnavailableState } from "../../../utils/sessionHistoryAvailability";
import { sessionDiskPageCursor } from "../../../utils/sessionDiskPageCursor";
import { planLoadMorePinSteps, shouldApplyDelayedHistoryResult } from "../../timeline/scrollHistoryPolicy";
/** 顶部插入锚点（数据翻页 / turn 窗口展开共用）：主 hook 的消费 effect 读它补位移。 */
export type TimelinePrependAnchor = {
	height: number;
	top: number;
	/** 发起请求时的历史浏览代数：回底/切会话后到达的响应不得恢复旧锚点。 */
	generation: number;
	/** 保持旧视口：即使原视口在顶部也只让新历史出现在上方。 */
	preserveAtTop?: boolean;
	/** 这次请求是否打开过整表渲染：只有打开过的才允许在消费点调用 end。 */
	solidOpened?: boolean;
};
export type TaggedTimelinePrependAnchor = { ownerKey: string; value: TimelinePrependAnchor };

/**
 * 历史窗口加载与分页所需的域外能力。
 *
 * 侧效与 IPC 一律从主 hook 注入，子 hook 不直接抓 atom / desktopApi：`useSessionTimelineController`
 * 是「滚动所有权 + 分页 + 跳转」的单一装配点，注入让依赖面在签名上可见，也让模块本身保持无状态可测。
 */
export interface TimelineHistoryPagingPorts {
	readRecordMessagePage: (sessionId: string, before?: number, pageSize?: number, options?: { beforeEntryId?: string }) => Promise<SessionMessagePage>;
	startDshHost: () => Promise<boolean>;
	setLoadState: (input: { sessionId: string; state: SessionLoadState }) => void;
	cacheMessages: (input: { sessionId: string; messages: ChatMessage[]; source: "disk"; expectedRevision: number; page: SessionMessageCacheEntry["page"]; force?: boolean }) => void;
	prependMessagePage: (input: { sessionId: string; before: number; expectedRevision: number; page: SessionMessagePage }) => boolean;
	prependHistoryPage: (input: { sessionId: string; expectedRevision: number; before?: number | null; page: SessionMessagePage }) => boolean;
	clearHistory: (sessionId: string) => boolean;
	translate: (key: TranslationKey) => string;
}

export interface TimelineHistoryPagingOptions {
	sessionId: string | undefined;
	controllerEnabled: boolean;
	messages: ChatMessage[];
	combinedMessages: ChatMessage[];
	runtimeHistory: SessionMessageCacheEntry["history"];
	cachedEntry: SessionMessageCacheEntry | undefined;
	parentSessionPath: string | undefined;
	timelineRef: RefObject<HTMLElement | null>;
	ownerKey: string;
	ownerKeyRef: RefObject<string>;
	autoScroll: boolean;
	autoScrollRef: RefObject<boolean>;
	historyBrowseGenerationRef: RefObject<number>;
	loadMoreAnchorRef: RefObject<TaggedTimelinePrependAnchor | undefined>;
	windowExpandableRef: RefObject<boolean>;
	escapeAutoScroll: () => void;
	captureBrowsePin: (freeze: boolean) => void;
	expandWindowBatched: (turns?: number) => void;
	beginPrependSolid: () => void;
	endPrependSolid: () => void;
	allocateLoadSequence: () => number;
	trackLatestLoad: (sessionId: string, sequence: number) => void;
	getLatestLoad: (sessionId: string) => number | undefined;
	/** 视口是否贴底；由主 hook 传入，避免子 hook 复制滚动判定。 */
	isTimelineAtBottom: (scrollTop: number, scrollHeight: number, clientHeight: number) => boolean;
	ports: TimelineHistoryPagingPorts;
}

export interface TimelineHistoryPagingState {
	diskPage: SessionMessageCacheEntry["page"] | undefined;
	earlierHistoryCursor: ReturnType<typeof resolveEarlierHistoryCursor>;
	historyHasMore: boolean;
	hasEarlierPages: boolean;
	visibleMessages: ChatMessage[];
	isLoadingMessagePage: boolean;
	setIsLoadingMessagePage: (loading: boolean) => void;
	loadMoreError: string | null;
	setLoadMoreError: (error: string | null) => void;
	loadMoreMessages: (source?: "scroll" | "button" | "backfill") => void;
	reloadFromDisk: () => Promise<void>;
	startDshHostAndReload: () => Promise<boolean>;
}

/**
 * 历史窗口加载与分页：首屏之后的「加载更多对话」、DSH host 恢复、以及贴底稳定后释放历史前缀。
 *
 * 只搬状态与请求编排；游标/窗口增长/贴底判定等策略仍是纯函数模块，行为与搬迁前逐行一致。
 */
export function useTimelineHistoryPaging(options: TimelineHistoryPagingOptions): TimelineHistoryPagingState {
	const {
		sessionId,
		controllerEnabled,
		messages,
		combinedMessages,
		runtimeHistory,
		cachedEntry,
		parentSessionPath,
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
		ports,
	} = options;
	const { readRecordMessagePage, startDshHost, setLoadState, cacheMessages, prependMessagePage, prependHistoryPage, clearHistory, translate: t } = ports;

	const reloadFromDisk = useCallback(async () => {
		if (!sessionId) return;
		const sequence = allocateLoadSequence();
		trackLatestLoad(sessionId, sequence);
		setLoadState({ sessionId, state: { status: "loading" } });
		try {
			const page = await readSessionFirstScreenPage((id, before, pageSize) => readRecordMessagePage(id, before, pageSize), sessionId, parentSessionPath);
			if (getLatestLoad(sessionId) !== sequence) return;
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
			if (getLatestLoad(sessionId) !== sequence) return;
			setLoadState({
				sessionId,
				state: {
					status: "error",
					error: error instanceof Error ? error.message : String(error),
				},
			});
			throw error;
		}
	}, [allocateLoadSequence, cacheMessages, getLatestLoad, parentSessionPath, readRecordMessagePage, sessionId, setLoadState, trackLatestLoad]);

	/**
	 * DSH host 被手动停止时的恢复入口（时间线专态的「启动 host 并重试」）。
	 *
	 * 为什么不能只重试读盘：手动停止态不会自愈——预热 / 按需兜底 / 崩溃重启 /
	 * runtime 安装恢复全被 isManualStopped 门控拒掉（见 dshManualStop），只有用户
	 * 显式 startDshHost（主进程清标记后 boot）才能恢复。所以先启动、再重载。
	 */
	const startDshHostAndReload = useCallback(async () => {
		// 启动失败不抛：保持专态等用户再点（真正原因会由后续读盘的错误态/日志暴露）。
		const started = await startDshHost().catch(() => false);
		if (!started) return false;
		// reloadFromDisk 失败会自行写 error 态并 rethrow，这里不重复上报。
		await reloadFromDisk().catch(() => undefined);
		return true;
	}, [reloadFromDisk, startDshHost]);

	const diskPage = controllerEnabled && cachedEntry?.source === "disk" ? cachedEntry.page : undefined;
	// 窗口前还有历史可加载：判断与「这次点击真能推进一页」必须同源，否则按钮变成死按钮
	// （2026-12 真机：已经是第一条消息了按钮还在，点了无任何变化）。旧写法两份实现：
	// 可见性看 `nextBefore !== null` / `windowStart > 0`，请求侧拿不到锚点就静默 return。
	// 现在统一走 resolveEarlierHistoryCursor：拿不到游标 = 没更早历史 = 不显示按钮。
	// 两个曾经的坑写在那个函数里（缓存页把文件头回成 nextBefore: 0、无文件会话只剩 windowStart>0）。
	const earlierHistoryCursor = useMemo(
		() =>
			controllerEnabled
				? resolveEarlierHistoryCursor({
						runtimeHistory,
						windowMessages: messages,
						windowStartFilePos: cachedEntry?.windowStartFilePos,
						// ACP 没有会话文件、消息也不带 entryId：窗口起点就是分页游标
						windowStart: cachedEntry?.windowStart,
					})
				: null,
		[controllerEnabled, runtimeHistory, messages, cachedEntry?.windowStartFilePos, cachedEntry?.windowStart],
	);
	const historyHasMore = controllerEnabled && cachedEntry?.source === "runtime" ? earlierHistoryCursor !== null : false;
	// disk 页与窗口页的统一口径：游标必须是 >0 的实下标（0 = 文件头，不是「还有」。）
	const hasEarlierPages = diskPage ? typeof diskPage.nextBefore === "number" && diskPage.nextBefore > 0 : historyHasMore;
	// 2026-11 轮次模型：不再按 100 条分页器切片，显示数组 = 已加载全部（历史前缀 + 运行时窗口段）。
	// 内存预算由主进程 12 轮缓存 + 回底临时历史清理承担，渲染层不再有第二道条数窗口。
	const visibleMessages = combinedMessages;
	const [isLoadingMessagePage, setIsLoadingMessagePage] = useState(false);
	/**
	 * 「加载更多对话」失败态：IPC 抛错（DSH host 不可用 / 会话文件失效）原先没人接，
	 * finally 只复位 loading，表现为「点了没反应」。这里留原始文案给时间线出错误行。
	 */
	const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

	const loadMoreMessages = useCallback(
		(source: "scroll" | "button" | "backfill" = "scroll") => {
			const pageSize = resolveHistoryPageSize(source);
			const requestOwnerKey = ownerKey;
			const timeline = timelineRef.current;
			// 前置动作的顺序是承重结构，写在 planLoadMorePinSteps 里并由单测钉住：
			// captureBrowsePin 在 autoScrollRef 为真时直接 return（贴底态一直是真），所以必须
			// 先脱离跟随再抓钉行，否则贴底点按钮一个钉行都抓不到。
			for (const step of planLoadMorePinSteps(source)) {
				if (step === "escapeFollow") escapeAutoScroll();
				else captureBrowsePin(true);
			}
			// 同上：翻页会在顶部插入，期间必须能按行测到 pin（整表渲染）。
			if (timeline && ownerKeyRef.current === requestOwnerKey) {
				loadMoreAnchorRef.current = {
					ownerKey: requestOwnerKey,
					value: {
						height: timeline.scrollHeight,
						top: timeline.scrollTop,
						generation: historyBrowseGenerationRef.current,
						...(source === "scroll" ? { preserveAtTop: true } : {}),
						solidOpened: source === "scroll",
					},
				};
			}
			if (diskPage) {
				const before = diskPage.nextBefore;
				// 0 是文件头而不是「还有更早」：放过会发出一次空页请求，界面毫无变化。
				if (!sessionId || typeof before !== "number" || before <= 0 || isLoadingMessagePage) return;
				const browseGeneration = historyBrowseGenerationRef.current;
				const sequence = allocateLoadSequence();
				trackLatestLoad(sessionId, sequence);
				const expectedRevision = cachedEntry?.revision ?? 0;
				// 只有 scroll（滚到顶部自动翻页）需要整表渲染：它要在 useLayoutEffect 里按 messageId
				// 查 DOM 行做 pin 补偿（pinBrowseRow -> measurePinnedRowTop），虚拟区外的行不在
				// DOM 里就量不到。button / backfill 走 resolveTimelineTopCompensation：补偿量 =
				// scrollHeight 差值（虚拟区占位高度是渲染期同步算出的，两次读数即得），不查任何
				// DOM —— 所以不必关闭虚拟化。用户点「加载更多」时把 100+ 轮全部真实挂载，正是
				// 「点了就卡」的主因。
				const needsSolid = source === "scroll";
				if (needsSolid) beginPrependSolid();
				let insertionCommitted = false;
				setIsLoadingMessagePage(true);
				// 重试时先清掉上一次的错误行
				setLoadMoreError(null);
				void readRecordMessagePage(sessionId, before, pageSize)
					.then((page: SessionMessagePage) => {
						if (getLatestLoad(sessionId) !== sequence) return;
						// 翻页期间 host 被停：保留已加载内容，出可辨识的失败行（静默丢弃这一页
						// 会让「加载更多」看起来没反应），下次点击仍可重试。
						if (sessionHistoryUnavailableState(page)) {
							setLoadMoreError(t("timeline.dshHostStopped"));
							return;
						}
						if (prependMessagePage({ sessionId, before, expectedRevision, page })) {
							insertionCommitted = true;
							// 历史消息页最多只开放一个 3 轮 cohort；数据页可能按消息数返回很多轮，
							// 不能再固定 +10 把 DOM 一次性解锁，剩余已加载数据交给本地扩窗。
							// 回底/切会话后到达（跟随或代数过期）只写缓存，不得扩窗——否则
							// 迟到分页会把刚回底的视口重新拉进历史模式。
							if (
								shouldApplyDelayedHistoryResult({
									following: autoScrollRef.current,
									generationAtRequest: browseGeneration,
									currentGeneration: historyBrowseGenerationRef.current,
									explicit: source === "button" || source === "backfill",
								})
							) {
								const growth = resolvePageWindowGrowth(page.messages, pageSize);
								if (growth > 0) expandWindowBatched(growth);
								else if (page.messages.length === 0 && windowExpandableRef.current) {
									// 空页 = 已经到文件头，游标不会再前进。数据没得翻，但渲染窗口
									// 可能还压着已加载的轮次：把这次点击转成一次窗口展开，否则
									// 按钮点了没反应、锚点也永远挂不出来（#477 e2e 真机复现）。
									expandWindowBatched(TIMELINE_WINDOW_EXPAND_STEP);
								}
							}
						} else {
							// prepend 被拒（atom 的四个前置之一不成立）：最常见是翻页期间缓存被写入、
							// revision 被抬高。此时游标 before 未变，再点一次即可重取同一页——不能报成
							// 「加载失败」，那会把「可重试」说成「坏了」。
							const revisionMoved = (cachedEntry?.revision ?? 0) !== expectedRevision;
							setLoadMoreError(revisionMoved ? t("timeline.loadMoreRetryable") : t("timeline.loadMoreFailed"));
						}
					})
					.catch((error: unknown) => {
						// 失败必须可见：没有 catch 时 IPC 抛错被吞掉，按钮弹回但页面无提示（2026-09 反馈）。
						if (getLatestLoad(sessionId) !== sequence) return;
						setLoadMoreError(error instanceof Error ? error.message : String(error));
					})
					.finally(() => {
						if (getLatestLoad(sessionId) === sequence) setIsLoadingMessagePage(false);
						// 插入没落地（早退 / 失败 / 空页 / prepend 被拒）：useLayoutEffect 依赖 visibleMessages.length，
						// 没插入就不跑，也就没人关整表渲染 —— 它只能等 1.5s 兜底，超时那刻虚拟化接管、
						// 未挂载行从实测高度回退估算、总高度突变 -> 重排 -> 抖。点几次就种几次跳。
						if (needsSolid && !insertionCommitted) endPrependSolid();
					});
				return;
			}
			// runtime 窗口会话：直接按轮次补历史（2026-11 轮次模型，不再有 100 条渲染窗口）。
			// 首次加载以运行时窗口段首条消息的 entryId 为锚点（两个下标空间唯一的对齐点），
			// 续页用上一页最旧条目的 entryId（nextBeforeEntryId）——主进程缓存命中路径依赖它。
			if (earlierHistoryCursor) {
				if (!sessionId || isLoadingMessagePage) return;
				// 游标由 resolveEarlierHistoryCursor 统一给出（与 historyHasMore 同一判断）：
				// 续页用上一页最旧条目的 entryId（nextBeforeEntryId），首次用窗口段首条带 entryId
				// 的消息，大历史窗口退化为 windowStartFilePos。这里不再自己找锚点——两处各写一份
				// 就会出现「按钮在、锚点缺、静默 return」的死按钮。
				const { before, beforeEntryId } = earlierHistoryCursor;
				const browseGeneration = historyBrowseGenerationRef.current;
				const sequence = allocateLoadSequence();
				trackLatestLoad(sessionId, sequence);
				const expectedRevision = cachedEntry?.revision ?? 0;
				// 只有 scroll（滚到顶部自动翻页）需要整表渲染：它要在 useLayoutEffect 里按 messageId
				// 查 DOM 行做 pin 补偿（pinBrowseRow -> measurePinnedRowTop），虚拟区外的行不在
				// DOM 里就量不到。button / backfill 走 resolveTimelineTopCompensation：补偿量 =
				// scrollHeight 差值（虚拟区占位高度是渲染期同步算出的，两次读数即得），不查任何
				// DOM —— 所以不必关闭虚拟化。用户点「加载更多」时把 100+ 轮全部真实挂载，正是
				// 「点了就卡」的主因。
				const needsSolid = source === "scroll";
				if (needsSolid) beginPrependSolid();
				let insertionCommitted = false;
				setIsLoadingMessagePage(true);
				// 重试时先清掉上一次的错误行
				setLoadMoreError(null);
				void readRecordMessagePage(sessionId, before ?? undefined, pageSize, { beforeEntryId })
					.then((page: SessionMessagePage) => {
						if (getLatestLoad(sessionId) !== sequence) return;
						// 与 disk 翻页同一语义：host 被停时不把空页当新历史，出失败行
						if (sessionHistoryUnavailableState(page)) {
							setLoadMoreError(t("timeline.dshHostStopped"));
							return;
						}
						if (prependHistoryPage({ sessionId, expectedRevision, before, page })) {
							insertionCommitted = true;
							// runtime history 页与 DOM 使用同一 3 轮 cohort；缓存命中和文件回退
							// 都只开放实际带回的轮数，避免数据 +3、窗口却 +10。
							// 回底/切会话后到达（跟随或代数过期）只写缓存，不得扩窗。
							if (
								shouldApplyDelayedHistoryResult({
									following: autoScrollRef.current,
									generationAtRequest: browseGeneration,
									currentGeneration: historyBrowseGenerationRef.current,
									explicit: source === "button" || source === "backfill",
								})
							) {
								const growth = resolvePageWindowGrowth(page.messages, pageSize);
								if (growth > 0) expandWindowBatched(growth);
								else if (page.messages.length === 0 && windowExpandableRef.current) {
									// 空页 = 已经到文件头，游标不会再前进。数据没得翻，但渲染窗口
									// 可能还压着已加载的轮次：把这次点击转成一次窗口展开，否则
									// 按钮点了没反应、锚点也永远挂不出来（#477 e2e 真机复现）。
									expandWindowBatched(TIMELINE_WINDOW_EXPAND_STEP);
								}
							}
						} else {
							// prepend 被拒（atom 的四个前置之一不成立）：最常见是翻页期间缓存被写入、
							// revision 被抬高。此时游标 before 未变，再点一次即可重取同一页——不能报成
							// 「加载失败」，那会把「可重试」说成「坏了」。
							const revisionMoved = (cachedEntry?.revision ?? 0) !== expectedRevision;
							setLoadMoreError(revisionMoved ? t("timeline.loadMoreRetryable") : t("timeline.loadMoreFailed"));
						}
					})
					.catch((error: unknown) => {
						// 失败必须可见：没有 catch 时 IPC 抛错被吞掉，按钮弹回但页面无提示（2026-09 反馈）。
						if (getLatestLoad(sessionId) !== sequence) return;
						setLoadMoreError(error instanceof Error ? error.message : String(error));
					})
					.finally(() => {
						if (getLatestLoad(sessionId) === sequence) setIsLoadingMessagePage(false);
						// 插入没落地（早退 / 失败 / 空页 / prepend 被拒）：useLayoutEffect 依赖 visibleMessages.length，
						// 没插入就不跑，也就没人关整表渲染 —— 它只能等 1.5s 兜底，超时那刻虚拟化接管、
						// 未挂载行从实测高度回退估算、总高度突变 -> 重排 -> 抖。点几次就种几次跳。
						if (needsSolid && !insertionCommitted) endPrependSolid();
					});
				return;
			}
		},
		[
			allocateLoadSequence,
			autoScrollRef,
			beginPrependSolid,
			cachedEntry?.revision,
			captureBrowsePin,
			diskPage,
			earlierHistoryCursor,
			endPrependSolid,
			escapeAutoScroll,
			expandWindowBatched,
			getLatestLoad,
			historyBrowseGenerationRef,
			isLoadingMessagePage,
			loadMoreAnchorRef,
			ownerKey,
			ownerKeyRef,
			prependHistoryPage,
			prependMessagePage,
			readRecordMessagePage,
			sessionId,
			t,
			timelineRef,
			trackLatestLoad,
			windowExpandableRef,
		],
	);

	// ── 回底清理临时历史（2026-11 轮次模型）──
	// 贴底稳定 1.5s 后清掉翻过的历史前缀（atom 只留运行时窗口段），渲染层内存回到最小；
	// 再次上翻走「atom → 主进程缓存 → 文件」重新拉取（主进程 12 轮内命中，无感）。
	// 上滚/加载历史中会取消待执行的清理；清理后 history 置空，后续再翻再拉。
	const historyClearTimerRef = useRef<number | undefined>(undefined);
	useEffect(() => {
		if (!controllerEnabled) return;
		if (!sessionId) return;
		if (autoScroll && runtimeHistory) {
			if (historyClearTimerRef.current != null) return;
			const clearNow = () => {
				historyClearTimerRef.current = undefined;
				if (!clearHistory(sessionId)) return;
				// 清理后丢弃在途历史页响应：迟到页会把已释放的 history 复活并携带旧滚动锚点
				const sequence = allocateLoadSequence();
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
	}, [allocateLoadSequence, autoScroll, clearHistory, controllerEnabled, isTimelineAtBottom, runtimeHistory, sessionId, timelineRef, trackLatestLoad]);

	return {
		diskPage,
		earlierHistoryCursor,
		historyHasMore,
		hasEarlierPages,
		visibleMessages,
		isLoadingMessagePage,
		setIsLoadingMessagePage,
		loadMoreError,
		setLoadMoreError,
		loadMoreMessages,
		reloadFromDisk,
		startDshHostAndReload,
	};
}
