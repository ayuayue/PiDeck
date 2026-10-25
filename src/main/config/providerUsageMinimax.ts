/**
 * MiniMax Coding Plan（Token Plan / M Plan）用量解析（纯函数，可单测）。
 *
 * 端点：GET /v1/token_plan/remains（官方 FAQ 现用）与旧版
 * /v1/api/openplatform/coding_plan/remains；国内域 api.minimaxi.com、海外域
 * api.minimax.io 各一套，路径都在 host 根下（故候选用 rootPath 只取 baseUrl origin）。
 *
 * 响应 = { base_resp: { status_code, status_msg }, model_remains: [...] }：
 * - model_remains 每行是一个模型桶（general = 文本/编码，video = 视频生成），
 *   各带 5 小时滚动窗（current_interval_*）与周窗（current_weekly_*）；
 * - 鉴权失败也是 HTTP 200，只能看 base_resp.status_code（1004 没带 key、
 *   2049 key 与域名不匹配，如把海外 key 配到国内域），非 0 一律判未命中；
 * - 新响应里 general 桶的 *_total_count / *_usage_count 恒为 0，真实额度只体现在
 *   *_remaining_percent（剩余百分比），故以它为准，旧响应缺 percent 时才回退计数。
 *
 * 接口报「剩余」，UI 要「已用」，故 percent = 100 - remaining（否则快用完的套餐会
 * 被画成几乎没用，方向反了就完全误导）。
 */
import type { ProviderUsagePeriod } from "../../shared/types/providerUsage";
import type { UsageProbeResponse } from "./providerUsageProbe";
import { getByPath, toNumber } from "./providerUsagePath";

/** 文本/编码额度所在的桶；video 桶是视频生成额度，不计入模型用量展示。 */
const GENERAL_BUCKET = "general";
const VIDEO_BUCKET = "video";

type WindowPrefix = "current_interval" | "current_weekly";

/** 百分比收窄到 0-100：上游越界时进度条会画出轨道。 */
function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}

/** 保留一位小数，避免 1/3 这类值把 UI 撑成 33.333333。 */
function roundPercent(value: number): number {
	return Math.round(value * 10) / 10;
}

/** 接口时间字段是 epoch 毫秒；非正数按「未上报」处理（不是 1970）。 */
function isoFromMillis(value: unknown): string | undefined {
	const ms = toNumber(value);
	if (ms === undefined || ms <= 0) return undefined;
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * 一档窗口的已用百分比。
 * `*_remaining_percent` 优先——它是新响应里唯一无歧义的额度字段。
 * 旧响应没有 percent 时退到计数：官方文档把 `*_usage_count` 标成「剩余用量」
 * （已用 = total - usage_count），社区早期实现均按此读；没有 total 就无法换算，
 * 该档直接缺失（宁可少一档，也不显示反了的数字）。
 */
function usedPercent(row: Record<string, unknown>, prefix: WindowPrefix): number | undefined {
	const remainingPercent = toNumber(getByPath(row, `${prefix}_remaining_percent`));
	if (remainingPercent !== undefined) return roundPercent(clampPercent(100 - remainingPercent));
	const total = toNumber(getByPath(row, `${prefix}_total_count`));
	const remainingCount = toNumber(getByPath(row, `${prefix}_usage_count`));
	if (total === undefined || total <= 0 || remainingCount === undefined) return undefined;
	const used = total - Math.min(Math.max(remainingCount, 0), total);
	return roundPercent(clampPercent((used / total) * 100));
}

/** 拼一档 periods：百分比必有，重置时间可能缺（缺就不给，UI 的 resetsAt 是可选的）。 */
function windowPeriod(row: Record<string, unknown>, prefix: WindowPrefix, resetAtKey: string): ProviderUsagePeriod | undefined {
	const percent = usedPercent(row, prefix);
	if (percent === undefined) return undefined;
	const resetsAt = isoFromMillis(getByPath(row, resetAtKey));
	return resetsAt ? { percent, resetsAt } : { percent };
}

/**
 * 选桶：general 是编码套餐真正计入的额度；若上游给桶改名，退到第一个非 video 行，
 * 都不满足才判失败——把套餐画成 0% 占用比不显示更误导。
 */
function pickBucketRow(rows: unknown[]): Record<string, unknown> | undefined {
	const objects = rows.filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && !Array.isArray(row));
	const isBucket = (row: Record<string, unknown>, name: string) => getByPath(row, "model_name") === name;
	return objects.find((row) => isBucket(row, GENERAL_BUCKET)) ?? objects.find((row) => !isBucket(row, VIDEO_BUCKET));
}

export function parseMinimaxPlan(body: unknown, raw: string): UsageProbeResponse {
	if (!body || typeof body !== "object" || Array.isArray(body)) return { matched: false, raw };
	// 鉴权/业务失败走 HTTP 200，靠 status_code 区分；缺失视为旧响应（无该字段）。
	const statusCode = toNumber(getByPath(body, "base_resp.status_code"));
	if (statusCode !== undefined && statusCode !== 0) return { matched: false, raw };
	const rows = getByPath(body, "model_remains");
	if (!Array.isArray(rows)) return { matched: false, raw };
	const row = pickBucketRow(rows);
	if (!row) return { matched: false, raw };
	const rolling = windowPeriod(row, "current_interval", "end_time");
	const weekly = windowPeriod(row, "current_weekly", "weekly_end_time");
	if (!rolling && !weekly) return { matched: false, raw };
	const periods: NonNullable<UsageProbeResponse["periods"]> = {};
	if (rolling) periods.rolling = rolling;
	if (weekly) periods.weekly = weekly;
	return { matched: true, kind: "periods", periods };
}
