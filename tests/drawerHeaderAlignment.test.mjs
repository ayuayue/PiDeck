import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

/**
 * 抽屉面板不再挂「标题 + ×」顶栏；开合用 Tab 栏 PanelRight，面板切换用抽屉内活动栏。
 */

const styles = readRendererStyles();
const drawerSurface = readFileSync("src/renderer/src/components/workspace/DrawerSurface.tsx", "utf8");

test("drawer panels drop title chrome (no header + close X)", () => {
	assert.doesNotMatch(drawerSurface, /drawer-header flex h-12/);
	assert.doesNotMatch(drawerSurface, /drawer\.sourceControl/);
	assert.doesNotMatch(drawerSurface, /app\.browser/);
	assert.doesNotMatch(drawerSurface, /<X\b/);
});

test("drawer does not cast a shadow over the adjacent white pane", () => {
	// 用行首锚定取裸 .detail-drawer 规则，避免误中 .shell-panel-drawer .detail-drawer
	const drawer = styles.match(/(?:^|\n)\.detail-drawer \{([\s\S]*?)\n\}/)?.[1];

	assert.ok(drawer, "drawer styles must exist");
	assert.match(drawer, /box-shadow:\s*none;/);
});
