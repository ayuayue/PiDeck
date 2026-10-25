import type { SessionSortModeId } from "./types/session";

/** 历史默认：最近活跃排序（2027-03 开放排序规则前的唯一行为）。 */
export const DEFAULT_SESSION_SORT_MODE: SessionSortModeId = "updatedAt";

/**
 * settings.sessionSortMode 边界归一：主进程读/写两侧与渲染层回退共用。
 * 手改 settings.json 的未知字符串（含旧版本未来删除的方案）一律回落默认，
 * 保证侧栏永不因坏值出现空白选项或未定义排序。
 */
export function normalizeSessionSortMode(value: unknown): SessionSortModeId {
	return value === "createdAt" || value === "title" ? value : DEFAULT_SESSION_SORT_MODE;
}
