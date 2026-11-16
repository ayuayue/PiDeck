import { app, ipcMain, net } from "electron";
import type { BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import type { AutomationStore } from "../../automation/AutomationStore";
import type { AgentProfileStore } from "../../agents/AgentProfileStore";
import type { FavoritesStore } from "../../favorites/FavoritesStore";
import type { SessionGroupStore } from "../../sessionGroups/sessionGroupStore";
import type { LinkedSessionService } from "../../linkedSessions/LinkedSessionService";
import type { LinkedSessionStore } from "../../linkedSessions/LinkedSessionStore";
import { registerLinkedSessionsIpc } from "../../ipc/linkedSessionsIpc";
import type { AgentInvokeService } from "../../agents/AgentInvokeService";
import type { AutomationScheduler } from "../../automation/AutomationScheduler";
import type { AutomationRunCoordinator } from "../../automation/AutomationRunCoordinator";
import { registerAutomationIpc } from "../../ipc/automationIpc";
import { registerAgentProfileIpc } from "../../ipc/agentProfileIpc";
import { registerFavoritesIpc } from "../../ipc/favoritesIpc";
import { registerSessionGroupsIpc } from "../../ipc/sessionGroupsIpc";
import { registerAgentInvokeIpc } from "../../ipc/agentInvokeIpc";
import { registerSelectionToolIpc } from "../../ipc/selectionToolIpc";
import type { SelectionToolService } from "../../selection/SelectionToolService";
import type { SelectionToolWindow } from "../../selection/SelectionToolWindow";
import type { SettingsStore } from "../../settings/SettingsStore";
import { registerDataEnvIpc } from "../../ipc/dataEnvIpc";
import { ChannelSwitchService } from "../../update/ChannelSwitchService";
import { registerChannelSwitchIpc } from "../../ipc/channelSwitchIpc";
import type { DataEnvMode } from "../../../shared/types/dataEnv";
import { ipcChannels } from "../../../shared/ipc";
import { openSystemPath } from "../../fs/openPath";
import type { AcpAgentManager } from "../../acp/AcpAgentManager";
import { registerAcpIpc } from "../../ipc/acpIpc";
import type { PiLocator } from "../../pi/PiLocator";
import type { PiAuthService } from "../../pi/auth/PiAuthService";
import type { EnhancePromptService } from "../../pi/enhance/EnhancePromptService";
import { registerUsageStatsIpc } from "../../ipc/usageStatsIpc";
import type { UsageStatsService } from "../../usageStats/UsageStatsService";
import { registerBackgroundImageProtocol, registerBackgroundsIpc } from "../../ipc/backgroundsIpc";
import { registerWallpaperEngineIpc, registerWallpaperEngineProtocol } from "../../ipc/wallpaperEngineIpc";
import { registerThemesIpc } from "../../ipc/themesIpc";
import type { AppLogger } from "../../logging/AppLogger";
import { registerEditorsIpc } from "../../ipc/editorsIpc";
import { registerPiAuthIpc } from "../../ipc/piAuthIpc";
import { registerEnhanceIpc } from "../../ipc/enhanceIpc";
import { registerPromptSuggestionIpc } from "../../ipc/promptSuggestionIpc";
import type { QuitCleanupRegistry } from "../../lifecycle/QuitCleanupRegistry";
import type { AcpSessionConfigOption } from "../../../shared/types/acp";
import type { UpdateChannel } from "../../../shared/types/app";

/**
 * agents 域 IPC 装配（自 index.ts 的 registerIpc 逐段外移，行为零变化）。
 *
 * ctx 只承载该段真正用到的实例与闭包：模块级单例按值传入（均在 registerIpc 之前完成单次赋值，
 * 读的是同一实例）；少数会在启动后续被替换的绑定（mainWindow / petSystem / tray）走 getter，
 * 保证闭包里读到的是当前值。调用顺序与搬迁前完全一致。
 */
export interface AgentsStackContext {
	readonly acpAgentManager: AcpAgentManager;
	readonly agentInvokeService: AgentInvokeService | null;
	readonly agentProfileStore: AgentProfileStore | null;
	readonly annotateAcpConfigOptions: (options: AcpSessionConfigOption[] | undefined) => AcpSessionConfigOption[] | undefined;
	readonly appLogger: AppLogger;
	readonly automationRunCoordinator: AutomationRunCoordinator | null;
	readonly automationScheduler: AutomationScheduler | null;
	readonly automationStore: AutomationStore | null;
	readonly channelDevDataDir: string;
	readonly devDataMode: DataEnvMode | null;
	readonly enhancePromptService: EnhancePromptService | null;
	readonly fallbackSharedDataDir: string;
	readonly favoritesStore: FavoritesStore | null;
	readonly focusMainWindow: () => void;
	readonly getIsQuitting: () => boolean;
	readonly setIsQuitting: (value: boolean) => void;
	readonly linkedSessionService: LinkedSessionService | null;
	readonly linkedSessionStore: LinkedSessionStore | null;
	readonly getMainWindow: () => BrowserWindow | null;
	readonly piAuthService: PiAuthService | null;
	readonly piLocator: PiLocator;
	readonly promptSuggestionService: EnhancePromptService | null;
	readonly quitCleanup: QuitCleanupRegistry;
	readonly restartApp: () => void;
	readonly selectionToolService: SelectionToolService | null;
	readonly selectionToolWindow: SelectionToolWindow | null;
	readonly sessionGroupStore: SessionGroupStore | null;
	readonly settingsStore: SettingsStore;
	readonly updateChannel: UpdateChannel;
	readonly usageStatsService: UsageStatsService | null;
}

export function registerAgentsStack(ctx: AgentsStackContext): void {
	const {
		acpAgentManager,
		agentInvokeService,
		agentProfileStore,
		annotateAcpConfigOptions,
		appLogger,
		automationRunCoordinator,
		automationScheduler,
		automationStore,
		channelDevDataDir,
		devDataMode,
		enhancePromptService,
		fallbackSharedDataDir,
		favoritesStore,
		focusMainWindow,
		linkedSessionService,
		linkedSessionStore,
		piAuthService,
		piLocator,
		promptSuggestionService,
		quitCleanup,
		restartApp,
		selectionToolService,
		selectionToolWindow,
		sessionGroupStore,
		settingsStore,
		updateChannel,
		usageStatsService,
	} = ctx;

	registerUsageStatsIpc(ipcMain, usageStatsService);
	// 供应商认证（/login）：同样只做校验/适配，进程与协议在 PiAuthService
	registerPiAuthIpc(ipcMain, piAuthService);
	// 提示词增强（输入框增强按钮）：只做校验/适配，进程与协议在 EnhancePromptService
	registerEnhanceIpc(ipcMain, enhancePromptService);
	// 输入预测（回合结束预测下一句输入）：同一侧车协议、独立实例；模型指令由主进程注入。
	// 预测不弹提示，全部结论都靠 scope=suggest 的应用日志（设置 → 日志）可查。
	registerPromptSuggestionIpc(ipcMain, promptSuggestionService, {
		debug: (message) => void appLogger?.debug("suggest", message),
		info: (message) => void appLogger?.info("suggest", message),
		warn: (message) => void appLogger?.warn("suggest", message),
	});
	// 智能体：配置 CRUD + 一次性调用（划词工具）。store 在 whenReady 里已 load，
	// 这里只按域注册边界 handler；直接调用走独立侧车实例（见 agentInvokeCompletionService）。
	if (agentProfileStore) {
		registerAgentProfileIpc({
			store: agentProfileStore,
			appLogger,
			onNotifyChanged: (event) => {
				const win = ctx.getMainWindow();
				if (win && !win.isDestroyed()) win.webContents.send(ipcChannels.agentProfilesChanged, event);
			},
		});
	}
	// 收藏：整条回复 / 划选片段的本地快照（userData/favorites.json）。
	if (favoritesStore) registerFavoritesIpc({ store: favoritesStore, appLogger });
	// 会话分组：侧栏只读消费 + 插件页写入，同一份 store（userData/session-groups.json）。
	if (sessionGroupStore) registerSessionGroupsIpc({ store: sessionGroupStore, appLogger });
	if (linkedSessionStore && linkedSessionService) registerLinkedSessionsIpc({ store: linkedSessionStore, service: linkedSessionService, appLogger });
	registerAgentInvokeIpc(ipcMain, agentInvokeService);
	// 系统级划词浮窗：状态/隐藏/「发送到 PiDeck」（文本插入主窗口当前会话输入框）。
	registerSelectionToolIpc({
		service: selectionToolService,
		window: selectionToolWindow,
		insertToMain: (text) => {
			const win = ctx.getMainWindow();
			if (!win || win.isDestroyed()) return false;
			win.webContents.send(ipcChannels.selectionToolInserted, { text });
			focusMainWindow();
			return true;
		},
	});
	// 数据环境（数据模式决策 / 目录归属校验）：业务在 dataEnvService，handler 只校验/适配。
	// relaunchApp 复用 restartApp（先停常驻服务 + ctx.getIsQuitting()，防止 closeToTray 吞掉 relaunch）；
	// quitApp 先置 ctx.getIsQuitting()，与托盘「退出」菜单同一写法，避免 closeToTray 把退出吞成隐藏到托盘。
	registerAcpIpc({
		settingsStore,
		// 会话级配置桥惰性取 manager:注册时(此处)尚未实例化(4786 行 opt-in 段),
		// 与生命周期依赖同一条惰性模式。查询/下发两个出口都补模型倍率注解。
		getSessionManager: () =>
			acpAgentManager
				? {
						getSessionConfigOptions: (agentId) => annotateAcpConfigOptions(acpAgentManager?.getSessionConfigOptions(agentId)),
						applyConfigOption: async (agentId, optionId, value) => annotateAcpConfigOptions(await acpAgentManager?.applyConfigOption(agentId, optionId, value)) ?? [],
					}
				: undefined,
		// 生命周期命令编排惰性取 piLocator:注册时(2361 行附近)它尚未实例化(3484 行)。
		// createInvocation 复用 AcpAgentManager 同一入口(Windows .cmd 垫片),spawn 带 timeout 兜底。
		getLifecycleDeps: () => ({
			createInvocation: (command, args) => piLocator.createInvocation(command, args),
			spawn: (command, args, options) => spawn(command, args, { timeout: options.timeout, windowsHide: true }),
		}),
	});
	registerDataEnvIpc({
		getChannel: () => updateChannel,
		getDecisionDir: () => channelDevDataDir,
		getActiveDirectory: () => (devDataMode === "channel-dev" ? "channel-dev" : "shared"),
		getAppVersion: () => app.getVersion(),
		relaunchApp: restartApp,
		quitApp: () => {
			ctx.setIsQuitting(true);
			app.quit();
		},
		// 数据导入（规格 §6 单向正式→dev）：源 = 共用目录（与 setPath 的 fallbackSharedDir 同源），目标 = dev 独立目录。
		getSharedDataDir: () => fallbackSharedDataDir,
		getChannelDevDataDir: () => channelDevDataDir,
		sendProgress: (progress) => ctx.getMainWindow()?.webContents.send(ipcChannels.dataEnvImportProgress, progress),
	});

	// 频道切换（跨通道升级，规格 §3）：服务 electron-free，网络/临时目录/启动安装器/退出/推送在此装配。
	// quitApp 先置 ctx.getIsQuitting()，与 dataEnv/托盘「退出」同一写法，防 closeToTray 吞掉退出。
	const channelSwitchService = new ChannelSwitchService({
		currentChannel: () => updateChannel,
		// 版本守卫数据源：目标通道最新版不高于当前版本时判「已是最新」，不提供下载。
		currentVersion: () => app.getVersion(),
		netFetch: (url, init) => net.fetch(url, init),
		getTempDir: () => app.getPath("temp"),
		spawnInstaller: (filePath) => {
			// win：NSIS 安装器 detached 脱离父进程运行，PiDeck 退出后安装流程继续；mac/linux 由系统接管。
			if (process.platform === "win32") {
				const installer = spawn(filePath, [], { detached: true, stdio: "ignore" });
				// 安装器启动失败（路径失效/杀软拦截）也要有 error 兜底，否则未处理 error 事件炸主进程。
				installer.once("error", (error) => {
					void appLogger.warn("update", "Installer spawn failed", {
						filePath,
						error: error instanceof Error ? error.message : String(error),
					});
				});
				installer.unref();
				return;
			}
			void openSystemPath(filePath);
		},
		quitApp: () => {
			ctx.setIsQuitting(true);
			app.quit();
		},
		sendToRenderer: (snapshot) => {
			const win = ctx.getMainWindow();
			if (win && !win.isDestroyed()) {
				win.webContents.send(ipcChannels.channelSwitchStateChanged, snapshot);
			}
		},
		registerQuitCleanup: (name, cleanup) => {
			quitCleanup.register(name, cleanup);
		},
	});
	// 安装包目录白名单直接用服务的 getInstallerDir()，同源不拼第二份路径。
	registerChannelSwitchIpc({ service: channelSwitchService, getInstallerDir: () => channelSwitchService.getInstallerDir() });

	if (automationStore && automationScheduler && automationRunCoordinator) {
		registerAutomationIpc({
			automationStore,
			automationScheduler,
			automationRunCoordinator,
			appLogger,
			onNotifyChanged: (event) => {
				const win = ctx.getMainWindow();
				if (win && !win.isDestroyed()) {
					win.webContents.send(ipcChannels.automationChanged, event);
				}
			},
		});
	}

	const catalogIdentityContext = () => ({});

	registerEditorsIpc({
		settingsStore,
		appLogger,
		getMainWindow: () => ctx.getMainWindow(),
	});
	// 换肤背景图：协议服务 userData/backgrounds/，IPC 负责选图复制与删除
	registerBackgroundImageProtocol();
	registerBackgroundsIpc();
	// Wallpaper Engine 视频壁纸：协议只服务设置里的工坊目录，IPC 只有选目录/列表/校验三条
	const wallpaperEngineDeps = { getDir: () => settingsStore.get().weWorkshopDir ?? "" };
	registerWallpaperEngineProtocol(wallpaperEngineDeps);
	registerWallpaperEngineIpc(wallpaperEngineDeps);
	registerThemesIpc();
}
