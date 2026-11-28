import type { ChatMessage, SessionMessagePage } from "../../../shared/types";

/** Historical payload budget, separate from the main-owned 1,200-entry live window.
 * Bytes are conservative UTF-16 JSON estimates, not a JS heap measurement.
 * A single oversized message is retained so it remains readable.
 */
export const HISTORY_WINDOW_MESSAGE_LIMIT = 512;
export const HISTORY_WINDOW_BYTE_BUDGET = 8 * 1024 * 1024;
type Cursor = Pick<SessionMessagePage, "total" | "nextBefore" | "nextBeforeEntryId" | "nextAfterEntryId" | "indexVersion">;
export function entryIdOf(message: ChatMessage | undefined): string | undefined {
	const id = message?.meta?.entryId;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}
const weights = new WeakMap<ChatMessage, number>();
export function messagePayloadBytes(message: ChatMessage): number {
	let value = weights.get(message);
	if (value === undefined) {
		value = JSON.stringify(message).length * 2;
		weights.set(message, value);
	}
	return value;
}
/** Keep the edge the reader just requested, never discard the requested page.
 * Eviction is legal only with stable identities at both retained edges.
 */
export function boundHistoryWindow(messages: ChatMessage[], page: Cursor, direction: "older" | "newer"): { messages: ChatMessage[]; page: Cursor } {
	let start = 0,
		end = messages.length;
	let bytes = messages.reduce((sum, message) => sum + messagePayloadBytes(message), 0);
	while (end - start > 1 && (end - start > HISTORY_WINDOW_MESSAGE_LIMIT || bytes > HISTORY_WINDOW_BYTE_BUDGET)) {
		if (direction === "older") bytes -= messagePayloadBytes(messages[--end]);
		else bytes -= messagePayloadBytes(messages[start++]);
	}
	if (start === 0 && end === messages.length) return { messages, page };
	const retained = messages.slice(start, end);
	const first = entryIdOf(retained[0]),
		last = entryIdOf(retained.at(-1));
	if (!first || !last) throw new Error("SESSION_HISTORY_WINDOW_IDENTITY_MISSING");
	return { messages: retained, page: { ...page, ...(start > 0 ? { nextBefore: Math.max(1, page.nextBefore ?? 1), nextBeforeEntryId: first } : {}), ...(end < messages.length ? { nextAfterEntryId: last } : {}) } };
}
