import React from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
	resolvePaneTerminal,
	terminalOwnerKey,
	shouldMountPaneTerminalDock,
} from "../../terminalDockState";
import { settingsOpenAtom } from "../../atoms";
import {
  claimSessionRuntimeUiResponseAtom,
  rollbackSessionRuntimeUiResponseAtom,
} from "../../atoms/session-atoms";
import {
  sessionRecordByIdAtomFamily,
  sessionRuntimeBySessionIdAtomFamily,
  sessionRuntimeUiBySessionIdAtomFamily,
} from "../../atoms/session-selectors";
import { projectByIdAtomFamily } from "../../atoms/project-atoms";
import { useSessionRuntimeController } from "../../hooks/useSessionRuntimeController";
import {
  createSessionRuntimeUiResponder,
  SessionRuntimeUiOverlay,
} from "../overlays/SessionRuntimeUiOverlay";
import type { QueuedPrompt } from "../../hooks/useQueuedPrompt";
import type { SessionTimelineController } from "../../hooks/useSessionTimelineController";
import { QueuedPromptPanel } from "./ComposerPanels";
import { FileLinkBaseProvider } from "./FileLinkBase";
import { SessionView } from "./SessionView";
import { useSessionPaneServices } from "./SessionPaneServices";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import {
	requireSessionCommand,
	sessionCommandFailureToast,
	toSessionRuntimeTarget,
} from "../../utils/sessionCommands";
import { formatRelativeTime } from "../../utils/relativeTime";
import { ConfirmDialog } from "../ui-shadcn/ConfirmDialog";
import type { ChatMessage, RewindCheckpointSummary } from "../../../../shared/types";

export type SessionRuntimeInjectorProps = {
  currentSessionId: string;
  sessionTitle: string;
  sessionTimeline: SessionTimelineController;
  /** 分屏栏加聚焦边框；单栏 Tab 已外置，同样只渲染本栏 Header */
  splitPane?: boolean;
  focused?: boolean;
  onFocusPane?: () => void;
  chatHeaderRef: React.RefObject<HTMLDivElement | null>;
  composerRef: React.RefObject<HTMLElement | null>;
  composerOffsetHeight: number;
  terminalRowHeight: number;
  activeQueuedPrompts: QueuedPrompt[];
  queuedTrackRef: React.MutableRefObject<HTMLElement | null>;
};

/**
 * 绑定本栏 runtime 订阅与 UI overlay，再交给 SessionView。
 * 共享服务从 SessionPaneServices 读取，避免 App 大 props 袋。
 */
