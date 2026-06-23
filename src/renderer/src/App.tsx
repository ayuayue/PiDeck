import {
  Fragment,
  useEffect,
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
  Info,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Play,
  Plus,
  Trash2,
  Minus,
  Globe,
  Pin,
  Square,
  X,
} from "lucide-react";
import { createPreviewApi } from "./previewApi";
import { createBrowserApi } from "./browserApi";
import { ConfigModal } from "./ConfigModal";
import { TerminalDock } from "./components/terminal/TerminalDock";
import { FeishuLinkIndicator } from "./components/feishu/FeishuLinkIndicator";
import { useFeishuBridge } from "./hooks/useFeishuBridge";
import { CloseIconButton } from "./components/ui/IconButton";
import { getComposerEnterIntent } from "./composerBehavior";
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
import { LazyWrapper } from "./hooks/useLazyComponent";
import {
  AgentRun,
  AgentContextMenu,
  BranchSelector,
  ChatBubble,
  CodexImportModal,
  ClaudeImportModal,
  OpenCodeImportModal,
  ComposerToolbar,
  ConversationOutline,
  DrawerContent,
  EmptyState,
  EnvironmentDialog,
  FileContextMenu,
  ConfirmDialog,
  ImagePreviewModal,
  LogoMark,
  ModelPicker,
  ProjectAvatar,
  ProjectContextMenu,
  PromptSuggestions,
  RpcLogModal,
  SessionContextMenu,
  SessionHistoryModal,
  SessionStatus,
  SessionFileSummary,
  SettingsModal,
  ThinkingBubble,
  ThinkingGroup,
  ThinkingPicker,
  ToolGroup,
  applySuggestion,
  buildOutline,
  buildSuggestionItems,
  clearSuggestionTrigger,
  detectTrigger,
  displayPath,
  flattenFiles,
  groupToolMessages,
  matches,
  type DrawerPanel,
  type SessionModifiedFile,
} from "./components/app/AppParts";
import {
	getCaretOffset as getCaretOffsetOf,
	getRichInputCaretCoords,
	RichInput,
	type RichInputChip,
} from "./components/app/RichInput";
import { FileDiffViewer } from "./components/app/FileDiffViewer";
import { createDefaultExternalEditorSettings } from "../../shared/types";
import type {
  AgentRuntimeState,
  AgentTab,
  AppInfo,
  AppSettings,
  AppUpdateDownloadProgress,
  AppUpdateInfo,
  AvailableModel,
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
  ImageContent,
  PiCommand,
  PiInstallStatus,
  Project,
  SessionSummary,
  ThinkingUpdate,
} from "../../shared/types";

const isLanWeb =
  !window.piDesktop && window.location.protocol.startsWith("http");
const api =
  window.piDesktop ?? (isLanWeb ? createBrowserApi() : createPreviewApi());
// 输入框默认高度增加,提供更好的输入体验,适合多行输入和代码片段
const COMPOSER_MIN_HEIGHT = 240;
const COMPOSER_DEFAULT_TERMINAL_HEIGHT = 220;
const COMPOSER_MIN_TIMELINE_HEIGHT = 160;
const SIDEBAR_PROJECT_CHILD_PAGE_SIZE = 5;

function countContentLines(value: unknown) {
  if (typeof value !== "string") return 0;
  if (!value) return 0;
  return value.split(/\r\n|\r|\n/).length;
}

function getToolChangedLineCount(toolName: string, args: any) {
  // 会话结束摘要只能使用 renderer 已收到的工具参数,不能重新 diff 工作区;
  // 这里按编辑/写入工具的输入估算"本次触达行数",避免把用户在会话外的改动也计入。
  if (/edit/i.test(toolName)) {
    const edits = Array.isArray(args?.edits) ? args.edits : undefined;
    if (edits) {
      return edits.reduce((total: number, edit: any) => {
        const oldLines = countContentLines(edit?.oldText);
        const newLines = countContentLines(edit?.newText);
        return total + Math.max(oldLines, newLines);
      }, 0);
    }
    return Math.max(
      countContentLines(args?.oldText),
      countContentLines(args?.newText),
    );
  }
  if (/write|create/i.test(toolName)) {
    return countContentLines(args?.content ?? args?.text ?? args?.data);
  }
  return 0;
}

function displayProjectDirectoryName(project: Project) {
  if (isChatProject(project)) return "Chat";
  const normalizedPath = project.path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalizedPath.split("/").pop() || project.name || project.path;
}

function isChatProject(project?: Project) {
  return project?.kind === "chat";
}

function isAbsoluteFilePath(path: string) {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/");
}

function resolveFileLinkPath(path: string, basePath?: string) {
  if (!path || isAbsoluteFilePath(path) || !basePath) return path;
  // 浏览器端不引入 Node path;按项目根路径分隔符拼接,满足点击 AI 输出的项目相对路径。
  const separator = basePath.includes("\\") ? "\\" : "/";
  return `${basePath.replace(/[\\/]+$/, "")}${separator}${path.replace(/^[\\/]+/, "")}`;
}

const EDITOR_LOGO_URLS: Record<string, string> = {
  vscode: new URL("./assets/editors/vscode.png", import.meta.url).href,
  cursor: new URL("./assets/editors/cursor.ico", import.meta.url).href,
  zed: new URL("./assets/editors/zed.png", import.meta.url).href,
  idea: new URL("./assets/editors/idea.svg", import.meta.url).href,
  webstorm: new URL("./assets/editors/webstorm.svg", import.meta.url).href,
  phpstorm: new URL("./assets/editors/phpstorm.svg", import.meta.url).href,
  pycharm: new URL("./assets/editors/pycharm.svg", import.meta.url).href,
};

function getEditorLogoUrl(editorId: string) {
  return EDITOR_LOGO_URLS[editorId];
}

