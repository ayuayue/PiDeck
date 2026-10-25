import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionTreeSource = readFileSync("src/renderer/src/components/sidebar/SessionTree.tsx", "utf8");

test("empty non-loading projects retain their final exit, then remove the session-card container", () => {
	assert.match(sessionTreeSource, /const hasRows = catalogLoading \|\| draftSessions\.length > 0 \|\| display\.visibleChildren\.length > 0 \|\| display\.hiddenChildCount > 0;/);
	// 空项目仍先保留一轮退出动画；无行且无退出保留时交回空态（项目自定义空态优先，否则不渲染容器）。
	assert.match(sessionTreeSource, /if\s*\(\s*!hasRows\s*&&\s*!retainingExit\s*\)\s*return\s+props\.emptyState\s*\?/);
	assert.match(sessionTreeSource, /emptyState\?:/);
	assert.match(sessionTreeSource, /onExitComplete\s*=/);
	assert.match(sessionTreeSource, /if\s*\(\s*!hasRows\s*\)\s*setRetainingExit\(false\)/);
});
