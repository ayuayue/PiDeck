/**
 * Live 正文挂载判定（纯函数，可单测）。
 *
 * 语义：Live 正文（streamingTextByIdAtom 会话级单槽）只能由「时间线上最后一个
 * agent-run」挂载。
 *
 * 背景（2026-08 回归）：steer 打断后，上一轮没有最终回答，其尾部常是空文本 interim
 * （纯工具调用消息的骨架挂载点）。旧逻辑只看「会话存在活动正文流 + 尾部是空骨架」，
 * 不看本轮是否最后一个 agent-run——新一轮开始流式时，旧轮也挂上 live，读同一个
 * 会话级流式槽，把新一轮正文在旧轮底部再打印一遍：同一个中间回复前后同时出现两份。
 *
 * 判定：
 * - isLastAgentRun（按 agent-run 判定，不是按显示条目判定）→ 非最后一个 agent-run
 *   一律不挂；steer 排队期显示数组以用户消息结尾，最后一个 agent-run 仍是流式轮，
 *   挂载不受影响；
 * - 无会话 / 无挂载点 / 无活动流 → 不挂；
 * - 空文本骨架（正文走独立通道，message 文本尚未落定）→ 挂载；
 * - 流式中 / agentRunning（正文已部分落定但仍在活动）→ 保持挂载；
 * - 其余（已 settled）→ 不挂，落回容器内渲染。
 */
/**
 * 思考叶子该按哪个 id 查 live 正文。
 *
 * 两条 id 通道不同形（主进程 live 段 `msg-thinking-<运行期 uuid>`，渲染层消息 id 可能是
 * `<agentId>-history-<entryId>`）时，用 group.id 查永远取不到 —— 思考步挂上了也是空行
 * （2026-11-26 真机）。buildTurnDisplay 把命中的 liveId 交给叶子，这里只判「用哪一个」。
 *
 * 顺序有意义：liveId 是**已经命中**的事实，group.id 只是兜底的拼接猜测。
 */
export function resolveLiveThinkingKey(input: { liveId?: string; groupId: string }): string {
	const liveId = input.liveId?.trim();
	return liveId ? liveId : input.groupId;
}

export function resolveLiveInterimId(input: {
	/** 所属会话 id（无会话不挂） */
	sessionId?: string;
	/** 本轮最后一条 interim 的 id（Live 挂载锚点） */
	lastInterimId?: string;
	/** 会话是否存在活动正文流（liveTextStreamingBySessionAtom 的派生位） */
	liveTextActive: boolean;
	/** 本轮最后一条 interim 的正文（空 = 骨架挂载点） */
	lastMessageText: string;
	agentRunning?: boolean;
	isStreaming?: boolean;
	/** 是否为时间线上最后一个 agent-run（live 挂载门） */
	isLastAgentRun?: boolean;
}): string | undefined {
	if (!input.isLastAgentRun) return undefined;
	if (!input.sessionId || !input.lastInterimId) return undefined;
	if (!input.liveTextActive) return undefined;
	const emptySkeleton = !input.lastMessageText.trim();
	if (emptySkeleton || input.agentRunning || input.isStreaming) return input.lastInterimId;
	return undefined;
}
