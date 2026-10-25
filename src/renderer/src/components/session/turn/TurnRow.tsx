import { messageEntryId } from "../../../utils/sessionCommands";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronUp, Clock, Share, SquarePen, Star, Trash } from "lucide-react";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { selectAtom } from "jotai/utils";
import type { AgentBackend, ChatMessage, ImageContent } from "../../../../../shared/types";
import { liveTextActiveBySessionAtom, newTurnCollapseTickBySessionIdAtomFamily, runStepsVisibleMemoryBySessionIdAtomFamily, sendPinAnimatingBySessionIdAtomFamily, type RunStepsVisibleMemoryEntry } from "../../../atoms/session-atoms";
import { timelineRevealRequestsAtom, type TimelineRevealRequest } from "../../../atoms/timeline-reveal-atoms";
import { turnFlowSettingsAtom } from "../../../atoms/app-ui-atoms";
import { t } from "../../../i18n";
import { useStreamSelectionPreserve } from "../../../hooks/useStreamSelectionPreserve";
import { Button } from "../../ui-shadcn/button";
import { Collapsible, CollapsibleContent } from "../../ui-shadcn/collapsible";
import { formatDuration } from "../TimelineFormat";
import { LiveDuration } from "../LiveDuration";
import { CopyMenu, stripMarkdown } from "../SurfaceComponents";
import { favoriteMessageKey } from "../../favorites/favoriteIdentity";
import { buildTurnDisplay, hasFoldableContent } from "../timeline/buildTurnDisplay";
import { groupTurnProcess, lastProcessGroup } from "../timeline/groupTurnProcess";
import { boundMountedSteps, TIMELINE_MOUNTED_STEP_LIMIT } from "../timeline/turnMountBudget";
import { resolveLiveInterimId } from "../timeline/liveMount";
import { buildProcessSummary } from "../timeline/segmentSummary";
import { pickEditableAssistantMessage, visibleAssistantText } from "../timeline/editableAnswerTarget";
import type { AgentRunItem, MessageItem } from "../timeline/types";
import { sameAgentRunForRender } from "../../app/AppUtils";
import { runContainsMessage } from "../timeline/runMessageLookup";
import { FinalAnswer } from "./FinalAnswer";
import { InterimAnswer } from "./InterimAnswer";
import { ProcessFold } from "./ProcessFold";
import { ProcessSummaryToggle } from "./ProcessSummaryToggle";
import { useProcessGroupOpenState } from "./useProcessGroupState";
import { TurnAuthorHeader } from "./TurnAuthorHeader";
import { ThinkingStep } from "./ThinkingStep";
import { RetryStep } from "./RetryStep";
import { ErrorStep } from "./ErrorStep";
import { ToolStep } from "./ToolStep";
import { ExtensionEntryStep } from "./ExtensionEntryStep";
import { TurnFileChanges } from "./TurnFileChanges";
import { useTurnExecution } from "./useTurnExecution";
import type { DiffFileHandler } from "../ToolCallComponents";

/** sessionId 为空时的占位 atom：恒 false（无会话不挂 live）。 */
const NO_LIVE_TEXT_ATOM = atom(false);
/** sessionId 为空时的占位 atom：恒 0（无会话不订阅新一轮信号）。 */
const NO_TURN_TICK_ATOM = atom(0);
/** sessionId 为空时的占位 atom：恒 false（无会话不订阅发送置顶动画标记）。 */
const NO_SEND_PIN_ANIMATING_ATOM = atom(false);
/** sessionId 为空时的占位 atom：恒 undefined（无会话不订阅展开记忆）。 */
const NO_STEPS_MEMORY_ATOM = atom<RunStepsVisibleMemoryEntry | undefined>(undefined);
/** sessionId 为空时的占位 atom：恒 undefined（无会话不订阅跳转揭示请求）。 */
const NO_REVEAL_REQUEST_ATOM = atom<TimelineRevealRequest | undefined>(undefined);

/**
 * 一轮 AI 回答的扁平容器：左侧竖线聚合，内含思考/工具/回答。
 *
 * 展示语义（与用户确认）：
 * - 唯一「执行过程」折叠汇总按钮（run 开头，纯数字）；
 * - 思考/工具/中间回答原位穿插，共用一个 run 级折叠开关；
 * - 最终回答常驻、永不折叠；
 * - 流式中自动展开（实时滚出），run 结束后展开执行过程（2026-12：会话结束展开工具调用，
 *   取代旧的 1.5s 自动收起；历史已完成轮保持折叠）。
 *
 * Live 正文由 InterimAnswer(mode=live) → AnswerOutput 订阅 atom，本组件不订 streaming store。
 */
