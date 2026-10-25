import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

const css = readRendererStyles();

const v3SidebarRule = css.match(/\.wechat-shell:not\(\.list-collapsed\) \.chat-list-pane\.v3-braun \{([\s\S]*?)\n\}/)?.[1];

test("v3 sidebar has no right divider in expanded or revealed states", () => {
	assert.ok(v3SidebarRule, "v3 sidebar surface rule must exist");
	assert.doesNotMatch(v3SidebarRule, /border-right:/);
});
