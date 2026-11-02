import type { AppSettings } from "../../../../../shared/types/settings";
import { parseBoundedInteger } from "./acpTimeoutInput";

/**
 * ACP 失败自动重试输入的纯逻辑（范围 + 文本 ↔ 毫秒/次数换算），组件只管状态与写盘。
 *
 * 与主进程 `acpTurnRetry.ts` 的 `ACP_TURN_RETRY_DEFAULTS` / `ACP_TURN_RETRY_LIMITS` 同口径：
 * 两边都硬编码同一组默认值（渲染层不能 import 主进程模块），改一处必须同时改另一处，
 * 因此 `tests/acpRetryInput.test.mjs` 直接对比这两个模块的常量，漂移会红。
 */
export const ACP_RETRY_DEFAULT_ENABLED = true;
export const ACP_RETRY_DEFAULT_MAX_RETRIES = 2;
export const ACP_RETRY_MAX_RETRIES_RANGE = { min: 0, max: 10 } as const;
export const ACP_RETRY_DEFAULT_BASE_DELAY_MS = 2_000;
/** 秒：UI 用秒表达退避（1–60），主进程再换算成毫秒并钳到 200ms 起。 */
export const ACP_RETRY_BASE_DELAY_SECONDS = { min: 1, max: 60 } as const;

export type AcpRetryPatch = Pick<AppSettings, "acpTurnRetryEnabled" | "acpTurnRetryMaxRetries" | "acpTurnRetryBaseDelayMs">;

/** settings 里的次数 → 输入框文本（缺省键显示生效中的代码默认值，用户不改就不写盘）。 */
export function acpRetryMaxRetriesText(value: number | undefined): string {
	return String(value ?? ACP_RETRY_DEFAULT_MAX_RETRIES);
}

/** settings 里的毫秒 → 输入框文本（秒，四舍五入到整秒）。 */
export function acpRetryBaseDelayText(delayMs: number | undefined): string {
	const seconds = Math.round((delayMs ?? ACP_RETRY_DEFAULT_BASE_DELAY_MS) / 1_000);
	return String(Math.max(ACP_RETRY_BASE_DELAY_SECONDS.min, seconds));
}

/** 输入框文本（次数）→ settings patch；非法输入返回 undefined。 */
export function acpRetryMaxRetriesPatch(raw: string): AcpRetryPatch | undefined {
	const value = parseBoundedInteger(raw, ACP_RETRY_MAX_RETRIES_RANGE);
	return value === null ? undefined : { acpTurnRetryMaxRetries: value };
}

/** 输入框文本（秒）→ settings patch；非法输入返回 undefined。 */
export function acpRetryBaseDelayPatch(raw: string): AcpRetryPatch | undefined {
	const seconds = parseBoundedInteger(raw, ACP_RETRY_BASE_DELAY_SECONDS);
	return seconds === null ? undefined : { acpTurnRetryBaseDelayMs: seconds * 1_000 };
}
