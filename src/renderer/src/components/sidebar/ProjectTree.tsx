import { ChevronRight, ChevronsDownUp, Ellipsis, Filter, Folder, FolderOpen, FolderPlus, List, Plus, RefreshCw, Settings2, UserPlus } from "lucide-react";
import type { DragEvent } from "react";
import type { Project, WorktreeEntry } from "../../../../shared/types";
import type { SidebarController } from "../../hooks/useSidebarController";
import { t } from "../../i18n";
import type { SidebarActions } from "./SidebarContent";
import { ActiveSessionsTree } from "./ActiveSessionsTree";
import { SessionTree } from "./SessionTree";
import { WorktreeTree } from "./WorktreeTree";
import { isLiveRuntimeStatus } from "../../utils/sessionCommands";
import { sessionDisplayName } from "../../utils/sessionDisplayName";
import { displayProjectDirectoryName, isChatProject } from "../../rendererUtils";
import { Button } from "../ui-shadcn/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui-shadcn/dropdown-menu";
import { cn } from "../../lib/utils";

/** 项目行只做容器：hover 浅灰，永不挂选中底。
 * 选中态只给叶子会话（对标 dsh-web：.sessionRow.selected = hover 灰，项目行无 selected）。 */
// 根项目行保留折叠层级，但收窄左右留白，给窄侧栏中的目录名多留出可用宽度。
const treeRowClass =
  "group conversation relative flex min-h-8 w-full items-center gap-1.5 rounded-lg border border-transparent px-1 py-0 text-body text-foreground shadow-none transition-[background-color,border-color,box-shadow] duration-200 hover:border-border-subtle hover:bg-muted/60 hover:text-foreground";

/** 项目行右侧操作按钮的虚化模式：absolute 浮层，不参与布局（不挤压项目名文字），
 * 默认隐藏（pointer-events 一并关闭防误触），行 hover / 行内聚焦时显现。
 * 按钮浮层会盖住项目名：conversation-body 上 group-hover:pr-16 在 hover 时压出
 * 右侧留白——容器 right-1(4px) + pr-1(4px) + 两个 size-6 按钮(52px) + 4px 余量 = 64px，
 * 文本截断让位但保持可见；启用来源筛选（sourceFilter）时共 3 个按钮，让位加宽到 88px。
 * 与 SessionTree/WorktreeTree 同一策略：所有宽度统一让位，不能只依赖窄侧栏断点
 * （中等宽度下长项目名同样会延伸到按钮下方，表现为 + / ⋯ 叠在项目名文字上）。
 * 2027-01 用户反馈：整行淡出到透明会导致标题不可读，必须点击激活才能看到文字；
 * 压缩+截断只损失尾部文字，不影响辨认。 */
const dimmedActionsClass =
	"pointer-events-none absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100";

function matchesProject(project: Project, search: string, controller: SidebarController) {
  if (!search) return true;
  const query = search.toLowerCase();
  // 搜索项目时把直属 worktree 视为同一工作区树，否则用户搜到 worktree 分支/会话
  // 后根项目会被过滤掉，导致结果实际存在却无法展开查看。
  const relatedProjects = controller.catalog.projects.filter(
    (candidate) => candidate.id === project.id || candidate.worktreeParentId === project.id,
  );
  return relatedProjects.some((related) => {
    if (`${related.name}${related.path}`.toLowerCase().includes(query)) return true;
    if (controller.catalog.agents.some((agent) => agent.projectId === related.id &&
      `${agent.title}${agent.cwd}${agent.sessionId ?? ""}`.toLowerCase().includes(query))) return true;
    return (controller.catalog.sessionsByProject[related.id] ?? []).some((session) =>
      `${sessionDisplayName(session.title, session.forked) ?? session.title}${session.preview}${session.filePath ?? ""}`.toLowerCase().includes(query));
  });
}

