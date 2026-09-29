import type { Project, ProjectLocator, ProjectMetadata } from "../../shared/types/project";
import { projectLocatorFromLegacy, projectLocatorToLegacyFields } from "../../shared/locationAdapters";
import { isRemoteProject } from "../../shared/projectLocation";

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
	const { path, environment, wslDistro, ...rest } = project;
	return { ...rest, locator: projectLocatorFromLegacy({ path, environment, wslDistro }) };
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
		...(typeof value.pinned === "boolean" ? { pinned: value.pinned } : {}),
		...(typeof value.sortOrder === "number" ? { sortOrder: value.sortOrder } : {}),
		...(value.kind === "chat" ? { kind: "chat" } : {}),
		...(typeof value.worktreeEnabled === "boolean" ? { worktreeEnabled: value.worktreeEnabled } : {}),
		...(typeof value.worktreeParentId === "string" ? { worktreeParentId: value.worktreeParentId } : {}),
		...(typeof value.missing === "boolean" ? { missing: value.missing } : {}),
	};
}

/** 远端路径上限与 `RemoteBrowseRoot` 的 `--root` 上限保持一致（4096）。 */
const MAX_REMOTE_PATH = 4096;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * 校验 ssh locator：`hostId` 非空有界、`remotePath` 必须是绝对 POSIX 路径且无穿越/控制字节。
 *
 * 这条校验与写入侧同源（canonical browse root 只产出这种值），所以放行集不会意外变窄；
 * 而任何不满足的记录在加载时被拒 ⇒ 整份 store 进 `needs-repair`，绝不把可疑远端路径
 * 交给下游当授权根。
 */
function readSshLocator(value: Record<string, unknown>): ProjectLocator | undefined {
	if (typeof value.hostId !== "string" || !value.hostId || value.hostId.length > 256 || CONTROL_CHARS.test(value.hostId)) return undefined;
	if (typeof value.remotePath !== "string" || value.remotePath.length === 0 || value.remotePath.length > MAX_REMOTE_PATH || CONTROL_CHARS.test(value.remotePath)) return undefined;
	if (!value.remotePath.startsWith("/") || value.remotePath === "/" || value.remotePath.endsWith("/")) return undefined;
	const segments = value.remotePath.slice(1).split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
	return { kind: "ssh", hostId: value.hostId, remotePath: value.remotePath };
}

function readProjectLocator(value: unknown): ProjectLocator | undefined {
	if (!isRecord(value)) return undefined;
	if (value.kind === "local" && (value.environment === "native" || value.environment === "wsl") && typeof value.localPath === "string" && value.localPath.trim()) {
		if (value.wslDistro !== undefined && typeof value.wslDistro !== "string") return undefined;
		return {
			kind: "local",
			environment: value.environment,
			localPath: value.localPath,
			...(typeof value.wslDistro === "string" ? { wslDistro: value.wslDistro } : {}),
		};
	}
	if (value.kind === "ssh") return readSshLocator(value);
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
