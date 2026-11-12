import type { BrowserWindow, Tray } from "electron";
import type { PetSystem } from "../../pet";
import type { CuaService } from "../../cua/CuaService";
import type { SettingsStore } from "../../settings/SettingsStore";
import { isSharedDevBranch } from "../../devIsolation";
import type { AppSettings, SessionCommandError, SessionCommandResult, SessionRuntimeTarget } from "../../../shared/types";
import { isLocalProject } from "../../../shared/projectLocation";
import type { MainProcessTranslationKey } from "../../../shared/i18n/mainProcessCopy";
import type { ProjectStore } from "../../projects/ProjectStore";
import type { AgentManager } from "../../pi/AgentManager";
import type { PiModelCapabilityCache } from "../../pi/PiModelCapabilityCache";
import { syncAgentMemoryRegistration } from "../../agentMemory/AgentMemoryMcpRegistration";
import type { DshHost } from "../../dsh/DshHost";
import type { DshRuntimeManager } from "../../dsh/runtime/DshRuntimeManager";
import { createNetDownloader, createTarExtractor } from "../../dsh/runtime/dshRuntimeIo";
import type { DshAgentManager } from "../../dsh/DshAgentManager";
import type { PiLocator } from "../../pi/PiLocator";
import { testPiProxy } from "../../pi/PiProxyTester";
import type { SessionRuntimeCoordinator } from "../../sessions/SessionRuntimeCoordinator";
import type { SessionCommandIpcError } from "../../sessions/SessionCommandIpcError";
import { applyDesktopProxy } from "../../settings/DesktopProxy";
import type { ConfigManager } from "../../config/ConfigManager";
import type { PiResourceManagerPool } from "../../config/PiResourceManagerPool";
import type { TokendanceCatalogStore } from "../../config/tokendanceCatalog";
import type { TokendancePricingStore } from "../../config/tokendancePricing";
import { installTokendanceProvider } from "../../config/tokendanceInstaller";
import { TokendanceAuthStore } from "../../config/tokendanceAuth";
import { TokendancePaymentStore } from "../../config/tokendancePayment";
import { WatchaEntitlementStore } from "../../config/watchaEntitlement";
import { usageProbeRequest } from "../../config/usageProbeTransport";
import { TOKENDANCE_PROVIDER } from "../../../shared/tokendance";
import type { TerminalSessionManager } from "../../terminal/TerminalSessionManager";
import type { SkillManager } from "../../skills/SkillManager";
import { readSkillContent } from "../../skills/readSkillContent";
import type { ExtensionManager } from "../../extensions/ExtensionManager";
import type { ProjectResourceManager } from "../../projects/ProjectResourceManager";
import { toWindowsHostPath, toWslLinuxPath } from "../../wsl/WslPaths";
import type { RemoteAccessManager } from "../../web/remoteAccess/RemoteAccessManager";
import { registerSystemIpc } from "../../ipc/systemIpc";
import { getPiAiCatalogIndex, lookupPiAiCatalogEntry } from "../../pi/piAiBuiltinCatalog";
import type { WebServiceManager } from "../../web/WebServiceManager";
import type { AppLogger } from "../../logging/AppLogger";
import type { RpcLogger } from "../../logging/RpcLogger";
import type { FeishuBridge } from "../../feishu/FeishuBridge";
import { feishuT } from "../../feishu/FeishuI18n";
import type { FeishuLocale } from "../../feishu/FeishuI18n";
import { setFeishuConfigDefaultBotName } from "../../feishu/FeishuConfig";
import type { DiagnosticsMonitor } from "../../diagnostics/DiagnosticsMonitor";
import type { EnvironmentDoctor } from "../../health/EnvironmentDoctor";
import type { LogBundleExporter } from "../../health/LogBundleExporter";
import type { UpdateService } from "../../update/UpdateService";
import type { AgentMemoryMount } from "../../agentMemory/agentMemoryMounts";
import type { RemotePiConfigBackend } from "../../config/RemotePiConfigBackend";
import type { RemoteModelCatalog } from "../../remote/RemotePiModelCatalog";

