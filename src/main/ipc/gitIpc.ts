import { ipcMain } from "electron";
import { resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { ipcChannels } from "../../shared/ipc";
import type { GitDiscardResource, GitGenerateCommitMessageResult, GitWorkspaceDiffGroup } from "../../shared/types";
import type { GitService } from "../git/GitService";
import { listGitRepos, resolveGitCwd } from "../git/gitRepoScope";
import type { AppLogger } from "../logging/AppLogger";
import type { PiLocator } from "../pi/PiLocator";
import { PiRpcClient } from "../pi/PiRpcClient";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SettingsStore } from "../settings/SettingsStore";
import type { WorktreeService } from "../git/WorktreeService";
import {
	normalizeSelectedWslProjectPath,
	parseWslUncPath,
	toWindowsHostPath,
	toWslLinuxPath,
} from "../wsl/WslPaths";
import {
	applyPiProxyModeWithProvider,
	computeGenProxyKey,
} from "../sessions/sessionProxyPolicy";

export type GitIpcDeps = {
	appLogger: Pick<AppLogger, "warn" | "info" | "error">;
	mainCopy: (key: string, params?: Record<string, string | number>) => string;
	gitService: GitService;
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
		try { genProcess.kill(); } catch { /* ignore */ }
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
async function ensureGenProcess(
	projectPath: string,
	command: string,
	piLocator: PiLocator,
	settingsStore: SettingsStore,
	model: { provider: string; modelId: string },
	appLogger: Pick<AppLogger, "warn">,
): Promise<PiRpcClient> {
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
		return await trySpawnGenProcess(
			firstWithExtensions,
			projectPath, command, piLocator, settingsStore, model, appLogger,
		);
	} catch {
		// 带扩展启动失败（坏扩展导致崩溃/启动挂起/RPC 未就绪）：
		// 降级为无扩展重试一次；仍失败则抛出第二轮错误（无扩展基线，更能反映真实状态）。
		return await trySpawnGenProcess(
			false,
			projectPath, command, piLocator, settingsStore, model, appLogger,
		);
	}
}

/** 生成进程基础参数：默认【加载扩展】（issue #181）；withExtensions=false 时追加
 * --no-extensions 作为坏扩展场景的降级集。 */
function buildGenArgs(withExtensions: boolean): string[] {
	return [
		"--mode", "rpc",
		"--no-session",
		"--no-tools",
		...(withExtensions ? [] : ["--no-extensions"]),
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--no-themes",
		"--thinking", "off",
	];
}

/** 启动轻量 pi RPC 生成进程并完成 set_model；withExtensions 决定是否加载扩展。
 * 失败时清理进程与全局状态并抛错，由 ensureGenProcess 决定是否降级重试。 */
