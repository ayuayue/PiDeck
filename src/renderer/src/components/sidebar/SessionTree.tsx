import { Fragment, type ReactNode } from "react";
import { ChevronDown, HatGlasses, Trash2 } from "lucide-react";
import type { AgentTab, Project, SessionRecord, SessionSummary } from "../../../../shared/types";
import { filterAgentsForSidebarDisplay, getProjectAgentSessionDisplay, sessionStatusDotClass, type ProjectChildItem } from "../../agentListDisplay";
import { sessionRecordToSummary } from "../../atoms";
import { t } from "../../i18n";
import { filterSidebarSessions, getBoundSidebarRuntimeAgent, hasLiveSidebarRuntime, type SidebarController } from "../../hooks/useSidebarController";
import { Button } from "../ui-shadcn/button";
import { PathTooltip } from "../ui-shadcn/PathTooltip";
import type { SidebarActions } from "./SidebarContent";
import { SessionSourceBadge } from "../session/SessionSourceBadge";
import { cn } from "../../lib/utils";

/** pure official：与 ProjectTree 对齐的会话/agent 行底色。
 * 注意：不要加 w-full——w-full(width:100%) 叠加 .agent-row/.session-row 的 margin-left 缩进
 * 会让行向右溢出父容器，右圆角被 overflow-x:hidden 裁掉；width:auto（foundation.css）即可撑满。 */
const sessionRowClass =
	"conversation agent-row relative flex min-h-11 items-center gap-2 rounded-lg border border-transparent bg-background px-3 py-2 text-left text-body text-foreground shadow-none transition-[background-color,border-color] duration-200 hover:border-border-subtle hover:bg-muted/60 hover:text-foreground";

function matchesSearch(value: string, search: string) {
  return !search || value.toLowerCase().includes(search.toLowerCase());
}

function formatCodexSubagentName(session: SessionSummary) {
  return [session.codexAgentNickname, session.codexAgentRole].filter(Boolean).join(" · ") ||
    session.name || t("app.codexSubagent");
}

function formatPiSubagentName(session: SessionSummary) {
  return session.name || t("app.piSubagent");
}

/**
 * 复用 Tab 栏的状态点语义，并把点绑定到具体 Agent/历史会话行。
 * 没有 runtime 的历史记录传入 undefined，因此纯打开记录不会被误标成已启动。
 */
function renderRuntimeStatusDot(status?: string | null) {
  const dotClass = sessionStatusDotClass(status);
  if (!dotClass) return null;
  const label = status === "idle"
    ? t("app.statusIdle")
    : status === "error"
      ? t("app.statusError")
      : status === "running" || status === "starting" || status === "pending" || status === "waiting"
        ? t("app.statusRunning")
        : undefined;
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        dotClass,
        status === "error" ? "" : "animate-pulse",
      )}
      aria-label={label}
      title={label}
    />
  );
}

