import { useEffect, useState } from "react";
import { desktopApi } from "../desktopApi";

/**
 * DSH 会话内容搜索（G9）：侧栏搜索框输入时的全文搜索（debounce 300ms）。
 * wire `session.search` 结果最多 20 会话；返回 { sessionId, snippet }，
 * 由调用方按 dshSessionId 映射回 catalog 记录。
 */
export function useDshSessionSearch(query: string): Array<{ sessionId: string; snippet: string }> {
	const [results, setResults] = useState<Array<{ sessionId: string; snippet: string }>>([]);

	useEffect(() => {
		const trimmed = query.trim();
		if (!trimmed) {
			setResults([]);
			return;
		}
		let cancelled = false;
		const timer = setTimeout(() => {
			void desktopApi.sessions
				.searchDshSessions(trimmed)
				.then((items) => {
					if (!cancelled) setResults(items);
				})
				.catch(() => {
					if (!cancelled) setResults([]);
				});
		}, 300);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [query]);

	return results;
}
