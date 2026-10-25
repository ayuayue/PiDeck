import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { composeAppTitle } = loadTsCommonJs("src/shared/appTitle.ts");

test("composeAppTitle 用显示名称拼标题，未设置/非法值回落 PiDeck", () => {
	assert.equal(composeAppTitle(undefined), "PiDeck");
	assert.equal(composeAppTitle(null), "PiDeck");
	assert.equal(composeAppTitle(""), "PiDeck");
	assert.equal(composeAppTitle("   "), "PiDeck");
	assert.equal(composeAppTitle("WorkBuddy"), "WorkBuddy");
	// 前后空白与设置层同一套裁剪规则（resolveAppDisplayName）
	assert.equal(composeAppTitle("  WorkBuddy  "), "WorkBuddy");
	// 超长（>24）与设置层一致：回落默认而不是截断
	assert.equal(composeAppTitle("x".repeat(25)), "PiDeck");
});

test("composeAppTitle 只在开发态分支隔离时追加分支名", () => {
	assert.equal(composeAppTitle("WorkBuddy", "dev"), "WorkBuddy · dev");
	assert.equal(composeAppTitle(undefined, "dev"), "PiDeck · dev");
	// 打包版传 undefined/空串/纯空白 → 不加分隔符（否则任务栏会出现「WorkBuddy · 」）
	assert.equal(composeAppTitle("WorkBuddy", undefined), "WorkBuddy");
	assert.equal(composeAppTitle("WorkBuddy", ""), "WorkBuddy");
	assert.equal(composeAppTitle("WorkBuddy", "   "), "WorkBuddy");
	assert.equal(composeAppTitle("WorkBuddy", " dev "), "WorkBuddy · dev");
});
