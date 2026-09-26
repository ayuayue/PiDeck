import { dialog, ipcMain, type BrowserWindow } from "electron";
import { relative, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { ipcChannels } from "../../shared/ipc";
import type { CommitDetail, GitChangedFile, GitCommitFileDiff, GitDiscardResource, GitGenerateCommitMessageResult, GitRepoInfo, GitResource, GitResourceGroups, GitWorkspaceDiffGroup, GitWorkspaceFileDiff, ProjectFileTarget, WorktreeEntry } from "../../shared/types";
import { parseProjectFileTarget } from "../files/projectFileTarget";
import { GitBackendRouter, LocalGitBackend, resolveRelativeGitPath, type GitBackend, type GitRepositoryContext } from "../git/GitBackend";
import type { LocalGitChangedFile, LocalGitCommitDetail, LocalGitCommitFileDiff, LocalGitResource, LocalGitResourceGroups, LocalGitWorkspaceFileDiff, LocalWorktreeEntry } from "../git/localGitTypes";
import type { GitService } from "../git/GitService";
import type { GitRefsWatcher } from "../git/GitRefsWatcher";
import { currentGitExecutable, detectGitExecutable } from "../git/gitExecutable";
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
};

// ── QuickGen：持久化轻量 pi 进程，通过 RPC 生成提交摘要 ──────────────

/** 轻量 pi 进程，用 RPC 模式运行，只做文本生成，不加载 session/tools/extensions */
let genProcess: ChildProcess | null = null;
let genRpcClient: PiRpcClient | null = null;
let genProcessCwd = "";
let genModelKey = "";
/** 当前生成进程的代理指纹：代理设置/名单命中变化且模型未变时也要重建（env 在 spawn 时定格）。 */
let genProxyKey = "";
let genIdleTimer: NodeJS.Timeout | null = null;
/** 生成互斥锁：同一时刻只允许一个摘要请求，避免并发打到复用进程触发 pi 的 busy 拒绝 */
let genBusy = false;

/** 清理快速生成进程 */
function stopGenProcess() {
	if (genIdleTimer) {
		clearTimeout(genIdleTimer);
		genIdleTimer = null;
	}
	genRpcClient?.close();
	genRpcClient = null;
	if (genProcess && genProcess.exitCode === null) {
		try {
			genProcess.kill();
		} catch {
			/* ignore */
		}
	}
	genProcess = null;
	genProcessCwd = "";
	genModelKey = "";
	genProxyKey = "";
}

/** 重置空闲定时器：30 分钟无请求自动杀掉进程释放内存 */
function resetGenIdleTimer() {
	if (genIdleTimer) clearTimeout(genIdleTimer);
	genIdleTimer = setTimeout(() => {
		stopGenProcess();
	}, 30 * 60_000);
}

/** 确保有一个轻量 pi RPC 进程在运行，跨项目复用 */
async function ensureGenProcess(projectPath: string, command: string, piLocator: PiLocator, settingsStore: SettingsStore, model: { provider: string; modelId: string }, appLogger: Pick<AppLogger, "warn">): Promise<PiRpcClient> {
	// provider/model 变化时必须重启轻量进程，避免旧进程继续持有上一组选中的模型。
	// 代理指纹同理：HTTP_PROXY 等环境变量在 spawn 时定格，设置页改代理/名单后不重建
	// 旧进程会一直直连（或沿用旧代理），表现为「配置了代理但生成摘要没走代理」。
	const modelKey = `${model.provider}\0${model.modelId}`;
	const proxyKey = computeGenProxyKey(settingsStore.get(), model.provider, model.modelId);
	if (genProcess && genRpcClient && genProcess.exitCode === null) {
		if (genModelKey === modelKey && genProxyKey === proxyKey) {
			genProcessCwd = projectPath;
			resetGenIdleTimer();
			return genRpcClient;
		}
		stopGenProcess();
	}

	// 清理已死的旧进程
	if (genProcess) stopGenProcess();

	try {
		// 首次默认带扩展启动：提交信息模型选择器允许扩展 provider（如 antigravity 插件）
		// 贡献的模型（issue #181），进程必须能解析它们，与运行时会话保持一致。
		// 用户开启「禁用扩展启动」诊断开关（piRpcNoExtensions）时首次也直接不带扩展。
		const firstWithExtensions = !settingsStore.get().piRpcNoExtensions;
		return await trySpawnGenProcess(firstWithExtensions, projectPath, command, piLocator, settingsStore, model, appLogger);
	} catch {
		// 带扩展启动失败（坏扩展导致崩溃/启动挂起/RPC 未就绪）：
		// 降级为无扩展重试一次；仍失败则抛出第二轮错误（无扩展基线，更能反映真实状态）。
		return await trySpawnGenProcess(false, projectPath, command, piLocator, settingsStore, model, appLogger);
	}
}

