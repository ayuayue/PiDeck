import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentTab,
  CommitEntry,
  GitChangedFile,
  GitResourceGroupType,
  Project,
} from "../../../shared/types";
import type { DrawerPanel, SessionModifiedFile } from "../components/app/AppParts";

function isAbsoluteFilePath(path: string) {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/");
}

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
  lastAccess: number;
}

interface GitDrawerDiff {
  projectId: string;
  filePath: string;
  originalContent: string;
  modifiedContent: string;
  label: string;
}

export function resolveFileLinkPath(path: string, basePath?: string) {
  if (!path || isAbsoluteFilePath(path) || !basePath) return path;
  const separator = basePath.includes("\\") ? "\\" : "/";
  return `${basePath.replace(/[\\/]+$/, "")}${separator}${path.replace(/^[\\/]+/, "")}`;
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
  showToast: (message: string, duration?: number) => void;
  /** 读取文件内容的 API */
  readFileContent: (path: string) => Promise<string>;
  /** 读取 Git 原始内容的 API */
  readGitOriginalContent: (path: string) => Promise<string>;
  /** 保存文件内容的 API */
  writeFileContent: (path: string, content: string) => Promise<void>;
  /** 系统打开文件 */
  openFile: (path: string) => Promise<void>;
  /** 获取 Git 工作区差异 */
  workspaceFileDiff: (
    projectId: string,
    group: GitResourceGroupType,
    path: string,
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
  ) => Promise<{
    path: string;
    originalContent: string;
    modifiedContent: string;
  } | null>;
  /** 翻译函数 */
  t: (...args: any[]) => string;
}

