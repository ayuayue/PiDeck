/**
 * Web 端项目展示与「本次要建到哪个项目」的取值规则。
 *
 * 抽出来是为了两处共用同一口径：侧栏项目树（displayProjectName）与「智能体」面板的
 * 目标项目（resolveTargetProjectId）。规则一旦两处各写一份，就会出现「侧栏叫 A、面板叫 B」。
 */
import { t } from "@/i18n";
import type { WebProject } from "./webTypes";

/** 与桌面 ProjectTree 相同的项目目录名展示：chat 项目显示「聊天」，
 *  其余取路径末段；用户重命名过（name 与目录名不同）时优先展示自定义别名。 */
export function displayProjectName(project: WebProject): string {
	if (project.kind === "chat") return t("app.chatProject");
	const normalized = project.path.replace(/\\/g, "/").replace(/\/+$/, "");
	const dirName = normalized.split("/").pop() || "";
	if (!dirName) return project.name || project.path;
	return project.name && project.name !== dirName ? project.name : dirName;
}

/**
 * 目标项目：优先用调用方给的上文（当前会话所属项目），它已不在列表时退回内置对话项目，
 * 再退回第一个项目。没有项目时返回 undefined——调用方据此禁用「使用」而不是建到别处。
 */
export function resolveTargetProjectId(projects: WebProject[], preferred?: string | null): string | undefined {
	if (preferred && projects.some((project) => project.id === preferred)) return preferred;
	return (projects.find((project) => project.kind === "chat") ?? projects[0])?.id;
}
