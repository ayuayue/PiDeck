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
	assert.match(source, /if \(!showMainWindowImmediately\) \{\s*mainWindow\.maximize\(\);\s*\}/s);
	assert.match(source, /if \(showMainWindowImmediately\) \{\s*showMainWindowOnce\(\);\s*\}/s);
});
