import { ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type ReactNode, type MutableRefObject } from "react";
import {
  type GroupImperativeHandle,
  type PanelImperativeHandle,
  type PanelSize,
} from "react-resizable-panels";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../ui-shadcn/resizable";
import type { AgentRuntimeState, GitBranchInfo, ImageContent, SessionRuntimeTarget } from "../../../../shared/types";
import type { SessionTimelineController } from "../../hooks/useSessionTimelineController";
import type { QueuedPrompt } from "../../hooks/useQueuedPrompt";
import type { PiDesktopApi } from "../../../../preload";
import { t } from "../../i18n";
import { isLanWeb, desktopApi as api } from "../../desktopApi";
import { SessionHeader } from "./SessionHeader";
import { SessionWidgetChips } from "./SessionWidgetChips";
import { SessionTabsBar, type SessionTabsBarProps } from "./SessionTabsBar";
import { SessionMessageTimeline } from "./SessionMessageTimeline";
import { ComposerArea } from "./ComposerArea";
import { SessionRuntimeDock } from "./SessionRuntimeDock";
import { QueuedPromptPanel } from "./ComposerPanels";
import { COMPOSER_DEFAULT_HEIGHT, COMPOSER_MIN_HEIGHT, TIMELINE_MIN_HEIGHT, growComposerWithinTimelineBudget } from "../../rendererUtils";
import type { EnqueuePromptSnapshot } from "../../hooks/useSessionSend";

// terminal 程序化布局保护窗口（ms）：programResize 后该窗口内的 terminal
// onResize 一律视为程序化结果，不写 collapsed 状态。独立于 composer 的共享
// 标记，避免 composer onResize 先触发清掉保护后，terminal 回调被误判为折叠。
const TERMINAL_PROGRAMMATIC_PROTECT_MS = 250;

export type SessionViewProps = {
  // ── Session identity ──
  sessionId: string;
  sessionTitle: string;
  sessionTabs: Omit<SessionTabsBarProps, "actions">;
  sessionTimeline: SessionTimelineController;
  activeAgentId?: string;
  activeAgent?: {
    compactionCount?: number;
    noSession?: boolean;
    status?: string;
  } | null;
  activeRuntimeState?: AgentRuntimeState;
  runtimeTarget?: SessionRuntimeTarget;
  hasActiveConversation: boolean;
  hasProject: boolean;

  // ── Layout refs ──
  chatHeaderRef: RefObject<HTMLDivElement | null>;
  sessionComboRef: RefObject<HTMLDivElement | null>;
  composerRef: RefObject<HTMLElement | null>;
  composerOffsetHeight: number;
  terminalRowHeight: number;

  // ── Header state ──
  isAgentStarting: boolean;
  sessionActionsOpen: boolean;
  canStop: boolean;
  canRestart: boolean;
  restartingAgentId?: string;
  isRestarting: boolean;
  showRestart: boolean;
  sessionDuration?: number;

  // ── Header callbacks ──
  onHeaderTrigger: () => void;
  onStop: () => void;
  onRestart: () => void;
  /** 右侧抽屉开关（main 布局：会话操作菜单右侧），不传则不渲染 */
  onToggleDrawer?: () => void;
  drawerOpen?: boolean;

  // ── Timeline interaction ──
  showThinking: boolean;
  validCommandNames: Set<string>;
  validFilePaths: Set<string>;
  onPreviewImage: (image: ImageContent) => void;
  onOpenFile?: (path: string) => void;
  onDiffFile?: (path: string) => void;
  onResendUserMessage?: (message: any) => void;
  onEditMessage?: (messageId: string, newText: string) => void;
  onDeleteMessage?: (messageId: string) => void;
  onForkMessage?: (message: any) => void;
  forkingMessageId?: string | null;
  onToast: (message: string) => void;
  onQuickPrompt?: (prompt: string) => void;
  canMutateActiveMessages: boolean;

  // ── Composer ──
  enqueueSessionPrompt: (sessionId: string, snapshot: EnqueuePromptSnapshot) => boolean;
  gitInfo?: GitBranchInfo;
  openFilePath?: (path: string) => void;
  ensureSessionId?: (sessionId: string) => Promise<string>;
  queuePanel?: ReactNode;
  runtimeUi?: ReactNode;

  // ── Terminal dock ──
  terminalDockVisible: boolean;
  terminalOpen: boolean;
  terminalDockClosing: boolean;
  terminalCollapsed: boolean;
  availableTerminalHeight: number;
  setTerminalOpenForAgent: (agentId: string, open: boolean) => void;
  setTerminalCollapsedForAgent: (agentId: string, collapsed: boolean) => void;
  setTerminalHeightByAgent: (
    updater: (current: Record<string, number>) => Record<string, number>
  ) => void;

  // ── Other visibility ──
  settingsOpen: boolean;
  configOpen: boolean;
  environmentDialog: boolean;

  // ── Session actions ──
  runCreateSessionDraft: () => void;
  abortAgent: () => void;
  restartActiveAgent: () => void;
};

