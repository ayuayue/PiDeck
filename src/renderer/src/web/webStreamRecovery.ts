/**
 * Web 端 SSE 断线恢复决策（纯函数，WebChatApp 接线）。
 *
 * 背景：/api/chat 的 SSE 流是一次性 POST 响应，AI SDK useChat 不支持中途续流。
 * 手机锁屏 / 切网 / 后台节流都会断流（status 转 error，或后台暂停事件处理造成
 * 「看似在流、实际已断」）。可行恢复策略 = 落盘追赶：重新拉取会话消息窗口，
 * 用磁盘权威内容替换本地消息——pi 侧不受影响（它继续跑并落盘）。
 *
 * 触发面（外层接线）：
 * - visibilitychange → visible：手机解锁/切回，最常见断流点；
 * - window online：网络恢复；
 * - useChat status === "error"：显式断流。
 * - 主轮询兜底：useChat 已回 ready 但 runtime 仍在跑（刷新页面/端口中断后
 *   页面状态与后端脱节——本轮 SSE 已经死亡，只能落盘追赶；不这样补的话
 *   ready 态永远等不到恢复触发，页面只能手动刷新看一次快照）。
 * 三者都汇到本函数做防抖决策，避免恢复风暴。
 */

export type WebStreamStatus = "submitted" | "streaming" | "ready" | "error";

export type WebRecoveryDecisionInput = {
	status: WebStreamStatus;
	/** pi runtime 仍在跑（running/starting）；ready 态恢复必须带它，避免误拉空闲会话。 */
	runtimeBusy?: boolean;
	documentVisible: boolean;
	online: boolean;
	/** 上次恢复尝试的 epoch ms（0 = 从未）；防抖窗口内不重复拉。 */
	lastAttemptAt: number;
	now: number;
};

export type WebRecoveryDecision = {
	/** 是否执行落盘追赶。 */
	recover: boolean;
	/** 是否向用户提示（首次恢复或 error 态恢复才提示，常规回前台静默同步）。 */
	notify: boolean;
};

/** 恢复防抖：两次追赶至少间隔 5s（页面可见性抖动 / online 事件重复触发）。 */
export const WEB_RECOVERY_DEBOUNCE_MS = 5000;

export function decideStreamRecovery(input: WebRecoveryDecisionInput): WebRecoveryDecision {
	const { status, runtimeBusy, documentVisible, online, lastAttemptAt, now } = input;
	// 不可见页面不追（拉了也没人看；等回前台再触发）
	if (!documentVisible || !online) return { recover: false, notify: false };
	// 只有错误态或活跃流（可能被后台节流悄悄断掉）需要追赶；ready 无流可断。
	// 例外：ready + runtime 忙 = 刷新/断线后的脱节态（SSE 已死但 pi 还在落盘），
	// 此时静默追赶磁盘快照直到 runtime 空闲；没有 runtimeBusy 信号的 ready 仍按空闲处理。
	if (status === "ready") {
		if (!runtimeBusy) return { recover: false, notify: false };
	} else if (status !== "error" && status !== "streaming" && status !== "submitted") return { recover: false, notify: false };
	if (now - lastAttemptAt < WEB_RECOVERY_DEBOUNCE_MS) return { recover: false, notify: false };
	return { recover: true, notify: status === "error" };
}
