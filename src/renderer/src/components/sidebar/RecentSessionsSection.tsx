import { ChevronDown, ChevronUp, Ellipsis } from "lucide-react";
import { useAtomValue } from "jotai";
import { sessionRecordToSummary } from "../../atoms/session-selectors";
import { sessionRuntimeUiByIdAtom } from "../../atoms/session-atoms";
import { hasPendingAskForSession } from "../../utils/askUi";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import type { SidebarController } from "../../hooks/useSidebarController";
import type { SidebarActions } from "./SidebarContent";
import { Button } from "../ui-shadcn/button";
import { PendingAskBadge } from "./PendingAskBadge";
import { SessionBackendMark, SessionSourceBadge } from "../session/SessionSourceBadge";
import { SessionHoverCard } from "./SessionHoverCard";
import { TitleScrollText } from "./TitleScrollText";
import { SESSION_TAB_DRAG_MIME } from "../../utils/sessionSplitEdge";
import { formatRelativeTime } from "../../utils/relativeTime";
import { RECENT_SESSIONS_INITIAL_VISIBLE, canCollapseRecent } from "./activitySessionsModel";
import type { RecentSessionRow } from "./activitySessionsModel";

/**
 * 活动页下半部分：「最近会话」区。
 *
 * 为什么需要它：上半部分的活动行只覆盖 runtime 绑定的 Agent，应用重启后（或 Agent
 * 结束/会话关闭后）活动区会变空，用户刚才用过的会话就找不到入口了。这里从会话
 * catalog 里取「最近更新」的历史会话补位，默认只放 10 条，再手动「加载更多」——
 * 一次性渲染几百行历史会让侧栏卡顿（用户明确要求注意性能）。
 *
 * 行观感与 chats 分段的历史会话行（`SessionTree` 的 history-session-row）严格一致：
 * 同一段列表里两种样式会让用户以为「最近」是另一类数据。
 */

/** 与 `SessionTree.sessionRowClass` 逐字一致（history-session-row 的历史样式基座）。
 *  `tests/sidebarActivityRecent.test.mjs` 有逐字一致性断言：改这里必须同步 SessionTree。 */
const recentRowClass =
	"group/resource conversation agent-row relative flex min-h-8 w-full items-center gap-1.5 rounded-lg border border-transparent px-2 py-0 text-left text-body text-foreground shadow-none transition-[background-color,border-color,box-shadow] duration-200 hover:border-border-subtle hover:bg-muted/60 hover:text-foreground focus-visible:bg-muted/70 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset";

/** 与 `SessionTree.selectedRowClass` 逐字一致：选中底用 active 面，不用描边。 */
const selectedRowClass = "active bg-bg-active text-foreground";

/** 与 `SessionTree.rowMoreActionsClass` 逐字一致：absolute 浮层，不挤压标题。 */
const rowMoreActionsClass = "row-more-actions pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100";

/**
 * 分页行基座：与项目页「查看更多 / 收起」（SessionTree 的 session-more-btn 组合）
 * 逐字一致，保证两处同一个功能的行高、内边距、字号完全相同（`tests/sidebarActivityRecent.test.mjs`
 * 有逐字一致性断言：改这里必须同步 SessionTree）。
 * 另带 `session-more-row`：legacy 层负责 margin/字色/背景，utility 负责高度与布局。
 */
const moreRowClass = "session-more-btn session-more-row h-auto min-w-0 w-auto flex-1 justify-start px-2 text-micro opacity-80 transition-opacity hover:opacity-100";

/** 与项目页同款的「收起」按钮：`shrink-0`（不参与 1fr 分配，与左侧按钮并排）。 */
const collapseRowClass = "session-more-row h-auto shrink-0 w-auto justify-start px-2 text-micro opacity-80 transition-opacity hover:opacity-100";

/**
 * 最近会话区：分界线 + 段落标题（含 x/y 计数）+ 行 + 手动「加载更多」/「收起」。
 *
 * 全量条数与可见条数由外部传入：段落只负责渲染，条数状态归活动页 owner（ActiveSessionsTree），
 * 避免同一份「显示多少条」在两处各存一份。
 */
