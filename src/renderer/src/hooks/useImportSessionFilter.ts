import { useCallback, useMemo, useRef, useState } from "react";
import { matchesImportQuery, normalizeImportQuery } from "../utils/importSessionList";

/**
 * 导入弹窗的关键字过滤（标题 / 摘要 / 路径 / 日期 / 状态）。
 *
 * 性能约定：每行的搜索索引（haystack）只随 sessions 变化重建一次，
 * 敲键盘时仅对已有索引做子串判定——否则上千行列表每输入一个字符都要
 * 重新格式化时间与拼接字段，输入会明显掉帧。
 */
export function useImportSessionFilter<T>(sessions: readonly T[], buildHaystack: (session: T) => string) {
	const [query, setQuery] = useState("");
	// buildHaystack 常以行内函数传入：存 ref 保证索引只依赖 sessions，而不是每次渲染的函数身份。
	const buildHaystackRef = useRef(buildHaystack);
	buildHaystackRef.current = buildHaystack;

	const normalizedQuery = useMemo(() => normalizeImportQuery(query), [query]);
	const indexed = useMemo(() => sessions.map((session) => ({ session, haystack: buildHaystackRef.current(session) })), [sessions]);
	const matched = useMemo<readonly T[]>(() => {
		// 无关键字时直接返回原数组：保持引用稳定，下游的窗口 hook 与分组 memo 才不会白跑。
		if (!normalizedQuery) return sessions;
		return indexed.filter((entry) => matchesImportQuery(entry.haystack, normalizedQuery)).map((entry) => entry.session);
	}, [indexed, normalizedQuery, sessions]);
	const clearQuery = useCallback(() => setQuery(""), []);

	return {
		query,
		setQuery,
		clearQuery,
		matched,
		totalCount: sessions.length,
		isSearching: normalizedQuery.length > 0,
	};
}
