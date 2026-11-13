import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, protocol, safeStorage, session, shell, Tray, Notification, webContents } from "electron";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { hostname, release as osRelease } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { exportCatalogSessionHtmlWithPorts } from "./sessions/catalogSessionHtmlExport";
import { registerSessionShareExportIpc } from "./ipc/sessionShareExportIpc";
import { SessionShareExportService } from "./sessions/SessionShareExportService";
import { createSessionShareSourceLoader } from "./sessions/sessionShareSource";
import { createPiSessionShareReader } from "./pi/piSessionShareReader";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { is } from "@electron-toolkit/utils";
import { PetSystem, type PetSystemDeps } from "./pet";
import { SoundAlertService } from "./sounds/SoundAlertService";
import { AnnouncementService } from "./announcements/AnnouncementService";
import { CuaService } from "./cua/CuaService";
import { BrowserAgentService } from "./browser/BrowserAgentService";
import { AutomationStore } from "./automation/AutomationStore";
import { AgentProfileStore } from "./agents/AgentProfileStore";
import { FavoritesStore } from "./favorites/FavoritesStore";
import { SessionGroupStore } from "./sessionGroups/sessionGroupStore";
import { LinkedSessionServer } from "./linkedSessions/LinkedSessionServer";
import { LinkedSessionService, lastAssistantTextSince } from "./linkedSessions/LinkedSessionService";
import { LinkedSessionStore } from "./linkedSessions/LinkedSessionStore";
import { registerLinkedSessionsIpc } from "./ipc/linkedSessionsIpc";
import { AgentInvokeService } from "./agents/AgentInvokeService";
import { applyBoundAgentPersona } from "./agents/agentPersonaInstruction";
import { AutomationScheduler } from "./automation/AutomationScheduler";
import { AutomationRunCoordinator } from "./automation/AutomationRunCoordinator";
import { registerAutomationIpc } from "./ipc/automationIpc";
import { registerAgentProfileIpc } from "./ipc/agentProfileIpc";
import { registerFavoritesIpc } from "./ipc/favoritesIpc";
import { registerSessionGroupsIpc } from "./ipc/sessionGroupsIpc";
import { registerAgentInvokeIpc } from "./ipc/agentInvokeIpc";
import { registerSelectionToolIpc } from "./ipc/selectionToolIpc";
import { SelectionToolService } from "./selection/SelectionToolService";
import { SelectionToolWindow } from "./selection/SelectionToolWindow";
import { ClipboardSelectionWatcher } from "./selection/clipboardSelectionWatcher";
import { WindowsSelectionCapture } from "./selection/windowsSelectionCapture";
import { resolveShortcutBindings } from "../shared/shortcuts";
import { SYSTEM_SELECTION_TOOL_ENABLED } from "../shared/types/selectionTool";
import { applyLinuxDisplayBackendWorkaround, isUsingLinuxXWaylandWorkaround } from "./linuxDisplayBackend";
import { registerFeishuIpc } from "./ipc/feishuIpc";
import { readBootPreferences } from "./settings/SettingsStore";
import { acquireVersionSingleInstance, type FocusPayload } from "./singleInstance";
import { mainProcessJsFlags, rendererHeapAdditionalArguments } from "./v8HeapLimits";
import { isDevToolsShortcut, toggleMainWindowDevTools } from "./devTools";
import { isShortcutInput, refreshShortcutBindings } from "./appShortcuts";
// 主进程复用共享的接管型扩展识别规则（与渲染层横幅单一来源；纯函数无依赖）。
import { detectThirdPartyMcpExtensions } from "../shared/mcpThirdParty";
import { PiResourceConfigService } from "./config/PiResourceConfigService";
import { isPackageSource, projectExtensionEnabled, projectExtensionFiltered } from "./config/PiResourceConfigService";
import { runPackageRootRuleRepair, type PackageRootRuleRepairDeps } from "./config/piPackageRootRuleRepair";
import { projectResourceEnabled } from "./config/piResourceRules";
import { PiResourceStateStore } from "./config/PiResourceStateStore";
import { readPiConfigFile } from "./config/piConfigFileStore";
import { ensurePiSettingsDefaults } from "./config/piSettingsDefaults";
import { runGlobalResourceMigration, runProjectResourceMigration } from "./config/piResourceMigrationRunner";
import type { ResolvedMigrationResource } from "./config/piResourceMigration";
import type { PiResourceScope } from "../shared/types/piResources";
import { createWindowZoomShortcutHandler } from "./windowZoom";
import { DEFAULT_DEV_USER_DATA_NAME, readDevGitBranch, resolveDevUserDataDirName } from "./devIsolation";
import { isPortablePackagedEnv, resolveAppUserDataDir, resolvePackagedUserDataDir } from "./portableUserData";
import { readDataEnvDecision } from "./dataEnv/dataEnvMarker";
import { registerDataEnvIpc } from "./ipc/dataEnvIpc";
import { ChannelSwitchService } from "./update/ChannelSwitchService";
import { registerChannelSwitchIpc } from "./ipc/channelSwitchIpc";
import { resolveUpdateChannel } from "./update/channelIdentity";
import { resolveBuildOrigin } from "./buildIdentity";
import { APP_DEEP_LINK_SCHEME } from "./utils/deepLinkScheme";
import { APP_DISPLAY_NAME, initializeAppBrand } from "./utils/appBrand";
import { migrateDevUserData } from "./projects/devUserDataMigration";
import { isMainWindowFocused, shouldAlertNow } from "./notifications/alertFocusGate";
import { buildToastXml, notificationLaunchUrl, resolveNotificationLogoUri } from "./notifications/notificationToast";
import { notifyAskPending as notifyAgentAskPending, notifySessionFinished, type AgentToastDeps } from "./notifications/agentToast";
import { extractFocusTargetFromArgv } from "./utils/focusTarget";
import type { Project, StartupWindowMode } from "../shared/types";
import { isLocalProject, isRemoteProject } from "../shared/projectLocation";
import type { DataEnvMode } from "../shared/types/dataEnv";
import { applyTrayLogoStyle, applyWindowLogoStyle } from "./appWindowLogo";
import { registerTaskbarIdentityAumid, resolveAppUserModelId, syncTaskbarShortcutIcon } from "./appTaskbarIdentity";

// 构建标记：npm run dist:*:dev 打包时由 vite define 注入 true（构建期替换，非运行时环境变量）。
declare const __PIDECK_DEV_BUILD__: boolean;

// dev 构建（PiDeck Dev 安装包）只影响通知归属（AUMID）与 deep link scheme（pideck-dev://），
// userData 与正式版**共用** PiDeck——双通道共用数据目录是刻意决策（2026-09）：
// 用户在 stable / dev 安装包之间切换不丢 settings / 会话 / 扩展配置。
// 未打包的 npm run dev 仍隔离到 PiDeck-dev(±分支后缀)，避免开发调试误写坏真实数据。
const isDevBuild = !app.isPackaged || __PIDECK_DEV_BUILD__;
// ready 前只为密钥环保留历史身份，窗口创建前恢复用户可见品牌，避免改 npm 名后旧密文失效。
initializeAppBrand(app, app.isPackaged && __PIDECK_DEV_BUILD__ ? "PiDeck Dev" : APP_DISPLAY_NAME);

// E2E（Playwright 驱动）静默运行：窗口显示但不抢焦点、不最大化铺满屏，
// 避免打断用户在其他软件的输入。fixture 通过 env PIDECK_E2E=1 标识。
const isE2E = process.env.PIDECK_E2E === "1";
// E2E 窗口默认摆到屏幕外（见 e2eWindowMode.ts）：不遮挡、不抢焦点、不进任务栏；
// PIDECK_E2E_WINDOW_MODE=visible 给 window-memory / quick-task 这类需要真实几何的用例回退。
const e2eWindowPlacement = resolveE2EWindowPlacement(isE2E, process.env.PIDECK_E2E_WINDOW_MODE);
if (isE2E) {
	// 屏幕外窗口会被 Windows 原生遮挡判定当成不可见 → 渲染/定时器节流，Playwright 点击与截图会卡住。
	for (const switchName of E2E_RENDERING_SWITCHES) app.commandLine.appendSwitch(switchName);
}
// disable-features 唯一拼装点（同名 switch 后值覆盖前值，禁在此之外再 append）：
// 默认清单（音频服务进程内等）与 E2E 的渲染保活条目合并成单次写入。
applyChromiumFeatureFlags(app.commandLine, isE2E ? ["CalculateNativeWinOcclusion"] : []);

// 冷启动计时锚点（2026-10 流畅度审计）：里程碑在 whenReady 与 showMainWindowOnce 记录，
// 日志对比 sinceModuleLoadMs / processUptimeMs 两个口径即可观测启动回归。
const bootAnchorMs = Date.now();

// userData 决策（三分支判定在 portableUserData.resolveAppUserDataDir，单测覆盖）：
// - 未打包 npm run dev：功能分支再按 git 分支名拆目录（PiDeck-dev-<branch>），
//   避免多个 worktree 同时启动共用 catalog / 单实例锁 / DSH home；main/dev 仍用历史目录。
// - 打包态（stable 与 dev 通道安装包）：共用 %APPDATA%/PiDeck（便携版 exe 同级 data/）。
// 必须在读取 settings / 版本单实例锁之前设置。
let userDataNameMigrationResult: UserDataNameMigration | null = null;
const isolateDevByGitBranch = !app.isPackaged;
const devGitBranch = isolateDevByGitBranch ? readDevGitBranch() : undefined;
const devUserDataDirName = isolateDevByGitBranch ? resolveDevUserDataDirName(devGitBranch) : DEFAULT_DEV_USER_DATA_NAME;
const explicitUserDataDir = (isE2E ? process.env.PIDECK_E2E_USER_DATA_DIR?.trim() : undefined) || app.commandLine.getSwitchValue("user-data-dir") || process.argv.find((arg) => arg.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
// 显式目录仅在 dev 态或 E2E 下生效：生产发行物不受外部参数影响，数据目录保持稳定
// （否则 e2e 会读到本机真实开发数据，settings/projects 全部污染测试断言）。
const gatedExplicitUserDataDir = explicitUserDataDir && (isDevBuild || isE2E) ? explicitUserDataDir : undefined;
// —— 数据环境决策（规格 §6 启动序列：ready 前只读不写，保持 setPath 时序）——
// 只有 dev 通道读决策指针：stable 恒走共用目录，不碰 dev 独立目录。
// 决策指针与独立数据目录同处（规格 §6）：读到 null = dev 首启未决策，本会话临时落共用目录运行。
const updateChannel = resolveUpdateChannel();
const devDirectoryMigration = migrateDevUserData({
	appDataDir: app.getPath("appData"),
	homeDir: app.getPath("home"),
	devDirectoryName: devUserDataDirName,
	isPackaged: app.isPackaged,
	channel: updateChannel,
	portableExeDir: process.platform === "win32" ? process.env.PORTABLE_EXECUTABLE_DIR?.trim() : undefined,
	explicitDir: gatedExplicitUserDataDir,
});
const channelDevDataDir = updateChannel === "dev" ? devDirectoryMigration.channelDevDataDir : "";
const devDataMode: DataEnvMode | null = updateChannel === "dev" ? (readDataEnvDecision(channelDevDataDir)?.dataMode ?? null) : null;
// 共用数据目录：既是 setPath 的 shared 分支，也是数据导入的源目录（与 fallbackSharedDir 同源，规格 §6 单向正式→dev）。
// 安装版历史根已由 %APPDATA%/pi-desktop 更名为 %APPDATA%/PiDeck：老用户首启在这里做一次性迁移
// （整目录改名 + 持久化绝对路径改写 + pi 会话 encoded 目录改名），迁移失败自动回退旧目录、下次启动重试。
// Windows 便携 exe 落到 PORTABLE_EXECUTABLE_DIR/data，与安装版隔离（否则同版本单实例锁让第二次启动静默退出）。
// 此处只迁移正式根；调试态与 Dev 独立环境在读取决策指针前由 migrateDevUserData 迁移。
const packagedAppDataDir = app.getPath("appData");
const fallbackSharedDataDir = resolvePackagedUserDataDir({ appData: packagedAppDataDir });
if (app.isPackaged && !gatedExplicitUserDataDir) {
	// 必须在通道决策分流之前迁移：迁移结果本身决定共用目录的最终落点
	// （改名成功 → PiDeck，失败 → 留在旧根，两者都喂给 resolveAppUserDataDir）。
	userDataNameMigrationResult = runUserDataNameMigration({
		appDataDir: packagedAppDataDir,
		homeDir: app.getPath("home"),
		portableOrExplicit: isPortablePackagedEnv(),
	});
	recordUserDataNameMigrationNotice(userDataNameMigrationResult);
}
app.setPath(
	"userData",
	resolveAppUserDataDir({
		explicitDir: gatedExplicitUserDataDir,
		unpackagedDevDir: devDirectoryMigration.unpackagedDevDir,
		isPackaged: app.isPackaged,
		channel: updateChannel,
		devDataMode,
		channelDevDataDir,
		fallbackSharedDir: userDataNameMigrationResult?.userDataPath ?? fallbackSharedDataDir,
	}),
);

// Linux XWayland 兼容层：仅当桌面宠物启用时才强制 ozone-platform=x11（#108，
// 强制 XWayland 在部分 GNOME/Wayland 环境会导致主窗口不可见）。
// ozone 平台一经启动不可更改，整个生命周期统一使用启动时快照。
// 注意必须放在 dev userData 覆盖之后，否则 dev 模式会误读正式版的 petEnabled。
// 启动偏好共享一次读取（沙箱/单实例/宠物开关同源 settings.json）：三个快照值在
// dev userData 覆盖之后一次读齐，替代原来三次独立的 readFileSync+JSON.parse。
const bootPreferences = readBootPreferences();
const petEnabledAtLaunch = bootPreferences.petEnabled;
applyLinuxDisplayBackendWorkaround(petEnabledAtLaunch);

// Chromium 沙箱开关必须在 app.ready 前生效。
// 默认关闭：Windows 上部分安全软件/旧 GPU 驱动会在沙箱初始化时触发原生断点（0x80000003）。
// 用户可在「开发设置」中开启 electronChromiumSandbox，重启后走 Chromium 默认沙箱。
const electronChromiumSandboxEnabled = bootPreferences.electronChromiumSandbox;
if (!electronChromiumSandboxEnabled) {
	// 关闭沙箱时显式附带 no-sandbox，避免部分环境仍按默认策略启用。
	app.commandLine.appendSwitch("no-sandbox");
}

// V8 老生代堆上限（分层，见 v8HeapLimits.ts 注释）：
// Chromium 默认上限 ≈ 物理内存 60%（8GB 机器 ≈ 4.8GB），V8 没有压力就不主动收缩，
// 会话消息/代码块高亮等大对象把堆撑大后 committed 空间长期不归还 OS（内存采样实测：
// V8 总 55MB → 210MB 不回落，RSS 基线随每次操作抬升）。
// 这里的 384MB 是**主进程**档位；渲染进程不能跟着吃这个值（会被 msg 体量打爆 V8，
// #213），所以每个窗口额外用 additionalArguments 抬到 RENDERER_MAX_OLD_SPACE_MB。
app.commandLine.appendSwitch("js-flags", mainProcessJsFlags());

// Windows 系统通知必须设置 AppUserModelID，否则通知不显示、点击事件不触发。
// dev 与正式版使用不同 AppID，避免通知中心归属混淆（与 dev userData 隔离思路一致）。
if (process.platform === "win32") {
	const appUserModelId = resolveAppUserModelId({ isDevBuild, devUserDataDirName, devGitBranch });
	app.setAppUserModelId(appUserModelId);
	// 任务栏按钮的身份（图标）靠更新「开始菜单里目标为本程序」的快捷方式，登记 AUMID 供其匹配，
	// 见 appTaskbarIdentity.ts（注册表 DisplayName/IconUri 只作用于通知，别往那条路上走）。
	registerTaskbarIdentityAumid(appUserModelId);
}

// 注册 deep link 自定义协议：系统通知点击（toast activationType="protocol"）通过该协议唤起应用，
// 唤起实例的 argv 携带 pideck://session/<id> URL，主进程据此跳转对应会话。
// 仅 packaged 应用注册：dev 模式跑的是 electron 二进制，注册会把协议关联劫持到 electron.exe，
// 覆盖已安装正式版的关联；dev 模式下通知点击依赖 Electron 原生 click 事件聚焦即可。
// E2E 实例（同为打包态）也默认跳过同一原因：#513 注册表按 scheme 全局唯一，跑一次用例
// 就会把真实安装版的 pideck:// 改写成临时 userData 的测试实例；需要验证深链的用例用
// PIDECK_E2E_REGISTER_PROTOCOL=1 显式 opt-in。
// 安装包内 electron-builder 的 protocols 配置也会在安装时写入注册表，此处是运行时兜底。
// dev 通道构建注册 pideck-dev://（安装清单同 scheme）：注册表按 scheme 为键，
// 两通道同 scheme 会互相抢占关联，点击通知会唤起错误的通道。
if (shouldRegisterDeepLinkProtocol({ isPackaged: app.isPackaged, isE2E, optIn: process.env.PIDECK_E2E_REGISTER_PROTOCOL === "1" })) {
	app.setAsDefaultProtocolClient(APP_DEEP_LINK_SCHEME);
}

// 按「应用版本」隔离的单实例：同版本复用窗口，不同版本可并行。
// 双通道共用 userData（PiDeck）的前提下，锁文件仍按版本分文件：
// stable 与 dev 通道版本号不同即可并存；同版本（含同版本的两个通道包）会复用窗口。
// 不用 Electron requestSingleInstanceLock：它按 userData 全局互斥，会导致 0.6.7 与 0.6.8 无法同开。
// focus 回调稍后挂到 focusMainWindow（定义在文件后部），避免顶层 TDZ。
// payload 携带次实例的 argv，可解析「点击系统通知」激活时携带的跳转目标。
let focusExistingWindow: ((payload?: FocusPayload) => void) | null = null;
const singleInstanceEnabled = bootPreferences.singleInstance;
// 本次启动是否来自深链激活（点系统通知 / 资源管理器右键打开项目）。即使开了多开也要先交给
// 已运行的同版本实例：通知点击的语义是「跳回那个会话」，不是「再开一个 PiDeck」（2026-10 用户反馈）。
const launchIsActivation = extractFocusTargetFromArgv(process.argv) !== undefined;
const versionSingleInstance = acquireVersionSingleInstance(
	singleInstanceEnabled,
	app.getVersion(),
	(payload) => {
		focusExistingWindow?.(payload);
	},
	{ routeActivation: launchIsActivation },
);
const gotSingleInstanceLock = versionSingleInstance.isPrimary;
if (!gotSingleInstanceLock) {
	// 同版本已有实例（单实例模式），或深链请求已交给它处理（多开模式）：立即退出，
	// 由主实例 watch .focus 后唤起窗口。用 exit(0) 而不是 quit()：第二进程尚未 ready，quit 更慢。
	app.exit(0);
}

// 开发模式下 stdout 管道可能断开导致 EPIPE 崩溃，全局静默处理
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
	if (err.code === "EPIPE") return;
	throw err;
});
process.stderr.on("error", (err: NodeJS.ErrnoException) => {
	if (err.code === "EPIPE") return;
	throw err;
});

process.on("uncaughtException", (error) => {
	void appLogger?.error("process", "Uncaught exception", error);
	console.error("Uncaught exception:", error);
});
process.on("unhandledRejection", (reason) => {
	void appLogger?.error("process", "Unhandled rejection", reason);
	console.error("Unhandled rejection:", reason);
});
import { agentEventTags, ipcChannels } from "../shared/ipc";
import { mainProcessT, normalizeMainProcessLocale, type MainProcessLocale, type MainProcessTranslationKey } from "../shared/i18n/mainProcessCopy";
import { buildSessionOriginKey, canonicalizeSessionPath, toAbsoluteSessionPath } from "../shared/sessionIdentity";
import type {
	AgentTab,
	AgentUiRequest,
	AppSettings,
	AppLogQuery,
	AvailableModel,
	ExternalEditor,
	ExternalEditorId,
	ExternalEditorSetting,
	CreateSessionDraftInput,
	CreateAnonymousSessionInput,
	CreateAnonymousSessionResult,
	UpdateSessionRecordInput,
	FeishuBotConfig,
	FeishuBridgeStatus,
	FeishuConnectInput,
	FeishuTestResult,
	SendPromptInput,
	SendPromptResult,
	SendSessionPromptInput,
	SessionRecord,
	SessionCommandError,
	SessionCommandResult,
	SessionSearchResult,
	SessionRuntimeEvent,
	SessionRuntimeTarget,
	SessionUiResponseInput,
	PiPromptTemplateSummary,
	PromptStoreSearchResult,
	PromptStoreSearchResponse,
	PromptStoreRawItem,
	PromptStoreItem,
	YaoPromptListResult,
	YaoPromptDetailResult,
} from "../shared/types";
import { msUntilNextThemeBoundary, resolveAppColorScheme } from "../shared/themeSchedule";
import { ProjectStore } from "./projects/ProjectStore";
import { runUserDataNameMigration, recordUserDataNameMigrationNotice, type UserDataNameMigration } from "./projects/userDataNameMigration";
import { shouldAutoRegisterForeignCwd } from "./projects/projectPathPolicy";
import { defaultPathCheck } from "./projects/projectPresence";
import { FileSystemService } from "./fs/FileSystemService";
import { openSystemPath } from "./fs/openPath";
import { AgentManager } from "./pi/AgentManager";
import { createRemoteRuntimePort } from "./pi/remoteRuntimePort";
import { PiProcess } from "./pi/PiProcess";
import { getModelTraceServer, stopModelTraceServer } from "./pi/modelTrace/ModelTraceServer";
import { PiModelCapabilityCache, watchPiConfigDirectory } from "./pi/PiModelCapabilityCache";
// 生图消息不走 Agent 消息流，改名前需判断标题是否仍是占位名
import { isDefaultAgentTitle } from "./pi/agentUtils";
import { CompositeAgentGateway } from "./agents/CompositeAgentGateway";
import { AcpAgentManager } from "./acp/AcpAgentManager";
import { buildAcpMcpServers, buildAgentMemoryMountForApp, memoryDirOfMount, resolveAgentMemoryDir, sourcesOfMount } from "./agentMemory/agentMemoryMounts";
import { runLearnerForAgent } from "./agentMemory/agentMemoryLearner";
import { resolveEnhanceTargetModel } from "../shared/enhanceModelPreference";
import { syncAgentMemoryRegistration } from "./agentMemory/AgentMemoryMcpRegistration";
import { clearAgentMemoryIndex, readAgentMemoryStatus } from "./agentMemory/agentMemoryStatus";
import { migrateAgentMemoryProjectKeys } from "./agentMemory/agentMemoryMigration";
import { deleteAgentMemoryEntries, deleteAgentMemoryEntry, readAgentMemoryEntries, readStandingEntry, restoreAgentMemoryEntry, writeStandingEntry } from "./agentMemory/agentMemoryEntries";
import { renameDevice } from "../../resources/agent-memory/sync.mjs";
import { exportAgentMemoryBundle, importAgentMemoryBundle, previewAgentMemoryBundle } from "./agentMemory/agentMemoryBundle";
import { registerAgentMemoryIpc } from "./ipc/agentMemoryIpc";
import { AcpSessionArchive } from "./acp/AcpSessionArchive";
import { createAcpModelRateAnnotator } from "./acp/acpModelRates";
import { withAcpConfigDefault } from "./acp/acpToolConfig";
import { broadcastCatalogRefreshed } from "./sessions/catalogRefresh";
import { registerAcpIpc } from "./ipc/acpIpc";
import { DshHost, resolveDshHomeDir } from "./dsh/DshHost";
import { DshPluginInstallService } from "./dsh/DshPluginInstallService";
import { DshRuntimeStatusService } from "./dsh/runtime/DshRuntimeStatus";
import { DshRuntimeManager, DSH_BUNDLED_RUNTIME_DIRNAME, readBundledRuntime, readDeclaredDshVersion } from "./dsh/runtime/DshRuntimeManager";
import { DshRuntimeInstaller, DSH_RUNTIME_VERSION_UNAVAILABLE_PREFIX } from "./dsh/runtime/DshRuntimeInstaller";
import { resolveDshRuntimeReleaseTag } from "./dsh/runtime/dshRuntimeReleaseTarget";
import { resolveDshRuntimeIndexUrl } from "../shared/types/dshRuntimeManifest";
import { autoUpdateDshRuntimeIfOutdated } from "./dsh/runtime/dshRuntimeAutoUpdate";
import { createNetDownloader, createTarExtractor, fetchDshRuntimeIndex } from "./dsh/runtime/dshRuntimeIo";
import { credentialValueFromDocument } from "./dsh/dshCredentials";
import { DshAgentManager } from "./dsh/DshAgentManager";
import { createDshSessionSkillLoader } from "./dsh/dshSessionSkillLoader";
import { listDshFilesystemSkills } from "./skills/skillCatalog";
import { startDshHostInBackground } from "./dsh/startDshHostInBackground";
import { importForeignSession, knownForeignSessionIds, syncForeignSessions, type DshForeignSyncDeps } from "./dsh/dshForeignSync";
import { PiLocator } from "./pi/PiLocator";
import { PiAuthService } from "./pi/auth/PiAuthService";
import { resolvePiAuthHostLaunch } from "./pi/auth/piAuthHostLaunch";
import { EnhancePromptService, PI_ENHANCE_HOST_FILENAME } from "./pi/enhance/EnhancePromptService";
import { testPiProxy } from "./pi/PiProxyTester";
import { SessionScanner } from "./sessions/SessionScanner";
import { resolveLaunchDefaultOptions, isModelInModelsConfig, resolveImSessionLaunchDefaults } from "./sessions/launchDefaults";
import { mergeCatalogModels } from "./pi/catalogModelsForValidation";
import { pickStandbyWarmupProject } from "./pi/standbyWarmupTarget";
import { createSessionModelPreference } from "../shared/modelDisplayName";
import { modelThinkingLevelOf } from "../shared/modelThinkingLevels";
import { SessionCatalog, canAttachRuntimeMetadata } from "./sessions/SessionCatalog";
import { waitForSessionRunEnd } from "./sessions/sessionRunWaiter";
import { aggregateDshProxyMode, buildHostProxyEnvPatch, resolveAcpProxySettings, resolveDshHostProxyMode, resolveEffectiveSessionProxyMode } from "./sessions/sessionProxyPolicy";
import { SessionRuntimeCoordinator, type SessionRuntimeBinding } from "./sessions/SessionRuntimeCoordinator";
import { migrateMergedSessionPinnedIds } from "./sessions/sessionPinnedIdsMigration";
import { IdleAgentReleaser } from "./sessions/IdleAgentReleaser";
import { VisibleSessionRegistry, shouldDeliverLiveStreamToMainWindow } from "./sessions/visibleSessionRegistry";
import { StaleDraftReaper } from "./sessions/StaleDraftReaper";
import { SessionCommandIpcError } from "./sessions/SessionCommandIpcError";
import { appendSessionForkSuffix } from "./sessions/sessionForkTitle";
import { sanitizeAutomaticTitle } from "./sessions/sessionTitleSanitize";
import { createSessionForkCommands } from "./sessions/sessionForkCommands";
import { createDshSessionFork } from "./sessions/dshSessionFork";
import { registerAllDomains } from "./api/domainAssembly";
import { CodexSessionImporter } from "./sessions/CodexSessionImporter";
import { ClaudeSessionImporter } from "./sessions/ClaudeSessionImporter";
import { QoderSessionImporter } from "./sessions/QoderSessionImporter";
import { OpenCodeSessionImporter } from "./sessions/OpenCodeSessionImporter";
import { ZCodeSessionImporter } from "./sessions/ZCodeSessionImporter";
import { WorkBuddySessionImporter } from "./sessions/codebuddyFamilySessionImporter";
import { CodeBuddySessionImporter } from "./sessions/codebuddyFamilySessionImporter";
import { CursorSessionImporter } from "./sessions/CursorSessionImporter";
import { KimiSessionImporter } from "./sessions/KimiSessionImporter";
import { KimiWorkSessionImporter } from "./sessions/KimiWorkSessionImporter";
import { MinimaxSessionImporter } from "./sessions/MinimaxSessionImporter";
import { DirectorySessionImporter } from "./sessions/DirectorySessionImporter";
import { normalizeSessionPathKey } from "./sessions/directorySessionImport";
import { SettingsStore } from "./settings/SettingsStore";
import { SecurityStore } from "./security/SecurityStore";
import { applyDesktopProxy } from "./settings/DesktopProxy";
import { GitService } from "./git/GitService";
import { GitRefsWatcher } from "./git/GitRefsWatcher";
import { WorktreeService } from "./git/WorktreeService";
import { ConfigManager } from "./config/ConfigManager";
import { ConfigBackupManager } from "./config/ConfigBackupManager";
import { createPiResourceManagerPool, type PiResourceManagerPool } from "./config/PiResourceManagerPool";
import { createPiResourceManagerFactories } from "./config/piResourceFactories";
import { createPiResourceTargetResolver } from "./config/PiResourceTargetResolver";
import { TokendanceCatalogStore } from "./config/tokendanceCatalog";
import { TokendancePricingStore } from "./config/tokendancePricing";
import { installTokendanceProvider } from "./config/tokendanceInstaller";
import { TokendanceAuthStore } from "./config/tokendanceAuth";
import { createRemoteTerminalManager } from "./terminal/createRemoteTerminalManager";
import type { RemoteTerminalSessionManager } from "./terminal/RemoteTerminalSessionManager";
import { TokendancePaymentStore } from "./config/tokendancePayment";
import { WatchaEntitlementStore } from "./config/watchaEntitlement";
import { usageProbeRequest } from "./config/usageProbeTransport";
import { TOKENDANCE_PROVIDER } from "../shared/tokendance";
import { TerminalSessionManager } from "./terminal/TerminalSessionManager";
import { TelemetryService } from "./telemetry/TelemetryService";
import { collectTelemetrySnapshot } from "./telemetry/telemetrySnapshot";
import { PromptManager } from "./prompts/PromptManager";
import { XuePromptManager } from "./prompts/XuePromptManager";
import { XueIndexService } from "./prompts/XueIndexService";
import { SessionIndexService } from "./sessions/SessionIndexService";
import { deriveOrphanSweepMarkers, sweepOrphanedManagedProcesses } from "./process/orphanSweep";
import { XuePromptDbStore } from "./prompts/XuePromptDbStore";
import { SkillManager } from "./skills/SkillManager";
import { readSkillContent } from "./skills/readSkillContent";
import { buildSkillInstallProxyEnv } from "./skills/skillHubInstallProxy";
import { ExtensionManager } from "./extensions/ExtensionManager";
import { readEffectiveBuiltInExtensionsVersion, resolveBuiltInExtensionsOverlayDir, type BuiltInExtensionPathRoots } from "./extensions/builtInExtensions";
import { createPiProcessExtensionResolvers } from "./extensions/piProcessExtensionResolvers";
import { startAppUpdate } from "./startup/appUpdate";
import { startResourceStores } from "./startup/resourceStores";
import { startCoreServices } from "./startup/services";
import { startSidecars } from "./startup/sidecars";
import { registerAgentsStack } from "./startup/ipcStacks/agentsStack";
import { registerContentStack } from "./startup/ipcStacks/contentStack";
import { registerGitStack } from "./startup/ipcStacks/gitStack";
import { registerHostServicesStack } from "./startup/ipcStacks/hostServicesStack";
import { startWeChatBridge } from "./startup/weChatBridge";
import { startRemoteAccess } from "./startup/remoteAccess";
import { startSoundsAndAnnouncements } from "./startup/soundsAndAnnouncements";
import { startWebService } from "./startup/webService";
import { registerMediaSessionStack } from "./startup/ipcStacks/mediaSessionStack";
import { registerMediaStack } from "./startup/ipcStacks/mediaStack";
import { registerPlatformStack } from "./startup/ipcStacks/platformStack";
import { registerRemoteStack } from "./startup/ipcStacks/remoteStack";
import { registerSessionsStack } from "./startup/ipcStacks/sessionsStack";
import { startPrewarm } from "./startup/sessionCatalogPrewarm";
import { registerSystemStack } from "./startup/ipcStacks/systemStack";
import { ProjectResourceManager } from "./projects/ProjectResourceManager";
import { ResourceImportManager } from "./resourceImport/ResourceImportManager";
import { toWslLinuxPath, toWindowsHostPath } from "./wsl/WslPaths";
import { registerProjectsIpc } from "./ipc/projectsIpc";
import { registerRemoteHostIpc } from "./ipc/remoteHostIpc";
import { registerRemoteHostRebindIpc } from "./ipc/remoteHostRebindIpc";
import { registerWslHostIpc } from "./ipc/wslHostIpc";
import { createWslHostReferenceRegistry } from "./wsl/WslHostReferences";
import { createWslHostStore } from "./wsl/WslHostStore";
import { resolveProjectWslIdentity, resolveSettingsWslIdentity } from "./wsl/WslProjectEnvironment";
import { createWslHelperSessionPool } from "./wsl/WslHelperSession";
import { registerRemoteProjectIpc } from "./ipc/remoteProjectIpc";
import { createRemoteFactsHub } from "./remote/RemoteFactsNotifications";
import { REMOTE_FEATURE_AVAILABLE } from "./remote/remoteFeaturePolicy";
import { registerRemoteProjectFileIpc } from "./ipc/remoteProjectFileIpc";
import { registerRemoteProjectTransferJobIpc } from "./ipc/remoteProjectTransferJobIpc";
import { registerRemoteProjectEntryIpc } from "./ipc/remoteProjectEntryIpc";
import { registerRemoteProjectTrustIpc } from "./ipc/remoteProjectTrustIpc";
import { registerRemoteSessionIpc } from "./ipc/remoteSessionIpc";
import { registerRemotePiModelIpc } from "./ipc/remotePiModelIpc";
import { createRemotePiModelProbe } from "./pi/RemotePiModelProbe";
import { createRemoteHostConnectionService, type RemoteHostConnectionService } from "./remote/RemoteHostConnectionService";
import { ROOT_POOL_DEFAULT_POLICY } from "./remote/RemoteRootSessionPool";
import { createRemoteModelCatalog, REMOTE_MODEL_CATALOG_CODES } from "./remote/RemotePiModelCatalog";
import { createSshClientRuntime, resolvePosixSshClient, type SshClientRuntime } from "./remote/SshClientRuntime";
import { buildPinnedSshInvocation } from "./remote/SshVerifiedConnection";
import { loadRemoteSftpBinaryIdentity, type RemoteSftpBinaryIdentity } from "./remote/RemoteSftpBinary";
import { createRemoteSftpCapabilityCache } from "./remote/RemoteSftpCapabilityCache";
import { createRemoteSftpCapabilityProbe } from "./remote/RemoteSftpCapabilityProbe";
import { createRemoteSftpDirectoryReader } from "./remote/RemoteSftpDirectoryReader";
import type { RemoteSftpProbe } from "./remote/RemoteSftpAdapter";
import { createRemoteSessionHistoryReader } from "./remote/RemoteSessionHistoryReader";
import { createRemoteSessionArchive } from "./remote/RemoteSessionArchive";
import { createRemoteSessionDelete } from "./remote/RemoteSessionDelete";
import { createRemotePiConfigBackend } from "./config/RemotePiConfigBackend";
import { createRemoteSessionHistoryWriter, type RemoteSessionMessageMutationPort } from "./remote/RemoteSessionHistoryWriter";
import { exportRemoteSessionHtml, REMOTE_SESSION_EXPORT_LIMITS } from "./remote/RemoteSessionHtmlExport";
import { createRemoteSessionScanner, type RemoteSessionCommandTransportPort } from "./sessions/RemoteSessionScanner";
import type { SshSessionLocator } from "../shared/projectLocation";
import { matchRemoteSessionProject } from "./remote/remoteSessionProjectMatch";
import { openRemoteHostCatalogView } from "./remote/RemoteHostCatalogView";
import { createRemoteProjectTrustHostFacts } from "./remote/RemoteProjectTrustHostFacts";
import { createRemoteProjectTrustService, type RemoteProjectTrustService } from "./remote/RemoteProjectTrustService";
import { createRemoteReferenceWriteGuard } from "./remote/RemoteReferenceWriteGuard";
import { registerUsageStatsIpc } from "./ipc/usageStatsIpc";
import { UsageStatsService } from "./usageStats/UsageStatsService";
import { saveLastWindowBounds } from "./windowState";
import { type MainWindowVisualEvent, type MainWindowVisualIntent, type MainWindowVisualState, nextMainWindowVisualIntent, planMainWindowReveal } from "./windowReveal";
import { E2E_RENDERING_SWITCHES, resolveE2EWindowPlacement } from "./e2eWindowMode";
import { shouldRegisterDeepLinkProtocol } from "./e2eProtocolRegistration";
import { applyChromiumFeatureFlags } from "./chromiumFeatureFlags";
import { createRendererCrashRecoveryGuard } from "./window/rendererCrashRecovery";
import { registerBackgroundImageProtocol, registerBackgroundsIpc } from "./ipc/backgroundsIpc";
import { registerWallpaperEngineIpc, registerWallpaperEngineProtocol } from "./ipc/wallpaperEngineIpc";
import { registerThemesIpc } from "./ipc/themesIpc";
import { registerHostPluginsIpc } from "./ipc/hostPluginsIpc";
import { registerPiDeckMcpIpc } from "./ipc/piDeckMcpIpc";
import { PiDeckMcpService } from "./mcp/PiDeckMcpService";
import { PiDeckMcpAcpSessions } from "./mcp/piDeckMcpAcpSessions";
import { HostPluginSessions } from "./plugins/HostPluginSessions";
import { HostPluginService } from "./plugins/HostPluginService";
import { BillionContextService } from "./localServices/billionContextService";
import { LocalServiceRegistry } from "./localServices/LocalServiceRegistry";
import { createLocalServiceCli, killLocalServiceProcess } from "./localServices/localServiceCli";
import { HOST_PLUGIN_SCHEME } from "./plugins/hostPluginPolicy";
import { hostPluginPartitionId, hostPluginWebviewBridge } from "./plugins/hostPluginWebviewPolicy";
import { registerRemoteGitReadIpc } from "./ipc/remoteGitReadIpc";
import { registerStoreIpc } from "./ipc/storeIpc";
import { registerTerminalIpc } from "./ipc/terminalIpc";
import { registerScratchPadIpc } from "./ipc/scratchPadIpc";
import { registerPasteFilesIpc } from "./ipc/pasteFilesIpc";
import { registerSecurityIpc } from "./ipc/securityIpc";
import { registerVisionIpc } from "./ipc/visionIpc";
import { registerImageGenIpc } from "./ipc/imagegenIpc";
import { registerCloudSyncIpc } from "./ipc/cloudSyncIpc";
import { CloudSyncManager } from "./cloudSync/CloudSyncManager";
import { ImageGenService } from "./imagegen/ImageGenService";
import { ImageSessionStore } from "./imagegen/ImageSessionStore";
import { ImageBlobStore } from "./imagegen/ImageBlobStore";
import { registerImageGenImageProtocol } from "./imagegen/ImageGenImageProtocol";
import { registerLocalImageProtocol } from "./media/LocalImageProtocol";
import { registerLocalImageIpc } from "./ipc/localImageIpc";
import { createCanonicalRootsProvider } from "./media/localImageRoots";
import { ImageGenConfigStore } from "./imagegen/ImageGenConfigStore";
import { registerVideoGenIpc } from "./ipc/videogenIpc";
import { VideoGenConfigStore } from "./videogen/VideoGenConfigStore";
import { VideoBlobStore } from "./videogen/VideoBlobStore";
import { VideoSessionStore } from "./videogen/VideoSessionStore";
import { VideoJobStore } from "./videogen/VideoJobStore";
import { VideoJobRunner } from "./videogen/VideoJobRunner";
import { registerVideoGenProtocol } from "./videogen/VideoGenProtocol";
import type { VideoGenJobSnapshot } from "../shared/types/videogen";
import { registerVoiceTranscriptionIpc } from "./ipc/voiceTranscriptionIpc";
import { VoiceTranscriptionConfigStore } from "./voice/VoiceTranscriptionConfigStore";
import { VoiceTranscriptionService } from "./voice/VoiceTranscriptionService";
import { createVolcStreamSocket } from "./voice/volcStreamSocket";
import { fetchWhisperReleaseDigests, WhisperRuntimeManager } from "./voice/WhisperRuntimeManager";
import { getWhisperModelDef } from "../shared/types/whisperRuntime";
import { WhisperTranscriber } from "./voice/WhisperTranscriber";
import { WhisperServerPool } from "./voice/WhisperServerPool";
import { VisionBridgeConfigManager } from "./settings/visionBridgeConfig";
import { scheduleCatalogBackgroundScan } from "./ipc/sessionIpc";
import { registerWebRemoteAccessIpc } from "./ipc/webRemoteAccessIpc";
import { RemoteAccessManager } from "./web/remoteAccess/RemoteAccessManager";
import { registerSystemIpc } from "./ipc/systemIpc";
import { registerResourceImportIpc } from "./ipc/resourceImportIpc";
import { registerBackupIpc } from "./ipc/backupIpc";
import { registerNoticeHistoryIpc } from "./ipc/noticeHistoryIpc";
import { NoticeHistoryStore } from "./notices/NoticeHistoryStore";
import { getPiAiCatalogIndex, lookupPiAiCatalogEntry } from "./pi/piAiBuiltinCatalog";
import { fetchModelList, refreshModelCatalogIfStale, refreshModelList, getCachedModelList } from "./pi/modelListCache";
import { registerFilesIpc } from "./ipc/filesIpc";
import { FileIndexService } from "./files/FileIndexService";
import { SessionStoreService } from "./sessions/SessionStoreService";
import { registerClipboardIpc } from "./ipc/clipboardIpc";
import { registerShellMenuIpc } from "./ipc/shellMenuIpc";
import { QuickTaskWindowChrome } from "./quickTask/quickTaskWindowChrome";
import { registerQuickTaskIpc } from "./ipc/quickTaskIpc";
import { registerFloatingIpc } from "./ipc/floatingIpc";
import { FloatingController } from "./floating/FloatingController";
import { MiniOverlayWindow } from "./floating/MiniOverlayWindow";
import { BROWSER_PANEL_PARTITION as BROWSER_PANEL_PARTITION_SHARED, isAllowedBrowserPanelUrl as isAllowedBrowserPanelUrlShared } from "./browser/browserSecurity";
import { WebServiceManager } from "./web/WebServiceManager";
import { preparePreloadPath } from "./preloadPath";
import { AppLogger } from "./logging/AppLogger";
import { setAppLogger } from "./logging/sharedLogger";
import { RpcLogger } from "./logging/RpcLogger";
import { RpcLogLiveBroadcaster } from "./logging/RpcLogLiveBroadcaster";
import { registerEditorsIpc } from "./ipc/editorsIpc";
import { registerPiAuthIpc } from "./ipc/piAuthIpc";
import { registerEnhanceIpc } from "./ipc/enhanceIpc";
import { registerPromptSuggestionIpc } from "./ipc/promptSuggestionIpc";
import { detectExternalEditors, listConfiguredExternalEditors, mergeDetectedExternalEditors, openProjectInEditor, validateExternalEditorCommand } from "./editors/EditorDetector";
import { FeishuBridge, type SessionRuntimeBindingGateway } from "./feishu/FeishuBridge";
import { feishuT, normalizeFeishuLocale, type FeishuLocale } from "./feishu/FeishuI18n";
import { wantsFeishuDoc } from "./feishu/docActions";
import { resolveFeishuFileSendIntent } from "./feishu/fileIntent";
import { listBots, getBot, addBot as addFeishuBot, removeBot as removeFeishuBot, updateBot as updateFeishuBot, getDecryptedBotAppSecret, getSessionBotId, setSessionBotId, setFeishuConfigDefaultBotName } from "./feishu/FeishuConfig";
import { WeChatService } from "./wechat/WeChatService";
import { startMemoryProfile, isMemoryProfileEnabled, type MemoryProfileHandle } from "./memory/MemoryMonitor";
import { DiagnosticsMonitor } from "./diagnostics/DiagnosticsMonitor";
import { EnvironmentDoctor } from "./health/EnvironmentDoctor";
import { LogBundleExporter } from "./health/LogBundleExporter";
import { QuitCleanupRegistry } from "./lifecycle/QuitCleanupRegistry";
import { ensureWindowsPathFresh } from "./process/windowsPathRefresh";
import type { FeishuChatBinding } from "../shared/types";
import { UpdateService } from "./update/UpdateService";

