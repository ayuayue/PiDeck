/**
 * DSH agent 预设（会话「模式」）「创建即固定」的锁定判据（单一数据源）。
 *
 * 为什么放 shared：模式只在 host 建会话（composeAgent）时一次性组合，之后无法切换。
 * 主进程在 `sessions:catalog-update` 边界要拒绝改写，渲染层要靠同一判据决定
 * 胶囊是「可选」还是「只读」。两边各写一份的后果是判据漂移——
 * 曾经主进程按「active 或已有 runtime」锁、渲染层只看「有 runtime」，
 * 于是草稿/激活失败残留的会话在界面上仍可点，点完直接收到原始 IPC 报错。
 */

/** 锁定判定的输入：全部来自会话记录 + 当前 runtime 绑定，主/渲染两侧都能取到。 */
export type DshAgentPresetLockState = {
	/** 会话后端；只有 dsh 有 agent 预设语义。 */
	backend?: string;
	/** catalog 状态：active = 已激活/已导入/已发送过的会话。 */
	status?: "draft" | "active";
	/** host 会话身份；存在即说明预设已由 host header 权威持有（激活失败/停止后也残留）。 */
	dshSessionId?: string;
	/** 当前是否存在 runtime 绑定（草稿期预热/发送后未回收都算）。 */
	hasRuntime: boolean;
};

/**
 * 该会话的 agent 预设是否已固定（不可再改）。
 *
 * 三个条件都表示「host 已经按某个预设组合过（或即将组合）这个会话」：
 * - `hasRuntime`：当前有活着的 runtime，改预设也只会写进 catalog，host 不会重组合；
 * - `dshSessionId`：host 会话已建，preset 存在会话 header 里；
 * - `status === "active"`：已导入/已激活的会话（含 DSH 历史导入，可能暂未 attach）。
 * 只放行「未激活、还没 host 会话、也没有 runtime」的草稿，才是真正能改的时机。
 */
export function isDshAgentPresetLocked(state: DshAgentPresetLockState): boolean {
	if (state.backend !== "dsh") return false;
	return state.hasRuntime || Boolean(state.dshSessionId) || state.status === "active";
}
