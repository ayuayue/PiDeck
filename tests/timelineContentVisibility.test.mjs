import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 长会话渲染治理契约（2026-08 调整）：
// 移除 content-visibility 估算高度（旧方案对屏外行用 240px 估算，展开/折叠工具卡
// 或思考卡时浏览器按估算修正滚动位置，产生屏幕抖动）。
// 替代方案（学 Proma）：靠「总折叠 + 各自折叠」压缩单行 DOM 体积，
// 分页（useMessagePagination / disk 轮次页）继续做窗口治理。

const timeline = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");
const turnRow = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");

test("message-list no longer estimates offscreen row height via content-visibility", () => {
  // 旧估算高度是展开/折叠抖动的根源：不再对 message-list 行应用 content-visibility 工具类
  assert.doesNotMatch(timeline, /message-list[^\n]*\[content-visibility:auto\]/);
  assert.doesNotMatch(timeline, /message-list[^\n]*contain-intrinsic-size:auto_\d+px/);
});

test("long-session window governance stays via turn-based history loading", () => {
  // 2026-11 轮次模型：100 条分页器已删除，长会话治理改由
  // 「贴底挂载窗口 + 按轮补历史（主进程缓存优先/文件兜底）」承担。
  const controller = readFileSync(
    "src/renderer/src/hooks/useSessionTimelineController.ts",
    "utf8",
  );
  assert.doesNotMatch(controller, /useMessagePagination/);
  assert.match(controller, /RUNTIME_HISTORY_TURN_PAGE_SIZE/);
  assert.match(controller, /beforeEntryId: anchorEntryId/);
});

test("single-turn DOM stays light via default-collapsed process group", () => {
  // 学 Proma：执行过程总折叠默认收起（历史 run 不弹开），单 turn DOM 体积小
  const turnExecution = readFileSync(
    "src/renderer/src/components/session/turn/useTurnExecution.ts",
    "utf8",
  );
  // 非 live（只看历史/会话空闲）的轮一律折叠：已完成轮只留最终回答，
  // 无最终回答的中断轮（stop/steer 打断）同样收起（旧实现把设置①误用于静止历史，
  // 导致只看历史时中断轮整段展开——用户反馈后收紧）。
  assert.match(turnExecution, /if \(!opts\.agentRunning\) return false;/);
  // 手动 override 最高优先：上升沿不清 override、不撑开手动折叠过的轮次
  assert.match(turnExecution, /!userOverrideRef\.current/);
  // 1.5s idle 自动收起由 timeline 统一计时，TurnRow 消费 autoCollapseTick；
  // 历史 run 默认折叠、流式上升沿才展开，仍然保证单 turn DOM 轻量。
  assert.doesNotMatch(turnExecution, /}, 1500\)/);
  assert.match(turnExecution, /autoCollapseTick/);
  assert.match(turnExecution, /!wasRunningRef\.current/);
});

test("process group uses CollapsibleContent height transition", () => {
  // 总折叠用 Radix CollapsibleContent（自带 height 过渡动画），替代 display:none 突变
  assert.match(turnRow, /<Collapsible/);
  assert.match(turnRow, /<CollapsibleContent/);
});

test("user messages fold long text beyond 8 lines with an expand toggle", () => {
  // 长发送消息默认折叠（line-clamp-8），右下角「展开全文/收起」切换；
  // 溢出检测用 ResizeObserver 对比 scrollHeight/clientHeight（折叠态下测量）。
  const surface = readFileSync(
    "src/renderer/src/components/session/SurfaceComponents.tsx",
    "utf8",
  );
  assert.match(surface, /line-clamp-8/);
  assert.match(surface, /messageExpanded/);
  assert.match(surface, /ResizeObserver/);
  assert.match(surface, /scrollHeight > el\.clientHeight \+ 1/);
  assert.match(surface, /t\("app\.messageExpand"\)/);
  assert.match(surface, /t\("app\.messageCollapse"\)/);
});

test("compaction card stays retired: no dashed summary card, no compaction copy", () => {
  // 压缩摘要卡片按产品决策下线（与 dsh 后端行为对齐）：压缩进行态由 RespondingIndicator
  // 「正在压缩」承担，compaction system 消息在 SessionMessageTimeline 里不渲染。
  // 旧卡专用的 Minimize 图标行、虚线摘要框、app.compactionExpand 文案已一并移除；
  // 此断言固化下线事实，防止卡片未走评审悄悄回来。
  const cards = readFileSync(
    "src/renderer/src/components/session/TimelineEventCards.tsx",
    "utf8",
  );
  assert.doesNotMatch(cards, /📁|📂/);
  assert.doesNotMatch(cards, /Minimize size=\{15\}/);
  assert.doesNotMatch(cards, /border-dashed border-border-subtle/);
  assert.doesNotMatch(cards, /app\.compactionExpand/);
});

test("content enter animation mounts before paint (no flash-then-fade)", () => {
  // 闪屏根因：useEffect 在 paint 后补挂淡入类，内容先以正常透明度绘制一帧，
  // 再被动画重置到 opacity 0 重新淡入 = 「闪一下再淡入」。
  // 触发必须同步（useLayoutEffect），让内容挂载的第一帧就带动画类。
  const surface = readFileSync(
    "src/renderer/src/components/session/SessionMessageTimeline.tsx",
    "utf8",
  );
  const enterBlock = surface.slice(
    surface.indexOf("会话内容就绪淡入"),
    surface.indexOf("// ── 失败/重试 toast"),
  );
  assert.match(enterBlock, /useLayoutEffect\(\(\) => \{\n\s*if \(prevConversationLoadingRef\.current && !isConversationLoading\) \{\n\s*setContentEntering\(true\);/);
  // 类清理（非视觉关键）留在 useEffect，不在 layout 阶段多一次重渲染
  assert.match(enterBlock, /const timer = window\.setTimeout\(\(\) => setContentEntering\(false\), 180\);/);
});
