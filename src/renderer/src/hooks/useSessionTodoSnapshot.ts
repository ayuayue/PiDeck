/**
 * useSessionTodoSnapshot — 历史会话 todo 快照 hook。
 *
 * 活会话（enabled=false）不发 IPC：runtime widgets 是唯一真源（实时 + dismissed 指纹）；
 * 历史会话（enabled=true，无 coherent runtime）从主进程读 pi-deck-todo custom 快照重建任务列表。
 * 与 useSessionSubagents 同构：切换会话后按 sessionId 重建。
 */
import { useEffect, useState } from "react";
import type { SessionTodoSnapshot } from "../../../shared/types";
import { desktopApi } from "../desktopApi";

export function useSessionTodoSnapshot(sessionId: string, enabled: boolean): SessionTodoSnapshot | undefined {
	const [snapshot, setSnapshot] = useState<SessionTodoSnapshot | undefined>(undefined);

	useEffect(() => {
		if (!enabled) return;
		let cancelled = false;
		desktopApi.sessions
			.listSessionTodo(sessionId)
			.then((result) => {
				if (!cancelled) setSnapshot(result);
			})
			.catch(() => {
				// 读失败保持 undefined：TasksPane 回落到空态，不阻塞其它段
			});
		return () => {
			cancelled = true;
		};
	}, [sessionId, enabled]);

	return snapshot;
}
