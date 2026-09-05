/**
 * 手动压缩的统一门槛与结果分类。
 *
 * 历史问题：底栏 compact chip（>30% 才出现）迁入上下文圆环后，压缩按钮几乎
 * 总是可点；占用很低时点下去会打 RPC，pi 回 nothing-to-do / too-small，
 * 用户觉得「没到级别还弹提示」。成功路径又不弹 toast，重复点击在压缩中
 * 被主进程当成功返回，表现为「点了没反应」。
 *
 * 统一规则（按钮 / /compact / 主进程跳过 共用同一套分类）：
 * - 占用 < COMPACT_READY_PERCENT：客户端视为未就绪，不发 RPC；
 * - 占用达标：发 RPC，成功 toast、失败按原文分类；
 * - 压缩进行中：拒绝重复请求（不再静默当成功）；
 * - compaction cancelled：静默（自动压缩撞车 / 新消息打断）。
 */

/** 建议手动压缩的占用门槛（与旧 compact chip >30% 一致）。 */
export const COMPACT_READY_PERCENT = 30;

export type CompactUrgency = "idle" | "warn" | "danger";

export type CompactUiState = {
	/** 占用达到建议门槛，按钮可点、会发 RPC。 */
	ready: boolean;
	compacting: boolean;
	urgency: CompactUrgency;
};

export type CompactNoticeKind =
	| "done"
	| "nothingToDo"
	| "tooSmall"
	| "inProgress"
	| "failed"
	| "silent";

/** 门槛判定用的占用字段；与 runtime state / 圆环 occupancy 同源。 */
export type CompactUsageInput = {
	contextPercent?: number | null;
	contextTokens?: number | null;
	contextWindow?: number | null;
};

/**
 * 把 runtime 上报收成「圆环/压缩门槛用」的占用百分比。
 * pi/dsh 偶发 percent=0 但 tokens 非 0（取整或尚未随 tokens 刷新）；
 * 圆环会按 tokens/window 重算，斜杠 /compact 必须用同一数字，否则会出现
 * 「圆环显示 40%、按钮可点，/compact 却提示太小」的分叉。
 * percent 缺失返回 null：草稿刚启动尚未上报，不在客户端拦截。
 * 不封顶 100：pi 按 tokens/contextWindow 直接计算（缓存超窗等场景可 >100%），
 * 其 CLI footer 也显示原始值；封顶会让「真实 112%」显示成 100%，与
 * ~used/window 原始数字及会话头部明细（用原始值）互相矛盾。
 */
export function resolveCompactUsagePercent(
	state?: CompactUsageInput | null,
): number | null {
	if (state?.contextPercent == null) return null;
	let percent = state.contextPercent;
	const used = state.contextTokens;
	const contextWindow = state.contextWindow;
	if (percent <= 0 && used != null && used > 0 && contextWindow != null && contextWindow > 0) {
		percent = (used / contextWindow) * 100;
	}
	return percent;
}

/** 圆环压缩按钮的可见交互态：压缩中禁用；未达标也禁用（避免打空 RPC）。 */
export function compactUiState(
	percent: number | null | undefined,
	compacting: boolean,
): CompactUiState {
	const usage = percent ?? 0;
	return {
		ready: usage >= COMPACT_READY_PERCENT,
		compacting,
		urgency: usage >= 90 ? "danger" : usage >= 70 ? "warn" : "idle",
	};
}

/** 客户端是否应拦截手动压缩（未达门槛且当前没在压）。percent 用 resolveCompactUsagePercent 的结果。 */
export function shouldSkipCompactForLowUsage(
	percent: number | null | undefined,
	compacting: boolean,
): boolean {
	if (compacting) return false;
	if (percent == null) return false;
	return percent < COMPACT_READY_PERCENT;
}

/**
 * 把 pi/DSH/IPC 错误原文收成统一 kind。
 * 调用方再映射 i18n；silent = 不弹 toast。
 */
export function classifyCompactError(raw: string): CompactNoticeKind {
	const lower = raw.trim().toLowerCase();
	if (!lower) return "failed";
	if (/nothing to compact|already compacted/.test(lower)) return "nothingToDo";
	if (/session too small|too small|not ready|below threshold/.test(lower)) {
		return "tooSmall";
	}
	if (/already compacting|compaction in progress/.test(lower)) return "inProgress";
	// cancelled 必须在 inProgress 之后：后者含 compacting，前者含 compaction cancelled
	if (/compaction cancelled|cancelled/.test(lower)) return "silent";
	return "failed";
}
