import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/main/index.ts", "utf8");

test("main window has load and timeout fallbacks for showing the hidden window", () => {
	assert.match(source, /function showMainWindowOnce\(/);
	assert.match(source, /mainWindow\.once\("ready-to-show", showMainWindowOnce\)/);
	assert.match(source, /mainWindow\.webContents\.once\("did-finish-load", showMainWindowOnce\)/);
	assert.match(source, /setTimeout\(showMainWindowOnce, 3000\)/);
});

test("main window records renderer load diagnostics", () => {
	assert.match(source, /mainWindow\.webContents\.on\("did-start-loading"/);
	assert.match(source, /Main window load started/);
	assert.match(source, /mainWindow\.webContents\.on\("did-finish-load"/);
	assert.match(source, /Main window load finished/);
	assert.match(source, /mainWindow\.webContents\.on\(\s*"did-fail-load"/);
	assert.match(source, /Main window load failed/);
	assert.match(source, /mainWindow\.webContents\.on\("render-process-gone"/);
	assert.match(source, /details\.reason === "clean-exit"/);
	assert.match(source, /Main window renderer process gone/);
	assert.match(source, /mainWindow\.webContents\.on\("dom-ready"/);
	assert.match(source, /Boolean\(window\.piDesktop\)/);
	assert.match(source, /Main window preload API availability/);
	assert.match(source, /mainWindow\.webContents\.on\(\s*"console-message"/);
	assert.match(source, /event\.level/);
	assert.match(source, /Main window renderer console error/);
});

test("linux display workaround opens the main window without hidden pre-map", () => {
	assert.match(source, /const showMainWindowImmediately = shouldShowMainWindowImmediately\(\)/);
	assert.match(source, /show: showMainWindowImmediately/);
	// 启动尺寸统一走 applyStartupWindowMode：隐藏态先 maximize 减少首帧跳动，
	// XWayland 兼容层下 showMainWindowImmediately=true 则跳过预映射直接 show。
	assert.match(source, /applyStartupWindowMode\(\s*mainWindow,\s*effectiveStartupMode,\s*showMainWindowImmediately,?\s*\)/s);
	assert.match(source, /if \(showMainWindowImmediately\) \{\s*showMainWindowOnce\(\);\s*\}/s);
});

test("file editor: openEditorTab updater is pure (StrictMode double-invoke safe)", () => {
  // 首次点击文件空白根因：openEditorTab 的 updater 内含 crypto.randomUUID + setActiveTabId，
  // StrictMode 双调用产生两个不同 tab id → activeTabId 与 editorTabs 不一致 → activeTab null。
  // 修复：闭包内读同步 ref 计算 next，setState 传值。
  const source = readFileSync("src/renderer/src/hooks/useFileEditor.ts", "utf8");
  assert.match(source, /editorTabsRef\.current = editorTabs;/);
  assert.match(source, /updater 纯化：StrictMode 双调用下/);
  assert.match(source, /const prev = editorTabsRef\.current;/);
  assert.doesNotMatch(
    source,
    /setEditorTabs\(\(prev\) => \{[\s\S]{0,200}?crypto\.randomUUID/,
  );
  // 渲染层 StrictMode 开启（双调用条件存在）
  const mainSource = readFileSync("src/renderer/src/main.tsx", "utf8");
  assert.match(mainSource, /<React\.StrictMode>/);
});

test("drawer viewer: toggleEditorMode closes drawer when expanding to modal (fix minimize)", () => {
  const source = readFileSync("src/renderer/src/hooks/useFileEditor.ts", "utf8");
  // 展开到 modal 必须收起抽屉（否则最小化时 openDrawer("editor") 命中 toggle 语义关闭抽屉）
  assert.match(source, /展开到 modal：必须收起抽屉/);
  assert.match(source, /setDrawer\(null\);/);
  // updater 外执行副作用（StrictMode 双调用安全）
  assert.match(source, /editorModeRef\.current = next;/);
  // 文件树打开始终 drawer 模式 + 记录来源面板（返回键）
  assert.match(source, /文件树打开始终进抽屉模式/);
  // 编辑器（CodeMirror 6）同步加载，无 Monaco 首帧空白问题；
  // 加载态仍保留给文件内容异步读取（loading state → file-diff-loading）
  const viewer = readFileSync("src/renderer/src/components/app/FileDiffViewer.tsx", "utf8");
  assert.match(viewer, /\{loading && <div className="file-diff-loading">/);
  assert.match(viewer, /<CodeMirrorEditor/);
  assert.match(viewer, /<MergeDiffView/);
});