export function SessionTree(props: {
  project: Project;
  sessions: readonly SessionRecord[];
  agents: readonly AgentTab[];
  currentSessionId?: string;
  controller: SidebarController;
  actions: SidebarActions;
  nested?: boolean;
  visibleChildCount?: number;
  onShowMore?: () => void;
}) {
  const filter = props.controller.sourceFilterFor(props.project.id);
  const search = props.controller.search.trim();
  const draftSessions = props.sessions
    .filter((session) => session.status === "draft")
    .filter((session) => matchesSearch(session.title, search))
    .filter((session) => filter === null || filter.has(session.source))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const allSummaries = props.sessions.flatMap((session) => {
    const summary = sessionRecordToSummary(session);
    return summary ? [summary] : [];
  });
  const summaries = filterSidebarSessions(allSummaries, filter)
    .filter((session) => matchesSearch(`${session.name ?? ""}${session.preview}${session.filePath}`, search));
  const projectAgents = props.agents.filter((agent) => agent.projectId === props.project.id);
  const displayAgents = filterAgentsForSidebarDisplay({
    agents: projectAgents,
    allSessions: allSummaries,
    visibleSessions: summaries,
    sources: filter,
  });
  const display = getProjectAgentSessionDisplay({
    agents: displayAgents,
    sessions: summaries,
    visibleChildCount: props.visibleChildCount ?? (props.nested ? Number.MAX_SAFE_INTEGER : props.controller.visibleChildCountFor(props.project.id)),
  });
  const catalogLoading = props.controller.catalog.catalogLoadStateByProject[props.project.id]?.status === "loading";
  const hasRows = catalogLoading || draftSessions.length > 0 || display.visibleChildren.length > 0 || display.hiddenChildCount > 0;
  if (!hasRows) return null;

  const openContext = (event: React.MouseEvent, session: SessionSummary) => {
    event.preventDefault();
    const runtime = getBoundSidebarRuntimeAgent(props.controller.catalog, session.id);
    void props.controller.openMenu(runtime
      ? { kind: "agent", agentId: runtime.id, x: event.clientX, y: event.clientY }
      : { kind: "session", projectId: props.project.id, sessionId: session.id, x: event.clientX, y: event.clientY });
  };
  const openDraftContext = (event: React.MouseEvent, session: SessionRecord) => {
    event.preventDefault();
    const runtime = props.controller.catalog.runtimeBySessionId[session.id];
    const runtimeAgent = getBoundSidebarRuntimeAgent(props.controller.catalog, session.id);
    if (runtimeAgent) {
      void props.controller.openMenu({
        kind: "agent",
        agentId: runtimeAgent.id,
        x: event.clientX,
        y: event.clientY,
      });
      return;
    }
    // The runtime snapshot can arrive just before the Agent inventory. Suppress
    // a destructive menu in that gap; the main process applies the same guard.
    if (hasLiveSidebarRuntime(runtime)) return;
    void props.controller.openMenu({
      kind: "draft",
      projectId: props.project.id,
      sessionId: session.id,
      x: event.clientX,
      y: event.clientY,
    });
  };
  const renderSubagent = (session: SessionSummary, label: ReactNode) => {
    return (
      <PathTooltip key={session.id} content={session.filePath}>
        <button
          type="button"
          className={cn(
            sessionRowClass,
            "session-row codex-subagent-sidebar-row pl-6",
            session.id === props.currentSessionId && "active border-border-strong bg-accent/20 text-foreground shadow-sm",
          )}
          onContextMenu={(event) => openContext(event, session)}
          onClick={() => void props.actions.sessions.open(props.project.id, session.id)}
        >
          <div className="conversation-body min-w-0 flex-1"><div className="conversation-title flex min-w-0 items-center gap-1.5">{label}</div></div>
        </button>
      </PathTooltip>
    );
  };
  const renderSubagents = (parentKey: string, codex: SessionSummary[], pi: SessionSummary[]) => {
    if (codex.length + pi.length === 0 || !props.controller.expandedSubagentGroups.has(parentKey)) return null;
    return (
      <div className="codex-subagent-sidebar-group">
        {codex.map((session) => renderSubagent(session, <><strong>{formatCodexSubagentName(session)}</strong><SessionSourceBadge source="codex" label={t("app.codexSubagent")} /></>))}
        {pi.map((session) => renderSubagent(session, <strong>{formatPiSubagentName(session)}</strong>))}
      </div>
    );
  };
  const renderToggle = (key: string, count: number) => count > 0 ? (
    <span
      className="subagent-inline-toggle"
      title={t("app.piSubagentCount", { count })}
      onClick={(event) => { event.stopPropagation(); props.controller.toggleSubagentGroup(key); }}
    >
      <ChevronDown size={10} className={props.controller.expandedSubagentGroups.has(key) ? "expanded" : ""} />
      {/* 子 Agent 数量：统一 pill 样式（与项目行会话数徽标同尺寸同圆角） */}
      <span className="subagent-inline-count inline-flex h-4 shrink-0 items-center rounded-full px-1.5 text-micro font-medium tabular-nums">{count}</span>
    </span>
  ) : null;

  // main 语义：项目下直接展示统一列表（drafts + 会话/Agent 按时间混排），不分组标题；
  // Tab 栏同款状态点跟随具体 Agent/历史会话行；没有 runtime 的纯历史记录保持无点。
  const renderChild = (child: ProjectChildItem) => {
    const groupKey = `${props.project.id}:${child.key}`;
    const childCount = child.codexSubagents.length + child.piSubagents.length;
    if (child.type === "agent") {
      const agentSession = props.sessions.find((session) => (
        props.controller.catalog.runtimeBySessionId[session.id]?.agentId === child.agent.id
      )) ?? summaries.find((session) => session.filePath === child.agent.sessionPath);
      return <Fragment key={child.key}>
        {/* 运行中 Agent 行：标题常被 truncate（如 "JZSSC40..."），悬浮展示完整标题 */}
        <PathTooltip content={child.agent.title}>
          <button
            type="button"
            className={cn(
              sessionRowClass,
              agentSession?.id === props.currentSessionId && "active border-border-strong bg-accent/20 text-foreground shadow-sm",
            )}
            onContextMenu={(event) => { event.preventDefault(); void props.controller.openMenu({ kind: "agent", agentId: child.agent.id, x: event.clientX, y: event.clientY }); }}
            onClick={() => { if (agentSession) void props.actions.sessions.open(props.project.id, agentSession.id); }}
          >
            {renderRuntimeStatusDot(child.agent.status)}
            <div className="conversation-body min-w-0 flex-1"><div className="conversation-title flex min-w-0 items-center gap-1.5">
              <strong className="min-w-0 flex-1 truncate font-medium">{child.agent.title}</strong>
              {child.agent.noSession && <span className="anonymous-indicator" title={t("app.anonymousChat")}><HatGlasses size={11} aria-hidden="true" /></span>}
              {renderToggle(groupKey, childCount)}
            </div></div>
          </button>
        </PathTooltip>
        {renderSubagents(groupKey, child.codexSubagents, child.piSubagents)}
      </Fragment>;
    }
    const runtime = getBoundSidebarRuntimeAgent(props.controller.catalog, child.session.id);
    const runtimeSnapshot = props.controller.catalog.runtimeBySessionId[child.session.id];
    return <Fragment key={child.session.id}>
      {/* 悬浮第一行展示完整会话名（行内常被 truncate），第二行展示文件路径 */}
      <PathTooltip content={`${child.session.name || t("common.untitled")}\n${child.session.filePath}`}>
        <button
          type="button"
          className={cn(
            sessionRowClass,
            // 历史会话不是运行中的 Agent：只给这一类内容增加层级缩进，避免项目标题与历史记录贴在同一列。
            // 历史会话需要比运行中 Agent 更松的点击区域和行间距，避免连续记录挤成一块。
            "session-row history-session-row mx-0 mb-1 last:mb-0 min-h-11 pl-3 pr-3 py-2",
            child.session.id === props.currentSessionId && "active border-border-strong bg-accent/20 text-foreground shadow-sm",
          )}
          onContextMenu={(event) => openContext(event, child.session)}
          onClick={() => void props.actions.sessions.open(props.project.id, child.session.id)}
        >
        {renderRuntimeStatusDot(runtimeSnapshot?.status)}
        <div className="conversation-body min-w-0 flex-1"><div className="conversation-title flex min-w-0 items-center gap-1.5">
          {/* 历史会话（无运行态）文字降一级，与活跃 Agent/运行中会话形成层级差 */}
          <strong className={cn("min-w-0 flex-1 truncate", runtime ? "font-medium" : "font-normal text-muted-foreground/90")}>{child.session.name || t("common.untitled")}</strong>
          {child.session.source && child.session.source !== "pi" && <SessionSourceBadge source={child.session.source} />}
          {renderToggle(groupKey, childCount)}
        </div></div>
      </button>
      </PathTooltip>
      {renderSubagents(groupKey, child.codexSubagents, child.piSubagents)}
    </Fragment>;
  };

  return (
    <div className={cn(
      props.nested ? "worktree-children m-0 border-0 bg-transparent p-0" : "session-card",
      "flex flex-col gap-2 py-1",
    )}>
      {draftSessions.map((session) => {
        const runtime = props.controller.catalog.runtimeBySessionId[session.id];
        const canDelete = !hasLiveSidebarRuntime(runtime);
        return (
          <div
            key={`draft:${session.id}`}
            className={cn("draft-session-row group/draft grid items-center gap-1", canDelete ? "grid-cols-[minmax(0,1fr)_2rem]" : "grid-cols-1 has-runtime")}
            onContextMenu={(event) => openDraftContext(event, session)}
          >
          <PathTooltip content={session.title}>
            <button
              type="button"
              className={cn(
                sessionRowClass,
                "session-row draft-session-trigger",
                session.id === props.currentSessionId && "active border-border-strong bg-accent/20 text-foreground shadow-sm",
              )}
              onClick={() => void props.actions.sessions.open(props.project.id, session.id)}
            >
              <div className="conversation-body min-w-0 flex-1"><div className="conversation-title flex min-w-0 items-center gap-1.5">
                {renderRuntimeStatusDot(runtime?.status)}
                <strong className="min-w-0 flex-1 truncate font-medium">{session.title}</strong>
              </div></div>
            </button>
          </PathTooltip>
            {canDelete && (
              <Button variant="ghost" size="icon"
                className="draft-session-delete"
                aria-label={t("common.delete")} title={t("common.delete")}
                onClick={() => void props.actions.sessions.deleteDraft(session)}
              >
                <Trash2 size={14} aria-hidden="true" />
              </Button>
            )}
          </div>
        );
      })}
      {catalogLoading && <div className="project-session-loading"><div className="loader" /><span>{t("app.projectSessionsLoading")}</span></div>}
      {display.visibleChildren.map(renderChild)}

      {display.hiddenChildCount > 0 && (
        <Button
          variant="ghost" size="sm" className={`h-auto justify-start px-2 text-caption ${props.nested ? "worktree-sessions-more" : "session-more-row"}`}
          onClick={props.onShowMore ?? (() => props.controller.showMoreChildren(props.project.id))}
        >
          <span>{props.nested
            ? t("app.worktreeShowMoreSessions", { count: display.hiddenChildCount })
            : t("app.projectShowMoreChildren", { count: display.hiddenChildCount })}
          </span>
        </Button>
      )}
    </div>
  );
}
