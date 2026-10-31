/**
 * 瞬时失败分类器（纯函数、无依赖）。
 *
 * 为什么要自己判一遍：pi 的分类器（`pi-ai/dist/utils/retry.js`）是**白名单正则**，
 * 上游网关/undici 断开时常见的 `ECONNRESET`、`premature close`、`Unexpected end of JSON input`、
 * 网关回 HTML 的 `Unexpected token '<'`、纯文本 `Bad Gateway` 都不在名单里 —— 一次断开就被判死，
 * 用户看到的是「任务直接停止」。ACP 后端更是没有任何重试层，任何 JSON-RPC error 都是回合失败。
 *
 * 口径：终局（fatal）优先判定，剩下的才算瞬时。认不出的一律 `retry: true, kind: "unknown"`：
 * 调用方（ACP）只在「本轮还没有任何产出」时才重试，成本是两三次空请求，收益是不让用户手动重发；
 * 判定不出就停才是用户抱怨的那个故障。命中 unknown 的样本由调用方记日志留样，后续补进规则表。
 *
 * 这里是 `shared/` 纯契约层：只导出常量与纯函数，不 import 任何运行时/主进程模块。
 */

/** 瞬时失败的细分类别（仅用于日志与卡片 debugDetails）。 */
export type TransientFailureKind = "network" | "stream" | "gateway" | "rate-limit" | "timeout" | "unknown";

/** 终局失败的细分类别（重试也救不回来）。 */
export type FatalFailureKind = "cancelled" | "quota" | "auth" | "context-overflow" | "invalid-request" | "tls";

export type FailureVerdict =
	| { retry: true; kind: TransientFailureKind; reason: string }
	| { retry: false; kind: FatalFailureKind; reason: string };

export type ClassifyFailureInput = {
	/** 原始错误文本（JSON-RPC error.message / Error.message / CLI 输出片段）。 */
	message: string;
	/** HTTP 状态码（有就优先按码判定，比文本正则可靠）。 */
	status?: number;
	/** 用户主动中止：终局，永不重试。 */
	cancelled?: boolean;
};

type Rule = { kind: FatalFailureKind | TransientFailureKind; label: string; pattern: RegExp };

/**
 * 终局规则（按顺序先判）。
 *
 * 顺序有意义：`insufficient_quota` 里也含 "quota"，而 context overflow 文本常含 "too many tokens"
 * 又可能被 gateway 规则里的 "timeout" 命中 —— 终局必须先于瞬时。
 */
const FATAL_RULES: Rule[] = [
	{
		kind: "quota",
		label: "quota",
		pattern:
			/insufficient[ _-]?quota|exceeded your current quota|out of budget|available balance|billing|payment required|credit balance|top ?up|余额不足|余额|欠费|额度(?:已)?(?:用完|耗尽|不足)|配额不足|充值/,
	},
	{
		kind: "auth",
		label: "auth",
		pattern:
			/\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid[ _-]?api[ _-]?key|invalid[ _-]?(?:token|credential|key)|authentication (?:failed|error|required)|auth_required|not logged in|log ?in required|please (?:log ?in|authenticate)|missing (?:api )?key|未登录|登录已过期|认证失败/,
	},
	{
		kind: "context-overflow",
		label: "context-overflow",
		pattern:
			/context[ _-]?(?:length|window)[ _-]?(?:exceed|limit)|maximum context|too many tokens|prompt is too long|reduce the length|context length exceeded|上下文(?:长度)?超|超出(?:模型)?上下文/,
	},
	{
		kind: "invalid-request",
		label: "invalid-request",
		pattern:
			/\b400\b|\b404\b|\b405\b|\b413\b|\b422\b|bad request|invalid[ _-]?request|invalid[ _-]?param|method not found|not supported|unsupported (?:model|parameter|image|content)|model[ _-]not[ _-]found|does not exist|no such model/,
	},
	{
		kind: "tls",
		label: "tls",
		// 证书/握手失败不会自愈，重试只是拖长失败时间（企业代理环境常见）。
		pattern: /certificate|self[ _-]signed|unable to verify the first certificate|\bssl\b|tls handshake|err_tls_|cert_has_expired/,
	},
];

