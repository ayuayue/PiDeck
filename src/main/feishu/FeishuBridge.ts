/**
 * FeishuBridge — 飞书桥接主类 v3
 *
 * 核心升级：
 * - CardKit 2.0 流式卡片：骨架卡→实时更新→终态 flush
 *   看到工具调用名称、思考过程、输出文本等细节
 * - 智能消息模式：text/post/interactive 解决表格渲染
 * - Session Mirror：Pi 创建会话→飞书自动拉群（1会话=1群）
 * - Pi→飞书实时同步：AgentManager 事件驱动
 */

import type { BrowserWindow } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { FeishuBotConfig, FeishuBridgeStatus, FeishuChatBinding, FeishuChatMessage, FeishuTestResult, ImageContent, AvailableModel, AgentRuntimeState, AgentTab } from "../../shared/types";
import type { FeishuGroupInfo, FeishuGroupMember, FeishuImageAttachment, FeishuFileAttachment, FeishuMessageContext, FeishuCardActionEvent } from "./types";
import { loadBindings, saveBindings, getPersistentChatId, setPersistentChatId, type FeishuChatBindingPersist } from "./FeishuConfig";
import { chooseMessageMode, buildPostMessages, buildMarkdownCards } from "./rich-text";
import { CardStream } from "./CardStream";
import { FeishuConnection } from "./FeishuConnection";
import { buildFeishuTextChildren, sanitizeFeishuUserVisibleText, stripFeishuActionMarkers, wantsFeishuDoc } from "./docActions";
import { hasExplicitFeishuFileSendIntent } from "./fileIntent";
import { createInitialState, reduceFromPiEvent, markInterrupted, markError, type RunState } from "./CardRunState";
import { renderRunCard } from "./CardRenderer";
import { buildModelPickerCard, parseModelActionValue } from "./ModelPickerCard";
import { buildAskCard, normalizeAskOption, parseAskActionValue, parseAskInputValue, tryParseBatchAskEnvelope, type AskOption, type AskUiRequest } from "./AskCard";
import { feishuLanguage, feishuT, normalizeFeishuLocale, type FeishuLocale } from "./FeishuI18n";
import type { AgentManager } from "../pi/AgentManager";

export interface SessionRuntimeBindingGateway {
	ensureSession(input: { projectId: string; title: string; existingSessionId?: string; sessionPath?: string }): Promise<{ sessionId: string }>;
	activateRuntime(sessionId: string): Promise<AgentTab>;
	bindRuntime(input: { projectId: string; agent: AgentTab; existingSessionId?: string }): Promise<{ sessionId: string }>;
	sendPrompt(input: { sessionId: string; message: string; agentMessage?: string; images?: ImageContent[] }): Promise<void>;
	abortRuntime(sessionId: string): Promise<void>;
	listRuntimeModels(sessionId: string): Promise<AvailableModel[]>;
	getRuntimeState(sessionId: string): Promise<AgentRuntimeState | undefined>;
	setRuntimeModel(sessionId: string, provider: string, modelId: string): Promise<void>;
	/** 把 ask/confirm 等扩展 UI 的答案写回 pi（与桌面端弹窗回答同一条链路）。 */
	sendUIResponse(agentId: string, requestId: string, response: { value?: string | boolean; confirmed?: boolean; cancelled?: boolean }): void;
}

// ===== 常量 =====
const DEDUP_MAX = 200;
const GROUP_CACHE_TTL = 3600_000;

/** 飞书端待回答的 ask/confirm 请求（pi 发 extension_ui_request 后阻塞等待，必须有人回答）。 */
type PendingAsk = {
	requestId: string;
	agentId: string;
	method: "select" | "confirm" | "input" | "editor" | "batch_ask";
	title: string;
	chatId: string;
	askedAt: number;
	/** select 的选项列表（卡片编号与此一致），供纯数字文本回复映射选项值。 */
	options?: AskOption[];
};

/** 类型守卫：extension_ui_request 的 method 是否属于可回答的对话类方法。 */
function isAskMethod(value: string): value is "select" | "confirm" | "input" | "editor" {
	return value === "select" || value === "confirm" || value === "input" || value === "editor";
}

// ===== 安全日志 =====
function safeLog(level: "log" | "warn" | "error", ...args: unknown[]): void {
	try {
		console[level](...args);
	} catch {
		/* EPIPE */
	}
}
const log = (...args: unknown[]) => safeLog("log", ...args);
const warn = (...args: unknown[]) => safeLog("warn", ...args);
const logErr = (...args: unknown[]) => safeLog("error", ...args);

export class FeishuBridge {
	private botConfig: FeishuBotConfig;
	private agentManager: AgentManager;
	private runtimeBindings: SessionRuntimeBindingGateway;
	private getWindow: () => BrowserWindow | null;
	private getProjects: () => Array<{ id: string; name: string; path: string }>;
	private locale: FeishuLocale;

	private connection: FeishuConnection;

	private status: FeishuBridgeStatus = { status: "disconnected", activeBindings: 0 };
	private botOpenId: string | null = null;
	private userOpenId: string | null = null; // 记住最近一个用户，用于自动拉群

	private recentMessageIds = new Set<string>();
	private recentEventIds = new Set<string>();
	private recentContent = new Map<string, number>();
	private processingChats = new Set<string>();
	/** 用户发了文件但还没说需求，暂存着等文字指令 */
	private pendingAttachments = new Map<string, { images: FeishuImageAttachment[]; files: FeishuFileAttachment[] }>();

	private chatBindings = new Map<string, FeishuChatBinding>();
	private sessionToChat = new Map<string, string>();
	/** 同一会话可能在创建 Agent 和首次发送消息时同时触发 mirror；用 pending 防止并发重复建群。 */
	private sessionMirrorPending = new Map<string, Promise<string | undefined>>();

	private groupInfoCache = new Map<string, FeishuGroupInfo>();
	private userNameCache = new Map<string, string>();

	// ===== 图片/文件即时处理（不做 pending 等待，收到即处理） =====
	private imageConfirmTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** 待回答的 ask/confirm 请求：key = `${chatId}:${requestId}`（同一 chat 同一时刻至多一个，pi 串行执行）。 */
	private pendingAsks = new Map<string, PendingAsk>();

	// 流式卡片：sessionId → CardStream
	private streamingCards = new Map<string, CardStream>();
	// 流式状态：sessionId → RunState
	private streamingRunStates = new Map<string, RunState>();
	// 卡片未创建时的缓存事件（并行模式下 Agent 先启动，事件暂存于此）
	private pendingCardEvents = new Map<string, unknown[]>();
	// 记录卡片更新失败的 session（用于 runAgent 降级兜底）
	private cardUpdateFailed = new Set<string>();
	/** 本轮已成功完成流式卡片终态的 session；agent_end 时跳过二次纯文本同步，避免双消息。 */
	private cardTerminalSucceeded = new Set<string>();
	/** 已同步结果指纹（FIFO 上限防长驻无界增长；只在发送成功后记录，失败可重试） */
	private syncedFingerprints = new Set<string>();

	private unsubscribeLocalEvents: (() => void) | null = null;
	// 哪些 session 是飞书发起的（不需要 session mirror）
	private feishuSessions = new Set<string>();
	/** 飞书消息触发中的运行，agent_end 期间不要再走 PiDeck 本地同步，避免文件/文本重复发送。 */
	private feishuDrivenRuns = new Set<string>();

	private lastUserMessageId = new Map<string, string>();

	/** 用户消息中检测到要做飞书文档，agent 结束后自动创建 */
	private pendingDocRequests = new Map<string, string>();

	constructor(botConfig: FeishuBotConfig, agentManager: AgentManager, getWindow: () => BrowserWindow | null, getProjects: () => Array<{ id: string; name: string; path: string }>, runtimeBindings: SessionRuntimeBindingGateway, plainAppSecret?: string, locale: FeishuLocale = "zh-CN") {
		this.botConfig = botConfig;
		this.agentManager = agentManager;
		this.runtimeBindings = runtimeBindings;
		this.getWindow = getWindow;
		this.getProjects = getProjects;
		this.locale = normalizeFeishuLocale(locale);
		this.connection = new FeishuConnection(botConfig, plainAppSecret, this.locale);
	}

	getStatus(): FeishuBridgeStatus {
		return { ...this.status };
	}
	listBindings(): FeishuChatBinding[] {
		return Array.from(this.chatBindings.values());
	}
	/** 当前 Agent 是否已经手动连接/绑定飞书会话。索引同时接受 stable sessionId 和 runtime agentId。 */
	hasSessionBinding(sessionOrAgentId: string): boolean {
		return this.sessionToChat.has(sessionOrAgentId);
	}
	/** 当前 Agent 绑定的飞书 chat_id，用于注入给 Agent 做默认目标群。 */
	getSessionChatId(sessionOrAgentId: string): string | undefined {
		return this.getBestChatId(sessionOrAgentId);
	}

	/** 优先取明确映射，再兜底查绑定对象；stable ID 与 runtime ID 都是显式索引。 */
	private getBestChatId(sessionOrAgentId: string): string | undefined {
		const currentChatId = this.sessionToChat.get(sessionOrAgentId);
		if (currentChatId) return currentChatId;
		for (const [chatId, b] of this.chatBindings) {
			if ((b.sessionId === sessionOrAgentId || b.agentId === sessionOrAgentId) && b.source === "session-mirror") return chatId;
		}
		return undefined;
	}

	private hasFeishuBindingForKey(key: string): boolean {
		return Array.from(this.chatBindings.values()).some((candidate) => candidate.source === "feishu" && (candidate.sessionId === key || candidate.agentId === key));
	}

	private removeBindingIndexKey(key: string, chatId: string): void {
		if (this.sessionToChat.get(key) === chatId) this.sessionToChat.delete(key);
		if (!this.hasFeishuBindingForKey(key)) this.feishuSessions.delete(key);
	}

	private setBindingIndexKey(key: string, chatId: string): void {
		const currentChatId = this.sessionToChat.get(key);
		if (!currentChatId || currentChatId === chatId) this.sessionToChat.set(key, chatId);
	}

	private indexBinding(binding: FeishuChatBinding, previousAgentId?: string, previousSessionId?: string): void {
		if (previousSessionId && previousSessionId !== binding.sessionId) {
			this.removeBindingIndexKey(previousSessionId, binding.chatId);
		}
		if (previousAgentId && previousAgentId !== binding.agentId) {
			this.removeBindingIndexKey(previousAgentId, binding.chatId);
		}
		this.setBindingIndexKey(binding.sessionId, binding.chatId);
		if (binding.agentId) this.setBindingIndexKey(binding.agentId, binding.chatId);
		if (binding.source === "feishu") {
			this.feishuSessions.add(binding.sessionId);
			if (binding.agentId) this.feishuSessions.add(binding.agentId);
		}
	}

	private unindexBinding(binding: FeishuChatBinding): void {
		this.chatBindings.delete(binding.chatId);
		this.removeBindingIndexKey(binding.sessionId, binding.chatId);
		if (binding.agentId) this.removeBindingIndexKey(binding.agentId, binding.chatId);
	}

	private clearRuntimeAgentId(binding: FeishuChatBinding): void {
		const previousAgentId = binding.agentId;
		if (!previousAgentId) return;
		binding.agentId = undefined;
		this.indexBinding(binding, previousAgentId);
		this.persistBindings();
		this.pushBindings();
	}

