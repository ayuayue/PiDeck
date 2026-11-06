import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
const zhCN = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const enUS = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

const { STYLE_PRESETS, PALETTE_PRESETS, DEFAULT_STYLE, DEFAULT_PALETTE, ACCENT_PRESETS } = loadTsCommonJs("src/renderer/src/themePresets.ts");
const { CUSTOM_THEME_BASE_SKINS } = loadTsCommonJs("src/shared/customThemes.ts");
const { APP_STYLE_IDS, APP_PALETTE_IDS, LEGACY_SKIN_MAP, normalizeThemeAppearance } = loadTsCommonJs("src/shared/themeSkinMigration.ts");

/**
 * 外观两维模型契约（样式 × 配色）：
 * - STYLE_PRESETS（形状）只有 terminal 这类真形状差异；PALETTE_PRESETS（颜色）只有色板。
 *   旧模型把两者混成一条「皮肤」列表，结果是纯换色的条目和真换形状的条目并列，
 *   用户看不出区别——本文件守住「各自只干自己的事」。
 * - 样式只写 data-appearance（字体/圆角/消息标记），配色只写 data-palette（色板变量）；
 *   两边 id 必须与 shared/themeSkinMigration.ts 的 APP_STYLE_IDS / APP_PALETTE_IDS 一致；
 * - 每套配色自带明暗两版（light 块 + `[data-theme="dark"]` 变体），且必须覆盖完整色板，
 *   否则会出现「换了配色但某些面还是别的配色的颜色」；
 * - 所有新增 i18n key（labelKey/descKey）在 zh-CN / en-US 两套文案中同步存在。
 */
const REQUIRED_THEME_TOKENS = [
	"--color-bg-app",
	"--color-bg-sidebar",
	"--color-bg-panel",
	"--color-bg-muted",
	"--color-bg-hover",
	"--color-bg-active",
	"--color-text-primary",
	"--color-text-secondary",
	"--color-text-tertiary",
	"--color-border-subtle",
	"--color-border-default",
	"--color-border-strong",
	"--color-chat-card-bg",
	"--color-chat-muted-bg",
	"--color-chat-control-bg",
	"--color-chat-table-bg",
];

/** 解析 foundation.css 里的 `:root[data-palette="<id>"] { ... }` 块（含暗色变体） */
function parsePaletteBlocks(source) {
	const light = {};
	const dark = {};
	const pattern = /:root\[data-theme="dark"\]\[data-palette="([^"]+)"\]\s*\{([^}]*)\}|:root\[data-palette="([^"]+)"\]\s*\{([^}]*)\}/g;
	let match;
	while ((match = pattern.exec(source)) !== null) {
		if (match[1] !== undefined) {
			dark[match[1]] = match[2];
		} else {
			light[match[3]] = match[4];
		}
	}
	return { light, dark };
}

/** 抽一个选择器的块体（selector 必须带 `{`，精确到下一个 `}`） */
function extractBlock(source, selector) {
	const start = source.indexOf(`${selector} {`);
	assert.ok(start !== -1, `selector not found: ${selector}`);
	const end = source.indexOf("}", start);
	return source.slice(start + selector.length + 2, end);
}

test("STYLE_PRESETS 只列真形状差异的样式，默认 classic", () => {
	const ids = [...STYLE_PRESETS].map((preset) => preset.id);
	assert.deepEqual(ids, ["classic", "terminal"]);
	assert.equal(DEFAULT_STYLE, "classic");
	for (const preset of STYLE_PRESETS) {
		assert.ok(preset.labelKey.startsWith("settings.style."), preset.id);
		assert.ok(preset.descKey.startsWith("settings.style."), preset.id);
	}
});

test("PALETTE_PRESETS 只列配色，默认 classic-green，custom 不联动主色", () => {
	const ids = [...PALETTE_PRESETS].map((preset) => preset.id);
	assert.deepEqual(ids, ["classic-green", "fresh-green", "graphite", "sea-blue", "warm-beige", "parchment", "tui", "custom"]);
	assert.equal(DEFAULT_PALETTE, "classic-green");
	for (const preset of PALETTE_PRESETS) {
		assert.ok(preset.labelKey.startsWith("settings.palette."), preset.id);
		assert.ok(preset.descKey.startsWith("settings.palette."), preset.id);
		assert.ok(preset.preview.startsWith("#"), preset.id);
		for (const key of ["background", "sidebar", "panel", "accent", "border"]) {
			assert.ok(preset.previewSurfaces[key].startsWith("#"), `${preset.id}.${key}`);
		}
		// custom 的颜色来自主题包，没有内置推荐主色（否则会覆盖用户自己的 accent）
		if (preset.id === "custom") {
			assert.equal(preset.accent, undefined, "custom palette must not carry an accent");
		} else {
			assert.ok(preset.accent.length > 0, preset.id);
		}
	}
});

