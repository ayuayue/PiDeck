import { useState, useRef, useEffect, useCallback } from "react";
import type { Project, FileTreeNode, GitBranchInfo, WorktreeEntry, SessionSummary, SessionRecord } from "../../../shared/types";
import type { SessionLoadState } from "../atoms/session-atoms";
import { sessionRecordToSummary } from "../atoms/session-selectors";
import { loadProjectFileTree } from "../utils/fileTreeLazy";
import { createKeyedWatchdog } from "../utils/catalogLoadWatchdog";

const SESSION_REFRESH_TIMEOUT_MS = 20_000;
const SIDEBAR_PROJECT_CHILD_PAGE_SIZE = 5;
/** loading 兜底观察时长：超时后先静默重试一轮，再超时强制揭开（总共约 2× 本级）。 */
const CATALOG_WATCHDOG_STAGE_MS = 15_000;

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

type UseProjectSyncInput = {
  projects: Project[];
  activeProjectId: string | undefined;
  setProjects: (projects: Project[]) => void;
  setActiveProjectId: (id: string) => void;
  replaceProjectSessions: (input: { projectId: string; sessions: SessionRecord[] }) => void;
  api: {
    projects: { list: () => Promise<Project[]> };
    git: { worktreeList: (projectId: string) => Promise<WorktreeEntry[]>; branches: (projectId: string) => Promise<{ current: string | null; branches: string[] }> };
    settings?: {
      get: () => Promise<{ dshAutoImportSessions?: boolean }>;
    };
    sessions: {
      listCatalog: (projectId: string, options?: { scan?: boolean }) => Promise<SessionRecord[]>;
      /** 后台扫描完成推送（主进程 → 渲染层）；可选，缺省时退化为纯轮询。 */
      onCatalogRefreshed?: (listener: (input: { projectId: string }) => void) => () => void;
      /** 只读扫 $DSH_HOME，把外部根会话写入 catalog；关闭自动导入时调用方不应触发。 */
      syncDshForeignSessions?: () => Promise<{ imported: number; skipped: number }>;
    };
    files: {
      list: (
        projectId: string,
        options?: { maxDepth?: number; directory?: string },
      ) => Promise<FileTreeNode[]>;
    };
  };
  showToast: (message: string, duration?: number) => void;
  setSessionCatalogLoadState?: (input: { projectId: string; state: SessionLoadState }) => void;
  t: typeof import("../i18n").t;
};

type ProjectSessionRefreshResult = SessionSummary[] | SessionRecord[] | undefined;
type ProjectSessionRefreshPromise = Promise<ProjectSessionRefreshResult>;
type ProjectSessionRefreshCompletion = {
  promise: ProjectSessionRefreshPromise;
  resolve: (value: ProjectSessionRefreshResult | PromiseLike<ProjectSessionRefreshResult>) => void;
  reject: (reason?: unknown) => void;
};

function createProjectSessionRefreshCompletion(): ProjectSessionRefreshCompletion {
  let resolveCompletion!: (value: ProjectSessionRefreshResult | PromiseLike<ProjectSessionRefreshResult>) => void;
  let rejectCompletion!: (reason?: unknown) => void;
  const promise = new Promise<ProjectSessionRefreshResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  return { promise, resolve: resolveCompletion, reject: rejectCompletion };
}

