import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * pi-deck-retry-no-body 扩展的契约与纯函数测试。
 *
 * 纯函数 isNoBodyError / isTransientError / makeRetryableErrorMessage /
 * makeTransientErrorMessage 以「副本」形式内联在下方，与
 * resources/extensions/pi-deck-retry-no-body.ts 保持同步（契约断言保证锚点一致）。
 * 内联副本避免测试文件 import pi 依赖（@earendil-works/pi-coding-agent 是 ESM + 运行时依赖）。
 */

// =========================================================================
// 纯函数副本（与 pi-deck-retry-no-body.ts 保持同步）
// =========================================================================

function isNoBodyError(errorMessage) {
	if (!errorMessage) return false;
	return /\(no body\)/i.test(errorMessage) || /no body\s*$/i.test(errorMessage) || /empty\s+response\s+body/i.test(errorMessage) || /no\s+response\s+body/i.test(errorMessage);
}

const ANTHROPIC_MESSAGE_APIS = new Set(["anthropic-messages", "anthropic"]);
const PI_OVERFLOW_ANCHORED_STATUS = /^4(?:00|13)\b/i;

function needsOverflowUnanchor(errorMessage, api) {
	const isAnthropic = typeof api === "string" && ANTHROPIC_MESSAGE_APIS.has(api);
	return !isAnthropic && PI_OVERFLOW_ANCHORED_STATUS.test(errorMessage);
}

const REWRITE_TAG_PATTERN = /\((?:connection error|overloaded)\)\s*$/i;

function makeRetryableErrorMessage(errorMessage, api) {
	const tagged = REWRITE_TAG_PATTERN.test(errorMessage) ? errorMessage : errorMessage + " (connection error)";
	return needsOverflowUnanchor(errorMessage, api) ? "transient upstream fault: " + tagged : tagged;
}

// --- 本地化 / 传输层瞬态故障识别（与扩展源码同步） ---

const NON_RETRYABLE_LOCALIZED_PATTERNS = [/额度|余额|配额|限额|上限|欠费|充值|扣费|计费/, /(api[_\s-]?key|密钥|令牌).{0,8}(无效|错误|过期|不存在)/i, /鉴权|认证|未授权|无权|禁止访问|已被禁用/, /不存在|未找到|找不到|不支持|不可用渠道/, /参数错误|格式错误|请求错误|非法|校验失败/];

const NON_RETRYABLE_HTTP_STATUS_PATTERN = /(?:^|[^0-9])(?:400|401|402|403|404|405|406|409|410|412|413|415|422|431)\b/;

const TRANSIENT_OVERLOAD_PATTERNS = [/访问量过大|流量过大|并发.*?过(?:大|高)|请求过快|频率过高/, /负载(?:过高|过大|满载)|压力过大|排队中|拥挤/, /服务繁忙|系统繁忙|业务繁忙|服务器繁忙|繁忙，请/];

const TRANSIENT_UPSTREAM_PATTERNS = [
	/暂时不可用|临时不可用|暂不可用|暂时无法(?:访问|响应|处理)|临时无法(?:访问|响应|处理)/,
	/上游.*?(?:不可用|异常|错误|超时|失败|中断)/,
	/(?:网关|代理|节点|渠道|链路).*?(?:异常|错误|超时|不可用|失败|中断|不稳定)/,
	/连接.*?(?:失败|超时|中断|重置|断开|被关闭)/,
	/(?:请求|响应|读取)超时/,
	/没有可用的?健康.*?账号|无可用的?健康.*?账号/,
	/正在(?:维护|重启|升级|恢复)|维护中|升级中|重启中/,
	/请稍后重试|请稍后再试|稍后重试|稍后再试|请重试|请重新尝试/,
];

const TRANSIENT_TRANSPORT_PATTERNS = [/^stream_read_error$/i, /unexpected\s+eof/i, /premature\s+close/i, /upstream\s+request\s+failed/i, /no\s+available\s+channel/i, /GOAWAY/i];

const ALREADY_RETRYABLE_SIGNALS = [/\b(?:429|500|502|503|504|524)\b/, /rate.?limit|too many requests|overloaded/i, /service.?unavailable|server.?error|internal.?error/i, /timed?\s*out|timeout|terminated/i, /connection.?error|socket hang up|fetch failed/i];

