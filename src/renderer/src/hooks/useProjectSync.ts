import { useState, useRef, useEffect } from "react";
import type { Project, FileTreeNode, GitBranchInfo, WorktreeEntry, SessionSummary, SessionRecord } from "../../../shared/types";
import type { SessionLoadState } from "../atoms/session-atoms";
import { sessionRecordToSummary } from "../atoms/session-selectors";

const SESSION_REFRESH_TIMEOUT_MS = 20_000;
const SIDEBAR_PROJECT_CHILD_PAGE_SIZE = 5;

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
    sessions: {
      listCatalog: (projectId: string, options?: { scan?: boolean }) => Promise<SessionRecord[]>;
      /** 后台扫描完成推送（主进程 → 渲染层）；可选，缺省时退化为纯轮询。 */
      onCatalogRefreshed?: (listener: (input: { projectId: string }) => void) => () => void;
    };
    files: { list: (projectId: string) => Promise<FileTreeNode[]> };
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
  const sessionRequestByProjectRef = useRef<Record<string, number>>({});
  const sessionRefreshRunningRef = useRef<Set<string>>(new Set());
  const sessionRefreshPendingRef = useRef<Set<string>>(new Set());
  const sessionRefreshCompletionByProjectRef = useRef<Record<string, ProjectSessionRefreshCompletion | undefined>>({});

  async function refreshProjects() {
    const next = await api.projects.list();
    setProjects(next);
    if (!activeProjectId && next.length > 0) setActiveProjectId(next[0].id);
    for (const p of next) { if (p.worktreeEnabled) void refreshWorktrees(p.id); }
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
      .map((session) => "projectId" in session ? sessionRecordToSummary(session) : session)
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
        setSessionCatalogLoadState?.({ projectId, state: { status: "loading" } });
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
        setSessionCatalogLoadState?.({ projectId, state: { status: "ready" } });
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
        setSessionCatalogLoadState?.({
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
        })
        .catch(() => undefined); // 静默路径失败不打断：下一次轮询/推送仍会纠正
    });
    return unsubscribe;
    // replaceProjectSessions/api 由 App 以稳定引用提供（useCallback/useMemo），依赖安全
  }, [api, replaceProjectSessions]);

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
    await refreshProjectSessions(project.id);
    if (project.worktreeEnabled) {
      await refreshWorktrees(project.id);
      const latestProjects = await api.projects.list();
      setProjects(latestProjects);
      const childProjects = latestProjects.filter((p) => p.worktreeParentId === project.id);
      await Promise.all(childProjects.map((child) => refreshProjectSessions(child.id).catch(() => undefined)));
    }
    showToast(t("app.projectRefreshed", {}), 1800);
  }

  async function refreshFiles(projectId = activeProjectId, silent = false) {
    if (!projectId) return;
    const next = await api.files.list(projectId);
    setFiles(next);
    if (!silent) showToast(t("app.filesRefreshed", {}), 1800);
  }

  return { worktreesByProject, branchByProject, files, setFiles, gitInfo, setGitInfo, sessionLoadingByProject, setSessionLoadingByProject, visibleProjectChildCountByProject, setVisibleProjectChildCountByProject, refreshProjects, refreshWorktrees, refreshSessions, refreshProjectSessions, refreshFiles, refreshProjectTree };
}
