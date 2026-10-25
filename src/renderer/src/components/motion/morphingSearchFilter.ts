// MorphingSearch 的检索项过滤（纯函数，可单测）：
// 子串命中 title/description/keywords，纯字母查询额外走拼音通道（首字母/全拼）。
//
// 为什么单独成模块：这是产品规则（「哪些项算命中」），不该只活在组件的 JSX
// lambda 里；拼音通道的分数只用来判「是否留下」，不重排——列表顺序是目录/会话
// 的既有顺序，按分数重排会让侧栏搜索与侧栏树顺序不一致。
import { isPinyinQuery, matchPinyin, type PinyinKeys } from "../../utils/pinyinSearch";

export type SearchFilterItem = {
	title: string;
	description?: string;
	keywords?: string[];
	/** 标题的拼音键：渲染层本地过滤拿不到 sidecar 索引，由调用方算好（自带缓存）。 */
	pinyin?: PinyinKeys | null;
};

/** 空查询返回原数组（保持引用稳定）：调用方按数组身份记忆过滤结果。 */
export function filterSearchItems<T extends SearchFilterItem>(items: T[], query: string): T[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return items;

	// 拼音通道只对纯小写字母且长度 2..24 的查询启用，中文/带标点的照旧走子串匹配。
	const pinyinQuery = isPinyinQuery(needle);
	return items.filter((item) => {
		const haystack = [item.title, item.description ?? "", ...(item.keywords ?? [])].join(" ").toLowerCase();
		if (haystack.includes(needle)) return true;
		return pinyinQuery && matchPinyin(item.pinyin ?? null, needle) > 0;
	});
}
