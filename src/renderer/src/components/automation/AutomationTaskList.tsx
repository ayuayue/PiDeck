import { useState } from "react";
import { useAtomValue } from "jotai";
import {
	Play,
	Plus,
	Trash2,
	Edit,
	CheckCircle2,
	XCircle,
	AlertCircle,
} from "lucide-react";
import {
	automationTasksAtom,
	automationRunningTaskIdsAtom,
	automationRunsAtom,
} from "../../atoms/automation-atoms";
import { projectInventoryAtom } from "../../atoms/project-atoms";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { showNotice } from "../../utils/notice";
import { Button } from "../ui-shadcn/button";
import { Badge } from "../ui-shadcn/badge";
import { Switch } from "../ui-shadcn/switch";
import { ConfirmDialog } from "../ui-shadcn/ConfirmDialog";
import type { AutomationTask, AutomationTaskSummary } from "../../../../shared/types";

interface AutomationTaskListProps {
	onEditTask: (task: AutomationTask) => void;
	onCreateTask: () => void;
	onSelectTaskForHistory?: (taskId: string) => void;
}

/**
 * 格式化时间戳为本地简短时间串。
 */
function formatTime(timestamp?: number): string {
	if (!timestamp) return "";
	const date = new Date(timestamp);
	return date.toLocaleString(undefined, {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

/**
 * 定时任务列表视图：展示所有已定义的定时任务卡片、启用/暂停切换、手动触发、编辑与删除。
 */
export function AutomationTaskList({
	onEditTask,
	onCreateTask,
}: AutomationTaskListProps) {
	const tasks = useAtomValue(automationTasksAtom);
	const runningTaskIds = useAtomValue(automationRunningTaskIdsAtom);
	const runs = useAtomValue(automationRunsAtom);
	const projects = useAtomValue(projectInventoryAtom);

	const [deletingTask, setDeletingTask] = useState<AutomationTaskSummary | null>(null);
	const [triggeringTaskIds, setTriggeringTaskIds] = useState<Set<string>>(
		new Set(),
	);

	// 项目 ID 到项目名称的快速映射
	const projectMap = new Map<string, string>();
	for (const p of projects) {
		projectMap.set(p.id, p.name);
	}

	// 任务 ID 到最近一次运行状态的映射
	const latestRunByTaskId = new Map<string, (typeof runs)[0]>();
	for (const run of runs) {
		if (!latestRunByTaskId.has(run.taskId)) {
			latestRunByTaskId.set(run.taskId, run);
		}
	}

	/** 切换任务启用/暂停 */
	const handleToggleEnable = async (task: AutomationTaskSummary, enabled: boolean) => {
		try {
			await desktopApi.automation.updateTask(task.id, { enabled });
			showNotice(t("automation.taskSaved"), 2000);
		} catch (error) {
			showNotice(
				error instanceof Error ? error.message : String(error),
				3000,
			);
		}
	};

	/** 手动立即触发执行 */
	const handleRunNow = async (task: AutomationTaskSummary) => {
		setTriggeringTaskIds((prev) => new Set(prev).add(task.id));
		try {
			await desktopApi.automation.runNow(task.id);
			showNotice(t("automation.runStarted"), 2500);
		} catch (error) {
			showNotice(
				error instanceof Error ? error.message : String(error),
				3500,
			);
		} finally {
			setTriggeringTaskIds((prev) => {
				const next = new Set(prev);
				next.delete(task.id);
				return next;
			});
		}
	};

	/** 确认删除任务 */
	const handleConfirmDelete = async () => {
		if (!deletingTask) return;
		try {
			await desktopApi.automation.deleteTask(deletingTask.id);
			showNotice(t("automation.taskDeleted"), 2000);
			setDeletingTask(null);
		} catch (error) {
			showNotice(
				error instanceof Error ? error.message : String(error),
				3500,
			);
		}
	};

	if (tasks.length === 0) {
		return (
			<div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
				<div className="text-sm font-medium text-foreground">
					{t("automation.emptyTasks")}
				</div>
				<p className="max-w-md text-xs text-muted-foreground">
					{t("automation.emptyTasksDesc")}
				</p>
				<Button size="sm" onClick={onCreateTask} className="h-8 gap-1.5 text-xs">
					<Plus className="size-3.5" />
					{t("automation.createTask")}
				</Button>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-3">
			<div className="flex items-center justify-between pb-1">
				<span className="text-xs text-muted-foreground">
					{t("automation.tasksTab")} ({tasks.length})
				</span>
				<Button size="sm" onClick={onCreateTask} className="h-7 gap-1 text-xs">
					<Plus className="size-3" />
					{t("automation.createTask")}
				</Button>
			</div>

			<div className="flex flex-col gap-2.5">
				{tasks.map((task) => {
					const isRunning = runningTaskIds.has(task.id);
					const isTriggering = triggeringTaskIds.has(task.id);
					const projectName = projectMap.get(task.projectId) || task.projectId;
					const latestRun = latestRunByTaskId.get(task.id);

					return (
						<div
							key={task.id}
							className="flex flex-col gap-2.5 rounded-lg border border-border/60 bg-bg-panel/40 p-3 transition-colors hover:border-border"
						>
							<div className="flex items-start justify-between gap-3">
								<div className="flex min-w-0 flex-1 flex-col gap-1">
									<div className="flex items-center gap-2">
										<span className="truncate text-sm font-medium text-foreground">
											{task.name}
										</span>
										<Badge
											variant="outline"
											className="h-5 px-1.5 text-[11px] font-normal"
										>
											{projectName}
										</Badge>
										{task.schedule.type === "cron" && (
											<span className="font-mono text-xs text-muted-foreground bg-bg-muted/80 px-1.5 py-0.5 rounded">
												{task.schedule.expression}
											</span>
										)}
										{/* 非普通工作模式才打标：普通是缺省，标出来只会加噪音 */}
										{task.mode === "plan" && (
											<Badge
												variant="outline"
												className="h-5 px-1.5 text-[11px] font-normal"
											>
												{t("app.composerModePlan")}
											</Badge>
										)}
										{task.mode === "goal" && (
											<Badge className="h-5 border-amber-500/30 bg-amber-500/15 px-1.5 text-[11px] font-normal text-amber-600">
												{t("app.composerModeGoal")}
											</Badge>
										)}
										{/* DSH 后端任务打标（pi 是缺省，标出来只会加噪音） */}
										{task.backend === "dsh" && (
											<Badge className="h-5 border-violet-500/30 bg-violet-500/15 px-1.5 text-[11px] font-normal text-violet-500">
												{t("automation.backendDsh")}
											</Badge>
										)}
										{isRunning && (
											<Badge className="h-5 bg-sky-500/15 text-sky-500 border-sky-500/30 px-1.5 text-[11px] font-normal animate-pulse">
												{t("automation.running")}
											</Badge>
										)}
									</div>
									<p className="text-xs text-muted-foreground line-clamp-1 font-mono">
										{task.prompt}
									</p>
								</div>

								{/* 开关与操作按钮 */}
								<div className="flex items-center gap-2 shrink-0">
									<div className="flex items-center gap-1.5 mr-1">
										<Switch
											checked={task.enabled}
											onCheckedChange={(checked) =>
												handleToggleEnable(task, checked)
											}
											aria-label={
												task.enabled
													? t("automation.enabled")
													: t("automation.disabled")
											}
										/>
									</div>
									<Button
										variant="outline"
										size="sm"
										className="h-7 w-7 p-0"
										disabled={isRunning || isTriggering}
										onClick={() => handleRunNow(task)}
										title={t("automation.runNow")}
									>
										<Play className="size-3.5 text-emerald-500" />
									</Button>
									<Button
										variant="ghost"
										size="sm"
										className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
										onClick={() => onEditTask(task)}
										title={t("automation.editTask")}
									>
										<Edit className="size-3.5" />
									</Button>
									<Button
										variant="ghost"
										size="sm"
										className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
										onClick={() => setDeletingTask(task)}
										title={t("automation.deleteTask")}
									>
										<Trash2 className="size-3.5" />
									</Button>
								</div>
							</div>

							{/* 底部运行元信息 */}
							<div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/30 pt-2 text-[11px] text-muted-foreground">
								<div>
									{task.nextRunAt
										? t("automation.nextRun", {
												time: formatTime(task.nextRunAt),
											})
										: t("automation.manualTrigger")}
								</div>
								{task.lastScheduledAt ? (
									<div className="flex items-center gap-1">
										<span>
											{t("automation.lastRun", {
												time: formatTime(task.lastScheduledAt),
											})}
										</span>
										{latestRun && (
											<span className="inline-flex items-center gap-0.5">
												{latestRun.status === "succeeded" && (
													<CheckCircle2 className="size-3 text-emerald-500" />
												)}
												{(latestRun.status === "failed" ||
													latestRun.status === "timed-out" ||
													latestRun.status === "budget-exhausted" ||
													latestRun.status === "interrupted") && (
													<XCircle className="size-3 text-destructive" />
												)}
												{latestRun.status === "aborted" && (
													<AlertCircle className="size-3 text-amber-500" />
												)}
											</span>
										)}
									</div>
								) : (
									<span>{t("automation.neverRun")}</span>
								)}
							</div>
						</div>
					);
				})}
			</div>

			{/* 删除确认对话框 */}
			{deletingTask && (
				<ConfirmDialog
					title={t("automation.deleteTask")}
					message={t("automation.deleteConfirm", {
						name: deletingTask.name,
					})}
					confirmLabel={t("automation.delete")}
					danger
					onConfirm={handleConfirmDelete}
					onCancel={() => setDeletingTask(null)}
				/>
			)}
		</div>
	);
}
