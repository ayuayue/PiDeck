import type { Project, ProjectFileTarget, WorktreeEntry } from "../../../../shared/types";

export type WorkspaceTreeRow = {
	key: string;
	target: ProjectFileTarget;
	displayPath: string;
	branch: string;
	directory: string;
	project?: Project;
};

export function getWorkspaceDirectory(path: string): string {
	const normalized = path.replace(/[\\/]+$/, "");
	return normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** 将 Git 内部 ref 前缀从用户可见分支名中移除。 */
export function formatWorkspaceBranch(branch: string, displayPath: string): string {
	const cleanBranch = branch
		.trim()
		.replace(/^refs\/heads\//, "")
		.replace(/^pideck\//, "");
	return cleanBranch || getWorkspaceDirectory(displayPath);
}

/** Merge Git's worktree listing with child projects using their stable project identities. */
export function mergeWorkspaceTreeRows(entries: readonly WorktreeEntry[], childProjects: readonly Project[]): WorkspaceTreeRow[] {
	const rows: WorkspaceTreeRow[] = [];
	const byProjectId = new Map<string, WorkspaceTreeRow>();

	const add = (target: ProjectFileTarget, displayPath: string, branch: string, project?: Project) => {
		const trimmedDisplayPath = displayPath.trim();
		if (!target.projectId) return;
		const existing = byProjectId.get(target.projectId);
		if (existing) {
			existing.project = project ?? existing.project;
			if (project) existing.displayPath = project.path;
			if (!existing.branch || existing.branch === existing.directory) {
				existing.branch = formatWorkspaceBranch(branch, existing.displayPath);
			}
			return;
		}
		const row: WorkspaceTreeRow = {
			key: target.projectId,
			target,
			displayPath: project?.path ?? trimmedDisplayPath,
			branch: formatWorkspaceBranch(branch, trimmedDisplayPath),
			directory: getWorkspaceDirectory(project?.path ?? trimmedDisplayPath),
			project,
		};
		byProjectId.set(target.projectId, row);
		rows.push(row);
	};

	for (const entry of entries) add(entry.target, entry.displayPath, entry.branch);
	for (const project of childProjects) add({ projectId: project.id, relativePath: "" }, project.path, project.name, project);
	return rows;
}
