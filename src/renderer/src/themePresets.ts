import type { AppAccentMode, AppPaletteId, AppStyleId } from "../../shared/types/settings";
import type { TranslationKey } from "./i18n";

/**
 * 主题色预设（UI 主题扩展点）。
 *
 * 扩展自制主题的方式：
 * 1. 在 foundation.css 新增 `:root[data-accent="<id>"]`（及 dark 变体）覆盖
 *    --color-accent/-strong/-soft 与 --color-logo-green* 系列；
 * 2. 在这里的 ACCENT_PRESETS 追加一条（id/label/色值预览）。
 * 两处同步后，设置页「主题色」下拉即自动出现新选项，无需改业务代码。
 *
 * 注：外观配色（PALETTE_PRESETS）自带推荐主色，accent 不再作为独立下拉暴露在设置页，
 * 仅保留为自定义配色（themePalette="custom"）与旧版数据的兼容字段。
 */
export type AccentPreset = {
	id: AppAccentMode;
	labelKey: TranslationKey;
	/** 预览色（设置页色块展示） */
	preview: string;
};

export const ACCENT_PRESETS: readonly AccentPreset[] = [
	// 出厂默认使用黑白灰；绿色保留为显式可选主题，避免默认界面被高饱和色占据。
	// preview 与 foundation.css 的默认 --color-accent 保持一致（浅色 zinc-900 近黑）。
	{ id: "default", labelKey: "settings.accent.default", preview: "#18181b" },
	// 绿色预览与 foundation.css 的森系绿主色保持一致（#4a7854，参考 Proma 森息配色）。
	{ id: "green", labelKey: "settings.accent.green", preview: "#4a7854" },
	{ id: "blue", labelKey: "settings.accent.blue", preview: "#2563eb" },
	{ id: "purple", labelKey: "settings.accent.purple", preview: "#7c3aed" },
	{ id: "amber", labelKey: "settings.accent.amber", preview: "#b45309" },
	{ id: "rose", labelKey: "settings.accent.rose", preview: "#e11d48" },
];

export const DEFAULT_ACCENT: AppAccentMode = "default";

/**
 * 外观两维模型：样式（形状） × 配色（颜色），两组预设正交。
 *
 * 为什么拆开：旧模型一套「皮肤」同时定形状与颜色，结果纯配色条目（fresh-green、graphite…）
 * 与真有形状差异的条目（terminal）混在同一个列表里；靠半透明面色伪装的「毛玻璃」更是
 * 分栏布局下根本看不出玻璃质感。拆开后列表语义明确，且终端也能换配色。
 *
 * 渲染分工（单一事实源）：
 * - 样式 → `<html data-appearance="<style>">`，只有 terminalSkin.css 这类形状规则；
 * - 配色 → `<html data-palette="<palette>">`，只有 foundation.css 的色板变量块；
 * - 主色：配色自带推荐 accent（选配色时设置页联动写入 settings.accent），
 *   custom 配色沿用用户自己的 settings.accent。
 *
 * 扩展方式：在 foundation.css 新增 `:root[data-palette="<id>"]` 与
 * `:root[data-theme="dark"][data-palette="<id>"]` 色板块，再在本文件 PALETTE_PRESETS 追加一条；
 * id 集合必须与 shared/themeSkinMigration.ts 的 APP_PALETTE_IDS 一致（测试守卫）。
 */
export type StylePreset = {
	id: AppStyleId;
	labelKey: TranslationKey;
	/** 样式一句话描述（设置页卡片悬浮提示） */
	descKey: TranslationKey;
};

export const STYLE_PRESETS: readonly StylePreset[] = [
	{
		id: "classic",
		labelKey: "settings.style.classic",
		descKey: "settings.style.classicDesc",
	},
	{
		id: "terminal",
		labelKey: "settings.style.terminal",
		descKey: "settings.style.terminalDesc",
	},
];

export type PalettePreset = {
	id: AppPaletteId;
	labelKey: TranslationKey;
	/** 配色一句话描述（设置页卡片悬浮提示） */
	descKey: TranslationKey;
	/** 配色推荐主色（AppAccentMode），选择该配色时 UI 联动写入 settings.accent；custom 为 undefined */
	accent?: AppAccentMode;
	/** 预览主色（设置页卡片主色块） */
	preview: string;
	/** 设置页卡片预览用的表面色块（浅色观感）；custom 无内置色板，用占位灰 */
	previewSurfaces: {
		background: string;
		sidebar: string;
		panel: string;
		accent: string;
		border: string;
	};
};