export function ProjectTree(props: {
  controller: SidebarController;
  actions: SidebarActions;
  currentProjectId?: string;
  currentSessionId?: string;
  worktreesByProject: Readonly<Record<string, readonly WorktreeEntry[]>>;
  branchByProject?: Readonly<Record<string, string | null | undefined>>;
  /** 正在删除的 worktree 路径集合（透传给 WorktreeTree 驱动淡出动画）。 */
  removingWorktreePaths?: ReadonlySet<string>;
}) {
  const rootProjects = props.controller.catalog.projects.filter((project) =>
    !project.worktreeParentId && matchesProject(project, props.controller.search.trim(), props.controller),
  );
  const dragStart = (event: DragEvent<HTMLButtonElement>, projectId: string) => {
    if (props.controller.search.trim()) return;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", projectId);
    props.controller.startProjectDrag(projectId);
  };
  const drop = (event: DragEvent<HTMLButtonElement>, projectId: string) => {
    event.preventDefault();
    const source = event.dataTransfer.getData("text/plain") || props.controller.drag.sourceProjectId;
    props.controller.finishProjectDrag();
    if (props.controller.search.trim()) return;
    if (source && source !== projectId) void props.actions.projects.reorder(source, projectId);
  };
  const renderProject = (project: Project) => {
      const collapsed = props.controller.isProjectCollapsed(project.id);
      const projectDirectoryName = displayProjectDirectoryName(project);
      const sourceFilter = props.controller.sourceFilterFor(project.id);
      const dragging = props.controller.drag.sourceProjectId === project.id;
      const dragOver = props.controller.drag.overProjectId === project.id;
      const rootProjectSessions = props.controller.catalog.sessionsByProject[project.id] ?? [];
      // 项目级「运行中」判定：任一 Agent 进程存活（starting/idle/running）即视为运行中。
      // 与 ActiveSessionsTree 活动页同源，保证折叠时的项目 tag 与展开后的子行状态一致。
      const hasLiveAgent = props.controller.catalog.agents.some(
        (agent) => agent.projectId === project.id && isLiveRuntimeStatus(agent.status),
      );
      // 运行态属于具体会话，而不是项目容器；项目行只负责导航，避免多个 Agent 同时运行时
      // 项目头像出现无法指向目标会话的聚合动画。
      return <div key={project.id} className={cn("project-group mb-1.5", project.worktreeEnabled && "worktree-enabled")}>
        <div
          className={cn(
            treeRowClass,
            !props.controller.search.trim() && "project-draggable",
            dragging && "dragging opacity-60",
            dragOver && "drag-over ring-1 ring-border",
          )}
          onContextMenu={(event) => { event.preventDefault(); void props.controller.openMenu({ kind: "project", projectId: project.id, x: event.clientX, y: event.clientY }); }}
        >
          <button
            type="button"
            className={cn("project-fold grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground", collapsed && "folded")}
            title={collapsed ? t("app.projectExpand") : t("app.projectCollapse")}
            aria-label={collapsed ? t("app.projectExpand") : t("app.projectCollapse")}
            onClick={() => props.controller.toggleProject(project.id)}
          >
            <ChevronRight size={14} className={cn("transition-transform", !collapsed && "rotate-90")} />
          </button>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1 py-0 pr-1 text-left"
            draggable={!props.controller.search.trim()}
            onDragStart={(event) => dragStart(event, project.id)}
            onDragOver={(event) => { if (props.controller.drag.sourceProjectId && props.controller.drag.sourceProjectId !== project.id) { event.preventDefault(); props.controller.setProjectDropTarget(project.id); } }}
            onDragLeave={() => props.controller.setProjectDropTarget(undefined)}
            onDrop={(event) => drop(event, project.id)}
            onDragEnd={props.controller.finishProjectDrag}
            onClick={() => {
              // 项目主行同时承担选择和手风琴切换，让项目卡片本身保持唯一且明确的导航入口。
              props.controller.toggleProject(project.id);
              props.actions.projects.select(project.id);
            }}
          >
            <span className="grid size-5 shrink-0 place-items-center text-muted-foreground" aria-hidden="true">
              {collapsed ? <Folder size={14} /> : <FolderOpen size={14} />}
            </span>
            <div className={cn(
              "conversation-body min-w-0 flex-1 transition-[padding-right] group-hover:pr-16 group-focus-within:pr-16",
              // 筛选按钮与 + / ⋯ 共 3 个按钮时让位 88px（24×3 + 8px 间隙 + 外层定位），
              // 否则文本会短到筛按钮下方。twMerge 保证后者胜出（见 sidebarNarrowRowActions 契约测试）。
              sourceFilter !== null && "group-hover:pr-[88px] group-focus-within:pr-[88px]",
            )}>
              <div className="conversation-title flex min-w-0 items-center">
                {/* 项目名 + 运行态点合成一个截断单元：点紧跟文本而不是被 space-between
                    推到最右——旧布局下点在行尾，鼠标移入时会被右侧浮层按钮盖住。 */}
                <div className="flex min-w-0 flex-1 items-center gap-1">
                  <strong className={`min-w-0 truncate font-medium${project.missing ? " text-muted-foreground" : ""}`}>{projectDirectoryName}</strong>
                  {/* 折叠时项目行只剩名称，用黄色状态点提示该工作区仍有 Agent 进程在跑；
                      展开后子行自带状态点，不再重复提示。颜色与语义对齐 agent 行的 running 状态点（bg-warning）。 */}
                  {collapsed && hasLiveAgent && (
                    <span
                      className="size-1.5 shrink-0 rounded-full bg-warning"
                      title={t("app.projectRunningHint")}
                      aria-hidden="true"
                    />
                  )}
                </div>
                {/* 目录已被删除/移动/未挂载：保留记录并标记，用户可右键移除或恢复目录 */}
                {project.missing && (
                  <span
                    className="shrink-0 rounded bg-destructive/10 px-1 text-[10px] font-medium leading-4 text-destructive"
                    title={t("app.projectMissingHint")}
                  >
                    {t("app.projectMissing")}
                  </span>
                )}
              </div>
              {/* 项目名称只承担导航信息；详细会话状态由下方的 Agent/历史会话行承担。 */}
            </div>
          </button>
          <div className={cn(dimmedActionsClass, "pr-1", props.controller.menu?.kind === "project" && props.controller.menu.projectId === project.id && "pointer-events-auto opacity-100")}>
            {sourceFilter !== null && (
              <button
                type="button"
                className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-background/80 hover:text-foreground"
                title={t("menu.filterSessions")}
                aria-label={t("menu.filterSessions")}
                onClick={(event) => props.controller.openSourceFilter(project.id, event.clientX, event.clientY)}
              >
                <Filter size={12} />
              </button>
            )}
            {/* 新建会话入口外露为 + 号（hover 项目行可见），匿名会话保留在 ⋯ 菜单 */}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("app.newNormalSession")}
              title={t("app.newNormalSession")}
              onClick={(event) => {
                event.stopPropagation();
                void props.actions.sessions.createDraft(project.id);
              }}
            >
              <Plus className="size-3.5" aria-hidden="true" />
            </Button>
            {/* 三个点：把项目右键菜单变成可见入口，让用户知道项目行还有更多操作 */}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("sidebar.moreActions")}
              title={t("sidebar.moreActions")}
              onClick={(event) => {
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                void props.controller.openMenu({ kind: "project", projectId: project.id, x: rect.right, y: rect.bottom });
              }}
            >
              <Ellipsis size={14} aria-hidden="true" />
            </Button>
          </div>
        </div>
        {!collapsed && (
          <div className="relative ml-3 mt-1 mr-1 space-y-0.5 pl-2 pb-1">
            {/* 展开内容不依赖当前选中项，项目切换只改变高亮，避免两棵会话树同时伸缩造成布局抖动。 */}
            {project.worktreeEnabled ? (
              <WorktreeTree
                project={project}
                controller={props.controller}
                actions={props.actions}
                currentSessionId={props.currentSessionId}
                sessions={rootProjectSessions}
                agents={props.controller.catalog.agents}
                entries={props.worktreesByProject[project.id] ?? []}
                branch={props.branchByProject?.[project.id]}
                removingWorktreePaths={props.removingWorktreePaths}
              />
            ) : (
              <SessionTree
                project={project}
                sessions={rootProjectSessions}
                agents={props.controller.catalog.agents}
                currentSessionId={props.currentSessionId}
                controller={props.controller}
                actions={props.actions}
              />
            )}
          </div>
        )}
      </div>;
  };

  const chatProjects = rootProjects.filter(isChatProject);
  const workspaceProjects = rootProjects.filter((project) => !isChatProject(project));
  // 任一工作区项目展开即视为“展开态”，供标题栏批量折叠按钮切换文案与 aria-expanded。
  // 基于完整 catalog（非搜索过滤后视图）计算，避免搜索时按钮状态与目录全局状态不一致。
  const anyWorkspaceExpanded = props.controller.catalog.projects.some(
    (project) => !project.worktreeParentId && !isChatProject(project) && !props.controller.isProjectCollapsed(project.id),
  );

  // 聊天/项目分段：chats 只显示内置 Chat 的会话；projects 显示所有工作区项目及其嵌套会话。
  // Tab 已承担「聊天/项目」文案，下面不再重复标题父块；两个区只保留各自必需的操作入口。
  const chatSection = chatProjects.map((project) => {
    const collapsed = props.controller.isProjectCollapsed(project.id);
    const sessions = props.controller.catalog.sessionsByProject[project.id] ?? [];
    return (
      <section key={project.id} className="mb-4" aria-label={t("app.chatProject")} role="treeitem" aria-expanded={!collapsed}>
        {/* 分组标题栏：左侧「聊天」标题，右侧 = 「+ 新建会话」+ 折叠（高频操作外露）
            + 「⋯ 更多操作」下拉（匿名会话/目录设置收纳其中）。
            新建与折叠都是最常用入口，直接外露；匿名会话使用率低，收进更多菜单。 */}
        <div className="flex items-center justify-between px-1 pb-1">
          <span className="text-caption font-medium text-muted-foreground">{t("app.sidebarChats")}</span>
          <div className="flex items-center gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={t("app.newNormalSession")}
              title={t("app.newNormalSession")}
              onClick={() => void props.actions.sessions.createDraft(project.id)}
            >
              <Plus className="size-3.5" aria-hidden="true" />
            </Button>
            {/* Chat 无父项目行，折叠入口必须外露，否则展开后无法从标题栏恢复。 */}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              title={collapsed ? t("app.projectExpand") : t("app.projectCollapse")}
              aria-label={collapsed ? t("app.projectExpand") : t("app.projectCollapse")}
              aria-expanded={!collapsed}
              onClick={() => props.controller.toggleProject(project.id)}
            >
              <ChevronsDownUp size={14} aria-hidden="true" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={t("sidebar.moreActions")}
                  title={t("sidebar.moreActions")}
                >
                  <Ellipsis size={14} aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={4} className="min-w-36">
                <DropdownMenuItem onSelect={() => void props.actions.sessions.createAnonymous(project.id)}>
                  <UserPlus className="size-3.5" aria-hidden="true" />
                  {t("app.newAnonymousSession")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {/* 会话管理：与项目会话管理同款弹窗（含归档/恢复/删除）；Chat 是内置项目同样适用 */}
                <DropdownMenuItem onSelect={() => { props.controller.openSessionManager(project.id); }}>
                  <List className="size-3.5" aria-hidden="true" />
                  {t("menu.manageSessions")}
                </DropdownMenuItem>
                {props.actions.projects.changeChatPath && (
                  <DropdownMenuItem onSelect={() => { void props.actions.projects.changeChatPath?.(project); }}>
                    <Settings2 className="size-3.5" aria-hidden="true" />
                    {t("app.chatProjectSettings")}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {!collapsed && (
          <div className="relative ml-3 space-y-0.5 pl-2">
            <SessionTree
              project={project}
              sessions={sessions}
              agents={props.controller.catalog.agents}
              currentSessionId={props.currentSessionId}
              controller={props.controller}
              actions={props.actions}
            />
          </div>
        )}
      </section>
    );
  });

  const projectsSection = (
    <>
      {workspaceProjects.length > 0 && (
        <section aria-label={t("app.sidebarProjects")} role="tree">
        {/* 分组标题栏：左侧「项目」标题，右侧 = 「+ 添加项目」+ 全部折叠/展开（高频操作外露）
            + 「⋯ 更多操作」。目录存在性重扫属于低频维护动作，收进菜单避免挤占窄侧栏。 */}
          <div className="flex items-center justify-between px-1 pb-1">
            <span className="text-caption font-medium text-muted-foreground">{t("app.sidebarProjects")}</span>
            <div className="flex items-center gap-0.5">
              {/* 添加项目是最常用入口，外露为显式「+」按钮 */}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label={t("app.addProject")}
                title={t("app.addProject")}
                onClick={() => void props.actions.projects.add()}
              >
                <Plus className="size-3.5" aria-hidden="true" />
              </Button>
              {/* 全部折叠/展开：批量收起所有工作区项目，批量展开/折叠入口外露（与聊天折叠同策略） */}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                title={anyWorkspaceExpanded ? t("app.projectCollapseAll") : t("app.projectExpandAll")}
                aria-label={anyWorkspaceExpanded ? t("app.projectCollapseAll") : t("app.projectExpandAll")}
                onClick={() => props.controller.toggleCollapseAllProjects()}
              >
                <ChevronsDownUp size={14} aria-hidden="true" />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={t("sidebar.moreActions")}
                    title={t("sidebar.moreActions")}
                  >
                    <Ellipsis size={14} aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={4} className="min-w-36">
                  <DropdownMenuItem onSelect={() => void props.actions.projects.refreshAll()}>
                    <RefreshCw className="size-3.5" aria-hidden="true" />
                    {t("app.projectRefreshAll")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          {workspaceProjects.map(renderProject)}
        </section>
      )}
      {/* 无任何工作区项目（新用户只有内置 Chat）：显式渲染空态引导。
          此前该分组整体不渲染，用户不知道可以添加项目目录，误以为只能聊天（issue #149）。 */}
      {workspaceProjects.length === 0 && (
        <section aria-label={t("app.sidebarProjects")} className="mt-1">
          <div className="flex items-center justify-between px-1 pb-1">
            <span className="text-caption font-medium text-muted-foreground">{t("app.sidebarProjects")}</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={t("sidebar.moreActions")}
                  title={t("sidebar.moreActions")}
                >
                  <Ellipsis size={14} aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" sideOffset={4} className="min-w-36">
                <DropdownMenuItem onSelect={() => void props.actions.projects.refreshAll()}>
                  <RefreshCw className="size-3.5" aria-hidden="true" />
                  {t("app.projectRefreshAll")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="mx-1 rounded-lg border border-dashed border-border-subtle bg-muted/20 px-3 py-4 text-center">
            <FolderPlus className="mx-auto mb-2 size-5 text-muted-foreground" aria-hidden="true" />
            <div className="text-body font-medium text-foreground">{t("sidebar.emptyProjectsTitle")}</div>
            <p className="mt-1 text-caption text-muted-foreground">{t("sidebar.emptyProjectsDesc")}</p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mt-3"
              title={t("app.addProject")}
              aria-label={t("app.addProject")}
              onClick={() => void props.actions.projects.add()}
            >
              <FolderPlus className="size-3.5" aria-hidden="true" />
              {t("app.addProject")}
            </Button>
          </div>
        </section>
      )}
    </>
  );

  return (
    <>
      {props.controller.navTab === "active" ? (
        <ActiveSessionsTree
          controller={props.controller}
          actions={props.actions}
          currentSessionId={props.currentSessionId}
        />
      ) : props.controller.navTab === "chats" ? chatSection : projectsSection}
    </>
  );
}
