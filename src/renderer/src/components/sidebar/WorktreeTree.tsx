import { ChevronDown, ChevronRight, Ellipsis, GitBranch, Plus } from "lucide-react";
import type { AgentTab, Project, SessionRecord, WorktreeEntry } from "../../../../shared/types";
import type { SidebarController } from "../../hooks/useSidebarController";
import { t } from "../../i18n";
import type { SidebarActions } from "./SidebarContent";
import { SessionTree } from "./SessionTree";
import { Button } from "../ui-shadcn/button";
import { cn } from "../../lib/utils";
import { mergeWorkspaceTreeRows, type WorkspaceTreeRow } from "./workspaceTreeModel";
import { normalizeWorkspacePath } from "./workspaceTreeModel";

// 主工作区是根项目展开后的首个导航项，字号需要与父项目保持一致；
// 其他 worktree 只是该项目的分支入口，渲染时会覆写为较小的 text-control，避免子项抢占层级。
const workspaceRowClass =
  "workspace-tree-row relative flex min-h-8 min-w-0 items-center gap-0.5 rounded-md p-0.5 text-body text-foreground transition-[background-color,border-color,box-shadow] duration-fast hover:bg-muted/60";
const workspaceSelectClass =
  "flex min-h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-0 text-left text-body text-muted-foreground transition-[color,background-color,padding-right] hover:bg-accent hover:text-accent-foreground disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted-foreground";
const workspaceActionClass = "text-muted-foreground hover:bg-muted hover:text-foreground";
const workspaceActionPaddingClass =
  "group-hover/workspace-row:pr-[52px] group-focus-within/workspace-row:pr-[52px]";
const workspaceSessionsClass = "min-w-0 basis-[calc(100%-24px)] ml-6 pl-2";

/**
 * 工作区标题操作与普通项目行保持同一呈现：两个等尺寸的 + / ⋯ 浮层按钮。
 * 子工作区的标题行独立命名为 group，展开后的会话列表不会意外点亮标题操作。
 */
function WorkspaceRowActions(props: {
  children: React.ReactNode;
  menuOpen?: boolean;
}) {
  return (
    <div
      className={cn(
        "workspace-tree-actions pointer-events-none absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity group-hover/workspace-row:pointer-events-auto group-hover/workspace-row:opacity-100 group-focus-within/workspace-row:pointer-events-auto group-focus-within/workspace-row:opacity-100",
        props.menuOpen && "pointer-events-auto opacity-100",
      )}
    >
      {props.children}
    </div>
  );
}

export function WorktreeTree(props: {
  project: Project;
  controller: SidebarController;
  actions: SidebarActions;
  currentSessionId?: string;
  sessions: readonly SessionRecord[];
  agents: readonly AgentTab[];
  entries: readonly WorktreeEntry[];
  branch?: string | null;
  /** 正在删除的 worktree 路径集合（与 removingWorktreePaths 同源，路径已归一化）。 */
  removingWorktreePaths?: ReadonlySet<string>;
}) {
  const childProjects = props.controller.catalog.projects.filter(
    (project) => project.worktreeParentId === props.project.id,
  );
  const rows = mergeWorkspaceTreeRows(props.entries, childProjects);
  // 删除动画命中集合：useWorktreeActions 里以原始路径为 key，这里统一归一化再比较，
  // 避免 Windows 盘符大小写/反斜杠差异导致该淡出的行不命中（与 workspaceTreeModel 同策略）。
  const removingPaths = new Set(
    [...(props.removingWorktreePaths ?? [])].map(normalizeWorkspacePath),
  );
  // 主工作区折叠态复用 worktree 展开集合，key 用根项目路径（与任何 worktree 路径都不冲突）。
  // 注意语义反转：集合里存在 = 已折叠（worktree 行是存在 = 展开），因为主工作区默认展开。
  const mainSessionsKey = props.project.path;
  const mainCollapsed = props.controller.expandedWorktreePaths.has(mainSessionsKey);
  const mainRowId = `worktree-main-sessions-${props.project.id}`;
  const mainActionsOpen = props.controller.menu?.kind === "project"
    && props.controller.menu.projectId === props.project.id;

  return (
    <div className="workspace-tree min-w-0 py-1 pl-1">
      <section className="workspace-tree-main" aria-label={t("app.worktreeMainWorkspace")}>
        <div className={cn(workspaceRowClass, "group/workspace-row")}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="workspace-tree-expand shrink-0 text-muted-foreground"
            aria-expanded={!mainCollapsed}
            aria-controls={mainRowId}
            aria-label={mainCollapsed ? t("app.projectExpand") : t("app.projectCollapse")}
            title={mainCollapsed ? t("app.projectExpand") : t("app.projectCollapse")}
            onClick={() => props.controller.toggleWorktreeSessions(mainSessionsKey)}
          >
            {mainCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(
              // 工作区行是容器，不跟会话抢选中底；选中只画在 SessionTree 叶子上。
              "conversation worktree-workspace-header h-7 justify-start text-left",
              workspaceSelectClass,
            )}
            onClick={() => props.actions.projects.select(props.project.id)}
            title={t("app.worktreeMainWorkspace")}
          >
            <span className="worktree-main-branch-icon grid size-5 shrink-0 place-items-center text-muted-foreground"><GitBranch size={14} /></span>
            <span
              className={cn(
                "conversation-body min-w-0 flex-1 transition-[padding-right]",
                workspaceActionPaddingClass,
                mainActionsOpen && "pr-[52px]",
              )}
            >
              <span className="conversation-title flex min-w-0 items-center gap-1.5">
                <strong className="min-w-0 truncate font-medium">{t("app.worktreeMainWorkspace")}</strong>
                <span className="worktree-main-branch min-w-0 truncate text-control text-muted-foreground">{props.branch ?? t("app.worktreeBranchLoading")}</span>
              </span>
            </span>
          </Button>
          {/* 工作区标题也复用项目栏的 + / ⋯ 操作；根项目行保留自己的原有入口。 */}
          <WorkspaceRowActions
            menuOpen={mainActionsOpen}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={workspaceActionClass}
              aria-label={t("app.newNormalSession")}
              title={t("app.newNormalSession")}
              onClick={() => void props.actions.sessions.createDraft(props.project.id)}
            >
              <Plus size={13} aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={workspaceActionClass}
              aria-label={t("sidebar.moreActions")}
              title={t("sidebar.moreActions")}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                void props.controller.openMenu({
                  kind: "project",
                  projectId: props.project.id,
                  x: rect.right,
                  y: rect.bottom,
                });
              }}
            >
              <Ellipsis size={14} aria-hidden="true" />
            </Button>
          </WorkspaceRowActions>
        </div>
        {/* Worktree 模式下主工作区是默认展开的第一项；根项目历史必须挂在这里，
            不能等 Worktree 列表渲染完再由 ProjectTree 追加到所有工作区之后。 */}
        {!mainCollapsed && (
          <div id={mainRowId} className={cn("workspace-tree-main-sessions", workspaceSessionsClass)}>
            <SessionTree
              project={props.project}
              sessions={props.sessions}
              agents={props.agents}
              currentSessionId={props.currentSessionId}
              controller={props.controller}
              actions={props.actions}
            />
          </div>
        )}
      </section>

      <section className="workspace-tree-list" aria-label={t("app.worktreeOtherWorkspaces")}>
        <header className="workspace-tree-section-header mt-2 flex min-h-7 items-center justify-between gap-2 border-t border-border/40 px-2 pt-1 text-micro text-muted-foreground">
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
            controller={props.controller}
            actions={props.actions}
            currentSessionId={props.currentSessionId}
            removing={removingPaths.has(row.key)}
          />
        ))}
      </section>
    </div>
  );
}

