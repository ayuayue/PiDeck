/**
 * session 域 IPC 的共用入参守卫与命令结果工具（渲染层数据不可信，校验在边界）。
 *
 * 拆分后多个 IPC 文件都要用同一套判定，集中在这里只留一份；各文件自抄一份会让
 * 「id 长度上限」「record 判定」这类边界在不同入口悄悄漂移。会话命令失败日志同理：
 * edit/delete/resend 等通道直接返回 SessionCommandResult，多个文件都要打同一条日志。
 */

import type { SessionCommandError, SessionCommandResult, SessionRuntimeTarget } from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";

export function isRecord(input: unknown): input is Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input);
}

/** catalog 会话 id：非空字符串，长度上限 256（超出即视为伪造输入）。 */
export function parseSessionId(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 256) throw new Error("INVALID_SESSION_ID");
	return value;
}

/**
 * 会话命令失败日志：edit/delete/resend 等 IPC 直接返回 SessionCommandResult，
 * 不走 sessionCommandIpcError 抛错，漏打这条就会出现「toast 失败、主进程无日志」。
 * 标题带上错误码：按 code/关键词（如 edit、BUSY）就能在日志里搜到对应失败，
 * 不依赖结构化字段（2026-10 教训：按「编辑」搜正文一无所获）。
 */
export function logSessionCommandFailure(appLogger: Pick<AppLogger, "warn">, error: SessionCommandError, extra?: Record<string, unknown>): void {
	void appLogger.warn("session-command", `Session command failed (${error.code})`, {
		code: error.code,
		...(error.debugDetails ? { debugDetails: error.debugDetails } : {}),
		...extra,
	});
}

export async function handleSessionCommandResult<T>(appLogger: Pick<AppLogger, "warn">, operation: string, target: SessionRuntimeTarget, extra: Record<string, unknown>, run: () => Promise<SessionCommandResult<T>>): Promise<SessionCommandResult<T>> {
	const result = await run();
	if (!result.ok) {
		logSessionCommandFailure(appLogger, result.error, {
			operation,
			sessionId: target.sessionId,
			agentId: target.agentId,
			runtimeGeneration: target.runtimeGeneration,
			...extra,
		});
	}
	return result;
}
