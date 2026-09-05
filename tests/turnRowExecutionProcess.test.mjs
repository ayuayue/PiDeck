import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const turnRowSource = readFileSync(
  "src/renderer/src/components/session/turn/TurnRow.tsx",
  "utf8",
);
const thinkingStepSource = readFileSync(
  "src/renderer/src/components/session/turn/ThinkingStep.tsx",
  "utf8",
);
const toolStepSource = readFileSync(
  "src/renderer/src/components/session/turn/ToolStep.tsx",
  "utf8",
);
const summaryToggleSource = readFileSync(
  "src/renderer/src/components/session/turn/ProcessSummaryToggle.tsx",
  "utf8",
);
const timelineEventCardsSource = readFileSync(
  "src/renderer/src/components/session/TimelineEventCards.tsx",
  "utf8",
);

test("renders the run as order-preserving flat display without pulling the last answer to the bottom", () => {
  assert.ok(
    turnRowSource.indexOf("foldableItems.map") > 0,
    "TurnRow must render foldable display items",
  );
  // 顺序忠实：不再抽离时序、不把回答拽到底部，final/interim 都在原位
  assert.doesNotMatch(
    turnRowSource.slice(turnRowSource.indexOf("foldableItems.map")),
    /最终回答（始终可见）/,
  );
  assert.match(turnRowSource, /buildTurnDisplay\(run/);
  // 最终回答走 FinalAnswer（常驻），容器外常驻区渲染
  assert.match(turnRowSource, /\/\/ final-answer/);
  assert.match(turnRowSource, /<FinalAnswer/);
});

// issue #130：回答文本是面向用户的正式内容，不应折进「执行过程」。
// 新结构：中间回答受 run 级折叠控制（可折叠），最终回答常驻；思考/工具步骤
// 原位穿插且只受一个折叠开关控制；概要只统计工具/思考/中间回复数，不显示正文预览。
test("issue #130: fold concerns process steps and interim answers, final answer stays inline", () => {
  // 思考/工具步骤组件独立：思考走 ThinkingBlock（CoT 单步），工具走 ToolGroupCard
  assert.match(thinkingStepSource, /ThinkingBlock/);
  // 思考默认收起由 ThinkingBlock 自己决定，步骤层不传 defaultExpanded
  assert.doesNotMatch(thinkingStepSource, /defaultExpanded=/);
  assert.match(toolStepSource, /ToolGroupCard/);
  // 步骤原位渲染，不受「单个折叠容器」限制（避免折叠容器被回答文本打断）
  assert.match(turnRowSource, /hidden=\{!stepsVisible\}/);

  // 概要只统计工具/思考/中间回复数，不再计「N次回答」预览
  assert.doesNotMatch(turnRowSource, /executionAnswerCount/);
  assert.doesNotMatch(summaryToggleSource, /message\.text/);

  // i18n key 同步移除旧的回答计数；新增中间回复计数
  assert.doesNotMatch(
    readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8"),
    /executionAnswerCount/,
  );
  assert.match(
    readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8"),
    /executionInterimCount/,
  );
});

test("stale running tools stay stopped when a newer run starts", () => {
  // stopped 只由当前回合是否 live 决定；不能再绑定 isLatestRun，否则新回合开始后旧回合会复活 spinner。
  assert.match(turnRowSource, /stopped=\{props\.agentRunning !== true\}/);
  assert.doesNotMatch(turnRowSource, /stopped=\{Boolean\(props\.isLatestRun && !props\.agentRunning\)\}/);
});

test("execution summary toggle radius matches other buttons", () => {
  const css = readFileSync("src/renderer/src/styles/timeline.css", "utf8");
  const toggleRule = css.match(/\.execution-summary-toggle \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(toggleRule, ".execution-summary-toggle rule must exist");
  // 与 shadcn rounded-md 同档（--radius-md: 8px），不再用全圆 pill
  assert.match(toggleRule, /border-radius: var\(--radius-md\)/);
  assert.doesNotMatch(toggleRule, /999px/);
});

// Chain of Thought 步骤化：执行过程折叠详情里，思考与工具同为「步骤」——
// 思考默认收起为单步（标题+首句预览），点击才展开全文；概要行带步骤图标。
test("execution fold renders thinking as collapsed CoT steps", () => {
  // 步骤层不写死折叠：ThinkingBlock 默认单行跑马灯，用户点开才展开
  assert.doesNotMatch(thinkingStepSource, /defaultExpanded=\{false\}/);
  assert.doesNotMatch(thinkingStepSource, /defaultExpanded=/);

  const cards = readFileSync(
    "src/renderer/src/components/session/TimelineEventCards.tsx",
    "utf8",
  );
  assert.match(cards, /defaultExpanded\?: boolean/);
  assert.match(cards, /useState\(props\.defaultExpanded \?\? false\)/);
  assert.doesNotMatch(cards, /if \(props\.isStreaming\) setExpanded\(true\)/);
  // 折叠预览与「思考了 Xs」同一行，不再落到下方虚线框
  assert.match(cards, /!expanded && \(/);
  assert.match(cards, /<SingleLinePreview/);
  assert.doesNotMatch(
    cards.slice(cards.indexOf("function ThinkingBlock")),
    /border-dashed border-border-subtle/,
  );

  // 汇总按钮带步骤图标（ListTree），呼应 Chain of Thought 头部
  assert.match(summaryToggleSource, /<ListTree size=\{13\}/);
});

// 阶段 0：历史 run 跳过重渲染。TurnRow 用自定义 memo 比较（sameAgentRunForRender
// 深度比较 run 内容 + 标量 props），流式增量时未变化的 run 不重渲染，
// 只有内容真正变化的 run（当前流式 run）才重渲染。
test("TurnRow uses custom memo compare so unchanged runs skip re-render", () => {
  assert.match(turnRowSource, /sameAgentRunForRender/);
  assert.match(turnRowSource, /turnRowPropsEqual\(prev: TurnRowProps, next: TurnRowProps\)/);
  assert.match(turnRowSource, /memo\(\s*function TurnRow\(props: TurnRowProps\)/);
  assert.match(turnRowSource, /turnRowPropsEqual,\s*\);/);
  // 流式 run 总是重渲染（气泡随独立通道更新）；历史 run 走 memo 跳过
  assert.match(turnRowSource, /if \(prev\.isStreaming \|\| next\.isStreaming\) return false;/);
  assert.match(turnRowSource, /prev\.liveThinkingId === next\.liveThinkingId/);
  // 行头 Pi/DSH 署名随 backend 变化必须重渲染，不能被 memo 吞掉
  assert.match(turnRowSource, /prev\.backend === next\.backend/);
  // 打开文件回调绑定栏级 cwd/project；作用域变化时历史工具卡必须刷新回调。
  assert.match(turnRowSource, /prev\.onOpenFile === next\.onOpenFile/);
  // 思考卡片还有一层自定义 memo；展开后的 Markdown 也必须换到新栏授权上下文。
  assert.match(timelineEventCardsSource, /prev\.onOpenExternal === next\.onOpenExternal/);
  assert.match(timelineEventCardsSource, /prev\.onOpenFile === next\.onOpenFile/);
  // 深度比较入口来自 AppUtils
  assert.match(
    readFileSync("src/renderer/src/components/app/AppUtils.ts", "utf8"),
    /export function sameAgentRunForRender/,
  );
});
