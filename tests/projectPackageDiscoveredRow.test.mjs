import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const read = (path) => readFileSync(path, "utf8");
const { isActionableProjectPackageItem } = loadTsCommonJs("src/renderer/src/config/resourceScopeModel.ts");

// ── 纯函数：package-project 发现行的可操作判定 ─────────────────────────────
// 背景约束：只有项目层安装的包（source 即 npm:<name> 包源）能接整包开关/卸载——
// 后端 setExtensionEnabled 按 isPackageSource 分流到项目层 packages delta，
// settings-* 行无整包语义、package-user 属全局层，误开操作会写出错误层的规则。

test("package-project 且 managed 的发现行可操作", () => {
	assert.equal(isActionableProjectPackageItem({ sourceId: "package-project", managed: true }), true);
});

test("package-user / settings-* / 非 managed 行不可操作", () => {
	assert.equal(isActionableProjectPackageItem({ sourceId: "package-user", managed: true }), false, "全局包不在项目层，开关会写错作用域");
	assert.equal(isActionableProjectPackageItem({ sourceId: "settings-project", managed: true }), false, "settings 行没有整包语义");
	assert.equal(isActionableProjectPackageItem({ sourceId: "package-project", managed: false }), false, "非托管行保持只读");
});

// ── 源码契约：行组件 → ExtensionsTab → ConfigModal 的完整接线 ─────────────
// 正则空白容忍（\s* / [\t ]*），格式化调整不应打断断言（AGENTS 格式化契约）。

