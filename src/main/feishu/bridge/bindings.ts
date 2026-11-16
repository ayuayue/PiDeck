/**
 * bridge/bindings — 飞书聊天绑定的持久化（读盘恢复 + 写盘保存）。
 *
 * 从 FeishuBridge.ts 原样搬出的一域：恢复时经 runtime 网关校验 stable Session 身份，
 * 校验失败保留无主绑定而不猜测改主；保存在每次绑定变更后整体落盘。
 *
 * 绑定表本身留在宿主（索引、解绑、镜像共用同一份），这里只按窄接口读写。
 */

import type { AgentTab, FeishuBridgeStatus, FeishuChatBinding } from "../../../shared/types";
import { loadBindings, saveBindings, setPersistentChatId, type FeishuChatBindingPersist } from "../FeishuConfig";
import { log, warn } from "./bridgeLog";

/** 协作者对宿主的最小依赖面：绑定表 + 索引/落盘/状态推送。 */
export type FeishuBindingsHost = {
	botId: () => string;
	listAgents: () => AgentTab[];
	bindRuntime: (input: { projectId: string; agent: AgentTab; existingSessionId?: string }) => Promise<{ sessionId: string }>;
	chatBindings: Map<string, FeishuChatBinding>;
	sessionToChat: Map<string, string>;
	feishuSessions: Set<string>;
	indexBinding: (binding: FeishuChatBinding) => void;
	persistBindings: () => void;
	updateStatus: (partial: Partial<FeishuBridgeStatus>) => void;
};

export class FeishuBindings {
	constructor(private readonly host: FeishuBindingsHost) {}

	async load(): Promise<void> {
		const bindings = loadBindings(this.host.botId());
		const tabs = this.host.listAgents();
		const normalizePath = (value: string): string => {
			const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
			return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
		};
		const persistedPathCounts = new Map<string, number>();
		for (const binding of bindings) {
			if (!binding.sessionPath) continue;
			const pathKey = normalizePath(binding.sessionPath);
			persistedPathCounts.set(pathKey, (persistedPathCounts.get(pathKey) ?? 0) + 1);
		}

		let migrated = false;
		for (const b of bindings) {
			let candidateTab = b.agentId ? tabs.find((candidate) => candidate.id === b.agentId) : undefined;
			if (!candidateTab) candidateTab = tabs.find((candidate) => candidate.id === b.sessionId); // legacy candidate
			if (!candidateTab && b.sessionPath) {
				const pathKey = normalizePath(b.sessionPath);
				const samePath = tabs.filter((candidate) => candidate.sessionPath && normalizePath(candidate.sessionPath) === pathKey);
				if (persistedPathCounts.get(pathKey) === 1 && samePath.length === 1) candidateTab = samePath[0];
			}

			if (candidateTab?.status === "error" || candidateTab?.status === "closed") candidateTab = undefined;

			const stableSessionId = b.sessionId;
			let authorizedTab: AgentTab | undefined;
			if (candidateTab) {
				try {
					const runtimeBinding = await this.host.bindRuntime({
						projectId: candidateTab.projectId,
						agent: candidateTab,
						existingSessionId: b.sessionId,
					});
					if (runtimeBinding.sessionId !== b.sessionId) {
						throw new Error(`Runtime gateway returned a different Session: ${runtimeBinding.sessionId}`);
					}
					authorizedTab = candidateTab;
					migrated ||= b.agentId !== candidateTab.id;
				} catch (error) {
					warn(`[飞书 Bridge] 持久绑定 identity 迁移失败，保留原 stable ID: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			if (!authorizedTab && b.agentId) migrated = true;

			const binding: FeishuChatBinding = {
				chatId: b.chatId,
				botId: b.botId,
				userId: b.userId,
				sessionId: stableSessionId,
				agentId: authorizedTab?.id,
				sessionPath: authorizedTab?.sessionPath ?? b.sessionPath,
				workspaceId: b.workspaceId,
				channelId: b.channelId,
				modelId: b.modelId,
				source: b.source as "feishu" | "session-mirror",
				chatType: b.chatType as "p2p" | "group",
				groupName: b.groupName,
				createdAt: b.createdAt,
			};
			this.host.chatBindings.set(b.chatId, binding);
			this.host.indexBinding(binding);
			if (!authorizedTab) {
				log(`[飞书 Bridge] 保留无主绑定（等后续恢复）: ${b.groupName ?? b.chatId}，sessionPath=${b.sessionPath ?? "(无)"}`);
			}
			if (binding.sessionPath) setPersistentChatId(binding.sessionPath, b.chatId);
			setPersistentChatId(`session:${binding.sessionId}`, b.chatId);
			if (binding.agentId) setPersistentChatId(`agent:${binding.agentId}`, b.chatId);
		}
		if (migrated) this.host.persistBindings();
		if (this.host.chatBindings.size > 0) log(`[飞书 Bridge] 已恢复 ${this.host.chatBindings.size} 个聊天绑定`);
		this.host.updateStatus({ activeBindings: this.host.chatBindings.size });
	}

	/** 刷新绑定：重新从磁盘加载并匹配当前 agent 列表 */
	async reload(): Promise<void> {
		this.host.chatBindings.clear();
		this.host.sessionToChat.clear();
		this.host.feishuSessions.clear();
		await this.load();
		log(`[飞书 Bridge] 手动刷新绑定完成，活跃绑定: ${this.host.chatBindings.size}`);
	}

	update(chatId: string, patch: Partial<Omit<FeishuChatBinding, "chatId" | "botId" | "sessionId">>): FeishuChatBinding | undefined {
		const binding = this.host.chatBindings.get(chatId);
		if (!binding) return undefined;
		Object.assign(binding, patch);
		this.host.persistBindings();
		return { ...binding };
	}

	persist(): void {
		const bindings: FeishuChatBindingPersist[] = Array.from(this.host.chatBindings.values()).map((b) => ({
			chatId: b.chatId,
			botId: b.botId,
			userId: b.userId,
			sessionId: b.sessionId,
			agentId: b.agentId,
			sessionPath: b.sessionPath,
			workspaceId: b.workspaceId,
			channelId: b.channelId,
			modelId: b.modelId,
			source: b.source,
			chatType: b.chatType,
			groupName: b.groupName,
			createdAt: b.createdAt,
		}));
		saveBindings(this.host.botId(), bindings);
	}
}