/**
 * system 域 IPC 装配（自 index.ts 的 registerIpc 逐段外移，行为零变化）。
 *
 * ctx 只承载该段真正用到的实例与闭包：模块级单例按值传入（均在 registerIpc 之前完成单次赋值，
 * 读的是同一实例）；少数会在启动后续被替换的绑定（mainWindow / petSystem / tray）走 getter，
 * 保证闭包里读到的是当前值。调用顺序与搬迁前完全一致。
 */
export interface SystemStackContext {
	readonly agentManager: AgentManager;
	readonly appLogger: AppLogger;
	readonly applyNativeThemeSource: (settings: AppSettings) => void;
	readonly configManager: ConfigManager;
	readonly createAgentMemoryMount: (cwd?: string) => AgentMemoryMount;
	readonly getCuaService: () => CuaService | null;
	readonly currentFeishuLocale: () => FeishuLocale;
	readonly devGitBranch: string | undefined;
	readonly diagnosticsMonitor: DiagnosticsMonitor | null;
	readonly dshAgentManager: DshAgentManager;
	readonly dshHost: DshHost;
	readonly dshRuntimeManager: DshRuntimeManager;
	readonly environmentDoctor: EnvironmentDoctor | null;
	readonly extensionManager: ExtensionManager;
	readonly feishuBridgeRef: { current: FeishuBridge | null };
	readonly getIsQuitting: () => boolean;
	readonly setIsQuitting: (value: boolean) => void;
	readonly isolateDevByGitBranch: boolean;
	readonly logBundleExporter: LogBundleExporter | null;
	readonly mainCopy: (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;
	readonly getMainWindow: () => BrowserWindow | null;
	readonly openExternalUrl: (url: string, forceSystem?: boolean) => Promise<void>;
	readonly getPetSystem: () => PetSystem | null;
	readonly piLocator: PiLocator;
	readonly piModelCapabilityCache: PiModelCapabilityCache;
	readonly piResourcePool: PiResourceManagerPool | undefined;
	readonly projectResourceManager: ProjectResourceManager;
	readonly projectStore: ProjectStore;
	readonly refreshTrayContextMenu: () => void;
	readonly remoteAccessManager: RemoteAccessManager;
	readonly rpcLogger: RpcLogger;
	readonly sessionCommandIpcError: (error: SessionCommandError) => SessionCommandIpcError;
	readonly sessionRuntimeCoordinator: SessionRuntimeCoordinator;
	readonly settingsStore: SettingsStore;
	readonly skillManager: SkillManager;
	readonly stopAgentFromMonitor: (agentId: string) => Promise<SessionCommandResult<SessionRuntimeTarget | undefined>>;
	readonly stopDshHostFromMonitor: () => Promise<SessionCommandResult<undefined>>;
	readonly syncSelectionToolShortcut: () => void;
	readonly syncWslConfig: () => Promise<void>;
	readonly terminalManager: TerminalSessionManager;
	readonly getTray: () => Tray | null;
	readonly updateService: UpdateService | null;
	readonly webServiceManager: WebServiceManager;
	readonly remoteModelCatalogForProject: ((projectId: string, sessionId: string, force: boolean) => Promise<import("../../../shared/types").ModelListReport | null>) | undefined;
	readonly remotePiConfig: RemotePiConfigBackend | undefined;
	readonly remotePiModelCatalog: RemoteModelCatalog | undefined;
	readonly resolveWatchaUserId: () => Promise<string>;
	readonly tokendanceCatalogStore: TokendanceCatalogStore;
	readonly tokendancePricingStore: TokendancePricingStore;
}

export function registerSystemStack(ctx: SystemStackContext): void {
	const {
		agentManager,
		appLogger,
		applyNativeThemeSource,
		configManager,
		createAgentMemoryMount,
		currentFeishuLocale,
		devGitBranch,
		diagnosticsMonitor,
		dshAgentManager,
		dshHost,
		dshRuntimeManager,
		environmentDoctor,
		extensionManager,
		feishuBridgeRef,
		isolateDevByGitBranch,
		logBundleExporter,
		mainCopy,
		openExternalUrl,
		piLocator,
		piModelCapabilityCache,
		piResourcePool,
		projectResourceManager,
		projectStore,
		refreshTrayContextMenu,
		remoteAccessManager,
		rpcLogger,
		sessionCommandIpcError,
		sessionRuntimeCoordinator,
		settingsStore,
		skillManager,
		stopAgentFromMonitor,
		stopDshHostFromMonitor,
		syncSelectionToolShortcut,
		syncWslConfig,
		terminalManager,
		updateService,
		webServiceManager,
		remoteModelCatalogForProject,
		remotePiConfig,
		remotePiModelCatalog,
		resolveWatchaUserId,
		tokendanceCatalogStore,
		tokendancePricingStore,
	} = ctx;

	registerSystemIpc({
		// 设置保存后的主进程副作用：系统级划词快捷键按新键位/开关重注册（appShortcuts 同一时机）。
		afterSettingsUpdate: () => syncSelectionToolShortcut(),
		// WSL 来源/发行版/用户变化：立即重绑资源目录与 spawn 环境，省掉一次重启。
		// 配置文件目录（models.json / settings.json）已经换了一套，能力快照与 watcher 一起重指向。
		applyWslSettings: async () => {
			await syncWslConfig();
			piModelCapabilityCache?.invalidate();
			piModelCapabilityCache?.watchConfigDirectory();
		},
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
		// 项目目录信任判定（trust.json 最近父目录语义，与 storeIpc 同源）。
		// 漏装配会让项目作用域全部按「未信任」处理：项目 MCP 读写、项目 MCP 的 pi mcp CLI、
		// 以及 piResources 的项目级内置扩展开关都会被拒，而与 trust.json 里实际写了什么无关。
		// WSL 项目例外：信任判定用发行版内的 Linux 路径（trust.json 键也是 Linux 路径）。
		isProjectTrusted: async (projectId, projectRoot) => {
			const project = projectStore.get(projectId);
			const settings = settingsStore.get();
			const trustWslDistro = project?.environment === "wsl" ? (project?.wslDistro ?? settings.wslDistro) : undefined;
			const trustPath = process.platform === "win32" && trustWslDistro ? toWslLinuxPath(projectRoot, { distro: trustWslDistro }) : projectRoot;
			return (await configManager.getProjectTrustDecision(trustPath)) === true;
		},
		// pi 环境引导：便携 Node 安装器的真实 IO（下载/解压与 DSH runtime 同源，
		// 测试里注入替身；未装配时引导安装入口降级不可用）。
		piRuntimeNodeInstaller: {
			download: createNetDownloader((scope, message, detail) => {
				void appLogger.info(scope, message, detail);
			}),
			extract: createTarExtractor((scope, message, detail) => void appLogger.warn(scope, message, detail)),
		},
		// 「关于」面板读取启用中的 DSH 运行时版本
		dshRuntimeManager: dshRuntimeManager ?? undefined,
		// G17：RPC 日志按 backend 分流（DSH 走 DshAgentManager 领域调用记录）
		isDshAgent: (agentId) => dshAgentManager?.list().some((tab) => tab.id === agentId) === true,
		setDshRpcLogging: (agentId, enabled) => dshAgentManager.setRpcLogging(agentId, enabled),
		isDshRpcLogging: (agentId) => dshAgentManager.isRpcLogging(agentId),
		// 实时观看登记同样分流到 DSH 的广播器
		setDshRpcLogWatching: (agentId, watching) => dshAgentManager.setRpcLogWatching(agentId, watching),
		diagnosticsMonitor: diagnosticsMonitor ?? undefined,
		environmentDoctor: environmentDoctor ?? undefined,
		logBundleExporter: logBundleExporter ?? undefined,
		// 进程监控停止 agent：按 agentId 走完整会话停止链路（含 detach 推送）
		stopAgentFromMonitor,
		getDshHostPid: () => dshHost.getHostPid(),
		restartDshHost: async () => {
			await dshAgentManager.stopAll();
			await dshHost.restart();
			try {
				await dshHost.ensureStarted();
				return dshHost.isHostProcessRunning() && dshHost.isHostReady();
			} catch {
				return false;
			}
		},
		dshHostIsStarted: () => dshHost.isStarted(),
		providerMigration: {
			configManager,
			dshHost,
		},
		modelCapabilityCache: piModelCapabilityCache,
		remoteModelCatalogForProject,
		remoteModelCatalog: remotePiModelCatalog,
		// 内置 TokenDance 模型目录（live fetch + userData 缓存；
		// 作为一键配置的数据源：目录模型写入 models.json 后由 pi 运行时自行解析）
		tokendanceCatalog: tokendanceCatalogStore,
		// 同一份报价缓存服务模型选择器徽章（折扣/免费），与目录缓存分开（不同端点）
		tokendancePricing: tokendancePricingStore,
		// 内置 TokenDance OAuth 授权（PKCE S256 headless；verifier 内存持有，重启失效）
		tokendanceAuth: new TokendanceAuthStore(),
		// 内置 TokenDance 充值：与模型调用同一个 API Key（从 models.json 解析，只在本进程使用），
		// 创建/查询都走既有用量探针传输层（Electron net，服从系统代理与超时/字节上界）。
		tokendancePayment: new TokendancePaymentStore({
			resolveEndpoint: () => configManager.resolveProviderEndpoint(TOKENDANCE_PROVIDER),
			request: usageProbeRequest,
		}),
		// 「请作者喝咖啡」：查余额 + 按次扣减，全部经自家边缘代理；失败不拦截用户使用。
		watchaEntitlement: new WatchaEntitlementStore({ resolveUserId: resolveWatchaUserId, request: usageProbeRequest }),
		// 一键安装：pi models.json + DSH llm-pi-ai 双落盘（复用迁移服务的写盘策略：
		// host 就绪走官方 settings API，否则直写 settings.yaml/.credentials.yaml）
		tokendanceInstall: (apiKey) =>
			installTokendanceProvider(
				{
					configManager,
					dshHost,
					tokendanceCatalog: tokendanceCatalogStore,
					// 能力字段补全：目录只下 id/name/context_length，maxTokens/reasoning/
					// input/thinkingLevelMap 按模型 id 从 pi-ai 目录精确匹配（无模糊匹配，
					// 命不中就留空不猜默认值）。
					catalogLookup: (modelId) => lookupPiAiCatalogEntry(getPiAiCatalogIndex(), "tokendance", modelId),
				},
				{ apiKey },
			),
		listDshMonitorSessions: () => dshAgentManager.list().map((tab) => ({ title: tab.title })),
		stopDshHostFromMonitor,
		getMainWindow: () => ctx.getMainWindow(),
		// Logo 风格切换要同时刷托盘；Tray 实例归本文件持有，按 getter 注入避免 systemIpc 直接引用。
		getTray: () => ctx.getTray(),
		mainCopy: mainCopy as (key: string, params?: Record<string, string | number>) => string,
		// 适配层：checkForAppUpdate 直接触发 UpdateService 检查（结果经快照推送）；
		// download/install 同样转发给 UpdateService（electron-updater 驱动）。
		checkForAppUpdate: () => updateService?.checkNow() ?? Promise.resolve(),
		downloadAppUpdate: () => updateService?.downloadNow() ?? Promise.resolve(),
		installAppUpdate: () => updateService?.installNow(),
		openExternalUrl,
		extensionManager,
		// 设置变更副作用（代理 / 主题 / 飞书语言 / WSL / 宠物 / Web 服务）
		applyDesktopProxy,
		testPiProxy,
		// Web 服务启停后收敛外网访问渠道（隧道重建/serve 重指；见 RemoteAccessManager.syncWebService）
		applyWebServiceSettings: async (settings) => {
			await webServiceManager.applySettings(settings);
			await remoteAccessManager?.syncWebService();
		},
		restartWebService: async (settings) => {
			await webServiceManager.restart(settings);
			await remoteAccessManager?.syncWebService();
		},
		reactToPetSettings: async (prev, next) => {
			await ctx.getPetSystem()?.reactToSettings(prev, next);
		},
		// CUA / 浏览器 Agent 开关：任一能力启用时启动进程内 MCP 端点并写入 mcp.json，
		// 两者都关时停端点并注销；gate 在 applySettings 内按能力分别开关（host 存活 ≠ 能力启用）。
		reactToCuaSettings: async (prev, next) => {
			const cuaService = ctx.getCuaService();
			if (!cuaService) return;
			const cuaChanged = prev.cuaEnabled !== next.cuaEnabled;
			const browserChanged = prev.browserAgentEnabled !== next.browserAgentEnabled;
			if (!cuaChanged && !browserChanged) return;
			await cuaService.applySettings({
				cuaEnabled: next.cuaEnabled,
				browserAgentEnabled: next.browserAgentEnabled ?? false,
			});
		},
		// 智能体记忆开关：开启即幂等注册、关闭只删自己那一项（与启动时同一套动作）。
		reactToAgentMemorySettings: async (prev, next) => {
			if (prev.agentMemoryEnabled === next.agentMemoryEnabled) return;
			const synced = syncAgentMemoryRegistration({ enabled: next.agentMemoryEnabled, mount: createAgentMemoryMount() });
			void appLogger?.info("memory", "agent memory MCP synced", { action: synced.action, path: synced.path });
		},
		applyNativeThemeSource,
		refreshTrayContextMenu,
		// 语言变更时按当前主进程 locale 重算，忽略 systemIpc 传入的占位参数
		setFeishuLocale: () => {
			feishuBridgeRef.current?.setLocale(currentFeishuLocale());
		},
		setFeishuConfigDefaultBotName: (_name: string) => {
			// systemIpc 传入空串只是触发点；实际默认名必须按当前主进程 locale 重算。
			setFeishuConfigDefaultBotName(feishuT(currentFeishuLocale(), "bridge.defaultBotName"));
		},
		notifyTitleBarChange: (window) => settingsStore.notifyTitleBarChange(window),
		// 技能正文读取：注入路径白名单上下文（全局技能目录 + 已注册项目根），
		// 由 readSkillContent 完成校验后读 SKILL.md；WSL 项目按项目档案 distro 转主机路径。
		readSkillContent: (skillPath) =>
			readSkillContent(skillPath, {
				globalSkillPaths: skillManager.getLocations().map((location) => location.path),
				projectRootPaths: projectStore
					.list()
					.filter(isLocalProject)
					.map((project) => {
						const distro = project.environment === "wsl" ? (project.wslDistro ?? settingsStore.get().wslDistro) : undefined;
						if (process.platform === "win32" && distro !== undefined) {
							try {
								return toWindowsHostPath(project.path, { distro });
							} catch {
								return project.path;
							}
						}
						return project.path;
					}),
			}),
		sessionCommandIpcError,
		// 重启路径需要同步 ctx.getIsQuitting() / 停服务，避免 closeToTray 吞掉 relaunch
		webServiceManager,
		terminalManager,
		isQuitting: {
			get value() {
				return ctx.getIsQuitting();
			},
			set value(next: boolean) {
				ctx.setIsQuitting(next);
			},
		},
		devBranch: isolateDevByGitBranch && !isSharedDevBranch(devGitBranch) ? devGitBranch : undefined,
		updateService: updateService ?? undefined,
	});
}