export function RecentSessionsSection(props: { controller: SidebarController; actions: SidebarActions; currentSessionId?: string; rows: readonly RecentSessionRow[]; totalCount: number; visibleCount: number; onLoadMore: () => void; onCollapse: () => void }) {
	// 待确认标记按本行 sessionId 判定（与活动行同一策略，不订阅项目级聚合值）。
	const sessionRuntimeUiById = useAtomValue(sessionRuntimeUiByIdAtom);
	// 没有历史会话时整段消失：标题与分界线一起收起，活动页保持现状（不为空列表留一条悬空分界线）。
	if (props.rows.length === 0) return null;
	// 剩余未展示条数：按钮标题用「再加载 N 个会话」，按钮右侧数字沿用项目行的右对齐计数列。
	const remainingCount = Math.max(0, props.totalCount - props.visibleCount);
	// 收起：只有展开过（超过首页 10 条）才出现，与项目页「查看更多 / 收起」并列的语义一致。
	const canCollapse = canCollapseRecent(props.visibleCount);
	const projectNamesById = new Map(props.controller.catalog.projects.map((project) => [project.id, project.name]));
	return (
		<section aria-label={t("app.sidebarRecentSessions")} className="mt-1 flex flex-col gap-0">
			{/* 分界线：上方活动行、下方最近会话，用户要求两段之间有明确界限。
			    sticky：下半区自己滚时标题不离场（粘在半个面板顶部），底部给半透明底避免行从字下穿过。 */}
			<div className="sticky top-0 z-10 flex items-center gap-2 border-t border-border/40 bg-sidebar px-1 pt-1 pb-0.5">
				{/* 加粗：与项目页分组标题（ProjectTree 的「项目 / 聊天」）同一档，一眼看出这是分段而不是一行会话。 */}
				<span className="text-caption font-semibold text-muted-foreground">{t("app.sidebarRecentSessions")}</span>
				<span className="ml-auto shrink-0 text-caption tabular-nums text-muted-foreground" title={t("app.sidebarRecentShown", { shown: props.visibleCount, total: props.totalCount })}>
					{props.visibleCount}/{props.totalCount}
				</span>
			</div>
			{props.rows.map((row) => (
				<RecentSessionRowItem key={row.session.id} row={row} projectName={projectNamesById.get(row.projectId)} controller={props.controller} actions={props.actions} currentSessionId={props.currentSessionId} sessionRuntimeUiById={sessionRuntimeUiById} />
			))}
			{/* 分页条：常驻在本区下缘（不跟随列表滚到底，用户要求「挂在下侧」）。
			    sticky bottom-0：仍在内容流里（保留自身行位，最后一行不会被盖住），
			    内容高过本区时自动粘在下缘。观感与项目页「查看更多 / 收起」完全一致——
			    不加卡片框/描边/阴影，只垫一层侧栏底色避免行文字从按钮下方穿过。 */}
			{(remainingCount > 0 || canCollapse) && (
				<div className="sticky bottom-0 z-20 flex min-w-0 items-center gap-1 bg-sidebar">
					{remainingCount > 0 && (
						<Button type="button" variant="ghost" size="sm" className={moreRowClass} aria-label={t("app.sidebarRecentLoadMore")} title={t("app.sidebarRecentLoadMoreHint", { count: remainingCount })} onClick={props.onLoadMore}>
							<ChevronDown size={12} aria-hidden="true" />
							<span className="truncate">{t("app.sidebarRecentLoadMore")}</span>
							<span className="ml-auto shrink-0 pl-1.5 tabular-nums">{remainingCount}</span>
						</Button>
					)}
					{canCollapse && (
						<Button type="button" variant="ghost" size="sm" className={collapseRowClass} aria-label={t("app.sidebarRecentCollapse")} title={t("app.sidebarRecentCollapseHint", { count: RECENT_SESSIONS_INITIAL_VISIBLE })} onClick={props.onCollapse}>
							<ChevronUp size={12} aria-hidden="true" />
							<span>{t("app.sidebarRecentCollapse")}</span>
						</Button>
					)}
				</div>
			)}
		</section>
	);
}

