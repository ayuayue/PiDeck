import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 长会话渲染治理契约（2026-08 内存/卡顿批次）：
// message-list 对屏外行启用 content-visibility:auto 跳过 layout/paint，
// 但尾部必须排除——pin 置顶测量（measurePinSpacer）与自动跟随只依赖尾部行，
// 若尾部也走估算盒，垫片高度会按估算值算错，置顶位置漂移。

const timeline = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");

test("message-list skips offscreen row layout via content-visibility", () => {
  assert.match(timeline, /message-list \[&>\*:not\(:nth-last-child\(-n\+\d+\)\)\]:\[content-visibility:auto\]/);
});

test("offscreen rows carry an intrinsic-size fallback with remembered-size auto keyword", () => {
  // auto 关键字 = 渲染过的行用真实高度，未渲染行用估算值；缺了 auto 会导致
  // 已渲染行滚出视口后高度回退到估算值，滚动条持续跳动
  assert.match(timeline, /\[contain-intrinsic-size:auto_\d+px\]/);
});

test("tail exclusion guard covers pin measurement surface", () => {
  // 尾部排除阈值必须 >= 8：pinned 用户消息之下还有思考卡/执行中工具卡/
  // RespondingIndicator/SessionFileSummary/pin 垫片等多个尾部子元素，
  // 阈值太小会把这些测量依赖项也纳入跳过范围
  const match = timeline.match(/nth-last-child\(-n\+(\d+)\)/);
  assert.ok(match, "tail exclusion selector present");
  assert.ok(Number(match[1]) >= 8, `tail exclusion window ${match[1]} must be >= 8`);
});
