import type { AgentBackend } from "../../shared/types";

/** 启动期预热目标推断用的 catalog 投影（只取判定需要的字段，便于单测构造）。 */
export type StandbyWarmupCatalogEntry = {
	projectId: string;
	/** 缺省 "pi"：旧 catalog 条目没有 backend 字段，语义与 SessionCatalogEntry.backend 一致。 */
	backend?: AgentBackend;
	updatedAt: number;
};

export type StandbyWarmupTargetInput = {
	entries: readonly StandbyWarmupCatalogEntry[];
	/** 仍然存在的项目 id；已删除项目不能预热（AgentManager.getProject 会直接失败）。 */
	projectIds: ReadonlySet<string>;
	/** 设置项 defaultAgentBackend：新建会话的默认后端。 */
	defaultBackend: AgentBackend;
	now: number;
	/** 非 pi 默认后端时「近期用过 pi」的时间窗；缺省 7 天（测试可注入）。 */
	recentPiWindowMs?: number;
};

const DEFAULT_RECENT_PI_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 选择启动期 pi standby 预热的目标项目（纯函数）。
 *
 * 为什么需要启动期预热：一次 pi RPC 启动实测 8~25s，耗时几乎全在 pi 加载用户扩展；
 * 现有预热只在「草稿创建/激活完成」之后触发，应用刚启动后第一次新建会话（尤其
 * 引导页首条消息：创建草稿后立刻发送）必然吃满一次冷启动。启动期提前起进程可以
 * 把这段耗时藏进应用启动/用户阅读历史的空窗。
 *
 * 取舍（预热是「内存换启动速度」，只该在大概率马上要用时做）：
 * - 默认后端是 pi：下一次新会话大概率落在最近活跃项目，取 catalog 最近一条所属项目；
 * - 默认后端不是 pi：只有时间窗内确实存在 pi 会话才预热——纯 DSH/ACP 用户不必为一个
 *   永远不会用到的进程常驻约 300MB；窗口内没有 pi 会话则不预热；
 * - 已删除项目 / 空 catalog / 非法时间戳 → 不预热（启动预热是优化，宁可不热也不报错）。
 */
export function pickStandbyWarmupProject(input: StandbyWarmupTargetInput): string | undefined {
	let latest: StandbyWarmupCatalogEntry | undefined;
	let latestPi: StandbyWarmupCatalogEntry | undefined;
	const windowMs = input.recentPiWindowMs ?? DEFAULT_RECENT_PI_WINDOW_MS;
	for (const entry of input.entries) {
		if (!entry.projectId || !input.projectIds.has(entry.projectId)) continue;
		if (!Number.isFinite(entry.updatedAt)) continue;
		if (!latest || entry.updatedAt > latest.updatedAt) latest = entry;
		const isPi = (entry.backend ?? "pi") === "pi";
		// 时间窗非法（手改/旧数据）时按 0 处理：只认「现在及以后」的 pi 会话，等价于不预热，
		// 不能因为一个非法窗口把所有历史 pi 会话都当成「近期用过」。
		const windowUsable = Number.isFinite(windowMs) ? Math.max(0, windowMs) : 0;
		const inWindow = input.now - entry.updatedAt <= windowUsable;
		if (isPi && inWindow && (!latestPi || entry.updatedAt > latestPi.updatedAt)) latestPi = entry;
	}
	if (!latest) return undefined;
	if (input.defaultBackend === "pi") return latest.projectId;
	return latestPi?.projectId;
}
