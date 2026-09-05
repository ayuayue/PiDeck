import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import type { AgentBackend, AgentTab, Project, SessionRecord } from "../../../shared/types";
import {
  agentInventoryAtom,
  projectInventoryAtom,
  sessionCatalogLoadStateAtom,
  sessionIdsByProjectAtom,
  sessionRecordsAtom,
  sidebarExpandedProjectIdsAtom,
  sidebarNavTabAtom,
  sidebarRuntimeAtom,
} from "../atoms";
import {
  migrateLegacyCollapsedProjects,
  sameProjectIdSet,
  writeExpandedSidebarProjects,
} from "../utils/sidebarExpandedProjects";
import {
  parseSidebarNavTab,
  writeSidebarNavTab,
  type SidebarNavTab,
} from "../utils/sidebarNavTab";
import {
  SESSION_FILTER_PILLS,
  parseSessionFilterState,
  serializeSessionFilterState,
  sessionPillOf,
  type SessionFilterPill,
  type SessionFilterState,
} from "../sessionFilterPills";

export const SIDEBAR_PROJECT_CHILD_PAGE_SIZE = 5;

/** 侧栏过滤类别：来源 + DSH 后端（会话归属见 sessionFilterPills.sessionPillOf）。 */
export type SidebarSourceFilter = Set<SessionFilterPill> | null;
export type SidebarSourceFilters = SessionFilterState;
export type SidebarSourceFilterMenu = {
  projectId: string;
  x: number;
  y: number;
};
export type SidebarMenuTarget =
  | { kind: "project"; projectId: string; x: number; y: number }
  | { kind: "agent"; agentId: string; pinnable?: boolean; x: number; y: number }
  | { kind: "session"; projectId: string; sessionId: string; pinnable: boolean; x: number; y: number }
  | { kind: "draft"; projectId: string; sessionId: string; x: number; y: number };

export type SidebarRpcLog = {
  id: string;
  agentId: string;
  direction: string;
  summary: string;
  time: number;
  data?: unknown;
};

export type SidebarRuntimeSummary = {
  agentId?: string;
  status: string;
};

export type SidebarCatalog = {
  projects: readonly Project[];
  agents: readonly AgentTab[];
  sessionsByProject: Readonly<Record<string, readonly SessionRecord[]>>;
  runtimeBySessionId: Readonly<Record<string, SidebarRuntimeSummary | undefined>>;
  catalogLoadStateByProject: Readonly<Record<string, { status: string } | undefined>>;
};

/** A terminal runtime no longer owns its Session and may safely be discarded. */
export function hasLiveSidebarRuntime(runtime: SidebarRuntimeSummary | undefined): boolean {
  return Boolean(
    runtime?.agentId &&
    runtime.status !== "detached" &&
    runtime.status !== "closed" &&
    runtime.status !== "error",
  );
}

