/**
 * 会话压缩百分比滑条的换算策略（设置页「会话压缩」区块）。
 *
 * pi 的自动压缩触发条件是 contextTokens > contextWindow - reserveTokens，
 * 即 reserveTokens/keepRecentTokens 的直观语义是「默认模型上下文窗口的占比」；
 * 设置页用百分比滑条编辑，落盘仍是绝对 token 数（pi 契约不变）。
 */

/** 滑条下限：1% 起步，避免 0 值让滑条失去意义（reserve=0 等于永不触发余量检查）。 */
export const COMPACTION_SLIDER_MIN_PERCENT = 1;
/** 滑条上限：超过窗口一半意味着压缩过于频繁，没有正常使用场景。 */
export const COMPACTION_SLIDER_MAX_PERCENT = 50;

/**
 * 模型窗口识别不到时的滑条换算基数（tokens）。
 * 取业界最常见约 200k：pi 默认 reserveTokens=16384 / keepRecentTokens=20000 恰为 8%/10%，
 * 滑条刻度与默认值对齐；token 数始终如实展示，百分比仅是编辑手感。
 */
export const COMPACT_REFERENCE_WINDOW_TOKENS = 200_000;

/** 百分比 → 绝对 token 数（四舍五入，非负安全整数）。 */
export function compactionPercentToTokens(percent: number, contextWindow: number): number {
	if (!Number.isFinite(percent) || !Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
	return Math.max(0, Math.round((percent / 100) * contextWindow));
}

/** 绝对 token 数 → 滑条百分比（截断到 [1, 50]；窗口无效时回下限）。 */
export function compactionTokensToPercent(tokens: number, contextWindow: number): number {
	if (!Number.isFinite(tokens) || !Number.isFinite(contextWindow) || contextWindow <= 0) return COMPACTION_SLIDER_MIN_PERCENT;
	return Math.min(COMPACTION_SLIDER_MAX_PERCENT, Math.max(COMPACTION_SLIDER_MIN_PERCENT, Math.round((tokens / contextWindow) * 100)));
}