/** 生成进程基础参数：默认【加载扩展】（issue #181）；withExtensions=false 时追加
 * --no-extensions 作为坏扩展场景的降级集。 */
function buildGenArgs(withExtensions: boolean): string[] {
	return ["--mode", "rpc", "--no-session", "--no-tools", ...(withExtensions ? [] : ["--no-extensions"]), "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--thinking", "off"];
}

/** 启动轻量 pi RPC 生成进程并完成 set_model；withExtensions 决定是否加载扩展。
 * 失败时清理进程与全局状态并抛错，由 ensureGenProcess 决定是否降级重试。 */
async function trySpawnGenProcess(withExtensions: boolean, projectPath: string, command: string, piLocator: PiLocator, settingsStore: SettingsStore, model: { provider: string; modelId: string }, appLogger: Pick<AppLogger, "warn">): Promise<PiRpcClient> {
	const modelKey = `${model.provider}\0${model.modelId}`;
	const settings = settingsStore.get();
	// WSL pi 需要 Linux cwd（--cd）；Windows spawn 本身仍必须落在主机路径上。
	const wslCwd = settings.wslEnabled && settings.wslDistro && command.startsWith("wsl://") ? toWslLinuxPath(projectPath, { distro: settings.wslDistro }) : undefined;
	const invocation = piLocator.createInvocation(command, buildGenArgs(withExtensions), wslCwd ? { wslCwd } : {});
	const spawnCwd = wslCwd && settings.wslDistro ? toWindowsHostPath(projectPath, { distro: settings.wslDistro }) : projectPath;

	const childProcess = spawn(invocation.command, invocation.args, {
		cwd: spawnCwd,
		// 与运行时会话同策略：会话 on/off 覆盖 > 模型名单命中强制走代理 > 跟随全局。
		// 之前只按 piProxyEnabled 全局开关注入，名单内模型（全局关）生成摘要会直连失败。
		env: piLocator.createProcessEnv(applyPiProxyModeWithProvider(settings, undefined, model.provider, model.modelId), invocation.pathPrefix, invocation.wsl),
		stdio: ["pipe", "pipe", "pipe"],
		shell: invocation.shell,
		windowsHide: true,
		windowsVerbatimArguments: invocation.windowsVerbatimArguments,
	});
	genProcess = childProcess;
	genProcessCwd = spawnCwd;
	genProxyKey = computeGenProxyKey(settings, model.provider, model.modelId);

	genRpcClient = new PiRpcClient(childProcess.stdin!, childProcess.stdout!);

	try {
		const modelResponse = await genRpcClient.request({
			type: "set_model",
			provider: model.provider,
			modelId: model.modelId,
		});
		if (!modelResponse.success) {
			throw new Error(modelResponse.error ?? `Unable to select model ${model.provider}/${model.modelId}`);
		}
		genModelKey = modelKey;
	} catch (error) {
		stopGenProcess();
		throw error;
	}

	// stderr 仅用于调试日志
	genProcess.stderr!.on("data", (chunk: Buffer) => {
		const text = chunk.toString("utf8").slice(0, 300);
		void appLogger.warn("git", "QuickGen stderr", { text });
	});

	genProcess.on("exit", () => {
		// 旧进程可能在模型切换后才发出 exit；只允许当前实例清理全局状态。
		if (genProcess === childProcess) stopGenProcess();
	});

	resetGenIdleTimer();
	return genRpcClient;
}

