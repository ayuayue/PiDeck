import { useCallback, useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { relativeTimeNowAtom, sessionActivityAnchorByIdAtom } from "../../atoms/sessionActivityAtoms";

/** 相对时间刷新节拍：侧栏只需挂一次，订阅 relativeTimeNowAtom 的行随之重渲染。 */
export function useRelativeTimeTicker(intervalMs = 30_000): void {
	const setNow = useSetAtom(relativeTimeNowAtom);
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
		return () => window.clearInterval(timer);
	}, [intervalMs, setNow]);
}

/**
 * 会话行的相对时间基准：有 live 计时点（这一轮从什么时候开始 / 到什么时候结束）就用它，
 * 否则回落持久化时间（catalog.updatedAt 或最近访问时间）。
 *
 * 订阅刷新节拍：`formatRelativeTime` 内部读 Date.now()，节拍一变就重算，
 * 空闲会话的「n分钟」才会自己往前走（不然标签会停在上一次渲染的时刻）。
 */
export function useSessionActivityAt(): (sessionId: string | undefined, fallbackAt: number) => number {
	const anchors = useAtomValue(sessionActivityAnchorByIdAtom);
	useAtomValue(relativeTimeNowAtom);
	return useCallback((sessionId: string | undefined, fallbackAt: number) => (sessionId ? (anchors[sessionId] ?? fallbackAt) : fallbackAt), [anchors]);
}
