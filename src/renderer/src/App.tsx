import { Button } from "./components/ui-shadcn/button";
import { NoticeHistoryDialog } from "./components/ui-shadcn/notice-history-dialog";
import { useSessionNavigation } from "./hooks/useSessionNavigation";
import { WorkbenchFileTabs } from "./components/workspace/WorkbenchFileTabs";
import { ArrowLeft, ArrowRight, PanelLeft } from "lucide-react";
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from "react";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { toggleThemeMode } from "./themeAppearance";
import {
	Code,
	Activity,
	FolderOpen,
	Globe,
	History,
	Pencil,
	Terminal,
	GitBranch,
	ListTree,
	// 命令面板（Ctrl/Cmd+P）操作项图标
	SquarePen,
	Settings2,
	RotateCw,
	CircleStop,
	RefreshCw,
	Fingerprint,
	// 抽屉 RPC 日志 Tab 图标
	ScrollText,
} from "lucide-react";
import { configureNoticeDefaults, showNotice, type NoticeKind } from "./utils/notice";
import { copyTextWithCopiedNotice } from "./utils/clipboardNotice";
import { buildSettingsCommands, type PaletteCommand } from "./utils/commandPaletteCommands";
import { CommandPalette } from "./components/overlays/CommandPalette";
import { CommandPaletteOnboarding, markCommandPaletteOnboardingSeen } from "./components/overlays/CommandPaletteOnboarding";
import { desktopApi as api, isLanWeb, missingElectronPreload } from "./desktopApi";
import {
	turnFlowSettingsAtom,
	defaultAgentBackendAtom,
	effectiveAgentBackendAtom,
	busySendDeliveryAtom,
	hiddenModulesAtom,
	imageGenConfigAtom,
	enhanceModelAtom,
	dshRuntimeStatusAtom,
	openSettingsAtom,
	openAutomationModalAtom,
	sessionRecordsAtom,
	bumpNewTurnCollapseTickAtom,
	rpcLoggingAgentIdsAtom,
	toggleRpcLoggingAgent,
} from "./atoms";
import { type SidebarActions } from "./components/sidebar/SidebarContent";
import { AppSidebar } from "./components/sidebar/AppSidebar";
import { AppBootstrap } from "./components/app/AppBootstrap";
import { SettingsFeatureRoot } from "./components/app/SettingsFeatureRoot";
import { AutomationModal } from "./components/automation/AutomationModal";
import { useRename } from "./hooks/useRename";
import { useProjectRuntimeCapabilities } from "./hooks/useRuntimeCapabilities";
import { useSessionRuntimeBridge } from "./hooks/useSessionRuntimeBridge";
import { useAgentLoadNotice } from "./hooks/useAgentLoadNotice";
import { useArchMismatchNotice } from "./hooks/useArchMismatchNotice";
import { useAnnouncementNotifier } from "./hooks/useAnnouncementNotifier";
import { useModelsVerifyNotifier } from "./hooks/useModelsVerifyNotifier";
import { useBackgroundAskPatrol } from "./hooks/useBackgroundAskPatrol";
import { announcementCenterOpenAtom, announcementNotificationEnabledAtom } from "./atoms/announcement-atoms";
import { logoStyleAtom } from "./atoms/app-ui-atoms";
import { LOGO_STYLE_STORAGE_KEY, resolveLogoStyle } from "./components/app/piTuiLogoData";
import { openProviderLoginAtom } from "./atoms/providerLoginAtoms";
import { useSessionLayout } from "./hooks/useSessionLayout";
import { useFileEditor } from "./hooks/useFileEditor";
import { useSessionFileLinks } from "./hooks/workspace/useSessionFileLinks";
import { useOverlayActions } from "./hooks/useOverlayActions";
import { useWorkspacePanels, type WorkspaceDrawerPanel, type WorkspaceExternalEditorAdapter } from "./hooks/useWorkspacePanels";
import { useDrawerPorts } from "./hooks/useDrawerPorts";
import { useTerminalDock } from "./hooks/useTerminalDock";
import { resolveTerminalOwner, terminalOwnerKey } from "./terminalDockState";
import { useImportFlow } from "./hooks/useImportFlow";
import { useDirectoryImport } from "./hooks/useDirectoryImport";
import { useQueuedPrompt } from "./hooks/useQueuedPrompt";
import { activeAgentIdAtom } from "./hooks/useSessionRuntimeController";
import { useSessionHistoryMutations } from "./hooks/useSessionHistoryMutations";
import { useUserMessageEditReplay } from "./hooks/useUserMessageEditReplay";
import { isLiveRuntimeStatus, sessionCommandFailureToast, type SessionRunCapabilities, type SessionRunAction } from "./utils/sessionCommands";
import { GUIDE_BOOTSTRAP_SESSION_ID, readWelcomeAcpToolPreference, readWelcomeBackendPreference, readWelcomeDshModelPreference, readWelcomeModelPreference, readWelcomeThinkingPreference, resolveChatSessionBootstrap, resolveGuidePageBackend } from "./utils/chatSessionBootstrap";
import { useAppAppearance } from "./hooks/appearance/useAppAppearance";
import { useAppBootstrapInfo } from "./hooks/app/useAppBootstrapInfo";
import { useBootOverlayReady } from "./hooks/app/useBootOverlayReady";
import { useCommandPalette } from "./hooks/app/useCommandPalette";
import { useSidebarArchiveActions } from "./hooks/sidebar/useSidebarArchiveActions";
import { useSettingsUpdater } from "./hooks/settings/useSettingsUpdater";
import { useSessionRunControl } from "./hooks/session/useSessionRunControl";
import { useProjectFileTreeController } from "./hooks/files/useProjectFileTreeController";
import { useSessionDurationTracking } from "./hooks/session/useSessionDurationTracking";
import { useSessionPromptDispatch } from "./hooks/session/useSessionPromptDispatch";

import { usePiUpdate } from "./hooks/usePiUpdate";
import { useProviderUsageStartupWarmup } from "./hooks/useProviderUsage";

import { useBackgroundUpdateWatch } from "./hooks/useBackgroundUpdateWatch";
import { useChannelSwitchWatch } from "./hooks/useChannelSwitchWatch";
import { useDataEnvWatch } from "./hooks/useDataEnvWatch";
import { DataModeChoiceDialog } from "./components/app/DataModeChoiceDialog";
import { DataEnvMismatchDialog } from "./components/app/DataEnvMismatchDialog";
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
	promoteSessionComposerStateAtom,
	promoteSessionMessagesCacheAtom,
	setSessionAttachmentsAtom,
	setSessionCatalogLoadStateAtom,
	setSessionMessageLoadStateAtom,
	setSessionHistoryMutationOverlayAtom,
	setSessionDraftAtom,
	cacheSessionMessagesAtom,
	upsertSessionAtom,
	acpToolsAtom,
	acpEnabledAtom,
} from "./atoms";
import { isSameSessionPath } from "./agentListDisplay";
import { t } from "./i18n";
import { isChatProject, loadSessionSourceFilter, saveSessionSourceFilter, isReplacementForPendingAgent, isPendingAgentId, migrateAgentRecord, stampIdleSessionDuration, type PendingAgentTab } from "./rendererUtils";
import { reorderProjectList } from "./utils/projectOrder";
import { MiniOverlaySurface } from "./components/mini-overlay/MiniOverlaySurface";
import type { SessionFilterPill } from "./sessionFilterPills";
import { useResize } from "./hooks/useResize";
import { ARCHIVED_SESSION_TOAST_MS, archivedSessionToastMessage, useSessionActions } from "./hooks/useSessionActions";
import { useScratchPad } from "./hooks/useScratchPad";
import { useDshRuntimeStatusSync } from "./hooks/useDshRuntimeStatusSync";
import { useDshRuntimeMigrationNotice } from "./hooks/useDshRuntimeMigrationNotice";
import { useDshRuntimeInstallProgressSync } from "./hooks/useDshRuntimeInstallProgressSync";
import { useWorktreeActions } from "./hooks/useWorktreeActions";
import { ChatSessionPane } from "./components/session/ChatSessionPane";
import { SessionSplitStage } from "./components/session/SessionSplitStage";
import { splitLayoutSessionIds } from "./utils/sessionSplitEdge";
import { SessionTabsBar, type SessionTabsBarProps, type SessionToolAction } from "./components/session/SessionTabsBar";
import { SessionPaneServicesProvider, type SessionFileOpenContext } from "./components/session/SessionPaneServices";
import { ProjectEmptyState } from "./components/session/ProjectEmptyState";
import { FileLinkBaseProvider } from "./components/session/FileLinkBase";
import { useSessionWorkspaceChrome } from "./hooks/useSessionWorkspaceChrome";
import { useQuickTask } from "./hooks/useQuickTask";
import { QuickTaskSurface } from "./components/app/QuickTaskSurface";
import { AskPanelOverlay } from "./components/overlays/AskPanelOverlay";
import { HostPluginPanelHost } from "./components/plugins/HostPluginPanelHost";
import { HostPluginPageOverlay } from "./components/plugins/HostPluginPageOverlay";
import { useHostPluginPageTab } from "./hooks/useHostPluginPageTab";
import { useHostPluginNavigation } from "./hooks/plugins/useHostPluginNavigation";
import { TerminalDockPanel } from "./components/terminal/TerminalDockPanel";
import { ResizablePanel, ResizablePanelGroup } from "./components/ui-shadcn/resizable";
import { AppShell } from "./components/app/AppShell";
import { WorkspaceDrawerRail } from "./components/workspace/WorkspaceDrawerRail";
import { DrawerSurface } from "./components/workspace/DrawerSurface";
import { WorkbenchStage } from "./components/workspace/WorkbenchStage";
import { WorkbenchContent } from "./components/workspace/WorkbenchContent";
import { RenameModals } from "./components/RenameModals";
import { SessionActionOverlays } from "./components/overlays/SessionActionOverlays";
import { SessionProxyDialog } from "./components/session/SessionProxyDialog";
import { CuaApprovalDialog, useCuaApproval } from "./components/overlays/CuaApprovalDialog";

