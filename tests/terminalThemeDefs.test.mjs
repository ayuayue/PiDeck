import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 终端配色单一数据源回归测试。
 *
 * 背景：改动前配色定义有两份——TerminalDock.tsx 里的 TERMINAL_THEMES（xterm ITheme）
 * 与 foundation.css 里的 `[data-theme]` 变量块（9 个 --terminal-* CSS 变量），手工同步
 * 必然漂移。现在唯一数据源是 renderer/src/terminalThemes.ts，CSS 变量由 TerminalDock
 * 运行时注入。本测试锁住：数据源完整性、inherit 的跟随语义、以及 foundation.css 里
 * 旧变量块确实已删（防止回潮）。
 */
function loadTerminalThemes() {
	return loadTsCommonJs("src/renderer/src/terminalThemes.ts");
}

const FOUNDATION_CSS = "src/renderer/src/styles/foundation.css";

test("TERMINAL_THEME_DEFS 覆盖 4 个显式主题，每个都有 label 与亮/暗 xterm 配色", () => {
	const { TERMINAL_THEME_DEFS } = loadTerminalThemes();
	// loadTsCommonJs 在 vm sandbox 里加载，返回的数组是另一个 realm 的 Array 实例，
	// 直接 deepEqual 会因原型不同而误报，先展开成测试侧数组
	assert.deepEqual([...TERMINAL_THEME_DEFS.map((def) => def.id)], ["solarized-light", "solarized-dark", "one-dark", "monokai"]);
	for (const def of TERMINAL_THEME_DEFS) {
		assert.ok(def.label, `${def.id} 缺 label`);
		assert.equal(typeof def.xterm.background, "string", `${def.id} 缺 xterm.background`);
		if (def.xtermDark) {
			assert.equal(typeof def.xtermDark.background, "string", `${def.id} 缺 xtermDark.background`);
		}
	}
});

test("resolveTerminalTheme inherit：浅色用上游柔绿纸感值，暗色切 PI_SOFT_DARK 并保留无阴影例外", () => {
	const { resolveTerminalTheme } = loadTerminalThemes();
	const light = resolveTerminalTheme("inherit", "light");
	assert.equal(light.dataTheme, "pi-soft");
	assert.equal(light.css["--terminal-bg"], "#f8faf8");
	assert.equal(light.transparentShadow, false);

	const dark = resolveTerminalTheme("inherit", "dark");
	assert.equal(dark.dataTheme, "pi-soft");
	assert.equal(dark.css["--terminal-bg"], "#15191d");
	assert.equal(dark.transparentShadow, true);
});

test("resolveTerminalTheme 显式主题：dataTheme 即主题 id，暗色 app 下取 dark xterm 变体", () => {
	const { resolveTerminalTheme, TERMINAL_THEME_DEFS } = loadTerminalThemes();
	const def = TERMINAL_THEME_DEFS.find((candidate) => candidate.id === "solarized-dark");
	const resolved = resolveTerminalTheme("solarized-dark", "dark");
	assert.equal(resolved.dataTheme, "solarized-dark");
	assert.equal(resolved.css["--terminal-bg"], "#002b36");
	assert.equal(resolved.transparentShadow, false);
	assert.deepEqual(resolved.xterm, def.xtermDark ?? def.xterm);
});

test("foundation.css 不再有按 data-theme 硬编码的终端变量块（唯一数据源回潮守卫）", () => {
	const css = readFileSync(FOUNDATION_CSS, "utf8");
	assert.doesNotMatch(css, /\.terminal-dock\[data-theme=/, "foundation.css 出现了 .terminal-dock[data-theme] 变量块，配色定义回潮成双份");
	assert.doesNotMatch(css, /:root\[data-theme="dark"\] \.terminal-dock/, "暗色 pi-soft 覆盖块仍在 CSS 里（已迁移到 terminalThemes.ts 的 transparentShadow 语义）");
});

test("foundation.css 壁纸透明规则带 !important 且 box-shadow 走 --terminal-shadow 变量", () => {
	const css = readFileSync(FOUNDATION_CSS, "utf8");
	// 主题变量由 TerminalDock inline 注入，普通声明压不过 inline，壁纸透明必须 !important
	assert.match(css, /--terminal-bg: transparent !important/);
	// inherit 暗色的 box-shadow:none 例外由 JS 注入 --terminal-shadow: none 表达
	assert.match(css, /box-shadow: var\(--terminal-shadow,/);
});
