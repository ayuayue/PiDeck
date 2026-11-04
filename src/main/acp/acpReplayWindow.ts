import type { ChatMessage } from "../../shared/types";

/**
 * ACP 激活重放投递窗口（Phase 2，见 docs/acp-replay-batching-plan.md §0.1/0.2）。
 *
 * 为什么不是 pi 的「尾部 N 轮」：ACP 一轮里每次工具调用都是一条消息，实测 40 条真实
 * 会话里 9 轮窗口仍有 31 条超过 256KB 门禁（单轮最长 200+ 条）。所以口径改成
 * 「条数预算优先、轮边界对齐」：从尾部按轮起点向前累加，条数够了就停，并且一定停在
 * 轮起点上——把一轮切成两半会让工具卡缺上下文。
 *
 * 窗口只是**投递**窗口：更早的历史仍可经「加载更多」按轮翻回来
 * （主进程 acpMessagePage 按轮切片，游标就是这里的 windowStart 下标）。
 */

/** 尾部窗口的条数预算：实测 p50 0.21MB / p90 0.28MB。 */
export const ACP_WINDOW_MAX_MESSAGES = 100;
/** 兜底轮数上限（与 pi 的 9 轮口径对齐），防止全是零散消息的会话窗口无限长。 */
export const ACP_WINDOW_MAX_TURNS = 9;

/** 轮起点口径与 countUserTurns / findTurnPageStart 一致：user 且前一条真实消息不是 user。 */
function isTurnStart(messages: readonly ChatMessage[], index: number): boolean {
	if (messages[index]?.role !== "user") return false;
	for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
		const role = messages[cursor]?.role;
		// 跳过 tool/system 等非对话消息：它们不构成「上一句是谁说的」
		if (role !== "user" && role !== "assistant") continue;
		return role !== "user";
	}
	return true;
}

/**
 * 计算窗口起点（runtime 数组下标空间）。返回值 ≥ 0；等于总条数表示空窗口（仅空会话）。
 */
export function resolveAcpWindowStart(messages: readonly ChatMessage[], options: { maxMessages?: number; maxTurns?: number } = {}): number {
	const total = messages.length;
	if (total === 0) return 0;
	const maxMessages = Math.max(1, options.maxMessages ?? ACP_WINDOW_MAX_MESSAGES);
	const maxTurns = Math.max(1, options.maxTurns ?? ACP_WINDOW_MAX_TURNS);
	let start = total;
	let turns = 0;
	for (let index = total - 1; index >= 0; index -= 1) {
		if (!isTurnStart(messages, index)) continue;
		turns += 1;
		start = index;
		if (turns >= maxTurns) break;
		if (total - index >= maxMessages) break;
	}
	// 没有任何轮结构（全是 tool/system 的异常投影）：退化为按条数截尾，绝不返回空窗口。
	if (start >= total) return Math.max(0, total - maxMessages);
	return start;
}