import { getTray, refreshTrayContextMenu, setupTray, type TrayDeps } from "./window/tray";
import { createMainWindow, type MainWindowDeps } from "./window/mainWindow";
let mainWindow: BrowserWindow | null = null;

// 托盘实现已搬进 src/main/window/tray.ts：托盘实例由该模块持有，其余单例仍由本文件拥有，
// 这里只把读取入口交给它（菜单动作、更新检查、悬浮球控制器、退出标志）。
const trayDeps: TrayDeps = {
	appLogger: () => appLogger,
	settings: () => settingsStore.get(),
	projectStore: () => projectStore,
	quitCleanup: () => quitCleanup,
	updateService: () => updateService,
	floatingController: () => floatingController,
	restartApp,
	markQuitting: () => {
		isQuitting = true;
	},
	translate: (key, params) => mainCopy(key, params),
	focusMainWindow: () => focusMainWindow(),
	queueFocusTarget: (target) => queueFocusTarget(target),
	getMainWindow: () => mainWindow,
	revealMainWindow: (window) => revealMainWindow(window),
};

/**
 * 主窗口最后一次的呈现态（用户手动最大化/还原/全屏的结果）。
 * 唤起窗口时按它重新施加：Windows 上从最小化/隐藏唤回的窗口不保证仍是最大化，
 * 见 revealMainWindow 与 windowReveal.ts。
 */
let mainWindowVisualIntent: MainWindowVisualIntent = "normal";
/** 主窗口实际挂载的会话（当前 + 分屏）：live 流只发这些会话，见 visibleSessionRegistry.ts。 */
const visibleSessions = new VisibleSessionRegistry();
/**
 * 草稿 DSH 会话的技能目录入口（懒装配）：sessionCatalog/dshAgentManager 都是
 * whenReady 之后才赋值，构造必须延迟到首次 IPC 调用，避免启动顺序耦合。
 */
let dshSessionSkillLoader: ReturnType<typeof createDshSessionSkillLoader> | undefined;
function getDshSessionSkillLoader(): ReturnType<typeof createDshSessionSkillLoader> {
	dshSessionSkillLoader ??= createDshSessionSkillLoader({
		getEntry: (sessionId) => {
			const entry = sessionCatalog.get(sessionId);
			if (!entry) return undefined;
			return { backend: entry.backend, status: entry.status, noSession: entry.noSession, projectId: entry.projectId, dshSessionId: entry.dshSessionId, agentPreset: entry.agentPreset };
		},
		getProjectPath: (projectId) => projectStore.get(projectId)?.path,
		// 预览层：通用 SKILL.md 文件系统扫描（pi/dsh 共用逻辑），不依赖 host/agent。
		scanFilesystem: async (entry) => {
			const projectPath = projectStore.get(entry.projectId)?.path;
			if (!projectPath) return [];
			return listDshFilesystemSkills({
				projectPath,
				dshHome: dshHost.getHomeDir(),
				agentsHome: process.env.DSH_AGENTS_HOME?.trim() || undefined,
				bundledSkillDir: process.env.DSH_BUNDLED_SKILL_DIR?.trim() || undefined,
			});
		},
		ensureHostSession: (cwd, agentPreset) => dshAgentManager.ensureAttachableHostSession(cwd, agentPreset),
		attachHostSession: async (deckSessionId, dshSessionId, agentPreset) => {
			const updated = await sessionCatalog.attachRuntime({ sessionId: deckSessionId, dshSessionId, ...(agentPreset ? { agentPreset } : {}) });
			// host id 回写后渲染层的「模式锁定」/删除墓碑语义随之变化，静默重拉该项目列表。
			mainWindow?.webContents.send(ipcChannels.sessionsCatalogRefreshed, { projectId: updated.projectId });
		},
		dismissHostSession: (dshSessionId) => sessionCatalog.rememberDismissedDshSession(dshSessionId),
		listSkills: (dshSessionId) => dshAgentManager.listSkillsByHostSession(dshSessionId),
	});
	return dshSessionSkillLoader;
}
// 紧凑模式（右键小任务）与主窗口几何的接线统一收在 quickTaskWindowChrome：
// 本文件不再出现紧凑模式的激活判断、屏幕几何计算与「关闭=返回工作台」的拦截逻辑。
const quickTaskChrome = new QuickTaskWindowChrome({
	getWindow: () => mainWindow,
	saveWorkbenchBounds: (bounds) => saveLastWindowBounds(app.getPath("userData"), bounds),
});
let floatingController: FloatingController | null = null;
let miniOverlayWindow: MiniOverlayWindow | null = null;
/** 标记是否由用户主动退出（托盘菜单「退出」），区别于窗口关闭隐藏到托盘 */
let isQuitting = false;
/** 渲染进程崩溃自动恢复守卫（2026-08 黑屏治理，见 window/rendererCrashRecovery.ts）：
 *  非正常崩溃自动 reload 恢复，崩溃风暴（60s 内超 2 次）放弃。 */
const rendererCrashGuard = createRendererCrashRecoveryGuard();
let projectStore: ProjectStore;
/** rebind IPC 的启动收敛入口（Q8）；注册发生在 whenReady 前半段，调用发生在两个 store load 之后。 */
let remoteHostRebindIpc: { resumePendingAtStartup: () => Promise<void> } | undefined;
let fileSystemService: FileSystemService;
/**
 * 跨会话正文搜索的项目来源：当前环境可见的项目（WSL 项目不进——宿主 Go 进程读 UNC
 * 不可靠，WSL 模式下 scanner 自身也会返回空根整体降级）。项目级 sessionDir 是不少
 * 用户实际的会话落点，漏掉它就会出现「明明有这条消息却搜不到」。
 */
function projectPathsForContentSearch(): string[] {
	return (
		projectStore
			.list()
			// 远端项目没有本机 path（搜索进程读不到远端目录），与 WSL 一样整体不进索引根。
			.filter(isLocalProject)
			.filter((project) => project.environment !== "wsl")
			.map((project) => project.path)
	);
}
/**
 * 会话内检索的一个会话实现（只扫给定会话文件、命中按时间线返回）：桌面 Ctrl+Shift+F
 * （sessionIpc 的 sessionMessageSearch）与 Web 搜索弹层（WebServiceManager 的
 * searchSessionMessages）共用同一份降级口径——未就绪先 warmup 再返回 null（渲染层显示
 * 「索引准备中」，绝不让输入框等 boot），refresh 失败但索引仍可用时继续搜一次
 * （transient 失败不该让本次检索静默无内容）。返回 null 恒表示「检索源不可用」。
 */
function sessionMessageSearchInFile(sessionPath: string, query: string): Promise<SessionSearchResult | null> {
	// 先取本地快照：下面每处 await 之后 sidecar 都可能已被退出清理置空，逐次判空最稳。
	const service = sessionIndexService;
	if (!service) return Promise.resolve(null);
	return (async () => {
		const roots = await sessionScanner.resolveContentSearchRoots(projectPathsForContentSearch());
		if (roots.length === 0) return null;
		if (!service.isReady(roots)) {
			service.warmup(roots);
			return null;
		}
		const refreshed = await service.refresh(roots);
		if (!refreshed.ok && !service.isReady(roots)) return null;
		const result = await service.searchInSession(roots, sessionPath, query);
		return result.ok ? result.value : null;
	})();
}
let sessionScanner: SessionScanner;
let sessionCatalog: SessionCatalog;
let sessionRuntimeCoordinator: SessionRuntimeCoordinator;
/**
 * 远端会话消息改写端口（P4.5c）：编辑 / 删除 / 重发三条链路共用的写面。
 *
 * 为什么是模块级 let 而不是构造期常量：写面依赖 pinned SSH 短命令，而那条通道在 `registerIpc()`
 * （挂在下面的启动流程里）才装配；协调器构造时把 `() => remoteSessionMessageMutation` 作为解析器注入，
 * 于是「开关关闭 / 尚未装配」在调用时自然就是 undefined ⇒ fail-closed，不需要 setter，也不把业务
 * 分支塞回本文件。
 */
let remoteSessionMessageMutation: RemoteSessionMessageMutationPort | undefined;
/**
 * 远端一次性短命令传输（R1a）：扫描 / 会话根解析 / 登记用它替代 helper 会话，不再切 host 的活动 root。
 *
 * 为什么是模块级 let：它由 `registerIpc()` 与 pinned SSH 通道一起装配（那里才知道已验过的客户端），
 * 而 `AgentManager` 的远端运行时端口比 `registerIpc()` 更早构造 — 与 `remoteProjectTrustService` 同理，
 * 用解析器（`resolveRemoteTransport`）在**真正登记会话时**才求值，才不会捕获一个当时还不存在的对象。
 */
let remoteCommandTransport: RemoteSessionCommandTransportPort | undefined;
/**
 * 远端项目 trust 决策服务（P4.4b）：决策表读写 + 主机 pin 事实 → 四态。
 *
 * 为什么是模块级 let：它同时在两处被拿去用——`registerIpc()`（trust 域 IPC 与主机退役清理钩子）和
 * `AgentManager` 构造时注入的远端运行时端口（`resolveTrust` 闭包在**真正 spawn 时**才求值）。
 * 后者比前者早执行，用解析器而不是实例就避免了「构造时捕获一个当时还不存在的对象」。
 */
let remoteProjectTrustService: RemoteProjectTrustService | undefined;
/** 闲置 agent 自动释放器（内存优化）：whenReady 阶段装配，quit 时 stop */
let idleAgentReleaser: IdleAgentReleaser | null = null;
let staleDraftReaper: StaleDraftReaper | null = null;
let codexSessionImporter: CodexSessionImporter;
let claudeSessionImporter: ClaudeSessionImporter;
let qoderSessionImporter: QoderSessionImporter;
let openCodeSessionImporter: OpenCodeSessionImporter;
let zcodeSessionImporter: ZCodeSessionImporter;
let workbuddySessionImporter: WorkBuddySessionImporter;
let codebuddySessionImporter: CodeBuddySessionImporter;
let cursorSessionImporter: CursorSessionImporter;
let kimiSessionImporter: KimiSessionImporter;
/** Kimi Work（桌面版）会话导入；daimon-share 位置不固定，内部走探测链。 */
let kimiWorkSessionImporter: KimiWorkSessionImporter;
/** MinimaxCode（CLI）会话导入；数据目录固定 ~/.minimax，无探测链。 */
let minimaxSessionImporter: MinimaxSessionImporter;
/** 外置目录会话导入（项目目录移动/改名后找回历史）；只建 catalog 引用，不复制文件。 */
let directorySessionImporter: DirectorySessionImporter;
let settingsStore: SettingsStore;
let securityStore: SecurityStore;
let worktreeService: WorktreeService;
let gitService: GitService;
/** refs 变化监听：面板订阅 push/commit/fetch，主进程推送后角标秒级跟平（轮询仍作兜底） */
let gitRefsWatcher: GitRefsWatcher;
let piLocator: PiLocator;
let agentManager: AgentManager;
/** 全局模型 capability snapshot；仅在启动/配置变更时临时拉起 Pi。 */
let piModelCapabilityCache: PiModelCapabilityCache | undefined;
/** DSH 深融合宿主与后端网关；窗口创建后后台预热，发送链路仍可按需兜底。 */
let dshHost: DshHost;
/** DSH 用户插件安装服务（npm pack → 受管目录 → 用户补丁层行；随 DshHost 装配）。 */
let dshPluginInstallService: DshPluginInstallService | undefined;
/** DSH runtime 安装态服务（AgentRuntimeProvider 阶段 1）：installed 门控 UI/新建会话。 */
let dshRuntimeStatus: DshRuntimeStatusService;
/** DSH runtime 生命周期管理（阶段 2）：外部 runtime 的扫描/下载/安装/回收。 */
let dshRuntimeManager: DshRuntimeManager;
/** DSH runtime 安装编排（阶段 2）：索引选版本 + 进度广播。 */
let dshRuntimeInstaller: DshRuntimeInstaller;
let dshAgentManager: DshAgentManager;
let acpAgentManager: AcpAgentManager;
/** ACP 模型倍率注解：读本机 magpie 缓存（缺省空表），查询/下发/推送三个出口共用同一份。 */
const annotateAcpConfigOptions = createAcpModelRateAnnotator();
/** 生图 blob 存储的延迟引用：imagegen 初始化在另一装配段，ACP 图片物化经此取实例（未初始化时物化退化为保留 data）。 */
let acpImageBlobStore: ImageBlobStore | null = null;
/** 多后端合成网关（pi + dsh + 未来后端）；启动装配后赋值，供发送链路按 agentId 路由。 */
let compositeAgentGateway: CompositeAgentGateway | undefined;
let configManager: ConfigManager;
/** pi 原生资源配置服务与迁移状态（A2/A3；启动装配，IPC 复用）。 */
let piResourceConfigService: PiResourceConfigService | undefined;
let piResourceStateStore: PiResourceStateStore | undefined;
/** Agent spawn 前的迁移保证（幂等）；由启动装配注入，未注入时视为无需迁移。 */
let ensurePiResourceMigration: ((projectId?: string) => Promise<void>) | undefined;
/** 全局 settings.json 的 skills / prompts / extensions 条目缓存（供列表状态投影；迁移/开关后刷新）。 */
let skillManagerNativeEntries: string[] | null = null;
let promptManagerNativeEntries: string[] | null = null;
let extensionManagerNativeEntries: string[] | null = null;
/** settings.json 的 packages 条目缓存：整包停用写在这里，扩展投影必须一并读取。 */
let extensionManagerNativePackages: unknown[] | null = null;
let configBackupManager: ConfigBackupManager | undefined;
let promptManager: PromptManager;
let xuePromptManager: XuePromptManager;
/** 提示词库 Go sidecar 客户端（null = 未装配；进程生命周期与 app 一致）。 */
let xueIndexService: XueIndexService | null = null;
let sessionIndexService: SessionIndexService | null = null;
/** 工作区文件索引 sidecar（Go file-index）：名字模糊检索 + 有界内容检索，缺失时回退 BFS。 */
let fileIndexService: FileIndexService | null = null;
/**
 * 会话数据面 sidecar（Go session-store，Wave 1 骨架）：快照 + 行边界增量扫描。
 * 暂无消费者（Wave 2 的窗口化读取会接进来），装配只做二进制定位与退出清理登记。
 */
let sessionStoreService: SessionStoreService | null = null;
/** 提示词库 db 远程拉取/缓存服务；null = 未装配。 */
let xuePromptDbStore: XuePromptDbStore | null = null;
let skillManager: SkillManager;
let extensionManager: ExtensionManager;
/** 资源作用域池（W1）：技能/提示词/扩展按 PiResourceTarget 路由；本机复用现有四个单例。 */
let piResourcePool: PiResourceManagerPool | undefined;
/** 后台更新检查服务（启动延迟 + 2h 周期，无配额方案）；null = 未初始化。 */
let updateService: UpdateService | null = null;
let projectResourceManager: ProjectResourceManager;
let resourceImportManager: ResourceImportManager;
let webServiceManager: WebServiceManager;
let remoteAccessManager: RemoteAccessManager;
let terminalManager: TerminalSessionManager;
let remoteTerminalManager: RemoteTerminalSessionManager | undefined;
let petSystem: PetSystem | null = null;
/**
 * 远端连接服务的按需访问器（Phase 4 P4.2）。
 *
 * 由 `registerIpc` 在装配远端 IPC 时登记：服务是实验门禁下的懒建单例，而 AgentManager 装配得更早，
 * 所以远端运行时端口拿到的是「读取器」而不是实例 —— 既不会重复建第二个 client（那会用一套不同于
 * 会话验证时的环境拉 ssh），也不会把门禁表达式抄成两份。
 */
let remoteHostServiceResolver: (() => Promise<RemoteHostConnectionService> | undefined) | undefined;
/** 声音提醒服务（完成/出错/等待输入提示音）；null = 未初始化 */
let soundAlertService: SoundAlertService | null = null;
/** 应用公告服务（无服务器拉取模式）；null = 未初始化 */
let announcementService: AnnouncementService | null = null;
/** CUA（Computer Use Agent）服务；null = 未初始化 */
let cuaService: CuaService | null = null;
/** 浏览器 Agent 服务（内置 webview + CDP）；null = 未初始化 */
let browserAgentService: BrowserAgentService | null = null;
/** 定时任务与自动化服务；null = 未初始化 */
let automationStore: AutomationStore | null = null;
let automationScheduler: AutomationScheduler | null = null;
let automationRunCoordinator: AutomationRunCoordinator | null = null;
let appLogger: AppLogger;
let rpcLogger: RpcLogger;
/** 内存采样句柄（PIDECK_MEMORY_PROFILE=1 时启用），quit 时停止 */
let memoryProfileHandle: MemoryProfileHandle | null = null;
/** 设置开关控制的开发诊断（内存 CSV + 事件循环延迟 + 关键耗时） */
let diagnosticsMonitor: DiagnosticsMonitor | null = null;
/** 环境体检编排器（问题反馈页一键排障） */
let environmentDoctor: EnvironmentDoctor | null = null;
/** 诊断产物导出器（Markdown / zip 日志包） */
let logBundleExporter: LogBundleExporter | null = null;
// feishuBridge 是跨域共享可变单例：飞书 IPC（连接/重连/删除）、退出清理、setLocale、
// 会话绑定查询都读写它；用 ref 对象而非裸 let，便于把飞书 IPC 域迁出本文件后共享同一槽位。
const feishuBridgeRef: { current: FeishuBridge | null } = { current: null };
// 微信桥接同样需要跨域共享（IPC 域 + 退出清理），用同一套 ref 槽位约定。
const wechatServiceRef: { current: WeChatService | null } = { current: null };
// 退出清理路径与 IPC 域共用同一槽位（见 ipc/feishuIpc.ts）。
let usageStatsService: UsageStatsService | null = null;
/**
 * 供应商认证服务（`/login` 弹框的后端）：pi 的登录只在它的 CLI 交互层存在，
 * 应用内登录必须绕过 RPC 直调 pi 的认证 API，见 AGENTS.md「认证例外通道」。
 */
let piAuthService: PiAuthService | null = null;
/** 提示词增强服务（输入框增强按钮的后端）：常驻助手进程复用用户那套 pi 的 ModelRuntime。 */
let enhancePromptService: EnhancePromptService | null = null;
/** 智能体配置存储（<userData>/agent-profiles.json）；null = 尚未初始化。 */
let agentProfileStore: AgentProfileStore | null = null;
/** 收藏存储（<userData>/favorites.json）；null = 尚未初始化。 */
let favoritesStore: FavoritesStore | null = null;
/** 会话分组存储（<userData>/session-groups.json）；null = 尚未初始化。侧栏与插件经它共用一份数据。 */
let sessionGroupStore: SessionGroupStore | null = null;
/** 关联会话（子对话，docs/host-boundaries.md 例外九）：关系表 + 编排 + 回环端点。 */
let linkedSessionStore: LinkedSessionStore | null = null;
let linkedSessionService: LinkedSessionService | null = null;
/** 智能体一次性调用服务（划词工具 / 市场面板）：业务在 service，侧车进程在下面的 completion。 */
let agentInvokeService: AgentInvokeService | null = null;
/**
 * 输入预测服务（回合结束后预测下一句输入）：与提示词增强同协议，但**独立实例**——
 * 单飞语义下共用会让预测把用户正在跑的增强打断（同 agentInvokeCompletionService 的理由）。
 */
let promptSuggestionService: EnhancePromptService | null = null;
/**
 * 智能体调用专用侧车实例。与提示词增强共用同一套 pi-enhance-host 协议，但必须是
 * **独立进程**：EnhancePromptService 是「新 run 打断旧 run」的单飞语义，共用实例会
 * 让划词翻译把用户正在跑的输入框增强打断（见 AGENTS.md 例外四）。
 */
let agentInvokeCompletionService: EnhancePromptService | null = null;
/**
 * 记忆学习循环专用侧车实例。同样的单飞语义理由：与提示词增强/输入预测共用实例，
 * 学习跑一次就会把用户正在用的增强打断（学习是后台行为，用户看不见它为什么卡住）。
 */
let agentMemoryLearnService: EnhancePromptService | null = null;
/** 系统级划词浮窗（全局快捷键触发的独立 BrowserWindow）；null = 尚未装配/装配失败。 */
let selectionToolWindow: SelectionToolWindow | null = null;
/** 系统级划词服务：取词、浮窗展示与全局快捷键注册的唯一归属地。 */
let selectionToolService: SelectionToolService | null = null;
/** 复制即触发监听：系统级划词开启时轮询外部剪贴板变更（不依赖快捷键）。 */
let selectionClipboardWatcher: ClipboardSelectionWatcher | null = null;
/** Windows 原生划词：鼠标手势 + UIAutomation 读选区，不依赖复制/快捷键。 */
let windowsSelectionCapture: WindowsSelectionCapture | null = null;

/**
 * 最近一次系统级划词快捷键冲突（accelerator）与已提示值。
 * 注册失败常见于 accelerator 被其他应用或另一个 PiDeck 实例占用；只写日志会让用户
 * 以为「系统级划词只在本应用生效」，所以失败要弹一次可执行提示（设置页另有常驻警告）。
 * 窗口尚未创建时保持未提示状态，由后续 focus/did-finish-load 重试补发。
 */
let selectionShortcutConflict: string | null = null;
let selectionShortcutConflictNotified: string | null = null;

function notifySelectionShortcutConflict(accelerator: string): void {
	selectionShortcutConflict = accelerator;
	if (selectionShortcutConflictNotified === accelerator) return;
	if (!mainWindow || mainWindow.isDestroyed()) return;
	emitAgentsNotice({
		message: `System selection shortcut ${accelerator} is unavailable`,
		i18nKey: "selectionTool.shortcutConflict",
		i18nParams: { accelerator },
		kind: "warning",
	});
	selectionShortcutConflictNotified = accelerator;
}

function clearSelectionShortcutConflict(): void {
	selectionShortcutConflict = null;
	selectionShortcutConflictNotified = null;
}

/** 窗口就绪/重新聚焦后补发上次未送达的冲突提示（首次注册发生在建窗之前）。 */
function flushSelectionShortcutConflictNotice(): void {
	if (selectionShortcutConflict) notifySelectionShortcutConflict(selectionShortcutConflict);
}

/**
 * 同步系统级划词的全局快捷键（开关、键位、市场设置任一变化都调用）。
 *
 * globalShortcut 是应用级独占资源：关闭开关必须立刻注销，改键必须先释放旧键再注册
 * （Electron 对同一 accelerator 重复注册返回 false）。注册失败时登记冲突并提示用户——
 * 常见原因是该组合被其他应用/另一个 PiDeck 实例占用，用户可改键或关闭占用方。
 */
function syncSelectionToolShortcut(): void {
	const service = selectionToolService;
	if (!service) return;
	if (!SYSTEM_SELECTION_TOOL_ENABLED) {
		// 系统级划词暂时隐藏：不清持久化设置，但一切入口（快捷键/复制监听/原生捕获）都不启动。
		selectionClipboardWatcher?.setEnabled(false);
		windowsSelectionCapture?.setEnabled(false);
		service.unregisterShortcut();
		clearSelectionShortcutConflict();
		return;
	}
	const systemEnabled = agentProfileStore?.getSnapshot().settings.systemSelectionEnabled === true;
	// 复制即触发与快捷键解耦：快捷键被其它实例占用时，复制文本仍然可以自动弹窗。
	selectionClipboardWatcher?.setEnabled(systemEnabled);
	// Windows 优先用原生选区读取（Magpie 同款 UIA），复制监听只做 UIA 读不到时的兜底。
	windowsSelectionCapture?.setEnabled(systemEnabled);
	if (!systemEnabled) {
		service.unregisterShortcut();
		clearSelectionShortcutConflict();
		return;
	}
	const accelerator = resolveShortcutBindings(settingsStore.get().shortcuts ?? {}, process.platform).openSelectionTool;
	if (!accelerator) {
		service.unregisterShortcut();
		clearSelectionShortcutConflict();
		return;
	}
	if (service.getRegisteredShortcut() === accelerator) {
		clearSelectionShortcutConflict();
		return;
	}
	const registered = service.setShortcut(accelerator);
	if (!registered) {
		void appLogger.warn("selection-tool", "Global shortcut registration failed", { accelerator });
		notifySelectionShortcutConflict(accelerator);
		return;
	}
	clearSelectionShortcutConflict();
}
/** 粘贴文件启动清理（registerIpc 阶段赋值；whenReady 后 fire-and-forget 执行） */
let cleanupPasteFiles: (() => Promise<number>) | undefined;
let cloudSyncManager: CloudSyncManager;

/** 退出清理登记表（C12）：常驻资源创建处登记，before-quit 统一顺序执行。 */
const quitCleanup = new QuitCleanupRegistry();
// feishuBridge 在多个 IPC 处理器里重建/置空（临时连接/正式连接/重连），此前没登记
// 退出清理——quit 时若 bridge 在线，其长轮询/WS 不会被停。闭包延迟读当前实例。
quitCleanup.register("feishu-bridge", () => {
	feishuBridgeRef.current?.stop();
	feishuBridgeRef.current = null;
});
quitCleanup.register("wechat-bridge", () => {
	void wechatServiceRef.current?.stop();
	wechatServiceRef.current = null;
});

// 窗口整体缩放快捷键（Ctrl/Cmd+= 放大、Ctrl/Cmd+- 缩小）：按 shared/zoom 档位应用并持久化。
// 主窗口与内置浏览器 webview guest 的 before-input-event 共用同一判定函数。
const handleWindowZoomShortcut = createWindowZoomShortcutHandler({
	getWindow: () => mainWindow,
	getZoomFactor: () => settingsStore.get().zoomFactor,
	// 持久化失败不影响本次缩放的观感（已 setZoomFactor），只记日志交由下次启动恢复
	persistZoomFactor: (value) => {
		void settingsStore.update({ zoomFactor: value }).catch((error) => {
			void appLogger.warn("settings", "Failed to persist zoom factor", { error: error instanceof Error ? error.message : String(error) });
		});
	},
	// 同步渲染层设置态：否则设置页「外观 → 窗口缩放」会一直显示快捷键改动前的旧百分比
	notifyZoomFactor: (value) => {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		mainWindow.webContents.send(ipcChannels.appZoomFactorChanged, value);
	},
});

// ── DSH 外部会话同步（dshForeignSync 编排；本文件只做依赖装配）────────────
// 清单来自磁盘只读扫描（不启动 host）；目标项目按会话自己的 cwd 建/挂，无 cwd 才兑底。
// 标题优先官方 session_projcache；cwd 末段只作占位，下次扫描有投影名会覆盖。
// 依赖闭包延迟引用模块级实例（registerIpc/whenReady 阶段才赋值），调用时已就绪。
const foreignSyncDeps: DshForeignSyncDeps = {
	listForeignSessions: () => dshHost.listForeignSessions(),
	findProjectByPath: (cwd) => projectStore.findByPath(cwd),
	// 会话自带工作目录但侧栏还没有该项目：按该目录注册，打开会话时 cwd 才对得上。
	// 已删记录 / e2e 临时目录 / 磁盘不存在：拒绝注册，避免「删了重启又回来」。
	shouldRegisterCwd: async (cwd) =>
		shouldAutoRegisterForeignCwd(cwd, {
			dismissedPaths: projectStore.listDismissedPaths(),
			pathExists: await defaultPathCheck(cwd),
		}),
	// 全局 WSL 模式下按 WSL 环境登记：cwd 是发行版内路径时不能记成 Windows 项目。
	ensureProjectForCwd: (cwd) => projectStore.add(cwd, undefined, settingsStore.get().wslEnabled ? "wsl" : "windows"),
	ensureFallbackProject: () => projectStore.ensureExternalSessionsProject(mainCopy("project.externalSessions")),
	createDraft: (input) => sessionCatalog.createDraft(input),
	// 纠正归属时看现有标题是不是 cwd 兑底占位；有官方投影名时必须覆盖。
	getExistingDraft: (dshSessionId) => {
		const existing = sessionCatalog.listEntries().find((entry) => entry.dshSessionId === dshSessionId);
		return existing ? { title: existing.title } : undefined;
	},
	getEnvironment: () => "native",
	// 惰性：此对象在模块顶层创建，此时 settingsStore 尚未赋值，eager mainCopy 会崩。
	fallbackTitle: () => mainCopy("session.dshUntitled"),
	onError: (dshSessionId, error) => {
		void appLogger.warn("session", "Foreign DSH session import failed", {
			dshSessionId,
			error: error instanceof Error ? error.message : String(error),
		});
	},
	// 用户删过的 DSH 会话：host 目录可能还在，自动同步不得再导入。
	dismissedDshSessionIds: () => sessionCatalog.listDismissedDshSessionIds(),
};

/** catalog 变更后向渲染层广播对应项目刷新（侧栏静默重拉，新/删/改的会话立即对齐）。
 *  渲染进程自己发起的增删改会拿 IPC 返回值就地更新，所以只有**非渲染进程发起**的改动
 *  （DSH 导入/同步、自动化、Web API 等）才必须走这里，否则侧栏会留下幽灵行或漏掉新行（issue #436）。 */
function notifyCatalogRefreshed(projectIds: Iterable<string>): void {
	broadcastCatalogRefreshed(projectIds, { channel: ipcChannels.sessionsCatalogRefreshed, getWindow: () => mainWindow });
}

/** 按当前设置过滤可见项目并推给渲染层（启动 load / 自动导入兑底项目后共用）。 */
function broadcastVisibleProjects(): void {
	const window = mainWindow;
	if (!window || window.isDestroyed()) return;
	const visible = projectStore.list();
	// 这里只广播 store 清单；渲染层接到事件后会再调用 projects:list 附加实时 presence。
	// 直接把未检测版本写进 atom 会短暂抹掉 missing 标记，使失效目录看起来又恢复正常。
	window.webContents.send(ipcChannels.projectsChanged, visible);
	// 项目集变化同步重建托盘菜单（最近项目区），否则增删项目后菜单滞后。
	refreshTrayContextMenu(trayDeps);
}

/** 云同步状态变化 → 渲染层（设置页/全局状态订阅共用）。 */
function broadcastCloudSyncStateChanged(): void {
	const window = mainWindow;
	if (!window || window.isDestroyed() || !cloudSyncManager) return;
	window.webContents.send(ipcChannels.cloudSyncStateChanged, cloudSyncManager.getStateSnapshot());
}

/**
 * 第 14 步：WSL 项目按档案 distro/user 使用独立的 SessionScanner 实例。
 *
 * 旧实现靠全局 `sessionScanner.configureWsl()`，同一时刻只能扫一个发行版；两个 WSL 档案
 * 并存时会互相覆盖。每个 `(distro,user)` 一份 scanner（含各自的摘要缓存），按需解析 home；
 * 解析失败不缓存失败结果，下次请求重试。本机项目继续用主 `sessionScanner`。
 */
