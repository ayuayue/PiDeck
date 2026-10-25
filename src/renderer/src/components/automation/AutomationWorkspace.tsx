import { useEffect } from "react";
import { useAtomValue } from "jotai";
import { Clock, History, ListFilter, PlayCircle, Plus, Sliders } from "lucide-react";
import { automationActiveRunsAtom, automationTasksAtom } from "../../atoms/automation-atoms";
import { projectInventoryAtom } from "../../atoms/project-atoms";
import { t } from "../../i18n";
import type { AutomationWorkspaceRoute } from "../../utils/workspaceSurface";
import { Badge } from "../ui-shadcn/badge";
import { Button } from "../ui-shadcn/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui-shadcn/tabs";
import { AutomationHistoryList } from "./AutomationHistoryList";
import { AutomationSettingsTab } from "./AutomationSettingsTab";
import { AutomationTaskEditor } from "./AutomationTaskEditor";
import { AutomationTaskList } from "./AutomationTaskList";
import type { AutomationTask } from "../../../../shared/types";

interface AutomationWorkspaceProps {
	route: AutomationWorkspaceRoute;
	/** Omit for the cross-project overview; project menus pass an explicit owner id. */
	projectId?: string;
	onRouteChange: (route: AutomationWorkspaceRoute) => void;
	/** 点击执行记录关联会话时，由宿主切换项目并打开常驻会话 Tab。 */
	onViewSession: (projectId: string, sessionId: string) => void;
}

/**
 * 定时任务管理界面（页面内路由 + 头部），由会话 Tab 栏里的页面 Tab 承载。
 *
 * 它保留自己的 route state：切到会话只是让页面失活（Tab 仍打开），
 * 关闭页面 Tab 不会暂停任务，也不会改变当前会话。
 */
export function AutomationWorkspace(props: AutomationWorkspaceProps) {
	const activeRuns = useAtomValue(automationActiveRunsAtom);
	const tasks = useAtomValue(automationTasksAtom);
	const scopedActiveRuns = props.projectId ? activeRuns.filter((run) => run.projectId === props.projectId) : activeRuns;
	const scopedTasks = props.projectId ? tasks.filter((task) => task.projectId === props.projectId) : tasks;
	const projects = useAtomValue(projectInventoryAtom);
	const route = props.route;
	const scopedProject = props.projectId ? projects.find((project) => project.id === props.projectId) : undefined;
	const scopeTitle = props.projectId ? t("automation.projectTitle", { project: scopedProject?.name ?? props.projectId }) : t("automation.allProjectsTitle");
	const editingTaskId = route.kind === "editor" ? route.taskId : undefined;
	const editingTask = editingTaskId ? (tasks.find((task) => task.id === editingTaskId) ?? null) : null;

	// A deleted task must not leave the editor pointing at a stale task id. Returning to
	// the task list is safer than silently turning an edit into a new-task form.
	useEffect(() => {
		if (route.kind === "editor" && route.taskId && !editingTask) {
			props.onRouteChange({ kind: "tasks" });
		}
	}, [editingTask, editingTaskId, props.onRouteChange, route.kind]);

	const activeTab = route.kind;
	const handleTabChange = (value: string) => {
		if (value === "tasks" || value === "history" || (!props.projectId && value === "settings")) {
			props.onRouteChange({ kind: value });
		}
	};
	const openCreate = () => props.onRouteChange({ kind: "editor" });
	const openEdit = (task: AutomationTask) => {
		props.onRouteChange({ kind: "editor", taskId: task.id });
	};
	const returnToTasks = () => props.onRouteChange({ kind: "tasks" });

	return (
		<section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
			<header className="flex shrink-0 items-center justify-between gap-4 border-b border-border/40 px-5 py-3">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<Clock className="size-5 shrink-0 text-[var(--color-accent)]" />
						<h1 className="truncate text-base font-semibold text-foreground">{scopeTitle}</h1>
						{scopedActiveRuns.length > 0 && (
							<Badge variant="info" size="sm" className="gap-1 animate-pulse">
								<PlayCircle className="size-3" />
								{t("automation.running")} ({scopedActiveRuns.length})
							</Badge>
						)}
					</div>
					<p className="mt-1 truncate text-xs text-muted-foreground">{props.projectId ? t("automation.projectSubtitle") : t("automation.subtitle")}</p>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{activeTab === "tasks" && scopedTasks.length > 0 && (
						<Button size="sm" className="h-8 gap-1.5 text-xs" onClick={openCreate}>
							<Plus className="size-3.5" />
							{t("automation.createTask")}
						</Button>
					)}
				</div>
			</header>

			<Tabs value={activeTab} onValueChange={handleTabChange} className="flex min-h-0 flex-1 flex-col gap-3 px-5 pb-5 pt-3">
				<TabsList className="w-auto self-start">
					<TabsTrigger value="tasks" className="gap-1.5">
						<ListFilter className="size-3.5" />
						{t("automation.tasksTab")}
					</TabsTrigger>
					<TabsTrigger value="history" className="gap-1.5">
						<History className="size-3.5" />
						{t("automation.historyTab")}
					</TabsTrigger>
					{!props.projectId && (
						<TabsTrigger value="settings" className="gap-1.5">
							<Sliders className="size-3.5" />
							{t("automation.settingsTab")}
						</TabsTrigger>
					)}
					{activeTab === "editor" && (
						<TabsTrigger value="editor" className="gap-1.5">
							{editingTask ? t("automation.editTask") : t("automation.createTask")}
						</TabsTrigger>
					)}
				</TabsList>

				<div className="min-h-0 flex-1 overflow-y-auto pr-1">
					<TabsContent value="tasks" className="m-0 focus-visible:outline-none">
						<AutomationTaskList projectId={props.projectId} onEditTask={openEdit} onCreateTask={openCreate} />
					</TabsContent>
					<TabsContent value="editor" className="m-0 focus-visible:outline-none">
						<AutomationTaskEditor key={editingTask?.id ?? "new"} task={editingTask} defaultProjectId={props.projectId} lockProject={Boolean(props.projectId)} onSave={returnToTasks} onCancel={returnToTasks} />
					</TabsContent>
					<TabsContent value="history" className="m-0 focus-visible:outline-none">
						<AutomationHistoryList projectId={props.projectId} onViewSession={props.onViewSession} />
					</TabsContent>
					{!props.projectId && (
						<TabsContent value="settings" className="m-0 focus-visible:outline-none">
							<AutomationSettingsTab />
						</TabsContent>
					)}
				</div>
			</Tabs>
		</section>
	);
}
