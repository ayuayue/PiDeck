/**
 * 微信 iLink（ClawBot）协议常量与线格式类型。
 *
 * 事实来源：Tencent/openclaw-weixin 的 `docs/protocol.md`，外加 2026-10-14 本机探针
 * 全链路实测（扫码登录 → notifystart → getupdates 收信 → getconfig/sendtyping →
 * sendmessage 回信，全部 200）。实测与文档不一致的四处偏差记在下面各常量处，
 * 这些是「照文档写就会挂」的地方，改动前先复读。
 */

/** 默认 API base。扫码确认后服务端会回传 baseurl，可能与本默认值不同，必须以回传值为准。 */
export const ILINK_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

/** 生成二维码用的业务场景标记。固定 3，换值会导致扫码后拿不到 bot_token。 */
export const ILINK_BOT_TYPE = 3;

/**
 * base_info.channel_version —— 「插件版本」。服务端仅做观测，不参与鉴权与路由
 * （探针用 1.0.2 全程通过）。填一个协议形态预期的值，不要跟着 PiDeck 版本乱跳：
 * 它表达的是「我按哪版协议说话」。
 */
export const ILINK_CHANNEL_VERSION = "1.0.2";

/** 媒体走独立 CDN 域（图片/文件上传下载），与 API base 不同源。 */
export const ILINK_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

// ===== 端点 =====
// 扫码前的两个端点是「应用级」的：不带 bot_token，也不带 iLink-App-Id（实测均可省）。

export const ILINK_EP_GET_BOT_QRCODE = "/ilink/bot/get_bot_qrcode";
export const ILINK_EP_GET_QRCODE_STATUS = "/ilink/bot/get_qrcode_status";
export const ILINK_EP_GET_UPDATES = "/ilink/bot/getupdates";
export const ILINK_EP_SEND_MESSAGE = "/ilink/bot/sendmessage";
export const ILINK_EP_GET_CONFIG = "/ilink/bot/getconfig";
export const ILINK_EP_SEND_TYPING = "/ilink/bot/sendtyping";
export const ILINK_EP_NOTIFY_START = "/ilink/bot/msg/notifystart";
export const ILINK_EP_NOTIFY_STOP = "/ilink/bot/msg/notifystop";
export const ILINK_EP_GET_UPLOAD_URL = "/ilink/bot/getuploadurl";

// ===== 超时 =====
// 三个超时值是三个不同语义，不能合并成一个常量。

/** 普通业务请求。服务端处理很快（实测 sendmessage 337ms / getconfig 226ms）。 */
export const API_TIMEOUT_MS = 15_000;

/**
 * get_qrcode_status 实测是「长轮询」而非轮询：拿到 confirmed 那次连接挂了 10055ms 才返回。
 * 用默认 15s 会把自己打死（第一版就是这么挂的，报错 `This operation was aborted`），
 * 所以给足 45s，并且把单次超时当作「状态未变化」而不是「请求失败」。
 */
export const QR_STATUS_TIMEOUT_MS = 45_000;

/** 扫码状态轮询间隔。该端点是长轮询，间隔只在服务端立即返回时生效。 */
export const QR_STATUS_POLL_INTERVAL_MS = 2_000;

/**
 * getupdates 长轮询。文档写响应里带 `longpolling_timeout_ms: 35000`，实测该字段**不存在**，
 * 每次稳定在 ~18.1s 返回。既然读不到服务端承诺的超时，就自己兜一个明显大于 18s 的值。
 */
export const POLL_TIMEOUT_MS = 40_000;

/** 长轮询连续失败后的退避：前两次按 2s 快试，达到阈值后退到 30s（避免打爆服务端）。 */
export const POLL_RETRY_FAST_MS = 2_000;
export const POLL_RETRY_SLOW_MS = 30_000;
export const POLL_RETRY_SLOW_AFTER = 3;

