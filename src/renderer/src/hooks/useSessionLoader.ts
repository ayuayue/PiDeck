/**
 * 会话延迟加载 Hook
 * 只在用户展开项目时加载该项目的会话列表
 */
import { useState, useEffect, useCallback, useRef } from "react";

interface SessionLoaderOptions<T> {
	projectId: string;
	isCollapsed: boolean;
	loadFn: (projectId: string) => Promise<T[]>;
	enabled?: boolean;
}

interface SessionLoaderResult<T> {
	sessions: T[];
	isLoading: boolean;
	error: Error | null;
	refresh: () => Promise<void>;
}

export function useSessionLoader<T>({ projectId, isCollapsed, loadFn, enabled = true }: SessionLoaderOptions<T>): SessionLoaderResult<T> {
	const [sessions, setSessions] = useState<T[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<Error | null>(null);
	const hasLoadedRef = useRef(false);
	const loadingRef = useRef(false);

	const load = useCallback(async () => {
		if (!enabled || loadingRef.current) return;

		loadingRef.current = true;
		setIsLoading(true);
		setError(null);

		try {
			const result = await loadFn(projectId);
			setSessions(result);
			hasLoadedRef.current = true;
		} catch (err) {
			setError(err instanceof Error ? err : new Error(String(err)));
		} finally {
			setIsLoading(false);
			loadingRef.current = false;
		}
	}, [projectId, loadFn, enabled]);

	const refresh = useCallback(async () => {
		hasLoadedRef.current = false;
		await load();
	}, [load]);

	// 延迟加载：只在项目展开且未加载过时加载
	useEffect(() => {
		if (!isCollapsed && !hasLoadedRef.current && enabled) {
			// 使用 requestIdleCallback 在浏览器空闲时加载
			const hasIdleCallback = typeof window.requestIdleCallback === "function";
			const idleCallback = hasIdleCallback
				? window.requestIdleCallback(() => {
						void load();
					})
				: window.setTimeout(() => {
						void load();
					}, 0);

			return () => {
				if (hasIdleCallback) {
					window.cancelIdleCallback(idleCallback as number);
				} else {
					window.clearTimeout(idleCallback as number);
				}
			};
		}
	}, [isCollapsed, load, enabled]);

	// 项目ID变化时重置状态
	useEffect(() => {
		hasLoadedRef.current = false;
		setSessions([]);
		setError(null);
	}, [projectId]);

	return {
		sessions,
		isLoading,
		error,
		refresh,
	};
}
