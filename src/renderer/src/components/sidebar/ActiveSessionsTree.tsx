import { Ellipsis } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { sessionStatusDotClass } from "../../agentListDisplay";
import { sessionRecordToSummary } from "../../atoms";
import { sessionRuntimeUiByIdAtom } from "../../atoms/session-atoms";
import { hasPendingAskForSession } from "../../utils/askUi";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import type { SidebarController } from "../../hooks/useSidebarController";
import type { SidebarActions } from "./SidebarContent";
import { Button } from "../ui-shadcn/button";
import { PendingAskBadge } from "./PendingAskBadge";
import { SessionBackendMark } from "../session/SessionSourceBadge";
import { SessionHoverCard } from "./SessionHoverCard";
import { TitleScrollText } from "./TitleScrollText";
import { SESSION_TAB_DRAG_MIME } from "../../utils/sessionSplitEdge";
import { formatRelativeTime } from "../../utils/relativeTime";
import { RECENT_SESSIONS_INITIAL_VISIBLE, collectActiveSessionRows, collectRecentSessionRows, growRecentVisible } from "./activitySessionsModel";
import { RecentSessionsSection } from "./RecentSessionsSection";

/** 活动页行样式：与 SessionTree 会话行同尺寸同圆角，但选中底不需要（活动页行不持久）。 */
const activeRowClass =
	"group/resource conversation agent-row relative flex min-h-8 w-full items-center gap-1.5 rounded-lg border border-transparent px-2 py-0 text-left text-body text-foreground shadow-none transition-[background-color,border-color,box-shadow] duration-200 hover:border-border-subtle hover:bg-muted/60 hover:text-foreground focus-visible:bg-muted/70 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset";

/** 右侧「更多操作」按钮：与 SessionTree 同一套 absolute 浮层虚化模式，
 *  行 hover 出现，菜单打开期间保持点亮。 */
const rowMoreActionsClass = "row-more-actions pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100";

/**
 * 活动 Agent 会话页：跨项目收集所有已绑定 runtime 的 Agent（live + 终态），按会话更新时间排序。
 * 活动行身份与 SessionTree 的 agent 行一致（状态点 + 标题 + 后端标记 + 相对时间），
 * 点击打开绑定会话（单击 preview / 双击 permanent），右键打开 Agent 菜单，支持拖拽分屏。
 * 这是「runtime 会话」的实时入口：live 状态（starting/idle/running）是进程仍在，
 * error/closed 是运行失败或已停止但 Tab 未关——保留它们才能从活动页直接重启/重载失败会话，
 * 而不是让失败会话在活动页消失、只能去 chats 历史页翻。
 *
 * 布局：上下两个独立滚动区（上半活动行 / 下半「最近会话」）——用户要求最近会话固定
 * 在侧栏面板下半部分。活动行可能很多，若共用一个滚动容器，要一路滚到底才能看到
 * 最近会话；反过来「加载更多」也会把活动行顶出视野。两半各占 1fr、各自滚动。
 */
