/**
 * 记忆条目列表的分页切片（纯函数，可单测）。
 *
 * 为什么要单独一个文件：分页的单位是**条目**，但表格里还有「分组行」（作用域 + 落盘文件 +
 * 预算）。两者混在一起时最容易出的错是「换页后条目还在、分组行没了」——读者看到一屏记忆
 * 却不知道它们属于哪个文件。这里让分组行跟着它在本页的第一条一起出现：一页从某个组中间
 * 开始时，页首补一次该组的分组行。
 */

import type { AgentMemoryEntry, AgentMemoryEntryGroup } from "../../../../../shared/types/agentMemory";

/** 每页条数：与日志页一致。 */
export const MEMORY_PAGE_SIZE = 20;

export type AgentMemoryRow = { kind: "group"; key: string; group: AgentMemoryEntryGroup } | { kind: "entry"; key: string; entry: AgentMemoryEntry };

/** 条目身份：同一段内容可能同时存在于全局与项目作用域，所以键里必须带作用域。 */
export function memoryEntryId(entry: AgentMemoryEntry): string {
	return `${entry.scope}|${entry.projectId}|${entry.target}|${entry.key}`;
}

/** 总页数（空列表也算 1 页，避免分页控件出现 0 页）。 */
export function memoryTotalPages(totalEntries: number, pageSize = MEMORY_PAGE_SIZE): number {
	return Math.max(1, Math.ceil(totalEntries / pageSize));
}

/**
 * 取第 page 页（1 起）的行。越界页码夹到首/尾页，删条目后不会停在空白页。
 */
export function buildMemoryPageRows(groups: readonly AgentMemoryEntryGroup[], page: number, pageSize = MEMORY_PAGE_SIZE): AgentMemoryRow[] {
	const totalEntries = groups.reduce((sum, group) => sum + group.entries.length, 0);
	const current = Math.min(Math.max(1, Math.trunc(page) || 1), memoryTotalPages(totalEntries, pageSize));
	const pageStart = (current - 1) * pageSize;
	const pageEnd = pageStart + pageSize;
	const rows: AgentMemoryRow[] = [];
	let offset = 0;
	for (const group of groups) {
		const start = Math.max(0, pageStart - offset);
		const end = Math.min(group.entries.length, pageEnd - offset);
		if (end > start) {
			rows.push({ kind: "group", key: `group:${group.scope}|${group.projectId}|${group.target}`, group });
			for (let index = start; index < end; index += 1) {
				const entry = group.entries[index];
				rows.push({ kind: "entry", key: memoryEntryId(entry), entry });
			}
		}
		offset += group.entries.length;
		if (offset >= pageEnd) break;
	}
	return rows;
}
