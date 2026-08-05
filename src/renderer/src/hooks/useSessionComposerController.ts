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
  FileTreeNode,
  ImageContent,
  PiCommand,
  SessionSummary,
} from "../../../shared/types";
import {
  sessionAttachmentsByIdAtom,
  sessionComposerModeByIdAtom,
  sessionDraftByIdAtom,
  sessionRecordByIdAtomFamily,
  sessionRuntimeBySessionIdAtomFamily,
  sessionRuntimeUiBySessionIdAtomFamily,
  sessionSendStateByIdAtom,
  sessionSummariesByProjectIdAtomFamily,
  setSessionAttachmentsAtom,
  setSessionComposerModeAtom,
  setSessionDraftAtom,
  setSessionSendStateAtom,
} from "../atoms";
import {
  getComposerEnterIntent,
  parseArgumentHint,
  translateBuiltinPromptDescription,
  type PromptTemplateInfo,
} from "../composerBehavior";
import {
  applySuggestion,
  buildSuggestionItems,
  clearSuggestionTrigger,
  detectTrigger,
  fileNodeDragPayloadToRef,
  flattenFiles,
  mergeCommands,
  PI_FILE_NODE_DRAG_MIME,
  PI_FILE_PATH_DRAG_MIME,
  readFileNodeDragPayload,
} from "../components/app/AppUtils";
import {
  getCaretOffset,
  getRichInputCaretCoords,
  type RichInputChip,
} from "../components/app/RichInput";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import {
  ComposerImageError,
  getClipboardImageFiles,
  getDroppedImageFiles,
  processComposerImageFile,
} from "../utils/composerImages";
import { showNotice } from "../utils/notice";
import {
  requireSessionCommand,
  toSessionRuntimeTarget,
} from "../utils/sessionCommands";
import { useSessionSend, type EnqueuePromptSnapshot } from "./useSessionSend";

/**
 * compact 错误友好文案：requireSessionCommand 的 message 是 i18n 通用失败，
 * pi 原错在 debugDetails。优先用 debugDetails 匹配 nothing-to-do / too-small。
 */
function friendlyCompactError(error: unknown): string {
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
  const lower = detail.toLowerCase();
  if (/nothing to compact|already compacted/i.test(lower)) return t("app.compactNothingToDo");
  if (/session too small|too small/i.test(lower)) return t("app.compactSessionTooSmall");
  return detail
    ? t("app.compactFailedWithReason", { error: detail })
    : t("app.compactFailed");
}

export type ComposerPickerKind = "model" | "mode" | "thinking" | "template";