const wslSessionScanners = new Map<string, Promise<SessionScanner>>();

async function wslSessionScannerFor(identity: { distro: string; user: string }): Promise<SessionScanner> {
	const key = `${identity.distro}\u0000${identity.user}`;
	const existing = wslSessionScanners.get(key);
	if (existing) return existing;
	const pending = (async () => {
		const { resolveWslEnvironment } = await import("./wsl/WslEnvironment");
		const environment = await resolveWslEnvironment(identity.distro, identity.user, {
			warn: (message: string, detail: unknown) => void appLogger?.warn("wsl", String(message), { detail }),
		});
		const scanner = new SessionScanner(mainCopy);
		await scanner.configureWsl(environment);
		return scanner;
	})();
	wslSessionScanners.set(key, pending);
	pending.catch(() => {
		if (wslSessionScanners.get(key) === pending) wslSessionScanners.delete(key);
	});
	return pending;
}

async function sessionScannerForProject(project: Project | undefined): Promise<SessionScanner> {
	if (project === undefined || !isLocalProject(project) || project.environment !== "wsl") return sessionScanner;
	const identity = resolveProjectWslIdentity(project, settingsStore.get());
	if (identity === undefined) return sessionScanner;
	return wslSessionScannerFor(identity);
}

/**
 * 启动自动导入：catalog + projects 都已就绪后扫磁盘，把外部根会话写入侧栏。
 * 设置 dshAutoImportSessions=false 时跳过；失败只记日志，不阻断启动。
 */
