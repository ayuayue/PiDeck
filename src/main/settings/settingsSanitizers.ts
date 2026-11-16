/**
 * SettingsStore 的可选数值清洗器（从存量巨文件外移，见 docs/mega-file-split-plan.md）。
 * 读盘与 IPC update 共用同一套规则，避免脏值经 patch 绕过校验直接落盘。
 */

/** 可选正毫秒阈值：非有限数/非正数一律视为未设置；上限 24h（与 ACP 超时同口径）。 */
export function sanitizeOptionalPositiveIntMs(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	const n = Math.floor(value);
	return n > 0 && n <= 86_400_000 ? n : undefined;
}

/**
 * ACP 自动重试次数清洗：0 在这里是有意义的值（= 只试一次），因此不能复用
 * sanitizeOptionalPositiveIntMs；上限 10（与 acpTurnRetry.ACP_TURN_RETRY_LIMITS 同口径）。
 */
export function sanitizeOptionalRetryCount(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	const n = Math.floor(value);
	return n >= 0 && n <= 10 ? n : undefined;
}
