import type { TerminalThemeId } from "../../shared/types/settings";

/**
 * 终端配色的**唯一数据源**。
 *
 * 改动前配色定义有两份：TerminalDock.tsx 里的 TERMINAL_THEMES（xterm ITheme）与
 * foundation.css 里的 `[data-theme]` 变量块（dock 容器/标签页的 9 个 --terminal-* 变量）。
 * 两份手工同步必然漂移，所以这里合并成一份：xterm 主题直接取自 xterm 字段，
 * CSS 变量由 TerminalDock 在挂载/主题变化时用 `element.style.setProperty` 注入。
 *
 * 壁纸透明规则（`[data-bg-image="on"]` 下的 transparent !important）仍留在 CSS 层，
 * inline 注入的变量会被它覆盖 —— 与改动前行为一致（实测 WebGL 渲染器下逐像素等价）。
 */

/** xterm ITheme 子集：只声明我们实际设置的字段 */
export type TerminalXtermTheme = {
	background: string;
	foreground: string;
	cursor: string;
	selectionBackground: string;
};

export type TerminalThemeDef = {
	/** 用户可选主题 id（inherit 是实现概念，不出现在这里） */
	id: Exclude<TerminalThemeId, "inherit">;
	/** 更多菜单里显示的名字（品牌名，不翻译） */
	label: string;
	/** 亮色版配色（"inherit" 派生时用 light） */
	xterm: TerminalXtermTheme;
	/** 深色版配色；仅 "inherit" 派生时使用（显式主题不分明暗） */
	xtermDark?: TerminalXtermTheme;
	/** CSS 变量块：键是 foundation.css 的 `--terminal-*` 变量名（含 `--` 前缀），值原样写入 */
	css: Record<string, string>;
};

/** CSS 变量键集合（所有主题必须一致，由 tests/terminalThemeDefs.test.mjs 断言） */
const TERMINAL_CSS_KEYS = ["--terminal-bg", "--terminal-fg", "--terminal-panel", "--terminal-header", "--terminal-border", "--terminal-muted", "--terminal-active-bg", "--terminal-active-fg", "--terminal-hover"] as const;

/** 构造 css 记录：把「短名 → 值」按固定顺序展开成完整变量名，避免每套主题手写 9 个键漂移。 */
function css(surface: { bg: string; fg: string; panel: string; header: string; border: string; muted: string; activeBg: string; activeFg: string; hover: string }): Record<string, string> {
	const values = [surface.bg, surface.fg, surface.panel, surface.header, surface.border, surface.muted, surface.activeBg, surface.activeFg, surface.hover];
	return Object.fromEntries(TERMINAL_CSS_KEYS.map((key, index) => [key, values[index]]));
}

export const TERMINAL_THEME_DEFS: readonly TerminalThemeDef[] = [
	{
		id: "solarized-light",
		label: "Solarized Light",
		xterm: { background: "#fdf6e3", foreground: "#657b83", cursor: "#268bd2", selectionBackground: "#eee8d5" },
		css: css({
			bg: "#fdf6e3",
			fg: "#657b83",
			panel: "#eee8d5",
			header: "#fdf6e3",
			border: "color-mix(in srgb, #d9d0ad 55%, transparent)",
			muted: "#6c7780",
			activeBg: "#e6f2d7",
			activeFg: "#586e00",
			hover: "#e8dfc3",
		}),
	},
	{
		id: "solarized-dark",
		label: "Solarized Dark",
		xterm: { background: "#002b36", foreground: "#839496", cursor: "#2aa198", selectionBackground: "#073642" },
		css: css({
			bg: "#002b36",
			fg: "#839496",
			panel: "#073642",
			header: "#073642",
			border: "#164b59",
			muted: "#93a1a1",
			activeBg: "#114b58",
			activeFg: "#2aa198",
			hover: "#0f4652",
		}),
	},
	{
		id: "one-dark",
		label: "One Dark",
		xterm: { background: "#282c34", foreground: "#abb2bf", cursor: "#98c379", selectionBackground: "#3e4451" },
		css: css({
			bg: "#282c34",
			fg: "#abb2bf",
			panel: "#21252b",
			header: "#282c34",
			border: "#3a3f4b",
			muted: "#9aa3b4",
			activeBg: "#343b46",
			activeFg: "#98c379",
			hover: "#303640",
		}),
	},
	{
		id: "monokai",
		label: "Monokai",
		xterm: { background: "#272822", foreground: "#f8f8f2", cursor: "#a6e22e", selectionBackground: "#49483e" },
		css: css({
			bg: "#272822",
			fg: "#f8f8f2",
			panel: "#20211c",
			header: "#272822",
			border: "#3e3d32",
			muted: "#cfcfc2",
			activeBg: "#3a3b31",
			activeFg: "#a6e22e",
			hover: "#33342c",
		}),
	},
];

