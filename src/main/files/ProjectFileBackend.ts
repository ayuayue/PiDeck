import type { FileSearchResult, FileTreeNode, ProjectFileTarget, ProjectLocator } from "../../shared/types";

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
};

/** Selects a backend by the project's canonical location; Phase 1 registers only local. */
export class ProjectFileBackendRouter {
	constructor(
		private readonly localBackend: ProjectFileBackend,
		private readonly getProjectLocator: (projectId: string) => ProjectLocator | undefined,
	) {}

	forProject(projectId: string): ProjectFileBackend {
		if (!projectId.trim()) throw new Error("INVALID_PROJECT_FILE_TARGET");
		const locator = this.getProjectLocator(projectId);
		if (!locator) throw new Error("PROJECT_NOT_FOUND");
		if (locator.kind !== "local") throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		return this.localBackend;
	}
}
