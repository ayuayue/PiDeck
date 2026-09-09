import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const toolCard = readFileSync(
  "src/renderer/src/components/session/ToolCallComponents.tsx",
  "utf8",
);
const turnExecution = readFileSync(
  "src/renderer/src/components/session/turn/useTurnExecution.ts",
  "utf8",
);
const controller = readFileSync(
  "src/renderer/src/hooks/useSessionTimelineController.ts",
  "utf8",
);
const scroller = readFileSync(
  "src/renderer/src/components/agents/message-scroller.tsx",
  "utf8",
);
const turnRow = readFileSync(
  "src/renderer/src/components/session/turn/TurnRow.tsx",
  "utf8",
);
const timeline = readFileSync(
  "src/renderer/src/components/session/SessionMessageTimeline.tsx",
  "utf8",
);

test("tool card name is a faint process-layer label, weight kept normal", () => {
  // 过程层视觉：工具名用 tertiary 浅色退到正文之后；字重保持 normal（不降档，
  // 过轻在 CJK 下会有锯齿感，用户反馈优先保字重、靠颜色区分）
  assert.match(
    toolCard,
    /className="shrink-0 text-control lowercase text-text-faint"/,
  );
  assert.doesNotMatch(toolCard, /font-light/);
  assert.doesNotMatch(toolCard, /font-\[650\]/);
  // ToolActivityCard 也不再用 <strong> 加粗
  assert.doesNotMatch(toolCard, /tool-activity-copy>\s*<strong>/);
  assert.match(toolCard, /tool-activity-name/);
});

test("latest turn auto-collapses from the timeline idle signal after streaming", () => {
  // 1.5s idle 计时在 timeline 侧；TurnRow 只消费 autoCollapseTick。
  assert.doesNotMatch(turnExecution, /}, 1500\)/);
  assert.match(timeline, /TURN_SETTLE_IDLE_COLLAPSE_MS = 1500/);
  assert.match(turnExecution, /autoCollapseTick/);
  assert.match(turnExecution, /onAutoCollapsed/);
  // 不再在「运行中 → 停转」边沿自动展开执行过程（旧 2026-12 兼容行为已移除）
  assert.doesNotMatch(turnExecution, /const justFinished = wasRunningRef\.current && !running;/);
  // 上升沿仍只在设置①开启时展开，避免用户收起后被 busy 抖动撑开
  assert.match(turnExecution, /!wasRunningRef\.current/);
  assert.match(turnExecution, /setStepsVisibleFromUser/);
});

test("scrollToBottom uses stick-to-bottom spring via scrollerScrollApiRef", () => {
  assert.match(controller, /scrollerScrollApiRef/);
  assert.match(controller, /api\.scrollToBottom\(\{ animation \}\)/);
  // 不再把回底按钮绑成裸 timeline.scrollTo 作为主路径（兜底除外）
  assert.match(scroller, /scrollApiRef/);
  assert.match(scroller, /MessageScrollerScrollApi/);
  assert.match(timeline, /scrollApiRef=\{controller\.scrollerScrollApiRef\}/);
});

test("auto-collapse uses run-start positioning without breaking follow semantics", () => {
  // 最终回答标记仍在（折叠后阅读用）；自动收起回调使用新的 onAutoCollapsed。
  assert.match(turnRow, /data-final-answer=\{run\.id\}/);
  assert.doesNotMatch(controller, /scrollFinalAnswerIntoView/);
  assert.doesNotMatch(turnRow, /onProcessAutoCollapsed/);
  assert.doesNotMatch(timeline, /onProcessAutoCollapsed/);
  assert.match(turnRow, /onAutoCollapsed/);
  assert.match(controller, /scrollFinalAnswerToUpperMiddle/);
  assert.match(controller, /data-final-answer/);
  assert.match(controller, /SETTLED_TURN_VIEWPORT_ANCHOR_RATIO/);
  // isLatestRun（自动收起）保持按「最后一条显示条目」判定；
  // live 挂载门用单独的 isLastAgentRun（最后一个 agent-run）判定——
  // 两者语义不同，不能合并（见 liveMountDecision 回归）。
  // 2026-08 perf：判定方式从 index 改为 run id（滚动窗口切片不再翻转位置 props），
  // 语义保持：isLatestRun 用 lastDisplayedItemId、isLastAgentRun 用 latestAgentRunId。
  assert.match(timeline, /isLatestRun=\{item\.id === lastDisplayedItemId\}/);
  assert.match(timeline, /isLastAgentRun=\{item\.id === latestAgentRunId\}/);
  assert.match(timeline, /lastAgentRunIndex/);
});

