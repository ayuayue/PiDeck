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
	return input.intent === "up" && input.scrollTop <= input.expandThreshold && input.windowExpandable && !input.hasPendingExpand && input.cooldownElapsed;
}

export interface DelayedHistoryResultGate {
	/** 是否已回到跟随态（回底按钮 / 手动滚回底部）。 */
	following: boolean;
	/** 发起分页请求时的历史浏览代数。 */
	generationAtRequest: number;
	/** 当前浏览代数（回底/切会话会递增）。 */
	currentGeneration: number;
	/** 用户显式点击「加载更多对话」：贴底时也应用。
	 *  贴底引擎每帧把 autoScroll 报回 true；沿用 following 门时，点击后数据进了缓存、
	 *  渲染窗口不扩，界面逐字不变（2026-11 真机：点「加载更多对话」毫无反应）。 */
	explicit?: boolean;
}

/** 迟到的历史分页结果是否仍允许驱动 DOM 扩窗：
 *  已回底（following）或浏览代数已过期时只允许写缓存，扩窗/锚点恢复一律跳过。
 *  例外是显式点击：用户亲手点「加载更多对话」就说明他要看更早的内容，贴底态也得应用，
 *  否则那次点击是恒等变换（数据进缓存、窗口不扩、界面不动）。 */
export function shouldApplyDelayedHistoryResult(gate: DelayedHistoryResultGate): boolean {
	if (gate.generationAtRequest !== gate.currentGeneration) return false;
	return gate.explicit === true || !gate.following;
}

/** 发起翻页的来源。 */
export type LoadMoreSource = "scroll" | "button" | "backfill";

/** 翻页前要先做的动作。 */
export type LoadMorePinStep = "escapeFollow" | "capturePin";

/** 翻页前置动作序列，**数组顺序就是执行顺序**。
 *
 *  顺序是承重结构，不是风格问题：captureBrowsePin 首行在 autoScrollRef 为真时直接 return，
 *  而贴底态这个值一直是真（引擎每帧上报 following）。所以必须先把 autoScroll 打掉再抓钉行，
 *  否则贴底点「加载更多对话」一个钉行都抓不到；没有钉行，引擎的 following 上报又不会被忽略，
 *  扩窗批次会被 consumeExpandBatch 首行清掉，界面逐字不变（2026-11 真机症状）。
 *
 *  反过来写（先 capture 再 escape）在静态检查与旧测试下全绿，功能却是坏的 —— 这类缺陷只能靠
 *  把顺序变成数据、再用单测钉住，所以这个函数存在。 */
export function planLoadMorePinSteps(source: LoadMoreSource): readonly LoadMorePinStep[] {
	if (source === "button") return ["escapeFollow", "capturePin"];
	if (source === "scroll") return ["capturePin"];
	return [];
}
