import { Button } from "./components/ui-shadcn/button";
import { WorkbenchFileTabs } from "./components/workspace/WorkbenchFileTabs";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from "react";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { toggleThemeMode } from "./themeAppearance";
import { DURATION_SLOW_MS, EASE_OUT_QUINT_CSS } from "./lib/motionTokens";
import { configureNoticeDefaults, showNotice, type NoticeKind } from "./utils/notice";
import { copyTextWithCopiedNotice } from "./utils/clipboardNotice";
import { buildSettingsCommands, type PaletteCommand } from "./utils/commandPaletteCommands";
import { desktopApi as api, isLanWeb, missingElectronPreload } from "./desktopApi";
import {
	turnFlowSettingsAtom,
	defaultAgentBackendAtom,
	effectiveAgentBackendAtom,
	busySendDeliveryAtom,
	scrollToLatestOnSendAtom,
	hiddenModulesAtom,
	openAgentMarketPageAtom,
	openFavoritesPageAtom,
	favoritesOpenSessionRequestAtom,
	hiddenComposerFeaturesAtom,
	imageGenConfigAtom,
	enhanceModelAtom,
	enhanceIncludeContextAtom,
	promptSuggestionEnabledAtom,
	promptSuggestionModelAtom,
	dshRuntimeStatusAtom,
	openSettingsAtom,
	settingsOpenAtom,
	openAutomationPageAtom,
	activeWorkspacePageAtom,
	openWorkspacePageIdsAtom,
	openWorkspacePageAtom,
	deactivateWorkspacePageAtom,
	closeWorkspacePageAtom,
	bumpNewTurnCollapseTickAtom,
	rpcLoggingAgentIdsAtom,
	toggleRpcLoggingAgent,
} from "./atoms";
import { type SidebarActions } from "./components/sidebar/SidebarContent";
import { AppSidebar } from "./components/sidebar/AppSidebar";
import { SettingsFeatureRoot } from "./components/app/SettingsFeatureRoot";
import { hostPluginPanelAtom } from "./atoms/host-plugin-atoms";
import { AutomationPage } from "./components/automation/AutomationPage";
import { AgentMarketPage } from "./components/agents/AgentMarketPage";
import { FavoritesPage } from "./components/favorites/FavoritesPage";
import { useRename } from "./hooks/useRename";
import { useProjectRuntimeCapabilities } from "./hooks/useRuntimeCapabilities";
import { useSessionRuntimeBridge } from "./hooks/useSessionRuntimeBridge";
import { useAgentLoadNotice } from "./hooks/useAgentLoadNotice";
import { useArchMismatchNotice } from "./hooks/useArchMismatchNotice";
import { useAnnouncementNotifier } from "./hooks/useAnnouncementNotifier";
import { useStarReminder } from "./hooks/useStarReminder";
import { useModelsVerifyNotifier } from "./hooks/useModelsVerifyNotifier";
import { useBackgroundAskPatrol } from "./hooks/useBackgroundAskPatrol";
import { openProviderLoginAtom } from "./atoms/providerLoginAtoms";
import { wslProjectPickerAtom } from "./atoms/wsl-project-atoms";
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
import { useComposerStateSessionPrune } from "./hooks/useComposerStateSessionPrune";
import { useStoppedSessionCacheTrim } from "./hooks/useStoppedSessionCacheTrim";
import { activeAgentIdAtom } from "./hooks/useSessionRuntimeController";
import { useUserMessageEditReplay } from "./hooks/useUserMessageEditReplay";
import { isLiveRuntimeStatus } from "./utils/sessionCommands";
import { useAppAppearance } from "./hooks/appearance/useAppAppearance";
import { useAppBootstrapInfo } from "./hooks/app/useAppBootstrapInfo";
import { useBootOverlayReady } from "./hooks/app/useBootOverlayReady";
import { useCommandPalette } from "./hooks/app/useCommandPalette";
import { useAppProjectActions } from "./hooks/app/useAppProjectActions";
import { useAppSidebarActions } from "./hooks/app/useAppSidebarActions";
import { useSessionTabsAssembly } from "./hooks/app/useSessionTabsAssembly";
import { useAppSessionPaneServices } from "./hooks/app/useAppSessionPaneServices";
import { useAppFileTreeTransfer } from "./hooks/app/useAppFileTreeTransfer";
import { useAppSessionCreation } from "./hooks/app/useAppSessionCreation";
import { useAppActiveProjectSync } from "./hooks/app/useAppActiveProjectSync";
import { useAppSessionEntrypoints } from "./hooks/app/useAppSessionEntrypoints";
import { useAppStartupWiring } from "./hooks/app/useAppStartupWiring";
import { useAppSettingsMirrors } from "./hooks/app/useAppSettingsMirrors";
import { useAppGitBranchActions } from "./hooks/app/useAppGitBranchActions";
import { useAppProjectScanEffects } from "./hooks/app/useAppProjectScanEffects";
import { useAppHistoryMutations } from "./hooks/app/useAppHistoryMutations";
import { useSidebarArchiveActions } from "./hooks/sidebar/useSidebarArchiveActions";
import { useSettingsUpdater } from "./hooks/settings/useSettingsUpdater";
import { useTpsDisplayMode } from "./hooks/settings/useTpsDisplayMode";
import { useSendShortcut } from "./hooks/settings/useSendShortcut";
import { useSessionRunControl } from "./hooks/session/useSessionRunControl";
import { useCloseSessionTabShortcut } from "./hooks/useCloseSessionTabShortcut";
import { useProjectFileTreeController } from "./hooks/files/useProjectFileTreeController";
import { useProjectServices } from "./hooks/useProjectServices";
import { useSessionDurationTracking } from "./hooks/session/useSessionDurationTracking";
import { useSessionPromptDispatch } from "./hooks/session/useSessionPromptDispatch";

import { usePiUpdate } from "./hooks/usePiUpdate";
import { useProviderUsageStartupWarmup } from "./hooks/useProviderUsage";

