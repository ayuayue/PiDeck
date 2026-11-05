import type { Project } from "../../../../shared/types";

/**
 * 「把某个项目行揭示到可视区」的导航计划：搜索面板选中项目、新建项目后定位共用。
 *
 * 侧栏三个分段（活动 / 聊天 / 项目）只挂载当前分段，worktree 子项目行又挂在父项目树下，
 * 所以「滚到某行」不是一次 scrollIntoView 能解决的：先切分段，再展开父级与分支行，最后定位。
 * 这里只算「切到哪个分段、先展开哪个父项目」，DOM 定位由 SidebarContent 执行
 * （两帧后按 data-project-row-id 在列表滚动容器内滚动）。
 */
export type SidebarProjectRevealPlan = {
	/** 该行真正会被挂载的分段：内置 Chat 在「聊天」，其余项目在「项目」。 */
	tab: "chats" | "projects";
	/** worktree 子项目：父项目收起时整棵子树都不渲染，必须先展开父项目（父项目不在清单里时为 undefined）。 */
	parentProjectId?: string;
	/** 行锚点 id（data-project-row-id）。 */
	projectId: string;
};

export function planSidebarProjectReveal(project: Project, projects: readonly Project[]): SidebarProjectRevealPlan {
	return {
		tab: project.kind === "chat" ? "chats" : "projects",
		parentProjectId: project.worktreeParentId ? projects.find((candidate) => candidate.id === project.worktreeParentId)?.id : undefined,
		projectId: project.id,
	};
}