/** 主题定义去掉 id（inherit 的实现体不对外可选） */
type TerminalThemePalette = Omit<TerminalThemeDef, "id">;

/**
 * pi-soft：跟随应用明暗的默认配色（主题 id "inherit" 的实现）。
 * 不作为用户可选 id —— 它就是「继承应用外观」本身，显式列出来会造成
 * 「inherit 和 pi-soft 有什么区别」的歧义。
 */
export const PI_SOFT_THEME: TerminalThemePalette = {
	label: "Pi Soft",
	xterm: { background: "#ffffff", foreground: "#243244", cursor: "#18181b", selectionBackground: "#e4e4e7" },
	xtermDark: { background: "#09090b", foreground: "#e4e4e7", cursor: "#fafafa", selectionBackground: "#3f3f46" },
	css: css({
		// pi-soft 浅色侧：柔绿灰纸感，与暗色 pi-soft 同族（2027-03 从纯白补齐）。
		// 缺这份映射时浅色回落到纯白 #ffffff，在暖灰面板环境里像一块刺眼白板。
		bg: "#f8faf8",
		fg: "#33413a",
		panel: "#eef2ef",
		header: "#f4f7f5",
		border: "color-mix(in srgb, #ccd6d0 55%, transparent)",
		muted: "#75817b",
		activeBg: "transparent",
		activeFg: "#1a7f37",
		hover: "#e3eae6",
	}),
};

/** pi-soft 暗色版：原 foundation.css 的 `:root[data-theme="dark"] .terminal-dock[data-theme="pi-soft"]` 块 */
const PI_SOFT_DARK_CSS = css({
	bg: "#15191d",
	fg: "#d9e2dc",
	panel: "#1b2025",
	header: "#22282e",
	border: "color-mix(in srgb, #2a333a 55%, transparent)",
	muted: "#95a39c",
	activeBg: "transparent",
	activeFg: "#6ee78c",
	hover: "#263039",
});

export type ResolvedTerminalTheme = {
	/** 实际生效的主题 id（inherit 解析后是 pi-soft 的具体承载 id，仅用于调试可读性） */
	dataTheme: string;
	xterm: TerminalXtermTheme;
	css: Record<string, string>;
	/** inherit 暗色版在原 CSS 里额外带 `box-shadow: none`，转为变量保留该例外 */
	transparentShadow: boolean;
};

/** 把设置里的主题 id 解析成实际生效的主题定义（inherit 按应用明暗取 pi-soft 亮/暗版）。 */
export function resolveTerminalTheme(themeId: TerminalThemeId, appTheme: string): ResolvedTerminalTheme {
	if (themeId === "inherit") {
		const dark = appTheme === "dark";
		return {
			dataTheme: "pi-soft",
			xterm: dark && PI_SOFT_THEME.xtermDark ? PI_SOFT_THEME.xtermDark : PI_SOFT_THEME.xterm,
			css: dark ? PI_SOFT_DARK_CSS : PI_SOFT_THEME.css,
			transparentShadow: dark,
		};
	}
	const def = TERMINAL_THEME_DEFS.find((item) => item.id === themeId) ?? TERMINAL_THEME_DEFS[0];
	return { dataTheme: def.id, xterm: def.xterm, css: def.css, transparentShadow: false };
}
