import { useEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import type { AgentTab, SessionRecord, SessionRuntimeTarget } from "../../../shared/types";
import {
  currentSessionAtom,
  currentSessionIdAtom,
  currentSessionRuntimeAtom,
  currentSessionRuntimeUiAtom,
  sessionRecordsAtom,
  sessionRuntimeUiByIdAtom,
} from "../atoms/session-atoms";
import { currentSessionSendStateAtom } from "../atoms/composer-atoms";
import type { QueuedPrompt } from "./useQueuedPrompt";
import { t } from "../i18n";

// ── narrow selector (stable unless agentId changes; streaming state updates do NOT change this) ──

export const activeAgentIdAtom = selectAtom(
  currentSessionRuntimeAtom,
  (rt) => rt?.agentId,
);

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
  canStopSession: boolean;
  canRestartSession: boolean;
  sessionDuration: number | undefined;
  isRestartingThisAgent: boolean;
  sessionHasProject: boolean;
}

export interface UseSessionRuntimeControllerOptions {
  agents: AgentTab[];
  queueFlushBySessionRef: React.MutableRefObject<Set<string>>;
  activeQueuedPrompts: QueuedPrompt[];
  restartingAgentId: string | null;
  sessionDurationByAgent: Record<string, number>;
  activeProjectId: string | undefined;
  showNotice: (message: string, duration?: number, kind?: "info" | "warning" | "error") => void;
}

export function useSessionRuntimeController(
  options: UseSessionRuntimeControllerOptions,
): SessionRuntimeController {
  const {
    agents,
    queueFlushBySessionRef,
    activeQueuedPrompts,
    restartingAgentId,
    sessionDurationByAgent,
    activeProjectId,
    showNotice,
  } = options;

  const currentSessionId = useAtomValue(currentSessionIdAtom);
  const currentSession = useAtomValue(currentSessionAtom);
  const currentSessionRuntime = useAtomValue(currentSessionRuntimeAtom);
  const currentSessionRuntimeUi = useAtomValue(currentSessionRuntimeUiAtom);
  const sessionRuntimeUiById = useAtomValue(sessionRuntimeUiByIdAtom);
  const sessionRecords = useAtomValue(sessionRecordsAtom);
  const currentSessionSendState = useAtomValue(currentSessionSendStateAtom);
  const activeAgentId = useAtomValue(activeAgentIdAtom);
	const runtimeTarget = currentSessionId && currentSessionRuntime?.agentId
		? {
			sessionId: currentSessionId,
			agentId: currentSessionRuntime.agentId,
			runtimeGeneration: currentSessionRuntime.runtimeGeneration,
		}
		: undefined;
  const activeAgent = activeAgentId
    ? agents.find((a) => a.id === activeAgentId)
    : undefined;

  // The renderer-only Chat bootstrap ID has no Catalog record until first send,
  // yet it must render the empty surface and composer without an Agent.
  const hasActiveConversation = Boolean(currentSessionId);

  // ── runtime state (declared early, used by isAgentBusy) ──

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

  const isAgentStarting =
    activeConversationStatus === "starting" ||
    currentSessionSendState.status === "activating";

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

  const canStopSession = activeAgent?.status === "running";

  const canRestartSession = Boolean(
    currentSessionId &&
    activeAgentId &&
    activeAgent &&
    activeAgent.status !== "starting" &&
    restartingAgentId !== activeAgentId &&
    !queueFlushBySessionRef.current.has(currentSessionId) &&
    !activeQueuedPrompts.some(
      (qp: QueuedPrompt) => qp.status === "sending" || qp.status === "unknown",
    ),
  );

  const isRestartingThisAgent = restartingAgentId === activeAgentId;

  const sessionDuration = activeAgentId
    ? sessionDurationByAgent[activeAgentId]
    : undefined;

  const sessionHasProject = Boolean(activeProjectId);

  // ── UI notification effect ──

  const lastNoticeRef = useRef("");
  const notifiedBackgroundAskRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const notification = currentSessionRuntimeUi?.notification;
    if (!currentSessionId || !notification) return;
    const key = `${currentSessionId}:${currentSessionRuntimeUi.runtimeGeneration}:${notification.revision}`;
    if (lastNoticeRef.current === key) return;
    lastNoticeRef.current = key;
    showNotice(
      notification.message,
      notification.notifyType === "error" || notification.notifyType === "warning" ? 3000 : 1500,
      notification.notifyType,
    );
  }, [currentSessionId, currentSessionRuntimeUi, showNotice]);

  useEffect(() => {
    for (const [sessionId, runtimeUi] of Object.entries(sessionRuntimeUiById)) {
      if (sessionId === currentSessionId) continue;
      const pendingAsk = Object.values(runtimeUi.requests).find(({ request, status }) =>
        status === "pending" && ["select", "confirm", "input", "editor", "batch_ask"].includes(request.method),
      );
      if (!pendingAsk) continue;

      const key = `${sessionId}:${runtimeUi.runtimeGeneration}:${pendingAsk.request.requestId}`;
      if (notifiedBackgroundAskRef.current.has(key)) continue;
      notifiedBackgroundAskRef.current.add(key);
      // Ask 属于阻塞式交互，不能像普通提示一样自动消失；用户切回会话处理后可手动关闭。
      const title = sessionRecords[sessionId]?.title?.trim() || pendingAsk.request.title || t("ask.defaultTitle");
      showNotice(t("ask.backgroundPending", { title }), Number.POSITIVE_INFINITY, "warning");
    }
    // 限制长期运行时的去重集合，避免大量历史会话累积内存。
    if (notifiedBackgroundAskRef.current.size > 200) {
      notifiedBackgroundAskRef.current = new Set(
        Array.from(notifiedBackgroundAskRef.current).slice(-100),
      );
    }
  }, [currentSessionId, sessionRecords, sessionRuntimeUiById, showNotice]);

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
    canStopSession,
    canRestartSession,
    sessionDuration,
    isRestartingThisAgent,
    sessionHasProject,
  };
}