function isTransientError(errorMessage) {
	if (!errorMessage) return false;
	if (NON_RETRYABLE_LOCALIZED_PATTERNS.some((p) => p.test(errorMessage))) return false;
	if (NON_RETRYABLE_HTTP_STATUS_PATTERN.test(errorMessage)) return false;
	if (ALREADY_RETRYABLE_SIGNALS.some((p) => p.test(errorMessage))) return false;
	return TRANSIENT_OVERLOAD_PATTERNS.some((p) => p.test(errorMessage)) || TRANSIENT_UPSTREAM_PATTERNS.some((p) => p.test(errorMessage)) || TRANSIENT_TRANSPORT_PATTERNS.some((p) => p.test(errorMessage));
}

const OVERLOAD_TAG = "overloaded";
const CONNECTION_TAG = "connection error";

function makeTransientErrorMessage(errorMessage) {
	const isOverload = TRANSIENT_OVERLOAD_PATTERNS.some((p) => p.test(errorMessage));
	return `${errorMessage} (${isOverload ? OVERLOAD_TAG : CONNECTION_TAG})`;
}

/** 复刻扩展入口的改写判定：空响应优先，其次本地化/传输层瞬态。 */
function rewriteErrorMessage(message) {
	const errorMessage = message.errorMessage;
	if (!errorMessage) return undefined;
	if (isNoBodyError(errorMessage)) {
		const needsRewrite = needsOverflowUnanchor(errorMessage, message.api) || !ALREADY_RETRYABLE_SIGNALS.some((p) => p.test(errorMessage));
		if (!needsRewrite) return undefined;
		return makeRetryableErrorMessage(errorMessage, message.api);
	}
	if (isTransientError(errorMessage)) return makeTransientErrorMessage(errorMessage);
	return undefined;
}

// =========================================================================
// pi agent-session 层判定副本
// （pi ≤ 0.85：_isRetryableError = isContextOverflow 优先，其次 isRetryableAssistantError；
//   pi ≥ 0.86：上游已把 bodyless 400/413 移出溢出判定，本副本用于锁定 ≤0.85 的兜底口径）
// =========================================================================

/**
 * pi（≤0.85）的 OVERFLOW_PATTERNS 末条会把 `^4(00|13) (no body)` 判为上下文溢出，
 * 命中后走压缩恢复而非重试。这是 400 空响应「不重试」的真正原因，
 * 只补 `(connection error)` 无法绕过（正则锚定开头）。
 */
const OVERFLOW_PATTERNS = [/prompt is too long/i, /request_too_large/i, /exceeds the context window/i, /context[_ ]length[_ ]exceeded/i, /too many tokens/i, /token limit exceeded/i, /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i];
const NON_OVERFLOW_PATTERNS = [/^(Throttling error|Service unavailable):/i, /rate limit/i, /too many requests/i];

function isContextOverflow(message) {
	const errorMessage = message.errorMessage;
	if (message.stopReason !== "error" || !errorMessage) return false;
	if (NON_OVERFLOW_PATTERNS.some((p) => p.test(errorMessage))) return false;
	return OVERFLOW_PATTERNS.some((p) => p.test(errorMessage));
}

// =========================================================================
// pi 重试判定副本（与 pi-ai/dist/utils/retry.js 的 isRetryableAssistantError 一致）
// =========================================================================

const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN = new RegExp(["GoUsageLimitError", "FreeUsageLimitError", "Monthly usage limit reached", "available balance", "insufficient_quota", "out of budget", "quota exceeded", "billing"].join("|"), "i");

const RETRYABLE_PROVIDER_ERROR_PATTERN = new RegExp(
	[
		"overloaded",
		"rate.?limit",
		"too many requests",
		"429",
		"500",
		"502",
		"503",
		"504",
		"524",
		"service.?unavailable",
		"server.?error",
		"internal.?error",
		"provider.?returned.?error",
		"network.?error",
		"connection.?error",
		"connection.?refused",
		"connection.?lost",
		"other side closed",
		"fetch failed",
		"getaddrinfo",
		"ENOTFOUND",
		"EAI_AGAIN",
		"upstream.?connect",
		"reset before headers",
		"socket hang up",
		"socket connection was closed",
		"timed? out",
		"timeout",
		"terminated",
		"websocket.?closed",
		"websocket.?error",
	].join("|"),
	"i",
);

function isRetryableAssistantError(message) {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	const errorMessage = message.errorMessage;
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}

