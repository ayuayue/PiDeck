/**
 * System IPC handlers: pi check/exec, WSL, model list, logging, config, app update, dev tools.
 * Phase 3.7: extracted from src/main/index.ts registerIpc().
 */

import { app, dialog, ipcMain, shell } from "electron";
import { execFile } from "node:child_process";

import { ipcChannels } from "../../shared/ipc";

import { normalizeUpdateSource } from "../update/updateSources";

import { join } from "node:path";

import { PiMcpCli } from "../pi/piMcpCli";

import { validateMcpConfigFile } from "../config/mcpConfig";

import { PiResourceConfigService } from "../config/PiResourceConfigService";
import { PiResourceStateStore } from "../config/PiResourceStateStore";

import { isValidWebTokenShape, WEB_TOKEN_EXPIRES_IN_CHOICES, type WebServiceStatusInfo } from "../../shared/types";
import type { AppSettings, CreatePiSkillInput, ModelListReport, SessionCommandResult, SessionRuntimeTarget } from "../../shared/types";
import { invalidatePiInstallationCache, type PiLocator } from "../pi/PiLocator";

import { hasWslSettingsChanged } from "../wsl/WslProjectEnvironment";
import type { SettingsStore } from "../settings/SettingsStore";
import type { ConfigManager } from "../config/ConfigManager";
import type { RemotePiConfigBackend } from "../config/RemotePiConfigBackend";

import type { PiResourceManagerPool } from "../config/PiResourceManagerPool";
import { readPiResourceOptions } from "../config/piResourceTarget";
import { resolvePiResourceWriteManager } from "../config/piResourceWriteRouting";

import type { AgentManager } from "../pi/AgentManager";
import type { AppLogger } from "../logging/AppLogger";
import type { RpcLogger } from "../logging/RpcLogger";
import type { SessionRuntimeCoordinator } from "../sessions/SessionRuntimeCoordinator";

import { setConfiguredGitPath } from "../git/gitExecutable";
import { openSystemPath } from "../fs/openPath";
import { applyTrayLogoStyle, applyWindowLogoStyle } from "../appWindowLogo";
import { syncTaskbarShortcutIcon } from "../appTaskbarIdentity";
import { detectDshRunnerNode } from "../dsh/dshRunnerNode";
import { DSH_RUNNER_NODE_ENV } from "../dsh/dshRunnerNodeSidecar";
import { installDshRunnerNodeSidecar } from "../dsh/dshRunnerNodeInstall";
import { createNetDownloader, fetchDshRunnerNodeIndex } from "../dsh/runtime/dshRuntimeIo";
import { refreshShortcutBindings } from "../appShortcuts";

import type { SkillManager } from "../skills/SkillManager";
import { fetchModelList, invalidateModelListCache, refreshModelCatalogStore, refreshModelList, resolveModelListReport } from "../pi/modelListCache";
import { resolveRemoteModelReport as resolveRemoteModelReportRouting } from "../pi/remoteModelReportRouting";
import { TokendanceCatalogStore } from "../config/tokendanceCatalog";
import type { TokendancePricingStore } from "../config/tokendancePricing";
import type { TokendanceInstallResult } from "../config/tokendanceInstaller";
import type { TokendanceAuthStore } from "../config/tokendanceAuth";
import type { TokendancePaymentStore } from "../config/tokendancePayment";
import type { WatchaEntitlementStore } from "../config/watchaEntitlement";
import type { ProjectResourceManager } from "../projects/ProjectResourceManager";

import type { PiModelCapabilityCache } from "../pi/PiModelCapabilityCache";
import { getPiAiCatalogIndex } from "../pi/piAiBuiltinCatalog";
import { resolveModelSpecFromCatalogs } from "../pi/modelCapabilityResolver";
import { getProcessSnapshot } from "../process/ProcessMonitor";
import { buildDshHostMonitorRow, isDshHostMonitorId } from "../process/dshHostMonitor";
import type { AgentProcessMetric, ArchStatus, DiagnosticsSnapshot, ProcessMetricsSnapshot } from "../../shared/types";
import type { DiagnosticsMonitor } from "../diagnostics/DiagnosticsMonitor";
import { getWslExe, decodeWslOutput, parseWslDistroList } from "../wsl/wslExe";

import { type ProviderMigrationDeps } from "../config/providerMigrationService";

import type { McpConfigFile, McpServerDefinition } from "../../shared/types/mcp";
import type { HealthExportResult, HealthReport } from "../../shared/types";
import type { EnvironmentDoctor } from "../health/EnvironmentDoctor";
import type { LogBundleExporter } from "../health/LogBundleExporter";
import { registerSystemAppIpc } from "./systemAppIpc";
import { registerSystemConfigIpc } from "./systemConfigIpc";
import { registerSystemConfigProviderIpc } from "./systemConfigProviderIpc";
import { registerSystemConfigTokensIpc } from "./systemConfigTokensIpc";
import { registerSystemLogsIpc } from "./systemLogsIpc";
import { registerSystemPiIpc } from "./systemPiIpc";
import { registerSystemPiRuntimeIpc } from "./systemPiRuntimeIpc";

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isUnknownRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

const MCP_EXPOSURE_VALUES = ["codemode", "codemode-deferred", "deferred", "direct", "hidden"];
/** 仅属于全局层的字段：项目层含它会被 pi 跳过（auth）或仅能读不能校验（不拦）。 */
function isProviderAuth(value: unknown): boolean {
	return isUnknownRecord(value) && (value.provider === undefined || typeof value.provider === "string");
}

function isMcpServerDefinition(value: unknown): value is McpServerDefinition {
	if (!isUnknownRecord(value)) return false;
	const optionalString = (key: string) => !(key in value) || value[key] === undefined || typeof value[key] === "string";
	const optionalExposure = (key: string) => !(key in value) || value[key] === undefined || (typeof value[key] === "string" && MCP_EXPOSURE_VALUES.includes(value[key]));
	// pi 0.99.2 内置 MCP schema：command/cwd/url + exposure/toolExposure/enabled/timeout/description
	// + oauth + auth.provider。legacy 字段（socket/lifecycle/directTools/disabled…）pi 静默忽略，PiDeck 不再接受。
	return (
		["command", "cwd", "url"].every(optionalString) &&
		optionalString("description") &&
		optionalExposure("exposure") &&
		(!("toolExposure" in value) || value.toolExposure === undefined || (isUnknownRecord(value.toolExposure) && Object.values(value.toolExposure).every((entry) => typeof entry === "string" && MCP_EXPOSURE_VALUES.includes(entry)))) &&
		(!("enabled" in value) || value.enabled === undefined || typeof value.enabled === "boolean") &&
		(!("timeout" in value) || value.timeout === undefined || (typeof value.timeout === "number" && Number.isFinite(value.timeout) && value.timeout > 0)) &&
		(!("args" in value) || value.args === undefined || (Array.isArray(value.args) && value.args.every((entry) => typeof entry === "string"))) &&
		(!("env" in value) || value.env === undefined || isStringRecord(value.env)) &&
		(!("headers" in value) || value.headers === undefined || isStringRecord(value.headers)) &&
		(!("oauth" in value) || value.oauth === undefined || isUnknownRecord(value.oauth)) &&
		(!("auth" in value) || value.auth === undefined || isProviderAuth(value.auth))
	);
}

function isMcpConfigFile(value: unknown): value is McpConfigFile {
	if (!isUnknownRecord(value)) return false;
	if ("settings" in value && value.settings !== undefined && !isUnknownRecord(value.settings)) return false;
	if (!("mcpServers" in value) || value.mcpServers === undefined) return true;
	if (!isUnknownRecord(value.mcpServers)) return false;
	return Object.values(value.mcpServers).every(isMcpServerDefinition);
}