export interface UseFileEditorOutput {
  editorMode: "modal" | "drawer";
  toggleEditorMode: () => void;
  editorTabs: EditorTab[];
  activeTabId: string | null;
  activeTab: EditorTab | null;
  editorTabAccessSequenceRef: React.MutableRefObject<number>;
  readEditorFileContent: (path: string) => Promise<string>;
  readEditorOriginalContent: (path: string) => Promise<string>;
  saveEditorFileContent: (path: string, content: string) => Promise<void>;
  openEditorTab: (
    path: string,
    mode: "view" | "diff",
    originalContent?: string,
    modifiedContent?: string,
    allowSave?: boolean,
    tabKey?: string,
    label?: string,
    preserveDrawer?: boolean,
  ) => void;
  closeEditorTab: (tabId: string) => void;
  selectEditorTab: (tabId: string) => void;
  openFilePath: (path: string) => void;
  viewFilePath: (path: string) => void;
  diffFilePath: (path: string, originalContent?: string, content?: string) => void;
  openWorkspaceFileDiff: (group: GitResourceGroupType, path: string) => Promise<void>;
  openCommitFileDiff: (
    commit: CommitEntry,
    file: GitChangedFile,
  ) => Promise<void>;
  closeGitDiff: () => void;
  gitDiffDisplayMode: "modal" | "drawer";
  gitDrawerDiff: GitDrawerDiff | null;
  toggleGitDiffDisplayMode: () => void;
  gitDiffRequestSequenceRef: React.MutableRefObject<number>;
  prevDrawerPanelRef: React.MutableRefObject<DrawerPanel | null>;
  clearEditorBack: () => DrawerPanel | null;
  closeEditor: () => void;
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
    showToast,
    readFileContent,
    readGitOriginalContent,
    writeFileContent,
    openFile,
    workspaceFileDiff,
    commitFileDiff,
    t,
  } = input;

  // drawer 同步 ref：toggleEditorMode/最小化等回调需要读取当前抽屉面板（返回键来源）
  const drawerRef = useRef(drawer);
  drawerRef.current = drawer;

  // ---- editor mode ----
  const [editorMode, setEditorMode] = useState<"modal" | "drawer">("drawer");
  // 修复：updater 必须是纯函数（StrictMode 双调用），抽屉展开副作用移到 updater 外——
  // 否则 setDrawer 更新可能被丢弃，表现为"最小化到侧边栏没有效果"
  const editorModeRef = useRef<"modal" | "drawer">("drawer");
  const toggleEditorMode = useCallback(() => {
    const next = editorModeRef.current === "modal" ? "drawer" : "modal";
    editorModeRef.current = next;
    setEditorMode(next);
    if (next === "drawer") {
      // 从 modal 最小化：来源面板为空时才记录（从文件树打开时 viewFilePath 已记录 files）
      if (!prevDrawerPanelRef.current) prevDrawerPanelRef.current = drawerRef.current;
      setDrawer("editor");
      setDrawerCollapsed(false);
    } else {
      // 展开到 modal：必须收起抽屉——否则 drawer 面板仍是 "editor"，
      // 最小化时 openDrawer("editor") 命中 toggle 语义（同面板）→ 关闭抽屉 = "最小化没效果"
      setDrawer(null);
    }
  }, [setDrawer, setDrawerCollapsed]);

  // ---- Git diff state ----
  const gitDiffRequestSequenceRef = useRef(0);
  const [gitDrawerDiff, setGitDrawerDiff] = useState<GitDrawerDiff | null>(null);
  const [gitDiffDisplayMode, setGitDiffDisplayMode] = useState<"modal" | "drawer">("drawer");

  const closeGitDiff = useCallback(() => {
    gitDiffRequestSequenceRef.current += 1;
    setGitDrawerDiff(null);
    setGitDiffDisplayMode("drawer");
  }, []);

  const toggleGitDiffDisplayMode = useCallback(() => {
    if (gitDiffDisplayMode === "drawer") {
      setEditorMode("drawer");
      setGitDiffDisplayMode("modal");
      return;
    }
    setDrawer("git");
    setDrawerCollapsed(false);
    setGitDiffDisplayMode("drawer");
  }, [gitDiffDisplayMode, setDrawer, setDrawerCollapsed]);

  useEffect(() => {
    gitDiffRequestSequenceRef.current += 1;
    setGitDrawerDiff(null);
    setGitDiffDisplayMode("drawer");
  }, [activeProjectId]);

  useEffect(() => {
    if (drawer !== "git" && gitDiffDisplayMode === "drawer") {
      gitDiffRequestSequenceRef.current += 1;
      if (gitDrawerDiff) setGitDrawerDiff(null);
    }
  }, [drawer, gitDiffDisplayMode, gitDrawerDiff]);

  // ---- editor tabs ----
  const editorTabAccessSequenceRef = useRef(0);
  const [editorTabs, setEditorTabs] = useState<EditorTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  // tabs 同步 ref：openEditorTab/closeEditorTab 需要在 updater 外计算 next——
  // StrictMode 双调用 updater 内的 crypto.randomUUID/setActiveTabId 会产生两个
  // 不同 id，导致 activeTabId 与 editorTabs 不一致 → 首次打开文件空白
  const editorTabsRef = useRef<EditorTab[]>([]);
  editorTabsRef.current = editorTabs;
  const activeTab = useMemo(
    () => editorTabs.find((t) => t.id === activeTabId) ?? null,
    [editorTabs, activeTabId],
  );

  // ---- IO callbacks ----
  const readEditorFileContent = useCallback(
    (path: string) => readFileContent(path),
    [readFileContent],
  );
  const readEditorOriginalContent = useCallback(
    (path: string) => readGitOriginalContent(path),
    [readGitOriginalContent],
  );
  const saveEditorFileContent = useCallback(
    (path: string, content: string) => writeFileContent(path, content),
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
    ) => {
      // updater 纯化：StrictMode 双调用下，updater 内 crypto.randomUUID/嵌套
      // setState 会产生两个不同 id → activeTabId 与 editorTabs 不一致 → 首次空白。
      // 改为在闭包内读同步 ref 计算 next，setState 传值（幂等，双调用安全）
      const prev = editorTabsRef.current;
      const existing = prev.find(
        (t) => t.filePath === path && t.tabKey === tabKey,
      );
      if (existing) {
        const updated = {
          ...existing,
          mode,
          originalContent: originalContent ?? "",
          modifiedContent,
          allowSave,
          tabKey,
          label,
          preserveDrawer,
          lastAccess: ++editorTabAccessSequenceRef.current,
        };
        setEditorTabs(
          trimEditorTabs(
            prev.map((tab) => (tab.id === existing.id ? updated : tab)),
            existing.id,
          ),
        );
        setActiveTabId(existing.id);
        return;
      }
      const newTab: EditorTab = {
        id: crypto.randomUUID(),
        filePath: path,
        mode,
        originalContent: originalContent ?? "",
        modifiedContent,
        allowSave,
        tabKey,
        label,
        preserveDrawer,
        lastAccess: ++editorTabAccessSequenceRef.current,
      };
      setEditorTabs(trimEditorTabs([...prev, newTab], newTab.id));
      setActiveTabId(newTab.id);
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
      if (next.length === 0) {
        setActiveTabId(null);
        // 编辑器是独立抽屉面板：关闭最后一个 tab 后停留在面板空状态，
        // 并复位 modal 模式——残留 "modal" 会让抽屉分支（editorMode==="drawer" 才渲染）空白
        editorModeRef.current = "drawer";
        setEditorMode("drawer");
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

  // ---- drawer panel restore ref ----
  const prevDrawerPanelRef = useRef<DrawerPanel | null>(null);

  const clearEditorBack = useCallback(() => {
    const prev = prevDrawerPanelRef.current;
    prevDrawerPanelRef.current = null;
    setActiveTabId(null);
    setEditorTabs([]);
    return prev;
  }, []);

  const closeEditor = useCallback(() => {
    setActiveTabId(null);
    setEditorTabs([]);
    // 同 closeEditorTab：复位 modal 残留状态，保证回到抽屉时是正常的编辑器面板
    editorModeRef.current = "drawer";
    setEditorMode("drawer");
  }, []);

  // 注意：不要在 tab 清空时自动 setDrawer(null)。编辑器是活动栏上的一等面板，
  // 空 tab 时由 DrawerSurface 渲染空状态，面板去留交给用户通过 rail/关闭键控制。

  // ---- file actions ----
  const openFilePath = useCallback(
    (path: string) => {
      const resolvedPath = resolveFileLinkPath(
        path,
        activeAgent?.cwd ?? activeProject?.path,
      );
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
    (path: string) => {
      openEditorTab(path, "view");
      // 修复：文件树打开始终进抽屉模式（此前 editorMode=modal 时点文件会开 modal，
      // 且不记录来源面板导致抽屉视图没有返回键）
      editorModeRef.current = "drawer";
      setEditorMode("drawer");
      prevDrawerPanelRef.current = drawer;
      setDrawer("editor");
      setDrawerCollapsed(false);
    },
    [drawer, setDrawer, setDrawerCollapsed, openEditorTab],
  );

  const diffFilePath = useCallback(
    (path: string, originalContent?: string, content?: string) => {
      const modified = modifiedFiles.find((f) => f.path === path);
      const resolvedOriginal =
        originalContent ?? modified?.originalContent ?? "";
      const resolvedModified = content ?? modified?.content ?? undefined;
      closeGitDiff();
      setEditorMode("modal");
      setDrawer(null);
      openEditorTab(path, "diff", resolvedOriginal, resolvedModified);
    },
    [modifiedFiles, closeGitDiff, setDrawer, openEditorTab],
  );

  const openWorkspaceFileDiffFn = useCallback(
    async (group: GitResourceGroupType, path: string) => {
      if (!activeProjectId) return;
      const projectId = activeProjectId;
      const request = ++gitDiffRequestSequenceRef.current;
      try {
        const diff = await workspaceFileDiff(projectId, group, path);
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
        setEditorMode("drawer");
        setGitDiffDisplayMode("drawer");
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
    async (commit: CommitEntry, file: GitChangedFile) => {
      if (!activeProjectId) return;
      const projectId = activeProjectId;
      const request = ++gitDiffRequestSequenceRef.current;
      try {
        const diff = await commitFileDiff(
          projectId,
          commit.hash,
          file.path,
          file.originalPath,
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
        setEditorMode("drawer");
        setGitDiffDisplayMode("drawer");
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
    openFilePath,
    viewFilePath,
    diffFilePath,
    openWorkspaceFileDiff: openWorkspaceFileDiffFn,
    openCommitFileDiff: openCommitFileDiffFn,
    closeGitDiff,
    gitDiffDisplayMode,
    gitDrawerDiff,
    toggleGitDiffDisplayMode,
    gitDiffRequestSequenceRef,
    prevDrawerPanelRef,
    clearEditorBack,
    closeEditor,
  };
}
