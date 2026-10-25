import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
const zhCN = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const enUS = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

const { SKIN_PRESETS, DEFAULT_SKIN, ACCENT_PRESETS } = loadTsCommonJs("src/renderer/src/themePresets.ts");

/**
 * 外观主题契约：
 * - SKIN_PRESETS（ts）与 foundation.css 的 [data-appearance] 块必须同一套 id，
 *   且每套主题自带明暗两版（light 块 + `[data-theme="dark"]` 变体）；
 * - 每个色板块必须覆盖「完整外观」的关键 token（表面/文字/边框/会话面板），
 *   保证外观主题真的是整套重绘，而不是只改主色的旧行为；
 * - 每套主题的推荐主色必须能映射到既有 data-accent 色块；
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

/** 解析 foundation.css 里的 `:root[data-appearance="<id>"] { ... }` 块 */
function parseAppearanceBlocks(source) {
	const light = {};
	const dark = {};
	const pattern = /:root\[data-theme="dark"\]\[data-appearance="([^"]+)"\]\s*\{([^}]*)\}|:root\[data-appearance="([^"]+)"\]\s*\{([^}]*)\}/g;
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

test("SKIN_PRESETS is complete and DEFAULT is classic-green", () => {
	// VM 加载的数组属于另一个 realm，需先展平为本地数组再比较
	const ids = [...SKIN_PRESETS].map((preset) => preset.id);
	assert.deepEqual(ids, ["classic-green", "fresh-green", "graphite", "sea-blue", "warm-beige"]);
	assert.equal(DEFAULT_SKIN, "classic-green");
	// 每个预设都有完整元数据：Label/描述/推荐主色/预览色块
	for (const preset of SKIN_PRESETS) {
		assert.ok(preset.labelKey.startsWith("settings.skin."), preset.id);
		assert.ok(typeof preset.descKey === "string" && preset.descKey.length > 0, preset.id);
		assert.ok(preset.accent.length > 0, preset.id);
		assert.ok(preset.preview.startsWith("#"), preset.id);
		for (const key of ["background", "sidebar", "panel", "accent", "border"]) {
			assert.ok(preset.previewSurfaces[key].startsWith("#"), `${preset.id}.${key}`);
		}
	}
});

test("CSS data-appearance blocks exist for every non-default skin, light + dark", () => {
	const { light, dark } = parseAppearanceBlocks(foundation);
	const builtIn = SKIN_PRESETS.filter((preset) => preset.id !== "classic-green").map((preset) => preset.id);
	for (const id of builtIn) {
		assert.ok(light[id], `missing light block for [data-appearance="${id}"]`);
		assert.ok(dark[id], `missing dark block for [data-theme="dark"][data-appearance="${id}"]`);
	}
	// 不许出现 SKIN_PRESETS 里没有的 id（防色块与配置脱节）
	const allCssIds = [...new Set([...Object.keys(light), ...Object.keys(dark)])];
	assert.deepEqual(allCssIds.sort(), [...builtIn].sort()); // 默认主题不强制覆盖块，但也绝不能被错误地声明（默认观感即 :root）
	assert.ok(!light["classic-green"], "classic-green must not declare an appearance block");
});

test("every appearance block repaints the full palette (surfaces/text/borders/chat)", () => {
	const { light, dark } = parseAppearanceBlocks(foundation);
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

test("each skin's bundled accent maps to an existing data-accent block", () => {
	for (const preset of SKIN_PRESETS) {
		if (preset.accent === "default") continue; // 默认中性主色 = :root base，无独立块
		assert.match(foundation, new RegExp(`:root\\[data-accent="${preset.accent}"\\]`), `missing data-accent block for skin ${preset.id} → accent ${preset.accent}`);
	}
	const knownAccents = ACCENT_PRESETS.map((preset) => preset.id);
	for (const preset of SKIN_PRESETS) {
		assert.ok(knownAccents.includes(preset.accent), `${preset.id} → ${preset.accent}`);
	}
});

test("appearance theme i18n keys exist in zh-CN and en-US dictionaries", () => {
	for (const file of [zhCN, enUS]) {
		for (const preset of SKIN_PRESETS) {
			assert.match(file, new RegExp(`"${escapeRegExp(preset.labelKey)}"`), `${file}: ${preset.labelKey}`);
			assert.match(file, new RegExp(`"${escapeRegExp(preset.descKey)}"`), `${file}: ${preset.descKey}`);
		}
	}
});

/**
 * 回归：暖阳米（accent=amber）下会话状态灯被主色污染，idle 灯变琥珀、
 * 与运行（warning）/错误（danger）糊成一片。状态语义色（info=蓝、warning=黄、
 * danger=红）必须跨主题恒定，accent/appearance 色块只允许改装饰色
 * （主色/链接/logo/工具身份色），禁止覆盖状态色 token。
 */
const STATUS_TOKENS = ["--color-info", "--color-warning", "--color-danger"];

test("accent and appearance blocks never override semantic status colors", () => {
	const blockPattern = /:root(\[data-theme="dark"\])?\[data-(accent|appearance)="[^"]+"\]\s*\{([^}]*)\}/g;
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
	assert.ok(count > 0, "expected to find at least one accent/appearance block");
});

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
