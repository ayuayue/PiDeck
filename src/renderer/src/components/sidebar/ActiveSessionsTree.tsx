import { Ellipsis } from "lucide-react";
import type { AgentTab, SessionRecord } from "../../../../shared/types";
import { sessionStatusDotClass } from "../../agentListDisplay";
import { sessionRecordToSummary } from "../../atoms";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { isLiveRuntimeStatus } from "../../utils/sessionCommands";
import type { SidebarController } from "../../hooks/useSidebarController";
import type { SidebarActions } from "./SidebarContent";
import { Button } from "../ui-shadcn/button";
import { SessionBackendMark } from "../session/SessionSourceBadge";
import { TitleScrollText } from "./TitleScrollText";
import { SESSION_TAB_DRAG_MIME } from "../../utils/sessionSplitEdge";
import { formatRelativeTime } from "../../utils/relativeTime";

/** 活动页行样式：与 SessionTree 会话行同尺寸同圆角，但选中底不需要（活动页行不持久）。 */
const activeRowClass =
	"group/resource conversation agent-row relative flex min-h-8 w-full items-center gap-1.5 rounded-lg border border-transparent px-2 py-0 text-left text-body text-foreground shadow-none transition-[background-color,border-color,box-shadow] duration-200 hover:border-border-subtle hover:bg-muted/60 hover:text-foreground focus-visible:bg-muted/70 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset";

/** 右侧「更多操作」按钮：与 SessionTree 同一套 absolute 浮层虚化模式，
 *  行 hover 出现，菜单打开期间保持点亮。 */
const rowMoreActionsClass =
	"row-more-actions pointer-events-none absolute top-1/2 right-1 -translate-y-1/2 opacity-0 transition-opacity group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100";

/**
 * 活动 Agent 会话页：跨项目收集所有已激活（live runtime）的 Agent，按会话更新时间排序。
 * 活动行身份与 SessionTree 的 agent 行一致（状态点 + 标题 + 后端标记 + 相对时间），
 * 点击打开绑定会话（单击 preview / 双击 permanent），右键打开 Agent 菜单，支持拖拽分屏。
 * 这是「进程还在跑」的实时入口，与 chats 的历史会话列表互补：历史页只读记录，活动页跟进程。
 */
export function ActiveSessionsTree(props: {
	controller: SidebarController;
	actions: SidebarActions;
	currentSessionId?: string;
}) {
	const { controller } = props;
	// 收集所有项目下 live runtime 的 agent，并解析其绑定会话记录（sessionId → record）。
	const liveRows: {
		agent: AgentTab;
		projectId: string;
		record?: SessionRecord;
		sortAt: number;
	}[] = [];
	for (const project of controller.catalog.projects) {
		const sessions = controller.catalog.sessionsByProject[project.id] ?? [];
		for (const agent of controller.catalog.agents) {
			if (agent.projectId !== project.id) continue;
			if (!isLiveRuntimeStatus(agent.status)) continue;
			// 绑定会话：runtimeBySessionId 反查（最可靠），否则按 sessionPath 匹配历史记录。
			const bound = sessions.find((session) =>
				controller.catalog.runtimeBySessionId[session.id]?.agentId === agent.id,
			) ?? sessions.find((session) => session.filePath === agent.sessionPath);
			liveRows.push({
				agent,
				projectId: project.id,
				record: bound,
				// 有绑定记录按会话更新时间排，全新 Agent 按创建时间（排在会话之后）。
				sortAt: bound ? bound.updatedAt : agent.createdAt,
			});
		}
	}
	liveRows.sort((left, right) => right.sortAt - left.sortAt);

	if (liveRows.length === 0) {
		return (
			<div className="active-sessions-empty flex h-full min-h-0 flex-col items-center justify-center gap-2 px-4 py-8 text-center">
				<div className="text-caption text-muted-foreground">{t("app.sidebarActiveEmpty")}</div>
			</div>
		);
	}

	return (
		<div className="active-sessions-list flex flex-col gap-0">
			{liveRows.map(({ agent, projectId, record, sortAt }) => {
				const sessionId = record?.id;
				const selected = sessionId === props.currentSessionId;
				const summary = record ? sessionRecordToSummary(record) : undefined;
				const displayTitle = summary?.name || agent.title;
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
							<span
								className={cn(
									"size-1.5 shrink-0 rounded-full",
									sessionStatusDotClass(agent.status),
								)}
								aria-hidden="true"
							/>
							<div className="conversation-body min-w-0 flex-1 transition-[padding-right] group-hover/row:pr-7 group-focus-within/row:pr-7">
								<div className="conversation-title flex min-w-0 items-center gap-1.5">
									<TitleScrollText text={displayTitle} className="font-medium" />
									<SessionBackendMark backend={agent.backend} />
									{/* 相对时间常显：hover 时被右侧「⋯」浮层盖住（与历史会话行同一策略） */}
									<span className="shrink-0 text-caption tabular-nums text-muted-foreground group-hover/row:hidden">
										{formatRelativeTime(sortAt)}
									</span>
								</div>
							</div>
						</button>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							className={cn(
								rowMoreActionsClass,
								controller.menu?.kind === "agent" && controller.menu.agentId === agent.id && "pointer-events-auto opacity-100",
							)}
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
	);
}
