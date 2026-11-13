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
import type { FeishuBotConfig, FeishuBridgeStatus, FeishuChatBinding, FeishuChatMessage, FeishuTestResult, ImageContent, AvailableModel, AgentTab, ChatMessage, ImChannelBackend, LocalProject } from "../../shared/types";
import type { FeishuImageAttachment, FeishuFileAttachment, FeishuMessageContext, FeishuCardActionEvent } from "./types";
import { setPersistentChatId } from "./FeishuConfig";
import { chooseMessageMode, buildPostMessages, buildMarkdownCards } from "./rich-text";
import { CardStream } from "./CardStream";
import { FeishuConnection } from "./FeishuConnection";
import { sanitizeFeishuUserVisibleText, stripFeishuActionMarkers, wantsFeishuDoc } from "./docActions";
import { markInterrupted, markError, reduceFromPiEvent, type RunState } from "./CardRunState";
import { renderRunCard } from "./CardRenderer";
import { parseModelActionValue } from "./ModelPickerCard";
import { normalizeAskOption, parseAskActionValue, parseAskInputValue } from "./AskCard";
import { MAX_ATTACHMENT_BYTES, PENDING_ATTACHMENT_MAX_BYTES, PENDING_ATTACHMENT_MAX_COUNT, formatAttachmentSize, safeAttachmentFileName } from "./attachmentFiles";
import { feishuLanguage, feishuT, normalizeFeishuLocale, type FeishuLocale } from "./FeishuI18n";
import { log, logErr } from "./bridge/bridgeLog";
import { FeishuMedia } from "./bridge/media";
import { FeishuAskCenter, type PendingAsk } from "./bridge/askCenter";
import { FeishuCommands } from "./bridge/commands";
import { FeishuOutbound } from "./bridge/outbound";
import { FeishuBindings } from "./bridge/bindings";
import { FeishuSessionMirror } from "./bridge/sessionMirror";
import { FeishuRunCards } from "./bridge/runCards";
import { FeishuSessionSync } from "./bridge/sessionSync";
import { FeishuActions } from "./bridge/actions";
import { FeishuRuntimeAuth } from "./bridge/runtimeAuth";
import type { AgentManager } from "../pi/AgentManager";

import type { SessionRuntimeBindingGateway } from "../sessions/sessionRuntimeBinding";

export type { SessionRuntimeBindingGateway };

// ===== 常量 =====
const DEDUP_MAX = 200;
/**
 * 每个 chat 的忙时排队上限。
 * 超限必须明确回「排满」，不能沿用旧实现的「静默跳过」——用户连发几条时丢的往往是最新那条。
 */
const PENDING_QUEUE_MAX = 20;

export class FeishuBridge {
	private botConfig: FeishuBotConfig;
	private agentManager: AgentManager;
	private runtimeBindings: SessionRuntimeBindingGateway;
	private getWindow: () => BrowserWindow | null;
	/** 飞书 Bridge 只在本机项目上建会话；远端项目由调用方过滤掉（不能把远端路径当本机 cwd）。 */
	private getProjects: () => LocalProject[];
	private locale: FeishuLocale;

	private connection: FeishuConnection;

	private status: FeishuBridgeStatus = { status: "disconnected", activeBindings: 0 };
	private botOpenId: string | null = null;
	private userOpenId: string | null = null; // 记住最近一个用户，用于自动拉群

	private recentMessageIds = new Set<string>();
	private recentEventIds = new Set<string>();
	private processingChats = new Set<string>();
	/**
	 * 忙时排队的入站事件（按 chatId FIFO，队列里存原始事件对象）。
	 * 与桌面端 busySendDelivery 的排队语义对齐：上一轮收尾后自动重放，不再直接丢弃。
	 */
	private pendingMessageQueues = new Map<string, Array<Record<string, unknown>>>();
	/** 用户发了文件但还没说需求，暂存着等文字指令 */
	private pendingAttachments = new Map<string, { images: FeishuImageAttachment[]; files: FeishuFileAttachment[] }>();

	private chatBindings = new Map<string, FeishuChatBinding>();
	private sessionToChat = new Map<string, string>();
	private sessionMirror: FeishuSessionMirror;
	private runCards: FeishuRunCards;
	private sessionSync: FeishuSessionSync;
	private actions: FeishuActions;
	private runtimeAuth: FeishuRuntimeAuth;

	private media: FeishuMedia;
	private asks: FeishuAskCenter;
	private commands: FeishuCommands;
	private outbound: FeishuOutbound;
	private bindings: FeishuBindings;
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

