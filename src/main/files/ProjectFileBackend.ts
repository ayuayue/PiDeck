import type { FileSearchResult, FileTreeNode, ProjectFileTarget, ProjectLocator } from "../../shared/types";
import type { ProjectDirectoryEntry } from "../../shared/types/projectFiles";

export type ProjectFileBackend = {
	readonly locationKind: ProjectLocator["kind"];
	list(target: ProjectFileTarget, maxDepth?: number): Promise<FileTreeNode[]>;
	search(target: ProjectFileTarget, query: string): Promise<FileSearchResult[]>;
	readContent(target: ProjectFileTarget, maxBytes?: number): Promise<string>;
	readBase64(target: ProjectFileTarget, maxBytes?: number): Promise<string>;
	writeContent(target: ProjectFileTarget, content: string): Promise<void>;
	pathsExist(targets: ProjectFileTarget[]): Promise<boolean[]>;
	stat(target: ProjectFileTarget): Promise<{ exists: boolean; isDirectory: boolean }>;
	create(parent: ProjectFileTarget, name: string, type: "file" | "directory"): Promise<ProjectFileTarget>;
	delete(target: ProjectFileTarget, recursive?: boolean): Promise<void>;
	rename(target: ProjectFileTarget, newName: string): Promise<ProjectFileTarget>;
	copy(sources: ProjectFileTarget[], targetDir: ProjectFileTarget): Promise<ProjectFileTarget[]>;
	move(sources: ProjectFileTarget[], targetDir: ProjectFileTarget): Promise<ProjectFileTarget[]>;
	/** 单层目录页（T6）；没有它的位置明确表示「不支持目录页」，调用方不得自行拼凑。 */
	directoryPage?(target: ProjectFileTarget, limit?: number): Promise<{ entries: ProjectDirectoryEntry[]; truncated: boolean }>;
};

/** Selects a backend by the project's canonical location; the WSL backend is optional so tests and non-Windows builds stay local-only. */
export class ProjectFileBackendRouter {
	constructor(
		private readonly localBackend: ProjectFileBackend,
		private readonly getProjectLocator: (projectId: string) => ProjectLocator | undefined,
		private readonly wslBackend?: ProjectFileBackend,
	) {}

	forProject(projectId: string): ProjectFileBackend {
		if (!projectId.trim()) throw new Error("INVALID_PROJECT_FILE_TARGET");
		const locator = this.getProjectLocator(projectId);
		if (!locator) throw new Error("PROJECT_NOT_FOUND");
		if (locator.kind !== "local") throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		// WSL 项目仍是 local locator，但它的文件面必须在发行版内以档案用户身份执行（见计划决定 5）。
		if (this.wslBackend !== undefined && locator.environment === "wsl") return this.wslBackend;
		return this.localBackend;
	}
}