export function SessionView({
  sessionId,
  sessionTitle,
  sessionTabs,
  sessionTimeline,
  activeAgentId,
  activeAgent,
  activeRuntimeState,
  runtimeTarget,
  hasActiveConversation,
  hasProject,
  chatHeaderRef,
  sessionComboRef,
  composerRef,
  composerOffsetHeight,
  terminalRowHeight,
  isAgentStarting,
  sessionActionsOpen,
  canStop,
  canRestart,
  restartingAgentId,
  isRestarting,
  showRestart,
  sessionDuration,
  onHeaderTrigger,
  onStop,
  onRestart,
  onToggleDrawer,
  drawerOpen,
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
  forkingMessageId,
  onToast,
  onQuickPrompt,
  canMutateActiveMessages,
  enqueueSessionPrompt,
  gitInfo,
  openFilePath,
  ensureSessionId,
  queuePanel,
  runtimeUi,
  terminalDockVisible,
  terminalOpen,
  terminalDockClosing,
  terminalCollapsed,
  availableTerminalHeight,
  setTerminalOpenForAgent,
  setTerminalCollapsedForAgent,
  setTerminalHeightByAgent,
  settingsOpen,
  configOpen,
  environmentDialog,
  runCreateSessionDraft,
  abortAgent,
  restartActiveAgent,
}: SessionViewProps) {
  // #115 U5 垂直轴：timeline | composer | terminal 三段由 react-resizable-panels 接管。
  // composer 高度本地持有（px），终端高度/折叠仍由 useTerminalDock 的 per-agent
  // 状态持有，拖拽结果经 onResize 回写，外部状态经 imperative API 同步。
  // 默认高度走 COMPOSER_DEFAULT_HEIGHT（偏矮，给 timeline 留正文）；
  // Ask 属于会话交互状态，不再参与 composer 的高度分配；它固定在时间线底部，避免把输入框挤出面板。
  const [composerHeight, setComposerHeight] = useState(COMPOSER_DEFAULT_HEIGHT);
  const terminalPanelRef = useRef<PanelImperativeHandle | null>(null);
  const sessionGroupRef = useRef<GroupImperativeHandle | null>(null);

  // ── composer 面板自适应高度（#115 U5 布局换装） ──────────────
  // 面板高度由 react-resizable-panels 持有；输入区上方出现可变内容（Todo/记忆
  // widget、图片附件等）时，footer 固定高度会把 composer-box 挤到 min-height 并
  // 被 overflow-hidden 裁切，输入区显示不清晰。这里通过 panelRef 命令式 resize：
  // 内容需要更高 → 自动增高；内容减少（含完全消失）且当前高度由内容驱动 → 回缩，
  // 但用户手动拖高的高度不被内容变化回缩。
  const composerPanelRef = useRef<PanelImperativeHandle | null>(null);
  const composerHeightStateRef = useRef(COMPOSER_DEFAULT_HEIGHT);
  // 用户手动拖拽后的面板高度（未拖拽时等于默认值）；内容自适应不会回缩到它以下
  const userComposerHeightRef = useRef(COMPOSER_DEFAULT_HEIGHT);
  // 内容驱动高度：最近一次内容所需的面板高度。回缩只发生在 current <= 该值
  // （面板高度未超过内容所需，即没有被用户手动拖高）。
  const contentDrivenHeightRef = useRef(COMPOSER_DEFAULT_HEIGHT);
  // resize() 经 ResizeObserver 异步触发 onResize；用「时间窗口 + 内容驱动高度
  // 匹配」双重判断区分程序 resize 与用户拖拽，避免程序增高后的回调被误判为
  // 用户操作（误判会把用户手动高度抬到内容高度，导致内容减少时不再回缩）。
  const programmaticResizeTargetRef = useRef<number | null>(null);
  const programResizeExpireRef = useRef(0);
  // terminal 专用的程序化保护窗口：programResize 设置、仅由超时清空。
  // 不能复用 programmaticResizeTargetRef——composer 的 onResize 会把它清掉，
  // 若 terminal 的 onResize 后触发（连续 setLayout 竞态下 K() 把 terminal
  // 压到折叠阈值），就落在保护窗口外被误判为用户折叠，导致发送消息时终端被收起。
  const terminalProgrammaticExpireRef = useRef(0);

  function applyComposerHeight(px: number, fromUser: boolean) {
    composerHeightStateRef.current = px;
    setComposerHeight(px);
    if (fromUser) {
      userComposerHeightRef.current = px;
    }
  }

  function programResize(target: number): boolean {
    programmaticResizeTargetRef.current = target;
    programResizeExpireRef.current = Date.now() + 200;
    terminalProgrammaticExpireRef.current =
      Date.now() + TERMINAL_PROGRAMMATIC_PROTECT_MS;
    try {
      // 优先走 Group.setLayout：composer 增高时保持 terminal 高度不变，从 timeline
      // 拿空间。库的 panel.resize() 默认从相邻面板（terminal）拿空间，粘贴图片会
      // 把终端面板压扁（#115 U5 反馈）。timeline 低于 minSize 时由 K() 自动 clamp。
      const group = sessionGroupRef.current;
      const composerSize = composerPanelRef.current?.getSize();
      if (
        group &&
        composerSize &&
        composerSize.inPixels > 0 &&
        composerSize.asPercentage > 0
      ) {
        const layout = group.getLayout();
        if (Object.keys(layout).length > 0) {
          // getSize() 返回 px 与百分比，反推 group 总高，把目标 px 转成百分比。
          const groupPx = (composerSize.inPixels / composerSize.asPercentage) * 100;
          const targetPct = Math.min(100, (target / groupPx) * 100);
          // 增高预算受 timeline 保底线限制：timeline 让不出空间时不再硬扣，
          // 否则库 K() 会把 clamp 差额压给 collapsible 的 terminal，导致发送消息/输出时终端被收起。
          const budget = growComposerWithinTimelineBudget(
            layout,
            composerSize.asPercentage,
            targetPct,
            groupPx,
            TIMELINE_MIN_HEIGHT,
          );
          // setLayout 要求键与当前面板集合一致：terminal 卸载后 getLayout 仍
          // 保留其百分比，必须剔除，否则 K() 校验键数不匹配会 throw。
          const next: Record<string, number> = { ...layout };
          if (layout.terminal !== undefined && !terminalPanelVisible) {
            delete next.terminal;
          }
          next.composer = budget.composer;
          if (layout.timeline !== undefined) {
            next.timeline = budget.timeline;
          }
          group.setLayout(next);
          return true;
        }
      }
      // group 未就绪（挂载早期）回退旧路径：相邻面板（terminal）让出空间。
      composerPanelRef.current?.resize(target);
    } catch {
      // 面板尚未注册到 ResizablePanelGroup（挂载早期时序）时 resize 会抛
      // Group not found；静默跳过并清除目标值，下一轮内容测量会再次尝试。
      programmaticResizeTargetRef.current = null;
      return false;
    }
    // 兜底：resize 未触发 onResize（面板未挂载/已卸载）时也清除目标值，
    // 避免残留目标吞掉下一次真实拖拽（与目标恰好一致的极小概率）。
    window.setTimeout(() => {
      if (Date.now() >= programResizeExpireRef.current) {
        programmaticResizeTargetRef.current = null;
      }
    }, 250);
    return true;
  }

  /**
   * ComposerArea 上报可变内容占用的额外高度（px）。
   * 目标高度 = 内容所需（默认输入区 + 额外内容），且不低于用户手动拖拽的高度。
   * - 内容需要更高 → 自动增高，并记录内容驱动高度；
   * - 内容减少 → 仅当当前高度由内容驱动（未超过内容所需）时回缩，
   *   用户手动拖高的高度不被内容变化回缩。
   */
  function handleComposerContentHeight(extraHeight: number) {
    const maxAllowed = Math.max(COMPOSER_MIN_HEIGHT, composerMaxHeight);
    const userPreferred = Math.max(
      userComposerHeightRef.current,
      COMPOSER_MIN_HEIGHT,
    );
    const target = Math.min(
      Math.max(userPreferred, COMPOSER_DEFAULT_HEIGHT + extraHeight),
      maxAllowed,
    );
    const current = composerHeightStateRef.current;
    if (target === current) return;
    if (target > current) {
      // 内容需要更高 → 自动增高，记录内容驱动高度
      contentDrivenHeightRef.current = target;
      if (programResize(target)) applyComposerHeight(target, false);
      return;
    }
    // 内容减少需要更矮：仅当当前高度由内容驱动（未超过内容所需）时回缩；
    // 用户手动拖高的高度不被内容变化回缩。
    if (current <= contentDrivenHeightRef.current) {
      contentDrivenHeightRef.current = Math.min(
        contentDrivenHeightRef.current,
        target,
      );
      if (programResize(target)) applyComposerHeight(target, false);
    }
  }

  // 终端 Panel 随 terminalOpen 动态挂载，约束注册有一帧延迟（与抽屉同款问题），
  // imperative 同步统一推迟一帧并容错。
  useEffect(() => {
    const panel = terminalPanelRef.current;
    if (!panel) return;
    const frame = requestAnimationFrame(() => {
      try {
        if (terminalCollapsed) { if (!panel.isCollapsed()) panel.collapse(); }
        else if (panel.isCollapsed()) panel.expand();
      } catch { /* 约束未就绪，下轮状态再同步 */ }
    });
    return () => cancelAnimationFrame(frame);
  }, [terminalCollapsed, terminalOpen, terminalDockVisible]);

  function handleComposerResize(size: PanelSize) {
    const px = Math.round(size.inPixels);
    const now = Date.now();
    // 程序 resize 的异步回调：时间窗口内（刚 programResize），或最终高度与
    // 内容驱动高度一致（即使回调延迟/像素取整）都视为程序化结果，不记为用户
    // 手动高度，避免内容减少时误判导致不回缩。
    const isProgrammatic =
      (programmaticResizeTargetRef.current != null &&
        now < programResizeExpireRef.current) ||
      Math.abs(px - contentDrivenHeightRef.current) <= 2;
    if (isProgrammatic) {
      programmaticResizeTargetRef.current = null;
      composerHeightStateRef.current = px;
      setComposerHeight(px);
      return;
    }
    programmaticResizeTargetRef.current = null;
    applyComposerHeight(px, true);
  }

  function handleTerminalResize(size: PanelSize) {
    const px = Math.round(size.inPixels);
    if (!activeAgentId) return;
    // 34px 为折叠条高度：拖到折叠阈值视为折叠，拖回展开。
    // 程序化 setLayout（composer 增高/回缩）触发的 onResize 不算用户折叠意图：
    // 布局挤压导致的面板变矮不应把 collapsed 状态写死，否则下次打开仍是收起的。
    // 用独立保护窗口而非共享的 programmaticResizeTargetRef：后者会被 composer 的
    // onResize 消费清空，terminal 回调后触发时会失去保护。
    const withinProgrammaticWindow =
      Date.now() < terminalProgrammaticExpireRef.current;
    if (px <= 35) {
      if (!terminalCollapsed && !withinProgrammaticWindow) {
        setTerminalCollapsedForAgent(activeAgentId, true);
      }
      return;
    }
    if (terminalCollapsed && !withinProgrammaticWindow) {
      setTerminalCollapsedForAgent(activeAgentId, false);
    }
    const maxHeight = Math.max(120, availableTerminalHeight);
    setTerminalHeightByAgent((current) => ({
      ...current,
      [activeAgentId]: Math.min(px, maxHeight),
    }));
  }

  // 与旧拖拽实现一致的上限公式（渲染期快照，与旧行为同为非响应式）
  const composerMaxHeight = Math.max(COMPOSER_MIN_HEIGHT, Math.min(480, window.innerHeight - 260));
  const terminalPanelVisible =
    !isLanWeb && !settingsOpen && !configOpen && !environmentDialog &&
    terminalDockVisible && terminalOpen;

  // 最近一次三面板布局快照（terminal 可见时持续记录），关闭终端时恢复用。
  const lastThreePanelLayoutRef = useRef<Record<string, number> | null>(null);
  useEffect(() => {
    if (!terminalPanelVisible) return;
    try {
      lastThreePanelLayoutRef.current =
        sessionGroupRef.current?.getLayout() ?? null;
    } catch { /* Group 未挂载 */ }
  });

  // terminal 面板卸载时 Group 重注册：2 面板布局缓存缺失会按 defaultSize
  // 回退（输入框高度跳变 + 内容被压缩出滚动条）。这里在 paint 前用「关闭前
  // 的三面板布局」主动恢复：composer 保持关闭前高度，timeline 吸收 terminal
  // 释放的空间；setLayout 同时填充 "timeline,composer" 缓存，重开终端时
  // 三面板缓存恢复原布局。程序化标记避免恢复触发的 onResize 污染用户手动高度。
  useLayoutEffect(() => {
    if (terminalPanelVisible || terminalOpen) return;
    const prev = lastThreePanelLayoutRef.current;
    const group = sessionGroupRef.current;
    const panel = composerPanelRef.current;
    if (!prev || !group || !panel || prev.composer === undefined) return;
    try {
      const next: Record<string, number> = { ...prev };
      delete next.terminal;
      next.timeline = 100 - prev.composer;
      const size = panel.getSize();
      if (size.inPixels <= 0 || size.asPercentage <= 0) return;
      const groupPx = size.inPixels / (size.asPercentage / 100);
      const expectedPx = Math.round(groupPx * (prev.composer / 100));
      programmaticResizeTargetRef.current = expectedPx;
      programResizeExpireRef.current = Date.now() + 200;
      group.setLayout(next);
      applyComposerHeight(expectedPx, false);
    } catch { /* Group 未就绪 */ }
  }, [terminalPanelVisible, terminalOpen]);

  return (
    <>
      {/* 状态徽章与操作独立成下一行，Tab 栏只保留可横向滚动的会话标签。 */}
      <SessionTabsBar {...sessionTabs} actions={null} />
      <SessionHeader
        headerRef={chatHeaderRef}
        comboRef={sessionComboRef}
        title={sessionTitle}
        compactionCount={activeAgent?.compactionCount}
        isAnonymous={activeAgent?.noSession}
        runtimeState={activeRuntimeState}
        duration={sessionDuration}
        isStarting={isAgentStarting}
        hasProject={hasProject}
        hasSession={Boolean(activeAgentId || sessionId)}
        menuOpen={sessionActionsOpen}
        canStop={canStop}
        canRestart={canRestart}
        isRestarting={isRestarting}
        showRestart={showRestart}
        onTrigger={onHeaderTrigger}
        onStop={onStop}
        onRestart={onRestart}
        onToggleDrawer={onToggleDrawer}
        drawerOpen={drawerOpen}
        widgetChips={<SessionWidgetChips sessionId={sessionId} />}
      />
      <ResizablePanelGroup
        orientation="vertical"
        className="session-v-group"
        groupRef={sessionGroupRef}
      >
        <ResizablePanel id="timeline" minSize={TIMELINE_MIN_HEIGHT} className="session-v-timeline">
          <div className="relative h-full min-h-0">
          <SessionMessageTimeline
            sessionId={sessionId}
            controller={sessionTimeline}
            hasProject={hasProject}
            onCreateSession={runCreateSessionDraft}
            showThinking={showThinking}
            validCommandNames={validCommandNames}
            validFilePaths={validFilePaths}
            onPreviewImage={onPreviewImage}
            onOpenExternal={(url: string) => api.app.openExternal(url)}
            onOpenFile={onOpenFile}
            onDiffFile={onDiffFile}
            onResendUserMessage={
              canMutateActiveMessages ? onResendUserMessage : undefined
            }
            onEditMessage={
              canMutateActiveMessages ? onEditMessage : undefined
            }
            onDeleteMessage={
              canMutateActiveMessages ? onDeleteMessage : undefined
            }
            onForkMessage={
              canMutateActiveMessages ? onForkMessage : undefined
            }
            forkingMessageId={forkingMessageId}
            onToast={onToast}
            onQuickPrompt={onQuickPrompt}
            runtimeUi={runtimeUi}
          />

          {sessionTimeline.showScrollToBottom && (
            <button
              className="scroll-to-bottom-btn"
              onClick={sessionTimeline.scrollToBottom}
              title={t("app.scrollToBottom")}
              aria-label={t("app.scrollToBottom")}
            >
              <ChevronDown size={18} />
            </button>
          )}
          </div>
        </ResizablePanel>

        {hasActiveConversation && (
          <>
            <ResizableHandle className="v-splitter" />
            <ResizablePanel
              id="composer"
              panelRef={composerPanelRef}
              minSize={COMPOSER_MIN_HEIGHT}
              maxSize={composerMaxHeight}
              defaultSize={composerHeight}
              onResize={handleComposerResize}
              className="session-v-composer"
            >
              <ComposerArea
                ref={composerRef}
                sessionId={sessionId}
                gitInfo={gitInfo}
                height={composerHeight}
                onContentHeightChange={handleComposerContentHeight}
                onOpenFile={openFilePath}
                enqueue={enqueueSessionPrompt}
                ensureSessionId={ensureSessionId}
                queuePanel={queuePanel}
              />
            </ResizablePanel>
          </>
        )}

        {terminalPanelVisible && (
          <>
            <ResizableHandle className="v-splitter" />
            <ResizablePanel
              id="terminal"
              panelRef={terminalPanelRef}
              collapsible
              collapsedSize={34}
              minSize={120}
              maxSize={Math.max(120, availableTerminalHeight)}
              defaultSize={terminalCollapsed ? 34 : terminalRowHeight}
              onResize={handleTerminalResize}
              className="session-v-terminal"
            >
              <SessionRuntimeDock
                target={runtimeTarget}
                mounted={terminalDockVisible}
                open={terminalOpen}
                closing={terminalDockClosing}
                collapsed={terminalCollapsed}
                height={terminalRowHeight}
                terminal={api.terminal}
                onOpenChange={(open) => {
                  if (activeAgentId) setTerminalOpenForAgent(activeAgentId, open);
                }}
                onCollapsedChange={(collapsed) => {
                  if (activeAgentId)
                    setTerminalCollapsedForAgent(activeAgentId, collapsed);
                }}
                onHeightChange={() => {
                  // 高度由面板 onResize 统一回写，此回调保留仅为兼容接口
                }}
              />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </>
  );
}
