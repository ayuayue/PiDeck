// ===== 飞书桥接类型 =====

import type { ImChannelBackend } from "./agent";

export type FeishuBotConfig = {
	id: string;
	name: string;
	enabled: boolean;
	appId: string;
	appSecret: string; // 加密存储
	defaultWorkspaceId?: string;
	defaultChannelId?: string;
	defaultModelId?: string;
	requireMention?: boolean;
	/** 用户自己的 open_id（用于自动拉群时加入 user_id_list）。在飞书中给 Bot 发 /whoami 即可获取 */
	defaultUserOpenId?: string;
	/** 新建飞书会话使用的后端（pi/dsh）；缺省 = 跟随会话默认。
	 *  改这里会让已有绑定在下一条消息时换绑成新后端的新会话（换绑会主动回消息说明），原会话留在侧栏。 */
	backend?: ImChannelBackend;
};

export type FeishuBridgeStatus = {
	status: "disconnected" | "connecting" | "connected" | "error";
	activeBindings: number;
	connectedAt?: number;
	errorMessage?: string;
	/** 当前 bridge 连接的 Bot 配置 ID，用于配置页精确标记连接状态 */
	botId?: string;
	botOpenId?: string;
	botName?: string;
};

export type FeishuChatBinding = {
	chatId: string;
	botId: string;
	userId: string;
	/** Stable SessionRecord/catalog identity. Never use this as an AgentManager handle. */
	sessionId: string;
	/** Current AgentManager runtime handle; changes when the runtime is recreated. */
	agentId?: string;
	sessionPath?: string;
	workspaceId: string;
	channelId?: string;
	modelId?: string;
	source: "feishu" | "session-mirror";
	/** 该会话创建时选定的后端，随会话走（不随设置改）。 */
	backend?: ImChannelBackend;
	chatType: "p2p" | "group";
	groupName?: string;
	createdAt: number;
};

/** 草稿元信息，对应 drafts 目录中的单个 .md 文件 */
export type DraftMeta = {
	id: string;
	name: string;
	path: string;
	createdAt: number;
	updatedAt: number;
};

export type ScratchPadData = {
	content: string;
	lastEditedAt: number;
	cursorPosition: number;
};

export type FeishuChatMessage = {
	chatId: string;
	messageId: string;
	senderOpenId: string;
	senderName?: string;
	chatType: "p2p" | "group";
	groupName?: string;
	messageType: "text" | "image" | "post" | "file";
	text: string;
	imageKeys: string[];
	fileKeys: string[];
	timestamp: number;
};

export type FeishuConnectInput = {
	appId: string;
	appSecret: string;
	name?: string;
	defaultUserOpenId?: string;
};

export type FeishuTestResult = {
	success: boolean;
	message: string;
	botName?: string;
};

export type FeishuSessionBotResult = {
	success: boolean;
	message?: string;
	chatId?: string;
};
