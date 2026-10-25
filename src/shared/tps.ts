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

/** 时间区间 [startMs, endMs] */
export type TimeInterval = [start: number, end: number];

/**
 * 区间并集（Interval Union）：将可能重叠的时间区间合并为若干互不相交的闭区间，
 * 计算净活跃时间总和（毫秒）。
 * 消除派生任务（如 subagent 派生并发执行）耗时重叠累加导致分母虚高、算出的平均 TPS 偏低的问题。
 */
export function calculateIntervalUnionDurationMs(intervals: ReadonlyArray<TimeInterval>): number {
	if (intervals.length === 0) return 0;
	const valid: Array<[number, number]> = [];
	for (const [start, end] of intervals) {
		if (typeof start === "number" && typeof end === "number" && Number.isFinite(start) && Number.isFinite(end) && end > start) {
			valid.push([start, end]);
		}
	}
	if (valid.length === 0) return 0;
	valid.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

	let totalDuration = 0;
	let currentStart = valid[0][0];
	let currentEnd = valid[0][1];

	for (let i = 1; i < valid.length; i++) {
		const [nextStart, nextEnd] = valid[i];
		if (nextStart <= currentEnd) {
			if (nextEnd > currentEnd) {
				currentEnd = nextEnd;
			}
		} else {
			totalDuration += currentEnd - currentStart;
			currentStart = nextStart;
			currentEnd = nextEnd;
		}
	}
	totalDuration += currentEnd - currentStart;
	return totalDuration;
}

/** 单次模型调用或派生任务的性能区间。 */
export interface TaskPerfSpan {
	id?: string;
	/** 请求或任务启动时间戳 (epoch ms) */
	startedAt: number;
	/** 首个有效 token / delta 时间戳 (epoch ms，仅流式可用) */
	firstDeltaAt?: number;
	/** 任务或回复结束时间戳 (epoch ms) */
	completedAt: number;
	/** 本次生成的 output/completion tokens */
	outputTokens: number;
}

/** 会话级平均性能统计结果。 */
export interface SessionPerfStats {
	/** 会话级平均流式 TPS（output tokens ÷ 解码活跃耗时并集）。 */
	sessionTps?: number;
	/** 会话级平均端到端 TPS（output tokens ÷ 整体活跃耗时并集）。 */
	sessionEndToEndTps?: number;
	/** 纳入统计的输出 tokens 总和。 */
	totalOutputTokens: number;
	/** 消除重叠后的整体净活跃耗时（毫秒）。 */
	activeDurationMs: number;
	/** 消除重叠后的纯流式解码净活跃耗时（毫秒）。 */
	activeStreamingDurationMs: number;
}

/**
 * 计算整段会话的平均 TPS（支持流式与端到端两种口径）。
 * 针对并发任务（如 subagent 派生执行）通过活跃时间区间并集消除重叠耗时。
 */
export function calculateSessionTokensPerSecond(spans: ReadonlyArray<TaskPerfSpan>): SessionPerfStats {
	if (!spans || spans.length === 0) {
		return {
			totalOutputTokens: 0,
			activeDurationMs: 0,
			activeStreamingDurationMs: 0,
		};
	}

	const validSpans = spans.filter((s) => typeof s.outputTokens === "number" && Number.isFinite(s.outputTokens) && s.outputTokens >= 0 && typeof s.startedAt === "number" && typeof s.completedAt === "number" && s.completedAt > s.startedAt);

	if (validSpans.length === 0) {
		return {
			totalOutputTokens: 0,
			activeDurationMs: 0,
			activeStreamingDurationMs: 0,
		};
	}

	// 1. 端到端口径：所有有效任务的 outputTokens 总和 ÷ 整体活跃时间区间并集
	let totalOutputTokens = 0;
	const e2eIntervals: TimeInterval[] = [];
	for (const span of validSpans) {
		totalOutputTokens += span.outputTokens;
		e2eIntervals.push([span.startedAt, span.completedAt]);
	}
	const activeDurationMs = calculateIntervalUnionDurationMs(e2eIntervals);
	const sessionEndToEndTps = calculateTokensPerSecond(totalOutputTokens, activeDurationMs);

	// 2. 流式口径（纯生成）：有首 token delta 记录的任务 outputTokens 总和 ÷ 解码活跃时间区间并集
	const streamingSpans = validSpans.filter((s) => typeof s.firstDeltaAt === "number" && Number.isFinite(s.firstDeltaAt) && s.firstDeltaAt > 0 && s.completedAt > s.firstDeltaAt);

	let streamingOutputTokens = 0;
	const streamingIntervals: TimeInterval[] = [];
	for (const span of streamingSpans) {
		streamingOutputTokens += span.outputTokens;
		streamingIntervals.push([span.firstDeltaAt!, span.completedAt]);
	}
	const activeStreamingDurationMs = calculateIntervalUnionDurationMs(streamingIntervals);
	const sessionTps = calculateTokensPerSecond(streamingOutputTokens, activeStreamingDurationMs);

	return {
		sessionTps,
		sessionEndToEndTps,
		totalOutputTokens,
		activeDurationMs,
		activeStreamingDurationMs,
	};
}
