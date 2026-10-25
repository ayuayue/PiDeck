// syncReleaseNotes.test.mjs
// 回归测试：scripts/sync-release-notes.js 的 emoji 前缀清洗。
// 背景：🐛/✨ 是 surrogate pair（两个 code unit），字符类不带 u flag 时只能匹配
// 半个 code unit，导致 replace 静默失败，README ✨ 区会混入带 🐛 前缀的条目。
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripEmojiPrefix } from "../scripts/sync-release-notes.js";

test("stripEmojiPrefix removes 🐛 prefix followed by space", () => {
	assert.equal(stripEmojiPrefix("🐛 **「停止」停不下来**"), "**「停止」停不下来**");
});

test("stripEmojiPrefix removes ✨ prefix followed by space", () => {
	assert.equal(stripEmojiPrefix("✨ **侧边栏可发现性优化**"), "**侧边栏可发现性优化**");
});

test("stripEmojiPrefix leaves entries without emoji prefix untouched", () => {
	assert.equal(stripEmojiPrefix("**Session-first 架构（#113）**"), "**Session-first 架构（#113）**");
});

test("stripEmojiPrefix handles mixed emoji text inside the title", () => {
	// emoji 出现在标题内部时不应被误删（只清理行首前缀）
	assert.equal(stripEmojiPrefix("🐛 **修复 🐛 图标**"), "**修复 🐛 图标**");
});
