import assert from "node:assert/strict";
import test from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

const css = readRendererStyles();
const selector = ".chat-list-pane.v3-braun .sidebar-body .conversation-list";
const rule = css.match(new RegExp(`${selector.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\s*\\{([\\s\\S]*?)\\n\\}`));

// 侧栏滚动条位置策略已变更（#113 中性化改版）：旧实现用负 margin 把滚动条拉到分隔线上，
// 现在由 sidebar-body 统一提供左右安全边距，列表不再做负 margin 补偿。
test("sidebar conversation list no longer compensates scrollbar with negative margin", () => {
	assert.ok(rule, "v3 sidebar conversation list rule should exist");
	assert.doesNotMatch(rule[1], /margin-right:\s*calc\(-1 \* var\(--space-3\)\);/);
	assert.match(rule[1], /margin-right:\s*0;/);
	assert.match(rule[1], /padding-right:\s*0;/);
	assert.doesNotMatch(css, new RegExp(`${selector.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\s*\\{[\\s\\S]*?scrollbar-width:\\s*thin;`));
	assert.doesNotMatch(css, new RegExp(`${selector.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}::-webkit-scrollbar`));
});
