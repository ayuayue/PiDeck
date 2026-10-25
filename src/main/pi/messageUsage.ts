/**
 * pi assistant 消息的 usage → `ChatMessage.meta.usage`。
 *
 * pi 的会话文件与 RPC `message_end` 都带 `usage`（input/output/cacheRead/cacheWrite/
 * reasoning/totalTokens/cost）。轨迹账本与时间线需要的是统一键名（与 DSH adapter
 * 上报的 meta.usage 同形），否则同一功能在两个后端要写两套读取逻辑。
 *
 * 缺字段保持 undefined（= 上游未上报），不补 0：补 0 会让「缓存未命中」与
 * 「没上报」在账本上长得一样。
 */

export type ChatUsageMeta = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	reasoningTokens?: number;
	/** 本次请求花费（pi 按供应商价格算好的美元金额，未上报则不写）。 */
	cost?: number;
};

function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value != null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** pi Usage → meta.usage；input/output 都为 0 或缺失时返回 undefined（无用量可展示）。 */
export function chatUsageFromPiUsage(usage: unknown): ChatUsageMeta | undefined {
	const record = asRecord(usage);
	if (!record) return undefined;
	const inputTokens = asFiniteNumber(record.input) ?? 0;
	const outputTokens = asFiniteNumber(record.output) ?? 0;
	const cacheReadTokens = asFiniteNumber(record.cacheRead);
	const cacheWriteTokens = asFiniteNumber(record.cacheWrite);
	const reasoningTokens = asFiniteNumber(record.reasoning);
	const costRecord = asRecord(record.cost);
	const cost = asFiniteNumber(costRecord?.total);
	if (inputTokens <= 0 && outputTokens <= 0 && cacheReadTokens === undefined && cacheWriteTokens === undefined) return undefined;
	return {
		inputTokens,
		outputTokens,
		...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
		...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
		...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
		...(cost !== undefined ? { cost } : {}),
	};
}
