/**
 * Three-way merge for the PiDeck sync index (M6).
 *
 * The base is the last successfully synced index. For every entity we compare
 * local vs base vs remote; only entities that changed on one side are applied,
 * entities changed on both sides (differently) become conflicts. Conflict
 * resolution re-runs the merge with explicit local/remote choices.
 *
 * Pure functions only: file I/O and provider access live in CloudSyncManager.
 */

import type {
	CloudSyncConflict,
	CloudSyncConflictResolution,
	CloudSyncFileBundle,
	CloudSyncProject,
	CloudSyncSessionRef,
	CloudSyncStrategy,
	PiDeckSyncIndexV1,
} from "../../shared/types/cloudSync.ts";
import { GLOBAL_SYNC_PROJECT_ID } from "./payload.ts";

export type ConflictChoiceMap = ReadonlyMap<string, "local" | "remote">;

export interface CloudSyncTransferPlan {
	/** 本地胜出/仅本地的新增会话对象，需上传。 */
	sessionUpload: CloudSyncSessionRef[];
	/** 云端胜出/仅云端的新增会话对象，需下载。 */
	sessionDownload: CloudSyncSessionRef[];
	/** 本地胜出的资源 bundle（大文件对象），需上传。 */
	resourceUpload: Array<{ projectId: string; category: string; bundle: CloudSyncFileBundle }>;
	/** 云端胜出的资源 bundle（大文件对象），需下载。 */
	resourceDownload: Array<{ projectId: string; category: string; bundle: CloudSyncFileBundle }>;
}

export interface CloudSyncMergeResult {
	merged: PiDeckSyncIndexV1;
	conflicts: CloudSyncConflict[];
	transfers: CloudSyncTransferPlan;
	/** 合并结果中的 settings 是否包含远端采纳的字段（应用层据此写 SettingsStore）。 */
	settingsAdoptedFromRemote: boolean;
}

interface ResourceEntry {
	projectId: string;
	category: "prompts" | "skills" | "localExtensions" | "config";
	bundle: CloudSyncFileBundle;
}

type ResourceKey = string;

function resourceKey(projectId: string, category: string, relativePath: string): ResourceKey {
	return `${projectId}\0${category}\0${relativePath}`;
}

