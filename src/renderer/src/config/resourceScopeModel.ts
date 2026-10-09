import type { PiExtensionSummary, PiPromptTemplateSummary, PiSkillLocation, PiSkillSummary, ProjectResourceDiscoveryResult, ProjectResourceListResult } from "../../../shared/types";

/** 资源作用域：全局（Pi 用户层）或单个项目（项目资源目录）。 */
export type ResourceScope = "global" | "project";

export const PROJECT_SKILL_SOURCES: ReadonlySet<PiSkillLocation["id"]> = new Set(["project-pi", "project-agents"]);

export const GLOBAL_SKILL_SOURCES: ReadonlySet<PiSkillLocation["id"]> = new Set(["pi-global", "agents-global"]);

export function isProjectSkill(skill: PiSkillSummary): boolean {
	return PROJECT_SKILL_SOURCES.has(skill.sourceId);
}

export function isGlobalSkill(skill: PiSkillSummary): boolean {
	return GLOBAL_SKILL_SOURCES.has(skill.sourceId);
}

export function isProjectExtension(extension: PiExtensionSummary): boolean {
	return extension.scope === "project";
}

export function isProjectPrompt(template: PiPromptTemplateSummary): boolean {
	return template.scope === "project";
}

export function emptyProjectResourceData(): ProjectResourceListResult {
	return {
		skills: [],
		extensions: [],
		skillLocations: [],
		overrides: {
			disabledGlobalExtensions: [],
			disabledGlobalSkills: [],
			disabledGlobalPrompts: [],
		},
	};
}

export function emptyDiscoveryData(): ProjectResourceDiscoveryResult {
	return {
		projectResourcesAllowed: false,
		overrides: { disabledGlobalExtensions: [], disabledGlobalSkills: [], disabledGlobalPrompts: [] },
		skills: [],
		prompts: [],
		extensions: [],
	};
}

/** Discovery rows split into the project group vs the inherited global group. */
export function isProjectDiscoverySource(sourceId: string): boolean {
	return sourceId === "package-project" || sourceId === "settings-project" || sourceId === "ancestor-agents";
}

/**
 * 扩展商店卡片的「已安装」判据集合（项目作用域用）。
 *
 * 项目里安装的包（`pi install -l`）只写进项目 settings.json 的 packages：既不在项目列表
 * （只扫 `<项目>/.pi/extensions` 目录），也不在全局 pi list 结果里，只会以运行时发现条目出现
 * （sourceId `package-project`，source 就是 `npm:<name>` 形态）。漏掉它们会让装完的卡片仍显示
 * 「安装」并再次执行 `pi install -l`。
 * 全局行刻意排除：项目卡片的安装动作是「装进本项目」，全局已装不代表本项目已装。
 */
export function projectInstalledExtensionSources(data: PiExtensionSummary[], discovery: ProjectResourceDiscoveryResult["extensions"]): Set<string> {
	const sources = new Set<string>();
	for (const extension of data) {
		if (extension.scope === "project") sources.add(extension.source);
	}
	for (const item of discovery) {
		if (item.sourceId === "package-project") sources.add(item.source);
	}
	return sources;
}
