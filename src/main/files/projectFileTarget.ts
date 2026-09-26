import { isAbsolute, resolve } from "node:path";
import type { ProjectFileTarget } from "../../shared/types/project";
import { isPathInsideProject } from "../fs/FileSystemService";

export const INVALID_PROJECT_FILE_TARGET = "INVALID_PROJECT_FILE_TARGET";

/** Parse renderer input into the only portable project-file request shape. */
export function parseProjectFileTarget(value: unknown): ProjectFileTarget {
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "projectId" && key !== "relativePath")) {
		throw new Error(INVALID_PROJECT_FILE_TARGET);
	}
	if (typeof value.projectId !== "string" || !value.projectId.trim() || value.projectId !== value.projectId.trim() || value.projectId.length > 256 || value.projectId.includes("\0")) {
		throw new Error(INVALID_PROJECT_FILE_TARGET);
	}
	if (typeof value.relativePath !== "string") throw new Error(INVALID_PROJECT_FILE_TARGET);
	validateRelativePath(value.relativePath);
	return { projectId: value.projectId, relativePath: value.relativePath };
}

/** Resolve a validated slash-separated target only beneath a trusted local project root. */
export function resolveLocalProjectFileTarget(projectRoot: string, relativePath: string): string {
	if (!isAbsolute(projectRoot)) throw new Error(INVALID_PROJECT_FILE_TARGET);
	validateRelativePath(relativePath);
	const resolvedTarget = resolve(projectRoot, ...(relativePath ? relativePath.split("/") : []));
	if (!isPathInsideProject(projectRoot, resolvedTarget)) throw new Error(INVALID_PROJECT_FILE_TARGET);
	return resolvedTarget;
}

function validateRelativePath(relativePath: string): void {
	if (relativePath.length > 32_768 || relativePath.includes("\0")) throw new Error(INVALID_PROJECT_FILE_TARGET);
	if (relativePath === "") return;
	if (relativePath.startsWith("/") || /^[a-zA-Z]:/.test(relativePath) || (process.platform === "win32" && relativePath.includes("\\"))) {
		throw new Error(INVALID_PROJECT_FILE_TARGET);
	}
	if (relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
		throw new Error(INVALID_PROJECT_FILE_TARGET);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
