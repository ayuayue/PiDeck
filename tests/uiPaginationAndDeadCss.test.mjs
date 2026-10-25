import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readRendererStyles } from "./helpers/rendererStyles.mjs";

const pagination = readFileSync("src/renderer/src/components/ui-shadcn/pagination.tsx", "utf8");
const yao = readFileSync("src/renderer/src/config/YaoPromptTab.tsx", "utf8");
const styles = readRendererStyles();

test("shared Pagination provides labeled prev/next, page window and jump input", () => {
	assert.match(pagination, /export function Pagination/);
	assert.match(pagination, /aria-label=\{t\("pagination\.previous"\)\}/);
	assert.match(pagination, /aria-label=\{t\("pagination\.next"\)\}/);
	// 页码窗口来自纯函数（配单测），中间页码与省略号由此渲染
	assert.match(pagination, /paginationWindow\(page, totalPages\)/);
	assert.match(pagination, /t\("pagination\.page", \{ page: String\(item\) \}\)/);
	// 跳页输入框：回车跳转 + aria 标签
	assert.match(pagination, /t\("pagination\.jumpTo"\)/);
	assert.match(pagination, /Math\.max\(1, page - 1\)/);
	assert.match(pagination, /Math\.min\(totalPages, page \+ 1\)/);
});

test("YaoPrompt pagination uses the shared component and no legacy CSS remains", () => {
	assert.match(yao, /<Pagination[\s\S]*page=\{page\}[\s\S]*totalPages=\{totalPages\}[\s\S]*onPageChange=\{setPage\}/);
	assert.doesNotMatch(yao, /yao-pagination/);
	assert.doesNotMatch(styles, /\.yao-pagination\b/);
	assert.doesNotMatch(styles, /\.yao-pagination-info/);
});

test("dead CSS sweep removed unreferenced classes from style files", () => {
	for (const dead of ["git-pane-header-actions", "git-file-icon", "git-ref-branch", "git-commit-hover-author-text", "config-model-chip-list", "math-copy-btn--inline", "archived-message-text"]) {
		assert.doesNotMatch(styles, new RegExp(`\\.${dead}\\b`), `${dead} should be removed`);
	}
	// git-resource-group-actions 例外：与活类 .git-resource-group.open 共用选择器列表，按共享规则保守保留。
	assert.match(styles, /\.git-resource-group\.open \.git-resource-group-actions/);
});
