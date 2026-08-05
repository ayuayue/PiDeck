import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const drawerSurface = readFileSync("src/renderer/src/components/workspace/DrawerSurface.tsx", "utf8");
const fileEditorHook = readFileSync("src/renderer/src/hooks/useFileEditor.ts", "utf8");
const zhCN = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const enUS = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("drawer rail exposes the editor as a first-class panel entry", () => {
  // 编辑器入口与 files/git/browser 平级，复用同一套 toggle 语义
  assert.match(app, /id:\s*"editor"/);
  assert.match(app, /label:\s*t\("editor\.fileEditor"\)/);
  assert.match(app, /active:\s*drawer === "editor"/);
  assert.match(app, /handleToolDrawerAction\("editor"\)/);
});

test("editor drawer renders an empty state instead of requiring an active tab", () => {
  // 编辑器分支不得再以 activeTab 为整体渲染前提：空 tab 时由面板自身承载空状态
  assert.match(drawerSurface, /drawer === "editor" && !drawerCollapsed\s*\?/);
  assert.doesNotMatch(drawerSurface, /drawer === "editor" && !drawerCollapsed && editor\.activeTab/);
  assert.match(drawerSurface, /t\("editor\.emptyTitle"\)/);
  assert.match(drawerSurface, /t\("editor\.emptyHint"\)/);
  assert.match(drawerSurface, /t\("editor\.emptyOpenFiles"\)/);
  // 空状态的引导按钮切到文件面板（文件是文件，编辑器是编辑器，经 rail 往返）
  assert.match(drawerSurface, /chrome\.onOpenDrawer\("files"\)/);
});

test("closing the last editor tab keeps the panel open and resets modal mode", () => {
  // 旧行为：tab 清空即 setDrawer(null) 自动关抽屉——编辑器成为一等面板后必须移除
  assert.doesNotMatch(
    fileEditorHook,
    /editorTabs\.length === 0 && drawer === "editor"[\s\S]{0,200}?setDrawer\(null\)/,
  );
  // 残留 modal 模式会让抽屉分支（editorMode === "drawer" 才渲染）空白，关闭路径必须复位
  const closeTabBlock = fileEditorHook.slice(fileEditorHook.indexOf("if (next.length === 0)"), fileEditorHook.indexOf("if (next.length === 0)") + 500);
  assert.match(closeTabBlock, /editorModeRef\.current = "drawer"/);
  assert.match(closeTabBlock, /setEditorMode\("drawer"\)/);
  const closeEditorBlock = fileEditorHook.slice(fileEditorHook.indexOf("const closeEditor = useCallback"), fileEditorHook.indexOf("const closeEditor = useCallback") + 500);
  assert.match(closeEditorBlock, /setEditorMode\("drawer"\)/);
});

test("editor empty-state copy exists in both locales", () => {
  for (const key of ['"editor.emptyTitle"', '"editor.emptyHint"', '"editor.emptyOpenFiles"']) {
    assert.ok(zhCN.includes(key), `zh-CN missing ${key}`);
    assert.ok(enUS.includes(key), `en-US missing ${key}`);
  }
});
