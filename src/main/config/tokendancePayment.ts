/**
 * TokenDance 充值（Agent 支付）主进程实现。
 * 文档：https://tokendance.space/docs/agent-payment
 *
 * 只做两件事，各一条端点：
 * - **创建会话** POST /portal/api/v1/payment/sessions，body `{ amount }`（整数元）；
 * - **查询状态** GET 服务端下发的 `status_url`（3 秒轮询的节奏由渲染层决定）。
 *
 * 安全边界（渲染层入参一律不可信）：
 * - API Key 只在主进程取值/使用（端点解析经 resolveEndpoint 注入），不出现在返回值与日志；
 * - `amount` 必须通过 1–100000 的整数校验，否则拒绝发请求；
 * - `status_url` 必须同源于创建端点且路径前缀为 payment/sessions/ —— 否则渲染层能把
 *   Bearer Key 打到任意地址（凭据外泄/SSRF），这类 URL 一概不请求；
 * - provider 端点必须归属 TokenDance 官方域名（见 isTokendanceOwnEndpoint）：充值接口只会
 *   把额度记到「Bearer Key 所属账户」，而 Key 是从 tokendance provider 取的——端点被指到
 *   第三方中转时那把 Key 属于中转账号，发请求等于替中转账号充值（钱不可逆），故拒绝；
 * - 超时 15s、响应体 64KB 截断；不落盘、不缓存会话，状态判定以服务端为准（fail-closed：
 *   未知状态按 pending 处理，绝不因解析宽松而误报「已到账」）。
 */
import {
	TOKENDANCE_PAYMENT_SESSION_PATH_PREFIX,
	TOKENDANCE_PAYMENT_SESSIONS_URL,
	TOKENDANCE_PORTAL_API_URL,
	TOKENDANCE_TOP_UP_MAX_AMOUNT,
	TOKENDANCE_TOP_UP_MIN_AMOUNT,
	type TokendancePaymentErrorCode,
	type TokendancePaymentSession,
	type TokendancePaymentSessionResult,
	type TokendancePaymentStatus,
} from "../../shared/tokendance";

/** 请求形状（与 usageProbeTransport.usageProbeRequest 结构兼容；测试注入 stub）。 */
export type TokendancePaymentRequest = (url: string, init: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string; timeoutMs: number; maxBytes: number }) => Promise<{ status: number; raw: string } | { error: "timeout" | "network" }>;

/** 端点解析（主进程内取值；失败/未配置时返回空对象，由调用方回 not-configured）。 */
export type TokendancePaymentEndpointResolver = () => Promise<{ baseUrl?: string; apiKey?: string }>;

export type TokendancePaymentDeps = {
	/** 解析 tokendance provider 端点（Key 只在主进程流转）。 */
	resolveEndpoint: TokendancePaymentEndpointResolver;
	/** HTTP 传输（默认 usageProbeRequest：走 Electron net，服从系统代理）。 */
	request: TokendancePaymentRequest;
};

const TOKENDANCE_PAYMENT_TIMEOUT_MS = 15_000;
const TOKENDANCE_PAYMENT_MAX_BYTES = 64 * 1024;

/** 平台已知的会话状态；不在表内的一律降级为 pending（继续轮询，不误判成功）。 */
const KNOWN_PAYMENT_STATUSES: readonly TokendancePaymentStatus[] = ["pending", "paid", "failed", "closed", "refunded"];

/** 金额校验（整数元，1–100000）：渲染层提示与主进程门禁共用同一份判定。 */
export function isValidTokendanceTopUpAmount(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= TOKENDANCE_TOP_UP_MIN_AMOUNT && value <= TOKENDANCE_TOP_UP_MAX_AMOUNT;
}

/** 解析服务端状态字符串：未知值按 pending（保守，不误报已支付）。 */
function parsePaymentStatus(value: unknown): TokendancePaymentStatus {
	return typeof value === "string" && (KNOWN_PAYMENT_STATUSES as readonly string[]).includes(value) ? (value as TokendancePaymentStatus) : "pending";
}

/** Unix 秒字段解析：非法/缺失归 0（调用方按 0 = 无过期信息处理）。 */
function parseUnixSeconds(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * 解析响应体 `{ session: {...} }`（纯函数，可单测）。
 * 必需字段（id/amount/payment_url/status_url）缺失即视为不可用——宁可报错也不拿残缺
 * 会话去渲染二维码；可选字段（alipay_url/时间戳）缺失不影响主流程。
 */
export function parseTokendancePaymentSession(body: unknown): TokendancePaymentSession | null {
	const session = body && typeof body === "object" ? (body as { session?: unknown }).session : undefined;
	if (!session || typeof session !== "object") return null;
	const raw = session as Record<string, unknown>;
	const id = raw.id;
	const amount = raw.amount;
	const paymentUrl = raw.payment_url;
	const statusUrl = raw.status_url;
	if (typeof id !== "string" || !id) return null;
	if (typeof amount !== "number" || !Number.isFinite(amount)) return null;
	if (typeof paymentUrl !== "string" || !paymentUrl) return null;
	if (typeof statusUrl !== "string" || !statusUrl) return null;
	const alipayUrl = typeof raw.alipay_url === "string" && raw.alipay_url ? raw.alipay_url : undefined;
	const paidAt = parseUnixSeconds(raw.paid_at);
	return {
		id,
		amount,
		status: parsePaymentStatus(raw.status),
		paymentUrl,
		...(alipayUrl ? { alipayUrl } : {}),
		statusUrl,
		expiredAt: parseUnixSeconds(raw.expired_at),
		createdAt: parseUnixSeconds(raw.created_at),
		...(paidAt ? { paidAt } : {}),
	};
}

/**
 * status_url 白名单：https + 同源（创建端点 origin）+ 路径前缀 /portal/api/v1/payment/sessions/。
 * 服务端下发的地址一旦被渲染层篡改，这条校验就是阻止 Key 外泄的最后一道闸。
 */
export function isAllowedTokendancePaymentStatusUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "https:") return false;
	if (parsed.origin !== new URL(TOKENDANCE_PAYMENT_SESSIONS_URL).origin) return false;
	return parsed.pathname.startsWith(TOKENDANCE_PAYMENT_SESSION_PATH_PREFIX);
}

