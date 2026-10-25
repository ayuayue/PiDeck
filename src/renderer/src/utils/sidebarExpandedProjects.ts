/**
 * 侧栏项目展开状态的本地缓存。
 *
 * 双写策略：localStorage 作首屏同步缓存，settings.json 作跨进程可靠落盘。
 * dev 模式强杀进程时 localStorage 可能来不及写入，settings.json 才是权威来源。
 */

/** 侧栏展开项目 id（含 chat） */
export const SIDEBAR_EXPANDED_PROJECTS_KEY = "pid:sidebar-expanded-projects";
/** 旧版「折叠集合」key，仅用于一次性迁移 */
export const SIDEBAR_COLLAPSED_PROJECTS_LEGACY_KEY = "pid:sidebar-collapsed-projects";
/** 与主进程 ProjectStore 内置 chat id 保持一致 */
export const BUILTIN_CHAT_PROJECT_ID = "builtin-chat";

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function parseProjectIdArray(raw: string | null): string[] | null {
	if (raw === null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return null;
		return parsed.filter((id): id is string => typeof id === "string");
	} catch {
		return null;
	}
}

/** 默认只展开内置 chat，与「启动不全量扫会话」策略一致 */
export function defaultExpandedSidebarProjects(): Set<string> {
	return new Set([BUILTIN_CHAT_PROJECT_ID]);
}

/**
 * 读取侧栏展开项目 id。
 * 只认新 key；仅有旧折叠 key 时返回 null，等拿到项目全集后再由 migrate 反演。
 */
export function readExpandedSidebarProjects(storage?: StorageLike): string[] | null {
	if (!storage) return null;
	try {
		return parseProjectIdArray(storage.getItem(SIDEBAR_EXPANDED_PROJECTS_KEY));
	} catch {
		return null;
	}
}

export function writeExpandedSidebarProjects(storage: StorageLike | undefined, ids: Iterable<string>) {
	if (!storage) return;
	try {
		storage.setItem(SIDEBAR_EXPANDED_PROJECTS_KEY, JSON.stringify([...ids]));
		// 迁移完成后清掉旧 key，避免两套数据源互相打架
		storage.removeItem(SIDEBAR_COLLAPSED_PROJECTS_LEGACY_KEY);
	} catch {
		// localStorage 不可用时静默忽略；settings.json 仍会落盘
	}
}

/**
 * 旧版 collapsed key → expanded 反演迁移。
 * 只在「有旧 key、且没有新 key」时返回迁移结果，否则返回 null 表示无需迁移。
 */
export function migrateLegacyCollapsedProjects(storage: StorageLike | undefined, projectIds: readonly string[]): Set<string> | null {
	if (!storage || projectIds.length === 0) return null;
	let legacyCollapsed: string[] | null;
	let hasExpandedCache: boolean;
	try {
		legacyCollapsed = parseProjectIdArray(storage.getItem(SIDEBAR_COLLAPSED_PROJECTS_LEGACY_KEY));
		hasExpandedCache = storage.getItem(SIDEBAR_EXPANDED_PROJECTS_KEY) !== null;
	} catch {
		return null;
	}
	if (!legacyCollapsed || hasExpandedCache) return null;
	const migrated = new Set(projectIds.filter((id) => !legacyCollapsed.includes(id)));
	// 至少保留 chat，避免迁移后侧栏全空
	if (projectIds.includes(BUILTIN_CHAT_PROJECT_ID)) {
		migrated.add(BUILTIN_CHAT_PROJECT_ID);
	}
	return migrated;
}

export function sameProjectIdSet(a: ReadonlySet<string>, b: ReadonlySet<string>) {
	if (a.size !== b.size) return false;
	for (const id of a) if (!b.has(id)) return false;
	return true;
}
