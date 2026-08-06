import type { AppAccentMode, AppSkinId } from "../../shared/types/settings";

/**
 * 主题色预设（UI 主题扩展点）。
 *
 * 扩展自制主题的方式：
 * 1. 在 foundation.css 新增 `:root[data-accent="<id>"]`（及 dark 变体）覆盖
 *    --color-accent/-strong/-soft 与 --color-logo-green* 系列；
 * 2. 在这里的 ACCENT_PRESETS 追加一条（id/label/色值预览）。
 * 两处同步后，设置页「主题色」下拉即自动出现新选项，无需改业务代码。
 */
export type AccentPreset = {
	id: AppAccentMode;
	labelKey: string;
	/** 预览色（设置页色块展示） */
	preview: string;
};

export const ACCENT_PRESETS: readonly AccentPreset[] = [
	// 出厂默认使用黑白灰；绿色保留为显式可选主题，避免默认界面被高饱和色占据。
	// preview 与 foundation.css 的默认 --color-accent 保持一致（浅色 zinc-900 近黑）。
	{ id: "default", labelKey: "settings.accent.default", preview: "#18181b" },
	{ id: "green", labelKey: "settings.accent.green", preview: "#238636" },
	{ id: "blue", labelKey: "settings.accent.blue", preview: "#2563eb" },
	{ id: "purple", labelKey: "settings.accent.purple", preview: "#7c3aed" },
	{ id: "amber", labelKey: "settings.accent.amber", preview: "#b45309" },
	{ id: "rose", labelKey: "settings.accent.rose", preview: "#e11d48" },
];

export const DEFAULT_ACCENT: AppAccentMode = "default";

/**
 * 皮肤（换肤）预设：覆盖 foundation.css 的 bg/border 色板，与 accent（主题色）正交。
 *
 * 扩展方式：追加一条 SkinPreset（id/labelKey/preview/light/dark 两套变量覆盖），
 * 设置页「皮肤」下拉自动出现。变量键 = foundation.css 的 --color-* 去掉前缀；
 * classic-green 为出厂皮肤（空覆盖，直接使用 :root 默认中性白底 + 默认中性灰主题色）。
 *
 * 自定义主题：themeSkin="custom" 时，App.tsx 将 customThemeOverrides 叠加应用；
 * 背景图走 backgroundImage / backgroundImageOpacity 设置项。
 */
export type SkinPreset = {
	id: AppSkinId;
	labelKey: string;
	/** 预览色（设置页色块展示） */
	preview: string;
	/** 浅色主题变量覆盖：--color-* 键（不含前缀）→ 值 */
	light: Record<string, string>;
	/** 暗色主题变量覆盖：--color-* 键（不含前缀）→ 值 */
	dark: Record<string, string>;
};

export const SKIN_PRESETS: readonly SkinPreset[] = [
	{
		id: "classic-green",
		labelKey: "settings.skin.classicGreen",
		preview: "#ffffff",
		light: {},
		dark: {},
	},
	{
		id: "graphite",
		labelKey: "settings.skin.graphite",
		preview: "#e2e2e2",
		light: {
			"bg-app": "#ececec",
			"bg-sidebar": "#e3e3e3",
			"bg-panel": "#f8f8f8",
			"bg-muted": "#e9e9e9",
			"bg-hover": "#e9e9e9",
			"bg-active": "#dedede",
			"border-subtle": "#d8d8d8",
			"border-default": "#d0d0d0",
			"border-strong": "#c7c7c7",
		},
		dark: {
			"bg-app": "#1b1b1b",
			"bg-sidebar": "#222222",
			"bg-panel": "#262626",
			"bg-muted": "#303030",
			"bg-hover": "#303030",
			"bg-active": "#383838",
			"border-subtle": "#3a3a3a",
			"border-default": "#444444",
			"border-strong": "#4f4f4f",
		},
	},
	{
		id: "sea-blue",
		labelKey: "settings.skin.seaBlue",
		preview: "#eaf3fb",
		light: {
			"bg-app": "#eef5fb",
			"bg-sidebar": "#e4eef7",
			"bg-panel": "#ffffff",
			"bg-muted": "#e8f0f7",
			"bg-hover": "#e8f0f7",
			"bg-active": "#dfeaf3",
			"border-subtle": "#dbe7f0",
			"border-default": "#d3e1ec",
			"border-strong": "#c9d9e6",
		},
		dark: {
			"bg-app": "#101a24",
			"bg-sidebar": "#15212d",
			"bg-panel": "#182634",
			"bg-muted": "#21303f",
			"bg-hover": "#21303f",
			"bg-active": "#2a3a4b",
			"border-subtle": "#2c3d4e",
			"border-default": "#36495c",
			"border-strong": "#415668",
		},
	},
	{
		id: "warm-beige",
		labelKey: "settings.skin.warmBeige",
		preview: "#f6f1e8",
		light: {
			"bg-app": "#f7f2ea",
			"bg-sidebar": "#f0e9dd",
			"bg-panel": "#fffdf8",
			"bg-muted": "#f0e9dd",
			"bg-hover": "#f0e9dd",
			"bg-active": "#e8dfd0",
			"border-subtle": "#e6dccb",
			"border-default": "#ded2bf",
			"border-strong": "#d4c6b0",
		},
		dark: {
			"bg-app": "#1e1a15",
			"bg-sidebar": "#26211a",
			"bg-panel": "#2b251d",
			"bg-muted": "#352e24",
			"bg-hover": "#352e24",
			"bg-active": "#3e362b",
			"border-subtle": "#453c2f",
			"border-default": "#51473a",
			"border-strong": "#5d5344",
		},
	},
];

/** 出厂皮肤：classic-green（中性白底 + 黑白灰默认主题，= :root 默认） */
export const DEFAULT_SKIN: AppSkinId = "classic-green";
