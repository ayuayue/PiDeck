import type { ChatMessage } from "../../../shared/types";

/** Returns the last user-message index in the runtime window, or -1 when absent. */
export function findLastUserMessageIndex(messages: readonly ChatMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index]?.role === "user") return index;
	}
	return -1;
}

/**
 * Incremental runtime updates replace a suffix beginning at upsertFrom. They
 * can reuse the outline only when that suffix starts after every user message
 * and does not add a new one. 助手消息在 message_end 才带终态 stopReason：
 * 那一刻要把这条 AI 回复补进大纲，但流式 delta（stopReason=pending/undefined）
 * 仍然复用旧投影，保持「不随 token 频率重算」的性能边界。
 */
export function shouldRefreshOutlineForRuntimeUpsert(currentMessages: readonly ChatMessage[], cachedLastUserIndex: number | undefined, upsertFrom: number, incomingMessages: readonly Pick<ChatMessage, "role" | "stopReason">[]): boolean {
	if (!Number.isInteger(upsertFrom) || upsertFrom < 0 || upsertFrom > currentMessages.length) {
		return true;
	}

	const cachedLastUserIndexIsValid = cachedLastUserIndex !== undefined && cachedLastUserIndex >= -1 && cachedLastUserIndex < currentMessages.length && (cachedLastUserIndex < 0 || currentMessages[cachedLastUserIndex]?.role === "user");
	const lastUserIndex = cachedLastUserIndexIsValid ? cachedLastUserIndex : findLastUserMessageIndex(currentMessages);

	return upsertFrom <= lastUserIndex || incomingMessages.some((message) => message.role === "user" || (message.role === "assistant" && message.stopReason !== undefined && message.stopReason !== "pending"));
}
