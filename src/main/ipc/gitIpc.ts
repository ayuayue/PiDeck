import { app, dialog, ipcMain, type BrowserWindow } from "electron";
import { relative, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { ipcChannels } from "../../shared/ipc";
import type {
	CommitDetail,
	GitChangedFile,
	GitCommitFileDiff,
	GitCompareRefsResult,
	GitDiscardResource,
	GitGenerateCommitMessageResult,
	GitHistoryPageResult,
	GitRepoInfo,
	GitRepositoryListResult,
	GitResource,
	GitRef,
	GitRecoveryListing,
	GitResourceGroups,
	GitWorkspaceDiffGroup,
	GitWorkspaceFileDiff,
	LocalProject,
	ProjectFileTarget,
	WorktreeEntry,
} from "../../shared/types";
import { isLocalProject, isRemoteProject } from "../../shared/projectLocation";
import { codeOf, opFailFromCode, opOk } from "../../shared/op";
import type { RemoteGitReadIpc } from "./remoteGitReadIpc";
import { createProjectGitHandler } from "./gitProjectHandlers";
import { dropRecovery, listRecovery, restoreRecovery } from "../git/LocalGitRecovery";
import { registerGitCommitMessageIpc } from "./gitCommitMessageIpc";
import { registerGitRecoveryIpc } from "./gitRecoveryIpc";
import { parseProjectFileTarget } from "../files/projectFileTarget";
import { GitBackendRouter, LocalGitBackend, resolveRelativeGitPath, type GitBackend, type GitRepositoryContext } from "../git/GitBackend";
import type { LocalGitChangedFile, LocalGitCommitDetail, LocalGitCommitFileDiff, LocalGitResource, LocalGitResourceGroups, LocalGitWorkspaceFileDiff, LocalWorktreeEntry } from "../git/localGitTypes";
import type { GitService } from "../git/GitService";
import type { GitRefsWatcher } from "../git/GitRefsWatcher";
import { detectGitExecutable } from "../git/gitExecutable";
import { listGitRepos, resolveGitCwd } from "../git/gitRepoScope";
import type { AppLogger } from "../logging/AppLogger";
import type { PiLocator } from "../pi/PiLocator";
import { PiRpcClient } from "../pi/PiRpcClient";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SettingsStore } from "../settings/SettingsStore";
import type { WorktreeService } from "../git/WorktreeService";
import { normalizeSelectedWslProjectPath, parseWslUncPath, toWindowsHostPath, toWslLinuxPath } from "../wsl/WslPaths";
import { applyPiProxyModeWithProvider, computeGenProxyKey } from "../sessions/sessionProxyPolicy";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type GitIpcDeps = {
	appLogger: Pick<AppLogger, "warn" | "info" | "error">;
	mainCopy: (key: string, params?: Record<string, string | number>) => string;
	gitService: GitService;
	/** refs 变化监听：面板订阅后由主进程推送，push/commit 后角标秒级跟平 */
	gitRefsWatcher: GitRefsWatcher;
	/** refs 变化推送需要发往主窗口（宠物窗等其它窗口不订阅） */
	getMainWindow: () => BrowserWindow | null;
	piLocator: PiLocator;
	projectStore: ProjectStore;
	settingsStore: SettingsStore;
	worktreeService: WorktreeService;
	/** Optional only for local-only callers/tests; SSH reads must never fall back to GitService. */
	remoteGitReads?: Pick<RemoteGitReadIpc, "status" | "workspaceDiff" | "stagedDiff" | "listRepositories" | "repositoryListing" | "historyPage" | "compareRefs" | "refs">;
};

// ── IPC 注册 ────────────────────────────────────────────────────────

