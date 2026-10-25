/**
 * webQueueFlush — 待发送队列的投递判定（纯函数，无 React / 无 DOM，vm 沙箱可单测）。
 *
 * Web 端队列语义对齐桌面 followUp：pi 在回合进行中拒收新 prompt（turnActive），
 * 所以回合内的提交先本地暂存，等回合真正结束再按序投递。判定条件全部收在这里，
 * 避免「什么时候该发」散落在 effect 的 if 链里（漏一个条件就会在流式中硬发、或在
 * 用户正回答提问时叠一条消息）。
 */

export type QueueFlushInput = {
	/** 本端流式（useChat status submitted/streaming）。 */
	streaming: boolean;
	/** 外部流（桌面端/其他设备发起的回合）正在推送。 */
	externalStreaming: boolean;
	/** 本会话 runtime 状态。 */
	runtimeStatus?: string;
	/** 是否有挂起的 Ask/权限提问（等用户回答时不该自动发下一条）。 */
	hasPendingUiRequest: boolean;
	/** 停止后暂停自动投递（用户再次主动发送才恢复）。 */
	paused: boolean;
	/** 当前会话待发送条数。 */
	queuedCount: number;
	/** 已有一次投递在途（防重复消费）。 */
	flushing: boolean;
};

/** 是否现在就该投递队首。 */
export function shouldFlushQueuedPrompt(input: QueueFlushInput): boolean {
	if (input.flushing) return false;
	if (input.queuedCount <= 0) return false;
	if (input.paused) return false;
	if (input.streaming || input.externalStreaming) return false;
	if (input.hasPendingUiRequest) return false;
	// runtime 仍在跑（本端流已断但 pi 未收口，如切后台再回来）→ 继续等
	if (input.runtimeStatus === "running" || input.runtimeStatus === "starting") return false;
	return true;
}
