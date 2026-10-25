/**
 * 并行问询「上下文继承」纯逻辑。
 *
 * pi RPC 的 prompt 只有 message/images/streamingBehavior，没有跨进程注入上下文的
 * 通道（new_session.parentSession 仅写入会话 header，且匿名 --no-session 会话
 * 不在同一 session tree 内）。因此携带主会话上下文采用：
 * 渲染层收集发起会话最近对话 → 生成只读上下文块 → 经 SendPromptInput.agentMessage
 * 传给匿名会话（agentMessage 模型可见、UI 时间线不可见，见 AgentManager.sendPrompt）。
 *
 * 本模块只负责「从消息列表生成上下文块」的纯转换，可脱离 React 单测。
 */

export type AskContextMessage = {
	role: string;
	text: string;
};

export type BuildAskContextOptions = {
	/** 最多携带最近多少条 user/assistant 消息（默认 12，超出取最新）。 */
	maxMessages?: number;
	/** 上下文块总字符上限（默认 6000；超出从最早的消息开始丢弃）。 */
	maxChars?: number;
	/** 上下文块标题（调用方传 i18n 文案；无标题则为纯对话块）。 */
	title?: string;
	/** 消息角色前缀（调用方传 i18n 文案，默认 "用户"/"助手"）。 */
	userLabel?: string;
	/** 消息角色前缀（调用方传 i18n 文案，默认 "用户"/"助手"）。 */
	assistantLabel?: string;
};

const DEFAULT_MAX_MESSAGES = 12;
const DEFAULT_MAX_CHARS = 6000;
/** 单条消息超长时保留的截断后缀余量 */
const SINGLE_LINE_CHARS = 200;

/**
 * 从会话消息列表构建并行问询的只读上下文块。
 * - 只取 user/assistant 有正文的消息（跳过 thinking/空消息等）；
 * - 保留最近 maxMessages 条，按旧→新顺序输出；
 * - 总量超过 maxChars 时从最早消息起丢弃，最后一条仍超长则就地截断。
 * - 无可携带内容（空列表/全是空消息）返回 null，调用方应跳过上下文注入。
 */
export function buildAskContextBlock(messages: readonly AskContextMessage[] | null | undefined, options?: BuildAskContextOptions): string | null {
	const maxMessages = options?.maxMessages ?? DEFAULT_MAX_MESSAGES;
	const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;
	const userLabel = options?.userLabel ?? "用户";
	const assistantLabel = options?.assistantLabel ?? "助手";

	// 收集候选消息：只保留有正文的用户/助手消息，最近 maxMessages 条
	const candidates = (messages ?? []).filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.text === "string" && m.text.trim().length > 0).slice(-maxMessages);

	if (candidates.length === 0) return null;

	// 逐条生成带角色前缀的行，追加到缓冲；随后从旧到新丢弃直到不超上限
	const roles: Record<string, string> = { user: userLabel, assistant: assistantLabel };
	const lines: string[] = [];
	let total = 0;
	for (const message of candidates) {
		const line = `${roles[message.role] ?? message.role}：${message.text.trim()}`;
		lines.push(line);
		total += line.length;
	}
	// 保留最近对话：超限时丢掉最早的行（至少留 1 行）
	while (lines.length > 1 && total > maxChars) {
		total -= lines[0].length;
		lines.shift();
	}
	// 剩余单行仍超长：就地截断并加省略号标记（保留 SINGLE_LINE_CHARS 字符）
	if (total > maxChars) {
		const lastIndex = lines.length - 1;
		lines[lastIndex] = `${lines[lastIndex].slice(0, SINGLE_LINE_CHARS)}…`;
	}

	const block = lines.join("\n");
	return options?.title ? `${options.title}\n${block}` : block;
}
