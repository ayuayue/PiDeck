import { useAtomValue, useSetAtom, useStore } from "jotai";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type {
  AgentBackend,
  ChatMessage,
  ComposerAgentMode,
  FileTreeNode,
  ImageContent,
  PiCommand,
  ResolvedLaunchDefaults,
  SessionSummary,
} from "../../../shared/types";
import {
  DEFAULT_IMAGE_GEN_OUTPUT_FORMAT,
  DEFAULT_IMAGE_GEN_SIZE,
  DEFAULT_IMAGE_GEN_WATERMARK,
  parseImageGenOutputFormat,
  parseImageGenSize,
  parseImageGenWatermark,
} from "../../../shared/imageGenParams";
import { resolveBusySendDelivery } from "../../../shared/busySendDelivery";
import { FILE_TREE_ABSOLUTE_MAX_DEPTH } from "../../../shared/fileTree";
import {
  classifyCompactError,
  resolveCompactUsagePercent,
  shouldSkipCompactForLowUsage,
  type CompactNoticeKind,
} from "../../../shared/compactFeedback";
import { findImageGenProvider } from "../../../shared/imageGenConfig";
import type { ImageGenMeta } from "../../../shared/types/imagegen";
import {
  busySendDeliveryAtom,
  cacheSessionMessagesAtom,
  effectiveAgentBackendAtom,
  imageGenConfigAtom,
  projectByIdAtomFamily,
  sessionAttachmentsByIdAtom,
  sessionComposerModeByIdAtom,
  sessionDraftByIdAtom,
  sessionMessagesCacheAtom,
  sessionPasteFilesByIdAtom,
  sessionRecordByIdAtomFamily,
  sessionRuntimeBySessionIdAtomFamily,
  sessionRuntimeUiBySessionIdAtomFamily,
  sessionQuotesByIdAtom,
  sessionSendStateByIdAtom,
  sessionSummariesByProjectIdAtomFamily,
  setSessionAttachmentsAtom,
  setSessionComposerModeAtom,
  setSessionDraftAtom,
  setSessionPasteFilesAtom,
  setSessionSendStateAtom,
  upsertSessionAtom,
  type PastedTextFile,
} from "../atoms";
import {
  appendContentToDraft,
  appendSlashCommandToDraft,
  stripMarkdownFrontmatter,
  toSkillInvocationToken,
  getComposerEnterIntent,
  isComposingKeyboardEvent,
  isPlanModeSendKey,
  parseArgumentHint,
  translateBuiltinPromptDescription,
  extractUserPrompts,
  mergePromptHistory,
  deriveComposerAgentMode,
  type PromptTemplateInfo,
} from "../composerBehavior";
import {
  applySuggestion,
  buildSuggestionItems,
  clearSuggestionTrigger,
  detectTrigger,
  DSH_COMMAND_SUGGESTIONS,
  fileNodeDragPayloadToRef,
  flattenFiles,
  mergeCommands,
  PI_FILE_NODE_DRAG_MIME,
  PI_FILE_PATH_DRAG_MIME,
  readFileNodeDragPayload,
  type SuggestionItem,
} from "../components/app/AppUtils";
import { SESSION_TAB_DRAG_MIME } from "../utils/sessionSplitEdge";
import {
  mergeFileTreeChildren,
  resolveAtDrillDirectory,
  shouldLoadFullTreeForAtSearch,
} from "../utils/fileTreeLazy";
import {
  formatFilePathRef,
  type ComposerChip,
} from "../components/session/composer/chips";
import type { ComposerCaretRequest } from "../components/session/composer/types";
import {
  getComposerCaretCoords,
  getComposerCaretOffset,
} from "../components/session/composer/caretCoords";
import { desktopApi } from "../desktopApi";
import { formatBytes } from "../../../shared/formatBytes";
import { t } from "../i18n";
import {
  COMPOSER_IMAGE_MAX_BYTES,
  ComposerImageError,
  dataUrlToFile,
  getClipboardImageFiles,
  getDroppedImageFiles,
  imageMimeTypeFromPath,
  isImageFilePath,
  processComposerImageFile,
} from "../utils/composerImages";
import { PASTE_TO_FILE_MIN_CHARS } from "../rendererUtils";
import { resolveBackendSwitchDefaults } from "../utils/backendSwitchDefaults";
import { showNotice } from "../utils/notice";
import {
  requireSessionCommand,
  toSessionRuntimeTarget,
} from "../utils/sessionCommands";
import { isSessionRuntimeBusy, isUserFacingSessionStart } from "./useSessionTimelineController";
import { truncateQuoteLabel } from "../components/session/composer/quoteChip";
import { useSessionSend, type EnqueuePromptSnapshot } from "./useSessionSend";

/** 统一压缩结果 → 用户可见文案；silent 不弹 toast。 */
function compactNotice(kind: CompactNoticeKind, detail?: string): string | null {
  switch (kind) {
    case "done":
      return t("app.compactDone");
    case "nothingToDo":
      return t("app.compactNothingToDo");
    case "tooSmall":
      return t("app.compactSessionTooSmall");
    case "inProgress":
      return t("app.compactInProgress");
    case "silent":
      return null;
    case "failed":
      return detail
        ? t("app.compactFailedWithReason", { error: detail })
        : t("app.compactFailed");
  }
}

/**
 * compact 错误友好文案：requireSessionCommand 的 message 是 i18n 通用失败，
 * pi 原错在 debugDetails。分类走 shared/compactFeedback（按钮 / /compact 共用）。
 * silent：压缩被取消（自动压缩撞车 / 新消息打断）不弹 toast——取消响应可能
 * 延迟到正常对话后返回（RPC 最长 120s），表现为「没点压缩却弹提示」。
 */
function friendlyCompactError(error: unknown): string | null {
  const debugDetails =
    error && typeof error === "object" && "debugDetails" in error
      ? String((error as { debugDetails?: unknown }).debugDetails ?? "").trim()
      : "";
  const rawMessage = error instanceof Error ? error.message.trim() : String(error ?? "").trim();
  const raw = debugDetails || rawMessage;
  const detail = raw
    .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
  return compactNotice(classifyCompactError(detail), detail);
}

export type ComposerPickerKind = "model" | "thinking" | "template" | "skill";

export type UseSessionComposerControllerOptions = {
  sessionId: string;
  /**
   * 引导页等无 record 虚拟会话的项目上下文（ProjectEmptyState 经
   * SessionStartSurface 传选中的 activeProject.id）。有 record 时一律以
   * record.projectId 为准；仅给 @ 文件引用/默认偏好提供项目来源，不参与
   * 会话创建（发送仍由 App.ensureSessionForSend 落地）。
   */
  bootstrapProjectId?: string;
  ensureSessionId?: (sessionId: string) => Promise<string>;
  /** 用户主动发消息时回调（预览 Tab 晋升常驻）；来自 SessionPaneServices 装配。 */
  onPromoteSession?: (sessionId: string) => void;
  /** `/new` 拦截后新建会话（与侧栏 + 同源）；来自 SessionPaneServices。 */
  onCreateSession?: () => Promise<void>;
  /** Passed through to useSessionSend.enqueue. */
  enqueue?: (sessionId: string, snapshot: EnqueuePromptSnapshot) => boolean;
};

export type ComposerDraftGuard = {
  sessionId: string;
  agentId?: string;
  runtimeGeneration: number;
  baselineDraft: string;
  version: number;
  pristine: boolean;
};

export function createComposerDraftGuard(input: {
  sessionId: string;
  agentId?: string;
  runtimeGeneration?: number;
  draft: string;
}): ComposerDraftGuard {
  return {
    sessionId: input.sessionId,
    agentId: input.agentId,
    runtimeGeneration: input.runtimeGeneration ?? 0,
    baselineDraft: input.draft,
    version: 0,
    pristine: input.draft.length === 0,
  };
}

export function markComposerDraftMutation(
  guard: ComposerDraftGuard,
): ComposerDraftGuard {
  return { ...guard, version: guard.version + 1, pristine: false };
}

export function canApplyRuntimeEditorText(
  guard: ComposerDraftGuard,
  input: {
    sessionId: string;
    agentId: string;
    runtimeGeneration: number;
    currentDraft: string;
  },
): boolean {
  return guard.sessionId === input.sessionId &&
    guard.agentId === input.agentId &&
    guard.runtimeGeneration === input.runtimeGeneration &&
    guard.pristine &&
    guard.baselineDraft === input.currentDraft;
}

export type LatestRequestToken = { key: string; sequence: number };

export function createLatestRequestGate() {
  let current = { key: "", sequence: 0 };
  return {
    begin(key: string): LatestRequestToken {
      current = { key, sequence: current.sequence + 1 };
      return current;
    },
    invalidate(key: string) {
      current = { key, sequence: current.sequence + 1 };
    },
    isCurrent(token: LatestRequestToken) {
      return token.key === current.key && token.sequence === current.sequence;
    },
  };
}

type SessionReferenceMessage = {
  role: string;
  content: string;
  timestamp: number;
};

export type SessionReferenceSelection = {
  selectedIndices: number[];
  entries: Array<{ index: number; message: SessionReferenceMessage }>;
};

export function createSessionReferenceSelection(
  selectedIndices: number[],
  selectedMessages: SessionReferenceMessage[],
): SessionReferenceSelection {
  const entries = selectedIndices
    .map((index, position) => ({ index, message: selectedMessages[position] }))
    .filter((entry): entry is { index: number; message: SessionReferenceMessage } =>
      Boolean(entry.message),
    );
  return { selectedIndices: entries.map((entry) => entry.index), entries };
}

export function selectedSessionReferenceMessages(
  selection: SessionReferenceSelection,
): SessionReferenceMessage[] {
  return [...selection.entries]
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.message);
}

function getBangMode(text: string): "none" | "bang" | "bang-bang" {
  if (text.startsWith("!!")) return "bang-bang";
  if (text.startsWith("!")) return "bang";
  return "none";
}

function composerImageNotice(error: unknown): string {
  if (error instanceof ComposerImageError) {
    if (error.code === "too-large") return t("app.imageTooLarge");
    if (error.code === "unsupported") return t("app.imageUnsupported");
  }
  return error instanceof Error ? error.message : String(error);
}