export type TurnRowProps = {
	run: AgentRunItem;
	/** 所属会话 id（转交给 live InterimAnswer） */
	sessionId?: string;
	/** 运行时后端（pi/dsh）：决定行头回复者署名；缺省 "pi"（旧调用方兼容） */
	backend?: AgentBackend;
	/** ACP 工具 id（会话记录绑定）：行头按它显示对应 CLI 的品牌 logo，缺省回退通用终端图标。 */
	acpToolId?: string;
	/** 新消息入场动画：仅发送后尾部新增的消息播放一次 */
	fresh?: boolean;
	/** 上滚窗口扩展时顶部新增的轮次：播放「从顶部淡入」过渡（2026-12 体验优化） */
	topFresh?: boolean;
	onPreviewImage: (image: ImageContent) => void;
	showThinking?: boolean;
	isStreaming?: boolean;
	/** 当前 live 思考段稳定 id（msg-thinking-*），交给 buildTurnDisplay 同身份挂载 */
	liveThinkingId?: string;
	onOpenExternal: (url: string) => void;
	onOpenFile?: (path: string, line?: number) => void;
	onDiffFile?: DiffFileHandler;
	onResendUserMessage?: (message: never) => void;
	onEditMessage?: (message: ChatMessage, newText: string) => void;
	onDeleteMessage?: (messageId: string, entryId?: string) => void;
	/** 当前模型回合活跃时为 true，驱动正文/过程的 live 渲染与完成判定。 */
	agentRunning?: boolean;
	/** 会话 runtime 仍被占用（如压缩）；仅阻止会改写历史的操作，不把已结束回答重置为 live。 */
	isRuntimeBusy?: boolean;
	/** 是否时间线最新一轮（非最新不自动收起） */
	isLatestRun?: boolean;
	/** 是否为时间线上最后一个 agent-run（live 正文挂载门：仅它可挂会话级流式槽） */
	isLastAgentRun?: boolean;
	/** 最新轮结束后的自动收起信号（timeline 1.5s idle 计时） */
	autoCollapseTick?: number;
	/** 自动收起真实发生后回调（timeline 据此定位本轮起始消息） */
	onAutoCollapsed?: () => void;
	/** 打开多选分享弹框 */
	onEnterMultiSelect?: () => void;
	/** 收藏/取消收藏本轮回复（正文为 Markdown 源码快照 + 该轮最终消息 id）；不传则不渲染星标按钮。 */
	onFavoriteReply?: (text: string, messageId: string | null) => void;
	/** 已收藏的「会话::消息」键集合：星标据此显示实心（已收藏）状态。 */
	favoritedMessageKeys?: ReadonlySet<string>;
};

