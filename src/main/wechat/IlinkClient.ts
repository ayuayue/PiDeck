/**
 * IlinkClient — 微信 iLink（ClawBot）协议传输层。
 *
 * 只做「一次请求 → 一个结构化结果或一个 IlinkError」，重试/退避/循环由调用方
 * （WeChatLogin / WeChatBridge）决定。这样拆是因为 iLink 的三种超时语义完全不同：
 * 普通请求超时=失败，QR 状态超时=「状态未变化」（要继续等），长轮询超时=正常失败
 * 要退避。把它们混进客户端会让重试策略散落在两处。
 *
 * fetch 走依赖注入而不是直接用全局 fetch：vm 测试沙箱不注入 fetch（见
 * tests/helpers/loadTsCommonJs.mjs 的全局表），注入后这个模块可脱网单测。
 * 生产默认用全局 fetch —— 探针实测过的就是这条路径；换 Electron net.fetch 要重新
 * 验证自定义头（Chromium 会静默丢弃部分 forbidden header，见 usageProbeTransport 的
 * Cookie 前车之鉴），收益不抵风险。
 */

import { clearTimeout, setTimeout } from "node:timers";
import {
	API_TIMEOUT_MS,
	buildBaseInfo,
	ILINK_AUTH_TYPE_VALUE,
	ILINK_DEFAULT_BASE_URL,
	ILINK_EP_GET_BOT_QRCODE,
	ILINK_EP_GET_CONFIG,
	ILINK_EP_GET_QRCODE_STATUS,
	ILINK_EP_GET_UPDATES,
	ILINK_EP_NOTIFY_START,
	ILINK_EP_NOTIFY_STOP,
	ILINK_EP_SEND_MESSAGE,
	ILINK_EP_SEND_TYPING,
	ILINK_HEADER_APP_CLIENT_VERSION,
	ILINK_HEADER_APP_ID,
	ILINK_HEADER_AUTH,
	ILINK_HEADER_AUTH_TYPE,
	ILINK_HEADER_UIN,
	ILINK_RET_OK,
	ITEM_TYPE_TEXT,
	MESSAGE_STATE_DELIVERED,
	MESSAGE_TYPE_BOT,
	POLL_TIMEOUT_MS,
	QR_STATUS_TIMEOUT_MS,
	isSessionExpired,
	randomWechatUin,
	type IlinkConfigResponse,
	type IlinkMessage,
	type IlinkQrCodeResponse,
	type IlinkQrStatusResponse,
	type IlinkSendMessageResponse,
	type IlinkSession,
	type IlinkSimpleResponse,
	type IlinkUpdatesResponse,
} from "./ilinkProtocol";

// ===== fetch 注入契约 =====

/** 结构化的响应契约（真实 Response 天然满足），只为可测性而存在。 */
export type IlinkFetchResponse = {
	status: number;
	text: () => Promise<string>;
};

export type IlinkFetchInit = {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
};

export type IlinkFetch = (url: string, init: IlinkFetchInit) => Promise<IlinkFetchResponse>;

export type IlinkLogFn = (level: "debug" | "info" | "warn" | "error", message: string, detail?: unknown) => void;

// ===== 错误 =====

/**
 * 失败分类。调用方按 kind 分流：timeout 在 QR 状态轮询里是「继续等」，
 * session-expired 必须暂停账号一小时，其余按退避重试。
 */
export type IlinkErrorKind = "timeout" | "network" | "http" | "business" | "malformed" | "session-expired";

export class IlinkError extends Error {
	readonly kind: IlinkErrorKind;
	readonly endpoint: string;
	readonly httpStatus?: number;
	readonly ret?: number;
	readonly errcode?: number;

	constructor(kind: IlinkErrorKind, endpoint: string, message: string, extra: { httpStatus?: number; ret?: number; errcode?: number } = {}) {
		super(message);
		this.name = "IlinkError";
		this.kind = kind;
		this.endpoint = endpoint;
		this.httpStatus = extra.httpStatus;
		this.ret = extra.ret;
		this.errcode = extra.errcode;
	}
}

// ===== 日志脱敏 =====

/**
 * 日志脱敏。bot_token 是长期有效的凭据，一旦落进日志就等于泄漏（本功能的探针阶段
 * 已经犯过一次，run.log 里留了明文 token）。约束必须落在产生风险的地方——这里就是
 * 唯一出口，而不是指望每个调用点自己记得别打。
 */