function isSameText(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function bundleHash(bundle: CloudSyncFileBundle): string {
	return bundle.contentHash;
}

/** 扁平化一个 index 的会话与资源，便于按实体比较。 */
function flattenIndex(index: PiDeckSyncIndexV1 | null): {
	sessions: Map<string, CloudSyncSessionRef>;
	resources: Map<ResourceKey, ResourceEntry>;
	catalog: Map<string, { projectId: string; entry: Record<string, unknown> }>;
	projects: Map<string, CloudSyncProject>;
} {
	const sessions = new Map<string, CloudSyncSessionRef>();
	const resources = new Map<ResourceKey, ResourceEntry>();
	const catalog = new Map<string, { projectId: string; entry: Record<string, unknown> }>();
	const projects = new Map<string, CloudSyncProject>();
	for (const project of index?.projects ?? []) {
		projects.set(project.projectId, project);
		for (const session of project.sessions ?? []) {
			sessions.set(session.sessionId, session);
		}
		for (const category of ["prompts", "skills", "localExtensions", "config"] as const) {
			for (const bundle of project.resources?.[category] ?? []) {
				resources.set(resourceKey(project.projectId, category, bundle.relativePath), {
					projectId: project.projectId,
					category,
					bundle,
				});
			}
		}
		for (const entry of project.catalogEntries ?? []) {
			if (typeof entry.id === "string") catalog.set(entry.id, { projectId: project.projectId, entry });
		}
	}
	return { sessions, resources, catalog, projects };
}

function sessionConflict(id: string, label: string, local: CloudSyncSessionRef | undefined, remote: CloudSyncSessionRef | undefined): CloudSyncConflict {
	return {
		id: `session:${id}`,
		kind: "session",
		label,
		entityId: id,
		local: local ? { hash: local.contentHash, updatedAt: local.mtimeMs } : {},
		remote: remote ? { hash: remote.contentHash, updatedAt: remote.mtimeMs } : {},
	};
}

function resourceConflict(id: string, label: string, local: ResourceEntry | undefined, remote: ResourceEntry | undefined): CloudSyncConflict {
	return {
		id: `resource:${id}`,
		kind: "resource",
		label,
		entityId: id,
		local: local ? { hash: bundleHash(local.bundle) } : {},
		remote: remote ? { hash: bundleHash(remote.bundle) } : {},
	};
}

function settingsConflict(field: string, local: unknown, remote: unknown): CloudSyncConflict {
	return {
		id: `settings:${field}`,
		kind: "settings",
		label: field,
		entityId: field,
		local: { hash: hashOf(local) },
		remote: { hash: hashOf(remote) },
	};
}

function catalogConflict(id: string, local: Record<string, unknown> | undefined, remote: Record<string, unknown> | undefined): CloudSyncConflict {
	return {
		id: `catalog:${id}`,
		kind: "catalog",
		label: id,
		entityId: id,
		local: local ? { hash: hashOf(local) } : {},
		remote: remote ? { hash: hashOf(remote) } : {},
	};
}

function hashOf(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	return Buffer.from(JSON.stringify(value)).toString("base64url").slice(0, 32);
}

/** 三方比较两个实体版本，返回动作。 */
function decideSide<T>(
	local: T | undefined,
	base: T | undefined,
	remote: T | undefined,
	localEquals: (a: T, b: T) => boolean,
	remoteEquals: (a: T, b: T) => boolean,
): "local" | "remote" | "conflict" | "none" {
	const localChanged = local !== undefined && base !== undefined ? !localEquals(local, base) : local !== base;
	const remoteChanged = remote !== undefined && base !== undefined ? !remoteEquals(remote, base) : remote !== base;
	if (!localChanged && !remoteChanged) return "none";
	if (localChanged && !remoteChanged) return "local";
	if (remoteChanged && !localChanged) return "remote";
	// 双方都改：内容相同视为无冲突（任取其一）
	if (local !== undefined && remote !== undefined && localEquals(local, remote)) return "local";
	return "conflict";
}

function hashEquals(a: CloudSyncSessionRef | undefined, b: CloudSyncSessionRef | undefined): boolean {
	if (!a || !b) return a === b;
	return a.contentHash === b.contentHash;
}

function bundleEquals(a: ResourceEntry | undefined, b: ResourceEntry | undefined): boolean {
	if (!a || !b) return a === b;
	return bundleHash(a.bundle) === bundleHash(b.bundle);
}

/**
 * 三路合并索引。choices 只作用于「双方都改且内容不同」的冲突实体；
 * 其余实体按 base 自动决定本地/远端。
 */
export function mergeSyncIndexes(
	base: PiDeckSyncIndexV1 | null,
	local: PiDeckSyncIndexV1,
	remote: PiDeckSyncIndexV1,
	strategy: CloudSyncStrategy,
	choices: ConflictChoiceMap = new Map(),
): CloudSyncMergeResult {
	const conflicts: CloudSyncConflict[] = [];
	const transfers: CloudSyncTransferPlan = {
		sessionUpload: [],
		sessionDownload: [],
		resourceUpload: [],
		resourceDownload: [],
	};
	const b = flattenIndex(base);
	const l = flattenIndex(local);
	const r = flattenIndex(remote);

	// 合并项目节点（按 projectId 取并集；元数据冲突按策略/选择处理）
	const mergedProjects = new Map<string, CloudSyncProject>();
	for (const project of [...r.projects.values(), ...l.projects.values()]) {
		mergedProjects.set(project.projectId, project);
	}
	for (const [projectId, remoteProject] of r.projects) {
		const localProject = l.projects.get(projectId);
		if (!localProject) continue;
		const baseProject = b.projects.get(projectId);
		const localMeta = localProject.metadata ?? {};
		const remoteMeta = remoteProject.metadata ?? {};
		const baseMeta = baseProject?.metadata ?? {};
		// 固定字段集合逐项三方比较；值类型由 Project.metadata 定义保证。
		const mergedMeta: Record<string, unknown> = {};
		for (const field of ["pinned", "sortOrder", "worktreeEnabled", "worktreeParentId"] as const) {
			const lv = localMeta[field];
			const rv = remoteMeta[field];
			const bv = baseMeta[field];
			const decision = decideSide(lv, bv, rv, (a, c) => a === c, (a, c) => a === c);
			if (decision === "local" || decision === "none") {
				if (lv !== undefined) mergedMeta[field] = lv;
			} else if (decision === "remote") {
				if (rv !== undefined) mergedMeta[field] = rv;
			} else {
				const conflictId = `project:${projectId}:${field}`;
				const explicit = choices.get(conflictId);
				const choice = explicit ?? choiceFor(conflictId, choices, strategy);
				if (choice === "remote" && rv !== undefined) mergedMeta[field] = rv;
				else if (lv !== undefined) mergedMeta[field] = lv;
				if (!explicit) {
					conflicts.push({
						id: conflictId,
						kind: "project",
						label: `${projectId}.${field}`,
						projectId,
						entityId: field,
						local: { hash: hashOf(lv) },
						remote: { hash: hashOf(rv) },
					});
				}
			}
		}
		if (Object.keys(mergedMeta).length > 0) {
			mergedProjects.set(projectId, { ...remoteProject, metadata: mergedMeta as CloudSyncProject["metadata"] });
		}
	}

	// 会话：三方按 sessionId 比较 contentHash
	const sessionIds = new Set([...l.sessions.keys(), ...r.sessions.keys()]);
	const mergedSessions = new Map<string, CloudSyncSessionRef>();
	for (const sessionId of sessionIds) {
		const localRef = l.sessions.get(sessionId);
		const remoteRef = r.sessions.get(sessionId);
		const baseRef = b.sessions.get(sessionId);
		const decision = decideSide(localRef, baseRef, remoteRef, hashEquals, hashEquals);
		const label = localRef?.relativePath ?? remoteRef?.relativePath ?? sessionId;
		if (decision === "local" || decision === "none") {
			if (localRef) mergedSessions.set(sessionId, localRef);
			else if (remoteRef) mergedSessions.set(sessionId, remoteRef); // local 删除、remote=base → 保留云端
			if (decision === "local") transfers.sessionUpload.push(localRef!);
		} else if (decision === "remote") {
			if (remoteRef) mergedSessions.set(sessionId, remoteRef);
			if (remoteRef) transfers.sessionDownload.push(remoteRef);
		} else {
			const conflictId = `session:${sessionId}`;
			const explicit = choices.get(conflictId);
			const choice = explicit ?? choiceFor(conflictId, choices, strategy);
			if (choice === "remote" && remoteRef) {
				mergedSessions.set(sessionId, remoteRef);
				transfers.sessionDownload.push(remoteRef);
			} else if (localRef) {
				mergedSessions.set(sessionId, localRef);
				transfers.sessionUpload.push(localRef);
			}
			if (!explicit) conflicts.push(sessionConflict(sessionId, label, localRef, remoteRef));
		}
	}

	// 资源：三方按 (projectId, category, relativePath) 比较 contentHash
	const resourceIds = new Set([...l.resources.keys(), ...r.resources.keys()]);
	const mergedResources = new Map<ResourceKey, ResourceEntry>();
	for (const key of resourceIds) {
		const localEntry = l.resources.get(key);
		const remoteEntry = r.resources.get(key);
		const baseEntry = b.resources.get(key);
		const decision = decideSide(localEntry, baseEntry, remoteEntry, bundleEquals, bundleEquals);
		const label = localEntry?.bundle.relativePath ?? remoteEntry?.bundle.relativePath ?? key;
		if (decision === "local" || decision === "none") {
			if (localEntry) mergedResources.set(key, localEntry);
			else if (remoteEntry) mergedResources.set(key, remoteEntry);
			if (decision === "local") transfers.resourceUpload.push({ projectId: localEntry!.projectId, category: localEntry!.category, bundle: localEntry!.bundle });
		} else if (decision === "remote") {
			if (remoteEntry) {
				mergedResources.set(key, remoteEntry);
				transfers.resourceDownload.push({ projectId: remoteEntry.projectId, category: remoteEntry.category, bundle: remoteEntry.bundle });
			}
		} else {
			const conflictId = `resource:${key.split("\0").join(":")}`;
			const explicit = choices.get(conflictId);
			const choice = explicit ?? choiceFor(conflictId, choices, strategy);
			if (choice === "remote" && remoteEntry) {
				mergedResources.set(key, remoteEntry);
				transfers.resourceDownload.push({ projectId: remoteEntry.projectId, category: remoteEntry.category, bundle: remoteEntry.bundle });
			} else if (localEntry) {
				mergedResources.set(key, localEntry);
				transfers.resourceUpload.push({ projectId: localEntry.projectId, category: localEntry.category, bundle: localEntry.bundle });
			}
			if (!explicit) conflicts.push(resourceConflict(key.split("\0").join(":"), label, localEntry, remoteEntry));
		}
	}

	// Catalog 条目：按 entry.id 三方比较 JSON，并保留项目归属
	const catalogIds = new Set([...l.catalog.keys(), ...r.catalog.keys()]);
	const mergedCatalog = new Map<string, { projectId: string; entry: Record<string, unknown> }>();
	for (const id of catalogIds) {
		const localEntry = l.catalog.get(id);
		const remoteEntry = r.catalog.get(id);
		const baseEntry = b.catalog.get(id);
		const decision = decideSide(
			localEntry?.entry,
			baseEntry?.entry,
			remoteEntry?.entry,
			isSameText,
			isSameText,
		);
		if (decision === "local" || decision === "none") {
			if (localEntry) mergedCatalog.set(id, localEntry);
			else if (remoteEntry) mergedCatalog.set(id, remoteEntry);
		} else if (decision === "remote") {
			if (remoteEntry) mergedCatalog.set(id, remoteEntry);
		} else {
			const conflictId = `catalog:${id}`;
			const explicit = choices.get(conflictId);
			const choice = explicit ?? choiceFor(conflictId, choices, strategy);
			if (choice === "remote" && remoteEntry) mergedCatalog.set(id, remoteEntry);
			else if (localEntry) mergedCatalog.set(id, localEntry);
			if (!explicit) conflicts.push(catalogConflict(id, localEntry?.entry, remoteEntry?.entry));
		}
	}

	// Settings：按字段三方比较
	const settingsFields = new Set([
		...(local.settings ? Object.keys(local.settings) : []),
		...(remote.settings ? Object.keys(remote.settings) : []),
	]);
	const mergedSettings: Record<string, unknown> = {};
	let settingsAdoptedFromRemote = false;
	for (const field of settingsFields) {
		const lv = local.settings?.[field];
		const rv = remote.settings?.[field];
		const bv = base?.settings?.[field];
		const decision = decideSide(lv, bv, rv, isSameText, isSameText);
		if (decision === "local" || decision === "none") {
			if (lv !== undefined) mergedSettings[field] = lv;
			else if (rv !== undefined) mergedSettings[field] = rv;
		} else if (decision === "remote") {
			if (rv !== undefined) mergedSettings[field] = rv;
			settingsAdoptedFromRemote = true;
		} else {
			const conflictId = `settings:${field}`;
			const explicit = choices.get(conflictId);
			const choice = explicit ?? choiceFor(conflictId, choices, strategy);
			if (choice === "remote" && rv !== undefined) {
				mergedSettings[field] = rv;
				settingsAdoptedFromRemote = true;
			} else if (lv !== undefined) mergedSettings[field] = lv;
			if (!explicit) conflicts.push(settingsConflict(field, lv, rv));
		}
	}

	// 组装合并后的索引：先把合并实体挂回项目节点（清掉原始 bundle 数组，避免与合并实体重复）
	const projectsById = new Map<string, CloudSyncProject>();
	for (const [projectId, project] of mergedProjects) {
		projectsById.set(projectId, {
			...project,
			...(project.resources ? {
				resources: {
					...(project.resources.piSettings !== undefined ? { piSettings: project.resources.piSettings } : {}),
					...(project.resources.extensionSources !== undefined ? { extensionSources: project.resources.extensionSources } : {}),
				},
			} : {}),
			sessions: [],
			catalogEntries: [],
		});
	}
	const ensureProject = (projectId: string, fallbackName: string): CloudSyncProject => {
		let project = projectsById.get(projectId);
		if (!project) {
			project = {
				projectId,
				name: fallbackName,
				kind: "normal",
				sessions: [],
				catalogEntries: [],
			};
			projectsById.set(projectId, project);
		}
		return project;
	};
	for (const ref of mergedSessions.values()) {
		const projectId = ref.scope === "project" && ref.projectId ? ref.projectId : GLOBAL_SYNC_PROJECT_ID;
		ensureProject(projectId, projectId).sessions!.push(ref);
	}
	for (const entry of mergedResources.values()) {
		const project = ensureProject(entry.projectId, entry.projectId);
		const resources = project.resources ?? {};
		const list = resources[entry.category] ?? [];
		list.push(entry.bundle);
		resources[entry.category] = list;
		project.resources = resources;
	}
	for (const { projectId, entry } of mergedCatalog.values()) {
		// 归属项目仍在合并集内 → 挂回；否则落全局节点（远端项目本机未注册）。
		const owner = projectsById.get(projectId) ?? projectsById.get(GLOBAL_SYNC_PROJECT_ID) ?? projectsById.values().next().value;
		if (!owner) break;
		const existing = owner.catalogEntries!.find((candidate) => candidate.id === entry.id);
		if (existing) Object.assign(existing, entry);
		else owner.catalogEntries!.push(entry);
	}

	const merged: PiDeckSyncIndexV1 = {
		...local,
		...(Object.keys(mergedSettings).length > 0 ? { settings: mergedSettings } : {}),
		projects: [...projectsById.values()].filter((project) => (
			project.sessions?.length ||
			(project.resources && (project.resources.prompts?.length || project.resources.skills?.length || project.resources.localExtensions?.length || project.resources.piSettings || project.resources.extensionSources?.length)) ||
			project.catalogEntries?.length ||
			(project.metadata && Object.keys(project.metadata).length > 0)
		)),
		syncedAt: Date.now(),
	};

	return { merged, conflicts, transfers, settingsAdoptedFromRemote };
}

function choiceFor(id: string, choices: ConflictChoiceMap, strategy: CloudSyncStrategy): "local" | "remote" | undefined {
	const explicit = choices.get(id);
	if (explicit) return explicit;
	// 智能合并默认本地优先并记录冲突（与方案文档 §7.1 一致）。
	if (strategy === "preferCloud") return "remote";
	if (strategy === "preferLocal") return "local";
	return undefined;
}

/** 把解析结果应用到合并：等价于带 choices 重跑 merge（由 manager 持有 base/local/remote 时调用）。 */
export function resolveMergeConflicts(
	base: PiDeckSyncIndexV1 | null,
	local: PiDeckSyncIndexV1,
	remote: PiDeckSyncIndexV1,
	resolutions: CloudSyncConflictResolution[],
	strategy: CloudSyncStrategy,
): CloudSyncMergeResult {
	const choices = new Map<string, "local" | "remote">(
		resolutions.map((resolution) => [resolution.id, resolution.choice]),
	);
	return mergeSyncIndexes(base, local, remote, strategy, choices);
}
