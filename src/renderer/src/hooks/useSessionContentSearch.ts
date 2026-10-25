import { useEffect, useState } from "react";
import type { SessionSearchResult } from "../../../shared/types";
import { desktopApi } from "../desktopApi";

/**
 * 跨会话正文搜索（Go session-index sidecar）：侧栏搜索词变化时 debounce 触发。
 * 结果含按会话分组的命中（messageId 可用于跳转定位）；无 sidecar/降级/失败时
 * IPC 返回 null（渲染层不感知差异，仅少一个结果区块）。
 */
export function useSessionContentSearch(query: string): SessionSearchResult | null {
	const [result, setResult] = useState<SessionSearchResult | null>(null);

	useEffect(() => {
		const trimmed = query.trim();
		if (trimmed.length < 2) {
			// 单字符全文搜索噪音过大（中文单字/英文字母命中过半会话），不触发远端检索
			setResult(null);
			return;
		}
		let cancelled = false;
		const timer = setTimeout(() => {
			void desktopApi.sessions
				.searchContent(trimmed)
				.then((items) => {
					if (!cancelled) setResult(items);
				})
				.catch(() => {
					if (!cancelled) setResult(null);
				});
		}, 300);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [query]);

	return result;
}
