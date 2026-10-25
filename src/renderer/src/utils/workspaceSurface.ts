/**
 * 定时任务管理页面的内部路由。
 *
 * 管理界面以会话 Tab 栏里的页面 Tab 呈现（见 AutomationPage），route 只决定页面内部
 * 当前展示哪个视图，与会话选择、Tab / 分屏 chrome 完全解耦。
 */
export type AutomationWorkspaceRoute = { kind: "tasks" } | { kind: "editor"; taskId?: string } | { kind: "history" } | { kind: "settings" };

export const DEFAULT_AUTOMATION_WORKSPACE_ROUTE: AutomationWorkspaceRoute = {
	kind: "tasks",
};
