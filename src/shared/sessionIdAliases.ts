/**
 * 会话稳定 ID 的别名解析（#354）。
 *
 * catalog 在启动归并历史身份重复记录时会丢掉被归并的 ID，而 settings/侧栏置顶、
 * 渲染层持久化的 Tab 置顶与「最近活动」都是按稳定 ID 存的引用：只改 catalog 会让
 * 这些引用变成指向不存在会话的死链（用户侧看到置顶丢失、Tab 被自动关掉）。
 *
 * 机制：存活条目记录 `mergedSessionIds`（被它吸收的历史 ID），归并映射与 catalog
 * 原子快照一起落盘，因此跨重启幂等；本模块把这份别名表还原成「旧 ID → 现存 ID」
 * 的解析表，主进程迁移持久化设置、渲染层迁移持久化引用都走这里，不新增通信通道。
 *
 * 只处理**同源同文件**的归并别名：别名指向的仍是同一个会话，语义与 fork 替换
 * （`supersededBy`，另一个独立会话）无关。
 */

/** 只依赖 catalog 记录的 id 与别名表，渲染层 summary/record 都能直接喂进来。 */
export type SessionIdAliasSource = {
	id: string;
	mergedSessionIds?: readonly string[];
};

/**
 * 别名表的读侧收窄。`mergedSessionIds` 是用户可手改的 session-catalog.json 字段，
 * 类型不可信：非数组（`42`/`{}`）与数组里的非字符串/空串一律不当别名。
 * **字符串绝不能直接迭代**——`for (const alias of "42")` 会把 `4`/`2` 变成逐字符别名。
 * @returns 合法别名列表（至少 1 条），否则 undefined。
 */
export function readMergedSessionIds(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const raw: unknown[] = value;
	const ids: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string" || item.length === 0) continue;
		ids.push(item);
	}
	return ids.length > 0 ? ids : undefined;
}

/**
 * 构建「被归并 ID → 现存 ID」别名表。
 *
 * 防御规则（别名表来自磁盘，可能被手改坏）：
 * - 别名等于自身或遮蔽**真实存在的**其他会话记录时忽略——那条记录是独立会话，不能被别名顶替；
 * - 同一别名被多条记录声明时先到先得，不互相覆盖。
 * 目标串都是现存记录的 id，因此解析一步收敛、不可能成环。
 */
export function buildSessionIdAliasMap(records: readonly SessionIdAliasSource[]): Map<string, string> {
	const realIds = new Set<string>();
	for (const record of records) realIds.add(record.id);
	const aliases = new Map<string, string>();
	for (const record of records) {
		for (const alias of readMergedSessionIds(record.mergedSessionIds) ?? []) {
			if (!alias || alias === record.id) continue;
			if (realIds.has(alias)) continue;
			if (aliases.has(alias)) continue;
			aliases.set(alias, record.id);
		}
	}
	return aliases;
}

/**
 * 把 ID 列表里的历史 ID 换成现存 ID；顺序保留、去重。
 * 没有变化时**返回入参本身**，让调用方的引用比较（React state/atom 去抖）继续成立。
 */
export function remapSessionIds(ids: readonly string[], aliases: ReadonlyMap<string, string>): readonly string[] {
	if (aliases.size === 0) return ids;
	let changed = false;
	const seen = new Set<string>();
	const next: string[] = [];
	for (const id of ids) {
		const canonical = aliases.get(id) ?? id;
		if (canonical !== id) changed = true;
		if (seen.has(canonical)) {
			changed = true;
			continue;
		}
		seen.add(canonical);
		next.push(canonical);
	}
	return changed ? next : ids;
}

/**
 * 用一组现存会话记录里的归并别名迁移一份稳定 ID 列表。
 * 主进程迁移 `settings.pinnedSessionIds` 与渲染层迁移持久化引用共用这个入口，
 * 不各自手写一遍解析（旧 ID → 现存 ID）。
 */
export function migrateSessionIdList(ids: readonly string[], records: readonly SessionIdAliasSource[]): readonly string[] {
	return remapSessionIds(ids, buildSessionIdAliasMap(records));
}

/**
 * 同一套规则的「按稳定 ID 记录」列表迁移（渲染层持久化的最近活动）。
 * 迁移后不同记录可能落到同一现存 ID：保留先出现的那条（活动页只需要一行入口）。
 */
export function remapSessionIdActivities<T extends { sessionId: string }>(entries: readonly T[], aliases: ReadonlyMap<string, string>): readonly T[] {
	if (aliases.size === 0) return entries;
	let changed = false;
	const seen = new Set<string>();
	const next: T[] = [];
	for (const entry of entries) {
		const sessionId = aliases.get(entry.sessionId) ?? entry.sessionId;
		if (sessionId !== entry.sessionId) changed = true;
		if (seen.has(sessionId)) {
			changed = true;
			continue;
		}
		seen.add(sessionId);
		next.push(sessionId === entry.sessionId ? entry : { ...entry, sessionId });
	}
	return changed ? next : entries;
}
