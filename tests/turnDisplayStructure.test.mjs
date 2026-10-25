import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const buildSource = readFileSync("src/renderer/src/components/session/timeline/buildTurnDisplay.ts", "utf8");
const summarySource = readFileSync("src/renderer/src/components/session/timeline/segmentSummary.ts", "utf8");
const typesSource = readFileSync("src/renderer/src/components/session/timeline/types.ts", "utf8");
const turnRowSource = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");
const summaryToggleSource = readFileSync("src/renderer/src/components/session/turn/ProcessSummaryToggle.tsx", "utf8");

// 单折叠汇总：整轮只出现一个「执行过程」汇总按钮，思考/工具/中间回答共用一个
// run 级折叠开关（stepsVisible），最终回答常驻、永不折叠。
test("TurnRow renders a single process summary toggle plus order-preserving flat display", () => {
	assert.match(turnRowSource, /buildTurnDisplay\(run/);
	// 唯一汇总按钮：只渲染一次（run 开头），不按 process 段循环
	assert.match(turnRowSource, /ProcessSummaryToggle\s*summary=\{processSummary\}/);
	assert.match(turnRowSource, /showProcessToggle && \(/);
	// 中间回答/最终回答区分渲染；最终回答走 FinalAnswer（常驻）
	assert.match(turnRowSource, /item\.kind === "interim-answer"/);
	assert.match(turnRowSource, /<FinalAnswer/);
	assert.match(turnRowSource, /\/\/ final-answer/);
	// 思考/工具/中间回答共用一个折叠开关
	assert.match(turnRowSource, /hidden=\{!stepsVisible\}/);
	// 折叠区内 settled 中间段一律 process（同正文尺寸 + my-3 间距）；live 在容器外走 answer
	assert.match(turnRowSource, /variant="process"/);
	// 中间内容收进执行过程折叠容器（foldableItems），最终回答常驻容器外（finalItems）。
	// #213：折叠区先过 boundMountedSteps 挂载预算（默认只挂尾部 N 条），渲染源仍是
	// foldableItems 的尾部切片——顺序不变；同时锁住「显示更早步骤」入口存在，
	// 否则预算会把早期步骤变成不可达内容。
	assert.match(turnRowSource, /boundMountedSteps\(foldableItems, TIMELINE_MOUNTED_STEP_LIMIT/);
	assert.match(turnRowSource, /mountedSteps\.items\.map/);
	assert.match(turnRowSource, /mountedSteps\.hiddenCount > 0/);
	assert.match(turnRowSource, /timeline\.showEarlierSteps/);
	assert.match(turnRowSource, /finalItems\.map/);
	// 折叠容器用 Radix CollapsibleContent（高度过渡动画），不再 display:none 突变
	assert.match(turnRowSource, /<Collapsible/);
	assert.match(turnRowSource, /<CollapsibleContent/);
	assert.doesNotMatch(turnRowSource, /stepsVisible \? undefined : "none"/);
	// 收起按钮：固定在折叠容器末尾
	assert.match(turnRowSource, /execution-summary-collapse/);
	assert.match(summaryToggleSource, /execution-summary-toggle/);
	assert.match(summaryToggleSource, /activity\.executionToolCount/);
	assert.match(summaryToggleSource, /activity\.executionThinkingCount/);
	assert.match(summaryToggleSource, /activity\.executionInterimCount/);
});

// 扁平展示序列：严格按 run.items 时序，不重排；中间回答 = 非最后一条 assistant 文本。
test("buildTurnDisplay keeps strict order and splits interim/final answers", () => {
	// 最终回答判定：run 收尾条目 + stopReason 协议信号/回退启发式（2026-08 升级，
	// 取代旧的 lastAssistantIndex 锚点——判定矩阵行为由 tests/turnSegments.test.mjs 覆盖）
	assert.match(buildSource, /isRunTail/);
	assert.match(buildSource, /isFinal/);
	assert.match(buildSource, /interim-answer/);
	assert.match(buildSource, /final-answer/);
	// 消息自带 thinking 作为思考步骤插到该回答之前
	assert.match(buildSource, /msg-thinking-/);
	// 空文本消息仍产出 interim 挂载点（Live 通道骨架）——但带图（生图结果）或生图占位（meta.imageGen）不降级，走最终回答
	assert.match(buildSource, /interim-answer/);
	assert.match(buildSource, /if \(!text && !hasImages && !hasImageGen\) \{/);
	assert.match(buildSource, /const hasImages = Boolean\(item\.message\.images\?\.length\)/);
	assert.match(buildSource, /const hasImageGen = Boolean\(item\.message\.meta\?\.imageGen\)/);
	// 工具步骤始终进序列（不依赖 showThinking）
	assert.match(buildSource, /tool-entry/);
	// 思考步骤：已有 thinking-group 始终保留；消息自带 thinking 受 showThinking 控制
	assert.match(buildSource, /pushThinking\(item, false\)/);
	assert.match(buildSource, /respectShowThinking && !showThinking/);
});

// 汇总统计：纯数字（工具/思考/中间回复），折叠态不显示内容预览。
test("segmentSummary counts tools, thinking steps and interim replies without preview text", () => {
	assert.match(summarySource, /toolCount/);
	assert.match(summarySource, /thinkingCount/);
	assert.match(summarySource, /interimCount/);
	assert.match(summarySource, /isEmptySummary/);
	// 折叠按钮纯数字：不引用消息正文
	assert.doesNotMatch(summaryToggleSource, /message\.text/);
	assert.doesNotMatch(summaryToggleSource, /preview/);
});
