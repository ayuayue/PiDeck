import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 过程组组体内「只有一条滚轮」的契约断言。
 *
 * 背景：组体本身已经是「限高 + 一条滚轮」（`data-process-group-scroller`）。组内工具卡
 * 再带一层限高滚动区（`ToolResult` 320 / `FileDiff` 200）就变成双层滚动条：内层滚到边
 * 即被 overscroll-contain 切断，外层一像素不动，观感像卡死。
 *
 * 约定：组内内层让位（maxHeight=null → 不限高、不自转纵向滚轮），组外保持原值。
 * 这里用源码正则把这条约束钉住——改动任一处且忘记同步，测试即红。
 */
const toolResultSource = () => readFileSync("src/renderer/src/components/agents/tool-result.tsx", "utf8");
const fileDiffSource = () => readFileSync("src/renderer/src/components/agents/file-diff.tsx", "utf8");
const groupStepSource = () => readFileSync("src/renderer/src/components/session/turn/ProcessGroupStep.tsx", "utf8");
const contextSource = () => readFileSync("src/renderer/src/components/session/turn/processGroupScrollContext.ts", "utf8");
const toolCardSource = () => readFileSync("src/renderer/src/components/session/ToolCallComponents.tsx", "utf8");

test("scroll context exists and defaults to false outside a group body", () => {
	const context = contextSource();
	assert.match(context, /export\s+const\s+ProcessGroupBodyScrollContext\s*=\s*createContext\(false\)/);
	assert.match(context, /export\s+function\s+useInsideProcessGroupBody\(\)/);
	assert.match(context, /useContext\(ProcessGroupBodyScrollContext\)/);
});

test("group body provides the context only while open", () => {
	const group = groupStepSource();
	// Provider 必须包住整个组体，且只在 props.open 分支内（收起时不该有组内语境）。
	assert.ok(/\{props\.open\s*&&\s*\([\s\S]*?<ProcessGroupBodyScrollContext\.Provider\s+value=\{true\}>/.test(group), "group body must open the provider inside the props.open branch");
	assert.ok(group.indexOf("<ProcessGroupBodyScrollContext.Provider") < group.indexOf("data-process-group-scroller"), "provider must wrap the group body scroller");
	assert.ok(group.indexOf("data-process-group-scroller") < group.indexOf("</ProcessGroupBodyScrollContext.Provider>"), "provider must close after the group body scroller");
});

test("tool card drops inner maxHeight inside a group body", () => {
	const card = toolCardSource();
	assert.match(card, /useInsideProcessGroupBody\(\)/);
	// ToolResult：组内 null，组外 320
	assert.match(card, /maxHeight=\{insideProcessGroupBody\s*\?\s*null\s*:\s*TOOL_RESULT_MAX_HEIGHT_OUTSIDE_GROUP\}/);
	assert.match(card, /TOOL_RESULT_MAX_HEIGHT_OUTSIDE_GROUP\s*=\s*320/);
	// FileDiff：组内 null，组外 200
	assert.match(card, /maxHeight=\{insideProcessGroupBody\s*\?\s*null\s*:\s*200\}/);
});

test("maxHeight accepts null and null disables the inner vertical scroller", () => {
	for (const source of [toolResultSource(), fileDiffSource()]) {
		// 类型放宽为 number | null：null 表示「外层已自带滚轮，内层让位」
		assert.match(source, /maxHeight\?:\s*number\s*\|\s*null/);
		// 限高样式与滚动类都由 maxHeight===null 派生，null 时不写 maxHeight、不加纵向滚动
		assert.match(source, /maxHeightStyle\s*=\s*maxHeight\s*===\s*null\s*\?\s*undefined\s*:\s*\{\s*maxHeight\s*\}/);
		assert.match(source, /style=\{maxHeightStyle\}/);
		assert.match(source, /className=\{scrollClass\}/);
	}
	// tool-result：null → 完全不滚动；否则仍保持 scrollbar-hide overflow-y-auto
	assert.match(toolResultSource(), /scrollClass\s*=\s*maxHeight\s*===\s*null\s*\?\s*"[^"]*"\s*:\s*"scrollbar-hide overflow-y-auto"/);
	// file-diff：null → 只保留横向滚动（overflow-y:auto 会让 overflow-x 计算成 auto，宽行会顶出组体）
	assert.match(fileDiffSource(), /scrollClass\s*=\s*maxHeight\s*===\s*null\s*\?\s*"overflow-x-auto"\s*:\s*"scrollbar-hide overflow-auto"/);
});
