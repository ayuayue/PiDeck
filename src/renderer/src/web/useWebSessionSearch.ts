/**
 * Web 端会话内搜索：优先走后端全会话检索（session-index sidecar / DSH 历史投影），
 * 后端不可用时回退到「已加载消息」的本地扫描。
 *
 * 为什么不是纯本地：Web 端只加载有界窗口（9 轮 + 更早历史按需翻页），大会话里搜
 * 未加载的部分本来必然落空——桌面端早就接了 sidecar，Web 端漏接。
 *
 * 三态语义（与桌面端 useSessionMessageSearch 对齐）：
 * - `result != null`：后端给出了结论（可能是 0 命中）；
 * - `result == null && unavailable`：检索源不可用 → 用本地结果兜底并提示范围受限；
 * - 后端就绪但命中 id 不在已加载消息里：前端补拉该页历史后再滚动定位（见 WebChatApp）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { UIMessage } from "ai";
import type { SessionSearchResult } from "../../../shared/types";
import { fetchSessionSearch } from "./webApi";
import { searchWebMessages, type WebSearchHit } from "./webSearch";

/** 输入停顿多久才打后端（逐键请求会让 sidecar 做无意义的全量语料扫描）。 */
export const WEB_SEARCH_DEBOUNCE_MS = 250;

/** 后端命中条数上限（与本地 MAX_HITS 一致，避免弹层无限长）。 */
const MAX_REMOTE_HITS = 50;

export type WebSessionSearchState = {
	hits: WebSearchHit[];
	/** false = 结果来自本地已加载消息（范围受限）；true = 后端全会话检索 */
	remote: boolean;
	/** 后端不可用（索引未就绪/后端未装配），此时 remote=false 且提示范围受限 */
	unavailable: boolean;
	/** 后端报的命中总数（可能大于 hits.length）；本地模式为 hits.length */
	hitCount: number;
	/** 搜索进行中 */
	searching: boolean;
};

const EMPTY: WebSessionSearchState = { hits: [], remote: false, unavailable: false, hitCount: 0, searching: false };

/** 后端命中 → 弹层命中项（role 归一成 "user"/"assistant" 供左右箭头渲染）。 */
export function remoteHitsFromResult(result: SessionSearchResult | null): WebSearchHit[] {
	if (!result) return [];
	const matches = result.sessions[0]?.matches ?? [];
	return matches.slice(0, MAX_REMOTE_HITS).map((match) => ({
		id: match.messageId,
		role: match.role,
		snippet: match.snippet,
	}));
}

export function useWebSessionSearch(sessionId: string | undefined, query: string, messages: UIMessage[], enabled: boolean): WebSessionSearchState {
	const [remoteResult, setRemoteResult] = useState<SessionSearchResult | null | undefined>(undefined);
	const [searching, setSearching] = useState(false);
	const requestSeqRef = useRef(0);
	const trimmed = query.trim();

	useEffect(() => {
		// 查询或会话变化立刻作废在途请求的回包（序号不匹配直接丢弃），
		// 否则慢响应会把上一个会话的命中贴到当前弹层。
		requestSeqRef.current += 1;
		const seq = requestSeqRef.current;
		if (!enabled || !sessionId || !trimmed) {
			setRemoteResult(undefined);
			setSearching(false);
			return;
		}
		setSearching(true);
		const timer = setTimeout(() => {
			void (async () => {
				let result: SessionSearchResult | null = null;
				try {
					result = await fetchSessionSearch(sessionId, trimmed);
				} catch {
					result = null;
				}
				if (requestSeqRef.current !== seq) return;
				setRemoteResult(result);
				setSearching(false);
			})();
		}, WEB_SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [enabled, sessionId, trimmed]);

	return useMemo(() => {
		if (!trimmed) return EMPTY;
		// undefined = 首轮请求还没回来：先展示本地命中，避免弹层空白闪烁
		if (remoteResult === undefined) {
			const local = searchWebMessages(messages, trimmed);
			return { hits: local, remote: false, unavailable: false, hitCount: local.length, searching };
		}
		if (remoteResult === null) {
			const local = searchWebMessages(messages, trimmed);
			return { hits: local, remote: false, unavailable: true, hitCount: local.length, searching: false };
		}
		const hits = remoteHitsFromResult(remoteResult);
		const first = remoteResult.sessions[0];
		return {
			hits,
			remote: true,
			unavailable: false,
			hitCount: first?.hitCount ?? hits.length,
			searching: false,
		};
	}, [messages, remoteResult, searching, trimmed]);
}