function isReplacementForPendingAgent(agent: AgentTab, pending: AgentTab) {
  if (!pending.id.startsWith("pending-")) return false;
  if (agent.projectId !== pending.projectId || agent.cwd !== pending.cwd)
    return false;
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
  const [projects, setProjects] = useState<Project[]>([]);
  const [draggingProjectId, setDraggingProjectId] = useState<string>();
  const [dragOverProjectId, setDragOverProjectId] = useState<string>();
  const [agents, setAgents] = useState<AgentTab[]>([]);
  const [pendingAgents, setPendingAgents] = useState<AgentTab[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string>();
  const [activeAgentId, setActiveAgentId] = useState<string>();
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
  const [externalEditors, setExternalEditors] = useState<ExternalEditor[]>([]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [thinkingPickerOpen, setThinkingPickerOpen] = useState(false);
  const [sendBehaviorMenuOpen, setSendBehaviorMenuOpen] = useState(false);
  const [sessionFeishuBotId, setSessionFeishuBotId] = useState<
    string | undefined
  >(undefined);
  const [sessionActionsOpen, setSessionActionsOpen] = useState(false);
  const [fileActionsOpen, setFileActionsOpen] = useState(false);
  const [switchingBranch, setSwitchingBranch] = useState<string | null>(null);
  const [promptByAgent, setPromptByAgent] = useState<Record<string, string>>(
    {},
  );
  /** 当前进行的操作类型,用于按钮 loading 状态 */
  const [loadingAction, setLoadingAction] = useState<null | "restart">(null);
  const [attachedImagesByAgent, setAttachedImagesByAgent] = useState<
    Record<string, ImageContent[]>
  >({});
  const [previewImage, setPreviewImage] = useState<ImageContent | null>(null);
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
  const [streamingThinking, setStreamingThinking] = useState<
    Record<string, string>
  >({});
  /** 每个 agent 最后一次会话的开始时间(status 变为 running 时记录),用 ref 避免 effect 闭包陈旧 */
  const sessionStartByAgentRef = useRef<Record<string, number>>({});
  /** 每个 agent 最后一次会话的总时长(ms),仅在会话结束后更新 */
  const [sessionDurationByAgent, setSessionDurationByAgent] = useState<
    Record<string, number>
  >({});
  /** 会话结束后固化的文件修改摘要;新一轮运行时继续展示上一轮结果,避免完成信息被隐藏。 */
  const [sessionFileSummaryByAgent, setSessionFileSummaryByAgent] = useState<
    Record<string, SessionModifiedFile[]>
  >({});
  /** 每轮回答完成后固化的文件修改摘要,key 为 assistant message id,便于卡片贴在对应回答后。 */
  const [turnFileSummaryByMessage, setTurnFileSummaryByMessage] = useState<
    Record<string, SessionModifiedFile[]>
  >({});
  // 记录每轮回答开始前已有的修改文件累计状态,用增量差异避免聊天卡片重复展示历史会话文件。
  const turnFileBaselineByAgentRef = useRef<
    Record<string, Map<string, SessionModifiedFile>>
  >({});
  const finalizedTurnByAgentRef = useRef<Record<string, string | null>>({});
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
  const [diffViewFile, setDiffViewFile] = useState<string | null>(null);
  const [diffViewMode, setDiffViewMode] = useState<"view" | "diff">("view");
  const [diffViewOriginalContent, setDiffViewOriginalContent] = useState<string>("");
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
  const [openCodeImportSessions, setOpenCodeImportSessions] = useState<
    OpenCodeSessionSummary[]
  >([]);
  const [openCodeImportSelected, setOpenCodeImportSelected] = useState<string[]>([]);
  const [openCodeImportLoading, setOpenCodeImportLoading] = useState(false);
  const [openCodeImportRunning, setOpenCodeImportRunning] = useState(false);
  const [openCodeImportReport, setOpenCodeImportReport] =
    useState<OpenCodeImportReport | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // 历史命令相关状态
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [historyNavigating, setHistoryNavigating] = useState(false);
  const [savedPrompt, setSavedPrompt] = useState("");
  const [compacting, setCompacting] = useState(false);
  const [drawer, setDrawer] = useState<DrawerPanel | null>(null);
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
  const [configOpen, setConfigOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [windowAlwaysOnTop, setWindowAlwaysOnTop] = useState(false);
  const [_debugOpen, _setDebugOpen] = useState(false);
  /** RPC 日志弹窗目标 agent */
  const [rpcLogAgentId, setRpcLogAgentId] = useState<string | null>(null);
  /** 是否自动滚动到最新消息 */
  const [autoScroll, setAutoScroll] = useState(true);
  /** 是否显示"移动到最新"按钮 */
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const [settings, setSettings] = useState<AppSettings>({
    useNativeTitleBar: true,
    showNativeMenu: false,
    sendShortcut: "enter-send",
    theme: "system",
    language: "system",
    piEnvironmentChecked: false,
    closeToTray: true,
    enableNotifications: true,
    showThinking: true,
    showDevTools: false,
    piProxyEnabled: false,
    piProxyUrl: "http://127.0.0.1:7890",
    piProxyBypass: "localhost,127.0.0.1,::1",
    desktopProxyEnabled: false,
    desktopProxyUrl: "http://127.0.0.1:7890",
    desktopProxyBypass: "localhost,127.0.0.1,::1",
    customPiPath: "",
    telemetryEnabled: true,
    webServiceEnabled: false,
    webServiceHost: "0.0.0.0",
    webServicePort: 8765,
    rpcTimeout: 600_000,
    linkOpenMode: "external",
    maxEditorFileSizeMB: 5,
    externalEditors: createDefaultExternalEditorSettings(),
  });
  const [settingsNotice, setSettingsNotice] = useState("");
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
  const [environmentDialog, setEnvironmentDialog] = useState(false);
  const DEFAULT_LIST_WIDTH = 250;
  const [listWidth, setListWidth] = useState(DEFAULT_LIST_WIDTH);
  const [drawerWidth, setDrawerWidth] = useState(270);
  const [composerHeight, setComposerHeight] = useState(COMPOSER_MIN_HEIGHT);
  const [composerAutoHeight, setComposerAutoHeight] =
    useState(COMPOSER_MIN_HEIGHT);
  const [terminalDockStateByAgent, setTerminalDockStateByAgent] =
    useState<TerminalDockStateByAgent>({});
  const [terminalHeightByAgent, setTerminalHeightByAgent] = useState<
    Record<string, number>
  >({});
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
  const fileActionsRef = useRef<HTMLDivElement | null>(null);
  const chatHeaderRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLElement | null>(null);
  const timelineRef = useRef<HTMLElement | null>(null);
  const composerBoxRef = useRef<HTMLDivElement | null>(null);
  const composerTextareaRef = useRef<HTMLDivElement | null>(null);
  // RichInput 受控重渲染后,光标应恢复到的纯文本偏移(供建议选中/清除后恢复选区)。
  const pendingComposerCaretRef = useRef<number | null>(null);
  const pendingAgentsRef = useRef<AgentTab[]>([]);
  const projectDragPreventClickRef = useRef(false);

  // ===== 飞书桥接 =====

  const feishu = useFeishuBridge();

  // 当活跃 Agent 切换时，加载该 Agent 指定的飞书 Bot
  useEffect(() => {
    if (!activeAgentId) {
      setSessionFeishuBotId(undefined);
      return;
    }
    feishu.getSessionBot(activeAgentId).then((botId) => {
      setSessionFeishuBotId(botId);
    });
  }, [activeAgentId]);

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
    isLoading: isLoadingMoreMessages,
  } = useMessagePagination({
    messages: activeMessages,
    initialPageSize: 100, // 首屏 100 条
    pageSize: 100,        // 每次加载 100 条
    enabled: activeMessages.length > 100, // 超过 100 条才启用
  });

  const renderedMessages = useMemo(
    () => groupToolMessages(paginatedMessages),
    [paginatedMessages],
  );
  const isAwaitingAssistant = Boolean(
    activeAgent &&
    (activeAgent.status === "running" || activeRuntimeState?.isStreaming) &&
    activeMessages.at(-1)?.role !== "assistant",
  );
  /** 当前活跃 agent 的实时思考文本 */
  const activeThinking = activeAgentId
    ? (streamingThinking[activeAgentId] ?? "")
    : "";
  const activeTerminalHeight = activeAgentId
    ? (terminalHeightByAgent[activeAgentId] ?? COMPOSER_DEFAULT_TERMINAL_HEIGHT)
    : COMPOSER_DEFAULT_TERMINAL_HEIGHT;
  const resolvedComposerHeight = Math.max(composerHeight, composerAutoHeight);
  const composerMode = prompt.startsWith("!!")
    ? "silent-shell"
    : prompt.startsWith("!")
      ? "shell"
      : null;
  const composerStatusText =
    composerMode === "silent-shell"
      ? t("app.composerSilentStatus")
      : composerMode === "shell"
        ? t("app.composerShellStatus")
        : drawer === "files"
          ? t("app.composerFilesStatus")
          : drawer === "sessions"
            ? t("app.composerSessionStatus", {
                name: sessionsProject?.name ?? t("common.project"),
              })
            : (activeAgent?.sessionPath ?? "");

  useEffect(() => {
    if (!drawerPinnedPanel) return;
    if (drawer !== drawerPinnedPanel) setDrawer(drawerPinnedPanel);
    if (drawerCollapsed) setDrawerCollapsed(false);
  }, [drawer, drawerCollapsed, drawerPinnedPanel]);

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
    };
    applyTheme();
    if (settings.theme !== "system" || !media) return;
    media.addEventListener?.("change", applyTheme);
    return () => media.removeEventListener?.("change", applyTheme);
  }, [settings.theme]);

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
      if (!toolName || !/write|edit|create/i.test(toolName)) continue;
      const filePath =
        typeof args?.filePath === "string"
          ? args.filePath
          : typeof args?.path === "string"
            ? args.path
            : typeof args?.file === "string"
              ? args.file
              : typeof args?.fileName === "string"
                ? args.fileName
                : undefined;
      if (!filePath) continue;
      const previous = byPath.get(filePath);
      // 同一路径再次被修改时移动到 Map 末尾，右侧修改清单才能按"最新修改"展示。
      if (previous) byPath.delete(filePath);
      // 从消息 meta 中提取工具执行前的文件原始内容，用于差异编辑器的对比基准。
      const originalContent = msg.meta?.originalContent as string | undefined;
      byPath.set(filePath, {
        path: filePath,
        toolName,
        status: status === "running" ? "running" : (previous?.status ?? status),
        changedLines:
          (previous?.changedLines ?? 0) +
          getToolChangedLineCount(toolName, args),
        // 同一路径多次修改时保留首次记录的 originalContent，历史会话恢复时优先使用
        originalContent: previous?.originalContent ?? originalContent ?? "",
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
  // 以光标位置为锚检测触发器,使文字中间也能唤出 @ 文件 / / 命令菜单。
  const suggestionItems = useMemo(
    () =>
      suggestionsOpen
        ? buildSuggestionItems(prompt, composerCursor, commands, flatFiles)
        : [],
    [suggestionsOpen, prompt, composerCursor, commands, flatFiles],
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
    void api.editors.list().then(setExternalEditors).catch(() => setExternalEditors([]));
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
    const offSettings = api.settings.onApplyWindow(() =>
      setSettingsNotice(t("settings.restartNotice")),
    );
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
    // 监听 RPC 日志,保留最近 2000 条用于调试;message_update 高频事件很多,
    // 200 条很容易在一次长响应中被刷掉,但仍设置上限避免 renderer 内存无限增长。
    const offRpcLog = api.agents.onRpcLog((payload) =>
      setRpcLogs((current) => {
        // 优化:避免频繁创建新数组,只在超过上限时才slice
        const newLog = {
          id: crypto.randomUUID(),
          agentId: payload.agentId,
          direction: payload.direction,
          summary: payload.summary,
          data: payload.data,
          time: Date.now(),
        };
        if (current.length < 2000) {
          return [...current, newLog];
        }
        return [...current.slice(-1999), newLog];
      }),
    );

    return () => {
      offProjects();
      offState();
      offMessages();
      offLog();
      offSettings();
      offUpdateProgress();
      offRuntimeState();
      offThinking();
      offRpcLog();
    };
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
    setShowScrollToBottom(false);
  }

  useEffect(() => {
    let frame = 0;
    const scheduleSync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setComposerHeight((current) => clampComposerHeight(current));
        syncComposerAutoHeight();
      });
    };

    const box = composerBoxRef.current;
    const observer =
      box &&
      new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        scheduleSync();
      });
    if (box) observer?.observe(box);

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
      syncComposerAutoHeight();
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
        console.error("Failed to save command history:", error);
      }
    }
  }, [commandHistory]);

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline || !autoScroll) return;
    // 历史会话加载后默认跳到最新消息,符合聊天软件的阅读习惯,避免用户手动滚动到底部。
    requestAnimationFrame(() => {
      timeline.scrollTop = timeline.scrollHeight;
    });
  }, [activeAgentId, activeMessages.length, autoScroll]);

  // 监听用户滚动,判断是否需要显示"移动到最新"按钮
  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = timeline;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 100;

      if (isAtBottom) {
        setAutoScroll(true);
        setShowScrollToBottom(false);
      } else {
        setAutoScroll(false);
        setShowScrollToBottom(true);
      }
    };

    // 初始化时检查一次
    handleScroll();

    timeline.addEventListener("scroll", handleScroll);
    return () => timeline.removeEventListener("scroll", handleScroll);
  }, [activeAgentId]);

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
    if (!fileActionsOpen) return;
    void api.editors.list().then(setExternalEditors).catch(() => setExternalEditors([]));
    const handler = (event: MouseEvent) => {
      if (fileActionsRef.current && !fileActionsRef.current.contains(event.target as Node)) {
        setFileActionsOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [fileActionsOpen]);

  useEffect(() => {
    for (const agent of displayAgents) {
      if (agent.id !== activeAgentId) continue;
      const previousStatus = agentStatusByAgentRef.current[agent.id];
      if (agent.status === "running") {
        if (previousStatus !== "running") {
          sessionStartByAgentRef.current[agent.id] = Date.now();
          // Files 面板展示会话总览;聊天流只展示本轮回答新增触达的文件。
          // 基线记录累计行数而不是仅记录路径:同一个文件在后续回答再次被编辑时也要显示。
          turnFileBaselineByAgentRef.current[agent.id] = new Map(
            modifiedFiles.map((file) => [file.path, file]),
          );
          finalizedTurnByAgentRef.current[agent.id] = null;
        }
      } else if (agent.status === "idle") {
        const start = sessionStartByAgentRef.current[agent.id];
        if (start) {
          setSessionDurationByAgent((d) => ({
            ...d,
            [agent.id]: Date.now() - start,
          }));
        }
        if (modifiedFiles.length > 0) {
          // 会话级摘要仍保留给右侧 Files 面板作为总览,但不再渲染到聊天底部。
          setSessionFileSummaryByAgent((current) => ({
            ...current,
            [agent.id]: modifiedFiles,
          }));
        }

        const lastAssistantMessage = [...(messagesByAgent[agent.id] ?? [])]
          .reverse()
          .find((message) => message.role === "assistant");
        const baseline =
          turnFileBaselineByAgentRef.current[agent.id] ??
          new Map<string, SessionModifiedFile>();
        const turnModifiedFiles = modifiedFiles
          .map<SessionModifiedFile | null>((file) => {
            const baselineFile = baseline.get(file.path);
            const changedLines = Math.max(
              0,
              (file.changedLines ?? 0) - (baselineFile?.changedLines ?? 0),
            );
            return changedLines > 0 || !baselineFile
              ? { ...file, changedLines }
              : null;
          })
          .filter((file): file is SessionModifiedFile => Boolean(file));

        if (
          lastAssistantMessage &&
          turnModifiedFiles.length > 0 &&
          finalizedTurnByAgentRef.current[agent.id] !== lastAssistantMessage.id
        ) {
          finalizedTurnByAgentRef.current[agent.id] = lastAssistantMessage.id;
          setTurnFileSummaryByMessage((current) => ({
            ...current,
            [lastAssistantMessage.id]: turnModifiedFiles,
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
        // 自动聚焦到输入框
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
        setSettingsNotice(
          t("app.piCheckPassed", {
            value: next.command ?? next.version ?? "pi",
          }),
        );
      } else {
        setSettingsNotice(
          t("app.piCheckFailed", {
            error: next.error ?? t("settings.piMissing"),
          }),
        );
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
        setSettingsNotice(
          t("app.piPathSaved", {
            path: result.command ?? updated.customPiPath ?? path,
          }),
        );
        if (options.closeDialogOnSuccess) {
          // 启动检测弹窗场景下保持原有成功后自动关闭体验;设置页内校验不关闭设置窗口。
          window.setTimeout(() => setEnvironmentDialog(false), 3000);
        }
      } else {
        setSettingsNotice(
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
    setSettingsNotice(t("app.piPathCleared"));
    const status = await api.pi.check();
    setPiStatus(status);
  }

  function showToast(message: string, duration = 3500) {
    setToast(message);
    window.setTimeout(() => setToast(null), duration);
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
        setSettingsNotice(
          t("app.latestVersionNotice", { version: next.currentVersion }),
        );
      }
    } catch (error) {
      if (source === "manual") {
        const message = error instanceof Error ? error.message : String(error);
        setSettingsNotice(t("app.updateFailedNotice", { error: message }));
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

  async function refreshFiles(projectId = activeProjectId) {
    if (!projectId) return;
    const next = await api.files.list(projectId);
    setFiles(next);
    showToast(t("app.filesRefreshed"), 1800);
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
    setDiffViewMode("view");
    setDiffViewFile(path);
  }

  function diffFilePath(path: string) {
    setDiffViewMode("diff");
    setDiffViewFile(path);
    // 从当前 modifiedFiles 中查找是否有缓存的原始内容，传递给差异编辑器作为对比基准。
    const modified = modifiedFiles.find((f) => f.path === path);
    setDiffViewOriginalContent(modified?.originalContent ?? "");
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
    setDrawer((current) => (current === "sessions" ? null : current));
    await refreshSessionHistory(project.id);
  }

  async function openHistorySession(session: SessionSummary) {
    const projectId = sessionsProjectId;
    if (!projectId) return;
    setSessionsProjectId(undefined);
    setSessions([]);
    await createAgent(
      projectId,
      session.filePath,
      session.name || t("common.untitled"),
    );
  }

  async function renameHistorySession(filePath: string, newName: string) {
    await api.sessions.rename(filePath, newName);
    if (sessionsProjectId) await refreshSessions(sessionsProjectId);
    if (sessionsProjectId) await refreshProjectSessions(sessionsProjectId);
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
      // 默认不自动勾选任何会话,避免用户未确认时批量覆盖已导入历史。
      setCodexImportSelected([]);
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
    const allPaths = codexImportSessions.map((session) => session.sourcePath);
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
      return existing;
    }
    const previousAgentId = activeAgentId;
    const pendingTab: AgentTab = {
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
    // 立即关闭抽屉,避免等待 agent 加载期间列表仍然显示
    setDrawer(null);
    try {
      const tab = await api.agents.create({ projectId, sessionPath, title });
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
      // 创建失败时由 main process 上报错误,前端仅回退乐观占位,避免停留在不存在的 agent。
      return undefined;
    }
  }

  async function refreshRuntimeState(agentId = activeAgentId) {
    if (!agentId || isPendingAgentId(agentId)) return;
    const state = await api.agents.runtimeState(agentId).catch(() => undefined);
    if (state)
      setRuntimeStateByAgent((current) => ({ ...current, [agentId]: state }));
  }

  async function cycleModel() {
    if (!activeAgentId || isPendingAgentId(activeAgentId)) return;
    const state = await api.agents.cycleModel(activeAgentId);
    setRuntimeStateByAgent((current) => ({
      ...current,
      [activeAgentId]: state,
    }));
  }

  async function openModelPicker() {
    if (!activeAgentId || isPendingAgentId(activeAgentId)) return;
    const models = await api.agents.availableModels(activeAgentId);
    setAvailableModels(models);
    setModelPickerOpen(true);
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

  async function compactAgent() {
    if (!activeAgentId || isPendingAgentId(activeAgentId)) return;
    setCompacting(true);
    try {
      const state = await api.agents.compact(activeAgentId);
      setRuntimeStateByAgent((current) => ({
        ...current,
        [activeAgentId]: state,
      }));
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
    await api.agents.abort(agentId);
    void refreshRuntimeState(agentId);
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

  async function sendPrompt() {
    if (
      isAgentStarting ||
      !activeAgentId ||
      (!prompt.trim() && attachedImages.length === 0)
    )
      return;
    const message = prompt;
    const images = attachedImages.length > 0 ? attachedImages : undefined;

    // ── /goal 命令处理 ──
    if (message.trim().startsWith("/goal")) {
      handleGoalCommand(message.trim());
      setPrompt("");
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
    setPrompt("");
    setAttachedImages([]);
    setSuggestionsOpen(false);
    setSendBehaviorMenuOpen(false);
    await submitPromptSnapshot(activeAgentId, message, images);
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
    setPrompt("");
    setAttachedImages([]);
    setSuggestionsOpen(false);
    setSendBehaviorMenuOpen(false);
    await submitPromptSnapshot(activeAgentId, message, images, "followUp");
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
      if (!window.confirm(`当前有进行中的目标:\n${goalTextRef.current}\n\n是否替换为新目标?`)) return;
    }

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
  ) {
    // 这里接收快照参数,让 composer 发送和历史消息"重新发送"共享同一条路径。
    // Agent 忙碌时显式使用官方 streamingBehavior=steer:消息会进入 pi 的运行中队列,
    // 而不是留在 desktop 本地等整个 agent idle 后再发送。
    const behavior = streamingBehavior ?? (isAgentBusy ? "steer" : undefined);
    await api.agents.prompt({
      agentId,
      message,
      images,
      ...(behavior ? { streamingBehavior: behavior } : {}),
    });
  }

  function resendUserMessage(message: ChatMessage) {
    if (!activeAgentId || message.agentId !== activeAgentId) return;
    // "重新发送"按原消息快照再次提交,不修改输入框,图片也复用原始 base64 内容。
    void submitPromptSnapshot(activeAgentId, message.text, message.images);
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
      setSettingsNotice(
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
      setSettingsNotice(notice);
    } catch (error) {
      setSettings(await api.settings.get());
      setSettingsNotice(error instanceof Error ? error.message : String(error));
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

  function openDrawer(panel: DrawerPanel) {
    if (drawerPinned && panel !== drawerPinnedPanel) return;
    if (panel === "sessions" && activeProjectId) {
      setSessionsProjectId(activeProjectId);
      void refreshSessions(activeProjectId);
    }
    setDrawer((current) => {
      if (current === panel) return drawerPinned ? current : null;
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
    setDrawerPinnedByAgent((current) => {
      const next = { ...current };
      if (next[activeAgentId]) delete next[activeAgentId];
      else next[activeAgentId] = drawer;
      return next;
    });
  }

  function toggleDirectory(path: string) {
    // 文件树默认折叠,只有用户显式展开目录才显示子项,避免大仓库一打开就产生视觉噪音。
    setExpandedDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
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
          const next = Math.min(440, Math.max(160, startListWidth + delta));
          setListCollapsed(next <= 170);
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
          "--list-hover-width": `${Math.max(250, listWidth)}px`,
          "--drawer-width": `${drawerCollapsed ? 0 : drawerWidth}px`,
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
        className="chat-list-pane"
        onPointerLeave={() => {
          if (listHoverRevealSuppressed) setListHoverRevealSuppressed(false);
        }}
      >
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
            const projectSessions = projectSearch
              ? (sessionsByProject[project.id] ?? []).filter((session) =>
                  matches(
                    `${session.name ?? ""}${session.preview}${session.filePath}`,
                    projectSearch,
                  ),
                )
              : (sessionsByProject[project.id] ?? []);
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
              projectDisplay.children.length > 0 || projectSessionsLoading;
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
                className={`project-group${projectIsChat ? " chat-project-group" : ""}`}
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
                    if (projectIsChat) return;
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
                    </div>
                    {projectIsChat && (
                      <p className="chat-project-guide">
                        {t("app.projectChatGuide")}
                      </p>
                    )}
                  </div>
                  <span className="project-row-actions">
                    <span
                      className="project-info"
                      title={
                        projectIsChat
                          ? t("app.projectChatInfo")
                          : t("app.projectInfo")
                      }
                      onClick={(event) => event.stopPropagation()}
                    >
                      <Info size={14} />
                    </span>
                    {!projectIsChat && (
                      <span
                        className="project-action project-delete"
                        title={t("app.projectRemoveTitle")}
                        onClick={async (event) => {
                          event.stopPropagation();
                          const next = await api.projects.remove(project.id);
                          setProjects(next);
                          updateAfterProjectRemoved(project.id, next);
                        }}
                      >
                        <Trash2 size={14} />
                      </span>
                    )}
                  </span>
                </button>
                {!isCollapsed &&
                  projectDisplay.visibleChildren.map((child) => {
                    if (child.type === "agent") {
                      const agent = child.agent;
                      const isActiveAgent = agent.id === activeAgentId;
                      return (
                        <button
                          key={child.key}
                          className={
                            isActiveAgent
                              ? "conversation agent-row active"
                              : "conversation agent-row"
                          }
                          onContextMenu={(event) => {
                            event.preventDefault();
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
                              <strong>{agent.title}</strong>
                              {agent.status && (
                                <span className={`agent-status-indicator status-${agent.status}`}>
                                  {agent.status === 'running' && '●'}
                                  {agent.status === 'idle' && '○'}
                                  {agent.status === 'starting' && '◐'}
                                  {' '}
                                  {t(`app.status${agent.status.charAt(0).toUpperCase() + agent.status.slice(1)}` as any) || agent.status}
                                </span>
                              )}
                            </div>
                          </div>
                        </button>
                      );
                    }

                    const session = child.session;
                    return (
                      <button
                        key={child.key}
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
                            <strong>
                              {session.name || t("common.untitled")}
                            </strong>
                          </div>
                        </div>
                      </button>
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
      </aside>

      <div
        className="splitter splitter-left"
        onPointerDown={(event) => startResize("list", event)}
      />

      <main ref={chatPaneRef} className="chat-pane">
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
              {activeAgent && (
                <span className="chat-path" title={activeProject?.path ?? activeAgent.cwd}>
                  {t("app.path")}: {displayPath(activeProject?.path ?? activeAgent.cwd)}
                </span>
              )}
            </div>
            <div className="chat-subtitle-row">
              {activeAgent?.status && (
                <span className={`agent-status-badge status-${activeAgent.status}`}>
                  {activeAgent.status === 'running' && '●'}
                  {activeAgent.status === 'idle' && '○'}
                  {activeAgent.status === 'starting' && '◐'}
                  {' '}
                  {t(`app.status${activeAgent.status.charAt(0).toUpperCase() + activeAgent.status.slice(1)}` as any) || activeAgent.status}
                </span>
              )}
              <SessionStatus
                state={activeRuntimeState}
                duration={
                  activeAgentId
                    ? sessionDurationByAgent[activeAgentId]
                    : undefined
                }
              />
          </div>
          </div>
          <div
            className={`chat-header-actions${activeAgent?.status === "starting" ? " loading" : ""}`}
          >
            <>
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
                    <span className="session-combo-label">{t("app.new")}</span>
                    {activeAgentId && (
                      <span className={`session-combo-chevron${sessionActionsOpen ? " open" : ""}`}>
                        <ChevronDown size={12} />
                      </span>
                    )}
                  </button>
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
                            !!loadingAction
                          }
                          onClick={async () => {
                            if (!activeAgentId) return;
                            setLoadingAction("restart");
                            setSessionActionsOpen(false);
                            try {
                              const tab =
                                await api.agents.restart(activeAgentId);
                              setActiveAgentId(tab.id);
                              void refreshRuntimeState(tab.id);
                            } finally {
                              setLoadingAction(null);
                            }
                          }}
                        >
                          {loadingAction === "restart"
                            ? t("app.restarting")
                            : t("app.restart")}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="header-action-group panel-group">
                {!isLanWeb && (
                  <>
                    <div className="file-action-combo" ref={fileActionsRef}>
                      <button
                        className={drawer === "files" ? "active file-action-trigger" : "file-action-trigger"}
                        disabled={isAgentStarting}
                        onClick={() => setFileActionsOpen((open) => !open)}
                        title={t("app.files")}
                      >
                        <span className="session-combo-label">{t("app.files")}</span>
                        <span className={`session-combo-chevron${fileActionsOpen ? " open" : ""}`}>
                          <ChevronDown size={12} />
                        </span>
                      </button>
                      {fileActionsOpen && (
                        <div className="file-action-menu">
                          <button
                            onClick={() => {
                              setDrawerCollapsed(false);
                              openDrawer("files");
                              setFileActionsOpen(false);
                            }}
                          >
                            <span>{t("app.showInSidebar")}</span>
                          </button>
                          {externalEditors.map((editor) => (
                            <button
                              key={editor.id}
                              disabled={!(activeAgent?.cwd || (activeProject && !isChatProject(activeProject) ? activeProject.path : undefined))}
                              onClick={() => {
                                const projectPath = activeAgent?.cwd || (activeProject && !isChatProject(activeProject) ? activeProject.path : undefined);
                                if (!projectPath) return;
                                setFileActionsOpen(false);
                                void api.editors.openProject(editor, projectPath).catch((error) => {
                                  showToast(
                                    t("app.openEditorFailed", {
                                      error: error instanceof Error ? error.message : String(error),
                                    }),
                                    3000,
                                  );
                                });
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
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      className={terminalOpen ? "active" : ""}
                      disabled={!activeAgentId || isAgentStarting}
                      onClick={() => {
                        if (!activeAgentId) return;
                        setTerminalOpenForAgent(activeAgentId, !terminalOpen);
                      }}
                      title={t("app.openTerminalTitle")}
                    >
                      {t("app.terminal")}
                    </button>
                  </>
                )}
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
                onClick={loadMoreMessages}
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
              <div className="loader" />
              <span>{t("app.agentStarting")}</span>
            </div>
          )}
          {!activeAgent && (
            <EmptyState
              hasProject={Boolean(activeProjectId)}
              onCreate={() => createAgent()}
            />
          )}
          {activeAgent && (
            <div className="message-list">
              {renderedMessages.map((item) =>
                item.kind === "agent-run" ? (
                  <AgentRun
                    key={item.id}
                    run={item}
                    onPreviewImage={setPreviewImage}
                    onOpenExternal={(url) => api.app.openExternal(url)}
                    onOpenFile={openFilePath}
                    onDiffFile={diffFilePath}
                    onResendUserMessage={resendUserMessage}
                    showThinking={settings.showThinking}
                    fileSummariesByMessage={turnFileSummaryByMessage}
                  />
                ) : item.kind === "tool-group" ? (
                  <ToolGroup key={item.id} group={item} />
                ) : item.kind === "thinking-group" ? (
                  <ThinkingGroup
                    key={item.id}
                    group={item}
                    showThinking={settings.showThinking}
                  />
                ) : (
                  <Fragment key={item.message.id}>
                    <ChatBubble
                      message={item.message}
                      onPreviewImage={setPreviewImage}
                      onOpenExternal={(url) => api.app.openExternal(url)}
                      onOpenFile={openFilePath}
                      onResendUserMessage={resendUserMessage}
                      showThinking={settings.showThinking}
                    />
                    {item.message.role === "assistant" &&
                      turnFileSummaryByMessage[item.message.id]?.length > 0 && (
                        <SessionFileSummary
                          files={turnFileSummaryByMessage[item.message.id]}
                          onOpenFile={openFilePath}
                          onDiffFile={diffFilePath}
                        />
                      )}
                  </Fragment>
                ),
              )}
              {isAwaitingAssistant && (
                <ThinkingBubble
                  thinking={activeThinking}
                  showThinking={settings.showThinking}
                />
              )}
            </div>
          )}

          {showScrollToBottom && (
            <button
              className="scroll-to-bottom-btn"
              onClick={scrollToBottom}
              title={t("app.scrollToBottom")}
            >
              <ChevronDown size={18} />
            </button>
          )}
        </section>

        {outlineItems.length > 1 && (
          <ConversationOutline
            items={outlineItems}
            onJump={(id) =>
              document
                .querySelector(`[data-message-id="${CSS.escape(id)}"]`)
                ?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
          />
        )}

        {!isLanWeb && terminalOpen && activeAgentId && (
          <TerminalDock
            agentId={activeAgentId}
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
          <div
            ref={composerBoxRef}
            className={`composer-box ${
              prompt.startsWith("!!")
                ? "shell-silent-mode"
                : prompt.startsWith("!")
                  ? "shell-mode"
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
              onCycleModel={cycleModel}
              onPickModel={openModelPicker}
              onPickThinking={() => setThinkingPickerOpen(true)}
              onCompact={compactAgent}
              feishuIndicator={
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
                // 文件 chip：在系统默认应用中打开对应文件
                if (chip.kind === "file") {
                  const path = chip.raw.slice(1); // 去掉 @ 前缀
                  openFilePath(path);
                }
                // skill chip 点击暂不处理，后续可扩展跳转 skill 详情
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
              <span className={composerMode ? "composer-mode-status" : ""}>
                {composerStatusText}
              </span>
              {activeAgent?.status === "running" && (
                <button className="stop-send" onClick={() => abortAgent()}>
                  {t("app.stop")}
                </button>
              )}
              <div className="send-button-group">
                <button
                  disabled={
                    isAgentStarting ||
                    !activeAgentId ||
                    (!prompt.trim() && attachedImages.length === 0)
                  }
                  className={
                    isAgentBusy && (prompt.trim() || attachedImages.length > 0)
                      ? "queue-send"
                      : ""
                  }
                  onClick={sendPrompt}
                >
                  {isAgentBusy && (prompt.trim() || attachedImages.length > 0)
                    ? t("app.composerAttach")
                    : t("app.send")}
                </button>
                {isAgentBusy &&
                  (prompt.trim() || attachedImages.length > 0) && (
                    <div className="send-behavior-menu-wrap">
                      <button
                        className="send-behavior-toggle"
                        title={t("app.sendBehaviorTitle")}
                        onClick={() => setSendBehaviorMenuOpen((open) => !open)}
                      >
                        <ChevronDown size={14} />
                      </button>
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
                  )}
              </div>
            </div>
          </div>
        </footer>
        )}
      </main>

      {drawer && !drawerCollapsed && (
        <div
          className="splitter splitter-right"
          onPointerDown={(event) => startResize("drawer", event)}
        />
      )}
      {drawer && !drawerCollapsed && (
        <aside className="detail-drawer">
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
              panel={drawer}
              project={drawer === "sessions" ? sessionsProject : undefined}
              files={files}
              sessions={sessions}
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
        </aside>
      )}
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
      {projectMenu && (
        <ProjectContextMenu
          menu={projectMenu}
          onClose={() => setProjectMenu(null)}
          onRevealProject={() => {
            void api.files.showInFolder(projectMenu.project.path);
            setProjectMenu(null);
          }}
          onImportCodexSessions={() => openCodexImport(projectMenu.project)}
          onImportClaudeSessions={() => openClaudeImport(projectMenu.project)}
          onImportOpenCodeSessions={() => openOpenCodeImport(projectMenu.project)}
          onRemoveProject={async () => {
            const project = projectMenu.project;
            setProjectMenu(null);
            const next = await api.projects.remove(project.id);
            setProjects(next);
            updateAfterProjectRemoved(project.id, next);
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
          onShowLogs={() => {
            setRpcLogAgentId(agentMenu.agent.id);
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
          onShowLogs={() => {
            void openSidebarSession(
              sessionMenu.projectId,
              sessionMenu.session,
            ).then((tab) => {
              if (tab) setRpcLogAgentId(tab.id);
            });
          }}
          onDeleteSession={() => {
            const session = sessionMenu.session;
            setSessionMenu(null);
            void deleteHistorySession(session);
          }}
        />
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
      {/* RPC 日志弹窗 */}
      {rpcLogAgentId && (
        <RpcLogModal
          logs={rpcLogs.filter((l) => l.agentId === rpcLogAgentId)}
          onClose={() => setRpcLogAgentId(null)}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
      {environmentDialog && (
        <EnvironmentDialog
          status={piStatus}
          checking={piChecking}
          onClose={() => {
            setEnvironmentDialog(false);
            setCustomPathResult(null);
          }}
          onRecheck={() => {
            setCustomPathResult(null);
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
        <SettingsModal
          settings={settings}
          notice={settingsNotice}
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
          onCustomPathChange={(path) => {
            setCustomPiPath(path);
            setCustomPathResult(null);
          }}
          onValidateCustomPath={() => validateCustomPiPath()}
          onClearCustomPath={clearCustomPiPath}
          onCheckPi={checkPiInstallInline}
          onTestPiProxy={() => testPiProxy()}
          onCheckUpdate={() => checkAppUpdate("manual")}
          onToggleDevTools={async () => {
            const opened = await api.app.toggleDevTools();
            setSettingsNotice(
              opened ? t("app.devToolsOpened") : t("app.devToolsClosed"),
            );
          }}
          onRestartApp={() => api.app.restart()}
          onOpenWebService={(port) =>
            api.app.openExternal(`http://127.0.0.1:${port}`)
          }
          onClose={() => {
            setSettingsOpen(false);
            setSettingsNotice("");
          }}
          onChange={updateSettings}
        />
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
        <UpdateErrorModal
          message={updateError}
          releasesUrl={appInfo.releasesUrl}
          onClose={() => setUpdateError(null)}
          onOpenRelease={() => api.app.openExternal(appInfo.releasesUrl)}
        />
      )}
      {upToDateVersion && (
        <UpToDateModal
          version={upToDateVersion}
          releasesUrl={appInfo.releasesUrl}
          onClose={() => setUpToDateVersion(null)}
          onOpenRelease={() => api.app.openExternal(appInfo.releasesUrl)}
        />
      )}
      {diffViewFile && (
        <FileDiffViewer
          filePath={diffViewFile}
          mode={diffViewMode}
          originalContent={diffViewMode === "diff" ? diffViewOriginalContent : undefined}
          onClose={() => { setDiffViewFile(null); setDiffViewMode("view"); }}
          readContent={(path) => api.files.readContent(path)}
          readOriginalContent={(path) => api.git.originalContent(path)}
          saveContent={(path, content) => api.files.writeContent(path, content)}
          theme={document.documentElement.dataset.theme === "dark" ? "dark" : "light"}
          maxFileSizeMB={settings.maxEditorFileSizeMB}
        />
      )}
      {previewImage && (
        <ImagePreviewModal
          image={previewImage}
          onClose={() => setPreviewImage(null)}
        />
      )}
      {codexImportProject && (
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
      )}
      {claudeImportProject && (
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
      )}
      {openCodeImportProject && (
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
      )}
      {sessionsProject && (
        <SessionHistoryModal
          project={sessionsProject}
          sessions={sessions}
          loading={sessionHistoryLoading}
          onClose={() => {
            setSessionsProjectId(undefined);
            setSessions([]);
          }}
          onRefresh={() => refreshSessionHistory(sessionsProject.id)}
          onOpen={openHistorySession}
          onRename={renameHistorySession}
          onCopy={(session) =>
            copySession(session.filePath, sessionsProject.id)
          }
          onExport={exportHistorySession}
          onDelete={deleteHistorySession}
        />
      )}
      <ConfigModal
        open={configOpen}
        onClose={() => setConfigOpen(false)}
        onSaved={() => {
          // 配置保存后不再自动 reload,用户可通过 Restart 按钮手动重载
        }}
      />

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

function UpdateErrorModal(props: {
  message: string;
  releasesUrl: string;
  onClose: () => void;
  onOpenRelease: () => void;
}) {
  return (
    <div className="modal-backdrop update-backdrop">
      <section className="update-modal update-error-modal">
        <div className="modal-header">
          <strong>{t("update.checkFailedTitle")}</strong>
          <CloseIconButton label={t("common.close")} onClick={props.onClose} />
        </div>
        <div className="update-body">
          <p className="update-version-line">
            {t("update.checkFailedDescription")}
          </p>
          <div className="update-error-detail">
            {t("update.errorInfo", { message: props.message })}
          </div>
          <p className="update-asset-line">
            {t("update.manualReleaseHint")}
            <br />
            <span>{props.releasesUrl}</span>
          </p>
        </div>
        <div className="update-actions">
          <button onClick={props.onClose}>{t("common.close")}</button>
          <button className="primary" onClick={props.onOpenRelease}>
            {t("update.openReleasePage")}
          </button>
        </div>
      </section>
    </div>
  );
}

function UpToDateModal(props: {
  version: string;
  releasesUrl: string;
  onClose: () => void;
  onOpenRelease: () => void;
}) {
  return (
    <div className="modal-backdrop update-backdrop">
      <section className="update-modal update-uptodate-modal">
        <div className="modal-header">
          <strong>{t("update.upToDateTitle")}</strong>
          <CloseIconButton label={t("common.close")} onClick={props.onClose} />
        </div>
        <div className="update-body">
          <p className="update-version-line">
            {t("update.upToDateMessage", { version: props.version })}
          </p>
        </div>
        <div className="update-actions">
          <button onClick={props.onClose}>{t("common.close")}</button>
          <button onClick={props.onOpenRelease}>
            {t("update.openReleasePage")}
          </button>
        </div>
      </section>
    </div>
  );
}
