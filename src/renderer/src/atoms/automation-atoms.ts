import { atom } from "jotai";
import type {
	AutomationRun,
	AutomationSettings,
	AutomationSnapshot,
	AutomationTaskSummary,
} from "../../../shared/types";

/**
 * 主进程定时任务与自动化快照（含 tasks、runs、settings 与 revision）。
 * null = 尚未获取到初始快照。
 */
export const automationSnapshotAtom = atom<AutomationSnapshot | null>(null);

/**
 * 定时任务管理弹窗显隐状态。
 */
export const automationModalOpenAtom = atom<boolean>(false);

/**
 * 当前在管理弹窗中选中的任务 ID（null = 未选中或处于新建模式）。
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
	return [...snapshot.tasks].sort(
		(a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
	);
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
	return runs.filter(
		(r) =>
			r.status === "queued" ||
			r.status === "starting" ||
			r.status === "running",
	);
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