	/** 卡片是否展示思考过程（跟随 pi agent 的 hideThinkingBlock）：用 resolver 而不是快照，用户改配置后立刻生效。 */
	private readonly getShowThinking: () => boolean;

	constructor(botConfig: FeishuBotConfig, agentManager: AgentManager, getWindow: () => BrowserWindow | null, getProjects: () => LocalProject[], runtimeBindings: SessionRuntimeBindingGateway, plainAppSecret?: string, locale: FeishuLocale = "zh-CN", getShowThinking: () => boolean = () => true) {
		this.botConfig = botConfig;
		this.agentManager = agentManager;
		this.runtimeBindings = runtimeBindings;
		this.getWindow = getWindow;
		this.getProjects = getProjects;
		this.locale = normalizeFeishuLocale(locale);
		this.getShowThinking = getShowThinking;
		this.connection = new FeishuConnection(botConfig, plainAppSecret, this.locale);
		// 连接句柄、bot open_id 与 locale 都会随 start/stop 与热更新变化：协作者按调用取值，不拿快照。
		this.media = new FeishuMedia({ client: () => this.connection.client, botOpenId: () => this.botOpenId, locale: () => this.locale });
		this.outbound = new FeishuOutbound({
			client: () => this.connection.client,
			locale: () => this.locale,
			sendSmartMessage: (chatId, text) => this.sendSmartMessage(chatId, text),
			getRuntimeMessages: (sessionId) => this.runtimeBindings.getRuntimeMessages(sessionId),
		});
		this.bindings = new FeishuBindings({
			botId: () => this.botConfig.id,
			listAgents: () => this.agentManager.list(),
			bindRuntime: (input) => this.runtimeBindings.bindRuntime(input),
			chatBindings: this.chatBindings,
			sessionToChat: this.sessionToChat,
			feishuSessions: this.feishuSessions,
			indexBinding: (binding) => this.indexBinding(binding),
			persistBindings: () => this.persistBindings(),
			updateStatus: (partial) => this.updateStatus(partial),
		});
		this.sessionMirror = new FeishuSessionMirror({
			client: () => this.connection.client,
			bridgeStatus: () => this.status,
			locale: () => this.locale,
			botConfig: () => this.botConfig,
			botOpenId: () => this.botOpenId,
			userOpenId: () => this.userOpenId,
			listAgents: () => this.agentManager.list(),
			bindRuntime: (input) => this.runtimeBindings.bindRuntime(input),
			authorizeRuntimeAgent: (binding) => this.runtimeAuth.authorize(binding),
			bindingEntries: () => Array.from(this.chatBindings.entries()),
			bindingValues: () => Array.from(this.chatBindings.values()),
			findBinding: (chatId) => this.chatBindings.get(chatId),
			setBinding: (chatId, binding) => this.chatBindings.set(chatId, binding),
			bindingCount: () => this.chatBindings.size,
			indexBinding: (binding, previousAgentId, previousSessionId) => this.indexBinding(binding, previousAgentId, previousSessionId),
			persistBindings: () => this.persistBindings(),
			pushBindings: () => this.pushBindings(),
			updateActiveBindings: (count) => this.updateStatus({ activeBindings: count }),
			sendSmartMessage: (chatId, text) => this.sendSmartMessage(chatId, text),
		});
		this.runCards = new FeishuRunCards({
			locale: () => this.locale,
			getShowThinking: () => this.getShowThinking(),
			streamingCards: this.streamingCards,
			streamingRunStates: this.streamingRunStates,
			pendingCardEvents: this.pendingCardEvents,
			addLocalEventListener: (handler) => this.agentManager.addLocalEventListener(handler),
		});
		this.sessionSync = new FeishuSessionSync({
			client: () => this.connection.client,
			getBestChatId: (sessionOrAgentId) => this.getBestChatId(sessionOrAgentId),
			sendSmartMessage: (chatId, text) => this.sendSmartMessage(chatId, text),
			listAgents: () => this.agentManager.list(),
			ensureSessionMirror: (agentId, sessionTitle, sessionPath) => this.ensureSessionMirror(agentId, sessionTitle, sessionPath),
			pendingDocRequests: this.pendingDocRequests,
		});
		this.actions = new FeishuActions({
			locale: () => this.locale,
			sendSmartMessage: (chatId, text) => this.sendSmartMessage(chatId, text),
			sendFeishuFile: (chatId, filePath, fileName) => this.sendFeishuFile(chatId, filePath, fileName),
			createFeishuDoc: (chatId, title, body) => this.outbound.createFeishuDoc(chatId, title, body),
		});
		this.runtimeAuth = new FeishuRuntimeAuth({
			findRuntimeAgent: (agentId) => this.runtimeBindings.findRuntimeAgent(agentId),
			bindRuntime: (input) => this.runtimeBindings.bindRuntime(input),
			indexBinding: (binding, previousAgentId, previousSessionId) => this.indexBinding(binding, previousAgentId, previousSessionId),
			persistBindings: () => this.persistBindings(),
			pushBindings: () => this.pushBindings(),
		});
		this.asks = new FeishuAskCenter({
			locale: () => this.locale,
			getBestChatId: (sessionOrAgentId) => this.getBestChatId(sessionOrAgentId),
			sendSmartMessage: (chatId, text) => this.sendSmartMessage(chatId, text),
			sendCardMessage: (chatId, card) => this.outbound.sendCardMessage(chatId, card),
			sendUIResponse: (agentId, requestId, response) => this.runtimeBindings.sendUIResponse(agentId, requestId, response),
			pendingAsks: this.pendingAsks,
		});
		this.commands = new FeishuCommands({
			locale: () => this.locale,
			bridgeStatus: () => this.status,
			sendSmartMessage: (chatId, text) => this.sendSmartMessage(chatId, text),
			sendCardMessage: (chatId, card) => this.outbound.sendCardMessage(chatId, card),
			sendWhoamiResult: (userId) => this.sendWhoamiResult(userId),
			createNewSession: (ctx) => this.createNewSession(ctx),
			handleStopCommand: (ctx) => this.handleStopCommand(ctx),
			doSetModel: (chatId, rawId) => this.commands.doSetModel(chatId, rawId),
			reloadBindings: () => this.reloadBindings(),
			sendFeishuFile: (chatId, filePath) => this.sendFeishuFile(chatId, filePath),
			createFeishuDoc: (chatId, title, body) => this.outbound.createFeishuDoc(chatId, title, body),
			findBinding: (chatId) => this.chatBindings.get(chatId),
			bindingCount: () => this.chatBindings.size,
			ensureRuntimeAgent: (binding) => this.ensureRuntimeBinding(binding),
			setRuntimeModel: (sessionId, provider, modelId) => this.runtimeBindings.setRuntimeModel(sessionId, provider, modelId),
			listRuntimeModels: (sessionId) => this.runtimeBindings.listRuntimeModels(sessionId),
			getRuntimeState: (sessionId) => this.runtimeBindings.getRuntimeState(sessionId),
			isChatBusy: (chatId) => this.processingChats.has(chatId),
			queuedCount: (chatId) => this.pendingMessageQueues.get(chatId)?.length ?? 0,
		});
	}

