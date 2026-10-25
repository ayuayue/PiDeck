import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const read = (path) => readFileSync(path, "utf8");
const scopeModel = loadTsCommonJs("src/renderer/src/config/resourceScopeModel.ts");

/** discovery 来源枚举（见 src/main/resourceDiscovery.ts 的 ResourceDiscoverySourceId）。 */
const GLOBAL_DISCOVERY_SOURCES = ["package-user", "settings-user"];
const PROJECT_DISCOVERY_SOURCES = ["package-project", "settings-project", "ancestor-agents"];
/** 本地管理目录（不是运行时发现来源）：两种 discovery 判定都必须为 false。 */
const LOCAL_DIRECTORY_SOURCES = ["pi-global", "agents-global", "project-pi", "project-agents", ""];

/** 取源码里某个顶层函数的整块（到下一个顶层 function/export function 为止）。 */
function functionBlock(source, name) {
	const start = source.search(new RegExp(`^function\\s+${name}\\(`, "m"));
	assert.ok(start >= 0, `源码里未找到函数 ${name}`);
	const rest = source.slice(start);
	// 从函数体内部再找下一个顶层函数声明（跨行，必须带 m 标志）
	const next = rest.slice(1).search(/^(?:export\s+)?function\s/m);
	return next >= 0 ? rest.slice(0, next + 1) : rest;
}

test("isGlobalDiscoverySource 只认 package-user/settings-user", () => {
	for (const sourceId of GLOBAL_DISCOVERY_SOURCES) {
		assert.equal(scopeModel.isGlobalDiscoverySource(sourceId), true, `${sourceId} 是全局拥有的发现来源，全局设置页必须可见`);
	}
	for (const sourceId of [...PROJECT_DISCOVERY_SOURCES, ...LOCAL_DIRECTORY_SOURCES]) {
		assert.equal(scopeModel.isGlobalDiscoverySource(sourceId), false, `${sourceId} 不属于全局发现来源`);
	}
});

test("isProjectDiscoverySource 语义保持不变（project 来源仍与全局来源互斥）", () => {
	for (const sourceId of PROJECT_DISCOVERY_SOURCES) {
		assert.equal(scopeModel.isProjectDiscoverySource(sourceId), true, `${sourceId} 仍属项目发现来源`);
	}
	for (const sourceId of [...GLOBAL_DISCOVERY_SOURCES, ...LOCAL_DIRECTORY_SOURCES]) {
		assert.equal(scopeModel.isProjectDiscoverySource(sourceId), false, `${sourceId} 不得被判成项目发现来源`);
	}
});

