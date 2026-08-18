/**
 * System IPC handlers: pi check/exec, WSL, model list, logging, config, app update, dev tools.
 * Phase 3.7: extracted from src/main/index.ts registerIpc().
 */

import { app, ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { RpcLogEntry } from "../../shared/types/rpcLog";
import type {
	AppLogLevel,
	AppLogQuery,
	AppSettings,
	AppUpdateAsset,
	AvailableModel,
	CreatePiSkillInput,
	SessionCommandResult,
	SessionRuntimeTarget,
} from "../../shared/types";
import type { PiLocator } from "../pi/PiLocator";
import type { SettingsStore } from "../settings/SettingsStore";
import type { ConfigManager } from "../config/ConfigManager";
import type { AgentManager } from "../pi/AgentManager";
import type { AppLogger } from "../logging/AppLogger";
import type { RpcLogger } from "../logging/RpcLogger";
import type { SessionRuntimeCoordinator } from "../sessions/SessionRuntimeCoordinator";
import type { SkillManager } from "../skills/SkillManager";
import { fetchModelList, invalidateModelListCache, getCachedModelList, refreshModelList } from "../pi/modelListCache";
import type { ModelSpecsStore } from "../pi/modelSpecsStore";
import { getProcessSnapshot } from "../process/ProcessMonitor";
import { buildDshHostMonitorRow, isDshHostMonitorId } from "../process/dshHostMonitor";
import type { AgentProcessMetric, ProcessMetricsSnapshot } from "../../shared/types";
import { getWslExe } from "../wsl/wslExe";
import { listWebNetworkAddresses } from "../web/WebNetwork";
import { toggleMainWindowDevTools } from "../devTools";
import {
	applyProviderMigration,
	previewProviderMigration,
	type ProviderMigrationDeps,
} from "../config/providerMigrationService";
import type { ProviderMigrationDirection } from "../../shared/types/providerMigration";

/**
 * IPC 边界校验：RPC 日志条目必须字段齐全，防止渲染层传伪造对象写盘。
 */
function isRpcLogEntry(value: unknown): value is RpcLogEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.id === "string" &&
		typeof entry.agentId === "string" &&
		(entry.direction === "send" || entry.direction === "recv") &&
		typeof entry.summary === "string" &&
		typeof entry.time === "number"
	);
}

export type SystemIpcDeps = {
	piLocator: PiLocator;
	settingsStore: SettingsStore;
	configManager: ConfigManager;
	agentManager: AgentManager;
	skillManager: SkillManager;
	appLogger: AppLogger;
	rpcLogger: RpcLogger;
	sessionRuntimeCoordinator: SessionRuntimeCoordinator;
	/** DSH 后端判定（G17：RPC 日志按 backend 分流）。 */
	isDshAgent?: (agentId: string) => boolean;
	/** DSH RPC 日志开关（G17；未装配 = 无 DSH 后端）。 */
	setDshRpcLogging?: (agentId: string, enabled: boolean) => void;
	/** DSH RPC 日志状态查询（G17）。 */
	isDshRpcLogging?: (agentId: string) => boolean;
	/** 进程监控停止 agent：按 agentId 走完整会话停止链路（含 detach 推送），装配层注入 */
	stopAgentFromMonitor: (
		agentId: string,
	) => Promise<SessionCommandResult<SessionRuntimeTarget | undefined>>;
	/** DSH host utilityProcess pid；未 fork 返回 undefined。 */
	getDshHostPid?: () => number | undefined;
	/** 当前挂在 host 上的 DSH 会话（监控行展示用，不各自占 pid）。 */
	listDshMonitorSessions?: () => Array<{ title?: string }>;
	/** 停止 DSH host：先卸会话再 dispose，不能走 pi stopAgentById。 */
	stopDshHostFromMonitor?: () => Promise<SessionCommandResult<undefined>>;
	/** 单供应商 pi↔DSH 互迁（不为此拉起 host）。 */
	providerMigration?: ProviderMigrationDeps;
	/** 模型规格存储（resources/model-specs.db 只读，发版前由 sync-model-specs.mjs 同步） */
	modelSpecsStore: ModelSpecsStore;
	getMainWindow: () => Electron.BrowserWindow | null;
	mainCopy: (key: string, params?: Record<string, string | number>) => string;
	/** Check for app update; defined in index.ts */
	checkForAppUpdate: (installationType?: string) => Promise<import("../../shared/types").AppUpdateInfo | null>;
	/** Download update asset */
	downloadUpdateAsset: (asset: AppUpdateAsset) => Promise<import("../../shared/types").AppUpdateDownloadResult>;
	/** Install downloaded update */
	installDownloadedUpdate: (filePath: string) => Promise<void>;
	/** Open external URL */
	openExternalUrl: (url: string, forceSystem?: boolean) => Promise<void>;
	/**
	 * Resolve WSL environment (lazy import in index.ts).
	 * 返回值直接喂给各 manager.configureWsl，形状必须是 WslEnvironment。
	 */
	resolveWslEnvironment?: (
		distro: string,
		user: string,
		logger: { warn: (msg: string, detail: unknown) => void },
	) => Promise<import("../wsl/WslPaths").WslEnvironment>;
	/** React to settings changes for pet system */
	reactToPetSettings?: (prev: AppSettings, next: AppSettings) => Promise<void>;
	/** Session scanner WSL config */
	configureSessionScannerWsl?: (env: import("../wsl/WslPaths").WslEnvironment) => Promise<void>;
	clearSessionScannerWsl?: () => void;
	/** Set feishu locale */
	setFeishuLocale?: (locale: unknown) => void;
	/** Set default bot name */
	setFeishuConfigDefaultBotName?: (name: string) => void;
	/** Refresh tray context menu */
	refreshTrayContextMenu?: () => void;
	/** Notify title bar change */
	notifyTitleBarChange?: (window: Electron.BrowserWindow) => void;
	/** Apply native theme source */
	applyNativeThemeSource?: (settings: AppSettings) => void;
	/** Apply desktop proxy settings */
	applyDesktopProxy?: (settings: AppSettings) => Promise<void>;
	/** Test Pi proxy */
	testPiProxy?: (settings: AppSettings, proxyUrl?: string, translate?: (key: string, params?: Record<string, string | number>) => string) => Promise<import("../../shared/types").PiProxyTestResult>;
	/** Web service manager apply settings */
	applyWebServiceSettings?: (settings: AppSettings) => Promise<void>;
	/** Restart the running Web service without changing persisted settings. */
	restartWebService?: (settings: AppSettings) => Promise<void>;
	/** Session catalog set identity context */
	setSessionCatalogIdentityContext?: (ctx: { wslDistro?: string; wslUser?: string }) => void;
	/** Configure WSL for various services — null 表示切回本机路径 */
	configureSkillManagerWsl?: (env: import("../wsl/WslPaths").WslEnvironment | null) => void;
	configurePromptManagerWsl?: (env: import("../wsl/WslPaths").WslEnvironment | null) => void;
	configureExtensionManagerWsl?: (env: import("../wsl/WslPaths").WslEnvironment | null) => void;
	configureConfigManagerWsl?: (env: import("../wsl/WslPaths").WslEnvironment | null) => void;
	configureXuePromptManagerWsl?: (env: import("../wsl/WslPaths").WslEnvironment | null) => void;
	configureAgentManagerWsl?: (env: import("../wsl/WslPaths").WslEnvironment | null) => void;
	/** Session command IPC error converter */
	sessionCommandIpcError?: (error: import("../../shared/types").SessionCommandError) => Error;
	/** Extension manager for pi update */
	extensionManager?: {
		checkPiUpdate: () => Promise<import("../../shared/types").PiUpdateCheckResult>;
		updatePi: () => Promise<import("../../shared/types").PiCliUpdateResult>;
	};
	/** Web service manager for restart */
	webServiceManager?: { stop: () => Promise<void> };
	/** Terminal manager for restart */
	terminalManager?: { closeAll: () => void };
	/** Is quitting flag (for restart) */
	isQuitting?: { value: boolean };
	/** Releases URL */
	RELEASES_URL?: string;
	/** 开发态 git 分支名（多 worktree 并行区分窗口）；正式包/共享分支为空。 */
	devBranch?: string;
};