test("样式/配色 id 集合与 shared/themeSkinMigration.ts 一致（迁移表与预设表不能脱节）", () => {
	// shared/ 是纯契约层，不能 import renderer 的预设表（反向依赖），两侧靠这条守卫对齐
	assert.deepEqual(
		[...APP_STYLE_IDS],
		[...STYLE_PRESETS].map((preset) => preset.id),
	);
	assert.deepEqual(
		[...APP_PALETTE_IDS],
		[...PALETTE_PRESETS].map((preset) => preset.id),
	);
});

test("CUSTOM_THEME_BASE_SKINS 与 STYLE_PRESETS 同步：主题包只能继承真实存在的样式", () => {
	assert.deepEqual(
		[...CUSTOM_THEME_BASE_SKINS],
		[...STYLE_PRESETS].map((preset) => preset.id),
	);
	// base 只继承形状；「不继承」用省略 base 表达，不该出现在可选值里
	assert.ok(!CUSTOM_THEME_BASE_SKINS.includes("custom"));
});

test("旧单维 themeSkin 全量迁移到 (样式, 配色)，已下线皮肤不丢用户设置", () => {
	const legacyIds = Object.keys(LEGACY_SKIN_MAP);
	// 旧版的每个皮肤 id 都必须有落点，否则升级后用户的皮肤选择会静默回落到出厂默认
	assert.deepEqual(legacyIds.sort(), ["classic-green", "custom", "fresh-green", "glass", "graphite", "liquid-glass", "sea-blue", "terminal", "warm-beige"]);
	for (const id of legacyIds) {
		const mapped = LEGACY_SKIN_MAP[id];
		assert.ok(APP_STYLE_IDS.includes(mapped.themeStyle), `${id} → ${mapped.themeStyle}`);
		assert.ok(APP_PALETTE_IDS.includes(mapped.themePalette), `${id} → ${mapped.themePalette}`);
	}
	// 终端是唯一带真形状的旧皮肤：样式保留 terminal，颜色落到 tui
	assert.deepEqual({ ...normalizeThemeAppearance({ themeSkin: "terminal" }) }, { themeStyle: "terminal", themePalette: "tui" });
	// 毛玻璃/液态玻璃只剩配色语义，形状回到 classic（它们的形状优势在分栏布局下看不出来）
	assert.deepEqual({ ...normalizeThemeAppearance({ themeSkin: "glass" }) }, { themeStyle: "classic", themePalette: "classic-green" });
	// 新字段优先；缺失/非法值逐字段回落，最后回落到出厂默认
	assert.deepEqual({ ...normalizeThemeAppearance({ themeStyle: "terminal", themePalette: "graphite", themeSkin: "sea-blue" }) }, { themeStyle: "terminal", themePalette: "graphite" });
	assert.deepEqual({ ...normalizeThemeAppearance({ themeSkin: "nope" }) }, { themeStyle: DEFAULT_STYLE, themePalette: DEFAULT_PALETTE });
	assert.deepEqual({ ...normalizeThemeAppearance({}) }, { themeStyle: DEFAULT_STYLE, themePalette: DEFAULT_PALETTE });
});

