/**
 * 历史消息改写的路径分类（编辑/删除/重发）。
 *
 * 核心策略：pi 会话的编辑/重发走「fork 到该消息 entry 重试」（与 zcode retryTurn 同构），
 * 删除没有 fork 语义仍走文件墓碑；DSH 先不动保持 legacy 路径。
 * - persisted + pi + 编辑/重发 → fork-mutation：fork 到目标 entry（旧分支完整留在原文件），
 *   子会话立即重发（原文或新文本）。activate=!live：冷会话先激活（standby 池摊薄成本），
 *   live 会话无需先停（pi fork 会中断当前运行）。
 * - persisted + 删除 → catalog：文件墓碑（live 时先停）。
 * - persisted + DSH → catalog：legacy 行为不变（主进程本就拒绝 DSH 编辑，行为兜底）。
 * - 匿名（--no-session，无文件）：pi 的 edit/delete/resend 三条命令在 AgentManager 里
 *   都要求 runtime.tab.sessionPath，缺失即抛 "Session not persisted"——编辑/删除只能明确
 *   告知不支持；重发退化为把原消息文本重新提交（没有文件可截断旧轮次，新轮次就是一次新尝试）。
 * - 生图 draft（无 pi JSONL、直连生图 API）：重发把失败提示词放回输入框（ImageSessionStore
 *   兜底历史），见 restoreImageGenTurn。
 *
 * live 由调用方按运行时 status 判定后显式传入：target 存在不代表 live（error/closed
 * 终态 Agent 仍持有绑定，target 非空但进程已死，不能再走「先停」路径）。
 */
export type HistoryMutationKind = "edit" | "delete" | "resend";

export type HistoryMutationPath = { path: "unsupported-anonymous"; reason: Exclude<HistoryMutationKind, "resend"> } | { path: "runtime-anonymous-resend" } | { path: "imagegen-resend" } | { path: "fork-mutation"; activate: boolean } | { path: "catalog"; live: boolean };

export function resolveHistoryMutationPath(options: { kind: HistoryMutationKind; live: boolean; persisted: boolean; isImageGenSession?: boolean; isDshSession?: boolean }): HistoryMutationPath {
	const { kind, live, persisted, isImageGenSession, isDshSession } = options;
	if (persisted) {
		// 编辑/重发 fork 化；删除与 DSH 保持 legacy 文件路径
		if (kind !== "delete" && !isDshSession) {
			return { path: "fork-mutation", activate: !live };
		}
		return { path: "catalog", live };
	}
	if (kind === "resend") {
		if (isImageGenSession) return { path: "imagegen-resend" };
		return { path: "runtime-anonymous-resend" };
	}
	return { path: "unsupported-anonymous", reason: kind };
}

/**
 * 重发发送结果 → 是否要补「已回滚」说明 toast。
 *
 * submitPromptSnapshot 返回 true=已接受、"unknown"=投递未知（可能已送达，不能断言「未送出」）、
 * false=确定失败。仅确定失败时提示：重发与普通发送不同，发送前已经截断了该消息之后的历史，
 * 只弹 API 错误用户看不出时间线为什么变短、数据是否丢失（「重发坏了」类反馈多源于此）。
 */
export function shouldShowResendRollbackHint(delivered: boolean | "unknown"): boolean {
	return delivered === false;
}