	/** 将用户 open_id 推回前端（添加 Bot 时自动填入）。 */
	private sendWhoamiResult(userId: string): void {
		try {
			const win = this.getWindow();
			if (win && !win.isDestroyed()) win.webContents.send(ipcChannels.feishuWhoamiResult, userId);
		} catch {
			/* ignore */
		}
	}

	/**
	 * 新建一次运行的状态机。showThinking 在建状态时就定下来：关闭时 reducer 连思考增量都不累积（#425）。
	 * resolver 抛错按「显示」处理，保持与历史行为一致 —— 卡片缺一块比整轮不推要好。
	 */
	private newRunState(): RunState {
		return this.runCards.newRunState();
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

	/** 该 Bot 新建会话使用的后端（设置项，只影响新会话）。 */
	private botBackend(): ImChannelBackend {
		return this.botConfig.backend ?? "pi";
	}

	/** 会话自己的后端：绑定上记录的值优先（随会话走），缺省才回落到 Bot 设置。 */
	private bindingBackend(binding: FeishuChatBinding): ImChannelBackend {
		return binding.backend ?? this.botBackend();
	}

	private async ensureRuntimeBinding(binding: FeishuChatBinding, options?: { forceNew?: boolean }): Promise<string | undefined> {
		// 换后端时必须跳过句柄复用：旧句柄跑的还是旧引擎，复用它等于没换。
		if (!options?.forceNew) {
			const activeAgentId = await this.runtimeAuth.authorize(binding);
			if (activeAgentId) return activeAgentId;
		}
		const resumed = await this.resumeOrCreateAgent(binding, options);
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
		await this.bindings.reload();
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
		return this.bindings.update(chatId, patch);
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
		this.processingChats.clear();
		// 断开即作废队列：没人会再 drain 它，留着只会在下次连接时误跑旧消息。
		this.pendingMessageQueues.clear();
		this.lastUserMessageId.clear();
		this.syncedFingerprints.clear();
		this.media.resetCaches();
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
			this.sendWhoamiResult(userId);
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
					await this.commands.handleCommand(msgCtx, cmdText);
					return;
				}
			} catch {}
		}

		if (this.processingChats.has(chatId)) {
			// 忙时排队而不是丢弃：旧实现只写一行日志就 return，用户在群里完全没反馈。
			this.enqueuePendingMessage(chatId, data);
			return;
		}
		this.processingChats.add(chatId);

		try {
			if (chatType === "group" && this.botConfig.requireMention !== false && !this.media.isBotMentioned(mentions)) {
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
								const imgData = await this.media.downloadImage(messageId, node.image_key);
								imageAttachments.push({ imageKey: node.image_key, data: imgData, mediaType: this.media.inferImageMediaType(imgData) });
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
						const imgData = await this.media.downloadImage(messageId, content.image_key);
						imageAttachments.push({ imageKey: content.image_key, data: imgData, mediaType: this.media.inferImageMediaType(imgData) });
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
						const fileData = await this.media.downloadFile(messageId, content.file_key);
						// 单文件 UX 上限 200MB（#427 追加二）：下载硬闸 256MB 在 streamToBuffer 里，
						// 这层只负责给出「太大不处理」的明确回执。
						if (fileData.length > MAX_ATTACHMENT_BYTES) {
							await this.sendSmartMessage(chatId, feishuT(this.locale, "attachment.fileTooLarge", { limit: formatAttachmentSize(MAX_ATTACHMENT_BYTES) }));
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
				// 会让每个文件（最大 200MB）的完整 Buffer 无限期驻留内存直到进程重启。
				const existing = this.pendingAttachments.get(chatId);
				const heldCount = existing ? existing.images.length + existing.files.length : 0;
				const heldBytes = existing ? [...existing.images, ...existing.files].reduce((n, a) => n + a.data.length, 0) : 0;
				const incomingCount = imageAttachments.length + fileAttachments.length;
				const incomingBytes = [...imageAttachments, ...fileAttachments].reduce((n, a) => n + a.data.length, 0);
				if (heldCount + incomingCount > PENDING_ATTACHMENT_MAX_COUNT || heldBytes + incomingBytes > PENDING_ATTACHMENT_MAX_BYTES) {
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
				const [gi, un] = await Promise.all([this.media.getGroupInfo(chatId), this.media.getUserName(userId)]);
				groupName = gi?.name;
				senderName = un;
			}

			const msgCtx: FeishuMessageContext = { chatId, senderOpenId: userId, senderName, messageId, chatType: chatType as "p2p" | "group", groupName };

			// 幂等只认平台投递身份（event_id / message_id，见 handleMessage 开头）：
			// 5s 同文本去重会吞掉用户主动连发的两句「在吗」，重投场景已由 id 幂等覆盖。

			log(`[飞书 Bridge] 准备调用 Agent: ${chatId}, "${text.slice(0, 60)}", images=${imageAttachments.length}`);

			// ⚡ 闪电确认：fire-and-forget，不等待
			const replyToMsgId = chatType === "group" ? messageId : undefined;
			void this.outbound.sendLightningConfirm(chatId, replyToMsgId).catch(() => {});

			await this.runAgent(msgCtx, text, imageAttachments, fileAttachments);
		} finally {
			this.processingChats.delete(chatId);
			this.drainPendingMessageQueue(chatId);
		}
	}

	/** 忙时把原始事件按 chatId 排队并回执「第 N 位」；排满则明确告诉用户没排上。 */
	private enqueuePendingMessage(chatId: string, event: Record<string, unknown>): void {
		const queue = this.pendingMessageQueues.get(chatId) ?? [];
		if (queue.length >= PENDING_QUEUE_MAX) {
			void this.sendSmartMessage(chatId, feishuT(this.locale, "queue.full", { limit: PENDING_QUEUE_MAX })).catch(() => {});
			return;
		}
		queue.push(event);
		this.pendingMessageQueues.set(chatId, queue);
		log(`[飞书 Bridge] 忙时排队: ${chatId.slice(0, 8)} (第 ${queue.length} 位)`);
		void this.sendSmartMessage(chatId, feishuT(this.locale, "queue.accepted", { position: queue.length })).catch(() => {});
	}

	/**
	 * 上一轮收尾后重放队首。
	 *
	 * 重放前必须撤销这条消息的幂等记录：event_id/message_id 在入队前就已经记账，
	 * 不撤销会被 handleMessage 当成平台重投直接丢掉（用户看到的就是「排队后没反应」）。
	 */
	private drainPendingMessageQueue(chatId: string): void {
		if (this.processingChats.has(chatId)) return;
		const queue = this.pendingMessageQueues.get(chatId);
		const next = queue?.shift();
		if (!queue || !next) {
			this.pendingMessageQueues.delete(chatId);
			return;
		}
		if (queue.length === 0) this.pendingMessageQueues.delete(chatId);
		const eventId = next.event_id as string | undefined;
		if (eventId) this.recentEventIds.delete(eventId);
		const messageId = (next.message as { message_id?: string } | undefined)?.message_id;
		if (messageId) this.recentMessageIds.delete(messageId);
		log(`[飞书 Bridge] 排队消息出队: ${chatId.slice(0, 8)}`);
		void this.handleMessage(next).catch((error) => logErr("[飞书 Bridge] 排队消息重放失败:", error));
	}

	// ===== 命令处理 =====

	/** 命令分诊（/help /new /stop /status /model /sendfile /newdoc /whoami /refresh）在 commands 域。 */

	// ===== Agent 执行（流式卡片 + 并行优化） =====

	private async runAgent(ctx: FeishuMessageContext, text: string, imageAttachments: FeishuImageAttachment[], fileAttachments: FeishuFileAttachment[]): Promise<void> {
		const { chatId } = ctx;
		let binding = this.chatBindings.get(chatId);

		// stable sessionId identifies the catalog record; all process operations use agentId.
		if (binding) {
			// 设置里换了 Bot 后端 = 换引擎：旧绑定记的会话文件与模型目录都属于旧引擎，继续复用
			// 只会让它静默跑在旧引擎上（用户以为切了后端其实没切）。这里改记新后端并强制开新会话，
			// 由 resumeOrCreateAgent 回一条换绑说明。
			// 旧绑定的 backend 缺省按 pi 算（功能上线前的绑定都是 pi），不能用 bindingBackend——
			// 它会回落到当前 Bot 设置，把「老绑定 + 新设置」误判成一致，就永远不会换绑。
			const settingsBackend = this.botBackend();
			const currentBackend = binding.backend ?? "pi";
			const switched = currentBackend !== settingsBackend;
			if (switched) {
				log(`[飞书 Bridge] 会话后端变更（${currentBackend} → ${settingsBackend}），换绑新会话`);
				binding.backend = settingsBackend;
			}
			const runtimeAgentId = await this.ensureRuntimeBinding(binding, { forceNew: switched });
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
		// 会话自己的后端：流式卡片与宿主指令都是 pi 能力，其它后端降级为「最终文本」。
		const backend = this.bindingBackend(binding);

		// 关闭已有流式卡片
		const existingCard = this.streamingCards.get(agentId);
		if (existingCard) {
			await existingCard.flush(markInterrupted(this.newRunState())).catch(() => {});
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
		const savedFiles: Array<{ path: string; name: string; size: number }> = [];
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
			// 落盘 + 绝对路径（#427 追加一）：只把文件名拼进 prompt 时，Agent 以为自己拿到了原文，
			// 实际是零字节——最容易骗人的失败模式。文件写到临时目录，路径随 prompt 交给 Agent，
			// run 收尾时删除（同图片）。sendPrompt 只收文本+图片，所以这里只给路径文本。
			const fileDir = join(tmpdir(), "pi-feishu-files");
			mkdirSync(fileDir, { recursive: true });
			for (const att of fileAttachments) {
				const fp = join(fileDir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeAttachmentFileName(att.fileName)}`);
				writeFileSync(fp, att.data);
				savedFiles.push({ path: fp, name: att.fileName, size: att.data.length });
			}
			const manifest = savedFiles.map((file) => `- ${file.path}（原名 ${file.name}，${formatAttachmentSize(file.size)}）`).join("\n");
			const note = `[文件已保存到本地，务必用 Read/文件工具读取原文，禁止只看文件名猜内容]\n${manifest}`;
			finalText = finalText ? `${finalText}\n\n${note}` : note;
		}

		const initialState = this.newRunState();
		// 卡片事件机由 pi 本地事件驱动（handleAgentEvent）：非 pi 后端没有这些事件，
		// 既不能开卡片也不能登记缓存表，否则每轮都会留下永不清理的孤儿注册项。
		const useStreamingCard = backend === "pi";
		if (useStreamingCard) {
			this.streamingRunStates.set(agentId, initialState);
			this.pendingCardEvents.set(agentId, []);
		}

		// 流式卡片：创建后实时更新活动轨迹和输出
		const cardPromise = useStreamingCard
			? CardStream.open(this.connection.client!, chatId, renderRunCard(initialState, { locale: this.locale }), { replyToMessageId: ctx.chatType === "group" ? ctx.messageId : undefined }).catch((e) => {
					logErr("[飞书 Bridge] 流式卡片创建失败:", e);
					return null as CardStream | null;
				})
			: Promise.resolve(null as CardStream | null);

		// 先注册回合结束监听再提交 prompt：快速失败的 run（模型配置错/auth 失败）会在
		// 卡片创建窗口内结束，注册晚于事件会错过 → 等满 300s 超时，期间
		// processingChats 持有 chatId，该聊天的后续消息被静默丢弃 5 分钟。
		// pi 用 agent_end 本地事件；其它后端统一走网关的回合等待器（agents:state 快照 + 时间线错误）。
		const sinceIndex = this.runtimeBindings.getRuntimeMessages(binding.sessionId).length;
		const runEndPromise: Promise<{ timedOut: boolean; failed: boolean; errorMessage?: string }> =
			backend === "pi"
				? this.waitForAgentEnd(agentId, 300_000).then((timedOut) => ({ timedOut, failed: false }))
				: this.runtimeBindings.waitForRunEnd({ sessionId: binding.sessionId, sinceIndex, timeoutMs: 300_000 }).then((outcome) => (outcome.kind === "timeout" ? { timedOut: true, failed: false } : { timedOut: false, failed: outcome.failed, ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}) }));

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
			const promptText = finalText || "处理附件";
			// pi 走宿主指令通道（agentMessage）；DSH 等后端没有这个通道并会直接拒收整条 prompt，
			// 因此把同样的内容并进正文——通道约束对它们同样必要。
			await this.runtimeBindings.sendPrompt(backend === "pi" ? { sessionId: binding.sessionId, message: promptText, agentMessage: feishuCtx, ...(images.length > 0 ? { images } : {}) } : { sessionId: binding.sessionId, message: `${feishuCtx}\n\n${promptText}`, ...(images.length > 0 ? { images } : {}) });
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
			this.runCards.replayBufferedEvents(agentId, cardStream);
		} else {
			this.pendingCardEvents.delete(agentId);
		}

		const startTime = Date.now();

		try {
			const runEnd = await runEndPromise;
			await new Promise((r) => setTimeout(r, 800));

			if (runEnd.timedOut) {
				// run 超过 5 分钟仍在运行：保留卡片/状态注册表，让 handleAgentEvent 的
				// 终态分支在真正结束时 flush+close+清理。此处删注册表会让卡片永久停在
				// 中间态且最终结果无任何交付通道（agent_end 迟到时三张 map 已被清空）。
				log(`[飞书 Bridge] 等待 agent_end 超时（run 仍在运行），保留卡片继续跟进: agentId=${agentId.slice(0, 8)}`);
				return;
			}

			if (runEnd.failed) {
				// 非 pi 后端不会把失败写成时间线里的 assistant 回复，失败文本只能由回合等待器给出。
				await this.sendSmartMessage(chatId, runEnd.errorMessage ?? feishuT(this.locale, "agent.failed"));
				this.streamingRunStates.delete(agentId);
				this.pendingCardEvents.delete(agentId);
			} else if (hasCard) {
				if (this.cardUpdateFailed.has(agentId)) {
					this.cardUpdateFailed.delete(agentId);
					log(`[飞书 Bridge] 卡片更新失败，降级为文本消息`);
					await this.outbound.sendResultFallback(chatId, binding.sessionId, startTime);
				}
				this.streamingCards.delete(agentId);
				this.streamingRunStates.delete(agentId);
				this.pendingCardEvents.delete(agentId);
			} else {
				await this.outbound.sendResultFallback(chatId, binding.sessionId, startTime);
				this.streamingRunStates.delete(agentId);
				this.pendingCardEvents.delete(agentId);
			}
			// 标记扫描与文档正文都基于同一份时间线快照（非 pi 后端同样适用）
			const runMessages = this.runtimeBindings.getRuntimeMessages(binding.sessionId);
			// 统一扫描 Agent 回复中的飞书标记并执行
			await this.actions.processReplyActions(chatId, runMessages).catch((e) => logErr("[飞书 Bridge] 处理飞书动作异常:", e));

			// 没有 [CREATE_DOC:] 标记但用户说了要做飞书文档 → 自动创建
			const docTitle = wantsFeishuDoc(text);
			if (docTitle) {
				const lastMsg = runMessages.filter((m) => m.role === "assistant").pop();
				if (lastMsg?.text && !lastMsg.text.includes("[CREATE_DOC:")) {
					const body = stripFeishuActionMarkers(lastMsg.text);
					if (body) {
						await this.outbound.createFeishuDoc(chatId, docTitle, body).catch((e) => logErr("[飞书 Bridge] feishu 路径自动创建文档失败:", e));
					}
				}
			}
		} catch (e) {
			logErr("[飞书 Bridge] Agent 运行失败:", e);
			const errState = markError(this.newRunState(), feishuT(this.locale, "agent.failed"));
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
			// 清理本轮附件临时文件：路径已随 prompt 交给 Agent，run 结束（含 processFeishuActions
			// 的 [SEND_FILE:] 已执行完）后文件不再有用；不删则 pi-feishu-images / pi-feishu-files 无限增长。
			const cleanupPaths = [...savedImages, ...savedFiles.map((file) => file.path)];
			if (cleanupPaths.length > 0) {
				void import("node:fs").then(({ unlink }) => {
					for (const fp of cleanupPaths) unlink(fp, () => {});
				});
			}
		}
	}

	private waitForAgentEnd(sessionId: string, timeoutMs: number): Promise<boolean> {
		return this.runCards.waitForAgentEnd(sessionId, timeoutMs);
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
			this.asks.handleRequest(agentId, typed);
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
		await this.actions.processReplyActions(chatId, messages).catch((e) => logErr("[Feishu Bridge] process PiDeck Feishu actions failed:", e));

		// 没有标记但用户说了要做飞书文档 → 用完整回答正文自动创建
		const pendingTitle = this.pendingDocRequests.get(agentId);
		if (pendingTitle && !lastAssistant.text.includes("[CREATE_DOC:")) {
			const body = stripFeishuActionMarkers(lastAssistant.text);
			if (body) {
				await this.outbound.createFeishuDoc(chatId, pendingTitle, body).catch((e) => logErr("[Feishu Bridge] auto create doc failed:", e));
			}
		}
		this.pendingDocRequests.delete(agentId);
	}

	/** 显式标记当前会话要在 Agent 回答完后创建飞书文档 */
	trackDocRequest(agentId: string, title: string): void {
		this.sessionSync.trackDocRequest(agentId, title);
	}

	/** 由 PiDeck 宿主按当前会话绑定发送文件，避免 Agent 自己搜索群聊发错 chat。 */
	async sendFileForSession(agentId: string, filePath: string): Promise<string> {
		const chatId = this.getBestChatId(agentId);
		if (!chatId) return feishuT(this.locale, "session.unbound");
		return this.sendFeishuFile(chatId, filePath);
	}

	/** 将 PiDeck 中的用户消息转发到飞书群（双向同步：Pi → 飞书） */
	async forwardUserMessageToFeishu(agentId: string, text: string): Promise<void> {
		await this.sessionSync.forwardUserMessageToFeishu(agentId, text);
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
				channel: "feishu",
				backend: this.botBackend(),
			});
			const binding: FeishuChatBinding = {
				chatId,
				botId: this.botConfig.id,
				userId: ctx.senderOpenId,
				sessionId: session.sessionId,
				workspaceId: this.botConfig.defaultWorkspaceId ?? "",
				source: "feishu",
				backend: this.botBackend(),
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
	 *
	 * `forceNew` 表示本次是设置页把 Bot 后端换成了另一个引擎（pi ↔ dsh）：旧 sessionId/sessionPath
	 * 属于旧引擎（跨引擎没有可续的历史，模型目录也不是同一套词汇），必须真的开新会话。
	 */
	private async resumeOrCreateAgent(binding: FeishuChatBinding, options?: { forceNew?: boolean }): Promise<FeishuChatBinding | undefined> {
		const projects = this.getProjects();
		if (projects.length === 0) {
			log("[飞书 Bridge] 恢复会话失败：无可用项目");
			return undefined;
		}
		const projectId = projects[0].id;
		const forceNew = options?.forceNew === true;

		try {
			const title = binding.groupName || feishuT(this.locale, "group.defaultSession");
			let session = await this.runtimeBindings.ensureSession({
				projectId,
				title,
				existingSessionId: forceNew ? undefined : binding.sessionId,
				sessionPath: forceNew ? undefined : binding.sessionPath,
				channel: "feishu",
				// 新建会话（首次恢复失败 / 换后端）一律带上会话自己的后端：不带就默默建成 pi，
				// 让 dsh 绑定挂到 pi 会话上。已有会话命中时这个字段被忽略。
				backend: this.bindingBackend(binding),
			});
			let tab: AgentTab;
			try {
				tab = await this.runtimeBindings.activateRuntime(session.sessionId);
			} catch (error) {
				if (!binding.sessionPath) throw error;
				log(`[飞书 Bridge] sessionPath 恢复失败，创建新 Session: ${error instanceof Error ? error.message : String(error)}`);
				session = await this.runtimeBindings.ensureSession({ projectId, title, channel: "feishu", backend: this.bindingBackend(binding) });
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
			await this.sendSmartMessage(binding.chatId, feishuT(this.locale, forceNew ? "session.backendSwitched" : "session.recovered", { id: binding.sessionId.slice(0, 8), backend: this.bindingBackend(binding) === "dsh" ? "DSH" : "pi" }));
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
		return this.sessionMirror.ensureMirror(agentId, sessionTitle, sessionPath);
	}

	/** Stable Session entry used by public surfaces that already resolved the current runtime target. */
	async ensureSessionMirrorForSession(sessionId: string, agentId: string, sessionTitle?: string, sessionPath?: string): Promise<string | undefined> {
		return this.sessionMirror.ensureMirrorForSession(sessionId, agentId, sessionTitle, sessionPath);
	}

	/** Session Mirror: Agent 运行前为 Pi 侧会话打开流式卡片 */
	async startSessionMirrorRun(agentId: string, sessionTitle?: string, sessionPath?: string): Promise<void> {
		if (!this.connection.client || this.status.status !== "connected") return;

		// 该 API 的调用方传 AgentManager handle；stable ID 仅留在 binding.sessionId。
		await this.ensureSessionMirror(agentId, sessionTitle, sessionPath);

		const binding = this.sessionToChat.get(agentId) ? this.chatBindings.get(this.sessionToChat.get(agentId)!) : undefined;
		if (!binding || binding.source !== "session-mirror") return;
		if (this.streamingCards.has(agentId)) return;

		const initialState = this.newRunState();
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
			this.runCards.replayBufferedEvents(agentId, cardStream);
		} catch (e) {
			logErr("[飞书 Session Mirror] 流式卡片创建失败:", e);
			this.streamingRunStates.delete(agentId);
			this.pendingCardEvents.delete(agentId);
		}
	}

	stopSessionMirrorRun(agentId: string): void {
		this.runCards.stopSessionMirrorRun(agentId);
	}

	private async handleStopCommand(ctx: FeishuMessageContext): Promise<void> {
		// /stop 的语义是「停下来」：排队中的后续消息一并作废，不能 stop 完接着跑下一条。
		const cleared = this.pendingMessageQueues.get(ctx.chatId)?.length ?? 0;
		this.pendingMessageQueues.delete(ctx.chatId);
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
		await this.sendSmartMessage(ctx.chatId, cleared > 0 ? feishuT(this.locale, "session.stoppedWithQueue", { count: cleared }) : feishuT(this.locale, "session.stopped"));
	}

	// ===== 卡片交互回调 =====

	private async handleCardAction(event: FeishuCardActionEvent): Promise<void> {
		// 输入框提交：飞书 input 组件提交时回调携带 input_value（SDK normalize 会丢弃该字段，
		// 必须从 includeRaw 的原始事件读取）；同一 chat 至多一个待答 ask，直接作为答案写回。
		const inputAnswer = parseAskInputValue(event.raw);
		if (inputAnswer !== undefined) {
			await this.asks.handleInputSubmit(event, inputAnswer);
			return;
		}
		// ask/confirm 提问卡片按钮：优先处理，与模型切换卡片互不干扰
		const askAction = parseAskActionValue(event.action.value);
		if (askAction) {
			await this.asks.handleCardAction(event, askAction);
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

	/** 查找某 chat 最早的待答 ask（同一 chat 同时至多一个，按时间取首个防异常态）。 */
	private getPendingAskForChat(chatId: string): PendingAsk | undefined {
		return this.asks.pendingForChat(chatId);
	}

	/** 清理某 agent 的所有待答 ask（agent 结束/新任务开始时调用，避免幽灵按钮）。 */
	private clearPendingAsksForAgent(agentId: string): void {
		this.asks.clearForAgent(agentId);
	}

	// ===== 共享逻辑 =====

	private async doSetModel(chatId: string, rawId: string): Promise<void> {
		await this.commands.doSetModel(chatId, rawId);
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

	// ===== 文件发送 & 文档创建 =====

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

	// ===== 持久化 =====

	private async loadPersistedBindings(): Promise<void> {
		await this.bindings.load();
	}

	private persistBindings(): void {
		this.bindings.persist();
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
