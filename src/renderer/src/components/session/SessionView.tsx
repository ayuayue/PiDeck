import { useAtomValue } from "jotai";
import { useEffect, useMemo, useRef, type CSSProperties, type RefObject, type ReactNode } from "react";
import {
  type GroupImperativeHandle,
  type PanelImperativeHandle,
} from "react-resizable-panels";
import {
  ResizablePanel,
  ResizablePanelGroup,
} from "../ui-shadcn/resizable";
import type { GitBranchInfo, ImageContent, TerminalTarget } from "../../../../shared/types";
import type { SessionTimelineController } from "../../hooks/useSessionTimelineController";
import { isLanWeb, desktopApi as api } from "../../desktopApi";
import { SessionHeader } from "./SessionHeader";
import { SessionBranchBar } from "./SessionBranchBar";
import { SessionFilesStrip } from "./SessionFilesStrip";
import { SessionGoalStrip } from "./SessionGoalStrip";
import { SessionSubagentsStrip } from "./SessionSubagentsStrip";
import { SessionTodoStrip } from "./SessionTodoStrip";
import { SessionSurfaceStage } from "./SessionSurfaceStage";
import { ComposerArea } from "./ComposerArea";
import { TerminalDockPanel, TERMINAL_PANEL_COLLAPSED_SIZE, TERMINAL_PANEL_MIN_SIZE } from "../terminal/TerminalDockPanel";
import { useSessionPaneServices } from "./SessionPaneServices";
import {
  COMPOSER_MAX_HEIGHT,
  COMPOSER_MIN_HEIGHT,
  TIMELINE_MIN_HEIGHT,
  displayProjectDirectoryName,
  redistributeTerminalAgainstTimeline,
  shouldMountBottomComposer,
  sessionResizableGroupKey,
  sessionGroupDefaultLayout,
} from "../../rendererUtils";
import { projectByIdAtomFamily, sessionRecordByIdAtomFamily } from "../../atoms";
import type { EnqueuePromptSnapshot } from "../../hooks/useSessionSend";
import { groupToolMessages } from "../app/AppUtils";
import type { AgentRunItem } from "./timeline/types";
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
  sessionDuration?: number;

  // ── Timeline interaction ──
  showThinking: boolean;
  validCommandNames: Set<string>;
  validFilePaths: Set<string>;
  onPreviewImage: (image: ImageContent) => void;
  onOpenFile?: (path: string) => void;
  onDiffFile?: (path: string) => void;
  onResendUserMessage?: (message: any) => void;
  onEditMessage?: (messageId: string, newText: string, entryId?: string) => void;
  onDeleteMessage?: (messageId: string, entryId?: string) => void;
  onForkMessage?: (message: any) => void;
  onRewindToMessage?: (message: any) => void;
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
  settingsOpen,
  environmentDialog,
  runCreateSessionDraft,
  abortAgent: _abortAgent,
}: SessionViewProps) {
  const paneServices = useSessionPaneServices();
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

  const terminalPanelVisible =
    !isLanWeb && !settingsOpen && !environmentDialog &&
    terminalDockVisible && terminalOpen;
  // 空会话磁盘就绪后卸底部栏，改由 timeline 内 SessionStartSurface 居中输入。
  const bottomComposerVisible = shouldMountBottomComposer({
    hasActiveConversation,
    messageCount: sessionTimeline.messages.length,
    isConversationLoading: sessionTimeline.isSurfaceLoading,
  });
  // 仅显示最近一轮的修改，避免把整个会话历史堆到输入框上方；切换到新一轮后，
  // strip 会按新的 run 身份重置为默认折叠。
  const latestAgentRun = useMemo<AgentRunItem | undefined>(() => {
    const displayItems = groupToolMessages(sessionTimeline.messages);
    let latestRun: AgentRunItem | undefined;
    let latestUserTimestamp = 0;
    for (const item of displayItems) {
      if (item.kind === "message" && item.message.role === "user") {
        latestUserTimestamp = Math.max(latestUserTimestamp, item.message.timestamp);
      } else if (item.kind === "agent-run") {
        latestRun = item;
      }
    }
    // 新问题已发出但 Agent 尚未产生新 run 时，隐藏上一轮文件，避免误导。
    return latestRun && latestUserTimestamp <= latestRun.endedAt
      ? latestRun
      : undefined;
  }, [sessionTimeline.messages]);
  const sessionPanels = { terminal: terminalPanelVisible };
  const timelineColumnMinSize = bottomComposerVisible
    ? TIMELINE_MIN_HEIGHT + COMPOSER_MIN_HEIGHT
    : TIMELINE_MIN_HEIGHT;
  const timelineColumnStyle = {
    "--session-timeline-min": `${TIMELINE_MIN_HEIGHT}px`,
  } as CSSProperties;

  // 终端 Panel 随 terminalOpen 动态挂载，约束注册有一帧延迟。
  // 折叠/展开用稳态读数 + setLayout：差额全部给 timeline，输入栏不在 Group 里。
  useEffect(() => {
    const panel = terminalPanelRef.current;
    if (!panel) return;
    const frame = requestAnimationFrame(() => {
      try {
        terminalProgrammaticExpireRef.current =
          Date.now() + TERMINAL_PROGRAMMATIC_PROTECT_MS;
        const terminalSize = terminalPanelRef.current?.getSize();
        if (!terminalSize || terminalSize.inPixels <= 0 || terminalSize.asPercentage <= 0) return;
        const groupPx = (terminalSize.inPixels / terminalSize.asPercentage) * 100;
        const terminalTargetPx = terminalCollapsed
          ? TERMINAL_PANEL_COLLAPSED_SIZE
          : Math.max(
              TERMINAL_PANEL_MIN_SIZE,
              Math.min(terminalRowHeight, availableTerminalHeight),
            );
        const terminalPct = Math.min(100, (terminalTargetPx / groupPx) * 100);
        const layout = sessionGroupRef.current?.getLayout();
        if (!layout || layout.timeline === undefined || layout.terminal === undefined) return;
        const next = redistributeTerminalAgainstTimeline(
          layout,
          terminalPct,
          (timelineColumnMinSize / groupPx) * 100,
        );
        if (next) sessionGroupRef.current?.setLayout(next);
      } catch { /* 约束未就绪，下轮状态再同步 */ }
    });
    return () => cancelAnimationFrame(frame);
  }, [
    availableTerminalHeight,
    terminalCollapsed,
    terminalDockVisible,
    terminalOpen,
    terminalRowHeight,
    timelineColumnMinSize,
  ]);

  return (
    <div
      className={
        splitPane
          ? `session-split-pane flex h-full min-h-0 flex-col${focused ? " session-split-pane-focused" : ""}`
          : "contents"
      }
      onMouseDown={splitPane ? () => onFocusPane?.() : undefined}
    >
      {/* Tab 栏已统一外置；运行控制（停止/重启）在共享 Tab 栏的 Tab 下拉；
          本栏只保留会话状态徽章与分屏身份标题（抽屉开关在共享 Tab 栏）。 */}
      <SessionHeader
        headerRef={chatHeaderRef}
        statusSessionId={sessionId}
        title={sessionTitle}
        projectName={projectName}
        paneTitle={splitPane ? sessionTitle : undefined}
        onExitSplit={
          splitPane ? () => paneServices.exitSessionSplit(sessionId) : undefined
        }
        isAnonymous={activeAgent?.noSession}
        duration={sessionDuration}
        isStarting={isAgentStarting}
      />
      {/* 分支导航条：仅当当前会话存在 fork 分支关系（父/兄弟/子分支）时显示 */}
      <SessionBranchBar sessionId={sessionId} onOpenSession={onOpenBranchSession} />
      <ResizablePanelGroup
        // 面板数只随终端挂载变化：输入栏在时间线列内，不再改变 Group 面板数。
        key={`${sessionId}:${sessionResizableGroupKey(sessionPanels)}`}
        orientation="vertical"
        className="session-v-group"
        groupRef={sessionGroupRef}
        defaultLayout={sessionGroupDefaultLayout(
          sessionPanels,
          terminalCollapsed ? TERMINAL_PANEL_COLLAPSED_SIZE : terminalRowHeight,
          Math.max(1, window.innerHeight - 120),
        )}
        resizeTargetMinimumSize={{ fine: 20, coarse: 24 }}
      >
        <ResizablePanel
          id="timeline"
          minSize={timelineColumnMinSize}
          className="session-v-timeline flex min-h-0 flex-col"
          style={timelineColumnStyle}
        >
          <div className="session-v-timeline-stage min-h-[var(--session-timeline-min,160px)] flex-1 overflow-hidden">
            <SessionSurfaceStage
              sessionId={sessionId}
              sessionTimeline={sessionTimeline}
              isRestarting={isRestarting}
              timelineProps={{
                hasProject,
                onCreateSession: runCreateSessionDraft,
                showThinking,
                validCommandNames,
                validFilePaths,
                onPreviewImage,
                onOpenExternal: (url: string, forceSystem?: boolean) => api.app.openExternal(url, forceSystem),
                onOpenFile,
                onDiffFile,
                onResendUserMessage,
                onEditMessage,
                onDeleteMessage,
                onForkMessage,
                onRewindToMessage,
                forkingMessageId,
                onToast,
                onQuickPrompt,
                runtimeUi,
              }}
            />
          </div>
          {/* 有消息或仍在加载：列底固有高度输入栏。空会话就绪后卸掉，改由起始页居中输入。
              max-height 相对本列：窗口放大后上限抬起，待办/改文件条随内容恢复，不锁死像素。 */}
          {bottomComposerVisible && (
            <div
              className="session-v-composer flex min-h-0 shrink-0 flex-col overflow-hidden [scrollbar-gutter:stable]"
              style={{
                maxHeight: `min(${COMPOSER_MAX_HEIGHT}px, calc(100% - var(--session-timeline-min, ${TIMELINE_MIN_HEIGHT}px)))`,
              }}
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
                    <SessionTodoStrip sessionId={sessionId} />
                    <SessionFilesStrip
                      sessionId={sessionId}
                      run={latestAgentRun}
                      onOpenFile={onOpenFile}
                      onDiffFile={onDiffFile}
                    />
                    <SessionSubagentsStrip
                      sessionId={sessionId}
                      onOpenChildSession={onOpenBranchSession}
                    />
                    <SessionGoalStrip sessionId={sessionId} />
                  </>
                }
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
