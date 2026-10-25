/**
 * 分页页码窗口纯函数：生成带省略号的页码序列（1 基），供共享 Pagination 组件渲染。
 * 规则：当前页前后各 sibling 页常驻，首页/尾页常驻，缺口用省略号占位；
 * 页码较少（≤ sibling*2+3）时直接返回完整序列，不产生省略号。
 */

export type PaginationItem = number | "ellipsis-start" | "ellipsis-end";

/**
 * 生成页码窗口。
 * @param page 当前页（1 基，越界时收敛到 [1, totalPages]）
 * @param totalPages 总页数（≤ 0 视为 1）
 * @param sibling 当前页两侧各保留的页码数（默认 2）
 * @returns 如 [1, "ellipsis-start", 5, 6, 7, "ellipsis-end", 20]
 */
export function paginationWindow(page: number, totalPages: number, sibling = 2): PaginationItem[] {
	const total = Math.max(1, Math.floor(totalPages));
	const current = Math.min(Math.max(1, Math.floor(page)), total);
	if (total <= sibling * 2 + 3) {
		return Array.from({ length: total }, (_, i) => i + 1);
	}

	const start = Math.max(1, current - sibling);
	const end = Math.min(total, current + sibling);
	const items: PaginationItem[] = [];
	if (start > 1) {
		items.push(1);
		if (start > 2) items.push("ellipsis-start");
	}
	for (let p = start; p <= end; p++) items.push(p);
	if (end < total) {
		if (end < total - 1) items.push("ellipsis-end");
		items.push(total);
	}
	return items;
}