/** 单条最近会话行：点击打开（preview/permanent）、右键会话菜单、可拖拽分屏。 */
function RecentSessionRowItem(props: { row: RecentSessionRow; projectName?: string; controller: SidebarController; actions: SidebarActions; currentSessionId?: string; sessionRuntimeUiById: Parameters<typeof hasPendingAskForSession>[1] }) {
	const { row, controller } = props;
	// 模型已按「可显示」判据过滤，这里只做类型收窄：无摘要身份的记录渲染出来会是空标题行。
	const summary = sessionRecordToSummary(row.session);
	if (!summary) return null;
	const sessionId = row.session.id;
	const pendingAsk = hasPendingAskForSession(sessionId, props.sessionRuntimeUiById);
	const selected = sessionId === props.currentSessionId;
	const displayTitle = summary.name || row.session.title || t("common.untitled");
	// 单击默认 preview、双击显式常驻：与活动行/历史行同一入口语义。
	const openSession = (tabMode?: "preview" | "permanent") => {
		void props.actions.sessions.open(row.projectId, sessionId, tabMode);
	};
	const openMenu = (x: number, y: number) => {
		void controller.openMenu({ kind: "session", projectId: row.projectId, sessionId, pinnable: true, x, y });
	};
	return (
		<div
			className="group/row relative mt-0.5 flex min-h-8 items-center"
			onContextMenu={(event) => {
				event.preventDefault();
				openMenu(event.clientX, event.clientY);
			}}
		>
			<SessionHoverCard session={row.session} title={displayTitle} projectName={props.projectName} disabled={Boolean(controller.menu)}>
				<button
					type="button"
					className={cn(recentRowClass, "session-row history-session-row mx-0 min-h-8 pl-2 pr-2 py-0", selected && selectedRowClass)}
					onClick={() => openSession()}
					onDoubleClick={() => openSession("permanent")}
					draggable
					onDragStart={(event) => {
						event.dataTransfer.effectAllowed = "move";
						event.dataTransfer.setData(SESSION_TAB_DRAG_MIME, sessionId);
						// 部分浏览器要求有 text/plain 才能跨区域 drop
						event.dataTransfer.setData("text/plain", sessionId);
						props.actions.sessions.beginDrag?.(sessionId);
					}}
					onDragEnd={() => props.actions.sessions.endDrag?.()}
				>
					<div className="conversation-body min-w-0 flex-1 transition-[padding-right] group-hover/row:pr-7 group-focus-within/row:pr-7">
						<div className="conversation-title flex min-w-0 items-center gap-1.5">
							{/* 历史会话没有运行态：标题降一级灰度，与上方活动行形成层级差；
                  项目归属由 hover 卡的「所属空间」承担，行内不重复显示项目名（与活动行同样式）。 */}
							<TitleScrollText text={displayTitle} className="font-normal text-muted-foreground/90" />
							{(row.session.backend === "dsh" || row.session.backend === "imagegen") && <SessionBackendMark backend={row.session.backend} />}
							{pendingAsk && <PendingAskBadge count={1} />}
							{row.session.source && row.session.source !== "pi" && <SessionSourceBadge source={row.session.source} />}
							{/* 相对时间常显，hover 行时让位给右侧「⋯」按钮（与上方活动行一致）。 */}
							<span className="shrink-0 text-caption tabular-nums text-muted-foreground group-hover/row:hidden group-focus-within/row:hidden" title={formatRelativeTime(row.sortAt)}>
								{formatRelativeTime(row.sortAt)}
							</span>
						</div>
					</div>
				</button>
			</SessionHoverCard>
			<Button
				type="button"
				variant="ghost"
				size="icon-xs"
				className={cn(rowMoreActionsClass, controller.menu?.kind === "session" && controller.menu.sessionId === sessionId && "pointer-events-auto opacity-100")}
				aria-label={t("sidebar.moreActions")}
				title={t("sidebar.moreActions")}
				onClick={(event) => {
					event.stopPropagation();
					const rect = event.currentTarget.getBoundingClientRect();
					openMenu(rect.right, rect.bottom);
				}}
			>
				<Ellipsis size={14} aria-hidden="true" />
			</Button>
		</div>
	);
}
