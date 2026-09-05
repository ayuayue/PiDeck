import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentTab,
  CommitEntry,
  GitChangedFile,
  GitResourceGroupType,
  Project,
  ProjectFileAccessScope,
} from "../../../shared/types";
import type {
  WorkspaceContentOpenMode,
} from "../../../shared/types/settings";
import type { DrawerPanel, SessionModifiedFile } from "../components/app/AppParts";
import {
  openPermanentEditorTab,
  openPreviewEditorTab,
  promotePreviewEditorTab as nextPreviewAfterPromote,
  type EditorTabOpenMode,
} from "../utils/editorTabs";
import { resolveFileLinkPath } from "../utils/filePathLinks";

const EDITOR_TAB_LIMIT = 5;
const EDITOR_TAB_TEXT_BUDGET = 24 * 1024 * 1024;

interface EditorTab {
  id: string;
  filePath: string;
  mode: "view" | "diff";
  originalContent: string;
  modifiedContent?: string;
  allowSave: boolean;
  tabKey?: string;
  label?: string;
  preserveDrawer?: boolean;
  /** 打开后滚动定位的目标行（1 起，来自 `path:line` 链接位置标记）；
   * 仅显式携带时写入，普通重复点击不覆盖已有定位。 */
  initialLine?: number;
  /** 项目文件入口的读取授权；随 tab 固化，不能在加载时改读当前焦点项目。 */
  fileAccessScope?: ProjectFileAccessScope;
  lastAccess: number;
}

interface GitDrawerDiff {
  projectId: string;
  filePath: string;
  originalContent: string;
  modifiedContent: string;
  label: string;
}

export interface UseFileEditorInput {
  activeProjectId: string | undefined;
  activeProjectIdRef: React.MutableRefObject<string | undefined>;
  activeAgent: AgentTab | null;
  activeProject: Project | null;
  drawer: DrawerPanel | null;
  modifiedFiles: SessionModifiedFile[];
  setDrawer: (panel: DrawerPanel | null) => void;
  setDrawerCollapsed: (collapsed: boolean) => void;
  /** 设置中的默认打开方式；每次新打开文件/Diff 时采用 */
  contentOpenMode: WorkspaceContentOpenMode;
  showToast: (message: string, duration?: number) => void;
  /** 读取文件内容的 API；maxBytes 用于编辑器大文件前置拦截（主进程 stat 检查，不传输超限内容） */
  readFileContent: (
    path: string,
    maxBytes?: number,
    scope?: ProjectFileAccessScope,
  ) => Promise<string>;
  /** 读取 Git 原始内容的 API */
  readGitOriginalContent: (path: string) => Promise<string>;
  /** 保存文件内容的 API；项目来源的 tab 必须把同一授权 scope 带到写入边界 */
  writeFileContent: (
    path: string,
    content: string,
    scope?: ProjectFileAccessScope,
  ) => Promise<void>;
  /** 系统打开文件 */
  openFile: (path: string) => Promise<void>;
  /** 获取 Git 工作区差异 */
  workspaceFileDiff: (
    projectId: string,
    group: GitResourceGroupType,
    path: string,
    repoPath?: string,
  ) => Promise<{
    path: string;
    originalContent: string;
    modifiedContent: string;
  } | null>;
  /** 获取 Git 提交文件差异 */
  commitFileDiff: (
    projectId: string,
    hash: string,
    path: string,
    originalPath?: string,
    repoPath?: string,
  ) => Promise<{
    path: string;
    originalContent: string;
    modifiedContent: string;
  } | null>;
  /** 翻译函数 */
  t: (...args: any[]) => string;
}

