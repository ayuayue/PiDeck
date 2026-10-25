import type { AgentRunItem } from "../../app/AppUtils";

/**
 * 一条消息是否属于这一轮 agent-run（跳转揭示用；纯函数，可单测）。
 *
 * run.items 是扁平展示序列的输入：普通消息、工具组、思考组、重试/错误诊断、扩展输出组。
 * 跳转目标可能是折叠区里的中间回答或工具卡片正文，只有命中本轮时才由 TurnRow 展开折叠，
 * 避免给所有已挂载的轮次无谓地展开。
 */
export function runContainsMessage(run: AgentRunItem, messageId: string): boolean {
	if (!messageId) return false;
	for (const item of run.items) {
		if (item.kind === "message") {
			if (item.message.id === messageId) return true;
			continue;
		}
		if (item.kind === "retry-group" || item.kind === "error-group") {
			if (item.message.id === messageId || item.id === messageId) return true;
			continue;
		}
		if (item.messages.some((message) => message.id === messageId)) return true;
	}
	return false;
}
