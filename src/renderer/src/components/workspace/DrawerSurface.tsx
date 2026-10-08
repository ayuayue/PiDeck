import { BrowserSurface } from "./BrowserSurface";
import { GitDrawerHost, type GitDrawerApi } from "./GitDrawerHost";
import { RewindPanel } from "./RewindPanel";
import { RpcLogPanel } from "./RpcLogPanel";
import { ScratchPadDrawer } from "../scratchPad/ScratchPadDrawer";
import type { useScratchPad } from "../../hooks/useScratchPad";
import { DrawerContent } from "../app/AppParts";
import { SessionTrajectoryPanel } from "../session/trajectory/SessionTrajectoryPanel";
import { LazyWrapper } from "../../hooks/useLazyComponent";
import { LoaderCircle } from "lucide-react";
import type { WorkspaceDrawerPanel } from "../../hooks/useWorkspacePanels";
import { SessionBranchTreePanel } from "../session/branch/SessionBranchTreePanel";
import type { RpcLogEntry } from "../../../../shared/types/rpcLog";
import { sessionPillOf, type SessionFilterPill } from "../../sessionFilterPills";
import { t } from "../../i18n";
import type { CommitEntry, FileTreeNode, GitBranchInfo, GitChangedFile, GitResourceGroupType, Project, SessionSummary } from "../../../../shared/types";
import type { PiDesktopApi } from "../../../../preload";

// ── port objects（字段类型直接取自消费组件的 props 契约：GitDrawerHost / DrawerContent）──

export interface DrawerGitPort {
	enableGitManagement: boolean;
	activeProjectId: string | undefined;
	gitDiffDisplayMode: string;
	openCommitFileDiff: (commit: CommitEntry, file: GitChangedFile, repoPath?: string) => void | Promise<void>;
	openWorkspaceFileDiff: (group: GitResourceGroupType, path: string, repoPath?: string) => void | Promise<void>;
	toggleGitDiffDisplayMode: () => void;
	closeGitDiff: () => void;
	gitApi: GitDrawerApi;
	gitInfo: GitBranchInfo;
	switchBranch: (branch: string) => void;
	createBranch: (branchName: string) => void;
}

export interface DrawerChromePort {
	onOpenDrawer: (panel: WorkspaceDrawerPanel) => void;
	onCloseDrawer: () => void;
	onCollapseDrawer: () => void;
}

export interface DrawerBrowserPort {
	browserFullscreen: boolean;
	onCloseBrowser: () => void;
	onMinimizeBrowser: () => void;
	onEnterBrowserFullscreen: () => void;
}

export interface DrawerRpcLogPort {
	/** 当前日志绑定的 agent；面板可见期间必须存在，否则什么都不渲染 */
	agentId: string | undefined;
	loadHistory: (agentId: string) => Promise<RpcLogEntry[]>;
	getLogging: (agentId: string) => Promise<boolean>;
	setLogging: (agentId: string, enabled: boolean) => Promise<boolean>;
	/** 关闭日志面板：由 useWorkspacePanels 还原打开前的抽屉面板 */
	onClose: () => void;
}

/** 文件树右键菜单状态（App 级 setFileMenu 的载荷） */
export interface DrawerFileMenu {
	node: FileTreeNode;
	x: number;
	y: number;
}

export interface DrawerFilesPort {
	sessionsProject: Project | undefined;
	sessionsProjectId: string | undefined;
	files: FileTreeNode[];
	sessions: SessionSummary[];
	sessionSourceFilter: Record<string, Set<SessionFilterPill> | null>;
	sessionHistoryLoading: boolean;
	expandedDirs: Set<string>;
	onToggleDirectory: (dir: string) => void;
	onCollapseAllDirectories: () => void;
	setFileMenu: (menu: DrawerFileMenu | null) => void;
	refreshFiles: (projectId: string | undefined) => void | Promise<void>;
	showToast?: (message: string, duration?: number) => void;
	projects: Project[];
	/** 返回 ProjectSessionRefreshPromise（自带防未处理 rejection 的 thenable）；调用方统一 void 丢弃 */
	refreshProjectSessions: (projectId: string, force?: boolean) => unknown;
	runOpenSidebarSession: (projectId: string, session: SessionSummary) => void | Promise<void>;
	isSameSessionPath: (pathA: string | undefined, pathB: string, mode: "wsl" | "native") => boolean;
	runCopySession: (sessionId: string, projectId: string | undefined) => void | Promise<void>;
	runExportHistorySession: (session: SessionSummary) => void | Promise<void>;
	runDeleteHistorySession: (session: SessionSummary) => void | Promise<void>;
	viewFilePath: (path: string, openMode?: "preview" | "permanent") => void;
	openFilePath: (path: string) => void;
	/** 在中间栏编辑器打开（可编辑 tab）；Git 变更行内“打开”按钮使用 */
	openEditorTab: (path: string) => void;
	api: PiDesktopApi;
	t: typeof t;
	/** 当前项目根目录：文件面板空白处拖入/粘贴/右键菜单的落点 */
	projectRoot: string | undefined;
	/** 从 OS 拖入文件（复制到目标目录） */
	onDropFiles: (targetDir: string, files: FileList) => void;
	/** 粘贴剪贴板文件（Ctrl+V / 右键菜单） */
	onPasteFiles: (targetDir: string) => void;
	/** 文件树内部拖拽移动 */
	onMoveFiles: (sourcePaths: string[], targetDir: string) => void;
}

