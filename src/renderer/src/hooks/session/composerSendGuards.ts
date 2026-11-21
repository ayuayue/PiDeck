import type { SendSessionPromptResult } from "../../../../shared/types";

/** 发送结果的四态投影：已投递 / 不可投递（压缩中，退回队列）/ 被拒 / 投递未知。 */
export function classifySessionPromptResult(result: SendSessionPromptResult): "accepted" | "deferred" | "rejected" | "unknown" {
	if (result.accepted) return "accepted";
	if (result.delivery === "unknown") return "unknown";
	// 宿主判定「此刻不可投递」（pi 压缩上下文）：消息确定没送到，但也不是失败，需要改排本地队列。
	return result.deferral ? "deferred" : "rejected";
}

/** 发送锁：同一会话在「空闲直发」期间不接受第二次提交（双击 / 回车连发）。 */
export function createSessionSendLock() {
	const sessionIds = new Set<string>();
	return {
		has: (sessionId: string) => sessionIds.has(sessionId),
		claim: (sessionId: string) => {
			if (sessionIds.has(sessionId)) return false;
			sessionIds.add(sessionId);
			return true;
		},
		release: (sessionId: string) => {
			sessionIds.delete(sessionId);
		},
	};
}
