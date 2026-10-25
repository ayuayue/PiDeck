/**
 * 会话顶部 Tab hover 富提示 + 面包屑工作区样式测试（用户反馈）。
 *
 * 需求：(1) Tab hover 只有原生 title，希望同时显示工作区（可复用面包屑样式或无样式）；
 * (2) 会话头部面包屑里工作区段与标题同色，看不清。
 *
 * 修复：(1) SessionTab / EditorWorkbenchTab 换 shadcn Tooltip（两行：标题 + 工作区）；
 * (2) SessionHeader 项目段加 bg-muted 胶囊底。
 *
 * 测试策略：组件渲染依赖 jotai Provider 与 Radix portal，纯函数价值低；
 * 这里的回归风险集中在「接线」——原生 title 被移除、Tooltip 覆盖两个 Tab 组件、
 * 面包屑胶囊样式存在。用静态源码断言锁住这些契约。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const tabsBar = readFileSync("src/renderer/src/components/session/SessionTabsBar.tsx", "utf8");
const sessionHeader = readFileSync("src/renderer/src/components/session/SessionHeader.tsx", "utf8");

function extractFunction(source, name, nextName) {
	const start = source.indexOf(`function ${name}(`);
	const end = source.indexOf(`function ${nextName}(`);
	assert.ok(start >= 0, `${name} should exist`);
	assert.ok(end > start, `${nextName} should follow ${name}`);
	return source.slice(start, end);
}

function extractFunctionToEnd(source, name) {
	const start = source.indexOf(`function ${name}(`);
	assert.ok(start >= 0, `${name} should exist`);
	return source.slice(start);
}

const sessionTabBody = extractFunction(tabsBar, "SessionTab", "NewSessionMenu");
const editorTabBody = extractFunction(tabsBar, "EditorWorkbenchTab", "GroupCapsuleButton");

test("Tab 右键菜单携带与 ⋯ 菜单同源的会话操作组", () => {
	// 2026-10-02 需求：右键菜单与右上角 ⋯ 更多菜单结合。装配层用同一工厂
	// （contextSessionActions(sessionId)）喂两处，闸门（草稿/DSH/无文件路径）一致。
	assert.match(tabsBar, /contextSessionActions\?: \(sessionId: string\) => SessionTabActions \| undefined;/);
	// Tab 级菜单渲染工厂结果（后台 Tab 同样可操作；renderTab 在 SessionTabsBar 函数体内）。
	assert.match(tabsBar, /sessionActions=\{props\.contextSessionActions\?\.\(sessionId\)\}/);
	// 右键菜单项与 ⋯ 菜单同源文案：重命名/复制会话/导出 HTML/复制路径/打开文件。
	assert.match(sessionTabBody, /\{t\("common\.rename"\)\}/);
	assert.match(sessionTabBody, /\{t\("menu\.copySession"\)\}/);
	assert.match(sessionTabBody, /\{t\("menu\.exportHtml"\)\}/);
	assert.match(sessionTabBody, /\{t\("menu\.copySessionFilePath"\)\}/);
	assert.match(sessionTabBody, /\{t\("menu\.openSessionFile"\)\}/);
});

function test_sessionTab() {}

test("SessionTab 用富 Tooltip 替代原生 title，第二行显示工作区", () => {
	const body = sessionTabBody;
	// 原生 title 已移除（防止 Tooltip 与原生气泡双弹）。
	assert.doesNotMatch(body, /\btitle=\{title\}/);
	// 富提示：工作区来自 displayProjectDirectoryName（与面包屑/侧栏同一展示源）。
	assert.match(body, /displayProjectDirectoryName\(tabProject\)/);
	assert.match(body, /projectByIdAtomFamily\(record\?\.projectId \?\? ""\)/);
	// Tooltip 两行结构：标题行 + 工作区行（含完整路径兜底）。
	assert.match(body, /<Tooltip delayDuration=\{500\}>/);
	assert.match(body, /<TooltipContent side="bottom" align="start"/);
	// 2026-10-02 回归：重排右键菜单嵌套时误删 TooltipTrigger → Tooltip.Root 失去
	// trigger，hover 富提示整体失效（用户报「移入的效果没了」）。Trigger 必须在链上。
	assert.match(body, /<TooltipTrigger asChild>/);
	assert.match(body, /\{workspaceName \? \(/);
	assert.match(body, /tabProject\?\.path/);
	// 读屏契约：aria-label 保留 标题 — 工作区。
	assert.match(body, /aria-label=\{workspaceName \? `\$\{title\} — \$\{workspaceName\}` : title\}/);
});

test("EditorWorkbenchTab 用富 Tooltip 显示 标题 + 完整路径", () => {
	const body = editorTabBody;
	assert.doesNotMatch(body, /\btitle=\{tab\.title \?\? tab\.label\}/);
	assert.match(body, /<Tooltip delayDuration=\{500\}>/);
	// 第二行是文件完整路径（tab.title 由装配层传 filePath），mono 字体区分路径与标题。
	assert.match(body, /font-mono text-micro[^"]*"\>\{tab\.title\}/);
	// title 缺省时不渲染 TooltipContent（退化为无提示，与旧行为一致）。
	assert.match(body, /\{tab\.title \? \(/);
});

test("面包屑工作区段用可见灰底 + 近正文色文字，与标题段拉开对比", () => {
	const breadcrumb = sessionHeader.match(/\{projectName \? \(\s*<span[\s\S]*?\{projectName\}\s*<\/span>\s*\) : null\}/);
	assert.ok(breadcrumb, "project breadcrumb segment should be discoverable");
	// 2026-09 用户反馈「项目不够明显」：bg-muted(#f4f4f4) 在浅色主题的 bg-background(#ffffff)
	// 上几乎不可见，改用 bg-accent(=--color-bg-active) 实底，明暗主题都能看见色块。
	assert.match(breadcrumb[0], /bg-accent/);
	assert.match(breadcrumb[0], /rounded/);
	// 项目段文字比 text-muted-foreground 更接近正文（用户要「明显」），但仍不进到 font-medium。
	assert.match(breadcrumb[0], /text-foreground\/\d+/);
	assert.doesNotMatch(breadcrumb[0], /font-medium/);
	// 标题段保持无底色（对比来自项目段，不整行加胶囊）。
	assert.doesNotMatch(sessionHeader, /session-pane-title[^"]*bg-accent/);
});
