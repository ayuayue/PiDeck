import { useMemo } from "react";
import type { WorkspaceDrawerPanel } from "./useWorkspacePanels";
import type { SessionFilterPill } from "../sessionFilterPills";
import { openGitFileInEditor } from "../utils/gitFileOpen";
import type {
  DrawerGitPort,
  DrawerChromePort,
  DrawerBrowserPort,
  DrawerFilesPort,
} from "../components/workspace/DrawerSurface";

interface UseDrawerPortsInput {
  // Git
  enableGitManagement: boolean;
  activeProjectId: string | undefined;
  gitDrawerDiff: any;
  gitDiffDisplayMode: string;
  openCommitFileDiff: any;
  openWorkspaceFileDiff: any;
  toggleGitDiffDisplayMode: () => void;
  closeGitDiff: () => void;
  /** 仅关掉 Git Diff、保留文件 tab；Git 行内“打开文件”要先清 Diff 再开 tab。 */
  dismissGitDiff: () => void;
  gitApi: any;
  gitInfo: any;
  switchBranch: any;
  createBranch: any;

  // Workspace actions
  openDrawer: (panel: WorkspaceDrawerPanel) => void;
  closeDrawer: () => void;
  collapseDrawer: () => void;
  closeBrowser: () => void;
  minimizeBrowser: () => void;
  enterBrowserFullscreen: () => void;

  // Browser
  browserFullscreen: boolean;

  // Files/History
  sessionsProject: any;
  sessionsProjectId: string | undefined;
  files: any[];
  sessions: any[];
  sessionSourceFilter: Record<string, Set<SessionFilterPill> | null>;
  sessionHistoryLoading: boolean;
  expandedDirs: Set<string>;
  onToggleDirectory: (dir: string) => void;
  onCollapseAllDirectories: () => void;
  setFileMenu: any;
  refreshFiles: any;
  showToast?: (message: string, duration?: number) => void;
  projects: any[];
  refreshProjectSessions: any;
  runOpenSidebarSession: any;
  isSameSessionPath: any;
  runCopySession: any;
  runExportHistorySession: any;
  runDeleteHistorySession: any;
  viewFilePath: any;
  openFilePath: any;
  /** 在中间栏编辑器打开（可编辑 tab）；Git 变更行内“打开”按钮使用 */
  openEditorTab: any;
  api: any;
  t: any;
  /** 当前项目根目录：文件面板空白处拖入/粘贴/右键菜单的落点 */
  projectRoot: string | undefined;
  /** 从 OS 拖入文件（复制到目标目录） */
  onDropFiles: (targetDir: string, files: FileList) => void;
  /** 粘贴剪贴板文件（Ctrl+V / 右键菜单） */
  onPasteFiles: (targetDir: string) => void;
  /** 文件树内部拖拽移动 */
  onMoveFiles: (sourcePaths: string[], targetDir: string) => void;
}

export function useDrawerPorts(input: UseDrawerPortsInput) {
  return useMemo(() => {
    const git: DrawerGitPort = {
      enableGitManagement: input.enableGitManagement,
      activeProjectId: input.activeProjectId,
      gitDrawerDiff: input.gitDrawerDiff,
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

    const files: DrawerFilesPort = {
      sessionsProject: input.sessionsProject,
      sessionsProjectId: input.sessionsProjectId,
      files: input.files,
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
      openEditorTab: (path: string) =>
        openGitFileInEditor(input.dismissGitDiff, input.openEditorTab, path),
      api: input.api,
      t: input.t,
      projectRoot: input.projectRoot,
      onDropFiles: input.onDropFiles,
      onPasteFiles: input.onPasteFiles,
      onMoveFiles: input.onMoveFiles,
    };

    return { git, chrome, browser, files };
  }, [
    input.enableGitManagement, input.activeProjectId,
    input.gitDrawerDiff, input.gitDiffDisplayMode,
    input.openCommitFileDiff, input.openWorkspaceFileDiff,
    input.toggleGitDiffDisplayMode, input.closeGitDiff, input.dismissGitDiff,
    input.gitApi, input.gitInfo, input.switchBranch, input.createBranch,
    input.openDrawer, input.closeDrawer, input.collapseDrawer,
    input.closeBrowser, input.minimizeBrowser, input.enterBrowserFullscreen,
    input.browserFullscreen,
    input.sessionsProject, input.sessionsProjectId,
    input.files, input.sessions, input.sessionSourceFilter, input.sessionHistoryLoading,
    input.expandedDirs, input.onToggleDirectory, input.onCollapseAllDirectories,
    input.setFileMenu, input.refreshFiles, input.showToast, input.projects, input.refreshProjectSessions,
    input.runOpenSidebarSession, input.isSameSessionPath,
    input.runCopySession, input.runExportHistorySession, input.runDeleteHistorySession,
    input.viewFilePath, input.openFilePath, input.openEditorTab, input.api, input.t,
    input.projectRoot, input.onDropFiles, input.onPasteFiles, input.onMoveFiles,
  ]);
}
