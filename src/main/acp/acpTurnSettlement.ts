/**
 * ACP 回合结算的纯判定/结果 shaping（sendPrompt 内最难懂的语义收口到这里）：
 * - resolvePromptDispatch：派发前 4 类前置拒绝（连接死/宿主指令/图片能力/回合中）。
 * - hasTurnOutput：本回合是否有可见产出（assistant/tool 条目），空回合守卫与
 *   失败路径 delivery 判定共用同一口径。
 * - emptyTurnRejection：正常结算但零输出的收口（回滚用户条目后按 rejected 返回）。
 * - escalatedStopRejection：升级强杀后的结果（delivery=unknown，不回填草稿防重发）。
 * 纯函数、可直接单测；副作用（回滚/flush/logger）留在 manager。
 */
import type { ChatMessage, SendPromptInput, SendPromptResult } from "../../shared/types/session";
import type { AcpAgentRuntime, AcpAbortEscalationReason } from "./acpAgentRuntime";
import type { AcpConnection } from "./AcpConnection";

/** 派发前置校验：返回收窄后的存活连接；任一拒因命中则返回 rejection（渲染层回填草稿）。 */
export function resolvePromptDispatch(input: SendPromptInput, runtime: AcpAgentRuntime): { conn: AcpConnection } | { rejection: SendPromptResult } {
	const conn = runtime.conn;
	if (!conn || conn.isClosed()) {
		return { rejection: { accepted: false, error: "ACP agent process is not running", delivery: "rejected", i18nKey: "acp.processNotRunning", i18nParams: { tool: runtime.tool.name } } };
	}
	if (input.agentMessage) {
		return { rejection: { accepted: false, error: "Host instructions are not supported by ACP backend", delivery: "rejected", i18nKey: "acp.hostInstructionsUnsupported", i18nParams: { tool: runtime.tool.name } } };
	}
	// 图片按能力门控：agent 未声明 promptCapabilities.image 时发 image 块只会换来整回合
	// 协议错误（raw JSON-RPC 文本对用户无意义）；拒收并回填草稿，用本地化文案说明。
	if (input.images?.length && !runtime.agentInfo.capabilities.promptImage) {
		return { rejection: { accepted: false, error: `ACP agent ${runtime.tool.name} does not accept image input`, delivery: "rejected", i18nKey: "acp.imagesNotSupported", i18nParams: { tool: runtime.tool.name } } };
	}
	if (runtime.turnActive) {
		return { rejection: { accepted: false, error: "ACP agent is still responding; stop or wait for the current turn", delivery: "rejected", i18nKey: "acp.turnBusy", i18nParams: { tool: runtime.tool.name } } };
	}
	return { conn };
}

/** seededIndex 之后是否出现 assistant/tool 条目（用户条目本身不算产出）。 */
export function hasTurnOutput(messages: ChatMessage[], seededIndex: number): boolean {
	return messages.slice(seededIndex + 1).some((entry) => entry.role === "assistant" || entry.role === "tool");
}

/** 正常结算但全程零输出的拒收结果（调用方已回滚用户条目并 flush）。 */
export function emptyTurnRejection(toolName: string): SendPromptResult {
	return { accepted: false, error: `ACP agent ${toolName} completed the turn without any output`, delivery: "rejected", i18nKey: "acp.emptyTurn", i18nParams: { tool: toolName } };
}

/** 升级强杀（abort 宽限超时/二次停止/stall）的结果：delivery=unknown，不回填草稿避免重发重复。 */
export function escalatedStopRejection(reason: AcpAbortEscalationReason, message: string, toolName: string): SendPromptResult {
	return {
		accepted: false,
		error: message,
		delivery: "unknown",
		i18nKey: reason === "stall" ? "acp.stallForceStopped" : "acp.abortForceStopped",
		i18nParams: { tool: toolName },
		debugDetails: `escalated=${reason}: ${message}`,
	};
}
