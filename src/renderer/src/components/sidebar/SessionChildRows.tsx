import { Bot, ChevronDown, Ellipsis, Link2 } from "lucide-react";
import type { ReactNode } from "react";
import type { Project, SessionRecord, SessionSummary } from "../../../../shared/types";
import type { LinkedSessionLink, LinkedSessionState } from "../../../../shared/types/linkedSessions";
import type { SidebarController } from "../../hooks/useSidebarController";
import { sessionRecordToSummary } from "../../atoms";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { hasPendingAskForSession } from "../../utils/askUi";
import { Button } from "../ui-shadcn/button";
import { PendingAskBadge } from "./PendingAskBadge";
import { SessionHoverCard } from "./SessionHoverCard";
import { SessionRuntimeStatusDot } from "./SidebarStatusDot";
import { SidebarRowTime } from "./SidebarRowTime";
import { TitleScrollText } from "./TitleScrollText";
import { ROW_CONTAINER_CLASS, ROW_MORE_ACTIONS_CLASS, SESSION_ROW_CLASS, SESSION_ROW_SELECTED_CLASS } from "./sidebarRowStyles";
import type { SidebarActions } from "./SidebarContent";
import { LINKED_NEST_MAX_DEPTH } from "./activitySessionsModel";
import type { ChildGroupKind } from "../../utils/childGroupState";

/**
 * 父会话下面的子项（关联子会话 + 子智能体）统一渲染。
 *
 * 设计约束（用户 2027-02 反馈后收敛）：子行除了左侧一个 12px 身份图标，尺寸、字号、
 * 字重、颜色、时间样式都与普通会话行完全一致——层级只由容器上一条 1px 导轨和缩进表达，
 * 不再每行画 ↪。父行只显示两个来源计数（链接 12 / 机器人 21），改由子项分组标题再说明一次，
 * 避免「一个 33 胶囊」看不出两类内容。
 *
 * 分组默认状态沿用既有语义：关联子会话常显（它们是用户可直接对话的会话），
 * 子智能体收起（可能很多），由父行右侧机器人计数承担展开按钮（父行是 button，不能嵌套按钮，
 * 故用锚点定位的浮层按钮，见 foundation.css 的 .session-toggle-row）。
 */

/** 关联子会话的展示状态 → 状态点语义（与 Tab 栏同一套颜色）；有活着的运行时时以运行时为准。 */
const LINKED_STATE_DOT: Record<LinkedSessionState, string | undefined> = {
	starting: "starting",
	running: "running",
	idle: "idle",
	failed: "error",
	stopped: undefined,
};

function linkedStateLabel(state: LinkedSessionState): string {
	switch (state) {
		case "starting":
			return t("linkedSessions.state.starting");
		case "running":
			return t("linkedSessions.state.running");
		case "idle":
			return t("linkedSessions.state.idle");
		case "failed":
			return t("linkedSessions.state.failed");
		case "stopped":
			return t("linkedSessions.state.stopped");
	}
}

function linkedChildTooltip(link: LinkedSessionLink): string {
	const head = `${linkedStateLabel(link.state)} · ${t("linkedSessions.turns", { count: link.turnCount })}`;
	return link.lastReport ? `${head}\n${t("linkedSessions.lastReport")}：${link.lastReport}` : head;
}

function formatCodexSubagentName(session: SessionSummary) {
	return [session.codexAgentNickname, session.codexAgentRole].filter(Boolean).join(" · ") || session.name || t("app.codexSubagent");
}

/** 子项行所需的上下文：父行与子行共用同一份打开/菜单/拖拽入口，避免每行透传一长串 props。 */
export type SessionChildRowContext = {
	project: Project;
	currentSessionId?: string;
	controller: SidebarController;
	actions: SidebarActions;
	activityAt: (sessionId: string | undefined, fallback: number) => number;
	dragProps: (sessionId: string) => Record<string, unknown>;
	openSession: (sessionId: string, tabMode?: "preview" | "permanent") => void;
	openContext: (event: React.MouseEvent, session: SessionSummary, pinnable?: boolean) => void;
	sessionRuntimeUiById: Parameters<typeof hasPendingAskForSession>[1];
};

