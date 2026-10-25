import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mainIpcSource } from "./helpers/mainIpcSources.mjs";

const source = mainIpcSource;

test("main process syncs native titlebar appearance with app theme", () => {
	assert.match(source, /function applyNativeThemeSource\(settings: AppSettings\)/);
	// 赋值右侧可能被格式化换行：\s* 容忍（三种主题枚举的语义不变）。
	assert.match(source, /nativeTheme\.themeSource =\s*settings\.theme === "system"/);
	assert.match(source, /resolveAppColorScheme/);
	assert.match(source, /applyNativeThemeSource\(settingsStore\.get\(\)\);[\s\S]*new BrowserWindow/);
	assert.match(source, /"theme" in patch[\s\S]*applyNativeThemeSource\(settings\)/);
	assert.match(source, /themeScheduleLightStart/);
});
