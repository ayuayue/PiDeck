/**
 * 会话绑定的智能体角色设定注入（纯函数，无 IO）。
 *
 * 「使用」智能体时渲染层把 sessionId → agentId 绑定写入 AgentProfileStore，
 * 之后该会话每次发送都由主进程把智能体的 systemPrompt 作为角色设定拼进本轮 prompt：
 * - pi（及支持隐藏通道的 ACP）：拼进 SendPromptInput.agentMessage。AgentManager 在
 *   agentMessage 非空时**整体替换** message（只影响本轮/模型可见内容，时间线仍只显示用户原文），
 *   所以角色设定必须与真正要发的载荷拼在一起，不能单独成一个字段。
 * - DSH：DshAgentManager 显式拒绝 agentMessage，且会**拒收整条 prompt**，
 *   因此退化为可见前缀（用户能看到角色设定——这是让请求成功的唯一方式）。
 *
 * 边界：空角色设定什么都不注入（连已有的 agentMessage 都原样保留，
 * 计划/目标模式靠它传隐藏标记）；角色设定只用 trim 后的文本，避免首尾空白进入 prompt。
 */

export type ComposeAgentInstructionInput = {
	/** 智能体角色设定（AgentProfile.systemPrompt）；空/全空白 = 未绑定。 */
	persona: string;
	/** 用户可见原文（会话气泡）。 */
	message: string;
	/** 调用方已带的隐藏载荷（计划模式标记等）；缺省 = 无。 */
	existingAgentMessage?: string;
	/** 会话后端（SessionRecord.backend）；缺省/未知按 pi 处理。 */
	backend: string | undefined;
};

export type ComposedAgentInstruction = {
	/** 替换后的可见消息（DSH 后端才是「角色设定 + 原文」）。 */
	message: string;
	/** 隐藏载荷；undefined 表示本轮没有隐藏指令。 */
	agentMessage?: string;
};

export function composeAgentInstruction(input: ComposeAgentInstructionInput): ComposedAgentInstruction {
	const persona = input.persona.trim();
	if (!persona) {
		return input.existingAgentMessage === undefined ? { message: input.message } : { message: input.message, agentMessage: input.existingAgentMessage };
	}
	if (input.backend === "dsh") {
		// DSH 没有隐藏通道且拒收 agentMessage：角色设定只能作为可见前缀；
		// 原有隐藏载荷也不能透传（哪怕是非空字符串），否则整条 prompt 被 host 拒绝。
		return { message: `${persona}\n\n${input.message}` };
	}
	// pi / acp：隐藏通道可用。已有隐藏载荷（计划模式标记等）时前置角色设定而不是覆盖它，
	// 两者都要生效；AgentManager 会把 message 整体换成这份载荷。
	return { message: input.message, agentMessage: `${persona}\n\n${input.existingAgentMessage ?? input.message}` };
}
