import { useEffect, useState } from "react";
import { desktopApi } from "../desktopApi";
import type { SessionOutlineEntry } from "../../../shared/types/outline";

/**
 * 用户检查点目录（导轨）的取数：pi 会话走索引派生，dsh/ACP 返回空目录后由调用方回退已加载大纲。
 *
 * 触发：会话变化 + 已加载消息条数变化（新消息落盘后目录可能变长）。
 * 目录本身是索引投影（主进程有 LRU），重复拉取不读正文。
 */
export function useSessionOutlineDirectory(sessionId: string | undefined, loadedCount: number): SessionOutlineEntry[] {
	const [entries, setEntries] = useState<SessionOutlineEntry[]>([]);
	useEffect(() => {
		if (!sessionId) {
			setEntries([]);
			return;
		}
		let disposed = false;
		void desktopApi.sessions
			.readOutline(sessionId)
			.then((snapshot) => {
				if (!disposed) setEntries(snapshot.entries);
			})
			.catch(() => {
				if (!disposed) setEntries([]);
			});
		return () => {
			disposed = true;
		};
	}, [sessionId, loadedCount]);
	return entries;
}
