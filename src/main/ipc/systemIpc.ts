/**
 * System IPC handlers: pi check/exec, WSL, model list, logging, config, app update, dev tools.
 * Phase 3.7: extracted from src/main/index.ts registerIpc().
 */

import { app, ipcMain, shell } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { UPDATE_REPO, UPDATE_REPO_OWNER } from "../update/releaseRepo";
import { probeAllMirrors, type MirrorHealthResult } from "../update/mirrorHealth";
import type { RpcLogEntry } from "../../shared/types/rpcLog";
import type {
	AppLogLevel,
	AppLogQuery,
	AppSettings,
	AvailableModel,
	ModelListReport,
	CreatePiSkillInput,
	SessionCommandResult,
	SessionRuntimeTarget,
} from "../../shared/types";
import type { PiLocator } from "../pi/PiLocator";
import type { SettingsStore } from "../settings/SettingsStore";
import type { ConfigManager, PiModelsFile } from "../config/ConfigManager";
import type { AgentManager } from "../pi/AgentManager";
import type { AppLogger } from "../logging/AppLogger";
import type { RpcLogger } from "../logging/RpcLogger";
import type { SessionRuntimeCoordinator } from "../sessions/SessionRuntimeCoordinator";
import { resolveConfigProxyTarget } from "../sessions/sessionProxyPolicy";
import type { ConfigProxyMode } from "../../shared/types/fetchedModel";
import type { SkillManager } from "../skills/SkillManager";
import { fetchModelList, getCachedModelList, invalidateModelListCache, refreshModelCatalogStore, refreshModelList, resolveModelListReport } from "../pi/modelListCache";
import { mergeTokenDanceModels, type TokendanceCatalogStore } from "../config/tokendanceCatalog";

import { probePiModel } from "../pi/PiModelProber";
import type { PiModelCapabilityCache } from "../pi/PiModelCapabilityCache";
import { getPiAiCatalogIndex } from "../pi/piAiBuiltinCatalog";
import { resolveModelSpecFromCatalogs } from "../pi/modelCapabilityResolver";
import { getProcessSnapshot } from "../process/ProcessMonitor";
import { buildDshHostMonitorRow, isDshHostMonitorId } from "../process/dshHostMonitor";
import type { AgentProcessMetric, DiagnosticsSnapshot, ProcessMetricsSnapshot } from "../../shared/types";
import type { DiagnosticsMonitor } from "../diagnostics/DiagnosticsMonitor";
import { getWslExe } from "../wsl/wslExe";
import { listWebNetworkAddresses } from "../web/WebNetwork";
import { toggleMainWindowDevTools } from "../devTools";
import {
	applyProviderMigration,
	previewProviderMigration,
	type ProviderMigrationDeps,
} from "../config/providerMigrationService";
import { USAGE_PROBE_CANDIDATES } from "../config/providerUsageProbe";
import { saveUsageProbeForProvider } from "../config/userUsageProbes";
import type {
	UsageProbeProviderConfig,
	UsageProbeTestInput,
} from "../../shared/types/providerUsage";
import type { ProviderMigrationDirection } from "../../shared/types/providerMigration";
import type { McpConfigFile, McpServerDefinition } from "../../shared/types/mcp";
import type {
	HealthExportResult,
	HealthReport,
	HealthReportContext,
	HealthReportFormat,
} from "../../shared/types";
import type { EnvironmentDoctor } from "../health/EnvironmentDoctor";
import type { LogBundleExporter } from "../health/LogBundleExporter";

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
	/** 开发诊断采样（设置开关热启停） */
	diagnosticsMonitor?: DiagnosticsMonitor;
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
	/** 全局 Pi 模型 capability snapshot（启动/配置变更时 hydration，picker 只读）。 */
	modelCapabilityCache: PiModelCapabilityCache;
	/** 内置 TokenDance 模型目录（live fetch + userData 缓存）；未装配 = 列表不注入。 */
	tokendanceCatalog?: TokendanceCatalogStore;
	/** 环境体检编排器（问题反馈页一键排障）。 */
	environmentDoctor?: EnvironmentDoctor;
	/** 诊断产物导出器（Markdown / zip 日志包）。 */
	logBundleExporter?: LogBundleExporter;
	getMainWindow: () => Electron.BrowserWindow | null;
	mainCopy: (key: string, params?: Record<string, string | number>) => string;
	/** Check for app update（index.ts 注入：直接触发 UpdateService.checkNow，结果经快照推送）。 */
	checkForAppUpdate: () => Promise<void>;
	/** 手动下载已检测到的更新（autoDownload 关闭时由设置页触发）。 */
	downloadAppUpdate: () => Promise<void>;
	/** 重启并安装已下载的更新（electron-updater quitAndInstall）。 */
	installAppUpdate: () => void;
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
	/** 读取技能 SKILL.md 正文（装配层注入：路径白名单校验由 readSkillContent 完成）。 */
	readSkillContent?: (
		skillPath: string,
	) => Promise<import("../../shared/types").SkillContentResult>;
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
	/** 后台更新检查服务（定时检查快照推送 / 已提示 / 跳过版本 / 立即检查 / 下载 / 安装）。 */
	updateService?: {
		getSnapshot: () => import("../../shared/types").AppUpdateStatusSnapshot;
		notifySeen: (kind: "app" | "pi", version: string) => Promise<void>;
		skipVersion: (version: string) => Promise<void>;
		checkNow: () => Promise<void>;
		downloadNow: () => Promise<void>;
		installNow: () => void;
		applyAutoDownloadPreference: () => void;
		/** 更新源切换（设置保存后调用）：镜像/自定义 → generic feed URL，回 github → 原生通道。 */
		applyUpdateSource: () => void;
	};
};

