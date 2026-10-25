import { useMemo } from "react";
import type { WorkspaceDrawerPanel } from "./useWorkspacePanels";
import type { SessionFilterPill } from "../sessionFilterPills";
import { openGitFileInEditor } from "../utils/gitFileOpen";
import type { RpcLogEntry } from "../../../shared/types/rpcLog";
import type { DrawerBrowserPort, DrawerChromePort, DrawerFilesPort, DrawerGitPort, DrawerRpcLogPort } from "../components/workspace/DrawerSurface";

/** useFileEditor 返回的原始开 Tab 函数（openGitFileInEditor 的 openTab 参数签名） */
type OpenEditorTabFn = Parameters<typeof openGitFileInEditor>[1];

/** Git port 的直通字段：类型直接取自 DrawerGitPort，避免两处漂移 */
type GitPortInput = Pick<DrawerGitPort, "enableGitManagement" | "activeProjectId" | "gitDiffDisplayMode" | "openCommitFileDiff" | "openWorkspaceFileDiff" | "toggleGitDiffDisplayMode" | "closeGitDiff" | "gitApi" | "gitInfo" | "switchBranch" | "createBranch">;

/** 文件/会话 port 的直通字段：类型直接取自 DrawerFilesPort */
type FilesPortInput = Pick<
	DrawerFilesPort,
	| "sessionsProject"
	| "sessionsProjectId"
	| "files"
	| "fileTreeContentRevision"
	| "sessions"
	| "sessionSourceFilter"
	| "sessionHistoryLoading"
	| "expandedDirs"
	| "onToggleDirectory"
	| "onCollapseAllDirectories"
	| "setFileMenu"
	| "refreshFiles"
	| "showToast"
	| "projects"
	| "refreshProjectSessions"
	| "runOpenSidebarSession"
	| "isSameSessionPath"
	| "runCopySession"
	| "runExportHistorySession"
	| "runDeleteHistorySession"
	| "viewFilePath"
	| "openFilePath"
	| "api"
	| "t"
	| "projectRoot"
	| "onDropFiles"
	| "onPasteFiles"
	| "onMoveFiles"
>;

interface UseDrawerPortsInput extends GitPortInput, FilesPortInput {
	// Workspace actions
	openDrawer: (panel: WorkspaceDrawerPanel) => void;
	closeDrawer: () => void;
	collapseDrawer: () => void;
	closeBrowser: () => void;
	minimizeBrowser: () => void;
	enterBrowserFullscreen: () => void;

	// RPC log（临时面板：agent 绑定 + 关闭还原，由 useWorkspacePanels 管开关）
	/** 当前日志面板绑定的 agent；undefined = 未打开 */
	rpcLogAgentId: string | undefined;
	/** 从磁盘补回缓冲之外的旧日志（会话右键入口） */
	rpcLogListLogs: (agentId: string) => Promise<RpcLogEntry[]>;
	rpcLogGetLogging: (agentId: string) => Promise<boolean>;
	rpcLogSetLogging: (agentId: string, enabled: boolean) => Promise<boolean>;
	/** 关闭日志面板并还原打开前的抽屉面板 */
	closeRpcLogPanel: () => void;

	// Browser
	browserFullscreen: boolean;

	/** 仅关掉 Git Diff、保留文件 tab；Git 行内“打开文件”要先清 Diff 再开 tab。 */
	dismissGitDiff: () => void;
	/** 原始开 Tab 函数（签名同 useFileEditor 的 openEditorTab） */
	openEditorTab: OpenEditorTabFn;
}

