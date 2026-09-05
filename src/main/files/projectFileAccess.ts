import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isPathInsideProject } from "../fs/FileSystemService";

export const FILE_OUTSIDE_PROJECT_ERROR = "FILE_OUTSIDE_PROJECT";

/**
 * 校验项目文件读取的词法边界。
 * 这一层会折叠 `..`，用于在触碰文件系统前快速拒绝明显越界或相对路径。
 */
export function assertProjectFilePathInsideRoot(projectRoot: string, targetPath: string): void {
	if (
		!isAbsolute(projectRoot) ||
		!isAbsolute(targetPath) ||
		!isPathInsideProject(projectRoot, targetPath)
	) {
		throw new Error(FILE_OUTSIDE_PROJECT_ERROR);
	}
}

export type ProjectFileReadBoundary = Readonly<{
	projectRoot: string;
	canonicalRoot: string;
}>;

/** 解析一批读取共用的可信项目根；批量 stat 时只触碰一次项目根 realpath。 */
export async function createProjectFileReadBoundary(
	projectRoot: string,
): Promise<ProjectFileReadBoundary> {
	if (!isAbsolute(projectRoot)) throw new Error(FILE_OUTSIDE_PROJECT_ERROR);
	return {
		projectRoot,
		canonicalRoot: await realpath(projectRoot),
	};
}

/** 在已解析的项目根内校验一个真实文件，并返回其 canonical path。 */
export async function resolveProjectFileReadPath(
	boundary: ProjectFileReadBoundary,
	targetPath: string,
): Promise<string> {
	assertProjectFilePathInsideRoot(boundary.projectRoot, targetPath);
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
export async function assertProjectFileReadPath(
	projectRoot: string,
	targetPath: string,
): Promise<string> {
	const boundary = await createProjectFileReadBoundary(projectRoot);
	return resolveProjectFileReadPath(boundary, targetPath);
}
