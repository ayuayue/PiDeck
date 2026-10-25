import { useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { Edit, Play, Plus, Trash2 } from "lucide-react";
import { automationRunningTaskIdsAtom, automationRunsAtom, automationTasksAtom } from "../../atoms/automation-atoms";
import { projectInventoryAtom } from "../../atoms/project-atoms";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { Badge } from "../ui-shadcn/badge";
import { Button } from "../ui-shadcn/button";
import { ConfirmDialog } from "../ui-shadcn/ConfirmDialog";
import { Switch } from "../ui-shadcn/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui-shadcn/table";
import type { AutomationRun, AutomationTask, AutomationTaskSummary } from "../../../../shared/types";

interface AutomationTaskListProps {
	/** Omit for the cross-project overview; a project page owns one task table. */
	projectId?: string;
	onEditTask: (task: AutomationTask) => void;
	onCreateTask: () => void;
}

function formatTime(timestamp?: number): string {
	if (!timestamp) return "-";
	return new Date(timestamp).toLocaleString(undefined, {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function runStatusLabel(status: AutomationRun["status"]): string {
	switch (status) {
		case "queued":
			return t("automation.status.queued");
		case "starting":
			return t("automation.status.starting");
		case "running":
			return t("automation.status.running");
		case "succeeded":
			return t("automation.status.succeeded");
		case "aborted":
			return t("automation.status.aborted");
		case "skipped":
			return t("automation.status.skipped");
		case "timed-out":
			return t("automation.status.timedOut");
		case "interrupted":
			return t("automation.status.interrupted");
		case "budget-exhausted":
		case "failed":
			return t("automation.status.failed");
	}
}

/** 运行状态 → badge 语义档：色值与尺寸都由 Badge 承担，这里只做角色映射。 */
function runStatusVariant(status: AutomationRun["status"]): "success" | "danger" | "warning" | "info" | "neutral" {
	if (status === "succeeded") return "success";
	if (status === "failed" || status === "timed-out" || status === "budget-exhausted" || status === "interrupted") return "danger";
	if (status === "aborted") return "warning";
	if (status === "queued" || status === "starting" || status === "running") return "info";
	return "neutral";
}

/**
 * Project-owned automation task table. A task is durable configuration; rows show
 * its schedule and most recent run, while each trigger still creates a fresh Agent session.
 */
export function AutomationTaskList({ projectId, onEditTask, onCreateTask }: AutomationTaskListProps) {
	const allTasks = useAtomValue(automationTasksAtom);
	const runningTaskIds = useAtomValue(automationRunningTaskIdsAtom);
	const runs = useAtomValue(automationRunsAtom);
	const projects = useAtomValue(projectInventoryAtom);
	const tasks = useMemo(() => (projectId ? allTasks.filter((task) => task.projectId === projectId) : allTasks), [allTasks, projectId]);

	const [deletingTask, setDeletingTask] = useState<AutomationTaskSummary | null>(null);
	const [triggeringTaskIds, setTriggeringTaskIds] = useState<Set<string>>(new Set());

	const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);
	const latestRunByTaskId = useMemo(() => {
		const result = new Map<string, AutomationRun>();
		for (const run of runs) {
			if (!result.has(run.taskId)) result.set(run.taskId, run);
		}
		return result;
	}, [runs]);

	const handleToggleEnable = async (task: AutomationTaskSummary, enabled: boolean) => {
		try {
			await desktopApi.automation.updateTask(task.id, { enabled });
			showNotice(t("automation.taskSaved"), 2000);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 3000);
		}
	};

	const handleRunNow = async (task: AutomationTaskSummary) => {
		setTriggeringTaskIds((current) => new Set(current).add(task.id));
		try {
			await desktopApi.automation.runNow(task.id);
			showNotice(t("automation.runStarted"), 2500);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 3500);
		} finally {
			setTriggeringTaskIds((current) => {
				const next = new Set(current);
				next.delete(task.id);
				return next;
			});
		}
	};

	const handleConfirmDelete = async () => {
		if (!deletingTask) return;
		try {
			await desktopApi.automation.deleteTask(deletingTask.id);
			showNotice(t("automation.taskDeleted"), 2000);
			setDeletingTask(null);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 3500);
		}
	};

	if (tasks.length === 0) {
		return (
			<div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
				<div className="text-sm font-medium text-foreground">{projectId ? t("automation.emptyProjectTasks") : t("automation.emptyTasks")}</div>
				<p className="max-w-md text-xs text-muted-foreground">{t("automation.emptyTasksDesc")}</p>
				<Button size="sm" onClick={onCreateTask} className="h-8 gap-1.5 text-xs">
					<Plus className="size-3.5" />
					{t("automation.createTask")}
				</Button>
			</div>
		);
	}

	return (
		<div className="flex min-w-0 flex-col gap-3">
			<div className="flex items-center justify-between gap-3">
				<span className="text-xs text-muted-foreground">
					{t("automation.tasksTab")} ({tasks.length})
				</span>
				<span className="text-micro text-muted-foreground">{t("automation.freshSessionHint")}</span>
			</div>

			<div className="overflow-hidden rounded-lg border border-border/60 bg-bg-panel/30">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>{t("automation.table.task")}</TableHead>
							{!projectId && <TableHead>{t("automation.project")}</TableHead>}
							<TableHead>{t("automation.table.schedule")}</TableHead>
							<TableHead>{t("automation.table.status")}</TableHead>
							<TableHead>{t("automation.table.nextRun")}</TableHead>
							<TableHead>{t("automation.table.lastRun")}</TableHead>
							<TableHead className="w-px text-right">{t("automation.table.actions")}</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{tasks.map((task) => {
							const isRunning = runningTaskIds.has(task.id);
							const isTriggering = triggeringTaskIds.has(task.id);
							const latestRun = latestRunByTaskId.get(task.id);
							const schedule = task.schedule.type === "cron" ? task.schedule.expression : t("automation.manualTrigger");

							return (
								<TableRow key={task.id}>
									<TableCell className="min-w-56 whitespace-normal">
										<div className="flex min-w-0 flex-col gap-1">
											<div className="flex min-w-0 items-center gap-1.5">
												<span className="truncate text-xs font-medium text-foreground">{task.name}</span>
												{task.mode === "plan" && (
													<Badge variant="outline" size="sm">
														{t("app.composerModePlan")}
													</Badge>
												)}
												{task.mode === "goal" && (
													<Badge variant="warning" size="sm">
														{t("app.composerModeGoal")}
													</Badge>
												)}
											</div>
											<p className="max-w-80 truncate font-mono text-micro text-muted-foreground" title={task.prompt}>
												{task.prompt}
											</p>
										</div>
									</TableCell>
									{!projectId && (
										<TableCell className="max-w-36 truncate text-xs text-muted-foreground" title={projectMap.get(task.projectId) ?? task.projectId}>
											{projectMap.get(task.projectId) ?? task.projectId}
										</TableCell>
									)}
									<TableCell>
										<span className="font-mono text-micro text-muted-foreground" title={schedule}>
											{schedule}
										</span>
									</TableCell>
									<TableCell>
										<Badge variant={isRunning ? "info" : task.enabled ? "success" : "neutral"} size="sm" className={isRunning ? "animate-pulse" : undefined}>
											{isRunning ? t("automation.running") : task.enabled ? t("automation.enabled") : t("automation.disabled")}
										</Badge>
									</TableCell>
									<TableCell className="text-micro text-muted-foreground">{task.nextRunAt ? formatTime(task.nextRunAt) : t("automation.manualTrigger")}</TableCell>
									<TableCell>
										{latestRun ? (
											<div className="flex flex-col gap-1">
												<Badge variant={runStatusVariant(latestRun.status)} size="sm">
													{runStatusLabel(latestRun.status)}
												</Badge>
												<span className="text-micro text-muted-foreground">{formatTime(latestRun.updatedAt)}</span>
											</div>
										) : (
											<span className="text-micro text-muted-foreground">{t("automation.neverRun")}</span>
										)}
									</TableCell>
									<TableCell>
										<div className="flex items-center justify-end gap-1">
											<Switch checked={task.enabled} onCheckedChange={(checked) => handleToggleEnable(task, checked)} aria-label={task.enabled ? t("automation.enabled") : t("automation.disabled")} />
											<Button type="button" variant="ghost" size="icon-sm" className="size-7 text-success hover:bg-success/10 hover:text-success" disabled={isRunning || isTriggering} title={t("automation.runNow")} aria-label={t("automation.runNow")} onClick={() => handleRunNow(task)}>
												<Play className="size-3.5" />
											</Button>
											<Button type="button" variant="ghost" size="icon-sm" className="size-7 text-muted-foreground hover:bg-muted hover:text-foreground" title={t("automation.editTask")} aria-label={t("automation.editTask")} onClick={() => onEditTask(task)}>
												<Edit className="size-3.5" />
											</Button>
											<Button type="button" variant="ghost" size="icon-sm" className="size-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" title={t("automation.deleteTask")} aria-label={t("automation.deleteTask")} onClick={() => setDeletingTask(task)}>
												<Trash2 className="size-3.5" />
											</Button>
										</div>
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			</div>

			{deletingTask && <ConfirmDialog title={t("automation.deleteTask")} message={t("automation.deleteConfirm", { name: deletingTask.name })} confirmLabel={t("automation.delete")} danger onConfirm={handleConfirmDelete} onCancel={() => setDeletingTask(null)} />}
		</div>
	);
}
