import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * pure official：标题截断/布局改由 SessionHeader Tailwind 承担。
 */

const header = readFileSync("src/renderer/src/components/session/SessionHeader.tsx", "utf8");

test("chat header leaves the session title to tabs and keeps the status actions", () => {
	assert.doesNotMatch(header, /chat-title-block/);
	assert.doesNotMatch(header, /<strong[^>]*title=\{title\}/);
	assert.match(header, /chat-header-actions flex min-w-0 items-center justify-end/);
	// 运行控制已迁入 Tab 下拉，不再有独立的 session-actions 按钮组
	assert.doesNotMatch(header, /header-actions-right/);
});
