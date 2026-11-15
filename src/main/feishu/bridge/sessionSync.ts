/**
 * bridge/sessionSync — PiDeck → 飞书的用户消息转发与文档意图登记。
 *
 * 从 FeishuBridge.ts 原样搬出的一域：用户消息转发在未绑定时先补建 mirror，
 * 并检测「要做飞书文档」的意图，记下来等 Agent 回答完后自动创建。
 *
 * 结果同步（agent_end → syncPiMessageToFeishu）留在宿主：它的去重指纹与
 * stop() 的清空位置是同一份状态。
 */

import type { AgentTab } from "../../../shared/types";
import { wantsFeishuDoc } from "../docActions";
import type { LarkClient } from "../types";

/** 协作者对宿主的最小依赖面：绑定查表 + 出站消息 + mirror 补建 + 待建文档表。 */
export type FeishuSessionSyncHost = {
	client: () => LarkClient | null;
	getBestChatId: (sessionOrAgentId: string) => string | undefined;
	sendSmartMessage: (chatId: string, text: string) => Promise<boolean>;
	listAgents: () => AgentTab[];
	ensureSessionMirror: (agentId: string, sessionTitle?: string, sessionPath?: string) => Promise<string | undefined>;
	/** 待自动创建的飞书文档（宿主 stop() 统一清空）。 */
	pendingDocRequests: Map<string, string>;
};

export class FeishuSessionSync {
	constructor(private readonly host: FeishuSessionSyncHost) {}

	/** 显式标记当前会话要在 Agent 回答完后创建飞书文档 */
	trackDocRequest(agentId: string, title: string): void {
		this.host.pendingDocRequests.set(agentId, title);
	}

	/** 将 PiDeck 中的用户消息转发到飞书群（双向同步：Pi → 飞书） */
	async forwardUserMessageToFeishu(agentId: string, text: string): Promise<void> {
		if (!this.host.client() || !text.trim()) return;
		const chatId = this.host.getBestChatId(agentId);
		if (!chatId) {
			// 没有绑定，尝试创建 session mirror
			const tab = this.host.listAgents().find((t) => t.id === agentId);
			if (tab) {
				await this.host.ensureSessionMirror(agentId, tab.title, tab.sessionPath);
			}
			return;
		}
		// 带上 PiDeck 标识，方便在飞书中区分消息来源
		await this.host.sendSmartMessage(chatId, `💻 **PiDeck**:\n${text}`);

		// 检测用户是否要创建飞书文档，记下来等 Agent 回答完后自动创建
		const docTitle = wantsFeishuDoc(text);
		if (docTitle) this.host.pendingDocRequests.set(agentId, docTitle);
	}
}
