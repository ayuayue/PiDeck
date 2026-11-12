import { Activity, FolderOpen, GitBranch, Globe, History, ListTree, Pencil, Rocket, ScrollText } from "lucide-react";
import type { ComponentProps, ReactNode, RefObject } from "react";
import { type SessionStatusPlacement, placementShowsSidebarPanel } from "../../../../shared/sessionStatusPlacement";
import type { AgentTab, AppInfo, AppSettings, Project, SessionRecord } from "../../../../shared/types";
import { desktopApi as api } from "../../desktopApi";
import type { useDrawerPorts } from "../../hooks/useDrawerPorts";
import type { useQuickTask } from "../../hooks/useQuickTask";
import type { useScratchPad } from "../../hooks/useScratchPad";
import type { SideTaskController } from "../../hooks/useSideTasks";
import type { useSessionHistoryMutations } from "../../hooks/useSessionHistoryMutations";
import type { useSessionFileLinks } from "../../hooks/workspace/useSessionFileLinks";
import type { WorkspaceDrawerPanel, useWorkspacePanels } from "../../hooks/useWorkspacePanels";
import { t } from "../../i18n";
import type { NoticeKind } from "../../utils/notice";
import { AppBootstrap } from "../app/AppBootstrap";
import { AppShell } from "../app/AppShell";
import { QuickTaskSurface } from "../app/QuickTaskSurface";
import { WallpaperVideoLayer } from "../app/wallpaper/WallpaperVideoLayer";
import { MiniOverlaySurface } from "../mini-overlay/MiniOverlaySurface";
import { ChatSessionPane } from "../session/ChatSessionPane";
import { FileLinkBaseProvider } from "../session/FileLinkBase";
import { SessionPaneServicesProvider, type SessionPaneServices } from "../session/SessionPaneServices";
import { SessionStatusPanel } from "../session/statusPanel/SessionStatusPanel";
import { DrawerSurface } from "../workspace/DrawerSurface";
import { WorkspaceDrawerRail } from "../workspace/WorkspaceDrawerRail";

type DrawerWorkspace = ReturnType<typeof useWorkspacePanels>;
type DrawerPorts = ReturnType<typeof useDrawerPorts>;
type ScratchPadController = ReturnType<typeof useScratchPad>;
type QuickTaskController = ReturnType<typeof useQuickTask>;
type SessionFileLinks = ReturnType<typeof useSessionFileLinks>;
type SessionHistoryMutations = ReturnType<typeof useSessionHistoryMutations>;

/** 右栏：开合控制器、当前面板与各面板 ports（DrawerSurface 要的整组）。 */
type WorkbenchDrawerSlot = {
	workspace: DrawerWorkspace;
	drawer: WorkspaceDrawerPanel | null;
	drawerCollapsed: boolean;
	drawerWidth: number;
	drawerPorts: DrawerPorts;
	scratchPad: ScratchPadController;
	sideTasks: SideTaskController;
	forkAtEntry: SessionHistoryMutations["forkAtEntry"];
};

/** AppShell 内除右栏之外，由 App 注入的分区节点与会话级 ports。 */
type WorkbenchPaneSlots = {
	bootstrapProps: ComponentProps<typeof AppBootstrap>;
	quickTask: QuickTaskController;
	sessionPaneServices: SessionPaneServices;
	chatPaneRef: RefObject<HTMLElement | null>;
	terminalRowHeight: number;
	workbenchContentWidth: number;
	sidebarContentNode: ReactNode;
	chatPaneContentNode: ReactNode;
	sessionStatusPlacement: SessionStatusPlacement;
};

