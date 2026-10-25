import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 底栏 dock 主题按钮的翻转规则（themeAppearance.toggleThemeMode）：
 * 手动模式浅色 ⇄ 暗色直接对翻；跟随系统/跟随时间点击视为退出自动模式，
 * 按「当前实际解析出的明暗」翻到对面——保证每次点击都有可见变化。
 */

const { toggleThemeMode } = loadTsCommonJs("src/renderer/src/themeAppearance.ts");

test("manual modes flip light ↔ dark", () => {
	assert.equal(toggleThemeMode({ theme: "light" }, true), "dark");
	assert.equal(toggleThemeMode({ theme: "dark" }, false), "light");
});

test("system mode exits to the opposite of the OS preference", () => {
	assert.equal(toggleThemeMode({ theme: "system" }, true), "light");
	assert.equal(toggleThemeMode({ theme: "system" }, false), "dark");
});

test("schedule mode exits to the opposite of the time-resolved theme", () => {
	// 默认浅色时段 07:00–19:00：中午解析为浅色 → 翻到暗色；深夜解析为暗色 → 翻到浅色
	assert.equal(toggleThemeMode({ theme: "schedule" }, true, new Date("2026-08-29T12:00:00")), "dark");
	assert.equal(toggleThemeMode({ theme: "schedule" }, true, new Date("2026-08-29T23:00:00")), "light");
});