import { ImportOverlayHost } from "./components/overlays/ImportOverlayHost";
import { EnvironmentOverlay } from "./components/overlays/EnvironmentOverlay";
import { usePiEnvironmentGuide } from "./hooks/usePiEnvironmentGuide";
import { EnvironmentDialog, FileContextMenu, ImagePreviewModal, type SessionModifiedFile } from "./components/app/AppParts";
import { ExternalEditorOverlay } from "./components/workspace/ExternalEditorOverlay";
import { navigateTo } from "./components/app/BrowserPanel";
import { flattenFiles, fileNodeDragPayloadToRef, mergeCommands, getToolFilePath, getToolNewContent, getToolChangedLineCount } from "./components/app/AppUtils";
// ProjectResourcesModal 仅在打开资源弹层时加载
const ProjectResourcesModal = lazy(() => import("./components/app/ProjectResourcesModal").then((m) => ({ default: m.ProjectResourcesModal })));
import { createDefaultAppSettings } from "../../shared/types";
import { hydrateImageContents } from "../../shared/imageContentSrc";
import type {
	AgentRuntimeState,
	AgentTab,
	SessionRuntimeTarget,
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
	TerminalThemeId,
	GitBranchInfo,
	FocusTargetPayload,
} from "../../shared/types";
import type { TerminalDockSettings } from "./components/terminal/TerminalDock";

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
						<path fill="url(#root-loading-logo-silver)" fillRule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z" />
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
	// 开屏交接：已聚焦会话（工作区知道自己该显示什么）才撤启动遮罩，
	// 否则会先闪一帧「无会话空态 = 引导页」再变正常。
	useBootOverlayReady(currentSessionId !== undefined);
	const currentSession = useAtomValue(currentSessionAtom);
	// currentSessionRuntime / currentSessionRuntimeUi / currentSessionSendState: sync store.get() only.
	// Streaming subscriptions are in SessionRuntimeInjector.
	// Timeline 由各 ChatSessionPane 自持；大纲只读当前聚焦会话的消息缓存。
	const activeMessages = useAtomValue(currentSessionMessagesAtom);
	const projects = useAtomValue(projectInventoryAtom);
	const agents = useAtomValue(agentInventoryAtom);
	const setCurrentSessionId = useSetAtom(currentSessionIdAtom);
	const replaceProjectSessions = useSetAtom(replaceProjectSessionsAtom);
	const openAutomationModal = useSetAtom(openAutomationModalAtom);
	// `/login`：打开供应商登录弹框（弹框自己从 atom 取预选供应商）。
	const openProviderLogin = useSetAtom(openProviderLoginAtom);
	const setProjects = useSetAtom(replaceProjectInventoryAtom);
	const applyRuntimeEvent = useSetAtom(applySessionRuntimeEventAtom);
	const upsertSession = useSetAtom(upsertSessionAtom);
	const setCacheMessages = useSetAtom(cacheSessionMessagesAtom);
	const setSessionDraft = useSetAtom(setSessionDraftAtom);
	const setSessionAttachments = useSetAtom(setSessionAttachmentsAtom);
	const promoteSessionComposerState = useSetAtom(promoteSessionComposerStateAtom);
	const promoteSessionMessagesCache = useSetAtom(promoteSessionMessagesCacheAtom);
	const setSessionCatalogLoadState = useSetAtom(setSessionCatalogLoadStateAtom);
	const setSessionMessageLoadState = useSetAtom(setSessionMessageLoadStateAtom);
	// 会话消息区域遮罩（SessionSurfaceStage）：重启/停止/重载等运行时操作据此显示「正在…」加载动画
	const setMutationOverlay = useSetAtom(setSessionHistoryMutationOverlayAtom);
	const removeSessionState = useSetAtom(removeSessionStateAtom);
	const removeSessionComposerState = useSetAtom(removeSessionComposerStateAtom);
	const setImageGenConfig = useSetAtom(imageGenConfigAtom);
	const setEnhanceModel = useSetAtom(enhanceModelAtom);
	const currentSessionIdRef = useRef<string | undefined>(currentSessionId);
	currentSessionIdRef.current = currentSessionId;
	const openSessionRequestRef = useRef(0);
	const creatingSessionDraftRef = useRef<Set<string>>(new Set());
	// 引导页虚拟会话提升并发闸：首次发送触发创建真实会话时登记 promise，同一帧内
	// 的并发发送（如快速双击）复用同一次提升，避免建出两个会话。
	const guideBootstrapPromotionRef = useRef<Promise<string> | undefined>(undefined);

	// 项目的 git worktree 列表：{ parentId -> WorktreeEntry[] }
	const [pendingAgents, setPendingAgents] = useState<PendingAgentTab[]>([]);
	const [activeProjectId, setActiveProjectId] = useState<string>();
	const activeProjectIdRef = useRef<string | undefined>(activeProjectId);
	activeProjectIdRef.current = activeProjectId;
	const activeAgentId = useAtomValue(activeAgentIdAtom);
	// 切换 agent（新会话/恢复会话）时刷新设置，使 pi agent 的 hideThinkingBlock 立即生效
	useEffect(() => {
		if (activeAgentId) {
			void api.settings
				.get()
				.then(setSettings)
				.catch(() => undefined);
		}
	}, [activeAgentId]);
	const activeAgentIdRef = useRef<string | undefined>(activeAgentId);
	activeAgentIdRef.current = activeAgentId;
	const agentsRef = useRef<AgentTab[]>(agents);
	agentsRef.current = agents;
	const expandedProjects = useAtomValue(sidebarExpandedProjectIdsAtom);
	const compactMiddlePackagesEnabled = useAtomValue(compactMiddlePackagesAtom);

	const jumpToMessageRef = useRef<((messageId: string) => void) | null>(null);
	// TECH DEBT (Phase 3): promptByAgent / attachedImagesByAgent legacy mirrors removed.
	// All drafts/attachments go through Session atoms (setSessionDraft / setSessionAttachments).

	/** 当前正在重启的 Agent，用于仅给对应会话显示 loading，避免切到其他 Agent 后仍被全局禁用。 */
	/** 当前正在激活（首次启动）的会话：未绑定 Agent 时「重启会话」走 activateRuntime，用会话 id 标记 loading。 */
	/** 当前正在停止的 Agent：Tab 栏「停止」/侧栏关闭 Agent 时给对应会话 tab 徽章显示 loading。 */
	/** 当前正在从磁盘重载消息的会话：Tab 栏「重载」时给对应会话 tab 徽章显示 loading。 */
	const [previewImage, setPreviewImage] = useState<ImageContent | null>(null);
	/**
	 * 会话代理设置弹框目标会话。侧栏会话菜单与 Tab 栏 ⋯ 菜单共用同一个宿主，
	 * 保证两处入口打开的是同一套 UI（弹窗自身读 atom 并负责保存后自动重启）。
	 */
	const [proxyDialogSessionId, setProxyDialogSessionId] = useState<string | null>(null);

	// composerAgentModes legacy mirror removed — mode restore uses Session atom in useQueuedPrompt.
	/** 客户端队列按 agent 记录 flush 锁，避免 tool-end 与 idle 并发投递。 */
	const queueFlushBySessionRef = useRef<Set<string>>(new Set());

	/** & 会话引用选择缓存：key = chip raw（如 "&My Session"），value = 选中的消息列表 */
	const [sessionRefSelections, setSessionRefSelections] = useState<Record<string, { messages: Array<{ role: string; content: string }>; fullContext: boolean; selectedIndices: number[] }>>({});

	// 会话区不再维护独立的“修改文件摘要”卡片；diff 入口贴在 edit/write 工具调用处，
	// 避免会话输入框上方摘要与 Git 工作区状态/历史会话恢复互相干扰。

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
	const [sessionSourceFilter] = useState<Record<string, Set<SessionFilterPill> | null>>(() => loadSessionSourceFilter());
	/** 编辑器展示模式：弹框或侧栏 */
	// showToast 必须是稳定回调：文件树 / overlay 等 effect 若把它当依赖，
	// 每次 render 新建函数会把 setFiles([]) 打成无限更新（设置/关窗点不动）。
	const showToast = useCallback((message: string, duration?: number, kind?: NoticeKind) => {
		showNotice(message, duration, kind);
	}, []);
	// userData 更名（pi-desktop → PiDeck）一次性提示：主进程在 setPath 前已完成迁移，
	// 这里首挂载消费式领取结果 toast——领过一次即清空，之后启动永不再弹。
	useEffect(() => {
		void api.projects
			.consumeMigrationNotice()
			.then((notice) => {
				if (notice) showToast(t("app.userDataMigrationNotice", { newPath: notice.newPath }), 8000);
			})
			.catch(() => undefined);
	}, [showToast]);
	// ACP 工具表（settings.acpTools 快照）：挂载时拉一次供新建会话菜单/设置页共享；
	// 后续变更由设置页保存后整表回写 acpToolsAtom，不做事件订阅（改动频率极低）。
	// 同一次拉取顺带同步 acpEnabled 快照：菜单组仅在开关开启时渲染（主进程同规则门控注册）。
	useEffect(() => {
		let cancelled = false;
		void api.acp
			.listTools()
			.then((tools) => {
				if (!cancelled) store.set(acpToolsAtom, tools);
			})
			.catch(() => undefined);
		void api.settings
			.get()
			.then((settings) => {
				if (!cancelled) store.set(acpEnabledAtom, settings.acpEnabled === true);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [store]);
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
	const loadSidebarWidth = useCallback(async () => (await getLayoutSettings()).sidebarWidth, [getLayoutSettings]);
	const loadDrawerWidth = useCallback(async () => (await getLayoutSettings()).drawerWidth, [getLayoutSettings]);
	const persistSidebarWidth = useCallback((width: number) => api.settings.update({ sidebarWidth: width }), []);
	const persistDrawerWidth = useCallback((width: number) => api.settings.update({ drawerWidth: width }), []);

	// Drawer state delegated to useWorkspacePanels.
	// 外部编辑器适配器：将 desktopApi 包装为 WorkspaceExternalEditorAdapter，
	// 供 useWorkspacePanels 的 loadExternalEditors / openProjectInExternalEditor 使用。
	const editorsAdapter = useMemo<WorkspaceExternalEditorAdapter>(
		() => ({
			list: () => api.editors.list(),
			openProject: (editor, projectPath) => api.editors.openProject(editor, projectPath),
		}),
		[],
	);
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
	const setDrawer = useCallback(
		(panel: WorkspaceDrawerPanel | null) => {
			// Open guard for git is handled by the enableGitManagement effect below.
			if (panel) workspace.openDrawer(panel);
			else workspace.closeDrawer();
		},
		[workspace.openDrawer, workspace.closeDrawer],
	);
	const setDrawerCollapsed = useCallback(
		(collapsed: boolean) => {
			if (collapsed) workspace.collapseDrawer();
			else workspace.expandDrawer();
		},
		[workspace.collapseDrawer, workspace.expandDrawer],
	);
	/** 打开文件编辑器前所在的抽屉面板，供返回按钮恢复 */
	const [sessionsProjectId, setSessionsProjectId] = useState<string>();
	const [projectResourcesProject, setProjectResourcesProject] = useState<Project | null>(null);
	const sessions = useAtomValue(sessionSummariesByProjectIdAtomFamily(sessionsProjectId ?? ""));

	// ===== 项目同步 hook (H3) =====
	const {
		worktreesByProject,
		branchByProject,
		setBranchByProject,
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
				list: (projectId: string, options?: { maxDepth?: number; directory?: string }) => api.files.list(projectId, options),
			},
		},
		showToast,
		setSessionCatalogLoadState,
		t,
	});
	// 回答结束后的会话列表后台静默刷新：500ms 尾沿去抖。
	// 多个 Agent 同时结束回答时只扫描一次，避免重复 IPC 与列表抖动。
	const answerEndRefreshTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
	const scheduleAnswerEndRefresh = useCallback(
		(projectId: string) => {
			const existing = answerEndRefreshTimerRef.current[projectId];
			if (existing) clearTimeout(existing);
			answerEndRefreshTimerRef.current[projectId] = setTimeout(() => {
				delete answerEndRefreshTimerRef.current[projectId];
				void refreshProjectSessions(projectId, true).catch(() => undefined);
			}, 500);
		},
		[refreshProjectSessions],
	);

	// === import flow hook ===
	const {
		codexImportProject,
		setCodexImportProject,
		claudeImportProject,
		setClaudeImportProject,
		qoderImportProject,
		setQoderImportProject,
		openCodeImportProject,
		setOpenCodeImportProject,
		zcodeImportProject,
		setZcodeImportProject,
		workbuddyImportProject,
		setWorkbuddyImportProject,
		cursorImportProject,
		setCursorImportProject,
		kimiImportProject,
		setKimiImportProject,
		kimiWorkImportProject,
		setKimiWorkImportProject,
		minimaxImportProject,
		setMinimaxImportProject,
		codexImportController,
		claudeImportController,
		qoderImportController,
		openCodeImportController,
		zcodeImportController,
		workbuddyImportController,
		cursorImportController,
		kimiImportController,
		kimiWorkImportController,
		minimaxImportController,
		openCodexImport,
		openClaudeImport,
		openQoderImport,
		openOpenCodeImport,
		openZCodeImport,
		openWorkBuddyImport,
		openCursorImport,
		openKimiImport,
		openKimiWorkImport,
		openMinimaxImport,
	} = useImportFlow({
		setProjectMenu: () => undefined,
		refreshProjectSessions,
		showToast,
		scanCodexSessions: api.codexSessions.scan,
		importCodexSessionsApi: api.codexSessions.import,
		scanClaudeSessions: api.claudeSessions.scan,
		importClaudeSessionsApi: api.claudeSessions.import,
		scanQoderSessions: api.qoderSessions.scan,
		importQoderSessionsApi: api.qoderSessions.import,
		scanOpenCodeSessions: api.openCodeSessions.scan,
		importOpenCodeSessionsApi: api.openCodeSessions.import,
		scanZCodeSessions: api.zcodeSessions.scan,
		importZCodeSessionsApi: api.zcodeSessions.import,
		scanWorkBuddySessions: api.workbuddySessions.scan,
		importWorkBuddySessionsApi: api.workbuddySessions.import,
		scanCursorSessions: api.cursorSessions.scan,
		importCursorSessionsApi: api.cursorSessions.import,
		scanKimiSessions: api.kimiSessions.scan,
		importKimiSessionsApi: api.kimiSessions.import,
		describeKimiWorkShareRoot: api.kimiWorkSessions.describe,
		scanKimiWorkSessions: api.kimiWorkSessions.scan,
		importKimiWorkSessionsApi: api.kimiWorkSessions.import,
		scanMinimaxSessions: api.minimaxSessions.scan,
		importMinimaxSessionsApi: api.minimaxSessions.import,
		getSettings: api.settings.get,
		updateSettings: api.settings.update,
		t,
	});

	// === 外置目录会话导入（目录移动/改名后找回历史）===
	const {
		project: directoryImportProject,
		setProject: setDirectoryImportProject,
		controller: directoryImportController,
		open: openDirectoryImport,
	} = useDirectoryImport({
		setProjectMenu: () => undefined,
		refreshProjectSessions,
		showToast,
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

	const getProjectSessionRecords = (projectId: string) => store.get(sessionRecordsByProjectIdAtomFamily(projectId));
	const getSessionRecord = (sessionId: string) => store.get(sessionRecordByIdAtomFamily(sessionId));
	const [sessionHistoryLoading, setSessionHistoryLoading] = useState(false);

	// 后台更新状态订阅（electron-updater 快照驱动）：自动下载开启时静默下载，
	// 完成后再 toast「重启并安装」；关闭时发现新版本 toast 提示去设置页。
	// 不再弹大窗打断用户（对齐 Netcatty 语义）。
	useBackgroundUpdateWatch({
		api,
		// 打开设置页并定位「开发设置」tab（toast「查看设置」动作目标）。
		openSettings: () => store.set(openSettingsAtom, { tab: "dev" }),
	});

	// 通道切换状态订阅：初拉当前通道 + 切换快照，AppUpdateCard 徽章/切换向导消费。
	useChannelSwitchWatch({ api });

	// 数据环境事件订阅：dev 首启模式选择 / 目录标记警告 / 导入进度（弹窗由 dataEnvAtoms 驱动）。
	useDataEnvWatch({ api });

	// localStorage 只负责首屏；展开项目的权威设置必须等首次 settings.get 返回后才参与迁移。
	const [settingsLoaded, setSettingsLoaded] = useState(false);
	const [expandedProjectsReady, setExpandedProjectsReady] = useState(false);
	const [settings, setSettings] = useState<AppSettings>(createDefaultAppSettings);

	// 流式对话行为设置同步给 turn 组件（TurnRow 直接订阅 atom，避免 5 层 props 透传；
	// 设置变化低频，全局订阅成本可忽略）。
	const setTurnFlowSettings = useSetAtom(turnFlowSettingsAtom);
	useEffect(() => {
		setTurnFlowSettings({
			expandInterimDuringStream: settings.expandInterimDuringStream,
			processGroupDisplay: settings.processGroupDisplay,
		});
	}, [settings.expandInterimDuringStream, settings.processGroupDisplay, setTurnFlowSettings]);

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

	// 隐藏的功能模块同步给不持有 settings props 的消费方（ConfigModal Pi/DSH 分页、composer 后端下拉），
	// 与 defaultAgentBackend 同一模式。
	const setHiddenModules = useSetAtom(hiddenModulesAtom);
	useEffect(() => {
		setHiddenModules(settings.hiddenModules ?? []);
	}, [settings.hiddenModules, setHiddenModules]);

	// 启动预热：应用起来后把「已开启用量查询」的供应商各查一次（串行错峰），
	// 打开模型/认证页即可直接看到徽章数值，不必先手动刷新。
	useProviderUsageStartupWarmup();

	// Guard: hide git drawer when git management is disabled.
	// Equivalent to: if (panel === "git" && !settings.enableGitManagement) return
	// Pinned cleanup (filter(([, panel]) => panel !== "git")) is handled inside useWorkspacePanels.
	useEffect(() => {
		if (settings.enableGitManagement) return;
		// setDrawer((current) => current === "git" ? null : current)
		if (drawer === "git") workspace.closeDrawer();
	}, [settings.enableGitManagement, drawer, workspace.closeDrawer]);

	/* settingsNotice 已改用 showToast（sonner）实现 */
	// 应用自描述信息域（版本/平台/目录 + 系统语言）收口到 useAppBootstrapInfo
	const { appInfo, systemLanguage } = useAppBootstrapInfo(api);
	// 外观/i18n 域（明暗解析、壁纸/皮肤/字体注入、locale 同步）统一收口到 useAppAppearance
	useAppAppearance({ settings, systemLanguage, settingsLoaded });

	// ===== Pi 更新/安装/代理 hook (H1) =====
	const piUpdate = usePiUpdate({
		settings,
		setSettings,
		showToast,
		api,
	});
	const { piStatus, piChecking, environmentDialog, setPiStatus, setEnvironmentDialog } = piUpdate;
	// pi 环境引导（Node→npm→pi 三步）：弹窗打开时自动检测第一步，关闭时重置一次性状态。
	// 依赖只取稳定的 checkNode（useCallback）；piGuide 对象每次渲染都是新引用，
	// 直接依赖会因 checkNode 内部 setState → 重渲染 → effect 重跑而形成检测循环。
	const piGuide = usePiEnvironmentGuide(api);
	const { checkNode: checkGuideNode } = piGuide;
	useEffect(() => {
		if (environmentDialog) void checkGuideNode();
	}, [environmentDialog, checkGuideNode]);
	// 抽屉宽度状态由 useWorkspacePanels 统一管理（全局 localStorage 持久化，键 pid:drawer-width），
	// AppShell 拖拽提交经 setDrawerWidth 回写；此处不再持有独立 useState，避免双份状态漂移。
	const drawerWidth = workspace.drawerWidth;
	const setDrawerWidth = workspace.setDrawerWidth;
	const [composerOffsetHeight, setComposerOffsetHeight] = useState(0);
	// 终端归属：有 activeAgent → agent owner；引导页/未激活 agent/历史会话 → project owner。
	// 终端 open/collapsed/PTY 实例按 owner 隔离，切换项目或 agent 绝不串台；
	// 分屏高度是全局单份并持久化（与抽屉宽度同策略），跨重启恢复上次大小。
	// 会话所属项目（响应式）：未激活 Agent 的会话回退项目终端时需要它的 projectId
	const currentSessionRecord = useAtomValue(sessionRecordByIdAtomFamily(currentSessionId ?? ""));
	// 当前会话 runtime（响应式）：Tab 栏 ⋯ 菜单「复制会话」按 live 分流（clone vs copyRecord）。
	const currentSessionRuntime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(currentSessionId ?? ""));
	const currentSessionIsLive = isLiveRuntimeStatus(currentSessionRuntime?.status);
	// 终端归属：有 activeAgent → agent owner；未激活 agent/历史会话 → project owner。
	// activeProjectId 未同步（如 Tab 直切跨项目会话）时用当前会话所属项目兜底，
	// 保证未激活 agent 的会话也常显「打开终端」按钮。
	const terminalOwner = resolveTerminalOwner(activeAgentId, activeProjectId ?? currentSessionRecord?.projectId);
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
	// 终端外观设置：App 级单份，随 AppSettings 持久化；dock 只收子集 props，不自读 settings
	const terminalSettings = useMemo<TerminalDockSettings>(
		() => ({
			themeId: settings.terminalTheme,
			fontFamily: settings.terminalFontFamily,
			fontSize: settings.terminalFontSize,
			scrollback: settings.terminalScrollback,
			cursorStyle: settings.terminalCursorStyle,
			cursorBlink: settings.terminalCursorBlink,
			copyOnSelect: settings.terminalCopyOnSelect,
			paddingY: settings.terminalPaddingY,
			confirmClose: settings.terminalConfirmClose,
			startupCommand: settings.terminalStartupCommand,
		}),
		[settings.terminalTheme, settings.terminalFontFamily, settings.terminalFontSize, settings.terminalScrollback, settings.terminalCursorStyle, settings.terminalCursorBlink, settings.terminalCopyOnSelect, settings.terminalPaddingY, settings.terminalConfirmClose, settings.terminalStartupCommand],
	);
	const setTerminalTheme = useCallback(
		(themeId: TerminalThemeId) => {
			void api.settings
				.update({ terminalTheme: themeId })
				.then(setSettings)
				.catch(() => showToast(t("settings.terminal.themeChangeFailed"), 3000));
		},
		[api, showToast],
	);
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

	// 项目文件树域（展开持久化/自愈/下钻/切换加载）收口到 useProjectFileTreeController
	const { expandedDirs, refreshVisibleFiles, restoreExpandedDirs, drillCompactChain, toggleDirectory, collapseAllDirectories } = useProjectFileTreeController({
		files,
		setFiles,
		refreshFiles,
		beginFileTreeRequest,
		isFileTreeRequestCurrent,
		activeProjectId,
		activeProjectIdRef,
		compactMiddlePackagesEnabled,
		agentsRef,
		refreshProjects,
		showToast,
	});

	const scratchPad = useScratchPad(workspace);
	// CUA 操作审批：根级订阅主进程推送的审批请求并渲染确认弹框（事件驱动，全局唯一一份）。
	const cuaApproval = useCuaApproval();
	// DSH runtime 安装态同步：全进程只挂这一份（IPC 拉取 + 变更订阅 → dshRuntimeStatusAtom）。
	// 必须早于任何按安装态门控的 UI 计算，否则首帧会用 checking 初值渲染。
	useDshRuntimeStatusSync();
	// DSH runtime 安装进度同步：App 级订阅（常驻，不随 DshRuntimeSection 卸载），
	// 保证切配置分页/关弹窗后进度仍保留；完成/失败时弹全局 toast。
	useDshRuntimeInstallProgressSync();
	// 存量 dsh 用户升级后 runtime 不在时给一次直达提示（有 dsh 会话才提示，只提示一次）。
	useDshRuntimeMigrationNotice();

	const activeProjectRuntimeCapabilities = useProjectRuntimeCapabilities(activeProjectId);
	const activeProject = projects.find((project) => project.id === activeProjectId);
	const overlays = useOverlayActions({ activeProject, appInfo, showToast });
	const sessionsProject = projects.find((project) => project.id === sessionsProjectId);
	const displayAgents = useMemo(() => {
		const realIds = new Set(agents.map((agent) => agent.id));
		return [...agents, ...pendingAgents.filter((agent) => !realIds.has(agent.id) && !agents.some((realAgent) => isReplacementForPendingAgent(realAgent, agent)))];
	}, [agents, pendingAgents]);

	// === worktree actions hook ===
	const { worktreeCreating, removingWorktreePaths, createWorktree, removeWorktree, requestRemoveWorktree, toggleProjectWorktree } = useWorktreeActions({
		projects,
		displayAgents,
		setProjects,
		refreshWorktrees,
		overlays,
	});

	// 会话时长跟踪（running→idle 边沿写 sessionDurationByAgent）收口到 useSessionDurationTracking
	const { sessionDurationByAgent } = useSessionDurationTracking({ displayAgents, activeAgentId });

	// displayAgents 的 ref，供只挂载一次的 IPC 监听器读取最新 Agent 列表，避免闭包陈旧
	const displayAgentsRef = useRef(displayAgents);
	displayAgentsRef.current = displayAgents;
	// prompt history persistence lives in session composer controller (session-first).
	// 查看器已移除：activeAgent 直接从 displayAgents / pendingAgents 取，不再有伪 Agent。
	const activeAgent = activeAgentId ? [...displayAgents, ...pendingAgents].find((agent) => agent.id === activeAgentId) : undefined;
	// rewind（检查点）是 pi 后端能力：抽屉 rail 与底栏按钮同口径门控
	// （dsh/imagegen 会话不展示入口）。与 Injector 的 isDshBackend 同源判定。
	const rewindBackend = activeAgent?.backend ?? currentSessionRecord?.backend;
	const rewindSupported = rewindBackend === undefined || rewindBackend === "pi";

	// === RPC 日志 Tab 门控（抽屉活动栏）===
	// rpcLoggingAgentIdsAtom 是「开启了 RPC 日志记录的 agent」渲染层镜像，唯一写入方是
	// rpc.setLogging 包装（主进程回执落地才写，见下方 sidebarActions）。Tab 门控叠加
	// 「agent 仍存活」判定：agentId 键在进程关闭后不清理（无复用价值），陈旧键只允许让
	// Tab 多显示（保守方向），叠加存活判定后即使有陈旧键也不会渲染出指向死 agent 的 Tab。
	const rpcLoggingAgentIds = useAtomValue(rpcLoggingAgentIdsAtom);
	const setRpcLoggingAgentIds = useSetAtom(rpcLoggingAgentIdsAtom);
	const patchRpcLoggingAgentIds = useCallback((agentId: string, enabled: boolean) => {
		setRpcLoggingAgentIds((current) => toggleRpcLoggingAgent(current, agentId, enabled));
	}, []);
	const rpcLogTabTargetAgentId = useMemo(() => {
		if (rpcLoggingAgentIds.size === 0) return undefined;
		const liveIds = new Set([...displayAgents, ...pendingAgents].filter((agent) => agent.status !== "closed" && agent.status !== "error").map((agent) => agent.id));
		// 优先沿用面板当前绑定的 agent（同一次观看会话内 Tab 点击不切换观察对象）
		if (workspace.rpcLogAgentId && rpcLoggingAgentIds.has(workspace.rpcLogAgentId) && liveIds.has(workspace.rpcLogAgentId)) return workspace.rpcLogAgentId;
		for (const id of rpcLoggingAgentIds) if (liveIds.has(id)) return id;
		return undefined;
	}, [rpcLoggingAgentIds, displayAgents, pendingAgents, workspace.rpcLogAgentId]);

	// Timeline scroll, pagination and jump ownership lives in sessionTimeline.
	// Modern Session drafts and attachments are subscribed by ComposerArea; the root only
	// keeps the legacy queue adapter for agents that do not yet have a Session record.
	// 提示词发送路径（草稿写入/忙碌投递语义/IPC sendPrompt 唯一出口/错误码本地化）收口到 useSessionPromptDispatch。
	const { livePromptByAgentRef, setPromptForAgent, setPrompt, isAgentCurrentlyBusy, dispatchPromptSnapshot, submitPromptSnapshot, translateAgentErrorMessage } = useSessionPromptDispatch({ store, setSessionDraft, currentSessionId, currentSessionIdRef, activeAgentIdRef, showToast });

	// Queue ownership extracted to useQueuedPrompt.
	const queue = useQueuedPrompt({
		displayAgentsRef,
		queueFlushBySessionRef,
		composerTextareaRef,
		pendingComposerCaretRef,
		store,
		setComposerCursor: (v: React.SetStateAction<number>) => {
			/* no-op: cursor managed by composer controller */
		},
		showToast,
		unknownDeliveryMessage: t("app.queuedUnknown"),
		dispatchPromptSnapshot,
	});
	useSessionRuntimeBridge({
		onRuntimeCapabilityChanged: ({ sessionId, previous, current, patch }) => {
			if (previous?.isExecutingTool && !current.isExecutingTool && (patch.toolStateSequence == null || previous.toolStateSequence == null || patch.toolStateSequence >= previous.toolStateSequence) && queue.isSessionRuntimeBusy(sessionId)) {
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

	// 架构错包检测：x64 包跑在 Apple Silicon（Rosetta）下时提示换装 arm64 原生包（可永久关闭）
	useArchMismatchNotice();

	// logo 风格 → 渲染层镜像 atom + localStorage 缓存：LogoMark/侧栏/关于弹层订阅 atom 即时切换；
	// localStorage 让下次启动的启动画面（React 挂载前）就能用同一风格，避免开屏闪回默认 pi-tui。
	const setLogoStyle = useSetAtom(logoStyleAtom);
	useEffect(() => {
		const logoStyle = resolveLogoStyle(settings.logoStyle);
		setLogoStyle(logoStyle);
		try {
			window.localStorage.setItem(LOGO_STYLE_STORAGE_KEY, logoStyle);
		} catch {
			// localStorage 不可用（隐私模式等）只影响启动画面回退 classic，不致命
		}
	}, [settings.logoStyle, setLogoStyle]);

	// 公告通知开关 → 渲染层镜像 atom：通知调度与侧栏入口显隐共用同一数据源，
	// 设置保存后即时生效（settings.get 首拉与 onSettingsApplied 都经此处同步）
	const setAnnouncementNotifyEnabled = useSetAtom(announcementNotificationEnabledAtom);
	useEffect(() => {
		setAnnouncementNotifyEnabled(settings.announcementNotificationEnabled);
		// 关闭通知时若公告弹窗恰好开着（弹窗与设置弹窗互斥，理论少见），一并收起，
		// 避免重新开启后残留的 open=true 让弹窗自动弹开
		if (!settings.announcementNotificationEnabled) {
			store.set(announcementCenterOpenAtom, false);
		}
	}, [settings.announcementNotificationEnabled, setAnnouncementNotifyEnabled, store]);

	// 公告通知调度（读镜像 atom）：输入/Agent 运行中/模态打开/窗口不活跃时自动延后弹出（不打扰操作，见 hook 注释）
	useAnnouncementNotifier();
	// toast 展示时长同步给 notice helper（全局统一口径；保存设置即时生效）
	useEffect(() => {
		configureNoticeDefaults({ toastDurationMs: settings.toastDurationMs });
	}, [settings.toastDurationMs]);
	// 模型保存后台验证结果（fork 真实 pi ~17s）失败时全局 toast；成功静默，见 hook 注释
	useModelsVerifyNotifier();
	const activeQueuedPrompts = currentSessionId ? (queue.queuedPrompts[currentSessionId] ?? []) : [];

	const enqueueSessionPrompt = useCallback(
		(sessionId: string, snapshot: { displayText: string; message: string; images?: ImageContent[]; agentMode: string; behavior?: "steer" | "followUp" }) => {
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
		},
		[store, queue.enqueueQueuedPrompt],
	);

	/** 空会话快捷操作只负责填入当前 composer；用户仍可修改 prompt 后再点击发送。 */
	const insertQuickPrompt = useCallback(
		(sessionId: string, message: string) => {
			setSessionDraft({ sessionId, value: message });
			requestAnimationFrame(() => {
				document.querySelector<HTMLElement>(".composer-box .rich-input")?.focus();
			});
		},
		[setSessionDraft],
	);

	// activeConversationStatus / activeRuntimeState replaced by sync isAgentCurrentlyBusy().
	// The built-in Chat uses a renderer-only Session ID before its first send.
	// Workspace chrome belongs to that visible conversation surface, not only to
	// persisted catalog records; otherwise Chat loses the dev-equivalent toolbar.

	const activeProjectHasBusyAgent = Boolean(activeProjectId && displayAgents.some((agent) => agent.projectId === activeProjectId && (agent.status === "starting" || agent.status === "running" || activeProjectRuntimeCapabilities[agent.id]?.isStreaming || activeProjectRuntimeCapabilities[agent.id]?.isExecutingTool)));
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
	const anyTerminalDockOpen = useMemo(() => Object.values(terminalStatesByOwner).some((state) => state.open), [terminalStatesByOwner]);
	const sessionLayout = useSessionLayout({
		terminalRequestedHeight: terminalHeight,
		terminalOpen: anyTerminalDockOpen,
		// 关闭信号不再让布局行高归零：分屏下其它栏的 dock 仍需要高度；关闭动画期间
		// 该栏面板已随 open=false 立即卸载，行高保留到 180ms 动画结束不影响布局。
		terminalClosing: false,
		terminalCollapsed,
		queuedPromptCount: activeQueuedPrompts.length,
	});
	const { chatPaneRef: sessionChatPaneRef, headerRef: sessionHeaderRef, composerRef: sessionComposerRef, terminalRowHeight, availableTerminalHeight } = sessionLayout;

	// Alias hook refs to the names App.tsx expects.
	const chatPaneRef = sessionChatPaneRef;
	const chatHeaderRef = sessionHeaderRef;
	const composerRef = sessionComposerRef;

	// Gate 4.5 — streaming signal / abort helpers
	const { listWidth, setListWidth, listCollapsed, setListCollapsed, toggleListCollapsed } = useResize({
		loadPersistedWidth: loadSidebarWidth,
		persistWidth: persistSidebarWidth,
	});

	/** 当前会话中 agent 修改过的文件(从 tool 消息 meta 中提取) */
	// 优化:只在消息数量变化时才重新计算,减少不必要的遍历
	const modifiedFiles = useMemo(() => {
		const byPath = new Map<string, SessionModifiedFile>();
		for (const msg of activeMessages) {
			if (msg.role !== "tool") continue;
			const toolName: string | undefined = msg.meta?.toolName as string | undefined;
			// 工具入参只可能是字符串或参数对象（投影器写入 meta 的两路形态），先收窄再交给工具解析器
			const argsRaw: unknown = msg.meta?.args;
			const args = typeof argsRaw === "string" || (argsRaw && typeof argsRaw === "object") ? (argsRaw as string | Record<string, unknown>) : undefined;
			const status: string = String(msg.meta?.status ?? "done");
			// 只收集文件写入/编辑类的工具调用，作为右侧 Files 与会话结束摘要的统一数据源。
			if (!toolName || !/write|edit|create|patch/i.test(toolName)) continue;
			const filePath = getToolFilePath(args);
			if (!filePath || !args) continue;
			const previous = byPath.get(filePath);
			// 同一路径再次被修改时移动到 Map 末尾，右侧修改清单才能按"最新修改"展示。
			if (previous) byPath.delete(filePath);
			// originalContent 不再存储到消息 meta 中（full file 会使会话体积过大）。
			// diff 展示时使用工具参数（oldText/newText）显示变动区域。
			byPath.set(filePath, {
				path: filePath,
				toolName,
				status: status === "running" ? "running" : (previous?.status ?? status),
				changedLines: (previous?.changedLines ?? 0) + getToolChangedLineCount(toolName, args),
				originalContent: "",
				content: getToolNewContent(toolName, args) ?? previous?.content,
			});
		}
		return Array.from(byPath.values());
	}, [activeMessages, activeAgentId]);
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
		preserveTabsForGit: settings.navigationMode === "simple",
		contentOpenMode: settings.navigationMode === "simple" ? "split" : (settings.workspaceContentOpenMode ?? "split"),
		showToast,
		readFileContent: api.files.readContent,
		readGitOriginalContent: api.git.originalContent,
		writeFileContent: api.files.writeContent,
		openFile: api.files.open,
		workspaceFileDiff: api.git.workspaceFileDiff,
		commitFileDiff: api.git.commitFileDiff,
		t,
	});

	// 会话内文件链接路由：两个口子分开——
	// 会话文件链接域（分级打开/安全门/抽屉切换）收口到 useSessionFileLinks
	const { openSessionFilePath, requestExternalPathOpen, externalPathOpenDialog, handleOpenLinkedFile, handleToolDrawerAction } = useSessionFileLinks({
		activeAgent,
		activeProject,
		currentSessionId,
		activeProjectId,
		showToast,
		setPreviewImage,
		viewFilePath,
		workspace,
		gitDrawerDiff,
		closeGitDiff,
		refreshVisibleFiles,
		restoreExpandedDirs,
	});

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

	// 会话运行控制域（target 解析/克隆/关闭/中止/重启/重载/能力快照 + 四个 busy 态）收口到 useSessionRunControl
	const {
		restartingAgentId,
		activatingSessionId,
		stoppingAgentId,
		reloadingSessionId,
		getRuntimeTargetForSession,
		getRuntimeTargetForAgent,
		isSessionRuntimeLive,
		openReplacedRuntimeSession,
		cloneAgentSession,
		applyAgentRuntimeState,
		refreshRuntimeState,
		reloadSessionMessages,
		closeAgent,
		requestCloseAgent,
		requestCloseAgentForSession,
		abortAgent,
		restartActiveAgent,
		restartSessionAnyState,
		exportAgentHtml,
		getSessionRunCapabilities,
		runSessionControl,
	} = useSessionRunControl({
		agents,
		activeAgent,
		activeAgentId,
		activeProjectId,
		showToast,
		overlays,
		refreshProjectSessions,
		selectSessionCommand,
		registerOpenSession: workspaceChrome.registerOpenSession,
		getSessionRecord,
		pendingAgentsRef,
		setPendingAgents,
		queueFlushBySessionRef,
		queuedPromptsRef: queue.queuedPromptsRef,
	});

	// 终端 IPC 目标：Agent 会话优先绑定当前 runtime；未启动或已停止时回退到项目 cwd。
	// 该计算必须放在 useSessionRunControl 之后，因为 runtime target resolver 是该 hook 的返回值。
	const terminalTarget: TerminalTarget | undefined = useMemo(() => {
		if (!terminalOwner) return undefined;
		const fallbackProject = (() => {
			const pid = terminalOwner.kind === "project" ? terminalOwner.id : (activeProjectId ?? currentSessionRecord?.projectId);
			return pid ? projects.find((p) => p.id === pid) : undefined;
		})();
		const projectTarget = fallbackProject && !isChatProject(fallbackProject) ? { kind: "project" as const, projectId: fallbackProject.id, cwd: fallbackProject.path } : undefined;
		if (terminalOwner.kind === "agent") {
			const runtimeTarget = getRuntimeTargetForSession(currentSessionId);
			return runtimeTarget ? { kind: "agent" as const, ...runtimeTarget } : projectTarget;
		}
		return projectTarget;
	}, [terminalOwner, currentSessionId, currentSessionRecord, projects, activeProjectId, getRuntimeTargetForSession]);

	const quickTask = useQuickTask({ ready: settingsLoaded, backend: effectiveAgentBackend, upsertSession, selectSession: selectSessionCommand, registerSession: workspaceChrome.registerOpenSession, refreshProjects, getSessionRecord });

	// 桌面插件发起的会话导航：broker 已验权限/归属，这里只注入现有选中动作（复用唯一选中路径）
	useHostPluginNavigation(selectSessionCommand);

	// 关闭 Tab / 分屏退栏时的焦点切换：只改 currentSession，不碰 Tab 登记
	useEffect(() => {
		workspaceChrome.bindFocusHandlers({
			focusSession: (projectId, sessionId) => {
				selectSessionCommand(projectId, sessionId, true);
			},
			focusProject: (projectId) => {
				selectProjectCommand(projectId);
			},
			// 文件夹右键打开未收录目录：弹确认框，确认后按路径入库并跳到该项目的引导页。
			focusOpenProjectPath: (path: string) => {
				overlays.showConfirm({
					title: t("app.openFolderConfirmTitle"),
					message: t("app.openFolderConfirmMessage", { path }),
					confirmLabel: t("app.openFolderConfirmAdd"),
					onConfirm: () => {
						void (async () => {
							try {
								const project = await api.projects.addByPath(path);
								// 与对话框添加同一刷新链路：侧栏清单立即出现新项目（主进程广播为兜底）。
								await refreshProjects();
								selectProjectCommand(project.id);
								showToast(t("app.openFolderAdded", { name: project.name }));
							} catch (error) {
								showToast(error instanceof Error ? error.message : String(error), 5000, "error");
							} finally {
								overlays.clearConfirm();
							}
						})();
					},
				});
			},
		});
	}, [workspaceChrome, selectSessionCommand, selectProjectCommand, overlays, showToast]);

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
		async (projectId: string, sessionId: string, tabMode: "preview" | "permanent" = "permanent") => {
			const openedId = await runOpenSidebarSessionById(projectId, sessionId);
			if (openedId) workspaceChrome.registerOpenSession(openedId, tabMode);
			return openedId;
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
	}, [activeProject, currentSessionId, refreshProjectSessions, selectSessionCommand, store]);

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
				// 引导页 picker 无 record 分支把显式选择存进 localStorage；创建时将模型交给
				// 主进程校验、将思考档位作为启动偏好带入。底栏展示和真实会话创建读取同一份值，
				// 避免出现「菜单看似切换，首次发送后又回到默认档位」。
				// 引导页底栏显式切换的后端（localStorage 偏好）优先于设置项默认；
				// 选了 dsh 但 DSH runtime 不可用时按 effectiveAgentBackendAtom 同一条
				// 钳制规则回落 pi，避免首次发送才在 createDraft 门控上抛错。
				// 与 ComposerArea 的展示用同一纯函数：展示的后端和创建的后端必须一致。
				const draftBackend = resolveGuidePageBackend({ override: readWelcomeBackendPreference(), acpToolId: readWelcomeAcpToolPreference(), effectiveDefault: effectiveAgentBackend });
				// 模型偏好按后端分开取（issue #253）：DSH 的模型是 host route 名，不在 models.json，
				// 必须作为显式 model 直接带给 host；pi 的偏好走 welcomeModel（launchDefaults 会按
				// models.json 校验存在性）。历史上 DSH 侧不读偏好，点选因此永远不生效。
				const welcomeModel = draftBackend === "dsh" ? readWelcomeDshModelPreference()?.model : readWelcomeModelPreference()?.model;
				const welcomeThinking = readWelcomeThinkingPreference()?.thinkingLevel;
				// 统一创建 draft 会话（Chat 项目也走普通会话、可保存）：创建不拉 pi，
				// selectSessionCommand 同步切页、立即进入会话页；匿名会话仅保留给侧栏
				// 「新建临时对话」入口（createAnonymousSessionWithTab）。
				// 默认后端跟随设置项（settings.defaultAgentBackend，默认 pi），
				// 且经 DSH runtime 安装态钳制——runtime 不可用时不会尝试建 dsh 会话。
				// 激活时 SessionRuntimeCoordinator.applyPreferences → DshAgentManager.setModel
				// 会把这条显式 model 落到 host（host 拒绝时降级并告警，不让创建失败）。
				const session = await api.sessions.createDraft({
					projectId: project.id,
					title: draftBackend === "dsh" ? `${project.name} DSH` : `${project.name} agent`,
					backend: draftBackend,
					...(draftBackend === "acp" ? { acpToolId: readWelcomeAcpToolPreference() } : {}),
					...(welcomeModel ? (draftBackend === "dsh" ? { model: welcomeModel } : { welcomeModel }) : {}),
					...(welcomeThinking ? { thinkingLevel: welcomeThinking } : {}),
				});
				upsertSession(session);
				// 引导页发送时 useSessionSend 已把 user 消息乐观写入虚拟会话 cache；
				// 提升时搬到真实会话——否则切页后新会话空态与引导页视觉相同，
				// 要等 agent 启动、回复流入后页面才「动」，用户误以为发送没生效。
				// 虚拟会话的 cache 随之清空（见 promoteSessionMessagesCacheAtom）。
				promoteSessionMessagesCache({
					fromSessionId: GUIDE_BOOTSTRAP_SESSION_ID,
					toSessionId: session.id,
				});
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
		[activeProjectId, projects, promoteSessionComposerState, promoteSessionMessagesCache, selectSessionCommand, upsertSession, workspaceChrome, effectiveAgentBackend],
	);

	/** 有效文件路径白名单：仅工作区真实存在的 @ 引用渲染为 chip */
	const validFilePaths = useMemo(() => new Set(flatFiles.map((f) => f.relativePath)), [flatFiles]);

	const projectIdsKey = useMemo(() => projects.map((project) => project.id).join("\n"), [projects]);

	function handleAgentInventoryChanged(nextAgents: AgentTab[]) {
		const previousPendingAgents = pendingAgentsRef.current;
		const remainingPendingAgents = previousPendingAgents.filter((pending) => !nextAgents.some((agent) => isReplacementForPendingAgent(agent, pending)));
		const pendingReplacementById = new Map(
			previousPendingAgents
				.map((pending) => {
					const replacement = nextAgents.find((agent) => isReplacementForPendingAgent(agent, pending));
					return replacement ? [pending.id, replacement.id] : undefined;
				})
				.filter((entry): entry is [string, string] => Boolean(entry)),
		);
		if (remainingPendingAgents.length !== previousPendingAgents.length) {
			pendingAgentsRef.current = remainingPendingAgents;
			setPendingAgents(remainingPendingAgents);
		}
		const draftIds = new Set([...nextAgents.map((agent) => agent.id), ...remainingPendingAgents.map((agent) => agent.id)]);
		// 终端状态清理统一由下方 useEffect([displayAgents]) 的 prune 负责：
		// 此处再调一次会在流式 runtime 更新时与 displayAgents effect 重复执行，
		// 形成不必要的 setState 链（历史日志：发送消息后 Maximum update depth）。
		livePromptByAgentRef.current = migrateAgentRecord(livePromptByAgentRef.current, pendingReplacementById, draftIds);
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
		// 主进程焦点目标（通知点击/右键打开项目）：sessionId 走旧链路选中会话；
		// projectId/projectPath 由 useSessionWorkspaceChrome 的订阅处理（本回调只透传不重复消费）。
		onFocusTarget: (target: FocusTargetPayload) => {
			if (!("sessionId" in target)) return;
			const session = store.get(sessionRecordByIdAtomFamily(target.sessionId));
			if (session) selectSessionCommand(session.projectId, session.id, false);
		},
	};

	useEffect(() => {
		void workspace.loadExternalEditors().catch(() => undefined);
		void api.imagegen
			.getConfig()
			.then(setImageGenConfig)
			.catch(() => undefined);
		void api.settings
			.get()
			.then((next) => {
				setSettings(next);
				setSettingsLoaded(true);
				setEnhanceModel(next.enhanceModel ?? null);
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
			})
			.catch(() => {
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
			const unchanged = next.size === prev.size && [...next].every((id) => prev.has(id));
			if (unchanged) return next;
			commitExpandedSidebarProjects(next);
			return next;
		},
		[commitExpandedSidebarProjects],
	);

	useEffect(() => {
		const projectIds = new Set(projects.map((project) => project.id));
		setVisibleProjectChildCountByProject((current) => Object.fromEntries(Object.entries(current).filter(([projectId]) => projectIds.has(projectId))));
		setSessionLoadingByProject((current) => Object.fromEntries(Object.entries(current).filter(([projectId]) => projectIds.has(projectId))));
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
		if (activeAgentId && !isPendingAgentId(activeAgentId)) void refreshRuntimeState(activeAgentId);
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
			return () => {
				disposed = true;
			};
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

	// 持久化会话来源过滤配置
	useEffect(() => {
		try {
			saveSessionSourceFilter(sessionSourceFilter);
		} catch (error) {
			// 静默失败
		}
	}, [sessionSourceFilter]);

	// 汇报聚焦会话给主进程：非聚焦会话收到 Ask 请求时触发桌面通知（Task 9）
	useEffect(() => {
		void api.sessions.setFocusedSession(currentSessionId).catch(() => undefined);
	}, [currentSessionId]);

	// 已删除内置 goal 完成检测。

	// 监听用户发送消息的编辑事件：回填输入框，并把自包含引用块还原成 chip
	// （quote 重建快照 + #q token，其余还原为 mention 文本，见 useUserMessageEditReplay）
	useUserMessageEditReplay({
		setPrompt,
		pendingComposerCaretRef,
		composerRef: composerTextareaRef,
		currentSessionIdRef,
	});

	// 编辑器右键「引用选中内容」：@path:start-end 引用追加到输入框（与文件树右键 onAttach 同语义）
	useEffect(() => {
		const handler = (event: Event) => {
			const detail = (event as CustomEvent<{ refs?: string[] }>).detail;
			const refs = detail?.refs;
			if (!refs?.length) return;
			setPrompt((current) => `${current}${current.endsWith(" ") || current.length === 0 ? "" : " "}${refs.join(" ")} `);
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

	// 项目切换只刷 git 分支（文件树加载/恢复已收口到 useProjectFileTreeController）
	useEffect(() => {
		if (!activeProjectId) {
			setGitInfo({ current: null, branches: [] });
			return;
		}
		let cancelled = false;
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
	}, [activeProjectId]);

	useEffect(() => {
		if (!activeProjectId) return;
		let stopped = false;
		const refreshGitInfo = async () => {
			try {
				const next = await api.git.branches(activeProjectId);
				if (stopped) return;
				// 外部终端/IDE 切分支时同步侧栏徽标与抽屉，只在状态真的变化时更新，避免不必要重渲染。
				setGitInfo((current) => (current.current === next.current && current.branches.join("\n") === next.branches.join("\n") ? current : next));
				// 侧栏分支徽标与 Git 抽屉同源：外部终端 checkout 后也要一起跟上。
				// 只更新聚焦项目——非聚焦项目不在监听范围内，由栏内 usePaneGitInfo 回写。
				setBranchByProject((prev) => (prev[activeProjectId] === next.current ? prev : { ...prev, [activeProjectId]: next.current }));
			} catch {
				if (!stopped) {
					setGitInfo({ current: null, branches: [] });
				}
			}
		};
		void refreshGitInfo();
		// 与栏内 usePaneGitInfo 同一事件源：主进程 GitRefsWatcher 复用一份 1.5s refs
		// 签名轮询，替代 App 级 4s 盲轮询；订阅失败时静默降级为初始一次回读。
		const offRefsChanged = api.git.onRefsChanged((changedWatchId) => {
			if (changedWatchId !== watchId || stopped) return;
			void refreshGitInfo();
		});
		const watchPromise = api.git.watchRefs(activeProjectId).catch(() => null);
		let watchId: string | null = null;
		void watchPromise.then((id) => {
			watchId = id;
		});
		return () => {
			stopped = true;
			offRefsChanged();
			// 竞态安全：卸载时 watch 可能尚未 resolve，退订等它落地后执行。
			void watchPromise.then((id) => {
				if (id) void api.git.unwatchRefs(id);
			});
		};
	}, [activeProjectId]);

	/**
	 * clone / fork 会把同一个 Agent 换绑到新的 SessionRecord。
	 * 必须先刷新 catalog 再登记 Tab：否则 chrome 的 prune 看到 records 里还没有新 id，会立刻清掉刚打开的 Tab。
	 * 选中与登记都在这里组合——selectSession 本身不碰 Tab。
	 */
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

	async function reorderProjects(sourceProjectId: string, targetProjectId: string, position: "before" | "after" = "after") {
		if (sourceProjectId === targetProjectId) return;
		const sourceProject = projects.find((project) => project.id === sourceProjectId);
		const targetProject = projects.find((project) => project.id === targetProjectId);
		if (isChatProject(sourceProject) || isChatProject(targetProject)) return;
		// 插入点由拖放边缘显式决定（utils/projectOrder 纯函数，便于单测）。
		const previousProjects = projects;
		const nextProjects = reorderProjectList(projects, (project) => project.id, sourceProjectId, targetProjectId, position);
		if (nextProjects === previousProjects) return;
		setProjects([...nextProjects]);

		try {
			const savedProjects = await api.projects.reorder(nextProjects.map((project) => project.id));
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

	/** 置顶/取消置顶普通项目：主进程落库后用返回列表刷新，聊天项目由 ProjectStore 拒绝。 */
	async function setProjectPinned(project: Project, pinned: boolean) {
		if (isChatProject(project)) return;
		try {
			const savedProjects = await api.projects.setPinned(project.id, pinned);
			setProjects(savedProjects);
		} catch (error) {
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

	function updateAfterProjectRemoved(removedProjectId: string, next: Project[]) {
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

	/** 调整菜单位置避免溢出视口 */
	function adjustMenuPos(x: number, y: number, width = 200, height = 260) {
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		return {
			x: x + width > vw ? Math.max(4, vw - width - 8) : x,
			y: y + height > vh ? Math.max(4, vh - height - 8) : y,
		};
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

	// Session prompt dispatch extracted to useSessionPromptDispatch
	// (dispatchPromptSnapshot / submitPromptSnapshot / translateAgentErrorMessage /
	// isAgentCurrentlyBusy / setPromptForAgent / setPrompt / livePromptByAgentRef).
	/**
	 * pi 历史消息改写：无 runtime 直接改 JSONL；有 runtime 先确认停止再改文件。
	 * DSH 入口在 Injector 按 backend 隐藏。下次发送才重新激活 Agent。
	 */
	const { editMessage, deleteMessage, removeMessageImage, resendUserMessage, forkFromUserMessage, forkAtEntry, forkingMessageId } = useSessionHistoryMutations({
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
		resolveProjectId: (sessionId) => getSessionRecord(sessionId)?.projectId ?? activeProjectId,
		hasPersistedSessionFile: (sessionId) => {
			const record = getSessionRecord(sessionId);
			return Boolean(record?.filePath) && !record?.noSession;
		},
		// 生图 draft：会话消息里存在生图占位/结果即判定为生图模式（无 pi runtime、无 pi JSONL）。
		isImageGenSession: (sessionId) => (store.get(sessionMessagesCacheAtom)?.[sessionId]?.messages ?? []).some((message) => message.meta?.imageGen !== undefined),
		// fork 化重发/编辑只服务 pi 后端：DSH 维持 legacy 路径（策略层返回 catalog）
		isDshSession: (sessionId) => getSessionRecord(sessionId)?.backend === "dsh",
		// fork 锚点是否为最后一条用户消息：尾部 → 替换语义（旧会话隐藏）；非尾部 → 分支模式（旧会话保留可见）。
		// 缓存缺失时按非尾部处理（false），宁可两会话并存也不隐藏可能还有独属内容的旧会话。
		isLastUserMessage: (sessionId, message) => {
			const cached = store.get(sessionMessagesCacheAtom)?.[sessionId]?.messages;
			if (!cached) return false;
			const index = cached.findIndex((candidate) => candidate.id === message.id);
			if (index < 0) return false;
			return !cached.slice(index + 1).some((candidate) => candidate.role === "user");
		},
		// 生图重发：把失败的提示词（+参考图）放回输入框供一键重试。参考图直接整体替换附件栏
		//（重发目标就是这轮消息自身，不需要前插保留——那是失败后保留用户新粘贴图的场景）。
		restoreImageGenTurn: (sessionId, text, images) => {
			setSessionDraft({ sessionId, value: text });
			if (!images?.length) return;
			// 历史消息里的参考图是落盘引用（ref），附件栏与后续请求体要的是 base64：
			// 异步回填，取不到字节的条目丢掉（不阻断提示词回填）。
			void hydrateImageContents(images, (ref) => window.piDesktop.imagegen.readImageBlob(ref))
				.then((hydrated) => {
					if (hydrated.length > 0) {
						setSessionAttachments({ sessionId, value: hydrated });
						return;
					}
					if (images.length > 0) showToast(t("imagegen.referenceUnavailable"));
				})
				.catch(() => showToast(t("imagegen.referenceUnavailable")));
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

	// 设置写入域（updateSettings/restartWebService + webServiceChanging 态）收口到 useSettingsUpdater
	const { updateSettings, restartWebService, webServiceChanging } = useSettingsUpdater({
		showToast,
		piUpdate,
		onSettingsApplied: setSettings,
		onProjectsChanged: setProjects,
		activeProjectId,
		refreshProjectSessions,
		webServiceEnabled: settings.webServiceEnabled,
	});

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
				const refreshed = await api.git.branches(activeProjectId).catch(() => ({ current: null, branches: [] }));
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

	// 侧栏会话归档/删除族收口到 useSidebarArchiveActions（删除/归档/恢复 + DSH 归档）
	const { deleteSidebarSession, archiveSidebarSession, unarchiveSidebarSession, unarchiveDshSidebarSession, listArchivedSidebarSessions, deleteArchivedSidebarSession, listArchivedDshSidebarSessions, deleteArchivedDshSidebarSession, requestDeleteSidebarSession } = useSidebarArchiveActions({
		activeProjectId,
		showToast,
		overlays,
		refreshProjectSessions,
		dismissSessionTree,
		getSessionRecords: getProjectSessionRecords,
	});

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
			showToast(message.includes("CHAT_PATH_OVERLAPS_PROJECT") ? t("app.chatPathOverlapsProject") : message, 5000);
		}
	}

	/**
	 * 按需加载单个项目的会话 catalog：已 loading/ready 的项目直接跳过。
	 * 空项目也可能已经成功加载，所以用 catalog 状态区分「空结果」和「尚未扫描」。
	 *
	 * silent 区分两种触发意图：
	 * - false（默认，用户点选/展开项目）：走常规加载态，侧栏会显示该项在加载；
	 * - true（活动页「最近会话」跨项目预热）：后台静默拉取，不挂 loading 态、不装 catalog
	 *   看门狗——用户只是看了眼活动页，不该让侧栏一堆项目同时转圈。
	 * 两者共用同一处「什么时候该扫、什么时候该跳过」判断，避免规则漂移。
	 */
	const ensureProjectCatalogLoaded = useCallback(
		(projectId: string, silent = false) => {
			const loadState = store.get(sessionCatalogLoadStateAtom)[projectId];
			if (loadState?.status === "loading" || loadState?.status === "ready") return;
			void refreshProjectSessions(projectId, silent).catch(() => undefined);
		},
		[store, refreshProjectSessions],
	);

	const sidebarActions: SidebarActions = {
		projects: {
			add: addProject,
			select: (projectId) => {
				selectProjectCommand(projectId);
				// 点开目录只选中项目并显示引导页：不自动创建会话，避免每点一个目录都
				// 悄悄新建一个 agent 会话 tab。创建由用户手动点「启动 Agent / 临时对话」
				// 触发；启动时首项目自动选中除外（见 bootstrapProps.onProjectsChanged）。
				// 项目点击选中即按需加载 catalog（已加载/加载中的跳过）。
				ensureProjectCatalogLoaded(projectId);
			},
			refresh: async (projectId) => {
				const project = projects.find((candidate) => candidate.id === projectId);
				if (project) await refreshProjectTree(project);
			},
			refreshAll: refreshAllProjects,
			reorder: reorderProjects,
			setPinned: setProjectPinned,
			reveal: (project) => api.files.showInFolder(project.path),
			openWithEditor: (project) => {
				workspace.openExternalEditorChooser(project.path, { x: 80, y: 80 });
			},
			importSessions: (project, source) => {
				if (source === "codex") return openCodexImport(project);
				if (source === "claude") return openClaudeImport(project);
				if (source === "qoder") return openQoderImport(project);
				if (source === "zcode") return openZCodeImport(project);
				if (source === "workbuddy") return openWorkBuddyImport(project);
				if (source === "cursor") return openCursorImport(project);
				if (source === "kimi") return openKimiImport(project);
				if (source === "kimiwork") return openKimiWorkImport(project);
				if (source === "minimax") return openMinimaxImport(project);
				return openOpenCodeImport(project);
			},
			importDirectorySessions: (project) => openDirectoryImport(project),
			manageResources: (project) => setProjectResourcesProject(project),
			manageAutomations: (projectId) => openAutomationModal(projectId),
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
			// 简洁模式没有临时预览；标签模式保留原设置及双击晋升。
			simpleNavigation: settings.navigationMode === "simple",
			open: async (projectId, sessionId, tabMode) => {
				await openSidebarSessionByIdWithTab(projectId, sessionId, settings.navigationMode === "simple" ? "permanent" : (tabMode ?? settings.sessionTabOpenMode));
			},
			// 活动页「最近会话」跨项目展示：后台静默预热尚未扫描的项目 catalog。
			ensureCatalogsLoaded: (projectIds) => {
				for (const projectId of projectIds) ensureProjectCatalogLoaded(projectId, true);
			},
			beginDrag: workspaceChrome.beginDrag,
			endDrag: workspaceChrome.endDrag,
			createDraft: async (projectId) => {
				await createSessionDraftWithTab(projectId);
			},
			createAnonymous: async (projectId) => {
				await createAnonymousSessionWithTab(projectId);
			},
			// ACP 工具会话：backend 固定 acp、acpToolId 指向 settings.acpTools 条目。
			// 工具表已加载进 acpToolsAtom，此处只按 id 取名称作草稿标题；找不到（刚被删）
			// 提示引导而不是静默失败。创建后与 createDraft 同一条选中/登记链。
			createAcp: async (projectId, toolId) => {
				const tool = store.get(acpToolsAtom).find((candidate) => candidate.id === toolId);
				if (!tool) {
					showToast(t("app.acpNoTools"), 3000);
					return;
				}
				const session = await api.sessions.createDraft({ projectId, title: tool.name, backend: "acp", acpToolId: tool.id });
				upsertSession(session);
				selectSessionCommand(projectId, session.id, false);
				workspaceChrome.registerOpenSession(session.id, "permanent");
			},
			deleteDraft: deleteDraftSession,
			rename: rename.openSessionRename,
			export: runExportSidebarSession,
			copy: runCopySidebarSession,
			copyPath: async (session) => {
				// DSH 会话没有 pi 会话文件：走主进程按 dshSessionId + cwd 推导 host 持久化路径（F5）。
				// 失败/不可推导时提示而不是把空值写进剪贴板（原实现会把 undefined 写成 "undefined" 字符串）。
				const path = session.backend === "dsh" ? await api.sessions.getDshSessionPath(session.id) : session.filePath;
				if (!path) {
					showToast(t("menu.copySessionFilePathUnavailable"), 3000);
					return;
				}
				await navigator.clipboard.writeText(path);
				showToast(t("common.copied"));
			},
			openFile: (session) =>
				api.files.open(session.filePath).catch((error) => {
					showToast(t("app.openFileFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
				}),
			delete: async (projectId, session) => {
				requestDeleteSidebarSession(projectId, session);
			},
			// 运行控制（全状态统一入口）：启动/停止/重启/重载都走 runSessionControl 分派
			runControl: async (sessionId, action) => {
				await runSessionControl(sessionId, action);
			},
			// 会话代理设置：宿主弹窗在 App 层统一挂载，这里只登记目标会话
			openProxySetting: (sessionId) => setProxyDialogSessionId(sessionId),
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
			openSessionFile: (agent) =>
				agent.sessionPath
					? api.files.open(agent.sessionPath).catch((error) => {
							showToast(t("app.openFileFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
						})
					: Promise.resolve(),
			close: requestCloseAgent,
			// 运行控制（全状态统一入口）：agent 菜单同样收敛到 runSessionControl
			runControl: async (sessionId, action) => {
				await runSessionControl(sessionId, action);
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
				if (!target) return Promise.resolve(false);
				// 回执落地后才写渲染层镜像：侧栏菜单文案与抽屉 rpcLog Tab 门控都读它，
				// 写早了会把开关失败误显示为已开启（回执 false 表示主进程未允许）。
				return api.rpcLogs.setLogging(target, enabled).then((receipt) => {
					patchRpcLoggingAgentIds(agentId, receipt);
					return receipt;
				});
			},
			listLogs: (agentId) => {
				const target = getRuntimeTargetForAgent(agentId);
				return target ? api.rpcLogs.get({ target }) : Promise.resolve([]);
			},
			// 日志面板 = 右侧抽屉的临时面板：非模态，可与消息区同时使用（旧弹窗打开时发不了消息）
			openViewer: (agentId) => workspace.openRpcLogPanel(agentId),
		},
	};

	const sidebarContentNode = (
		<AppSidebar
			simple={settings.navigationMode === "simple"}
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
			onOpenNewSession={() => {
				if (activeProjectId) selectProjectCommand(activeProjectId);
			}}
			onOpenFeedback={() => overlays.setFeedbackOpen(true)}
			settingsExpandedProjectIds={settings.sidebarExpandedProjectIds}
			settingsNavTab={settings.sidebarNavTab}
			settingsPinnedSessionIds={settings.pinnedSessionIds}
			settingsSessionSortMode={settings.sessionSortMode}
			settingsLoaded={settingsLoaded}
			onExpandedProjectsReady={() => setExpandedProjectsReady(true)}
			// 关于弹框：版本号/官网/GitHub 链接数据来自 AppInfo IPC（上方 useEffect 已拉取）
			appInfo={appInfo}
			// 底栏主题按钮：点击在浅/暗之间翻转；跟随系统/跟随时间退出自动时按当前实际明暗翻到对面，
			// 保证每次点击都有可见变化。落库后只合并 theme 字段，data-theme 由外观 effect 依赖 settings.theme 重应用。
			themeMode={settings.theme}
			onToggleTheme={() => {
				void api.settings
					.update({
						theme: toggleThemeMode(settings, window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? false),
					})
					.then((saved) => setSettings((current) => ({ ...current, theme: saved.theme })))
					.catch(() => undefined);
			}}
		/>
	);

	// Gate 4.6 — Session view wrapped in SessionRuntimeInjector / ChatSessionPane

	// 会话 Tab 栏始终外置挂载；分屏双栏共享同一条 Tab，单栏也不再嵌入 SessionView。
	const focusSessionPane = useCallback(
		(sessionId: string) => {
			const record = store.get(sessionRecordByIdAtomFamily(sessionId));
			if (record) selectSessionCommand(record.projectId, sessionId, true);
		},
		[selectSessionCommand, store],
	);

	const navigation = useSessionNavigation(currentSessionId, (id) => {
		workspaceChrome.registerOpenSession(id, "permanent");
		focusSessionPane(id);
	});

	// 后台 Ask 通知「前往会话」：跳转的同时登记常驻 Tab——agent 开多时被询问的会话
	// 可能根本没开 Tab（后台并行 ask 等），只切焦点的话回答完切换出去就找不到了。
	const jumpToAskSession = useCallback(
		(sessionId: string) => {
			const record = store.get(sessionRecordByIdAtomFamily(sessionId));
			if (!record) return;
			workspaceChrome.registerOpenSession(sessionId, "permanent");
			selectSessionCommand(record.projectId, sessionId, true);
		},
		[selectSessionCommand, store, workspaceChrome],
	);

	// M7：后台 Ask 巡检全应用单点挂载（原寄生在每栏 runtime 控制器，全局订阅拖垮分屏）
	useBackgroundAskPatrol({ onFocusSession: jumpToAskSession });

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
		// 简洁模式直接切内容：整区位移会越过面板边界，制造额外滚动条。
		if (settings.navigationMode === "simple") return;
		// 分屏内面板间聚焦切换：各栏都已渲染、内容未变，只有聚焦边框亮起；
		// 整区重播淡入微位移会造成「抖/闪」，静默跳过（边框高亮由
		// .session-split-pane-focused 类切换承担，无动画）。
		const layout = workspaceChrome.splitLayout;
		const splitIds = layout ? splitLayoutSessionIds(layout) : [];
		const prevInSplit = Boolean(layout && prev && splitIds.includes(prev));
		const nextInSplit = Boolean(layout && currentSessionId && splitIds.includes(currentSessionId));
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
	}, [currentSessionId, workspaceChrome.splitLayout, settings.navigationMode]);

	// —— Tab 栏会话操作组（重命名 / 复制会话 / 导出 HTML / 复制路径 / 打开文件）——
	// 与侧栏会话右键菜单同源同语义，参数化到任意 sessionId：⋯ 菜单喂当前会话，
	// Tab 右键菜单（SessionTabsBar contextSessionActions）喂被右键的 Tab——后台 Tab
	// 同样可操作。live 会话复制走 clone 分流（Agent 换绑新会话，DSH 亦可），历史/
	// 未启动会话走 copyRecord；DSH 历史会话无宿主文件，隐藏复制/导出组（与侧栏一致）。
	// record/runtime 用 store 现查（右键目标不在 current* 闭包里）；agent 列表闭包自
	// 当次渲染（SessionTabsBar 的 renderTab 每渲染重建，无过期问题）。
	const buildTabsSessionActions = (sessionId: string): SessionTabsBarProps["sessionActions"] => {
		const record = store.get(sessionRecordsAtom)[sessionId];
		if (!record) return undefined;
		const runtime = store.get(sessionRuntimeBySessionIdAtomFamily(sessionId));
		const isLive = isLiveRuntimeStatus(runtime?.status);
		const agentId = runtime?.agentId;
		// 草稿闸门：草稿期不提供重命名（自动命名还没跑，先钉名字会让条目进 manual
		// 终态，扩展规划的会话名再也写不进来）；复制/导出同款闸门。
		const canRename = record.status !== "draft";
		return {
			canCopySession: canRename && (isLive || record.backend !== "dsh"),
			canExportHtml: canRename && record.backend !== "dsh",
			hasFilePath: Boolean(record.filePath),
			onCopySession: () => {
				if (isLive && agentId) {
					void cloneAgentSession(agentId);
					return;
				}
				void runCopySession(sessionId, record.projectId);
			},
			onCopySessionFilePath: () => {
				void (async () => {
					// DSH 会话文件路径按 dshSessionId + cwd 推导（与侧栏 copyPath 同源）；
					// 失败/不可推导时提示而不是把空值写进剪贴板。
					const path = record.backend === "dsh" ? await api.sessions.getDshSessionPath(sessionId) : record.filePath;
					if (!path) {
						showToast(t("menu.copySessionFilePathUnavailable"), 3000);
						return;
					}
					await navigator.clipboard.writeText(path);
					showToast(t("common.copied"));
				})();
			},
			onOpenSessionFile: record.filePath
				? () => {
						const filePath = record.filePath;
						if (!filePath) return;
						api.files.open(filePath).catch((error) => {
							showToast(
								t("app.openFileFailed", {
									error: error instanceof Error ? error.message : String(error),
								}),
								4000,
							);
						});
					}
				: undefined,
			onExportSessionHtml: () => {
				// live 会话走 runtime 导出（与侧栏 agent 导出同源）；历史会话读文件导出
				if (isLive && agentId) {
					void exportAgentHtml(agentId);
					return;
				}
				api.sessions
					.exportRecordHtml(sessionId)
					.then((result) => showToast(t("app.exportedPath", { path: result.path }), 3500))
					.catch((error) => showToast(error instanceof Error ? error.message : String(error), 5000));
			},
			onRename: canRename
				? () => {
						// live 会话用 agent 重命名（与侧栏 AgentContextMenu 同源，改名同步运行时标题）；
						// 历史/未启动会话用 record 拼侧栏同构的 SessionSummary 走统一重命名弹框。
						const agent = agentId ? [...displayAgents, ...pendingAgents].find((candidate) => candidate.id === agentId) : undefined;
						if (isLive && agent) {
							rename.openAgentRename(agent);
							return;
						}
						rename.openSessionRename(record.projectId, {
							id: record.id,
							filePath: record.filePath ?? "",
							name: record.title,
							preview: record.preview,
							updatedAt: record.updatedAt,
							messageCount: record.messageCount,
							backend: record.backend,
							forked: record.forked,
						});
					}
				: undefined,
		};
	};
	// ⋯ 菜单（当前会话）与 Tab 右键菜单（被右键的 Tab）共用同一工厂，闸门语义一致。
	const tabsSessionActions = currentSessionId ? buildTabsSessionActions(currentSessionId) : undefined;

	useEffect(() => {
		if (settings.navigationMode === "simple" && workspaceChrome.previewSessionTabId) workspaceChrome.promotePreview(workspaceChrome.previewSessionTabId);
	}, [settings.navigationMode, workspaceChrome.previewSessionTabId, workspaceChrome.promotePreview]);

	const sessionTabsProps = {
		tabs: workspaceChrome.sessionTabIds,
		// 会话 Tab 宽度上限（外观设置可调，默认 104px）：SessionTabsBar 据此写 CSS 变量控制各 Tab 封顶。
		tabMaxWidth: settings.sessionTabMaxWidth,
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
		// ACP 工具会话入口（Tab 栏 + 下拉尾部，工具→项目二级）：走 sidebarActions.createAcp，
		// 与设置页共用同一条创建链（backend=acp + acpToolId）。
		onNewAcpSession: (projectId: string, toolId: string) => {
			void sidebarActions.sessions.createAcp(projectId, toolId);
		},
		onTogglePin: workspaceChrome.togglePin,
		onReorder: workspaceChrome.reorderTab,
		// 分屏组胶囊：分屏内会话聚合为组（颜色标记 + 展开/收起）
		splitGroupIds: workspaceChrome.splitLayout ? splitLayoutSessionIds(workspaceChrome.splitLayout) : [],
		splitGroupCollapsed: workspaceChrome.splitGroupCollapsed,
		onToggleSplitGroup: workspaceChrome.toggleSplitGroupCollapsed,
		splitGroupName: workspaceChrome.splitGroupConfig.name,
		splitGroupColor: workspaceChrome.splitGroupConfig.color,
		onSplitGroupRename: (name: string) => workspaceChrome.setSplitGroupConfig((config) => ({ ...config, name })),
		onSplitGroupColorChange: (color: string) => workspaceChrome.setSplitGroupConfig((config) => ({ ...config, color })),
		onExitAllSplit: workspaceChrome.exitAllSplit,
		// Tab 下拉运行控制：全状态统一入口（能力由 getSessionRunCapabilities 纯函数策略决定）。
		// 「停止回答」= abort（只中断当前回合，进程保留）；「关闭 Agent」= 杀进程 + 解绑，
		// 两者都保留会话记录与 Tab；未启动/失败/已关闭时主控按钮文案切成「启动 Agent」。
		runControl: currentSessionId
			? {
					capabilities: getSessionRunCapabilities(currentSessionId),
					isStopping: stoppingAgentId === activeAgentId,
					isRestarting: restartingAgentId === activeAgentId || activatingSessionId === currentSessionId,
					isReloading: reloadingSessionId === currentSessionId,
					// 「复制 Agent ID」用：与上面的 isStopping 同源判定（activeAgentId 即当前会话绑定的进程实例）
					agentId: activeAgentId,
					onCloseAgent: activeAgentId ? () => requestCloseAgentForSession(currentSessionId) : undefined,
					onAction: (action: SessionRunAction) => void runSessionControl(currentSessionId, action),
				}
			: undefined,
		// 会话代理（网络代理）入口：与侧栏会话菜单同源，打开同一个弹框。
		// 仅在有当前会话时给出；弹框内自行判断 DSH 等宿主差异并给出「下次启动生效」提示。
		onOpenProxySetting: currentSessionId ? () => setProxyDialogSessionId(currentSessionId) : undefined,
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
	const activeTerminalOwnerKey = terminalOwner ? terminalOwnerKey(terminalOwner) : undefined;

	// 分屏栏分支变化后的全局同步：侧栏分支字典对所有栏项目即时更新（每个项目行都要显示自己的分支），
	// 但右侧 Git 抽屉只采纳“栏项目 == 当前聚焦项目”的变化，
	// 非聚焦栏（另一个 worktree）切分支不得污染右侧 Git 抽屉的聚焦态；
	// 聚焦项目自己的分支早期离开（checkout 后被 4s 轮询追平）也不至于闪回旧值。
	const handleProjectGitChanged = useCallback(
		(projectId: string, info: GitBranchInfo) => {
			setBranchByProject((prev) => (prev[projectId] === info.current ? prev : { ...prev, [projectId]: info.current }));
			if (projectId !== activeProjectIdRef.current) return;
			setGitInfo((current) => (current.current === info.current && current.branches.join("\n") === info.branches.join("\n") ? current : info));
		},
		[setBranchByProject],
	);

	const sessionPaneServices = useMemo(
		() => ({
			simpleNavigation: settings.navigationMode === "simple",
			isLanWeb,
			promoteSessionToPermanent: workspaceChrome.promotePreview,
			showToast,
			onOpenFile: handleOpenLinkedFile,
			onDiffFile: diffFilePath,
			onPreviewImage: setPreviewImage,
			abortAgent,
			restartActiveAgent,
			openProviderLogin,
			runCreateSessionDraft: async () => {
				await createSessionDraftWithTab();
			},
			enqueueSessionPrompt,
			insertQuickPrompt,
			ensureSessionId: ensureSessionForSend,
			resendUserMessage,
			editMessage,
			deleteMessage,
			removeMessageImage,
			forkFromUserMessage,
			forkingMessageId,
			openSidebarSessionById: async (projectId: string, sessionId: string) => {
				await openSidebarSessionByIdWithTab(projectId, sessionId, "permanent");
			},
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
			onProjectGitChanged: handleProjectGitChanged,
			showThinking: settings.showThinking,
			validFilePaths,
			terminalStatesByOwner,
			activeTerminalOwnerKey,
			availableTerminalHeight: availableTerminalHeight ?? 120,
			setTerminalOpenByOwnerKey,
			setTerminalCollapsedByOwnerKey,
			setTerminalHeight,
			terminalSettings,
			hiddenComposerFeatures: settings.hiddenComposerFeatures ?? [],
			onTerminalThemeChange: setTerminalTheme,
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
			removeMessageImage,
			diffFilePath,
			displayAgents,
			editMessage,
			enqueueSessionPrompt,
			handleProjectGitChanged,
			ensureSessionForSend,
			environmentDialog,
			forkFromUserMessage,
			forkingMessageId,
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
			openProviderLogin,
			resendUserMessage,
			sessionDurationByAgent,
			settings.showThinking,
			settings.navigationMode,
			setPreviewImage,
			setTerminalCollapsedByOwnerKey,
			setTerminalHeight,
			setTerminalTheme,
			terminalSettings,
			settings.hiddenComposerFeatures,
			setTerminalOpenByOwnerKey,
			showToast,
			terminalStatesByOwner,
			availableTerminalHeight,
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
							workspaceChrome.splitLayout && splitLayoutSessionIds(workspaceChrome.splitLayout).includes(currentSessionId) ? workspaceChrome.splitLayout : null
						}
						draggingSessionId={workspaceChrome.draggingSessionId}
						onDropSplit={workspaceChrome.dropSplit}
						solo={<ChatSessionPane sessionId={currentSessionId} focused onFocusPane={() => focusSessionPane(currentSessionId)} splitPane={false} />}
						soloSessionId={currentSessionId}
						tabCount={workspaceChrome.sessionTabIds.length}
						renderSession={(sessionId) => <ChatSessionPane key={sessionId} sessionId={sessionId} focused={currentSessionId === sessionId} onFocusPane={() => focusSessionPane(sessionId)} splitPane />}
					/>
				</div>
			) : (
				// 无当前会话（普通项目点开 / 所有 Tab 关闭）时，普通项目与 Chat 项目
				// 共享统一空态；快捷操作新建 Agent / 匿名聊天，无项目时引导添加项目。
				// 引导页同样可以打开项目级终端（owner=project）：与有会话视图同构的
				// 垂直分屏形态，分隔条拖拽调高，高度经 localStorage 持久化跨重启恢复。
				// key 随终端挂载变化：面板数变化必须重建 Group（同 sessionResizableGroupKey）。
				<ResizablePanelGroup key={`empty-terminal-${terminalDockVisible ? "docked" : "solo"}`} orientation="vertical" className="min-h-0 flex-1">
					<ResizablePanel id="empty-main" minSize={200} className="flex min-h-0 flex-col">
						{/* 无会话空态：引导页 = 新建页面形态（居中 ComposerArea + 虚拟会话），
                不登记 Tab；首次发送才由 ensureSessionForSend 创建真实会话并落 Tab */}
						<ProjectEmptyState activeProject={activeProject} projects={projects} onAddProject={() => void addProject()} onSelectProject={selectProjectCommand} />
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
							terminalSettings={terminalSettings}
							onThemeChange={setTerminalTheme}
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

	const workbenchTheme: "dark" | "light" = typeof document !== "undefined" && document.documentElement.dataset.theme === "dark" ? "dark" : "light";

	// Git Diff 优先于文件编辑器（同一时刻只挂一份阅读面）
	const workbenchHasGitDiff = Boolean(gitDrawerDiff && gitDrawerDiff.projectId === activeProjectId);
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
	const simpleMode = settings.navigationMode === "simple";
	const [simpleContentExpanded, setSimpleContentExpanded] = useState(false);
	useEffect(() => setSimpleContentExpanded(false), [activeTabId, gitDrawerDiff?.filePath, simpleMode]);
	const workbenchLayout = simpleMode ? (simpleContentExpanded ? "maximize" : "split") : workbenchHasGitDiff ? gitDiffDisplayMode : editorMode;

	// 文件/Diff Tab 挂进总 SessionTabsBar：与会话共用一条栏，内容区不再另起绿条 Tab
	const fileTabs = editorTabs.map((tab) => ({
		id: tab.id,
		label: tab.label ?? tab.filePath.split(/[/\\]/).pop() ?? tab.filePath,
		title: tab.filePath,
		preview: tab.id === previewEditorTabId,
		active: !workbenchHasGitDiff && tab.id === activeTabId,
	}));
	const workbenchEditorTabs = [...(simpleMode || !workbenchHasGitDiff ? fileTabs : []), ...(workbenchHasGitDiff && gitDrawerDiff ? [{ id: `git-diff:${gitDrawerDiff.filePath}`, label: gitDrawerDiff.label, title: gitDrawerDiff.filePath, active: true }] : [])];

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
				const projectPath = activeAgent?.cwd || (activeProject && !isChatProject(activeProject) ? activeProject.path : null);
				// 无项目目录也允许打开：编辑器入口在气泡内禁用并提示，
				// 文件管理器不依赖项目（空路径由主进程回退用户主目录）
				const anchor = adjustMenuPos(e.currentTarget.getBoundingClientRect().left - 4, e.currentTarget.getBoundingClientRect().bottom + 4, 240, 240);
				workspace.openExternalEditorChooser(projectPath || "", anchor);
			},
		},
	];

	// ── 命令面板（Ctrl/Cmd+P）────────────────────────────────────────────
	//
	// 与会话搜索（Ctrl+F / MorphingSearch）刻意分成两条链路：那边搜「项目/会话」实体
	// 并跳转，这边搜「设置项 + 操作」。「重启当前 Agent」「复制 Agent ID」这类命令
	// 此前只能钻进侧栏/Tab 的右键菜单里翻，命令面板给它们一条可搜索的直达路径。
	//
	// 命令面板域（开关/快捷键唤起/命令列表）收口到 useCommandPalette
	const { commandPaletteOpen, setCommandPaletteOpen, openCommandPalette, commandPaletteCommands } = useCommandPalette({
		activeProjectId,
		currentSessionId,
		activeAgentId,
		hiddenModules: settings.hiddenModules ?? [],
		actions: { selectProjectCommand, restartActiveAgent, closeAgent, runSessionControl },
	});

	// 窗口缩放快捷键（Ctrl/Cmd+= / Ctrl/Cmd+-）由主进程直接改 zoomFactor 并落盘
	// （见 main/windowZoom.ts），渲染层只订阅新比例同步设置态——否则设置页
	// 「外观 → 窗口缩放」会一直显示快捷键改动前的旧百分比。
	useEffect(() => {
		return api.app.onZoomFactorChange((zoomFactor) => {
			setSettings((prev) => (prev.zoomFactor === zoomFactor ? prev : { ...prev, zoomFactor }));
		});
	}, []);

	const selectWorkbenchTab = (id: string) => {
		if (id.startsWith("git-diff:")) return;
		if (workbenchHasGitDiff) dismissGitDiff();
		selectEditorTab(id);
	};
	const closeWorkbenchTab = (id: string) => {
		if (id.startsWith("git-diff:")) {
			if (simpleMode) dismissGitDiff();
			else closeGitDiff();
		} else closeEditorTab(id);
	};
	const toggleSimpleContent = () => setSimpleContentExpanded((value) => !value);
	// 页面式插件面板伪 Tab：tab 模式下挂进 SessionTabsBar（打开时会话 Tab 退非选中，
	// 点任意会话 Tab 即收起）；simple 模式不挂（插件页直接铺满会话区，由 Overlay 承担）。
	const hostPluginPageTab = useHostPluginPageTab();
	const sessionTabsBarNode = (
		<SessionTabsBar
			{...sessionTabsProps}
			simple={simpleMode}
			// 插件页占据会话区时，会话 Tab 不得显示选中态（当前呈现的不是会话）
			currentSessionId={hostPluginPageTab ? undefined : currentSessionId}
			pluginTab={simpleMode ? null : hostPluginPageTab}
			// 点任意会话 Tab（含当前 Tab，sessionId 不变的场景）也要收起插件页；
			// Overlay 的 scope 变化兑底只覆盖「切到别的会话」这一分支。
			onSelect={(sessionId) => {
				hostPluginPageTab?.onClose();
				workspaceChrome.selectTab(sessionId);
			}}
			sessionActions={tabsSessionActions}
			contextSessionActions={buildTabsSessionActions}
			toolActions={sessionToolActions}
			editorTabs={simpleMode ? [] : workbenchEditorTabs}
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
			editorTabs={editorTabs}
			onDirty={promotePreviewEditorTab}
			gitDiff={workbenchHasGitDiff && gitDrawerDiff ? gitDrawerDiff : null}
			gitDiffDisplayMode={simpleMode ? workbenchLayout : gitDiffDisplayMode}
			onToggleGitDiffMode={simpleMode ? toggleSimpleContent : toggleGitDiffDisplayMode}
			onCloseGitDiff={simpleMode ? dismissGitDiff : closeGitDiff}
			activeTab={activeTab}
			editorMode={simpleMode ? workbenchLayout : editorMode}
			onToggleEditorMode={simpleMode ? toggleSimpleContent : activeTab?.preserveDrawer ? undefined : toggleEditorMode}
			onCloseEditor={() => {
				if (simpleMode && activeTab) closeEditorTab(activeTab.id);
				else closeEditor();
			}}
			readContent={readEditorFileContent}
			readOriginalContent={readEditorOriginalContent}
			saveContent={saveEditorFileContent}
		/>
	) : null;

	const chatPaneContentNode = (
		<WorkbenchStage
			simple={simpleMode}
			contentChrome={<WorkbenchFileTabs tabs={workbenchEditorTabs} onSelect={selectWorkbenchTab} onClose={closeWorkbenchTab} onPromote={promotePreviewEditorTab} />}
			chrome={sessionTabsBarNode}
			layout={workbenchLayout}
			hasContent={workbenchHasContent}
			// 插件页面式面板：以工作区会话列上的非模态覆盖层呈现（presentation:"page"），
			// 会话树保持挂载，关闭覆盖层即原样还原（滚动/草稿/终端内存态不丢）。
			session={
				<div className="relative flex h-full min-h-0 min-w-0 flex-col">
					{chatPaneSessionNode}
					<HostPluginPageOverlay projectId={activeProject?.id} sessionId={currentSessionId} />
				</div>
			}
			content={workbenchContentNode}
			onContentWidthChange={handleWorkbenchContentWidth}
		/>
	);

	// ── DrawerSurface port objects (stable via useMemo) ──
	const drawerPorts = useDrawerPorts({
		enableGitManagement: settings.enableGitManagement,
		activeProjectId,
		gitDiffDisplayMode,
		openCommitFileDiff,
		openWorkspaceFileDiff,
		toggleGitDiffDisplayMode,
		closeGitDiff,
		dismissGitDiff,
		gitApi: api.git,
		gitInfo,
		switchBranch,
		createBranch,
		openDrawer: workspace.openDrawer,
		closeDrawer: workspace.closeDrawer,
		collapseDrawer: workspace.collapseDrawer,
		closeBrowser: () => workspace.closeBrowser(),
		minimizeBrowser: () => workspace.minimizeBrowser(),
		enterBrowserFullscreen: () => workspace.enterBrowserFullscreen(),
		browserFullscreen,
		rpcLogAgentId: workspace.rpcLogAgentId,
		rpcLogListLogs: sidebarActions.rpc.listLogs,
		rpcLogGetLogging: sidebarActions.rpc.getLogging,
		rpcLogSetLogging: sidebarActions.rpc.setLogging,
		closeRpcLogPanel: workspace.closeRpcLogPanel,
		sessionsProject,
		sessionsProjectId,
		files,
		sessions,
		sessionSourceFilter,
		sessionHistoryLoading,
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
		runCopySession,
		runExportHistorySession,
		runDeleteHistorySession,
		viewFilePath,
		openFilePath,
		openEditorTab,
		api,
		t,
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
				void api.files
					.copy(paths, targetDir)
					.then(() => {
						void refreshVisibleFiles();
						showToast(t("app.fileCopyDone", { count: paths.length }), 2000);
					})
					.catch((error) => {
						showToast(error instanceof Error ? error.message : String(error), 4000);
					});
			}
		},
		onPasteFiles: (targetDir) => {
			// 粘贴：从系统剪贴板读取资源管理器复制的文件路径，复制到目标目录
			try {
				const paths = api.files.getClipboardPaths();
				if (paths.length > 0) {
					void api.files
						.copy(paths, targetDir)
						.then(() => {
							void refreshVisibleFiles();
							showToast(t("app.fileCopyDone", { count: paths.length }), 2000);
						})
						.catch((error) => {
							showToast(t("app.filePasteFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
						});
				}
			} catch {
				/* 剪贴板不可用 */
			}
		},
		onMoveFiles: (sourcePaths, targetDir) => {
			// 文件树内部拖拽移动：同设备 rename，跨设备 cp+rm
			void api.files
				.move(sourcePaths, targetDir)
				.then(() => {
					void refreshVisibleFiles();
					showToast(t("app.fileMoveDone", { count: sourcePaths.length }), 2000);
				})
				.catch((error) => {
					showToast(error instanceof Error ? error.message : String(error), 4000);
				});
		},
	});

	return (
		// 非会话静态区域使用当前焦点作为兜底；每个 SessionRuntimeInjector 会用本栏 cwd/project 覆盖。
		<FileLinkBaseProvider baseDir={activeAgent?.cwd ?? activeProject?.path} projectId={activeProject?.id} projectRoot={activeProject?.path} sessionId={currentSessionId}>
			<>
				<AppBootstrap {...bootstrapProps} />
				<AppShell
					navigationChrome={
						simpleMode ? (
							<div className="simple-navigation-bar flex h-8 shrink-0 items-center gap-0.5 bg-(--simple-shell-surface) px-2 [&_button]:[-webkit-app-region:no-drag]">
								<Button variant="ghost" size="icon-sm" className="size-6.5" type="button" aria-label={listCollapsed ? t("app.expandList") : t("app.collapseList")} title={listCollapsed ? t("app.expandList") : t("app.collapseList")} onClick={toggleListCollapsed}>
									<PanelLeft size={14} />
								</Button>
								<Button variant="ghost" size="icon-sm" className="size-6.5" type="button" aria-label={t("navigation.back")} title={t("navigation.back")} disabled={!navigation.canBack} onClick={navigation.back}>
									<ArrowLeft size={14} />
								</Button>
								<Button variant="ghost" size="icon-sm" className="size-6.5" type="button" aria-label={t("navigation.forward")} title={t("navigation.forward")} disabled={!navigation.canForward} onClick={navigation.forward}>
									<ArrowRight size={14} />
								</Button>
							</div>
						) : undefined
					}
					compactContent={
						// 极简浮窗模式：渲染当前活跃会话（不是 quickTask）
						new URLSearchParams(window.location.search).get("mini-overlay") === "1" ? (
							<MiniOverlaySurface
								activeProjectId={activeProjectId}
								onCreateSession={createSessionDraftWithTab}
								onOpenSession={openSidebarSessionByIdWithTab}
								onSwitchToQuickTask={() => {
									const projectPath = currentSession ? projects.find((item) => item.id === currentSession.projectId)?.path : undefined;
									void api.miniOverlay.switchToQuickTask(projectPath).catch(() => showToast(t("miniOverlay.windowActionFailed"), 4000, "error"));
								}}
							>
								{currentSession ? (
									<SessionPaneServicesProvider value={sessionPaneServices}>
										<ChatSessionPane sessionId={currentSession.id} focused onFocusPane={() => focusSessionPane(currentSession.id)} splitPane={false} />
									</SessionPaneServicesProvider>
								) : null}
							</MiniOverlaySurface>
						) : quickTask.active ? (
							<QuickTaskSurface task={quickTask}>
								<SessionPaneServicesProvider value={sessionPaneServices}>{quickTask.session && <ChatSessionPane sessionId={quickTask.session.id} focused onFocusPane={() => focusSessionPane(quickTask.session!.id)} splitPane={false} />}</SessionPaneServicesProvider>
							</QuickTaskSurface>
						) : undefined
					}
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
							addLabel={t("drawer.addPanel")}
							actions={[
								{
									id: "files",
									label: t("app.files"),
									icon: <FolderOpen size={16} />,
									active: drawer === "files",
									pinned: true,
									onClick: () => handleToolDrawerAction("files"),
								},
								// 编辑器入口已迁到分屏（SessionTabsBar），右侧抽屉不再提供 editor 面板
								// Git 面板受设置开关与项目上下文双重门控，与 outline 入口保持一致
								...(settings.enableGitManagement && activeProjectId
									? [
											{
												id: "git",
												label: t("drawer.sourceControl"),
												icon: <GitBranch size={16} />,
												active: drawer === "git",
												pinned: true,
												onClick: () => handleToolDrawerAction("git"),
											},
										]
									: []),
								// 轨迹固定在内置浏览器前面：有 Git 时是第 3 个（files / git / trajectory / browser）。
								{
									id: "trajectory",
									label: t("session.view.trajectory"),
									icon: <Activity size={16} />,
									active: drawer === "trajectory",
									pinned: workspace.pinnedPanels.includes("trajectory"),
									canRemove: true,
									onTogglePinned: () => workspace.toggleDrawerPanelPinned("trajectory"),
									onClick: () => handleToolDrawerAction("trajectory"),
								},
								// 分支树面板：与检查点同口径仅 pi 后端展示；条目树是 pi 会话文件的概念。
								...(rewindSupported
									? [
											{
												id: "branchTree" as const,
												label: t("session.branchTree.title"),
												// 图标用 ListTree 而不是 GitFork：活动栏里 Git 面板已经是 GitBranch，两个 git 系图标并排会认错「分支」入口。
												icon: <ListTree size={16} />,
												active: drawer === "branchTree",
												pinned: workspace.pinnedPanels.includes("branchTree"),
												canRemove: true,
												onTogglePinned: () => workspace.toggleDrawerPanelPinned("branchTree"),
												onClick: () => handleToolDrawerAction("branchTree"),
											},
										]
									: []),
								// 检查点面板：仅当前会话为 pi 后端时展示（rewind 能力；dsh 暂不声明）。
								...(rewindSupported
									? [
											{
												id: "rewind" as const,
												label: t("rewind.title"),
												icon: <History size={16} />,
												active: drawer === "rewind",
												pinned: workspace.pinnedPanels.includes("rewind"),
												canRemove: true,
												onTogglePinned: () => workspace.toggleDrawerPanelPinned("rewind"),
												onClick: () => handleToolDrawerAction("rewind"),
											},
										]
									: []),
								{
									id: "browser",
									label: t("app.browser"),
									icon: <Globe size={16} />,
									active: drawer === "browser",
									pinned: workspace.pinnedPanels.includes("browser"),
									canRemove: true,
									onTogglePinned: () => workspace.toggleDrawerPanelPinned("browser"),
									onClick: () => handleToolDrawerAction("browser"),
								},
								{
									id: "scratchPad",
									label: t("scratchPad.title"),
									icon: <Pencil size={16} />,
									active: scratchPad.isOpen,
									onClick: scratchPad.toggle,
								},
								// RPC 日志专属 Tab：默认隐藏，任一存活的 agent 开启记录后才出现
								//（门控与目标 agent 计算见 rpcLogTabTargetAgentId）。
								...(rpcLogTabTargetAgentId
									? [
											{
												id: "rpcLog",
												label: t("drawer.rpcLog"),
												icon: <ScrollText size={16} />,
												active: drawer === "rpcLog",
												onClick: () => {
													// rpcLog 面板必须绑定 agentId（无 id 的 openDrawer("rpcLog") 会渲染空面板）：
													// 已展开则点击关闭走还原语义（回到日志打开前的面板），否则切到目标 agent 的日志。
													if (workspace.drawer === "rpcLog" && !workspace.drawerCollapsed) workspace.closeRpcLogPanel();
													else workspace.openRpcLogPanel(rpcLogTabTargetAgentId);
												},
											},
										]
									: []),
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
							rpcLog={drawerPorts.rpcLog}
							scratchPad={scratchPad}
							branchTree={{ forkAtEntry: (entryId, fallbackText) => void forkAtEntry(entryId, fallbackText, `branch:${entryId}`) }}
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
										void api.files
											.copy(paths, targetDir)
											.then(() => {
												void refreshVisibleFiles();
												showToast(t("app.fileCopyDone", { count: paths.length }), 2000);
											})
											.catch((error) => {
												showToast(t("app.filePasteFailed", { error: error instanceof Error ? error.message : String(error) }), 4000);
											});
									}
								} catch {
									/* 剪贴板不可用 */
								}
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
								// 与文件树拖拽共用同一引用格式：目录补尾斜杠（@dir/），含空格路径自动加引号。
								// 走 composer-attach-refs 事件插入，避免这里再维护一份 @path 拼接逻辑
								// （裸 @dir 过不了 chip 路径规则，模型也容易当成 mention）。
								window.dispatchEvent(
									new CustomEvent("composer-attach-refs", {
										detail: {
											refs: [
												fileNodeDragPayloadToRef({
													path: fileMenu.node.path,
													relativePath: fileMenu.node.relativePath,
													type: fileMenu.node.type,
												}),
											],
										},
									}),
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
									message: node.type === "directory" ? t("drawer.deleteFolderConfirm", { name: node.name }) : t("drawer.deleteFileConfirm", { name: node.name }),
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
											showToast(
												t("app.fileDeleteFailed", {
													error: String(error instanceof Error ? error.message : error).replace(/^Error:\s*/, ""),
												}),
												5000,
												"error",
											);
										}
									},
								});
							}}
						/>
					)}

					{projectResourcesProject && (
						<Suspense fallback={null}>
							<ProjectResourcesModal project={projectResourcesProject} onClose={() => setProjectResourcesProject(null)} />
						</Suspense>
					)}
					<RenameModals
						rename={rename.renameModalsProps.rename}
						fileRename={
							renamingFile
								? {
										path: renamingFile.path,
										name: renamingFile.name,
										inputValue: renamingFileInput,
										onInputChange: setRenamingFileInput,
										onClose: () => setRenamingFile(null),
										onConfirm: (path, newName) => {
											void api.files
												.rename(path, newName)
												.then(() => {
													void refreshVisibleFiles();
													setRenamingFile(null);
													showToast(t("app.fileRenamed"), 2000);
												})
												.catch((err) => console.error("[File] rename failed:", err));
										},
									}
								: undefined
						}
					/>

					{/* old conditional wrapping — replaced by EnvironmentOverlay open prop below */}
					<EnvironmentOverlay open={environmentDialog}>
						<EnvironmentDialog
							status={piStatus}
							checking={piChecking}
							guide={piGuide}
							onClose={() => {
								setEnvironmentDialog(false);
								piUpdate.setCustomPathResult(null);
								// 关闭时重置安装状态
								piUpdate.setInstallResult(null);
								piUpdate.setInstallCompleted(false);
								piUpdate.setNpmAvailable(null);
								// 引导面板的一次性状态同样重置，下次打开重新检测
								piGuide.resetGuide();
							}}
							onRecheck={() => {
								piUpdate.setCustomPathResult(null);
								piUpdate.setNpmAvailable(null);
								piUpdate.setNpmVersion(undefined);
								piUpdate.setInstallResult(null);
								piUpdate.setInstallCompleted(false);
								piUpdate.setInstallUseMirror(false);
								// 引导步骤在重新检测后需要刷新（安装结果可能已让环境就绪）
								void piGuide.checkNode();
								piUpdate.checkPiInstall("manual");
							}}
							onOpenInstallDocs={() => api.app.openExternal("https://pi.dev/docs/latest/quickstart#install")}
							installations={piUpdate.piInstallations ?? []}
							applyingInstallationPath={piUpdate.applyingInstallationPath}
							onChooseInstallation={(path) => void piUpdate.choosePiInstallation(path)}
							onShellProbeInstallations={() => void piUpdate.loadPiInstallations({ forceShellProbe: true })}
							shellProbingInstallations={piUpdate.piInstallationsProbing}
							onBrowsePiPath={() => void piUpdate.browsePiPath()}
							browsingPiPath={piUpdate.browsingPiPath}
							customPath={piUpdate.customPiPath}
							customPathValidating={piUpdate.customPathValidating}
							customPathResult={piUpdate.customPathResult}
							onCustomPathChange={(path) => {
								piUpdate.setCustomPiPath(path);
								piUpdate.setCustomPathResult(null);
							}}
							onValidateCustomPath={() => piUpdate.validateCustomPiPath({ closeDialogOnSuccess: true })}
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
										piUpdate.setInstallCommand((cmd) => cmd.replace(/\s+--registry=https:\/\/registry\.npmmirror\.com/g, ""));
									} else {
										piUpdate.setInstallCommand((cmd) => (cmd.includes("--registry=") ? cmd : cmd + " --registry=https://registry.npmmirror.com"));
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
					<SettingsFeatureRoot settings={settings} piUpdate={piUpdate} webServiceChanging={webServiceChanging} onRestartWebService={restartWebService} appInfo={appInfo} onChange={updateSettings} projects={projects} projectId={activeProject?.id} projectKind={activeProject?.kind} projectName={activeProject?.name} />
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
					{previewImage && <ImagePreviewModal image={previewImage} onClose={() => setPreviewImage(null)} />}
					{/* 项目外文件链接二次确认（安全等级：敏感文件 / 限定目录 / 配置不可读时才弹） */}
					{externalPathOpenDialog}
					{/* 会话代理设置：侧栏菜单与 Tab 栏 ⋯ 菜单共用的宿主（同一弹框实例） */}
					{proxyDialogSessionId && <SessionProxyDialog sessionId={proxyDialogSessionId} onClose={() => setProxyDialogSessionId(null)} />}
					{codexImportProject && <ImportOverlayHost kind="codex" project={codexImportProject} controller={codexImportController} onClose={() => setCodexImportProject(null)} />}
					{claudeImportProject && <ImportOverlayHost kind="claude" project={claudeImportProject} controller={claudeImportController} onClose={() => setClaudeImportProject(null)} />}
					{qoderImportProject && <ImportOverlayHost kind="qoder" project={qoderImportProject} controller={qoderImportController} onClose={() => setQoderImportProject(null)} />}
					{openCodeImportProject && <ImportOverlayHost kind="opencode" project={openCodeImportProject} controller={openCodeImportController} onClose={() => setOpenCodeImportProject(null)} />}
					{zcodeImportProject && <ImportOverlayHost kind="zcode" project={zcodeImportProject} controller={zcodeImportController} onClose={() => setZcodeImportProject(null)} />}
					{workbuddyImportProject && <ImportOverlayHost kind="workbuddy" project={workbuddyImportProject} controller={workbuddyImportController} onClose={() => setWorkbuddyImportProject(null)} />}
					{cursorImportProject && <ImportOverlayHost kind="cursor" project={cursorImportProject} controller={cursorImportController} onClose={() => setCursorImportProject(null)} />}
					{kimiImportProject && <ImportOverlayHost kind="kimi" project={kimiImportProject} controller={kimiImportController} onClose={() => setKimiImportProject(null)} />}
					{kimiWorkImportProject && <ImportOverlayHost kind="kimiwork" project={kimiWorkImportProject} controller={kimiWorkImportController} onClose={() => setKimiWorkImportProject(null)} />}
					{minimaxImportProject && <ImportOverlayHost kind="minimax" project={minimaxImportProject} controller={minimaxImportController} onClose={() => setMinimaxImportProject(null)} />}
					{directoryImportProject && <ImportOverlayHost kind="directory" project={directoryImportProject} controller={directoryImportController} onClose={() => setDirectoryImportProject(null)} />}

					{/* 定时任务与自动化管理中心全功能弹窗（模态呈现，不覆盖会话工作区） */}
					<AutomationModal
						onViewSession={(projectId, sessionId) => {
							void openSidebarSessionByIdWithTab(projectId, sessionId, "permanent");
						}}
					/>

					{/* 并行问询结果弹框（AskPanel）：独立匿名会话的结果展示，根级渲染 */}
					<AskPanelOverlay />
					<HostPluginPanelHost projectId={activeProject?.id} sessionId={currentSessionId} />

					{/* toast 通知历史：全渲染层唯一一份（设置页/详情弹窗两个入口共用，
					    模块级 opener 注册式打开，见 utils/noticeHistory + ui-shadcn/notice-history-dialog） */}
					<NoticeHistoryDialog />

					{/* 外部编辑器选择气泡 */}
					<ExternalEditorOverlay
						open={editorsOpen}
						editors={externalEditors}
						anchor={editorsAnchor}
						projectPath={editorsTargetPath}
						onClose={() => workspace.closeExternalEditorChooser()}
						onOpenProject={(editor, path) => workspace.openProjectInExternalEditor(editor)}
						onError={(error) => showToast(t("app.openEditorFailed", { error: String(error) }), 3000)}
					/>
				</AppShell>

				{/* 命令面板（Ctrl/Cmd+P）：模糊搜索设置项并跳转 + 执行操作，根级渲染 */}
				<CommandPalette open={commandPaletteOpen} onOpenChange={setCommandPaletteOpen} commands={commandPaletteCommands} placeholder={t("command.placeholder")} emptyMessage={t("command.empty")} />

				{/* 命令面板首次引导：它是纯键盘入口，没有任何可点的 affordance，
        不主动提示就等于不存在。看完即写 localStorage，只弹一次。
        空状态（没项目）不弹——那时面板本身也没什么可搜的。 */}
				{!quickTask.active && <CommandPaletteOnboarding enabled={Boolean(activeProjectId) && !commandPaletteOpen} onTryNow={openCommandPalette} />}

				{/* 数据环境弹窗族：首启数据模式选择（内含导入向导）与目录标记警告，事件/atom 驱动 */}
				<DataModeChoiceDialog />
				<DataEnvMismatchDialog />

				{/* CUA 操作审批弹框：pi Agent 注入鼠标/键盘前的用户确认（事件驱动，根级渲染） */}
				<CuaApprovalDialog request={cuaApproval.request} pendingCount={cuaApproval.pendingCount} responding={cuaApproval.responding} open={cuaApproval.open} onOpenChange={cuaApproval.setOpen} onRespond={(allowed) => void cuaApproval.respond(allowed)} onCancel={cuaApproval.cancel} />
			</>
		</FileLinkBaseProvider>
	);
}

// test
