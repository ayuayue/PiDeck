/**
 * bridge/bridgeLog — FeishuBridge 的安全日志出口。
 *
 * 从 FeishuBridge.ts 原样搬出：console 写失败（EPIPE）不能中断桥接主链路，
 * 所有协作者共用同一份实现，避免每个拆分文件各写一份 try/catch。
 */

// ===== 安全日志 =====
function safeLog(level: "log" | "warn" | "error", ...args: unknown[]): void {
	try {
		console[level](...args);
	} catch {
		/* EPIPE */
	}
}
export const log = (...args: unknown[]) => safeLog("log", ...args);
export const warn = (...args: unknown[]) => safeLog("warn", ...args);
export const logErr = (...args: unknown[]) => safeLog("error", ...args);