async function scheduleDshForeignAutoImport(): Promise<void> {
	if (settingsStore.get().dshAutoImportSessions === false) return;
	try {
		await runDshForeignSync();
		// 按会话 cwd 新建的项目必须立刻出现在侧栏，否则会话挂在看不见的项目上。
		broadcastVisibleProjects();
	} catch (error: unknown) {
		void appLogger.warn("session", "Foreign DSH sessions auto-sync failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/** DSH 外部会话全量同步：启动扫描与配置页「全部导入」共用（只读磁盘，不 boot host）。
 *  结果含本轮导入数/已导入跳过数；有新增时广播受影响项目刷新侧栏。 */
async function runDshForeignSync(): Promise<{ imported: number; skipped: number }> {
	const result = await syncForeignSessions(foreignSyncDeps, knownForeignSessionIds(sessionCatalog.listEntries()));
	if (result.imported > 0 || result.skipped > 0) {
		// skipped>0 也可能是纠正归属（从兑底拆到各自目录），侧栏要重拉。
		notifyCatalogRefreshed(
			sessionCatalog
				.listEntries()
				.filter((entry) => entry.backend === "dsh" && entry.dshSessionId)
				.map((entry) => entry.projectId),
		);
	}
	void appLogger.info("session", "Foreign DSH sessions synced", {
		imported: result.imported,
		skipped: result.skipped,
	});
	return result;
}

/**
 * 激活失败的 session 级合成 error 事件：激活失败时 binding 从未建立，manager 的
 * 终态事件同样被丢弃——若不补发，渲染层会永远停在合成 starting 的加载态。
 * 仅在失败后仍无活 runtime 时发（bind 后才失败的边缘路径不深究，真实事件已可路由）。
 */
function emitSessionActivationFailed(sessionId: string): void {
	sendSessionRuntimeEnvelope({
		kind: "event",
		sessionId,
		agentId: "",
		runtimeGeneration: sessionRuntimeCoordinator.currentRuntimeGeneration(sessionId),
		sourceChannel: agentEventTags.agentsState,
		payload: { status: "error" },
	});
}

/**
 * 激活被作废（草稿期换后端 / 换 ACP 工具）：抵消 emitSessionActivating 的合成 starting。
 *
 * 语义与 emitSessionActivationFailed 相反：作废不是失败，不应画成错误可重试；但合成 starting
 * 已把会话标成「启动中」，不发事件就永远收不回来。detach = 未绑定，与取消后的真实状态一致
 * （旧进程已停、旧激活不得 bind）。payload 为空，渲染层 detach 分支不读它，
 * runtimeGeneration 取当前值以保证能盖住那条 starting。
 */
function emitSessionActivationCancelled(sessionId: string): void {
	sendSessionRuntimeEnvelope({
		kind: "detach",
		sessionId,
		agentId: "",
		runtimeGeneration: sessionRuntimeCoordinator.currentRuntimeGeneration(sessionId),
		sourceChannel: "sessions:runtime-detach",
		payload: null,
	});
}

function sendSessionRuntimeEnvelope(event: SessionRuntimeEvent): void {
	const window = mainWindow;
	// live 正文/思考只对主窗口可见的会话下发：不可见会话没有消费者，几百个后台流式
	// 会话会把渲染进程主线程打满（discussion #446）。消息/状态/通知不受影响；
	// 极简浮窗有自己显示的会话，仍按原样转发。
	// 收到过可见性上报才启用门控（fail-open）：上报链路异常时宁可多推，也不能让正在看的会话没有正文。
	if (window && !window.isDestroyed() && shouldDeliverLiveStreamToMainWindow(event, (sessionId) => !visibleSessions.hasReported() || visibleSessions.isVisible(sessionId))) {
		window.webContents.send(ipcChannels.sessionsRuntimeEvent, event);
	}
	// 极简浮窗是独立渲染进程，流式事件单独转发，否则会话页停在打开时的快照。
	miniOverlayWindow?.sendRuntimeEvent(event);
}

/**
 * 无 runtime 绑定也能送达的用户通知（copy 产物/fork 换绑瞬间都没有 runtime）。
 *
 * 背景（2026-10-08 现场）：copy/fork 的会话名后缀改名失败只写日志，用户零反馈——
 * 侧栏标题停在弱兜底上像乱码。渲染层 useSessionRuntimeBridge 对
 * sourceChannel=agents:notice 的 payload 直接弹 toast，不查 runtime atom，
 * 所以合成一个最小 envelope（sessionId=目标会话，agentId 占位）即可送达；
 * notice 分支不会触碰 runtime 状态，无副作用。
 */
function emitAgentsNotice(payload: { message: string; i18nKey: string; i18nParams?: Record<string, string | number>; kind: "info" | "warning" | "error"; sessionId?: string }): void {
	const event: SessionRuntimeEvent = {
		kind: "event",
		sessionId: payload.sessionId ?? "",
		agentId: "system",
		runtimeGeneration: 0,
		sourceChannel: agentEventTags.agentsNotice,
		payload: {
			message: payload.message,
			i18nKey: payload.i18nKey,
			i18nParams: payload.i18nParams,
			kind: payload.kind,
		},
	};
	sendSessionRuntimeEnvelope(event);
}

/**
 * 会话运行时事件的模块内旁路监听（IM 桥接等宿主模块等回合收口用）。
 *
 * 为什么不做在 Coordinator 里：observeRuntimeEvent 是「路由」不是订阅中心
 * （它只维护 agents:ui-request 待决表与自动化协调器），而这里的监听者要的是
 * 同一条事件流上的旁路副本——挂在事件出口处最不容易漏，也天然覆盖
 * 「compositeAgentGateway.onOutput 拆包后」的所有分支。
 */
const runtimeEventListeners = new Set<(event: SessionRuntimeEvent) => void>();

/**
 * 关联会话装配（docs/host-boundaries.md 例外九）。端点起不来只是工具不出现，不影响启动。
 * 与模型快照端点一样是 fire-and-forget：端点就绪前 spawn 的 agent 拿不到 env，下次 spawn 生效。
 */
function setupLinkedSessions(): void {
	const store = new LinkedSessionStore(join(app.getPath("userData"), "linked-sessions.json"));
	linkedSessionStore = store;
	const runtimeMessages = (sessionId: string) => sessionRuntimeCoordinator.getRuntimeMessages(sessionId)?.value ?? [];
	const service = new LinkedSessionService({
		store,
		getSessionIdForAgent: (agentId) => sessionRuntimeCoordinator.getSessionId(agentId),
		getSession: (sessionId) => {
			const entry = sessionCatalog.get(sessionId);
			if (!entry) return undefined;
			return {
				id: entry.id,
				projectId: entry.projectId,
				title: entry.title,
				backend: entry.backend ?? "pi",
				environment: entry.environment,
				...(entry.wslDistro ? { wslDistro: entry.wslDistro } : {}),
				...(entry.wslUser ? { wslUser: entry.wslUser } : {}),
			};
		},
		createDraft: async ({ parent, title }) => {
			const draft = await sessionCatalog.createDraft({
				projectId: parent.projectId,
				title,
				environment: parent.environment,
				...(parent.wslDistro ? { wslDistro: parent.wslDistro } : {}),
				...(parent.wslUser ? { wslUser: parent.wslUser } : {}),
				source: "pi",
				// 标题是开会话的 agent 起的终态名，不让自动标题覆盖（子会话靠标题在侧栏里被认出来）。
				titleOrigin: "manual",
				backend: "pi",
			});
			notifyCatalogRefreshed([parent.projectId]);
			return { id: draft.id };
		},
		send: async (input) => {
			const result = await sessionRuntimeCoordinator.send({
				sessionId: input.sessionId,
				requestId: LinkedSessionService.newRequestId(),
				message: input.message,
				...(input.agentMessage ? { agentMessage: input.agentMessage } : {}),
				...(input.description ? { description: input.description } : {}),
				...(input.streamingBehavior ? { streamingBehavior: input.streamingBehavior } : {}),
			});
			return result.accepted ? { accepted: true } : { accepted: false, error: result.error };
		},
		hasLiveRuntime: (sessionId) => Boolean(sessionRuntimeCoordinator.getTarget(sessionId)),
		getMessageCount: (sessionId) => runtimeMessages(sessionId).length,
		getAssistantTextSince: (sessionId, fromIndex) => lastAssistantTextSince(runtimeMessages(sessionId), fromIndex),
		discardDraft: async (sessionId) => {
			const projectId = sessionCatalog.get(sessionId)?.projectId;
			await sessionCatalog.remove(sessionId);
			if (projectId) notifyCatalogRefreshed([projectId]);
		},
		log: (level, message, data) => void appLogger?.[level]("linked-sessions", message, data),
	});
	linkedSessionService = service;
	store.onChanged(() => {
		const win = mainWindow;
		if (win && !win.isDestroyed()) win.webContents.send(ipcChannels.linkedSessionsChanged, null);
	});
	void store.load().then(() => {
		const win = mainWindow;
		if (win && !win.isDestroyed()) win.webContents.send(ipcChannels.linkedSessionsChanged, null);
	});
	runtimeEventListeners.add((event) => service.observeRuntimeEvent(event));
	// 两个集中点，覆盖所有入口：消息提交（清零自动续跑额度）与会话行消失（清理关系）。
	sessionRuntimeCoordinator.onPromptSubmitted((input) => service.noteOutgoingPrompt(input));
	sessionCatalog.onRowsRemoved((sessionIds) => void service.noteSessionsRemoved(sessionIds));
	const server = new LinkedSessionServer((agentId, request) => service.handle(agentId, request));
	agentManager.setLinkedSessionsHost({
		registerAgent: (agentId) => server.registerAgent(agentId),
		unregisterAgent: (agentId) => server.unregisterAgent(agentId),
	});
	void server.start();
	quitCleanup.register("linked-sessions", () => {
		service.dispose();
		server.stop();
	});
}

function emitSessionRuntimeEvent(agentId: string, sourceChannel: string, payload: unknown): boolean {
	const runtimeBinding = sessionRuntimeCoordinator.getRuntimeBinding(agentId);
	if (!runtimeBinding) return false;
	const event: SessionRuntimeEvent = {
		kind: "event",
		sessionId: runtimeBinding.sessionId,
		agentId,
		runtimeGeneration: runtimeBinding.runtimeGeneration,
		sourceChannel,
		payload,
	};
	for (const listener of runtimeEventListeners) {
		// 监听者抛错不影响事件主链路（渲染层状态、自动化、会话落盘都在后面）。
		try {
			listener(event);
		} catch (error) {
			void appLogger.warn("session", "Runtime event listener failed", { agentId, sourceChannel, error: error instanceof Error ? error.message : String(error) });
		}
	}
	sessionRuntimeCoordinator.observeRuntimeEvent(event);
	automationRunCoordinator?.observeRuntimeEvent(event);
	if (payload && typeof payload === "object" && !Array.isArray(payload)) {
		const tab = payload as Partial<AgentTab>;
		if (typeof tab.sessionPath === "string" && tab.sessionPath) {
			const entry = sessionCatalog.get(runtimeBinding.sessionId);
			// #314：pi 上报的路径与 catalog 持久化路径可能只是形态差异（分隔符/大小写、
			// resolveFilePath 归一先后不同）。裸字符串比较永真时每个 runtime 事件都会
			// 触发一次 attach；canonical 归一后再比，无实质变化不再入队。
			const sessionPathUnchanged = entry?.filePath !== undefined && canonicalizeSessionPath(entry.filePath, entry.environment) === canonicalizeSessionPath(tab.sessionPath, entry.environment);
			if (canAttachRuntimeMetadata(entry, tab) && (!sessionPathUnchanged || entry.piSessionId !== tab.sessionId)) {
				// 仅 pi JSONL 走文件配对。DSH 的 sessionPath 是 zstd，canAttach 已拒绝；
				// host id 由 Coordinator activate/dispatch 回写 dshSessionId。
				void sessionCatalog
					.attachRuntime({
						sessionId: runtimeBinding.sessionId,
						filePath: tab.sessionPath,
						piSessionId: tab.sessionId,
					})
					.catch(() => undefined);
			}
		}
	}
	sendSessionRuntimeEnvelope(event);
	const tab = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Partial<AgentTab>) : undefined;
	// A crashed anonymous process has no durable session to reopen. The regular
	// Agent state event reaches the renderer first so diagnostics remain visible
	// for the current tick, then detach removes the transient conversation.
	if (tab?.noSession && tab.status === "closed") {
		sessionRuntimeCoordinator.unbindTerminalAgent(agentId);
		discardAnonymousSession({ ...runtimeBinding, agentId });
	}
	return true;
}

function emitSessionRuntimeDetach(binding: SessionRuntimeBinding): void {
	sendSessionRuntimeEnvelope({
		kind: "detach",
		sessionId: binding.sessionId,
		agentId: binding.agentId,
		runtimeGeneration: binding.runtimeGeneration,
		sourceChannel: "sessions:runtime-detach",
		payload: null,
	});
}

/**
 * Anonymous chats have no catalog file to rediscover. Once their runtime stops,
 * discard the in-memory record after broadcasting detach so every renderer can
 * remove its transient Session state.
 */
function discardAnonymousSession(binding: SessionRuntimeBinding): void {
	if (!sessionCatalog.get(binding.sessionId)?.noSession) return;
	sessionCatalog.removeTransient(binding.sessionId);
	emitSessionRuntimeDetach(binding);
}

/**
 * 会话创建校验用的 pi 目录模型：capability 快照（get_available_models，含 auth.json
 * 官方 provider 与 models-store 目录）优先，快照缺失（尚未 hydration / RPC 降级）时退回
 * CLI 缓存（models.json ∪ pi --list-models）。
 * 必须与模型选择器同源：只用 CLI 缓存会把 auth 渠道模型判为不存在，新会话首发的点选
 * 被静默换成配置默认模型（issue #340）。同步读是有意的——创建链路不能为校验 fork pi。
 */
function validationCatalogModels(): AvailableModel[] | undefined {
	return mergeCatalogModels(piModelCapabilityCache?.getSnapshot(), getCachedModelList());
}

async function createAnonymousSession(input: CreateAnonymousSessionInput): Promise<CreateAnonymousSessionResult> {
	const project = projectStore.get(input.projectId);
	if (!project) throw new Error(mainCopy("project.notFound"));

	// Resolve pi-configured defaults so the composer bar shows the effective
	// model / thinking level even before the anonymous Agent is fully started.
	let model: CreateAnonymousSessionInput["model"] = input.model ? createSessionModelPreference(input.model.provider, input.model.modelId, input.model.modelName) : undefined;
	let thinkingLevel = input.thinkingLevel;
	try {
		const [settingsResult, modelsResult] = await Promise.all([configManager.getSettingsConfig(), configManager.getModelsConfig()]);
		// 渲染层/引导页显式传入的模型（欢迎页偏好等）也可能指向已删除条目：
		// 校验仍存在（models.json ∪ capability 快照，与选择器可选范围一致），不存在则交给 launchDefaults 按配置默认 →
		// enabledModels → lastUsed 的顺序兜底。
		if (model && !isModelInModelsConfig(modelsResult.parsed, model, validationCatalogModels())) {
			model = undefined;
		}
		// 缺省填充与引导页展示共用同一解析器（launchDefaults，含「最后一次使用」优先）：
		// 保证「预选的默认」与「创建时真正套用的默认」永远同源。
		const defaults = resolveLaunchDefaultOptions({
			backend: "pi",
			settings: settingsResult.parsed,
			models: modelsResult.parsed,
			// 与 createDraft 同源：存在性校验含 capability 快照（auth 渠道模型也在内）。
			catalogModels: validationCatalogModels(),
			lastUsedModel: settingsStore.get().lastUsedModel,
		});
		if (!model) {
			model = defaults.model;
		}
		if (!thinkingLevel) {
			// 与 createDraft 同序：每模型默认档位（pi settings.modelThinkingLevels）优先于
			// 全局默认，且按最终生效的模型查——匿名会话同样要「显示的默认 = 实际套用」。
			const perModelThinkingLevel = model && typeof model.provider === "string" && typeof model.modelId === "string" ? modelThinkingLevelOf(settingsResult.parsed, model.provider, model.modelId) : undefined;
			thinkingLevel = perModelThinkingLevel ?? defaults.thinkingLevel;
		}
	} catch {
		// Config read is best-effort.
	}

	const projectWsl = resolveProjectWslIdentity(project, settingsStore.get());
	const session = sessionCatalog.createAnonymous({
		projectId: project.id,
		title: input.title?.trim() || mainCopy("session.anonymousTitle", { project: project.name }),
		environment: projectWsl !== undefined ? "wsl" : "native",
		...(projectWsl !== undefined ? { wslDistro: projectWsl.distro, wslUser: projectWsl.user } : {}),
		model,
		thinkingLevel,
	});
	// Agent 启动可能包含 spawn/get_state/历史准备；匿名会话先返回可选中的 Session，
	// 再后台绑定 runtime。这样欢迎页点击后能立即进入输入框，启动失败仍通过 detach/日志收敛。
	// 先把后台启动 Promise 放进 Coordinator 的 Session 锁，再把 Session 返回给
	// renderer；用户若立即输入，activateRuntime 会等待这次启动而不会再 spawn 一个 pi。
	const activation = activateAnonymousRuntime(session, project, input);
	sessionRuntimeCoordinator.registerPendingRuntime(session.id, activation);
	void activation.catch(() => undefined);
	return { session };
}

async function activateAnonymousRuntime(session: SessionRecord, project: Project, input: CreateAnonymousSessionInput): Promise<AgentTab> {
	let agentId: string | undefined;
	try {
		const tab = await agentManager.create({
			projectId: project.id,
			title: session.title,
			environment: session.environment,
			source: "pi",
			wslDistro: session.wslDistro,
			wslUser: session.wslUser,
			noSession: true,
		});
		agentId = tab.id;
		const runtime = sessionRuntimeCoordinator.bindAnonymousRuntime(session.id, tab.id);
		// Anonymous Agent 使用 --no-session 创建，不会经过普通 activateRuntime 的恢复流程；
		// 因此在绑定后显式应用引导页选择，确保 pi 不再按自身默认优先级启动。
		if (session.model) {
			const result = await sessionRuntimeCoordinator.setRuntimeModel(runtime, session.model.provider, session.model.modelId, session.model.modelName);
			if (!result.ok) throw new Error(result.error.code);
		}
		if (session.thinkingLevel) {
			const result = await sessionRuntimeCoordinator.setRuntimeThinking(runtime, session.thinkingLevel);
			if (!result.ok) throw new Error(result.error.code);
		}
		emitReplacementState(runtime, true);
		return tab;
	} catch (error) {
		if (agentId) await agentManager.stop(agentId).catch(() => undefined);
		sessionCatalog.removeTransient(session.id);
		// createUnlocked 内部已尽量把 pi 启动失败落到会话错误卡；这里兜底信任/项目查找等
		// 前置异常，保证异步匿名启动失败仍可诊断且不会留下不可用的临时行。
		void appLogger.error("agent", "Agent create IPC failed", {
			projectId: project.id,
			title: input.title,
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
			platform: process.platform,
			arch: process.arch,
		});
		throw error;
	}
}

async function stopSessionRuntime(target: SessionRuntimeTarget) {
	const anonymous = sessionCatalog.get(target.sessionId)?.noSession === true;
	const result = await sessionRuntimeCoordinator.stopRuntime(target);
	if (result.ok) {
		terminalManager.closeAgent(target.agentId);
		if (anonymous) discardAnonymousSession(target);
		else emitSessionRuntimeDetach(target);
	}
	return result;
}

/**
 * 进程监控「停止 agent」入口：调用方只有 agentId，由 coordinator 反查会话并走
 * 完整停止链路（保留/解绑 + 关终端 + detach 推送）。与 stopSessionRuntime 的
 * 区别仅在于 target 的来源；不这么做的话渲染层收不到 detach，会话运行标记
 * 会停留在 running（用户可见的「停止后蓝点不变」现象）。
 */
async function stopAgentFromMonitor(agentId: string): Promise<SessionCommandResult<SessionRuntimeTarget | undefined>> {
	const result = await sessionRuntimeCoordinator.stopAgentById(agentId);
	if (!result.ok) return result;
	terminalManager.closeAgent(agentId);
	if (result.value) emitSessionRuntimeDetach(result.value);
	return result;
}

/**
 * 进程监控停 DSH host：先按会话走完整停止（detach 推送，运行标记熄灭），
 * 再 dispose utilityProcess。不能把 dsh-host 当 pi agentId 丢给 stopAgentById。
 */
async function stopDshHostFromMonitor(): Promise<SessionCommandResult<undefined>> {
	const tabs = dshAgentManager.list();
	for (const tab of tabs) {
		const result = await sessionRuntimeCoordinator.stopAgentById(tab.id);
		if (!result.ok) return result;
		terminalManager.closeAgent(tab.id);
		if (result.value) emitSessionRuntimeDetach(result.value);
	}
	await dshAgentManager.stopAll();
	await dshHost.dispose();
	return { ok: true, value: undefined };
}

/**
 * 全后端 runtime 查找（pi/DSH/ACP 统一）。
 * composite 未装配时（启动极早期/测试沙箱）回退 pi 查找——回退只是兼容，别在回退上建新功能。
 */
function findRuntimeTab(agentId: string): AgentTab | undefined {
	return compositeAgentGateway?.list().find((candidate) => candidate.id === agentId) ?? agentManager.list().find((candidate) => candidate.id === agentId);
}

function emitReplacementState(binding: SessionRuntimeBinding, includeMessages: boolean): void {
	// 多后端查找：ACP/DSH 的 tab 不在 pi AgentManager 里。此前只查 agentManager，
	// 查不到直接 return，导致换绑/重启后的状态+消息窗口重下发对 ACP/DSH 全部静默失效
	//（渲染层停在旧 runtime 的窗口/live 身份，重启后编辑/删除/重发定位失败）。
	// 2027-03 审计发现 B；`findRuntimeTab` 里保留了 composite 未装配时的 pi 回退。
	const tab = findRuntimeTab(binding.agentId);
	if (!tab) return;
	emitSessionRuntimeEvent(binding.agentId, agentEventTags.agentsState, tab);
	if (includeMessages) {
		// 与 flush 同一窗口协议：只下发显示窗口段 + windowStart/totalLength/fileVersion，
		// 渲染层合并逻辑一处生效（窗口前历史由 disk 轮次分页 prepend）；
		// ACP/DSH 无窗口实现时为全量（live 列表有界，协议兼容：无 windowStart = 全窗口）。
		const messageWindow = compositeAgentGateway?.getMessageWindow(binding.agentId) ?? agentManager.getMessageWindow(binding.agentId);
		emitSessionRuntimeEvent(binding.agentId, agentEventTags.agentsMessage, {
			agentId: binding.agentId,
			...messageWindow,
		});
	}
}

/**
 * 激活窗口的 session 级合成 starting 事件（2027-03 审计发现 A）。
 *
 * 背景：emitSessionRuntimeEvent 依赖 binding 才转发，而 coordinator.activate 要等
 * create+waitUntilReady 完成才 bind()——ACP 握手可达 ~8.5s，期间 manager 发的一切
 * agents:state（含 starting）全部被丢弃，渲染层全程静默、恢复条停在静态提示。
 * 激活开始时先发一条 session 级合成事件（agentId 占位、代数取 bind 前当前值，
 * 能压住旧 runtime 的迟到事件），渲染层据 status="starting" 显示加载动画；
 * 激活完成后由 emitReplacementState / 后续真实事件接管。与 emitAgentsNotice 同一
 * 合成模式；不经过 observeRuntimeEvent/automation，避免合成状态驱动运行编排。
 */
function emitSessionActivating(sessionId: string): void {
	sendSessionRuntimeEnvelope({
		kind: "event",
		sessionId,
		agentId: "",
		runtimeGeneration: sessionRuntimeCoordinator.currentRuntimeGeneration(sessionId),
		sourceChannel: agentEventTags.agentsState,
		payload: { status: "starting" },
	});
}

async function readCatalogSessionReferenceMessages(sessionId: string) {
	const filePath = sessionCatalog.getLocalFilePath(sessionId);
	if (!filePath) return [];
	return sessionScanner.readMessages(filePath);
}

async function copyCatalogSession(sessionId: string) {
	const entry = sessionCatalog.get(sessionId);
	// DSH 会话复制走运行中 agent 的 clone（sessionsRuntimeClone 已按 backend 分流）；
	// 历史 DSH 会话没有宿主文件可复制（host 会话在 $DSH_HOME），显式拒绝并提示正确入口，
	// 而不是报「文件不存在」误导（A8）。
	if (entry?.backend === "dsh") {
		throw new Error(mainCopy("session.copyDshUnsupported"));
	}
	const filePath = sessionCatalog.getLocalFilePath(sessionId);
	if (!entry || !filePath) throw new Error(mainCopy("session.fileNotFound"));
	const result = (await agentManager.cloneSessionFile(entry.projectId, filePath, entry.environment)) as {
		cancelled?: boolean;
		sessionPath?: string;
	};
	if (result.cancelled || !result.sessionPath) return { cancelled: true };
	// 静止复制与运行中复制同语义（fork 身份）：(fork) 物理写进会话名。产物是静态文件
	// （临时 pi 进程已停，无人并发写入），直接用 sessionScanner.rename 写 session_info，
	// 扫描回读（session_info 命中）即与 catalog 一致；rename 失败不阻断复制。
	let title = entry.title;
	const forkedTitle = appendSessionForkSuffix(title, mainCopy("session.forkedSuffix"));
	if (forkedTitle !== title) {
		try {
			await sessionScanner.rename(result.sessionPath, forkedTitle);
			title = forkedTitle;
		} catch (error) {
			// 静默历史（2026-10-08 现场）：只写日志 → 用户零反馈，侧栏标题停在弱兜底上
			// 看着像「复制出的名字是乱的」。改名失败不阻断复制（产物已存在），
			// 但必须让用户可见：toast 引导手动重命名补上后缀。
			void appLogger.warn("session", "Copy session suffix rename failed", {
				sessionId,
				sessionPath: result.sessionPath,
				error: error instanceof Error ? error.message : String(error),
			});
			emitAgentsNotice({
				message: mainCopy("notice.sessionSuffixRenameFailed"),
				i18nKey: "notice.sessionSuffixRenameFailed",
				i18nParams: { mode: mainCopy("session.forkedSuffix") },
				kind: "warning",
			});
		}
	}
	const copied = await sessionCatalog.ensureRuntimeTarget({
		projectId: entry.projectId,
		title,
		source: entry.source,
		environment: entry.environment,
		filePath: result.sessionPath,
		wslDistro: entry.wslDistro,
		wslUser: entry.wslUser,
		importedSourceId: entry.importedSourceId,
		// 复制产物同为 fork 身份（文件头带 parentSession，与运行中 clone 同源标记）。
		forked: true,
		// 命令层权威标题：上面刚把 (fork) 名写进产物文件，扫描竞态不得把标题留在正文兜底上。
		titleAuthority: "command",
		// 模型偏好/思考档位随复制继承：静态副本不会产生新的 model_change，不继承则重启后模型选择器为空。
		model: entry.model,
		thinkingLevel: entry.thinkingLevel,
	});
	return { cancelled: false, targetSessionId: copied.id };
}

/**
 * 生图独立存储的两个磁盘根：sessions（会话 JSONL 索引）+ blobs（图片二进制）。
 * 统一在这里解析，避免「列表读 A、写盘写 B、协议从 C 读」这类路径漂移。
 */
function resolveImageGenStorageRoots(): { sessions: string; blobs: string } {
	const root = join(app.getPath("userData"), "imagegen");
	return { sessions: join(root, "sessions"), blobs: join(root, "blobs") };
}

/**
 * 会话 HTML 导出的本机目录（应用数据目录内，AGENTS.md 路径安全约束）。
 *
 * 单一数据源：DSH 投影式导出与远端会话导出必须是同一个目录；各拼一次路径迟早漂移成
 * 「导出成功但用户在另一个目录找不到文件」。
 */
function resolveSessionExportDir(): string {
	return join(app.getPath("userData"), "exports");
}

/**
 * Agent 记忆（pideck-agent-memory）的挂载描述。
 *
 * 记忆实现是 resources/agent-memory 下的 stdio MCP 服务器，由各后端子进程自己拉起：
 * pi 走 ~/.pi/agent/mcp.json（pi 0.99 内置 MCP 只认这个文件），ACP 走 session/new 的 mcpServers。
 * 传 cwd 时会话就带上项目作用域键，三种后端因此共享同一份项目记忆。
 */
/**
 * 学习循环的一次性补全：与增强/预测同一条通道（同一份侧车协议），但用独立实例。
 *
 * 模型优先级复用增强那一套解析：用户显式指定的增强模型 > 该会话记录的模型。
 * 都没有就拒绝——学习是可选增益，不能为了它去猜一个模型或退回某个默认供应商。
 */
function memoryLearnComplete(sessionId: string, input: { systemPrompt: string; text: string }): Promise<string> {
	const service = agentMemoryLearnService;
	if (!service) return Promise.reject(new Error("learn-service-unavailable"));
	const record = sessionCatalog?.get(sessionId)?.model;
	const target = resolveEnhanceTargetModel({
		configured: settingsStore?.get().enhanceModel ?? null,
		recordModel: record ? { provider: record.provider, modelId: record.modelId } : undefined,
	});
	if (!target) return Promise.reject(new Error("learn-model-unavailable"));
	return new Promise<string>((resolve, reject) => {
		void service
			.enhance(
				{ provider: target.provider, modelId: target.modelId, userText: input.text, systemPrompt: input.systemPrompt },
				{
					onDelta: () => undefined,
					onDone: (text) => resolve(text),
					onAborted: () => reject(new Error("learn-aborted")),
					onError: (errorKind, message) => reject(new Error(`learn-${errorKind}: ${message}`)),
				},
			)
			.then((accepted) => {
				if (!accepted.ok) reject(new Error(`learn-${accepted.errorKind}`));
			});
	});
}

function createAgentMemoryMount(cwd?: string) {
	return buildAgentMemoryMountForApp({
		userData: app.getPath("userData"),
		home: app.getPath("home"),
		execPath: process.execPath,
		isPackaged: app.isPackaged,
		appPath: app.getAppPath(),
		resourcesPath: process.resourcesPath,
		cwd,
		// DSH 会话也进记忆索引（根会话才采）；dshHomeDir 设置为空时与 DshHost 同默认（~/.dsh）。
		// settingsStore 未装配时（理论上不会，注册都发生在 whenReady 后）不挡 pi/ACP 采集。
		dshSessionsDir: settingsStore ? join(resolveDshHomeDir(settingsStore.get().dshHomeDir ?? "", app.getPath("userData")), "sessions") : undefined,
	});
}

/**
 * 生视频独立存储的磁盘根：与生图同构（sessions + blobs），根目录 userData/videogen。
 * 同样统一在此解析，避免读写漂移；任务表 jobs.json 单独放根目录（高频重写，不入 sessions）。
 */
function resolveVideoGenStorageRoots(): { sessions: string; blobs: string; jobs: string } {
	const root = join(app.getPath("userData"), "videogen");
	return { sessions: join(root, "sessions"), blobs: join(root, "blobs"), jobs: join(root, "jobs.json") };
}

function exportCatalogSessionHtml(sessionId: string): Promise<{ path: string; truncated?: boolean }> {
	return exportCatalogSessionHtmlWithPorts({ catalog: sessionCatalog, projects: projectStore, pi: agentManager, dsh: dshAgentManager, exportDir: resolveSessionExportDir, copy: mainCopy }, sessionId);
}

type AgentSessionReplacementResult = {
	cancelled?: boolean;
	[key: string]: unknown;
};

async function replaceAgentSession(agentId: string, replace: () => Promise<unknown>, options?: { markForked?: boolean; markSuperseded?: boolean }): Promise<AgentSessionReplacementResult & { targetSessionId?: string }> {
	const originBinding = sessionRuntimeCoordinator.getRuntimeBinding(agentId);
	const originEntry = originBinding ? sessionCatalog.get(originBinding.sessionId) : undefined;
	// 远端会话的身份是 (hostId, remotePath)，本机 filePath/originKey 对它不成立：先取 locator 分流，
	// SSH 分支在 resolveTargetSessionId / canRestoreOrigin 内单独复核，绝不落进本机路径解析。
	const originLocator = originEntry ? sessionCatalog.getLocator(originEntry.id) : undefined;
	const originKey =
		originLocator?.kind !== "ssh" && originEntry?.filePath
			? buildSessionOriginKey({
					source: originEntry.source,
					environment: originEntry.environment,
					filePath: originEntry.filePath,
					wslDistro: originEntry.wslDistro,
					wslUser: originEntry.wslUser,
					importedSourceId: originEntry.importedSourceId,
				})
			: undefined;
	const projectLocatorOf = (projectId: string) => {
		const project = projectStore.get(projectId);
		return project && isRemoteProject(project) ? project.locator : undefined;
	};
	return sessionRuntimeCoordinator.replaceBoundRuntime({
		agentId,
		replace: async () => {
			const result = await replace();
			return result && typeof result === "object" && !Array.isArray(result) ? (result as AgentSessionReplacementResult) : {};
		},
		resolveTargetSessionId: async (result) => {
			const tab = agentManager.list().find((candidate) => candidate.id === agentId);
			if (!tab?.sessionPath) {
				throw new Error(`Replacement runtime has no session path: ${agentId}`);
			}
			// 远端 port 已把本次 get_state 的路径登记进 catalog：它只能用远端身份匹配，
			// 不能交给 ensureRuntimeTarget 的本机路径解析，也不能挂到原会话记录上。
			const remoteTargetId = originLocator?.kind === "ssh" && typeof result.targetSessionId === "string" ? result.targetSessionId : undefined;
			if (originLocator?.kind === "ssh") {
				const target = remoteTargetId ? sessionCatalog.get(remoteTargetId) : undefined;
				const locator = target?.locator;
				if (!target || target.id === originEntry?.id || target.projectId !== tab.projectId || locator?.kind !== "ssh" || locator.hostId !== originLocator.hostId || locator.remotePath !== tab.sessionPath) {
					throw new Error("REMOTE_SESSION_LOCATOR_UNRESOLVED");
				}
			}
			const environment = tab.sessionEnvironment ?? originEntry?.environment ?? "native";
			// fork/clone 产物把 (fork) 物理写进会话名（走 pi set_session_name RPC，持久化到
			// 会话文件），不再由展示层按 forked 标记拼装——用户重命名删掉后缀就是真的删掉，
			// 扫描回读（session_info 命中）也与文件一致。rename RPC 失败不阻断 fork：
			// 回退原名，避免文件/目录标题分叉（下次扫描以文件为权威）。
			let title = tab.title;
			if (options?.markForked) {
				const forkedTitle = appendSessionForkSuffix(title, mainCopy("session.forkedSuffix"));
				if (forkedTitle !== title) {
					try {
						await agentManager.rename(agentId, forkedTitle);
						title = forkedTitle;
					} catch (error) {
						// 静默历史（2026-10-08 现场）：只写日志 → 用户零反馈，侧栏标题停在弱兑底上。
						// fork 产物已存在，失败不阻断，但必须可见：toast 引导手动重命名补后缀。
						void appLogger.warn("session", "Fork session suffix rename failed", {
							agentId,
							title,
							error: error instanceof Error ? error.message : String(error),
						});
						emitAgentsNotice({
							message: mainCopy("notice.sessionSuffixRenameFailed"),
							i18nKey: "notice.sessionSuffixRenameFailed",
							i18nParams: { mode: mainCopy("session.forkedSuffix") },
							kind: "warning",
						});
					}
				}
			}
			if (remoteTargetId) {
				const locator = sessionCatalog.getLocator(remoteTargetId);
				const project = projectLocatorOf(tab.projectId);
				// rename 也会刷新 get_state：换绑前拒绝身份漂移。
				if (locator?.kind !== "ssh" || locator.remotePath !== tab.sessionPath || project?.kind !== "ssh" || project.hostId !== locator.hostId) throw new Error("REMOTE_SESSION_LOCATOR_UNRESOLVED");
				await sessionCatalog.update(remoteTargetId, { title, forked: options?.markForked });
				return remoteTargetId;
			}
			const target = await sessionCatalog.ensureRuntimeTarget({
				projectId: tab.projectId,
				title,
				source: tab.sessionSource ?? originEntry?.source ?? "pi",
				environment,
				filePath: tab.sessionPath,
				wslDistro: tab.wslDistro ?? (environment === "wsl" ? originEntry?.wslDistro : undefined),
				wslUser: tab.wslUser ?? (environment === "wsl" ? originEntry?.wslUser : undefined),
				importedSourceId: tab.importedSourceId ?? originEntry?.importedSourceId,
				piSessionId: tab.sessionId,
				// fork/clone 产物同步落 fork 标记（fork 身份元数据；(fork) 标题后缀已物理写入
				// 会话名，见上方 appendSessionForkSuffix）；开关由调用方按语义传入，
				// switch_session / 历史会话换绑等不标记。
				forked: options?.markForked,
				// 命令层权威标题：上面刚把 (fork) 名写进新会话文件，扫描竞态不得把标题留在正文兜底上。
				titleAuthority: "command",
				// 重发/编辑 fork 后的子会话文件里没有新的 model_change，扫描回读拿不到模型；
				// 不从源会话继承的话，重启后模型选择器为空、激活也不会重放该会话的模型偏好。
				model: originEntry?.model,
				thinkingLevel: originEntry?.thinkingLevel,
			});
			// 重发/编辑 fork 化替换：旧会话记录打 supersededBy 标记（列表过滤用），
			// 旧 JSONL 保留可恢复。放在 resolveTargetSessionId 内部：若标记写入失败，
			// replaceBoundRuntime 的错误路径会走 canRestoreOrigin 回滚绑定（fail-closed）。
			if (options?.markSuperseded && originEntry && originEntry.id !== target.id) {
				await sessionCatalog.markSuperseded(originEntry.id, target.id);
			}
			return target.id;
		},
		canRestoreOrigin: () => {
			const tab = agentManager.list().find((candidate) => candidate.id === agentId);
			if (!tab?.sessionPath) return false;
			if (originLocator?.kind === "ssh") {
				// 一次失败的 state 读取会清掉路径；文件变了也不能挂回旧记录。
				// SSH 身份是 host + remotePath，不是 originKey。
				const current = originEntry ? sessionCatalog.getLocator(originEntry.id) : undefined;
				const project = projectLocatorOf(tab.projectId);
				return project?.kind === "ssh" && project.hostId === originLocator.hostId && current?.kind === "ssh" && current.hostId === originLocator.hostId && current.remotePath === originLocator.remotePath && tab.projectId === originEntry?.projectId && tab.sessionPath === originLocator.remotePath;
			}
			if (!originKey) return false;
			return (
				buildSessionOriginKey({
					source: tab.sessionSource ?? "pi",
					environment: tab.sessionEnvironment ?? "native",
					filePath: tab.sessionPath,
					wslDistro: tab.wslDistro,
					wslUser: tab.wslUser,
					importedSourceId: tab.importedSourceId,
				}) === originKey
			);
		},
		onDetached: emitSessionRuntimeDetach,
		onAttached: (binding) => emitReplacementState(binding, true),
		onRestored: (binding) => emitReplacementState(binding, false),
	});
}

// ── fork/clone 统一命令层（桌面 IPC 与 Web HTTP 共用；W1 重发/编辑 fork 化统一）──
// DSH fork/clone：session.fork 出新 host 会话后**新建 catalog 条目**（(fork) 标题 + 新
// dshSessionId + forked 标记），再把 runtime 换绑过去；原条目保留在侧栏。
// 旧实现只把当前条目的 dshSessionId 原地改写，用户永远只看到一条会话（issue #381 后续）。
// 懒装配：dshAgentManager / sessionCatalog / coordinator 都在 whenReady 后才赋值。
let dshSessionForkInstance: ReturnType<typeof createDshSessionFork> | undefined;
const getDshSessionFork = () => {
	if (!dshSessionForkInstance) {
		if (!dshAgentManager) throw new Error("DSH agent manager is not ready");
		dshSessionForkInstance = createDshSessionFork({
			catalog: sessionCatalog,
			agents: dshAgentManager,
			coordinator: sessionRuntimeCoordinator,
			forkedSuffix: () => mainCopy("session.forkedSuffix"),
			onDetached: emitSessionRuntimeDetach,
			onAttached: (binding) => emitReplacementState(binding, true),
			onRestored: (binding) => emitReplacementState(binding, false),
			// host 改名失败不阻断 fork，但必须可见：与 pi 侧同一文案，引导手动重命名补后缀。
			onTitleRenameFailed: () =>
				emitAgentsNotice({
					message: mainCopy("notice.sessionSuffixRenameFailed"),
					i18nKey: "notice.sessionSuffixRenameFailed",
					i18nParams: { mode: mainCopy("session.forkedSuffix") },
					kind: "warning",
				}),
			logger: appLogger,
		});
	}
	return dshSessionForkInstance;
};
/** fork/clone 成功后推送 catalog 刷新：pi/DSH 都会新建 catalog 条目（或回填标题/标记），
 * 侧栏只有收到 sessionsCatalogRefreshed 才会静默重拉列表（useProjectSync），否则
 * 新会话要等下次手动刷新才出现。Web 端由 /api/events SSE 快照 diff 兜底。 */
const notifyForkCatalogRefreshed = (sessionId: string): void => {
	const projectId = sessionCatalog.get(sessionId)?.projectId;
	if (!projectId) return;
	const window = mainWindow;
	if (window && !window.isDestroyed()) {
		window.webContents.send(ipcChannels.sessionsCatalogRefreshed, { projectId });
	}
};
// 惰性初始化：装配顺序上 registerIpc/WebServiceManager 都会先拿到引用，而
// sessionRuntimeCoordinator/agentManager 在 whenReady 里才赋值；包一层闭门工厂避免顶层直用未赋值变量。
let sessionForkCommandsInstance: ReturnType<typeof createSessionForkCommands> | undefined;
const getSessionForkCommands = () => {
	if (!sessionForkCommandsInstance) {
		sessionForkCommandsInstance = createSessionForkCommands({
			sessionRuntimeCoordinator,
			agentManager,
			replaceAgentSession,
			isDshAgent: (agentId) => dshAgentManager?.list().some((tab) => tab.id === agentId) === true,
			replaceDshAgentSession: (target, entryId) => getDshSessionFork().fork(target, entryId),
			replaceDshCloneSession: (target) => getDshSessionFork().clone(target),
			logger: appLogger,
			notifyForkCatalogRefreshed,
		});
	}
	return sessionForkCommandsInstance;
};
/** 桌面/Web 共用的 fork/clone 命令层门面（延迟到首次调用才装配依赖）。 */
const sessionForkCommands = {
	forkRuntimeSession: (target: Parameters<ReturnType<typeof createSessionForkCommands>["forkRuntimeSession"]>[0], entryId: string, options?: { mutationFork?: boolean; branchMode?: boolean }) => getSessionForkCommands().forkRuntimeSession(target, entryId, options),
	cloneRuntimeSession: (target: Parameters<ReturnType<typeof createSessionForkCommands>["cloneRuntimeSession"]>[0]) => getSessionForkCommands().cloneRuntimeSession(target),
};

function cancelUnboundUiRequest(payload: unknown): void {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
	const request = payload as Partial<AgentUiRequest>;
	if (typeof request.agentId !== "string" || typeof request.requestId !== "string" || request.completed === true || !(["select", "confirm", "input", "editor", "batch_ask"] as const).some((method) => method === request.method)) {
		return;
	}
	void appLogger.warn("session", "Cancelled unbound runtime UI request", {
		agentId: request.agentId,
		requestId: request.requestId,
		method: request.method,
	});
	void agentManager.sendUIResponse(request.agentId, request.requestId, { cancelled: true });
}

/**
 * 渠道会话（飞书/微信）的默认模型与思考档位：与桌面端 createDraft 同一解析器（launchDefaults），
 * 否则桥建出来的会话不写这两项，pi 按自己的缺省开跑——用户在设置里配的默认档位（如 max）
 * 对飞书完全不生效（Discussions #478）。配置读取失败退回空：桥建会话不该被配置问题卡住。
 */
async function resolveImSessionLaunchPreferences(backend: Parameters<typeof resolveImSessionLaunchDefaults>[0]["backend"]): Promise<ReturnType<typeof resolveImSessionLaunchDefaults>> {
	try {
		const [settingsResult, modelsResult] = await Promise.all([configManager.getSettingsConfig(), configManager.getModelsConfig()]);
		const defaults = resolveImSessionLaunchDefaults({
			backend,
			settings: settingsResult.parsed,
			models: modelsResult.parsed,
			// 与桌面端 createDraft 同源：存在性校验含 capability 快照（auth 渠道模型也算可选）。
			catalogModels: validationCatalogModels(),
			lastUsedModel: settingsStore.get().lastUsedModel,
		});
		return defaults;
	} catch {
		return {};
	}
}

const imSessionRuntimeBindings: SessionRuntimeBindingGateway = {
	async ensureSession(input) {
		if (input.existingSessionId) {
			const existing = sessionCatalog.get(input.existingSessionId);
			if (existing) return { sessionId: existing.id };
		}
		const project = projectStore.get(input.projectId);
		const projectWsl = resolveProjectWslIdentity(project, settingsStore.get());
		const environment = projectWsl !== undefined ? "wsl" : "native";
		if (input.sessionPath) {
			const existing = sessionCatalog.findByFilePath(input.sessionPath, environment);
			if (existing) return { sessionId: existing.id };
			const restored = await sessionCatalog.ensureRuntimeTarget({
				projectId: input.projectId,
				title: input.title,
				source: "pi",
				environment,
				filePath: input.sessionPath,
				// 已存在的会话文件：标题按权威名落库（有历史就不会再有自动命名），只透传渠道标志。
				channel: input.channel,
				...(projectWsl !== undefined ? { wslDistro: projectWsl.distro, wslUser: projectWsl.user } : {}),
			});
			return { sessionId: restored.id };
		}
		if (input.backend === "dsh" && dshRuntimeStatus.canCreateDshSession() !== true) {
			// 与 sessions:create-anonymous 同一道门控：不可用后端建不出会话。
			// 这里只抛机器可读错误码，通道文案由桥接词典决定（装配层不写用户文案）。
			const error: Error & { code?: string } = new Error("DSH runtime is not available");
			error.code = "dshUnavailable";
			throw error;
		}
		const draft = await sessionCatalog.createDraft({
			projectId: input.projectId,
			title: input.title,
			environment,
			// 渠道后端（缺省 pi：保持与历史行为一致，undefined 与 pi 等价）。
			backend: input.backend,
			// 默认模型与思考档位：与桌面端同源，否则飞书里永远是 pi 缺省的 off（#478）。
			...(await resolveImSessionLaunchPreferences(input.backend)),
			// source 是历史来源（pi JSONL 语系），后端才是引擎：新建渠道会话一律 source=pi，
			// DSH 会话也一样（且不带 filePath——DSH 会话文件是 zstd，
			// canAttachRuntimeMetadata 会拒绝，host id 由 Coordinator 回写）。
			source: "pi",
			channel: input.channel,
			// 外部连接（微信等）要的是「像桌面会话一样自动命名」：不写 titleOrigin 即留一次
			// 自动命名机会（见 createDraft 的 titleOrigin 说明），pi 侧命名扩展的模型标题随后领取。
			...(input.autoTitle ? {} : { titleOrigin: "manual" as const }),
		});
		return { sessionId: draft.id };
	},
	async activateRuntime(sessionId) {
		const activated = await sessionRuntimeCoordinator.activateRuntime(sessionId);
		if (!activated.ok) throw sessionCommandIpcError(activated.error);
		const tab = findRuntimeTab(activated.value.agentId);
		if (!tab)
			throw sessionCommandIpcError({
				code: "SESSION_COMMAND_FAILED",
				debugDetails: `Activated runtime not found: ${activated.value.agentId}`,
			});
		tab.runtimeGeneration = activated.value.runtimeGeneration;
		emitSessionRuntimeEvent(tab.id, agentEventTags.agentsState, tab);
		return tab;
	},
	async bindRuntime(input) {
		if (input.agent.status === "error" || input.agent.status === "closed") {
			throw new Error(`Cannot bind terminal Feishu runtime: ${input.agent.id}`);
		}
		const environment = input.agent.sessionEnvironment ?? "native";
		const source = input.agent.sessionSource ?? "pi";
		let sessionId: string | undefined;
		if (input.existingSessionId) {
			const existing = sessionCatalog.get(input.existingSessionId);
			if (existing) {
				const currentBinding = sessionRuntimeCoordinator.getRuntimeBinding(input.agent.id);
				if (currentBinding && currentBinding.sessionId !== existing.id) {
					throw new Error(`Runtime is already bound to a different Session: ${currentBinding.sessionId}`);
				}
				if (input.agent.sessionPath && !canAttachRuntimeMetadata(existing, input.agent)) {
					throw new Error(`Existing Session origin does not match runtime: ${existing.id}`);
				}
				sessionId = existing.id;
			}
		}
		if (!sessionId && input.agent.sessionPath) {
			const targetOrigin = buildSessionOriginKey({
				source,
				environment,
				filePath: input.agent.sessionPath,
				wslDistro: input.agent.wslDistro,
				wslUser: input.agent.wslUser,
				importedSourceId: input.agent.importedSourceId,
			});
			sessionId = sessionCatalog.listEntries().find(
				(candidate) =>
					candidate.filePath &&
					buildSessionOriginKey({
						source: candidate.source,
						environment: candidate.environment,
						filePath: candidate.filePath,
						wslDistro: candidate.wslDistro,
						wslUser: candidate.wslUser,
						importedSourceId: candidate.importedSourceId,
					}) === targetOrigin,
			)?.id;
		}
		if (!sessionId) {
			const draft = await sessionCatalog.createDraft({
				projectId: input.projectId,
				title: input.agent.title || "Feishu session",
				environment,
				source,
				titleOrigin: "manual",
			});
			sessionId = draft.id;
		}
		await sessionCatalog.attachRuntime(
			input.agent.sessionPath
				? {
						sessionId,
						filePath: input.agent.sessionPath,
						piSessionId: input.agent.sessionId,
					}
				: {
						sessionId,
						piSessionId: input.agent.sessionId,
					},
		);
		const runtimeGeneration = sessionRuntimeCoordinator.bindExistingAgent(sessionId, input.agent.id);
		input.agent.runtimeGeneration = runtimeGeneration;
		emitSessionRuntimeEvent(input.agent.id, agentEventTags.agentsState, input.agent);
		return { sessionId };
	},
	async sendPrompt(input) {
		const result = await sessionRuntimeCoordinator.send({
			...input,
			requestId: randomUUID(),
		});
		if (!result.accepted) throw new Error(result.error);
	},
	async abortRuntime(sessionId) {
		const target = sessionRuntimeCoordinator.getTarget(sessionId);
		if (!target) throw sessionCommandIpcError({ code: "SESSION_RUNTIME_UNAVAILABLE" });
		const result = await sessionRuntimeCoordinator.abortRuntime(target);
		if (!result.ok) throw sessionCommandIpcError(result.error);
	},
	findRuntimeAgent(agentId) {
		return findRuntimeTab(agentId);
	},
	getRuntimeMessages(sessionId) {
		// 无 runtime（草稿/已释放）按空时间线处理：调用方用它取本轮起点，空数组是安全缺省。
		return sessionRuntimeCoordinator.getRuntimeMessages(sessionId)?.value ?? [];
	},
	waitForRunEnd(input) {
		// 监听在提交 prompt 之前同步注册（waitForSessionRunEnd 的第一件事就是 subscribe），
		// 终态契约见 sessions/sessionRunWaiter.ts。
		return waitForSessionRunEnd(
			{
				subscribe: (listener) => {
					runtimeEventListeners.add(listener);
					return () => {
						runtimeEventListeners.delete(listener);
					};
				},
				getMessages: (id) => sessionRuntimeCoordinator.getRuntimeMessages(id)?.value ?? [],
			},
			input,
		);
	},
	async listRuntimeModels(sessionId) {
		const target = sessionRuntimeCoordinator.getTarget(sessionId);
		if (!target) throw sessionCommandIpcError({ code: "SESSION_RUNTIME_UNAVAILABLE" });
		const result = await sessionRuntimeCoordinator.listRuntimeModels(target);
		if (!result.ok) throw sessionCommandIpcError(result.error);
		return result.value.value;
	},
	async getRuntimeState(sessionId) {
		const target = sessionRuntimeCoordinator.getTarget(sessionId);
		if (!target) return undefined;
		const result = await sessionRuntimeCoordinator.getRuntimeState(target);
		if (!result.ok) throw sessionCommandIpcError(result.error);
		return result.value.value;
	},
	async setRuntimeModel(sessionId, provider, modelId) {
		const target = sessionRuntimeCoordinator.getTarget(sessionId);
		if (!target) throw sessionCommandIpcError({ code: "SESSION_RUNTIME_UNAVAILABLE" });
		const result = await sessionRuntimeCoordinator.setRuntimeModel(target, provider, modelId);
		if (!result.ok) throw sessionCommandIpcError(result.error);
	},
	async setRuntimeThinking(sessionId, level) {
		const target = sessionRuntimeCoordinator.getTarget(sessionId);
		if (!target) throw sessionCommandIpcError({ code: "SESSION_RUNTIME_UNAVAILABLE" });
		const result = await sessionRuntimeCoordinator.setRuntimeThinking(target, level);
		if (!result.ok) throw sessionCommandIpcError(result.error);
	},
	// ask/confirm 等扩展 UI 请求的答案回写：agentId 是 runtime id，直接走 AgentManager（与桌面端弹窗同链路）。
	sendUIResponse(agentId, requestId, response) {
		agentManager.sendUIResponse(agentId, requestId, response);
	},
};

let themeScheduleTimer: ReturnType<typeof setTimeout> | undefined;

function clearThemeScheduleTimer(): void {
	if (themeScheduleTimer !== undefined) {
		clearTimeout(themeScheduleTimer);
		themeScheduleTimer = undefined;
	}
}

function applyNativeThemeSource(settings: AppSettings) {
	// 原生标题栏不受 renderer CSS 影响；跟随应用主题，避免暗色界面顶部仍是系统浅色栏。
	// Electron nativeTheme.themeSource 只认 system/light/dark；跟随时间先解析再写入。
	nativeTheme.themeSource =
		settings.theme === "system"
			? "system"
			: resolveAppColorScheme({
					theme: settings.theme,
					themeScheduleLightStart: settings.themeScheduleLightStart,
					themeScheduleDarkStart: settings.themeScheduleDarkStart,
					systemPrefersDark: nativeTheme.shouldUseDarkColors,
				});
	clearThemeScheduleTimer();
	// 跟随时间：睡到下一次浅色/暗色边界再刷标题栏，避免每分钟轮询。
	if (settings.theme === "schedule") {
		const delay = msUntilNextThemeBoundary(new Date(), settings.themeScheduleLightStart, settings.themeScheduleDarkStart);
		themeScheduleTimer = setTimeout(() => {
			applyNativeThemeSource(settingsStore.get());
		}, delay);
	}
}

const POSTHOG_PROJECT_KEY = process.env.POSTHOG_PROJECT_KEY ?? "phc_xgJ8gFUMgExZEEPzZ7VRa7698ENcaDRquWZVGYb2dCFK";
const POSTHOG_HOST = process.env.POSTHOG_HOST ?? "https://us.i.posthog.com";

/**
 * 重启应用：先同步退出标志并停掉常驻服务，再 relaunch + quit。
 * 必须置 isQuitting，否则 closeToTray 会把退出流程吞成「隐藏到托盘」，relaunch 不生效。
 */
function restartApp(): void {
	isQuitting = true;
	void webServiceManager?.stop();
	terminalManager?.closeAll();
	void agentManager?.stopAll();
	app.relaunch();
	app.quit();
}

/**
 * 记录用户对主窗口呈现态的选择，供唤起时重新施加。
 * 逻辑走 windowReveal 的纯函数：全屏期间 Windows 会连带发 maximize/unmaximize，不能被改写成最大化。
 */
function trackMainWindowVisualIntent(window: BrowserWindow): void {
	const readState = (): MainWindowVisualState => ({ minimized: window.isMinimized(), maximized: window.isMaximized(), fullscreen: window.isFullScreen() });
	// 逐个注册而非循环：BrowserWindow.on 的事件名是重载字面量，联合类型无法安定到具体重载。
	const track = (event: MainWindowVisualEvent) => () => {
		mainWindowVisualIntent = nextMainWindowVisualIntent(mainWindowVisualIntent, readState(), event);
	};
	window.on("maximize", track("maximize"));
	window.on("unmaximize", track("unmaximize"));
	window.on("enter-full-screen", track("enter-full-screen"));
	window.on("leave-full-screen", track("leave-full-screen"));
}

/**
 * 把主窗口带回前台，并重新施加用户最后一次的呈现态（最大化/全屏）。
 *
 * 为何不直接 show()：Electron 不保证从最小化/隐藏唤回的窗口还是最大化。
 * 实测 win32 + Electron 43：「最大化 → minimize() → 只 show()+focus()」得到
 * isMaximized()===false，几何仍是 -7,-7 2064×1120（铺满屏但系统视为普通窗口），
 * 下一次还原/拖动就掉回 1522×857 的正常尺寸——用户看到的就是「点通知/点宠物打开后窗口变小」。
 * 全屏同理：全屏若没进 last-window-bounds，关窗即退出（closeToTray=false）后只剩最大化。
 * 具体做哪几步由 planMainWindowReveal 决定（见 windowReveal.ts）。
 */
function revealMainWindow(window: BrowserWindow): void {
	if (window.isDestroyed()) return;
	const plan = planMainWindowReveal(mainWindowVisualIntent, { minimized: window.isMinimized(), maximized: window.isMaximized(), fullscreen: window.isFullScreen() }, { e2e: isE2E });
	if (plan.restore) window.restore();
	if (typeof window.setSkipTaskbar === "function") {
		window.setSkipTaskbar(false);
	}
	if (plan.maximizeBeforeShow) window.maximize();
	window.show();
	if (plan.fullscreenAfterShow) window.setFullScreen(true);
	window.focus();
	if (process.platform === "win32") {
		// Windows 前置窗口用「临时置顶再取消」hack 抢前台（直接 focus 可能被前台锁拦截）。
		// 必须原样还原用户置顶状态，否则会把用户手动置顶的窗口取消置顶；
		// 已置顶的窗口本身就在最前，无需重复 hack。
		const wasAlwaysOnTop = window.isAlwaysOnTop();
		if (!wasAlwaysOnTop) {
			window.setAlwaysOnTop(true);
			window.setAlwaysOnTop(false);
		}
	}
}

/** 从托盘/任务栏/二次启动唤起主窗口：处理最小化、隐藏到托盘两种状态，并回到原呈现态。 */
function focusMainWindow() {
	if (!mainWindow || mainWindow.isDestroyed()) return;
	revealMainWindow(mainWindow);
	// 主窗口回来时默认关闭极简浮窗（避免两个窗口并存）；
	// 「固定在最上方」开启（含未显式设置的默认 true）时浮窗常驻，只响应手动隐藏/收起。
	if (settingsStore.get().floatingBallAlwaysOnTop === false) miniOverlayWindow?.hide();
}

/**
 * 页面加载期间（冷启动/窗口重建）的跳转目标（通知点击/右键打开项目）：直接 send 会在 preload/React
 * 监听注册前丢失，先存入 pending，由两条路径兜底送达：
 * 1. did-finish-load 后 flush 一次（窗口重建/旧 renderer 兼容的尽力而为）；
 * 2. renderer 挂载后经 pet:get-focus-target-pending 主动拉取（取走即清空，保证送达）。
 * 三种目标：sessionId 跳会话；projectId 跳已有项目（右键打开已收录目录）；projectPath 引导新增项目。
 */
/** 项目表加载完成的 Promise（whenReady 内赋值）。冷启动跳转目标 / 单实例焦点请求
 * 解析目录是否已收录前必须先等它，否则 findByPath 命中空项目表，已注册目录也会弹「添加为项目」。 */
let projectStoreReady: Promise<unknown> | null = null;

let pendingFocusTarget: { sessionId: string } | { projectId: string } | { projectPath: string } | null = null;

/** 窗口就绪（存在且未在加载）直接推送；否则入 pending 队列。 */
function queueFocusTarget(target: { sessionId: string } | { projectId: string } | { projectPath: string }) {
	if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
		mainWindow.webContents.send(ipcChannels.petFocusAgentTarget, target);
		return;
	}
	pendingFocusTarget = target;
}

/** did-finish-load 兜底：仍在加载期排队的目标补发一次（不清空，renderer 拉取幂等）。 */
function flushPendingFocusTargetOnLoad() {
	if (pendingFocusTarget && mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send(ipcChannels.petFocusAgentTarget, pendingFocusTarget);
	}
}

/**
 * 同版本次实例请求聚焦：窗口已在则前置；若窗口尚未创建/已销毁，ready 后重建。
 * 若唤起源自「点击系统通知」（argv 携带 pideck:// URL），额外向 renderer 发送聚焦目标，
 * 切换到对应会话；agentId 为兼容旧 toast 的兜底格式，运行时经 coordinator 解析成会话。
 * 挂到顶层 focusExistingWindow，供版本单实例锁的 .focus 信号调用。
 */
function handleVersionFocusRequest(payload?: FocusPayload) {
	const target = extractFocusTargetFromArgv(payload?.argv);
	const activateSession = async () => {
		if (!target) return;
		if (await quickTaskChrome.applyLaunchTarget(target)) return;
		// 文件夹右键打开：已收录目录直接跳项目（渲染层 selectProjectCommand）；
		// 未收录目录推 projectPath，渲染层弹确认框走新增项目流程。
		if (target.projectPath) {
			// 主实例可能在启动早期就收到 .focus 信号（项目表尚未 load 完），先等就绪再判定。
			if (projectStoreReady) await projectStoreReady;
			const existing = projectStore?.findByPath(target.projectPath);
			if (existing) {
				queueFocusTarget({ projectId: existing.id });
			} else {
				queueFocusTarget({ projectPath: target.projectPath });
			}
			return;
		}
		let sessionId = target.sessionId;
		if (!sessionId && target.agentId && sessionRuntimeCoordinator) {
			sessionId = sessionRuntimeCoordinator.getSessionId(target.agentId);
		}
		if (sessionId) queueFocusTarget({ sessionId });
	};
	if (mainWindow && !mainWindow.isDestroyed()) {
		focusMainWindow();
		void activateSession();
		return;
	}
	void app.whenReady().then(() => {
		if (mainWindow && !mainWindow.isDestroyed()) {
			focusMainWindow();
			void activateSession();
			return;
		}
		if (settingsStore) {
			void createWindow()
				.then(() => {
					void activateSession();
				})
				.catch((error) => {
					void appLogger?.error("app", "Failed to recreate window on version focus request", error);
				});
		}
	});
}

// 顶层锁回调延后绑定：focusMainWindow / createWindow 定义在锁申请之后。
focusExistingWindow = handleVersionFocusRequest;

async function openExternalUrl(url: string, forceSystem = false) {
	if (!url.startsWith("http:") && !url.startsWith("https:")) return;
	// 更新页的发行说明和安装包必须离开内置浏览器，避免下载被 webview 的导航策略拦截。
	if (forceSystem) {
		await shell.openExternal(url);
		return;
	}
	const settings = settingsStore.get();
	if (settings.linkOpenMode === "internal") {
		openInternalLinkInBrowserPanel(url);
		return;
	}
	await shell.openExternal(url);
}

function openInternalLinkInBrowserPanel(url: string) {
	// 内部打开：将 URL 发送到渲染进程，由 BrowserPanel 在侧栏/弹框中加载，
	// 替代之前的独立 BrowserWindow 方案，保持一致的浏览体验。
	if (!mainWindow || mainWindow.isDestroyed()) {
		void shell.openExternal(url);
		return;
	}
	mainWindow.webContents.send(ipcChannels.appOpenInBrowser, url);
}

function printStartupInfo() {
	if (!mainWindow || mainWindow.isDestroyed()) return;

	const settings = settingsStore.get();
	const appVersion = app.getVersion();
	const electronVersion = process.versions.electron;
	const chromeVersion = process.versions.chrome;
	const nodeVersion = process.versions.node;
	const platform = process.platform;
	const arch = process.arch;
	const persistentInstallationType = settings.installationType || "unknown";
	const isPortableEnv = process.env.PORTABLE_EXECUTABLE_DIR !== undefined;
	// Debug 中展示实际生效类型,便于发现持久化值和运行时便携信号不一致的问题。
	const effectiveInstallationType = process.platform === "win32" && isPortableEnv ? "portable" : persistentInstallationType;

	// 执行 console.log 输出到开发者工具
	mainWindow.webContents.executeJavaScript(`
		console.log(
			"%c╭──────────────────────────────────────────────────────────╮",
			"color: #8b5cf6; font-weight: bold;"
		);
		console.log(
			"%c│                      PiDeck Desktop                      │",
			"color: #8b5cf6; font-weight: bold; font-size: 16px;"
		);
		console.log(
			"%c╰──────────────────────────────────────────────────────────╯",
			"color: #8b5cf6; font-weight: bold;"
		);
		console.log("");
		console.log("%c📦 Application Info", "color: #3b82f6; font-weight: bold; font-size: 14px;");
		console.log("%c  Version:         %c${appVersion}", "color: #6b7280;", "color: #10b981; font-weight: bold;");
		console.log("%c  Installation:    %c${effectiveInstallationType}", "color: #6b7280;", "color: #f59e0b; font-weight: bold;");
		console.log("%c  Platform:        %c${platform} (${arch})", "color: #6b7280;", "color: #8b5cf6;");
		console.log("");
		console.log("%c⚡ Runtime Info", "color: #3b82f6; font-weight: bold; font-size: 14px;");
		console.log("%c  Electron:        %c${electronVersion}", "color: #6b7280;", "color: #06b6d4;");
		console.log("%c  Chrome:          %c${chromeVersion}", "color: #6b7280;", "color: #06b6d4;");
		console.log("%c  Node:            %c${nodeVersion}", "color: #6b7280;", "color: #06b6d4;");
		console.log("");
		console.log("%c🔧 Debug Info", "color: #3b82f6; font-weight: bold; font-size: 14px;");
		console.log("%c  PORTABLE_EXECUTABLE_DIR: %c${isPortableEnv ? "✅ Set" : "❌ Not set"}", "color: #6b7280;", "color: ${isPortableEnv ? "#10b981" : "#ef4444"};");
		console.log("%c  Persistent installationType: %c${persistentInstallationType}", "color: #6b7280;", "color: #8b5cf6; font-weight: bold;");
		console.log("");
		console.log("%c🐛 Found a bug? Report at:", "color: #6b7280;");
		console.log("%c  https://github.com/ayuayue/PiDeck/issues", "color: #3b82f6; text-decoration: underline;");
		console.log("");
		console.log("%c🎉 Easter egg: You found it! Thanks for exploring.", "color: #ec4899; font-weight: bold;");
		console.log("");
	`);
}

async function prepareMainPreloadPath() {
	const sourcePath = join(__dirname, "../preload/index.js");
	return preparePreloadPath(sourcePath, "main-preload.js");
}

const BROWSER_PANEL_PARTITION = BROWSER_PANEL_PARTITION_SHARED;

function isAllowedBrowserPanelUrl(targetUrl: string): boolean {
	return isAllowedBrowserPanelUrlShared(targetUrl);
}

/**
 * 浏览器面板 partition 上的导航白名单拦截是否已注册。
 * Electron webRequest 监听返回 void 且不可移除；macOS activate 重建窗口会重复调用
 * configureBrowserPanelWebviewHost，必须只注册一次，否则每次重建都在共享 partition
 * 上累积一份回调（2026-10 泄漏修复）。
 */
let browserPanelRequestInstalled = false;

function configureBrowserPanelWebviewHost(window: BrowserWindow): void {
	const browserPanelSession = session.fromPartition(BROWSER_PANEL_PARTITION);
	browserPanelSession.setPermissionCheckHandler(() => false);
	browserPanelSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
	browserPanelSession.setDevicePermissionHandler(() => false);
	if (!browserPanelRequestInstalled) {
		browserPanelRequestInstalled = true;
		browserPanelSession.webRequest.onBeforeRequest((details, callback) => {
			const isFrameNavigation = details.resourceType === "mainFrame" || details.resourceType === "subFrame";
			if (isFrameNavigation && !isAllowedBrowserPanelUrl(details.url)) {
				void appLogger.warn("browser", "Blocked unsafe webview frame request", {
					resourceType: details.resourceType,
					url: details.url,
				});
				callback({ cancel: true });
				return;
			}
			callback({});
		});
	}

	window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
		// 宿主插件面板：partition 形如 host-plugin:<instanceId>，由 HostPluginViewHost 签发；
		// 与内置浏览器不同，必须携带独立 preload（桥接 broker），其余安全档位与浏览器面板一致。
		const hostPluginId = hostPluginPartitionId(params.partition ?? "");
		if (hostPluginId) {
			const bridge = hostPluginWebviewBridge();
			if (!bridge || !bridge.hasLive(hostPluginId) || (params.src !== `${HOST_PLUGIN_SCHEME}://${hostPluginId}/` && !params.src?.startsWith(`${HOST_PLUGIN_SCHEME}://${hostPluginId}/`))) {
				event.preventDefault();
				void appLogger.warn("host-plugins", "Blocked host-plugin webview attachment", { instanceId: hostPluginId });
				return;
			}
			webPreferences.partition = params.partition;
			webPreferences.sandbox = true;
			webPreferences.additionalArguments = rendererHeapAdditionalArguments();
			webPreferences.nodeIntegration = false;
			webPreferences.nodeIntegrationInWorker = false;
			webPreferences.nodeIntegrationInSubFrames = false;
			webPreferences.contextIsolation = true;
			webPreferences.webSecurity = true;
			webPreferences.allowRunningInsecureContent = false;
			webPreferences.webviewTag = false;
			delete webPreferences.preload;
			delete (webPreferences as Record<string, unknown>).preloadURL;
			const pluginPreload = bridge.preloadPath();
			if (pluginPreload) webPreferences.preload = pluginPreload;
			delete params.preload;
			delete params.preloadURL;
			delete params.allowfileaccess;
			delete params.allowpopups;
			return;
		}
		const sourceUrl = params.src || "about:blank";
		if ((params.partition && params.partition !== BROWSER_PANEL_PARTITION) || !isAllowedBrowserPanelUrl(sourceUrl)) {
			event.preventDefault();
			void appLogger.warn("browser", "Blocked unsafe webview attachment", {
				sourceUrl,
				partition: params.partition,
			});
			return;
		}

		params.src = sourceUrl;
		params.partition = BROWSER_PANEL_PARTITION;
		delete params.preload;
		delete params.preloadURL;
		delete params.allowfileaccess;
		delete params.allowpopups;

		webPreferences.partition = BROWSER_PANEL_PARTITION;
		webPreferences.sandbox = true;
		// 内置浏览器是第三方页面，同样不能被主进程的 384MB 档位锁住（#213）
		webPreferences.additionalArguments = rendererHeapAdditionalArguments();
		webPreferences.nodeIntegration = false;
		webPreferences.nodeIntegrationInWorker = false;
		webPreferences.nodeIntegrationInSubFrames = false;
		webPreferences.contextIsolation = true;
		webPreferences.webSecurity = true;
		webPreferences.allowRunningInsecureContent = false;
		webPreferences.webviewTag = false;
		delete webPreferences.preload;
		delete (webPreferences as Record<string, unknown>).preloadURL;
	});

	window.webContents.on("did-attach-webview", (_event, guest) => {
		// 宿主插件 guest：绑定到实例表并接管生命周期；未登记的实例立即关闭。
		const pluginBridge = hostPluginWebviewBridge();
		if (pluginBridge) {
			const hostPluginId = pluginBridge.instanceForGuest(guest);
			if (hostPluginId) {
				pluginBridge.attachGuest(hostPluginId, guest);
				return;
			}
		}
		if (guest.session !== browserPanelSession) {
			void appLogger.warn("browser", "Closed webview with unexpected session");
			guest.close();
			return;
		}

		// 浏览器 Agent 需要留住 guest 引用（快照/点击/截图）；
		// 抽屉收起/全屏切换会销毁重建 guest，registry 允许重复登记并在 destroyed 时清理。
		browserAgentService?.attachGuest(guest);

		const blockUnsafeNavigation = (event: { url: string; preventDefault(): void }, phase: string) => {
			if (isAllowedBrowserPanelUrl(event.url)) return;
			event.preventDefault();
			void appLogger.warn("browser", "Blocked unsafe webview navigation", {
				phase,
				url: event.url,
			});
		};

		guest.on("will-frame-navigate", (event) => blockUnsafeNavigation(event, "navigate"));
		guest.on("will-redirect", (event) => blockUnsafeNavigation(event, "redirect"));
		guest.setWindowOpenHandler(({ url }) => {
			if (url !== "about:blank" && isAllowedBrowserPanelUrl(url)) {
				void openExternalUrl(url);
			} else if (!isAllowedBrowserPanelUrl(url)) {
				void appLogger.warn("browser", "Blocked unsafe webview window open", { url });
			}
			return { action: "deny" };
		});

		// webview guest 是独立 webContents，按键到不了主窗口的 before-input-event；
		// 转发全局快捷键到主窗口：窗口缩放、DevTools 开关、打开设置（唤起窗口并广播），
		// 键位按用户配置匹配（见 appShortcuts.ts / shared/shortcuts.ts）。
		guest.on("before-input-event", (event, input) => {
			if (isShortcutInput("openSettings", input)) {
				event.preventDefault();
				if (!window || window.isDestroyed()) return;
				if (!window.isVisible()) window.show();
				window.webContents.send(ipcChannels.appOpenSettings);
				return;
			}
			// 窗口缩放：命中后直接改主窗口 zoomFactor 并持久化；仅回推新比例同步设置态
			if (handleWindowZoomShortcut(input)) {
				event.preventDefault();
				return;
			}
			// Ctrl(+Shift)+Tab 在网页内无既有含义（浏览器里它就是切宿主 tab），
			// 内置浏览器里同样切 PiDeck 会话标签页。
			if (isShortcutInput("cycleSessionTabs", input)) {
				event.preventDefault();
				if (!window || window.isDestroyed()) return;
				window.webContents.send(ipcChannels.appShortcutTriggered, "cycleSessionTabs");
				return;
			}
			if (isShortcutInput("cycleSessionTabsReverse", input)) {
				event.preventDefault();
				if (!window || window.isDestroyed()) return;
				window.webContents.send(ipcChannels.appShortcutTriggered, "cycleSessionTabsReverse");
				return;
			}
			// Cmd/Ctrl+W 关闭当前会话标签页：目标会话与「回答中先弹确认」由渲染层判定，主进程只命中广播。
			if (isShortcutInput("closeSessionTab", input)) {
				event.preventDefault();
				if (!window || window.isDestroyed()) return;
				window.webContents.send(ipcChannels.appShortcutTriggered, "closeSessionTab");
				return;
			}
			if (!isShortcutInput("toggleDevTools", input)) return;
			event.preventDefault();
			toggleMainWindowDevTools(window);
		});
	});
}

