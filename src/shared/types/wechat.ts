/**
 * 微信 iLink（ClawBot）桥接的跨进程契约。
 *
 * 与飞书的根本差异写在这里当基准：微信侧是「一个微信号 1:1 绑定一个 Bot」，
 * 所以没有多 Bot、没有群聊、没有卡片/按钮/Markdown。契约里刻意不保留这些字段，
 * 避免后来者以为它们只是「还没实现」。
 */

import type { ImChannelBackend } from "./agent";

/** 已登录账号的公开信息。**永不包含 bot_token** —— token 只在主进程内存里解密使用。 */
export type WeChatAccountInfo = {
	ilinkBotId: string;
	/** 扫码的微信号。同时是唯一被允许与 Bot 对话的身份（鉴权白名单）。 */
	ilinkUserId: string;
	/** 展示名。iLink 不提供 Bot 昵称，由用户自行命名。 */
	displayName: string;
	baseUrl: string;
	loggedInAt: number;
	/** token 已失效（服务端判定），需要重新扫码；此时桥接不会尝试连接。 */
	needsRelogin?: boolean;
};

/**
 * 模型优先级链的一条。微信回复从链首开始尝试，运行失败自动顺延到下一条。
 * provider + modelId 是唯一身份；modelName 只用于界面展示（可能拿不到）。
 */
export type WeChatModelChainEntry = {
	provider: string;
	modelId: string;
	modelName?: string;
};

export type WeChatSettings = {
	/** 是否启用桥接。关闭后不建连接、不收信，账号与绑定保留。 */
	enabled: boolean;
	account: WeChatAccountInfo | null;
	/**
	 * 新会话在哪个工作区打开。留空 = 自动（用 PiDeck 项目列表的第一项，约等于最近使用）。
	 * 已存在的绑定保持自己的工作区，改这里不会迁移旧会话。
	 */
	defaultWorkspaceId?: string;
	/**
	 * 微信回复跑在哪个运行时后端（缺省 pi）。
	 * 改这里会让已有绑定在下一条消息时换绑成新后端的新会话（换绑会主动回一条提示），
	 * 原会话保留在桌面侧栏；模型优先级链的条目必须与后端同源（pi 模型 / dsh 模型不能混用）。
	 */
	backend?: ImChannelBackend;
	/**
	 * 微信回复的模型优先级链。空数组 = 不干预会话模型。
	 * 非空时链首是新会话的默认模型，运行失败（供应商报错）时自动顺延到下一条。
	 */
	modelChain?: WeChatModelChainEntry[];
	/** @deprecated 历史字段，从未被桥接消费；模型选择改用 modelChain。 */
	defaultModelId?: string;
};

export type WeChatBridgeStatus = {
	status: "disconnected" | "connecting" | "connected" | "error";
	account: WeChatAccountInfo | null;
	/** 当前活跃的会话绑定数（微信私聊 1:1，正常为 0 或 1）。 */
	activeBindings: number;
	connectedAt?: number;
	/** 最后一次收到用户消息的时间，用于界面判断通道是否还活着。 */
	lastMessageAt?: number;
	errorMessage?: string;
};

/**
 * 扫码登录阶段。与 iLink 的 get_qrcode_status 取值一一对应，外加两个本地态：
 * idle=未开始，error=请求失败（协议错误不落这里）。
 */
export type WeChatLoginPhase = "idle" | "waiting" | "scanned" | "need-verify-code" | "confirmed" | "expired" | "error";

export type WeChatLoginState = {
	phase: WeChatLoginPhase;
	/**
	 * 供二维码编码的字符串（iLink 的 qrcode_img_content，形如
	 * https://liteapp.weixin.qq.com/q/xxx?qrcode=...）。渲染层自行转 data URL，
	 * 主进程不生成图片。
	 */
	qrcodeContent?: string;
	/** 展示给用户的提示（等待扫码/已扫码待确认/已过期等）。 */
	message?: string;
	error?: string;
};

/** 扫码登录的最终结果，成功后账号已落盘。 */
export type WeChatLoginResult = {
	ok: boolean;
	account?: WeChatAccountInfo;
	error?: string;
};

/** 微信私聊 ↔ pi 会话的绑定。chatId 即对方的 ilink_user_id（1:1 无群聊）。 */
export type WeChatChatBinding = {
	chatId: string;
	userId: string;
	/** 稳定会话身份，跨重启不变。 */
	sessionId: string;
	/** 会话文件路径。重启后据此恢复同一个 pi 会话。 */
	sessionPath?: string;
	/**
	 * 当前 runtime 句柄。**不是**身份：进程退出/重连后失效，需重新激活同一个 sessionId。
	 * 与 FeishuChatBinding 的 agentId 同义，同样不得当作长期标识使用。
	 */
	agentId?: string;
	workspaceId: string;
	/** 这个绑定当前用的运行时后端（缺省 pi）。
	 *  **跟会话走**：设置里改了后端，绑定会在下一条消息处换绑到新后端的新会话（原会话留在侧栏），
	 *  而不是让同一个会话中途换引擎（跨引擎没有可续的历史，模型目录也不是同一套词汇）。 */
	backend?: ImChannelBackend;
	modelId?: string;
	/** 微信里 /model 显式选中的 provider。有它才说明 modelId 是一次明确选择，
	 *  否则只表示「会话最后用过的模型」，不压过设置里的模型链。 */
	modelProvider?: string;
	createdAt: number;
};

/** 绑定会话当前实际在用的模型（只读视图，来自运行时状态，不落盘）。 */
export type WeChatBindingModel = {
	provider: string;
	modelId: string;
	/** 展示用名称；运行时给不出时省略，界面回退到 modelId。 */
	modelName?: string;
};

/**
 * 给设置页看的绑定视图：落盘结构永远是 WeChatChatBinding，`currentModel` 由主进程按运行时现算。
 * 只有拿到运行时状态（进程在跑）才有这个字段——界面据此显示「现在用的是哪个模型」。
 */
export type WeChatBindingView = WeChatChatBinding & { currentModel?: WeChatBindingModel };

/**
 * 设置页一次拉齐用的快照。微信只可能有一个账号，分多次请求只会让
 * 「开关已变、状态未及」这类不一致更难排查。
 */
export type WeChatSettingsSnapshot = {
	settings: WeChatSettings;
	status: WeChatBridgeStatus;
	bindings: WeChatBindingView[];
	/** 可绑定的工作区；与飞书取自同一份项目列表。 */
	projects: Array<{ id: string; name: string }>;
};

/**
 * 微信 IPC 的统一返回信封。主进程把所有失败折成 `{ok:false,message}`，
 * 免得渲染层对每个方法各写一套 try/catch。
 */
export type WeChatIpcResult<T> = ({ ok: true } & T) | { ok: false; message: string };
