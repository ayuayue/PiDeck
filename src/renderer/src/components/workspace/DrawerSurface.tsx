import { lazy, Suspense } from "react";
import { ArrowLeft, Minus, SquarePen, X } from "lucide-react";
const FileDiffViewer = lazy(() => import("../app/FileDiffViewer").then((module) => ({ default: module.FileDiffViewer })));
import { BrowserSurface } from "./BrowserSurface";
import { GitPanel } from "../app/GitPanel";
import { DrawerContent } from "../app/AppParts";
import { LazyWrapper } from "../../hooks/useLazyComponent";
import type { WorkspaceDrawerPanel } from "../../hooks/useWorkspacePanels";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";

// ── port objects (typed loosely — type tightening is a follow-up task) ──

export interface DrawerEditorPort {
  editorMode: string;
  activeTab: any;
  activeTabId: string | null;
  editorTabs: any[];
  toggleEditorMode: () => void;
  selectEditorTab: (id: string) => void;
  closeEditorTab: (id: string) => void;
  closeEditor: () => void;
  readEditorFileContent: (path: string) => Promise<string>;
  readEditorOriginalContent: any;
  saveEditorFileContent: ((path: string, content: string) => Promise<void>) | undefined;
  prevDrawerPanelRef: React.MutableRefObject<WorkspaceDrawerPanel | null>;
  clearEditorBack: () => WorkspaceDrawerPanel | null;
  maxEditorFileSizeMB: number;
}

export interface DrawerGitPort {
  enableGitManagement: boolean;
  activeProjectId: string | undefined;
  gitDrawerDiff: any;
  gitDiffDisplayMode: string;
  openCommitFileDiff: any;
  openWorkspaceFileDiff: any;
  toggleGitDiffDisplayMode: () => void;
  closeGitDiff: () => void;
  gitApi: any;
  gitInfo: any;
  switchBranch: any;
  createBranch: any;
}

export interface DrawerChromePort {
  onOpenDrawer: (panel: WorkspaceDrawerPanel) => void;
  onCloseDrawer: () => void;
  onCollapseDrawer: () => void;
  onToggleDrawerPin: () => void;
}

export interface DrawerBrowserPort {
  browserFullscreen: boolean;
  onCloseBrowser: () => void;
  onMinimizeBrowser: () => void;
  onEnterBrowserFullscreen: () => void;
}

