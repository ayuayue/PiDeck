import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileContentSearchResult, FileSearchResult } from "../../../shared/types";
import { filterSnapshotResults } from "../utils/fileSearchFilter";

/**
 * 工作区文件搜索（issue #215）的渲染层状态域：
 * 拥有查询词、防抖调度、代次防竞态、与最近一次完整请求的快照。
 * UI 只消费返回值并转发输入事件，不持有搜索状态。
 */
export const FILE_SEARCH_DEBOUNCE_MS = 250;
/** 内容检索的最小查询词长度：单字符几乎命中所有文件，扫盘纯噪音（与跨会话正文搜索口径一致）。 */
export const FILE_CONTENT_SEARCH_MIN_QUERY_LENGTH = 2;

export function useFileSearch(options: { projectId?: string }) {
	const { projectId } = options;
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<FileSearchResult[] | null>(null);
	const [isSearching, setIsSearching] = useState(false);
	// 内容检索单独一份状态：名字结果毫秒级先出，内容要扫盘（受字节预算约束），先到先渲染。
	const [contentResults, setContentResults] = useState<FileContentSearchResult | null>(null);
	const [isContentSearching, setIsContentSearching] = useState(false);
	// 代次计数：每次新请求递增；旧请求返回时因代次不匹配被丢弃，
	// 防止慢扫描（主进程最长可跑 8s）覆盖新结果（同 #159 files:list 的防竞态思路）。
	const requestSeqRef = useRef(0);
	// 「最近一次非空查询的完整结果」快照：只在查询变长时更新。
	// 查询被删短后新结果集必然是快照的子集，可先在前端过滤即时反馈，防抖结束才可能再打 IPC。
	const lastGoodRef = useRef<{ query: string; results: FileSearchResult[] } | null>(null);

	const searchNow = useCallback(
		async (rawQuery: string) => {
			const trimmed = rawQuery.trim();
			if (trimmed.length === 0) {
				// 空查询 = 退出搜索态：清结果、放快照，避免下次搜索还命中过期引用
				requestSeqRef.current += 1;
				lastGoodRef.current = null;
				setResults(null);
				setIsSearching(false);
				setContentResults(null);
				setIsContentSearching(false);
				return;
			}
			if (!projectId) return;
			const seq = ++requestSeqRef.current;
			setIsSearching(true);
			// 内容检索与名字检索并行（同一防抖窗口、同一代次）：
			// 名字结果不参与前缀快照过滤的是内容那一份，内容只认最新请求，迟到结果直接丢弃。
			const contentEnabled = trimmed.length >= FILE_CONTENT_SEARCH_MIN_QUERY_LENGTH;
			if (contentEnabled) setIsContentSearching(true);
			else {
				setContentResults(null);
				setIsContentSearching(false);
			}
			void (contentEnabled ? window.piDesktop.files.searchContent(projectId, trimmed) : Promise.resolve(null))
				.then((content) => {
					if (seq === requestSeqRef.current) setContentResults(content);
				})
				.catch(() => {
					if (seq === requestSeqRef.current) setContentResults(null);
				})
				.finally(() => {
					if (seq === requestSeqRef.current) setIsContentSearching(false);
				});
			try {
				const list = await window.piDesktop.files.search(projectId, trimmed);
				if (seq !== requestSeqRef.current) return; // 迟到的旧请求：静默丢弃
				setResults(list);
				// 查询变长时快照才更新：保证快照查询恒为当前查询的前缀，前缀过滤才有意义
				const last = lastGoodRef.current;
				if (!last || trimmed.length >= last.query.length) {
					lastGoodRef.current = { query: trimmed, results: list };
				}
			} catch {
				// 主进程错误已在日志侧记录；UI 只需停止 loading，保留上一次结果避免闪空
				if (seq === requestSeqRef.current) setIsSearching(false);
			} finally {
				if (seq === requestSeqRef.current) setIsSearching(false);
			}
		},
		[projectId],
	);

	// 防抖：停止输入 250ms 才发起扫描；切项目立即清态（旧项目的查询对新项目无意义）。
	useEffect(() => {
		if (query.trim().length === 0) {
			void searchNow("");
			return;
		}
		if (!projectId) return;
		const timer = setTimeout(() => void searchNow(query), FILE_SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [query, projectId, searchNow]);

	// 卸载时作废在途请求，防止 setState 到已卸载组件
	useEffect(
		() => () => {
			requestSeqRef.current += 1;
		},
		[],
	);

	/**
	 * 展示列表：查询是快照查询的前缀时走前端过滤（零延迟），
	 * 否则用服务端结果；无结果时为 null（UI 显示扫描中/空态）。
	 */
	const displayResults = useMemo<FileSearchResult[] | null>(() => {
		const trimmed = query.trim();
		if (trimmed.length === 0) return null;
		const last = lastGoodRef.current;
		if (last) {
			const filtered = filterSnapshotResults(last, trimmed);
			if (filtered) return filtered;
		}
		return results;
	}, [query, results]);

	/** 清空搜索框并退出搜索态（Esc / 关闭按钮） */
	const clearSearch = useCallback(() => setQuery(""), []);

	return { query, setQuery, results: displayResults, isSearching, contentResults, isContentSearching, clearSearch, searchNow };
}
