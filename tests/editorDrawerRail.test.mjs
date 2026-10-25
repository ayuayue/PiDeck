import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync("src/renderer/src/App.tsx", "utf8");
const drawerSurface = readFileSync("src/renderer/src/components/workspace/DrawerSurface.tsx", "utf8");
const drawerPorts = readFileSync("src/renderer/src/hooks/useDrawerPorts.ts", "utf8");
const fileEditorHook = readFileSync("src/renderer/src/hooks/useFileEditor.ts", "utf8");
const zhCN = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const enUS = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("drawer rail no longer exposes the editor as a panel entry", () => {
	// 编辑器阅读面已迁分屏（SessionTabsBar + WorkbenchContent），右侧抽屉不再有 editor 面板
	assert.doesNotMatch(app, /id:\s*"editor"/);
	assert.doesNotMatch(app, /active:\s*drawer === "editor"/);
	assert.doesNotMatch(app, /handleToolDrawerAction\("editor"\)/);
});

test("drawer surface and ports no longer carry the editor panel", () => {
	assert.doesNotMatch(drawerSurface, /drawer === "editor"/);
	assert.doesNotMatch(drawerSurface, /DrawerEditorPort/);
	assert.doesNotMatch(drawerSurface, /t\("editor\.emptyTitle"\)/);
	assert.doesNotMatch(drawerPorts, /DrawerEditorPort/);
	assert.doesNotMatch(drawerPorts, /input\.editorMode/);
});

test("closing the last editor tab resets workbench layout to settings default", () => {
	// 分屏 workbench 的布局重置逻辑与抽屉无关，必须保留
	assert.doesNotMatch(fileEditorHook, /editorTabs\.length === 0 && drawer === "editor"[\s\S]{0,200}?setDrawer\(null\)/);
	const closeTabBlock = fileEditorHook.slice(fileEditorHook.indexOf("if (next.length === 0)"), fileEditorHook.indexOf("if (next.length === 0)") + 500);
	assert.match(closeTabBlock, /contentOpenModeRef\.current/);
	assert.match(closeTabBlock, /setEditorMode\(contentOpenModeRef\.current\)/);
	const closeEditorBlock = fileEditorHook.slice(fileEditorHook.indexOf("const closeEditor = useCallback"), fileEditorHook.indexOf("const closeEditor = useCallback") + 500);
	assert.match(closeEditorBlock, /setEditorMode\(contentOpenModeRef\.current\)/);
});

test("editor drawer empty-state copy is removed from both locales", () => {
	for (const key of ['"editor.fileEditor"', '"editor.emptyTitle"', '"editor.emptyHint"', '"editor.emptyOpenFiles"']) {
		assert.ok(!zhCN.includes(key), `zh-CN should not keep ${key}`);
		assert.ok(!enUS.includes(key), `en-US should not keep ${key}`);
	}
});
