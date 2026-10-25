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
 * 全局拥有的运行时发现来源：pi 全局 settings.json 里的 packages（package-user）与显式路径（settings-user）。
 *
 * 这两类条目的归属就是「用户全局」，与项目无关：全局设置页也必须能看到（此前只有项目作用域渲染发现行，
 * 包提供的技能/提示词在全局页完全不出现）。项目来源（package-project/settings-project/ancestor-agents）
 * 仍只在项目作用域渲染——随项目 settings.json 或祖先目录存在，全局页展示会指向别的项目。
 */
export function isGlobalDiscoverySource(sourceId: string): boolean {
	return sourceId === "package-user" || sourceId === "settings-user";
}

/**
 * discovery 行去重键：来源 + 名称（名称折叠大小写，跨平台目录名差异不产生重复行）。
 *
 * 只按 name 去重会让包/设置提供的条目被本地同名行吞掉：本地行属于自己的目录（pi-global/agents-global/
 * project-*），并不代表包里的那一条，包资源因此在列表上消失。带上 sourceId 后，不同来源的同名条目都保留。
 */
export function discoveryRowKey(sourceId: string | undefined, name: string): string {
	// sourceId 允许缺省：本地提示词模板的 scope 是可选字段，缺省按空来源参与键（不与任何发现来源相等）。
	return `${sourceId ?? ""}\u0000${name.trim().toLowerCase()}`;
}

/**
 * package-project 发现行是否可操作（整包开关 + 卸载）：这类行的 source 就是包源（`npm:<name>` 等），
 * 后端 `setExtensionEnabled` 按 `isPackageSource` 分流到项目层 packages 条目（整包 `!`/`*` delta，
 * 与全局行同一回路）；卸载走 `pi remove <source> -l`。
 * 其余发现行维持只读：package-user 属全局层（全局视图另有入口），settings-* 行无整包语义。
 */
export function isActionableProjectPackageItem(item: { sourceId: string; managed: boolean }): boolean {
	return item.sourceId === "package-project" && item.managed;
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
