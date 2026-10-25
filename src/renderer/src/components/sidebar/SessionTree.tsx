import { useEffect, useState, type ReactNode } from "react";
import { SidebarRemovalList, SidebarRemovalRow } from "./SidebarRemovalRow";
import { ChevronDown, ChevronUp, Ellipsis, HatGlasses, Image as ImageIcon, Pin, Trash2 } from "lucide-react";
import { useAtomValue } from "jotai";
import type { AgentTab, Project, SessionRecord, SessionSummary } from "../../../../shared/types";
import { collectDisplayedSessionIds, filterAgentsForSidebarDisplay, getProjectAgentSessionDisplay, sessionStatusDotClass, type ProjectChildItem } from "../../agentListDisplay";
import { compareSessionsForSortMode } from "../../sessionSortModes";
import { sessionRecordToSummary } from "../../atoms";
import { sessionRuntimeUiByIdAtom } from "../../atoms/session-atoms";
import { t } from "../../i18n";
import { formatRelativeTime } from "../../utils/relativeTime";
import { hasPendingAskForSession } from "../../utils/askUi";
import { filterSidebarSessions, getBoundSidebarRuntimeAgent, type SidebarController } from "../../hooks/useSidebarController";
import { Button } from "../ui-shadcn/button";
import type { SidebarActions } from "./SidebarContent";
import { PendingAskBadge } from "./PendingAskBadge";
import { AcpBackendMark, SessionBackendMark, SessionChannelMark, SessionSourceBadge, SideTaskMark } from "../session/SessionSourceBadge";
import { SessionActivityIndicator } from "../session/SessionActivityIndicator";
import { SessionHoverCard } from "./SessionHoverCard";
import { TitleScrollText } from "./TitleScrollText";
import { resolveBoundSession } from "./activitySessionsModel";
import { cn } from "../../lib/utils";
import { SESSION_TAB_DRAG_MIME } from "../../utils/sessionSplitEdge";
import { useSessionActivityAt } from "../../hooks/sidebar/useSessionActivityClock";

/** 与 ProjectTree.treeRowClass 同尺寸同圆角：分层后 utility 生效，必须「新学旧」对齐项目行，
 * 不能再用 min-h-11/rounded-xl（会明显高于/圆于项目行）。 */
const sessionRowClass =
	"group/resource conversation agent-row relative flex min-h-8 w-full items-center gap-1.5 rounded-lg border border-transparent px-2 py-0 text-left text-body text-foreground shadow-none transition-[background-color,border-color,box-shadow] duration-base hover:border-border-subtle hover:bg-bg-hover hover:text-foreground focus-visible:bg-bg-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset";

/** 叶子选中态：灰底、无描边。比 hover（bg-hover，侧栏上 Δ6）再用 active 面深一档
 * （Δ12，≈ ZCode 选中墨量，见 docs/zcode-design-analysis.md）：选中感靠小步长，不靠深底。 */
const selectedRowClass = "active bg-bg-active text-foreground";

/** 行右侧「更多操作（三个点）」按钮：absolute 浮层，不参与布局（不挤压标题文字），
 * 默认隐藏（pointer-events 一并关闭防误触），行 hover / 行内聚焦时显现——
 * 与 WorktreeTree 的 workspace-tree-actions 同一套虚化模式。
 * 按钮浮层会盖住标题：conversation-body 上 group-hover/row:pr-7 在 hover 时压出
 * 28px 留白（一个按钮宽），标题截断让位但保持可见——所有宽度统一让位
 * （淡出到透明会让标题不可读，须点击激活才能看到，已弃用）。 */
const rowMoreActionsClass = "row-more-actions pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100";

// 操作按钮是 absolute 浮层，出现时所有宽度的标题都必须让出一个按钮位，
// 不能只依赖窄侧栏断点，否则中等宽度下 DSH 等尾部标记仍会被按钮覆盖。

/** 菜单打开期间保持点亮：菜单弹出后行 hover 会丢失（鼠标移向菜单），
 * 若不加此态按钮会瞬间熄灭，用户会误以为菜单与按钮无关。 */
function rowMoreMenuActiveClass(menuOpen: boolean) {
	return cn(rowMoreActionsClass, menuOpen && "pointer-events-auto opacity-100");
}

