import { useEffect, useRef, useState } from "react";
import type { SessionSearchResult } from "../../../shared/types";

/** 会话内查找的最小查询长度（1 个字符命中太多，导航没有意义）。 */
export const SESSION_FIND_MIN_QUERY_LENGTH = 1;
/** 输入停顿后多久发请求：会话内查找是单文件扫描，比跨会话搜索可以更跟手。 */
export const SESSION_FIND_DEBOUNCE_MS = 160;

export type SessionMessageSearchState = {
	/** 命中列表（按时间线顺序，Go 侧已排序）；null = 还没查/查询太短。 */
	result: SessionSearchResult | null;
	isSearching: boolean;
	/**
	 * true = 检索源暂时不可用（pi 索引缺失/未就绪/WSL，或 DSH host 启动失败/未就绪），
	 * 渲染层显示「暂时读不到」而不是「没有匹配」——这两件事故意区分开，否则用户会
	 * 以为会话里真没这个词。
	 */
	unavailable: boolean;
};

/**
 * 会话内查找：输入停顿后问主进程在**当前会话**里找关键词。
 *
 * 入参是 SessionRecord.id（不是会话文件路径）：主进程按 catalog 的后端分派——
 * pi 会话走 Go session-index 的单文件检索，DSH 会话走 host 历史投影，渲染层不关心
 * 后端差异。范围是单个会话、命中按时间线顺序返回（供上一条/下一条导航）、防抖更短。
 * 请求结果按「代次 + 会话」双重校验：切会话/改词后迟到的回包一律丢弃，不会把上一个
 * 会话的命中贴到当前会话。
 */
export function useSessionMessageSearch(sessionId: string | null | undefined, query: string, enabled = true): SessionMessageSearchState {
	const [result, setResult] = useState<SessionSearchResult | null>(null);
	const [isSearching, setIsSearching] = useState(false);
	const [unavailable, setUnavailable] = useState(false);
	const requestSeqRef = useRef(0);

	useEffect(() => {
		const trimmed = query.trim();
		const usable = enabled && Boolean(sessionId) && trimmed.length >= SESSION_FIND_MIN_QUERY_LENGTH;
		if (!usable) {
			requestSeqRef.current += 1;
			setResult(null);
			setIsSearching(false);
			setUnavailable(false);
			return;
		}
		const seq = requestSeqRef.current + 1;
		requestSeqRef.current = seq;
		setIsSearching(true);
		const timer = setTimeout(() => {
			void window.piDesktop.sessions
				.searchInSession(sessionId as string, trimmed)
				.then((value) => {
					if (requestSeqRef.current !== seq) return;
					// null = 主进程拿到了 but 检索源不可用（索引未就绪 / DSH host 未就绪 / 失败降级）
					setUnavailable(value === null);
					setResult(value);
				})
				.catch(() => {
					if (requestSeqRef.current !== seq) return;
					setUnavailable(true);
					setResult(null);
				})
				.finally(() => {
					if (requestSeqRef.current === seq) setIsSearching(false);
				});
		}, SESSION_FIND_DEBOUNCE_MS);
		return () => {
			clearTimeout(timer);
			requestSeqRef.current += 1;
		};
	}, [enabled, query, sessionId]);

	return { result, isSearching, unavailable };
}
