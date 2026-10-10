import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dir = "src/renderer/src/components/session/statusPanel";
const panel = readFileSync(`${dir}/SessionStatusPanel.tsx`, "utf8");
const content = readFileSync(`${dir}/SessionStatusContent.tsx`, "utf8");
const tabs = readFileSync(`${dir}/StatusTabs.tsx`, "utf8");
const KEYS = ["title", "tab.todo", "tab.files", "tab.subagents", "collapse", "expand", "expandBlocked", "resizeHandle", "noSession", "subagentsRunning", "fileKind.write", "fileKind.edit", "fileKindHint.write", "fileKindHint.edit"];

test("面板只在「抽屉打开且下半区展开且有会话」时占用会话，清理时只释放自己", () => {
	assert.match(panel, /stack\.open && !stack\.collapsed/);
	assert.match(panel, /rightSidebarStatusSessionIdAtom/);
	assert.match(panel, /current === sessionId \? null : current/);
	assert.match(panel, /if \(!stack\.open\) return null;/);
	// 设置只有 sidebar / composer 二选一：面板挂上即独占，不再有「两处并存」的参数分支
	assert.match(panel, /if \(!visible \|\| !sessionId\) return;/);
	assert.match(panel, /\[visible, sessionId, setStatusSessionId\]/);
	assert.doesNotMatch(panel, /hideComposerStrips/);
});

test("数据复用折叠条同源 hook，文件增量来自 SessionView 发布的 run", () => {
	assert.match(content, /useSessionTodoSources\(/);
	assert.match(content, /useSessionFileChanges\(sessionId, run\)/);
	assert.match(content, /sessionLatestAgentRunAtomFamily\(sessionId\)/);
	assert.match(content, /useSessionSubagentList\(/);
});

test("tab 用 line 变体与具名容器查询紧凑模式；无 overscroll-contain", () => {
	assert.match(tabs + panel, /variant="line"/);
	assert.match(tabs + panel, /@container\/status/);
	assert.match(tabs, /@min-\[280px\]\/status:inline/);
	for (const source of [panel, content, tabs]) assert.doesNotMatch(source, /overscroll-contain/);
});

test("三语 i18n 同步新增 sessionStatus.* 文案", () => {
	for (const locale of ["zh-CN", "zh-TW", "en-US"]) {
		const copy = readFileSync(`src/renderer/src/i18n/rendererCopy.${locale}.ts`, "utf8");
		for (const key of KEYS) assert.match(copy, new RegExp(`"sessionStatus\\.${key.replace(".", "\\.")}":`), `${locale} 缺 ${key}`);
	}
});

test("SessionView/SessionStartSurface：面板可见时只隐藏待办/文件/子代理三条，字面量与顺序不变", () => {
	const view = readFileSync("src/renderer/src/components/session/SessionView.tsx", "utf8");
	const start = readFileSync("src/renderer/src/components/session/SessionStartSurface.tsx", "utf8");
	assert.match(view, /sessionStatusInSidebarAtomFamily\(sessionId\)/);
	assert.match(view, /\{!statusInSidebar && <SessionTodoStrip sessionId=\{sessionId\} \/>\}/);
	assert.match(view, /\{!statusInSidebar && <SessionFilesStrip /);
	assert.match(view, /\{!statusInSidebar && <SessionSubagentsStrip /);
	assert.match(view, /<SessionQueuedMessagesStrip sessionId=\{sessionId\} \/>\n/);
	assert.match(view, /\n\s*<SessionTeamStrip sessionId=\{sessionId\} \/>/);
	assert.match(view, /\n\s*<SessionGoalStrip sessionId=\{sessionId\} \/>/);
	assert.match(view, /publishSessionLatestAgentRunAtom/);
	assert.match(start, /sessionStatusInSidebarAtomFamily\(props\.sessionId\)/);
	assert.match(start, /\{!statusInSidebar && <SessionTodoStrip sessionId=\{props\.sessionId\} \/>\}/);
});

test("App 按显示位置装配 drawerFooter：只有 sidebar 挂下半区，composer 时右侧边栏保持单区抽屉", () => {
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	assert.match(app, /const sessionStatusPlacement = parseSessionStatusPlacement\(settings\.sessionStatusPlacement\);/);
	assert.match(app, /drawerFooter=\{\s*placementShowsSidebarPanel\(sessionStatusPlacement\) \? \(\s*<SessionPaneServicesProvider value=\{sessionPaneServices\}>\s*<SessionStatusPanel sessionId=\{currentSessionId\} \/>\s*<\/SessionPaneServicesProvider>\s*\) : undefined\s*\}/);
});
