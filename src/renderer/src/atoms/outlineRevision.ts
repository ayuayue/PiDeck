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
 * and does not add a new one.
 */
export function shouldRefreshOutlineForRuntimeUpsert(currentMessages: readonly ChatMessage[], cachedLastUserIndex: number | undefined, upsertFrom: number, incomingMessages: readonly Pick<ChatMessage, "role">[]): boolean {
	if (!Number.isInteger(upsertFrom) || upsertFrom < 0 || upsertFrom > currentMessages.length) {
		return true;
	}

	const cachedLastUserIndexIsValid = cachedLastUserIndex !== undefined && cachedLastUserIndex >= -1 && cachedLastUserIndex < currentMessages.length && (cachedLastUserIndex < 0 || currentMessages[cachedLastUserIndex]?.role === "user");
	const lastUserIndex = cachedLastUserIndexIsValid ? cachedLastUserIndex : findLastUserMessageIndex(currentMessages);

	return upsertFrom <= lastUserIndex || incomingMessages.some((message) => message.role === "user");
}