	/** Reuse requires both a live handle and gateway authorization for the same stable Session. */
	private async authorizeRuntimeAgent(binding: FeishuChatBinding): Promise<string | undefined> {
		if (!binding.agentId) return undefined;
		const tab = this.agentManager.list().find((candidate) => candidate.id === binding.agentId);
		if (!tab || tab.status === "error" || tab.status === "closed") {
			this.clearRuntimeAgentId(binding);
			return undefined;
		}
		try {
			const runtimeBinding = await this.runtimeBindings.bindRuntime({
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

	private async ensureRuntimeBinding(binding: FeishuChatBinding): Promise<string | undefined> {
		const activeAgentId = await this.authorizeRuntimeAgent(binding);
		if (activeAgentId) return activeAgentId;
		const resumed = await this.resumeOrCreateAgent(binding);
		return resumed?.agentId;
	}

	/**
	 * 按 sessionId 移除绑定：通过 sessionToChat 查找 chatId，然后调用 removeBinding。
	 * 用于 FeishuLinkIndicator 等场景——前端只知道 agentId，不知 chatId。
	 */
	removeBindingBySessionId(sessionId: string): boolean {
		const chatId = this.sessionToChat.get(sessionId);
		if (!chatId) return false;
		return this.removeBinding(chatId);
	}

	/** 刷新绑定：重新从磁盘加载并匹配当前 agent 列表 */
	async reloadBindings(): Promise<void> {
		this.chatBindings.clear();
		this.sessionToChat.clear();
		this.feishuSessions.clear();
		await this.loadPersistedBindings();
		log(`[飞书 Bridge] 手动刷新绑定完成，活跃绑定: ${this.chatBindings.size}`);
	}

	// ===== 绑定管理 =====

	/**
	 * 移除绑定：取消飞书群与 Agent 的关联，清理会话级别的同步状态。
	 * 注意：这不会停止 Agent 进程，只是取消飞书侧的关联关系。
	 * Agent 在 PiDeck 中继续正常运行。
	 */
	removeBinding(chatId: string): boolean {
		const binding = this.chatBindings.get(chatId);
		if (!binding) return false;
		// 仅取消绑定，不终止 Agent。Agent 在 PiDeck 中继续独立运行。
		// 用户手动取消关联不应影响 Agent 的使用状态。
		this.unindexBinding(binding);
		this.chatBindings.delete(chatId);
		const runtimeId = binding.agentId;
		if (runtimeId) {
			this.streamingCards.delete(runtimeId);
			this.streamingRunStates.delete(runtimeId);
			this.pendingCardEvents.delete(runtimeId);
			this.cardUpdateFailed.delete(runtimeId);
		}
		// 清理图片确认定时器（如果有）
		const timer = this.imageConfirmTimers.get(chatId);
		if (timer) {
			clearTimeout(timer);
			this.imageConfirmTimers.delete(chatId);
		}
		this.lastUserMessageId.delete(chatId);
		// 解绑时释放该聊天暂存的附件 Buffer 与待答 ask，防解绑后永久驻留
		this.pendingAttachments.delete(chatId);
		for (const key of [...this.pendingAsks.keys()]) {
			if (key.startsWith(`${chatId}:`)) this.pendingAsks.delete(key);
		}
		this.updateStatus({ activeBindings: this.chatBindings.size });
		this.persistBindings();
		this.pushBindings();
		log(`[飞书 Bridge] 已移除绑定: ${chatId}`);
		return true;
	}

	updateBinding(chatId: string, patch: Partial<Omit<FeishuChatBinding, "chatId" | "botId" | "sessionId">>): FeishuChatBinding | undefined {
		const binding = this.chatBindings.get(chatId);
		if (!binding) return undefined;
		Object.assign(binding, patch);
		this.persistBindings();
		return { ...binding };
	}

	// ===== 生命周期 =====

	async start(): Promise<void> {
		this.updateStatus({ status: "connecting" });

		try {
			const { botOpenId } = await this.connection.start(
				async (data) => {
					await this.handleRawMessage(data).catch((err) => logErr("[飞书 Bridge] handleRawMessage 异常:", err));
				},
				async (event) => {
					await this.handleCardAction(event);
				},
			);
			this.botOpenId = botOpenId;

			this.unsubscribeLocalEvents = this.agentManager.addLocalEventListener((agentId, event) => this.handleAgentEvent(agentId, event));
			await this.loadPersistedBindings();
			this.updateStatus({
				status: "connected",
				activeBindings: this.chatBindings.size,
				connectedAt: Date.now(),
				botId: this.botConfig.id,
				botName: this.botConfig.name,
				botOpenId: this.botOpenId ?? undefined,
			});
			log("[Feishu Bridge] connected");
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			const message = feishuT(this.locale, "connection.failed");
			this.updateStatus({ status: "error", errorMessage: detail });
			logErr("[飞书 Bridge] 启动失败:", detail);
			throw new Error(message + " (" + detail + ")", { cause: error });
		}
	}

	stop(): void {
		if (this.unsubscribeLocalEvents) {
			this.unsubscribeLocalEvents();
			this.unsubscribeLocalEvents = null;
		}
		for (const [, card] of this.streamingCards) {
			card.close().catch(() => {});
		}
		this.streamingCards.clear();
		this.streamingRunStates.clear();
		this.pendingCardEvents.clear();

		this.connection.stop();
		this.chatBindings.clear();
		this.sessionToChat.clear();
		this.feishuSessions.clear();
		this.recentMessageIds.clear();
		this.recentEventIds.clear();
		this.recentContent.clear();
		this.processingChats.clear();
		this.lastUserMessageId.clear();
		this.syncedFingerprints.clear();
		this.groupInfoCache.clear();
		this.userNameCache.clear();
		this.botOpenId = null;
		this.cardUpdateFailed.clear();
		this.pendingDocRequests.clear();
		for (const [, timer] of this.imageConfirmTimers) {
			clearTimeout(timer);
		}
		this.imageConfirmTimers.clear();
		this.pendingAsks.clear();
		this.pendingAttachments.clear();
		this.updateStatus({ status: "disconnected", activeBindings: 0, botId: undefined, botName: undefined, botOpenId: undefined });
		log("[Feishu Bridge] stopped");
	}

	// ===== 配置热更新 =====

	/** 运行时更新 botConfig（用于用户在面板编辑 open_id 后无需重连） */
	updateBotConfig(patch: Partial<FeishuBotConfig>): void {
		this.botConfig = { ...this.botConfig, ...patch };
		log("[飞书 Bridge] 配置已热更新:", Object.keys(patch).join(", "));
	}

	setLocale(locale: FeishuLocale): void {
		this.locale = normalizeFeishuLocale(locale);
	}

	// ===== 测试连接 =====

	async testConnection(appId: string, appSecret: string): Promise<FeishuTestResult> {
		return this.connection.testConnection(appId, appSecret);
	}

	// ===== 闪电确认 =====

	/** ⚡ 闪电确认：收到消息后立即 fire-and-forget 一条 text 回复，让用户感知 Bot 已响应 */
	private async sendLightningConfirm(chatId: string, replyToMessageId?: string): Promise<void> {
		if (!this.connection.client) return;
		try {
			if (replyToMessageId) {
				await this.connection.client.im.message.reply({
					path: { message_id: replyToMessageId },
					data: { msg_type: "text", content: JSON.stringify({ text: feishuT(this.locale, "message.received") }) },
				});
			} else {
				await this.connection.client.im.message.create({
					params: { receive_id_type: "chat_id" },
					data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: feishuT(this.locale, "message.received") }) },
				});
			}
		} catch {
			/* fire-and-forget */
		}
	}

	// ===== 消息处理 =====

	private async handleRawMessage(data: Record<string, unknown>): Promise<void> {
		const event = (data?.event ?? data) as Record<string, unknown>;
		if (!event) return;
		const sender = event.sender as Record<string, unknown> | undefined;
		if (sender?.sender_type === "bot") return;
		await this.handleMessage(event);
	}

	private async handleMessage(data: Record<string, unknown>): Promise<void> {
		if (!this.connection.client) return;
		const eventId = data.event_id as string | undefined;
		if (eventId && this.recentEventIds.has(eventId)) return;
		if (eventId) {
			this.recentEventIds.add(eventId);
			if (this.recentEventIds.size > DEDUP_MAX) this.recentEventIds.delete(this.recentEventIds.values().next().value as string);
		}

		const message = (data as { message?: Record<string, unknown> }).message;
		if (!message) return;
		const sender = (data as { sender?: Record<string, unknown> }).sender;
		if ((sender?.sender_type as string) !== "user") return;

		const messageId = message.message_id as string;
		if (messageId && this.recentMessageIds.has(messageId)) return;
		if (messageId) {
			this.recentMessageIds.add(messageId);
			if (this.recentMessageIds.size > DEDUP_MAX) this.recentMessageIds.delete(this.recentMessageIds.values().next().value as string);
		}

		const chatId = message.chat_id as string;
		const messageType = message.message_type as string;
		const chatType = message.chat_type as string;
		const userId = ((sender?.sender_id as Record<string, unknown>)?.open_id as string) ?? "unknown";
		const mentions = message.mentions as Array<{ name: string; id: string | { open_id: string; union_id: string; user_id: string } }> | undefined;

		// 记住用户 open_id（用于自动拉群），并推回配置页；这样用户发任意消息都能自动回填，不依赖 /whoami 命令成功响应。
		if (userId && userId !== "unknown") {
			this.userOpenId = userId;
			try {
				const win = this.getWindow();
				if (win && !win.isDestroyed()) win.webContents.send(ipcChannels.feishuWhoamiResult, userId);
			} catch {
				/* ignore */
			}
		}

		// 命令消息（以 / 开头）不受 processingChats 限制，确保 /stop 等能在 Agent 运行时生效
		if (messageType === "text" && message.content) {
			try {
				const cmdContent = JSON.parse(message.content as string) as { text?: string };
				const cmdText = (cmdContent.text ?? "").replace(/@_user_\d+/g, "").trim();
				if (cmdText.startsWith("/") || cmdText.toLowerCase() === "whoami") {
					const msgCtx: FeishuMessageContext = {
						chatId,
						senderOpenId: userId,
						senderName: undefined,
						messageId,
						chatType: chatType as "p2p" | "group",
					};
					await this.handleCommand(msgCtx, cmdText);
					return;
				}
			} catch {}
		}

		if (this.processingChats.has(chatId)) {
			log(`[飞书 Bridge] 跳过重入消息: ${chatId}`);
			return;
		}
		this.processingChats.add(chatId);

		try {
			if (chatType === "group" && this.botConfig.requireMention !== false && !this.isBotMentioned(mentions)) {
				// session-mirror 群（Bot 自建群）允许无 @mention 消息
				const binding = this.chatBindings.get(chatId);
				if (!binding || binding.source !== "session-mirror") return;
			}
			if (chatType === "group" && messageId) this.lastUserMessageId.set(chatId, messageId);

			const supportedTypes = new Set(["text", "image", "post", "file"]);
			if (!supportedTypes.has(messageType)) {
				log(`[飞书 Bridge] 不支持的消息类型: ${messageType}`);
				return;
			}

			let text = "";
			const imageAttachments: FeishuImageAttachment[] = [];
			const fileAttachments: FeishuFileAttachment[] = [];

			if (messageType === "text") {
				const content = JSON.parse(message.content as string) as { text?: string };
				text = (content.text ?? "").replace(/@_user_\d+/g, "").trim();
			} else if (messageType === "post") {
				const content = JSON.parse(message.content as string) as { title?: string; content?: Array<Array<{ tag: string; text?: string; image_key?: string }>> };
				const parts: string[] = [];
				if (content.title) parts.push(content.title);
				for (const line of content.content ?? []) {
					for (const node of line) {
						if (node.tag === "text" && node.text) {
							parts.push(node.text);
						} else if ((node.tag === "img" || node.tag === "image") && node.image_key) {
							try {
								const imgData = await this.downloadImage(messageId, node.image_key);
								imageAttachments.push({ imageKey: node.image_key, data: imgData, mediaType: this.inferImageMediaType(imgData) });
							} catch (e) {
								logErr("[飞书 Bridge] post 图片下载失败:", e);
							}
						}
					}
				}
				text = parts
					.join(" ")
					.replace(/@_user_\d+/g, "")
					.trim();
			} else if (messageType === "image") {
				const content = JSON.parse(message.content as string) as { image_key?: string };
				if (content.image_key) {
					try {
						const imgData = await this.downloadImage(messageId, content.image_key);
						imageAttachments.push({ imageKey: content.image_key, data: imgData, mediaType: this.inferImageMediaType(imgData) });
					} catch (e) {
						logErr("[飞书 Bridge] 下载图片失败:", e);
						await this.sendSmartMessage(chatId, feishuT(this.locale, "attachment.imageDownloadFailed"));
						return;
					}
				}
			} else if (messageType === "file") {
				const content = JSON.parse(message.content as string) as { file_key?: string; file_name?: string };
				if (content.file_key) {
					try {
						const fileData = await this.downloadFile(messageId, content.file_key);
						if (fileData.length > 50 * 1024 * 1024) {
							await this.sendSmartMessage(chatId, feishuT(this.locale, "attachment.fileTooLarge50"));
							return;
						}
						fileAttachments.push({ fileKey: content.file_key, fileName: content.file_name || `feishu-${content.file_key}`, data: fileData });
					} catch (e) {
						logErr("[飞书 Bridge] 下载文件失败:", e);
						await this.sendSmartMessage(chatId, feishuT(this.locale, "attachment.fileDownloadFailed"));
						return;
					}
				}
			}

			// 有待答 ask 时，纯文本回复优先作为回答（input/editor/select 自定义答案），
			// 避免 pi 阻塞等待 extension_ui_response 时用户消息被排队、飞书侧“永远卡住”。
			// confirm/batch_ask 不支持文本回答，给出操作指引而不是静默吞掉。
			if (messageType === "text") {
				const pendingAsk = this.getPendingAskForChat(chatId);
				if (pendingAsk) {
					if (pendingAsk.method === "confirm") {
						await this.sendSmartMessage(chatId, feishuT(this.locale, "ask.confirmHint"));
						return;
					}
					if (pendingAsk.method === "batch_ask") {
						await this.sendSmartMessage(chatId, feishuT(this.locale, "ask.batchUnsupportedHint"));
						return;
					}
					let answer = text ?? "";
					// select 且回复纯数字：按卡片编号列表映射到选项原始值（用户可直接回复编号作答）
					if (answer.trim() && pendingAsk.method === "select" && pendingAsk.options?.length) {
						const index = Number(answer.trim()) - 1;
						if (/^\d+$/.test(answer.trim()) && index >= 0 && index < pendingAsk.options.length) {
							const mapped = normalizeAskOption(pendingAsk.options[index]);
							answer = typeof mapped === "string" ? mapped : (mapped?.value ?? mapped?.label ?? answer);
						}
					}
					if (answer.trim()) {
						this.runtimeBindings.sendUIResponse(pendingAsk.agentId, pendingAsk.requestId, { value: answer });
						this.pendingAsks.delete(`${chatId}:${pendingAsk.requestId}`);
						await this.sendSmartMessage(chatId, feishuT(this.locale, "ask.answered", { answer }));
						return;
					}
					// 空文本（仅附件）不走 ask 回答，落回正常流程
				}
			}

			// ===== 文件/图片 + 文字 → 一起处理；仅文件/图片 → 暂存等指令 =====
			if (!text && (imageAttachments.length > 0 || fileAttachments.length > 0)) {
				// 只有附件没有文字 → 存起来等指令；但必须有上界：只发文件不发指令的聊天
				// 会让每个文件（最大 50MB）的完整 Buffer 无限期驻留内存直到进程重启。
				const existing = this.pendingAttachments.get(chatId);
				const heldCount = existing ? existing.images.length + existing.files.length : 0;
				const heldBytes = existing ? [...existing.images, ...existing.files].reduce((n, a) => n + a.data.length, 0) : 0;
				const incomingCount = imageAttachments.length + fileAttachments.length;
				const incomingBytes = [...imageAttachments, ...fileAttachments].reduce((n, a) => n + a.data.length, 0);
				if (heldCount + incomingCount > 20 || heldBytes + incomingBytes > 20 * 1024 * 1024) {
					await this.sendSmartMessage(chatId, feishuT(this.locale, "attachment.pendingFull"));
					return;
				}
				const merged = existing || { images: [], files: [] };
				merged.images.push(...imageAttachments);
				merged.files.push(...fileAttachments);
				this.pendingAttachments.set(chatId, merged);
				const names = fileAttachments.map((f) => f.fileName).join("、");
				const hint = names ? feishuT(this.locale, "attachment.filesReceived", { names }) : feishuT(this.locale, "attachment.imageReceived");
				await this.sendSmartMessage(chatId, `📎 ${hint}`);
				return;
			}
			// 有文字时合并之前暂存的附件
			const pending = this.pendingAttachments.get(chatId);
			if (pending) {
				imageAttachments.unshift(...pending.images);
				fileAttachments.unshift(...pending.files);
				this.pendingAttachments.delete(chatId);
			}
			if (!text && imageAttachments.length === 0 && fileAttachments.length === 0) return;

			log(`[Feishu Bridge] message received: chat=${chatId.slice(0, 8)}, type=${messageType}, text=${text.slice(0, 40)}`);

			let groupName: string | undefined;
			let senderName: string | undefined;
			if (chatType === "group") {
				const [gi, un] = await Promise.all([this.getGroupInfo(chatId), this.getUserName(userId)]);
				groupName = gi?.name;
				senderName = un;
			}

			const msgCtx: FeishuMessageContext = { chatId, senderOpenId: userId, senderName, messageId, chatType: chatType as "p2p" | "group", groupName };

			const dedupParts = [chatId, userId, text];
			if (imageAttachments.length > 0) dedupParts.push("img", ...imageAttachments.map((a) => a.imageKey));
			if (fileAttachments.length > 0) dedupParts.push("file", ...fileAttachments.map((f) => f.fileKey));
			const contentKey = dedupParts.join("\u0000");
			const lastTime = this.recentContent.get(contentKey);
			if (lastTime && Date.now() - lastTime <= 5000) {
				log(`[飞书 Bridge] 重复内容已跳过: ${text.slice(0, 50)}`);
				return;
			}
			this.recentContent.set(contentKey, Date.now());
			if (this.recentContent.size > 2000) this.recentContent.delete(this.recentContent.keys().next().value as string);

			log(`[飞书 Bridge] 准备调用 Agent: ${chatId}, "${text.slice(0, 60)}", images=${imageAttachments.length}`);

			// ⚡ 闪电确认：fire-and-forget，不等待
			const replyToMsgId = chatType === "group" ? messageId : undefined;
			void this.sendLightningConfirm(chatId, replyToMsgId).catch(() => {});

			await this.runAgent(msgCtx, text, imageAttachments, fileAttachments);
		} finally {
			this.processingChats.delete(chatId);
		}
	}

	// ===== 命令处理 =====

	private async handleCommand(ctx: FeishuMessageContext, text: string): Promise<void> {
		const { chatId, senderOpenId: userId } = ctx;
		const [command] = text.split(/\s+/);
		switch (command?.toLowerCase()) {
			case "/help":
			case "/h":
				await this.sendHelpCard(chatId);
				break;
			case "/new":
			case "/n":
				await this.createNewSession(ctx);
				break;
			case "/stop":
			case "/s":
				await this.handleStopCommand(ctx);
				break;
			case "/status":
				await this.handleStatusCommand(ctx);
				break;
			case "/model":
				await this.handleModelCommand(ctx, text);
				break;
			case "/sendfile": {
				const fp = text.split(/\s+/).slice(1).join(" ");
				if (!fp) {
					await this.sendSmartMessage(chatId, feishuT(this.locale, "command.sendFileUsage"));
					break;
				}
				const result = await this.sendFeishuFile(chatId, fp);
				await this.sendSmartMessage(chatId, result);
				break;
			}
			case "/newdoc": {
				const title = text.split(/\s+/).slice(1).join(" ") || feishuT(this.locale, "doc.defaultTitle");
				const result = await this.createFeishuDoc(chatId, title);
				await this.sendSmartMessage(chatId, result);
				break;
			}
			case "/whoami":
				await this.sendSmartMessage(chatId, feishuT(this.locale, "command.whoami", { openId: userId }));
				// 将 open_id 推回前端，用于添加 Bot 时自动填入
				try {
					const win = this.getWindow();
					if (win && !win.isDestroyed()) {
						win.webContents.send(ipcChannels.feishuWhoamiResult, userId);
					}
				} catch {
					/* ignore */
				}
				break;
			case "/refresh":
			case "/r":
				await this.reloadBindings();
				await this.sendSmartMessage(chatId, feishuT(this.locale, "command.bindingsRefreshed", { count: this.chatBindings.size }));
				break;
			default:
				await this.sendSmartMessage(chatId, feishuT(this.locale, "command.unknown", { command: command ?? "" }));
		}
	}

	// ===== Agent 执行（流式卡片 + 并行优化） =====

	private async runAgent(ctx: FeishuMessageContext, text: string, imageAttachments: FeishuImageAttachment[], fileAttachments: FeishuFileAttachment[]): Promise<void> {
		const { chatId } = ctx;
		let binding = this.chatBindings.get(chatId);

		// stable sessionId identifies the catalog record; all process operations use agentId.
		if (binding) {
			const runtimeAgentId = await this.ensureRuntimeBinding(binding);
			if (!runtimeAgentId) {
				await this.sendSmartMessage(chatId, feishuT(this.locale, "session.restoreFailed"));
				return;
			}
		} else {
			await this.createNewSession(ctx);
			binding = this.chatBindings.get(chatId);
			if (!binding) return;
		}
		const agentId = binding.agentId;
		if (!agentId) return;

		// 关闭已有流式卡片
		const existingCard = this.streamingCards.get(agentId);
		if (existingCard) {
			await existingCard.flush(markInterrupted(createInitialState())).catch(() => {});
			await existingCard.close().catch(() => {});
			this.streamingCards.delete(agentId);
			this.streamingRunStates.delete(agentId);
		}
		this.pendingCardEvents.delete(agentId);

		// 图片 → ImageContent (base64) + 临时文件（方便 Agent 用 bash 操作）
		const { writeFileSync, mkdirSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { tmpdir } = await import("node:os");
		const imgDir = join(tmpdir(), "pi-feishu-images");
		mkdirSync(imgDir, { recursive: true });
		const savedImages: string[] = [];
		const images: ImageContent[] = imageAttachments.map((att) => {
			const ext = att.mediaType.split("/").pop() || "png";
			const name = `feishu-img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
			const fp = join(imgDir, name);
			writeFileSync(fp, att.data);
			savedImages.push(fp);
			return { type: "image" as const, data: att.data.toString("base64"), mimeType: att.mediaType };
		});
		let finalText = text;
		if (savedImages.length > 0) {
			finalText = finalText ? `${finalText}\n\n[图片已保存到: ${savedImages.join(", ")}]` : `[图片已保存到: ${savedImages.join(", ")}]`;
		}
		if (fileAttachments.length > 0) {
			const names = fileAttachments.map((f) => f.fileName).join(", ");
			finalText = finalText ? `${finalText}\n\n[附件: ${names}]` : `处理以下文件: ${names}`;
		}

		const initialState = createInitialState();
		this.streamingRunStates.set(agentId, initialState);
		this.pendingCardEvents.set(agentId, []);

		// 流式卡片：创建后实时更新活动轨迹和输出
		const cardPromise = CardStream.open(this.connection.client!, chatId, renderRunCard(initialState, { locale: this.locale }), { replyToMessageId: ctx.chatType === "group" ? ctx.messageId : undefined }).catch((e) => {
			logErr("[飞书 Bridge] 流式卡片创建失败:", e);
			return null as CardStream | null;
		});

		// 先注册 agent_end 监听再提交 prompt：快速失败的 run（模型配置错/auth 失败）会在
		// 卡片创建窗口内广播 agent_end，注册晚于事件会错过 → 等满 300s 超时，期间
		// processingChats 持有 chatId，该聊天的后续消息被静默丢弃 5 分钟。
		const agentEndPromise = this.waitForAgentEnd(agentId, 300_000);

		this.feishuDrivenRuns.add(agentId);
		try {
			// 飞书来源也必须显式注入宿主发送规则；否则 Agent 会回退到 lark-cli 并询问 chat_id。
			const feishuActionInstruction = [
				"当前会话已连接飞书聊天。严禁调用 lark-cli、飞书 IM API 或搜索群聊来发送文件；不要询问 chat_id。需要把本地文件发到当前飞书聊天时，最终回答末尾独立一行写 [SEND_FILE:本地文件路径]，PiDeck 会按当前会话绑定自动上传。",
				"只有用户明确要求发送、上传或分享文件时才写 [SEND_FILE:本地文件路径]；如果只是要求保存到本地，不要写该标记。",
				`当前绑定的飞书 chat_id: ${chatId}。这是只读上下文，用于确认当前会话绑定；发送文件仍必须用 [SEND_FILE:本地文件路径]。`,
				"这是飞书群聊消息。请直接回复用户。",
			].join("\n");
			const feishuCtx = finalText ? `${feishuActionInstruction}\n\n${finalText}\n\n[这是飞书群聊消息。请直接回复用户。]` : `${feishuActionInstruction}\n\n[飞书群聊消息。请直接回复用户。]`;
			await this.runtimeBindings.sendPrompt({
				sessionId: binding.sessionId,
				message: finalText || "处理附件",
				agentMessage: feishuCtx,
				...(images.length > 0 ? { images } : {}),
			});
		} catch (e) {
			this.feishuDrivenRuns.delete(agentId);
			this.streamingRunStates.delete(agentId);
			this.pendingCardEvents.delete(agentId);
			this.streamingCards.delete(agentId);
			// sendPrompt 与 CardStream.open 并发：open 较慢时这里先失败，若不关闭
			// 随后创建成功的卡片，它会成为群里永久「运行中」的孤儿骨架卡。
			void cardPromise.then((c) => {
				if (c) void c.close().catch(() => {});
			});
			throw e;
		}

		const cardStream = await cardPromise;
		const hasCard = cardStream !== null;
		if (cardStream) {
			this.streamingCards.set(agentId, cardStream);
			this.replayBufferedEvents(agentId, cardStream);
		} else {
			this.pendingCardEvents.delete(agentId);
		}

		const startTime = Date.now();

		try {
			const timedOut = await agentEndPromise;
			await new Promise((r) => setTimeout(r, 800));

			if (timedOut) {
				// run 超过 5 分钟仍在运行：保留卡片/状态注册表，让 handleAgentEvent 的
				// 终态分支在真正结束时 flush+close+清理。此处删注册表会让卡片永久停在
				// 中间态且最终结果无任何交付通道（agent_end 迟到时三张 map 已被清空）。
				log(`[飞书 Bridge] 等待 agent_end 超时（run 仍在运行），保留卡片继续跟进: agentId=${agentId.slice(0, 8)}`);
				return;
			}

			if (hasCard) {
				if (this.cardUpdateFailed.has(agentId)) {
					this.cardUpdateFailed.delete(agentId);
					log(`[飞书 Bridge] 卡片更新失败，降级为文本消息`);
					await this.sendResultFallback(chatId, agentId, startTime);
				}
				this.streamingCards.delete(agentId);
				this.streamingRunStates.delete(agentId);
				this.pendingCardEvents.delete(agentId);
			} else {
				await this.sendResultFallback(chatId, agentId, startTime);
				this.streamingRunStates.delete(agentId);
				this.pendingCardEvents.delete(agentId);
			}
			// 统一扫描 Agent 回复中的飞书标记并执行
			await this.processFeishuActions(chatId, agentId).catch((e) => logErr("[飞书 Bridge] 处理飞书动作异常:", e));

			// 没有 [CREATE_DOC:] 标记但用户说了要做飞书文档 → 自动创建
			const docTitle = wantsFeishuDoc(text);
			if (docTitle) {
				const lastMsg = this.agentManager
					.getMessages(agentId)
					.filter((m) => m.role === "assistant")
					.pop();
				if (lastMsg?.text && !lastMsg.text.includes("[CREATE_DOC:")) {
					const body = stripFeishuActionMarkers(lastMsg.text);
					if (body) {
						await this.createFeishuDoc(chatId, docTitle, body).catch((e) => logErr("[飞书 Bridge] feishu 路径自动创建文档失败:", e));
					}
				}
			}
		} catch (e) {
			logErr("[飞书 Bridge] Agent 运行失败:", e);
			const errState = markError(createInitialState(), feishuT(this.locale, "agent.failed"));
			const finalCardStream = this.streamingCards.get(agentId);
			if (finalCardStream) {
				await finalCardStream.flush(renderRunCard(errState, { locale: this.locale })).catch(() => {});
				await finalCardStream.close().catch(() => {});
				this.streamingCards.delete(agentId);
			}
			this.streamingRunStates.delete(agentId);
			this.pendingCardEvents.delete(agentId);
			this.cardUpdateFailed.delete(agentId);
			await this.sendSmartMessage(chatId, feishuT(this.locale, "agent.failed"));
		} finally {
			this.feishuDrivenRuns.delete(agentId);
			// 清理本轮图片临时文件：路径已随 prompt 交给 Agent，run 结束（含 processFeishuActions
			// 的 [SEND_FILE:] 已执行完）后文件不再有用；不删则 pi-feishu-images 目录无限增长。
			if (savedImages.length > 0) {
				void import("node:fs").then(({ unlink }) => {
					for (const fp of savedImages) unlink(fp, () => {});
				});
			}
		}
	}

	/** 回放卡片创建期间缓存的 Agent 事件 */
	private replayBufferedEvents(sessionId: string, cardStream: CardStream): void {
		const pending = this.pendingCardEvents.get(sessionId);
		if (!pending || pending.length === 0) {
			this.pendingCardEvents.delete(sessionId);
			return;
		}

		log(`[飞书 Bridge] 回放 ${pending.length} 个缓存事件到卡片`);
		let currentState = this.streamingRunStates.get(sessionId) ?? createInitialState();
		for (const ev of pending) {
			const nextState = reduceFromPiEvent(currentState, ev as Record<string, unknown>, this.locale);
			if (nextState !== currentState) {
				currentState = nextState;
				this.streamingRunStates.set(sessionId, nextState);
				cardStream.update(
					renderRunCard(nextState, {
						locale: this.locale,
						stopHint: nextState.terminal === "running" ? feishuT(this.locale, "card.stopHint") : undefined,
					}),
				);
			}
		}
		this.pendingCardEvents.delete(sessionId);
	}

	private waitForAgentEnd(sessionId: string, timeoutMs: number): Promise<boolean> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				cleanup();
				resolve(true);
			}, timeoutMs);
			const handler = (agentId: string, event: unknown) => {
				if (agentId !== sessionId) return;
				if (!event || typeof event !== "object") return;
				if ((event as Record<string, unknown>).type === "agent_end") {
					cleanup();
					resolve(false);
				}
			};
			const unsub = this.agentManager.addLocalEventListener(handler);
			const cleanup = () => {
				clearTimeout(timer);
				unsub();
			};
		});
	}

	// ===== Agent 事件处理（流式卡片 + Session Mirror） =====

	private handleAgentEvent(agentId: string, event: unknown): void {
		if (!event || typeof event !== "object") return;
		// 只有已连接状态才处理 agent 事件，防止断连后仍同步到飞书
		if (this.status.status !== "connected") return;
		const typed = event as Record<string, unknown>;

		// ask/confirm 等扩展 UI 请求：渲染提问卡片并记录待答状态。
		// 必须在卡片事件缓存之前拦截并返回——这些事件不进 runState，
		// 进 pendingCardEvents 只会被 replay 白白回放一遍。
		if (typed.type === "extension_ui_request") {
			this.handleAskRequest(agentId, typed);
			return;
		}

		// Agent 结束：清理该 agent 遗留的待答 ask（超时/已完成），防止旧卡片按钮变成幽灵操作
		if (typed.type === "agent_end") {
			this.clearPendingAsksForAgent(agentId);
		}

		const cardStream = this.streamingCards.get(agentId);

		// 卡片未就绪时：只缓存事件，不处理（replayBufferedEvents 会统一回放）
		// 避免事件被 reduceFromPiEvent 处理两次导致重复轨迹
		const pending = this.pendingCardEvents.get(agentId);
		if (pending) {
			pending.push(typed);
			return;
		}

		// 卡片已就绪：直接更新状态和卡片
		const runState = this.streamingRunStates.get(agentId);
		if (runState) {
			if (typed.type === "agent_end" && (typed.stopReason === "error" || typed.error || typed.errorMessage)) {
				logErr("[飞书 Bridge] Agent 终态错误:", typed.error ?? typed.errorMessage ?? typed.stopReason);
			}
			const nextState = reduceFromPiEvent(runState, typed, this.locale);
			if (nextState !== runState) {
				this.streamingRunStates.set(agentId, nextState);
			}
			if (cardStream) {
				// 卡片已就绪 → 直接更新（先清掉 [SEND_FILE:] [CREATE_DOC:] 标记）
				const cleanText = sanitizeFeishuUserVisibleText(nextState.outputText);
				const displayState = cleanText !== nextState.outputText ? { ...nextState, outputText: cleanText } : nextState;
				const chatId = this.sessionToChat.get(agentId) ?? "";
				const prefix = this.chatBindings.get(chatId)?.groupName ?? "";
				const card = renderRunCard(displayState, {
					locale: this.locale,
					stopHint: nextState.terminal === "running" ? feishuT(this.locale, "card.stopHint") : undefined,
				});
				if (nextState.terminal === "running") {
					cardStream.update(card);
				} else {
					// 终态：先预占，避免 agent_end 抢先触发重复纯文本同步。
					this.cardTerminalSucceeded.add(agentId);
					// 强制 flush + close，记录失败以便降级补发纯文本
					void cardStream
						.flush(card)
						.then(() => {
							if (cardStream.lastPatchFailed) {
								this.cardUpdateFailed.add(agentId);
								this.cardTerminalSucceeded.delete(agentId);
								log(`[飞书 Bridge] 终态卡片 patch 失败: ${cardStream.lastPatchError}`);
								// 卡片交付失败时再补一条纯文本，保证用户仍能看到结果。
								const chatIdForFallback = this.getBestChatId(agentId);
								if (chatIdForFallback && this.connection.client) {
									void this.syncPiMessageToFeishu(agentId, chatIdForFallback).catch((e) => logErr("[Feishu Bridge] card-fallback sync failed:", e));
								}
							}
						})
						.then(() => cardStream.close())
						.catch((e) => {
							this.cardUpdateFailed.add(agentId);
							this.cardTerminalSucceeded.delete(agentId);
							logErr("[飞书 Bridge] 终态卡片 flush/close 异常:", e);
							const chatIdForFallback = this.getBestChatId(agentId);
							if (chatIdForFallback && this.connection.client) {
								void this.syncPiMessageToFeishu(agentId, chatIdForFallback).catch((err) => logErr("[Feishu Bridge] card-fallback sync failed:", err));
							}
						});
					this.streamingRunStates.delete(agentId);
					this.streamingCards.delete(agentId);
					this.pendingCardEvents.delete(agentId);
				}
			} else {
				// 卡片尚未创建 → 缓存事件（并行模式）
				const pending = this.pendingCardEvents.get(agentId);
				if (pending) {
					pending.push(typed);
				}
			}
		}

		// 只有用户显式手动连接过的 PiDeck 会话，才把 Agent 结果同步到飞书。
		if (typed.type === "agent_end") {
			// cardTerminalSucceeded 是「本轮已由卡片交付」的预占标记，agent_end 到达即消费；
			// 若不消费，残留会永久压制同会话后续无卡片 run 的文本同步（结果无任何交付通道）。
			const deliveredByCard = this.cardTerminalSucceeded.has(agentId);
			this.cardTerminalSucceeded.delete(agentId);
			if (!deliveredByCard && !this.feishuSessions.has(agentId) && !this.feishuDrivenRuns.has(agentId)) {
				log(`[Feishu Bridge] agent_end 触发 syncPiMessageToFeishu, agentId=${agentId.slice(0, 8)}`);
				const chatId = this.getBestChatId(agentId);
				if (chatId && this.connection.client) {
					this.syncPiMessageToFeishu(agentId, chatId).catch((e) => logErr("[Feishu Bridge] sync Pi message failed:", e));
				}
			}
		}
	}

	/** 将 Pi Agent 回复同步到飞书（带去重，避免同一结果重复推送） */
	private async syncPiMessageToFeishu(agentId: string, chatId: string): Promise<void> {
		if (!this.connection.client) return;
		const messages = this.agentManager.getMessages(agentId);
		const assistantMessages = messages.filter((m) => m.role === "assistant");
		const lastAssistant = assistantMessages.pop();
		if (!lastAssistant?.text?.trim()) return;

		// 去重：用最后一条 assistant 消息的 id + text 前50字符做指纹。
		// 指纹只在发送成功后记录：sendSmartMessage 内部吞错，若先记账，瞬时发送失败
		// 的结果会被指纹永久去重（无重试、无告警，结果丢失）。
		const fingerprint = `${lastAssistant.id}|${lastAssistant.text.slice(0, 50)}`;
		if (this.syncedFingerprints.has(fingerprint)) return;

		// 清掉标记再发送
		const cleanText = sanitizeFeishuUserVisibleText(lastAssistant.text);
		if (cleanText) {
			const delivered = await this.sendSmartMessage(chatId, cleanText);
			if (!delivered) return; // 发送失败：不记指纹，后续 agent_end 仍可重试同步
		}
		this.syncedFingerprints.add(fingerprint);
		if (this.syncedFingerprints.size > 200) this.syncedFingerprints.delete(this.syncedFingerprints.keys().next().value as string);

		// 先扫 [CREATE_DOC:] 标记
		await this.processFeishuActions(chatId, agentId).catch((e) => logErr("[Feishu Bridge] process PiDeck Feishu actions failed:", e));

		// 没有标记但用户说了要做飞书文档 → 用完整回答正文自动创建
		const pendingTitle = this.pendingDocRequests.get(agentId);
		if (pendingTitle && !lastAssistant.text.includes("[CREATE_DOC:")) {
			const body = stripFeishuActionMarkers(lastAssistant.text);
			if (body) {
				await this.createFeishuDoc(chatId, pendingTitle, body).catch((e) => logErr("[Feishu Bridge] auto create doc failed:", e));
			}
		}
		this.pendingDocRequests.delete(agentId);
	}

	/** 显式标记当前会话要在 Agent 回答完后创建飞书文档 */
	trackDocRequest(agentId: string, title: string): void {
		this.pendingDocRequests.set(agentId, title);
	}

	/** 由 PiDeck 宿主按当前会话绑定发送文件，避免 Agent 自己搜索群聊发错 chat。 */
	async sendFileForSession(agentId: string, filePath: string): Promise<string> {
		const chatId = this.getBestChatId(agentId);
		if (!chatId) return feishuT(this.locale, "session.unbound");
		return this.sendFeishuFile(chatId, filePath);
	}

	/** 将 PiDeck 中的用户消息转发到飞书群（双向同步：Pi → 飞书） */
	async forwardUserMessageToFeishu(agentId: string, text: string): Promise<void> {
		if (!this.connection.client || !text.trim()) return;
		const chatId = this.getBestChatId(agentId);
		if (!chatId) {
			// 没有绑定，尝试创建 session mirror
			const tab = this.agentManager.list().find((t) => t.id === agentId);
			if (tab) {
				await this.ensureSessionMirror(agentId, tab.title, tab.sessionPath);
			}
			return;
		}
		// 带上 PiDeck 标识，方便在飞书中区分消息来源
		await this.sendSmartMessage(chatId, `💻 **PiDeck**:\n${text}`);

		// 检测用户是否要创建飞书文档，记下来等 Agent 回答完后自动创建
		const docTitle = wantsFeishuDoc(text);
		if (docTitle) this.pendingDocRequests.set(agentId, docTitle);
	}

	// ===== 会话管理 =====

	private async createNewSession(ctx: FeishuMessageContext, _title?: string): Promise<void> {
		const { chatId } = ctx;
		const projects = this.getProjects();
		if (projects.length === 0) {
			await this.sendSmartMessage(chatId, feishuT(this.locale, "session.projectRequired"));
			return;
		}
		const projectId = projects[0].id;

		try {
			const session = await this.runtimeBindings.ensureSession({
				projectId,
				title: _title?.trim() || ctx.groupName || feishuT(this.locale, "group.defaultSession"),
			});
			const binding: FeishuChatBinding = {
				chatId,
				botId: this.botConfig.id,
				userId: ctx.senderOpenId,
				sessionId: session.sessionId,
				workspaceId: this.botConfig.defaultWorkspaceId ?? "",
				source: "feishu",
				chatType: ctx.chatType,
				groupName: ctx.groupName,
				createdAt: Date.now(),
			};
			this.chatBindings.set(chatId, binding);
			this.indexBinding(binding);
			this.updateStatus({ activeBindings: this.chatBindings.size });
			this.persistBindings();
			this.pushBindings();
			// /new 只创建稳定 Session；第一条实际消息再激活 runtime。
			setPersistentChatId(`session:${binding.sessionId}`, chatId);
			await this.sendSmartMessage(chatId, feishuT(this.locale, "session.created", { id: binding.sessionId.slice(0, 8) }));
			// 飞书会话 runtime 启动时注入 PIDECK_FEISHU_LINKED，ask 交互被禁用——
			// 建立绑定即告知用户，避免首次遇到「Agent 直接写问题」时困惑。
			await this.sendSmartMessage(chatId, feishuT(this.locale, "session.askDisabled"));
		} catch (e) {
			logErr("[飞书 Bridge] 创建会话失败:", e);
			await this.sendSmartMessage(chatId, feishuT(this.locale, "session.createFailed"));
		}
	}

	/**
	 * 绑定失效恢复：先用 stable Session ID 或 legacy sessionPath 确定 Catalog Session，
	 * 再由 coordinator 激活 runtime。Bridge 不直接创建或停止 Agent。
	 * 用 chatId 作为稳定 key（参考上游 ConversationManager 思路），
	 * 会话文件持久化，重启后优先恢复而不是重建。
	 */
	private async resumeOrCreateAgent(binding: FeishuChatBinding): Promise<FeishuChatBinding | undefined> {
		const projects = this.getProjects();
		if (projects.length === 0) {
			log("[飞书 Bridge] 恢复会话失败：无可用项目");
			return undefined;
		}
		const projectId = projects[0].id;

		try {
			const title = binding.groupName || feishuT(this.locale, "group.defaultSession");
			let session = await this.runtimeBindings.ensureSession({
				projectId,
				title,
				existingSessionId: binding.sessionId,
				sessionPath: binding.sessionPath,
			});
			let tab: AgentTab;
			try {
				tab = await this.runtimeBindings.activateRuntime(session.sessionId);
			} catch (error) {
				if (!binding.sessionPath) throw error;
				log(`[飞书 Bridge] sessionPath 恢复失败，创建新 Session: ${error instanceof Error ? error.message : String(error)}`);
				session = await this.runtimeBindings.ensureSession({ projectId, title });
				tab = await this.runtimeBindings.activateRuntime(session.sessionId);
			}
			log(`[飞书 Bridge] 已为 Session ${session.sessionId} 激活 runtime ${tab.id}`);
			const previousAgentId = binding.agentId;
			const previousSessionId = binding.sessionId;
			binding.sessionId = session.sessionId;
			binding.agentId = tab.id;
			binding.sessionPath = tab.sessionPath;
			this.indexBinding(binding, previousAgentId, previousSessionId);
			this.chatBindings.set(binding.chatId, binding);
			this.persistBindings();
			this.pushBindings();
			await this.sendSmartMessage(binding.chatId, feishuT(this.locale, "session.recovered", { id: binding.sessionId.slice(0, 8) }));
			// 恢复的会话同样带 PIDECK_FEISHU_LINKED，ask 已禁用，同步提示用户。
			await this.sendSmartMessage(binding.chatId, feishuT(this.locale, "session.askDisabled"));
			return binding;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			logErr(`[飞书 Bridge] Session runtime 恢复失败: ${msg}`);
			return undefined;
		}
	}

	/** Session Mirror 的历史参数名是 sessionId，实际调用方传入 AgentManager runtime handle。 */
	async ensureSessionMirror(agentId: string, sessionTitle?: string, sessionPath?: string): Promise<string | undefined> {
		const pending = this.sessionMirrorPending.get(agentId);
		if (pending) return pending;
		const task = this.ensureSessionMirrorForRuntime(agentId, sessionTitle, sessionPath).finally(() => {
			if (this.sessionMirrorPending.get(agentId) === task) this.sessionMirrorPending.delete(agentId);
		});
		this.sessionMirrorPending.set(agentId, task);
		return task;
	}

	/** Stable Session entry used by public surfaces that already resolved the current runtime target. */
	async ensureSessionMirrorForSession(sessionId: string, agentId: string, sessionTitle?: string, sessionPath?: string): Promise<string | undefined> {
		const pending = this.sessionMirrorPending.get(sessionId);
		if (pending) return pending;
		const task = this.ensureSessionMirrorInner(sessionId, agentId, sessionTitle, sessionPath).finally(() => {
			if (this.sessionMirrorPending.get(sessionId) === task) {
				this.sessionMirrorPending.delete(sessionId);
			}
		});
		this.sessionMirrorPending.set(sessionId, task);
		return task;
	}

	private async ensureSessionMirrorForRuntime(agentId: string, sessionTitle?: string, sessionPath?: string): Promise<string | undefined> {
		const tab = this.agentManager.list().find((candidate) => candidate.id === agentId);
		const existingRuntimeBinding = tab ? Array.from(this.chatBindings.values()).find((binding) => binding.agentId === tab.id) : undefined;
		const authorizedAgentId = existingRuntimeBinding ? await this.authorizeRuntimeAgent(existingRuntimeBinding) : undefined;
		let stableSessionId = authorizedAgentId ? existingRuntimeBinding?.sessionId : undefined;
		let runtimeAgentId = authorizedAgentId;
		if (tab && (!stableSessionId || !runtimeAgentId)) {
			const runtimeBinding = await this.runtimeBindings.bindRuntime({ projectId: tab.projectId, agent: tab });
			stableSessionId = runtimeBinding.sessionId;
			runtimeAgentId = tab.id;
		}

		const sessionId = stableSessionId ?? agentId;
		const pending = this.sessionMirrorPending.get(sessionId);
		if (sessionId !== agentId && pending) return pending;
		const task = this.ensureSessionMirrorInner(sessionId, runtimeAgentId, sessionTitle, sessionPath).finally(() => {
			if (this.sessionMirrorPending.get(sessionId) === task) this.sessionMirrorPending.delete(sessionId);
		});
		this.sessionMirrorPending.set(sessionId, task);
		return task;
	}

	private async ensureSessionMirrorInner(sessionId: string, agentId: string | undefined, sessionTitle?: string, sessionPath?: string): Promise<string | undefined> {
		if (!this.connection.client || this.status.status !== "connected") {
			log("[飞书 Session Mirror] Bridge 未连接，跳过自动拉群");
			return undefined;
		}

		const groupName = `Pi Agent - ${(sessionTitle || feishuT(this.locale, "group.newSession", { id: sessionId.slice(0, 8) })).slice(0, 50)}`;

		// 1. stable session 或 runtime 已有任一飞书绑定时直接复用，不创建第二个 mirror。
		let existingChatId = Array.from(this.chatBindings.entries()).find(([, binding]) => binding.sessionId === sessionId || (agentId !== undefined && binding.agentId === agentId))?.[0];

		// 2. 仅对全局唯一的 legacy mirror 绑定按 path 迁移；不同 source 共享 path 时不得猜测。
		if (!existingChatId && sessionPath) {
			const pathMatches = Array.from(this.chatBindings.entries()).filter(([, binding]) => binding.sessionPath === sessionPath);
			if (pathMatches.length === 1 && pathMatches[0][1].source === "session-mirror") {
				const [cid, binding] = pathMatches[0];
				existingChatId = cid;
				log(`[飞书 Session Mirror] 按唯一 sessionPath 迁移旧群: ${cid} (path: ${sessionPath})`);
				const previousSessionId = binding.sessionId;
				const previousAgentId = binding.agentId;
				binding.sessionId = sessionId;
				binding.agentId = agentId;
				this.indexBinding(binding, previousAgentId, previousSessionId);
				this.persistBindings();
			}
		}

		// 3. 已有绑定：更新 runtime 索引。Feishu-origin 不支持 mirror card，明确复用其转发 chat。
		if (existingChatId) {
			const effectiveUserOpenId = this.botConfig.defaultUserOpenId || this.userOpenId;
			const binding = this.chatBindings.get(existingChatId);
			if (binding) {
				const previousAgentId = binding.agentId;
				binding.agentId = agentId ?? binding.agentId;
				this.indexBinding(binding, previousAgentId);
				if (previousAgentId !== binding.agentId) this.persistBindings();
				if (effectiveUserOpenId && !binding.userId) {
					log(`[飞书 Session Mirror] 检测到空群 ${existingChatId}，尝试补加用户 ${effectiveUserOpenId}`);
					await this.repairEmptyGroup(existingChatId, effectiveUserOpenId).catch(() => {});
					binding.userId = effectiveUserOpenId;
					this.persistBindings();
				}
			}
			return existingChatId;
		}

		// 4. 持久映射优先 stable ID，再兼容 path/runtime handle。
		let persistedChatId = getPersistentChatId(`session:${sessionId}`);
		if (!persistedChatId && sessionPath) persistedChatId = getPersistentChatId(sessionPath);
		if (!persistedChatId && agentId) persistedChatId = getPersistentChatId(`agent:${agentId}`);
		if (persistedChatId) {
			const activePersistedBinding = this.chatBindings.get(persistedChatId);
			if (activePersistedBinding) {
				log(`[飞书 Session Mirror] 持久化群 ${persistedChatId} 已绑定其他会话，跳过自动 mirror`);
				return undefined;
			}
			log(`[飞书 Session Mirror] 按持久化映射复用群: ${persistedChatId} (session: ${sessionId.slice(0, 8)})`);
			const agentTab = agentId ? this.agentManager.list().find((t) => t.id === agentId) : undefined;
			const binding: FeishuChatBinding = {
				chatId: persistedChatId,
				botId: this.botConfig.id,
				userId: this.botConfig.defaultUserOpenId ?? this.userOpenId ?? "",
				sessionId,
				agentId,
				sessionPath: agentTab?.sessionPath ?? sessionPath,
				workspaceId: this.botConfig.defaultWorkspaceId ?? "",
				source: "session-mirror" as const,
				chatType: "group",
				groupName,
				createdAt: Date.now(),
			};
			this.chatBindings.set(persistedChatId, binding);
			this.indexBinding(binding);
			this.updateStatus({ activeBindings: this.chatBindings.size });
			this.persistBindings();
			this.pushBindings();
			log(`[飞书 Session Mirror] 持久化群绑定已恢复: ${persistedChatId}`);
			return persistedChatId;
		}

		// 5. 完全没匹配 → 创建新群
		log(`[飞书 Session Mirror] 正在创建群: ${groupName}`);

		// 用户 open_id 获取优先级：配置 > 自动记住
		let effectiveUserOpenId: string | undefined = this.botConfig.defaultUserOpenId || this.userOpenId || undefined;

		// 安全检查：防止误把 Bot 自己的 open_id 当成用户的
		if (effectiveUserOpenId && effectiveUserOpenId === this.botOpenId) {
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

			const resp = await this.connection.client.im.chat.create({
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
			const agentTab = agentId ? this.agentManager.list().find((t) => t.id === agentId) : undefined;
			const effectiveSessionPath = agentTab?.sessionPath ?? sessionPath;
			const binding: FeishuChatBinding = {
				chatId,
				botId: this.botConfig.id,
				userId: effectiveUserOpenId ?? "",
				sessionId,
				agentId,
				sessionPath: effectiveSessionPath,
				workspaceId: this.botConfig.defaultWorkspaceId ?? "",
				source: "session-mirror" as const,
				chatType: "group",
				groupName,
				createdAt: Date.now(),
			};
			this.chatBindings.set(chatId, binding);
			this.indexBinding(binding);
			this.updateStatus({ activeBindings: this.chatBindings.size });
			this.persistBindings();
			this.pushBindings();
			// 持久化 chatId 映射：断开重连后可复用此群（removeBinding 不影响此映射）
			if (effectiveSessionPath) {
				setPersistentChatId(effectiveSessionPath, chatId);
				log(`[飞书 Session Mirror] 已持久化 chatId 映射: ${effectiveSessionPath} → ${chatId}`);
			}
			setPersistentChatId(`session:${sessionId}`, chatId);
			if (agentId) setPersistentChatId(`agent:${agentId}`, chatId);

			await this.sendSmartMessage(chatId, feishuT(this.locale, "session.mirrorWelcome", { id: sessionId.slice(0, 8) }));
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
		if (!this.connection.client) return;
		try {
			await this.connection.client.im.chat.members.add({
				path: { chat_id: chatId },
				data: { id_list: [userOpenId] },
				params: { member_id_type: "open_id" },
			});
			log(`[飞书 Session Mirror] 已将用户 ${userOpenId} 补加入群 ${chatId}`);
		} catch (e) {
			logErr("[飞书 Session Mirror] 补加成员失败:", e);
		}
	}

	/** Session Mirror: Agent 运行前为 Pi 侧会话打开流式卡片 */
	async startSessionMirrorRun(agentId: string, sessionTitle?: string, sessionPath?: string): Promise<void> {
		if (!this.connection.client || this.status.status !== "connected") return;

		// 该 API 的调用方传 AgentManager handle；stable ID 仅留在 binding.sessionId。
		await this.ensureSessionMirror(agentId, sessionTitle, sessionPath);

		const binding = this.sessionToChat.get(agentId) ? this.chatBindings.get(this.sessionToChat.get(agentId)!) : undefined;
		if (!binding || binding.source !== "session-mirror") return;
		if (this.streamingCards.has(agentId)) return;

		const initialState = createInitialState();
		this.streamingRunStates.set(agentId, initialState);
		// 与 runAgent 一致：卡片创建窗口（一次网络往返）内到达的 agent 事件（含快速失败
		// 的终态）必须缓冲，否则 handleAgentEvent 找不到 pending 直接丢弃，卡片永久停
		// 在初始骨架态且无人回放。
		this.pendingCardEvents.set(agentId, []);

		try {
			const cardStream = await CardStream.open(
				this.connection.client!,
				binding.chatId,
				renderRunCard(initialState, {
					locale: this.locale,
					stopHint: feishuT(this.locale, "card.stopHint"),
				}),
			);
			this.streamingCards.set(agentId, cardStream);
			this.replayBufferedEvents(agentId, cardStream);
		} catch (e) {
			logErr("[飞书 Session Mirror] 流式卡片创建失败:", e);
			this.streamingRunStates.delete(agentId);
			this.pendingCardEvents.delete(agentId);
		}
	}

	stopSessionMirrorRun(agentId: string): void {
		const state = this.streamingRunStates.get(agentId);
		const card = this.streamingCards.get(agentId);
		if (state && card) {
			const finalState = markInterrupted(state);
			void card
				.flush(renderRunCard(finalState, { locale: this.locale }))
				.then(() => card.close())
				.catch(() => {});
		}
		this.streamingCards.delete(agentId);
		this.streamingRunStates.delete(agentId);
		this.pendingCardEvents.delete(agentId);
	}

	private async handleStopCommand(ctx: FeishuMessageContext): Promise<void> {
		const binding = this.chatBindings.get(ctx.chatId);
		if (!binding) {
			await this.sendSmartMessage(ctx.chatId, feishuT(this.locale, "session.notBound"));
			return;
		}

		const agentId = await this.ensureRuntimeBinding(binding);
		if (!agentId) {
			await this.sendSmartMessage(ctx.chatId, feishuT(this.locale, "session.runtimeUnavailable"));
			return;
		}
		// 关闭流式卡片
		const state = this.streamingRunStates.get(agentId);
		const card = this.streamingCards.get(agentId);
		if (state && card) {
			void card
				.flush(renderRunCard(markInterrupted(state), { locale: this.locale }))
				.then(() => card.close())
				.catch(() => {});
			this.streamingCards.delete(agentId);
			this.streamingRunStates.delete(agentId);
			this.pendingCardEvents.delete(agentId);
		}

		await this.runtimeBindings.abortRuntime(binding.sessionId);
		await this.sendSmartMessage(ctx.chatId, feishuT(this.locale, "session.stopped"));
	}

	private async handleStatusCommand(ctx: FeishuMessageContext): Promise<void> {
		const binding = this.chatBindings.get(ctx.chatId);
		const statusLabel = feishuT(this.locale, `status.${this.status.status}` as "status.disconnected" | "status.connecting" | "status.connected" | "status.error");
		const lines = [
			feishuT(this.locale, "status.heading"),
			feishuT(this.locale, "status.status", { status: statusLabel }),
			feishuT(this.locale, "status.bindings", { count: this.chatBindings.size }),
			binding ? feishuT(this.locale, "status.session", { id: binding.sessionId.slice(0, 8) }) : feishuT(this.locale, "status.sessionUnbound"),
		];
		await this.sendCardMessage(ctx.chatId, { config: { wide_screen_mode: true, update_multi: true }, header: { title: { tag: "plain_text", content: feishuT(this.locale, "status.header") }, template: "blue" }, elements: [{ tag: "markdown", content: lines.join("\n") }] });
	}

	// ===== 模型命令 =====

	private async handleModelCommand(ctx: FeishuMessageContext, text: string): Promise<void> {
		const args = text.split(/\s+/).slice(1).join(" ");
		if (args) {
			await this.doSetModel(ctx.chatId, args);
			return;
		}
		const binding = this.chatBindings.get(ctx.chatId);
		if (!binding) {
			await this.sendSmartMessage(ctx.chatId, feishuT(this.locale, "session.notBoundCreateFirst"));
			return;
		}
		const agentId = await this.ensureRuntimeBinding(binding);
		if (!agentId) {
			await this.sendSmartMessage(ctx.chatId, feishuT(this.locale, "session.runtimeUnavailable"));
			return;
		}
		const models = await this.runtimeBindings.listRuntimeModels(binding.sessionId).catch(() => [] as AvailableModel[]);
		if (!models.length) {
			await this.sendSmartMessage(ctx.chatId, feishuT(this.locale, "model.unavailable"));
			return;
		}
		const state = await this.runtimeBindings.getRuntimeState(binding.sessionId).catch(() => undefined);
		const current = state ? `${state.provider}/${state.modelId}` : feishuT(this.locale, "model.none");
		await this.sendCardMessage(ctx.chatId, buildModelPickerCard({ current, models, locale: this.locale }));
	}

	// ===== 卡片交互回调 =====

	private async handleCardAction(event: FeishuCardActionEvent): Promise<void> {
		// 输入框提交：飞书 input 组件提交时回调携带 input_value（SDK normalize 会丢弃该字段，
		// 必须从 includeRaw 的原始事件读取）；同一 chat 至多一个待答 ask，直接作为答案写回。
		const inputAnswer = parseAskInputValue(event.raw);
		if (inputAnswer !== undefined) {
			await this.handleAskInputSubmit(event, inputAnswer);
			return;
		}
		// ask/confirm 提问卡片按钮：优先处理，与模型切换卡片互不干扰
		const askAction = parseAskActionValue(event.action.value);
		if (askAction) {
			await this.handleAskCardAction(event, askAction);
			return;
		}

		const action = parseModelActionValue(event.action.value);
		if (!action) return;
		const binding = this.chatBindings.get(event.chatId);
		if (!binding) {
			await this.sendSmartMessage(event.chatId, feishuT(this.locale, "session.notBound"));
			return;
		}
		const agentId = await this.ensureRuntimeBinding(binding);
		if (!agentId) {
			await this.sendSmartMessage(event.chatId, feishuT(this.locale, "session.runtimeUnavailable"));
			return;
		}
		const models = await this.runtimeBindings.listRuntimeModels(binding.sessionId).catch(() => [] as AvailableModel[]);
		if (!models.some((m) => m.provider === action.provider && m.id === action.modelId)) {
			await this.sendSmartMessage(event.chatId, feishuT(this.locale, "model.notAvailable", { model: `${action.provider}/${action.modelId}` }));
			return;
		}
		try {
			await this.runtimeBindings.setRuntimeModel(binding.sessionId, action.provider, action.modelId);
			await this.sendSmartMessage(event.chatId, feishuT(this.locale, "model.switched", { model: `${action.provider}/${action.modelId}` }));
		} catch (e) {
			logErr("[飞书 Bridge] 模型切换失败:", e);
			await this.sendSmartMessage(event.chatId, feishuT(this.locale, "model.switchFailed"));
		}
	}

	// ===== ask/confirm 扩展 UI 请求（飞书端问答） =====

	/**
	 * pi 发出 extension_ui_request（ask_question/confirm 等）后阻塞等待回答：
	 * 飞书端渲染提问卡片（选项按钮/确认按钮/回复文本提示），并登记 pendingAsks 供按钮回调与文本回复命中。
	 * 未绑定飞书时直接忽略——桌面端弹窗会兜底回答。
	 */
	private handleAskRequest(agentId: string, typed: Record<string, unknown>): void {
		const rawMethod = String(typed.method ?? "");
		const requestId = String(typed.id ?? "");
		// 边界校验：只处理需要用户回答的对话类方法，notify/setWidget 等纯通知不占飞书卡片
		if (!requestId || !isAskMethod(rawMethod)) return;
		const method = rawMethod;
		const chatId = this.getBestChatId(agentId);
		if (!chatId) return;

		const rawTitle = String(typed.title ?? typed.question ?? "");
		const batchEnvelope = tryParseBatchAskEnvelope(rawTitle);
		// 兼容桌面端约定：✎ 开头的“自定义回答”选项只对桌面端生效，飞书端直接回复文本即可，剔除之
		const rawOptions = Array.isArray(typed.options)
			? typed.options.map(normalizeAskOption).filter((option): option is NonNullable<ReturnType<typeof normalizeAskOption>> => {
					if (!option) return false;
					const label = typeof option === "string" ? option : option.label;
					return !label.startsWith("✎");
				})
			: undefined;
		// select 无有效选项时降级为 input（与桌面端 handleUIRequest 同一规则）：
		// ask_question 的 options 可选，模型经常只问问题不给选项，降级后用户仍可回复文本作答
		const effectiveMethod: AskUiRequest["method"] = method === "select" && (!rawOptions || rawOptions.length === 0) ? "input" : method;

		const request: AskUiRequest = batchEnvelope
			? {
					requestId,
					method: "batch_ask",
					title: "",
					batchQuestions: batchEnvelope.questions,
				}
			: {
					requestId,
					method: effectiveMethod,
					title: rawTitle,
					options: rawOptions,
				};

		const key = `${chatId}:${requestId}`;
		if (this.pendingAsks.has(key)) return;
		this.pendingAsks.set(key, {
			requestId,
			agentId,
			method: request.method,
			title: request.title,
			chatId,
			askedAt: Date.now(),
			// 保存选项供「回复纯数字」映射选项值（与卡片编号列表一致）
			options: request.method === "select" ? request.options : undefined,
		});
		void this.sendCardMessage(chatId, buildAskCard({ request, locale: this.locale })).catch((e) => logErr("[飞书 Bridge] ask 卡片发送失败:", e));
	}

	/** 飞书 input 组件提交回调：把输入文本作为待答 ask 的回答写回 pi。 */
	private async handleAskInputSubmit(event: FeishuCardActionEvent, answer: string): Promise<void> {
		const pending = this.getPendingAskForChat(event.chatId);
		if (!pending || pending.method === "confirm" || pending.method === "batch_ask") {
			// 无对应待答 ask（已超时/已处理）或 confirm/batch 不支持输入框，提示即可
			await this.sendSmartMessage(event.chatId, feishuT(this.locale, "ask.expired"));
			return;
		}
		this.runtimeBindings.sendUIResponse(pending.agentId, pending.requestId, { value: answer });
		this.pendingAsks.delete(`${event.chatId}:${pending.requestId}`);
		await this.sendSmartMessage(event.chatId, feishuT(this.locale, "ask.answeredInput", { answer }));
	}

	/** 查找某 chat 最早的待答 ask（同一 chat 同时至多一个，按时间取首个防异常态）。 */
	private getPendingAskForChat(chatId: string): PendingAsk | undefined {
		let earliest: PendingAsk | undefined;
		for (const pending of this.pendingAsks.values()) {
			if (pending.chatId !== chatId) continue;
			if (!earliest || pending.askedAt < earliest.askedAt) earliest = pending;
		}
		return earliest;
	}

	/** 清理某 agent 的所有待答 ask（agent 结束/新任务开始时调用，避免幽灵按钮）。 */
	private clearPendingAsksForAgent(agentId: string): void {
		for (const [key, pending] of this.pendingAsks) {
			if (pending.agentId === agentId) this.pendingAsks.delete(key);
		}
	}

	/** 飞书卡片按钮回调：把选项/确认/取消写回 pi，并移除待答记录。 */
	private async handleAskCardAction(event: FeishuCardActionEvent, action: NonNullable<ReturnType<typeof parseAskActionValue>>): Promise<void> {
		const key = `${event.chatId}:${action.requestId}`;
		const pending = this.pendingAsks.get(key);
		if (!pending) {
			// 超时/已处理：桌面端 sendUIResponse 已清理 pendingUIRequests，这里只提示不报错
			await this.sendSmartMessage(event.chatId, feishuT(this.locale, "ask.expired"));
			return;
		}

		let response: { value?: string; confirmed?: boolean; cancelled?: boolean };
		let feedback: string;
		if (action.kind === "confirm") {
			response = { confirmed: action.confirmed };
			feedback = action.confirmed ? feishuT(this.locale, "ask.confirmed") : feishuT(this.locale, "ask.rejected");
		} else if (action.kind === "cancel") {
			response = { cancelled: true };
			feedback = feishuT(this.locale, "ask.cancelled");
		} else {
			response = { value: action.option };
			feedback = feishuT(this.locale, "ask.answered", { answer: action.option });
		}

		this.runtimeBindings.sendUIResponse(pending.agentId, pending.requestId, response);
		this.pendingAsks.delete(key);
		await this.sendSmartMessage(event.chatId, feedback);
	}

	// ===== 共享逻辑 =====

	private async doSetModel(chatId: string, rawId: string): Promise<void> {
		const parts = rawId.split("/");
		if (parts.length < 2) {
			await this.sendSmartMessage(chatId, feishuT(this.locale, "model.usage"));
			return;
		}
		const provider = parts.slice(0, -1).join("/");
		const modelId = parts[parts.length - 1];
		const binding = this.chatBindings.get(chatId);
		if (!binding) {
			await this.sendSmartMessage(chatId, feishuT(this.locale, "session.notBound"));
			return;
		}
		const agentId = await this.ensureRuntimeBinding(binding);
		if (!agentId) {
			await this.sendSmartMessage(chatId, feishuT(this.locale, "session.runtimeUnavailable"));
			return;
		}
		try {
			await this.runtimeBindings.setRuntimeModel(binding.sessionId, provider, modelId);
			await this.sendSmartMessage(chatId, feishuT(this.locale, "model.switched", { model: `${provider}/${modelId}` }));
		} catch (e) {
			logErr("[飞书 Bridge] 模型切换失败:", e);
			await this.sendSmartMessage(chatId, feishuT(this.locale, "model.switchFailed"));
		}
	}

	// ===== 飞书消息发送（智能模式） =====

	/** 发送智能消息；返回是否送达（吞错但上报结果，同步去重依赖真实结果决定是否记指纹） */
	private async sendSmartMessage(chatId: string, text: string): Promise<boolean> {
		if (!this.connection.client) return false;
		const mode = chooseMessageMode(text);
		const language = feishuLanguage(this.locale);
		try {
			if (mode === "interactive") {
				for (const card of buildMarkdownCards(text, language)) {
					await this.connection.client.im.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) } });
				}
			} else if (mode === "post") {
				for (const post of buildPostMessages(text, language)) {
					await this.connection.client.im.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: chatId, msg_type: "post", content: JSON.stringify(post) } });
				}
			} else {
				await this.connection.client.im.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) } });
			}
			return true;
		} catch (e) {
			logErr("[飞书 Bridge] 发送消息失败:", e);
			return false;
		}
	}

	private async sendCardMessage(chatId: string, card: Record<string, unknown>): Promise<void> {
		if (!this.connection.client) return;
		try {
			await this.connection.client.im.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) } });
		} catch (e) {
			logErr("[飞书 Bridge] 发送卡片失败:", e);
		}
	}

	private async sendHelpCard(chatId: string): Promise<void> {
		await this.sendCardMessage(chatId, {
			config: { wide_screen_mode: true, update_multi: true },
			header: { title: { tag: "plain_text", content: feishuT(this.locale, "help.title") }, template: "green" },
			elements: [{ tag: "markdown", content: feishuT(this.locale, "help.body") }],
		});
	}

	// ===== 文件发送 & 文档创建 =====

	/**
	 * 发送 Agent 回复到飞书，并扫描执行 [SEND_FILE:] / [CREATE_DOC:] 标记。
	 */
	private async sendResultFallback(chatId: string, sessionId: string, startTime: number): Promise<void> {
		const messages = this.agentManager.getMessages(sessionId);
		const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
		const resultText = lastAssistant?.text ?? "";
		if (!resultText.trim()) return;
		const duration = ((Date.now() - startTime) / 1000).toFixed(1);
		const cleanText = sanitizeFeishuUserVisibleText(resultText);
		if (cleanText) await this.sendSmartMessage(chatId, `${cleanText}\n\n${feishuT(this.locale, "result.completed", { duration })}`);
	}

	/**
	 * 扫描 Agent 回复中的 [SEND_FILE:] / [CREATE_DOC:] 标记并执行飞书操作。
	 * 如果没有标记，自动检测回复中是否提到了工作目录下的文件并尝试发送。
	 */
	private async processFeishuActions(chatId: string, sessionId: string): Promise<void> {
		const messages = this.agentManager.getMessages(sessionId);
		const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
		const text = lastAssistant?.text ?? "";
		if (!text) return;
		const userText = [...messages].reverse().find((m) => m.role === "user")?.text ?? "";
		const canSendFile = hasExplicitFeishuFileSendIntent(userText);

		// 1. 显式 [SEND_FILE:path] 标记
		const sendMatch = text.match(/\[SEND_FILE:([^\]]+)\]/);
		if (sendMatch) {
			const filePath = sendMatch[1].trim();
			if (!canSendFile) {
				log(`[飞书 Bridge] 忽略 SEND_FILE：用户未明确要求发送文件: ${filePath}`);
			} else {
				log(`[飞书 Bridge] 检测到 SEND_FILE: ${filePath}`);
				const result = await this.sendFeishuFile(chatId, filePath);
				log(`[飞书 Bridge] SEND_FILE 结果: ${result}`);
				await this.sendSmartMessage(chatId, result);
			}
		} else if (canSendFile) {
			// 2. 无显式标记 → 自动检测 Agent 回答中提到的文件并发送（前 3 个）
			const { existsSync } = await import("node:fs");
			const pathPattern = /(?:保存到|已生成|文件在|输出到|写入|created|saved to|written to)[：:\s]*([^\s，,\n""<>]{5,200}\.(?:md|txt|csv|json|html|pdf|png|jpg|xlsx|docx|pptx|py|ts|js))/gi;
			const autoFiles: string[] = [];
			let m: RegExpExecArray | null;
			while ((m = pathPattern.exec(text)) !== null) {
				const fp = m[1].trim();
				if (fp && existsSync(fp) && !autoFiles.includes(fp)) autoFiles.push(fp);
			}
			if (autoFiles.length > 0) {
				log(`[飞书 Bridge] 自动检测到 ${autoFiles.length} 个文件: ${autoFiles.join(", ")}`);
				for (const fp of autoFiles.slice(0, 3)) {
					const result = await this.sendFeishuFile(chatId, fp);
					log(`[飞书 Bridge] 自动发送文件结果: ${result}`);
					await this.sendSmartMessage(chatId, result);
				}
			}
		}
		const docMatch = text.match(/\[CREATE_DOC:([^\]]+)\]/);
		if (docMatch) {
			const title = docMatch[1].trim() || feishuT(this.locale, "doc.defaultTitle");
			const result = await this.createFeishuDoc(chatId, title, text);
			// createFeishuDoc 内部失败时发了消息，这里补充发送
			if (result.startsWith("❌")) await this.sendSmartMessage(chatId, result);
		}
	}

	/**
	 * 上传本地文件并发送到飞书聊天。
	 * 流程：POST im/v1/files 上传 → 拿到 file_key → im.message.create 发送 file 消息
	 */
	private async sendFeishuFile(chatId: string, filePath: string, fileName?: string): Promise<string> {
		if (!this.connection.client) return feishuT(this.locale, "file.bridgeNotReady");
		const { existsSync, readFileSync, statSync } = await import("node:fs");
		const { basename } = await import("node:path");
		if (!existsSync(filePath)) return feishuT(this.locale, "file.notFound", { path: filePath });
		const fName = fileName || basename(filePath);
		// 先 stat 后读：30MB 上限若在整文件进内存后才判，大文件等于白读一次。
		if (statSync(filePath).size > 30 * 1024 * 1024) return feishuT(this.locale, "file.tooLarge");
		const fileData = readFileSync(filePath);

		try {
			// 1. 用 SDK im.file.create 上传文件
			const uploadResp = await this.connection.client.im.file!.create({
				data: { file_type: "stream", file_name: fName, file: fileData },
			});
			const fileKey = (uploadResp as Record<string, unknown>)?.file_key as string;
			if (!fileKey) {
				logErr("[飞书 Bridge] 上传文件未返回 file_key:", uploadResp);
				return feishuT(this.locale, "file.uploadFailed");
			}

			// 2. 发送文件消息
			await this.connection.client.im.message.create({
				params: { receive_id_type: "chat_id" },
				data: {
					receive_id: chatId,
					msg_type: "file",
					content: JSON.stringify({ file_key: fileKey }),
				},
			});
			return feishuT(this.locale, "file.sent", { name: fName });
		} catch (e) {
			logErr("[飞书 Bridge] 发送文件失败:", e);
			return feishuT(this.locale, "file.sendFailed");
		}
	}

	/**
	 * 创建飞书文档并分享链接到聊天。
	 * 需在飞书开放平台开启 docx:document 权限。
	 */
	private async createFeishuDoc(chatId: string, title: string, body = ""): Promise<string> {
		if (!this.connection.client) return feishuT(this.locale, "file.bridgeNotReady");
		try {
			const resp = await this.connection.client.request<{
				code?: number;
				msg?: string;
				data?: { document?: { document_id?: string; title?: string; url?: string } };
			}>({
				method: "POST",
				url: "https://open.feishu.cn/open-apis/docx/v1/documents",
				data: { title },
			});
			const doc = resp?.data?.document;
			if (!doc?.document_id) {
				logErr("[飞书 Bridge] 创建文档未返回 document_id:", resp);
				return feishuT(this.locale, "doc.createFailed");
			}

			const children = buildFeishuTextChildren(body);
			if (children.length > 0) {
				try {
					await this.connection.client.request({
						method: "POST",
						url: `https://open.feishu.cn/open-apis/docx/v1/documents/${doc.document_id}/blocks/${doc.document_id}/children`,
						params: { document_revision_id: -1 },
						data: { children, index: 0 },
					});
				} catch (writeError) {
					logErr("[飞书 Bridge] 写入飞书文档正文失败:", writeError);
					const docUrl = doc.url || `https://www.feishu.cn/docx/${doc.document_id}`;
					await this.sendSmartMessage(chatId, `📄 **${title}**\n${docUrl}\n\n${feishuT(this.locale, "doc.bodyWriteFailed")}`);
					return feishuT(this.locale, "doc.bodyWriteFailedResult", { title, url: docUrl });
				}
			}

			const docUrl = doc.url || `https://www.feishu.cn/docx/${doc.document_id}`;
			const preview = stripFeishuActionMarkers(body);
			await this.sendSmartMessage(chatId, `📄 **${title}**\n${docUrl}${preview ? `\n\n${feishuT(this.locale, "doc.bodyWritten")}` : ""}`);
			return feishuT(this.locale, "doc.created", { title, url: docUrl });
		} catch (e) {
			logErr("[飞书 Bridge] 创建飞书文档失败:", e);
			return feishuT(this.locale, "doc.createFailed");
		}
	}

	// ===== 图片/文件下载 =====

	private async downloadImage(messageId: string, imageKey: string): Promise<Buffer> {
		if (!this.connection.client) throw new Error("飞书 Client 未初始化");
		try {
			return await this.downloadMessageResource(messageId, imageKey, "image");
		} catch {
			warn("[飞书 Bridge] messageResource 失败，回退到 image.get");
		}
		return this.downloadViaImageGet(imageKey);
	}
	private async downloadMessageResource(messageId: string, fileKey: string, type: "image" | "file"): Promise<Buffer> {
		const resp = await this.connection.client!.im.messageResource.get({ path: { message_id: messageId, file_key: fileKey }, params: { type } });
		return this.streamToBuffer(resp);
	}
	private async downloadViaImageGet(imageKey: string): Promise<Buffer> {
		const resp = await this.connection.client!.request({ method: "GET", url: `https://open.feishu.cn/open-apis/im/v1/images/${imageKey}` });
		return this.streamToBuffer(resp);
	}
	private async downloadFile(messageId: string, fileKey: string): Promise<Buffer> {
		return this.downloadMessageResource(messageId, fileKey, "file");
	}

	private async streamToBuffer(result: unknown): Promise<Buffer> {
		const resp = result as Record<string, unknown>;
		if (typeof resp?.getReadableStream === "function") {
			const chunks: Buffer[] = [];
			const readable = (resp.getReadableStream as () => NodeJS.ReadableStream)();
			for await (const chunk of readable as AsyncIterable<Buffer | string>) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			return Buffer.concat(chunks);
		}
		if (typeof (result as AsyncIterable<unknown>)?.[Symbol.asyncIterator] === "function") {
			const chunks: Buffer[] = [];
			for await (const chunk of result as AsyncIterable<Buffer | string>) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			return Buffer.concat(chunks);
		}
		if (typeof resp?.writeFile === "function") {
			const { readFileSync, unlinkSync } = await import("node:fs");
			const tmp = `/tmp/feishu-dl-${Date.now()}.tmp`;
			await (resp.writeFile as (p: string) => Promise<void>)(tmp);
			const data = readFileSync(tmp);
			try {
				unlinkSync(tmp);
			} catch {}
			return data;
		}
		logErr("[飞书 Bridge] streamToBuffer 未知格式:", typeof result);
		throw new Error("无法读取飞书文件流");
	}

	// ===== 群聊辅助 =====

	private isBotMentioned(mentions: Array<{ name: string; id: string | { open_id: string; union_id: string; user_id: string } }> | undefined): boolean {
		if (!mentions || mentions.length === 0) return false;
		for (const m of mentions) {
			const openId = typeof m.id === "string" ? m.id : m.id.open_id;
			if (openId === "all") continue;
			if (openId === this.botOpenId) return true;
		}
		return false;
	}

	private async getGroupInfo(chatId: string): Promise<FeishuGroupInfo | null> {
		const cached = this.groupInfoCache.get(chatId);
		if (cached && Date.now() - cached.cachedAt < GROUP_CACHE_TTL) return cached;
		if (!this.connection.client) return null;
		try {
			const [chatResp, members] = await Promise.all([this.connection.client.im.chat.get({ path: { chat_id: chatId } }), this.fetchGroupMembers(chatId)]);
			const name = (chatResp as { data?: { name?: string } }).data?.name ?? feishuT(this.locale, "group.unknown");
			const info: FeishuGroupInfo = { chatId, name, members, cachedAt: Date.now() };
			this.groupInfoCache.set(chatId, info);
			return info;
		} catch (e) {
			warn("[飞书 Bridge] 获取群聊信息失败:", e);
			return null;
		}
	}

	private async fetchGroupMembers(chatId: string): Promise<FeishuGroupMember[]> {
		if (!this.connection.client) return [];
		try {
			const resp = await this.connection.client.im.chat.members.get({ path: { chat_id: chatId }, params: { user_id_type: "open_id", page_size: 100 } });
			return ((resp as { data?: { items?: Array<{ open_id: string; name?: string }> } }).data?.items ?? []).map((m) => ({ openId: m.open_id, name: m.name ?? m.open_id }));
		} catch (e) {
			warn("[飞书 Bridge] 获取群成员失败:", e);
			return [];
		}
	}

	private async getUserName(userId: string): Promise<string> {
		const cached = this.userNameCache.get(userId);
		if (cached) return cached;
		this.userNameCache.set(userId, userId);
		return userId;
	}

	private inferImageMediaType(data: Buffer): string {
		if (data.length < 4) return "image/png";
		if (data[0] === 0x89 && data[1] === 0x50) return "image/png";
		if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
		if (data[0] === 0x47 && data[1] === 0x49) return "image/gif";
		if (data[0] === 0x52 && data[1] === 0x49) return "image/webp";
		return "image/png";
	}

	// ===== 持久化 =====

	private async loadPersistedBindings(): Promise<void> {
		const bindings = loadBindings(this.botConfig.id);
		const tabs = this.agentManager.list();
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
					const runtimeBinding = await this.runtimeBindings.bindRuntime({
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
			this.chatBindings.set(b.chatId, binding);
			this.indexBinding(binding);
			if (!authorizedTab) {
				log(`[飞书 Bridge] 保留无主绑定（等后续恢复）: ${b.groupName ?? b.chatId}，sessionPath=${b.sessionPath ?? "(无)"}`);
			}
			if (binding.sessionPath) setPersistentChatId(binding.sessionPath, b.chatId);
			setPersistentChatId(`session:${binding.sessionId}`, b.chatId);
			if (binding.agentId) setPersistentChatId(`agent:${binding.agentId}`, b.chatId);
		}
		if (migrated) this.persistBindings();
		if (this.chatBindings.size > 0) log(`[飞书 Bridge] 已恢复 ${this.chatBindings.size} 个聊天绑定`);
		this.updateStatus({ activeBindings: this.chatBindings.size });
	}

	private persistBindings(): void {
		const bindings: FeishuChatBindingPersist[] = Array.from(this.chatBindings.values()).map((b) => ({
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
		saveBindings(this.botConfig.id, bindings);
	}

	// ===== 状态推送 =====

	private updateStatus(partial: Partial<FeishuBridgeStatus>): void {
		this.status = { ...this.status, ...partial };
		const win = this.getWindow();
		if (win && !win.isDestroyed()) win.webContents.send(ipcChannels.feishuStatus, this.status);
	}

	/** 将绑定列表推送到前端（绑定变更时调用） */
	private pushBindings(): void {
		const win = this.getWindow();
		if (win && !win.isDestroyed()) {
			win.webContents.send(ipcChannels.feishuBindingsChanged, this.listBindings());
		}
	}

	pushMessage(message: FeishuChatMessage): void {
		const win = this.getWindow();
		if (win && !win.isDestroyed()) win.webContents.send(ipcChannels.feishuMessages, message);
	}
}
