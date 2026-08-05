import { ChevronDown, ChevronRight, GitBranch, Plus, Trash2 } from "lucide-react";
import type { AgentTab, Project, SessionRecord, WorktreeEntry } from "../../../../shared/types";
import type { SidebarController } from "../../hooks/useSidebarController";
import { t } from "../../i18n";
import type { SidebarActions } from "./SidebarContent";
import { SessionTree } from "./SessionTree";
import { Button } from "../ui-shadcn/button";
import { PathTooltip } from "../ui-shadcn/PathTooltip";
import { cn } from "../../lib/utils";
import { mergeWorkspaceTreeRows, type WorkspaceTreeRow } from "./workspaceTreeModel";

export function WorktreeTree(props: {
  project: Project;
  controller: SidebarController;
  actions: SidebarActions;
  currentProjectId?: string;
  currentSessionId?: string;
  sessions: readonly SessionRecord[];
  agents: readonly AgentTab[];
  entries: readonly WorktreeEntry[];
  branch?: string | null;
}) {
  const childProjects = props.controller.catalog.projects.filter(
    (project) => project.worktreeParentId === props.project.id,
  );
  const rows = mergeWorkspaceTreeRows(props.entries, childProjects);

  return (
    <div className="workspace-tree min-w-0 bg-muted/20 py-1 pl-2">
      <section className="workspace-tree-main mb-0.5" aria-label={t("app.worktreeMainWorkspace")}>
        <Button
          type="button"
          variant="ghost"
          className={cn(
            "conversation worktree-workspace-header h-8 w-full justify-start gap-2 px-2 text-left",
            props.currentProjectId === props.project.id && "active border-accent/35 bg-accent/10 text-accent-foreground shadow-sm shadow-accent/10",
          )}
          onClick={() => props.actions.projects.select(props.project.id)}
          title={t("app.worktreeMainWorkspace")}
        >
          <span className="worktree-main-branch-icon shrink-0"><GitBranch size={13} /></span>
          <span className="conversation-body min-w-0 flex-1">
            <span className="conversation-title flex min-w-0 items-center gap-1.5">
              <strong className="min-w-0 truncate font-medium">{t("app.worktreeMainWorkspace")}</strong>
              <span className="worktree-main-branch min-w-0 truncate">{props.branch ?? t("app.worktreeBranchLoading")}</span>
            </span>
          </span>
        </Button>
        {/* Worktree 模式下主工作区是默认展开的第一项；根项目历史必须挂在这里，
            不能等 Worktree 列表渲染完再由 ProjectTree 追加到所有工作区之后。 */}
        <div className="workspace-tree-main-sessions pl-4">
          <SessionTree
            project={props.project}
            sessions={props.sessions}
            agents={props.agents}
            currentSessionId={props.currentSessionId}
            controller={props.controller}
            actions={props.actions}
          />
        </div>
      </section>

      <section className="workspace-tree-list" aria-label={t("app.worktreeOtherWorkspaces")}>
        <header className="workspace-tree-section-header flex min-h-7 items-center justify-between gap-2 px-2 text-caption text-muted-foreground">
          <span className="min-w-0 truncate">{t("app.worktreeOtherWorkspaces")}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="workspace-tree-create"
            title={t("app.worktreeNew")}
            aria-label={t("app.worktreeNew")}
            onClick={() => props.controller.openWorktreeCreate(props.project.id)}
          >
            <Plus size={13} />
          </Button>
        </header>

        {rows.map((row) => (
          <WorkspaceTreeRowView
            key={row.key}
            row={row}
            rootProject={props.project}
            controller={props.controller}
            actions={props.actions}
            currentProjectId={props.currentProjectId}
            currentSessionId={props.currentSessionId}
          />
        ))}
      </section>
    </div>
  );
}

/**
 * 单个工作区行：选择、展开和破坏性操作拆成并列控件，避免嵌套 button/role=button
 * 造成 click 冒泡串线。只有真实 child project 才显示会话和删除/新建操作。
 */
function WorkspaceTreeRowView(props: {
  row: WorkspaceTreeRow;
  rootProject: Project;
  controller: SidebarController;
  actions: SidebarActions;
  currentProjectId?: string;
  currentSessionId?: string;
}) {
  const { row } = props;
  const childProject = row.project;
  const expanded = Boolean(childProject && props.controller.expandedWorktreePaths.has(row.path));
  const rowId = `worktree-sessions-${row.key.replace(/[^a-z0-9]+/gi, "-")}`;
  const isActive = childProject?.id === props.currentProjectId;

  return (
    <div className={cn("workspace-tree-row group flex min-w-0 flex-wrap items-center gap-0.5 rounded-lg p-0.5 text-muted-foreground transition-colors", isActive && "bg-accent/60 text-foreground")}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="workspace-tree-expand shrink-0 text-muted-foreground"
        aria-expanded={expanded}
        aria-controls={childProject ? rowId : undefined}
        aria-label={expanded ? t("app.projectCollapse") : t("app.projectExpand")}
        title={expanded ? t("app.projectCollapse") : t("app.projectExpand")}
        disabled={!childProject}
        onClick={() => props.controller.toggleWorktreeSessions(row.path)}
      >
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </Button>

      {/* 悬浮展示完整分支名 + 工作区路径（分支名在行内常被 truncate） */}
      <PathTooltip content={`${row.branch}${row.directory !== row.branch ? ` (${row.directory})` : ""}\n${row.path}`}>
        <button
          type="button"
          className="workspace-tree-select flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-control text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
          disabled={!childProject}
          onClick={() => childProject && props.actions.projects.select(childProject.id)}
          onContextMenu={(event) => {
            if (!childProject) return;
            event.preventDefault();
            void props.controller.openMenu({
              kind: "project",
              projectId: childProject.id,
              x: event.clientX,
              y: event.clientY,
            });
          }}
        >
          <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-medium">{row.branch}</span>
          {row.directory !== row.branch && (
            <span className="workspace-tree-directory max-w-20 shrink-0 truncate text-micro text-muted-foreground">{row.directory}</span>
          )}
        </button>
      </PathTooltip>

      {childProject && (
        <div className="workspace-tree-actions pointer-events-none flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground"
            title={t("app.projectNewAgent")}
            aria-label={t("app.projectNewAgent")}
            onClick={() => void props.actions.sessions.createDraft(childProject.id)}
          >
            <Plus size={13} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-danger"
            title={t("menu.removeProject")}
            aria-label={t("menu.removeProject")}
            onClick={() => void props.actions.worktrees.remove(props.rootProject.id, {
              path: row.path,
              branch: row.branch,
            }, childProject)}
          >
            <Trash2 size={13} />
          </Button>
        </div>
      )}

      {expanded && childProject && (
        <div id={rowId} className="workspace-tree-sessions ml-6 min-w-0 basis-[calc(100%-24px)] pl-2">
          <SessionTree
            project={childProject}
            sessions={props.controller.catalog.sessionsByProject[childProject.id] ?? []}
            agents={props.controller.catalog.agents}
            currentSessionId={props.currentSessionId}
            controller={props.controller}
            actions={props.actions}
            nested
            visibleChildCount={props.controller.visibleChildCountFor(childProject.id)}
            onShowMore={() => props.controller.showMoreChildren(childProject.id)}
          />
        </div>
      )}
    </div>
  );
}