import { useBackgroundUpdateWatch } from "./hooks/useBackgroundUpdateWatch";
import { useChannelSwitchWatch } from "./hooks/useChannelSwitchWatch";
import { useDataEnvWatch } from "./hooks/useDataEnvWatch";
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
	requestSidebarRevealProjectAtom,
	replaceProjectInventoryAtom,
	replaceProjectSessionsAtom,
	sessionStatusInSidebarAtom,
	sessionRecordByIdAtomFamily,
	sessionRecordsByProjectIdAtomFamily,
	sessionIdByRuntimeAgentIdAtomFamily,
	sessionRuntimeBySessionIdAtomFamily,
	sidebarExpandedProjectIdsAtom,
	compactMiddlePackagesAtom,
	sessionSummariesByProjectIdAtomFamily,
	modifiedFilesAtom,
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
	sessionRuntimeByIdAtom,
} from "./atoms";
import { isSameSessionPath } from "./agentListDisplay";
import { t } from "./i18n";
import { isChatProject, loadSessionSourceFilter, saveSessionSourceFilter, isReplacementForPendingAgent, stampIdleSessionDuration, type PendingAgentTab } from "./rendererUtils";
import { isLocalProject, isRemoteProject } from "../../shared/projectLocation";
import type { SessionFilterPill } from "./sessionFilterPills";
import { useResize } from "./hooks/useResize";
import { ARCHIVED_SESSION_TOAST_MS, archivedSessionToastMessage, useSessionActions } from "./hooks/useSessionActions";
import { useScratchPad } from "./hooks/useScratchPad";
import { useDshRuntimeStatusSync } from "./hooks/useDshRuntimeStatusSync";
import { useAutoDefaultAgentBackend } from "./hooks/useAutoDefaultAgentBackend";
import { useDshRuntimeMigrationNotice } from "./hooks/useDshRuntimeMigrationNotice";
import { useDshRuntimeInstallProgressSync } from "./hooks/useDshRuntimeInstallProgressSync";
import { useWorktreeActions } from "./hooks/useWorktreeActions";
import { ChatSessionPane } from "./components/session/ChatSessionPane";
import { SessionSplitStage } from "./components/session/SessionSplitStage";
import { splitLayoutSessionIds } from "./utils/sessionSplitEdge";
import { flattenFiles } from "./components/app/AppUtils";
import { SessionTabsBar } from "./components/session/SessionTabsBar";
import { SessionPaneServicesProvider, type SessionFileOpenContext } from "./components/session/SessionPaneServices";
import { ProjectEmptyState } from "./components/session/ProjectEmptyState";
import { useSessionWorkspaceChrome } from "./hooks/useSessionWorkspaceChrome";
import { useSessionIdAliasMigration } from "./hooks/useSessionIdAliasMigration";
import { useQuickTask } from "./hooks/useQuickTask";
import { useSideTasks } from "./hooks/useSideTasks";
import { HostPluginPageOverlay } from "./components/plugins/HostPluginPageOverlay";
import { useHostPluginPageTab } from "./hooks/useHostPluginPageTab";
import { TerminalDockPanel } from "./components/terminal/TerminalDockPanel";
import { ResizablePanel, ResizablePanelGroup } from "./components/ui-shadcn/resizable";
import { WorkbenchStage } from "./components/workspace/WorkbenchStage";
import { WorkbenchContent } from "./components/workspace/WorkbenchContent";
import { useCuaApproval } from "./components/overlays/CuaApprovalDialog";
import { WorkbenchAppOverlays } from "./components/workbench/WorkbenchAppOverlays";
import { WorkbenchDialogs } from "./components/workbench/WorkbenchDialogs";
import { WorkbenchFileOverlays } from "./components/workbench/WorkbenchFileOverlays";
import { WorkbenchShell } from "./components/workbench/WorkbenchShell";

