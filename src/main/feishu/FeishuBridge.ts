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
	AvailableModel,
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
	getPersistentChatId,
	setPersistentChatId,
	type FeishuChatBindingPersist,
} from "./FeishuConfig";
import { chooseMessageMode, buildPostMessages, buildMarkdownCards } from "./rich-text";
import { CardStream } from "./CardStream";
import { buildFeishuTextChildren, stripFeishuActionMarkers, wantsFeishuDoc } from "./docActions";
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
	private readonly plainAppSecret?: string;
	private agentManager: AgentManager;
	private getWindow: () => BrowserWindow | null;
	private getProjects: () => Array<{ id: string; name: string; path: string }>;

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

	// ===== 图片/文件即时处理（参考 Proma 思路：不做 pending 等待，收到即处理） =====
	private imageConfirmTimers = new Map<string, ReturnType<typeof setTimeout>>();

	// 流式卡片：sessionId → CardStream
	private streamingCards = new Map<string, CardStream>();
	// 流式状态：sessionId → RunState
	private streamingRunStates = new Map<string, RunState>();
	// 卡片未创建时的缓存事件（并行模式下 Agent 先启动，事件暂存于此）
	private pendingCardEvents = new Map<string, unknown[]>();
	// 记录卡片更新失败的 session（用于 runAgent 降级兜底）
	private cardUpdateFailed = new Set<string>();

	private unsubscribeLocalEvents: (() => void) | null = null;
	// 哪些 session 是飞书发起的（不需要 session mirror）
	private feishuSessions = new Set<string>();

	private lastUserMessageId = new Map<string, string>();

	/** 用户消息中检测到要做飞书文档，agent 结束后自动创建 */
	private pendingDocRequests = new Map<string, string>();

	constructor(
		botConfig: FeishuBotConfig,
		agentManager: AgentManager,
		getWindow: () => BrowserWindow | null,
		getProjects: () => Array<{ id: string; name: string; path: string }>,
		plainAppSecret?: string,
	) {
		this.botConfig = botConfig;
		// 临时连接不会落盘，无法通过 bot id 解密 secret；这里保留一次性明文供 start() 使用。
		this.plainAppSecret = plainAppSecret;
		this.agentManager = agentManager;
		this.getWindow = getWindow;
		this.getProjects = getProjects;
	}

	getStatus(): FeishuBridgeStatus { return { ...this.status }; }
	listBindings(): FeishuChatBinding[] { return Array.from(this.chatBindings.values()); }
	/** 当前 Agent 是否已经手动连接/绑定飞书会话，用于决定是否同步消息。 */
	hasSessionBinding(agentId: string): boolean { return this.sessionToChat.has(agentId); }
	/** 当前 Agent 绑定的飞书 chat_id，用于注入给 Agent 做默认目标群。 */
	getSessionChatId(agentId: string): string | undefined { return this.getBestChatId(agentId); }

	/** 优先取当前会话明确映射的 chatId，再兜底查持久化恢复的 session-mirror 绑定。 */
	private getBestChatId(agentId: string): string | undefined {
		const currentChatId = this.sessionToChat.get(agentId);
		if (currentChatId) return currentChatId;
		for (const [chatId, b] of this.chatBindings) {
			if (b.sessionId === agentId && b.source === "session-mirror") return chatId;
		}
		return undefined;
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
	reloadBindings(): void {
		this.sessionToChat.clear();
		this.feishuSessions.clear();
		this.loadPersistedBindings();
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
		this.sessionToChat.delete(binding.sessionId);
		this.feishuSessions.delete(binding.sessionId);
		this.chatBindings.delete(chatId);
		this.streamingCards.delete(binding.sessionId);
		this.streamingRunStates.delete(binding.sessionId);
		this.pendingCardEvents.delete(binding.sessionId);
		this.cardUpdateFailed.delete(binding.sessionId);
		// 清理图片确认定时器（如果有）
		const timer = this.imageConfirmTimers.get(chatId);
		if (timer) { clearTimeout(timer); this.imageConfirmTimers.delete(chatId); }
		this.lastUserMessageId.delete(chatId);
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
		const { appId } = this.botConfig;
		const plainSecret = this.plainAppSecret ?? getDecryptedBotAppSecret(this.botConfig.id);
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
			});

			const ws = new lark.WSClient({
				appId, appSecret: plainSecret, domain: lark.Domain.Feishu, loggerLevel: lark.LoggerLevel.error,
			});
			this.wsClient = ws;
			ws.start({ eventDispatcher: dispatcher });
			log("[飞书 Bridge] WSClient 已启动");

			this.unsubscribeLocalEvents = this.agentManager.addLocalEventListener(
				(agentId, event) => this.handleAgentEvent(agentId, event),
			);
			this.loadPersistedBindings();
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
			const message = error instanceof Error ? error.message : String(error);
			this.updateStatus({ status: "error", errorMessage: message });
			logErr("[飞书 Bridge] 启动失败:", error);
			throw error;
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
		this.wsClient = null; this.client = null;
		this.chatBindings.clear(); this.sessionToChat.clear(); this.feishuSessions.clear();
		this.recentMessageIds.clear(); this.recentEventIds.clear(); this.recentContent.clear();
		this.processingChats.clear(); this.lastUserMessageId.clear();
		this.groupInfoCache.clear(); this.userNameCache.clear(); this.botOpenId = null;
		this.cardUpdateFailed.clear();
		this.pendingDocRequests.clear();
		for (const [, timer] of this.imageConfirmTimers) { clearTimeout(timer); }
		this.imageConfirmTimers.clear();
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

		// 记住用户 open_id（用于自动拉群），并推回配置页；这样用户发任意消息都能自动回填，不依赖 /whoami 命令成功响应。
		if (userId && userId !== "unknown") {
			this.userOpenId = userId;
			try {
				const win = this.getWindow();
				if (win && !win.isDestroyed()) win.webContents.send(ipcChannels.feishuWhoamiResult, userId);
			} catch { /* ignore */ }
		}

		// 命令消息（以 / 开头）不受 processingChats 限制，确保 /stop 等能在 Agent 运行时生效
		if (messageType === "text" && message.content) {
			try {
				const cmdContent = JSON.parse(message.content as string) as { text?: string };
				const cmdText = (cmdContent.text ?? "").replace(/@_user_\d+/g, "").trim();
				if (cmdText.startsWith("/") || cmdText.toLowerCase() === "whoami") {
					const msgCtx: FeishuMessageContext = {
						chatId, senderOpenId: userId, senderName: undefined,
						messageId, chatType: chatType as "p2p" | "group",
					};
					await this.handleCommand(msgCtx, cmdText);
					return;
				}
			} catch {}
		}

		if (this.processingChats.has(chatId)) { log(`[飞书 Bridge] 跳过重入消息: ${chatId}`); return; }
		this.processingChats.add(chatId);

		try {
			if (chatType === "group" && this.botConfig.requireMention !== false && !this.isBotMentioned(mentions)) {
			// session-mirror 群（Bot 自建群）允许无 @mention 消息
			const binding = this.chatBindings.get(chatId);
			if (!binding || binding.source !== "session-mirror") return;
		}
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
				text = parts.join(" ").replace(/@_user_\d+/g, "").trim();
			} else if (messageType === "image") {
				const content = JSON.parse(message.content as string) as { image_key?: string };
				if (content.image_key) { try { const imgData = await this.downloadImage(messageId, content.image_key); imageAttachments.push({ imageKey: content.image_key, data: imgData, mediaType: this.inferImageMediaType(imgData) }); } catch (e) { logErr("[飞书 Bridge] 下载图片失败:", e); await this.sendSmartMessage(chatId, "⚠️ 图片下载失败，请重试。"); return; } }
			} else if (messageType === "file") {
				const content = JSON.parse(message.content as string) as { file_key?: string; file_name?: string };
				if (content.file_key) { try { const fileData = await this.downloadFile(messageId, content.file_key); if (fileData.length > 50 * 1024 * 1024) { await this.sendSmartMessage(chatId, "文件过大（超过 50MB），暂不支持处理。"); return; } fileAttachments.push({ fileKey: content.file_key, fileName: content.file_name || `feishu-${content.file_key}`, data: fileData }); } catch (e) { logErr("[飞书 Bridge] 下载文件失败:", e); await this.sendSmartMessage(chatId, "⚠️ 文件下载失败，请重试。"); return; } }
			}

			// ===== 文件/图片 + 文字 → 一起处理；仅文件/图片 → 暂存等指令 =====
			if (!text && (imageAttachments.length > 0 || fileAttachments.length > 0)) {
				// 只有附件没有文字 → 存起来等指令
				const existing = this.pendingAttachments.get(chatId);
				const merged = existing || { images: [], files: [] };
				merged.images.push(...imageAttachments);
				merged.files.push(...fileAttachments);
				this.pendingAttachments.set(chatId, merged);
				const names = fileAttachments.map((f) => f.fileName).join("、");
				const hint = names ? `已收到文件: ${names}，请告诉我需要做什么` : "已收到图片，请告诉我需要做什么";
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

			let groupName: string | undefined; let senderName: string | undefined;
			if (chatType === "group") { const [gi, un] = await Promise.all([this.getGroupInfo(chatId), this.getUserName(userId)]); groupName = gi?.name; senderName = un; }

			const msgCtx: FeishuMessageContext = { chatId, senderOpenId: userId, senderName, messageId, chatType: chatType as "p2p" | "group", groupName };

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
			case "/model": await this.handleModelCommand(ctx, text); break;
			case "/sendfile": {
				const fp = text.split(/\s+/).slice(1).join(" ");
				if (!fp) { await this.sendSmartMessage(chatId, "用法: `/sendfile <文件路径>`"); break; }
				const result = await this.sendFeishuFile(chatId, fp);
				await this.sendSmartMessage(chatId, result);
				break;
			}
			case "/newdoc": {
				const title = text.split(/\s+/).slice(1).join(" ") || "Pi Agent 文档";
				const result = await this.createFeishuDoc(chatId, title);
				await this.sendSmartMessage(chatId, result);
				break;
			}
			case "/whoami":
				await this.sendSmartMessage(chatId,
					`你的 open_id: \`${userId}\`\n\n📋 你可以将此 ID 填入 PiDeck 飞书配置中的「你的 Open ID」字段，以便新建会话时自动拉你进群。`
				);
				// 将 open_id 推回前端，用于添加 Bot 时自动填入
				try {
					const win = this.getWindow();
					if (win && !win.isDestroyed()) {
						win.webContents.send(ipcChannels.feishuWhoamiResult, userId);
					}
				} catch { /* ignore */ }
				break;
			case "/refresh": case "/r":
				this.reloadBindings();
				await this.sendSmartMessage(chatId, `✅ 已刷新绑定 (${this.chatBindings.size} 个活跃)`);
				break;
			default: await this.sendSmartMessage(chatId, `未知命令: ${command}。输入 /help 查看帮助。`);
		}
	}

	// ===== Agent 执行（流式卡片 + 并行优化） =====

	private async runAgent(ctx: FeishuMessageContext, text: string, imageAttachments: FeishuImageAttachment[], fileAttachments: FeishuFileAttachment[]): Promise<void> {
		const { chatId } = ctx;
		let binding = this.chatBindings.get(chatId);

		// ===== 绑定失效恢复：重启后 sessionId 对应的 agent 不存在时，自动恢复或重建 =====
		if (binding) {
			const agentExists = this.agentManager.list().some((t) => t.id === binding!.sessionId);
			if (!agentExists) {
				log(`[飞书 Bridge] 绑定 ${chatId} 的 agent ${binding.sessionId.slice(0, 8)} 不存在，尝试恢复...`);
				const resumed = await this.resumeOrCreateAgent(binding);
				if (!resumed) {
					await this.sendSmartMessage(chatId, "⚠️ 会话恢复失败，请尝试 /new 创建新会话");
					return;
				}
				binding = resumed;
			}
		} else {
			await this.createNewSession(ctx);
			binding = this.chatBindings.get(chatId);
			if (!binding) return;
		}

		// 关闭已有流式卡片
		const existingCard = this.streamingCards.get(binding.sessionId);
		if (existingCard) { await existingCard.flush(markInterrupted(createInitialState())).catch(() => {}); await existingCard.close().catch(() => {}); this.streamingCards.delete(binding.sessionId); this.streamingRunStates.delete(binding.sessionId); }
		this.pendingCardEvents.delete(binding.sessionId);

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
		if (fileAttachments.length > 0) { const names = fileAttachments.map((f) => f.fileName).join(", "); finalText = finalText ? `${finalText}\n\n[附件: ${names}]` : `处理以下文件: ${names}`; }

		const initialState = createInitialState();
		this.streamingRunStates.set(binding.sessionId, initialState);
		this.pendingCardEvents.set(binding.sessionId, []);

		// 流式卡片：创建后实时更新活动轨迹和输出
		const cardPromise = CardStream.open(
			this.client!, chatId,
			renderRunCard(initialState),
			{ replyToMessageId: ctx.chatType === "group" ? ctx.messageId : undefined },
		).catch((e) => { logErr("[飞书 Bridge] 流式卡片创建失败:", e); return null as CardStream | null; });

		try {
			// Agent 需要知道消息来自飞书群聊，但不在 UI 显示这条上下文
			const feishuCtx = finalText
				? `${finalText}\n\n[这是飞书群聊消息。生成的文件 PiDeck 会自动发送到本群。]`
				: "[飞书群聊消息。请直接回复用户。]";
			await this.agentManager.sendPrompt({ agentId: binding.sessionId, message: finalText || "处理附件", agentMessage: feishuCtx, ...(images.length > 0 ? { images } : {}) });
		} catch (e) {
			this.streamingRunStates.delete(binding.sessionId);
			this.pendingCardEvents.delete(binding.sessionId);
			this.streamingCards.delete(binding.sessionId);
			throw e;
		}

		const cardStream = await cardPromise;
		const hasCard = cardStream !== null;
		if (cardStream) {
			this.streamingCards.set(binding.sessionId, cardStream);
			this.replayBufferedEvents(binding.sessionId, cardStream);
		} else {
			this.pendingCardEvents.delete(binding.sessionId);
		}

		const startTime = Date.now();

		try {
			await this.waitForAgentEnd(binding.sessionId, 300_000);
			await new Promise((r) => setTimeout(r, 800));

			if (hasCard) {
				if (this.cardUpdateFailed.has(binding.sessionId)) {
					this.cardUpdateFailed.delete(binding.sessionId);
					log(`[飞书 Bridge] 卡片更新失败，降级为文本消息`);
					await this.sendResultFallback(chatId, binding.sessionId, startTime);
				}
				this.streamingCards.delete(binding.sessionId);
				this.streamingRunStates.delete(binding.sessionId);
				this.pendingCardEvents.delete(binding.sessionId);
			} else {
				await this.sendResultFallback(chatId, binding.sessionId, startTime);
				this.streamingRunStates.delete(binding.sessionId);
				this.pendingCardEvents.delete(binding.sessionId);
			}
			// 统一扫描 Agent 回复中的飞书标记并执行
			await this.processFeishuActions(chatId, binding.sessionId).catch((e) =>
				logErr("[飞书 Bridge] 处理飞书动作异常:", e));

			// 没有 [CREATE_DOC:] 标记但用户说了要做飞书文档 → 自动创建
			const docTitle = wantsFeishuDoc(text);
			if (docTitle) {
				const lastMsg = this.agentManager.getMessages(binding.sessionId)
					.filter((m) => m.role === "assistant").pop();
				if (lastMsg?.text && !lastMsg.text.includes("[CREATE_DOC:")) {
					const body = stripFeishuActionMarkers(lastMsg.text);
					if (body) {
						await this.createFeishuDoc(chatId, docTitle, body).catch((e) =>
							logErr("[飞书 Bridge] feishu 路径自动创建文档失败:", e));
					}
				}
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			const errState = markError(createInitialState(), msg.slice(0, 96));
			const finalCardStream = this.streamingCards.get(binding.sessionId);
			if (finalCardStream) {
				await finalCardStream.flush(renderRunCard(errState)).catch(() => {});
				await finalCardStream.close().catch(() => {});
				this.streamingCards.delete(binding.sessionId);
			}
			this.streamingRunStates.delete(binding.sessionId);
			this.pendingCardEvents.delete(binding.sessionId);
			this.cardUpdateFailed.delete(binding.sessionId);
			await this.sendSmartMessage(chatId, `❌ Agent 错误: ${msg}`);
		}
	}

	/** 回放卡片创建期间缓存的 Agent 事件 */
	private replayBufferedEvents(sessionId: string, cardStream: CardStream): void {
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
		// 只有已连接状态才处理 agent 事件，防止断连后仍同步到飞书
		if (this.status.status !== "connected") return;
		const typed = event as Record<string, unknown>;

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
			const nextState = reduceFromPiEvent(runState, typed);
			if (nextState !== runState) {
				this.streamingRunStates.set(agentId, nextState);
			}
			if (cardStream) {
				// 卡片已就绪 → 直接更新（先清掉 [SEND_FILE:] [CREATE_DOC:] 标记）
				const cleanText = nextState.outputText
					.replace(/\[(SEND_FILE|CREATE_DOC):[^\]]*\]/g, "").trim();
				const displayState = cleanText !== nextState.outputText
					? { ...nextState, outputText: cleanText } : nextState;
				const chatId = this.sessionToChat.get(agentId) ?? "";
				const prefix = this.chatBindings.get(chatId)?.groupName ?? "";
				const card = renderRunCard(displayState, { stopHint: nextState.terminal === "running" ? "发送 /stop 可终止当前任务" : undefined });
				if (nextState.terminal === "running") {
					cardStream.update(card);
				} else {
					// 终态：强制 flush + close，记录失败以便 runAgent 降级兜底
					void cardStream.flush(card).then(() => {
						// flush 成功 → 检查实际 patch 是否成功
						if (cardStream.lastPatchFailed) {
							this.cardUpdateFailed.add(agentId);
							log(`[飞书 Bridge] 终态卡片 patch 失败: ${cardStream.lastPatchError}`);
						}
					}).then(() => cardStream.close()).catch((e) => {
						this.cardUpdateFailed.add(agentId);
						logErr("[飞书 Bridge] 终态卡片 flush/close 异常:", e);
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
		if (!this.feishuSessions.has(agentId) && typed.type === "agent_end") {
			log(`[Feishu Bridge] agent_end 触发 syncPiMessageToFeishu, agentId=${agentId.slice(0,8)}`);
			// 优先用 session-mirror 群聊，没有则回退到 sessionToChat
			const chatId = this.getBestChatId(agentId);
			if (chatId && this.client) {
				this.syncPiMessageToFeishu(agentId, chatId).catch((e) =>
					logErr("[Feishu Bridge] sync Pi message failed:", e));
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

		// 清掉标记再发送
		const cleanText = lastAssistant.text.replace(/\[(SEND_FILE|CREATE_DOC):[^\]]*\]/g, "").trim();
		if (cleanText) await this.sendSmartMessage(chatId, cleanText);

		// 先扫 [CREATE_DOC:] 标记
		await this.processFeishuActions(chatId, agentId).catch((e) =>
			logErr("[Feishu Bridge] process PiDeck Feishu actions failed:", e));

		// 没有标记但用户说了要做飞书文档 → 用完整回答正文自动创建
		const pendingTitle = this.pendingDocRequests.get(agentId);
		if (pendingTitle && !lastAssistant.text.includes("[CREATE_DOC:")) {
			const body = stripFeishuActionMarkers(lastAssistant.text);
			if (body) {
				await this.createFeishuDoc(chatId, pendingTitle, body).catch((e) =>
					logErr("[Feishu Bridge] auto create doc failed:", e));
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
		if (!chatId) return "当前会话未绑定飞书聊天";
		return this.sendFeishuFile(chatId, filePath);
	}

	/** 将 PiDeck 中的用户消息转发到飞书群（双向同步：Pi → 飞书） */
	async forwardUserMessageToFeishu(agentId: string, text: string): Promise<void> {
		if (!this.client || !text.trim()) return;
		const chatId = this.getBestChatId(agentId);
		if (!chatId) {
			// 没有绑定，尝试创建 session mirror
			const tab = this.agentManager.list().find(t => t.id === agentId);
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
		if (projects.length === 0) { await this.sendSmartMessage(chatId, "❌ 请先在 PiDeck 中添加项目（工作区），然后重试。"); return; }
		const projectId = projects[0].id;

		try {
			const tab = await this.agentManager.create({ projectId });
			const binding: FeishuChatBinding = {
				chatId, botId: this.botConfig.id, userId: ctx.senderOpenId, sessionId: tab.id,
				sessionPath: tab.sessionPath, workspaceId: this.botConfig.defaultWorkspaceId ?? "", source: "feishu", chatType: ctx.chatType,
				groupName: ctx.groupName, createdAt: Date.now(),
			};
			this.chatBindings.set(chatId, binding);
			this.sessionToChat.set(tab.id, chatId);
			this.feishuSessions.add(tab.id);
			this.updateStatus({ activeBindings: this.chatBindings.size });
			this.persistBindings();
			this.pushBindings();
			// 持久化 chatId 映射，确保断开重连后能复用已有群组
			if (tab.sessionPath) {
				setPersistentChatId(tab.sessionPath, chatId);
			}
			// 也按 agent UUID 保存一份，作为 sessionPath 不可用时的兜底键
			setPersistentChatId(`agent:${tab.id}`, chatId);
			await this.sendSmartMessage(chatId, `✅ 已创建会话 (${tab.id.slice(0, 8)})`);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			await this.sendSmartMessage(chatId, `❌ 创建会话失败: ${msg}`);
		}
	}

	/**
	 * 绑定失效恢复：当 sessionId 对应的 agent 不存在时，
	 * 尝试用 sessionPath 恢复会话；若无法恢复则创建新 agent 并复用已有绑定（不留群）。
	 * 参考了 Proma 的 ConversationManager 思路：用 chatId 作为稳定 key，
	 * 会话文件持久化，重启后优先恢复而不是重建。
	 */
	private async resumeOrCreateAgent(binding: FeishuChatBinding): Promise<FeishuChatBinding | undefined> {
		const projects = this.getProjects();
		if (projects.length === 0) {
			log("[飞书 Bridge] 恢复会话失败：无可用项目");
			return undefined;
		}
		const projectId = projects[0].id;

		// 1. 尝试用 sessionPath 恢复已有会话
		if (binding.sessionPath) {
			const { existsSync } = await import("node:fs");
			if (existsSync(binding.sessionPath)) {
				try {
					const tab = await this.agentManager.create({
						projectId,
						sessionPath: binding.sessionPath,
						title: binding.groupName || `飞书会话`,
					});
					log(`[飞书 Bridge] 会话恢复成功: ${tab.id} (从 ${binding.sessionPath})`);
					binding.sessionId = tab.id;
					binding.sessionPath = tab.sessionPath;
					this.sessionToChat.set(tab.id, binding.chatId);
					this.feishuSessions.add(tab.id);
					this.chatBindings.set(binding.chatId, binding);
					this.persistBindings();
					this.pushBindings();
					return binding;
				} catch (e) {
					log(`[飞书 Bridge] sessionPath 恢复失败: ${e instanceof Error ? e.message : String(e)}`);
				}
			} else {
				log(`[飞书 Bridge] sessionPath 不存在: ${binding.sessionPath}`);
			}
		}

		// 2. sessionPath 不可用 → 创建新 agent，复用已有 chatId 绑定（不新建群）
		try {
			const tab = await this.agentManager.create({ projectId, title: binding.groupName || `飞书会话` });
			log(`[飞书 Bridge] 已为新 agent ${tab.id} 复用绑定 ${binding.chatId}`);
			binding.sessionId = tab.id;
			binding.sessionPath = tab.sessionPath;
			this.sessionToChat.set(tab.id, binding.chatId);
			this.feishuSessions.add(tab.id);
			this.chatBindings.set(binding.chatId, binding);
			this.persistBindings();
			this.pushBindings();
			await this.sendSmartMessage(binding.chatId, `🔄 会话已恢复，新 ID: ${tab.id.slice(0, 8)}`);
			return binding;
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			logErr(`[飞书 Bridge] 新建 agent 失败: ${msg}`);
			return undefined;
		}
	}

	/** Session Mirror: Pi 侧创建会话时自动拉群（1会话=1群） */
	async ensureSessionMirror(sessionId: string, sessionTitle?: string, sessionPath?: string): Promise<string | undefined> {
		const pending = this.sessionMirrorPending.get(sessionId);
		if (pending) return pending;
		const task = this.ensureSessionMirrorInner(sessionId, sessionTitle, sessionPath).finally(() => {
			this.sessionMirrorPending.delete(sessionId);
		});
		this.sessionMirrorPending.set(sessionId, task);
		return task;
	}

	private async ensureSessionMirrorInner(sessionId: string, sessionTitle?: string, sessionPath?: string): Promise<string | undefined> {
		if (!this.client || this.status.status !== "connected") {
			log("[飞书 Session Mirror] Bridge 未连接，跳过自动拉群");
			return undefined;
		}

		const groupName = `Pi Agent - ${(sessionTitle || `新会话 ${sessionId.slice(0, 8)}`).slice(0, 50)}`;

		// 1. 按 sessionId 找已有绑定（只认 session-mirror 类型，忽略私聊等）
		let existingChatId = this.sessionToChat.get(sessionId);
		if (existingChatId) {
			const existingBinding = this.chatBindings.get(existingChatId);
			if (!existingBinding || existingBinding.source !== "session-mirror") {
				existingChatId = undefined;
			}
		}

		// 2. sessionId 没匹配 → 尝试按 sessionPath 找已有绑定
		//    （重启后 sessionId 变但 sessionPath 不变，可精准复用旧群）
		if (!existingChatId && sessionPath) {
			for (const [cid, binding] of this.chatBindings) {
				if (binding.sessionPath && binding.sessionPath === sessionPath) {
					existingChatId = cid;
					log(`[飞书 Session Mirror] 按 sessionPath 复用旧群: ${cid} (path: ${sessionPath})`);
					// 更新 sessionId 映射
					binding.sessionId = sessionId;
					this.sessionToChat.set(sessionId, cid);
					// 不加入 feishuSessions：session-mirror 需要 syncPiMessageToFeishu 发送结果文本
					this.persistBindings();
					break;
				}
			}
		}

		// 3. 已有绑定：检查是否需要修复空群，确保 sessionId 映射正确。
		// 不再按“孤立群”猜测复用，避免不同会话被错误关联到旧群；精准复用只依赖 sessionId/sessionPath。
		if (existingChatId) {
			const effectiveUserOpenId = this.botConfig.defaultUserOpenId || this.userOpenId;
			const binding = this.chatBindings.get(existingChatId);
			if (binding) {
				// 确保当前 sessionId 也有映射（可能刚通过 sessionPath 匹配到）
				if (binding.sessionId !== sessionId) {
					this.sessionToChat.set(sessionId, existingChatId);
				}
				if (effectiveUserOpenId && !binding.userId) {
					log(`[飞书 Session Mirror] 检测到空群 ${existingChatId}，尝试补加用户 ${effectiveUserOpenId}`);
					await this.repairEmptyGroup(existingChatId, effectiveUserOpenId).catch(() => {});
					binding.userId = effectiveUserOpenId;
					this.persistBindings();
				}
			}
			return existingChatId;
		}

		// 4. 内存中没匹配 → 尝试从持久化 chatId 映射中恢复（跨连接的生命周期）
		//    removeBinding 会删除内存绑定，但不删除此映射，确保断开重连后复用同群。
		//    兜底键 agent:sessionId 在 createNewSession / loadPersistedBindings / 建群时写入。
		let persistedChatId: string | undefined;
		if (!existingChatId) {
			if (sessionPath) {
				persistedChatId = getPersistentChatId(sessionPath);
			}
			if (!persistedChatId) {
				persistedChatId = getPersistentChatId(`agent:${sessionId}`);
			}
		}
		if (persistedChatId) {
			log(`[飞书 Session Mirror] 按持久化映射复用群: ${persistedChatId} (session: ${sessionId.slice(0, 8)})`);
				const agentTab = this.agentManager.list().find((t) => t.id === sessionId);
				const binding: FeishuChatBinding = {
					chatId: persistedChatId, botId: this.botConfig.id,
					userId: this.botConfig.defaultUserOpenId ?? this.userOpenId ?? "",
					sessionId, sessionPath: agentTab?.sessionPath ?? sessionPath,
					workspaceId: this.botConfig.defaultWorkspaceId ?? "",
					source: "session-mirror" as const, chatType: "group",
					groupName, createdAt: Date.now(),
				};
				this.chatBindings.set(persistedChatId, binding);
				this.sessionToChat.set(sessionId, persistedChatId);
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
			// 找到对应的 agent tab 以获取 sessionPath
			const agentTab = this.agentManager.list().find((t) => t.id === sessionId);
			const effectiveSessionPath = agentTab?.sessionPath ?? sessionPath;
			const binding: FeishuChatBinding = {
				chatId, botId: this.botConfig.id, userId: effectiveUserOpenId ?? "",
				sessionId, sessionPath: effectiveSessionPath, workspaceId: this.botConfig.defaultWorkspaceId ?? "",
				source: "session-mirror" as const, chatType: "group", groupName, createdAt: Date.now(),
			};
			this.chatBindings.set(chatId, binding);
			this.sessionToChat.set(sessionId, chatId);
			this.updateStatus({ activeBindings: this.chatBindings.size });
			this.persistBindings();
			this.pushBindings();
			// 持久化 chatId 映射：断开重连后可复用此群（removeBinding 不影响此映射）
			if (effectiveSessionPath) {
				setPersistentChatId(effectiveSessionPath, chatId);
				log(`[飞书 Session Mirror] 已持久化 chatId 映射: ${effectiveSessionPath} → ${chatId}`);
			}
			// 按 agent UUID 兜底键保存，确保 sessionPath 不存在时也能找到
			setPersistentChatId(`agent:${sessionId}`, chatId);

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
	async startSessionMirrorRun(sessionId: string, sessionTitle?: string, sessionPath?: string): Promise<void> {
		if (!this.client || this.status.status !== "connected") return;

		// 确保有群
		await this.ensureSessionMirror(sessionId, sessionTitle, sessionPath);

		const binding = this.sessionToChat.get(sessionId)
			? this.chatBindings.get(this.sessionToChat.get(sessionId)!)
			: undefined;
		if (!binding || binding.source !== "session-mirror") return;
		if (this.streamingCards.has(sessionId)) return;

		const initialState = createInitialState();
		this.streamingRunStates.set(sessionId, initialState);

		try {
			const cardStream = await CardStream.open(this.client!, binding.chatId, renderRunCard(initialState, { stopHint: "发送 /stop 可终止当前任务" }));
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

	// ===== 模型/工作区/会话管理命令（纯文本模式） =====

	private async handleModelCommand(ctx: FeishuMessageContext, text: string): Promise<void> {
		const args = text.split(/\s+/).slice(1).join(" ");
		if (args) {
			await this.doSetModel(ctx.chatId, args);
			return;
		}
		const binding = this.chatBindings.get(ctx.chatId);
		if (!binding) { await this.sendSmartMessage(ctx.chatId, "当前没有绑定的会话，请先发消息创建会话。"); return; }
		const models = await this.agentManager.getAvailableModels(binding.sessionId).catch(() => [] as AvailableModel[]);
		if (!models.length) { await this.sendSmartMessage(ctx.chatId, "没有可用模型。请先在 PiDeck 中配置模型。"); return; }
		const state = await this.agentManager.getRuntimeState(binding.sessionId).catch(() => undefined);
		const current = state ? `${state.provider}/${state.modelId}` : "无";
		const byProvider = new Map<string, AvailableModel[]>();
		for (const m of models) {
			if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
			const list = byProvider.get(m.provider)!;
			if (list.length < 8) list.push(m);
		}
		const lines: string[] = [`当前模型: ${current}`, "", "**可用模型：**", ""];
		for (const [provider, ms] of byProvider) {
			lines.push(`**${provider}**`);
			for (const m of ms) {
				const mark = current === `${provider}/${m.id}` ? " ✓" : "";
				lines.push(`${m.name || m.id}${mark}`);
				lines.push("```");
				lines.push(`/model ${provider}/${m.id}`);
				lines.push("```");
			}
		}
		await this.sendSmartMessage(ctx.chatId, lines.join("\n"));
	}

	private async handleWorkspaceCommand(ctx: FeishuMessageContext, text: string): Promise<void> {
		const projects = this.getProjects();
		if (!projects.length) { await this.sendSmartMessage(ctx.chatId, "没有可用项目，请先在 PiDeck 中添加项目。"); return; }
		const args = text.split(/\s+/).slice(1).join(" ");
		const binding = this.chatBindings.get(ctx.chatId);
		if (args) {
			const target = projects.find((p) => p.id === args || p.name === args);
			if (!target) { await this.sendSmartMessage(ctx.chatId, `未找到项目: ${args}`); return; }
			if (binding) binding.workspaceId = target.id;
			this.persistBindings();
			await this.sendSmartMessage(ctx.chatId, `✅ 工作区已切换至: ${target.name}（${target.path}）。`);
			return;
		}
		const currentId = binding?.workspaceId;
		const lines: string[] = ["**可用工作区：**", ""];
		for (const p of projects) {
			const mark = p.id === currentId ? " ✓" : "";
			lines.push(`${p.name}${mark}`);
			lines.push("```");
			lines.push(`/workspace ${p.name}`);
			lines.push("```");
		}
		await this.sendSmartMessage(ctx.chatId, lines.join("\n"));
	}

	private async handleResumeCommand(ctx: FeishuMessageContext, text: string): Promise<void> {
		const args = text.split(/\s+/).slice(1);
		const binding = this.chatBindings.get(ctx.chatId);
		const agents = this.agentManager.list().filter((t) => t.id !== binding?.sessionId).slice(0, 10);
		if (args.length > 0) {
			const idx = parseInt(args[0], 10) - 1;
			if (isNaN(idx) || idx < 0 || idx >= agents.length) { await this.sendSmartMessage(ctx.chatId, `无效编号，请输入 1-${agents.length}。`); return; }
			await this.doResumeSession(ctx.chatId, agents[idx]);
			return;
		}
		if (!agents.length) { await this.sendSmartMessage(ctx.chatId, "没有可恢复的历史会话。"); return; }
		const lines: string[] = ["**最近会话：**", ""];
		for (let i = 0; i < agents.length; i++) {
			const a = agents[i];
			const date = new Date(a.createdAt).toLocaleDateString("zh-CN");
			lines.push(`${i + 1}. ${a.title || a.id.slice(0, 8)} (${date})`);
			lines.push("```");
			lines.push(`/resume ${i + 1}`);
			lines.push("```");
		}
		await this.sendSmartMessage(ctx.chatId, lines.join("\n"));
	}

	// ===== 卡片交互回调（飞书 cardAction 不走 WS 连接，留空占位） =====

	private async handleCardAction(_data: Record<string, unknown>): Promise<void> {}

	// ===== 共享逻辑 =====

	private async doSetModel(chatId: string, rawId: string): Promise<void> {
		const parts = rawId.split("/");
		if (parts.length < 2) { await this.sendSmartMessage(chatId, `格式: provider/modelId，例如 anthropic/claude-sonnet-4`); return; }
		const provider = parts.slice(0, -1).join("/");
		const modelId = parts[parts.length - 1];
		const binding = this.chatBindings.get(chatId);
		if (!binding) { await this.sendSmartMessage(chatId, "当前没有绑定的会话。"); return; }
		try {
			await this.agentManager.setModel(binding.sessionId, provider, modelId);
			await this.sendSmartMessage(chatId, `✅ 已切换模型为: ${provider}/${modelId}`);
		} catch (e) {
			await this.sendSmartMessage(chatId, `❌ 切换失败: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private async doSwitchWorkspace(chatId: string, projectId: string): Promise<void> {
		const binding = this.chatBindings.get(chatId);
		if (!binding) { await this.sendSmartMessage(chatId, "当前没有绑定的会话。"); return; }
		binding.workspaceId = projectId;
		this.persistBindings();
		const project = this.getProjects().find((p) => p.id === projectId);
		await this.sendSmartMessage(chatId, `✅ 工作区已切换至: ${project?.name || projectId}。下一条消息将使用新工作区。`);
	}

	private async doResumeSession(chatId: string, target: { id: string; sessionPath?: string; title?: string }): Promise<void> {
		if (!target.sessionPath) { await this.sendSmartMessage(chatId, "⚠️ 该会话没有持久化路径，无法恢复。"); return; }
		const binding = this.chatBindings.get(chatId);
		if (!binding) { await this.sendSmartMessage(chatId, "当前没有绑定的会话。"); return; }
		try {
			const tab = await this.agentManager.create({
				projectId: binding.workspaceId || this.getProjects()[0]?.id || "",
				sessionPath: target.sessionPath,
				title: target.title,
			});
			binding.sessionId = tab.id;
			binding.sessionPath = tab.sessionPath;
			this.sessionToChat.set(tab.id, chatId);
			this.feishuSessions.add(tab.id);
			this.persistBindings();
			this.pushBindings();
			if (tab.sessionPath) setPersistentChatId(tab.sessionPath, chatId);
			setPersistentChatId(`agent:${tab.id}`, chatId);
			await this.sendSmartMessage(chatId, `✅ 已恢复会话: ${target.title || tab.id.slice(0, 8)} (${tab.id.slice(0, 8)})`);
		} catch (e) {
			await this.sendSmartMessage(chatId, `❌ 恢复失败: ${e instanceof Error ? e.message : String(e)}`);
		}
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
			elements: [{ tag: "markdown", content: ["**可用命令**", "", "`/new` 或 `/n` — 创建新会话", "`/stop` 或 `/s` — 停止当前 Agent", "`/model` — 列出模型；复制代码块切换", "`/status` — 查看当前状态", "`/whoami` — 查看你的 open_id", "`/help` 或 `/h` — 查看帮助", "", "**Agent 自主能力**", "让 Agent 帮你导出文件或写报告时，它会自动：", "• 发送文件到飞书聊天", "• 创建飞书文档并分享链接", ""].join("\n") }],
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
		const cleanText = resultText.replace(/\[SEND_FILE:[^\]]*\]/g, "").replace(/\[CREATE_DOC:[^\]]*\]/g, "").trim();
		if (cleanText) await this.sendSmartMessage(chatId, `${cleanText}\n\n⏱ ${duration}s ✅ 完成`);
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

		// 1. 显式 [SEND_FILE:path] 标记
		const sendMatch = text.match(/\[SEND_FILE:([^\]]+)\]/);
		if (sendMatch) {
			const filePath = sendMatch[1].trim();
			log(`[飞书 Bridge] 检测到 SEND_FILE: ${filePath}`);
			const result = await this.sendFeishuFile(chatId, filePath);
			log(`[飞书 Bridge] SEND_FILE 结果: ${result}`);
			if (!result.startsWith("✅")) await this.sendSmartMessage(chatId, `⚠️ ${result}`);
			else await this.sendSmartMessage(chatId, result);
		} else {
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
					if (!result.startsWith("✅")) await this.sendSmartMessage(chatId, `⚠️ ${result}`);
					else await this.sendSmartMessage(chatId, result);
				}
			}
		}
		const docMatch = text.match(/\[CREATE_DOC:([^\]]+)\]/);
		if (docMatch) {
			const title = docMatch[1].trim() || "Pi Agent 文档";
			const result = await this.createFeishuDoc(chatId, title, text);
			// createFeishuDoc 内部失败时发了消息，这里补充发送
			if (result.startsWith("❌") || result.startsWith("创建")) await this.sendSmartMessage(chatId, result);
		}
	}

	/**
	 * 上传本地文件并发送到飞书聊天。
	 * 流程：POST im/v1/files 上传 → 拿到 file_key → im.message.create 发送 file 消息
	 */
	private async sendFeishuFile(chatId: string, filePath: string, fileName?: string): Promise<string> {
		if (!this.client) return "飞书连接未就绪";
		const { existsSync, readFileSync } = await import("node:fs");
		const { basename } = await import("node:path");
		if (!existsSync(filePath)) return `文件不存在: ${filePath}`;
		const fName = fileName || basename(filePath);
		const fileData = readFileSync(filePath);
		if (fileData.length > 30 * 1024 * 1024) return "文件不能超过 30MB";

		try {
			// 1. 用 SDK im.file.create 上传文件
			const uploadResp = await this.client.im.file!.create({
				data: { file_type: "stream", file_name: fName, file: fileData },
			});
			const fileKey = (uploadResp as Record<string, unknown>)?.file_key as string;
			if (!fileKey) return "上传文件失败";

			// 2. 发送文件消息
			await this.client.im.message.create({
				params: { receive_id_type: "chat_id" },
				data: {
					receive_id: chatId,
					msg_type: "file",
					content: JSON.stringify({ file_key: fileKey }),
				},
			});
			return `✅ 已发送: ${fName}`;
		} catch (e) {
			return `发送文件失败: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	/**
	 * 创建飞书文档并分享链接到聊天。
	 * 需在飞书开放平台开启 docx:document 权限。
	 */
	private async createFeishuDoc(chatId: string, title: string, body = ""): Promise<string> {
		if (!this.client) return "飞书连接未就绪";
		try {
			const resp = await this.client.request<{
				code?: number; msg?: string; data?: { document?: { document_id?: string; title?: string; url?: string } };
			}>({
				method: "POST",
				url: "https://open.feishu.cn/open-apis/docx/v1/documents",
				data: { title },
			});
			const doc = resp?.data?.document;
			if (!doc?.document_id) return `创建文档失败: ${resp?.msg || resp?.code || "未知错误"}`;

			const children = buildFeishuTextChildren(body);
			if (children.length > 0) {
				try {
					await this.client.request({
						method: "POST",
						url: `https://open.feishu.cn/open-apis/docx/v1/documents/${doc.document_id}/blocks/${doc.document_id}/children`,
						params: { document_revision_id: -1 },
						data: { children, index: 0 },
					});
				} catch (writeError) {
					const reason = writeError instanceof Error ? writeError.message : String(writeError);
					const docUrl = doc.url || `https://www.feishu.cn/docx/${doc.document_id}`;
					await this.sendSmartMessage(chatId, `📄 **${title}**\n${docUrl}\n\n⚠️ 文档已创建，但正文写入失败：${reason}`);
					return `✅ 文档已创建但正文写入失败: ${title}\n${docUrl}\n${reason}`;
				}
			}

			const docUrl = doc.url || `https://www.feishu.cn/docx/${doc.document_id}`;
			const preview = stripFeishuActionMarkers(body);
			await this.sendSmartMessage(chatId, `📄 **${title}**\n${docUrl}${preview ? "\n\n✅ 已写入正文" : ""}`);
			return `✅ 文档已创建: ${title}\n${docUrl}`;
		} catch (e) {
			return `创建文档失败: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	// ===== 图片/文件下载 =====

	private async downloadImage(messageId: string, imageKey: string): Promise<Buffer> {
		if (!this.client) throw new Error("飞书 Client 未初始化");
		try { return await this.downloadMessageResource(messageId, imageKey, "image"); } catch { warn("[飞书 Bridge] messageResource 失败，回退到 image.get"); }
		return this.downloadViaImageGet(imageKey);
	}
	private async downloadMessageResource(messageId: string, fileKey: string, type: "image" | "file"): Promise<Buffer> {
		const resp = await this.client!.im.messageResource.get({ path: { message_id: messageId, file_key: fileKey }, params: { type } });
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
			if (!tab && b.sessionPath) {
				tab = tabs.find((t) => t.sessionPath === b.sessionPath);
				if (tab) log(`[飞书 Bridge] 按 sessionPath 恢复绑定: ${b.chatId} → sessionId ${tab.id}`);
			}

			if (tab) {
				const binding: FeishuChatBinding = {
					chatId: b.chatId, botId: b.botId, userId: b.userId, sessionId: tab.id,
					sessionPath: tab.sessionPath ?? b.sessionPath,
					workspaceId: b.workspaceId, channelId: b.channelId, modelId: b.modelId,
					source: b.source as "feishu" | "session-mirror", chatType: b.chatType as "p2p" | "group",
					groupName: b.groupName, createdAt: b.createdAt,
				};
				this.chatBindings.set(b.chatId, binding);
				this.sessionToChat.set(tab.id, b.chatId);
				// 只对 Feishu 发起的会话加入 feishuSessions（阻止 syncPiMessageToFeishu 重复发送）；
				// session-mirror 需要靠 syncPiMessageToFeishu 发送最终结果文本，不加入。
				if (b.source === "feishu") this.feishuSessions.add(tab.id);
				// 同步持久化 chatId 映射，确保断开重连后能复用群组
				if (tab.sessionPath) {
					setPersistentChatId(tab.sessionPath, b.chatId);
				}
				setPersistentChatId(`agent:${tab.id}`, b.chatId);
			} else {
				// 无匹配 tab: 保留绑定（用存储的 sessionId/sessionPath），
				// 后续消息到来时 resumeOrCreateAgent 会恢复或重建 agent。
				// 参考了 Proma 的 ConversationManager 思路：chatId 是稳定 key，
				// 不依赖 agent 运行状态。
				log(`[飞书 Bridge] 保留无主绑定（等后续恢复）: ${b.groupName ?? b.chatId}，sessionPath=${b.sessionPath ?? "(无)"}`);
				const binding: FeishuChatBinding = {
					chatId: b.chatId, botId: b.botId, userId: b.userId, sessionId: b.sessionId,
					sessionPath: b.sessionPath,
					workspaceId: b.workspaceId, channelId: b.channelId, modelId: b.modelId,
					source: b.source as "feishu" | "session-mirror", chatType: b.chatType as "p2p" | "group",
					groupName: b.groupName, createdAt: b.createdAt,
				};
				this.chatBindings.set(b.chatId, binding);
				// 即使 agent 不存在，也建立 sessionId → chatId 映射，
				// 方便后续通过 resumeOrCreateAgent 更新
				if (b.sessionId) this.sessionToChat.set(b.sessionId, b.chatId);
				// 同步持久化 chatId 映射（用存储的 sessionPath/sessionId 作兜底键）
				if (b.sessionPath) {
					setPersistentChatId(b.sessionPath, b.chatId);
				}
				if (b.sessionId) {
					setPersistentChatId(`agent:${b.sessionId}`, b.chatId);
				}
			}
		}
		if (this.chatBindings.size > 0) log(`[飞书 Bridge] 已恢复 ${this.chatBindings.size} 个聊天绑定`);
		this.updateStatus({ activeBindings: this.chatBindings.size });
	}

	private persistBindings(): void {
		const bindings: FeishuChatBindingPersist[] = Array.from(this.chatBindings.values()).map((b) => ({
			chatId: b.chatId, botId: b.botId, userId: b.userId, sessionId: b.sessionId,
			sessionPath: b.sessionPath,
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