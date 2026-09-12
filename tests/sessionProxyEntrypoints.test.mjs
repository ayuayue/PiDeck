import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// ===== 会话代理入口：Tab 栏 ⋯ 菜单与侧栏共用同一宿主 =====
//
// 回归背景（用户报障）：「chat 项目怎么没有代理操作，我看好像被过滤了」——
// 代理入口原先只挂在侧栏会话右键菜单，Chat 视图的 Tab 栏 ⋯ 菜单里完全没有，
// 用户切到 Chat 后找不到设置网络代理的地方。修复后两处入口同源，宿主统一在 App 层。

const TABS_BAR = "src/renderer/src/components/session/SessionTabsBar.tsx";
const APP = "src/renderer/src/App.tsx";
const SIDEBAR_CONTENT = "src/renderer/src/components/sidebar/SidebarContent.tsx";
const SIDEBAR_COMPONENTS = "src/renderer/src/components/sidebar/SidebarComponents.tsx";

test("Tab 栏 ⋯ 菜单提供会话代理入口", () => {
	const source = readFileSync(TABS_BAR, "utf8");
	// props 暴露回调，由 App 装配（组件本身不持有弹窗状态）
	assert.match(source, /onOpenProxySetting\?: \(\) => void;/);
	// 菜单内渲染该项，复用侧栏同款文案 key
	assert.match(source, /props\.onOpenProxySetting && \([\s\S]*?t\("menu\.sessionProxy"\)/);
});

test("Agent 右键菜单提供会话代理入口（此前缺失，用户报障点）", () => {
	const source = readFileSync(SIDEBAR_COMPONENTS, "utf8");
	assert.match(source, /onOpenProxySetting\?: \(\) => void;/);
	// AgentContextMenu 与 SessionContextMenu 两处菜单都有代理项（Globe/Settings2 图标可不同，文案 key 必须同源）
	const agentMenu = source.slice(source.indexOf("function AgentContextMenu"), source.indexOf("function DraftSessionContextMenu"));
	assert.match(agentMenu, /onOpenProxySetting/);
	assert.match(agentMenu, /t\("menu\.sessionProxy"\)/);
});

test("App 层是代理弹窗的唯一宿主（Tab 栏与侧栏共用）", () => {
	const app = readFileSync(APP, "utf8");
	// 单一 state + 单一挂载点
	assert.match(app, /const \[proxyDialogSessionId, setProxyDialogSessionId\] = useState<string \| null>\(null\)/);
	assert.match(app, /<SessionProxyDialog[\s\S]*?sessionId=\{proxyDialogSessionId\}[\s\S]*?onClose=\{\(\) => setProxyDialogSessionId\(null\)\}/);
	// Tab 栏拿到的是「打开当前会话代理」回调
	assert.match(app, /onOpenProxySetting: currentSessionId[\s\S]*?setProxyDialogSessionId\(currentSessionId\)/);
	// 侧栏通过 actions 上抛，不自己渲染弹窗
	assert.match(app, /openProxySetting: \(sessionId\) => setProxyDialogSessionId\(sessionId\)/);
});

test("侧栏不再重复挂载代理弹窗", () => {
	const sidebar = readFileSync(SIDEBAR_CONTENT, "utf8");
	// 菜单项保留，但走 App 层 actions
	assert.match(sidebar, /actions\.sessions\.openProxySetting\(menuSession\.id\)/);
	// 本地不再 import 弹窗组件、不再持有本地目标会话 state
	assert.doesNotMatch(sidebar, /import \{ SessionProxyDialog \}/);
	assert.doesNotMatch(sidebar, /\[proxyDialogSessionId, setProxyDialogSessionId\]/);
});

test("SidebarActions 契约声明 openProxySetting", () => {
	const sidebar = readFileSync(SIDEBAR_CONTENT, "utf8");
	assert.match(sidebar, /openProxySetting: \(sessionId: string\) => void;/);
});
