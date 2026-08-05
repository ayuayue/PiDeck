import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { SKIN_PRESETS } from "./themePresets";
// 壁纸模式已注入的 token 键（effect 重跑/清除设置时需要跨运行保留，避免漏清）
let injectedWallpaperTokens = new Set<string>();
import {
  Code,
  FolderOpen,
  Globe,
  Pencil,
  SquarePen,
  Terminal,
  GitBranch,
} from "lucide-react";
import { showNotice } from "./utils/notice";
import {
  desktopApi as api,
  isLanWeb,
  missingElectronPreload,
} from "./desktopApi";
// 文件链接路由：图片类型走弹窗预览
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"]);
const ConfigModal = lazy(() => import("./ConfigModal").then((m) => ({ default: m.ConfigModal })));
import { type SidebarActions } from "./components/sidebar/SidebarContent";
import { AppSidebar } from "./components/sidebar/AppSidebar";
import { AppBootstrap } from "./components/app/AppBootstrap";
import { SettingsFeatureRoot } from "./components/app/SettingsFeatureRoot";
import { useRename } from "./hooks/useRename";
import { useProjectRuntimeCapabilities } from "./hooks/useRuntimeCapabilities";
import { useSessionRuntimeBridge } from "./hooks/useSessionRuntimeBridge";
import { useSessionLayout } from "./hooks/useSessionLayout";
import { useFileEditor , resolveFileLinkPath } from "./hooks/useFileEditor";
import { useOverlayActions } from "./hooks/useOverlayActions";
import { useWorkspacePanels, type WorkspaceDrawerPanel, type WorkspaceExternalEditorAdapter } from "./hooks/useWorkspacePanels";
import { useDrawerPorts } from "./hooks/useDrawerPorts";
import { useTerminalDock } from "./hooks/useTerminalDock";
import { useImportFlow } from "./hooks/useImportFlow";
import { useQueuedPrompt } from "./hooks/useQueuedPrompt";
import { activeAgentIdAtom } from "./hooks/useSessionRuntimeController";
import { PromptDeliveryUnknownError } from "./utils/promptErrors";
import {
  requireSessionCommand,
  toSessionRuntimeTarget,
} from "./utils/sessionCommands";
import { resolveChatSessionBootstrap } from "./utils/chatSessionBootstrap";

import { usePiUpdate } from "./hooks/usePiUpdate";
import { useAppUpdateController } from "./hooks/useAppUpdateController";
import { useProjectSync } from "./hooks/useProjectSync";
import {
  agentInventoryAtom,
  applySessionRuntimeEventAtom,
  currentSessionAtom,
  currentSessionIdAtom,
  currentSessionRuntimeAtom,
  projectInventoryAtom,
  removeSessionComposerStateAtom,
  removeSessionStateAtom,
  replaceProjectInventoryAtom,
  replaceProjectSessionsAtom,
  sessionRecordByIdAtomFamily,
  sessionRecordsAtom,
  sessionRecordsByProjectIdAtomFamily,
  sessionIdByRuntimeAgentIdAtomFamily,
  sessionRuntimeBySessionIdAtomFamily,
  sidebarExpandedProjectIdsAtom,
  useWebContentsViewBrowserAtom,
  sessionCatalogLoadStateAtom,
  sessionSummariesByProjectIdAtomFamily,
  sessionTabIdsAtom,
  setSessionAttachmentsAtom,
  setSessionCatalogLoadStateAtom,
  setSessionDraftAtom,
  upsertSessionAtom,
} from "./atoms";
import {
  buildComposerPromptSubmission,
} from "./composerBehavior";
import {
  isSameSessionPath,
} from "./agentListDisplay";
import { resolveLocale, setI18nLocale, t, translateI18nDescriptor } from "./i18n";
import {
  isChatProject,
  loadSessionSourceFilter,
  saveSessionSourceFilter,
  isReplacementForPendingAgent,
  isPendingAgentId,
  migrateAgentRecord,
  type PendingAgentTab,
} from "./rendererUtils";
import { useResize } from "./hooks/useResize";
import { useSessionTimelineController } from "./hooks/useSessionTimelineController";
import { useSessionActions } from "./hooks/useSessionActions";
import { useScratchPad } from "./hooks/useScratchPad";
import { useWorktreeActions } from "./hooks/useWorktreeActions";
import { SessionRuntimeInjector } from "./components/session/SessionRuntimeInjector";
import { SessionTabsBar } from "./components/session/SessionTabsBar";
import { ProjectEmptyState } from "./components/session/ProjectEmptyState";
import {
  togglePinSessionTab as togglePinSessionTabList,
  reorderSessionTabs as reorderSessionTabList,
} from "./utils/sessionTabs";
import { ScratchPadOverlay } from "./components/overlays/ScratchPadOverlay";
import { AppShell } from "./components/app/AppShell";
import { WorkspaceDrawerRail } from "./components/workspace/WorkspaceDrawerRail";
import { DrawerSurface } from "./components/workspace/DrawerSurface";
import { RenameModals } from "./components/RenameModals";
import { SessionActionOverlays } from "./components/overlays/SessionActionOverlays";
import { AppUpdateOverlay } from "./components/overlays/AppUpdateOverlay";
import { ImportOverlayHost } from "./components/overlays/ImportOverlayHost";
import { EnvironmentOverlay } from "./components/overlays/EnvironmentOverlay";
import {
  ConversationOutline,
  EnvironmentDialog,
  FileContextMenu,
  ImagePreviewModal,
  LogoMark,
  type SessionModifiedFile,
} from "./components/app/AppParts";
import { ExternalEditorOverlay } from "./components/workspace/ExternalEditorOverlay";
import { navigateTo } from "./components/app/BrowserPanel";
import {
  buildOutline,
  flattenFiles,
  mergeCommands,
  getToolFilePath,
  getToolNewContent,
  getToolChangedLineCount,
} from "./components/app/AppUtils";
// 懒加载：Monaco Editor（~17.6MB Web Worker）仅在用户打开 diff 时才加载
const FileDiffViewer = lazy(() => import("./components/app/FileDiffViewer").then((m) => ({ default: m.FileDiffViewer })));
const ProjectResourcesModal = lazy(() => import("./components/app/ProjectResourcesModal").then((m) => ({ default: m.ProjectResourcesModal })));
import { createDefaultExternalEditorSettings } from "../../shared/types";
import type {
  AgentRuntimeState,
  AgentTab,
  AppInfo,
  AppSettings,
  ChatMessage,
  FileTreeNode,
  ImageContent,
  PiCommand,
  Project,
  SessionRecord,
  SessionSummary,
  ComposerAgentMode,
} from "../../shared/types";

