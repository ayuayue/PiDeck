import type { Project, ProjectLocator } from "../../shared/types/project";
import { projectLocatorFromLegacy, projectLocatorToLegacyFields } from "../../shared/locationAdapters";

export type ProjectStoreV2Entry = Omit<Project, "path" | "environment" | "wslDistro"> & {
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

type ProjectMetadata = Omit<Project, "path" | "environment" | "wslDistro">;

/** Reads v1 arrays and v2 envelopes into the current local-only compatibility shape. */
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

/** Writes only locator-based entries; path/environment remain confined to the local adapter. */
export function encodeProjectStoreSnapshot(projects: Project[], revision: number): ProjectStoreV2Snapshot {
	if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("PROJECT_STORE_INVALID_REVISION");
	return {
		schemaVersion: 2,
		revision,
		projects: projects.map((project) => {
			const { path, environment, wslDistro, ...metadata } = project;
			return {
				...metadata,
				locator: projectLocatorFromLegacy({ path, environment, wslDistro }),
			};
		}),
	};
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
	if (locator.kind !== "local") throw new Error("PROJECT_STORE_REMOTE_UNSUPPORTED");
	const fields = projectLocatorToLegacyFields(locator);
	if (!fields) throw new Error("PROJECT_STORE_INVALID_V2_PROJECT");
	return { ...metadata, ...fields };
}

function readProjectMetadata(value: Record<string, unknown>): ProjectMetadata | undefined {
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
	if (value.kind === "ssh" && typeof value.hostId === "string" && value.hostId && typeof value.remotePath === "string" && value.remotePath.trim()) {
		return { kind: "ssh", hostId: value.hostId, remotePath: value.remotePath };
	}
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