test("主题包 base 继承的应用侧契约：样式维度落到 base、配色维度落到 custom", () => {
	const section = readFileSync("src/renderer/src/components/app/settings/CustomThemeSection.tsx", "utf8");
	assert.match(section, /themePalette: "custom"/);
	assert.match(section, /themeStyle: item\.base \?\? draft\.themeStyle/);
	// 快照生效条件只看配色维度：themePalette=custom 时才注入主题包 token
	const hook = readFileSync("src/renderer/src/hooks/appearance/useAppAppearance.ts", "utf8");
	assert.match(hook, /function activeCustomTheme\(/);
	assert.match(hook, /settings\.themePalette === "custom"/);
	// 两维各自写自己的 dataset 属性：形状走 data-appearance，颜色走 data-palette
	const appearance = readFileSync("src/renderer/src/themeAppearance.ts", "utf8");
	assert.match(appearance, /dataset\.appearance = settings\.themeStyle/);
	assert.match(appearance, /dataset\.palette = settings\.themePalette/);
});

test("CSS data-palette 块覆盖每套非默认配色，light + dark，且无多余 id", () => {
	const { light, dark } = parsePaletteBlocks(foundation);
	// custom 没有内置色板（颜色完全来自主题包），自然也没有 CSS 块
	const builtIn = PALETTE_PRESETS.filter((preset) => preset.id !== "classic-green" && preset.id !== "custom").map((preset) => preset.id);
	for (const id of builtIn) {
		assert.ok(light[id], `missing light block for [data-palette="${id}"]`);
		assert.ok(dark[id], `missing dark block for [data-theme="dark"][data-palette="${id}"]`);
	}
	// 不许出现预设表里没有的 id（防色块与配置脱节）
	const allCssIds = [...new Set([...Object.keys(light), ...Object.keys(dark)])];
	assert.deepEqual(allCssIds.sort(), [...builtIn].sort());
	// 出厂默认配色不声明块：它的观感就是 :root 本身，声明了反而会掩盖默认值缺陷
	assert.ok(!light["classic-green"], "classic-green must not declare a palette block");
});

test("every palette block repaints the full color set (surfaces/text/borders/chat)", () => {
	const { light, dark } = parsePaletteBlocks(foundation);
	for (const [id, body] of Object.entries(light)) {
		for (const token of REQUIRED_THEME_TOKENS) {
			assert.ok(body.includes(token), `light ${id} missing ${token}`);
		}
	}
	for (const [id, body] of Object.entries(dark)) {
		for (const token of REQUIRED_THEME_TOKENS) {
			assert.ok(body.includes(token), `dark ${id} missing ${token}`);
		}
	}
});

test("terminal 样式块只写形状（字体/圆角），不写颜色", () => {
	// 样式的定义就是「不含颜色」：颜色必须能在不换形状的前提下被任意配色覆盖。
	// 这里同时守住两件事：块存在、且没有任何 --color-* 声明（写了就等于把颜色焊进样式）。
	const body = extractBlock(foundation, ':root[data-appearance="terminal"]');
	assert.match(body, /--font-family-md: var\(--font-family-mono\)/);
	assert.match(body, /--font-family-base: var\(--font-family-mono\)/);
	assert.match(body, /--radius-xl: 0px/);
	const colorDecls = [...body.matchAll(/(--color-[a-z0-9-]+)\s*:/g)].map((match) => match[1]);
	assert.deepEqual(colorDecls, [], `terminal style must not declare colors, got ${colorDecls.join(", ")}`);
});

test("each palette's bundled accent maps to an existing data-accent block", () => {
	for (const preset of PALETTE_PRESETS) {
		if (preset.accent === undefined || preset.accent === "default") continue; // 默认中性主色 = :root base，无独立块
		assert.match(foundation, new RegExp(`:root\\[data-accent="${preset.accent}"\\]`), `missing data-accent block for palette ${preset.id} → accent ${preset.accent}`);
	}
	const knownAccents = ACCENT_PRESETS.map((preset) => preset.id);
	for (const preset of PALETTE_PRESETS) {
		if (preset.accent === undefined) continue;
		assert.ok(knownAccents.includes(preset.accent), `${preset.id} → ${preset.accent}`);
	}
});

test("style and palette i18n keys exist in zh-CN and en-US dictionaries", () => {
	for (const file of [zhCN, enUS]) {
		for (const preset of [...STYLE_PRESETS, ...PALETTE_PRESETS]) {
			assert.match(file, new RegExp(`"${escapeRegExp(preset.labelKey)}"`), `${file}: ${preset.labelKey}`);
			assert.match(file, new RegExp(`"${escapeRegExp(preset.descKey)}"`), `${preset.descKey}`);
		}
	}
});

/**
 * 回归：暖阳米（accent=amber）下会话状态灯被主色污染，idle 灯变琥珀、
 * 与运行（warning）/错误（danger）糊成一片。状态语义色（info=蓝、warning=黄、
 * danger=红）必须跨配色恒定，accent/palette 色块只允许改装饰色
 * （主色/链接/logo/工具身份色），禁止覆盖状态色 token。
 */
const STATUS_TOKENS = ["--color-info", "--color-warning", "--color-danger"];

test("accent and palette blocks never override semantic status colors", () => {
	const blockPattern = /:root(\[data-theme="dark"\])?\[data-(accent|palette)="[^"]+"\]\s*\{([^}]*)\}/g;
	let match;
	let count = 0;
	while ((match = blockPattern.exec(foundation)) !== null) {
		count += 1;
		// 剥掉块内注释：注释里允许提及状态 token（如 fresh-green 的“不动 --color-info 状态色”），
		// 断言只针对实际会生效的属性声明。
		const body = match[3].replace(/\/\*[\s\S]*?\*\//g, "");
		for (const token of STATUS_TOKENS) {
			assert.ok(!body.includes(token), `block ${match[0].slice(0, 44)}… must not override ${token}`);
		}
	}
	assert.ok(count > 0, "expected to find at least one accent/palette block");
});

test("palette blocks never override geometry tokens（颜色块不该改形状）", () => {
	// 与上一条对偶：样式维度才拥有 --radius-*/--font-family-*，
	// 若颜色块里出现这些声明，说明有人又把形状塞回配色里了。
	const { light, dark } = parsePaletteBlocks(foundation);
	const geometry = /--(radius-[a-z]+|font-family-[a-z]+)\s*:/;
	for (const [id, body] of Object.entries({ ...light, ...dark })) {
		const stripped = body.replace(/\/\*[\s\S]*?\*\//g, "");
		assert.ok(!geometry.test(stripped), `palette ${id} must not declare geometry/font tokens`);
	}
});

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
