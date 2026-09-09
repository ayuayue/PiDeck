/**
 * 启动预热策略（纯函数，无 React，可被 Node 单测直接加载）。
 *
 * 背景：徽章数据只来自「查询过的结果」。应用启动后如果什么都不查，用户打开模型/认证页
 * 只能看到「查询中」或空态——所以启动时要主动跑一轮。但一轮全量扇出会把
 * 「多个 provider 共用同一本地网关」打熔断，因此策略是：
 *   - 只预热**已显式开启**的 provider（默认关，所以通常只有几条）；
 *   - 串行 + 固定间隔错峰（默认 300ms），不并发打同一网关。
 */
import type { UsageProbeBackend, UsageProbeProviderState } from "../../../shared/types/providerUsage";

/** 预热目标：provider 名（主进程按它解析端点）+ 查询链路。 */
export type ProviderUsageWarmupTarget = {
	provider: string;
	backend: UsageProbeBackend;
};

/** 错峰间隔（毫秒）：每个 provider 之间留出的空档。 */
export const PROVIDER_USAGE_WARMUP_GAP_MS = 300;

/** DSH 链路缓存 key 前缀（与 useProviderUsage 的 usageCacheKey 规则一致）。 */
const DSH_CACHE_PREFIX = "dsh:";

/**
 * 从状态表挑出预热目标：只取 enabled=true 的条目。
 *
 * 状态表 key 是渲染层缓存 key（pi = provider 名；dsh = `dsh:<provider>`），
 * 这里反解回「原始 provider 名 + backend」交给查询链路——主进程只认原始名。
 * 顺序固定（pi 在前、各自按名字排序），让每次启动的请求顺序可预期、便于排查。
 */
export function selectWarmupProviders(
	states: Record<string, UsageProbeProviderState>,
): ProviderUsageWarmupTarget[] {
	const targets: ProviderUsageWarmupTarget[] = [];
	for (const [cacheKey, state] of Object.entries(states)) {
		if (!state?.enabled) continue;
		if (cacheKey.startsWith(DSH_CACHE_PREFIX)) {
			targets.push({ provider: cacheKey.slice(DSH_CACHE_PREFIX.length), backend: "dsh" });
		} else {
			targets.push({ provider: cacheKey, backend: "pi" });
		}
	}
	return targets.sort((a, b) => {
		if (a.backend !== b.backend) return a.backend === "pi" ? -1 : 1;
		return a.provider.localeCompare(b.provider);
	});
}

/** 第 index 个预热目标的启动延迟：0, gap, 2*gap, …（串行错峰，避免同时打同一网关）。 */
export function warmupDelayMs(index: number, gapMs: number = PROVIDER_USAGE_WARMUP_GAP_MS): number {
	if (!Number.isFinite(index) || index <= 0) return 0;
	return Math.round(index * Math.max(0, gapMs));
}
