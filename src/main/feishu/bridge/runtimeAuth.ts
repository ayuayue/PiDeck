/**
 * bridge/runtimeAuth — 绑定上的 runtime 句柄归属校验与清理。
 *
 * 从 FeishuBridge.ts 原样搬出的一域：复用旧句柄前必须由网关确认它仍属于同一个
 * stable Session（pi 之外的后端不在 AgentManager 里）；校验不过就清掉句柄，
 * 保留 stable ID 等下一次恢复。
 */

import type { AgentTab, FeishuChatBinding } from "../../../shared/types";
import { warn } from "./bridgeLog";

/** 协作者对宿主的最小依赖面：runtime 网关 + 绑定索引/落盘/推送。 */
export type FeishuRuntimeAuthHost = {
	findRuntimeAgent: (agentId: string) => AgentTab | undefined;
	bindRuntime: (input: { projectId: string; agent: AgentTab; existingSessionId?: string }) => Promise<{ sessionId: string }>;
	indexBinding: (binding: FeishuChatBinding, previousAgentId?: string, previousSessionId?: string) => void;
	persistBindings: () => void;
	pushBindings: () => void;
};

export class FeishuRuntimeAuth {
	constructor(private readonly host: FeishuRuntimeAuthHost) {}

	/** Reuse requires both a live handle and gateway authorization for the same stable Session. */
	async authorize(binding: FeishuChatBinding): Promise<string | undefined> {
		if (!binding.agentId) return undefined;
		// runtime handle 归属由网关判定：pi 之外的后端（DSH）不在 AgentManager 里。
		const tab = this.host.findRuntimeAgent(binding.agentId);
		if (!tab || tab.status === "error" || tab.status === "closed") {
			this.clearRuntimeAgentId(binding);
			return undefined;
		}
		try {
			const runtimeBinding = await this.host.bindRuntime({
				projectId: tab.projectId,
				agent: tab,
				existingSessionId: binding.sessionId,
			});
			if (runtimeBinding.sessionId !== binding.sessionId) {
				throw new Error(`Runtime gateway returned a different Session: ${runtimeBinding.sessionId}`);
			}
			return tab.id;
		} catch (error) {
			warn(`[飞书 Bridge] runtime handle 校验失败，清理旧绑定: ${error instanceof Error ? error.message : String(error)}`);
			this.clearRuntimeAgentId(binding);
			return undefined;
		}
	}

	private clearRuntimeAgentId(binding: FeishuChatBinding): void {
		const previousAgentId = binding.agentId;
		if (!previousAgentId) return;
		binding.agentId = undefined;
		this.host.indexBinding(binding, previousAgentId);
		this.host.persistBindings();
		this.host.pushBindings();
	}
}