/**
 * 会话过期后必须暂停该账号的时长。iLink 用 errcode -14 表达「会话过期」，
 * 文档要求暂停 1 小时再重试；继续高频重试会被风控，所以这个值不是可调的性能参数。
 */
export const SESSION_EXPIRED_COOLDOWN_MS = 60 * 60 * 1000;

// ===== 请求头 =====

export const ILINK_HEADER_AUTH_TYPE = "AuthorizationType";
export const ILINK_HEADER_AUTH = "Authorization";
export const ILINK_HEADER_UIN = "X-WECHAT-UIN";
export const ILINK_HEADER_APP_ID = "iLink-App-Id";
export const ILINK_HEADER_APP_CLIENT_VERSION = "iLink-App-ClientVersion";

/** 固定值，与 bot_token 配套使用；缺了会被判为未认证。 */
export const ILINK_AUTH_TYPE_VALUE = "ilink_bot_token";

// ===== 协议常量 =====

/** 成功码。服务端用 `ret` 表达业务结果，HTTP 200 不代表成功。 */
export const ILINK_RET_OK = 0;

/** 「会话过期」错误码，见 SESSION_EXPIRED_COOLDOWN_MS。 */
export const ILINK_ERR_SESSION_EXPIRED = -14;

/** 单条消息的 item 类型。MVP 只处理文本，其余先识别出来降级提示。 */
export const ITEM_TYPE_TEXT = 1;
export const ITEM_TYPE_IMAGE = 2;
export const ITEM_TYPE_VOICE = 3;
export const ITEM_TYPE_FILE = 4;
export const ITEM_TYPE_VIDEO = 5;

/** 消息方向：1 = 用户发来，2 = 机器人发出。 */
export const MESSAGE_TYPE_USER = 1;
export const MESSAGE_TYPE_BOT = 2;

/** 已送达状态（发送时固定带 2）。 */
export const MESSAGE_STATE_DELIVERED = 2;

// ===== 线格式类型 =====

/** 每个请求都要带的元信息。`bot_agent` 仅用于可观测性，如实填写自身身份即可——实测服务端不据此鉴权。 */
export type IlinkBaseInfo = {
	channel_version: string;
	bot_agent?: string;
};

export type IlinkQrCodeResponse = {
	ret: number;
	errmsg?: string;
	qrcode: string;
	/** 二维码内容的 URL（`https://liteapp.weixin.qq.com/q/...`），渲染成图给人扫的就是它。 */
	qrcode_img_content?: string;
};

/**
 * 扫码状态。`wait` 之外的取值都需要单独分支处理，漏掉任何一个都会出现「卡住但无提示」。
 */
export type IlinkQrStatus = "wait" | "scaned" | "confirmed" | "expired" | "need_verifycode" | "verify_code_blocked" | "scaned_but_redirect" | "binded_redirect";

export type IlinkQrStatusResponse = {
	ret: number;
	errmsg?: string;
	status?: IlinkQrStatus;
	/** 仅在 confirmed 时出现。 */
	bot_token?: string;
	ilink_bot_id?: string;
	ilink_user_id?: string;
	/** 服务端指定的 API base，可能不同于请求时用的 host，后续请求必须换过去。 */
	baseurl?: string;
	/** 仅在 scaned_but_redirect 时出现，告知改连哪个 host 继续等状态。 */
	redirect_host?: string;
};

export type IlinkTextItem = {
	type: typeof ITEM_TYPE_TEXT;
	text_item: { text: string };
	msg_id?: string;
	create_time_ms?: number;
};

export type IlinkUnknownItem = {
	type: number;
	[key: string]: unknown;
};

export type IlinkMessageItem = IlinkTextItem | IlinkUnknownItem;