export function registerGitIpc({ appLogger, mainCopy, gitService, gitRefsWatcher, getMainWindow, piLocator, projectStore, settingsStore, worktreeService, remoteGitReads }: GitIpcDeps): void {
	// 第 12 步 Wave 4：WSL 项目优先用档案 distro；缺字段回退全局。
	const hostPath = (path: string, project?: LocalProject): string => {
		const settings = settingsStore.get();
		const distro = project?.environment === "wsl" ? (project.wslDistro ?? settings.wslDistro) : undefined;
		if (process.platform !== "win32" || !distro || (!path.startsWith("/") && !parseWslUncPath(path))) {
			return path;
		}
		return toWindowsHostPath(path, { distro });
	};
	const projectHostPath = (project: LocalProject) => hostPath(project.path, project);
	const gitBackendRouter = new GitBackendRouter(new LocalGitBackend(projectStore, projectHostPath), projectStore);
	const handleProjectGit = createProjectGitHandler(ipcMain, projectStore, settingsStore);
	/** worktree 相关 handler 的入口：解析 store 中的本地项目，远端拒绝。 */
	const requireLocalProject = (projectId: string): LocalProject => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error("PROJECT_NOT_FOUND");
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		return project;
	};
	const projectStoredPath = (path: string, project: LocalProject) => {
		const settings = settingsStore.get();
		const distro = project.wslDistro ?? settings.wslDistro;
		if (process.platform !== "win32" || project.environment !== "wsl" || !distro) {
			return path;
		}
		return normalizeSelectedWslProjectPath(path, { distro });
	};

	const projectTargetFromLocalPath = (projectId: string, path: unknown): ProjectFileTarget => {
		if (typeof path !== "string" || !path.trim() || path.length > 32_768 || path.includes("\\0")) throw new Error("INVALID_GIT_FILE_TARGET");
		const project = projectStore.get(projectId);
		if (!project) throw new Error("PROJECT_NOT_FOUND");
		// 本地 Git 目标解析不接受远端项目：它没有本机 root。
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const root = resolve(projectHostPath(project));
		const localPath = resolveGitCwd(root, hostPath(path));
		return parseProjectFileTarget({ projectId, relativePath: relative(root, localPath).replace(/\\/g, "/") });
	};
	const parseGitProjectTarget = (projectId: string, value: unknown): ProjectFileTarget => {
		const target = typeof value === "string" ? projectTargetFromLocalPath(projectId, value) : parseProjectFileTarget(value);
		if (target.projectId !== projectId) throw new Error("GIT_PROJECT_TARGET_MISMATCH");
		return target;
	};

	const parseGitRepositoryTarget = (projectId: string, value?: unknown): ProjectFileTarget => {
		if (value === undefined || value === null || value === "") return { projectId, relativePath: "" };
		return parseGitProjectTarget(projectId, value);
	};

	const requireGitRepository = async (projectId: string, rawRepoTarget?: unknown): Promise<GitRepositoryContext> => {
		const target = parseGitRepositoryTarget(projectId, rawRepoTarget);
		return gitBackendRouter.forProject(projectId).resolveRepository(target);
	};

	const findGitRepository = async (projectId: string, rawRepoTarget?: unknown): Promise<GitRepositoryContext | null> => {
		if (!projectStore.get(projectId)) return null;
		try {
			return await requireGitRepository(projectId, rawRepoTarget);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	};

	const requireGitCwd = async (projectId: string, repoTarget?: unknown): Promise<string> => (await requireGitRepository(projectId, repoTarget)).repoRoot;
	const findGitCwd = async (projectId: string, repoTarget?: unknown): Promise<string | null> => (await findGitRepository(projectId, repoTarget))?.repoRoot ?? null;

	const parseGitFileTargets = (projectId: string, value: unknown): ProjectFileTarget[] => {
		if (!Array.isArray(value) || value.length > 1000) throw new Error("INVALID_GIT_FILE_TARGETS");
		return value.map((entry) => parseGitProjectTarget(projectId, entry));
	};

	const localFilePaths = (backend: GitBackend, targets: ProjectFileTarget[]) => Promise.all(targets.map((target) => backend.resolveFilePath(target)));
	const targetForAbsolutePath = (context: GitRepositoryContext, path: string): ProjectFileTarget => parseProjectFileTarget({ projectId: context.projectId, relativePath: resolveRelativeGitPath(context.projectRoot, path) });
	const decorateResource = (context: GitRepositoryContext, resource: LocalGitResource): GitResource => {
		const target = targetForAbsolutePath(context, resource.path);
		const oldTarget = resource.oldPath ? targetForAbsolutePath(context, resource.oldPath) : undefined;
		return {
			path: target.relativePath,
			target,
			displayPath: target.relativePath,
			status: resource.status,
			letter: resource.letter,
			...(oldTarget ? { oldPath: oldTarget.relativePath, oldTarget } : {}),
		};
	};
	const decorateResourceGroups = (context: GitRepositoryContext, groups: LocalGitResourceGroups): GitResourceGroups => ({
		merge: groups.merge.map((resource) => decorateResource(context, resource)),
		index: groups.index.map((resource) => decorateResource(context, resource)),
		workingTree: groups.workingTree.map((resource) => decorateResource(context, resource)),
		untracked: groups.untracked.map((resource) => decorateResource(context, resource)),
	});
	const projectTargetFromRepoPath = (context: GitRepositoryContext, repoPath: string): ProjectFileTarget => parseProjectFileTarget({ projectId: context.projectId, relativePath: [context.repoTarget.relativePath, repoPath].filter(Boolean).join("/") });
	const decorateChangedFile = (context: GitRepositoryContext, file: LocalGitChangedFile): GitChangedFile => {
		const target = projectTargetFromRepoPath(context, file.path);
		const originalTarget = file.originalPath ? projectTargetFromRepoPath(context, file.originalPath) : undefined;
		return {
			path: target.relativePath,
			target,
			displayPath: target.relativePath,
			status: file.status,
			...(originalTarget ? { originalPath: originalTarget.relativePath, originalTarget } : {}),
		};
	};
	const decorateCommitDetail = (context: GitRepositoryContext, detail: LocalGitCommitDetail | null): CommitDetail | null => (detail ? { commit: detail.commit, files: detail.files.map((file) => decorateChangedFile(context, file)) } : null);
	const decorateBranchDiff = (context: GitRepositoryContext, result: { files: LocalGitChangedFile[]; ahead: number; behind: number }) => ({
		...result,
		files: result.files.map((file) => decorateChangedFile(context, file)),
	});
	const decorateCommitFileDiff = (context: GitRepositoryContext, diff: LocalGitCommitFileDiff | null): GitCommitFileDiff | null => {
		if (!diff) return null;
		const target = projectTargetFromRepoPath(context, diff.path);
		const originalTarget = diff.originalPath ? projectTargetFromRepoPath(context, diff.originalPath) : undefined;
		return {
			path: target.relativePath,
			target,
			displayPath: target.relativePath,
			...(originalTarget ? { originalPath: originalTarget.relativePath, originalTarget } : {}),
			originalContent: diff.originalContent,
			modifiedContent: diff.modifiedContent,
		};
	};
	const repoRelativePathForTarget = async (context: GitRepositoryContext, backend: GitBackend, target: ProjectFileTarget): Promise<string> => {
		if (target.projectId !== context.projectId) throw new Error("GIT_PROJECT_TARGET_MISMATCH");
		const path = await backend.resolveFilePath(target);
		const relativePath = resolveRelativeGitPath(context.repoRoot, path);
		if (!relativePath) throw new Error("GIT_FILE_TARGET_MUST_NOT_BE_REPOSITORY_ROOT");
		return relativePath;
	};
	type ParsedGitHistoryOptions = { maxEntries?: number; ref?: string; path?: ProjectFileTarget; allBranches?: boolean };
	const parseGitHistoryOptions = (projectId: string, value: unknown, includeMaxEntries: boolean): ParsedGitHistoryOptions | undefined => {
		if (value === undefined) return undefined;
		if (!isRecord(value)) throw new Error("INVALID_GIT_HISTORY_OPTIONS");
		const options = value;
		const allowed = includeMaxEntries ? ["maxEntries", "ref", "path", "allBranches"] : ["ref", "path", "allBranches"];
		if (Object.keys(options).some((key) => !allowed.includes(key))) throw new Error("INVALID_GIT_HISTORY_OPTIONS");
		const rawMaxEntries = options.maxEntries;
		if (includeMaxEntries && rawMaxEntries !== undefined && (typeof rawMaxEntries !== "number" || !Number.isInteger(rawMaxEntries) || rawMaxEntries < 1 || rawMaxEntries > 500)) {
			throw new Error("INVALID_GIT_HISTORY_OPTIONS");
		}
		const rawRef = options.ref;
		if (rawRef !== undefined && (typeof rawRef !== "string" || !rawRef.trim() || rawRef.length > 512)) throw new Error("INVALID_GIT_HISTORY_OPTIONS");
		const rawPath = options.path;
		if (options.allBranches !== undefined && typeof options.allBranches !== "boolean") throw new Error("INVALID_GIT_HISTORY_OPTIONS");
		return {
			...(includeMaxEntries && typeof rawMaxEntries === "number" ? { maxEntries: rawMaxEntries } : {}),
			...(typeof rawRef === "string" ? { ref: rawRef } : {}),
			...(rawPath !== undefined ? { path: parseGitProjectTarget(projectId, rawPath) } : {}),
			...(typeof options.allBranches === "boolean" ? { allBranches: options.allBranches } : {}),
		};
	};
	const localGitHistoryOptions = async (context: GitRepositoryContext, backend: GitBackend, options: ParsedGitHistoryOptions | undefined): Promise<{ maxEntries?: number; ref?: string; path?: string; allBranches?: boolean } | undefined> => {
		if (!options) return undefined;
		const path = options.path ? await repoRelativePathForTarget(context, backend, options.path) : undefined;
		return {
			...(options.maxEntries !== undefined ? { maxEntries: options.maxEntries } : {}),
			...(options.ref !== undefined ? { ref: options.ref } : {}),
			...(path !== undefined ? { path } : {}),
			...(options.allBranches !== undefined ? { allBranches: options.allBranches } : {}),
		};
	};

	/** 公共历史页选项：分页必选语义；本地过滤器（ref/path/allBranches）保留，远端只接受分页两项。 */
	type ParsedHistoryPageOptions = { maxCount: number; skip: number; ref?: string; path?: ProjectFileTarget; allBranches?: boolean; withTotal?: boolean };
	const parseHistoryPageOptions = (projectId: string, value: unknown): ParsedHistoryPageOptions => {
		if (value === undefined) return { maxCount: 50, skip: 0 };
		if (!isRecord(value)) throw new Error("INVALID_GIT_HISTORY_OPTIONS");
		if (Object.keys(value).some((key) => !["maxCount", "skip", "ref", "path", "allBranches", "withTotal"].includes(key))) throw new Error("INVALID_GIT_HISTORY_OPTIONS");
		const maxCount = value.maxCount ?? 50;
		if (typeof maxCount !== "number" || !Number.isSafeInteger(maxCount) || maxCount < 1 || maxCount > 500) throw new Error("INVALID_GIT_HISTORY_OPTIONS");
		const skip = value.skip ?? 0;
		if (typeof skip !== "number" || !Number.isSafeInteger(skip) || skip < 0 || skip > 100_000) throw new Error("INVALID_GIT_HISTORY_OPTIONS");
		const ref = value.ref;
		if (ref !== undefined && (typeof ref !== "string" || !ref.trim() || ref.length > 512)) throw new Error("INVALID_GIT_HISTORY_OPTIONS");
		if (value.allBranches !== undefined && typeof value.allBranches !== "boolean") throw new Error("INVALID_GIT_HISTORY_OPTIONS");
		if (value.withTotal !== undefined && typeof value.withTotal !== "boolean") throw new Error("INVALID_GIT_HISTORY_OPTIONS");
		return {
			maxCount,
			skip,
			...(typeof ref === "string" ? { ref } : {}),
			...(value.path !== undefined ? { path: parseGitProjectTarget(projectId, value.path) } : {}),
			...(typeof value.allBranches === "boolean" ? { allBranches: value.allBranches } : {}),
			...(typeof value.withTotal === "boolean" ? { withTotal: value.withTotal } : {}),
		};
	};

	let localRepositoryListingRevision = 0;

	/** 公共仓库列表（T7）：本地不截断（truncated=false），远端保留 helper 的 truncated。 */
	handleProjectGit(ipcChannels.gitRepositoryList, async (event, projectId: string): Promise<GitRepositoryListResult> => {
		if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 256) return opFailFromCode("INVALID_PROJECT_ID");
		const located = projectStore.get(projectId);
		if (located && isRemoteProject(located)) {
			if (!remoteGitReads) return opFailFromCode("UNSUPPORTED_CAPABILITY");
			return remoteGitReads.repositoryListing(event, projectId);
		}
		if (!located) return opFailFromCode("PROJECT_NOT_FOUND");
		try {
			const repos = await gitBackendRouter.forProject(projectId).listRepositories({ projectId, relativePath: "" });
			localRepositoryListingRevision += 1;
			return opOk({ repos, truncated: false, revision: localRepositoryListingRevision, generation: "local" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				localRepositoryListingRevision += 1;
				return opOk({ repos: [], truncated: false, revision: localRepositoryListingRevision, generation: "local" });
			}
			return opFailFromCode(codeOf(error, "GIT_COMMAND_FAILED"));
		}
	});

	/** 公共历史页（T7）：本地保留 ref/path/allBranches 与 totalCount；远端 HEAD-only 且无总数。 */
	handleProjectGit(ipcChannels.gitHistoryPage, async (event, projectId: string, rawOptions?: unknown, repoPath?: unknown): Promise<GitHistoryPageResult> => {
		if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 256) return opFailFromCode("INVALID_PROJECT_ID");
		let options: ParsedHistoryPageOptions;
		try {
			options = parseHistoryPageOptions(projectId, rawOptions);
		} catch (error) {
			return opFailFromCode(codeOf(error, "INVALID_GIT_HISTORY_OPTIONS"));
		}
		const located = projectStore.get(projectId);
		if (located && isRemoteProject(located)) {
			if (!remoteGitReads) return opFailFromCode("UNSUPPORTED_CAPABILITY");
			// helper 没有 path 过滤：拒绝而不是静默吞参数；ref/all/总数有对应 helper 参数。
			if (options.path !== undefined) return opFailFromCode("UNSUPPORTED_CAPABILITY");
			return remoteGitReads.historyPage(
				event,
				projectId,
				{
					maxCount: options.maxCount,
					skip: options.skip,
					...(options.ref === undefined ? {} : { ref: options.ref }),
					...(options.allBranches === undefined ? {} : { all: options.allBranches }),
					...(options.withTotal === true ? { withCount: true } : {}),
				},
				repoPath,
			);
		}
		if (!located) return opFailFromCode("PROJECT_NOT_FOUND");
		try {
			const context = await findGitRepository(projectId, repoPath);
			if (!context) return opOk({ commits: [], hasMore: false, totalCount: 0 });
			const backend = gitBackendRouter.forProject(projectId);
			const localOptions = await localGitHistoryOptions(context, backend, { maxEntries: options.maxCount, ...(options.ref === undefined ? {} : { ref: options.ref }), ...(options.path === undefined ? {} : { path: options.path }), ...(options.allBranches === undefined ? {} : { allBranches: options.allBranches }) });
			const totalCount = await gitService.getCommitCount(context.repoRoot, { ...(localOptions?.ref === undefined ? {} : { ref: localOptions.ref }), ...(localOptions?.path === undefined ? {} : { path: localOptions.path }), ...(localOptions?.allBranches === undefined ? {} : { allBranches: localOptions.allBranches }) });
			const entries = await gitService.getCommitLog(context.repoRoot, { ...localOptions, maxEntries: options.maxCount, skip: options.skip });
			const commits = entries.slice(0, options.maxCount).map((entry) => ({
				oid: entry.hash,
				parents: entry.parents,
				subject: entry.message,
				authorName: entry.authorName,
				authorEmail: entry.authorEmail,
				authorTimeMs: entry.authorDate,
				shortHash: entry.shortHash,
				refNames: entry.refNames,
				graph: entry.graph,
				...(entry.fullMessage === undefined ? {} : { fullMessage: entry.fullMessage }),
			}));
			return opOk({ commits, hasMore: totalCount > options.skip + commits.length, totalCount });
		} catch (error) {
			return opFailFromCode(codeOf(error, "GIT_COMMAND_FAILED"));
		}
	});

	/** 公共比较（T7）：本地固定三点（merge-base）；远端按 `mode` 决定两树或三点。 */
	handleProjectGit(ipcChannels.gitCompareRefs, async (event, projectId: string, base: unknown, head: unknown, repoPath?: unknown, mode?: unknown): Promise<GitCompareRefsResult> => {
		if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 256) return opFailFromCode("INVALID_PROJECT_ID");
		if (typeof base !== "string" || base.length === 0 || base.length > 512 || typeof head !== "string" || head.length === 0 || head.length > 512) return opFailFromCode("INVALID_GIT_HISTORY_OPTIONS");
		if (mode !== undefined && mode !== "trees" && mode !== "threeDot") return opFailFromCode("INVALID_GIT_HISTORY_OPTIONS");
		const located = projectStore.get(projectId);
		if (located && isRemoteProject(located)) {
			if (!remoteGitReads) return opFailFromCode("UNSUPPORTED_CAPABILITY");
			return remoteGitReads.compareRefs(event, projectId, base, head, repoPath, mode);
		}
		if (!located) return opFailFromCode("PROJECT_NOT_FOUND");
		try {
			const context = await requireGitRepository(projectId, repoPath);
			const [baseOid, headOid] = await Promise.all([gitService.resolveRefOid(context.repoRoot, base), gitService.resolveRefOid(context.repoRoot, head)]);
			if (!baseOid || !headOid) return opFailFromCode("GIT_REF_NOT_FOUND");
			const diff = await gitService.compareBranches(context.repoRoot, base, head);
			return opOk({
				mode: "merge-base",
				base: { ref: base, oid: baseOid },
				head: { ref: head, oid: headOid },
				files: diff.files.map((file) => ({ status: file.status, path: file.path, ...(file.originalPath === undefined ? {} : { oldPath: file.originalPath }) })),
				ahead: diff.ahead,
				behind: diff.behind,
			});
		} catch (error) {
			return opFailFromCode(codeOf(error, "GIT_COMMAND_FAILED"));
		}
	});

	// Scan repositories through the same local-only boundary used by every Git operation.
	handleProjectGit(ipcChannels.gitListRepos, async (event, projectId: string) => {
		if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 256) throw new Error("INVALID_PROJECT_ID");
		if (!projectStore.get(projectId)) return [];
		// W4：同一条通道也服务 ssh 项目（远端结果映射成与本地同形的 GitRepoInfo[]），
		// 上层不必为「位置」写第二个分支。
		const located = projectStore.get(projectId);
		if (located && isRemoteProject(located)) {
			if (!remoteGitReads) throw new Error("UNSUPPORTED_CAPABILITY");
			return remoteGitReads.listRepositories(event, projectId);
		}
		try {
			return await gitBackendRouter.forProject(projectId).listRepositories({ projectId, relativePath: "" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	});

	handleProjectGit(ipcChannels.gitBranches, async (_event, projectId: string, repoPath?: unknown) => {
		return gitService.getBranches(await requireGitCwd(projectId, repoPath));
	});

	handleProjectGit(ipcChannels.gitCheckout, async (_event, projectId: string, branch: string, repoPath?: unknown) => {
		const cwd = await requireGitCwd(projectId, repoPath);
		const result = await gitService.checkout(cwd, branch);
		// 切换分支可能覆盖未提交的工作区改动：记 warn 审计日志，排查"文件消失"时能定位到切换动作。
		void appLogger.warn("git", "Branch checked out", { projectId, branch, repoPath: cwd, changed: result });
		return result;
	});

	handleProjectGit(ipcChannels.gitCreateBranch, async (_event, projectId: string, branchName: string, repoPath?: unknown) => {
		return gitService.createBranch(await requireGitCwd(projectId, repoPath), branchName);
	});

	// Diff 基准只接受 project target，避免 renderer 提供任意主机路径交给 Git 子进程。
	handleProjectGit(ipcChannels.gitOriginalContent, async (_event, rawTarget: unknown) => {
		const target = parseProjectFileTarget(rawTarget);
		const backend = gitBackendRouter.forProject(target.projectId);
		const filePath = await backend.resolveFilePath(target);
		const maxBytes = Math.max(1, settingsStore.get().maxEditorFileSizeMB) * 1024 * 1024;
		return gitService.getOriginalContent(filePath, maxBytes);
	});

	handleProjectGit(ipcChannels.gitWorktreeList, async (_event, projectId: string): Promise<WorktreeEntry[]> => {
		const project = requireLocalProject(projectId);
		const rootTarget = { projectId, relativePath: "" };
		const repository = await requireGitRepository(projectId, rootTarget);
		const entries = await worktreeService.list(repository.projectRoot);
		const result: WorktreeEntry[] = [];
		for (const entry of entries) {
			const storedPath = projectStoredPath(entry.path, project);
			const child = await projectStore.add(storedPath, projectId, project.environment === "wsl" ? "wsl" : "windows");
			result.push({
				target: { projectId: child.id, relativePath: "" },
				branch: entry.branch,
				displayPath: storedPath,
				path: storedPath,
			});
		}
		return result;
	});

	handleProjectGit(ipcChannels.gitWorktreeCreate, async (_event, projectId: string, branchName: string): Promise<WorktreeEntry> => {
		const project = requireLocalProject(projectId);
		const repository = await requireGitRepository(projectId, { projectId, relativePath: "" });
		const info = await worktreeService.create(repository.projectRoot, projectId, branchName);
		const storedPath = projectStoredPath(info.path, project);
		const child = await projectStore.add(storedPath, projectId, project.environment === "wsl" ? "wsl" : "windows");
		return {
			target: { projectId: child.id, relativePath: "" },
			branch: info.branch,
			displayPath: storedPath,
			path: storedPath,
		};
	});

	handleProjectGit(ipcChannels.gitWorktreeRemove, async (_event, projectId: string, rawWorktreeTarget: unknown) => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error("PROJECT_NOT_FOUND");
		const worktreeTarget = parseProjectFileTarget(rawWorktreeTarget);
		if (worktreeTarget.relativePath !== "" || worktreeTarget.projectId === projectId) throw new Error("INVALID_WORKTREE_TARGET");
		const child = projectStore.get(worktreeTarget.projectId);
		if (!child || child.worktreeParentId !== projectId) throw new Error("WORKTREE_TARGET_NOT_OWNED_BY_PROJECT");
		const repository = await requireGitRepository(projectId, { projectId, relativePath: "" });
		try {
			const hostWorktreePath = hostPath(child.path);
			const ok = await worktreeService.remove(hostWorktreePath, repository.projectRoot);
			const normalizeForCompare = (value: string) => {
				const resolved = resolve(value);
				return process.platform === "win32" ? resolved.toLowerCase() : resolved;
			};
			const normalizedPath = normalizeForCompare(hostWorktreePath);
			const stillInGit = (await worktreeService.list(repository.projectRoot)).some((entry) => normalizeForCompare(entry.path) === normalizedPath);
			if (ok || !stillInGit) {
				await projectStore.remove(child.id);
				void appLogger.info("git", "Worktree removed", { projectId, worktreeTarget, projectRecordRemoved: true });
				return true;
			}
			void appLogger.info("git", "Worktree removal skipped", { projectId, worktreeTarget, reason: "worktree still tracked by git" });
			return false;
		} catch (error) {
			void appLogger.error("git", "Worktree remove failed", {
				projectId,
				worktreeTarget,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	});

	// -- Git 增强：提交历史 / 分支对比 / Graph
	handleProjectGit(ipcChannels.gitCommitLog, async (_event, projectId: string, rawOptions?: unknown, repoPath?: unknown) => {
		const options = parseGitHistoryOptions(projectId, rawOptions, true);
		const context = await findGitRepository(projectId, repoPath);
		if (!context) return [];
		const backend = gitBackendRouter.forProject(projectId);
		return gitService.getCommitLog(context.repoRoot, await localGitHistoryOptions(context, backend, options));
	});

	handleProjectGit(ipcChannels.gitCommitCount, async (_event, projectId: string, rawOptions?: unknown, repoPath?: unknown) => {
		const options = parseGitHistoryOptions(projectId, rawOptions, false);
		const context = await findGitRepository(projectId, repoPath);
		if (!context) return 0;
		const backend = gitBackendRouter.forProject(projectId);
		return gitService.getCommitCount(context.repoRoot, await localGitHistoryOptions(context, backend, options));
	});

	handleProjectGit(ipcChannels.gitRefs, async (event, projectId: string, repoPath?: unknown): Promise<GitRef[]> => {
		const project = projectStore.get(projectId);
		if (project && isRemoteProject(project)) {
			if (!remoteGitReads?.refs) throw new Error("UNSUPPORTED_CAPABILITY");
			return remoteGitReads.refs(event, projectId, repoPath);
		}
		const cwd = await findGitCwd(projectId, repoPath);
		return cwd ? gitService.getRefs(cwd) : [];
	});

	handleProjectGit(ipcChannels.gitBranchCompare, async (_event, projectId: string, base: string, target: string, repoPath?: unknown) => {
		const context = await requireGitRepository(projectId, repoPath);
		const result = await gitService.compareBranches(context.repoRoot, base, target);
		return decorateBranchDiff(context, result);
	});

	handleProjectGit(ipcChannels.gitCommitDetail, async (_event, projectId: string, ref: string, repoPath?: unknown) => {
		const context = await findGitRepository(projectId, repoPath);
		if (!context) return null;
		return decorateCommitDetail(context, await gitService.getCommitDetail(context.repoRoot, ref));
	});

	handleProjectGit(ipcChannels.gitCommitFileDiff, async (_event, projectId: string, ref: string, rawFileTarget: unknown, rawOriginalTarget?: unknown, repoPath?: unknown) => {
		const context = await findGitRepository(projectId, repoPath);
		if (!context) return null;
		const backend = gitBackendRouter.forProject(projectId);
		const fileTarget = parseGitProjectTarget(projectId, rawFileTarget);
		const originalTarget = rawOriginalTarget === undefined ? undefined : parseGitProjectTarget(projectId, rawOriginalTarget);
		const filePath = await repoRelativePathForTarget(context, backend, fileTarget);
		const originalPath = originalTarget ? await repoRelativePathForTarget(context, backend, originalTarget) : undefined;
		const maxBytes = Math.max(1, settingsStore.get().maxEditorFileSizeMB) * 1024 * 1024;
		const diff = await gitService.getCommitFileDiff(context.repoRoot, ref, filePath, originalPath, maxBytes);
		return decorateCommitFileDiff(context, diff);
	});

	handleProjectGit(ipcChannels.gitDiffFileBetween, async (_event, projectId: string, ref1: string, ref2: string, rawFileTarget: unknown, repoPath?: unknown) => {
		const context = await findGitRepository(projectId, repoPath);
		if (!context) return "";
		const backend = gitBackendRouter.forProject(projectId);
		const fileTarget = parseGitProjectTarget(projectId, rawFileTarget);
		const filePath = await repoRelativePathForTarget(context, backend, fileTarget);
		const maxBytes = Math.max(1, settingsStore.get().maxEditorFileSizeMB) * 1024 * 1024;
		return gitService.diffFileBetweenRefs(context.repoRoot, ref1, ref2, filePath, maxBytes);
	});

	// Git 工作区状态 + Stage/Unstage
	handleProjectGit(ipcChannels.gitStatus, async (event, projectId: string, repoPath?: unknown): Promise<GitResourceGroups> => {
		const project = projectStore.get(projectId);
		if (project && isRemoteProject(project)) {
			if (!remoteGitReads) throw new Error("UNSUPPORTED_CAPABILITY");
			return remoteGitReads.status(event, projectId, repoPath);
		}
		const context = await findGitRepository(projectId, repoPath);
		if (!context) return { merge: [], index: [], workingTree: [], untracked: [] };
		return decorateResourceGroups(context, await gitService.getStatus(context.repoRoot));
	});

	handleProjectGit(ipcChannels.gitWorkspaceFileDiff, async (event, projectId: string, group: unknown, rawFileTarget: unknown, repoPath?: unknown): Promise<GitWorkspaceFileDiff | null> => {
		const project = projectStore.get(projectId);
		if (project && isRemoteProject(project)) {
			if (!remoteGitReads) throw new Error("UNSUPPORTED_CAPABILITY");
			return remoteGitReads.workspaceDiff(event, projectId, group, rawFileTarget, repoPath);
		}
		if (group !== "merge" && group !== "index" && group !== "workingTree" && group !== "untracked") throw new Error("INVALID_GIT_RESOURCE_GROUP");
		const context = await findGitRepository(projectId, repoPath);
		if (!context) return null;
		const backend = gitBackendRouter.forProject(projectId);
		const fileTarget = parseGitProjectTarget(projectId, rawFileTarget);
		await repoRelativePathForTarget(context, backend, fileTarget);
		const filePath = await backend.resolveFilePath(fileTarget);
		const maxBytes = Math.max(1, settingsStore.get().maxEditorFileSizeMB) * 1024 * 1024;
		const diff = await gitService.getWorkspaceFileDiff(context.repoRoot, group, filePath, maxBytes);
		if (!diff) return null;
		const target = targetForAbsolutePath(context, diff.path);
		return { path: target.relativePath, target, displayPath: target.relativePath, originalContent: diff.originalContent, modifiedContent: diff.modifiedContent };
	});

	handleProjectGit(ipcChannels.gitStage, async (_event, projectId: string, rawTargets: unknown, repoPath?: unknown) => {
		const targets = parseGitFileTargets(projectId, rawTargets);
		const cwd = await requireGitCwd(projectId, repoPath);
		const backend = gitBackendRouter.forProject(projectId);
		await gitService.stageFiles(cwd, await localFilePaths(backend, targets));
	});

	handleProjectGit(ipcChannels.gitUnstage, async (_event, projectId: string, rawTargets: unknown, repoPath?: unknown) => {
		const targets = parseGitFileTargets(projectId, rawTargets);
		const cwd = await requireGitCwd(projectId, repoPath);
		const backend = gitBackendRouter.forProject(projectId);
		await gitService.unstageFiles(cwd, await localFilePaths(backend, targets));
	});

	handleProjectGit(ipcChannels.gitDiscard, async (_event, projectId: string, rawGroup: unknown, rawTarget: unknown, repoPath?: unknown) => {
		if (rawGroup !== "workingTree" && rawGroup !== "untracked") throw new Error("INVALID_GIT_RESOURCE_GROUP");
		const target = parseGitProjectTarget(projectId, rawTarget);
		const cwd = await requireGitCwd(projectId, repoPath);
		const backend = gitBackendRouter.forProject(projectId);
		const filePath = await backend.resolveFilePath(target);
		try {
			await gitService.discardFile(cwd, rawGroup, filePath);
			void appLogger.info("git", "Changes discarded", { projectId, group: rawGroup, target, repoTarget: parseGitRepositoryTarget(projectId, repoPath) });
		} catch (error) {
			void appLogger.error("git", "Discard changes failed", {
				projectId,
				group: rawGroup,
				target,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	});

	handleProjectGit(ipcChannels.gitDiscardFiles, async (_event, projectId: string, rawResources: unknown, repoPath?: unknown) => {
		if (!Array.isArray(rawResources) || rawResources.length > 1000) throw new Error("INVALID_GIT_DISCARD_RESOURCES");
		const resources: GitDiscardResource[] = rawResources.map((raw) => {
			if (!isRecord(raw)) throw new Error("INVALID_GIT_DISCARD_RESOURCES");
			const group = raw.group === "workingTree" || raw.group === "untracked" ? raw.group : undefined;
			if (!group) throw new Error("INVALID_GIT_DISCARD_RESOURCES");
			return { group, target: parseGitProjectTarget(projectId, raw.target) };
		});
		const cwd = await requireGitCwd(projectId, repoPath);
		const backend = gitBackendRouter.forProject(projectId);
		const localResources = await Promise.all(resources.map(async (resource) => ({ group: resource.group, path: await backend.resolveFilePath(resource.target) })));
		await gitService.discardFiles(cwd, localResources);
		void appLogger.info("git", "Changes discarded in batch", {
			projectId,
			count: resources.length,
			repoTarget: parseGitRepositoryTarget(projectId, repoPath),
		});
	});

	registerGitRecoveryIpc({
		handle: handleProjectGit,
		// 只转发三个动作，不把整个 service 交给恢复区（它不该知道别的写面）。
		recovery: { recoveryList: listRecovery, recoveryRestore: restoreRecovery, recoveryDrop: dropRecovery },
		requireGitCwd,
		info: (message, meta) => void appLogger.info("git", message, meta),
	});

	handleProjectGit(ipcChannels.gitCommit, async (_event, projectId: string, message: string, repoPath?: unknown) => {
		const cwd = await requireGitCwd(projectId, repoPath);
		await gitService.commit(cwd, message);
		void appLogger.info("git", "Commit created", { projectId, message, repoPath: cwd });
	});

	handleProjectGit(ipcChannels.gitCherryPick, async (_event, projectId: string, hash: string, repoPath?: unknown) => {
		const cwd = await requireGitCwd(projectId, repoPath);
		await gitService.cherryPick(cwd, hash);
		void appLogger.info("git", "Commit cherry-picked", { projectId, hash, repoPath: cwd });
	});

	handleProjectGit(ipcChannels.gitRevert, async (_event, projectId: string, hash: string, repoPath?: unknown) => {
		const cwd = await requireGitCwd(projectId, repoPath);
		await gitService.revertCommit(cwd, hash);
		void appLogger.info("git", "Commit reverted", { projectId, hash, repoPath: cwd });
	});

	handleProjectGit(ipcChannels.gitPush, async (_event, projectId: string, repoPath?: unknown) => {
		const cwd = await requireGitCwd(projectId, repoPath);
		await gitService.push(cwd);
		void appLogger.info("git", "Pushed", { projectId, repoPath: cwd });
	});

	handleProjectGit(ipcChannels.gitPull, async (_event, projectId: string, repoPath?: unknown) => {
		const cwd = await requireGitCwd(projectId, repoPath);
		await gitService.pull(cwd);
		void appLogger.info("git", "Pulled", { projectId, repoPath: cwd });
	});

	handleProjectGit(ipcChannels.gitReset, async (_event, projectId: string, hash: string, mode: "soft" | "mixed" | "hard", repoPath?: unknown) => {
		const cwd = await requireGitCwd(projectId, repoPath);
		await gitService.resetToCommit(cwd, hash, mode);
		// hard reset 会丢工作区/暂存区改动（reflog 外的不可恢复路径），warn 级突出显示。
		void appLogger.warn("git", "Reset to commit", { projectId, hash, mode, repoPath: cwd });
	});

	handleProjectGit(ipcChannels.gitDropCommit, async (_event, projectId: string, hash: string, repoPath?: unknown) => {
		const cwd = await requireGitCwd(projectId, repoPath);
		await gitService.dropCommit(cwd, hash);
		void appLogger.warn("git", "Commit dropped", { projectId, hash, repoPath: cwd });
	});

	registerGitCommitMessageIpc({
		handle: handleProjectGit,
		gitService,
		findGitCwd,
		settingsStore,
		projectStore,
		piLocator,
		appLogger,
		mainCopy,
		readRemoteStagedDiff: remoteGitReads === undefined ? undefined : (event, projectId, repoPath) => remoteGitReads.stagedDiff(event, projectId, repoPath),
	});

	handleProjectGit(ipcChannels.gitInit, async (_event, projectId: string) => {
		const context = await requireGitRepository(projectId, { projectId, relativePath: "" });
		await gitService.init(context.projectRoot);
		void appLogger.info("git", "Repository initialized", { projectId, target: { projectId, relativePath: "" } });
	});

	// Fetch：刷新远程跟踪引用（定时轮询 ahead/behind 的前置步骤）。
	// 非仓库直接跳过：面板首次挂载时 status 与 fetch 会并行，不能等 UI 标记。
	handleProjectGit(ipcChannels.gitFetch, async (_event, projectId: string, repoPath?: unknown) => {
		const cwd = await requireGitCwd(projectId, repoPath);
		if (!(await gitService.isGitRepo(cwd))) return;
		await gitService.fetch(cwd);
	});

	// ahead/behind：驱动 push/pull 角标；无上游返回 null（不显示角标）
	handleProjectGit(ipcChannels.gitAheadBehind, async (_event, projectId: string, repoPath?: unknown) => {
		return gitService.getAheadBehind(await requireGitCwd(projectId, repoPath));
	});

	// refs 变化监听：面板挂载时订阅、卸载时退订。commit/push/fetch/切分支会改写 refs 签名，
	// 主进程检出后立即推送，渲染层重读（延迟上限 = watcher 的轮询间隔 1.5 秒）。
	// 订阅是加速手段而非正确性前提：非 git 目录、读不到文件时 watcher 静默降级，渲染层仍有轮询兜底。
	// 传下去的是项目内仓库根（可能只是仓库的子目录），watcher 内部再向上解析 toplevel，
	// 按解析后的仓库去重复用轮询——同一仓库被多个项目根订阅时只跑一份。
	// 远端项目的 repoPath 由渲染层传入，保持 unknown 入参在边界校验。
	ipcMain.handle(ipcChannels.gitWatchRefs, async (_event, projectId: string, repoPath?: unknown) => {
		return gitRefsWatcher.acquire(projectId, await requireGitCwd(projectId, repoPath));
	});

	ipcMain.handle(ipcChannels.gitUnwatchRefs, (_event, watchId: string) => {
		// 入参不可信：只接受非空字符串；未知 watchId 由 watcher 静默忽略
		if (typeof watchId !== "string" || watchId === "") return;
		gitRefsWatcher.release(watchId);
	});

	// 事件桥：watcher → 渲染层推送。payload 用 watchId 而不是仓库路径，
	// 多仓项目里 N 个面板共用这条通道，各自比对自己的 id 即可，无需再规范化路径。
	// 退订由 watcher.disposeAll() 在退出清理时统一清空，无需单独登记。
	gitRefsWatcher.on((watchId) => {
		const window = getMainWindow();
		// 窗口已销毁时 send 会抛：这里只推送，不影响监听本身
		if (!window || window.isDestroyed()) return;
		window.webContents.send(ipcChannels.gitRefsChanged, watchId);
	});

	handleProjectGit(ipcChannels.gitDeleteFiles, async (_event, projectId: string, rawTargets: unknown, repoPath?: unknown) => {
		const targets = parseGitFileTargets(projectId, rawTargets);
		if (targets.length === 0) throw new Error("INVALID_GIT_FILE_TARGETS");
		const cwd = await requireGitCwd(projectId, repoPath);
		const backend = gitBackendRouter.forProject(projectId);
		await gitService.deleteFiles(cwd, await localFilePaths(backend, targets));
		void appLogger.warn("git", "Files deleted (recycle bin)", {
			projectId,
			count: targets.length,
			targets,
			repoTarget: parseGitRepositoryTarget(projectId, repoPath),
		});
	});

	ipcMain.handle(ipcChannels.gitDetectExecutable, async (_event, configuredPath?: unknown) => {
		// 入参不可信：非字符串（含 undefined）一律回落到设置里已持久化的值；
		// 渲染层传草稿值进来即可在保存前预览「这样配置能不能用」。
		const configured = typeof configuredPath === "string" ? configuredPath : settingsStore.get().gitExecutablePath;
		return detectGitExecutable(configured);
	});

	ipcMain.handle(ipcChannels.gitChooseExecutable, async () => {
		const options = {
			properties: ["openFile"],
			filters:
				process.platform === "win32"
					? [
							{ name: "Executables", extensions: ["exe", "cmd", "bat"] },
							{ name: "All Files", extensions: ["*"] },
						]
					: [{ name: "All Files", extensions: ["*"] }],
		} satisfies Electron.OpenDialogOptions;
		const result = await dialog.showOpenDialog(options);
		return result.canceled ? null : (result.filePaths[0] ?? null);
	});
}
