import { useEffect } from "react";
import type { createStore } from "jotai";
import { Bot, Clock, Settings2, Star, type LucideIcon } from "lucide-react";
import { sessionRecordsAtom, sessionRuntimeBySessionIdAtomFamily } from "../../atoms";
import { isLiveRuntimeStatus, resolveSessionReloadMode, type SessionRunAction, type SessionRunControlView } from "../../utils/sessionCommands";
import { sortWorkspacePageIds, type WorkspacePageId } from "../../utils/workspacePageTabs";
import { splitLayoutSessionIds } from "../../utils/sessionSplitEdge";
import { isChatProject, type PendingAgentTab } from "../../rendererUtils";
import type { PiDesktopApi } from "../../../../preload";
import type { AppSettings, AgentTab, Project, SessionRecord } from "../../../../shared/types";
import { t, type TranslationKey } from "../../i18n";
import type { SessionTabsBarProps, WorkspacePageTabItem } from "../../components/session/SessionTabsBar";
import type { useRename } from "../useRename";
import type { useSessionRunControl } from "../session/useSessionRunControl";
import type { useSessionActions } from "../useSessionActions";
import type { useSideTasks } from "../useSideTasks";
import type { useSessionWorkspaceChrome } from "../useSessionWorkspaceChrome";
import type { WorkspaceDrawerPanel } from "../useWorkspacePanels";

/**
 * 页面 Tab 的标题与图标（静态元数据，标题在渲染时经 t() 取当前语言）。
 * 一张表同时管住标题和图标：两串三元链曾分别维护，新增页面时必有一边漏改。
 */
const WORKSPACE_PAGE_TAB_META: Record<WorkspacePageId, { titleKey: TranslationKey; icon: LucideIcon }> = {
	settings: { titleKey: "settings.title", icon: Settings2 },
	automation: { titleKey: "automation.title", icon: Clock },
	agents: { titleKey: "agentMarket.title", icon: Bot },
	favorites: { titleKey: "favorites.title", icon: Star },
};

export interface SessionTabsAssemblyDeps {
	store: ReturnType<typeof createStore>;
	api: PiDesktopApi;
	showToast: (message: string, duration?: number) => void;
	settings: AppSettings;
	/** useSessionWorkspaceChrome 的 Tab 状态/动作整组（登记、关闭、分屏、拖拽）。 */
	chrome: ReturnType<typeof useSessionWorkspaceChrome>;
	projects: Project[];
	displayAgents: AgentTab[];
	pendingAgents: PendingAgentTab[];
	rename: Pick<ReturnType<typeof useRename>, "openAgentRename" | "openSessionRename">;
	runControl: Pick<ReturnType<typeof useSessionRunControl>, "restartingAgentId" | "activatingSessionId" | "stoppingAgentId" | "reloadingSessionId" | "getSessionRunCapabilities" | "getRuntimeTargetForSession" | "runSessionControl" | "requestCloseAgentForSession" | "cloneAgentSession">;
	sessionActions: Pick<ReturnType<typeof useSessionActions>, "copySession" | "exportSidebarSession">;
	sideTasks: Pick<ReturnType<typeof useSideTasks>, "create">;
	currentSessionId: string | undefined;
	currentSessionRecord: SessionRecord | undefined;
	activeAgentId: string | undefined;
	getSessionRecord: (sessionId: string) => SessionRecord | undefined;
	setProxyDialogSessionId: (sessionId: string | null) => void;
	createSessionDraftWithTab: (projectId?: string) => Promise<unknown>;
	createAcpSession: (projectId: string, toolId: string) => Promise<unknown>;
	openWorkspacePageIds: readonly WorkspacePageId[];
	activeWorkspacePage: WorkspacePageId | null;
	openWorkspacePage: (pageId: WorkspacePageId) => void;
	closeWorkspacePage: (pageId: WorkspacePageId) => void;
	closeRequestRef: { current: (() => void) | null };
	drawer: { panel: WorkspaceDrawerPanel | null; collapsed: boolean; toggle: () => void; listCollapsed: boolean; toggleListCollapsed: () => void };
}

