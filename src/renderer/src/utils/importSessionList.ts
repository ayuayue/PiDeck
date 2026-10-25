/**
 * 导入会话列表的纯策略：关键字匹配语义 + 选择集合的「子集全选」。
 *
 * 单独成模块是为了能离开 React 单测（tests/importSessionList.test.mjs），
 * 同时把性能约定写死在一处：搜索索引随会话清单重建一次，输入时只做子串判定。
 */

/**
 * 首屏与每次「加载更多」渲染的行数。
 * Codex / Claude / 目录导入的会话可能上千条，一次性渲染整表会卡住弹窗，
 * 因此列表按窗口增量渲染（40 行足以填满弹窗可视区，滚动时再追加）。
 */
export const IMPORT_LIST_PAGE_SIZE = 40;

/** 归一化关键字：去首尾空白 + 小写（中文字符不受影响，英文标题/路径大小写不敏感）。 */
export function normalizeImportQuery(raw: string): string {
	return raw.trim().toLowerCase();
}

/**
 * 多关键字 AND 匹配：关键字按空白拆词，要求每个词都出现在索引串里。
 * 这样「2026-09 codex」这类跨字段搜索可用（日期与标题分属不同字段）。
 *
 * 边界：空关键字恒命中（调用方据此跳过过滤）；haystack 必须是
 * {@link buildImportSearchHaystack} 产出的小写索引，否则大小写敏感会漏命中。
 */
export function matchesImportQuery(haystack: string, normalizedQuery: string): boolean {
	if (!normalizedQuery) return true;
	return normalizedQuery.split(/\s+/).every((term) => haystack.includes(term));
}

/**
 * 拼接一行会话的小写搜索索引。
 * 逐个字段只拼一次（随会话清单重建），比每次输入都重新格式化上千行便宜得多。
 */
export function buildImportSearchHaystack(parts: Array<string | number | undefined | null>): string {
	return parts
		.filter((part) => part !== undefined && part !== null && part !== "")
		.join("\n")
		.toLowerCase();
}

/**
 * 时间字段的搜索串：本地时间 "YYYY-MM-DD HH:mm"。
 * 刻意不用 toLocaleString——逐行走 Intl 格式化在上千行时是可见的启动开销，
 * 而搜索只需要「按日期能找到」这一点。
 */
export function formatImportSearchTime(updatedAt: number | undefined): string {
	if (!updatedAt || !Number.isFinite(updatedAt)) return "";
	const date = new Date(updatedAt);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 子集全选 / 全不选：
 * - 目标集合已全部选中 → 只移除这些（保留集合外的已选项，例如上一次筛选选中的行）；
 * - 否则补齐这些，不动其它已选项；
 * - 目标集合为空时原样返回，避免「筛选后没有命中」把用户已有勾选悄悄清空。
 *
 * 用 Set 做 O(n+k) 判定：一次全选可能同时涉及上千行路径，
 * 早期写法（每次都用 includes 扫一遍选中集）在 5000 行规模下有一次点击可见的卡顿。
 */
export function toggleSelectedPaths(current: readonly string[], targets: readonly string[]): string[] {
	if (targets.length === 0) return [...current];
	const selected = new Set(current);
	const targetSet = new Set(targets);
	if (targets.every((path) => selected.has(path))) return current.filter((path) => !targetSet.has(path));
	const next = [...current];
	for (const path of targets) {
		// 同一路径只追加一次（targets 理论上唯一，但调用方传的是列表推导结果，这里兜底去重）。
		if (selected.has(path)) continue;
		selected.add(path);
		next.push(path);
	}
	return next;
}

/**
 * 增量渲染窗口：source 是当前数据源的引用，count 是已渲染行数。
 * 用引用比较判断「数据换了」——搜索关键字变化、重新扫描都会给出新数组，
 * 不回到首屏窗口的话新结果会一口气渲染上百行，卡顿就出在这里。
 */
export type ImportListWindow = { source: readonly unknown[]; count: number };

/** 数据源变了就回到首屏窗口；没变则原样返回（保持引用稳定，不触发多余渲染）。 */
export function resolveImportListWindow(window: ImportListWindow, source: readonly unknown[], pageSize: number): ImportListWindow {
	return window.source === source ? window : { source, count: pageSize };
}

/** 追加一批行；已渲染完或数据为空时返回原状态（不产生新引用）。 */
export function growImportListWindow(window: ImportListWindow, totalCount: number, pageSize: number): ImportListWindow {
	if (window.count >= totalCount) return window;
	return { source: window.source, count: Math.min(window.count + pageSize, totalCount) };
}
