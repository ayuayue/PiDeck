/**
 * 飞书桥接 — 内部类型定义
 *
 * 这些类型仅在 main 进程内部使用，不暴露给 renderer。
 */

/** 飞书 mention 信息 */
export type FeishuMention = {
	name: string;
	id: string | { open_id: string; union_id: string; user_id: string };
};

/** 飞书群聊信息缓存 */
export type FeishuGroupInfo = {
	chatId: string;
	name: string;
	description?: string;
	members: FeishuGroupMember[];
	userCount?: number;
	cachedAt: number;
};

/** 飞书群成员 */
export type FeishuGroupMember = {
	openId: string;
	name: string;
};

/** 飞书图片附件 */
export type FeishuImageAttachment = {
	imageKey: string;
	data: Buffer;
	mediaType: string;
};

/** 飞书文件附件 */
export type FeishuFileAttachment = {
	fileKey: string;
	fileName: string;
	data: Buffer;
};

/** 飞书消息上下文 */
export type FeishuMessageContext = {
	chatId: string;
	senderOpenId: string;
	senderName?: string;
	messageId: string;
	chatType: "p2p" | "group";
	groupName?: string;
};

/** 会话累积缓冲 */
export type SessionBuffer = {
	text: string;
	toolSummaries: Map<string, { name: string; count: number }>;
	startedAt: number;
};

/** Agent 执行结果 */
export type AgentResult = {
	text: string;
	toolSummaries: Array<{ name: string; count: number }>;
	duration: number;
	error?: string;
};

/** Lark SDK 类型（延迟加载，用于 WSClient + EventDispatcher 模式） */
export type LarkSDK = {
	Client: new (opts: Record<string, unknown>) => LarkClient;
	WSClient: new (opts: Record<string, unknown>) => {
		start: (opts: Record<string, unknown>) => void;
		stop?: () => void;
	};
	EventDispatcher: new (opts: Record<string, unknown>) => {
		register: (handlers: Record<string, (data: unknown) => Promise<unknown | undefined | void>>) => unknown;
	};
	Domain: { Feishu: unknown };
	LoggerLevel: { error: unknown };
	AppType: { SelfBuild: unknown };
};

export type LarkClient = {
	request: <T = Record<string, unknown>>(opts: {
		method: string;
		url: string;
		data?: Record<string, unknown>;
		params?: Record<string, unknown>;
	}) => Promise<T>;
	im: {
		message: {
			create: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
			reply: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
		};
		messageResource: {
			get: (opts: Record<string, unknown>) => Record<string, unknown>;
		};
		chat: {
			get: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
			create: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
			members: {
				get: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
				add: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
			};
		};
		v1: {
			message: {
				patch: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
			};
		};
	};
	auth: {
		tenantAccessToken: {
			internal: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
		};
	};
};
