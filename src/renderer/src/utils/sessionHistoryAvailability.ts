import type { SessionHistoryUnavailableReason, SessionMessagePage } from "../../../shared/types";

/** 读盘错误态里与「历史暂时读不了」相关的字段（渲染层 SessionLoadState 的子集）。 */
export type SessionHistoryUnavailableState = {
	status: "error";
	reason: SessionHistoryUnavailableReason;
};

/**
 * 「历史暂时读不了」页 → 读盘错误态；普通页返回 null。
 *
 * 为什么所有「读到页就 force 写缓存」的地方都必须过这道闸：DSH host 被手动停止时
 * 主进程会返回 messages 为空、带 `unavailable` 的页（见 main/dsh/dshManualStop 的
 * dshUnavailablePageFor）。force 写缓存会把这个会话刷成空会话——时间线退回起始页、
 * 轨迹面板 total 归零，用户看到的是「我的会话没了」，而真实原因只是运行时被自己停了
 * （2026-09 反馈）。所以命中即早退，让上层的专态 UI 接管。
 *
 * 当前唯一原因是 dsh-host-stopped；其余读取故障仍按普通异常抛出，不会被降级成
 * 「点一下就好」的状态。
 */
export function sessionHistoryUnavailableState(page: Pick<SessionMessagePage, "unavailable">): SessionHistoryUnavailableState | null {
	if (!page.unavailable) return null;
	return { status: "error", reason: page.unavailable };
}
