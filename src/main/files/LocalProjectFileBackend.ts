import { createHash } from "node:crypto";
import { cp, readFile, rename as fsRename, rm, stat } from "node:fs/promises";
import { basename } from "node:path";
import { codeOf } from "../../shared/op";
import type { FileSearchResult, FileTreeNode, ProjectFileTarget } from "../../shared/types";
import type { ProjectDirectoryEntry, ProjectFileStatResult } from "../../shared/types/projectFiles";
import { createProjectFileReadBoundary, resolveProjectFileReadPath, resolveProjectFileWritePath, type ProjectFileReadBoundary } from "./projectFileAccess";
import { parseProjectFileTarget, resolveLocalProjectFileTarget } from "./projectFileTarget";
import { assertTrustedStatSize, readTextFileGuarded } from "./textFileRead";
import { writeTextFileGuarded } from "./textFileWrite";
import type { ProjectFileBackend } from "./ProjectFileBackend";
import { applyDirectoryIgnore } from "./DirectoryIgnore";
import type { FileSystemService } from "../fs/FileSystemService";

export type LocalProjectFileBackendDeps = {
	fileSystemService: Pick<FileSystemService, "listTree" | "listTreePage" | "searchNames" | "create" | "delete" | "rename">;
	resolveProjectRoot: (projectId: string) => string;
	/**
	 * 目录页的 Git ignore 判定（只读）：返回与路径逐位对应的布尔数组；无法判定返回 `undefined`。
	 * 未装配（旧装配/测试）时目录页不带 `ignored`——缺字段表示“没判定”，不是“未忽略”。
	 */
	checkIgnore?: (cwd: string, relativePaths: readonly string[]) => Promise<readonly boolean[] | undefined>;
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

	/**
	 * 公共目录页（T6）：只读一层，带 exact 的 hasChildren 与显式 truncated。
	 * 本机 `generation` 是稳定常量（同一个本地项目不存在连接代切换），`revision` 由调用方每次读取计。
	 */
	async checkIgnore(target: ProjectFileTarget, relativePaths: readonly string[]): Promise<readonly boolean[] | undefined> {
		if (this.deps.checkIgnore === undefined || relativePaths.length === 0) return undefined;
		let canonicalRoot: string;
		try {
			canonicalRoot = (await this.resolveTarget(target)).boundary.canonicalRoot;
		} catch {
			return undefined;
		}
		try {
			return await this.deps.checkIgnore(canonicalRoot, relativePaths);
		} catch {
			// 判定不是目录页的前置条件：失败就是不修饰。
			return undefined;
		}
	}

	async directoryPage(target: ProjectFileTarget, limit = 2000): Promise<{ entries: ProjectDirectoryEntry[]; truncated: boolean }> {
		let page;
		let canonicalRoot = "";
		try {
			const resolved = await this.resolveTarget(target);
			canonicalRoot = resolved.boundary.canonicalRoot;
			page = await this.deps.fileSystemService.listTreePage(canonicalRoot, 0, resolved.path);
		} catch (error) {
			if (isMissingPath(error)) throw new Error("PROJECT_DIRECTORY_MISSING");
			throw error;
		}
		const projectId = target.projectId;
		const mapped: ProjectDirectoryEntry[] = page.nodes
			.filter((node) => node.type === "file" || node.type === "directory")
			.map((node) => ({
				target: { projectId, relativePath: node.relativePath },
				relativePath: node.relativePath,
				type: node.type,
				hasChildren: node.type === "directory" ? (node.hasChildren ?? false) : false,
				// 本机条目的绝对路径/元数据：文件树的 path、排序与打开文件/Git 着色都依赖它们。
				path: node.path,
				mtimeMs: node.mtimeMs,
				ctimeMs: node.ctimeMs,
				size: node.size,
			}));
		// 本机 ignore 修饰：判定失败只是“没修饰”，它绝不能让一次成功的目录读变成失败。
		// 目录页的 ignore 修饰：判定失败只是「没有修饰」，不影响这一次成功的目录读。
		const ignored = await this.checkIgnore(
			{ projectId, relativePath: target.relativePath },
			mapped.map((entry) => entry.relativePath),
		);
		const truncated = page.truncated || mapped.length > limit;
		return { entries: applyDirectoryIgnore(mapped.slice(0, limit), ignored?.slice(0, limit)), truncated, ...(truncated ? { totalEntries: mapped.length } : {}) };
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
			// 大小可信性/文本性判定与 files:read-content 共用同一守卫，避免两条路径给出不同诊断。
			return await readTextFileGuarded(path, maxBytes);
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

	async writeContent(target: ProjectFileTarget, content: string, expectedRevision?: string): Promise<void> {
		if (typeof content !== "string") throw new Error("Invalid file content");
		const { path } = await this.resolveTarget(target);
		// 乐观锁（与 mcp.json 保存同一思路）：编辑器带回「它读到的那份内容」的 sha256。
		// 盘上已经变了就拒绝，把外部修改（另一个编辑器、git checkout、agent 写文件）留给用户判断，
		// 而不是让 500ms 自动保存把别人的修改静默盖掉。
		if (expectedRevision !== undefined && (await localTextRevision(path)) !== expectedRevision) throw new Error("PROJECT_FILE_CHANGED");
		// 与 files:write-content 同一条写守卫：拒绝把明文写进非文本/密文文件，写盘原子化。
		await writeTextFileGuarded(path, content);
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

	async stat(target: ProjectFileTarget): Promise<ProjectFileStatResult> {
		try {
			const resolved = await this.resolveTarget(target);
			const fileStat = await stat(resolved.path);
			return { availability: "present", exists: true, isDirectory: fileStat.isDirectory() };
		} catch (error) {
			if (isMissingPath(error)) return { availability: "missing", exists: false, isDirectory: false, code: "ENOENT" };
			return { availability: "unavailable", exists: false, isDirectory: false, code: codeOf(error, "PROJECT_FILE_STAT_UNAVAILABLE") };
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

	/**
	 * 一次写移动到目标全路径：跨目录改名与同目录改名走同一条路径（不再 move→rename 两步）。
	 * 跨设备失败时回退 cp + rm，与 `move` 相同。
	 */
	async moveTo(source: ProjectFileTarget, target: ProjectFileTarget): Promise<ProjectFileTarget> {
		const parsedSource = parseProjectFileTarget(source);
		if (parsedSource.relativePath === "") throw new Error("PROJECT_FILE_ROOT_CANNOT_BE_MOVED");
		const parsedDestination = parseProjectFileTarget(target);
		if (parsedDestination.relativePath === "" || parsedDestination.relativePath.endsWith("/")) throw new Error("INVALID_PROJECT_FILE_TARGET");
		if (parsedDestination.projectId !== parsedSource.projectId) throw new Error("CROSS_BACKEND_FILE_OPERATION_UNSUPPORTED");
		const resolvedSource = await this.resolveTarget(parsedSource);
		// 目标文件通常还不存在：用写边界（只需在根内），不能用读面 resolveTarget（它要求存在）。
		const destinationRoot = this.deps.resolveProjectRoot(parsedDestination.projectId);
		const destinationBoundary = await createProjectFileReadBoundary(destinationRoot);
		const destinationPath = await resolveProjectFileWritePath(destinationBoundary, resolveLocalProjectFileTarget(destinationRoot, parsedDestination.relativePath));
		const sourcePath = await resolveProjectFileWritePath(resolvedSource.boundary, resolveLocalProjectFileTarget(resolvedSource.root, parsedSource.relativePath));
		if (sourcePath === destinationPath) return parsedDestination;
		try {
			await fsRename(sourcePath, destinationPath);
		} catch {
			await cp(sourcePath, destinationPath, { recursive: true });
			await rm(sourcePath, { recursive: true, force: true });
		}
		return parsedDestination;
	}

	private async assertWithinSize(path: string, maxBytes: number): Promise<void> {
		const fileStat = await stat(path);
		assertTrustedStatSize(fileStat.size);
		if (fileStat.size > maxBytes) throw new Error(`FILE_TOO_LARGE:${fileStat.size}:${Math.floor(maxBytes)}`);
	}
}

/**
 * 本机文本文件的修订指纹：`sha256:` + 内容哈希；文件不存在时用 `absent`。
 * 只用来做「保存前盘上是否已被改过」的比较，跨进程稳定（渲染层可以用同一算法自查）。
 */
export async function localTextRevision(path: string): Promise<string> {
	try {
		return (
			"sha256:" +
			createHash("sha256")
				.update(await readFile(path))
				.digest("hex")
		);
	} catch (error) {
		if (isMissingPath(error)) return "absent";
		throw error;
	}
}
