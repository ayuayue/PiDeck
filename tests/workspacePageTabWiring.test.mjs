import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

/**
 * 页面式工作区（定时任务 / 智能体）的装配契约：
 * 两者都是会话 Tab 栏里的专属页面 Tab（不是弹窗、也不是会话 Tab）；
 * 切会话只失活、关闭才卸载；标题固定走 i18n，不参与 pi 的自动会话标题。
 */
const read = (path) => readFileSync(path, "utf8");
const app = read("src/renderer/src/App.tsx");
const tabsBar = read("src/renderer/src/components/session/SessionTabsBar.tsx");
const automationPage = read("src/renderer/src/components/automation/AutomationPage.tsx");
const automationWorkspace = read("src/renderer/src/components/automation/AutomationWorkspace.tsx");
const agentPage = read("src/renderer/src/components/agents/AgentMarketPage.tsx");
const agentHeader = read("src/renderer/src/components/agents/market/AgentMarketHeader.tsx");
const agentWorkspace = read("src/renderer/src/components/agents/market/AgentMarketWorkspace.tsx");
const automationAtoms = read("src/renderer/src/atoms/automation-atoms.ts");
const agentAtoms = read("src/renderer/src/atoms/agent-atoms.ts");
const workspaceAtoms = read("src/renderer/src/atoms/workspace-page-atoms.ts");
const workspaceUtil = read("src/renderer/src/utils/workspacePageTabs.ts");
const zh = read("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
const en = read("src/renderer/src/i18n/rendererCopy.en-US.ts");

test("会话 Tab 栏渲染页面式工作区 Tab（可选中/可关闭，不参与会话拖拽）", () => {
	assert.match(tabsBar, /pageTabs\?\s*:\s*readonly WorkspacePageTabItem\[\]/, "SessionTabsBar 必须声明 pageTabs prop");
	assert.match(tabsBar, /data-workspace-page-tab=\{tab\.id\}/, "页面 Tab 必须带稳定的数据属性（e2e/测试锚点）");
	assert.match(tabsBar, /props\.pageTabs[\s\S]*?WorkspacePageTab/, "SessionTabsBar 必须在提供 pageTabs 时渲染页面 Tab");
	// 页面 Tab 不能复用会话语义：不得出现 draggable / onDragStart / data-session-id。
	const pageTabStart = tabsBar.indexOf("function WorkspacePageTab");
	const pageTabEnd = tabsBar.indexOf("function GroupCapsuleButton");
	assert.ok(pageTabStart > -1 && pageTabEnd > pageTabStart, "WorkspacePageTab 组件必须存在");
	const pageTabComponent = tabsBar.slice(pageTabStart, pageTabEnd);
	assert.doesNotMatch(pageTabComponent, /draggable|onDragStart|data-session-id/, "页面 Tab 不得参与会话拖拽/会话身份");
});

test("App 把三个页面挂进会话 Tab 栏，并用当前页面决定会话选中态", () => {
	assert.match(app, /const workspacePageTabItems: WorkspacePageTabItem\[\] = sortWorkspacePageIds\(openWorkspacePageIds\)\.map/, "App 必须从页面 Tab 状态装配 Tab 项（固定展示顺序）");
	assert.match(app, /pageTabs=\{workspacePageTabItems\}/, "App 必须把页面 Tab 传给 SessionTabsBar");
	assert.match(app, /currentSessionId=\{activeWorkspacePage \|\| hostPluginPageTab \? undefined : currentSessionId\}/, "页面打开时会话 Tab 不得显示选中态");
	assert.match(app, /<AutomationPage\s+active=\{activeWorkspacePage === "automation"\}/, "定时任务页面必须按激活态挂载");
	assert.match(app, /<AgentMarketPage active=\{activeWorkspacePage === "agents"\}/, "智能体页面必须按激活态挂载");
	assert.match(app, /<FavoritesPage active=\{activeWorkspacePage === "favorites"\}/, "收藏页面必须按激活态挂载");
});

test("页面不是会话 Tab：不进 sessionTabIds，切会话只失活、关闭才卸载", () => {
	assert.doesNotMatch(workspaceAtoms, /sessionTabIdsAtom|registerOpenSession/, "页面 Tab 状态不得写入会话 Tab 列表");
	assert.doesNotMatch(workspaceUtil, /^\s*import\s/m, "页面 Tab 纯逻辑必须零依赖（离开 React/atoms 可单测）");
	assert.match(app, /onSelect=\{\(sessionId\) => \{[\s\S]{0,120}?deactivateWorkspacePage\(\);[\s\S]{0,120}?workspaceChrome\.selectTab\(sessionId\)/, "点会话 Tab 必须先让页面失活");
	assert.match(automationAtoms, /set\(openWorkspacePageAtom, "automation"\)/);
	assert.match(automationAtoms, /set\(closeWorkspacePageAtom, "automation"\)/);
	assert.match(agentAtoms, /set\(openWorkspacePageAtom, "agents"\)/);
	assert.match(agentAtoms, /set\(closeWorkspacePageAtom, "agents"\)/);
});

test("页面标题固定走 i18n：智能体市场已改名「智能体」，不参与自动会话标题", () => {
	assert.match(app, /title: t\(pageId === "automation" \? "automation\.title" : pageId === "agents" \? "agentMarket\.title" : "favorites\.title"\)/);
	assert.match(zh, /"favorites\.title": "收藏"/);
	assert.match(en, /"favorites\.title": "Favorites"/);
	assert.match(zh, /"automation\.title": "定时任务"/);
	assert.match(zh, /"agentMarket\.title": "智能体"/);
	assert.match(en, /"agentMarket\.title": "Agents"/);
	assert.ok(!zh.includes('"智能体市场"'), "用户可见文案不得再出现「智能体市场」");
});

test("定时任务页面化：复用原管理界面、不再有 Dialog 弹框", () => {
	assert.match(automationPage, /<AutomationWorkspace/, "页面内部复用 AutomationWorkspace（页面逻辑不变）");
	assert.ok(!/ui-shadcn\/dialog/.test(automationPage), "页面宿主不得再引入 Dialog");
	assert.match(automationPage, /absolute inset-0 z-30 flex flex-col bg-background/);
	assert.match(automationPage, /!props\.active && "hidden"/, "失活时保持挂载并隐藏（切回来状态不丢）");
	assert.equal(existsSync("src/renderer/src/components/automation/AutomationModal.tsx"), false, "旧弹框宿主必须删除");
});

test("页面关闭统一由会话 Tab 管理：页面头部不再渲染关闭叉", () => {
	// 用户反馈：既然会话 Tab 能关闭页面，就不需要页面里再点叉。
	assert.doesNotMatch(automationWorkspace, /drawer\.closePanel/, "定时任务页面头部不得再有关闭按钮");
	assert.doesNotMatch(automationWorkspace, /onClose/, "定时任务工作区不再接收 onClose（关闭只走 Tab）");
	assert.doesNotMatch(agentHeader, /common\.close|<X\s/, "智能体页面头部不得再有关闭按钮/X 图标");
	assert.doesNotMatch(agentWorkspace, /common\.close|<X\s/, "智能体编辑器子页头部不得再有关闭按钮/X 图标");
});

test("智能体页面：改名后的页面 Tab，失活隐藏、关闭卸载、Esc 只由当前页面响应", () => {
	assert.match(agentPage, /active: boolean/);
	assert.match(agentPage, /!active && "hidden"/);
	assert.match(agentPage, /if \(!open \|\| !active\) return;/);
	assert.match(agentPage, /if \(!open\) return null;/);
});
