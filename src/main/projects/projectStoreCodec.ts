import type { Project, ProjectLocator, ProjectMetadata } from "../../shared/types/project";
import { projectLocatorFromLegacy, projectLocatorToLegacyFields } from "../../shared/locationAdapters";
import { isRemoteProject, readProjectLocator as readSharedProjectLocator } from "../../shared/projectLocation";

export type ProjectStoreV2Entry = ProjectMetadata & {
	kind?: "chat";
	worktreeEnabled?: boolean;
	worktreeParentId?: string;
	locator: ProjectLocator;
};

export type ProjectStoreV2Snapshot = {
	schemaVersion: 2;
	revision: number;
	projects: ProjectStoreV2Entry[];
};

export type DecodedProjectStoreSnapshot = {
	projects: Project[];
	revision: number;
	sourceVersion: 1 | 2;
};

/**
 * 位置无关的元数据形状（本地/远端共用），由 `readProjectMetadata` 逐字段校验后产出。
 * `kind: "chat"` 只属于本地项目；远端记录中出现会被 `readV2Project` 拒绝。
 */
type ParsedProjectMetadata = ProjectMetadata & { kind?: "chat"; worktreeEnabled?: boolean; worktreeParentId?: string };

/** Reads v1 arrays and v2 envelopes. Both local and SSH (Phase 3) records decode to the `Project` union. */
export function decodeProjectStoreSnapshot(value: unknown): DecodedProjectStoreSnapshot {
	if (Array.isArray(value)) {
		return {
			projects: value.map(readLegacyProject),
			revision: 0,
			sourceVersion: 1,
		};
	}
	if (!isRecord(value) || value.schemaVersion !== 2 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !Array.isArray(value.projects)) {
		throw new Error("PROJECT_STORE_INVALID_SNAPSHOT");
	}
	return {
		projects: value.projects.map(readV2Project),
		revision: Number(value.revision),
		sourceVersion: 2,
	};
}

/**
 * Writes locator-based entries for both location kinds. `path`/`environment`/`wslDistro` never appear
 * on an SSH entry — the ssh locator is carried verbatim, so a remote project cannot be re-read as a
 * local path by any consumer.
 */
export function encodeProjectStoreSnapshot(projects: Project[], revision: number): ProjectStoreV2Snapshot {
	if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("PROJECT_STORE_INVALID_REVISION");
	return {
		schemaVersion: 2,
		revision,
		projects: projects.map((project) => (isRemoteProject(project) ? { ...project } : encodeLocalEntry(project))),
	};
}

function encodeLocalEntry(project: Project): ProjectStoreV2Entry {
	if (isRemoteProject(project)) throw new Error("PROJECT_STORE_INVALID_PROJECT");
	const { path, environment, wslDistro, wslUser, wslHostId, ...rest } = project;
	return { ...rest, locator: projectLocatorFromLegacy({ path, environment, wslDistro, wslUser, wslHostId }) };
}

function readLegacyProject(value: unknown): Project {
	if (!isRecord(value)) throw new Error("PROJECT_STORE_INVALID_PROJECT");
	const metadata = readProjectMetadata(value);
	if (!metadata || typeof value.path !== "string" || !value.path.trim()) throw new Error("PROJECT_STORE_INVALID_PROJECT");
	if (value.environment !== undefined && value.environment !== "windows" && value.environment !== "wsl") throw new Error("PROJECT_STORE_INVALID_PROJECT");
	if (value.wslDistro !== undefined && typeof value.wslDistro !== "string") throw new Error("PROJECT_STORE_INVALID_PROJECT");
	const fields = projectLocatorToLegacyFields(
		projectLocatorFromLegacy({
			path: value.path,
			...(value.environment === "windows" || value.environment === "wsl" ? { environment: value.environment } : {}),
			...(typeof value.wslDistro === "string" ? { wslDistro: value.wslDistro } : {}),
			...(typeof value.wslUser === "string" ? { wslUser: value.wslUser } : {}),
			...(typeof value.wslHostId === "string" ? { wslHostId: value.wslHostId } : {}),
		}),
	);
	if (!fields) throw new Error("PROJECT_STORE_INVALID_PROJECT");
	return { ...metadata, ...fields };
}

