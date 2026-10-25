import { useEffect, useMemo } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { recentSessionActivityAtom } from "../atoms/recent-session-atoms";
import { sessionRecordsAtom } from "../atoms/session-atoms";
import { buildSessionIdAliasMap, remapSessionIdActivities } from "../../../shared/sessionIdAliases";

/**
 * #354：catalog 身份归并会把被吸收的历史会话 ID 从会话记录里移除，而「最近活动」
 * （`localStorage`，atomWithStorage）按稳定 ID 存引用——不迁移就变成死链，用户从活动页
 * 点进去只能落到「会话不存在」。
 *
 * Tab 列表/Tab 置顶不在这里处理：它们必须在**存在性清理之前**迁移，由
 * useSessionWorkspaceChrome 在同一处完成（清理先跑会把被归并 ID 当已删除记录丢掉）。
 */
export function useSessionIdAliasMigration(): void {
	const sessionRecords = useAtomValue(sessionRecordsAtom);
	const setRecentActivity = useSetAtom(recentSessionActivityAtom);
	const aliases = useMemo(() => buildSessionIdAliasMap(Object.values(sessionRecords)), [sessionRecords]);

	useEffect(() => {
		if (aliases.size === 0) return;
		setRecentActivity((previous) => {
			const migrated = remapSessionIdActivities(previous, aliases);
			// 无变化时保留原引用（atomWithStorage 才不会白写一次 localStorage）。
			return migrated === previous ? previous : [...migrated];
		});
	}, [aliases, setRecentActivity]);
}