export function registerSystemIpc(deps: SystemIpcDeps): void {
	const {
		piLocator,
		settingsStore,
		configManager,
		agentManager,
		skillManager,
		appLogger,
		rpcLogger,
		sessionRuntimeCoordinator,
		isDshAgent,
		setDshRpcLogging,
		isDshRpcLogging,
		modelSpecsStore,
		getMainWindow,
		mainCopy,
		checkForAppUpdate,
		downloadUpdateAsset,
		installDownloadedUpdate,
		openExternalUrl: doOpenExternalUrl,
		resolveWslEnvironment,
		reactToPetSettings,
		configureSessionScannerWsl,
		clearSessionScannerWsl,
		setFeishuLocale,
		setFeishuConfigDefaultBotName,
		refreshTrayContextMenu,
		notifyTitleBarChange,
		applyNativeThemeSource,
		applyDesktopProxy,
		testPiProxy,
		applyWebServiceSettings,
		restartWebService,
		setSessionCatalogIdentityContext,
		configureSkillManagerWsl,
		configurePromptManagerWsl,
		configureExtensionManagerWsl,
		configureConfigManagerWsl,
		configureXuePromptManagerWsl,
		configureAgentManagerWsl,
		sessionCommandIpcError,
		extensionManager,
		webServiceManager,
		terminalManager,
		isQuitting,
		RELEASES_URL,
		devBranch,
		providerMigration,
	} = deps;

	// ── Pi 检测 ──────────────────────────────────────────────────────

	ipcMain.handle(ipcChannels.piCheck, async () => {
		const settings = settingsStore.get();
		const status = await piLocator.check(settings.customPiPath, settings.wslEnabled, settings.wslDistro, settings.wslUser);
		void appLogger.info("pi", "Pi check completed", {
			installed: status.installed,
			version: status.version,
			command: status.command,
			error: status.error,
		});
		return status;
	});

	ipcMain.handle(ipcChannels.piCheckCustom, async (_event, customPath: string) => {
		const settings = settingsStore.get();
		const status = await piLocator.validateCustomPath(
			customPath,
			settings.wslEnabled,
			settings.wslDistro,
			settings.wslUser,
		);
		if (status.installed && status.command) {
			await settingsStore.update({ customPiPath: status.command });
		}
		void appLogger.info("pi", "Custom pi path checked", {
			installed: status.installed,
			version: status.version,
			command: status.command,
			error: status.error,
		});
		return status;
	});

	// ── 模型列表 ────────────────────────────────────────────────────

	ipcMain.handle(ipcChannels.projectsListModels, async (_event, _projectId?: string) => {
		try {
			// 读缓存；无缓存时后台 fork pi --list-models（含加速参数，auth 由 pi 处理）。
			const models = await fetchModelList(piLocator, settingsStore, configManager);
			void appLogger.info("pi", "Model list resolved", {
				count: models.length,
				cached: getCachedModelList() === models,
				providers: [...new Set(models.map((m) => m.provider))].slice(0, 8),
			});
			return models;
		} catch (error) {
			void appLogger.warn("pi", "Failed to list models via pi --list-models", {
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		}
	});

	// ── 模型规格（resources/model-specs.db，发版前由 sync-model-specs.mjs 同步）──

	ipcMain.handle(
		ipcChannels.projectsGetModelSpec,
		async (_event, providerName: unknown, modelId: unknown) => {
			// 边界校验：渲染层输入不可信，拒绝非字符串/超长输入
			if (
				typeof providerName !== "string" ||
				typeof modelId !== "string" ||
				providerName.length > 128 ||
				modelId.length > 256
			) {
				return null;
			}
			try {
				return (await modelSpecsStore.lookup(providerName, modelId)) ?? null;
			} catch (error) {
				void appLogger.warn("models", "Model spec lookup failed", {
					error: error instanceof Error ? error.message : String(error),
				});
				return null;
			}
		},
	);

	// ── WSL ──────────────────────────────────────────────────────────

	const wslExe = getWslExe();
	const wslExePath = wslExe.command;
	const wslShell = wslExe.shell;

	ipcMain.handle(ipcChannels.wslListDistros, async () => {
		if (process.platform !== "win32") return [] as string[];
		try {
			const { execFile } = await import("node:child_process");
			return new Promise<string[]>((resolve) => {
				execFile(wslExePath, ["-l", "-q"], { encoding: "utf8", timeout: 10_000, windowsHide: true, shell: wslShell },
					(err, stdout) => {
						if (err) { resolve([]); return; }
						const distros = stdout.split(/\r?\n/)
							.map((s) => s.trim())
							.filter((s) => s.length > 0 && !s.includes("\\") && !s.includes("\x00"));
						resolve(distros);
					});
			});
		} catch { return [] as string[]; }
	});

	ipcMain.handle(ipcChannels.wslValidateConnection, async (_event, distro: string, user: string) => {
		if (process.platform !== "win32") {
			return { ok: false, whoami: "", piVersion: "", error: mainCopy("wsl.windowsOnly") };
		}
		try {
			const { execFile } = await import("node:child_process");
			const whoami = await new Promise<string>((resolve, reject) => {
				execFile(wslExePath, ["-d", distro, "-u", user, "whoami"],
					{ encoding: "utf8", timeout: 10_000, windowsHide: true, shell: wslShell },
					(err, stdout) => {
						if (err) { reject(err); return; }
						resolve(stdout.trim());
					});
			});
			let piVersion = "";
			try {
				piVersion = await new Promise<string>((resolve, reject) => {
					execFile(wslExePath, ["-d", distro, "-u", user, "pi", "--version"],
						{ encoding: "utf8", timeout: 10_000, windowsHide: true, shell: wslShell },
						(err, stdout) => {
							if (err) { reject(err); return; }
							resolve(stdout.trim());
						});
				});
			} catch { /* pi 未安装，piVersion 保持空 */ }
			return {
				ok: true,
				whoami,
				piVersion,
				error: piVersion ? "" : mainCopy("wsl.piNotInstalled"),
			};
		} catch (err) {
			void appLogger.warn("wsl", "WSL connection validation failed", {
				distro,
				user,
				error: err instanceof Error ? err.message : String(err),
			});
			return {
				ok: false,
				whoami: "",
				piVersion: "",
				error: mainCopy("wsl.connectionFailed"),
			};
		}
	});

	// ── Pi 安装 / NPM ────────────────────────────────────────────────

	ipcMain.handle(ipcChannels.piExecInstall, async (_event, command: string): Promise<import("../../shared/types").PiInstallExecResult> => {
		void appLogger.info("pi", "Executing install command", { command });
		try {
			const { execFile } = await import("node:child_process");
			const result = await new Promise<import("../../shared/types").PiInstallExecResult>((resolve) => {
				const isWin = process.platform === "win32";
				if (isWin) {
					const child = execFile(
						process.env.ComSpec || "cmd.exe",
						["/d", "/s", "/c", command],
						{
							cwd: app.getPath("home"),
							timeout: 120_000,
							// 复用 PiLocator 搜索目录拼 PATH：桌面端继承的注册表 PATH 不含版本管理器
							// （mise/fnm/volta/scoop 等）在 shell 会话里动态注入的目录，终端可用而
							// 桌面端“找不到 npm”即源于此；前置搜索目录后 npm 才能被 cmd 解析到。
							env: { ...piLocator.createProcessEnv(), npm_config_fund: "false", npm_config_audit: "false" },
							windowsHide: true,
							encoding: "utf8",
							shell: false,
						},
						(error: unknown, stdout: string, stderr: string) => {
							const execError = error as { code?: number | string } | null;
							resolve({
								success: !error,
								exitCode: typeof execError?.code === "number" ? execError.code : execError ? -1 : 0,
								stdout: stdout || "",
								stderr: stderr || "",
							});
						},
					);
				} else {
					execFile(
						"/bin/sh",
						["-c", command],
						{
							cwd: app.getPath("home"),
							timeout: 120_000,
							env: { ...piLocator.createProcessEnv(), npm_config_fund: "false", npm_config_audit: "false" },
							encoding: "utf8",
						},
						(error: unknown, stdout: string, stderr: string) => {
							const execError = error as { code?: number | string } | null;
							resolve({
								success: !error,
								exitCode: typeof execError?.code === "number" ? execError.code : execError ? -1 : 0,
								stdout: stdout || "",
								stderr: stderr || "",
							});
						},
					);
				}
			});
			void appLogger.info("pi", "Install command completed", {
				success: result.success,
				exitCode: result.exitCode,
				stdoutLength: result.stdout.length,
				stderrLength: result.stderr.length,
			});
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void appLogger.error("pi", "Install command threw", { error: message });
			return { success: false, exitCode: -1, stdout: "", stderr: message };
		}
	});

	ipcMain.handle(ipcChannels.piCheckNpm, async (): Promise<import("../../shared/types").NpmAvailabilityResult> => {
		try {
			const { execFile } = await import("node:child_process");
			const result = await new Promise<import("../../shared/types").NpmAvailabilityResult>((resolve) => {
				const isWin = process.platform === "win32";
				if (isWin) {
					execFile(
						process.env.ComSpec || "cmd.exe",
						["/d", "/s", "/c", "npm --version"],
						{
							// 同 piExecInstall：npm 可能只存在于版本管理器动态目录中，
							// 必须用 PiLocator 搜索目录（含注册表 PATH）重建子进程 PATH。
							env: piLocator.createProcessEnv(),
							timeout: 10_000, encoding: "utf8", windowsHide: true, shell: false,
						},
						(error, stdout) => {
							if (error) {
								resolve({ available: false, error: error.message });
							} else {
								resolve({ available: true, version: stdout.trim() });
							}
						},
					);
				} else {
					execFile(
						"npm",
						["--version"],
						{
							// 非 Windows：/bin/sh -lc 已能拿到登录 shell PATH；仍叠加搜索目录
							// 兜底 GUI 启动时 Homebrew/fnm/mise 等动态路径缺失的场景。
							env: piLocator.createProcessEnv(),
							timeout: 10_000, encoding: "utf8",
						},
						(error, stdout) => {
							if (error) {
								resolve({ available: false, error: error.message });
							} else {
								resolve({ available: true, version: stdout.trim() });
							}
						},
					);
				}
			});
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { available: false, error: message };
		}
	});

	// ── Pi 更新 ──────────────────────────────────────────────────────

	if (extensionManager) {
		ipcMain.handle(ipcChannels.piUpdateCheck, async () => {
			const result = await extensionManager.checkPiUpdate();
			void appLogger.info("pi", "Pi update check completed", { currentVersion: result.currentVersion, latestVersion: result.latestVersion, hasUpdate: result.hasUpdate, error: result.error });
			return result;
		});
		ipcMain.handle(ipcChannels.piUpdate, async () => {
			const result = await extensionManager.updatePi();
			void appLogger.info("pi", "Pi update command completed", { updated: result.updated, bytes: result.output.length });
			return result;
		});
	}

	// ── 应用信息 ─────────────────────────────────────────────────────

	ipcMain.handle(ipcChannels.appInfo, () => ({
		version: app.getVersion(),
		releasesUrl: RELEASES_URL ?? "https://github.com/ayuayue/pi-desktop/releases",
		platform: process.platform,
		devBranch: devBranch,
	}));

	ipcMain.handle(ipcChannels.appNetworkAddresses, () => listWebNetworkAddresses());

	ipcMain.handle(ipcChannels.appPreferredSystemLanguages, () => {
		try { return app.getPreferredSystemLanguages(); } catch { return []; }
	});

	// ── 应用更新 ─────────────────────────────────────────────────────

	ipcMain.handle(ipcChannels.appCheckUpdate, () =>
		checkForAppUpdate(settingsStore.get().installationType),
	);
	ipcMain.handle(ipcChannels.appDownloadUpdate, async (_event, asset: AppUpdateAsset) =>
		downloadUpdateAsset(asset),
	);
	ipcMain.handle(ipcChannels.appInstallUpdate, async (_event, filePath: string) =>
		installDownloadedUpdate(filePath),
	);

	// ── 应用日志 ─────────────────────────────────────────────────────

	// 进程监控：Electron 各进程 + pi agent 子进程内存/CPU 快照（手动刷新，不做高频轮询）
	ipcMain.handle(ipcChannels.processMetrics, async (): Promise<ProcessMetricsSnapshot> => {
		const agents: Array<Pick<AgentProcessMetric, "agentId" | "pid" | "kind" | "sessionId" | "sessionTitle" | "sessionTitles">> =
			deps.agentManager.listAgentPids().map((agent) => {
				// 进程监控表展示会话身份：按 agentId 反查关联的会话 id/标题，
				// 让用户知道每个 agent 对应哪个会话（而不是只看到内部 id）
				const sessionInfo = deps.sessionRuntimeCoordinator.getSessionInfoForAgent(
					agent.agentId,
				);
				return { ...agent, kind: "pi" as const, ...(sessionInfo ?? {}) };
			});
		// DSH 会话共享一个 utilityProcess：有 pid 时追加一行，不按会话伪造多个 pid。
		const dshPid = deps.getDshHostPid?.();
		if (dshPid) {
			agents.push(buildDshHostMonitorRow({
				pid: dshPid,
				sessions: deps.listDshMonitorSessions?.() ?? [],
			}));
		}
		return getProcessSnapshot(agents);
	});

	ipcMain.handle(ipcChannels.stopAgent, async (_event, agentId: unknown) => {
		// 输入校验：agentId 必须是字符串，否则拒绝（渲染层数据不可信）
		if (typeof agentId !== "string" || !agentId) {
			throw new Error("invalid agentId");
		}
		// DSH host 行：停全部 DSH 会话 + dispose utilityProcess，不能当 pi agentId。
		if (isDshHostMonitorId(agentId)) {
			if (!deps.stopDshHostFromMonitor) {
				throw new Error("DSH host stop is not available");
			}
			const hostResult = await deps.stopDshHostFromMonitor();
			if (!hostResult.ok) {
				throw new Error(hostResult.error.debugDetails ?? "failed to stop DSH host");
			}
			return;
		}
		// 走完整会话停止链路（coordinator 反查会话 + 解绑 + detach 推送），
		// 不能只调 agentManager.stop——那会跳过会话状态收尾，渲染层运行标记不熄灭
		const result = await deps.stopAgentFromMonitor(agentId);
		if (!result.ok) {
			throw new Error(result.error.debugDetails ?? `failed to stop agent ${agentId}`);
		}
	});

	ipcMain.handle(ipcChannels.logsList, async (_event, query: AppLogQuery) =>
		appLogger.list(query),
	);
	ipcMain.handle(ipcChannels.logsListPage, async (_event, query: AppLogQuery) =>
		appLogger.listPage(query),
	);
	ipcMain.handle(ipcChannels.rendererLog, async (
		_event, level: AppLogLevel, scope: string, message: string, detail?: unknown,
	) => {
		const safeLevel = ["debug", "info", "warn", "error"].includes(level) ? level : "info";
		await appLogger.log(safeLevel as AppLogLevel, scope, message, detail);
	});
	ipcMain.on(ipcChannels.preloadReady, (event) => {
		void appLogger.info("app", "Preload API exposed", { url: event.sender.getURL() });
	});
	ipcMain.on(ipcChannels.preloadError, (event, detail) => {
		void appLogger.error("app", "Preload API expose failed", { url: event.sender.getURL(), detail });
	});
	ipcMain.handle(ipcChannels.logsClear, async () => appLogger.clear());
	ipcMain.handle(ipcChannels.logsOpenFolder, async () => appLogger.openFolder());
	ipcMain.handle(ipcChannels.logsSize, async () => appLogger.getSize());

	// ── RPC 日志 ─────────────────────────────────────────────────────

	const resolveRpcRuntimeAgent = (target?: SessionRuntimeTarget) => {
		if (!target) return undefined;
		const validated = sessionRuntimeCoordinator.validateTarget(target);
		if (!validated.ok) {
			if (sessionCommandIpcError) throw sessionCommandIpcError((validated as { ok: false; error: import("../../shared/types").SessionCommandError }).error);
			return undefined;
		}
		return target.agentId;
	};

	ipcMain.handle(ipcChannels.rpcLogsGetSize, async (_event, target?: SessionRuntimeTarget) =>
		rpcLogger.getSize(resolveRpcRuntimeAgent(target)),
	);
	ipcMain.handle(ipcChannels.rpcLogsGet, async (_event, options?: { target?: SessionRuntimeTarget; days?: number; limit?: number }) =>
		rpcLogger.getFromFile({ agentId: resolveRpcRuntimeAgent(options?.target), days: options?.days, limit: options?.limit }),
	);
	// 实时查看弹窗的初始历史：直接读主进程环形缓冲，不读磁盘
	ipcMain.handle(ipcChannels.rpcLogsGetLive, async (_event, agentId?: string) =>
		rpcLogger.getLive(typeof agentId === "string" ? agentId : undefined),
	);
	// 实时查看弹窗“保存到文件”：直接合并写入该 agent 的自动日志文件（按 id 去重），
	// 不再弹目录选择——开启记录后日志本就自动落盘，保存只是把弹窗内容对齐到文件。
	// 返回实际写入的文件路径列表，供渲染层 toast 提示用户保存位置。
	// 渲染层传来的条目不可信，数量与字段都要校验。
	ipcMain.handle(ipcChannels.rpcLogsSave, async (_event, options?: { entries?: unknown }) => {
		const rawEntries = Array.isArray(options?.entries) ? options.entries : [];
		const entries = rawEntries
			.slice(0, 10_000) // 上限：防止一次 IPC 携带超大批次
			.filter((value): value is RpcLogEntry => isRpcLogEntry(value));
		if (entries.length === 0) return [];
		return rpcLogger.appendEntries(entries);
	});
	ipcMain.handle(ipcChannels.rpcLogsClear, async (_event, target?: SessionRuntimeTarget) =>
		rpcLogger.clear(resolveRpcRuntimeAgent(target)),
	);
	ipcMain.handle(ipcChannels.rpcLoggingSet, async (_event, target: SessionRuntimeTarget, enabled: boolean) => {
		const agentId = resolveRpcRuntimeAgent(target);
		if (!agentId) return enabled;
		// G17：DSH 会话的 RPC 日志走 DshAgentManager（领域调用记录），pi 走 AgentManager。
		if (isDshAgent?.(agentId)) {
			setDshRpcLogging?.(agentId, enabled);
		} else {
			agentManager.setRpcLogging(agentId, enabled);
		}
		return enabled;
	});
	ipcMain.handle(ipcChannels.rpcLoggingGet, async (_event, target: SessionRuntimeTarget) => {
		const agentId = resolveRpcRuntimeAgent(target);
		if (!agentId) return false;
		if (isDshAgent?.(agentId)) {
			return isDshRpcLogging?.(agentId) ?? false;
		}
		return agentManager.isRpcLogging(agentId);
	});

	// ── 反馈环境 ─────────────────────────────────────────────────────

	ipcMain.handle(ipcChannels.appFeedbackEnvironment, async () => {
		const settings = settingsStore.get();
		const pi = await piLocator.check(
			settings.customPiPath,
			settings.wslEnabled,
			settings.wslDistro,
			settings.wslUser,
		);
		return {
			appVersion: app.getVersion(),
			platform: process.platform,
			arch: process.arch,
			electronVersion: process.versions.electron ?? "",
			chromeVersion: process.versions.chrome ?? "",
			nodeVersion: process.versions.node,
			pi,
		};
	});

	// ── 外部链接 / 重启 / 窗口控制 ──────────────────────────────────

	ipcMain.handle(ipcChannels.appOpenExternal, async (_event, url: string, forceSystem?: boolean) => {
		await doOpenExternalUrl(url, forceSystem);
	});

	ipcMain.handle(ipcChannels.appRestart, async () => {
		if (isQuitting) isQuitting.value = true;
		await webServiceManager?.stop();
		terminalManager?.closeAll();
		agentManager?.stopAll();
		app.relaunch();
		app.quit();
	});

	const mainWindow = getMainWindow();

	ipcMain.handle(ipcChannels.appWindowMinimize, () => {
		const win = getMainWindow();
		if (!win || win.isDestroyed()) return;
		win.minimize();
	});
	/**
	 * 最大化态以本进程跟踪为准，不用「调用后立刻 isMaximized()」。
	 * Windows + 无边框上 maximize/unmaximize 后同步读 isMaximized() 常仍是旧值；
	 * 若再把该旧值经 IPC/事件推回渲染层，会与按钮意图互踩 → 表现为要点两次。
	 */
	const wiredMaximizeWindows = new WeakSet<Electron.BrowserWindow>();
	const maximizedByWindow = new WeakMap<Electron.BrowserWindow, boolean>();
	const emitMaximizedState = (win: Electron.BrowserWindow, maximized: boolean) => {
		if (win.isDestroyed()) return;
		maximizedByWindow.set(win, maximized);
		win.webContents.send(ipcChannels.appWindowMaximizedChanged, maximized);
	};
	const wireMaximizeEvents = (win: Electron.BrowserWindow) => {
		if (wiredMaximizeWindows.has(win)) return;
		wiredMaximizeWindows.add(win);
		maximizedByWindow.set(win, win.isMaximized());
		// 信事件名，不信事件回调里再读 isMaximized()（同一帧可能仍为旧值）。
		win.on("maximize", () => emitMaximizedState(win, true));
		win.on("unmaximize", () => emitMaximizedState(win, false));
	};
	const readMaximized = (win: Electron.BrowserWindow): boolean =>
		maximizedByWindow.get(win) ?? win.isMaximized();
	ipcMain.handle(ipcChannels.appWindowToggleMaximize, () => {
		const win = getMainWindow();
		if (!win || win.isDestroyed()) return false;
		wireMaximizeEvents(win);
		const nextMaximized = !readMaximized(win);
		if (nextMaximized) win.maximize();
		else win.unmaximize();
		// 先写入意图态并推送：不依赖异步事件到达顺序，一次点击即可对齐图标。
		emitMaximizedState(win, nextMaximized);
		return nextMaximized;
	});
	ipcMain.handle(ipcChannels.appWindowIsMaximized, () => {
		const win = getMainWindow();
		if (!win || win.isDestroyed()) return false;
		wireMaximizeEvents(win);
		return readMaximized(win);
	});
	{
		const win = getMainWindow();
		if (win && !win.isDestroyed()) wireMaximizeEvents(win);
	}
	ipcMain.handle(ipcChannels.appWindowToggleAlwaysOnTop, () => {
		const win = getMainWindow();
		if (!win || win.isDestroyed()) return false;
		const next = !win.isAlwaysOnTop();
		win.setAlwaysOnTop(next, "floating");
		return next;
	});
	ipcMain.handle(ipcChannels.appWindowClose, () => {
		const win = getMainWindow();
		if (!win || win.isDestroyed()) return;
		win.close();
	});

	// ── 设置 ─────────────────────────────────────────────────────────

	ipcMain.handle(ipcChannels.settingsGet, () => settingsStore.get());

	ipcMain.handle(ipcChannels.settingsUpdate, async (_event, patch: Partial<AppSettings>) => {
		const prevSettings = settingsStore.get();
		const settings = await settingsStore.update(patch);
		// 设置变更审计已下沉到 SettingsStore.update 内部统一留痕（覆盖所有直写路径），此处不重复记录

		if (typeof reactToPetSettings === "function") {
			await reactToPetSettings(prevSettings, settings);
		}
		if (
			"desktopProxyEnabled" in patch ||
			"desktopProxyUrl" in patch ||
			"desktopProxyBypass" in patch
		) {
			if (applyDesktopProxy) await applyDesktopProxy(settings);
		}
		if ("theme" in patch) {
			if (applyNativeThemeSource) applyNativeThemeSource(settings);
		}
		if ("language" in patch) {
			if (setFeishuLocale) setFeishuLocale(undefined);
			if (setFeishuConfigDefaultBotName) setFeishuConfigDefaultBotName("");
			if (refreshTrayContextMenu) refreshTrayContextMenu();
		}
		if ("useNativeTitleBar" in patch) {
			if (notifyTitleBarChange) notifyTitleBarChange(getMainWindow()!);
		}
		if ("zoomFactor" in patch) {
			getMainWindow()?.webContents.setZoomFactor(settings.zoomFactor);
		}
		if (
			"webServiceEnabled" in patch ||
			"webServiceHost" in patch ||
			"webServicePort" in patch
		) {
			try {
				if (applyWebServiceSettings) await applyWebServiceSettings(settings);
			} catch (error) {
				const debugDetails = error instanceof Error ? error.message : String(error);
				void appLogger.warn("web", "Failed to apply web service settings", { error: debugDetails });
				if (settings.webServiceEnabled) {
					await settingsStore.update({ webServiceEnabled: false });
				}
				throw new Error(mainCopy(
					debugDetails === "WEB_SERVICE_INVALID_PORT"
						? "webService.invalidPort"
						: "webService.startFailed",
				));
			}
		}
		// WSL 设置变更时同步更新会话扫描器和配置管理器
		if ("wslEnabled" in patch || "wslDistro" in patch || "wslUser" in patch) {
			if (setSessionCatalogIdentityContext) {
				setSessionCatalogIdentityContext(
					settings.wslEnabled
						? { wslDistro: settings.wslDistro, wslUser: settings.wslUser }
						: {},
				);
			}
			if (settings.wslEnabled && settings.wslDistro && settings.wslUser && resolveWslEnvironment) {
				const environment = await resolveWslEnvironment(settings.wslDistro, settings.wslUser, {
					warn: (msg: string, detail: unknown) => console.warn("[PiDeck] " + String(msg), detail),
				});
				if (configureSessionScannerWsl) await configureSessionScannerWsl(environment);
				if (configureSkillManagerWsl) configureSkillManagerWsl(environment);
				if (configurePromptManagerWsl) configurePromptManagerWsl(environment);
				if (configureExtensionManagerWsl) configureExtensionManagerWsl(environment);
				if (configureConfigManagerWsl) configureConfigManagerWsl(environment);
				if (configureXuePromptManagerWsl) configureXuePromptManagerWsl(environment);
				if (configureAgentManagerWsl) configureAgentManagerWsl(environment);
			} else {
				if (clearSessionScannerWsl) clearSessionScannerWsl();
				if (configureSkillManagerWsl) configureSkillManagerWsl(null);
				if (configurePromptManagerWsl) configurePromptManagerWsl(null);
				if (configureExtensionManagerWsl) configureExtensionManagerWsl(null);
				if (configureConfigManagerWsl) configureConfigManagerWsl(null);
				if (configureXuePromptManagerWsl) configureXuePromptManagerWsl(null);
				if (configureAgentManagerWsl) configureAgentManagerWsl(null);
			}
		}
		return settings;
	});

	ipcMain.handle(ipcChannels.settingsRestartWebService, async () => {
		if (!restartWebService) throw new Error("restartWebService not available");
		await restartWebService(settingsStore.get());
	});

	ipcMain.handle(ipcChannels.settingsTestPiProxy, async () => {
		if (!testPiProxy) throw new Error("testPiProxy not available");
		const result = await testPiProxy(settingsStore.get(), undefined, mainCopy);
		void appLogger.info("settings", "Pi proxy tested", {
			success: result.success,
			elapsedMs: result.elapsedMs,
			statusCode: result.statusCode,
			error: result.error,
		});
		return result;
	});

	// ── Skills CRUD ──────────────────────────────────────────────────

	ipcMain.handle(ipcChannels.skillsList, () => skillManager.list());
	ipcMain.handle(ipcChannels.skillsCreate, async (_event, input: CreatePiSkillInput) => {
		const result = await skillManager.create(input);
		void appLogger.info("skill", "Skill created", { name: input.name, locationId: input.locationId });
		return result;
	});
	ipcMain.handle(ipcChannels.skillsToggle, async (_event, path: string, enabled: boolean) => {
		const result = await skillManager.toggle(path, enabled);
		void appLogger.info("skill", "Skill toggled", { path, enabled });
		return result;
	});
	ipcMain.handle(ipcChannels.skillsDelete, async (_event, path: string) => {
		const result = await skillManager.delete(path);
		void appLogger.info("skill", "Skill deleted", { path });
		return result;
	});
	ipcMain.handle(ipcChannels.skillsOpenFolder, (_event, path?: string) =>
		skillManager.openFolder(path),
	);

	// ── 配置管理 ─────────────────────────────────────────────────────

	ipcMain.handle(ipcChannels.configGetModels, () =>
		configManager.getModelsConfig(),
	);
	// 预览/执行单供应商互迁：方向必须是枚举，供应商名在服务层再校验。
	ipcMain.handle(ipcChannels.configPreviewProviderMigration, async (_event, direction: unknown) => {
		if (direction !== "pi-to-dsh" && direction !== "dsh-to-pi") {
			throw new Error("invalid migration direction");
		}
		if (!providerMigration) throw new Error("provider migration is not available");
		return previewProviderMigration(providerMigration, direction as ProviderMigrationDirection);
	});
	ipcMain.handle(ipcChannels.configApplyProviderMigration, async (_event, direction: unknown, provider: unknown) => {
		if (direction !== "pi-to-dsh" && direction !== "dsh-to-pi") {
			throw new Error("invalid migration direction");
		}
		if (typeof provider !== "string") throw new Error("invalid provider name");
		if (!providerMigration) throw new Error("provider migration is not available");
		const result = await applyProviderMigration(providerMigration, direction as ProviderMigrationDirection, provider);
		if (result.ok && direction === "dsh-to-pi") {
			invalidateModelListCache();
			void refreshModelList(piLocator, settingsStore, configManager).catch(() => undefined);
		}
		void appLogger.info("config", "Provider migration applied", {
			direction,
			provider,
			ok: result.ok,
			copiedKey: result.copiedKey,
			wroteViaHost: result.wroteViaHost,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.configGetAuth, () =>
		configManager.getAuthConfig(),
	);
	ipcMain.handle(ipcChannels.configGetSettings, () =>
		configManager.getSettingsConfig(),
	);
	ipcMain.handle(ipcChannels.configGetTrust, () =>
		configManager.getTrustConfig(),
	);
	ipcMain.handle(ipcChannels.projectsTrustResponse,
		(_event, requestId: string, choice: "trust-remember" | "trust-session" | "deny") =>
			agentManager.respondTrustRequest(requestId, choice),
	);
	ipcMain.handle(ipcChannels.configSaveModels, async (_event, data) => {
		const result = await configManager.saveModelsConfig(data);
		invalidateModelListCache();
		// 配置保存后立即后台重取，下次打开选择器直接命中新缓存。
		void refreshModelList(piLocator, settingsStore, configManager).catch(() => undefined);
		void appLogger.info("config", "Models config saved", { providerCount: Object.keys(data?.providers ?? {}).length });
		return result;
	});
	ipcMain.handle(ipcChannels.configSaveAuth, async (_event, data) => {
		const result = await configManager.saveAuthConfig(data);
		invalidateModelListCache();
		// auth 影响「可用模型」过滤（pi 只列已认证 provider），保存后同样后台重取。
		void refreshModelList(piLocator, settingsStore, configManager).catch(() => undefined);
		void appLogger.info("config", "Auth config saved", { authCount: Object.keys(data ?? {}).length });
		return result;
	});
	ipcMain.handle(ipcChannels.configSaveSettings, async (_event, settings) => {
		const result = await configManager.saveSettingsConfig(settings);
		void appLogger.info("config", "Pi settings config saved", { keys: Object.keys(settings ?? {}) });
		return result;
	});
	ipcMain.handle(ipcChannels.configSaveRaw, async (_event, fileName, rawJson) => {
		const result = await configManager.saveRawConfig(fileName, rawJson);
		void appLogger.info("config", "Raw config saved", { fileName, bytes: Buffer.byteLength(rawJson, "utf8") });
		return result;
	});
	ipcMain.handle(ipcChannels.configExport, () =>
		configManager.exportConfig(),
	);
	ipcMain.handle(ipcChannels.configImport, async (_event, packageJson: string) => {
		const result = await configManager.importConfig(packageJson);
		void appLogger.info("config", "Config imported", { bytes: Buffer.byteLength(packageJson, "utf8"), valid: result.valid });
		return result;
	});
	ipcMain.handle(ipcChannels.configFetchModels, async (
		_event,
		payload: { baseUrl: string; apiKey: string; apiType?: string },
	) => {
		const result = await configManager.fetchProviderModels(payload.baseUrl, payload.apiKey, payload.apiType);
		void appLogger.info("config", "Provider models fetched", {
			baseUrl: payload.baseUrl,
			apiType: payload.apiType,
			modelCount: Array.isArray(result) ? result.length : undefined,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.configTestProvider, async (
		_event,
		payload: { baseUrl: string; apiKey: string; modelId: string; apiType?: string; headers?: Record<string, string> },
	) => {
		const result = await configManager.testProviderConnection(
			payload.baseUrl, payload.apiKey, payload.modelId, payload.apiType, payload.headers,
		);
		void appLogger.info("config", "Provider connection tested", {
			baseUrl: payload.baseUrl,
			apiType: payload.apiType,
			modelId: payload.modelId,
			success: result.success,
			error: result.error,
		});
		return result;
	});

	// ── 开发者控制台 ─────────────────────────────────────────────────

	ipcMain.handle(ipcChannels.appToggleDevTools, () => toggleMainWindowDevTools(getMainWindow()));
}