export interface DrawerFilesPort {
  sessionsProject: any;
  sessionsProjectId: string | undefined;
  files: any[];
  sessions: any[];
  sessionSourceFilter: Record<string, Set<string> | null>;
  sessionHistoryLoading: boolean;
  expandedDirs: Set<string>;
  onToggleDirectory: (dir: string) => void;
  onCollapseAllDirectories: () => void;
  setFileMenu: any;
  refreshFiles: any;
  projects: any[];
  refreshProjectSessions: any;
  runOpenSidebarSession: any;
  isSameSessionPath: any;
  runCopySession: any;
  runExportHistorySession: any;
  runDeleteHistorySession: any;
  viewFilePath: any;
  openFilePath: any;
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

export interface DrawerSurfaceProps {
  drawer: WorkspaceDrawerPanel | null;
  drawerCollapsed: boolean;
  drawerPinned: boolean;
  editor: DrawerEditorPort;
  git: DrawerGitPort;
  chrome: DrawerChromePort;
  browser: DrawerBrowserPort;
  files: DrawerFilesPort;
}

export function DrawerSurface(props: DrawerSurfaceProps) {
  const { drawer, drawerCollapsed, drawerPinned, editor, git, chrome, browser, files } = props;

  const theme: "dark" | "light" =
    typeof document !== "undefined" && document.documentElement.dataset.theme === "dark"
      ? "dark"
      : "light";

  return (
    <>
      {/* 编辑器是一等抽屉面板：无 activeTab 时渲染空状态而不是整块消失 */}
      {editor.editorMode === "drawer" && drawer === "editor" && !drawerCollapsed ? (
        <>

          {/* 文件编辑独立 Header：与内容区分离渲染，返回键不依赖文件内容加载（始终可点） */}
          <div className="drawer-header flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/40 bg-background px-3">
            <div className="flex min-w-0 items-center gap-2">
              {editor.activeTab && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="inline-grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  title={t("common.back")}
                  aria-label={t("common.back")}
                  onClick={
                    editor.prevDrawerPanelRef.current && editor.prevDrawerPanelRef.current !== "editor"
                      ? () => {
                          const prev = editor.clearEditorBack();
                          if (prev) chrome.onOpenDrawer(prev);
                        }
                      : () => {
                          editor.closeEditor();
                          chrome.onCloseDrawer();
                        }
                  }
                >
                  <ArrowLeft size={16} />
                </Button>
              )}
              <strong className="shrink-0 text-body font-semibold text-foreground">{t("editor.fileEditor")}</strong>
            </div>
            {editor.activeTab && (
              <span className="min-w-0 flex-1 truncate text-right font-mono text-caption text-muted-foreground" title={editor.activeTab.filePath}>
                {editor.activeTab.filePath.split(/[\\/]/).pop()}
              </span>
            )}
            <div className="drawer-header-actions flex shrink-0 items-center gap-1">
              <Button type="button" variant="ghost" size="icon-sm" className="inline-grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground" onClick={chrome.onCollapseDrawer} title={t("drawer.collapsePanel")}>
                <Minus size={15} />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" className="inline-grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground" onClick={() => { editor.closeEditor(); chrome.onCloseDrawer(); }} title={t("common.close")}>
                <X size={15} />
              </Button>
            </div>
          </div>
          {editor.activeTab ? (
            <Suspense fallback={<div className="drawer-content-frame"><div className="file-diff-loading">{t("drawer.lazyLoading")}</div></div>}>
              <FileDiffViewer
                displayMode="drawer"
                filePath={editor.activeTab.filePath}
                mode={editor.activeTab.mode}
                onToggleMode={editor.activeTab.preserveDrawer ? undefined : editor.toggleEditorMode}
                onBack={undefined}
                originalContent={editor.activeTab.mode === "diff" ? editor.activeTab.originalContent : undefined}
                modifiedContent={editor.activeTab.modifiedContent}
                tabs={editor.editorTabs}
                activeTabId={editor.activeTabId}
                onSelectTab={editor.selectEditorTab}
                onCloseTab={editor.closeEditorTab}
                onClose={() => { editor.closeEditor(); chrome.onCloseDrawer(); }}
                readContent={editor.readEditorFileContent}
                readOriginalContent={editor.readEditorOriginalContent}
                saveContent={editor.activeTab.allowSave ? editor.saveEditorFileContent : undefined}
                theme={theme}
                maxFileSizeMB={editor.maxEditorFileSizeMB}
              />
            </Suspense>
          ) : (
            /* 空状态：引导用户从文件面板打开文件；文件树与编辑器互为独立面板，经 rail 往返 */
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              <SquarePen size={28} className="text-muted-foreground/50" aria-hidden="true" />
              <div className="text-body font-medium text-foreground">{t("editor.emptyTitle")}</div>
              <p className="max-w-60 text-caption text-muted-foreground">{t("editor.emptyHint")}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => chrome.onOpenDrawer("files")}
              >
                {t("editor.emptyOpenFiles")}
              </Button>
            </div>
          )}
        </>
      ) : drawer === "browser" && !drawerCollapsed ? (
        <div className="drawer-content-frame flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* 与 files/git 对齐的抽屉标题栏：浏览器面板此前缺 header，点叉无法关闭侧边栏 */}
          <div className="drawer-header flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/40 bg-background px-3">
            <strong className="truncate text-body font-semibold text-foreground">{files.t("app.browser")}</strong>
            <div className="drawer-header-actions flex shrink-0 items-center gap-1">
              <Button type="button" variant="ghost" size="icon-sm" className="inline-grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground" onClick={chrome.onCollapseDrawer} title={files.t("drawer.collapsePanel")}>
                <Minus size={15} />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" className="inline-grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground" onClick={chrome.onCloseDrawer} title={files.t("common.close")}>
                <X size={15} />
              </Button>
            </div>
          </div>
          <BrowserSurface
            fullscreen={browser.browserFullscreen}
            onClose={browser.onCloseBrowser}
            onMinimize={browser.onMinimizeBrowser}
            onEnterFullscreen={browser.onEnterBrowserFullscreen}
          />
        </div>
      ) : git.enableGitManagement && drawer === "git" && !drawerCollapsed && git.activeProjectId ? (
        <div className="drawer-content-frame flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="drawer-header flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border/40 bg-background px-3">
            <strong className="truncate text-body font-semibold text-foreground">{files.t("drawer.sourceControl")}</strong>
            <div className="drawer-header-actions flex shrink-0 items-center gap-1">
              <Button type="button" variant="ghost" size="icon-sm" className="inline-grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground" onClick={chrome.onCollapseDrawer} title={files.t("drawer.collapsePanel")}>
                <Minus size={15} />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" className="inline-grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground" onClick={chrome.onCloseDrawer} title={files.t("common.close")}>
                <X size={15} />
              </Button>
            </div>
          </div>
          <div className="git-drawer-stack" data-detail-open={Boolean(git.gitDrawerDiff && git.gitDiffDisplayMode === "drawer")}>
            <div className="git-drawer-source" aria-hidden={Boolean(git.gitDrawerDiff && git.gitDiffDisplayMode === "drawer")}>
              <GitPanel
                projectId={git.activeProjectId}
                projectRoot={files.projects.find((project: any) => project.id === git.activeProjectId)?.path}
                commitLog={git.gitApi.commitLog}
                commitDetail={git.gitApi.commitDetail}
                onOpenCommitFileDiff={git.openCommitFileDiff}
                onOpenWorkspaceFileDiff={git.openWorkspaceFileDiff}
                branchCompare={git.gitApi.branchCompare}
                getStatus={git.gitApi.status}
                stageFiles={git.gitApi.stage}
                unstageFiles={git.gitApi.unstage}
                discardFile={git.gitApi.discard}
                commit={git.gitApi.commit}
                branches={git.gitInfo.branches}
                currentBranch={git.gitInfo.current}
                onSwitchBranch={git.switchBranch}
                onCreateBranch={git.createBranch}
                cherryPick={git.gitApi.cherryPick}
                revert={git.gitApi.revert}
                reset={git.gitApi.reset}
                dropCommit={git.gitApi.dropCommit}
                generateCommitMessage={git.gitApi.generateCommitMessage}
                gitInit={git.gitApi.init}
                push={git.gitApi.push}
                pull={git.gitApi.pull}
              />
            </div>
            {git.gitDrawerDiff && git.gitDrawerDiff.projectId === git.activeProjectId && git.gitDiffDisplayMode === "drawer" && (
              <div className="git-drawer-detail">
                <Suspense fallback={<div className="file-diff-loading">{t("drawer.lazyLoading")}</div>}>
                  <FileDiffViewer
                    displayMode="drawer"
                    filePath={git.gitDrawerDiff.filePath}
                    mode="diff"
                    onToggleMode={git.toggleGitDiffDisplayMode}
                    originalContent={git.gitDrawerDiff.originalContent}
                    modifiedContent={git.gitDrawerDiff.modifiedContent}
                    tabs={[{ id: git.gitDrawerDiff.filePath, filePath: git.gitDrawerDiff.filePath, label: git.gitDrawerDiff.label }]}
                    activeTabId={git.gitDrawerDiff.filePath}
                    onClose={git.closeGitDiff}
                    readContent={editor.readEditorFileContent}
                    theme={theme}
                    maxFileSizeMB={editor.maxEditorFileSizeMB}
                  />
                </Suspense>
              </div>
            )}
          </div>
        </div>
      ) : drawer && drawer !== "browser" && drawer !== "editor" && drawer !== "git" ? (
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
              {t("drawer.lazyLoading")}
            </div>
          }
        >
          <DrawerContent
            panel={drawer}
            project={drawer === "sessions" ? files.sessionsProject : undefined}
            files={files.files}
            sessions={(files.sessionsProjectId && files.sessionSourceFilter[files.sessionsProjectId as string]) ? files.sessions.filter(
              (s: any) => !s.parentSessionPath && (files.sessionSourceFilter[files.sessionsProjectId as string]!)!.has(s.source ?? "pi"),
            ).concat(files.sessions.filter((s: any) => s.parentSessionPath && (files.sessionSourceFilter[files.sessionsProjectId as string]!)!.has(s.source ?? "pi"))) : files.sessions}
            sessionsLoading={files.sessionHistoryLoading}
            expandedDirs={files.expandedDirs}
            onToggleDirectory={files.onToggleDirectory}
            onCollapseAllDirectories={files.onCollapseAllDirectories}
            pinned={drawerPinned}
            onTogglePin={chrome.onToggleDrawerPin}
            onCollapse={chrome.onCollapseDrawer}
            onClose={chrome.onCloseDrawer}
            onFileContextMenu={(node: any, x: number, y: number) => files.setFileMenu({ node, x, y })}
            onRefreshFiles={() => {
              files.refreshFiles(git.activeProjectId);
            }}
            onOpenFolder={() => {
              const p = files.projects.find((p: any) => p.id === git.activeProjectId);
              if (p) void files.api.files.open(p.path);
            }}
            projectRoot={files.projectRoot}
            onDropFiles={files.onDropFiles}
            onPasteFiles={files.onPasteFiles}
            onMoveFiles={files.onMoveFiles}
            onRefreshSessions={() => {
              const projectId = files.sessionsProjectId ?? git.activeProjectId;
              if (projectId) void files.refreshProjectSessions(projectId, true);
            }}
            onOpenSession={(session: any) =>
              void files.runOpenSidebarSession(
                files.sessionsProjectId ?? git.activeProjectId ?? "",
                session,
              )
            }
            onRenameSession={async (filePath: string, newName: string) => {
              const session = files.sessions.find((candidate: any) =>
                files.isSameSessionPath(
                  candidate.filePath,
                  filePath,
                  candidate.wsl ? "wsl" : "native",
                ),
              );
              if (!session) return;
              await files.api.sessions.updateRecord(session.id, { title: newName });
              const projectId = files.sessionsProjectId ?? git.activeProjectId;
              if (projectId) await files.refreshProjectSessions(projectId, true);
            }}
            onCopySession={(session: any) =>
              files.runCopySession(
                session.id,
                files.sessionsProjectId ?? git.activeProjectId,
              )
            }
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
