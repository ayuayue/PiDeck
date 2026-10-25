import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const stylesEntry = readFileSync("src/renderer/src/styles.css", "utf8");
const workspace = readFileSync("src/renderer/src/styles/workspace.css", "utf8");
const main = readFileSync("src/renderer/src/main.tsx", "utf8");

/**
 * Cascade 契约：
 * - vendor（streamdown/file-icons）< legacy（手写）< utilities
 * - legacy 高于 base，避免 preflight 冲掉整站外观
 */
test("styles.css layer order: vendor < legacy < utilities", () => {
	assert.match(stylesEntry, /@layer\s+theme\s*,\s*base\s*,\s*components\s*,\s*vendor\s*,\s*legacy\s*,\s*utilities\s*;/, "vendor must sit before legacy; legacy before utilities");

	assert.doesNotMatch(stylesEntry, /@layer\s+legacy\s*,\s*theme/, "legacy must not be declared before theme/base (preflight would wipe app chrome)");

	assert.match(stylesEntry, /@import\s+"streamdown\/styles\.css"\s+layer\(vendor\)\s*;/);
	assert.match(stylesEntry, /@import\s+"\.\/file-icons\.css"\s+layer\(vendor\)\s*;/);

	for (const file of ["foundation.css", "timeline.css", "surfaces.css", "integrations.css", "workspace.css"]) {
		assert.match(stylesEntry, new RegExp(`@import\\s+"\\./styles/${file}"\\s+layer\\(legacy\\)\\s*;`), `${file} must import with layer(legacy)`);
	}

	assert.match(stylesEntry, /@import\s+"\.\/styles\/tailwind\.css"\s*;/);
	assert.doesNotMatch(stylesEntry, /tailwind\.css"\s+layer\(/);
	// Streamdown 观感覆盖必须在 utilities 层（压过官方 p-2 / 双层 border）
	assert.match(stylesEntry, /@import\s+"\.\/styles\/streamdownChrome\.css"\s+layer\(utilities\)\s*;/);
});

test("main.tsx does not import streamdown/file-icons unlayered after styles.css", () => {
	// unlayered 后引入会压过 legacy 里的 markdown/图标覆盖（代码块曾因此回退到默认双层皮）
	assert.doesNotMatch(main, /import\s+"streamdown\/styles\.css"/);
	assert.doesNotMatch(main, /import\s+"\.\/file-icons\.css"/);
	assert.match(main, /import\s+"\.\/styles\.css"/);
});

test("v3-braun sidebar-body no longer hardcodes padding/gap (Tailwind owns spacing)", () => {
	const match = workspace.match(/\.chat-list-pane\.v3-braun\s+\.sidebar-body\s*\{([^}]*)\}/);
	assert.ok(match, "v3-braun sidebar-body rule must exist");
	const body = match[1];
	assert.doesNotMatch(body, /\bpadding\s*:/);
	assert.doesNotMatch(body, /\bgap\s*:/);
});

test("handwritten CSS files stay unlayered internally (layer only at import)", () => {
	const layerAtRule = /(?:^|[\s;}])@layer\s+(components|legacy|base|vendor)\b/m;
	for (const file of ["foundation.css", "timeline.css", "surfaces.css", "integrations.css", "workspace.css"]) {
		const source = readFileSync(`src/renderer/src/styles/${file}`, "utf8");
		const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
		assert.doesNotMatch(withoutComments, layerAtRule, `${file} must not wrap itself in @layer; entry styles.css owns the layer assignment`);
	}
});
