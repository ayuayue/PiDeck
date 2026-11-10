import { Buffer } from "node:buffer";
import type { ChatMessage } from "../../shared/types";
import { projectDshEvent } from "./dshEventProjector";
import type { DshEnvelope, DshHistoryPage } from "./dshRemoteClient";

export type DshExportMessagesLimits = { pageSize: number; maxPages: number; maxEventBytes: number; maxMessages: number };

/** Export/search snapshots are bounded even when a host page contains a very long turn. */
export const DSH_EXPORT_MESSAGES_LIMITS: Readonly<DshExportMessagesLimits> = {
	pageSize: 500,
	maxPages: 100,
	maxEventBytes: 32 * 1024 * 1024,
	maxMessages: 10_000,
};

export const DSH_EXPORT_MESSAGES_CODES = {
	readFailed: "DSH_EXPORT_READ_FAILED",
	pageInvalid: "DSH_EXPORT_PAGE_INVALID",
	cursorStalled: "DSH_EXPORT_CURSOR_STALLED",
	limitsInvalid: "DSH_EXPORT_LIMITS_INVALID",
} as const;

/** Stable errors never expose host messages, session paths, or partial data as success. */
export class DshExportMessagesError extends Error {
	constructor(readonly code: (typeof DSH_EXPORT_MESSAGES_CODES)[keyof typeof DSH_EXPORT_MESSAGES_CODES]) {
		super(code);
		this.name = "DshExportMessagesError";
	}
}

export type DshExportHistoryPage = (beforeSeq: number | undefined, maxMessages: number) => Promise<DshEnvelope<DshHistoryPage>>;
export type DshExportMessagesCollection = { messages: ChatMessage[]; truncated: boolean };
type SequencedEntry = { event: Record<string, unknown> & { seq: number }; view: unknown };

function resolveLimits(overrides?: Partial<DshExportMessagesLimits>): DshExportMessagesLimits {
	const limits = { ...DSH_EXPORT_MESSAGES_LIMITS, ...overrides };
	if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)) throw new DshExportMessagesError(DSH_EXPORT_MESSAGES_CODES.limitsInvalid);
	return limits;
}

/** Normalize order at the boundary; malformed history must not silently become an empty export. */
function sequencedEntries(page: DshHistoryPage): SequencedEntry[] {
	if (!page || !Array.isArray(page.events) || (page.hasMore !== undefined && typeof page.hasMore !== "boolean")) throw new DshExportMessagesError(DSH_EXPORT_MESSAGES_CODES.pageInvalid);
	const entries: SequencedEntry[] = [];
	for (const entry of page.events) {
		const event = entry?.event;
		if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.seq !== "number" || !Number.isSafeInteger(event.seq) || event.seq < 0) throw new DshExportMessagesError(DSH_EXPORT_MESSAGES_CODES.pageInvalid);
		entries.push({ event: { ...event, seq: event.seq }, view: entry.view });
	}
	return entries.sort((left, right) => right.event.seq - left.event.seq);
}

/** Both raw event content and host tool views count toward the retained UTF-8 byte budget. */
function entryBytes(entry: SequencedEntry): number {
	try {
		return Buffer.byteLength(JSON.stringify(entry), "utf8");
	} catch {
		throw new DshExportMessagesError(DSH_EXPORT_MESSAGES_CODES.pageInvalid);
	}
}

/**
 * Read newest to oldest, deduplicate by seq, then replay one chronological stream.
 * A separate projection per page loses tool call/result pairing and assistant/model state.
 * Budgets retain the newest suffix; reaching the true last page exactly at a budget is not truncation.
 */
export async function collectDshExportMessages(input: { agentId: string; historyPage: DshExportHistoryPage; limits?: Partial<DshExportMessagesLimits> }): Promise<DshExportMessagesCollection> {
	const limits = resolveLimits(input.limits);
	const retained = new Map<number, SequencedEntry>();
	let beforeSeq: number | undefined;
	let bytes = 0;
	let truncated = false;
	for (let pagesRead = 0; pagesRead < limits.maxPages; pagesRead += 1) {
		let response: DshEnvelope<DshHistoryPage>;
		try {
			response = await input.historyPage(beforeSeq, limits.pageSize);
		} catch {
			throw new DshExportMessagesError(DSH_EXPORT_MESSAGES_CODES.readFailed);
		}
		if (!response?.result?.ok) throw new DshExportMessagesError(DSH_EXPORT_MESSAGES_CODES.readFailed);
		const page = response.result.value;
		const entries = sequencedEntries(page);
		const oldestSeq = entries.at(-1)?.event.seq;
		if (oldestSeq === undefined) {
			if (page.hasMore === true) throw new DshExportMessagesError(DSH_EXPORT_MESSAGES_CODES.cursorStalled);
			break;
		}
		const cursor = beforeSeq;
		if (cursor !== undefined && (oldestSeq >= cursor || entries.some((entry) => entry.event.seq >= cursor && !retained.has(entry.event.seq)))) throw new DshExportMessagesError(DSH_EXPORT_MESSAGES_CODES.cursorStalled);
		for (const entry of entries) {
			if (retained.has(entry.event.seq)) continue;
			const size = entryBytes(entry);
			if (bytes + size > limits.maxEventBytes) {
				truncated = true;
				break;
			}
			retained.set(entry.event.seq, entry);
			bytes += size;
		}
		if (truncated || page.hasMore !== true) break;
		if (pagesRead + 1 >= limits.maxPages || bytes >= limits.maxEventBytes) {
			truncated = true;
			break;
		}
		beforeSeq = oldestSeq;
	}
	const ordered = [...retained.values()].sort((left, right) => left.event.seq - right.event.seq);
	let projection = projectDshEvent(undefined, undefined, input.agentId);
	for (const { event, view } of ordered) projection = projectDshEvent(projection, event, input.agentId, view);
	// Replay is bounded by retained event bytes. Crop only afterwards: removing a pending skeleton
	// mid-replay makes its later final event append a different message and breaks chronological order.
	if (projection.messages.length > limits.maxMessages) truncated = true;
	return { messages: projection.messages.slice(-limits.maxMessages), truncated };
}
