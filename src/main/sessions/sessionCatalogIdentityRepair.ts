import { isUnambiguousAbsoluteSessionPath } from "../../shared/sessionIdentity";
import { readMergedSessionIds } from "../../shared/sessionIdAliases";
import type { SessionCatalogEntry, SessionFilePathResolver, SessionTitleFetcher } from "./SessionCatalog";

/** 非文件会话由各自后端持久化，不参与 pi JSONL 的身份修复或归并。
 *  运行时归并（SessionCatalog.attachRuntime）复用同一条规则：dsh/acp 会话即使带着
 *  路径文本也不是同一物理文件会话，不得被吸收。 */
export function isFileSession(entry: SessionCatalogEntry): boolean {
	return Boolean(entry.filePath) && (!entry.backend || entry.backend === "pi");
}

/** 明确人工命名优先，其次保守保留存量所有权；自动/首句标题不能覆盖用户选择。 */
function titlePriority(entry: SessionCatalogEntry): number {
	switch (entry.titleOrigin) {
		case "manual":
			return 4;
		case "legacy":
			return 3;
		case "auto":
			return 2;
		case "fallback":
			return 1;
		default:
			return 0;
	}
}

/** 标题比对前的归一化：折叠空白并去首尾空白，避免换行/多空格造成的假阴性。 */
function normalizeTitle(value: string | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 冲突判定：同源组里**标题优先级最高**的层出现两个不同标题 = 无法只靠条目字段定谁是最后改名。
 * 只有这种组才需要磁盘证据；优先级唯一或最高层标题一致的组按既有优先级规则直接归并。
 */
export function hasTitleConflict(group: readonly SessionCatalogEntry[]): boolean {
	const top = Math.max(...group.map(titlePriority));
	const titles = new Set(group.filter((entry) => titlePriority(entry) === top).map((entry) => normalizeTitle(entry.title)));
	return titles.size > 1;
}

/**
 * 冲突标题仲裁：只认有界读取到的**权威**会话名（`nameFromSessionInfo === true`），
 * 且必须与冲突层某一方的标题逐字相同才采信。
 *
 * 为什么不能用 `updatedAt`：runtime attach、重命名、普通扫描都会刷新它，它不等于
 * 「最后一次改标题的时刻」；重开一个旧重复条目（只 attach、不改标题）就能把陈旧标题
 * 选回来，而 manual 锁让后续扫描永远纠正不了（#354 复审）。
 * 读不到 / 非权威名 / 与任何候选都不匹配时返回 undefined：调用方必须放弃本次归并
 * 而不是猜一个标题删掉另一条记录（那份被删的标题可能才是最新的）。
 */
export async function resolveConflictTitleOwner(group: readonly SessionCatalogEntry[], fetchTitle: SessionTitleFetcher | undefined): Promise<SessionCatalogEntry | undefined> {
	if (!fetchTitle) return undefined;
	const top = Math.max(...group.map(titlePriority));
	const candidates = group.filter((entry) => titlePriority(entry) === top && normalizeTitle(entry.title));
	const filePath = candidates[0]?.filePath;
	if (!filePath) return undefined;
	let authoritative: string | undefined;
	try {
		const result = await fetchTitle(filePath, { includeTitle: true });
		if (result?.nameFromSessionInfo === true) authoritative = normalizeTitle(result.name);
	} catch {
		// 读失败保守：不下结论，冲突组原样保留等下次启动重试。
		return undefined;
	}
	if (!authoritative) return undefined;
	const matched = candidates.filter((entry) => normalizeTitle(entry.title) === authoritative);
	return matched.length === 1 ? matched[0] : undefined;
}

/**
 * 最高优先级层的标题归属：该层只有一种标题时，它就是整组的标题归属方（无需磁盘证据）。
 * 该层没有有效标题时返回 undefined——调用方保持存活条目的既有标题，不能用空标题覆盖。
 */
function highestPriorityTitleOwner(group: readonly SessionCatalogEntry[]): SessionCatalogEntry | undefined {
	const top = Math.max(...group.map(titlePriority));
	return group.find((entry) => titlePriority(entry) === top && normalizeTitle(entry.title));
}

/**
 * 运行时归并（attachRuntime）的标题仲裁：与启动修复同一套优先级/证据规则，判定「能否归并」
 * 与「整组标题归谁」。
 *
 * - 最高优先级层没有标题冲突 → 可归并，标题归属该层（manual > legacy > auto > fallback >
 *   undefined）。归并必须整组选归属：存活条目往往是刚创建的 provisional 草稿（最低层），
 *   让它带着自己的临时名吸收掉扫描条目的手工名，就是「fallback 吞掉手工信息」（#354 复审）；
 * - 同层标题冲突 → 只有有界权威名命中某一方才能归并，并采用那份标题；
 * - 读失败 / 无 fetcher / 权威名与任何候选都不符 → **不得归并**：启动时保守保留的冲突组
 *   不能因为用户激活其中一条就在运行时被静默删掉（#354 复审：删除点必须过同一道仲裁）。
 *
 * 任何分支都不用 `updatedAt` 仲裁（它不等于「最后一次改标题的时刻」，重开一条旧重复记录
 * 就能把陈旧标题选回来，而 manual 锁让后续扫描永远纠正不了）。
 */
export async function arbitrateRuntimeMergeTitle(group: readonly SessionCatalogEntry[], fetchTitle: SessionTitleFetcher | undefined): Promise<{ merge: boolean; titleOwner?: SessionCatalogEntry }> {
	if (group.length < 2) return { merge: true };
	if (!hasTitleConflict(group)) return { merge: true, titleOwner: highestPriorityTitleOwner(group) };
	const owner = await resolveConflictTitleOwner(group, fetchTitle);
	return owner ? { merge: true, titleOwner: owner } : { merge: false };
}

/** 把标题归属来源（证据选中方）的标题三件套应用到归并结果上；无变化返回原对象。 */
function applyTitleOwnership(entry: SessionCatalogEntry, owner: SessionCatalogEntry): SessionCatalogEntry {
	if (entry.title === owner.title && entry.titleOrigin === owner.titleOrigin && entry.titleLocked === owner.titleLocked) return entry;
	return { ...entry, title: owner.title, titleOrigin: owner.titleOrigin, titleLocked: owner.titleLocked };
}

/**
 * 旧键条目优先保留原始 ID，其余按最早 createdAt 归并；标题与缺失元数据独立选取。
 * 标题只按优先级层取高者（同层保持原记录）——同层冲突的仲裁由调用方在**全组 fold 完成后**
 * 用 `applyTitleOwnership` 明确应用，不能依赖这里逐次 merge 的对象 identity（每次 merge 都会
 * 重建对象，第二轮起 owner 引用就失效，会错选回旧标题）。
 */
function mergeDuplicateEntries(left: SessionCatalogEntry, right: SessionCatalogEntry, legacyIdentityIds: ReadonlySet<string>): SessionCatalogEntry {
	const preferRight = legacyIdentityIds.has(left.id) === legacyIdentityIds.has(right.id) ? right.createdAt < left.createdAt : legacyIdentityIds.has(right.id);
	const original = preferRight ? right : left;
	const duplicate = original === left ? right : left;
	// 标题归属：优先级高者；同层同题保持原记录。**不按 updatedAt 决胜**。
	const titleDifference = titlePriority(duplicate) - titlePriority(original);
	const titleOwnerEntry = titleDifference > 0 ? duplicate : original;
	const assignment = duplicate.manualProjectAssignment && !original.manualProjectAssignment ? duplicate : original;
	return {
		...duplicate,
		...original,
		projectId: assignment.projectId,
		manualProjectAssignment: original.manualProjectAssignment || duplicate.manualProjectAssignment,
		title: titleOwnerEntry.title,
		titleOrigin: titleOwnerEntry.titleOrigin,
		titleLocked: titleOwnerEntry.titleLocked,
		updatedAt: Math.max(left.updatedAt, right.updatedAt),
		model: original.model ?? duplicate.model,
		thinkingLevel: original.thinkingLevel ?? duplicate.thinkingLevel,
		permissionPreset: original.permissionPreset ?? duplicate.permissionPreset,
		proxy: original.proxy ?? duplicate.proxy,
		piSessionId: original.piSessionId ?? duplicate.piSessionId,
		channel: original.channel ?? duplicate.channel,
		parentSessionPath: original.parentSessionPath ?? duplicate.parentSessionPath,
		forked: original.forked || duplicate.forked,
		supersededBy: original.supersededBy ?? duplicate.supersededBy,
		// 多轮归并的别名必须累积：本轮吸收的 id 连同它此前吸收过的历史 id 一起转给留存条目。
		mergedSessionIds: collectMergedSessionIds(original, [left, right]),
	};
}

/**
 * 运行时归并：`survivorId` 是 runtime 与渲染层当前持有的 ID，不能改名；同源组其余条目全部
 * 并入它（N 条匹配全部吸收，不是只删一条）。偏好与结构元数据按「survivor 优先、缺失取被吸收方」
 * 保全，被吸收 ID 与其历史别名累计进 `mergedSessionIds`。标题只在仲裁给出 `titleOwner` 时改写。
 */
export function mergeSourceGroupInto(survivorId: string, group: readonly SessionCatalogEntry[], titleOwner?: SessionCatalogEntry): SessionCatalogEntry {
	const survivor = group.find((entry) => entry.id === survivorId);
	if (!survivor) throw new Error(`Merge survivor is not part of the source group: ${survivorId}`);
	let merged = survivor;
	for (const duplicate of group) {
		if (duplicate.id === survivorId) continue;
		merged = {
			...duplicate,
			...merged,
			// 手动导入钉住的项目归属优先保留；否则沿用 survivor 的项目。
			projectId: merged.manualProjectAssignment ? merged.projectId : duplicate.manualProjectAssignment ? duplicate.projectId : merged.projectId,
			manualProjectAssignment: Boolean(merged.manualProjectAssignment || duplicate.manualProjectAssignment),
			createdAt: Math.min(merged.createdAt, duplicate.createdAt),
			updatedAt: Math.max(merged.updatedAt, duplicate.updatedAt),
			model: merged.model ?? duplicate.model,
			thinkingLevel: merged.thinkingLevel ?? duplicate.thinkingLevel,
			permissionPreset: merged.permissionPreset ?? duplicate.permissionPreset,
			agentPreset: merged.agentPreset ?? duplicate.agentPreset,
			proxy: merged.proxy ?? duplicate.proxy,
			piSessionId: merged.piSessionId ?? duplicate.piSessionId,
			dshSessionId: merged.dshSessionId ?? duplicate.dshSessionId,
			acpSessionId: merged.acpSessionId ?? duplicate.acpSessionId,
			channel: merged.channel ?? duplicate.channel,
			parentSessionPath: merged.parentSessionPath ?? duplicate.parentSessionPath,
			importedSourceId: merged.importedSourceId ?? duplicate.importedSourceId,
			forked: Boolean(merged.forked || duplicate.forked),
			supersededBy: merged.supersededBy ?? duplicate.supersededBy,
			mergedSessionIds: collectMergedSessionIds(merged, [duplicate]),
		};
	}
	return titleOwner ? applyTitleOwnership(merged, titleOwner) : merged;
}

/** 留存条目应记录的历史 ID：自身旧别名 + 被吸收条目的 id 与其旧别名。 */
function collectMergedSessionIds(target: SessionCatalogEntry, absorbed: readonly SessionCatalogEntry[]): string[] | undefined {
	const ids = new Set<string>(readMergedSessionIds(target.mergedSessionIds) ?? []);
	for (const entry of absorbed) {
		if (entry.id !== target.id) ids.add(entry.id);
		for (const alias of readMergedSessionIds(entry.mergedSessionIds) ?? []) ids.add(alias);
	}
	ids.delete(target.id);
	return ids.size > 0 ? [...ids] : undefined;
}

/**
 * 别名表落盘前的净化：别名只作历史 ID 的解析入口，不得遮蔽真实存在的会话记录（那条记录是
 * 独立会话）、不得自指、不得被两条记录同时声明。坏数据只删字段项，不动条目本身。
 *
 * 字段来自用户可手改的 JSON，类型不可信：`mergedSessionIds: 42` / `"abc"` 一律按「没有别名表」
 * 处理（字符串若直接 `for...of` 会被逐字符当成 alias），不能让一条坏字段让整个 catalog 启动失败。
 */
function sanitizeMergedSessionIds(entries: SessionCatalogEntry[]): { entries: SessionCatalogEntry[]; changed: boolean } {
	const realIds = new Set(entries.map((entry) => entry.id));
	const claimed = new Set<string>();
	let changed = false;
	const next: SessionCatalogEntry[] = entries.map((entry) => {
		const raw: unknown = entry.mergedSessionIds;
		if (raw === undefined) return entry;
		const declared = readMergedSessionIds(raw) ?? [];
		const kept: string[] = [];
		for (const alias of declared) {
			if (alias === entry.id || realIds.has(alias) || claimed.has(alias)) continue;
			claimed.add(alias);
			kept.push(alias);
		}
		const unchangedField = Array.isArray(raw) && raw.length === declared.length && kept.length === declared.length;
		if (unchangedField) return entry;
		changed = true;
		if (kept.length === 0) {
			const { mergedSessionIds: _dropped, ...rest } = entry;
			return rest;
		}
		return { ...entry, mergedSessionIds: kept };
	});
	return { entries: changed ? next : entries, changed };
}

/** 一条记录在本次修复中的两种形态：规范化形态与入参原样（供延期归并整组回退）。 */
type NormalizedEntry = {
	/** 路径已解析、身份键已重算的形态；未通过绝对路径闸门时与 original 相同。 */
	entry: SessionCatalogEntry;
	/** 入参原样（含旧身份键）——延期归并的组必须整组保留它，下次启动才有可恢复证据。 */
	original: SessionCatalogEntry;
	/** 规范化本身是否改动了这条记录。 */
	repaired: boolean;
};

/**
 * #354：路径不变也必须重算派生身份键，修复 native POSIX 从全小写切到保留大小写的旧索引。
 * 只在启动、运行时尚未恢复前归并真实同源记录；保留原始 ID，不触碰会话 JSONL。
 *
 * 两道保守闸（复审修正）：
 * 1. 只有 resolver 返回**无歧义绝对路径**的条目才进入归并——生产 resolver 在项目解析不出来时
 *    按契约原样返回入参，把相对路径当已确认位置会让两个项目各自的 `.pi/sessions/x.jsonl`
 *    算成同一个键而被破坏性归并；
 * 2. 标题优先级同层的标题冲突必须有权威磁盘名匹配才归并，无证据（无 fetcher / 读失败 /
 *    权威名与两方标题都不符）时**整组保留原始数据**（连旧身份键一起，不落盘 normalized
 *    克隆）、下次启动重试，不用可变的 updatedAt 猜标题。
 *
 * 返回 undefined 表示无需落盘；调用方复用 catalog 的备份、原子写与失败降级。
 */
export async function repairSessionCatalogIdentities(entries: readonly SessionCatalogEntry[], resolveFilePath: SessionFilePathResolver | undefined, originKeyForEntry: (entry: SessionCatalogEntry) => string | undefined, fetchTitle?: SessionTitleFetcher): Promise<SessionCatalogEntry[] | undefined> {
	const verifiedIdentityIds = new Set<string>();
	const legacyIdentityIds = new Set<string>();
	const items: NormalizedEntry[] = entries.map((entry) => {
		if (!isFileSession(entry) || !entry.filePath) return { entry, original: entry, repaired: false };
		const filePath = entry.filePath;
		const resolved = resolveFilePath ? resolveFilePath(entry.projectId, filePath, entry.environment) : filePath;
		// resolver 找不到项目基址时原样返回相对路径：那不是「已确认的物理位置」，不重算键也不归并。
		if (!resolved || !isUnambiguousAbsoluteSessionPath(resolved)) return { entry, original: entry, repaired: false };
		const repairedEntry = resolved === filePath ? entry : { ...entry, filePath: resolved };
		const originKey = originKeyForEntry(repairedEntry);
		if (!originKey) return { entry: repairedEntry, original: entry, repaired: repairedEntry !== entry };
		verifiedIdentityIds.add(entry.id);
		// 扫描条目的 createdAt 来自文件 mtime，未必晚于原记录；旧 native 小写键
		// 才是升级前身份的证据，不能只按文件时间决定保留哪个 ID。
		if (entry.environment === "native" && entry.originKey && entry.originKey !== originKey && entry.originKey === originKeyForEntry({ ...repairedEntry, filePath: resolved.toLowerCase() })) legacyIdentityIds.add(entry.id);
		if (repairedEntry === entry && originKey === entry.originKey) return { entry, original: entry, repaired: false };
		return { entry: { ...repairedEntry, originKey }, original: entry, repaired: true };
	});

	// 同源分组（只含已确认路径的条目），据此判定哪些组需要磁盘证据、哪些组只能原样保留。
	const originGroups = new Map<string, SessionCatalogEntry[]>();
	for (const item of items) {
		const entry = item.entry;
		if (!verifiedIdentityIds.has(entry.id) || !entry.originKey) continue;
		const group = originGroups.get(entry.originKey);
		if (group) group.push(entry);
		else originGroups.set(entry.originKey, [entry]);
	}
	const titleOwners = new Map<string, SessionCatalogEntry>();
	const unresolvedOrigins = new Set<string>();
	for (const [originKey, group] of originGroups) {
		if (group.length < 2 || !hasTitleConflict(group)) continue;
		const owner = await resolveConflictTitleOwner(group, fetchTitle);
		if (owner) titleOwners.set(originKey, owner);
		else unresolvedOrigins.add(originKey);
	}
	/** 无权威证据的冲突组：整组不归并、不重算身份键，保留原始记录等下次启动重试。 */
	const isDeferred = (item: NormalizedEntry): boolean => {
		const originKey = item.entry.originKey;
		if (!originKey || !verifiedIdentityIds.has(item.entry.id)) return false;
		return unresolvedOrigins.has(originKey);
	};

	let changed = items.some((item) => item.repaired && !isDeferred(item));
	const next: SessionCatalogEntry[] = [];
	const indexByOrigin = new Map<string, number>();
	const mergedOrigins = new Set<string>();
	for (const item of items) {
		// resolver 未能确认路径、或冲突组没有权威证据时，不得做破坏性归并。
		if (isDeferred(item)) {
			next.push(item.original);
			continue;
		}
		const entry = item.entry;
		const originKey = verifiedIdentityIds.has(entry.id) ? entry.originKey : undefined;
		if (!originKey) {
			next.push(entry);
			continue;
		}
		const index = indexByOrigin.get(originKey);
		if (index === undefined) {
			indexByOrigin.set(originKey, next.length);
			next.push(entry);
		} else {
			next[index] = mergeDuplicateEntries(next[index], entry, legacyIdentityIds);
			mergedOrigins.add(originKey);
			changed = true;
		}
	}
	// 全组 fold 完成后再明确应用仲裁出的标题归属：逐次 merge 会重建对象，按对象 identity 记
	// owner 会在第二轮 merge 后失效并把标题错退回被保留的旧标题（#354 复审）。
	for (const [originKey, owner] of titleOwners) {
		if (!mergedOrigins.has(originKey)) continue;
		const index = indexByOrigin.get(originKey);
		if (index === undefined) continue;
		next[index] = applyTitleOwnership(next[index], owner);
	}

	// fork/重发的替换关系也按稳定 ID 存储，不能留下指向被归并记录的悬空引用。
	const retainedIds = new Map<string, string>();
	for (const item of items) {
		const entry = item.entry;
		const index = verifiedIdentityIds.has(entry.id) && entry.originKey && !unresolvedOrigins.has(entry.originKey) ? indexByOrigin.get(entry.originKey) : undefined;
		if (index !== undefined) retainedIds.set(entry.id, next[index].id);
	}
	const withReferences = next.map((entry) => {
		if (!entry.supersededBy) return entry;
		const target = retainedIds.get(entry.supersededBy) ?? entry.supersededBy;
		if (target === entry.id) return { ...entry, supersededBy: undefined };
		return target === entry.supersededBy ? entry : { ...entry, supersededBy: target };
	});

	const sanitized = sanitizeMergedSessionIds(withReferences);
	changed = changed || sanitized.changed;
	return changed ? sanitized.entries : undefined;
}