export type SidebarController = {
  catalog: SidebarCatalog;
  search: string;
  setSearch: (search: string) => void;
  /** 侧栏 Chats/项目分段当前选中；记忆上次选择，双写到 localStorage 与 settings.json */
  navTab: SidebarNavTab;
  setNavTab: (tab: SidebarNavTab) => void;
  /** Stable SessionRecord ids pinned within their owning project list. */
  pinnedSessionIds: ReadonlySet<string>;
  isSessionPinned: (sessionId: string) => boolean;
  toggleSessionPin: (sessionId: string) => void;
  expandedProjectIds: ReadonlySet<string>;
  isProjectCollapsed: (projectId: string) => boolean;
  toggleProject: (projectId: string) => void;
  /** 展开/折叠某个项目；forceExpand=true 时只展开不切换 */
  setProjectExpanded: (projectId: string, forceExpand?: boolean) => void;
  /** 批量折叠/展开工作区项目：任一展开则全折叠，全折叠则全展开；Chat 由自己标题栏控制。 */
  toggleCollapseAllProjects: () => void;
  sourceFilterFor: (projectId: string) => SidebarSourceFilter;
  setSourceEnabled: (projectId: string, source: SessionFilterPill, enabled: boolean) => void;
  /** Matches the dev filter menu: first source click narrows from All to that source. */
  toggleSourceFilter: (projectId: string, source: SessionFilterPill) => void;
  clearSourceFilter: (projectId: string) => void;
  sourceFilterMenu?: SidebarSourceFilterMenu;
  openSourceFilter: (projectId: string, x: number, y: number) => void;
  closeSourceFilter: () => void;
  visibleChildCountFor: (projectId: string) => number;
  showMoreChildren: (projectId: string) => void;
  /** 把项目子项列表收回到默认页大小（与 showMoreChildren 配对）。 */
  collapseChildren: (projectId: string) => void;
  /** 该项目是否展开过「查看更多」（存在显式计数即视为展开过）。 */
  hasExpandedChildren: (projectId: string) => boolean;
  expandedSubagentGroups: ReadonlySet<string>;
  toggleSubagentGroup: (groupId: string) => void;
  expandedWorktreePaths: ReadonlySet<string>;
  toggleWorktreeSessions: (path: string) => void;
  expandWorktreeSessions: (path: string) => void;
  /**
   * 点选工作区（主工作区或 worktree）。
   * 切换到其他工作区时自动展开，避免「选中了却看不到会话」；
   * 再次点击当前工作区时切换折叠。
   */
  drag: { sourceProjectId?: string; overProjectId?: string };
  startProjectDrag: (projectId: string) => void;
  setProjectDropTarget: (projectId?: string) => void;
  finishProjectDrag: () => void;
  menu: SidebarMenuTarget | null;
  openMenu: (target: SidebarMenuTarget) => Promise<void>;
  closeMenu: () => void;
  isAgentRpcLogging: (agentId: string) => boolean;
  setAgentRpcLogging: (agentId: string, enabled: boolean) => void;
  sessionManagerProjectId?: string;
  openSessionManager: (projectId: string) => void;
  closeSessionManager: () => void;
  worktreeCreateProjectId?: string;
  openWorktreeCreate: (projectId: string) => void;
  closeWorktreeCreate: () => void;
  rpcLogAgentId?: string;
  /** 打开实时 RPC 日志查看弹窗（数据订阅由弹窗自己管理） */
  openRpcLogs: (agentId: string) => void;
  closeRpcLogs: () => void;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const SOURCE_FILTER_STORAGE_KEY = "pideck-session-source-filter";

export function getBoundSidebarRuntimeAgent(
  catalog: Pick<SidebarCatalog, "agents" | "runtimeBySessionId">,
  sessionId: string,
): AgentTab | undefined {
  const runtime = catalog.runtimeBySessionId[sessionId];
  const agentId = runtime?.agentId;
  if (!hasLiveSidebarRuntime(runtime) || !agentId) return undefined;
  const agent = catalog.agents.find((candidate) => candidate.id === agentId);
  return agent && agent.status !== "closed" && agent.status !== "error" ? agent : undefined;
}

/**
 * 按 agentId 反查其绑定会话对应的 live runtime agent。
 * AgentTab.sessionId 是 pi 自身会话 id（runtime.piSessionId），不能直接当
 * runtimeBySessionId 的 key（其 key 是会话记录 id），因此 agent 菜单的
 * RPC 日志能力判断必须走 agentId 反查，否则运行中的 agent 会永远判定为
 * “无 runtime”而置灰。
 */
export function getBoundSidebarRuntimeAgentByAgentId(
  catalog: Pick<SidebarCatalog, "agents" | "runtimeBySessionId">,
  agentId: string,
): AgentTab | undefined {
  for (const [sessionId, runtime] of Object.entries(catalog.runtimeBySessionId)) {
    if (runtime?.agentId !== agentId) continue;
    return getBoundSidebarRuntimeAgent(catalog, sessionId);
  }
  return undefined;
}

export function createSidebarRequestGate() {
  let menuRequest = 0;
  return {
    beginMenu: () => ++menuRequest,
    isCurrentMenu: (request: number) => request === menuRequest,
    cancelMenu: () => { menuRequest += 1; },
  };
}

export function readSidebarSourceFilters(storage?: StorageLike): SidebarSourceFilters {
  if (!storage) return {};
  try {
    return parseSessionFilterState(storage.getItem(SOURCE_FILTER_STORAGE_KEY));
  } catch {
    return {};
  }
}

export function serializeSidebarSourceFilters(filters: SidebarSourceFilters) {
  return serializeSessionFilterState(filters);
}

/**
 * 按类别过滤侧栏会话：DSH 会话按 backend 判定（source 恒为 pi），
 * 避免「只选 Pi」时 DSH 会话仍显示 / 只选 DSH 时 pi 会话误显示。
 */
export function filterSidebarSessions<
  T extends { source?: import("../../../shared/types").SessionSource; backend?: AgentBackend },
>(
  sessions: readonly T[],
  filter: SidebarSourceFilter,
) {
  return filter === null || filter === undefined
    ? sessions
    : sessions.filter((session) => filter.has(sessionPillOf(session)));
}

export function useSidebarController(options: {
  storage?: StorageLike;
  getRpcLogging?: (agentId: string) => Promise<boolean>;
  pageSize?: number;
  /** 展开集合变更时写入 settings.json；dev 强杀丢 localStorage 时靠它恢复 */
  persistExpandedProjectIds?: (projectIds: string[]) => void;
  /** settings.json 中的权威展开集合，首次拿到时覆盖本地缓存 */
  settingsExpandedProjectIds?: readonly string[];
  /** 侧栏分段切换状态变更时写入 settings.json；dev 强杀丢 localStorage 时靠它恢复 */
  persistNavTab?: (tab: SidebarNavTab) => void;
  /** settings.json 中的权威侧栏分段，首次拿到时覆盖本地缓存 */
  settingsNavTab?: SidebarNavTab;
  /** 置顶会话 id 的权威 settings.json 值。 */
  settingsPinnedSessionIds?: readonly string[];
  /** 置顶集合变更时写入 settings.json。 */
  persistPinnedSessionIds?: (sessionIds: string[]) => void;
  /** 初始 settings.get 已完成；旧 key 迁移必须等此时才允许落盘。 */
  settingsLoaded?: boolean;
  /** 权威 settings 已应用且旧 key 已完成迁移后通知 App 开始懒加载会话。 */
  onExpandedProjectsReady?: () => void;
} = {}): SidebarController {
  const projects = useAtomValue(projectInventoryAtom);
  const agents = useAtomValue(agentInventoryAtom);
  const sessionRecords = useAtomValue(sessionRecordsAtom);
  const sessionIdsByProject = useAtomValue(sessionIdsByProjectAtom);
  const sessionRuntimeById = useAtomValue(sidebarRuntimeAtom);
  const sessionCatalogLoadStateByProject = useAtomValue(sessionCatalogLoadStateAtom);
  const pageSize = options.pageSize ?? SIDEBAR_PROJECT_CHILD_PAGE_SIZE;
  const [search, setSearch] = useState("");
  const [expandedProjectIds, setExpandedProjectIds] = useAtom(sidebarExpandedProjectIdsAtom);
  const [navTab, setNavTabState] = useAtom(sidebarNavTabAtom);
  const [pinnedSessionIds, setPinnedSessionIds] = useState<ReadonlySet<string>>(() => new Set());
  const [sourceFilters, setSourceFilters] = useState<SidebarSourceFilters>(() =>
    readSidebarSourceFilters(options.storage ?? (typeof window === "undefined" ? undefined : window.localStorage)),
  );
  const [visibleChildCountByProject, setVisibleChildCountByProject] = useState<Record<string, number>>({});
  const [sourceFilterMenu, setSourceFilterMenu] = useState<SidebarSourceFilterMenu>();
  const [expandedSubagentGroups, setExpandedSubagentGroups] = useState<Set<string>>(() => new Set());
  const [expandedWorktreePaths, setExpandedWorktreePaths] = useState<Set<string>>(() => new Set());
  const [drag, setDrag] = useState<{ sourceProjectId?: string; overProjectId?: string }>({});
  const [menu, setMenu] = useState<SidebarMenuTarget | null>(null);
  const [agentRpcLogging, setAgentRpcLoggingById] = useState<Map<string, boolean>>(() => new Map());
  // RPC 日志开关（agentId 键，只增不清 → 关闭时删键；agentId 每次 spawn 随机，旧键无复用价值）
  const patchRpcLogging = useCallback((agentId: string, enabled: boolean) => {
    setAgentRpcLoggingById((current) => {
      const next = new Map(current);
      if (enabled) next.set(agentId, true);
      else next.delete(agentId);
      return next;
    });
  }, []);
  const [sessionManagerProjectId, setSessionManagerProjectId] = useState<string>();
  const [worktreeCreateProjectId, setWorktreeCreateProjectId] = useState<string>();
  const [rpcLogAgentId, setRpcLogAgentId] = useState<string>();
  const requestGateRef = useRef(createSidebarRequestGate());
  const pinnedSessionIdsRef = useRef(pinnedSessionIds);
  pinnedSessionIdsRef.current = pinnedSessionIds;
  const pinnedSessionIdsHydratedRef = useRef(false);
  const persistPinnedSessionIdsRef = useRef(options.persistPinnedSessionIds);
  persistPinnedSessionIdsRef.current = options.persistPinnedSessionIds;

  useEffect(() => {
    const storage = options.storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    if (!storage) return;
    try {
      storage.setItem(SOURCE_FILTER_STORAGE_KEY, serializeSidebarSourceFilters(sourceFilters));
    } catch {
      // Local preferences are optional and must not make the Sidebar unusable.
    }
  }, [options.storage, sourceFilters]);

  // 置顶状态只落 settings.json：首次 hydration 后由 controller 独占运行时状态，
  // 避免迟到的 settings 响应覆盖用户刚完成的置顶操作。
  useEffect(() => {
    if (pinnedSessionIdsHydratedRef.current || !options.settingsLoaded) return;
    pinnedSessionIdsHydratedRef.current = true;
    const hydrated = new Set(
      (options.settingsPinnedSessionIds ?? []).filter(
        (id): id is string => typeof id === "string" && id.trim().length > 0,
      ),
    );
    pinnedSessionIdsRef.current = hydrated;
    setPinnedSessionIds(hydrated);
  }, [options.settingsLoaded, options.settingsPinnedSessionIds]);

  const toggleSessionPin = useCallback((sessionId: string) => {
    if (!sessionId) return;
    pinnedSessionIdsHydratedRef.current = true;
    const next = new Set(pinnedSessionIdsRef.current);
    if (next.has(sessionId)) next.delete(sessionId);
    else next.add(sessionId);
    pinnedSessionIdsRef.current = next;
    setPinnedSessionIds(next);
    persistPinnedSessionIdsRef.current?.([...next]);
  }, []);

  // ── 侧栏 Chats/项目分段：localStorage 首屏缓存 + settings.json 可靠落盘（与展开集合同策略） ──

  const navTabRef = useRef(navTab);
  navTabRef.current = navTab;
  /** 已合并过 settings.json 的分段状态，避免迟到的 settings 覆盖用户在首屏刚切的标签 */
  const navTabHydratedRef = useRef(false);
  const persistNavTabRef = useRef(options.persistNavTab);
  persistNavTabRef.current = options.persistNavTab;

  /** 更新分段并双写：localStorage 同步落盘 + settings.json 交调用方写入 */
  const commitNavTab = useCallback((tab: SidebarNavTab) => {
    navTabRef.current = tab;
    setNavTabState(tab);
    writeSidebarNavTab(storageRef.current, tab);
    persistNavTabRef.current?.(tab);
  }, [setNavTabState]);

  const setNavTab = useCallback((tab: SidebarNavTab) => {
    // 用户点选即视为权威已应用，防止迟到的 settings 回盖
    navTabHydratedRef.current = true;
    commitNavTab(tab);
  }, [commitNavTab]);

  // settings.json 为权威来源：首次拿到时覆盖 localStorage 缓存值；缺省/非法保留本地默认 chats
  const settingsNavTab = options.settingsNavTab;
  useEffect(() => {
    if (navTabHydratedRef.current || !options.settingsLoaded) return;
    navTabHydratedRef.current = true;
    const parsed = parseSidebarNavTab(settingsNavTab);
    if (parsed === null || parsed === navTabRef.current) return;
    navTabRef.current = parsed;
    setNavTabState(parsed);
    writeSidebarNavTab(storageRef.current, parsed);
  }, [options.settingsLoaded, settingsNavTab, setNavTabState]);

  // ── 侧栏展开状态：localStorage 首屏缓存 + settings.json 可靠落盘 ──

  const expandedProjectIdsRef = useRef(expandedProjectIds);
  expandedProjectIdsRef.current = expandedProjectIds;
  /** 已合并过 settings.json 的展开状态，避免迟到的 settings 覆盖用户刚点的展开 */
  const settingsHydratedRef = useRef(false);
  const persistExpandedRef = useRef(options.persistExpandedProjectIds);
  persistExpandedRef.current = options.persistExpandedProjectIds;
  const onExpandedProjectsReadyRef = useRef(options.onExpandedProjectsReady);
  onExpandedProjectsReadyRef.current = options.onExpandedProjectsReady;
  const expandedProjectsReadyNotifiedRef = useRef(false);
  const localStorageOrUndefined = options.storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
  const storageRef = useRef(localStorageOrUndefined);
  storageRef.current = localStorageOrUndefined;

  /** 更新展开集合并双写：localStorage 同步落盘 + settings.json 交调用方写入 */
  const commitExpandedProjectIds = useCallback((next: ReadonlySet<string>) => {
    expandedProjectIdsRef.current = next;
    setExpandedProjectIds(next);
    writeExpandedSidebarProjects(storageRef.current, next);
    persistExpandedRef.current?.([...next]);
  }, [setExpandedProjectIds]);

  // settings.json 为权威来源：首次拿到时覆盖 localStorage 缓存值
  const settingsExpanded = options.settingsExpandedProjectIds;
  useEffect(() => {
    if (settingsHydratedRef.current || !options.settingsLoaded) return;
    settingsHydratedRef.current = true;
    // 缺省字段表示旧版本 settings；保留 localStorage/default，随后由旧 key 迁移或用户操作写入。
    if (!Array.isArray(settingsExpanded)) return;
    const fromSettings = new Set(settingsExpanded.filter((id): id is string => typeof id === "string"));
    if (sameProjectIdSet(fromSettings, expandedProjectIdsRef.current)) return;
    expandedProjectIdsRef.current = fromSettings;
    setExpandedProjectIds(fromSettings);
    writeExpandedSidebarProjects(storageRef.current, fromSettings);
  }, [options.settingsLoaded, settingsExpanded, setExpandedProjectIds]);

  const projectIdsKey = projects.map((project) => project.id).join("|");
  useEffect(() => {
    // settings.json 到达前不能修剪或迁移：项目列表与展开缓存都可能只是首屏中间态，
    // 此时回写会把尚未加载的项目误删进持久化设置。
    if (projects.length === 0 || !options.settingsLoaded) return;
    const projectIds = projects.map((project) => project.id);
    // 旧版 collapsed key → expanded 反演迁移。必须等 settings.get 完成，
    // 否则慢到的 settings.json 会把刚迁移并写入的新集合覆盖回旧值。
    if (options.settingsLoaded && !Array.isArray(options.settingsExpandedProjectIds)) {
      const migrated = migrateLegacyCollapsedProjects(storageRef.current, projectIds);
      if (migrated) {
        commitExpandedProjectIds(migrated);
        return;
      }
    }
    // 修剪已删除的项目 id；不自动展开新建项目，也不把用户主动折叠的 chat 加回来
    const previous = expandedProjectIdsRef.current;
    const known = new Set(projectIds);
    const pruned = new Set([...previous].filter((id) => known.has(id)));
    if (sameProjectIdSet(pruned, previous)) return;
    // 删除项目同样是一次状态变更，必须双写；否则下次启动又会从 settings.json 取回陈旧 id。
    commitExpandedProjectIds(pruned);
  }, [projectIdsKey, commitExpandedProjectIds, options.settingsExpandedProjectIds, options.settingsLoaded]);

  useEffect(() => {
    // 只有权威集合已覆盖缓存、且项目全集已可用于旧 key 反演后，App 才能按展开状态扫描。
    if (expandedProjectsReadyNotifiedRef.current || !options.settingsLoaded || projects.length === 0) return;
    expandedProjectsReadyNotifiedRef.current = true;
    onExpandedProjectsReadyRef.current?.();
  }, [options.settingsLoaded, projectIdsKey]);

  const sessionsByProject = useMemo(() => Object.fromEntries(
    Object.entries(sessionIdsByProject).map(([projectId, sessionIds]) => [
      projectId,
      sessionIds.map((id) => sessionRecords[id]).filter((session): session is SessionRecord => Boolean(session)),
    ]),
  ), [sessionIdsByProject, sessionRecords]);
  const catalog = useMemo<SidebarCatalog>(() => ({
    projects,
    agents,
    sessionsByProject,
    runtimeBySessionId: sessionRuntimeById,
    catalogLoadStateByProject: sessionCatalogLoadStateByProject,
  }), [agents, projects, sessionCatalogLoadStateByProject, sessionRuntimeById, sessionsByProject]);

  const setProjectExpanded = useCallback((projectId: string, forceExpand?: boolean) => {
    const previous = expandedProjectIdsRef.current;
    const next = new Set(previous);
    const shouldExpand = forceExpand ?? !next.has(projectId);
    if (shouldExpand) next.add(projectId);
    else next.delete(projectId);
    if (sameProjectIdSet(next, previous)) return;
    // 标记已有权威写入，防止启动时迟到的 settings 用旧值覆盖用户刚点的展开
    settingsHydratedRef.current = true;
    commitExpandedProjectIds(next);
  }, [commitExpandedProjectIds]);
  const toggleProject = useCallback((projectId: string) => {
    setProjectExpanded(projectId);
  }, [setProjectExpanded]);
  const toggleCollapseAllProjects = useCallback(() => {
    const previous = expandedProjectIdsRef.current;
    // 只作用于根工作区项目：Chat 折叠由自己的标题栏按钮管理，worktree 子项目不独立折叠。
    const workspaceIds = projects
      .filter((project) => project.kind !== "chat" && !project.worktreeParentId)
      .map((project) => project.id);
    const hasExpanded = workspaceIds.some((id) => previous.has(id));
    const next = new Set(previous);
    if (hasExpanded) {
      // 任一项目展开 → 全部折叠（仅移除工作区 id，保留 Chat 折叠状态原状）
      workspaceIds.forEach((id) => next.delete(id));
    } else {
      // 全部已折叠 → 展开全部工作区项目
      workspaceIds.forEach((id) => next.add(id));
    }
    if (sameProjectIdSet(next, previous)) return;
    settingsHydratedRef.current = true;
    commitExpandedProjectIds(next);
  }, [commitExpandedProjectIds, projects]);
  const setSourceEnabled = useCallback((projectId: string, source: SessionFilterPill, enabled: boolean) => {
    setSourceFilters((current) => {
      const previous = current[projectId] ?? null;
      const next = new Set(previous ?? SESSION_FILTER_PILLS);
      if (enabled) next.add(source);
      else next.delete(source);
      return { ...current, [projectId]: next.size === SESSION_FILTER_PILLS.length ? null : next };
    });
  }, []);
  const toggleSourceFilter = useCallback((projectId: string, source: SessionFilterPill) => {
    setSourceFilters((current) => {
      const previous = current[projectId] ?? null;
      if (previous === null) return { ...current, [projectId]: new Set([source]) };
      const next = new Set(previous);
      if (next.has(source)) next.delete(source);
      else next.add(source);
      return { ...current, [projectId]: next.size === 0 ? null : next };
    });
  }, []);
  const clearSourceFilter = useCallback((projectId: string) => {
    setSourceFilters((current) => ({ ...current, [projectId]: null }));
  }, []);
  const showMoreChildren = useCallback((projectId: string) => {
    setVisibleChildCountByProject((current) => ({
      ...current,
      [projectId]: (current[projectId] ?? pageSize) + pageSize,
    }));
  }, [pageSize]);
  const collapseChildren = useCallback((projectId: string) => {
    setVisibleChildCountByProject((current) => {
      const next = { ...current };
      delete next[projectId];
      return next;
    });
  }, []);
  const hasExpandedChildren = useCallback(
    (projectId: string) => visibleChildCountByProject[projectId] !== undefined,
    [visibleChildCountByProject],
  );
  const toggleSubagentGroup = useCallback((groupId: string) => {
    setExpandedSubagentGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);
  const toggleWorktreeSessions = useCallback((path: string) => {
    setExpandedWorktreePaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  const expandWorktreeSessions = useCallback((path: string) => {
    setExpandedWorktreePaths((current) => new Set(current).add(path));
  }, []);
  const openMenu = useCallback(async (target: SidebarMenuTarget) => {
    const request = requestGateRef.current.beginMenu();
    if (target.kind === "agent" && options.getRpcLogging) {
      const logging = await options.getRpcLogging(target.agentId);
      if (!requestGateRef.current.isCurrentMenu(request)) return;
      patchRpcLogging(target.agentId, logging);
    }
    if (requestGateRef.current.isCurrentMenu(request)) setMenu(target);
  }, [options.getRpcLogging]);  const openRpcLogs = useCallback((agentId: string) => {
    // 弹窗自持数据（初始历史 + 实时订阅），这里只负责开关
    setRpcLogAgentId(agentId);
  }, []);

  return {
    catalog,
    search,
    setSearch,
    navTab,
    setNavTab,
    pinnedSessionIds,
    isSessionPinned: (sessionId) => pinnedSessionIds.has(sessionId),
    toggleSessionPin,
    expandedProjectIds,
    isProjectCollapsed: (projectId) => !expandedProjectIds.has(projectId),
    toggleProject,
    setProjectExpanded,
    toggleCollapseAllProjects,
    sourceFilterFor: (projectId) => sourceFilters[projectId] ?? null,
    setSourceEnabled,
    toggleSourceFilter,
    clearSourceFilter,
    sourceFilterMenu,
    openSourceFilter: (projectId, x, y) => setSourceFilterMenu({ projectId, x, y }),
    closeSourceFilter: () => setSourceFilterMenu(undefined),
    visibleChildCountFor: (projectId) => visibleChildCountByProject[projectId] ?? pageSize,
    showMoreChildren,
    collapseChildren,
    hasExpandedChildren,
    expandedSubagentGroups,
    toggleSubagentGroup,
    expandedWorktreePaths,
    toggleWorktreeSessions,
    expandWorktreeSessions,
    drag,
    startProjectDrag: (projectId) => setDrag({ sourceProjectId: projectId }),
    setProjectDropTarget: (projectId) => setDrag((current) => ({ ...current, overProjectId: projectId })),
    finishProjectDrag: () => setDrag({}),
    menu,
    openMenu,
    closeMenu: () => {
      requestGateRef.current.cancelMenu();
      setMenu(null);
    },
    isAgentRpcLogging: (agentId) => agentRpcLogging.get(agentId) ?? false,
    setAgentRpcLogging: (agentId, enabled) => patchRpcLogging(agentId, enabled),
    sessionManagerProjectId,
    openSessionManager: setSessionManagerProjectId,
    closeSessionManager: () => setSessionManagerProjectId(undefined),
    worktreeCreateProjectId,
    openWorktreeCreate: setWorktreeCreateProjectId,
    closeWorktreeCreate: () => setWorktreeCreateProjectId(undefined),
    rpcLogAgentId,
    openRpcLogs,
    closeRpcLogs: () => {
      // 弹窗卸载即退订实时日志，无需额外请求门
      setRpcLogAgentId(undefined);
    },
  };
}
