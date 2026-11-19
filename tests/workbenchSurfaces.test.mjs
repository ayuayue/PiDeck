import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 中间栏前台面判定（会话面 vs 文件/Git Diff 内容面）。
 *
 * 回归背景：files 面占满中间栏后，点会话 Tab 或点侧栏「已经是当前会话」的那一行都只改
 * currentSessionId，内容面继续铺满 → 点上去毫无反应。让位规则在这里可判定。
 */
const { workbenchContentFolded, workbenchShowsContent, workbenchTabActive } = loadTsCommonJs("src/renderer/src/utils/workbenchSurfaces.ts");

const state = (over = {}) => ({ simpleMode: false, hasContent: true, layout: "maximize", front: "content", ...over });

test("maximize + 会话在前台 → 内容面让位（会话独占中间栏）", () => {
	assert.equal(workbenchContentFolded(state({ front: "session" })), true);
	assert.equal(workbenchShowsContent(state({ front: "session" })), false);
});

test("内容面在前台 → 不让位，占满中间栏照常呈现", () => {
	assert.equal(workbenchContentFolded(state()), false);
	assert.equal(workbenchShowsContent(state()), true);
});

test("split 下不让位：两面同屏，折叠会把正在对照的文件藏起来", () => {
	assert.equal(workbenchContentFolded(state({ layout: "split", front: "session" })), false);
	assert.equal(workbenchShowsContent(state({ layout: "split", front: "session" })), true);
});

test("简洁模式与无内容面时没有让位语义", () => {
	assert.equal(workbenchContentFolded(state({ simpleMode: true, front: "session" })), false);
	assert.equal(workbenchContentFolded(state({ hasContent: false, front: "session" })), false);
	assert.equal(workbenchShowsContent(state({ hasContent: false })), false);
	assert.equal(workbenchShowsContent(state({ hasContent: false, front: "session" })), false);
});

test("内容 Tab 选中态：让位时一律不亮，否则只看自己是不是当前 Tab", () => {
	assert.equal(workbenchTabActive(false, true), true);
	assert.equal(workbenchTabActive(false, false), false);
	assert.equal(workbenchTabActive(true, true), false);
	assert.equal(workbenchTabActive(true, false), false);
});
