import type { AppPaletteId, AppSkinId, AppStyleId } from "./types/settings";

/**
 * 外观的「样式 × 配色」两维模型（纯契约层，main / renderer 共用）。
 *
 * 旧模型是单维 themeSkin（一套皮肤同时定形状与颜色），导致「毛玻璃 / 液态玻璃」这类
 * 只靠半透明面色伪装的条目和纯配色条目混在同一个列表里。现在拆成：
 * - 样式（AppStyleId）→ `data-appearance`，只给形状/排版/装饰；
 * - 配色（AppPaletteId）→ `data-palette`，只给颜色 token。
 * 两者正交，任意组合成立（如 terminal 样式 + graphite 配色）。
 *
 * id 列表放在 shared 层是因为主进程（SettingsStore 迁移、遥测）与渲染层（主题预设、CSS 守卫）
 * 都要用；renderer 的 STYLE_PRESETS / PALETTE_PRESETS 必须与本文件逐项一致，
 * 由 tests/appearanceThemes.test.mjs 守卫。
 */
export const APP_STYLE_IDS = ["classic", "terminal"] as const;

export const APP_PALETTE_IDS = ["classic-green", "fresh-green", "graphite", "sea-blue", "warm-beige", "parchment", "tui", "custom"] as const;

export const DEFAULT_APP_STYLE: AppStyleId = "classic";

export const DEFAULT_APP_PALETTE: AppPaletteId = "classic-green";

/**
 * 旧 themeSkin → (样式, 配色) 的迁移表。
 *
 * - 纯配色皮肤（fresh-green / graphite / sea-blue / warm-beige）落到 classic 样式；
 * - terminal 自带 TUI 色板，拆成「terminal 样式 + tui 配色」，观感与升级前一致；
 * - glass / liquid-glass 已下线（分栏布局下玻璃面板背后只有低频渐变，看不出磨砂质感），
 *   迁移到默认观感而不是留一个无法渲染的 id；
 * - custom 保持「颜色完全来自主题包」的语义，落到 custom 配色。
 */
export const LEGACY_SKIN_MAP: Record<AppSkinId, { themeStyle: AppStyleId; themePalette: AppPaletteId }> = {
	"classic-green": { themeStyle: "classic", themePalette: "classic-green" },
	"fresh-green": { themeStyle: "classic", themePalette: "fresh-green" },
	graphite: { themeStyle: "classic", themePalette: "graphite" },
	"sea-blue": { themeStyle: "classic", themePalette: "sea-blue" },
	"warm-beige": { themeStyle: "classic", themePalette: "warm-beige" },
	terminal: { themeStyle: "terminal", themePalette: "tui" },
	glass: { themeStyle: "classic", themePalette: "classic-green" },
	"liquid-glass": { themeStyle: "classic", themePalette: "classic-green" },
	custom: { themeStyle: "classic", themePalette: "custom" },
};

export function isAppStyleId(value: unknown): value is AppStyleId {
	return typeof value === "string" && (APP_STYLE_IDS as readonly string[]).includes(value);
}

/** 是否旧版单维皮肤 id（用于把旧主题包的 base 归一成样式 id，而不是直接报错）。 */
export function isLegacyAppSkinId(value: unknown): value is AppSkinId {
	return typeof value === "string" && Object.hasOwn(LEGACY_SKIN_MAP, value);
}

export function isAppPaletteId(value: unknown): value is AppPaletteId {
	return typeof value === "string" && (APP_PALETTE_IDS as readonly string[]).includes(value);
}

/**
 * 把任意来源（旧 settings.json / 旧快照）归一成 (themeStyle, themePalette)。
 *
 * 取值优先级：逐字段校验后的新字段 > 旧 themeSkin 迁移结果 > 出厂默认。
 * 逐字段而不是整体回退：只缺 themePalette 的历史数据仍能保留用户选的样式。
 */
export function normalizeThemeAppearance(input: { themeStyle?: unknown; themePalette?: unknown; themeSkin?: unknown }): { themeStyle: AppStyleId; themePalette: AppPaletteId } {
	const legacy = typeof input.themeSkin === "string" ? LEGACY_SKIN_MAP[input.themeSkin as AppSkinId] : undefined;
	const themeStyle = isAppStyleId(input.themeStyle) ? input.themeStyle : (legacy?.themeStyle ?? DEFAULT_APP_STYLE);
	const themePalette = isAppPaletteId(input.themePalette) ? input.themePalette : (legacy?.themePalette ?? DEFAULT_APP_PALETTE);
	return { themeStyle, themePalette };
}