/** 复刻 pi 的 _isRetryableError：溢出判定优先于重试判定。 */
function piWillRetry(message) {
	if (isContextOverflow(message)) return false;
	return isRetryableAssistantError(message);
}

/**
 * pi ≥ 0.86 的溢出判定副本：上游已把 bodyless 400/413 末条移出 OVERFLOW_PATTERNS
 * （实测 0.86.1：`400 status code (no body)` 的 isContextOverflow=false）。
 * 但 400/413 仍不在重试名单里 —— 改写必须保留 `(connection error)`。
 */
const OVERFLOW_PATTERNS_086 = [/prompt is too long/i, /request_too_large/i, /exceeds the context window/i, /context[_ ]length[_ ]exceeded/i, /too many tokens/i, /token limit exceeded/i];

function isContextOverflow086(message) {
	const errorMessage = message.errorMessage;
	if (message.stopReason !== "error" || !errorMessage) return false;
	if (NON_OVERFLOW_PATTERNS.some((p) => p.test(errorMessage))) return false;
	return OVERFLOW_PATTERNS_086.some((p) => p.test(errorMessage));
}

// =========================================================================
// 纯函数行为测试
// =========================================================================

test("isNoBodyError 识别 thetoken 风格空响应", () => {
	assert.equal(isNoBodyError("400 status code (no body)"), true);
	assert.equal(isNoBodyError("503 status code (no body)"), true);
	assert.equal(isNoBodyError("502 status code (no body)"), true);
	assert.equal(isNoBodyError("400 STATUS CODE (NO BODY)"), true);
});

test("isNoBodyError 识别其他空响应变体", () => {
	assert.equal(isNoBodyError("empty response body"), true);
	assert.equal(isNoBodyError("no response body"), true);
	assert.equal(isNoBodyError("request failed no body"), true);
});

test("isNoBodyError 不误伤有 body 的真实错误", () => {
	assert.equal(isNoBodyError("400 Bad Request"), false);
	assert.equal(isNoBodyError("Request failed with status 400"), false);
	assert.equal(isNoBodyError("insufficient_quota"), false);
	assert.equal(isNoBodyError("context length exceeded"), false);
	assert.equal(isNoBodyError(""), false);
	assert.equal(isNoBodyError(undefined), false);
});

test("makeRetryableErrorMessage 追加连接错误说明并保留原文", () => {
	assert.equal(makeRetryableErrorMessage("503 status code (no body)"), "503 status code (no body) (connection error)");
});

test("makeRetryableErrorMessage 对 400/413 破锚，对其它状态码不破锚", () => {
	assert.equal(makeRetryableErrorMessage("400 status code (no body)", "openai-completions"), "transient upstream fault: 400 status code (no body) (connection error)");
	assert.equal(makeRetryableErrorMessage("413 status code (no body)", "openai-completions"), "transient upstream fault: 413 status code (no body) (connection error)");
	// 503 本就可重试，无需破锚，保留原文便于诊断
	assert.equal(makeRetryableErrorMessage("503 status code (no body)", "openai-completions"), "503 status code (no body) (connection error)");
});

test("makeRetryableErrorMessage 对 anthropic api 不破锚（保留 pi 的压缩恢复路径）", () => {
	assert.equal(makeRetryableErrorMessage("400 status code (no body)", "anthropic-messages"), "400 status code (no body) (connection error)");
});

// =========================================================================
// 核心契约：改写让 400 空响应真正进入 pi 的重试闭环（含溢出误判这一关）
// =========================================================================

test("原始 400 空响应被 pi 判为上下文溢出而跳过重试（问题的根源）", () => {
	const original = {
		stopReason: "error",
		errorMessage: "400 status code (no body)",
		api: "openai-completions",
	};
	assert.equal(isContextOverflow(original), true);
	assert.equal(piWillRetry(original), false);
});

test("只追加 connection error 无法绕过溢出误判（pi ≤0.85 回归防护）", () => {
	// 这是 0.84.x 之前有效的旧方案：命中重试名单，却被溢出判定抢先拦截
	const legacy = {
		stopReason: "error",
		errorMessage: "400 status code (no body) (connection error)",
		api: "openai-completions",
	};
	assert.equal(isRetryableAssistantError(legacy), true);
	assert.equal(isContextOverflow(legacy), true);
	assert.equal(piWillRetry(legacy), false);
});