/**
 * MCP 作用域请求：`{scope:"global"}` / `{scope:"project",projectId}`。
 * 渲染层只能传注册过的 projectId，不传路径。旧的无参/裸 projectId 形式按全局处理，兼容旧预加载。
 */
type McpScopeRequest = { kind: "global" } | { kind: "project"; projectId: string };

function parseMcpScopeRequest(value: unknown): McpScopeRequest {
	if (value === undefined || value === null) return { kind: "global" };
	if (typeof value === "string") {
		if (!value.trim() || value.length > 256) throw new Error("Invalid project id.");
		return { kind: "project", projectId: value.trim() };
	}
	if (!isUnknownRecord(value)) throw new Error("Invalid MCP scope.");
	const scope = value.scope;
	if (scope === undefined || scope === "global") return { kind: "global" };
	if (scope !== "project") throw new Error("Invalid MCP scope.");
	const projectId = value.projectId;
	if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 256) throw new Error("Invalid project id.");
	return { kind: "project", projectId: projectId.trim() };
}

export type SystemIpcDeps = {
	/**
	 * 设置保存后的主进程级副作用钩子（系统级划词全局快捷键等需要随设置即时重注册的能力）。
	 * 与 refreshShortcutBindings 同一时机：保存即生效，无需重启。
	 */
	afterSettingsUpdate?: (settings: AppSettings) => void;
	/**
	 * WSL 来源/发行版/用户变化后重放一次全局 WSL 环境切换（会话扫描、Agent/DSH spawn、
	 * 技能/提示词/扩展/配置目录），保存即生效，无需重启。未装配时保持旧行为（下次启动生效）。
	 */
	applyWslSettings?: () => Promise<void>;
	piLocator: PiLocator;
	settingsStore: SettingsStore;
	configManager: ConfigManager;
	/** Phase 5 remote config scope (Batch A): absent when the remote experiment switch is off => ssh targets fail closed. */
	remotePiConfig?: RemotePiConfigBackend;
	projectResourceManager: ProjectResourceManager;
	agentManager: AgentManager;
	skillManager: SkillManager;
	/**
	 * 资源作用域池（W1）：技能/提示词/扩展的 list 按 PiResourceTarget 路由。缺省 = 只用本机单例，
	 * 让既有装配与定向 IPC 单测保持不变；装配层注入后 WSL 目标不再读写 Windows HOME。
	 */
	piResourcePool?: PiResourceManagerPool;
	appLogger: AppLogger;
	rpcLogger: RpcLogger;
	sessionRuntimeCoordinator: SessionRuntimeCoordinator;
	/**
	 * 项目目录的信任判定（index.ts 注入，已处理 WSL 路径映射）。未装配时按未信任处理，
	 * 使项目 MCP 读写不会在缺少门禁的路径上放开。
	 */
	isProjectTrusted?: (projectId: string, projectRoot: string) => Promise<boolean>;
	/** pi 环境引导：便携 Node 安装器（下载/解压 IO 由 index.ts 装配 DSH 同源实现）；未装配 = 引导入口降级不可用。 */
	piRuntimeNodeInstaller?: import("../pi/runtimeNodeInstall").RuntimeNodeInstallerDeps;
	/** DSH 后端判定（G17：RPC 日志按 backend 分流）。 */
	isDshAgent?: (agentId: string) => boolean;
	/** DSH RPC 日志开关（G17；未装配 = 无 DSH 后端）。 */
	setDshRpcLogging?: (agentId: string, enabled: boolean) => void;
	/** DSH RPC 日志状态查询（G17）。 */
	isDshRpcLogging?: (agentId: string) => boolean;
	/** DSH 实时日志观看登记（面板挂载/卸载成对调用；未装配 = 无 DSH 后端）。 */
	setDshRpcLogWatching?: (agentId: string, watching: boolean) => void;
	/** 开发诊断采样（设置开关热启停） */
	diagnosticsMonitor?: DiagnosticsMonitor;
	/** 进程监控停止 agent：按 agentId 走完整会话停止链路（含 detach 推送），装配层注入 */
	stopAgentFromMonitor: (agentId: string) => Promise<SessionCommandResult<SessionRuntimeTarget | undefined>>;
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
	/**
	 * 远端项目的模型目录（pinned SSH 上跑一次 `pi --list-models`，结果按主机缓存）。
	 * 未装配（实验开关关闭/非远端项目由返回值 null 表示）时远端会话按 `remote-inactive` 处理。
	 */
	remoteModelCatalogForProject?: (projectId: string, sessionId: string, force: boolean) => Promise<ModelListReport | null>;
	/** 同一份远端目录缓存的失效入口（远端 models.json 改写后必须显式失效）。 */
	remoteModelCatalog?: { invalidate: (hostId: string) => void };
	/** 内置 TokenDance 模型目录（live fetch + userData 缓存）；未装配 = 列表不注入。 */
	tokendanceCatalog?: TokendanceCatalogStore;
	/** TokenDance 公开报价派生的折扣/免费徽章表（模型选择器展示用）；未装配 = 不显示徽章。 */
	tokendancePricing?: TokendancePricingStore;
	/** 内置 TokenDance OAuth 授权流程（PKCE verifier 内存持有）；未装配 = 授权入口不可用。 */
	tokendanceAuth?: TokendanceAuthStore;
	/** 内置 TokenDance 充值会话（创建 + 状态查询，Key 不出主进程）；未装配 = 充值入口不可用。 */
	tokendancePayment?: TokendancePaymentStore;
	/** 「请作者喝咖啡」按次付费（只调自家边缘代理）；未装配 = 该入口不可用。 */
	watchaEntitlement?: WatchaEntitlementStore;
	/** TokenDance 一键安装（写入 pi models.json + DSH llm-pi-ai）；未装配 = 配置入口不可用。 */
	tokendanceInstall?: (apiKey?: string) => Promise<TokendanceInstallResult>;
	/** 环境体检编排器（问题反馈页一键排障）。 */
	environmentDoctor?: EnvironmentDoctor;
	/** 诊断产物导出器（Markdown / zip 日志包）。 */
	logBundleExporter?: LogBundleExporter;
	getMainWindow: () => Electron.BrowserWindow | null;
	/** 当前托盘实例（index.ts 持有）；Logo 风格切换时一并刷新托盘图标，未创建/已销毁返回 null。 */
	getTray?: () => Electron.Tray | null;
	mainCopy: (key: string, params?: Record<string, string | number>) => string;
	/** Check for app update（index.ts 注入：直接触发 UpdateService.checkNow，结果经快照推送）。 */
	checkForAppUpdate: () => Promise<void>;
	/** 手动下载已检测到的更新（autoDownload 关闭时由设置页触发）。 */
	downloadAppUpdate: () => Promise<void>;
	/** 重启并安装已下载的更新（electron-updater quitAndInstall）。 */
	installAppUpdate: () => void;
	/** Open external URL */
	openExternalUrl: (url: string, forceSystem?: boolean) => Promise<void>;
	/** React to settings changes for pet system */
	reactToPetSettings?: (prev: AppSettings, next: AppSettings) => Promise<void>;
	/** React to CUA enable/disable changes (start/stop the in-process MCP host). */
	reactToCuaSettings?: (prev: AppSettings, next: AppSettings) => Promise<void>;
	/** React to agent-memory enable/disable changes (register/unregister the stdio MCP server). */
	reactToAgentMemorySettings?: (prev: AppSettings, next: AppSettings) => Promise<void>;
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
	/** DSH host 重启（改 runner node 路径后写入 fork env）。 */
	restartDshHost?: () => Promise<boolean>;
	/** host 是否已 fork；未启动时改路径不必立刻重启。 */
	dshHostIsStarted?: () => boolean;
	/** Session command IPC error converter */
	sessionCommandIpcError?: (error: import("../../shared/types").SessionCommandError) => Error;
	/** 读取技能 SKILL.md 正文（装配层注入：路径白名单校验由 readSkillContent 完成）。 */
	readSkillContent?: (skillPath: string) => Promise<import("../../shared/types").SkillContentResult>;
	/** Extension manager for pi update */
	extensionManager?: {
		checkPiUpdate: () => Promise<import("../../shared/types").PiUpdateCheckResult>;
		updatePi: () => Promise<import("../../shared/types").PiCliUpdateResult>;
	};
	/** Web service manager for restart / 运行状态查询 / 令牌轮换与手动设置 */
	webServiceManager?: { stop: () => Promise<void>; getStatus: () => WebServiceStatusInfo; rotateToken: () => void; setTokenPolicy: (input: { token?: string; expiresIn?: number }) => void };
	/** Terminal manager for restart */
	terminalManager?: { closeAll: () => void };
	/** Is quitting flag (for restart) */
	isQuitting?: { value: boolean };
	/** Releases URL */
	RELEASES_URL?: string;
	/** 开发态 git 分支名（多 worktree 并行区分窗口）；正式包/共享分支为空。 */
	devBranch?: string;
	/** DSH 运行时管理器（读取启用中的 runtime 版本，随包 bundled manifest 兜底）。 */
	dshRuntimeManager?: import("../dsh/runtime/DshRuntimeManager").DshRuntimeManager;
	/** 后台更新检查服务（定时检查快照推送 / 已提示 / 跳过版本 / 立即检查 / 下载 / 安装）。 */
	updateService?: {
		getSnapshot: () => import("../../shared/types").AppUpdateStatusSnapshot;
		notifySeen: (kind: "app" | "pi", version: string) => Promise<void>;
		skipVersion: (version: string) => Promise<void>;
		checkNow: () => Promise<void>;
		/** 把一次真实的 Pi CLI 版本检查结果同步进后台快照（设置页检查/应用内更新后调用）。 */
		applyPiCheckResult: (result: import("../../shared/types").PiUpdateCheckResult) => void;
		downloadNow: () => Promise<void>;
		installNow: () => void;
		applyAutoDownloadPreference: () => void;
		/** 更新源切换（设置保存后调用）：镜像/自定义 → generic feed URL，回 github → 原生通道。 */
		applyUpdateSource: () => void;
	};
};