test("followOutput re-lock uses spring when far from bottom", () => {
  // 避免回底按钮 setAutoScroll(true) 后被 layout instant 掐死弹簧
  assert.match(
    scroller,
    /reduce \|\| distance <= followThreshold \? "instant" : "smooth"/,
  );
});

test("settled positioning is state-driven, inputs never cancel it", () => {
  // 2026-09 对抗审查收敛：鼠标移动/键盘/滚轮/触摸等输入事件不参与「最终回答
  // 安静定位」的取消——只有「已结束且仍跟随」才触发，只有状态边界（真实上滚/回底/
  // 切会话/新一轮）才取消。
  assert.doesNotMatch(timeline, /addEventListener\("pointermove"/);
  assert.doesNotMatch(timeline, /addEventListener\("pointerdown"/);
  assert.doesNotMatch(timeline, /addEventListener\("wheel"/);
  assert.doesNotMatch(timeline, /addEventListener\("keydown"/);
  assert.doesNotMatch(timeline, /addEventListener\("touchstart"/);
  assert.doesNotMatch(controller, /addEventListener\("wheel", interrupt/);
  assert.doesNotMatch(controller, /addEventListener\("pointerdown", interrupt/);
  // 状态驱动取消仍然保留：
  // - 引擎真实输入（wheel/touch）带 source="input" → 终止在途定位动画；
  // - 历史浏览失效事务（回底/重锁/切会话）→ invalidateHistoryBrowsing 取消。
  assert.match(controller, /source === "input"/);
  assert.match(controller, /settleScrollCancelRef\.current\?\.\(\);/);
  // 对抗审查补修：
  // - F1：新一轮开始（busy 边沿）取消在途 settle 动画并恢复跟随贴底；
  // - P2-①：动画期间用户接管（拖动滚动条等）经几何检测中断，不再逐帧覆盖；
  // - P2-②：切回补挂 arm 幂等，已消费过 tick 的 run 不再重复 arm（记忆优先）。
  assert.match(controller, /cancelSettledRepositionForNewRun/);
  assert.match(timeline, /controller\.cancelSettledRepositionForNewRun\(\)/);
  // 滚动条拖动取消用「命中滚动条区域」的事件判定；不用几何分叉启发式——
  // 内容收缩 clamp 也会改变 scrollTop，几何启发式会误判并取消定位动画。
  assert.match(controller, /onScrollbarPointerDown/);
  assert.match(controller, /event\.clientX >= rect\.left \+ timeline\.clientWidth/);
  const pinScrollSource = readFileSync(
    "src/renderer/src/lib/pinTurnScroll.ts",
    "utf8",
  );
  assert.doesNotMatch(pinScrollSource, /TAKEOVER_TOLERANCE_PX/);
  assert.match(timeline, /settleTickConsumedRunRef/);
  // 触发时序不变：1.5s 阅读停顿 + 320ms 布局稳定窗口。
  assert.match(timeline, /TURN_SETTLE_IDLE_COLLAPSE_MS = 1500/);
  assert.match(timeline, /TURN_SETTLE_SCROLL_DELAY_MS/);
  // TurnRow 保留 onAutoCollapsed 通道（契约不依赖折叠回调驱动定位，但可扩展）。
  assert.match(turnRow, /onAutoCollapsed/);
});