/** 通过持久化 RPC 进程快速生成文本，避免每次 fork 新进程 */
async function quickGenerate(projectPath: string, prompt: string, piLocator: PiLocator, settingsStore: SettingsStore, model: { provider: string; modelId: string }, appLogger: Pick<AppLogger, "warn">): Promise<string> {
	// 复用进程同时只能跑一个生成；并发（连点/跨项目）直接拒绝，由 handler 转友好提示
	if (genBusy) {
		throw new Error("Agent is already processing");
	}
	genBusy = true;

	const settings = settingsStore.get();
	// Git 快生成前异步预热 WSL which，避免 resolveCommand 同步卡住主进程。
	if (settings.wslEnabled && settings.wslDistro && settings.wslUser) {
		await piLocator.warmWslCommand(settings.wslDistro, settings.wslUser);
	}
	const command = piLocator.resolveCommand(settings.customPiPath, settings.wslEnabled, settings.wslDistro, settings.wslUser);

	try {
		const rpc = await ensureGenProcess(projectPath, command, piLocator, settingsStore, model, appLogger);

		return await new Promise<string>((resolve, reject) => {
			const collected: string[] = [];
			let settled = false;
			const timeout = setTimeout(() => {
				if (!settled) {
					void appLogger.warn("git", "QuickGen timed out", {});
					// 超时后 pi 进程内的 agent 可能仍在处理旧请求（残留 busy 状态），
					// 直接杀掉复用进程，下次请求重建干净的进程，避免后续请求被 busy 拒绝。
					stopGenProcess();
					reject(new Error("Quick generate timed out"));
				}
			}, 60_000);

			const onEvent = (event: Record<string, unknown>) => {
				const eventType = event.type as string;
				if (eventType === "message_update") {
					const ae = (event as Record<string, unknown>).assistantMessageEvent as Record<string, unknown> | undefined;
					if (ae?.type === "text_delta" && typeof ae.delta === "string") {
						collected.push(ae.delta);
					}
				}
				if (eventType === "agent_settled" || eventType === "agent_end") {
					settled = true;
					clearTimeout(timeout);
					rpc.off("event", onEvent);
					resolve(collected.join(""));
				}
			};

			rpc.on("event", onEvent);

			rpc
				.request({ type: "prompt", message: prompt })
				.then((response) => {
					if (!response.success) {
						clearTimeout(timeout);
						rpc.off("event", onEvent);
						reject(new Error(response.error ?? "Prompt rejected"));
					}
				})
				.catch((err) => {
					clearTimeout(timeout);
					rpc.off("event", onEvent);
					reject(err);
				});
		});
	} finally {
		genBusy = false;
	}
}

// ── IPC 注册 ────────────────────────────────────────────────────────

