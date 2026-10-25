import { migrateSessionIdList, type SessionIdAliasSource } from "../../shared/sessionIdAliases";

export type SessionPinnedIdsMigrationDeps = {
	/** catalog 现存条目（含 mergedSessionIds 别名表）。 */
	listCatalogSessions: () => readonly SessionIdAliasSource[];
	/** settings 里当前持久化的置顶稳定 ID。 */
	readPinnedSessionIds: () => readonly string[] | undefined;
	writePinnedSessionIds: (ids: string[]) => Promise<unknown>;
	/** 写盘失败只记日志（不中断启动）：内存 catalog 已是归并后状态，迟到的旧 ID 请求由
	 *  SessionCatalog.resolveSessionId 兜底，不会另起一个 runtime。 */
	logWarning: (cause: string) => void;
};

/**
 * #354：把 `settings.pinnedSessionIds` 里指向「已被身份归并掉的历史会话 ID」的置顶迁移到存活
 * 会话 ID。侧栏置顶按稳定 ID 持久化，catalog 归并后不迁移就是死链（用户看到置顶丢失）。
 *
 * 别名表随 catalog 快照落盘，重启后重放结果一致（幂等）；无变化时不写 settings（避免无谓的
 * 设置落盘与变更广播）。catalog/settings/日志由装配层注入，本模块只做一次纯迁移 + 一次写入。
 */
export async function migrateMergedSessionPinnedIds(deps: SessionPinnedIdsMigrationDeps): Promise<void> {
	const pinned = deps.readPinnedSessionIds() ?? [];
	const migrated = migrateSessionIdList(pinned, deps.listCatalogSessions());
	if (migrated.length === pinned.length && migrated.every((id, index) => id === pinned[index])) return;
	try {
		await deps.writePinnedSessionIds([...migrated]);
	} catch (error) {
		deps.logWarning(error instanceof Error ? error.message : String(error));
	}
}
