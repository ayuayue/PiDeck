import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 用户反馈：插件面板只能从设置页/命令面板打开，期望像定时任务一样在侧边栏
// 「新建/搜索/定时任务」下方有直接入口，点击打开统计页面。
const sidebar = readFileSync("src/renderer/src/components/sidebar/SidebarContent.tsx", "utf8");
const dock = readFileSync("src/renderer/src/components/plugins/HostPluginDockButtons.tsx", "utf8");
const host = readFileSync("src/renderer/src/components/plugins/HostPluginPanelHost.tsx", "utf8");
const sharedIcons = readFileSync("src/shared/hostPluginIcons.ts", "utf8");
const rendererIcons = readFileSync("src/renderer/src/components/plugins/hostPluginPanelIcon.tsx", "utf8");

test("host plugin dock entry renders under the automation entry in the sidebar action block", () => {
	assert.match(sidebar, /import \{ HostPluginDockButtons \} from "\.\.\/plugins\/HostPluginDockButtons";/);
	const automationIndex = sidebar.indexOf("<AutomationDockButton />");
	const pluginIndex = sidebar.indexOf("<HostPluginDockButtons />");
	const tabsIndex = sidebar.indexOf("<Tabs");
	assert.ok(automationIndex > -1, "automation entry missing");
	assert.ok(pluginIndex > automationIndex, "plugin entries should sit below the automation entry");
	assert.ok(pluginIndex < tabsIndex, "plugin entries should stay in the top action block");
});

test("dock rows only come from enabled plugins and share the panel atom open path", () => {
	// 只渲染启用插件的面板；点击与设置页/命令面板共用 hostPluginPanelAtom（同一打开路径）
	assert.match(dock, /if \(!plugin\.enabled\) continue;/);
	assert.match(dock, /hostPluginPanelAtom/);
	assert.match(dock, /rows\.length === 0/);
	assert.doesNotMatch(dock, /hostPluginsMount|desktopApi\.hostPlugins\.mount/);
	// page 面板是常驻覆盖层：再点同一面板 = 关闭；modal 面板仍是纯打开
	assert.match(dock, /selected\?\.pluginId === row\.pluginId && selected\?\.panelId === row\.panelId && row\.presentation === "page" \? openPanel\(null\)/);
});

test("page panels render as a non-modal overlay over the session column, not a dialog", () => {
	const overlay = readFileSync("src/renderer/src/components/plugins/HostPluginPageOverlay.tsx", "utf8");
	const host = readFileSync("src/renderer/src/components/plugins/HostPluginPanelHost.tsx", "utf8");
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	// 页面式：非模态覆盖层，覆盖会话列但不卸载会话树（包裹在 relative 容器里）
	assert.match(overlay, /panel\.presentation !== "page"/);
	assert.match(overlay, /absolute inset-0/);
	assert.match(overlay, /NativePluginSurface/);
	// 弹框宿主必须跳过 page 面板，两处呈现互斥
	assert.match(host, /panel\.presentation !== "page"/);
	// App 在会话列挂 overlay，会话树保持挂载
	assert.match(app, /HostPluginPageOverlay projectId=\{activeProject\?\.id\}/);
	const wrapIndex = app.indexOf('<div className="relative flex h-full min-h-0 min-w-0 flex-col">');
	const sessionIndex = app.indexOf("{chatPaneSessionNode}");
	const overlayIndex = app.indexOf("<HostPluginPageOverlay");
	assert.ok(wrapIndex > -1 && sessionIndex > wrapIndex && overlayIndex > sessionIndex, "session node must stay mounted inside the overlay wrapper");
});

test("converter ships pi-context as a page-presentation panel with host-token theming", () => {
	const converter = readFileSync("scripts/convert-pi-context-host-plugin.mjs", "utf8");
	// 页面式呈现 + 中性色跟随 PiDeck token（两主题适配），图表系列色保持上游色板
	assert.match(converter, /presentation: "page"/);
	assert.match(converter, /--bg: var\(--color-bg-app/);
	assert.match(converter, /--fg: var\(--color-text-primary/);
	assert.match(converter, /\.kpi b, \.card \.m, summary b \{ color: var\(--fg\); \}/);
});

test("panel icons stay allowlisted end to end with a puzzle fallback", () => {
	// shared 白名单与渲染层映射是同一契约的两端：unknown 名字在校验处 fail-closed
	const names = [...sharedIcons.matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
	assert.ok(names.includes("bar-chart"), "bar-chart icon missing from allowlist");
	assert.match(rendererIcons, /Puzzle/);
	assert.match(rendererIcons, /"bar-chart": BarChart3/);
});

test("plugin panel presents as a page-sized modal aligned with the automation modal", () => {
	assert.match(host, /size="xl"/);
	assert.match(host, /stagger/);
	assert.match(host, /h-\[min\(760px,calc\(100vh-64px\)\)\]/);
});

test("settings tab exposes the development guide entry linking the canonical guide", () => {
	const tab = readFileSync("src/renderer/src/config/HostPluginsTab.tsx", "utf8");
	assert.match(tab, /hostPlugins\.devGuide/);
	assert.match(tab, /docs\/host-plugin-dev-guide\.md/);
	assert.match(tab, /openExternal/);
});
