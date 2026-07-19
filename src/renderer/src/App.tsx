import {
  Fragment,
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type PointerEvent,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Settings,
  Sliders,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Code,
  Info,
  MessageCircle,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Play,
  Plus,
  Trash2,
  Wrench,
  Minus,
  FolderOpen,
  Globe,
  Pin,
  Pencil,
  ArrowUp,
  Square,
  Terminal,
  Filter,
  GitBranch,
  X,
} from "lucide-react";
import { subscribeToNotice, showNotice } from "./utils/notice";
import { createPreviewApi } from "./previewApi";
import { createBrowserApi } from "./browserApi";
const ConfigModal = lazy(() => import("./ConfigModal").then((m) => ({ default: m.ConfigModal })));
import { TrustConfirmModal } from "./components/app/TrustConfirmModal";
import { TerminalDock } from "./components/terminal/TerminalDock";
import { FeishuLinkIndicator } from "./components/feishu/FeishuLinkIndicator";
import { useFeishuBridge } from "./hooks/useFeishuBridge";
import { CloseIconButton } from "./components/ui/IconButton";
import {
  buildComposerPromptSubmission,
  expandPromptTemplates,
  getComposerEnterIntent,
  parseArgumentHint,
  translateBuiltinPromptDescription,
} from "./composerBehavior";
import {
  getProjectAgentSessionDisplay,
  isSameSessionPath,
} from "./agentListDisplay";
import { resolveLocale, setI18nLocale, t } from "./i18n";
import {
  pruneTerminalDockState,
  setTerminalDockCollapsed,
  setTerminalDockOpen,
  type TerminalDockStateByAgent,
} from "./terminalDockState";
import { useMessagePagination } from "./hooks/useMessagePagination";
import { useSessionLoader } from "./hooks/useSessionLoader";
import { useScratchPad } from "./hooks/useScratchPad";
import { SessionReferenceModal, type SessionReferenceResult } from "./components/app/SessionReferenceModal";
import { ScratchPadPanel } from "./components/scratchPad/ScratchPadPanel";
import { LazyWrapper } from "./hooks/useLazyComponent";
import {
  AgentContextMenu,
  BranchSelector,
  ComposerToolbar,
  ThinkingIndicator,
  CompactionCard,
  ConversationOutline,
  DiagnosticMessageCard,
  DrawerContent,
  EmptyState,
  EnvironmentDialog,
  FileContextMenu,
  ConfirmDialog,
  ImagePreviewModal,
  LogoMark,
  ModelPicker,
  PromptTemplatePicker,
  ProjectAvatar,
  ProjectContextMenu,
  PromptSuggestions,
  SessionContextMenu,
  SessionManagerModal,
  SessionStatus,

  ComposerModePicker,
  ThinkingPicker,
  UserBubble,
  TurnRow,
  AskQuestionCard,
  ExtensionWidgetCard,
  MultiSelectModal,
  WorktreeCreateDialog,
  type DrawerPanel,
  type SessionModifiedFile,
} from "./components/app/AppParts";
import { BrowserPanel } from "./components/app/BrowserPanel";
import {
  groupToolMessages,
  getMultiSelectImageCaptureIds,
  applySuggestion,
  buildOutline,
  buildSuggestionItems,
  clearSuggestionTrigger,
  detectTrigger,
  displayPath,
  flattenFiles,
  matches,
  mergeCommands,
  type MessageItem,
} from "./components/app/AppUtils";
import {
	getCaretOffset as getCaretOffsetOf,
	getRichInputCaretCoords,
	RichInput,
	type RichInputChip,
} from "./components/app/RichInput";
// 懒加载：Monaco Editor（~17.6MB Web Worker）仅在用户打开 diff 时才加载
const FileDiffViewer = lazy(() => import("./components/app/FileDiffViewer").then((m) => ({ default: m.FileDiffViewer })));
// 懒加载模态框，减少首屏 JS 体积
const SettingsModal = lazy(() => import("./components/app/SettingsModal").then((m) => ({ default: m.SettingsModal })));

const CodexImportModal = lazy(() => import("./components/app/ImportModals").then((m) => ({ default: m.CodexImportModal })));
const ClaudeImportModal = lazy(() => import("./components/app/ImportModals").then((m) => ({ default: m.ClaudeImportModal })));
const OpenCodeImportModal = lazy(() => import("./components/app/ImportModals").then((m) => ({ default: m.OpenCodeImportModal })));
const ProjectResourcesModal = lazy(() => import("./components/app/ProjectResourcesModal").then((m) => ({ default: m.ProjectResourcesModal })));
const UpdateErrorModalLazy = lazy(() => import("./components/app/UpdateModals").then((m) => ({ default: m.UpdateErrorModal })));
const UpToDateModalLazy = lazy(() => import("./components/app/UpdateModals").then((m) => ({ default: m.UpToDateModal })));
import { createDefaultExternalEditorSettings } from "../../shared/types";
import type {
  AgentRuntimeState,
  AgentTab,
  AppInfo,
  AppSettings,
  AppUpdateDownloadProgress,
  AppUpdateInfo,
  AvailableModel,
  PiCliUpdateResult,
  ExternalEditor,
  FeedbackEnvironment,
  ChatMessage,
  CodexImportReport,
  CodexSessionSummary,
  ClaudeImportReport,
  ClaudeSessionSummary,
  OpenCodeImportReport,
  OpenCodeSessionSummary,
  FileTreeNode,
  GitBranchInfo,
  WorktreeEntry,
  ImageContent,
  PiCommand,
  PiInstallStatus,
  PiInstallExecResult,
  NpmAvailabilityResult,
  PiUpdateCheckResult,
  Project,
  SessionSummary,
  ComposerAgentMode,
  ThinkingUpdate,
} from "../../shared/types";

const isLanWeb =
  !window.piDesktop && window.location.protocol.startsWith("http");
const isElectronRuntime = navigator.userAgent.includes("Electron/");
const missingElectronPreload = isElectronRuntime && !window.piDesktop;
function createUnavailableDesktopApi(): typeof window.piDesktop {
  const fail = () => {
    throw new Error(t("app.preloadMissing"));
  };
  return new Proxy(
    {},
    {
      get: fail,
      set: fail,
    },
  ) as typeof window.piDesktop;
}
const api =
  window.piDesktop ??
  (missingElectronPreload
    ? createUnavailableDesktopApi()
    : isLanWeb
      ? createBrowserApi()
      : createPreviewApi());
// 输入框默认高度增加,提供更好的输入体验,适合多行输入和代码片段
const COMPOSER_MIN_HEIGHT = 175;
const COMPOSER_DEFAULT_TERMINAL_HEIGHT = 220;
const COMPOSER_MIN_TIMELINE_HEIGHT = 160;
const DRAWER_ANIMATION_MS = 180;
const TERMINAL_DOCK_MOTION_MS = 180;
const SIDEBAR_PROJECT_CHILD_PAGE_SIZE = 5;
const AGENT_CREATE_TIMEOUT_MS = 60_000;

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function countContentLines(value: unknown) {
  if (typeof value !== "string") return 0;
  if (!value) return 0;
  return value.split(/\r\n|\r|\n/).length;
}

function getToolChangedLineCount(toolName: string, args: any) {
  // meta.args 可能被 AgentManager 序列化为 JSON 字符串
  if (typeof args === "string" && args.trim()) {
    try { args = JSON.parse(args); } catch { return 0; }
  }
  // 会话结束摘要只能使用 renderer 已收到的工具参数,不能重新 diff 工作区;
  // 这里按编辑/写入工具的输入估算"本次触达行数",避免把用户在会话外的改动也计入。
  if (/edit|patch/i.test(toolName)) {
    const edits = Array.isArray(args?.edits) ? args.edits : undefined;
    if (edits) {
      return edits.reduce((total: number, edit: any) => {
        const oldLines = countContentLines(edit?.oldText ?? edit?.old_text);
        const newLines = countContentLines(edit?.newText ?? edit?.new_text);
        return total + Math.max(oldLines, newLines);
      }, 0);
    }
    return Math.max(
      countContentLines(args?.oldText ?? args?.old_text),
      countContentLines(args?.newText ?? args?.new_text),
    );
  }
  if (/write|create/i.test(toolName)) {
    return countContentLines(args?.content ?? args?.text ?? args?.data ?? args?.body);
  }
  return 0;
}

function getToolFilePath(args: any) {
  // meta.args 可能被 AgentManager 序列化为 JSON 字符串（safeJson），需反解为对象再查找路径字段。
  if (typeof args === "string" && args.trim()) {
    try { args = JSON.parse(args); } catch { return undefined; }
  }
  return typeof args?.filePath === "string"
    ? args.filePath
    : typeof args?.file_path === "string"
      ? args.file_path
      : typeof args?.path === "string"
        ? args.path
        : typeof args?.targetPath === "string"
          ? args.targetPath
          : typeof args?.target_path === "string"
            ? args.target_path
            : typeof args?.outputPath === "string"
              ? args.outputPath
              : typeof args?.output_path === "string"
                ? args.output_path
                : typeof args?.file === "string"
                  ? args.file
                  : typeof args?.fileName === "string"
                    ? args.fileName
                    : typeof args?.filename === "string"
                      ? args.filename
                      : undefined;
}

/**
 * 从工具参数中提取修改后的文件内容，用于 diff 展示。
 * 不再依赖 originalContent（已移除存储），
 * 对于 edit 操作直接提取工具参数中的变动区域。
 */
function getToolNewContent(toolName: string, args: any, _originalContent?: string): string | undefined {
  // meta.args 可能是 JSON 字符串，反解后再提取内容字段。
  if (!args) return undefined;
  if (typeof args === "string" && args.trim()) {
    try { args = JSON.parse(args); } catch { return undefined; }
  }
  if (/write|create/i.test(toolName) && typeof args.content === "string") return args.content;
  // edit/patch：originalContent 不再存储，这里不再尝试重建全量文件内容。
  // diff 展示时使用工具参数中的 oldText/newText 显示变动区域。
  return undefined;
}

function displayProjectDirectoryName(project: Project) {
  if (isChatProject(project)) return "Chat";
  const normalizedPath = project.path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalizedPath.split("/").pop() || project.name || project.path;
}

function isChatProject(project?: Project) {
  return project?.kind === "chat";
}

function getSelectableCodexImportPaths(sessions: CodexSessionSummary[]) {
  return sessions
    .filter((session) => session.threadSource !== "subagent")
    .map((session) => session.sourcePath);
}

function formatCodexSubagentName(session: SessionSummary) {
  const label = [session.codexAgentNickname, session.codexAgentRole]
    .filter(Boolean)
    .join(" · ");
  return label || session.name || t("app.codexSubagent");
}

function isAbsoluteFilePath(path: string) {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/");
}

/** 从 localStorage 恢复会话来源过滤配置 */
function loadSessionSourceFilter(): Record<string, Set<"pi" | "codex" | "claude" | "opencode"> | null> {
	try {
		const raw = localStorage.getItem("pideck-session-source-filter");
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		const result: Record<string, Set<"pi" | "codex" | "claude" | "opencode"> | null> = {};
		for (const [key, val] of Object.entries(parsed)) {
			if (val === null) {
				result[key] = null;
			} else if (Array.isArray(val)) {
				result[key] = new Set(val);
			}
		}
		return result;
	} catch {
		return {};
	}
}

/** 将会话来源过滤持久化到 localStorage */
function saveSessionSourceFilter(filter: Record<string, Set<"pi" | "codex" | "claude" | "opencode"> | null>) {
	try {
		const obj: Record<string, string[] | null> = {};
		for (const [key, val] of Object.entries(filter)) {
			obj[key] = val === null ? null : [...val];
		}
		localStorage.setItem("pideck-session-source-filter", JSON.stringify(obj));
	} catch {
		// 静默失败
	}
}

function resolveFileLinkPath(path: string, basePath?: string) {
  if (!path || isAbsoluteFilePath(path) || !basePath) return path;
  // 浏览器端不引入 Node path;按项目根路径分隔符拼接,满足点击 AI 输出的项目相对路径。
  const separator = basePath.includes("\\") ? "\\" : "/";
  return `${basePath.replace(/[\\/]+$/, "")}${separator}${path.replace(/^[\\/]+/, "")}`;
}

const DISMISSED_EXTENSION_WIDGETS_STORAGE_KEY =
  "pid:extension-widget-dismissed-by-session";

function loadDismissedExtensionWidgets(): Record<string, string[]> {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(DISMISSED_EXTENSION_WIDGETS_STORAGE_KEY) ?? "{}",
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, string[]> = {};
    for (const [sessionKey, widgetKeys] of Object.entries(parsed)) {
      if (Array.isArray(widgetKeys)) {
        result[sessionKey] = widgetKeys.filter(
          (widgetKey): widgetKey is string => typeof widgetKey === "string",
        );
      }
    }
    return result;
  } catch {
    return {};
  }
}

function saveDismissedExtensionWidgets(value: Record<string, string[]>) {
  try {
    localStorage.setItem(
      DISMISSED_EXTENSION_WIDGETS_STORAGE_KEY,
      JSON.stringify(value),
    );
  } catch {
    // localStorage 可能因隐私模式/配额失败；关闭状态丢失不应影响主流程。
  }
}

function getAgentSessionStorageKey(agent?: AgentTab, fallbackAgentId?: string) {
  return agent?.sessionPath ?? fallbackAgentId ?? "";
}


type PendingAgentTab = AgentTab & {
  pendingKind?: "create" | "restart";
  pendingStartedAt?: number;
};

function isReplacementForPendingAgent(agent: AgentTab, pending: PendingAgentTab) {
  if (agent.projectId !== pending.projectId || agent.cwd !== pending.cwd)
    return false;

  if (pending.pendingKind === "restart") {
    const startedAt = pending.pendingStartedAt ?? pending.createdAt;
    // 重启占位只匹配本次重启之后出现的新进程，避免误选同项目下已有的同名 Agent。
    if (agent.createdAt < startedAt - 1000) return false;
    if (isSameSessionPath(agent.sessionPath, pending.sessionPath)) return true;
    return !pending.sessionPath && agent.title === pending.title;
  }

  if (!pending.id.startsWith("pending-")) return false;
  if (isSameSessionPath(agent.sessionPath, pending.sessionPath)) return true;
  if (pending.sessionPath && agent.createdAt >= pending.createdAt - 1000)
    return true;
  return (
    agent.title === pending.title && agent.createdAt >= pending.createdAt - 1000
  );
}

function isPendingAgentId(agentId?: string) {
  return Boolean(agentId?.startsWith("pending-"));
}

const EDITOR_LOGO_URLS: Record<string, string> = {
  vscode: new URL("./assets/editors/vscode.png", import.meta.url).href,
  cursor: new URL("./assets/editors/cursor.png", import.meta.url).href,
  zed: new URL("./assets/editors/zed.png", import.meta.url).href,
  idea: new URL("./assets/editors/idea.svg", import.meta.url).href,
  webstorm: new URL("./assets/editors/webstorm.svg", import.meta.url).href,
  phpstorm: new URL("./assets/editors/phpstorm.svg", import.meta.url).href,
  pycharm: new URL("./assets/editors/pycharm.svg", import.meta.url).href,
};

function getEditorLogoUrl(editorId: string) {
  return EDITOR_LOGO_URLS[editorId];
}

/** 扩展 UI 请求，适配 onUiRequest 回调中的 request 对象 */
interface UiRequest {
	agentId: string;
	requestId: string;
	method: string;
	title: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	allowOther?: boolean;
	completed?: boolean;
	value?: string;
	cancelled?: boolean;
	message?: string;
	notifyType?: "info" | "warning" | "error";
	text?: string;
	widgetKey?: string;
	widgetLines?: string[];
	widgetPlacement?: "aboveEditor" | "belowEditor";
}

function migrateAgentRecord<T>(
  current: Record<string, T>,
  replacementById: Map<string, string>,
  liveIds: Set<string>,
) {
  const next: Record<string, T> = {};
  for (const [agentId, value] of Object.entries(current)) {
    const nextAgentId = replacementById.get(agentId) ?? agentId;
    if (liveIds.has(nextAgentId)) next[nextAgentId] = value;
  }
  return next;
}

