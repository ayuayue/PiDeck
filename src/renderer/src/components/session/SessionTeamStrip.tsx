import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { ChevronDown, ChevronUp, Users } from "lucide-react";
import { sessionRuntimeBySessionIdAtomFamily } from "../../atoms";
import { t } from "../../i18n";
import type { DshTeamMember, DshTeamState, DshTeamTask } from "../../../../shared/types/agent";
import { ComposerWidgetFrame, useComposerWidgetCollapsed } from "./ComposerWidgetLayout";

/**
 * composer 上方的 Team 常驻条（agent-team 实验预设，P1 最小可用视图）。
 *
 * 数据源：官方 `agentTeam` projection 经主进程解析后的 AgentRuntimeState.dshTeam
 * （成员 roster + 任务板，见 src/main/dsh/dshTeamProjection.ts 的数据面取舍）。
 * 仅 DSH 后端且 dshTeam 有内容（成员/任务/失败记录任一非空）时渲染；
 * 未启用预设的会话该字段恒 undefined，面板自然不出现。
 * 按 sessionId 订阅 runtime atom family，多会话天然隔离（不订全局 currentSession*）。
 */

function memberPhaseLabel(member: DshTeamMember): string {
	if (member.role === "lead") return t("sessionTeam.role.lead");
	if (member.phase === "provisioning") return t("sessionTeam.phase.provisioning");
	if (member.phase === "failed") return member.error ? `${t("sessionTeam.phase.failed")} · ${member.error}` : t("sessionTeam.phase.failed");
	return t("sessionTeam.role.teammate");
}

function taskStatusLabel(task: DshTeamTask): string {
	if (task.status === "in_progress") return t("sessionTeam.task.in_progress");
	if (task.status === "completed") return t("sessionTeam.task.completed");
	if (task.status === "deleted") return t("sessionTeam.task.deleted");
	return task.ready ? t("sessionTeam.task.pending") : t("sessionTeam.blocked");
}

/** 任务状态点：进行中=品牌色、完成=成功色、删除=弱化、待处理按 ready 分弱化/警示。 */
function taskStatusDotClass(task: DshTeamTask): string {
	if (task.status === "in_progress") return "bg-[var(--color-accent)]";
	if (task.status === "completed") return "bg-[var(--color-success)]";
	if (task.status === "deleted") return "bg-text-tertiary/50";
	return task.ready ? "bg-text-tertiary/70" : "bg-[var(--color-warning)]";
}

/** 成员状态点：活跃=成功色、启动中=警示色、失败=danger 色。 */
function memberPhaseDotClass(member: DshTeamMember): string {
	if (member.phase === "provisioning") return "bg-[var(--color-warning)]";
	if (member.phase === "failed") return "bg-[var(--color-danger)]";
	return "bg-[var(--color-success)]";
}

/** 头部摘要：「n 成员 · n 任务」（删除态任务不计入，避免噪音）。导出供测试断言。 */
export function teamSummaryLabel(team: DshTeamState): string {
	const tasks = team.tasks.filter((task) => task.status !== "deleted").length;
	return t("sessionTeam.summary", { members: team.members.length, tasks });
}

/** 面板可见性：启用预设后没有任何成员/任务/失败记录时不占位（「有数据才显示」）。类型谓词兼供组件内收窄。 */
export function hasTeamContent(team: DshTeamState | null | undefined): team is DshTeamState {
	if (!team) return false;
	return team.members.length > 0 || team.tasks.length > 0 || typeof team.failure === "string";
}

export function SessionTeamStrip(props: { sessionId: string }) {
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(props.sessionId));
	const { collapsed, toggleCollapsed } = useComposerWidgetCollapsed(`team:${props.sessionId}`, false);

	const team = runtime?.backend === "dsh" ? runtime.state?.dshTeam : undefined;
	const members = useMemo(() => team?.members ?? [], [team]);
	const tasks = useMemo(() => (team ? team.tasks.filter((task) => task.status !== "deleted") : []), [team]);

	if (!hasTeamContent(team)) return null;

	return (
		<ComposerWidgetFrame data-testid="session-team-strip" aria-label={t("sessionTeam.title")}>
			<div className="flex h-9 w-full items-center gap-2.5 px-3">
				<button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 text-left" aria-expanded={!collapsed} onClick={toggleCollapsed}>
					<Users size={14} aria-hidden="true" className="shrink-0 text-text-tertiary" />
					<span className="shrink-0 text-control font-medium leading-6 text-foreground">{t("sessionTeam.title")}</span>
					<span className="min-w-0 flex-1 truncate text-control leading-5 text-text-tertiary">{teamSummaryLabel(team)}</span>
					<span className="shrink-0 text-text-tertiary" aria-hidden="true">
						{collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
					</span>
				</button>
			</div>
			{!collapsed && (
				<div className="mb-2 flex max-h-[260px] flex-col gap-2 overflow-y-auto [contain:layout_paint] px-3 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-100 motion-reduce:animate-none">
					{/* 与 todo 条同款 shrink-0 纪律：限高 flex 列 + 行 overflow-hidden 会清零
					    min-height:auto，不锁行高整列会被线性压扁（2027-01 排版事故）。 */}
					{team?.failure && <p className="shrink-0 rounded-md bg-[var(--color-danger)]/10 px-2 py-1 text-xs leading-5 text-[var(--color-danger)]">{t("sessionTeam.failure", { failure: team.failure })}</p>}
					{members.map((member) => (
						<div key={member.id} className="flex min-w-0 shrink-0 items-center gap-2.5 overflow-hidden text-control leading-5">
							<span className={`size-1.5 shrink-0 rounded-full ${memberPhaseDotClass(member)}`} aria-hidden="true" />
							<span className="min-w-0 shrink-0 truncate font-medium text-text-secondary">{member.name}</span>
							<span className="min-w-0 flex-1 truncate text-xs text-text-tertiary">{memberPhaseLabel(member)}</span>
						</div>
					))}
					{tasks.length > 0 && <p className="shrink-0 pt-1 text-xs font-medium uppercase tracking-wide text-text-tertiary">{t("sessionTeam.tasks")}</p>}
					{tasks.length === 0 && members.length === 0 && <p className="shrink-0 text-control leading-5 text-text-tertiary">{t("sessionTeam.noTasks")}</p>}
					{tasks.map((task) => (
						<div key={task.id} className="flex min-w-0 shrink-0 items-center gap-2.5 overflow-hidden text-control leading-5">
							<span className={`size-1.5 shrink-0 rounded-full transition-colors ${taskStatusDotClass(task)}`} aria-hidden="true" />
							<span className="min-w-0 flex-1 truncate text-text-secondary">{task.subject}</span>
							<span className="shrink-0 truncate text-xs text-text-tertiary">{task.ownerName ?? t("sessionTeam.unassigned")}</span>
						</div>
					))}
				</div>
			)}
		</ComposerWidgetFrame>
	);
}
