import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

test("过滤式安装徽标只服务全局安装行；项目行/发现行不参与", () => {
	const modal = read("src/renderer/src/ConfigModal.tsx");
	const rows = read("src/renderer/src/config/extensionsTableRows.tsx");
	const projectManager = read("src/main/projects/ProjectResourceManager.ts");
	// 全局列表（pi list）里的项目作用域行必须丢掉：否则它们会把 pi 的 object=filtered 粗标记带进列表，
	// 而原生过滤投影只读全局 packages 快照，对项目条目无真值可判（见 projectExtensionFiltered 边界注释）。
	assert.match(modal, /globalExtensions\s*=\s*globalResult\.extensions\.filter\(\(extension\)\s*=>\s*!isProjectExtension\(extension\)\)/, "ConfigModal 必须继续把 pi list 中的项目作用域行从全局列表剔除");
	// 项目自有行来自 ProjectResourceManager.list（本地 .pi/extensions），不携带 filtered
	assert.doesNotMatch(projectManager, /filtered\s*:/, "项目行不得携带 pi list 的 filtered 标记，必须由全局快照投影决定");
	// 项目里的包声明只以只读发现行展示，不渲染徽标
	const discoveredStart = rows.indexOf("export function DiscoveredExtensionRow");
	assert.ok(discoveredStart > 0, "未找到 DiscoveredExtensionRow");
	assert.doesNotMatch(rows.slice(discoveredStart), /config\.extensionFiltered/, "发现行（项目包声明的唯一展示形态）不得挂过滤式安装徽标");
});

