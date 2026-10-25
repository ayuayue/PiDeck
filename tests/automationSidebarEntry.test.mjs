import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

// 用户反馈：定时任务入口藏在左下角 Dock 不明显，应放在「新建会话 / 搜索会话」下方。
const sidebar = readFileSync("src/renderer/src/components/sidebar/SidebarContent.tsx", "utf8");

test("automation entry renders under new/search session actions, not the dock", () => {
	assert.match(sidebar, /import \{ AutomationDockButton \} from "\.\.\/automation\/AutomationDockButton";/);
	const newSessionIndex = sidebar.indexOf('aria-label={t("app.newSession")}');
	const searchIndex = sidebar.indexOf('aria-label={t("app.searchSessions")}');
	const automationIndex = sidebar.indexOf("<AutomationDockButton />");
	const tabsIndex = sidebar.indexOf("<Tabs");
	assert.ok(newSessionIndex > -1, "new session action missing");
	assert.ok(searchIndex > newSessionIndex, "search should follow new session");
	assert.ok(automationIndex > searchIndex, "automation entry should sit below new/search session");
	assert.ok(automationIndex < tabsIndex, "automation entry should stay in the top action block");
});

test("dock no longer hosts the automation entry", () => {
	const dockIndex = sidebar.indexOf("<Dock size={32}");
	assert.ok(dockIndex > -1, "dock section missing");
	assert.doesNotMatch(sidebar.slice(dockIndex), /AutomationDockButton/);
});

test("automation management is a workspace page tab, not a modal", () => {
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	const sessionActions = readFileSync("src/renderer/src/hooks/useSessionActions.ts", "utf8");
	const page = readFileSync("src/renderer/src/components/automation/AutomationPage.tsx", "utf8");

	// 定时任务以会话 Tab 栏里的页面 Tab 呈现：App 挂 AutomationPage，旧模态弹框已删除
	assert.match(app, /<AutomationPage/);
	assert.match(app, /active=\{activeWorkspacePage === "automation"\}/);
	assert.doesNotMatch(app, /<AutomationModal/);
	assert.doesNotMatch(app, /<AutomationWorkspace/);
	assert.equal(existsSync("src/renderer/src/components/automation/AutomationModal.tsx"), false, "旧弹框宿主必须删除");
	assert.match(page, /<AutomationWorkspace/, "页面宿主内部仍复用原管理界面（页面逻辑不变）");
	assert.ok(!/ui-shadcn\/dialog/.test(page), "页面宿主不得回退到 Dialog");
	assert.doesNotMatch(app, /workspaceSurface/);
	// 会话选择回调已回归普通选中链路，不再需要 surface 让步钩子
	assert.doesNotMatch(sessionActions, /onWorkspaceSelection/);
});

test("automation dock button keeps active-run indicator and opens the page tab", () => {
	const source = readFileSync("src/renderer/src/components/automation/AutomationDockButton.tsx", "utf8");
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	assert.match(source, /openAutomationPageAtom/);
	assert.doesNotMatch(source, /openAutomationModalAtom/);
	assert.doesNotMatch(source, /openAutomationWorkspaceAtom/);
	assert.doesNotMatch(source, /workspaceSurface/);
	assert.match(source, /automationActiveRunsAtom/);
	assert.match(source, /t\("automation\.title"\)/);
	assert.match(app, /<AutomationPage/);
	assert.doesNotMatch(app, /workspaceSurface\.isAutomationWorkspace/);
});
