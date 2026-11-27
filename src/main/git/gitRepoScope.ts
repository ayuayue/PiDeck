import { readdir } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runGitCommand } from "./gitRun.ts";
import type { LocalGitRepoInfo } from "./localGitTypes";

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

function toRepoInfo(projectRoot: string, repoPath: string): LocalGitRepoInfo {
	const rel = relative(projectRoot, repoPath);
	const relativePath = rel === "" ? "" : rel.split(/[\\/]/).join("/");
	return {
		path: repoPath,
		name: relativePath === "" ? basename(projectRoot) : basename(repoPath),
		relativePath,
	};
}

/** 同一层按工作树批量询问 Git，先剪枝再 readdir，避免按目录启动子进程。 */
async function unignoredDirectories(cwd: string, directories: string[]): Promise<string[]> {
	// ./ 让以冒号开头的目录名也作为字面路径；保留索引判定，已跟踪的子模块应可见。
	const paths = directories.map((dir) => `./${relative(cwd, dir).split(sep).join("/")}`);
	try {
		const { stdout } = await runGitCommand(["check-ignore", "-z", "--stdin"], {
			cwd,
			input: paths.join("\0") + "\0",
			allowExitCodes: [1],
			timeoutMs: 5_000,
		});
		const ignored = new Set(stdout.split("\0"));
		return directories.filter((_, index) => !ignored.has(paths[index]));
	} catch {
		// 普通目录也可以作为多个仓库的容器；Git 无法判定时继续发现子仓库。
		return directories;
	}
}

/**
 * 在项目目录内发现独立 Git 仓库（目录或 gitfile 形式的 .git）。
 * 找到仓库后仍继续向下扫：VS Code 同款，支持根仓库 + packages/* 各自独立仓库。
 */
export async function listGitRepos(projectPath: string): Promise<LocalGitRepoInfo[]> {
	const projectRoot = resolve(projectPath);
	const found: LocalGitRepoInfo[] = [];

	let level = [{ dir: projectRoot, worktree: projectRoot }];
	for (let depth = 0; level.length > 0 && depth <= GIT_REPO_SCAN_MAX_DEPTH; depth++) {
		const childrenByWorktree = new Map<string, string[]>();
		await Promise.all(
			level.map(async ({ dir, worktree }) => {
				let entries;
				try {
					entries = await readdir(dir, { withFileTypes: true });
				} catch {
					return;
				}
				if (found.length >= GIT_REPO_SCAN_MAX_REPOS) return;
				if (entries.some((entry) => entry.name === ".git")) {
					found.push(toRepoInfo(projectRoot, dir));
					worktree = dir;
				}
				if (depth === GIT_REPO_SCAN_MAX_DEPTH) return;
				const children = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !SKIP_DIR_NAMES.has(entry.name));
				if (children.length === 0) return;
				const group = childrenByWorktree.get(worktree) ?? [];
				for (const entry of children) group.push(join(dir, entry.name));
				childrenByWorktree.set(worktree, group);
			}),
		);
		if (found.length >= GIT_REPO_SCAN_MAX_REPOS) break;
		const groups = await Promise.all(
			Array.from(childrenByWorktree, async ([worktree, children]) => {
				const visible = await unignoredDirectories(worktree, children);
				return visible.map((dir) => ({ dir, worktree }));
			}),
		);
		level = groups.flat();
	}
	found.sort((left, right) => {
		if (left.relativePath === "") return -1;
		if (right.relativePath === "") return 1;
		return left.relativePath.localeCompare(right.relativePath);
	});
	return found;
}
