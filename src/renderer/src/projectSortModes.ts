import type { Project, ProjectSortModeId } from "../../shared/types/project";
import type { SessionRecord } from "../../shared/types/session";
import type { TranslationKey } from "./i18n/rendererCopy.zh-CN";

export const PROJECT_SORT_MODES: readonly { id: ProjectSortModeId; labelKey: TranslationKey }[] = [
	{ id: "manual", labelKey: "app.projectSortMode.manual" },
	{ id: "updatedAt", labelKey: "app.sessionSortMode.updatedAt" },
	{ id: "createdAt", labelKey: "app.sessionSortMode.createdAt" },
	{ id: "title", labelKey: "app.sessionSortMode.title" },
];

type ProjectSessions = Readonly<Record<string, readonly Pick<SessionRecord, "id" | "updatedAt">[]>>;

/** 只排根项目；输入的手动顺序也是置顶组和相同排序值的稳定后备顺序。 */
export function sortSidebarProjects(projects: readonly Project[], sessionsByProject: ProjectSessions, mode: ProjectSortModeId, activityAnchors: Readonly<Record<string, number>> = {}, cachedActivity: Readonly<Record<string, number>> = {}): Project[] {
	const roots = projects.filter((project) => !project.worktreeParentId);
	const activity = new Map<string, number>();
	if (mode === "updatedAt") {
		for (const project of projects) {
			const rootId = project.worktreeParentId ?? project.id;
			let latest = Math.max(activity.get(rootId) ?? 0, project.lastOpenedAt, sessionsByProject[project.id] === undefined ? (cachedActivity[project.id] ?? 0) : 0);
			for (const session of sessionsByProject[project.id] ?? []) latest = Math.max(latest, session.updatedAt, activityAnchors[session.id] ?? 0);
			activity.set(rootId, latest);
		}
	}
	return roots.sort((left, right) => {
		const chat = Number(right.kind === "chat") - Number(left.kind === "chat");
		if (chat) return chat;
		const pinned = Number(Boolean(right.pinned)) - Number(Boolean(left.pinned));
		if (pinned) return pinned;
		if (left.pinned || mode === "manual") return 0;
		if (mode === "title") return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
		if (mode === "createdAt") return (right.createdAt ?? 0) - (left.createdAt ?? 0);
		return (activity.get(right.id) ?? 0) - (activity.get(left.id) ?? 0);
	});
}
