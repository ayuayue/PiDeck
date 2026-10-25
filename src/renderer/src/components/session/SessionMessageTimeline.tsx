import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import { useReducedMotion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { ComponentProps, ReactNode, Ref, RefObject } from "react";
import type { ChatMessage, ImageContent } from "../../../../shared/types";
import { MarkdownStream } from "./MarkdownStream";
import { replaceExpandedRefBlocksWithLabels } from "./composer/quoteChip";
import { Button } from "../ui-shadcn/button";
import { DiagnosticMessageCard, EmptyState, MultiSelectModal, RespondingIndicator, TurnRow, UserBubble, stripMarkdown } from "./SurfaceParts";
import { getMultiSelectImageCaptureIds, groupToolMessages, reconcileRuns, type RenderMessage } from "../app/AppUtils";
import { liveThinkingIdBySessionIdAtomFamily, liveTextStreamingBySessionAtom, liveThinkingStreamingBySessionAtom, sessionMessageCacheBySessionIdAtomFamily, sessionMessageLoadStateAtom, sessionRecordByIdAtomFamily, sessionRuntimeBySessionIdAtomFamily, sessionSendStateByIdAtom } from "../../atoms";
import { writeClipboardImage } from "../../utils/clipboard";
import { useTimelineSelection } from "../../hooks/useTimelineSelection";
import { useMessageContextMenu } from "../../hooks/useMessageContextMenu";
import { useFavorites } from "../../hooks/useFavorites";
import { SelectionToolbar } from "./timeline/SelectionToolbar";
import { MessageContextMenu } from "./timeline/MessageContextMenu";
import { deriveTimelineRunActivity } from "./timeline/timelineRunActivity";
import { canLoadSessionTimelineMore, deriveSessionSurfaceRuntime, type SessionTimelineController } from "../../hooks/useSessionTimelineController";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { Loader2, LoaderCircle, Power } from "lucide-react";
import { showNotice } from "../../utils/notice";
import { isLiveRuntimeStatus } from "../../utils/sessionCommands";
import { composeFailureNotice, isRetryStatusMessage, reduceFailureNoticePass, type FailureNoticePassState } from "./timelineFailureNotice";
import { SessionStartSurface } from "./SessionStartSurface";
import { NotifyMessageCard, shouldRenderNotifyCard } from "./NotifyMessageCard";
import { ExtensionEntryCard } from "./ExtensionEntryCard";
import { MessageScroller } from "../agents/message-scroller";
import { askEchoBySessionIdAtomFamily } from "../../atoms/ask-echo-atoms";
import { injectAskEchoMessage } from "../../utils/askUi";
import { resolveFreshTailIds } from "../../lib/pinTurnScroll";
import { chatContentWidthStyle } from "./chatContentWidth";
import { useSessionVisionBridgeExpected } from "../../hooks/useSessionVisionBridgeExpected";
import { countAgentRunItems, selectTimelineTurnWindow, shouldWindowTimelineTurns, TIMELINE_MOUNTED_TURN_LIMIT } from "./timeline/turnRenderWindow";
import { VirtualRunList } from "./timeline/VirtualRunList";
import { isRenderableRunItem } from "./timeline/virtualTimelinePolicy";
import { REVEAL_TIMELINE_ENTRY_EVENT, REVEAL_TIMELINE_ENTRY_TIMEOUT_MS } from "../../hooks/timeline/timelineRevealChannel";

type TurnRowProps = ComponentProps<typeof TurnRow>;
type UserBubbleProps = ComponentProps<typeof UserBubble>;

/** 一轮结束后、用户无操作的自动收起等待时间。 */
const TURN_SETTLE_IDLE_COLLAPSE_MS = 1500;
/** 折叠高度动画基本结束后再做「拉到中上方」定位，避免用折叠前的高度计算目标。 */
const TURN_SETTLE_SCROLL_DELAY_MS = 320;

// 失败/重试 toast 去重必须放模块级：分屏多栏、切走再切回都会重挂 effect。
// 重试签名尤其不能放组件 ref——旧实现 lastRetryToastRef 在 sessionId 变化时被清空，
// 切回同一会话会把「自动重连 / 自动重试」再播一遍。
const toastedFailureIds = new Set<string>();
const toastedRetrySignatures = new Set<string>();
const TOASTED_FAILURE_IDS_LIMIT = 500;
function pruneToastedFailureSets() {
	// 超限：清空重建（Set 无 FIFO；失败 toast 是低频事件，偶发重复提醒可接受）
	if (toastedFailureIds.size > TOASTED_FAILURE_IDS_LIMIT) toastedFailureIds.clear();
	if (toastedRetrySignatures.size > TOASTED_FAILURE_IDS_LIMIT) toastedRetrySignatures.clear();
}

/** 数组按对象身份判断 prefix/suffix：runtime history 的补页与 slideOut 保留旧消息引用。 */
function isMessagePrefix(prefix: readonly ChatMessage[], next: readonly ChatMessage[]): boolean {
	if (prefix.length > next.length) return false;
	for (let i = 0; i < prefix.length; i += 1) {
		if (prefix[i] !== next[i]) return false;
	}
	return true;
}

function isMessageSuffix(suffix: readonly ChatMessage[], next: readonly ChatMessage[]): boolean {
	if (suffix.length > next.length) return false;
	const offset = next.length - suffix.length;
	for (let i = 0; i < suffix.length; i += 1) {
		if (suffix[i] !== next[offset + i]) return false;
	}
	return true;
}

/** 弹失败/重试/扩展错误 toast：标题与正文由 composeFailureNotice 统一收口。 */
function showFailureToast(message: ChatMessage): void {
	const notice = composeFailureNotice(message);
	showNotice(notice.body, notice.duration, notice.kind, notice.title, undefined, notice.id);
}

type TimelineInteractionProps = {
	instantSessionSwitch?: boolean;
	hasProject: boolean;
	onCreateSession: () => void;
	showThinking: boolean;
	validCommandNames: Set<string>;
	validFilePaths: Set<string>;
	onPreviewImage: (image: ImageContent) => void;
	onOpenExternal: (url: string, forceSystem?: boolean) => void;
	onOpenFile?: (path: string) => void;
	onDiffFile?: TurnRowProps["onDiffFile"];
	onResendUserMessage?: UserBubbleProps["onResendUserMessage"];
	onEditMessage?: TurnRowProps["onEditMessage"];
	onDeleteMessage?: TurnRowProps["onDeleteMessage"];
	onRemoveMessageImage?: UserBubbleProps["onRemoveMessageImage"];
	onForkMessage?: UserBubbleProps["onForkMessage"];
	onRewindToMessage?: UserBubbleProps["onRewindToMessage"];
	forkingMessageId?: string | null;
	onToast: (message: string) => void;
	/** 新建 Agent 的空时间线快捷操作：只写入 composer，不自动投递。 */
	onQuickPrompt?: (prompt: string) => void;
	/** 当前会话的阻塞式交互（如 ask_question），由时间线统一承载滚动与底部定位。 */
	runtimeUi?: ReactNode;
	/** 最新回复后唯一的动作落点；内容由本栏 composer 投入，不给历史每轮复制按钮。 */
	replyActionsRef?: Ref<HTMLDivElement>;
};

export type SessionMessageTimelineProps = TimelineInteractionProps & {
	sessionId: string;
	/** The only controller that may own this timeline's scroll and lifecycle state. */
	controller: SessionTimelineController;
	timelineRef?: RefObject<HTMLElement | null>;
};

export function SessionMessageTimeline(props: SessionMessageTimelineProps) {
	const sessionId = props.sessionId;
	const session = useAtomValue(sessionRecordByIdAtomFamily(sessionId));
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(sessionId));
	const hasLiveRuntime = Boolean(runtime?.agentId) && isLiveRuntimeStatus(runtime?.status);
	const messageLoadStateSelector = useMemo(() => selectAtom(sessionMessageLoadStateAtom, (states) => states[sessionId], Object.is), [sessionId]);
	const sendStateSelector = useMemo(() => selectAtom(sessionSendStateByIdAtom, (states) => states[sessionId], Object.is), [sessionId]);
	const messageLoadState = useAtomValue(messageLoadStateSelector);
	const sendState = useAtomValue(sendStateSelector);
	const controller = props.controller;
	// DSH host 被用户手动停止：历史暂时读不了（main 侧降级成带原因的空页）。
	// 与普通读盘失败分开渲染——DSH 会话没有 pi 会话文件，重试也永远不会自愈。
	const dshHostStopped = messageLoadState?.status === "error" && messageLoadState.reason === "dsh-host-stopped";
	// DSH 运行时未安装（#375）：与手动停止不同，「启动 host」修不好这件事——缺的是 runtime 资源本身
	const dshRuntimeMissing = messageLoadState?.status === "error" && messageLoadState.reason === "dsh-runtime-missing";
	// 会话文件还不存在（新建会话/外部连接建的会话，在发出第一条消息前 pi 不落盘）：
	// 这不是故障，是「还没有内容」——给友好空态，不显示错误原因，也不落到起始页。
	const sessionFileMissing = messageLoadState?.status === "error" && messageLoadState.reason === "file-missing";
	const [startingDshHost, setStartingDshHost] = useState(false);
	/** 专态主按钮：显式启动 host（唯一能解开手动停止标记的路径）+ 重载本会话历史。 */
	const startDshHostAndRetry = useCallback(async () => {
		if (startingDshHost) return;
		setStartingDshHost(true);
		try {
			// 启动失败（host boot 报错）保留专态并提示；成功路径由控制器重载历史
			if (!(await controller.startDshHostAndReload())) showNotice(t("config.dsh.hostStartFailed"), 6000);
		} finally {
			setStartingDshHost(false);
		}
	}, [controller, startingDshHost]);
	const timelineRef = props.timelineRef ?? controller.timelineRef;
	const activeMessages = controller.messages;
	const paginatedMessages = controller.visibleMessages;
	const totalMessageCount = controller.totalMessageCount;
	const hasMoreMessages = controller.hasMoreMessages;
	const isLoadingMoreMessages = controller.isLoadingMoreMessages;
	const hasActiveConversation = Boolean(session);
	// disk 读取无论空/非空都会创建缓存条目：「条目是否存在」用于区分
	// 读取未到达（无条目→钉骨架屏）与读取已返回（有条目→起始页合法）。
	const surfaceCachedEntry = useAtomValue(sessionMessageCacheBySessionIdAtomFamily(sessionId ?? ""));
	const modernSurfaceState = deriveSessionSurfaceRuntime(
		activeMessages.length,
		messageLoadState?.status,
		sendState?.status,
		runtime?.status,
		runtime?.state,
		// 缓存条目存在性（disk 读取无论空/非空都会创建条目）：ready 且无条目 =
		// 读取结果未到达 → 钉骨架屏；有条目（即使空）＝读取已返回，空会话起始页合法。
		// 不依赖 catalog messageCount（摘要缺失时兑底为 0，不可靠）。
		Boolean(surfaceCachedEntry),
		// 用 controller 的 sticky：预热回写 filePath/dshSessionId 后仍不闪历史骨架。
		controller.knownEmpty,
	);
	const isConversationLoading = modernSurfaceState.isLoading;
	// 空态（起始页 / 旧 Editorial 空态）时 [role=log] 不套聊天列宽度约束：
	// chatContentWidthStyle 把内容列限制为 min(80%, 100%-48px)，会让「新建 Agent」
	// 等真实会话页的 SessionStartSurface 输入框比引导页（直接挂 ProjectEmptyState、
	// 不受此约束）窄且位置偏移，同一组件两副长相；起始页组件自身有 max-w-[980px]
	// 居中控制，去掉约束后与引导页完全一致。有消息时保持原约束（消息列与输入框对齐契约）。
	const showSurfaceEmptyState = !hasActiveConversation || (!isConversationLoading && activeMessages.length === 0);
	const canLoadMoreMessages = canLoadSessionTimelineMore(modernSurfaceState.isStarting, activeMessages.length);
	// 划选引用：选区落在同一条消息内时在选区上方提供「引用并提问」按钮
	const { quote: selectionQuote, clear: clearSelectionQuote, toolbarRef: selectionToolbarRef } = useTimelineSelection(timelineRef);
	// 消息右键菜单：复制来源（选区快照 / 命中消息 / live 正文回退）由 hook 解析，
	// 这里只持有控制器并挂到消息列表容器上（消息、用户气泡、工具卡都在容器内）。
	const { favoritedMessageKeys, toggleMessageFavorite } = useFavorites();
	// 收藏来源元信息：右键菜单每次打开时现取（favoriteContext），回合星标走 ref 读最新值——
	// TurnRow 的自定义 memo 不比较回调引用，回调必须稳定，否则历史轮次会被整体重渲染。
	const favoriteMetaRef = useRef({ sessionTitle: session?.title ?? null, projectId: session?.projectId ?? null });
	favoriteMetaRef.current = { sessionTitle: session?.title ?? null, projectId: session?.projectId ?? null };
	const favoriteContext = useMemo(() => ({ sessionId, sessionTitle: session?.title ?? null, projectId: session?.projectId ?? null }), [session?.projectId, session?.title, sessionId]);
	const handleFavoriteReply = useCallback(
		(text: string, messageId: string | null) => {
			if (!sessionId) return;
			const meta = favoriteMetaRef.current;
			// 开关语义：这条回复已收藏则取消，否则新增（与右键菜单共用「会话 + 消息 id」身份）。
			void toggleMessageFavorite({ kind: "message", text, role: "assistant", messageId, sessionId, sessionTitle: meta.sessionTitle, projectId: meta.projectId });
		},
		[sessionId, toggleMessageFavorite],
	);
	const messageContextMenu = useMessageContextMenu({ messages: activeMessages, scopeKey: sessionId, favoriteContext, favoritedMessageKeys });
	const activeRuntimeState = runtime?.state;
	const activeConversationStatus = modernSurfaceState.status;
	// 只订 live id：思考正文由 ThinkingStep 叶子订阅，避免 50ms 戳醒整条 timeline。
	const liveThinkingId = useAtomValue(liveThinkingIdBySessionIdAtomFamily(sessionId ?? ""));
	// 状态条只订 streaming 位（boolean），不订正文 atom，避免 50ms 重渲整条 timeline。
	const liveTextStreaming = useAtomValue(liveTextStreamingBySessionAtom(sessionId ?? ""));
	const liveThinkingStreaming = useAtomValue(liveThinkingStreamingBySessionAtom(sessionId ?? ""));
	const sessionRuntimeBusy = modernSurfaceState.isBusy;
	// Pi can compact immediately after agent_end. Keep the session busy during that
	// file rewrite, but finalize the just-completed model turn in the timeline.
	const { isCompacting, isRuntimeBusy, isTurnRunning } = deriveTimelineRunActivity({
		isRuntimeBusy: sessionRuntimeBusy,
		isCompacting: activeRuntimeState?.isCompacting,
		isTurnActive: activeRuntimeState?.isTurnActive,
	});
	const cancellingUi = false;
	const loadMoreMessages = controller.loadMoreMessages;
	// ── 滚动接近顶部自动加载历史（2026-11 轮次模型）──
	// 监听器已迁移到 useSessionTimelineController（程序化滚动抑制在同一 owner）：
	// 用户接近顶部时先扩 DOM 窗口，挂满后触顶才按轮补历史；
	// prepend 补偿不会连锁触发下一页。
	// 新增消息入场动画跟踪 ──
	// 只对「时间线尾部新增」的消息播放一次入场动画：历史加载/分页前插不算，
	// 避免整屏消息同时闪烁。乐观上屏的用户消息与流式替换后的权威消息都会触发。
	const [multiSelectOpen, setMultiSelectOpen] = useState(false);
	// 多选期间 VirtualRunList 用全量 reconciledRuns 渲染（导出需要窗口外的 DOM）。关闭后若立刻
	// 缩回 turn 窗口，用户在多选时滚到的「窗口外那一轮」会从 DOM 消失，锚点补偿找不到行，
	// 视口被 clamp 回尾部（#401 复审实测的 P1）。所以关闭后保留全量渲染，直到回到底部
	// （此时锚点必然落在尾部窗口内）；虚拟化仍生效，常驻 DOM 不涨。
	const [retainFullRuns, setRetainFullRuns] = useState(false);
	// 导出图片需要「窗口外选中的行也在 DOM」：只在点「复制为图片」时临时整表真实渲染，
	// 导出后立刻恢复虚拟化。多选打开期间保持虚拟化——否则长历史点开多选就是一次全量挂载
	// （#213 形态，终审 P1）。
	const [multiSelectExporting, setMultiSelectExporting] = useState(false);
	// 2026-08 perf：TurnRow 的 memo 浅比较依赖 props 引用稳定。内联箭头会在每次
	// 时间线渲染创建新函数 → 所有 TurnRow 的 memo 失效 → 滚动/流式时全量重渲染
	// （longtask 归因：index.js::check/anon 在每个长任务里占 50ms+）。
	const handleEnterMultiSelect = useCallback(() => {
		setRetainFullRuns(true);
		setMultiSelectOpen(true);
	}, []);
	const [freshMessageIds, setFreshMessageIds] = useState<ReadonlySet<string>>(() => new Set());
	const seenTailMessageIdRef = useRef<string | undefined>(undefined);
	const freshTimersRef = useRef<Map<string, number>>(new Map());
	// ── 上滚窗口扩展的「顶部新增」入场动画（2026-12 体验优化）──
	// 窗口扩展（上滚 3→N 轮 / 翻页 prepend）会在 displayRuns 顶部插入新轮次；
	// 对比前后 id 序列找出「顶部新增段」，给它们播从上方淡入的过渡，
	// 让「内容挂载那一下」不是硬切而是流进来。动画播完（约 300ms）后清理标记。
	const reduceMotion = useReducedMotion() ?? false;
	const [topFreshIds, setTopFreshIds] = useState<ReadonlySet<string>>(() => new Set());
	const [latestTurnAutoCollapseTick, setLatestTurnAutoCollapseTick] = useState(0);
	const lastSessionIdRef = useRef(sessionId);
	const prevDisplayRunsIdsRef = useRef<string[] | undefined>(undefined);
	const topFreshTimersRef = useRef<Map<string, number>>(new Map());
	// 最新轮结束后的「阅读停顿 → 布局稳定 → 最终回答定位」流水线：
	// 定时器只由状态边界取消（会话切换/新一轮/离开跟随），不监听任何输入事件。
	const turnSettleIdleTimerRef = useRef<number | undefined>(undefined);
	const turnSettleScrollTimerRef = useRef<number | undefined>(undefined);
	/** 已排定流水线的 run id：同 run 重复 arm 直接复用，避免双调度。 */
	const turnSettleIdleLastRunRef = useRef<string | undefined>(undefined);
	const latestRunIdRef = useRef<string | undefined>(undefined);
	// 会话内容就绪淡入：isConversationLoading true→false（切会话历史加载完成）时，
	// 给 MessageScroller 挂一次 160ms 淡入动画类，与骨架屏消失衔接，避免整块瞬间出现。
	// 触发必须用 useLayoutEffect（paint 前同步）：若用 useEffect，内容会先以正常透明度
	// 绘制一帧，再被动画类重置到 opacity:0 重新淡入——视觉上就是「闪一下再淡入」。
	const [contentEntering, setContentEntering] = useState(false);
	const prevConversationLoadingRef = useRef(isConversationLoading);
	useLayoutEffect(() => {
		if (!props.instantSessionSwitch && prevConversationLoadingRef.current && !isConversationLoading) {
			setContentEntering(true);
		}
		prevConversationLoadingRef.current = isConversationLoading;
	}, [isConversationLoading, props.instantSessionSwitch]);
	// 动画播完清理类（非视觉关键路径，放 useEffect 避免 layout 阶段多一次重渲染）
	useEffect(() => {
		if (!contentEntering) return;
		const timer = window.setTimeout(() => setContentEntering(false), 180);
		return () => window.clearTimeout(timer);
	}, [contentEntering]);

	useLayoutEffect(() => {
		// 会话切换时重置：新会话的首帧（历史加载）不播动画。
		// 用 layout effect：必须在上滚窗口 layout effect 之前清掉 prevDisplayRunsIdsRef，
		// 否则切会话后新旧 id 序列会被拿去比较，可能误播顶部入场动画。
		if (lastSessionIdRef.current === sessionId) return;
		lastSessionIdRef.current = sessionId;
		wasRuntimeBusyRef.current = isRuntimeBusy;
		seenTailMessageIdRef.current = undefined;
		setFreshMessageIds(new Set());
		// retain 是「关闭多选后不缩窗」的会话内状态：切会话必须复位，否则新会话的窗口裁剪
		// 会对整个会话永久失效（#401 终审 P1）。
		setRetainFullRuns(false);
		// 多选状态同样是「本会话」的：不复位时新会话的 runs 会直接吃全量 reconciledRuns
		// （跳过 turn 窗口裁剪），旧多选面板还会把候选换成新会话消息（#401 复审 P1）。
		setMultiSelectOpen(false);
		setMultiSelectExporting(false);
		for (const timer of freshTimersRef.current.values()) window.clearTimeout(timer);
		freshTimersRef.current.clear();
		prevDisplayRunsIdsRef.current = undefined;
		setTopFreshIds(new Set());
		for (const timer of topFreshTimersRef.current.values()) window.clearTimeout(timer);
		topFreshTimersRef.current.clear();
		if (turnSettleIdleTimerRef.current !== undefined) {
			window.clearTimeout(turnSettleIdleTimerRef.current);
			turnSettleIdleTimerRef.current = undefined;
		}
		if (turnSettleScrollTimerRef.current !== undefined) {
			window.clearTimeout(turnSettleScrollTimerRef.current);
			turnSettleScrollTimerRef.current = undefined;
		}
		turnSettleIdleLastRunRef.current = undefined;
		latestRunIdRef.current = undefined;
		setLatestTurnAutoCollapseTick(0);
	}, [sessionId]);

	// ── 失败/重试 toast：只对「当前会话加载完成后新出现」的诊断弹 ──
	// 切会话必须重采基线，且重试签名走模块级 Set：组件 ref 会在切走时被清掉，
	// 切回同一条 processReconnectFailed / retryScheduled 就会重放 toast。
	const failureNoticeStateRef = useRef<FailureNoticePassState>({
		sessionId: undefined,
		baselineIds: null,
	});
	useEffect(() => {
		if (!sessionId) return;
		const result = reduceFailureNoticePass({
			sessionId,
			isLoading: isConversationLoading,
			messages: activeMessages,
			state: failureNoticeStateRef.current,
			toastedIds: toastedFailureIds,
			toastedRetrySignatures,
		});
		failureNoticeStateRef.current = result.state;
		pruneToastedFailureSets();
		for (const message of result.toasts) showFailureToast(message);
	}, [sessionId, activeMessages, isConversationLoading]);

	useEffect(() => {
		const previousTail = seenTailMessageIdRef.current;
		const lastMessage = activeMessages[activeMessages.length - 1];
		const nextTail = lastMessage?.id;
		seenTailMessageIdRef.current = nextTail;
		if (!nextTail) return;
		const fresh = resolveFreshTailIds(activeMessages, previousTail, nextTail, sendState?.requestId);
		if (fresh.length === 0) return;
		setFreshMessageIds((current) => {
			const next = new Set(current);
			for (const id of fresh) next.add(id);
			return next;
		});
		for (const id of fresh) {
			const timer = window.setTimeout(() => {
				freshTimersRef.current.delete(id);
				setFreshMessageIds((current) => {
					if (!current.has(id)) return current;
					const next = new Set(current);
					next.delete(id);
					return next;
				});
			}, 1200);
			freshTimersRef.current.set(id, timer);
		}
	}, [activeMessages, controller.autoScroll, sendState?.requestId]);

	useEffect(
		() => () => {
			for (const timer of freshTimersRef.current.values()) window.clearTimeout(timer);
			freshTimersRef.current.clear();
		},
		[],
	);

	// 流式期渲染优化：runtime 会话把「历史前缀」和「窗口段」分开分组。
	// history 是 prepend-only、低频变化；流式 50ms 增量只影响窗口段，
	// 若每次都对全部已加载历史跑 groupToolMessages，上翻很多页后打字机仍会全量重建。
	const runtimeHistoryMessages = surfaceCachedEntry?.source === "runtime" ? surfaceCachedEntry.history?.messages : undefined;
	// runtime history 变化只有三种：头部补页（prepend）、尾部并入 slideOut（append）、
	// 版本失效重建。前两种保留旧消息引用，可增量 group，避免每次补页都全量重建历史。
	const historyGroupStateRef = useRef<{
		messages: readonly ChatMessage[] | undefined;
		groups: RenderMessage[];
	}>({ messages: undefined, groups: [] });
	const groupedHistoryRuns = useMemo(() => {
		const next = runtimeHistoryMessages;
		const state = historyGroupStateRef.current;
		if (next === undefined) {
			historyGroupStateRef.current = { messages: undefined, groups: [] };
			return null;
		}
		if (state.messages === next) return state.groups;
		const prev = state.messages;
		let groups: RenderMessage[];
		if (prev && isMessagePrefix(prev, next)) {
			const appended = next.slice(prev.length);
			groups = [...state.groups, ...groupToolMessages(appended, { agentBusy: isTurnRunning })];
		} else if (prev && isMessageSuffix(prev, next)) {
			const prepended = next.slice(0, next.length - prev.length);
			groups = [...groupToolMessages(prepended, { agentBusy: isTurnRunning }), ...state.groups];
		} else {
			groups = groupToolMessages(next, { agentBusy: isTurnRunning });
		}
		historyGroupStateRef.current = { messages: next, groups };
		// Turn activity participates in history grouping: when context compaction
		// starts after agent_end, the preceding assistant reply becomes final.
		return groups;
	}, [runtimeHistoryMessages, isTurnRunning]);
	// The window segment follows the same turn-level activity rule as history.
	// DSH 已作答回显内联注入：应答时记录的锚点（最后一条消息 id）即提问阻塞的
	// 工具调用位置，把回显合成为 ask_question 工具消息插在其后，走 pi _askCard
	// 同一分组/渲染路径。只在派生层注入——DSH 历史由 host 全量折叠投影，任何写
	// 进缓存的合成消息都会被下次投影冲掉。runtime 换代即作废；锚点被压缩/重投影
	// 改写找不到时不注入（错位的回显比没有更糟）。
	const askEchoEntry = useAtomValue(askEchoBySessionIdAtomFamily(sessionId));
	const askEchoPlacement = useMemo(() => {
		if (!askEchoEntry) return undefined;
		if (runtime?.agentId !== askEchoEntry.agentId || runtime.runtimeGeneration !== askEchoEntry.runtimeGeneration) return undefined;
		return {
			echo: askEchoEntry.echo,
			agentId: askEchoEntry.agentId,
			...(askEchoEntry.anchorMessageId ? { anchorMessageId: askEchoEntry.anchorMessageId } : {}),
			answeredAt: askEchoEntry.answeredAt,
		};
	}, [askEchoEntry, runtime?.agentId, runtime?.runtimeGeneration]);
	const echoedWindowMessages = useMemo(() => injectAskEchoMessage(controller.messages, askEchoPlacement), [controller.messages, askEchoPlacement]);
	const echoedPaginatedMessages = useMemo(() => injectAskEchoMessage(paginatedMessages, askEchoPlacement), [paginatedMessages, askEchoPlacement]);
	const groupedWindowRuns = useMemo(() => groupToolMessages(echoedWindowMessages, { agentBusy: isTurnRunning }), [echoedWindowMessages, isTurnRunning]);
	const renderedRuns = useMemo(() => {
		if (groupedHistoryRuns) {
			return [...groupedHistoryRuns, ...groupedWindowRuns];
		}
		return groupToolMessages(echoedPaginatedMessages, { agentBusy: isTurnRunning });
	}, [groupedHistoryRuns, groupedWindowRuns, echoedPaginatedMessages, isTurnRunning]);
	// 阶段0补强：对未变化的 run 复用旧对象引用，历史 run 的 memo 比较退化为 O(1)
	const prevRenderedRunsRef = useRef<RenderMessage[] | undefined>(undefined);
	const reconciledRuns = useMemo(() => {
		const next = reconcileRuns(prevRenderedRunsRef.current, renderedRuns);
		prevRenderedRunsRef.current = next;
		return next;
	}, [renderedRuns]);
	// 渲染窗口（2026-08 黑屏治理）：贴底只挂尾部 3 轮；上滚查看历史也裁剪
	// （controller.scrolledWindowTurns，初始 3 轮，接近顶部按 3 轮 cohort 自动扩大）——
	// 历史全量放开挂载是大会话渲染进程内存峰值/黑屏的来源。数据仍在 atoms。
	//
	// 关键不变量：锚点保存和恢复必须使用同一轮次窗口。恢复期若临时全量物化、
	// restoreAt 后又收回尾部窗口，文档高度收缩会把已恢复的 scrollTop 截断，造成
	// 切回位置漂移。锚点不在已保存窗口时，controller 会逐步扩窗后重试；跳转也走
	// 同一扩窗策略，而不是绕过窗口约束。
	const followingForTurnWindow = controller.autoScroll;
	const turnWindowTurns = followingForTurnWindow ? TIMELINE_MOUNTED_TURN_LIMIT : controller.scrolledWindowTurns;
	const displayRuns = useMemo(() => selectTimelineTurnWindow(reconciledRuns, turnWindowTurns), [reconciledRuns, turnWindowTurns]);
	useEffect(() => {
		// 多选关闭且回到底部后才允许缩回 turn 窗口：回底时锚点必在尾部窗口内，缩回不会丢行。
		if (!multiSelectOpen && followingForTurnWindow) setRetainFullRuns(false);
	}, [followingForTurnWindow, multiSelectOpen]);
	// 身份判定（2026-08 perf）：位置判定（index / displayRuns.length）随滚动窗口切片
	// 变化会让窗口内所有 TurnRow 的位置相关 props 一起翻转 → memo 全部失效 →
	// 滚动 + 流式推送叠加时全量重渲染，单帧超 50ms 形成 longtask（实测归因）。
	// 改为按 run id 判定：窗口扩展/收缩只影响切片边界，尾部 run 的身份不变 → memo 生效。
	// MessageItem 的 id 在 message.id，其余类型在顶层 id（与 useLayoutEffect 的 id 提取一致）。
	// 空窗口（displayRuns 为空数组）时返回 undefined，避免越界崩溃。
	const renderMessageId = (item: RenderMessage | undefined): string | undefined => {
		if (!item) return undefined;
		return item.kind === "message" ? item.message.id : item.id;
	};
	const lastDisplayedItemId = renderMessageId(displayRuns[displayRuns.length - 1]);
	const latestAgentRunId = useMemo(() => {
		for (let index = displayRuns.length - 1; index >= 0; index -= 1) {
			const item = displayRuns[index];
			if (item?.kind === "agent-run") return item.id;
		}
		return undefined;
	}, [displayRuns]);
	// 上滚窗口扩展：对比前后 displayRuns 的 id 序列，找出顶部新增段
	// （窗口扩展 / 数据翻页都在顶部插入内容）。只标记「前缀新增」——
	// 尾部追加（流式新轮）走 freshMessageIds，不在此处处理。
	// 用 useLayoutEffect 而不是 useEffect：被动 effect 在浏览器 paint 后才补动画类，
	// 新内容会先以正常透明度画出一帧再跳回 opacity:0，视觉上闪一下。
	useLayoutEffect(() => {
		const nextIds = displayRuns.map((item) => (item.kind === "message" ? item.message.id : item.id));
		const prevIds = prevDisplayRunsIdsRef.current;
		prevDisplayRunsIdsRef.current = nextIds;
		if (!prevIds || prevIds.length === 0 || reduceMotion) return; // 首帧/减少动态不播
		// 找顶部新增段：从头部逐个对比，遇到第一个旧序列中存在的 id 为止
		const prevSet = new Set(prevIds);
		let added: string[] = [];
		for (const id of nextIds) {
			if (prevSet.has(id)) break;
			added.push(id);
		}
		// 新增段为空（纯尾部变化/无变化）或过大（会话切换整段替换）时不播
		if (added.length === 0 || added.length >= nextIds.length) return;
		setTopFreshIds((current) => {
			const next = new Set(current);
			for (const id of added) next.add(id);
			return next;
		});
		for (const id of added) {
			const timer = window.setTimeout(() => {
				topFreshTimersRef.current.delete(id);
				setTopFreshIds((current) => {
					if (!current.has(id)) return current;
					const next = new Set(current);
					next.delete(id);
					return next;
				});
			}, 400); // 动画约 280-300ms，保留 400ms 后清理
			topFreshTimersRef.current.set(id, timer);
		}
	}, [displayRuns, reduceMotion]);
	useEffect(
		() => () => {
			for (const timer of topFreshTimersRef.current.values()) window.clearTimeout(timer);
			topFreshTimersRef.current.clear();
		},
		[],
	);
	// 「最后一个 agent-run」：live 挂载门的判定基准。不能按最后一条显示条目判定：
	// steer 排队期显示数组以用户消息结尾（新轮尚未产生首条消息），最后一条 agent-run
	// 才是真正的流式轮；反过来若门控放宽到任意轮，被 steer 打断的旧轮（尾部是空文本
	// interim）会挂上会话级流式槽，把新一轮正文在旧轮底部再打印一遍（同一中间回复
	// 前后双份，2026-08 回归）。
	// 注意：这个判定只用于 live 挂载门——isLatestRun/busy 仍按「最后一条显示条目」
	// 判定，否则普通发送的激活等待期（用户消息在末尾）会把上一轮已完成、已提升的
	// 最终回答重新降级，导致最终回答暂时消失。
	const lastAgentRunIndex = useMemo(() => {
		for (let index = displayRuns.length - 1; index >= 0; index -= 1) {
			if (displayRuns[index].kind === "agent-run") return index;
		}
		return -1;
	}, [displayRuns]);

	// ── 最新轮结束后的 1.5s idle 自动收起 ──
	// 仅存活 Agent 实例在跟底时安排；纯历史浏览不自动改变阅读位置。
	// 鼠标移动、输入草稿不取消，真实上滚读历史会退出跟随。
	const wasRuntimeBusyRef = useRef(isRuntimeBusy);
	// 1.5s 后再复核，而不是沿用安排时刻的快照（见下方定时器注释）。
	// 这两个值只给定时器读，不进 effect 依赖：autoScroll 若进依赖，终态 flush 期间
	// 一次短暂离开底部的翻转就会触发 effect 清理，把刚安排的收起定时器清掉。
	const isRuntimeBusyRef = useRef(isRuntimeBusy);
	isRuntimeBusyRef.current = isRuntimeBusy;
	const autoScrollRef = useRef(controller.autoScroll);
	autoScrollRef.current = controller.autoScroll;

	useEffect(() => {
		const latestRun = lastAgentRunIndex >= 0 ? displayRuns[lastAgentRunIndex] : undefined;
		latestRunIdRef.current = latestRun?.kind === "agent-run" ? latestRun.id : undefined;
	}, [displayRuns, lastAgentRunIndex]);

	// 回复完结后不再「自动滚回答案开头」（旧"安静收起"/完结定位已删除）。
	// 自动滚动只发生在「发送那一刻」：由 controller 对新 user 行做一次性置顶动画。
	// 完结后视口应保持用户在离开时的位置不变；会话切换由 controller 的恢复逻辑负责。
	useEffect(() => {
		const wasBusy = wasRuntimeBusyRef.current;
		wasRuntimeBusyRef.current = isRuntimeBusy;
		const clearIdle = () => {
			if (turnSettleIdleTimerRef.current !== undefined) {
				window.clearTimeout(turnSettleIdleTimerRef.current);
				turnSettleIdleTimerRef.current = undefined;
			}
			if (turnSettleScrollTimerRef.current !== undefined) {
				window.clearTimeout(turnSettleScrollTimerRef.current);
				turnSettleScrollTimerRef.current = undefined;
			}
			turnSettleIdleLastRunRef.current = undefined;
		};
		if (isRuntimeBusy || !hasLiveRuntime) {
			clearIdle();
			return;
		}
		if (!wasBusy) return;
		// 「运行中 → 停转」边沿仅用于让旧的 settled 流水线失效；不再调度任何定位。
		// 仍保留「1.5s 阅读停顿 → 自动收起最新轮」的让读不托苏。
		const latestRunId = latestRunIdRef.current;
		if (!latestRunId) return clearIdle;
		if (turnSettleIdleTimerRef.current !== undefined) {
			window.clearTimeout(turnSettleIdleTimerRef.current);
		}
		turnSettleIdleLastRunRef.current = latestRunId;
		turnSettleIdleTimerRef.current = window.setTimeout(() => {
			turnSettleIdleTimerRef.current = undefined;
			// 触发条件在 1.5s 后复核，而不是沿用安排时刻的快照：
			// - DSH 的 idle 边沿先于终态 messages flush 到达，末轮会在窗口内重新分组
			//   （run id 变化）；按安排时 id 相等判断会永久跳过收起（用户反馈
			//   「DSH 会话结束后执行过程不自动折叠」）；
			// - 终态 flush 也可能让视口短暂离开底部，1.5s 后已回到底部仍应收起。
			// 用户真实上滚阅读时 autoScroll 保持 false，这里跳过（不打扰阅读）。
			if (isRuntimeBusyRef.current || !autoScrollRef.current || !latestRunIdRef.current) return;
			turnSettleIdleLastRunRef.current = undefined;
			setLatestTurnAutoCollapseTick((tick) => tick + 1);
		}, TURN_SETTLE_IDLE_COLLAPSE_MS);
		return clearIdle;
	}, [hasLiveRuntime, isRuntimeBusy, runtime?.agentId, runtime?.runtimeGeneration, sessionId]);

	// 轮数集中算一次供窗口判定用：reconciledRuns 在流式期间每帧重建，memo 只保证同一次渲染内不重复计数。
	const agentRunCount = useMemo(() => countAgentRunItems(reconciledRuns), [reconciledRuns]);
	const turnWindowActive = shouldWindowTimelineTurns(agentRunCount, turnWindowTurns);
	// 方案 C（2026-12）渐进扩展：把「窗口是否仍可扩展」同步给 controller 的滚动监听——
	// 接近窗口顶部且还有未挂载的已加载数据时，先自动扩窗口（本地 DOM，无网络往返），
	// 而不是一次性把整个历史窗口挂出来导致滚动条骤变。渲染期写 ref，
	// 与 ownerKeyRef 同模式；turnWindowActive 变化低频，不引发额外渲染。
	controller.windowExpandableRef.current = turnWindowActive;
	// 窗口轮数变化（上滚 3→6→9、点按钮扩大）会在顶部插入内容。
	// 钉的是扩窗前正在看的那一轮（controller.pinBrowseRow），不是整页 scrollHeight 差；
	// 数据翻页也走同一钉行；Markdown/图片后增高由内容 ResizeObserver 继续补漂移。
	const turnWindowStateRef = useRef<{ windowed: boolean; turns: number }>({
		windowed: false,
		turns: 0,
	});
	const pinBrowseRow = controller.pinBrowseRow;
	useLayoutEffect(() => {
		const prev = turnWindowStateRef.current;
		if (prev.windowed && prev.turns !== turnWindowTurns && !followingForTurnWindow) {
			pinBrowseRow();
		}
		turnWindowStateRef.current = {
			windowed: turnWindowActive,
			turns: turnWindowTurns,
		};
	}, [displayRuns, followingForTurnWindow, pinBrowseRow, turnWindowActive, turnWindowTurns]);
	// 文件修改由 SessionView 提取最近一轮并放在 composer 上方；时间线只负责渲染消息。
	// 时间线里已有用户图片才解析模型目录：原生看图时气泡不能显示视觉桥「转换中」。
	const hasUserImages = useMemo(() => activeMessages.some((message) => message.role === "user" && Boolean(message.images?.length)), [activeMessages]);
	const visionBridgeExpected = useSessionVisionBridgeExpected(sessionId, hasUserImages);
	// 生图轮的 user 消息（紧随其后带 imageGen meta 的 assistant 占位/结果）：参考图直接进
	// 供应商 image 参数，不走 LLM 视觉桥——必须禁用视觉桥 UI，否则参考图气泡会被误显示
	// 「转换中/视觉桥已查看」。普通带图消息（下一跳是非 imageGen assistant）不受影响；
	// 该判定对重启恢复的历史消息同样成立（落盘的 assistant 带 imageGen meta）。
	const imageGenUserMessageIds = useMemo(() => {
		const ids = new Set<string>();
		for (let i = 0; i < activeMessages.length - 1; i += 1) {
			const current = activeMessages[i];
			const next = activeMessages[i + 1];
			if (current.role === "user" && next.role === "assistant" && Boolean(next.meta?.imageGen)) {
				ids.add(current.id);
			}
		}
		return ids;
	}, [activeMessages]);
	const lastUserMessageId = useMemo(() => {
		for (let index = activeMessages.length - 1; index >= 0; index -= 1) {
			if (activeMessages[index].role === "user") {
				return activeMessages[index].id;
			}
		}
		return undefined;
	}, [activeMessages]);

	// Only show resend when last user message is followed by error/abort (not normal assistant)
	const resendableMessageIds = useMemo(() => {
		const ids = new Set<string>();
		for (let i = activeMessages.length - 1; i >= 0; i--) {
			const msg = activeMessages[i];
			if (msg.role !== "user") continue;
			let hasAbortOrError = false;
			for (let j = i + 1; j < activeMessages.length; j++) {
				const next = activeMessages[j];
				if (next.role === "user") break;
				if (next.role === "error") {
					hasAbortOrError = true;
					break;
				}
				if (next.role === "system") {
					const meta = next.meta as Record<string, unknown> | undefined;
					if (meta?.i18nKey === "app.abortRequested") {
						hasAbortOrError = true;
						break;
					}
				}
				if (next.role === "assistant" && next.text?.trim()) {
					// Only block if assistant completed normally (done marker); partial output may precede error
					const am = next.meta as Record<string, unknown> | undefined;
					if (am?.done === true || am?.stopReason) break;
					continue;
				}
			}
			if (hasAbortOrError) ids.add(msg.id);
			break;
		}
		return ids;
	}, [activeMessages]);

	const isAwaitingAssistant = Boolean(hasActiveConversation && !cancellingUi && isTurnRunning && activeMessages.at(-1)?.role !== "assistant");

	async function copySelectedMessages(selectedIds: Set<string>, kind: "text" | "markdown" | "image") {
		if (kind === "image") {
			try {
				// flushSync 同步提交 solid 全量渲染：createRoot 的渲染可被切片，rAF 两帧不保证已提交
				// （终审 P2）。提交后再等一帧让浏览器完成布局；timer 兜底「窗口最小化时 rAF 暂停」。
				flushSync(() => setMultiSelectExporting(true));
				await new Promise<void>((resolve) => {
					const timer = window.setTimeout(resolve, 32);
					requestAnimationFrame(() => {
						window.clearTimeout(timer);
						resolve();
					});
				});
				const { toBlob } = await import("html-to-image");
				const source = timelineRef.current?.querySelector(".message-list") as HTMLElement | null;
				if (!source) throw new Error("Timeline capture target is missing");

				const captureIds = getMultiSelectImageCaptureIds(reconciledRuns, selectedIds);
				const clone = source.cloneNode(true) as HTMLElement;
				for (const item of Array.from(clone.children)) {
					if (!(item instanceof HTMLElement)) continue;
					// 虚拟化的包装 div 没有 data-message-id：唯一 id 落在 data-solid-run-id / data-virtual-run-id 上。
					// 只认 dataset.messageId 会把包装层全部判成「未选中」删掉，导出空白图。
					const id = item.dataset.messageId ?? item.dataset.solidRunId ?? item.dataset.virtualRunId;
					if (!id || !captureIds.has(id)) item.remove();
				}
				clone.classList.add("multi-select-image-export");
				clone.style.width = `${Math.max(source.clientWidth, source.scrollWidth)}px`;
				clone.style.padding = "24px";
				clone.style.background = getComputedStyle(document.documentElement).getPropertyValue("--color-bg-panel") || "#fff";
				document.body.appendChild(clone);
				let blob: Blob | null = null;
				try {
					blob = await toBlob(clone, {
						pixelRatio: Math.min(2, window.devicePixelRatio || 1),
						backgroundColor: getComputedStyle(document.documentElement).getPropertyValue("--color-bg-panel") || undefined,
						filter: (node) => !(node instanceof HTMLElement) || (!node.classList.contains("turn-row-actions") && !node.classList.contains("user-turn-actions") && !node.classList.contains("copy-menu-popover")),
					});
				} finally {
					clone.remove();
				}
				if (!blob) throw new Error("Unable to capture selected messages as PNG");
				const written = await writeClipboardImage(blob);
				if (!written) throw new Error("Unable to write PNG to clipboard");
				props.onToast(t("copy.asImageCopied"));
			} catch (error) {
				props.onToast(t("copy.failed"));
				void window.piDesktop?.app.rendererLog("warn", "clipboard", "copy selected messages as image failed", error).catch(() => undefined);
			} finally {
				setMultiSelectExporting(false);
			}
			setMultiSelectOpen(false);
			return;
		}

		const selected = activeMessages.filter((message) => selectedIds.has(message.id)).sort((left, right) => left.timestamp - right.timestamp);
		if (!selected.length) return;

		const separator = "\n\n---\n\n";
		const content =
			kind === "text"
				? selected
						.map((message) => {
							// 多选复制也走与气泡/单条复制相同的展示折叠，不能让模型上下文 XML 漏出。
							let text = replaceExpandedRefBlocksWithLabels(message.text);
							text = text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
							text = text.replace(/<thinking>[\s\S]*?<\/thinking>/g, "");
							text = text.replace(/<skill\s+name="[^"]*"[^>]*>[\s\S]*?<\/skill>/gi, "");
							return stripMarkdown(text);
						})
						.join(separator)
				: selected.map((message) => replaceExpandedRefBlocksWithLabels(message.text)).join(separator);

		await navigator.clipboard.writeText(content);
		props.onToast(kind === "text" ? t("copy.asTextCopied") : t("copy.asMarkdownCopied"));
		setMultiSelectOpen(false);
	}

	// 虚拟化的两个判定函数必须是稳定引用：内联箭头每帧换引用，VirtualRunList 里 split 的
	// useMemo 会恒失效（每帧 O(n) 重算）。
	const virtualRunId = useCallback((item: RenderMessage) => renderMessageId(item) ?? "", []);
	const isAgentRunItem = useCallback((item: RenderMessage) => item.kind === "agent-run", []);
	// 与 renderRunItem 首行、VirtualRunList 的 entries 共用同一份「是否产出 DOM」判据：
	// 判定放宽会为空行多吃一条行距，收紧会把卡片从虚拟区静默丢掉（#401 评审）。
	const isRenderableItem = useCallback((item: RenderMessage) => isRenderableRunItem(item), []);
	// 恢复锚点 / 挂起跳转在途：这两条路径按 [data-message-id] 查 DOM，虚拟区外的行不在 DOM 里。
	// 交给 VirtualRunList 的 solid 模式（同一组件内整表真实渲染），不换组件类型 ——
	// 换类型会整棵卸载，heightsRef 的高度缓存丢失，恢复完成后按估值重排会跳位。
	const navBlocked = props.controller.navBlockingVirtualization;
	// 宿主插件按 entryId 导航：目标轮可能在虚拟区外（没有 DOM）。hook 派发渲染层事件，
	// 这里转给 controller.jumpToMessage——它会挂起 pendingJump 并整表真实渲染后精确落位。
	// 事件带 sessionId：插件刚 selectSession 时本组件可能还挂在旧会话，先存下来等切到位再跳。
	const revealRequestRef = useRef<{ entryId: string; sessionId: string; at: number } | null>(null);
	const controllerRef = useRef(props.controller);
	controllerRef.current = props.controller;
	useEffect(() => {
		// 单测的极简 window 只有定时器（没有 addEventListener）：没有监听能力时直接跳过。
		// 生产（Electron 渲染进程）一定有；不要在测试沙箱里造事件系统来迁就一个 effect。
		if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
		const handleReveal = (event: Event) => {
			const detail = (event as CustomEvent<{ entryId?: string; sessionId?: string }>).detail;
			if (!detail?.entryId) return;
			if (detail.sessionId && detail.sessionId !== sessionId) {
				revealRequestRef.current = { entryId: detail.entryId, sessionId: detail.sessionId ?? "", at: Date.now() };
				return;
			}
			revealRequestRef.current = null;
			controllerRef.current.jumpToMessage(detail.entryId);
		};
		window.addEventListener(REVEAL_TIMELINE_ENTRY_EVENT, handleReveal);
		// 事件只派发一次，不会自己追到新会话：切到位后重放一次。
		const pending = revealRequestRef.current;
		if (pending) {
			revealRequestRef.current = null;
			// 过期请求丢弃：用户之后手动切到目标会话时，不该被几秒前的插件导航拽走并高亮。
			if (pending.sessionId === sessionId && Date.now() - pending.at <= REVEAL_TIMELINE_ENTRY_TIMEOUT_MS) controllerRef.current.jumpToMessage(pending.entryId);
		}
		return () => window.removeEventListener(REVEAL_TIMELINE_ENTRY_EVENT, handleReveal);
	}, [sessionId]);

	const renderRunItem = (item: RenderMessage): ReactNode => {
		// 判定与 VirtualRunList 的 entries 同源（virtualTimelinePolicy.isRenderableRunItem）：
		// 虚拟区只为可渲染条目建包装 div，两边口径必须一致。
		if (!isRenderableItem(item)) return null;
		if (item.kind === "agent-run") {
			// Only an active model turn keeps its latest run live. Context
			// compaction happens after agent_end, so it must not fold the answer.
			// 2026-08 perf：身份判定（run id），不用 index/length——滚动窗口切片变化
			// 不翻转位置 props，memo 保持生效。busy 仍按「最后一条显示条目」判定
			// （用户发送后激活等待期不把已完成回答当 live，见组件内注释）。
			const isRunStreaming = isTurnRunning && item.id === lastDisplayedItemId;
			return (
				<TurnRow
					key={item.id}
					run={item}
					sessionId={sessionId}
					// 行头署名与后端一致：DSH 会话的回复标 dsh，而非 pi
					backend={session?.backend ?? "pi"}
					// ACP 会话的回复行头用工具自己的品牌 logo（分不清是哪个 CLI 就失去署名意义）
					acpToolId={session?.acpToolId}
					fresh={freshMessageIds.has(item.id)}
					topFresh={topFreshIds.has(item.id)}
					onPreviewImage={props.onPreviewImage}
					showThinking={props.showThinking}
					isStreaming={isRunStreaming}
					// 始终下发 live id（按 message id 命中）；勿绑 isRunStreaming，
					// 否则流结束而 History 未到时会提前卸思考步导致 remount dump。
					liveThinkingId={liveThinkingId}
					isRuntimeBusy={isRuntimeBusy}
					agentRunning={isRunStreaming}
					isLatestRun={item.id === lastDisplayedItemId}
					isLastAgentRun={item.id === latestAgentRunId}
					autoCollapseTick={item.id === latestAgentRunId ? latestTurnAutoCollapseTick : 0}
					onOpenExternal={props.onOpenExternal}
					onOpenFile={props.onOpenFile}
					onDiffFile={props.onDiffFile}
					onEditMessage={props.onEditMessage}
					onDeleteMessage={props.onDeleteMessage}
					onEnterMultiSelect={handleEnterMultiSelect}
					onFavoriteReply={handleFavoriteReply}
					favoritedMessageKeys={favoritedMessageKeys}
				/>
			);
		}
		if (item.kind !== "message") return null;
		const message = item.message;
		if (message.role === "user") {
			return (
				<UserBubble
					key={message.id}
					message={message}
					onRemoveMessageImage={props.onRemoveMessageImage}
					fresh={freshMessageIds.has(message.id)}
					topFresh={topFreshIds.has(message.id)}
					onPreviewImage={props.onPreviewImage}
					onOpenFile={props.onOpenFile}
					onResendUserMessage={props.onResendUserMessage}
					onEditMessage={props.onEditMessage}
					onDeleteMessage={props.onDeleteMessage}
					onForkMessage={props.onForkMessage}
					onRewindToMessage={props.onRewindToMessage}
					forking={props.forkingMessageId === message.id}
					agentRunning={isRuntimeBusy}
					isLastUserMessage={message.id === lastUserMessageId}
					showResendButton={resendableMessageIds.has(message.id)}
					validCommandNames={props.validCommandNames}
					validFilePaths={props.validFilePaths}
					onEnterMultiSelect={handleEnterMultiSelect}
					// 生图参考图永远不触发视觉桥（参考图直接进供应商 API）
					visionBridgeExpected={imageGenUserMessageIds.has(message.id) ? false : visionBridgeExpected}
				/>
			);
		}
		if (message.role === "error") {
			// 失败类消息与 toast 并存渲染诊断卡片：toast 即时提醒，卡片留痕可排查。
			return <DiagnosticMessageCard key={message.id} message={message} />;
		}
		if (message.role === "system") {
			const meta = message.meta && typeof message.meta === "object" ? (message.meta as { type?: string }) : undefined;
			if (meta?.type === "askQuestion") {
				// Pending extension UI is rendered once in the timeline footer.
				// Legacy in-memory messages may still contain this placeholder.
				return null;
			}
			// 扩展输出条目（pi appendEntry / type:"custom"）：主进程读侧投影的可见性补齐卡，
			// 不是回合边界，只让 /btw 这类扩展输出到达用户（issue #285）。
			if (meta?.type === "customEntry") {
				return <ExtensionEntryCard key={message.id} message={message} />;
			}
			// 扩展 custom 消息（pi custom_message 条目）：只有面向用户的通知类白名单
			// 才渲染成卡片（如子代理后台任务完成），其余（display:false 的内部上下文
			// 注入）保持不可见——但它们仍是回合边界（见 AppUtils 的 customMessage 分支）。
			if (meta?.type === "customMessage") {
				return shouldRenderNotifyCard(message) ? <NotifyMessageCard key={message.id} message={message} /> : null;
			}
			// 压缩摘要卡片已按产品决策下线（与 dsh 后端行为对齐）：
			// 压缩进行态由 RespondingIndicator「正在压缩」承担，压缩完成后
			// 时间线直接呈现保留消息。pi 投影出的 compaction system 消息
			// 仍会进入时间线数据（主进程继续维护），这里仅不渲染。
			if (meta?.type === "compaction") {
				return null;
			}
			// 重试成功卡是瞬态卡：连续重试每个周期各留一张，堆成一排「自动重试成功」很难看
			// （用户反馈）。成功由 toast 即时报告，这里不渲染。
			// 自动重试状态卡（含运行中/失败）已收进所属 agent-run 内部作为过程行
			// （groupToolMessages 的 retry-group 分支 → TurnRow RetryStep），
			// 留痕职责由过程行承担，不再在时间线顶层渲染独立大卡片——
			// 旧形态与工具时间线割裂且插在工具与后续回答之间（顺序错乱根因）。
			if (isRetryStatusMessage(message)) return null;
			// 系统诊断渲染卡片留痕（与 toast 并存，见 timelineFailureNotice）。
			return <DiagnosticMessageCard key={message.id} message={message} />;
		}
		return null;
	};

	return (
		<MessageScroller
			className={cn("message-timeline-host h-full min-h-0", !props.instantSessionSwitch && contentEntering && "timeline-content-enter")}
			viewportClassName="message-timeline"
			// 宽度约束落在内层 [role=log] 而非 scroller 宿主：视口撑满整个面板，
			// 原生滚动条贴面板最右侧；内容列仍与 composer 同宽居中（见 chatContentWidth）。
			contentProps={showSurfaceEmptyState ? undefined : { style: chatContentWidthStyle }}
			viewportRef={timelineRef}
			scrollApiRef={controller.scrollerScrollApiRef}
			followOutput={controller.autoScroll}
			followThreshold={56}
			smooth
			// busy 只驱动 aria-busy 和结束后的 150ms instant 窗口；流式增高是否弹簧
			// 由 MessageScroller 的 resize + 28px 阈值决定，不再整段忙碌硬贴底。
			busy={isRuntimeBusy || isAwaitingAssistant}
			onFollowChange={controller.setAutoScrollFromScroller}
			onUserScrollIntent={controller.setUserScrollIntent}
			viewportProps={{
				// 会话切换滚动位置保持：滚动时维护 per-session 锚点（rAF 合并，不触发渲染）
				onScroll: controller.handleTimelineScroll,
			}}
		>
			{(turnWindowActive || (hasMoreMessages && canLoadMoreMessages)) && (
				<div
					style={{
						display: "flex",
						justifyContent: "center",
						padding: "12px 0",
						borderBottom: "1px solid var(--border-color)",
					}}
				>
					<button
						onClick={() => {
							// 窗口裁剪生效时先扩大渲染窗口（显示已加载的更早内容）；
							// 窗口已覆盖全部已加载数据且还有历史时才翻数据页。
							// 数据翻页补偿（loadMoreAnchorRef）与窗口扩大补偿（turnWindowStateRef）
							// 发生在不同帧，不会双重补偿。
							if (turnWindowActive) {
								controller.expandWindow();
							} else if (hasMoreMessages && canLoadMoreMessages) {
								// 与滚动加载同一策略：新历史只出现在上方，视口不做「直接展示」跳动。
								loadMoreMessages("scroll");
							}
						}}
						disabled={isLoadingMoreMessages}
						style={{
							display: "inline-flex",
							alignItems: "center",
							gap: "6px",
							padding: "6px 16px",
							border: "1px solid var(--border-color)",
							borderRadius: "6px",
							background: "var(--bg-secondary)",
							color: "var(--text-primary)",
							fontSize: "13px",
							cursor: isLoadingMoreMessages ? "not-allowed" : "pointer",
							opacity: isLoadingMoreMessages ? 0.6 : 1,
							transition: "all 0.2s",
						}}
					>
						{isLoadingMoreMessages ? (
							// 加载动画：点击后立即出现，真正加载完成（finally 复位 isLoadingMessagePage）才消失
							<>
								<Loader2 className="size-3.5 animate-pideck-spin" aria-hidden="true" />
								{t("timeline.loadingMore")}
							</>
						) : (
							// 2026-12 统一文案：上滚窗口已由「接近顶部自动扩展」接管（无需再提示
							// 剩余已加载轮数），按钮统一为「加载更多对话」——窗口可扩时点击本地扩
							// 窗口，已挂满且有更早历史时点击翻页，对用户透明。
							t("timeline.loadMoreTurns")
						)}
					</button>
				</div>
			)}

			{/* 加载更多失败：按钮弹回却没有任何提示就是 2026-09 反馈的「点了没反应」。
			    这里出失败行（原始 IPC 文案放 title），按钮仍在，可直接再点重试。 */}
			{controller.loadMoreError && (
				<div className="flex flex-col items-center gap-1 px-6 pb-3 text-center">
					<p className="text-xs font-medium text-destructive">{t("timeline.loadMoreFailed")}</p>
					<p className="max-w-[560px] text-micro text-muted-foreground" title={controller.loadMoreError}>
						{t("timeline.loadMoreFailedHint")}
					</p>
				</div>
			)}

			{isConversationLoading && (
				<div className="history-loading">
					<div className="history-loading-placeholder">
						<div className="skeleton-bubble" />
						<div className="skeleton-line" />
						<div className="skeleton-line" />
						<div className="skeleton-line" />
					</div>
					<div className="history-loading-placeholder">
						<div className="skeleton-line" />
						<div className="skeleton-line" />
						<div className="skeleton-line" />
					</div>
					<div className="history-loading-placeholder">
						<div className="skeleton-line" />
						<div className="skeleton-line" />
					</div>
					<span
						style={{
							paddingTop: "16px",
							alignSelf: "center",
							fontSize: "var(--font-size-small)",
						}}
					>
						{t("app.historyLoading")}
					</span>
				</div>
			)}

			{/* 读盘失败终态：文件被删/路径失效/解析异常时不能无限滞留骨架，
          也不裸显示起始页误导——明确错误文案 + 重试（2026-08 生图会话文件缺失）。
          DSH host 被手动停止走下面的专态分支：DSH 会话没有 pi 会话文件，说成
          「文件可能已被删除」会把用户引向错误方向，而且重试永远无效。 */}
			{messageLoadState?.status === "error" && activeMessages.length === 0 && !dshHostStopped && !dshRuntimeMissing && !sessionFileMissing && (
				<div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
					<p className="text-sm font-medium">{t("timeline.loadFailed")}</p>
					<p className="max-w-[560px] text-xs text-muted-foreground">{t("timeline.loadFailedHint")}</p>
					{/* 解析/读取错误不等于文件丢失：直接展示原因，避免误导用户删除合法会话。 */}
					{messageLoadState.error && <p className="max-w-[560px] whitespace-pre-wrap break-all text-xs text-muted-foreground">{messageLoadState.error}</p>}
					<Button type="button" variant="outline" size="sm" onClick={() => void controller.reloadFromDisk()}>
						{t("common.retry")}
					</Button>
				</div>
			)}

			{/* DSH 手动停止专态：不是故障而是用户自己的选择（预热/按需兜底/崩溃重启全被
			    门控，不会自愈），所以主操作是「启动 host」而非只给重试；启动成功后
			    控制器自动重载历史，用户无感回到会话内容。 */}
			{messageLoadState?.status === "error" && activeMessages.length === 0 && dshHostStopped && (
				<div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
					<p className="text-sm font-medium">{t("timeline.dshHostStopped")}</p>
					<p className="max-w-[560px] text-xs text-muted-foreground">{t("timeline.dshHostStoppedHint")}</p>
					<div className="flex items-center gap-2">
						<Button type="button" size="sm" className="gap-1.5" disabled={startingDshHost} onClick={() => void startDshHostAndRetry()}>
							{startingDshHost ? <LoaderCircle className="size-3.5 animate-pideck-spin" aria-hidden="true" /> : <Power className="size-3.5" aria-hidden="true" />}
							{t("timeline.dshHostStoppedStart")}
						</Button>
						<Button type="button" variant="outline" size="sm" onClick={() => void controller.reloadFromDisk()}>
							{t("common.retry")}
						</Button>
					</div>
				</div>
			)}

			{/* DSH 运行时未安装专态：与手动停止分开——点「启动 host」修不好这件事，缺的是 runtime
			    资源本身，恢复路径在「设置 → DSH」，所以这里只给提示 + 重试。 */}
			{messageLoadState?.status === "error" && activeMessages.length === 0 && dshRuntimeMissing && (
				<div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
					<p className="text-sm font-medium">{t("timeline.dshRuntimeMissing")}</p>
					<p className="max-w-[560px] text-xs text-muted-foreground">{t("timeline.dshRuntimeMissingHint")}</p>
					<Button type="button" variant="outline" size="sm" onClick={() => void controller.reloadFromDisk()}>
						{t("common.retry")}
					</Button>
				</div>
			)}

			{/* 空会话（文件尚未创建）专态：只说「还没有内容」+ 怎么产生内容，不展示 ENOENT，
			    也不渲染起始页——新建会话/外部连接会话打开时就应该是这一屏。 */}
			{messageLoadState?.status === "error" && activeMessages.length === 0 && sessionFileMissing && (
				<div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
					<p className="text-sm font-medium">{t("timeline.emptySessionFile")}</p>
					<p className="max-w-[560px] text-xs text-muted-foreground">{t("timeline.emptySessionFileHint")}</p>
					<Button type="button" variant="outline" size="sm" onClick={() => void controller.reloadFromDisk()}>
						{t("common.retry")}
					</Button>
				</div>
			)}

			{!hasActiveConversation && <EmptyState hasProject={props.hasProject} onCreate={props.onCreateSession} />}

			{hasActiveConversation && !isConversationLoading && activeMessages.length === 0 && !sessionFileMissing && <SessionStartSurface sessionId={sessionId} />}

			{/* 长会话渲染治理：
          - 不再使用 content-visibility 估算高度（展开工具会抖）。
          - 学 Proma：总折叠压缩单行 DOM；另在贴底时只挂尾部 N 个 agent-run
            （见 turnRenderWindow），上滚放开。分页仍做数据窗口治理。 */}
			{hasActiveConversation && !isConversationLoading && activeMessages.length > 0 && (
				<div className="message-list min-w-0 w-full mx-auto transition-opacity duration-fast" onContextMenu={messageContextMenu.handleContextMenu}>
					{/* 阈值在 VirtualRunList 内部判：父层切组件类型会在 8→9 轮时整表卸载（#401 评审） */}
					{/* 多选导出按 DOM 克隆整表，而 MultiSelectModal 的候选是全量 reconciledRuns：
					    期间必须把「窗口裁剪后的 displayRuns」换成全量，否则窗口外选中的消息没有 DOM，
					    clone 过滤会把它当未选中删掉（导出缺内容）。关闭后保留全量渲染，直到回底或重新开多选。 */}
					<VirtualRunList
						runs={multiSelectOpen || retainFullRuns ? reconciledRuns : displayRuns}
						scrollRef={timelineRef}
						renderRun={renderRunItem}
						getRunId={virtualRunId}
						isAgentRun={isAgentRunItem}
						isRenderable={isRenderableItem}
						solid={navBlocked || multiSelectExporting}
						onBeforeScrollCorrection={controller.markProgrammaticScroll}
					/>

					{hasActiveConversation && !cancellingUi && isRuntimeBusy && (
						<RespondingIndicator isCompacting={isCompacting} isStarting={activeConversationStatus === "starting"} isExecutingTool={activeRuntimeState?.isExecutingTool} executingToolName={activeRuntimeState?.executingToolName} liveTextStreaming={liveTextStreaming} liveThinkingStreaming={liveThinkingStreaming} />
					)}
					{props.replyActionsRef ? <div key={sessionId} ref={props.replyActionsRef} data-session-id={sessionId} data-testid="session-reply-actions-target" className="min-w-0 empty:hidden" /> : null}
				</div>
			)}

			{/* 时间线内的 Ask 通道只服务于并行问询浮层（AskPanelOverlay / OwnedSessionMessageTimeline）；
			    主会话栏的阻塞式 Ask 已改由 SessionView 钉在对话区下方（issue #230），不再走这里。
			    这里仍用正常流布局而不是 sticky/z-index，避免覆盖最后一条工具调用或回答。 */}
			{props.runtimeUi ? <div className="session-runtime-ui mx-auto w-full min-w-0 empty:hidden">{props.runtimeUi}</div> : null}

			{/* 发送定位垫片：让长历史下的新消息即使尚未有足够自然内容，也能平滑到视口顶部。 */}
			<div aria-hidden="true" data-send-scroll-spacer="true" className="shrink-0" />

			{multiSelectOpen && <MultiSelectModal renderedRuns={reconciledRuns} onClose={() => setMultiSelectOpen(false)} onCopy={copySelectedMessages} />}

			{/* 消息右键菜单：portal 到 body、fixed 定位在右键坐标（见 MessageContextMenu） */}
			<MessageContextMenu state={messageContextMenu.state} onCopy={messageContextMenu.copy} onSelectAll={messageContextMenu.selectAll} onFavorite={messageContextMenu.favorite} onClose={messageContextMenu.close} />

			{/* 划选引用浮层：portal 到 body，fixed 定位；空会话起始页无消息不出现 */}
			{!showSurfaceEmptyState && sessionId && <SelectionToolbar quote={selectionQuote} sessionId={sessionId} onConsume={clearSelectionQuote} toolbarRef={selectionToolbarRef} />}
		</MessageScroller>
	);
}
