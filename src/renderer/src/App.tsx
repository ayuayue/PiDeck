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
import { applyAppearanceAttributes, toggleThemeMode } from "./themeAppearance";
// 壁纸模式已注入的 token 键（effect 重跑/清除设置时需要跨运行保留，避免漏清）
let injectedWallpaperTokens = new Set<string>();
// 自定义外观主题（customThemeOverrides）已注入的 token 键：切换主题时先清后注，防残留
let injectedCustomTokens = new Set<string>();
import {
  Code,
  Activity,
  FolderOpen,
  Globe,
  History,
  Pencil,
  Terminal,
  GitBranch,
} from "lucide-react";
import { showNotice } from "./utils/notice";
import {
  desktopApi as api,
  isLanWeb,
  missingElectronPreload,
} from "./desktopApi";
import { turnFlowSettingsAtom, defaultAgentBackendAtom, effectiveAgentBackendAtom, busySendDeliveryAtom, imageGenConfigAtom, dshRuntimeStatusAtom, openSettingsAtom, sessionRecordsAtom, bumpNewTurnCollapseTickAtom } from "./atoms";
import { resolveBusySendDelivery } from "../../shared/busySendDelivery";
import { FILE_TREE_ABSOLUTE_MAX_DEPTH } from "../../shared/fileTree";
// 文件链接路由：图片类型走弹窗预览
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"]);
import { type SidebarActions } from "./components/sidebar/SidebarContent";
import { AppSidebar } from "./components/sidebar/AppSidebar";
import { AppBootstrap } from "./components/app/AppBootstrap";
import { SettingsFeatureRoot } from "./components/app/SettingsFeatureRoot";
import { useRename } from "./hooks/useRename";
import { useProjectRuntimeCapabilities } from "./hooks/useRuntimeCapabilities";
import { useSessionRuntimeBridge } from "./hooks/useSessionRuntimeBridge";
import { useAgentLoadNotice } from "./hooks/useAgentLoadNotice";
import { useSessionLayout } from "./hooks/useSessionLayout";
import { useFileEditor } from "./hooks/useFileEditor";
import { resolveFileLinkPath } from "./utils/filePathLinks";
import { imageMimeTypeFromPath } from "./utils/composerImages";
import { useOverlayActions } from "./hooks/useOverlayActions";
import { useWorkspacePanels, type WorkspaceDrawerPanel, type WorkspaceExternalEditorAdapter } from "./hooks/useWorkspacePanels";
import { useDrawerPorts } from "./hooks/useDrawerPorts";
import { useTerminalDock } from "./hooks/useTerminalDock";
import { resolveTerminalOwner, terminalOwnerKey } from "./terminalDockState";
import { useImportFlow } from "./hooks/useImportFlow";
import { useQueuedPrompt } from "./hooks/useQueuedPrompt";
import { activeAgentIdAtom } from "./hooks/useSessionRuntimeController";
import { useSessionHistoryMutations } from "./hooks/useSessionHistoryMutations";
import { PromptDeliveryUnknownError } from "./utils/promptErrors";
import {
  isLiveRuntimeStatus,
  requireSessionCommand,
  SessionCommandFailure,
  sessionCommandFailureToast,
  toSessionRuntimeTarget,
} from "./utils/sessionCommands";
import {
  GUIDE_BOOTSTRAP_SESSION_ID,
  readWelcomeModelPreference,
  resolveChatSessionBootstrap,
} from "./utils/chatSessionBootstrap";
import { detectRendererPlatform } from "./lib/detectRendererPlatform";
import { msUntilNextThemeBoundary } from "../../shared/themeSchedule";

import { usePiUpdate } from "./hooks/usePiUpdate";
import { useAppUpdateController } from "./hooks/useAppUpdateController";
import { useBackgroundUpdateWatch } from "./hooks/useBackgroundUpdateWatch";
import { useProjectSync } from "./hooks/useProjectSync";
import {
  agentInventoryAtom,
  applySessionRuntimeEventAtom,
  currentSessionAtom,
  currentSessionIdAtom,
  currentSessionMessagesAtom,
  currentSessionRuntimeAtom,
  projectInventoryAtom,
  removeSessionComposerStateAtom,
  removeSessionStateAtom,
  replaceProjectInventoryAtom,
  replaceProjectSessionsAtom,
  sessionRecordByIdAtomFamily,
  sessionRecordsByProjectIdAtomFamily,
  sessionIdByRuntimeAgentIdAtomFamily,
  sessionRuntimeBySessionIdAtomFamily,
  sidebarExpandedProjectIdsAtom,
  compactMiddlePackagesAtom,
  sessionCatalogLoadStateAtom,
  sessionMessagesCacheAtom,
  sessionSummariesByProjectIdAtomFamily,
  sessionDraftByIdAtom,
  promoteSessionComposerStateAtom,
  setSessionAttachmentsAtom,
  setSessionCatalogLoadStateAtom,
  setSessionMessageLoadStateAtom,
  setSessionHistoryMutationOverlayAtom,
  setSessionDraftAtom,
  cacheSessionMessagesAtom,
  upsertSessionAtom,
} from "./atoms";
import {
  applyDshGoalSendTransform,
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
  stampIdleSessionDuration,
  type PendingAgentTab,
} from "./rendererUtils";
import type { SessionFilterPill } from "./sessionFilterPills";
import { useResize } from "./hooks/useResize";
import {
  ARCHIVED_SESSION_TOAST_MS,
  archivedSessionToastMessage,
  useSessionActions,
} from "./hooks/useSessionActions";
import { useScratchPad } from "./hooks/useScratchPad";
import { useDshRuntimeStatusSync } from "./hooks/useDshRuntimeStatusSync";
import { useDshRuntimeMigrationNotice } from "./hooks/useDshRuntimeMigrationNotice";
import { useDshRuntimeInstallProgressSync } from "./hooks/useDshRuntimeInstallProgressSync";
import { DSH_INSTALL_SETTINGS_TARGET, showDshRuntimeBlockHint } from "./utils/dshRuntimeHint";
import { dshSendBlockReason } from "../../shared/types/dshRuntime";
import { useWorktreeActions } from "./hooks/useWorktreeActions";
import { ChatSessionPane } from "./components/session/ChatSessionPane";
import { SessionSplitStage } from "./components/session/SessionSplitStage";
import { splitLayoutSessionIds } from "./utils/sessionSplitEdge";
import { findLoadedDirectory, loadProjectFileTree, mergeFileTreeChildren } from "./utils/fileTreeLazy";
import { SessionTabsBar, type SessionToolAction } from "./components/session/SessionTabsBar";
import {
  SessionPaneServicesProvider,
  type SessionFileOpenContext,
} from "./components/session/SessionPaneServices";
import { ProjectEmptyState } from "./components/session/ProjectEmptyState";
import { FileLinkBaseProvider } from "./components/session/FileLinkBase";
import { useSessionWorkspaceChrome } from "./hooks/useSessionWorkspaceChrome";
import { ScratchPadOverlay } from "./components/overlays/ScratchPadOverlay";
import { AskPanelOverlay } from "./components/overlays/AskPanelOverlay";
import { TerminalDockPanel } from "./components/terminal/TerminalDockPanel";
import { ResizablePanel, ResizablePanelGroup } from "./components/ui-shadcn/resizable";
import { AppShell } from "./components/app/AppShell";
import { WorkspaceDrawerRail } from "./components/workspace/WorkspaceDrawerRail";
import { DrawerSurface } from "./components/workspace/DrawerSurface";
import { WorkbenchStage } from "./components/workspace/WorkbenchStage";
import { WorkbenchContent } from "./components/workspace/WorkbenchContent";
import { RenameModals } from "./components/RenameModals";
import { SessionActionOverlays } from "./components/overlays/SessionActionOverlays";
import { AppUpdateOverlay } from "./components/overlays/AppUpdateOverlay";
import { ImportOverlayHost } from "./components/overlays/ImportOverlayHost";
import { EnvironmentOverlay } from "./components/overlays/EnvironmentOverlay";
import {
  EnvironmentDialog,
  FileContextMenu,
  ImagePreviewModal,
  type SessionModifiedFile,
} from "./components/app/AppParts";
import { ExternalEditorOverlay } from "./components/workspace/ExternalEditorOverlay";
import { navigateTo } from "./components/app/BrowserPanel";
import {
  flattenFiles,
  mergeCommands,
  getToolFilePath,
  getToolNewContent,
  getToolChangedLineCount,
} from "./components/app/AppUtils";
// ProjectResourcesModal 仅在打开资源弹层时加载
const ProjectResourcesModal = lazy(() => import("./components/app/ProjectResourcesModal").then((m) => ({ default: m.ProjectResourcesModal })));
import { createDefaultExternalEditorSettings, DEFAULT_PET_SCALE } from "../../shared/types";
import type {
  AgentRuntimeState,
  AgentTab,
  SessionRuntimeTarget,
  AppInfo,
  AppSettings,
  ChatMessage,
  FileTreeNode,
  ImageContent,
  PiCommand,
  Project,
  AgentBackend,
  SessionLaunchPreferences,
  SessionRecord,
  SessionSummary,
  ComposerAgentMode,
  TerminalTarget,
} from "../../shared/types";

