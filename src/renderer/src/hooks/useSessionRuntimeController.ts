import { useEffect, useMemo, useRef } from "react";
import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import type { AgentTab, SessionRecord, SessionRuntimeTarget } from "../../../shared/types";
import {
  currentSessionIdAtom,
  currentSessionRuntimeAtom,
  sessionRecordsAtom,
  sessionRuntimeUiByIdAtom,
} from "../atoms/session-atoms";
import {
  sessionRecordByIdAtomFamily,
  sessionRuntimeBySessionIdAtomFamily,
  sessionRuntimeUiBySessionIdAtomFamily,
} from "../atoms/session-selectors";
import { sessionSendStateByIdAtom } from "../atoms/composer-atoms";
import {
  resolveSessionRunState,
  sessionRunCapabilities,
  type SessionRunCapabilities,
} from "../utils/sessionCommands";
import { isUserFacingSessionStart } from "./useSessionTimelineController";
import type { QueuedPrompt } from "./useQueuedPrompt";
import { t } from "../i18n";
import { dismissNotice, type NoticeActions, type NoticeId } from "../utils/notice";
import {
  describeBackgroundAsk,
  forgetBackgroundAsk,
  getRememberedBackgroundAskKeys,
  getRuntimeNotificationKey,
  rememberBackgroundAsk,
  rememberRuntimeNotification,
} from "../utils/runtimeNotification";

// ── narrow selector（供 App 等「当前聚焦会话 agentId」消费者）──

export const activeAgentIdAtom = selectAtom(
  currentSessionRuntimeAtom,
  (rt) => rt?.agentId,
);

// Ask 提醒的 Toast 句柄跨 Tab 生命周期存在，不能放在单个 hook 实例的 ref 中。
const backgroundAskNoticeIdMap = new Map<string, NoticeId>();

// ── types ──

interface RuntimeStateLike {
  isStreaming?: boolean;
  [key: string]: unknown;
}

export interface SessionRuntimeController {
  currentSessionId: string | undefined;
  currentSession: SessionRecord | undefined;
  activeAgentId: string | undefined;
  activeRuntimeState: RuntimeStateLike | undefined;
  runtimeTarget: SessionRuntimeTarget | undefined;
  activeConversationStatus: "starting" | "running" | "idle" | undefined;
  hasActiveConversation: boolean;
  isAgentStarting: boolean;
  isAgentBusy: boolean;
  currentSessionLiveAgentId: string | undefined;
  canMutateActiveMessages: boolean;
  /** 全状态运行控制能力（与 Tab 下拉/侧栏菜单同源） */
  runCapabilities: SessionRunCapabilities;
  sessionDuration: number | undefined;
  isRestartingThisAgent: boolean;
  sessionHasProject: boolean;
}

export interface UseSessionRuntimeControllerOptions {
  /** 绑定到指定会话；缺省则跟随 currentSessionIdAtom。 */
  sessionId?: string;
  agents: AgentTab[];
  queueFlushBySessionRef: React.MutableRefObject<Set<string>>;
  activeQueuedPrompts: QueuedPrompt[];
  restartingAgentId: string | null;
  sessionDurationByAgent: Record<string, number>;
  activeProjectId: string | undefined;
  showNotice: (
    message: string,
    duration?: number,
    kind?: "info" | "warning" | "error",
    title?: string,
    actions?: NoticeActions,
  ) => NoticeId | undefined;
  /** Ask 提醒的「前往会话」动作：跳转到等待回答的会话（渲染层提供，不依赖主进程）。 */
  onFocusSession?: (sessionId: string) => void;
}

const idleSendState = { status: "idle" as const };

/**
 * 会话 runtime 视图模型：始终按 sessionId 订阅 family，
 * 避免分屏时非聚焦栏被「另一栏的 current* 流式更新」牵连重渲染。
 */
