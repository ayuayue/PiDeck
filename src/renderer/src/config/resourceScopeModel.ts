import type { PiExtensionSummary, PiPromptTemplateSummary, PiSkillLocation, PiSkillSummary, ProjectResourceDiscoveryResult, ProjectResourceListResult } from "../../../shared/types";

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
