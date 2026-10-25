import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * issue #297 回归：主题「跟随系统」+ 图片背景时，系统深浅色切换后界面不同步。
 *
 * 根因：明暗监听只直接改 data-theme，壁纸注入 effect（依赖数组只有 settings 字段）
 * 不重跑——上一主题明暗烤进 root.style 的 inline 壁纸 token（color-mix 基色、遮罩 rgb）
 * 压过样式表，界面卡死在旧主题；点一次「保存」改变 settings 才恢复。
 *
 * 修复：系统明暗（systemPrefersDark）与跟随时间到达边界（scheduleNow）提为 state，
 * resolvedTheme 派生值进入「外观应用」与「壁纸注入」两个 effect 的依赖数组，
 * 明暗翻转即重算壁纸 token。
 *
 * 后续回归（自定义主题亮暗切换，如内置示例「莓果夜色」）：依赖数组补齐只保证 effect
 * 重跑，但注入 effect 读 root.dataset.theme 选档——data-theme 由外观应用 effect 经
 * startViewTransition 异步写入，重跑时仍是旧明暗，错档 token 注入 inline 样式后压过
 * 样式表，界面停在上一档。isDark 必须改用 resolvedTheme（与写入值同源派生，即时）。
 */

// 外观域已从 App.tsx 迁到 hooks/appearance/useAppAppearance.ts（useAppAppearance）
const app = readFileSync("src/renderer/src/hooks/appearance/useAppAppearance.ts", "utf8");

test("system color-scheme change feeds a state, not a direct attribute write", () => {
	// matchMedia change 监听必须经 setState 驱动派生明暗，才能让壁纸 effect 感知翻转
	assert.match(app, /setSystemPrefersDark\(Boolean\(media\.matches\)\)/);
	// resolvedTheme 由 resolveAppColorScheme 派生，携带 systemPrefersDark
	assert.match(app, /resolveAppColorScheme\(\{[\s\S]{0,200}?systemPrefersDark,\s*\n\s*now: scheduleNow/s);
});

test("wallpaper injection effect depends on the resolved theme", () => {
	// 壁纸/自定义覆盖注入 effect 的依赖数组必须包含 resolvedTheme——
	// 缺了它，明暗翻转后旧主题烤进的 inline token 焊死在 root.style 上（issue #297）
	// 锚定 effect 结尾的 --wallpaper-floating-alpha 清理分支后紧跟的依赖数组
	const wallpaperEffect = app.match(/--wallpaper-floating-alpha"\);\n[\t ]*\}[\s\S]*?\}, \[([^\]]*)\]\);/);
	assert.ok(wallpaperEffect, "wallpaper injection effect not found");
	assert.match(wallpaperEffect[1], /resolvedTheme/);
});

test("appearance application effect also tracks the resolved theme", () => {
	// applyAppearanceAttributes effect 同样以 resolvedTheme 为依赖（跟随时间到点也靠它重应用）
	const appearanceEffect = app.match(/applyAppearanceAttributes\(document\.documentElement, settings, systemPrefersDark\);[\s\S]*?\}, \[([^\]]*)\]\);/);
	assert.ok(appearanceEffect, "appearance application effect not found");
	assert.match(appearanceEffect[1], /resolvedTheme/);
});

test("token injection derives isDark from resolvedTheme, not the deferred dataset.theme", () => {
	// 注入 effect（自定义主题快照 + 壁纸）读 root.dataset.theme 会拿到 View Transition
	// 异步写入前的旧明暗：自定义主题注入错档 token 且 inline 压过样式表，亮暗切换后
	// 界面停留在上一档。isDark 必须用 resolvedTheme（与 data-theme 写入值同源派生）。
	const injectionEffect = app.match(/applyCustomThemeTokens\(root, settings, isDark\);[\s\S]*?\}, \[([^\]]*)\]\);/);
	assert.ok(injectionEffect, "token injection effect not found");
	assert.match(app, /const isDark = resolvedTheme === "dark";/);
	assert.doesNotMatch(app, /isDark = root\.dataset\.theme === "dark"/);
});
