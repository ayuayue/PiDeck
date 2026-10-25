/**
 * ACP create/回合失败的本地化描述符（纯函数）。
 *
 * 从 AcpAgentManager 抽出：把「错误长什么样」的判定收敛在独立模块，
 * manager 只负责把命中的描述符挂到 Error / 拒收结果上透传。
 * 描述符结构（i18nKey/i18nParams/debugDetails）由 coordinator 的
 * descriptorFromThrownError 透传，渲染层据此弹本地化引导。
 */
import type { AcpToolConfig } from "../../shared/types/acp";
import { ACP_ERROR_CODE } from "./acpProtocol";
import { AcpRpcError, AcpTimeoutError } from "./AcpConnection";

/**
 * AUTH_REQUIRED(-32000)的统一出口：kimi/codex adapter 实测用该惯例码表示未登录。
 * sendPrompt 的返回结果与 create 的 thrown error 共用同一描述符结构，
 * 渲染层据此弹本地化登录引导（原文留在 debugDetails）。
 */
export function authRequiredDescriptor(error: unknown, tool: AcpToolConfig): { i18nKey: string; i18nParams: { tool: string }; debugDetails: string } | undefined {
	if (error instanceof AcpRpcError && error.code === ACP_ERROR_CODE.authRequired) {
		return { i18nKey: "acp.authRequired", i18nParams: { tool: tool.name }, debugDetails: error.message };
	}
	return undefined;
}

/** spawn ENOENT（CLI 未安装/不在 PATH）→ 安装引导；debugDetails 保留原文。 */
export function spawnNotInstalledDescriptor(error: unknown, tool: AcpToolConfig): { i18nKey: string; i18nParams: { tool: string; command: string }; debugDetails: string } | undefined {
	const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "ENOENT" || /spawn .+ ENOENT/i.test(message)) {
		return { i18nKey: "acp.toolNotInstalled", i18nParams: { tool: tool.name, command: [tool.command, ...tool.args].join(" ") }, debugDetails: message };
	}
	return undefined;
}

/** initialize/session 握手超时（首次 npx 下载 / CLI 冷启动慢）→ 中性重试引导。 */
export function startupTimeoutDescriptor(error: unknown, tool: AcpToolConfig): { i18nKey: string; i18nParams: { tool: string }; debugDetails: string } | undefined {
	if (error instanceof AcpTimeoutError) {
		return { i18nKey: "acp.startupTimeout", i18nParams: { tool: tool.name }, debugDetails: error.message };
	}
	return undefined;
}

/** create 抛错前的统一本地化：命中任一描述符即挂到 Error 上（coordinator 透传）。 */
export function localizeCreateFailure(error: Error, tool: AcpToolConfig): void {
	const descriptor = authRequiredDescriptor(error, tool) ?? spawnNotInstalledDescriptor(error, tool) ?? startupTimeoutDescriptor(error, tool);
	if (descriptor) Object.assign(error, descriptor);
}
