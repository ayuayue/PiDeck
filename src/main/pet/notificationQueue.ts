import type { PetNotification } from "../../shared/types/settings";

/**
 * PetSystem 提醒展示队列的纯状态机（与 UI/窗口解耦，可单测）。
 *
 * 语义：
 * - waiting 为持久化提醒：不自动消失，直到 pending 清空收到 null 信号。
 * - error/done 为非持久化提醒：展示 NOTIFICATION_DURATION_MS 后由计时器触发 elapse。
 * - 非持久化提醒展示期间到达的 waiting 排队等待；非持久化覆盖 waiting 时保存 waiting，
 *   计时结束后恢复 —— 保证「等待操作」提示不因错误/完成气泡而永久丢失。
 */

export type NotificationQueueState = {
	/** 当前正在展示的提醒；null 表示无提醒 */
	active: PetNotification | null;
	/** 等待在非持久化提醒结束后恢复展示的 persistent 提醒 */
	queued: PetNotification | null;
};

export const EMPTY_NOTIFICATION_QUEUE: NotificationQueueState = { active: null, queued: null };

/**
 * 处理一条新通知（null = waiting 清空信号）。
 * 返回新状态；调用方按 active 变化决定窗口扩展/收缩与 IPC 推送。
 */
export function nextNotificationQueueState(state: NotificationQueueState, incoming: PetNotification | null): NotificationQueueState {
	// waiting 清空信号：仅正展示 persistent 提醒时收起；非持久化展示中忽略（计时器到点统一收缩）
	if (!incoming) {
		return {
			active: state.active?.persistent ? null : state.active,
			queued: null,
		};
	}
	// waiting 到达且非持久化提醒正在展示：排队等待
	if (incoming.persistent && state.active && !state.active.persistent) {
		return { active: state.active, queued: incoming };
	}
	// 非持久化提醒覆盖正在展示的 waiting：保存 waiting，等其结束后恢复
	if (!incoming.persistent && state.active?.persistent) {
		return { active: incoming, queued: state.active };
	}
	return { active: incoming, queued: null };
}

/** 非持久化提醒计时结束：优先恢复排队中的 waiting，否则回到空状态（收缩窗口） */
export function onNotificationTimerElapse(state: NotificationQueueState): NotificationQueueState {
	if (state.queued) return { active: state.queued, queued: null };
	return { active: null, queued: null };
}
