/**
 * 手动压缩的统一可用态与结果分类。
 *
 * 可用态（按钮 / /compact 共用）：
 * - 上下文占用数据可用（percent 已上报）即可压缩，不再设占用门槛——
 *   占用很低时点击由 pi 自行判定（nothing-to-do / too-small 按原文分类提示）；
 * - 无占用数据（会话未运行 / 尚未上报）视为未就绪，按钮禁用；
 * - 压缩进行中：拒绝重复请求（不再静默当成功）；
 * - compaction cancelled：**必须可见**且分来源（扩展接管 / 用户打断 / 来源不明）。
 *
 * urgency 色阶保留：≥90 红 / ≥70 黄，仅作视觉提示，不影响可点性。
 */

export type CompactUrgency = "idle" | "warn" | "danger";

export type CompactUiState = {
	/** 上下文占用数据可用（已上报 percent），按钮可点、会发 RPC。 */
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
	/** 被取消但来源判不出：仍要给提示，不能静默。 */
	| "cancelled"
	/** 被会话内的扩展接管：它的 session_before_compact 钩子在总结开始前直接拒绝压缩。 */
	| "cancelledByOwner"
	/** 用户按了停止（或压缩窗口内的回合中断）：压缩是被自己打断的。 */
	| "interrupted"
	/** 接管者有自己的压缩入口，请求已改写成它的扩展命令（如 Magic Context 的 /ctx-wrapup）。 */
	| "routedToOwner"
	/** 等待 RPC 响应超时：pi 进程仍活着、压缩大概率还在后台进行，最终结果以
	 * compaction_end 事件为准，不能当成「压缩失败」提示（#303）。 */
	| "timeout";

/**
 * 取消来源的稳定标记：主进程按证据判定后抛这两条之一，classifyCompactError 只认标记。
 *
 * pi 的原始文案（`Compaction cancelled`）在两条路径上是同一个字符串——扩展钩子
 * `return { cancel: true }` 与 `session.abort()` 打断压缩（agent-session.js 手动路径
 * 1507 / 1537 行）——所以分类信息必须由主进程补上，不能靠猜 pi 的文本。
 */
export const COMPACT_CANCELLED_BY_OWNER = "Compaction cancelled by session_before_compact hook";
export const COMPACT_CANCELLED_BY_USER_ABORT = "Compaction cancelled by user abort";

/**
 * 接管者有自己的手动入口时，主进程把请求改写成它的扩展命令并抛这条标记；
 * 标记后跟命令名（如 `/ctx-wrapup`），渲染层据此给出「已改用 X」的提示。
 */
export const COMPACT_ROUTED_TO_OWNER = "Compaction routed to extension command";

/**
 * 手动压缩等待超时的稳定标记：PiDeck 的 RPC 等待已到时，但 pi 进程仍活着、
 * 压缩大概率仍在后台进行（真实案例：120s 超时报「压缩失败」，149.4s 后台实际
 * 压缩成功并写入会话文件，#303）。主进程识别超时错误后抛这条标记，渲染层
 * 映射为「仍在后台进行」而非「失败」；最终结果由 compaction_end 事件反馈。
 */
export const COMPACT_WAIT_TIMEOUT = "Compact wait timed out; still running in background";

/** 从 `Compaction routed to extension command: /ctx-wrapup` 取出命令名。 */
export function compactRoutedCommand(raw: string): string | null {
	const index = raw.indexOf(COMPACT_ROUTED_TO_OWNER);
	if (index < 0) return null;
	const command = raw
		.slice(index + COMPACT_ROUTED_TO_OWNER.length)
		.replace(/^[:：\s]+/, "")
		.split(/\s+/)[0]
		?.trim();
	return command && command.startsWith("/") ? command : null;
}

/** 从接管标记后取出原因片段（主进程把 `notes` 拼在标记后），无则返回 null。 */
export function compactOwnerReason(raw: string): string | null {
	const index = raw.indexOf(COMPACT_CANCELLED_BY_OWNER);
	if (index < 0) return null;
	const reason = raw
		.slice(index + COMPACT_CANCELLED_BY_OWNER.length)
		.replace(/^[:：\-\s]+/, "")
		.trim();
	return reason.length > 0 ? reason : null;
}

/**
 * 判定「扩展接管」的耗时阈值：compaction_start → compaction_end 短于该值，
 * 说明钩子在**总结开始前**就拒绝了（没走 LLM 调用）。真正的压缩要秒级起步。
 */
export const COMPACT_HOOK_REJECT_MAX_MS = 1500;

/** 用户 abort 的判定窗口：pi 的 abort 会 abortCompaction，取消结果紧随其后到达。 */
export const COMPACT_USER_ABORT_WINDOW_MS = 10_000;

/**
 * 上次 compaction 观测的保鲜期：超过它就不能用来解释这次的取消
 * （用户可能十分钟前压过一次，这次是另一回事）。
 */
export const COMPACT_OBSERVATION_MAX_AGE_MS = 60_000;

/** 圆环/压缩可用性判定用的占用字段；与 runtime state / 圆环 occupancy 同源。 */
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
export function resolveCompactUsagePercent(state?: CompactUsageInput | null): number | null {
	if (state?.contextPercent == null) return null;
	let percent = state.contextPercent;
	const used = state.contextTokens;
	const contextWindow = state.contextWindow;
	if (percent <= 0 && used != null && used > 0 && contextWindow != null && contextWindow > 0) {
		percent = (used / contextWindow) * 100;
	}
	return percent;
}

/** 圆环压缩按钮的可见交互态：压缩中禁用；无占用数据（percent 未上报）也禁用。
 * 占用达标与否不再影响可点性（随时可压缩），urgency 色阶仅作视觉提示。 */
export function compactUiState(percent: number | null | undefined, compacting: boolean): CompactUiState {
	return {
		ready: percent != null,
		compacting,
		urgency: percent == null ? "idle" : percent >= 90 ? "danger" : percent >= 70 ? "warn" : "idle",
	};
}

/**
 * 把 pi/DSH/IPC 错误原文收成统一 kind。调用方再映射 i18n。
 *
 * 取消类不再返回「不提示」：手动压缩是用户主动点的，静默等于「点了没反应」
 * ——这正是一次真实排查的形态（billion-context-pi 取消 pi 压缩 + 静默映射）。
 */
export function classifyCompactError(raw: string): CompactNoticeKind {
	const lower = raw.trim().toLowerCase();
	if (!lower) return "failed";
	if (/nothing to compact|already compacted/.test(lower)) return "nothingToDo";
	if (/session too small|too small|not ready|below threshold/.test(lower)) {
		return "tooSmall";
	}
	if (/already compacting|compaction in progress/.test(lower)) return "inProgress";
	// 改写（路由到接管者命令）必须排在取消之前：改写的文案里带 "cancelled" 之外的
	// `Compaction routed ...`，但先判它可避免将来文案交叉时归错类。
	if (/compaction routed to extension/.test(lower)) return "routedToOwner";
	// 等待超时必须排在 cancelled/failed 之前：超时只说明「没等到响应」，pi 进程
	// 仍活着时压缩大概率还在后台跑，归成 failed 会让用户误以为已确认失败（#303）。
	if (/compact wait timed out/.test(lower)) return "timeout";
	// 取消必须在 inProgress 之后：后者含 compacting，前者含 compaction cancelled。
	// 来源标记（主进程抛出的稳定文案）优先于 pi 原始文本。
	if (/session_before_compact|cancelled by owner|cancelled by extension/.test(lower)) {
		return "cancelledByOwner";
	}
	if (/cancelled by user abort|cancelled by abort/.test(lower)) return "interrupted";
	if (/compaction cancelled|cancelled/.test(lower)) return "cancelled";
	return "failed";
}
