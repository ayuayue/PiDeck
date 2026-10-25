import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Pi management navigation follows the settings tab visual rhythm", () => {
	const styles = readFileSync("src/renderer/src/styles/surfaces.css", "utf8");
	const modal = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
	const tabs = readFileSync("src/renderer/src/components/ui-shadcn/tabs.tsx", "utf8");

	// 左侧导航已迁移为 shadcn Vertical Tabs：TabsTrigger 保留 config-nav-btn 基础样式
	assert.match(modal, /config-nav-btn/);
	assert.match(modal, /orientation="vertical"/);
	assert.match(modal, /<TabsTrigger[^>]*config-nav-btn/);
	assert.match(styles, /\.config-sidebar-group \{[\s\S]*?gap: 4px;/);
	assert.match(styles, /\.config-sidebar-group \+ \.config-sidebar-group \{[\s\S]*?margin-top: 6px;/);
	assert.match(styles, /\.config-nav-btn \{[\s\S]*?font-family: var\(--font-family-sans/);
	assert.match(styles, /\.config-nav-btn:hover:not\(\.active\)/);
	// 选中态由 TabsTrigger 的 data-[state=active] utility 承担（bg-bg-panel + shadow-sm）
	assert.match(tabs, /data-\[state=active\]:bg-bg-panel/);
	assert.match(tabs, /data-\[state=active\]:shadow-sm/);
	// 旧的 .active 死规则已删除（避免与 Tabs 选中态双背景叠加）
	assert.doesNotMatch(styles, /\.config-nav-btn\.active \{/);
});
