/**
 * useSessionFileChanges — 「最新一轮」文件修改数据 hook。
 *
 * 数据源：主进程 IPC 聚合（按最后一个 user 消息切分，只返回最新一轮
 * write/edit/create/patch，历史/活会话通用）+ 当前 run 增量合并
 * （流式期未落盘消息立即可见）。
 *
 * 刷新时机（为什么依赖 run?.id）：主进程返回的是「最新一轮」，会话打开时
 * 拉到的是当时的最新一轮；新 run 开始意味着用户发了新一轮提问，此时必须
 * 重拉，否则横栏会一直停留在旧轮次（旧实现只在 sessionId 变化时拉一次，
 * 导致文件随轮次无限堆积）。流式期未落盘部分仍由 run 增量合并补齐。
 */
import { useEffect, useMemo, useState } from "react";
import type { SessionFileChange } from "../../../shared/types";
import type { AgentRunItem } from "../components/app/AppUtils";
import { collectRunFileChanges } from "../components/session/TimelineFormat";
import { mergeRunFileChanges } from "../components/session/turn/fileChangesMerge";
import { desktopApi } from "../desktopApi";

export function useSessionFileChanges(
	sessionId: string,
	run?: AgentRunItem,
): { entries: SessionFileChange[]; loading: boolean } {
	const [full, setFull] = useState<SessionFileChange[]>([]);
	const [loading, setLoading] = useState(false);

	// 主进程 IPC：拉取最新一轮（初次 / 会话切换 / 新一轮开始）
	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		desktopApi.sessions
			.listSessionFileChanges(sessionId)
			.then((entries) => {
				if (!cancelled) {
					setFull(entries);
					setLoading(false);
				}
			})
			.catch(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [sessionId, run?.id]);

	// 当前 run 增量（流式未落盘部分），与全量合并
	const runEntries = useMemo(() => (run ? collectRunFileChanges(run) : []), [run]);
	const entries = useMemo(() => mergeRunFileChanges(full, runEntries), [full, runEntries]);

	return { entries, loading };
}
