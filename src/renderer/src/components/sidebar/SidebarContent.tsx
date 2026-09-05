import { Activity, Bolt, CirclePlus, Clock, Folder, Globe, MessageSquare, Monitor, Moon, Search, Sun } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { AgentTab, AppThemeMode, ArchivedDshSession, ArchivedPiSession, Project, SessionRecord, SessionSummary, WorktreeEntry } from "../../../../shared/types";
import {
  AgentContextMenu,
  DraftSessionContextMenu,
  ProjectContextMenu,
  SessionContextMenu,
  SessionManagerModal,
  SessionSourceFilterMenu,
  WorktreeCreateDialog,
  RpcLogOpenedDialog,
} from "./SidebarParts";
import { RpcLogViewer } from "./RpcLogViewer";
import { SessionProxyDialog } from "../session/SessionProxyDialog";
import { sessionRecordToSummary } from "../../atoms";
import { pendingAppUpdateAtom, pendingPiUpdateAtom } from "../../atoms/update-atoms";
import { useAtomValue } from "jotai";
import { isManagerSessionSummary, worktreeFamilyProjects } from "../../sessionManagerModel";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { showNotice } from "../../utils/notice";
import { isLiveRuntimeStatus } from "../../utils/sessionCommands";
import { getBoundSidebarRuntimeAgent, getBoundSidebarRuntimeAgentByAgentId, type SidebarController, type SidebarRpcLog } from "../../hooks/useSidebarController";
import { sessionDisplayName } from "../../utils/sessionDisplayName";
import { DshSearchResults } from "./DshSearchResults";
import { ProjectTree } from "./ProjectTree";
import { Button } from "../ui-shadcn/button";
import { Tabs, TabsList, TabsTrigger } from "../motion/tabs";
import { Dock, DockItem } from "../motion/dock";
import { MorphingSearch, type MorphingSearchItem } from "../motion/morphing-search";
import { parseSidebarNavTab } from "../../utils/sidebarNavTab";
import { displayProjectDirectoryName, isChatProject } from "../../rendererUtils";

export type SidebarActions = {
  projects: {
    add: () => Promise<void>;
    select: (projectId: string) => void;
    refresh: (projectId: string) => Promise<void>;
    /** 重扫所有项目目录的存在性并刷新侧栏清单。 */
    refreshAll: () => Promise<void>;
    reorder: (sourceProjectId: string, targetProjectId: string) => Promise<void>;
    reveal: (project: Project) => Promise<void>;
    openWithEditor: (project: Project) => void;
    importSessions: (project: Project, source: "codex" | "claude" | "opencode") => void;
    manageResources: (project: Project) => void;
    toggleWorktree: (project: Project) => Promise<void>;
    copyPath: (project: Project) => Promise<void>;
    /** 重命名项目显示名（仅改 label，不动磁盘目录）；打开重命名对话框。 */
    rename: (project: Project) => void;
    remove: (project: Project) => Promise<void>;
    changeChatPath?: (project: Project) => Promise<void>;
  };
  sessions: {
    /** 单击默认 preview；双击传 permanent。侧栏拖拽分屏也会走 open。 */
    open: (
      projectId: string,
      sessionId: string,
      tabMode?: "preview" | "permanent",
    ) => Promise<void>;
    /** 侧栏会话开始拖拽（与 Tab 栏共用 MIME，可拖到聊天区边缘分屏） */
    beginDrag?: (sessionId: string) => void;
    endDrag?: () => void;
    createDraft: (projectId: string) => Promise<void>;
    createAnonymous: (projectId: string) => Promise<void>;
    deleteDraft: (session: SessionRecord) => Promise<void>;
    rename: (projectId: string, session: SessionSummary) => void;
    export: (projectId: string, session: SessionSummary) => Promise<void>;
    copy: (projectId: string, session: SessionSummary) => Promise<void>;
    copyPath: (session: SessionSummary) => Promise<void>;
    openFile: (session: SessionSummary) => Promise<void>;
    delete: (projectId: string, session: SessionSummary) => Promise<void>;
    /** 重新加载会话消息文件（未启动/异常的历史会话，从磁盘刷新） */
    reload: (projectId: string, session: SessionSummary) => Promise<void>;
    /** 重启会话（全状态：失败/未启动/空闲/运行中，按绑定状态分派 restart/activate） */
    restart: (projectId: string, session: SessionSummary) => Promise<void>;
    /** 归档会话（可恢复） */
    archive: (projectId: string, session: SessionSummary) => Promise<void>;
    /** 恢复归档会话 */
    unarchive: (session: SessionSummary, projectId?: string) => Promise<void>;
    /** 列出已归档会话（恢复 UI 用；带原始路径，弹窗按项目归属过滤） */
    listArchived: () => Promise<ArchivedPiSession[]>;
    /** 永久删除已归档会话（pi 文件归档；移入回收站并移出索引） */
    deleteArchived: (archivedPath: string) => Promise<void>;
    /** 恢复 DSH 归档会话（host 目录移回 sessions 树并重建 catalog 记录） */
    unarchiveDsh: (dshSessionId: string, projectId?: string) => Promise<void>;
    /** 列出 DSH 归档会话（会话管理弹窗归档视图用；含标题） */
    listArchivedDsh: () => Promise<ArchivedDshSession[]>;
    /** 永久删除已归档 DSH 会话（host 目录移入回收站） */
    deleteArchivedDsh: (dshSessionId: string) => Promise<void>;
  };
  agents: {
    rename: (agent: AgentTab) => void;
    export: (agent: AgentTab) => Promise<void>;
    copySession: (agent: AgentTab) => Promise<void>;
    copyPath: (agent: AgentTab) => Promise<void>;
    openSessionFile: (agent: AgentTab) => Promise<void>;
    close: (agent: AgentTab) => Promise<void>;
    /** 重启会话（全状态：live/error/closed/未启动，按绑定状态分派） */
    restart: (agent: AgentTab) => void;
    /** 重新加载会话消息文件（无 live 运行时） */
    reload: (agent: AgentTab) => Promise<void>;
  };
  worktrees: {
    create: (projectId: string, branchName: string) => Promise<void>;
    remove: (parentProjectId: string, entry: WorktreeEntry, childProject?: Project) => Promise<void>;
  };
  rpc: {
    getLogging: (agentId: string) => Promise<boolean>;
    setLogging: (agentId: string, enabled: boolean) => Promise<boolean>;
    listLogs: (agentId: string) => Promise<SidebarRpcLog[]>;
  };
};

