/**
 * AI 提交摘要（QuickGen）与它的通道。
 *
 * 从 `gitIpc.ts` 拆出（文件体量门禁：存量巨文件只准降不准升）。这一块本来就是一个自洽的子系统：
 * 一个复用的轻量 pi RPC 进程（30 分钟空闲回收、并发互斥、代理指纹随设置变化重建）+ 一个只读入口。
 *
 * 两种输入：
 * - 本机项目：自己读 `git diff --staged`；
 * - 远端项目：调用方传入 helper 读回的暂存 diff（本机没有那个仓库的工作区），此时 pi 进程用一个
 *   存在的本地 cwd，prompt 里已带全部上下文。
 */
import { app, type IpcMainInvokeEvent } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import type { GitGenerateCommitMessageResult, LocalProject } from "../../shared/types";
import { isLocalProject } from "../../shared/projectLocation";
import { ipcChannels } from "../../shared/ipc";
import type { AppLogger } from "../logging/AppLogger";
import type { PiLocator } from "../pi/PiLocator";
import { PiRpcClient } from "../pi/PiRpcClient";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SettingsStore } from "../settings/SettingsStore";
import { applyPiProxyModeWithProvider, computeGenProxyKey } from "../sessions/sessionProxyPolicy";
import { toWindowsHostPath, toWslLinuxPath } from "../wsl/WslPaths";

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
async function ensureGenProcess(projectPath: string, command: string, piLocator: PiLocator, settingsStore: SettingsStore, model: { provider: string; modelId: string }, appLogger: Pick<AppLogger, "warn">, wsl?: { distro: string; user: string }): Promise<PiRpcClient> {
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
		return await trySpawnGenProcess(firstWithExtensions, projectPath, command, piLocator, settingsStore, model, appLogger, wsl);
	} catch {
		// 带扩展启动失败（坏扩展导致崩溃/启动挂起/RPC 未就绪）：
		// 降级为无扩展重试一次；仍失败则抛出第二轮错误（无扩展基线，更能反映真实状态）。
		return await trySpawnGenProcess(false, projectPath, command, piLocator, settingsStore, model, appLogger, wsl);
	}
}

/** 生成进程基础参数：默认【加载扩展】（issue #181）；withExtensions=false 时追加
 * --no-extensions 作为坏扩展场景的降级集。 */
function buildGenArgs(withExtensions: boolean): string[] {
	return ["--mode", "rpc", "--no-session", "--no-tools", ...(withExtensions ? [] : ["--no-extensions"]), "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes", "--thinking", "off"];
}

/** 启动轻量 pi RPC 生成进程并完成 set_model；withExtensions 决定是否加载扩展。
 * 失败时清理进程与全局状态并抛错，由 ensureGenProcess 决定是否降级重试。 */