// 渲染层传入的代理模式收窄：非白名单一律回退 follow（跟随全局），保证 IPC 边界不信任任意字符串。
function asConfigProxyMode(raw: unknown): ConfigProxyMode {
	return raw === "pi" || raw === "desktop" || raw === "off" ? raw : "follow";
}

/**
 * 把内置 TokenDance 目录并入模型列表（读取缓存/拉取，失败静默保持原列表）。
 * 注入是“展示层”行为：pi 运行时会话仍按 pi 自己的 models.json 解析 provider，
 * 所以列表已含 tokendance 组（用户已保存到 pi 配置）时不会再塞一份。
 */
async function withTokenDanceModels(
	models: AvailableModel[],
	catalog?: TokendanceCatalogStore,
): Promise<AvailableModel[]> {
	if (!catalog) return models;
	try {
		const result = await catalog.getModels();
		return result ? mergeTokenDanceModels(models, result.models) : models;
	} catch {
		return models;
	}
}

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
		getMainWindow,
		mainCopy,
		checkForAppUpdate,
		downloadAppUpdate,
		installAppUpdate,
		openExternalUrl: doOpenExternalUrl,
		resolveWslEnvironment,
		reactToPetSettings,
		configureSessionScannerWsl,
		clearSessionScannerWsl,
		setFeishuLocale,
		setFeishuConfigDefaultBotName,
		refreshTrayContextMenu,
		updateService,
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
		readSkillContent,
		extensionManager,
		webServiceManager,
		terminalManager,
		isQuitting,
		RELEASES_URL,
		devBranch,
		providerMigration,
		modelCapabilityCache,
		tokendanceCatalog,
		diagnosticsMonitor,
		environmentDoctor,
		logBundleExporter,
	} = deps;

	/**
	 * Models/auth 的任何写入都必须同时失效 CLI fallback 与 Pi-authoritative
	 * capability snapshot。cache 自己按 generation 丢弃旧 probe 的迟到结果。
	 */
	const refreshPiModelCatalogs = async (): Promise<void> => {
		invalidateModelListCache();
		const snapshot = await modelCapabilityCache.refresh();
		if (snapshot) return;
		// 旧 Pi 没有 capability RPC 时，仍预热原有的兼容模型列表。
		await refreshModelList(piLocator, settingsStore, configManager).catch(() => undefined);
	};

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
			void refreshPiModelCatalogs().catch(() => undefined);
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
			const snapshot = await modelCapabilityCache.ensure();
			const models = snapshot?.models ?? await fetchModelList(piLocator, settingsStore, configManager);
			void appLogger.info("pi", "Model list resolved", {
				count: models.length,
				capabilitiesReady: snapshot !== null,
				providers: [...new Set(models.map((m) => m.provider))].slice(0, 8),
			});
			// 内置 TokenDance 目录注入（未配置/拉取失败静默保持原列表）
			return await withTokenDanceModels(models, tokendanceCatalog);
		} catch (error) {
			void appLogger.warn("pi", "Failed to resolve model list", {
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		}
	});

	ipcMain.handle(ipcChannels.projectsListModelsReport, async (_event, projectId: unknown, force: unknown) => {
		// 边界校验：渲染层入参不可信；projectId 仅透传（当前实现未使用），force 必须为布尔。
		const projectIdArg =
			typeof projectId === "string" && projectId.length <= 256 ? projectId : undefined;
		const forceArg = force === true;
		try {
			// 手动刷新（force）：先强制刷新 pi 模型目录缓存（pi update --models，
			// force 绕过 4h 磁盘节流——官方 provider 新模型立刻可见），成功后再重新
			// hydration。目录刷新失败（无网络/超时）不阻塞：退回读盘 hydration，
			// 旧目录也能刷新列表，刷新按钮不因网络问题报错。
			if (forceArg) {
				const catalogRefreshed = await refreshModelCatalogStore(piLocator, settingsStore);
				void appLogger.info("pi", "Model catalog force refresh on manual reload", {
					ok: catalogRefreshed,
				});
			}
			const snapshot = forceArg
				? await modelCapabilityCache.refresh()
				: await modelCapabilityCache.ensure();
			const report: ModelListReport = snapshot && snapshot.models.length > 0
				? {
					models: snapshot.models,
					ok: true,
					reason: null,
					version: null,
					detail: "",
					source: "cache",
					at: Date.now(),
				}
				: await resolveModelListReport(
					piLocator,
					settingsStore,
					configManager,
					forceArg,
				);
			// 内置 TokenDance 目录注入（已含 tokendance 组 / 未装配 / 拉取失败都不改变报告）
			const merged = await withTokenDanceModels(report.models, tokendanceCatalog);
			if (merged.length !== report.models.length) {
				void appLogger.info("pi", "TokenDance models injected into report", {
					added: merged.length - report.models.length,
				});
			}
			report.models = merged;
			void appLogger.info("pi", "Model list report resolved", {
				ok: report.ok,
				reason: report.reason,
				count: report.models.length,
				source: report.source,
				forced: forceArg,
			});
			return report;
		} catch (error) {
			// resolveModelListReport 内部吞掉大部分异常；兜底返回失败报告，不让渲染层拿到裸异常。
			void appLogger.warn("pi", "Model list report failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return {
				models: [],
				ok: false,
				reason: "cli-failed",
				version: null,
				detail: error instanceof Error ? error.message : String(error),
				source: "none",
				at: Date.now(),
			};
		}
	});

	// ── 模型规格（官方目录 + 当前 Pi 完整目录；第三方 provider 按模型本体匹配）──

	ipcMain.handle(
		ipcChannels.projectsGetModelSpec,
		async (_event, providerName: unknown, modelId: unknown, modelName: unknown) => {
			// 边界校验：渲染层输入不可信，拒绝非字符串/超长输入。
			if (
				typeof providerName !== "string" ||
				typeof modelId !== "string" ||
				(modelName !== undefined && typeof modelName !== "string") ||
				providerName.length > 128 ||
				modelId.length > 256 ||
				(typeof modelName === "string" && modelName.length > 256)
			) {
				return null;
			}
			try {
				// 配置阶段模板优先读运行中 pi 的模型列表（pi --list-models 已含内置目录 +
				// auth.json/models.json 覆盖后的解析容量），bundled pi-ai catalog 兜底。
				// 只读缓存不触发新 fork：启动预取（index.ts refreshModelList）已填充，
				// 保存 models.json/auth.json 后也由 invalidateModelListCache 置空并重取。
				const runtimeModels = getCachedModelList() ?? undefined;
				return resolveModelSpecFromCatalogs(
					{
						providerName,
						modelId,
						...(typeof modelName === "string" && modelName.trim() ? { modelName } : {}),
					},
					getPiAiCatalogIndex(),
					runtimeModels,
				);
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
			if (result.updated) void refreshPiModelCatalogs().catch(() => undefined);
			void appLogger.info("pi", "Pi update command completed", { updated: result.updated, bytes: result.output.length });
			return result;
		});
	}

	// ── 应用信息 ─────────────────────────────────────────────────────

	ipcMain.handle(ipcChannels.appInfo, () => ({
		version: app.getVersion(),
		releasesUrl: RELEASES_URL ?? `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO}/releases`,
		platform: process.platform,
		// 数据目录直接取实际生效路径：便携版（exe 同级 data/）、安装版、dev 模式（-dev 后缀）由主进程统一解析
		userDataDir: app.getPath("userData"),
		devBranch: devBranch,
	}));

	ipcMain.handle(ipcChannels.appNetworkAddresses, () => listWebNetworkAddresses());

	ipcMain.handle(ipcChannels.appPreferredSystemLanguages, () => {
		try { return app.getPreferredSystemLanguages(); } catch { return []; }
	});

	// ── 应用更新（electron-updater 事件驱动；结果统一经 app:update-status-changed 快照推送）──

	ipcMain.handle(ipcChannels.appCheckUpdate, async () => {
		await updateService?.checkNow();
	});
	ipcMain.handle(ipcChannels.appDownloadUpdate, async () => {
		await updateService?.downloadNow();
	});
	ipcMain.handle(ipcChannels.appInstallUpdate, async () => {
		updateService?.installNow();
	});
	// 后台更新检查快照：主进程定时检查后主动推送（渲染层角标/每版本一次提示）；
	// 渲染层也可主动拉取当前快照（如手动检测完成后刷新角标）。
	ipcMain.handle(ipcChannels.appUpdateStatusChanged, () =>
		updateService?.getSnapshot() ?? null,
	);
	ipcMain.handle(ipcChannels.appUpdateNotifySeen, async (_event, kind: unknown, version: unknown) => {
		if (!updateService) return;
		// 输入校验：kind 只允许 app/pi，version 必须是字符串，否则拒绝（渲染层数据不可信）。
		if (kind !== "app" && kind !== "pi") return;
		if (typeof version !== "string" || !version) return;
		await updateService.notifySeen(kind, version);
	});
	ipcMain.handle(ipcChannels.appUpdateSkipVersion, async (_event, version: unknown) => {
		if (!updateService) return;
		if (typeof version !== "string" || !version) return;
		await updateService.skipVersion(version);
	});

	// 内置更新镜像体检：并行探测各镜像 latest.yml + Range 分片（设置页「更新源」自动体检；
	// 纯网络只读操作、无状态，不依赖 updateService，失败由镜像上报，不向外抛）。
	ipcMain.handle(ipcChannels.appCheckUpdateMirrors, async (): Promise<MirrorHealthResult[]> => {
		return probeAllMirrors();
	});

	// ── 应用日志 ─────────────────────────────────────────────────────

	// 进程监控：Electron 各进程 + pi agent 子进程内存/CPU 快照（手动刷新，不做高频轮询）
	ipcMain.handle(ipcChannels.diagnosticsSnapshot, (): DiagnosticsSnapshot => {
		return diagnosticsMonitor?.snapshot() ?? {
			enabled: false,
			sampledAt: Date.now(),
			main: {
				rssBytes: 0,
				heapUsedBytes: 0,
				heapTotalBytes: 0,
				externalBytes: 0,
				arrayBuffersBytes: 0,
			},
			eventLoopLagMs: 0,
			eventLoopLagMaxMs: 0,
			memoryProfilePath: null,
			timingsPath: null,
			recentTimings: [],
		};
	});
	ipcMain.handle(ipcChannels.diagnosticsOpenFolder, async () => {
		if (!diagnosticsMonitor) return;
		await diagnosticsMonitor.openFolder();
	});

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

	// ── 环境体检（问题反馈页一键排障）──────────────────────────────
	// 依赖在装配层注入；未装配时（如 headless 测试）返回明确的降级错误，不静默失败。

	ipcMain.handle(ipcChannels.healthCheck, async (): Promise<HealthReport> => {
		if (!environmentDoctor) throw new Error("EnvironmentDoctor not injected");
		return environmentDoctor.run();
	});

	ipcMain.handle(
		ipcChannels.healthExportReport,
		async (_event, markdown: unknown, reportJson?: unknown): Promise<HealthExportResult> => {
			if (!logBundleExporter) throw new Error("LogBundleExporter not injected");
			return logBundleExporter.exportReport({
				markdown: typeof markdown === "string" ? markdown : "",
				reportJson: typeof reportJson === "string" ? reportJson : undefined,
			});
		},
	);

	ipcMain.handle(
		ipcChannels.healthExportBundle,
		async (_event, markdown: unknown, reportJson: unknown): Promise<HealthExportResult> => {
			if (!logBundleExporter) throw new Error("LogBundleExporter not injected");
			return logBundleExporter.exportBundle({
				markdown: typeof markdown === "string" ? markdown : "",
				reportJson: typeof reportJson === "string" ? reportJson : "{}",
			});
		},
	);

	// ── RPC 日志 ─────────────────────────────────────────────────────

	const resolveRpcRuntimeAgent = (target?: SessionRuntimeTarget) => {
		if (!target) return undefined;
		const validated = sessionRuntimeCoordinator.validateTarget(target);
		if (!validated.ok) {
			// 失败原因落日志：rpc 日志开关/查询/保存都会走这里，静默失败会让渲染层
			// 误以为开关已生效（此前 handler 在 undefined 时直接 return enabled 假成功）。
			const error = (validated as { ok: false; error: import("../../shared/types").SessionCommandError }).error;
			void appLogger.warn("agent", "RPC log runtime target invalid", {
				sessionId: target.sessionId,
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
				code: error.code,
			});
			if (sessionCommandIpcError) throw sessionCommandIpcError(error);
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
		// target 校验失败时返回 false（而非 enabled）：此前静默返回 enabled 会让渲染层
		// 弹「RPC 日志已打开」提醒框，实际主进程从未开启记录，导致弹窗永远无数据。
		if (!agentId) return false;
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

	// 与托盘「退出 PiDeck」同语义：先置 isQuitting，再 app.quit()。
	// 不能复用 appWindowClose——开启 closeToTray 时 win.close() 只 hide，崩溃页再藏起来用户就退不掉。
	ipcMain.handle(ipcChannels.appQuit, () => {
		if (isQuitting) isQuitting.value = true;
		app.quit();
	});

	// 打开数据目录：userData 目录必然已存在，无需 mkdir；shell.openPath 是 Electron 跨平台 API，
	// 会自动选择系统文件管理器（Windows 资源管理器 / macOS Finder / Linux xdg-open），
	// 不手拼平台命令，避免 Windows 路径空格/分隔符问题。
	ipcMain.handle(ipcChannels.appOpenDataDir, async (): Promise<{ ok: boolean; error?: string }> => {
		const error = await shell.openPath(app.getPath("userData"));
		return error ? { ok: false, error } : { ok: true };
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
	// 供渲染层初始化置顶按钮态：读真实状态而非硬编码 false，
	// 避免「窗口实际置顶、按钮却显示关」的错位（用户反馈的开关需切换一次才正常）。
	ipcMain.handle(ipcChannels.appWindowIsAlwaysOnTop, () => {
		const win = getMainWindow();
		if (!win || win.isDestroyed()) return false;
		return win.isAlwaysOnTop();
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
		// 自动下载更新开关：立即下发到 electron-updater（含检查期间的 autoDownload 切换）。
		if ("autoDownloadUpdates" in patch) {
			updateService?.applyAutoDownloadPreference();
		}
		// 更新源切换（预设镜像 / 自定义镜像前缀）：立即重建 feed URL，无需重启生效。
		if ("updateSource" in patch || "customUpdateSourceUrl" in patch) {
			updateService?.applyUpdateSource();
		}
		if ("developerDiagnostics" in patch && diagnosticsMonitor) {
			void diagnosticsMonitor.setEnabled(settings.developerDiagnostics).catch((error) => {
				void appLogger.warn("diagnostics", "Failed to toggle developer diagnostics", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}
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
		if (
			"theme" in patch
			|| "themeScheduleLightStart" in patch
			|| "themeScheduleDarkStart" in patch
		) {
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
		if (
			"customPiPath" in patch ||
			"wslEnabled" in patch ||
			"wslDistro" in patch ||
			"wslUser" in patch
		) {
			// WSL 切换会改变 ConfigManager 的目录；先重新挂 watcher，再启动新 generation。
			modelCapabilityCache.watchConfigDirectory();
			void refreshPiModelCatalogs().catch(() => undefined);
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
	ipcMain.handle(ipcChannels.skillsReadContent, async (_event, skillPath: string) => {
		if (!readSkillContent) throw new Error("readSkillContent not available");
		// 渲染层传入的路径不可信：白名单校验（全局/项目技能位置）在 readSkillContent 内完成。
		return readSkillContent(skillPath);
	});
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
		if (result.ok) {
			void refreshPiModelCatalogs().catch(() => undefined);
		}
		void appLogger.info("config", "Provider migration applied", {
			direction,
			provider,
			ok: result.ok,
			copiedKey: result.copiedKey,
			wroteViaHost: result.wroteViaHost,
			// 失败时记录具体原因（OAuth 拒绝 / 对面没有 / catalog 缺失 / provider not found），
			// 否则“点迁移报错”只能靠打断点查，日志里看不出是哪条失败分支。
			...(result.error ? { error: result.error } : {}),
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
	// MCP 配置只读合并：projectPath 可选，非法输入当全局层处理。
	ipcMain.handle(ipcChannels.configGetMcp, (_event, projectPath?: unknown) => {
		const path =
			typeof projectPath === "string" && projectPath.trim().length > 0
				? projectPath.trim()
				: undefined;
		return configManager.getMcpConfig(path);
	});
	ipcMain.handle(ipcChannels.configSaveMcp, async (_event, data: unknown) => {
		if (!data || typeof data !== "object" || Array.isArray(data)) {
			return { valid: false, error: "mcp.json must be an object" };
		}
		const result = await configManager.saveMcpConfig(data as McpConfigFile);
		void appLogger.info("config", "MCP config saved", {
			serverCount: Object.keys((data as McpConfigFile).mcpServers ?? {}).length,
		});
		return result;
	});
	// 轻量探测：不 spawn 用户 command、不连 MCP SDK。
	ipcMain.handle(ipcChannels.configProbeMcp, async (_event, definition: unknown) => {
		if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
			return { ok: false, error: "invalid MCP server definition" };
		}
		return configManager.probeMcpServer(definition as McpServerDefinition);
	});
	// 只读：pi 全局配置目录，供源文件编辑页标注实际路径（渲染层不感知配置位置）。
	ipcMain.handle(ipcChannels.configGetDir, () =>
		configManager.getConfigDir(),
	);
	ipcMain.handle(ipcChannels.projectsTrustResponse,
		(_event, requestId: string, choice: "trust-remember" | "trust-session" | "deny") =>
			agentManager.respondTrustRequest(requestId, choice),
	);
	ipcMain.handle(ipcChannels.configSaveModels, async (_event, data) => {
		const result = await configManager.saveModelsConfig(data);
		if (!result.valid) return result;
		invalidateModelListCache();
		// 保存后同步验证：用真实 pi 重新列出模型，确认配置能被 pi 正常加载。
		// 只有拿到非空模型列表才算“保存且可用”；空/失败时把原因带回渲染层提示用户检查配置。
		let modelLoadOk = false;
		let modelCount = 0;
		let modelLoadReason: string | null = null;
		let modelLoadDetail = "";
		try {
			const report = await resolveModelListReport(piLocator, settingsStore, configManager, true);
			// 只有 pi 自己成功列出非空模型列表才算“保存且可用”。source 为 config-fallback
			// 说明 pi 实际没能列出模型（CLI 空 → 回退读本地 models.json 兑底，且兑底会把空
			// name 自动补成 ${provider}/${id}），此时报“已加载”是假绿灯。
			modelLoadOk = report.ok && report.models.length > 0 && report.source !== "config-fallback";
			modelCount = report.models.length;
			modelLoadReason = report.reason;
			// config-fallback 时 report.reason 为 null，补充一个可诊断原因，避免日志/UI 拿到空 reason。
			if (report.source === "config-fallback") modelLoadReason = "config-fallback";
			modelLoadDetail = report.detail ?? "";
		} catch (error) {
			modelLoadReason = "cli-failed";
			modelLoadDetail = error instanceof Error ? error.message : String(error);
		}
		// 同时刷新 capability 快照（模型能力自适应模板依赖），旧 Pi 无 capability RPC 时回退列表。
		void refreshPiModelCatalogs().catch(() => undefined);
		void appLogger.info("config", "Models config saved", {
			providerCount: Object.keys(data?.providers ?? {}).length,
			modelLoadOk,
			modelCount,
			modelLoadReason,
		});
		return { valid: true, modelLoadOk, modelCount, modelLoadReason, modelLoadDetail };
	});
	ipcMain.handle(ipcChannels.configSaveAuth, async (_event, data) => {
		const result = await configManager.saveAuthConfig(data);
		if (result.valid) void refreshPiModelCatalogs().catch(() => undefined);
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
		if (result.valid && (fileName === "models.json" || fileName === "auth.json")) {
			void refreshPiModelCatalogs().catch(() => undefined);
		}
		void appLogger.info("config", "Raw config saved", { fileName, bytes: Buffer.byteLength(rawJson, "utf8") });
		return result;
	});
	ipcMain.handle(ipcChannels.configExport, () =>
		configManager.exportConfig(),
	);
	ipcMain.handle(ipcChannels.configImport, async (_event, packageJson: string) => {
		const result = await configManager.importConfig(packageJson);
		if (result.valid) void refreshPiModelCatalogs().catch(() => undefined);
		void appLogger.info("config", "Config imported", { bytes: Buffer.byteLength(packageJson, "utf8"), valid: result.valid });
		return result;
	});
	ipcMain.handle(ipcChannels.configFetchModels, async (
		_event,
		payload: { baseUrl: string; apiKey: string; apiType?: string; headers?: Record<string, string>; proxyMode?: string },
	) => {
		// proxyMode 白名单收窄（渲染层不可信），再解析成主进程代理策略。
		const proxyTarget = resolveConfigProxyTarget(settingsStore.get(), asConfigProxyMode(payload?.proxyMode));
		const result = await configManager.fetchProviderModels(payload.baseUrl, payload.apiKey, payload.apiType, payload.headers, proxyTarget);
		void appLogger.info("config", "Provider models fetched", {
			baseUrl: payload.baseUrl,
			apiType: payload.apiType,
			modelCount: Array.isArray(result) ? result.length : undefined,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.configGetTokendanceModels, async (_event, force: unknown) => {
		// force 必须为布尔（渲染层入参不可信）；目录拉取/缓存错误统一兜底空结果。
		const forceArg = force === true;
		try {
			if (!tokendanceCatalog) return { models: [], fromCache: false, at: 0 };
			const result = forceArg
				? await tokendanceCatalog.refresh()
				: await tokendanceCatalog.getModels();
			return result ?? { models: [], fromCache: false, at: 0 };
		} catch (error) {
			void appLogger.warn("config", "TokenDance catalog load failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return { models: [], fromCache: false, at: 0 };
		}
	});
	ipcMain.handle(ipcChannels.configTestProvider, async (
		_event,
		payload: { providerName: string; modelId: string; models: PiModelsFile; proxyMode?: string },
	) => {
		// 1) 边界校验：provider/model 名必须是有限的非空字符串；models 交由 saveModelsConfig 做结构校验。
		const providerName = typeof payload?.providerName === "string" ? payload.providerName.trim() : "";
		const modelId = typeof payload?.modelId === "string" ? payload.modelId.trim() : "";
		if (!providerName || providerName.length > 128 || !modelId || modelId.length > 256) {
			return { success: false, error: "Invalid provider name or model id" };
		}
		if (!payload?.models || typeof payload.models !== "object") {
			return { success: false, error: "Invalid models config" };
		}

		// 2) 点击测试即保存：把表单里的配置先落盘，pi 只读磁盘上的 models.json/auth.json。
		const saved = await configManager.saveModelsConfig(payload.models);
		if (!saved.valid) {
			return { success: false, error: saved.error ?? "Invalid models config" };
		}
		invalidateModelListCache();
		void refreshModelList(piLocator, settingsStore, configManager).catch(() => undefined);

		// 3) 用真实 pi 做一次最小调用（走 pi 的 provider 解析 + SDK，与真实会话同路径）。
		//    测试连接显式选了代理时，把它覆盖到探针进程的代理环境（pi 侧只认 piProxy* 配置）。
		const result = await probePiModel(
			piLocator,
			settingsStore,
			providerName,
			modelId,
			resolveConfigProxyTarget(settingsStore.get(), asConfigProxyMode(payload?.proxyMode)),
		);
		void appLogger.info("config", "Provider connection tested via pi", {
			providerName,
			modelId,
			success: result.success,
			error: result.error,
		});
		return result;
	});
	ipcMain.handle(ipcChannels.configFetchUsage, async (
		_event,
		payload: { provider: string; backend?: "pi" | "dsh" },
	) => {
		// 1) 边界校验：provider 名必须是有限的非空字符串，避免把任意 IPC 载荷当路径/URL 用。
		const provider = payload?.provider?.trim() ?? "";
		if (!provider || provider.length > 128) {
			return { success: false, error: "Invalid provider name" };
		}
		// backend 白名单：pi（缺省）/ dsh（DSH 链路：$DSH_HOME 配置 + 凭据库）。
		const backend = payload?.backend === "dsh" ? "dsh" : "pi";
		// 2) 主进程按 provider 名路由：门控（未开启）→ 端点解析 → 模板探测，key 不出主进程。
		const result = await configManager.fetchProviderUsage(provider, backend);
		void appLogger.info("config", "Provider usage fetched", {
			provider,
			backend,
			success: result.success,
			error: result.error,
		});
		return { ...result, provider };
	});
	// ── 用量查询配置（usage-probes.json；学 cc-switch：per-provider 开关 + 模板） ──
	// 读取：该 provider 已保存配置 + 内置模板自动识别（弹窗打开时拉取）。
	ipcMain.handle(ipcChannels.configGetUsageProbes, async (_event, payload: unknown) => {
		const raw = payload && typeof payload === "object" ? (payload as { provider?: unknown; backend?: unknown }) : {};
		const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
		if (!provider || provider.length > 128) {
			return { success: false, error: "Invalid provider name" };
		}
		const backend = raw.backend === "dsh" ? "dsh" : "pi";
		return configManager.getUsageProbeSettings(provider, backend);
	});
	// 轻量内置识别（渲染层隐藏「用量查询」配置按钮用）：命中内置候选（零配置自动生效）返回 true。
	// 与 getUsageProbes 的区别：不读 usage-probes.json，只按端点解析 + 内置候选表判断，开销更小。
	ipcMain.handle(ipcChannels.configUsageRecognized, async (_event, payload: unknown) => {
		const raw = payload && typeof payload === "object" ? (payload as { provider?: unknown; backend?: unknown }) : {};
		const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
		if (!provider || provider.length > 128) {
			return { recognized: false };
		}
		const backend = raw.backend === "dsh" ? "dsh" : "pi";
		const recognized = await configManager.recognizeUsageTemplate(provider, backend);
		return { recognized: recognized != null };
	});
	// 按 provider 合并保存：入口校验与落盘同一套规则，零错误才写（保留文件里其它 providers 与旧 probes）。
	ipcMain.handle(ipcChannels.configSaveUsageProbes, async (_event, payload: unknown) => {
		const input =
			payload && typeof payload === "object" && !Array.isArray(payload)
				? (payload as { provider?: unknown; config?: unknown; backend?: unknown })
				: {};
		const provider = typeof input.provider === "string" ? input.provider.trim() : "";
		if (!provider || provider.length > 128) {
			return { ok: false, error: "Invalid provider name" };
		}
		const backend = input.backend === "dsh" ? "dsh" : "pi";
		const result = await saveUsageProbeForProvider(
			configManager.getUsageProbeConfigDir(backend),
			provider,
			input.config as UsageProbeProviderConfig,
		);
		// 日志只记 provider 与结果；apiKey/accessToken 等字段一律不落日志。
		void appLogger.info("config", "Usage probe config saved", {
			provider,
			backend,
			ok: result.ok,
		});
		return result;
	});
	// 单条模板测试（弹窗「测试」按钮）：按模板 id + 覆盖字段构建候选，主进程解析端点与密钥。
	ipcMain.handle(ipcChannels.configTestUsageProbe, async (_event, payload: unknown) => {
		const input =
			payload && typeof payload === "object" && !Array.isArray(payload)
				? (payload as UsageProbeTestInput)
				: ({} as UsageProbeTestInput);
		const provider = typeof input.provider === "string" ? input.provider.trim() : "";
		if (!provider || provider.length > 128) {
			return { success: false, error: "Invalid provider name" };
		}
		const template = typeof input.template === "string" ? input.template.trim() : undefined;
		if (template && template !== "general" && template !== "newapi" && template !== "cookie") {
			// 内置模板 id 也接受（识别命中后的「测试」按钮走这条路径）。
			const knownBuiltin = USAGE_PROBE_CANDIDATES.some((c) => c.templateId === template);
			if (!knownBuiltin) {
				return { success: false, error: "Unknown template" };
			}
		}
		const result = await configManager.testUsageProbe({
			provider,
			backend: input.backend === "dsh" ? "dsh" : "pi",
			...(template ? { template } : {}),
			...(typeof input.apiKey === "string" ? { apiKey: input.apiKey } : {}),
			...(typeof input.baseUrl === "string" ? { baseUrl: input.baseUrl } : {}),
			...(typeof input.accessToken === "string" ? { accessToken: input.accessToken } : {}),
			...(typeof input.userId === "string" ? { userId: input.userId } : {}),
			// Cookie 模板字段：弹窗测试必须透传，否则构建候选时校验失败（必填三件套）。
			...(typeof input.cookie === "string" ? { cookie: input.cookie } : {}),
			...(typeof input.cookiePath === "string" ? { cookiePath: input.cookiePath } : {}),
			...(typeof input.valuePath === "string" ? { valuePath: input.valuePath } : {}),
			...(typeof input.currencyPath === "string" ? { currencyPath: input.currencyPath } : {}),
			...(typeof input.timeoutSecs === "number" ? { timeoutSecs: input.timeoutSecs } : {}),
		});
		void appLogger.info("config", "Usage probe tested", {
			provider,
			backend: input.backend === "dsh" ? "dsh" : "pi",
			template: template ?? "(auto)",
			success: result.success,
		});
		return result;
	});
	// 安装内置「用量查询自定义」技能模板：从 app resources 复制 SKILL.md 到全局技能目录。
	// 幂等：内容直接覆盖；启动时也会自动安装（见 index.ts），此处保留手动触发兑底。
	ipcMain.handle(ipcChannels.configInstallUsageSkill, async () => {
		const result = await skillManager.installUsageProbeTemplate();
		if (result.success) {
			void appLogger.info("skill", "Usage probe skill template installed", { path: result.path });
			return { success: true, path: result.path };
		}
		void appLogger.warn("skill", "Failed to install usage probe skill template", { error: result.error });
		return { success: false, error: result.error };
	});

	// 内置生图技能手动安装入口：与 usage-probe 同理，供 UI/调试触发兑底（启动时已自动装，此处幂等覆盖）。
	ipcMain.handle(ipcChannels.configInstallImageGenSkill, async () => {
		const result = await skillManager.installImageGenTemplate();
		if (result.success) {
			void appLogger.info("skill", "Image-gen skill template installed", { path: result.path });
			return { success: true, path: result.path };
		}
		void appLogger.warn("skill", "Failed to install image-gen skill template", { error: result.error });
		return { success: false, error: result.error };
	});

	// ── 开发者控制台 ───────────────────────────────────────────────

	ipcMain.handle(ipcChannels.appToggleDevTools, () => toggleMainWindowDevTools(getMainWindow()));
}
