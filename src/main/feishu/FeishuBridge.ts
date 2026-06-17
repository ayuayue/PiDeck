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
import type {
	FeishuBotConfig,
	FeishuBridgeStatus,
	FeishuChatBinding,
	FeishuChatMessage,
	FeishuTestResult,
	ImageContent,
} from "../../shared/types";
import type {
	FeishuGroupInfo,
	FeishuGroupMember,
	FeishuImageAttachment,
	FeishuFileAttachment,
	FeishuMessageContext,
	LarkSDK,
	LarkClient,
} from "./types";
import {
	listBots,
	addBot,
	removeBot,
	updateBot,
	getDecryptedBotAppSecret,
	loadBindings,
	saveBindings,
	type FeishuChatBindingPersist,
} from "./FeishuConfig";
import { chooseMessageMode, buildPostMessages, buildMarkdownCards } from "./rich-text";
import { CardStream } from "./CardStream";
import { createInitialState, reduceFromPiEvent, markInterrupted, markError, markDone, type RunState } from "./CardRunState";
import { renderRunCard } from "./CardRenderer";
import type { AgentManager } from "../pi/AgentManager";

// ===== 常量 =====
const DEDUP_MAX = 200;
const GROUP_CACHE_TTL = 3600_000;

// ===== 安全日志 =====
function safeLog(level: "log" | "warn" | "error", ...args: unknown[]): void {
	try { console[level](...args); } catch { /* EPIPE */ }
}
const log = (...args: unknown[]) => safeLog("log", ...args);
const warn = (...args: unknown[]) => safeLog("warn", ...args);
const logErr = (...args: unknown[]) => safeLog("error", ...args);

export class FeishuBridge {
	private wsClient: unknown = null;
	private client: LarkClient | null = null;
	private botConfig: FeishuBotConfig;
	private agentManager: AgentManager;
	private getWindow: () => BrowserWindow | null;
	private getProjects: () => Array<{ id: string; name: string; path: string }>;

	private status: FeishuBridgeStatus = { status: "disconnected", activeBindings: 0 };
	private botOpenId: string | null = null;
	private userOpenId: string | null = null; // 记住最近一个用户，用于自动拉群

	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectAttempts = 0;
	private readonly maxReconnectAttempts = 10;

	private recentMessageIds = new Set<string>();
	private recentEventIds = new Set<string>();
	private recentContent = new Map<string, number>();
	private processingChats = new Set<string>();

	private chatBindings = new Map<string, FeishuChatBinding>();
	private sessionToChat = new Map<string, string>();

	private groupInfoCache = new Map<string, FeishuGroupInfo>();
	private userNameCache = new Map<string, string>();

	private pendingImages = new Map<string, FeishuImageAttachment[]>();
	private pendingFiles = new Map<string, FeishuFileAttachment[]>();

	// 流式卡片：sessionId → CardStream
	private streamingCards = new Map<string, CardStream>();
	// 流式状态：sessionId → RunState
	private streamingRunStates = new Map<string, RunState>();
	// 卡片未创建时的缓存事件（并行模式下 Agent 先启动，事件暂存于此）
	private pendingCardEvents = new Map<string, unknown[]>();

	private unsubscribeLocalEvents: (() => void) | null = null;
	// 哪些 session 是飞书发起的（不需要 session mirror）
	private feishuSessions = new Set<string>();

	private lastUserMessageId = new Map<string, string>();

	constructor(
		botConfig: FeishuBotConfig,
		agentManager: AgentManager,
		getWindow: () => BrowserWindow | null,
		getProjects: () => Array<{ id: string; name: string; path: string }>,
	) {
		this.botConfig = botConfig;
		this.agentManager = agentManager;
		this.getWindow = getWindow;
		this.getProjects = getProjects;
	}

	getStatus(): FeishuBridgeStatus { return { ...this.status }; }
	listBindings(): FeishuChatBinding[] { return Array.from(this.chatBindings.values()); }

	// ===== 绑定管理 =====

	removeBinding(chatId: string): boolean {
		const binding = this.chatBindings.get(chatId);
		if (!binding) return false;
		try { this.agentManager.stop(binding.sessionId); } catch { /* ignore */ }
		this.sessionToChat.delete(binding.sessionId);
		this.feishuSessions.delete(binding.sessionId);
		this.chatBindings.delete(chatId);
		this.streamingCards.delete(binding.sessionId);
		this.streamingRunStates.delete(binding.sessionId);
		this.pendingCardEvents.delete(binding.sessionId);
		this.pendingImages.delete(chatId);
		this.pendingFiles.delete(chatId);
		this.lastUserMessageId.delete(chatId);
		this.updateStatus({ activeBindings: this.chatBindings.size });
		this.persistBindings();
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
		const { appId } = this.botConfig;
		const plainSecret = getDecryptedBotAppSecret(this.botConfig.id);
		if (!appId || !plainSecret) throw new Error("请先配置 App ID 和 App Secret");

		this.updateStatus({ status: "connecting" });

		try {
			const lark = (await import("@larksuiteoapi/node-sdk")) as unknown as LarkSDK;
			this.client = new lark.Client({
				appId, appSecret: plainSecret,
				appType: lark.AppType.SelfBuild, domain: lark.Domain.Feishu,
				loggerLevel: lark.LoggerLevel.error,
			} as Record<string, unknown>) as LarkClient;

			try {
				const botInfoResp = await this.client.request<{
					code?: number; bot?: { open_id?: string; app_name?: string };
					data?: { bot?: { open_id?: string; app_name?: string } };
				}>({ method: "GET", url: "https://open.feishu.cn/open-apis/bot/v3/info/" });
				this.botOpenId = botInfoResp?.bot?.open_id ?? botInfoResp?.data?.bot?.open_id ?? null;
				if (this.botOpenId) {
					log(`[飞书 Bridge] Bot 自身 open_id: ${this.botOpenId}`);
					// 防止用户误把 Bot 的 open_id 填成自己的
					if (this.botConfig.defaultUserOpenId === this.botOpenId) {
						warn(`[飞书 Bridge] ⚠️ 配置中的 defaultUserOpenId 是 Bot 自己的 open_id，不是你的！`);
						warn(`[飞书 Bridge] 💡 请在飞书中给 Bot 发送 /whoami 获取你的真实 open_id，然后填入配置`);
					}
				}
			} catch (e) { warn("[飞书 Bridge] 获取 Bot info 失败（非致命）:", e); }

			const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.error }).register({
				"im.message.receive_v1": async (data: unknown) => {
					await this.handleRawMessage(data as Record<string, unknown>).catch((err) =>
						logErr("[飞书 Bridge] handleRawMessage 异常:", err));
				},
				"im.message.reaction.created_v1": async () => {},
				"im.chat.member.bot.added_v1": async () => {},
				"card.action.trigger": async (data: unknown) => this.handleCardAction(data as Record<string, unknown>),
			});