/** 会话/Agent 行容器：内容行占满 + 三个点按钮浮层（button 不能嵌 button，
 * 且浮层不占位——窄侧栏时标题文字不会被按钮挤窄）。
 * mt-0.5：行间距 2px，参考 dsh-web 会话列表的紧凑行距。 */
const rowContainerClass = "group/row relative mt-0.5 flex min-h-8 items-center";

function matchesSearch(value: string, search: string) {
	return !search || value.toLowerCase().includes(search.toLowerCase());
}

function formatCodexSubagentName(session: SessionSummary) {
	return [session.codexAgentNickname, session.codexAgentRole].filter(Boolean).join(" · ") || session.name || t("app.codexSubagent");
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
	const label = status === "idle" ? t("app.statusIdle") : status === "error" ? t("app.statusError") : status === "running" || status === "starting" || status === "pending" || status === "waiting" ? t("app.statusRunning") : undefined;
	return <span className={cn("size-1.5 shrink-0 rounded-full", dotClass, status === "error" ? "" : "animate-pulse")} aria-label={label} title={label} />;
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
	/** 无行可渲染时的空态（仅聊天分组传入）：空列表必须有可见反馈，不能静默 return null。 */
	emptyState?: ReactNode;
}) {
	const filter = props.controller.sourceFilterFor(props.project.id);
	const search = props.controller.search.trim();
	// 待确认 ask 以**会话**为粒度展示：同一项目下可能多个会话各自在等回答，
	// 只挂项目/标题栏徽章会分不清是哪一个会话（用户反馈）。
	const sessionRuntimeUiById = useAtomValue(sessionRuntimeUiByIdAtom);
	// 相对时间的基准：live 计时点（本轮开始/上一轮结束）优先，历史会话回落会话更新时间。
	const activityAt = useSessionActivityAt();
	const allSummaries = props.sessions.flatMap((session) => {
		const summary = sessionRecordToSummary(session);
		return summary ? [summary] : [];
	});
	const summaries = filterSidebarSessions(allSummaries, filter).filter((session) => matchesSearch(`${session.name ?? ""}${session.preview}${session.filePath}`, search));
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
		pinnedSessionIds: props.controller.pinnedSessionIds,
		sortMode: props.controller.sessionSortMode,
	});
	const displayedSessionIds = collectDisplayedSessionIds(display.visibleChildren, (agent) => {
		const linked = resolveBoundSession(agent, props.sessions, props.controller.catalog.runtimeBySessionId) ?? (agent.sessionPath ? summaries.find((session) => session.filePath === agent.sessionPath) : undefined);
		return linked?.id;
	});
	const draftSessions = props.sessions
		.filter((session) => session.status === "draft")
		.filter((session) => !displayedSessionIds.has(session.id))
		.filter((session) => matchesSearch(session.title, search))
		.filter((session) => filter === null || filter.has(session.source))
		.sort((left, right) => compareSessionsForSortMode(left, right, props.controller.sessionSortMode));
	const catalogLoading = props.controller.catalog.catalogLoadStateByProject[props.project.id]?.status === "loading";
	const canCollapseChildren = props.controller.hasExpandedChildren(props.project.id);
	/** 完整文案（含数字），用于 aria-label / title 的无障碍与悬停提示。 */
	const showMoreLabel = props.nested ? t("app.worktreeShowMoreSessions", { count: display.hiddenChildCount }) : t("app.projectShowMoreChildren", { count: display.hiddenChildCount });
	/** 按钮内可见文字：非嵌套文案是「查看更多 {count}」，数字在句尾，
	 *  拆出来单独右对齐（与上方会话行的时间列对齐）；嵌套文案数字在句中，
	 *  拆开会出现「还有 个会话…」这种断句，故整体渲染。 */
	const showMoreText = props.nested ? showMoreLabel : t("app.projectShowMoreChildren", { count: "" }).replace(/\s+$/, "");
	const collapseLabel = t("app.projectCollapseChildren");
	const hasRows = catalogLoading || draftSessions.length > 0 || display.visibleChildren.length > 0 || display.hiddenChildCount > 0;
	const [retainingExit, setRetainingExit] = useState(hasRows);
	useEffect(() => {
		if (hasRows) setRetainingExit(true);
	}, [hasRows]);
	// 最后一条也必须留到退场结束；空树在调用方未提供空态时仍不占 session-card 的空间。
	// 聊天分组提供 emptyState：展开且为空时显示「还没有聊天记录」，与「分组被折叠」区分开（#387）。
	if (!hasRows && !retainingExit) return props.emptyState ? <>{props.emptyState}</> : null;

	/** 单击走设置默认模式（App 层读 sessionTabOpenMode）；双击显式常驻。
	 *  不设本地默认值：undefined 透传后由 App 的 sessions.open 用设置值兜底 */
	const openSession = (sessionId: string, tabMode?: "preview" | "permanent") => {
		void props.actions.sessions.open(props.project.id, sessionId, tabMode);
	};

	const sessionDragProps = (sessionId: string) => ({
		draggable: true,
		onDragStart: (event: React.DragEvent) => {
			event.dataTransfer.effectAllowed = "move";
			event.dataTransfer.setData(SESSION_TAB_DRAG_MIME, sessionId);
			// 部分浏览器要求有 text/plain 才能跨区域 drop
			event.dataTransfer.setData("text/plain", sessionId);
			props.actions.sessions.beginDrag?.(sessionId);
		},
		onDragEnd: () => {
			props.actions.sessions.endDrag?.();
		},
	});

	const openContext = (event: React.MouseEvent, session: SessionSummary, pinnable = true) => {
		event.preventDefault();
		const runtime = getBoundSidebarRuntimeAgent(props.controller.catalog, session.id);
		void props.controller.openMenu(runtime ? { kind: "agent", agentId: runtime.id, pinnable, x: event.clientX, y: event.clientY } : { kind: "session", projectId: props.project.id, sessionId: session.id, pinnable, x: event.clientX, y: event.clientY });
	};
	const openDraftContext = (event: React.MouseEvent, session: SessionRecord) => {
		event.preventDefault();
		const runtimeAgent = getBoundSidebarRuntimeAgent(props.controller.catalog, session.id);
		if (runtimeAgent) {
			// 运行中也给删除：主进程会先停后删，不必先关 Agent。
			void props.controller.openMenu({
				kind: "agent",
				agentId: runtimeAgent.id,
				pinnable: false,
				x: event.clientX,
				y: event.clientY,
			});
			return;
		}
		void props.controller.openMenu({
			kind: "draft",
			projectId: props.project.id,
			sessionId: session.id,
			x: event.clientX,
			y: event.clientY,
		});
	};
	const renderSubagent = (session: SessionSummary, title: string, badge?: ReactNode) => {
		return (
			<div key={session.id} className={rowContainerClass} onContextMenu={(event) => openContext(event, session, false)}>
				<SessionHoverCard session={session} title={title} projectName={props.project.name} disabled={Boolean(props.controller.menu)}>
					<button
						type="button"
						className={cn(sessionRowClass, "session-row codex-subagent-sidebar-row pl-2", session.id === props.currentSessionId && selectedRowClass)}
						onClick={() => openSession(session.id)}
						onDoubleClick={props.actions.sessions.simpleNavigation ? undefined : () => openSession(session.id, "permanent")}
						{...sessionDragProps(session.id)}
					>
						<div className="conversation-body min-w-0 flex-1 transition-[padding-right] group-hover/row:pr-7 group-focus-within/row:pr-7">
							<div className="conversation-title flex min-w-0 items-center gap-1.5">
								{/* 来源/后端标放标题左侧（与顶部 Tab 一致，用户反馈原先在标题右侧）。 */}
								{badge}
								<TitleScrollText text={title} />
							</div>
						</div>
					</button>
				</SessionHoverCard>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					className={rowMoreMenuActiveClass(props.controller.menu?.kind === "session" && props.controller.menu.sessionId === session.id)}
					aria-label={t("sidebar.moreActions")}
					title={t("sidebar.moreActions")}
					onClick={(event) => {
						event.stopPropagation();
						openContext(event, session, false);
					}}
				>
					<Ellipsis size={14} aria-hidden="true" />
				</Button>
			</div>
		);
	};
	const renderSubagents = (parentKey: string, codex: SessionSummary[], pi: SessionSummary[]) => {
		if (codex.length + pi.length === 0 || !props.controller.expandedSubagentGroups.has(parentKey)) return null;
		// 主侧栏子会话组缩进走 tailwind utility（ml-3），避免 legacy 层 v3-braun 规则覆盖；
		// worktree（nested）子树保留其自身布局规则
		return (
			<div className={cn("codex-subagent-sidebar-group", !props.nested && "ml-3")}>
				{codex.map((session) => renderSubagent(session, formatCodexSubagentName(session), <SessionSourceBadge source="codex" label={t("app.codexSubagent")} />))}
				{pi.map((session) => renderSubagent(session, formatPiSubagentName(session)))}
			</div>
		);
	};
	/** 子会话折叠胶囊：紧贴右侧邻居左缘，自身不预留空白——留白归属由「谁在它右边」决定：
	 *  - 历史会话行后面跟着相对时间戳 → margin 0，胶囊贴住时间戳（用户要求把标签右移，别再空 28px）；
	 *  - 运行中 Agent 行没有时间戳，胶囊是行内最后一个元素 → `last:mr-7` 自己预留 28px（= size-6
	 *    「⋯」按钮 + right-1），否则 hover 让位 padding 长出前的 150ms 里它会正压在「⋯」上。
	 *   实例代价：两种行非 hover 态的胶囊右缘相差 18px（会话行多让出时间戳宽度 + 间距），
	 *   但落点都由本行右侧邻居决定，视觉上一致。 */
	const renderToggle = (key: string, count: number) =>
		count > 0 ? (
			<span
				className="subagent-inline-toggle px-1 py-0.5 last:mr-7"
				title={t("app.piSubagentCount", { count })}
				onClick={(event) => {
					event.stopPropagation();
					props.controller.toggleSubagentGroup(key);
				}}
			>
				<ChevronDown size={8} className={props.controller.expandedSubagentGroups.has(key) ? "expanded" : ""} />
				{/* 子 Agent 数量：统一 pill 样式（与项目行会话数徽标同尺寸同圆角），紧凑档 */}
				<span className="subagent-inline-count inline-flex h-3.5 shrink-0 items-center rounded-full px-1 text-micro font-medium tabular-nums">{count}</span>
			</span>
		) : null;

	// main 语义：项目下直接展示统一列表（drafts + 会话/Agent 按时间混排），不分组标题；
	// Tab 栏同款状态点跟随具体 Agent/历史会话行；没有 runtime 的纯历史记录保持无点。
	const renderChild = (child: ProjectChildItem) => {
		const groupKey = `${props.project.id}:${child.key}`;
		const childCount = child.codexSubagents.length + child.piSubagents.length;
		if (child.type === "agent") {
			const agentSession = resolveBoundSession(child.agent, props.sessions, props.controller.catalog.runtimeBySessionId) ?? (child.agent.sessionPath ? summaries.find((session) => session.filePath === child.agent.sessionPath) : undefined);
			// Catalog owns the display title. AgentTab.title may reflect a transient pi/TUI
			// session_info event, so only use it for an unbound runtime with no record.
			const displayTitle = (agentSession ? ("title" in agentSession ? agentSession.title : agentSession.name || child.agent.title) : child.agent.title) || t("common.untitled");
			return (
				<SidebarRemovalRow key={child.key} itemId={agentSession?.id ?? child.agent.id}>
					{/* 运行中 Agent 行：标题常被 truncate（如 "JZSSC40..."），悬浮展示完整标题 */}
					<div
						className={rowContainerClass}
						onContextMenu={(event) => {
							event.preventDefault();
							void props.controller.openMenu({ kind: "agent", agentId: child.agent.id, x: event.clientX, y: event.clientY });
						}}
					>
						<SessionHoverCard session={agentSession} title={displayTitle} projectName={props.project.name} status={child.agent.status} disabled={Boolean(props.controller.menu)}>
							<button
								type="button"
								className={cn(sessionRowClass, agentSession?.id === props.currentSessionId && selectedRowClass)}
								onClick={() => {
									if (agentSession) openSession(agentSession.id);
								}}
								onDoubleClick={
									props.actions.sessions.simpleNavigation
										? undefined
										: () => {
												if (agentSession) openSession(agentSession.id, "permanent");
											}
								}
								{...(agentSession ? sessionDragProps(agentSession.id) : {})}
							>
								{props.actions.sessions.simpleNavigation ? <SessionActivityIndicator status={child.agent.status} sessionId={agentSession?.id} /> : renderRuntimeStatusDot(child.agent.status)}
								<div className="conversation-body min-w-0 flex-1 transition-[padding-right] group-hover/row:pr-7 group-focus-within/row:pr-7">
									<div className="conversation-title flex min-w-0 items-center gap-1.5">
										{/* 后端身份标放标题左侧（与顶部 Tab 一致）。 */}
										{child.agent.backend === "acp" ? <AcpBackendMark acpToolId={agentSession?.acpToolId} /> : <SessionBackendMark backend={child.agent.backend} />}
										{/* 运行中 Agent 行：标题常被 truncate（如 "JZSSC40..."），悬浮展示完整标题；
                    选中背景仍保留，聚焦行也允许 hover 查看完整标题。 */}
										<TitleScrollText text={displayTitle} className="font-medium" />
										{/* 待确认 ask：运行中 Agent 行同样按会话粒度标记，避免多会话同时等待时分不清。 */}
										{hasPendingAskForSession(agentSession?.id, sessionRuntimeUiById) && <PendingAskBadge count={1} />}
										{agentSession?.sideTask && <SideTaskMark />}
										{child.agent.noSession && (
											<span className="anonymous-indicator" title={t("app.anonymousChat")}>
												<HatGlasses size={11} aria-hidden="true" />
											</span>
										)}
										{renderToggle(groupKey, childCount)}
									</div>
								</div>
							</button>
						</SessionHoverCard>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							className={rowMoreMenuActiveClass(props.controller.menu?.kind === "agent" && props.controller.menu.agentId === child.agent.id)}
							aria-label={t("sidebar.moreActions")}
							title={t("sidebar.moreActions")}
							onClick={(event) => {
								event.stopPropagation();
								const rect = event.currentTarget.getBoundingClientRect();
								void props.controller.openMenu({ kind: "agent", agentId: child.agent.id, x: rect.right, y: rect.bottom });
							}}
						>
							<Ellipsis size={14} aria-hidden="true" />
						</Button>
					</div>
					{renderSubagents(groupKey, child.codexSubagents, child.piSubagents)}
				</SidebarRemovalRow>
			);
		}
		const runtime = getBoundSidebarRuntimeAgent(props.controller.catalog, child.session.id);
		const runtimeSnapshot = props.controller.catalog.runtimeBySessionId[child.session.id];
		const pinned = props.controller.isSessionPinned(child.session.id);
		return (
			<SidebarRemovalRow key={child.session.id} itemId={child.session.id}>
				<div className={rowContainerClass} onContextMenu={(event) => openContext(event, child.session)}>
					<SessionHoverCard session={child.session} title={child.session.name} projectName={props.project.name} status={runtimeSnapshot?.status} disabled={Boolean(props.controller.menu)}>
						<button
							type="button"
							className={cn(
								sessionRowClass,
								// 历史会话不是运行中的 Agent：只给这一类内容增加层级缩进，避免项目标题与历史记录贴在同一列。
								// 历史会话需要比运行中 Agent 更松的点击区域和行间距，避免连续记录挤成一块。
								"session-row history-session-row mx-0 min-h-8 pl-2 pr-2 py-0",
								child.session.id === props.currentSessionId && selectedRowClass,
							)}
							onClick={() => openSession(child.session.id)}
							onDoubleClick={props.actions.sessions.simpleNavigation ? undefined : () => openSession(child.session.id, "permanent")}
							{...sessionDragProps(child.session.id)}
						>
							{props.actions.sessions.simpleNavigation ? <SessionActivityIndicator status={runtimeSnapshot?.status} sessionId={child.session.id} /> : renderRuntimeStatusDot(runtimeSnapshot?.status)}
							{pinned && <Pin className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />}
							<div className="conversation-body min-w-0 flex-1 transition-[padding-right] group-hover/row:pr-7 group-focus-within/row:pr-7">
								<div className="conversation-title flex min-w-0 items-center gap-1.5">
									{/* 后端/来源身份标放标题左侧（与顶部 Tab 一致，用户反馈原先在标题右侧）：
                      ACP 用工具品牌图标、DSH/生图用后端标、其余来源用来源徽标。 */}
									{child.session.backend === "acp" ? <AcpBackendMark acpToolId={child.session.acpToolId} /> : (child.session.backend === "dsh" || child.session.backend === "imagegen") && <SessionBackendMark backend={child.session.backend} />}
									{child.session.source && child.session.source !== "pi" && <SessionSourceBadge source={child.session.source} />}
									{/* 历史会话（无运行态）文字降一级，与活跃 Agent/运行中会话形成层级差；
                  标题被截断时 hover 滚动展示全文（TitleScrollText，未溢出则静止）；
                  选中背景仍保留，聚焦行也允许 hover 查看完整标题。 */}
									<TitleScrollText text={child.session.name || t("common.untitled")} className={cn(runtime ? "font-medium" : "font-normal text-muted-foreground/90")} />
									{/* 待确认 ask：挂在会话行本身，用户一眼看出是哪个会话在等回答
                  （项目/标题栏徽章只给汇总数，多会话同时等待时分不清）。
                  与 ActiveSessionsTree、项目行共用 PendingAskBadge，语义与视觉一致。 */}
									{hasPendingAskForSession(child.session.id, sessionRuntimeUiById) && <PendingAskBadge count={1} />}
									{/* 生图角标：imagegen 后端会话的徽标已含生图标识，此处仅对遗留 pi 后端含生图消息的会话补图标 */}
									{child.session.backend !== "imagegen" && child.session.hasImageGen && <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
									{child.session.channel && <SessionChannelMark channel={child.session.channel} />}
									{child.session.sideTask && <SideTaskMark />}
									{renderToggle(groupKey, childCount)}
									{/* 相对时间常显：多久前用过一目了然；hover 行时让位给右侧「⋯」按钮。
                  基准是「计时点」而不是文件 mtime（见 hooks/sidebar/useSessionActivityClock）：
                  本轮开始（用户输入）与 turn 结束各算一次，流式期间不会一直被重置成「刚刚」。
                  窄侧栏时间可能被截断，title 提示完整相对时间。
                  hover 用「宽度收拢」而不是 display:none：时间瞬时消失会让左侧胶囊一步跳到行尾
                  （那一刻正好压在「⋯」上，150ms 后才被 padding 带回左边），改成与 padding 同步
                  （同为 150ms 默认时长）收拢后胶囊是缓慢滑过去，任何一帧都不会越过「⋯」左缘。
                  w-max 保证非 hover 态宽度与 auto 完全一致（不写魔法宽度，「3天」这类文案不会被截）；
                  interpolate-size 让 max-content→0 可插值（Electron 43 / Chromium 142 支持）。
                  不支持该属性的旧浏览器退化为瞬时收拢，胶囊在该帧会短暂压到「⋯」左缘——仅降级路径，
                  比时间直接 display:none 时「整颗胶囊跳到行尾」轻得多，故不额外加延迟。 */}
									<span
										className="w-max shrink-0 overflow-hidden whitespace-nowrap text-micro tabular-nums text-muted-foreground transition-[width,opacity] [interpolate-size:allow-keywords] group-hover/row:w-0 group-hover/row:opacity-0 group-focus-within/row:w-0 group-focus-within/row:opacity-0"
										title={formatRelativeTime(activityAt(child.session.id, child.session.updatedAt))}
									>
										{formatRelativeTime(activityAt(child.session.id, child.session.updatedAt))}
									</span>
								</div>
							</div>
						</button>
					</SessionHoverCard>
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						className={rowMoreMenuActiveClass(props.controller.menu?.kind === "session" && props.controller.menu.sessionId === child.session.id)}
						aria-label={t("sidebar.moreActions")}
						title={t("sidebar.moreActions")}
						onClick={(event) => {
							event.stopPropagation();
							openContext(event, child.session);
						}}
					>
						<Ellipsis size={14} aria-hidden="true" />
					</Button>
				</div>
				{renderSubagents(groupKey, child.codexSubagents, child.piSubagents)}
			</SidebarRemovalRow>
		);
	};

	return (
		<div className={cn(props.nested ? "worktree-children m-0 border-0 bg-transparent p-0" : "session-card", "flex flex-col gap-0")}>
			<SidebarRemovalList
				remainingIds={[...props.sessions.map((session) => session.id), ...projectAgents.map((agent) => agent.id)]}
				onExitComplete={() => {
					if (!hasRows) setRetainingExit(false);
				}}
			>
				{draftSessions.map((session) => {
					const runtime = props.controller.catalog.runtimeBySessionId[session.id];
					return (
						<SidebarRemovalRow key={`draft:${session.id}`} itemId={session.id}>
							<div className={cn("draft-session-row group/draft grid items-center gap-1", "grid-cols-[minmax(0,1fr)_2rem]")} onContextMenu={(event) => openDraftContext(event, session)}>
								<SessionHoverCard session={session} title={session.title} projectName={props.project.name} status={runtime?.status} disabled={Boolean(props.controller.menu)}>
									<button
										type="button"
										className={cn(sessionRowClass, "session-row draft-session-trigger", session.id === props.currentSessionId && selectedRowClass)}
										onClick={() => openSession(session.id)}
										onDoubleClick={props.actions.sessions.simpleNavigation ? undefined : () => openSession(session.id, "permanent")}
										{...sessionDragProps(session.id)}
									>
										<div className="conversation-body min-w-0 flex-1 transition-[padding-right] group-hover/row:pr-7 group-focus-within/row:pr-7">
											<div className="conversation-title flex min-w-0 items-center gap-1.5">
												{props.actions.sessions.simpleNavigation ? <SessionActivityIndicator status={runtime?.status} sessionId={session.id} /> : renderRuntimeStatusDot(runtime?.status)}
												{/* 后端身份标放标题左侧（与顶部 Tab 一致）。 */}
												{session.backend === "acp" ? <AcpBackendMark acpToolId={session.acpToolId} /> : <SessionBackendMark backend={session.backend} />}
												{/* 草稿会话：选中背景仍保留，聚焦行也允许 hover 查看完整标题 */}
												<TitleScrollText text={session.title || t("common.untitled")} className="font-medium" />
												{/* 草稿会话同样按会话粒度标记待确认 ask。 */}
												{hasPendingAskForSession(session.id, sessionRuntimeUiById) && <PendingAskBadge count={1} />}
												{/* 侧边任务的草稿期也要认得出来：面板与左栏是同一会话，标记缺失会让人以为建了两条 */}
												{session.sideTask && <SideTaskMark />}
											</div>
										</div>
									</button>
								</SessionHoverCard>
								<Button variant="ghost" size="icon" className="draft-session-delete" aria-label={t("common.delete")} title={t("common.delete")} onClick={() => void props.actions.sessions.deleteDraft(session)}>
									<Trash2 size={14} aria-hidden="true" />
								</Button>
							</div>
						</SidebarRemovalRow>
					);
				})}
				{catalogLoading && (
					<div key="catalog-loading" className="project-session-loading">
						<div className="loader animate-pideck-spin" />
						<span>{t("app.projectSessionsLoading")}</span>
					</div>
				)}
				{display.visibleChildren.map(renderChild)}
			</SidebarRemovalList>

			{(display.hiddenChildCount > 0 || canCollapseChildren) && (
				<div className="flex min-w-0 items-center gap-1">
					{display.hiddenChildCount > 0 && (
						<Button
							variant="ghost"
							size="sm"
							className={`session-more-btn h-auto min-w-0 w-auto flex-1 justify-start px-2 text-micro opacity-80 transition-opacity hover:opacity-100 ${props.nested ? "worktree-sessions-more" : "session-more-row"}`}
							aria-label={showMoreLabel}
							title={showMoreLabel}
							onClick={props.onShowMore ?? (() => props.controller.showMoreChildren(props.project.id))}
						>
							<ChevronDown size={12} aria-hidden="true" />
							<span className="truncate">{showMoreText}</span>
							{/* 数字与上方会话行的相对时间同列右对齐（嵌套文案数字在句中，不拆）。 */}
							{!props.nested && <span className="ml-auto shrink-0 pl-1.5 tabular-nums">{display.hiddenChildCount}</span>}
						</Button>
					)}
					{canCollapseChildren && (
						/* 只要用户展开过，就和「查看更多」并列保留收起入口；不用等所有子项都加载完。 */
						<Button
							variant="ghost"
							size="sm"
							className={`h-auto shrink-0 w-auto justify-start px-2 text-micro opacity-80 transition-opacity hover:opacity-100 ${props.nested ? "worktree-sessions-more" : "session-more-row"}`}
							aria-label={collapseLabel}
							title={collapseLabel}
							onClick={() => props.controller.collapseChildren(props.project.id)}
						>
							<ChevronUp size={12} aria-hidden="true" />
							<span>{collapseLabel}</span>
						</Button>
					)}
				</div>
			)}
		</div>
	);
}
