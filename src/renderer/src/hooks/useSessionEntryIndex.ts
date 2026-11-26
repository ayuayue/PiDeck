import { useEffect, useMemo, useState } from "react";
import { desktopApi } from "../desktopApi";

/** 索引条目：每条消息的 entryId / 文件序号 / 角色。不含正文。 */
export interface SessionEntryIndexRow {
	entryId: string;
	ordinal: number;
	role: string;
}

/**
 * 会话全量条目索引（常驻）。
 *
 * 用户口径：「数据没你想的这么大，反正不上 G，就全量索引」。实测 5254 条 ≈ 292 KB、
 * 建索引 0.3 ms —— 整份常驻没有性能顾虑，而这正是跳转该有的样子：
 *
 *   点一条命中 → entryId 查表得 ordinal → 一次取那一页 → 渲染 → 落位
 *
 * 旧实现没有索引，只能拿 entryId 去已加载的消息数组里找；找不到就「补页 → 再找」，
 * 600 轮会话要循环三四次，长了就是「跳不过去」。索引把这一步变成 O(1)。
 *
 * 依赖 loadSignal：新消息落盘后索引会变长，调用方传 messages.length 即可刷新。
 */
export function useSessionEntryIndex(sessionId: string | undefined, loadSignal: number): ReadonlyMap<string, SessionEntryIndexRow> {
	const [rows, setRows] = useState<SessionEntryIndexRow[]>([]);
	useEffect(() => {
		if (!sessionId) {
			setRows([]);
			return;
		}
		let disposed = false;
		void desktopApi.sessions
			.readEntryIndex(sessionId)
			.then((snapshot) => {
				if (!disposed) setRows(snapshot.entries);
			})
			.catch(() => {
				// 读索引失败不该让界面报错：退化成空索引，跳转走原来的「已加载数据里找」路径。
				if (!disposed) setRows([]);
			});
		return () => {
			disposed = true;
		};
	}, [sessionId, loadSignal]);
	return useMemo(() => new Map(rows.map((row) => [row.entryId, row])), [rows]);
}