export function redactSecrets(text: string): string {
	return text
		.replace(/("bot_token"\s*:\s*")[^"]*(")/g, "$1<redacted>$2")
		.replace(/(Bearer\s+)[A-Za-z0-9._~+/@:-]+/g, "$1<redacted>")
		.replace(/("context_token"\s*:\s*")[^"]*(")/g, "$1<redacted>$2")
		.replace(/("typing_ticket"\s*:\s*")[^"]*(")/g, "$1<redacted>$2");
}

/** 请求/响应体上限。iLink 的响应都是小 JSON，超过即视为异常而不是正常大响应。 */
const MAX_RESPONSE_CHARS = 1_000_000;
/** 落日志的片段长度，避免一次异常响应把日志刷爆。 */
const LOG_SNIPPET_CHARS = 400;

// ===== 客户端 =====

export type IlinkClientOptions = {
	baseUrl?: string;
	/** 协议要求必填，随客户端版本变化；与鉴权无关，服务端只做观测。 */
	channelVersion: string;
	/** 自身身份标识。**不伪装成 OpenClaw** —— 实测服务端不据此鉴权，伪装只会让故障无法归因。 */
	botAgent?: string;
	appId?: string;
	appClientVersion?: string;
	fetchImpl?: IlinkFetch;
	logger?: IlinkLogFn;
	/** 长轮询与 QR 状态超时，供测试压缩等待；生产用协议默认值。 */
	timeouts?: { api?: number; qrStatus?: number; poll?: number };
};

export class IlinkClient {
	private baseUrl: string;
	private readonly channelVersion: string;
	private readonly botAgent: string | undefined;
	private readonly appId: string | undefined;
	private readonly appClientVersion: string | undefined;
	private readonly fetchImpl: IlinkFetch;
	private readonly logger: IlinkLogFn | undefined;
	private readonly apiTimeoutMs: number;
	private readonly qrStatusTimeoutMs: number;
	private readonly pollTimeoutMs: number;

	constructor(options: IlinkClientOptions) {
		this.baseUrl = options.baseUrl ?? ILINK_DEFAULT_BASE_URL;
		this.channelVersion = options.channelVersion;
		this.botAgent = options.botAgent;
		this.appId = options.appId;
		this.appClientVersion = options.appClientVersion;
		this.fetchImpl = options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
		this.logger = options.logger;
		this.apiTimeoutMs = options.timeouts?.api ?? API_TIMEOUT_MS;
		this.qrStatusTimeoutMs = options.timeouts?.qrStatus ?? QR_STATUS_TIMEOUT_MS;
		this.pollTimeoutMs = options.timeouts?.poll ?? POLL_TIMEOUT_MS;
	}

	/** 当前 API base。扫码遇到 scaned_but_redirect 或确认后回传 baseurl 时都要改这里。 */
	getBaseUrl(): string {
		return this.baseUrl;
	}

	/** 切换 API base。空值忽略（服务端偶尔回空字符串，不能因此把 base 清空）。 */
	setBaseUrl(url: string | undefined): void {
		if (!url) return;
		const normalized = url.startsWith("http") ? url : `https://${url}`;
		if (normalized === this.baseUrl) return;
		this.log(`切换到 base ${normalized}`);
		this.baseUrl = normalized;
	}

	private log(message: string, detail?: unknown): void {
		this.logger?.("debug", message, detail);
	}

	/** 应用级请求头：扫码阶段用，不带任何凭据。 */
	private appHeaders(): Record<string, string> {
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (this.appId) headers[ILINK_HEADER_APP_ID] = this.appId;
		if (this.appClientVersion) headers[ILINK_HEADER_APP_CLIENT_VERSION] = this.appClientVersion;
		return headers;
	}

	/** 业务请求头：带 bot_token。X-WECHAT-UIN 每次请求都要新随机值。 */
	private authHeaders(botToken: string): Record<string, string> {
		return {
			...this.appHeaders(),
			[ILINK_HEADER_AUTH_TYPE]: ILINK_AUTH_TYPE_VALUE,
			[ILINK_HEADER_AUTH]: `Bearer ${botToken}`,
			[ILINK_HEADER_UIN]: randomWechatUin(),
		};
	}

	/** 发一次请求并解析 JSON。所有失败都归一成 IlinkError，不向上抛裸异常。 */
	private async request<T extends { ret?: number; errcode?: number; errmsg?: string }>(method: "GET" | "POST", path: string, options: { body?: unknown; headers: Record<string, string>; timeoutMs: number; label: string }): Promise<T> {
		const url = new URL(path, `${this.baseUrl}/`).toString();
		const bodyStr = options.body === undefined ? undefined : JSON.stringify(options.body);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), options.timeoutMs);
		const started = Date.now();

		let response: IlinkFetchResponse;
		try {
			response = await this.fetchImpl(url, {
				method,
				headers: options.headers,
				...(bodyStr !== undefined ? { body: bodyStr } : {}),
				signal: controller.signal,
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			const name = error instanceof Error ? error.name : "";
			const timedOut = name === "AbortError" || name === "TimeoutError" || /aborted/i.test(detail);
			throw new IlinkError(timedOut ? "timeout" : "network", options.label, `${options.label} ${timedOut ? "超时" : "网络失败"}：${detail}`);
		} finally {
			clearTimeout(timer);
		}

		let text: string;
		try {
			text = await response.text();
		} catch (error) {
			throw new IlinkError("network", options.label, `${options.label} 响应读取失败：${error instanceof Error ? error.message : String(error)}`);
		}
		const elapsed = Date.now() - started;

		if (text.length > MAX_RESPONSE_CHARS) {
			throw new IlinkError("malformed", options.label, `${options.label} 响应过大（${text.length} 字符），拒绝解析`, { httpStatus: response.status });
		}
		// 响应体直接落日志会把 bot_token/context_token 写进日志文件，故出口即脱敏。
		this.log(`${options.label} → HTTP ${response.status} (${elapsed}ms)`, redactSecrets(text.slice(0, LOG_SNIPPET_CHARS)));

		let payload: T;
		try {
			payload = (text ? JSON.parse(text) : {}) as T;
		} catch {
			throw new IlinkError("malformed", options.label, `${options.label} 返回非 JSON：${redactSecrets(text.slice(0, LOG_SNIPPET_CHARS))}`, { httpStatus: response.status });
		}

		if (response.status < 200 || response.status >= 300) {
			throw new IlinkError("http", options.label, `${options.label} HTTP ${response.status}：${redactSecrets(text.slice(0, LOG_SNIPPET_CHARS))}`, { httpStatus: response.status });
		}
		// 会话失效可能只出现在 errcode 上而 ret 仍为 0，必须独立判定：漏判会让调用方
		// 拿着已失效的 token 一直轮询，而不是按协议暂停一小时。
		if (isSessionExpired(payload)) {
			throw new IlinkError("session-expired", options.label, `${options.label} 会话已失效 errcode=${payload.errcode ?? payload.ret}`, {
				httpStatus: response.status,
				ret: payload.ret,
				errcode: payload.errcode,
			});
		}
		// iLink 用 HTTP 200 + ret 表达业务失败，所以 2xx 不等于成功。
		if (payload.ret !== undefined && payload.ret !== ILINK_RET_OK) {
			throw new IlinkError("business", options.label, `${options.label} 业务失败 ret=${payload.ret}${payload.errmsg ? ` ${payload.errmsg}` : ""}`, {
				httpStatus: response.status,
				ret: payload.ret,
				errcode: payload.errcode,
			});
		}
		return payload;
	}

	private baseInfo(): { channel_version: string; bot_agent?: string } {
		return buildBaseInfo(this.channelVersion, this.botAgent);
	}

	// ===== 扫码（应用级，无凭据）=====

	/** 取登录二维码。返回的 qrcode_img_content 是给人扫的 URL。 */
	async createQrcode(): Promise<IlinkQrCodeResponse> {
		return this.request<IlinkQrCodeResponse>("POST", `/ilink/bot/get_bot_qrcode?bot_type=3`, {
			body: { local_token_list: [] },
			headers: this.appHeaders(),
			timeoutMs: this.apiTimeoutMs,
			label: "get_bot_qrcode",
		});
	}

	/**
	 * 查询扫码状态。这个端点是长轮询：没有状态变化时服务端会一直挂着连接，
	 * 所以超时要给足，且调用方收到 timeout 必须当作「还没变化」而不是失败。
	 */
	async queryQrcodeStatus(qrcode: string, verifyCode?: string): Promise<IlinkQrStatusResponse> {
		const params = new URLSearchParams({ qrcode });
		if (verifyCode) params.set("verify_code", verifyCode);
		return this.request<IlinkQrStatusResponse>("GET", `${ILINK_EP_GET_QRCODE_STATUS}?${params}`, {
			headers: this.appHeaders(),
			timeoutMs: this.qrStatusTimeoutMs,
			label: "get_qrcode_status",
		});
	}

	// ===== 在线状态 =====

	async notifyStart(session: IlinkSession): Promise<IlinkSimpleResponse> {
		return this.request<IlinkSimpleResponse>("POST", ILINK_EP_NOTIFY_START, {
			body: { base_info: this.baseInfo() },
			headers: this.authHeaders(session.botToken),
			timeoutMs: this.apiTimeoutMs,
			label: "notifystart",
		});
	}

	/**
	 * 声明离线。进程被强杀时发不出去（Windows 下 taskkill 不会触发 SIGTERM 处理器），
	 * 所以它只是「礼貌性通知」，实现上不能依赖它来保证服务端状态正确。
	 */
	async notifyStop(session: IlinkSession): Promise<IlinkSimpleResponse> {
		return this.request<IlinkSimpleResponse>("POST", ILINK_EP_NOTIFY_STOP, {
			body: { base_info: this.baseInfo() },
			headers: this.authHeaders(session.botToken),
			timeoutMs: this.apiTimeoutMs,
			label: "notifystop",
		});
	}

	// ===== 收信 =====

	/** 长轮询收信。返回增量游标，调用方需持久化并在下次请求回传以保证不重复投递。 */
	async getUpdates(session: IlinkSession, cursor?: string): Promise<{ msgs: IlinkMessage[]; cursor: string }> {
		const payload = await this.request<IlinkUpdatesResponse>("POST", ILINK_EP_GET_UPDATES, {
			body: { get_updates_buf: cursor ?? "", base_info: this.baseInfo() },
			headers: this.authHeaders(session.botToken),
			timeoutMs: this.pollTimeoutMs,
			label: "getupdates",
		});
		return { msgs: payload.msgs ?? [], cursor: payload.get_updates_buf ?? cursor ?? "" };
	}

	// ===== 回信 =====

	/** 取「正在输入」凭证。有效期短，每次发送前重新取。 */
	async getConfig(session: IlinkSession, userId: string, contextToken: string): Promise<IlinkConfigResponse> {
		return this.request<IlinkConfigResponse>("POST", ILINK_EP_GET_CONFIG, {
			body: { ilink_user_id: userId, context_token: contextToken, base_info: this.baseInfo() },
			headers: this.authHeaders(session.botToken),
			timeoutMs: this.apiTimeoutMs,
			label: "getconfig",
		});
	}

	async sendTyping(session: IlinkSession, userId: string, typingTicket: string, status = 1): Promise<IlinkSimpleResponse> {
		return this.request<IlinkSimpleResponse>("POST", ILINK_EP_SEND_TYPING, {
			body: { ilink_user_id: userId, typing_ticket: typingTicket, status, base_info: this.baseInfo() },
			headers: this.authHeaders(session.botToken),
			timeoutMs: this.apiTimeoutMs,
			label: "sendtyping",
		});
	}

	/**
	 * 发文本。必须先收到带 context_token 的用户消息——协议不支持主动推送，
	 * 所以「Agent 主动通知用户」在微信侧做不到，只能等用户先开口。
	 */
	async sendText(session: IlinkSession, input: { toUserId: string; contextToken: string; text: string; clientId?: string; runId?: string }): Promise<IlinkSendMessageResponse> {
		return this.request<IlinkSendMessageResponse>("POST", ILINK_EP_SEND_MESSAGE, {
			body: {
				msg: {
					from_user_id: "",
					to_user_id: input.toUserId,
					...(input.clientId ? { client_id: input.clientId } : {}),
					...(input.runId ? { run_id: input.runId } : {}),
					message_type: MESSAGE_TYPE_BOT,
					message_state: MESSAGE_STATE_DELIVERED,
					context_token: input.contextToken,
					item_list: [{ type: ITEM_TYPE_TEXT, text_item: { text: input.text } }],
				},
				base_info: this.baseInfo(),
			},
			headers: this.authHeaders(session.botToken),
			timeoutMs: this.apiTimeoutMs,
			label: "sendmessage",
		});
	}
}