test("破锚改写后 400 空响应不再被判溢出，进入 pi 重试", () => {
	const rewritten = {
		stopReason: "error",
		errorMessage: makeRetryableErrorMessage("400 status code (no body)", "openai-completions"),
		api: "openai-completions",
	};
	assert.equal(isContextOverflow(rewritten), false);
	assert.equal(isRetryableAssistantError(rewritten), true);
	assert.equal(piWillRetry(rewritten), true);
});

test("400 空响应版本矩阵：≤0.85 靠破锚，≥0.86 破锚无害且标注仍必需", () => {
	const raw = { stopReason: "error", errorMessage: "400 status code (no body)", api: "openai-completions" };
	// ≤0.85：原文被溢出误判拦下，重试根本不发生（破锚的原因）
	assert.equal(piWillRetry(raw), false);
	// ≥0.86：上游已修掉溢出误判，但原文依旧不在重试名单里
	assert.equal(isContextOverflow086(raw), false);
	assert.equal(isRetryableAssistantError(raw), false);

	const rewritten = { ...raw, errorMessage: makeRetryableErrorMessage(raw.errorMessage, raw.api) };
	// 改写后两个版本都必须进入重试闭环（破锚对 ≥0.86 无副作用，(connection error) 不可省）
	assert.equal(piWillRetry(rewritten), true);
	assert.equal(isContextOverflow086(rewritten), false);
	assert.equal(isRetryableAssistantError(rewritten), true);
});

test("anthropic 的 400 空响应仍走压缩恢复而非重试", () => {
	const anthropic = {
		stopReason: "error",
		errorMessage: makeRetryableErrorMessage("400 status code (no body)", "anthropic-messages"),
		api: "anthropic-messages",
	};
	assert.equal(isContextOverflow(anthropic), true);
	assert.equal(piWillRetry(anthropic), false);
});

test("503 空响应原始即可重试（对照组：网关空响应本应重试）", () => {
	const original = {
		stopReason: "error",
		errorMessage: "503 status code (no body)",
		api: "openai-completions",
	};
	assert.equal(piWillRetry(original), true);
});

test("真实上下文溢出错误不会被破锚改写误判为可重试", () => {
	const overflow = { stopReason: "error", errorMessage: "context length exceeded" };
	assert.equal(isNoBodyError(overflow.errorMessage), false);
	assert.equal(piWillRetry(overflow), false);
});

test("额度耗尽错误不会被误判为重试（改写只对空响应生效）", () => {
	const quota = { stopReason: "error", errorMessage: "insufficient_quota" };
	assert.equal(isRetryableAssistantError(quota), false);
	// 改写函数只追加连接说明，不改额度类文本；即便追加也不应命中额度拦截之外的可重试词
	assert.equal(isNoBodyError("insufficient_quota"), false);
});

// =========================================================================
// 本地化（中文）瞬态文案：pi 全英文名单命中不了，需扩展救援
// =========================================================================

test("中文「模型服务暂时不可用，请稍后重试」原本 pi 不重试（用户实测的失败场景）", () => {
	const original = {
		stopReason: "error",
		errorMessage: "模型服务暂时不可用，请稍后重试",
		api: "openai-completions",
	};
	assert.equal(isNoBodyError(original.errorMessage), false);
	assert.equal(piWillRetry(original), false);
});

test("中文瞬态文案改写后进入 pi 重试闭环", () => {
	const message = {
		stopReason: "error",
		errorMessage: "模型服务暂时不可用，请稍后重试",
		api: "openai-completions",
	};
	const rewritten = rewriteErrorMessage(message);
	assert.equal(rewritten, "模型服务暂时不可用，请稍后重试 (connection error)");
	assert.equal(piWillRetry({ ...message, errorMessage: rewritten }), true);
	// 原文完整保留，会话历史仍可诊断
	assert.match(rewritten, /^模型服务暂时不可用，请稍后重试/);
});

test("过载类中文文案标注为 overloaded 并可重试", () => {
	const message = {
		stopReason: "error",
		errorMessage: "该模型当前访问量过大，请您稍后再试",
		api: "openai-completions",
	};
	const rewritten = rewriteErrorMessage(message);
	assert.equal(rewritten, "该模型当前访问量过大，请您稍后再试 (overloaded)");
	assert.equal(piWillRetry({ ...message, errorMessage: rewritten }), true);
});