async function trySpawnGenProcess(withExtensions: boolean, projectPath: string, command: string, piLocator: PiLocator, settingsStore: SettingsStore, model: { provider: string; modelId: string }, appLogger: Pick<AppLogger, "warn">, wsl?: { distro: string; user: string }): Promise<PiRpcClient> {
	const modelKey = `${model.provider}\0${model.modelId}`;
	const settings = settingsStore.get();
	// WSL pi 需要 Linux cwd（--cd）；Windows spawn 本身仍必须落在主机路径上。
	const wslCwd = wsl !== undefined && command.startsWith("wsl://") ? toWslLinuxPath(projectPath, { distro: wsl.distro }) : undefined;
	const invocation = piLocator.createInvocation(command, buildGenArgs(withExtensions), wslCwd ? { wslCwd } : {});
	const spawnCwd = wslCwd !== undefined && wsl !== undefined ? toWindowsHostPath(projectPath, { distro: wsl.distro }) : projectPath;

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

	// spawn 失败（ENOENT/自定义 pi 路径失效/EACCES）时 'error' 事件无监听会直接崩掉主进程（AGENTS.md spawn 纪律）；
	// 这里只做日志与清理：挂起的 set_model 由 stopGenProcess→rpcClient.close() 统一拒绝，genBusy 由 quickGenerate 的 finally 复位。
	childProcess.on("error", (error) => {
		void appLogger.warn("git", "QuickGen process spawn error", { message: error.message });
		if (genProcess === childProcess) stopGenProcess();
	});

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
async function quickGenerate(projectPath: string, prompt: string, piLocator: PiLocator, settingsStore: SettingsStore, model: { provider: string; modelId: string }, appLogger: Pick<AppLogger, "warn">, project?: LocalProject): Promise<string> {
	// 复用进程同时只能跑一个生成；并发（连点/跨项目）直接拒绝，由 handler 转友好提示
	if (genBusy) {
		throw new Error("Agent is already processing");
	}
	genBusy = true;

	const settings = settingsStore.get();
	// 第 14 步：Git 快生成按项目档案挑发行版，不再看全局 WSL 开关。
	const wsl = project?.environment === "wsl" ? { distro: project.wslDistro ?? settings.wslDistro, user: project.wslUser ?? settings.wslUser } : undefined;
	if (wsl !== undefined && wsl.distro && wsl.user) await piLocator.warmWslCommand(wsl.distro, wsl.user);
	const command = piLocator.resolveCommand(settings.customPiPath, wsl !== undefined, wsl?.distro, wsl?.user);

	try {
		const rpc = await ensureGenProcess(projectPath, command, piLocator, settingsStore, model, appLogger, wsl);

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

export type GitCommitMessageIpcDeps = {
	/** 已绑定“可信项目 + WSL 身份”的 handler 注册器。 */
	handle<Args extends unknown[], Result>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: Args) => Result): void;
	gitService: { getStagedDiff(cwd: string, maxBytes?: number): Promise<string> };
	findGitCwd(projectId: string, repoPath?: unknown): Promise<string | null>;
	settingsStore: SettingsStore;
	projectStore: Pick<ProjectStore, "get">;
	piLocator: PiLocator;
	appLogger: Pick<AppLogger, "warn" | "info">;
	mainCopy: (key: string, params?: Record<string, string | number>) => string;
	/** 远端项目的暂存 diff 读口（helper `git.stagedDiff`）；缺席时远端项目明确失败，不回退本机。 */
	readRemoteStagedDiff?: (event: IpcMainInvokeEvent, projectId: string, repoPath: unknown) => Promise<string | null>;
};

export function registerGitCommitMessageIpc(deps: GitCommitMessageIpcDeps): void {
	deps.handle(ipcChannels.gitGenerateCommitMessage, async (_event, projectId: string, repoPath?: unknown, stagedDiff?: unknown): Promise<GitGenerateCommitMessageResult> => {
		/**
		 * 远端项目把暂存区 diff 作为第三个参数送进来（helper `git.stagedDiff`）：本机没有那个仓库的
		 * 工作区可读，而生成本身只消费 prompt。第三种情况是参数形状不对，显式拒绝而不是当成空 diff。
		 */
		if (stagedDiff !== undefined && (typeof stagedDiff !== "string" || stagedDiff.length > 200_000)) {
			void deps.appLogger.warn("git", "Generate commit message rejected: invalid staged diff input", { projectId, repoPath });
			return { ok: false, code: "GIT_COMMIT_DIFF_FAILED", message: deps.mainCopy("git.commitMessageEmptyDiff") };
		}
		const providedDiff = typeof stagedDiff === "string" ? stagedDiff : undefined;
		// 远端没有本地工作区：pi 快生成进程只需一个存在的本地 cwd，prompt 里已带全部上下文。
		let cwd: string | undefined = providedDiff === undefined ? undefined : app.getPath("userData");
		if (cwd === undefined) {
			const resolved = await deps.findGitCwd(projectId, repoPath);
			if (!resolved) {
				// 仓库目录没解析出来不等于「模型没返回摘要」：面板刚打开/刚 init/工作树被删时都会走到这里，
				// 误报会把用户引去查模型设置（issue #338）。
				void deps.appLogger.warn("git", "Generate commit message failed: repository path unresolved", { projectId, repoPath });
				return { ok: false, code: "GIT_COMMIT_NO_REPO", message: deps.mainCopy("git.commitMessageNoRepo") };
			}
			cwd = resolved;
		}

		let diff: string;
		if (providedDiff !== undefined) {
			diff = providedDiff;
		} else {
			try {
				diff = await deps.gitService.getStagedDiff(cwd);
			} catch (err) {
				// 读 diff 失败（cwd 失效/仓库损坏/git 超时）不能当成「空暂存区」，更不能吞成空串：
				// 两者文案与后续动作完全不同——空 → 引导先暂存；失败 → 报 git 原始报错。
				const msg = err instanceof Error ? err.message : String(err);
				void deps.appLogger.warn("git", "Read staged diff for commit message failed", { error: msg, projectId, repoPath: cwd });
				return { ok: false, code: "GIT_COMMIT_DIFF_FAILED", message: msg };
			}
		}
		if (!diff.trim()) {
			// 以真实暂存区为准：渲染层分组可能是旧快照（issue #338 的误报场景），必须给它可判别的码
			void deps.appLogger.info("git", "Generate commit message skipped: nothing staged", { projectId, repoPath: cwd });
			return { ok: false, code: "GIT_COMMIT_EMPTY_DIFF", message: deps.mainCopy("git.commitMessageEmptyDiff") };
		}

		const settings = deps.settingsStore.get();
		const provider = settings.gitCommitMessageProvider.trim();
		const modelId = settings.gitCommitMessageModel.trim();
		if (!provider || !modelId) {
			// 结构化错误码：渲染层识别后提供“去设置”引导，而不是只显示一行文案
			return {
				ok: false,
				code: "GIT_COMMIT_MODEL_REQUIRED",
				message: deps.mainCopy("git.commitMessageModelRequired"),
			};
		}

		// 从设置中读取提示词模板，替换 {diff} 为实际 diff 内容
		const promptTemplate = settings.gitCommitMessagePrompt || "请根据以下 git diff 生成一条中文 git commit message。\n\n{diff}\n\n直接输出 commit 消息。";
		const prompt = promptTemplate.replace("{diff}", diff.slice(0, 8000));

		try {
			const project = deps.projectStore.get(projectId);
			const result = await quickGenerate(cwd, prompt, deps.piLocator, deps.settingsStore, { provider, modelId }, deps.appLogger, project && isLocalProject(project) ? project : undefined);
			void deps.appLogger.warn("git", "Generate commit message result", { length: result.length });
			return { ok: true, message: result.trim() };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			void deps.appLogger.warn("git", "Generate commit message failed", { error: msg });
			// pi 的 busy 拒绝是技术性英文，统一转成本地化提示；其余错误保留原文便于排查
			if (/Agent is already processing/i.test(msg)) {
				return { ok: false, code: "GIT_COMMIT_BUSY", message: deps.mainCopy("git.commitMessageBusy") };
			}
			if (/timed out/i.test(msg)) {
				return { ok: false, code: "GIT_COMMIT_TIMEOUT", message: deps.mainCopy("git.commitMessageTimeout") };
			}
			return { ok: false, code: "GIT_COMMIT_GENERATE_FAILED", message: msg };
		}
	});
}
