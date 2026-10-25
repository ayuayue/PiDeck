/** Raw historical entries are a separate, bounded projection, never a model-request reconstruction. */
import { open } from "node:fs/promises";
import type { HostPluginEntriesPage, HostPluginEntryCursor } from "../../shared/types/hostPlugin";

export type IndexedHistoryEntry = { id: string; type: string; parentId: string | null; offset: number; byteLength: number; chainHostPath?: string; oversized?: true };
const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_PAGE_ENTRIES = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strip filesystem identity and inline image bytes before crossing the plugin boundary. */
function projectValue(value: unknown, depth = 0): unknown {
	if (depth > 24) return null;
	if (Array.isArray(value)) return value.map((item) => projectValue(item, depth + 1));
	if (!isRecord(value)) return value;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (["__proto__", "constructor", "prototype", "cwd", "parentSession", "sessionFile", "filePath"].includes(key)) continue;
		if (value.type === "image" && ["data", "imageRef", "url", "source"].includes(key)) continue;
		result[key] = projectValue(item, depth + 1);
	}
	return result;
}

/** Read only indexed byte ranges, newest page first, with a cursor bound to a file revision. */
export async function readBoundedEntryPage(hostPath: string, entries: readonly IndexedHistoryEntry[], version: string, cursor?: HostPluginEntryCursor): Promise<HostPluginEntriesPage> {
	if (cursor && (cursor.version !== version || !Number.isSafeInteger(cursor.before) || cursor.before < 0 || cursor.before > entries.length)) throw new Error("stale-cursor");
	const before = cursor?.before ?? entries.length;
	let start = before;
	let bytes = 0;
	while (start > 0 && before - start < MAX_PAGE_ENTRIES) {
		const entry = entries[start - 1];
		const cost = entry.byteLength > MAX_ENTRY_BYTES || entry.oversized ? 0 : entry.byteLength;
		if (bytes + cost > MAX_PAGE_BYTES) break;
		bytes += cost;
		start -= 1;
	}
	const result: Record<string, unknown>[] = [];
	let truncated = false;
	for (const entry of entries.slice(start, before)) {
		if (entry.oversized || entry.byteLength > MAX_ENTRY_BYTES) {
			truncated = true;
			result.push({ id: entry.id, type: entry.type, parentId: entry.parentId, omitted: "entry-too-large" });
			continue;
		}
		const handle = await open(entry.chainHostPath ?? hostPath, "r");
		try {
			const buffer = Buffer.alloc(entry.byteLength);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, entry.offset);
			if (bytesRead !== entry.byteLength) throw new Error("history-changed");
			const parsed: unknown = JSON.parse(buffer.toString("utf8"));
			const projected = projectValue(parsed);
			if (!isRecord(projected) || projected.id !== entry.id) throw new Error("history-changed");
			result.push(projected);
		} finally {
			await handle.close();
		}
	}
	return { entries: result, nextCursor: start > 0 ? { before: start, version } : null, version, truncated };
}
