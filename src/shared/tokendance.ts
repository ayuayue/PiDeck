/**
 * TokenDance（词元跳动）产品接入共享常量。
 *
 * 主进程（模型目录/授权交换/用量查询）与渲染层（内置供应商卡片、授权引导）
 * 统一从这里取字符串，避免三个地方各写一份 URL 导致归因/端点漂移。
 * 纯常量文件，不引入任何运行时依赖（shared 层约束）。
 *
 * 相关文档：https://tokendance.space/docs/ai-integration.md
 *  - 应用归因：app_url 写入 API Key，请求维度用 X-App-URL 覆盖；
 *  - OAuth 式授权：/auth + PKCE(S256)，code 在 /portal/api/v1/auth/keys 交换。
 */

/** 内置供应商名（pi models.json 的 provider key、模型选择器分组名）。 */
export const TOKENDANCE_PROVIDER = "tokendance";

/** OpenAI 兼容网关 base URL（模型目录 /models 与协议请求共用）。 */
export const TOKENDANCE_BASE_URL = "https://tokendance.space/gateway/v1";

/** PiDeck 的 App URL：写入 API Key 归因 + 请求头 X-App-URL 的值。 */
export const TOKENDANCE_APP_URL = "https://pideck.caoayu.top/";

/** OAuth 授权页（PKCE headless 模式：无 callback_url，确认后展示一次性 code）。 */
export const TOKENDANCE_AUTH_URL = "https://tokendance.space/auth";

/** code 交换 API Key 的端点（POST /portal/api/v1/auth/keys）。 */
export const TOKENDANCE_EXCHANGE_URL = "https://tokendance.space/portal/api/v1/auth/keys";

/** 授权页展示的应用名（key_name 参数，也是新 Key 的默认名称）。 */
export const TOKENDANCE_KEY_NAME = "PiDeck";

/** 兜底解析内置端点时发出的归因请求头（请求维度归因，覆盖 Key 上的 app_url）。 */
export const TOKENDANCE_APP_URL_HEADER = "X-App-URL";

/**
 * 授权收码方式（跨层契约：主进程实现、preload 入参、渲染层选单共用一份定义）。
 * - callback：本地回环监听自动接收 code，用户无需复制粘贴（默认）。
 * - headless：无 callback_url，授权页展示一次性 code 由用户粘贴（降级/离线兜底）。
 */
export type TokendanceAuthMode = "callback" | "headless";

// ── 充值（Agent 支付，见 https://tokendance.space/docs/agent-payment） ──

/** 开放平台 API 根（余额查询与支付会话同挂 /portal/api/v1）。 */
export const TOKENDANCE_PORTAL_API_URL = "https://tokendance.space/portal/api/v1";

/** 创建充值会话端点（POST，body `{ amount }`，amount 为整数元）。 */
export const TOKENDANCE_PAYMENT_SESSIONS_URL = `${TOKENDANCE_PORTAL_API_URL}/payment/sessions`;

/** 服务端下发的 status_url 必须是该路径前缀（主进程请求前做同源 + 前缀白名单校验）。 */
export const TOKENDANCE_PAYMENT_SESSION_PATH_PREFIX = "/portal/api/v1/payment/sessions/";

/** 单笔充值金额上下限（整数元，与平台限制一致；主进程校验与渲染层提示共用）。 */
export const TOKENDANCE_TOP_UP_MIN_AMOUNT = 1;
export const TOKENDANCE_TOP_UP_MAX_AMOUNT = 100000;

/** 支付会话状态：pending 等待支付；paid 已到账；其余是终态失败（需重新创建会话）。 */
export type TokendancePaymentStatus = "pending" | "paid" | "failed" | "closed" | "refunded";

/** 充值会话（主进程解析后的视图；API Key 不在其中）。 */
export type TokendancePaymentSession = {
	id: string;
	/** 充值金额，单位元（整数）。 */
	amount: number;
	status: TokendancePaymentStatus;
	/** 聚合码内容，PC 端渲染成二维码供扫码支付（不是可跳转的支付网页）。 */
	paymentUrl: string;
	/** 支付宝 App 深链（旧会话/暂不可用时缺失）；移动端由用户点击后唤起。 */
	alipayUrl?: string;
	/** 查询状态的完整 URL（主进程校验后才请求）。 */
	statusUrl: string;
	/** 会话过期时间（Unix 秒）；到点后停止轮询。 */
	expiredAt: number;
	createdAt: number;
	/** 仅 paid 时出现（Unix 秒）。 */
	paidAt?: number;
};

/**
 * 支付接口失败原因码（跨层契约）：主进程不带 i18n 依赖，只回码；
 * 文案由渲染层按码翻译（见 rendererCopy 的 config.tokendance.topUp*）。
 */
export type TokendancePaymentErrorCode =
	/** 金额不是 1–100000 的整数元。 */
	| "invalid-amount"
	/** 未解析到 provider 端点/API Key（尚未完成 TokenDance 配置）。 */
	| "not-configured"
	/** provider 端点不归属 TokenDance 官方域名（Key 属于别家账号，充值会记错户）。 */
	| "endpoint-mismatch"
	/** status_url 缺失或不满足同源 + 路径前缀白名单。 */
	| "bad-status-url"
	/** HTTP 非 2xx（detail 携带状态码）。 */
	| "http"
	| "timeout"
	| "network"
	/** 响应体不是预期的 session 结构。 */
	| "bad-response";

/** 创建/查询充值会话的统一结果（成功带 session，失败带原因码）。 */
export type TokendancePaymentSessionResult =
	| {
			ok: true;
			session: TokendancePaymentSession;
			/** 仅创建时返回：目标 Key 的掩码（如 `••••ab12`），供用户在支付前核对充的是哪把 Key。 */
			keyHint?: string;
	  }
	| { ok: false; code: TokendancePaymentErrorCode; detail?: string };