			const ws = new lark.WSClient({
				appId, appSecret: plainSecret, domain: lark.Domain.Feishu, loggerLevel: lark.LoggerLevel.error,
			});
			this.wsClient = ws;
			ws.start({ eventDispatcher: dispatcher });
			log("[飞书 Bridge] WSClient 已启动");

			this.reconnectAttempts = 0;
			this.unsubscribeLocalEvents = this.agentManager.addLocalEventListener(
				(agentId, event) => this.handleAgentEvent(agentId, event),
			);
			this.loadPersistedBindings();
			this.updateStatus({ status: "connected", activeBindings: this.chatBindings.size, connectedAt: Date.now(), botOpenId: this.botOpenId ?? undefined });
			log("[飞书 Bridge] 已连接");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.updateStatus({ status: "error", errorMessage: message });
			logErr("[飞书 Bridge] 启动失败:", error);
			this.scheduleReconnect(); throw error;
		}
	}

	stop(): void {
		if (this.unsubscribeLocalEvents) { this.unsubscribeLocalEvents(); this.unsubscribeLocalEvents = null; }
		for (const [, card] of this.streamingCards) { card.close().catch(() => {}); }
		this.streamingCards.clear();
		this.streamingRunStates.clear();
		this.pendingCardEvents.clear();

		const ws = this.wsClient as { stop?: () => void } | null;
		if (ws?.stop) try { ws.stop(); } catch {}
		if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
		this.wsClient = null; this.client = null;
		this.chatBindings.clear(); this.sessionToChat.clear(); this.feishuSessions.clear();
		this.pendingImages.clear(); this.pendingFiles.clear();
		this.recentMessageIds.clear(); this.recentEventIds.clear(); this.recentContent.clear();
		this.processingChats.clear(); this.lastUserMessageId.clear();
		this.groupInfoCache.clear(); this.userNameCache.clear(); this.botOpenId = null;
		this.updateStatus({ status: "disconnected", activeBindings: 0 });
		log("[飞书 Bridge] 已停止");
	}

	// ===== 配置热更新 =====

	/** 运行时更新 botConfig（用于用户在面板编辑 open_id 后无需重连） */
	updateBotConfig(patch: Partial<FeishuBotConfig>): void {
		this.botConfig = { ...this.botConfig, ...patch };
		log("[飞书 Bridge] 配置已热更新:", Object.keys(patch).join(", "));
	}

	// ===== 测试连接 =====

	async testConnection(appId: string, appSecret: string): Promise<FeishuTestResult> {
		try {
			const lark = (await import("@larksuiteoapi/node-sdk")) as unknown as LarkSDK;
			const client = new lark.Client({ appId, appSecret, appType: lark.AppType.SelfBuild } as Record<string, unknown>) as LarkClient;
			const resp = await client.auth.tenantAccessToken.internal({ data: { app_id: appId, app_secret: appSecret } });
			if ((resp as Record<string, unknown>).code === 0) return { success: true, message: "连接成功！", botName: `App ${appId.slice(0, 8)}...` };
			return { success: false, message: `飞书 API 错误: ${(resp as Record<string, unknown>).msg ?? "未知错误"}` };
		} catch (error) {
			return { success: false, message: `连接失败: ${error instanceof Error ? error.message : String(error)}` };
		}
	}

	// ===== 卡片交互回调 =====

	private async handleCardAction(data: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
		const actionValue = (data as { action?: { value?: unknown } })?.action?.value;
		if (!actionValue || typeof actionValue !== "object") return undefined;
		const value = actionValue as Record<string, unknown>;
		// 目前无卡片按钮交互需求（停止命令走 /stop）
		return undefined;
	}

	// ===== 闪电确认 =====

	/** ⚡ 闪电确认：收到消息后立即 fire-and-forget 一条 text 回复，让用户感知 Bot 已响应 */
	private async sendLightningConfirm(chatId: string, replyToMessageId?: string): Promise<void> {
		if (!this.client) return;
		try {
			if (replyToMessageId) {
				await this.client.im.message.reply({
					path: { message_id: replyToMessageId },
					data: { msg_type: "text", content: JSON.stringify({ text: "⚡ 已收到" }) },
				});
			} else {
				await this.client.im.message.create({
					params: { receive_id_type: "chat_id" },
					data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: "⚡ 已收到" }) },
				});
			}
		} catch { /* fire-and-forget */ }
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
		if (!this.client) return;
		const eventId = data.event_id as string | undefined;
		if (eventId && this.recentEventIds.has(eventId)) return;
		if (eventId) { this.recentEventIds.add(eventId); if (this.recentEventIds.size > DEDUP_MAX) this.recentEventIds.delete(this.recentEventIds.values().next().value as string); }

		const message = (data as { message?: Record<string, unknown> }).message;
		if (!message) return;
		const sender = (data as { sender?: Record<string, unknown> }).sender;
		if ((sender?.sender_type as string) !== "user") return;

		const messageId = message.message_id as string;
		if (messageId && this.recentMessageIds.has(messageId)) return;
		if (messageId) { this.recentMessageIds.add(messageId); if (this.recentMessageIds.size > DEDUP_MAX) this.recentMessageIds.delete(this.recentMessageIds.values().next().value as string); }

		const chatId = message.chat_id as string;
		const messageType = message.message_type as string;
		const chatType = message.chat_type as string;
		const userId = (sender?.sender_id as Record<string, unknown>)?.open_id as string ?? "unknown";
		const mentions = message.mentions as Array<{ name: string; id: string | { open_id: string; union_id: string; user_id: string } }> | undefined;

		// 记住用户 open_id（用于自动拉群）
		if (userId && userId !== "unknown") this.userOpenId = userId;

		if (this.processingChats.has(chatId)) { log(`[飞书 Bridge] 跳过重入消息: ${chatId}`); return; }
		this.processingChats.add(chatId);

		try {
			if (chatType === "group" && this.botConfig.requireMention !== false && !this.isBotMentioned(mentions)) return;
			if (chatType === "group" && messageId) this.lastUserMessageId.set(chatId, messageId);

			const supportedTypes = new Set(["text", "image", "post", "file"]);
			if (!supportedTypes.has(messageType)) { log(`[飞书 Bridge] 不支持的消息类型: ${messageType}`); return; }

			let text = "";
			const imageAttachments: FeishuImageAttachment[] = [];
			const fileAttachments: FeishuFileAttachment[] = [];

			if (messageType === "text") {
				const content = JSON.parse(message.content as string) as { text?: string };
				text = (content.text ?? "").replace(/@_user_\d+/g, "").trim();
			} else if (messageType === "post") {
				const content = JSON.parse(message.content as string) as { title?: string; content?: Array<Array<{ tag: string; text?: string }>> };
				const parts: string[] = [];
				if (content.title) parts.push(content.title);
				for (const line of content.content ?? []) for (const node of line) if (node.tag === "text" && node.text) parts.push(node.text);
				text = parts.join(" ").replace(/@_user_\d+/g, "").trim();
			} else if (messageType === "image") {
				const content = JSON.parse(message.content as string) as { image_key?: string };
				if (content.image_key) { try { const imgData = await this.downloadImage(messageId, content.image_key); imageAttachments.push({ imageKey: content.image_key, data: imgData, mediaType: this.inferImageMediaType(imgData) }); } catch (e) { logErr("[飞书 Bridge] 下载图片失败:", e); await this.sendSmartMessage(chatId, "⚠️ 图片下载失败，请重试。"); return; } }
			} else if (messageType === "file") {
				const content = JSON.parse(message.content as string) as { file_key?: string; file_name?: string };
				if (content.file_key) { try { const fileData = await this.downloadFile(messageId, content.file_key); if (fileData.length > 50 * 1024 * 1024) { await this.sendSmartMessage(chatId, "文件过大（超过 50MB），暂不支持处理。"); return; } fileAttachments.push({ fileKey: content.file_key, fileName: content.file_name || `feishu-${content.file_key}`, data: fileData }); } catch (e) { logErr("[飞书 Bridge] 下载文件失败:", e); await this.sendSmartMessage(chatId, "⚠️ 文件下载失败，请重试。"); return; } }
			}

			if (!text && (imageAttachments.length > 0 || fileAttachments.length > 0)) {
				if (imageAttachments.length > 0) { const existing = this.pendingImages.get(chatId) ?? []; existing.push(...imageAttachments); this.pendingImages.set(chatId, existing); }
				if (fileAttachments.length > 0) { const existing = this.pendingFiles.get(chatId) ?? []; existing.push(...fileAttachments); this.pendingFiles.set(chatId, existing); }
				const parts: string[] = []; const ic = this.pendingImages.get(chatId)?.length ?? 0; const fc = this.pendingFiles.get(chatId)?.length ?? 0;
				if (ic > 0) parts.push(`${ic} 张图片`); if (fc > 0) parts.push(`${fc} 个文件`);
				await this.sendSmartMessage(chatId, `已收到${parts.join("和")}，请继续发送文字消息来触发处理。`);
				return;
			}

			if (text && this.pendingImages.has(chatId)) { imageAttachments.unshift(...this.pendingImages.get(chatId)!); this.pendingImages.delete(chatId); }
			if (text && this.pendingFiles.has(chatId)) { fileAttachments.unshift(...this.pendingFiles.get(chatId)!); this.pendingFiles.delete(chatId); }
			if (!text && imageAttachments.length === 0 && fileAttachments.length === 0) return;

			let groupName: string | undefined; let senderName: string | undefined;
			if (chatType === "group") { const [gi, un] = await Promise.all([this.getGroupInfo(chatId), this.getUserName(userId)]); groupName = gi?.name; senderName = un; }

			const msgCtx: FeishuMessageContext = { chatId, senderOpenId: userId, senderName, messageId, chatType: chatType as "p2p" | "group", groupName };

			if (text.startsWith("/")) { await this.handleCommand(msgCtx, text); return; }

			const dedupParts = [chatId, userId, text];
			if (imageAttachments.length > 0) dedupParts.push("img", ...imageAttachments.map((a) => a.imageKey));
			if (fileAttachments.length > 0) dedupParts.push("file", ...fileAttachments.map((f) => f.fileKey));
			const contentKey = dedupParts.join("\u0000");
			const lastTime = this.recentContent.get(contentKey);
			if (lastTime && Date.now() - lastTime <= 5000) { log(`[飞书 Bridge] 重复内容已跳过: ${text.slice(0, 50)}`); return; }
			this.recentContent.set(contentKey, Date.now());
			if (this.recentContent.size > 2000) this.recentContent.delete(this.recentContent.keys().next().value as string);

			log(`[飞书 Bridge] 准备调用 Agent: ${chatId}, "${text.slice(0, 60)}", images=${imageAttachments.length}`);

			// ⚡ 闪电确认：fire-and-forget，不等待
			const replyToMsgId = chatType === "group" ? messageId : undefined;
			void this.sendLightningConfirm(chatId, replyToMsgId).catch(() => {});

			await this.runAgent(msgCtx, text, imageAttachments, fileAttachments);
		} finally { this.processingChats.delete(chatId); }
	}

	// ===== 命令处理 =====

	private async handleCommand(ctx: FeishuMessageContext, text: string): Promise<void> {
		const { chatId, senderOpenId: userId } = ctx;
		const [command] = text.split(/\s+/);
		switch (command?.toLowerCase()) {
			case "/help": case "/h": await this.sendHelpCard(chatId); break;
			case "/new": case "/n": await this.createNewSession(ctx); break;
			case "/stop": case "/s": await this.handleStopCommand(ctx); break;
			case "/status": await this.handleStatusCommand(ctx); break;
			case "/whoami":
				await this.sendSmartMessage(chatId,
					`你的 open_id: \`${userId}\`\n\n📋 你可以将此 ID 填入 PiDeck 飞书配置中的「你的 Open ID」字段，以便新建会话时自动拉你进群。`
				);
				break;
			default: await this.sendSmartMessage(chatId, `未知命令: ${command}。输入 /help 查看帮助。`);
		}
	}

	// ===== Agent 执行（流式卡片 + 并行优化） =====

	private async runAgent(ctx: FeishuMessageContext, text: string, imageAttachments: FeishuImageAttachment[], fileAttachments: FeishuFileAttachment[]): Promise<void> {
		const { chatId } = ctx;
		let binding = this.chatBindings.get(chatId);
		if (!binding) { await this.createNewSession(ctx); binding = this.chatBindings.get(chatId); if (!binding) return; }

		// 关闭已有流式卡片
		const existingCard = this.streamingCards.get(binding.sessionId);
		if (existingCard) { await existingCard.flush(markInterrupted(createInitialState())).catch(() => {}); await existingCard.close().catch(() => {}); this.streamingCards.delete(binding.sessionId); this.streamingRunStates.delete(binding.sessionId); }
		this.pendingCardEvents.delete(binding.sessionId);

		// 图片 → ImageContent (base64)
		const images: ImageContent[] = imageAttachments.map((att) => ({ type: "image" as const, data: att.data.toString("base64"), mimeType: att.mediaType }));
		let finalText = text;
		if (fileAttachments.length > 0) { const names = fileAttachments.map((f) => f.fileName).join(", "); finalText = finalText ? `${finalText}\n\n[附件: ${names}]` : `处理以下文件: ${names}`; }

		// 🔥 立即初始化状态机 + 缓存队列（卡片可能尚未创建）
		const initialState = createInitialState();
		this.streamingRunStates.set(binding.sessionId, initialState);
		this.pendingCardEvents.set(binding.sessionId, []);

		const prefix = ctx.chatType === "group" && ctx.groupName ? `${ctx.groupName}` : "";
		const runningHeader = prefix ? `${prefix} · Agent 处理中` : "Agent 处理中";

		// 🔥 并行启动：CardStream 创建 + Agent 推理（互不阻塞）
		const cardPromise = CardStream.open(
			this.client!, chatId,
			renderRunCard(initialState, { header: runningHeader, stopHint: "发送 /stop 可终止当前任务" }),
			{ replyToMessageId: ctx.chatType === "group" ? ctx.messageId : undefined },
		).catch((e) => { logErr("[飞书 Bridge] 流式卡片创建失败:", e); return null as CardStream | null; });

		try {
			// Agent 先行启动（不等待卡片创建完成）
			await this.agentManager.sendPrompt({ agentId: binding.sessionId, message: finalText, ...(images.length > 0 ? { images } : {}) });
		} catch (e) {
			// sendPrompt 失败 → 清理状态
			this.streamingRunStates.delete(binding.sessionId);
			this.pendingCardEvents.delete(binding.sessionId);
			this.streamingCards.delete(binding.sessionId);
			throw e;
		}

		// 等待卡片创建完成，回放缓存事件
		const cardStream = await cardPromise;
		const hasCard = cardStream !== null;
		if (cardStream) {
			this.streamingCards.set(binding.sessionId, cardStream);
			this.replayBufferedEvents(binding.sessionId, cardStream, runningHeader);
		} else {
			this.pendingCardEvents.delete(binding.sessionId);
			await this.sendSmartMessage(chatId, "🔄 Agent 处理中...");
		}

		const startTime = Date.now();

		try {
			// agent_end 事件会在 handleAgentEvent 中 flush 终态卡片
			await this.waitForAgentEnd(binding.sessionId, 300_000);

			// 如果流式卡片已创建，结果已展示在卡片中，无需额外发送
			if (hasCard) {
				// 清理可能残留的状态（handleAgentEvent 已处理大部分）
				this.streamingCards.delete(binding.sessionId);
				this.streamingRunStates.delete(binding.sessionId);
				this.pendingCardEvents.delete(binding.sessionId);
			} else {
				// 降级：无流式卡片，用文本消息发送最终结果
				const messages = this.agentManager.getMessages(binding.sessionId);
				const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
				const resultText = lastAssistant?.text ?? "";
				this.streamingRunStates.delete(binding.sessionId);
				this.pendingCardEvents.delete(binding.sessionId);
				if (resultText.trim()) {
					const duration = ((Date.now() - startTime) / 1000).toFixed(1);
					await this.sendSmartMessage(chatId, `${resultText}\n\n---\n⏱ ${duration}s`);
				}
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			const errState = markError(createInitialState(), msg.slice(0, 96));
			const finalCardStream = this.streamingCards.get(binding.sessionId);
			if (finalCardStream) {
				await finalCardStream.flush(renderRunCard(errState, { header: "❌ 失败" })).catch(() => {});
				await finalCardStream.close().catch(() => {});
				this.streamingCards.delete(binding.sessionId);
			}
			this.streamingRunStates.delete(binding.sessionId);
			this.pendingCardEvents.delete(binding.sessionId);
			await this.sendSmartMessage(chatId, `❌ Agent 错误: ${msg}`);
		}
	}

	/** 回放卡片创建期间缓存的 Agent 事件 */
	private replayBufferedEvents(sessionId: string, cardStream: CardStream, headerTitle: string): void {
		const pending = this.pendingCardEvents.get(sessionId);
		if (!pending || pending.length === 0) { this.pendingCardEvents.delete(sessionId); return; }

		log(`[飞书 Bridge] 回放 ${pending.length} 个缓存事件到卡片`);
		let currentState = this.streamingRunStates.get(sessionId) ?? createInitialState();
		for (const ev of pending) {
			const nextState = reduceFromPiEvent(currentState, ev as Record<string, unknown>);
			if (nextState !== currentState) {
				currentState = nextState;
				this.streamingRunStates.set(sessionId, nextState);
				cardStream.update(renderRunCard(nextState, {
					header: headerTitle,
					stopHint: nextState.terminal === "running" ? "发送 /stop 可终止当前任务" : undefined,
				}));
			}
		}
		this.pendingCardEvents.delete(sessionId);
	}

	private waitForAgentEnd(sessionId: string, timeoutMs: number): Promise<void> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => { cleanup(); resolve(); }, timeoutMs);
			const handler = (agentId: string, event: unknown) => {
				if (agentId !== sessionId) return;
				if (!event || typeof event !== "object") return;
				if ((event as Record<string, unknown>).type === "agent_end") { cleanup(); resolve(); }
			};
			const unsub = this.agentManager.addLocalEventListener(handler);
			const cleanup = () => { clearTimeout(timer); unsub(); };
		});
	}

	// ===== Agent 事件处理（流式卡片 + Session Mirror） =====

	private handleAgentEvent(agentId: string, event: unknown): void {
		if (!event || typeof event !== "object") return;
		const typed = event as Record<string, unknown>;

		// ==== 流式状态更新（无论卡片是否就绪都更新 runState）====
		const runState = this.streamingRunStates.get(agentId);
		if (runState) {
			const nextState = reduceFromPiEvent(runState, typed);
			if (nextState !== runState) {
				this.streamingRunStates.set(agentId, nextState);
			}

			// 卡片更新或事件缓存
			const cardStream = this.streamingCards.get(agentId);
			if (cardStream) {
				// 卡片已就绪 → 直接更新
				const chatId = this.sessionToChat.get(agentId) ?? "";
				const prefix = this.chatBindings.get(chatId)?.groupName ?? "";
				const headerTitle = (prefix ? `${prefix} · ` : "") + (nextState.terminal === "running" ? "Agent 处理中" : "✅ 完成");

				const card = renderRunCard(nextState, { header: headerTitle, stopHint: nextState.terminal === "running" ? "发送 /stop 可终止当前任务" : undefined });
				if (nextState.terminal === "running") {
					cardStream.update(card);
				} else {
					// 终态：强制 flush + close
					void cardStream.flush(card).then(() => cardStream.close()).catch(() => {});
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

		// ==== Session Mirror: Pi 侧会话 → 飞书实时同步 ====
		if (!this.feishuSessions.has(agentId) && typed.type === "agent_end") {
			// 非飞书发起的 session 完成 → 同步结果到飞书
			const chatId = this.sessionToChat.get(agentId);
			if (chatId && this.client) {
				this.syncPiMessageToFeishu(agentId, chatId).catch((e) =>
					logErr("[飞书 Bridge] 同步 Pi 消息到飞书失败:", e));
			}
		}
	}

	/** 将 Pi Agent 回复同步到飞书（带去重，避免同一结果重复推送） */
	private async syncPiMessageToFeishu(agentId: string, chatId: string): Promise<void> {
		if (!this.client) return;
		const messages = this.agentManager.getMessages(agentId);
		const assistantMessages = messages.filter((m) => m.role === "assistant");
		const lastAssistant = assistantMessages.pop();
		if (!lastAssistant?.text?.trim()) return;

		// 去重：用最后一条 assistant 消息的 id + text 前50字符做指纹
		const fingerprint = `${lastAssistant.id}|${lastAssistant.text.slice(0, 50)}`;
		const syncedFingerprints = (this as Record<string, unknown>).__feishuSyncFp as Set<string> | undefined;
		if (syncedFingerprints?.has(fingerprint)) return;

		if (!syncedFingerprints) {
			(this as Record<string, unknown>).__feishuSyncFp = new Set<string>();
		}
		((this as Record<string, unknown>).__feishuSyncFp as Set<string>).add(fingerprint);

		await this.sendSmartMessage(chatId, lastAssistant.text);
	}

	/** 将 PiDeck 中的用户消息转发到飞书群（双向同步：Pi → 飞书） */
	async forwardUserMessageToFeishu(agentId: string, text: string): Promise<void> {
		if (!this.client || !text.trim()) return;
		const chatId = this.sessionToChat.get(agentId);
		if (!chatId) {
			// 没有绑定，尝试创建 session mirror
			const tab = this.agentManager.list().find(t => t.id === agentId);
			if (tab) {
				await this.ensureSessionMirror(agentId, tab.title);
			}
			return;
		}
		// 带上 PiDeck 标识，方便在飞书中区分消息来源
		await this.sendSmartMessage(chatId, `💻 **PiDeck**:\n${text}`);
	}

	// ===== 会话管理 =====

	private async createNewSession(ctx: FeishuMessageContext, _title?: string): Promise<void> {
		const { chatId } = ctx;
		const projects = this.getProjects();
		if (projects.length === 0) { await this.sendSmartMessage(chatId, "❌ 请先在 PiDeck 中添加项目（工作区），然后重试。"); return; }
		const projectId = projects[0].id;

		try {
			const tab = await this.agentManager.create({ projectId });
			const binding: FeishuChatBinding = {
				chatId, botId: this.botConfig.id, userId: ctx.senderOpenId, sessionId: tab.id,
				workspaceId: this.botConfig.defaultWorkspaceId ?? "", source: "feishu", chatType: ctx.chatType,
				groupName: ctx.groupName, createdAt: Date.now(),
			};
			this.chatBindings.set(chatId, binding);
			this.sessionToChat.set(tab.id, chatId);
			this.feishuSessions.add(tab.id);
			this.updateStatus({ activeBindings: this.chatBindings.size });
			this.persistBindings();
			await this.sendSmartMessage(chatId, `✅ 已创建会话 (${tab.id.slice(0, 8)})`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			await this.sendSmartMessage(chatId, `❌ 创建会话失败: ${msg}`);
		}
	}

	/** Session Mirror: Pi 侧创建会话时自动拉群（1会话=1群） */
	async ensureSessionMirror(sessionId: string, sessionTitle?: string): Promise<string | undefined> {
		if (!this.client || this.status.status !== "connected") {
			log("[飞书 Session Mirror] Bridge 未连接，跳过自动拉群");
			return undefined;
		}

		const groupName = `Pi Agent - ${(sessionTitle || `新会话 ${sessionId.slice(0, 8)}`).slice(0, 50)}`;

		// 1. 先按 sessionId 找已有绑定
		let existingChatId = this.sessionToChat.get(sessionId);

		// 2. sessionId 没匹配 → 按 groupName 在所有绑定中搜索（重启后 sessionId 可能变）
		if (!existingChatId) {
			for (const [chatId, binding] of this.chatBindings) {
				if (binding.groupName === groupName && binding.source === "session-mirror") {
					log(`[飞书 Session Mirror] 按群名匹配到已有群: ${groupName} → ${chatId}`);
					existingChatId = chatId;
					// 更新 sessionId 映射
					this.sessionToChat.set(sessionId, chatId);
					// 更新绑定中的 sessionId
					binding.sessionId = sessionId;
					this.persistBindings();
					break;
				}
			}
		}

		// 3. 已有绑定：检查是否需要修复空群
		if (existingChatId) {
			const effectiveUserOpenId = this.botConfig.defaultUserOpenId || this.userOpenId;
			if (effectiveUserOpenId) {
				const binding = this.chatBindings.get(existingChatId);
				if (binding && !binding.userId) {
					log(`[飞书 Session Mirror] 检测到空群 ${existingChatId}，尝试补加用户 ${effectiveUserOpenId}`);
					await this.repairEmptyGroup(existingChatId, effectiveUserOpenId).catch(() => {});
					binding.userId = effectiveUserOpenId;
					this.persistBindings();
				}
			}
			return existingChatId;
		}

		// 4. 完全没匹配 → 创建新群
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
				name: groupName, chat_mode: "group", chat_type: "private", external: false,
			};
			if (effectiveUserOpenId) {
				chatData.user_id_list = [effectiveUserOpenId];
			}

			const resp = await this.client.im.chat.create({
				data: chatData,
				params: { user_id_type: "open_id" },
			});

			// 兼容多种 Lark SDK 响应格式
			const respAny = resp as Record<string, unknown>;
			const chatId = (respAny?.data as Record<string, unknown>)?.chat_id as string
				?? respAny?.chat_id as string
				?? undefined;
			if (!chatId) {
				logErr("[飞书 Session Mirror] 创建群未返回 chat_id, 原始响应:", JSON.stringify(resp).slice(0, 200));
				return undefined;
			}

			log(`[飞书 Session Mirror] 群创建成功: chatId=${chatId}, 成员数=${effectiveUserOpenId ? 2 : 1}`);

			// 创建绑定
			const binding: FeishuChatBinding = {
				chatId, botId: this.botConfig.id, userId: effectiveUserOpenId ?? "",
				sessionId, workspaceId: this.botConfig.defaultWorkspaceId ?? "",
				source: "session-mirror" as const, chatType: "group", groupName, createdAt: Date.now(),
			};
			this.chatBindings.set(chatId, binding);
			this.sessionToChat.set(sessionId, chatId);
			this.updateStatus({ activeBindings: this.chatBindings.size });
			this.persistBindings();

			await this.sendSmartMessage(chatId, `🤖 Pi Agent 会话已创建\n会话 ID: ${sessionId.slice(0, 8)}\n\n直接发消息即可与 Agent 对话。`);
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
		if (!this.client) return;
		try {
			await this.client.im.chat.members.add({
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
	async startSessionMirrorRun(sessionId: string, sessionTitle?: string): Promise<void> {
		if (!this.client || this.status.status !== "connected") return;

		// 确保有群
		await this.ensureSessionMirror(sessionId, sessionTitle);

		const binding = this.sessionToChat.get(sessionId)
			? this.chatBindings.get(this.sessionToChat.get(sessionId)!)
			: undefined;
		if (!binding || binding.source !== "session-mirror") return;
		if (this.streamingCards.has(sessionId)) return;

		const initialState = createInitialState();
		this.streamingRunStates.set(sessionId, initialState);

		const headerTitle = `${binding.groupName ?? `Pi Agent`} · Agent 处理中`;
		try {
			const cardStream = await CardStream.open(this.client!, binding.chatId, renderRunCard(initialState, { header: headerTitle, stopHint: "发送 /stop 可终止当前任务" }));
			this.streamingCards.set(sessionId, cardStream);
		} catch (e) {
			logErr("[飞书 Session Mirror] 流式卡片创建失败:", e);
			this.streamingRunStates.delete(sessionId);
		}
	}

	stopSessionMirrorRun(sessionId: string): void {
		const state = this.streamingRunStates.get(sessionId);
		const card = this.streamingCards.get(sessionId);
		if (state && card) {
			const finalState = markInterrupted(state);
			void card.flush(renderRunCard(finalState)).then(() => card.close()).catch(() => {});
		}
		this.streamingCards.delete(sessionId);
		this.streamingRunStates.delete(sessionId);
		this.pendingCardEvents.delete(sessionId);
	}

	private async handleStopCommand(ctx: FeishuMessageContext): Promise<void> {
		const binding = this.chatBindings.get(ctx.chatId);
		if (!binding) { await this.sendSmartMessage(ctx.chatId, "当前没有绑定的会话。"); return; }

		// 关闭流式卡片
		const state = this.streamingRunStates.get(binding.sessionId);
		const card = this.streamingCards.get(binding.sessionId);
		if (state && card) {
			void card.flush(renderRunCard(markInterrupted(state))).then(() => card.close()).catch(() => {});
			this.streamingCards.delete(binding.sessionId);
			this.streamingRunStates.delete(binding.sessionId);
			this.pendingCardEvents.delete(binding.sessionId);
		}

		await this.agentManager.abort(binding.sessionId);
		await this.sendSmartMessage(ctx.chatId, "⏹ 已停止 Agent");
	}

	private async handleStatusCommand(ctx: FeishuMessageContext): Promise<void> {
		const binding = this.chatBindings.get(ctx.chatId);
		const lines = ["**飞书 Bridge 状态**", `状态: ${this.status.status}`, `绑定数: ${this.chatBindings.size}`, binding ? `会话: ${binding.sessionId.slice(0, 8)}` : "会话: 未绑定"];
		await this.sendCardMessage(ctx.chatId, { config: { wide_screen_mode: true, update_multi: true }, header: { title: { tag: "plain_text", content: "当前状态" }, template: "blue" }, elements: [{ tag: "markdown", content: lines.join("\n") }] });
	}

	// ===== 飞书消息发送（智能模式） =====

	private async sendSmartMessage(chatId: string, text: string): Promise<void> {
		if (!this.client) return;
		const mode = chooseMessageMode(text);
		try {
			if (mode === "interactive") {
				for (const card of buildMarkdownCards(text)) {
					await this.client.im.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) } });
				}
			} else if (mode === "post") {
				for (const post of buildPostMessages(text)) {
					await this.client.im.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: chatId, msg_type: "post", content: JSON.stringify(post) } });
				}
			} else {
				await this.client.im.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) } });
			}
		} catch (e) { logErr("[飞书 Bridge] 发送消息失败:", e); }
	}

	private async sendCardMessage(chatId: string, card: Record<string, unknown>): Promise<void> {
		if (!this.client) return;
		try { await this.client.im.message.create({ params: { receive_id_type: "chat_id" }, data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify(card) } }); } catch (e) { logErr("[飞书 Bridge] 发送卡片失败:", e); }
	}

	private async sendHelpCard(chatId: string): Promise<void> {
		await this.sendCardMessage(chatId, {
			config: { wide_screen_mode: true, update_multi: true },
			header: { title: { tag: "plain_text", content: "🤖 Pi Agent 帮助" }, template: "green" },
			elements: [{ tag: "markdown", content: ["**可用命令**", "", "`/new` 或 `/n` — 创建新会话", "`/stop` 或 `/s` — 停止当前 Agent", "`/status` — 查看当前状态", "`/whoami` — 查看你的 open_id（用于自动拉群配置）", "`/help` 或 `/h` — 查看帮助", "", "直接发送文字消息即可与 Agent 对话。", "", "💡 **Pi 中创建会话时，飞书自动拉群**", "在 PiDeck 中新建会话后，飞书会自动创建一个群聊。", "如需自动拉你进群，请先配置「你的 Open ID」（发 /whoami 获取）。"].join("\n") }],
		});
	}

	// ===== 图片/文件下载 =====

	private async downloadImage(messageId: string, imageKey: string): Promise<Buffer> {
		if (!this.client) throw new Error("飞书 Client 未初始化");
		try { return await this.downloadMessageResource(messageId, imageKey, "image"); } catch { warn("[飞书 Bridge] messageResource 失败，回退到 image.get"); }
		return this.downloadViaImageGet(imageKey);
	}
	private async downloadMessageResource(messageId: string, fileKey: string, type: "image" | "file"): Promise<Buffer> {
		const resp = this.client!.im.messageResource.get({ path: { message_id: messageId, file_key: fileKey }, params: { type } });
		return this.streamToBuffer(resp);
	}
	private async downloadViaImageGet(imageKey: string): Promise<Buffer> {
		const resp = await this.client!.request({ method: "GET", url: `https://open.feishu.cn/open-apis/im/v1/images/${imageKey}` });
		return this.streamToBuffer(resp);
	}
	private async downloadFile(messageId: string, fileKey: string): Promise<Buffer> { return this.downloadMessageResource(messageId, fileKey, "file"); }

	private async streamToBuffer(result: unknown): Promise<Buffer> {
		const resp = result as Record<string, unknown>;
		if (typeof resp?.getReadableStream === "function") { const chunks: Buffer[] = []; const readable = (resp.getReadableStream as () => NodeJS.ReadableStream)(); for await (const chunk of readable as AsyncIterable<Buffer | string>) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); } return Buffer.concat(chunks); }
		if (typeof (result as AsyncIterable<unknown>)?.[Symbol.asyncIterator] === "function") { const chunks: Buffer[] = []; for await (const chunk of result as AsyncIterable<Buffer | string>) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); } return Buffer.concat(chunks); }
		if (typeof resp?.writeFile === "function") { const { readFileSync, unlinkSync } = await import("node:fs"); const tmp = `/tmp/feishu-dl-${Date.now()}.tmp`; await (resp.writeFile as (p: string) => Promise<void>)(tmp); const data = readFileSync(tmp); try { unlinkSync(tmp); } catch {} return data; }
		logErr("[飞书 Bridge] streamToBuffer 未知格式:", typeof result); throw new Error("无法读取飞书文件流");
	}

	// ===== 群聊辅助 =====

	private isBotMentioned(mentions: Array<{ name: string; id: string | { open_id: string; union_id: string; user_id: string } }> | undefined): boolean {
		if (!mentions || mentions.length === 0) return false;
		for (const m of mentions) { const openId = typeof m.id === "string" ? m.id : m.id.open_id; if (openId === "all") continue; if (openId === this.botOpenId) return true; }
		return false;
	}

	private async getGroupInfo(chatId: string): Promise<FeishuGroupInfo | null> {
		const cached = this.groupInfoCache.get(chatId);
		if (cached && Date.now() - cached.cachedAt < GROUP_CACHE_TTL) return cached;
		if (!this.client) return null;
		try {
			const [chatResp, members] = await Promise.all([this.client.im.chat.get({ path: { chat_id: chatId } }), this.fetchGroupMembers(chatId)]);
			const name = (chatResp as { data?: { name?: string } }).data?.name ?? "未知群组";
			const info: FeishuGroupInfo = { chatId, name, members, cachedAt: Date.now() };
			this.groupInfoCache.set(chatId, info); return info;
		} catch (e) { warn("[飞书 Bridge] 获取群聊信息失败:", e); return null; }
	}

	private async fetchGroupMembers(chatId: string): Promise<FeishuGroupMember[]> {
		if (!this.client) return [];
		try {
			const resp = await this.client.im.chat.members.get({ path: { chat_id: chatId }, params: { user_id_type: "open_id", page_size: 100 } });
			return ((resp as { data?: { items?: Array<{ open_id: string; name?: string }> } }).data?.items ?? []).map((m) => ({ openId: m.open_id, name: m.name ?? m.open_id }));
		} catch (e) { warn("[飞书 Bridge] 获取群成员失败:", e); return []; }
	}

	private async getUserName(userId: string): Promise<string> {
		const cached = this.userNameCache.get(userId);
		if (cached) return cached;
		this.userNameCache.set(userId, userId); return userId;
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

	private loadPersistedBindings(): void {
		const bindings = loadBindings(this.botConfig.id);
		for (const b of bindings) {
			const tabs = this.agentManager.list();
			let tab = tabs.find((t) => t.id === b.sessionId);

			// sessionId 不匹配当前 tab → 尝试按群名匹配（重启后 sessionId 可能变）
			if (!tab && b.groupName && b.source === "session-mirror") {
				for (const t of tabs) {
					const expectedName = `Pi Agent - ${(t.title || `新会话 ${t.id.slice(0, 8)}`).slice(0, 50)}`;
					if (expectedName === b.groupName) {
						tab = t;
						log(`[飞书 Bridge] 按群名恢复绑定: ${b.groupName} → sessionId ${t.id}`);
						break;
					}
				}
			}

			if (tab) {
				const binding: FeishuChatBinding = {
					chatId: b.chatId, botId: b.botId, userId: b.userId, sessionId: tab.id,
					workspaceId: b.workspaceId, channelId: b.channelId, modelId: b.modelId,
					source: b.source as "feishu" | "session-mirror", chatType: b.chatType as "p2p" | "group",
					groupName: b.groupName, createdAt: b.createdAt,
				};
				this.chatBindings.set(b.chatId, binding);
				this.sessionToChat.set(tab.id, b.chatId);
				if (b.source === "feishu" || b.source === "session-mirror") this.feishuSessions.add(tab.id);
			} else {
				// session-mirror 绑定：即使没有匹配的 tab 也保留，后续 ensureSessionMirror 会处理
				if (b.source === "session-mirror") {
					log(`[飞书 Bridge] 保留无主绑定（等后续匹配）: ${b.groupName ?? b.chatId}`);
					const binding: FeishuChatBinding = {
						chatId: b.chatId, botId: b.botId, userId: b.userId, sessionId: b.sessionId,
						workspaceId: b.workspaceId, channelId: b.channelId, modelId: b.modelId,
						source: b.source as "feishu" | "session-mirror", chatType: b.chatType as "p2p" | "group",
						groupName: b.groupName, createdAt: b.createdAt,
					};
					this.chatBindings.set(b.chatId, binding);
				}
			}
		}
		if (this.chatBindings.size > 0) log(`[飞书 Bridge] 已恢复 ${this.chatBindings.size} 个聊天绑定`);
		this.updateStatus({ activeBindings: this.chatBindings.size });
	}

	private persistBindings(): void {
		const bindings: FeishuChatBindingPersist[] = Array.from(this.chatBindings.values()).map((b) => ({
			chatId: b.chatId, botId: b.botId, userId: b.userId, sessionId: b.sessionId,
			workspaceId: b.workspaceId, channelId: b.channelId, modelId: b.modelId,
			source: b.source, chatType: b.chatType, groupName: b.groupName, createdAt: b.createdAt,
		}));
		saveBindings(this.botConfig.id, bindings);
	}

	// ===== 状态推送 =====

	private updateStatus(partial: Partial<FeishuBridgeStatus>): void {
		this.status = { ...this.status, ...partial };
		const win = this.getWindow();
		if (win && !win.isDestroyed()) win.webContents.send(ipcChannels.feishuStatus, this.status);
	}

	pushMessage(message: FeishuChatMessage): void {
		const win = this.getWindow();
		if (win && !win.isDestroyed()) win.webContents.send(ipcChannels.feishuMessages, message);
	}

	// ===== 重连 =====

	private scheduleReconnect(): void {
		if (this.reconnectTimer) return;
		this.reconnectAttempts++;
		if (this.reconnectAttempts > this.maxReconnectAttempts) { logErr(`[飞书 Bridge] 重连失败，已达最大尝试次数 ${this.maxReconnectAttempts}`); this.updateStatus({ status: "error", errorMessage: "连接失败，请手动重连" }); return; }
		const delay = Math.min(5000 * Math.pow(1.5, this.reconnectAttempts - 1), 60000);
		log(`[飞书 Bridge] 将在 ${(delay / 1000).toFixed(1)}s 后重连 (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
		this.updateStatus({ status: "connecting" });
		this.reconnectTimer = setTimeout(async () => { this.reconnectTimer = null; try { await this.start(); } catch {} }, delay);
	}
}