export function useDrawerPorts(input: UseDrawerPortsInput) {
	return useMemo(() => {
		const git: DrawerGitPort = {
			enableGitManagement: input.enableGitManagement,
			activeProjectId: input.activeProjectId,
			gitDiffDisplayMode: input.gitDiffDisplayMode,
			openCommitFileDiff: input.openCommitFileDiff,
			openWorkspaceFileDiff: input.openWorkspaceFileDiff,
			toggleGitDiffDisplayMode: input.toggleGitDiffDisplayMode,
			closeGitDiff: input.closeGitDiff,
			gitApi: input.gitApi,
			gitInfo: input.gitInfo,
			switchBranch: input.switchBranch,
			createBranch: input.createBranch,
		};

		const chrome: DrawerChromePort = {
			onOpenDrawer: input.openDrawer,
			onCloseDrawer: input.closeDrawer,
			/* 右侧不再半折叠：历史 collapse 入口统一改为关闭 */
			onCollapseDrawer: input.closeDrawer,
		};

		const browser: DrawerBrowserPort = {
			browserFullscreen: input.browserFullscreen,
			onCloseBrowser: input.closeBrowser,
			onMinimizeBrowser: input.minimizeBrowser,
			onEnterBrowserFullscreen: input.enterBrowserFullscreen,
		};

		const rpcLog: DrawerRpcLogPort = {
			agentId: input.rpcLogAgentId,
			loadHistory: input.rpcLogListLogs,
			getLogging: input.rpcLogGetLogging,
			setLogging: input.rpcLogSetLogging,
			onClose: input.closeRpcLogPanel,
		};

		const files: DrawerFilesPort = {
			sessionsProject: input.sessionsProject,
			sessionsProjectId: input.sessionsProjectId,
			files: input.files,
			fileTreeContentRevision: input.fileTreeContentRevision,
			sessions: input.sessions,
			sessionSourceFilter: input.sessionSourceFilter,
			sessionHistoryLoading: input.sessionHistoryLoading,
			expandedDirs: input.expandedDirs,
			onToggleDirectory: input.onToggleDirectory,
			onCollapseAllDirectories: input.onCollapseAllDirectories,
			setFileMenu: input.setFileMenu,
			refreshFiles: input.refreshFiles,
			showToast: input.showToast,
			projects: input.projects,
			refreshProjectSessions: input.refreshProjectSessions,
			runOpenSidebarSession: input.runOpenSidebarSession,
			isSameSessionPath: input.isSameSessionPath,
			runCopySession: input.runCopySession,
			runExportHistorySession: input.runExportHistorySession,
			runDeleteHistorySession: input.runDeleteHistorySession,
			viewFilePath: input.viewFilePath,
			openFilePath: input.openFilePath,
			// 包装为单参：以可编辑模式在中间栏打开文件（Git 行内“打开文件”按钮）。
			// 先清 Git Diff 再开 Tab 的顺序契约见 utils/gitFileOpen.ts。
			openEditorTab: (path: string) => openGitFileInEditor(input.dismissGitDiff, input.openEditorTab, path),
			api: input.api,
			t: input.t,
			projectRoot: input.projectRoot,
			onDropFiles: input.onDropFiles,
			onPasteFiles: input.onPasteFiles,
			onMoveFiles: input.onMoveFiles,
		};

		return { git, chrome, browser, files, rpcLog };
	}, [
		input.enableGitManagement,
		input.activeProjectId,
		input.gitDiffDisplayMode,
		input.openCommitFileDiff,
		input.openWorkspaceFileDiff,
		input.toggleGitDiffDisplayMode,
		input.closeGitDiff,
		input.dismissGitDiff,
		input.gitApi,
		input.gitInfo,
		input.switchBranch,
		input.createBranch,
		input.openDrawer,
		input.closeDrawer,
		input.collapseDrawer,
		input.closeBrowser,
		input.minimizeBrowser,
		input.enterBrowserFullscreen,
		input.browserFullscreen,
		input.rpcLogAgentId,
		input.rpcLogListLogs,
		input.rpcLogGetLogging,
		input.rpcLogSetLogging,
		input.closeRpcLogPanel,
		input.sessionsProject,
		input.sessionsProjectId,
		input.files,
		input.fileTreeContentRevision,
		input.sessions,
		input.sessionSourceFilter,
		input.sessionHistoryLoading,
		input.expandedDirs,
		input.onToggleDirectory,
		input.onCollapseAllDirectories,
		input.setFileMenu,
		input.refreshFiles,
		input.showToast,
		input.projects,
		input.refreshProjectSessions,
		input.runOpenSidebarSession,
		input.isSameSessionPath,
		input.runCopySession,
		input.runExportHistorySession,
		input.runDeleteHistorySession,
		input.viewFilePath,
		input.openFilePath,
		input.openEditorTab,
		input.api,
		input.t,
		input.projectRoot,
		input.onDropFiles,
		input.onPasteFiles,
		input.onMoveFiles,
	]);
}
