/**
 * PiDeck Retry Transient Extension（文件名沿用 pi-deck-retry-no-body，保持向后兼容）
 *
 * 背景：中转网关（如 thetoken）偶发返回瞬态故障，但错误文案落在 pi 的重试名单之外，
 * 导致会话直接失败停止。pi 的 `isRetryableAssistantError` 只按 `errorMessage` 文本
 * 匹配一张**全英文**名单（429/500/502/503/504/524 与 `connection error` 等关键词）。
 * 实测本机会话里有三类漏网之鱼：
 *
 *   1. `400 status code (no body)` —— 网关空响应，400/413 不在重试名单里。
 *      破锚需求随 pi 版本变化（详见 makeRetryableErrorMessage 注释）：
 *      - pi ≤ 0.85：该文案还会被溢出正则
 *        `/^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i` 误判为上下文溢出，
 *        走压缩恢复而非重试，必须破锚；
 *      - pi ≥ 0.86：上游已把 bodyless 400/413 移出溢出判定（不再误判），破锚
 *        变成冗余但无害，为兼容仍在用旧版 pi 的用户保留。
 *      两个版本都必须追加 `(connection error)` 才算进重试名单。
 *   2. `模型服务暂时不可用，请稍后重试` —— 中文文案，名单里一个词都命中不了。
 *   3. `stream_read_error` / `unexpected EOF` / HTTP2 `GOAWAY` —— 传输层瞬态错误，
 *      同样不在名单里。
 *
 * 方案：本扩展在 `message_end` 事件里拦截 assistant 错误消息，识别上述瞬态故障，
 * 把 `errorMessage` 改写成既命中 pi 重试名单、又不触发 pi 上下文溢出误判的文本。
 * 从而让 pi 的 `_isRetryableError` → `_prepareRetry` 完整闭环生效：
 *
 *   - 指数退避：delayMs = baseDelayMs * 2^(attempt-1)（默认 2s/4s/8s，可设置）
 *   - 最大次数：settings.retry.maxRetries 上限，超出后发 auto_retry_end{success:false}
 *   - 可中止：重试 sleep 期间可被 abort 取消
 *   - 不污染会话：_prepareRetry 会从 agent state 移除 error 消息再重发
 *   - UI 事件：auto_retry_start/end 原生触发，PiDeck 气泡显示「重试中」无需额外处理
 *
 * 为什么不直接改状态码为 503：那会篡改事实、丢失「网关报的是 400」这一诊断
 * 信息。追加说明词既保留原文又诚实表达「这是连接层瞬态故障，正在重试」。
 *
 * @packageDocumentation
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// 纯函数：空响应错误识别与改写（不依赖 pi API，便于独立测试）
// ---------------------------------------------------------------------------

/**
 * 判断错误信息是否为「空响应」类网关故障。
 *
 * 匹配特征（不区分大小写）：
 * - `400 status code (no body)` / `503 status code (no body)` — thetoken 网关格式
 * - `...no body` 结尾 — 省略状态码前缀的变体
 * - `empty response body` / `no response body` — 其他网关的通用表述
 *
 * 边界条件：只匹配「空响应」这一确定性特征，不匹配任意 400/5xx——避免误伤
 * 真正的请求构造错误（那些错误有 body 说明原因，重试无意义）。
 *
 * @param errorMessage - assistant 消息的 errorMessage 字段
 * @returns 是否为空响应类故障
 */
export function isNoBodyError(errorMessage: string): boolean {
	if (!errorMessage) return false;
	return (
		/\(no body\)/i.test(errorMessage) ||
		/no body\s*$/i.test(errorMessage) ||
		/empty\s+response\s+body/i.test(errorMessage) ||
		/no\s+response\s+body/i.test(errorMessage)
	);
}

/**
 * 明确不该重试的本地化文案。
 *
 * 中转网关把「额度/鉴权/模型不存在/请求构造错误」也用中文返回，这些重试一百次
 * 也是同样的结果，且会掩盖真正的配置问题。优先级高于瞬态白名单。
 */
const NON_RETRYABLE_LOCALIZED_PATTERNS: RegExp[] = [
	/额度|余额|配额|限额|上限|欠费|充值|扣费|计费/,
	/(api[_\s-]?key|密钥|令牌).{0,8}(无效|错误|过期|不存在)/i,
	/鉴权|认证|未授权|无权|禁止访问|已被禁用/,
	/不存在|未找到|找不到|不支持|不可用渠道/,
	/参数错误|格式错误|请求错误|非法|校验失败/,
];