test("上游/网关类中文文案标注为 connection error 并可重试", () => {
	for (const errorMessage of ["上游服务暂不可用", "网关响应异常，请稍后重试", "连接被上游重置", "服务正在重启，请稍后重试"]) {
		const message = { stopReason: "error", errorMessage, api: "openai-completions" };
		const rewritten = rewriteErrorMessage(message);
		assert.match(rewritten, /\(connection error\)$/, errorMessage);
		assert.equal(piWillRetry({ ...message, errorMessage: rewritten }), true, `应可重试: ${errorMessage}`);
	}
});

// =========================================================================
// 排除规则：不该重试的中文文案绝不能被救活
// =========================================================================

test("额度/配额类中文文案不改写（重试无意义）", () => {
	for (const errorMessage of ["您已达到每周/每月使用上限，您的限额将在 2026-09-02 重置。", "403 用户额度不足, 剩余额度: ＄-2.521900", "预扣费额度失败, 用户剩余额度: ¥0.247150", "api key 7天限额已用完"]) {
		const message = { stopReason: "error", errorMessage, api: "openai-completions" };
		assert.equal(rewriteErrorMessage(message), undefined, `不应改写: ${errorMessage}`);
	}
});

test("鉴权/模型不存在/请求构造错误类中文文案不改写", () => {
	for (const errorMessage of ["404: 模型不存在", "API Key 无效或已过期", "您无权访问该模型", "请求参数错误：messages 格式非法"]) {
		const message = { stopReason: "error", errorMessage, api: "openai-completions" };
		assert.equal(rewriteErrorMessage(message), undefined, `不应改写: ${errorMessage}`);
	}
});

test("已含 pi 重试锚点的文案不改写（避免无意义后缀）", () => {
	// 这些 pi 自己就能重试，扩展不该插手
	for (const errorMessage of ['429: {"message":"该模型当前访问量过大，请您稍后再试"}', '503: {"code":"upstream_unavailable","message":"上游服务暂不可用"}', '500: {"message":"没有可用的健康 CPA 出口账号"}', "上游服务连接超时 timeout"]) {
		const message = { stopReason: "error", errorMessage, api: "openai-completions" };
		assert.equal(rewriteErrorMessage(message), undefined, `不应改写: ${errorMessage}`);
		assert.equal(piWillRetry(message), true, `pi 本就应重试: ${errorMessage}`);
	}
});

test("用户主动中止（aborted）绝不重试——否则已停止的会话会复活", () => {
	for (const errorMessage of ["Request was aborted.", "Request aborted", "Operation aborted", "This operation was aborted"]) {
		const message = { stopReason: "error", errorMessage, api: "openai-completions" };
		assert.equal(rewriteErrorMessage(message), undefined, `不应改写: ${errorMessage}`);
		assert.equal(piWillRetry(message), false, `不应重试: ${errorMessage}`);
	}
});

// =========================================================================
// 传输层瞬态错误（英文，pi 名单漏掉）
// =========================================================================

test("传输层瞬态错误改写后进入 pi 重试闭环", () => {
	for (const errorMessage of ["stream_read_error", "unexpected EOF", "Upstream request failed", "http2: server sent GOAWAY and closed the connection; LastStreamID=21, ErrCode=NO_ERROR"]) {
		const message = { stopReason: "error", errorMessage, api: "openai-completions" };
		assert.equal(piWillRetry(message), false, `改写前不应重试: ${errorMessage}`);
		const rewritten = rewriteErrorMessage(message);
		assert.ok(rewritten, `应改写: ${errorMessage}`);
		assert.equal(piWillRetry({ ...message, errorMessage: rewritten }), true, `改写后应重试: ${errorMessage}`);
	}
});

test("带 4xx 的文案不改写——即便含 Upstream request failed 字样", () => {
	// 真实误伤案例：含 transport 关键词，但真实原因是 403 region 限制 / 400 参数非法
	for (const errorMessage of [
		'OpenAI API error (403): {"message":"Upstream request failed: [403] This model is not available in your region."}',
		'400: {"type":"invalid_request_error","message":"Error from provider (Console Go): Upstream request failed: [bad_request] bad request: max_tokens"}',
		"404: model is not found",
		"413: payload too large",
	]) {
		const message = { stopReason: "error", errorMessage, api: "openai-completions" };
		assert.equal(rewriteErrorMessage(message), undefined, `不应改写: ${errorMessage}`);
	}
});

