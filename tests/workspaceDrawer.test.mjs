import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const typescript = require("typescript");

const host = readFileSync("src/renderer/src/components/workspace/WorkspaceDrawerHost.tsx", "utf8");
const hook = readFileSync("src/renderer/src/hooks/useWorkspacePanels.ts", "utf8");
const editor = readFileSync("src/renderer/src/components/workspace/EditorSurface.tsx", "utf8");
const browser = readFileSync("src/renderer/src/components/workspace/BrowserSurface.tsx", "utf8");
const external = readFileSync("src/renderer/src/components/workspace/ExternalEditorOverlay.tsx", "utf8");

async function loadPureExports(source, startMarker, endMarker) {
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker, start + startMarker.length);
	assert.notEqual(start, -1, `${startMarker} must exist`);
	assert.notEqual(end, -1, `${endMarker} must follow ${startMarker}`);
	const output = typescript.transpileModule(source.slice(start, end), {
		compilerOptions: { module: typescript.ModuleKind.ESNext, target: typescript.ScriptTarget.ES2022 },
	}).outputText;
	return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

const gitState = await loadPureExports(hook, "export function invalidateGitDiffState", "/** The adapter deliberately mirrors GitPanel's resource boundary");
const drawerState = await loadPureExports(host, "export function getVisibleDrawerPanel", "export type WorkspaceDrawerHostProps");

test("workspace drawer keeps a rendered panel through the 120ms compositor close", () => {
	assert.match(hook, /DRAWER_ANIMATION_MS\s*=\s*120/);
	assert.match(host, /const \[renderedDrawer, setRenderedDrawer\]/);
	assert.match(host, /setTimeout\(\(\) => \{[\s\S]*?setRenderedDrawer\(null\)/);
	assert.match(host, /\}, DRAWER_ANIMATION_MS\)/);
	assert.match(host, /data-open=\{open\}/);
	assert.match(host, /const visiblePanel = getVisibleDrawerPanel\(open, props\.panel, renderedDrawer\)/);
	assert.match(host, /data-rendered=\{Boolean\(visiblePanel\)\}/);
});

test("Git diff lifecycle helper invalidates close races and rejects old project responses", () => {
	const initial = {
		request: 7,
		snapshot: { projectId: "project-a", path: "a.ts", originalContent: "", modifiedContent: "", label: "a.ts" },
		displayMode: "modal",
	};
	const invalidated = gitState.invalidateGitDiffState(initial);
	assert.deepEqual(invalidated, { request: 8, snapshot: null, displayMode: "drawer" });
	assert.equal(
		gitState.isCurrentGitDiffResponse({
			request: 8,
			currentRequest: 8,
			responseProjectId: "project-a",
			activeProjectId: "project-a",
		}),
		true,
	);
	assert.equal(
		gitState.isCurrentGitDiffResponse({
			request: 7,
			currentRequest: invalidated.request,
			responseProjectId: "project-a",
			activeProjectId: "project-a",
		}),
		false,
	);
	assert.equal(
		gitState.isCurrentGitDiffResponse({
			request: 8,
			currentRequest: invalidated.request,
			responseProjectId: "project-a",
			activeProjectId: "project-b",
		}),
		false,
	);
});