export const TurnRow = memo(function TurnRow(props: TurnRowProps) {
	const { run } = props;
	const rowRef = useRef<HTMLElement | null>(null);
	// 流式期间保持划选（MarkdownStream 每帧重渲染会挤掉浏览器选区，见 hook 头注释）。
	// 挂在本轮容器上：live 正文与 settled 正文都在 rowRef 内，流式 churn 与 settle 换树都能覆盖。
	useStreamSelectionPreserve(rowRef);
	const [editing, setEditing] = useState(false);
	const [editText, setEditText] = useState("");
	const editAreaRef = useRef<HTMLDivElement | null>(null);
	// 激活编辑时自动滚动到编辑区（避免 textarea 超出可视区域）
	useEffect(() => {
		if (editing && editAreaRef.current) {
			editAreaRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
		}
	}, [editing]);

	const isComplete = run.endedAt > 0;
	// 结束判定不能依赖 isComplete：groupToolMessages 里 endedAt 永远是最后一条消息时间戳，
	// 流式 run 也有空骨架消息（message_start/thinking 时创建），因此流式中 isComplete 恒为 true。
	// 真实语义：agentRunning 期间（仅末轮）由 LiveDuration 实时计时，agent 空闲后才显示固定值。
	const isRunLive = Boolean(props.agentRunning);
	// 回复耗时扣除本轮 ask_question 的等待：等待段由主进程从工具 durationMs 中排除，
	// 这里把等价量从轮时长里减去，含义为「agent 实际处理时长」。
	const effectiveStart = run.startedAt + (run.askWaitMs ?? 0);
	const duration = isComplete && effectiveStart > 0 ? Math.max(0, run.endedAt - effectiveStart) : 0;
	// 耗时：结束后固定（endedAt - startedAt - ask 等待）；流式中（isRunLive）由 LiveDuration 实时增长；
	// 轮被 ask_question 阻塞时冻结在提问弹起时刻（时间不再计入）。
	const showDuration = (isComplete && !isRunLive && duration > 0) || (isRunLive && effectiveStart > 0);

	// 扁平展示序列：Live 与 History 共用 msg-thinking-* 身份（liveThinkingId 命中即挂步）。
	const displayItems = useMemo(
		() =>
			buildTurnDisplay(run, {
				showThinking: props.showThinking,
				isComplete: !props.agentRunning,
				liveThinkingId: props.liveThinkingId,
			}),
		[run, props.showThinking, props.agentRunning, props.liveThinkingId],
	);

	const processSummary = useMemo(() => buildProcessSummary(displayItems), [displayItems]);
	const showProcessToggle = hasFoldableContent(displayItems);

	// 流式中最后一条中间回答 id（Live 挂载锚点）。
	const lastInterimId = useMemo(() => {
		let last: string | undefined;
		for (const item of displayItems) {
			if (item.kind === "interim-answer") last = item.id;
		}
		return last;
	}, [displayItems]);

	// 末条 Live 正文：挂在折叠容器外常显（避免 Radix Collapsible 卸载/收起导致无 DOM）。
	// 要求「存在活动正文流」且「本轮是最后一个 agent-run」才挂 live：
	// - 中间回复 message_end 后槽删（streaming=false）立即落回容器内 settled，
	//   消除双失明消失窗口（live 读空 + 容器内被跳过）；
	// - 被 steer 打断的旧轮尾部是空文本 interim（骨架挂载点），若允许旧轮挂 live，
	//   新一轮流式时旧轮会把会话槽里的新一轮正文再打印一遍——同一中间回复前后双份
	//   （2026-08 回归：判定逻辑见 resolveLiveInterimId，按轮级门控）。
	// 流式期间 content 每 50ms 变化但 streaming 不变 → 派生 boolean 引用稳定 → 零额外重渲染。
	const liveTextActive = useAtomValue(props.sessionId ? liveTextActiveBySessionAtom(props.sessionId) : NO_LIVE_TEXT_ATOM);
	const liveInterimId = useMemo(() => {
		const last = displayItems.find((item) => item.kind === "interim-answer" && item.id === lastInterimId);
		if (!last || last.kind !== "interim-answer") return undefined;
		return resolveLiveInterimId({
			sessionId: props.sessionId,
			lastInterimId,
			liveTextActive,
			lastMessageText: last.message.text,
			agentRunning: props.agentRunning,
			isStreaming: props.isStreaming,
			isLastAgentRun: props.isLastAgentRun,
		});
	}, [props.sessionId, props.agentRunning, props.isStreaming, props.isLastAgentRun, lastInterimId, displayItems, liveTextActive]);

	// live plain 卸下 → settled Markdown 挂上：只给刚卸下的那条 id 打一次 settle 淡入。
	const prevLiveIdRef = useRef<string | undefined>(undefined);
	const [settleId, setSettleId] = useState<string | undefined>(undefined);
	useEffect(() => {
		const prev = prevLiveIdRef.current;
		const next = liveInterimId;
		if (prev && !next) {
			setSettleId(prev);
			const timer = window.setTimeout(() => setSettleId(undefined), 320);
			prevLiveIdRef.current = next;
			return () => window.clearTimeout(timer);
		}
		prevLiveIdRef.current = next;
		return undefined;
	}, [liveInterimId]);

	// run 级折叠状态（一个开关控制全部思考/工具/中间回答步骤）
	// hasFinalAnswer：无最终回答的 run 不自动展开（中间回答是唯一输出，不能被折叠隐藏）
	const hasFinalAnswer = displayItems.some((item) => item.kind === "final-answer");
	// 流式对话行为设置（App 同步写入）+ 新一轮信号（composer 发送成功后 bump）。
	// 设置变化低频；tick 经 atomFamily selectAtom 隔离，跨会话 bump 不触发本行重渲染。
	const flowSettings = useAtomValue(turnFlowSettingsAtom);
	const newTurnCollapseTick = useAtomValue(props.sessionId ? newTurnCollapseTickBySessionIdAtomFamily(props.sessionId) : NO_TURN_TICK_ATOM);
	// 发送置顶动画进行中：此时收起上一轮会让上方内容骤缩，视口先向上再向下（见 useTurnExecution）。
	const sendPinAnimating = useAtomValue(props.sessionId ? sendPinAnimatingBySessionIdAtomFamily(props.sessionId) : NO_SEND_PIN_ANIMATING_ATOM);
	// 执行过程展开状态跨挂载记忆（run 级）：切会话再切回时恢复手动/流式展开的
	// 轮次；selectAtom 按 run.id 取值，同会话其它 run 变化不重渲染本行。
	const stepsVisibleMemoryAtom = useMemo(() => (props.sessionId ? selectAtom(runStepsVisibleMemoryBySessionIdAtomFamily(props.sessionId), (map) => map[run.id] ?? undefined, Object.is) : NO_STEPS_MEMORY_ATOM), [props.sessionId, run.id]);
	const stepsVisibleMemory = useAtomValue(stepsVisibleMemoryAtom);
	const setRunStepsMemoryAtom = useSetAtom(runStepsVisibleMemoryBySessionIdAtomFamily(props.sessionId ?? ""));
	const onStepsVisibleMemoryChange = useCallback(
		(visible: boolean | undefined, atTick: number) => {
			const runId = run.id;
			if (!props.sessionId || !runId) return;
			setRunStepsMemoryAtom((prev) => {
				const next = { ...prev };
				if (visible === undefined) delete next[runId];
				else next[runId] = { visible, atTick };
				return next;
			});
		},
		[props.sessionId, run.id, setRunStepsMemoryAtom],
	);
	const { stepsVisible, setStepsVisibleFromUser, toggleSteps } = useTurnExecution({
		runId: run.id,
		agentRunning: props.agentRunning,
		isComplete,
		hasFinalAnswer,
		isLatestRun: props.isLatestRun,
		expandInterimDuringStream: flowSettings.expandInterimDuringStream,
		newTurnCollapseTick,
		sendPinAnimating,
		autoCollapseTick: props.autoCollapseTick,
		onAutoCollapsed: props.onAutoCollapsed,
		stepsVisibleMemory,
		onStepsVisibleMemoryChange,
	});

	// 跳转揭示请求：目标消息（会话内查找/跨会话搜索的命中）属于本轮时展开执行过程折叠栏，
	// 让折叠区里的中间回答/工具节点挂载出来——已完成轮默认折叠，Radix 收起会整块卸载，
	// controller 只扩轮次窗口永远挂不出这些节点，旧行为最后只能弹「未能跳转」。
	// nonce 只认变化：同一目标重复点击也生效；请求表按会话分格，别的会话的变化不重渲染本行。
	const revealSessionId = props.sessionId;
	const revealRequestAtom = useMemo(() => (revealSessionId ? selectAtom(timelineRevealRequestsAtom, (requests) => requests[revealSessionId], Object.is) : NO_REVEAL_REQUEST_ATOM), [revealSessionId]);
	const revealRequest = useAtomValue(revealRequestAtom);
	const lastRevealNonceRef = useRef<number | undefined>(undefined);
	useEffect(() => {
		if (!revealRequest || revealRequest.nonce === lastRevealNonceRef.current) return;
		if (!runContainsMessage(run, revealRequest.messageId)) return;
		lastRevealNonceRef.current = revealRequest.nonce;
		setStepsVisibleFromUser(true);
	}, [revealRequest, run, setStepsVisibleFromUser]);

	// 中间内容（思考/工具/中间回答）与最终回答分组：
	// 中间内容统一收进执行过程折叠容器（stepsVisible 整体控制显隐），
	// 最终回答留在容器外常驻、永不折叠。
	const foldableItems = useMemo(() => displayItems.filter((item) => item.kind !== "final-answer"), [displayItems]);
	const finalItems = useMemo(() => displayItems.filter((item) => item.kind === "final-answer"), [displayItems]);
	// 单轮步骤挂载预算（2026-08 #213）：极端轮次（单轮上百个工具/思考条目）默认只挂尾部
	// LIMIT 条，顶部给「显示更早 N 条步骤」入口——每点一次把挂载下界向前挪一批（batches +1）。
	// 下界锚在首次点击时的条目总数上：之后尾部追加新步骤不会把已展开的旧条目挤回去。
	// 用 run.id 判定「已展开」状态：换 run 自然重置，不需要额外 effect。
	const [expandedSteps, setExpandedSteps] = useState<{ runId: string; anchor: number; batches: number } | undefined>(undefined);
	const stepExpansion = expandedSteps?.runId === run.id ? expandedSteps : undefined;
	const mountedSteps = useMemo(() => boundMountedSteps(foldableItems, TIMELINE_MOUNTED_STEP_LIMIT, stepExpansion), [foldableItems, stepExpansion]);

	/* ── 过程组模式（processGroupDisplay；关闭时走下面原有的扁平渲染） ──
	 * 纯函数把扁平序列切成「中间回复 / 过程组 / 一级行」交替序列（见 timeline/groupTurnProcess.ts）。
	 * 手风琴语义（与用户确认）：
	 * - 大折叠栏展开时，自动槽指向**最新**的那个过程组；
	 * - 出现新组 → 槽位推进 → 上一个自动组随之关闭；用户手动打开的组不受影响；
	 * - 大折叠栏关闭 → 两通道一起清空。组内卡片的展开态不需要额外代码：Radix 折叠时
	 *   子树整体卸载（children: isOpen && children），组件内部 state 随之销毁。
	 */
	const processNodes = useMemo(() => groupTurnProcess(displayItems), [displayItems]);
	const latestProcessGroupId = useMemo(() => lastProcessGroup(processNodes)?.id, [processNodes]);
	const { groupState: processGroupState, toggleGroup: toggleProcessGroup, syncLatestGroup: syncLatestProcessGroup, reset: resetProcessGroups } = useProcessGroupOpenState(props.sessionId, run.id);
	useEffect(() => {
		if (!flowSettings.processGroupDisplay) return;
		if (!stepsVisible) {
			resetProcessGroups();
			return;
		}
		syncLatestProcessGroup(latestProcessGroupId);
	}, [flowSettings.processGroupDisplay, stepsVisible, latestProcessGroupId, resetProcessGroups, syncLatestProcessGroup]);

	// 收集本轮所有 assistant 消息（按 run.items 的时序保持原始顺序）
	const assistantMessages = run.items.filter((item): item is MessageItem => item.kind === "message" && item.message.role === "assistant");
	const allImages: ImageContent[] = [];
	for (const item of assistantMessages) {
		if (item.message.images) allImages.push(...item.message.images);
	}
	// 合并后的完整文本仅用于复制等操作栏（复制整轮输出），不得作为编辑初值（issue #310）
	const mergedText = assistantMessages
		.map((item) => visibleAssistantText(item.message.text))
		.filter(Boolean)
		.join("\n\n");
	const containsImageGen = assistantMessages.some((item) => Boolean(item.message.meta?.imageGen));
	// 编辑目标与编辑初值同源：最后一条有可见正文的 assistant 消息，加载/保存/按钮显隐都指向它
	const editableMessage = pickEditableAssistantMessage(assistantMessages);
	// 收藏身份与右键菜单同源（会话 + 消息 id）：星标显示实心即表示这条回复已在收藏里，再点即取消。
	const replyMessageId = editableMessage?.message.id ?? null;
	const replyFavoriteKey = replyMessageId ? favoriteMessageKey(props.sessionId ?? null, replyMessageId) : null;
	const replyFavorited = replyFavoriteKey ? (props.favoritedMessageKeys?.has(replyFavoriteKey) ?? false) : false;
	// 本轮回答用的模型（逐轮展示）：取本轮最后一条带模型信息的 assistant 消息。
	// 同一会话内用户会频繁换模型，只有逐轮记录才能看出哪段是谁答的；
	// 旧数据/ACP 会话没有该字段时留空，行头不占位。
	// 本轮模型名：取最后一条带 model 的 assistant 消息（同轮内一般同源），显示在底部耗时行。
	let turnModel: ChatMessage["model"];
	for (let index = assistantMessages.length - 1; index >= 0 && !turnModel; index -= 1) {
		turnModel = assistantMessages[index]?.message.model;
	}
	// 只在本轮结束后显示：流式期间模型名跟着正文一起长出来，既干扰阅读也像「已经定稿」的断言；
	// 回看历史轮用的是哪个模型只关心定论，故与固定耗时（showDuration 的非 live 分支）同一时机出现。
	const showTurnModel = !isRunLive && Boolean(turnModel);

	// 本轮没有任何可渲染内容时不输出空容器
	if (displayItems.length === 0 && allImages.length === 0) return null;

	const startEditing = () => {
		// 只加载编辑目标自身的正文；mergedText 聚合了中间回复，当初值会在原样保存时把
		// 中间回复重复写进末条 entry（issue #310），禁止回退到聚合初值
		setEditText(visibleAssistantText(editableMessage?.message.text ?? ""));
		setEditing(true);
	};
	const saveEdit = () => {
		if (editableMessage && props.onEditMessage) {
			props.onEditMessage(editableMessage.message, editText);
			setEditing(false);
		}
	};
	const deleteMessage = () => {
		const targetId = assistantMessages.at(-1)?.message.id;
		if (targetId) props.onDeleteMessage?.(targetId, messageEntryId(assistantMessages.at(-1)?.message));
	};

	return (
		<article ref={rowRef} className={`turn-row mb-6 w-full min-w-0 max-w-full ${props.agentRunning && !isComplete ? "turn-row--running" : isComplete ? "turn-row--complete" : "turn-row--pending"} ${props.fresh ? "turn-row--fresh" : ""} ${props.topFresh ? "turn-row--top-fresh" : ""}`} data-message-id={run.id}>
			<div className="flex min-w-0 flex-col gap-3">
				{/* 行头：头像 + Pi/DSH 署名 + 时间。耗时与本轮模型名都不放行头——回复生成时用户视线在底部，
				    统一显示在 turn 尾部（见底部耗时行），不用翻回开头看跑了多久、用的是哪个模型。 */}
				<TurnAuthorHeader backend={props.backend} acpToolId={props.acpToolId} endedAt={run.endedAt} />

				{/* 执行过程折叠栏：中间内容（思考/工具/中间回答）统一收进容器，
				    由 stepsVisible 整体控制显隐；最终回答在容器外常驻。
				    学 Proma ProcessBlockGroup：CollapsibleContent 自带高度过渡动画，
				    折叠/展开是 scrollHeight 高度渐变而非 display:none 突变。 */}
				{showProcessToggle && (
					<Collapsible
						className="execution-summary"
						open={stepsVisible}
						// Radix 传入目标 open；必须 set 而非 toggle，否则受控更新会把状态打反。
						onOpenChange={setStepsVisibleFromUser}
					>
						<ProcessSummaryToggle summary={processSummary} expanded={stepsVisible} onToggle={toggleSteps} />
						<CollapsibleContent className="execution-summary-details">
							{flowSettings.processGroupDisplay ? (
								<ProcessFold
									nodes={processNodes}
									stepsVisible={stepsVisible}
									agentRunning={props.agentRunning}
									showThinking={props.showThinking}
									sessionId={props.sessionId}
									liveInterimId={liveInterimId}
									groupState={processGroupState}
									onToggleGroup={toggleProcessGroup}
									onOpenFile={props.onOpenFile}
									onOpenExternal={props.onOpenExternal}
									onCollapse={toggleSteps}
								/>
							) : (
								<>
									{/* 折叠挂载策略（2026-09 主流实践，按轮状态分场景）：
							    1. 非流式轮（agentRunning=false，含历史已结束轮）折叠时**完全卸载**内容——
							       历史默认折叠，滚动经过几十轮只携带折叠头 + 最终回答，
							       单轮 500 条工具调用时省下海量 DOM；展开时全量挂载。
							    2. live 流式轮（agentRunning=true）折叠时仍保持挂载（display:none）——
							       卸载会重置打字机动画状态，恢复展开时思考/工具重播。
							    代价：Radix 高度渐变动画在历史轮退化为瞬时展开/收起。 */}
									{(stepsVisible || props.agentRunning === true) && mountedSteps.hiddenCount > 0 && (
										// 超出挂载预算的早期步骤入口：与 execution-summary-toggle 同款观感，
										// 用 Tailwind utility 对齐旧 CSS 的 token（不新增手写 class）。
										<button
											type="button"
											className="mt-1 inline-flex h-[26px] items-center gap-2 self-start rounded-[var(--radius-md)] border border-border-subtle bg-[var(--color-chat-card-bg)] px-3 text-chat-detail font-medium text-text-secondary transition-colors hover:border-border-strong hover:bg-bg-hover hover:text-text-primary"
											onClick={() => setExpandedSteps((prev) => (prev?.runId === run.id ? { ...prev, batches: prev.batches + 1 } : { runId: run.id, anchor: foldableItems.length, batches: 1 }))}
											title={t("timeline.showEarlierSteps", { count: Math.min(TIMELINE_MOUNTED_STEP_LIMIT, mountedSteps.hiddenCount) })}
										>
											<ChevronUp size={12} aria-hidden="true" />
											<span>{t("timeline.showEarlierSteps", { count: Math.min(TIMELINE_MOUNTED_STEP_LIMIT, mountedSteps.hiddenCount) })}</span>
										</button>
									)}
									{(stepsVisible || props.agentRunning === true) &&
										mountedSteps.items.map((item) => {
											let content: ReactNode;
											let itemKey: string;
											if (item.kind === "process-entry") {
												itemKey = item.entry.id;
												if (item.entry.kind === "thinking-entry") {
													content = <ThinkingStep group={item.entry.group} hidden={!stepsVisible} showThinking={props.showThinking} onOpenExternal={props.onOpenExternal} onOpenFile={props.onOpenFile} />;
												} else if (item.entry.kind === "retry-entry") {
													// 自动重试过程行：与工具/思考同层，失败红、运行中旋转（见 RetryStep 注释）
													content = <RetryStep group={{ kind: "retry-group", id: item.entry.id, message: item.entry.message }} hidden={!stepsVisible} />;
												} else if (item.entry.kind === "error-entry") {
													// 错误诊断过程行：429 等错误并入工具调用，可点开看具体错误（见 ErrorStep 注释）
													content = <ErrorStep group={{ kind: "error-group", id: item.entry.id, message: item.entry.message }} hidden={!stepsVisible} />;
												} else if (item.entry.kind === "extension-entry") {
													// 扩展输出行（平铺路径）：无流式状态，隐藏时直接卸载即可
													content = stepsVisible ? <ExtensionEntryStep messages={item.entry.messages} /> : null;
												} else {
													content = <ToolStep group={item.entry.group} hidden={!stepsVisible} stopped={props.agentRunning !== true} sessionId={props.sessionId} onOpenFile={props.onOpenFile} />;
												}
											} else if (item.kind === "interim-answer") {
												itemKey = item.id;
												// Live 末条在折叠容器外渲染，此处跳过以免双份。
												if (item.id === liveInterimId) return null;
												content = (
													<InterimAnswer
														mode="settled"
														text={item.message.text}
														hidden={!stepsVisible}
														isStreaming={false}
														settle={settleId === item.id}
														// 折叠区内一律 process：正文已与最终回答同尺寸，process 只负责 my-3 间距。
														// 无最终回答的末段也要这段间距，否则会贴着上方工具行。
														variant="process"
														// 中间回复引用锚点：settled 正文根节点带 data-message-id，划选可解析来源消息。
														messageId={item.id}
														onOpenExternal={props.onOpenExternal}
														onOpenFile={props.onOpenFile}
													/>
												);
											} else {
												// final-answer 不在此容器内（见下方常驻区），此处仅兜底跳过
												return null;
											}
											return <Fragment key={itemKey}>{content}</Fragment>;
										})}
									{/* 收起按钮：固定在折叠容器末尾（不再是动态跟随） */}
									{stepsVisible && (
										<button type="button" className="execution-summary-collapse" onClick={toggleSteps} title={t("common.collapse")}>
											<ChevronUp size={12} aria-hidden="true" />
											<span>{t("common.collapse")}</span>
										</button>
									)}
								</>
							)}
						</CollapsibleContent>
					</Collapsible>
				)}

				{/* Live 正文：折叠容器外常显，确保流式 DOM 可采样、不被 Collapsible 卸载 */}
				{liveInterimId && props.sessionId && <InterimAnswer mode="live" sessionId={props.sessionId} hidden={false} isStreaming={Boolean(props.isStreaming || props.agentRunning || liveInterimId)} onOpenExternal={props.onOpenExternal} onOpenFile={props.onOpenFile} />}

				{/* 最终回答：本轮最后一条 assistant 文本，常驻、永不折叠 */}
				{finalItems.map((item) => (
					<div key={item.id} data-final-answer={run.id} data-message-id={item.id}>
						<FinalAnswer
							message={item.message}
							images={allImages}
							isStreaming={props.isStreaming ?? false}
							settle={settleId === item.id}
							editing={editing}
							editText={editText}
							editAreaRef={editAreaRef}
							onEditTextChange={setEditText}
							onStartEdit={startEditing}
							onCancelEdit={() => setEditing(false)}
							onSaveEdit={saveEdit}
							onPreviewImage={props.onPreviewImage}
							onOpenExternal={props.onOpenExternal}
							onOpenFile={props.onOpenFile}
						/>
					</div>
				))}

				{/* 本轮产物：修改的文件 chip 行（左缩进对齐正文列，虚线分隔）。
				    位置对齐 Proma：正文之后、操作栏之前——「改了哪些文件」属于本轮结论，
				    而非下一轮的输入（旧实现在 composer 上方的常驻卡片里，与轮次脱节）。
				    流式中不渲染：文件列表还在长，逐条冒出来会让正文区持续抖动。 */}
				<TurnFileChanges run={run} streaming={isRunLive || Boolean(props.isStreaming)} onOpenFile={props.onOpenFile} onDiffFile={props.onDiffFile} />

				{/* 操作栏 + 尾部耗时/模型：合并为同一行，耗时与模型排在行末（少占一行高度）。
				    耗时：回复生成中由 LiveDuration 实时计时（100ms 连续跳动，用户视线在底部），
				    回复结束后固定为总耗时。全轮只有一个耗时显示点（行头只留时间戳），
				    避免开头结尾重复；无最终回答的轮（纯工具/思考）只有耗时、无按钮，同样可见。
				    本轮模型名跟在耗时之后（同一行同一层）：回看历史轮用的是哪个模型时视线不用翻回行头。
				    透明度：半透明降噪（hover/focus-within 恢复）必须盖住整行——按钮图标与行末耗时/模型同一层，
				    否则出现「图标偏淡、数字偏深」的割裂观感；无按钮时不降噪（没有需要弱化的交互件）。
				    ask_question 等待回答期间不增长：冻结在提问弹起时刻，等待不计入处理耗时。 */}
				{((mergedText && !editing) || showDuration || showTurnModel) && (
					<div className={`flex min-h-6 items-center gap-1${mergedText && !editing ? " opacity-55 transition-opacity hover:opacity-100 focus-within:opacity-100" : ""}`}>
						{mergedText && !editing && (
							<>
								{!containsImageGen && <CopyMenu text={stripMarkdown(mergedText)} markdown={mergedText} targetRef={rowRef} />}
								{/* 收藏整轮回复：与复制同源（Markdown 源码），快照落本机收藏页；入口不依赖编辑权限。
								    已收藏显示实心星（与右键菜单同一身份），再点即取消。 */}
								{props.onFavoriteReply && (
									<Button
										type="button"
										variant="ghost"
										size="icon-sm"
										className="turn-row-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
										aria-pressed={replyFavorited}
										onClick={() => props.onFavoriteReply?.(mergedText, replyMessageId)}
										title={replyFavorited ? t("favorites.unsaveMessage") : t("favorites.saveMessage")}
										aria-label={replyFavorited ? t("favorites.unsaveMessage") : t("favorites.saveMessage")}
									>
										<Star size={14} className={replyFavorited ? "fill-current" : undefined} />
									</Button>
								)}
								<Button type="button" variant="ghost" size="icon-sm" className="turn-row-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" onClick={props.onEnterMultiSelect} title={t("app.multiSelectEnter")}>
									<Share size={14} />
								</Button>
								{!props.isStreaming && !props.isRuntimeBusy && editableMessage?.message.id && (
									<>
										{props.onEditMessage && (
											<Button type="button" variant="ghost" size="icon-sm" className="turn-row-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" onClick={startEditing} title={t("common.edit")}>
												<SquarePen size={14} />
											</Button>
										)}
										{props.onDeleteMessage && (
											<Button type="button" variant="ghost" size="icon-sm" className="turn-row-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" onClick={deleteMessage} title={t("common.delete")}>
												<Trash size={14} />
											</Button>
										)}
									</>
								)}
							</>
						)}
						{showDuration && (
							/* 图标尺寸 14 对齐同行按钮图标（原独占一行时是 12）；
							   pl-[7px] 等于 size-7 按钮里 14px 图标的水平内缩量：时钟与前一个按钮图标的间距
							   7+gap-1+7 与按钮之间的一致，不再比按钮之间更近。 */
							<div className="flex items-center gap-1.5 pl-[7px] text-muted-foreground">
								<Clock size={14} className="shrink-0" aria-hidden="true" />
								{/* 耗时数字与行头时间一致用界面字体（见 TurnAuthorHeader 注释）；tabular-nums 保持跳动不抖 */}
								<span className="text-body leading-none tabular-nums">{isRunLive && run.askPending ? formatDuration(Math.max(0, (run.askPendingAt ?? effectiveStart) - effectiveStart)) : isRunLive ? <LiveDuration startedAt={effectiveStart} isStreaming /> : formatDuration(duration)}</span>
							</div>
						)}
						{showTurnModel && turnModel && (
							/* 本轮实际使用的模型（provider + modelId）跟在耗时后面：同一会话内用户会频繁换模型，
							   只在输入框显示当前模型不足以回看历史轮；流式中不显示，回复结束才落定。
							   做成小标签而不是同号纯文本：左边耗时是读数（text-body + 等宽数字），
							   模型名是名字，同色同号时两段会连成一句「2m18s global:xxx」读不断。
							   模型名长短不一（如 global:deepseek-v4.1-flash），限宽截断 + title 给全量 provider/model，
							   不让长名字把行末撑开或换行。 */
							<span className="ml-1 min-w-0 max-w-[16rem] truncate rounded-sm bg-muted/60 px-1.5 py-0.5 text-chat-detail font-medium leading-none text-muted-foreground" title={`${turnModel.provider}/${turnModel.modelId}`} data-turn-model={turnModel.modelId}>
								{turnModel.modelId}
							</span>
						)}
					</div>
				)}
			</div>
		</article>
	);
}, turnRowPropsEqual);