export function ActiveSessionsTree(props: { controller: SidebarController; actions: SidebarActions; currentSessionId?: string }) {
	const { controller } = props;
	// 活动页以会话为粒度，待确认标记直接按本行 sessionId 判定，
	// 避免订阅项目级聚合值导致一个会话的 ask 点亮整页。
	const sessionRuntimeUiById = useAtomValue(sessionRuntimeUiByIdAtom);
	// 活动行：跨项目收集所有已绑定 runtime 的 Agent（live + 终态）。
	// catalog 只含 runtime 绑定（detached 已被 agentInventoryAtom 排除），
	// 因此不再按 isLiveRuntimeStatus 过滤——否则 error/closed 的失败会话会从活动页消失。
	// 收集与排序规则在 activitySessionsModel（纯函数可单测），catalog 引用稳定时 memo 复用结果。
	const liveRows = useMemo(() => collectActiveSessionRows(controller.catalog), [controller.catalog]);
	// 「最近会话」可见条数：默认 10 条，手动「加载更多」每次 +10；「收起」回到首页大小。
	// 行数受控是性能要求——侧栏一次性渲染几百行历史会明显卡顿（用户反馈）。
	const [recentVisibleCount, setRecentVisibleCount] = useState(RECENT_SESSIONS_INITIAL_VISIBLE);
	const recent = useMemo(() => collectRecentSessionRows({ catalog: controller.catalog, activeRows: liveRows, visibleCount: recentVisibleCount }), [controller.catalog, liveRows, recentVisibleCount]);
	// 「最近」是跨项目数据，而项目 catalog 只在展开/选中该项目时才扫描。
	// 活动页挂载时把尚未扫描的项目排进按需扫描（主进程立即返回目录缓存、后台扫描去重+冷却，
	// 见 BackgroundScanCoordinator），否则重启后活动区与最近区会同时为空——
	// 这正是用户要求补「最近」的起因。已在 loading/ready 的项目在 App 侧直接跳过，
	// 且以静默方式预热（不挂 loading 态、不装看门狗），避免侧栏一堆项目同时转圈。
	const projectIds = useMemo(() => controller.catalog.projects.map((project) => project.id), [controller.catalog.projects]);
	const ensureCatalogsLoaded = props.actions.sessions.ensureCatalogsLoaded;
	// 每个项目只请求一次：动作引用可能随 App 每次渲染变化，若不记住已请求的项目，
	// 失败/空结果项目会被反复重试，形成扫描请求风暴。重试交给项目刷新入口或重进活动页。
	const requestedProjectIdsRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		const pending = projectIds.filter((projectId) => !requestedProjectIdsRef.current.has(projectId));
		if (pending.length === 0) return;
		for (const projectId of pending) requestedProjectIdsRef.current.add(projectId);
		ensureCatalogsLoaded(pending);
	}, [ensureCatalogsLoaded, projectIds]);

	const hasRecent = recent.rows.length > 0;

	// 两段都空才是真正的空态；只有活动区空时用一行提示顶替，
	// 不能让 h-full 空态占满高度把下方「最近」挤出视野。
	if (liveRows.length === 0 && !hasRecent) {
		return (
			<div className="active-sessions-empty flex h-full min-h-0 flex-col items-center justify-center gap-2 px-4 py-8 text-center">
				<div className="text-caption text-muted-foreground">{t("app.sidebarActiveEmpty")}</div>
			</div>
		);
	}

	return (
		/* h-full：两半必须在侧栏可视高度内分配，否则下半个滚动区会被内容顶出屏幕。 */
		<div className="active-sessions-pane flex h-full min-h-0 flex-col">
			{/* 上半：活动行。行数多时只滚这里，「最近会话」不会被挤下去。 */}
			<div className="active-sessions-list flex min-h-0 flex-1 flex-col gap-0 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]">
				{liveRows.length === 0 ? <div className="px-2 py-1.5 text-caption text-muted-foreground">{t("app.sidebarActiveEmpty")}</div> : null}
				{liveRows.map(({ agent, projectId, record, sortAt }) => {
					const sessionId = record?.id;
					const selected = sessionId === props.currentSessionId;
					const summary = record ? sessionRecordToSummary(record) : undefined;
					const displayTitle = summary?.name || agent.title;
					const project = controller.catalog.projects.find((p) => p.id === projectId);
					const pendingAsk = hasPendingAskForSession(sessionId, sessionRuntimeUiById);
					// 单击默认 preview；双击显式常驻（与 SessionTree 同一入口语义）。
					const openSession = (tabMode?: "preview" | "permanent") => {
						if (sessionId) void props.actions.sessions.open(projectId, sessionId, tabMode);
					};
					return (
						<div
							key={agent.id}
							className="group/row relative mt-0.5 flex min-h-8 items-center"
							onContextMenu={(event) => {
								event.preventDefault();
								void controller.openMenu({ kind: "agent", agentId: agent.id, x: event.clientX, y: event.clientY });
							}}
						>
							<SessionHoverCard session={record ?? summary} title={displayTitle} projectName={project?.name} status={agent.status} disabled={Boolean(controller.menu)}>
								<button
									type="button"
									className={cn(activeRowClass, selected && "bg-bg-active text-foreground")}
									onClick={() => openSession()}
									onDoubleClick={() => openSession("permanent")}
									draggable={Boolean(sessionId)}
									onDragStart={(event) => {
										if (!sessionId) return;
										event.dataTransfer.effectAllowed = "move";
										event.dataTransfer.setData(SESSION_TAB_DRAG_MIME, sessionId);
										event.dataTransfer.setData("text/plain", sessionId);
										props.actions.sessions.beginDrag?.(sessionId);
									}}
									onDragEnd={() => props.actions.sessions.endDrag?.()}
								>
									<span className={cn("size-1.5 shrink-0 rounded-full", sessionStatusDotClass(agent.status))} aria-hidden="true" />
									<div className="conversation-body min-w-0 flex-1 transition-[padding-right] group-hover/row:pr-7 group-focus-within/row:pr-7">
										<div className="conversation-title flex min-w-0 items-center gap-1.5">
											{/* 选中背景仍保留，聚焦行也允许 hover 查看完整标题 */}
											<TitleScrollText text={displayTitle} className="font-medium" />
											<SessionBackendMark backend={agent.backend} />
											{/* 待确认标记：该会话正在等用户回答 ask，与项目行徽章共用同一组件 */}
											{pendingAsk && <PendingAskBadge count={1} />}
											{/* 相对时间常显：hover 时被右侧「⋯」浮层盖住（与历史会话行同一策略） */}
											<span className="shrink-0 text-caption tabular-nums text-muted-foreground group-hover/row:hidden">{formatRelativeTime(sortAt)}</span>
										</div>
									</div>
								</button>
							</SessionHoverCard>
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								className={cn(rowMoreActionsClass, controller.menu?.kind === "agent" && controller.menu.agentId === agent.id && "pointer-events-auto opacity-100")}
								aria-label={t("sidebar.moreActions")}
								title={t("sidebar.moreActions")}
								onClick={(event) => {
									event.stopPropagation();
									const rect = event.currentTarget.getBoundingClientRect();
									void controller.openMenu({ kind: "agent", agentId: agent.id, x: rect.right, y: rect.bottom });
								}}
							>
								<Ellipsis size={14} aria-hidden="true" />
							</Button>
						</div>
					);
				})}
			</div>
			{/* 下半：最近会话常驻面板下半部分，自带滚动（与上半各自独立）。 */}
			{hasRecent && (
				<div className="recent-sessions-pane flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]">
					<RecentSessionsSection
						controller={controller}
						actions={props.actions}
						currentSessionId={props.currentSessionId}
						rows={recent.rows}
						totalCount={recent.totalCount}
						visibleCount={recentVisibleCount}
						onLoadMore={() => setRecentVisibleCount((current) => growRecentVisible(current, recent.totalCount))}
						onCollapse={() => setRecentVisibleCount(RECENT_SESSIONS_INITIAL_VISIBLE)}
					/>
				</div>
			)}
		</div>
	);
}
