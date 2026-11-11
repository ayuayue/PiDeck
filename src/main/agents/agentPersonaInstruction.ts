/**
 * 会话绑定的智能体角色设定注入（纯函数，无 IO）。
 *
 * 「使用」智能体时渲染层把 sessionId → agentId 绑定写入 AgentProfileStore，
 * 之后该会话**首次**发送时由主进程把智能体的 systemPrompt 作为角色设定拼进本轮 prompt
 *（只在首轮注入：角色设定随第一条用户消息留在会话历史里，之后每轮再拼会重复）：
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

export type AgentPersonaGateInput = {
	/** catalog 记录的会话状态：绑定只经新会话「使用」流程建立，draft = 还没成功发过首条消息。 */
	sessionStatus: "draft" | "active" | undefined;
	/** 本进程内是否已成功注入过（覆盖首条已接受、catalog 的 draft→active 还没回写的窗口）。 */
	alreadyInjected: boolean;
};

/**
 * 角色设定只在会话首轮注入一次。
 *
 * 首条消息被接受后，pi 的会话文件里已经存了「角色设定 + 用户原文」这条 user 消息，
 * 后续轮次沿用上下文即可；每轮重拼会在模型上下文里出现重复的角色设定。
 * 发送失败/被拒绝时状态仍是 draft，下一次发送会重新注入。
 */
export function shouldInjectAgentPersona(input: AgentPersonaGateInput): boolean {
	return input.sessionStatus === "draft" && !input.alreadyInjected;
}

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

export type ApplyBoundAgentPersonaInput<T extends { message: string; agentMessage?: string }> = {
	/** 本轮待发送载荷（渲染层原文 + 可能的隐藏标记）。 */
	prompt: T;
	/** 会话绑定的智能体角色设定；未绑定 / 空白 = 不做任何事。 */
	persona: string | undefined;
	/** catalog 记录状态：draft = 还没成功发过首条消息。 */
	sessionStatus: "draft" | "active" | undefined;
	/** 会话后端（SessionRecord.backend）；缺省按 pi。 */
	backend: string | undefined;
	/** 本进程已在本会话成功注入过角色设定。 */
	alreadyInjected: boolean;
};

export type ApplyBoundAgentPersonaResult<T extends { message: string; agentMessage?: string }> = {
	/** 组合后的载荷；未绑定/未到注入时机时原样返回入参。 */
	prompt: T;
	/** 本次是否真的拼进了角色设定（调用方据此在发送被接受后记账）。 */
	injected: boolean;
};

/**
 * 发送前的「绑定智能体会话」收口（纯函数）：桌面 IPC 与 Web 服务两个发送入口共用同一份
 * 判定与组合语义，只在外面各自持有一个「已注入会话」集合。
 *
 * - 角色设定只在首轮注入（`shouldInjectAgentPersona`）；
 * - DSH 没有隐藏通道，首轮和后续轮次都必须丢掉 agentMessage（host 见到就拒收整条）；
 * - 其余后端沿用 composeAgentInstruction 的隐藏通道语义。
 */
export function applyBoundAgentPersona<T extends { message: string; agentMessage?: string }>(input: ApplyBoundAgentPersonaInput<T>): ApplyBoundAgentPersonaResult<T> {
	const persona = input.persona?.trim();
	if (!persona) return { prompt: input.prompt, injected: false };
	const injected = shouldInjectAgentPersona({ sessionStatus: input.sessionStatus, alreadyInjected: input.alreadyInjected });
	let prompt: T = input.prompt;
	if (injected) {
		const composed = composeAgentInstruction({ persona, message: prompt.message, existingAgentMessage: prompt.agentMessage, backend: input.backend });
		prompt = { ...prompt, message: composed.message, ...(composed.agentMessage !== undefined ? { agentMessage: composed.agentMessage } : {}) };
	}
	if (input.backend === "dsh" && prompt.agentMessage !== undefined) {
		const { agentMessage: _dropped, ...rest } = prompt;
		prompt = rest as T;
	}
	return { prompt, injected };
}