export type UseSessionComposerControllerOptions = {
  sessionId: string;
  onOpenFile?: (path: string) => void;
  ensureSessionId?: (sessionId: string) => Promise<string>;
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
  const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(sessionId));
  const runtimeUi = useAtomValue(sessionRuntimeUiBySessionIdAtomFamily(sessionId));
  const projectSessions = useAtomValue(
    sessionSummariesByProjectIdAtomFamily(record?.projectId ?? ""),
  );
  const drafts = useAtomValue(sessionDraftByIdAtom);
  const attachmentsBySession = useAtomValue(sessionAttachmentsByIdAtom);
  const modes = useAtomValue(sessionComposerModeByIdAtom);
  const sendStates = useAtomValue(sessionSendStateByIdAtom);
  const setDraftAtom = useSetAtom(setSessionDraftAtom);
  const setAttachmentsAtom = useSetAtom(setSessionAttachmentsAtom);
  const setModeAtom = useSetAtom(setSessionComposerModeAtom);
  const setSendStateAtom = useSetAtom(setSessionSendStateAtom);

  const draft = drafts[sessionId] ?? "";
  const attachments = attachmentsBySession[sessionId] ?? [];
  const mode = modes[sessionId] ?? "normal";
  const sendState = sendStates[sessionId] ?? { status: "idle" as const };
  const editorRef = useRef<HTMLDivElement | null>(null);
  const caretRef = useRef<number | null>(null);
  const liveDomDraftRef = useRef({ sessionId, value: draft });
  const draftGuardRef = useRef(createComposerDraftGuard({
    sessionId,
    agentId: runtime?.agentId,
    runtimeGeneration: runtime?.runtimeGeneration,
    draft,
  }));
  const templateRequestGateRef = useRef(createLatestRequestGate());
  const promptHistoryRef = useRef<Record<string, string[]>>({});
  const sendBehaviorCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEditorTextEnvelopeRef = useRef("");
  const [cursor, setCursor] = useState(0);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [savedDraft, setSavedDraft] = useState("");
  const [busyDraftLocked, setBusyDraftLocked] = useState(false);
  const [sendBehaviorMenuOpen, setSendBehaviorMenuOpen] = useState(false);
  const [previewImage, setPreviewImage] = useState<ImageContent | null>(null);
  const [picker, setPicker] = useState<ComposerPickerKind | null>(null);
  const [commands, setCommands] = useState<PiCommand[]>([]);
  const [files, setFiles] = useState<FileTreeNode[]>([]);
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

  const setMode = useCallback((nextMode: "normal" | "plan") => {
    setModeAtom({ sessionId, mode: nextMode });
  }, [sessionId, setModeAtom]);

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
    setSendBehaviorMenuOpen(false);
    caretRef.current = draft.length;
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
    caretRef.current = editorText.text.length;
  }, [runtime, runtimeUi, sessionId, setDraft, store]);

  useEffect(() => {
    void desktopApi.settings.get().then((settings) => {
      setSendShortcut(settings.sendShortcut);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!record?.projectId) {
      setFiles([]);
      return;
    }
    let current = true;
    void desktopApi.files.list(record.projectId).then((next) => {
      if (current) setFiles(next);
    }).catch(() => {
      if (current) setFiles([]);
    });
    return () => {
      current = false;
    };
  }, [record?.projectId]);

  useEffect(() => {
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
  }, [runtime?.agentId, runtime?.runtimeGeneration, sessionId]);

  useEffect(() => {
    templateRequestGateRef.current.invalidate(templateKey);
    setTemplateState({ key: templateKey, items: [] });
    void loadTemplates();
  }, [loadTemplates, templateKey]);

  useEffect(() => () => {
    if (sendBehaviorCloseTimerRef.current) {
      clearTimeout(sendBehaviorCloseTimerRef.current);
    }
  }, []);

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
  const suggestionItems = useMemo(
    () => suggestionsOpen
      ? buildSuggestionItems(draft, cursor, commands, flatFiles, projectSessions)
      : [],
    [commands, cursor, draft, flatFiles, projectSessions, suggestionsOpen],
  );
  const suggestionAnchorStyle = useMemo<CSSProperties | undefined>(() => {
    if (!suggestionsOpen || !editorRef.current) return undefined;
    const coordinates = getRichInputCaretCoords(editorRef.current, cursor);
    if (!coordinates) return undefined;
    const menuWidth = Math.min(520, window.innerWidth - 120);
    const menuHeight = 380;
    const gap = 8;
    let left = coordinates.left;
    if (left + menuWidth > window.innerWidth - 16) {
      left = Math.max(16, window.innerWidth - menuWidth - 16);
    }
    const below = coordinates.top + gap;
    if (below + menuHeight <= window.innerHeight - 16) {
      return { top: below, left, bottom: "auto", transform: "none" };
    }
    const above = coordinates.top - gap;
    if (above - menuHeight >= 0) {
      return {
        top: "auto",
        bottom: window.innerHeight - above,
        left,
        transform: "none",
      };
    }
    return { top: "auto", bottom: 16, left, transform: "none" };
  }, [cursor, suggestionsOpen]);

  const isBusy = runtime?.status === "running" || Boolean(runtime?.state?.isStreaming);
  const isStarting = runtime?.status === "starting" || sendState.status === "activating";
  const hasContent = Boolean(draft.trim() || attachments.length);

  const resetEphemeralUi = useCallback(() => {
    setHistoryIndex(-1);
    setSavedDraft("");
    setSuggestionsOpen(false);
    setSendBehaviorMenuOpen(false);
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

  const send = useSessionSend({
    sessionId,
    sendPrompt: (input) => desktopApi.sessions.sendPrompt(input),
    ensureSessionId,
    templates,
    prepareMessage: resolveSessionReferences,
    onDraftMutation: markDraftMutation,
    compact: async (target, prompt) => {
      // /compact 与 chip 共用同一友好错误映射（nothing-to-do / too-small）
      try {
        requireSessionCommand(await desktopApi.sessions.compactRuntime(target, prompt));
      } catch (error) {
        showNotice(friendlyCompactError(error), 6500);
      }
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

  const selectSuggestion = useCallback((value: string) => {
    const liveDraft = liveDomDraftRef.current.sessionId === sessionId
      ? liveDomDraftRef.current.value
      : draft;
    const liveCursor = editorRef.current ? getCaretOffset(editorRef.current) : cursor;
    const result = applySuggestion(liveDraft, liveCursor, value);
    liveDomDraftRef.current = { sessionId, value: result.text };
    setDraft(result.text);
    setCursor(result.cursor);
    caretRef.current = result.cursor;
    setSuggestionsOpen(false);
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [cursor, draft, sessionId, setDraft]);

  const closeSuggestions = useCallback(() => {
    const liveDraft = liveDomDraftRef.current.sessionId === sessionId
      ? liveDomDraftRef.current.value
      : draft;
    const liveCursor = editorRef.current ? getCaretOffset(editorRef.current) : cursor;
    const result = clearSuggestionTrigger(liveDraft, liveCursor);
    liveDomDraftRef.current = { sessionId, value: result.text };
    setDraft(result.text);
    setCursor(result.cursor);
    caretRef.current = result.cursor;
    setSuggestionsOpen(false);
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [cursor, draft, sessionId, setDraft]);

  const onChange = useCallback((value: string, nextCursor: number) => {
    liveDomDraftRef.current = { sessionId, value };
    setDraft(value);
    setCursor(nextCursor);
    setSuggestionsOpen(detectTrigger(value, nextCursor) !== null);
    if (historyIndex >= 0) {
      const history = promptHistoryRef.current[sessionId] ?? [];
      if (value !== history[historyIndex]) {
        setHistoryIndex(-1);
        setSavedDraft("");
      }
    }
  }, [historyIndex, sessionId, setDraft]);

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
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        const selected = suggestionItems[
          Math.min(selectedSuggestionIndex, suggestionItems.length - 1)
        ];
        if (selected) selectSuggestion(selected.value);
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
    const liveCursor = getCaretOffset(event.currentTarget);
    const firstLine = !liveDraft.slice(0, liveCursor).includes("\n");
    const lastLine = !liveDraft.slice(liveCursor).includes("\n");
    const history = promptHistoryRef.current[sessionId] ?? [];

    if (event.key === "ArrowUp" && firstLine && history.length > 0) {
      event.preventDefault();
      const nextIndex = historyIndex < 0
        ? 0
        : Math.min(historyIndex + 1, history.length - 1);
      if (historyIndex < 0) setSavedDraft(liveDraft);
      setHistoryIndex(nextIndex);
      liveDomDraftRef.current = { sessionId, value: history[nextIndex] };
      setDraft(history[nextIndex]);
      caretRef.current = history[nextIndex].length;
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
      caretRef.current = nextDraft.length;
      return;
    }
    if (event.key === "Escape" && historyIndex >= 0) {
      liveDomDraftRef.current = { sessionId, value: savedDraft };
      setDraft(savedDraft);
      setHistoryIndex(-1);
      setSavedDraft("");
      return;
    }

    const intent = getComposerEnterIntent(event, sendShortcut);
    if (intent === "send") {
      event.preventDefault();
      void send(isBusy ? "steer" : undefined);
    }
  }, [
    closeSuggestions,
    draft,
    historyIndex,
    isBusy,
    savedDraft,
    selectedSuggestionIndex,
    selectSuggestion,
    send,
    sendShortcut,
    sessionId,
    setDraft,
    suggestionItems,
    suggestionsOpen,
  ]);

  const addImageFiles = useCallback(async (imageFiles: File[]) => {
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
    const liveCursor = editorRef.current ? getCaretOffset(editorRef.current) : cursor;
    const refText = refTexts.join(" ");
    const previous = liveDraft[liveCursor - 1];
    const spacer = liveCursor > 0 && previous !== " " && previous !== "\n" ? " " : "";
    const next = liveDraft.slice(0, liveCursor) + spacer + refText + liveDraft.slice(liveCursor);
    const nextCursor = liveCursor + spacer.length + refText.length;
    liveDomDraftRef.current = { sessionId, value: next };
    setDraft(next);
    setCursor(nextCursor);
    caretRef.current = nextCursor;
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [cursor, draft, sessionId, setDraft]);

  /** 本地路径以 @path 引用插入（OS 文件拖入/粘贴/文件选择器共用） */
  const insertFilePathRefs = useCallback((paths: string[]) => {
    insertRefTexts(paths.map((path) => `@${path}`));
  }, [insertRefTexts]);

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
   * 粘贴：系统文件路径以 @path 引用插入，位图/截图附加为图片。
   * 未处理时不 preventDefault，交给 RichInput 做纯文本粘贴。
   * preventDefault 必须在任何 await 之前同步调用，否则浏览器会先插入默认内容。
   *
   * 顺序说明：资源管理器复制图片文件时，剪贴板常同时带路径 + 缩略图；
   * 必须先判定文件路径，否则会被误当成截图附加。纯截图无路径，仍走图片分支。
   */
  const onPaste = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    // 1) 资源管理器复制/剪切的文件：浏览器 ClipboardEvent 通常没有 kind=file，
    //    需通过 preload 同步读取 Electron clipboard（FileNameW / CF_HDROP 等）
    const clipboardPaths = desktopApi.files.getClipboardPaths?.() ?? [];
    if (clipboardPaths.length > 0) {
      event.preventDefault();
      insertFilePathRefs(clipboardPaths);
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
        insertFilePathRefs(paths);
        return;
      }
    }

    // 3) 图片粘贴（截图等位图数据，无本地文件路径）：读取并附加到消息
    const imageFiles = getClipboardImageFiles(event.clipboardData);
    if (!imageFiles.length) return;
    event.preventDefault();
    void addImageFiles(imageFiles);
  }, [addImageFiles, insertFilePathRefs, resolveLocalPathsFromFiles]);

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

  const onChipClick = useCallback((chip: RichInputChip) => {
    if (chip.kind === "file") {
      const path = chip.raw.slice(1);
      if (options.onOpenFile) options.onOpenFile(path);
      else void desktopApi.files.open(path);
      return;
    }
    if (chip.kind === "session") {
      const selected = projectSessions.find(
        (session) => (session.name ?? session.filePath) === chip.label,
      );
      if (selected) setSessionReference(selected);
    }
  }, [options.onOpenFile, projectSessions]);

  useEffect(() => {
    if (!hasContent) {
      setBusyDraftLocked(false);
    } else if (isBusy) {
      setBusyDraftLocked(true);
    }
  }, [hasContent, isBusy, sessionId]);

  const keepSendBehaviorMenuOpen = useCallback(() => {
    if (sendBehaviorCloseTimerRef.current) {
      clearTimeout(sendBehaviorCloseTimerRef.current);
      sendBehaviorCloseTimerRef.current = null;
    }
    setSendBehaviorMenuOpen(true);
  }, []);

  const scheduleSendBehaviorMenuClose = useCallback(() => {
    if (sendBehaviorCloseTimerRef.current) {
      clearTimeout(sendBehaviorCloseTimerRef.current);
    }
    sendBehaviorCloseTimerRef.current = setTimeout(() => {
      setSendBehaviorMenuOpen(false);
      sendBehaviorCloseTimerRef.current = null;
    }, 160);
  }, []);

  const abort = useCallback(async () => {
    const target = toSessionRuntimeTarget(sessionId, runtime);
    if (!target) return;
    requireSessionCommand(await desktopApi.sessions.abortRuntime(target));
  }, [runtime?.agentId, runtime?.runtimeGeneration, sessionId]);

  const acknowledgeUnknownDelivery = useCallback(() => {
    setSendStateAtom({ sessionId, state: { status: "idle" } });
  }, [sessionId, setSendStateAtom]);

  const compact = useCallback(async () => {
    const target = toSessionRuntimeTarget(sessionId, runtime);
    if (!target) {
      // No Agent yet: write /compact to draft and send → starts Agent + compacts
      setDraft("/compact");
      caretRef.current = "/compact".length;
      send();
      return;
    }
    try {
      requireSessionCommand(await desktopApi.sessions.compactRuntime(target));
    } catch (error) {
      showNotice(friendlyCompactError(error), 6500);
    }
  }, [runtime?.agentId, runtime?.runtimeGeneration, sessionId, setDraft, send]);

  const openPicker = useCallback((kind: ComposerPickerKind) => {
    if (kind === "template") void loadTemplates();
    setPicker(kind);
  }, [loadTemplates]);

  const insertTemplate = useCallback((template: PromptTemplateInfo) => {
    const next = draft.trimEnd()
      ? `${draft.trimEnd()} /${template.name} `
      : `/${template.name} `;
    liveDomDraftRef.current = { sessionId, value: next };
    setDraft(next);
    caretRef.current = next.length;
    setPicker(null);
    requestAnimationFrame(() => editorRef.current?.focus());
  }, [draft, sessionId, setDraft]);

  return {
    sessionId,
    record,
    runtime,
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
      onChange,
      onCursorChange: setCursor,
      onKeyDown,
      onPaste,
      onDrop,
      onDragOver: (event: React.DragEvent<HTMLDivElement>) => {
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
      onFocus: () => setSuggestionsOpen(detectTrigger(draft, cursor) !== null),
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
      remove: (index: number) => setAttachments((current) => current.filter((_, item) => item !== index)),
      clear: () => setAttachments([]),
    },
    delivery: {
      send: () => void send(isBusy ? "steer" : undefined),
      followUp: () => void send("followUp"),
      abort: () => void abort(),
      compact: () => void compact(),
      unknown: sendState.status === "unknown",
      unknownError: sendState.error,
      acknowledgeUnknown: acknowledgeUnknownDelivery,
      canSend: hasContent && !isStarting,
      sendBehaviorMenuOpen,
      toggleSendBehaviorMenu: () => setSendBehaviorMenuOpen((open) => !open),
      keepSendBehaviorMenuOpen,
      scheduleSendBehaviorMenuClose,
    },
    pickers: {
      open: openPicker,
      close: () => setPicker(null),
      setMode,
      insertTemplate,
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
