/**
 * 配置弹窗列表的搜索过滤（认证页供应商卡片、DSH 模型目录）。
 *
 * 为什么单独成模块：
 * 1. 匹配规则（去首尾空白 + 大小写不敏感 + 多字段任一命中）必须两处一致，写在 JSX 里会各写一份；
 * 2. 返回**原始下标**而不是过滤后的数组：DSH 模型行用下标定位行内编辑/删除（id 是行内可编辑
 *    字段，不能当 key），组件拿到过滤结果后还要按下标回写；认证页顺带取 row 即可。
 */

/** 一行的命中判定：任一文本片段包含关键词（片段可以是 undefined / null，跳过）。 */
function rowMatches(needle: string, parts: readonly (string | null | undefined)[]): boolean {
	return parts.some((part) => typeof part === "string" && part.toLowerCase().includes(needle));
}

/**
 * 按关键词过滤并保留原始下标。
 *
 * - 空关键词（含纯空白）返回全部行，顺序不变；
 * - 大小写不敏感，命中 `partsOf(row)` 里任意一个片段；
 * - 不区分隐藏/可见等其它业务筛选，调用方传进来的就是最终展示集合。
 */
export function filterIndexedRows<T>(rows: readonly T[], query: string, partsOf: (row: T) => readonly (string | null | undefined)[]): Array<{ row: T; index: number }> {
	const needle = query.trim().toLowerCase();
	return rows.flatMap((row, index) => (needle && !rowMatches(needle, partsOf(row)) ? [] : [{ row, index }]));
}
