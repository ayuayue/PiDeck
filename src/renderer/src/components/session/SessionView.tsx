import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject, type ReactNode } from "react";
import { type GroupImperativeHandle, type PanelImperativeHandle } from "react-resizable-panels";
import { ResizablePanel, ResizablePanelGroup } from "../ui-shadcn/resizable";
import type { ChatMessage, GitBranchInfo, ImageContent, TerminalTarget, TerminalThemeId } from "../../../../shared/types";
import type { SessionTimelineController } from "../../hooks/useSessionTimelineController";
import { isLanWeb, desktopApi as api } from "../../desktopApi";
import { SessionHeader } from "./SessionHeader";
import { SessionBranchBar } from "./SessionBranchBar";
import { SessionGoalStrip } from "./SessionGoalStrip";
import { SessionSubagentsStrip } from "./SessionSubagentsStrip";
import { SessionTodoStrip } from "./SessionTodoStrip";
import { SessionTeamStrip } from "./SessionTeamStrip";
import { SessionQueuedMessagesStrip } from "./SessionQueuedMessagesStrip";
import { SessionSurfaceStage } from "./SessionSurfaceStage";
import { ComposerArea } from "./ComposerArea";
import type { SessionMenuModel, SessionMenuRunControl } from "./SessionActionsMenu";
import { useReplyActions } from "../../hooks/useReplyActions";
import { useAnimationWindow } from "../../hooks/useAnimationWindow";
import { chatContentWidthStyle } from "./chatContentWidth";
import { TerminalDockPanel, TERMINAL_PANEL_COLLAPSED_SIZE, TERMINAL_PANEL_MIN_SIZE } from "../terminal/TerminalDockPanel";
import type { TerminalDockSettings } from "../terminal/TerminalDock";
import { useSessionPaneServices } from "./SessionPaneServices";
import { COMPOSER_MAX_HEIGHT, COMPOSER_MIN_HEIGHT, TIMELINE_MIN_HEIGHT, displayProjectDirectoryName, redistributeTerminalAgainstTimeline, shouldMountBottomComposer, sessionResizableGroupKey, sessionGroupDefaultLayout } from "../../rendererUtils";
import { projectByIdAtomFamily, sessionRecordByIdAtomFamily, sessionStatusInSidebarAtomFamily } from "../../atoms";
import type { EnqueuePromptSnapshot } from "../../hooks/useSessionSend";
import { countUserTurns } from "./timeline/turnRenderWindow";

// terminal 程序化布局保护窗口（ms）：setLayout 后该窗口内的 terminal
// onResize 一律视为程序化结果，不写 collapsed 状态。
const TERMINAL_PROGRAMMATIC_PROTECT_MS = 250;