export function App() {
  if (missingElectronPreload) {
    return (
      <div className="boot-screen root-loading">
        {/* 与 EmptyState / index.html 启动标同一 path，避免 LogoMark 再套一层不同底色 */}
        <div className="boot-logo root-loading-logo" aria-hidden="true">
          <svg viewBox="140 140 520 520" width="48" height="48">
            <path
              fill="#fff"
              fillRule="evenodd"
              d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
            />
            <path fill="#fff" d="M517.36 400H634.72V634.72H517.36Z" />
          </svg>
        </div>
        <strong>PiDeck</strong>
        <span>{t("app.preloadMissing")}</span>
      </div>
    );
  }

  const store = useStore();
  // Composer input state is owned by ComposerArea; the root does not subscribe to each key.
  const currentSessionId = useAtomValue(currentSessionIdAtom);
  const currentSession = useAtomValue(currentSessionAtom);
  // currentSessionRuntime / currentSessionRuntimeUi / currentSessionSendState: sync store.get() only.
  // Streaming subscriptions are in SessionRuntimeInjector.
  const projects = useAtomValue(projectInventoryAtom);
  const agents = useAtomValue(agentInventoryAtom);
  const setCurrentSessionId = useSetAtom(currentSessionIdAtom);
  const replaceProjectSessions = useSetAtom(replaceProjectSessionsAtom);
  const setProjects = useSetAtom(replaceProjectInventoryAtom);
  const applyRuntimeEvent = useSetAtom(applySessionRuntimeEventAtom);
  const upsertSession = useSetAtom(upsertSessionAtom);
  const setSessionDraft = useSetAtom(setSessionDraftAtom);
  const setSessionAttachments = useSetAtom(setSessionAttachmentsAtom);
  const setSessionCatalogLoadState = useSetAtom(setSessionCatalogLoadStateAtom);
  const removeSessionState = useSetAtom(removeSessionStateAtom);
  const removeSessionComposerState = useSetAtom(removeSessionComposerStateAtom);
  const sessionTimeline = useSessionTimelineController({ sessionId: currentSessionId });
  const currentSessionIdRef = useRef<string | undefined>(currentSessionId);
  currentSessionIdRef.current = currentSessionId;
  const openSessionRequestRef = useRef(0);
  const creatingSessionDraftRef = useRef<Set<string>>(new Set());

  // 项目的 git worktree 列表：{ parentId -> WorktreeEntry[] }
  const [pendingAgents, setPendingAgents] = useState<PendingAgentTab[]>([]);
  /** 侧栏 π logo 重播令牌：agent 启动（含历史会话）/关闭时递增，驱动 BrandLockup 动画 */
  const [brandLogoReplayToken, setBrandLogoReplayToken] = useState(0);
  const [activeProjectId, setActiveProjectId] = useState<string>();
  const activeProjectIdRef = useRef<string | undefined>(activeProjectId);
  activeProjectIdRef.current = activeProjectId;
  const activeAgentId = useAtomValue(activeAgentIdAtom);
  // 切换 agent（新会话/恢复会话）时刷新设置，使 pi agent 的 hideThinkingBlock 立即生效
  useEffect(() => {
    if (activeAgentId) {
      void api.settings.get().then(setSettings).catch(() => undefined);
    }
  }, [activeAgentId]);
  const activeAgentIdRef = useRef<string | undefined>(activeAgentId);
  activeAgentIdRef.current = activeAgentId;
  const agentsRef = useRef<AgentTab[]>(agents);
  agentsRef.current = agents;
  const expandedProjects = useAtomValue(sidebarExpandedProjectIdsAtom);

  const [commands, setCommands] = useState<PiCommand[]>([]);
  const [promptTemplateList] = useState<
    Array<{ name: string; path: string; description: string; content: string; argumentHint?: string }>
  >([]);
  const [sessionActionsOpen, setSessionActionsOpen] = useState(false);
  // TECH DEBT (Phase 3): promptByAgent / attachedImagesByAgent legacy mirrors removed.
  // All drafts/attachments go through Session atoms (setSessionDraft / setSessionAttachments).

  // contentEditable 的实时值通过 livePromptByAgentRef 保持最新，发送路径始终从这里读取草稿。
  const livePromptByAgentRef = useRef<Record<string, string>>({});

  /** 当前正在重启的 Agent，用于仅给对应会话显示 loading，避免切到其他 Agent 后仍被全局禁用。 */
  const [restartingAgentId, setRestartingAgentId] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<ImageContent | null>(null);

  // composerAgentModes legacy mirror removed — mode restore uses Session atom in useQueuedPrompt.
  /** 客户端队列按 agent 记录 flush 锁，避免 tool-end 与 idle 并发投递。 */
  const queueFlushBySessionRef = useRef<Set<string>>(new Set());

  /** & 会话引用选择缓存：key = chip raw（如 "&My Session"），value = 选中的消息列表 */
  const [sessionRefSelections, setSessionRefSelections] = useState<
    Record<string, { messages: Array<{ role: string; content: string }>; fullContext: boolean; selectedIndices: number[] }>
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

  // 记录 composer 光标位置,用于光标相关的 @ / 触发检测与建议项替换。
  const [fileMenu, setFileMenu] = useState<{
    x: number;
    y: number;
    node: FileTreeNode;
  } | null>(null);
  /** 右键打开文件菜单时检查剪贴板是否有文件路径，决定是否显示「粘贴」项 */
  const [hasClipboardFiles, setHasClipboardFiles] = useState(false);
  const [renamingFile, setRenamingFile] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const [renamingFileInput, setRenamingFileInput] = useState("");
  /** 历史会话来源过滤（按项目）：undefined=显示全部，Record 含项目ID对应 Set */
  const [sessionSourceFilter] = useState<
  	Record<string, Set<"pi" | "codex" | "claude" | "opencode"> | null>
  >(() => loadSessionSourceFilter());
  /** 编辑器展示模式：弹框或侧栏 */
  // showToast 经 showNotice → sonner 全局 toast（#115）
  // 历史命令：按 agent 隔离，agent 关闭即清除（不持久化）
  const promptHistoryRef = useRef<Record<string, string[]>>({});

  // Drawer state delegated to useWorkspacePanels.
  // 外部编辑器适配器：将 desktopApi 包装为 WorkspaceExternalEditorAdapter，
  // 供 useWorkspacePanels 的 loadExternalEditors / openProjectInExternalEditor 使用。
  const editorsAdapter = useMemo<WorkspaceExternalEditorAdapter>(() => ({
    list: () => api.editors.list(),
    openProject: (editor, projectPath) => api.editors.openProject(editor, projectPath),
  }), []);
  const workspace = useWorkspacePanels({ projectId: activeProjectId, editors: editorsAdapter });
  const drawer = workspace.drawer;
  const drawerCollapsed = workspace.drawerCollapsed;
  // 与 main 一致：右侧栏开关优先折叠/展开当前抽屉；无抽屉时默认打开 files
  const toggleRightDrawer = useCallback(() => {
    if (workspace.drawer && !workspace.drawerCollapsed) {
      workspace.collapseDrawer();
      return;
    }
    if (workspace.drawer && workspace.drawerCollapsed) {
      workspace.expandDrawer();
      return;
    }
    workspace.openDrawer("files");
  }, [workspace]);
  const drawerPinned = workspace.drawerPinned;
  const browserFullscreen = workspace.browserFullscreen;
  const externalEditors = workspace.externalEditors;
  const editorsOpen = workspace.externalEditorsOpen;
  const editorsAnchor = workspace.externalEditorsAnchor;
  const editorsTargetPath = workspace.externalEditorsTargetPath;
  // Adapters for useFileEditor (expects setDrawer/setDrawerCollapsed).
  const setDrawer = useCallback((panel: WorkspaceDrawerPanel | null) => {
    // Open guard for git is handled by the enableGitManagement effect below.
    if (panel) workspace.openDrawer(panel);
    else workspace.closeDrawer();
  }, [workspace.openDrawer, workspace.closeDrawer]);
  const setDrawerCollapsed = useCallback((collapsed: boolean) => {
    if (collapsed) workspace.collapseDrawer();
    else workspace.expandDrawer();
  }, [workspace.collapseDrawer, workspace.expandDrawer]);
  const saveExpandedDirs = useCallback((projectId: string, dirs: Set<string>) => {
    try {
      localStorage.setItem(PROJECT_EXPANDED_DIRS_KEY_PREFIX + projectId, JSON.stringify([...dirs]));
    } catch { /* ignore */ }
  }, []);

  const loadExpandedDirs = useCallback((projectId: string): Set<string> => {
    try {
      const key = PROJECT_EXPANDED_DIRS_KEY_PREFIX + projectId;
      let raw = localStorage.getItem(key);
      if (!raw) {
        const legacyAgents = agentsRef.current.filter((a) => a.projectId === projectId).map((a) => a.id);
        for (const agentId of legacyAgents) {
          const oldKey = `pid:agent-expanded-dirs:${agentId}`;
          const value = localStorage.getItem(oldKey);
          if (value) {
            if (!localStorage.getItem(key)) localStorage.setItem(key, value);
            localStorage.removeItem(oldKey);
            raw = value;
            break;
          }
        }
      }
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return new Set(arr);
      }
    } catch { /* ignore */ }
    return new Set();
  }, []);
  /** 打开文件编辑器前所在的抽屉面板，供返回按钮恢复 */
  const [sessionsProjectId, setSessionsProjectId] = useState<string>();
  const [projectResourcesProject, setProjectResourcesProject] = useState<Project | null>(null);
  const sessions = useAtomValue(
    sessionSummariesByProjectIdAtomFamily(sessionsProjectId ?? ""),
  );

  // ===== 项目同步 hook (H3) =====
  const {
    worktreesByProject,
    branchByProject,
    files,
    setFiles,
    gitInfo,
    setGitInfo,
    setSessionLoadingByProject,
    setVisibleProjectChildCountByProject,
    refreshProjects,
    refreshWorktrees,
    refreshProjectSessions,
    refreshFiles,
    refreshProjectTree,
  } = useProjectSync({
    projects,
    activeProjectId,
    setProjects,
    setActiveProjectId,
    replaceProjectSessions,
    api: {
      projects: { list: api.projects.list },
      git: { worktreeList: api.git.worktreeList, branches: api.git.branches },
      sessions: { listCatalog: api.sessions.listCatalog },
      files: { list: api.files.list },
    },
    showToast,
    setSessionCatalogLoadState,
    t,
  });

  // 回答结束后的会话列表后台静默刷新：500ms 尾沿去抖。
  // 多个 Agent 同时结束回答时只扫描一次，避免重复 IPC 与列表抖动。
  const answerEndRefreshTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const scheduleAnswerEndRefresh = useCallback((projectId: string) => {
    const existing = answerEndRefreshTimerRef.current[projectId];
    if (existing) clearTimeout(existing);
    answerEndRefreshTimerRef.current[projectId] = setTimeout(() => {
      delete answerEndRefreshTimerRef.current[projectId];
      void refreshProjectSessions(projectId, true).catch(() => undefined);
    }, 500);
  }, [refreshProjectSessions]);

  // === import flow hook ===
  const {
    codexImportProject,
    setCodexImportProject,
    claudeImportProject,
    setClaudeImportProject,
    openCodeImportProject,
    setOpenCodeImportProject,
    codexImportController,
    claudeImportController,
    openCodeImportController,
    openCodexImport,
    openClaudeImport,
    openOpenCodeImport,
  } = useImportFlow({
    setProjectMenu: () => undefined,
    refreshProjectSessions,
    showToast,
    scanCodexSessions: api.codexSessions.scan,
    importCodexSessionsApi: api.codexSessions.import,
    scanClaudeSessions: api.claudeSessions.scan,
    importClaudeSessionsApi: api.claudeSessions.import,
    scanOpenCodeSessions: api.openCodeSessions.scan,
    importOpenCodeSessionsApi: api.openCodeSessions.import,
    t,
  });

  const rename = useRename({
    renameAgent: async (id, name) => {
      const agent = agentsRef.current.find((candidate) => candidate.id === id);
      const sessionId = store.get(sessionIdByRuntimeAgentIdAtomFamily(id));
      if (!agent || !sessionId) throw new Error("Session runtime is not bound");
      const updated = await api.sessions.updateRecord(sessionId, { title: name });
      upsertSession(updated);
      return { ...agent, title: updated.title };
    },
    renameSession: (id, name) => api.sessions.updateRecord(id, { title: name }),
    showToast,
    refreshProjectSessions,
    closeAgentMenu: () => undefined,
  });

  const getProjectSessionRecords = (projectId: string) =>
    store.get(sessionRecordsByProjectIdAtomFamily(projectId));
  const getSessionRecord = (sessionId: string) =>
    store.get(sessionRecordByIdAtomFamily(sessionId));
  const getRuntimeTargetForSession = (sessionId: string | undefined) =>
    sessionId
      ? toSessionRuntimeTarget(sessionId, store.get(sessionRuntimeBySessionIdAtomFamily(sessionId)))
      : undefined;
  const getRuntimeTargetForAgent = (agentId: string | undefined) => {
    if (!agentId) return undefined;
    const sessionId = store.get(sessionIdByRuntimeAgentIdAtomFamily(agentId));
    return getRuntimeTargetForSession(sessionId);
  };
  const [sessionHistoryLoading, setSessionHistoryLoading] = useState(false);
  const appUpdate = useAppUpdateController({
    checkUpdate: api.app.checkUpdate,
    downloadUpdate: (asset) => api.app.downloadUpdate(asset),
    installUpdate: (filePath) => api.app.installUpdate(filePath),
    onUpdateProgress: (cb) => api.app.onUpdateProgress(cb),
    openExternal: (url) => api.app.openExternal(url),
  }, false);

  // upToDateVersion: hook does not expose this; used by AppUpdateOverlay for "up to date" toast.
  const [upToDateVersion, setUpToDateVersion] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);

  const PROJECT_EXPANDED_DIRS_KEY_PREFIX = "pid:project-expanded-dirs:";

  // localStorage 只负责首屏；展开项目的权威设置必须等首次 settings.get 返回后才参与迁移。
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [expandedProjectsReady, setExpandedProjectsReady] = useState(false);
  const [settings, setSettings] = useState<AppSettings>({
    useNativeTitleBar: true,
    showNativeMenu: false,
    sendShortcut: "enter-send",
    theme: "system",
    accent: "default",
	themeSkin: "classic-green",
	customThemeOverrides: {},
	backgroundImage: "",
	backgroundImageOpacity: 0.8,
    language: "system",
    startupWindowMode: "last",
    piEnvironmentChecked: false,
    enableGitManagement: true,
    gitCommitMessagePrompt: "请根据以下 git diff 生成一条中文 git commit message。\n\n变更描述：\n{diff}\n\nGitmoji 对应关系：\n✨ feat - 新功能\n🐛 fix - Bug 修复\n📚 docs - 文档更新\n💎 style - 代码格式\n♻️ refactor - 重构\n🧪 test - 测试\n🔧 chore - 构建/工具",
    gitCommitMessageProvider: "",
    gitCommitMessageModel: "",
    closeToTray: true,
    singleInstance: true,
    enableNotifications: true,
    // showThinking 由 pi agent 的 hideThinkingBlock 控制，启动后从主进程加载的真实值会覆盖此处
    showThinking: true,
    showDevTools: false,
    // Electron Chromium 沙箱默认关，与主进程历史兼容策略一致
    electronChromiumSandbox: false,
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
    contentMaxWidth: 1800,
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
    fontSize: "medium",
    uiFontSize: null,
    chatFontSize: null,
    inputFontSize: null,
    zoomFactor: 1,
    fontFamilyBase: "system",
    fontFamilyBaseCustom: "",
    fontFamilyMono: "commit-mono",
    fontFamilyMonoCustom: "",
    removedBuiltInExtensions: [],
    disableUpdateCheck: false,
    piRpcOffline: true,
    piRpcNoExtensions: false,
    piRpcNoSkills: false,
  });

  // 实验浏览器开关（#115 U4）：WebContentsView 灰度
  const setWebContentsViewBrowser = useSetAtom(useWebContentsViewBrowserAtom);
  useEffect(() => {
    setWebContentsViewBrowser(Boolean(settings.useWebContentsViewBrowser));
  }, [settings.useWebContentsViewBrowser, setWebContentsViewBrowser]);

  // Guard: hide git drawer when git management is disabled.
  // Equivalent to: if (panel === "git" && !settings.enableGitManagement) return
  // Pinned cleanup (filter(([, panel]) => panel !== "git")) is handled inside useWorkspacePanels.
  useEffect(() => {
    if (settings.enableGitManagement) return;
    // setDrawer((current) => current === "git" ? null : current)
    if (drawer === "git") workspace.closeDrawer();
  }, [settings.enableGitManagement, drawer, workspace.closeDrawer]);

  /* settingsNotice 已改用 showToast（sonner）实现 */
  const [webServiceChanging, setWebServiceChanging] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo>({
    version: "-",
    releasesUrl: "https://github.com/ayuayue/pi-desktop/releases",
    platform: "win32",
    homeDir: "",
  });
  const [systemLanguage, setSystemLanguage] = useState<string | null>(null);
  const resolvedLocale = resolveLocale(settings.language, systemLanguage ?? undefined);
  setI18nLocale(resolvedLocale);

  // ===== Pi 更新/安装/代理 hook (H1) =====
  const piUpdate = usePiUpdate({
    settings,
    setSettings,
    showToast,
    api,
  });
  const { piStatus, piChecking, environmentDialog, setPiStatus, setEnvironmentDialog } = piUpdate;
  const [drawerWidth, setDrawerWidth] = useState(320);
  const [composerOffsetHeight, setComposerOffsetHeight] = useState(0);
  const {
    terminalOpen,
    terminalCollapsed,
    terminalDockVisible,
    terminalDockClosing,
    terminalRowHeight: activeTerminalHeight,
    setTerminalOpenForAgent,
    setTerminalCollapsedForAgent,
    setTerminalHeightByAgent,
    prune: pruneTerminalDockState,
  } = useTerminalDock(activeAgentId);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [, setBranchByProject] = useState<Record<string, string | null>>({});
  const [expandedSidebarProjects, setExpandedSidebarProjects] = useState<Set<string>>(new Set());
  const expandedSidebarProjectsRef = useRef(expandedSidebarProjects);
  expandedSidebarProjectsRef.current = expandedSidebarProjects;
  const expandedSidebarFromSettingsRef = useRef(false);
  function saveExpandedSidebarProjectsToLocal(next: Set<string>) {
    try {
      localStorage.setItem("pidek.sidebarExpandedProjectIds", JSON.stringify([...next]));
    } catch {
      // ignore
    }
  }
  const sessionComboRef = useRef<HTMLDivElement | null>(null);
  const queuedTrackRef = useRef<HTMLDivElement | null>(null);

  const composerTextareaRef = useRef<HTMLDivElement | null>(null);
  // RichInput 受控重渲染后,光标应恢复到的纯文本偏移(供建议选中/清除后恢复选区)。
  const pendingComposerCaretRef = useRef<number | null>(null);
  const pendingAgentsRef = useRef<PendingAgentTab[]>([]);

  const scratchPad = useScratchPad();

  // Drawer loading handled by useWorkspacePanels; only expandedDirs logic remains.
  useEffect(() => {
    if (!activeProjectId) {
      setExpandedDirs(new Set());
      return;
    }
    const dirs = loadExpandedDirs(activeProjectId);
    setExpandedDirs(dirs);
  }, [activeProjectId, loadExpandedDirs]);

  const activeProjectRuntimeCapabilities = useProjectRuntimeCapabilities(activeProjectId);
  const activeProject = projects.find(
    (project) => project.id === activeProjectId,
  );
  const overlays = useOverlayActions({ activeProject, appInfo, showToast });
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

  // === worktree actions hook ===
  const {
    worktreeCreating,
    removingWorktreePaths,
    createWorktree,
    removeWorktree,
    requestRemoveWorktree,
    toggleProjectWorktree,
  } = useWorktreeActions({
    projects,
    displayAgents,
    setProjects,
    refreshWorktrees,
    overlays,
  });

  // displayAgents 的 ref，供只挂载一次的 IPC 监听器读取最新 Agent 列表，避免闭包陈旧
  const displayAgentsRef = useRef(displayAgents);
  displayAgentsRef.current = displayAgents;
  // prompt history persistence lives in session composer controller (session-first).
  // 查看器已移除：activeAgent 直接从 displayAgents / pendingAgents 取，不再有伪 Agent。
  const activeAgent = activeAgentId
    ? [...displayAgents, ...pendingAgents].find((agent) => agent.id === activeAgentId)
    : undefined;

  // Timeline scroll, pagination and jump ownership lives in sessionTimeline.
  // Modern Session drafts and attachments are subscribed by ComposerArea; the root only
  // keeps the legacy queue adapter for agents that do not yet have a Session record.
  function setPromptForAgent(
    agentId: string,
    value: string | ((current: string) => string),
  ) {
    const targetAgentId = agentId;
    const previous = livePromptByAgentRef.current[targetAgentId] ?? "";
    const nextValue = typeof value === "function" ? value(previous) : value;
    if (nextValue) livePromptByAgentRef.current[targetAgentId] = nextValue;
    else delete livePromptByAgentRef.current[targetAgentId];
    setSessionDraft({ sessionId: targetAgentId, value: nextValue });
  }


  function getComposerTargetId() {
    return currentSessionIdRef.current ?? activeAgentIdRef.current;
  }


  function setPrompt(value: string | ((current: string) => string)) {
    const targetId = getComposerTargetId();
    if (targetId) setPromptForAgent(targetId, value);
  }

  // Queue ownership extracted to useQueuedPrompt.
  const queue = useQueuedPrompt({
    displayAgentsRef,
    queueFlushBySessionRef,
    composerTextareaRef,
    pendingComposerCaretRef,
    store,
    setComposerCursor: (v: React.SetStateAction<number>) => { /* no-op: cursor managed by composer controller */ },
    showToast,
    unknownDeliveryMessage: t("app.queuedUnknown"),
    dispatchPromptSnapshot,
  });
  useSessionRuntimeBridge({
    onRuntimeCapabilityChanged: ({ sessionId, previous, current, patch }) => {
      if (
        previous?.isExecutingTool &&
        !current.isExecutingTool &&
        (patch.toolStateSequence == null ||
          previous.toolStateSequence == null ||
          patch.toolStateSequence >= previous.toolStateSequence) &&
        queue.isSessionRuntimeBusy(sessionId)
      ) {
        void queue.flushQueuedSteerPrompts(sessionId);
      }
      // 回答结束（流式停止）后后台静默刷新该会话所属项目的历史会话：
      // 子 Agent 会话由扩展直接写盘，只在回答结束时刷新能保证列表最新且无手动刷新成本。
      // refreshProjectSessions 内部会合并并发请求，多个 Agent 同时结束时不会重复扫描。
      if (previous?.isStreaming && !current.isStreaming) {
        const projectId = store.get(sessionRecordByIdAtomFamily(sessionId))?.projectId;
        if (projectId) {
          scheduleAnswerEndRefresh(projectId);
        }
      }
    },
  });
  const activeQueuedPrompts = currentSessionId
    ? (queue.queuedPrompts[currentSessionId] ?? [])
    : [];

  const enqueueSessionPrompt = useCallback((
    sessionId: string,
    snapshot: { displayText: string; message: string; images?: ImageContent[]; agentMode: string; behavior?: "steer" | "followUp" },
  ) => {
    if (!store.get(sessionRuntimeBySessionIdAtomFamily(sessionId))?.agentId) return false;
    return queue.enqueueQueuedPrompt(sessionId, {
      id: crypto.randomUUID(),
      message: snapshot.message,
      displayText: snapshot.displayText,
      images: snapshot.images,
      behavior: snapshot.behavior ?? "steer",
      agentMode: snapshot.agentMode as ComposerAgentMode,
      timestamp: Date.now(),
    });
  }, [store, queue.enqueueQueuedPrompt]);

  /** 空会话快捷操作只负责填入当前 composer；用户仍可修改 prompt 后再点击发送。 */
  const insertQuickPrompt = useCallback((sessionId: string, message: string) => {
    setSessionDraft({ sessionId, value: message });
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(".composer-box .rich-input")?.focus();
    });
  }, [setSessionDraft]);

  const activeMessages = sessionTimeline.messages;
  // activeConversationStatus / activeRuntimeState replaced by sync isAgentCurrentlyBusy().
  // The built-in Chat uses a renderer-only Session ID before its first send.
  // Workspace chrome belongs to that visible conversation surface, not only to
  // persisted catalog records; otherwise Chat loses the dev-equivalent toolbar.
  const hasActiveConversation = Boolean(currentSessionId);

  // Timeline scroll, pagination and jump ownership lives in sessionTimeline.
  const activeProjectHasBusyAgent = Boolean(
    activeProjectId && displayAgents.some((agent) =>
      agent.projectId === activeProjectId && (
        agent.status === "starting" ||
        agent.status === "running" ||
        activeProjectRuntimeCapabilities[agent.id]?.isStreaming ||
        activeProjectRuntimeCapabilities[agent.id]?.isExecutingTool
      ),
    ),
  );
  const activeProjectSessionSyncKey = useMemo(() => {
    if (!activeProjectId) return "";
    return displayAgents
      .filter((agent) => agent.projectId === activeProjectId)
      .map((agent) => {
        const runtime = activeProjectRuntimeCapabilities[agent.id];
        return `${agent.id}:${agent.status}:${runtime?.isStreaming ? 1 : 0}:${runtime?.isExecutingTool ? 1 : 0}`;
      })
      .sort()
      .join("|");
  }, [activeProjectId, activeProjectRuntimeCapabilities, displayAgents]);


  // Runtime UI responses are generation-bound in SessionRuntimeUiOverlay.
  // Runtime notifications remain owned by useSessionRuntimeController.

  // Runtime editor text is applied by useSessionComposerController, which owns the draft guard.

  // Layout calculation delegated to useSessionLayout (refs + ResizeObserver + math).
  const sessionLayout = useSessionLayout({
    terminalRequestedHeight: activeTerminalHeight,
    terminalOpen,
    terminalClosing: terminalDockClosing,
    terminalCollapsed,
    queuedPromptCount: activeQueuedPrompts.length,
  });
  const {
    chatPaneRef: sessionChatPaneRef,
    headerRef: sessionHeaderRef,
    composerRef: sessionComposerRef,
    terminalRowHeight,
    availableTerminalHeight,
  } = sessionLayout;

  // Alias hook refs to the names App.tsx expects.
  const chatPaneRef = sessionChatPaneRef;
  const chatHeaderRef = sessionHeaderRef;
  const composerRef = sessionComposerRef;

  const visibleQueuedPrompts = activeQueuedPrompts;

  const {
    listWidth,
    setListWidth,
    listCollapsed,
    setListCollapsed,
    toggleListCollapsed,
  } = useResize();
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
      // 主题色预设：data-accent 驱动 foundation.css 的 accent/logo 变量
      document.documentElement.dataset.accent = settings.accent;
      // 皮肤（换肤）：data-skin 记录当前皮肤 id（变量覆盖在下方 effect 注入）
      document.documentElement.dataset.skin = settings.themeSkin;
    };
    applyTheme();
    if (settings.theme !== "system" || !media) return;
    media.addEventListener?.("change", applyTheme);
    return () => media.removeEventListener?.("change", applyTheme);
    // 依赖 theme 与 accent：只改主题色时也必须重新应用 data-accent（否则界面不变）
  }, [settings.theme, settings.accent, settings.themeSkin]);

  // 皮肤 + 换肤背景图统一管理（原两个 effect 互相清除：皮肤 effect 清 token 时误清壁纸注入、
  // 背景 effect 的 else 分支又误清皮肤 bg 键——合并后顺序固定：先皮肤后壁纸覆盖）
  useEffect(() => {
    const root = document.documentElement;
    const isDark = root.dataset.theme === "dark";
    const BG_TOKENS = ["--color-bg-app", "--color-bg-sidebar", "--color-bg-panel", "--color-bg-muted", "--color-bg-hover", "--color-bg-active", "--color-background", "--color-card"];

    // 1. 皮肤变量：先清所有皮肤预设可能触及的键，再应用当前皮肤（light/dark 色板）+ 自定义覆盖
    const skinKeys = new Set<string>();
    for (const p of SKIN_PRESETS) {
      Object.keys(p.light).forEach((k) => skinKeys.add(k));
      Object.keys(p.dark).forEach((k) => skinKeys.add(k));
    }
    Object.keys(settings.customThemeOverrides ?? {}).forEach((k) => skinKeys.add(k));
    for (const k of skinKeys) root.style.removeProperty(`--color-${k}`);
    // 内置 skin 选项已合并进 accent 外观主题；只保留 custom override 的兼容读取，
    // 避免用户同时面对两套互相叠加的背景/边框配置。
    const merged = {
      ...(settings.customThemeOverrides ?? {}),
    };
    for (const [k, v] of Object.entries(merged)) root.style.setProperty(`--color-${k}`, v);

    // 2. 换肤背景图：遮罩同色渐变（浅白/暗黑）+ 壁纸模式 token 半透明注入。
    //    存储语义=图片可见度（0=全遮，1=图全显）；滑块 80% → 遮罩 0.2 → 图 80% 透出。
    root.dataset.bgImage = settings.backgroundImage ? "on" : "off";
    if (settings.backgroundImage) {
      root.style.setProperty(
        "--app-bg-image",
        `url("pideck-bg://local/${encodeURIComponent(settings.backgroundImage)}")`,
      );
      const alpha = Math.min(1, Math.max(0, 1 - settings.backgroundImageOpacity));
      // 面板不透明度与遮罩同步并加 10% 基础偏移（面板更实一点，可读性更好）：
      // 滑块 80% → 面板 30%；100% → 10%（图完整显示）；0% → 100%（纯色）
      const panelMix = Math.min(100, Math.round(alpha * 100) + 10);
      const rgb = isDark ? "0,0,0" : "255,255,255";
      root.style.setProperty(
        "--app-bg-mask",
        `linear-gradient(rgba(${rgb},${alpha}), rgba(${rgb},${alpha}))`,
      );
      // 半透明 token：getComputedStyle 取当前计算值（含皮肤覆盖）→ 静态 color-mix，无循环引用。
      // 壁纸模式下所有面板统一用 --color-bg-app 作基色 + 同一个 panelMix，
      // 保证侧栏/会话区/抽屉透出的图片明暗完全一致
      const cs = getComputedStyle(root);
      const base = cs.getPropertyValue("--color-bg-app").trim();
      // 供弹窗覆盖规则使用：纯色基色 + 面板不透明度（弹窗 = 面板 + 10% 更实）
      if (base) root.style.setProperty("--wallpaper-base", base);
      root.style.setProperty("--wallpaper-panel-alpha", `${panelMix}%`);
      for (const k of BG_TOKENS) {
        const v = cs.getPropertyValue(k).trim();
        if (v) {
          root.style.setProperty(k, `color-mix(in srgb, ${base} ${panelMix}%, transparent)`);
          injectedWallpaperTokens.add(k);
        }
      }
    } else {
      root.style.removeProperty("--app-bg-image");
      root.style.removeProperty("--app-bg-mask");
      // 只清本 effect 注入过的壁纸 token，绝不误清皮肤设置的 bg 键
      for (const k of injectedWallpaperTokens) root.style.removeProperty(k);
      injectedWallpaperTokens.clear();
      root.style.removeProperty("--wallpaper-base");
      root.style.removeProperty("--wallpaper-panel-alpha");
    }
  }, [settings.themeSkin, settings.theme, settings.customThemeOverrides, settings.backgroundImage, settings.backgroundImageOpacity]);

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
  // === file editor hook ===
  const {
    editorMode,
    toggleEditorMode,
    editorTabs,
    activeTabId,
    activeTab,
    readEditorFileContent,
    readEditorOriginalContent,
    saveEditorFileContent,
    closeEditorTab,
    selectEditorTab,
    openFilePath,
    viewFilePath,
    diffFilePath,
    openWorkspaceFileDiff,
    openCommitFileDiff,
    closeGitDiff,
    gitDiffDisplayMode,
    gitDrawerDiff,
    toggleGitDiffDisplayMode,
    prevDrawerPanelRef,
    clearEditorBack,
    closeEditor,
  } = useFileEditor({
    activeProjectId,
    activeProjectIdRef,
    activeAgent: activeAgent ?? null,
    activeProject: activeProject ?? null,
    drawer,
    modifiedFiles,
    setDrawer,
    setDrawerCollapsed,
    showToast,
    readFileContent: api.files.readContent,
    readGitOriginalContent: api.git.originalContent,
    writeFileContent: api.files.writeContent,
    openFile: api.files.open,
    workspaceFileDiff: api.git.workspaceFileDiff,
    commitFileDiff: api.git.commitFileDiff,
    t,
  });

  // 会话内文件链接打开路由：按扩展名分级——
  // 图片 → 弹窗预览（readBase64 → ImagePreviewModal）；markdown/html → 抽屉查看
  //（FileDiffViewer 对 .md 默认 preview、.html 用 HtmlPreview 内置渲染）；其他文件 → 编辑器打开。
  // 替代原先的"系统默认应用打开"（.md 会被浏览器接管、体验割裂）
  const handleOpenLinkedFile = useCallback(
    (path: string) => {
      const resolved = resolveFileLinkPath(
        path,
        activeAgent?.cwd ?? activeProject?.path,
      );
      const ext = resolved.split(".").pop()?.toLowerCase() ?? "";
      if (IMAGE_EXTENSIONS.has(ext)) {
        // 图片：读取二进制 → 弹窗预览
        void api.files
          .readBase64(resolved)
          .then((dataUrl) => {
            const m = dataUrl.match(/^data:(.*?);base64,(.*)$/s);
            if (m) setPreviewImage({ type: "image", mimeType: m[1], data: m[2] });
          })
          .catch(() => showToast(t("app.openFileFailed", { error: ext })));
        return;
      }
      // markdown / html / 其他文本文件：统一抽屉查看
      viewFilePath(resolved);
    },
    [activeAgent?.cwd, activeProject?.path, viewFilePath, showToast],
  );

  // 工具抽屉（files/git/browser）的统一切换语义：当前面板已展开 → 关闭；
  // 其余情况打开/切到目标面板。outline 浮动按钮与抽屉活动栏共用同一套语义，
  // 保证两个入口行为一致。注意必须放在 useFileEditor 之后（依赖 gitDrawerDiff）。
  const handleToolDrawerAction = useCallback((panel: WorkspaceDrawerPanel) => {
    if (workspace.drawer === panel && !workspace.drawerCollapsed) {
      if (panel === "git" && gitDrawerDiff) {
        closeGitDiff();
        return;
      }
      workspace.closeDrawer();
    } else {
      if (panel === "files" && activeProjectId) void refreshFiles(activeProjectId, true);
      workspace.openDrawer(panel);
    }
  }, [workspace, gitDrawerDiff, closeGitDiff, activeProjectId, refreshFiles]);

  const {
    selectProject: selectProjectCommand,
    selectSession: selectSessionCommand,
    copySession: runCopySession,
    exportHistorySession: runExportHistorySession,
    deleteHistorySession: runDeleteHistorySession,
    openSidebarSession: runOpenSidebarSession,
    openSidebarSessionById: runOpenSidebarSessionById,
    copySidebarSession: runCopySidebarSession,
    exportSidebarSession: runExportSidebarSession,
    createSessionDraft: runCreateSessionDraft,
    createAnonymousSession: runCreateAnonymousSession,
  } = useSessionActions({
    openSessionRequestRef,
    creatingSessionDraftRef,
    activeProjectId,
    sessionsProjectId,
    projects,
    setActiveProjectId,
    setCurrentSessionId,
    getSessionRecord,
    getProjectSessionRecords,
    upsertSession,
    removeSessionState,
    removeSessionComposerState,
    refreshProjectSessions,
    api,
    showToast,
    // 任何路径打开会话（侧栏/标题栏/引导恢复）都在 Tab 栏登记，
    // 用户可在 Tab 间快速切换而无需回侧栏找
    onSessionSelected: openSessionTab,
  });

  // ── 会话 Tab 栏状态（浏览器式多 Tab）──
  // 关闭 Tab 只移除列表项，不 kill Agent；再次打开同一会话时复用已绑定运行时。
  const PINNED_TABS_STORAGE_KEY = "pideck.pinnedSessionTabIds";
  const sessionTabIds = useAtomValue(sessionTabIdsAtom);
  const setSessionTabIds = useSetAtom(sessionTabIdsAtom);
  const sessionRecordsForTabs = useAtomValue(sessionRecordsAtom);
  // 固定 Tab 集合：localStorage 持久化（会话重开时自动恢复固定状态）
  const [pinnedSessionTabIds, setPinnedSessionTabIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(PINNED_TABS_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === "string")
        : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(PINNED_TABS_STORAGE_KEY, JSON.stringify(pinnedSessionTabIds));
    } catch {
      // 持久化失败不影响功能
    }
  }, [pinnedSessionTabIds]);
  // 固定集合随 Tab 清理：被删除会话的固定记录一并移除
  useEffect(() => {
    setPinnedSessionTabIds((current) => {
      const next = current.filter((id) => Boolean(sessionRecordsForTabs[id]));
      return next.length === current.length ? current : next;
    });
  }, [sessionRecordsForTabs]);

  /** 打开会话时在 Tab 栏登记（幂等）；首个会话自动登记后 Tab 栏才出现 */
  function openSessionTab(sessionId: string) {
    // 引导恢复/自动选中发生在 App 挂载早期，同样登记，保证 Tab 栏与会话视图一致
    setSessionTabIds((current) =>
      current.includes(sessionId) ? current : [...current, sessionId],
    );
  }

  // 会话被删除（记录消失）时自动清理对应 Tab；currentSessionId 的清理由 removeSessionStateAtom 负责
  useEffect(() => {
    setSessionTabIds((current) => {
      const next = current.filter((id) => Boolean(sessionRecordsForTabs[id]));
      return next.length === current.length ? current : next;
    });
  }, [sessionRecordsForTabs, setSessionTabIds]);

  /** 关闭单个 Tab：仅移除列表；若关闭的是当前会话，切到相邻 Tab（不 kill Agent） */
  function closeSessionTab(sessionId: string) {
    const remaining = sessionTabIds.filter((id) => id !== sessionId);
    setSessionTabIds(remaining);
    if (currentSessionId !== sessionId) return;
    if (remaining.length > 0) {
      // 优先切到右侧相邻 Tab，保持阅读位置连续；没有右侧才取左侧
      const index = sessionTabIds.indexOf(sessionId);
      const next = remaining[Math.min(index, remaining.length - 1)];
      const record = store.get(sessionRecordByIdAtomFamily(next));
      if (record) {
        selectSessionCommand(record.projectId, next, true);
      }
    } else if (activeProjectId) {
      // 无剩余 Tab 时回到项目空态（走命令路由，不直接改 currentSessionId）
      selectProjectCommand(activeProjectId);
    }
  }

  function closeOtherSessionTabs(sessionId: string) {
    setSessionTabIds((current) =>
      current.filter((id) => id === sessionId),
    );
  }

  function closeAllSessionTabs() {
    setSessionTabIds([]);
    // 全部关闭后回到项目空态；Agent 进程保持运行，会话仍可从侧栏重新打开
    if (activeProjectId) selectProjectCommand(activeProjectId);
  }

  /** 固定/取消固定 Tab：状态转换由纯函数维护（保持 pinned 前置不变量） */
  function togglePinSessionTab(sessionId: string) {
    const next = togglePinSessionTabList(sessionTabIds, pinnedSessionTabIds, sessionId);
    setSessionTabIds(next.tabs);
    setPinnedSessionTabIds(next.pinned);
  }

  /** 拖拽排序：区间内重排，交叉拖动自动转换固定状态 */
  function reorderSessionTab(sourceId: string, targetId: string, position: "before" | "after") {
    const next = reorderSessionTabList(sessionTabIds, pinnedSessionTabIds, sourceId, targetId, position);
    setSessionTabIds(next.tabs);
    setPinnedSessionTabIds(next.pinned);
  }

  useEffect(() => {
    if (!activeProject) return;
    const action = resolveChatSessionBootstrap({
      isChatProject: isChatProject(activeProject),
      currentSessionId,
      catalogStatus: store.get(sessionCatalogLoadStateAtom)[activeProject.id]?.status,
    });
    if (action.kind === "load") {
      void refreshProjectSessions(activeProject.id).catch(() => undefined);
    }
  }, [
    activeProject,
    currentSessionId,
    refreshProjectSessions,
    selectSessionCommand,
    store,
  ]);

  // 聊天项目点开后与普通项目一致，先进统一引导页；用户从引导页选择
  // 「新建 Agent / 匿名聊天」时通过 createSessionDraft / createAnonymousSession
  // 创建真实 Catalog 会话，因此发送钩子不再需要把 renderer-only 虚拟会话提升为真实会话，
  // 直接透传传入的 sessionId（保持签名以兼容 composer 链路）。
  const ensureSessionForSend = useCallback(
    async (sessionId: string) => sessionId,
    [],
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

  const projectIdsKey = useMemo(
    () => projects.map((project) => project.id).join("\n"),
    [projects],
  );

  function handleAgentInventoryChanged(nextAgents: AgentTab[]) {
    const previousPendingAgents = pendingAgentsRef.current;
    const remainingPendingAgents = previousPendingAgents.filter(
      (pending) => !nextAgents.some((agent) =>
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
    const draftIds = new Set([
      ...nextAgents.map((agent) => agent.id),
      ...remainingPendingAgents.map((agent) => agent.id),
    ]);
    // 终端状态清理统一由下方 useEffect([displayAgents]) 的 prune 负责：
    // 此处再调一次会在流式 runtime 更新时与 displayAgents effect 重复执行，
    // 形成不必要的 setState 链（历史日志：发送消息后 Maximum update depth）。
    livePromptByAgentRef.current = migrateAgentRecord(
      livePromptByAgentRef.current,
      pendingReplacementById,
      draftIds,
    );
  }

  useEffect(() => {
    handleAgentInventoryChanged(agents);
  }, [agents]);

  const bootstrapProps = {
    onProjectsChanged: (next: Project[]) => {
      if (!activeProjectId && next.length > 0) setActiveProjectId(next[0].id);
    },
    onSettingsApplied: (next: AppSettings) => {
      setSettings(next);
      showToast(t("settings.restartNotice"));
    },
    onOpenInBrowser: (url: string) => {
      // 外部链接必须强制打开 browser 面板（openDrawer 是 toggle 语义，
      // 已是 browser 展开时会关抽屉，导致首次点击关抽屉、二次重复入栈）
      workspace.openDrawerForce("browser");
      navigateTo(url);
    },
    onTrustRequest: overlays.setTrustRequest,
    onFocusTarget: (target: { sessionId: string }) => {
      const session = store.get(sessionRecordByIdAtomFamily(target.sessionId));
      if (session) selectSessionCommand(session.projectId, session.id, false);
    },
  };

  useEffect(() => {
    void workspace.loadExternalEditors().catch(() => undefined);
    void api.app
      .preferredSystemLanguages()
      .then((languages) => setSystemLanguage(languages.find((language) => typeof language === "string" && language.trim()) ?? null))
      .catch(() => setSystemLanguage(null));
    void api.app
      .info()
      .then(setAppInfo)
      .catch(() => undefined);
    void api.settings.get().then((next) => {
      setSettings(next);
      setSettingsLoaded(true);
      piUpdate.setCustomPiPath(next.customPiPath ?? "");
      if (!Object.values(next.externalEditors).some((editor) => editor.command)) {
        void api.editors
          .redetect()
          .then((updated) => {
            setSettings(updated);
          })
          .then(() => workspace.loadExternalEditors())
          .catch(() => undefined);
      }
      if (!next.piEnvironmentChecked) {
        // 首次检测延后一帧启动,先让主界面完成绘制,避免 packaged app 打开时出现几秒白屏。
        window.setTimeout(() => void piUpdate.checkPiInstall("startup"), 300);
      }
      if (!next.disableUpdateCheck) {
        window.setTimeout(() => void piUpdate.checkPiCliUpdateOnStartup(), 1200);
      }
    }).catch(() => {
      // 即使 settings IPC 暂不可用，也要允许侧栏继续使用 localStorage/default 状态。
      setSettingsLoaded(true);
    });

  }, []);

  /**
   * 更新侧栏展开集合并双写持久化：
   * 1) localStorage：同步，首屏可读
   * 2) settings.json：主进程 writeFile，dev 强杀/重启也不丢
   */
  const commitExpandedSidebarProjects = useCallback((next: Set<string>) => {
    // 标记已有权威写入，防止启动时迟到的 settings.get 用旧值覆盖用户刚点的展开
    expandedSidebarFromSettingsRef.current = true;
    expandedSidebarProjectsRef.current = next;
    setExpandedSidebarProjects(next);
    saveExpandedSidebarProjectsToLocal(next);
    void api.settings
      .update({ sidebarExpandedProjectIds: [...next] })
      .then((saved) => {
        // 只合并本字段，避免覆盖用户在设置页刚改的其它项的本地缓存
        setSettings((current) => ({
          ...current,
          sidebarExpandedProjectIds: saved.sidebarExpandedProjectIds,
        }));
      })
      .catch(() => undefined);
  }, []);

  /** 展开/折叠某个项目；forceExpand=true 时只展开不切换 */
  const setProjectSidebarExpanded = useCallback(
    (projectId: string, forceExpand?: boolean) => {
      const prev = expandedSidebarProjectsRef.current;
      const next = new Set(prev);
      const shouldExpand = forceExpand ?? !next.has(projectId);
      if (shouldExpand) next.add(projectId);
      else next.delete(projectId);
      const unchanged =
        next.size === prev.size && [...next].every((id) => prev.has(id));
      if (unchanged) return next;
      commitExpandedSidebarProjects(next);
      return next;
    },
    [commitExpandedSidebarProjects],
  );

  useEffect(() => {
    const projectIds = new Set(projects.map((project) => project.id));
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
  }, [projectIdsKey]);

  useEffect(() => {
    // settings.json 覆盖首屏 localStorage 后，按最终展开集合补加载；使用 catalog load state
    // 而不是会话数量判定，空项目也只加载一次。
    if (!expandedProjectsReady) return;
    for (const project of projects) {
      if (!expandedProjects.has(project.id)) continue;
      const loadState = store.get(sessionCatalogLoadStateAtom)[project.id];
      if (loadState?.status === "loading" || loadState?.status === "ready") continue;
      void refreshProjectSessions(project.id).catch(() => undefined);
    }
  }, [expandedProjects, expandedProjectsReady, projectIdsKey, refreshProjectSessions, store]);

  useEffect(() => {
    // When update check is disabled, skip periodic and deferred auto-check.
    if (settings.disableUpdateCheck) return;
    const timer = window.setInterval(
      () => void appUpdate.check("auto"),
      1000 * 60 * 60 * 6,
    );
    window.setTimeout(() => void appUpdate.check("auto"), 5000);
    return () => window.clearInterval(timer);
  }, [settings.disableUpdateCheck]);

  useEffect(() => {
    if (activeAgentId && !isPendingAgentId(activeAgentId))
      void refreshRuntimeState(activeAgentId);
  }, [activeAgentId]);

  useEffect(() => {
    const activeIds = new Set(displayAgents.map((agent) => agent.id));
    pruneTerminalDockState(activeIds);
  }, [displayAgents]);

  useEffect(() => {
    // 折叠中的项目不跑周期扫描，避免后台无意义刷会话列表
    if (!expandedProjectsReady || !activeProjectId || !expandedProjects.has(activeProjectId)) return;
    // 进入/退出运行态时都立即扫描一次，保证最终 child session 不因最后一次写入时序而遗漏。
    let disposed = false;
    const scheduleRefresh = () => {
      if (disposed) return;
      void refreshProjectSessions(activeProjectId, true).catch(() => undefined);
    };
    scheduleRefresh();
    if (!activeProjectHasBusyAgent) {
      return () => { disposed = true; };
    }

    // 子会话由扩展直接写盘，运行期间保留低频兜底；工具 start/end 不应重置计时器并触发额外扫描。
    const timer = window.setInterval(scheduleRefresh, 15_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [activeProjectId, activeProjectHasBusyAgent, activeProjectSessionSyncKey, expandedProjects, expandedProjectsReady]);

  // Composer sizing is owned by the composer panel (react-resizable-panels) since #115 U5.
  // 待发送轨道高度变化只影响面板可用空间，不再回写 composer 高度状态。
  // composerOffsetHeight 仍由 ResizeObserver/布局效应测量，供布局兼容与旧嵌入路径保留。
  useLayoutEffect(() => {
    setComposerOffsetHeight(composerRef.current?.offsetHeight ?? 0);
  }, [activeAgentId, activeQueuedPrompts.length, composerRef]);

  // Outline jumps through the same timeline controller that owns pagination and scroll state.

  useEffect(() => {
    const target = getRuntimeTargetForSession(currentSessionId);
    if (!target) {
      setCommands([]);
      return;
    }
    void api.sessions
      .listRuntimeCommands(target)
      // goal 模式这版先不公开入口；保留底层实现,等待官方 plan/goal 能力稳定后再决定是否恢复。
      .then((result) => setCommands(requireSessionCommand(result).value))
      .catch(() => setCommands([]));
  }, [activeAgentId, currentSessionId]);

  // 持久化会话来源过滤配置
  useEffect(() => {
    try {
      saveSessionSourceFilter(sessionSourceFilter);
    } catch (error) {
      // 静默失败
    }
  }, [sessionSourceFilter]);


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
  }, [activeAgentId, displayAgents, modifiedFiles]);

  // 汇报聚焦会话给主进程：非聚焦会话收到 Ask 请求时触发桌面通知（Task 9）
  useEffect(() => {
    void api.sessions.setFocusedSession(currentSessionId).catch(() => undefined);
  }, [currentSessionId]);


  // 侧栏 π logo 业务反馈：新建/历史会话启动/关闭 agent 时重播拼装动画。
  const triggerBrandLogoReplay = useCallback(() => {
    setBrandLogoReplayToken((token) => token + 1);
  }, []);

  // 已删除内置 goal 完成检测。

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
      setGitInfo({ current: null, branches: [] });
      return;
    }

    // 切换项目时按 catalog load state 判断。空项目成功返回 [] 后也会是 ready，
    // 不能再用列表长度，否则每次选中都会重扫。
    const activeProject = projects.find((p) => p.id === activeProjectId);
    const loadState = store.get(sessionCatalogLoadStateAtom)[activeProjectId];
    if (expandedProjectsReady && activeProject && expandedProjects.has(activeProjectId) && loadState?.status !== "loading" && loadState?.status !== "ready") {
      void refreshProjectSessions(activeProjectId).catch(() => undefined);
    }

    setExpandedDirs(new Set());
    void api.files
      .list(activeProjectId)
      .then(setFiles)
      .catch((error) => console.error("[Files] refresh failed", error));
    void api.git
      .branches(activeProjectId)
      .then(setGitInfo)
      .catch(() => setGitInfo({ current: null, branches: [] }));
  }, [activeProjectId, currentSessionId, displayAgents.length]);

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
      } catch {
        if (!stopped) {
          setGitInfo({ current: null, branches: [] });
        }
      }
    };
    const timer = window.setInterval(refreshGitInfo, 4000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [activeProjectId]);

  /** 统一通知：普通消息默认 1.5 秒，异常由 kind 映射为 3 秒；Ask 使用持久 warning toast。 */
  function showToast(message: string, duration?: number, kind?: "info" | "warning" | "error") {
    showNotice(message, duration, kind);
  }

  async function cloneAgentSession(agentId: string) {
    try {
      const target = getRuntimeTargetForAgent(agentId);
      if (!target) return;
      const result = requireSessionCommand(await api.sessions.cloneRuntime(target));
      if (result?.cancelled) {
        showToast(t("app.sessionCopyCancelled"));
        return;
      }
      showToast(t("app.currentSessionCopied"));
      await refreshRuntimeState(agentId);
      const projectId = agents.find((agent) => agent.id === agentId)?.projectId ?? activeProjectId;
      if (projectId) await refreshProjectSessions(projectId);
      if (result.targetSessionId && projectId) {
        selectSessionCommand(projectId, result.targetSessionId, true);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 5000);
    }
  }

  async function deleteDraftSession(session: SessionRecord) {
    try {
      await api.sessions.deleteRecord(session.id);
      // A false result means another path already removed the catalog record;
      // clear the stale sidebar row the same way as a successful deletion.
      removeSessionState(session.id);
      removeSessionComposerState(session.id);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 4000);
    }
  }

  async function reorderProjects(
    sourceProjectId: string,
    targetProjectId: string,
  ) {
    if (sourceProjectId === targetProjectId) return;
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

  async function addProject() {
    const project = await api.projects.add();
    if (!project) return;
    await refreshProjects();
    setActiveProjectId(project.id);
  }

  function updateAfterProjectRemoved(
    removedProjectId: string,
    next: Project[],
  ) {
    setVisibleProjectChildCountByProject((current) => {
      const updated = { ...current };
      delete updated[removedProjectId];
      return updated;
    });
    if (activeProjectId === removedProjectId) {
      setActiveProjectId(next[0]?.id);
    }
    if (sessionsProjectId === removedProjectId) {
      setSessionsProjectId(undefined);
      if (drawer === "sessions") workspace.closeDrawer();
    }
  }

  function applyAgentRuntimeState(agentId: string, incoming: AgentRuntimeState) {
    const target = getRuntimeTargetForAgent(agentId);
    if (!target) return undefined;
    applyRuntimeEvent({
      ...target,
      sourceChannel: "agents:runtime-state",
      payload: { agentId, state: incoming },
    });
    return store.get(sessionRuntimeBySessionIdAtomFamily(target.sessionId))?.state;
  }

  async function refreshRuntimeState(agentId = activeAgentId) {
    if (!agentId || isPendingAgentId(agentId)) return;
    const target = getRuntimeTargetForAgent(agentId);
    if (!target) return;
    const result = await api.sessions.getRuntimeState(target).catch(() => undefined);
    if (result?.ok) applyAgentRuntimeState(agentId, result.value.value);
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

  async function closeAgent(agentId: string) {
    if (isPendingAgentId(agentId)) return;
    const target = getRuntimeTargetForAgent(agentId);
    if (!target) return;
    requireSessionCommand(await api.sessions.stopRuntime(target));
  }

  function requestCloseAgent(agent: AgentTab): Promise<void> {
    if (!agent.noSession) return closeAgent(agent.id);
    overlays.showConfirm({
      title: t("app.anonymousChatCloseTitle"),
      message: t("app.anonymousChatCloseBody"),
      danger: true,
      confirmLabel: t("common.close"),
      onConfirm: () => {
        overlays.clearConfirm();
        void closeAgent(agent.id).catch((error) => {
          showToast(error instanceof Error ? error.message : String(error), 5000);
        });
      },
    });
    return Promise.resolve();
  }

  async function abortAgent(agentId = activeAgentId) {
    if (!agentId || isPendingAgentId(agentId)) return;
    const target = getRuntimeTargetForAgent(agentId);
    if (!target) return;
    // 立即清除流式状态，让思考气泡和 loading 立刻消失，不等后端 RPC 返回
    const previous = store.get(sessionRuntimeBySessionIdAtomFamily(target.sessionId))?.state;
    if (previous) {
      applyAgentRuntimeState(agentId, { ...previous, isStreaming: false });
    }
    requireSessionCommand(await api.sessions.abortRuntime(target));
    // 不调用 refreshRuntimeState：AgentManager.abort() 会通过 emitState 推送正确状态，
    // 避免后端 get_state 返回过时的 isStreaming: true 覆盖前端立刻设的 false。
  }

  async function restartActiveAgent() {
    if (!activeAgentId || !activeAgent) return;
    const restartingAgent = activeAgent;
    const target = getRuntimeTargetForAgent(restartingAgent.id);
    if (!target) return;
    setRestartingAgentId(restartingAgent.id);
    setSessionActionsOpen(false);
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
      const replacement = requireSessionCommand(await api.sessions.restartRuntime(target));
      pendingAgentsRef.current = pendingAgentsRef.current.filter(
        (agent) => agent.id !== restartingAgent.id,
      );
      setPendingAgents(pendingAgentsRef.current);
      void refreshRuntimeState(replacement.runtime.agentId);
      showToast(t("app.agentRestarted"), 2000);
    } catch (error) {
      pendingAgentsRef.current = pendingAgentsRef.current.map((agent) =>
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
  }

  async function exportAgentHtml(agentId: string) {
    if (isPendingAgentId(agentId)) return;
    try {
      const target = getRuntimeTargetForAgent(agentId);
      if (!target) return;
      const result = requireSessionCommand(await api.sessions.exportRuntimeHtml(target)).value as {
        path: string;
      };
      showToast(t("app.exportedPath", { path: result.path }), 3500);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 5000);
    }
  }

  // isAgentBusy: synchronous store read (steer logic is callback-only, not render-time).
  function isAgentCurrentlyBusy(): boolean {
    if (!currentSessionId) return false;
    const rt = store.get(currentSessionRuntimeAtom);
    return rt?.status === "running" || Boolean((rt?.state as any)?.isStreaming);
  }

  // Drain by stable Session identity so runtime replacement cannot orphan queued work.
  // tool-end 的 steer 投递直接在 onRuntimeState 原始事件上处理，避免批量 render 漏边沿。
  useEffect(() => {
    for (const sessionId of Object.keys(queue.queuedPrompts)) {
      if (queue.canFlushQueuedPrompt(sessionId)) {
        void queue.flushNextQueuedPrompt(sessionId);
      }
    }
  }, [activeProjectRuntimeCapabilities, agents, queue.queuedPrompts]);

  // Session prompt submission is owned by useSessionComposerController.

  // 已删除内置 /goal 与 startNewGoal 实现。

  async function dispatchPromptSnapshot(
    sessionId: string,
    message: string,
    images?: ImageContent[],
    streamingBehavior?: "steer" | "followUp",
    agentMode: ComposerAgentMode = "normal",
    templateDescription?: string,
  ) {
    const submission = buildComposerPromptSubmission(message, agentMode);
    let result: Awaited<ReturnType<typeof api.sessions.sendPrompt>>;
    try {
      result = await api.sessions.sendPrompt({
        sessionId,
        requestId: crypto.randomUUID(),
        message: submission.message,
        images,
        ...(submission.agentMessage ? { agentMessage: submission.agentMessage } : {}),
        ...(templateDescription ? { description: templateDescription } : {}),
        ...(streamingBehavior ? { streamingBehavior } : {}),
      });
    } catch (error) {
      // IPC/fetch 在请求发出后断开时无法判断主进程是否已经提交给 pi；按未知处理，
      // 绝不能把它降级为可重试失败，否则网络/IPC 抖动会造成重复发送。
      throw new PromptDeliveryUnknownError(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!result.accepted) {
		const localizedError = translateI18nDescriptor(result, result.error);
      if (result.delivery === "unknown") {
        throw new PromptDeliveryUnknownError(localizedError);
      }
      throw new Error(localizedError);
    }
  }

  async function submitPromptSnapshot(
    sessionId: string,
    message: string,
    images?: ImageContent[],
    streamingBehavior?: "steer" | "followUp",
    agentMode: ComposerAgentMode = "normal",
    /** prompt 模板匹配到的 description，作为元数据发给 pi agent 标识意图 */
    templateDescription?: string,
  ) {
    // 非队列入口继续保持原有行为：当前选中 agent 忙碌时默认 steer。
    // 客户端队列 drain 直接调用 dispatchPromptSnapshot，并显式指定其投递语义。
    const behavior =
      streamingBehavior ??
      (sessionId === currentSessionId && isAgentCurrentlyBusy() ? "steer" : undefined);
    try {
      await dispatchPromptSnapshot(
        sessionId,
        message,
        images,
        behavior,
        agentMode,
        templateDescription,
      );
      return true;
    } catch (error) {
      if (error instanceof PromptDeliveryUnknownError) {
        showToast(t("app.queuedUnknown"), 6000);
        return "unknown" as const;
      }
      showToast(error instanceof Error ? error.message : String(error), 4000);
      return false;
    }
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

    const target = getRuntimeTargetForAgent(activeAgentId);
    if (!target || !currentSessionId) return;
    // Resend mutates the persisted branch first, then submits the exact returned snapshot.
    void api.sessions.prepareRuntimeResend(target, message.id)
      .then((result) => requireSessionCommand(result).value)
      .then((snapshot) => submitPromptSnapshot(currentSessionId, snapshot.text, snapshot.images))
      .catch((error) => showToast(error instanceof Error ? error.message : String(error), 5000));
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
      const target = getRuntimeTargetForAgent(activeAgentId);
      if (!target) return;
      requireSessionCommand(await api.sessions.editRuntimeMessage(target, messageId, newText));
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
    overlays.showConfirm({
      title: t("message.deleteTitle"),
      message: t("message.deleteReloadPrompt"),
      danger: true,
      confirmLabel: t("common.delete"),
      onConfirm: async () => {
        overlays.clearConfirm();
        try {
          const target = getRuntimeTargetForAgent(activeAgentId);
          if (!target) return;
          requireSessionCommand(await api.sessions.deleteRuntimeMessage(target, messageId));
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          showToast(`${t("message.deleteFailed")}: ${translateAgentErrorMessage(msg)}`, 5000);
        }
      },
    });
  }

  /** 正在 fork 的用户消息 id；用于按钮 loading，避免连点重复 fork。 */
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);

  /**
   * 解析用户消息对应的 pi session entryId。
   * 优先 meta.entryId；其次 id 里的 history 片段；再回退 get_fork_messages 按正文匹配。
   */
  async function resolveForkEntryId(
    agentId: string,
    message: ChatMessage,
  ): Promise<string | undefined> {
    if (typeof message.meta?.entryId === "string" && message.meta.entryId) {
      return message.meta.entryId;
    }
    const historyPrefix = `${agentId}-history-`;
    if (message.id.startsWith(historyPrefix)) {
      const fromId = message.id.slice(historyPrefix.length).trim();
      if (fromId && fromId !== String(message.meta?._piDeckMsgSeq ?? "")) {
        // 纯数字序号是无 entryId 时的 index 回退，不能当 fork entryId。
        if (!/^\d+$/.test(fromId)) return fromId;
      }
    }
    try {
      const target = getRuntimeTargetForAgent(agentId);
      if (!target) return undefined;
      const forkMessages = requireSessionCommand(
        await api.sessions.getRuntimeForkMessages(target),
      ).value;
      const targetText = message.text.trim();
      if (!targetText) return undefined;
      // 相同文案多条时取最后一次，贴近用户点的“当前这句”。
      for (let i = forkMessages.length - 1; i >= 0; i -= 1) {
        const item = forkMessages[i];
        if (item?.entryId && item.text?.trim() === targetText) return item.entryId;
      }
    } catch {
      // getForkMessages 失败时交给上层 toast
    }
    return undefined;
  }

  /**
   * 从用户消息 fork 新会话（pi /fork）。
   * 忙碌中不展示入口；点击时再解析 entryId（meta 缺失时走 getForkMessages 回退）。
   * 成功后主进程会替换 sessionPath 并重载消息，这里把原 prompt 预填回输入框供修改再发。
   */
  async function forkFromUserMessage(message: ChatMessage) {
    if (!activeAgentId || isAgentCurrentlyBusy()) return;
    if (forkingMessageId) return;
    setForkingMessageId(message.id);
    try {
      const entryId = await resolveForkEntryId(activeAgentId, message);
      if (!entryId) {
        showToast(t("app.forkMissingEntryId"), 4000);
        return;
      }
      const target = getRuntimeTargetForAgent(activeAgentId);
      if (!target) return;
      const result = requireSessionCommand(
        await api.sessions.forkRuntimeSession(target, entryId),
      );
      if ((result as { cancelled?: boolean })?.cancelled) {
        showToast(t("app.forkCancelled"), 3500);
        return;
      }
      const promptText =
        typeof (result as { text?: string })?.text === "string" &&
        (result as { text?: string }).text!.length > 0
          ? (result as { text: string }).text
          : message.text;
      // 直接写 Session draft atom（session-first 真源），再派发事件做 caret/focus。
      // 仅靠事件时，若 currentSessionId 在 fork 刷新瞬间短暂为空，setPrompt 会静默丢草稿。
      const draftTarget = currentSessionIdRef.current ?? activeAgentIdRef.current;
      if (draftTarget) setPromptForAgent(draftTarget, promptText);
      window.dispatchEvent(
        new CustomEvent("user-message-edit", { detail: { text: promptText } }),
      );
      if (activeProjectId) {
        void refreshProjectSessions(activeProjectId).catch(() => undefined);
      }
      showToast(t("app.forkDone"), 3500);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      showToast(t("app.forkFailed", { error: translateAgentErrorMessage(msg) }), 5000);
    } finally {
      setForkingMessageId(null);
    }
  }


  /**
   * 打开系统原生文件/文件夹选择器，将选中路径以 @path 引用格式插入到消息中。
   * 仅引用路径，不读取/上传文件内容。
   */
  async function handleAttachFile() {
    try {
      // session-first：路径引用插入由 composer controller 负责；这里仅打开选择器并派发事件。
      const paths = await window.piDesktop.dialog.pickFiles({
        title: t("menu.attachFile"),
      });
      if (paths.length > 0) {
        window.dispatchEvent(new CustomEvent("composer-attach-paths", { detail: { paths } }));
      }
    } catch {
      // 用户取消或出错时不作处理
    }
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
        piUpdate.setPiProxyNoticeTone("info");
        piUpdate.setPiProxyNotice(next.piProxyEnabled ? t("app.shellProxySaved") : "");
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
      // Chromium 沙箱依赖启动参数与 webPreferences，保存后必须整应用重启才生效。
      if ("electronChromiumSandbox" in patch) {
        notice = t("app.settingsSaved"); // sandbox 需重启
      }
      // 单实例锁在进程启动时申请，修改后需重启才切换多开/复用行为。
      if ("singleInstance" in patch) {
        notice = t("app.settingsSaved"); // 单实例需重启
      }
      // 启动窗口预设仅在下次 createWindow 时应用。
      if ("startupWindowMode" in patch) {
        notice = t("app.settingsSaved"); // 启动窗口需重启
      }
      // WSL/Windows pi 源切换：重新检测 pi 环境、刷新项目和会话列表
      if ("wslEnabled" in patch || "wslDistro" in patch || "wslUser" in patch) {
        void api.pi.check().then((next) => setPiStatus(next)).catch(() => undefined);
        void api.projects.list().then(setProjects).catch(() => undefined);
        if (activeProjectId) {
          void refreshProjectSessions(activeProjectId, true).catch(() => undefined);
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

  async function switchBranch(branch: string) {
    if (!activeProjectId || !branch || branch === gitInfo.current) return;
    try {
      const next = await api.git.checkout(activeProjectId, branch);
      setGitInfo(next);
      setBranchByProject((prev) => ({ ...prev, [activeProjectId]: next.current }));
    } catch (error) {
      showToast(
        t("app.branchSwitchFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      const refreshed = await api.git
        .branches(activeProjectId)
        .catch(() => ({ current: null, branches: [] }));
      setGitInfo(refreshed);
    }
  }

  async function createBranch(branchName: string) {
    if (!activeProjectId || !branchName.trim()) return;
    try {
      const next = await api.git.createBranch(activeProjectId, branchName);
      setGitInfo(next);
      setBranchByProject((prev) => ({ ...prev, [activeProjectId]: next.current }));
      showToast(t("app.branchCreated", { branch: branchName }), 2500);
    } catch (error) {
      showToast(
        t("app.branchCreateFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  function toggleDirectory(path: string) {
    // 文件树默认折叠,只有用户显式展开目录才显示子项,避免大仓库一打开就产生视觉噪音。
    setExpandedDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      // 持久化展开状态到 localStorage，切换回此项目时恢复
      if (activeProjectId) saveExpandedDirs(activeProjectId, next);
      return next;
    });
  }

  function collapseAllDirectories() {
    const collapsedDirs = new Set<string>();
    setExpandedDirs(collapsedDirs);
    // 全部收起同样持久化，避免用户切换项目后又恢复此前展开的目录。
    if (activeProjectId) saveExpandedDirs(activeProjectId, collapsedDirs);
  }

  async function deleteSidebarSession(projectId: string, session: SessionSummary) {
    await api.sessions.deleteRecord(session.id);
    removeSessionState(session.id);
    removeSessionComposerState(session.id);
    showToast(t("app.sessionDeleted"), 2200);
    await refreshProjectSessions(projectId);
  }

  function requestDeleteSidebarSession(projectId: string, session: SessionSummary) {
    const childCount = getProjectSessionRecords(projectId).filter((candidate) =>
      isSameSessionPath(
        candidate.parentSessionPath,
        session.filePath,
      ),
    ).length;
    if (childCount === 0) {
      void deleteSidebarSession(projectId, session);
      return;
    }
    overlays.showConfirm({
      title: t("drawer.sessionDeleteTitle"),
      message: t("drawer.sessionDeleteBodyWithChildren", {
        name: session.name || t("common.untitled"),
        count: childCount,
      }),
      danger: true,
      confirmLabel: t("common.delete"),
      onConfirm: () => {
        overlays.clearConfirm();
        void deleteSidebarSession(projectId, session);
      },
    });
  }

  async function removeSidebarProject(project: Project) {
    try {
      const next = await api.projects.remove(project.id);
      setProjects(next);
      updateAfterProjectRemoved(project.id, next);
    } catch (error) {
      if (String(error instanceof Error ? error.message : error).includes("PROJECT_HAS_RUNNING_AGENT")) {
        overlays.showConfirm({
          title: t("app.projectRemoveBlockedTitle"),
          message: t("app.projectRemoveBlockedByAgent"),
          confirmLabel: t("app.projectRemoveBlockedAck"),
          onConfirm: () => overlays.clearConfirm(),
        });
      } else {
        showToast(error instanceof Error ? error.message : String(error), 5000);
      }
    }
  }

  const sidebarActions: SidebarActions = {
    projects: {
      add: addProject,
      select: (projectId) => {
        selectProjectCommand(projectId);
        // 空项目也可能已经成功加载；用 catalog 状态区分“空结果”和“尚未扫描”。
        const loadState = store.get(sessionCatalogLoadStateAtom)[projectId];
        if (loadState?.status !== "loading" && loadState?.status !== "ready") {
          void refreshProjectSessions(projectId).catch(() => undefined);
        }
      },
      refresh: async (projectId) => {
        const project = projects.find((candidate) => candidate.id === projectId);
        if (project) await refreshProjectTree(project);
      },
      reorder: reorderProjects,
      reveal: (project) => api.files.showInFolder(project.path),
      openWithEditor: (project) => {
        workspace.openExternalEditorChooser(project.path, { x: 80, y: 80 });
      },
      importSessions: (project, source) => {
        if (source === "codex") return openCodexImport(project);
        if (source === "claude") return openClaudeImport(project);
        return openOpenCodeImport(project);
      },
      manageResources: (project) => setProjectResourcesProject(project),
      toggleWorktree: toggleProjectWorktree,
      copyPath: async (project) => {
        await navigator.clipboard.writeText(project.path);
        showToast(t("common.copied"));
      },
      remove: removeSidebarProject,
      changeChatPath: async (project) => {
        const picked = await api.projects.chooseChatPath();
        if (!picked || picked === project.path) return;
        await api.projects.setChatPath(picked);
        await refreshProjectSessions(project.id);
        showToast(t("app.chatProjectPathUpdated"), 1800);
      },
    },
    sessions: {
      open: runOpenSidebarSessionById,
      createDraft: runCreateSessionDraft,
      createAnonymous: runCreateAnonymousSession,
      deleteDraft: deleteDraftSession,
      rename: rename.openSessionRename,
      export: runExportSidebarSession,
      copy: runCopySidebarSession,
      copyPath: async (session) => {
        await navigator.clipboard.writeText(session.filePath);
        showToast(t("common.copied"));
      },
      openFile: (session) => api.files.open(session.filePath),
      delete: async (projectId, session) => {
        requestDeleteSidebarSession(projectId, session);
      },
    },
    agents: {
      rename: rename.openAgentRename,
      export: (agent) => exportAgentHtml(agent.id),
      copySession: (agent) => cloneAgentSession(agent.id),
      copyPath: async (agent) => {
        if (!agent.sessionPath) return;
        await navigator.clipboard.writeText(agent.sessionPath);
        showToast(t("common.copied"));
      },
      openSessionFile: (agent) => agent.sessionPath ? api.files.open(agent.sessionPath) : Promise.resolve(),
      close: requestCloseAgent,
    },
    worktrees: {
      create: async (projectId, branchName) => {
        await createWorktree(projectId, branchName);
      },
      remove: (parentProjectId, entry, childProject) => {
        requestRemoveWorktree(parentProjectId, entry.path, childProject);
        return Promise.resolve();
      },
    },
    rpc: {
      getLogging: (agentId) => {
        const target = getRuntimeTargetForAgent(agentId);
        return target ? api.rpcLogs.getLogging(target) : Promise.resolve(false);
      },
      setLogging: (agentId, enabled) => {
        const target = getRuntimeTargetForAgent(agentId);
        return target ? api.rpcLogs.setLogging(target, enabled) : Promise.resolve(false);
      },
      openLogFile: (agentId) => {
        const target = getRuntimeTargetForAgent(agentId);
        return target ? api.rpcLogs.openFile(target) : Promise.resolve();
      },
      listLogs: (agentId) => {
        const target = getRuntimeTargetForAgent(agentId);
        return target ? api.rpcLogs.get({ target }) : Promise.resolve([]);
      },
    },
  };

  const sidebarContentNode = (
    <AppSidebar
      listCollapsed={listCollapsed}
      toggleListCollapsed={toggleListCollapsed}
      actions={sidebarActions}
      currentProjectId={activeProjectId}
      currentSessionId={currentSessionId}
      worktreesByProject={worktreesByProject}
      branchByProject={branchByProject}
      creatingWorktree={worktreeCreating}
      isLanWeb={isLanWeb}
      onOpenConfig={() => setConfigOpen(true)}
      onOpenFeedback={() => overlays.setFeedbackOpen(true)}
      settingsExpandedProjectIds={settings.sidebarExpandedProjectIds}
      settingsLoaded={settingsLoaded}
      onExpandedProjectsReady={() => setExpandedProjectsReady(true)}
      onOpenHomepage={() => void api.app.openExternal("https://ayuayue.github.io/PiDeck/")}
    />
  );

  // Gate 4.6 — Session view wrapped in SessionRuntimeInjector
  const sessionTitle =
    currentSession?.title ??
    (isChatProject(activeProject)
      ? t("app.chatProject")
      : activeProject?.name) ??
    "PiDeck";

  // 会话 Tab 栏的交互端口由 App 持有；当前会话视图会把状态/操作区嵌入同一行。
  const sessionTabsProps = {
    tabs: sessionTabIds,
    pinnedTabs: pinnedSessionTabIds,
    currentSessionId,
    onSelect: (sessionId: string) => {
      // 点击 Tab 只切换会话，不启动/停止 Agent；记录缺失时忽略（即将被清理）
      const record = store.get(sessionRecordByIdAtomFamily(sessionId));
      if (record) selectSessionCommand(record.projectId, sessionId, true);
    },
    onClose: closeSessionTab,
    onCloseOthers: closeOtherSessionTabs,
    onCloseAll: closeAllSessionTabs,
    // Tab 栏 “+” 下拉的新建目标：聊天对话区置顶，其余按侧栏项目顺序
    newSessionTargets: projects
      .map((project) => ({
        projectId: project.id,
        label: isChatProject(project) ? t("app.chatProject") : project.name,
        isChat: isChatProject(project),
      }))
      .sort((a, b) => Number(b.isChat) - Number(a.isChat)),
    onNewSessionInProject: (projectId: string) => void runCreateSessionDraft(projectId),
    onTogglePin: togglePinSessionTab,
    onReorder: reorderSessionTab,
    onToggleDrawer: toggleRightDrawer,
    drawerOpen: Boolean(drawer && !drawerCollapsed),
  };
  const sessionTabsBarNode = <SessionTabsBar {...sessionTabsProps} />;

  const chatPaneContentNode = (
    <>
      {!currentSessionId && sessionTabsBarNode}
      {currentSessionId ? (
    <SessionRuntimeInjector
      currentSessionId={currentSessionId}
      sessionTitle={sessionTitle}
      sessionTabs={sessionTabsProps}
      sessionTimeline={sessionTimeline}
      sessionActionsOpen={sessionActionsOpen}
      setSessionActionsOpen={setSessionActionsOpen}
      isLanWeb={isLanWeb}
      chatHeaderRef={chatHeaderRef}
      sessionComboRef={sessionComboRef}
      composerRef={composerRef}
      composerOffsetHeight={composerOffsetHeight}
      terminalRowHeight={terminalRowHeight}
      showToast={showToast}
      onOpenFile={handleOpenLinkedFile}
      onDiffFile={diffFilePath}
      onPreviewImage={setPreviewImage}
      abortAgent={abortAgent}
      restartActiveAgent={restartActiveAgent}
      onToggleDrawer={toggleRightDrawer}
      drawerOpen={Boolean(drawer && !drawerCollapsed)}
      runCreateSessionDraft={runCreateSessionDraft}
      enqueueSessionPrompt={enqueueSessionPrompt}
      insertQuickPrompt={insertQuickPrompt}
      ensureSessionId={ensureSessionForSend}
      resendUserMessage={resendUserMessage}
      editMessage={editMessage}
      deleteMessage={deleteMessage}
      forkFromUserMessage={forkFromUserMessage}
      forkingMessageId={forkingMessageId}
      agents={displayAgents}
      activeQueuedPrompts={activeQueuedPrompts}
      visibleQueuedPrompts={visibleQueuedPrompts}
      queueRetract={queue.retractQueuedPromptForEdit}
      queueDiscard={queue.discardQueuedPrompt}
      queuedTrackRef={queuedTrackRef}
      queueFlushBySessionRef={queueFlushBySessionRef}
      restartingAgentId={restartingAgentId}
      sessionDurationByAgent={sessionDurationByAgent}
      activeProjectId={activeProjectId}
      gitInfo={gitInfo}
      showThinking={settings.showThinking}
      validCommandNames={validCommandNames}
      validFilePaths={validFilePaths}
      terminalOpen={terminalOpen}
      terminalDockClosing={terminalDockClosing}
      terminalDockVisible={terminalDockVisible}
      terminalCollapsed={terminalCollapsed}
      availableTerminalHeight={availableTerminalHeight ?? 120}
      setTerminalOpenForAgent={setTerminalOpenForAgent}
      setTerminalCollapsedForAgent={setTerminalCollapsedForAgent}
      setTerminalHeightByAgent={setTerminalHeightByAgent}
      configOpen={configOpen}
      environmentDialog={Boolean(environmentDialog)}
      showNotice={showNotice}
      api={api}
    />
      ) : (
        // 无当前会话（普通项目点开 / 所有 Tab 关闭）时，普通项目与 Chat 项目
        // 共享统一空态；快捷操作新建 Agent / 匿名聊天，无项目时引导添加项目。
        <ProjectEmptyState
          activeProject={activeProject}
          onCreateAgent={() => void runCreateSessionDraft()}
          onCreateAnonymous={() => void runCreateAnonymousSession()}
          onAddProject={() => void addProject()}
        />
      )}
    </>
  );

  // ── DrawerSurface port objects (stable via useMemo) ──
  const drawerPorts = useDrawerPorts({
    editorMode, activeTab, activeTabId, editorTabs,
    toggleEditorMode, selectEditorTab, closeEditorTab, closeEditor,
    readEditorFileContent, readEditorOriginalContent, saveEditorFileContent,
    prevDrawerPanelRef, clearEditorBack,
    maxEditorFileSizeMB: settings.maxEditorFileSizeMB,
    enableGitManagement: settings.enableGitManagement, activeProjectId,
    gitDrawerDiff, gitDiffDisplayMode,
    openCommitFileDiff, openWorkspaceFileDiff,
    toggleGitDiffDisplayMode, closeGitDiff,
    gitApi: api.git, gitInfo,
    switchBranch, createBranch,
    openDrawer: workspace.openDrawer,
    closeDrawer: workspace.closeDrawer,
    collapseDrawer: workspace.collapseDrawer,
    toggleDrawerPinned: workspace.toggleDrawerPinned,
    closeBrowser: () => workspace.closeBrowser(),
    minimizeBrowser: () => workspace.minimizeBrowser(),
    enterBrowserFullscreen: () => workspace.enterBrowserFullscreen(),
    browserFullscreen,
    sessionsProject, sessionsProjectId,
    files, sessions,
    sessionSourceFilter, sessionHistoryLoading,
    expandedDirs,
    onToggleDirectory: toggleDirectory,
    onCollapseAllDirectories: collapseAllDirectories,
    setFileMenu: (menu: { x: number; y: number; node: FileTreeNode } | null) => {
      setFileMenu(menu);
      if (!menu) return;
      try {
        setHasClipboardFiles(api.files.getClipboardPaths().length > 0);
      } catch {
        setHasClipboardFiles(false);
      }
    },
    refreshFiles,
    projects,
    refreshProjectSessions,
    runOpenSidebarSession, isSameSessionPath,
    runCopySession, runExportHistorySession, runDeleteHistorySession,
    viewFilePath, openFilePath,
    api, t,
    projectRoot: activeProject?.path,
    onDropFiles: (targetDir, fileList) => {
      // 从 OS 拖入：解析本地路径后复制到目标目录（目录不支持跨源复制时跳过）
      const paths: string[] = [];
      for (let i = 0; i < fileList.length; i++) {
        const file = fileList.item(i);
        if (file) {
          const path = api.files.getPathForFile(file);
          if (path) paths.push(path);
        }
      }
      if (paths.length > 0) {
        void api.files.copy(paths, targetDir).then(() => {
          void refreshFiles();
          showToast(t("app.fileCopyDone", { count: paths.length }), 2000);
        }).catch((error) => {
          showToast(error instanceof Error ? error.message : String(error), 4000);
        });
      }
    },
    onPasteFiles: (targetDir) => {
      // 粘贴：从系统剪贴板读取资源管理器复制的文件路径，复制到目标目录
      try {
        const paths = api.files.getClipboardPaths();
        if (paths.length > 0) {
          void api.files.copy(paths, targetDir).then(() => {
            void refreshFiles();
            showToast(t("app.fileCopyDone", { count: paths.length }), 2000);
          }).catch((error) => {
            showToast(t("app.filePasteFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
          });
        }
      } catch { /* 剪贴板不可用 */ }
    },
    onMoveFiles: (sourcePaths, targetDir) => {
      // 文件树内部拖拽移动：同设备 rename，跨设备 cp+rm
      void api.files.move(sourcePaths, targetDir).then(() => {
        void refreshFiles();
        showToast(t("app.fileMoveDone", { count: sourcePaths.length }), 2000);
      }).catch((error) => {
        showToast(error instanceof Error ? error.message : String(error), 4000);
      });
    },
  });


  // 钉住面板恢复：编辑器占用抽屉（drawer=editor 或 modal 展开中）时强制恢复
  // pinned 面板会与 toggleEditorMode 互相覆盖 → 最小化需点击两次/渲染循环。
  // 放在 useFileEditor 之后（editorMode 可用）；编辑器模式优先于 pinned 恢复。
  useEffect(() => {
    if (!workspace.drawerPinnedPanel) return;
    if (drawer === "editor" || editorMode === "modal") return;
    if (workspace.drawer !== workspace.drawerPinnedPanel) workspace.openDrawer(workspace.drawerPinnedPanel);
    if (workspace.drawerCollapsed) workspace.expandDrawer();
  }, [workspace.drawer, workspace.drawerCollapsed, workspace.drawerPinnedPanel, drawer, editorMode]);
  return (
    <>
      <AppBootstrap {...bootstrapProps} />
    <AppShell
      listCollapsed={listCollapsed}
      listWidth={listWidth}
      drawer={drawer}
      drawerCollapsed={drawerCollapsed}
      drawerWidth={drawerWidth}
      drawerPinned={workspace.drawerPinned}
      useNativeTitleBar={settings.useNativeTitleBar}
      chatPaneRef={chatPaneRef}
      terminalRowHeight={terminalRowHeight}
      contentMaxWidth={settings.contentMaxWidth}
      sidebarContent={sidebarContentNode}
      chatPaneContent={chatPaneContentNode}
      drawerRail={
        <WorkspaceDrawerRail
          actions={[
            {
              id: "files",
              label: t("app.files"),
              icon: <FolderOpen size={16} />,
              active: drawer === "files",
              onClick: () => handleToolDrawerAction("files"),
            },
            // 编辑器与文件互为独立面板：文件树负责浏览，编辑器承载所有已打开文件
            {
              id: "editor",
              label: t("editor.fileEditor"),
              icon: <SquarePen size={16} />,
              active: drawer === "editor",
              onClick: () => handleToolDrawerAction("editor"),
            },
            // Git 面板受设置开关与项目上下文双重门控，与 outline 入口保持一致
            ...(settings.enableGitManagement && activeProjectId ? [{
              id: "git",
              label: t("drawer.sourceControl"),
              icon: <GitBranch size={16} />,
              active: drawer === "git",
              onClick: () => handleToolDrawerAction("git"),
            }] : []),
            {
              id: "browser",
              label: t("app.browser"),
              icon: <Globe size={16} />,
              active: drawer === "browser",
              onClick: () => handleToolDrawerAction("browser"),
            },
          ]}
        />
      }
      drawerContent={(visibleDrawerPanel) => (
        <DrawerSurface
          drawer={visibleDrawerPanel}
          drawerCollapsed={drawerCollapsed}
          drawerPinned={drawerPinned}
          editor={drawerPorts.editor}
          git={drawerPorts.git}
          chrome={drawerPorts.chrome}
          browser={drawerPorts.browser}
          files={drawerPorts.files}
        />
      )}
      outlineContent={hasActiveConversation ? (
<ConversationOutline
        items={outlineItems}
        onJump={sessionTimeline.jumpToMessage}
        extraAction={{
          active: scratchPad.isOpen,
          label: t("scratchPad.openTooltip"),
          onClick: () => scratchPad.toggle(),
          icon: <Pencil size={17} />,
        }}
        terminalAction={activeAgentId ? {
          active: terminalOpen,
          label: t("app.terminal"),
          onClick: () => {
            setTerminalOpenForAgent(activeAgentId, !terminalOpen);
          },
          icon: <Terminal size={17} />,
        } : undefined}
        filesAction={undefined}
        gitAction={undefined}
        editorsAction={{
          active: editorsOpen,
          label: t("app.openWithEditor"),
          onClick: (e) => {
            const projectPath =
              activeAgent?.cwd ||
              (activeProject && !isChatProject(activeProject)
                ? activeProject.path
                : null);
            const btn = (e?.currentTarget as HTMLElement)?.closest("button");
            const anchor = btn
              ? adjustMenuPos(btn.getBoundingClientRect().left - 4, btn.getBoundingClientRect().top, 220, 280)
              : undefined;
            workspace.openExternalEditorChooser(projectPath || "", anchor);
          },
          icon: <Code size={17} />,
        }}
        browserAction={undefined}
      />
    ) : null}
      setListCollapsed={setListCollapsed}
      setListWidth={setListWidth}
      setDrawerCollapsed={setDrawerCollapsed}
      setDrawerWidth={setDrawerWidth}
      onToggleListCollapsed={toggleListCollapsed}
      onDrawerCollapse={workspace.collapseDrawer}
      onDrawerClose={workspace.closeDrawer}
      onDrawerRestore={() => workspace.expandDrawer()}
      onToggleDrawerPin={workspace.toggleDrawerPinned}
      toggleAlwaysOnTop={api.app.toggleAlwaysOnTopWindow}
      minimizeWindow={api.app.minimizeWindow}
      toggleMaximizeWindow={api.app.toggleMaximizeWindow}
      closeWindow={api.app.closeWindow}
    >

    {fileMenu && (
      <FileContextMenu
        menu={fileMenu}
        hasClipboardFiles={hasClipboardFiles}
        onPaste={(targetDir) => {
          // 右键菜单「粘贴文件到此处」：读剪贴板路径复制到目标目录
          try {
            const paths = api.files.getClipboardPaths();
            if (paths.length > 0) {
              void api.files.copy(paths, targetDir).then(() => {
                void refreshFiles();
                showToast(t("app.fileCopyDone", { count: paths.length }), 2000);
              }).catch((error) => {
                showToast(t("app.filePasteFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
              });
            }
          } catch { /* 剪贴板不可用 */ }
          setFileMenu(null);
        }}
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
          showToast(t("app.pathCopied"), 1200);
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
          overlays.showConfirm({
            title: node.type === "directory" ? t("drawer.deleteFolderTitle") : t("drawer.deleteFileTitle"),
            message: node.type === "directory"
              ? t("drawer.deleteFolderConfirm", { name: node.name })
              : t("drawer.deleteFileConfirm", { name: node.name }),
            danger: true,
            confirmLabel: t("common.delete"),
            onConfirm: async () => {
              overlays.clearConfirm();
              try {
                await api.files.delete(node.path, true);
                void refreshFiles();
                showToast(t("app.fileDeleted"), 2000);
              } catch (e) {
                console.error("[File] 删除失败:", e);
              }
            },
          });
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
    <RenameModals
      agentRename={rename.renameModalsProps.agentRename}
      fileRename={renamingFile ? {
        path: renamingFile.path,
        name: renamingFile.name,
        inputValue: renamingFileInput,
        onInputChange: setRenamingFileInput,
        onClose: () => setRenamingFile(null),
        onConfirm: (path, newName) => {
          void api.files.rename(path, newName).then(() => {
            void refreshFiles();
            setRenamingFile(null);
            showToast(t("app.fileRenamed"), 2000);
          }).catch((err) => console.error("[File] rename failed:", err));
        },
      } : undefined}
    />

    {/* old conditional wrapping — replaced by EnvironmentOverlay open prop below */}
    <EnvironmentOverlay open={environmentDialog}>
      <EnvironmentDialog
        status={piStatus}
        checking={piChecking}
        onClose={() => {
          setEnvironmentDialog(false);
          piUpdate.setCustomPathResult(null);
          // 关闭时重置安装状态
          piUpdate.setInstallResult(null);
          piUpdate.setInstallCompleted(false);
          piUpdate.setNpmAvailable(null);
        }}
        onRecheck={() => {
          piUpdate.setCustomPathResult(null);
          piUpdate.setNpmAvailable(null);
          piUpdate.setNpmVersion(undefined);
          piUpdate.setInstallResult(null);
          piUpdate.setInstallCompleted(false);
          piUpdate.setInstallUseMirror(false);
          piUpdate.checkPiInstall("manual");
        }}
        onOpenInstallDocs={() =>
          api.app.openExternal(
            "https://pi.dev/docs/latest/quickstart#install",
          )
        }
        customPath={piUpdate.customPiPath}
        customPathValidating={piUpdate.customPathValidating}
        customPathResult={piUpdate.customPathResult}
        onCustomPathChange={(path) => {
          piUpdate.setCustomPiPath(path);
          piUpdate.setCustomPathResult(null);
        }}
        onValidateCustomPath={() =>
          piUpdate.validateCustomPiPath({ closeDialogOnSuccess: true })
        }
        npmAvailable={piUpdate.npmAvailable}
        npmVersion={piUpdate.npmVersion}
        npmChecking={piUpdate.npmChecking}
        installCommand={piUpdate.installCommand}
        installUseMirror={piUpdate.installUseMirror}
        installExecuting={piUpdate.installExecuting}
        installResult={piUpdate.installResult}
        installCompleted={piUpdate.installCompleted}
        onCheckNpm={piUpdate.checkNpm}
        onInstallCommandChange={(cmd) => {
          piUpdate.setInstallCommand(cmd);
          piUpdate.setInstallResult(null);
          piUpdate.setInstallCompleted(false);
        }}
        onToggleInstallMirror={() => {
          piUpdate.setInstallUseMirror((prev) => {
            if (prev) {
              piUpdate.setInstallCommand((cmd) =>
                cmd.replace(
                  /\s+--registry=https:\/\/registry\.npmmirror\.com/g,
                  "",
                ),
              );
            } else {
              piUpdate.setInstallCommand((cmd) =>
                cmd.includes("--registry=")
                  ? cmd
                  : cmd + " --registry=https://registry.npmmirror.com",
              );
            }
            return !prev;
          });
          piUpdate.setInstallResult(null);
          piUpdate.setInstallCompleted(false);
        }}
        onExecInstall={piUpdate.execInstallCommand}
        onRestartApp={() => api.app.restart()}
        onClearCheckFlag={async () => {
          await api.settings.update({ piEnvironmentChecked: false });
          showToast(t("environment.checkFlagCleared"));
        }}
      />
    </EnvironmentOverlay>
    <SettingsFeatureRoot
      settings={settings}
      piUpdate={piUpdate}
      appUpdate={appUpdate}
      webServiceChanging={webServiceChanging}
      appInfo={appInfo}
      onChange={updateSettings}
      onCurrentVersion={setUpToDateVersion}
    />
    <SessionActionOverlays {...overlays.overlayProps} />
    <AppUpdateOverlay
      controller={appUpdate}
      releasesUrl={appInfo.releasesUrl}
      openExternal={(url, forceSystem) => api.app.openExternal(url, forceSystem)}
      upToDateVersion={upToDateVersion}
      onDismissUpToDate={() => setUpToDateVersion(null)}
    />
    {editorMode === "modal" && activeTab && gitDiffDisplayMode !== "modal" && (
      <Suspense fallback={<div className="modal-backdrop"><span className="file-diff-loading">Loading...</span></div>}>
      <FileDiffViewer
        displayMode="modal"
        filePath={activeTab.filePath}
        mode={activeTab.mode}
        onToggleMode={activeTab.preserveDrawer ? undefined : toggleEditorMode}
        originalContent={activeTab.mode === "diff" ? activeTab.originalContent : undefined}
        modifiedContent={activeTab.modifiedContent}
        tabs={editorTabs}
        activeTabId={activeTabId}
        onSelectTab={selectEditorTab}
        onCloseTab={closeEditorTab}
        onClose={() => { closeEditor(); }}
        readContent={readEditorFileContent}
        readOriginalContent={readEditorOriginalContent}
        saveContent={activeTab.allowSave ? saveEditorFileContent : undefined}
        theme={document.documentElement.dataset.theme === "dark" ? "dark" : "light"}
        maxFileSizeMB={settings.maxEditorFileSizeMB}
      />
    </Suspense>
    )}
    {gitDiffDisplayMode === "modal" && gitDrawerDiff && gitDrawerDiff.projectId === activeProjectId && (
      <Suspense fallback={<div className="modal-backdrop"><span className="file-diff-loading">Loading...</span></div>}>
        <FileDiffViewer
          displayMode="modal"
          filePath={gitDrawerDiff.filePath}
          mode="diff"
          onToggleMode={toggleGitDiffDisplayMode}
          originalContent={gitDrawerDiff.originalContent}
          modifiedContent={gitDrawerDiff.modifiedContent}
          tabs={[{ id: gitDrawerDiff.filePath, filePath: gitDrawerDiff.filePath, label: gitDrawerDiff.label }]}
          activeTabId={gitDrawerDiff.filePath}
          onClose={closeGitDiff}
          readContent={readEditorFileContent}
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
    {codexImportProject && <ImportOverlayHost kind="codex" project={codexImportProject} controller={codexImportController} onClose={() => setCodexImportProject(null)} />}
    {claudeImportProject && <ImportOverlayHost kind="claude" project={claudeImportProject} controller={claudeImportController} onClose={() => setClaudeImportProject(null)} />}
    {openCodeImportProject && <ImportOverlayHost kind="opencode" project={openCodeImportProject} controller={openCodeImportController} onClose={() => setOpenCodeImportProject(null)} />}
    <Suspense fallback={null}>
    <ConfigModal
      open={configOpen}
      onClose={() => setConfigOpen(false)}
      onSaved={() => {
        // 配置保存后不再自动 reload,用户可通过 Restart 按钮手动重载
      }}
    />
    </Suspense>

    {/* Scratch Pad（草稿本）：根级渲染，避免受 chat-pane grid 影响定位 */}
    <ScratchPadOverlay controller={scratchPad} />

    {/* 外部编辑器选择气泡 */}
    <ExternalEditorOverlay
      open={editorsOpen}
      editors={externalEditors}
      anchor={editorsAnchor}
      projectPath={editorsTargetPath}
      onClose={() => workspace.closeExternalEditorChooser()}
      onOpenProject={(editor, path) => workspace.openProjectInExternalEditor(editor)}
      onError={(error) => showToast(t("app.openEditorFailed", {error: String(error)}), 3000)}
    />

    </AppShell>
    </>
  );
}

// test