export function registerGitIpc({ appLogger, mainCopy, gitService, gitRefsWatcher, getMainWindow, piLocator, projectStore, settingsStore, worktreeService }: GitIpcDeps): void {
	const hostPath = (path: string): string => {
		const settings = settingsStore.get();
		if (process.platform !== "win32" || !settings.wslEnabled || !settings.wslDistro || (!path.startsWith("/") && !parseWslUncPath(path))) {
			return path;
		}
		return toWindowsHostPath(path, { distro: settings.wslDistro });
	};

	const projectHostPath = (project: { path: string }) => hostPath(project.path);
	const gitBackendRouter = new GitBackendRouter(new LocalGitBackend(projectStore, projectHostPath), projectStore);
	const projectStoredPath = (path: string, project: { environment?: string }) => {
		const settings = settingsStore.get();
		if (process.platform !== "win32" || project.environment !== "wsl" || !settings.wslEnabled || !settings.wslDistro) {
			return path;
		}
		return normalizeSelectedWslProjectPath(path, { distro: settings.wslDistro });
	};

	const projectTargetFromLocalPath = (projectId: string, path: unknown): ProjectFileTarget => {
		if (typeof path !== "string" || !path.trim() || path.length > 32_768 || path.includes("\\0")) throw new Error("INVALID_GIT_FILE_TARGET");
		const project = projectStore.get(projectId);
		if (!project) throw new Error("PROJECT_NOT_FOUND");
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

	// Scan repositories through the same local-only boundary used by every Git operation.
	ipcMain.handle(ipcChannels.gitListRepos, async (_event, projectId: string) => {
		if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 256) throw new Error("INVALID_PROJECT_ID");
		if (!projectStore.get(projectId)) return [];
		try {
			return await gitBackendRouter.forProject(projectId).listRepositories({ projectId, relativePath: "" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	});

	ipcMain.handle(ipcChannels.gitBranches, async (_event, projectId: string, repoPath?: unknown) => {
		return gitService.getBranches(await requireGitCwd(projectId, repoPath));
	});

	ipcMain.handle(ipcChannels.gitCheckout, async (_event, projectId: string, branch: string, repoPath?: unknown) => {
		const cwd = await requireGitCwd(projectId, repoPath);
		const result = await gitService.checkout(cwd, branch);
		// 切换分支可能覆盖未提交的工作区改动：记 warn 审计日志，排查"文件消失"时能定位到切换动作。
		void appLogger.warn("git", "Branch checked out", { projectId, branch, repoPath: cwd, changed: result });
		return result;
	});

	ipcMain.handle(ipcChannels.gitCreateBranch, async (_event, projectId: string, branchName: string, repoPath?: unknown) => {
		return gitService.createBranch(await requireGitCwd(projectId, repoPath), branchName);
	});

	// Diff 基准只接受 project target，避免 renderer 提供任意主机路径交给 Git 子进程。
	ipcMain.handle(ipcChannels.gitOriginalContent, async (_event, rawTarget: unknown) => {
		const target = parseProjectFileTarget(rawTarget);
		const backend = gitBackendRouter.forProject(target.projectId);
		const filePath = await backend.resolveFilePath(target);
		const maxBytes = Math.max(1, settingsStore.get().maxEditorFileSizeMB) * 1024 * 1024;
		return gitService.getOriginalContent(filePath, maxBytes);
	});

	ipcMain.handle(ipcChannels.gitWorktreeList, async (_event, projectId: string): Promise<WorktreeEntry[]> => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error("PROJECT_NOT_FOUND");
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

	ipcMain.handle(ipcChannels.gitWorktreeCreate, async (_event, projectId: string, branchName: string): Promise<WorktreeEntry> => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error("PROJECT_NOT_FOUND");
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

	ipcMain.handle(ipcChannels.gitWorktreeRemove, async (_event, projectId: string, rawWorktreeTarget: unknown) => {
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
	ipcMain.handle(ipcChannels.gitCommitLog, async (_event, projectId: string, rawOptions?: unknown, repoPath?: unknown) => {
		const options = parseGitHistoryOptions(projectId, rawOptions, true);
		const context = await findGitRepository(projectId, repoPath);
		if (!context) return [];
		const backend = gitBackendRouter.forProject(projectId);
		return gitService.getCommitLog(context.repoRoot, await localGitHistoryOptions(context, backend, options));
	});

	ipcMain.handle(ipcChannels.gitCommitCount, async (_event, projectId: string, rawOptions?: unknown, repoPath?: unknown) => {
		const options = parseGitHistoryOptions(projectId, rawOptions, false);
		const context = await findGitRepository(projectId, repoPath);
		if (!context) return 0;
		const backend = gitBackendRouter.forProject(projectId);
		return gitService.getCommitCount(context.repoRoot, await localGitHistoryOptions(context, backend, options));
	});

	ipcMain.handle(ipcChannels.gitRefs, async (_event, projectId: string, repoPath?: unknown) => {
		const cwd = await findGitCwd(projectId, repoPath);
		return cwd ? gitService.getRefs(cwd) : [];
	});

	ipcMain.handle(ipcChannels.gitBranchCompare, async (_event, projectId: string, base: string, target: string, repoPath?: unknown) => {
		const context = await requireGitRepository(projectId, repoPath);
		const result = await gitService.compareBranches(context.repoRoot, base, target);
		return decorateBranchDiff(context, result);
	});

	ipcMain.handle(ipcChannels.gitCommitDetail, async (_event, projectId: string, ref: string, repoPath?: unknown) => {
		const context = await findGitRepository(projectId, repoPath);
		if (!context) return null;
		return decorateCommitDetail(context, await gitService.getCommitDetail(context.repoRoot, ref));
	});

	ipcMain.handle(ipcChannels.gitCommitFileDiff, async (_event, projectId: string, ref: string, rawFileTarget: unknown, rawOriginalTarget?: unknown, repoPath?: unknown) => {
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

	ipcMain.handle(ipcChannels.gitDiffFileBetween, async (_event, projectId: string, ref1: string, ref2: string, rawFileTarget: unknown, repoPath?: unknown) => {
		const context = await findGitRepository(projectId, repoPath);
		if (!context) return "";
		const backend = gitBackendRouter.forProject(projectId);
		const fileTarget = parseGitProjectTarget(projectId, rawFileTarget);
		const filePath = await repoRelativePathForTarget(context, backend, fileTarget);
		const maxBytes = Math.max(1, settingsStore.get().maxEditorFileSizeMB) * 1024 * 1024;
		return gitService.diffFileBetweenRefs(context.repoRoot, ref1, ref2, filePath, maxBytes);
	});

	// Git 工作区状态 + Stage/Unstage
	ipcMain.handle(ipcChannels.gitStatus, async (_event, projectId: string, repoPath?: unknown): Promise<GitResourceGroups> => {
		const context = await findGitRepository(projectId, repoPath);
		if (!context) return { merge: [], index: [], workingTree: [], untracked: [] };
		return decorateResourceGroups(context, await gitService.getStatus(context.repoRoot));
	});

	ipcMain.handle(ipcChannels.gitWorkspaceFileDiff, async (_event, projectId: string, group: unknown, rawFileTarget: unknown, repoPath?: unknown): Promise<GitWorkspaceFileDiff | null> => {
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

	ipcMain.handle(ipcChannels.gitStage, async (_event, projectId: string, rawTargets: unknown, repoPath?: unknown) => {
		const targets = parseGitFileTargets(projectId, rawTargets);
		const cwd = await requireGitCwd(projectId, repoPath);
		const backend = gitBackendRouter.forProject(projectId);
		await gitService.stageFiles(cwd, await localFilePaths(backend, targets));
	});

	ipcMain.handle(ipcChannels.gitUnstage, async (_event, projectId: string, rawTargets: unknown, repoPath?: unknown) => {
		const targets = parseGitFileTargets(projectId, rawTargets);
		const cwd = await requireGitCwd(projectId, repoPath);
		const backend = gitBackendRouter.forProject(projectId);
		await gitService.unstageFiles(cwd, await localFilePaths(backend, targets));
	});

	ipcMain.handle(ipcChannels.gitDiscard, async (_event, projectId: string, rawGroup: unknown, rawTarget: unknown, repoPath?: unknown) => {
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

	ipcMain.handle(ipcChannels.gitDiscardFiles, async (_event, projectId: string, rawResources: unknown, repoPath?: unknown) => {
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

	ipcMain.handle(ipcChannels.gitCommit, async (_event, projectId: string, message: string, repoPath?: unknown) => {
		const cwd = await requireGitCwd(projectId, repoPath);
		await gitService.commit(cwd, message);
		void appLogger.info("git", "Commit created", { projectId, message, repoPath: cwd });
	});

	ipcMain.handle(ipcChannels.gitCherryPick, async (_event, projectId: string, hash: string, repoPath?: unknown) => {
		const cwd = await requireGitCwd(projectId, repoPath);
		await gitService.cherryPick(cwd, hash);
		void appLogger.info("git", "Commit cherry-picked", { projectId, hash, repoPath: cwd });
	});

	ipcMain.handle(ipcChannels.gitRevert, async (_event, projectId: string, hash: string, repoPath?: unknown) => {
		const cwd = await requireGitCwd(projectId, repoPath);
		await gitService.revertCommit(cwd, hash);
		void appLogger.info("git", "Commit reverted", { projectId, hash, repoPath: cwd });
	});

	ipcMain.handle(ipcChannels.gitPush, async (_event, projectId: string, repoPath?: unknown) => {
		const cwd = await requireGitCwd(projectId, repoPath);
		await gitService.push(cwd);
		void appLogger.info("git", "Pushed", { projectId, repoPath: cwd });
	});

	ipcMain.handle(ipcChannels.gitPull, async (_event, projectId: string, repoPath?: unknown) => {
		const cwd = await requireGitCwd(projectId, repoPath);
		await gitService.pull(cwd);
		void appLogger.info("git", "Pulled", { projectId, repoPath: cwd });
	});

	ipcMain.handle(ipcChannels.gitReset, async (_event, projectId: string, hash: string, mode: "soft" | "mixed" | "hard", repoPath?: unknown) => {
		const cwd = await requireGitCwd(projectId, repoPath);
		await gitService.resetToCommit(cwd, hash, mode);
		// hard reset 会丢工作区/暂存区改动（reflog 外的不可恢复路径），warn 级突出显示。
		void appLogger.warn("git", "Reset to commit", { projectId, hash, mode, repoPath: cwd });
	});

	ipcMain.handle(ipcChannels.gitDropCommit, async (_event, projectId: string, hash: string, repoPath?: unknown) => {
		const cwd = await requireGitCwd(projectId, repoPath);
		await gitService.dropCommit(cwd, hash);
		void appLogger.warn("git", "Commit dropped", { projectId, hash, repoPath: cwd });
	});

	ipcMain.handle(ipcChannels.gitGenerateCommitMessage, async (_event, projectId: string, repoPath?: unknown): Promise<GitGenerateCommitMessageResult> => {
		const cwd = await findGitCwd(projectId, repoPath);
		if (!cwd) return { ok: true, message: "" };

		const diff = await gitService.getStagedDiff(cwd);
		if (!diff.trim()) return { ok: true, message: "" };

		const settings = settingsStore.get();
		const provider = settings.gitCommitMessageProvider.trim();
		const modelId = settings.gitCommitMessageModel.trim();
		if (!provider || !modelId) {
			// 结构化错误码：渲染层识别后提供“去设置”引导，而不是只显示一行文案
			return {
				ok: false,
				code: "GIT_COMMIT_MODEL_REQUIRED",
				message: mainCopy("git.commitMessageModelRequired"),
			};
		}

		// 从设置中读取提示词模板，替换 {diff} 为实际 diff 内容
		const promptTemplate = settings.gitCommitMessagePrompt || "请根据以下 git diff 生成一条中文 git commit message。\n\n{diff}\n\n直接输出 commit 消息。";
		const prompt = promptTemplate.replace("{diff}", diff.slice(0, 8000));

		try {
			const result = await quickGenerate(cwd, prompt, piLocator, settingsStore, { provider, modelId }, appLogger);
			void appLogger.warn("git", "Generate commit message result", { length: result.length });
			return { ok: true, message: result.trim() };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			void appLogger.warn("git", "Generate commit message failed", { error: msg });
			// pi 的 busy 拒绝是技术性英文，统一转成本地化提示；其余错误保留原文便于排查
			if (/Agent is already processing/i.test(msg)) {
				return { ok: false, code: "GIT_COMMIT_BUSY", message: mainCopy("git.commitMessageBusy") };
			}
			if (/timed out/i.test(msg)) {
				return { ok: false, code: "GIT_COMMIT_TIMEOUT", message: mainCopy("git.commitMessageTimeout") };
			}
			return { ok: false, code: "GIT_COMMIT_GENERATE_FAILED", message: msg };
		}
	});

	ipcMain.handle(ipcChannels.gitInit, async (_event, projectId: string) => {
		const context = await requireGitRepository(projectId, { projectId, relativePath: "" });
		await gitService.init(context.projectRoot);
		void appLogger.info("git", "Repository initialized", { projectId, target: { projectId, relativePath: "" } });
	});

	// Fetch：刷新远程跟踪引用（定时轮询 ahead/behind 的前置步骤）。
	// 非仓库直接跳过：面板首次挂载时 status 与 fetch 会并行，不能等 UI 标记。
	ipcMain.handle(ipcChannels.gitFetch, async (_event, projectId: string, repoPath?: unknown) => {
		const cwd = await requireGitCwd(projectId, repoPath);
		if (!(await gitService.isGitRepo(cwd))) return;
		await gitService.fetch(cwd);
	});

	// ahead/behind：驱动 push/pull 角标；无上游返回 null（不显示角标）
	ipcMain.handle(ipcChannels.gitAheadBehind, async (_event, projectId: string, repoPath?: unknown) => {
		return gitService.getAheadBehind(await requireGitCwd(projectId, repoPath));
	});

	// refs 变化监听：面板挂载时订阅、卸载时退订。commit/push/fetch/切分支会改写 refs 签名，
	// 主进程检出后立即推送，渲染层重读（延迟上限 = watcher 的轮询间隔 1.5 秒）。
	// 订阅是加速手段而非正确性前提：非 git 目录、读不到文件时 watcher 静默降级，渲染层仍有轮询兜底。
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

	ipcMain.handle(ipcChannels.gitDeleteFiles, async (_event, projectId: string, rawTargets: unknown, repoPath?: unknown) => {
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