/** TokenDance 官方域名（支付端点 origin 的 host，Portal 与网关同域）。 */
const TOKENDANCE_HOSTNAME = new URL(TOKENDANCE_PORTAL_API_URL).hostname.toLowerCase();

/**
 * 判断 provider 端点是否归属 TokenDance 官方域名（含子域）。
 * 放行 baseUrl 缺失的情况：内置安装一定写官方 baseUrl，此处缺失只意味着解析不到（不可判定），
 * 门禁不该因配置残缺而误拦；一旦给了地址且不是官方域名，就必须拦（防替中转账号充值）。
 */
export function isTokendanceOwnEndpoint(baseUrl: string | undefined): boolean {
	if (!baseUrl) return true;
	let host: string;
	try {
		host = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return false;
	}
	return host === TOKENDANCE_HOSTNAME || host.endsWith(`.${TOKENDANCE_HOSTNAME}`);
}

/**
 * Key 掩码（只留末 4 位）：让用户在支付前肉眼核对「充的是哪把 Key」，同时不落明文。
 * 短 Key（≤ 8 位）整体掩掉——末 4 位在那种长度下已近于全文。
 */
export function maskTokendanceApiKey(apiKey: string): string {
	const trimmed = apiKey.trim();
	return trimmed.length > 8 ? `••••${trimmed.slice(-4)}` : "••••";
}

/** TokenDance 充值会话 store：创建 + 查询，无状态（会话状态始终以服务端为准）。 */
export class TokendancePaymentStore {
	private resolveEndpoint: TokendancePaymentEndpointResolver;
	private request: TokendancePaymentRequest;

	constructor(deps: TokendancePaymentDeps) {
		this.resolveEndpoint = deps.resolveEndpoint;
		this.request = deps.request;
	}

	/** 创建充值会话：金额先过白名单校验，再带 Bearer Key POST。 */
	async createSession(amount: unknown): Promise<TokendancePaymentSessionResult> {
		if (!isValidTokendanceTopUpAmount(amount)) return { ok: false, code: "invalid-amount" };
		const auth = await this.authorize();
		if (!auth.ok) return auth;
		const response = await this.request(TOKENDANCE_PAYMENT_SESSIONS_URL, {
			method: "POST",
			headers: { ...auth.headers, "Content-Type": "application/json" },
			body: JSON.stringify({ amount }),
			timeoutMs: TOKENDANCE_PAYMENT_TIMEOUT_MS,
			maxBytes: TOKENDANCE_PAYMENT_MAX_BYTES,
		});
		const result = readSession(response);
		// 只在此处回目标 Key 掩码（每次轮询都回没必要）；失败结果不带任何 Key 痕迹。
		return result.ok ? { ...result, keyHint: auth.keyHint } : result;
	}

	/** 查询充值会话状态：只请求通过白名单的 status_url。 */
	async fetchSession(statusUrl: unknown): Promise<TokendancePaymentSessionResult> {
		if (typeof statusUrl !== "string" || !isAllowedTokendancePaymentStatusUrl(statusUrl)) {
			return { ok: false, code: "bad-status-url" };
		}
		const auth = await this.authorize();
		if (!auth.ok) return auth;
		const response = await this.request(statusUrl, {
			method: "GET",
			headers: auth.headers,
			timeoutMs: TOKENDANCE_PAYMENT_TIMEOUT_MS,
			maxBytes: TOKENDANCE_PAYMENT_MAX_BYTES,
		});
		return readSession(response);
	}

	/**
	 * 取 Bearer 头；未配置（无 Key）时回 not-configured，不把空 Key 发出去。
	 * 端点不归属 TokenDance 官方域名时回 endpoint-mismatch：Key 属于别家账号，充值会记错户。
	 */
	private async authorize(): Promise<{ ok: true; headers: Record<string, string>; keyHint: string } | { ok: false; code: TokendancePaymentErrorCode }> {
		let resolved: { baseUrl?: string; apiKey?: string } | undefined;
		try {
			resolved = await this.resolveEndpoint();
		} catch {
			// 端点解析失败与未配置同路返回：用户可执行的动作一样（先完成 TokenDance 配置）。
			resolved = undefined;
		}
		const apiKey = resolved?.apiKey?.trim();
		if (!apiKey) return { ok: false, code: "not-configured" };
		if (!isTokendanceOwnEndpoint(resolved?.baseUrl)) return { ok: false, code: "endpoint-mismatch" };
		return { ok: true, headers: { Authorization: `Bearer ${apiKey}` }, keyHint: maskTokendanceApiKey(apiKey) };
	}
}

/** 统一把传输层结果映射成会话结果（不把响应原文回传渲染层，避免泄漏服务端细节）。 */
function readSession(response: { status: number; raw: string } | { error: "timeout" | "network" }): TokendancePaymentSessionResult {
	if ("error" in response) return { ok: false, code: response.error };
	if (response.status < 200 || response.status >= 300) {
		return { ok: false, code: "http", detail: String(response.status) };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(response.raw);
	} catch {
		return { ok: false, code: "bad-response" };
	}
	const session = parseTokendancePaymentSession(parsed);
	if (!session) return { ok: false, code: "bad-response" };
	return { ok: true, session };
}
