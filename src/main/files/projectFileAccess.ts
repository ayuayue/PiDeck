import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isPathInsideProject } from "../fs/FileSystemService";

export const FILE_OUTSIDE_PROJECT_ERROR = "FILE_OUTSIDE_PROJECT";

/**
 * 校验项目文件读取的词法边界。
 * 这一层会折叠 `..`，用于在触碰文件系统前快速拒绝明显越界或相对路径。
 */
export function assertProjectFilePathInsideRoot(projectRoot: string, targetPath: string): void {
	if (!isAbsolute(projectRoot) || !isAbsolute(targetPath) || !isPathInsideProject(projectRoot, targetPath)) {
		throw new Error(FILE_OUTSIDE_PROJECT_ERROR);
	}
}

export type ProjectFileReadBoundary = Readonly<{
	projectRoot: string;
	canonicalRoot: string;
}>;

/** 解析一批读取共用的可信项目根；批量 stat 时只触碰一次项目根 realpath。 */
export async function createProjectFileReadBoundary(projectRoot: string): Promise<ProjectFileReadBoundary> {
	if (!isAbsolute(projectRoot)) throw new Error(FILE_OUTSIDE_PROJECT_ERROR);
	return {
		projectRoot,
		canonicalRoot: await realpath(projectRoot),
	};
}

function assertBoundaryTargetPath(boundary: ProjectFileReadBoundary, targetPath: string): void {
	try {
		assertProjectFilePathInsideRoot(boundary.projectRoot, targetPath);
	} catch {
		// realpath can expand Windows short names or resolve a registered root symlink. Paths returned
		// by an earlier authorized read therefore belong to the canonical root, not its lexical alias.
		assertProjectFilePathInsideRoot(boundary.canonicalRoot, targetPath);
	}
}

/** 在已解析的项目根内校验一个真实文件，并返回其 canonical path。 */
export async function resolveProjectFileReadPath(boundary: ProjectFileReadBoundary, targetPath: string): Promise<string> {
	assertBoundaryTargetPath(boundary, targetPath);
	const canonicalTarget = await realpath(targetPath);
	if (!isPathInsideProject(boundary.canonicalRoot, canonicalTarget)) {
		throw new Error(FILE_OUTSIDE_PROJECT_ERROR);
	}
	// 后续读取使用已校验的真实路径，避免校验后仍沿原 symlink 再次解析。
	return canonicalTarget;
}

/**
 * 校验真实文件边界。
 * 仅做 resolve 比较会被「项目内 symlink 指向项目外」绕过，因此读取前必须比较 realpath。
 */
export async function assertProjectFileReadPath(projectRoot: string, targetPath: string): Promise<string> {
	const boundary = await createProjectFileReadBoundary(projectRoot);
	return resolveProjectFileReadPath(boundary, targetPath);
}

function isMissingPathError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function assertMissingPathIsNotLink(path: string): Promise<void> {
	try {
		const entry = await lstat(path);
		// A dangling symlink/junction has a directory entry even though realpath reports ENOENT.
		// Returning its lexical path would let the eventual write follow the reparse point.
		if (entry.isSymbolicLink()) throw new Error(FILE_OUTSIDE_PROJECT_ERROR);
	} catch (error) {
		if (error instanceof Error && error.message === FILE_OUTSIDE_PROJECT_ERROR) throw error;
		if (!isMissingPathError(error)) throw error;
	}
}

/**
 * Resolve a mutation target through its nearest existing ancestor. Existing targets use their
 * real path; new targets inherit the canonical parent, so project-local symlinks cannot redirect
 * writes, renames, or trash operations outside the registered project.
 */
export async function resolveProjectFileWritePath(boundary: ProjectFileReadBoundary, targetPath: string): Promise<string> {
	assertBoundaryTargetPath(boundary, targetPath);
	try {
		return await resolveProjectFileReadPath(boundary, targetPath);
	} catch (error) {
		if (!isMissingPathError(error)) throw error;
		await assertMissingPathIsNotLink(targetPath);
	}

	let ancestor = dirname(targetPath);
	while (true) {
		try {
			const canonicalAncestor = await realpath(ancestor);
			if (!isPathInsideProject(boundary.canonicalRoot, canonicalAncestor)) {
				throw new Error(FILE_OUTSIDE_PROJECT_ERROR);
			}
			const suffix = relative(ancestor, targetPath);
			const canonicalTarget = resolve(canonicalAncestor, suffix);
			if (!isPathInsideProject(boundary.canonicalRoot, canonicalTarget)) {
				throw new Error(FILE_OUTSIDE_PROJECT_ERROR);
			}
			return canonicalTarget;
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
			await assertMissingPathIsNotLink(ancestor);
			const parent = dirname(ancestor);
			if (parent === ancestor) throw new Error(FILE_OUTSIDE_PROJECT_ERROR);
			ancestor = parent;
		}
	}
}