test("pi 名单已覆盖的状态码空响应保持原文（不给气泡加噪音）", () => {
	for (const errorMessage of ["500 status code (no body)", "503 status code (no body)", "502 status code (no body)"]) {
		const message = { stopReason: "error", errorMessage, api: "openai-completions" };
		assert.equal(rewriteErrorMessage(message), undefined, `不应改写: ${errorMessage}`);
		assert.equal(piWillRetry(message), true, `pi 本就应重试: ${errorMessage}`);
	}
});

test("幂等：旧版扩展已改写过的文案只补前缀，不重复追加标注", () => {
	const message = {
		stopReason: "error",
		errorMessage: "400 status code (no body) (connection error)",
		api: "openai-completions",
	};
	const rewritten = rewriteErrorMessage(message);
	assert.equal(rewritten, "transient upstream fault: 400 status code (no body) (connection error)");
	assert.equal(piWillRetry({ ...message, errorMessage: rewritten }), true);
});

test("408 空响应仍被救援（Request Timeout 属瞬态，不在 4xx 排除表内）", () => {
	const message = {
		stopReason: "error",
		errorMessage: "408 status code (no body)",
		api: "openai-completions",
	};
	assert.equal(piWillRetry(message), false);
	const rewritten = rewriteErrorMessage(message);
	assert.equal(rewritten, "408 status code (no body) (connection error)");
	assert.equal(piWillRetry({ ...message, errorMessage: rewritten }), true);
});

test("泛化错误不改写（信息不足，宁可漏判）", () => {
	for (const errorMessage of ["Provider finish_reason: error", "Provider finish_reason: repetition_truncation"]) {
		const message = { stopReason: "error", errorMessage, api: "openai-completions" };
		assert.equal(rewriteErrorMessage(message), undefined, `不应改写: ${errorMessage}`);
	}
});

// =========================================================================
// 契约：扩展源码结构与注册
// =========================================================================

const extensionSource = readFileSync("resources/extensions/pi-deck-retry-no-body.ts", "utf8");
const builtInsSource = readFileSync("src/main/extensions/builtInExtensions.ts", "utf8");

test("扩展注册了 message_end 拦截与纯函数", () => {
	assert.match(extensionSource, /pi\.on\("message_end"/);
	assert.match(extensionSource, /export function isNoBodyError/);
	assert.match(extensionSource, /export function isTransientError/);
	assert.match(extensionSource, /export function makeRetryableErrorMessage/);
	assert.match(extensionSource, /export function makeTransientErrorMessage/);
	assert.match(extensionSource, /message\.role !== "assistant"/);
	assert.match(extensionSource, /message\.stopReason !== "error"/);
	// 展开保留其余字段，避免 _replaceMessageInPlace 删掉 content/api/usage
	assert.match(extensionSource, /\.\.\.message,\s*\n\s*errorMessage:/);
});

test("扩展先判空响应再判其它瞬态，并对排除项不改写", () => {
	// 空响应优先（需要 api 参与破锚判断），其次本地化/传输层瞬态
	assert.match(extensionSource, /if \(isNoBodyError\(errorMessage\)\) \{/);
	assert.match(extensionSource, /\} else if \(isTransientError\(errorMessage\)\) \{/);
	// 黑名单优先于白名单：额度/鉴权/模型不存在不得被救活
	assert.match(extensionSource, /NON_RETRYABLE_LOCALIZED_PATTERNS/);
	// 已能被 pi 重试的文案不重复改写
	assert.match(extensionSource, /ALREADY_RETRYABLE_SIGNALS/);
	assert.match(extensionSource, /TRANSIENT_TRANSPORT_PATTERNS/);
});

test("扩展按 api 区分改写，并对 400/413 解除 pi 溢出误判", () => {
	// 破锚前缀：pi 的溢出正则锚定开头 ^，前置标记即可解除误判
	assert.match(extensionSource, /transient upstream fault: /);
	assert.match(extensionSource, /PI_OVERFLOW_ANCHORED_STATUS/);
	// anthropic 系保持原样，留给 pi 的压缩恢复
	assert.match(extensionSource, /ANTHROPIC_MESSAGE_APIS/);
	assert.match(extensionSource, /typeof message\.api === "string"/);
});

test("扩展已注册进 BUILT_IN_EXTENSIONS 白名单", () => {
	assert.match(builtInsSource, /"pi-deck-retry-no-body\.ts"/);
});