export function useProjectSync(input: UseProjectSyncInput) {
  const {
    projects,
    activeProjectId,
    setProjects,
    setActiveProjectId,
    replaceProjectSessions,
    api,
    showToast,
    setSessionCatalogLoadState,
    t,
  } = input;
  const [worktreesByProject, setWorktreesByProject] = useState<Record<string, WorktreeEntry[]>>({});
  const [branchByProject, setBranchByProject] = useState<Record<string, string | null>>({});
  const [files, setFiles] = useState<FileTreeNode[]>([]);
  const [gitInfo, setGitInfo] = useState<GitBranchInfo>({ current: null, branches: [] });
  const [sessionLoadingByProject, setSessionLoadingByProject] = useState<Record<string, boolean>>({});
  const [visibleProjectChildCountByProject, setVisibleProjectChildCountByProject] = useState<Record<string, number>>({});
  // 项目目录 loading 兜底（2026-09）：序号守卫/静默拉取失败会让 loading 永挂，
  // 用两级看门狗保证「重试一轮 → 强制 ready」。实例一次性创建，生命周期随 hook 存活。
  const catalogLoadWatchdogRef = useRef(createKeyedWatchdog());
  const catalogLoadWatchdog = catalogLoadWatchdogRef.current;
  const sessionRequestByProjectRef = useRef<Record<string, number>>({});
  const sessionRefreshRunningRef = useRef<Set<string>>(new Set());
  const sessionRefreshPendingRef = useRef<Set<string>>(new Set());
  const sessionRefreshCompletionByProjectRef = useRef<Record<string, ProjectSessionRefreshCompletion | undefined>>({});
  // #159：文件树刷新按代次丢弃，避免旧项目慢扫描覆盖当前抽屉。
  const fileTreeGenerationRef = useRef(0);
  const activeProjectIdRef = useRef(activeProjectId);
  activeProjectIdRef.current = activeProjectId;

  /** 包一层：任何 loadState 变更（loading/ready/error）都取消该项目看门狗，
   *  只有「一直没被揭开」的 loading 才继续享受超时兜底。 */
  const setCatalogLoadStateGuarded = useCallback(
    (input: { projectId: string; state: SessionLoadState }) => {
      catalogLoadWatchdog.cancel(input.projectId);
      setSessionCatalogLoadState?.(input);
    },
    [catalogLoadWatchdog, setSessionCatalogLoadState],
  );

  // 卸载时清掉全部看门狗定时器，防止回调引用已卸载组件状态
  useEffect(() => () => { catalogLoadWatchdog.cancelAll(); }, [catalogLoadWatchdog]);

  /** 发起新的根树请求；旧代次的 listing 一律丢弃。 */
  const beginFileTreeRequest = useCallback(() => ++fileTreeGenerationRef.current, []);

  const isFileTreeRequestCurrent = useCallback((generation: number, projectId: string) => {
    return fileTreeGenerationRef.current === generation && activeProjectIdRef.current === projectId;
  }, []);

  /**
   * 重新读取项目目录存在性并替换侧栏清单。
   * 缺失目录只标记 missing、不自动移除，避免网络盘/WSL 暂时不可达时丢失项目记录。
   */
  async function refreshProjects(): Promise<Project[]> {
    const next = await api.projects.list();
    setProjects(next);
    if (!activeProjectId && next.length > 0) setActiveProjectId(next[0].id);
    // 失效目录不能继续触发 Git 扫描，否则手动刷新项目后仍会产生 ENOENT 噪音。
    for (const p of next) { if (p.worktreeEnabled && !p.missing) void refreshWorktrees(p.id); }
    return next;
  }

  /** 用户从项目分组菜单发起的全量刷新：重扫清单并给出统一反馈。 */
  async function refreshAllProjects() {
    try {
      const next = await refreshProjects();
      showToast(t("app.projectsRefreshed", { count: next.filter((project) => project.kind !== "chat").length }), 1800);
    } catch (error) {
      showToast(
        t("app.projectsRefreshFailed", {
          // Electron invoke 在部分环境会把 Error 跨 realm 包装，统一去掉可选的 `Error:` 前缀。
          error: String(error instanceof Error ? error.message : error).replace(/^Error:\s*/, ""),
        }),
        4000,
      );
    }
  }

  async function refreshWorktrees(projectId: string) {
    try {
      const [entries, branchInfo] = await Promise.all([
        api.git.worktreeList(projectId),
        api.git.branches(projectId).catch(() => ({ current: null, branches: [] })),
      ]);
      setWorktreesByProject((prev) => ({ ...prev, [projectId]: entries }));
      setBranchByProject((prev) => ({ ...prev, [projectId]: branchInfo.current }));
      const next = await api.projects.list();
      setProjects(next);
    } catch { setWorktreesByProject((prev) => ({ ...prev, [projectId]: [] })); }
  }

  async function refreshSessions(projectId = activeProjectId): Promise<SessionSummary[]> {
    if (!projectId) return [];
    const refreshed: ProjectSessionRefreshResult = await refreshProjectSessions(projectId, true);
    if (!refreshed) return [];
    return refreshed
      // SessionSummary 已带 projectId（会话管理弹窗工作区标签用），不能再以
      // "projectId" in session 区分 Record/Summary；用 Record 独有的 title 判定。
      .map((session) => "title" in session ? sessionRecordToSummary(session) : session)
      .filter((session): session is SessionSummary => Boolean(session))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async function runProjectSessionRefresh(
    projectId: string,
    silent: boolean,
    completion: ProjectSessionRefreshCompletion,
  ): Promise<void> {
    const request = (sessionRequestByProjectRef.current[projectId] ?? 0) + 1;
    sessionRequestByProjectRef.current[projectId] = request;
    sessionRefreshRunningRef.current.add(projectId);

    let result: ProjectSessionRefreshResult = undefined;
    let error: unknown;
    let failed = false;
    try {
      if (!silent) {
        setSessionLoadingByProject((c) => ({ ...c, [projectId]: true }));
        setCatalogLoadStateGuarded({ projectId, state: { status: "loading" } });
        // loading 一旦置位就挂上兜底：正常链路（本次成功/推送静默拉取）会经
        // guarded setter 取消；链路断裂时依次执行「静默重试 → 强制 ready」。
        armCatalogLoadWatchdog(projectId);
        await new Promise<void>((r) => setTimeout(r, 0));
      }
      const records = await withTimeout(
        api.sessions.listCatalog(projectId),
        SESSION_REFRESH_TIMEOUT_MS,
        t("app.sessionRefreshTimeout"),
      );
      if (sessionRequestByProjectRef.current[projectId] !== request) {
        result = records;
      } else {
        replaceProjectSessions({ projectId, sessions: records });
        // 空缓存先回 []：保持 loading，等 catalog-refreshed 才揭开，避免侧栏闪空白。
        // 磁盘 catalog 已有记录则立刻 ready，后台扫描稍后静默补齐。
        if (records.length > 0) {
          setCatalogLoadStateGuarded({ projectId, state: { status: "ready" } });
        }
        const sorted = records
          .map(sessionRecordToSummary)
          .filter((session): session is SessionSummary => Boolean(session))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        setVisibleProjectChildCountByProject((c) => ({ ...c, [projectId]: c[projectId] ?? SIDEBAR_PROJECT_CHILD_PAGE_SIZE }));
        result = sorted;
      }
    } catch (caughtError) {
      failed = true;
      error = caughtError;
      if (sessionRequestByProjectRef.current[projectId] === request) {
        const message = caughtError instanceof Error ? caughtError.message : String(caughtError);
        setCatalogLoadStateGuarded({
          projectId,
          state: { status: "error", error: message },
        });
      }
    } finally {
      const isCurrentCompletion = sessionRefreshCompletionByProjectRef.current[projectId] === completion;
      const isCurrentRequest = sessionRequestByProjectRef.current[projectId] === request;
      if (isCurrentRequest) {
        sessionRefreshRunningRef.current.delete(projectId);
        if (!silent) setSessionLoadingByProject((c) => ({ ...c, [projectId]: false }));
      }
      if (!isCurrentCompletion) {
        if (failed) completion.reject(error);
        else completion.resolve(result);
        return;
      }
      if (sessionRefreshPendingRef.current.delete(projectId)) {
        startProjectSessionRefresh(projectId, true, completion);
        return;
      }
      delete sessionRefreshCompletionByProjectRef.current[projectId];
      if (failed) completion.reject(error);
      else completion.resolve(result);
    }
  }

  function startProjectSessionRefresh(
    projectId: string,
    silent: boolean,
    completion: ProjectSessionRefreshCompletion,
  ) {
    void runProjectSessionRefresh(projectId, silent, completion).catch((unexpectedError) => {
      if (sessionRefreshCompletionByProjectRef.current[projectId] === completion) {
        sessionRefreshRunningRef.current.delete(projectId);
        sessionRefreshPendingRef.current.delete(projectId);
        delete sessionRefreshCompletionByProjectRef.current[projectId];
      }
      completion.reject(unexpectedError);
    });
  }

  // ── 后台扫描完成推送（2026-08 展开项目卡顿优化）──
  // 主进程后台扫描合并完成后推送 catalog-refreshed：以 scan:false 静默拉取合并结果，
  // 复用 request 序号防止过期响应覆盖更新数据；silent（无 loading 态、不打断用户操作）。
  useEffect(() => {
    if (!api.sessions.onCatalogRefreshed) return;
    const unsubscribe = api.sessions.onCatalogRefreshed(({ projectId }) => {
      const request = (sessionRequestByProjectRef.current[projectId] ?? 0) + 1;
      sessionRequestByProjectRef.current[projectId] = request;
      void api.sessions
        .listCatalog(projectId, { scan: false })
        .then((records) => {
          if (sessionRequestByProjectRef.current[projectId] !== request) return;
          replaceProjectSessions({ projectId, sessions: records });
          // 静默拉取完成 = catalog 已就绪：清掉可能残留的 loading 态。
          // 场景：非 silent 刷新（loading）进行中，catalog-refreshed 推送的静默
          // 拉取覆盖了 request 序号——原请求的 finally 因 isCurrentRequest=false
          // 不再清理 loading（也不 set ready），这里补上，否则侧栏「加载中」
          // （project-session-loading）永远转。典型触发：重命名 DSH 会话
          // （onTitleChanged → catalog 更新 → catalog-refreshed 推送）。
          setCatalogLoadStateGuarded({ projectId, state: { status: "ready" } });
        })
        .catch(() => {
          // 静默拉取失败不能就此丢掉揭盖机会：触发一轮非静默重试，重新走
          // 「loading → 扫描 → catalog-refreshed 推送」闭环。反复失败会落在
          // runProjectSessionRefresh 的 error 分支上，不会无限循环。
          void refreshProjectSessions(projectId).catch(() => undefined);
        });
    });
    return unsubscribe;
    // replaceProjectSessions/api 由 App 以稳定引用提供（useCallback/useMemo），依赖安全
  }, [api, replaceProjectSessions, setCatalogLoadStateGuarded]);

  /**
   * DSH 会话在 $DSH_HOME，不在项目目录 JSONL。添加项目 / 右键刷新若只扫 pi，
   * 侧栏会缺刚对上 cwd 的外部会话。关闭自动导入后保持现状，不偷偷写入。
   */
  async function syncDshForeignSessionsIfEnabled() {
    if (!api.sessions.syncDshForeignSessions || !api.settings?.get) return;
    const settings = await api.settings.get();
    if (settings.dshAutoImportSessions === false) return;
    try {
      await api.sessions.syncDshForeignSessions();
    } catch {
      // 磁盘扫描失败不阻断项目刷新：已入册的 DSH/pi 会话仍应出现。
    }
  }

  /**
   * loading 兜底两级看门狗：一级超时静默重试一轮（主进程目录缓存在扫描后已含记录，
   * 重试即揭开）；二级仍超时则强制置 ready，不让侧栏永远转圈，数据靠后续推送/轮询补齐。
   * 重试或揭开产生的任何状态变更都会经 guarded setter 取消本看门狗。
   */
  function armCatalogLoadWatchdog(projectId: string): void {
    catalogLoadWatchdog.schedule(projectId, CATALOG_WATCHDOG_STAGE_MS, () => {
      void refreshProjectSessions(projectId, true).catch(() => undefined);
      catalogLoadWatchdog.schedule(projectId, CATALOG_WATCHDOG_STAGE_MS, () => {
        // 二级兜底：强制揭开（置 ready 经 guarded setter 取消看门狗，此为终态）
        setCatalogLoadStateGuarded({ projectId, state: { status: "ready" } });
        void refreshProjectSessions(projectId, true).catch(() => undefined);
      });
    });
  }

  function refreshProjectSessions(projectId: string, silent = false): ProjectSessionRefreshPromise {
    const current = sessionRefreshCompletionByProjectRef.current[projectId];
    if (current) {
      sessionRefreshPendingRef.current.add(projectId);
      return current.promise;
    }
    const completion = createProjectSessionRefreshCompletion();
    sessionRefreshCompletionByProjectRef.current[projectId] = completion;
    startProjectSessionRefresh(projectId, silent, completion);
    return completion.promise;
  }

  async function refreshProjectTree(project: Project) {
    await syncDshForeignSessionsIfEnabled();
    const latestProjects = await refreshProjects();
    const latestProject = latestProjects.find((candidate) => candidate.id === project.id);
    // 项目可能在菜单打开后被外部删除。刷新存在性后立即停止后续会话/Git 扫描，
    // 避免继续对旧路径执行 scandir 并把原始 ENOENT 暴露给用户。
    if (!latestProject || latestProject.missing) {
      showToast(t("app.projectDirectoryMissing"), 4000);
      return;
    }
    await refreshProjectSessions(latestProject.id);
    if (latestProject.worktreeEnabled) {
      await refreshWorktrees(latestProject.id);
      const projectsAfterWorktreeRefresh = await api.projects.list();
      setProjects(projectsAfterWorktreeRefresh);
      const childProjects = projectsAfterWorktreeRefresh.filter((p) => p.worktreeParentId === latestProject.id && !p.missing);
      await Promise.all(childProjects.map((child) => refreshProjectSessions(child.id).catch(() => undefined)));
    }
    showToast(t("app.projectRefreshed", {}), 1800);
  }

  async function refreshFiles(
    projectId = activeProjectId,
    silent = false,
    expandedDirs: Iterable<string> = [],
  ) {
    if (!projectId) return;
    const generation = beginFileTreeRequest();
    try {
      // 抽屉刷新只拉浅层根，再按当前展开目录补齐，避免整棵 12 层 IPC。
      const next = await loadProjectFileTree(
        () => api.files.list(projectId, { maxDepth: 0 }),
        expandedDirs,
        () => isFileTreeRequestCurrent(generation, projectId),
        (directory) => api.files.list(projectId, { maxDepth: 0, directory }),
      );
      if (!next) return;
      setFiles(next);
      if (!silent) showToast(t("app.filesRefreshed", {}), 1800);
    } catch (error) {
      if (!isFileTreeRequestCurrent(generation, projectId)) return;
      const message = error instanceof Error ? error.message : String(error);
      const tooLarge = message.match(/FILE_TREE_DIRECTORY_TOO_LARGE:(\d+):(\d+)/);
      const projectDirectoryMissing = message.includes("PROJECT_DIRECTORY_MISSING");
      if (projectDirectoryMissing) {
        // 目录被外部删除后先清掉陈旧文件树，再刷新项目 presence，让侧栏立即出现“目录不存在”。
        setFiles([]);
        void refreshProjects().catch(() => undefined);
      }
      showToast(
        tooLarge
          ? t("app.filesDirectoryTooLarge", { count: tooLarge[1], max: tooLarge[2] })
          : projectDirectoryMissing
            ? t("app.projectDirectoryMissing")
            : t("app.filesRefreshFailed", { error: message }),
        4000,
      );
    }
  }

  return { worktreesByProject, branchByProject, files, setFiles, gitInfo, setGitInfo, sessionLoadingByProject, setSessionLoadingByProject, visibleProjectChildCountByProject, setVisibleProjectChildCountByProject, refreshProjects, refreshAllProjects, refreshWorktrees, refreshSessions, refreshProjectSessions, refreshFiles, refreshProjectTree, syncDshForeignSessionsIfEnabled, beginFileTreeRequest, isFileTreeRequestCurrent };
}