export interface DrawerSurfaceProps {
	drawer: WorkspaceDrawerPanel | null;
	drawerCollapsed: boolean;
	git: DrawerGitPort;
	chrome: DrawerChromePort;
	browser: DrawerBrowserPort;
	files: DrawerFilesPort;
	rpcLog: DrawerRpcLogPort;
	scratchPad: ReturnType<typeof useScratchPad>;
	/** 分支树面板的 fork 端口：App 从会话变更 hook 传入，面板不自己拥有 fork 语义。 */
	branchTree: { forkAtEntry: (entryId: string, fallbackText: string) => void };
}

export function DrawerSurface(props: DrawerSurfaceProps) {
	const { drawer, drawerCollapsed, git, chrome, browser, files, rpcLog, scratchPad, branchTree } = props;

	return (
		<>
			{/* 工具面板共享抽屉开关；草稿本保留自身编辑工具行。 */}
			{drawer === "scratchPad" && !drawerCollapsed ? (
				<ScratchPadDrawer controller={scratchPad} />
			) : drawer === "trajectory" && !drawerCollapsed ? (
				<div className="drawer-content-frame flex min-h-0 flex-1 flex-col overflow-hidden">
					<SessionTrajectoryPanel />
				</div>
			) : drawer === "branchTree" && !drawerCollapsed ? (
				<div className="drawer-content-frame flex min-h-0 flex-1 flex-col overflow-hidden">
					<SessionBranchTreePanel forkAtEntry={branchTree.forkAtEntry} />
				</div>
			) : drawer === "rewind" && !drawerCollapsed ? (
				<div className="drawer-content-frame flex min-h-0 flex-1 flex-col overflow-hidden">
					<RewindPanel />
				</div>
			) : drawer === "browser" && !drawerCollapsed ? (
				<div className="drawer-content-frame flex min-h-0 flex-1 flex-col overflow-hidden">
					<BrowserSurface fullscreen={browser.browserFullscreen} onClose={browser.onCloseBrowser} onMinimize={browser.onMinimizeBrowser} onEnterFullscreen={browser.onEnterBrowserFullscreen} />
				</div>
			) : drawer === "rpcLog" && !drawerCollapsed ? (
				// 实时日志面板（临时面板）：与消息区并排，边看日志边发消息；
				// agentId 缺省（未打开）时不渲染，避免绑定到空 agent 的订阅。
				<div className="drawer-content-frame flex min-h-0 flex-1 flex-col overflow-hidden">{rpcLog.agentId ? <RpcLogPanel agentId={rpcLog.agentId} loadHistory={rpcLog.loadHistory} getLogging={rpcLog.getLogging} setLogging={rpcLog.setLogging} onClose={rpcLog.onClose} /> : null}</div>
			) : git.enableGitManagement && drawer === "git" && !drawerCollapsed && git.activeProjectId ? (
				<div className="drawer-content-frame flex min-h-0 flex-1 flex-col overflow-hidden">
					<div className="git-drawer-stack">
						<div className="git-drawer-source">
							<GitDrawerHost
								projectId={git.activeProjectId}
								projectRoot={files.projects.find((project: { id: string; path?: string }) => project.id === git.activeProjectId)?.path}
								gitApi={git.gitApi}
								fallbackGitInfo={git.gitInfo}
								fallbackSwitchBranch={git.switchBranch}
								fallbackCreateBranch={git.createBranch}
								onOpenCommitFileDiff={git.openCommitFileDiff}
								onOpenWorkspaceFileDiff={git.openWorkspaceFileDiff}
								onOpenFile={files.openEditorTab}
							/>
						</div>
					</div>
				</div>
			) : drawer && drawer !== "browser" && drawer !== "git" && drawer !== "trajectory" && drawer !== "rpcLog" ? (
				<LazyWrapper
					// 滚动层上移到这里：files/sessions 面板自身不再滚动（见 timeline.css
					// .files-panel/.sessions-panel 注释），占位与内容共用同一滚动容器，配合
					// scrollbar-gutter: stable 让内容宽度不随滚动条出现/消失跳变——
					// 否则切 tab 重挂时占位(无滚动条,320) → 内容(有滚动条,310) 瞬间收窄，
					// 且树高度跨阈值时滚动条反复出现/消失，形成“呼吸式”宽度摆动。
					className="drawer-content-frame overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
					enabled={true}
					threshold={0}
					rootMargin="50px"
					placeholder={
						// 整面板懒加载占位：独立居中容器，不会叠在文件名上；加载完成后随内容一起消失。
						<div
							style={{
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								gap: "6px",
								height: "100%",
								color: "var(--text-secondary)",
								fontSize: "14px",
							}}
						>
							<LoaderCircle size={14} className="animate-pideck-spin" aria-hidden="true" />
							<span>{t("drawer.lazyLoading")}</span>
						</div>
					}
				>
					<DrawerContent
						panel={drawer}
						project={drawer === "sessions" ? files.sessionsProject : undefined}
						projectId={git.activeProjectId}
						files={files.files}
						sessions={
							files.sessionsProjectId && files.sessionSourceFilter[files.sessionsProjectId as string]
								? files.sessions.filter((s) => !s.parentSessionPath && files.sessionSourceFilter[files.sessionsProjectId as string]!!.has(sessionPillOf(s))).concat(files.sessions.filter((s) => s.parentSessionPath && files.sessionSourceFilter[files.sessionsProjectId as string]!!.has(sessionPillOf(s))))
								: files.sessions
						}
						sessionsLoading={files.sessionHistoryLoading}
						expandedDirs={files.expandedDirs}
						onToggleDirectory={files.onToggleDirectory}
						onCollapseAllDirectories={files.onCollapseAllDirectories}
						onClose={chrome.onCloseDrawer}
						onFileContextMenu={(node, x, y) => files.setFileMenu({ node, x, y })}
						onRefreshFiles={() => {
							files.refreshFiles(git.activeProjectId);
						}}
						onOpenFolder={() => {
							const p = files.projects.find((p) => p.id === git.activeProjectId);
							if (p) {
								void files.api.files.open(p.path).catch((error: unknown) => {
									files.showToast?.(
										t("app.openFileFailed", {
											error: error instanceof Error ? error.message : String(error),
										}),
										4000,
									);
								});
							}
						}}
						projectRoot={files.projectRoot}
						onDropFiles={files.onDropFiles}
						onPasteFiles={files.onPasteFiles}
						onMoveFiles={files.onMoveFiles}
						onRefreshSessions={() => {
							const projectId = files.sessionsProjectId ?? git.activeProjectId;
							if (projectId) void files.refreshProjectSessions(projectId, true);
						}}
						onOpenSession={(session) => void files.runOpenSidebarSession(files.sessionsProjectId ?? git.activeProjectId ?? "", session)}
						onRenameSession={async (filePath: string, newName: string) => {
							const session = files.sessions.find((candidate) => files.isSameSessionPath(candidate.filePath, filePath, candidate.wsl ? "wsl" : "native"));
							if (!session) return;
							await files.api.sessions.updateRecord(session.id, { title: newName });
							const projectId = files.sessionsProjectId ?? git.activeProjectId;
							if (projectId) await files.refreshProjectSessions(projectId, true);
						}}
						onCopySession={(session) => files.runCopySession(session.id, files.sessionsProjectId ?? git.activeProjectId)}
						onExportSession={files.runExportHistorySession}
						onDeleteSession={files.runDeleteHistorySession}
						onViewFile={files.viewFilePath}
						onOpenFile={files.openFilePath}
					/>
				</LazyWrapper>
			) : null}
		</>
	);
}