/** 父行右侧的分组计数 + 展开按钮：两类子项各一个，互不影响（收起 30 条会话不影响子智能体）。
 *  父行本身是 button，不能嵌按钮，所以真实按钮是浮层，几何由 CSS anchor 对齐到行内占位；
 *  slot = 行内占位（宽度与可见按钮一致），非 slot = 真的可点按钮。 */
export function ChildGroupToggle(props: { kind: ChildGroupKind; groupKey: string; count: number; expanded: boolean; onToggle: (groupKey: string, kind: ChildGroupKind, count: number) => void; slot?: boolean }) {
	if (props.count <= 0) return null;
	const label = t("sidebar.childGroupToggle", { group: t(props.kind === "linked" ? "sidebar.childGroupLinked" : "sidebar.childGroupAgents"), count: props.count });
	const content = (
		<>
			{props.kind === "linked" ? <Link2 className="size-3" aria-hidden="true" /> : <Bot className="size-3" aria-hidden="true" />}
			<span className="tabular-nums">{props.count}</span>
			<ChevronDown className={cn("size-3 transition-transform", !props.expanded && "-rotate-90")} aria-hidden="true" />
		</>
	);
	if (props.slot)
		return (
			<span className="child-toggle child-toggle-slot px-1 py-0.5 last:mr-7" data-kind={props.kind} aria-hidden="true">
				{content}
			</span>
		);
	return (
		<button type="button" className="child-toggle child-toggle-button px-1 py-0.5 focus-visible:ring-1 focus-visible:ring-ring" data-kind={props.kind} aria-label={label} aria-expanded={props.expanded} title={label} onClick={() => props.onToggle(props.groupKey, props.kind, props.count)}>
			{content}
		</button>
	);
}

/** 分类标题：比子行更轻的一条分组说明，本身也是收起入口（比父行的小计数好点）。 */
function ChildGroupLabel(props: { icon: ReactNode; label: string; count: number; onToggle?: () => void }) {
	const content = (
		<>
			<span className="flex size-3 items-center justify-center">{props.icon}</span>
			<span className="truncate">{props.label}</span>
			<span className="font-mono tabular-nums">{props.count}</span>
			{props.onToggle && <ChevronDown className="size-3" aria-hidden="true" />}
		</>
	);
	const className = "mt-1.5 mb-0.5 flex w-full items-center gap-1 rounded px-1.5 py-0.5 text-micro font-semibold text-muted-foreground/70";
	if (!props.onToggle) return <div className={className}>{content}</div>;
	return (
		<button type="button" className={cn(className, "text-left transition-colors hover:bg-bg-hover hover:text-muted-foreground")} title={t("sidebar.childGroupCollapse")} onClick={props.onToggle}>
			{content}
		</button>
	);
}

/** 子行骨架：关联子会话与子智能体共用同一份 markup，保证「只差一个图标」。 */
function ChildRow(props: {
	icon: ReactNode;
	title: string;
	titleClassName?: string;
	session?: SessionSummary | SessionRecord;
	projectName?: string;
	status?: string | null;
	timeAt: number;
	selected: boolean;
	pendingAsk: boolean;
	moreActive: boolean;
	linkState?: LinkedSessionState;
	linkTooltip?: string;
	onOpen: () => void;
	onOpenPermanent?: () => void;
	onContextMenu?: (event: React.MouseEvent) => void;
	dragProps?: Record<string, unknown>;
	onMore?: (event: React.MouseEvent<HTMLButtonElement>) => void;
	hoverDisabled: boolean;
}) {
	return (
		<div className={ROW_CONTAINER_CLASS} data-linked-state={props.linkState} onContextMenu={props.onContextMenu}>
			<SessionHoverCard session={props.session} title={props.title} projectName={props.projectName} status={props.status} disabled={props.hoverDisabled}>
				<button type="button" className={cn(SESSION_ROW_CLASS, "session-row pl-2", props.selected && SESSION_ROW_SELECTED_CLASS)} title={props.linkTooltip ? `${props.title}\n${props.linkTooltip}` : undefined} onClick={props.onOpen} onDoubleClick={props.onOpenPermanent} {...props.dragProps}>
					<span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">{props.icon}</span>
					<SessionRuntimeStatusDot status={props.status} />
					<div className="conversation-body min-w-0 flex-1 transition-[padding-right] group-hover/row:pr-7 group-focus-within/row:pr-7">
						<div className="conversation-title flex min-w-0 items-center gap-1.5">
							<TitleScrollText text={props.title} className={props.titleClassName} />
							{props.pendingAsk && <PendingAskBadge count={1} />}
							<SidebarRowTime at={props.timeAt} />
						</div>
					</div>
				</button>
			</SessionHoverCard>
			{props.onMore && (
				<Button type="button" variant="ghost" size="icon-xs" className={cn(ROW_MORE_ACTIONS_CLASS, props.moreActive && "pointer-events-auto opacity-100")} aria-label={t("sidebar.moreActions")} title={t("sidebar.moreActions")} onClick={props.onMore}>
					<Ellipsis size={14} aria-hidden="true" />
				</Button>
			)}
		</div>
	);
}