function readV2Project(value: unknown): Project {
	if (!isRecord(value) || "path" in value || "environment" in value || "wslDistro" in value) {
		throw new Error("PROJECT_STORE_INVALID_V2_PROJECT");
	}
	const metadata = readProjectMetadata(value);
	const locator = readProjectLocator(value.locator);
	if (!metadata || !locator) throw new Error("PROJECT_STORE_INVALID_V2_PROJECT");
	if (locator.kind === "ssh") {
		// 远端项目没有本机路径、没有 worktree/chat 语义：出现这些字段说明写入侧把两种形状混淆了，
		// 宁可整份 store 拒绝，也不产出一个「看起来像本地项目」的远端记录。
		if (metadata.kind === "chat" || metadata.worktreeEnabled !== undefined || metadata.worktreeParentId !== undefined) throw new Error("PROJECT_STORE_INVALID_V2_PROJECT");
		const { kind: _kind, worktreeEnabled: _worktreeEnabled, worktreeParentId: _worktreeParentId, ...plain } = metadata;
		return { ...plain, locator };
	}
	const fields = projectLocatorToLegacyFields(locator);
	if (!fields) throw new Error("PROJECT_STORE_INVALID_V2_PROJECT");
	return { ...metadata, ...fields };
}

function readProjectMetadata(value: Record<string, unknown>): ParsedProjectMetadata | undefined {
	if (typeof value.id !== "string" || !value.id || typeof value.name !== "string" || !value.name || typeof value.lastOpenedAt !== "number" || !Number.isFinite(value.lastOpenedAt)) return undefined;
	if ("createdAt" in value && (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt))) return undefined;
	if ("pinned" in value && typeof value.pinned !== "boolean") return undefined;
	if ("sortOrder" in value && (typeof value.sortOrder !== "number" || !Number.isFinite(value.sortOrder))) return undefined;
	if ("kind" in value && value.kind !== "chat") return undefined;
	if ("worktreeEnabled" in value && typeof value.worktreeEnabled !== "boolean") return undefined;
	if ("worktreeParentId" in value && typeof value.worktreeParentId !== "string") return undefined;
	if ("missing" in value && typeof value.missing !== "boolean") return undefined;
	return {
		id: value.id,
		name: value.name,
		lastOpenedAt: value.lastOpenedAt,
		...(typeof value.createdAt === "number" ? { createdAt: value.createdAt } : {}),
		...(typeof value.pinned === "boolean" ? { pinned: value.pinned } : {}),
		...(typeof value.sortOrder === "number" ? { sortOrder: value.sortOrder } : {}),
		...(value.kind === "chat" ? { kind: "chat" } : {}),
		...(typeof value.worktreeEnabled === "boolean" ? { worktreeEnabled: value.worktreeEnabled } : {}),
		...(typeof value.worktreeParentId === "string" ? { worktreeParentId: value.worktreeParentId } : {}),
		...(typeof value.missing === "boolean" ? { missing: value.missing } : {}),
	};
}

/**
 * locator 的读取判据不在本文件：唯一出处是 shared 的 `readProjectLocator`，与写入侧
 * （`ProjectStore.addRemote`）和引用扫描（`RemoteHostReferenceSources`）同一个纯函数。
 *
 * 历史事故形状：写入侧只查非空、codec 却更严格，于是一次登记就能写出加载时被整份拒绝的
 * `projects.json`（`needs-repair`，所有项目一起不可用）。三处共用一个判据后，这种
 * 「写进去、读不出来」的形状不再存在。任何不满足的记录仍在加载时被拒，绝不把可疑远端路径
 * 交给下游当授权根。
 *
 * 保留 `readSshLocator` 这个薄投影而不是让 `readV2Project` 直接调 shared，是因为
 * `tests/remoteHostCrossStoreContract.test.mjs` 按「文件:函数名」登记解码持久化 hostId 的引用源
 * 归属：解码点必须留在被审计的文件里，否则这份审计会静默失去覆盖。
 */
function readSshLocator(value: Record<string, unknown>): ProjectLocator | undefined {
	const parsed = readSharedProjectLocator(value);
	if (!parsed || parsed.kind !== "ssh") return undefined;
	return { kind: "ssh", hostId: parsed.hostId, remotePath: parsed.remotePath };
}

/** 本地分支（含「本地 locator 不得携带 hostId」）与 ssh 分支都回到 shared 的同一判据。 */
function readProjectLocator(value: unknown): ProjectLocator | undefined {
	if (!isRecord(value) || value.kind !== "ssh") return readSharedProjectLocator(value);
	return readSshLocator(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
