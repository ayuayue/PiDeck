import type { FileSearchResult } from "../../../shared/types";

/**
 * 搜索快照的回退过滤（issue #215 纯策略）：
 * 当前查询是快照查询的前缀时，命中集合必然是快照结果的子集，
 * 直接在前端按「文件名包含查询」过滤，零 IPC 延迟；前缀不成立返回 null，
 * 调用方应改用服务端结果。匹配语义与主进程 searchNames 一致（小写子串）。
 */
export function filterSnapshotResults(snapshot: { query: string; results: FileSearchResult[] }, currentQuery: string): FileSearchResult[] | null {
	const current = currentQuery.trim().toLowerCase();
	const snapshotQuery = snapshot.query.toLowerCase();
	if (current.length === 0 || !current.startsWith(snapshotQuery)) return null;
	return snapshot.results.filter((item) => item.name.toLowerCase().includes(current));
}

/**
 * 计算文件名中查询词的高亮起点；未命中返回 -1。
 * 独立成函数是为了让渲染层与主进程的「小写子串」语义有唯一的对照实现。
 */
export function findFileNameMatchIndex(name: string, query: string): number {
	const normalized = query.trim().toLowerCase();
	// 空查询（含纯空白）无高亮语义：indexOf("") 恒返 0 会把整个名称标成命中，显式排除
	if (normalized.length === 0) return -1;
	return name.toLowerCase().indexOf(normalized);
}