/**
 * 4xx 客户端错误状态码。
 *
 * 带 4xx 的文案说明服务端明确拒绝了请求（region 不可用、参数非法、鉴权失败等），
 * 重试必然复现。典型误伤：
 * `Upstream request failed: [403] This model is not available in your region.` ——
 * 它含 `Upstream request failed` 字样，但真实原因是 403 region 限制。
 *
 * 不含 408（Request Timeout，属瞬态）与 429（限流，pi 名单已覆盖，重试合理）。
 * 空响应类的 `400 status code (no body)` 走 isNoBodyError 分支，不受此规则影响。
 */
const NON_RETRYABLE_HTTP_STATUS_PATTERN =
	/(?:^|[^0-9])(?:400|401|402|403|404|405|406|409|410|412|413|415|422|431)\b/;

/** 过载类本地化文案：命中后标注为 overloaded。 */
const TRANSIENT_OVERLOAD_PATTERNS: RegExp[] = [
	/访问量过大|流量过大|并发.*?过(?:大|高)|请求过快|频率过高/,
	/负载(?:过高|过大|满载)|压力过大|排队中|拥挤/,
	/服务繁忙|系统繁忙|业务繁忙|服务器繁忙|繁忙，请/,
];

/** 上游/连接类本地化文案：命中后标注为 connection error。 */
const TRANSIENT_UPSTREAM_PATTERNS: RegExp[] = [
	/暂时不可用|临时不可用|暂不可用|暂时无法(?:访问|响应|处理)|临时无法(?:访问|响应|处理)/,
	/上游.*?(?:不可用|异常|错误|超时|失败|中断)/,
	/(?:网关|代理|节点|渠道|链路).*?(?:异常|错误|超时|不可用|失败|中断|不稳定)/,
	/连接.*?(?:失败|超时|中断|重置|断开|被关闭)/,
	/(?:请求|响应|读取)超时/,
	/没有可用的?健康.*?账号|无可用的?健康.*?账号/,
	/正在(?:维护|重启|升级|恢复)|维护中|升级中|重启中/,
	/请稍后重试|请稍后再试|稍后重试|稍后再试|请重试|请重新尝试/,
];

/**
 * 传输层瞬态错误（英文，实测会话中反复出现且确实重发即成功）。
 * 这些都不含 pi 重试名单里的任何关键词，因此会直接导致会话失败停止。
 */
const TRANSIENT_TRANSPORT_PATTERNS: RegExp[] = [
	/^stream_read_error$/i,
	/unexpected\s+eof/i,
	/premature\s+close/i,
	/upstream\s+request\s+failed/i,
	/no\s+available\s+channel/i,
	/GOAWAY/i,
];

/**
 * pi 已能自行重试的信号。
 *
 * 若原文已含这些锚点（如 `429: {...中文...}`、`503: {...}`），pi 的重试判定本就
 * 会命中，扩展不应再插手——否则只是给错误气泡多加一段无意义后缀。
 */
const ALREADY_RETRYABLE_SIGNALS: RegExp[] = [
	/\b(?:429|500|502|503|504|524)\b/,
	/rate.?limit|too many requests|overloaded/i,
	/service.?unavailable|server.?error|internal.?error/i,
	/timed?\s*out|timeout|terminated/i,
	/connection.?error|socket hang up|fetch failed/i,
];

/**
 * 判断错误信息是否为「应重试但 pi 识别不了」的瞬态故障。
 *
 * 覆盖两类 pi 名单漏掉的瞬态故障：
 * 1. 本地化（中文）文案 —— 中转网关常把上游故障翻译成中文，
 *    其中没有一个词落在 pi 的全英文重试名单里。
 * 2. 传输层错误 —— `stream_read_error` / `unexpected EOF` / HTTP2 `GOAWAY` 等。
 *
 * 排除原则（宁可漏判，不可误判）：
 * - 额度/鉴权/模型不存在/请求构造错误 → 重试无意义（黑名单优先）
 * - 带 4xx 状态码 → 服务端明确拒绝，重试必然复现（如 403 region 限制）
 * - 已含 pi 重试锚点的文案 → 交给 pi，扩展不改写
 * - 用户主动中止（`Request was aborted` / `Operation aborted`）→ **不重试**。
 *   这是刻意排除的：abort 通常是用户点了停止，自动重发会让已停止的会话"复活"。
 *
 * @param errorMessage - assistant 消息的 errorMessage 字段
 * @returns 是否应被改写为可重试
 */