/**
 * 单个工作区行：选择和展开拆成并列控件，避免嵌套 button/role=button
 * 造成 click 冒泡串线。只有真实 child project 才显示新建和更多操作。
 */
function WorkspaceTreeRowView(props: {
  row: WorkspaceTreeRow;
  controller: SidebarController;
  actions: SidebarActions;
  currentSessionId?: string;
  /** 该行是否正在删除（命中 removingWorktreePaths 时淡出）。 */
  removing?: boolean;
}) {
  const { row } = props;
  const childProject = row.project;
  const expanded = Boolean(childProject && props.controller.expandedWorktreePaths.has(row.path));
  const rowId = `worktree-sessions-${row.key.replace(/[^a-z0-9]+/gi, "-")}`;
  const childActionsOpen = childProject !== undefined
    && props.controller.menu?.kind === "project"
    && props.controller.menu.projectId === childProject.id;

  return (
    // 工作区行是容器：选中态只落在叶子会话上，分支名不加底、不加字重区分。
    <div className={cn(workspaceRowClass, "flex-wrap text-muted-foreground", props.removing && "worktree-removing")}>
      {/* 标题行单独成相对容器：会话列表（flex-wrap 换到下一行）留在外层，
          操作按钮 absolute 锚定本行，不会压到展开的历史会话上。 */}
      <div className="workspace-tree-header group/workspace-row relative flex min-w-0 flex-1 items-center gap-0.5">
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

        <button
          type="button"
          className={cn(
            "workspace-tree-select",
            workspaceSelectClass,
            // 子 worktree 是父项目下的分支入口，不应与父项目/主工作区争夺视觉层级。
            "text-control",
            // 与会话行一样，右侧操作显现时通过 padding-right 动画压缩标题，不让文字落在按钮下。
            workspaceActionPaddingClass,
            childActionsOpen && "pr-[52px]",
          )}
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

        {childProject && (
          <WorkspaceRowActions
            menuOpen={childActionsOpen}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={workspaceActionClass}
              aria-label={t("app.newNormalSession")}
              title={t("app.newNormalSession")}
              onClick={() => void props.actions.sessions.createDraft(childProject.id)}
            >
              <Plus size={13} aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={workspaceActionClass}
              aria-label={t("sidebar.moreActions")}
              title={t("sidebar.moreActions")}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                void props.controller.openMenu({
                  kind: "project",
                  projectId: childProject.id,
                  x: rect.right,
                  y: rect.bottom,
                });
              }}
            >
              <Ellipsis size={14} aria-hidden="true" />
            </Button>
          </WorkspaceRowActions>
        )}
      </div>

      {expanded && childProject && (
        <div id={rowId} className={cn("workspace-tree-sessions", workspaceSessionsClass)}>
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
