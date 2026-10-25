import { readdir } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GitRepoInfo } from "../../shared/types";

/** 扫描嵌套仓库时跳过的构建/依赖目录，避免把依赖里的 .git 当成用户仓库。 */
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "dist", "out", "build", ".next", "target", "vendor", "__pycache__", ".venv", "venv", "coverage"]);

/** 相对项目根最多向下 4 层：覆盖 packages/* 与少量 monorepo 分组，避免扫整盘。 */
export const GIT_REPO_SCAN_MAX_DEPTH = 4;
/** 单项目仓库上限，防止异常目录树拖垮 IPC。 */
export const GIT_REPO_SCAN_MAX_REPOS = 50;

function normalizeForCompare(value: string): string {
	const resolved = resolve(value);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** 判断 candidate 是否落在 projectPath 之内（含自身）。Windows 忽略盘符大小写。 */
export function isPathInsideProject(projectPath: string, candidate: string): boolean {
	const root = normalizeForCompare(projectPath);
	const target = normalizeForCompare(candidate);
	if (target === root) return true;
	const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
	return target.startsWith(prefix);
}

/**
 * 将渲染层传入的可选 repoPath 收成安全 cwd。
 * 未传时沿用项目根（旧调用方行为不变）；传入时必须落在项目目录内，防止路径逃逸。
 */
export function resolveGitCwd(projectPath: string, repoPath?: unknown): string {
	const projectRoot = resolve(projectPath);
	if (repoPath == null || repoPath === "") return projectRoot;
	if (typeof repoPath !== "string" || !repoPath.trim()) {
		throw new Error("Invalid git repository path");
	}
	const trimmed = repoPath.trim();
	const resolved = isAbsolute(trimmed) ? resolve(trimmed) : resolve(projectRoot, trimmed);
	if (!isPathInsideProject(projectRoot, resolved)) {
		throw new Error("Git repository is outside the project");
	}
	return resolved;
}

function toRepoInfo(projectRoot: string, repoPath: string): GitRepoInfo {
	const rel = relative(projectRoot, repoPath);
	const relativePath = rel === "" ? "" : rel.split(/[\\/]/).join("/");
	return {
		path: repoPath,
		name: relativePath === "" ? basename(projectRoot) : basename(repoPath),
		relativePath,
	};
}

/**
 * 在项目目录内发现独立 Git 仓库（目录或 gitfile 形式的 .git）。
 * 找到仓库后仍继续向下扫：VS Code 同款，支持根仓库 + packages/* 各自独立仓库。
 */
export async function listGitRepos(projectPath: string): Promise<GitRepoInfo[]> {
	const projectRoot = resolve(projectPath);
	const found: GitRepoInfo[] = [];

	const walk = async (dir: string, depth: number): Promise<void> => {
		if (found.length >= GIT_REPO_SCAN_MAX_REPOS) return;
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		if (entries.some((entry) => entry.name === ".git")) {
			found.push(toRepoInfo(projectRoot, dir));
			if (found.length >= GIT_REPO_SCAN_MAX_REPOS) return;
		}
		if (depth >= GIT_REPO_SCAN_MAX_DEPTH) return;
		const children = entries.filter((entry) => {
			if (!entry.isDirectory()) return false;
			if (SKIP_DIR_NAMES.has(entry.name)) return false;
			// 隐藏目录几乎不会是用户仓库，跳过以免扫 .cache 等。
			if (entry.name.startsWith(".")) return false;
			return true;
		});
		await Promise.all(children.map((entry) => walk(join(dir, entry.name), depth + 1)));
	};

	await walk(projectRoot, 0);
	found.sort((left, right) => {
		if (left.relativePath === "") return -1;
		if (right.relativePath === "") return 1;
		return left.relativePath.localeCompare(right.relativePath);
	});
	return found;
}