export const PALETTE_PRESETS: readonly PalettePreset[] = [
	{
		id: "classic-green",
		labelKey: "settings.palette.classicGreen",
		descKey: "settings.palette.classicGreenDesc",
		// 出厂默认：中性黑白灰（表面 = :root 默认中性白灰，无 CSS 覆盖块；
		// 主色 = data-accent="default" 的近黑/近白），与旧版出厂观感一致。
		accent: "default",
		preview: "#ffffff",
		previewSurfaces: {
			background: "#ffffff",
			sidebar: "#ffffff",
			panel: "#fafafa",
			accent: "#18181b",
			border: "#dfdfdf",
		},
	},
	{
		id: "fresh-green",
		labelKey: "settings.palette.freshGreen",
		descKey: "settings.palette.freshGreenDesc",
		// 全屏森系绿：纸感浅绿表面 + 鼠尾草绿主色（参考 Proma theme-forest-light），
		// 主色 = data-accent="green"（#4a7854）。
		accent: "green",
		preview: "#f6f7f2",
		previewSurfaces: {
			background: "#f6f7f2",
			sidebar: "#ecefe6",
			panel: "#f6f7f2",
			accent: "#4a7854",
			border: "#c8cfbf",
		},
	},
	{
		id: "graphite",
		labelKey: "settings.palette.graphite",
		descKey: "settings.palette.graphiteDesc",
		accent: "default",
		preview: "#e2e2e2",
		previewSurfaces: {
			background: "#ececec",
			sidebar: "#e3e3e3",
			panel: "#f8f8f8",
			accent: "#18181b",
			border: "#d0d0d0",
		},
	},
	{
		id: "sea-blue",
		labelKey: "settings.palette.seaBlue",
		descKey: "settings.palette.seaBlueDesc",
		accent: "blue",
		preview: "#eaf3fb",
		previewSurfaces: {
			background: "#eef5fb",
			sidebar: "#e4eef7",
			panel: "#ffffff",
			accent: "#2563eb",
			border: "#d3e1ec",
		},
	},
	{
		id: "warm-beige",
		labelKey: "settings.palette.warmBeige",
		descKey: "settings.palette.warmBeigeDesc",
		accent: "amber",
		preview: "#f6f1e8",
		previewSurfaces: {
			background: "#f7f2ea",
			sidebar: "#f0e9dd",
			panel: "#fffdf8",
			accent: "#b45309",
			border: "#ded2bf",
		},
	},
	{
		id: "parchment",
		labelKey: "settings.palette.parchment",
		descKey: "settings.palette.parchmentDesc",
		// 主色由 CSS 块接管（同 tui 先例）；default 只用来满足字段契约。
		accent: "default",
		preview: "#f5f4ed",
		previewSurfaces: {
			background: "#f5f4ed",
			sidebar: "#ece9df",
			panel: "#faf9f5",
			accent: "#b0562f",
			border: "#dcd8ca",
		},
	},
	{
		id: "tui",
		labelKey: "settings.palette.tui",
		descKey: "settings.palette.tuiDesc",
		// 终端（TUI）配色：整套移植 pi 交互模式的终端主题——面色/文字/边框取 pi theme 的
		// pageBg / cardBg / text / muted / border，Markdown 取 mdHeading/mdLink/mdCode/mdQuote 系列
		// （okhsl 转 sRGB，与 pi TUI 屏幕上看到的色一致）。形状不在这里，见 STYLE_PRESETS 的 terminal。
		// 主色 = purple：pi 的 accent 是 violet，本应用无 violet 档，取最近的一档。
		accent: "purple",
		preview: "#f7f8f7",
		previewSurfaces: {
			background: "#efeeee",
			sidebar: "#e9e8e8",
			panel: "#f7f6f6",
			accent: "#7459b4",
			border: "#9aa2a7",
		},
	},
	{
		id: "custom",
		labelKey: "settings.palette.custom",
		descKey: "settings.palette.customDesc",
		// custom 没有内置色板：颜色完全来自自定义主题包 / customThemeOverrides，
		// 因此不联动 accent（保留用户自己的 settings.accent），预览用中性占位灰。
		preview: "#9ca3af",
		previewSurfaces: {
			background: "#f4f4f5",
			sidebar: "#e9e9ec",
			panel: "#fafafa",
			accent: "#9ca3af",
			border: "#d4d4d8",
		},
	},
];

/** 出厂样式：classic（无任何形状覆盖） */
export const DEFAULT_STYLE: AppStyleId = "classic";

/** 出厂配色：classic-green（中性黑白灰，与旧版出厂观感一致） */
export const DEFAULT_PALETTE: AppPaletteId = "classic-green";