export function useSessionComposerController(
  options: UseSessionComposerControllerOptions,
) {
  const { sessionId, enqueue, ensureSessionId } = options;
  const store = useStore();
  const record = useAtomValue(sessionRecordByIdAtomFamily(sessionId));
  // 引导页虚拟会话没有 record：文件树/@ 引用回退到引导页选中的项目，
  // 否则 files 恒为空、@ 输入永远匹配不到任何文件。
  const effectiveProjectId = record?.projectId ?? options.bootstrapProjectId;
  // 粘贴转文件/@ 引用的项目路径来源：catalog 会话 record 不一定携带 projectPath
  // （主进程扫描只在会话文件位于项目内时才推断，旧数据/独立目录会话恒缺省），
  // 统一经 projectId 反查项目清单，拿到已登记的项目根路径，避免把有项目会话
  // 误当成匿名会话（用户反馈：粘贴大文本发送后消息里被展开成普通文本）。
  const composerProject = useAtomValue(
    projectByIdAtomFamily(effectiveProjectId ?? ""),
  );
  const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(sessionId));
  const runtimeUi = useAtomValue(sessionRuntimeUiBySessionIdAtomFamily(sessionId));
  const projectSessions = useAtomValue(
    sessionSummariesByProjectIdAtomFamily(effectiveProjectId ?? ""),
  );
  const drafts = useAtomValue(sessionDraftByIdAtom);
  const attachmentsBySession = useAtomValue(sessionAttachmentsByIdAtom);
  const pasteFilesBySession = useAtomValue(sessionPasteFilesByIdAtom);
  const modes = useAtomValue(sessionComposerModeByIdAtom);
  const sendStates = useAtomValue(sessionSendStateByIdAtom);
  const messageCache = useAtomValue(sessionMessagesCacheAtom);
  const imageGenConfig = useAtomValue(imageGenConfigAtom);
  const setImageGenConfig = useSetAtom(imageGenConfigAtom);
  const setDraftAtom = useSetAtom(setSessionDraftAtom);
  const setAttachmentsAtom = useSetAtom(setSessionAttachmentsAtom);
  const setPasteFilesAtom = useSetAtom(setSessionPasteFilesAtom);
  const setModeAtom = useSetAtom(setSessionComposerModeAtom);
  const setSendStateAtom = useSetAtom(setSessionSendStateAtom);
  const setCacheMessages = useSetAtom(cacheSessionMessagesAtom);

  const draft = drafts[sessionId] ?? "";
  const attachments = attachmentsBySession[sessionId] ?? [];
  const pasteFiles = pasteFilesBySession[sessionId] ?? [];
  // DSH：plan 由 host 持有；goal 由本地选择或进行中/阻塞的目标驱动（切回普通会 pause）。
  // 生图为独立供应商配置，不属于 pi/dsh 任一后端，两种后端均可用。
  const isDshBackend = record?.backend === "dsh" || runtime?.backend === "dsh";
  const hasImageGenHistory = (messageCache[sessionId]?.messages ?? []).some(
    (message) => Boolean(message.meta?.imageGen),
  );
  // 生图供应商/模型来自独立 imagegen.json，与会话 LLM 模型无关。
  const activeImageGenProviderId = imageGenConfig.activeProviderId;
  const activeImageGenModelId = imageGenConfig.activeModel;
  const mode: ComposerAgentMode = record?.backend === "imagegen" || hasImageGenHistory
    ? "imagegen"
    : deriveComposerAgentMode({
    backend: isDshBackend ? "dsh" : "pi",
    localMode: modes[sessionId],
    planModeActive: runtime?.state?.planModeActive === true,
    goalPhase: runtime?.state?.goal?.phase,
  });
  const sendState = sendStates[sessionId] ?? { status: "idle" as const };
  // DSH 部署默认模型选择（settings.yaml agent-default-model）：草稿/未激活会话
  // 的底栏与选择器用它展示默认模型/思考档位（host 会话创建前没有 runtime state）。
  // settings.yaml 未配 reasoningEffort 时，回退到默认模型自身的 defaultEffort
  // （DSH 官方语义：每个模型都有 reasoning.defaultEffort）。
  const [dshDefault, setDshDefault] = useState<{
    provider: string;
    model: string;
    reasoningEffort?: string;
    defaultEffort?: string;
  } | undefined>(undefined);
  useEffect(() => {
    if (!isDshBackend) {
      // 离开 dsh 后端（切回 pi/生图）时清掉残留的 DSH 部署默认模型：
      // 底栏 defaultModel = dshDefaultModel ?? bootstrapDefaultModel，
      // 残留会让 pi 会话误显示 DSH 的默认模型（用户反馈「切回 pi 默认模型变了」）。
      setDshDefault(undefined);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const next = await desktopApi.sessions.getDshDefaultModel();
        if (!next || cancelled) {
          if (!cancelled) setDshDefault(next);
          return;
        }
        let defaultEffort = next.reasoningEffort;
        if (!defaultEffort) {
          try {
            const models = await desktopApi.sessions.listDshModels();
            const defaultModel = models.find(
              (model) => model.provider === next.provider && model.id === next.model,
            );
            defaultEffort = defaultModel?.defaultEffort;
          } catch {
            // 目录读取失败不影响 settings.yaml 的默认模型展示。
          }
        }
        if (!cancelled) setDshDefault({ ...next, defaultEffort });
      } catch {
        if (!cancelled) setDshDefault(undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isDshBackend]);
  // 引导页虚拟会话（无 record）：预取主进程解析的启动默认（与 createDraft 缺省
  // 同一解析器 launchDefaults），让底栏/选择器在用户从未设置欢迎页偏好时也能
  // 显示当前默认模型/思考档位。真实会话的默认值写在 record 里走原链路，
  // 不需要这里重复解析。
  // 读「有效」后端（经 DSH runtime 安装态钳制）：引导页预取的启动默认不会指向不可用后端。
  const defaultAgentBackend = useAtomValue(effectiveAgentBackendAtom);
  const [bootstrapDefaults, setBootstrapDefaults] = useState<ResolvedLaunchDefaults | undefined>(undefined);
  useEffect(() => {
    if (record) return;
    let cancelled = false;
    void desktopApi.sessions.resolveLaunchDefaults({ backend: defaultAgentBackend })
      .then((next) => {
        if (!cancelled) setBootstrapDefaults(next);
      })
      .catch(() => {
        // 解析失败退回“无预选”形态：底栏不显示默认模型，但不影响发送。
        if (!cancelled) setBootstrapDefaults(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [defaultAgentBackend, record]);
  const editorRef = useRef<HTMLDivElement | null>(null);
  // 程序化光标请求（带归属 forValue，见 composer/types.ts 的 ComposerCaretRequest）；
  // 编辑器只在内容同步到 forValue 的同一趟 layout pass 配对消费，过期请求会被丢弃。
  const caretRef = useRef<ComposerCaretRequest | null>(null);
  const liveDomDraftRef = useRef({ sessionId, value: draft });
  const draftGuardRef = useRef(createComposerDraftGuard({
    sessionId,
    agentId: runtime?.agentId,
    runtimeGeneration: runtime?.runtimeGeneration,
    draft,
  }));
  const templateRequestGateRef = useRef(createLatestRequestGate());
  const promptHistoryRef = useRef<Record<string, string[]>>({});
  /**
   * 当前会话可导航的输入历史 = 本次运行发送记录（promptHistoryRef，最新在前）
   * + 会话已有消息里的用户输入（从 sessionMessagesCacheAtom 懒读取，零订阅零重渲染）。
   * 未启动的 Agent 没有发送记录，但 timeline 加载会话时已把 disk 消息写入缓存，
   * 因此激活前后上下键历史行为一致（issue-139）。
   */
  const getPromptHistory = useCallback(() => {
    const runtimeHistory = promptHistoryRef.current[sessionId] ?? [];
    const sessionHistory = extractUserPrompts(
      store.get(sessionMessagesCacheAtom)[sessionId]?.messages ?? [],
    );
    return mergePromptHistory(runtimeHistory, sessionHistory);
  }, [sessionId, store]);
  const lastEditorTextEnvelopeRef = useRef("");
  const [cursor, setCursor] = useState(0);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [savedDraft, setSavedDraft] = useState("");
  const [busyDraftLocked, setBusyDraftLocked] = useState(false);
  const [previewImage, setPreviewImage] = useState<ImageContent | null>(null);
  // 生图进行中：置 true 时发送按钮禁用（避免并发多次生图），完成后图片进附件栏
  const [generatingImage, setGeneratingImage] = useState(false);
  // 生图尺寸/水印记在 AppSettings，跨会话复用；非法磁盘值回落到默认。
  const [imageGenSize, setImageGenSizeState] = useState<string>(DEFAULT_IMAGE_GEN_SIZE);
  const [imageGenWatermark, setImageGenWatermarkState] = useState(DEFAULT_IMAGE_GEN_WATERMARK);
  const [imageGenOutputFormat, setImageGenOutputFormatState] = useState(DEFAULT_IMAGE_GEN_OUTPUT_FORMAT);
  const [picker, setPicker] = useState<ComposerPickerKind | null>(null);
  const [commands, setCommands] = useState<PiCommand[]>([]);
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  // @ 引用懒加载状态：已按 maxDepth 0 拉过子项的目录绝对路径（防重复请求），
  // 与在途加载集合成对出现；目录不在任一集合才能发新请求。
  const loadedDirPathsRef = useRef<Set<string>>(new Set());
  const loadingDirPathsRef = useRef<Set<string>>(new Set());
  // @ 纯文件名搜索的整树后台加载：按 projectId 隔离的单个状态，每项目最多触发
  // 一次（成功或失败都算尝试过），避免用户每敲一个新关键词都重扫整棵目录树。
  const deepTreeStateRef = useRef<{ projectId: string; loaded: boolean; loading: boolean }>({
    projectId: "",
    loaded: false,
    loading: false,
  });
  const templateKey = `${sessionId}:${record?.projectPath ?? ""}`;
  const [templateState, setTemplateState] = useState<{
    key: string;
    items: PromptTemplateInfo[];
  }>({ key: templateKey, items: [] });
  const templates = templateState.key === templateKey ? templateState.items : [];
  const [sendShortcut, setSendShortcut] = useState<
    "enter-send" | "ctrl-enter-send" | "shift-enter-send"
  >("enter-send");
  const [sessionReference, setSessionReference] = useState<SessionSummary | null>(null);
  const [sessionReferenceSelections, setSessionReferenceSelections] = useState<
    Record<string, SessionReferenceSelection>
  >({});

  const markDraftMutation = useCallback((targetSessionId = sessionId) => {
    if (targetSessionId !== sessionId) return;
    draftGuardRef.current = markComposerDraftMutation(draftGuardRef.current);
  }, [sessionId]);

  const setDraft = useCallback((value: string | ((current: string) => string)) => {
    markDraftMutation();
    setDraftAtom({ sessionId, value });
  }, [markDraftMutation, sessionId, setDraftAtom]);

  const setAttachments = useCallback((
    value: ImageContent[] | ((current: ImageContent[]) => ImageContent[]),
  ) => {
    setAttachmentsAtom({ sessionId, value });
  }, [sessionId, setAttachmentsAtom]);

  const setPasteFiles = useCallback((
    value: PastedTextFile[] | ((current: PastedTextFile[]) => PastedTextFile[]),
  ) => {
    setPasteFilesAtom({ sessionId, value });
  }, [sessionId, setPasteFilesAtom]);

  const setMode = useCallback((nextMode: ComposerAgentMode) => {
    // 生图历史是独立消息协议，普通/计划/目标模式的命令语义不适用；
    // 同一会话一旦产生生图记录（或本身是 imagegen 后端），必须保持生图模式，避免误发普通请求。
    if ((hasImageGenHistory || record?.backend === "imagegen") && nextMode !== "imagegen") return;
    // DSH：plan 走 host /plan；goal 走 create/resume/pause IPC（切回普通暂停，不清除）。
    // 本地 atom 仍写入 goal，让选择器立刻切到目标模式；首条用户消息再 /goal 创建。
    if (isDshBackend) {
      const currentPhase = runtime?.state?.goal?.phase;
      const agentId = runtime?.agentId;
      if (nextMode === "plan" || (nextMode === "normal" && mode === "plan")) {
        const command = nextMode === "plan" ? "/plan" : "/plan off";
        void desktopApi.sessions.sendPrompt({
          sessionId,
          requestId: crypto.randomUUID(),
          message: command,
        }).then((result) => {
          if (!result.accepted) {
            showNotice(result.error ?? t("dshPlan.switchFailed"), 4000);
          } else if (nextMode === "plan") {
            showNotice(t("dshPlan.pendingNotice"), 3000);
          }
        }).catch((error) => {
          showNotice(error instanceof Error ? error.message : String(error), 4000);
        });
        if (nextMode === "plan") {
          setModeAtom({ sessionId, mode: "normal" });
          // 模式选择器互斥：进 plan 时暂停进行中的 goal，不清除。
          if (agentId && (currentPhase === "active" || currentPhase === "blocked")) {
            void desktopApi.sessions.runDshGoalAction(agentId, "pause").catch((error) => {
              showNotice(error instanceof Error ? error.message : String(error), 4000);
            });
          }
        }
        return;
      }
      if (nextMode === "goal") {
        if (mode === "plan") {
          void desktopApi.sessions.sendPrompt({
            sessionId,
            requestId: crypto.randomUUID(),
            message: "/plan off",
          }).catch((error) => {
            showNotice(error instanceof Error ? error.message : String(error), 4000);
          });
        }
        setModeAtom({ sessionId, mode: "goal" });
        if (agentId && (currentPhase === "paused" || currentPhase === "blocked")) {
          void desktopApi.sessions.runDshGoalAction(agentId, "resume").catch((error) => {
            showNotice(error instanceof Error ? error.message : String(error), 4000);
          });
        } else if (!currentPhase || currentPhase === "complete") {
          showNotice(t("dshGoal.pendingNotice"), 3000);
        }
        return;
      }
      if (nextMode === "normal" && mode === "goal") {
        setModeAtom({ sessionId, mode: "normal" });
        if (agentId && (currentPhase === "active" || currentPhase === "blocked")) {
          void desktopApi.sessions.runDshGoalAction(agentId, "pause").catch((error) => {
            showNotice(error instanceof Error ? error.message : String(error), 4000);
          });
        }
        return;
      }
    }
    // pi：切回普通立刻发 /goal pause，不要等下一条无标记消息才停。
    if (!isDshBackend && nextMode === "normal" && mode === "goal") {
      setModeAtom({ sessionId, mode: "normal" });
      void desktopApi.sessions.sendPrompt({
        sessionId,
        requestId: crypto.randomUUID(),
        message: "/goal pause",
      }).catch((error) => {
        showNotice(error instanceof Error ? error.message : String(error), 4000);
      });
      return;
    }
    setModeAtom({ sessionId, mode: nextMode });
  }, [hasImageGenHistory, isDshBackend, mode, runtime?.agentId, runtime?.state?.goal?.phase, sessionId, setModeAtom]);

  const loadTemplates = useCallback(async () => {
    const token = templateRequestGateRef.current.begin(templateKey);
    const next: PromptTemplateInfo[] = [];
    try {
      const globalResult = await desktopApi.prompts.list();
      next.push(...globalResult.templates.map((template) => ({
        ...template,
        description: translateBuiltinPromptDescription(template),
        argumentHint: parseArgumentHint(template.content),
      })));
    } catch {
      // Project templates remain usable when the global store is unavailable.
    }
    if (record?.projectPath) {
      try {
        const projectResult = await desktopApi.prompts.listByProject(record.projectPath);
        next.push(...projectResult.templates.map((template) => ({
          ...template,
          argumentHint: parseArgumentHint(template.content),
        })));
      } catch {
        // A project does not have to provide .pi/prompts.
      }
    }
    if (templateRequestGateRef.current.isCurrent(token)) {
      setTemplateState({ key: templateKey, items: next });
    }
    return next;
  }, [record?.projectPath, sessionId, templateKey]);

  useEffect(() => {
    liveDomDraftRef.current = { sessionId, value: draft };
    setCursor(draft.length);
    setSuggestionsOpen(false);
    setSelectedSuggestionIndex(0);
    setHistoryIndex(-1);
    setSavedDraft("");
    setBusyDraftLocked(false);
    // 注意：这里不再写 caretRef。该写入发生在编辑器 layout effect 之后、且 layout
    // effect 只在 value 变化时重跑，会留下一条过期待消费光标——首次输入（打字/
    // 粘贴/语音）时把选区重置回 0。恢复光标到文末由编辑器在内容同步（setContent）
    // 时兜底完成，见 useTipTapComposerEditor 同步 effect。
    draftGuardRef.current = createComposerDraftGuard({
      sessionId,
      agentId: runtime?.agentId,
      runtimeGeneration: runtime?.runtimeGeneration,
      draft,
    });
    lastEditorTextEnvelopeRef.current = "";
  }, [sessionId]);

  useEffect(() => {
    const currentDraft = store.get(sessionDraftByIdAtom)[sessionId] ?? "";
    draftGuardRef.current = createComposerDraftGuard({
      sessionId,
      agentId: runtime?.agentId,
      runtimeGeneration: runtime?.runtimeGeneration,
      draft: currentDraft,
    });
    lastEditorTextEnvelopeRef.current = "";
  }, [runtime?.agentId, runtime?.runtimeGeneration, sessionId, store]);

  useEffect(() => {
    if (
      liveDomDraftRef.current.sessionId === sessionId &&
      liveDomDraftRef.current.value !== draft
    ) {
      liveDomDraftRef.current = { sessionId, value: draft };
    }
  }, [draft, sessionId]);

  useEffect(() => {
    const editorText = runtimeUi?.editorText;
    if (
      !runtime?.agentId ||
      !editorText ||
      runtimeUi.agentId !== runtime.agentId ||
      runtimeUi.runtimeGeneration !== runtime.runtimeGeneration
    ) {
      return;
    }
    const envelope = `${sessionId}:${runtime.runtimeGeneration}:${editorText.revision}`;
    if (lastEditorTextEnvelopeRef.current === envelope) return;
    lastEditorTextEnvelopeRef.current = envelope;
    const currentDraft = store.get(sessionDraftByIdAtom)[sessionId] ?? "";
    if (!canApplyRuntimeEditorText(draftGuardRef.current, {
      sessionId,
      agentId: runtime.agentId,
      runtimeGeneration: runtime.runtimeGeneration,
      currentDraft,
    })) {
      return;
    }
    liveDomDraftRef.current = { sessionId, value: editorText.text };
    setDraft(editorText.text);
    setCursor(editorText.text.length);
    caretRef.current = { pos: editorText.text.length, forValue: editorText.text };
  }, [runtime, runtimeUi, sessionId, setDraft, store]);

  useEffect(() => {
    void desktopApi.settings.get().then((settings) => {
      setSendShortcut(settings.sendShortcut);
      setImageGenSizeState(parseImageGenSize(settings.imageGenSize) ?? DEFAULT_IMAGE_GEN_SIZE);
      setImageGenWatermarkState(parseImageGenWatermark(settings.imageGenWatermark));
      setImageGenOutputFormatState(
        parseImageGenOutputFormat(settings.imageGenOutputFormat) ?? DEFAULT_IMAGE_GEN_OUTPUT_FORMAT,
      );
    }).catch(() => undefined);
  }, []);

  // 单栏会话复用同一 Composer 实例：切 tab 必须清掉 picker/建议/预览等本地 UI，
  // 草稿和附件走 per-session atom，这里只重置不属于 atom 的瞬时状态。
  useEffect(() => {
    setCursor(0);
    setSuggestionsOpen(false);
    setSelectedSuggestionIndex(0);
    setHistoryIndex(-1);
    setSavedDraft("");
    setBusyDraftLocked(false);
    setPreviewImage(null);
    setGeneratingImage(false);
    setPicker(null);
    setSessionReference(null);
    setSessionReferenceSelections({});
  }, [sessionId]);

  useEffect(() => {
    if (!effectiveProjectId) {
      setFiles([]);
      return;
    }
    let current = true;
    // @ 引用跟文件抽屉同一套懒加载：maxDepth 0 只扫根层，展开再补子目录。
    // 旧实现扫 8 层会在切项目时把主进程/渲染都拖死（大会话项目尤其明显）。
    // 引导页虚拟会话没有 record，靠 bootstrapProjectId 兑底加载文件树。
    void desktopApi.files.list(effectiveProjectId, { maxDepth: 0 }).then((next) => {
      if (current) setFiles(next);
    }).catch(() => {
      if (current) setFiles([]);
    });
    return () => {
      current = false;
    };
  }, [effectiveProjectId]);

  // 切项目时清掉懒加载进度：老项目的目录缓存/在途请求不能让新项目复用。
  // （真实请求仍受主进程 isPathInsideProject 拦截，这里双保险。）
  useEffect(() => {
    loadedDirPathsRef.current = new Set();
    loadingDirPathsRef.current = new Set();
  }, [effectiveProjectId]);

  useEffect(() => {
    // D15：DSH 会话的命令补全优先走 live 注册表（host 侧 ctx.commands.list，
    // 含用户/插件注册的命令）；会话未激活（无 live Agent）或桥失败时降级为
    // 已知命令建议集（与 dsh-web 命名空间一致；slash 桥未命中会放行给模型）。
    if (isDshBackend) {
      const staticCommands = DSH_COMMAND_SUGGESTIONS.map((command) => ({
        name: command.name,
        description: t(command.descriptionKey),
        source: command.source,
      }));
      const dshTarget = toSessionRuntimeTarget(sessionId, runtime);
      if (!dshTarget) {
        setCommands(staticCommands);
        return;
      }
      let current = true;
      void desktopApi.sessions.listRuntimeCommands(dshTarget).then((result) => {
        if (current) {
          const live = requireSessionCommand(result).value;
          // live 清单可能不含 help 等基础命令（部分命令仅桌面侧存在）：
          // 与静态建议集合并去重，优先 live 描述。
          const names = new Set(live.map((command) => command.name));
          setCommands([...live, ...staticCommands.filter((command) => !names.has(command.name))]);
        }
      }).catch(() => {
        if (current) setCommands(staticCommands);
      });
      return () => {
        current = false;
      };
    }
    const target = toSessionRuntimeTarget(sessionId, runtime);
    if (!target) {
      setCommands([]);
      return;
    }
    let current = true;
    void desktopApi.sessions.listRuntimeCommands(target).then((result) => {
      if (current) setCommands(requireSessionCommand(result).value);
    }).catch(() => {
      if (current) setCommands([]);
    });
    return () => {
      current = false;
    };
  }, [isDshBackend, runtime?.agentId, runtime?.runtimeGeneration, sessionId]);

  useEffect(() => {
    templateRequestGateRef.current.invalidate(templateKey);
    setTemplateState({ key: templateKey, items: [] });
    void loadTemplates();
  }, [loadTemplates, templateKey]);

  const flatFiles = useMemo(() => flattenFiles(files), [files]);
  const mergedCommands = useMemo(() => mergeCommands(commands), [commands]);
  const validCommandNames = useMemo(() => new Set([
    ...mergedCommands.map((command) => command.name),
    ...templates.map((template) => template.name),
  ]), [mergedCommands, templates]);
  const validFilePaths = useMemo(
    () => new Set(flatFiles.map((file) => file.relativePath)),
    [flatFiles],
  );
  const validSessionRefs = useMemo(
    () => new Set(projectSessions.map((session) => session.name ?? session.filePath)),
    [projectSessions],
  );
  // 引用 chip 白名单：id → 截断后的快照预览 label；无快照时返回 undefined，
  // 解析器直接跳过引用分支（零开销快速路径）
  const sessionQuotes = useAtomValue(sessionQuotesByIdAtom);
  const validQuotes = useMemo(() => {
    const map = sessionQuotes[sessionId];
    if (!map) return undefined;
    const entries = Object.entries(map);
    if (entries.length === 0) return undefined;
    return new Map(entries.map(([id, snippet]) => [id, truncateQuoteLabel(snippet.text)]));
  }, [sessionQuotes, sessionId]);
  const suggestionItems = useMemo(
    () => suggestionsOpen
      ? buildSuggestionItems(draft, cursor, commands, flatFiles, projectSessions)
      : [],
    [commands, cursor, draft, flatFiles, projectSessions, suggestionsOpen],
  );

  // @ 引用向下钻取：随输入懒加载子目录（maxDepth 0 只拉一层，与文件抽屉同语义）。
  // 修复 maxDepth 0 化后只能引用到项目根一层（71d27ed1 为保主进程响应把 8 层递归改成
  // 根层，但没补抽屉那套展开逻辑，导致 @src/xxx 永远匹配不到深层文件）。
  useEffect(() => {
    if (!effectiveProjectId) return;
    const trigger = detectTrigger(draft, cursor, validSessionRefs);
    if (!trigger || trigger.char !== "@") return;
    const dirNode = resolveAtDrillDirectory(trigger.query, files);
    if (!dirNode) return;
    // 已有 children 数组 = 子项已加载（含空目录），不重复请求
    if (Array.isArray(dirNode.children) || loadingDirPathsRef.current.has(dirNode.path)) {
      return;
    }
    let current = true;
    loadingDirPathsRef.current.add(dirNode.path);
    void desktopApi.files.list(effectiveProjectId, { maxDepth: 0, directory: dirNode.path })
      .then((children) => {
        if (!current) return;
        setFiles((prev) => mergeFileTreeChildren(prev, dirNode.path, children));
        loadedDirPathsRef.current.add(dirNode.path);
      })
      .catch(() => {
        // 目录被删/权限不足：保留已加载部分，下次输入自然重试
      })
      .finally(() => {
        loadingDirPathsRef.current.delete(dirNode.path);
      });
    return () => {
      current = false;
    };
  }, [cursor, draft, effectiveProjectId, files, validSessionRefs]);

  // @ 纯文件名搜索（无 /，如 @index）：懒加载缺少锚点目录，必须一次性拿到整树
  // 才能让模糊搜索覆盖深层文件（恢复 71d27ed1 之前的深度搜索能力）。
  // 只在用户确实在搜索（长度 ≥2）且每项目只触发一次；整树合并后所有目录
  // 都有 children 数组，下钻 effect 的 Array.isArray 门自然短路，不会重复拉。
  useEffect(() => {
    if (!effectiveProjectId) return;
    // 切到新项目：重建状态（不 return，继续按新状态评估是否触发）
    const state = deepTreeStateRef.current;
    if (state.projectId !== effectiveProjectId) {
      deepTreeStateRef.current = { projectId: effectiveProjectId, loaded: false, loading: false };
    }
    if (deepTreeStateRef.current.loaded || deepTreeStateRef.current.loading) return;
    const trigger = detectTrigger(draft, cursor, validSessionRefs);
    if (!trigger || trigger.char !== "@" || !shouldLoadFullTreeForAtSearch(trigger.query)) {
      return;
    }
    // 标记在途后即便本 effect 因继续输入被重新评估，loading 门也会挡住重复请求
    deepTreeStateRef.current.loading = true;
    void desktopApi.files.list(effectiveProjectId, { maxDepth: FILE_TREE_ABSOLUTE_MAX_DEPTH })
      .then((next) => {
        // 用项目比对而非 current 标志：输入过程中的每个按键都会触发本 effect
        // 重新评估并清理旧闭包，但请求仍属于当前项目——数据不该被丢弃，
        // 否则快速打字会连续浪费整树扫描（重扫风暴）。只有切走项目才丢弃。
        if (deepTreeStateRef.current.projectId !== effectiveProjectId) return;
        // 整树是根层清单的超集且目录均带 children，整体替换最省事：
        // 已下钻目录的数据都在里面（幂等），无需再逐目录 merge。
        setFiles(next);
      })
      .catch(() => {
        // 超大目录（FILE_TREE_DIRECTORY_TOO_LARGE）/权限问题：保留已加载部分；
        // 同样标记为已尝试，避免每个关键词都重扫整个项目。
      })
      .finally(() => {
        // 只有请求仍属于当前项目才写状态：切走后的旧闭包不能污染新项目标记。
        if (deepTreeStateRef.current.projectId === effectiveProjectId) {
          deepTreeStateRef.current.loading = false;
          deepTreeStateRef.current.loaded = true;
        }
      });
  }, [cursor, draft, effectiveProjectId, validSessionRefs]);
  const suggestionAnchorStyle = useMemo<CSSProperties | undefined>(() => {
    if (!suggestionsOpen) return undefined;
    const menuWidth = Math.min(520, window.innerWidth - 120);
    const menuHeight = 380;
    const gap = 8;
    // 兜底定位（原 CSS .command-palette 的「默认居中 + 底部 160px」语义收进 JS）：
    // 拿不到编辑器/光标坐标时，面板仍然有确定位置，CSS 不再承载任何定位假设。
    const fallback: CSSProperties = {
      top: "auto",
      bottom: 160,
      left: Math.max(16, (window.innerWidth - menuWidth) / 2),
    };
    const root = editorRef.current;
    if (!root) return fallback;
    const coordinates = getComposerCaretCoords(root, cursor);
    if (!coordinates) return fallback;
    let left = coordinates.left;
    if (left + menuWidth > window.innerWidth - 16) {
      left = Math.max(16, window.innerWidth - menuWidth - 16);
    }
    const below = coordinates.top + gap;
    if (below + menuHeight <= window.innerHeight - 16) {
      return { top: below, left, bottom: "auto" };
    }
    const above = coordinates.top - gap;
    if (above - menuHeight >= 0) {
      return {
        top: "auto",
        bottom: window.innerHeight - above,
        left,
      };
    }
    return { top: "auto", bottom: 16, left };
  }, [cursor, suggestionsOpen]);

  const isBusy = isSessionRuntimeBusy(runtime?.status, runtime?.state);
  // 预热只创建进程，不能把编辑器 setEditable(false)：contenteditable 关掉会失焦，输入一半就断。
  const isStarting = isUserFacingSessionStart(sendState.status);
  const hasContent = Boolean(draft.trim() || attachments.length || pasteFiles.length);

  const resetEphemeralUi = useCallback(() => {
    setHistoryIndex(-1);
    setSavedDraft("");
    setSuggestionsOpen(false);
    setBusyDraftLocked(false);
    liveDomDraftRef.current = { sessionId, value: "" };
  }, [sessionId]);

  const resolveSessionReferences = useCallback(async (message: string) => {
    let resolved = message;
    const sessionsByLongestName = [...projectSessions].sort(
      (left, right) =>
        (right.name ?? right.filePath).length - (left.name ?? left.filePath).length,
    );
    for (const referencedSession of sessionsByLongestName) {
      const sessionName = referencedSession.name ?? referencedSession.filePath;
      const raw = `&${sessionName}`;
      if (!resolved.toLowerCase().includes(raw.toLowerCase())) continue;
      const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(escaped, "gi");
      const saved = sessionReferenceSelections[raw];
      const selectedMessages = saved
        ? selectedSessionReferenceMessages(saved)
        : await desktopApi.sessions.readReferenceMessages(referencedSession.id);
      const context = selectedMessages
        .map((item) => `[${item.role === "user" ? "User" : "Assistant"}]: ${item.content}`)
        .join("\n");
      resolved = resolved.replace(
        pattern,
        context
          ? `<referenced_session name="${sessionName}">\n${context}\n</referenced_session>`
          : "",
      );
    }
    return resolved;
  }, [projectSessions, sessionReferenceSelections]);

  /**
   * 手动压缩唯一入口：圆环按钮与 /compact 共用。
   * 未达 30% 门槛不打 RPC（友好 toast）；压缩中拒绝重复点击；成功弹完成。
   */
  const runManualCompact = useCallback(async (
    target: { sessionId: string; agentId: string; runtimeGeneration: number },
    prompt?: string,
  ) => {
    const live = store.get(sessionRuntimeBySessionIdAtomFamily(sessionId));
    // 与圆环 occupancy 同一套占用数字：percent=0 但 tokens 非 0 时按 tokens/window 重算。
    const percent = resolveCompactUsagePercent(live?.state);
    const compacting = live?.state?.isCompacting === true;
    if (compacting) {
      showNotice(t("app.compactInProgress"), 4000);
      return;
    }
    if (shouldSkipCompactForLowUsage(percent, compacting)) {
      showNotice(t("app.compactSessionTooSmall"), 6000);
      return;
    }
    try {
      requireSessionCommand(await desktopApi.sessions.compactRuntime(target, prompt));
      showNotice(t("app.compactDone"), 4000);
    } catch (error) {
      const message = friendlyCompactError(error);
      if (message) showNotice(message, 6000);
    }
  }, [sessionId, store]);

  const send = useSessionSend({
    sessionId,
    sendPrompt: (input) => desktopApi.sessions.sendPrompt(input),
    ensureSessionId,
    templates,
    prepareMessage: async (message) => {
      const resolved = await resolveSessionReferences(message);
      // 条上暂停后 composer 仍可能停在目标模式：发送前先 resume，否则 host 不会续轮。
      if (isDshBackend && mode === "goal") {
        const phase = runtime?.state?.goal?.phase;
        if (runtime?.agentId && (phase === "paused" || phase === "blocked")) {
          try {
            await desktopApi.sessions.runDshGoalAction(runtime.agentId, "resume");
          } catch (error) {
            showNotice(error instanceof Error ? error.message : String(error), 4000);
          }
        }
      }
      return resolved;
    },
    onDraftMutation: markDraftMutation,
    createNewSession: options.onCreateSession,
    compact: async (target, prompt) => {
      await runManualCompact(target, prompt);
    },
    resetComposerUi: resetEphemeralUi,
    recordPromptHistory: (targetSessionId, message) => {
      if (!message.trim() || message.startsWith("!")) return;
      const normalized = message.trim();
      const previous = promptHistoryRef.current[targetSessionId] ?? [];
      promptHistoryRef.current[targetSessionId] = [
        normalized,
        ...previous.filter((item) => item !== normalized),
      ].slice(0, 50);
    },
    showError: (message, duration) => showNotice(message, duration),
    showUnknown: () => showNotice(t("app.queuedUnknown"), 6000),
    enqueue,
  });

  // 生图：凭据来自独立 imagegen.json（供应商 + 模型），不读会话 LLM。
  // 结果按「消息」语义上屏（与 useSessionSend 乐观提交同一约定：写时间线缓存、source=runtime）：
  // 提示词作为 user 消息立即上屏；随后追加一条 assistant「生图占位」消息（meta.imageGen=generating），
  // 生成期间由 FinalAnswer 渲染 beUI ImageGeneration 点阵动画，完成后原地更新为 complete（图片清晰过渡），
  // 失败原地更新为 error。不调用 send、不进附件栏（无运行中 Agent 也能用）。
  const persistImageGenSelection = useCallback((providerId: string, modelId: string) => {
    const next = {
      ...imageGenConfig,
      activeProviderId: providerId,
      activeModel: modelId,
    };
    setImageGenConfig(next);
    void desktopApi.imagegen.saveConfig(next).catch(() => undefined);
  }, [imageGenConfig, setImageGenConfig]);

  const generateImage = useCallback(async () => {
    const prompt = draft.trim();
    if (!prompt || generatingImage) return;
    const provider = findImageGenProvider(imageGenConfig, activeImageGenProviderId)
      ?? imageGenConfig.providers[0];
    const modelId = provider && provider.models.includes(activeImageGenModelId)
      ? activeImageGenModelId
      : (provider?.models[0] ?? "");
    if (!provider?.id || !modelId || !provider.baseUrl.trim() || !provider.apiKey.trim()) {
      showNotice(t("imagegen.error.notConfigured"), 5000);
      return;
    }
    // 参考图前置门禁：供应商未声明带图输入时直接提示，不发无效请求（主进程也会拦截兑底）
    if (attachments.length > 0 && (provider.referenceMode ?? "none") === "none") {
      showNotice(t("imagegen.error.referenceUnsupported"), 5000);
      return;
    }
    // 仅「启动即匿名」的会话提示（noSession=true，经匿名开聊创建，pi 以 --no-session 启动）：
    // 生图不落盘、重启即失。普通新建 draft 会话 filePath 同样为空（生图不启动 agent），
    // 但用户视角它是正式会话，不弹匿名提示打扰（2026 反馈）。
    if (record?.noSession === true) {
      showNotice(t("imagegen.transientHint"), 6000);
    }
    setGeneratingImage(true);

    // 把本地生图消息追加进时间线缓存（整体替换 messages 数组，source=runtime 沿用乐观提交约定）。
    const appendTimelineMessage = (message: ChatMessage) => {
      const previous = store.get(sessionMessagesCacheAtom)?.[sessionId]?.messages ?? [];
      setCacheMessages({ sessionId, messages: [...previous, message], source: "runtime" });
    };
    // 按 id 原地更新已上屏消息（生图占位 → complete/error 复用同一条，避免时间线多出一条）。
    const updateTimelineMessage = (id: string, patch: (m: ChatMessage) => ChatMessage) => {
      const previous = store.get(sessionMessagesCacheAtom)?.[sessionId]?.messages ?? [];
      setCacheMessages({
        sessionId,
        messages: previous.map((m) => (m.id === id ? patch(m) : m)),
        source: "runtime",
      });
    };

    appendTimelineMessage({
      id: crypto.randomUUID(),
      agentId: "",
      role: "user",
      text: prompt,
      timestamp: Date.now(),
      // 参考图随 user 消息上屏：发送后附件栏清空，图片要留在时间线气泡里回显
      images: attachments.length > 0 ? attachments : undefined,
    });
    const imageMessageId = crypto.randomUUID();
    appendTimelineMessage({
      id: imageMessageId,
      agentId: "",
      role: "assistant",
      text: "",
      stopReason: "stop",
      timestamp: Date.now(),
      meta: {
        imageGen: { status: "generating", prompt, size: imageGenSize } satisfies ImageGenMeta,
      },
    });
    setDraft("");
    // 乐观清空附件栏：参考图已随 user 消息上屏回显，输入框不再占用
    // （与普通消息发送同惯例 useSessionSend.clearSnapshot）；
    // 生成失败时下方失败分支会把附件前插恢复，支持改词重试。
    if (attachments.length > 0) {
      setAttachmentsAtom({ sessionId, value: [] });
    }

    try {
      const result = await desktopApi.imagegen.generate({
        provider: provider.id,
        model: modelId,
        prompt,
        size: imageGenSize,
        watermark: imageGenWatermark,
        outputFormat: imageGenOutputFormat,
        // 参考图：附件栏图片作为参考图传给主进程；是否可用由供应商 referenceMode 决定
        referenceImages: attachments.length > 0 ? attachments : undefined,
        // 生图记录落盘：主进程成功后把 user+assistant 消息写入当前会话的 pi 文件
        sessionId,
      });
      if (result.ok) {
        // 参考图发送时已乐观清空，此处只原地更新结果消息
        updateTimelineMessage(imageMessageId, (m) => ({
          ...m,
          images: [result.image],
          meta: {
            imageGen: { status: "complete", prompt, size: imageGenSize } satisfies ImageGenMeta,
          },
        }));
        showNotice(t("imagegen.done"), 4000);
      } else {
        // 失败恢复附件：参考图放回输入框便于改词重试；前插不覆盖期间新粘贴的图
        if (attachments.length > 0) {
          setAttachmentsAtom({ sessionId, value: (current) => [...attachments, ...current] });
        }
        updateTimelineMessage(imageMessageId, (m) => ({
          ...m,
          meta: {
            imageGen: {
              status: "error",
              prompt,
              size: imageGenSize,
              errorDetail: mapImageGenError(result.error, result.detail),
            } satisfies ImageGenMeta,
          },
        }));
      }
    } catch {
      // 网络/超时类失败同样恢复附件，便于原地重试
      if (attachments.length > 0) {
        setAttachmentsAtom({ sessionId, value: (current) => [...attachments, ...current] });
      }
      updateTimelineMessage(imageMessageId, (m) => ({
        ...m,
        meta: {
          imageGen: {
            status: "error",
            prompt,
            errorDetail: t("imagegen.error.network"),
          } satisfies ImageGenMeta,
        },
      }));
    } finally {
      setGeneratingImage(false);
    }
  }, [activeImageGenModelId, activeImageGenProviderId, attachments, draft, generatingImage, imageGenConfig, imageGenOutputFormat, imageGenSize, imageGenWatermark, record?.noSession, sessionId, setAttachmentsAtom, setCacheMessages, setDraft, store]);

  // 统一发送入口：先晋升预览 Tab 再投递（幂等，非预览无副作用）。
  // 发送按钮 / 追问按钮 / Enter 键 / 无 Agent 时的 /compact 直发都会走这里，
  // 避免新增发送路径时漏掉 promote 导致预览 Tab 不常驻（曾因此回归）。
  // 生图模式：所有发送入口统一转生图（不晋升预览 Tab、不发消息），避免各入口分支不一致。
  const promoteAndSend = useCallback(
    async (behavior?: "steer" | "followUp") => {
      if (mode === "imagegen") {
        void generateImage();
        return;
      }
      // 粘贴文件折叠：把 chip 里的文件引用/内容并进草稿再发送。
      // 项目内文件（inProject）走 @\"path\" 引用——pi 展开读取，消息体保持轻量；
      // 匿名会话（文件在 userData，pi 无法读取）折叠原样文本内联，保证内容送达。
      if (pasteFiles.length) {
        const refs: string[] = [];
        for (const file of pasteFiles) {
          if (file.inProject) {
            refs.push(formatFilePathRef(file.path));
          } else {
            const content = await desktopApi.files.readContent(file.path).catch(() => "");
            if (content) refs.push(content);
          }
        }
        const liveDraft = liveDomDraftRef.current.sessionId === sessionId
          ? liveDomDraftRef.current.value
          : draft;
        const joined = [liveDraft.trim(), refs.join("\n\n")].filter(Boolean).join("\n\n");
        liveDomDraftRef.current = { sessionId, value: joined };
        setDraft(joined);
        // 已折叠进草稿：立即移除 chip（发送成功/失败都会在 clearSnapshot 兜底清空）
        setPasteFiles([]);
      }
      options.onPromoteSession?.(sessionId);
      return send(behavior);
    },
    [draft, mode, generateImage, options.onPromoteSession, pasteFiles, send, sessionId, setDraft, setPasteFiles],
  );

  const selectSuggestion = useCallback((item: SuggestionItem) => {
    const liveDraft = liveDomDraftRef.current.sessionId === sessionId
      ? liveDomDraftRef.current.value
      : draft;
    const liveCursor = editorRef.current ? getComposerCaretOffset(editorRef.current) : cursor;
    // 目录引用（isDirectory）不带尾随空格：@src/ 之后继续敲路径段时建议框会
    // 随按键重新打开（onChange → detectTrigger），实现连续的目录下钻引用；
    // 带空格会让建议框立刻关闭，用户必须回删空格才能继续，容易误以为只能选一层。
    const result = applySuggestion(liveDraft, liveCursor, item.value, validSessionRefs, {
      noTrailingSpace: item.isDirectory === true,
    });
    liveDomDraftRef.current = { sessionId, value: result.text };
    setDraft(result.text);
    setCursor(result.cursor);
    caretRef.current = { pos: result.cursor, forValue: result.text };
    setSuggestionsOpen(false);
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [cursor, draft, sessionId, setDraft, validSessionRefs]);

  const closeSuggestions = useCallback(() => {
    const liveDraft = liveDomDraftRef.current.sessionId === sessionId
      ? liveDomDraftRef.current.value
      : draft;
    const liveCursor = editorRef.current ? getComposerCaretOffset(editorRef.current) : cursor;
    const result = clearSuggestionTrigger(liveDraft, liveCursor, validSessionRefs);
    liveDomDraftRef.current = { sessionId, value: result.text };
    setDraft(result.text);
    setCursor(result.cursor);
    caretRef.current = { pos: result.cursor, forValue: result.text };
    setSuggestionsOpen(false);
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [cursor, draft, sessionId, setDraft, validSessionRefs]);

  const onChange = useCallback((value: string, nextCursor: number) => {
    liveDomDraftRef.current = { sessionId, value };
    setDraft(value);
    setCursor(nextCursor);
    setSuggestionsOpen(detectTrigger(value, nextCursor, validSessionRefs) !== null);
    if (historyIndex >= 0) {
      const history = getPromptHistory();
      if (value !== history[historyIndex]) {
        setHistoryIndex(-1);
        setSavedDraft("");
      }
    }
  }, [getPromptHistory, historyIndex, sessionId, setDraft, validSessionRefs]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (suggestionsOpen && suggestionItems.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedSuggestionIndex((index) => Math.min(index + 1, suggestionItems.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedSuggestionIndex((index) => Math.max(index - 1, 0));
        return;
      }
      if (event.key === "Enter") {
        // IME 合成中的回车属于输入法确认候选，不能拿去选建议项
        if (isComposingKeyboardEvent(event)) return;
        event.preventDefault();
        const selected = suggestionItems[
          Math.min(selectedSuggestionIndex, suggestionItems.length - 1)
        ];
        if (selected) selectSuggestion(selected);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeSuggestions();
        return;
      }
    }

    const liveDraft = liveDomDraftRef.current.sessionId === sessionId
      ? liveDomDraftRef.current.value
      : draft;
    const liveCursor = editorRef.current
      ? getComposerCaretOffset(editorRef.current)
      : cursor;
    const firstLine = !liveDraft.slice(0, liveCursor).includes("\n");
    const lastLine = !liveDraft.slice(liveCursor).includes("\n");
    const history = getPromptHistory();

    if (event.key === "ArrowUp" && firstLine && history.length > 0) {
      event.preventDefault();
      const nextIndex = historyIndex < 0
        ? 0
        : Math.min(historyIndex + 1, history.length - 1);
      if (historyIndex < 0) setSavedDraft(liveDraft);
      setHistoryIndex(nextIndex);
      liveDomDraftRef.current = { sessionId, value: history[nextIndex] };
      setDraft(history[nextIndex]);
      caretRef.current = { pos: history[nextIndex].length, forValue: history[nextIndex] };
      return;
    }
    if (event.key === "ArrowDown" && lastLine && historyIndex >= 0) {
      event.preventDefault();
      const nextIndex = historyIndex - 1;
      const nextDraft = nextIndex >= 0 ? history[nextIndex] : savedDraft;
      setHistoryIndex(nextIndex);
      if (nextIndex < 0) setSavedDraft("");
      liveDomDraftRef.current = { sessionId, value: nextDraft };
      setDraft(nextDraft);
      caretRef.current = { pos: nextDraft.length, forValue: nextDraft };
      return;
    }
    if (event.key === "Escape" && historyIndex >= 0) {
      liveDomDraftRef.current = { sessionId, value: savedDraft };
      setDraft(savedDraft);
      setHistoryIndex(-1);
      setSavedDraft("");
      return;
    }

    const intent =
      mode === "plan" && isPlanModeSendKey(event)
        ? "send"
        : getComposerEnterIntent(event, sendShortcut);
    if (intent === "send") {
      event.preventDefault();
      // Enter 发送也晋升预览 Tab（promoteAndSend 内部统一处理）。
      // 忙碌时按「忙碌时投递行为」设置决定语义（pi/dsh 统一，不再按后端分叉）；
      // 空闲直发（undefined）。设置在常用设置→会话，改后即时生效（App 同步 atom）。
      void promoteAndSend(resolveBusySendDelivery(isBusy, store.get(busySendDeliveryAtom)));
    }
  }, [
    closeSuggestions,
    draft,
    getPromptHistory,
    historyIndex,
    isBusy,
    mode,
    promoteAndSend,
    savedDraft,
    selectedSuggestionIndex,
    selectSuggestion,
    sendShortcut,
    sessionId,
    setDraft,
    store,
    suggestionItems,
    suggestionsOpen,
  ]);

  const addImageFiles = useCallback(async (imageFiles: File[]) => {
    // G2：DSH 图片附件已支持（经 host attachment 服务上传，sendPrompt 带 image 块），
    // 与 pi 共用附件流程，不再按 backend 拦截。
    for (const file of imageFiles) {
      try {
        const image = await processComposerImageFile(file);
        setAttachments((current) => [...current, image]);
      } catch (error) {
        showNotice(composerImageNotice(error), 3000);
      }
    }
  }, [setAttachments]);

  /**
   * 把已格式化的引用文本（@path、@"a b/" 等）插入输入框当前光标处。
   * 文件树拖拽、OS 文件拖入/粘贴、「加入对话引用」按钮共用同一插入规则：
   * 只引用路径，不上传内容；与前字符之间按需补空格。
   */
  const insertRefTexts = useCallback((refTexts: string[]) => {
    if (refTexts.length === 0) return;
    const liveDraft = liveDomDraftRef.current.sessionId === sessionId
      ? liveDomDraftRef.current.value
      : draft;
    const liveCursor = editorRef.current ? getComposerCaretOffset(editorRef.current) : cursor;
    const refText = refTexts.join(" ");
    const previous = liveDraft[liveCursor - 1];
    const spacer = liveCursor > 0 && previous !== " " && previous !== "\n" ? " " : "";
    const next = liveDraft.slice(0, liveCursor) + spacer + refText + liveDraft.slice(liveCursor);
    const nextCursor = liveCursor + spacer.length + refText.length;
    liveDomDraftRef.current = { sessionId, value: next };
    setDraft(next);
    setCursor(nextCursor);
    caretRef.current = { pos: nextCursor, forValue: next };
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [cursor, draft, sessionId, setDraft]);

  /** 本地路径以 @path 引用插入（OS 文件拖入/粘贴/文件选择器共用）；含空格路径自动加引号 */
  const insertFilePathRefs = useCallback((paths: string[]) => {
    insertRefTexts(
      paths.map((path) =>
        formatFilePathRef(path, { isDirectory: /[\\/]$/.test(path) }),
      ),
    );
  }, [insertRefTexts]);

  /**
   * 把纯文本插入输入框当前光标处（不带 @ 引用包装）。
   * 与 insertRefTexts 同一套光标/草稿同步协议；仅用于「转文件失败回退原样粘贴」
   * 这类需要绕过 TipTap 默认粘贴路径的场景（onPaste 已同步 preventDefault）。
   */
  const insertPlainTextAtCursor = useCallback((text: string) => {
    if (!text) return;
    const liveDraft = liveDomDraftRef.current.sessionId === sessionId
      ? liveDomDraftRef.current.value
      : draft;
    const liveCursor = editorRef.current ? getComposerCaretOffset(editorRef.current) : cursor;
    const next = liveDraft.slice(0, liveCursor) + text + liveDraft.slice(liveCursor);
    const nextCursor = liveCursor + text.length;
    liveDomDraftRef.current = { sessionId, value: next };
    setDraft(next);
    setCursor(nextCursor);
    caretRef.current = { pos: nextCursor, forValue: next };
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [cursor, draft, sessionId, setDraft]);

  /**
   * 大段粘贴文本 → 落盘受管文件 + 附件栏 chip。
   * 触发条件：粘贴纯文本达到 PASTE_TO_FILE_MIN_CHARS（复制长日志/代码/文章是主要场景）。
   * 有项目：写入 `<project>/.pideck-paste/`，发送时折叠 @"path" 引用（pi 可展开读取）；
   * 匿名会话：写入 userData/paste-files/，发送时折叠原样文本内联。
   * 写盘失败（权限/路径异常）回退原样插入，保证粘贴内容不丢。
   */
  const pasteTextToFile = useCallback(async (text: string) => {
    try {
      const result = await desktopApi.pasteFiles.write({
        // 项目根经 projectId 反查项目清单（不依赖可能缺失的 record.projectPath）；
        // 有项目（含引导页选中项目）→ 写 <project>/.pideck-paste/ 并在发送时折叠为
        // @"path" 引用（消息端渲染文件 chip）；无项目 → userData 兜底、折叠原样文本内联。
        projectPath: composerProject?.path ?? "",
        content: text,
      });
      setPasteFiles((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          path: result.path,
          fileName: result.fileName,
          bytes: result.bytes,
          inProject: result.inProject,
        },
      ]);
      showNotice(
        t("app.pasteConvertedToFile", { name: result.fileName, size: formatBytes(result.bytes) }),
        4000,
      );
    } catch {
      showNotice(t("app.pasteConvertFailed"), 3000);
      insertPlainTextAtCursor(text);
    }
  }, [composerProject?.path, insertPlainTextAtCursor, setPasteFiles]);

  /** 从 File 列表解析本地路径（Electron 32+ 必须走 webUtils，不能用已移除的 File.path） */
  const resolveLocalPathsFromFiles = useCallback((files: File[]) => {
    const getPath = desktopApi.files.getPathForFile;
    if (!getPath) return [];
    const paths: string[] = [];
    for (const file of files) {
      try {
        const path = getPath(file);
        if (path) paths.push(path);
      } catch {
        // 非本地文件或路径不可用时跳过
      }
    }
    return paths;
  }, []);

  /**
   * 剪贴板里的图片文件 → 附加为图片预览（对齐微信/QQ 粘贴习惯）。
   * 经 files.readBase64 读原文件（比剪贴板位图缩略图清晰），构造 File 走统一附件流程；
   * 任一文件读取失败或超出合成器大小上限（主进程 stat 预检拦截）时：
   * 先兜底剪贴板位图——截图工具/网页复制常同时写路径+位图，而路径文件可能已被删除
   * 或过大，位图仍在（否则粘贴会退化成无用的 @path 引用）；实在没有位图才整体回退
   * @path 引用，保证「复制图片」粘贴始终有可用结果。
   */
  const pasteClipboardImages = useCallback(async (paths: string[], dataTransfer: DataTransfer | null) => {
    try {
      const files: File[] = [];
      for (const path of paths) {
        const dataUrl = await desktopApi.files.readBase64(path, COMPOSER_IMAGE_MAX_BYTES);
        if (!dataUrl) throw new Error(`Cannot read image: ${path}`);
        const fileName = path.split(/[\\/]/).pop() || path;
        files.push(dataUrlToFile(dataUrl, imageMimeTypeFromPath(path), fileName));
      }
      await addImageFiles(files);
    } catch {
      // 位图兜底：事件粘贴优先取 clipboardData 的 image 项；右键粘贴无事件，走 Electron 剪贴板位图
      const imageFiles = dataTransfer ? getClipboardImageFiles(dataTransfer) : [];
      if (imageFiles.length) {
        await addImageFiles(imageFiles);
        return;
      }
      const imageDataUrl = desktopApi.clipboard.readImage();
      if (imageDataUrl) {
        await addImageFiles([dataUrlToFile(imageDataUrl, "image/png", "clipboard-image.png")]);
        return;
      }
      insertFilePathRefs(paths);
    }
  }, [addImageFiles, insertFilePathRefs]);

  /**
   * 右键「粘贴」（无 ClipboardEvent）：从 Electron 剪贴板同步读取。
   * 优先级同 onPaste：文件路径 → 位图 → 大段文本转文件；纯文本返回 false，交给编辑器本地插入。
   */
  const pasteFromClipboard = useCallback(async (): Promise<boolean> => {
    const clipboardPaths = desktopApi.files.getClipboardPaths?.() ?? [];
    if (clipboardPaths.length > 0) {
      if (clipboardPaths.every(isImageFilePath)) {
        await pasteClipboardImages(clipboardPaths, null);
      } else {
        insertFilePathRefs(clipboardPaths);
      }
      return true;
    }
    const imageDataUrl = desktopApi.clipboard.readImage();
    if (imageDataUrl) {
      await addImageFiles([dataUrlToFile(imageDataUrl, "image/png", "clipboard-image.png")]);
      return true;
    }
    // 大段文本（右键粘贴菜单无 ClipboardEvent）：同样转文件，避免塞进 ProseMirror 变卡
    const text = desktopApi.clipboard.readText();
    if (text.length >= PASTE_TO_FILE_MIN_CHARS) {
      void pasteTextToFile(text);
      return true;
    }
    return false;
  }, [addImageFiles, insertFilePathRefs, pasteClipboardImages, pasteTextToFile]);

  /**
   * 粘贴：系统文件路径以 @path 引用插入，位图/截图附加为图片。
   * 未处理时不 preventDefault，交给 RichInput 做纯文本粘贴。
   * preventDefault 必须在任何 await 之前同步调用，否则浏览器会先插入默认内容。
   *
   * 顺序说明：资源管理器复制图片文件时，剪贴板常同时带路径 + 缩略图；
   * 路径为受支持图片时优先附加预览，否则仍按路径引用处理，避免被误当成截图。
   */
  const onPaste = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    // 1) 资源管理器复制/剪切的文件：浏览器 ClipboardEvent 通常没有 kind=file，
    //    需通过 preload 同步读取 Electron clipboard（FileNameW / CF_HDROP 等）
    const clipboardPaths = desktopApi.files.getClipboardPaths?.() ?? [];
    if (clipboardPaths.length > 0) {
      event.preventDefault();
      // 复制的全是受支持图片 → 附加预览；混合/其他文件 → 维持 @path 引用
      if (clipboardPaths.every(isImageFilePath)) {
        void pasteClipboardImages(clipboardPaths, event.clipboardData);
      } else {
        insertFilePathRefs(clipboardPaths);
      }
      return;
    }

    // 2) 兜底：剪贴板里若有 File 对象（部分场景），用 webUtils 解析路径
    const fileItems = Array.from(event.clipboardData.items).filter((item) => item.kind === "file");
    if (fileItems.length > 0) {
      const files = fileItems
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file));
      const paths = resolveLocalPathsFromFiles(files);
      if (paths.length > 0) {
        event.preventDefault();
        // 与第 1 步同规则：全是图片 → 附加预览（失败位图兜底），混合 → @path
        if (paths.every(isImageFilePath)) {
          void pasteClipboardImages(paths, event.clipboardData);
        } else {
          insertFilePathRefs(paths);
        }
        return;
      }
    }

    // 3) 剪贴板位图（截图/微信QQ/网页复制图片）：必须优先于纯文本——
    //    这类复制常同时写位图 + text 槽（微信写图片缓存路径、网页写图片 URL），
    //    位图才是用户要的内容；文件路径场景已在前两步处理，这里只剩纯位图。
    const imageFiles = getClipboardImageFiles(event.clipboardData);
    if (imageFiles.length) {
      event.preventDefault();
      void addImageFiles(imageFiles);
      return;
    }
    // 4) 大段纯文本粘贴（复制日志/代码/长文是主要来源）：直接插入 ProseMirror
    //    会随文本量级变卡（文档模型 + 逐键建议扫描），改为落盘成文件并在附件栏
    //    显示文件 chip（与图片粘贴同款形态），发送时自动折叠 @引用/原样文本。
    const plainText = event.clipboardData.getData("text/plain");
    if (plainText.length >= PASTE_TO_FILE_MIN_CHARS) {
      event.preventDefault();
      void pasteTextToFile(plainText);
      return;
    }
    // 5) 其余纯文本一律交给编辑器原样插入：不做自动路径识别——
    //    粘贴 /foo/bar、//注释 这类文本时，若自动补 @ 并转成引用 chip，
    //    文本变成原子节点无法再编辑移动光标（用户反馈的痛点）；
    //    需要引用文件时走资源管理器复制文件（步骤 1/2）或手动输入 @ 触发补全。
  }, [addImageFiles, insertFilePathRefs, pasteClipboardImages, pasteTextToFile, resolveLocalPathsFromFiles]);

  /**
   * 拖拽：
   * 1) 文件树节点（含目录）→ 按节点信息生成 @ 引用；
   * 2) OS 本地文件/目录 → 以 @path 引用插入（含图片文件，不上传内容）；
   * 3) 仅当无法解析本地路径且类型为 image/* 时，才退回附加图片（极少见）。
   */
  const onDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const nodePayload = readFileNodeDragPayload(event.dataTransfer);
    if (nodePayload) {
      insertRefTexts([fileNodeDragPayloadToRef(nodePayload)]);
      return;
    }
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    const paths = resolveLocalPathsFromFiles(files);
    if (paths.length > 0) {
      insertFilePathRefs(paths);
      return;
    }
    void addImageFiles(getDroppedImageFiles(event.dataTransfer));
  }, [addImageFiles, insertFilePathRefs, insertRefTexts, resolveLocalPathsFromFiles]);

  /** 「加入对话引用」按钮：系统选择器选中的文件/目录以 @path 插入 */
  const attachFile = useCallback(async () => {
    try {
      const paths = await desktopApi.dialog.pickFiles({ title: t("menu.attachFile") });
      insertFilePathRefs(paths);
    } catch {
      // 用户取消或出错时不作处理
    }
  }, [insertFilePathRefs]);

  /** 移除粘贴文件 chip：同步删除落盘文件（粘贴产物，不留孤儿文件）。 */
  const removePasteFile = useCallback((index: number) => {
    const target = pasteFiles[index];
    setPasteFiles((current) => current.filter((_, item) => item !== index));
    if (target) void desktopApi.pasteFiles.delete(target.path).catch(() => undefined);
  }, [pasteFiles, setPasteFiles]);

  /** 清空全部粘贴文件 chip（附件栏「清空」按钮）：逐个删除落盘文件。 */
  const clearPasteFiles = useCallback(() => {
    for (const file of pasteFiles) {
      void desktopApi.pasteFiles.delete(file.path).catch(() => undefined);
    }
    setPasteFiles([]);
  }, [pasteFiles, setPasteFiles]);

  const onChipClick = useCallback((chip: ComposerChip) => {
    // 文件引用点击不再打开文件/分屏（用户要求阻止点击打开事件）：
    // 引用 chip 只是一段文本标记，打开文件走时间线链接或文件树等显式入口。
    if (chip.kind === "session") {
      const selected = projectSessions.find(
        (session) => (session.name ?? session.filePath) === chip.label,
      );
      if (selected) setSessionReference(selected);
    }
  }, [projectSessions]);

  useEffect(() => {
    if (!hasContent) {
      setBusyDraftLocked(false);
    } else if (isBusy) {
      setBusyDraftLocked(true);
    }
  }, [hasContent, isBusy, sessionId]);

  const abort = useCallback(async () => {
    const target = toSessionRuntimeTarget(sessionId, runtime);
    if (!target) {
      // 运行时信息缺失（如 agent 尚未绑定）：停止无意义，但不应静默——
      // 提示用户当前会话没有可停止的 Agent，避免「点了停止没反应」的困惑。
      showNotice(t("sessionCommand.runtimeUnavailable"), 4000);
      return;
    }
    try {
      requireSessionCommand(await desktopApi.sessions.abortRuntime(target));
    } catch (error) {
      // abort 失败必须可见：之前这里直接 throw 变成未处理 rejection，
      // 用户点停止后毫无反馈、agent 继续运行，表现为「停止不了」。
      // 异常常驻提示，直到用户手动关闭。
      showNotice(error instanceof Error ? error.message : String(error), Number.POSITIVE_INFINITY);
    }
  }, [runtime?.agentId, runtime?.runtimeGeneration, sessionId]);

  const acknowledgeUnknownDelivery = useCallback(() => {
    setSendStateAtom({ sessionId, state: { status: "idle" } });
  }, [sessionId, setSendStateAtom]);

  const upsertSession = useSetAtom(upsertSessionAtom);

  /**
   * 切换后端（pi ↔ dsh）：仅草稿期可用。
   * 会话一旦激活（有 runtime 或 record 已 active）即锁定后端——pi 会话文件（JSONL）
   * 与 DSH 会话（host session log）格式不同，中途切换会导致时间线消息来源混乱、
   * 同步渲染不可靠。激活后 UI 不再渲染切换器（changeBackend 返回 undefined）。
   * imagegen 后端同样锁定：生图会话不可切回 pi/dsh（互不影响）。
   */
  const backendLocked = Boolean(runtime?.agentId) || record?.status === "active" || record?.backend === "imagegen";
  const changeBackend = useCallback(async (next: AgentBackend) => {
    if (backendLocked) return;
    try {
      // 切回 pi 时按 pi 配置重新解析默认模型/思考档位（与 createDraft 缺省填充
      // 同一解析器 launchDefaults），而不是直接清空——否则用户 pi 配置里的
      // defaultProvider/defaultModel 不会出现在切回后的会话（底栏回退残留 DSH 默认）。
      // dsh/imagegen 后端模型由各自部署默认决定，record 保持清空。
      const resolved = next === "pi"
        ? await desktopApi.sessions.resolveLaunchDefaults({ backend: "pi" }).catch(() => undefined)
        : undefined;
      const defaults = resolveBackendSwitchDefaults(next, resolved);
      const updated = await desktopApi.sessions.updateRecord(sessionId, {
        backend: next,
        model: defaults.model,
        thinkingLevel: defaults.thinkingLevel,
      });
      upsertSession(updated);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), 4000);
    }
  }, [backendLocked, sessionId, upsertSession]);

  const compact = useCallback(async () => {
    const target = toSessionRuntimeTarget(sessionId, runtime);
    if (!target) {
      // No Agent yet: write /compact to draft and send → starts Agent + compacts
      setDraft("/compact");
      caretRef.current = { pos: "/compact".length, forValue: "/compact" };
      void promoteAndSend();
      return;
    }
    await runManualCompact(target);
  }, [runtime?.agentId, runtime?.runtimeGeneration, sessionId, setDraft, promoteAndSend, runManualCompact]);

  const openPicker = useCallback((kind: ComposerPickerKind) => {
    if (kind === "template") void loadTemplates();
    setPicker(kind);
  }, [loadTemplates]);

  const insertTemplate = useCallback((template: PromptTemplateInfo) => {
    const next = appendSlashCommandToDraft(draft, template.name);
    liveDomDraftRef.current = { sessionId, value: next };
    setDraft(next);
    caretRef.current = { pos: next.length, forValue: next };
    setPicker(null);
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [draft, sessionId, setDraft]);

  // 技能选择器选中后插入技能斜杠命令到草稿尾（与 insertTemplate 同构）：
  // pi 用 /skill:名称（裸 /名称 pi 当未知命令拒绝——斜线命令与技能冲突的根因），
  // DSH 由宿主把裸 /名称注册成技能命令；插入后光标落末尾，回车即可发送。
  const insertSkillInvocation = useCallback((name: string) => {
    const token = toSkillInvocationToken(isDshBackend ? "dsh" : "pi", name);
    const next = appendSlashCommandToDraft(draft, token);
    liveDomDraftRef.current = { sessionId, value: next };
    setDraft(next);
    caretRef.current = { pos: next.length, forValue: next };
    setPicker(null);
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [draft, isDshBackend, sessionId, setDraft]);

  // 「一键插入全文」：选择器条目上的插入按钮把提示词/技能正文整段塞进草稿
  // （不是斜线命令形态），便于用户直接编辑或原文发送；与斜线插入是并列入口。
  // 插入内容先剥离 YAML frontmatter「描述头」（name/description 元数据是给选择器用的，
  // 不该出现在输入框里）——预览详情仍显示原文件，只有插入动作做剥离。
  const insertTemplateContent = useCallback((template: PromptTemplateInfo) => {
    const next = appendContentToDraft(draft, stripMarkdownFrontmatter(template.content));
    liveDomDraftRef.current = { sessionId, value: next };
    setDraft(next);
    caretRef.current = { pos: next.length, forValue: next };
    setPicker(null);
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [draft, sessionId, setDraft]);

  const insertSkillContent = useCallback((content: string) => {
    const next = appendContentToDraft(draft, stripMarkdownFrontmatter(content));
    liveDomDraftRef.current = { sessionId, value: next };
    setDraft(next);
    caretRef.current = { pos: next.length, forValue: next };
    setPicker(null);
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [draft, sessionId, setDraft]);

  return {
    sessionId,
    record,
    runtime,
    backend: record?.backend ?? "pi",
    /** 草稿期可切换后端；激活后锁定（undefined → UI 隐藏切换器）。 */
    changeBackend: backendLocked ? undefined : changeBackend,
    /** DSH 部署默认模型（settings.yaml agent-default-model）；仅 dsh 后端时展示，
     *  离开 dsh 时清空（否则残留值会随 defaultModel 泄漏到 pi 会话底栏）。 */
    dshDefaultModel: isDshBackend && dshDefault
      ? { provider: dshDefault.provider, modelId: dshDefault.model, modelName: dshDefault.model }
      : undefined,
    /** DSH 部署默认思考档位：settings.yaml 的 reasoningEffort 优先，缺省用模型自身 defaultEffort。 */
    dshDefaultThinkingLevel: isDshBackend
      ? (dshDefault?.reasoningEffort ?? dshDefault?.defaultEffort)
      : undefined,
    /** 引导页（无 record）启动默认：主进程按 pi 配置/模型目录解析（显式默认 > 偏好 > 上次使用 > 空），展示用。 */
    bootstrapDefaultModel: bootstrapDefaults?.model,
    bootstrapDefaultThinkingLevel: bootstrapDefaults?.thinkingLevel,
    /** 解析结果是否来自用户显式配置的默认模型：True 时欢迎页偏好不参与展示回退（与创建同规则）。 */
    bootstrapDefaultModelConfigured: bootstrapDefaults?.defaultModelConfigured === true,
    draft,
    attachments,
    mode,
    sendState,
    templates,
    picker,
    previewImage,
    sessionReference,
    sessionReferenceSelection: sessionReference
      ? sessionReferenceSelections[`&${sessionReference.name ?? sessionReference.filePath}`]
      : undefined,
    bangMode: getBangMode(draft),
    isBusy,
    isStarting,
    hasContent,
    busyDraftLocked,
    editor: {
      ref: editorRef,
      caretRef,
      cursor,
      validCommandNames,
      validFilePaths,
      validSessionRefs,
      validQuotes,
      onChange,
      onCursorChange: setCursor,
      onKeyDown,
      onPaste,
      onPasteClipboard: pasteFromClipboard,
      onDrop,
      onDragOver: (event: React.DragEvent<HTMLDivElement>) => {
        // 会话 Tab / 侧栏分屏拖拽交给 SessionSplitStage（capture），composer 不抢落点
        if (event.dataTransfer.types.includes(SESSION_TAB_DRAG_MIME)) return;
        event.preventDefault();
        // 文件树拖拽的 effectAllowed 含 move（内部移动语义），拖入 composer 时
        // 显式声明 copy，避免光标显示为“移动”，实际行为是插入引用
        if (
          event.dataTransfer.types.includes(PI_FILE_NODE_DRAG_MIME) ||
          event.dataTransfer.types.includes(PI_FILE_PATH_DRAG_MIME)
        ) {
          event.dataTransfer.dropEffect = "copy";
        }
      },
      onFocus: () => setSuggestionsOpen(detectTrigger(draft, cursor, validSessionRefs) !== null),
      onBlur: () => setSuggestionsOpen(false),
      onChipClick,
      attachFile,
    },
    suggestions: {
      open: suggestionsOpen,
      items: suggestionItems,
      selectedIndex: selectedSuggestionIndex,
      anchorStyle: suggestionAnchorStyle,
      setSelectedIndex: setSelectedSuggestionIndex,
      close: closeSuggestions,
      pick: selectSuggestion,
    },
    images: {
      preview: setPreviewImage,
      add: (image: ImageContent) => setAttachments((current) => [...current, image]),
      remove: (index: number) => setAttachments((current) => current.filter((_, item) => item !== index)),
      clear: () => setAttachments([]),
    },
    pasteFiles: {
      files: pasteFiles,
      remove: removePasteFile,
      clear: clearPasteFiles,
    },
    delivery: {
      // 发送/追问都算主动交互：先把预览 Tab 晋升常驻，再投递（幂等，非预览无副作用）。
      // 忙碌时按「忙碌时投递行为」设置决定语义（pi/dsh 统一，不再按后端分叉）；
      // 空闲直发。排队项的插入/排队切换走输入框上方队列面板的行内按钮。
      send: () => {
        void promoteAndSend(resolveBusySendDelivery(isBusy, store.get(busySendDeliveryAtom)));
      },
      abort: () => void abort(),
      compact: () => void compact(),
      imageGenConfig,
      imageGenProviderId: activeImageGenProviderId,
      imageGenModelId: activeImageGenModelId,
      imageGenSize,
      imageGenWatermark,
      imageGenOutputFormat,
      imageGenModeLocked: hasImageGenHistory || record?.backend === "imagegen",
      setImageGenSelection: (providerId: string, modelId: string) => {
        const nextProvider = findImageGenProvider(imageGenConfig, providerId);
        if (!nextProvider?.models.includes(modelId)) return;
        persistImageGenSelection(nextProvider.id, modelId);
      },
      setImageGenSize: (size: string) => {
        const parsed = parseImageGenSize(size);
        if (!parsed) return;
        setImageGenSizeState(parsed);
        void desktopApi.settings.update({ imageGenSize: parsed }).catch(() => undefined);
      },
      setImageGenWatermark: (watermark: boolean) => {
        setImageGenWatermarkState(watermark);
        void desktopApi.settings.update({ imageGenWatermark: watermark }).catch(() => undefined);
      },
      setImageGenOutputFormat: (format: string) => {
        const parsed = parseImageGenOutputFormat(format, null);
        if (!parsed) return;
        setImageGenOutputFormatState(parsed);
        void desktopApi.settings.update({ imageGenOutputFormat: parsed }).catch(() => undefined);
      },
      unknown: sendState.status === "unknown",
      unknownError: sendState.error,
      acknowledgeUnknown: acknowledgeUnknownDelivery,
      // DSH 只在 host 明确报告 routable=false 时锁住发送；undefined 代表尚未确认或目录加载失败。
      canSend: hasContent && !isStarting && !generatingImage && (!isDshBackend || runtime?.state?.modelRoutable !== false),
      generatingImage,
    },
    pickers: {
      open: openPicker,
      close: () => setPicker(null),
      setMode,
      insertTemplate,
      insertTemplateContent,
      insertSkillInvocation,
      insertSkillContent,
    },
    modals: {
      closePreview: () => setPreviewImage(null),
      closeSessionReference: () => setSessionReference(null),
      confirmSessionReference: (
        sessionName: string,
        messages: Array<{ role: string; content: string; timestamp: number }>,
        selectedIndices: number[],
      ) => {
        setSessionReferenceSelections((current) => ({
          ...current,
          [`&${sessionName}`]: createSessionReferenceSelection(
            selectedIndices,
            messages,
          ),
        }));
        setSessionReference(null);
      },
    },
  };
}

export type SessionComposerController = ReturnType<typeof useSessionComposerController>;

/** 生图错误码 → 用户可见文案。http/鉴权类错误尽量附上厂商 detail（已脱敏）。 */
function mapImageGenError(error: string, detail?: string): string {
  const extra = detail?.trim() ?? "";
  switch (error) {
    case "notConfigured":
      return t("imagegen.error.notConfigured");
    case "invalidKey":
      return extra
        ? t("imagegen.error.invalidKeyDetail", { detail: extra })
        : t("imagegen.error.invalidKey");
    case "badBaseUrl":
      return extra
        ? t("imagegen.error.badBaseUrlDetail", { detail: extra })
        : t("imagegen.error.badBaseUrl");
    case "empty":
      return t("imagegen.error.empty");
    case "http":
      return extra
        ? t("imagegen.error.http", { detail: extra })
        : t("imagegen.status.error");
    default:
      return t("imagegen.error.network");
  }
}