export interface WorkbenchShellProps {
	/**
	 * 身份：这层外壳绑定的代理/项目/会话快照 + 两个全局快照（设置、平台信息）。
	 * FileLinkBaseProvider 的兜底 cwd、mini 浮窗的项目上下文都从这取；外壳自己不订阅 atom。
	 */
	identity: {
		activeAgent?: AgentTab;
		activeProject?: Project;
		activeProjectId?: string;
		currentSession?: SessionRecord;
		currentSessionId?: string;
		projects: Project[];
		settings: AppSettings;
		appInfo: AppInfo;
	};
	/**
	 * chrome 开关：外壳长什么样——三形态（simple / compact / 常规）、左右两栏的尺寸与折叠、
	 * 抽屉当前面板，以及注入的分区节点。
	 */
	chrome: {
		simpleMode: boolean;
		listCollapsed: boolean;
		listWidth: number;
		drawer: WorkbenchDrawerSlot;
		panes: WorkbenchPaneSlots;
		/** 检查点/分支树面板的能力门控：非 pi 后端不声明 rewind。 */
		rewindSupported: boolean;
		/** RPC 日志 Tab 的目标 agent id：为空时该 Tab 不出现（门控计算见 App 的 rpcLogTabTargetAgentId）。 */
		rpcLogTabTargetAgentId?: string;
	};
	/** 事件入口：外壳自身的尺寸/折叠开关、抽屉动作，以及 App 注入的会话创建/选中回调。 */
	events: {
		showToast: (message: string, duration?: number, kind?: NoticeKind) => void;
		setListCollapsed: (collapsed: boolean) => void;
		setListWidth: (width: number) => void;
		setDrawerCollapsed: (collapsed: boolean) => void;
		setDrawerWidth: (width: number) => void;
		toggleListCollapsed: () => void;
		toggleRightDrawer: () => void;
		handleToolDrawerAction: SessionFileLinks["handleToolDrawerAction"];
		focusSessionPane: (sessionId: string) => void;
		createSessionDraftWithTab: ComponentProps<typeof MiniOverlaySurface>["onCreateSession"];
		openSidebarSessionByIdWithTab: ComponentProps<typeof MiniOverlaySurface>["onOpenSession"];
	};
	/** AppShell 内、抽屉内容之后的应用级浮层（文件菜单 / 弹窗族），由 App 组合后注入。 */
	children?: ReactNode;
	/** AppShell 之外的根级常驻弹窗（命令面板 / 数据环境 / CUA 审批）。 */
	rootDialogs?: ReactNode;
}

/**
 * 工作台外壳装配层：身份绑定 + 三形态外壳 + 右栏（活动栏 / 抽屉内容 / 会话状态下半区）。
 *
 * 只搬结构不持状态：状态与 handler 全部留在 App，经 identity / chrome / events 三组注入。
 * DOM 层级、条件渲染顺序与原 App 内联版本逐字一致（含 mini-overlay 与 quickTask 两个 compact 分支）。
 */
export function WorkbenchShell({ identity, chrome, events, children, rootDialogs }: WorkbenchShellProps) {
	const { activeAgent, activeProject, activeProjectId, currentSession, currentSessionId, projects, settings, appInfo } = identity;
	const { simpleMode, listCollapsed, listWidth, drawer: drawerSlot, panes, rewindSupported, rpcLogTabTargetAgentId } = chrome;
	const { workspace, drawer, drawerCollapsed, drawerWidth, drawerPorts, scratchPad, sideTasks, forkAtEntry } = drawerSlot;
	const { bootstrapProps, quickTask, sessionPaneServices, chatPaneRef, terminalRowHeight, workbenchContentWidth, sidebarContentNode, chatPaneContentNode, sessionStatusPlacement } = panes;
	const { showToast, setListCollapsed, setListWidth, setDrawerCollapsed, setDrawerWidth, toggleListCollapsed, toggleRightDrawer, handleToolDrawerAction, focusSessionPane, createSessionDraftWithTab, openSidebarSessionByIdWithTab } = events;

	return (
		// 非会话静态区域使用当前焦点作为兜底；每个 SessionRuntimeInjector 会用本栏 cwd/project 覆盖。
		<FileLinkBaseProvider baseDir={activeAgent?.cwd ?? activeProject?.path} projectId={activeProject?.id} projectRoot={activeProject?.path} sessionId={currentSessionId}>
			<>
				<WallpaperVideoLayer settings={settings} />
				<AppBootstrap {...bootstrapProps} />
				<AppShell
					simpleShell={simpleMode}
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
							onClose={toggleRightDrawer}
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
								// 侧边任务 Tab：点了「新建侧边任务」才出现（面板正打开时也保留，
								// 否则空态面板会挂在没有归属 tab 的内容上）。
								...(sideTasks.ids.length > 0 || drawer === "sideTask"
									? [
											{
												id: "sideTask",
												label: t("sideTask.title"),
												icon: <Rocket size={16} />,
												active: drawer === "sideTask",
												onClick: () => handleToolDrawerAction("sideTask"),
											},
										]
									: []),
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
					drawerFooter={
						placementShowsSidebarPanel(sessionStatusPlacement) ? (
							<SessionPaneServicesProvider value={sessionPaneServices}>
								<SessionStatusPanel sessionId={currentSessionId} />
							</SessionPaneServicesProvider>
						) : undefined
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
							sideTask={{ controller: sideTasks, paneServices: sessionPaneServices }}
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
					{children}
				</AppShell>
				{rootDialogs}
			</>
		</FileLinkBaseProvider>
	);
}