import { usePiEnvironmentGuide } from "./hooks/usePiEnvironmentGuide";
import { navigateTo } from "./components/app/BrowserPanel";
import { createDefaultAppSettings } from "../../shared/types";
import { parseSessionStatusPlacement, placementShowsSidebarPanel } from "../../shared/sessionStatusPlacement";
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
	ProjectFileTarget,
	AgentBackend,
	SessionRecord,
	SessionSummary,
	ComposerAgentMode,
	TerminalTarget,
	TerminalThemeId,
	GitBranchInfo,
	FocusTargetPayload,
	ScratchPadScope,
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
	// Streaming subscriptions are in SessionRuntimeInjector. 修改文件清单走内容稳定投影 atom，
	// 消息 flush 不改变清单内容时不会叫醒 App 根（否则文件抽屉等大树每 50ms 全量重渲）。
	const modifiedFiles = useAtomValue(modifiedFilesAtom);
	const projects = useAtomValue(projectInventoryAtom);
	const agents = useAtomValue(agentInventoryAtom);
	// 设置页是整列页面 Tab：它会盖住欢迎页/会话列，首次引导不能叠在它上面。
	const settingsPageActive = useAtomValue(settingsOpenAtom);
	const setCurrentSessionId = useSetAtom(currentSessionIdAtom);
	const replaceProjectSessions = useSetAtom(replaceProjectSessionsAtom);
	const openAutomationPage = useSetAtom(openAutomationPageAtom);
	const openAgentMarketPage = useSetAtom(openAgentMarketPageAtom);
	const openFavoritesPage = useSetAtom(openFavoritesPageAtom);
	const favoritesOpenSessionRequest = useAtomValue(favoritesOpenSessionRequestAtom);
	const setFavoritesOpenSessionRequest = useSetAtom(favoritesOpenSessionRequestAtom);
	// 页面式工作区（定时任务 / 智能体）：Tab 列表与当前呈现页面；切会话只失活、关闭才卸载。
	const openWorkspacePageIds = useAtomValue(openWorkspacePageIdsAtom);
	const activeWorkspacePage = useAtomValue(activeWorkspacePageAtom);
	const openWorkspacePage = useSetAtom(openWorkspacePageAtom);
	const deactivateWorkspacePage = useSetAtom(deactivateWorkspacePageAtom);
	const closeWorkspacePage = useSetAtom(closeWorkspacePageAtom);
	// 设置页的「关闭请求」出口：页面内持有内存草稿，Tab 栏的关闭叉必须先问它（未保存确认），
	// 确认后才真正关 Tab。页面组件挂载时写入、卸载时置空（用 ref 而非 atom：函数值走 atom 会被当成更新器）。
	const settingsCloseRequestRef = useRef<(() => void) | null>(null);
	// 页面式插件面板与工作区页面共用会话列覆盖层：两者同时呈现会互相盖住，打开页面时收起插件页。
	const hostPluginPanel = useAtomValue(hostPluginPanelAtom);
	const setHostPluginPanel = useSetAtom(hostPluginPanelAtom);
	// `/login`：打开供应商登录弹框（弹框自己从 atom 取预选供应商）。
	const openProviderLogin = useSetAtom(openProviderLoginAtom);
	// WSL 模式下的「添加项目」：写开关即打开内置目录选择器（系统对话框读不到发行版内目录）。
	const setWslProjectPicker = useSetAtom(wslProjectPickerAtom);
	// 新建项目后请侧栏把新行揭示出来（切项目分段 + 滚动定位）。
	const requestSidebarRevealProject = useSetAtom(requestSidebarRevealProjectAtom);
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
	const setEnhanceIncludeContext = useSetAtom(enhanceIncludeContextAtom);
	const setPromptSuggestionEnabled = useSetAtom(promptSuggestionEnabledAtom);
	const setPromptSuggestionModel = useSetAtom(promptSuggestionModelAtom);
	const currentSessionIdRef = useRef<string | undefined>(currentSessionId);
	currentSessionIdRef.current = currentSessionId;
	const openSessionRequestRef = useRef(0);
	const creatingSessionDraftRef = useRef<Set<string>>(new Set());
	// 每个项目在途的草稿创建（issue #481）：Tab 栏「+」/ 侧栏新建 与 引导页首发
	// 是两条独立入口，都会为同一项目建 draft。谁先发起谁落地，后到者复用同一条
	// 会话——否则多建出的那条没人写过，就是 Tab 栏里点不动的空标签。
	const pendingDraftCreationRef = useRef<Map<string, Promise<SessionRecord | undefined>>>(new Map());
	// 最近一条由「+」/侧栏新建落地的草稿：引导页输入框被它顶下去时，卸载前已排队的
	// 首次发送要落进这条会话，而不是再建一条空会话（issue #481 的另一半竞态）。
	const lastCreatedDraftIdRef = useRef<string | undefined>(undefined);
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
		target?: ProjectFileTarget;
		name: string;
	} | null>(null);
	const [renamingFileInput, setRenamingFileInput] = useState("");
	/** 文件树右键「新建文件/新建文件夹」：target 与「粘贴」同源（目录=自身、文件=父目录） */
	const [creatingFile, setCreatingFile] = useState<{
		target: string | ProjectFileTarget;
		kind: "file" | "directory";
	} | null>(null);
	const [creatingFileInput, setCreatingFileInput] = useState("");
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
	// 同一次拉取顺带同步 acpEnabled 快照：菜单组仅在开关开启时渲染（主进程在 create 边界同规则门控）。
	// 开关的后续变更由设置页开关直接回写 acpEnabledAtom，无需重启应用。
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
		fileTreeContentRevision,
		setFiles,
		gitInfo,
		setGitInfo,
		setSessionLoadingByProject,
		setVisibleProjectChildCountByProject,
		refreshProjects,
		refreshAllProjects,
		refreshWorktrees,
		refreshProjectSessions,
		refreshProjectTree,
		syncDshForeignSessionsIfEnabled,
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
				list: (project: string | ProjectFileTarget, options?: { maxDepth?: number; directory?: string }) => api.files.list(project, options),
			},
		},
		showToast,
		setSessionCatalogLoadState,
		t,
	});

	// refreshProjectSessions 由 useProjectSync 以普通函数返回，每次渲染都换引用。
	// 写进 effect deps 会让「catalog 加载失败 → 状态更新重渲染」再次触发自动重试，
	// 持久失败时形成无限扫描风暴。自动加载类 effect 经 ref 取最新实现，不随渲染重跑。
	const refreshProjectSessionsRef = useRef(refreshProjectSessions);
	refreshProjectSessionsRef.current = refreshProjectSessions;

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
	const importFlow = useImportFlow({
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
		scanCodeBuddySessions: api.codebuddySessions.scan,
		importCodeBuddySessionsApi: api.codebuddySessions.import,
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
	// 这里只取侧栏/空态要用的打开命令；弹窗本身挂在 AppOverlays，直接吃 importFlow 整组。
	const { openCodexImport, openClaudeImport, openQoderImport, openOpenCodeImport, openZCodeImport, openWorkBuddyImport, openCodeBuddyImport, openCursorImport, openKimiImport, openKimiWorkImport, openMinimaxImport } = importFlow;

	// === 外置目录会话导入（目录移动/改名后找回历史）===
	const directoryImport = useDirectoryImport({
		setProjectMenu: () => undefined,
		refreshProjectSessions,
		showToast,
	});
	// 只取入口命令；弹窗与项目/controller 整组下沉到 AppOverlays。
	const { open: openDirectoryImport } = directoryImport;

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

	// 「发送后自动回底」同步给时间线 controller（决策时刻读 atom，设置保存后下一次发送即生效）。
	const setScrollToLatestOnSend = useSetAtom(scrollToLatestOnSendAtom);
	useEffect(() => {
		setScrollToLatestOnSend(settings.scrollToLatestOnSend !== false);
	}, [settings.scrollToLatestOnSend, setScrollToLatestOnSend]);

	// 隐藏的功能模块同步给不持有 settings props 的消费方（ConfigModal Pi/DSH 分页、composer 后端下拉），
	// 与 defaultAgentBackend 同一模式。
	const setHiddenModules = useSetAtom(hiddenModulesAtom);
	useEffect(() => {
		setHiddenModules(settings.hiddenModules ?? []);
	}, [settings.hiddenModules, setHiddenModules]);

	// 隐藏的输入框功能入口同步给不持有 settings props 的消费方（ComposerBottomBar 的模式选择器），
	// 与 hiddenModules 同一模式。
	const setHiddenComposerFeatures = useSetAtom(hiddenComposerFeaturesAtom);
	useEffect(() => {
		setHiddenComposerFeatures(settings.hiddenComposerFeatures ?? []);
	}, [settings.hiddenComposerFeatures, setHiddenComposerFeatures]);

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
	// pi 环境引导（检测 Node/npm → 一键安装 → 重新检测）：弹窗打开时自动刷新环境状态，关闭时重置一次性状态。
	// 重新检测复用完整的环境检测（usePiUpdate），把 installed 回传给引导流程，
	// 由它决定面板是否切到「检测通过」——只有一处检测口径，避免两套判定漂移。
	const { checkPiInstall } = piUpdate;
	const recheckPiForGuide = useCallback(async () => {
		const status = await checkPiInstall("manual");
		return Boolean(status?.installed);
	}, [checkPiInstall]);
	// 依赖只取稳定的 checkNode/checkNpmForGuide（useCallback）；piGuide 对象每次渲染都是新引用，
	// 直接依赖会因内部 setState → 重渲染 → effect 重跑而形成检测循环。
	const piGuide = usePiEnvironmentGuide(api, recheckPiForGuide);
	const { checkNode: checkGuideNode, checkNpmForGuide: checkGuideNpm } = piGuide;
	useEffect(() => {
		if (!environmentDialog) return;
		// WSL 模式下 pi 由发行版提供：宿主机 Node/npm 的检测与引导面板无关（面板已换成 WSL 内的安装指令），不做无谓探测。
		if (settings.wslEnabled === true) return;
		void checkGuideNode();
		void checkGuideNpm();
	}, [environmentDialog, checkGuideNode, checkGuideNpm, settings.wslEnabled]);
	// 默认后端自动选择：没有手动选过时，只装了 DSH runtime（没有 pi）就用 dsh，否则 pi。
	// piInstalled 用实时检测优先、持久化缓存兜底：首次引导前 piStatus 还是 null。
	const dshRuntimeStatus = useAtomValue(dshRuntimeStatusAtom);
	useAutoDefaultAgentBackend({
		api,
		settings,
		setSettings,
		dshState: dshRuntimeStatus.state,
		// 环境检测完成前用持久化缓存顶一下（缓存只说明上次装过 pi），避免启动瞬间因 piStatus 为空误判成「只有 DSH」。
		piInstalled: piStatus ? piStatus.installed : Boolean(settings.piInstall),
	});
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
	const terminalProjectId = activeProjectId ?? currentSessionRecord?.projectId;
	const terminalOwner = resolveTerminalOwner(
		activeAgentId,
		terminalProjectId,
		projects.some((project) => project.id === terminalProjectId && isRemoteProject(project)),
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
	const queuedTrackRef = useRef<HTMLElement | null>(null);

	const composerTextareaRef = useRef<HTMLDivElement | null>(null);
	// RichInput 受控重渲染后,光标应恢复到的纯文本偏移(供建议选中/清除后恢复选区)。
	const pendingComposerCaretRef = useRef<number | null>(null);
	const pendingAgentsRef = useRef<PendingAgentTab[]>([]);

	// 项目文件树域（展开持久化/自愈/下钻/切换加载）收口到 useProjectFileTreeController。
	// 文件树是纯本机能力：远端项目没有本机 path，hook 需要据此跳过一切本地 files:list。
	// 本地树的数据入口同样走 ProjectServices（useProjectServices 支持 Project | undefined：
	// 没有活动项目时不建 runtime/subscription）。
	const activeProject = projects.find((project) => project.id === activeProjectId);
	const localFileTreeProject = activeProject !== undefined && isLocalProject(activeProject) ? activeProject : undefined;
	const localFileTreeServices = useProjectServices(localFileTreeProject);
	const isLocalProjectId = useCallback((projectId: string) => projects.some((project) => project.id === projectId && isLocalProject(project)), [projects]);
	const { expandedDirs, refreshVisibleFiles, restoreExpandedDirs, drillCompactChain, toggleDirectory, collapseAllDirectories } = useProjectFileTreeController({
		setFiles,
		activeProjectId,
		services: localFileTreeServices,
		isLocalProjectId,
		activeProjectMissing: activeProject?.missing === true,
		compactMiddlePackagesEnabled,
		agentsRef,
		refreshProjects,
		showToast,
	});

	// 草稿本作用域：项目模式按当前项目分桶（activeProjectId 未同步时用会话所属项目兜底，
	// 与终端 owner 同口径）；没有项目时回落全局。全局模式永远只有一份。
	const scratchPadProjectId = activeProjectId ?? currentSessionRecord?.projectId;
	const scratchPadScope: ScratchPadScope = settings.scratchPadScope === "project" && scratchPadProjectId ? { kind: "project", projectId: scratchPadProjectId } : { kind: "global" };
	const scratchPad = useScratchPad({ ...workspace, scope: scratchPadScope });
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
	// 远端项目没有本机路径：本地文件树/Git/会话扫描一律不得对它触发（各 IPC 也已按 locator 拒绝）。
	const activeProjectIsRemote = activeProject !== undefined && isRemoteProject(activeProject);
	const overlays = useOverlayActions({ activeProject, appInfo, showToast });
	const sessionsProject = projects.find((project) => project.id === sessionsProjectId);
	const displayAgents = useMemo(() => {
		const realIds = new Set(agents.map((agent) => agent.id));
		return [...agents, ...pendingAgents.filter((agent) => !realIds.has(agent.id) && !agents.some((realAgent) => isReplacementForPendingAgent(realAgent, agent)))];
	}, [agents, pendingAgents]);

	// === worktree actions hook ===
	const { worktreeCreating, removingWorktreeProjectIds, createWorktree, removeWorktree, requestRemoveWorktree, toggleProjectWorktree } = useWorktreeActions({
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
	// composer 域 per-session 状态（草稿/引用全文仓/发送态等）的外部删除清理，
	// 与 queue 同一所有权模式：records+runtime 双双消失才回收，引导页虚拟会话豁免。
	useComposerStateSessionPrune(store);
	// 运行时已停止的会话离开视野（切走 / 关 Tab）后立刻回收消息缓存（#519）。
	useStoppedSessionCacheTrim(store);
	useSessionRuntimeBridge({
		// 「停止响应较慢」→ 重启会话：会杀掉当前 pi 进程重建（丢正在跑的那一轮），
		// 因此走 overlays 确认框，和 Tab ⋯ 菜单的「重启进程」同一份文案与判定。
		onRestartSessionRuntime: (sessionId) => {
			const runtime = store.get(sessionRuntimeByIdAtom)[sessionId];
			if (!runtime?.agentId) return;
			overlays.showConfirm({
				title: t("runControl.restartRunningTitle"),
				message: t("runControl.restartRunningBody"),
				confirmLabel: t("app.restart"),
				onConfirm: () => {
					overlays.clearConfirm();
					void restartSessionAnyState(sessionId);
				},
			});
		},
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
	useTpsDisplayMode(settings.tpsDisplayMode);
	useSendShortcut(settings.sendShortcut);

	// 架构错包检测：x64 包跑在 Apple Silicon（Rosetta）下时提示换装 arm64 原生包（可永久关闭）
	useArchMismatchNotice();

	// 设置 → 渲染层镜像 atom / 开屏缓存（logo 风格、自定义品牌、公告通知开关）
	// 收口到 useAppSettingsMirrors。
	useAppSettingsMirrors({ settings, store });

	// 公告通知调度（读镜像 atom）：输入/Agent 运行中/模态打开/窗口不活跃时自动延后弹出（不打扰操作，见 hook 注释）
	useAnnouncementNotifier();
	// GitHub Star 提醒：用满一天 + 本次运行 15 分钟后才开口，一天最多一次，可「不再提醒」（见 hook 注释）
	useStarReminder();
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
		markEditorTabDirty,
		isEditorTabDirty,
		promotePreviewEditorTab,
		allowSaveEditorTab,
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
		projects,
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
	// #354：catalog 身份归并后迁移渲染层持久化的「最近活动」引用（Tab 置顶在 chrome hook 内迁移）。
	useSessionIdAliasMigration();

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
		// 新建会话默认后端：跟随设置项（默认 pi，可切换 dsh），经 DSH runtime 安装态钳制。
		// 不再沿用「上次选择」——侧栏「+」等入口一律按设置默认建会话。
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
		suppressQueueAutoDrain: queue.suppressSessionQueueAutoDrain,
	});

	// Cmd/Ctrl+W 关闭当前会话标签页：回答进行中先弹确认（确认 = 停止 + 关闭），空闲直接关。
	// 会话目标解析/停止/确认框分别复用 runControl/overlays，本处仅装配。
	useCloseSessionTabShortcut({ closeTab: workspaceChrome.closeTab, abortAgent, overlays });

	// 终端 IPC 目标：Agent 会话优先绑定当前 runtime；未启动或已停止时回退到项目 cwd。
	// 该计算必须放在 useSessionRunControl 之后，因为 runtime target resolver 是该 hook 的返回值。
	const terminalTarget: TerminalTarget | undefined = useMemo(() => {
		if (!terminalOwner) return undefined;
		const fallbackProject = (() => {
			const pid = terminalOwner.kind === "project" ? terminalOwner.id : (activeProjectId ?? currentSessionRecord?.projectId);
			return pid ? projects.find((p) => p.id === pid) : undefined;
		})();
		// 远端项目没有本机 cwd：只传 projectId，由主进程按项目 locator 解析远端终端目标。
		const projectTarget = fallbackProject && !isChatProject(fallbackProject) ? { kind: "project" as const, projectId: fallbackProject.id, ...(isRemoteProject(fallbackProject) ? {} : { cwd: fallbackProject.path }) } : undefined;
		if (terminalOwner.kind === "agent") {
			const runtimeTarget = getRuntimeTargetForSession(currentSessionId);
			return runtimeTarget ? { kind: "agent" as const, ...runtimeTarget } : projectTarget;
		}
		return projectTarget;
	}, [terminalOwner, currentSessionId, currentSessionRecord, projects, activeProjectId, getRuntimeTargetForSession]);
	// 终端面板判定远端外观需要的项目记录：由 App 读取后作为普通 prop 下传，
	// TerminalDock 本身保持无 Jotai 依赖（dev 的终端 harness 直接以 props 渲染它）。
	const terminalTargetProject = terminalProjectId ? projects.find((project) => project.id === terminalProjectId) : undefined;

	const quickTask = useQuickTask({ ready: settingsLoaded, backend: effectiveAgentBackend, upsertSession, selectSession: selectSessionCommand, registerSession: workspaceChrome.registerOpenSession, refreshProjects, getSessionRecord });

	// 侧边任务：抽屉「侧边任务」面板持有的轻量会话。创建/切换/释放都在 useSideTasks 里，
	// App 只负责「建好后把抽屉开到这个面板」，不登记主区 Tab、不改当前会话（面板自己寻址）。
	const sideTasks = useSideTasks({
		backend: effectiveAgentBackend,
		showToast,
		onCreated: () => workspace.openDrawerForce("sideTask"),
	});

	// 外部链接与本地服务 Web UI 共用同一个出口：强制打开 browser 抽屉 + 内置浏览器新建 tab。
	const openInBrowser = (url: string) => {
		workspace.openDrawerForce("browser");
		navigateTo(url);
	};

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
								announceProjectAdded(project);
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

	// 会话创建入口族（新建草稿/匿名会话、问题反馈会话、智能体「发送到会话」/「使用」）
	// 收口到 useAppSessionCreation：App 只接选中态、在途闸门与草稿写入，动作实现与文案都在 hook 内。
	const { createSessionDraftWithTab, createAnonymousSessionWithTab, handleFeedbackCreateSession, handleAgentSendToSession, handleAgentUseAgent } = useAppSessionCreation({
		store,
		activeProjectId,
		effectiveAgentBackend,
		projects,
		setSessionDraft,
		selectSessionCommand,
		selectProjectCommand,
		showToast,
		upsertSession,
		workspaceChrome,
		runCreateSessionDraft,
		runCreateAnonymousSession,
		pendingDraftCreationRef,
		lastCreatedDraftIdRef,
	});

	// 会话入口与引导页首发（划词回填 / 页面式工作区互斥 / 侧栏·插件·收藏页打开会话 /
	// 引导页首次发送落地真实会话）收口到 useAppSessionEntrypoints。
	const { openSidebarSessionByIdWithTab, ensureSessionForSend } = useAppSessionEntrypoints({
		store,
		currentSessionId,
		activeProjectId,
		activeProject,
		projects,
		effectiveAgentBackend,
		setSessionDraft,
		showToast,
		selectSessionCommand,
		upsertSession,
		promoteSessionComposerState,
		promoteSessionMessagesCache,
		workspaceChrome,
		runOpenSidebarSessionById,
		openInBrowser,
		activeWorkspacePage,
		deactivateWorkspacePage,
		hostPluginPanel,
		setHostPluginPanel,
		favoritesOpenSessionRequest,
		setFavoritesOpenSessionRequest,
		refreshProjectSessionsRef,
		pendingDraftCreationRef,
		lastCreatedDraftIdRef,
		guideBootstrapPromotionRef,
	});

	/** 有效文件路径白名单：仅工作区真实存在的 @ 引用渲染为 chip */
	const validFilePaths = useMemo(() => new Set(flatFiles.map((f) => f.relativePath)), [flatFiles]);

	const projectIdsKey = useMemo(() => projects.map((project) => project.id).join("\n"), [projects]);

	// App 启动接线（Agent 清单替换 + 宿主 bootstrapProps + 首拉设置）收口到 useAppStartupWiring。
	const { bootstrapProps } = useAppStartupWiring({
		store,
		agents,
		pendingAgentsRef,
		setPendingAgents,
		livePromptByAgentRef,
		activeProjectId,
		setActiveProjectId,
		setSettings,
		setSettingsLoaded,
		setImageGenConfig,
		setEnhanceModel,
		setEnhanceIncludeContext,
		setPromptSuggestionEnabled,
		setPromptSuggestionModel,
		showToast,
		selectSessionCommand,
		openInBrowser,
		overlays,
		workspace,
		piUpdate,
	});

	// 项目/会话集合的收敛 effect（项目裁剪、catalog 补加载、运行态回读、终端裁剪、周期扫描）
	// 收口到 useAppProjectScanEffects。
	useAppProjectScanEffects({
		store,
		projects,
		projectIdsKey,
		setVisibleProjectChildCountByProject,
		setSessionLoadingByProject,
		expandedProjects,
		expandedProjectsReady,
		refreshProjectSessionsRef,
		activeAgentId,
		refreshRuntimeState,
		displayAgents,
		pruneTerminalDockState,
		activeProjectId,
		activeProjectHasBusyAgent,
		activeProjectSessionSyncKey,
		refreshProjectSessions,
	});

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

	// 活动项目的 catalog 补加载与 git 分支同步（切项目回读分支 + 订 refs 变化事件）
	// 收口到 useAppActiveProjectSync：三条 effect 共用「活动项目 + 是否远端」同一入口条件。
	useAppActiveProjectSync({
		store,
		activeProjectId,
		activeProjectIsRemote,
		projects,
		expandedProjects,
		expandedProjectsReady,
		refreshProjectSessionsRef,
		setGitInfo,
		setBranchByProject,
	});

	// 项目记录域（入库/移除/排序/置顶、Chat 记录目录切换、草稿会话删除、catalog 按需预热）
	// 收口到 useAppProjectActions：App 只接 IO 接口与选中态，动作实现与文案都在 hook 内。
	const { announceProjectAdded, addProject, updateAfterProjectRemoved, deleteDraftSession, reorderProjects, setProjectPinned, removeSidebarProject, removeSidebarProjects, changeChatPath, ensureProjectCatalogLoaded } = useAppProjectActions({
		store,
		api,
		showToast,
		showConfirm: overlays.showConfirm,
		clearConfirm: overlays.clearConfirm,
		projects,
		setProjects,
		activeProjectId,
		setActiveProjectId,
		sessionsProjectId,
		setSessionsProjectId,
		drawer,
		closeSessionsDrawer: () => workspace.closeDrawer(),
		setVisibleProjectChildCountByProject,
		revealProjectInSidebar: requestSidebarRevealProject,
		setWslProjectPicker,
		settings,
		syncDshForeignSessionsIfEnabled,
		refreshProjects,
		refreshProjectSessions,
		removeSessionState,
		removeSessionComposerState,
	});

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
	// pi 历史消息改写（编辑/删除/重发/分支）的装配收口到 useAppHistoryMutations：策略与写盘在
	// useSessionHistoryMutations，这里只接「会话身份 → 项目/文件/后端形态」判定。
	const { editMessage, deleteMessage, removeMessageImage, resendUserMessage, forkFromUserMessage, forkAtEntry, pendingHistoryMutation } = useAppHistoryMutations({
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
		isAgentCurrentlyBusy,
		currentSessionIdRef,
		store,
		getSessionRecord,
		activeProjectId,
		setSessionDraft,
		setSessionAttachments,
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

	// 分支切换/新建（成功后同源回写侧栏徽标与 Git 抽屉）收口到 useAppGitBranchActions。
	const { switchBranch, createBranch } = useAppGitBranchActions({
		activeProjectId,
		gitInfo,
		showToast,
		setGitInfo,
		setBranchByProject,
	});

	// 侧栏会话归档/删除族收口到 useSidebarArchiveActions（删除/归档/恢复 + DSH 归档）
	const archiveActions = useSidebarArchiveActions({
		activeProjectId,
		showToast,
		overlays,
		refreshProjectSessions,
		dismissSessionTree,
		getSessionRecords: getProjectSessionRecords,
	});

	// 侧栏动作装配（项目/会话/Agent/worktree/RPC 日志五组）收口到 useAppSidebarActions
	const sidebarActions: SidebarActions = useAppSidebarActions({
		api,
		store,
		showToast,
		settings,
		projects,
		selectProject: selectProjectCommand,
		selectSession: selectSessionCommand,
		openSessionInTab: openSidebarSessionByIdWithTab,
		refreshProjectSessions,
		createSessionDraftWithTab,
		createAnonymousSessionWithTab,
		upsertSession,
		setProxyDialogSessionId,
		patchRpcLoggingAgentIds,
		openDirectoryImport,
		openProjectResources: setProjectResourcesProject,
		openAutomations: openAutomationPage,
		projectActions: { addProject, ensureProjectCatalogLoaded, reorderProjects, setProjectPinned, removeSidebarProject, removeSidebarProjects, deleteDraftSession, changeChatPath },
		sync: { refreshProjectTree, refreshAllProjects },
		sessionActions: { copySidebarSession: runCopySidebarSession, exportSidebarSession: runExportSidebarSession },
		archiveActions,
		runControl: { runSessionControl, getRuntimeTargetForAgent, exportAgentHtml, cloneAgentSession, requestCloseAgent },
		worktreeActions: { toggleProjectWorktree, createWorktree, requestRemoveWorktree },
		workspace,
		chrome: workspaceChrome,
		importFlow,
		rename,
		sideTasks,
	});

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
			removingWorktreeProjectIds={removingWorktreeProjectIds}
			isLanWeb={isLanWeb}
			// 新建会话先打开引导页；首次发送再创建真实会话，无项目时显示添加项目空态。
			onOpenNewSession={() => {
				if (activeProjectId) selectProjectCommand(activeProjectId);
			}}
			onOpenFeedback={() => overlays.setFeedbackOpen(true)}
			settingsExpandedProjectIds={settings.sidebarExpandedProjectIds}
			settingsNavTab={settings.sidebarNavTab}
			settingsPinnedSessionIds={settings.pinnedSessionIds}
			settingsSessionSortMode={settings.sessionSortMode}
			settingsProjectSortMode={settings.projectSortMode}
			stickyGroupHeaders={settings.sidebarStickyGroupHeaders === true}
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

	// 后台 Ask 通知「前往会话」：跳转的同时登记常驻 Tab——agent 开多时被询问的会话
	// 可能根本没开 Tab（后台并行 ask 等），只切焦点的话回答完切换出去就找不到了。
	// 必须在选会话之前让出页面式工作区（设置/定时任务/智能体）：它们盖在会话列上，
	// 而「失活页面」只由 scope 变化触发——被询问的会话已经是 currentSessionId 时
	// （在会话里触发 ask → 切到设置页 → 点「前往会话」）scope 不变，不清就毫无反应。
	const jumpToAskSession = useCallback(
		(sessionId: string) => {
			const record = store.get(sessionRecordByIdAtomFamily(sessionId));
			if (!record) return;
			deactivateWorkspacePage();
			workspaceChrome.registerOpenSession(sessionId, "permanent");
			selectSessionCommand(record.projectId, sessionId, true);
		},
		[deactivateWorkspacePage, selectSessionCommand, store, workspaceChrome],
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
			// 切会话属面板级（tailwind.css 三档文档明确列了「切会话/抽屉」→ slow 320ms）；
			// 曲线走 --ease-out-quint 的 JS 孪生（lib/motionTokens，与 CSS 侧同值互钉）
			{ duration: DURATION_SLOW_MS, easing: EASE_OUT_QUINT_CSS },
		);
		return () => anim.cancel();
	}, [currentSessionId, workspaceChrome.splitLayout, settings.navigationMode]);

	// 会话 Tab 栏装配域（会话操作组/运行控制/页面 Tab/栏 props）收口到 useSessionTabsAssembly：
	// App 只接选中态、运行控制与抽屉开关，闸门判定与 props 形状都在 hook 内。
	const { sessionTabsProps, workspacePageTabItems, buildTabsSessionActions, tabsSessionActions } = useSessionTabsAssembly({
		store,
		api,
		showToast,
		settings,
		chrome: workspaceChrome,
		projects,
		displayAgents,
		pendingAgents,
		rename,
		runControl: { restartingAgentId, activatingSessionId, stoppingAgentId, reloadingSessionId, getSessionRunCapabilities, getRuntimeTargetForSession, runSessionControl, requestCloseAgentForSession, cloneAgentSession },
		sessionActions: { copySession: runCopySession, exportSidebarSession: runExportSidebarSession },
		sideTasks,
		currentSessionId,
		currentSessionRecord,
		activeAgentId,
		getSessionRecord,
		setProxyDialogSessionId,
		createSessionDraftWithTab,
		createAcpSession: (projectId, toolId) => sidebarActions.sessions.createAcp(projectId, toolId),
		openWorkspacePageIds,
		activeWorkspacePage,
		openWorkspacePage,
		closeWorkspacePage,
		closeRequestRef: settingsCloseRequestRef,
		drawer: { panel: drawer, collapsed: drawerCollapsed, toggle: toggleRightDrawer, listCollapsed, toggleListCollapsed },
	});

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

	// 会话栏服务装配域（Tab 栏工具开关 + SessionPaneServices 值）收口到 useAppSessionPaneServices：
	// 运行控制/历史变更/排队队列/终端外观按栏契约接线，App 只提供跨域取值与选中态。
	const { sessionToolActions, sessionPaneServices } = useAppSessionPaneServices({
		settings,
		showToast,
		showNotice,
		api,
		scratchPad,
		terminalTarget,
		terminalOpen,
		setTerminalOpenForOwner,
		editorsOpen,
		activeAgent,
		activeProject,
		adjustMenuPos,
		openExternalEditorChooser: workspace.openExternalEditorChooser,
		workspaceChrome,
		runControl: { abortAgent, restartActiveAgent, getSessionRunCapabilities, runSessionControl, requestCloseAgentForSession, restartingAgentId, stoppingAgentId, activatingSessionId, reloadingSessionId },
		history: { resendUserMessage, editMessage, deleteMessage, removeMessageImage, forkFromUserMessage, pendingHistoryMutation },
		queue,
		terminal: { terminalStatesByOwner, activeTerminalOwnerKey, availableTerminalHeight, setTerminalOpenByOwnerKey, setTerminalCollapsedByOwnerKey, setTerminalHeight, terminalSettings, onTerminalThemeChange: setTerminalTheme },
		getSessionRecord,
		setProxyDialogSessionId,
		buildTabsSessionActions,
		createSessionDraftWithTab,
		openSidebarSessionByIdWithTab,
		openProviderLogin,
		jumpToAskSession,
		ensureSessionForSend,
		enqueueSessionPrompt,
		insertQuickPrompt,
		displayAgents,
		queueFlushBySessionRef,
		sessionDurationByAgent,
		activeProjectId,
		handleProjectGitChanged,
		validFilePaths,
		environmentDialog: Boolean(environmentDialog),
		changeChatPath,
		jumpToMessageRef,
		paneLayoutRefs,
		handleOpenLinkedFile,
		diffFilePath,
		setPreviewImage,
	});

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
						<ProjectEmptyState
							activeProject={activeProject}
							projects={projects}
							onAddProject={() => void addProject()}
							onSelectProject={selectProjectCommand}
							onOpenTerminal={!isLanWeb && terminalTarget ? () => setTerminalOpenForOwner(true) : undefined}
							onOpenFile={(target) => viewFilePath(target)}
							onCreateSession={createSessionDraftWithTab}
						/>
					</ResizablePanel>
					{!isLanWeb && terminalDockVisible && terminalTarget && (
						<TerminalDockPanel
							target={terminalTarget}
							targetProject={terminalTargetProject}
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
	// 会话状态显示位置：首屏设置未拉到 / 预览环境缺字段时按默认值处理
	const sessionStatusPlacement = parseSessionStatusPlacement(settings.sessionStatusPlacement);
	// 输入框上方的待办/子代理横栏只看设置：选「右侧边栏」就始终让位，与面板此刻展开还是收起无关。
	const setSessionStatusInSidebar = useSetAtom(sessionStatusInSidebarAtom);
	useEffect(() => {
		setSessionStatusInSidebar(placementShowsSidebarPanel(sessionStatusPlacement));
	}, [sessionStatusPlacement, setSessionStatusInSidebar]);
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
		actions: { selectProjectCommand, restartActiveAgent, closeAgent, runSessionControl, openAutomationPage: () => openAutomationPage(), openAgentMarketPage: () => openAgentMarketPage(), openFavoritesPage: () => openFavoritesPage(), openEnvironmentGuide: piUpdate.openEnvironmentGuide },
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
	// 文件 tab 关闭保护（Wave 5）：dirty tab 直接关闭 = 静默丢改动。自动保存有 1.5s
	// debounce 且可能失败（网络盘/权限），不能假设「关的时候已经存过了」。确认框文案
	// 与 ConfigModal「放弃更改」同语义；dirty 集来自 FileDiffViewer 上报。
	const requestCloseEditorTab = (id: string) => {
		if (!isEditorTabDirty(id)) {
			closeEditorTab(id);
			return;
		}
		const tab = editorTabs.find((t) => t.id === id);
		const label = tab?.label ?? tab?.filePath.split(/[/\\]/).pop() ?? id;
		overlays.showConfirm({
			title: t("editor.dirtyCloseTitle"),
			message: t("editor.dirtyCloseMessage", { file: label }),
			confirmLabel: t("config.discardChanges"),
			danger: true,
			onConfirm: () => {
				overlays.clearConfirm();
				closeEditorTab(id);
			},
		});
	};
	const closeWorkbenchTab = (id: string) => {
		if (id.startsWith("git-diff:")) {
			if (simpleMode) dismissGitDiff();
			else closeGitDiff();
		} else requestCloseEditorTab(id);
	};
	const toggleSimpleContent = () => setSimpleContentExpanded((value) => !value);
	// 页面式插件面板伪 Tab：tab 模式下挂进 SessionTabsBar（打开时会话 Tab 退非选中，
	// 点任意会话 Tab 即收起）；simple 模式不挂（插件页直接铺满会话区，由 Overlay 承担）。
	const hostPluginPageTab = useHostPluginPageTab();
	const sessionTabsBarNode = (
		<SessionTabsBar
			{...sessionTabsProps}
			simple={simpleMode}
			// 页面（插件页 / 定时任务 / 智能体）占据会话区时，会话 Tab 不得显示选中态（当前呈现的不是会话）
			currentSessionId={activeWorkspacePage || hostPluginPageTab ? undefined : currentSessionId}
			pageTabs={workspacePageTabItems}
			pluginTab={simpleMode || activeWorkspacePage ? null : hostPluginPageTab}
			// 点任意会话 Tab（含当前 Tab，sessionId 不变的场景）也要让出页面：插件页直接收起，
			// 工作区页面只失活（Tab 保留，切回来状态还在）；Overlay 的 scope 变化兜底只覆盖「切到别的会话」。
			onSelect={(sessionId) => {
				deactivateWorkspacePage();
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
				requestCloseEditorTab(tabId);
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
			onDirtyChange={markEditorTabDirty}
			gitDiff={workbenchHasGitDiff && gitDrawerDiff ? gitDrawerDiff : null}
			gitDiffDisplayMode={simpleMode ? workbenchLayout : gitDiffDisplayMode}
			onToggleGitDiffMode={simpleMode ? toggleSimpleContent : toggleGitDiffDisplayMode}
			onCloseGitDiff={simpleMode ? dismissGitDiff : closeGitDiff}
			activeTab={activeTab}
			editorMode={simpleMode ? workbenchLayout : editorMode}
			onToggleEditorMode={simpleMode ? toggleSimpleContent : activeTab?.preserveDrawer ? undefined : toggleEditorMode}
			onCloseEditor={() => {
				if (simpleMode && activeTab) requestCloseEditorTab(activeTab.id);
				else closeEditor();
			}}
			readContent={readEditorFileContent}
			readOriginalContent={readEditorOriginalContent}
			saveContent={saveEditorFileContent}
			onAllowSaveTab={allowSaveEditorTab}
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
					{/* 页面式工作区（定时任务 / 智能体）：会话 Tab 栏里的专属页面 Tab，覆盖会话列；
					    关闭 Tab 才卸载，失活时 hidden 保留页面内状态 */}
					<AutomationPage
						active={activeWorkspacePage === "automation"}
						onViewSession={(projectId, sessionId) => {
							void openSidebarSessionByIdWithTab(projectId, sessionId, "permanent");
						}}
					/>
					<AgentMarketPage active={activeWorkspacePage === "agents"} onUseAgent={handleAgentUseAgent} />
					{/* 收藏：整条回复 / 划选片段的本地快照，页面式 Tab（与智能体同一层级） */}
					<FavoritesPage active={activeWorkspacePage === "favorites"} />
					{/* 设置：从 80vw×80vh 弹框迁成会话列页面（不再遮住工作区），失活只 hidden 保挂载，
					    关闭 Tab 才卸载（内存草稿随之丢弃，所以关闭叉先走页面的未保存确认） */}
					<SettingsFeatureRoot
						settings={settings}
						piUpdate={piUpdate}
						webServiceChanging={webServiceChanging}
						onRestartWebService={restartWebService}
						appInfo={appInfo}
						onChange={updateSettings}
						projects={projects}
						projectId={activeProject?.id}
						projectKind={activeProject?.kind}
						projectName={activeProject?.name}
						closeRequestRef={settingsCloseRequestRef}
					/>
				</div>
			}
			content={workbenchContentNode}
			onContentWidthChange={handleWorkbenchContentWidth}
		/>
	);

	// ── DrawerSurface port objects (stable via useMemo) ──
	// 文件树传输域（OS 拖入 / 剪贴板粘贴 / 树内拖拽移动 + 右键菜单剪贴板探测）收口到
	// useAppFileTreeTransfer：三个入口只差源路径从哪来，落地动作与提示文案同源。
	const fileTreeTransfer = useAppFileTreeTransfer({ api, refreshVisibleFiles, showToast, setFileMenu, setHasClipboardFiles });

	const drawerPorts = useDrawerPorts({
		enableGitManagement: settings.enableGitManagement,
		activeProjectId,
		activeProject: activeProject ?? undefined,
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
		fileTreeContentRevision,
		sessions,
		sessionSourceFilter,
		sessionHistoryLoading,
		expandedDirs,
		onToggleDirectory: toggleDirectory,
		onCollapseAllDirectories: collapseAllDirectories,
		setFileMenu: fileTreeTransfer.setFileMenu,
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
		onDropFiles: fileTreeTransfer.onDropFiles,
		onPasteFiles: fileTreeTransfer.onPasteFiles,
		onMoveFiles: fileTreeTransfer.onMoveFiles,
	});

	return (
		<WorkbenchShell
			identity={{ activeAgent, activeProject, activeProjectId, currentSession, currentSessionId, projects, settings, appInfo }}
			chrome={{
				simpleMode,
				listCollapsed,
				listWidth,
				drawer: { workspace, drawer, drawerCollapsed, drawerWidth, drawerPorts, scratchPad, sideTasks, forkAtEntry },
				panes: { bootstrapProps, quickTask, sessionPaneServices, chatPaneRef, terminalRowHeight, workbenchContentWidth, sidebarContentNode, chatPaneContentNode, sessionStatusPlacement },
				rewindSupported,
				rpcLogTabTargetAgentId,
			}}
			events={{
				showToast,
				setListCollapsed,
				setListWidth,
				setDrawerCollapsed,
				setDrawerWidth,
				toggleListCollapsed,
				toggleRightDrawer,
				handleToolDrawerAction,
				focusSessionPane,
				createSessionDraftWithTab,
				openSidebarSessionByIdWithTab,
			}}
			rootDialogs={<WorkbenchDialogs palette={{ commandPaletteOpen, setCommandPaletteOpen, commandPaletteCommands, openCommandPalette, activeProjectId, activeProjectHasBusyAgent, settingsPageActive, quickTaskActive: quickTask.active }} cuaApproval={cuaApproval} />}
		>
			<WorkbenchFileOverlays
				menu={{ fileMenu, hasClipboardFiles }}
				editing={{ creatingFile, creatingFileInput, renamingFile, renamingFileInput, rename }}
				resources={{ projectResourcesProject }}
				events={{ setFileMenu, setCreatingFile, setCreatingFileInput, setRenamingFile, setRenamingFileInput, setProjectResourcesProject, refreshVisibleFiles, showToast, overlays }}
			/>
			<WorkbenchAppOverlays
				environment={{ environmentDialog, setEnvironmentDialog, piStatus, piChecking, piGuide, piUpdate, dshRuntimeStatus, settings, store, setSettings }}
				enrollment={{ refreshProjects, selectProjectCommand, requestSidebarRevealProject, syncDshForeignSessionsIfEnabled, announceProjectAdded, importFlow, directoryImport }}
				session={{ overlays, handleFeedbackCreateSession, previewImage, setPreviewImage, externalPathOpenDialog, proxyDialogSessionId, setProxyDialogSessionId, activeProject, currentSessionId, handleAgentSendToSession, editorsOpen, externalEditors, editorsAnchor, editorsTargetPath, workspace }}
				events={{ showToast }}
			/>
		</WorkbenchShell>
	);
}

// test
