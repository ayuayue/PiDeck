/**
 * 历史浏览滚动策略（纯函数，无 React/DOM 依赖，可独立单测）。
 *
 * 根因修复（2026-09）：controller 的近顶部自动扩窗/预取监听此前仅凭
 * 「scrollTop 变小」推断用户上滑。活动 run 的 live→settled 交接、工具/Markdown
 * 重排、回底时窗口 6→3 轮收回，都会让浏览器把 scrollTop clamp 到新的最大值并
 * 派发 scroll 事件——被误判为「用户上滑」→ expandWindowBatched →
 * escapeAutoScroll → 运行中脱离吸底 / 回底按钮连点无效。
 *
 * 本模块把「用户意图」与「布局滚动」分开：
 * - 用户意图（intent）只由 stick 引擎从 wheel/触摸/滚动条等真实输入逐次上报
 *   （见 useStickToBottom 的 onUserIntent）；resize/动画/程序化定位没有授权入口；
 * - controller 在下一帧直接消费该事件，不再用另一套 scroll 监听和 sticky 方向拼接；
 * - 回底/切会话（following=true 或浏览代数过期）之后到达的历史页结果只写缓存，
 *   不再驱动 DOM 扩窗与锚点恢复——迟到分页不得把刚回底的视口重新拉回历史模式。
 */
export type ScrollBrowseIntent = "up" | "down" | "none";

export interface AutoExpandScrollInput {
  /** 引擎上报的用户滚动意图（唯一的授权信号）。 */
  intent: ScrollBrowseIntent;
  scrollTop: number;
  /** 近顶部自动扩窗阈值（resolveAutoExpandThreshold 的产出）。 */
  expandThreshold: number;
  /** 渲染窗口是否仍可扩展（windowExpandableRef）。 */
  windowExpandable: boolean;
  /** 是否已有在途/待消费的扩窗批次（pending + rAF 队列）。 */
  hasPendingExpand: boolean;
  /** 自动扩窗冷却是否已过。 */
  cooldownElapsed: boolean;
}

/** 是否允许自动扩窗：必须同时满足「本次真实用户上滚事件 + 进入近顶部区间」。
 *  内容收缩产生的 clamp 没有用户意图事件，因此不会调用这条策略。 */
export function shouldAutoExpandRenderWindow(input: AutoExpandScrollInput): boolean {
	return (
		input.intent === "up" &&
		input.scrollTop <= input.expandThreshold &&
		input.windowExpandable &&
		!input.hasPendingExpand &&
		input.cooldownElapsed
	);
}

export interface DelayedHistoryResultGate {
  /** 是否已回到跟随态（回底按钮 / 手动滚回底部）。 */
  following: boolean;
  /** 发起分页请求时的历史浏览代数。 */
  generationAtRequest: number;
  /** 当前浏览代数（回底/切会话会递增）。 */
  currentGeneration: number;
}

/** 迟到的历史分页结果是否仍允许驱动 DOM 扩窗：
 *  已回底（following）或浏览代数已过期时只允许写缓存，扩窗/锚点恢复一律跳过。 */
export function shouldApplyDelayedHistoryResult(gate: DelayedHistoryResultGate): boolean {
	return !gate.following && gate.generationAtRequest === gate.currentGeneration;
}