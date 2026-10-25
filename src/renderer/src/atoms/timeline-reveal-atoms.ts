import { atom } from "jotai";

/**
 * 时间线「揭示目标」请求（按会话）：跳转目标消息在**已加载数据**里，但 DOM 节点没挂载——
 * 典型场景是命中落在已完成轮的执行过程折叠区里（Radix 折叠收起会整块卸载中间回答/工具），
 * 或者落在单轮挂载预算之外。controller 发请求，包含这条消息的 TurnRow 收到后展开执行过程，
 * 让节点落地后再滚动/高亮。
 *
 * 为什么不直接改折叠记忆 atom：记忆只在 TurnRow 挂载时读一次（useTurnExecution 的初始态），
 * 对已挂载的行改了不生效；这里用「请求 + nonce」让已挂载的行也能即时响应，同一目标重复点击
 * 也会重新触发。记录式（而不是 atomFamily）与 session-find-atoms 同一形态：
 * 只有被请求会话的那一格换引用，其它会话的订阅者不会重渲染。
 */
export type TimelineRevealRequest = { messageId: string; nonce: number };

export const timelineRevealRequestsAtom = atom<Readonly<Record<string, TimelineRevealRequest>>>({});

/** 写入一次揭示请求：同一会话 nonce 自增，重复跳同一目标也能触发已挂载的 TurnRow。 */
export const requestTimelineRevealAtom = atom(null, (get, set, input: { sessionId: string; messageId: string }) => {
	const { sessionId, messageId } = input;
	if (!sessionId || !messageId) return;
	const current = get(timelineRevealRequestsAtom);
	const nonce = (current[sessionId]?.nonce ?? 0) + 1;
	set(timelineRevealRequestsAtom, { ...current, [sessionId]: { messageId, nonce } });
});

/** 结算（跳转成功/放弃/切会话）后清掉本会话的请求，避免切回来时把旧轮次自动撑开。 */
export const clearTimelineRevealAtom = atom(null, (get, set, sessionId: string) => {
	if (!sessionId) return;
	const current = get(timelineRevealRequestsAtom);
	if (!(sessionId in current)) return;
	const next = { ...current };
	delete next[sessionId];
	set(timelineRevealRequestsAtom, next);
});
