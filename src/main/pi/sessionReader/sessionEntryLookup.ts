import type { ChatMessage } from "../../../shared/types";
import type { SessionDisplayReadOptions } from "./sessionEntryParsing";
import { stripProjectionPrefix } from "../../../shared/sessionJumpAnchor";
/** 单条条目的最小形状（索引条目与事实行条目共用）。 */
interface LookupEntry {
	id: string;
	parentId?: string | null;
	type?: string;
	role?: unknown;
	offset: number;
	byteLength?: number;
	[key: string]: unknown;
}

/** 读单条 / 读全量索引所需的最小宿主能力（由 SessionHistoryReader 提供）。 */
export interface SessionEntryLookupHost {
	readIndex(sessionPath: string): Promise<{ entries: Map<string, LookupEntry>; activeMessageEntries: readonly LookupEntry[] }>;
	readFactLines(sessionPath: string, entries: LookupEntry[]): Promise<string[]>;
	/** 第三参是**单行**原文（sessionContent 口径），不是行数组。 */
	readDisplayMessages(sessionPath: string, agentId: string, line: string, options?: SessionDisplayReadOptions): Promise<ChatMessage[]>;
}

/**
 * 跳转按 entryId 读单条，以及全量条目索引。
 *
 * 单独成类是因为 SessionHistoryReader 是存量巨文件（只准降不准升），而这两段都只经
 * host 三个读口，不碰 reader 的内部状态。行为不变，只是搬家。
 */
/**
 * 在活动分支里找「字节偏移最接近且不超过目标」的位置：它就是那段历史现在的锚。
 *
 * 不能把文件序号当活动下标：两个下标空间不同（活动分支几百条，文件上万条），夹一下就
 * 全落到末尾，表现是「第一页和最后一页能跳，中间的全跳不了」（2026-11 真机）。
 */
export function pickAnchorOrdinal(activeEntries: readonly { offset: number }[], targetOffset: number): number {
	let best = 0;
	for (let i = 0; i < activeEntries.length; i += 1) {
		if (activeEntries[i].offset <= targetOffset) best = i;
		else break;
	}
	return best;
}

/** 全量条目表 -> 跳转索引行（ordinal 按文件顺序重编，只留消息条目）。 */
export function toEntryIndexRows(entries: Iterable<{ id: string; type?: string; role?: unknown }>): Array<{ entryId: string; ordinal: number; role: string }> {
	const rows: Array<{ entryId: string; ordinal: number; role: string }> = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		rows.push({ entryId: entry.id, ordinal: rows.length, role: String(entry.role ?? "") });
	}
	return rows;
}

export class SessionEntryLookup {
	constructor(private readonly host: SessionEntryLookupHost) {}

	/**
	 * 按 entryId 读单条显示消息，含被 compaction / context_edit 移出活动分支的条目。
	 * 那些条目不在 activeMessageEntries 里，分页永远取不到，用户搜到自己说过的话却只能
	 * 「定位到该时间附近」。返回 undefined = 文件里没有这个 entryId（真删除）。
	 */
	async readDisplayMessage(sessionPath: string, agentId: string, entryId: string, options?: SessionDisplayReadOptions): Promise<ChatMessage | undefined> {
		const index = await this.host.readIndex(sessionPath);
		const entry = index.entries.get(stripProjectionPrefix(entryId));
		if (!entry) return undefined;
		const [line] = await this.host.readFactLines(sessionPath, [entry]);
		if (!line) return undefined;
		const messages = await this.host.readDisplayMessages(sessionPath, agentId, line, options);
		return messages[0];
	}

	/**
	 * 文件里的每一条消息（含被压缩移出活动分支的）。
	 *
	 * 不能用 activeMessageEntries：那是「当前上下文」。会话一长必然多次压缩，早期消息
	 * 被摘要掉，而用户搜到的正是那些 —— 于是「索引里没有 → 报『不在活动分支』」。
	 * index.entries 是全量条目表（Map 保持文件顺序），这才是分页与跳转该走的空间。
	 */
	async readEntryIndex(sessionPath: string): Promise<Array<{ entryId: string; ordinal: number; role: string }>> {
		const index = await this.host.readIndex(sessionPath);
		return toEntryIndexRows(index.entries.values());
	}
}