export interface UseFileEditorOutput {
  /** 中间栏内容布局：分屏或占满中间栏（不再进侧栏抽屉） */
  editorMode: WorkspaceContentOpenMode;
  toggleEditorMode: () => void;
  editorTabs: EditorTab[];
  activeTabId: string | null;
  activeTab: EditorTab | null;
  editorTabAccessSequenceRef: React.MutableRefObject<number>;
  readEditorFileContent: (
    path: string,
    maxBytes?: number,
    scope?: ProjectFileAccessScope,
  ) => Promise<string>;
  readEditorOriginalContent: (path: string) => Promise<string>;
  saveEditorFileContent: (
    path: string,
    content: string,
    scope?: ProjectFileAccessScope,
  ) => Promise<void>;
  openEditorTab: (
    path: string,
    mode: "view" | "diff",
    originalContent?: string,
    modifiedContent?: string,
    allowSave?: boolean,
    tabKey?: string,
    label?: string,
    preserveDrawer?: boolean,
    openMode?: EditorTabOpenMode,
    initialLine?: number,
    fileAccessScope?: ProjectFileAccessScope,
  ) => void;
  closeEditorTab: (tabId: string) => void;
  selectEditorTab: (tabId: string) => void;
  /** 双击预览 Tab → 常驻 */
  promotePreviewEditorTab: (tabId: string) => void;
  /** VS Code 式预览 Tab id（斜体）；至多一个 */
  previewEditorTabId: string | null;
  openFilePath: (path: string) => void;
  /** 单击默认 preview；双击传 permanent */
  viewFilePath: (
    path: string,
    openMode?: EditorTabOpenMode,
    initialLine?: number,
    fileAccessScope?: ProjectFileAccessScope,
  ) => void;
  diffFilePath: (path: string, originalContent?: string, content?: string) => void;
  openWorkspaceFileDiff: (
    group: GitResourceGroupType,
    path: string,
    repoPath?: string,
  ) => Promise<void>;
  openCommitFileDiff: (
    commit: CommitEntry,
    file: GitChangedFile,
    repoPath?: string,
  ) => Promise<void>;
  closeGitDiff: () => void;
  /** 仅关掉 Git Diff、保留文件 tab（与 closeGitDiff 不同：后者连 tab 一起清）。 */
  dismissGitDiff: () => void;
  gitDiffDisplayMode: WorkspaceContentOpenMode;
  gitDrawerDiff: GitDrawerDiff | null;
  toggleGitDiffDisplayMode: () => void;
  closeEditor: () => void;
  prevDrawerPanelRef: React.MutableRefObject<DrawerPanel | null>;
  clearEditorBack: () => DrawerPanel | null;
  gitDiffRequestSequenceRef: React.MutableRefObject<number>;
}