/** 瞬时规则（终局规则没命中时才轮到这里）。 */
const TRANSIENT_RULES: Rule[] = [
	{
		kind: "network",
		label: "errno",
		pattern:
			/\b(?:econnreset|econnrefused|econnaborted|epipe|etimedout|esockettimedout|enetunreach|ehostunreach|enetdown|eai_again|enotfound|eproto)\b|\bund_err_[a-z_]+\b|\berr_stream_premature_close\b/,
	},
	{
		kind: "stream",
		label: "transport",
		pattern:
			/premature close|socket hang up|other side closed|connection (?:reset|refused|closed|lost|aborted|terminated)|reset by peer|broken pipe|network (?:error|failure|unreachable)|fetch failed|getaddrinfo|upstream connect|reset before headers|unexpected eof|\beof\b|remote (?:end|server) closed|stream (?:was )?(?:interrupted|closed|ended|disconnected)|http\/?2 stream failed|websocket (?:closed|error)|closed before (?:response|message)|disconnected before/,
	},
	{
		kind: "stream",
		label: "body",
		// 网关 502 时回 HTML/半截 JSON，SDK 直接 JSON.parse 报这两种；空 body 同理。
		pattern:
			/unexpected token|unexpected end of (?:json|input|data)|invalid json|json parse|empty (?:response|body|reply|completion)|(?:response|body|reply) (?:is )?empty|no content|zero[ _-]?byte|truncated (?:response|body)/,
	},
	{
		kind: "rate-limit",
		label: "rate-limit",
		// 限流必须先于 gateway 判：429 的 body 里常同时出现 “please retry later”，
		// 那是限流不是网关故障。也刻意不把裸的「使用量已超出」写进 quota——
		// magpie 网关的真实文案是「您的使用量已超出频率限制，将在 … 重置」，那是限流。
		pattern: /rate[ _-]?limit|too many requests|throttl|频率限制|限流/,
	},
	{
		kind: "gateway",
		label: "gateway",
		pattern:
			/bad gateway|gateway time[ _-]?out|service unavailable|internal server error|upstream (?:request )?(?:failed|error)|unable to forward upstream|provider returned error|overloaded|server_busy|resource ?exhausted|try (?:your request )?again|please retry|retry your request|retry delay/,
	},
	{
		kind: "timeout",
		label: "timeout",
		pattern: /timed? out|time[ _-]?out|deadline exceeded/,
	},
];

/** 文本里裸的数字状态码（`429:` / `HTTP 502`）：只认网关常见的瞬时码。 */
const TEXT_STATUS_PATTERN = /(?<![a-z0-9])(4(?:08|25|29)|5(?:00|02|03|04|20|21|22|23|24|25|29|99))(?![a-z0-9])/;

/** 按 HTTP 状态码判定：5xx 与 408/425/429 瞬时，其余 4xx 终局。 */
function classifyStatus(status: number | undefined): FailureVerdict | undefined {
	if (status === undefined || !Number.isFinite(status)) return undefined;
	if (status === 429) return { retry: true, kind: "rate-limit", reason: "status:429" };
	if (status === 408 || status === 425) return { retry: true, kind: "timeout", reason: `status:${status}` };
	if (status >= 500 && status <= 599) return { retry: true, kind: "gateway", reason: `status:${status}` };
	if (status >= 400 && status <= 499) return { retry: false, kind: "invalid-request", reason: `status:${status}` };
	return undefined;
}

/**
 * 判定一次失败是否值得自动重试。
 *
 * 调用方必须自带「本轮已有产出就不重试」的门（见 `acpTurnRetry.ts`）：
 * 分类器只看错误文本，不可能知道这条流已经写出去多少 token。
 */
export function classifyFailure(input: ClassifyFailureInput): FailureVerdict {
	if (input.cancelled) return { retry: false, kind: "cancelled", reason: "cancelled" };

	const haystack = String(input.message ?? "").toLowerCase();
	const byStatus = classifyStatus(input.status);
	// 状态码只在硬终局（4xx）时直接采信；5xx/429 仍要走文本终局规则——
	// 有的网关回 500 但 body 是「insufficient_quota」，那种重试没意义。
	if (byStatus && !byStatus.retry) return byStatus;

	for (const rule of FATAL_RULES) {
		if (rule.pattern.test(haystack)) return { retry: false, kind: rule.kind as FatalFailureKind, reason: rule.label };
	}
	if (byStatus) return byStatus;
	for (const rule of TRANSIENT_RULES) {
		if (rule.pattern.test(haystack)) return { retry: true, kind: rule.kind as TransientFailureKind, reason: rule.label };
	}
	const codeMatch = TEXT_STATUS_PATTERN.exec(haystack);
	if (codeMatch) {
		const code = Number(codeMatch[1]);
		return classifyStatus(code) ?? { retry: true, kind: "gateway", reason: `text:${code}` };
	}
	return { retry: true, kind: "unknown", reason: "unclassified" };
}

/** 便捷判定：只要布尔。 */
export function isTransientFailure(input: ClassifyFailureInput): boolean {
	return classifyFailure(input).retry;
}

/** 错误的可读文本：Error 取 message，其余 String()（null/undefined 不放行 "null" 字面量）。 */
export function failureMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (error === null || error === undefined) return "";
	return typeof error === "string" ? error : String(error);
}
