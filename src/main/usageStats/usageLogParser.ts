/**
 * pi-tracker usage.jsonl 行解析（防御式纯函数）。
 *
 * 数据格式来自 pi-tracker@0.3.0（src/storage/jsonl-store.ts）：
 *   10 字段（旧版）: [ts, sid, cwd, model, in, out, cR, cW, tot, cost]
 *   11 字段（新）  : 同上 + costKnown(0|1)
 *
 * 外部插件产物视为不可信输入：坏行/类型错一律跳过不抛异常，
 * 兼容规则与上游自身逻辑保持一致（costKnown 推断见 parseCostKnown）。
 */

import type { UsageRecord } from "../../shared/types/usageStats";

/** 合法字段数：10（旧）或 11（新）。 */
const ACCEPTED_FIELD_COUNTS = new Set([10, 11]);

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * 兼容旧日志：11 字段直接读 costKnown；10 字段按 cost > 0 推断
 * （与 pi-tracker readAll 的 costKnown 兼容逻辑一致）。
 */
function parseCostKnown(row: unknown[], cost: number): boolean {
	if (row.length > 10) {
		return row[10] === 1;
	}
	return cost > 0;
}

/** 解析一行；非法行返回 null（调用方计数，不中断）。 */
export function parseUsageLogLine(line: string): UsageRecord | null {
	if (!line.trim()) return null;

	let row: unknown;
	try {
		row = JSON.parse(line);
	} catch {
		return null;
	}
	if (!Array.isArray(row)) return null;
	if (!ACCEPTED_FIELD_COUNTS.has(row.length)) return null;

	const ts = row[0];
	const sid = row[1];
	const cwd = row[2];
	const model = row[3];
	const input = row[4];
	const output = row[5];
	const cacheRead = row[6];
	const cacheWrite = row[7];
	const totalTokens = row[8];
	const cost = row[9];

	if (!isFiniteNumber(ts) || ts <= 0) return null;
	if (typeof sid !== "string" || sid.length === 0) return null;
	if (typeof cwd !== "string") return null;
	if (typeof model !== "string" || model.length === 0) return null;
	// 数值字段做防御：非法类型视为坏行（不静默清零，避免脏数据污染统计）
	for (const value of [input, output, cacheRead, cacheWrite, totalTokens, cost]) {
		if (!isFiniteNumber(value)) return null;
	}

	return {
		ts,
		sid,
		cwd,
		model,
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens,
		cost,
		costKnown: parseCostKnown(row, cost),
	};
}

export type ParseLogResult = {
	records: UsageRecord[];
	/** 坏行数（空行不计入坏行） */
	skippedLines: number;
};

/** 解析整段日志内容（读取层逐段调用后合并即可）。 */
export function parseUsageLogContent(content: string): ParseLogResult {
	const records: UsageRecord[] = [];
	let skippedLines = 0;
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		const record = parseUsageLogLine(line);
		if (record) {
			records.push(record);
		} else {
			skippedLines++;
		}
	}
	return { records, skippedLines };
}
