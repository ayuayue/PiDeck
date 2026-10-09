/**
 * 会话状态面板（右侧边栏下半区）的纯函数：tab 解析、角标、文件变更类型。
 * 无 React/i18n 依赖，node 单测直接加载。
 */
export type SessionStatusTab = "todo" | "files" | "subagents";
export const SESSION_STATUS_TABS: readonly SessionStatusTab[] = ["todo", "files", "subagents"];
export const SESSION_STATUS_TAB_STORAGE_KEY = "pid:session-status-tab-v1";

export function parseSessionStatusTab(raw: unknown): SessionStatusTab {
	return SESSION_STATUS_TABS.find((tab) => tab === raw) ?? "todo";
}

/**
 * 变更类型只能从「最后一次修改有无旧内容」推导（主进程不存完整旧文件）：
 * write/create 无旧内容 = 整文件写入（新建或覆盖，无法区分）；edit/patch = 局部编辑。
 * 与 fileChangeToDiffLines 的 hasOld 判定同口径。
 */
export type FileChangeKind = "write" | "edit";

export function fileChangeKind(entry: { originalContent: string }): FileChangeKind {
	return entry.originalContent.length > 0 ? "edit" : "write";
}

/** 待办 tab 角标「已完成/总数」；空列表不显示。 */
export function todoProgressBadge(items: readonly { status?: string }[]): string | null {
	if (items.length === 0) return null;
	const done = items.filter((item) => item.status === "completed").length;
	return `${done}/${items.length}`;
}
