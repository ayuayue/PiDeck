import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 过程组组体的“只有一条滚轮”契约断言。
 *
 * 2026-11 两次转向，别再拨回去：
 * - 曾经：组体 `max-h-[min(320px,30vh)]` + `overscroll-contain` + 自带跟底 → 「双层滚动条」
 *   （组内工具卡也限高）与「到边死区」（组体到底、会话一像素不动）；
 * - 中间版：组体自然高度、滚动全交会话 → 一个组几十条时一轮正文被抛在后面；
 * - 现在：组体限高（≈ 22 行，`min(640px,60vh)`）+ 组内一条滚轮（滚动条隐藏）+ **不 contain**。
 *   到边后滚轮继续交给会话；外层时间线按 `resolveGestureOwner` 判定归属，
 *   组内还有余量时不动外层跟随态。组内工具卡继续让位（maxHeight=null），整组只有一条滚轮。
 *
 * 组体的行为（限高、方向提示、暂停点、引擎接线、展开分流）由
 * `tests/processGroupStepBody.test.mjs` 渲染真组件断言；本文件只保留「上下文接线」
 * 这类无法在无 DOM 环境里观察的结构断言。
 */
const toolResultSource = () => readFileSync("src/renderer/src/components/agents/tool-result.tsx", "utf8");
const fileDiffSource = () => readFileSync("src/renderer/src/components/agents/file-diff.tsx", "utf8");
const groupStepSource = () => readFileSync("src/renderer/src/components/session/turn/ProcessGroupStep.tsx", "utf8");
const contextSource = () => readFileSync("src/renderer/src/components/session/turn/processGroupScrollContext.ts", "utf8");
const stickySource = () => readFileSync("src/renderer/src/components/session/turn/useProcessEntryStickyHeader.ts", "utf8");
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
	assert.ok(group.indexOf("<ProcessGroupBodyScrollContext.Provider") < group.indexOf("data-process-group-content"), "provider must wrap the group content");
	assert.ok(group.indexOf("data-process-group-content") < group.indexOf("</ProcessGroupBodyScrollContext.Provider>"), "provider must close after the group content");
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
		// 容器行上的滚动类由各文件自己断言（见文件末尾）：tool-result 已把类名内联，
		// 因为守卫只认元素行里的 overflow-* 字面量（docs/virtualization-audit.md 7.4）。
	}
	// tool-result：null → 完全不滚动；否则仍保持 scrollbar-hide overflow-y-auto
	assert.match(toolResultSource(), /className=\{maxHeight === null \? "" : "scrollbar-hide overflow-y-auto"\}/);
	// file-diff：null → 只保留横向滚动（overflow-y:auto 会让 overflow-x 计算成 auto，宽行会顶出组体）
	// file-diff：null → 只保留横向滚动（overflow-y:auto 会让 overflow-x 计算成 auto，宽行会顶出组体）。
	// 类名同样内联在容器行上（守卫要看得见字面量）。
	assert.match(fileDiffSource(), /className=\{maxHeight === null \? "overflow-x-auto" : "scrollbar-hide overflow-auto"\}/);
});
