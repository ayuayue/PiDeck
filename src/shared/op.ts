/**
 * 统一的调用结果信封（v5 §2「单信封」）：跨 main↔renderer 的每个操作只允许一种结果形状。
 *
 * 为什么需要它：同一条链路上现在有四种说法——`{ok:false, code}`（远端 IPC）、抛异常（`files:*` /
 * `git:*`）、`{ok:false, message}`（个别 Git 结果）、以及 `withProjectSession` 自己的
 * `{ok:false, code}` 再被 6 处 handler 用 `throw new Error(result.code)` 拆开、又被 8 份本地
 * `codeOf` 重新包装成信封。信封在边界上被拆开重建，`outcome` 就在拆装中丢了。
 *
 * 两条硬规定（不是建议）：
 * 1. **`outcome` 必填**。`rejected` = 确定什么都没发生，可以安全重试；`unknown` = 命令可能已经
 *    执行，只能去核对，绝不能重放。把「被拒绝」说成「未知」和反过来，都是数据损坏级别的错误。
 * 2. **`code` 是闭集稳定码**，不是文案。它跨进程、跨版本、进日志、进测试断言；自由文本一律不外传。
 *
 * 本模块是纯函数与纯类型，属于契约层（`shared/` 只被依赖，不反向 import 运行时层）。
 */

/** 结果的二阶语义：`unknown` 只可能来自远端写路径（本机写失败时状态是确定已知的）。 */
export type OpOutcome = "rejected" | "unknown";

export type OpFailure = { ok: false; code: string; outcome: OpOutcome };
export type Op<T> = { ok: true; value: T } | OpFailure;

export function opOk<T>(value: T): Op<T> {
	return { ok: true, value };
}

/** `unknown` 必须显式写出来：默认 `rejected`，因为「什么都不需要重放」是安全的默认值。 */
export function opFail(code: string, outcome: OpOutcome = "rejected"): OpFailure {
	return { ok: false, code, outcome };
}

export function isOpFailure<T>(op: Op<T>): op is OpFailure {
	return op.ok === false;
}

/**
 * 「可能已经执行」的码（闭集）。把它们从直接失败里分出来的唯一理由：重试会重复执行。
 *
 * 不收以 `_UNCONFIRMED` 结尾的引导/握手码（`BOOTSTRAP_*` / `REMOTE_RUNTIME_HANDSHAKE_UNCONFIRMED`）：
 * 它们是连接层内部状态，不是用户的一次写操作，永远不该出现在操作结果信封里。
 */
export const OP_UNKNOWN_CODES: ReadonlySet<string> = new Set([
	"REMOTE_FILE_RESULT_UNCONFIRMED",
	"REMOTE_DOWNLOAD_RESULT_UNCONFIRMED",
	"REMOTE_UPLOAD_COMMIT_UNCONFIRMED",
	"REMOTE_PROJECT_CREATE_UNCONFIRMED",
	"GIT_WRITE_RESULT_UNCONFIRMED",
	"CONFIG_RESULT_UNCONFIRMED",
	"REMOTE_CONFIG_RESULT_UNCONFIRMED",
	"REMOTE_SESSION_DELETE_RESULT_UNCONFIRMED",
	"REMOTE_SESSION_HISTORY_WRITER_RESULT_UNCONFIRMED",
]);

/** 由稳定码推出 outcome：唯一的真相来源是闭集，不靠调用方记着传。 */
export function opOutcomeOf(code: string): OpOutcome {
	return OP_UNKNOWN_CODES.has(code) ? "unknown" : "rejected";
}

/** 失败信封的一行式构造：码 + 由码推出的 outcome（迁移期用它替掉各处手写的 outcome 判定）。 */
export function opFailFromCode(code: string): OpFailure {
	return { ok: false, code, outcome: opOutcomeOf(code) };
}

/** 稳定码的形状：全大写、下划线分段、3..64 字符。与各域既有判据逐字相同。 */
export const STABLE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;

/**
 * 把任意抛出物折成一个稳定码。
 *
 * 迁移前的 8 份本地副本判据各不相同（有的只认 `Error.message`，有的认 `code` 字段，正则也不一致），
 * 于是同一类失败在不同面板上得到不同的码、不同的文案。这里只留一条判据，`fallback` 由调用方按域给出
 * （必须是闭集里的常量，不许临时拼字符串）。
 */
export function codeOf(error: unknown, fallback: string): string {
	if (typeof error === "string" && STABLE_CODE_PATTERN.test(error)) return error;
	if (error instanceof Error) {
		// 稳定码在本仓约定俗成地放在 message 里（`throw stable("OP_X")`），也兼容挂在 `code` 上的实现。
		if (STABLE_CODE_PATTERN.test(error.message)) return error.message;
		const attached = (error as { code?: unknown }).code;
		if (typeof attached === "string" && STABLE_CODE_PATTERN.test(attached)) return attached;
	}
	const attached = (error as { code?: unknown } | null)?.code;
	if (typeof attached === "string" && STABLE_CODE_PATTERN.test(attached)) return attached;
	return fallback;
}

/**
 * 信封 → 异常：给仍然以 `throw` 为契约的边界用（例如背后已经是 Promise 拒约的端口）。
 *
 * 它带着 `code` 与 `outcome` 一起抛出，所以上层再 `catch` 时不会把「已执行但未知」退化成
 * 普通失败——这正是旧适配器 `throw new Error(result.code)` 丢掉的信息。
 */
export function opError(failure: OpFailure): Error & { code: string; outcome: OpOutcome } {
	const error = new Error(failure.code) as Error & { code: string; outcome: OpOutcome };
	error.code = failure.code;
	error.outcome = failure.outcome;
	return error;
}