export type SessionViewProps = {
	// ── Session identity ──
	sessionId: string;
	sessionTitle: string;
	sessionTimeline: SessionTimelineController;
	/** 分屏栏：加边框与点击聚焦；单栏 Tab 已外置，同样只渲染 Header */
	splitPane?: boolean;
	focused?: boolean;
	onFocusPane?: () => void;
	activeAgentId?: string;
	activeAgent?: {
		noSession?: boolean;
		status?: string;
	} | null;
	hasActiveConversation: boolean;
	hasProject: boolean;

	// ── Layout refs ──
	chatHeaderRef: RefObject<HTMLDivElement | null>;
	composerRef: RefObject<HTMLElement | null>;
	composerOffsetHeight: number;
	terminalRowHeight: number;

	// ── Header 状态 ──
	isAgentStarting: boolean;
	isRestarting: boolean;
	/** 本栏运行控制快照：会话头部快捷钮用；分屏两栏各算各的。 */
	runControl?: SessionMenuRunControl;
	/** 会话头部「⋯」菜单（原 Tab 栏菜单）：会话操作 / 代理 / 工具开关。 */
	menu?: SessionMenuModel;
	sessionDuration?: number;

	// ── Timeline interaction ──
	showThinking: boolean;
	validCommandNames: Set<string>;
	validFilePaths: Set<string>;
	onPreviewImage: (image: ImageContent) => void;
	onOpenFile?: (path: string) => void;
	onDiffFile?: (path: string) => void;
	onResendUserMessage?: (message: ChatMessage) => void;
	onEditMessage?: (message: ChatMessage, newText: string) => void;
	onDeleteMessage?: (messageId: string, entryId?: string) => void;
	onRemoveMessageImage?: (message: ChatMessage, index: number) => void;
	onForkMessage?: (message: ChatMessage) => void;
	onRewindToMessage?: (message: ChatMessage) => void;
	forkingMessageId?: string | null;
	onToast: (message: string) => void;
	onQuickPrompt?: (prompt: string) => void;
	canMutateActiveMessages: boolean;
	/** 分支导航条：打开兄弟/父/子分支会话（SessionRuntimeInjector 装配 openSidebarSessionById） */
	onOpenBranchSession?: (sessionId: string) => void;

	// ── Composer ──
	enqueueSessionPrompt: (sessionId: string, snapshot: EnqueuePromptSnapshot) => boolean;
	gitInfo?: GitBranchInfo;
	/** 底栏分支下拉的切换回调（透传给 ComposerArea，owner 为 App 级 switchBranch） */
	onSwitchBranch?: (branch: string) => void;
	ensureSessionId?: (sessionId: string) => Promise<string>;
	queuePanel?: ReactNode;
	/** 当前是否有待回答的阻塞式 Ask（与 SessionRuntimeUiOverlay 同代判据）。 */
	askPanelVisible?: boolean;
	runtimeUi?: ReactNode;

	// ── Terminal dock ──
	terminalDockVisible: boolean;
	terminalOpen: boolean;
	terminalDockClosing: boolean;
	terminalCollapsed: boolean;
	availableTerminalHeight: number;
	/** 终端归属键（agent:<id> / project:<id>）：状态回写与 dock 实例隔离都按它 */
	terminalOwnerKey?: string;
	/** agent 或 project 终端目标；undefined 时不渲染 dock */
	terminalTarget?: TerminalTarget;
	setTerminalOpenForOwner: (open: boolean) => void;
	setTerminalCollapsedForOwner: (collapsed: boolean) => void;
	/** 回写终端分屏高度（全局单份，hook 内部持久化） */
	setTerminalHeight: (height: number) => void;
	/** 终端外观设置（App 级单份，随 AppSettings 持久化） */
	terminalSettings: TerminalDockSettings;
	/** dock 内主题菜单写回设置 */
	onTerminalThemeChange: (themeId: TerminalThemeId) => void;

	// ── Other visibility ──
	settingsOpen: boolean;
	environmentDialog: boolean;

	// ── Session actions ──
	runCreateSessionDraft: () => void;
	abortAgent: () => void;
};

