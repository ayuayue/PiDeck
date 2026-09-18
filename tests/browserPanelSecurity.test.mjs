import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const browserPanel = readFileSync("src/renderer/src/components/app/BrowserPanel.tsx", "utf8");
const rendererTypes = readFileSync("src/renderer/src/types.d.ts", "utf8");
const main = readFileSync("src/main/index.ts", "utf8");
// #115 U4：partition/白名单已收敛到共享模块，webview 管线主进程加固与浏览器安全模块都从它导入
const browserSecurity = readFileSync("src/main/browser/browserSecurity.ts", "utf8");
const filesIpc = readFileSync("src/main/ipc/filesIpc.ts", "utf8");

function functionBlock(source, signature, nextSignature) {
	const start = source.indexOf(signature);
	assert.ok(start >= 0, `missing ${signature}`);
	const end = source.indexOf(nextSignature, start + signature.length);
	return source.slice(start, end >= 0 ? end : undefined);
}

test("BrowserPanel uses a fixed persistent partition without popup or file access attributes", () => {
	// The partition constant lives in main (configureBrowserPanelWebviewHost) and is
	// no longer duplicated in the renderer component.
	assert.doesNotMatch(browserPanel, /const BROWSER_PANEL_PARTITION = "persist:pideck-browser-panel"/);
	// 常量唯一定义在共享模块；index.ts 经别名引用同一值
	assert.match(browserSecurity, /export const BROWSER_PANEL_PARTITION = "persist:pideck-browser-panel"/);
	assert.match(browserSecurity, /export function isAllowedBrowserPanelUrl/);
	assert.match(main, /from "\.\/browser\/browserSecurity"/);
	assert.match(main, /session\.fromPartition\(BROWSER_PANEL_PARTITION\)/);
	// 2026-09 第五批 M8：渲染层不再设置 allowfileaccess/allowpopups——主进程
	// will-attach-webview 兜底本来就会剥离这两个属性（index.ts configureBrowserPanelWebviewHost），
	// 渲染层设置只会制造第二事实来源与虚假的安全感。
	assert.doesNotMatch(browserPanel, /allowfileaccess/);
	assert.doesNotMatch(browserPanel, /allowpopups/);
	assert.doesNotMatch(browserPanel, /webviewRef = useRef<any>/);
	assert.doesNotMatch(browserPanel, /MutableRefObject<any>/);
	assert.doesNotMatch(rendererTypes, /WebviewElement[\s\S]*allowpopups/);
	assert.doesNotMatch(rendererTypes, /allowpopups/i);
});

test("BrowserPanel navigation goes through the module-state pending-URL poll loop", () => {
	assert.match(browserPanel, /export function navigateTo\(url: string\)/);
	assert.match(browserPanel, /pendingNavigateUrl = url/);
	assert.match(browserPanel, /moduleState\.tabs\.push\(\{ id, title: "", url \}\)/);
	assert.doesNotMatch(browserPanel, /isAllowedBrowserUrl/);
});

test("main process hardens webPreferences before attaching BrowserPanel guests", () => {
	const attach = functionBlock(main, "function configureBrowserPanelWebviewHost", "\n\nasync function createWindow");
	assert.match(attach, /session\.fromPartition\(BROWSER_PANEL_PARTITION\)/);
	assert.match(attach, /"will-attach-webview"/);
	assert.match(attach, /params\.partition = BROWSER_PANEL_PARTITION/);
	assert.match(attach, /webPreferences\.partition = BROWSER_PANEL_PARTITION/);
	assert.match(attach, /webPreferences\.sandbox = true/);
	assert.match(attach, /webPreferences\.nodeIntegration = false/);
	assert.match(attach, /webPreferences\.contextIsolation = true/);
	assert.match(attach, /webPreferences\.webSecurity = true/);
	assert.match(attach, /delete webPreferences\.preload/);
	assert.match(attach, /delete params\.preload/);
	assert.match(attach, /event\.preventDefault\(\)/);
});

test("BrowserPanel guest navigation, redirects, windows, and permissions default to deny", () => {
	const attach = functionBlock(main, "function configureBrowserPanelWebviewHost", "\n\nasync function createWindow");
	assert.match(attach, /setPermissionCheckHandler\(\(\) => false\)/);
	assert.match(attach, /setPermissionRequestHandler\(\(_webContents, _permission, callback\) => callback\(false\)\)/);
	assert.match(attach, /setDevicePermissionHandler\(\(\) => false\)/);
	assert.match(attach, /webRequest\.onBeforeRequest/);
	assert.match(attach, /details\.resourceType === "mainFrame" \|\| details\.resourceType === "subFrame"/);
	assert.match(attach, /callback\(\{ cancel: true \}\)/);
	assert.match(attach, /guest\.session !== browserPanelSession/);
	assert.match(attach, /guest\.close\(\)/);
	assert.match(attach, /guest\.on\("will-frame-navigate"/);
	assert.match(attach, /guest\.on\("will-redirect"/);
	assert.match(attach, /guest\.setWindowOpenHandler/);
	assert.match(attach, /return \{ action: "deny" \}/);
	assert.match(attach, /if \(isAllowedBrowserPanelUrl\(event\.url\)\) return;/);
});

test("webview hardening is installed before the main window loads renderer content", () => {
	const createWindow = functionBlock(main, "async function createWindow()", "\n\nfunction shouldUseDevRendererUrl");
	const configureIndex = createWindow.indexOf("configureBrowserPanelWebviewHost(createdWindow)");
	const loadIndex = createWindow.indexOf("mainWindow.loadURL");
	assert.ok(configureIndex >= 0, "expected webview hardening setup");
	assert.ok(loadIndex >= 0, "expected renderer load");
	assert.ok(configureIndex < loadIndex, "hardening must be installed before renderer load");
});

test("external browser IPC shares the HTTP(S) protocol gate and Chromium sandbox stays enabled", () => {
	const browserOpenExternal = functionBlock(filesIpc, 'ipcMain.handle(ipcChannels.browserOpenExternal', "\n\n\tipcMain.handle(");
	assert.match(browserOpenExternal, /await openExternalUrl\(url, true\)/);
	assert.doesNotMatch(browserOpenExternal, /shell\.openExternal\(url\)/);
	// Chromium 沙箱默认关闭是刻意的（Windows 安全软件/旧 GPU 驱动会在沙箱初始化触发原生断点），
	// 但只能在用户未显式开启 electronChromiumSandbox 时才附带 no-sandbox；
	// 用户开启沙箱后必须保持 Chromium 默认沙箱，不能无条件追加 no-sandbox。
	assert.match(main, /if \(!electronChromiumSandboxEnabled\) \{\s*\/\/[^\n]*\n\s*app\.commandLine\.appendSwitch\("no-sandbox"\);/);
});
