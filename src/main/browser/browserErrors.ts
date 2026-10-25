/**
 * 浏览器 Agent 的结构化错误：工具层只把 code 回给模型，便于模型据此决定是否重试/重新快照。
 * 命名与 docs/browser-agent-plan.md §7.3 的错误码表一致。
 */

export const BROWSER_AGENT_ERROR_CODES = [
	"browser_disabled",
	"browser_not_open",
	"browser_guest_gone",
	"stale_ref",
	"element_not_visible",
	"element_disabled",
	"url_not_allowed",
	"unsupported_key",
	"navigation_failed",
	"screenshot_failed",
	"cdp_busy",
	"cdp_unavailable",
	"cdp_timeout",
	"page_script_error",
	"no_approval_handler",
	"approval_timeout",
	"approval_denied",
	"invalid_input",
	"internal_error",
] as const;

export type BrowserAgentErrorCode = (typeof BROWSER_AGENT_ERROR_CODES)[number];

/** 主进程内部抛出的浏览器错误：code 是给模型看的唯一失败信号。 */
export class BrowserAgentError extends Error {
	constructor(
		readonly code: BrowserAgentErrorCode,
		message: string,
	) {
		super(message);
		this.name = "BrowserAgentError";
	}
}

export function isBrowserAgentError(value: unknown): value is BrowserAgentError {
	return value instanceof BrowserAgentError;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 把任意异常收敛成模型可见的 { code, message }，不泄漏栈、路径或页面内容。
 * 未知异常（controller 内部 bug、guest 销毁竞态等）用 internal_error：此前误报成
 * cdp_unavailable 会让模型以为是 DevTools 占用而盲目重试。
 */
export function toBrowserErrorPayload(error: unknown): { code: string; message: string } {
	if (isBrowserAgentError(error)) return { code: error.code, message: error.message };
	return { code: "internal_error", message: errorMessage(error) };
}

/**
 * 读取任意错误的 code（跨模块副本/跨 realm 也可靠）：
 * 生产里错误都是本模块的 BrowserAgentError；测试或未来多 bundle 场景下 instanceof 可能失效，
 * 因此这里退化为"形状收窄"——只认本域已知码，避免把任意 Error 当可降级错误。
 */
export function browserAgentErrorCode(error: unknown): string | null {
	if (isBrowserAgentError(error)) return error.code;
	if (typeof error === "object" && error !== null) {
		const candidate: unknown = Reflect.get(error, "code");
		if (typeof candidate === "string" && (BROWSER_AGENT_ERROR_CODES as readonly string[]).includes(candidate)) return candidate;
	}
	return null;
}

/** CuaGate 的拒绝原因沿用 CUA 词汇，映射成浏览器域的错误码。 */
export function mapGateReason(reason: string | undefined): BrowserAgentErrorCode {
	if (reason === "cua_disabled") return "browser_disabled";
	if (reason === "no_approval_handler") return "no_approval_handler";
	if (reason === "approval_timeout") return "approval_timeout";
	if (reason === "auto_approve") return "approval_denied";
	return "approval_denied";
}