export function App() {
  if (missingElectronPreload) {
    return (
      <div className="boot-screen root-loading">
        <div className="boot-logo root-loading-logo">
          <LogoMark />
        </div>
        <strong>PiDeck</strong>
        <span>{t("app.preloadMissing")}</span>
      </div>
    );
  }

  const [projects, setProjects] = useState<Project[]>([]);
  // 项目的 git worktree 列表：{ parentId -> WorktreeEntry[] }
  const [worktreesByProject, setWorktreesByProject] = useState<
    Record<string, WorktreeEntry[]>
  >({});
  const [branchByProject, setBranchByProject] = useState<Record<string, string | null>>({});
  const [draggingProjectId, setDraggingProjectId] = useState<string>();
  const [dragOverProjectId, setDragOverProjectId] = useState<string>();
  const [agents, setAgents] = useState<AgentTab[]>([]);
  const [pendingAgents, setPendingAgents] = useState<PendingAgentTab[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string>();
  const [activeAgentId, setActiveAgentId] = useState<string>();
  // 切换 agent（新会话/恢复会话）时刷新设置，使 pi agent 的 hideThinkingBlock 立即生效
  useEffect(() => {
    if (activeAgentId) {
      void api.settings.get().then(setSettings).catch(() => undefined);
    }
  }, [activeAgentId]);
  const activeAgentIdRef = useRef<string | undefined>(activeAgentId);
  activeAgentIdRef.current = activeAgentId;
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(
    new Set(),
  );
  const [activeAgentByProject, setActiveAgentByProject] = useState<
    Record<string, string>
  >({});
  const [messagesByAgent, setMessagesByAgent] = useState<
    Record<string, ChatMessage[]>
  >({});
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  /** Git 工作区中对比 HEAD 有变更的文件列表（用于右侧面板展示）。 */
  const [gitChangedFiles, setGitChangedFiles] = useState<
    { path: string; status: string }[]
  >([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionsByProject, setSessionsByProject] = useState<
    Record<string, SessionSummary[]>
  >({});
  const [sessionLoadingByProject, setSessionLoadingByProject] = useState<
    Record<string, boolean>
  >({});
  const [visibleProjectChildCountByProject, setVisibleProjectChildCountByProject] =
    useState<Record<string, number>>({});
  const [gitInfo, setGitInfo] = useState<GitBranchInfo>({
    current: null,
    branches: [],
  });
  const [commands, setCommands] = useState<PiCommand[]>([]);
  const [runtimeStateByAgent, setRuntimeStateByAgent] = useState<
    Record<string, AgentRuntimeState>
  >({});
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [promptTemplatePickerOpen, setPromptTemplatePickerOpen] = useState(false);
  const [promptTemplateList, setPromptTemplateList] = useState<
    Array<{ name: string; path: string; description: string; content: string; argumentHint?: string }>
  >([]);
  const [composerModePickerOpen, setComposerModePickerOpen] = useState(false);
  const [thinkingPickerOpen, setThinkingPickerOpen] = useState(false);
  const [sendBehaviorMenuOpen, setSendBehaviorMenuOpen] = useState(false);
  const [sessionFeishuBotId, setSessionFeishuBotId] = useState<
    string | undefined
  >(undefined);
  const [sessionActionsOpen, setSessionActionsOpen] = useState(false);
  const [appNotice, setAppNotice] = useState<{ message: string; duration: number } | null>(null);
  const appNoticeTimeoutRef = useRef<number | null>(null);
  const [switchingBranch, setSwitchingBranch] = useState<string | null>(null);
  const [promptByAgent, setPromptByAgent] = useState<Record<string, string>>(
    {},
  );
  /** 当前正在重启的 Agent，用于仅给对应会话显示 loading，避免切到其他 Agent 后仍被全局禁用。 */
  const [restartingAgentId, setRestartingAgentId] = useState<string | null>(null);
  /** 用户点击 ask_question 取消/abort 后的过渡标记，立即隐藏运行指示器。 */
  const [cancellingUi, setCancellingUi] = useState(false);
  const [attachedImagesByAgent, setAttachedImagesByAgent] = useState<
    Record<string, ImageContent[]>
  >({});
  const [previewImage, setPreviewImage] = useState<ImageContent | null>(null);
  /** 存储用户在 select 弹框自定义输入框中键入的值，用于在后续 input 弹框中自动提交 */
  const pendingCustomInputRef = useRef("");
  /** 外部编辑器列表 + 弹出气泡状态 */
  const [externalEditors, setExternalEditors] = useState<ExternalEditor[]>([]);
  const [editorsOpen, setEditorsOpen] = useState(false);
  const [editorsAnchor, setEditorsAnchor] = useState<{ x: number; y: number } | null>(null);
  /** 右键项目也能唤起编辑器气泡，所以这里显式记录本次要打开的目录，避免依赖运行中 agent 的 cwd。 */
  const [editorsTargetPath, setEditorsTargetPath] = useState<string | null>(null);
  /** 浏览器全屏模式：在完整窗口覆盖层中渲染浏览器面板，不受右侧抽屉宽度限制。 */
  const [browserFullscreen, setBrowserFullscreen] = useState(false);
  const editorsRef = useRef<HTMLDivElement>(null);

  // 点击编辑器气泡外部时关闭
  useEffect(() => {
    if (!editorsOpen) return;
    const handler = (event: MouseEvent) => {
      if (editorsRef.current && !editorsRef.current.contains(event.target as Node)) {
        setEditorsOpen(false);
        setEditorsAnchor(null);
        setEditorsTargetPath(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [editorsOpen]);
  // 订阅 app-notice 通知：替代 sonner toast
  useEffect(() => {
    return subscribeToNotice((data) => {
      if (data) {
        setAppNotice({ message: data.message, duration: data.duration });
        if (appNoticeTimeoutRef.current) {
          window.clearTimeout(appNoticeTimeoutRef.current);
        }
        appNoticeTimeoutRef.current = window.setTimeout(() => {
          setAppNotice(null);
          appNoticeTimeoutRef.current = null;
        }, data.duration);
      }
    });
  }, []);
  /** 活跃的 Extension UI 请求 map（requestId → UiRequest），用于实时显示 ask_question 卡片 */
  const [activeUiRequest, setActiveUiRequest] = useState<Record<string, UiRequest> | null>(null);
  /** Extension 通过 RPC setWidget 推送的轻量状态块；按 agent 隔离，避免切换会话串台。 */
  const [extensionWidgetsByAgent, setExtensionWidgetsByAgent] = useState<
    Record<string, Record<string, string[]>>
  >({});
  /** Extension widget 容器折叠状态（全局持久化，不按 agentId 隔离，重启后恢复） */
  const [widgetsCollapsed, setWidgetsCollapsed] = useState(() => {
    try {
      return (
        JSON.parse(localStorage.getItem("pid:extension-widgets-collapsed") ?? "false") ??
        false
      );
    } catch {
      return false;
    }
  });
  /** 用户手动关闭的 extension widget（widgetKey）；按稳定 sessionPath 隔离，避免切换 agent 串状态。 */
  const [agentDismissedWidgets, setAgentDismissedWidgets] = useState<
    Record<string, string[]>
  >(() => loadDismissedExtensionWidgets());
  /** 输入框发送模式：normal 直接交给 agent，plan 通过隐藏标记触发 PiDeck Plan Mode 扩展。 */
  const [composerAgentModes, setComposerAgentModes] = useState<Record<string, ComposerAgentMode>>({});
  /** 当前 agent 的发送模式，按 agentId 隔离。 */
  const currentComposerAgentMode = composerAgentModes[activeAgentId ?? ""] ?? "normal";
  const setCurrentComposerAgentMode = (mode: ComposerAgentMode) => {
    if (!activeAgentId) return;
    setComposerAgentModes((prev) => ({ ...prev, [activeAgentId]: mode }));
  };
  /** Goal 状态 */
  const [goalText, setGoalText] = useState<string>("");
  const goalTextRef = useRef("");
  const [goalStatus, setGoalStatus] = useState<"none" | "active" | "paused" | "complete">("none");
  const goalStatusRef = useRef<"none" | "active" | "paused" | "complete">("none");
  const [goalStartedAt, setGoalStartedAt] = useState(0);
  const goalStartedAtRef = useRef(0);
  const [goalCompletedAt, setGoalCompletedAt] = useState(0);
  const goalIterationRef = useRef(0);
  /** 标记是否已经在等待自动续接,防止多个异步续接冲突 */
  const goalContinuationPendingRef = useRef(false);
  /** 记录上次续接前已看到的 agent 响应,用于识别运行状态抖动造成的无进展空转。 */
  const goalLastResponseSignatureRef = useRef("");
  /** 最大自动续接次数,达到后暂停而不是伪装完成,避免目标未完成时进入死循环。 */
  const GOAL_MAX_CONTINUATIONS = 5;
  /** 上一次 isAgentBusy 状态,用于检测 busy→idle 转换 */
  const prevIsAgentBusyRef = useRef(false);

  /** 当前 agent 流式思考的实时文本,agent_end 时清空 */
  const [multiSelectOpen, setMultiSelectOpen] = useState(false);
  const [sessionRefPickerOpen, setSessionRefPickerOpen] = useState(false);
  const [sessionRefPickerTarget, setSessionRefPickerTarget] = useState<SessionSummary | null>(null);
  /** & 会话引用选择缓存：key = chip raw（如 "&My Session"），value = 选中的消息列表 */
  const [sessionRefSelections, setSessionRefSelections] = useState<
    Record<string, { messages: Array<{ role: string; content: string }>; fullContext: boolean; selectedIndices: number[] }>
  >({});

  const [streamingThinking, setStreamingThinking] = useState<
    Record<string, string>
  >({});
  /** 每个 agent 最后一次会话的开始时间(status 变为 running 时记录),用 ref 避免 effect 闭包陈旧 */
  const sessionStartByAgentRef = useRef<Record<string, number>>({});
  /** 每个 agent 最后一次会话的总时长(ms),仅在会话结束后更新 */
  const [sessionDurationByAgent, setSessionDurationByAgent] = useState<
    Record<string, number>
  >({});
  // 会话区不再维护独立的“修改文件摘要”卡片；diff 入口贴在 edit/write 工具调用处，
  // 避免会话输入框上方摘要与 Git 工作区状态/历史会话恢复互相干扰。
  const agentStatusByAgentRef = useRef<Record<string, AgentTab["status"]>>({});
  /** RPC 日志,用于调试 */
  const [rpcLogs, setRpcLogs] = useState<
    Array<{
      id: string;
      agentId: string;
      direction: string;
      summary: string;
      data?: unknown;
      time: number;
    }>
  >([]);
  const [_logs, setLogs] = useState<string[]>([]); // 写入式调试日志,仅用于 onLog/onError 捕获
  const [search, setSearch] = useState("");
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  // 记录 composer 光标位置,用于光标相关的 @ / 触发检测与建议项替换。
  const [composerCursor, setComposerCursor] = useState(0);
  const [fileMenu, setFileMenu] = useState<{
    x: number;
    y: number;
    node: FileTreeNode;
  } | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
    danger?: boolean;
    confirmLabel?: string;
  } | null>(null);
  // 项目信任确认请求：含 .pi 资源且未记录决策的项目首次创建 Agent 时由主进程发起
  const [trustRequest, setTrustRequest] = useState<{
    requestId: string;
    cwd: string;
    projectName: string;
  } | null>(null);
  const [renamingFile, setRenamingFile] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const [renamingFileInput, setRenamingFileInput] = useState("");
  const [agentMenu, setAgentMenu] = useState<{
    x: number;
    y: number;
    agent: AgentTab;
  } | null>(null);
  const [sessionMenu, setSessionMenu] = useState<{
    x: number;
    y: number;
    projectId: string;
    session: SessionSummary;
  } | null>(null);
  const [agentActionLoading, setAgentActionLoading] = useState<
    "copy" | "export" | null
  >(null);
  const [sessionActionLoading, setSessionActionLoading] = useState<
    "copy" | "export" | null
  >(null);
  const [agentRenameTarget, setAgentRenameTarget] = useState<AgentTab | null>(
    null,
  );
  const [sessionRenameTarget, setSessionRenameTarget] = useState<{
    projectId: string;
    session: SessionSummary;
  } | null>(null);
  const [agentRenameValue, setAgentRenameValue] = useState("");
  const [agentRenaming, setAgentRenaming] = useState(false);
  const [projectMenu, setProjectMenu] = useState<{
    x: number;
    y: number;
    project: Project;
  } | null>(null);
  /** 会话管理弹框 */
  const [sessionManagerProject, setSessionManagerProject] = useState<Project | null>(null);
  /** Worktree 创建弹窗 */
  const [worktreeCreateDialog, setWorktreeCreateDialog] = useState<{
    projectId: string;
  } | null>(null);
  /** worktree 创建进行中，用于禁用弹框按钮并显示"创建中" */
  const [worktreeCreating, setWorktreeCreating] = useState(false);
  /** 展开会话的 worktree 路径集合：默认子工作区只展示 3 条会话，展开后显示全部 */
  const [expandedWorktreeSessions, setExpandedWorktreeSessions] = useState<
    Set<string>
  >(() => new Set());
  /** 正在被删除的 worktree 路径集合：触发淡出动画期间保留 DOM，动画结束后才移除。 */
  const [removingWorktreePaths, setRemovingWorktreePaths] = useState<
    Set<string>
  >(() => new Set());
  /** 历史会话来源过滤（按项目）：undefined=显示全部，Record 含项目ID对应 Set */
  const [sessionSourceFilter, setSessionSourceFilter] = useState<
  	Record<string, Set<"pi" | "codex" | "claude" | "opencode"> | null>
  >(() => loadSessionSourceFilter());
  const [expandedCodexSubagentGroups, setExpandedCodexSubagentGroups] =
    useState<Set<string>>(() => new Set());
  /** 来源过滤弹窗（关联项目ID和位置） */
  const [sessionFilterOpen, setSessionFilterOpen] = useState<{
  	x: number;
  	y: number;
  	projectId: string;
  } | null>(null);
  /** 编辑器展示模式：弹框或侧栏 */
  const [editorMode, setEditorMode] = useState<"modal" | "drawer">("drawer");
  const toggleEditorMode = useCallback(() => {
    setEditorMode((prev) => {
      const next = prev === "modal" ? "drawer" : "modal";
      if (next === "drawer") {
        setDrawer("editor");
        setDrawerCollapsed(false);
      }
      return next;
    });
  }, []);
  /** Editor tab：文件中转查看/差异查看。最多 5 个，超出移除最早打开的那个。 */
  interface EditorTab {
    id: string;
    filePath: string;
    mode: "view" | "diff";
    originalContent: string;
    modifiedContent?: string;
  }
  const [editorTabs, setEditorTabs] = useState<EditorTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  /** 当前活跃 tab 派生数据 */
  const activeTab = useMemo(
    () => editorTabs.find((t) => t.id === activeTabId) ?? null,
    [editorTabs, activeTabId],
  );
  // FileDiffViewer 会在读取函数变化时重载文件；这些 IO 入口必须保持引用稳定，避免 App 轮询/消息更新导致预览滚动回到顶部。
  const readEditorFileContent = useCallback(
    (path: string) => api.files.readContent(path),
    [],
  );
  const readEditorOriginalContent = useCallback(
    (path: string) => api.git.originalContent(path),
    [],
  );
  const saveEditorFileContent = useCallback(
    (path: string, content: string) => api.files.writeContent(path, content),
    [],
  );
  /** 打开（或切换到已存在的）编辑器 tab。已打开时跳转；未打开时新增，超过 5 个淘汰最早 tab。 */
  const openEditorTab = useCallback(
    (path: string, mode: "view" | "diff", originalContent?: string, modifiedContent?: string) => {
      setEditorTabs((prev) => {
        const existing = prev.find((t) => t.filePath === path);
        if (existing) {
          // 已打开的 tab：更新 mode 和 content（工具 diff 可能和普通查看模式不同）
          setActiveTabId(existing.id);
          return prev.map((t) =>
            t.id === existing.id
              ? { ...t, mode, originalContent: originalContent ?? "", modifiedContent }
              : t,
          );
        }
        const newTab: EditorTab = {
          id: crypto.randomUUID(),
          filePath: path,
          mode,
          originalContent: originalContent ?? "",
          modifiedContent,
        };
        const next = [...prev, newTab];
        if (next.length > 5) next.shift();
        setActiveTabId(newTab.id);
        return next;
      });
    },
    [],
  );
  /** 关闭指定 tab。关闭活跃 tab 时切到相邻 tab；一个都不剩时关闭编辑器。 */
  const closeEditorTab = useCallback(
    (tabId: string) => {
      setEditorTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === tabId);
        if (idx < 0) return prev;
        const next = prev.filter((t) => t.id !== tabId);
        if (next.length === 0) {
          setActiveTabId(null);
        } else if (tabId === activeTabId) {
          const neighborIdx = Math.min(idx, next.length - 1);
          setActiveTabId(next[neighborIdx].id);
        }
        return next;
      });
    },
    [activeTabId],
  );
  /** 切换活跃 tab。 */
  const selectEditorTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
  }, []);
  /** 稳定版文件读写回调，避免内联函数导致 FileDiffViewer 的 useEffect 每轮渲染都重新触发。 */
  const handleReadContent = useCallback(
    (path: string) => api.files.readContent(path),
    [],
  );
  const handleReadOriginalContent = useCallback(
    (path: string) => api.git.originalContent(path),
    [],
  );
  const handleSaveContent = useCallback(
    (path: string, content: string) => api.files.writeContent(path, content),
    [],
  );
  const [codexImportProject, setCodexImportProject] = useState<Project | null>(
    null,
  );
  const [codexImportSessions, setCodexImportSessions] = useState<
    CodexSessionSummary[]
  >([]);
  const [codexImportSelected, setCodexImportSelected] = useState<string[]>([]);
  const [codexImportLoading, setCodexImportLoading] = useState(false);
  const [codexImportRunning, setCodexImportRunning] = useState(false);
  const [codexImportReport, setCodexImportReport] =
    useState<CodexImportReport | null>(null);
  const [claudeImportProject, setClaudeImportProject] = useState<Project | null>(
    null,
  );
  const [claudeImportSessions, setClaudeImportSessions] = useState<
    ClaudeSessionSummary[]
  >([]);
  const [claudeImportSelected, setClaudeImportSelected] = useState<string[]>([]);
  const [claudeImportLoading, setClaudeImportLoading] = useState(false);
  const [claudeImportRunning, setClaudeImportRunning] = useState(false);
  const [claudeImportReport, setClaudeImportReport] =
    useState<ClaudeImportReport | null>(null);
  const [openCodeImportProject, setOpenCodeImportProject] = useState<Project | null>(
    null,
  );
  const [projectResourcesProject, setProjectResourcesProject] = useState<Project | null>(null);
  const [openCodeImportSessions, setOpenCodeImportSessions] = useState<
    OpenCodeSessionSummary[]
  >([]);
  const [openCodeImportSelected, setOpenCodeImportSelected] = useState<string[]>([]);
  const [openCodeImportLoading, setOpenCodeImportLoading] = useState(false);
  const [openCodeImportRunning, setOpenCodeImportRunning] = useState(false);
  const [openCodeImportReport, setOpenCodeImportReport] =
    useState<OpenCodeImportReport | null>(null);
  // showToast 使用 app-notice 统一展示，见下方函数定义
  // 历史命令相关状态
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [historyNavigating, setHistoryNavigating] = useState(false);
  const [savedPrompt, setSavedPrompt] = useState("");
  const [compacting, setCompacting] = useState(false);
  const [drawer, setDrawer] = useState<DrawerPanel | null>(null);

  // ── 每个 Agent 的抽屉面板状态持久化（localStorage） ──
  // 用户切换会话时自动恢复上次的文件面板状态和展开目录，避免每次进来都要重新点开。
  const AGENT_DRAWER_KEY_PREFIX = "pid:agent-drawer:";
  const AGENT_EXPANDED_DIRS_KEY_PREFIX = "pid:agent-expanded-dirs:";

  const saveDrawerState = useCallback((agentId: string, panel: DrawerPanel | null, pinned: boolean) => {
    try {
      localStorage.setItem(AGENT_DRAWER_KEY_PREFIX + agentId, JSON.stringify({ panel, pinned }));
    } catch { /* localStorage 不可用时静默忽略 */ }
  }, []);

  const loadDrawerState = useCallback((agentId: string): { panel: DrawerPanel | null; pinned: boolean } | null => {
    try {
      const raw = localStorage.getItem(AGENT_DRAWER_KEY_PREFIX + agentId);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && (parsed.panel === null || ["files", "sessions", "browser", "editor"].includes(parsed.panel))) {
          return parsed;
        }
      }
    } catch { /* ignore */ }
    return null;
  }, []);

  const saveExpandedDirs = useCallback((agentId: string, dirs: Set<string>) => {
    try {
      localStorage.setItem(AGENT_EXPANDED_DIRS_KEY_PREFIX + agentId, JSON.stringify([...dirs]));
    } catch { /* ignore */ }
  }, []);

  const loadExpandedDirs = useCallback((agentId: string): Set<string> => {
    try {
      const raw = localStorage.getItem(AGENT_EXPANDED_DIRS_KEY_PREFIX + agentId);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return new Set(arr);
      }
    } catch { /* ignore */ }
    return new Set();
  }, []);
  const [renderedDrawer, setRenderedDrawer] = useState<DrawerPanel | null>(null);
  const drawerUnmountTimerRef = useRef<number | null>(null);
  // 最后一个 editor tab 被关闭时自动收起 drawer
  useEffect(() => {
    if (editorTabs.length === 0 && drawer === "editor") {
      setDrawer(null);
    }
  }, [editorTabs.length, drawer]);
  const [sessionsProjectId, setSessionsProjectId] = useState<string>();
  const [sessionHistoryLoading, setSessionHistoryLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateDownloading, setUpdateDownloading] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<AppUpdateDownloadProgress | null>(null);
  const [downloadedUpdatePath, setDownloadedUpdatePath] = useState<string | null>(null);
  const [upToDateVersion, setUpToDateVersion] = useState<string | null>(null);
  const [piUpdating, setPiUpdating] = useState(false);
  const [piUpdateChecking, setPiUpdateChecking] = useState(false);
  const [piUpdateCheck, setPiUpdateCheck] = useState<PiUpdateCheckResult | null>(null);
  const [piUpdateResult, setPiUpdateResult] = useState<PiCliUpdateResult | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [windowAlwaysOnTop, setWindowAlwaysOnTop] = useState(false);
  const [_debugOpen, _setDebugOpen] = useState(false);
  /** RPC 日志弹窗目标 agent */
  const [agentRpcLogging, setAgentRpcLogging] = useState<Map<string, boolean>>(new Map());
  /** 是否自动滚动到最新消息 */
  const [autoScroll, setAutoScroll] = useState(true);
  /** 用 ref 同步 autoScroll，供 ResizeObserver 回调读取最新值，避免响应式时序间隙导致滚动抢跑。 */
  const autoScrollRef = useRef(true);
  autoScrollRef.current = autoScroll;
  /** 是否显示"移动到最新"按钮 */
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  /** 会话定位跳转到尚未加载的旧消息时，先扩展分页再在 effect 中滚动定位；此状态保存待跳转的消息 id。 */
  const [pendingJumpId, setPendingJumpId] = useState<string | null>(null);
  /** 加载更多历史消息前的滚动锚点（旧 scrollHeight + scrollTop），用于渲染后按顶部锚定恢复滚动位置。 */
  const loadMoreAnchorRef = useRef<{ height: number; top: number } | null>(null);

  const [settings, setSettings] = useState<AppSettings>({
    useNativeTitleBar: true,
    showNativeMenu: false,
    sendShortcut: "enter-send",
    theme: "system",
    lightBackground: "white",
    language: "system",
    piEnvironmentChecked: false,
    closeToTray: true,
    enableNotifications: true,
    // showThinking 由 pi agent 的 hideThinkingBlock 控制，启动后从主进程加载的真实值会覆盖此处
    showThinking: true,
    showDevTools: false,
    piProxyEnabled: false,
    piProxyUrl: "http://127.0.0.1:7890",
    piProxyBypass: "localhost,127.0.0.1,::1",
    desktopProxyEnabled: false,
    desktopProxyUrl: "http://127.0.0.1:7890",
    desktopProxyBypass: "localhost,127.0.0.1,::1",
    customPiPath: "",
    wslEnabled: false,
    wslDistro: "Ubuntu",
    wslUser: "root",
    telemetryEnabled: true,
    webServiceEnabled: false,
    webServiceHost: "0.0.0.0",
    webServicePort: 8765,
    rpcTimeout: 600_000,
    linkOpenMode: "external",
    contentMaxWidth: 1400,
    maxEditorFileSizeMB: 5,
    externalEditors: createDefaultExternalEditorSettings(),

    // 桌面宠物默认关闭：关闭后应用与现状完全一致，零回归
    petEnabled: false,
    petId: "clawd",
    petAlwaysOnTop: true,
    petScale: 0.8,
    petPatrolEnabled: true,
    petPatrolPauseMin: 5,
    favoriteModels: [],

    // 字体配置：与 main SettingsStore 默认值保持一致，避免启动时闪烁
    fontSize: "default",
    uiFontSize: null,
    chatFontSize: null,
    inputFontSize: null,
    zoomFactor: 1,
    fontFamilyBase: "system",
    fontFamilyBaseCustom: "",
    fontFamilyMono: "commit-mono",
    fontFamilyMonoCustom: "",
  });
  /* settingsNotice 已改用 showToast (app-notice) 实现 */
  const [piProxyNotice, setPiProxyNotice] = useState("");
  const [piProxyNoticeTone, setPiProxyNoticeTone] = useState<
    "info" | "success" | "error"
  >("info");
  const [piStatus, setPiStatus] = useState<PiInstallStatus | null>(null);
  const [piProxyChecking, setPiProxyChecking] = useState(false);
  const [webServiceChanging, setWebServiceChanging] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo>({
    version: "-",
    releasesUrl: "https://github.com/ayuayue/pi-desktop/releases",
  });
  const [piChecking, setPiChecking] = useState(false);
  const resolvedLocale = resolveLocale(settings.language);
  setI18nLocale(resolvedLocale);
  // 手动输入 pi 路径相关状态
  const [customPiPath, setCustomPiPath] = useState("");
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const [customPathResult, setCustomPathResult] =
    useState<PiInstallStatus | null>(null);
  /** npm 可用性检测 */
  const [npmAvailable, setNpmAvailable] = useState<boolean | null>(null);
  const [npmVersion, setNpmVersion] = useState<string | undefined>(undefined);
  const [npmChecking, setNpmChecking] = useState(false);
  /** 安装命令文本（可编辑） */
  const [installCommand, setInstallCommand] = useState(
    "npm install -g @earendil-works/pi-coding-agent",
  );
  /** 是否使用国内镜像源 */
  const [installUseMirror, setInstallUseMirror] = useState(false);
  /** 是否正在执行安装 */
  const [installExecuting, setInstallExecuting] = useState(false);
  /** 安装执行结果 */
  const [installResult, setInstallResult] = useState<PiInstallExecResult | null>(null);
  /** 安装是否已成功完成 */
  const [installCompleted, setInstallCompleted] = useState(false);
  const [environmentDialog, setEnvironmentDialog] = useState(false);
  const DEFAULT_LIST_WIDTH = 260;
  const [listWidth, setListWidth] = useState(DEFAULT_LIST_WIDTH);
  const [drawerWidth, setDrawerWidth] = useState(270);
  const [composerHeight, setComposerHeight] = useState(COMPOSER_MIN_HEIGHT);
  const [composerOffsetHeight, setComposerOffsetHeight] = useState(0);
  const [composerAutoHeight, setComposerAutoHeight] =
    useState(COMPOSER_MIN_HEIGHT);
  const [terminalDockStateByAgent, setTerminalDockStateByAgent] =
    useState<TerminalDockStateByAgent>({});
  const [terminalHeightByAgent, setTerminalHeightByAgent] = useState<
    Record<string, number>
  >({});
  const [terminalDockMounted, setTerminalDockMounted] = useState(false);
  const [terminalDockClosing, setTerminalDockClosing] = useState(false);
  const [terminalDockAgentId, setTerminalDockAgentId] = useState<string>();
  const terminalDockCloseTimerRef = useRef<number | null>(null);
  const [listCollapsed, setListCollapsed] = useState(false);
  const [listHoverRevealSuppressed, setListHoverRevealSuppressed] =
    useState(false);
  const [drawerCollapsed, setDrawerCollapsed] = useState(false);
  const [drawerPinnedByAgent, setDrawerPinnedByAgent] = useState<
    Record<string, DrawerPanel>
  >({});
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const chatPaneRef = useRef<HTMLElement | null>(null);
  const sessionComboRef = useRef<HTMLDivElement | null>(null);
  const chatHeaderRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLElement | null>(null);
  const timelineRef = useRef<HTMLElement | null>(null);
  const composerBoxRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLDivElement | null>(null);
  // RichInput 受控重渲染后,光标应恢复到的纯文本偏移(供建议选中/清除后恢复选区)。
  const pendingComposerCaretRef = useRef<number | null>(null);
  const pendingAgentsRef = useRef<PendingAgentTab[]>([]);
  const projectDragPreventClickRef = useRef(false);

  // ===== 飞书桥接 =====

  const feishu = useFeishuBridge();
  const scratchPad = useScratchPad();

  // 当活跃 Agent 切换时，从 localStorage 恢复该 Agent 的抽屉面板状态和展开目录
  // 使得用户切换会话后文件面板和展开目录保持之前的状态。
  useEffect(() => {
    if (!activeAgentId) return;
    const savedState = loadDrawerState(activeAgentId);
    if (savedState) {
      const panel: DrawerPanel | null = savedState.panel;
      if (savedState.pinned && panel) {
        setDrawerPinnedByAgent((current) => {
          if (current[activeAgentId] === panel) return current;
          return { ...current, [activeAgentId]: panel };
        });
      }
      if (panel) {
        setDrawer(panel);
        setDrawerCollapsed(false);
      }
    }
    const dirs = loadExpandedDirs(activeAgentId);
    setExpandedDirs(dirs);
  }, [activeAgentId, loadDrawerState, loadExpandedDirs]);

  // 当活跃 Agent 切换或绑定列表变更时，加载该 Agent 指定的飞书 Bot
  // 绑定变更后同步刷新，确保配置页断开关联后已连接状态正确反映。
  useEffect(() => {
    if (!activeAgentId) {
      setSessionFeishuBotId(undefined);
      return;
    }
    feishu.getSessionBot(activeAgentId).then((botId) => {
      setSessionFeishuBotId(botId);
    });
  }, [activeAgentId, feishu.bindings]);

  // Bot 列表变更后，若当前会话固定的 Bot 已被删除，则清除本地缓存避免指示器展示已失效的固定状态。
  useEffect(() => {
    if (!sessionFeishuBotId) return;
    if (!feishu.bots.some((bot) => bot.id === sessionFeishuBotId)) {
      setSessionFeishuBotId(undefined);
    }
  }, [feishu.bots, sessionFeishuBotId]);

  const activeProject = projects.find(
    (project) => project.id === activeProjectId,
  );
  const sessionsProject = projects.find(
    (project) => project.id === sessionsProjectId,
  );
  const displayAgents = useMemo(() => {
    const realIds = new Set(agents.map((agent) => agent.id));
    return [
      ...agents,
      ...pendingAgents.filter(
        (agent) =>
          !realIds.has(agent.id) &&
          !agents.some((realAgent) =>
            isReplacementForPendingAgent(realAgent, agent),
          ),
      ),
    ];
  }, [agents, pendingAgents]);
  // displayAgents 的 ref，供只挂载一次的 IPC 监听器读取最新 Agent 列表，避免闭包陈旧
  const displayAgentsRef = useRef(displayAgents);
  displayAgentsRef.current = displayAgents;
  const activeAgent = displayAgents.find((agent) => agent.id === activeAgentId);
  const prompt = activeAgentId ? (promptByAgent[activeAgentId] ?? "") : "";
  const attachedImages = activeAgentId
    ? (attachedImagesByAgent[activeAgentId] ?? [])
    : [];

  function setPrompt(value: string | ((current: string) => string)) {
    const targetAgentId = activeAgentIdRef.current;
    if (!targetAgentId) return;
    setPromptByAgent((current) => {
      const previous = current[targetAgentId] ?? "";
      const nextValue = typeof value === "function" ? value(previous) : value;
      if (!nextValue) {
        const next = { ...current };
        delete next[targetAgentId];
        return next;
      }
      return {
        ...current,
        [targetAgentId]: nextValue,
      };
    });
  }

  function setAttachedImages(
    value: ImageContent[] | ((current: ImageContent[]) => ImageContent[]),
  ) {
    if (!activeAgentId) return;
    setAttachedImagesByAgent((current) => {
      const previous = current[activeAgentId] ?? [];
      const nextValue = typeof value === "function" ? value(previous) : value;
      if (nextValue.length === 0) {
        const next = { ...current };
        delete next[activeAgentId];
        return next;
      }
      return {
        ...current,
        [activeAgentId]: nextValue,
      };
    });
  }
  const terminalDockState = activeAgentId
    ? terminalDockStateByAgent[activeAgentId]
    : undefined;
  // 终端打开/折叠状态按 agent 隔离,避免切换项目/agent 后丢失当前终端 UI 状态。
  const terminalOpen = Boolean(terminalDockState?.open);
  const terminalCollapsed = Boolean(terminalDockState?.collapsed);
  const terminalDockVisible =
    terminalDockMounted && terminalDockAgentId === activeAgentId;

  // 轨道尺寸只在开关时变更一次，终端本身用 transform 完成合成动画。
  // 关闭时保留组件至动画结束，避免同步销毁 xterm 阻塞第一帧。
  useEffect(() => {
    if (terminalOpen && activeAgentId) {
      if (terminalDockCloseTimerRef.current != null) {
        window.clearTimeout(terminalDockCloseTimerRef.current);
        terminalDockCloseTimerRef.current = null;
      }
      setTerminalDockAgentId(activeAgentId);
      setTerminalDockClosing(false);
      setTerminalDockMounted(true);
      return;
    }
    if (!terminalDockMounted) return;
    if (terminalDockAgentId !== activeAgentId) {
      setTerminalDockMounted(false);
      return;
    }

    setTerminalDockClosing(true);
    terminalDockCloseTimerRef.current = window.setTimeout(
      () => {
        setTerminalDockMounted(false);
        setTerminalDockClosing(false);
      },
      TERMINAL_DOCK_MOTION_MS,
    );
    return () => {
      if (terminalDockCloseTimerRef.current != null) {
        window.clearTimeout(terminalDockCloseTimerRef.current);
        terminalDockCloseTimerRef.current = null;
      }
    };
  }, [activeAgentId, terminalDockAgentId, terminalDockMounted, terminalOpen]);

  const drawerPinnedPanel = activeAgentId
    ? drawerPinnedByAgent[activeAgentId]
    : undefined;
  const drawerPinned = Boolean(drawerPinnedPanel);
  const activeMessages = activeAgentId
    ? (messagesByAgent[activeAgentId] ?? [])
    : [];
  const activeRuntimeState = activeAgentId
    ? runtimeStateByAgent[activeAgentId]
    : undefined;

  // 消息分页:超过 100 条消息时启用,大幅减少输入卡顿
  // 首屏 100 条,每次加载 100 条,一页一页懒加载
  const {
    visibleMessages: paginatedMessages,
    hasMore: hasMoreMessages,
    loadMore: loadMoreMessages,
    loadUntilIncluded: loadMessagesUntilIncluded,
    isLoading: isLoadingMoreMessages,
  } = useMessagePagination({
    messages: activeMessages,
    initialPageSize: 100, // 首屏 100 条
    pageSize: 100,        // 每次加载 100 条
    enabled: activeMessages.length > 100, // 超过 100 条才启用
  });

  /** 最后一条用户消息的 id，用于决定重发按钮只在最新消息上显示。 */
  /**
   * 将分页消息按 agent run 分组，用于 TurnRow 渲染。
   * 用户/错误/系统消息保持独立条目，assistant + tool 消息聚合为 agnet-run。
   */
  const renderedRuns = useMemo(
    () => groupToolMessages(paginatedMessages),
    [paginatedMessages],
  );

  // 多选分享：图片只克隆已勾选的可见消息，避免截到整屏会话或被滚动容器裁掉。
  const handleMultiSelectCopy = useCallback(async (selectedIds: Set<string>, kind: "text" | "markdown" | "image") => {
    if (kind === "image") {
      try {
        const { toBlob: toBlobImg } = await import("html-to-image");
        const source = document.querySelector(".message-list") as HTMLElement | null;
        if (!source) return;

        const captureIds = getMultiSelectImageCaptureIds(renderedRuns, selectedIds);
        const clone = source.cloneNode(true) as HTMLElement;
        for (const item of Array.from(clone.children)) {
          if (!(item instanceof HTMLElement)) continue;
          const id = item.dataset.messageId;
          if (!id || !captureIds.has(id)) item.remove();
        }
        clone.classList.add("multi-select-image-export");
        clone.style.width = `${Math.max(source.clientWidth, source.scrollWidth)}px`;
        clone.style.padding = "24px";
        clone.style.background = getComputedStyle(document.documentElement).getPropertyValue("--color-bg-panel") || "#fff";
        document.body.appendChild(clone);
        let blob: Blob | null = null;
        try {
          blob = await toBlobImg(clone, {
            pixelRatio: Math.min(2, window.devicePixelRatio || 1),
            backgroundColor: getComputedStyle(document.documentElement).getPropertyValue("--color-bg-panel") || undefined,
            filter: (node) =>
              !(node instanceof HTMLElement) ||
              (!node.classList.contains("turn-row-actions") &&
                !node.classList.contains("user-turn-actions") &&
                !node.classList.contains("copy-menu-popover")),
          });
        } finally {
          clone.remove();
        }
        if (blob) {
          await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
          showToast(t("copy.asImageCopied"));
        }
      } catch {
        showToast(t("copy.failed"));
      }
      setMultiSelectOpen(false);
      return;
    }

    const selected = activeMessages
      .filter((m) => selectedIds.has(m.id))
      .sort((a, b) => a.timestamp - b.timestamp);
    if (selected.length === 0) return;

    const separator = "\n\n---\n\n";
    const content = kind === "text"
      ? selected.map((m) => {
          let text = m.text;
          text = text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
          text = text.replace(/<thinking>[\s\S]*?<\/thinking>/g, "");
          text = text.replace(/<skill\s+name="[^"]*"[^>]*>[\s\S]*?<\/skill>/gi, "");
          return text.trim();
        }).join(separator)
      : selected.map((m) => m.text).join(separator);

    await navigator.clipboard.writeText(content);
    showToast(kind === "text" ? t("copy.asTextCopied") : t("copy.asMarkdownCopied"));
    setMultiSelectOpen(false);
  }, [activeMessages, renderedRuns]);

  const lastUserMessageId = useMemo(() => {
    for (let i = activeMessages.length - 1; i >= 0; i--) {
      if (activeMessages[i].role === "user") return activeMessages[i].id;
    }
    return undefined;
  }, [activeMessages]);
  // 从 activeUiRequest 提取正在进行的交互式请求（select/confirm/input/editor）
  // 这是 ask_question 在 pi RPC 模式下的表现方式：pi 通过 extension_ui_request 将
  // 等待用户回答的对话框发送到桌面端，包含 requestId、title、options 等完整信息。
  const activeUiAsk = useMemo(() => {
    if (!activeUiRequest) return undefined;
    return Object.values(activeUiRequest).find(
      (req) => !req.completed && ["select", "confirm", "input", "editor"].includes(req.method),
    );
  }, [activeUiRequest]);
  // dialog 显示条件：仅当有活跃的交互式 UI 请求时
  const showAskDialog = activeUiAsk !== undefined;
  // 用 body class 控制内联 ask 卡片的显示
  useEffect(() => {
    document.body.classList.toggle("ask-dialog-open", showAskDialog);
    return () => document.body.classList.remove("ask-dialog-open");
  }, [showAskDialog]);

  const isAwaitingAssistant = Boolean(
    activeAgent &&
    !cancellingUi &&
    (activeAgent.status === "running" || activeRuntimeState?.isStreaming) &&
    activeMessages.at(-1)?.role !== "assistant",
  );
  /** 正在流式追加的最后一条 assistant 消息的 id（agent 处于运行/流式状态时才有值）。
   *  用于让对应 AssistantText 走轻量渲染路径，避免每个 token 都对不断增长的全量正文
   *  反复运行 KaTeX 数学解析导致渲染主线程卡死；回答结束后切回完整渲染。 */
  const streamingMessageId = useMemo(() => {
    if (!activeAgent || activeAgent.status !== "running") return undefined;
    if (!(activeRuntimeState?.isStreaming)) return undefined;
    for (let i = activeMessages.length - 1; i >= 0; i--) {
      const m = activeMessages[i];
      if (m.role === "user") break;
      // 跳过纯 thinking / 工具消息，定位最后一条有实际正文的 assistant 消息
      if (m.role === "assistant" && (m.text || "").trim()) return m.id;
    }
    return undefined;
  }, [activeAgent, activeRuntimeState, activeMessages]);

  /** 当前活跃 agent 的实时思考文本 */
  const activeThinking = activeAgentId
    ? (streamingThinking[activeAgentId] ?? "")
    : "";
  const activeTerminalHeight = activeAgentId
    ? (terminalHeightByAgent[activeAgentId] ?? COMPOSER_DEFAULT_TERMINAL_HEIGHT)
    : COMPOSER_DEFAULT_TERMINAL_HEIGHT;
  // 终端 Grid 只做 120ms 短过渡，面板表面仍由 transform 完成主要运动。
  const terminalRowHeight =
    !terminalDockVisible || terminalDockClosing
      ? 0
      : terminalCollapsed
        ? 34
        : activeTerminalHeight;
  const resolvedComposerHeight = Math.max(composerHeight, composerAutoHeight);
  const composerMode = prompt.startsWith("!!")
    ? "silent-shell"
    : prompt.startsWith("!")
      ? "shell"
      : currentComposerAgentMode === "plan"
        ? "plan"
        : null;
  const composerStatusText =
    composerMode === "silent-shell"
      ? t("app.composerSilentStatus")
      : composerMode === "shell"
        ? t("app.composerShellStatus")
        : composerMode === "plan"
          ? t("app.composerPlanStatus")
          : drawer === "files"
          ? t("app.composerFilesStatus")
          : drawer === "sessions"
            ? t("app.composerSessionStatus", {
                name: sessionsProject?.name ?? t("common.project"),
              })
            : (activeAgent?.sessionPath ?? "");
  const drawerContentPanel = drawer && !drawerCollapsed ? drawer : renderedDrawer;

  useEffect(() => {
    if (!drawerPinnedPanel) return;
    if (drawer !== drawerPinnedPanel) setDrawer(drawerPinnedPanel);
    if (drawerCollapsed) setDrawerCollapsed(false);
  }, [drawer, drawerCollapsed, drawerPinnedPanel]);

  useEffect(() => {
    if (drawerUnmountTimerRef.current) {
      window.clearTimeout(drawerUnmountTimerRef.current);
      drawerUnmountTimerRef.current = null;
    }

    if (drawer && !drawerCollapsed) {
      setRenderedDrawer(drawer);
      return;
    }

    if (!renderedDrawer) return;
    // 抽屉收回时保留最后内容，等 transform 动画结束后再卸载；否则文字会先消失，再空壳收回。
    drawerUnmountTimerRef.current = window.setTimeout(() => {
      setRenderedDrawer(null);
      drawerUnmountTimerRef.current = null;
    }, DRAWER_ANIMATION_MS);

    return () => {
      if (drawerUnmountTimerRef.current) {
        window.clearTimeout(drawerUnmountTimerRef.current);
        drawerUnmountTimerRef.current = null;
      }
    };
  }, [drawer, drawerCollapsed, renderedDrawer]);

  useEffect(() => {
    document.documentElement.lang = resolvedLocale;
  }, [resolvedLocale]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolvedTheme =
        settings.theme === "system"
          ? media?.matches
            ? "dark"
            : "light"
          : settings.theme;
      document.documentElement.dataset.theme = resolvedTheme;
      document.documentElement.dataset.lightBackground = settings.lightBackground;
    };
    applyTheme();
    if (settings.theme !== "system" || !media) return;
    media.addEventListener?.("change", applyTheme);
    return () => media.removeEventListener?.("change", applyTheme);
  }, [settings.theme, settings.lightBackground]);

  // 字号与命名字体预设由 data 属性选择 CSS token；只有 custom 字体需要注入用户输入。
  useEffect(() => {
    const root = document.documentElement;
    const uiFontSize = settings.uiFontSize ?? settings.fontSize;
    const chatFontSize = settings.chatFontSize ?? settings.fontSize;
    const inputFontSize = settings.inputFontSize ?? settings.fontSize;
    root.dataset.uiFontSize = uiFontSize;
    root.dataset.chatFontSize = chatFontSize;
    root.dataset.inputFontSize = inputFontSize;
    // 旧属性保留，兼容外部依赖或测试仍读取 dataset.fontSize 的场景
    root.dataset.fontSize = settings.fontSize;
    root.dataset.fontBase = settings.fontFamilyBase;
    root.dataset.fontMono = settings.fontFamilyMono;

    const baseCustomFont = settings.fontFamilyBaseCustom.trim();
    if (settings.fontFamilyBase === "custom" && baseCustomFont) {
      root.style.setProperty("--font-family-base", baseCustomFont);
    } else {
      root.style.removeProperty("--font-family-base");
    }

    const monoCustomFont = settings.fontFamilyMonoCustom.trim();
    if (settings.fontFamilyMono === "custom" && monoCustomFont) {
      root.style.setProperty("--font-family-mono", monoCustomFont);
    } else {
      root.style.removeProperty("--font-family-mono");
    }
  }, [
    settings.fontSize,
    settings.uiFontSize,
    settings.chatFontSize,
    settings.inputFontSize,
    settings.fontFamilyBase,
    settings.fontFamilyBaseCustom,
    settings.fontFamilyMono,
    settings.fontFamilyMonoCustom,
  ]);

  /** 当前会话中 agent 修改过的文件(从 tool 消息 meta 中提取) */
  // 优化:只在消息数量变化时才重新计算,减少不必要的遍历
  const modifiedFiles = useMemo(() => {
    const byPath = new Map<string, SessionModifiedFile>();
    for (const msg of activeMessages) {
      if (msg.role !== "tool") continue;
      const toolName: string | undefined = msg.meta?.toolName as
        | string
        | undefined;
      const args: any = msg.meta?.args;
      const status: string = String(msg.meta?.status ?? "done");
      // 只收集文件写入/编辑类的工具调用，作为右侧 Files 与会话结束摘要的统一数据源。
      if (!toolName || !/write|edit|create|patch/i.test(toolName)) continue;
      const filePath = getToolFilePath(args);
      if (!filePath) continue;
      const previous = byPath.get(filePath);
      // 同一路径再次被修改时移动到 Map 末尾，右侧修改清单才能按"最新修改"展示。
      if (previous) byPath.delete(filePath);
      // originalContent 不再存储到消息 meta 中（full file 会使会话体积过大）。
      // diff 展示时使用工具参数（oldText/newText）显示变动区域。
      byPath.set(filePath, {
        path: filePath,
        toolName,
        status: status === "running" ? "running" : (previous?.status ?? status),
        changedLines:
          (previous?.changedLines ?? 0) +
          getToolChangedLineCount(toolName, args),
        originalContent: "",
        content: getToolNewContent(toolName, args) ?? previous?.content,
      });
    }
    return Array.from(byPath.values());
  }, [activeMessages.length, activeAgentId]);
  // 优化:轮廓项计算仅在消息数量变化时触发,减少不必要的重计算
  const outlineItems = useMemo(
    () => buildOutline(activeMessages),
    [activeMessages.length, activeAgentId],
  );
  const flatFiles = useMemo(() => flattenFiles(files), [files]);
  // 优化:建议项计算仅在必要时触发,避免每次输入都重计算导致卡顿
  // 只有当建议框打开时才计算,关闭时返回空数组
  const activeProjectSessions = useMemo(
    () => (activeProjectId ? sessionsByProject[activeProjectId] ?? [] : []),
    [activeProjectId, sessionsByProject],
  );

  const suggestionItems = useMemo(
    () =>
      suggestionsOpen
        ? buildSuggestionItems(prompt, composerCursor, commands, flatFiles, activeProjectSessions)
        : [],
    [suggestionsOpen, prompt, composerCursor, commands, flatFiles, activeProjectSessions],
  );

  /** 有效命令名白名单：仅已知命令渲染为 chip */
  const mergedCommands = useMemo(
    () => mergeCommands(commands),
    [commands],
  );
  const validCommandNames = useMemo(
    () => new Set([
      ...mergedCommands.map((c) => c.name),
      ...promptTemplateList.map((t) => t.name),
    ]),
    [mergedCommands, promptTemplateList],
  );

  /** 有效文件路径白名单：仅工作区真实存在的 @ 引用渲染为 chip */
  const validFilePaths = useMemo(
    () => new Set(flatFiles.map((f) => f.relativePath)),
    [flatFiles],
  );

  const validSessionRefs: Set<string> = useMemo(
    () => new Set(activeProjectSessions.map((s) => s.name ?? s.filePath)),
    [activeProjectSessions],
  );

  /** 菜单光标锚定位置（屏幕坐标），仅在 suggestionsOpen 时计算。 */
  const suggestionAnchorStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!suggestionsOpen) return undefined;
    const root = composerTextareaRef.current;
    if (!root) return undefined;
    const coords = getRichInputCaretCoords(root, composerCursor);
    if (!coords) return undefined;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const menuW = Math.min(520, vw - 120);
    const menuH = 380;
    const gap = 8;

    // 水平：光标左对齐，超出则右贴边
    let left = coords.left;
    if (left + menuW > vw - 16) left = Math.max(16, vw - menuW - 16);

    // 垂直：优先光标下方，空间不够则上方
    const belowTop = coords.top + gap;
    const aboveBottom = coords.top - gap;
    if (belowTop + menuH <= vh - 16) {
      return { top: belowTop, left, bottom: "auto", transform: "none" };
    }
    if (aboveBottom - menuH >= 0) {
      return { top: "auto", bottom: vh - aboveBottom, left, transform: "none" };
    }
    return { top: "auto", bottom: 16, left, transform: "none" };
  }, [suggestionsOpen, composerCursor]);
  const visibleAgents = useMemo(
    () =>
      displayAgents.filter((agent) =>
        matches(agent.title + agent.cwd + (agent.sessionId ?? ""), search),
      ),
    [displayAgents, search],
  );
  const filteredAgents = visibleAgents;
  const filteredProjects = useMemo(
    () =>
      projects.filter((project) => {
        // worktree 子项目不显示在主列表中，只在父项目下以子项展示
        if (project.worktreeParentId) return false;
        const projectSessions = sessionsByProject[project.id] ?? [];
        return (
          matches(project.name + project.path, search) ||
          displayAgents.some(
            (agent) =>
              agent.projectId === project.id &&
              matches(
                agent.title + agent.cwd + (agent.sessionId ?? ""),
                search,
              ),
          ) ||
          projectSessions.some((session) =>
            matches(
              `${session.name ?? ""}${session.preview}${session.filePath}`,
              search,
            ),
          )
        );
      }),
    [displayAgents, projects, search, sessionsByProject],
  );
  const projectIdsKey = useMemo(
    () => projects.map((project) => project.id).join("\n"),
    [projects],
  );
  const canReorderProjects = search.trim().length === 0;

  useEffect(() => {
    window.setTimeout(() => void refreshProjects(), 0);
    window.setTimeout(() => void api.agents.list().then(setAgents), 0);
    void api.editors.list().then(setExternalEditors).catch(() => undefined);
    void api.app
      .info()
      .then(setAppInfo)
      .catch(() => undefined);
    void api.settings.get().then((next) => {
      setSettings(next);
      setCustomPiPath(next.customPiPath ?? "");
      if (!Object.values(next.externalEditors).some((editor) => editor.command)) {
        void api.editors
          .redetect()
          .then((updated) => {
            setSettings(updated);
            return api.editors.list();
          })
          .then(setExternalEditors)
          .catch(() => undefined);
      }
      if (!next.piEnvironmentChecked) {
        // 首次检测延后一帧启动,先让主界面完成绘制,避免 packaged app 打开时出现几秒白屏。
        window.setTimeout(() => void checkPiInstall("startup"), 300);
      }
      window.setTimeout(() => void checkPiCliUpdateOnStartup(), 1200);
    });

    // 加载历史命令
    try {
      const savedHistory = localStorage.getItem("pideck-command-history");
      if (savedHistory) {
        setCommandHistory(JSON.parse(savedHistory));
      }
    } catch (error) {
      console.error("Failed to load command history:", error);
    }

    const offProjects = api.projects.onChanged((next) => {
      setProjects(next);
      if (!activeProjectId && next.length > 0) setActiveProjectId(next[0].id);
    });
    const offState = api.agents.onState((nextAgents) => {
      const previousPendingAgents = pendingAgentsRef.current;
      const remainingPendingAgents = previousPendingAgents.filter(
        (pending) =>
          !nextAgents.some((agent) =>
            isReplacementForPendingAgent(agent, pending),
          ),
      );
      const pendingReplacementById = new Map(
        previousPendingAgents
          .map((pending) => {
            const replacement = nextAgents.find((agent) =>
              isReplacementForPendingAgent(agent, pending),
            );
            return replacement ? [pending.id, replacement.id] : undefined;
          })
          .filter((entry): entry is [string, string] => Boolean(entry)),
      );
      if (remainingPendingAgents.length !== previousPendingAgents.length) {
        pendingAgentsRef.current = remainingPendingAgents;
        setPendingAgents(remainingPendingAgents);
      }
      setAgents(nextAgents);
      setActiveAgentId((current) => {
        if (!current) return undefined;
        if (nextAgents.some((agent) => agent.id === current)) return current;
        const pendingAgent = previousPendingAgents.find(
          (agent) => agent.id === current,
        );
        const replacement = pendingAgent
          ? nextAgents.find((agent) =>
              isReplacementForPendingAgent(agent, pendingAgent),
            )
          : undefined;
        if (replacement) return replacement.id;
        return pendingAgent ? current : undefined;
      });
      const activeIds = new Set(nextAgents.map((agent) => agent.id));
      const draftIds = new Set([
        ...nextAgents.map((agent) => agent.id),
        ...remainingPendingAgents.map((agent) => agent.id),
      ]);
      setTerminalDockStateByAgent((current) =>
        pruneTerminalDockState(current, activeIds),
      );
      setTerminalHeightByAgent((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([agentId]) => activeIds.has(agentId)),
        ),
      );
      setDrawerPinnedByAgent((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([agentId]) => activeIds.has(agentId)),
        ),
      );
      setPromptByAgent((current) =>
        migrateAgentRecord(current, pendingReplacementById, draftIds),
      );
      setAttachedImagesByAgent((current) =>
        migrateAgentRecord(current, pendingReplacementById, draftIds),
      );
      // 裁剪已关闭 agent 的消息缓存，释放 renderer 内存；重启占位需要参与 liveIds，避免旧进程移除时聊天记录闪空。
      setMessagesByAgent((current) =>
        migrateAgentRecord(current, pendingReplacementById, draftIds),
      );
    });
    // 优化:历史会话加载时消息更新频繁,只在消息真正变化时更新 state,避免不必要的重渲染导致输入卡顿
    const offMessages = api.agents.onMessages((payload) =>
      setMessagesByAgent((current) => {
        const prevMessages = current[payload.agentId];
        // 消息数量相同且引用相同时跳过更新,减少输入框重渲染
        if (
          prevMessages?.length === payload.messages.length &&
          prevMessages === payload.messages
        ) {
          return current;
        }
        return {
          ...current,
          [payload.agentId]: payload.messages,
        };
      }),
    );
    const offLog = api.agents.onLog((payload) =>
      setLogs((current) => {
        // 优化:只在超过200条时才slice,减少不必要的数组操作
        const newLog = `[${payload.agentId.slice(0, 8)}] ${payload.text}`;
        if (current.length < 200) {
          return [...current, newLog];
        }
        return [...current.slice(-199), newLog];
      }),
    );
    const offSettings = api.settings.onApplyWindow((next) => {
      setSettings(next);
      showToast(t("settings.restartNotice"));
    });
    const offUpdateProgress = api.app.onUpdateProgress((progress) => {
      setUpdateProgress(progress);
      if (progress.state === "completed") {
        setUpdateDownloading(false);
        setDownloadedUpdatePath(progress.filePath ?? null);
      } else if (progress.state === "failed") {
        setUpdateDownloading(false);
        setUpdateError(progress.error ?? t("update.downloadFailed"));
      }
    });
    // 监听后端主动推送的 runtimeState 更新(如 agent_end 时重置 isStreaming),
    // 确保前端 isAgentBusy 判断基于最新状态,排队 flush 能正常触发。
    const offRuntimeState = api.agents.onRuntimeState((payload) =>
      setRuntimeStateByAgent((current) => ({
        ...current,
        [payload.agentId]: payload.state,
      })),
    );
    // 监听流式思考内容更新,用于在 agent 响应前展示推理过程
    const offThinking = api.agents.onThinking((payload: ThinkingUpdate) =>
      setStreamingThinking((current) => ({
        ...current,
        [payload.agentId]: payload.thinking,
      })),
    );
    // 监听 Extension UI 请求：对话类渲染为提问卡片；setWidget 类作为 composer 上方的轻量状态块展示。
    const offUiRequest = api.agents.onUiRequest((request) => {
      if (request.method === "notify") {
        const notifyRequest = request as UiRequest;
        if (notifyRequest.message) {
          showNotice(notifyRequest.message, notifyRequest.notifyType === "error" ? 5000 : 3500);
        }
        return;
      }

      if (request.method === "set_editor_text") {
        const editorRequest = request as UiRequest;
        const text = editorRequest.text ?? "";
        setPromptByAgent((current) => {
          const next = { ...current };
          if (text) next[request.agentId] = text;
          else delete next[request.agentId];
          return next;
        });
        if (request.agentId === activeAgentIdRef.current) {
          setComposerCursor(text.length);
          pendingComposerCaretRef.current = text.length;
        }
        return;
      }

      if (request.method === "setWidget") {
        const widgetRequest = request as UiRequest;
        const widgetKey = widgetRequest.widgetKey || widgetRequest.requestId;
        const widgetLines = Array.isArray(widgetRequest.widgetLines)
          ? widgetRequest.widgetLines.filter((line) => typeof line === "string")
          : [];
        setExtensionWidgetsByAgent((current) => {
          const agentWidgets = { ...(current[request.agentId] ?? {}) };
          if (widgetLines.length > 0) agentWidgets[widgetKey] = widgetLines;
          else delete agentWidgets[widgetKey];
          return { ...current, [request.agentId]: agentWidgets };
        });
        // agent 推送了新的 widget 内容，清除该 widget 的关闭标记使其重新显示
        if (widgetLines.length > 0) {
          setAgentDismissedWidgets((prev) => {
            const current = prev[request.agentId];
            if (!current?.includes(widgetKey)) return prev;
            return {
              ...prev,
              [request.agentId]: current.filter((k) => k !== widgetKey),
            };
          });
        }
        return;
      }

      setActiveUiRequest((current) => {
        // 如果 requestId 已存在且带了 completed 标记，清除该请求
        if (current?.[request.requestId] && request.completed) {
          const next = { ...current };
          delete next[request.requestId];
          if (Object.keys(next).length === 0) return null;
          return next;
        }
        /* 用户通过 select 弹框自定义输入框提交自定义值后，Pi 会收到 "✎ 自行输入..."
           选项值并发送 input 弹框让用户输入。此处检测到 pending 值后自动提交 input
           弹框，对用户表现为一次提交即完成，无需二次输入。 */
        if (request.method === "input" && pendingCustomInputRef.current) {
          const value = pendingCustomInputRef.current;
          pendingCustomInputRef.current = "";
          api.agents.sendUiResponse(activeAgentIdRef.current ?? "", request.requestId, { value });
          return current; // 不显示 input 弹框
        }
        // 新增或更新 UI 请求
        return { ...(current ?? {}), [request.requestId]: request as UiRequest };
      });
    });
    // 监听项目信任确认请求：主进程在启动 pi 前对含 .pi 资源的项目发起，弹窗等待用户决策
    const offTrustRequest = api.agents.onTrustRequest((request) => {
      setTrustRequest(request);
    });
    return () => {
      offProjects();
      offState();
      offMessages();
      offLog();
      offSettings();
      offUpdateProgress();
      offRuntimeState();
      offThinking();
      offUiRequest();
      offTrustRequest();
    };
  }, []);

  // 全局快捷键：Cmd/Ctrl+Shift+S 呼出/收起草稿本；Esc 关闭
  const scratchPadToggle = scratchPad.toggle;
  const scratchPadClose = scratchPad.close;
  const scratchPadIsOpen = scratchPad.isOpen;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isSaveShortcut = (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "s";
      if (isSaveShortcut) {
        e.preventDefault();
        scratchPadToggle();
        return;
      }
      if (e.key === "Escape" && scratchPadIsOpen) {
        e.stopPropagation();
        scratchPadClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [scratchPadToggle, scratchPadClose, scratchPadIsOpen]);

  // 桌面宠物点击跳转：主进程通知激活某 Agent，切到对应 project + agent tab
  useEffect(() => {
    const off = api.agents.onFocusTarget((target) => {
      const agent = displayAgentsRef.current.find((a) => a.id === target.agentId);
      if (!agent) return;
      setActiveProjectId(agent.projectId);
      setActiveAgentId(agent.id);
    });
    return off;
  }, []);

  useEffect(() => {
    const projectIds = new Set(projects.map((project) => project.id));
    setSessionsByProject((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([projectId]) =>
          projectIds.has(projectId),
        ),
      ),
    );
    setVisibleProjectChildCountByProject((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([projectId]) =>
          projectIds.has(projectId),
        ),
      ),
    );
    setSessionLoadingByProject((current) =>
      Object.fromEntries(
        Object.entries(current).filter(([projectId]) =>
          projectIds.has(projectId),
        ),
      ),
    );
    // 启动时只加载 chat 项目的会话,其他项目延迟到展开时加载
    for (const project of projects) {
      if (project.kind === "chat") {
        void refreshProjectSessions(project.id).catch(() => undefined);
      }
    }
  }, [projectIdsKey]);

  useEffect(() => {
    const timer = window.setInterval(
      () => void checkAppUpdate("auto"),
      1000 * 60 * 60 * 6,
    );
    window.setTimeout(() => void checkAppUpdate("auto"), 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (activeAgentId && !isPendingAgentId(activeAgentId))
      void refreshRuntimeState(activeAgentId);
  }, [activeAgentId]);

  useEffect(() => {
    const activeIds = new Set(displayAgents.map((agent) => agent.id));
    setTerminalDockStateByAgent((current) =>
      pruneTerminalDockState(current, activeIds),
    );
  }, [displayAgents]);

  function getComposerMaxHeight() {
    const chatPane = chatPaneRef.current;
    const header = chatHeaderRef.current;
    const composer = composerRef.current;
    const box = composerBoxRef.current;
    if (!chatPane || !header || !composer || !box) {
      const reservedTerminalHeight = terminalOpen ? activeTerminalHeight : 0;
      return Math.max(
        180,
        window.innerHeight -
          78 -
          COMPOSER_MIN_TIMELINE_HEIGHT -
          52 -
          reservedTerminalHeight,
      );
    }

    const reservedTerminalHeight = terminalOpen ? activeTerminalHeight : 0;
    const composerChrome = Math.max(
      0,
      composer.offsetHeight - box.offsetHeight,
    );
    // 输入框最大高度取决于聊天区域还剩多少可用空间,而不是固定视口比例;
    // 否则窗口变窄后软换行变多,最小窗口下会比内容需要的高度更早触顶。
    return Math.max(
      180,
      chatPane.clientHeight -
        header.offsetHeight -
        COMPOSER_MIN_TIMELINE_HEIGHT -
        reservedTerminalHeight -
        composerChrome,
    );
  }

  function clampComposerHeight(height: number) {
    const maxHeight = getComposerMaxHeight();
    return Math.min(maxHeight, Math.max(COMPOSER_MIN_HEIGHT, height));
  }

  function ensureComposerTailVisible() {
    const editor = composerTextareaRef.current;
    if (!editor || document.activeElement !== editor) return;
    // RichInput 用纯文本偏移表示光标;光标在末尾时同步滚动到底,行为与原 textarea 一致。
    const len = editor.textContent?.length ?? 0;
    const atEnd = getCaretOffsetOf(editor) >= len;
    if (!atEnd) return;
    requestAnimationFrame(() => {
      const current = composerTextareaRef.current;
      if (!current) return;
      current.scrollTop = current.scrollHeight;
    });
  }

  function syncComposerAutoHeight() {
    const box = composerBoxRef.current;
    const editor = composerTextareaRef.current;
    if (!box || !editor) return;

    // 宽度变化会改变软换行位置,编辑区的 scrollHeight 才是当前内容真实需要的高度。
    // 这里减去 chrome 高度(顶部留白/工具条/底部状态条),把问题修在布局源头而不是靠用户手动拖。
    const chromeHeight = box.offsetHeight - editor.clientHeight;
    const nextHeight = clampComposerHeight(
      editor.scrollHeight + chromeHeight,
    );
    setComposerAutoHeight((current) =>
      Math.abs(current - nextHeight) <= 1 ? current : nextHeight,
    );
    ensureComposerTailVisible();
  }

  function scrollToBottom() {
    const timeline = timelineRef.current;
    if (!timeline) return;
    timeline.scrollTo({ top: timeline.scrollHeight, behavior: "smooth" });
    setAutoScroll(true);
    autoScrollRef.current = true;
    setShowScrollToBottom(false);
  }

  // 给定位命中的消息元素加一个短暂的高亮动画，方便用户在长会话中快速识别跳转落点。
  function highlightMessageElement(el: HTMLElement) {
    el.classList.remove("message-jump-highlight");
    // 强制 reflow 以便重复跳转同一条消息时仍能重新触发动画。
    void el.offsetWidth;
    el.classList.add("message-jump-highlight");
    window.setTimeout(() => el.classList.remove("message-jump-highlight"), 2000);
  }

  // 点击“加载更多历史消息”：先记录当前滚动锚点，再触发分页加载，
  // 渲染后的 effect 会根据新增高度补偿 scrollTop，保持视图稳定。
  function handleLoadMoreMessages() {
    const timeline = timelineRef.current;
    if (timeline) {
      loadMoreAnchorRef.current = {
        height: timeline.scrollHeight,
        top: timeline.scrollTop,
      };
    }
    loadMoreMessages();
  }

  // 会话定位跳转：若目标消息已在当前分页内则直接滚动定位；
  // 否则先扩展分页窗口把它包含进来，交给 pendingJumpId effect 在渲染后定位。
  function handleOutlineJump(id: string) {
    const el = document.querySelector(
      `[data-message-id="${CSS.escape(id)}"]`,
    ) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      highlightMessageElement(el);
      return;
    }
    const index = activeMessages.findIndex((m) => m.id === id);
    if (index < 0) return;
    loadMessagesUntilIncluded(index);
    setPendingJumpId(id);
  }

  useEffect(() => {
    let frame = 0;
    const scheduleSync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setComposerHeight((current) => clampComposerHeight(current));
        setComposerOffsetHeight(composerRef.current?.offsetHeight ?? 0);
      });
    };

    const box = composerBoxRef.current;
    const footer = composerRef.current;
    const observer =
      (box || footer) &&
      new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        scheduleSync();
      });
    if (box) observer?.observe(box);
    if (footer) observer?.observe(footer);

    window.addEventListener("resize", scheduleSync);
    scheduleSync();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleSync);
      observer?.disconnect();
    };
  }, [activeAgentId]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setComposerHeight((current) => clampComposerHeight(current));
      setComposerOffsetHeight(composerRef.current?.offsetHeight ?? 0);
    });
    return () => cancelAnimationFrame(frame);
  }, [
    prompt,
    activeAgentId,
    listCollapsed,
    drawerCollapsed,
    drawer,
    terminalOpen,
    activeTerminalHeight,
  ]);

  useEffect(() => {
    if (activeProjectId && activeAgentId)
      setActiveAgentByProject((current) => ({
        ...current,
        [activeProjectId]: activeAgentId,
      }));
  }, [activeProjectId, activeAgentId]);

  useEffect(() => {
    if (activeAgentId && !isPendingAgentId(activeAgentId))
      void api.agents
        .commands(activeAgentId)
        // goal 模式这版先不公开入口；保留底层实现,等待官方 plan/goal 能力稳定后再决定是否恢复。
        .then((cmds) => setCommands(cmds))
        .catch(() => setCommands([]));
    else setCommands([]);
  }, [activeAgentId]);

  useEffect(() => {
    setSelectedSuggestionIndex(0);
  }, [suggestionItems.length]);

  // 持久化历史命令
  useEffect(() => {
    if (commandHistory.length > 0) {
      try {
        localStorage.setItem("pideck-command-history", JSON.stringify(commandHistory));
      } catch (error) {
        // 容量超限时静默失败
      }
    }
  }, [commandHistory]);

  // 持久化会话来源过滤配置
  useEffect(() => {
    try {
      saveSessionSourceFilter(sessionSourceFilter);
    } catch (error) {
      // 静默失败
    }
  }, [sessionSourceFilter]);

  // 持久化历史命令
  useEffect(() => {
    if (commandHistory.length > 0) {
      try {
        localStorage.setItem("pideck-command-history", JSON.stringify(commandHistory));
      } catch (error) {
        console.error("Failed to save command history:", error);
      }
    }
  }, [commandHistory]);

  // 监听用户滚动,判断是否需要显示"移动到最新"按钮
  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = timeline;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 100;

      if (isAtBottom) {
        setAutoScroll(true);
        autoScrollRef.current = true;
        setShowScrollToBottom(false);
      } else {
        setAutoScroll(false);
        // 同步更新 ref，确保 ResizeObserver 回调在 React 状态更新生效前读到最新值，
        // 避免用户已滚到上方但 DOM 增长触发的 observer 因闭包旧值抢滚动到底部。
        autoScrollRef.current = false;
        setShowScrollToBottom(true);
      }
    };

    // 初始化时检查一次
    handleScroll();

    timeline.addEventListener("scroll", handleScroll);
    return () => timeline.removeEventListener("scroll", handleScroll);
  }, [activeAgentId]);

  // 用 ResizeObserver 监控消息列表内容的 DOM 高度变化，自动滚动到底部。
  // 流式回答时最后一条 assistant 消息原地增长但 messages.length 不变，
  // 依赖 length 的 effect 不会及时触发；通过 ResizeObserver 准确感知容器扩张。
  // autoScroll 在依赖中确保开关变化时重建 observer（同时触发一次初始滚动）。
  // activeAgent?.status 让 agent 从 starting→idle/errored 时重建 observer
  // 并触发一次滚动，解决状态切换后才出现 .message-list 时不会自动滚到底部的问题。
  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    const messageList = timeline.querySelector(".message-list");
    if (!messageList) return;

    // 使用 ref 而非闭包值，防止 DOM 变化与 React 状态更新之间的时序间隙造成滚动抢跑：
    // 用户已滚到上方（autoScroll=false），但状态更新尚未生效，observer 闭包中的 autoScroll 仍为 true。
    const scrollIfNeeded = () => {
      if (!autoScrollRef.current) return;
      timeline.scrollTo({ top: timeline.scrollHeight, behavior: "instant" });
    };
    // 重建 observer 时先主动滚一次，处理 autoScroll 从 false→true 但列表高度未变的场景。
    scrollIfNeeded();

    const resizeObserver = new ResizeObserver(scrollIfNeeded);
    resizeObserver.observe(messageList);

    return () => resizeObserver.disconnect();
  }, [activeAgentId, autoScroll, activeAgent?.status]);

  // 加载更多历史消息后，按顶部锁定的方式恢复滚动位置。
  // 历史消息会插入到 .message-list 顶部，若不补偿新增高度，浏览器保持原 scrollTop 会导致视图跳动，
  // 用户会感觉输入框/内容错位。这里把新增高度增量加回 scrollTop，让当前看到的消息留在原位。
  // 使用 useLayoutEffect 在浏览器绘制前同步补偿，避免用户看到中间跳动的一帧。
  useLayoutEffect(() => {
    const anchor = loadMoreAnchorRef.current;
    if (!anchor) return;
    const el = timelineRef.current;
    if (!el) return;
    const delta = el.scrollHeight - anchor.height;
    if (delta !== 0) el.scrollTop = anchor.top + delta;
    loadMoreAnchorRef.current = null;
  }, [paginatedMessages.length]);

  // 会话定位跳转到尚未加载的消息时，先通过 loadMessagesUntilIncluded 扩展分页窗口；
  // 该消息被渲染进 DOM 后，在此 effect 中真正滚动定位并短暂高亮，提示用户落点。
  useEffect(() => {
    if (!pendingJumpId) return;
    const el = document.querySelector(
      `[data-message-id="${CSS.escape(pendingJumpId)}"]`,
    ) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    highlightMessageElement(el);
    setPendingJumpId(null);
  }, [pendingJumpId, paginatedMessages.length]);

  // 追踪 agent 会话开始/结束时间,计算会话时长
  // 点击外部区域自动关闭会话组合下拉
  useEffect(() => {
    if (!sessionActionsOpen) return;
    const handler = (event: MouseEvent) => {
      if (sessionComboRef.current && !sessionComboRef.current.contains(event.target as Node)) {
        setSessionActionsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [sessionActionsOpen]);


  useEffect(() => {
    for (const agent of displayAgents) {
      if (agent.id !== activeAgentId) continue;
      const previousStatus = agentStatusByAgentRef.current[agent.id];
      if (agent.status === "running") {
        if (previousStatus !== "running") {
          sessionStartByAgentRef.current[agent.id] = Date.now();
        }
      } else if (agent.status === "idle") {
        const start = sessionStartByAgentRef.current[agent.id];
        if (start) {
          setSessionDurationByAgent((d) => ({
            ...d,
            [agent.id]: Date.now() - start,
          }));
        }
      }
      agentStatusByAgentRef.current[agent.id] = agent.status;
    }
  }, [displayAgents, activeAgentId, modifiedFiles, messagesByAgent]);

  // 检测 goal_complete tool call → 标记 goal 完成
  useEffect(() => {
    if (goalStatusRef.current !== "active") return;
    const goalAgentMessages = activeAgentId ? messagesByAgent[activeAgentId] : undefined;
    if (!goalAgentMessages) return;
    for (let i = goalAgentMessages.length - 1; i >= 0; i--) {
      const message = goalAgentMessages[i];
      if (message.role === "tool" && message.meta?.toolName === "goal_complete") {
        goalStatusRef.current = "complete";
        goalContinuationPendingRef.current = false;
        setGoalStatus("complete");
        setGoalCompletedAt(Date.now());
        break;
      }
    }
  }, [messagesByAgent, activeAgentId]);

  // 监听用户发送消息的编辑事件,将消息填入输入框
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ text: string }>).detail;
      if (detail?.text) {
        setPrompt(detail.text);
        // 光标移至文本末尾，利用 RichInput 的 caretRef 机制在渲染后恢复
        pendingComposerCaretRef.current = detail.text.length;
        requestAnimationFrame(() => {
          composerTextareaRef.current?.focus();
        });
      }
    };
    window.addEventListener("user-message-edit", handler);
    return () => window.removeEventListener("user-message-edit", handler);
  }, []);

  useEffect(() => {
    if (!activeProjectId) {
      setFiles([]);
      setSessions([]);
      setGitInfo({ current: null, branches: [] });
      return;
    }

    // 切换项目时,如果该项目未加载过会话,则加载
    const activeProject = projects.find((p) => p.id === activeProjectId);
    const hasLoadedSessions = sessionsByProject[activeProjectId]?.length > 0;
    const isLoadingNow = sessionLoadingByProject[activeProjectId];

    if (activeProject && !activeProject.kind && !hasLoadedSessions && !isLoadingNow) {
      void refreshProjectSessions(activeProjectId).catch(() => undefined);
    }

    const currentAgentBelongsToProject =
      activeAgentId &&
      displayAgents.some(
        (agent) =>
          agent.id === activeAgentId && agent.projectId === activeProjectId,
      );
    if (!currentAgentBelongsToProject) {
      const rememberedAgent = activeAgentByProject[activeProjectId];
      const fallbackAgent = displayAgents.find(
        (agent) => agent.projectId === activeProjectId,
      )?.id;
      setActiveAgentId(
        rememberedAgent &&
          displayAgents.some((agent) => agent.id === rememberedAgent)
          ? rememberedAgent
          : fallbackAgent,
      );
    }

    setExpandedDirs(new Set());
    void api.files
      .list(activeProjectId)
      .then(setFiles)
      .catch((error) => setLogs((current) => [...current, String(error)]));
    void api.git
      .branches(activeProjectId)
      .then(setGitInfo)
      .catch(() => setGitInfo({ current: null, branches: [] }));
  }, [activeProjectId, displayAgents.length]);

  useEffect(() => {
    if (!activeProjectId) return;
    let stopped = false;
    const refreshGitInfo = async () => {
      try {
        // 轮询分支信息
        const next = await api.git.branches(activeProjectId);
        if (stopped) return;
        // 分支可能在外部终端/IDE 中切换,轮询只在状态真的变化时更新,避免不必要重渲染。
        setGitInfo((current) =>
          current.current === next.current &&
          current.branches.join("\n") === next.branches.join("\n")
            ? current
            : next,
        );
        // 同时刷新 Git 工作区变更文件列表（对比 HEAD）
        const changed = await api.git.changedFiles(activeProjectId);
        if (!stopped) setGitChangedFiles(changed);
      } catch {
        if (!stopped) {
          setGitInfo({ current: null, branches: [] });
          setGitChangedFiles([]);
        }
      }
    };
    const timer = window.setInterval(refreshGitInfo, 4000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [activeProjectId]);

  async function checkPiInstall(source: "startup" | "manual" = "manual") {
    setSettingsOpen(false);
    setPiChecking(true);
    setEnvironmentDialog(true);
    try {
      const next = await api.pi.check();
      setPiStatus(next);
      if (next.installed && source === "startup") {
        // 首次启动检测通过后落盘,后续启动不再阻塞/打扰;用户仍可在设置里手动重新检测。
        const saved = await api.settings.update({ piEnvironmentChecked: true });
        setSettings(saved);
        window.setTimeout(() => setEnvironmentDialog(false), 3000);
      }
      if (next.installed && source === "manual")
        window.setTimeout(() => setEnvironmentDialog(false), 3000);
    } finally {
      setPiChecking(false);
    }
  }

  async function checkPiInstallInline() {
    setPiChecking(true);
    setCustomPathResult(null);
    try {
      const next = await api.pi.check();
      setPiStatus(next);
      if (next.installed) {
        const saved = await api.settings.update({ piEnvironmentChecked: true });
        setSettings(saved);
        showToast(
          t("app.piCheckPassed", {
            value: next.command ?? next.version ?? "pi",
          }),
        );
      } else {
        /* 检测失败时弹出环境检测弹框，方便用户查看安装指引 */
        setSettingsOpen(false);
        setEnvironmentDialog(true);
        setPiStatus(next);
      }
    } finally {
      setPiChecking(false);
    }
  }

  /**
   * 校验用户手动输入的 pi 路径。
   * 主进程执行 command --version 验证后,通过则自动保存到 settings.customPiPath,
   * 之后新建/重启 agent 时 PiProcess 会优先使用自定义路径。
   */
  async function validateCustomPiPath(
    options: { closeDialogOnSuccess?: boolean } = {},
  ) {
    const path = customPiPath.trim();
    if (!path) return;
    setCustomPathValidating(true);
    setCustomPathResult(null);
    try {
      const result = await api.pi.checkCustom(path);
      setCustomPathResult(result);
      if (result.installed) {
        // 主进程会保存 PiLocator 归一化后的路径;这里重新读取,确保 UI 展示的是实际使用路径。
        const updated = await api.settings.get();
        setSettings(updated);
        setCustomPiPath(updated.customPiPath ?? result.command ?? path);
        setPiStatus(result);
        showToast(
          t("app.piPathSaved", {
            path: result.command ?? updated.customPiPath ?? path,
          }),
        );
        if (options.closeDialogOnSuccess) {
          // 启动检测弹窗场景下保持原有成功后自动关闭体验;设置页内校验不关闭设置窗口。
          window.setTimeout(() => setEnvironmentDialog(false), 3000);
        }
      } else {
        showToast(
          t("app.piPathValidateFailed", {
            error: result.error ?? t("environment.unableToRun"),
          }),
        );
      }
    } finally {
      setCustomPathValidating(false);
    }
  }

  async function clearCustomPiPath() {
    const updated = await api.settings.update({ customPiPath: "" });
    setSettings(updated);
    setCustomPiPath("");
    setCustomPathResult(null);
    showToast(t("app.piPathCleared"));
    const status = await api.pi.check();
    setPiStatus(status);
  }

  /**
   * 检查 npm 是否可用。
   * 通过主进程执行 npm --version 检测系统中是否安装了 npm。
   */
  async function checkNpm() {
    setNpmChecking(true);
    try {
      const result = await api.pi.checkNpm();
      setNpmAvailable(result.available);
      setNpmVersion(result.version);
    } finally {
      setNpmChecking(false);
    }
  }

  /**
   * 执行安装命令的 handler。
   * 调用主进程执行命令，根据退出码判断成功/失败。
   */
  async function execInstallCommand() {
    const cmd = installCommand.trim();
    if (!cmd) return;
    setInstallExecuting(true);
    setInstallResult(null);
    setInstallCompleted(false);
    try {
      const result = await api.pi.execInstall(cmd);
      setInstallResult(result);
      // 退出码 0 表示成功（npm install 成功时 exitCode 为 0）
      if (result.success && result.exitCode === 0) {
        setInstallCompleted(true);
      }
    } finally {
      setInstallExecuting(false);
    }
  }

  /** 统一通知：所有非模态消息都走 app-notice 位置 */
  function showToast(message: string, duration = 3500) {
    showNotice(message, duration);
  }

  async function downloadAppUpdate() {
    const asset = updateInfo?.recommendedAsset;
    if (!asset) {
      await api.app.openExternal(updateInfo?.releaseUrl ?? appInfo.releasesUrl);
      return;
    }
    setUpdateDownloading(true);
    setDownloadedUpdatePath(null);
    setUpdateProgress({
      assetName: asset.name,
      receivedBytes: 0,
      totalBytes: asset.size,
      percent: 0,
      state: "downloading",
    });
    try {
      const result = await api.app.downloadUpdate(asset);
      setDownloadedUpdatePath(result.filePath);
      showToast(t("update.downloadCompleted"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setUpdateError(message);
      showToast(t("update.downloadFailed"));
    } finally {
      setUpdateDownloading(false);
    }
  }

  async function installDownloadedAppUpdate() {
    if (!downloadedUpdatePath) return;
    await api.app.installUpdate(downloadedUpdatePath);
  }

  async function checkPiCliUpdateOnStartup() {
    try {
      const result = await api.pi.checkUpdate();
      setPiUpdateCheck(result);
      if (result.hasUpdate) {
        // 启动后后台提醒即可，不阻塞主界面；低版本 pi 可能缺少新版协议/工具能力。
        const message = t("settings.piUpdateStartupNotice");
        showToast(message, 6500);
      }
    } catch {
      // 后台检查失败不打扰用户；设置页仍可手动检查并看到详细错误。
    }
  }

  async function checkPiCliUpdate() {
    setPiUpdateChecking(true);
    try {
      const result = await api.pi.checkUpdate();
      setPiUpdateCheck(result);
      showToast(result.error ? t("settings.piUpdateFailed", { error: result.error }) : result.hasUpdate ? t("settings.piUpdateAvailable") : t("settings.piUpdateChecked"));
    } finally {
      setPiUpdateChecking(false);
    }
  }

  async function updatePiCli() {
    setPiUpdating(true);
    setPiUpdateResult(null);
    try {
      const result = await api.pi.update();
      setPiUpdateResult(result);
      await checkPiInstallInline();
      setPiUpdateCheck(await api.pi.checkUpdate());
      showToast(result.updated ? t("settings.piUpdateDone") : t("settings.piUpdateChecked"));
    } catch (error) {
      showToast(t("settings.piUpdateFailed", { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setPiUpdating(false);
    }
  }


  async function checkAppUpdate(source: "auto" | "manual" = "manual") {
    if (updateChecking) return;
    setUpdateChecking(true);
    try {
      const next = await api.app.checkUpdate();
      if (next.hasUpdate) {
        setUpdateInfo(next);
      } else if (source === "manual") {
        // 手动检查且无更新时,显示模态框提示
        setUpToDateVersion(next.currentVersion);
        showToast(
          t("app.latestVersionNotice", { version: next.currentVersion }),
        );
      }
    } catch (error) {
      if (source === "manual") {
        const message = error instanceof Error ? error.message : String(error);
        showToast(t("app.updateFailedNotice", { error: message }));
        setUpdateError(message);
        showToast(t("app.updateFailed"));
      }
    } finally {
      setUpdateChecking(false);
    }
  }

  async function refreshProjects() {
    const next = await api.projects.list();
    setProjects(next);
    if (!activeProjectId && next.length > 0) setActiveProjectId(next[0].id);
    // 启动时刷新所有 worktree 项目的分支列表
    for (const p of next) {
      if (p.worktreeEnabled) {
        void refreshWorktrees(p.id);
      }
    }
  }

  async function refreshWorktrees(projectId: string) {
    try {
      const [entries, branchInfo] = await Promise.all([
        api.git.worktreeList(projectId),
        api.git.branches(projectId).catch(() => ({ current: null, branches: [] })),
      ]);
      setWorktreesByProject((prev) => ({ ...prev, [projectId]: entries }));
      setBranchByProject((prev) => ({ ...prev, [projectId]: branchInfo.current }));
      // 刷新项目列表（可能已有新注册的 worktree 子项目）
      const next = await api.projects.list();
      setProjects(next);
    } catch {
      setWorktreesByProject((prev) => ({ ...prev, [projectId]: [] }));
    }
  }

  async function refreshSessions(projectId = activeProjectId) {
    const next = await api.sessions.list(projectId);
    setSessions([...next].sort((a, b) => b.updatedAt - a.updatedAt));
  }

  async function refreshProjectSessions(projectId: string) {
    setSessionLoadingByProject((current) => ({
      ...current,
      [projectId]: true,
    }));
    try {
      const next = await api.sessions.list(projectId);
      const sorted = [...next].sort((a, b) => b.updatedAt - a.updatedAt);
      setSessionsByProject((current) => ({
        ...current,
        [projectId]: sorted,
      }));
      setVisibleProjectChildCountByProject((current) => ({
        ...current,
        [projectId]: current[projectId] ?? SIDEBAR_PROJECT_CHILD_PAGE_SIZE,
      }));
      return sorted;
    } finally {
      setSessionLoadingByProject((current) => ({
        ...current,
        [projectId]: false,
      }));
    }
  }

  /** 刷新项目侧栏数据：根项目会话 + worktree 列表 + worktree 子项目会话。 */
  async function refreshProjectTree(project: Project) {
    await refreshProjectSessions(project.id);
    if (project.worktreeEnabled) {
      await refreshWorktrees(project.id);
      const latestProjects = await api.projects.list();
      setProjects(latestProjects);
      const childProjects = latestProjects.filter((p) => p.worktreeParentId === project.id);
      await Promise.all(
        childProjects.map((child) => refreshProjectSessions(child.id).catch(() => undefined)),
      );
    }
    showToast(t("app.projectRefreshed"), 1800);
  }

  async function refreshFiles(projectId = activeProjectId, silent = false) {
    if (!projectId) return;
    const next = await api.files.list(projectId);
    setFiles(next);
    if (!silent) showToast(t("app.filesRefreshed"), 1800);
  }

  async function refreshGitChangedFiles(projectId = activeProjectId) {
    if (!projectId) return;
    try {
      const next = await api.git.changedFiles(projectId);
      setGitChangedFiles(next);
    } catch {
      // 非 Git 项目或 git 未安装，静默置空
      setGitChangedFiles([]);
    }
  }

  function openFilePath(path: string) {
    // 绝对路径直接打开;相对路径按当前 agent cwd / 项目目录解析后交给系统默认应用。
    const resolvedPath = resolveFileLinkPath(path, activeAgent?.cwd ?? activeProject?.path);
    void api.files.open(resolvedPath).catch((error) => {
      showToast(t("app.openFileFailed", {
        error: error instanceof Error ? error.message : String(error),
      }));
    });
  }

  function viewFilePath(path: string) {
    openEditorTab(path, "view");
    if (editorMode === "drawer") {
      setDrawer("editor");
      setDrawerCollapsed(false);
    }
  }

  function diffFilePath(path: string, originalContent?: string, content?: string) {
    // 工具 diff 展示：write = 空白→全量内容，edit = oldText→newText（变动区域）
    // originalContent 不再存储 full file，使用工具参数中的变动文本作为对比基准。
    const modified = modifiedFiles.find((f) => f.path === path);
    const resolvedOriginal = originalContent ?? modified?.originalContent ?? "";
    const resolvedModified = content ?? modified?.content ?? undefined;
    // 工具 diff 以弹框打开（其后可最小化到侧栏）
    setEditorMode("modal");
    setDrawer(null);
    openEditorTab(path, "diff", resolvedOriginal, resolvedModified);
  }

  async function refreshSessionHistory(projectId = sessionsProjectId) {
    if (!projectId) return;
    setSessionHistoryLoading(true);
    try {
      // 项目历史弹框内的刷新需要显式进入 loading 状态;否则刷新很快完成时用户会误以为按钮没有响应。
      await refreshSessions(projectId);
    } finally {
      setSessionHistoryLoading(false);
    }
  }

  async function openProjectSessions(project: Project) {
    setProjectMenu(null);
    setActiveProjectId(project.id);
    setSessionsProjectId(project.id);
    setSessions([]);
    setDrawer("sessions");
    setDrawerCollapsed(false);
    await refreshSessionHistory(project.id);
  }

  async function copySession(
    filePath: string,
    projectId = sessionsProjectId ?? activeProjectId,
  ) {
    if (!projectId) return;
    const result = await api.sessions.copy(projectId, filePath);
    if (result.cancelled) {
      showToast(t("app.sessionCopyCancelled"));
      return;
    }
    showToast(t("app.sessionCopied"));
    await refreshSessions(projectId);
    await refreshProjectSessions(projectId);
  }

  async function exportHistorySession(session: SessionSummary) {
    const projectId = sessionsProjectId ?? activeProjectId;
    if (!projectId) return;
    const result = await api.sessions.exportHtml(projectId, session.filePath);
    showToast(t("app.exportedPath", { path: result.path }), 3500);
  }

  async function deleteHistorySession(session: SessionSummary) {
    await api.sessions.delete(session.filePath);
    showToast(t("app.sessionDeleted"), 2200);
    const projectId = sessionsProjectId ?? activeProjectId;
    await refreshSessions(projectId);
    if (projectId) await refreshProjectSessions(projectId);
  }

  async function cloneAgentSession(agentId: string) {
    setAgentActionLoading("copy");
    try {
      const result = await api.agents.cloneSession(agentId);
      if (result?.cancelled) {
        showToast(t("app.sessionCopyCancelled"));
        return;
      }
      showToast(t("app.currentSessionCopied"));
      await refreshRuntimeState(agentId);
      await refreshSessions(activeProjectId);
      if (activeProjectId) await refreshProjectSessions(activeProjectId);
    } finally {
      setAgentActionLoading(null);
      setAgentMenu(null);
    }
  }

  function openAgentRename(agent: AgentTab) {
    setAgentMenu(null);
    setAgentRenameTarget(agent);
    setSessionRenameTarget(null);
    setAgentRenameValue(agent.title);
  }

  function openSessionRename(projectId: string, session: SessionSummary) {
    setSessionMenu(null);
    setAgentRenameTarget(null);
    setSessionRenameTarget({ projectId, session });
    setAgentRenameValue(session.name || t("common.untitled"));
  }

  async function submitAgentRename() {
    if (!agentRenameTarget) return;
    const name = agentRenameValue.replace(/\s+/g, " ").trim();
    if (!name) {
      showToast(t("app.sessionNameRequired"), 2200);
      return;
    }
    setAgentRenaming(true);
    try {
      const tab = await api.agents.rename(agentRenameTarget.id, name);
      setAgents((current) =>
        current.map((agent) => (agent.id === tab.id ? tab : agent)),
      );
      setAgentRenameTarget(null);
      setSessionRenameTarget(null);
      setAgentRenameValue("");
      showToast(t("app.sessionRenamed"), 2200);
      await refreshProjectSessions(tab.projectId);
      if (sessionsProjectId === tab.projectId)
        await refreshSessions(tab.projectId);
    } catch (error) {
      showToast(
        t("app.sessionRenameFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        4000,
      );
    } finally {
      setAgentRenaming(false);
    }
  }

  async function submitSessionRename() {
    if (!sessionRenameTarget) return;
    const name = agentRenameValue.replace(/\s+/g, " ").trim();
    if (!name) {
      showToast(t("app.sessionNameRequired"), 2200);
      return;
    }
    setAgentRenaming(true);
    try {
      await api.sessions.rename(sessionRenameTarget.session.filePath, name);
      await refreshProjectSessions(sessionRenameTarget.projectId);
      if (sessionsProjectId === sessionRenameTarget.projectId) {
        await refreshSessions(sessionRenameTarget.projectId);
      }
      setSessionRenameTarget(null);
      setAgentRenameValue("");
      showToast(t("app.sessionRenamed"), 2200);
    } catch (error) {
      showToast(
        t("app.sessionRenameFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        4000,
      );
    } finally {
      setAgentRenaming(false);
    }
  }

  async function openSidebarSession(
    projectId: string,
    session: SessionSummary,
  ) {
    setSessionMenu(null);
    return createAgent(
      projectId,
      session.filePath,
      session.name || t("common.untitled"),
    );
  }

  async function copySidebarSession(
    projectId: string,
    session: SessionSummary,
  ) {
    setSessionActionLoading("copy");
    try {
      await copySession(session.filePath, projectId);
    } finally {
      setSessionActionLoading(null);
      setSessionMenu(null);
    }
  }

  async function exportSidebarSession(
    projectId: string,
    session: SessionSummary,
  ) {
    setSessionActionLoading("export");
    try {
      const result = await api.sessions.exportHtml(projectId, session.filePath);
      showToast(t("app.exportedPath", { path: result.path }), 3500);
    } finally {
      setSessionActionLoading(null);
      setSessionMenu(null);
    }
  }

  async function openCodexImport(project: Project) {
    setProjectMenu(null);
    setCodexImportProject(project);
    setCodexImportReport(null);
    setCodexImportSessions([]);
    setCodexImportSelected([]);
    await scanCodexSessions(project);
  }

  async function scanCodexSessions(
    project = codexImportProject,
    clearReport = true,
  ) {
    if (!project) return;
    setCodexImportLoading(true);
    if (clearReport) setCodexImportReport(null);
    try {
      const next = await api.codexSessions.scan(project.id);
      setCodexImportSessions(next);
      setCodexImportSelected(getSelectableCodexImportPaths(next));
    } catch (error) {
      showToast(
        t("codex.scanFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        4000,
      );
    } finally {
      setCodexImportLoading(false);
    }
  }

  function toggleCodexSession(sourcePath: string) {
    setCodexImportSelected((current) =>
      current.includes(sourcePath)
        ? current.filter((item) => item !== sourcePath)
        : [...current, sourcePath],
    );
  }

  function toggleAllCodexSessions() {
    const allPaths = getSelectableCodexImportPaths(codexImportSessions);
    setCodexImportSelected((current) =>
      allPaths.length > 0 && allPaths.every((path) => current.includes(path))
        ? []
        : allPaths,
    );
  }

  async function importCodexSessions() {
    if (!codexImportProject || codexImportSelected.length === 0) return;
    setCodexImportRunning(true);
    setCodexImportReport(null);
    try {
      const report = await api.codexSessions.import(
        codexImportProject.id,
        codexImportSelected,
      );
      setCodexImportReport(report);
      await scanCodexSessions(codexImportProject, false);
      await refreshProjectSessions(codexImportProject.id);
      if (sessionsProjectId === codexImportProject.id)
        await refreshSessions(codexImportProject.id);
      showToast(
        t("codex.importDone", {
          imported: report.imported,
          failed: report.failed,
        }),
      );
    } catch (error) {
      showToast(
        t("codex.importFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        4000,
      );
    } finally {
      setCodexImportRunning(false);
    }
  }

  async function openClaudeImport(project: Project) {
    setProjectMenu(null);
    setClaudeImportProject(project);
    setClaudeImportReport(null);
    setClaudeImportSessions([]);
    setClaudeImportSelected([]);
    await scanClaudeSessions(project);
  }

  async function scanClaudeSessions(
    project = claudeImportProject,
    clearReport = true,
  ) {
    if (!project) return;
    setClaudeImportLoading(true);
    if (clearReport) setClaudeImportReport(null);
    try {
      const next = await api.claudeSessions.scan(project.id);
      setClaudeImportSessions(next);
      setClaudeImportSelected([]);
    } catch (error) {
      showToast(
        t("claude.scanFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        4000,
      );
    } finally {
      setClaudeImportLoading(false);
    }
  }

  function toggleClaudeSession(sourcePath: string) {
    setClaudeImportSelected((current) =>
      current.includes(sourcePath)
        ? current.filter((item) => item !== sourcePath)
        : [...current, sourcePath],
    );
  }

  function toggleAllClaudeSessions() {
    const allPaths = claudeImportSessions.map((session) => session.sourcePath);
    setClaudeImportSelected((current) =>
      allPaths.length > 0 && allPaths.every((path) => current.includes(path))
        ? []
        : allPaths,
    );
  }

  async function importClaudeSessions() {
    if (!claudeImportProject || claudeImportSelected.length === 0) return;
    setClaudeImportRunning(true);
    setClaudeImportReport(null);
    try {
      const report = await api.claudeSessions.import(
        claudeImportProject.id,
        claudeImportSelected,
      );
      setClaudeImportReport(report);
      await scanClaudeSessions(claudeImportProject, false);
      await refreshProjectSessions(claudeImportProject.id);
      if (sessionsProjectId === claudeImportProject.id)
        await refreshSessions(claudeImportProject.id);
      showToast(
        t("claude.importDone", {
          imported: report.imported,
          failed: report.failed,
        }),
      );
    } catch (error) {
      showToast(
        t("claude.importFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        4000,
      );
    } finally {
      setClaudeImportRunning(false);
    }
  }

  async function openOpenCodeImport(project: Project) {
    setProjectMenu(null);
    setOpenCodeImportProject(project);
    setOpenCodeImportReport(null);
    setOpenCodeImportSessions([]);
    setOpenCodeImportSelected([]);
    await scanOpenCodeSessions(project);
  }

  async function scanOpenCodeSessions(
    project = openCodeImportProject,
    clearReport = true,
  ) {
    if (!project) return;
    setOpenCodeImportLoading(true);
    if (clearReport) setOpenCodeImportReport(null);
    try {
      const next = await api.openCodeSessions.scan(project.id);
      setOpenCodeImportSessions(next);
      // OpenCode 导入会覆盖同名目标副本，默认不勾选，避免误覆盖用户已经导入过的历史。
      setOpenCodeImportSelected([]);
    } catch (error) {
      showToast(
        t("opencode.scanFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        4000,
      );
    } finally {
      setOpenCodeImportLoading(false);
    }
  }

  function toggleOpenCodeSession(sourcePath: string) {
    setOpenCodeImportSelected((current) =>
      current.includes(sourcePath)
        ? current.filter((item) => item !== sourcePath)
        : [...current, sourcePath],
    );
  }

  function toggleAllOpenCodeSessions() {
    const allPaths = openCodeImportSessions.map((session) => session.sourcePath);
    setOpenCodeImportSelected((current) =>
      allPaths.length > 0 && allPaths.every((path) => current.includes(path))
        ? []
        : allPaths,
    );
  }

  async function importOpenCodeSessions() {
    if (!openCodeImportProject || openCodeImportSelected.length === 0) return;
    setOpenCodeImportRunning(true);
    setOpenCodeImportReport(null);
    try {
      const report = await api.openCodeSessions.import(
        openCodeImportProject.id,
        openCodeImportSelected,
      );
      setOpenCodeImportReport(report);
      await scanOpenCodeSessions(openCodeImportProject, false);
      await refreshProjectSessions(openCodeImportProject.id);
      if (sessionsProjectId === openCodeImportProject.id)
        await refreshSessions(openCodeImportProject.id);
      showToast(
        t("opencode.importDone", {
          imported: report.imported,
          failed: report.failed,
        }),
      );
    } catch (error) {
      showToast(
        t("opencode.importFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        4000,
      );
    } finally {
      setOpenCodeImportRunning(false);
    }
  }

  async function reorderProjects(
    sourceProjectId: string,
    targetProjectId: string,
  ) {
    if (!canReorderProjects || sourceProjectId === targetProjectId) return;
    const sourceProject = projects.find(
      (project) => project.id === sourceProjectId,
    );
    const targetProject = projects.find(
      (project) => project.id === targetProjectId,
    );
    if (isChatProject(sourceProject) || isChatProject(targetProject)) return;
    const sourceIndex = projects.findIndex(
      (project) => project.id === sourceProjectId,
    );
    const targetIndex = projects.findIndex(
      (project) => project.id === targetProjectId,
    );
    if (sourceIndex === -1 || targetIndex === -1) return;

    const previousProjects = projects;
    const nextProjects = [...projects];
    const [movedProject] = nextProjects.splice(sourceIndex, 1);
    const targetIndexAfterRemoval = nextProjects.findIndex(
      (project) => project.id === targetProjectId,
    );
    const insertIndex =
      sourceIndex < targetIndex
        ? targetIndexAfterRemoval + 1
        : targetIndexAfterRemoval;
    nextProjects.splice(insertIndex, 0, movedProject);
    setProjects(nextProjects);

    try {
      const savedProjects = await api.projects.reorder(
        nextProjects.map((project) => project.id),
      );
      setProjects(savedProjects);
    } catch (error) {
      setProjects(previousProjects);
      showToast(
        t("app.projectSortFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        4000,
      );
    }
  }

  function handleProjectDragStart(
    event: React.DragEvent<HTMLButtonElement>,
    projectId: string,
  ) {
    if (!canReorderProjects) {
      event.preventDefault();
      return;
    }
    setDraggingProjectId(projectId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", projectId);
  }

  function handleProjectDragOver(
    event: React.DragEvent<HTMLButtonElement>,
    projectId: string,
  ) {
    if (!draggingProjectId || draggingProjectId === projectId) return;
    if (isChatProject(projects.find((project) => project.id === projectId)))
      return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragOverProjectId(projectId);
  }

  function handleProjectDragLeave(projectId: string) {
    setDragOverProjectId((current) =>
      current === projectId ? undefined : current,
    );
  }

  function finishProjectDrag() {
    setDraggingProjectId(undefined);
    setDragOverProjectId(undefined);
  }

  async function handleProjectDrop(
    event: React.DragEvent<HTMLButtonElement>,
    targetProjectId: string,
  ) {
    event.preventDefault();
    const sourceProjectId =
      event.dataTransfer.getData("text/plain") || draggingProjectId;
    finishProjectDrag();
    if (!sourceProjectId || sourceProjectId === targetProjectId) return;
    projectDragPreventClickRef.current = true;
    window.setTimeout(() => {
      projectDragPreventClickRef.current = false;
    }, 0);
    await reorderProjects(sourceProjectId, targetProjectId);
  }

  async function addProject() {
    const project = await api.projects.add();
    if (!project) return;
    await refreshProjects();
    setActiveProjectId(project.id);
    setActiveAgentId(undefined);
  }

  function updateAfterProjectRemoved(
    removedProjectId: string,
    next: Project[],
  ) {
    setSessionsByProject((current) => {
      const updated = { ...current };
      delete updated[removedProjectId];
      return updated;
    });
    setVisibleProjectChildCountByProject((current) => {
      const updated = { ...current };
      delete updated[removedProjectId];
      return updated;
    });
    if (activeProjectId === removedProjectId) {
      setActiveProjectId(next[0]?.id);
      setActiveAgentId(undefined);
    }
    if (sessionsProjectId === removedProjectId) {
      setSessionsProjectId(undefined);
      if (drawer === "sessions") setDrawer(null);
    }
  }

  async function createAgent(
    projectId = activeProjectId,
    sessionPath?: string,
    title?: string,
  ): Promise<AgentTab | undefined> {
    if (!projectId) return;
    const project = projects.find((item) => item.id === projectId);
    if (!project) return;
    const existing = sessionPath
      ? [...displayAgents, ...pendingAgentsRef.current].find(
          (agent) =>
            agent.projectId === projectId &&
            isSameSessionPath(agent.sessionPath, sessionPath),
        )
      : undefined;
    if (existing) {
      setActiveProjectId(existing.projectId);
      setActiveAgentId(existing.id);
      setDrawer(null);
      setAutoScroll(true);
      autoScrollRef.current = true;
      return existing;
    }
    const previousAgentId = activeAgentId;
    const pendingTab: PendingAgentTab = {
      id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      projectId,
      cwd: project.path,
      title: title || `${project.name} agent`,
      status: "starting",
      sessionPath,
      createdAt: Date.now(),
    };
    pendingAgentsRef.current = [...pendingAgentsRef.current, pendingTab];
    setPendingAgents(pendingAgentsRef.current);
    setActiveProjectId(projectId);
    setActiveAgentId(pendingTab.id);
    setActiveAgentByProject((current) => ({
      ...current,
      [projectId]: pendingTab.id,
    }));
    void api.app.rendererLog("info", "renderer", "Agent create requested", {
      projectId,
      sessionPath,
      title,
      pendingAgentId: pendingTab.id,
    });
    // 立即关闭抽屉,避免等待 agent 加载期间列表仍然显示
    setDrawer(null);
    try {
      const tab = await withTimeout<AgentTab>(
        api.agents.create({ projectId, sessionPath, title }),
        AGENT_CREATE_TIMEOUT_MS,
        t("app.agentCreateTimeout"),
      );
      pendingAgentsRef.current = pendingAgentsRef.current.filter(
        (agent) => agent.id !== pendingTab.id,
      );
      setPendingAgents(pendingAgentsRef.current);
      setActiveAgentId((current) =>
        current === pendingTab.id ? tab.id : current,
      );
      setActiveAgentByProject((current) =>
        current[projectId] === pendingTab.id
          ? {
              ...current,
              [projectId]: tab.id,
            }
          : current,
      );
      setPromptByAgent((current) => {
        const draft = current[pendingTab.id];
        if (draft == null) return current;
        const next = { ...current, [tab.id]: draft };
        delete next[pendingTab.id];
        return next;
      });
      setAttachedImagesByAgent((current) => {
        const draft = current[pendingTab.id];
        if (draft == null) return current;
        const next = { ...current, [tab.id]: draft };
        delete next[pendingTab.id];
        return next;
      });
      // 全新创建的会话需要刷新历史列表以显示新文件；从已有历史会话打开的 agent 跳过刷新，避免文件 mtime 被不必要地读/写导致排序提前
      if (!sessionPath) {
        void refreshProjectSessions(projectId).catch(() => undefined);
      }
      void refreshRuntimeState(tab.id);
      void api.app.rendererLog("info", "renderer", "Agent create completed", {
        projectId,
        pendingAgentId: pendingTab.id,
        agentId: tab.id,
        status: tab.status,
      });
      return tab;
    } catch (e) {
      pendingAgentsRef.current = pendingAgentsRef.current.filter(
        (agent) => agent.id !== pendingTab.id,
      );
      setPendingAgents(pendingAgentsRef.current);
      setActiveAgentId((current) =>
        current === pendingTab.id ? previousAgentId : current,
      );
      setActiveAgentByProject((current) => {
        if (current[projectId] !== pendingTab.id) return current;
        const next = { ...current };
        if (previousAgentId) next[projectId] = previousAgentId;
        else delete next[projectId];
        return next;
      });
      showToast(e instanceof Error ? e.message : String(e), 5000);
      void api.app.rendererLog("warn", "renderer", "Agent create failed", {
        projectId,
        pendingAgentId: pendingTab.id,
        error: e instanceof Error ? e.message : String(e),
      });
      // 创建失败或超时时回退乐观占位，避免停留在不存在的 pending agent。
      return undefined;
    }
  }

  async function refreshRuntimeState(agentId = activeAgentId) {
    if (!agentId || isPendingAgentId(agentId)) return;
    const state = await api.agents.runtimeState(agentId).catch(() => undefined);
    if (state)
      setRuntimeStateByAgent((current) => ({ ...current, [agentId]: state }));
  }

  function getProjectFilter(projectId: string) {
  	return sessionSourceFilter[projectId] ?? null;
  }

  function toggleSessionSourceFilter(projectId: string, source: "pi" | "codex" | "claude" | "opencode") {
  	setSessionSourceFilter((current) => {
  		const prev = current[projectId] ?? null;
  		if (prev === null) {
  			return { ...current, [projectId]: new Set([source]) };
  		}
  		const next = new Set(prev);
  		if (next.has(source)) {
  			next.delete(source);
  			if (next.size === 0) {
  				const copy = { ...current };
  				copy[projectId] = null;
  				return copy;
  			}
  		} else {
  			next.add(source);
  		}
  		return { ...current, [projectId]: next };
  	});
  }

  async function cycleModel() {
    if (!activeAgentId || isPendingAgentId(activeAgentId)) return;
    const state = await api.agents.cycleModel(activeAgentId);
    setRuntimeStateByAgent((current) => ({
      ...current,
      [activeAgentId]: state,
    }));
  }

  /** 调整菜单位置避免溢出视口 */
  function adjustMenuPos(x: number, y: number, width = 200, height = 260) {
  	const vw = window.innerWidth;
  	const vh = window.innerHeight;
  	return {
  		x: x + width > vw ? Math.max(4, vw - width - 8) : x,
  		y: y + height > vh ? Math.max(4, vh - height - 8) : y,
  	};
  }

  async function openModelPicker() {
    if (!activeAgentId || isPendingAgentId(activeAgentId)) return;
    const models = await api.agents.availableModels(activeAgentId);
    setAvailableModels(models);
    setModelPickerOpen(true);
  }

  async function openPromptTemplatePicker() {
    if (!activeAgentId || isPendingAgentId(activeAgentId)) return;
    const allTemplates: typeof promptTemplateList = [];
    try {
      const globalResult = await api.prompts.list();
      for (const tpl of globalResult.templates) {
        allTemplates.push({
            ...tpl,
            description: translateBuiltinPromptDescription(tpl),
            argumentHint: parseArgumentHint(tpl.content),
        });
      }
    } catch {
      // 全局列表失败时继续加载项目列表
    }
    // 同时加载当前活动项目的项目级提示词
    const activeProject = activeProjectId
      ? projects.find((p) => p.id === activeProjectId)
      : undefined;
    if (activeProject) {
      try {
        const projectResult = await api.prompts.listByProject(activeProject.path);
        allTemplates.push(...projectResult.templates);
      } catch {
        // 项目无 .pi/prompts/ 目录时静默跳过
      }
    }
    setPromptTemplateList(allTemplates);
    setPromptTemplatePickerOpen(true);
  }

  function selectPromptTemplate(template: {
    name: string;
    path: string;
    description: string;
    content: string;
    argumentHint?: string;
  }) {
    // 插入斜线命令形式，pi 会在发送时自动展开，末尾加空格分割后续输入
    setPrompt((prev) => {
      const trimmed = prev ? prev.trimEnd() : "";
      if (!trimmed) return "/" + template.name + " ";
      return trimmed + " /" + template.name + " ";
    });
    setPromptTemplatePickerOpen(false);
  }

  async function selectModel(model: AvailableModel) {
    if (!activeAgentId || isPendingAgentId(activeAgentId)) return;
    const state = await api.agents.setModel(
      activeAgentId,
      model.provider,
      model.id,
    );
    setRuntimeStateByAgent((current) => ({
      ...current,
      [activeAgentId]: state,
    }));
    setModelPickerOpen(false);
  }

  /** 切换模型的收藏状态，收藏的模型在选模型列表中置顶显示 */
  function toggleFavoriteModel(provider: string, modelId: string) {
    const key = `${provider}/${modelId}`;
    const current = settings.favoriteModels ?? [];
    const next = current.includes(key)
      ? current.filter((id) => id !== key)
      : [...current, key];
    void updateSettings({ favoriteModels: next });
  }

  async function cycleThinking() {
    if (!activeAgentId || isPendingAgentId(activeAgentId)) return;
    const state = await api.agents.cycleThinking(activeAgentId);
    setRuntimeStateByAgent((current) => ({
      ...current,
      [activeAgentId]: state,
    }));
  }

  async function selectThinking(level: string) {
    if (!activeAgentId || isPendingAgentId(activeAgentId)) return;
    try {
      // 使用 setThinking 明确落到用户选择的档位,避免 cycle 模式需要反复点击才能到目标级别。
      const state = await api.agents.setThinking(activeAgentId, level);
      setRuntimeStateByAgent((current) => ({
        ...current,
        [activeAgentId]: state,
      }));
      setThinkingPickerOpen(false);
      // pi runtime 会按模型能力 clamp thinking level;对比实际状态,避免用户误以为已运行在不支持的档位。
      if (state.thinkingLevel && state.thinkingLevel !== level) {
        showToast(
          t("app.thinkingUnsupported", {
            level,
            fallback: state.thinkingLevel,
          }),
        );
      }
    } catch (error) {
      showToast(
        t("app.thinkingSwitchFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async function compactAgent(compactPrompt?: string) {
    if (!activeAgentId || isPendingAgentId(activeAgentId)) return;
    setCompacting(true);
    try {
      const state = await api.agents.compact(activeAgentId, compactPrompt);
      setRuntimeStateByAgent((current) => ({
        ...current,
        [activeAgentId]: state,
      }));
      showToast(t("app.compactDone"));
    } catch (e) {
      showToast(t("app.compactFailed"));
    } finally {
      setCompacting(false);
    }
  }

  async function closeAgent(agentId: string) {
    if (isPendingAgentId(agentId)) return;
    await api.agents.stop(agentId);
  }

  async function abortAgent(agentId = activeAgentId) {
    if (!agentId || isPendingAgentId(agentId)) return;
    // 立即清除流式状态，让思考气泡和 loading 立刻消失，不等后端 RPC 返回
    setRuntimeStateByAgent((current) => {
      const prev = current[agentId];
      if (!prev) return current;
      return { ...current, [agentId]: { ...prev, isStreaming: false } };
    });
    await api.agents.abort(agentId);
    // 不调用 refreshRuntimeState：AgentManager.abort() 会通过 emitState 推送正确状态，
    // 避免后端 get_state 返回过时的 isStreaming: true 覆盖前端立刻设的 false。
  }

  async function exportAgentHtml(agentId: string) {
    if (isPendingAgentId(agentId)) return;
    setAgentActionLoading("export");
    try {
      const result = await api.agents.exportHtml(agentId);
      showToast(t("app.exportedPath", { path: result.path }), 3500);
    } finally {
      setAgentActionLoading(null);
      setAgentMenu(null);
    }
  }

  function setTerminalOpenForAgent(agentId: string, open: boolean) {
    setTerminalDockStateByAgent((current) =>
      setTerminalDockOpen(current, agentId, open),
    );
  }

  function setTerminalCollapsedForAgent(agentId: string, collapsed: boolean) {
    setTerminalDockStateByAgent((current) =>
      setTerminalDockCollapsed(current, agentId, collapsed),
    );
  }

  function handleComposerKeyDown(
    event: React.KeyboardEvent<HTMLDivElement>,
  ) {
    if (suggestionsOpen && suggestionItems.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedSuggestionIndex((index) =>
          Math.min(index + 1, suggestionItems.length - 1),
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedSuggestionIndex((index) => Math.max(index - 1, 0));
        return;
      }
      if (event.key === "Enter") {
        // IME 确认时也会触发 Enter(keyCode=229 或 isComposing),不放行到建议选中。
        if ((event.nativeEvent as KeyboardEvent).isComposing || event.keyCode === 229) return;
        event.preventDefault();
        const selected =
          suggestionItems[
            Math.min(selectedSuggestionIndex, suggestionItems.length - 1)
          ];
        if (selected) {
          // 以光标为锚替换触发符..光标这一段,并在下一帧恢复光标到插入项之后。
          const el = event.currentTarget;
          const cursor = getCaretOffsetOf(el);
          const result = applySuggestion(prompt, cursor, selected.value);
          // RichInput 的受控同步会基于 value 重渲染并恢复光标,这里同步状态即可。
          setPrompt(result.text);
          setComposerCursor(result.cursor);
          pendingComposerCaretRef.current = result.cursor;
          setSuggestionsOpen(false);
          requestAnimationFrame(() => {
            composerTextareaRef.current?.focus();
          });
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        const el = event.currentTarget;
        const cursor = getCaretOffsetOf(el);
        const result = clearSuggestionTrigger(prompt, cursor);
        setPrompt(result.text);
        setComposerCursor(result.cursor);
        pendingComposerCaretRef.current = result.cursor;
        setSuggestionsOpen(false);
        requestAnimationFrame(() => {
          composerTextareaRef.current?.focus();
        });
        return;
      }
    }

    // 历史命令导航:只在光标位于第一行时生效
    const editor = event.currentTarget;
    const cursorPos = getCaretOffsetOf(editor);
    const textBeforeCursor = prompt.substring(0, cursorPos);
    const isFirstLine = !textBeforeCursor.includes('\n');
    const textAfterCursor = prompt.substring(cursorPos);
    const isLastLine = !textAfterCursor.includes('\n');

    if (event.key === "ArrowUp" && isFirstLine && commandHistory.length > 0) {
      event.preventDefault();

      // 首次导航时保存当前输入
      if (!historyNavigating) {
        setSavedPrompt(prompt);
        setHistoryNavigating(true);
        const newIndex = 0;
        setHistoryIndex(newIndex);
        setPrompt(commandHistory[newIndex]);
      } else {
        // 继续向上导航
        const newIndex = Math.min(historyIndex + 1, commandHistory.length - 1);
        if (newIndex !== historyIndex) {
          setHistoryIndex(newIndex);
          setPrompt(commandHistory[newIndex]);
        }
      }
      return;
    }

    if (event.key === "ArrowDown" && isLastLine && historyNavigating) {
      event.preventDefault();

      if (historyIndex > 0) {
        // 向下导航
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setPrompt(commandHistory[newIndex]);
      } else {
        // 回到最初输入的内容
        setHistoryIndex(-1);
        setHistoryNavigating(false);
        setPrompt(savedPrompt);
        setSavedPrompt("");
      }
      return;
    }

    if (event.key === "Escape") {
      const el = event.currentTarget;
      const cursor = getCaretOffsetOf(el);
      const result = clearSuggestionTrigger(prompt, cursor);
      setPrompt(result.text);
      setComposerCursor(result.cursor);
      setSuggestionsOpen(false);
      // 如果正在历史导航,ESC 退出并恢复原始输入
      if (historyNavigating) {
        setPrompt(savedPrompt);
        setHistoryIndex(-1);
        setHistoryNavigating(false);
        setSavedPrompt("");
      }
    }
    const enterIntent = getComposerEnterIntent(event, settings.sendShortcut);
    if (enterIntent === "send") {
      event.preventDefault();
      void sendPrompt();
    } else if (enterIntent === "newline") {
      // RichInput 内部会在 Enter 未被上层 preventDefault 时手动插入 \n。
      return;
    }
  }

  /** 判断 agent 是否处于忙碌状态(正在处理消息或流式输出中) */
  const isAgentStarting = activeAgent?.status === "starting";
  const composerDisabled = !activeAgent || isAgentStarting;
  const isAgentBusy = Boolean(
    activeAgent &&
    (activeAgent.status === "running" || activeRuntimeState?.isStreaming),
  );

  // 切换 agent 时不能沿用上一会话的 busy 边沿,否则旧 agent 结束可能误触发新 agent 的 goal 续接。
  useEffect(() => {
    prevIsAgentBusyRef.current = false;
    goalContinuationPendingRef.current = false;
    goalLastResponseSignatureRef.current = "";
  }, [activeAgentId]);

  // 自动续接：busy → idle 时，如果 goal 仍 active 则自动发送续接
  useEffect(() => {
    const busy = isAgentBusy;
    const wasBusy = prevIsAgentBusyRef.current;
    prevIsAgentBusyRef.current = busy;
    if (wasBusy && !busy && goalStatusRef.current === "active" && activeAgentId) {
      const text = goalTextRef.current;
      // 直接扫描消息确认是否有 goal_complete（防范 effect 时序问题）
      const goalMsgs = activeAgentId ? messagesByAgent[activeAgentId] : undefined;
      if (goalMsgs?.some((m) => m.role === "tool" && m.meta?.toolName === "goal_complete")) {
        goalStatusRef.current = "complete";
        setGoalStatus("complete");
        setGoalCompletedAt(Date.now());
        return;
      }

      const latestResponseSignature =
        goalMsgs
          ?.filter((message) => message.role === "assistant" || message.role === "tool")
          .slice(-1)
          .map((message) => `${message.role}:${message.id}:${message.timestamp}`)[0] ?? "";

      // 如果上一次自动续接后没有产生新的 assistant/tool 消息,说明只是状态抖动或发送失败重入,
      // 继续 followUp 只会堆叠同一目标,因此暂停交给用户检查而不是无限循环。
      if (
        goalIterationRef.current > 0 &&
        goalLastResponseSignatureRef.current === latestResponseSignature
      ) {
        goalStatusRef.current = "paused";
        goalContinuationPendingRef.current = false;
        setGoalStatus("paused");
        showToast("🎯 Goal paused: no new agent response after auto continuation.", 4000);
        return;
      }

      const iteration = goalIterationRef.current + 1;

      // 达到最大续接次数时暂停,保留未完成状态,避免模型未调用 goal_complete 时无限自动续接。
      if (iteration > GOAL_MAX_CONTINUATIONS) {
        goalStatusRef.current = "paused";
        goalContinuationPendingRef.current = false;
        setGoalStatus("paused");
        showToast(`🎯 Goal paused after ${GOAL_MAX_CONTINUATIONS} auto continuations.`, 4000);
        return;
      }

      if (!goalContinuationPendingRef.current && text) {
        goalIterationRef.current = iteration;
        goalContinuationPendingRef.current = true;
        goalLastResponseSignatureRef.current = latestResponseSignature;
        const continuationMsg = `[goal 自动续接 #${iteration}]
当前目标仍未完成，请继续工作:
<goal_objective>
${text}
</goal_objective>

继续完成该目标。不要停止在分析、计划、TODO 或部分修改上。彻底完成后调用 goal_complete。`;
        api.agents.prompt({
          agentId: activeAgentId,
          message: continuationMsg,
          description: "[goal 自动续接]",
          streamingBehavior: "followUp",
        }).catch(() => {
          goalContinuationPendingRef.current = false;
        });
      }
    }
    if (busy) {
      goalContinuationPendingRef.current = false;
    }
  }, [isAgentBusy, activeAgentId, api.agents, messagesByAgent]);

  /** 解析消息中的 & 会话引用，将 chip 替换为引用上下文 */
  async function resolveSessionRefs(message: string): Promise<string> {
    let resolved = message;
    const sorted = [...activeProjectSessions].sort(
      (a, b) => (b.name ?? b.filePath).length - (a.name ?? a.filePath).length,
    );
    for (const session of sorted) {
      const sessionName = session.name ?? session.filePath;
      const raw = `&${sessionName}`;
      // 大小写不敏感查找，但保留原始大小写用于替换
      const lowerResolved = resolved.toLowerCase();
      const lowerRaw = raw.toLowerCase();
      if (!lowerResolved.includes(lowerRaw)) continue;
      // 预编译正则 pattern，避免在 if/else 分支中重复创建
      const pattern = new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      let msgs: Array<{ role: string; content: string }> | undefined;
      if (sessionRefSelections[raw]) {
        msgs = sessionRefSelections[raw].messages;
      } else {
        try {
          const all = await api.sessions.readMessages(session.filePath);
          const loaded = all.map((m) => ({ role: m.role, content: m.content }));
          msgs = loaded;
          setSessionRefSelections((prev) => ({ ...prev, [raw]: { messages: loaded, fullContext: true, selectedIndices: loaded.map((_, i) => i) } }));
        } catch {
          // 加载失败时 chip 会在下面 else 分支被移除
        }
      }
      if (msgs && msgs.length > 0) {
        const ctx = msgs.map((m) => `[${m.role === "user" ? "User" : "Assistant"}]: ${m.content}`).join("\n");
        const refBlock = `<referenced_session name="${sessionName}">\n${ctx}\n</referenced_session>`;
        resolved = resolved.replace(pattern, refBlock);
      } else {
        resolved = resolved.replace(pattern, "");
      }
    }
    return resolved;
  }

  async function sendPrompt() {
    if (
      isAgentStarting ||
      !activeAgentId ||
      (!prompt.trim() && attachedImages.length === 0)
    )
      return;
    const message = prompt;
    const images = attachedImages.length > 0 ? attachedImages : undefined;

    const trimmedMessage = message.trim();

    // ── /goal 命令处理 ──
    if (trimmedMessage.startsWith("/goal")) {
      handleGoalCommand(trimmedMessage);
      setPrompt("");
      return;
    }

    // ── /compact 命令处理 ──
    if (/^\/compact(?:\s|$)/.test(trimmedMessage)) {
      const compactPrompt = trimmedMessage.replace(/^\/compact\s*/, "").trim();
      // /compact 是桌面端内置控制命令，必须走 RPC compact 通道；否则会被当作普通消息发送给 agent。
      setPrompt("");
      setSuggestionsOpen(false);
      await compactAgent(compactPrompt || undefined);
      return;
    }

    // 保存到历史记录(只保存非空的文本命令)
    if (message.trim() && !message.startsWith("!")) {
      setCommandHistory((prev) => {
        // 避免重复保存相同的命令
        const filtered = prev.filter(cmd => cmd !== message.trim());
        // 保留最近 50 条
        const newHistory = [message.trim(), ...filtered].slice(0, 50);
        return newHistory;
      });
    }

    // 重置历史导航状态
    setHistoryIndex(-1);
    setHistoryNavigating(false);
    setSavedPrompt("");

    // 发送前先保留快照,再立即清空 composer;运行中发送会走官方 steer 队列,
    // 由 pi runtime 保证在当前工具调用结束后、下一次 LLM 调用前注入。
    // 不论之前是否滚动回看，发新消息都强制自动滚到底，确保能看到 agent 的回答。
    setAutoScroll(true);
    autoScrollRef.current = true;
    const scrollTimeline = timelineRef.current;
    if (scrollTimeline) scrollTimeline.scrollTo({ top: scrollTimeline.scrollHeight, behavior: "instant" });
    setPrompt("");
    setAttachedImages([]);
    setSuggestionsOpen(false);
    setSendBehaviorMenuOpen(false);
    // 发送后强制重置自动高度：避免粘贴多行内容后 scrollHeight 残留导致 composer 无法恢复默认高度。
    // 下一帧 DOM 同步后再跑一次 syncComposerAutoHeight，让最终高度以清空后的 scrollHeight 为准。
    // 发送后固定 composer 高度，不再自动适配内容高度
    // 让输入框保持固定大小，超出部分滚动显示
    setComposerAutoHeight(COMPOSER_MIN_HEIGHT);

    const resolvedMessage = await resolveSessionRefs(message);
    const { message: expandedMessage, description: templateDescription } = expandPromptTemplates(resolvedMessage, promptTemplateList);
    await submitPromptSnapshot(activeAgentId, expandedMessage, images, undefined, currentComposerAgentMode, templateDescription);
    // 用 MutationObserver 监听消息列表 DOM 变化，新消息出现时滚动到底部
    const scrollOnNewMessage = () => {
      const timeline = timelineRef.current;
      if (!timeline) return;
      const list = timeline.querySelector(".message-list");
      if (!list) return;
      const observer = new MutationObserver(() => {
        if (!autoScrollRef.current) return;
        timeline.scrollTo({ top: timeline.scrollHeight, behavior: "instant" });
      });
      observer.observe(list, { childList: true, subtree: false });
      // 8 秒后自动断开，避免累积
      setTimeout(() => observer.disconnect(), 8000);
    };
    requestAnimationFrame(scrollOnNewMessage);
  }

  async function sendPromptAsFollowUp() {
    if (
      isAgentStarting ||
      !activeAgentId ||
      (!prompt.trim() && attachedImages.length === 0)
    )
      return;
    const message = prompt;
    const images = attachedImages.length > 0 ? attachedImages : undefined;
    setAutoScroll(true);
    autoScrollRef.current = true;
    const scrollTimeline = timelineRef.current;
    if (scrollTimeline) scrollTimeline.scrollTo({ top: scrollTimeline.scrollHeight, behavior: "instant" });
    setPrompt("");
    setAttachedImages([]);
    setSuggestionsOpen(false);
    setSendBehaviorMenuOpen(false);
    setComposerAutoHeight(COMPOSER_MIN_HEIGHT);
    const resolvedMessage = await resolveSessionRefs(message);
    await submitPromptSnapshot(activeAgentId, resolvedMessage, images, "followUp", currentComposerAgentMode);
    // 用 MutationObserver 监听消息列表 DOM 变化，新消息出现时滚动到底部
    const scrollOnNewMessage = () => {
      const timeline = timelineRef.current;
      if (!timeline) return;
      const list = timeline.querySelector(".message-list");
      if (!list) return;
      const observer = new MutationObserver(() => {
        if (!autoScrollRef.current) return;
        timeline.scrollTo({ top: timeline.scrollHeight, behavior: "instant" });
      });
      observer.observe(list, { childList: true, subtree: false });
      setTimeout(() => observer.disconnect(), 8000);
    };
    requestAnimationFrame(scrollOnNewMessage);
  }

  /** 处理 /goal 命令 */
  function handleGoalCommand(input: string) {
    const trimmed = input.replace(/^\/goal/, "").trim();
    const first = trimmed.split(/\s+/)[0];

    if (!trimmed || first === "status") {
      if (goalStatusRef.current === "none") {
        showToast(!activeAgentId ? t("goal.noGoal") : `Usage: /goal <objective>\nNo goal set.`, 3000);
      } else {
        const elapsed = goalStartedAtRef.current ? Math.floor((Date.now() - goalStartedAtRef.current) / 1000) : 0;
        const elapsedStr = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s` : `${elapsed}s`;
        const tokenHint = goalIterationRef.current > 0 ? ` (续接 ${goalIterationRef.current} 次)` : "";
        showToast(`🎯 ${goalStatusRef.current === "complete" ? "已完成" : "进行中"}: ${goalTextRef.current}\n耗时: ${elapsedStr} | 状态: ${goalStatusRef.current}${tokenHint}`, 4000);
      }
      return;
    }

    if (first === "clear" || first === "stop") {
      goalStatusRef.current = "none";
      goalTextRef.current = "";
      goalStartedAtRef.current = 0;
      goalIterationRef.current = 0;
      goalContinuationPendingRef.current = false;
      goalLastResponseSignatureRef.current = "";
      setGoalStatus("none");
      setGoalText("");
      setGoalStartedAt(0);
      setGoalCompletedAt(0);
      showToast("🎯 Goal cleared", 2000);
      return;
    }

    if (first === "pause") {
      if (goalStatusRef.current !== "active") {
        showToast("No active goal to pause.", 2000);
        return;
      }
      goalStatusRef.current = "paused";
      setGoalStatus("paused");
      goalContinuationPendingRef.current = false;
      showToast(`🎯 Goal paused: ${goalTextRef.current}`, 3000);
      return;
    }

    if (first === "resume") {
      if (goalStatusRef.current !== "paused") {
        showToast("No paused goal to resume.", 2000);
        return;
      }
      goalStatusRef.current = "active";
      setGoalStatus("active");
      goalContinuationPendingRef.current = false;
      goalLastResponseSignatureRef.current = "";
      void submitPromptSnapshot(activeAgentId!, `[goal 续接] 之前暂停的目标已恢复，请继续完成:
<goal_objective>
${goalTextRef.current}
</goal_objective>`, undefined, "followUp");
      showToast(`🎯 Goal resumed: ${goalTextRef.current}`, 3000);
      return;
    }

    // /goal <objective> — 启动新目标
    const objective = trimmed;
    const existing = goalStatusRef.current;
    if (existing === "active") {
      // 使用自定义 ConfirmDialog 弹框确认替换当前目标
      setConfirmDialog({
        title: t("goal.replaceTitle"),
        message: t("goal.replaceConfirm", { goal: goalTextRef.current ?? "" }),
        danger: false,
        confirmLabel: t("common.confirm"),
        onConfirm: () => {
          setConfirmDialog(null);
          startNewGoal(objective);
        },
      });
      return;
    }
    startNewGoal(objective);
  }

  /** 在确认后实际启动新目标（从 /goal 和 replace 确认回调共享） */
  function startNewGoal(objective: string) {

    goalTextRef.current = objective;
    goalStatusRef.current = "active";
    goalStartedAtRef.current = Date.now();
    goalIterationRef.current = 0;
    goalContinuationPendingRef.current = false;
    goalLastResponseSignatureRef.current = "";
    setGoalText(objective);
    setGoalStatus("active");
    setGoalStartedAt(Date.now());
    setGoalCompletedAt(0);

    // 将目标文本作为普通消息发送（不使用 followUp，避免显示错误的消息标签）
    void submitPromptSnapshot(activeAgentId!, objective);
    // 目标文本作为用户消息显示在对话中，goal 状态可通过 /goal status 查看
  }

  async function submitPromptSnapshot(
    agentId: string,
    message: string,
    images?: ImageContent[],
    streamingBehavior?: "steer" | "followUp",
    agentMode: ComposerAgentMode = "normal",
    /** prompt 模板匹配到的 description，作为元数据发给 pi agent 标识意图 */
    templateDescription?: string,
  ) {
    // 这里接收快照参数,让 composer 发送和历史消息"重新发送"共享同一条路径。
    // Agent 忙碌时显式使用官方 streamingBehavior=steer:消息会进入 pi 的运行中队列,
    // 而不是留在 desktop 本地等整个 agent idle 后再发送。
    const behavior = streamingBehavior ?? (isAgentBusy ? "steer" : undefined);
    const submission = buildComposerPromptSubmission(message, agentMode);
    await api.agents.prompt({
      agentId,
      message: submission.message,
      images,
      ...(submission.agentMessage ? { agentMessage: submission.agentMessage } : {}),
      ...(templateDescription ? { description: templateDescription } : {}),
      ...(behavior ? { streamingBehavior: behavior } : {}),
    });
  }

  /** 重发防重复：通过 messageId 锁避免同一消息多次重发。
   *  锁会在 agent 状态切回 idle 时自动清除（下方 useEffect），超时 30s 兜底释放。 */
  const resendingIdsRef = useRef<Set<string>>(new Set());

  function resendUserMessage(message: ChatMessage) {
    if (!activeAgentId || message.agentId !== activeAgentId) return;
    if (resendingIdsRef.current.has(message.id)) return;
    resendingIdsRef.current.add(message.id);
    // 30 秒兜底释放，防止锁泄漏
    setTimeout(() => resendingIdsRef.current.delete(message.id), 30_000);

    // "重新发送"按原消息快照再次提交,不修改输入框,图片也复用原始 base64 内容。
    void submitPromptSnapshot(activeAgentId, message.text, message.images);
  }

  /** agent 切回 idle 时释放所有重发锁，允许下次正常重发。 */
  useEffect(() => {
    if (activeAgent?.status !== "running" && activeAgent?.status !== "starting") {
      resendingIdsRef.current.clear();
    }
  }, [activeAgent?.status]);

  /** 将主进程抛出的错误消息中的 BUSY_ 前缀码转为前端多语言文案 */
  function translateAgentErrorMessage(msg: string): string {
    if (msg.startsWith("BUSY_STREAMING:")) return t("message.busyStreaming");
    if (msg.startsWith("BUSY_TOOL:")) return t("message.busyTool");
    if (msg.startsWith("BUSY_GENERIC:")) return t("message.busyGeneric");
    return msg;
  }

  /**
   * 编辑消息：修改 JSONL + 重载会话。用户已点击「编辑 + 保存」两步操作，意图明确，不额外弹框确认。
   */
  async function editMessage(messageId: string, newText: string) {
    if (!activeAgentId) return;
    try {
      await api.agents.editMessage(activeAgentId, messageId, newText);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      showToast(`${t("message.editFailed")}: ${translateAgentErrorMessage(msg)}`, 5000);
    }
  }

  /**
   * 删除消息：从 JSONL 移除 + 重载会话。使用统一的自定义 ConfirmDialog。
   */
  function deleteMessage(messageId: string) {
    if (!activeAgentId) return;
    setConfirmDialog({
      title: t("message.deleteTitle"),
      message: t("message.deleteReloadPrompt"),
      danger: true,
      confirmLabel: t("common.delete"),
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await api.agents.deleteMessage(activeAgentId!, messageId);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          showToast(`${t("message.deleteFailed")}: ${translateAgentErrorMessage(msg)}`, 5000);
        }
      },
    });
  }

  /**
   * 处理图片文件,转为 pi RPC 可识别的 ImageContent。
   * 大图会压缩到最长边 2000px,避免 base64 过大导致 RPC 传输和模型上下文成本上升。
   */
  async function processImageFile(file: File): Promise<ImageContent | null> {
    const maxSize = 10 * 1024 * 1024; // 原始文件 10MB 限制,避免误粘超大图片卡住渲染进程
    if (file.size > maxSize) {
      showToast(t("app.imageTooLarge"), 3000);
      return null;
    }

    const validTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"];
    if (!validTypes.includes(file.type)) {
      showToast(t("app.imageUnsupported"), 3000);
      return null;
    }

    // GIF 可能是动图,canvas 压缩会丢失动画;保留原始数据。
    if (file.type === "image/gif") return fileToImageContent(file);
    return resizeImageFile(file, 2000, 0.86).catch(() =>
      fileToImageContent(file),
    );
  }

  function fileToImageContent(file: File): Promise<ImageContent> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () =>
        resolve(dataUrlToImageContent(String(reader.result), file.type));
      reader.readAsDataURL(file);
    });
  }

  function dataUrlToImageContent(
    dataUrl: string,
    fallbackMimeType: string,
  ): ImageContent {
    const [meta, data = ""] = dataUrl.split(",");
    const mimeType = meta.match(/^data:(.*?);base64$/)?.[1] || fallbackMimeType;
    return { type: "image", data, mimeType };
  }

  function resizeImageFile(
    file: File,
    maxEdge: number,
    quality: number,
  ): Promise<ImageContent> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const image = new Image();
        image.onerror = reject;
        image.onload = () => {
          const scale = Math.min(
            1,
            maxEdge / Math.max(image.width, image.height),
          );
          const width = Math.max(1, Math.round(image.width * scale));
          const height = Math.max(1, Math.round(image.height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          canvas.getContext("2d")?.drawImage(image, 0, 0, width, height);
          // JPEG 更省 token/传输体积;透明 PNG/WebP 保持 PNG,避免截图透明区域变黑。
          const outputType =
            file.type === "image/png" ? "image/png" : "image/jpeg";
          resolve(
            dataUrlToImageContent(
              canvas.toDataURL(outputType, quality),
              outputType,
            ),
          );
        };
        image.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  /** 处理粘贴事件:从剪贴板提取图片 */
  async function handlePaste(event: React.ClipboardEvent) {
    const items = Array.from(event.clipboardData.items);
    for (const item of items) {
      if (item.type.startsWith("image/")) {
        event.preventDefault();
        const file = item.getAsFile();
        if (file) {
          const image = await processImageFile(file);
          if (image) {
            setAttachedImages((prev) => [...prev, image]);
          }
        }
        return;
      }
    }
  }

  /** 处理拖拽事件:支持拖入图片 */
  async function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    for (const file of files) {
      if (file.type.startsWith("image/")) {
        const image = await processImageFile(file);
        if (image) {
          setAttachedImages((prev) => [...prev, image]);
        }
      }
    }
  }

  function handleDragOver(event: React.DragEvent) {
    event.preventDefault();
  }

  /** 移除已附加的图片 */
  function removeImage(index: number) {
    setAttachedImages((prev) => prev.filter((_, i) => i !== index));
  }

  /** 清空所有附加图片 */
  function clearImages() {
    setAttachedImages([]);
  }

  async function updateSettings(patch: Partial<AppSettings>) {
    const changesWebService =
      "webServiceEnabled" in patch ||
      "webServiceHost" in patch ||
      "webServicePort" in patch;
    if (changesWebService) {
      setWebServiceChanging(true);
      showToast(
        patch.webServiceEnabled === false
          ? t("app.webStopping")
          : t("app.webApplying"),
      );
    }
    try {
      const next = await api.settings.update(patch);
      setSettings(next);
      let notice = t("app.settingsSaved");
      if (
        "piProxyEnabled" in patch ||
        "piProxyUrl" in patch ||
        "piProxyBypass" in patch
      ) {
        notice = next.piProxyEnabled
          ? t("app.shellProxySaved")
          : t("app.shellProxyDisabled");
        setPiProxyNoticeTone("info");
        setPiProxyNotice(next.piProxyEnabled ? t("app.shellProxySaved") : "");
      }
      if (
        "desktopProxyEnabled" in patch ||
        "desktopProxyUrl" in patch ||
        "desktopProxyBypass" in patch
      ) {
        notice = next.desktopProxyEnabled
          ? t("app.webProxySaved")
          : t("app.webProxyDisabled");
      }
      if ("sendShortcut" in patch) {
        notice = t("app.sendShortcutSaved");
      }
      if (
        "webServiceEnabled" in patch ||
        "webServiceHost" in patch ||
        "webServicePort" in patch
      ) {
        notice = next.webServiceEnabled
          ? t("app.webServiceStarted", { port: next.webServicePort })
          : t("app.webServiceStopped");
      }
      if ("useNativeTitleBar" in patch) {
        notice = t("app.titleBarSaved");
      }
      // WSL/Windows pi 源切换：重新检测 pi 环境、刷新项目和会话列表
      if ("wslEnabled" in patch || "wslDistro" in patch || "wslUser" in patch) {
        void api.pi.check().then((next) => setPiStatus(next)).catch(() => undefined);
        void api.agents.list().then(setAgents).catch(() => undefined);
        void api.projects.list().then(setProjects).catch(() => undefined);
        if (activeProjectId) {
          void api.sessions.list(activeProjectId).then((sessions) => {
            setSessions([...sessions].sort((a, b) => b.updatedAt - a.updatedAt));
          }).catch(() => undefined);
        }
      }
      showToast(notice);
    } catch (error) {
      setSettings(await api.settings.get());
      showToast(error instanceof Error ? error.message : String(error));
    } finally {
      if (changesWebService) setWebServiceChanging(false);
    }
  }

  async function testPiProxy() {
    setPiProxyChecking(true);
    setPiProxyNoticeTone("info");
    setPiProxyNotice(t("app.proxyChecking"));
    try {
      const result = await api.settings.testPiProxy();
      setPiProxyNoticeTone(result.success ? "success" : "error");
      setPiProxyNotice(
        result.success
          ? t("app.proxyAvailable", {
              message: result.message ?? t("app.proxyDefaultOk"),
              elapsed: result.elapsedMs,
            })
          : t("app.proxyCheckFailed", {
              error: result.error ?? t("app.proxyUnknownError"),
            }),
      );
    } catch (error) {
      setPiProxyNoticeTone("error");
      setPiProxyNotice(
        t("app.proxyCheckFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setPiProxyChecking(false);
    }
  }

  async function switchBranch(branch: string) {
    if (!activeProjectId || !branch || branch === gitInfo.current) return;
    setSwitchingBranch(branch);
    try {
      const next = await api.git.checkout(activeProjectId, branch);
      setGitInfo(next);
    } catch (error) {
      showToast(
        t("app.branchSwitchFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      // 失败后主动刷新一次,覆盖 git 拒绝切换或外部同时切换导致的 UI 状态偏差。
      const refreshed = await api.git
        .branches(activeProjectId)
        .catch(() => ({ current: null, branches: [] }));
      setGitInfo(refreshed);
    } finally {
      setSwitchingBranch(null);
    }
  }

  async function createBranch(branchName: string) {
    if (!activeProjectId || !branchName.trim()) return;
    setSwitchingBranch(branchName);
    try {
      const next = await api.git.createBranch(activeProjectId, branchName);
      setGitInfo(next);
      showToast(t("app.branchCreated", { branch: branchName }), 2500);
    } catch (error) {
      showToast(
        t("app.branchCreateFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setSwitchingBranch(null);
    }
  }

  /** 创建新的 git worktree 工作区 */
  async function createWorktree(projectId: string, branchName: string) {
    setWorktreeCreating(true);
    try {
      const result = await api.git.worktreeCreate(projectId, branchName);
      // 刷新项目列表（新 worktree 已注册为项目）
      const next = await api.projects.list();
      setProjects(next);
      // 刷新 worktree 列表
      await refreshWorktrees(projectId);
      showToast(t("app.worktreeCreated") + result.branch);
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      showToast(t("app.worktreeCreateFailed") + message, 5000);
      throw e;
    } finally {
      setWorktreeCreating(false);
    }
  }

  /** 删除 worktree 工作区 */
  async function removeWorktree(parentProjectId: string, worktreePath: string) {
    try {
      const removed = await api.git.worktreeRemove(parentProjectId, worktreePath);
      if (!removed) {
        throw new Error(t("app.worktreeRemoveNotFound"));
      }
      const next = await api.projects.list();
      setProjects(next);
      await refreshWorktrees(parentProjectId);
      showToast(t("app.worktreeRemoved"));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      showToast(t("app.worktreeRemoveFailed") + message, 5000);
    } finally {
      // 无论成功还是失败，都移除动画状态，避免 worktree 行永久隐藏
      setRemovingWorktreePaths((prev) => {
        const next = new Set(prev);
        next.delete(worktreePath);
        return next;
      });
    }
  }

  /**
   * 请求删除 worktree：先校验是否有运行中的 Agent，再弹确认框，确认后执行删除。
   * 避免误删正在使用的 worktree，也保证删除结果通过 toast 反馈给用户。
   */
  function requestRemoveWorktree(
    parentProjectId: string,
    worktreePath: string,
    childProject: Project | undefined,
  ) {
    const childAgents = childProject
      ? displayAgents.filter(
          (a) =>
            a.projectId === childProject.id &&
            (a.status === "running" || a.status === "starting"),
        )
      : [];
    if (childAgents.length > 0) {
      showToast(t("app.worktreeRemoveBlockedByAgents"), 5000);
      return;
    }
    setConfirmDialog({
      title: t("app.worktreeRemoveConfirmTitle"),
      message: t("app.worktreeRemoveConfirmMessage"),
      danger: true,
      confirmLabel: t("common.delete"),
      onConfirm: () => {
        setConfirmDialog(null);
        // 先触发淡出动画（添加 removing 类），等动画结束后再执行真实删除。
        setRemovingWorktreePaths((prev) => new Set(prev).add(worktreePath));
        setTimeout(() => {
          void removeWorktree(parentProjectId, worktreePath);
        }, 280);
      },
    });
  }

  function openDrawer(panel: DrawerPanel) {
    if (drawerPinned && panel !== drawerPinnedPanel) return;
    if (panel === "sessions" && activeProjectId) {
      setSessionsProjectId(activeProjectId);
      void refreshSessions(activeProjectId);
    }
    // 打开文件面板时触发一次静默刷新，确保目录结构是最新的，避免上次打开时文件已有变更但未刷新。
    if (panel === "files" && activeProjectId) {
      void refreshFiles(activeProjectId, true);
      void refreshGitChangedFiles(activeProjectId);
    }
    setDrawer((current) => {
      if (current === panel) return drawerPinned ? current : null;
      // 持久化当前 Agent 的抽屉面板状态
      if (activeAgentId) saveDrawerState(activeAgentId, panel, drawerPinned);
      return panel;
    });
  }

  function closeDrawer() {
    if (drawerPinned) return;
    setDrawer(null);
  }

  function collapseDrawer() {
    if (drawerPinned) return;
    setDrawerCollapsed(true);
  }

  function toggleDrawerPinned() {
    if (!activeAgentId || !drawer) return;
    const willPin = !drawerPinned;
    setDrawerPinnedByAgent((current) => {
      const next = { ...current };
      if (next[activeAgentId]) delete next[activeAgentId];
      else next[activeAgentId] = drawer;
      return next;
    });
    // 持久化钉选状态
    saveDrawerState(activeAgentId, drawer, willPin);
  }

  function toggleDirectory(path: string) {
    // 文件树默认折叠,只有用户显式展开目录才显示子项,避免大仓库一打开就产生视觉噪音。
    setExpandedDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      // 持久化展开状态到 localStorage，切换回此会话时恢复
      if (activeAgentId) saveExpandedDirs(activeAgentId, next);
      return next;
    });
  }

  function startResize(target: "list" | "drawer", event: PointerEvent) {
    const startX = event.clientX;
    const startListWidth = listCollapsed ? 68 : listWidth;
    const startDrawerWidth = drawerCollapsed ? 0 : drawerWidth;
    let frame = 0;

    function onMove(moveEvent: globalThis.PointerEvent) {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const delta = moveEvent.clientX - startX;
        if (target === "list") {
          const next = Math.min(440, Math.max(100, startListWidth + delta));
          setListCollapsed(next <= 120);
          setListWidth(next);
        } else {
          const minDrawerWidth = drawerPinned ? 220 : 180;
          const next = Math.min(
            560,
            Math.max(minDrawerWidth, startDrawerWidth - delta),
          );
          setDrawerCollapsed(!drawerPinned && next <= 190);
          setDrawerWidth(next);
        }
      });
    }

    function onUp() {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("is-resizing");
      document.body.classList.remove("is-list-resizing");
    }

    document.body.classList.add("is-resizing");
    if (target === "list") document.body.classList.add("is-list-resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function startComposerResize(event: PointerEvent) {
    const startY = event.clientY;
    const startHeight = resolvedComposerHeight;
    let frame = 0;

    function onMove(moveEvent: globalThis.PointerEvent) {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const maxHeight = getComposerMaxHeight();
        // 拖动的是输入区顶部边线,鼠标向上意味着输入区变高;限制最大高度避免挤压会话阅读区域。
        // 实际高度由手动高度和自动内容高度共同决定;拖到最大后自动高度也会变大,
        // 因此手动缩小时必须同步覆盖 autoHeight,否则 Math.max 会继续把输入框顶在最大高度。
        const next = Math.min(
          maxHeight,
          Math.max(
            COMPOSER_MIN_HEIGHT,
            startHeight + startY - moveEvent.clientY,
          ),
        );
        setComposerHeight(next);
        setComposerAutoHeight(next);
      });
    }

    function onUp() {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.classList.remove("is-composer-resizing");
    }

    document.body.classList.add("is-composer-resizing");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function toggleListCollapsed() {
    const nextCollapsed = !listCollapsed;
    if (!nextCollapsed) setListWidth(DEFAULT_LIST_WIDTH);
    if (nextCollapsed) {
      // 点击折叠后鼠标和焦点仍在侧栏内;先释放焦点并抑制 hover,避免刚折叠就被 CSS 展开。
      (document.activeElement as HTMLElement | null)?.blur();
    }
    setListHoverRevealSuppressed(nextCollapsed);
    setListCollapsed(nextCollapsed);
  }

  function releaseListHoverSuppression(event: PointerEvent<HTMLDivElement>) {
    if (listCollapsed && listHoverRevealSuppressed && event.clientX > 24) {
      setListHoverRevealSuppressed(false);
    }
  }

  return (
    <div
      className={[
        "wechat-shell",
        drawer ? "drawer-open" : "",
        listCollapsed ? "list-collapsed" : "",
        listHoverRevealSuppressed ? "list-hover-suppressed" : "",
        drawerCollapsed ? "drawer-collapsed" : "",
        settings.useNativeTitleBar ? "" : "custom-titlebar-enabled",
      ]
        .filter(Boolean)
        .join(" ")}
      onPointerMove={releaseListHoverSuppression}
      style={
        {
          "--list-width": `${listCollapsed ? 0 : listWidth}px`,
          "--list-expanded-width": `${listWidth}px`,
          "--list-hover-width": `${Math.max(190, listWidth)}px`,
          // 短布局过渡在面板滑动时同步收缩；内容仍由 renderedDrawer 保留到退出结束。
          "--drawer-width": `${drawer && !drawerCollapsed ? drawerWidth : 0}px`,
          "--drawer-col-w": `${drawer && !drawerCollapsed ? 260 : 0}px`,
          "--drawer-splitter-w": `${drawer && !drawerCollapsed ? 6 : 0}px`,
        } as React.CSSProperties
      }
    >
      {!settings.useNativeTitleBar && (
        <div className="window-drag-layer" aria-hidden="true" />
      )}
      {!settings.useNativeTitleBar && (
        <div className="window-controls" aria-label={t("app.windowControls")}>
          <button
            type="button"
            className={`window-control pin${windowAlwaysOnTop ? " active" : ""}`}
            aria-label={
              windowAlwaysOnTop ? t("app.windowUnpin") : t("app.windowPin")
            }
            title={
              windowAlwaysOnTop ? t("app.windowUnpin") : t("app.windowPin")
            }
            onClick={async () => {
              const next = await api.app.toggleAlwaysOnTopWindow();
              setWindowAlwaysOnTop(next);
            }}
          >
            <Pin size={15} strokeWidth={2.2} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="window-control"
            aria-label={t("app.windowMinimize")}
            title={t("app.windowMinimize")}
            onClick={() => api.app.minimizeWindow()}
          >
            <Minus size={15} strokeWidth={2.2} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="window-control"
            aria-label={t("app.windowToggleMaximize")}
            title={t("app.windowToggleMaximize")}
            onClick={() => api.app.toggleMaximizeWindow()}
          >
            <Square size={13} strokeWidth={2} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="window-control close"
            aria-label={t("app.windowClose")}
            title={t("app.windowClose")}
            onClick={() => api.app.closeWindow()}
          >
            <X size={16} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
      )}
      <aside
        className="chat-list-pane v3-braun"
        onPointerLeave={() => {
          if (listHoverRevealSuppressed) setListHoverRevealSuppressed(false);
        }}
      >
        <div className="sidebar-body">
          <div className="list-toolbar">
          <div className="app-badge">
            <LogoMark />
            <span className="brand-wordmark" aria-label="PiDeck">
              PiDeck
            </span>
          </div>
        </div>
        <button
          className="collapse-button list-collapse"
          title={listCollapsed ? t("app.expandList") : t("app.collapseList")}
          onClick={toggleListCollapsed}
        >
          {listCollapsed ? (
            <ChevronRight size={16} />
          ) : (
            <ChevronLeft size={16} />
          )}
        </button>

        <div className="search-row">
          <div className="search-box">
            <span className="search-icon">
              <Search size={14} />
            </span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("app.search")}
            />
          </div>
          <button className="round-add" onClick={addProject}>
            <Plus size={18} />
          </button>
        </div>

        <div className="conversation-list">
          {filteredProjects.map((project) => {
            const projectIsChat = isChatProject(project);
            const projectDirectoryName = projectIsChat
              ? t("app.chatProject")
              : displayProjectDirectoryName(project);
            const canDragProject = canReorderProjects && !projectIsChat;
            const projectAgents = filteredAgents.filter(
              (agent) => agent.projectId === project.id,
            );
            const projectSearch = search.trim();
            const projectSessions = ((projectSearch
              ? (sessionsByProject[project.id] ?? []).filter((session) =>
                  matches(
                    `${session.name ?? ""}${session.preview}${session.filePath}`,
                    projectSearch,
                  ),
                )
              : (sessionsByProject[project.id] ?? [])).filter((session) => {
              	const filter = sessionSourceFilter[project.id] ?? null;
              	return filter === null
              		? true
              		: filter.has(session.source ?? "pi");
              }));
            const visibleChildCount =
              visibleProjectChildCountByProject[project.id] ??
              SIDEBAR_PROJECT_CHILD_PAGE_SIZE;
            const projectDisplay = getProjectAgentSessionDisplay({
              agents: projectAgents,
              sessions: projectSessions,
              visibleChildCount,
            });
            const projectSessionsLoading = Boolean(
              sessionLoadingByProject[project.id],
            );
            const hasProjectChildren =
              projectDisplay.children.length > 0 || projectSessionsLoading || !!project.worktreeEnabled;
            const isCollapsed = collapsedProjects.has(project.id);
            const isDraggingProject = draggingProjectId === project.id;
            const isProjectDropTarget = dragOverProjectId === project.id;
            const projectRowClass = [
              project.id === activeProjectId && !activeAgentId
                ? "conversation active"
                : "conversation",
              canDragProject ? "project-draggable" : "",
              projectIsChat ? "chat-project" : "",
              isDraggingProject ? "dragging" : "",
              isProjectDropTarget ? "drag-over" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div
                key={project.id}
                className={`project-group${projectIsChat ? " chat-project-group" : ""}${project.worktreeEnabled ? " worktree-enabled" : ""}`}
              >
                <button
                  className={projectRowClass}
                  draggable={canDragProject}
                  onDragStart={(event) =>
                    handleProjectDragStart(event, project.id)
                  }
                  onDragOver={(event) =>
                    handleProjectDragOver(event, project.id)
                  }
                  onDragLeave={() => handleProjectDragLeave(project.id)}
                  onDrop={(event) => void handleProjectDrop(event, project.id)}
                  onDragEnd={finishProjectDrag}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setProjectMenu({
                      x: event.clientX,
                      y: event.clientY,
                      project,
                    });
                  }}
                  onClick={() => {
                    if (projectDragPreventClickRef.current) return;
                    // 项目节点现在同时承载运行中的 Agent 和历史会话;有任一子项时点击项目行切换展开状态。
                    const wasCollapsed = collapsedProjects.has(project.id);
                    const willBeExpanded = wasCollapsed; // 如果之前折叠,点击后会展开

                    if (hasProjectChildren) {
                      setCollapsedProjects((prev) => {
                        const next = new Set(prev);
                        if (next.has(project.id)) next.delete(project.id);
                        else next.add(project.id);
                        return next;
                      });
                    }

                    // 展开项目时加载会话(如果之前未加载过)
                    if (willBeExpanded && !projectIsChat) {
                      const hasLoadedSessions = sessionsByProject[project.id]?.length > 0;
                      if (!hasLoadedSessions) {
                        void refreshProjectSessions(project.id).catch(() => undefined);
                      }
                    }

                    setActiveProjectId(project.id);
                    setActiveAgentId(undefined);
                  }}
                >
                  <span
                    className={`project-fold${isCollapsed ? " folded" : ""}${hasProjectChildren ? " has-agents" : ""}`}
                    title={
                      isCollapsed
                        ? t("app.projectExpand")
                        : t("app.projectCollapse")
                    }
                  >
                    <Play size={12} />
                  </span>
                  <ProjectAvatar
                    name={projectDirectoryName}
                    kind={projectIsChat ? "chat" : "project"}
                  />
                  <div className="conversation-body">
                    <div className="conversation-title">
                      <strong title={project.path}>
                        {projectDirectoryName}
                      </strong>
                      {(sessionSourceFilter[project.id] ?? null) !== null && (
                        <Filter
                          size={12}
                          className="filter-indicator"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSessionFilterOpen({
                              ...adjustMenuPos(e.clientX, e.clientY, 180, 250),
                              projectId: project.id,
                            });
                          }}
                        />
                      )}
                    </div>
                    {projectIsChat && (
                      <p className="chat-project-guide">
                        {t("app.projectChatGuide")}
                      </p>
                    )}
                  </div>
                  <span className="project-row-actions">
                    <span
                      className="project-action"
                      title={t("app.projectNewAgent")}
                      onClick={(event) => {
                        event.stopPropagation();
                        void createAgent(project.id);
                      }}
                    >
                      <Plus size={14} />
                    </span>
                  </span>
                </button>
                {!isCollapsed && project.worktreeEnabled && (
                  <div className="worktree-children worktree-main-header-only">
                    <button
                      className={`conversation worktree-workspace-header${project.id === activeProjectId && !activeAgentId ? " active" : ""}`}
                      // 点击主工作区 header 等同于选中父项目本身：激活主项目并加载其会话，
                      // 避免与点击父项目行产生行为分歧导致用户迷惑。
                      onClick={() => {
                        setActiveProjectId(project.id);
                        setActiveAgentId(undefined);
                        if (!projectIsChat && !sessionsByProject[project.id]?.length) {
                          void refreshProjectSessions(project.id).catch(() => undefined);
                        }
                      }}
                      title={t("app.worktreeMainWorkspace")}
                    >
                      <span className="worktree-main-branch-icon">
                        <GitBranch size={12} />
                      </span>
                      <div className="conversation-body">
                        <div className="conversation-title">
                          <strong>{t("app.worktreeMainWorkspace")}</strong>
                          <span className="worktree-main-branch">
                            {branchByProject[project.id] ?? t("app.worktreeBranchLoading")}
                          </span>
                        </div>
                      </div>
                    </button>
                  </div>
                )}
                {!isCollapsed &&
                  (projectDisplay.visibleChildren.length > 0 ||
                    projectSessionsLoading ||
                    projectDisplay.hiddenChildCount > 0) && (
                  <div className="session-card">
                    {projectDisplay.visibleChildren.map((child) => {
                    const subagentGroupKey = `${project.id}:${child.key}`;
                    const subagentsExpanded = expandedCodexSubagentGroups.has(subagentGroupKey);
                    const renderCodexSubagents = (subagents: SessionSummary[]) => {
                      if (subagents.length === 0) return null;
                      return (
                        <div className="codex-subagent-sidebar-group">
                          <button
                            type="button"
                            className="codex-subagent-sidebar-toggle"
                            onClick={() => {
                              setExpandedCodexSubagentGroups((current) => {
                                const next = new Set(current);
                                if (next.has(subagentGroupKey)) next.delete(subagentGroupKey);
                                else next.add(subagentGroupKey);
                                return next;
                              });
                            }}
                          >
                            <ChevronDown
                              size={12}
                              className={subagentsExpanded ? "expanded" : ""}
                            />
                            {t("app.codexSubagentCount", { count: subagents.length })}
                          </button>
                          {subagentsExpanded &&
                            subagents.map((subagent) => (
                              <button
                                key={subagent.filePath}
                                className="conversation agent-row session-row codex-subagent-sidebar-row"
                                title={subagent.filePath}
                                onContextMenu={(event) => {
                                  event.preventDefault();
                                  setSessionMenu({
                                    x: event.clientX,
                                    y: event.clientY,
                                    projectId: project.id,
                                    session: subagent,
                                  });
                                }}
                                onClick={() =>
                                  void openSidebarSession(project.id, subagent)
                                }
                              >
                                <div className="conversation-body">
                                  <div className="conversation-title">
                                    <strong>{formatCodexSubagentName(subagent)}</strong>
                                    <span className="session-source-badge codex subagent">
                                      {t("app.codexSubagent")}
                                    </span>
                                  </div>
                                </div>
                              </button>
                            ))}
                        </div>
                      );
                    };
                    if (child.type === "agent") {
                      const agent = child.agent;
                      const isActiveAgent = agent.id === activeAgentId;
                      return (
                        <Fragment key={child.key}>
                        <button
                          className={
                            isActiveAgent
                              ? "conversation agent-row active"
                              : "conversation agent-row"
                          }
                          onContextMenu={async (event) => {
                            event.preventDefault();
                            // 菜单打开时查询 RPC 日志记录状态
                            const logging = await window.piDesktop.rpcLogs.getLogging(agent.id);
                            setAgentRpcLogging((prev) => {
                              const next = new Map(prev);
                              next.set(agent.id, logging);
                              return next;
                            });
                            setAgentMenu({
                              x: event.clientX,
                              y: event.clientY,
                              agent,
                            });
                          }}
                          onClick={() => {
                            setActiveProjectId(project.id);
                            setActiveAgentId(agent.id);
                          }}
                        >
                          <span className="agent-node-marker" aria-hidden="true" />
                          <div className="conversation-body">
                            <div className="conversation-title">
                              {agent.status && (
                                <span className={`agent-status-indicator status-${agent.status}`}>
                                  {t(`app.status${agent.status.charAt(0).toUpperCase() + agent.status.slice(1)}` as any) || agent.status}
                                </span>
                              )}
                              <strong>{agent.title}</strong>
                              {child.source && child.source !== "pi" && (
                                <span className={`session-source-badge ${child.source}`}>
                                  {t(`sessionSource.${child.source}` as any)}
                                </span>
                              )}
                            </div>
                          </div>
                        </button>
                        {renderCodexSubagents(child.codexSubagents)}
                        </Fragment>
                      );
                    }

                    const session = child.session;
                    return (
                      <Fragment key={child.key}>
                      <button
                        className="conversation agent-row session-row"
                        title={session.filePath}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          setSessionMenu({
                            x: event.clientX,
                            y: event.clientY,
                            projectId: project.id,
                            session,
                          });
                        }}
                        onClick={() =>
                          void openSidebarSession(project.id, session)
                        }
                      >
                        <span
                          className="session-node-marker"
                          aria-hidden="true"
                        />
                        <div className="conversation-body">
                          <div className="conversation-title">
                            <strong title={session.name || t("common.untitled")}>
                              {session.name || t("common.untitled")}
                            </strong>
                            {session.source && session.source !== "pi" && (
                              <span className={`session-source-badge ${session.source}`}>
                                {t(`sessionSource.${session.source}` as any)}
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                      {renderCodexSubagents(child.codexSubagents)}
                      </Fragment>
                    );
                  })}
                {!isCollapsed && projectSessionsLoading && (
                  <div className="project-session-loading">
                    {t("app.projectSessionsLoading")}
                  </div>
                )}
                {!isCollapsed && projectDisplay.hiddenChildCount > 0 && (
                  <button
                    className="session-more-row"
                    onClick={() => {
                      setVisibleProjectChildCountByProject((current) => ({
                        ...current,
                        [project.id]:
                          (current[project.id] ?? SIDEBAR_PROJECT_CHILD_PAGE_SIZE) +
                          SIDEBAR_PROJECT_CHILD_PAGE_SIZE,
                      }));
                    }}
                  >
                    <span className="agent-more-branch" />
                    <span>
                      {t("app.projectShowMoreChildren", {
                        count: projectDisplay.hiddenChildCount,
                      })}
                    </span>
                  </button>
                )}
                  </div>
                )}
                {!isCollapsed && project.worktreeEnabled && (
                  <div className="worktree-children worktree-sandbox-list">
                    <div className="worktree-sandbox-toolbar">
                      <span>{t("app.worktreeOtherWorkspaces")}</span>
                      <button
                        className="worktree-create-btn"
                        title={t("app.worktreeNew")}
                        aria-label={t("app.worktreeNew")}
                        onClick={() => {
                          setWorktreeCreateDialog({ projectId: project.id });
                        }}
                      >
                        <GitBranch size={12} />
                        <span>{t("app.worktreeNewShort")}</span>
                      </button>
                    </div>
                    {(() => {
                      // 合并 git worktree 列表和已注册的子项目，确保外部 worktree 也能显示。
                      const wtEntries = worktreesByProject[project.id] ?? [];
                      const childProjects = projects.filter(p => p.worktreeParentId === project.id);
                      const merged = [...wtEntries];
                      for (const cp of childProjects) {
                        if (!merged.some(e => e.path === cp.path)) {
                          merged.push({ path: cp.path, branch: cp.name });
                        }
                      }
                      return merged;
                    })().map((wt) => {
                      const childProject = projects.find(p => p.path === wt.path);
                      const isActive = childProject?.id === activeProjectId;
                      const childAgents = childProject
                        ? filteredAgents.filter((agent) => agent.projectId === childProject.id)
                        : [];
                      const rawChildSessions = childProject ? (sessionsByProject[childProject.id] ?? []) : [];
                      // 已经打开成 Agent 的历史会话不再作为 session 行重复展示，避免同一会话出现两条入口。
                      const childSessions = rawChildSessions.filter(
                        (session) => !childAgents.some((agent) => isSameSessionPath(agent.sessionPath, session.filePath)),
                      );
                      // 默认只展示 3 条会话，展开后显示全部，避免子工作区会话过多时侧栏过长。
                      const sessionsExpanded = expandedWorktreeSessions.has(wt.path);
                      const visibleSessions = sessionsExpanded
                        ? childSessions
                        : childSessions.slice(0, 3);
                      const hiddenSessionCount = childSessions.length - visibleSessions.length;
                      // 取目录名作为副信息，帮助用户区分多个 worktree。
                      const dirName = wt.path.split(/[/\\]/).filter(Boolean).pop() || wt.path;
                      // PiDeck 创建的 worktree 分支使用 pideck/{slug} 命名；侧栏只展示 slug，
                      // 避免同一行同时出现 pideck/test-a 和 test-a 造成信息重复。
                      const displayBranchName = wt.branch.replace(/^pideck\//, "");
                      return (
                        <Fragment key={wt.path}>
                          <button
                            className={`conversation worktree-row${isActive ? " active" : ""}${removingWorktreePaths.has(wt.path) ? " worktree-removing" : ""}`}
                            onClick={() => {
                              if (childProject) {
                                setActiveProjectId(childProject.id);
                                setActiveAgentId(undefined);
                                if (!sessionsByProject[childProject.id]?.length) {
                                  void refreshProjectSessions(childProject.id).catch(() => undefined);
                                }
                              }
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              if (childProject) {
                                setProjectMenu({
                                  x: e.clientX,
                                  y: e.clientY,
                                  project: childProject,
                                });
                              }
                            }}
                            title={wt.path}
                          >
                            <span className="worktree-branch-icon">
                              <GitBranch size={12} />
                            </span>
                            <span className="worktree-branch-name">{displayBranchName}</span>
                            {dirName !== displayBranchName && (
                              <span className="worktree-dir-meta" title={wt.path}>{dirName}</span>
                            )}
                            {childProject && (
                              // 子工作区直接新建 Agent，免去先选中再从别处创建的绕路操作。
                              <span
                                className="project-action worktree-new-agent"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void createAgent(childProject.id);
                                }}
                                title={t("app.projectNewAgent")}
                              >
                                <Plus size={12} />
                              </span>
                            )}
                            {childProject && (
                              <span
                                className="project-action worktree-remove"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  requestRemoveWorktree(project.id, wt.path, childProject);
                                }}
                                title={t("menu.removeProject")}
                              >
                                <Trash2 size={12} />
                              </span>
                            )}
                          </button>
                          {childAgents.map((agent) => (
                            <button
                              key={agent.id}
                              className={agent.id === activeAgentId ? "conversation agent-row worktree-nested-row active" : "conversation agent-row worktree-nested-row"}
                              onContextMenu={async (event) => {
                                event.preventDefault();
                                const logging = await window.piDesktop.rpcLogs.getLogging(agent.id);
                                setAgentRpcLogging((prev) => {
                                  const next = new Map(prev);
                                  next.set(agent.id, logging);
                                  return next;
                                });
                                setAgentMenu({
                                  x: event.clientX,
                                  y: event.clientY,
                                  agent,
                                });
                              }}
                              onClick={() => {
                                setActiveProjectId(agent.projectId);
                                setActiveAgentId(agent.id);
                              }}
                            >
                              <span className="agent-node-marker" aria-hidden="true" />
                              <div className="conversation-body">
                                <div className="conversation-title">
                                  {agent.status && (
                                    <span className={`agent-status-indicator status-${agent.status}`}>
                                      {t(`app.status${agent.status.charAt(0).toUpperCase() + agent.status.slice(1)}` as any) || agent.status}
                                    </span>
                                  )}
                                  <strong>{agent.title}</strong>
                                </div>
                              </div>
                            </button>
                          ))}
                          {visibleSessions.map((session) => (
                            <button
                              key={session.filePath}
                              className="conversation agent-row session-row worktree-nested-row"
                              title={session.filePath}
                              onClick={() => void openSidebarSession(childProject!.id, session)}
                            >
                              <span className="session-node-marker" aria-hidden="true" />
                              <div className="conversation-body">
                                <div className="conversation-title"><strong title={session.name || t("common.untitled")}>{session.name || t("common.untitled")}</strong></div>
                              </div>
                            </button>
                          ))}
                          {hiddenSessionCount > 0 && (
                            <button
                              className="worktree-sessions-more"
                              onClick={() => {
                                setExpandedWorktreeSessions((prev) => {
                                  const next = new Set(prev);
                                  next.add(wt.path);
                                  return next;
                                });
                              }}
                            >
                              {t("app.worktreeShowMoreSessions", { count: hiddenSessionCount })}
                            </button>
                          )}
                        </Fragment>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {!isLanWeb && (
          <div className="toolbar-actions sidebar-bottom-actions">
            <div className="sidebar-bottom-primary-actions">
              <button
                className="icon-button settings-icon"
                title={t("settings.title")}
                onClick={() => setSettingsOpen(true)}
              >
                <Settings size={17} />
              </button>
              <button
                className="icon-button config-icon"
                title={t("config.title")}
                onClick={() => setConfigOpen(true)}
              >
                <Sliders size={17} />
              </button>
              <button
                className="icon-button feedback-icon"
                title={t("feedback.title")}
                onClick={() => setFeedbackOpen(true)}
              >
                <MessageSquare size={17} />
              </button>
              <button
                className="icon-button homepage-icon"
                title={t("app.homepage")}
                onClick={() => api.app.openExternal("https://ayuayue.github.io/PiDeck/")}
              >
                <Globe size={17} />
              </button>
            </div>
            <button
              className="icon-button sidebar-collapse-logo"
              title={
                listCollapsed ? t("app.expandList") : t("app.collapseList")
              }
              onClick={toggleListCollapsed}
            >
              {listCollapsed ? (
                <PanelLeftOpen size={18} strokeWidth={1.9} />
              ) : (
                <PanelLeftClose size={18} strokeWidth={1.9} />
              )}
            </button>
          </div>
        )}
        </div>
      </aside>

      <div
        className="splitter splitter-left"
        onPointerDown={(event) => startResize("list", event)}
      />

      <main
        ref={chatPaneRef}
        className="chat-pane"
        style={{
          "--terminal-row-h": `${terminalRowHeight}px`,
          ...(settings.contentMaxWidth > 0 && settings.contentMaxWidth < 1400
            ? { "--content-max-width": `${settings.contentMaxWidth}px` }
            : undefined),
        } as React.CSSProperties}
      >
        <header ref={chatHeaderRef} className="chat-header">
          <div className="chat-title-block">
            <div className="chat-title-row">
              <strong
                title={activeAgent?.title ?? activeProject?.name ?? "PiDeck"}
              >
                {activeAgent?.title ??
                  (isChatProject(activeProject)
                    ? t("app.chatProject")
                    : activeProject?.name) ??
                  "PiDeck"}
              </strong>
              {activeAgent?.compactionCount ? (
                <span
                  className="compaction-count-badge"
                  title={t("app.compactionTooltip", { count: activeAgent.compactionCount })}
                >
                  {activeAgent.compactionCount}
                </span>
              ) : null}
            </div>
          </div>
          <div
            className={`chat-header-actions${activeAgent?.status === "starting" ? " loading" : ""}`}
          >
            <>
              <SessionStatus
                state={activeRuntimeState}
                duration={
                  activeAgentId
                    ? sessionDurationByAgent[activeAgentId]
                    : undefined
                }
              />
              <div className="header-actions-right">
                <div className="header-action-group branch-group">
                  {!isLanWeb && (
                    <BranchSelector
                      gitInfo={gitInfo}
                      switchingBranch={switchingBranch}
                      onSwitch={switchBranch}
                      onCreateBranch={createBranch}
                    />
                  )}
                </div>
                <div className="header-action-group session-group">
                  <div className="session-combo" ref={sessionComboRef}>
                    <button
                      className="session-combo-trigger"
                      disabled={!activeProjectId || isAgentStarting}
                      title={t("app.newSession")}
                      onClick={() => {
                        if (activeAgentId) {
                          setSessionActionsOpen((open) => !open);
                        } else {
                          createAgent();
                        }
                      }}
                    >
                      <Plus size={14} strokeWidth={2} aria-hidden="true" />
                      <span className="session-combo-label">{t("app.new")}</span>
                      {activeAgentId && (
                        <span className={`session-combo-chevron${sessionActionsOpen ? " open" : ""}`}>
                          <ChevronDown size={12} />
                        </span>
                      )}
                    </button>
                    {appNotice && (
                      <div className="app-notice" role="status">
                        {appNotice.message}
                      </div>
                    )}
                  {sessionActionsOpen && activeAgentId && (
                    <div className="session-combo-menu">
                      <button
                        onClick={() => {
                          createAgent();
                          setSessionActionsOpen(false);
                        }}
                      >
                        <span>{t("app.newSession")}</span>
                      </button>
                      <div className="session-combo-divider" />
                      <button
                        disabled={activeAgent?.status !== "running"}
                        onClick={() => {
                          abortAgent();
                          setSessionActionsOpen(false);
                        }}
                      >
                        {t("app.stop")}
                      </button>
                      {!isLanWeb && (
                        <button
                          disabled={
                            activeAgent?.status === "starting" ||
                            restartingAgentId === activeAgentId
                          }
                          onClick={async () => {
                            if (!activeAgentId || !activeAgent) return;
                            const restartingAgent = activeAgent;
                            setRestartingAgentId(restartingAgent.id);
                            setSessionActionsOpen(false);
                            // 重启会在主进程中短暂移除旧 Agent；这里保留原位置的 starting 占位，避免自动选中同项目下一个 Agent。
                            pendingAgentsRef.current = [
                              ...pendingAgentsRef.current.filter(
                                (agent) => agent.id !== restartingAgent.id,
                              ),
                              {
                                ...restartingAgent,
                                status: "starting",
                                pendingKind: "restart",
                                pendingStartedAt: Date.now(),
                              },
                            ];
                            setPendingAgents(pendingAgentsRef.current);
                            try {
                              const tab =
                                await api.agents.restart(restartingAgent.id);
                              pendingAgentsRef.current = pendingAgentsRef.current.filter(
                                (agent) => agent.id !== restartingAgent.id,
                              );
                              setPendingAgents(pendingAgentsRef.current);
                              setActiveAgentId((current) =>
                                current === restartingAgent.id ? tab.id : current,
                              );
                              setActiveAgentByProject((current) =>
                                current[restartingAgent.projectId] === restartingAgent.id
                                  ? { ...current, [restartingAgent.projectId]: tab.id }
                                  : current,
                              );
                              void refreshRuntimeState(tab.id);
                            } catch (error) {
                              // 重启失败时保留原 Agent 卡片并标记错误，避免用户当前上下文被兜底切走。
                              pendingAgentsRef.current = pendingAgentsRef.current.map(
                                (agent) =>
                                  agent.id === restartingAgent.id
                                    ? { ...agent, status: "error" }
                                    : agent,
                              );
                              setPendingAgents(pendingAgentsRef.current);
                              showToast(error instanceof Error ? error.message : String(error), 5000);
                            } finally {
                              setRestartingAgentId((current) =>
                                current === restartingAgent.id ? null : current,
                              );
                            }
                          }}
                        >
                          {restartingAgentId === activeAgentId
                            ? t("app.restarting")
                            : t("app.restart")}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
              </div>
            </>
          </div>
        </header>

        <section className="message-timeline" ref={timelineRef}>
          {/* 加载更多历史消息按钮 */}
          {hasMoreMessages && activeAgent && activeAgent.status !== "starting" && (
            <div style={{
              display: "flex",
              justifyContent: "center",
              padding: "12px 0",
              borderBottom: "1px solid var(--border-color)"
            }}>
              <button
                onClick={handleLoadMoreMessages}
                disabled={isLoadingMoreMessages}
                style={{
                  padding: "6px 16px",
                  border: "1px solid var(--border-color)",
                  borderRadius: "6px",
                  background: "var(--bg-secondary)",
                  color: "var(--text-primary)",
                  fontSize: "13px",
                  cursor: isLoadingMoreMessages ? "not-allowed" : "pointer",
                  opacity: isLoadingMoreMessages ? 0.6 : 1,
                  transition: "all 0.2s"
                }}
              >
                {isLoadingMoreMessages
                  ? "加载中..."
                  : `加载更多历史消息 (${activeMessages.length - paginatedMessages.length} 条)`
                }
              </button>
            </div>
          )}

          {activeAgent?.status === "starting" && (
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
              <span style={{ paddingTop: "16px", alignSelf: "center", fontSize: "var(--font-size-small)" }}>{t("app.agentStarting")}</span>
            </div>
          )}
          {!activeAgent && (
            <EmptyState
              hasProject={Boolean(activeProjectId)}
              onCreate={() => createAgent()}
            />
          )}
          {activeAgent && activeAgent.status !== "starting" && (
            <div className="message-list">
              {/* 使用 groupToolMessages 渲染：user/error/system 独立条目，
                  assistant + tool 聚合为 agnet-run（TurnRow 自带操作栏） */}
              {renderedRuns.map((item, index) => {
                if (item.kind === "agent-run") {
                  // 判断该 run 是否包含正在流式的消息
                  const isRunStreaming = Boolean(
                    streamingMessageId &&
                    item.items.some(
                      (i) => i.kind === "message" && i.message.id === streamingMessageId,
                    ),
                  );
                  return (
                    <TurnRow
                      key={item.id}
                      run={item}
                      onPreviewImage={setPreviewImage}
                      showThinking={settings.showThinking}
                      isStreaming={isRunStreaming}
                      agentRunning={isAgentBusy && index === renderedRuns.length - 1}
                      onOpenExternal={(url) => api.app.openExternal(url)}
                      onOpenFile={openFilePath}
                      onDiffFile={diffFilePath}
                      onEditMessage={editMessage}
                      onDeleteMessage={deleteMessage}
                      onEnterMultiSelect={() => setMultiSelectOpen(true)}
                    />
                  );
                }
                // 独立消息条目：user / error / system
                // 理论上顶层的 thinking-group / tool-group 不会穿透到此（
                // 它们总是被聚合进 agent-run），但 TypeScript 需要穷举
                if (item.kind !== "message") return null;
                const message = item.message;
                if (message.role === "user") {
                  return (
                    <UserBubble
                      key={message.id}
                      message={message}
                      onPreviewImage={setPreviewImage}
                      onOpenFile={openFilePath}
                      onResendUserMessage={resendUserMessage}
                      onEditMessage={editMessage}
                      onDeleteMessage={deleteMessage}
                      agentRunning={isAgentBusy}
                      isLastUserMessage={message.id === lastUserMessageId}
                      validCommandNames={validCommandNames}
                      validFilePaths={validFilePaths}
                      onEnterMultiSelect={() => setMultiSelectOpen(true)}
                    />
                  );
                }
                if (message.role === "error") {
                  return (
                    <DiagnosticMessageCard key={message.id} message={message} />
                  );
                }
                if (message.role === "system") {
                  const meta = message.meta as any;
                  if (meta?.type === "askQuestion") {
                    return (
                      <AskQuestionCard key={message.id} message={message} onRespond={(response) => {
                        const req = meta.uiRequest;
                        if (!req || !activeAgentId) return;
                        // cancelled 通过 sendUiResponse 正常发送：pi 的 rpc-mode 对
                        // select/input/editor 返回 undefined（卡片显示"已取消"），
                        // confirm 返回 false（同"否"，pi 的 ctx.ui.confirm() 不区分取消和否）
                        if (response.cancelled) {
                          setCancellingUi(true);
                          api.agents.sendUiResponse(activeAgentId, req.requestId, response);
                        } else {
                          api.agents.sendUiResponse(activeAgentId, req.requestId, response);
                        }
                      }} />
                    );
                  }
                  if (meta?.type === "compaction") {
                    return (
                      <CompactionCard key={message.id} message={message} />
                    );
                  }
                  return (
                    <DiagnosticMessageCard key={message.id} message={message} />
                  );
                }
                return null;
              })}
              {isAwaitingAssistant && (
                <>
                  {settings.showThinking && activeThinking && (
                    <section className="thinking-card streaming">
                      <div className="thinking-card-content">{activeThinking}</div>
                    </section>
                  )}
                  {/* 工具执行中但消息尚未到达时，显示临时占位卡片，避免状态指示器亮了但页面空白。
                      runtimeState 在工具消息到达前就已更新 isExecutingTool，存在时序间隙。 */}
                  {activeRuntimeState?.isExecutingTool && !renderedRuns.some(r => r.kind === "agent-run" && r.items.some(i => i.kind === "tool-group")) && (
                    <section className="tool-card tone-info" data-status="running">
                      <div className="tool-card-header">
                        <span className="tool-card-trigger">
                          <span className="tool-card-icon">
                            <Wrench size={14} />
                          </span>
                          <span className="tool-card-name">{t("tool.pending")}</span>
                          <span className="tool-card-status">
                            <span className="tool-card-spinner" aria-hidden="true" />
                            {t("tool.statusRunning")}
                          </span>
                        </span>
                      </div>
                    </section>
                  )}
                </>
              )}
              {/* 状态指示器：agent 运行或流式期间始终与回复并行展示 */}
              {activeAgent && !cancellingUi &&
                (activeAgent.status === "running" || activeRuntimeState?.isStreaming) && (
                <ThinkingIndicator
                  thinking={activeThinking}
                  showThinking={settings.showThinking}
                  isExecutingTool={activeRuntimeState?.isExecutingTool}
                  isStreaming={activeRuntimeState?.isStreaming}
                />
              )}
            </div>
          )}

          {/* 多选分享弹框：会话树 */}
          {multiSelectOpen && (
            <MultiSelectModal renderedRuns={renderedRuns} onClose={() => setMultiSelectOpen(false)} onCopy={handleMultiSelectCopy} />
          )}

          {sessionRefPickerOpen && sessionRefPickerTarget && (
            <SessionReferenceModal
              session={sessionRefPickerTarget}
              initialSelected={
                (() => {
                  const chipRaw = `&${sessionRefPickerTarget.name ?? sessionRefPickerTarget.filePath}`;
                  const saved = sessionRefSelections[chipRaw];
                  return saved?.selectedIndices?.length ? new Set(saved.selectedIndices) : undefined;
                })()
              }
              onClose={() => { setSessionRefPickerOpen(false); setSessionRefPickerTarget(null); }}
              onConfirm={(result: SessionReferenceResult, selectedIndices: number[]) => {
                const chipRaw = `&${result.sessionName}`;
                setSessionRefSelections((prev) => ({
                  ...prev,
                  [chipRaw]: { messages: result.messages, fullContext: result.fullContext, selectedIndices },
                }));
                setSessionRefPickerOpen(false);
                setSessionRefPickerTarget(null);
              }}
              loadMessages={async (fp: string) => api.sessions.readMessages(fp)}
            />
          )}

        </section>

          {showScrollToBottom && (
            <button
              className="scroll-to-bottom-btn"
              // 按钮脱离滚动容器后，由 composer 实际高度 + 终端高度决定 bottom，避免输入框增高或终端打开时遮挡。
              style={{ bottom: Math.max(24, terminalRowHeight + composerOffsetHeight + 18) }}
              onClick={scrollToBottom}
              title={t("app.scrollToBottom")}
            >
              <ChevronDown size={18} />
            </button>
          )}

        {activeAgent && (
        <footer ref={composerRef} className="composer">
          {/* 图片预览作为输入框上方的附件栏,避免占用 textarea 的可输入区域。 */}
          {attachedImages.length > 0 && (
            <div className="image-preview-area">
              {attachedImages.map((img, index) => (
                <div key={index} className="image-preview-item">
                  <img
                    src={`data:${img.mimeType};base64,${img.data}`}
                    alt={t("app.imageAlt", { index: index + 1 })}
                    onClick={() => setPreviewImage(img)}
                    style={{ cursor: "pointer" }}
                  />
                  <button
                    className="image-remove-btn"
                    onClick={() => removeImage(index)}
                    title={t("app.imageRemove")}
                  >
                    <X size={12} strokeWidth={2.4} />
                  </button>
                </div>
              ))}
              <button
                className="image-clear-btn"
                onClick={clearImages}
                title={t("app.clearImagesTitle")}
              >
                {t("app.clearImages")}
              </button>
            </div>
          )}
          {activeAgentId && extensionWidgetsByAgent[activeAgentId] && Object.keys(extensionWidgetsByAgent[activeAgentId]).length > 0 && (() => {
            const entries = Object.entries(extensionWidgetsByAgent[activeAgentId]);
            const widgetSessionKey = getAgentSessionStorageKey(activeAgent, activeAgentId);
            return (
              <div className="extension-widgets-container" key="widgets-container">
                {!widgetsCollapsed && entries.filter(([key]) =>
                  widgetSessionKey && !(agentDismissedWidgets[widgetSessionKey]?.includes(key))
                ).map(([widgetKey, widgetLines]) => (
                  <ExtensionWidgetCard
                    key={widgetKey}
                    widgetKey={widgetKey}
                    lines={widgetLines}
                    sessionIdOrPath={widgetSessionKey}
                    onClose={() => {
                      if (!widgetSessionKey) return;
                      setAgentDismissedWidgets((prev) => {
                        const current = prev[widgetSessionKey] ?? [];
                        if (current.includes(widgetKey)) return prev;
                        const next = { ...prev, [widgetSessionKey]: [...current, widgetKey] };
                        saveDismissedExtensionWidgets(next);
                        return next;
                      });
                    }}
                  />
                ))}
              </div>
            );
          })()}
          <div
            ref={composerBoxRef}
            className={`composer-box ${
              prompt.startsWith("!!")
                ? "shell-silent-mode"
                : prompt.startsWith("!")
                  ? "shell-mode"
                  : currentComposerAgentMode === "plan"
                    ? "plan-mode"
                    : ""
            }`}
            style={{ height: resolvedComposerHeight }}
          >
            <div
              className="composer-resize-handle"
              title={t("app.resizeComposer")}
              onPointerDown={startComposerResize}
            />
            <ComposerToolbar
              state={activeRuntimeState}
              compacting={compacting}
              disabled={isAgentBusy || composerDisabled}
              onPickModel={openModelPicker}
              onPickThinking={() => setThinkingPickerOpen(true)}
              onPickPromptTemplate={openPromptTemplatePicker}
              onCompact={() => compactAgent()}
              composerAgentMode={currentComposerAgentMode}
              onOpenComposerModePicker={() => setComposerModePickerOpen(true)}
              onCancelPlan={() => setCurrentComposerAgentMode("normal")}
              feishuIndicator={
                feishu.bots.length > 0 ? (
                  <FeishuLinkIndicator
                  status={feishu.status}
                  bots={feishu.bots}
                  activeAgentId={activeAgentId}
                  activeBotId={feishu.activeBotId}
                  sessionBotId={sessionFeishuBotId}
                  isConnected={feishu.isConnected}
                  connecting={feishu.connecting}
                  onConnectByBot={feishu.connectByBot}
                  onDisconnect={feishu.disconnect}
                  onSetSessionBot={async (agentId: string, botId: string | null) => {
                    await feishu.setSessionBot(agentId, botId);
                    setSessionFeishuBotId(botId ?? undefined);
                  }}
                  />
                ) : undefined
              }

            />
            <RichInput
              ref={composerTextareaRef}
              value={prompt}
              className={
                prompt.startsWith("!!")
                  ? "bang-bang"
                  : prompt.startsWith("!")
                    ? "bang"
                    : ""
              }
              disabled={composerDisabled}
              validCommandNames={validCommandNames}
              validFilePaths={validFilePaths}
              validSessionRefs={validSessionRefs}
              caretRef={pendingComposerCaretRef}
              placeholder={
                isAgentStarting
                  ? t("app.agentStartingPlaceholder")
                  : !activeAgent
                    ? t("app.composerNoAgentPlaceholder")
                    : prompt.startsWith("!!")
                      ? t("app.composerSilentPlaceholder")
                      : prompt.startsWith("!")
                        ? t("app.composerShellPlaceholder")
                        : currentComposerAgentMode === "plan"
                          ? t("app.composerPlanPlaceholder")
                          : settings.sendShortcut === "enter-send"
                            ? t("app.composerEnterPlaceholder")
                            : t("app.composerShortcutPlaceholder")
              }
              onFocus={() => {
                // 仅当光标处存在 @ / 触发器时才打开建议框,避免聚焦即弹空菜单。
                setSuggestionsOpen(detectTrigger(prompt, composerCursor) !== null);
              }}
              onChange={(newValue, cursor) => {
                setPrompt(newValue);
                setComposerCursor(cursor);
                setSuggestionsOpen(detectTrigger(newValue, cursor) !== null);
                // 如果正在历史导航,检测到用户手动编辑内容则退出历史模式
                if (historyNavigating) {
                  const currentHistoryCommand = commandHistory[historyIndex];
                  if (newValue !== currentHistoryCommand) {
                    setHistoryIndex(-1);
                    setHistoryNavigating(false);
                    setSavedPrompt("");
                  }
                }
              }}
              onCursorChange={(cursor) => {
                setComposerCursor(cursor);
              }}
              onKeyDown={handleComposerKeyDown}
              onPaste={handlePaste}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onBlur={() => {
                setSuggestionsOpen(false);
              }}
              onChipClick={(chip: RichInputChip) => {
                if (chip.kind === "file") { const path = chip.raw.slice(1); openFilePath(path); }
                if (chip.kind === "session") {
                  const s = activeProjectSessions.find((x) => (x.name ?? x.filePath) === chip.label);
                  if (s) { setSessionRefPickerTarget(s); setSessionRefPickerOpen(true); }
                }
              }}
            />
            {suggestionsOpen && !composerDisabled && (
              <PromptSuggestions
                prompt={prompt}
                items={suggestionItems}
                selectedIndex={selectedSuggestionIndex}
                anchorStyle={suggestionAnchorStyle}
                onSelectedIndexChange={setSelectedSuggestionIndex}
                onClose={() => {
                  const el = composerTextareaRef.current;
                  const cursor = el ? getCaretOffsetOf(el) : composerCursor;
                  const result = clearSuggestionTrigger(prompt, cursor);
                  setPrompt(result.text);
                  setComposerCursor(result.cursor);
                  pendingComposerCaretRef.current = result.cursor;
                  setSuggestionsOpen(false);
                  requestAnimationFrame(() => {
                    composerTextareaRef.current?.focus();
                  });
                }}
                onPick={(value) => {
                  const el = composerTextareaRef.current;
                  const cursor = el ? getCaretOffsetOf(el) : composerCursor;
                  const result = applySuggestion(prompt, cursor, value);
                  setPrompt(result.text);
                  setComposerCursor(result.cursor);
                  pendingComposerCaretRef.current = result.cursor;
                  setSuggestionsOpen(false);
                  requestAnimationFrame(() => {
                    composerTextareaRef.current?.focus();
                  });
                }}
              />
            )}
            <div className="composer-footer">
              {composerMode && (
                <span className="composer-mode-status">{composerStatusText}</span>
              )}
              <div className="footer-actions">
                <div className="send-behavior-menu-wrap">
                  {isAgentBusy ? (
                    <button className="btn-circle stop" onClick={() => abortAgent()} title={t("app.stop")}>
                      <Square size={18} strokeWidth={0} fill="currentColor" />
                    </button>
                  ) : (
                    <button
                      disabled={
                        isAgentStarting ||
                        !activeAgentId ||
                        (!prompt.trim() && attachedImages.length === 0)
                      }
                      className="btn-circle send"
                      onClick={sendPrompt}
                      title={t("app.send")}
                    >
                      <ArrowUp size={18} strokeWidth={2.5} />
                    </button>
                  )}
                  {isAgentBusy &&
                    (prompt.trim() || attachedImages.length > 0) && (
                      <button
                        className="send-behavior-toggle"
                        title={t("app.sendBehaviorTitle")}
                        onClick={() => setSendBehaviorMenuOpen((open) => !open)}
                      >
                        <ChevronDown size={14} />
                      </button>
                    )}
                  {sendBehaviorMenuOpen && (
                    <div className="send-behavior-menu">
                      <button onClick={sendPrompt}>
                        <strong>{t("app.sendSteerTitle")}</strong>
                        <span>{t("app.sendSteerDesc")}</span>
                      </button>
                      <button onClick={sendPromptAsFollowUp}>
                        <strong>{t("app.sendFollowUpTitle")}</strong>
                        <span>{t("app.sendFollowUpDesc")}</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </footer>
        )}

        {!isLanWeb && activeAgentId && !isPendingAgentId(activeAgentId) && !settingsOpen && !configOpen && !environmentDialog && terminalDockVisible && (
          <TerminalDock
            key={terminalDockAgentId}
            agentId={activeAgentId}
            open={terminalDockVisible}
            closing={terminalDockClosing}
            collapsed={terminalCollapsed}
            height={terminalHeightByAgent[activeAgentId] ?? 220}
            terminal={api.terminal}
            onCollapsedChange={(collapsed) =>
              setTerminalCollapsedForAgent(activeAgentId, collapsed)
            }
            onHeightChange={(height) =>
              setTerminalHeightByAgent((current) => ({
                ...current,
                [activeAgentId]: height,
              }))
            }
            onClose={() => setTerminalOpenForAgent(activeAgentId, false)}
          />
        )}
      </main>

        {activeAgent && (
          <ConversationOutline
            items={outlineItems}
            onJump={handleOutlineJump}
            extraAction={{
              active: scratchPad.isOpen,
              label: t("scratchPad.openTooltip"),
              onClick: () => scratchPad.toggle(),
              icon: <Pencil size={17} />,
            }}
            terminalAction={{
              active: terminalOpen,
              label: t("app.terminal"),
              onClick: () => {
                if (!activeAgentId) return;
                setTerminalOpenForAgent(activeAgentId, !terminalOpen);
              },
              icon: <Terminal size={17} />,
            }}
            filesAction={{
              active: drawer === "files",
              label: t("app.files"),
              onClick: () => {
                if (drawer === "files" && !drawerCollapsed) {
                  setDrawer(null);
                } else {
                  openDrawer("files");
                  setDrawerCollapsed(false);
                }
              },
              icon: <FolderOpen size={17} />,
            }}
            editorsAction={{
              active: editorsOpen,
              label: t("app.openWithEditor"),
              onClick: (e) => {
                const projectPath =
                  activeAgent?.cwd ||
                  (activeProject && !isChatProject(activeProject)
                    ? activeProject.path
                    : null);
                setEditorsTargetPath(projectPath);
                setEditorsOpen((open) => !open);
                const btn = (e?.currentTarget as HTMLElement)?.closest("button");
                if (btn) {
                  const rect = btn.getBoundingClientRect();
                  setEditorsAnchor(adjustMenuPos(rect.left - 4, rect.top, 220, 280));
                }
              },
              icon: <Code size={17} />,
            }}
            browserAction={{
              active: drawer === "browser",
              label: t("app.browser"),
              onClick: () => {
                if (drawer === "browser" && !drawerCollapsed) {
                  setDrawer(null);
                } else {
                  setDrawer("browser");
                  setDrawerCollapsed(false);
                }
              },
              icon: <Globe size={17} />,
            }}
          />
        )}

      {/* 右侧分隔条常驻 grid 列 4，宽度由 --drawer-splitter-w 驱动（0/6px）；
          关闭/折叠时宽度 0 且 pointer-events:none，避免遮挡会话区。 */}
      <div
        className="splitter splitter-right"
        data-active={drawer && !drawerCollapsed}
        onPointerDown={(event) =>
          drawer && !drawerCollapsed && startResize("drawer", event)
        }
      />
      {/* 抽屉壳常驻 grid 列 5，宽度由 --drawer-col-w 驱动平滑开合；
          收回时保留内容到动画结束，让文字随面板一起被 overflow 裁切。 */}
      <aside
        className="detail-drawer"
        data-open={drawer && !drawerCollapsed}
        data-rendered={Boolean(drawerContentPanel)}
      >
        {editorMode === "drawer" && drawerContentPanel === "editor" && !drawerCollapsed && activeTab ? (
          <Suspense fallback={<div className="drawer-content-frame"><div className="file-diff-loading">Loading...</div></div>}>
            <FileDiffViewer
              displayMode="drawer"
              filePath={activeTab.filePath}
              mode={activeTab.mode}
              onToggleMode={toggleEditorMode}
              originalContent={activeTab.mode === "diff" ? activeTab.originalContent : undefined}
              modifiedContent={activeTab.modifiedContent}
              tabs={editorTabs}
              activeTabId={activeTabId}
              onSelectTab={selectEditorTab}
              onCloseTab={closeEditorTab}
              onClose={() => { setActiveTabId(null); setEditorTabs([]); setDrawer(null); }}
              readContent={readEditorFileContent}
              readOriginalContent={readEditorOriginalContent}
              saveContent={saveEditorFileContent}
              theme={document.documentElement.dataset.theme === "dark" ? "dark" : "light"}
              maxFileSizeMB={settings.maxEditorFileSizeMB}
            />
          </Suspense>
        ) : drawerContentPanel === "browser" && !drawerCollapsed && !browserFullscreen ? (
          <div className="drawer-content-frame">
            <BrowserPanel
              onClose={() => setDrawer(null)}
              onToggleFullscreen={() => setBrowserFullscreen(true)}
            />
          </div>
        ) : drawerContentPanel && drawerContentPanel !== "browser" && drawerContentPanel !== "editor" ? (
          <LazyWrapper
            className="drawer-content-frame"
            enabled={true}
            threshold={0}
            rootMargin="50px"
            placeholder={
              <div style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                height: "100%",
                color: "var(--text-secondary)",
                fontSize: "14px"
              }}>
                加载中...
              </div>
            }
          >
            <DrawerContent
              panel={drawerContentPanel}
              project={drawerContentPanel === "sessions" ? sessionsProject : undefined}
              files={files}
              sessions={(sessionsProjectId && sessionSourceFilter[sessionsProjectId]) ? sessions.filter(
                (s) => !s.parentSessionPath && (sessionSourceFilter[sessionsProjectId]!)!.has(s.source ?? "pi"),
              ).concat(sessions.filter(s => s.parentSessionPath)) : sessions}
              sessionsLoading={sessionHistoryLoading}
              gitChangedFiles={gitChangedFiles}
              expandedDirs={expandedDirs}
              onToggleDirectory={toggleDirectory}
              pinned={drawerPinned}
              onTogglePin={toggleDrawerPinned}
              onCollapse={collapseDrawer}
              onClose={closeDrawer}
              onFileContextMenu={(node, x, y) => setFileMenu({ node, x, y })}
              onRefreshFiles={() => {
                refreshFiles(activeProjectId);
                refreshGitChangedFiles(activeProjectId);
              }}
              onOpenFolder={() => {
                const p = projects.find((p) => p.id === activeProjectId);
                if (p) void api.files.open(p.path);
              }}
              onRefreshSessions={() =>
                refreshSessions(sessionsProjectId ?? activeProjectId)
              }
              onOpenSession={(session) =>
                createAgent(
                  sessionsProjectId ?? activeProjectId,
                  session.filePath,
                  session.name || t("common.untitled"),
                )
              }
              onRenameSession={async (filePath, newName) => {
                await api.sessions.rename(filePath, newName);
                await refreshSessions(sessionsProjectId ?? activeProjectId);
              }}
              onCopySession={(session) =>
                copySession(
                  session.filePath,
                  sessionsProjectId ?? activeProjectId,
                )
              }
              onExportSession={exportHistorySession}
              onDeleteSession={deleteHistorySession}
              onDiffFile={diffFilePath}
              onViewFile={viewFilePath}
              onOpenFile={openFilePath}
            />
          </LazyWrapper>
        ) : null}
      </aside>
      {drawer && drawerCollapsed && (
        <button
          className="drawer-restore"
          title={t("drawer.expandPanel")}
          onClick={() => setDrawerCollapsed(false)}
        >
          <ChevronLeft size={16} />
        </button>
      )}
      {fileMenu && (
        <FileContextMenu
          menu={fileMenu}
          onClose={() => setFileMenu(null)}
          onOpen={() => {
            void api.files.open(fileMenu.node.path);
            setFileMenu(null);
          }}
          onReveal={() => {
            void api.files.showInFolder(fileMenu.node.path);
            setFileMenu(null);
          }}
          onAttach={() => {
            setPrompt(
              (current) =>
                `${current}${current.endsWith(" ") || current.length === 0 ? "" : " "}@${fileMenu.node.relativePath} `,
            );
            setFileMenu(null);
          }}
          onCopyPath={() => {
            void navigator.clipboard.writeText(fileMenu.node.path);
            setFileMenu(null);
          }}
          onRename={() => {
            const node = fileMenu.node;
            setRenamingFile({ path: node.path, name: node.name });
            setRenamingFileInput(node.name);
            setFileMenu(null);
          }}
          onDelete={() => {
            const node = fileMenu.node;
            setFileMenu(null);
            setConfirmDialog({
              title: node.type === "directory" ? t("drawer.deleteFolderTitle") : t("drawer.deleteFileTitle"),
              message: node.type === "directory"
                ? t("drawer.deleteFolderConfirm", { name: node.name })
                : t("drawer.deleteFileConfirm", { name: node.name }),
              danger: true,
              confirmLabel: t("common.delete"),
              onConfirm: async () => {
                setConfirmDialog(null);
                try {
                  await api.files.delete(node.path, true);
                  void refreshFiles();
                } catch (e) {
                  console.error("[File] 删除失败:", e);
                }
              },
            });
          }}
        />
      )}
      {sessionFilterOpen && (() => {
        const currentFilter = sessionSourceFilter[sessionFilterOpen.projectId] ?? null;
        return (
          <div className="context-backdrop" onClick={() => setSessionFilterOpen(null)}>
            <div
              className="context-menu filter-menu"
              style={{
                left: sessionFilterOpen.x,
                top: sessionFilterOpen.y,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="filter-menu-header">{t("menu.filterSessions")}</div>
              <label className="filter-menu-item">
                <input
                  type="checkbox"
                  checked={currentFilter === null}
                  onChange={() =>
                    setSessionSourceFilter((prev) => ({
                      ...prev,
                      [sessionFilterOpen.projectId]: null,
                    }))
                  }
                />
                {t("menu.filterSourceAll")}
              </label>
              {["pi", "codex", "claude", "opencode"].map((source) => (
                <label key={source} className="filter-menu-item">
                  <input
                    type="checkbox"
                    checked={currentFilter !== null && currentFilter.has(source as any)}
                    onChange={() =>
                      toggleSessionSourceFilter(sessionFilterOpen.projectId, source as any)
                    }
                  />
                  <span className={`session-source-badge ${source}`}>
                    {t(`sessionSource.${source}` as any)}
                  </span>
                </label>
              ))}
            </div>
          </div>
        );
      })()}
      {projectMenu && (
        <ProjectContextMenu
          menu={projectMenu}
          onClose={() => setProjectMenu(null)}
          onRevealProject={() => {
            void api.files.showInFolder(projectMenu.project.path);
            setProjectMenu(null);
          }}
          onOpenWithEditor={() => {
            setEditorsTargetPath(projectMenu.project.path);
            setEditorsAnchor(adjustMenuPos(projectMenu.x, projectMenu.y, 220, 280));
            setEditorsOpen(true);
            setProjectMenu(null);
          }}
          onImportCodexSessions={() => openCodexImport(projectMenu.project)}
          onImportClaudeSessions={() => openClaudeImport(projectMenu.project)}
          onImportOpenCodeSessions={() => openOpenCodeImport(projectMenu.project)}
          onManageProjectResources={() => {
            setProjectResourcesProject(projectMenu.project);
            setProjectMenu(null);
          }}
          onManageSessions={() => {
            setSessionManagerProject(projectMenu.project);
            setProjectMenu(null);
            // 确保会话列表已加载
            const pid = projectMenu.project.id;
            if (!(sessionsByProject[pid]?.length)) {
              void refreshProjectSessions(pid);
            }
          }}
          onFilterSessions={() => {
            setSessionFilterOpen({
              ...adjustMenuPos(projectMenu.x, projectMenu.y + 20, 180, 250),
              projectId: projectMenu.project.id,
            });
            setProjectMenu(null);
          }}
          onToggleWorktree={async () => {
            const project = projectMenu.project;
            setProjectMenu(null);
            try {
              const updated = await api.projects.toggleWorktreeEnabled(project.id);
              if (updated) {
                const next = await api.projects.list();
                setProjects(next);
                // 开启后立即扫描并注册已有 worktree
                if (updated.worktreeEnabled) {
                  void refreshWorktrees(updated.id);
                }
              }
            } catch (e) {
              // 后端在非 git 项目启用时抛出 NOT_A_GIT_REPO，给用户明确提示而非静默失败。
              const message = e instanceof Error ? e.message : String(e);
              if (message.includes("NOT_A_GIT_REPO")) {
                showToast(t("app.worktreeNotGitRepo"), 5000);
              } else {
                console.error('Toggle worktree failed', e);
              }
            }
          }}
          onRefreshProject={() => {
            void refreshProjectTree(projectMenu.project);
            setProjectMenu(null);
          }}
          onRemoveProject={async () => {
            const project = projectMenu.project;
            setProjectMenu(null);
            try {
              const next = await api.projects.remove(project.id);
              setProjects(next);
              updateAfterProjectRemoved(project.id, next);
            } catch (e) {
              if (String((e as Error)?.message ?? e).includes("PROJECT_HAS_RUNNING_AGENT")) {
                setConfirmDialog({
                  title: t("app.projectRemoveBlockedTitle"),
                  message: t("app.projectRemoveBlockedByAgent"),
                  confirmLabel: t("app.projectRemoveBlockedAck"),
                  onConfirm: () => setConfirmDialog(null),
                });
              }
            }
          }}
        />
      )}
      {agentMenu && (
        <AgentContextMenu
          menu={agentMenu}
          actionLoading={agentActionLoading}
          onClose={() => {
            if (!agentActionLoading) setAgentMenu(null);
          }}
          onRename={() => openAgentRename(agentMenu.agent)}
          onExport={() => {
            void exportAgentHtml(agentMenu.agent.id);
          }}
          onCopySession={() => {
            void cloneAgentSession(agentMenu.agent.id);
          }}
          onToggleRpcLogging={() => {
            const id = agentMenu.agent.id;
            const current = agentRpcLogging.get(id) ?? false;
            void window.piDesktop.rpcLogs.setLogging(id, !current).then((enabled) => {
              setAgentRpcLogging((prev) => {
                const next = new Map(prev);
                next.set(id, enabled);
                return next;
              });
            });
            setAgentMenu(null);
          }}
          isRpcLogging={agentRpcLogging.get(agentMenu.agent.id) ?? false}
          onOpenLogFile={() => {
            void window.piDesktop.rpcLogs.openFile(agentMenu.agent.id);
            setAgentMenu(null);
          }}
          onOpenSessionFile={() => {
            const path = agentMenu.agent.sessionPath;
            if (path) void api.files.open(path);
            setAgentMenu(null);
          }}
          onCloseAgent={() => {
            void closeAgent(agentMenu.agent.id);
            setAgentMenu(null);
          }}
        />
      )}
      {sessionMenu && (
        <SessionContextMenu
          menu={sessionMenu}
          actionLoading={sessionActionLoading}
          onClose={() => {
            if (!sessionActionLoading) setSessionMenu(null);
          }}
          onRename={() =>
            openSessionRename(sessionMenu.projectId, sessionMenu.session)
          }
          onExport={() => {
            void exportSidebarSession(
              sessionMenu.projectId,
              sessionMenu.session,
            );
          }}
          onCopySession={() => {
            void copySidebarSession(sessionMenu.projectId, sessionMenu.session);
          }}
          // 历史会话的 RPC 日志在 agent 启动后再通过右键菜单开启记录
          onOpenSessionFile={() => {
            void api.files.open(sessionMenu.session.filePath);
            setSessionMenu(null);
          }}
          onDeleteSession={() => {
            const session = sessionMenu.session;
            setSessionMenu(null);
            void deleteHistorySession(session);
          }}
        />
      )}
      {sessionManagerProject && (
        <SessionManagerModal
          sessions={sessionsByProject[sessionManagerProject.id] ?? []}
          onClose={() => setSessionManagerProject(null)}
          onRename={(session) => {
            setSessionManagerProject(null);
            openSessionRename(sessionManagerProject.id, session);
          }}
          onExport={(session) => {
            setSessionManagerProject(null);
            void exportHistorySession(session);
          }}
          onDelete={async (sessions) => {
            for (const session of sessions) {
              await api.sessions.delete(session.filePath);
            }
            showToast(t("app.sessionDeleted"), 2200);
            const projectId = sessionManagerProject.id;
            await refreshSessions(projectId);
            await refreshProjectSessions(projectId);
          }}
        />
      )}
      {projectResourcesProject && (
        <Suspense fallback={null}>
          <ProjectResourcesModal
            project={projectResourcesProject}
            onClose={() => setProjectResourcesProject(null)}
          />
        </Suspense>
      )}
      {(agentRenameTarget || sessionRenameTarget) && (
        <div
          className="modal-backdrop rename-dialog-backdrop"
          onClick={() => {
            if (!agentRenaming) {
              setAgentRenameTarget(null);
              setSessionRenameTarget(null);
            }
          }}
        >
          <form
            className="rename-dialog"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => {
              event.preventDefault();
              if (agentRenameTarget) void submitAgentRename();
              else void submitSessionRename();
            }}
          >
            <div className="rename-dialog-header">
              <strong>{t("app.renameSessionTitle")}</strong>
              <button
                type="button"
                disabled={agentRenaming}
                onClick={() => {
                  setAgentRenameTarget(null);
                  setSessionRenameTarget(null);
                }}
              >
                <X size={15} />
              </button>
            </div>
            <input
              autoFocus
              value={agentRenameValue}
              onChange={(event) => setAgentRenameValue(event.target.value)}
              placeholder={t("app.renameSessionPlaceholder")}
              disabled={agentRenaming}
            />
            <div className="rename-dialog-actions">
              <button
                type="button"
                disabled={agentRenaming}
                onClick={() => {
                  setAgentRenameTarget(null);
                  setSessionRenameTarget(null);
                }}
              >
                {t("common.cancel")}
              </button>
              <button type="submit" disabled={agentRenaming}>
                {agentRenaming ? t("common.saving") : t("common.save")}
              </button>
            </div>
          </form>
        </div>
      )}


      {worktreeCreateDialog && (
        <WorktreeCreateDialog
          projectId={worktreeCreateDialog.projectId}
          creating={worktreeCreating}
          onCreate={async (branchName) => {
            try {
              await createWorktree(worktreeCreateDialog.projectId, branchName);
              setWorktreeCreateDialog(null);
            } catch {
              // createWorktree 内部已通过 toast 反馈错误，这里只阻止关闭弹框，
              // 便于用户修改名称后重试。
            }
          }}
          onClose={() => setWorktreeCreateDialog(null)}
        />
      )}
      {environmentDialog && (
        <EnvironmentDialog
          status={piStatus}
          checking={piChecking}
          onClose={() => {
            setEnvironmentDialog(false);
            setCustomPathResult(null);
            // 关闭时重置安装状态
            setInstallResult(null);
            setInstallCompleted(false);
            setNpmAvailable(null);
          }}
          onRecheck={() => {
            setCustomPathResult(null);
            setNpmAvailable(null);
            setNpmVersion(undefined);
            setInstallResult(null);
            setInstallCompleted(false);
            setInstallUseMirror(false);
            checkPiInstall("manual");
          }}
          onOpenInstallDocs={() =>
            api.app.openExternal(
              "https://pi.dev/docs/latest/quickstart#install",
            )
          }
          customPath={customPiPath}
          customPathValidating={customPathValidating}
          customPathResult={customPathResult}
          onCustomPathChange={(path) => {
            setCustomPiPath(path);
            setCustomPathResult(null);
          }}
          onValidateCustomPath={() =>
            validateCustomPiPath({ closeDialogOnSuccess: true })
          }
          npmAvailable={npmAvailable}
          npmVersion={npmVersion}
          npmChecking={npmChecking}
          installCommand={installCommand}
          installUseMirror={installUseMirror}
          installExecuting={installExecuting}
          installResult={installResult}
          installCompleted={installCompleted}
          onCheckNpm={checkNpm}
          onInstallCommandChange={(cmd) => {
            setInstallCommand(cmd);
            setInstallResult(null);
            setInstallCompleted(false);
          }}
          onToggleInstallMirror={() => {
            setInstallUseMirror((prev) => {
              // 切换镜像，同时更新命令文本
              if (prev) {
                // 移除镜像
                setInstallCommand((cmd) =>
                  cmd.replace(
                    /\s+--registry=https:\/\/registry\.npmmirror\.com/g,
                    "",
                  ),
                );
              } else {
                // 添加镜像
                setInstallCommand((cmd) =>
                  cmd.includes("--registry=")
                    ? cmd
                    : cmd + " --registry=https://registry.npmmirror.com",
                );
              }
              return !prev;
            });
            setInstallResult(null);
            setInstallCompleted(false);
          }}
          onExecInstall={execInstallCommand}
          onRestartApp={() => api.app.restart()}
          onClearCheckFlag={async () => {
            await api.settings.update({ piEnvironmentChecked: false });
            showToast(t("environment.checkFlagCleared"));
          }}
        />
      )}
      {promptTemplatePickerOpen && (
        <PromptTemplatePicker
          templates={promptTemplateList}
          onClose={() => setPromptTemplatePickerOpen(false)}
          onPick={selectPromptTemplate}
        />
      )}
      {modelPickerOpen && (
        <ModelPicker
          models={availableModels}
          current={{
            provider: activeRuntimeState?.provider,
            modelId: activeRuntimeState?.modelId,
            modelName: activeRuntimeState?.modelName,
          }}
          onClose={() => setModelPickerOpen(false)}
          onPick={selectModel}
          favoriteModels={settings.favoriteModels}
          onToggleFavorite={toggleFavoriteModel}
        />
      )}
      {composerModePickerOpen && (
        <ComposerModePicker
          currentMode={currentComposerAgentMode}
          onClose={() => setComposerModePickerOpen(false)}
          onPick={(mode) => {
            setCurrentComposerAgentMode(mode);
            setComposerModePickerOpen(false);
          }}
        />
      )}
      {thinkingPickerOpen && (
        <ThinkingPicker
          current={activeRuntimeState?.thinkingLevel}
          onClose={() => setThinkingPickerOpen(false)}
          onPick={selectThinking}
        />
      )}
      {settingsOpen && (
        <Suspense fallback={null}>
        <SettingsModal
          settings={settings}
          piStatus={piStatus}
          piChecking={piChecking}
          piProxyChecking={piProxyChecking}
          piProxyNotice={piProxyNotice}
          piProxyNoticeTone={piProxyNoticeTone}
          webServiceChanging={webServiceChanging}
          appInfo={appInfo}
          customPiPath={customPiPath}
          customPathValidating={customPathValidating}
          customPathResult={customPathResult}
          updateChecking={updateChecking}
          piUpdating={piUpdating}
          piUpdateChecking={piUpdateChecking}
          piUpdateCheck={piUpdateCheck}
          piUpdateResult={piUpdateResult}
          onCustomPathChange={(path) => {
            setCustomPiPath(path);
            setCustomPathResult(null);
          }}
          onValidateCustomPath={() => validateCustomPiPath()}
          onClearCustomPath={clearCustomPiPath}
          onCheckPi={checkPiInstallInline}
          onTestPiProxy={() => testPiProxy()}
          onCheckUpdate={() => checkAppUpdate("manual")}
          onCheckPiUpdate={checkPiCliUpdate}
          onUpdatePi={updatePiCli}
          onToggleDevTools={async () => {
            const opened = await api.app.toggleDevTools();
            showToast(
              opened ? t("app.devToolsOpened") : t("app.devToolsClosed"),
            );
          }}
          onRestartApp={() => api.app.restart()}
          onClearCheckFlag={async () => {
            await api.settings.update({ piEnvironmentChecked: false });
            showToast(t("environment.checkFlagCleared"));
          }}
          onOpenWebService={(port) =>
            api.app.openExternal(`http://127.0.0.1:${port}`)
          }
          onClose={() => {
            setSettingsOpen(false);
          }}
          onChange={updateSettings}
        />
      </Suspense>
      )}
      {feedbackOpen && (
        <FeedbackModal
          project={activeProject}
          appInfo={appInfo}
          onClose={() => setFeedbackOpen(false)}
          onCopy={() => showToast(t("app.feedbackCopied"))}
          onOpenExternal={(url) => api.app.openExternal(url)}
          loadEnvironment={api.app.feedbackEnvironment}
        />
      )}
      {updateInfo && (
        <UpdateModal
          info={updateInfo}
          checking={updateChecking}
          downloading={updateDownloading}
          progress={updateProgress}
          downloadedPath={downloadedUpdatePath}
          onClose={() => setUpdateInfo(null)}
          onOpenRelease={() => api.app.openExternal(updateInfo.releaseUrl)}
          onDownload={() => void downloadAppUpdate()}
          onInstall={() => void installDownloadedAppUpdate()}
          onBrowserDownload={() =>
            api.app.openExternal(
              updateInfo.recommendedAsset?.url ?? updateInfo.releaseUrl,
            )
          }
        />
      )}
      {updateError && (
        <Suspense fallback={null}>
        <UpdateErrorModalLazy
          message={updateError}
          releasesUrl={appInfo.releasesUrl}
          onClose={() => setUpdateError(null)}
          onOpenRelease={() => api.app.openExternal(appInfo.releasesUrl)}
        />
      </Suspense>
      )}
      {upToDateVersion && (
        <Suspense fallback={null}>
        <UpToDateModalLazy
          version={upToDateVersion}
          releasesUrl={appInfo.releasesUrl}
          onClose={() => setUpToDateVersion(null)}
          onOpenRelease={() => api.app.openExternal(appInfo.releasesUrl)}
        />
      </Suspense>
      )}
      {editorMode === "modal" && activeTab && (
        <Suspense fallback={<div className="modal-backdrop"><span className="file-diff-loading">Loading...</span></div>}>
        <FileDiffViewer
          displayMode="modal"
          filePath={activeTab.filePath}
          mode={activeTab.mode}
          onToggleMode={toggleEditorMode}
          originalContent={activeTab.mode === "diff" ? activeTab.originalContent : undefined}
          modifiedContent={activeTab.modifiedContent}
          tabs={editorTabs}
          activeTabId={activeTabId}
          onSelectTab={selectEditorTab}
          onCloseTab={closeEditorTab}
          onClose={() => { setActiveTabId(null); setEditorTabs([]); }}
          readContent={readEditorFileContent}
          readOriginalContent={readEditorOriginalContent}
          saveContent={saveEditorFileContent}
          theme={document.documentElement.dataset.theme === "dark" ? "dark" : "light"}
          maxFileSizeMB={settings.maxEditorFileSizeMB}
        />
      </Suspense>
      )}
      {previewImage && (
        <ImagePreviewModal
          image={previewImage}
          onClose={() => setPreviewImage(null)}
        />
      )}
      {codexImportProject && (
        <Suspense fallback={null}>
        <CodexImportModal
          project={codexImportProject}
          sessions={codexImportSessions}
          selectedPaths={codexImportSelected}
          loading={codexImportLoading}
          importing={codexImportRunning}
          report={codexImportReport}
          onClose={() => {
            setCodexImportProject(null);
            setCodexImportReport(null);
          }}
          onRefresh={() => scanCodexSessions()}
          onToggle={toggleCodexSession}
          onToggleAll={toggleAllCodexSessions}
          onImport={importCodexSessions}
        />
      </Suspense>
      )}
      {claudeImportProject && (
        <Suspense fallback={null}>
        <ClaudeImportModal
          project={claudeImportProject}
          sessions={claudeImportSessions}
          selectedPaths={claudeImportSelected}
          loading={claudeImportLoading}
          importing={claudeImportRunning}
          report={claudeImportReport}
          onClose={() => {
            setClaudeImportProject(null);
            setClaudeImportReport(null);
          }}
          onRefresh={() => scanClaudeSessions()}
          onToggle={toggleClaudeSession}
          onToggleAll={toggleAllClaudeSessions}
          onImport={importClaudeSessions}
        />
      </Suspense>
      )}
      {openCodeImportProject && (
        <Suspense fallback={null}>
        <OpenCodeImportModal
          project={openCodeImportProject}
          sessions={openCodeImportSessions}
          selectedPaths={openCodeImportSelected}
          loading={openCodeImportLoading}
          importing={openCodeImportRunning}
          report={openCodeImportReport}
          onClose={() => {
            setOpenCodeImportProject(null);
            setOpenCodeImportReport(null);
          }}
          onRefresh={() => scanOpenCodeSessions()}
          onToggle={toggleOpenCodeSession}
          onToggleAll={toggleAllOpenCodeSessions}
          onImport={importOpenCodeSessions}
        />
      </Suspense>
      )}
      <Suspense fallback={null}>
      <ConfigModal
        open={configOpen}
        onClose={() => setConfigOpen(false)}
        onSaved={() => {
          // 配置保存后不再自动 reload,用户可通过 Restart 按钮手动重载
        }}
      />
      </Suspense>

      {confirmDialog && (
        <ConfirmDialog
          title={confirmDialog.title}
          message={confirmDialog.message}
          danger={confirmDialog.danger}
          confirmLabel={confirmDialog.confirmLabel}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}

      {trustRequest && (
        <TrustConfirmModal
          cwd={trustRequest.cwd}
          projectName={trustRequest.projectName}
          onChoose={(choice) => {
            api.agents.respondTrustRequest(trustRequest.requestId, choice);
            setTrustRequest(null);
          }}
        />
      )}

      {renamingFile && (
        <div className="config-modal-overlay" onClick={() => setRenamingFile(null)}>
          <div className="config-modal-dialog" onClick={(e) => e.stopPropagation()}>
            <strong>{t("drawer.renameTitle")}</strong>
            <div style={{ margin: "12px 0" }}>
              <input
                type="text"
                value={renamingFileInput}
                onChange={(e) => setRenamingFileInput(e.target.value)}
                className="config-input"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const path = renamingFile.path;
                    const newName = renamingFileInput.trim();
                    if (newName && newName !== renamingFile.name) {
                      void api.files.rename(path, newName).then(() => {
                        void refreshFiles();
                        setRenamingFile(null);
                      }).catch((err) => console.error("[File] 重命名失败:", err));
                    } else {
                      setRenamingFile(null);
                    }
                  }
                  if (e.key === "Escape") setRenamingFile(null);
                }}
              />
            </div>
            <div className="config-modal-actions">
              <button className="config-btn" onClick={() => setRenamingFile(null)}>
                {t("common.cancel")}
              </button>
              <button
                className="config-btn primary"
                onClick={() => {
                  const path = renamingFile.path;
                  const newName = renamingFileInput.trim();
                  if (newName && newName !== renamingFile.name) {
                    void api.files.rename(path, newName).then(() => {
                      void refreshFiles();
                      setRenamingFile(null);
                    }).catch((err) => console.error("[File] 重命名失败:", err));
                  } else {
                    setRenamingFile(null);
                  }
                }}
              >
                {t("common.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Scratch Pad（草稿本）：根级渲染，避免受 chat-pane grid 影响定位 */}
      {scratchPad.isOpen || scratchPad.isClosing ? (
        <div className={`scratch-pad-overlay${scratchPad.isClosing ? " closing" : ""}`} onClick={() => scratchPad.close()}>
          <ScratchPadPanel
            drafts={scratchPad.drafts}
            currentDraftPath={scratchPad.currentDraftPath}
            content={scratchPad.content}
            mode={scratchPad.mode}
            isClosing={scratchPad.isClosing}
            isSaving={scratchPad.isSaving}
            hasError={scratchPad.hasError}
            onChangeContent={scratchPad.setContent}
            onSetMode={scratchPad.setMode}
            onToggleCheckbox={scratchPad.toggleTaskCheckbox}
            onExport={() => void scratchPad.exportFile()}
            onSelectDraft={scratchPad.selectDraft}
            onCreateDraft={scratchPad.createDraft}
            onDeleteDraft={scratchPad.deleteDraft}
          />
        </div>
      ) : null}

      {/* 外部编辑器选择气泡 */}
      {editorsOpen && editorsAnchor && (
        <div
          ref={editorsRef}
          className="editors-popover"
          style={{
            position: "fixed",
            left: editorsAnchor.x,
            top: editorsAnchor.y,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {externalEditors.length === 0 ? (
            <div className="editors-popover-empty">{t("app.noExternalEditors")}</div>
          ) : (
            externalEditors.map((editor) => (
              <button
                key={editor.id}
                className="editors-popover-item"
                onClick={() => {
                  const projectPath = editorsTargetPath;
                  if (projectPath) {
                    void api.editors.openProject(editor, projectPath).catch((error) => {
                      showToast(
                        t("app.openEditorFailed", {
                          error: error instanceof Error ? error.message : String(error),
                        }),
                        3000,
                      );
                    });
                  }
                  setEditorsOpen(false);
                  setEditorsAnchor(null);
                  setEditorsTargetPath(null);
                }}
              >
                <span className={`editor-logo ${editor.id}`}>
                  {getEditorLogoUrl(editor.id) ? (
                    <img src={getEditorLogoUrl(editor.id)} alt="" />
                  ) : (
                    editor.id.slice(0, 2).toUpperCase()
                  )}
                </span>
                <span>{editor.name}</span>
              </button>
            ))
          )}
        </div>
      )}

      {/* 浏览器全屏覆盖层 */}
      {browserFullscreen && (
        <div className="modal-backdrop" onClick={() => setBrowserFullscreen(false)}>
          <div className="browser-modal" onClick={(e) => e.stopPropagation()}>
            <BrowserPanel
              isFullscreen
              onClose={() => setBrowserFullscreen(false)}
              onMinimize={() => {
                setBrowserFullscreen(false);
                setDrawer("browser");
                setDrawerCollapsed(false);
              }}
            />
          </div>
        </div>
      )}

    {/* ask_question 弹出 dialog - 仅在 pi 通过 extension_ui_request 发送交互请求时显示 */}
    {showAskDialog && activeUiAsk && (
      <div className="modal-backdrop" onClick={undefined}>
        <div className="ask-dialog" onClick={(e) => e.stopPropagation()}>
          <div className="ask-dialog-header">
            <MessageCircle size={16} />
            <span>{t("ask.toolName")}</span>
            {/* 关闭按钮：点击后取消当前请求，select 类型会提示模型默认选第一项 */}
            <button
              className="ask-dialog-close-btn"
              title={t("common.close")}
              onClick={() => {
                const isSelect = activeUiAsk.method === "select" && Array.isArray(activeUiAsk.options) && activeUiAsk.options.length > 0;
                if (isSelect) {
                  showToast(t("ask.cancelHint"));
                }
                if (activeUiAsk.requestId && activeAgentId) {
                  api.agents.sendUiResponse(activeAgentId, activeUiAsk.requestId, { cancelled: true });
                }
              }}
            >
              <X size={14} />
            </button>
          </div>
          <div className="ask-dialog-question">{activeUiAsk.title || t("ask.pending")}</div>
          {activeUiAsk.method === "confirm" ? (
            <div className="ask-dialog-options ask-dialog-options-confirm">
              <button
                className="ask-dialog-option"
                onClick={() => {
                  if (activeUiAsk.requestId && activeAgentId) {
                    api.agents.sendUiResponse(activeAgentId, activeUiAsk.requestId, { confirmed: true });
                  }
                }}
              >
                {t("common.true")}
              </button>
              <button
                className="ask-dialog-option"
                onClick={() => {
                  if (activeUiAsk.requestId && activeAgentId) {
                    api.agents.sendUiResponse(activeAgentId, activeUiAsk.requestId, { confirmed: false });
                  }
                }}
              >
                {t("common.false")}
              </button>
            </div>
          ) : activeUiAsk.options && activeUiAsk.options.length > 0 ? (
            <div className="ask-dialog-options">
              {/* 过滤掉 Pi 自带的 "✎ 自行输入..." 选项，用下方内联输入框替代 */}
              {activeUiAsk.options.filter((opt) => {
                const label = typeof opt === "string" ? opt : String((opt as any).label ?? opt);
                return !label.startsWith("✎");
              }).map((opt, i) => {
                const val = typeof opt === "string" ? opt : String((opt as any).value ?? (opt as any).label ?? opt);
                const label = typeof opt === "string" ? opt : (opt as any).label ?? val;
                return (
                  <button
                    key={i}
                    className="ask-dialog-option"
                    onClick={() => {
                      if (activeUiAsk.requestId && activeAgentId) {
                        api.agents.sendUiResponse(activeAgentId, activeUiAsk.requestId, { value: val });
                      }
                    }}
                  >
                    <span className="ask-dialog-option-marker">{label}</span>
                  </button>
                );
              })}
              <div className="ask-dialog-custom-input">
                <input
                  id="ask-dialog-custom-field"
                  className="ask-dialog-custom-field"
                  placeholder={t("ask.customPlaceholder")}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const el = document.getElementById("ask-dialog-custom-field") as HTMLInputElement | null;
                      const val = el?.value?.trim() ?? "";
                      if (val && activeUiAsk.requestId && activeAgentId) {
                        /* 保存自定义值到 ref，选择 "✎ 自行输入..." 让 Pi 走 input 流 */
                        pendingCustomInputRef.current = val;
                        api.agents.sendUiResponse(activeAgentId, activeUiAsk.requestId, { value: "✎ 自行输入..." });
                      }
                    }
                  }}
                />
                <button
                  type="button"
                  className="ask-dialog-submit-btn"
                  onClick={() => {
                    const el = document.getElementById("ask-dialog-custom-field") as HTMLInputElement | null;
                    const val = el?.value?.trim() ?? "";
                    if (val && activeUiAsk.requestId && activeAgentId) {
                      /* 保存自定义值到 ref，选择 "✎ 自行输入..." 让 Pi 走 input 流 */
                      pendingCustomInputRef.current = val;
                      api.agents.sendUiResponse(activeAgentId, activeUiAsk.requestId, { value: "✎ 自行输入..." });
                    }
                  }}
                >
                  {t("common.submit")}
                </button>
              </div>
            </div>
          ) : activeUiAsk.method === "input" || activeUiAsk.method === "editor" ? (
            <div className="ask-dialog-input-area">
              <input
                id="ask-dialog-input"
                className="ask-dialog-input"
                placeholder={activeUiAsk.placeholder || ""}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && activeUiAsk.requestId && activeAgentId) {
                    const value = (e.target as HTMLInputElement).value;
                    api.agents.sendUiResponse(activeAgentId, activeUiAsk.requestId, { value });
                  }
                }}
              />
              <button
                className="ask-dialog-submit-btn"
                onClick={() => {
                  const value = (document.getElementById("ask-dialog-input") as HTMLInputElement)?.value ?? "";
                  if (activeUiAsk.requestId && activeAgentId) {
                    api.agents.sendUiResponse(activeAgentId, activeUiAsk.requestId, { value });
                  }
                }}
              >
                {t("common.submit")}
              </button>
            </div>

          ) : null}
          {/* select 类型取消提示 */}
          {activeUiAsk.method === "select" && Array.isArray(activeUiAsk.options) && activeUiAsk.options.length > 0 && (
            <div className="ask-dialog-cancel-hint">
              <Info size={12} />
              <span>{t("ask.cancelHint")}</span>
            </div>
          )}
        </div>
      </div>
    )}
    </div>
  );
}

function FeedbackModal({
  project,
  appInfo,
  onClose,
  onCopy,
  onOpenExternal,
  loadEnvironment,
}: {
  project?: Project;
  appInfo: AppInfo;
  onClose: () => void;
  onCopy: () => void;
  onOpenExternal: (url: string) => Promise<void>;
  loadEnvironment: () => Promise<FeedbackEnvironment>;
}) {
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState("");
  const [environment, setEnvironment] = useState<FeedbackEnvironment | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    loadEnvironment()
      .then((next) => {
        if (!cancelled) setEnvironment(next);
      })
      .catch((reason) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadEnvironment]);

  const report = buildFeedbackReport({
    description,
    steps,
    project,
    environment,
    fallbackVersion: appInfo.version,
    environmentError: error,
  });

  // 从用户描述中提取简短摘要作为 issue 标题的一部分
  const descriptionSummary = description.trim().split('\n')[0].slice(0, 60);
  const issueTitle = descriptionSummary
    ? `${t("feedback.issueTitle")}${descriptionSummary}`
    : t("feedback.issueTitle") + t("feedback.issueTitleEmpty");
  const issueUrl = `https://github.com/ayuayue/pi-desktop/issues/new?title=${encodeURIComponent(issueTitle)}&body=${encodeURIComponent(report)}`;
  const authorUrl = "https://github.com/ayuayue";

  async function copyReport() {
    await navigator.clipboard.writeText(report);
    onCopy();
  }

  return (
    <div className="modal-backdrop feedback-backdrop" onClick={onClose}>
      <section
        className="feedback-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header feedback-header">
          <div>
            <strong>{t("feedback.title")}</strong>
            <small>
              {t("feedback.intro")}{" "}
              <strong className="feedback-email">chat@caoayu.eu.org</strong>
            </small>
            <small className="feedback-qq">
              QQ 群：<strong>1026218644</strong>
            </small>
          </div>
          <CloseIconButton label={t("common.close")} onClick={onClose} />
        </div>
        <div className="feedback-body">
          <div className="feedback-form-section">
            <div className="feedback-section-header">
              <strong>{t("feedback.descriptionLabel")}</strong>
              <small>{t("feedback.descriptionHint")}</small>
            </div>
            <textarea
              className="feedback-textarea"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t("feedback.descriptionPlaceholder")}
            />
            <div className="feedback-section-header">
              <strong>{t("feedback.stepsLabel")}</strong>
              <small>{t("feedback.stepsHint")}</small>
            </div>
            <textarea
              className="feedback-textarea"
              value={steps}
              onChange={(event) => setSteps(event.target.value)}
              placeholder={t("feedback.stepsPlaceholder")}
            />
          </div>
          <div className="feedback-environment-section">
            <div className="feedback-section-header">
              <strong>{t("feedback.environmentTitle")}</strong>
              <small>
                {loading
                  ? t("feedback.reportLoading")
                  : t("feedback.environmentHint")}
              </small>
            </div>
            <pre className="feedback-environment-content">{report}</pre>
          </div>
        </div>
        <div className="feedback-actions">
          <button onClick={copyReport}>{t("feedback.copyReport")}</button>
          <button onClick={() => onOpenExternal(authorUrl)}>
            {t("feedback.authorGithub")}
          </button>
          <button className="primary" onClick={() => onOpenExternal(issueUrl)}>
            {t("feedback.openIssue")}
          </button>
        </div>
      </section>
    </div>
  );
}

function buildFeedbackReport(input: {
  description: string;
  steps: string;
  project?: Project;
  environment: FeedbackEnvironment | null;
  fallbackVersion: string;
  environmentError: string;
}) {
  const pi = input.environment?.pi;
  const projectPath = input.project?.path
    ? maskHomePath(input.project.path)
    : t("feedback.report.projectNone");
  // 反馈报告刻意只展示脱敏路径和运行时版本,避免把用户 home 目录、API key 或会话内容默认发出去。
  return [
    t("feedback.report.description"),
    input.description.trim() || t("feedback.report.descriptionEmpty"),
    "",
    t("feedback.report.steps"),
    input.steps.trim() || t("feedback.report.stepsEmpty"),
    "",
    t("feedback.report.environment"),
    t("feedback.report.piDesktop", {
      value: input.environment?.appVersion ?? input.fallbackVersion,
    }),
    t("feedback.report.system", {
      value: input.environment
        ? `${input.environment.platform} ${input.environment.arch}`
        : t("feedback.report.readFailed"),
    }),
    t("feedback.report.electron", {
      value: input.environment?.electronVersion ?? "-",
    }),
    t("feedback.report.chrome", {
      value: input.environment?.chromeVersion ?? "-",
    }),
    t("feedback.report.node", { value: input.environment?.nodeVersion ?? "-" }),
    t("feedback.report.project", { value: projectPath }),
    t("feedback.report.piStatus", {
      value: pi
        ? pi.installed
          ? t("feedback.report.piDetected")
          : t("feedback.report.piMissing")
        : t("feedback.report.readFailed"),
    }),
    t("feedback.report.piCommand", {
      value: pi?.command ? maskHomePath(pi.command) : "-",
    }),
    t("feedback.report.piVersion", { value: pi?.version || "-" }),
    ...(pi?.error ? [t("feedback.report.piError", { value: pi.error })] : []),
    ...(input.environmentError
      ? [
          t("feedback.report.environmentError", {
            value: input.environmentError,
          }),
        ]
      : []),
  ].join("\n");
}

function maskHomePath(value: string) {
  return value
    .replace(/([A-Z]:\\Users\\)[^\\/]+/gi, "$1<user>")
    .replace(/(\/Users\/)[^/]+/g, "$1<user>");
}

function formatUpdateBytes(bytes?: number) {
  if (!bytes || bytes <= 0) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`;
}

function UpdateModal(props: {
  info: AppUpdateInfo;
  checking: boolean;
  downloading: boolean;
  progress: AppUpdateDownloadProgress | null;
  downloadedPath: string | null;
  onClose: () => void;
  onDownload: () => void;
  onInstall: () => void;
  onBrowserDownload: () => void;
  onOpenRelease: () => void;
}) {
  const progressPercent = props.progress?.percent ?? 0;
  return (
    <div className="modal-backdrop update-backdrop">
      <section className="update-modal">
        <div className="modal-header">
          <strong>
            {t("update.availableTitle", { version: props.info.latestVersion })}
          </strong>
          <CloseIconButton label={t("common.close")} onClick={props.onClose} />
        </div>
        <div className="update-body">
          <p className="update-version-line">
            {t("update.currentLatest", {
              current: props.info.currentVersion,
              latest: props.info.latestVersion,
            })}
          </p>
          {props.info.recommendedAsset && (
            <p className="update-asset-line">
              {t("update.recommendedAsset", {
                name: props.info.recommendedAsset.name,
              })}
            </p>
          )}
          {props.progress && (
            <div className="update-download-progress">
              <div className="update-progress-header">
                <span>{props.progress.assetName}</span>
                <span>{progressPercent ? `${progressPercent.toFixed(1)}%` : t("update.downloading")}</span>
              </div>
              <div className="update-progress-track">
                <div
                  className="update-progress-bar"
                  style={{ width: `${Math.max(0, Math.min(100, progressPercent))}%` }}
                />
              </div>
              <div className="update-progress-meta">
                <span>
                  {formatUpdateBytes(props.progress.receivedBytes)} / {formatUpdateBytes(props.progress.totalBytes)}
                </span>
                <span>
                  {props.progress.bytesPerSecond
                    ? `${formatUpdateBytes(props.progress.bytesPerSecond)}/s`
                    : ""}
                </span>
              </div>
              {props.downloadedPath && (
                <div className="update-downloaded-path">{props.downloadedPath}</div>
              )}
            </div>
          )}
          <div className="update-notes markdown-body">
            {/* GitHub Release notes 通常是 Markdown;这里复用聊天渲染链路支持标题、列表、链接和代码块。 */}
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {props.info.releaseNotes.trim() || t("update.noReleaseNotes")}
            </ReactMarkdown>
          </div>
        </div>
        <div className="update-actions">
          <button onClick={props.onOpenRelease}>
            {t("update.openRelease")}
          </button>
          <button onClick={props.onBrowserDownload}>
            {t("update.browserDownload")}
          </button>
          {props.downloadedPath ? (
            <button className="primary" onClick={props.onInstall}>
              {t("update.installDownloaded")}
            </button>
          ) : (
            <button
              className="primary"
              disabled={props.checking || props.downloading || !props.info.recommendedAsset}
              onClick={props.onDownload}
            >
              {props.downloading ? t("update.downloading") : t("update.downloadInApp")}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
