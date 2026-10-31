/**
 * ACP 回合失败自动重试的判定与口径（纯函数，不碰连接/投影）。
 *
 * 背景：pi 后端由 pi SDK 自己重试，DSH 由内置 llm-retry 重试，只有 ACP 后端一点重试都没有 ——
 * `session/prompt` 收到任何 JSON-RPC error / 连接抖动就是整个回合失败：气泡撤回、草稿回填、
 * 用户得手动再发一次。各家 CLI（gemini / codex / claude / kimi / qwen …）的适配器不同，
 * 逐家兼容是条死路；这里只在**协议层**兜：「这一轮还没产出任何东西 + 错误像瞬时故障」就重发同一个
 * `session/prompt`，与具体 CLI 无关。
 *
 * 安全门（任一命中都不重试）：
 * - 用户已经点了停止（cancelling）；
 * - 传输层已经强杀（escalatedStop）；
 * - 连接已死 / runtime 已被替换（重发只会立刻失败，重启进程是另一期的事）；
 * - 本轮已有产出（重复 JSON-RPC 请求可能让 agent 重复执行工具/写文件，宁可不救）；
 * - 鉴权失败（重试只会连撞五次 401）；
 * - 回合总超时（AcpTimeoutError：CLI 卡死，重发只会再卡 15 分钟）；
 * - 分类器判为终局（额度/余额/context overflow/400）。
 */
import { classifyFailure, failureMessage } from "../../shared/retry/transientFailure";

/** 保守默认：两次重试、2s 起指数退避，最坏多花 6s 换取「不用手动重发」。 */
export const ACP_TURN_RETRY_DEFAULTS = {
	enabled: true,
	maxRetries: 2,
	baseDelayMs: 2_000,
	maxDelayMs: 30_000,
} as const;

export const ACP_TURN_RETRY_LIMITS = {
	maxRetries: { min: 0, max: 10 },
	baseDelayMs: { min: 200, max: 60_000 },
} as const;

export type AcpTurnRetrySettings = {
	enabled?: boolean;
	maxRetries?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
};

export type ResolvedAcpTurnRetrySettings = {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
};

function clampInteger(value: unknown, range: { min: number; max: number }, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(range.max, Math.max(range.min, Math.floor(value)));
}

/** 设置值 → 生效口径：缺省/脏值回落到默认，整数钳在允许区间内。 */
export function resolveAcpTurnRetrySettings(input?: AcpTurnRetrySettings): ResolvedAcpTurnRetrySettings {
	return {
		enabled: input?.enabled ?? ACP_TURN_RETRY_DEFAULTS.enabled,
		maxRetries: clampInteger(input?.maxRetries, ACP_TURN_RETRY_LIMITS.maxRetries, ACP_TURN_RETRY_DEFAULTS.maxRetries),
		baseDelayMs: clampInteger(input?.baseDelayMs, ACP_TURN_RETRY_LIMITS.baseDelayMs, ACP_TURN_RETRY_DEFAULTS.baseDelayMs),
		maxDelayMs: clampInteger(input?.maxDelayMs, ACP_TURN_RETRY_LIMITS.baseDelayMs, ACP_TURN_RETRY_DEFAULTS.maxDelayMs),
	};
}

export type AcpTurnRetryInput = {
	error: unknown;
	settings: ResolvedAcpTurnRetrySettings;
	/** 本轮已经重试过的次数（0 = 首次失败）。 */
	attemptsMade: number;
	/** 本回合是否已经产出过 assistant/tool 内容（有产出就不许重试）。 */
	hasOutput: boolean;
	cancelled: boolean;
	escalated: boolean;
	connectionAlive: boolean;
	/** 命中 AUTH_REQUIRED（-32000 惯例码 / 未登录文案）。 */
	authRequired: boolean;
	/** 回合总超时（AcpTimeoutError）。 */
	timedOut: boolean;
	/** 错误的 HTTP 状态码（能从错误对象上拿到就传，比文本正则可靠）。 */
	status?: number;
};

export type AcpTurnRetryDecision =
	| ({ retry: true; attempt: number; maxAttempts: number; delayMs: number; reason: string } & {
			/** 供重试卡 debugDetails / 日志用：命中的类别。 */
			kind: string;
	  })
	| { retry: false; reason: string };

/** 判定这一次失败要不要自动重发，以及退避多久。 */
export function decideAcpTurnRetry(input: AcpTurnRetryInput): AcpTurnRetryDecision {
	const { settings } = input;
	if (!settings.enabled) return { retry: false, reason: "disabled" };
	if (input.cancelled) return { retry: false, reason: "cancelled" };
	if (input.escalated) return { retry: false, reason: "escalated" };
	if (!input.connectionAlive) return { retry: false, reason: "connection-dead" };
	if (input.hasOutput) return { retry: false, reason: "has-output" };
	if (input.authRequired) return { retry: false, reason: "auth-required" };
	if (input.timedOut) return { retry: false, reason: "turn-timeout" };
	if (input.attemptsMade >= settings.maxRetries) return { retry: false, reason: "exhausted" };

	const verdict = classifyFailure({ message: failureMessage(input.error), status: input.status });
	if (!verdict.retry) return { retry: false, reason: `fatal:${verdict.kind}` };

	const attempt = input.attemptsMade + 1;
	// 指数退避：2s、4s、8s… 封顶 maxDelayMs（默认 30s）。
	const delayMs = Math.min(settings.baseDelayMs * 2 ** input.attemptsMade, settings.maxDelayMs);
	return { retry: true, attempt, maxAttempts: settings.maxRetries, delayMs, reason: verdict.reason, kind: verdict.kind };
}
