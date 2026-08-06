import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const turnRowSource = readFileSync(
  "src/renderer/src/components/session/SurfaceComponents.tsx",
  "utf8",
);

test("renders the execution process segments before the final assistant answer", () => {
  assert.ok(
    turnRowSource.indexOf("{segments.map(renderSegment)}") > 0,
    "TurnRow must render segments",
  );
  assert.ok(
    turnRowSource.lastIndexOf("{segments.map(renderSegment)}") <
      turnRowSource.indexOf("{/* 最终回答"),
    "process/text segments must precede the final answer in TurnRow",
  );
});

// issue #130：回答文本是面向用户的正式内容，不应折进「执行过程」，
// 折叠只针对思考块与工具调用；多段回答逐条平铺，不再摘要成「N次回答」。
test("issue #130: fold contains only thinking and tools, answers stay inline", () => {
  // 折叠详情的渲染函数不再接受 assistant message 分支
  const renderExecutionItem = turnRowSource.match(
    /const renderExecutionItem = \([\s\S]*?\n\t\};/,
  )?.[0] ?? "";
  assert.ok(renderExecutionItem, "renderExecutionItem must exist");
  assert.doesNotMatch(renderExecutionItem, /item\.kind === "message"/);
  assert.match(renderExecutionItem, /thinking-group/);
  assert.match(renderExecutionItem, /ToolGroupCard/);

  // 回答文本段在折叠区外平铺渲染
  const renderSegment = turnRowSource.match(
    /const renderSegment = \([\s\S]*?\n\t\};/,
  )?.[0] ?? "";
  assert.ok(renderSegment, "renderSegment must exist");
  assert.match(renderSegment, /segment\.kind === "text"/);
  assert.match(renderSegment, /timeline-inline-text/);

  // 概要只统计工具/思考，不再计「N次回答」
  const segmentSummary = turnRowSource.match(
    /const segmentSummary = \([\s\S]*?\n\t\};/,
  )?.[0] ?? "";
  assert.ok(segmentSummary, "segmentSummary must exist");
  assert.doesNotMatch(segmentSummary, /executionAnswerCount/);
  assert.doesNotMatch(turnRowSource, /executionAnswerCount/);

  // i18n key 同步移除
  assert.doesNotMatch(
    readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8"),
    /executionAnswerCount/,
  );
  assert.doesNotMatch(
    readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8"),
    /executionAnswerCount/,
  );
});

test("execution summary toggle radius matches other buttons", () => {
  const css = readFileSync("src/renderer/src/styles/timeline.css", "utf8");
  const toggleRule = css.match(/\.execution-summary-toggle \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.ok(toggleRule, ".execution-summary-toggle rule must exist");
  // 与 shadcn rounded-md 同档（--radius-md: 8px），不再用全圆 pill
  assert.match(toggleRule, /border-radius: var\(--radius-md\)/);
  assert.doesNotMatch(toggleRule, /999px/);
});
