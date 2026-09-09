/**
 * Provider 用量自动查询策略（纯函数，无 React）。
 *
 * 抽出原因：打开模型选择器 / 配置页会对每个 provider 扇出 HTTP 用量探测，
 * 需要一处可单测的「该不该发」判定（新鲜期 + 轮询间隔）。
 * 自动查询不再有全局开关：是否查询由每个 provider 的徽章开关决定（enabled），
 * 门控在 useProviderUsageEntry 里按 provider 状态判定；手动刷新永远放行。
 * 本模块可被 Node 单测直接加载。
 */
import type { ProviderUsageEntry } from "../atoms/provider-usage-atoms";

/** 默认自动查询间隔（分钟）：与主进程默认一致（学 cc-switch），0 = 关闭该 provider 的间隔轮询。 */
export const USAGE_PROBE_DEFAULT_INTERVAL_MINUTES = 5;

/** 自动查询触发来源：挂载卡片、轮询、模型选择器批量、用户点击刷新。 */
export type ProviderUsageAutoQueryReason = "mount" | "poll" | "batch" | "manual";

export type ShouldAutoFetchProviderUsageInput = {
	reason: ProviderUsageAutoQueryReason;
	/** 当前缓存条目；从未查过时为 null。poll 不依赖此字段。 */
	entry: Pick<ProviderUsageEntry, "fetchedAt"> | null;
	intervalMinutes: number;
	now?: number;
};

/**
 * entry 是否需要（重）查：
 * - 从未完成过（fetchedAt=null）→ 需要（首查）；
 * - interval <= 0（该 provider 关闭间隔轮询）→ 不需要（只靠手动刷新）；
 * - 否则按 interval 分钟过期判定（默认 5 分钟）。
 */
export function providerUsageEntryStale(
	entry: Pick<ProviderUsageEntry, "fetchedAt"> | null,
	intervalMinutes: number = USAGE_PROBE_DEFAULT_INTERVAL_MINUTES,
	now: number = Date.now(),
): boolean {
	if (!entry || entry.fetchedAt == null) return true;
	if (intervalMinutes <= 0) return false;
	return now - entry.fetchedAt >= intervalMinutes * 60_000;
}

/**
 * 是否应发起一次用量 HTTP 查询。
 *
 * 业务规则：
 * - manual：用户主动刷新，永远发，不看新鲜期。
 * - poll：间隔 <= 0 不排下一次；否则由调用方按 interval 设 timer，到期即发。
 * - mount / batch：走新鲜期（从未查过或已过 interval 才发）。
 * provider 级开关（徽章里的 enabled）在 hook 层门控，本纯函数只管时序。
 */
export function shouldAutoFetchProviderUsage(input: ShouldAutoFetchProviderUsageInput): boolean {
	if (input.reason === "manual") return true;
	if (input.reason === "poll") return input.intervalMinutes > 0;
	return providerUsageEntryStale(input.entry, input.intervalMinutes, input.now ?? Date.now());
}