function LinkedChildRow(props: { record: SessionRecord; link: LinkedSessionLink; ctx: SessionChildRowContext; moreActive: boolean }) {
	const summary = sessionRecordToSummary(props.record);
	const liveStatus = props.ctx.controller.catalog.runtimeBySessionId[props.record.id]?.status;
	const dotStatus = props.link.state === "failed" ? "error" : (liveStatus ?? LINKED_STATE_DOT[props.link.state]);
	const title = props.record.title || t("common.untitled");
	return (
		<ChildRow
			icon={<Link2 className="size-3" aria-label={t("linkedSessions.childBadge")} />}
			title={title}
			titleClassName={cn(liveStatus ? "font-medium" : "font-normal text-muted-foreground/90")}
			session={props.record}
			projectName={props.ctx.project.name}
			status={dotStatus}
			timeAt={props.ctx.activityAt(props.record.id, props.record.updatedAt)}
			selected={props.record.id === props.ctx.currentSessionId}
			pendingAsk={hasPendingAskForSession(props.record.id, props.ctx.sessionRuntimeUiById)}
			moreActive={props.moreActive}
			linkState={props.link.state}
			linkTooltip={linkedChildTooltip(props.link)}
			hoverDisabled={Boolean(props.ctx.controller.menu)}
			onOpen={() => props.ctx.openSession(props.record.id)}
			onOpenPermanent={props.ctx.actions.sessions.simpleNavigation ? undefined : () => props.ctx.openSession(props.record.id, "permanent")}
			onContextMenu={summary ? (event) => props.ctx.openContext(event, summary, false) : undefined}
			dragProps={props.ctx.dragProps(props.record.id)}
			onMore={
				summary
					? (event) => {
							event.stopPropagation();
							props.ctx.openContext(event, summary, false);
						}
					: undefined
			}
		/>
	);
}

function SubagentRow(props: { session: SessionSummary; codex: boolean; ctx: SessionChildRowContext; moreActive: boolean }) {
	const title = props.codex ? formatCodexSubagentName(props.session) : props.session.name || t("app.piSubagent");
	return (
		<ChildRow
			icon={<Bot className="size-3" aria-label={t("sidebar.childGroupAgents")} />}
			title={title}
			session={props.session}
			projectName={props.ctx.project.name}
			timeAt={props.ctx.activityAt(props.session.id, props.session.updatedAt)}
			selected={props.session.id === props.ctx.currentSessionId}
			pendingAsk={hasPendingAskForSession(props.session.id, props.ctx.sessionRuntimeUiById)}
			moreActive={props.moreActive}
			hoverDisabled={Boolean(props.ctx.controller.menu)}
			onOpen={() => props.ctx.openSession(props.session.id)}
			onOpenPermanent={props.ctx.actions.sessions.simpleNavigation ? undefined : () => props.ctx.openSession(props.session.id, "permanent")}
			onContextMenu={(event) => props.ctx.openContext(event, props.session, false)}
			dragProps={props.ctx.dragProps(props.session.id)}
			onMore={(event) => {
				event.stopPropagation();
				props.ctx.openContext(event, props.session, false);
			}}
		/>
	);
}