export function isTransientError(errorMessage: string): boolean {
	if (!errorMessage) return false;
	if (NON_RETRYABLE_LOCALIZED_PATTERNS.some((p) => p.test(errorMessage))) return false;
	if (NON_RETRYABLE_HTTP_STATUS_PATTERN.test(errorMessage)) return false;
	if (ALREADY_RETRYABLE_SIGNALS.some((p) => p.test(errorMessage))) return false;
	return (
		TRANSIENT_OVERLOAD_PATTERNS.some((p) => p.test(errorMessage)) ||
		TRANSIENT_UPSTREAM_PATTERNS.some((p) => p.test(errorMessage)) ||
		TRANSIENT_TRANSPORT_PATTERNS.some((p) => p.test(errorMessage))
	);
}

/** 过载瞬态错误的英文标注（命中 pi 重试名单的 `overloaded`）。 */
const OVERLOAD_TAG = "overloaded";
/** 上游/连接瞬态错误的英文标注（命中 pi 重试名单的 `connection.?error`）。 */
const CONNECTION_TAG = "connection error";

/**
 * 给瞬态故障文案追加 pi 可识别的英文标注。
 *
 * 保留原文并追加括号标注（而非替换），用户气泡仍能看到网关的原始中文文案，
 * 会话历史可诊断；追加的英文词命中 pi 的 `RETRYABLE_PROVIDER_ERROR_PATTERN`。
 *
 * 标注按语义分派：过载类用 `overloaded`，上游/连接/超时类用 `connection error`。
 * 这类本地化文案不会命中 pi 的溢出正则（后者全为英文），因此无需破锚前缀。
 *
 * @param errorMessage - 原始错误信息
 * @returns 追加标注后的可重试错误信息
 */
export function makeTransientErrorMessage(errorMessage: string): string {
	const isOverload = TRANSIENT_OVERLOAD_PATTERNS.some((p) => p.test(errorMessage));
	return `${errorMessage} (${isOverload ? OVERLOAD_TAG : CONNECTION_TAG})`;
}

/** pi 的 anthropic 系 api 标识：这些 api 的 400/413 + 空 body 多为真实上下文溢出。 */
const ANTHROPIC_MESSAGE_APIS = new Set(["anthropic-messages", "anthropic"]);

/** pi 溢出正则 `/^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i` 的状态码前缀部分。 */
const PI_OVERFLOW_ANCHORED_STATUS = /^4(?:00|13)\b/i;

/**
 * 把空响应错误改写为可重试文本，使其命中 pi 内置重试名单。
 *
 * 需要做两件事，缺一不可：
 *
 * 1. 追加 ` (connection error)`：命中 agent-session 的 `isRetryableAssistantError`
 *    名单中的 `connection.?error`，让错误进入 `_prepareRetry` 完整重试闭环。
 *
 * 2. 必要时在开头前置 `transient upstream fault: `：pi ≤ 0.85 的 agent-session
 *    `_isRetryableError` 会**先**判 `isContextOverflow`，溢出判定优先于重试判定：
 *
 *      OVERFLOW_PATTERNS 末条 = /^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i
 *
 *    这是 pi 为 Anthropic「超长脉冲突发返回 400/413 + 空 body」加的启发式，命中后
 *    走压缩恢复而不是重试。中转网关（thetoken 等）把瞬态故障也报成
 *    `400 status code (no body)` 时会误命中 —— 会话直接失败停止，重试根本不发生。
 *    （实测 pi 0.84.4：503 空响应能重试，400 空响应不能，差别就在这一条。）
 *    该正则锚定开头 `^`，所以前置任意标记即可解除误判；原文与状态码完整保留。
 *
 *    版本矩阵（2026-09 核对）：pi 0.86 起上游已修掉该误判（实测 0.86.1：
 *    `400 status code (no body)` 的 isContextOverflow=false，但仍不在重试名单里）。
 *    因此破锚前缀对 ≥0.86 是冗余但无害的兼容手段，保留以覆盖继续使用旧版 pi 的
 *    用户；等最低支持版本抬升后再按兼容代码移除规则清理。
 *
 * Anthropic 例外：`api` 为 anthropic 系时不做前置，让 pi 按设计走压缩恢复 ——
 * 那里的 400 + 空 body 确实大概率是 prompt 超长，重试无意义。
 *
 * @param errorMessage - 原始错误信息
 * @param api - assistant 消息的 api 标识（如 openai-completions / anthropic-messages）
 * @returns 改写后的可重试错误信息
 */