export function useSessionTabsAssembly(deps: SessionTabsAssemblyDeps) {
	const {
		store,
		api,
		showToast,
		settings,
		chrome: workspaceChrome,
		projects,
		displayAgents,
		pendingAgents,
		rename,
		currentSessionId,
		currentSessionRecord,
		activeAgentId,
		getSessionRecord,
		setProxyDialogSessionId,
		createSessionDraftWithTab,
		createAcpSession,
		openWorkspacePageIds,
		activeWorkspacePage,
		openWorkspacePage,
		closeWorkspacePage,
		closeRequestRef: settingsCloseRequestRef,
	} = deps;
	const { restartingAgentId, activatingSessionId, stoppingAgentId, reloadingSessionId, getSessionRunCapabilities, getRuntimeTargetForSession, runSessionControl, requestCloseAgentForSession, cloneAgentSession } = deps.runControl;
	const { copySession: runCopySession, exportSidebarSession: runExportSidebarSession } = deps.sessionActions;
	const { sideTasks } = deps;
	const { panel: drawer, collapsed: drawerCollapsed, toggle: toggleRightDrawer, listCollapsed, toggleListCollapsed } = deps.drawer;
	// —— Tab 栏会话操作组（重命名 / 复制会话 / 导出 HTML / 复制路径 / 打开文件）——
	// 与侧栏会话右键菜单同源同语义，参数化到任意 sessionId：⋯ 菜单喂当前会话，
	// Tab 右键菜单（SessionTabsBar contextSessionActions）喂被右键的 Tab——后台 Tab
	// 同样可操作。live 复制走 clone；历史走 copyRecord。导出由统一对话框区分完整/安全分享。
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
		// ACP 同样隐藏：live 复制走 pi manager cloneSession 会报 unknown agent，历史会话
		// 无 filePath 只会报「文件不存在」——两条路都是死胡同（2027-03 审计发现 H）。
		const canRename = record.status !== "draft";
		return {
			canCopySession: canRename && record.backend !== "acp" && (isLive || record.backend !== "dsh"),
			canExportHtml: canRename && (!record.backend || record.backend === "pi" || record.backend === "dsh"),
			hasFilePath: Boolean(record.filePath),
			// 侧边任务：目标会话的项目与后端原样带过去；不登记主区常驻 Tab、不改当前会话焦点。
			onCreateSideTask: () => void sideTasks.create({ projectId: record.projectId, backend: record.backend }),
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
			onExportSessionHtml: () => void runExportSidebarSession(record.projectId, { ...record, name: record.title, filePath: record.filePath ?? "" }),
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
	// Tab 右键菜单的运行控制：与 ⋯ 菜单共用策略函数，但按被右键的 sessionId 现算，
	// 后台 Tab 也能直接停止/重启/重载。重载入口按后端分流（pi 热重载 / DSH host 重启）。
	const buildTabsRunControl = (sessionId: string): SessionRunControlView | undefined => {
		const capabilities = getSessionRunCapabilities(sessionId);
		if (!capabilities) return undefined;
		const target = getRuntimeTargetForSession(sessionId);
		const record = store.get(sessionRecordsAtom)[sessionId];
		return {
			capabilities,
			isStopping: Boolean(stoppingAgentId && stoppingAgentId === target?.agentId),
			isRestarting: Boolean(target?.agentId && restartingAgentId === target.agentId) || activatingSessionId === sessionId,
			isReloading: reloadingSessionId === sessionId,
			reloadMode: resolveSessionReloadMode(record?.backend),
			agentId: target?.agentId,
			// 右键 Tab 的强制停止入口：杀进程 + 解绑，会话记录保留；无绑定（未启动/已关）时隐藏。
			onCloseAgent: target ? () => requestCloseAgentForSession(sessionId) : undefined,
			onAction: (action) => void runSessionControl(sessionId, action),
		};
	};
	// ⋯ 菜单（当前会话）与 Tab 右键菜单（被右键的 Tab）共用同一工厂，闸门语义一致。
	const tabsSessionActions = currentSessionId ? buildTabsSessionActions(currentSessionId) : undefined;

	useEffect(() => {
		if (settings.navigationMode === "simple" && workspaceChrome.previewSessionTabId) workspaceChrome.promotePreview(workspaceChrome.previewSessionTabId);
	}, [settings.navigationMode, workspaceChrome.previewSessionTabId, workspaceChrome.promotePreview]);

	// 会话 Tab 栏里的页面式工作区 Tab：标题固定走 i18n（不是会话、不参与自动会话标题），
	// 激活态只由 activeWorkspacePage 决定；关闭即卸载页面（切会话只是失活）。
	const workspacePageTabItems: WorkspacePageTabItem[] = sortWorkspacePageIds(openWorkspacePageIds).map((pageId) => ({
		id: pageId,
		title: t(WORKSPACE_PAGE_TAB_META[pageId].titleKey),
		icon: WORKSPACE_PAGE_TAB_META[pageId].icon,
		active: activeWorkspacePage === pageId,
		onSelect: () => openWorkspacePage(pageId),
		onClose: () => {
			// 设置页有内存草稿：关闭叉先走页面自己的未保存确认，确认后才真正关 Tab（页面卸载）。
			// 页面未注册（理论上不会：Tab 开着即挂载）才退回直接关。
			if (pageId === "settings" && settingsCloseRequestRef.current) {
				settingsCloseRequestRef.current();
				return;
			}
			closeWorkspacePage(pageId);
		},
	}));

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
			void createAcpSession(projectId, toolId);
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
					isStopping: Boolean(stoppingAgentId && stoppingAgentId === activeAgentId),
					isRestarting: restartingAgentId === activeAgentId || activatingSessionId === currentSessionId,
					isReloading: reloadingSessionId === currentSessionId,
					reloadMode: resolveSessionReloadMode(currentSessionRecord?.backend),
					// 「复制 Agent ID」用：与上面的 isStopping 同源判定（activeAgentId 即当前会话绑定的进程实例）
					agentId: activeAgentId,
					onCloseAgent: activeAgentId ? () => requestCloseAgentForSession(currentSessionId) : undefined,
					onAction: (action: SessionRunAction) => void runSessionControl(currentSessionId, action),
				}
			: undefined,
		// Tab 右键：按被右键的 Tab 现算运行控制（后台 Tab 也能停止/重启/热重载）。
		contextRunControl: buildTabsRunControl,
		// 会话代理（网络代理）入口：与侧栏会话菜单同源，打开同一个弹框。
		// 仅在有当前会话时给出；弹框内自行判断 DSH 等宿主差异并给出「下次启动生效」提示。
		// ACP 隐藏：会话代理只在 pi spawn 时消费（AgentManager.resolveSessionProxy），
		// ACP 子进程从不读取——入口是死胡同（2027-03 审计发现 H）。
		onOpenProxySetting: currentSessionId && getSessionRecord(currentSessionId)?.backend !== "acp" ? () => setProxyDialogSessionId(currentSessionId) : undefined,
		onToggleDrawer: toggleRightDrawer,
		drawerOpen: Boolean(drawer && !drawerCollapsed),
		listCollapsed,
		onToggleListCollapsed: toggleListCollapsed,
		onDragSessionChange: (sessionId: string | null) => {
			if (sessionId) workspaceChrome.beginDrag(sessionId);
			else workspaceChrome.endDrag();
		},
	};
	return { sessionTabsProps, workspacePageTabItems, buildTabsSessionActions, tabsSessionActions };
}