/**
 * TurnRow 自定义 memo 比较（阶段 0：历史 run 跳过重渲染）。
 *
 * 比较项：
 * - run：深度比较内容（sameAgentRunForRender），未变化的 run 不重渲染；
 * - 标量 props（backend/fresh/showThinking/isStreaming/liveThinkingId/agentRunning/isRuntimeBusy）：=== 比较；
 * - onOpenFile：栏级 cwd/project 变化时引用会更新，必须参与比较，否则历史工具按钮会继续调用旧栏上下文；
 * - 其余回调函数（onPreviewImage/onOpenExternal/onDiffFile/onEditMessage/onDeleteMessage/
 *   onEnterMultiSelect）：行为稳定（读 ref/setState），引用变化不影响渲染结果，忽略（同 FinalAnswer 惯例）。
 */
function turnRowPropsEqual(prev: TurnRowProps, next: TurnRowProps): boolean {
	// 流式 run：Live AnswerOutput 随 atom 更新；父级仍需在 isStreaming 边沿重渲染折叠态。
	if (prev.isStreaming || next.isStreaming) return false;
	if (!sameAgentRunForRender(prev.run, next.run)) return false;
	return (
		prev.sessionId === next.sessionId &&
		prev.backend === next.backend &&
		prev.fresh === next.fresh &&
		prev.topFresh === next.topFresh &&
		prev.showThinking === next.showThinking &&
		prev.liveThinkingId === next.liveThinkingId &&
		prev.agentRunning === next.agentRunning &&
		prev.isRuntimeBusy === next.isRuntimeBusy &&
		prev.isLatestRun === next.isLatestRun &&
		prev.isLastAgentRun === next.isLastAgentRun &&
		prev.autoCollapseTick === next.autoCollapseTick &&
		// 收藏表变化才换引用（时间线 useMemo）：已收藏态变了星标要重绘，未变时保持记忆化。
		prev.favoritedMessageKeys === next.favoritedMessageKeys &&
		prev.onOpenFile === next.onOpenFile
	);
}
