import { cp, readFile, rename as fsRename, rm, stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { FileSearchResult, FileTreeNode, ProjectFileTarget } from "../../shared/types";
import { createProjectFileReadBoundary, resolveProjectFileReadPath, resolveProjectFileWritePath, type ProjectFileReadBoundary } from "./projectFileAccess";
import { parseProjectFileTarget, resolveLocalProjectFileTarget } from "./projectFileTarget";
import type { ProjectFileBackend } from "./ProjectFileBackend";
import type { FileSystemService } from "../fs/FileSystemService";

export type LocalProjectFileBackendDeps = {
	fileSystemService: Pick<FileSystemService, "listTree" | "searchNames" | "create" | "delete" | "rename">;
	resolveProjectRoot: (projectId: string) => string;
};

type ResolvedTarget = {
	target: ProjectFileTarget;
	root: string;
	boundary: ProjectFileReadBoundary;
	path: string;
};

function isMissingPath(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function withProjectTargets(nodes: FileTreeNode[], projectId: string): FileTreeNode[] {
	return nodes.map((node) => ({
		...node,
		displayPath: node.displayPath ?? node.path ?? node.relativePath,
		target: { projectId, relativePath: node.relativePath },
		...(node.children ? { children: withProjectTargets(node.children, projectId) } : {}),
	}));
}

function validateName(name: unknown): asserts name is string {
	if (typeof name !== "string" || !name.trim() || name.length > 255 || name === "." || name === ".." || /[\\/\0]/.test(name)) {
		throw new Error("INVALID_PROJECT_FILE_NAME");
	}
}

function childTarget(parent: ProjectFileTarget, name: string): ProjectFileTarget {
	return { projectId: parent.projectId, relativePath: parent.relativePath ? `${parent.relativePath}/${name}` : name };
}

/** Local implementation of the portable project-relative file contract. */
export class LocalProjectFileBackend implements ProjectFileBackend {
	readonly locationKind = "local" as const;

	constructor(private readonly deps: LocalProjectFileBackendDeps) {}

	private async resolveTarget(rawTarget: ProjectFileTarget): Promise<ResolvedTarget> {
		const target = parseProjectFileTarget(rawTarget);
		const root = this.deps.resolveProjectRoot(target.projectId);
		const boundary = await createProjectFileReadBoundary(root);
		const localPath = resolveLocalProjectFileTarget(root, target.relativePath);
		const path = await resolveProjectFileReadPath(boundary, localPath);
		return { target, root, boundary, path };
	}

	async list(target: ProjectFileTarget, maxDepth = 0): Promise<FileTreeNode[]> {
		try {
			const resolved = await this.resolveTarget(target);
			const nodes = await this.deps.fileSystemService.listTree(resolved.root, maxDepth, resolved.path);
			return withProjectTargets(nodes, resolved.target.projectId);
		} catch (error) {
			if (isMissingPath(error)) throw new Error("PROJECT_DIRECTORY_MISSING");
			throw error;
		}
	}

	async search(target: ProjectFileTarget, query: string): Promise<FileSearchResult[]> {
		const resolved = await this.resolveTarget(target);
		const results = await this.deps.fileSystemService.searchNames(resolved.root, query);
		return results.map((result) => ({
			...result,
			displayPath: result.displayPath ?? result.path ?? result.relativePath,
			target: { projectId: resolved.target.projectId, relativePath: result.relativePath },
		}));
	}

	async readContent(target: ProjectFileTarget, maxBytes?: number): Promise<string> {
		try {
			const { path } = await this.resolveTarget(target);
			if (Number.isFinite(maxBytes) && (maxBytes ?? 0) > 0) await this.assertWithinSize(path, maxBytes as number);
			return await readFile(path, "utf8");
		} catch (error) {
			if (isMissingPath(error)) return "";
			throw error;
		}
	}

	async readBase64(target: ProjectFileTarget, maxBytes?: number): Promise<string> {
		try {
			const { path } = await this.resolveTarget(target);
			if (Number.isFinite(maxBytes) && (maxBytes ?? 0) > 0) await this.assertWithinSize(path, maxBytes as number);
			return (await readFile(path)).toString("base64");
		} catch (error) {
			if (isMissingPath(error)) return "";
			throw error;
		}
	}

	async writeContent(target: ProjectFileTarget, content: string): Promise<void> {
		if (typeof content !== "string") throw new Error("Invalid file content");
		const { path } = await this.resolveTarget(target);
		await writeFile(path, content, "utf8");
	}

	async pathsExist(targets: ProjectFileTarget[]): Promise<boolean[]> {
		const parsedTargets = targets.map((target) => parseProjectFileTarget(target));
		return Promise.all(
			parsedTargets.map(async (target) => {
				try {
					const result = await this.resolveTarget(target);
					const fileStat = await stat(result.path);
					return fileStat.isFile() || fileStat.isDirectory();
				} catch {
					return false;
				}
			}),
		);
	}

	async stat(target: ProjectFileTarget): Promise<{ exists: boolean; isDirectory: boolean }> {
		try {
			const resolved = await this.resolveTarget(target);
			const fileStat = await stat(resolved.path);
			return { exists: true, isDirectory: fileStat.isDirectory() };
		} catch {
			return { exists: false, isDirectory: false };
		}
	}

	async create(parent: ProjectFileTarget, name: string, type: "file" | "directory"): Promise<ProjectFileTarget> {
		validateName(name);
		const resolved = await this.resolveTarget(parent);
		if (!(await stat(resolved.path)).isDirectory()) throw new Error("PROJECT_FILE_PARENT_NOT_DIRECTORY");
		const target = childTarget(resolved.target, name);
		const localTarget = resolveLocalProjectFileTarget(resolved.root, target.relativePath);
		await resolveProjectFileWritePath(resolved.boundary, localTarget);
		await this.deps.fileSystemService.create(resolved.path, name, type);
		return target;
	}

	async delete(target: ProjectFileTarget, recursive = false): Promise<void> {
		const resolved = await this.resolveTarget(target);
		const writablePath = await resolveProjectFileWritePath(resolved.boundary, resolveLocalProjectFileTarget(resolved.root, resolved.target.relativePath));
		await this.deps.fileSystemService.delete(writablePath, recursive);
	}

	async rename(target: ProjectFileTarget, newName: string): Promise<ProjectFileTarget> {
		validateName(newName);
		const resolved = await this.resolveTarget(target);
		const writablePath = await resolveProjectFileWritePath(resolved.boundary, resolveLocalProjectFileTarget(resolved.root, resolved.target.relativePath));
		await this.deps.fileSystemService.rename(writablePath, newName);
		const parentPath = resolved.target.relativePath.split("/").slice(0, -1).join("/");
		return childTarget({ projectId: resolved.target.projectId, relativePath: parentPath }, newName);
	}

	async copy(sources: ProjectFileTarget[], targetDir: ProjectFileTarget): Promise<ProjectFileTarget[]> {
		const parsedSources = sources.map((source) => parseProjectFileTarget(source));
		const destination = await this.resolveTarget(targetDir);
		const sourcePaths = await Promise.all(parsedSources.map(async (source) => ({ source, path: (await this.resolveTarget(source)).path })));
		const results: ProjectFileTarget[] = [];
		for (const { source, path } of sourcePaths) {
			const name = basename(source.relativePath);
			if (!name) throw new Error("PROJECT_FILE_ROOT_CANNOT_BE_COPIED");
			const target = childTarget(destination.target, name);
			const destinationPath = resolveLocalProjectFileTarget(destination.root, target.relativePath);
			const writableDestination = await resolveProjectFileWritePath(destination.boundary, destinationPath);
			await cp(path, writableDestination, { recursive: true, errorOnExist: false });
			results.push(target);
		}
		return results;
	}

	async move(sources: ProjectFileTarget[], targetDir: ProjectFileTarget): Promise<ProjectFileTarget[]> {
		const parsedSources = sources.map((source) => parseProjectFileTarget(source));
		const destination = await this.resolveTarget(targetDir);
		const sourcePaths = await Promise.all(parsedSources.map(async (source) => ({ source, resolved: await this.resolveTarget(source) })));
		const results: ProjectFileTarget[] = [];
		for (const { source, resolved } of sourcePaths) {
			const name = basename(source.relativePath);
			if (!name) throw new Error("PROJECT_FILE_ROOT_CANNOT_BE_MOVED");
			const target = childTarget(destination.target, name);
			const destinationPath = resolveLocalProjectFileTarget(destination.root, target.relativePath);
			const writableDestination = await resolveProjectFileWritePath(destination.boundary, destinationPath);
			const sourcePath = await resolveProjectFileWritePath(resolved.boundary, resolveLocalProjectFileTarget(resolved.root, source.relativePath));
			if (sourcePath === writableDestination) {
				results.push(target);
				continue;
			}
			try {
				await fsRename(sourcePath, writableDestination);
			} catch {
				await cp(sourcePath, writableDestination, { recursive: true });
				await rm(sourcePath, { recursive: true, force: true });
			}
			results.push(target);
		}
		return results;
	}

	private async assertWithinSize(path: string, maxBytes: number): Promise<void> {
		const fileStat = await stat(path);
		if (fileStat.size > maxBytes) throw new Error(`FILE_TOO_LARGE:${fileStat.size}:${Math.floor(maxBytes)}`);
	}
}
