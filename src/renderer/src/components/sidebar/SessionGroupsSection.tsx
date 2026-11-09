/**
 * 侧栏「分组」区：会话分组的两层列表（分组 → 会话），只读浏览。
 *
 * 数据在宿主 session-groups.json（userData/session-groups.json），写入方是会话分组插件页；
 * 取数与订阅由 useSessionGroups 统一提供，装配成节点放在 ProjectTree（同一份数据还要用于
 * 「项目列表里隐藏已入组会话」），本组件只负责渲染。
 * 点击会话走侧栏同一条打开链路（选中 + 按设置登记 Tab）；右键复用项目树的会话菜单
 * （Agent 菜单 / 会话菜单同一判定，见 openSessionRowMenu）；增删改管理仍在插件页（v1 约定）。
 * 没有分组（插件未启用 / 全部失效 / 本栏目裁剪后没有会话）时整块不渲染：不留一个永远空着的区。
 * 渲染范围由调用方传入的 nodes 决定：聊天栏目只给 Chat 会话节点，项目栏目只给工作区会话节点
 * （见 sessionGroupsModel.buildSessionGroupNodes 的 scope），活动栏目不挂本区。
 */
import { ChevronRight, Ellipsis } from "lucide-react";
import { useState } from "react";
import type { Project, SessionGroupColor } from "../../../../shared/types";
import type { SidebarController } from "../../hooks/useSidebarController";
import { useSessionActivityAt } from "../../hooks/sidebar/useSessionActivityClock";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { formatRelativeTime } from "../../utils/relativeTime";
import { Button } from "../ui-shadcn/button";
import type { SidebarActions } from "./SidebarContent";
import { projectDirectoryLabel, type SessionGroupNode } from "./sessionGroupsModel";
import { openSessionRowMenu } from "./sessionRowMenu";
import { SessionRuntimeStatusDot } from "./SidebarStatusDot";
import { ROW_CONTAINER_CLASS, ROW_MORE_ACTIONS_CLASS, SESSION_ROW_CLASS, SESSION_ROW_SELECTED_CLASS } from "./sidebarRowStyles";

/** 分组身份色（与插件页色点同值；内联样式避免 Tailwind 按名字 purge）。 */
const GROUP_COLOR_HEX: Record<SessionGroupColor, string> = {
	blue: "#3b82f6",
	green: "#16a34a",
	orange: "#ea580c",
	purple: "#7c3aed",
	red: "#dc2626",
	cyan: "#0891b2",
};

const SECTION_COLLAPSED_KEY = "sidebar.sessionGroups.sectionCollapsed";
const GROUP_COLLAPSED_KEY = "sidebar.sessionGroups.groupCollapsed";

function readIdSet(key: string): Set<string> {
	try {
		const raw = localStorage.getItem(key);
		const parsed = raw ? (JSON.parse(raw) as unknown) : [];
		return Array.isArray(parsed) ? new Set(parsed.filter((id): id is string => typeof id === "string")) : new Set();
	} catch {
		return new Set();
	}
}

function writeIdSet(key: string, ids: Set<string>): void {
	try {
		localStorage.setItem(key, JSON.stringify([...ids]));
	} catch {
		/* localStorage 不可用时折叠态退化为内存态，不影响功能。 */
	}
}

/** 分组标题行：比会话行略低密度（无时间列、无更多按钮），只做折叠开关。 */
const groupRowClass = "relative flex min-h-7 w-full cursor-pointer select-none items-center gap-1.5 rounded-lg border border-transparent px-2 py-0 text-left text-caption font-medium text-foreground transition-[background-color,border-color] duration-base hover:border-border-subtle hover:bg-bg-hover";

