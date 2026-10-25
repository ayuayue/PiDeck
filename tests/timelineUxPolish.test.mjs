import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const toolCard = readFileSync("src/renderer/src/components/session/ToolCallComponents.tsx", "utf8");
const turnExecution = readFileSync("src/renderer/src/components/session/turn/useTurnExecution.ts", "utf8");
const controller = readFileSync("src/renderer/src/hooks/useSessionTimelineController.ts", "utf8");
const sendScroll = readFileSync("src/renderer/src/hooks/timeline/sendScroll.ts", "utf8");
const scroller = readFileSync("src/renderer/src/components/agents/message-scroller.tsx", "utf8");
const turnRow = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");
const timeline = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");

test("tool card name is a faint process-layer label, weight kept normal", () => {
	// 过程层视觉：工具名用 tertiary 浅色退到正文之后；字重保持 normal（不降档，
	// 过轻在 CJK 下会有锯齿感，用户反馈优先保字重、靠颜色区分）。
	// 字号走会话正文轨道（text-chat-row = 正文 −2px）：随「会话正文字号」缩放，不随界面字号。
	assert.match(toolCard, /className="shrink-0 text-chat-row lowercase text-text-faint"/);
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

test("auto-collapse survives without completion-reposition; send-time pin is the only auto-scroll", () => {
	// 最终回答标记仍在（折叠后阅读用）；自动收起回调使用新的 onAutoCollapsed。
	assert.match(turnRow, /data-final-answer=\{run\.id\}/);
	assert.doesNotMatch(controller, /scrollFinalAnswerIntoView/);
	assert.doesNotMatch(turnRow, /onProcessAutoCollapsed/);
	assert.doesNotMatch(timeline, /onProcessAutoCollapsed/);
	assert.match(turnRow, /onAutoCollapsed/);
	// 用户请求（m00677）：去掉完结/切回的自上旋滚动，自动滚动只在「发送那一刻」。
	// 完结定位整链必须移除（scrollFinalAnswerToUpperMiddle 只允许安全的内部 no-op 吞杀）。
	assert.doesNotMatch(timeline, /scheduleFinalAnswerSettle/);
	assert.doesNotMatch(timeline, /scheduleSettleFinalAnswerTop/);
	assert.doesNotMatch(timeline, /settleFinalAnswerTargetPx/);
	// 自动滚动唯一路径：实现住 hooks/timeline/sendScroll.ts（SendScrollPositioner，612bb51c1 起迁移），
	// controller 侧只保留接线：发送时把新 user 行交给独立定位器。
	assert.match(controller, /SendScrollPositioner/);
	assert.doesNotMatch(controller, /scrollFinalAnswerIntoView|scheduleFinalAnswerSettle|scheduleSettleFinalAnswerTop|settleFinalAnswerTargetPx/);
	assert.match(controller, /sendScrollRef\.current\.pin\(timeline, sendMessageId/);
	assert.match(sendScroll, /pinScrollDurationMs\(distance\)/);
	assert.match(sendScroll, /TARGET_GAP_PX = 24/);
	assert.match(sendScroll, /SKIP_EPSILON_PX = 8/);
	assert.match(sendScroll, /CANCEL_INPUTS/);
	assert.match(sendScroll, /cancel = \(\): void/);
	// isLatestRun（自动收起）保持按「最后一条显示条目」判定；
	// live 挂载门用单独的 isLastAgentRun（最后一个 agent-run）判定——
	// 两者语义不同，不能合并（见 liveMountDecision 回归）。
	// 2026-08 perf：判定方式从 index 改为 run id（滚动窗口切片不再翻转位置 props），
	// 语义保持：isLatestRun 用 lastDisplayedItemId、isLastAgentRun 用 latestAgentRunId。
	assert.match(timeline, /isLatestRun=\{item\.id === lastDisplayedItemId\}/);
	assert.match(timeline, /isLastAgentRun=\{item\.id === latestAgentRunId\}/);
	assert.match(timeline, /lastAgentRunIndex/);
});

test("auto-collapse re-checks follow and run state when the idle timer fires", () => {
	// DSH 的「idle 边沿」先于终态 messages flush 到达：安排收起时 latestRunId 可能随后
	// 因末轮重新分组而变化，autoScroll 也可能在 flush 期间短暂翻 false。旧实现用安排时刻
	// 的 run id 做相等判断、且把 autoScroll 放进 effect 依赖（一次翻转即 cleanup 清掉定时器），
	// 结果 DSH 会话结束后执行过程永不自动收起（用户反馈）。
	assert.doesNotMatch(timeline, /\}\s*,\s*\[controller\.autoScroll,\s*hasLiveRuntime/);
	assert.doesNotMatch(timeline, /turnSettleIdleLastRunRef\.current !== latestRunId/);
	assert.match(timeline, /autoScrollRef\.current = controller\.autoScroll/);
	assert.match(timeline, /isRuntimeBusyRef\.current \|\| !autoScrollRef\.current/);
});

test("followOutput re-lock uses spring when far from bottom", () => {
	// 避免回底按钮 setAutoScroll(true) 后被 layout instant 掐死弹簧
	assert.match(scroller, /reduce \|\| distance <= followThreshold \? "instant" : "smooth"/);
});

test("settled reposition removed: no completion-driven scrolling, state-driven send pin only", () => {
	// 2026-09 对抗审查收敛仍适用：鼠标移动/键盘/滚轮/触摸等输入事件不参与滚动取消。
	assert.doesNotMatch(timeline, /addEventListener\("pointermove"/);
	assert.doesNotMatch(timeline, /addEventListener\("pointerdown"/);
	assert.doesNotMatch(timeline, /addEventListener\("wheel"/);
	assert.doesNotMatch(timeline, /addEventListener\("keydown"/);
	assert.doesNotMatch(timeline, /addEventListener\("touchstart"/);
	assert.doesNotMatch(controller, /addEventListener\("wheel", interrupt/);
	assert.doesNotMatch(controller, /addEventListener\("pointerdown", interrupt/);
	// 完结定位系统全删除：不再有完结后的自动滚动/定位目标/完结动画取消链。
	assert.doesNotMatch(timeline, /addEventListener\("wheel", turnSettle/);
	assert.doesNotMatch(timeline, /turnSettleIdleLastRunRef\.current = runId/);
	assert.doesNotMatch(timeline, /armSettledReposition\(latestRunIdRef/);
	const pinScrollSource = readFileSync("src/renderer/src/lib/pinTurnScroll.ts", "utf8");
	assert.doesNotMatch(pinScrollSource, /TAKEOVER_TOLERANCE_PX/);
	// 完结动画取消只依靠历史浏览失效事务/回底/切会话；不再需要 run-start 忙搃取消完结定位。
	assert.doesNotMatch(timeline, /controller\.cancelSettledRepositionForNewRun\(\)/);
	// TurnRow 保留 onAutoCollapsed 通道（自动折叠仍独立于滚动定位）。
	assert.match(turnRow, /onAutoCollapsed/);
});
