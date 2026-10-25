/**
 * webMessageOptimistic — Web 端消息编辑/删除的乐观更新纯函数。
 *
 * 背景：runtime 编辑/删除要走「停 agent → 改会话文件 → pi switch_session 重载」全链路，
 * 耗时数秒；若等服务端回包再刷新，用户会盯着旧气泡/旧文本干等。这里先在本地
 * UIMessage 列表上施加与 SessionFileEditor 相同的终态，服务端完成后再静默对齐：
 * - 编辑：setMessageText 只替换目标条目文本（user→主文本 part；assistant→最后一个
 *   text part），图片/思考/工具 part 原样保留，不截断后续消息。
 * - 删除：只墓碑目标条目、子条目 reparent（回复保留），因此乐观移除也只摘目标一条。
 */
import type { UIMessage } from "ai";

/** 编辑乐观更新：返回替换目标消息正文后的新数组；找不到目标或无文本 part 时原样返回。 */
export function replaceMessageTextOptimistic(messages: UIMessage[], messageId: string, newText: string): UIMessage[] {
	const index = messages.findIndex((message) => message.id === messageId);
	if (index < 0) return messages;
	const message = messages[index];
	const parts = [...message.parts];
	// assistant 可能有思考/工具 part 夹杂，正文以最后一个 text part 为准；user 取首个 text part。
	const range = message.role === "assistant" ? [...parts.keys()].reverse() : [...parts.keys()];
	for (const partIndex of range) {
		const part = parts[partIndex];
		if (part.type === "text") {
			parts[partIndex] = { ...part, text: newText };
			const next = [...messages];
			next[index] = { ...message, parts };
			return next;
		}
	}
	return messages;
}

/** 删除乐观更新：只移除目标条目（与墓碑 reparent 语义一致：其后的回复保留）。 */
export function removeMessageOptimistic(messages: UIMessage[], messageId: string): UIMessage[] {
	const index = messages.findIndex((message) => message.id === messageId);
	if (index < 0) return messages;
	const next = [...messages];
	next.splice(index, 1);
	return next;
}
