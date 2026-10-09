import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

/** 页面式插件覆盖层的源码契约：切换会话/项目必须自动收起（回归：插件页盖住新选会话，2025-11 用户报告）。 */
const source = readFileSync("src/renderer/src/components/plugins/HostPluginPageOverlay.tsx", "utf8");

test("page overlay dismisses when session or project scope changes", () => {
	// scope 变化 → setSelected(null)：正则空白容忍，格式化改动不断言
	assert.match(source, /scope\s*!==\s*lastScope\.current[\s\S]*?setSelected\(null\)/, "覆盖层必须在 scope 变化时调用 setSelected(null) 收起");
	// 首次渲染建立基线，不在挂载瞬间误收起
	assert.match(source, /lastScope\.current\s*===\s*undefined/, "首次渲染必须只记录基线 scope，不触发收起");
});

test("page overlay stays above session column only", () => {
	assert.match(source, /className="absolute inset-0[\s\S]*?bg-background"/, "覆盖层保持非模态样式（absolute inset-0 + 不透明背景）");
});

/** tab 模式下插件页伪 Tab 的接线契约（回归：插件页只在 tab 栏下方铺开、不占 tab 位，2025-11 用户报告）。 */
const tabsBarSource = readFileSync("src/renderer/src/components/session/SessionTabsBar.tsx", "utf8");
const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");

test("session tabs bar renders plugin pseudo-tab when provided", () => {
	assert.match(tabsBarSource, /pluginTab\?\s*:\s*\{/, "SessionTabsBar 必须声明 pluginTab prop");
	assert.match(tabsBarSource, /props\.pluginTab[\s\S]*?HostPluginTab/, "SessionTabsBar 必须在提供 pluginTab 时渲染 HostPluginTab 伪 Tab");
	assert.match(tabsBarSource, /!props\.simple && props\.pluginTab/, "伪 Tab 仅 tab 模式渲染（simple 模式插件页直接铺满）");
});

test("app dismisses plugin page when any session tab clicked", () => {
	// currentSessionId 置 undefined：插件页打开时会话 Tab 不显示选中态
	assert.match(appSource, /currentSessionId=\{hostPluginPageTab \? undefined : currentSessionId\}/, "插件页打开时必须向 Tab 栏传 currentSessionId=undefined");
	// 点任意会话 Tab（含当前 Tab）先收起插件页再正常选中
	assert.match(appSource, /hostPluginPageTab\?\.onClose\(\);[\s\S]*?workspaceChrome\.selectTab\(sessionId\)/, "会话 Tab 点击必须先收起插件页再选中会话");
});
