/**
 * 记忆条目列表的分页/展平（纯函数，可单测）。
 *
 * 设置页的列表是**单一时间线**：所有作用域按记录时间倒序混排，作用域信息跟着条目一起
 * 返回，行内用徽标区分全局 / 项目 / 本机设备。早期版本在时间线里插「分组行」，同一组
 * 的条目被别组隔开时会反复出现同样的表头（一屏里好几个「全局 通用记忆 MEMORY.md」），
 * 既占行又把列表切得零碎，所以不再插入分组行。
 *
 * 导出/导入弹窗仍按文件分组：它们用 `flattenMemoryRows` 拿「分组行 + 条目行」，行数随
 * 记忆量增长，渲染交给 VirtualStack（见 issue #481）。
 */

import type { AgentMemoryEntry, AgentMemoryEntryGroup } from "../../../../../shared/types/agentMemory";

/** 每页条数：与日志页一致。 */
export const MEMORY_PAGE_SIZE = 20;

/** 导出/导入弹窗的行模型：仍保留分组行，勾选与虚拟滚动按文件组织。 */
export type AgentMemoryRow = { kind: "group"; key: string; group: AgentMemoryEntryGroup } | { kind: "entry"; key: string; entry: AgentMemoryEntry };

/** 设置页列表的一行：条目 + 它所属的作用域（徽标、文件、预算都从这里取）。 */
export type AgentMemoryPageEntry = { key: string; entry: AgentMemoryEntry; group: AgentMemoryEntryGroup };

/** 条目身份：同一段内容可能同时存在于全局与项目作用域，所以键里必须带作用域。 */
export function memoryEntryId(entry: AgentMemoryEntry): string {
	return `${entry.scope}|${entry.projectId}|${entry.target}|${entry.key}`;
}

/** 分组身份：作用域 + 项目 + 目标文件，导出/导入/条目表三处共用同一套键。 */
export function memoryGroupKey(group: Pick<AgentMemoryEntryGroup, "scope" | "projectId" | "target">): string {
	return `group:${group.scope}|${group.projectId}|${group.target}`;
}

/** 总页数（空列表也算 1 页，避免分页控件出现 0 页）。 */
export function memoryTotalPages(totalEntries: number, pageSize = MEMORY_PAGE_SIZE): number {
	return Math.max(1, Math.ceil(totalEntries / pageSize));
}

/**
 * 全量行序列（分组行 + 条目行，不分页）：给虚拟滚动用。
 *
 * 不返回页切片是因为弹窗里要能「一直往下滚」勾选；行数由调用方的 VirtualStack 收敛成
 * 视口附近的几十行，DOM 不随条目总数增长。
 */
export function flattenMemoryRows(groups: readonly AgentMemoryEntryGroup[]): AgentMemoryRow[] {
	const rows: AgentMemoryRow[] = [];
	for (const group of groups) {
		// 空组只出一个「0/0」表头，没有任何可勾内容：与分页口径一致，直接跳过。
		if (group.entries.length === 0) continue;
		rows.push({ kind: "group", key: memoryGroupKey(group), group });
		for (const entry of group.entries) rows.push({ kind: "entry", key: memoryEntryId(entry), entry });
	}
	return rows;
}

/**
 * 全量条目时间线（不分页）：新记录在前，同时间或无时间时保留组序，组内按文件序号倒序。
 * 不改变原数据和导出顺序（导出仍走 `flattenMemoryRows`）。
 */
function memoryTimeline(groups: readonly AgentMemoryEntryGroup[]): AgentMemoryPageEntry[] {
	const entries = groups.flatMap((group, groupIndex) =>
		group.entries.map((entry) => {
			const time = Date.parse(entry.updatedAt ?? "");
			return { group, groupIndex, entry, time: Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY };
		}),
	);
	entries.sort((a, b) => (a.time !== b.time ? b.time - a.time : a.groupIndex - b.groupIndex || b.entry.index - a.entry.index));
	return entries.map(({ group, entry }) => ({ key: memoryEntryId(entry), entry, group }));
}

/**
 * 取第 page 页（1 起）。越界页码夹到首/尾页，删条目后不会停在空白页。
 * 每行都带 group：列表不再插分组行，作用域徽标与文件/预算提示需要逐条取。
 */
export function buildMemoryPageEntries(groups: readonly AgentMemoryEntryGroup[], page: number, pageSize = MEMORY_PAGE_SIZE): AgentMemoryPageEntry[] {
	const all = memoryTimeline(groups);
	const current = Math.min(Math.max(1, Math.trunc(page) || 1), memoryTotalPages(all.length, pageSize));
	const pageStart = (current - 1) * pageSize;
	return all.slice(pageStart, pageStart + pageSize);
}
