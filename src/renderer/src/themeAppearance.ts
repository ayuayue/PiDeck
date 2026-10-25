import { resolveAppColorScheme } from "../../shared/themeSchedule";
import type { AppSettings, AppThemeMode } from "../../shared/types";
import { SKIN_PRESETS } from "./themePresets";

/** 外观相关设置子集：明暗（含跟随时间）、外观主题、主色 */
export type AppearanceSettings = Pick<AppSettings, "theme" | "themeScheduleLightStart" | "themeScheduleDarkStart" | "themeSkin" | "accent">;

/**
 * 底栏 dock 主题按钮：点击在浅色/暗色之间翻转。
 * 手动模式直接对翻；跟随系统/跟随时间点击视为退出自动模式，
 * 按「当前实际解析出的明暗」翻到对面——保证每次点击都有可见变化
 * （system 的解析结果可能与刚离开的手动主题相同，若进循环会出现「点了没反应」）。
 */
export function toggleThemeMode(appearance: Pick<AppSettings, "theme" | "themeScheduleLightStart" | "themeScheduleDarkStart">, systemPrefersDark: boolean, now: Date = new Date()): AppThemeMode {
	if (appearance.theme === "light") return "dark";
	if (appearance.theme === "dark") return "light";
	const resolved = resolveAppColorScheme({ ...appearance, systemPrefersDark, now });
	return resolved === "dark" ? "light" : "dark";
}

/**
 * 把外观设置应用到 <html> 的 data-* 属性（data-theme / data-appearance / data-accent）。
 *
 * App.tsx（持久化 settings，含跟随系统的 media 监听与跟随时间的定时器）与
 * 设置弹窗（草稿实时预览）共用这一份实现，保证「预览」与「保存后」渲染结果一致：
 * - data-theme：浅/暗（system 由调用方传入 systemPrefersDark）；
 * - data-appearance：外观主题 id，驱动 foundation.css 的 [data-appearance] 表面色板块；
 * - data-accent：外观主题自带推荐主色（SKIN_PRESETS[].accent），custom 沿用 settings.accent；
 *   既有依赖（PiLogoCanvas / CodeMirror / sonner）按 data-theme / data-accent 刷新。
 */
export function applyAppearanceAttributes(root: HTMLElement, settings: AppearanceSettings, systemPrefersDark: boolean) {
	const resolvedTheme = resolveAppColorScheme({
		theme: settings.theme,
		themeScheduleLightStart: settings.themeScheduleLightStart,
		themeScheduleDarkStart: settings.themeScheduleDarkStart,
		systemPrefersDark,
	});
	root.dataset.theme = resolvedTheme;
	root.dataset.appearance = settings.themeSkin;
	const skinPreset = SKIN_PRESETS.find((p) => p.id === settings.themeSkin);
	const effectiveAccent = settings.themeSkin === "custom" || !skinPreset ? settings.accent : skinPreset.accent;
	root.dataset.accent = effectiveAccent;
}