export const SessionRuntimeInjector = React.memo(function SessionRuntimeInjector(
  props: SessionRuntimeInjectorProps,
) {
  const {
    currentSessionId,
    sessionTitle,
    sessionTimeline,
    splitPane = false,
    focused = true,
    onFocusPane,
    chatHeaderRef,
    composerRef,
    composerOffsetHeight,
    terminalRowHeight,
    activeQueuedPrompts,
    queuedTrackRef,
  } = props;

  const services = useSessionPaneServices();
  const settingsOpen = useAtomValue(settingsOpenAtom);
  const sessionRecord = useAtomValue(sessionRecordByIdAtomFamily(currentSessionId));
  const currentSessionRuntime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(currentSessionId));
  const currentSessionRuntimeUi = useAtomValue(sessionRuntimeUiBySessionIdAtomFamily(currentSessionId));
  const claimSessionUiResponse = useSetAtom(claimSessionRuntimeUiResponseAtom);
  const rollbackSessionUiResponse = useSetAtom(rollbackSessionRuntimeUiResponseAtom);
  const runtimeRef = React.useRef(currentSessionRuntime);
  runtimeRef.current = currentSessionRuntime;

  // 本栏终端归属：从本会话自身的 runtime/record 解析（分屏各栏独立，不再跟随 App 聚焦态）；
  // owner 解析失败或目标不可落地时该栏不挂 dock。
  const paneProjectId = currentSessionRuntime?.projectId ?? sessionRecord?.projectId ?? "";
  const paneProject = useAtomValue(
    projectByIdAtomFamily(paneProjectId),
  );
  const paneFileContext = React.useMemo(
    () => ({
      // runtime cwd 是该会话真正执行工具的目录；未启动时回退 catalog 项目根。
      baseDir: currentSessionRuntime?.cwd ?? paneProject?.path,
      projectId: paneProjectId || undefined,
      projectRoot: paneProject?.path,
    }),
    [currentSessionRuntime?.cwd, paneProject?.path, paneProjectId],
  );
  const openPaneFile = React.useCallback(
    (path: string, line?: number) => services.onOpenFile(path, line, paneFileContext),
    [paneFileContext, services.onOpenFile],
  );
  const paneTerminal = React.useMemo(
    () =>
      resolvePaneTerminal({
        sessionId: currentSessionId,
        runtime: currentSessionRuntime,
        projectId: paneProjectId || undefined,
        project: paneProject,
      }),
    [currentSessionId, currentSessionRuntime, paneProjectId, paneProject],
  );
  const paneOwnerKey = paneTerminal ? terminalOwnerKey(paneTerminal.owner) : undefined;
  const paneTerminalState = paneOwnerKey
    ? services.terminalStatesByOwner[paneOwnerKey]
    : undefined;
  const paneTerminalOpen = Boolean(paneTerminalState?.open) && Boolean(paneTerminal);
  const paneTerminalCollapsed = Boolean(paneTerminalState?.collapsed);
  const paneTerminalDockVisible = shouldMountPaneTerminalDock({
    ownerKey: paneOwnerKey,
    activeOwnerKey: services.activeTerminalOwnerKey,
    focused,
    open: paneTerminalOpen,
  });
  // 本栏 dock 的开关回调绑定本栏自己的 owner key：非聚焦栏也能关自己的终端，
  // 不会写到当前聚焦会话的桶里（分屏双栏状态互不串台）。
  const setPaneTerminalOpen = React.useCallback(
    (open: boolean) => {
      if (paneOwnerKey) services.setTerminalOpenByOwnerKey(paneOwnerKey, open);
    },
    [paneOwnerKey, services.setTerminalOpenByOwnerKey],
  );
  const setPaneTerminalCollapsed = React.useCallback(
    (collapsed: boolean) => {
      if (paneOwnerKey) services.setTerminalCollapsedByOwnerKey(paneOwnerKey, collapsed);
    },
    [paneOwnerKey, services.setTerminalCollapsedByOwnerKey],
  );

  const runtimeUiResponder = React.useMemo(() => {
    if (!currentSessionRuntime?.agentId) return undefined;
    const binding = {
      sessionId: currentSessionId,
      agentId: currentSessionRuntime.agentId,
      runtimeGeneration: currentSessionRuntime.runtimeGeneration,
    };

    return createSessionRuntimeUiResponder({
      binding,
      readBinding: () => {
        const latest = runtimeRef.current;
        return latest?.agentId
          ? {
              sessionId: currentSessionId,
              agentId: latest.agentId,
              runtimeGeneration: latest.runtimeGeneration,
            }
          : undefined;
      },
      claim: claimSessionUiResponse,
      rollback: rollbackSessionUiResponse,
      send: services.api.sessions.sendUiResponse,
      onError: (error) =>
        services.showToast(error instanceof Error ? error.message : String(error), 4000),
    });
  }, [
    claimSessionUiResponse,
    currentSessionId,
    currentSessionRuntime?.agentId,
    currentSessionRuntime?.runtimeGeneration,
    rollbackSessionUiResponse,
    services.api.sessions.sendUiResponse,
    services.showToast,
  ]);

  const runtime = useSessionRuntimeController({
    sessionId: currentSessionId,
    agents: services.agents,
    queueFlushBySessionRef: services.queueFlushBySessionRef,
    activeQueuedPrompts,
    restartingAgentId: services.restartingAgentId,
    sessionDurationByAgent: services.sessionDurationByAgent,
    activeProjectId: services.activeProjectId,
    showNotice: services.showNotice,
    // 后台 Ask toast 的「前往会话」：由 App 级 focusAskSessionById 解析 record 并登记 Tab
    onFocusSession: services.focusAskSessionById,
  });

  const activeAgent = runtime.activeAgentId
    ? services.agents.find((a) => a.id === runtime.activeAgentId)
    : undefined;
  const canMutateActiveMessages = runtime.canMutateActiveMessages;
  // 未启动时 activeAgent 为空，必须看 catalog backend，不能只看 live tab。
  // DSH 本轮不做编辑/删除/重发（无 JSONL 离线改写）；
  // fork 对 pi/DSH 都始终提供入口：DSH 未激活时由 forkFromUserMessage 内部
  // 先 activateRuntime 再 fork，不再用 canMutateActiveMessages 门控——否则打开
  // 历史 DSH 会话（runtime 懒启动）时 fork 入口时有时无。
  const isDshBackend = sessionRecord?.backend === "dsh" || activeAgent?.backend === "dsh";
  const canEditOrDeleteMessages = !isDshBackend;
  const canResend = !isDshBackend;

  // ── 回退到此消息：解析最近检查点 + 确认回退（仅 pi 后端注入入口）──
  const [rewindConfirm, setRewindConfirm] = React.useState<RewindCheckpointSummary | null>(null);
  const [rewinding, setRewinding] = React.useState(false);
  const handleRewindToMessage = React.useCallback(
    async (message: ChatMessage) => {
      const target = toSessionRuntimeTarget(currentSessionId, currentSessionRuntime);
      if (!target) {
        services.showToast(t("rewind.unavailable"));
        return;
      }
      let list: RewindCheckpointSummary[];
      try {
        // rewind-to-message 需要全量最近检查点（无 limit → 后端返回全部）。
        list = requireSessionCommand(
          await desktopApi.sessions.listRewindCheckpoints(target),
        ).value.items;
      } catch (error) {
        services.showToast(
          sessionCommandFailureToast(error, (raw) => t("rewind.loadFailed", { error: raw })),
          4000,
        );
        return;
      }
      // 最近的、时刻不晚于该消息的检查点 ≈ 该消息开始动文件之前的状态；
      // 该轮没有文件类工具时自然落到上一轮的检查点，语义仍成立（撤销本消息起的改动）。
      const nearest = [...list]
        .sort((a, b) => b.timestamp - a.timestamp)
        .find((cp) => cp.timestamp <= message.timestamp);
      if (!nearest) {
        services.showToast(t("rewind.empty"), 3000);
        return;
      }
      setRewindConfirm(nearest);
    },
    [currentSessionId, currentSessionRuntime, services],
  );
  const performRewindRestore = React.useCallback(async () => {
    if (!rewindConfirm) return;
    const target = toSessionRuntimeTarget(currentSessionId, currentSessionRuntime);
    if (!target) return;
    setRewinding(true);
    try {
      await requireSessionCommand(
        await desktopApi.sessions.restoreRewindCheckpoint(target, rewindConfirm.id, "files"),
      );
      services.showToast(t("rewind.restoreDone", { id: rewindConfirm.id }));
    } catch (error) {
      services.showToast(
        sessionCommandFailureToast(error, (raw) => t("rewind.restoreFailed", { error: raw })),
        4000,
      );
    } finally {
      setRewinding(false);
      setRewindConfirm(null);
    }
  }, [currentSessionId, currentSessionRuntime, rewindConfirm, services]);

  return (
    <FileLinkBaseProvider
      baseDir={paneFileContext.baseDir}
      projectId={paneFileContext.projectId}
      projectRoot={paneFileContext.projectRoot}
    >
    <>
    <SessionView
      sessionId={currentSessionId}
      sessionTitle={sessionTitle}
      sessionTimeline={sessionTimeline}
      splitPane={splitPane}
      focused={focused}
      onFocusPane={onFocusPane}
      activeAgentId={runtime.activeAgentId ?? undefined}
      activeAgent={activeAgent}
      hasActiveConversation={runtime.hasActiveConversation}
      hasProject={runtime.sessionHasProject}
      chatHeaderRef={chatHeaderRef}
      composerRef={composerRef}
      composerOffsetHeight={composerOffsetHeight}
      terminalRowHeight={terminalRowHeight}
      isAgentStarting={runtime.isAgentStarting}
      isRestarting={runtime.isRestartingThisAgent}
      sessionDuration={runtime.sessionDuration}
      showThinking={services.showThinking}
      validCommandNames={services.validCommandNames}
      validFilePaths={services.validFilePaths}
      onPreviewImage={services.onPreviewImage}
      onOpenFile={openPaneFile}
      onDiffFile={services.onDiffFile}
      onResendUserMessage={canResend ? services.resendUserMessage : undefined}
      onEditMessage={canEditOrDeleteMessages ? services.editMessage : undefined}
      onDeleteMessage={canEditOrDeleteMessages ? services.deleteMessage : undefined}
      onForkMessage={services.forkFromUserMessage}
      onRewindToMessage={isDshBackend ? undefined : handleRewindToMessage}
      forkingMessageId={services.forkingMessageId}
      onToast={(message: string) => services.showToast(message)}
      onQuickPrompt={(message) => services.insertQuickPrompt(currentSessionId, message)}
      canMutateActiveMessages={canMutateActiveMessages}
      onOpenBranchSession={
        services.activeProjectId && services.openSidebarSessionById
          ? (sessionId: string) => {
              void services.openSidebarSessionById?.(services.activeProjectId!, sessionId);
            }
          : undefined
      }
      enqueueSessionPrompt={services.enqueueSessionPrompt}
      gitInfo={services.gitInfo}
      onSwitchBranch={services.onSwitchBranch}
      ensureSessionId={services.ensureSessionId}
      runtimeUi={
        runtimeUiResponder ? (
          <SessionRuntimeUiOverlay
            sessionId={currentSessionId}
            runtime={currentSessionRuntime}
            ui={currentSessionRuntimeUi}
            responder={runtimeUiResponder}
            // 展开工具/思考卡片不应抢夺用户当前滚动位置；只有新消息进入时由时间线控制自动贴底。
            onExpandedChange={() => undefined}
          />
        ) : null
      }
      queuePanel={
        currentSessionId ? (
          <QueuedPromptPanel
            trackRef={queuedTrackRef}
            sessionId={currentSessionId}
            prompts={activeQueuedPrompts}
            visiblePrompts={activeQueuedPrompts}
            onRetract={services.queueRetract}
            onDiscard={services.queueDiscard}
            onChangeBehavior={services.queueChangeBehavior}
          />
        ) : undefined
      }
      terminalDockVisible={paneTerminalDockVisible}
      terminalOpen={paneTerminalOpen}
      // 本栏 dock 卸载不播关闭动画（面板随 open 立即卸载，closing 只在 App 级空态路径有意义）
      terminalDockClosing={false}
      terminalCollapsed={paneTerminalCollapsed}
      availableTerminalHeight={services.availableTerminalHeight ?? 120}
      terminalOwnerKey={paneOwnerKey}
      terminalTarget={paneTerminal?.target}
      setTerminalOpenForOwner={setPaneTerminalOpen}
      setTerminalCollapsedForOwner={setPaneTerminalCollapsed}
      setTerminalHeight={services.setTerminalHeight}
      settingsOpen={settingsOpen}
      environmentDialog={services.environmentDialog}
      runCreateSessionDraft={services.runCreateSessionDraft}
      abortAgent={services.abortAgent}
    />
    {rewindConfirm && (
      <ConfirmDialog
        title={t("rewind.restoreConfirmTitle")}
        message={t("rewind.restoreConfirmMessage", {
          id: rewindConfirm.id,
          time: formatRelativeTime(rewindConfirm.timestamp),
        })}
        confirmLabel={t("rewind.restoreConfirmRestore")}
        danger
        onConfirm={() => void performRewindRestore()}
        onCancel={() => setRewindConfirm(null)}
      />
    )}
  </>
    </FileLinkBaseProvider>
  );
});
