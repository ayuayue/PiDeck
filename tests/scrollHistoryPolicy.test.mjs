import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function compile(filePath) {
  const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, require: () => ({}) });
  return module.exports;
}

const policy = compile("src/renderer/src/hooks/timeline/scrollHistoryPolicy.ts");

function expandInput(overrides = {}) {
  return {
    intent: "up",
    scrollTop: 100,
    expandThreshold: 257,
    windowExpandable: true,
    hasPendingExpand: false,
    cooldownElapsed: true,
    ...overrides,
  };
}

// 用户反馈 bug（2026-09）：活动 run 的内容收缩（live→settled 交接、工具/Markdown
// 重排、回底 6→3 轮窗口收回）会让浏览器 clamp scrollTop 并派发 scroll 事件；
// controller 旧逻辑仅凭 scrollTop 变小判「用户上滑」，误调 expandWindowBatched →
// escapeAutoScroll → 运行中脱离吸底、回底按钮连点无效。
// 修复：自动扩窗必须同时满足「引擎上报的用户上滚意图（intent=up）」。
// 布局 resize/动画/程序化定位不会上报意图，收缩造成的 clamp 上移恒为 none/down。
test("shrink clamp without user intent never auto-expands (bug 1 regression)", () => {
  // 内容收缩：scrollTop 变小 + 进入近顶部区间，但意图为 none → 不扩窗
  assert.equal(policy.shouldAutoExpandRenderWindow(expandInput({ intent: "none" })), false);
  // 用户正在下滚（意图 down）时发生的 clamp 上移也不扩窗
  assert.equal(policy.shouldAutoExpandRenderWindow(expandInput({ intent: "down" })), false);
});

// 真实用户上滚浏览历史：只有「本次意图 up + 近顶部区间 + 窗口可扩」全满足才扩窗。
test("real user up-scroll in the near-top zone expands the window", () => {
  assert.equal(policy.shouldAutoExpandRenderWindow(expandInput()), true);
  // 未进入近顶部区间不扩窗
  assert.equal(policy.shouldAutoExpandRenderWindow(expandInput({ scrollTop: 400 })), false);
  // 窗口已全量挂载（不可再扩）不扩窗
  assert.equal(policy.shouldAutoExpandRenderWindow(expandInput({ windowExpandable: false })), false);
  // 已有在途扩窗批次不重复提交
  assert.equal(policy.shouldAutoExpandRenderWindow(expandInput({ hasPendingExpand: true })), false);
  // 自动扩窗冷却中不扩窗
  assert.equal(policy.shouldAutoExpandRenderWindow(expandInput({ cooldownElapsed: false })), false);
});

// 用户反馈 bug（2026-09）：回底点击后，在途历史分页响应无条件 expandWindowBatched，
// 会把刚收回的 3 轮窗口重新扩回去（回底按钮连点无效的另一半）。
// 修复：跟随态或浏览代数过期时，迟到结果只允许写缓存，不得扩窗。
test("late history page after go-bottom may write cache but must not expand window", () => {
  // 已回底（following=true）：即使代数未变也不扩窗
  assert.equal(
    policy.shouldApplyDelayedHistoryResult({ following: true, generationAtRequest: 3, currentGeneration: 3 }),
    false,
  );
  // 浏览代数已过期（回底/切会话递增代数）：不扩窗
  assert.equal(
    policy.shouldApplyDelayedHistoryResult({ following: false, generationAtRequest: 3, currentGeneration: 4 }),
    false,
  );
  // 正常浏览中到达且代数未变：允许扩窗
  assert.equal(
    policy.shouldApplyDelayedHistoryResult({ following: false, generationAtRequest: 3, currentGeneration: 3 }),
    true,
  );
});

test("policy types are exported for the controller to consume", () => {
  const source = readFileSync(
    "src/renderer/src/hooks/timeline/scrollHistoryPolicy.ts",
    "utf8",
  );
  assert.match(source, /export type ScrollBrowseIntent = "up" \| "down" \| "none";/);
  assert.match(source, /export function shouldAutoExpandRenderWindow/);
  assert.match(source, /export function shouldApplyDelayedHistoryResult/);
});