// 建窗所需宿主状态：单例与启动装配仍归本文件，建窗实现搬进 window/mainWindow.ts。
// 单例一律用 getter 传（settingsStore / appLogger / mainWindow 都是 let，建窗可能早于或晚于赋值）。
const mainWindowDeps: MainWindowDeps = {
	getSettings: () => settingsStore.get(),
	createWindowOptions: () => settingsStore.createWindowOptions(),
	getAppLogger: () => appLogger,
	getIsQuitting: () => isQuitting,
	setIsQuitting: (quitting) => {
		isQuitting = quitting;
	},
	setMainWindow: (window) => {
		mainWindow = window;
	},
	setMainWindowVisualIntent: (intent) => {
		mainWindowVisualIntent = intent;
	},
	getFloatingController: () => floatingController,
	isE2E,
	e2eWindowPlacement,
	isolateDevByGitBranch,
	devGitBranch,
	petEnabledAtLaunch,
	updateChannel,
	devDataMode,
	bootAnchorMs,
	quickTaskChrome,
	rendererCrashGuard,
	handleWindowZoomShortcut,
	prepareMainPreloadPath,
	openExternalUrl,
	configureBrowserPanelWebviewHost,
	shouldShowMainWindowImmediately,
	resolveStartupWindowBounds,
	applyStartupWindowMode,
	shouldUseDevRendererUrl,
	applyNativeThemeSource,
	printStartupInfo,
	trackMainWindowVisualIntent,
	rearmStandbyAgentOnFocus,
	syncSelectionToolShortcut,
	flushSelectionShortcutConflictNotice,
	flushPendingFocusTargetOnLoad,
};

/** 薄包装：调用点（首启 / 版本激活 / 通道切换）不变，实现见 window/mainWindow.ts。 */
async function createWindow(): Promise<void> {
	await createMainWindow(mainWindowDeps);
}

function shouldUseDevRendererUrl() {
	return is.dev && !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL);
}

function shouldShowMainWindowImmediately() {
	return isUsingLinuxXWaylandWorkaround(petEnabledAtLaunch);
}

/** 启动尺寸预设 → 初始窗口尺寸；全屏/最大化也给合理兜底，避免显示器信息异常时缩成最小窗。 */
function resolveStartupWindowBounds(mode: StartupWindowMode): {
	width: number;
	height: number;
} {
	switch (mode) {
		case "normal-compact":
			return { width: 1100, height: 720 };
		case "normal-medium":
			return { width: 1280, height: 840 };
		case "normal-large":
			return { width: 1480, height: 960 };
		case "maximized":
		case "fullscreen":
		default:
			return { width: 1480, height: 960 };
	}
}

/** 在窗口创建后应用启动尺寸预设；隐藏态先 maximize/fullscreen，减少首帧跳动。 */
function applyStartupWindowMode(window: BrowserWindow, mode: StartupWindowMode, showImmediately: boolean) {
	// E2E 静默：不 maximize/fullscreen，保持默认尺寸（1480x960）避免铺满屏遮挡用户
	if (isE2E) return;
	if (mode === "fullscreen") {
		// setFullScreen 在某些平台要求窗口已 show；隐藏态先 maximize 再在 show 后补全屏。
		if (showImmediately) {
			window.setFullScreen(true);
		} else {
			window.maximize();
			window.once("show", () => {
				if (!window.isDestroyed()) window.setFullScreen(true);
			});
		}
		return;
	}
	if (mode === "maximized") {
		window.maximize();
	}
}

// ===== 飞书桥接 IPC =====

/** 自动连接：启动时检查已保存的 Bot 配置，自动连接 */
async function autoConnectFeishu() {
	const bots = listBots();
	if (bots.length === 0) return;
	const bot = bots.find((b) => b.enabled);
	if (!bot) return;
	// 不再自动连接，由用户手动在配置页点击连接
	// 避免应用重启后静默恢复连接导致用户困惑
	void appLogger?.info("feishu", "Detected saved bot config, skipping auto connect", { bot: bot.name });
}

function currentMainProcessLocale(): MainProcessLocale {
	const language = settingsStore.get().language;
	if (language === "pseudo") return "en-US";
	return normalizeMainProcessLocale(language === "system" ? app.getLocale() : language);
}

/**
 * runtime 变更（安装 / 导入）后重启已运行的 DSH host。
 *
 * 为什么必须重启：host 进程是在 fork 时通过 `--dsh-node-modules` 拿到 runtime 路径的，
 * 之后路径就固化在那个进程里。装了新 runtime 而 host 还在跑，它用的仍是旧路径
 * （通常是 app 内置那份），用户会看到「装完了但行为没变」。
 *
 * 两个收敛点：
 * - host 没启动过就直接返回——此时用户没在用 DSH，不该为一次安装动作白起一个
 *   utilityProcess（约 200MB）。下次要用 DSH 时 ensureStarted 会自动用新 runtime fork。
 * - host 本来在跑说明用户在用 DSH，重启后要重新拉起，否则活跃会话静默失效。
 */
/**
 * 磁盘操作（runtime 安装/导入/卸载）前释放 DSH host 的文件锁。Windows 上 host 进程把
 * runtime 里的 .node 原生模块（如 koffi.node）映射成 DLL 句柄，进程存活时替换/删除
 * 同版本 runtime 目录必报 EPERM（文件被占用）。停活跃会话 + dispose host 释放锁。
 * 返回 host 原本是否在跑：操作结束后用 startDshHostAfterRuntimeDiskOperation 拉回。
 */
