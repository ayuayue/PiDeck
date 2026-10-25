/**
 * 会话状态面板（右侧边栏下半区）的纯函数：tab 解析与待办角标。
 * 无 React/i18n 依赖，node 单测直接加载。
 *
 * 2027-02 移除 files tab：文件修改已改为每轮末尾的 chip 行（turn/TurnFileChanges），
 * 它在轮次内就能看到且可点开，右侧再挂一份会话级列表属于重复入口。
 */
export type SessionStatusTab = "todo" | "subagents";
export const SESSION_STATUS_TABS: readonly SessionStatusTab[] = ["todo", "subagents"];
export const SESSION_STATUS_TAB_STORAGE_KEY = "pid:session-status-tab-v1";

export function parseSessionStatusTab(raw: unknown): SessionStatusTab {
	return SESSION_STATUS_TABS.find((tab) => tab === raw) ?? "todo";
}

/** 待办 tab 角标「已完成/总数」；空列表不显示。 */
export function todoProgressBadge(items: readonly { status?: string }[]): string | null {
	if (items.length === 0) return null;
	const done = items.filter((item) => item.status === "completed").length;
	return `${done}/${items.length}`;
}
