import { ChevronsDownUp, Filter, HatGlasses, Play, Plus } from "lucide-react";
import type { DragEvent } from "react";
import type { Project, WorktreeEntry } from "../../../../shared/types";
import type { SidebarController } from "../../hooks/useSidebarController";
import { t } from "../../i18n";
import type { SidebarActions } from "./SidebarContent";
import { SessionTree } from "./SessionTree";
import { WorktreeTree } from "./WorktreeTree";
import { PathTooltip } from "../ui-shadcn/PathTooltip";
import { cn } from "../../lib/utils";

/** pure official：项目/会话树行共享的 shadcn 风格底（hover=accent 面，active 同系） */
const treeRowClass =
  "group conversation relative flex min-h-7 w-full items-center gap-1.5 rounded-lg border border-transparent bg-background px-2 py-0 text-body text-foreground shadow-none transition-[background-color,border-color] duration-200 hover:border-border-subtle hover:bg-muted/60 hover:text-foreground";

function isChatProject(project: Project) {
  return project.kind === "chat";
}

function displayProjectDirectoryName(project: Project) {
  if (isChatProject(project)) return "Chat";
  const normalizedPath = project.path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalizedPath.split("/").pop() || project.name || project.path;
}

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
      `${session.title}${session.preview}${session.filePath ?? ""}`.toLowerCase().includes(query));
  });
}

export function ProjectTree(props: {
  controller: SidebarController;
  actions: SidebarActions;
  currentProjectId?: string;
  /** 实际选中的项目（可能是 worktree 子项目），用于高亮工作区行。 */
  selectedProjectId?: string;
  currentSessionId?: string;
  worktreesByProject: Readonly<Record<string, readonly WorktreeEntry[]>>;
  branchByProject?: Readonly<Record<string, string | null | undefined>>;
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
      const isCurrent = props.currentProjectId === project.id;
      const projectDirectoryName = displayProjectDirectoryName(project);
      const sourceFilter = props.controller.sourceFilterFor(project.id);
      const dragging = props.controller.drag.sourceProjectId === project.id;
      const dragOver = props.controller.drag.overProjectId === project.id;
      const rootProjectSessions = props.controller.catalog.sessionsByProject[project.id] ?? [];
      // 运行态属于具体会话，而不是项目容器；项目行只负责导航，避免多个 Agent 同时运行时
      // 项目头像出现无法指向目标会话的聚合动画。
      return <div key={project.id} className={cn("project-group mb-2", project.worktreeEnabled && "worktree-enabled")}>
        <div
          className={cn(
            treeRowClass,
            !props.controller.search.trim() && "project-draggable",
            dragging && "dragging opacity-60",
            dragOver && "drag-over ring-1 ring-border",
            isCurrent && "active border-border-strong bg-accent/20 text-foreground shadow-sm",
          )}
          data-active={isCurrent || undefined}
          onContextMenu={(event) => { event.preventDefault(); void props.controller.openMenu({ kind: "project", projectId: project.id, x: event.clientX, y: event.clientY }); }}
        >
          <button
            type="button"
            className={cn("project-fold grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground", collapsed && "folded")}
            title={collapsed ? t("app.projectExpand") : t("app.projectCollapse")}
            aria-label={collapsed ? t("app.projectExpand") : t("app.projectCollapse")}
            onClick={() => props.controller.toggleProject(project.id)}
          >
            <Play size={12} className={cn("transition-transform", !collapsed && "rotate-90")} />
          </button>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 py-0 pr-1 text-left"
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
            <div className="conversation-body min-w-0 flex-1">
              <div className="conversation-title flex min-w-0 items-center">
                {/* 悬浮展示完整项目目录名 + 路径（目录名在行内常被 truncate） */}
                <PathTooltip content={`${projectDirectoryName}\n${project.path}`}>
                  <strong className="min-w-0 flex-1 truncate font-medium">{projectDirectoryName}</strong>
                </PathTooltip>
              </div>
              {/* 项目名称只承担导航信息；详细会话状态由下方的 Agent/历史会话行承担。 */}
            </div>
          </button>
          <div className="flex shrink-0 items-center gap-1 pr-1">
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
            {isCurrent && (
              <button type="button" className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-background/80 hover:text-foreground" title={t("app.projectNewAgent")} aria-label={t("app.projectNewAgent")} onClick={() => void props.actions.sessions.createDraft(project.id)}><Plus size={14} /></button>
            )}
            <div className="flex items-center gap-1">
              {!isCurrent && (
                <button type="button" className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-background/80 hover:text-foreground" title={t("app.projectNewAgent")} aria-label={t("app.projectNewAgent")} onClick={() => void props.actions.sessions.createDraft(project.id)}><Plus size={14} /></button>
              )}
              <button type="button" className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-background/80 hover:text-foreground" title={t("app.anonymousChat")} aria-label={t("app.anonymousChat")} onClick={() => void props.actions.sessions.createAnonymous(project.id)}><HatGlasses size={14} /></button>
            </div>
          </div>
        </div>
        {!collapsed && (
          <div className="ml-2 mt-2 mr-1 space-y-1 pb-1">
            {/* 展开内容不依赖当前选中项，项目切换只改变高亮，避免两棵会话树同时伸缩造成布局抖动。 */}
            {project.worktreeEnabled ? (
              <WorktreeTree
                project={project}
                controller={props.controller}
                actions={props.actions}
                currentProjectId={props.selectedProjectId}
                currentSessionId={props.currentSessionId}
                sessions={rootProjectSessions}
                agents={props.controller.catalog.agents}
                entries={props.worktreesByProject[project.id] ?? []}
                branch={props.branchByProject?.[project.id]}
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
  return <>
    {chatProjects.map((project) => {
      const collapsed = props.controller.isProjectCollapsed(project.id);
      const sessions = props.controller.catalog.sessionsByProject[project.id] ?? [];
      return (
        <section key={project.id} className="mb-5" aria-label={t("app.chatProject")}>
          <div
            className="flex items-center justify-between px-2 pb-1"
            onContextMenu={(event) => {
              event.preventDefault();
              void props.controller.openMenu({ kind: "project", projectId: project.id, x: event.clientX, y: event.clientY });
            }}
          >
            <span className="text-caption font-medium text-muted-foreground">{t("app.chatProject")}</span>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title={collapsed ? t("app.projectExpand") : t("app.projectCollapse")}
                aria-label={collapsed ? t("app.projectExpand") : t("app.projectCollapse")}
                aria-expanded={!collapsed}
                onClick={() => props.controller.toggleProject(project.id)}
              >
                {/* Chat 没有可点击的父项目行，折叠入口固定放在标题栏，避免展开后无法恢复。 */}
                <ChevronsDownUp size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title={t("app.newSession")}
                aria-label={t("app.newSession")}
                onClick={() => void props.actions.sessions.createDraft(project.id)}
              >
                <Plus size={13} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title={t("app.anonymousChat")}
                aria-label={t("app.anonymousChat")}
                onClick={() => void props.actions.sessions.createAnonymous(project.id)}
              >
                <HatGlasses size={13} aria-hidden="true" />
              </button>
            </div>
          </div>
          {!collapsed && (
            <div className="space-y-1">
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
    })}
    {workspaceProjects.length > 0 && (
      <section aria-label={t("app.sidebarProjects")}>
        <div className="px-2 pb-1 text-caption font-medium text-muted-foreground">{t("app.sidebarProjects")}</div>
        {workspaceProjects.map(renderProject)}
      </section>
    )}
  </>;
}