export function useSessionRuntimeController(
  options: UseSessionRuntimeControllerOptions,
): SessionRuntimeController {
  const {
    sessionId: boundSessionIdOption,
    agents,
    queueFlushBySessionRef,
    activeQueuedPrompts,
    restartingAgentId,
    sessionDurationByAgent,
    activeProjectId,
    showNotice,
    onFocusSession,
  } = options;

  const focusedSessionId = useAtomValue(currentSessionIdAtom);
  const currentSessionId = boundSessionIdOption ?? focusedSessionId;
  const isFocusedPane = currentSessionId === focusedSessionId;
  const sessionKey = currentSessionId ?? "";

  const recordAtom = useMemo(() => sessionRecordByIdAtomFamily(sessionKey), [sessionKey]);
  const runtimeAtom = useMemo(() => sessionRuntimeBySessionIdAtomFamily(sessionKey), [sessionKey]);
  const runtimeUiAtom = useMemo(() => sessionRuntimeUiBySessionIdAtomFamily(sessionKey), [sessionKey]);
  const sendAtom = useMemo(
    () =>
      selectAtom(
        sessionSendStateByIdAtom,
        (states) => (sessionKey ? (states[sessionKey] ?? idleSendState) : idleSendState),
        Object.is,
      ),
    [sessionKey],
  );

  const currentSession = useAtomValue(recordAtom);
  const currentSessionRuntime = useAtomValue(runtimeAtom);
  const currentSessionRuntimeUi = useAtomValue(runtimeUiAtom);
  const currentSessionSendState = useAtomValue(sendAtom);

  const sessionRuntimeUiById = useAtomValue(sessionRuntimeUiByIdAtom);
  const sessionRecords = useAtomValue(sessionRecordsAtom);

  const activeAgentId = currentSessionRuntime?.agentId;
  const runtimeTarget =
    currentSessionId && currentSessionRuntime?.agentId
      ? {
          sessionId: currentSessionId,
          agentId: currentSessionRuntime.agentId,
          runtimeGeneration: currentSessionRuntime.runtimeGeneration,
        }
      : undefined;
  const activeAgent = activeAgentId
    ? agents.find((a) => a.id === activeAgentId)
    : undefined;

  const hasActiveConversation = Boolean(currentSessionId);

  const activeRuntimeState: RuntimeStateLike | undefined = currentSessionId
    ? ((currentSessionRuntime?.state as RuntimeStateLike | undefined) ??
      (currentSession?.model || currentSession?.thinkingLevel
        ? {
            provider: currentSession.model?.provider,
            modelId: currentSession.model?.modelId,
            modelName: currentSession.model?.modelId,
            thinkingLevel: currentSession.thinkingLevel,
          }
        : undefined))
    : undefined;

  const activeConversationStatus: "starting" | "running" | "idle" | undefined =
    currentSessionId
      ? ((currentSessionRuntime?.status as "starting" | "running" | "idle" | undefined) ??
        (currentSessionSendState.status === "activating" ? "starting" : "idle"))
      : undefined;

  // 标题栏 loading / 输入框禁用只跟用户发送走；后台预热的 runtime starting 不能顶高顶栏。
  const isAgentStarting = isUserFacingSessionStart(currentSessionSendState.status);

  const isAgentBusy = Boolean(
    hasActiveConversation &&
    (activeConversationStatus === "running" ||
      activeRuntimeState?.isStreaming),
  );

  const currentSessionLiveAgentId =
    currentSessionRuntime?.agentId === activeAgentId &&
    activeAgent &&
    activeAgent.status !== "closed" &&
    activeAgent.status !== "error"
      ? activeAgent.id
      : undefined;

  const canMutateActiveMessages = Boolean(currentSessionLiveAgentId);

  // ── SessionView shortcuts ──

  /**
   * 会话运行控制能力（全状态）：与 Tab 下拉 / 侧栏菜单共用同一套策略函数，
   * 保证「同一会话在任何入口看到的可用性一致」。旧的 canStopSession /
   * canRestartSession 布尔已由 capabilities + canRunSessionAction 取代。
   */
  const runCapabilities = sessionRunCapabilities({
    state: resolveSessionRunState(currentSessionRuntime, Boolean(runtimeTarget)),
    hasBinding: Boolean(runtimeTarget),
    busy: Boolean(restartingAgentId && restartingAgentId === activeAgentId),
    hasInFlightQueuedPrompt: activeQueuedPrompts.some(
      (qp: QueuedPrompt) => qp.status === "sending" || qp.status === "unknown",
    ),
  });

  const isRestartingThisAgent = restartingAgentId === activeAgentId;
  const sessionDuration = activeAgentId
    ? sessionDurationByAgent[activeAgentId]
    : undefined;
  const sessionHasProject = Boolean(activeProjectId);

  // Ask 提醒会跨 Tab 等待；去重 key 与 toast 句柄都由 renderer 进程级模块持有。

  useEffect(() => {
    const notification = currentSessionRuntimeUi?.notification;
    if (!currentSessionId || !notification) return;
    const key = getRuntimeNotificationKey(
      currentSessionId,
      currentSessionRuntimeUi.runtimeGeneration,
      notification.requestId,
    );
    if (!rememberRuntimeNotification(key)) return;
    // 异常提示（error）常驻不自动消失：会话失败/重试类通知需要用户看到并处理，
    // 自动消失（默认 3s）容易错过；info 保持短时反馈。
    showNotice(
      notification.message,
      notification.notifyType === "error"
        ? Number.POSITIVE_INFINITY
        : notification.notifyType === "warning" ? 3000 : 1500,
      notification.notifyType,
    );
  }, [currentSessionId, currentSessionRuntimeUi, showNotice]);

  useEffect(() => {
    if (!isFocusedPane) return;
    const activeBackgroundKeys = new Set<string>();
    const pendingAskKeys = new Set<string>();
    for (const [sessionId, runtimeUi] of Object.entries(sessionRuntimeUiById)) {
      const pendingAsk = Object.values(runtimeUi.requests).find(({ request, status }) =>
        (status === "pending" || status === "responding") &&
        ["select", "confirm", "input", "editor", "batch_ask"].includes(request.method),
      );
      if (!pendingAsk) continue;

      const key = `${sessionId}:${runtimeUi.runtimeGeneration}:${pendingAsk.request.requestId}`;
      pendingAskKeys.add(key);
      // 不按聚焦会话过滤：任何会话的 Ask（含当前 Tab）都弹 toast 提醒
      activeBackgroundKeys.add(key);
      if (!rememberBackgroundAsk(key)) continue;
      const display = describeBackgroundAsk({
        sessionName: sessionRecords[sessionId]?.title,
        requestTitle: pendingAsk.request.title,
        defaultSessionName: t("ask.defaultTitle"),
      });
      const message = display.question
        ? t("ask.backgroundPendingDetail", { title: display.sessionName, question: display.question })
        : t("ask.backgroundPending", { title: display.sessionName });
      const noticeId = showNotice(message, Number.POSITIVE_INFINITY, "warning", undefined, {
        action: onFocusSession
          ? { label: t("ask.jumpToSession"), onClick: () => onFocusSession(sessionId) }
          : undefined,
      });
      if (noticeId !== undefined) backgroundAskNoticeIdMap.set(key, noticeId);
    }

    // 仅当 Ask 不再 pending（已回答/取消）时撤掉对应浮层；通知 key 保留到 Ask 真正完成，避免来回切换反复弹出。
    for (const [key, noticeId] of backgroundAskNoticeIdMap) {
      if (activeBackgroundKeys.has(key)) continue;
      dismissNotice(noticeId);
      backgroundAskNoticeIdMap.delete(key);
    }

    // 只有请求已经回答/取消，才回收去重 key；切换焦点不算 Ask 生命周期结束。
    for (const key of getRememberedBackgroundAskKeys()) {
      if (!pendingAskKeys.has(key)) forgetBackgroundAsk(key);
    }
  }, [focusedSessionId, isFocusedPane, sessionRecords, sessionRuntimeUiById, showNotice, onFocusSession]);

  return {
    currentSessionId,
    currentSession,
    activeAgentId,
    activeRuntimeState,
    runtimeTarget,
    activeConversationStatus,
    hasActiveConversation,
    isAgentStarting,
    isAgentBusy,
    currentSessionLiveAgentId,
    canMutateActiveMessages,
    runCapabilities,
    sessionDuration,
    isRestartingThisAgent,
    sessionHasProject,
  };
}