test("all Git leave paths invalidate the request and clear the snapshot", () => {
	const openDrawer = hook.slice(hook.indexOf("const openDrawer"), hook.indexOf("const closeDrawer"));
	const closeDrawer = hook.slice(hook.indexOf("const closeDrawer"), hook.indexOf("const collapseDrawer"));
	assert.match(openDrawer, /if \(next !== "git"\) invalidateGitDiff\(\)/);
	assert.match(closeDrawer, /invalidateGitDiff\(\)/);
	assert.match(hook, /const closeGitDiff = useCallback\(\(\) => \{\s*invalidateGitDiff\(\);/);
	assert.match(hook, /const openBrowser = useCallback\(\(\) => \{\s*invalidateGitDiff\(\);/);
	assert.match(hook, /useEffect\(\(\) => \{\s*invalidateGitDiff\(\);/);
});

test("drawer visible-panel helper renders first opens and switches immediately but retains close content", () => {
	assert.equal(drawerState.getVisibleDrawerPanel(true, "files", null), "files");
	assert.equal(drawerState.getVisibleDrawerPanel(true, "browser", "files"), "browser");
	assert.equal(drawerState.getVisibleDrawerPanel(false, null, "browser"), "browser");
	assert.equal(drawerState.getVisibleDrawerPanel(false, null, null), null);
});

test("workspace panel hook exposes narrow drawer commands", () => {
	assert.match(hook, /export function useWorkspacePanels/);
	for (const command of ["openDrawer", "closeDrawer", "collapseDrawer", "expandDrawer", "toggleDrawerPinned"]) {
		assert.match(hook, new RegExp(`const ${command} = useCallback`));
	}
	// 钉住（pin）功能：合并对方抽屉重构后恢复——钉住面板禁折叠、可持久化
	assert.match(hook, /drawerPinned/);
	assert.match(hook, /drawerStoragePrefix/);
	assert.match(hook, /projectIdRef\.current/);
});

test("editor tabs enforce both count and text-budget LRU while keeping IO callbacks stable", () => {
	// Editor state moved to useFileEditor (Phase 2 Gate 2D). Constants preserved in useWorkspacePanels.
	assert.match(hook, /EDITOR_TAB_LIMIT\s*=\s*5/);
	assert.match(hook, /EDITOR_TAB_TEXT_BUDGET\s*=\s*24 \* 1024 \* 1024/);
	// Editor tabs, trimEditorTabs, readContent now owned by useFileEditor.
	const fileEditor = readFileSync("src/renderer/src/hooks/useFileEditor.ts", "utf8");
	assert.match(fileEditor, /const EDITOR_TAB_LIMIT = 5/);
	assert.match(fileEditor, /const trimEditorTabs/);
	assert.match(fileEditor, /lastAccess/);
});

test("Git diff and external editor flows reject stale project responses", () => {
	assert.match(hook, /gitRequestRef\.current/);
	assert.match(hook, /isCurrentGitDiffResponse\(\{/);
	assert.match(hook, /editorRequestRef\.current/);
	assert.match(hook, /request !== editorRequestRef\.current \|\| projectIdRef\.current !== forProjectId/);
	assert.match(hook, /openProjectInExternalEditor/);
	assert.match(hook, /projectIdRef\.current !== id/);
	assert.match(external, /onOpenProject/);
});

test("browser surface has explicit fullscreen and minimize paths", () => {
	assert.match(browser, /isFullscreen/);
	assert.match(browser, /onMinimize=\{props\.onMinimize\}/);
	assert.match(browser, /onToggleFullscreen=\{props\.onEnterFullscreen\}/);
	assert.match(hook, /browserFullscreen/);
	assert.match(hook, /const minimizeBrowser = useCallback/);
	assert.match(hook, /openBrowser\(\)/);
});

// 回归（#113 parity）：抽屉面板切换入口必须挂在抽屉自身（activity rail），
// 不能只在会话 outline 浮动按钮里 —— 否则无活跃会话时无法切到 git/browser。
test("drawer host renders an injected activity rail while open", () => {
	const rail = readFileSync("src/renderer/src/components/workspace/WorkspaceDrawerRail.tsx", "utf8");
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	const shell = readFileSync("src/renderer/src/components/app/AppShell.tsx", "utf8");
	// rail 组件：水平 tablist + 激活态（pure official：shadcn Button + 下缘指示条）
	assert.match(rail, /role="tablist"/);
	assert.match(rail, /aria-orientation="horizontal"/);
	assert.match(rail, /aria-selected=\{action\.active\}/);
	assert.match(rail, /from "\.\.\/ui-shadcn\/button"/);
	assert.match(rail, /variant=\{action\.active \? "secondary" : "ghost"\}/);
	// host：打开期间渲染注入的 rail
	assert.match(host, /rail\?: ReactNode/);
	assert.match(host, /\{open && props\.rail\}/);
	// shell：drawerRail 透传
	assert.match(shell, /drawerRail\?: ReactNode/);
	assert.match(shell, /rail=\{drawerRail\}/);
	// App：右侧栏开关只做开/关（不再半折叠）；rail 切换语义仍由 handleToolDrawerAction 承载
	assert.match(app, /handleToolDrawerAction\s*=\s*useCallback\(\s*\(panel: WorkspaceDrawerPanel\)\s*=>/);
	assert.match(app, /const toggleRightDrawer = useCallback\(\(\) => \{\n\s*if \(workspace\.drawer\) \{\n\s*workspace\.closeDrawer\(\);/);
});

// 回归：项目上下文水合（null → 首个 projectId）不得重置用户已打开的抽屉；
// 只有真实项目切换（A → B）才恢复目标项目的保存态。
test("project hydration does not clobber a user-opened drawer", () => {
	assert.match(hook, /prevProjectIdRef/);
	assert.match(hook, /isInitialHydration = prevProjectId === null/);
	assert.match(hook, /!isInitialHydration \|\| !drawerRef\.current/);
});

test("drawer defaults closed on project load; pin restores per project", () => {
	// 换项目 / 水合默认关闭；钉住面板按项目持久化恢复（合并对方抽屉重构）
	assert.match(hook, /setDrawer\(null\)/);
	assert.match(hook, /saved\?\.pinned/);
	assert.match(hook, /toggleDrawerPinned/);
	const tabs = readFileSync("src/renderer/src/components/session/SessionTabsBar.tsx", "utf8");
	assert.match(tabs, /header-drawer-toggle/);
	assert.match(tabs, /PanelRight/);
	assert.doesNotMatch(tabs, /onToggleDrawer && !props\.drawerOpen/);
	const rail = readFileSync("src/renderer/src/components/workspace/WorkspaceDrawerRail.tsx", "utf8");
	assert.doesNotMatch(rail, /drawer-rail-close/);
	const surface = readFileSync("src/renderer/src/components/session/WorkspaceSurface.tsx", "utf8");
	assert.doesNotMatch(surface, /drawer\.pin/);
	assert.doesNotMatch(surface, /onTogglePin/);
});

// 回归（点叉无法关闭 tab / 最后 tab 不收起侧边栏）：
// 1) closeBrowser 是全屏 X 与关闭最后 tab 的统一入口，必须退出全屏并收起抽屉
//    （仅 setBrowserFullscreen(false) 在抽屉模式下是空操作，侧边栏永远关不掉）；
// 2) BrowserPanel 关闭最后 tab 时必须同步本地 tabs 状态，否则 React 因同值更新
//    跳过重渲染，旧 tab 残留显示。
test("closing the last browser tab syncs local state and collapses the sidebar", () => {
	const panel = readFileSync("src/renderer/src/components/app/BrowserPanel.tsx", "utf8");
	// closeBrowser 语义：关闭整个浏览器面板（退出全屏 + 关抽屉），区别于 minimizeBrowser
	assert.match(hook, /const closeBrowser = useCallback\(\(\) => \{\s*setBrowserFullscreen\(false\);\s*closeDrawer\(\);\s*\}, \[closeDrawer\]\);/);
	assert.match(hook, /const minimizeBrowser = useCallback/);
	// closeTab 最后 tab 分支：moduleState 与本地 state 同时清空，再调用 onClose
	assert.match(panel, /if \(current\.length <= 1\) \{/);
	assert.match(panel, /moduleState\.tabs = \[\];/);
	assert.match(panel, /setTabs\(\[\]\);/);
	assert.match(panel, /setActiveTabId\(null\);/);
	assert.match(panel, /onClose\?\.\(\);/);
});

// 回归：右侧「文件」面板的搜索入口曾经完全不可达——抽屉只给会话历史面板传 project，
// 文件面板拿到 undefined → 工具行搜索按钮的条件渲染从不成立、useFileSearch 也拿不到项目；
// 另外 FileSearchResults 在空查询时直接 return null，即使打开搜索也是一片空白、连输入框都没有。
test("files drawer wires the project id all the way to the search entry", () => {
	const surface = readFileSync("src/renderer/src/components/session/WorkspaceSurface.tsx", "utf8");
	const drawer = readFileSync("src/renderer/src/components/workspace/DrawerSurface.tsx", "utf8");
	const results = readFileSync("src/renderer/src/components/session/FileSearchResults.tsx", "utf8");
	// 抽屉必须把「文件树当前项目」传给 DrawerContent（project 只在会话历史面板才有值）
	assert.match(drawer, /<DrawerContent[\s\S]{0,400}?projectId=\{git\.activeProjectId\}/);
	// DrawerContent 声明该 prop 并转交 FilesPanel，保留 project?.id 兜底给其他调用方
	assert.match(surface, /projectId\?: string/);
	assert.match(surface, /projectId=\{props\.projectId \?\? props\.project\?\.id\}/);
	// 搜索入口以 projectId 为前提；快捷键与「输入即搜索」同一前提，首字符要播种进查询词
	assert.match(surface, /\{props\.projectId && \(/);
	assert.match(surface, /if \(!props\.projectId\) return;/);
	assert.match(surface, /isTypeToSearchKey\(event\)/);
	assert.match(surface, /fileSearch\.setQuery\(event\.key\)/);
	// 空查询必须保留搜索框（只把结果区换成引导文案），不能整块 return null
	assert.doesNotMatch(results, /if \(trimmed\.length === 0\) return null;/);
	assert.match(results, /trimmed\.length === 0 \? \(\s*<div[^>]*>\{t\("drawer\.fileSearchEmptyHint"\)\}/);
});