async function trySpawnGenProcess(
	withExtensions: boolean,
	projectPath: string,
	command: string,
	piLocator: PiLocator,
	settingsStore: SettingsStore,
	model: { provider: string; modelId: string },
	appLogger: Pick<AppLogger, "warn">,
): Promise<PiRpcClient> {
	const modelKey = `${model.provider}\0${model.modelId}`;
	const settings = settingsStore.get();
	// WSL pi 需要 Linux cwd（--cd）；Windows spawn 本身仍必须落在主机路径上。
	const wslCwd = settings.wslEnabled && settings.wslDistro && command.startsWith("wsl://")
		? toWslLinuxPath(projectPath, { distro: settings.wslDistro })
		: undefined;
	const invocation = piLocator.createInvocation(
		command,
		buildGenArgs(withExtensions),
		wslCwd ? { wslCwd } : {},
	);
	const spawnCwd = wslCwd && settings.wslDistro
		? toWindowsHostPath(projectPath, { distro: settings.wslDistro })
		: projectPath;

	const childProcess = spawn(invocation.command, invocation.args, {
		cwd: spawnCwd,
		// 与运行时会话同策略：会话 on/off 覆盖 > 模型名单命中强制走代理 > 跟随全局。
		// 之前只按 piProxyEnabled 全局开关注入，名单内模型（全局关）生成摘要会直连失败。
		env: piLocator.createProcessEnv(
			applyPiProxyModeWithProvider(settings, undefined, model.provider, model.modelId),
			invocation.pathPrefix,
			invocation.wsl,
		),
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
async function quickGenerate(
	projectPath: string,
	prompt: string,
	piLocator: PiLocator,
	settingsStore: SettingsStore,
	model: { provider: string; modelId: string },
	appLogger: Pick<AppLogger, "warn">,
): Promise<string> {
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
	const command = piLocator.resolveCommand(
		settings.customPiPath,
		settings.wslEnabled,
		settings.wslDistro,
		settings.wslUser,
	);

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

			rpc.request({ type: "prompt", message: prompt }).then((response) => {
				if (!response.success) {
					clearTimeout(timeout);
					rpc.off("event", onEvent);
					reject(new Error(response.error ?? "Prompt rejected"));
				}
			}).catch((err) => {
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

export function registerGitIpc({
	appLogger,
	mainCopy,
	gitService,
	piLocator,
	projectStore,
	settingsStore,
	worktreeService,
}: GitIpcDeps): void {
	const hostPath = (path: string): string => {
		const settings = settingsStore.get();
		if (
			process.platform !== "win32" ||
			!settings.wslEnabled ||
			!settings.wslDistro ||
			(!path.startsWith("/") && !parseWslUncPath(path))
		) {
			return path;
		}
		return toWindowsHostPath(path, { distro: settings.wslDistro });
	};

	const projectHostPath = (project: { path: string }) => hostPath(project.path);
	const projectStoredPath = (path: string, project: { environment?: string }) => {
		const settings = settingsStore.get();
		if (
			process.platform !== "win32" ||
			project.environment !== "wsl" ||
			!settings.wslEnabled ||
			!settings.wslDistro
		) {
			return path;
		}
		return normalizeSelectedWslProjectPath(path, { distro: settings.wslDistro });
	};

	/** 解析项目 + 可选嵌套仓库路径。repoPath 必须落在项目内，缺省仍用项目根。 */
	const requireGitCwd = (projectId: string, repoPath?: unknown): string => {
		const project = projectStore.get(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		return resolveGitCwd(projectHostPath(project), repoPath == null || repoPath === "" ? repoPath : hostPath(String(repoPath)));
	};

	const findGitCwd = (projectId: string, repoPath?: unknown): string | null => {
		const project = projectStore.get(projectId);
		if (!project) return null;
		return resolveGitCwd(projectHostPath(project), repoPath == null || repoPath === "" ? repoPath : hostPath(String(repoPath)));
	};

	// 扫描项目内独立仓库（根 + 嵌套）。worktree / git init 仍只作用于项目根。
	ipcMain.handle(ipcChannels.gitListRepos, async (_event, projectId: string) => {
		const project = projectStore.get(projectId);
		if (!project) return [];
		return listGitRepos(projectHostPath(project));
	});

	ipcMain.handle(ipcChannels.gitBranches, async (_event, projectId: string, repoPath?: string) => {
		return gitService.getBranches(requireGitCwd(projectId, repoPath));
	});

	ipcMain.handle(
		ipcChannels.gitCheckout,
		async (_event, projectId: string, branch: string, repoPath?: string) => {
			const cwd = requireGitCwd(projectId, repoPath);
			const result = await gitService.checkout(cwd, branch);
			// 切换分支可能覆盖未提交的工作区改动：记 warn 审计日志，排查"文件消失"时能定位到切换动作。
			void appLogger.warn("git", "Branch checked out", { projectId, branch, repoPath: cwd, changed: result });
			return result;
		},
	);

	ipcMain.handle(
		ipcChannels.gitCreateBranch,
		async (_event, projectId: string, branchName: string, repoPath?: string) => {
			return gitService.createBranch(requireGitCwd(projectId, repoPath), branchName);
		},
	);

	// 差异查看需要文件的 Git HEAD 原始内容作为对比基准；参数是绝对文件路径，后端自行定位仓库根。
	ipcMain.handle(
		ipcChannels.gitOriginalContent,
		async (_event, filePath: string) => {
			const maxBytes = Math.max(1, settingsStore.get().maxEditorFileSizeMB) * 1024 * 1024;
			return gitService.getOriginalContent(hostPath(filePath), maxBytes);
		},
	);

	ipcMain.handle(
		ipcChannels.gitWorktreeList,
		async (_event, projectId: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			const entries = await worktreeService.list(projectHostPath(project));
			const storedEntries = entries.map((entry) => ({
				...entry,
				path: projectStoredPath(entry.path, project),
			}));
			// 每次扫描都同步注册外部新增 worktree，保证侧栏数据和 git 状态一致。
			for (const wt of storedEntries) {
				await projectStore.add(wt.path, projectId, project.environment === "wsl" ? "wsl" : "windows");
			}
			return storedEntries;
		},
	);

	ipcMain.handle(
		ipcChannels.gitWorktreeCreate,
		async (_event, projectId: string, branchName: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			const info = await worktreeService.create(projectHostPath(project), projectId, branchName);
			const storedPath = projectStoredPath(info.path, project);
			await projectStore.add(storedPath, projectId, project.environment === "wsl" ? "wsl" : "windows");
			return { ...info, path: storedPath };
		},
	);

	ipcMain.handle(
		ipcChannels.gitWorktreeRemove,
		async (_event, projectId: string, worktreePath: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			try {
				const hostWorktreePath = hostPath(worktreePath);
				const hostProjectPath = projectHostPath(project);
				const ok = await worktreeService.remove(hostWorktreePath, hostProjectPath);
				const normalizeForCompare = (value: string) => {
					const resolved = resolve(value);
					return process.platform === "win32" ? resolved.toLowerCase() : resolved;
				};
				const normalizedTarget = normalizeForCompare(hostWorktreePath);
				const stillInGit = (await worktreeService.list(hostProjectPath)).some(
					(entry) => normalizeForCompare(entry.path) === normalizedTarget,
				);
				// 如果 git 已经没有该 worktree（包括用户在外部删过导致 remove 返回 false），
				// 也要清理 PiDeck 项目记录，否则重启后会从 projects.json 恢复成"删不掉"。
				if (ok || !stillInGit) {
					const child = projectStore.findByPath(projectStoredPath(hostWorktreePath, project));
					if (child) await projectStore.remove(child.id);
					// worktree 删除 = 物理目录删除（走回收站），记审计日志便于追踪。
					void appLogger.info("git", "Worktree removed", {
						projectId,
						worktreePath,
						projectRecordRemoved: Boolean(child),
					});
					return true;
				}
				void appLogger.info("git", "Worktree removal skipped", {
					projectId,
					worktreePath,
					reason: "worktree still tracked by git",
				});
				return false;
			} catch (error) {
				void appLogger.error("git", "Worktree remove failed", {
					projectId,
					worktreePath,
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		},
	);

	// -- Git 增强：提交历史 / 分支对比 / Graph
	ipcMain.handle(
		ipcChannels.gitCommitLog,
		async (_event, projectId: string, options?: { maxEntries?: number; ref?: string; path?: string; allBranches?: boolean }, repoPath?: string) => {
			const cwd = findGitCwd(projectId, repoPath);
			if (!cwd) return [];
			const hostOptions = options?.path ? { ...options, path: hostPath(options.path) } : options;
			return gitService.getCommitLog(cwd, hostOptions);
		},
	);

	ipcMain.handle(
		ipcChannels.gitRefs,
		async (_event, projectId: string, repoPath?: string) => {
			const cwd = findGitCwd(projectId, repoPath);
			if (!cwd) return [];
			return gitService.getRefs(cwd);
		},
	);

	ipcMain.handle(
		ipcChannels.gitBranchCompare,
		async (_event, projectId: string, base: string, target: string, repoPath?: string) => {
			return gitService.compareBranches(requireGitCwd(projectId, repoPath), base, target);
		},
	);

	ipcMain.handle(
		ipcChannels.gitCommitDetail,
		async (_event, projectId: string, ref: string, repoPath?: string) => {
			const cwd = findGitCwd(projectId, repoPath);
			if (!cwd) return null;
			return gitService.getCommitDetail(cwd, ref);
		},
	);

	ipcMain.handle(
		ipcChannels.gitCommitFileDiff,
		async (_event, projectId: string, ref: string, filePath: string, originalPath?: string, repoPath?: string) => {
			const cwd = findGitCwd(projectId, repoPath);
			if (!cwd) return null;
			const maxBytes = Math.max(1, settingsStore.get().maxEditorFileSizeMB) * 1024 * 1024;
			return gitService.getCommitFileDiff(
				cwd,
				ref,
				hostPath(filePath),
				originalPath ? hostPath(originalPath) : originalPath,
				maxBytes,
			);
		},
	);

	ipcMain.handle(
		ipcChannels.gitDiffFileBetween,
		async (_event, projectId: string, ref1: string, ref2: string, filePath: string, repoPath?: string) => {
			const cwd = findGitCwd(projectId, repoPath);
			if (!cwd) return "";
			return gitService.diffFileBetweenRefs(cwd, ref1, ref2, hostPath(filePath));
		},
	);


	// Git 工作区状态 + Stage/Unstage
	ipcMain.handle(
		ipcChannels.gitStatus,
		async (_event, projectId: string, repoPath?: string) => {
			const cwd = findGitCwd(projectId, repoPath);
			if (!cwd) return { merge: [], index: [], workingTree: [], untracked: [] };
			return gitService.getStatus(cwd);
		},
	);

	ipcMain.handle(
		ipcChannels.gitWorkspaceFileDiff,
		async (_event, projectId: string, group: GitWorkspaceDiffGroup, filePath: string, repoPath?: string) => {
			const cwd = findGitCwd(projectId, repoPath);
			if (!cwd) return null;
			const maxBytes = Math.max(1, settingsStore.get().maxEditorFileSizeMB) * 1024 * 1024;
			return gitService.getWorkspaceFileDiff(cwd, group, hostPath(filePath), maxBytes);
		},
	);

	ipcMain.handle(
		ipcChannels.gitStage,
		async (_event, projectId: string, paths: string[], repoPath?: string) => {
			await gitService.stageFiles(requireGitCwd(projectId, repoPath), paths.map(hostPath));
		},
	);

	ipcMain.handle(
		ipcChannels.gitUnstage,
		async (_event, projectId: string, paths: string[], repoPath?: string) => {
			await gitService.unstageFiles(requireGitCwd(projectId, repoPath), paths.map(hostPath));
		},
	);

	ipcMain.handle(
		ipcChannels.gitDiscard,
		async (_event, projectId: string, group: "workingTree" | "untracked", filePath: string, repoPath?: string) => {
			const cwd = requireGitCwd(projectId, repoPath);
			try {
				await gitService.discardFile(cwd, group, hostPath(filePath));
				// untracked 丢弃 = 删除用户文件（走回收站），记审计日志便于追踪。
				void appLogger.info("git", "Changes discarded", { projectId, group, filePath, repoPath: cwd });
			} catch (error) {
				void appLogger.error("git", "Discard changes failed", {
					projectId,
					group,
					filePath,
					repoPath: cwd,
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
		},
	);

	ipcMain.handle(
		ipcChannels.gitDiscardFiles,
		async (_event, projectId: string, resources: GitDiscardResource[], repoPath?: string) => {
			if (
				!Array.isArray(resources) ||
				resources.length > 1000 ||
				resources.some((resource) =>
					!resource ||
					(resource.group !== "workingTree" && resource.group !== "untracked") ||
					typeof resource.path !== "string" ||
					resource.path.length === 0,
				)
			) {
				throw new Error("Invalid Git discard resources");
			}
			const cwd = requireGitCwd(projectId, repoPath);
			await gitService.discardFiles(
				cwd,
				resources.map((resource) => ({ ...resource, path: hostPath(resource.path) })),
			);
			void appLogger.info("git", "Changes discarded in batch", {
				projectId,
				count: resources.length,
				repoPath: cwd,
			});
		},
	);

	ipcMain.handle(
		ipcChannels.gitCommit,
		async (_event, projectId: string, message: string, repoPath?: string) => {
			const cwd = requireGitCwd(projectId, repoPath);
			await gitService.commit(cwd, message);
			void appLogger.info("git", "Commit created", { projectId, message, repoPath: cwd });
		},
	);

	ipcMain.handle(
		ipcChannels.gitCherryPick,
		async (_event, projectId: string, hash: string, repoPath?: string) => {
			const cwd = requireGitCwd(projectId, repoPath);
			await gitService.cherryPick(cwd, hash);
			void appLogger.info("git", "Commit cherry-picked", { projectId, hash, repoPath: cwd });
		},
	);

	ipcMain.handle(
		ipcChannels.gitRevert,
		async (_event, projectId: string, hash: string, repoPath?: string) => {
			const cwd = requireGitCwd(projectId, repoPath);
			await gitService.revertCommit(cwd, hash);
			void appLogger.info("git", "Commit reverted", { projectId, hash, repoPath: cwd });
		},
	);

	ipcMain.handle(
		ipcChannels.gitPush,
		async (_event, projectId: string, repoPath?: string) => {
			const cwd = requireGitCwd(projectId, repoPath);
			await gitService.push(cwd);
			void appLogger.info("git", "Pushed", { projectId, repoPath: cwd });
		},
	);

	ipcMain.handle(
		ipcChannels.gitPull,
		async (_event, projectId: string, repoPath?: string) => {
			const cwd = requireGitCwd(projectId, repoPath);
			await gitService.pull(cwd);
			void appLogger.info("git", "Pulled", { projectId, repoPath: cwd });
		},
	);

	ipcMain.handle(
		ipcChannels.gitReset,
		async (_event, projectId: string, hash: string, mode: "soft" | "mixed" | "hard", repoPath?: string) => {
			const cwd = requireGitCwd(projectId, repoPath);
			await gitService.resetToCommit(cwd, hash, mode);
			// hard reset 会丢工作区/暂存区改动（reflog 外的不可恢复路径），warn 级突出显示。
			void appLogger.warn("git", "Reset to commit", { projectId, hash, mode, repoPath: cwd });
		},
	);

	ipcMain.handle(
		ipcChannels.gitDropCommit,
		async (_event, projectId: string, hash: string, repoPath?: string) => {
			const cwd = requireGitCwd(projectId, repoPath);
			await gitService.dropCommit(cwd, hash);
			void appLogger.warn("git", "Commit dropped", { projectId, hash, repoPath: cwd });
		},
	);

	ipcMain.handle(
		ipcChannels.gitGenerateCommitMessage,
		async (_event, projectId: string, repoPath?: string): Promise<GitGenerateCommitMessageResult> => {
			const cwd = findGitCwd(projectId, repoPath);
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
			const promptTemplate = settings.gitCommitMessagePrompt ||
				"请根据以下 git diff 生成一条中文 git commit message。\n\n{diff}\n\n直接输出 commit 消息。";
			const prompt = promptTemplate.replace("{diff}", diff.slice(0, 8000));

			try {
				const result = await quickGenerate(
					cwd,
					prompt,
					piLocator,
					settingsStore,
					{ provider, modelId },
					appLogger,
				);
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
		},
	);

	ipcMain.handle(
		ipcChannels.gitInit,
		async (_event, projectId: string) => {
			const project = projectStore.get(projectId);
			if (!project) throw new Error(`Project not found: ${projectId}`);
			const { execFile } = await import("node:child_process");
			await execFile("git", ["init"], { cwd: projectHostPath(project) });
			void appLogger.info("git", "Repository initialized", { projectId, path: project.path });
		},
	);

	// Fetch：刷新远程跟踪引用（定时轮询 ahead/behind 的前置步骤）。
	// 非仓库直接跳过：面板首次挂载时 status 与 fetch 会并行，不能等 UI 标记。
	ipcMain.handle(
		ipcChannels.gitFetch,
		async (_event, projectId: string, repoPath?: string) => {
			const cwd = requireGitCwd(projectId, repoPath);
			if (!(await gitService.isGitRepo(cwd))) return;
			await gitService.fetch(cwd);
		},
	);

	// ahead/behind：驱动 push/pull 角标；无上游返回 null（不显示角标）
	ipcMain.handle(
		ipcChannels.gitAheadBehind,
		async (_event, projectId: string, repoPath?: string) => {
			return gitService.getAheadBehind(requireGitCwd(projectId, repoPath));
		},
	);

	// 删除变更文件（移入回收站）：路径由 GitService 按 status 白名单校验
	ipcMain.handle(
		ipcChannels.gitDeleteFiles,
		async (_event, projectId: string, paths: string[], repoPath?: string) => {
			const cwd = requireGitCwd(projectId, repoPath);
			// 入参不可信：必须是非空字符串数组，防注入
			if (!Array.isArray(paths) || paths.length === 0 || paths.some((p) => typeof p !== "string" || !p)) {
				throw new Error("Invalid paths");
			}
			await gitService.deleteFiles(cwd, paths.map(hostPath));
			// 批量删除文件：最高风险操作之一，完整记录路径清单（含数量）便于误删回溯。
			void appLogger.warn("git", "Files deleted (recycle bin)", { projectId, count: paths.length, paths, repoPath: cwd });
		},
	);

}