export type SidebarContentProps = {
  controller: SidebarController;
  actions: SidebarActions;
  currentProjectId?: string;
  currentSessionId?: string;
  worktreesByProject: Readonly<Record<string, readonly WorktreeEntry[]>>;
  branchByProject?: Readonly<Record<string, string | null | undefined>>;
  creatingWorktree?: boolean;
  /** 正在删除的 worktree 路径集合（透传给 WorktreeTree 驱动淡出动画）。 */
  removingWorktreePaths?: ReadonlySet<string>;
  isLanWeb?: boolean;
  chrome?: ReactNode;
  /** 「新建会话」：打开初始引导页（居中输入框 + 项目下拉切换），由 App 提供。 */
  onOpenNewSession?: () => void;
  onOpenSettings?: () => void;
  onOpenFeedback?: () => void;
  onOpenHomepage?: () => void;
  /** 底栏主题切换：当前主题模式 + 点击循环（浅色→暗色→跟随系统），由 App 提供。 */
  themeMode?: AppThemeMode;
  onToggleTheme?: () => void;
};

export function SidebarContent(props: SidebarContentProps) {
  const { controller, actions } = props;
  const menu = controller.menu;
  // 两个 atom 必须无条件读取：不能用 `useAtomValue(app) || useAtomValue(pi)`，
  // 否则应用更新从 false 变 true 时会短路跳过第二个 Hook，破坏 Hook 调用顺序。
  const hasPendingAppUpdate = useAtomValue(pendingAppUpdateAtom);
  const hasPendingPiUpdate = useAtomValue(pendingPiUpdateAtom);
  const hasPendingUpdate = hasPendingAppUpdate || hasPendingPiUpdate;
  const menuProject = menu?.kind === "project"
    ? controller.catalog.projects.find((project) => project.id === menu.projectId)
    : undefined;
  // 子工作区的「⋯」需要复用项目菜单，但删除必须回到根项目的 Git worktree 流程。
  const menuProjectWorktreeParent = menuProject?.worktreeParentId
    ? controller.catalog.projects.find((project) => project.id === menuProject.worktreeParentId)
    : undefined;
  const menuAgent = menu?.kind === "agent"
    ? controller.catalog.agents.find((agent) => agent.id === menu.agentId)
    : undefined;
  const menuAgentSessionId = menuAgent
    ? Object.entries(controller.catalog.runtimeBySessionId).find(
      ([, runtime]) => runtime?.agentId === menuAgent.id,
    )?.[0]
    : undefined;
  const menuAgentSessionRecord = menuAgentSessionId && menuAgent
    ? controller.catalog.sessionsByProject[menuAgent.projectId]?.find(
      (session) => session.id === menuAgentSessionId,
    )
    : undefined;

  // 底栏主题按钮：图标与文案反映当前主题模式；点击翻转浅/暗（规则见 themeAppearance.toggleThemeMode）
  const ThemeModeIcon =
    props.themeMode === "dark" ? Moon
    : props.themeMode === "system" ? Monitor
    : props.themeMode === "schedule" ? Clock
    : Sun;
  const themeToggleTitle = t("app.themeDockTooltip", {
    mode: t(
      props.themeMode === "dark" ? "settings.themeDark"
      : props.themeMode === "system" ? "settings.themeSystem"
      : props.themeMode === "schedule" ? "settings.themeSchedule"
      : "settings.themeLight",
    ),
  });
  // agent 是否有 live runtime：没有运行中的 pi 子进程时，RPC 日志记录无法开启
  // （记录靠主进程旁路拦截子进程通信，进程不存在则无日志可记）。
  // 注意不能拿 menuAgent.sessionId 直接查 runtimeBySessionId：AgentTab.sessionId
  // 是 pi 自身会话 id，而 runtimeBySessionId 的 key 是会话记录 id，必须按 agentId 反查。
  const menuAgentCanRpcLog = menuAgent !== undefined
    && getBoundSidebarRuntimeAgentByAgentId(controller.catalog, menuAgent.id) !== undefined;
  // 会话运行控制：live（starting/idle/running）显示重启，否则（未启动/error/closed）显示重新加载。
  const menuAgentLive = menuAgent !== undefined && isLiveRuntimeStatus(menuAgent.status);
  // “RPC 日志已打开”提醒弹框的打开目标 agent id（null = 关闭）
  const [rpcLogOpenedAgentId, setRpcLogOpenedAgentId] = useState<string | null>(null);
  // 顶部「搜索」菜单项控制 MorphingSearch 命令面板的展开状态。
  const [searchOpen, setSearchOpen] = useState(false);

  // 全局快捷键：Ctrl+N 新建会话（打开引导页）、Ctrl+F 搜索（打开命令面板）。
  // 与界面上的 kbd 提示保持一致；输入框/内容可编辑区域聚焦时跳过，避免干扰打字。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const target = event.target;
      if (target instanceof HTMLElement &&
        (target.isContentEditable ||
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement)) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "n") {
        event.preventDefault();
        props.onOpenNewSession?.();
      } else if (key === "f") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.onOpenNewSession]);
  // 会话代理设置弹框的打开目标会话 id（null = 关闭）
  const [proxyDialogSessionId, setProxyDialogSessionId] = useState<string | null>(null);
  const menuSessionRecord = menu?.kind === "session"
    ? controller.catalog.sessionsByProject[menu.projectId]?.find((session) => session.id === menu.sessionId)
    : undefined;
  const menuDraft = menu?.kind === "draft"
    ? controller.catalog.sessionsByProject[menu.projectId]?.find((session) => session.id === menu.sessionId)
    : undefined;
  const menuSession = menuSessionRecord ? sessionRecordToSummary(menuSessionRecord) : undefined;
  const menuSessionRuntimeAgent = menuSessionRecord
    ? getBoundSidebarRuntimeAgent(controller.catalog, menuSessionRecord.id)
    : undefined;
  const managerProject = controller.sessionManagerProjectId
    ? controller.catalog.projects.find((project) => project.id === controller.sessionManagerProjectId)
    : undefined;
  const currentProject = props.currentProjectId
    ? controller.catalog.projects.find((project) => project.id === props.currentProjectId)
    : undefined;
  const currentRootProject = currentProject?.worktreeParentId
    ? controller.catalog.projects.find((project) => project.id === currentProject.worktreeParentId) ?? currentProject
    : currentProject;

  // MorphingSearch 检索项：扁平化所有项目 + 会话，供命令面板跳转。
  // 项目项用目录名（chat 用「Chat」），会话项用标题 + 预览；选中即打开/选中目标。
  const searchItems: MorphingSearchItem[] = [];
  for (const project of controller.catalog.projects) {
    searchItems.push({
      id: `project:${project.id}`,
      title: displayProjectDirectoryName(project),
      description: project.path,
      icon: isChatProject(project) ? MessageSquare : Folder,
      onSelect: () => {
        actions.projects.select(project.id);
        controller.setProjectExpanded(project.id, true);
      },
    });
    for (const session of controller.catalog.sessionsByProject[project.id] ?? []) {
      searchItems.push({
        id: `session:${session.id}`,
        title: sessionDisplayName(session.title, session.forked) ?? session.title,
        description: session.preview,
        icon: MessageSquare,
        onSelect: () => { void actions.sessions.open(project.id, session.id); },
      });
    }
  }

  return (
    <aside
      // 行操作按钮是 absolute 浮层：hover 时行文本通过 padding-right 压缩让位
      // （pr 留出按钮空间 + 截断，三棵树统一策略，不再按侧栏宽度分断点），
      // 宽度不用穿透到树组件
      className="chat-list-pane v3-braun flex h-full min-w-0 flex-col overflow-hidden bg-sidebar text-sidebar-foreground"
      aria-label={t("app.search")}
    >
      {/* 品牌区提到 body 外：贴侧栏顶边，不被 sidebar-body 的 px/py 顶开（logo 怼左上）。 */}
      {props.chrome}
      <div className="sidebar-body flex min-h-0 flex-1 flex-col gap-2 px-2 pt-2 pb-1">
        {/* 顶部两个平铺操作：「新建会话」+「搜索」（无下拉、无外边框）。
            新建会话 → 打开初始引导页（居中输入框 + 项目下拉切换后可直接对话）；
            搜索 → 打开 MorphingSearch 命令面板。把搜索从整行输入框收敛成单个动作项，
            消除与下方胶囊分段的样式重复。底部细分割线与下方分组区分，避免与分段栏粘连。 */}
        <div className="flex shrink-0 flex-col gap-0.5 border-b border-border/40 pt-1 pb-2">
          <button
            type="button"
            className="group flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-body text-foreground transition-colors hover:bg-muted/60"
            aria-label={t("app.newSession")}
            title={t("app.newSession")}
            onClick={() => props.onOpenNewSession?.()}
          >
            <CirclePlus className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate font-medium">{t("app.newSession")}</span>
            {/* 快捷键默认隐藏，行 hover 时才淡入（无边框，弱化到只剩文字），避免常驻视觉噪音 */}
            <kbd className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md px-1 text-micro text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">Ctrl+N</kbd>
          </button>
          <button
            type="button"
            className="group flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-body text-foreground transition-colors hover:bg-muted/60"
            aria-label={t("app.searchSessions")}
            title={t("app.searchSessions")}
            onClick={() => setSearchOpen(true)}
          >
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate font-medium">{t("app.searchSessions")}</span>
            {/* 快捷键默认隐藏，行 hover 时才淡入；搜索快捷键为 Ctrl+F（见下方全局监听） */}
            <kbd className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md px-1 text-micro text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">Ctrl+F</kbd>
          </button>
        </div>

        {/* MorphingSearch 命令面板：锚点固定定位到视口水平居中、垂直约 1/5 处，
            （VSCode/Raycast 式 command 弹窗），而不是贴在搜索按钮旁。锚点不可见但保留
            真实尺寸供 getBoundingClientRect 测量，面板从锚点位置展开即居中。 */}
        <div className="pointer-events-none fixed left-1/2 top-[16vh] z-50 w-[min(640px,calc(100vw-2rem))] -translate-x-1/2">
          <MorphingSearch
            items={searchItems}
            placeholder={t("app.searchSessions")}
            shortcut=""
            iconOnly
            maxWidth={640}
            maxHeight={360}
            open={searchOpen}
            onOpenChange={setSearchOpen}
            emptyMessage={t("app.searchNoResults")}
            className="pointer-events-none h-12 w-full opacity-0"
            onQueryChange={(query) => controller.setSearch(query)}
          />
        </div>

        {/* 活动 / 聊天 / 项目分段：beUI pill 分段（凹槽轨道 + 凸起高亮胶囊）。
            活动页收集所有已激活的 Agent 会话（跨项目），聊天页显示历史会话，项目页显示工作区目录。
            轨道：muted 弱化底 + hairline 边框；高亮块盖掉 beUI 默认的 bg-primary 色块，
            换成 background 浮起面（细描边 + 投影；暗色用 bg-active 提亮一档做「抬起」感）。
            激活文字显式给 text-foreground 压掉 beUI 的 text-primary-foreground
            （反白色落在浅色胶囊上不可见）。选择即记忆（双写 localStorage + settings.json）。 */}
        <Tabs
          value={controller.navTab}
          onValueChange={(value) => {
            const tab = parseSidebarNavTab(value);
            if (tab) controller.setNavTab(tab);
          }}
          variant="pill"
        >
          <TabsList className="w-full rounded-full bg-muted/70 p-0.5">
            <TabsTrigger
              value="active"
              className={cn("w-full gap-1.5 px-2 py-1.5 text-xs", controller.navTab === "active" && "text-foreground")}
              indicatorClassName="bg-background shadow-sm dark:bg-bg-active"
            >
              <Activity className="size-3.5 shrink-0" aria-hidden="true" />
              {t("app.sidebarActive")}
            </TabsTrigger>
            <TabsTrigger
              value="chats"
              className={cn("w-full gap-1.5 px-2 py-1.5 text-xs", controller.navTab === "chats" && "text-foreground")}
              indicatorClassName="bg-background shadow-sm dark:bg-bg-active"
            >
              <MessageSquare className="size-3.5 shrink-0" aria-hidden="true" />
              {t("app.sidebarChats")}
            </TabsTrigger>
            <TabsTrigger
              value="projects"
              className={cn("w-full gap-1.5 px-2 py-1.5 text-xs", controller.navTab === "projects" && "text-foreground")}
              indicatorClassName="bg-background shadow-sm dark:bg-bg-active"
            >
              <Folder className="size-3.5 shrink-0" aria-hidden="true" />
              {t("app.sidebarProjects")}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {/* G9：DSH 全文搜索结果（搜索词非空时展示；结果按 dshSessionId 映射回 catalog） */}
        {controller.search.trim() && (
          <DshSearchResults
            query={controller.search}
            onOpen={(projectId, sessionId) => {
              void actions.sessions.open(projectId, sessionId);
            }}
          />
        )}

        {/* 单一滚动区承载项目与展开内容，避免项目导航/详情双滚动和重复标题。
            scrollbar-gutter: stable：滚动条出现/消失时列表宽度不跳变（与抽屉一致）。 */}
        <section className="conversation-list min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]">
          <ProjectTree
            controller={controller}
            actions={actions}
            currentProjectId={currentRootProject?.id}
            currentSessionId={props.currentSessionId}
            worktreesByProject={props.worktreesByProject}
            branchByProject={props.branchByProject}
            removingWorktreePaths={props.removingWorktreePaths}
          />
        </section>
      </div>
      {/* 底栏 dock（beUI Dock）：设置/反馈/官网/主题切换收进浮动卡片，铺满底栏宽度
          （w-full + justify-between 让四个动作均匀分布，侧栏最小宽 208px 时也不溢出）。
          DockItem 只提供尺寸与居中容器，按钮本体仍是 shadcn ghost（title/aria 不丢）。 */}
      {!props.isLanWeb && (
        <div className="flex shrink-0 items-center px-2 pb-2 pt-1">
          <Dock size={32} className="w-full justify-between">
            <DockItem>
              <div className="relative size-full">
                {/* 有可用更新时 title 换成带说明的文案，避免用户把角标误认成别的状态（如 dsh 未安装） */}
                <Button type="button" variant="ghost" className="size-full rounded-full text-muted-foreground hover:bg-muted hover:text-foreground" title={hasPendingUpdate ? t("settings.titleWithUpdate") : t("settings.title")} aria-label={hasPendingUpdate ? t("settings.titleWithUpdate") : t("settings.title")} onClick={props.onOpenSettings}><Bolt className="size-4" /></Button>
                {/* 更新角标：PiDeck 或 Pi CLI 有可提示更新时在设置按钮右上角显示圆点 */}
                {hasPendingUpdate && <span className="pointer-events-none absolute right-1 top-1 size-2 rounded-full bg-[var(--color-accent)]" aria-hidden="true" />}
              </div>
            </DockItem>
            <DockItem>
              <Button type="button" variant="ghost" className="size-full rounded-full text-muted-foreground hover:bg-muted hover:text-foreground" title={t("feedback.title")} aria-label={t("feedback.title")} onClick={props.onOpenFeedback}><MessageSquare className="size-4" /></Button>
            </DockItem>
            <DockItem>
              <Button type="button" variant="ghost" className="size-full rounded-full text-muted-foreground hover:bg-muted hover:text-foreground" title={t("app.homepage")} aria-label={t("app.homepage")} onClick={props.onOpenHomepage}><Globe className="size-4" /></Button>
            </DockItem>
            <DockItem>
              <Button type="button" variant="ghost" className="size-full rounded-full text-muted-foreground hover:bg-muted hover:text-foreground" title={themeToggleTitle} aria-label={themeToggleTitle} onClick={props.onToggleTheme}><ThemeModeIcon className="size-4" /></Button>
            </DockItem>
          </Dock>
        </div>
      )}

      {controller.sourceFilterMenu && (
        <SessionSourceFilterMenu
          menu={controller.sourceFilterMenu}
          filter={controller.sourceFilterFor(controller.sourceFilterMenu.projectId)}
          onToggleSource={(source) =>
            controller.toggleSourceFilter(controller.sourceFilterMenu!.projectId, source)
          }
          onClear={() => controller.clearSourceFilter(controller.sourceFilterMenu!.projectId)}
          onClose={controller.closeSourceFilter}
        />
      )}
      {menuProject && menu?.kind === "project" && (
        <ProjectContextMenu
          menu={{ x: menu.x, y: menu.y, project: menuProject }}
          onClose={controller.closeMenu}
          onNewSession={() => { void actions.sessions.createDraft(menuProject.id); controller.closeMenu(); }}
          onNewAnonymousSession={() => { void actions.sessions.createAnonymous(menuProject.id); controller.closeMenu(); }}
          onRevealProject={() => { void actions.projects.reveal(menuProject); controller.closeMenu(); }}
          onOpenWithEditor={() => { actions.projects.openWithEditor(menuProject); controller.closeMenu(); }}
          onImportCodexSessions={() => { actions.projects.importSessions(menuProject, "codex"); controller.closeMenu(); }}
          onImportClaudeSessions={() => { actions.projects.importSessions(menuProject, "claude"); controller.closeMenu(); }}
          onImportOpenCodeSessions={() => { actions.projects.importSessions(menuProject, "opencode"); controller.closeMenu(); }}
          onManageProjectResources={() => { actions.projects.manageResources(menuProject); controller.closeMenu(); }}
          onManageSessions={() => { controller.openSessionManager(menuProject.id); controller.closeMenu(); }}
          onFilterSessions={() => { controller.openSourceFilter(menuProject.id, menu.x, menu.y + 20); controller.closeMenu(); }}
          onToggleWorktree={() => { void actions.projects.toggleWorktree(menuProject); controller.closeMenu(); }}
          onRefreshProject={() => { void actions.projects.refresh(menuProject.id); controller.closeMenu(); }}
          onCopyProjectPath={() => { void actions.projects.copyPath(menuProject); controller.closeMenu(); }}
          onRenameProject={() => { actions.projects.rename(menuProject); controller.closeMenu(); }}
          onRemoveWorktree={menuProjectWorktreeParent ? () => {
            void actions.worktrees.remove(menuProjectWorktreeParent.id, {
              path: menuProject.path,
              branch: menuProject.name,
            }, menuProject);
            controller.closeMenu();
          } : undefined}
          onRemoveProject={() => { void actions.projects.remove(menuProject); controller.closeMenu(); }}
        />
      )}
      {menuAgent && menu?.kind === "agent" && (
        <AgentContextMenu
          menu={{ x: menu.x, y: menu.y, agent: menuAgent }}
          onClose={controller.closeMenu}
          onRename={() => { actions.agents.rename(menuAgent); controller.closeMenu(); }}
          isPinned={menuAgentSessionRecord ? controller.isSessionPinned(menuAgentSessionRecord.id) : false}
          onTogglePinned={menuAgentSessionRecord && menu.pinnable !== false ? () => {
            controller.toggleSessionPin(menuAgentSessionRecord.id);
            controller.closeMenu();
          } : undefined}
          onExport={() => { void actions.agents.export(menuAgent); controller.closeMenu(); }}
          onCopySession={() => { void actions.agents.copySession(menuAgent); controller.closeMenu(); }}
          onCopySessionFilePath={() => { void actions.agents.copyPath(menuAgent); controller.closeMenu(); }}
          onOpenSessionFile={() => { void actions.agents.openSessionFile(menuAgent); controller.closeMenu(); }}
          // 重启会话对所有状态开放（actions.agents.restart 内部按绑定状态分派）；重新加载保留给无 live 运行时
          onRestartSession={() => { actions.agents.restart(menuAgent); controller.closeMenu(); }}
          onReloadSession={!menuAgentLive ? () => { controller.closeMenu(); void actions.agents.reload(menuAgent); } : undefined}
          onToggleRpcLogging={() => {
            // 兜底：置灰的菜单项点击不触发 onSelect，这里防御 agent 状态在菜单打开期间变化的情况
            if (!menuAgentCanRpcLog) {
              showNotice(t("menu.rpcLoggingRequiresRuntime"), 2500);
              controller.closeMenu();
              return;
            }
            controller.closeMenu();
            if (controller.isAgentRpcLogging(menuAgent.id)) {
              // 已开启：菜单项显示「关闭RPC日志」→ 直接关闭记录（历史文件保留，30 天自动清理）
              void actions.rpc.setLogging(menuAgent.id, false).then((enabled) => {
                controller.setAgentRpcLogging(menuAgent.id, enabled);
                showNotice(enabled ? t("rpc.loggingDisableFailed") : t("rpc.loggingDisabled"), 2500);
              }).catch(() => showNotice(t("rpc.loggingDisableFailed"), 2500));
              return;
            }
            void actions.rpc.setLogging(menuAgent.id, true).then((enabled) => {
              controller.setAgentRpcLogging(menuAgent.id, enabled);
              if (enabled) {
                // 开启成功弹提醒框（含“查看日志”入口），不再自动打开日志弹窗
                setRpcLogOpenedAgentId(menuAgent.id);
              } else {
                showNotice(t("rpc.loggingEnableFailed"), 2500);
              }
            }).catch(() => showNotice(t("rpc.loggingEnableFailed"), 2500));
          }}
          isRpcLogging={controller.isAgentRpcLogging(menuAgent.id)}
          rpcToggleDisabled={!menuAgentCanRpcLog}
          onOpenLogs={() => { controller.openRpcLogs(menuAgent.id); controller.closeMenu(); }}
          onCloseAgent={() => { void actions.agents.close(menuAgent); controller.closeMenu(); }}
          onDeleteSession={() => {
            const bound = Object.entries(controller.catalog.runtimeBySessionId).find(
              ([, runtime]) => runtime?.agentId === menuAgent.id,
            );
            const sessionId = bound?.[0];
            const projectId = menuAgent.projectId;
            const record = sessionId
              ? controller.catalog.sessionsByProject[projectId]?.find((session) => session.id === sessionId)
              : undefined;
            if (record?.status === "draft") {
              void actions.sessions.deleteDraft(record);
            } else if (record) {
              const summary = sessionRecordToSummary(record);
              if (summary) void actions.sessions.delete(projectId, summary);
            }
            controller.closeMenu();
          }}
        />
      )}
      {menuDraft && menu?.kind === "draft" && menuDraft.status === "draft" && !menuAgent && (
        <DraftSessionContextMenu
          menu={{ x: menu.x, y: menu.y }}
          onClose={controller.closeMenu}
          onDelete={() => { void actions.sessions.deleteDraft(menuDraft); controller.closeMenu(); }}
        />
      )}
      {menuSession && menu?.kind === "session" && (
        <SessionContextMenu
          menu={{ x: menu.x, y: menu.y, session: menuSession }}
          onClose={controller.closeMenu}
          onRename={() => { actions.sessions.rename(menu.projectId, menuSession); controller.closeMenu(); }}
          isPinned={controller.isSessionPinned(menuSession.id)}
          onTogglePinned={menu.pinnable ? () => {
            controller.toggleSessionPin(menuSession.id);
            controller.closeMenu();
          } : undefined}
          onOpenProxySetting={() => { controller.closeMenu(); setProxyDialogSessionId(menuSession.id); }}
          // 重启会话（未启动的历史会话走 activateRuntime 启动；有绑定则走 restartRuntime）
          onRestartSession={() => { controller.closeMenu(); void actions.sessions.restart(menu.projectId, menuSession); }}
          // 未启动的历史会话：从磁盘重新加载会话消息文件（外部修改后刷新）
          onReloadSession={() => { controller.closeMenu(); void actions.sessions.reload(menu.projectId, menuSession); }}
          onExport={() => { void actions.sessions.export(menu.projectId, menuSession); controller.closeMenu(); }}
          onCopySession={() => { void actions.sessions.copy(menu.projectId, menuSession); controller.closeMenu(); }}
          onCopySessionFilePath={() => { void actions.sessions.copyPath(menuSession); controller.closeMenu(); }}
          onOpenSessionFile={() => { void actions.sessions.openFile(menuSession); controller.closeMenu(); }}
          // F5：DSH 会话无 filePath 但可复制 host 会话文件路径（主进程按 dshSessionId 推导）
          hasFilePath={Boolean(menuSession.filePath) || menuSession.backend === "dsh"}
          canRpcLog={Boolean(menuSessionRuntimeAgent)}
          rpcToggleDisabled={!menuSessionRuntimeAgent}
          isRpcLogging={menuSessionRuntimeAgent ? controller.isAgentRpcLogging(menuSessionRuntimeAgent.id) : false}
          onToggleRpcLogging={() => {
            // 历史会话（无 runtime）不会渲染该项；兜底防御状态变化
            if (!menuSessionRuntimeAgent) {
              showNotice(t("menu.rpcLoggingRequiresRuntime"), 2500);
              controller.closeMenu();
              return;
            }
            controller.closeMenu();
            if (controller.isAgentRpcLogging(menuSessionRuntimeAgent.id)) {
              // 已开启：菜单项显示「关闭RPC日志」→ 直接关闭记录
              void actions.rpc.setLogging(menuSessionRuntimeAgent.id, false).then((enabled) => {
                controller.setAgentRpcLogging(menuSessionRuntimeAgent.id, enabled);
                showNotice(enabled ? t("rpc.loggingDisableFailed") : t("rpc.loggingDisabled"), 2500);
              }).catch(() => showNotice(t("rpc.loggingDisableFailed"), 2500));
              return;
            }
            void actions.rpc.setLogging(menuSessionRuntimeAgent.id, true).then((enabled) => {
              controller.setAgentRpcLogging(menuSessionRuntimeAgent.id, enabled);
              if (enabled) {
                setRpcLogOpenedAgentId(menuSessionRuntimeAgent.id);
              } else {
                showNotice(t("rpc.loggingEnableFailed"), 2500);
              }
            }).catch(() => showNotice(t("rpc.loggingEnableFailed"), 2500));
          }}
          onOpenLogs={() => {
            if (menuSessionRuntimeAgent) controller.openRpcLogs(menuSessionRuntimeAgent.id);
            controller.closeMenu();
          }}
          onArchiveSession={() => { void actions.sessions.archive(menu.projectId, menuSession); controller.closeMenu(); }}
          onDeleteSession={() => { void actions.sessions.delete(menu.projectId, menuSession); controller.closeMenu(); }}
        />
      )}
      {/* 会话代理设置弹框（菜单项「会话代理」打开；会话 id 为 null 时关闭） */}
      {proxyDialogSessionId && (
        <SessionProxyDialog
          sessionId={proxyDialogSessionId}
          onClose={() => setProxyDialogSessionId(null)}
        />
      )}
      {managerProject && (
        /* 弹窗项目上下文 = 整个 worktree 家族（根 + 全部子工作区）：主列表并集展示，
           归档按家族过滤，worktree 会话打工作区标签（策略见 sessionManagerModel）。 */
        <SessionManagerModal
          projects={controller.catalog.projects}
          projectId={managerProject.id}
          sessions={(worktreeFamilyProjects(controller.catalog.projects, managerProject.id)
            .flatMap((project) => controller.catalog.sessionsByProject[project.id] ?? [])
            .map(sessionRecordToSummary)
            .filter((summary): summary is SessionSummary => Boolean(summary && isManagerSessionSummary(summary)))
            .sort((a, b) => b.updatedAt - a.updatedAt))}
          onClose={controller.closeSessionManager}
          onRename={(session) => actions.sessions.rename(managerProject.id, session)}
          onExport={(session) => void actions.sessions.export(managerProject.id, session)}
          onDelete={(sessions) => Promise.all(sessions.map((session) => actions.sessions.delete(managerProject.id, session))).then(controller.closeSessionManager)}
          onArchive={(sessions) => Promise.all(sessions.map((session) => actions.sessions.archive(managerProject.id, session))).then(controller.closeSessionManager)}
          onUnarchive={(archived) => actions.sessions.unarchive(archived, managerProject.id)}
          listArchived={actions.sessions.listArchived}
          deleteArchived={(archivedPath) => actions.sessions.deleteArchived(archivedPath)}
          onUnarchiveDsh={(dshSessionId) => actions.sessions.unarchiveDsh(dshSessionId, managerProject.id)}
          listArchivedDsh={actions.sessions.listArchivedDsh}
          deleteArchivedDsh={(dshSessionId) => actions.sessions.deleteArchivedDsh(dshSessionId)}
        />
      )}
      {controller.worktreeCreateProjectId && (
        <WorktreeCreateDialog
          projectId={controller.worktreeCreateProjectId}
          creating={Boolean(props.creatingWorktree)}
          onCreate={(branchName) => void actions.worktrees.create(controller.worktreeCreateProjectId!, branchName).then(controller.closeWorktreeCreate)}
          onClose={controller.closeWorktreeCreate}
        />
      )}
      {controller.rpcLogAgentId && (
        <RpcLogViewer
          agentId={controller.rpcLogAgentId}
          loadHistory={actions.rpc.listLogs}
          getLogging={actions.rpc.getLogging}
          setLogging={actions.rpc.setLogging}
          onClose={controller.closeRpcLogs}
        />
      )}
      {/* “RPC 日志已打开”提醒：点击菜单后弹框，可直达日志查看弹窗 */}
      {rpcLogOpenedAgentId && (
        <RpcLogOpenedDialog
          onView={() => {
            controller.openRpcLogs(rpcLogOpenedAgentId);
            setRpcLogOpenedAgentId(null);
          }}
          onClose={() => setRpcLogOpenedAgentId(null)}
        />
      )}
    </aside>
  );
}
