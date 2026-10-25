import type { PiSkillSummary, ProjectResourceDiscoveryResult } from "./types";

/**
 * 技能目录共享层（Phase 2）：pi 与 DSH 共用同一份数据模型与合并规则。
 *
 * 为什么放 shared：pi 的技能来源是「项目资源 + 全局技能 + 资源发现/禁用覆盖」
 * （主进程现有 provider，含用户开关与 override，不能自己另扫一份），DSH 的来源是
 * 「文件系统扫描 + host 权威列表」。两边的来源不同，但「同名去重、项目优先、
 * 结果排序、条目结构」是同一套产品规则——收口到这里，渲染层与主进程不再各写一份。
 */

/** 技能选择面板的统一条目（pi 项目/全局 + DSH 本地/宿主技能都映射到它）。 */
export type SkillCatalogEntry = {
	/** 调用名（不含前导斜杠；pi 与 DSH 都已是 kebab-case）。 */
	name: string;
	description: string;
	whenToUse?: string;
	/** false = 用户专用技能（pi 的 disable-model-invocation）：仅用户可调用。 */
	userOnly?: boolean;
	/** 来源归属：项目/全局（pi 用于徽标区分；DSH 可缺省）。 */
	source?: "project" | "global";
	/** 来源标识（disabledGlobalSkills 覆盖键、去重 identity）。 */
	sourceId?: string;
	/** 来源展示名（徽标 title）。 */
	sourceLabel?: string;
	/** SKILL.md 绝对路径（pi 可读正文/插入；DSH 由宿主管理，无正文通道）。 */
	path?: string;
};

/** pi 三路来源：与主进程 projectResources/skills 现有 IPC 返回值同形状。 */
export type PiSkillCatalogInput = {
	/** projectResources.list(projectId).skills（未取项目时传空数组）。 */
	projectSkills: readonly PiSkillSummary[];
	/** skills.list().skills（全局技能）。 */
	globalSkills: readonly PiSkillSummary[];
	/** projectResources.discovery(projectId)。 */
	discovery: ProjectResourceDiscoveryResult;
};

/** projectResources:discovery 请求失败时的空兜底（与渲染层旧实现同一形状）。 */
export function emptyProjectResourceDiscovery(): ProjectResourceDiscoveryResult {
	return { projectResourcesAllowed: false, overrides: { disabledGlobalExtensions: [], disabledGlobalSkills: [], disabledGlobalPrompts: [] }, skills: [], prompts: [], extensions: [] };
}

/**
 * 技能列表并集：primary 优先，fallback 只补 primary 里没有的名字。
 * 用于 DSH「host 权威结果 ∪ 文件系统扫描」——host 的 preset/插件技能不会被扫描覆盖。
 */
export function mergeSkillCatalog<T extends { name: string }>(primary: readonly T[], fallback: readonly T[]): T[] {
	const seen = new Set(primary.map((skill) => skill.name.toLowerCase()));
	const merged = [...primary];
	for (const skill of fallback) {
		const key = skill.name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(skill);
	}
	return merged.sort((a, b) => a.name.localeCompare(b.name));
}

/** 发现来源的项目/全局归属判定（与渲染层旧 mapDiscoveredSkill 同一口径）。 */
function discoveredSkillSource(sourceId: string): "project" | "global" {
	return sourceId === "settings-project" || sourceId === "package-project" || sourceId === "ancestor-agents" ? "project" : "global";
}

function toEntry(skill: PiSkillSummary, source: "project" | "global"): SkillCatalogEntry {
	return {
		name: skill.name,
		description: skill.description,
		userOnly: skill.userOnly,
		source,
		sourceId: skill.sourceId,
		sourceLabel: skill.sourceLabel,
		path: skill.path,
	};
}

/**
 * pi 技能目录合并（渲染层旧逻辑的等价收口）：
 * - projectResourcesAllowed=false 时项目技能整体不可用，但全局技能仍可选；
 * - 全局技能受各项目 disabledGlobalSkills 覆盖过滤（键 = sourceId:name 小写）；
 * - 同名去重优先级：项目直接目录 > 项目发现项 > 全局直接目录 > 全局发现项；
 * - 最终按 name 排序，便于选择器稳定展示。
 */
export function mergePiSkillCatalog(input: PiSkillCatalogInput): SkillCatalogEntry[] {
	const projectResourcesAllowed = input.discovery.projectResourcesAllowed;
	const disabledInheritedSkills = new Set(input.discovery.overrides.disabledGlobalSkills);
	const visibleProjectSkills = projectResourcesAllowed ? input.projectSkills.filter((skill) => skill.enabled).map((skill) => toEntry(skill, "project")) : [];
	const visibleGlobalSkills = input.globalSkills.filter((skill) => skill.enabled && !disabledInheritedSkills.has(skill.sourceId + ":" + skill.name.toLowerCase())).map((skill) => toEntry(skill, "global"));
	const discoveredSkills: SkillCatalogEntry[] = input.discovery.skills
		.filter((skill) => skill.enabled)
		.map((skill) => ({
			name: skill.name,
			description: skill.description,
			userOnly: skill.userOnly,
			source: discoveredSkillSource(skill.sourceId),
			sourceId: skill.sourceId,
			sourceLabel: skill.sourceLabel,
		}));
	const discoveredProjectSkills = discoveredSkills.filter((skill) => skill.source === "project");
	const discoveredGlobalSkills = discoveredSkills.filter((skill) => skill.source === "global");

	const seen = new Map<string, SkillCatalogEntry>();
	for (const skill of [...visibleProjectSkills, ...discoveredProjectSkills, ...visibleGlobalSkills, ...discoveredGlobalSkills]) {
		const key = skill.name.toLowerCase();
		const previous = seen.get(key);
		// 同名时项目来源覆盖全局来源；同来源保持先到先得（项目直接目录 > 发现项）。
		if (!previous || (skill.source === "project" && previous.source === "global")) seen.set(key, skill);
	}
	return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}