export function SessionGroupsSection(props: { nodes: readonly SessionGroupNode[]; projectsById: Readonly<Record<string, Project>>; controller: SidebarController; actions: SidebarActions; currentSessionId?: string }) {
	const [sectionCollapsed, setSectionCollapsed] = useState(() => readIdSet(SECTION_COLLAPSED_KEY).has("section"));
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => readIdSet(GROUP_COLLAPSED_KEY));
	const activityAt = useSessionActivityAt();
	if (props.nodes.length === 0) return null;

	const toggleGroup = (groupId: string) => {
		setCollapsedGroups((current) => {
			const next = new Set(current);
			if (next.has(groupId)) next.delete(groupId);
			else next.add(groupId);
			writeIdSet(GROUP_COLLAPSED_KEY, next);
			return next;
		});
	};

	return (
		<section aria-label={t("sidebar.sessionGroups")} className="mb-4">
			<div className="flex items-center justify-between px-1 pb-1">
				<button type="button" className="flex min-w-0 items-center gap-1 text-caption font-medium text-muted-foreground" aria-expanded={!sectionCollapsed} onClick={() => setSectionCollapsed((value) => !value)}>
					<ChevronRight size={12} className={cn("shrink-0 transition-transform", !sectionCollapsed && "rotate-90")} aria-hidden="true" />
					<span className="truncate">{t("sidebar.sessionGroups")}</span>
					<span className="text-muted-foreground/70">{props.nodes.length}</span>
				</button>
			</div>
			{!sectionCollapsed && (
				<div className="space-y-0.5">
					{props.nodes.map(({ group, total, projectCount, sessions }) => {
						const collapsed = collapsedGroups.has(group.id);
						return (
							<div key={group.id}>
								<button type="button" className={groupRowClass} aria-expanded={!collapsed} onClick={() => toggleGroup(group.id)}>
									<ChevronRight size={12} className={cn("shrink-0 text-muted-foreground transition-transform", !collapsed && "rotate-90")} aria-hidden="true" />
									<span className="size-2 shrink-0 rounded-full" style={{ background: GROUP_COLOR_HEX[group.color] }} aria-hidden="true" />
									<span className="min-w-0 flex-1 truncate">{group.name}</span>
									<span className="shrink-0 text-muted-foreground/70">{total}</span>
								</button>
								{!collapsed && (
									<div className="ml-3 space-y-0.5 border-l border-border-subtle pl-2">
										{sessions.length === 0 && <div className="px-2 py-0.5 text-caption text-muted-foreground/70">{t("sidebar.sessionGroupsEmpty")}</div>}
										{sessions.map((session) => {
											const projectLabel = projectDirectoryLabel(props.projectsById[session.projectId], session.projectId);
											const menuOpen = props.controller.menu?.kind === "session" && props.controller.menu.sessionId === session.id;
											return (
												<div key={session.id} className={ROW_CONTAINER_CLASS} onContextMenu={(event) => openSessionRowMenu(props.controller, event, session.projectId, session.id)}>
													<button
														type="button"
														className={cn(SESSION_ROW_CLASS, "pl-2", session.id === props.currentSessionId && SESSION_ROW_SELECTED_CLASS)}
														// 多项目分组才标项目名：单项目组里重复同一个名字只是噪音（tooltip 始终给完整路径）。
														title={projectCount > 1 ? `${session.title}\n${[projectLabel.name, projectLabel.path].filter(Boolean).join(" · ")}` : session.title}
														onClick={() => void props.actions.sessions.open(session.projectId, session.id)}
													>
														<div className="conversation-body min-w-0 flex-1 transition-[padding-right] group-hover/row:pr-7 group-focus-within/row:pr-7">
															<div className="conversation-title flex min-w-0 items-center gap-1.5">
																{/* 运行状态：入组后项目列表的 agent 行会被隐藏，这里是该会话唯一的运行态入口（与项目树同一套色点/脉动）。 */}
														<SessionRuntimeStatusDot status={props.controller.catalog.runtimeBySessionId[session.id]?.status} />
														<span className="min-w-0 flex-1 truncate">{session.title}</span>
																{projectCount > 1 && <span className="max-w-24 shrink-0 truncate text-micro text-muted-foreground/70">{projectLabel.name}</span>}
																{/* 时间 hover 时让位给「⋯」：与项目树会话行同一策略，避免瞬时消失导致行尾跳动。 */}
																<span
																	className="w-max shrink-0 overflow-hidden whitespace-nowrap text-micro tabular-nums text-muted-foreground transition-[width,opacity] [interpolate-size:allow-keywords] group-hover/row:w-0 group-hover/row:opacity-0 group-focus-within/row:w-0 group-focus-within/row:opacity-0"
																	title={formatRelativeTime(activityAt(session.id, session.updatedAt))}
																>
																	{formatRelativeTime(activityAt(session.id, session.updatedAt))}
																</span>
															</div>
														</div>
													</button>
													<Button
														type="button"
														variant="ghost"
														size="icon-xs"
														className={cn(ROW_MORE_ACTIONS_CLASS, menuOpen && "pointer-events-auto opacity-100")}
														aria-label={t("sidebar.moreActions")}
														title={t("sidebar.moreActions")}
														onClick={(event) => {
															event.stopPropagation();
															openSessionRowMenu(props.controller, event, session.projectId, session.id);
														}}
													>
														<Ellipsis size={14} aria-hidden="true" />
													</Button>
												</div>
											);
										})}
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}
		</section>
	);
}
