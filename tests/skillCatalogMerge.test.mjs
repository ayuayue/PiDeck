/**
 * 技能目录共享层（Phase 2）：pi 三路来源合并 + DSH 并集。
 *
 * 这里锁的是一套跨后端一致的产品规则：
 * - pi：项目资源 > 全局技能；资源发现项按 sourceId 归组；disabledGlobalSkills override 过滤；
 * - 同名去重项目优先；结果按 name 稳定排序；
 * - DSH：host 权威结果优先，扫描只补缺（不会用扫描覆盖 host 的 preset/插件技能）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const shared = loadTsCommonJs("src/shared/skillCatalog.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

const skill = (overrides = {}) => ({
	id: "id",
	name: "skill",
	description: "desc",
	path: "/skills/skill/SKILL.md",
	dir: "/skills/skill",
	sourceId: "pi-global",
	sourceLabel: "~/.pi/agent/skills",
	type: "directory",
	userOnly: false,
	enabled: true,
	valid: true,
	warnings: [],
	...overrides,
});

const discovery = (overrides = {}) => ({
	projectResourcesAllowed: true,
	overrides: { disabledGlobalExtensions: [], disabledGlobalSkills: [], disabledGlobalPrompts: [] },
	skills: [],
	prompts: [],
	extensions: [],
	...overrides,
});

test("mergePiSkillCatalog：项目直接目录 + 全局 + 发现项合并，项目优先、全局被 override 过滤", () => {
	const merged = shared.mergePiSkillCatalog({
		projectSkills: [skill({ name: "project-skill", sourceId: "settings-project" }), skill({ name: "disabled-project", enabled: false })],
		globalSkills: [skill({ name: "global-skill" }), skill({ name: "blocked-global", sourceId: "agents-global" }), skill({ name: "project-skill", description: "global duplicate", sourceId: "agents-global" })],
		discovery: discovery({
			overrides: { disabledGlobalExtensions: [], disabledGlobalSkills: ["agents-global:blocked-global"], disabledGlobalPrompts: [] },
			skills: [skill({ name: "discovered-project", sourceId: "ancestor-agents", sourceLabel: ".agents/skills" }), skill({ name: "discovered-global", sourceId: "user-agents", sourceLabel: "~/.agents/skills" })],
		}),
	});
	assert.deepEqual(plain(merged.map((entry) => [entry.name, entry.source, entry.sourceLabel, Boolean(entry.path)])), [
		["discovered-global", "global", "~/.agents/skills", false],
		["discovered-project", "project", ".agents/skills", false],
		["global-skill", "global", "~/.pi/agent/skills", true],
		["project-skill", "project", "~/.pi/agent/skills", true],
	]);
});

test("mergePiSkillCatalog：projectResourcesAllowed=false 时项目技能整体不可用，全局仍可选", () => {
	const merged = shared.mergePiSkillCatalog({
		projectSkills: [skill({ name: "project-skill", sourceId: "settings-project" })],
		globalSkills: [skill({ name: "global-skill" })],
		discovery: discovery({ projectResourcesAllowed: false }),
	});
	assert.deepEqual(plain(merged.map((entry) => entry.name)), ["global-skill"]);
});

test("mergePiSkillCatalog：同名去重项目优先（项目直接目录 > 发现项 > 全局直接目录 > 全局发现项）", () => {
	const merged = shared.mergePiSkillCatalog({
		projectSkills: [skill({ name: "dup", description: "project-direct", sourceId: "settings-project" })],
		globalSkills: [skill({ name: "dup", description: "global-direct", sourceId: "agents-global" })],
		discovery: discovery({
			skills: [skill({ name: "dup", description: "discovered-project", sourceId: "ancestor-agents" }), skill({ name: "dup", description: "discovered-global", sourceId: "user-agents" })],
		}),
	});
	assert.deepEqual(plain(merged.map((entry) => [entry.name, entry.description, entry.source])), [["dup", "project-direct", "project"]]);
});

test("mergePiSkillCatalog：只有发现项时也能命中同名（归组正确）", () => {
	const merged = shared.mergePiSkillCatalog({
		projectSkills: [],
		globalSkills: [],
		discovery: discovery({ skills: [skill({ name: "from-agents", sourceId: "ancestor-agents", userOnly: true })] }),
	});
	assert.deepEqual(plain(merged.map((entry) => [entry.name, entry.source, entry.userOnly])), [["from-agents", "project", true]]);
});

test("mergeSkillCatalog：host 结果优先，扫描只补缺，结果按 name 排序", () => {
	const host = [
		{ name: "beta", description: "host" },
		{ name: "alpha", description: "host alpha" },
	];
	const scanned = [
		{ name: "Alpha", description: "fs alpha" },
		{ name: "gamma", description: "fs gamma" },
	];
	const merged = shared.mergeSkillCatalog(host, scanned);
	assert.deepEqual(plain(merged.map((entry) => [entry.name, entry.description])), [
		["alpha", "host alpha"],
		["beta", "host"],
		["gamma", "fs gamma"],
	]);
});

test("emptyProjectResourceDiscovery：与渲染层旧兜底同形状", () => {
	const empty = shared.emptyProjectResourceDiscovery();
	assert.deepEqual(plain(empty), {
		projectResourcesAllowed: false,
		overrides: { disabledGlobalExtensions: [], disabledGlobalSkills: [], disabledGlobalPrompts: [] },
		skills: [],
		prompts: [],
		extensions: [],
	});
});

test("接线契约：技能选择器 pi 分支走共享 merge（不再各写一份）", () => {
	const picker = readFileSync(new URL("../src/renderer/src/components/session/ComposerSkillPicker.tsx", import.meta.url), "utf8");
	assert.match(picker, /import \{[^}]*mergePiSkillCatalog[^}]*\} from "\.\.\/\.\.\/\.\.\/\.\.\/shared\/skillCatalog"/);
	assert.match(picker, /mergePiSkillCatalog\(\{ projectSkills, globalSkills, discovery \}\)/);
});
