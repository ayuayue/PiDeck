import { stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { GitRepoInfo, Project, ProjectFileTarget, ProjectLocator } from "../../shared/types";
import { projectLocatorFromLegacy } from "../../shared/locationAdapters";
import { createProjectFileReadBoundary, resolveProjectFileReadPath } from "../files/projectFileAccess";
import { parseProjectFileTarget } from "../files/projectFileTarget";
import { listGitRepos } from "./gitRepoScope";
import type { ProjectStore } from "../projects/ProjectStore";

export type GitRepositoryContext = {
	projectId: string;
	projectRoot: string;
	repoRoot: string;
	repoTarget: ProjectFileTarget;
};

/** Location-aware boundary for repository roots and project-relative Git file targets. */
export interface GitBackend {
	readonly locationKind: ProjectLocator["kind"];
	resolveRepository(target: ProjectFileTarget): Promise<GitRepositoryContext>;
	resolveFilePath(target: ProjectFileTarget): Promise<string>;
	listRepositories(rootTarget: ProjectFileTarget): Promise<GitRepoInfo[]>;
}

export class LocalGitBackend implements GitBackend {
	readonly locationKind = "local" as const;

	constructor(
		private readonly projectStore: ProjectStore,
		private readonly projectRootPath: (project: Project) => string,
	) {}

	async resolveRepository(target: ProjectFileTarget): Promise<GitRepositoryContext> {
		const normalizedTarget = parseProjectFileTarget(target);
		const project = this.projectStore.get(normalizedTarget.projectId);
		if (!project) throw new Error("PROJECT_NOT_FOUND");
		const boundary = await createProjectFileReadBoundary(this.projectRootPath(project));
		const repoPath = resolve(boundary.canonicalRoot, normalizedTarget.relativePath);
		const repoRoot = await resolveProjectFileReadPath(boundary, repoPath);
		if (!(await stat(repoRoot)).isDirectory()) throw new Error("GIT_REPOSITORY_TARGET_NOT_DIRECTORY");
		return { projectId: normalizedTarget.projectId, projectRoot: boundary.canonicalRoot, repoRoot, repoTarget: normalizedTarget };
	}

	async resolveFilePath(target: ProjectFileTarget): Promise<string> {
		const normalizedTarget = parseProjectFileTarget(target);
		const root = await this.resolveRepository({ projectId: normalizedTarget.projectId, relativePath: "" });
		return resolve(root.projectRoot, normalizedTarget.relativePath);
	}

	async listRepositories(rootTarget: ProjectFileTarget): Promise<GitRepoInfo[]> {
		const normalizedTarget = parseProjectFileTarget(rootTarget);
		const context = await this.resolveRepository(normalizedTarget);
		if (normalizedTarget.relativePath !== "") throw new Error("GIT_REPOSITORY_LIST_REQUIRES_PROJECT_ROOT");
		const repositories = await listGitRepos(context.projectRoot);
		return repositories.map((repository) => ({
			target: { projectId: normalizedTarget.projectId, relativePath: repository.relativePath },
			relativePath: repository.relativePath,
			displayPath: repository.relativePath,
			name: repository.name,
			path: repository.path,
		}));
	}
}

/** Selects local Git only; an SSH locator must never fall through to host Git or cwd. */
export class GitBackendRouter {
	constructor(
		private readonly localBackend: GitBackend,
		private readonly projectStore: ProjectStore,
	) {}

	forLocator(locator: ProjectLocator): GitBackend {
		if (locator.kind === "ssh") throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		return this.localBackend;
	}

	forProject(projectId: string): GitBackend {
		const project = this.projectStore.get(projectId);
		if (!project) throw new Error("PROJECT_NOT_FOUND");
		return this.forLocator(projectLocatorFromLegacy(project));
	}
}

export function resolveRelativeGitPath(root: string, targetPath: string): string {
	const value = relative(root, targetPath).replace(/\\/g, "/");
	if (value === ".." || value.startsWith("../") || value.startsWith("/")) throw new Error("GIT_PATH_OUTSIDE_PROJECT");
	return value;
}
