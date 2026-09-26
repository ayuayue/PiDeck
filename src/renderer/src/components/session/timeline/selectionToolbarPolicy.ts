/**
 * 时间线「划选引用」浮层的纯策略层。
 * 无 DOM / React 依赖，node:test 可直接加载；DOM 胶水在 useTimelineSelection 里。
 */

/**
 * 引用排除范围（白名单思路的照底表：除中间回复/最终回答/用户气泡正文外，逐项排除）：
 * - `.turn-row--pending`：流式中的 turn（含 live 中间回复，快照会失真）。
 * - `[data-tool-kind]`：工具卡（含卡内展开的输出）。
 * - `[data-retry-step]` / `[data-error-step]`：重试 / 错误诊断行。
 * - `[data-thinking-step]`：思考卡（含展开正文）。
 * - `[data-process-group-head]` / `[data-process-group-body]`：过程组头（摘要按钮）与组体（思考/工具成员）。
 * - `[data-live-answer]`：live 正文副本（打字未定稿）。run 结束后的短暂残留期，轮样式已切成
 *   complete 但 live 副本可能仍在挂载：不加排除的话划选会解析到外层 run id，引用错归属。
 *   live 副本永久不可引用；定稿后由带 data-message-id 的 settled 副本接管。
 * 注意：不再整体排除 `.execution-summary-details`——中间回复（settled InterimAnswer）
 * 就在折叠区内，其正文根节点带 data-message-id，放开后划选可归属到具体消息。
 * 折叠态安全：历史轮折叠=完全卸载、live 轮折叠=display:none，都选不中。
 */
export const QUOTE_EXCLUDED_SELECTOR = ".turn-row--pending, [data-tool-kind], [data-retry-step], [data-error-step], [data-thinking-step], [data-process-group-head], [data-process-group-body], [data-live-answer]";

/** 引用快照长度上限：超长划选截断并提示语义由 label 省略号体现（防极端大文本入 atom）。 */
export const MAX_QUOTE_CHARS = 4000;

export type QuotableRangeInput = {
	/** 选区两端各自解析到的消息 id（data-message-id）；跨消息为 null。 */
	messageIdA?: string | null;
	messageIdB?: string | null;
	/** 两端是否命中排除选择器（流式 / 工具卡 / 折叠过程）。 */
	excludedA: boolean;
	excludedB: boolean;
	text: string;
	maxLength?: number;
};

/**
 * 是否对该划选提供「引用」按钮：
 * - 必须能解析出唯一且一致的来源消息（跨消息边界忽略，对齐 assistant-ui/Codex）；
 * - 两端都不得落在排除区域（两端分开判，防止跨边界选区漏网）；
 * - 文本 trim 后非空且不超长。
 */
export function isQuotableRange(input: QuotableRangeInput): boolean {
	const messageId = input.messageIdA;
	if (!messageId || messageId !== input.messageIdB) return false;
	if (input.excludedA || input.excludedB) return false;
	const text = input.text.trim();
	if (text.length === 0) return false;
	return text.length <= (input.maxLength ?? MAX_QUOTE_CHARS);
}

export type ToolbarViewport = { width: number; height: number };
export type ToolbarRect = {
	top: number;
	left: number;
	width: number;
	height: number;
};
export type ToolbarSize = { width: number; height: number };

/**
 * 浮层定位：默认悬在选区上方居中；顶部放不下时翻转到选区下方；
 * 水平夹紧在视口内（margin=8）。返回 fixed 定位的 top/left。
 */
export function computeToolbarPosition(rect: ToolbarRect, viewport: ToolbarViewport, size: ToolbarSize): { top: number; left: number } {
	const margin = 8;
	const gap = 6;
	const aboveTop = rect.top - gap - size.height;
	const belowTop = rect.top + rect.height + gap;
	const top = aboveTop >= margin ? aboveTop : Math.min(belowTop, viewport.height - margin - size.height);
	const maxLeft = Math.max(margin, viewport.width - margin - size.width);
	const centered = rect.left + (rect.width - size.width) / 2;
	return {
		top: Math.max(margin, top),
		left: Math.min(Math.max(margin, centered), maxLeft),
	};
}