test("两种 discovery 判定覆盖主进程全部已知来源（新增来源必须显式归类）", () => {
	// 渲染层按这两个纯函数分流作用域：resourceDiscovery 新增 sourceId 却没归类时，该来源会从列表里静默消失。
	const mainSource = read("src/main/resourceDiscovery.ts");
	const union = /export type ResourceDiscoverySourceId = ([^;]+);/.exec(mainSource);
	assert.ok(union, "未找到 ResourceDiscoverySourceId 联合类型");
	const sourceIds = [...union[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
	assert.ok(sourceIds.length >= GLOBAL_DISCOVERY_SOURCES.length + PROJECT_DISCOVERY_SOURCES.length, "来源枚举数量异常");
	for (const sourceId of sourceIds) {
		const isGlobal = scopeModel.isGlobalDiscoverySource(sourceId);
		const isProject = scopeModel.isProjectDiscoverySource(sourceId);
		assert.notEqual(isGlobal, isProject, `${sourceId} 必须且只能归入全局/项目一侧`);
	}
});

test("discoveryRowKey 由 sourceId + name 组成：跨来源同名不折叠、同来源大小写折叠", () => {
	assert.equal(scopeModel.discoveryRowKey("package-user", "Todo"), scopeModel.discoveryRowKey("package-user", "  todo "), "同一来源的同一名称（大小写/空白差异）仍是一条");
	assert.notEqual(scopeModel.discoveryRowKey("package-user", "todo"), scopeModel.discoveryRowKey("settings-user", "todo"), "不同来源的同名条目必须是两条，否则包资源被设置项吞掉");
	assert.notEqual(scopeModel.discoveryRowKey("package-user", "todo"), scopeModel.discoveryRowKey("package-user", "todo-two"), "名称不同不能折叠");
	assert.ok(scopeModel.discoveryRowKey("package-user", "todo").includes("package-user"), "键必须包含 sourceId");
	// 本地行（目录来源）与包来源同名的键不同：去重不再让本地行吞掉包提供的条目
	assert.notEqual(scopeModel.discoveryRowKey("pi-global", "todo"), scopeModel.discoveryRowKey("package-user", "todo"));
});

test("SkillsTab 在全局作用域渲染全局拥有的 discovery 行，项目来源仍只在项目作用域", () => {
	const skills = read("src/renderer/src/config/SkillsTab.tsx");
	// 判定收口在 resourceScopeModel 的纯函数里，组件不得再自带一份 sourceId 字面量副本
	assert.match(skills, /^[\t ]*import\s*\{[^}]*\bisGlobalDiscoverySource\b[^}]*\}\s*from\s*"\.\/resourceScopeModel";/m);
	assert.doesNotMatch(skills, /^function\s+isProjectDiscoverySource\s*\(/m, "SkillsTab 不得再重复定义 isProjectDiscoverySource");
	// 分组：全局拥有 = isGlobalDiscoverySource；项目 = isProjectDiscoverySource
	assert.match(skills, /^[\t ]*const\s+globalDiscoverySkills\s*=\s*uniqueDiscoverySkills\.filter\(\s*\(item\)\s*=>\s*isGlobalDiscoverySource\(\s*item\.sourceId\s*\)\s*\);$/m);
	assert.match(skills, /^[\t ]*const\s+projectDiscoverySkills\s*=\s*uniqueDiscoverySkills\.filter\(\s*\(item\)\s*=>\s*isProjectDiscoverySource\(\s*item\.sourceId\s*\)\s*\);$/m);
	// 全局作用域可见集合 = 全局来源（这一行是「全局页看得见包资源」的判定本体）
	assert.match(skills, /^[\t ]*const\s+visibleDiscoverySkills\s*=\s*props\.scope\s*===\s*"project"\s*\?\s*uniqueDiscoverySkills\s*:\s*globalDiscoverySkills;$/m);
	// 渲染：全局发现行不带 scope 门禁（项目/全局都渲染），项目发现行仍限定 project
	assert.match(skills, /^[\t ]*\{globalDiscoverySkills\.map\(/m, "全局发现行必须在两种作用域都渲染");
	assert.match(skills, /^[\t ]*\{props\.scope\s*===\s*"project"\s*&&\s*projectDiscoverySkills\.map\(/m, "项目发现行仍只在项目作用域渲染");
	assert.doesNotMatch(skills, /uniqueDiscoverySkills\.filter\(\s*\(item\)\s*=>\s*!isProjectDiscoverySource/, "旧的「非项目来源」内联过滤会吞掉全局页的行");
	// 空态/计数把发现行算进去：只有包资源的全局页不能显示空态并隐藏表格
	assert.match(skills, /^[\t ]*const\s+skillRowCount\s*=\s*visibleSkills\.length\s*\+\s*visibleDiscoverySkills\.length;$/m);
	assert.match(skills, /\{\s*skillRowCount\s*===\s*0\s*\?\s*\(/);
	assert.match(skills, /\{\s*t\("config\.count\.skills",\s*\{\s*count:\s*skillRowCount\s*\}\s*\)\s*\}/);
	assert.doesNotMatch(skills, /visibleSkills\.length === 0/);
	// 去重键带 sourceId（本地行集合与发现行比较同一组合键）
	assert.match(skills, /localSkillKeys\s*\.has\(\s*discoveryRowKey\(\s*item\.sourceId,\s*item\.name\s*\)\s*\)/);
	assert.doesNotMatch(skills, /localSkillNames|item\.name\.toLowerCase\(\)\)\)/, "不得回退到只按 name 去重");
});

test("PromptsTab 在全局作用域渲染全局拥有的 discovery 行，项目来源仍只在项目作用域", () => {
	const prompts = read("src/renderer/src/config/PromptsTab.tsx");
	assert.match(prompts, /^[\t ]*import\s*\{[^}]*\bisGlobalDiscoverySource\b[^}]*\}\s*from\s*"\.\/resourceScopeModel";/m);
	assert.match(prompts, /^[\t ]*const\s+globalDiscoveryPrompts\s*=\s*uniqueDiscoveryPrompts\.filter\(\s*\(item\)\s*=>\s*isGlobalDiscoverySource\(\s*item\.sourceId\s*\)\s*\);$/m);
	assert.match(prompts, /^[\t ]*const\s+projectDiscoveryPrompts\s*=\s*uniqueDiscoveryPrompts\.filter\(\s*\(item\)\s*=>\s*isProjectDiscoverySource\(\s*item\.sourceId\s*\)\s*\);$/m);
	assert.match(prompts, /^[\t ]*const\s+visibleDiscoveryPrompts\s*=\s*props\.scope\s*===\s*"project"\s*\?\s*uniqueDiscoveryPrompts\s*:\s*globalDiscoveryPrompts;$/m);
	assert.match(prompts, /^[\t ]*\{globalDiscoveryPrompts\.map\(/m, "全局发现行必须在两种作用域都渲染");
	assert.match(prompts, /^[\t ]*\{props\.scope\s*===\s*"project"\s*&&\s*projectDiscoveryPrompts\.map\(/m, "项目发现行仍只在项目作用域渲染");
	assert.doesNotMatch(prompts, /uniqueDiscoveryPrompts\.filter\(\s*\(item\)\s*=>\s*!isProjectDiscoverySource/, "旧的「非项目来源」内联过滤会吞掉全局页的行");
	assert.match(prompts, /^[\t ]*const\s+visibleTemplateCount\s*=\s*visibleTemplates\.length\s*\+\s*visibleDiscoveryPrompts\.length;$/m);
	assert.match(prompts, /\{\s*visibleTemplateCount\s*===\s*0\s*\?\s*\(/);
	assert.match(prompts, /localPromptKeys\s*\.has\(\s*discoveryRowKey\(\s*item\.sourceId,\s*item\.name\s*\)\s*\)/);
	assert.doesNotMatch(prompts, /localPromptNames|item\.name\.toLowerCase\(\)\)\)/, "不得回退到只按 name 去重");
	// 本地模板没有 sourceId，用 scope 作来源维度，键仍由 discoveryRowKey 统一生成
	assert.match(prompts, /localPromptKeys\s*=\s*new Set\(\s*visibleTemplates\.map\(\s*\(template\)\s*=>\s*discoveryRowKey\(\s*template\.scope,\s*template\.name\s*\)\s*\)\s*\)/);
});

test("全局 discovery 行保持只读：行组件不含编辑/重命名/删除/启停入口", () => {
	const skillsRow = functionBlock(read("src/renderer/src/config/SkillsTab.tsx"), "DiscoveredSkillRow");
	const promptsRow = functionBlock(read("src/renderer/src/config/PromptsTab.tsx"), "DiscoveredPromptRow");
	for (const [label, block] of [
		["DiscoveredSkillRow", skillsRow],
		["DiscoveredPromptRow", promptsRow],
	]) {
		assert.doesNotMatch(block, /onEdit|onRename|onDelete|<Pencil|<Trash2|<FileEdit|<Switch|<Input\b|<Textarea\b/, `${label} 是托管只读行，不得挂编辑/重命名/删除/启停入口`);
	}
	// 只读语义对用户可见：托管徽标/说明沿用既有 key
	assert.match(skillsRow, /config\.resourceManagedHint/);
	assert.match(promptsRow, /config\.resourceManagedHint/);
	assert.match(promptsRow, /config\.resourceManaged/);
});

test("ConfigModal 三处 discovery 调用都总是请求（无项目时传 undefined）", () => {
	const modal = read("src/renderer/src/ConfigModal.tsx");
	const calls = modal.match(/api\.projectResources\.discovery\(\s*projectIdHere\s*\)/g) ?? [];
	assert.equal(calls.length, 3, "技能/提示词/扩展三处刷新都必须请求 discovery");
	assert.doesNotMatch(modal, /Promise\.resolve\(\s*emptyDiscoveryData\(\)\s*\)/, "不得再用空数据短路 discovery");
	assert.doesNotMatch(modal, /projectIdHere\s*&&\s*hasProject\s*\?\s*api\.projectResources\.discovery/, "全局作用域也必须发起 discovery 请求");
	// 无项目时 projectId 传 undefined：取值为 resourceScope === "project" ? effectiveProjectId : undefined
	assert.match(modal, /^[\t ]*const\s+projectIdHere\s*=\s*resourceScope\s*===\s*"project"\s*\?\s*effectiveProjectId\s*:\s*undefined;$/m);
});

test("全局 discovery 分组标题在 zh-CN/en-US 同步，zh-TW 为生成物且已重生成", () => {
	const copies = ["rendererCopy.zh-CN.ts", "rendererCopy.en-US.ts", "rendererCopy.zh-TW.ts"].map((file) => [file, read(`src/renderer/src/i18n/${file}`)]);
	for (const [file, copy] of copies) {
		assert.match(copy, /^[\t ]*"config\.resourceGroup\.discovered":\s*".+",$/m, `${file} 缺少全局 discovery 分组标题`);
	}
	// zh-TW 是生成物：头部指纹与同批生成的其它 zh-TW 词典格式一致（改 zh-CN 后必须重跑脚本）
	assert.match(copies[2][1], /\* source-sha256: [0-9a-f]{64}/, "zh-TW 必须是 genZhTwCopy 生成产物");
});