export function App() {
  if (missingElectronPreload) {
    return (
      <div className="boot-screen root-loading">
        {/* 与 EmptyState / index.html 启动标同一套 π path */}
        <div className="boot-logo root-loading-logo" aria-hidden="true">
          <svg viewBox="140 140 520 520" width="48" height="48">
            <defs>
              <linearGradient id="root-loading-logo-silver" x1="0.2" y1="0" x2="0.8" y2="1">
                <stop stopColor="#ffffff" />
                <stop offset="0.5" stopColor="#f4f4f5" />
                <stop offset="1" stopColor="#a7a8ab" />
              </linearGradient>
            </defs>
            <path
              fill="url(#root-loading-logo-silver)"
              fillRule="evenodd"
              d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
            />
            <path fill="url(#root-loading-logo-silver)" d="M517.36 400H634.72V634.72H517.36Z" />
          </svg>
        </div>
        <strong className="text-[40px] font-bold tracking-[0.06em]">PiDeck</strong>
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
  // Timeline 由各 ChatSessionPane 自持；大纲只读当前聚焦会话的消息缓存。
  const activeMessages = useAtomValue(currentSessionMessagesAtom);
  const projects = useAtomValue(projectInventoryAtom);
  const agents = useAtomValue(agentInventoryAtom);
  const setCurrentSessionId = useSetAtom(currentSessionIdAtom);
  const replaceProjectSessions = useSetAtom(replaceProjectSessionsAtom);
  const setProjects = useSetAtom(replaceProjectInventoryAtom);
  const applyRuntimeEvent = useSetAtom(applySessionRuntimeEventAtom);
  const upsertSession = useSetAtom(upsertSessionAtom);
  const setCacheMessages = useSetAtom(cacheSessionMessagesAtom);
  const setSessionDraft = useSetAtom(setSessionDraftAtom);
  const setSessionAttachments = useSetAtom(setSessionAttachmentsAtom);
  const promoteSessionComposerState = useSetAtom(promoteSessionComposerStateAtom);
  const setSessionCatalogLoadState = useSetAtom(setSessionCatalogLoadStateAtom);
  const setSessionMessageLoadState = useSetAtom(setSessionMessageLoadStateAtom);
  // 会话消息区域遮罩（SessionSurfaceStage）：重启/停止/重载等运行时操作据此显示「正在…」加载动画
  const setMutationOverlay = useSetAtom(setSessionHistoryMutationOverlayAtom);
  const removeSessionState = useSetAtom(removeSessionStateAtom);
  const removeSessionComposerState = useSetAtom(removeSessionComposerStateAtom);
  const setImageGenConfig = useSetAtom(imageGenConfigAtom);
  const currentSessionIdRef = useRef<string | undefined>(currentSessionId);
  currentSessionIdRef.current = currentSessionId;
  const openSessionRequestRef = useRef(0);
  const creatingSessionDraftRef = useRef<Set<string>>(new Set());
  // 引导页虚拟会话提升并发闸：首次发送触发创建真实会话时登记 promise，同一帧内
  // 的并发发送（如快速双击）复用同一次提升，避免建出两个会话。
  const guideBootstrapPromotionRef = useRef<Promise<string> | undefined>(undefined);

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
  const compactMiddlePackagesEnabled = useAtomValue(compactMiddlePackagesAtom);

  const [commands, setCommands] = useState<PiCommand[]>([]);
  const [promptTemplateList] = useState<
    Array<{ name: string; path: string; description: string; content: string; argumentHint?: string }>
  >([]);
  const jumpToMessageRef = useRef<((messageId: string) => void) | null>(null);
  // TECH DEBT (Phase 3): promptByAgent / attachedImagesByAgent legacy mirrors removed.
  // All drafts/attachments go through Session atoms (setSessionDraft / setSessionAttachments).

  // contentEditable 的实时值通过 livePromptByAgentRef 保持最新，发送路径始终从这里读取草稿。
  const livePromptByAgentRef = useRef<Record<string, string>>({});

  /** 当前正在重启的 Agent，用于仅给对应会话显示 loading，避免切到其他 Agent 后仍被全局禁用。 */
  const [restartingAgentId, setRestartingAgentId] = useState<string | null>(null);
  /** 当前正在激活（首次启动）的会话：未绑定 Agent 时「重启会话」走 activateRuntime，用会话 id 标记 loading。 */
  const [activatingSessionId, setActivatingSessionId] = useState<string | null>(null);
  /** 当前正在停止的 Agent：Tab 栏「停止」/侧栏关闭 Agent 时给对应会话 tab 徽章显示 loading。 */
  const [stoppingAgentId, setStoppingAgentId] = useState<string | null>(null);
  /** 当前正在从磁盘重载消息的会话：Tab 栏「重载」时给对应会话 tab 徽章显示 loading。 */
  const [reloadingSessionId, setReloadingSessionId] = useState<string | null>(null);
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
  /** 历史会话来源过滤（按项目）：undefined=显示全部，Record 含项目ID对应 Set（含 DSH 类别） */
  const [sessionSourceFilter] = useState<
  	Record<string, Set<SessionFilterPill> | null>
  >(() => loadSessionSourceFilter());
  /** 编辑器展示模式：弹框或侧栏 */
  // showToast 必须是稳定回调：文件树 / overlay 等 effect 若把它当依赖，
  // 每次 render 新建函数会把 setFiles([]) 打成无限更新（设置/关窗点不动）。
  const showToast = useCallback((message: string, duration?: number, kind?: "info" | "warning" | "error") => {
    showNotice(message, duration, kind);
  }, []);
  // 历史命令：按 agent 隔离，agent 关闭即清除（不持久化）
  const promptHistoryRef = useRef<Record<string, string[]>>({});

  // 面板宽度的 localStorage 只按 renderer origin 隔离；开发端口变化时会读不到旧值。
  // 复用一次 settings 请求作为 durable fallback，避免左右面板各自再发一遍 get IPC。
  const layoutSettingsRequestRef = useRef<Promise<AppSettings> | null>(null);
  const getLayoutSettings = useCallback(() => {
    const cached = layoutSettingsRequestRef.current;
    if (cached) return cached;
    const request = api.settings.get();
    layoutSettingsRequestRef.current = request;
    void request.catch(() => {
      if (layoutSettingsRequestRef.current === request) layoutSettingsRequestRef.current = null;
    });
    return request;
  }, []);
  const loadSidebarWidth = useCallback(
    async () => (await getLayoutSettings()).sidebarWidth,
    [getLayoutSettings],
  );
  const loadDrawerWidth = useCallback(
    async () => (await getLayoutSettings()).drawerWidth,
    [getLayoutSettings],
  );
  const persistSidebarWidth = useCallback(
    (width: number) => api.settings.update({ sidebarWidth: width }),
    [],
  );
  const persistDrawerWidth = useCallback(
    (width: number) => api.settings.update({ drawerWidth: width }),
    [],
  );

  // Drawer state delegated to useWorkspacePanels.
  // 外部编辑器适配器：将 desktopApi 包装为 WorkspaceExternalEditorAdapter，
  // 供 useWorkspacePanels 的 loadExternalEditors / openProjectInExternalEditor 使用。
  const editorsAdapter = useMemo<WorkspaceExternalEditorAdapter>(() => ({
    list: () => api.editors.list(),
    openProject: (editor, projectPath) => api.editors.openProject(editor, projectPath),
  }), []);
  const workspace = useWorkspacePanels({
    projectId: activeProjectId,
    editors: editorsAdapter,
    loadPersistedWidth: loadDrawerWidth,
    persistWidth: persistDrawerWidth,
  });
  const drawer = workspace.drawer;
  const drawerCollapsed = workspace.drawerCollapsed;
  // 右侧栏总开关：已打开则关闭，否则打开 files（默认关闭，手动打开）
  const toggleRightDrawer = useCallback(() => {
    if (workspace.drawer) {
      workspace.closeDrawer();
      return;
    }
    workspace.openDrawer("files");
  }, [workspace]);
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
    refreshAllProjects,
    refreshWorktrees,
    refreshProjectSessions,
    refreshFiles,
    refreshProjectTree,
    syncDshForeignSessionsIfEnabled,
    beginFileTreeRequest,
    isFileTreeRequestCurrent,
  } = useProjectSync({
    projects,
    activeProjectId,
    setProjects,
    setActiveProjectId,
    replaceProjectSessions,
    api: {
      projects: { list: api.projects.list },
      settings: { get: api.settings.get },
      git: { worktreeList: api.git.worktreeList, branches: api.git.branches },
      sessions: {
        listCatalog: api.sessions.listCatalog,
        onCatalogRefreshed: api.sessions.onCatalogRefreshed,
        syncDshForeignSessions: api.sessions.syncDshForeignSessions,
      },
      files: {
        list: (projectId: string, options?: { maxDepth?: number; directory?: string }) =>
          api.files.list(projectId, options),
      },
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
    renameProject: (id, name) => api.projects.rename(id, name),
    applyRenamedProjects: setProjects,
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
  // target 存在不代表 live（error/closed 终态仍持有绑定）：改文件前是否要先停 Agent
  // 必须按 runtime status 判定，避免对已死进程误发 stop。
  const isSessionRuntimeLive = (sessionId: string) =>
    isLiveRuntimeStatus(store.get(sessionRuntimeBySessionIdAtomFamily(sessionId))?.status);
  const getRuntimeTargetForAgent = (agentId: string | undefined) => {
    if (!agentId) return undefined;
    const sessionId = store.get(sessionIdByRuntimeAgentIdAtomFamily(agentId));
    return getRuntimeTargetForSession(sessionId);
  };
  const [sessionHistoryLoading, setSessionHistoryLoading] = useState(false);
  // controller 的 api 对象必须 useMemo 稳定：内联字面量会让 useAppUpdateController 内部
  // 依赖 api 的 useCallback/effect（含下载进度订阅）每次 App 重渲染都重建/重订。
  const appUpdateApi = useMemo(
    () => ({
      checkUpdate: api.app.checkUpdate,
      downloadUpdate: (asset: Parameters<typeof api.app.downloadUpdate>[0]) => api.app.downloadUpdate(asset),
      installUpdate: (filePath: string) => api.app.installUpdate(filePath),
      onUpdateProgress: (cb: Parameters<typeof api.app.onUpdateProgress>[0]) => api.app.onUpdateProgress(cb),
      openExternal: (url: string) => api.app.openExternal(url),
    }),
    [api],
  );
  const appUpdate = useAppUpdateController(appUpdateApi, false);

  // 后台更新状态订阅：主进程每 2h 自动检查（无配额方案），有更新且未跳过/未提示
  // 时自动弹窗；Pi CLI 有更新时 toast 一次并引导去设置页。
  // appUpdateCheck 直传稳定引用：内联箭头会作为 effect 依赖导致推送订阅每次渲染重订。
  useBackgroundUpdateWatch({
    api,
    appUpdateCheck: appUpdate.check,
    showToast,
  });

  // upToDateVersion: hook does not expose this; used by AppUpdateOverlay for "up to date" toast.
  const [upToDateVersion, setUpToDateVersion] = useState<string | null>(null);

  const PROJECT_EXPANDED_DIRS_KEY_PREFIX = "pid:project-expanded-dirs:";

  // localStorage 只负责首屏；展开项目的权威设置必须等首次 settings.get 返回后才参与迁移。
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [expandedProjectsReady, setExpandedProjectsReady] = useState(false);
  const [settings, setSettings] = useState<AppSettings>({
    useNativeTitleBar: true,
    showNativeMenu: false,
    sendShortcut: "enter-send",
    defaultAgentBackend: "pi",
    theme: "system",
    themeScheduleLightStart: "07:00",
    themeScheduleDarkStart: "19:00",
    accent: "default",
	themeSkin: "classic-green",
	customThemeOverrides: {},
	backgroundImage: "",
	backgroundImageOpacity: 0.8,
    language: "system",
    startupWindowMode: "last",
    piEnvironmentChecked: false,
    /** 扩展禁用白名单：与 SettingsStore 默认一致，空数组 = 不启用白名单（首屏未拉到真实设置前的默认值） */
    /** 扩展禁用白名单：与 SettingsStore 默认一致，空数组 = 不启用白名单（首屏未拉到真实设置前的默认值） */
    disabledExtensions: [],
    disableExtensionWhitelist: false,
    sessionTabOpenMode: "preview",
    // 与 main SettingsStore 默认一致：首轮完成后由内置扩展异步生成标题
    autoSessionTitle: true,
    // 与 main SettingsStore 默认一致：忙碌时发送默认「插入当前回合」
    busySendDelivery: "steer",
    enableGitManagement: true,
    gitCommitMessagePrompt: "请根据以下 git diff 生成一条中文 git commit message。\n\n变更描述：\n{diff}\n\nGitmoji 对应关系：\n✨ feat - 新功能\n🐛 fix - Bug 修复\n📚 docs - 文档更新\n💎 style - 代码格式\n♻️ refactor - 重构\n🧪 test - 测试\n🔧 chore - 构建/工具",
    gitCommitMessageProvider: "",
    gitCommitMessageModel: "",
    closeToTray: true,
    singleInstance: true,
    enableNotifications: true,
    // Ask 提问系统通知默认关闭：与主进程 SettingsStore 默认一致（默认不打扰）
    askNotificationEnabled: false,
    // 人文关怀提醒默认开启：与主进程 SettingsStore 默认一致，首屏未拉到真实设置前不关闭提醒
    agentCountReminderEnabled: true,
    // showThinking 由 pi agent 的 hideThinkingBlock 控制，启动后从主进程加载的真实值会覆盖此处
    showThinking: true,
    // 流式对话行为：默认自动展开中间过程；新一轮默认收起非最新轮（与 SettingsStore 一致）
    expandInterimDuringStream: true,
    collapsePrevRunsOnNewTurn: true,
    showDevTools: false,
    developerDiagnostics: false,
    // Electron Chromium 沙箱默认关，与主进程历史兼容策略一致
    electronChromiumSandbox: false,
    piProxyEnabled: false,
    piProxyUrl: "http://127.0.0.1:7890",
    piProxyBypass: "localhost,127.0.0.1,::1",
    piProxyProviders: [],
    piProxyModels: [],
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
    workspaceContentOpenMode: "split",
    contentMaxWidth: 1800,
    chatContentWidthPct: 80,
    maxEditorFileSizeMB: 5,
    externalEditors: createDefaultExternalEditorSettings(),

    // 桌面宠物默认关闭：关闭后应用与现状完全一致，零回归
    petEnabled: false,
    petId: "clawd",
    petAlwaysOnTop: true,
    petScale: DEFAULT_PET_SCALE,
    petPatrolEnabled: true,
    petPatrolPauseMin: 5,
    // 闲置 agent 自动释放：与 main SettingsStore 默认值保持一致，避免启动时闪烁
    idleAgentAutoRelease: true,
    idleAgentKeepCount: 5,
    idleAgentTimeoutMin: 60,
    favoriteModels: [],

    // 字体配置：与 main SettingsStore 默认值保持一致，避免启动时闪烁
    fontSize: "default",
    uiFontSize: null,
    chatFontSize: null,
    inputFontSize: null,
    zoomFactor: 1,
    fontFamilyBase: "system",
    fontFamilyBaseCustom: "",
    fontFamilyMono: "system-mono",
    fontFamilyMonoCustom: "",
    removedBuiltInExtensions: [],
    imageGenSize: "unset",
    imageGenWatermark: false,
    imageGenOutputFormat: "png",
    disableUpdateCheck: false,
    // 与主进程 defaultSettings 保持一致：offline 默认关，让模型目录随启动刷新
    piRpcOffline: false,
    piRpcNoExtensions: false,
    piRpcNoSkills: false,
  });

  // 流式对话行为设置同步给 turn 组件（TurnRow 直接订阅 atom，避免 5 层 props 透传；
  // 设置变化低频，全局订阅成本可忽略）。
  const setTurnFlowSettings = useSetAtom(turnFlowSettingsAtom);
  useEffect(() => {
    setTurnFlowSettings({
      expandInterimDuringStream: settings.expandInterimDuringStream,
      collapsePrevRunsOnNewTurn: settings.collapsePrevRunsOnNewTurn,
    });
  }, [
    settings.expandInterimDuringStream,
    settings.collapsePrevRunsOnNewTurn,
    setTurnFlowSettings,
  ]);

  // 新建会话默认后端同步给根级组件（并行问询 AskPanel 等不持有 settings props）。
  const setDefaultAgentBackend = useSetAtom(defaultAgentBackendAtom);
  useEffect(() => {
    setDefaultAgentBackend(settings.defaultAgentBackend);
  }, [settings.defaultAgentBackend, setDefaultAgentBackend]);
  // 派生出「有效」后端：设置值经 DSH runtime 安装态钳制（runtime 不可用时 dsh → pi）。
  // 所有新建会话入口统一读这个值，避免设置里残留 dsh 而 runtime 已不可用导致裸报错。
  const effectiveAgentBackend = useAtomValue(effectiveAgentBackendAtom);

  // 忙碌时发送的默认投递行为同步给发送链路（composer/App 决策时刻从 atom 读取，
  // 设置保存后无需重挂载会话即可生效，与 defaultAgentBackend 同一模式）。
  const setBusySendDelivery = useSetAtom(busySendDeliveryAtom);
  useEffect(() => {
    setBusySendDelivery(settings.busySendDelivery);
  }, [settings.busySendDelivery, setBusySendDelivery]);

  // 应用更新：主进程后台每 2h 自动检查（无配额方案），有更新且未跳过/未提示时
  // 经 useBackgroundUpdateWatch 自动弹窗；设置页手动「检测更新」仍可用（checking 门控
  // 已改为共享在途 promise，不再吞结果）。弹窗关闭/跳过时向主进程标记已提示/跳过，
  // 保证「每版本只提示一次」。
  const dismissAppUpdate = useCallback(() => {
    const version = appUpdate.info?.latestVersion;
    appUpdate.clear();
    if (version) void api.app.notifyUpdateSeen("app", version);
  }, [appUpdate.info?.latestVersion, appUpdate.clear]);

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
    releasesUrl: "https://github.com/ayuayue/PiDeck/releases",
    // 同步判定，避免 Mac 首帧在 appInfo IPC 返回前误画 Win 窗口按钮
    platform: detectRendererPlatform(),
    homeDir: "",
    userDataDir: "",
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
  // 抽屉宽度状态由 useWorkspacePanels 统一管理（全局 localStorage 持久化，键 pid:drawer-width），
  // AppShell 拖拽提交经 setDrawerWidth 回写；此处不再持有独立 useState，避免双份状态漂移。
  const drawerWidth = workspace.drawerWidth;
  const setDrawerWidth = workspace.setDrawerWidth;
  const [composerOffsetHeight, setComposerOffsetHeight] = useState(0);
  // 终端归属：有 activeAgent → agent owner；引导页/未激活 agent/历史会话 → project owner。
  // 终端 open/collapsed/PTY 实例按 owner 隔离，切换项目或 agent 绝不串台；
  // 分屏高度是全局单份并持久化（与抽屉宽度同策略），跨重启恢复上次大小。
  // 会话所属项目（响应式）：未激活 Agent 的会话回退项目终端时需要它的 projectId
  const currentSessionRecord = useAtomValue(
    sessionRecordByIdAtomFamily(currentSessionId ?? ""),
  );
  // 终端归属：有 activeAgent → agent owner；未激活 agent/历史会话 → project owner。
  // activeProjectId 未同步（如 Tab 直切跨项目会话）时用当前会话所属项目兜底，
  // 保证未激活 agent 的会话也常显「打开终端」按钮。
  const terminalOwner = resolveTerminalOwner(
    activeAgentId,
    activeProjectId ?? currentSessionRecord?.projectId,
  );
  const {
    terminalOpen,
    terminalCollapsed,
    terminalDockVisible,
    terminalDockClosing,
    terminalHeight,
    setTerminalOpenForOwner,
    setTerminalCollapsedForOwner,
    setTerminalHeight,
    setTerminalOpenByOwnerKey,
    setTerminalCollapsedByOwnerKey,
    terminalStatesByOwner,
    prune: pruneTerminalDockState,
  } = useTerminalDock(terminalOwner);
  // 终端 IPC 目标：
  // - agent owner → 当前会话的 runtime target（须绑定已启动 Agent）；拿不到 runtime
  //   （从未启动 / 停止后绑定缺失）时回退项目 cwd 目标，主进程按 cwd 隔离 PTY——
  //   保证普通项目的会话无论 Agent 是否激活都能开项目终端（按钮常显）。
  // - project owner（引导页/未激活 agent/历史会话）→ 项目 cwd。
  // - Chat 项目没有可落地的 cwd，不提供终端（激活中的匿名聊天除外，走 agent 目标）。
  const terminalTarget: TerminalTarget | undefined = useMemo(() => {
    if (!terminalOwner) return undefined;
    const fallbackProject = (() => {
      const pid = terminalOwner.kind === "project"
        ? terminalOwner.id
        : activeProjectId ?? currentSessionRecord?.projectId;
      return pid ? projects.find((p) => p.id === pid) : undefined;
    })();
    const projectTarget = fallbackProject && !isChatProject(fallbackProject)
      ? { kind: "project" as const, projectId: fallbackProject.id, cwd: fallbackProject.path }
      : undefined;
    if (terminalOwner.kind === "agent") {
      const runtimeTarget = getRuntimeTargetForSession(currentSessionId);
      return runtimeTarget ? { kind: "agent", ...runtimeTarget } : projectTarget;
    }
    return projectTarget;
  }, [terminalOwner, currentSessionId, currentSessionRecord, projects, activeProjectId]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  // 手动刷新/增删改后仍只拉浅层 + 当前展开目录，避免再走整棵 12 层 IPC。
  const refreshVisibleFiles = useCallback(
    (projectId?: string, silent?: boolean) => refreshFiles(projectId, silent, expandedDirs),
    [expandedDirs, refreshFiles],
  );
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
  const queuedTrackRef = useRef<HTMLElement | null>(null);

  const composerTextareaRef = useRef<HTMLDivElement | null>(null);
  // RichInput 受控重渲染后,光标应恢复到的纯文本偏移(供建议选中/清除后恢复选区)。
  const pendingComposerCaretRef = useRef<number | null>(null);
  const pendingAgentsRef = useRef<PendingAgentTab[]>([]);

  const scratchPad = useScratchPad();
  // DSH runtime 安装态同步：全进程只挂这一份（IPC 拉取 + 变更订阅 → dshRuntimeStatusAtom）。
  // 必须早于任何按安装态门控的 UI 计算，否则首帧会用 checking 初值渲染。
  useDshRuntimeStatusSync();
  // DSH runtime 安装进度同步：App 级订阅（常驻，不随 DshRuntimeSection 卸载），
  // 保证切配置分页/关弹窗后进度仍保留；完成/失败时弹全局 toast。
  useDshRuntimeInstallProgressSync();
  // 存量 dsh 用户升级后 runtime 不在时给一次直达提示（有 dsh 会话才提示，只提示一次）。
  useDshRuntimeMigrationNotice();

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
  // rewind（检查点）是 pi 后端能力：抽屉 rail 与底栏按钮同口径门控
  // （dsh/imagegen 会话不展示入口）。与 Injector 的 isDshBackend 同源判定。
  const rewindBackend = activeAgent?.backend ?? currentSessionRecord?.backend;
  const rewindSupported = rewindBackend === undefined || rewindBackend === "pi";

  // Timeline scroll, pagination and jump ownership lives in sessionTimeline.
  // Modern Session drafts and attachments are subscribed by ComposerArea; the root only
  // keeps the legacy queue adapter for agents that do not yet have a Session record.
  function setPromptForAgent(
    agentId: string,
    value: string | ((current: string) => string),
  ) {
    const targetAgentId = agentId;
    // previous 必须从 Session draft atom 读取（权威源）：输入框的编辑/删除都经 composer
    // setDraft 写入 atom，livePromptByAgentRef 只在 setPromptForAgent 内更新，若用它当
    // previous，「右键引用 → 删除 → 再右键引用」会把已删除的旧引用带回输入框。
    const previous = store.get(sessionDraftByIdAtom)[targetAgentId] ?? "";
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
  // 激活 Agent 数量告警：受设置 agentCountReminderEnabled 控制（默认开启），每个启动周期提示一次
  useAgentLoadNotice(settings.agentCountReminderEnabled);
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
      // 未指定行为时按「忙碌时投递行为」设置兜底（pi/dsh 统一，不再按后端分叉）。
      behavior: snapshot.behavior ?? store.get(busySendDeliveryAtom),
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

  // activeConversationStatus / activeRuntimeState replaced by sync isAgentCurrentlyBusy().
  // The built-in Chat uses a renderer-only Session ID before its first send.
  // Workspace chrome belongs to that visible conversation surface, not only to
  // persisted catalog records; otherwise Chat loses the dev-equivalent toolbar.

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
  // 布局的 terminalRequestedHeight 只看「是否有任一 owner 的终端展开」：分屏下非聚焦栏
  // 的 dock 也按各自 owner 持续显示，不能随聚焦会话的 open 状态把全局行高打成 0
  // （否则非聚焦栏的终端面板 defaultSize 变成 0）。
  const anyTerminalDockOpen = useMemo(
    () =>
      Object.values(terminalStatesByOwner).some((state) => state.open),
    [terminalStatesByOwner],
  );
  const sessionLayout = useSessionLayout({
    terminalRequestedHeight: terminalHeight,
    terminalOpen: anyTerminalDockOpen,
    // 关闭信号不再让布局行高归零：分屏下其它栏的 dock 仍需要高度；关闭动画期间
    // 该栏面板已随 open=false 立即卸载，行高保留到 180ms 动画结束不影响布局。
    terminalClosing: false,
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

  // Gate 4.5 — streaming signal / abort helpers
  const {
    listWidth,
    setListWidth,
    listCollapsed,
    setListCollapsed,
    toggleListCollapsed,
  } = useResize({
    loadPersistedWidth: loadSidebarWidth,
    persistWidth: persistSidebarWidth,
  });
  useEffect(() => {
    document.documentElement.lang = resolvedLocale;
  }, [resolvedLocale]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      // 明暗 / 外观主题 / 主色统一经 themeAppearance 应用（与设置弹窗实时预览共用实现）：
      // data-theme(浅暗) + data-appearance(表面色板) + data-accent(主题自带主色)
      applyAppearanceAttributes(
        document.documentElement,
        settings,
        Boolean(media?.matches),
      );
    };
    applyTheme();
    const cleanups: Array<() => void> = [];
    if (settings.theme === "system" && media?.addEventListener) {
      media.addEventListener("change", applyTheme);
      cleanups.push(() => media.removeEventListener("change", applyTheme));
    }
    // 跟随时间：睡到下一次浅色/暗色边界再应用，避免每分钟轮询。
    if (settings.theme === "schedule") {
      let timer: number | undefined;
      const arm = () => {
        const delay = msUntilNextThemeBoundary(
          new Date(),
          settings.themeScheduleLightStart,
          settings.themeScheduleDarkStart,
        );
        timer = window.setTimeout(() => {
          applyTheme();
          arm();
        }, delay);
      };
      arm();
      cleanups.push(() => {
        if (timer !== undefined) window.clearTimeout(timer);
      });
    }
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
    // 依赖 theme 与 accent：只改主题色时也必须重新应用 data-accent（否则界面不变）
  }, [
    settings.theme,
    settings.themeScheduleLightStart,
    settings.themeScheduleDarkStart,
    settings.accent,
    settings.themeSkin,
  ]);

  // 外观主题自定义覆盖 + 换肤背景图统一管理（原两个 effect 互相清除：
  // 皮肤 effect 清 token 时误清壁纸注入、背景 effect 的 else 分支又误清皮肤 bg 键——
  // 合并后顺序固定：先自定义覆盖，后壁纸覆盖。内置外观主题色板由 CSS data-appearance 承担。）
  useEffect(() => {
    const root = document.documentElement;
    const isDark = root.dataset.theme === "dark";
    const BG_TOKENS = [
      "--color-bg-app",
      "--color-bg-sidebar",
      "--color-bg-panel",
      "--color-bg-input",
      "--color-bg-muted",
      "--color-bg-hover",
      "--color-bg-active",
      "--color-background",
      "--color-card",
      // Markdown/表格使用 chat 专属 token；未注入时会继续显示固定白色代码块。
      "--color-chat-card-bg",
      "--color-chat-muted-bg",
      "--color-chat-control-bg",
      "--color-chat-table-bg",
    ];

    // 1. 自定义外观主题覆盖：customThemeOverrides 总是叠加在内置外观主题之上
    //    （inline 样式优先于 stylesheet 的 [data-appearance] 块，语义=「自定义压过内置」）。
    //    内置主题（classic-green/graphite/sea-blue/warm-beige）的表面色板由 CSS
    //    [data-appearance] 块承担，这里不再注入内置皮肤变量，避免 inline 与样式表互相覆盖。
    //    先清掉上次注入的 custom token，保证切换主题后无残留。
    for (const k of injectedCustomTokens) root.style.removeProperty(`--color-${k}`);
    injectedCustomTokens.clear();
    for (const [k, v] of Object.entries(settings.customThemeOverrides ?? {})) {
      root.style.setProperty(`--color-${k}`, v);
      injectedCustomTokens.add(k);
    }

    // 2. 换肤背景图：遮罩同色渐变（浅白/暗黑）+ 壁纸模式 token 半透明注入。
    //    存储语义=图片可见度（0=全遮，1=图全显）；滑块 80% → 遮罩 0.2 → 图 80% 透出。
    root.dataset.bgImage = settings.backgroundImage ? "on" : "off";
    if (settings.backgroundImage) {
      // 采样前先摘掉上一轮注入的壁纸 token：inline style 在 cascade 上压过
      // :root[data-theme="dark"] 样式表，不摘的话 getComputedStyle 读到的是
      // 上一轮主题烤进的旧值，重注入又基于旧值——背景被永久焊死在注入时的
      // 明暗（暗色启动后亮色坏、亮色启动后暗色坏，即主题互相「打架」的根因）。
      for (const k of injectedWallpaperTokens) root.style.removeProperty(k);
      injectedWallpaperTokens.clear();
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
      // Select/Dropdown/Popover 会 portal 到 body，不能继承 DialogContent 的局部变量。
      // 单独给浮层保留 92% 以上的底色，避免半透明面板 token 让菜单内容透出并误读为“透明坏了”。
      const floatingMix = Math.max(92, Math.min(100, panelMix + 40));
      root.style.setProperty(
        "--color-bg-popover",
        `color-mix(in srgb, ${base} ${floatingMix}%, transparent)`,
      );
      root.style.setProperty("--wallpaper-floating-alpha", `${floatingMix}%`);
      injectedWallpaperTokens.add("--color-bg-popover");
    } else {
      root.style.removeProperty("--app-bg-image");
      root.style.removeProperty("--app-bg-mask");
      // 只清本 effect 注入过的壁纸 token，绝不误清皮肤设置的 bg 键
      for (const k of injectedWallpaperTokens) root.style.removeProperty(k);
      injectedWallpaperTokens.clear();
      root.style.removeProperty("--wallpaper-base");
      root.style.removeProperty("--wallpaper-panel-alpha");
      root.style.removeProperty("--wallpaper-floating-alpha");
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

    // 自定义字体统一追加 CJK 回退：用户只填西文字体时，中文不能落到 SimSun 小字挤压
    // （与下方 mono 注入同理，见 foundation.css 注释）。
    const baseCustomFont = settings.fontFamilyBaseCustom.trim();
    if (settings.fontFamilyBase === "custom" && baseCustomFont) {
      root.style.setProperty("--font-family-base", `${baseCustomFont}, "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "HarmonyOS Sans SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif`);
    } else {
      root.style.removeProperty("--font-family-base");
    }

    // 自定义等宽字体同样必须追加 CJK 回退：用户一般只填西文字体
    // （如 JetBrains Mono），不追加时中文会落到 SimSun 小字挤压（见 foundation.css 注释）。
    const monoCustomFont = settings.fontFamilyMonoCustom.trim();
    if (settings.fontFamilyMono === "custom" && monoCustomFont) {
      root.style.setProperty("--font-family-mono", `${monoCustomFont}, "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "HarmonyOS Sans SC", "Hiragino Sans GB", "Noto Sans CJK SC"`);
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
    promotePreviewEditorTab,
    previewEditorTabId,
    openFilePath,
    viewFilePath,
    openEditorTab,
    diffFilePath,
    openWorkspaceFileDiff,
    openCommitFileDiff,
    closeGitDiff,
    dismissGitDiff,
    gitDiffDisplayMode,
    gitDrawerDiff,
    toggleGitDiffDisplayMode,
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
    contentOpenMode: settings.workspaceContentOpenMode ?? "split",
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
  // 图片 → 弹窗预览（readBase64 → ImagePreviewModal）；markdown/html → 中间栏查看
  //（FileDiffViewer 对 .md 默认 preview、.html 用 HtmlPreview 内置渲染）；其他文件 → 编辑器打开。
  // 替代原先的"系统默认应用打开"（.md 会被浏览器接管、体验割裂）
  // line 为可选 `path:line` 位置标记：编辑器打开后滚动定位到该行。
  const handleOpenLinkedFile = useCallback(
    (path: string, line?: number, context?: SessionFileOpenContext) => {
      // 有栏级上下文时绝不回退 App 当前焦点：分屏左栏的点击不能借用右栏 cwd/project。
      const baseDir = context
        ? context.baseDir
        : activeAgent?.cwd ?? activeProject?.path;
      const projectRoot = context ? context.projectRoot : activeProject?.path;
      const projectId = context ? context.projectId : activeProject?.id;
      // 会话内入口必须携带稳定 projectId；缺失时不能降级成通用读取绕开主进程项目边界。
      if (context && !projectId) {
        showToast(t("app.fileLinkCannotResolve", { path }));
        return;
      }
      const resolved = resolveFileLinkPath(path, baseDir, projectRoot);
      // 相对路径无基准目录、`..` 逃逸或绝对路径落在项目外都会返回 null。
      // 主进程读取时还会按 projectId 对真实路径做第二次边界校验。
      if (!resolved) {
        showToast(t("app.fileLinkCannotResolve", { path }));
        return;
      }
      const fileAccessScope = projectId ? { projectId } : undefined;
      const ext = resolved.split(".").pop()?.toLowerCase() ?? "";
      if (IMAGE_EXTENSIONS.has(ext)) {
        // readBase64 返回原始 base64，不是 data URL；直接构造 ImageContent 供预览弹层使用。
        void api.files
          .readBase64(resolved, undefined, fileAccessScope)
          .then((data) => {
            if (!data) throw new Error("FILE_NOT_FOUND");
            setPreviewImage({
              type: "image",
              mimeType: imageMimeTypeFromPath(resolved),
              data,
            });
          })
          .catch((error) =>
            showToast(t("app.openFileFailed", {
              error: error instanceof Error ? error.message : String(error),
            })),
          );
        return;
      }
      // markdown / html / 其他文本文件：统一抽屉查看；scope 固化进 tab，切焦点后仍按原项目读取。
      viewFilePath(resolved, undefined, line, fileAccessScope);
    },
    [activeAgent?.cwd, activeProject?.id, activeProject?.path, viewFilePath, showToast],
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
      if (panel === "files" && activeProjectId) void refreshVisibleFiles(activeProjectId, true);
      workspace.openDrawer(panel);
    }
  }, [workspace, gitDrawerDiff, closeGitDiff, activeProjectId, refreshVisibleFiles]);

  const workspaceChrome = useSessionWorkspaceChrome({
    currentSessionId,
    activeProjectId,
  });

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
    dismissSessionTree,
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
    closeTabs: workspaceChrome.closeTabs,
    refreshProjectSessions,
    api,
    showToast,
    // 新建会话默认后端：跟随设置项（默认 pi，可切换 dsh），经 DSH runtime 安装态钳制
    defaultBackend: effectiveAgentBackend,
  });

  // 关闭 Tab / 分屏退栏时的焦点切换：只改 currentSession，不碰 Tab 登记
  useEffect(() => {
    workspaceChrome.bindFocusHandlers({
      focusSession: (projectId, sessionId) => {
        selectSessionCommand(projectId, sessionId, true);
      },
      focusProject: (projectId) => {
        selectProjectCommand(projectId);
      },
    });
  }, [workspaceChrome, selectSessionCommand, selectProjectCommand]);

  /** 新建会话：选中 + 登记常驻 Tab（chrome 与 selection 在 App 边界组合） */
  const createSessionDraftWithTab = useCallback(
    async (projectId?: string, preferences: SessionLaunchPreferences = {}, backend?: AgentBackend) => {
      const session = await runCreateSessionDraft(projectId, preferences, backend);
      if (session) workspaceChrome.registerOpenSession(session.id, "permanent");
      return session;
    },
    [runCreateSessionDraft, workspaceChrome],
  );

  const createAnonymousSessionWithTab = useCallback(
    async (projectId?: string, preferences: SessionLaunchPreferences = {}) => {
      const session = await runCreateAnonymousSession(projectId, preferences);
      if (session) workspaceChrome.registerOpenSession(session.id, "permanent");
      return session;
    },
    [runCreateAnonymousSession, workspaceChrome],
  );

  /**
   * 问题反馈「新建会话分析」：在活动项目新建草稿会话并选中，把 AI 提示词预填进
   * 该会话输入框（composer 草稿）。pi 启动后会自动加载项目 AGENTS.md 与技能，
   * 提示词里的诊断报告 + 项目上下文可让 pi 在正确约束下排查。
   */
  const handleFeedbackCreateSession = useCallback(
    async (prompt: string): Promise<boolean> => {
      const session = await createSessionDraftWithTab();
      if (!session) return false;
      setSessionDraft({ sessionId: session.id, value: prompt });
      return true;
    },
    [createSessionDraftWithTab, setSessionDraft],
  );

  /** 侧栏/分支打开：选中成功后按 preview|permanent 登记 Tab */
  const openSidebarSessionByIdWithTab = useCallback(
    async (
      projectId: string,
      sessionId: string,
      tabMode: "preview" | "permanent" = "permanent",
    ) => {
      const openedId = await runOpenSidebarSessionById(projectId, sessionId);
      if (openedId) workspaceChrome.registerOpenSession(openedId, tabMode);
    },
    [runOpenSidebarSessionById, workspaceChrome],
  );

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

  // 引导页空白输入框（虚拟会话 GUIDE_BOOTSTRAP_SESSION_ID）的发送钩子：首次
  // 发送时创建真实 Catalog 会话（Chat 匿名 / 非 Chat draft），把 composer 状态
  // 整体提升到新会话（promoteSessionComposerStateAtom），随后选中并登记 Tab，
  // 返回真实 sessionId 让发送链路继续；非虚拟会话直接透传（保持签名兼容）。
  // 并发发送（快速双击）复用 guideBootstrapPromotionRef 里的同一个提升 promise，
  // 避免建出两个会话。创建即用户意图（已输入消息），Chat 拉起 pi 是预期行为。
  const ensureSessionForSend = useCallback(
    async (sessionId: string) => {
      if (sessionId !== GUIDE_BOOTSTRAP_SESSION_ID) return sessionId;
      if (guideBootstrapPromotionRef.current) return guideBootstrapPromotionRef.current;
      const project = projects.find((candidate) => candidate.id === activeProjectId);
      if (!project) {
        throw new Error(t("app.guideBootstrapUnavailable"));
      }
      const promotion = (async () => {
        // 引导页 picker 无 record 分支把模型选择存进 localStorage；创建时作为
        // 「偏好」交给主进程解析（优先级：显式默认 > 偏好 > 上次使用 > 空），
        // 与底栏显示同源，避免显示/套用分叉。思考级别不随偏好传入——
        // 一律走默认档位（settings.defaultThinkingLevel），由解析器决定。
        const welcomeModel = readWelcomeModelPreference()?.model;
        // 统一创建 draft 会话（Chat 项目也走普通会话、可保存）：创建不拉 pi，
        // selectSessionCommand 同步切页、立即进入会话页；匿名会话仅保留给侧栏
        // 「新建临时对话」入口（createAnonymousSessionWithTab）。
        // 默认后端跟随设置项（settings.defaultAgentBackend，默认 pi），
        // 且经 DSH runtime 安装态钳制——runtime 不可用时不会尝试建 dsh 会话。
        const session = await api.sessions.createDraft({
          projectId: project.id,
          title: effectiveAgentBackend === "dsh" ? `${project.name} DSH` : `${project.name} agent`,
          backend: effectiveAgentBackend,
          ...(welcomeModel ? { welcomeModel } : {}),
        });
        upsertSession(session);
        // 引导页发送时 useSessionSend 已把 user 消息乐观写入虚拟会话 cache；
        // 提升时搬到真实会话——否则切页后新会话空态与引导页视觉相同，
        // 要等 agent 启动、回复流入后页面才「动」，用户误以为发送没生效。
        const bootstrapMessages =
          store.get(sessionMessagesCacheAtom)[GUIDE_BOOTSTRAP_SESSION_ID]?.messages;
        if (bootstrapMessages?.length) {
          setCacheMessages({
            sessionId: session.id,
            messages: bootstrapMessages,
            source: "runtime",
          });
        }
        promoteSessionComposerState({
          fromSessionId: GUIDE_BOOTSTRAP_SESSION_ID,
          toSessionId: session.id,
        });
        selectSessionCommand(project.id, session.id, false);
        workspaceChrome.registerOpenSession(session.id, "permanent");
        return session.id;
      })();
      guideBootstrapPromotionRef.current = promotion;
      try {
        return await promotion;
      } finally {
        guideBootstrapPromotionRef.current = undefined;
      }
    },
    [
      activeProjectId,
      projects,
      promoteSessionComposerState,
      selectSessionCommand,
      upsertSession,
      workspaceChrome,
      effectiveAgentBackend,
    ],
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
      .then((info) => {
        setAppInfo(info);
        // 与窗口标题一致：开发态功能分支时文档标题带分支名
        document.title = info.devBranch ? `PiDeck · ${info.devBranch}` : "PiDeck";
      })
      .catch(() => undefined);
    void api.imagegen.getConfig().then(setImageGenConfig).catch(() => undefined);
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
    if (activeAgentId && !isPendingAgentId(activeAgentId))
      void refreshRuntimeState(activeAgentId);
  }, [activeAgentId]);

  useEffect(() => {
    // 只按各自存活集合裁剪：流式事件仅更新 agent 集合，不能误删项目终端状态
    const liveAgentIds = new Set(displayAgents.map((agent) => agent.id));
    const liveProjectIds = new Set(projects.map((project) => project.id));
    pruneTerminalDockState(liveAgentIds, liveProjectIds);
  }, [displayAgents, projects]);

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
  useEffect(() => {
    // 活 agent 集合（agentId 每次 spawn 随机，标签关闭后旧键永久残留 → 按活集合裁剪，2026-10）
    const liveIds = new Set(displayAgents.map((a) => a.id));
    for (const id of Object.keys(agentStatusByAgentRef.current)) {
      if (!liveIds.has(id)) delete agentStatusByAgentRef.current[id];
    }
    for (const id of Object.keys(sessionStartByAgentRef.current)) {
      if (!liveIds.has(id)) delete sessionStartByAgentRef.current[id];
    }
    setSessionDurationByAgent((d) => {
      let changed = false;
      const next: typeof d = {};
      for (const id of Object.keys(d)) {
        if (liveIds.has(id)) next[id] = d[id];
        else changed = true;
      }
      return changed ? next : d;
    });
    for (const agent of displayAgents) {
      if (agent.id !== activeAgentId) continue;
      const previousStatus = agentStatusByAgentRef.current[agent.id];
      const stamped = stampIdleSessionDuration({
        previousStatus,
        status: agent.status,
        startedAt: sessionStartByAgentRef.current[agent.id],
        now: Date.now(),
      });
      // 只在 running→idle 边沿写时长；已 idle 后再被新 displayAgents 引用戳到不得 setState。
      if (stamped.clearStart) {
        delete sessionStartByAgentRef.current[agent.id];
      } else if (stamped.startedAt != null) {
        sessionStartByAgentRef.current[agent.id] = stamped.startedAt;
      }
      if (stamped.durationMs != null) {
        const durationMs = stamped.durationMs;
        setSessionDurationByAgent((d) => (
          d[agent.id] === durationMs ? d : { ...d, [agent.id]: durationMs }
        ));
      }
      agentStatusByAgentRef.current[agent.id] = agent.status;
    }
  }, [activeAgentId, displayAgents]);

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

  // 编辑器右键「引用选中内容」：@path:start-end 引用追加到输入框（与文件树右键 onAttach 同语义）
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ refs?: string[] }>).detail;
      const refs = detail?.refs;
      if (!refs?.length) return;
      setPrompt(
        (current) =>
          `${current}${current.endsWith(" ") || current.length === 0 ? "" : " "}${refs.join(" ")} `,
      );
    };
    window.addEventListener("composer-attach-refs", handler);
    return () => window.removeEventListener("composer-attach-refs", handler);
  }, []);

  useEffect(() => {
    if (!activeProjectId) return;
    // 切换项目时按 catalog load state 判断。空项目成功返回 [] 后也会是 ready，
    // 不能再用列表长度，否则每次选中都会重扫。
    const activeProject = projects.find((p) => p.id === activeProjectId);
    const loadState = store.get(sessionCatalogLoadStateAtom)[activeProjectId];
    if (expandedProjectsReady && activeProject && expandedProjects.has(activeProjectId) && loadState?.status !== "loading" && loadState?.status !== "ready") {
      void refreshProjectSessions(activeProjectId).catch(() => undefined);
    }
  }, [activeProjectId, expandedProjects, expandedProjectsReady, projects, refreshProjectSessions, store]);

  useEffect(() => {
    if (!activeProjectId) {
      beginFileTreeRequest();
      setFiles((current) => (current.length === 0 ? current : []));
      setGitInfo({ current: null, branches: [] });
      return;
    }

    // 只跟项目：切 tab / agent 数量变化不得清空展开目录，也不得整棵重扫文件树。
    // 先立刻清空旧树，并抬高代次，避免大仓库扫描期间右侧仍显示上一个项目（#159）。
    const projectId = activeProjectId;
    const generation = beginFileTreeRequest();
    // 空树复用原数组，避免 effect 误触发时用新 [] 把 React 更新打满。
    setFiles((current) => (current.length === 0 ? current : []));
    const dirs = loadExpandedDirs(projectId);
    setExpandedDirs(dirs);
    let cancelled = false;
    void (async () => {
      try {
        const hydrated = await loadProjectFileTree(
          () => api.files.list(projectId, { maxDepth: 0 }),
          dirs,
          () => !cancelled && isFileTreeRequestCurrent(generation, projectId),
          (directory) => api.files.list(projectId, { maxDepth: 0, directory }),
        );
        if (!cancelled && hydrated) setFiles(hydrated);
      } catch (error) {
        if (cancelled) return;
        console.error("[Files] refresh failed", error);
        const message = error instanceof Error ? error.message : String(error);
        const tooLarge = message.match(/FILE_TREE_DIRECTORY_TOO_LARGE:(\d+):(\d+)/);
        const projectDirectoryMissing = message.includes("PROJECT_DIRECTORY_MISSING");
        if (projectDirectoryMissing) {
          // 项目在启动/切换期间被外部删除：清空树后重扫项目 presence，侧栏马上标出失效目录。
          void refreshProjects().catch(() => undefined);
        }
        showToast(
          tooLarge
            ? t("app.filesDirectoryTooLarge", { count: tooLarge[1], max: tooLarge[2] })
            : projectDirectoryMissing
              ? t("app.projectDirectoryMissing")
              : t("app.filesRefreshFailed", { error: message }),
          4000,
        );
      }
    })();
    void api.git
      .branches(activeProjectId)
      .then((info) => {
        if (!cancelled) setGitInfo(info);
      })
      .catch(() => {
        if (!cancelled) setGitInfo({ current: null, branches: [] });
      });
    return () => {
      cancelled = true;
    };
  // 该 effect 只应由项目身份切换触发；refreshProjects 是 hook 每次渲染返回的命令，
  // 放入依赖会让 setFiles 后再次触发扫描，形成文件树刷新循环。
  }, [activeProjectId, beginFileTreeRequest, isFileTreeRequestCurrent, loadExpandedDirs]);

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

  /**
   * clone / fork 会把同一个 Agent 换绑到新的 SessionRecord。
   * 必须先刷新 catalog 再登记 Tab：否则 chrome 的 prune 看到 records 里还没有新 id，会立刻清掉刚打开的 Tab。
   * 选中与登记都在这里组合——selectSession 本身不碰 Tab。
   */
  async function openReplacedRuntimeSession(
    projectId: string | undefined,
    targetSessionId: string | undefined,
  ) {
    if (!projectId || !targetSessionId) return;
    await refreshProjectSessions(projectId);
    workspaceChrome.registerOpenSession(targetSessionId, "permanent");
    selectSessionCommand(projectId, targetSessionId, true);
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
      await openReplacedRuntimeSession(projectId, result.targetSessionId);
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
    // 先同步 DSH：新目录注册后，原先按 cwd 找不到项目的外部会话才能挂进来。
    await syncDshForeignSessionsIfEnabled();
    await refreshProjects();
    setActiveProjectId(project.id);
    await refreshProjectSessions(project.id);
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

  /**
   * 从磁盘重新加载会话消息（外部修改会话文件后刷新时间线）。
   * 仅用于未启动/异常（无 live runtime）的会话：live 会话刷新应走「重启 Agent」，
   * 直接 force 磁盘会覆盖运行时内存中的流式消息。force 覆盖缓存后，所有展示该会话的
   * 时间线（含分屏栏）都会通过 sessionMessagesCacheAtom 订阅自动更新。
   */
  async function reloadSessionMessages(sessionId: string) {
    if (!sessionId) return;
    // live 运行时（starting/idle/running）不能强刷磁盘，会覆盖内存中的流式消息；
    // error/closed 终态仍持有绑定（getRuntimeTargetForSession 有 target），但进程已死，
    // 应当允许从磁盘刷新——这里必须按 status 判 live，不能用 target 判（否则 error/closed 的重载入口会被静默吞掉）。
    if (isSessionRuntimeLive(sessionId)) return;
    // 标记重载中：Tab 栏「重载」菜单项/tab 徽章 + 会话消息区域遮罩据此显示 loading 动画
    setReloadingSessionId(sessionId);
    setMutationOverlay({ sessionId, kind: "reloading" });
    setSessionMessageLoadState({ sessionId, state: { status: "loading" } });
    try {
      const page = await api.sessions.readRecordMessagePage(sessionId, undefined, 100);
      setCacheMessages({
        sessionId,
        messages: page.messages,
        source: "disk",
        expectedRevision: 0,
        page: { total: page.total, nextBefore: page.nextBefore },
        force: true,
      });
      setSessionMessageLoadState({ sessionId, state: { status: "ready" } });
      showToast(t("app.sessionReloaded"), 2000);
    } catch (error) {
      setSessionMessageLoadState({
        sessionId,
        state: { status: "error", error: error instanceof Error ? error.message : String(error) },
      });
      showToast(
        t("app.sessionReloadFailed", { error: error instanceof Error ? error.message : String(error) }),
        5000,
      );
    } finally {
      setReloadingSessionId((current) => (current === sessionId ? null : current));
      setMutationOverlay({ sessionId, kind: null });
    }
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
    // 标记停止中：Tab 栏「停止」菜单项/tab 徽章 + 会话消息区域遮罩据此显示 loading 动画
    setStoppingAgentId(agentId);
    setMutationOverlay({ sessionId: target.sessionId, kind: "stopping" });
    try {
      requireSessionCommand(await api.sessions.stopRuntime(target));
    } finally {
      setStoppingAgentId((current) => (current === agentId ? null : current));
      setMutationOverlay({ sessionId: target.sessionId, kind: null });
    }
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
    if (!target) {
      showToast(t("sessionCommand.runtimeUnavailable"), 4000);
      return;
    }
    // 立即清除流式状态，让思考气泡和 loading 立刻消失，不等后端 RPC 返回
    const previous = store.get(sessionRuntimeBySessionIdAtomFamily(target.sessionId))?.state;
    if (previous) {
      applyAgentRuntimeState(agentId, { ...previous, isStreaming: false });
    }
    try {
      requireSessionCommand(await api.sessions.abortRuntime(target));
    } catch (error) {
      // abort 失败必须可见：之前此处直接 throw 变成未处理 rejection，
      // 用户点停止后毫无反馈、agent 继续运行，表现为「停止不了」。
      showToast(error instanceof Error ? error.message : String(error), 5000);
    }
    // 不调用 refreshRuntimeState：AgentManager.abort() 会通过 emitState 推送正确状态，
    // 避免后端 get_state 返回过时的 isStreaming: true 覆盖前端立刻设的 false。
  }

  /**
   * restartRuntime 的核心流程：pending（重启中）动画 + 替换回调 + toast。
   * restartingAgent 仅用于侧栏/tab 的重启中反馈；找不到时（如已 detach 的终态
   * agent 不在 inventory）也照常重启，不因缺少展示对象而阻断。
   */
  async function restartRuntimeTarget(target: SessionRuntimeTarget, restartingAgent?: AgentTab) {
    if (restartingAgent) {
      setRestartingAgentId(restartingAgent.id);
      pendingAgentsRef.current = [
        ...pendingAgentsRef.current.filter((agent) => agent.id !== restartingAgent.id),
        {
          ...restartingAgent,
          status: "starting",
          pendingKind: "restart",
          pendingStartedAt: Date.now(),
        },
      ];
      setPendingAgents(pendingAgentsRef.current);
    }
    try {
      const replacement = requireSessionCommand(await api.sessions.restartRuntime(target));
      if (restartingAgent) {
        pendingAgentsRef.current = pendingAgentsRef.current.filter(
          (agent) => agent.id !== restartingAgent.id,
        );
        setPendingAgents(pendingAgentsRef.current);
      }
      void refreshRuntimeState(replacement.runtime.agentId);
      showToast(t("app.agentRestarted"), 2000);
    } catch (error) {
      if (restartingAgent) {
        pendingAgentsRef.current = pendingAgentsRef.current.map((agent) =>
          agent.id === restartingAgent.id ? { ...agent, status: "error" } : agent,
        );
        setPendingAgents(pendingAgentsRef.current);
      }
      throw error;
    } finally {
      if (restartingAgent) {
        setRestartingAgentId((current) =>
          current === restartingAgent.id ? null : current,
        );
      }
    }
  }

  async function restartActiveAgent(agentId = activeAgentId) {
    if (!agentId) return;
    const restartingAgent = agents.find((agent) => agent.id === agentId) ?? activeAgent;
    if (!restartingAgent) return;
    const target = getRuntimeTargetForAgent(restartingAgent.id);
    if (!target) {
      // error/closed 终态仍保留 agentId+runtimeGeneration（target 存在，可幂等重启）；
      // 只有 detached/无绑定（无 target）才会走到这里。该场景由 restartSessionAnyState
      // 改走 activateRuntime 启动，这里兜底防竞态/其他入口（如模型切换重启）静默无反馈。
      showToast(t("sessionCommand.runtimeUnavailable"), 4000);
      return;
    }
    try {
      await restartRuntimeTarget(target, restartingAgent);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 5000);
    }
  }

  /**
   * 按会话状态分派「重启会话」：失败/未启动/空闲/运行中的统一入口。
   * - 有绑定（runtime.agentId 仍在）→ restartRuntimeTarget；error/closed 终态也能幂等重启。
   * - 无绑定（未启动/detached）→ activateRuntime 启动新 Agent。
   * - restartRuntime 若因「主进程已惰性解绑」抛 SESSION_RUNTIME_UNAVAILABLE/CHANGED
   *   （agent crash 后发消息激活触发主进程 unbindTerminalAgent 但不推事件，前端未同步），
   *   降级 activateRuntime 重新绑定启动——根治「右键重启没反应」。
   */
  async function restartSessionAnyState(sessionId: string) {
    if (!sessionId) return;
    const runtime = store.get(sessionRuntimeBySessionIdAtomFamily(sessionId));
    const target = toSessionRuntimeTarget(sessionId, runtime);
    if (target) {
      try {
        await restartRuntimeTarget(
          target,
          agents.find((agent) => agent.id === target.agentId),
        );
        return;
      } catch (error) {
        const canFallback =
          error instanceof SessionCommandFailure &&
          (error.code === "SESSION_RUNTIME_UNAVAILABLE" || error.code === "SESSION_RUNTIME_CHANGED");
        if (!canFallback) {
          showToast(error instanceof Error ? error.message : String(error), 5000);
          return;
        }
        // 主进程绑定已解绑（前端未同步）：降级为重新激活启动，不重复报错。
        // 先清掉 restart 失败残留的 error pending，避免激活成功后侧栏出现两个同会话 agent。
        pendingAgentsRef.current = pendingAgentsRef.current.filter(
          (agent) => agent.id !== target.agentId,
        );
        setPendingAgents(pendingAgentsRef.current);
      }
    }
    // 未启动/已解绑：激活会话（ensureRuntime 对无绑定会话 create 新 Agent，幂等去重防重复点击）。
    // DSH 会话 runtime 不可用（未安装/损坏）时 host 无法 fork，activateRuntime 只会抛
    // 模块解析裸报错——给「去安装」提示（含直达入口）而不是把底层错误甩给用户。
    const restartRecord = store.get(sessionRecordsAtom)[sessionId];
    if (restartRecord?.backend === "dsh") {
      const dshStatus = store.get(dshRuntimeStatusAtom);
      if (dshSendBlockReason(dshStatus.state)) {
        showDshRuntimeBlockHint(
          () => store.set(openSettingsAtom, DSH_INSTALL_SETTINGS_TARGET),
          dshStatus.state,
          dshStatus.reason,
        );
        return;
      }
    }
    // 重启活会话走 restartRuntimeTarget→restartingAgentId→SessionSurfaceStage 的 isRestarting 遮罩；
    // 这里（无绑定）没有 restartingAgentId，需显式设置 activating 遮罩，让会话消息区域也有加载动画。
    setActivatingSessionId(sessionId);
    setMutationOverlay({ sessionId, kind: "activating" });
    try {
      const activated = requireSessionCommand(
        await api.sessions.activateRuntime(sessionId),
      );
      void refreshRuntimeState(activated.agentId);
      showToast(t("app.sessionStarted"), 2000);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 5000);
    } finally {
      setActivatingSessionId((current) =>
        current === sessionId ? null : current,
      );
      setMutationOverlay({ sessionId, kind: null });
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
    // 与 composer isBusy 对齐（含 isExecutingTool）：DSH 工具执行期间 steer 也应可用。
    return rt?.status === "running" || Boolean((rt?.state as any)?.isStreaming) || Boolean((rt?.state as any)?.isExecutingTool);
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

  async function dispatchPromptSnapshot(
    sessionId: string,
    message: string,
    images?: ImageContent[],
    streamingBehavior?: "steer" | "followUp",
    agentMode: ComposerAgentMode = "normal",
    templateDescription?: string,
  ) {
    // 排队投递与输入框同一套规则：DSH 拒绝 agentMessage，首次目标改写成 /goal。
    const record = store.get(sessionRecordByIdAtomFamily(sessionId));
    const isDsh = record?.backend === "dsh";
    const visibleMessage = isDsh
      ? applyDshGoalSendTransform({
          message,
          mode: agentMode,
          goal: store.get(sessionRuntimeBySessionIdAtomFamily(sessionId))?.state?.goal,
        })
      : message;
    const submission = buildComposerPromptSubmission(
      visibleMessage,
      isDsh ? "normal" : agentMode,
    );
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
    // 排队投递（steer「插入当前回合」/ followUp 排队）同样构成「新一轮」：
    // bump 会话 tick，timeline 侧非最新轮据此收起（设置② collapsePrevRunsOnNewTurn）。
    // 普通发送由 useSessionSend 的 sendPrompt 返回值自己 bump；这里是队列 drain 的
    // 唯一出口，漏掉会导致中断轮（无最终回答）在新一轮开始后仍保持展开。
    store.set(bumpNewTurnCollapseTickAtom, sessionId);
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
    // 非队列入口：当前选中 agent 忙碌时按「忙碌时投递行为」设置决定投递语义
    // （pi/dsh 统一）；空闲直发（undefined）。客户端队列 drain 直接调用
    // dispatchPromptSnapshot，并显式指定其投递语义。
    const behavior =
      streamingBehavior ??
      resolveBusySendDelivery(
        sessionId === currentSessionId && isAgentCurrentlyBusy(),
        store.get(busySendDeliveryAtom),
      );
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

  /** 将主进程抛出的错误消息中的 BUSY_ 前缀码转为前端多语言文案 */
  function translateAgentErrorMessage(msg: string): string {
    if (msg.startsWith("BUSY_STREAMING:")) return t("message.busyStreaming");
    if (msg.startsWith("BUSY_TOOL:")) return t("message.busyTool");
    if (msg.startsWith("BUSY_GENERIC:")) return t("message.busyGeneric");
    return msg;
  }

  /**
   * pi 历史消息改写：无 runtime 直接改 JSONL；有 runtime 先确认停止再改文件。
   * DSH 入口在 Injector 按 backend 隐藏。下次发送才重新激活 Agent。
   */
  const {
    editMessage,
    deleteMessage,
    resendUserMessage,
    forkFromUserMessage,
    forkingMessageId,
  } = useSessionHistoryMutations({
    currentSessionId,
    getRuntimeTargetForSession,
    getRuntimeTargetForAgent,
    isSessionRuntimeLive,
    showConfirm: overlays.showConfirm,
    clearConfirm: overlays.clearConfirm,
    showToast,
    translateAgentErrorMessage,
    submitPromptSnapshot,
    openReplacedRuntimeSession,
    setPromptForAgent,
    setCurrentSessionIdRef: (sessionId) => {
      currentSessionIdRef.current = sessionId;
    },
    isAgentCurrentlyBusy,
    resolveProjectId: (sessionId) =>
      getSessionRecord(sessionId)?.projectId ?? activeProjectId,
    hasPersistedSessionFile: (sessionId) => {
      const record = getSessionRecord(sessionId);
      return Boolean(record?.filePath) && !record?.noSession;
    },
    // 生图 draft：会话消息里存在生图占位/结果即判定为生图模式（无 pi runtime、无 pi JSONL）。
    isImageGenSession: (sessionId) =>
      (store.get(sessionMessagesCacheAtom)?.[sessionId]?.messages ?? []).some(
        (message) => message.meta?.imageGen !== undefined,
      ),
    // 生图重发：把失败的提示词（+参考图）放回输入框供一键重试。参考图直接整体替换附件栏
    //（重发目标就是这轮消息自身，不需要前插保留——那是失败后保留用户新粘贴图的场景）。
    restoreImageGenTurn: (sessionId, text, images) => {
      setSessionDraft({ sessionId, value: text });
      if (images?.length) {
        setSessionAttachments({ sessionId, value: images });
      }
    },
  });


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
        "piProxyBypass" in patch ||
        "piProxyModels" in patch
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

  async function restartWebService() {
    if (!settings.webServiceEnabled || webServiceChanging) return;
    setWebServiceChanging(true);
    showToast(t("settings.webRestarting"));
    try {
      await api.settings.restartWebService();
      showToast(t("settings.webRestarted"));
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    } finally {
      setWebServiceChanging(false);
    }
  }

  const switchBranch = useCallback(
    async (branch: string) => {
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
    },
    [activeProjectId, gitInfo.current, showToast],
  );

  const createBranch = useCallback(
    async (branchName: string) => {
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
    },
    [activeProjectId, showToast],
  );

  /**
   * 折叠中间包模式下的「自动下钻」：展开一个目录时，若它是一条
   * 「单子目录且无文件」的链（Java/Maven、NestJS 等深包结构），
   * 一次把它加载到链尾，让折叠后的点分节点直接展开到真实内容，
   * 避免用户逐层点 11 次。
   */
  async function drillCompactChain(projectId: string, startPath: string) {
    let current = startPath;
    const chain = new Set<string>([startPath]);
    for (let i = 0; i < FILE_TREE_ABSOLUTE_MAX_DEPTH; i++) {
      let children: FileTreeNode[];
      try {
        children = await api.files.list(projectId, { maxDepth: 0, directory: current });
      } catch {
        // 超大目录 / 权限问题：停止下钻，保留已加载部分，避免整条链卡死。
        break;
      }
      if (activeProjectIdRef.current !== projectId) return;
      setFiles((tree) => mergeFileTreeChildren(tree, current, children));
      // 恰 1 个子目录且无文件 → 继续沿链下钻，并把该子目录也标记展开。
      if (children.length === 1 && children[0].type === "directory") {
        current = children[0].path;
        chain.add(current);
        continue;
      }
      break;
    }
    // 整条链（含链尾）一次性并入展开集合：折叠模式下只有链尾 path 可见，
    // 但关闭折叠后整条链仍需保持展开；持久化保证重新打开项目能重建。
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      for (const p of chain) next.add(p);
      if (activeProjectIdRef.current === projectId) saveExpandedDirs(projectId, next);
      return next;
    });
  }

  function toggleDirectory(path: string) {
    // 文件树默认折叠,只有用户显式展开目录才显示子项,避免大仓库一打开就产生视觉噪音。
    let expanding = false;
    setExpandedDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        expanding = true;
      }
      // 持久化展开状态到 localStorage，切换回此项目时恢复
      if (activeProjectId) saveExpandedDirs(activeProjectId, next);
      return next;
    });
    // 首次展开时按需拉这一层；收起或已有 children 只改展开态，避免重复 IPC。
    if (!expanding || !activeProjectId) return;
    const projectId = activeProjectId;
    if (compactMiddlePackagesEnabled) {
      // 折叠模式下沿单子目录链自动下钻，一次展开整条包链
      void drillCompactChain(projectId, path);
      return;
    }
    setFiles((current) => {
      if (findLoadedDirectory(current, path)) return current;
      void api.files
        .list(projectId, { maxDepth: 0, directory: path })
        .then((children) => {
          if (activeProjectIdRef.current !== projectId) return;
          setFiles((tree) => mergeFileTreeChildren(tree, path, children));
        })
        .catch((error) => console.error("[Files] expand failed", error));
      return current;
    });
  }

  function collapseAllDirectories() {
    const collapsedDirs = new Set<string>();
    setExpandedDirs(collapsedDirs);
    // 全部收起同样持久化，避免用户切换项目后又恢复此前展开的目录。
    if (activeProjectId) saveExpandedDirs(activeProjectId, collapsedDirs);
  }

  async function deleteSidebarSession(projectId: string, session: SessionSummary) {
    try {
      await api.sessions.deleteRecord(session.id);
    } catch (error) {
      // 主进程可能拦截删除（会话正在使用中/删除失败），拒绝必须落成友好 toast，
      // 否则会成为未处理 rejection（全局"未处理异常"弹窗，2026-08 用户反馈）。
      // 剥离 Electron 的 "Error invoking remote method 'xxx': " 前缀，只展示主进程真实原因。
      const raw = error instanceof Error ? error.message : String(error ?? "");
      const reason = raw
        .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*/i, "")
        .replace(/^Error:\s*/i, "")
        .trim();
      showToast(reason || t("app.sessionDeleteFailed"), 5000, "error");
      return;
    }
    // 先关 Tab 再清状态，并带走 sibling-dir / parentSessionPath 子会话，避免空态 Composer 残留。
    dismissSessionTree(session, projectId);
    showToast(t("app.sessionDeleted"), 2200);
    await refreshProjectSessions(projectId);
  }

  /** 归档会话：从列表移除但不销毁文件；toast 按后端告知恢复入口（pi 走会话管理，DSH 走配置页归档区） */
  async function archiveSidebarSession(projectId: string, session: SessionSummary) {
    await api.sessions.archiveRecord(session.id);
    dismissSessionTree(session, projectId);
    showToast(archivedSessionToastMessage(session), ARCHIVED_SESSION_TOAST_MS);
    await refreshProjectSessions(projectId);
  }

  /** 恢复归档会话：文件移回原路径并重新扫描 */
  async function unarchiveSidebarSession(archivedPath: string, projectId = activeProjectId) {
    await api.sessions.unarchiveRecord(archivedPath);
    showToast(t("app.sessionRestored"), 2200);
    // 归档管理弹窗可以从非当前项目打开；必须刷新弹窗所属项目，否则文件已恢复但侧栏仍沿用旧目录快照。
    if (projectId) await refreshProjectSessions(projectId);
  }

  /** 恢复 DSH 归档会话：host 目录移回 sessions 树并由主进程重建 catalog 记录 */
  async function unarchiveDshSidebarSession(dshSessionId: string, projectId = activeProjectId) {
    await api.sessions.unarchiveDshSession(dshSessionId);
    showToast(t("app.sessionRestored"), 2200);
    // 恢复目标项目由主进程按 manifest 的 cwd 决定；刷新当前弹窗项目即可让 catalog 快照更新。
    if (projectId) await refreshProjectSessions(projectId);
  }

  /** 列出已归档会话（会话管理弹窗恢复视图用） */
  function listArchivedSidebarSessions() {
    return api.sessions.listArchived();
  }

  /** 永久删除已归档会话（pi 文件归档：文件移入回收站并移出索引） */
  async function deleteArchivedSidebarSession(archivedPath: string) {
    await api.sessions.deleteArchivedRecord(archivedPath);
    showToast(t("app.sessionDeletedFromArchive"), 2200);
    // 归档删除不影响常规目录；刷新当前项目只是让 catalog 快照与磁盘一致。
    const projectId = activeProjectId;
    if (projectId) await refreshProjectSessions(projectId);
  }

  /** 列出 DSH 归档会话（会话管理弹窗归档视图用；与 pi 归档合并展示） */
  function listArchivedDshSidebarSessions() {
    return api.sessions.listArchivedDshSessions();
  }

  /** 永久删除已归档 DSH 会话（host 目录移入回收站） */
  async function deleteArchivedDshSidebarSession(dshSessionId: string) {
    await api.sessions.deleteArchivedDshSession(dshSessionId);
    showToast(t("app.sessionDeletedFromArchive"), 2200);
    const projectId = activeProjectId;
    if (projectId) await refreshProjectSessions(projectId);
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

  /**
   * 修改内置对话区（Chat）的聊天记录保存目录：弹目录选择器 → 主进程写入
   * chat-path.json 并广播 projects:changed → 重新扫描该项目会话列表 → toast 提示。
   * 侧边栏菜单与聊天区头部按钮共用此实现，避免两处 IPC 调用逻辑漂移。
   */
  async function changeChatPath(project: Project) {
    const picked = await api.projects.chooseChatPath();
    if (!picked || picked === project.path) return;
    try {
      await api.projects.setChatPath(picked);
      await refreshProjectSessions(project.id);
      showToast(t("app.chatProjectPathUpdated"), 1800);
    } catch (error) {
      // 主进程拒绝把聊天目录指向已注册的项目目录（CHAT_PATH_OVERLAPS_PROJECT，issue #149）：
      // 同路径会吞掉项目区的新项目，这里给出明确提示而不是静默失败。
      const message = String(error instanceof Error ? error.message : error);
      showToast(
        message.includes("CHAT_PATH_OVERLAPS_PROJECT")
          ? t("app.chatPathOverlapsProject")
          : message,
        5000,
      );
    }
  }

  const sidebarActions: SidebarActions = {
    projects: {
      add: addProject,
      select: (projectId) => {
        selectProjectCommand(projectId);
        // 点开目录只选中项目并显示引导页：不自动创建会话，避免每点一个目录都
        // 悄悄新建一个 agent 会话 tab。创建由用户手动点「启动 Agent / 临时对话」
        // 触发；启动时首项目自动选中除外（见 bootstrapProps.onProjectsChanged）。
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
      refreshAll: refreshAllProjects,
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
      rename: rename.openProjectRename,
      changeChatPath,
    },
    sessions: {
      // 侧栏单击模式由设置 sessionTabOpenMode 控制（默认 preview=临时预览，发消息自动晋升常驻）；
      // 双击仍是显式常驻。tabMode 为 undefined 时用当前设置值。
      open: (projectId, sessionId, tabMode) =>
        openSidebarSessionByIdWithTab(projectId, sessionId, tabMode ?? settings.sessionTabOpenMode),
      beginDrag: workspaceChrome.beginDrag,
      endDrag: workspaceChrome.endDrag,
      createDraft: async (projectId) => {
        await createSessionDraftWithTab(projectId);
      },
      createAnonymous: async (projectId) => {
        await createAnonymousSessionWithTab(projectId);
      },
      deleteDraft: deleteDraftSession,
      rename: rename.openSessionRename,
      export: runExportSidebarSession,
      copy: runCopySidebarSession,
      copyPath: async (session) => {
        // DSH 会话没有 pi 会话文件：走主进程按 dshSessionId + cwd 推导 host 持久化路径（F5）。
        // 失败/不可推导时提示而不是把空值写进剪贴板（原实现会把 undefined 写成 "undefined" 字符串）。
        const path = session.backend === "dsh"
          ? await api.sessions.getDshSessionPath(session.id)
          : session.filePath;
        if (!path) {
          showToast(t("menu.copySessionFilePathUnavailable"), 3000);
          return;
        }
        await navigator.clipboard.writeText(path);
        showToast(t("common.copied"));
      },
      openFile: (session) => api.files.open(session.filePath).catch((error) => {
        showToast(t("app.openFileFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
      }),
      delete: async (projectId, session) => {
        requestDeleteSidebarSession(projectId, session);
      },
      reload: async (_projectId, session) => {
        await reloadSessionMessages(session.id);
      },
      // 重启会话（全状态：失败/未启动/空闲/运行中，按绑定状态分派 restart/activate）
      restart: async (_projectId, session) => {
        await restartSessionAnyState(session.id);
      },
      archive: async (projectId, session) => {
        await archiveSidebarSession(projectId, session);
      },
      unarchive: async (archived, projectId) => {
        await unarchiveSidebarSession(archived.filePath, projectId);
      },
      listArchived: () => listArchivedSidebarSessions(),
      deleteArchived: async (archivedPath) => {
        await deleteArchivedSidebarSession(archivedPath);
      },
      unarchiveDsh: async (dshSessionId, projectId) => {
        await unarchiveDshSidebarSession(dshSessionId, projectId);
      },
      listArchivedDsh: () => listArchivedDshSidebarSessions(),
      deleteArchivedDsh: async (dshSessionId) => {
        await deleteArchivedDshSidebarSession(dshSessionId);
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
      openSessionFile: (agent) => agent.sessionPath
        ? api.files.open(agent.sessionPath).catch((error) => {
          showToast(t("app.openFileFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
        })
        : Promise.resolve(),
      close: requestCloseAgent,
      // 重启会话（全状态）：反查绑定会话走统一分派（live/error/closed 重启，未启动激活）；
      // 反查不到会话（罕见：已 detach 且无绑定）退回 restartActiveAgent 兜底。
      restart: (agent) => {
        const sessionId = store.get(sessionIdByRuntimeAgentIdAtomFamily(agent.id));
        if (sessionId) void restartSessionAnyState(sessionId);
        else restartActiveAgent(agent.id);
      },
      // 重新加载会话消息：按 agentId 反查绑定的会话记录 id（error/closed 仍保留绑定）
      reload: async (agent) => {
        const sessionId = store.get(sessionIdByRuntimeAgentIdAtomFamily(agent.id));
        if (sessionId) await reloadSessionMessages(sessionId);
      },
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
      removingWorktreePaths={removingWorktreePaths}
      isLanWeb={isLanWeb}
      // 「新建会话」：清空当前会话并选中活动项目 → 落到初始引导页（居中输入框 + 项目下拉切换），
      // 用户选择项目后可直接输入对话（首次发送才创建真实会话）。无项目时保持引导页「添加项目」空态。
      onOpenNewSession={() => { if (activeProjectId) selectProjectCommand(activeProjectId); }}
      onOpenFeedback={() => overlays.setFeedbackOpen(true)}
      settingsExpandedProjectIds={settings.sidebarExpandedProjectIds}
      settingsNavTab={settings.sidebarNavTab}
      settingsPinnedSessionIds={settings.pinnedSessionIds}
      settingsLoaded={settingsLoaded}
      onExpandedProjectsReady={() => setExpandedProjectsReady(true)}
      // 官网主页是品牌入口，强制系统浏览器打开：不受「链接打开方式=内置浏览器」设置影响
      onOpenHomepage={() => void api.app.openExternal("https://ayuayue.github.io/PiDeck/", true)}
      // 底栏主题按钮：点击在浅/暗之间翻转；跟随系统/跟随时间退出自动时按当前实际明暗翻到对面，
      // 保证每次点击都有可见变化。落库后只合并 theme 字段，data-theme 由外观 effect 依赖 settings.theme 重应用。
      themeMode={settings.theme}
      onToggleTheme={() => {
        void api.settings
          .update({
            theme: toggleThemeMode(
              settings,
              window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? false,
            ),
          })
          .then((saved) => setSettings((current) => ({ ...current, theme: saved.theme })))
          .catch(() => undefined);
      }}
    />
  );

  // Gate 4.6 — Session view wrapped in SessionRuntimeInjector / ChatSessionPane

  // 会话 Tab 栏始终外置挂载；分屏双栏共享同一条 Tab，单栏也不再嵌入 SessionView。
  const focusSessionPane = useCallback((sessionId: string) => {
    const record = store.get(sessionRecordByIdAtomFamily(sessionId));
    if (record) selectSessionCommand(record.projectId, sessionId, true);
  }, [selectSessionCommand, store]);

  // 后台 Ask 通知「前往会话」：跳转的同时登记常驻 Tab——agent 开多时被询问的会话
  // 可能根本没开 Tab（后台并行 ask 等），只切焦点的话回答完切换出去就找不到了。
  const jumpToAskSession = useCallback((sessionId: string) => {
    const record = store.get(sessionRecordByIdAtomFamily(sessionId));
    if (!record) return;
    workspaceChrome.registerOpenSession(sessionId, "permanent");
    selectSessionCommand(record.projectId, sessionId, true);
  }, [selectSessionCommand, store, workspaceChrome]);

  // 切会话过渡：会话区整体做一次 160ms 淡入+微位移（Web Animations API，
  // 不卸载树/不动布局，避免整树重建的卡顿与瞬间替换的生硬）；
  // 首次挂载不播，prefers-reduced-motion 下跳过。
  const chatPaneContentRef = useRef<HTMLDivElement>(null);
  const prevSessionIdRef = useRef(currentSessionId);
  useEffect(() => {
    const el = chatPaneContentRef.current;
    if (!el || prevSessionIdRef.current === currentSessionId) return;
    const prev = prevSessionIdRef.current;
    prevSessionIdRef.current = currentSessionId;
    // 分屏内面板间聚焦切换：各栏都已渲染、内容未变，只有聚焦边框亮起；
    // 整区重播淡入微位移会造成「抖/闪」，静默跳过（边框高亮由
    // .session-split-pane-focused 类切换承担，无动画）。
    const layout = workspaceChrome.splitLayout;
    const splitIds = layout ? splitLayoutSessionIds(layout) : [];
    const prevInSplit = Boolean(layout && prev && splitIds.includes(prev));
    const nextInSplit = Boolean(
      layout && currentSessionId && splitIds.includes(currentSessionId),
    );
    if (prevInSplit && nextInSplit) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const anim = el.animate(
      [
        { opacity: 0, transform: "translateY(4px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 160, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
    return () => anim.cancel();
  }, [currentSessionId, workspaceChrome.splitLayout]);

  const sessionTabsProps = {
    tabs: workspaceChrome.sessionTabIds,
    pinnedTabs: workspaceChrome.pinnedSessionTabIds,
    previewTabId: workspaceChrome.previewSessionTabId,
    currentSessionId,
    onSelect: workspaceChrome.selectTab,
    onPromotePreview: workspaceChrome.promotePreview,
    onClose: workspaceChrome.closeTab,
    onCloseOthers: workspaceChrome.closeOtherTabs,
    onCloseAll: workspaceChrome.closeAllTabs,
    // Tab 栏 “+” 下拉的新建目标：聊天对话区置顶，其余按侧栏项目顺序
    newSessionTargets: projects
      .map((project) => ({
        projectId: project.id,
        label: isChatProject(project) ? t("app.chatProject") : project.name,
        isChat: isChatProject(project),
      }))
      .sort((a, b) => Number(b.isChat) - Number(a.isChat)),
    onNewSessionInProject: (projectId: string) => {
      void createSessionDraftWithTab(projectId);
    },
    onTogglePin: workspaceChrome.togglePin,
    onReorder: workspaceChrome.reorderTab,
    // 分屏组胶囊：分屏内会话聚合为组（颜色标记 + 展开/收起）
    splitGroupIds: workspaceChrome.splitLayout
      ? splitLayoutSessionIds(workspaceChrome.splitLayout)
      : [],
    splitGroupCollapsed: workspaceChrome.splitGroupCollapsed,
    onToggleSplitGroup: workspaceChrome.toggleSplitGroupCollapsed,
    splitGroupName: workspaceChrome.splitGroupConfig.name,
    splitGroupColor: workspaceChrome.splitGroupConfig.color,
    onSplitGroupRename: (name: string) =>
      workspaceChrome.setSplitGroupConfig((config) => ({ ...config, name })),
    onSplitGroupColorChange: (color: string) =>
      workspaceChrome.setSplitGroupConfig((config) => ({ ...config, color })),
    onExitAllSplit: workspaceChrome.exitAllSplit,
    // Tab 下拉运行控制：只对当前会话 Tab 生效。
    // 停止 Agent = 停掉当前会话绑定的 pi/DSH 进程（保留会话与 Tab，可随时重启/重载），
    // 与「关闭标签页」仅移除 Tab 不同；无绑定或已终态（error/closed）的会话隐藏停止入口。
    canStopCurrent: isLiveRuntimeStatus(activeAgent?.status),
    isStoppingCurrent: stoppingAgentId === activeAgentId,
    onStopCurrent: activeAgentId
      ? () => {
          void closeAgent(activeAgentId).catch((error) => {
            showToast(error instanceof Error ? error.message : String(error), 5000);
          });
        }
      : undefined,
    // 重启会话对所有状态开放：有绑定运行实例（starting/idle/running/error/closed）走
    // restartRuntime（主进程幂等 stop+重建）；未绑定（未启动/detached）走 activateRuntime。
    // 分派逻辑统一收敛在 restartSessionAnyState（不再用 isLiveRuntimeStatus 挡 error/closed）。
    canRestartCurrent: Boolean(currentSessionId),
    isRestartingCurrent:
      restartingAgentId === activeAgentId || activatingSessionId === currentSessionId,
    onRestartCurrent: currentSessionId
      ? () => void restartSessionAnyState(currentSessionId)
      : undefined,
    // 重新加载会话：无 live 运行时（未启动/error/closed）时可用，从磁盘刷新消息文件；
    // live 会话刷新走重启即可，不做磁盘强刷以免覆盖内存中的流式消息。
    canReloadCurrent: Boolean(currentSessionId) && !isLiveRuntimeStatus(activeAgent?.status),
    isReloadingCurrent: reloadingSessionId === currentSessionId,
    onReloadCurrent: currentSessionId
      ? () => void reloadSessionMessages(currentSessionId)
      : undefined,
    onToggleDrawer: toggleRightDrawer,
    drawerOpen: Boolean(drawer && !drawerCollapsed),
    listCollapsed,
    onToggleListCollapsed: toggleListCollapsed,
    onDragSessionChange: (sessionId: string | null) => {
      if (sessionId) workspaceChrome.beginDrag(sessionId);
      else workspaceChrome.endDrag();
    },
  };

  const paneLayoutRefs = useMemo(
    () => ({
      chatHeaderRef,
      composerRef,
      composerOffsetHeight,
      terminalRowHeight,
    }),
    [composerOffsetHeight, terminalRowHeight],
  );
  // App 级激活 owner 键（聚焦会话/runtime 对应桶）：分屏各栏用它做“同 owner 去重”参照；
  // 先算成稳定字符串再进 memo 依赖，避免 terminalOwner 每次渲染新建对象把 memo 打穿。
  const activeTerminalOwnerKey = terminalOwner
    ? terminalOwnerKey(terminalOwner)
    : undefined;

  const sessionPaneServices = useMemo(
    () => ({
      isLanWeb,
      promoteSessionToPermanent: workspaceChrome.promotePreview,
      showToast,
      onOpenFile: handleOpenLinkedFile,
      onDiffFile: diffFilePath,
      onPreviewImage: setPreviewImage,
      abortAgent,
      restartActiveAgent,
      runCreateSessionDraft: async () => {
        await createSessionDraftWithTab();
      },
      enqueueSessionPrompt,
      insertQuickPrompt,
      ensureSessionId: ensureSessionForSend,
      resendUserMessage,
      editMessage,
      deleteMessage,
      forkFromUserMessage,
      forkingMessageId,
      openSidebarSessionById: (projectId: string, sessionId: string) =>
        openSidebarSessionByIdWithTab(projectId, sessionId, "permanent"),
      focusAskSessionById: jumpToAskSession,
      agents: displayAgents,
      queuedPromptsBySession: queue.queuedPrompts,
      queueRetract: queue.retractQueuedPromptForEdit,
      queueDiscard: queue.discardQueuedPrompt,
      queueChangeBehavior: queue.setQueuedPromptBehavior,
      queueFlushBySessionRef,
      restartingAgentId,
      sessionDurationByAgent,
      activeProjectId,
      gitInfo,
      onSwitchBranch: switchBranch,
      showThinking: settings.showThinking,
      validCommandNames,
      validFilePaths,
      terminalStatesByOwner,
      activeTerminalOwnerKey,
      availableTerminalHeight: availableTerminalHeight ?? 120,
      setTerminalOpenByOwnerKey,
      setTerminalCollapsedByOwnerKey,
      setTerminalHeight,
      environmentDialog: Boolean(environmentDialog),
      showNotice,
      api,
      changeChatPath,
      jumpToMessageRef,
      layoutRefs: paneLayoutRefs,
      exitSessionSplit: workspaceChrome.exitSplit,
    }),
    [
      abortAgent,
      activeTerminalOwnerKey,
      activeProjectId,
      availableTerminalHeight,
      createSessionDraftWithTab,
      changeChatPath,
      deleteMessage,
      diffFilePath,
      displayAgents,
      editMessage,
      enqueueSessionPrompt,
      switchBranch,
      ensureSessionForSend,
      environmentDialog,
      forkFromUserMessage,
      forkingMessageId,
      gitInfo,
      handleOpenLinkedFile,
      insertQuickPrompt,
      isLanWeb,
      jumpToAskSession,
      jumpToMessageRef,
      openSidebarSessionByIdWithTab,
      paneLayoutRefs,
      queue.discardQueuedPrompt,
      queue.queuedPrompts,
      queue.retractQueuedPromptForEdit,
      queueFlushBySessionRef,
      restartActiveAgent,
      restartingAgentId,
      resendUserMessage,
      sessionDurationByAgent,
      settings.showThinking,
      setPreviewImage,
      setTerminalCollapsedByOwnerKey,
      setTerminalHeight,
      setTerminalOpenByOwnerKey,
      showToast,
      terminalStatesByOwner,
      availableTerminalHeight,
      validCommandNames,
      validFilePaths,
      workspaceChrome.exitSplit,
      workspaceChrome.promotePreview,
    ],
  );

  const chatPaneSessionNode = (
    <SessionPaneServicesProvider value={sessionPaneServices}>
      {currentSessionId ? (
        <div ref={chatPaneContentRef} className="flex h-full min-h-0 min-w-0 flex-col">
          <SessionSplitStage
            layout={
              // 视图投影：焦点会话在布局中 → 显示分屏；不在（新建/打开/退出分屏）→ 全屏 solo，
              // 布局状态保留，点布局内会话即恢复分屏视图
              workspaceChrome.splitLayout &&
              splitLayoutSessionIds(workspaceChrome.splitLayout).includes(currentSessionId)
                ? workspaceChrome.splitLayout
                : null
            }
            draggingSessionId={workspaceChrome.draggingSessionId}
            onDropSplit={workspaceChrome.dropSplit}
            solo={
              <ChatSessionPane
                sessionId={currentSessionId}
                focused
                onFocusPane={() => focusSessionPane(currentSessionId)}
                splitPane={false}
              />
            }
            soloSessionId={currentSessionId}
            tabCount={workspaceChrome.sessionTabIds.length}
            renderSession={(sessionId) => (
              <ChatSessionPane
                key={sessionId}
                sessionId={sessionId}
                focused={currentSessionId === sessionId}
                onFocusPane={() => focusSessionPane(sessionId)}
                splitPane
              />
            )}
          />
        </div>
      ) : (
        // 无当前会话（普通项目点开 / 所有 Tab 关闭）时，普通项目与 Chat 项目
        // 共享统一空态；快捷操作新建 Agent / 匿名聊天，无项目时引导添加项目。
        // 引导页同样可以打开项目级终端（owner=project）：与有会话视图同构的
        // 垂直分屏形态，分隔条拖拽调高，高度经 localStorage 持久化跨重启恢复。
        // key 随终端挂载变化：面板数变化必须重建 Group（同 sessionResizableGroupKey）。
        <ResizablePanelGroup
          key={`empty-terminal-${terminalDockVisible ? "docked" : "solo"}`}
          orientation="vertical"
          className="min-h-0 flex-1"
        >
          <ResizablePanel id="empty-main" minSize={200} className="flex min-h-0 flex-col">
            {/* 无会话空态：引导页 = 新建页面形态（居中 ComposerArea + 虚拟会话），
                不登记 Tab；首次发送才由 ensureSessionForSend 创建真实会话并落 Tab */}
            <ProjectEmptyState
              activeProject={activeProject}
              projects={projects}
              onAddProject={() => void addProject()}
              onSelectProject={selectProjectCommand}
            />
          </ResizablePanel>
          {!isLanWeb && terminalDockVisible && terminalTarget && (
            <TerminalDockPanel
              target={terminalTarget}
              open={terminalOpen}
              closing={terminalDockClosing}
              collapsed={terminalCollapsed}
              height={terminalRowHeight}
              maxHeight={availableTerminalHeight ?? 120}
              terminal={api.terminal}
              ownerKey={terminalOwner ? terminalOwnerKey(terminalOwner) : undefined}
              onOpenChange={setTerminalOpenForOwner}
              onCollapsedChange={setTerminalCollapsedForOwner}
              onHeightChange={setTerminalHeight}
            />
          )}
        </ResizablePanelGroup>
      )}
    </SessionPaneServicesProvider>
  );

  const workbenchTheme: "dark" | "light" =
    typeof document !== "undefined" && document.documentElement.dataset.theme === "dark"
      ? "dark"
      : "light";

  // Git Diff 优先于文件编辑器（同一时刻只挂一份阅读面）
  const workbenchHasGitDiff = Boolean(
    gitDrawerDiff && gitDrawerDiff.projectId === activeProjectId,
  );
  const workbenchHasEditor = Boolean(activeTab) && !workbenchHasGitDiff;
  const workbenchHasContent = workbenchHasGitDiff || workbenchHasEditor;
  // 工作台内容区宽度：分屏（文件/Diff 在右）时右缘刻度轴需贴消息区右缘，
  // 由 WorkbenchStage 实时上报（split 分屏才上报；solo/maximize 归零）。
  const [workbenchContentWidth, setWorkbenchContentWidth] = useState(0);
  const handleWorkbenchContentWidth = useCallback((width: number) => {
    setWorkbenchContentWidth((current) =>
      // 相同宽度跳过，避免拖拽分隔条时反复重渲染
      current === width ? current : width,
    );
  }, []);
  const workbenchLayout = workbenchHasGitDiff ? gitDiffDisplayMode : editorMode;

  // 文件/Diff Tab 挂进总 SessionTabsBar：与会话共用一条栏，内容区不再另起绿条 Tab
  const workbenchEditorTabs = workbenchHasGitDiff && gitDrawerDiff
    ? [
        {
          id: gitDrawerDiff.filePath,
          label: gitDrawerDiff.label,
          title: gitDrawerDiff.filePath,
          active: true,
        },
      ]
    : workbenchHasEditor
      ? editorTabs.map((tab) => ({
          id: tab.id,
          label:
            tab.label ??
            tab.filePath.split(/[/\\]/).pop() ??
            tab.filePath,
          title: tab.filePath,
          preview: tab.id === previewEditorTabId,
          active: tab.id === activeTabId,
        }))
      : [];

  // 工具开关上收会话 Tab 栏（原右侧悬浮工具条入口的唯一挂载点）：
  // 草稿纸 / 终端 / 外部编辑器，与抽屉开关同排。
  // 终端按钮绑定 owner（agent 或项目），不再要求 agent 已激活；
  // web 预览 / 无可用目标（纯聊天无项目）时隐藏，避免指向无处可开的终端。
  const sessionToolActions: SessionToolAction[] = [
    {
      id: "scratch",
      label: t("scratchPad.openTooltip"),
      icon: <Pencil size={14} />,
      active: scratchPad.isOpen,
      onClick: () => scratchPad.toggle(),
    },
    ...(!isLanWeb && terminalTarget
      ? [
          {
            id: "terminal",
            label: t("app.terminal"),
            icon: <Terminal size={14} />,
            active: terminalOpen,
            onClick: () => {
              setTerminalOpenForOwner(!terminalOpen);
            },
          },
        ]
      : []),
    {
      id: "editors",
      label: t("app.openWithEditor"),
      icon: <Code size={14} />,
      active: editorsOpen,
      onClick: (e) => {
        const projectPath =
          activeAgent?.cwd ||
          (activeProject && !isChatProject(activeProject)
            ? activeProject.path
            : null);
        // 无项目目录也允许打开：编辑器入口在气泡内禁用并提示，
        // 文件管理器不依赖项目（空路径由主进程回退用户主目录）
        const anchor = adjustMenuPos(
          e.currentTarget.getBoundingClientRect().left - 4,
          e.currentTarget.getBoundingClientRect().bottom + 4,
          240,
          240,
        );
        workspace.openExternalEditorChooser(projectPath || "", anchor);
      },
    },
  ];

  const sessionTabsBarNode = (
    <SessionTabsBar
      {...sessionTabsProps}
      toolActions={sessionToolActions}
      editorTabs={workbenchEditorTabs}
      onSelectEditorTab={(tabId) => {
        if (workbenchHasGitDiff) return;
        selectEditorTab(tabId);
      }}
      onCloseEditorTab={(tabId) => {
        if (workbenchHasGitDiff) {
          closeGitDiff();
          return;
        }
        closeEditorTab(tabId);
      }}
      onPromoteEditorPreview={promotePreviewEditorTab}
    />
  );

  const workbenchContentNode = workbenchHasContent ? (
    <WorkbenchContent
      theme={workbenchTheme}
      maxFileSizeMB={settings.maxEditorFileSizeMB}
      gitDiff={workbenchHasGitDiff && gitDrawerDiff ? gitDrawerDiff : null}
      gitDiffDisplayMode={gitDiffDisplayMode}
      onToggleGitDiffMode={toggleGitDiffDisplayMode}
      onCloseGitDiff={closeGitDiff}
      activeTab={workbenchHasEditor && activeTab ? activeTab : null}
      editorMode={editorMode}
      onToggleEditorMode={activeTab?.preserveDrawer ? undefined : toggleEditorMode}
      onCloseEditor={() => { closeEditor(); }}
      readContent={readEditorFileContent}
      readOriginalContent={readEditorOriginalContent}
      saveContent={saveEditorFileContent}
    />
  ) : null;

  const chatPaneContentNode = (
    <WorkbenchStage
      chrome={sessionTabsBarNode}
      layout={workbenchLayout}
      hasContent={workbenchHasContent}
      session={chatPaneSessionNode}
      content={workbenchContentNode}
      onContentWidthChange={handleWorkbenchContentWidth}
    />
  );

  // ── DrawerSurface port objects (stable via useMemo) ──
  const drawerPorts = useDrawerPorts({
    enableGitManagement: settings.enableGitManagement, activeProjectId,
    gitDrawerDiff, gitDiffDisplayMode,
    openCommitFileDiff, openWorkspaceFileDiff,
    toggleGitDiffDisplayMode, closeGitDiff, dismissGitDiff,
    gitApi: api.git, gitInfo,
    switchBranch, createBranch,
    openDrawer: workspace.openDrawer,
    closeDrawer: workspace.closeDrawer,
    collapseDrawer: workspace.collapseDrawer,
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
    refreshFiles: refreshVisibleFiles,
    showToast,
    projects,
    refreshProjectSessions,
    runOpenSidebarSession: async (projectId: string, session: SessionSummary) => {
      const openedId = await runOpenSidebarSession(projectId, session);
      if (openedId) workspaceChrome.registerOpenSession(openedId, "permanent");
    },
    isSameSessionPath,
    runCopySession, runExportHistorySession, runDeleteHistorySession,
    viewFilePath, openFilePath, openEditorTab,
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
          void refreshVisibleFiles();
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
            void refreshVisibleFiles();
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
        void refreshVisibleFiles();
        showToast(t("app.fileMoveDone", { count: sourcePaths.length }), 2000);
      }).catch((error) => {
        showToast(error instanceof Error ? error.message : String(error), 4000);
      });
    },
  });


  return (
    // 非会话静态区域使用当前焦点作为兜底；每个 SessionRuntimeInjector 会用本栏 cwd/project 覆盖。
    <FileLinkBaseProvider
      baseDir={activeAgent?.cwd ?? activeProject?.path}
      projectId={activeProject?.id}
      projectRoot={activeProject?.path}
    >
    <>
      <AppBootstrap {...bootstrapProps} />
    <AppShell
      listCollapsed={listCollapsed}
      listWidth={listWidth}
      drawer={drawer}
      drawerCollapsed={drawerCollapsed}
      drawerWidth={drawerWidth}
      useNativeTitleBar={settings.useNativeTitleBar}
      platform={appInfo.platform}
      chatPaneRef={chatPaneRef}
      terminalRowHeight={terminalRowHeight}
      chatContentWidthPct={settings.chatContentWidthPct}
      outlineContentOffset={workbenchContentWidth}
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
            // 编辑器入口已迁到分屏（SessionTabsBar），右侧抽屉不再提供 editor 面板
            // Git 面板受设置开关与项目上下文双重门控，与 outline 入口保持一致
            ...(settings.enableGitManagement && activeProjectId ? [{
              id: "git",
              label: t("drawer.sourceControl"),
              icon: <GitBranch size={16} />,
              active: drawer === "git",
              onClick: () => handleToolDrawerAction("git"),
            }] : []),
            // 轨迹固定在内置浏览器前面：有 Git 时是第 3 个（files / git / trajectory / browser）。
            {
              id: "trajectory",
              label: t("session.view.trajectory"),
              icon: <Activity size={16} />,
              active: drawer === "trajectory",
              onClick: () => handleToolDrawerAction("trajectory"),
            },
            // 检查点面板：仅当前会话为 pi 后端时展示（rewind 能力；dsh 暂不声明）。
            ...(rewindSupported
              ? [{
                  id: "rewind" as const,
                  label: t("rewind.title"),
                  icon: <History size={16} />,
                  active: drawer === "rewind",
                  onClick: () => handleToolDrawerAction("rewind"),
                }]
              : []),
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
          git={drawerPorts.git}
          chrome={drawerPorts.chrome}
          browser={drawerPorts.browser}
          files={drawerPorts.files}
        />
      )}
      setListCollapsed={setListCollapsed}
      setListWidth={setListWidth}
      setDrawerCollapsed={setDrawerCollapsed}
      setDrawerWidth={setDrawerWidth}
      onToggleListCollapsed={toggleListCollapsed}
      drawerPinned={workspace.drawerPinned}
      onDrawerCollapse={workspace.collapseDrawer}
      onDrawerClose={workspace.closeDrawer}
      onDrawerRestore={() => workspace.expandDrawer()}
      onToggleDrawerPin={workspace.toggleDrawerPinned}
      toggleAlwaysOnTop={api.app.toggleAlwaysOnTopWindow}
      isWindowAlwaysOnTop={api.app.isWindowAlwaysOnTop}
      minimizeWindow={api.app.minimizeWindow}
      toggleMaximizeWindow={api.app.toggleMaximizeWindow}
      isWindowMaximized={api.app.isWindowMaximized}
      onWindowMaximizedChange={api.app.onWindowMaximizedChange}
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
                void refreshVisibleFiles();
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
          void api.files.open(fileMenu.node.path).catch((error) => {
            showToast(t("app.openFileFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
          });
          setFileMenu(null);
        }}
        onReveal={() => {
          void api.files.showInFolder(fileMenu.node.path).catch((error) => {
            showToast(t("app.openFileFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
          });
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
                void refreshVisibleFiles();
                showToast(t("app.fileDeleted"), 2000);
              } catch (error) {
                // 回收站不可用、权限不足或文件已被外部移走时，必须把主进程错误呈现给用户；
                // 仅写控制台会让确认框关闭后看起来像“点击无效”。
                showToast(t("app.fileDeleteFailed", {
                  error: String(error instanceof Error ? error.message : error).replace(/^Error:\s*/, ""),
                }), 5000, "error");
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
      rename={rename.renameModalsProps.rename}
      fileRename={renamingFile ? {
        path: renamingFile.path,
        name: renamingFile.name,
        inputValue: renamingFileInput,
        onInputChange: setRenamingFileInput,
        onClose: () => setRenamingFile(null),
        onConfirm: (path, newName) => {
          void api.files.rename(path, newName).then(() => {
            void refreshVisibleFiles();
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
      onRestartWebService={restartWebService}
      appInfo={appInfo}
      onChange={updateSettings}
      onCurrentVersion={setUpToDateVersion}
      projectPath={activeProject?.path}
    />
    {/*
     * 问题反馈弹窗的「新建会话分析」依赖 App 级会话创建能力（createSessionDraftWithTab），
     * 在装配层组合：useOverlayActions 只持开关状态，会话创建与预填在此处注入。
     */}
    <SessionActionOverlays
      {...overlays.overlayProps}
      feedback={
        overlays.overlayProps.feedback
          ? {
              ...overlays.overlayProps.feedback,
              props: {
                ...overlays.overlayProps.feedback.props,
                onCreateSessionWithPrompt: handleFeedbackCreateSession,
              },
            }
          : undefined
      }
    />
    <AppUpdateOverlay
      controller={{ ...appUpdate, clear: dismissAppUpdate }}
      releasesUrl={appInfo.releasesUrl}
      openExternal={(url, forceSystem) => api.app.openExternal(url, forceSystem)}
      upToDateVersion={upToDateVersion}
      onDismissUpToDate={() => setUpToDateVersion(null)}
      onSkipVersion={(version) => {
        void api.app.skipUpdateVersion(version);
        void api.app.notifyUpdateSeen("app", version);
        appUpdate.clear();
      }}
    />
    {previewImage && (
      <ImagePreviewModal
        image={previewImage}
        onClose={() => setPreviewImage(null)}
      />
    )}
    {codexImportProject && <ImportOverlayHost kind="codex" project={codexImportProject} controller={codexImportController} onClose={() => setCodexImportProject(null)} />}
    {claudeImportProject && <ImportOverlayHost kind="claude" project={claudeImportProject} controller={claudeImportController} onClose={() => setClaudeImportProject(null)} />}
    {openCodeImportProject && <ImportOverlayHost kind="opencode" project={openCodeImportProject} controller={openCodeImportController} onClose={() => setOpenCodeImportProject(null)} />}

    {/* Scratch Pad（草稿本）：根级渲染，避免受 chat-pane grid 影响定位 */}
    <ScratchPadOverlay controller={scratchPad} />

    {/* 并行问询结果弹框（AskPanel）：独立匿名会话的结果展示，根级渲染 */}
    <AskPanelOverlay />

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
    </FileLinkBaseProvider>
  );
}

// test