export function SessionView({
	sessionId,
	sessionTitle,
	sessionTimeline,
	splitPane = false,
	focused = true,
	onFocusPane,
	activeAgentId,
	activeAgent,
	hasActiveConversation,
	hasProject,
	chatHeaderRef,
	composerRef,
	composerOffsetHeight: _composerOffsetHeight,
	terminalRowHeight,
	isAgentStarting,
	isRestarting,
	runControl,
	menu,
	sessionDuration,
	showThinking,
	validCommandNames,
	validFilePaths,
	onPreviewImage,
	onOpenFile,
	onDiffFile,
	onResendUserMessage,
	onEditMessage,
	onDeleteMessage,
	onRemoveMessageImage,
	onForkMessage,
	onRewindToMessage,
	forkingMessageId,
	onToast,
	onQuickPrompt,
	canMutateActiveMessages: _canMutateActiveMessages,
	onOpenBranchSession,
	enqueueSessionPrompt,
	gitInfo,
	onSwitchBranch,
	ensureSessionId,
	queuePanel,
	askPanelVisible = false,
	runtimeUi,
	terminalDockVisible,
	terminalOpen,
	terminalDockClosing,
	terminalCollapsed,
	availableTerminalHeight,
	terminalOwnerKey,
	terminalTarget,
	setTerminalOpenForOwner,
	setTerminalCollapsedForOwner,
	setTerminalHeight,
	terminalSettings,
	onTerminalThemeChange,
	settingsOpen,
	environmentDialog,
	runCreateSessionDraft,
	abortAgent: _abortAgent,
}: SessionViewProps) {
	const paneServices = useSessionPaneServices();
	// 落点随本栏时间线挂载/卸载更新；发送控制器仍只有 ComposerArea 内的一份。
	const [replyActionsTarget, setReplyActionsTarget] = useState<HTMLDivElement | null>(null);
	// 回复快捷操作规则：全局一份快照（主进程读 userData/reply-actions.json），
	// SessionReplyActions 只读；保存入口在设置页，保存后整份替换 atom。
	// 只取 items（规则数组），避免整个 hook 返回值每渲染变引用拖累下游 memo。
	const { items: replyActionRuleItems } = useReplyActions();
	// 会话身份面包屑的项目名：多 Tab/分屏时提醒当前会话属于哪个项目。
	// 从会话记录解析 projectId → 项目目录名；无记录（匿名会话等）时省略。
	const sessionRecord = useAtomValue(sessionRecordByIdAtomFamily(sessionId));
	const project = useAtomValue(projectByIdAtomFamily(sessionRecord?.projectId ?? ""));
	const projectName = project ? displayProjectDirectoryName(project) : undefined;
	// 垂直轴只分两段：时间线列（对话 + 固有高度输入栏）| 终端。
	// 输入栏不再占 Group 百分比——窗口缩放时时间线吸收全部余量，待办/改文件
	// 条随内容撑开，放大后由 CSS max-height 自动恢复，不依赖 hug/setLayout。
	const terminalPanelRef = useRef<PanelImperativeHandle | null>(null);
	const sessionGroupRef = useRef<GroupImperativeHandle | null>(null);
	const terminalProgrammaticExpireRef = useRef(0);
	// 折叠/展开动画窗口：terminalCollapsed 翻转后短暂给面板挂 flex-grow 过渡，
	// 让程序化 setLayout 有 160ms 高度渐变；拖拽时属性不在，直接操作不橡皮筋。
	const terminalCollapseAnimating = useAnimationWindow(terminalCollapsed, 200);

	const terminalPanelVisible = !isLanWeb && !settingsOpen && !environmentDialog && terminalDockVisible && terminalOpen;
	// 空会话磁盘就绪后卸底部栏，改由 timeline 内 SessionStartSurface 居中输入。
	const bottomComposerVisible = shouldMountBottomComposer({
		hasActiveConversation,
		messageCount: sessionTimeline.messages.length,
		isConversationLoading: sessionTimeline.isSurfaceLoading,
	});
	// 右侧边栏「会话状态」面板正可见地展示本会话时，输入框上方的待办/子代理折叠条让位给面板
	//（文件修改已改由每轮末尾的 chip 行走轮次上下文，不再经过面板与 latestAgentRun）。
	const statusInSidebar = useAtomValue(sessionStatusInSidebarAtomFamily(sessionId));
	const sessionPanels = { terminal: terminalPanelVisible };
	const timelineColumnMinSize = bottomComposerVisible ? TIMELINE_MIN_HEIGHT + COMPOSER_MIN_HEIGHT : TIMELINE_MIN_HEIGHT;
	const timelineColumnStyle = {
		"--session-timeline-min": `${TIMELINE_MIN_HEIGHT}px`,
	} as CSSProperties;
	// Ask 底栏与 composer 互斥分高（issue #230 定案，2026-12 用户拍板 B：卡片接管列底）：
	// ask 可见时 composer 通过 max-height:0 + overflow-hidden 坍缩到零高，而不是卸载——
	// 粘贴转文件的 chip 删盘动作在 composer 的卸载路径上会丢失（orphan 临时文件），
	// 草稿/附件虽在 atom 里，仍以「不卸载」为更强约束。
	// 因此两者不会同时占高；不设固定像素上限（用户反馈：别限我的卡片高度），
	// 上限就是「列高 - 对话区保底」，正常情况下卡片不会被截断，超长才内部滚动兜底。
	const askMaxHeight = `calc(100% - var(--session-timeline-min, ${TIMELINE_MIN_HEIGHT}px))`;
	const composerMaxHeight = askPanelVisible ? "0px" : `min(${COMPOSER_MAX_HEIGHT}px, calc(100% - var(--session-timeline-min, ${TIMELINE_MIN_HEIGHT}px)))`;

	// 时间线 props 稳定化（2027-02 性能审计）：这里原先每渲染新建对象 + 内联
	// onOpenExternal 箭头，打穿 SessionMessageTimeline → TurnRow → MarkdownStream
	// 的整条 memo 链——SessionView 任何无关重渲染（agent 状态、待办条、header 等）
	// 都会让全部已挂载轮次的 settled 文本全量重解析（streamdown 只缓存 processor、
	// 不缓存解析结果，重渲染 = 重新 parse + sanitize + 重建元素树）。
	// 回调 useCallback、props 对象 useMemo 之后，链上 memo 才真正生效。
	const handleOpenExternal = useCallback((url: string, forceSystem?: boolean) => api.app.openExternal(url, forceSystem), []);
	const timelineInteractionProps = useMemo(
		() => ({
			instantSessionSwitch: paneServices.simpleNavigation,
			hasProject,
			onCreateSession: runCreateSessionDraft,
			showThinking,
			validCommandNames,
			validFilePaths,
			onPreviewImage,
			onOpenExternal: handleOpenExternal,
			onOpenFile,
			onDiffFile,
			onResendUserMessage,
			onEditMessage,
			onDeleteMessage,
			onRemoveMessageImage,
			onForkMessage,
			onRewindToMessage,
			forkingMessageId,
			onToast,
			onQuickPrompt,
			replyActionsRef: setReplyActionsTarget,
		}),
		[
			paneServices.simpleNavigation,
			hasProject,
			runCreateSessionDraft,
			showThinking,
			validCommandNames,
			validFilePaths,
			onPreviewImage,
			handleOpenExternal,
			onOpenFile,
			onDiffFile,
			onResendUserMessage,
			onEditMessage,
			onDeleteMessage,
			onRemoveMessageImage,
			onForkMessage,
			onRewindToMessage,
			forkingMessageId,
			onToast,
			onQuickPrompt,
		],
	);

	// 终端 Panel 随 terminalOpen 动态挂载，约束注册有一帧延迟。
	// 折叠/展开用稳态读数 + setLayout：差额全部给 timeline，输入栏不在 Group 里。
	useEffect(() => {
		const panel = terminalPanelRef.current;
		if (!panel) return;
		const frame = requestAnimationFrame(() => {
			try {
				terminalProgrammaticExpireRef.current = Date.now() + TERMINAL_PROGRAMMATIC_PROTECT_MS;
				const terminalSize = terminalPanelRef.current?.getSize();
				if (!terminalSize || terminalSize.inPixels <= 0 || terminalSize.asPercentage <= 0) return;
				const groupPx = (terminalSize.inPixels / terminalSize.asPercentage) * 100;
				const terminalTargetPx = terminalCollapsed ? TERMINAL_PANEL_COLLAPSED_SIZE : Math.max(TERMINAL_PANEL_MIN_SIZE, Math.min(terminalRowHeight, availableTerminalHeight));
				const terminalPct = Math.min(100, (terminalTargetPx / groupPx) * 100);
				const layout = sessionGroupRef.current?.getLayout();
				if (!layout || layout.timeline === undefined || layout.terminal === undefined) return;
				const next = redistributeTerminalAgainstTimeline(layout, terminalPct, (timelineColumnMinSize / groupPx) * 100);
				if (next) sessionGroupRef.current?.setLayout(next);
			} catch {
				/* 约束未就绪，下轮状态再同步 */
			}
		});
		return () => cancelAnimationFrame(frame);
	}, [availableTerminalHeight, terminalCollapsed, terminalDockVisible, terminalOpen, terminalRowHeight, timelineColumnMinSize]);

	return (
		<div className={splitPane ? `session-split-pane flex h-full min-h-0 flex-col${focused ? " session-split-pane-focused" : ""}` : "contents"} onMouseDown={splitPane ? () => onFocusPane?.() : undefined}>
			{/* Tab 栏已统一外置；本栏头部显示会话状态徽章、分屏身份标题与运行控制工具条。 */}
			{(!paneServices.simpleNavigation || splitPane) && (
				<SessionHeader
					headerRef={chatHeaderRef}
					statusSessionId={sessionId}
					title={sessionTitle}
					projectName={projectName}
					paneTitle={splitPane ? sessionTitle : undefined}
					onExitSplit={splitPane ? () => paneServices.exitSessionSplit(sessionId) : undefined}
					isAnonymous={activeAgent?.noSession}
					duration={sessionDuration}
					isStarting={isAgentStarting}
					runControl={runControl}
					menu={menu}
				/>
			)}
			{/* 分支导航条：仅当当前会话存在 fork 分支关系（父/兄弟/子分支）时显示 */}
			<SessionBranchBar sessionId={sessionId} onOpenSession={onOpenBranchSession} />
			<ResizablePanelGroup
				// 面板数只随终端挂载变化：输入栏在时间线列内，不再改变 Group 面板数。
				key={`${sessionId}:${sessionResizableGroupKey(sessionPanels)}`}
				orientation="vertical"
				className="session-v-group"
				data-terminal-collapse-anim={terminalCollapseAnimating || undefined}
				groupRef={sessionGroupRef}
				defaultLayout={sessionGroupDefaultLayout(sessionPanels, terminalCollapsed ? TERMINAL_PANEL_COLLAPSED_SIZE : terminalRowHeight, Math.max(1, window.innerHeight - 120))}
				resizeTargetMinimumSize={{ fine: 20, coarse: 24 }}
			>
				<ResizablePanel id="timeline" minSize={timelineColumnMinSize} className="session-v-timeline flex min-h-0 flex-col" style={timelineColumnStyle}>
					<div className="session-v-timeline-stage min-h-[var(--session-timeline-min,160px)] flex-1 overflow-hidden">
						<SessionSurfaceStage sessionId={sessionId} sessionTimeline={sessionTimeline} isRestarting={isRestarting} isReloading={Boolean(runControl?.isReloading)} timelineProps={timelineInteractionProps} />
					</div>
					{/* 阻塞式 Ask 底栏（issue #230）：与输入框同级钉在对话区下方，
					    不再随时间线滚动——用户上翻看历史时提问卡仍常驻可见，不必再往下找。
					    宽度基准与消息列/输入框同源（chatContentWidthStyle + scrollbar-gutter 槽位），
					    内容超「列高 - 对话区保底」时由本层滚动（时间线仍是唯一的消息滚动 owner）。
					    必须用 askPanelVisible 而不是仅 runtimeUi 门控：overlay 无 pending 时返回 null，
					    只看 runtimeUi 会留下一条空白底栏。 */}
					{runtimeUi && askPanelVisible ? (
						<div className="session-v-ask min-h-0 shrink-0 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]" style={{ maxHeight: askMaxHeight }} aria-live="polite">
							<div className="pb-2" style={chatContentWidthStyle}>
								{runtimeUi}
							</div>
						</div>
					) : null}
					{/* 有消息或仍在加载：列底固有高度输入栏。空会话就绪后卸掉，改由起始页居中输入。
              max-height 相对本列：窗口放大后上限抬起，待办/改文件条随内容恢复，不锁死像素。 */}
					{bottomComposerVisible && (
						<div
							className="session-v-composer flex min-h-0 shrink-0 flex-col overflow-hidden [scrollbar-gutter:stable]"
							style={{
								maxHeight: composerMaxHeight,
							}}
							// 坍缩到 0px 时必须同时 inert + aria-hidden：否则看不见的编辑器仍可被 Tab/点击命中，
							// 用户会往一个不可见的输入框里打字（React 19 支持 inert 属性）。
							inert={askPanelVisible}
							aria-hidden={askPanelVisible || undefined}
						>
							<ComposerArea
								ref={composerRef}
								sessionId={sessionId}
								turnCount={countUserTurns(sessionTimeline.messages)}
								gitInfo={gitInfo}
								onSwitchBranch={onSwitchBranch}
								enqueue={enqueueSessionPrompt}
								ensureSessionId={ensureSessionId}
								queuePanel={queuePanel}
								widgets={
									<>
										<SessionQueuedMessagesStrip sessionId={sessionId} />
										{!statusInSidebar && <SessionTodoStrip sessionId={sessionId} />}
										<SessionTeamStrip sessionId={sessionId} />
										{/* 「修改的文件」已改为每轮末尾的 chip 行（TurnFileChanges），
										    不再作为 composer 上方的常驻卡片：它属于本轮结论，而不是下一轮的输入。
										    右侧状态面板的「文件」tab 也已移除，那条链路（含会话级 IPC）整体下线。 */}
										{!statusInSidebar && <SessionSubagentsStrip sessionId={sessionId} onOpenChildSession={onOpenBranchSession} />}
										<SessionGoalStrip sessionId={sessionId} />
									</>
								}
								replyActionMessages={sessionTimeline.messages}
								replyActionRules={replyActionRuleItems}
								replyActionsTarget={replyActionsTarget}
								replyActionsBlocked={askPanelVisible || isRestarting || isAgentStarting || sessionTimeline.isSurfaceLoading}
							/>
						</div>
					)}
				</ResizablePanel>

				{terminalPanelVisible && (
					<TerminalDockPanel
						target={terminalTarget}
						panelRef={terminalPanelRef}
						open={terminalOpen}
						closing={terminalDockClosing}
						collapsed={terminalCollapsed}
						height={terminalRowHeight}
						maxHeight={availableTerminalHeight}
						terminal={api.terminal}
						terminalSettings={terminalSettings}
						onThemeChange={onTerminalThemeChange}
						ownerKey={terminalOwnerKey}
						isProgrammaticResize={() => Date.now() < terminalProgrammaticExpireRef.current}
						onOpenChange={setTerminalOpenForOwner}
						onCollapsedChange={setTerminalCollapsedForOwner}
						onHeightChange={setTerminalHeight}
					/>
				)}
			</ResizablePanelGroup>
		</div>
	);
}
