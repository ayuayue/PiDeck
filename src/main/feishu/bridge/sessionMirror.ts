/**
 * bridge/sessionMirror — Session Mirror（1 会话 = 1 飞书群）。
 *
 * 从 FeishuBridge.ts 原样搬出的一域：按 stable Session 复用/迁移/创建群聊绑定，
 * 并维护 chatId ↔ sessionPath/agent 的持久映射。
 *
 * 绑定表与 UI 推送仍在宿主（索引、解绑、状态卡共用同一份），这里只按窄接口读写。
 */

import type { AgentTab, FeishuBotConfig, FeishuBridgeStatus, FeishuChatBinding } from "../../../shared/types";
import { getPersistentChatId, setPersistentChatId } from "../FeishuConfig";
import { feishuT, type FeishuLocale } from "../FeishuI18n";
import type { LarkClient } from "../types";
import { log, logErr, warn } from "./bridgeLog";

/** 协作者对宿主的最小依赖面：绑定表 + runtime 网关 + 出站消息。 */
export type FeishuSessionMirrorHost = {
	client: () => LarkClient | null;
	bridgeStatus: () => FeishuBridgeStatus;
	locale: () => FeishuLocale;
	botConfig: () => FeishuBotConfig;
	botOpenId: () => string | null;
	userOpenId: () => string | null;
	listAgents: () => AgentTab[];
	bindRuntime: (input: { projectId: string; agent: AgentTab }) => Promise<{ sessionId: string }>;
	authorizeRuntimeAgent: (binding: FeishuChatBinding) => Promise<string | undefined>;
	bindingEntries: () => Array<[string, FeishuChatBinding]>;
	bindingValues: () => FeishuChatBinding[];
	findBinding: (chatId: string) => FeishuChatBinding | undefined;
	setBinding: (chatId: string, binding: FeishuChatBinding) => void;
	bindingCount: () => number;
	indexBinding: (binding: FeishuChatBinding, previousAgentId?: string, previousSessionId?: string) => void;
	persistBindings: () => void;
	pushBindings: () => void;
	updateActiveBindings: (count: number) => void;
	sendSmartMessage: (chatId: string, text: string) => Promise<boolean>;
};

export class FeishuSessionMirror {
	/** 同一会话可能在创建 Agent 和首次发送消息时同时触发 mirror；用 pending 防止并发重复建群。 */
	private readonly pending = new Map<string, Promise<string | undefined>>();

	constructor(private readonly host: FeishuSessionMirrorHost) {}

	/** Session Mirror 的历史参数名是 sessionId，实际调用方传入 AgentManager runtime handle。 */
	async ensureMirror(agentId: string, sessionTitle?: string, sessionPath?: string): Promise<string | undefined> {
		const pending = this.pending.get(agentId);
		if (pending) return pending;
		const task = this.ensureSessionMirrorForRuntime(agentId, sessionTitle, sessionPath).finally(() => {
			if (this.pending.get(agentId) === task) this.pending.delete(agentId);
		});
		this.pending.set(agentId, task);
		return task;
	}

	/** Stable Session entry used by public surfaces that already resolved the current runtime target. */
	async ensureMirrorForSession(sessionId: string, agentId: string, sessionTitle?: string, sessionPath?: string): Promise<string | undefined> {
		const pending = this.pending.get(sessionId);
		if (pending) return pending;
		const task = this.ensureSessionMirrorInner(sessionId, agentId, sessionTitle, sessionPath).finally(() => {
			if (this.pending.get(sessionId) === task) {
				this.pending.delete(sessionId);
			}
		});
		this.pending.set(sessionId, task);
		return task;
	}

	private async ensureSessionMirrorForRuntime(agentId: string, sessionTitle?: string, sessionPath?: string): Promise<string | undefined> {
		const tab = this.host.listAgents().find((candidate) => candidate.id === agentId);
		const existingRuntimeBinding = tab ? this.host.bindingValues().find((binding) => binding.agentId === tab.id) : undefined;
		const authorizedAgentId = existingRuntimeBinding ? await this.host.authorizeRuntimeAgent(existingRuntimeBinding) : undefined;
		let stableSessionId = authorizedAgentId ? existingRuntimeBinding?.sessionId : undefined;
		let runtimeAgentId = authorizedAgentId;
		if (tab && (!stableSessionId || !runtimeAgentId)) {
			const runtimeBinding = await this.host.bindRuntime({ projectId: tab.projectId, agent: tab });
			stableSessionId = runtimeBinding.sessionId;
			runtimeAgentId = tab.id;
		}

		const sessionId = stableSessionId ?? agentId;
		const pending = this.pending.get(sessionId);
		if (sessionId !== agentId && pending) return pending;
		const task = this.ensureSessionMirrorInner(sessionId, runtimeAgentId, sessionTitle, sessionPath).finally(() => {
			if (this.pending.get(sessionId) === task) this.pending.delete(sessionId);
		});
		this.pending.set(sessionId, task);
		return task;
	}

