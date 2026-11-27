/**
 * runtime 会话「加载更早历史」的游标准入判定（纯函数，无依赖）。
 *
 * 抽出来的原因：这段判定埋在 jotai atom 里，只有整条 IPC + atom 组装起来才跑得到，
 * 而它错一次的症状是「点加载更多永远失败」——按钮能点、每次都红、游标永不变。
 *
 * 首屏 history 页允许哪些数值游标？三个都是同一个会话的合法起点，取哪一个由上游
 * 决定（见 historyPagePolicy.resolveEarlierHistoryCursor）：
 *   - windowStart            runtime 数组下标（ACP / 激活窗口起点）
 *   - pageNextBefore         磁盘/远端页游标（窗口会话的首屏页常写在这里）
 *   - historyNextBefore      已翻过页时的续页游标
 *
 * 其余数值一律拒绝：一次错游标会把窗口前那段以外的消息拼进来。
 *
 * 反例（2026-11-25 真机，12754 条会话）：首屏只认 windowStart，而 runtime 给的游标是
 * nextBefore=12326（≠ windowStart），于是首次点击就 rejected-cursor，用户看到
 * 「更早的历史加载失败 / 按钮可再重试」，重试永远同样失败。
 */
export type HistoryPageCursorState = {
	/** 是否已有 history 前缀段（已翻过至少一页历史）。 */
	hasHistory: boolean;
	/** history.nextBefore：上一页写回的续页游标。 */
	historyNextBefore?: number | null;
	/** 激活窗口起点（runtime 数组下标）。 */
	windowStart?: number;
	/** page.nextBefore：磁盘/远端页游标。 */
	pageNextBefore?: number | null;
	/** 本次请求的游标；undefined = 首屏（文件头 / entryId 锚点），不带数值。 */
	before?: number | null;
};

/** 返回 "ok" 表示可以合并这一页，返回 "rejected-cursor" 表示游标不是本会话的合法起点。 */
export function resolveHistoryPageCursorDecision(state: HistoryPageCursorState): "ok" | "rejected-cursor" {
	if (state.hasHistory) {
		return state.historyNextBefore === state.before ? "ok" : "rejected-cursor";
	}
	// 首屏：undefined 表示文件头 / entryId 锚点，永远合法。
	if (state.before === undefined) return "ok";
	const candidates = [state.windowStart, state.pageNextBefore];
	for (const candidate of candidates) {
		if (typeof candidate === "number" && candidate === state.before) return "ok";
	}
	return "rejected-cursor";
}