/**
 * WSL 发行版名 / 用户名的边界校验：只允许安全字符、限长，且不得以 `-` 开头。
 * 两者会以数组形式传给 wsl.exe 的 `-d` / `-u`，以 `-` 开头的值会被当成额外选项解析。
 */
function isWslName(value: string): boolean {
	return /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/.test(value);
}

export function registerSystemIpc(deps: SystemIpcDeps): void {
	const {
		piLocator,
		settingsStore,
		configManager,
		remotePiConfig,
		projectResourceManager,
		agentManager,
		skillManager,
		piResourcePool,
		appLogger,
		rpcLogger,
		sessionRuntimeCoordinator,
		remoteModelCatalogForProject,
		remoteModelCatalog,
		isProjectTrusted,
		isDshAgent,
		setDshRpcLogging,
		isDshRpcLogging,
		setDshRpcLogWatching,
		getMainWindow,
		getTray,
		mainCopy,
		checkForAppUpdate,
		downloadAppUpdate,
		installAppUpdate,
		openExternalUrl: doOpenExternalUrl,
		reactToPetSettings,
		reactToCuaSettings,
		reactToAgentMemorySettings,
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
		restartDshHost,
		dshHostIsStarted,
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
		tokendancePricing,
		tokendanceAuth,
		tokendancePayment,
		watchaEntitlement,
		tokendanceInstall,
		diagnosticsMonitor,
		environmentDoctor,
		logBundleExporter,
	} = deps;

	/** `pi mcp` CLI 封装（连接检测 / OAuth 登录登出）；惰性构造，无状态可安全复用。 */
	let piMcpCli: PiMcpCli | null = null;
	/** pi 原生资源配置服务（懒建：只在用户打开相关页面/切换开关时才需要）。 */
	let piResourceService: PiResourceConfigService | undefined;
	const getPiMcpCli = () => {
		piMcpCli ??= new PiMcpCli({
			locator: piLocator,
			getSettings: () => settingsStore.get(),
			resolveProjectScope: async (projectId) => {
				const root = projectResourceManager.getProjectRoot(projectId);
				const trusted = isProjectTrusted ? await isProjectTrusted(projectId, root) : false;
				return { cwd: root, trusted };
			},
		});
		return piMcpCli;
	};

	/**
	 * Models/auth 的任何写入都必须同时失效 CLI fallback 与 Pi-authoritative
	 * capability snapshot。cache 自己按 generation 丢弃旧 probe 的迟到结果。
	 *
	 * 走默认快速档（不加载扩展）：配置保存/watcher/备份恢复都是用户动作的副作用，
	 * 不应附带 ~2s 的扩展加载；要补回扩展贡献的模型请用模型选择器的手动刷新按钮。
	 */
	const refreshPiModelCatalogs = async (): Promise<void> => {
		invalidateModelListCache();
		const snapshot = await modelCapabilityCache.refresh();
		if (snapshot) return;
		// 旧 Pi 没有 capability RPC 时，仍预热原有的兼容模型列表。
		await refreshModelList(piLocator, settingsStore, configManager).catch(() => undefined);
	};

	// 配置域（源文件读写 / 迁移 / 模型保存验证）已拆到 ./systemConfigIpc.ts。
	registerSystemConfigIpc({
		settingsStore,
		configManager,
		remotePiConfig,
		providerMigration,
		modelCapabilityCache,
		piLocator,
		appLogger,
		getMainWindow,
		refreshPiModelCatalogs,
		remoteModelCatalog,
	});

	// pi 检测 / 安装域已拆到 ./systemPiIpc.ts。
	registerSystemPiIpc({ piLocator, settingsStore, appLogger, mainCopy, updateService, refreshPiModelCatalogs });

	// ── 模型列表 ────────────────────────────────────────────────────

	/**
	 * 本机模型目录解析（projects:list-models-report 与 sessions:list-models 的本机分支共用）。
	 *
	 * 抽出来的理由：远端会话走的是「远端主机上的 pi --list-models」（见 resolveRemoteModelReport），
	 * 而本机路径的 force 刷新语义（pi update --models + 带扩展快照）与远端无关；两条通道路由到
	 * 同一份本机实现，避免出现第二份「本机目录」定义而慢慢分叉。
	 */
	const resolveLocalModelReport = async (forceArg: boolean): Promise<ModelListReport> => {
		try {
			// 手动刷新（force）：先强制刷新 pi 模型目录缓存（pi update --models，
			// force 绕过 4h 磁盘节流——官方 provider 新模型立刻可见），成功后再重新
			// hydration。目录刷新失败（无网络/超时）不阻塞：退回读盘 hydration，
			// 旧目录也能刷新列表，刷新按钮不因网络问题报错。
			// 同时这是模型选择器里唯一付「带扩展」成本的入口（loadExtensions: true）：
			// 启动/失效重建默认走 --no-extensions 快速档，扩展通过 pi.registerProvider
			// 贡献的模型（issue #181）只在这里补回，见 docs/archive/plans/pi-model-capability-plan.md。
			if (forceArg) {
				const catalogRefreshed = await refreshModelCatalogStore(piLocator, settingsStore);
				void appLogger.info("pi", "Model catalog force refresh on manual reload", {
					ok: catalogRefreshed,
				});
			}
			const snapshot = forceArg ? await modelCapabilityCache.refresh({ loadExtensions: true }) : await modelCapabilityCache.ensure();
			const report: ModelListReport =
				snapshot && snapshot.models.length > 0
					? {
							models: snapshot.models,
							ok: true,
							reason: null,
							version: null,
							detail: "",
							source: "cache",
							at: Date.now(),
						}
					: await resolveModelListReport(piLocator, settingsStore, configManager, forceArg);
			// 模型列表只反映 pi 运行时配置：TokenDance 目录由用户确认写入配置后自然出现。
			void appLogger.info("pi", "Model list report resolved", {
				ok: report.ok,
				reason: report.reason,
				count: report.models.length,
				source: report.source,
				forced: forceArg,
				// 记录本次快照是否带扩展：带扩展快照可能比快速档多出插件贡献的模型，
				// 排查「刷新后多/少模型」时先看这个字段。
				loadExtensions: snapshot?.loadExtensions ?? null,
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
	};

	ipcMain.handle(ipcChannels.projectsListModels, async (_event, _projectId?: string) => {
		try {
			const snapshot = await modelCapabilityCache.ensure();
			const models = snapshot?.models ?? (await fetchModelList(piLocator, settingsStore, configManager));
			void appLogger.info("pi", "Model list resolved", {
				count: models.length,
				capabilitiesReady: snapshot !== null,
				providers: [...new Set(models.map((m) => m.provider))].slice(0, 8),
			});
			// 供应商只来自 pi 配置（models.json）/内置 catalog：TokenDance 需用户在配置
			// 页确认后写入，这里不做任何展示层注入（列表 = 运行时可用模型）。
			return models;
		} catch (error) {
			void appLogger.warn("pi", "Failed to resolve model list", {
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		}
	});

	ipcMain.handle(ipcChannels.projectsListModelsReport, async (_event, _projectId: unknown, force: unknown) => {
		// 边界校验：渲染层入参不可信；projectId 仍按原契约接受但当前实现不使用，force 必须为布尔。
		return resolveLocalModelReport(force === true);
	});

	/**
	 * 远端项目的模型目录：具体顺序与「绝不回退本机目录」的保证在
	 * `src/main/pi/remoteModelReportRouting.ts`（纯策略，可单测）；这里只做依赖装配。
	 */
	const resolveRemoteModelReport = async (input: { projectId: string; sessionId: string; liveAgentId: string | undefined; force: boolean }): Promise<ModelListReport> =>
		resolveRemoteModelReportRouting(
			{ projectId: input.projectId, liveAgentId: input.liveAgentId },
			{
				// 目录解析失败（locator 读取异常等）折叠成 null，不让裸 rejection 穿过 IPC 边界。
				loadCatalog: async (projectId) => {
					if (!remoteModelCatalogForProject) return null;
					try {
						return await remoteModelCatalogForProject(projectId, input.sessionId, input.force);
					} catch (error) {
						void appLogger.warn("pi", "Remote model catalog resolution failed", { projectId, error: error instanceof Error ? error.message : String(error) });
						return null;
					}
				},
				askRuntime: async (agentId) => {
					try {
						const models = await agentManager.getAvailableModels(agentId);
						void appLogger.info("pi", "Remote session model list resolved", { agentId, count: models.length });
						return { models, ok: models.length > 0, reason: models.length > 0 ? null : "empty", version: null, detail: "", source: "remote", at: Date.now() };
					} catch (error) {
						void appLogger.warn("pi", "Remote session model list failed", { agentId, error: error instanceof Error ? error.message : String(error) });
						return null;
					}
				},
			},
		);

	/**
	 * 会话级模型目录：远端会话**只**接受它自己那台远端 pi 的回答。
	 *
	 * 为什么不能复用 projects:list-models-report：那条永远回答本机目录（本机 pi --list-models /
	 * models.json），而 set_model 的校验发生在远端 pi 上——给远端会话展示本机模型，用户选中后
	 * 必然 `Model not found`，然后被偏好降级链路静默改回远端默认模型。这正是「远端能聊但选不了
	 * 我那边的模型」的根因。
	 *
	 * 三种结果：
	 * - 远端项目：`pi --list-models` 在**那台主机**上算目录（与本机同一个解析函数，按主机缓存，
	 *   与 runtime 无关 ⇒ 草稿期也能选）；CLI 拿不到时若恰好有活 runtime 再问进程一次；
	 * - 既非远端会话也没有远端 runtime：与 projects:list-models-report 逐字同源；
	 * - 远端但所有来源都失败：`remote-inactive`，**绝不回退本机目录**（否则用户选到远端不存在的模型）。
	 *
	 * `projectId` 是给「没有真实会话身份」的入口兜底用的（小窗新建会话的虚拟 sessionId、自动化任务
	 * 编辑器）。这些入口最终仍会落在远端项目里：只看 sessionId 会得到本机目录，让同一个错误从主选择器
	 * 换到边缘入口重现。
	 */
	ipcMain.handle(ipcChannels.sessionsListModels, async (_event, rawSessionId: unknown, force: unknown, rawProjectId: unknown): Promise<ModelListReport> => {
		// 边界校验：渲染层入参不可信；sessionId/projectId 只用于查 runtime，长度上限与其它会话通道一致。
		const sessionId = typeof rawSessionId === "string" && rawSessionId.length > 0 && rawSessionId.length <= 256 ? rawSessionId : "";
		const projectId = typeof rawProjectId === "string" && rawProjectId.length > 0 && rawProjectId.length <= 256 ? rawProjectId : "";
		const forceArg = force === true;
		const target = sessionId ? sessionRuntimeCoordinator.getTarget(sessionId) : undefined;
		const liveRemoteAgentId = target && agentManager.isRemoteAgent(target.agentId) ? target.agentId : undefined;
		// 两个判据都要看：会话不在 catalog 里时 isRemoteSession 一律 false（小窗新建的虚拟 sessionId、
		// 自动化任务编辑器的固定 key 都属于这种），只看它会让这些入口在远端项目里拿到本机目录。
		const isRemoteSession = (sessionId.length > 0 && sessionRuntimeCoordinator.isRemoteSession(sessionId)) || (projectId.length > 0 && agentManager.isRemoteProject(projectId));
		if (isRemoteSession || liveRemoteAgentId !== undefined) {
			return await resolveRemoteModelReport({
				projectId,
				sessionId,
				liveAgentId: liveRemoteAgentId ?? (projectId.length > 0 ? agentManager.findLiveRemoteAgentId([projectId]) : undefined),
				force: forceArg,
			});
		}
		// 既不是远端会话、也没有远端 runtime：本机语义逐字不变。
		return resolveLocalModelReport(forceArg);
	});

	// ── 模型规格（官方 pi-ai 目录；第三方 provider 按模型本体匹配）──

	ipcMain.handle(ipcChannels.projectsGetModelSpec, async (_event, providerName: unknown, modelId: unknown, modelName: unknown) => {
		// 边界校验：渲染层输入不可信，拒绝非字符串/超长输入。
		if (typeof providerName !== "string" || typeof modelId !== "string" || (modelName !== undefined && typeof modelName !== "string") || providerName.length > 128 || modelId.length > 256 || (typeof modelName === "string" && modelName.length > 256)) {
			return null;
		}
		try {
			// 模板只读官方 pi-ai 目录（端点 /models 实报字段由渲染层优先合并）。
			// 不读运行中 pi 的模型列表：那是它对 models.json 的解析后视图，会把
			// `?? 128000 / ?? 16384 / ?? false / ?? ["text"]` 兜底值回显成事实
			// （见 modelCapabilityResolver 顶部注释）。
			return resolveModelSpecFromCatalogs(
				{
					providerName,
					modelId,
					...(typeof modelName === "string" && modelName.trim() ? { modelName } : {}),
				},
				getPiAiCatalogIndex(),
			);
		} catch (error) {
			void appLogger.warn("models", "Model spec lookup failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	});

	// ── WSL ──────────────────────────────────────────────────────────

	const wslExe = getWslExe();
	const wslExePath = wslExe.command;
	const wslShell = wslExe.shell;

	ipcMain.handle(ipcChannels.wslListDistros, async () => {
		if (process.platform !== "win32") return [] as string[];
		try {
			const { execFile } = await import("node:child_process");
			return await new Promise<string[]>((resolve) => {
				// wsl.exe 在 Windows 10 1903+ 以 UTF-16LE 输出；按 utf8 解码会得到字符夹 NUL 的乱码，
				// 旧实现的 `!includes("\x00")` 过滤会把全部行丢掉，表现为发行版下拉框永远为空。
				execFile(wslExePath, ["-l", "-q"], { encoding: "buffer", timeout: 10_000, windowsHide: true, shell: wslShell }, (err, stdout) => {
					if (err) {
						resolve([]);
						return;
					}
					resolve(parseWslDistroList(stdout));
				});
			});
		} catch {
			return [] as string[];
		}
	});

	ipcMain.handle(ipcChannels.wslValidateConnection, async (_event, distro: unknown, user: unknown) => {
		// 边界校验：渲染层输入不可信，distro/user 只允许安全字符且限长（会拼进子进程参数数组）。
		if (typeof distro !== "string" || typeof user !== "string" || !isWslName(distro) || !isWslName(user)) {
			return { ok: false, whoami: "", piVersion: "", piPath: "", error: mainCopy("wsl.connectionFailed") };
		}
		if (process.platform !== "win32") {
			return { ok: false, whoami: "", piVersion: "", piPath: "", error: mainCopy("wsl.windowsOnly") };
		}
		try {
			const { execFile } = await import("node:child_process");
			const whoami = await new Promise<string>((resolve, reject) => {
				execFile(wslExePath, ["-d", distro, "-u", user, "whoami"], { encoding: "buffer", timeout: 10_000, windowsHide: true, shell: wslShell }, (err, stdout) => {
					if (err) {
						reject(err);
						return;
					}
					resolve(decodeWslOutput(stdout).trim());
				});
			});
			// 与 agent 启动共用同一探测结果（强制重探）：用户可能刚在 WSL 里装完 pi 就来点验证。
			const pi = await piLocator.checkWslInstallation(distro, user, { force: true });
			return {
				ok: true,
				whoami,
				piVersion: pi.installed ? (pi.version ?? "") : "",
				piPath: pi.installed ? (pi.piPath ?? "") : "",
				error: pi.installed ? "" : mainCopy("wsl.piNotInstalled"),
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
				piPath: "",
				error: mainCopy("wsl.connectionFailed"),
			};
		}
	});

	// pi 环境引导 / 更新域已拆到 ./systemPiRuntimeIpc.ts。
	registerSystemPiRuntimeIpc({ piLocator, settingsStore, appLogger, mainCopy, piRuntimeNodeInstaller: deps.piRuntimeNodeInstaller, extensionManager, updateService, refreshPiModelCatalogs });

	// 应用信息 / 更新 / 外部链接 / 窗口控制域已拆到 ./systemAppIpc.ts。
	registerSystemAppIpc({
		settingsStore,
		piLocator,
		appLogger,
		agentManager,
		getMainWindow,
		openExternalUrl: doOpenExternalUrl,
		RELEASES_URL,
		devBranch,
		dshRuntimeManager: deps.dshRuntimeManager,
		updateService,
		isQuitting,
		webServiceManager,
		terminalManager,
	});
	// ── 应用日志 ─────────────────────────────────────────────────────

	// 进程监控：Electron 各进程 + pi agent 子进程内存/CPU 快照（手动刷新，不做高频轮询）
	ipcMain.handle(ipcChannels.diagnosticsSnapshot, (): DiagnosticsSnapshot => {
		return (
			diagnosticsMonitor?.snapshot() ?? {
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
				processCpu: [],
				memoryProfilePath: null,
				timingsPath: null,
				cpuPath: null,
				recentTimings: [],
			}
		);
	});
	// 运行架构检测：Electron 官方接口判定「x64 二进制在 ARM64 转译层下」（macOS=Rosetta 2）。
	// 无参数、无副作用，纯读当前进程状态；渲染层启动时拉一次决定是否提示换原生包。
	ipcMain.handle(ipcChannels.archStatus, (): ArchStatus => {
		return {
			platform: process.platform,
			processArch: process.arch,
			runningUnderArm64Translation: app.runningUnderARM64Translation === true,
		};
	});
	ipcMain.handle(ipcChannels.diagnosticsOpenFolder, async () => {
		if (!diagnosticsMonitor) return;
		await diagnosticsMonitor.openFolder();
	});

	ipcMain.handle(ipcChannels.processMetrics, async (): Promise<ProcessMetricsSnapshot> => {
		const agents: Array<Pick<AgentProcessMetric, "agentId" | "pid" | "kind" | "sessionId" | "sessionTitle" | "sessionTitles">> = deps.agentManager.listAgentPids().map((agent) => {
			// 进程监控表展示会话身份：按 agentId 反查关联的会话 id/标题，
			// 让用户知道每个 agent 对应哪个会话（而不是只看到内部 id）
			const sessionInfo = deps.sessionRuntimeCoordinator.getSessionInfoForAgent(agent.agentId);
			return { ...agent, kind: "pi" as const, ...(sessionInfo ?? {}) };
		});
		// DSH 会话共享一个 utilityProcess：有 pid 时追加一行，不按会话伪造多个 pid。
		const dshPid = deps.getDshHostPid?.();
		if (dshPid) {
			agents.push(
				buildDshHostMonitorRow({
					pid: dshPid,
					sessions: deps.listDshMonitorSessions?.() ?? [],
				}),
			);
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

	// 应用日志 / RPC 日志域已拆到 ./systemLogsIpc.ts。
	registerSystemLogsIpc({ appLogger, rpcLogger, agentManager, sessionRuntimeCoordinator, sessionCommandIpcError, isDshAgent, setDshRpcLogging, isDshRpcLogging, setDshRpcLogWatching });

	// ── 环境体检（问题反馈页一键排障）──────────────────────────────
	// 依赖在装配层注入；未装配时（如 headless 测试）返回明确的降级错误，不静默失败。

	ipcMain.handle(ipcChannels.healthCheck, async (): Promise<HealthReport> => {
		if (!environmentDoctor) throw new Error("EnvironmentDoctor not injected");
		return environmentDoctor.run();
	});

	ipcMain.handle(ipcChannels.healthExportReport, async (_event, markdown: unknown, reportJson?: unknown): Promise<HealthExportResult> => {
		if (!logBundleExporter) throw new Error("LogBundleExporter not injected");
		return logBundleExporter.exportReport({
			markdown: typeof markdown === "string" ? markdown : "",
			reportJson: typeof reportJson === "string" ? reportJson : undefined,
		});
	});

	ipcMain.handle(ipcChannels.healthExportBundle, async (_event, markdown: unknown, reportJson: unknown): Promise<HealthExportResult> => {
		if (!logBundleExporter) throw new Error("LogBundleExporter not injected");
		return logBundleExporter.exportBundle({
			markdown: typeof markdown === "string" ? markdown : "",
			reportJson: typeof reportJson === "string" ? reportJson : "{}",
		});
	});

	// ── 设置 ─────────────────────────────────────────────────────────

	ipcMain.handle(ipcChannels.dshDetectRunnerNode, async (_event, configuredPath?: unknown) => {
		const configured = typeof configuredPath === "string" ? configuredPath : settingsStore.get().dshRunnerNodePath;
		return detectDshRunnerNode({
			configuredPath: configured,
			envPath: process.env[DSH_RUNNER_NODE_ENV],
			userDataPath: app.getPath("userData"),
			resourcesPath: process.resourcesPath,
			appPath: app.getAppPath(),
		});
	});
	let runnerNodeInstallInflight: Promise<import("../../shared/types/dshRunnerNode").DshRunnerNodeInstallResult> | null = null;
	ipcMain.handle(ipcChannels.dshInstallRunnerNode, async () => {
		if (process.platform !== "win32") {
			return { ok: false, error: "仅 Windows 需要单独的 Node 24 沙箱副本" };
		}
		if (runnerNodeInstallInflight) return runnerNodeInstallInflight;
		runnerNodeInstallInflight = (async () => {
			const settings = settingsStore.get();
			const result = await installDshRunnerNodeSidecar({
				userDataPath: app.getPath("userData"),
				platform: process.platform,
				updateSource: normalizeUpdateSource(settings.updateSource),
				indexUrl: process.env.DSH_RUNNER_NODE_INDEX_URL || settings.dshRunnerNodeIndexUrl,
				download: createNetDownloader((scope, message, detail) => {
					void appLogger.info(scope, message, detail);
				}),
				fetchIndex: (url) =>
					fetchDshRunnerNodeIndex(url, (scope, message, detail) => {
						void appLogger.info(scope, message, detail);
					}),
			});
			if (result.ok && restartDshHost && dshHostIsStarted?.()) {
				void restartDshHost().catch((error) => {
					void appLogger.warn("dsh", "Failed to restart DSH host after installing runner node", {
						error: error instanceof Error ? error.message : String(error),
					});
				});
			}
			return result;
		})().finally(() => {
			runnerNodeInstallInflight = null;
		});
		return runnerNodeInstallInflight;
	});
	ipcMain.handle(ipcChannels.dshChooseRunnerNode, async () => {
		const options = {
			properties: ["openFile" as const],
			filters:
				process.platform === "win32"
					? [
							{ name: "Node", extensions: ["exe"] },
							{ name: "All Files", extensions: ["*"] },
						]
					: [{ name: "All Files", extensions: ["*"] }],
		};
		const mainWindow = getMainWindow();
		const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
		return result.canceled ? null : (result.filePaths[0] ?? null);
	});

	ipcMain.handle(ipcChannels.settingsGet, () => settingsStore.get());

	ipcMain.handle(ipcChannels.settingsUpdate, async (_event, patch: Partial<AppSettings>) => {
		const prevSettings = settingsStore.get();
		const settings = await settingsStore.update(patch);
		// 全局快捷键覆盖：保存后立即刷新主进程生效绑定，无需重启即可用新键（见 appShortcuts.ts）
		if ("shortcuts" in patch) {
			refreshShortcutBindings(settings);
		}
		// 主进程级副作用钩子：系统级划词快捷键等需要按新设置重注册（见 index.ts 装配）。
		deps.afterSettingsUpdate?.(settings);
		// Git 可执行文件路径：立即同步给 git 子进程解析器，保存后无需重启即生效。
		if ("gitExecutablePath" in patch) {
			setConfiguredGitPath(settings.gitExecutablePath);
		}
		// DSH runner 的 node 路径写入 host fork env：已运行的 host 必须重启才生效。
		if ("dshRunnerNodePath" in patch && prevSettings.dshRunnerNodePath !== settings.dshRunnerNodePath) {
			if (restartDshHost && dshHostIsStarted?.()) {
				void restartDshHost().catch((error) => {
					void appLogger.warn("dsh", "Failed to restart DSH host after runner node path change", {
						error: error instanceof Error ? error.message : String(error),
					});
				});
			}
		}
		// 自动下载更新开关：立即下发到 electron-updater（含检查期间的 autoDownload 切换）。
		if ("autoDownloadUpdates" in patch) {
			updateService?.applyAutoDownloadPreference();
		}
		// Logo 风格/自定义 logo 图：立即切换窗口/任务栏/Dock/托盘图标（安装包与 exe 的静态图标在构建期烘进二进制，
		// 运行时改不了，见 appWindowLogo.ts）。两项要一起判：切图不动风格、或风格已是 custom 只换图，都得刷新。
		const logoChanged = ("logoStyle" in patch && prevSettings.logoStyle !== settings.logoStyle) || ("logoCustomImage" in patch && prevSettings.logoCustomImage !== settings.logoCustomImage);
		if (logoChanged) {
			applyWindowLogoStyle(settings.logoStyle, getMainWindow, settings.logoCustomImage);
			if (getTray) applyTrayLogoStyle(settings.logoStyle, getTray, settings.logoCustomImage);
		}
		// 任务栏按钮的图标取开始菜单快捷方式的图标（窗口图标只是无身份注册时的兜底）：换 logo 时同步重写。
		// 任务栏按钮上的**文字**不在这里：它取快捷方式/exe 名，与 appDisplayName 无关。
		if (logoChanged) {
			syncTaskbarShortcutIcon({ style: settings.logoStyle, customLogoDataUrl: settings.logoCustomImage });
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
		// CUA 开关：开启时启动进程内 MCP 端点并写入 pi 的 mcp.json，关闭时停端点并注销。
		if (("cuaEnabled" in patch || "browserAgentEnabled" in patch) && typeof reactToCuaSettings === "function") {
			await reactToCuaSettings(prevSettings, settings);
		}
		// 智能体记忆开关：开启时注册 stdio MCP 服务器，关闭时只删自己那一项。
		if ("agentMemoryEnabled" in patch && typeof reactToAgentMemorySettings === "function") {
			await reactToAgentMemorySettings(prevSettings, settings);
		}
		if ("desktopProxyEnabled" in patch || "desktopProxyUrl" in patch || "desktopProxyBypass" in patch) {
			if (applyDesktopProxy) await applyDesktopProxy(settings);
		}
		if ("theme" in patch || "themeScheduleLightStart" in patch || "themeScheduleDarkStart" in patch) {
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
		// EasyTier 手动 IP / CLI 路径变更也走同一收敛入口：Web 服务配置没变时 applySettings 早退，syncWebService 会重新探测只读渠道。
		if ("webServiceEnabled" in patch || "webServiceHost" in patch || "webServicePort" in patch || "webServiceRequiresAuth" in patch || "webRemoteEasyTierIp" in patch || "webRemoteEasyTierCliPath" in patch) {
			try {
				if (applyWebServiceSettings) await applyWebServiceSettings(settings);
			} catch (error) {
				const debugDetails = error instanceof Error ? error.message : String(error);
				void appLogger.warn("web", "Failed to apply web service settings", { error: debugDetails });
				if (settings.webServiceEnabled) {
					await settingsStore.update({ webServiceEnabled: false });
				}
				throw new Error(mainCopy(debugDetails === "WEB_SERVICE_INVALID_PORT" ? "webService.invalidPort" : "webService.startFailed"));
			}
		}
		if ("customPiPath" in patch) {
			// 当前使用的 pi 路径变化后重新挂 watcher，再启动新 generation。
			modelCapabilityCache.watchConfigDirectory();
			// 当前使用项与候选列表都随这些字段变化：不清缓存会让 UI 在 TTL 内显示旧安装列表。
			invalidatePiInstallationCache();
			void refreshPiModelCatalogs().catch(() => undefined);
		}
		// WSL 来源/发行版/用户：目标是另一套 HOME，技能/提示词/扩展/配置目录必须整体重绑，
		// 否则设置页改完只有「检测环境」生效，资源页仍是旧用户（/root 的 0700 家目录还会 EPERM）。
		// 只在三元组真的变化时重放：普通设置保存不额外拉起 wsl.exe 探测。
		const wslSettingsChanged = hasWslSettingsChanged(prevSettings, settings);
		if (wslSettingsChanged && deps.applyWslSettings) {
			try {
				await deps.applyWslSettings();
			} catch (error) {
				// 设置已落盘：切换失败不回滚、也不让保存请求失败，用户可点「检测环境」重试。
				void appLogger.warn("wsl", "Applying WSL settings failed", { error: error instanceof Error ? error.message : String(error) });
			}
		}
		return settings;
	});

	ipcMain.handle(ipcChannels.settingsRestartWebService, async () => {
		if (!restartWebService) throw new Error("restartWebService not available");
		await restartWebService(settingsStore.get());
	});

	ipcMain.handle(ipcChannels.webServiceStatus, () => {
		if (!webServiceManager) {
			return {
				running: false,
				host: "",
				port: 0,
				token: "",
				requiresAuth: false,
				tokenExpiresAt: null,
			} satisfies WebServiceStatusInfo;
		}
		return webServiceManager.getStatus();
	});

	ipcMain.handle(ipcChannels.webServiceRotateToken, () => {
		if (!webServiceManager) throw new Error("web service not available");
		webServiceManager.rotateToken();
		return webServiceManager.getStatus();
	});

	// 手动设置令牌/过期策略：热生效不重启服务。输入校验在边界完成——
	// token 需满足形状约束（8-128 可打印非空白），expiresIn 必须是枚举值，
	// 非法输入直接拒绝不落盘（与 SettingsStore 清洗同一口径）。
	ipcMain.handle(ipcChannels.webServiceSetToken, (_event, input: unknown) => {
		if (!webServiceManager) throw new Error("web service not available");
		if (typeof input !== "object" || input === null) throw new Error("invalid payload");
		const payload = input as { token?: unknown; expiresIn?: unknown };
		const patch: { token?: string; expiresIn?: number } = {};
		if (payload.token !== undefined) {
			if (typeof payload.token !== "string") throw new Error("invalid token");
			const token = payload.token.trim();
			if (!isValidWebTokenShape(token)) throw new Error("invalid token shape");
			patch.token = token;
		}
		if (payload.expiresIn !== undefined) {
			if (typeof payload.expiresIn !== "number" || !WEB_TOKEN_EXPIRES_IN_CHOICES.includes(payload.expiresIn as (typeof WEB_TOKEN_EXPIRES_IN_CHOICES)[number])) throw new Error("invalid expiresIn");
			patch.expiresIn = payload.expiresIn;
		}
		if (patch.token === undefined && patch.expiresIn === undefined) throw new Error("empty payload");
		webServiceManager.setTokenPolicy(patch);
		return webServiceManager.getStatus();
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

	// 资源目标（W1）：options 在第一行校验（形状/hostId/拒绝 ssh），再由池按目标取管理器；
	// 未装配池时保持旧行为（本机单例），不让资源页因为装配顺序变成不可用。
	ipcMain.handle(ipcChannels.skillsList, async (_event, options?: unknown) => {
		const parsed = readPiResourceOptions(options);
		return (piResourcePool ? await piResourcePool.skills(parsed) : skillManager).list();
	});
	ipcMain.handle(ipcChannels.skillsReadContent, async (_event, skillPath: string) => {
		if (!readSkillContent) throw new Error("readSkillContent not available");
		// 渲染层传入的路径不可信：白名单校验（全局/项目技能位置）在 readSkillContent 内完成。
		return readSkillContent(skillPath);
	});
	// 资源写通道（task-16）：local/缺省 → 原单例；wsl → 池中该档案管理器（写入其发行版 HOME）；池缺失 fail closed。
	ipcMain.handle(ipcChannels.skillsCreate, async (_event, input: CreatePiSkillInput, options?: unknown) => {
		const manager = await resolvePiResourceWriteManager({ options, pool: piResourcePool, local: () => skillManager, pick: async (pool, parsed) => await pool.skills(parsed) });
		const result = await manager.create(input);
		void appLogger.info("skill", "Skill created", { name: input.name, locationId: input.locationId });
		return result;
	});
	ipcMain.handle(ipcChannels.skillsToggle, async (_event, path: string, enabled: boolean, options?: unknown) => {
		const manager = await resolvePiResourceWriteManager({ options, pool: piResourcePool, local: () => skillManager, pick: async (pool, parsed) => await pool.skills(parsed) });
		const result = await manager.toggle(path, enabled);
		void appLogger.info("skill", "Skill toggled", { path, enabled });
		return result;
	});
	ipcMain.handle(ipcChannels.skillsDelete, async (_event, path: string, options?: unknown) => {
		const manager = await resolvePiResourceWriteManager({ options, pool: piResourcePool, local: () => skillManager, pick: async (pool, parsed) => await pool.skills(parsed) });
		// WSL 目标：shell.trashItem 对 UNC 路径可能不支持 → 报错而不是硬删（风险已登记）。
		const result = await manager.delete(path);
		void appLogger.info("skill", "Skill deleted", { path });
		return result;
	});
	ipcMain.handle(ipcChannels.skillsRename, async (_event, skillPath: unknown, newName: unknown, options?: unknown) => {
		const manager = await resolvePiResourceWriteManager({ options, pool: piResourcePool, local: () => skillManager, pick: async (pool, parsed) => await pool.skills(parsed) });
		// 渲染层入参不可信：先校验再进 SkillManager（与 projectResourceIpc 的边界校验同一纪律）。
		if (typeof skillPath !== "string" || skillPath.trim().length === 0 || skillPath.length > 4096) {
			throw new Error("Invalid skill path for rename.");
		}
		if (typeof newName !== "string" || newName.trim().length === 0 || newName.length > 256) {
			throw new Error("Invalid skill name for rename.");
		}
		const result = await manager.rename(skillPath, newName);
		void appLogger.info("skill", "Skill renamed", { skillPath, newName });
		return result;
	});
	ipcMain.handle(ipcChannels.skillsOpenFolder, async (_event, path?: string, options?: unknown) => {
		const manager = await resolvePiResourceWriteManager({ options, pool: piResourcePool, local: () => skillManager, pick: async (pool, parsed) => await pool.skills(parsed) });
		// WSL 目标：openSystemPath 对 UNC 路径若不被支持会抛错（不静默），错误经 IPC 上抛。
		return await manager.openFolder(path);
	});

	// ── 项目 MCP 读写（作用域 + 信任门禁；config 域其余通道见 ./systemConfigIpc.ts）──
	// MCP project layers are selected by a stable registered project id; renderer paths are never trusted.
	// MCP 作用域：projectId 省略 = 全局页；项目页固定写项目 .pi/mcp.json（读也要过信任门禁）。
	const assertTrustedMcpProject = async (projectId: string, root: string): Promise<void> => {
		if (!isProjectTrusted) throw new Error(mainCopy("mainProjectResource.projectNotTrusted"));
		if (!(await isProjectTrusted(projectId, root))) throw new Error(mainCopy("mainProjectResource.projectNotTrusted"));
	};
	ipcMain.handle(ipcChannels.configGetMcp, async (_event, scope: unknown) => {
		const parsed = parseMcpScopeRequest(scope);
		if (parsed.kind === "global") return configManager.getMcpConfig();
		const root = projectResourceManager.getProjectRoot(parsed.projectId);
		await assertTrustedMcpProject(parsed.projectId, root);
		return configManager.getMcpConfig(root, { writableScope: "project-pi", projectTrusted: true });
	});
	ipcMain.handle(ipcChannels.configSaveMcp, async (_event, data: unknown, scope: unknown, expectedRevision: unknown) => {
		const parsed = parseMcpScopeRequest(scope);
		if (!isMcpConfigFile(data)) {
			return { valid: false, error: "mcp.json must contain an object of server definitions" };
		}
		if (expectedRevision !== undefined && typeof expectedRevision !== "string") {
			return { valid: false, error: "Invalid expectedRevision." };
		}
		let result: { valid: boolean; error?: string; conflict?: boolean; revision?: string };
		if (parsed.kind === "global") {
			result = await configManager.saveMcpConfig(data, { expectedRevision });
		} else {
			const root = projectResourceManager.getProjectRoot(parsed.projectId);
			await assertTrustedMcpProject(parsed.projectId, root);
			// 项目写入走 ProjectResourceManager：canonical 边界 + 临时文件 rename，拒绝 junction 逃逸。
			const validationError = validateMcpConfigFile(data, { scope: "project-pi" });
			result = validationError ? { valid: false, error: validationError } : { valid: true };
			if (result.valid) {
				const write = await projectResourceManager.saveProjectMcpConfig(parsed.projectId, data, { expectedRevision });
				result = write.ok ? { valid: true } : { valid: false, error: write.error, conflict: write.conflict };
			}
		}
		void appLogger.info("config", "MCP config saved", {
			scope: parsed.kind,
			serverCount: Object.keys(data.mcpServers ?? {}).length,
			...(result.conflict ? { conflict: true } : {}),
		});
		return result;
	});
	// 轻量探测：不 spawn 用户 command、不连 MCP SDK。
	ipcMain.handle(ipcChannels.configProbeMcp, async (_event, definition: unknown) => {
		if (!isMcpServerDefinition(definition)) {
			return { ok: false, error: "invalid MCP server definition" };
		}
		return configManager.probeMcpServer(definition);
	});

	// ── pi mcp CLI：真实连接检测 + OAuth 登录/登出（仅命令路线，不走 RPC，见计划 M4/M6）──

	ipcMain.handle(ipcChannels.mcpListStatus, async (_event, scope: unknown) => {
		const parsed = parseMcpScopeRequest(scope);
		const result = await getPiMcpCli().list(parsed.kind === "global" ? { scope: "global" } : { scope: "project", projectId: parsed.projectId });
		void appLogger.info("config", "pi mcp list finished", {
			scope: parsed.kind,
			servers: result.servers.length,
			errors: result.errors.length,
			connected: result.servers.filter((server) => server.state === "connected").length,
		});
		return result;
	});

	ipcMain.handle(ipcChannels.mcpLogin, (event, server: unknown, timeoutSec: unknown, scope: unknown, operationId: unknown) => {
		if (typeof server !== "string" || !server.trim() || server.length > 128) {
			return Promise.resolve({ ok: false, output: "invalid server name" });
		}
		const seconds = typeof timeoutSec === "number" && Number.isFinite(timeoutSec) && timeoutSec > 0 ? Math.min(Math.floor(timeoutSec), 600) : 240;
		const parsed = parseMcpScopeRequest(scope);
		const operation = typeof operationId === "string" && operationId.length <= 128 ? operationId : undefined;
		const webContents = event.sender;
		return getPiMcpCli()
			.login(parsed.kind === "global" ? { scope: "global" } : { scope: "project", projectId: parsed.projectId }, server.trim(), seconds, {
				operationId: operation,
				onUrl: (url) => {
					// WSL 下 pi 自动开浏览器经常失败；把授权 URL 推给 UI 内嵌兜底（不弹 toast，见计划 M2）。
					// 带 operationId + scope：迟到结果不会串到别的 server/作用域/已关闭页面。
					if (!webContents.isDestroyed()) webContents.send(ipcChannels.mcpLoginUrl, { server: server.trim(), scope: parsed, operationId: operation, url });
				},
			})
			.catch((error: unknown) => ({ ok: false as const, output: error instanceof Error ? error.message : String(error) }));
	});

	ipcMain.handle(ipcChannels.mcpLogout, async (_event, server: unknown, scope: unknown) => {
		if (typeof server !== "string" || !server.trim() || server.length > 128) {
			return { ok: false, output: "invalid server name" };
		}
		const parsed = parseMcpScopeRequest(scope);
		return getPiMcpCli().logout(parsed.kind === "global" ? { scope: "global" } : { scope: "project", projectId: parsed.projectId }, server.trim());
	});
	// ── pi 原生资源配置（内置扩展开关 + 四类资源数组）──
	// 只改 pi 自己认识的字段；未知字段、用户 glob 与显式路径一律保留（见计划 A2/A4）。
	const getPiResources = (): import("../config/PiResourceConfigService").PiResourceConfigService => {
		piResourceService ??= new PiResourceConfigService(
			{
				globalSettingsPath: () => join(configManager.getConfigDir(), "settings.json"),
				resolveProject: async (projectId) => {
					const root = projectResourceManager.getProjectRoot(projectId);
					const trusted = isProjectTrusted ? await isProjectTrusted(projectId, root) : false;
					return { root, trusted };
				},
			},
			new PiResourceStateStore(join(app.getPath("userData"), "pi-native-resources.json")),
			{ projectTrust: (projectId, root) => (isProjectTrusted ? isProjectTrusted(projectId, root) : Promise.resolve(false)) },
		);
		return piResourceService;
	};
	ipcMain.handle(ipcChannels.piResourcesSummary, async (_event, scope: unknown) => {
		const parsed = parseMcpScopeRequest(scope);
		return getPiResources().readSummary(parsed.kind === "global" ? { scope: "global" } : { scope: "project", projectId: parsed.projectId });
	});
	ipcMain.handle(ipcChannels.piResourcesSetBuiltin, async (_event, input: unknown) => {
		if (!isUnknownRecord(input)) throw new Error("Invalid built-in extension input.");
		const parsed = parseMcpScopeRequest(input.scope);
		const name = input.name;
		const enabled = input.enabled;
		if (typeof name !== "string" || typeof enabled !== "boolean") throw new Error("Invalid built-in extension input.");
		const result = await getPiResources().setBuiltinEnabled(parsed.kind === "global" ? { scope: "global" } : { scope: "project", projectId: parsed.projectId }, name as import("../../shared/types/piResources").PiBuiltinExtension, enabled, {
			expectedRevision: typeof input.expectedRevision === "string" ? input.expectedRevision : undefined,
		});
		void appLogger.info("config", "pi built-in extension toggled", { scope: parsed.kind, name, enabled, ok: result.ok });
		return result;
	});
	ipcMain.handle(ipcChannels.projectsTrustResponse, (_event, requestId: string, choice: "trust-remember" | "trust-session" | "deny") => agentManager.respondTrustRequest(requestId, choice));
	// provider 模型 / 连通性 / 用量查询域已拆到 ./systemConfigProviderIpc.ts。
	registerSystemConfigProviderIpc({ configManager, settingsStore, appLogger, piLocator, skillManager });
	// TokenDance / Watcha 付费入口域已拆到 ./systemConfigTokensIpc.ts。
	registerSystemConfigTokensIpc({ appLogger, modelCapabilityCache, tokendanceCatalog, tokendancePricing, tokendanceAuth, tokendancePayment, watchaEntitlement, tokendanceInstall });
}