test("configuration resources share one global/project scope owner", () => {
	const modal = read("src/renderer/src/ConfigModal.tsx");
	const scopeModel = read("src/renderer/src/config/resourceScopeModel.ts");
	const mcp = read("src/renderer/src/config/McpTab.tsx");
	// 主配置页资源作用域是派生值：非 resourceOnly 固定 global（全局/用户自装/内置），
	// 项目级技能/扩展/提示词管理入口在项目右键的资源弹窗，不再提供可切换下拉。
	assert.match(modal, /const resourceScope: ResourceScope = resourceOnly \? "project" : "global"/);
	assert.doesNotMatch(modal, /useState<ResourceScope>/);
	// 资源 tab（技能/扩展/提示词）仍接 resourceScopeSelector：resourceOnly 为固定项目标识，主页面为 undefined
	assert.equal((modal.match(/scopeSelector=\{resourceScopeSelector\}/g) ?? []).length, 3);
	// MCP 页接显式作用域对象（渲染层只传注册 projectId，不传路径）；没有作用域下拉
	assert.match(mcp, /McpConfigScope/);
	assert.match(mcp, /api\.config\.getMcp\(scope\)/);
	assert.match(mcp, /api\.config\.saveMcp\(toSave, scope, snapshot\?\.revision\)/);
	assert.doesNotMatch(mcp, /useState<ResourceScope>|effectiveScope|ResourceScopeSelector/);
	// 作用域类型迁到 resourceScopeModel；只被 MCP 页使用的共享下拉组件已随之下线
	assert.match(scopeModel, /export type ResourceScope = "global" \| "project"/);
	assert.equal(existsSync("src/renderer/src/config/ResourceScopeSelector.tsx"), false);
	// Chat 项目没有项目资源，作用域解析必须过滤（resourceOnly 入口）
	assert.match(modal, /resourceOnly && projectKind !== "chat" \? effectiveProjectId : undefined/);
	assert.match(modal, /resourceScopeSelector = resourceOnly \?/);
	assert.doesNotMatch(modal, /getMcp\(projectPath\)/);
	// 全局 McpTab 装配：只下发导入扫描的项目来源与脏回调，不传项目列表、不传项目作用域
	const globalMountMatch = /<McpTab[\s\S]{0,320}?ref=\{mcpTabRef\}[\s\S]{0,320}?\/>/.exec(modal);
	assert.ok(globalMountMatch, "ConfigModal 未挂载全局 McpTab");
	const globalMount = globalMountMatch[0];
	assert.match(globalMount, /activeProjectId=\{projectId\}/);
	assert.match(globalMount, /onDirtyChange=\{handleMcpDirtyChange\}/);
	assert.doesNotMatch(globalMount, /projectId=\{/);
	assert.doesNotMatch(globalMount, /projects=/);
	// 项目资源管理器里的 McpTab 固定项目作用域
	assert.match(modal, /<McpTab[\s\S]{0,240}?ref=\{resourceMcpTabRef\}[\s\S]{0,240}?projectId=\{resourceOnly && projectKind !== "chat" \? effectiveProjectId : undefined\}/);
});

test("extension scope table keeps three columns and horizontal state toggles", () => {
	const extensions = read("src/renderer/src/config/ExtensionsTab.tsx");
	const rows = read("src/renderer/src/config/extensionsTableRows.tsx");
	// 路径列已随并行提交移除，表头为 扩展/版本/操作 三列
	assert.match(extensions, /config\.extensionVersion/);
	assert.match(extensions, /config\.actions/);
	assert.doesNotMatch(extensions, /config\.extensionPath/);
	// 启停开关用 Switch（轨道着色区分启用/禁用），不使用 Power 图标或无色差的 Toggle 图标
	assert.doesNotMatch(extensions + rows, /\bPower\b/);
	assert.doesNotMatch(rows, /ToggleRight|ToggleLeft/);
	assert.match(rows, /<Switch\s+checked=\{effectiveEnabled\}/);
	// 内置扩展也使用同一启停开关；仅保留全局范围下的独立移除入口（不限于启用态：已禁用的内置同样可移除）。
	assert.match(rows, /启停开关：Switch 轨道着色[\s\S]*?内置扩展也复用 extensions:toggle/);
	assert.match(rows, /onCheckedChange=\{\(checked\) => props\.onToggle\(extension, checked\)\}/);
	assert.match(rows, /extension\.builtIn && !inherited && \(/);
	assert.doesNotMatch(rows, /onRestoreBuiltIn|restoringBuiltIn/);
	// 继承的全局行只读：全局禁用项不可在项目视图重新启用，卸载/移除均隐藏
	assert.match(rows, /\(inherited && extension\.enabled === false\)/);
	assert.match(rows, /!extension\.builtIn && !inherited && \(\s*<Button[\s\S]*?onUninstall/);
});

test("project resource views group inherited globals and use project-only overrides", () => {
	const skills = read("src/renderer/src/config/SkillsTab.tsx");
	const prompts = read("src/renderer/src/config/PromptsTab.tsx");
	const extensions = read("src/renderer/src/config/ExtensionsTab.tsx");
	for (const source of [skills, prompts, extensions]) {
		assert.match(source, /config\.resourceGroup\.project/);
		assert.match(source, /config\.resourceGroup\.global/);
	}
	assert.match(skills, /disabledGlobalSkills/);
	assert.match(prompts, /disabledGlobalPrompts/);
	assert.match(extensions, /disabledGlobalExtensions/);
	// MCP 列表一次只显示一个作用域，不分「项目/全局」两组；项目来源用层标记区分
	const mcp = read("src/renderer/src/config/McpResourceViews.tsx");
	assert.doesNotMatch(mcp, /config\.resourceGroup\./);
	assert.doesNotMatch(mcp, /projectLayerPaths/);
	assert.match(mcp, /originScope === "project-pi"/);
});

test("project resource file operations retain the registered project scope", () => {
	const modal = read("src/renderer/src/ConfigModal.tsx");
	const extensions = read("src/renderer/src/config/ExtensionsTab.tsx");
	assert.match(modal, /isProjectSkill\(skill\) && effectiveProjectId \? \{ projectId: effectiveProjectId \} : undefined/);
	assert.match(modal, /isProjectSkill\(editingGlobalSkill\) && effectiveProjectId \? \{ projectId: effectiveProjectId \} : undefined/);
	assert.match(modal, /api\.projectResources\.openDirectory\(effectiveProjectId, kind\)/);
	assert.match(modal, /extension\.scope === "project" && effectiveProjectId \? \{ projectId: effectiveProjectId \} : undefined/);
	assert.match(extensions, /onShowInFolder/);
});

test("inherited override IPC is exposed through shared, main, and preload layers", () => {
	const channels = read("src/shared/ipc.ts");
	const main = read("src/main/ipc/projectResourceIpc.ts");
	const preload = read("src/preload/index.ts");
	assert.match(channels, /projectResourcesOpenDirectory: "project-resources:open-directory"/);
	assert.match(channels, /projectResourcesToggleInherited: "project-resources:toggle-inherited"/);
	assert.match(main, /ipcChannels\.projectResourcesToggleInherited/);
	assert.match(main, /isInheritedToggleInput/);
	assert.match(preload, /openDirectory: \(projectId: string, kind: ProjectResourceDirectoryKind\)/);
	assert.match(preload, /toggleInherited: \(input: ProjectInheritedResourceToggleInput\)/);
});
