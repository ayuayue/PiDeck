/**
 * 会话进行态指示器判定（pi / DSH 共用）。
 *
 * 业务规则：状态条必须跟「此刻屏幕上在发生什么」对齐，不能用粘滞的
 * runtime.isStreaming / 残留 liveThinkingId。优先级：
 * 1. 上下文压缩 → compacting（压缩属于上一轮回答结束后的 runtime 工作）
 * 2. 正在跑工具卡 → executing
 * 3. live 正文仍在推流 → responding（模型已经在写答案）
 * 4. live 思考仍在推流 → thinking（模型还在推理，尚无正文）
 * 5. 发送预热 / runtime starting，且还没有字和工具 → starting
 * 6. 其余空窗（等首 token、工具与正文之间）→ waiting
 *
 * 边界：
 * - activating 刚结束、首字已到时优先 responding，避免「预热」盖住已出的字。
 * - thinking 与 responding 必须分开：两者都只是「有 delta 在推流」，但对应后台两个
 *   不同阶段。合并成一个状态会让状态条在纯推理期就显示「撰写回复」，用户反馈
 *   「动画经常轮询、不能真实反映后台」正是这个粗粒度造成的。
 */
export type RespondingKind = "starting" | "executing" | "thinking" | "responding" | "compacting" | "waiting";

export function deriveRespondingKind(input: { isCompacting?: boolean; isStarting?: boolean; isExecutingTool?: boolean; liveTextStreaming?: boolean; liveThinkingStreaming?: boolean }): RespondingKind {
	if (input.isCompacting) return "compacting";
	if (input.isExecutingTool) return "executing";
	// 正文优先于思考：思考收尾与正文首字可能落在同一批更新里，正文是更外层、更靠后的
	// 阶段。先判正文可避免状态条从「撰写回复」退回「思考中」再跳回来。
	if (input.liveTextStreaming) return "responding";
	if (input.liveThinkingStreaming) return "thinking";
	if (input.isStarting) return "starting";
	return "waiting";
}