/**
 * 判断空响应错误是否需要「破锚」以解除 pi 的上下文溢出误判。
 *
 * 只有 pi ≤ 0.85 需要：0.86 起上游已把 bodyless 400/413 移出溢出判定。
 * 保留是兼容仍在用旧版 pi 的用户（破锚文本对 ≥0.86 无副作用），
 * 移除条件与 `docs/pi-compatibility.md` 的兼容代码移除规则一致。
 *
 * @param errorMessage - 原始错误信息
 * @param api - assistant 消息的 api 标识
 * @returns 是否需要在开头前置 `transient upstream fault: `
 */
export function needsOverflowUnanchor(errorMessage: string, api?: string): boolean {
	const isAnthropic = typeof api === "string" && ANTHROPIC_MESSAGE_APIS.has(api);
	// 仅当原文以 400/413 开头时才需要破锚，其它状态码（如 503）本来就能重试。
	return !isAnthropic && PI_OVERFLOW_ANCHORED_STATUS.test(errorMessage);
}

/** 改写标注：用于幂等判断，避免重复追加。 */
const REWRITE_TAG_PATTERN = /\((?:connection error|overloaded)\)\s*$/i;

/**
 * 幂等改写：已带标注的文案只补前缀、不重复追加（兼容旧版扩展改写过的会话）。
 */
export function makeRetryableErrorMessage(errorMessage: string, api?: string): string {
	const tagged = REWRITE_TAG_PATTERN.test(errorMessage)
		? errorMessage
		: `${errorMessage} (connection error)`;
	return needsOverflowUnanchor(errorMessage, api)
		? `transient upstream fault: ${tagged}`
		: tagged;
}

// ---------------------------------------------------------------------------
// Pi 扩展入口
// ---------------------------------------------------------------------------

/**
 * PiDeck 内置扩展：让「空响应」类错误复用 pi 的内置重试机制。
 *
 * 挂载到 `message_end` 事件，只处理 assistant + stopReason=error + 空响应。
 * 通过返回 `{ message }` 原地替换 finalized message（agent-session 的
 * `emitMessageEnd` 会 `_replaceMessageInPlace` 改写同一对象），改写发生在
 * `_lastAssistantMessage` 赋值与 `_handlePostAgentRun` 重试判定之前，
 * 因此改写后的 errorMessage 会被 pi 当作「原始错误」参与重试判定。
 */
export default function (pi: ExtensionAPI): void {
	pi.on("message_end", ({ message }) => {
		// 只处理 assistant 的错误消息（user/toolResult/custom 消息直接透传）
		if (message.role !== "assistant") return;
		if (message.stopReason !== "error") return;

		const errorMessage = message.errorMessage;
		if (!errorMessage) return;

		// 传入 api：Anthropic 的 400/413 + 空 body 多为真实溢出，需保留 pi 的压缩恢复路径。
		const api = typeof message.api === "string" ? message.api : undefined;

		let rewritten: string;
		if (isNoBodyError(errorMessage)) {
			// pi 名单已覆盖的状态码（500/502/503/504/429…）空响应本就会重试，
			// 保持原文以免给错误气泡加无意义后缀；只有被溢出误判的 400/413 需要改写。
			const needsRewrite =
				needsOverflowUnanchor(errorMessage, api) ||
				!ALREADY_RETRYABLE_SIGNALS.some((p) => p.test(errorMessage));
			if (!needsRewrite) return;
			rewritten = makeRetryableErrorMessage(errorMessage, api);
		} else if (isTransientError(errorMessage)) {
			// 本地化文案 / 传输层错误：pi 的重试名单里一个词都匹配不上，补英文标注。
			rewritten = makeTransientErrorMessage(errorMessage);
		} else {
			return;
		}

		// 返回替换消息：仅改写 errorMessage，其余字段（content/api/usage 等）
		// 通过展开保留，避免 _replaceMessageInPlace 删掉原消息的其他字段。
		return {
			message: {
				...message,
				errorMessage: rewritten,
			},
		};
	});
}
