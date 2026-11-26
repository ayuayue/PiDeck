import type { PiPromptTemplateListResult } from "../../shared/types";

/**
 * `prompts:list-by-project` 的实现。
 *
 * chat 项目（会话工作区）没有项目级提示词：这是**读取**，语义是空集，不是错误。
 * 本类里已有两处同口径：`ProjectResourceManager.list()` 返回空列表、
 * `collectProjectRules()` 返回 [] —— 抛错会让前端整个资源面板失败。
 *
 * 为什么不用 `projectAllowsResources` 提前判：那需要 project 对象，而 IPC 层只拿得到
 * `ProjectResourceManager` 的公开方法（`getProject` 是 private）。因此这里按「写路径守卫
 * 拒绝时抛什么」来识别：只把 chat 那一条错误转成空集，其余错误照原样抛。
 *
 * 反例（2026-11-26 真机）：原实现直接调 `getProjectRoot()`，chat 项目上每次调用都抛
 * `mainProjectResource.chatUnsupported`，配置页一打开 Prompts 标签，主进程日志刷满同一堆栈。
 */
export async function listProjectPrompts(
	deps: {
		projectResourceManager: { getProjectRoot(projectId: string): string };
		promptManager: { listByProject(projectPath: string, projectId?: string): Promise<PiPromptTemplateListResult> };
		/** 写路径守卫拒绝 chat 项目时用的那条文案（与 i18n 同源，比较用）。 */
		chatUnsupportedMessage: string;
	},
	projectId: unknown,
): Promise<PiPromptTemplateListResult> {
	if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 256) throw new Error("Invalid project id.");
	const id = projectId.trim();
	try {
		return await deps.promptManager.listByProject(deps.projectResourceManager.getProjectRoot(id), id);
	} catch (error) {
		// 只兜 chat 这一条：别的错误（文件不可读、路径越界）必须照原样抛，不能被静默吞成空集。
		if (error instanceof Error && error.message === deps.chatUnsupportedMessage) return { templates: [], globalDir: "" };
		throw error;
	}
}
