/**
 * Composer 主发送圆钮的显示决策（纯函数，脱离 React 可单测）：
 * - 生图进行中 → spinner：生图无中断语义，忙碌但不是停止钮；
 * - Agent 忙碌且输入框无内容 → stop：此时圆钮是会话内唯一的停止入口；
 * - 其余（空闲，或忙碌但有内容）→ send：忙碌时发送走 steer/followUp
 *   投递语义（shared/busySendDelivery），有内容即优先发送，清空输入才回到停止。
 */
export type ComposerSendButtonState = "send" | "stop" | "spinner";

export function resolveComposerSendButtonState(input: { isAgentBusy: boolean; hasContent: boolean; isGeneratingImage?: boolean }): ComposerSendButtonState {
	if (input.isGeneratingImage) return "spinner";
	if (input.isAgentBusy && !input.hasContent) return "stop";
	return "send";
}
