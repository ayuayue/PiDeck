import type { Project, WorktreeEntry } from "../../../../shared/types";

export type WorkspaceTreeRow = {
	key: string;
	path: string;
	branch: string;
	directory: string;
	project?: Project;
};

/**
 * 归一化 worktree 路径作为 UI 身份：Git 可能返回反斜杠，而项目目录来自
 * settings；Windows 路径还不区分大小写。统一身份后才能避免同一个工作区出现两行。
 */
export function normalizeWorkspacePath(path: string): string {
	const raw = path.trim();
	const isUncPath = /^[\\/]{2}/.test(raw);
	const normalized = raw.replace(/[\\/]+/g, "/").replace(/\/$/, "") || "/";
	const isWindowsPath = /^[A-Za-z]:\//.test(normalized) || isUncPath;
	return isWindowsPath ? normalized.toLowerCase() : normalized;
}

export function getWorkspaceDirectory(path: string): string {
	const normalized = path.replace(/[\\/]+$/, "");
	return normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

/** 将 Git 的内部 ref 前缀从用户可见分支名中移除，避免出现 pideck/T6 这类实现细节。 */
export function formatWorkspaceBranch(branch: string, path: string): string {
	const cleanBranch = branch
		.trim()
		.replace(/^refs\/heads\//, "")
		.replace(/^pideck\//, "");
	return cleanBranch || getWorkspaceDirectory(path);
}

/**
 * 合并 Git worktree 列表和项目目录列表。Git 是运行时来源，Project 是持久化来源；
 * 两者按规范化路径合并，保留 Git 顺序，并把可操作的 child project 绑定到同一行。
 */
export function mergeWorkspaceTreeRows(entries: readonly WorktreeEntry[], childProjects: readonly Project[]): WorkspaceTreeRow[] {
	const rows: WorkspaceTreeRow[] = [];
	const byKey = new Map<string, WorkspaceTreeRow>();

	const add = (path: string, branch: string, project?: Project) => {
		const trimmedPath = path.trim();
		if (!trimmedPath) return;
		const key = normalizeWorkspacePath(trimmedPath);
		const existing = byKey.get(key);
		if (existing) {
			existing.project = project ?? existing.project;
			if (!existing.branch || existing.branch === existing.directory) {
				existing.branch = formatWorkspaceBranch(branch, trimmedPath);
			}
			return;
		}
		const row: WorkspaceTreeRow = {
			key,
			path: trimmedPath,
			branch: formatWorkspaceBranch(branch, trimmedPath),
			directory: getWorkspaceDirectory(trimmedPath),
			project,
		};
		byKey.set(key, row);
		rows.push(row);
	};

	for (const entry of entries) add(entry.path, entry.branch);
	for (const project of childProjects) add(project.path, project.name, project);
	return rows;
}