export function useFileEditor(input: UseFileEditorInput): UseFileEditorOutput {
  const {
    activeProjectId,
    activeProjectIdRef,
    activeAgent,
    activeProject,
    drawer,
    modifiedFiles,
    setDrawer,
    setDrawerCollapsed,
    contentOpenMode,
    showToast,
    readFileContent,
    readGitOriginalContent,
    writeFileContent,
    openFile,
    workspaceFileDiff,
    commitFileDiff,
    t,
  } = input;

  const contentOpenModeRef = useRef(contentOpenMode);
  contentOpenModeRef.current = contentOpenMode;

  // ---- 中间栏内容布局（split | maximize）----
  const [editorMode, setEditorMode] = useState<WorkspaceContentOpenMode>(contentOpenMode);
  const editorModeRef = useRef<WorkspaceContentOpenMode>(contentOpenMode);
  const toggleEditorMode = useCallback(() => {
    const next: WorkspaceContentOpenMode =
      editorModeRef.current === "maximize" ? "split" : "maximize";
    editorModeRef.current = next;
    setEditorMode(next);
  }, []);

  // ---- Git diff state（展示在中间栏 ContentHost，不再叠在抽屉里）----
  const gitDiffRequestSequenceRef = useRef(0);
  const [gitDrawerDiff, setGitDrawerDiff] = useState<GitDrawerDiff | null>(null);
  const [gitDiffDisplayMode, setGitDiffDisplayMode] =
    useState<WorkspaceContentOpenMode>(contentOpenMode);

  const toggleGitDiffDisplayMode = useCallback(() => {
    setGitDiffDisplayMode((mode) => (mode === "maximize" ? "split" : "maximize"));
  }, []);

  useEffect(() => {
    gitDiffRequestSequenceRef.current += 1;
    setGitDrawerDiff(null);
    setGitDiffDisplayMode(contentOpenModeRef.current);
  }, [activeProjectId]);

  // ---- editor tabs ----
  const editorTabAccessSequenceRef = useRef(0);
  const [editorTabs, setEditorTabs] = useState<EditorTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  /** VS Code 式预览 Tab：至多一个；单击打开会替换它 */
  const [previewEditorTabId, setPreviewEditorTabId] = useState<string | null>(
    null,
  );
  // tabs / preview 同步 ref：openEditorTab/closeEditorTab 需要在 updater 外计算 next——
  // StrictMode 双调用 updater 内的 crypto.randomUUID/setActiveTabId 会产生两个
  // 不同 id，导致 activeTabId 与 editorTabs 不一致 → 首次打开文件空白
  const editorTabsRef = useRef<EditorTab[]>([]);
  editorTabsRef.current = editorTabs;
  const previewEditorTabIdRef = useRef<string | null>(null);
  previewEditorTabIdRef.current = previewEditorTabId;
  const activeTab = useMemo(
    () => editorTabs.find((t) => t.id === activeTabId) ?? null,
    [editorTabs, activeTabId],
  );

  /** 仅关掉 Git Diff，保留文件 tab（打开文件时不应毁掉已有预览/常驻栏） */
  const dismissGitDiffOnly = useCallback(() => {
    gitDiffRequestSequenceRef.current += 1;
    setGitDrawerDiff(null);
    setGitDiffDisplayMode(contentOpenModeRef.current);
  }, []);

  /** 关掉中间栏阅读面：Git Diff + 文件 tab 一并清掉，避免关 Diff 后又露出文件面 */
  const dismissWorkbenchContent = useCallback(() => {
    gitDiffRequestSequenceRef.current += 1;
    setGitDrawerDiff(null);
    setGitDiffDisplayMode(contentOpenModeRef.current);
    setActiveTabId(null);
    setEditorTabs([]);
    setPreviewEditorTabId(null);
    editorModeRef.current = contentOpenModeRef.current;
    setEditorMode(contentOpenModeRef.current);
  }, []);

  // ---- IO callbacks ----
  const readEditorFileContent = useCallback(
    (path: string, maxBytes?: number, scope?: ProjectFileAccessScope) =>
      readFileContent(path, maxBytes, scope),
    [readFileContent],
  );
  const readEditorOriginalContent = useCallback(
    (path: string) => readGitOriginalContent(path),
    [readGitOriginalContent],
  );
  const saveEditorFileContent = useCallback(
    (path: string, content: string, scope?: ProjectFileAccessScope) =>
      writeFileContent(path, content, scope),
    [writeFileContent],
  );

  // ---- tab management helpers ----
  const editorTabTextBytes = (tab: EditorTab) =>
    (tab.originalContent.length + (tab.modifiedContent?.length ?? 0)) * 2;

  const trimEditorTabs = (tabs: EditorTab[], protectedId: string) => {
    const next = [...tabs];
    let textBytes = next.reduce(
      (sum, tab) => sum + editorTabTextBytes(tab),
      0,
    );
    while (
      next.length > 1 &&
      (next.length > EDITOR_TAB_LIMIT || textBytes > EDITOR_TAB_TEXT_BUDGET)
    ) {
      const candidates = next.filter((tab) => tab.id !== protectedId);
      if (candidates.length === 0) break;
      const oldest = candidates.reduce((left, right) =>
        left.lastAccess <= right.lastAccess ? left : right,
      );
      const index = next.findIndex((tab) => tab.id === oldest.id);
      const [removed] = next.splice(index, 1);
      if (removed) textBytes -= editorTabTextBytes(removed);
    }
    return next;
  };

  const openEditorTab = useCallback(
    (
      path: string,
      mode: "view" | "diff",
      originalContent?: string,
      modifiedContent?: string,
      allowSave = true,
      tabKey?: string,
      label?: string,
      preserveDrawer = false,
      openMode: EditorTabOpenMode = "permanent",
      initialLine?: number,
      fileAccessScope?: ProjectFileAccessScope,
    ) => {
      // updater 纯化：StrictMode 双调用下，updater 内 crypto.randomUUID/嵌套
      // setState 会产生两个不同 id → activeTabId 与 editorTabs 不一致 → 首次空白。
      // 改为在闭包内读同步 ref 计算 next，setState 传值（幂等，双调用安全）
      // 预览/常驻名单由 editorTabs 纯策略决定；内容字段再写回 active tab。
      const prev = editorTabsRef.current;
      const previewId = previewEditorTabIdRef.current;
      const candidate: EditorTab = {
        id: crypto.randomUUID(),
        filePath: path,
        mode,
        originalContent: originalContent ?? "",
        modifiedContent,
        allowSave,
        tabKey,
        label,
        preserveDrawer,
        ...(initialLine !== undefined ? { initialLine } : {}),
        fileAccessScope,
        lastAccess: ++editorTabAccessSequenceRef.current,
      };
      const strategy =
        openMode === "preview"
          ? openPreviewEditorTab(prev, previewId, candidate)
          : openPermanentEditorTab(prev, previewId, candidate);

      let nextTabs = strategy.tabs.map((tab) =>
        tab.id === strategy.activeId
          ? {
              ...tab,
              mode,
              originalContent: originalContent ?? "",
              modifiedContent,
              allowSave,
              tabKey,
              label,
              preserveDrawer,
              ...(initialLine !== undefined ? { initialLine } : {}),
              fileAccessScope,
              lastAccess: candidate.lastAccess,
            }
          : tab,
      );
      nextTabs = trimEditorTabs(nextTabs, strategy.activeId);
      // trim 可能挤掉预览 Tab；预览 id 必须以仍在列表中的为准
      const nextPreview =
        strategy.previewId &&
        nextTabs.some((tab) => tab.id === strategy.previewId)
          ? strategy.previewId
          : null;

      setEditorTabs(nextTabs);
      setActiveTabId(strategy.activeId);
      setPreviewEditorTabId(nextPreview);
    },
    [],
  );

  const closeEditorTab = useCallback(
    (tabId: string) => {
      // updater 纯化（同上）：副作用移出
      const prev = editorTabsRef.current;
      const idx = prev.findIndex((t) => t.id === tabId);
      if (idx < 0) return;
      const next = prev.filter((t) => t.id !== tabId);
      setEditorTabs(next);
      setPreviewEditorTabId((current) => (current === tabId ? null : current));
      if (next.length === 0) {
        setActiveTabId(null);
        setPreviewEditorTabId(null);
        // 关闭最后一个 tab 后复位为设置默认布局，避免残留 maximize
        editorModeRef.current = contentOpenModeRef.current;
        setEditorMode(contentOpenModeRef.current);
      } else if (tabId === activeTabId) {
        const neighborIdx = Math.min(idx, next.length - 1);
        setActiveTabId(next[neighborIdx].id);
      }
    },
    [activeTabId],
  );

  const selectEditorTab = useCallback((tabId: string) => {
    setEditorTabs((current) =>
      current.map((tab) =>
        tab.id === tabId
          ? { ...tab, lastAccess: ++editorTabAccessSequenceRef.current }
          : tab,
      ),
    );
    setActiveTabId(tabId);
  }, []);

  /** 双击预览 Tab → 常驻（清 preview 标记） */
  const promotePreviewEditorTab = useCallback((tabId: string) => {
    setPreviewEditorTabId((current) =>
      nextPreviewAfterPromote(current, tabId),
    );
  }, []);

  // ---- drawer panel restore ref ----
  const prevDrawerPanelRef = useRef<DrawerPanel | null>(null);

  const clearEditorBack = useCallback(() => {
    const prev = prevDrawerPanelRef.current;
    prevDrawerPanelRef.current = null;
    setActiveTabId(null);
    setEditorTabs([]);
    setPreviewEditorTabId(null);
    return prev;
  }, []);

  const closeEditor = useCallback(() => {
    setActiveTabId(null);
    setEditorTabs([]);
    setPreviewEditorTabId(null);
    editorModeRef.current = contentOpenModeRef.current;
    setEditorMode(contentOpenModeRef.current);
  }, []);

  // 注意：不要在 tab 清空时自动 setDrawer(null)。编辑器 rail 仍是活动栏入口，
  // 空 tab 时由 DrawerSurface 渲染空状态引导；阅读面已迁到中间栏 ContentHost。

  // ---- file actions ----
  const openFilePath = useCallback(
    (path: string) => {
      const resolvedPath = resolveFileLinkPath(
        path,
        activeAgent?.cwd ?? activeProject?.path,
      );
      if (!resolvedPath) {
        showToast(t("app.fileLinkCannotResolve", { path }));
        return;
      }
      void openFile(resolvedPath).catch((error) => {
        showToast(
          t("app.openFileFailed", {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    },
    [activeAgent?.cwd, activeProject?.path, openFile, showToast, t],
  );

  const viewFilePath = useCallback(
    (
      path: string,
      openMode: EditorTabOpenMode = "preview",
      initialLine?: number,
      fileAccessScope?: ProjectFileAccessScope,
    ) => {
      // 只清 Git Diff，保留已有文件 tab——否则预览/多 tab 无法成立
      dismissGitDiffOnly();
      openEditorTab(
        path,
        "view",
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        false,
        openMode,
        initialLine,
        fileAccessScope,
      );
      const mode = contentOpenModeRef.current;
      editorModeRef.current = mode;
      setEditorMode(mode);
      // 阅读面进中间栏；抽屉保持文件树导航，不再切到 editor 面板
      prevDrawerPanelRef.current = drawer;
    },
    [drawer, openEditorTab, dismissGitDiffOnly],
  );

  const diffFilePath = useCallback(
    (path: string, originalContent?: string, content?: string) => {
      const modified = modifiedFiles.find((f) => f.path === path);
      const resolvedOriginal =
        originalContent ?? modified?.originalContent ?? "";
      const resolvedModified = content ?? modified?.content ?? undefined;
      dismissGitDiffOnly();
      const mode = contentOpenModeRef.current;
      editorModeRef.current = mode;
      setEditorMode(mode);
      // Diff 来自明确意图（消息/工具），按常驻打开，避免被下次单击预览挤掉
      openEditorTab(
        path,
        "diff",
        resolvedOriginal,
        resolvedModified,
        true,
        undefined,
        undefined,
        false,
        "permanent",
      );
    },
    [modifiedFiles, dismissGitDiffOnly, openEditorTab],
  );

  const openWorkspaceFileDiffFn = useCallback(
    async (group: GitResourceGroupType, path: string, repoPath?: string) => {
      if (!activeProjectId) return;
      const projectId = activeProjectId;
      const request = ++gitDiffRequestSequenceRef.current;
      try {
        // repoPath 来自 Git 侧栏当前选中仓库；缺省仍读项目根，兼容单仓。
        const diff = await workspaceFileDiff(projectId, group, path, repoPath);
        if (
          activeProjectIdRef.current !== projectId ||
          request !== gitDiffRequestSequenceRef.current
        )
          return;
        if (!diff) {
          showToast(t("git.workspaceDiffUnavailable"));
          return;
        }
        const groupLabel =
          group === "index"
            ? t("git.stagedChanges")
            : group === "merge"
              ? t("git.mergeChanges")
              : t("git.changes");
        const mode = contentOpenModeRef.current;
        // Diff 独占阅读面：清掉文件 tab，避免关 Diff 后又弹回文件
        setActiveTabId(null);
        setEditorTabs([]);
        setPreviewEditorTabId(null);
        editorModeRef.current = mode;
        setEditorMode(mode);
        setGitDiffDisplayMode(mode);
        setGitDrawerDiff({
          projectId,
          filePath: diff.path,
          originalContent: diff.originalContent,
          modifiedContent: diff.modifiedContent,
          label: `${diff.path.split(/[/\\]/).pop() ?? diff.path} (${groupLabel})`,
        });
      } catch (error) {
        if (
          activeProjectIdRef.current === projectId &&
          request === gitDiffRequestSequenceRef.current
        ) {
          showToast(
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    },
    [
      activeProjectId,
      activeProjectIdRef,
      workspaceFileDiff,
      showToast,
      t,
    ],
  );

  const openCommitFileDiffFn = useCallback(
    async (commit: CommitEntry, file: GitChangedFile, repoPath?: string) => {
      if (!activeProjectId) return;
      const projectId = activeProjectId;
      const request = ++gitDiffRequestSequenceRef.current;
      try {
        const diff = await commitFileDiff(
          projectId,
          commit.hash,
          file.path,
          file.originalPath,
          repoPath,
        );
        if (
          activeProjectIdRef.current !== projectId ||
          request !== gitDiffRequestSequenceRef.current
        )
          return;
        if (!diff) {
          showToast(t("git.fileDiffUnavailable"));
          return;
        }
        const mode = contentOpenModeRef.current;
        setActiveTabId(null);
        setEditorTabs([]);
        setPreviewEditorTabId(null);
        editorModeRef.current = mode;
        setEditorMode(mode);
        setGitDiffDisplayMode(mode);
        setGitDrawerDiff({
          projectId,
          filePath: diff.path,
          originalContent: diff.originalContent,
          modifiedContent: diff.modifiedContent,
          label: `${diff.path.split(/[/\\]/).pop() ?? diff.path} (${commit.shortHash})`,
        });
      } catch (error) {
        if (
          activeProjectIdRef.current === projectId &&
          request === gitDiffRequestSequenceRef.current
        ) {
          showToast(
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    },
    [
      activeProjectId,
      activeProjectIdRef,
      commitFileDiff,
      showToast,
      t,
    ],
  );

  return {
    editorMode,
    toggleEditorMode,
    editorTabs,
    activeTabId,
    activeTab,
    editorTabAccessSequenceRef,
    readEditorFileContent,
    readEditorOriginalContent,
    saveEditorFileContent,
    openEditorTab,
    closeEditorTab,
    selectEditorTab,
    promotePreviewEditorTab,
    previewEditorTabId,
    openFilePath,
    viewFilePath,
    diffFilePath,
    openWorkspaceFileDiff: openWorkspaceFileDiffFn,
    openCommitFileDiff: openCommitFileDiffFn,
    // 阅读面关闭钮：清 Diff + 文件 tab，避免「关不完」
    closeGitDiff: dismissWorkbenchContent,
    // 与新打开文件 tab 同时使用时只清 Diff：Diff 在阅读面独占优先级，不清的话新 tab 被压住看起来“打不开”。
    dismissGitDiff: dismissGitDiffOnly,
    gitDiffDisplayMode,
    gitDrawerDiff,
    toggleGitDiffDisplayMode,
    gitDiffRequestSequenceRef,
    prevDrawerPanelRef,
    clearEditorBack,
    closeEditor,
  };
}