export type IlinkMessage = {
	seq?: number;
	message_id: number;
	from_user_id: string;
	to_user_id: string;
	client_id?: string;
	create_time_ms?: number;
	update_time_ms?: number;
	/** 非空表示群消息；MVP 只支持私聊，收到就降级提示。 */
	group_id?: string;
	session_id?: string;
	message_type: number;
	message_state?: number;
	item_list?: IlinkMessageItem[];
	/**
	 * 回信凭证。必须先收到带 context_token 的用户消息才能回——协议不支持主动推送，
	 * 所以「Agent 跑完了通知用户」在微信侧无法实现，只能等用户开口。
	 */
	context_token?: string;
	root_id?: number;
	parent_id?: number;
};

export type IlinkUpdatesResponse = {
	ret: number;
	errmsg?: string;
	errcode?: number;
	msgs?: IlinkMessage[];
	/** 增量游标：回传上一次的值即可续接，服务端据此保证不重复投递。 */
	get_updates_buf?: string;
	/** 与 get_updates_buf 是不同的字段，实测两者同时返回且内容不同；续接用 get_updates_buf。 */
	sync_buf?: string;
	/** 文档声称有、实测不存在的字段，保留类型只为兼容将来出现的情形。 */
	longpolling_timeout_ms?: number;
};

export type IlinkConfigResponse = {
	ret: number;
	errmsg?: string;
	errcode?: number;
	/** 「正在输入」凭证，有效期短，每次发送 typing 前重新获取。 */
	typing_ticket?: string;
};

export type IlinkSendMessageResponse = {
	ret: number;
	errmsg?: string;
	errcode?: number;
	/** 服务端消息 ID。注意：拿到它只代表服务端收下了，不代表对方客户端已渲染。 */
	message_id?: number;
};

export type IlinkSimpleResponse = {
	ret: number;
	errmsg?: string;
	errcode?: number;
};

/** 扫码确认后得到的会话凭据。bot_token 是密钥，绝不可写进日志。 */
export type IlinkSession = {
	botToken: string;
	baseUrl: string;
	ilinkBotId: string;
	ilinkUserId: string;
	/** 长轮询游标，重启后从 0/空开始即可（服务端只投递新消息）。 */
	cursor: string;
};

// ===== 纯函数 =====

/**
 * 构造 X-WECHAT-UIN：随机 uint32 的十进制字符串再做 base64。
 * 实测该头并非必需（不发也能成功），但文档要求且成本为零，照发。
 */
export function randomWechatUin(): string {
	const value = Math.floor(Math.random() * 0xffffffff);
	return Buffer.from(String(value), "utf-8").toString("base64");
}

/** 构造 base_info。channelVersion 必填；botAgent 传自身身份，不伪装成 OpenClaw。 */
export function buildBaseInfo(channelVersion: string, botAgent?: string): IlinkBaseInfo {
	const info: IlinkBaseInfo = { channel_version: channelVersion };
	if (botAgent) info.bot_agent = botAgent;
	return info;
}

/** 会话过期判定：`ret` 或 `errcode` 任一命中 -14 都算。 */
export function isSessionExpired(payload: { ret?: number; errcode?: number }): boolean {
	return payload.ret === ILINK_ERR_SESSION_EXPIRED || payload.errcode === ILINK_ERR_SESSION_EXPIRED;
}

/** 从 item_list 里抽出全部文本（一条消息可能被拆成多个 text item）。 */
export function extractMessageText(items: IlinkMessageItem[] | undefined): string {
	if (!items) return "";
	return items
		.filter((item): item is IlinkTextItem => item.type === ITEM_TYPE_TEXT && typeof (item as IlinkTextItem).text_item?.text === "string")
		.map((item) => item.text_item.text)
		.join("");
}

/** 列表里是否含非文本 item——用于给「暂不支持图片/语音」的降级提示做判断。 */
export function hasUnsupportedItem(items: IlinkMessageItem[] | undefined): boolean {
	if (!items) return false;
	return items.some((item) => item.type !== ITEM_TYPE_TEXT);
}
