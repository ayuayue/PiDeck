import { atom } from "jotai";
import type { AutomationRun, AutomationSettings, AutomationSnapshot, AutomationTaskSummary } from "../../../shared/types";
import { closeWorkspacePageAtom, openWorkspacePageAtom, workspacePageTabStateAtom } from "./workspace-page-atoms";

/**
 * 主进程定时任务与自动化快照（含 tasks、runs、settings 与 revision）。
 * null = 尚未获取到初始快照。
 */
export const automationSnapshotAtom = atom<AutomationSnapshot | null>(null);

/** 定时任务页面 Tab 是否打开（页面式工作区，见 workspace-page-atoms）。 */
export const automationPageOpenAtom = atom((get) => get(workspacePageTabStateAtom).tabs.includes("automation"));

/**
 * 页面打开时锁定的项目范围（null = 跨项目总览）。
 * 由 openAutomationPageAtom 在每次打开时写入，关闭后不清（下次打开必然重写）。
 */
export const automationPageProjectIdAtom = atom<string | null>(null);

/**
 * 打开定时任务页面 Tab；传 projectId 时任务表锁定到该项目（项目菜单入口）。
 * 已打开时只激活并刷新范围，不重复建 Tab。
 */
export const openAutomationPageAtom = atom(null, (_get, set, projectId?: string) => {
	set(automationPageProjectIdAtom, projectId ?? null);
	set(openWorkspacePageAtom, "automation");
});

/** 关闭定时任务页面 Tab（页面子树卸载，下一次打开回到任务列表）。 */
export const closeAutomationPageAtom = atom(null, (_get, set) => {
	set(closeWorkspacePageAtom, "automation");
});

/**
 * 当前在管理页面中选中的任务 ID（null = 未选中或处于新建模式）。
 */
export const automationSelectedTaskIdAtom = atom<string | null>(null);

/**
 * 处于新建任务草稿状态。
 */
export const automationIsCreatingTaskAtom = atom<boolean>(false);

/**
 * 所有定义的自动化任务（按创建时间降序，新建的排在最前）。
 *
 * 排序键必须是**创建后不再变化**的字段：早先用 updatedAt 降序，导致任何一次
 * 开关/编辑（updateTask 会 bump updatedAt）都把该卡片顶到列表首位，用户刚点的
 * 那张卡换位、另一张卡占回原位，观感就是「我点了一个，结果另一个被点了」。
 * 定时任务列表是长期停留的看板，顺序稳定比「最近改动优先」重要。
 */
export const automationTasksAtom = atom<AutomationTaskSummary[]>((get) => {
	const snapshot = get(automationSnapshotAtom);
	if (!snapshot) return [];
	return [...snapshot.tasks].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
});

/**
 * 所有执行记录（按排队时间降序）。
 */
export const automationRunsAtom = atom<AutomationRun[]>((get) => {
	const snapshot = get(automationSnapshotAtom);
	if (!snapshot) return [];
	return [...snapshot.runs].sort((a, b) => b.queuedAt - a.queuedAt);
});

/**
 * 正在执行或排队中的运行记录集合。
 */
export const automationActiveRunsAtom = atom<AutomationRun[]>((get) => {
	const runs = get(automationRunsAtom);
	return runs.filter((r) => r.status === "queued" || r.status === "starting" || r.status === "running");
});

/**
 * 正在执行或排队中的任务 ID 集合（用于列表显示运行中动画/指示）。
 */
export const automationRunningTaskIdsAtom = atom<Set<string>>((get) => {
	const active = get(automationActiveRunsAtom);
	return new Set(active.map((r) => r.taskId));
});

/**
 * 定时任务全局设置（并发数与历史保留上限）。
 */
export const automationSettingsAtom = atom<AutomationSettings>((get) => {
	const snapshot = get(automationSnapshotAtom);
	return snapshot?.settings ?? { maxConcurrentRuns: 1, historyLimit: 200 };
});