test("DiscoveredExtensionRow：可操作行渲染开关与卸载，徽标按物理层归属", () => {
	const source = read("src/renderer/src/config/extensionsTableRows.tsx");
	assert.match(source, /const actionable = isActionableProjectPackageItem\(item\)\s*&&\s*Boolean\(props\.onToggle && props\.onUninstall\)/, "操作区必须同时判定行身份与处理器可用");
	assert.match(source, /\{actionable && \(/, "操作区按 actionable 条件渲染");
	assert.match(source, /onCheckedChange=\{\(checked\) => props\.onToggle\?\.\(item, checked\)\}/, "开关必须回调 onToggle");
	assert.match(source, /onClick=\{\(\) => props\.onUninstall\?\.\(item\)\}/, "卸载按钮必须回调 onUninstall");
	assert.match(source, /checked=\{props\.effectiveEnabled\}/, "开关显示态必须走乐观覆盖值（由调用方传入）");
	// 徽标修正：项目层条目不得再误标「全局」
	assert.match(source, /item\.physicalScope === "project"\s*\?\s*t\("config\.source\.project"\)\s*:\s*t\("config\.source\.global"\)/);
});

test("ExtensionsTab：项目包开关走原生 toggle（scope=project、path=undefined）+ 乐观刷新", () => {
	const source = read("src/renderer/src/config/ExtensionsTab.tsx");
	assert.match(source, /await getExtensionsApi\(\)\.toggle\(item\.source, enabled, "project", undefined, props\.projectId\)/, "包源 path 无意义必须传 undefined；projectId 缺失后端会拒绝项目层写入");
	assert.match(source, /await \(props\.onRefreshAfterToggle \?\? props\.onRefresh\)\(\)/, "必须等刷新落地再清乐观覆盖，否则开关弹回旧值");
	assert.match(source, /onToggle=\{handleDiscoveredPackageToggle\}/, "发现行开关必须接统一 handler");
	assert.match(source, /onUninstall=\{props\.onUninstallProjectPackage\}/, "发现行卸载必须由 ConfigModal 弹确认");
	assert.match(source, /uninstalling=\{props\.uninstallingSource === item\.source\}/, "卸载进行态按 source 匹配复用 uninstallingSource");
});

test("ConfigModal：项目包卸载确认走 api.extensions.uninstall(source, project, projectId)", () => {
	const source = read("src/renderer/src/ConfigModal.tsx");
	assert.match(source, /await api\.extensions\.uninstall\(target\.source, "project", effectiveProjectId\)/, "项目包卸载必须带 project scope + 项目 id（后端信任门解析根目录）");
	assert.match(source, /target\.scope === "project" \? effectiveProjectId : undefined/, "已装行卸载在 project scope 也必须传项目 id");
	assert.match(source, /onUninstallProjectPackage=\{handleRequestProjectPackageUninstall\}/, "ExtensionsTab 必须拿到卸载确认入口");
	assert.match(source, /\{uninstallProjectPackageConfirm && \(/, "卸载前必须有确认弹窗");
	assert.match(source, /pi uninstall \$\{target\.source\} -l/, "失败兜底文案必须给出项目层等价 CLI（-l）");
});

test("i18n：徽标新键三语言齐全", () => {
	for (const locale of ["zh-CN", "en-US", "zh-TW"]) {
		const source = read(`src/renderer/src/i18n/rendererCopy.${locale}.ts`);
		assert.match(source, /"config\.source\.project":/, `rendererCopy.${locale}.ts 必须含 config.source.project`);
	}
});

// ── 三需求：版本列 / 整包更新 / 打开安装位置（2026-06 冒烟后补） ─────────────

test("发现行：版本列与文件夹/更新按钮接线", () => {
	const source = read("src/renderer/src/config/extensionsTableRows.tsx");
	assert.match(source, /import \{ Copy, FolderOpen, RefreshCw, Trash2 \} from "lucide-react"/, "RefreshCw 必须引入");
	assert.match(source, /\{item\.version \?\? "-"\}/, "版本列必须显示发现链路带出的 version，无则 -");
	assert.match(source, /\(actionable \|\| props\.onShowInFolder\) && \(/, "有 path 的行（含 settings-*）都要能打开位置");
	assert.match(source, /onClick=\{\(\) => props\.onShowInFolder\?\.\(item\)\}/, "文件夹按钮回调 onShowInFolder");
	assert.match(source, /\{actionable && props\.onUpdate && \(/, "更新按钮仅项目包行提供");
	assert.match(source, /onClick=\{\(\) => props\.onUpdate\?\.\(item\)\}/, "更新按钮回调 onUpdate");
	assert.match(source, /disabled=\{props\.updating \|\| props\.uninstalling\}/, "更新中/卸载中必须互斥禁用");
});

test("ExtensionsTab：发现行接共用 updateOne 与文件夹回调", () => {
	const source = read("src/renderer/src/config/ExtensionsTab.tsx");
	assert.match(source, /const handleUpdateOne = async \(extension: \{ source: string \}\)/, "更新 handler 收窄为 source 型，发现行与已装行共用同一回路");
	assert.match(source, /onShowDiscoveredInFolder\?: \(item: DiscoveredExtensionItem\) => void/, "发现行文件夹 prop 声明");
	assert.match(source, /updating=\{updatingOne === item\.source\}/, "发现行更新进行态按 source 匹配复用 updatingOne");
	assert.match(source, /onUpdate=\{handleUpdateOne\}/, "发现行更新必须走 updateOne 回路");
	assert.match(source, /onShowInFolder=\{props\.onShowDiscoveredInFolder\}/, "发现行文件夹必须透传 ConfigModal 回调");
});

test("ConfigModal：发现行打开位置按 physicalScope 决定项目读边界", () => {
	const source = read("src/renderer/src/ConfigModal.tsx");
	assert.match(source, /item\.physicalScope === "project" && effectiveProjectId/, "项目层物理路径必须带 projectId 走项目读边界，防越权打开");
	assert.match(source, /onShowDiscoveredInFolder=\{\(item\) => void handleOpenDiscoveredLocation\(item\)\}/, "ExtensionsTab 必须拿到发现行位置回调");
});

test("版本穿线：resolver → discovery → 共享类型", () => {
	const resolver = read("src/main/packageResourceResolver.ts");
	assert.match(resolver, /version: readPackageVersion\(path\)/, "解析时必须就近读包版本");
	assert.match(resolver, /export function readPackageVersion/, "版本读取需导出可单测");
	const discovery = read("src/main/resourceDiscovery.ts");
	assert.match(discovery, /version: resource\.version/, "发现链路必须透传版本");
	const shared = read("src/shared/types/app.ts");
	assert.match(shared, /extensions: Array<\{[\s\S]*?version\?: string;/, "共享发现类型必须声明 version 可选字段");
});

// ── 源码契约：项目层卸载信任路径（冒烟事故：--no-approve 拒改本地 packages） ──
// 事故：pi remove -l 不带项目 cwd 且被推入 --no-approve → "Project is not trusted.
// Use --approve to modify local package config."；安装路径本就带 cwd + projectInstall，卸载必须镜像。

test("项目层卸载与安装走同一信任路径（preload → storeIpc → ExtensionManager）", () => {
	const preload = read("src/preload/index.ts");
	assert.match(preload, /uninstall: \(source: string, scope\?: "user" \| "project" \| "unknown", projectId\?: string\)/, "preload 必须透传 projectId");

	const ipc = read("src/main/ipc/storeIpc.ts");
	assert.match(ipc, /extensionsUninstall, async \(_event, source: string, scope\?: "user" \| "project" \| "unknown", projectId\?: unknown\)/, "卸载通道必须收 projectId");
	assert.match(ipc, /scope === "project" \? await projectInstallTarget\(projectId\) : undefined/, "project scope 必须过安装同一信任门解析项目根");
	assert.match(ipc, /scope === "project" && !target\) throw new Error\("Project scope requires a project id\."\)/, "无项目 id 必须拒绝（fail closed）");
	assert.match(ipc, /extensionManager\.uninstall\(source, scope, target \? \{ projectRoot: target\.root \} : \{\}\)/, "项目根必须传给 uninstall");

	const manager = read("src/main/extensions/ExtensionManager.ts");
	assert.match(manager, /options\.projectRoot \? \{ cwd: options\.projectRoot, projectInstall: true \} : \{\}/, "项目层 remove 必须带 cwd 且不推 --no-approve（与 install 的 projectInstall 语义一致）");
});