	private async ensureSessionMirrorInner(sessionId: string, agentId: string | undefined, sessionTitle?: string, sessionPath?: string): Promise<string | undefined> {
		if (!this.host.client() || this.host.bridgeStatus().status !== "connected") {
			log("[飞书 Session Mirror] Bridge 未连接，跳过自动拉群");
			return undefined;
		}

		const groupName = `Pi Agent - ${(sessionTitle || feishuT(this.host.locale(), "group.newSession", { id: sessionId.slice(0, 8) })).slice(0, 50)}`;

		// 1. stable session 或 runtime 已有任一飞书绑定时直接复用，不创建第二个 mirror。
		let existingChatId = this.host.bindingEntries().find(([, binding]) => binding.sessionId === sessionId || (agentId !== undefined && binding.agentId === agentId))?.[0];

		// 2. 仅对全局唯一的 legacy mirror 绑定按 path 迁移；不同 source 共享 path 时不得猜测。
		if (!existingChatId && sessionPath) {
			const pathMatches = this.host.bindingEntries().filter(([, binding]) => binding.sessionPath === sessionPath);
			if (pathMatches.length === 1 && pathMatches[0][1].source === "session-mirror") {
				const [cid, binding] = pathMatches[0];
				existingChatId = cid;
				log(`[飞书 Session Mirror] 按唯一 sessionPath 迁移旧群: ${cid} (path: ${sessionPath})`);
				const previousSessionId = binding.sessionId;
				const previousAgentId = binding.agentId;
				binding.sessionId = sessionId;
				binding.agentId = agentId;
				this.host.indexBinding(binding, previousAgentId, previousSessionId);
				this.host.persistBindings();
			}
		}

		// 3. 已有绑定：更新 runtime 索引。Feishu-origin 不支持 mirror card，明确复用其转发 chat。
		if (existingChatId) {
			const effectiveUserOpenId = this.host.botConfig().defaultUserOpenId || this.host.userOpenId();
			const binding = this.host.findBinding(existingChatId);
			if (binding) {
				const previousAgentId = binding.agentId;
				binding.agentId = agentId ?? binding.agentId;
				this.host.indexBinding(binding, previousAgentId);
				if (previousAgentId !== binding.agentId) this.host.persistBindings();
				if (effectiveUserOpenId && !binding.userId) {
					log(`[飞书 Session Mirror] 检测到空群 ${existingChatId}，尝试补加用户 ${effectiveUserOpenId}`);
					await this.repairEmptyGroup(existingChatId, effectiveUserOpenId).catch(() => {});
					binding.userId = effectiveUserOpenId;
					this.host.persistBindings();
				}
			}
			return existingChatId;
		}

		// 4. 持久映射优先 stable ID，再兼容 path/runtime handle。
		let persistedChatId = getPersistentChatId(`session:${sessionId}`);
		if (!persistedChatId && sessionPath) persistedChatId = getPersistentChatId(sessionPath);
		if (!persistedChatId && agentId) persistedChatId = getPersistentChatId(`agent:${agentId}`);
		if (persistedChatId) {
			const activePersistedBinding = this.host.findBinding(persistedChatId);
			if (activePersistedBinding) {
				log(`[飞书 Session Mirror] 持久化群 ${persistedChatId} 已绑定其他会话，跳过自动 mirror`);
				return undefined;
			}
			log(`[飞书 Session Mirror] 按持久化映射复用群: ${persistedChatId} (session: ${sessionId.slice(0, 8)})`);
			const agentTab = agentId ? this.host.listAgents().find((t) => t.id === agentId) : undefined;
			const binding: FeishuChatBinding = {
				chatId: persistedChatId,
				botId: this.host.botConfig().id,
				userId: this.host.botConfig().defaultUserOpenId ?? this.host.userOpenId() ?? "",
				sessionId,
				agentId,
				sessionPath: agentTab?.sessionPath ?? sessionPath,
				workspaceId: this.host.botConfig().defaultWorkspaceId ?? "",
				source: "session-mirror" as const,
				chatType: "group",
				groupName,
				createdAt: Date.now(),
			};
			this.host.setBinding(persistedChatId, binding);
			this.host.indexBinding(binding);
			this.host.updateActiveBindings(this.host.bindingCount());
			this.host.persistBindings();
			this.host.pushBindings();
			log(`[飞书 Session Mirror] 持久化群绑定已恢复: ${persistedChatId}`);
			return persistedChatId;
		}

		// 5. 完全没匹配 → 创建新群
		log(`[飞书 Session Mirror] 正在创建群: ${groupName}`);

		// 用户 open_id 获取优先级：配置 > 自动记住
		let effectiveUserOpenId: string | undefined = this.host.botConfig().defaultUserOpenId || this.host.userOpenId() || undefined;

		// 安全检查：防止误把 Bot 自己的 open_id 当成用户的
		if (effectiveUserOpenId && effectiveUserOpenId === this.host.botOpenId()) {
			warn(`[飞书 Session Mirror] ⚠️ 配置的 open_id (${effectiveUserOpenId}) 是 Bot 自己的，已忽略`);
			warn(`[飞书 Session Mirror] 💡 请在飞书中给 Bot 发 /whoami，Bot 会回复你真正的用户 open_id`);
			effectiveUserOpenId = undefined;
		}

		if (!effectiveUserOpenId) {
			log("[飞书 Session Mirror] ⚠️ 用户 open_id 未获取，群聊将只有 Bot");
			log("[飞书 Session Mirror] 💡 提示：在飞书中给 Bot 发送任意消息或 /whoami，即可自动记录；或将 open_id 填入配置中的「你的 Open ID」字段");
		}

		try {
			// 构建 data 对象，空 user_id_list 时不传该字段
			const chatData: Record<string, unknown> = {
				name: groupName,
				chat_mode: "group",
				chat_type: "private",
				external: false,
			};
			if (effectiveUserOpenId) {
				chatData.user_id_list = [effectiveUserOpenId];
			}

			const resp = await this.host.client()!.im.chat.create({
				data: chatData,
				params: { user_id_type: "open_id" },
			});

			// 兼容多种 Lark SDK 响应格式
			const respAny = resp as Record<string, unknown>;
			const chatId = ((respAny?.data as Record<string, unknown>)?.chat_id as string) ?? (respAny?.chat_id as string) ?? undefined;
			if (!chatId) {
				logErr("[飞书 Session Mirror] 创建群未返回 chat_id, 原始响应:", JSON.stringify(resp).slice(0, 200));
				return undefined;
			}

			log(`[飞书 Session Mirror] 群创建成功: chatId=${chatId}, 成员数=${effectiveUserOpenId ? 2 : 1}`);

			// 创建绑定
			// 找到对应的 agent tab 以获取 sessionPath
			const agentTab = agentId ? this.host.listAgents().find((t) => t.id === agentId) : undefined;
			const effectiveSessionPath = agentTab?.sessionPath ?? sessionPath;
			const binding: FeishuChatBinding = {
				chatId,
				botId: this.host.botConfig().id,
				userId: effectiveUserOpenId ?? "",
				sessionId,
				agentId,
				sessionPath: effectiveSessionPath,
				workspaceId: this.host.botConfig().defaultWorkspaceId ?? "",
				source: "session-mirror" as const,
				chatType: "group",
				groupName,
				createdAt: Date.now(),
			};
			this.host.setBinding(chatId, binding);
			this.host.indexBinding(binding);
			this.host.updateActiveBindings(this.host.bindingCount());
			this.host.persistBindings();
			this.host.pushBindings();
			// 持久化 chatId 映射：断开重连后可复用此群（removeBinding 不影响此映射）
			if (effectiveSessionPath) {
				setPersistentChatId(effectiveSessionPath, chatId);
				log(`[飞书 Session Mirror] 已持久化 chatId 映射: ${effectiveSessionPath} → ${chatId}`);
			}
			setPersistentChatId(`session:${sessionId}`, chatId);
			if (agentId) setPersistentChatId(`agent:${agentId}`, chatId);

			await this.host.sendSmartMessage(chatId, feishuT(this.host.locale(), "session.mirrorWelcome", { id: sessionId.slice(0, 8) }));
			return chatId;
		} catch (e) {
			const errMsg = e instanceof Error ? e.message : String(e);
			logErr("[飞书 Session Mirror] 创建群失败:", errMsg);
			// 如果是权限问题，提示用户
			if (errMsg.includes("permission") || errMsg.includes("scope") || errMsg.includes("230001")) {
				logErr("[飞书 Session Mirror] 可能缺少 im:chat 权限，请在飞书开放平台→权限管理中开启「获取群聊信息」权限");
			}
			return undefined;
		}
	}

	/** 修复空群：将用户加入已有但只有 Bot 的群聊 */
	private async repairEmptyGroup(chatId: string, userOpenId: string): Promise<void> {
		if (!this.host.client()) return;
		try {
			await this.host.client()!.im.chat.members.add({
				path: { chat_id: chatId },
				data: { id_list: [userOpenId] },
				params: { member_id_type: "open_id" },
			});
			log(`[飞书 Session Mirror] 已将用户 ${userOpenId} 补加入群 ${chatId}`);
		} catch (e) {
			logErr("[飞书 Session Mirror] 补加成员失败:", e);
		}
	}
}
