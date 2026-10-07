import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

test("ConfigModal wires an MCP tab without bloating loadConfig into MCP CRUD", () => {
	const modal = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
	assert.match(modal, /id: "mcp"/);
	assert.match(modal, /CONFIG_TABS: readonly ConfigTab\[] = \["models", "auth", "settings", "trust", "mcp", "raw"\]/);
	// MCP 页固定全局作用域：父层只传导入扫描的项目来源 + 脏回调，不再下发项目列表/作用域
	assert.match(modal, /<McpTab[\s\S]{0,160}?activeProjectId=\{projectId\}[\s\S]{0,160}?onDirtyChange=\{handleMcpDirtyChange\}/);
	assert.match(modal, /case "config:mcp":/);
	assert.match(modal, /api\.config\.getMcp/);
	assert.match(modal, /rawFileName === "mcp\.json"/);
});

test("McpTab 的 load 依赖必须稳定，且同名 MCP 入口只保留一个", () => {
	const tab = readFileSync("src/renderer/src/config/McpTab.tsx", "utf8");
	const modal = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
	// 回归：作用域对象未 memo / 调用方传内联脏回调 → load 身份每次渲染都变 → effect 重跑，
	// 用磁盘内容覆盖正在编辑的表单（用户实测：输入的内容自己消失）。
	assert.match(tab, /const scope: McpConfigScope \| undefined = useMemo\(\(\) => \(projectId \? \{ scope: "project", projectId \} : undefined\), \[projectId\]\)/);
	assert.match(tab, /const onDirtyChangeRef = useRef\(onDirtyChange\)/);
	assert.doesNotMatch(tab, /\[onDirtyChange, probeThirdParty, scope\]/);
	assert.doesNotMatch(tab, /\bonDirtyChange\(false\)/);
	// 同源脏回调在父层 memo 化（两道防线：McpTab 用 ref 兼底，调用方不再传内联箭头）
	assert.match(modal, /const handleResourceMcpDirtyChange = useCallback\(/);
	assert.match(modal, /onDirtyChange=\{handleResourceMcpDirtyChange\}/);
	assert.doesNotMatch(modal, /onDirtyChange=\{\(dirty\) => \{/);
	// 双入口收敛：配置管理弹窗里 MCP 归「配置文件」组的 config:mcp；
	// 同名入口只在项目资源管理器（resourceOnly）出现，且保住自管草稿的 forceMount。
	assert.equal(modal.match(/<TabsTrigger value="mcp"/g)?.length, 1);
	assert.match(modal, /\{resourceOnly && \(\s*<TabsTrigger value="mcp"/);
	assert.match(modal, /\{resourceOnly \? \(\s*<TabsContent value="mcp" forceMount/);
});

test("exposure 别名归一必须落到表单展示：别名住 shared，渲染层不能引 main", () => {
	const tab = readFileSync("src/renderer/src/config/McpTab.tsx", "utf8");
	const mcpConfig = readFileSync("src/main/config/mcpConfig.ts", "utf8");
	const shared = readFileSync("src/shared/mcpExposure.ts", "utf8");
	// 单一来源：纯函数放 shared（渲染层不得 import main），main 只 re-export
	assert.match(shared, /export function resolveExposureAlias\(value: unknown\): unknown/);
	assert.match(shared, /export function resolveExposureAliases\(def: McpServerDefinition\): McpServerDefinition/);
	assert.doesNotMatch(mcpConfig, /export function resolveExposureAlias/);
	assert.match(mcpConfig, /export \{ resolveExposureAlias, resolveExposureAliases \};/);
	// 回归：别名没归一就会落到 ConfigSelect 的「自定义」兜底，把原字符串当档位显示
	assert.match(tab, /import \{ resolveExposureAliases \} from "\.\.\/\.\.\/\.\.\/shared\/mcpExposure";/);
	assert.match(tab, /const editingDisplayDef = useMemo\(\(\) => resolveExposureAliases\(editingDef\), \[editingDef\]\);/);
	assert.match(tab, /value=\{editingDisplayDef\.exposure \?\? "codemode"\}/);
	assert.match(tab, /const base = editingDisplayDef\.toolExposure \?\? \{\};/);
});

test("McpTab 保存必须带乐观锁 revision，冲突时提示并重载", () => {
	const tab = readFileSync("src/renderer/src/config/McpTab.tsx", "utf8");
	const sharedTypes = readFileSync("src/shared/types/mcp.ts", "utf8");
	// 快照带可写层内容哈希，保存时回传比对（P1-1：外部手改不被草稿静默覆盖）
	assert.match(sharedTypes, /\/\*\*[\s\S]*?\*\/\n\trevision: string;/);
	assert.match(tab, /api\.config\.saveMcp\(toSave, scope, snapshot\?\.revision\)/);
	// 冲突分支：提示用户并以磁盘为准重新加载
	assert.match(tab, /if \(result\.conflict\) \{[\s\S]{0,240}?t\("config\.mcp\.conflict"\)[\s\S]{0,80}?await load\(\);/);
});

test("MCP service catalog stays separate from configured status; auth.provider is global and advanced-only; AI setup entry is wired", () => {
	const tab = readFileSync("src/renderer/src/config/McpTab.tsx", "utf8");
	const list = readFileSync("src/renderer/src/config/McpResourceViews.tsx", "utf8");
	const templateForm = readFileSync("src/renderer/src/config/McpServiceTemplateForm.tsx", "utf8");
	const smartAdd = readFileSync("src/renderer/src/config/McpSmartAdd.tsx", "utf8");
	const ipc = readFileSync("src/shared/ipc.ts", "utf8");
	const preload = readFileSync("src/preload/index.ts", "utf8");
	const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	const advancedStart = tab.indexOf('t("config.mcp.section.advanced")');
	assert.ok(advancedStart >= 0);
	// 目录分组呈现：按 category 聚类，已配置条目打勾，不再与已配置服务混在同一个状态列表里
	assert.match(list, /MCP_SERVICE_CATALOG\.filter\(\(entry\) => entry\.category === category\)/);
	assert.match(list, /McpCatalogConfiguredMark/);
	assert.match(tab, /selectedTemplateDefinition \? \(/);
	assert.match(tab, /McpServiceTemplateForm/);
	// 表单由认证声明驱动：必填密钥 / 可选密钥 / OAuth / none 四形态
	assert.match(templateForm, /catalogNeedsCredential/);
	assert.match(templateForm, /buildCatalogDefinition/);
	assert.match(templateForm, /SecretInput/);
	assert.match(templateForm, /config\.mcp\.template\.plaintextNotice/);
	assert.match(templateForm, /config\.mcp\.catalog\.oauthHint/);
	assert.match(templateForm, /config\.mcp\.catalog\.noAuthHint/);
	assert.match(templateForm, /uniqueServerName\(props\.entry\.defaultName, props\.existingNames\)/);
	assert.match(templateForm, /props\.existingNames\.has\(trimmedName\)/);
	// AI 代配入口：MCP 页安装内置 mcp-setup 技能；IPC 三处同步（通道常量/preload 白名单/main handler）
	assert.match(smartAdd, /t\("config\.mcp\.catalog\.aiSetup\.install"\)/);
	assert.match(tab, /installMcpSetupSkill/);
	assert.match(ipc, /configInstallMcpSetupSkill: "config:install-mcp-setup-skill"/);
	assert.match(preload, /installMcpSetupSkill:/);
	assert.match(systemIpc, /ipcChannels\.configInstallMcpSetupSkill/);
	assert.ok(readFileSync("resources/skills/mcp-setup/SKILL.md", "utf8").includes("name: mcp-setup"));
	// 密钥明文提示双语齐全（目录表单 + 通用高级字段共用）
	assert.match(tab, /config\.mcp\.secretStorageHint/);
	assert.match(smartAdd, /t\("config\.mcp\.secretStorageHint"\)/);
	for (const key of ["config.mcp.template.plaintextNotice", "config.mcp.secretStorageHint", "config.mcp.catalog.category.dev", "config.mcp.catalog.oauthHint", "config.mcp.catalog.aiSetup.installed"]) {
		assert.ok(zh.includes(`"${key}"`), `zh-CN missing ${key}`);
		assert.ok(en.includes(`"${key}"`), `en-US missing ${key}`);
	}
	// 旧的三模板专有 key 已随目录化清理
	assert.ok(!zh.includes('"config.mcp.template.linear"'), "zh-CN still has legacy template key");
	assert.doesNotMatch(tab, /config\.mcp\.auth\.method|deriveAuthMode|extractApiKey/);
	assert.ok(tab.indexOf("config.mcp.providerAuth.provider", advancedStart) > advancedStart);
	assert.doesNotMatch(tab.slice(0, advancedStart), /config\.mcp\.providerAuth\.provider/);
	assert.match(tab.slice(advancedStart), /transport === "http" && !isProjectScope/);
	assert.match(tab.slice(advancedStart), /isProjectScope && usesProviderAuth\(editingDef\)/);
	assert.match(tab, /api\.config\n?\s*\.getAuth\(\)|getAuth: \(\) => Promise/);
	assert.match(tab, /snapshot\?\.oauthCredentialNames/);
	assert.match(tab, /setLogoutConfirm\(selected\)/);
	// 登录过程信息统一收在「连接与认证」块：复制链接出口 + 结构化结果（原始 CLI 输出经 sanitize 上屏），
	// 左栏不再渲染原始输出（历史问题：超长授权 URL 堆在列表底部）。
	assert.match(tab, /config\.mcp\.oauth\.copyLink/);
	assert.match(tab, /clipboard\.writeText\(loginUrl\.url\)/);
	assert.match(tab, /sanitizeLoginOutput\(loginResult\.output\)/);
	assert.match(tab, /loginResult\.kind === "logout"/);
	assert.doesNotMatch(tab, /\{loginResult\.server\}: \{loginResult\.output/);
	assert.match(zh, /"config\.mcp\.oauth\.browserOpened"/);
	assert.match(en, /"config\.mcp\.oauth\.browserOpened"/);
});

test("dirty-mark helpers include config:mcp", () => {
	const { dirtyKeysClearedByReload, ALL_CONFIG_DIRTY_KEYS } = loadTsCommonJs("src/renderer/src/config/configDirtyMarks.ts");
	assert.deepEqual(new Set(dirtyKeysClearedByReload("mcp")), new Set(["config:mcp", "config:raw"]));
	assert.ok(Array.from(ALL_CONFIG_DIRTY_KEYS).includes("config:mcp"));
});

test("IPC, preload, and ConfigManager expose get/save/probe MCP channels", () => {
	const ipc = readFileSync("src/shared/ipc.ts", "utf8");
	const preload = readFileSync("src/preload/index.ts", "utf8");
	const manager = readFileSync("src/main/config/ConfigManager.ts", "utf8");
	const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
	assert.match(ipc, /configGetMcp: "config:get-mcp"/);
	assert.match(ipc, /configSaveMcp: "config:save-mcp"/);
	assert.match(ipc, /configProbeMcp: "config:probe-mcp"/);
	assert.match(preload, /getMcp:/);
	assert.match(preload, /saveMcp:/);
	assert.match(preload, /probeMcp:/);
	assert.match(manager, /getMcpConfig/);
	assert.match(manager, /saveMcpConfig/);
	assert.match(systemIpc, /ipcChannels\.configGetMcp/);
	assert.match(systemIpc, /function isMcpConfigFile\(value: unknown\): value is McpConfigFile/);
	assert.match(systemIpc, /function isMcpServerDefinition\(value: unknown\): value is McpServerDefinition/);
	assert.match(systemIpc, /projectId\.length > 256/);
	assert.doesNotMatch(systemIpc, /data as McpConfigFile|definition as McpServerDefinition/);
	assert.match(manager, /"mcp\.json"/);
	assert.match(manager, /readJsonFile<McpConfigFile>\("mcp\.json"/);
	assert.match(manager, /files\["mcp\.json"\]/);
});

test("McpTab stays proxy-config only with an explicit scope object", () => {
	const tab = readFileSync("src/renderer/src/config/McpTab.tsx", "utf8");
	const resourceViews = readFileSync("src/renderer/src/config/McpResourceViews.tsx", "utf8");
	const main = readFileSync("src/main/config/mcpConfig.ts", "utf8");
	assert.match(tab, /probeMcp/);
	assert.match(tab, /item\?\.ownedByWritable/);
	assert.match(tab, /writableBroken/);
	// 作用域是显式对象（渲染层只传注册 projectId，主进程做 trust 与路径解析）；没有作用域下拉
	assert.match(tab, /McpConfigScope/);
	assert.match(tab, /getMcp\(scope\)/);
	assert.doesNotMatch(tab, /effectiveScope|ResourceScopeSelector|projects=\{projects\}/);
	assert.match(tab, /generation !== loadGenerationRef\.current/);
	assert.doesNotMatch(tab, /<fieldset/);
	// 列表一次只显示一个作用域；项目来源用层标记区分
	assert.match(resourceViews, /McpServerListPane/);
	assert.match(resourceViews, /originScope === "project-pi"/);
	assert.doesNotMatch(resourceViews, /config\.resourceGroup\.|projectLayerPaths/);
	assert.doesNotMatch(tab, /Client|StdioClientTransport|@modelcontextprotocol/);
	assert.doesNotMatch(main, /spawn\(|fork\(/);
	assert.match(main, /Command not found/);
});

test("MCP 表单切到 pi 0.99 内置 MCP schema：exposure/timeout/enabled 替代 adapter lifecycle", () => {
	const tab = readFileSync("src/renderer/src/config/McpTab.tsx", "utf8");
	const resourceViews = readFileSync("src/renderer/src/config/McpResourceViews.tsx", "utf8");
	const shared = readFileSync("src/shared/types/mcp.ts", "utf8");
	const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
	// pi 0.99 不再识别 lifecycle/directTools：表单停止写入这些死字段
	assert.doesNotMatch(tab, /LIFECYCLE_OPTIONS/);
	assert.doesNotMatch(tab, /config\.mcp\.field\.lifecycle/);
	// 停用语义 = pi 语义：只写 enabled；本层已有条目启用时删键，继承条目写最小有效停用定义。
	// 启停开关即时落盘（与智能添加同语义）并自动重检——只写草稿会让用户感知「开了没反应」。
	// 键移除逻辑抽纯函数 applyEnabledToggle（回归：开启分支曾漏删 enabled:false，服务永远开不回来）。
	assert.doesNotMatch(tab, /disabled: !checked/);
	assert.doesNotMatch(tab, /disabled: disabled \? true : false/);
	assert.match(tab, /applyEnabledToggle\(existing, disabled\)/);
	assert.match(tab, /const saved = await persistServers\(next\);/);
	assert.match(tab, /if \(saved\) void runStatusCheck\(\);/);
	assert.match(tab, /buildInheritedDisableOverride/);
	assert.match(resourceViews, /definition\.enabled === false/);
	assert.match(resourceViews, /hasLegacyDisabledField/);
	assert.match(resourceViews, /usesProviderAuth/);
	assert.match(resourceViews, /usesMcpOAuth/);
	// exposure / timeout 编辑入口
	assert.match(tab, /EXPOSURE_OPTIONS/);
	assert.match(tab, /patchEditing\(\{ exposure: value as McpExposure \}\)/);
	assert.match(tab, /patchEditing\(\{ timeout: parsed \}\)/);
	assert.match(tab, /placeholder="60"/);
	// 共享类型与主进程校验容纳 0.99 schema
	assert.match(shared, /export type McpExposure =/);
	assert.match(shared, /exposure\?: McpExposure;/);
	assert.match(shared, /toolExposure\?: Record<string, McpExposure>;/);
	assert.match(systemIpc, /MCP_EXPOSURE_VALUES/);
	assert.match(systemIpc, /optionalExposure\("exposure"\)/);
	assert.match(systemIpc, /Number\.isFinite\(value\.timeout\) && value\.timeout > 0/);
});

test("pi 0.99 起 MCP 内置：adapter 引导降级为可选提示，配置页不再被整页接管", () => {
	const tab = readFileSync("src/renderer/src/config/McpTab.tsx", "utf8");
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	// 不再存在「缺 adapter 就隐藏新建按钮 / 隐藏整个编辑器」的分支
	assert.doesNotMatch(tab, /adapterInstalled !== false \? \(/);
	assert.doesNotMatch(tab, /showAdapterGuide \? null : \(/);
	// 旧「可选 adapter」折叠安装入口已随第三方接管识别移除
	assert.doesNotMatch(tab, /t\("config\.mcp\.optionalAdapter"\)/);
	assert.doesNotMatch(tab, /<details className="mt-1">/);
	// 文档指向 pi 官方 MCP 文档而非 adapter mintlify
	assert.match(tab, /const MCP_DOCS = "https:\/\/earendil-works\.github\.io\/pi\/docs\/mcp"/);
	// 新增的第三方横幅文案双语齐全
	for (const key of ["config.mcp.thirdParty.title", "config.mcp.thirdParty.copyCommand", "config.mcp.thirdParty.detectFailed"]) {
		assert.ok(zh.includes(`"${key}"`), `zh-CN missing ${key}`);
		assert.ok(en.includes(`"${key}"`), `en-US missing ${key}`);
	}
});
