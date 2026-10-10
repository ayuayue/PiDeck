import type { TpsDisplayMode } from "./types/settings";

/** 旧设置缺字段或枚举被改坏时保持既有流式口径。 */
export function normalizeTpsDisplayMode(value: unknown): TpsDisplayMode {
	return value === "endToEnd" ? "endToEnd" : "streaming";
}

/** token 与耗时必须来自同一批回复；无用量或无有效耗时就不估算速度。 */
export function calculateTokensPerSecond(outputTokens: number | undefined, durationMs: number | undefined): number | undefined {
	if (outputTokens == null || !Number.isFinite(outputTokens) || outputTokens < 0 || durationMs == null || !Number.isFinite(durationMs) || durationMs <= 0) return undefined;
	const value = outputTokens / (durationMs / 1000);
	return Number.isFinite(value) ? value : undefined;
}

/** 切换只选择已结算的数据；缺数据不回退到另一种统计口径。 */
export function selectTokensPerSecond(mode: TpsDisplayMode, streaming: number | undefined, endToEnd: number | undefined): number | undefined {
	const value = mode === "endToEnd" ? endToEnd : streaming;
	return value != null && Number.isFinite(value) && value >= 0 ? value : undefined;
}
