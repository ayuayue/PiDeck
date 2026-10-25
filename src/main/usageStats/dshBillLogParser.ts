/**
 * dsh-bill records.jsonl 行解析（防御式纯函数）。
 *
 * 数据格式来自 dsh-bill@0.13.0（`$DSH_HOME/dsh-bill/records.jsonl`）：
 *   { time, sessionId, provider, model, inputTokens, outputTokens,
 *     cacheReadTokens, cacheWriteTokens, usd, priced, ... }
 *
 * 外部插件产物视为不可信输入：坏行/类型错一律跳过不抛异常。
 * cwd 不在记录里（花费按机器而非项目落盘），项目桶用 "dsh" 占位，避免空路径挤成一行无名项目。
 */

import type { UsageRecord } from "../../shared/types/usageStats";

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 拼成与 pi-tracker 一致的 "provider/model"。
 * 模型名已带 "/"（如 openrouter/deepseek-chat）时不再重复加 provider。
 */
export function dshBillModelKey(provider: string | undefined, model: string): string {
	if (!provider || provider === "unknown") return model;
	if (model.includes("/")) return model;
	return `${provider}/${model}`;
}

/** 解析一行 dsh-bill JSON 对象；非法行返回 null（调用方计数，不中断）。 */
export function parseDshBillLogLine(line: string): UsageRecord | null {
	if (!line.trim()) return null;

	let row: unknown;
	try {
		row = JSON.parse(line);
	} catch {
		return null;
	}
	if (typeof row !== "object" || row === null || Array.isArray(row)) return null;

	const rec = row as Record<string, unknown>;
	const ts = rec.time;
	const sid = nonEmptyString(rec.sessionId);
	const modelName = nonEmptyString(rec.model);
	if (!isFiniteNumber(ts) || ts <= 0) return null;
	if (!sid || !modelName) return null;

	const input = rec.inputTokens ?? 0;
	const output = rec.outputTokens ?? 0;
	const cacheRead = rec.cacheReadTokens ?? 0;
	const cacheWrite = rec.cacheWriteTokens ?? 0;
	if (!isFiniteNumber(input) || input < 0) return null;
	if (!isFiniteNumber(output) || output < 0) return null;
	if (!isFiniteNumber(cacheRead) || cacheRead < 0) return null;
	if (!isFiniteNumber(cacheWrite) || cacheWrite < 0) return null;

	// priced=false / usd 缺失 = 目录未命中，成本未知（显示 n/a 而非 0）
	const usd = rec.usd;
	const priced = rec.priced === true && isFiniteNumber(usd);
	const cost = priced ? usd : 0;
	const provider = nonEmptyString(rec.provider);

	return {
		ts,
		sid,
		cwd: "DSH",
		model: dshBillModelKey(provider, modelName),
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost,
		costKnown: priced,
	};
}
