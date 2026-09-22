import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
const streamdownChrome = readFileSync("src/renderer/src/styles/streamdownChrome.css", "utf8");
const stylesEntry = readFileSync("src/renderer/src/styles.css", "utf8");
const header = readFileSync("src/renderer/src/components/AppHeader.tsx", "utf8");
const ipc = readFileSync("src/shared/ipc.ts", "utf8");
const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");
const brand = readFileSync("src/renderer/src/components/app/AppParts.tsx", "utf8");
const sidebar = readFileSync("src/renderer/src/components/sidebar/AppSidebar.tsx", "utf8");
const tabs = readFileSync("src/renderer/src/components/session/SessionTabsBar.tsx", "utf8");
const shell = readFileSync("src/renderer/src/components/app/AppShell.tsx", "utf8");
const quickTaskSurface = readFileSync("src/renderer/src/components/app/QuickTaskSurface.tsx", "utf8");

test("compact task shell participates in the shared custom titlebar contract", () => {
	// 小任务复用主窗口的标题栏按钮和拖拽层；根节点必须进入同一套 CSS 作用域，
	// 否则 --window-drag-height / --window-controls-width 会退回无效默认值。
	assert.match(shell, /if \(props\.compactContent\)[\s\S]*?"wechat-shell quick-task-shell"/);
	assert.match(shell, /!useNativeTitleBar && platform === "darwin" \? "mac-custom-titlebar" : ""/);
	assert.match(quickTaskSurface, /BrandLockup/);
	assert.match(quickTaskSurface, /list-toolbar flex h-10/);
	assert.match(foundation, /\.quick-task-shell\.custom-titlebar-enabled \{[\s\S]*?padding-top:\s*0;/);
	assert.match(foundation, /\.quick-task-shell\.custom-titlebar-enabled \.list-toolbar \{[\s\S]*?margin-right:\s*var\(--window-controls-width\);/);
	assert.match(foundation, /\.quick-task-shell\.custom-titlebar-enabled \.list-toolbar button \{[\s\S]*?-webkit-app-region:\s*no-drag;/);
});

test("custom titlebar content is flush to window top (no shell padding strip)", () => {
	assert.match(foundation, /\.wechat-shell\.custom-titlebar-enabled,[\s\S]*?\.quick-task-shell\.custom-titlebar-enabled \{[\s\S]*?padding-top:\s*0;/);
	assert.match(foundation, /\.window-drag-layer \{[\s\S]*?background:\s*transparent;/);
	assert.doesNotMatch(foundation, /\.custom-titlebar-enabled \.chat-pane[\s\S]{0,80}margin-top:\s*calc\(-1 \* var\(--window-drag-height\)\)/);
	assert.match(foundation, /\.custom-titlebar-enabled:not\(\.drawer-open\) \.session-tabs-bar \{[\s\S]*?margin-right:\s*var\(--window-controls-width\);/);
});

test("window controls are compact and match drag-layer inset", () => {
	assert.match(foundation, /--window-drag-height:\s*40px/);
	assert.match(foundation, /--window-controls-width:\s*144px/);
	assert.match(foundation, /grid-template-columns:\s*repeat\(4,\s*36px\)/);
	assert.match(foundation, /\.window-drag-layer \{[\s\S]*?right:\s*var\(--window-controls-width\)/);
	assert.match(foundation, /\.window-controls \{[\s\S]*?width:\s*var\(--window-controls-width\)/);
});

test("pin button syncs initial always-on-top state from main process", () => {
	// 回归：置顶按钮态曾硬编码 false，窗口实际置顶时按钮却显示「关」，
	// 需点一次开关才恢复正常。现在必须新增 isWindowAlwaysOnTop 通道并向主进程读真实状态。
	assert.match(ipc, /appWindowIsAlwaysOnTop:/);
	assert.match(systemIpc, /appWindowIsAlwaysOnTop/);
	assert.match(preload, /isWindowAlwaysOnTop:/);
	assert.match(header, /isWindowAlwaysOnTop: \(\) => Promise<boolean>/);
	assert.match(header, /isWindowAlwaysOnTop\(\)\.then\(\(value\) => \{/);
	assert.match(header, /setWindowAlwaysOnTop\(value\)/);
});

test("focusMainWindow preserves the user's pin on Windows", () => {
	const mainIndex = readFileSync("src/main/index.ts", "utf8");
	// 临时置顶 hack 不能无条件 true/false：会把用户已置顶的窗口取消置顶
	assert.match(mainIndex, /const wasAlwaysOnTop = mainWindow\.isAlwaysOnTop\(\)/);
	assert.match(mainIndex, /if \(!wasAlwaysOnTop\)/);
});

test("maximize button tracks window state with restore icon", () => {
	assert.match(header, /function RestoreIcon/);
	assert.match(header, /maximized \? <RestoreIcon/);
	assert.match(header, /app\.windowRestore/);
	assert.match(header, /app\.windowMaximize/);
	assert.match(ipc, /appWindowIsMaximized/);
	assert.match(ipc, /appWindowMaximizedChanged/);
	assert.match(systemIpc, /appWindowIsMaximized/);
	assert.match(systemIpc, /win\.on\("maximize"/);
	assert.match(systemIpc, /win\.on\("unmaximize"/);
	assert.match(preload, /isWindowMaximized:/);
	assert.match(preload, /onWindowMaximizedChange:/);
	assert.match(preload, /toggleMaximizeWindow:[\s\S]*Promise<boolean>/);
});

test("window controls stay above session tabs so close is never covered", () => {
	assert.match(foundation, /\.window-controls \{[\s\S]*?z-index:\s*940;/);
	assert.match(foundation, /\.custom-titlebar-enabled \.session-tabs-bar \{[\s\S]*?z-index:\s*930;/);
});

test("workbench content sits below shared tabs chrome (no double drag padding)", () => {
	const surfaces = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");
	// Tab 栏已抬到 WorkbenchStage chrome；内容区再叠 window-drag padding 会空出一条缝
	assert.doesNotMatch(surfaces, /\.custom-titlebar-enabled \.workbench-content-frame \{[\s\S]*?padding-top:\s*var\(--window-drag-height\);/);
	// 关闭/动作钮仍须 no-drag（header 可能贴近顶栏）
	assert.match(foundation, /\.custom-titlebar-enabled \.file-diff-header[\s\S]*?-webkit-app-region:\s*no-drag;/);
	assert.match(foundation, /\.custom-titlebar-enabled \.file-diff-header button[\s\S]*?-webkit-app-region:\s*no-drag;/);
});

test("session tabs bar keeps trailing inset for drawer toggle (no px-* override)", () => {
	const tabs = readFileSync("src/renderer/src/components/session/SessionTabsBar.tsx", "utf8");
	// utility px-* 会冲掉 foundation 的右边距，导致开关钻进窗口控件下
	assert.doesNotMatch(tabs, /session-tabs-bar[^"]*px-\d/);
	assert.match(tabs, /session-tabs-bar[^\"]*pl-\[max\(0\.5rem,var\(--session-tabs-left-inset/);
	assert.doesNotMatch(tabs, /session-tabs-bar[^\"]*\bpl-2\b/);
	assert.match(tabs, /header-drawer-toggle/);
	assert.match(tabs, /PanelRight/);
	// margin 让位 + min-width:0：避免 flex 内容把 drag 区撑进窗口控件
	assert.match(foundation, /\.custom-titlebar-enabled \.session-tabs-bar \{[\s\S]*?min-width:\s*0;/);
	assert.match(foundation, /\.custom-titlebar-enabled \.session-tabs-bar \{[\s\S]*?margin-right:\s*var\(--window-controls-width\);/);
	assert.match(foundation, /\.window-controls,\s*\n\.window-controls \* \{[\s\S]*?-webkit-app-region:\s*no-drag;/);
});

test("toggle maximize tracks intent without stale isMaximized reads", () => {
	const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
	assert.match(systemIpc, /const nextMaximized = !readMaximized\(win\)/);
	assert.match(systemIpc, /emitMaximizedState\(win,\s*nextMaximized\)/);
	assert.match(systemIpc, /return nextMaximized/);
	assert.match(systemIpc, /win\.on\("maximize",\s*\(\)\s*=>\s*emitMaximizedState\(win,\s*true\)\)/);
	assert.match(systemIpc, /win\.on\("unmaximize",\s*\(\)\s*=>\s*emitMaximizedState\(win,\s*false\)\)/);
	assert.doesNotMatch(systemIpc, /win\.webContents\.send\(ipcChannels\.appWindowMaximizedChanged,\s*win\.isMaximized\(\)\)/);
	assert.doesNotMatch(systemIpc, /win\.maximize\(\);\s*\n\s*return win\.isMaximized\(\)/);
	// 渲染层禁止乐观翻转：否则会与主进程推送互踩
	assert.doesNotMatch(header, /setMaximized\(\(current\)\s*=>\s*!current\)/);
});

test("window control hover uses solid hover surface", () => {
	assert.match(foundation, /\.window-control:hover \{[\s\S]*?background:\s*var\(--color-bg-hover\);/);
});

test("brand lockup is larger inside the 40px titlebar", () => {
	// 品牌区：官方 pi canvas logo + PiDeck 字标；
	// 功能分支时分支名只保留在 title/aria-label，不上视觉
	assert.match(brand, /PiLogoCanvas size=\{18\}/);
	assert.match(brand, /brand-wordmark/);
	assert.match(brand, /PiDeck · \$\{branch\}/);
	assert.match(sidebar, /list-toolbar flex h-10/);
	assert.doesNotMatch(sidebar, /list-toggle-native floating/);
});

test("mac custom titlebar uses system traffic lights and insets collapsed tabs", () => {
	const header = readFileSync("src/renderer/src/components/AppHeader.tsx", "utf8");
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	const settingsStore = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
	// 右侧 Win 控件只在非 darwin 渲染；mac 靠 hiddenInset 红绿灯。
	assert.match(header, /const showWinWindowControls = platform !== "darwin"/);
	assert.match(shell, /mac-custom-titlebar/);
	assert.match(app, /platform=\{appInfo\.platform\}/);
	assert.match(app, /detectRendererPlatform\(\)/);
	assert.match(settingsStore, /titleBarStyle: useNative[\s\S]*hiddenInset/);
	assert.match(settingsStore, /trafficLightPosition: \{ x: 14, y: 14 \}/);
	assert.match(foundation, /\.wechat-shell\.custom-titlebar-enabled\.mac-custom-titlebar \{[\s\S]*--window-controls-width:\s*0px;/);
	assert.match(foundation, /\.wechat-shell\.custom-titlebar-enabled\.mac-custom-titlebar\.list-collapsed \{[\s\S]*--session-tabs-left-inset:/);
	assert.match(sidebar, /pl-\[max\(0\.625rem,var\(--traffic-lights-width/);
});

test("collapsed sidebar keeps 14px gutter; restore lives in tab bar", () => {
	assert.match(shell, /LIST_COLLAPSED_SIZE = 0/);
	assert.match(foundation, /\.list-collapsed \.shell-panel-list/);
	assert.match(foundation, /\.list-collapsed \.chat-list-pane \{\s*display:\s*none;/);
	assert.doesNotMatch(foundation, /list-toggle-native\.floating/);
	assert.match(tabs, /listCollapsed && props\.onToggleListCollapsed/);
	assert.match(tabs, /PanelLeft/);
	// Tab 栏必须压过透明拖拽层，否则展开按钮点不到
	assert.match(foundation, /\.custom-titlebar-enabled \.session-tabs-bar \{[\s\S]*?z-index:\s*930;/);
});

test("drawer toggle stays on session tab bar right; no gap when drawer open", () => {
	assert.match(tabs, /header-drawer-toggle/);
	assert.match(tabs, /PanelRight/);
	assert.doesNotMatch(tabs, /onToggleDrawer && !props\.drawerOpen/);
	const rail = readFileSync("src/renderer/src/components/workspace/WorkspaceDrawerRail.tsx", "utf8");
	assert.doesNotMatch(rail, /onClose/);
	assert.doesNotMatch(rail, /drawer-rail-close/);
	// 抽屉打开后窗口控件叠在抽屉顶上，会话 Tab 不再预留 144px，开关贴在 Tab 栏右缘。
	// drawer-open 必须同时要求未折叠：折叠后聊天区顶到窗口右缘，Tab 栏仍须让位，
	// 否则抽屉开关会与关闭按钮重叠。
	assert.match(shell, /drawer && !drawerCollapsed \? "drawer-open" : ""/);
	assert.match(foundation, /\.custom-titlebar-enabled \.session-tabs-bar \{[\s\S]*?margin-right:\s*var\(--window-controls-width\);/);
	assert.match(foundation, /\.custom-titlebar-enabled \.shell-panel-drawer \.detail-drawer \{[\s\S]*?padding-top:\s*var\(--window-drag-height\);/);
});

test("streamdown code-block and table chrome share utilities-layer card skin", () => {
	assert.match(stylesEntry, /@import\s+"\.\/styles\/streamdownChrome\.css"\s+layer\(utilities\)\s*;/);
	assert.match(streamdownChrome, /\[data-streamdown="code-block"\] \{[\s\S]*?gap:\s*0;[\s\S]*?padding:\s*0;/);
	assert.match(streamdownChrome, /\[data-streamdown="code-block-body"\] \{[\s\S]*?border:\s*0;[\s\S]*?border-radius:\s*0;/);
	assert.match(streamdownChrome, /\[data-streamdown="table-wrapper"\] \{[\s\S]*?border-radius:\s*12px;/);
	assert.match(streamdownChrome, /\[data-streamdown="code-block-header"\] \{[\s\S]*?height:\s*34px;/);
});
