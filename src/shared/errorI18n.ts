/**
 * 主进程抛出的错误 → 渲染层本地化 toast 的提取通道。
 *
 * 背景：SessionAgentGateway 的拒收结果（SendPromptResult）天然携带 I18nDescriptor
 * （i18nKey/i18nParams/debugDetails），但「激活失败」走的是 throw——
 * SessionRuntimeCoordinator 只能拿到 Error.message。约定：主进程在 throw 前给
 * Error 挂上 i18nKey/i18nParams/debugDetails 属性（如 AcpAgentManager 的
 * AUTH_REQUIRED 映射），coordinator 用本函数提取并透传进拒收结果，
 * 渲染层 translateI18nDescriptor 据此弹出本地化引导文案。
 */
import type { I18nDescriptor } from "./types/session";

/**
 * 从抛出的错误上提取 I18nDescriptor；未挂载自定义 i18nKey 时返回 undefined
 *（调用方回落通用「消息发送失败」+ 原文 debugDetails 的默认描述符）。
 * debugDetails 缺省时用 error.message 兜底：toast 文案是本地化概括，
 * 根因（RPC 超时/CLI 原文）必须经 debugDetails 带出，否则用户无从排查。
 */
export function descriptorFromThrownError(error: unknown, debugDetailsFallback?: string): I18nDescriptor | undefined {
	if (!error || typeof error !== "object") return undefined;
	const descriptor = error as I18nDescriptor & { message?: unknown };
	if (typeof descriptor.i18nKey !== "string" || !descriptor.i18nKey.trim()) return undefined;
	const debugDetails = typeof descriptor.debugDetails === "string" && descriptor.debugDetails ? descriptor.debugDetails : typeof descriptor.message === "string" ? descriptor.message : debugDetailsFallback;
	return {
		i18nKey: descriptor.i18nKey,
		...(descriptor.i18nParams ? { i18nParams: descriptor.i18nParams } : {}),
		...(debugDetails ? { debugDetails } : {}),
	};
}
