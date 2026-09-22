/**
 * 「快捷消息」弹框的纯视图模型：搜索过滤 + 分页切片。
 *
 * 抽成纯函数（而不是写在组件里）是因为分页边界最容易写错又最难测：过滤把结果截短、
 * 用户在设置里删条、手工编辑配置文件后条目变少，都会让「当前页码」越界——夹紧规则
 * 必须能脱离 React 单测（tests/quickMessages.test.mjs）。
 */

/**
 * 每页条数。取 8 是因为弹框高度要压到一屏内可扫（约 8 行 ≈ 224px），
 * 出厂 16 条刚好两页，翻一页就能看全，不必滚动。
 */
export const QUICK_MESSAGE_PAGE_SIZE = 8;

/**
 * 搜索过滤：去首尾空白 + 小写子串匹配（中英混排条目也能直接用原文搜）。
 * 刻意不做模糊/模糊子序列匹配：条目都是短句，模糊匹配会把「提交推送」拆散成
 * 一堆命中（拼音/首字母同理），搜「提交」反而更该只看到包含「提交」的两条。
 */
export function filterQuickMessages(items: readonly string[], query: string): string[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [...items];
	return items.filter((item) => item.toLowerCase().includes(needle));
}

/**
 * 分页切片：页码越界时夹紧到 [1, totalPages]，并把夹紧后的页码一并返回。
 *
 * 为什么不直接抛/返回空页：空页在界面上表现为「明明有条目却什么都没有」，
 * 而越界是正常操作导致的（搜完再清空搜索、刚删掉几条），必须自愈。
 * 空清单视为 1 页（而不是 0 页），这样分页控件不会出现「第 0 页」这种状态。
 */
export function paginateQuickMessages(items: readonly string[], page: number, pageSize: number = QUICK_MESSAGE_PAGE_SIZE): { items: string[]; page: number; totalPages: number } {
	// pageSize 由调用方（含测试）可覆盖，非法值统一收敛成 1，避免除 0 得到 Infinity 页
	const size = Math.max(1, Math.floor(pageSize) || 1);
	const totalPages = Math.max(1, Math.ceil(items.length / size));
	const requested = Math.floor(page);
	const clamped = Number.isFinite(requested) ? Math.min(Math.max(1, requested), totalPages) : 1;
	const start = (clamped - 1) * size;
	return { items: items.slice(start, start + size), page: clamped, totalPages };
}