export type SessionChildBranchProps = {
	ctx: SessionChildRowContext;
	/** 关联子会话的父子索引（与父行递归共用；孙会话要靠它继续往下找）。 */
	childrenByParent: ReadonlyMap<string, readonly SessionRecord[]>;
	linkByChildId: ReadonlyMap<string, LinkedSessionLink>;
	/** 两类子项各自的展开态（父行计数按钮与这里必须同源，否则点一下会“跳”）。 */
	linkedExpanded: boolean;
	agentsExpanded: boolean;
	onToggle: (groupKey: string, kind: ChildGroupKind, count: number) => void;
	groupKey: string;
	linkedChildren?: readonly SessionRecord[];
	codexSubagents?: readonly SessionSummary[];
	piSubagents?: readonly SessionSummary[];
	/** 分组标题是否可点收起：孙会话分组没有自己的计数按钮，传 false 避免点了没反应。 */
	interactive?: boolean;
	depth?: number;
};

/**
 * 一段子项区块（导轨 + 分组标题 + 若干子行）：父行调用一次，关联子会话行再递归调用一次。
 * 没有可见子项时返回 null，不留下空导轨。
 */
export function SessionChildBranch(props: SessionChildBranchProps) {
	const { ctx } = props;
	const linked = props.linkedChildren ?? [];
	const codex = props.agentsExpanded ? (props.codexSubagents ?? []) : [];
	const pi = props.agentsExpanded ? (props.piSubagents ?? []) : [];
	// 收起态整组不渲染（含分组标题）：只靠父行计数表达「下面还有 N 条」。
	const linkedRows = props.linkedExpanded ? linked : [];
	const depth = props.depth ?? 1;
	const interactive = props.interactive !== false;
	if (linkedRows.length === 0 && codex.length + pi.length === 0) return null;
	const menu = ctx.controller.menu;
	return (
		<div className={cn("flex flex-col", depth > LINKED_NEST_MAX_DEPTH ? "ml-0" : "ml-2")} data-testid="session-child-branch">
			<div className="border-l border-border-subtle pl-1.5">
				{linkedRows.length > 0 && (
					<>
						<ChildGroupLabel icon={<Link2 className="size-3" aria-hidden="true" />} label={t("sidebar.childGroupLinked")} count={linked.length} onToggle={interactive ? () => props.onToggle(props.groupKey, "linked", linked.length) : undefined} />
						{linkedRows.map((record) => {
							const link = props.linkByChildId.get(record.id);
							if (!link) return null;
							// 孙会话分组没有自己的计数按钮，按默认规则展开（数量少就展开）。
							const grandChildren = props.childrenByParent.get(record.id);
							return (
								<div key={record.id} className="flex flex-col">
									<LinkedChildRow record={record} link={link} ctx={ctx} moreActive={menu?.kind === "session" && menu.sessionId === record.id} />
									<SessionChildBranch
										ctx={ctx}
										childrenByParent={props.childrenByParent}
										linkByChildId={props.linkByChildId}
										// 孙会话分组没有折叠按钮，且只可能因为父行可见才渲染：直接展开，否则会被默认收起藏掉。
										linkedExpanded={true}
										agentsExpanded={false}
										onToggle={props.onToggle}
										interactive={false}
										groupKey={`${props.groupKey}:${record.id}`}
										linkedChildren={grandChildren}
										depth={depth + 1}
									/>
								</div>
							);
						})}
					</>
				)}
				{codex.length + pi.length > 0 && (
					<>
						<ChildGroupLabel icon={<Bot className="size-3" aria-hidden="true" />} label={t("sidebar.childGroupAgents")} count={codex.length + pi.length} onToggle={interactive ? () => props.onToggle(props.groupKey, "agents", codex.length + pi.length) : undefined} />
						{codex.map((session) => (
							<SubagentRow key={`codex:${session.id}`} session={session} codex ctx={ctx} moreActive={menu?.kind === "session" && menu.sessionId === session.id} />
						))}
						{pi.map((session) => (
							<SubagentRow key={`pi:${session.id}`} session={session} codex={false} ctx={ctx} moreActive={menu?.kind === "session" && menu.sessionId === session.id} />
						))}
					</>
				)}
			</div>
		</div>
	);
}