async function stopDshHostForRuntimeDiskOperation(): Promise<boolean> {
	const wasRunning = dshHost.isStarted() || dshHost.isHostProcessRunning();
	if (!wasRunning) return false;
	try {
		// 会话只在 boot 完成后才存在（isStarted 为真时停）；进程存活就 dispose。
		if (dshHost.isStarted()) await dshAgentManager.stopAll();
		await dshHost.restart();
	} catch (error) {
		// 停 host 失败不阻塞磁盘操作：rm 自带退避重试，锁仍在则返回结构化错误。
		void appLogger?.warn("dsh-runtime", "stop host before runtime disk operation failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	return wasRunning;
}

/**
 * DSH 后台预热是否允许：runtime 已安装可用，且用户没有手动停止过 host。
 *
 * 刻意不再要求 `defaultAgentBackend === "dsh"`：runtime 需要用户单独下载/安装（几十 MB），
 * 它出现在 userData 里本身就是「用户要用 DSH」的显式信号；host boot 实测约 20s，装了却
 * 不预热会让第一次打开 DSH 会话/配置页白等一轮 boot。只要装了、又没手动停过，就提前拉起。
 *
 * 内存取舍：host 常驻约 200MB。手动停止（dshManualStopped）优先级最高——用户表达过
 * 「不想让它运行」时一律不预热；runtime 未安装时不预热（boot 必然失败，白起进程）。
 */
function dshWarmupEnabled(): boolean {
	return dshRuntimeStatus.canCreateDshSession() && settingsStore.get().dshManualStopped !== true;
}

/**
 * 启动期 pi standby 预热（fire-and-forget）：把「首次新会话要付的完整 pi 启动」提前挪进
 * 应用启动/用户阅读历史的空窗。
 *
 * 为什么需要：一次 pi RPC 启动实测 8~25s（耗时几乎全在 pi 加载用户 npm 扩展），而现有
 * 预热只在草稿创建/激活完成之后触发——应用刚启动后从引导页发的第一条消息是「建草稿 +
 * 立刻发送」，standby 还没握手完，只能再 spawn 一个（实测两个 pi 进程并行冷启动，更慢）。
 * 这里按 catalog 最近活跃项目提前起一个待命进程。
 *
 * 触发条件收敛在 pickStandbyWarmupProject：默认后端 pi 取最近活跃项目，非 pi 默认只在
 * 近期确实用过 pi 时预热，避免纯 DSH/ACP 用户为用不到的能力常驻约 300MB。
 * 必须在 syncWslConfig 之后调用：WSL 项目的 spawn 参数依赖 agentManager 的 WSL 快照，
 * 抢跑会用错环境，认领时指纹不符又白起一个进程。
 * 失败一律只记日志：预热是启动期优化，绝不阻断启动。
 */
function warmStandbyAgentAtStartup(): void {
	try {
		if (settingsStore.get().standbyRuntimeEnabled === false) return;
		// 已有 pi 会话正在启动时让路：并行 spawn 会互相拖慢（磁盘/CPU 竞争），而且该会话激活
		// 结束后自己的链路还会补热一个 standby。
		if (agentManager.list().some((tab) => tab.status === "starting")) return;
		const target = pickStandbyWarmupProject({
			entries: sessionCatalog.listEntries(),
			projectIds: new Set(projectStore.list().map((project) => project.id)),
			defaultBackend: settingsStore.get().defaultAgentBackend,
			now: Date.now(),
		});
		if (!target) return;
		void appLogger?.info("agent", "Startup standby warmup requested", { projectId: target });
		agentManager.ensureStandbyAgent(target);
	} catch (error) {
		void appLogger?.warn("agent", "Startup standby warmup target resolution failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

// 聚焦补热节流状态：上次触发时刻（0=从未）。窗口每次聚焦都会喊一次，
// 但补热本身只在池空/指纹过期时才真正 spawn（ensure 幂等），节流只为压日志噪音。
let lastStandbyFocusRewarmAt = 0;
const STANDBY_FOCUS_REWARM_INTERVAL_MS = 60_000;

/**
 * 窗口聚焦触发的 standby 补热（节流）：池条目 10min TTL 过期后，用户「离开一阵
 * 再回来开新会话」要吃满一次 8~25s 冷启动；聚焦是「马上又要用」的强信号，趁用户
 * 浏览/输入的空窗后台补一个待命进程。目标推断/让路判定复用启动期预热同一条路径。
 */
function rearmStandbyAgentOnFocus(): void {
	const now = Date.now();
	if (now - lastStandbyFocusRewarmAt < STANDBY_FOCUS_REWARM_INTERVAL_MS) return;
	lastStandbyFocusRewarmAt = now;
	warmStandbyAgentAtStartup();
}

/**
 * DSH host 手动停止（用户显式动作，IPC dsh:stop-host）：
 * 1. 先写 settings.dshManualStopped = true 再停——顺序保证「停止意图」优先落地：
 *    即使 stopAll/dispose 中途失败，自动拉起路径也已经全部被门控住；
 * 2. 停掉所有活跃 DSH 会话（与 DSH_HOME 切换同一链路，避免旧 mux 悬挂）；
 * 3. dispose host（utilityProcess 退出，释放 ~200MB 与 DSH_HOME 文件锁）。
 * 返回停进程是否顺利完成（标记写入与否不影响返回值语义——门控已生效）。
 */
async function stopDshHostManually(): Promise<boolean> {
	// 先持久化停止意图：后续任何 ensureStarted（含并发在途调用）都会被拒。
	await settingsStore.update({ dshManualStopped: true });
	try {
		if (dshHost.isStarted()) await dshAgentManager.stopAll();
		await dshHost.restart();
		return true;
	} catch (error) {
		void appLogger?.warn("dsh-host", "manual stop: stopAll/dispose failed", {
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

/**
 * DSH host 显式启动（用户显式动作，IPC dsh:start-host）：清除手动停止标记后 boot。
 * 必须先清标记再 boot——DshHost 的启动门控按 settings 实时读取。
 * 返回 host 是否真正就绪（boot 完成），渲染层据此刷新状态徽标。
 */
async function startDshHostManually(): Promise<boolean> {
	await settingsStore.update({ dshManualStopped: false });
	return dshHost.startManually();
}

async function startDshHostAfterRuntimeDiskOperation(wasRunning: boolean): Promise<void> {
	if (!wasRunning) return;
	try {
		await dshHost.ensureStarted();
	} catch (error) {
		void appLogger?.warn("dsh-runtime", "restart host after runtime disk operation failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function mainCopy(key: MainProcessTranslationKey, params?: Record<string, string | number>): string {
	return mainProcessT(currentMainProcessLocale(), key, params);
}

/**
 * 桌面通知的统一依赖（门控/toast/点击跳转在 notifications/agentToast.ts）。
 * pi 在 AgentManager 内部用同一份 showAgentToast；ACP/DSH 与「非 pi 完成」订阅走这里。
 * 每次调用现取：settingsStore / mainWindow 都是后段装配，不能在模块顶层快照。
 */
function agentToastDeps(): AgentToastDeps {
	return {
		settings: () => settingsStore.get(),
		getWindow: () => mainWindow,
		logoUri: () => resolveNotificationLogoUri({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }),
		translate: (key, params) => mainCopy(key, params),
		activate: (sessionId) => {
			focusMainWindow();
			if (sessionId) queueFocusTarget({ sessionId });
		},
		logger: appLogger,
	};
}

/**
 * 把 DSH runtime 导入/安装的内部错误码翻译为用户可读文案。
 * 错误码是 DshRuntimeManager.verifyStagedRuntime 的返回值契约（tests 亦断言裸码），
 * 因此这里只做「码 → 文案」映射，不修改下层返回值。
 */
function dshRuntimeErrorCopy(error: string): string {
	if (error.startsWith(DSH_RUNTIME_VERSION_UNAVAILABLE_PREFIX)) {
		// 错误码格式由 DshRuntimeInstaller 固定：`required=<版本> available=<版本,版本>`。
		const detail = /^required=(?<required>.*?) available=(?<available>.*)$/.exec(error.slice(DSH_RUNTIME_VERSION_UNAVAILABLE_PREFIX.length));
		return mainCopy("dsh.runtime.errors.runtimeVersionUnavailable", {
			required: detail?.groups?.required ?? "",
			available: (detail?.groups?.available ?? "").split(",").filter(Boolean).join("、"),
		});
	}
	if (error === "manifest missing") return mainCopy("dsh.runtime.errors.manifestMissing");
	if (error === "manifest unreadable") return mainCopy("dsh.runtime.errors.manifestUnreadable");
	if (error === "manifest schema unsupported") return mainCopy("dsh.runtime.errors.schemaUnsupported");
	if (error === "app version incompatible") return mainCopy("dsh.runtime.errors.appIncompatible");
	if (error === "node_modules missing") return mainCopy("dsh.runtime.errors.nodeModulesMissing");
	if (error.startsWith("required package missing: "))
		return mainCopy("dsh.runtime.errors.requiredPackageMissing", {
			pkg: error.slice("required package missing: ".length),
		});
	if (error === "directory not found" || error === "cancelled") return error;
	return error;
}

function sessionCommandIpcError(error: SessionCommandError): SessionCommandIpcError {
	if (error.debugDetails) {
		void appLogger?.warn("session-command", "Session command failed", {
			code: error.code,
			debugDetails: error.debugDetails,
		});
	}
	return new SessionCommandIpcError(error, mainCopy);
}

function currentFeishuLocale(): FeishuLocale {
	return normalizeFeishuLocale(currentMainProcessLocale());
}

async function sendAgentPromptWithIntegrations(input: SendPromptInput): Promise<SendPromptResult> {
	// 多后端路由：非 pi 后端（dsh/未来新增后端）不经过 pi 专属的飞书/扩展链路，
	// 按 agentId 交给合成网关路由到所属后端网关（pi 后端继续走下方集成链路）。
	const gateway = compositeAgentGateway;
	const agentTab = gateway?.list().find((item) => item.id === input.agentId);
	if (gateway && agentTab && agentTab.backend !== "pi") {
		return gateway.sendPrompt(input);
	}
	const bridge = feishuBridgeRef.current;
	const bridgeConnected = bridge?.getStatus().status === "connected";
	const hasFeishuBinding = bridgeConnected && bridge.hasSessionBinding(input.agentId);
	const docTitle = bridgeConnected ? wantsFeishuDoc(input.message) : undefined;
	const sessionChatId = bridgeConnected ? bridge.getSessionChatId(input.agentId) : undefined;
	let agentInstruction: string | undefined;
	const buildFeishuActionInstruction = (chatId?: string) =>
		[
			"当前会话已连接飞书聊天。严禁调用 lark-cli、飞书 IM API 或搜索群聊来发送文件；不要询问 chat_id。需要把本地文件发到当前飞书聊天时，最终回答末尾独立一行写 [SEND_FILE:本地文件路径]，PiDeck 会按当前会话绑定自动上传。",
			chatId ? `当前绑定的飞书 chat_id: ${chatId}。这是只读上下文，用于确认当前会话绑定；发送文件仍必须用 [SEND_FILE:本地文件路径]。` : undefined,
		]
			.filter(Boolean)
			.join("\n");

	if (bridgeConnected && hasFeishuBinding) {
		const filePath = resolveFeishuFileSendIntent(input.message, agentManager.getCwd(input.agentId));
		if (filePath) {
			const result = await bridge.sendFileForSession(input.agentId, filePath);
			agentManager.recordHostExchange(input.agentId, input.message, result);
			void appLogger.info("feishu", "File sent through current session binding", {
				agentId: input.agentId,
				filePath,
				success: result.startsWith("✅"),
			});
			return { accepted: true };
		}
	}

	if (bridgeConnected && docTitle && !hasFeishuBinding) {
		const tab = agentManager.list().find((item) => item.id === input.agentId);
		if (tab) {
			await bridge.ensureSessionMirror(tab.id, tab.title, tab.sessionPath).catch((error) => {
				void appLogger?.error("feishu", "Auto-bind session mirror failed", { error: error instanceof Error ? error.message : String(error) });
			});
			bridge.trackDocRequest(tab.id, docTitle);
			void bridge.forwardUserMessageToFeishu(tab.id, input.message).catch((error) => {
				void appLogger?.error("feishu", "Forward PiDeck message failed", { error: error instanceof Error ? error.message : String(error) });
			});
			agentInstruction = `${buildFeishuActionInstruction(bridge.getSessionChatId(tab.id))}\n创建飞书文档时，先输出完整正文，最后独立一行写 [CREATE_DOC:文档标题]。`;
		}
	} else if (hasFeishuBinding) {
		agentInstruction = buildFeishuActionInstruction(sessionChatId);
		const tab = agentManager.list().find((item) => item.id === input.agentId);
		if (tab) {
			void bridge.startSessionMirrorRun(tab.id, tab.title, tab.sessionPath).catch((error) => {
				void appLogger?.error("feishu", "Session mirror card init failed", { error: error instanceof Error ? error.message : String(error) });
			});
			if (input.message.trim()) {
				void bridge.forwardUserMessageToFeishu(tab.id, input.message).catch((error) => {
					void appLogger?.error("feishu", "Forward PiDeck message failed", { error: error instanceof Error ? error.message : String(error) });
				});
			}
		}
	}
	const result = await agentManager.sendPrompt(agentInstruction ? { ...input, agentMessage: `${agentInstruction}\n\n${input.message}` } : input);
	void appLogger.info("agent", "Prompt sent", {
		agentId: input.agentId,
		messageLength: input.message.length,
		imageCount: input.images?.length ?? 0,
		streamingBehavior: input.streamingBehavior,
	});
	return result;
}

/**
 * 内置扩展磁盘根：随包分发目录 + userData 覆盖层（热更新落点）。
 *
 * 三处调用点必须同源（ExtensionManager 列表/版本、热更新器写盘、-e 注入路径解析），
 * 各拼一次路径迟早会漂移成「更新成功但会话仍加载旧扩展」，故统一走这里。
 * 须在 app ready 后调用（app.getPath("userData") 此时才反映 dev 隔离目录）。
 */
function resolveBuiltInExtensionRoots(): BuiltInExtensionPathRoots {
	return {
		appPath: app.getAppPath(),
		resourcesPath: process.resourcesPath,
		isDev: !app.isPackaged,
		overlayDir: resolveBuiltInExtensionsOverlayDir(app.getPath("userData")),
	};
}

/**
 * 一次补全侧车（pi-enhance-host）实例的公共装配：提示词增强 / 智能体调用 / 输入预测各自
 * 一个独立进程（EnhancePromptService 的单飞语义是「新 run 打断旧 run」，共用实例会互相打断）。
 * resolveLaunch 现求值：用户改自定义 pi 路径后下次调用即生效，无需重启。
 */
function createCompletionHelperService(namespace: "enhance" | "agent-invoke" | "suggest" | "agent-memory"): EnhancePromptService {
	const log = (level: "debug" | "info" | "warn" | "error", message: string) => void appLogger?.[level](namespace, message);
	return new EnhancePromptService({
		// 侧车是常驻单进程，env 在 spawn 时固定，所以代理只能在这里落地：
		// 把本次要用的模型交给启动参数解析，按与 pi 会话同一套名单语义决定要不要走代理；
		// 换模型或改代理设置后启动指纹变化，服务会重建进程而不是沿用旧出口。
		resolveLaunch: (run) => {
			const settings = settingsStore.get();
			return resolvePiAuthHostLaunch({
				settings,
				proxyModel: run,
				locator: piLocator as PiLocator,
				userDataPath: app.getPath("userData"),
				appPath: app.getAppPath(),
				resourcesPath: process.resourcesPath,
				isPackaged: app.isPackaged,
				helperFilename: PI_ENHANCE_HOST_FILENAME,
			});
		},
		logger: {
			debug: (message) => log("debug", message),
			info: (message) => log("info", message),
			warn: (message) => log("warn", message),
			error: (message) => log("error", message),
		},
	});
}

/** 读 pi settings.json 的 skills / prompts / extensions 条目；读不出来返回 null（投影降级为无规则）。 */
async function readNativeEntries(key: "skills" | "prompts" | "extensions"): Promise<string[] | null> {
	try {
		const file = await readPiConfigFile(join(configManager.getConfigDir(), "settings.json"));
		const value = file.data[key];
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return null;
	}
}

/** 刷新技能/模板状态投影缓存（迁移完成、用户切开关、或设置里切换 WSL 环境后调用）。 */
async function refreshSkillProjection(): Promise<void> {
	skillManagerNativeEntries = await readNativeEntries("skills");
}

async function refreshPromptProjection(): Promise<void> {
	promptManagerNativeEntries = await readNativeEntries("prompts");
}

async function refreshExtensionProjection(): Promise<void> {
	try {
		const file = await readPiConfigFile(join(configManager.getConfigDir(), "settings.json"));
		const extensions = file.data.extensions;
		const packages = file.data.packages;
		extensionManagerNativeEntries = Array.isArray(extensions) ? extensions.filter((item): item is string => typeof item === "string") : [];
		extensionManagerNativePackages = Array.isArray(packages) ? [...packages] : [];
	} catch {
		extensionManagerNativeEntries = null;
		extensionManagerNativePackages = null;
	}
}

/**
 * 全局 WSL 模式（设置 → 开发 → Pi 来源）。
 *
 * 把会话扫描、Agent/DSH spawn、技能/提示词/扩展/配置目录一起切到发行版 HOME，关闭时切回 Windows。
 * 启动时执行一次；设置保存时由 settingsUpdate → applyWslSettings 重放，切换无需重启。
 */
async function syncWslConfig(): Promise<void> {
	const { wslEnabled, wslDistro, wslUser } = settingsStore.get();
	if (wslEnabled && wslDistro && wslUser) {
		const { resolveWslEnvironment } = await import("./wsl/WslEnvironment");
		const wslEnv = await resolveWslEnvironment(wslDistro, wslUser, {
			warn: (msg: string, detail: unknown) => void appLogger?.warn("wsl", String(msg), { detail }),
		});
		await sessionScanner.configureWsl(wslEnv);
		agentManager.configureWsl(wslEnv);
		// DSH host 是 Windows 原生进程：WSL 项目的 workspace 路径与会话目录编码
		// 都要按主机路径算，否则 workspace.resolve 失败、会话建不出来。
		dshHost.configureWsl(wslEnv);
		skillManager.configureWsl(wslEnv);
		promptManager.configureWsl(wslEnv);
		extensionManager.configureWsl(wslEnv);
		// 配置/雪提示词管理器在装配后段才实例化：启动早期同步时可能还没有，跳过即可。
		if (configManager) configManager.configureWsl(wslEnv);
		if (xuePromptManager) xuePromptManager.configureWsl(wslEnv);
		// 窗口已起来后再异步探测 WSL which，点会话时 resolveCommand 才能命中 wsl:// 缓存。
		void piLocator.warmWslCommand(wslDistro, wslUser).catch((error: unknown) => {
			void appLogger?.warn("app", "WSL pi which warmup failed", error);
		});
	} else {
		sessionScanner.clearWsl();
		agentManager.configureWsl(null);
		dshHost.configureWsl(null);
		skillManager.configureWsl(null);
		promptManager.configureWsl(null);
		extensionManager.configureWsl(null);
		if (configManager) configManager.configureWsl(null);
		if (xuePromptManager) xuePromptManager.configureWsl(null);
	}
	// 原生过滤投影取自 <config dir>/settings.json：目录换了一套就必须重读，
	// 否则开关显示的还是旧用户那份设置（切换 WSL 用户后点开关会写错文件）。
	await Promise.all([refreshSkillProjection(), refreshPromptProjection(), refreshExtensionProjection()]);
}

function registerIpc() {
	// 远端能力与更新通道正交：正式包和 dev 包都装配；同一策略位由
	// update:get-channel 的 remoteAvailable 下发给渲染层，避免主/渲染判据漂移。
	// 各远端 IPC 仍保留 enabled=false 的 fail-closed 分支，供测试和后续下线策略使用。
	const { getRemoteHostService, remoteFeatureEnabled, remoteGitReads, remoteHostServiceIfEnabled, remoteProjectEntries, remoteProjectIpc, remoteProjectTextPort, remoteProjectTransfers, runPinnedRemoteCommand } = registerRemoteStack({
		agentManager,
		getMainWindow: () => mainWindow,
		getPiResourcePool: () => piResourcePool,
		getRemoteCommandTransport: () => remoteCommandTransport,
		getRemoteTerminalManager: () => remoteTerminalManager,
		projectStore,
		quitCleanup,
		resolveBuiltInExtensionRoots,
		sessionCatalog,
		setRemoteCommandTransport: (value) => {
			remoteCommandTransport = value;
		},
		setRemoteHostRebindIpc: (value) => {
			remoteHostRebindIpc = value;
		},
		setRemoteHostServiceResolver: (value) => {
			remoteHostServiceResolver = value;
		},
		setRemoteProjectTrustService: (value) => {
			remoteProjectTrustService = value;
		},
		settingsStore,
	});
	// 用量统计：业务在 UsageStatsService，handler 薄层只校验/适配
	registerAgentsStack({
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
		getIsQuitting: () => isQuitting,
		setIsQuitting: (value) => {
			isQuitting = value;
		},
		linkedSessionService,
		linkedSessionStore,
		getMainWindow: () => mainWindow,
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
	});
	// Desktop plugins run without AgentManager/RPC; failure leaves the rest of PiDeck untouched.
	// 项目显示名闭包在面板挂载时才求值：此处 projectStore 尚未装配。
	// 本地服务（宿主插件可按名启停 + 开内置浏览器）：适配器与命令全在主进程，插件只能点名。
	registerHostServicesStack({
		acpAgentManager,
		agentManager,
		agentProfileStore,
		appLogger,
		automationRunCoordinator,
		automationStore,
		setCleanupPasteFiles: (value) => {
			cleanupPasteFiles = value;
		},
		favoritesStore,
		gitService,
		mainCopy,
		getMainWindow: () => mainWindow,
		piLocator,
		projectResourceManager,
		projectStore,
		quitCleanup,
		resolveBuiltInExtensionRoots,
		resourceImportManager,
		securityStore,
		sessionCatalog,
		sessionGroupStore,
		sessionRuntimeCoordinator,
		settingsStore,
		worktreeService,
		remoteHostService: getRemoteHostService(),
		remoteProjectIpc,
		remoteProjectTransfers,
	});

	// 视觉桥配置（~/.pi/agent/pi-deck-vision.json）界面化编辑；运行时由 pi-deck-vision 扩展消费
	const { imageSessionStore } = registerMediaStack({
		getAcpImageBlobStore: () => acpImageBlobStore,
		setAcpImageBlobStore: (value) => {
			acpImageBlobStore = value;
		},
		agentManager,
		appLogger,
		configManager,
		mainCopy,
		getMainWindow: () => mainWindow,
		piLocator,
		projectStore,
		quitCleanup,
		resolveImageGenStorageRoots,
		sessionCatalog,
	});
	const { readRemoteSessionHistoryPage, remotePiModelCatalog, remoteModelCatalogForProject, exportRemoteCatalogSessionHtml, remoteSessionArchive, remoteSessionDelete, videoSessionStore } = registerMediaSessionStack({
		agentManager,
		appLogger,
		dshAgentManager,
		mainCopy,
		getMainWindow: () => mainWindow,
		projectStore,
		remoteCommandTransport,
		setRemoteSessionMessageMutation: (value) => {
			remoteSessionMessageMutation = value;
		},
		resolveSessionExportDir,
		resolveVideoGenStorageRoots,
		sessionCatalog,
		remoteFeatureEnabled,
		remoteHostServiceIfEnabled,
		runPinnedRemoteCommand,
	});
	registerSessionsStack({
		// 会话 ↔ 智能体绑定：绑定的会话每次发送注入角色设定（pi/acp 隐藏 agentMessage，
		// dsh 退化为可见前缀，由 sessionIpc 的 composeAgentInstruction 统一组合）。
		acpAgentManager,
		agentManager,
		agentProfileStore,
		appLogger,
		codebuddySessionImporter,
		claudeSessionImporter,
		codexSessionImporter,
		configManager,
		copyCatalogSession,
		createAnonymousSession,
		cursorSessionImporter,
		directorySessionImporter,
		dshAgentManager,
		dshHost,
		dshRuntimeErrorCopy,
		emitReplacementState,
		emitSessionActivating,
		emitSessionActivationCancelled,
		emitSessionActivationFailed,
		emitSessionRuntimeDetach,
		emitSessionRuntimeEvent,
		exportCatalogSessionHtml,
		exportRemoteCatalogSessionHtml,
		foreignSyncDeps,
		getDshPluginInstallService: () => dshPluginInstallService,
		getDshRuntimeInstaller: () => dshRuntimeInstaller,
		getDshRuntimeStatus: () => dshRuntimeStatus,
		getDshSessionSkillLoader,
		getMainWindow: () => mainWindow,
		getSessionIndexService: () => sessionIndexService,
		imageSessionStore,
		kimiSessionImporter,
		kimiWorkSessionImporter,
		mainCopy: mainCopy as (key: string, params?: Record<string, string | number>) => string,
		minimaxSessionImporter,
		notifyCatalogRefreshed,
		openCodeSessionImporter,
		projectPathsForContentSearch,
		projectStore,
		qoderSessionImporter,
		readCatalogSessionReferenceMessages,
		readRemoteSessionHistoryPage,
		remoteSessionArchive,
		remoteSessionDelete,
		replaceAgentSession,
		resolveWslSessionScanner: (identity) => wslSessionScannerFor(identity),
		resolveSessionAgentInstruction: (sessionId) => agentProfileStore?.getBoundAgent(sessionId)?.systemPrompt,
		runDshForeignSync,
		sessionCatalog,
		sessionForkCommands,
		sessionMessageSearchInFile,
		sessionRuntimeCoordinator,
		sessionScanner,
		settingsStore,
		startDshHostAfterRuntimeDiskOperation,
		startDshHostManually,
		stopDshHostForRuntimeDiskOperation,
		stopDshHostManually,
		stopSessionRuntime,
		terminalManager,
		validationCatalogModels,
		videoSessionStore,
		visibleSessions,
		workbuddySessionImporter,
		wslSessionScannerFor,
		zcodeSessionImporter,
	});

	startPrewarm({
		appLogger,
		getExtensionManager: () => extensionManager,
		getSessionScanner: () => sessionScanner,
		projectStore,
		sessionCatalog,
		settingsStore,
		wslSessionScannerFor,
	});

	registerGitStack({
		appLogger,
		mainCopy: mainCopy as (key: string, params?: Record<string, string | number>) => string,
		gitService,
		gitRefsWatcher: gitRefsWatcher,
		getMainWindow: () => mainWindow,
		piLocator,
		projectStore,
		settingsStore,
		worktreeService,
		remoteGitReads,
	});

	// Phase 3.7 拆出 systemIpc 后这些可选依赖必须显式注入；
	// 漏传 extensionManager 会导致 pi:update-check / pi:update 根本不注册。
	if (!piModelCapabilityCache) throw new Error("Pi model capability cache is unavailable after settings load");
	// 更新服务、模型目录与内置扩展三件套整体搬到 startup/appUpdate.ts：交付模式分支与
	// `updateService` 的唯一 owner 回填都在那里，这里原位调用，构造与 start() 顺序不变。
	const { catalogUpdater, builtInExtensionsUpdater } = startAppUpdate({
		appLogger,
		getExtensionManager: () => extensionManager,
		getIsQuitting: () => isQuitting,
		getMainWindow: () => mainWindow,
		resolveBuiltInExtensionRoots,
		setIsQuitting: (value) => {
			isQuitting = value;
		},
		settingsStore,
		updateChannel,
		assign: (patch) => {
			if (patch.updateService !== undefined) updateService = patch.updateService;
		},
	});
	registerContentStack({
		appLogger,
		builtInExtensionsUpdater,
		catalogUpdater,
		getUpdateService: () => updateService,
		settingsStore,
	});
	// TokenDance 目录 store 是共享实例：渲染层目录展示与一键安装（写入配置）读同一份缓存。
	const tokendanceCatalogStore = new TokendanceCatalogStore({
		getCachePath: () => join(app.getPath("userData"), "tokendance-models.json"),
		log: (message, detail) => void appLogger.info("tokendance", message, detail),
	});
	// TokenDance 公开报价 → 模型折扣/免费徽章（选择器展示用）。独立缓存文件：报价端点与
	// 网关 /models 不是同一个源，刷新/失败不应互相牵连；拿不到价格时徽章整体缺席。
	const tokendancePricingStore = new TokendancePricingStore({
		getCachePath: () => join(app.getPath("userData"), "tokendance-pricing.json"),
		log: (message, detail) => void appLogger.info("tokendance", message, detail),
	});
	/**
	 * Phase 5 remote config scope (Batch A): every ssh target is one ready host's helper request. The host is
	 * resolved through the same service the rest of the remote surface uses, so a disconnected/replaced host
	 * fails closed with HOST_NOT_READY instead of reading anything local. Batch B adds the renderer selector; this
	 * batch only routes and validates.
	 */
	const remotePiConfig = remoteFeatureEnabled
		? createRemotePiConfigBackend({
				request: async (hostId, method, params) => {
					const pending = remoteHostServiceIfEnabled();
					if (pending === undefined) throw new Error("REMOTE_CONFIG_UNAVAILABLE");
					const service = await pending;
					return service.request(hostId, method, params, { timeoutMs: 15_000 });
				},
			})
		: undefined;

	// 「请作者喝咖啡」按次付费：桌面端只调自家边缘代理（平台服务端 Key 在代理里，不进客户端）。
	// 用户标识首次查询时生成并落盘；并发首查共用一个 Promise，避免生成两个 ID 把余额拆到两处。
	let watchaUserIdPromise: Promise<string> | undefined;
	const resolveWatchaUserId = () => {
		watchaUserIdPromise ??= (async () => {
			const existing = settingsStore.get().watchaUserId;
			if (existing) return existing;
			const created = randomUUID();
			await settingsStore.update({ watchaUserId: created });
			return created;
		})();
		return watchaUserIdPromise;
	};
	registerSystemStack({
		agentManager,
		appLogger,
		applyNativeThemeSource,
		configManager,
		createAgentMemoryMount,
		getCuaService: () => cuaService,
		currentFeishuLocale,
		devGitBranch,
		diagnosticsMonitor,
		dshAgentManager,
		dshHost,
		dshRuntimeManager,
		environmentDoctor,
		extensionManager,
		feishuBridgeRef,
		getIsQuitting: () => isQuitting,
		setIsQuitting: (value) => {
			isQuitting = value;
		},
		isolateDevByGitBranch,
		logBundleExporter,
		mainCopy,
		getMainWindow: () => mainWindow,
		openExternalUrl,
		getPetSystem: () => petSystem,
		piLocator,
		piModelCapabilityCache,
		piResourcePool,
		projectResourceManager,
		projectStore,
		refreshTrayContextMenu: () => refreshTrayContextMenu(trayDeps),
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
		getTray,
		updateService,
		webServiceManager,
		remoteModelCatalogForProject,
		remotePiConfig,
		remotePiModelCatalog,
		resolveWatchaUserId,
		tokendanceCatalogStore,
		tokendancePricingStore,
	});

	registerPlatformStack({
		appLogger,
		broadcastCloudSyncStateChanged,
		cloudSyncManager,
		configBackupManager,
		configManager,
		extensionManager,
		fileIndexService,
		fileSystemService,
		gitService,
		mainCopy,
		getMainWindow: () => mainWindow,
		openExternalUrl,
		piModelCapabilityCache,
		piResourcePool,
		projectResourceManager,
		projectStore,
		promptManager,
		quitCleanup,
		remoteAccessManager,
		getRemoteTerminalManager: () => remoteTerminalManager,
		setRemoteTerminalManager: (value) => {
			remoteTerminalManager = value;
		},
		sessionCatalog,
		sessionCommandIpcError,
		sessionRuntimeCoordinator,
		settingsStore,
		skillManager,
		terminalManager,
		xuePromptManager,
		remoteHostServiceIfEnabled,
		remoteProjectEntries,
		remoteProjectIpc,
		remoteProjectTextPort,
	});
	// registerQuickTaskIpc 移至 floating/mini-overlay 装配处（依赖 expandMiniOverlay 做模式互切）。
}

function sendTelemetryHeartbeat() {
	const telemetry = new TelemetryService({
		settingsStore,
		config: {
			projectKey: POSTHOG_PROJECT_KEY,
			host: POSTHOG_HOST,
		},
		metadata: {
			appVersion: app.getVersion(),
			platform: process.platform,
			arch: process.arch,
			packaged: app.isPackaged,
		},
		// 匿名快照：功能开关状态与规模计数，不碰路径/项目名/内容/凭据（口径见设置页遥测文案）
		snapshot: () =>
			collectTelemetrySnapshot({
				settings: settingsStore.get(),
				sessionsTotal: sessionCatalog.listEntries().length,
				projectsTotal: projectStore.list().length,
				agentsActive: agentManager.list().length,
				feishuBotsTotal: listBots().length,
				automationTasksTotal: automationStore?.listTasks().length ?? 0,
				systemLocale: app.getLocale(),
				portable: Boolean(process.env.PORTABLE_EXECUTABLE_DIR),
				uptimeMs: process.uptime() * 1000,
				osRelease: osRelease(),
			}),
		capture: async (request) => {
			const response = await net.fetch(request.url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(request.body),
			});
			if (!response.ok) {
				throw new Error(`Telemetry request failed: ${response.status}`);
			}
		},
	});

	void telemetry.sendHeartbeat().catch(() => undefined);
}

async function detectExternalEditorsOnFirstLaunch() {
	const current = settingsStore.get().externalEditors;
	if (Object.values(current).some((editor) => editor.command)) return;
	const detected = await detectExternalEditors();
	if (detected.length === 0) return;
	await settingsStore.update({
		externalEditors: mergeDetectedExternalEditors(current, detected),
	});
	void appLogger.info("editor", "External editors detected on first launch", { count: detected.length });
}

// 换肤背景图/宠物雪碧图/声音提醒/生图历史图片协议：自定义 scheme 必须在 ready 前注册特权声明（secure 以便渲染层 CSS/图片/音频引用）
protocol.registerSchemesAsPrivileged([
	{ scheme: "pideck-plugin", privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: false } },
	// Wallpaper Engine 视频壁纸：stream:true 让 <video> 走 Range 流式读取，不整块进内存
	{ scheme: "pideck-we", privileges: { secure: true, standard: true, corsEnabled: false, supportFetchAPI: true, stream: true } },
	{ scheme: "pideck-bg", privileges: { secure: true, standard: true, corsEnabled: false, supportFetchAPI: true, stream: false } },
	{ scheme: "pideck-pet", privileges: { secure: true, standard: true, corsEnabled: false, supportFetchAPI: true, stream: false } },
	{ scheme: "pideck-sound", privileges: { secure: true, standard: true, corsEnabled: false, supportFetchAPI: true, stream: true } },
	// 生图历史图片：渲染层 <img> 直接加载落盘 blob，避免把 base64 搬回渲染进程堆
	{ scheme: "pideck-img", privileges: { secure: true, standard: true, corsEnabled: false, supportFetchAPI: true, stream: true } },
	// 对话内本地图片（Markdown 正文引用白名单目录内的图片）：替代 file://，dev 与打包行为一致
	{ scheme: "pideck-file", privileges: { secure: true, standard: true, corsEnabled: false, supportFetchAPI: true, stream: true } },
	// 文件预览的 HTML：内容编码在 URL 里，CSP 由主进程响应头下发，与主窗口策略解耦（#377）
	{ scheme: "pideck-html", privileges: { secure: true, standard: true, corsEnabled: false, supportFetchAPI: false, stream: false } },
]);

app
	.whenReady()
	.then(async () => {
		// 未拿到同版本主实例锁时不要继续初始化，避免第二进程短暂闪窗。
		if (!gotSingleInstanceLock) return;

		// Windows 的进程环境块是启动快照：用户在 PiDeck 开着的时候装了 CLI（官网脚本只改注册表 PATH，
		// 如 %USERPROFILE%\.qoder-cn\bin\qoderclicn），已运行的进程里 spawn 出去只会回
		// 「不是内部或外部命令」。开机刷一次，设置页点「检测」时还会再刷（见 acpIpc）。
		void ensureWindowsPathFresh({
			onAdded: (directories) => void appLogger?.info("app", "Windows PATH refreshed from registry", { added: directories }),
		});

		// 引用写入门（INV-1 / INV-12 写入侧）：远端项目与会话登记前复查 hostId 仍能解析到 profile、
		// 且没有跨 store rebind 事务在跑。门自己读 remote-hosts.json，不依赖主进程缓存；构造本身不做 I/O。
		const referenceWriteGuard = createRemoteReferenceWriteGuard({ userDataDir: app.getPath("userData") });
		// 平台服务骨架（项目表 / 文件 / 会话扫描 + 11 个外部会话导入器 / 设置 / 安全 / 日志 /
		// 用量 / Git / pi 定位与认证 / 增强三侧车 / pi 配置与备份）整体搬到 startup/services.ts：
		// 这里原位调用，构造顺序与退出清理登记次序不变。
		({
			projectStore,
			fileSystemService,
			sessionScanner,
			codexSessionImporter,
			claudeSessionImporter,
			qoderSessionImporter,
			openCodeSessionImporter,
			zcodeSessionImporter,
			workbuddySessionImporter,
			codebuddySessionImporter,
			cursorSessionImporter,
			kimiSessionImporter,
			kimiWorkSessionImporter,
			minimaxSessionImporter,
			directorySessionImporter,
			settingsStore,
			securityStore,
			appLogger,
			rpcLogger,
			usageStatsService,
			gitService,
			gitRefsWatcher,
			worktreeService,
			piLocator,
			piAuthService,
			enhancePromptService,
			promptSuggestionService,
			agentMemoryLearnService,
			configManager,
			configBackupManager,
		} = startCoreServices({
			mainCopy,
			createCompletionHelperService,
			quitCleanup,
			referenceWriteGuard,
			bootAnchorMs,
			updateChannel,
			userDataNameMigrationResult,
			devDirectoryMigration,
			getMainWindow: () => mainWindow,
			getSessionCatalog: () => sessionCatalog,
			getRemoteHostServiceResolver: () => remoteHostServiceResolver,
			getWebServiceManager: () => webServiceManager,
		}));
		promptManager = new PromptManager(undefined, mainCopy);
		// 注入旧禁用列表读写（原生服务未装配时的兜底通道；迁移后为空，仅兼容读取）。
		promptManager.configureSettings(
			() => settingsStore.get(),
			(patch) => settingsStore.update(patch),
		);
		// 原生配置接线（A4）：模板开关写 pi settings.json 精确规则，列表状态按原生条目投影。
		promptManager.configureNativeToggle(async (templatePath, enabled) => {
			const service = piResourceConfigService;
			if (!service) return { ok: false, error: "pi resource service unavailable" };
			const saved = await service.setFileResourceEnabled({ scope: { scope: "global" }, kind: "prompts", resourceId: templatePath, enabled });
			if (saved.ok) await refreshPromptProjection();
			return saved;
		});
		promptManager.configureNativeEnabledReader((templatePath) => {
			const entries = promptManagerNativeEntries;
			if (!entries) return undefined;
			return projectResourceEnabled({ entries, value: templatePath, baseDir: dirname(templatePath) });
		});
		// 项目作用域：模板开关写项目 `.pi/settings.json` 的 prompts 精确规则。
		promptManager.configureNativeProjectToggle(async (projectId, templatePath, enabled) => {
			const service = piResourceConfigService;
			if (!service) return { ok: false, error: "pi resource service unavailable" };
			return service.setFileResourceEnabled({ scope: { scope: "project", projectId }, kind: "prompts", resourceId: templatePath, enabled });
		});
		promptManager.configureNativeProjectEntriesReader(async (projectId) => {
			const project = projectStore.get(projectId);
			// 项目级 pi 配置只存在于本机目录；远端项目不读本机路径（fail-closed 返回 null）。
			if (!project || !isLocalProject(project)) return null;
			try {
				const file = await readPiConfigFile(join(project.path, ".pi", "settings.json"));
				const value = file.data.prompts;
				return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
			} catch {
				return null;
			}
		});
		// 提示词商店官方模板 / 内置技能热更新：与内置扩展同一套「resources 只读 → userData 覆盖层」机制。
		// 覆盖层供查询侧（XuePromptManager / SkillManager）叠加解析：远端新增/修改的模板与技能免发版生效。
		const { promptStoreUpdater, skillStoreUpdater } = startResourceStores({ getSettings: () => settingsStore.get() });
		// 提示词库双通道（db 远程拉取 + Go xue-index 检索）与三个 Go 数据面 sidecar
		// （session-index 正文搜索 / file-index 文件检索 / session-store 会话数据面）连同预热与退出清理
		// 整体搬到 startup/sidecars.ts；`assign` 只回填本文件里的模块级槽位，不复制第二份实例。
		startSidecars({
			appLogger,
			getMainWindow: () => mainWindow,
			promptStoreUpdater,
			projectPathsForContentSearch,
			quitCleanup,
			sessionScanner,
			settingsStore,
			assign: (patch) => {
				if (patch.xuePromptDbStore !== undefined) xuePromptDbStore = patch.xuePromptDbStore;
				if (patch.xueIndexService !== undefined) xueIndexService = patch.xueIndexService;
				if (patch.xuePromptManager !== undefined) xuePromptManager = patch.xuePromptManager;
				if (patch.sessionIndexService !== undefined) sessionIndexService = patch.sessionIndexService;
				if (patch.fileIndexService !== undefined) fileIndexService = patch.fileIndexService;
				if (patch.sessionStoreService !== undefined) sessionStoreService = patch.sessionStoreService;
			},
		});
		skillManager = new SkillManager(undefined, mainCopy);
		// 内置技能覆盖层叠加：安装内置技能模板时覆盖层优先（修 bug/新增技能免发版）
		skillManager.configureSkillOverlay(() => skillStoreUpdater.resolveEffectiveOverlayDir());
		// 注入旧禁用列表读写（原生服务未装配时的兜底通道；迁移后为空，仅兼容读取）。
		skillManager.configureSettings(
			() => settingsStore.get(),
			(patch) => settingsStore.update(patch),
		);
		// 原生配置接线（A4）：迁移后禁用列表不再是真值来源，技能开关直接写 pi settings.json
		// 的精确过滤规则；列表状态也按原生条目投影（见 PiResourceConfigService）。
		// 闭包延迟读 piResourceConfigService（它在启动迁移阶段才装配）。
		skillManager.configureNativeToggle(async (skillPath, enabled) => {
			const service = piResourceConfigService;
			if (!service) return { ok: false, error: "pi resource service unavailable" };
			// revision 交给服务内部锁内重读；这里不传，避免把并发页面草稿误判成冲突。
			const saved = await service.setFileResourceEnabled({ scope: { scope: "global" }, kind: "skills", resourceId: skillPath, enabled });
			if (saved.ok) await refreshSkillProjection();
			return saved;
		});
		// 状态投影：按原生条目判定该技能当前是否加载（排除 → 强制包含 → 强制排除）。
		// 运行时真值仍是 pi；这里只用于列表展示与开关初始值。
		skillManager.configureNativeEnabledReader((skillPath) => {
			const entries = skillManagerNativeEntries;
			if (!entries) return undefined;
			return projectResourceEnabled({ entries, value: skillPath, baseDir: dirname(skillPath) });
		});
		// 启动时自动安装内置 usage-probe 技能模板到 PiDeck 专属技能目录（~/.pi/agent/pideck-skills）：
		// 该目录不在 pi 的自动发现根里，只有 PiDeck spawn 时以 --skill 注入，
		// 终端里的 pi（TUI）不会加载；用户仍可在聊天里 /skill:usage-probe 触发。
		// fire-and-forget：安装失败不阻塞启动，仅记日志（手动入口 configInstallUsageSkill 仍可兑底）。
		void skillManager.installUsageProbeTemplate().then((result) => {
			if (result.success) {
				void appLogger?.info("skill", "Usage probe skill template auto-installed", { path: result.path });
			} else {
				void appLogger?.warn("skill", "Usage probe skill template auto-install failed", { error: result.error });
			}
		});
		// 生图技能同样启动时落到 PiDeck 专属技能目录（只由 PiDeck 的 --skill 注入），
		// 否则用户无法 /skill:image-gen 触发生图。fire-and-forget，失败不阻塞启动。
		void skillManager.installImageGenTemplate().then((result) => {
			if (result.success) {
				void appLogger?.info("skill", "Image-gen skill template auto-installed", { path: result.path });
			} else {
				void appLogger?.warn("skill", "Image-gen skill template auto-install failed", { error: result.error });
			}
		});
		// 环境诊断技能启动时落到 PiDeck 专属技能目录，用户可 /skill:pideck-doctor 让 pi 读诊断报告排障。
		// fire-and-forget，失败不阻塞启动。
		void skillManager.installPideckDoctorTemplate().then((result) => {
			if (result.success) {
				void appLogger?.info("skill", "Pideck-doctor skill template auto-installed", { path: result.path });
			} else {
				void appLogger?.warn("skill", "Pideck-doctor skill template auto-install failed", { error: result.error });
			}
		});
		// issue #450：Windows 没有进程组级联回收，强杀/异常退出会留下 npx 型 MCP 与 ACP 的
		// 孤儿 node 进程（事故现场 195 个 / 21GB 提交内存）。启动后后台回收一次：只杀
		// 「父进程已消失 + 命令行命中当前 MCP/ACP 配置」的 node.exe，活的进程一律不碰。
		setTimeout(() => {
			void (async () => {
				try {
					const mcp = await configManager.getMcpConfig().catch(() => null);
					const markers = deriveOrphanSweepMarkers({
						mcpServers: (mcp?.servers ?? []).map((server) => server.definition),
						acpTools: settingsStore.get().acpTools ?? [],
					});
					const result = await sweepOrphanedManagedProcesses({ markers });
					if (result.found > 0) void appLogger?.info("process-sweep", "Reclaimed orphaned managed processes", result);
				} catch (error) {
					void appLogger?.warn("process-sweep", "Orphan process sweep failed", { error: error instanceof Error ? error.message : String(error) });
				}
			})();
		}, 5_000);
		extensionManager = new ExtensionManager(
			piLocator,
			() => settingsStore.get(),
			() => settingsStore.get(),
			(patch) => settingsStore.update(patch),
			mainCopy,
			// 与热更新器/-e 注入共用同一套根（含 overlayDir），列表里的内置扩展路径与版本
			// 才能反映「当前真正生效」的那一份。
			resolveBuiltInExtensionRoots(),
		);
		// 原生配置接线（A4）：扩展到开关写 pi settings.json 的过滤规则
		// （包安装 → 整包停用；本地文件扩展 → 顶层精确 +/-路径），列表状态按原生条目投影。
		// 闭包延迟读 piResourceConfigService（启动迁移阶段才装配）。
		extensionManager.configureNativeToggle(async ({ source, path, scope, projectId, enabled }) => {
			const service = piResourceConfigService;
			if (!service) return { ok: false, error: "pi resource service unavailable" };
			let target: PiResourceScope;
			if (scope === "project") {
				// 项目作用域必须由渲染层显式给出注册 projectId：缺它就报错，绝不猜一个项目写错配置。
				if (!projectId) return { ok: false, error: "Project scope requires a project id." };
				target = { scope: "project", projectId };
			} else {
				target = { scope: "global" };
			}
			const saved = await service.setExtensionEnabled({ scope: target, source, path, enabled });
			if (saved.ok) await refreshExtensionProjection();
			return saved;
		});
		extensionManager.configureNativeEnabledReader((extension) => {
			const entries = extensionManagerNativeEntries;
			if (!entries) return undefined;
			// 包安装的扩展真值在 packages 条目的过滤里，顶层 extensions 的路径规则对它无效
			// （历史迁移残留的 `-<包目录>` 会让开关写成功后弹回，见 projectExtensionEnabled）。
			const enabled = projectExtensionEnabled({ source: extension.source, path: extension.path, entries, packages: extensionManagerNativePackages });
			if (enabled === undefined) return undefined;
			// filtered 也按 packages 条目重算：pi list 只按「条目是不是对象」打标，
			// 整包停用（四类空数组）与历史空对象会被误标成过滤式安装。
			const filtered = projectExtensionFiltered({ source: extension.source, packages: extensionManagerNativePackages });
			return filtered === undefined ? { enabled } : { enabled, filtered };
		});
		// 项目侧资源开关写项目 `.pi/settings.json` 的原生过滤规则（A4）。
		// 项目自有资源用精确 `-path`；继承全局资源写「绝对路径 plain + +/-」，与 pi config 一致。
		const projectNativeRules = {
			setResourceEnabled: async (projectId: string, kind: "extensions" | "skills" | "prompts", value: string, enabled: boolean) => {
				const service = piResourceConfigService;
				if (!service) return { ok: false, error: "pi resource service unavailable" };
				return service.setFileResourceEnabled({ scope: { scope: "project", projectId }, kind, resourceId: value, enabled });
			},
			setInheritedOverride: async (projectId: string, kind: "extensions" | "skills" | "prompts", value: string, state: "inherit" | "enabled" | "disabled") => {
				const service = piResourceConfigService;
				if (!service) return { ok: false, error: "pi resource service unavailable" };
				return service.setProjectInheritedOverride({ projectId, kind, value, state });
			},
			readEntries: async (projectId: string, kind: "extensions" | "skills" | "prompts") => {
				try {
					const project = projectStore.get(projectId);
					if (!project || !isLocalProject(project)) return null;
					const file = await readPiConfigFile(join(project.path, ".pi", "settings.json"));
					const value = file.data[kind];
					return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
				} catch {
					return null;
				}
			},
		};
		projectResourceManager = new ProjectResourceManager(
			(projectId) => projectStore.get(projectId),
			mainCopy,
			(project) => {
				// ProjectResourceManager 只在本地项目上工作（远端资源发现属 Phase 4）。
				if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
				const settings = settingsStore.get();
				const resourceWslDistro = project.environment === "wsl" ? (project.wslDistro ?? settings.wslDistro) : undefined;
				if (process.platform === "win32" && resourceWslDistro !== undefined) {
					try {
						return toWindowsHostPath(project.path, { distro: resourceWslDistro });
					} catch {
						return project.path;
					}
				}
				return project.path;
			},
			{
				getProjectTrustDecision: async (project) => {
					if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
					const settings = settingsStore.get();
					const projectWslDistro = project.environment === "wsl" ? (project.wslDistro ?? settings.wslDistro) : undefined;
					const cwd = process.platform === "win32" && projectWslDistro !== undefined ? toWslLinuxPath(project.path, { distro: projectWslDistro }) : project.path;
					return configManager.getProjectTrustDecision(cwd);
				},
				getGlobalDisabledResourceNames: () => {
					const settings = settingsStore.get();
					return { skills: settings.disabledSkills, prompts: settings.disabledPrompts };
				},
			},
			projectNativeRules,
		);
		resourceImportManager = new ResourceImportManager(
			configManager,
			skillManager,
			projectResourceManager,
			(id) => {
				const project = projectStore.get(id);
				// 资源导入只在本机项目上发生（远端项目资源发现属 Phase 4）。
				return project && isLocalProject(project) ? project : undefined;
			},
			async (_id, root) => (await configManager.getProjectTrustDecision(root)) === true,
			(report) => {
				void appLogger.info("resource-import", "Resource import completed", {
					kind: report.kind,
					imported: report.imported,
					skipped: report.skipped,
					failed: report.failed,
				});
			},
		);
		agentManager = new AgentManager(
			(id) => projectStore.get(id),
			() => mainWindow,
			settingsStore,
			configManager,
			rpcLogger,
			appLogger,
			undefined,
			mainCopy,
			// 每次 spawn 前只确保已有 capability hydration 已完成；snapshot/失败状态
			// 都会命中内存，不能因为启动多个 Agent 重复 fork Pi。
			() => {
				void piModelCapabilityCache
					?.ensure()
					.then((snapshot) => (snapshot ? undefined : refreshModelList(piLocator, settingsStore, configManager)))
					.catch(() => undefined);
			},
			securityStore,
			// spawn pi 前预检修复会话文件（旧版私有 sessionName 头行会让 pi 拒绝加载，见 #114）
			(filePath) => sessionScanner.repairCorruptSessionHeader(filePath),
			// 飞书绑定会话：spawn 时注入 PIDECK_FEISHU_LINKED，ask_question 切换为禁用提示版。
			// 闭包延迟读 feishuBridge（连接成功后才创建），spawn 时 binding 已先于 runtime 建立。
			(key) => Boolean(key && feishuBridgeRef.current?.hasSessionBinding(key)),
			// 通知点击跳转需要 record.id（renderer 按它索引会话）；agentId → record.id 由 coordinator 维护。
			(agentId) => sessionRuntimeCoordinator.getSessionId(agentId),
			// 会话级代理覆盖（含按模型/供应商两级白名单过滤）：
			// 1. 会话显式 on/off 最高优；2. 全局名单非空时按会话 model 自动映射 on/off——
			//    模型名单（provider/modelId，粒度更细）优先，供应商名单（provider）兜底；
			//    （force_on：名单内即使全局关闭也复用全局 URL，实现“指定模型/供应商走代理”）；
			// 3. 否则跟随全局。解决“新建会话首条请求无代理”痛点：创建时模型已确定即带正确代理。
			(sessionKey) => {
				if (!sessionKey || !sessionCatalog) return undefined;
				const entry = sessionCatalog.get(sessionKey);
				if (!entry) return undefined;
				const sessionMode = entry.proxy?.mode;
				const provider = entry.model?.provider;
				const modelId = entry.model?.modelId;
				const { piProxyProviders, piProxyModels } = settingsStore.get();
				return resolveEffectiveSessionProxyMode(sessionMode, provider, modelId, piProxyProviders, piProxyModels);
			},
			// set_model 失败时判断模型是否在 pi 目录中（选择器同源）：模型在目录而 Agent
			// 快照没有 → 目录是 Agent 启动后才更新的，标记 needsRestart 引导用户重启 Agent。
			// 覆盖 auth.json 官方 provider 的目录模型（models.json 无此 provider 也能选能用）。
			async (provider, modelId) => {
				try {
					const snapshot = await piModelCapabilityCache?.ensure();
					const models = snapshot && snapshot.models.length > 0 ? snapshot.models : await fetchModelList(piLocator, settingsStore, configManager);
					return models.some((m) => m.provider === provider && m.id === modelId);
				} catch {
					// 目录查询失败（pi 缺失/CLI 异常等）时退回旧行为：不标 needsRestart，
					// 保持错误形态不变，避免把可诊断错误变成误导性的“重启即可”。
					return false;
				}
			},
			// 远端运行时端口（Phase 4 P4.2）：只把「远端会话怎么起来」这件事交给 AgentManager，
			// 事实探测/ssh/握手全留在连接服务那条已验证的通道里。缺省不注入 = 本机产品，
			// 远端项目仍会被拒绝（见 createRemoteUnlocked）。
			createRemoteRuntimePort({
				// 连接服务是 registerIpc 里懒建的单例；这里的回调在真正要起远端会话时才求值。
				resolveService: () => remoteHostServiceResolver?.(),
				// 远端会话身份登记（P4.2 收口）的正门：catalog 也是懒取（AgentManager 比它更早装配）。
				resolveCatalog: () => sessionCatalog,
				// 登记时的会话根解析同样走一次性命令（R1a）：不在会话启动路径上切 host 的活动 root。
				resolveRemoteTransport: () => remoteCommandTransport,
				settings: () => settingsStore.get(),
				// runner 1.1.0 起支持 init 帧 env：安全门可以拿到 PIDECK_SECURITY_CONFIG。
				envChannelAvailable: true,
				securityPolicyBytes: () => securityStore.readSnapshotBytes(),
				// 远端项目 trust 决策（P4.4b）：端口每次 prepare 现读，未决策/材料缺失/endpoint 变更都返回
				// undefined ⇒ 一个 flag 都不加（零行为变更）。
				resolveTrust: () => remoteProjectTrustService,
			}),
			// 第三方接管型 MCP 扩展提醒（M5b）：复用 ExtensionManager.list() 的缓存路径（轻扫描，
			// 不查 npm view），把命中的接管型扩展交给 AgentManager 在启动后提醒。闭包延迟读
			// extensionManager（构造晚于 agentManager）；列表查询失败时返回空集（宁可漏提醒也不报错）。
			async () => {
				try {
					const list = await extensionManager?.list(false);
					if (!list) return [];
					return detectThirdPartyMcpExtensions(list.extensions).map((hit) => ({
						source: hit.source,
						scope: hit.scope,
						enabled: hit.enabled,
						uninstallCommand: hit.uninstallCommand,
						isLocalFile: hit.isLocalFile,
					}));
				} catch {
					return [];
				}
			},
		);
		// 桌面端专用技能只经 spawn 时的 --skill 注入；TUI 不扫内置目录，自然不会加载。
		agentManager.setBundledSkillResolver(() => skillManager.getBundledSkillLoadPaths());
		// C12：退出清理登记（before-quit 统一 runAll，新增资源不再改 before-quit）
		quitCleanup.register("pi-agents", () => agentManager?.stopAll());

		// Wave 2 + 2b：把 session-store 条目表接进会话历史读取（TS 缓存未命中时优先问 Go）。
		// 条目表落盘后重启首次打开大会话 14–20ms（TS 冷建表 99–188ms，见计划 §8.11），故默认开启；
		// settings.sessionStoreEnabled 置 false 即回退纯 TS 解析（紧急开关，无 UI）。
		// 只在 sidecar **已就绪**时问：未就绪宁可走 TS 解析，也不让「打开会话」卡在冷扫上。
		agentManager.setSessionStoreIndexReader(async (hostPath) => {
			if (!settingsStore.get().sessionStoreEnabled) return null;
			const service = sessionStoreService;
			if (!service || !service.isReady()) return null;
			const result = await service.getIndex(hostPath);
			return result.ok ? result.value : null;
		});

		// 悬浮球控制器：主窗口隐藏后常驻屏幕角落的小圆点，点击展开 mini 浮窗/紧凑模式。
		// 延迟到 agentManager 就绪后创建，因为依赖 addStateListener 订阅运行状态。
		// 极简浮窗：360×480 状态总览+快捷输入+最近会话，独立于主窗口运行。
		// 创建逻辑与展开逻辑拆开：悬浮球点击（onExpandMini）与任务模式→小窗互切共用。
		const ensureMiniOverlayWindow = (): MiniOverlayWindow => {
			miniOverlayWindow ??= new MiniOverlayWindow({
				settingsStore,
				agentManager,
				projectStore,
				onJumpToSession: (sessionId, projectId) => {
					focusMainWindow();
					queueFocusTarget({ sessionId, projectId });
					mainWindow?.webContents.once("did-finish-load", () => {
						flushPendingFocusTargetOnLoad();
					});
				},
				onQuickPrompt: async (projectId, text) => {
					// 快捷输入：创建草稿 → activateRuntime → agentManager.sendPrompt（与渲染层 useQuickTask 同链路）
					const draft = await sessionCatalog.createDraft({ projectId, title: text.slice(0, 40), environment: "native", backend: agentManager.backend });
					const runtime = await sessionRuntimeCoordinator.activateRuntime(draft.id);
					if (!runtime.ok) return { ok: false, message: runtime.error.code };
					const result = await agentManager.sendPrompt({ agentId: runtime.value.agentId, message: text });
					if (!result.accepted) return { ok: false, message: result.error };
					return { ok: true };
				},
				onExit: () => {
					// 关闭浮窗：退出悬浮球模式，回主窗口
					settingsStore.update({ floatingBallEnabled: false });
					floatingController?.hide();
					focusMainWindow();
				},
				onCollapse: () => {
					// 收起浮窗：回悬浮球（保持悬浮球模式）
					if (settingsStore.get().floatingBallEnabled) {
						void floatingController?.show();
					}
				},
				onSwitchToQuickTask: async (projectPath) => {
					// 小窗 → 任务模式：不回悬浮球（与 onExpandCompact 一致），
					// 主窗口以 quick-task 紧凑形态打开；未带项目路径时用桌面。
					floatingController?.hide();
					await quickTaskChrome.controller.open(projectPath ?? app.getPath("desktop"));
				},
			});
			return miniOverlayWindow;
		};
		async function expandMiniOverlay(): Promise<void> {
			floatingController?.hide();
			await ensureMiniOverlayWindow().show();
		}

		floatingController = new FloatingController({
			settingsStore,
			getMainWindow: () => mainWindow,
			onExpandMini: expandMiniOverlay,
			onExpandCompact: async () => {
				floatingController?.hide();
				// 小任务模式：主窗口变 compact 浮窗（不显示主窗口，直接 enterCompact）
				if (mainWindow && !mainWindow.isDestroyed()) {
					mainWindow.hide();
				}
				await quickTaskChrome.controller.open(app.getPath("desktop"));
			},
			onShowMainWindow: () => {
				if (mainWindow && !mainWindow.isDestroyed()) {
					mainWindow.show();
					mainWindow.focus();
				}
			},
			addAgentStateListener: (listener) => agentManager.addStateListener(listener),
			getActiveAgentCount: () => agentManager.list().filter((t) => t.status !== "closed").length,
			getRunningAgentCount: () => agentManager.list().filter((t) => t.status === "running").length,
			getRecentRunningTitles: () =>
				agentManager
					.list()
					.filter((t) => t.status === "running")
					.map((t) => t.title)
					.filter(Boolean)
					.slice(0, 3) as string[],
		});
		quitCleanup.register("floating-ball", () => floatingController?.destroy());
		quitCleanup.register("mini-overlay", () => miniOverlayWindow?.destroy());
		registerFloatingIpc(floatingController);
		// quick-task IPC 与 floating/mini-overlay 共置：switchToMiniOverlay 依赖 expandMiniOverlay（小窗⇄任务模式互切）。
		registerQuickTaskIpc(quickTaskChrome.controller, {
			onSwitchToMiniOverlay: async () => {
				if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
				await expandMiniOverlay();
			},
		});
		// 启动时如果悬浮球已开启，自动显示（用户上次开着悬浮球退出了应用）
		if (settingsStore.get().floatingBallEnabled) {
			void floatingController.show();
		}

		// RPC 日志是合并落盘的（250ms / 256 行刷一批），退出前把缓冲刷干净。
		// 必须排在 pi-agents 之后：runAll 顺序执行，先停进程（最后几条日志在这里产生）再刷盘。
		quitCleanup.register("rpc-logs-flush", () => rpcLogger?.flushPending());
		// 模型请求快照端点：关掉监听，释放端口（快照随 pi 子进程一起结束）
		quitCleanup.register("model-trace", () => stopModelTraceServer());
		// 开发诊断必须在 registerIpc 之前创建：systemIpc 闭包捕获这个实例。
		diagnosticsMonitor = new DiagnosticsMonitor({
			logger: appLogger,
			streamingProbe: () => agentManager.hasActiveStreaming(),
		});
		agentManager.setDiagnosticsSink((name, startedAt, detail) => {
			diagnosticsMonitor?.recordTiming(name, startedAt, detail);
		});
		quitCleanup.register("diagnostics-monitor", () => diagnosticsMonitor?.stop());
		// 环境体检（问题反馈页一键排障）与诊断产物导出器：依赖齐全后构造，注入 systemIpc。
		// 两者都只读 appLogger/piLocator/settingsStore/configManager，无独立生命周期。
		environmentDoctor = new EnvironmentDoctor({
			appLogger,
			piLocator,
			settingsStore,
			configManager,
		});
		logBundleExporter = new LogBundleExporter({ appLogger });
		// DSH runtime 管理器（阶段 2）：外部 runtime 落在 userData/runtimes/dsh/<version>。
		// 暂存目录与版本目录同级，便于整体清理；两者都在 userData 内，卸载应用时一并带走。
		dshRuntimeManager = new DshRuntimeManager({
			layout: {
				runtimesRoot: join(app.getPath("userData"), "runtimes", "dsh"),
				tempRoot: join(app.getPath("userData"), "runtimes", ".tmp"),
			},
			appVersion: () => app.getVersion(),
			download: createNetDownloader((scope, message, detail) => void appLogger.warn(scope, message, detail)),
			extract: createTarExtractor((scope, message, detail) => void appLogger.warn(scope, message, detail)),
			log: (scope, message, detail) => void appLogger.info(scope, message, detail),
		});
		// 「本版本配套哪个 dsh runtime」只有一个事实源：状态服务的门控与安装器的挑版本
		// 必须同源，否则会出现「门控要 0.2.0-rc.2、安装器装 0.1.5-rc.1 并报成功」的死循环。
		const declaredDshVersion = () => readDeclaredDshVersion(app.getAppPath());
		// DSH runtime 安装态服务先于 DshHost 装配（探测只依赖 appPath，不 fork host）。
		// 探测顺序：外部已装 runtime 优先 → 兼容旧版 full/存量包时才回退 app 内置。
		// 官方 lite 包与 dev 都把 runtime 获取统一到 userData 外部目录，未安装时从同一份
		// Release 索引下载；这样开发环境验证的就是用户实际走的远程安装链路。
		// allowBundledFallback 仅保留给显式 full/存量包兼容，不再按 app.isPackaged 区分；
		// 新的 dev/lite 默认关闭，避免项目 node_modules 或残留资源绕过远程安装。
		dshRuntimeStatus = new DshRuntimeStatusService(
			() => app.getAppPath(),
			(scope, message, detail) => void appLogger.info(scope, message, detail),
			() => {
				const active = dshRuntimeManager.resolveActive();
				return active ? { nodeModules: active.nodeModules, runtimeVersion: active.manifest.runtimeVersion } : undefined;
			},
			// dev 不把项目 node_modules 当成「已安装 runtime」；统一走外部 Release 下载。
			() => false,
			// 保留构造位次供旧调用方兼容；安装入口现在由状态服务统一开放，不读取打包态。
			() => app.isPackaged,
			// 声明的配套 dsh 版本（package.json）：与已装 runtime 比对得出 updateAvailable，
			// 升级 app 后旧 runtime 仍「兼容」会被一直选用，UI 需要这个信号提示更新。
			declaredDshVersion,
		);
		dshRuntimeStatus.subscribe((status) => {
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send(ipcChannels.dshRuntimeStatusChanged, status);
			}
		});
		// runtime 安装编排：索引拉取 + 选版本 + 落位，进度统一广播给渲染层。
		// 索引地址默认指向与 app update 同一仓库的 release 资产，settings 可覆盖为镜像。
		dshRuntimeInstaller = new DshRuntimeInstaller({
			manager: dshRuntimeManager,
			// 优先级：环境变量（本地/内网验证用，免改设置）> 设置项（镜像）> 当前 latest 应用 Release。
			// 禁止独立 dsh-runtime tag：会抢走 GitHub /releases/latest。
			indexUrl: () =>
				resolveDshRuntimeIndexUrl({
					indexUrl: process.env.DSH_RUNTIME_INDEX_URL || settingsStore.get().dshRuntimeIndexUrl,
					updateSource: settingsStore.get().updateSource,
				}),
			updateSource: () => settingsStore.get().updateSource,
			releaseTag: () =>
				resolveDshRuntimeReleaseTag({
					explicitTag: process.env.PIDECK_RELEASE_TAG,
					isPackaged: app.isPackaged,
					appVersion: app.getVersion(),
				}),
			appVersion: () => app.getVersion(),
			// 与状态服务同源：安装只认这个配套版本，索引里没有就报错而不是退装旧版。
			declaredVersion: declaredDshVersion,
			fetchIndex: fetchDshRuntimeIndex,
			// dev 与官方 lite 包统一走远程 Release；只给显式 full/存量包保留离线兼容入口。
			// 通过显式环境变量开启，避免开发机或新包因残留资源误绕过远程下载链路。
			bundledRuntime: () => (process.env.PIDECK_DSH_ALLOW_BUNDLED_RUNTIME === "1" ? readBundledRuntime(process.resourcesPath ? join(process.resourcesPath, DSH_BUNDLED_RUNTIME_DIRNAME) : undefined, app.getVersion()) : undefined),
			onProgress: (progress) => {
				if (mainWindow && !mainWindow.isDestroyed()) {
					mainWindow.webContents.send(ipcChannels.dshRuntimeInstallProgress, progress);
				}
			},
			log: (scope, message, detail) => void appLogger.info(scope, message, detail),
		});
		// DSH host 实例先装配；是否后台预热看 defaultAgentBackend（见 createWindow 后）。
		// 发送/历史/配置链路仍走 ensureStarted 幂等兜底，不用 DSH 的用户不常驻 host。
		// DSH_HOME 可用设置 dshHomeDir 覆盖（用户自己的 ~/.dsh 等），空串 = 应用私有目录。
		dshHost = new DshHost(
			() => app.getPath("userData"),
			() => app.getAppPath(),
			undefined,
			() => settingsStore.get().dshHomeDir ?? "",
			// 会话级代理覆盖（DSH 降级方案，用户确认的取舍）：DSH 是单一共享 host、无 per-session
			// 通道，只能聚合所有 DSH 会话（backend=dsh）的开关应用到共享 host 的 fork env。
			// 冲突规则 off 优先于 on（直连是安全默认）；全 follow → 不动（保持 host 现有行为）。
			// 生效机制：buildHostProxyEnvPatch 在 on 时会额外注入 NODE_USE_ENV_PROXY=1，让 host
			// 内部 globalThis.fetch（undici）真正按注入的 HTTP_PROXY/NO_PROXY 走代理（Node 22.21+
			// 行为，Electron 43 内置 Node 24.18.1 已实测）；off 时剥离该开关。
			() => {
				const settings = settingsStore.get();
				// DSH 共享 host 的代理需按供应商过滤逐会话计算有效模式，再聚合（与 pi 会话链路一致的 provider 感知）。
				const dshOverrides = (sessionCatalog?.listEntries() ?? [])
					.filter((entry) => entry.backend === "dsh")
					.map((entry) => {
						const effectiveMode = resolveEffectiveSessionProxyMode(entry.proxy?.mode, entry.model?.provider, entry.model?.modelId, settings.piProxyProviders, settings.piProxyModels);
						return effectiveMode === "follow" ? undefined : ({ mode: effectiveMode } as import("../shared/types/session").SessionProxyOverride);
					});
				const mode = aggregateDshProxyMode(dshOverrides);
				// 全局开关兜底：所有 DSH 会话都 follow（无显式覆盖、无名单命中）时，仍应让 host
				// 跟随全局 pi 代理开关——否则用户在设置页只开全局开关，DSH 永远直连（与 pi 会话
				// 「名单空时跟随全局」语义不一致）。名单非空时不做兜底（见 resolveDshHostProxyMode）。
				const settingsSnapshot = settingsStore.get();
				const hasProxyList = (settingsSnapshot.piProxyModels?.length ?? 0) > 0 || (settingsSnapshot.piProxyProviders?.length ?? 0) > 0;
				const finalMode = resolveDshHostProxyMode(mode, {
					piProxyEnabled: settingsSnapshot.piProxyEnabled,
					hasList: hasProxyList,
				});
				return buildHostProxyEnvPatch(finalMode, {
					url: settingsSnapshot.piProxyUrl,
					bypass: settingsSnapshot.piProxyBypass,
				});
			},
			// 外部 runtime 根目录；未安装时保持 undefined，随后由 canCreateDshSession 门控，
			// 不再把 dev 项目 node_modules 当作远程 runtime 的隐式回退。
			() => dshRuntimeStatus.resolveAppRoot(),
			// 永久删除归档目录：统一走系统回收站（与 pi 会话删除同语义，可恢复；拒绝静默硬删）。
			async (path) => {
				await shell.trashItem(path);
			},
			() => settingsStore.get().dshRunnerNodePath ?? "",
			// 手动停止标记（持久化）：为真时 ensureStarted 拒绝自动拉起，只有用户显式启动才 boot。
			() => settingsStore.get().dshManualStopped === true,
			// agent-team 实验预设（默认关）：fork 时读快照传入 hostEntry；变更需重启 host。
			() => settingsStore.get().dshAgentTeamPreset === true,
		);
		// 用户插件安装服务（搜索/安装/清单；npm 走 PiLocator 的跨平台启动规格，市场 API 走 fetch）。
		// 依赖闭包优先取 runtime node_modules（与 host 同版本）；runtime 未安装时也能装（registry 补齐）。
		dshPluginInstallService = new DshPluginInstallService({
			getDshHomeDir: () => dshHost.getHomeDir(),
			getUserDataDir: () => app.getPath("userData"),
			resolveRuntimeNodeModules: () => {
				const appRoot = dshRuntimeStatus.resolveAppRoot();
				return appRoot === undefined ? undefined : join(appRoot, "node_modules");
			},
			launcher: {
				createInvocation: (command, args) => piLocator.createInvocation(command, args),
				// 参数顺序陷阱：createProcessEnv 首个参数是代理设置，pathPrefix 在第二位。
				createProcessEnv: (pathPrefix) => piLocator.createProcessEnv(undefined, pathPrefix),
			},
			fetchImpl: (url, init) => fetch(url, init),
			log: (scope, message, detail) => void appLogger.info(scope, message, detail),
		});
		// 实时 RPC 日志广播器（DSH 后端用）：镜像 pi AgentManager 的 80ms 节流批量推送语义，
		// 窗口销毁后静默丢弃；观看登记由 rpcLogsSetWatching IPC 按面板挂载/卸载成对驱动。
		const rpcLogLiveBroadcaster = new RpcLogLiveBroadcaster({
			send: (channel, payload) => {
				if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
			},
		});
		dshAgentManager = new DshAgentManager(
			dshHost,
			(projectId) => projectStore.get(projectId),
			// 审批自动放行：运行时读取设置（即时生效，无需重启 host），见 settings.ts dshApprovalAutoAllow。
			() => settingsStore.get().dshApprovalAutoAllow === true,
			// DSH host 会话标题变化（attach 初值 / session/title 事件 / rename）写回 catalog：
			// DSH 会话没有 pi 会话文件，标题只存在于 host（dsh-session-title fold），
			// 不写回则侧栏/重启后一直显示 draft 占位名（如「pi-desktop DSH」）。
			// 更新后推送 catalog-refreshed，渲染层 useProjectSync 静默重拉刷新侧栏标题。
			(dshSessionId, title) => {
				const entry = sessionCatalog?.findByDshSessionId(dshSessionId);
				if (!entry || entry.title === title) return;
				void sessionCatalog
					.update(entry.id, { title })
					.then(() => {
						// index.ts 作用域用模块级 mainWindow（本文件没有 getMainWindow 助手）
						if (mainWindow && !mainWindow.isDestroyed()) {
							mainWindow.webContents.send(ipcChannels.sessionsCatalogRefreshed, { projectId: entry.projectId });
						}
					})
					.catch((error: unknown) => {
						void appLogger.warn("session", "DSH title sync to catalog failed", {
							dshSessionId,
							title,
							error: error instanceof Error ? error.message : String(error),
						});
					});
			},
			// G17：DSH RPC 日志复用 RpcLogger（按 agentId=dsh:<sessionId> 分文件）
			rpcLogger,
			// G10：DSH 会话 HTML 导出目录（与远端会话导出同源：resolveSessionExportDir）
			resolveSessionExportDir,
			// 新会话无标题时的兜底标题（i18n；与外部会话导入兜底一致）
			() => mainCopy("session.dshUntitled"),
			rpcLogLiveBroadcaster,
			// Ask 通知：DSH 没有 AgentManager 的通道，由装配层注入统一门控/toast。
			{ askPending: (input) => notifyAgentAskPending(agentToastDeps(), input) },
			mainCopy,
		);
		// C12/E15：DSH 退出清理——先停全部活跃会话（清 mux/订阅/pending）再 dispose host，
		// 顺序保证避免 host 先被杀导致会话清理路径访问已死 transport。
		quitCleanup.register("dsh", async () => {
			await dshAgentManager?.stopAll();
			// 退出前清空实时广播的观看登记与聚合缓冲（含在途节流定时器，配对清理）
			rpcLogLiveBroadcaster.clear();
			await dshHost?.dispose();
		});
		// DSH 外部会话自动导入改到 projectStore.load 之后（见下方 scheduleDshForeignAutoImport）：
		// 必须走只读磁盘扫描，不能依赖 host-ready——否则会与 dsh-web 抢同一份 DSH_HOME。
		// Web 端 /api/chat 的「绑定智能体角色设定」已注入记账（与桌面 IPC 的 personaInjectedSessions 同语义）：
		// 主进程内两个发送入口共用 applyBoundAgentPersona 的纯语义，各自持有本入口的已注入集合。
		startWebService({
			appLogger,
			settingsStore,
			securityStore,
			agentManager,
			projectStore,
			sessionScanner,
			configManager,
			piLocator,
			dshAgentManager,
			dshHost,
			promptManager,
			xuePromptManager,
			skillManager,
			extensionManager,
			gitService,
			fileSystemService,
			wechatServiceRef,
			sessionForkCommands,
			getSessionCatalog: () => sessionCatalog,
			getSessionRuntimeCoordinator: () => sessionRuntimeCoordinator,
			getAcpAgentManager: () => acpAgentManager,
			getAgentProfileStore: () => agentProfileStore,
			getPiModelCapabilityCache: () => piModelCapabilityCache,
			getTerminalManager: () => terminalManager,
			getRemoteAccessManager: () => remoteAccessManager,
			getWebServiceManager: () => webServiceManager,
			mainCopy,
			shouldUseDevRendererUrl,
			sessionScannerForProject,
			wslSessionScannerFor,
			emitSessionRuntimeEvent,
			emitSessionRuntimeDetach,
			emitReplacementState,
			notifyCatalogRefreshed,
			createAnonymousSession,
			copyCatalogSession,
			exportCatalogSessionHtml,
			readCatalogSessionReferenceMessages,
			sessionMessageSearchInFile,
			sessionCommandIpcError,
			stopSessionRuntime,
			assign: (patch) => {
				webServiceManager = patch.webServiceManager;
			},
		});
		// C12：退出清理登记（before-quit 统一 runAll）
		quitCleanup.register("theme-schedule", () => clearThemeScheduleTimer());
		quitCleanup.register("update-check", () => updateService?.stop());
		quitCleanup.register("web-service", () => webServiceManager?.stop());
		startRemoteAccess({
			appLogger,
			settingsStore,
			quitCleanup,
			getWebServiceManager: () => webServiceManager,
			getMainWindow: () => mainWindow,
			assign: (patch) => {
				if (patch.remoteAccessManager !== undefined) remoteAccessManager = patch.remoteAccessManager;
			},
		});
		terminalManager = new TerminalSessionManager(
			(agentId) => {
				// 多后端：pi 与 DSH runtime 各持自己的 tab 表，终端工作目录必须经合成网关
				// 按 agentId 解析。只查 pi agentManager 会让 DSH 会话的终端在创建时抛
				// `Agent not found`，表现为「DSH 后端终端打不开」（渲染层静默吞掉该错误）。
				const tab = compositeAgentGateway?.list().find((candidate) => candidate.id === agentId);
				if (tab) return tab.cwd;
				// 网关未装配完成（启动极早期）时退回 pi 管理器；DSH agent 不在 pi 表里时
				// 同样抛出与原来一致的 `Agent not found` 语义。
				return agentManager.getCwd(agentId);
			},
			(channel, payload) => mainWindow?.webContents.send(channel, payload),
			projectStore,
			// 第 14 步：原生终端不再读取旧全局 WSL 开关；WSL 终端的身份只来自项目档案。
			() => ({}),
		);
		// C12：退出清理登记（before-quit 统一 runAll）
		quitCleanup.register("terminal", () => terminalManager?.closeAll());

		await settingsStore.load();
		// 快捷键覆盖从磁盘载入后立即刷新主进程生效绑定（此后 settings:update 路径实时刷新）
		refreshShortcutBindings(settingsStore.get());
		// Logo 风格：启动时按已加载设置刷新窗口/Dock 图标（此后 settings:update 路径实时刷新）
		applyWindowLogoStyle(settingsStore.get().logoStyle, () => mainWindow, settingsStore.get().logoCustomImage);
		// 任务栏按钮的图标取开始菜单快捷方式的图标（窗口图标只是无身份注册时的兜底）。
		// 2027-02 性能治理：整段是同步递归扫开始菜单（上限 2000 个 .lnk）+ 逐个
		// readShortcutLink，开发机上 50-300ms——原先在建窗前的同步链上直接推迟首窗可见。
		// 改 setImmediate 与 createWindow 的加载阶段重叠：窗口加载本身数百 ms，按钮首次
		// 出现的时点绝大多数仍在扫描完成之后；极端快加载下按钮先显示默认图标、扫描
		// 完成后 Windows 自动刷新（每启动只扫一次，签名去重见 appTaskbarIdentity）。
		setImmediate(() => {
			syncTaskbarShortcutIcon({ style: settingsStore.get().logoStyle, customLogoDataUrl: settingsStore.get().logoCustomImage });
		});
		piModelCapabilityCache = new PiModelCapabilityCache({
			// 模型能力水合分两档（详见 docs/archive/plans/pi-model-capability-plan.md）：
			// - 快速档（默认，loadExtensions=false）：--no-extensions。实测 418 模型下
			//   冷启动从 ~2.4s 降到 ~0.37s（扩展加载就是 hydration 的绝对大头）。
			// - 慢速档（loadExtensions=true）：仅模型选择器的手动刷新按钮触发，付扩展
			//   加载成本把 pi.registerProvider 贡献的模型（issue #181，如 antigravity
			//   插件）补回选择器——这是扩展模型的唯一入口。
			// 用户全局勾了 piRpcNoExtensions（开发设置诊断开关）时慢速档仍不加载扩展：
			// 显式设置优先，诊断路径不能被刷新按钮绕过。
			// 慢速档下用户禁用的扩展仍经 createPiProcessExtensionResolvers 白名单过滤，
			// 泄漏不进来。
			createProcess: ({ loadExtensions }) =>
				new PiProcess(
					process.cwd(),
					{
						...settingsStore.get(),
						// 全局 picker 用离线目录范围：不跑技能或网络刷新。
						piRpcOffline: true,
						piRpcNoSkills: true,
						// 快速档还跳过内置扩展的 -e 注入（内置扩展不贡献 provider，纯属白花时间）。
						...(loadExtensions ? {} : { piRpcNoExtensions: true }),
					},
					piLocator,
					// 与 AgentManager 同一套扩展/技能解析（内置注入 + 禁用白名单），
					// 保证「选择器看到的模型」与「运行时实际加载的扩展」同源。
					{ ...createPiProcessExtensionResolvers(process.cwd(), settingsStore.get()) },
				),
			getConfigDirectory: () => configManager.getConfigDir(),
			watchDirectory: watchPiConfigDirectory,
			onWarning: (message, detail) => void appLogger.warn("pi-capabilities", message, detail),
		});
		quitCleanup.register("pi-model-capabilities", () => piModelCapabilityCache?.dispose());
		setFeishuConfigDefaultBotName(feishuT(currentFeishuLocale(), "bridge.defaultBotName"));
		const initialSessionSettings = settingsStore.get();
		sessionCatalog = new SessionCatalog(
			join(app.getPath("userData"), "session-catalog.json"),
			{},
			// 会话路径统一绝对化：pi 的 sessionDir 配置为相对路径（如 ".pi/sessions"）时，
			// get_state 返回的 sessionFile 是相对 cwd 的；与扫描器绝对路径 originKey 不一致
			// 会导致同一会话在侧栏出现两条记录。加载与写入边界都经此归一化。
			(projectId, filePath, environment) => {
				const project = projectStore.get(projectId);
				if (!project || !isLocalProject(project)) return filePath;
				return toAbsoluteSessionPath(filePath, project.path, environment);
			},
			// 占位标题回填 + 会话头有效性校验：未打开过的 pi 会话也能在侧栏显示首条消息标题
			// （不再永远 Untitled）；同一次有界读头部顺带校验首条记录是否带 type 头，
			// 把 pi-subagents transcript 等无 type 头的产物挡在 catalog 之外（#168）。
			async (filePath, options) => {
				// WSL 会话文件是发行版内的 Linux 路径，宿主 Node 读不到；按合并上下文里的 distro/user
				// 选对应 scanner 读头部。本机会话继续用主 scanner。
				if (options?.wslDistro && options?.wslUser) {
					const scanner = await wslSessionScannerFor({ distro: options.wslDistro, user: options.wslUser });
					return scanner.inferSessionNameAndValidity(filePath, options);
				}
				return sessionScanner.inferSessionNameAndValidity(filePath, options);
			},
			// 远端会话登记（ensureRemoteSession）也写 hostId 引用，用同一道门。
			{ referenceGuard: referenceWriteGuard },
		);
		automationStore = new AutomationStore(join(app.getPath("userData"), "automation.json"));
		const automationStorePreload = automationStore.load();
		// 智能体：配置存储（userData/agent-profiles.json）。load 内部做旧数据归一化与
		// 内置翻译智能体补种；与 sessionCatalog 并行加载，不额外拖慢启动。
		agentProfileStore = new AgentProfileStore(join(app.getPath("userData"), "agent-profiles.json"));
		const agentProfileStorePreload = agentProfileStore.load();
		// 一次性调用计数带 1s 落盘合并窗口（见 AgentProfileStore.recordUsage）：退出时收尾。
		quitCleanup.register("agent-profile-store", () => agentProfileStore?.flushPendingUsage());
		// 收藏：本地快照（userData/favorites.json）。坏文件按空列表重建，不阻断启动。
		favoritesStore = new FavoritesStore(join(app.getPath("userData"), "favorites.json"));
		const favoritesStorePreload = favoritesStore.load();
		// 会话分组（userData/session-groups.json）：启动时一次性从旧版 session-groups 插件的私有 storage 迁入
		//（那个插件当时随包内置，已改为 docs/examples 下可选安装；只读旧文件、不写不删）；此后侧栏与插件 v3 都经 store 读写同一份数据。
		sessionGroupStore = new SessionGroupStore(join(app.getPath("userData"), "session-groups.json"), join(app.getPath("userData"), "host-plugin-storage", "session-groups.json"));
		const sessionGroupStorePreload = sessionGroupStore.load();
		// 插件页保存分组后实时刷侧栏：数据变化统一从 store 冒泡，广播给主窗口。
		sessionGroupStore.onChanged(() => {
			const win = mainWindow;
			if (win && !win.isDestroyed()) win.webContents.send(ipcChannels.sessionGroupsChanged, null);
		});
		await Promise.all([sessionCatalog.load(), automationStorePreload, agentProfileStorePreload, favoritesStorePreload, sessionGroupStorePreload]);
		// 云同步编排：主进程唯一持有密码/派生 key/Provider 凭据；扫描与恢复都走主进程。
		cloudSyncManager = new CloudSyncManager({
			userDataDir: app.getPath("userData"),
			homeDir: app.getPath("home"),
			// DSH 会话同步：DSH_HOME 与 DshHost 同一套解析（设置覆盖 > ~/.dsh > 应用私有目录）。
			dshHomeDir: resolveDshHomeDir(settingsStore.get().dshHomeDir ?? "", app.getPath("userData")),
			deviceName: hostname(),
			appVersion: app.getVersion(),
			listProjects: () => projectStore.list(),
			listSessionRecords: () =>
				sessionCatalog
					.listEntries()
					.map((entry) => sessionCatalog.getRecord(entry.id))
					.filter((record): record is SessionRecord => Boolean(record)),
			getDesktopSettings: () => settingsStore.get(),
			// filterSyncableDesktopSettings 已把未知 key 过滤掉，这里收窄为 AppSettings 字段。
			updateDesktopSettings: async (patch) => {
				await settingsStore.update(patch as Partial<AppSettings>);
			},
			// M5：包扩展安装走 ExtensionManager（pi install）；失败只记录缺失，不阻断同步。
			installExtension: async (source) => {
				try {
					await extensionManager.install(source);
					return { ok: true };
				} catch (error) {
					return { ok: false, error: error instanceof Error ? error.message : String(error) };
				}
			},
			listExtensions: async () => {
				try {
					const result = await extensionManager.list(false);
					return result.extensions.map((summary) => ({
						source: summary.source,
						scope: summary.scope,
					}));
				} catch {
					return [];
				}
			},
			onStateChanged: () => broadcastCloudSyncStateChanged(),
			log: (domain, message, details) => void appLogger.info(domain, message, details),
		});
		await cloudSyncManager.initialize();
		// C12：退出清理登记（before-quit 统一 runAll；cloud-sync 定时器与适配器随进程结束回收）
		quitCleanup.register("cloud-sync", () => cloudSyncManager?.dispose());
		// 智能体一次性调用（划词工具 / 市场面板）：复用提示词增强侧车协议，但**独立实例**。
		// 侧车进程常驻、首次调用才拉起（EnhancePromptService 的现有语义），启动期只做装配。
		agentInvokeCompletionService = createCompletionHelperService("agent-invoke");
		// C12：常驻子进程，退出时必须回收（与 enhance-prompt 同一清理登记表）。
		quitCleanup.register("agent-invoke", () => agentInvokeCompletionService?.dispose());
		agentInvokeService = new AgentInvokeService({
			profiles: agentProfileStore,
			completion: agentInvokeCompletionService,
			logger: {
				warn: (message) => void appLogger.warn("agent-invoke", message),
				error: (message) => void appLogger.error("agent-invoke", message),
			},
		});

		// 系统级划词：独立浮窗（复用主 preload，渲染层与主窗口同一份 desktopApi）+ 服务 + 全局快捷键。
		// 浮窗只在首次触发时创建；warmUp 预加载可把首次弹出延迟降到只剩 show。
		const selectionToolPreloadPath = await prepareMainPreloadPath();
		selectionToolWindow = new SelectionToolWindow({
			preloadPath: selectionToolPreloadPath,
			logger: appLogger,
			devRendererUrl: process.env.ELECTRON_RENDERER_URL ?? null,
		});
		selectionToolService = new SelectionToolService({
			window: selectionToolWindow,
			logger: {
				info: (scope, message, detail) => void appLogger.info(scope, message, detail),
				warn: (scope, message, detail) => void appLogger.warn(scope, message, detail),
				error: (scope, message, detail) => void appLogger.error(scope, message, detail),
			},
			suppressClipboardWatcher: (durationMs) => selectionClipboardWatcher?.suppressFor(durationMs),
		});
		// 复制即触发：外部应用复制文字 → 光标附近自动弹翻译浮窗（Magpie 式交互）。
		// 自己的窗口有焦点时不触发：应用内复制由应用内划词处理，浮窗自己的复制也不会再弹一个。
		selectionClipboardWatcher = new ClipboardSelectionWatcher({
			readText: () => clipboard.readText(),
			isOwnWindowFocused: () => BrowserWindow.getAllWindows().some((win) => !win.isDestroyed() && win.isFocused()),
			onCaptured: (text) => {
				void selectionToolService?.showText(text);
			},
			logger: { warn: (message, detail) => void appLogger.warn("selection-tool", message, detail) },
		});
		// Windows 原生划词：拖选/双击后直接 UIA 读选区；读不到时才靠上面的剪贴板兜底。
		windowsSelectionCapture = new WindowsSelectionCapture({
			onSelection: ({ text }) => {
				selectionClipboardWatcher?.suppressFor(2500);
				void selectionToolService?.showText(text);
			},
			logger: {
				info: (message, detail) => void appLogger.info("selection-tool", message, detail),
				warn: (message, detail) => void appLogger.warn("selection-tool", message, detail),
			},
		});
		// 预热放在 registerIpc 之后（见下方 assemble 段）：浮窗加载即会 settings.get / agentProfiles.getSnapshot，
		// 提前 warmUp 会让首帧拿到「服务未就绪」的拒绝（只是闪一下默认主题，但没必要）。
		quitCleanup.register("selection-tool", () => {
			selectionClipboardWatcher?.dispose();
			selectionClipboardWatcher = null;
			windowsSelectionCapture?.dispose();
			windowsSelectionCapture = null;
			selectionToolService?.dispose();
		});
		// 市场设置的「系统级划词」开关保存后即时生效（不必重启应用）。
		agentProfileStore.onChanged(() => syncSelectionToolShortcut());
		syncSelectionToolShortcut();
		// 同一台机器可能同时跑 dev 与安装版：后启动的实例会因 globalShortcut 被前者占用而注册失败。
		// 用户切回窗口/关掉另一个实例时重试一次，不必重启；仍失败则补发一次可执行提示。
		app.on("browser-window-focus", () => {
			syncSelectionToolShortcut();
			flushSelectionShortcutConflictNotice();
		});
		// #354：身份归并会把被吸收的历史会话 ID 从 catalog 移除，而侧栏置顶按稳定 ID 存在
		// settings.json 里，不迁移就是死链（用户看到置顶丢失）。必须在本行完成——它早于
		// createWindow，渲染层首次 settings.get 拿到的就是迁移后的值。
		await migrateMergedSessionPinnedIds({
			listCatalogSessions: () => sessionCatalog.listEntries(),
			readPinnedSessionIds: () => settingsStore.get().pinnedSessionIds,
			writePinnedSessionIds: (ids) => settingsStore.update({ pinnedSessionIds: ids }),
			logWarning: (cause) => void appLogger.warn("session-catalog", "Merged session id migration for pinned sessions failed", { cause }),
		});

		// ── 旧禁用记录 → pi 原生配置迁移（计划 A3/A5）──
		// 启动期一次性执行：旧列表一旦被清理，原生过滤就是唯一生效来源。
		// 失败/未解析时保留旧记录并记日志（下次启动幂等重试），不静默打开用户禁用的资源。
		piResourceStateStore = new PiResourceStateStore(join(app.getPath("userData"), "pi-native-resources.json"));
		piResourceConfigService = new PiResourceConfigService(
			{
				globalSettingsPath: () => join(configManager.getConfigDir(), "settings.json"),
				resolveProject: async (projectId) => {
					const project = projectStore.get(projectId);
					// pi 原生资源配置作用在本机 `.pi/settings.json`：远端项目没有本机 root，按「项目不适用」返回 null。
					if (!project || project.kind === "chat" || !isLocalProject(project)) return null;
					const root = project.path;
					const settings = settingsStore.get();
					const resourceWslDistro = project.environment === "wsl" ? (project.wslDistro ?? settings.wslDistro) : undefined;
					const trustPath = process.platform === "win32" && resourceWslDistro !== undefined ? toWslLinuxPath(root, { distro: resourceWslDistro }) : root;
					return { root, trusted: (await configManager.getProjectTrustDecision(trustPath)) === true };
				},
			},
			piResourceStateStore,
			{ projectTrust: async (projectId, _root) => (await configManager.getProjectTrustDecision(projectStore.get(projectId)?.path ?? "")) === true },
		);
		/**
		 * 迁移依赖：全局与项目共用（项目迁移也需要全局资源做名称→路径映射）。
		 * 迁移是「旧禁用记录 → 原生过滤规则」的唯一入口，必须在任何 Agent spawn 前跑完，
		 * 否则退出白名单后旧记录不再有任何生效途径（见计划 A5）。
		 */
		const migrationDeps: import("./config/piResourceMigrationRunner").MigrationRunnerDeps = {
			service: piResourceConfigService,
			state: piResourceStateStore,
			readSettings: () => settingsStore.get(),
			resolveGlobalResources: async () => {
				const settings = settingsStore.get();
				const resources: ResolvedMigrationResource[] = [];
				// 迁移只需要「旧禁用记录里的名字 → 原生过滤匹配值」的映射，直接用各 Manager
				// 的列表（它们已按原生规则投影状态，但这里要的是全部条目，与启用与否无关）。
				const extensionList = await extensionManager?.list(false).catch(() => null);
				for (const item of extensionList?.extensions ?? []) {
					if (!item.source || item.builtIn) continue;
					// 包安装的扩展：`item.path` 是**包目录**，不能当顶层过滤值（写进去就是惰性规则，
					// 让开关投影误判停用）；带 packageSource 后由规划器改成「整包停用」。
					resources.push({ kind: "extensions", name: item.source, value: item.path ?? item.source, scope: item.scope === "project" ? "project" : "user", ...(isPackageSource(item.source) ? { packageSource: item.source } : {}) });
				}
				const skills = await skillManager?.list().catch(() => null);
				for (const skill of skills?.skills ?? []) {
					// pideck-global（自带技能）也要参与映射：老版本把它们装在 pi 的全局目录，
					// 迁移时把旧禁用名翻成新路径的 -path 规则，用户的停用意图才不会丢。
					if (skill.sourceId !== "pi-global" && skill.sourceId !== "agents-global" && skill.sourceId !== "pideck-global") continue;
					resources.push({ kind: "skills", name: skill.name, value: skill.path, scope: "user" });
				}
				const prompts = await promptManager?.list().catch(() => null);
				for (const template of prompts?.templates ?? []) {
					if (template.scope === "project") continue;
					resources.push({ kind: "prompts", name: template.name, value: template.path, scope: "user" });
				}
				return resources;
			},
			readProjectLegacyState: async (projectId) => projectResourceManager.readProjectLegacyDisables(projectId),
			resolveProjectResources: async (projectId) => {
				const project = projectStore.get(projectId);
				if (!project) return [];
				const resources: ResolvedMigrationResource[] = [];
				for (const skill of (await projectResourceManager.list(projectId).catch(() => null))?.skills ?? []) {
					if (typeof skill.path === "string") resources.push({ kind: "skills", name: skill.name, value: skill.path, scope: "project" });
				}
				return resources;
			},
			writeSettingsPatch: async (patch) => {
				await settingsStore.update(patch as Parameters<typeof settingsStore.update>[0]);
			},
			clearProjectLegacyState: async (projectId, patch) => {
				await projectResourceManager.clearProjectLegacyDisables(projectId, patch);
			},
			logger: { info: (scope, message, detail) => void appLogger.info(scope, message, detail), warn: (scope, message, detail) => void appLogger.warn(scope, message, detail) },
		};
		/**
		 * 包目录路径规则清理（幂等）：历史迁移曾把「指向包安装的禁用」写成顶层 `-<包目录>`，
		 * 对 pi 惰性却让列表投影误判停用。npm 包只装在两处：全局 install 目录与项目 `.pi/npm`。
		 */
		const packageRootRuleRepairDeps: PackageRootRuleRepairDeps = {
			service: {
				stripPackageRootResourceRules: async (scope, packageDirs) => {
					const service = piResourceConfigService;
					if (!service) return { ok: false, error: "pi resource service unavailable", removed: [] };
					return service.stripPackageRootResourceRules(scope, packageDirs);
				},
			},
			npmRoot: (scope) => {
				if (scope.scope === "project") {
					const project = projectStore.get(scope.projectId);
					return project && isLocalProject(project) ? join(project.path, ".pi", "npm", "node_modules") : "";
				}
				return join(configManager.getConfigDir(), "npm", "node_modules");
			},
			logger: { info: (scope, message, detail) => void appLogger.info(scope, message, detail), warn: (scope, message, detail) => void appLogger.warn(scope, message, detail) },
		};
		/** 迁移后刷新投影缓存：否则列表仍按旧列表显示，与实际生效的原生规则不一致。 */
		const refreshAllProjections = async (): Promise<void> => {
			await Promise.all([refreshSkillProjection(), refreshPromptProjection(), refreshExtensionProjection()]);
		};
		let globalMigrationRun: Promise<void> | null = null;
		const projectMigrationRuns = new Map<string, Promise<void>>();
		/**
		 * 确保该作用域的旧禁用记录已迁移（幂等、并发复用同一个 Promise）。
		 * Agent spawn 前必须 await：迁移未完成就启动会话会把用户停用的资源重新加载。
		 */
		const ensureResourceMigration = async (projectId?: string): Promise<void> => {
			if (!projectId) {
				globalMigrationRun ??= runGlobalResourceMigration(migrationDeps).then(async (result) => {
					// 先清历史残留的包目录规则，再刷新投影：否则开关仍会显示成停用。
					await runPackageRootRuleRepair(packageRootRuleRepairDeps, { scope: "global" });
					await refreshAllProjections();
					if (result.errors.length > 0) {
						void appLogger.warn("migration", "Global resource migration reported problems", { status: result.status, errors: result.errors });
					}
				});
				return globalMigrationRun;
			}
			let run = projectMigrationRuns.get(projectId);
			if (!run) {
				run = runProjectResourceMigration(migrationDeps, projectId).then(async (result) => {
					await runPackageRootRuleRepair(packageRootRuleRepairDeps, { scope: "project", projectId });
					await refreshAllProjections();
					if (result.errors.length > 0) {
						void appLogger.warn("migration", "Project resource migration reported problems", { projectId, status: result.status, errors: result.errors });
					}
				});
				projectMigrationRuns.set(projectId, run);
			}
			return run;
		};
		// 启动即开始全局迁移（不阻塞窗口创建），并把它交给 AgentManager 在 spawn 前 await。
		void ensureResourceMigration();
		ensurePiResourceMigration = ensureResourceMigration;
		agentManager.configureResourceMigrationGate(ensureResourceMigration);
		// 多后端网关装配：pi + dsh + acp（DSH 在窗口创建后后台预热，失败时按需重试）。
		// ACP 是 opt-in（settings.acpEnabled，默认 false）：网关常驻注册，开关是运行时读的（deps.isEnabled），
		// 关闭时 create 直接拒绝——保证「未开启的构建不 spawn 任何 ACP CLI」，
		// 又让设置页开关立即生效（不必重启）。
		// 不按启动时的开关决定是否注册：合成器的事件订阅（onOutput）与能力并集在启动时一次成形，
		// 启动后才补注册的网关收不到事件转发，ACP 时间线会静默无输出；
		// 而 AcpAgentManager 构造函数不 spawn 任何进程，常驻注册本身零运行时成本。
		// 开启后每次 create 即 spawn 对应 CLI，无预热。
		acpAgentManager = new AcpAgentManager({
			piLocator,
			// 每次 session/new 现算：项目键依赖会话 cwd，ACP CLI 因此获得与 pi 同一套记忆工具。
			// 开关关闭时给空数组：ACP v1 该字段必填（opencode 缺它直接 -32602），但也别把工具挂给外部 CLI。
			mcpServers: (cwd) => (settingsStore.get().agentMemoryEnabled ? buildAcpMcpServers(createAgentMemoryMount(cwd)) : []),
			// ACP CLI 是本机进程：远端项目没有本机 cwd，明确不适用（与 ACP 无远端运行时一致）。
			getProject: (projectId) => {
				const project = projectStore.get(projectId);
				return project && isLocalProject(project) ? project : undefined;
			},
			getTools: () => settingsStore.get().acpTools ?? [],
			isEnabled: () => settingsStore.get().acpEnabled === true,
			// ACP 代理：每次开会话实时读，只作用于新 spawn 的 CLI 进程（env 在启动时定格）。
			getProxySettings: () => resolveAcpProxySettings(settingsStore.get()),
			// 工具级配置记忆：新建会话重放；用户切换成功即写回 settings（只记思考/模式/权限，不含模型）。
			getToolConfigDefaults: (toolId) => settingsStore.get().acpToolConfigDefaults?.[toolId],
			rememberConfigOption: (toolId, optionId, value) => {
				const settings = settingsStore.get();
				// 工具已被删除/改名后不再写记忆，避免产生永不消费的孤儿条目。
				if (!(settings.acpTools ?? []).some((tool) => tool.id === toolId)) return;
				const next = withAcpConfigDefault(settings.acpToolConfigDefaults ?? {}, toolId, optionId, value);
				if (next) void settingsStore.update({ acpToolConfigDefaults: next });
			},
			// ACP 超时口径运行时读口：每次布防/派发实时读 settings（变更后新回合生效，
			// 不需要重启）；undefined 回落代码内默认（stall 180s / turn 15min）。
			readAcpTimeoutSettings: () => {
				const settings = settingsStore.get();
				return { promptStallTimeoutMs: settings.acpPromptStallTimeoutMs, promptTurnTimeoutMs: settings.acpPromptTurnTimeoutMs };
			},
			// ACP 回合失败自动重试口径：与超时同源实时读，变更后新回合生效。
			// 未设置时各项为 undefined，由 acpTurnRetry.resolveAcpTurnRetrySettings 落回代码内默认。
			readAcpTurnRetrySettings: () => {
				const settings = settingsStore.get();
				return { enabled: settings.acpTurnRetryEnabled, maxRetries: settings.acpTurnRetryMaxRetries, baseDelayMs: settings.acpTurnRetryBaseDelayMs };
			},
			// Ask 通知：与 pi 共用同一份门控/toast；完成通知由 composite.onAgentSettled 统一补。
			notify: { askPending: (input) => notifyAgentAskPending(agentToastDeps(), input) },
			// configOptions 变更推送：set_config_option 响应/config_option_update 通知都走同一事件,
			// 渲染层按 agentId 隔离(旧 agent 迟到事件写旧 atom,不再被读)。
			onConfigOptionsChanged: (tab, options) => {
				if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ipcChannels.acpSessionConfigChanged, { agentId: tab.id, options: annotateAcpConfigOptions(options) ?? [] });
			},
			// 图片物化落盘：ACP 消息里的 base64 图复用生图 blob 存储（ref 形态回填消息；
			// imagegen 装配在另一段完成，经模块级 ref 延迟取实例）。
			imageStore: {
				put: (data, mimeType) => acpImageBlobStore?.put(data, mimeType) ?? Promise.resolve(null),
			},
			// ACP 会话标题（session_info_update）写回 catalog：ACP 无本地文件，标题在 agent 侧。
			onTitleChanged: (deckSessionId, title) => {
				const entry = sessionCatalog?.get(deckSessionId);
				if (!entry || entry.title === title) return;
				// session_info_update.title 是 agent 侧命名而非用户手动：走 applyAgentTitle
				// （同源 last-wins、不覆盖用户改名、拒收标记脏名）。此前直接 update() 会把 CLI
				// 标题锁成 manual 终态，用户改名在下一个回合就被 CLI 拉回。
				void sessionCatalog
					.applyAgentTitle(deckSessionId, title)
					.then((applied) => {
						if (!applied) return;
						if (mainWindow && !mainWindow.isDestroyed()) {
							mainWindow.webContents.send(ipcChannels.sessionsCatalogRefreshed, { projectId: applied.projectId });
						}
					})
					.catch((error: unknown) => {
						void appLogger.warn("session", "ACP title sync to catalog failed", { deckSessionId, title, error: error instanceof Error ? error.message : String(error) });
					});
			},
			logger: appLogger,
			// 会话归档：投影消息按 acpSessionId 落到 userData/acp-sessions（sha1 文件名 + 原子写）。
			// 为什么需要：ACP 历史此前只在 CLI 侧 + 内存快照（重启即空），CLI 存档被清
			// （换机器 / 清 ~/.codebuddy）后历史就永久丢了，会话内查找也没有检索源。
			// 写时机在 manager 内固定为「回合结算 + stop()/stopAll()」，失败只记日志。
			archive: new AcpSessionArchive({ userDataDir: app.getPath("userData"), logger: appLogger }),
		});
		quitCleanup.register("acp", async () => {
			// stopAll → stop(agent) → 归档写盘（await 到底）：退出前这份快照必须落地。
			await acpAgentManager?.stopAll();
		});
		compositeAgentGateway = new CompositeAgentGateway([agentManager, dshAgentManager, acpAgentManager]);
		// 非 pi 后端没有 AgentManager 的内部完成通知：这里统一补「会话完成」。
		// pi 已经在自己内部发过（门控/文案一致），跳过避免双弹。
		compositeAgentGateway.onAgentSettled((info) => {
			const tab = compositeAgentGateway?.list().find((candidate) => candidate.id === info.agentId);
			if (!tab || (tab.backend ?? "pi") === "pi") return;
			notifySessionFinished(agentToastDeps(), { agentId: info.agentId, title: info.title, ...(tab.deckSessionId ? { sessionId: tab.deckSessionId } : {}) });
		});
		// 记忆学习循环：回合结算后按阈值尝试一次提炼（三后端统一走这里）。
		// 与上面的完成通知不同，pi 会话也要参与——记忆是跨后端的同一份数据。
		// 学习本身是可选增益：任何失败都只进日志，绝不让它反过来影响会话。
		compositeAgentGateway.onAgentSettled((info) => {
			const settings = settingsStore?.get();
			if (!settings?.agentMemoryEnabled || !settings.agentMemoryAutoLearnEnabled) return;
			const tab = compositeAgentGateway?.list().find((candidate) => candidate.id === info.agentId);
			if (!tab) return;
			const mount = createAgentMemoryMount(tab.cwd);
			void runLearnerForAgent(
				{
					root: memoryDirOfMount(mount),
					sources: sourcesOfMount(mount),
					complete: memoryLearnComplete,
					logger: {
						info: (channel, message, meta) => void appLogger.info(channel, message, meta),
						warn: (channel, message, meta) => void appLogger.warn(channel, message, meta),
					},
				},
				tab,
			).catch((error: unknown) => {
				void appLogger.warn("agent-memory", "learn pass crashed", { error: error instanceof Error ? error.message : String(error) });
			});
		});
		// 项目位置注入给会话协调器：远端会话在 pi 上报会话文件之前没有 ssh 身份，"这条会话的 runtime
		// 在哪台机器上"只能由项目 locator 回答（AgentManager 也按它路由 runtime）。位置真相同的单一
		// 来源仍然是 projectStore，这里只给一个只读取值器。
		sessionRuntimeCoordinator = new SessionRuntimeCoordinator(
			sessionCatalog,
			compositeAgentGateway,
			sendAgentPromptWithIntegrations,
			appLogger,
			(projectId) => {
				const project = projectStore.get(projectId);
				return project && !isLocalProject(project) ? project.locator : undefined;
			},
			// 远端会话文件改写端口（P4.5c）：调用时解析——端口在 registerIpc() 里才装配（见模块级声明）。
			() => remoteSessionMessageMutation,
		);
		// 终态惰性解绑（getAgentId → unbindTerminalAgent）发生在查询路径里，必须把解绑推给渲染层：
		// 否则渲染层快照停在 error，红点常亮且「关闭 Agent」永远对不上存在的运行实例。
		sessionRuntimeCoordinator.setDetachedNotifier((binding) => emitSessionRuntimeDetach(binding));
		// catalog 外部删除清理的活性探针：预热激活后 pi 可能尚未写出会话文件，
		// 有活跃绑定的记录不得被扫描当「外部删除」剔掉。
		sessionCatalog.setSessionLivenessProbe((sessionId) => sessionRuntimeCoordinator?.hasLiveRuntime(sessionId) === true);

		// 定时任务调度器与执行编排器装配
		automationRunCoordinator = new AutomationRunCoordinator({
			store: automationStore,
			catalog: sessionCatalog,
			sessionRuntimeCoordinator,
			projectStore,
			gitService,
			logger: appLogger,
			notifyRunFinished: (run, task) => {
				const settings = settingsStore.get();
				if (!settings.enableNotifications || !Notification.isSupported()) return;
				// 仅失焦提醒：窗口在前台时不弹系统通知（设置默认关闭时不生效）
				if (!shouldAlertNow(settings.alertOnlyWhenUnfocused, isMainWindowFocused(mainWindow))) return;
				const isSuccess = run.status === "succeeded";
				// 系统通知固定使用品牌常量，不受运行时通道/打包元数据影响
				const appName = APP_DISPLAY_NAME;
				const body = isSuccess
					? mainCopy("mainNotification.automationDone", { name: task.name })
					: mainCopy("mainNotification.automationFailed", {
							name: task.name,
							error: run.error || run.status,
						});
				const notification = new Notification({
					title: appName,
					body,
					silent: false,
					// 与 AgentManager 同一套 toast XML：品牌字标 + 点击经深链跳回会话（下面 click 处理保留作兜底）
					toastXml: buildToastXml({
						title: appName,
						body,
						launch: notificationLaunchUrl(run.sessionId),
						logoUri: resolveNotificationLogoUri({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }),
					}),
				});
				notification.on("click", () => {
					focusMainWindow();
					if (run.sessionId) {
						queueFocusTarget({ sessionId: run.sessionId });
					}
				});
				notification.show();
			},
			// catalog 变更广播：automation createDraft / dispatch 接受后让侧栏静默重拉，
			// 避免新会话行延迟出现、DSH agent 行先落成孤儿条目（复用 DSH 刷新同一条 IPC 通道）。
			notifySessionCatalogChanged: (projectId) => notifyCatalogRefreshed([projectId]),
		});
		automationScheduler = new AutomationScheduler(automationStore);
		automationScheduler.setTriggerHandler(async (task, scheduledFor, trigger) => {
			await automationRunCoordinator?.enqueueRun(task, scheduledFor, trigger);
		});
		automationScheduler.start();
		quitCleanup.register("automation", () => {
			automationScheduler?.stop();
			automationRunCoordinator?.dispose();
			automationScheduler = null;
			automationRunCoordinator = null;
		});
		setupLinkedSessions();
		// 闲置 agent 自动释放（内存优化）：轮询 agents.list() 自记 idle 时长，释放走
		// coordinator.stopAgentById（解绑 + agents.stop + agents:state 推送，会话状态自动同步）。
		// 设置项（开关/保留数/闲置时长）每次扫描时读取，改设置后下一轮自动生效。
		idleAgentReleaser = new IdleAgentReleaser(
			sessionRuntimeCoordinator,
			compositeAgentGateway,
			() => settingsStore.get(),
			appLogger,
			undefined, // sweepIntervalMs 用默认 60s
			// 释放收尾与进程监控停止路径一致：关终端 + sessions:runtime-detach 推送
			// （缺 detach 时渲染层会话运行标记会停在 running）。
			(agentId, target) => {
				terminalManager.closeAgent(agentId);
				if (target) emitSessionRuntimeDetach(target);
			},
		);
		idleAgentReleaser.start();
		quitCleanup.register("idle-agent-releaser", () => idleAgentReleaser?.stop());
		// 零内容草稿自动清理：小窗/主窗「新建后不用」的空草稿在运行期间定期剔除
		// （语义对齐 SessionCatalog.load 的启动清理，但豁免用户投入信号：命名/选模型/预选配置）。
		// 删除后广播 catalog-refreshed，侧栏静默重拉，空白条目即消失。
		staleDraftReaper = new StaleDraftReaper(
			sessionCatalog,
			sessionRuntimeCoordinator,
			(projectIds) => {
				if (!mainWindow || mainWindow.isDestroyed()) return;
				for (const projectId of projectIds) {
					mainWindow.webContents.send(ipcChannels.sessionsCatalogRefreshed, { projectId });
				}
			},
			appLogger,
		);
		staleDraftReaper.start();
		quitCleanup.register("stale-draft-reaper", () => staleDraftReaper?.stop());
		// 只有 PiDeck 自动命名扩展的专用 marker 才能领取 fresh placeholder。
		// pi /name、JSONL session_info 与重启 get_state 都不会经过这里，catalog 因而
		// 始终是侧栏和 Tab 的显示标题权威。
		// source 决定所有权（#266）：扩展模型标题 "auto" 可升级首条消息的 "fallback"；
		// 反向不可（迟到的首条消息不得压住已生成的模型标题）。
		agentManager.setAutomaticTitleChangedHandler((agentId, rawTitle, source) => {
			const sessionId = sessionRuntimeCoordinator?.getSessionId(agentId);
			if (!sessionId) return;
			// 外部连接的通道指令随首条消息写进会话文件，pi 侧命名扩展读到的是带指令的原文：
			// 标题是另一个出口，这里再剥一次，避免侧栏变成整段指令（2026-10 微信现场）。
			const title = sanitizeAutomaticTitle(rawTitle);
			if (!title) return;
			const entry = sessionCatalog.get(sessionId);
			// 文本相同仍可能是「fallback → auto」的所有权升级（扩展标题与首条消息恰好一致）：
			// 只有来源已确认且非 fallback 时才是真正的 no-op。
			if (!entry || (entry.title === title && entry.titleOrigin !== "fallback")) return;
			void sessionCatalog
				.applyAutomaticTitle(sessionId, title, source)
				.then(() => {
					if (mainWindow && !mainWindow.isDestroyed()) {
						mainWindow.webContents.send(ipcChannels.sessionsCatalogRefreshed, {
							projectId: entry.projectId,
						});
					}
				})
				.catch((error: unknown) => {
					void appLogger.warn("session", "Pi automatic title sync to catalog failed", {
						agentId,
						sessionId,
						title,
						error: error instanceof Error ? error.message : String(error),
					});
				});
		});
		compositeAgentGateway.onOutput((sourceChannel, payload) => {
			if (sourceChannel === agentEventTags.agentsState && Array.isArray(payload)) {
				for (const tab of payload) {
					if (tab && typeof tab === "object" && typeof tab.id === "string") {
						emitSessionRuntimeEvent(tab.id, sourceChannel, tab);
					}
				}
				return;
			}
			if (payload && typeof payload === "object" && "agentId" in payload) {
				const agentId = (payload as { agentId?: unknown }).agentId;
				if (typeof agentId !== "string") return;
				const forwarded = emitSessionRuntimeEvent(agentId, sourceChannel, payload);
				if (!forwarded && sourceChannel === agentEventTags.agentsUiRequest) {
					cancelUnboundUiRequest(payload);
				}
			}
		});

		// 根据已加载的 WSL 设置配置会话扫描器，使其能同时扫描 WSL 中的 pi 会话目录
		/**
		 * 第 14 步：不再根据全局设置切换单例管理器的 WSL HOME。
		 *
		 * 会话扫描按项目档案使用独立 scanner（wslSessionScannerFor），spawn 由 AgentManager 的
		 * 每次启动覆盖值决定；这里只把旧的全局状态清掉，避免残留一个发行版影响其它项目。
		 * 配置/资源页按目标路由：WSL 目标解析发行版 HOME，不回退本机；生产代码里不再有全局
		 * configureWsl 切换共享单例的路径（W1 起用 PiResourceManagerPool）。
		 */
		// 资源作用域池（W1）：本机复用既有四个单例；WSL 目标每次请求重读应用设置（cache key 含 distro/user），
		// 改发行版/用户或退出 WSL 模式后旧实例自动失效重建，绝不回退本机 HOME。
		piResourcePool = createPiResourceManagerPool({
			resolver: createPiResourceTargetResolver({
				readWslIdentity: async () => resolveSettingsWslIdentity(settingsStore.get()),
				resolveEnvironment: async (distro, user) => {
					const { resolveWslEnvironment } = await import("./wsl/WslEnvironment");
					return resolveWslEnvironment(distro, user, { warn: (message, details) => void appLogger?.warn("wsl", message, details) });
				},
				localHome: () => app.getPath("home"),
			}),
			local: {
				skills: () => skillManager,
				prompts: () => promptManager,
				extensions: () => extensionManager,
				xuePrompts: () => xuePromptManager,
			},
			create: createPiResourceManagerFactories({
				translate: mainCopy,
				// WSL 扩展包开关的恢复快照（skills/prompts 不需要）；未装配时 WSL 包开关会明确失败而不是静默成功。
				...(piResourceStateStore ? { resourceState: piResourceStateStore } : {}),
				extension: {
					locator: piLocator,
					getSettings: () => settingsStore.get(),
					getPiDeckSettings: () => settingsStore.get(),
					patchPiDeckSettings: (patch) => settingsStore.update(patch),
					builtInRoots: resolveBuiltInExtensionRoots(),
				},
				xuePrompts: {
					overlayDir: () => promptStoreUpdater.resolveEffectiveOverlayDir(),
					dbStore: xuePromptDbStore ?? undefined,
					xueIndex: xueIndexService ?? undefined,
				},
			}),
		});
		// 全局 WSL 模式：定义见模块级 syncWslConfig（设置保存时热重放同一份逻辑）。
		// 先注册 IPC 并创建窗口：WSL 探测 / pi settings / 代理 / Web 服务都可能卡住或抛错，
		// 不能挡在 createWindow 前面（打包便携版表现为「启动没反应」，dev 因热路径较短不易复现）。
		// 模型请求快照端点：只绑 127.0.0.1，起不来就静默跳过（快照不工作，pi 与 PiDeck 照常）。
		// 必须在任何 Agent spawn 之前启动，否则首个 agent 拿不到 PIDECK_MODEL_TRACE_URL。
		// 放在 registerIpc 之前：端点与 IPC 注册无依赖，早启动早就绪。
		void getModelTraceServer()
			.start()
			.then((info) => {
				if (!info) return;
				void appLogger?.info("app", "Model trace endpoint ready", { baseUrl: info.baseUrl });
			})
			.catch((error: unknown) => {
				void appLogger?.warn("app", "Model trace endpoint startup failed", error);
			});
		registerIpc();
		// 系统级划词浮窗预热：功能隐藏期间连窗口都不加载，避免白占一个渲染进程。
		if (SYSTEM_SELECTION_TOOL_ENABLED) void selectionToolWindow?.warmUp().catch(() => undefined);
		// 统一接口聚合层：注册全部域与导入器并冻结（deps 缺省在 domainAssembly.ts 收集，FIND-5）
		registerAllDomains();
		registerFeishuIpc({
			getMainWindow: () => mainWindow,
			feishuBridgeRef,
			agentManager,
			projectStore,
			sessionRuntimeCoordinator,
			feishuSessionRuntimeBindings: imSessionRuntimeBindings,
			getCurrentLocale: currentFeishuLocale,
			// 卡片思考过程跟随 pi 的 hideThinkingBlock（#425）：每次建状态时现读，用户改完立刻生效
			getShowThinking: () => settingsStore.get().showThinking,
		});
		startWeChatBridge({
			appLogger,
			getMainWindow: () => mainWindow,
			projectStore,
			imSessionRuntimeBindings,
			currentMainProcessLocale,
			assign: (patch) => {
				if (patch.wechatService !== undefined) wechatServiceRef.current = patch.wechatService;
			},
		});
		await createWindow();
		// 配置备份（手动模式）：仅在备份目录为空（首次使用）时自动建一份 first-run，
		// 之后不再自动备份。2027-02 性能治理：list() 会对每个备份 JSON 全量解析（内嵌
		// settings/models 原文，可达 MB 级），首启还要同步读 6 个配置文件——原先排在
		// createWindow 之前的同步链上推迟首窗可见（注释自称"不挡首帧"与执行点矛盾）。
		// 挪到窗口创建后执行，失败仅记录，不阻断启动。
		setImmediate(() => {
			configBackupManager?.ensureInitialBackups();
		});
		// Quick tasks should not wait for unrelated WSL/proxy startup probes. The controller
		// retains validated intent until the renderer subscribes or requests its snapshot.
		const coldStartTarget = extractFocusTargetFromArgv(process.argv);
		await quickTaskChrome.applyLaunchTarget(coldStartTarget);
		setupTray(trayDeps);
		// 粘贴文件启动清理：删除超过保留期的落盘文件（fire-and-forget，不挡首帧）
		void cleanupPasteFiles?.().catch((error: unknown) => {
			void appLogger.warn("app", "Paste file cleanup failed during startup", error);
		});
		// DSH runtime 自动更新：升级 PiDeck 后若已装 runtime 与声明版本不一致
		// （outdated，被硬门控挡住无法启动 host），启动期后台自动重装配套版本并回收旧
		// 版本目录——与其让用户手动点「重新安装」，不如升级后首次启动自动完成。
		// notInstalled 不自动装（用户未选择使用 DSH，保持安装引导）；dev 与打包版都允许
		// 手动安装，但自动更新只处理已有 runtime 的版本错配。fire-and-forget，不挡首帧。
		void autoUpdateDshRuntimeIfOutdated({
			getStatus: () => dshRuntimeStatus.getStatus(),
			refresh: () => dshRuntimeStatus.refresh(),
			install: () => dshRuntimeInstaller.installFromIndex(),
			listInstalled: () => dshRuntimeManager.listInstalled(),
			resolveActiveDirName: () => dshRuntimeManager.resolveActive()?.dirName,
			uninstall: async (dirName) => {
				await dshRuntimeManager.uninstall(dirName);
			},
			appVersion: () => app.getVersion(),
			isPackaged: () => app.isPackaged,
			// 自动更新完成前 warmup 因 outdated 被跳过：装好后补一次预热（门控见 dshWarmupEnabled）。
			onRuntimeReady: () => {
				startDshHostInBackground(dshHost, appLogger, {
					enabled: dshWarmupEnabled(),
				});
			},
			log: (scope, message, detail) => void appLogger.info(scope, message, detail),
		}).catch((error: unknown) => {
			void appLogger.warn("dsh-runtime", "DSH runtime auto-update crashed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});

		// 窗口已可用后预热 DSH：runtime 已安装且用户没手动停止过 host 才后台 boot。
		// 不再要求默认后端是 dsh——装 runtime 本身就是显式选择，host boot 约 20s，装了就该提前拉起；
		// 未安装时 boot 必然失败（白起 utilityProcess），手动停止（dshManualStopped）优先级最高，
		// 两种情况都不预热（不弹错误，用户下次显式启动即可）。发送/历史/配置路径仍由 ensureStarted 兜底。
		startDshHostInBackground(dshHost, appLogger, {
			enabled: dshWarmupEnabled(),
		});

		// 模型 capability cache 的 hydration 在 syncWslConfig 后启动，确保它与 PiProcess
		// 使用同一套 WSL HOME/config 目录；不阻塞首帧。
		void syncWslConfig()
			.then(async () => {
				// pi standby 启动预热放在这里：必须晚于 syncWslConfig（WSL 项目的 spawn 参数依赖
				// agentManager 的 WSL 快照），但早于模型目录刷新/能力 hydration——三者互不依赖，
				// 先让 pi 进程开始加载扩展，越早开始越能把启动耗时藏进启动空窗。
				warmStandbyAgentAtStartup();
				// 冷启动先刷 pi 模型目录缓存（models-store.json）再 hydration：PiDeck 的 RPC
				// 进程都带 --offline，pi 启动时的自动目录网络刷新被跳过；目录若不主动刷新
				// 只能靠 TUI 更新，可能长期滞后（官方 provider 新模型导致「列表有、Agent
				// 快照没有」的选择失败，2026-08 deepseek 场景）。目录过期才刷（mtime 节流），
				// 过期时刷新失败也不挡启动——下次冷启动再试，watcher 兜底失效已发布快照。
				// watcher 必须在这两步之后安装：否则启动目录刷新或 Pi 初始化期间的文件事件
				// 会立刻 invalidate 正在进行的 hydration，造成同一启动周期重复 spawn 临时 Pi。
				await refreshModelCatalogIfStale(piLocator, settingsStore, configManager.getConfigDir()).then((result) => {
					if (result.ran) {
						void appLogger.info("app", "Pi model catalog refresh at startup", {
							ok: result.ok,
						});
					} else if (result.ok) {
						void appLogger.debug("app", "Pi model catalog is fresh; skip refresh");
					}
				});
				await piModelCapabilityCache?.ensure();
				piModelCapabilityCache?.watchConfigDirectory();
			})
			.catch((error) => {
				void appLogger.warn("app", "WSL config sync or Pi capability hydration failed", error);
			});
		void migrateLegacyBuiltInExtensions().catch((error) => {
			console.error("Failed to migrate legacy built-in extensions:", error);
			void appLogger?.error("extensions", "Failed to migrate legacy built-in extensions", { error: error instanceof Error ? error.message : String(error) });
		});
		void ensureAllPiSettingsDefaults().catch((error) => {
			console.error("Failed to ensure pi settings defaults:", error);
			void appLogger?.error("settings", "Failed to ensure pi settings defaults", { error: error instanceof Error ? error.message : String(error) });
		});
		void appLogger.info("app", "Application started", {
			version: app.getVersion(),
			platform: process.platform,
			arch: process.arch,
			installationType: settingsStore.get().installationType,
		});
		void applyDesktopProxy(settingsStore.get()).catch((error) => {
			void appLogger.warn("settings", "Desktop proxy skipped after apply failure", error);
		});
		void webServiceManager.applySettings(settingsStore.get()).catch((error) => {
			console.error("Failed to start web service:", error);
			void appLogger?.error("web", "Failed to start web service", { error: error instanceof Error ? error.message : String(error) });
			void appLogger.warn("web", "Web service disabled after apply failure", {
				error: error instanceof Error ? error.message : String(error),
			});
			void settingsStore.update({ webServiceEnabled: false });
		});
		// 外网访问初始探测：探测二进制/登录态与既有 serve 配置（只读），不自动拉起任何渠道
		void remoteAccessManager
			.refresh()
			.then(() => remoteAccessManager.syncWebService())
			.catch((error) => {
				void appLogger.warn("web-remote", "Remote access initial probe failed", { error: error instanceof Error ? error.message : String(error) });
			});

		// 🆕 自动连接：如果已有 Bot 配置，自动启动飞书连接
		autoConnectFeishu();

		// 内存分析模式（PIDECK_MEMORY_PROFILE=1）：尽早开始采样，覆盖窗口创建/加载全过程。
		// 采样失败不阻塞启动（诊断工具降级为不可用）。
		if (isMemoryProfileEnabled()) {
			void startMemoryProfile(() => agentManager.hasActiveStreaming())
				.then((handle) => {
					memoryProfileHandle = handle;
					quitCleanup.register("memory-profile", () => memoryProfileHandle?.stop());
				})
				.catch((error) => {
					console.error("Failed to start memory profile:", error);
					void appLogger?.error("memory", "Failed to start memory profile", { error: error instanceof Error ? error.message : String(error) });
				});
		}
		// 设置里的开发诊断：热启停，不必改环境变量重启。默认关，生产零开销。
		if (settingsStore.get().developerDiagnostics) {
			void diagnosticsMonitor?.setEnabled(true).catch((error) => {
				console.error("Failed to start developer diagnostics:", error);
				void appLogger?.error("diagnostics", "Failed to start developer diagnostics", { error: error instanceof Error ? error.message : String(error) });
			});
		}

		// 项目列表可能位于杀软/同步盘较慢的 userData；窗口先显示，随后异步加载，避免 packaged app 打开时白屏等待。
		// 必须在冷启动跳转目标解析之前开始（并等它完成）：否则 findByPath 命中空项目表，
		// 已收录目录也会被当成新目录弹「添加为项目」（实测右键打开两次都走了 add 链路）。
		const projectStoreLoadPromise = projectStore.load();
		projectStoreReady = projectStoreLoadPromise.catch(() => undefined);
		// 心跳快照里的 projects_total 取自 projectStore.list()，必须等项目表加载结束再发，
		// 否则恒为空表、projects_total 恒为 0（2026-10 线上 389 条快照全部为 0 即此因）。
		// projectStoreReady 已吞掉加载失败，失败时也照发（快照按空表上报）。
		void projectStoreReady.then(() => sendTelemetryHeartbeat());
		void projectStoreLoadPromise
			.then(async () => {
				// 启动时自动收敛一次残留 rebind（设计 Q8）：两个 store 都已 load，失败只留横幅。
				void remoteHostRebindIpc?.resumePendingAtStartup();
				// load() 已丢掉 e2e 临时项目；对应 catalog 映射一并清掉，侧栏会话不会再挂回来。
				const knownProjectIds = new Set(projectStore.list().map((project) => project.id));
				const orphanProjectIds = new Set(
					sessionCatalog
						.listEntries()
						.map((entry) => entry.projectId)
						.filter((projectId) => !knownProjectIds.has(projectId)),
				);
				for (const projectId of orphanProjectIds) {
					// 启动期孤儿清理是 best-effort（下一次启动会重试），但不能静默：失败必须留一条可见日志。
					await sessionCatalog.removeByProjectId(projectId).catch((error: unknown) => {
						appLogger.warn("project", "Orphan session catalog sweep failed", { projectId, cause: error instanceof Error ? error.message : String(error) });
					});
				}
				broadcastVisibleProjects();
				// 项目表就绪后再扫 DSH_HOME：cwd 才能匹配已注册项目；不启动 host。
				await scheduleDshForeignAutoImport();
			})
			.catch(() => undefined);

		// 冷启动通知/右键唤起：应用未运行时点击系统通知或右键菜单，本进程即为唯一实例（无次实例 .focus
		// 流转），argv 携带 pideck:// URL 或 --open-project 参数，窗口就绪后跳转对应会话/项目。
		// 页面仍在加载时直接 send 会丢（preload/React 监听未注册），故走 pending 队列：
		// did-finish-load 补发一次 + renderer 挂载后主动拉取（见 queueFocusTarget 注释）。
		// catalog 可能尚未加载完，renderer 侧监听会小间隔重试直到能解析到会话记录。
		if (coldStartTarget) {
			if (coldStartTarget.projectPath) {
				// 项目表就绪后再判定是否已收录：否则已注册目录也会弹「添加为项目」。
				await projectStoreReady;
				const existing = projectStore?.findByPath(coldStartTarget.projectPath);
				if (existing) {
					queueFocusTarget({ projectId: existing.id });
				} else {
					queueFocusTarget({ projectPath: coldStartTarget.projectPath });
				}
			} else if (coldStartTarget.sessionId) {
				queueFocusTarget({ sessionId: coldStartTarget.sessionId });
			}
		}
		// renderer 挂载后拉取 pending 跳转目标（一次性，取走即清空）
		ipcMain.handle(ipcChannels.petGetFocusTargetPending, () => {
			const target = pendingFocusTarget;
			pendingFocusTarget = null;
			return target;
		});
		void detectExternalEditorsOnFirstLaunch().catch((error) => {
			void appLogger.warn("editor", "External editor first launch detection failed", error);
		});

		// 桌面宠物系统：新增模块，默认关闭（petEnabled=false），不触碰现有 IPC 与主窗逻辑
		petSystem = new PetSystem({
			// 全后端聚合：ACP/DSH 的 running/idle/error/waiting 与完成气泡都由 composite 提供。
			agentSource: compositeAgentGateway,
			settingsStore,
			getMainWindow: () => mainWindow,
			resolveSessionId: (agentId) => sessionRuntimeCoordinator.getSessionId(agentId),
			translate: (key, params) => mainCopy(key, params),
			// 宠物唤回主窗口：与托盘/通知共用同一条唤起路径，保留最大化/全屏
			revealMainWindow: (window) => revealMainWindow(window),
			recreateMainWindow: async () => {
				await createWindow();
				return mainWindow!;
			},
		});
		// C12：退出清理登记（before-quit 统一 runAll）
		quitCleanup.register("pet", () => {
			petSystem?.stop();
			petSystem = null;
		});
		void petSystem.start().catch((error) => {
			void appLogger.warn("pet", "Pet system start failed", error);
		});

		startSoundsAndAnnouncements({
			appLogger,
			agentManager,
			settingsStore,
			quitCleanup,
			getMainWindow: () => mainWindow,
			assign: (patch) => {
				if (patch.soundAlertService !== undefined) soundAlertService = patch.soundAlertService;
				if (patch.announcementService !== undefined) announcementService = patch.announcementService;
			},
		});

		// CUA（Computer Use Agent）：观察屏幕 + 注入鼠标/键盘输入，供 pi Agent 通过
		// `pideck-cua` MCP（主进程内 StreamableHTTP 端点）调用。默认关闭（cuaEnabled=false）：
		// 只有开启时才监听本地端点并写入 ~/.pi/agent/mcp.json，关闭时零副作用（不监听、不改 pi 配置）。
		// 真实输入注入另有「每次操作审批门 + 全局/会话杀开关」双重兜底（见 cua/CuaGate.ts）。
		// 浏览器 Agent：主进程 CDP 驱动内置 webview 的 browser_* 工具。
		// 与 CUA 共用同一个 MCP host 与 mcp.json 条目，但开关、审批门、autoApprove 独立；
		// 默认关闭，页面内容按不可信数据处理（docs/archive/plans/browser-agent-plan.md）。
		browserAgentService = new BrowserAgentService({
			listAllWebContents: () => webContents.getAllWebContents(),
			isBrowserPanelGuest: (guest) => guest.session === session.fromPartition(BROWSER_PANEL_PARTITION),
			getAutoApprove: () => settingsStore.get().browserAgentAutoApprove,
		});
		cuaService = new CuaService({
			getMainWindow: () => mainWindow,
			log: (domain, message, details) => void appLogger.info(domain, message, details),
			// 免审批设置实时读取：改设置即时生效，无需重启 CUA 服务。
			getAutoApprove: () => settingsStore.get().cuaAutoApprove,
			browserAgent: browserAgentService,
		});
		// 启动时按真实开关决定 host 是否监听：任一能力启用即启动，两者都关则零副作用。
		void cuaService
			.applySettings({
				cuaEnabled: settingsStore.get().cuaEnabled,
				browserAgentEnabled: settingsStore.get().browserAgentEnabled ?? false,
			})
			.catch((error) => {
				void appLogger.warn("cua", "CUA/browser agent service start failed", error);
			});
		// 智能体记忆：默认关闭。关闭时若上一次开过，把 mcp.json 里自己那一项删掉（别人的条目不动），
		// 否则「关掉开关」在 pi 侧仍会拉起记忆工具。注册失败不阻断启动——记忆是增强项。
		try {
			const synced = syncAgentMemoryRegistration({ enabled: settingsStore.get().agentMemoryEnabled ?? false, mount: createAgentMemoryMount() });
			void appLogger?.info("memory", "agent memory MCP synced", { action: synced.action, path: synced.path });
		} catch (error) {
			void appLogger?.warn("memory", "agent memory MCP registration failed", { error: error instanceof Error ? error.message : String(error) });
		}
		quitCleanup.register("cua", async () => {
			// runAll 会逐项 await：返回 dispose 的 Promise 保证退出前 host 关闭 + mcp.json 反注册完成（早前 `void` 掉 Promise，退出竞态）。
			await cuaService?.dispose();
			cuaService = null;
		});
		quitCleanup.register("browser-agent", () => {
			browserAgentService?.dispose();
			browserAgentService = null;
		});
		// C12：catalog 的在途写事务必须在退出前落盘。必须登记在最后一个会写 catalog 的清理任务之后：
		// runAll 顺序执行，而 pi/dsh/acp 的 stopAll、自动化收尾都会回写会话状态；没人等 writeQueue 时，
		// 这些写在 runAll 返回后被进程终止截断，锁文件（先建空文件、owner 后写）就留在盘上，
		// 重启后读不出 owner 的残留锁会被当成活着的写者（照旧只报 SESSION_CATALOG_BUSY）。
		quitCleanup.register("session-catalog-flush", () => sessionCatalog?.flushPendingWrites());

		// 启动后异步检查 RPC 超时时间，如果小于 600 秒则自动修正为 600 秒
		// 避免用户配置的过小超时（如 30 秒）导致启动或命令执行频繁超时
		setTimeout(() => {
			void settingsStore.ensureRpcTimeoutMinimum().catch((error) => {
				void appLogger.warn("settings", "Failed to ensure rpcTimeout minimum", error);
			});
		}, 0);

		// macOS dock 点击或任务栏点击时恢复窗口
		app.on("activate", () => {
			// 窗口销毁后 mainWindow 不会置 null（closed 只满空一次），销毁实例上调
			// show() 会抛 "Object has been destroyed"——降级到重建窗口。
			if (mainWindow && !mainWindow.isDestroyed()) {
				revealMainWindow(mainWindow);
			} else {
				void createWindow().catch((error) => {
					void appLogger.error("app", "Failed to create window on activate", error);
				});
			}
		});
	})
	.catch((error) => {
		// 打包启动链无窗口时用户只能看到「没反应」；必须落盘并尽力弹出错误框。
		console.error("Application startup failed:", error);
		void appLogger?.error("app", "Application startup failed", { error: error instanceof Error ? error.message : String(error) });
		void appLogger?.error("app", "Application startup failed", error);
		void import("electron")
			.then(({ dialog }) => {
				dialog.showErrorBox("PiDeck failed to start", error instanceof Error ? (error.stack ?? error.message) : String(error));
			})
			.catch(() => undefined);
	});

/**
 * 删除用户扩展目录中的 PiDeck 扩展文件（历史部署或已下线扩展）。
 * 内置扩展现改为 -e 从 app resources 加载，用户目录不应再有 pi-deck-* 副本。
 */
async function removeStalePiDeckExtension(extensionName: string, homeDir?: string): Promise<void> {
	const home = homeDir ?? app.getPath("home");
	const targetPath = join(home, ".pi", "agent", "extensions", extensionName);
	await rm(targetPath, { force: true });
	appLogger?.info("extension", "Removed legacy/stale extension", { path: targetPath });
}

/**
 * 升级迁移：清掉历史版本复制到 ~/.pi/agent/extensions 的内置扩展与已下线扩展。
 * 覆盖 Windows home；WSL 启用时同步清理 \\wsl$ 映射 home。
 */
async function migrateLegacyBuiltInExtensions(): Promise<void> {
	const { BUILT_IN_EXTENSIONS } = await import("./extensions/builtInExtensions");
	const legacyNames = [...BUILT_IN_EXTENSIONS, "pi-deck-project-trust.ts", "pi-deck-file-capture.ts"];
	for (const name of legacyNames) {
		await removeStalePiDeckExtension(name).catch(() => undefined);
	}
}

/**
 * 对当前环境和 WSL 环境（如果启用）都补齐 settings.json 默认项。
 * 具体边界（不覆盖不可解析文件、只补缺失键、锁内原子写）在 config/piSettingsDefaults.ts。
 */
async function ensureAllPiSettingsDefaults(): Promise<void> {
	let piVersion = "";
	if (piLocator) {
		piVersion = (await piLocator.check().catch(() => null))?.version ?? "";
	}
	await ensurePiSettingsDefaults(join(app.getPath("home"), ".pi", "agent"), piVersion).catch(() => undefined);
}

// 子进程（含 GPU/utility）异常退出：Mac 上偶发“整窗闪一下”，需要留下 reason/exitCode。
// 注册在 app 级而不是 createWindow 内：窗口重建（macOS activate）会重复叠监听器。
app.on("child-process-gone", (_event, details) => {
	void appLogger.error("process", "Child process gone", {
		...details,
		platform: process.platform,
		arch: process.arch,
	});
});

let quitCleanupStarted = false;
app.on("before-quit", (event) => {
	isQuitting = true;
	// 退出清理统一走登记表（C12）：各常驻资源在创建处 register，这里只负责顺序执行。
	// 新增资源不再改 before-quit；单项失败由 registry 记日志不阻塞其余清理。
	// Electron 不等异步 promise：preventDefault 挡住本次退出，等 runAll 收尾后再
	// app.quit()（重入时放行），否则 whisper/DSH dispose 等异步清理会被进程终止截断。
	// 总预算 5s：任一清理任务挂死不能让应用永远退不出去。
	if (quitCleanupStarted) return;
	quitCleanupStarted = true;
	event.preventDefault();
	const cleanupBudget = new Promise<void>((resolve) => {
		setTimeout(resolve, 5000).unref();
	});
	void Promise.race([quitCleanup.runAll(), cleanupBudget])
		.catch((error) => {
			void appLogger.error("quit", "Quit cleanup crashed", { error: error instanceof Error ? error.message : String(error) });
		})
		.finally(() => {
			app.quit();
		});
});

app.on("window-all-closed", () => {
	// macOS 关闭所有窗口不退出；其他平台如果启用 closeToTray 也不退出
	if (process.platform === "darwin") return;
	if (!isQuitting) return;
	app.quit();
});
