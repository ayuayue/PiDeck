import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, protocol, safeStorage, screen, session, shell, Tray, Notification } from "electron";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { homedir, release as osRelease } from "node:os";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { is } from "@electron-toolkit/utils";
import { PetSystem, type PetSystemDeps } from "./pet";
import { downgradeRunningStartedBefore, downgradeStaleRunning } from "./pi/derivedSubagents";
import { SoundAlertService } from "./sounds/SoundAlertService";
import { registerSoundIpc } from "./ipc/soundIpc";
import { registerSoundProtocol } from "./sounds/soundProtocol";
import { AnnouncementService } from "./announcements/AnnouncementService";
import { registerAnnouncementIpc } from "./ipc/announcementIpc";
import { CuaService } from "./cua/CuaService";
import { AutomationStore } from "./automation/AutomationStore";
import { AutomationScheduler } from "./automation/AutomationScheduler";
import { AutomationRunCoordinator } from "./automation/AutomationRunCoordinator";
import { registerAutomationIpc } from "./ipc/automationIpc";
import { registerFeishuIpc } from "./ipc/feishuIpc";
import { applyLinuxDisplayBackendWorkaround, isUsingLinuxXWaylandWorkaround } from "./linuxDisplayBackend";
import { readBootPreferences } from "./settings/SettingsStore";
import { acquireVersionSingleInstance, type FocusPayload } from "./singleInstance";
import { mainProcessJsFlags, rendererHeapAdditionalArguments } from "./v8HeapLimits";
import { isDevToolsShortcut, toggleMainWindowDevTools } from "./devTools";
import { isShortcutInput, refreshShortcutBindings } from "./appShortcuts";
// 主进程复用共享的接管型扩展识别规则（与渲染层横幅单一来源；纯函数无依赖）。
import { detectThirdPartyMcpExtensions } from "../shared/mcpThirdParty";
import { PiResourceConfigService } from "./config/PiResourceConfigService";
import { isPackageSource, isEntryDisabled, packageSourceOf } from "./config/PiResourceConfigService";
import { projectResourceEnabled } from "./config/piResourceRules";
import { PiResourceStateStore } from "./config/PiResourceStateStore";
import { readPiConfigFile } from "./config/piConfigFileStore";
import { runGlobalResourceMigration, runProjectResourceMigration } from "./config/piResourceMigrationRunner";
import type { ResolvedMigrationResource } from "./config/piResourceMigration";
import type { PiResourceScope } from "../shared/types/piResources";
import { createWindowZoomShortcutHandler } from "./windowZoom";
import { DEFAULT_DEV_USER_DATA_NAME, isSharedDevBranch, readDevGitBranch, resolveDevUserDataDirName, sanitizeDevBranchSegment } from "./devIsolation";
import { KEEP_DEV_HTTP_CACHE_ENV, clearDevRendererCache } from "./devRendererCache";
import { isPortablePackagedEnv, resolveAppUserDataDir, resolveChannelDevDataDir, resolvePackagedUserDataDir } from "./portableUserData";
import { readDataEnvDecision, validateStartupDataEnv, writeDataEnvDecision } from "./dataEnv/dataEnvMarker";
import { registerDataEnvIpc } from "./ipc/dataEnvIpc";
import { ChannelSwitchService } from "./update/ChannelSwitchService";
import { registerChannelSwitchIpc } from "./ipc/channelSwitchIpc";
import { resolveUpdateChannel } from "./update/channelIdentity";
import { APP_DEEP_LINK_SCHEME } from "./utils/deepLinkScheme";
import { extractFocusTargetFromArgv } from "./utils/focusTarget";
import type { Project, StartupWindowMode } from "../shared/types";
import type { DataEnvMode } from "../shared/types/dataEnv";
// 使用 ?asset 后缀导入图标，electron-vite 会在构建时将其复制到输出目录并提供正确的运行时路径
// 这解决了打包后 build/ 目录不在 asar 中导致托盘图标丢失的问题
import iconPath from "../../build/icon.png?asset";
import { applyTrayLogoStyle, applyWindowLogoStyle, resolveLogoImage } from "./appWindowLogo";

// 构建标记：npm run dist:*:dev 打包时由 vite define 注入 true（构建期替换，非运行时环境变量）。
declare const __PIDECK_DEV_BUILD__: boolean;

// dev 构建（PiDeck Dev 安装包）只影响通知归属（AUMID）与 deep link scheme（pideck-dev://），
// userData 与正式版**共用** pi-desktop——双通道共用数据目录是刻意决策（2026-09）：
// 用户在 stable / dev 安装包之间切换不丢 settings / 会话 / 扩展配置。
// 未打包的 npm run dev 仍隔离到 pi-desktop-dev(±分支后缀)，避免开发调试误写坏真实数据。
const isDevBuild = !app.isPackaged || __PIDECK_DEV_BUILD__;

// E2E（Playwright 驱动）静默运行：窗口显示但不抢焦点、不最大化铺满屏，
// 避免打断用户在其他软件的输入。fixture 通过 env PIDECK_E2E=1 标识。
const isE2E = process.env.PIDECK_E2E === "1";

// 冷启动计时锚点（2026-10 流畅度审计）：里程碑在 whenReady 与 showMainWindowOnce 记录，
// 日志对比 sinceModuleLoadMs / processUptimeMs 两个口径即可观测启动回归。
const bootAnchorMs = Date.now();

// userData 决策（三分支判定在 portableUserData.resolveAppUserDataDir，单测覆盖）：
// - 未打包 npm run dev：功能分支再按 git 分支名拆目录（pi-desktop-dev-<branch>），
//   避免多个 worktree 同时启动共用 catalog / 单实例锁 / DSH home；main/dev 仍用历史目录。
// - 打包态（stable 与 dev 通道安装包）：共用历史 %APPDATA%/pi-desktop（便携版 exe 同级 data/）。
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
const channelDevDataDir = updateChannel === "dev" ? resolveChannelDevDataDir({ appDataDir: app.getPath("appData"), portableExeDir: process.env.PORTABLE_EXECUTABLE_DIR }) : "";
const devDataMode: DataEnvMode | null = updateChannel === "dev" ? (readDataEnvDecision(channelDevDataDir)?.dataMode ?? null) : null;
// 共用数据目录：既是 setPath 的 shared 分支，也是数据导入的源目录（与 fallbackSharedDir 同源，规格 §6 单向正式→dev）。
// 安装版历史根已由 %APPDATA%/pi-desktop 更名为 %APPDATA%/PiDeck：老用户首启在这里做一次性迁移
// （整目录改名 + 持久化绝对路径改写 + pi 会话 encoded 目录改名），迁移失败自动回退旧目录、下次启动重试。
// Windows 便携 exe 落到 PORTABLE_EXECUTABLE_DIR/data，与安装版隔离（否则同版本单实例锁让第二次启动静默退出）。
// 迁移只接管「打包且非显式目录」这条路径；未打包调试态有自己的 -dev 目录，不参与更名。
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
		unpackagedDevDir: join(app.getPath("appData"), devUserDataDirName),
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
	const devAppId = devUserDataDirName === DEFAULT_DEV_USER_DATA_NAME ? "com.ayuayue.pi-desktop-dev" : `com.ayuayue.pi-desktop-dev.${sanitizeDevBranchSegment(devGitBranch ?? "detached")}`;
	app.setAppUserModelId(isDevBuild ? devAppId : "com.ayuayue.pi-desktop");
}

// 注册 deep link 自定义协议：系统通知点击（toast activationType="protocol"）通过该协议唤起应用，
// 唤起实例的 argv 携带 pideck://session/<id> URL，主进程据此跳转对应会话。
// 仅 packaged 应用注册：dev 模式跑的是 electron 二进制，注册会把协议关联劫持到 electron.exe，
// 覆盖已安装正式版的关联；dev 模式下通知点击依赖 Electron 原生 click 事件聚焦即可。
// 安装包内 electron-builder 的 protocols 配置也会在安装时写入注册表，此处是运行时兜底。
// dev 通道构建注册 pideck-dev://（安装清单同 scheme）：注册表按 scheme 为键，
// 两通道同 scheme 会互相抢占关联，点击通知会唤起错误的通道。
if (app.isPackaged) {
	app.setAsDefaultProtocolClient(APP_DEEP_LINK_SCHEME);
}

// 按「应用版本」隔离的单实例：同版本复用窗口，不同版本可并行。
// 双通道共用 userData（pi-desktop）的前提下，锁文件仍按版本分文件：
// stable 与 dev 通道版本号不同即可并存；同版本（含同版本的两个通道包）会复用窗口。
// 不用 Electron requestSingleInstanceLock：它按 userData 全局互斥，会导致 0.6.7 与 0.6.8 无法同开。
// focus 回调稍后挂到 focusMainWindow（定义在文件后部），避免顶层 TDZ。
// payload 携带次实例的 argv，可解析「点击系统通知」激活时携带的跳转目标。
let focusExistingWindow: ((payload?: FocusPayload) => void) | null = null;
const singleInstanceEnabled = bootPreferences.singleInstance;
const versionSingleInstance = acquireVersionSingleInstance(singleInstanceEnabled, app.getVersion(), (payload) => {
	focusExistingWindow?.(payload);
});
const gotSingleInstanceLock = versionSingleInstance.isPrimary;
if (singleInstanceEnabled && !gotSingleInstanceLock) {
	// 同版本已有实例：立即退出，由主实例 watch .focus 后唤起窗口。
	// 用 exit(0) 而不是 quit()：第二进程尚未 ready，quit 更慢。
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
import { ipcChannels } from "../shared/ipc";
import { mainProcessT, normalizeMainProcessLocale, type MainProcessLocale, type MainProcessTranslationKey } from "../shared/i18n/mainProcessCopy";
import { buildSessionOriginKey, canonicalizeSessionPath, toAbsoluteSessionPath } from "../shared/sessionIdentity";
import type {
	AgentTab,
	AgentUiRequest,
	AppSettings,
	AppLogLevel,
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
import { AgentManager } from "./pi/AgentManager";
import { PiProcess } from "./pi/PiProcess";
import { getBridgeServer, stopBridgeServer } from "./pi/bridge/BridgeServer";
import { PiModelCapabilityCache, watchPiConfigDirectory } from "./pi/PiModelCapabilityCache";
// 生图消息不走 Agent 消息流，改名前需判断标题是否仍是占位名
import { isDefaultAgentTitle } from "./pi/agentUtils";
import { CompositeAgentGateway } from "./agents/CompositeAgentGateway";
import { AcpAgentManager } from "./acp/AcpAgentManager";
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
import { startDshHostInBackground } from "./dsh/startDshHostInBackground";
import { importForeignSession, knownForeignSessionIds, syncForeignSessions, type DshForeignSyncDeps } from "./dsh/dshForeignSync";
import { PiLocator } from "./pi/PiLocator";
import { PiAuthService } from "./pi/auth/PiAuthService";
import { resolvePiAuthHostLaunch } from "./pi/auth/piAuthHostLaunch";
import { EnhancePromptService, PI_ENHANCE_HOST_FILENAME } from "./pi/enhance/EnhancePromptService";
import { testPiProxy } from "./pi/PiProxyTester";
import { SessionScanner } from "./sessions/SessionScanner";
import { resolveLaunchDefaultOptions, isModelInModelsConfig } from "./sessions/launchDefaults";
import { createSessionModelPreference } from "../shared/modelDisplayName";
import { modelThinkingLevelOf } from "../shared/modelThinkingLevels";
import { SessionCatalog, canAttachRuntimeMetadata } from "./sessions/SessionCatalog";
import { aggregateDshProxyMode, buildHostProxyEnvPatch, resolveDshHostProxyMode, resolveEffectiveSessionProxyMode } from "./sessions/sessionProxyPolicy";
import { SessionRuntimeCoordinator, type SessionRuntimeBinding } from "./sessions/SessionRuntimeCoordinator";
import { IdleAgentReleaser } from "./sessions/IdleAgentReleaser";
import { StaleDraftReaper } from "./sessions/StaleDraftReaper";
import { SessionCommandIpcError } from "./sessions/SessionCommandIpcError";
import { appendSessionForkSuffix } from "./sessions/sessionForkTitle";
import { CodexSessionImporter } from "./sessions/CodexSessionImporter";
import { ClaudeSessionImporter } from "./sessions/ClaudeSessionImporter";
import { QoderSessionImporter } from "./sessions/QoderSessionImporter";
import { OpenCodeSessionImporter } from "./sessions/OpenCodeSessionImporter";
import { ZCodeSessionImporter } from "./sessions/ZCodeSessionImporter";
import { WorkBuddySessionImporter } from "./sessions/WorkBuddySessionImporter";
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
import { TokendanceCatalogStore } from "./config/tokendanceCatalog";
import { installTokendanceProvider } from "./config/tokendanceInstaller";
import { TokendanceAuthStore } from "./config/tokendanceAuth";
import { TokendancePaymentStore } from "./config/tokendancePayment";
import { usageProbeRequest } from "./config/usageProbeTransport";
import { TOKENDANCE_PROVIDER } from "../shared/tokendance";
import { TerminalSessionManager } from "./terminal/TerminalSessionManager";
import { startTrayRegistrationVerify, type TrayRegistrationVerify } from "./tray/trayRegistrationVerify";
import { buildTrayMenuTemplate, TRAY_RECENT_PROJECTS_LIMIT } from "./tray/trayMenuTemplate";
import { TelemetryService } from "./telemetry/TelemetryService";
import { collectTelemetrySnapshot } from "./telemetry/telemetrySnapshot";
import { PromptManager } from "./prompts/PromptManager";
import { XuePromptManager } from "./prompts/XuePromptManager";
import { SkillManager } from "./skills/SkillManager";
import { readSkillContent } from "./skills/readSkillContent";
import { ExtensionManager } from "./extensions/ExtensionManager";
import { BuiltInExtensionsUpdater } from "./extensions/builtInExtensionsUpdater";
import { resolveBuiltInExtensionsDir, resolveBuiltInExtensionsOverlayDir, resolveVendorNodeModulesDir, type BuiltInExtensionPathRoots } from "./extensions/builtInExtensions";
import { createPiProcessExtensionResolvers } from "./extensions/piProcessExtensionResolvers";
import { registerBuiltInExtensionIpc } from "./ipc/builtInExtensionIpc";
import { PROMPTS_STORE_CHANNELS, SKILLS_STORE_CHANNELS, registerContentStoreIpc } from "./ipc/contentStoreIpc";
import { PromptStoreUpdater } from "./prompts/promptStoreUpdater";
import { SkillStoreUpdater } from "./skills/skillStoreUpdater";
import { ProjectResourceManager } from "./projects/ProjectResourceManager";
import { ResourceImportManager } from "./resourceImport/ResourceImportManager";
import { toWslLinuxPath, toWindowsHostPath } from "./wsl/WslPaths";
import { registerProjectsIpc } from "./ipc/projectsIpc";
import { registerUsageStatsIpc } from "./ipc/usageStatsIpc";
import { UsageStatsService } from "./usageStats/UsageStatsService";
import { constrainWindowBoundsToWorkArea, type LastWindowBounds, MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, readLastWindowBounds, saveLastWindowBounds } from "./windowState";
import { createRendererCrashRecoveryGuard } from "./window/rendererCrashRecovery";
import { registerBackgroundImageProtocol, registerBackgroundsIpc } from "./ipc/backgroundsIpc";
import { registerThemesIpc } from "./ipc/themesIpc";
import { registerPluginDevIpc } from "./ipc/pluginDevIpc";
import { registerHostPluginsIpc } from "./ipc/hostPluginsIpc";
import { HostPluginService } from "./plugins/HostPluginService";
import { PluginDevService } from "./extensions/PluginDevService";
import { registerGitIpc } from "./ipc/gitIpc";
import { registerStoreIpc } from "./ipc/storeIpc";
import { registerTerminalIpc } from "./ipc/terminalIpc";
import { registerScratchPadIpc } from "./ipc/scratchPadIpc";
import { registerPasteFilesIpc } from "./ipc/pasteFilesIpc";
import { registerSecurityIpc } from "./ipc/securityIpc";
import { registerVisionIpc } from "./ipc/visionIpc";
import { registerImageGenIpc } from "./ipc/imagegenIpc";
import { ImageGenService } from "./imagegen/ImageGenService";
import { ImageSessionStore } from "./imagegen/ImageSessionStore";
import { ImageBlobStore } from "./imagegen/ImageBlobStore";
import { registerImageGenImageProtocol } from "./imagegen/ImageGenImageProtocol";
import { ImageGenConfigStore } from "./imagegen/ImageGenConfigStore";
import { registerVoiceTranscriptionIpc } from "./ipc/voiceTranscriptionIpc";
import { VoiceTranscriptionConfigStore } from "./voice/VoiceTranscriptionConfigStore";
import { VoiceTranscriptionService } from "./voice/VoiceTranscriptionService";
import { createVolcStreamSocket } from "./voice/volcStreamSocket";
import { fetchWhisperReleaseDigests, WhisperRuntimeManager } from "./voice/WhisperRuntimeManager";
import { getWhisperModelDef } from "../shared/types/whisperRuntime";
import { WhisperTranscriber } from "./voice/WhisperTranscriber";
import { WhisperServerPool } from "./voice/WhisperServerPool";
import { VisionBridgeConfigManager } from "./settings/visionBridgeConfig";
import { registerSessionIpc, scheduleCatalogBackgroundScan } from "./ipc/sessionIpc";
import { registerWebRemoteAccessIpc } from "./ipc/webRemoteAccessIpc";
import { RemoteAccessManager } from "./web/remoteAccess/RemoteAccessManager";
import { registerSystemIpc } from "./ipc/systemIpc";
import { registerResourceImportIpc } from "./ipc/resourceImportIpc";
import { registerBackupIpc } from "./ipc/backupIpc";
import { registerCatalogIpc } from "./ipc/catalogIpc";
import { registerQuickMessagesIpc } from "./ipc/quickMessagesIpc";
import { registerNoticeHistoryIpc } from "./ipc/noticeHistoryIpc";
import { NoticeHistoryStore } from "./notices/NoticeHistoryStore";
import { registerReplyActionsIpc } from "./ipc/replyActionsIpc";
import { QuickMessageStore } from "./quickmessages/QuickMessageStore";
import { ReplyActionRuleStore } from "./replyactions/ReplyActionRuleStore";
import { QUICK_MESSAGES_DEFAULT_RESOURCE_NAME, QUICK_MESSAGES_FILE_NAME, REPLY_ACTIONS_DEFAULT_RESOURCE_NAME, REPLY_ACTIONS_FILE_NAME } from "../shared/quickMessages";
import { getPiAiCatalogIndex, lookupPiAiCatalogEntry, setPiAiCatalogUserDataDir } from "./pi/piAiBuiltinCatalog";
import { PiAiCatalogUpdater } from "./pi/PiAiCatalogUpdater";
import { fetchModelList, refreshModelCatalogIfStale, refreshModelList, getCachedModelList } from "./pi/modelListCache";
import { registerFilesIpc } from "./ipc/filesIpc";
import { registerClipboardIpc } from "./ipc/clipboardIpc";
import { registerShellMenuIpc } from "./ipc/shellMenuIpc";
import { QuickTaskWindowChrome } from "./quickTask/quickTaskWindowChrome";
import { registerQuickTaskIpc } from "./ipc/quickTaskIpc";
import { registerFloatingIpc } from "./ipc/floatingIpc";
import { FloatingController } from "./floating/FloatingController";
import { MiniOverlayWindow } from "./floating/MiniOverlayWindow";
import { BROWSER_PANEL_PARTITION as BROWSER_PANEL_PARTITION_SHARED, isAllowedBrowserPanelUrl as isAllowedBrowserPanelUrlShared } from "./browser/browserSecurity";
import { WebServiceManager } from "./web/WebServiceManager";
import { WebWorkspaceRoutes } from "./web/WebWorkspaceRoutes";
import { preparePreloadPath } from "./preloadPath";
import { AppLogger } from "./logging/AppLogger";
import { setAppLogger } from "./logging/sharedLogger";
import { RpcLogger } from "./logging/RpcLogger";
import { RpcLogLiveBroadcaster } from "./logging/RpcLogLiveBroadcaster";
import { registerEditorsIpc } from "./ipc/editorsIpc";
import { registerPiAuthIpc } from "./ipc/piAuthIpc";
import { registerEnhanceIpc } from "./ipc/enhanceIpc";
import { detectExternalEditors, listConfiguredExternalEditors, mergeDetectedExternalEditors, openProjectInEditor, validateExternalEditorCommand } from "./editors/EditorDetector";
import { FeishuBridge, type SessionRuntimeBindingGateway } from "./feishu/FeishuBridge";
import { feishuT, normalizeFeishuLocale, type FeishuLocale } from "./feishu/FeishuI18n";
import { wantsFeishuDoc } from "./feishu/docActions";
import { resolveFeishuFileSendIntent } from "./feishu/fileIntent";
import { listBots, getBot, addBot as addFeishuBot, removeBot as removeFeishuBot, updateBot as updateFeishuBot, getDecryptedBotAppSecret, getSessionBotId, setSessionBotId, setFeishuConfigDefaultBotName } from "./feishu/FeishuConfig";
import { startMemoryProfile, isMemoryProfileEnabled, type MemoryProfileHandle } from "./memory/MemoryMonitor";
import { DiagnosticsMonitor } from "./diagnostics/DiagnosticsMonitor";
import { EnvironmentDoctor } from "./health/EnvironmentDoctor";
import { LogBundleExporter } from "./health/LogBundleExporter";
import { QuitCleanupRegistry } from "./lifecycle/QuitCleanupRegistry";
import type { FeishuChatBinding } from "../shared/types";
import { createRealAutoUpdater } from "./update/createAutoUpdater";
import { installAtomgitNoCacheBypass, UPDATER_PARTITION_NAME } from "./update/atomgitNoCacheBypass";
import { createMacManualUpdateChecker } from "./update/macManualUpdate";
import { UpdateService } from "./update/UpdateService";

let mainWindow: BrowserWindow | null = null;
// 紧凑模式（右键小任务）与主窗口几何的接线统一收在 quickTaskWindowChrome：
// 本文件不再出现紧凑模式的激活判断、屏幕几何计算与「关闭=返回工作台」的拦截逻辑。
const quickTaskChrome = new QuickTaskWindowChrome({
	getWindow: () => mainWindow,
	saveWorkbenchBounds: (bounds) => saveLastWindowBounds(app.getPath("userData"), bounds),
});
let floatingController: FloatingController | null = null;
let miniOverlayWindow: MiniOverlayWindow | null = null;
let tray: Tray | null = null;
/** Linux 托盘注册验收器（见 tray/trayRegistrationVerify.ts），退出清理里与 tray 一起停 */
let trayRegistrationVerify: TrayRegistrationVerify | null = null;
/** 标记是否由用户主动退出（托盘菜单「退出」），区别于窗口关闭隐藏到托盘 */
let isQuitting = false;
/** 渲染进程崩溃自动恢复守卫（2026-08 黑屏治理，见 window/rendererCrashRecovery.ts）：
 *  非正常崩溃自动 reload 恢复，崩溃风暴（60s 内超 2 次）放弃。 */
const rendererCrashGuard = createRendererCrashRecoveryGuard();
let projectStore: ProjectStore;
let fileSystemService: FileSystemService;
let sessionScanner: SessionScanner;
let sessionCatalog: SessionCatalog;
let sessionRuntimeCoordinator: SessionRuntimeCoordinator;
/** 闲置 agent 自动释放器（内存优化）：whenReady 阶段装配，quit 时 stop */
let idleAgentReleaser: IdleAgentReleaser | null = null;
let staleDraftReaper: StaleDraftReaper | null = null;
let codexSessionImporter: CodexSessionImporter;
let claudeSessionImporter: ClaudeSessionImporter;
let qoderSessionImporter: QoderSessionImporter;
let openCodeSessionImporter: OpenCodeSessionImporter;
let zcodeSessionImporter: ZCodeSessionImporter;
let workbuddySessionImporter: WorkBuddySessionImporter;
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
/** 多后端合成网关（pi + dsh + 未来后端）；启动装配后赋值，供发送链路按 agentId 路由。 */
let compositeAgentGateway: CompositeAgentGateway | undefined;
let acpAgentManager: AcpAgentManager;
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
let skillManager: SkillManager;
let extensionManager: ExtensionManager;
/** 后台更新检查服务（启动延迟 + 2h 周期，无配额方案）；null = 未初始化。 */
let updateService: UpdateService | null = null;
let projectResourceManager: ProjectResourceManager;
let resourceImportManager: ResourceImportManager;
let webServiceManager: WebServiceManager;
let remoteAccessManager: RemoteAccessManager;
let terminalManager: TerminalSessionManager;
let petSystem: PetSystem | null = null;
/** 声音提醒服务（完成/出错/等待输入提示音）；null = 未初始化 */
let soundAlertService: SoundAlertService | null = null;
/** 应用公告服务（无服务器拉取模式）；null = 未初始化 */
let announcementService: AnnouncementService | null = null;
/** CUA（Computer Use Agent）服务；null = 未初始化 */
let cuaService: CuaService | null = null;
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
// 退出清理路径与 IPC 域共用同一槽位（见 ipc/feishuIpc.ts）。
let usageStatsService: UsageStatsService | null = null;
/**
 * 供应商认证服务（`/login` 弹框的后端）：pi 的登录只在它的 CLI 交互层存在，
 * 应用内登录必须绕过 RPC 直调 pi 的认证 API，见 AGENTS.md「认证例外通道」。
 */
let piAuthService: PiAuthService | null = null;
/** 提示词增强服务（输入框增强按钮的后端）：常驻助手进程复用用户那套 pi 的 ModelRuntime。 */
let enhancePromptService: EnhancePromptService | null = null;
/** 粘贴文件启动清理（registerIpc 阶段赋值；whenReady 后 fire-and-forget 执行） */
let cleanupPasteFiles: (() => Promise<number>) | undefined;

/** 退出清理登记表（C12）：常驻资源创建处登记，before-quit 统一顺序执行。 */
const quitCleanup = new QuitCleanupRegistry();
// feishuBridge 在多个 IPC 处理器里重建/置空（临时连接/正式连接/重连），此前没登记
// 退出清理——quit 时若 bridge 在线，其长轮询/WS 不会被停。闭包延迟读当前实例。
quitCleanup.register("feishu-bridge", () => {
	feishuBridgeRef.current?.stop();
	feishuBridgeRef.current = null;
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
	ensureProjectForCwd: (cwd) => projectStore.add(cwd, undefined, settingsStore.get().wslEnabled ? "wsl" : "windows"),
	ensureFallbackProject: () => projectStore.ensureExternalSessionsProject(mainCopy("project.externalSessions")),
	createDraft: (input) => sessionCatalog.createDraft(input),
	// 纠正归属时看现有标题是不是 cwd 兑底占位；有官方投影名时必须覆盖。
	getExistingDraft: (dshSessionId) => {
		const existing = sessionCatalog.listEntries().find((entry) => entry.dshSessionId === dshSessionId);
		return existing ? { title: existing.title } : undefined;
	},
	getEnvironment: () => (settingsStore.get().wslEnabled ? "wsl" : "native"),
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

/** 导入/同步落库后向渲染层广播对应项目刷新（侧栏静默重拉，新会话立即可见）。 */
function notifyDshCatalogRefreshed(projectIds: Iterable<string>): void {
	const window = mainWindow;
	if (!window || window.isDestroyed()) return;
	for (const projectId of new Set(projectIds)) {
		window.webContents.send(ipcChannels.sessionsCatalogRefreshed, { projectId });
	}
}

/** 按当前设置过滤可见项目并推给渲染层（启动 load / 自动导入兑底项目后共用）。 */
function broadcastVisibleProjects(): void {
	const window = mainWindow;
	if (!window || window.isDestroyed()) return;
	const s = settingsStore.get();
	const visible = s.wslEnabled ? projectStore.list().filter((p) => p.kind === "chat" || p.environment === "wsl") : projectStore.list().filter((p) => p.kind === "chat" || !p.environment || p.environment === "windows");
	// 这里只广播 store 清单；渲染层接到事件后会再调用 projects:list 附加实时 presence。
	// 直接把未检测版本写进 atom 会短暂抹掉 missing 标记，使失效目录看起来又恢复正常。
	window.webContents.send(ipcChannels.projectsChanged, visible);
	// 项目集变化同步重建托盘菜单（最近项目区），否则增删项目后菜单滞后。
	refreshTrayContextMenu();
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
		notifyDshCatalogRefreshed(
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

function sendSessionRuntimeEnvelope(event: SessionRuntimeEvent): void {
	const window = mainWindow;
	if (window && !window.isDestroyed()) {
		window.webContents.send(ipcChannels.sessionsRuntimeEvent, event);
	}
	// 极简浮窗是独立渲染进程，流式事件单独转发，否则会话页停在打开时的快照。
	miniOverlayWindow?.sendRuntimeEvent(event);
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
		// 校验仍存在（models.json ∪ pi 目录，与选择器可选范围一致），不存在则交给 launchDefaults 按配置默认 →
		// enabledModels → lastUsed 的顺序兜底。
		if (model && !isModelInModelsConfig(modelsResult.parsed, model, getCachedModelList())) {
			model = undefined;
		}
		// 缺省填充与引导页展示共用同一解析器（launchDefaults，含「最后一次使用」优先）：
		// 保证「预选的默认」与「创建时真正套用的默认」永远同源。
		const defaults = resolveLaunchDefaultOptions({
			backend: "pi",
			settings: settingsResult.parsed,
			models: modelsResult.parsed,
			// 与 createDraft 同源：存在性校验含 pi 目录（冷缓存 null 时退回仅 models.json）。
			catalogModels: getCachedModelList(),
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

	const session = sessionCatalog.createAnonymous({
		projectId: project.id,
		title: input.title?.trim() || mainCopy("session.anonymousTitle", { project: project.name }),
		environment: settingsStore.get().wslEnabled ? "wsl" : "native",
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

function emitReplacementState(binding: SessionRuntimeBinding, includeMessages: boolean): void {
	const tab = agentManager.list().find((candidate) => candidate.id === binding.agentId);
	if (!tab) return;
	emitSessionRuntimeEvent(binding.agentId, ipcChannels.agentsState, tab);
	if (includeMessages) {
		// 与 flush 同一窗口协议：只下发显示窗口段 + windowStart/totalLength/fileVersion，
		// 渲染层合并逻辑一处生效（窗口前历史由 disk 轮次分页 prepend）
		emitSessionRuntimeEvent(binding.agentId, ipcChannels.agentsMessage, {
			agentId: binding.agentId,
			...agentManager.getMessageWindow(binding.agentId),
		});
	}
}

async function readCatalogSessionReferenceMessages(sessionId: string) {
	const entry = sessionCatalog.get(sessionId);
	if (!entry?.filePath) return [];
	return sessionScanner.readMessages(entry.filePath);
}

async function copyCatalogSession(sessionId: string) {
	const entry = sessionCatalog.get(sessionId);
	// DSH 会话复制走运行中 agent 的 clone（sessionsRuntimeClone 已按 backend 分流）；
	// 历史 DSH 会话没有宿主文件可复制（host 会话在 $DSH_HOME），显式拒绝并提示正确入口，
	// 而不是报「文件不存在」误导（A8）。
	if (entry?.backend === "dsh") {
		throw new Error(mainCopy("session.copyDshUnsupported"));
	}
	if (!entry?.filePath) throw new Error(mainCopy("session.fileNotFound"));
	const result = (await agentManager.cloneSessionFile(entry.projectId, entry.filePath, entry.environment)) as {
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
			void appLogger.warn("session", "Copy session suffix rename failed", {
				sessionId,
				sessionPath: result.sessionPath,
				error: error instanceof Error ? error.message : String(error),
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

async function exportCatalogSessionHtml(sessionId: string): Promise<{ path: string }> {
	const entry = sessionCatalog.get(sessionId);
	// G10：DSH 会话投影式导出（无活跃 runtime 时从 host 分页拉全量渲染），
	// 与 pi 的 export_html 同协议返回导出文件路径。
	if (entry?.backend === "dsh") {
		if (!entry.dshSessionId) throw new Error(mainCopy("session.fileNotFound"));
		const project = projectStore.get(entry.projectId);
		return dshAgentManager.exportSessionHtml(entry.dshSessionId, entry.title, project?.path);
	}
	if (!entry?.filePath) throw new Error(mainCopy("session.fileNotFound"));
	const result = await agentManager.exportSessionHtml(entry.projectId, entry.filePath);
	if (!result || typeof result !== "object" || !("path" in result) || typeof result.path !== "string") {
		throw new Error(mainCopy("session.exportFailed"));
	}
	return { path: result.path };
}

type AgentSessionReplacementResult = {
	cancelled?: boolean;
	[key: string]: unknown;
};

async function replaceAgentSession(agentId: string, replace: () => Promise<unknown>, options?: { markForked?: boolean; markSuperseded?: boolean }): Promise<AgentSessionReplacementResult & { targetSessionId?: string }> {
	const originBinding = sessionRuntimeCoordinator.getRuntimeBinding(agentId);
	const originEntry = originBinding ? sessionCatalog.get(originBinding.sessionId) : undefined;
	const originKey = originEntry?.filePath
		? buildSessionOriginKey({
				source: originEntry.source,
				environment: originEntry.environment,
				filePath: originEntry.filePath,
				wslDistro: originEntry.wslDistro,
				wslUser: originEntry.wslUser,
				importedSourceId: originEntry.importedSourceId,
			})
		: undefined;
	return sessionRuntimeCoordinator.replaceBoundRuntime({
		agentId,
		replace: async () => {
			const result = await replace();
			return result && typeof result === "object" && !Array.isArray(result) ? (result as AgentSessionReplacementResult) : {};
		},
		resolveTargetSessionId: async () => {
			const tab = agentManager.list().find((candidate) => candidate.id === agentId);
			if (!tab?.sessionPath) {
				throw new Error(`Replacement runtime has no session path: ${agentId}`);
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
						void appLogger.warn("session", "Fork session suffix rename failed", {
							agentId,
							title,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
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
			if (!originKey || !tab?.sessionPath) return false;
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

const feishuSessionRuntimeBindings: SessionRuntimeBindingGateway = {
	async ensureSession(input) {
		if (input.existingSessionId) {
			const existing = sessionCatalog.get(input.existingSessionId);
			if (existing) return { sessionId: existing.id };
		}
		const environment = settingsStore.get().wslEnabled ? "wsl" : "native";
		if (input.sessionPath) {
			const existing = sessionCatalog.findByFilePath(input.sessionPath, environment);
			if (existing) return { sessionId: existing.id };
			const restored = await sessionCatalog.ensureRuntimeTarget({
				projectId: input.projectId,
				title: input.title,
				source: "pi",
				environment,
				filePath: input.sessionPath,
				wslDistro: environment === "wsl" ? settingsStore.get().wslDistro : undefined,
				wslUser: environment === "wsl" ? settingsStore.get().wslUser : undefined,
			});
			return { sessionId: restored.id };
		}
		const draft = await sessionCatalog.createDraft({
			projectId: input.projectId,
			title: input.title,
			environment,
			source: "pi",
			titleOrigin: "manual",
		});
		return { sessionId: draft.id };
	},
	async activateRuntime(sessionId) {
		const activated = await sessionRuntimeCoordinator.activateRuntime(sessionId);
		if (!activated.ok) throw sessionCommandIpcError(activated.error);
		const tab = agentManager.list().find((candidate) => candidate.id === activated.value.agentId);
		if (!tab)
			throw sessionCommandIpcError({
				code: "SESSION_COMMAND_FAILED",
				debugDetails: `Activated runtime not found: ${activated.value.agentId}`,
			});
		tab.runtimeGeneration = activated.value.runtimeGeneration;
		emitSessionRuntimeEvent(tab.id, ipcChannels.agentsState, tab);
		return tab;
	},
	async bindRuntime(input) {
		if (input.agent.status === "error" || input.agent.status === "closed") {
			throw new Error(`Cannot bind terminal Feishu runtime: ${input.agent.id}`);
		}
		const environment = input.agent.sessionEnvironment ?? (settingsStore.get().wslEnabled ? "wsl" : "native");
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
		emitSessionRuntimeEvent(input.agent.id, ipcChannels.agentsState, input.agent);
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

function refreshTrayContextMenu(): void {
	if (!tray) return;
	// 项目取非聊天项目前 N（ProjectStore.list 已按置顶/最近打开排序）；菜单在项目集变化时重建（broadcastVisibleProjects / projectsIpc 回调）。
	const recentProjects = projectStore
		.list()
		.filter((p) => p.kind !== "chat")
		.slice(0, TRAY_RECENT_PROJECTS_LIMIT)
		.map((p) => ({ id: p.id, name: p.name, path: p.path }));
	tray.setContextMenu(
		Menu.buildFromTemplate(
			buildTrayMenuTemplate(mainCopy, app.getVersion(), recentProjects, {
				showWindow: focusMainWindow,
				checkUpdate: checkForUpdatesFromTray,
				openProject: (projectId) => {
					// 与桌宠/通知同一条跳转链路：窗口置前 + renderer 按 projectId 切项目
					queueFocusTarget({ projectId });
					focusMainWindow();
				},
				openDataDir: () => {
					void shell.openPath(app.getPath("userData"));
				},
				openLogsDir: () => {
					void shell.openPath(join(app.getPath("userData"), "logs"));
				},
				restart: restartApp,
				quit: () => {
					isQuitting = true;
					app.quit();
				},
				toggleFloatingBall: (visible) => {
					if (visible) {
						void floatingController?.show();
					} else {
						floatingController?.hide();
					}
				},
				exitFloatingBall: () => {
					void floatingController?.exit();
				},
				isFloatingBallActive: () => floatingController?.isActive() ?? false,
			}),
		),
	);
}

/**
 * 托盘「检查更新」：走 UpdateService.checkNow（与渲染层手动检测同一链路，结果状态也同步给窗口 UI），
 * 完成后用系统通知告知结果；点击通知聚焦主窗口（渲染层已有更新横幅/下载入口）。
 */
function checkForUpdatesFromTray(): void {
	void (async () => {
		try {
			if (updateService) {
				await updateService.checkNow();
				const snapshot = updateService.getSnapshot();
				const latest = snapshot.app?.latestVersion;
				if (snapshot.app?.hasUpdate && latest) {
					notifyFromTray(mainCopy("tray.updateAvailableTitle"), mainCopy("tray.updateAvailableBody", { version: latest }));
					return;
				}
			}
			notifyFromTray(mainCopy("tray.upToDateTitle"), mainCopy("tray.upToDateBody", { version: app.getVersion() }));
		} catch (error) {
			void appLogger?.warn("update", "Tray update check failed", { error: error instanceof Error ? error.message : String(error) });
			notifyFromTray(mainCopy("update.checkFailed"), "");
		}
	})();
}

/** 托盘通知：点击即聚焦主窗口（更新/最新两种结果都引导回窗口）。 */
function notifyFromTray(title: string, body: string): void {
	const notification = new Notification({ title, body, silent: false });
	notification.on("click", () => focusMainWindow());
	notification.show();
}

/** 从托盘/任务栏/二次启动唤起主窗口：处理最小化、隐藏到托盘两种状态。 */
function focusMainWindow() {
	if (!mainWindow || mainWindow.isDestroyed()) return;
	if (mainWindow.isMinimized()) mainWindow.restore();
	if (typeof mainWindow.setSkipTaskbar === "function") {
		mainWindow.setSkipTaskbar(false);
	}
	mainWindow.show();
	mainWindow.focus();
	// 主窗口回来时默认关闭极简浮窗（避免两个窗口并存）；
	// 「固定在最上方」开启（含未显式设置的默认 true）时浮窗常驻，只响应手动隐藏/收起。
	if (settingsStore.get().floatingBallAlwaysOnTop === false) miniOverlayWindow?.hide();
	if (process.platform === "win32") {
		// Windows 前置窗口用「临时置顶再取消」hack 抢前台（直接 focus 可能被前台锁拦截）。
		// 必须原样还原用户置顶状态，否则会把用户手动置顶的窗口取消置顶；
		// 已置顶的窗口本身就在最前，无需重复 hack。
		const wasAlwaysOnTop = mainWindow.isAlwaysOnTop();
		if (!wasAlwaysOnTop) {
			mainWindow.setAlwaysOnTop(true);
			mainWindow.setAlwaysOnTop(false);
		}
	}
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

function setupTray() {
	// 托盘图标跟随设置里的「Logo 风格」；resolveLogoImage 按风格选 build/icon.png 或 icon-pi-tui.png
	// （均由 electron-vite 的 ?asset 后缀解析，打包后也能正确定位）。
	// 资源缺失时降级回 classic iconPath：托盘必须建得出来——closeToTray 开启时它是唯一的唤回入口。
	const icon = resolveLogoImage(settingsStore.get().logoStyle)?.image ?? nativeImage.createFromPath(iconPath);

	/** 创建托盘实例；首次创建与自愈重建共用同一条路径，避免两处行为漂移。 */
	const createTrayInstance = (): Tray => {
		const instance = new Tray(icon.resize({ width: 16, height: 16 }));
		instance.setToolTip("PiDeck");
		// 双击托盘图标恢复窗口（Windows 常见交互）
		instance.on("double-click", () => {
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.show();
				mainWindow.focus();
			}
		});
		return instance;
	};

	tray = createTrayInstance();
	refreshTrayContextMenu();
	// 项目集变化（增删/重命名/最近打开排序）经 ProjectStore.onChanged 统一派发，重建托盘「最近项目」区。
	const stopTrayProjectListener = projectStore.onChanged(() => refreshTrayContextMenu());

	// C12：退出清理登记（before-quit 统一 runAll）——验收器必须一起停，
	// 否则退出阶段还会把已销毁的 tray 再重建一次。
	quitCleanup.register("tray", () => {
		stopTrayProjectListener();
		trayRegistrationVerify?.stop();
		trayRegistrationVerify = null;
		tray?.destroy();
		tray = null;
	});

	// Linux/GNOME 托盘注册诊断（见 tray/trayRegistrationVerify.ts）：旧版 appindicator 扩展
	// (< v66) 读不到 SNI 属性会永久放弃图标且不再重试（closeToTray 默认开启时，
	// 用户点 X 隐藏后就再无唤回入口）。根因与修复见 docs/linux-tray-icon.md。
	// 这里只验收并记日志，不做重建 —— 重建换名并不能改变扩展的读法，实测无效。
	if (process.platform === "linux") {
		trayRegistrationVerify = startTrayRegistrationVerify({
			onUnregistered: (detail) => {
				void appLogger?.warn("app", "tray verify: unregistered (likely appindicator extension < v66), see docs/linux-tray-icon.md", detail);
			},
			onLog: (message, detail) => void appLogger?.info("app", message, detail),
		});
	}
}

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
		if (guest.session !== browserPanelSession) {
			void appLogger.warn("browser", "Closed webview with unexpected session");
			guest.close();
			return;
		}

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
			if (!isShortcutInput("toggleDevTools", input)) return;
			event.preventDefault();
			toggleMainWindowDevTools(window);
		});
	});
}

async function createWindow() {
	applyNativeThemeSource(settingsStore.get());
	const windowOptions = settingsStore.createWindowOptions();
	const showMainWindowImmediately = shouldShowMainWindowImmediately();
	const sourcePreloadPath = join(__dirname, "../preload/index.js");
	const mainPreloadPath = await prepareMainPreloadPath();
	void appLogger.info("app", "Main window preload configured", {
		sourcePreloadPath,
		preloadPath: mainPreloadPath,
		sourceExists: existsSync(sourcePreloadPath),
		exists: existsSync(mainPreloadPath),
		appPath: app.getAppPath(),
		userDataPath: app.getPath("userData"),
		packaged: app.isPackaged,
		isDev: is.dev,
		electronRendererUrl: process.env.ELECTRON_RENDERER_URL ? "set" : "unset",
	});

	// 根据用户的主题设置选择窗口背景色，避免系统标题栏与暗色主题间出现浅色条带。
	// 色值与 foundation.css 的 light/dark 基底保持一致（暖白 / 暖黑）。
	const windowThemeSettings = settingsStore.get();
	const isDark =
		resolveAppColorScheme({
			theme: windowThemeSettings.theme,
			themeScheduleLightStart: windowThemeSettings.themeScheduleLightStart,
			themeScheduleDarkStart: windowThemeSettings.themeScheduleDarkStart,
			systemPrefersDark: nativeTheme.shouldUseDarkColors,
		}) === "dark";
	const backgroundColor = isDark ? "#121212" : "#f8f8f5";

	// 按外观设置的启动预设调整初始尺寸；隐藏态先 maximize/fullscreen，减少首帧跳动。
	// startupWindowMode="last"：读上次关闭时的窗口几何（位置/尺寸/是否最大化）；
	// 读不到（首次启动/记录损坏）顺延默认 maximized。上次是最大化时先按记录的 normal 几何
	// 建窗再 maximize，还原后回到原位置。
	const requestedMode = settingsStore.get().startupWindowMode ?? "last";
	let effectiveStartupMode = requestedMode;
	let startupBounds: LastWindowBounds;
	if (requestedMode === "last") {
		const last = readLastWindowBounds(app.getPath("userData"));
		if (last) {
			startupBounds = last;
			if (last.maximized) effectiveStartupMode = "maximized";
		} else {
			effectiveStartupMode = "maximized";
			startupBounds = resolveStartupWindowBounds("maximized");
		}
	} else {
		startupBounds = resolveStartupWindowBounds(requestedMode);
	}

	// 有记录位置时以该位置所在显示器为恢复目标（多屏下回到原来那块屏）；无位置（预设模式 /
	// 旧版只存宽高的记录）以主显示器为确定目标并居中。纯逻辑负责裁尺寸、钳位置。
	const targetDisplay = typeof startupBounds.x === "number" && typeof startupBounds.y === "number" ? screen.getDisplayMatching({ x: startupBounds.x, y: startupBounds.y, width: startupBounds.width, height: startupBounds.height }) : screen.getPrimaryDisplay();
	const startupWindowBounds = constrainWindowBoundsToWorkArea(startupBounds, targetDisplay.workArea);

	mainWindow = new BrowserWindow({
		show: showMainWindowImmediately,
		backgroundColor,
		x: startupWindowBounds.x,
		y: startupWindowBounds.y,
		width: startupWindowBounds.width,
		height: startupWindowBounds.height,
		minWidth: MIN_WINDOW_WIDTH,
		minHeight: MIN_WINDOW_HEIGHT,
		// 多 worktree 并行 dev：标题带分支名，任务栏/Alt-Tab 一眼区分窗口
		title: isolateDevByGitBranch && !isSharedDevBranch(devGitBranch) ? `PiDeck · ${devGitBranch}` : "PiDeck",
		icon: iconPath,
		frame: windowOptions.frame,
		titleBarStyle: windowOptions.titleBarStyle,
		...(windowOptions.trafficLightPosition ? { trafficLightPosition: windowOptions.trafficLightPosition } : {}),
		webPreferences: {
			preload: mainPreloadPath,
			sandbox: false,
			contextIsolation: true,
			nodeIntegration: false,
			webviewTag: true,
			// 渲染进程 V8 堆上限：必须覆盖 Chromium 透传的全局 `--js-flags`（#213）
			additionalArguments: rendererHeapAdditionalArguments(),
		},
	});
	const createdWindow = mainWindow;
	// Windows 建窗时可能裁掉工作区外的不可见 resize border；构造参数不足以精确还原贴边外框。
	// 显示/最大化前显式设置已解析的几何，避免重启后高度再次被原生建窗流程缩短。
	createdWindow.setBounds(startupWindowBounds);
	configureBrowserPanelWebviewHost(createdWindow);
	let hasShownMainWindow = false;
	function showMainWindowOnce() {
		if (createdWindow.isDestroyed() || hasShownMainWindow) return;
		hasShownMainWindow = true;
		if (isE2E) {
			// E2E 静默：showInactive 显示但不激活，不抢用户焦点
			createdWindow.showInactive();
		} else {
			createdWindow.show();
			createdWindow.focus();
		}
		// 冷启动里程碑（2/2）：首窗可见（ready-to-show / did-finish-load / 3s 兜底三路共用此口）。
		void appLogger?.info("app", "Cold start milestone: first window shown", {
			sinceModuleLoadMs: Date.now() - bootAnchorMs,
			processUptimeMs: Math.round(process.uptime() * 1000),
		});
		// 向开发者工具输出启动信息
		printStartupInfo();
	}

	// 窗口保持隐藏时先按启动预设调整（maximize/fullscreen），再加载页面；
	// 避免 ready-to-show 后再调整造成首帧布局跳变。
	applyStartupWindowMode(mainWindow, effectiveStartupMode, showMainWindowImmediately);

	// 所有 target="_blank" 或 window.open 的链接统一经同一入口处理，遵守用户设置的打开方式。
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		void openExternalUrl(url);
		return { action: "deny" };
	});
	mainWindow.webContents.on("did-start-loading", () => {
		void appLogger.info("app", "Main window load started", {
			url: mainWindow?.webContents.getURL(),
		});
	});
	mainWindow.webContents.on("did-finish-load", () => {
		void appLogger.info("app", "Main window load finished", {
			url: mainWindow?.webContents.getURL(),
		});
		// 恢复用户设置的窗口缩放；在 did-finish-load 后应用，避免早期设置被覆盖。
		mainWindow?.webContents.setZoomFactor(settingsStore.get().zoomFactor);
		// 加载期排队的通知跳转目标补发一次（renderer 挂载后还会主动拉取，幂等兜底）
		flushPendingFocusTargetOnLoad();
		// —— 数据环境通知（规格 §6：首帧后与渲染层对齐目录归属）——
		// dev 打包首启未决策 → 请渲染层弹数据模式选择（本会话临时落共用目录运行）；
		// 未打包 dev 恒走开发隔离目录，不弹。
		if (updateChannel === "dev" && app.isPackaged && devDataMode === null) {
			mainWindow?.webContents.send(ipcChannels.dataEnvDecisionRequired);
		}
		// 目录标记与通道匹配校验（存量无标记 → ok 不打扰）：stable 包落在 channel-dev 目录才 mismatch。
		const markerInDataDir = readDataEnvDecision(app.getPath("userData"));
		if (markerInDataDir && validateStartupDataEnv(updateChannel, markerInDataDir) === "mismatch") {
			mainWindow?.webContents.send(ipcChannels.dataEnvMismatchDetected, { dataModeInDir: markerInDataDir.dataMode });
		}
		// 共用目录存量标记补写（向后兼容：无标记视为 shared，首启补一次，之后只在缺失时写）。
		if (updateChannel === "stable" && markerInDataDir === null) {
			writeDataEnvDecision(app.getPath("userData"), "shared", app.getVersion());
		}
	});
	mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
		void appLogger.error("app", "Main window load failed", {
			errorCode,
			errorDescription,
			validatedURL,
			isMainFrame,
		});
	});
	mainWindow.webContents.on("render-process-gone", (_event, details) => {
		const level: AppLogLevel = details.reason === "clean-exit" ? "info" : "error";
		void appLogger.log(level, "app", "Main window renderer process gone", {
			...details,
			platform: process.platform,
			arch: process.arch,
		});
		// 黑屏治理：非正常崩溃自动 reload 恢复；clean-exit（正常退出）、用户主动退出
		// 与崩溃风暴（窗口期内超限）不恢复。reload 前检查窗口/webContents 仍存活。
		if (isQuitting || !rendererCrashGuard.shouldAutoReload(details.reason)) return;
		void appLogger.warn("app", "Auto-reloading main window after renderer crash", {
			reason: details.reason,
			exitCode: details.exitCode,
			recoveriesInWindow: rendererCrashGuard.recoveriesInWindow(),
		});
		if (mainWindow && !mainWindow.isDestroyed()) {
			try {
				mainWindow.webContents.reload();
			} catch (error) {
				// reload 抛异常（webContents 已销毁等竞态）：记日志，留给用户手动处理
				void appLogger.error("app", "Auto-reload failed", error);
			}
		}
	});
	// 子进程（含 GPU/utility）异常退出监听已提到模块级 app.on（见 before-quit 附近）：
	// 注册在 createWindow 内会随窗口重建（macOS activate）重复叠监听器。
	mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
		void appLogger.error("app", "Main window preload failed", {
			preloadPath,
			message: error.message,
			stack: error.stack,
		});
	});
	mainWindow.webContents.on("dom-ready", () => {
		void mainWindow?.webContents
			.executeJavaScript("Boolean(window.piDesktop)", true)
			.then((hasPiDesktop) => {
				void appLogger.info("app", "Main window preload API availability", {
					hasPiDesktop,
					url: mainWindow?.webContents.getURL(),
				});
			})
			.catch((error) => {
				void appLogger.warn("app", "Main window preload API check failed", error);
			});
	});
	mainWindow.webContents.on("console-message", (event) => {
		if (!["warning", "error"].includes(event.level)) return;
		void appLogger.warn("app", "Main window renderer console error", {
			level: event.level,
			message: event.message,
			line: event.lineNumber,
			sourceId: event.sourceId,
		});
	});

	mainWindow.once("ready-to-show", showMainWindowOnce);
	mainWindow.webContents.once("did-finish-load", showMainWindowOnce);
	setTimeout(showMainWindowOnce, 3000);
	if (showMainWindowImmediately) {
		showMainWindowOnce();
	}

	// 窗口大小记忆：关闭/退出前保存 normal bounds（最大化/全屏时取恢复后的尺寸），
	// 供下次 startupWindowMode="last" 启动使用；隐藏到托盘不记录（窗口未关闭）。
	// 注意：mainWindow 为模块级可空变量，此处用创建后的局部引用确保非空
	const windowForState = createdWindow;
	windowForState.on("close", () => quickTaskChrome.saveWorkbenchBoundsOnClose(windowForState));

	// 关闭窗口时根据设置决定：隐藏到托盘还是正常退出
	mainWindow.on("close", (event) => {
		if (!isQuitting && quickTaskChrome.interceptClose(event)) return;
		if (!isQuitting && settingsStore.get().floatingBallEnabled) {
			// 悬浮球开启时，关闭主窗口 = 隐藏到悬浮球（不退出）
			event.preventDefault();
			mainWindow?.hide();
			void floatingController?.show();
		} else if (!isQuitting && settingsStore.get().closeToTray) {
			event.preventDefault();
			mainWindow?.hide();
		} else if (!isQuitting) {
			// 如果没有启用托盘，关闭窗口时直接退出应用
			isQuitting = true;
			app.quit();
		}
	});

	// 监听全局快捷键（打开设置 / 开发者工具 / 新建会话 / 搜索会话，键位见 shared/shortcuts.ts，
	// 可设置页自定义）；devTools 组合键的 macOS 变体与开关逻辑集中在 devTools.ts，
	// 主窗口/webview/设置 IPC 共用。新建/搜索是渲染层 UI 动作（引导页/命令面板），
	// 这里只做命中与广播，由渲染层按焦点状态决定是否执行（输入框聚焦时忽略）。
	mainWindow.webContents.on("before-input-event", (event, input) => {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		if (isShortcutInput("openSettings", input)) {
			event.preventDefault();
			// 快捷键可能命中在窗口隐藏（托盘）期间：先唤起窗口，再让渲染层打开设置页
			if (!mainWindow.isVisible()) mainWindow.show();
			mainWindow.webContents.send(ipcChannels.appOpenSettings);
			return;
		}
		// 窗口缩放：主进程直接改 zoomFactor 并持久化，只回推新比例同步设置态
		if (handleWindowZoomShortcut(input)) {
			event.preventDefault();
			return;
		}
		if (isShortcutInput("openNewSession", input)) {
			event.preventDefault();
			mainWindow.webContents.send(ipcChannels.appShortcutTriggered, "openNewSession");
			return;
		}
		if (isShortcutInput("openSearch", input)) {
			event.preventDefault();
			mainWindow.webContents.send(ipcChannels.appShortcutTriggered, "openSearch");
			return;
		}
		if (isShortcutInput("openCommandPalette", input)) {
			event.preventDefault();
			mainWindow.webContents.send(ipcChannels.appShortcutTriggered, "openCommandPalette");
			return;
		}
		// 模型/思考强度循环：目标是「当前聚焦会话」，由渲染层按聚焦栏定位会话并复用
		// 模型选择器的应用链路（main 不持有会话上下文，也不复刻 pi 的 scoped models）。
		if (isShortcutInput("cycleModel", input)) {
			event.preventDefault();
			mainWindow.webContents.send(ipcChannels.appShortcutTriggered, "cycleModel");
			return;
		}
		if (isShortcutInput("cycleThinking", input)) {
			event.preventDefault();
			mainWindow.webContents.send(ipcChannels.appShortcutTriggered, "cycleThinking");
			return;
		}
		// 快捷消息浮层：目标是「当前聚焦会话」的输入框底栏，主进程只负责转发广播，
		// 由渲染层按聚焦栏定位会话并唤出浮层（main 不持有会话上下文，见 renderer 的
		// useQuickMessagePopover / ownsQuickMessageShortcut）。
		// 注意本项不受「输入框聚焦时不触发」约束：它的用途就是打字途中插口令。
		if (isShortcutInput("openQuickMessages", input)) {
			event.preventDefault();
			mainWindow.webContents.send(ipcChannels.appShortcutTriggered, "openQuickMessages");
			return;
		}
		// 语音输入开关：与快捷消息同理，输入框聚焦时仍然生效——录音恰恰发生在打字现场。
		if (isShortcutInput("toggleVoiceRecording", input)) {
			event.preventDefault();
			mainWindow.webContents.send(ipcChannels.appShortcutTriggered, "toggleVoiceRecording");
			return;
		}
		// Ctrl(+Shift)+Tab 循环切换会话标签页：Tab 顺序在渲染层 atoms，主进程只命中广播。
		// 输入框聚焦时仍生效（浏览器同款惯例，Ctrl+Tab 无文本编辑含义）。
		if (isShortcutInput("cycleSessionTabs", input)) {
			event.preventDefault();
			mainWindow.webContents.send(ipcChannels.appShortcutTriggered, "cycleSessionTabs");
			return;
		}
		if (isShortcutInput("cycleSessionTabsReverse", input)) {
			event.preventDefault();
			mainWindow.webContents.send(ipcChannels.appShortcutTriggered, "cycleSessionTabsReverse");
			return;
		}
		if (isShortcutInput("toggleDevTools", input)) {
			event.preventDefault();
			toggleMainWindowDevTools(mainWindow);
		}
	});

	const devRendererUrl = shouldUseDevRendererUrl() ? process.env.ELECTRON_RENDERER_URL : undefined;
	if (devRendererUrl) {
		// Vite 预构建 chunk 是 immutable 强缓存，重新预构建后同一 URL 内容会变但缓存键不变，
		// 渲染层会拿到旧模块去 import 已被删除的 chunk（504）→ 动态 import 失败；dev 加载前先清一次。
		await clearDevRendererCache({
			session: session.defaultSession,
			keepHttpCacheFlag: process.env[KEEP_DEV_HTTP_CACHE_ENV],
			onLog: (outcome, detail) => void appLogger.info("app", `dev renderer http cache ${outcome}`, detail),
		});
		mainWindow.loadURL(devRendererUrl);
	} else {
		mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
	}
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
	console.log("[飞书] 检测到已保存的 Bot 配置:", bot.name, "(跳过自动连接，需手动连接)");
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
 * DSH 后台预热是否允许：默认后端是 dsh、runtime 可用，且用户没有手动停止过 host。
 * 手动停止优先级最高——即使用户把默认后端切成 dsh，也不该把用户明确停掉的 host
 * 又悄悄拉起来（预热失败只记日志，用户无感，所以这里必须直接不开）。
 */
function dshWarmupEnabled(): boolean {
	return settingsStore.get().defaultAgentBackend === "dsh" && dshRuntimeStatus.canCreateDshSession() && settingsStore.get().dshManualStopped !== true;
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
				console.error("[Feishu] auto-bind session mirror failed:", error);
			});
			bridge.trackDocRequest(tab.id, docTitle);
			void bridge.forwardUserMessageToFeishu(tab.id, input.message).catch((error) => {
				console.error("[Feishu] forward PiDeck message failed:", error);
			});
			agentInstruction = `${buildFeishuActionInstruction(bridge.getSessionChatId(tab.id))}\n创建飞书文档时，先输出完整正文，最后独立一行写 [CREATE_DOC:文档标题]。`;
		}
	} else if (hasFeishuBinding) {
		agentInstruction = buildFeishuActionInstruction(sessionChatId);
		const tab = agentManager.list().find((item) => item.id === input.agentId);
		if (tab) {
			void bridge.startSessionMirrorRun(tab.id, tab.title, tab.sessionPath).catch((error) => {
				console.error("[Feishu] session mirror card init failed:", error);
			});
			if (input.message.trim()) {
				void bridge.forwardUserMessageToFeishu(tab.id, input.message).catch((error) => {
					console.error("[Feishu] forward PiDeck message failed:", error);
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

function registerIpc() {
	// 用量统计：业务在 UsageStatsService，handler 薄层只校验/适配
	registerUsageStatsIpc(ipcMain, usageStatsService);
	// 供应商认证（/login）：同样只做校验/适配，进程与协议在 PiAuthService
	registerPiAuthIpc(ipcMain, piAuthService);
	// 提示词增强（输入框增强按钮）：只做校验/适配，进程与协议在 EnhancePromptService
	registerEnhanceIpc(ipcMain, enhancePromptService);
	// 数据环境（数据模式决策 / 目录归属校验）：业务在 dataEnvService，handler 只校验/适配。
	// relaunchApp 复用 restartApp（先停常驻服务 + isQuitting，防止 closeToTray 吞掉 relaunch）；
	// quitApp 先置 isQuitting，与托盘「退出」菜单同一写法，避免 closeToTray 把退出吞成隐藏到托盘。
	registerDataEnvIpc({
		getChannel: () => updateChannel,
	registerAcpIpc({ settingsStore });
		getDecisionDir: () => channelDevDataDir,
		getActiveDirectory: () => (devDataMode === "channel-dev" ? "channel-dev" : "shared"),
		getAppVersion: () => app.getVersion(),
		relaunchApp: restartApp,
		quitApp: () => {
			isQuitting = true;
			app.quit();
		},
		// 数据导入（规格 §6 单向正式→dev）：源 = 共用目录（与 setPath 的 fallbackSharedDir 同源），目标 = dev 独立目录。
		getSharedDataDir: () => fallbackSharedDataDir,
		getChannelDevDataDir: () => channelDevDataDir,
		sendProgress: (progress) => mainWindow?.webContents.send(ipcChannels.dataEnvImportProgress, progress),
	});

	// 频道切换（跨通道升级，规格 §3）：服务 electron-free，网络/临时目录/启动安装器/退出/推送在此装配。
	// quitApp 先置 isQuitting，与 dataEnv/托盘「退出」同一写法，防 closeToTray 吞掉退出。
	const channelSwitchService = new ChannelSwitchService({
		currentChannel: () => updateChannel,
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
			void shell.openPath(filePath);
		},
		quitApp: () => {
			isQuitting = true;
			app.quit();
		},
		sendToRenderer: (snapshot) => {
			const win = mainWindow;
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
				const win = mainWindow;
				if (win && !win.isDestroyed()) {
					win.webContents.send(ipcChannels.automationChanged, event);
				}
			},
		});
	}

	const catalogIdentityContext = () => {
		const { wslEnabled, wslDistro, wslUser } = settingsStore.get();
		return wslEnabled ? { wslDistro, wslUser } : {};
	};

	registerEditorsIpc({
		settingsStore,
		appLogger,
		getMainWindow: () => mainWindow,
	});
	// 换肤背景图：协议服务 userData/backgrounds/，IPC 负责选图复制与删除
	registerBackgroundImageProtocol();
	registerBackgroundsIpc();
	registerThemesIpc();
	// Desktop plugins run without AgentManager/RPC; failure leaves the rest of PiDeck untouched.
	const hostPlugins = new HostPluginService(app.getPath("userData"), sessionCatalog, join(__dirname, "../preload/hostPlugin.js"));
	const unregisterHostPlugins = registerHostPluginsIpc(hostPlugins, () => mainWindow);
	quitCleanup.register("host-plugins", () => {
		unregisterHostPlugins();
		hostPlugins.dispose();
	});
	void hostPlugins.initialize().catch(() => appLogger.warn("host-plugins", "Optional plugin host initialization failed"));
	// 插件开发支持：demo/指南落 ~/.pi/agent/extensions（与扩展列表同一 home 来源）
	const pluginDevService = new PluginDevService(resolveBuiltInExtensionRoots(), () => extensionManager?.userHomeDir ?? homedir());
	registerPluginDevIpc(pluginDevService, {
		// demo 是落进用户扩展目录的普通扩展：落盘后同步失效扩展列表缓存，
		// 避免已打开的扩展页/缓存读看不到新行（与安装包后失效缓存同一语义）。
		onExtensionFilesChanged: () => extensionManager?.invalidateListCache(),
	});
	registerProjectsIpc({
		projectStore,
		settingsStore,
		gitService,
		worktreeService,
		agentManager,
		appLogger,
		projectResourceManager,
		sessionCatalog,
		mainCopy: mainCopy as (key: string, params?: Record<string, string | number>) => string,
		getMainWindow: () => mainWindow,
		resolveWslEnvironment: async (distro, user) => {
			const { resolveWslEnvironment } = await import("./wsl/WslEnvironment");
			return resolveWslEnvironment(distro, user, {
				warn: (msg: string, detail: Record<string, unknown>) => console.warn("[PiDeck] " + msg, detail),
			});
		},
	});
	registerResourceImportIpc(resourceImportManager);

	registerScratchPadIpc({ appLogger });

	// 通知历史落盘：showNotice 单点记录后推送主进程，重启可回灌（渲染层环形缓冲只服务当次会话）
	registerNoticeHistoryIpc(
		new NoticeHistoryStore({
			getFilePath: () => join(app.getPath("userData"), "notice-history.json"),
			log: (level, message, detail) => {
				if (level === "error") void appLogger.error("notice-history", message, detail);
				else void appLogger.info("notice-history", message, detail);
			},
		}),
	);

	// 粘贴大文本 → 落盘文件（受管目录，路径校验 + 启动清理）
	cleanupPasteFiles = registerPasteFilesIpc({
		projectStore,
		settingsStore,
		appLogger,
	});

	// 安全管理：配置读写 + 会话等级覆盖（SecurityStore 负责持久化与策略快照）
	registerSecurityIpc({
		securityStore,
		log: (domain, message, details) => void appLogger.info(domain, message, details),
	});

	// 视觉桥配置（~/.pi/agent/pi-deck-vision.json）界面化编辑；运行时由 pi-deck-vision 扩展消费
	registerVisionIpc({
		visionBridge: new VisionBridgeConfigManager(configManager),
		log: (message, ...args) => appLogger.info("vision", message, ...args),
	});

	const whisperRuntimeRoot = join(app.getPath("userData"), "voice-runtime");
	const whisperRuntimeManager = new WhisperRuntimeManager({
		platform: process.platform,
		arch: process.arch,
		layout: { runtimeRoot: whisperRuntimeRoot, modelsRoot: join(whisperRuntimeRoot, "models"), tempRoot: join(whisperRuntimeRoot, "tmp") },
		download: createNetDownloader((scope, message, detail) => void appLogger.warn(scope, message, detail)),
		fetchReleaseDigests: fetchWhisperReleaseDigests,
		log: (scope, message, detail) => void appLogger.info(scope, message, detail),
	});
	const whisperServerPool = new WhisperServerPool({
		resolveServerPath: (input) => whisperRuntimeManager.resolveServerPath(input),
		getEnv: () => (piLocator ? piLocator.createProcessEnv() : undefined),
		log: (message, details) => void appLogger.info("voice-whisper-server", message, details),
	});
	// C12：退出清理登记（before-quit 统一 runAll）——常驻推理进程必须随应用回收，
	// 否则残留的 whisper-server 会一直占着几百 MB 模型内存和监听端口。
	quitCleanup.register("whisper-server", async () => {
		whisperServerPool.abortAll();
		await whisperServerPool.shutdown("quit");
	});
	const whisperTranscriber = new WhisperTranscriber({
		manager: whisperRuntimeManager,
		server: whisperServerPool,
		getTempRoot: () => join(whisperRuntimeRoot, "tmp"),
		// piLocator 在启动装配后段才就绪（本注册在其之前），转写发生在运行期，闭包懒取即可。
		getEnv: () => (piLocator ? piLocator.createProcessEnv() : undefined),
		log: (message, details) => void appLogger.info("voice-whisper", message, details),
	});
	const voiceTranscriptionConfigStore = new VoiceTranscriptionConfigStore({
		getConfigPath: () => join(app.getPath("userData"), "voice-transcription.json"),
		isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
		protect: (plainText) => safeStorage.encryptString(plainText),
		unprotect: (encrypted) => safeStorage.decryptString(Buffer.from(encrypted)),
		log: (message, details) => void appLogger.info("voice-transcription", message, details),
		isLocalReady: (config) => {
			const status = whisperRuntimeManager.getStatus({ cliPath: config.cliPath, localModelId: undefined });
			const selected = getWhisperModelDef(config.localModelId);
			return status.cliReady && Boolean(selected && whisperRuntimeManager.isModelInstalled(selected.id));
		},
	});
	registerVoiceTranscriptionIpc({
		configStore: voiceTranscriptionConfigStore,
		service: new VoiceTranscriptionService({
			getPublicConfig: () => voiceTranscriptionConfigStore.getPublicConfig(),
			getCredentials: () => voiceTranscriptionConfigStore.getCredentials(),
			transcribeLocal: (input) => whisperTranscriber.transcribe(input),
			cancelLocal: (requestId) => whisperTranscriber.cancel(requestId),
			// 流式 2.0：主进程只负责建连与转发帧，握手/序号/收尾都在 VolcengineStreamSession 里。
			createStreamSocket: createVolcStreamSocket,
			emitStreamPartial: (partial) => {
				if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ipcChannels.voiceTranscriptionStreamPartial, partial);
			},
			log: (message, details) => void appLogger.info("voice-transcription", message, details),
		}),
		runtimeManager: whisperRuntimeManager,
		// 删模型/换二进制前先放下常驻进程：Windows 的文件锁会让删除直接失败。
		beforeRuntimeMutation: () => whisperServerPool.shutdown("runtime-mutation"),
		emitRuntimeProgress: (progress) => {
			if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ipcChannels.voiceTranscriptionRuntimeProgress, progress);
		},
	});

	// 生图：凭据来自独立 userData/imagegen.json，不读 pi models.json
	const imageGenConfigStore = new ImageGenConfigStore({
		getConfigPath: () => join(app.getPath("userData"), "imagegen.json"),
		log: (message, ...args) => appLogger.info("imagegen", message, ...args),
	});
	// 生图 session 独立存储：无 pi 会话文件的纯生图草稿把历史落盘到这里（重启可恢复），
	// 不依赖 pi 会话文件也不进 pi 的 sessions 目录（PiDeck userData/imagegen/sessions）。
	// 图片二进制单独落 blobs：JSONL 只留引用，否则几十轮生图就能把会话文件堆到 200 MB+，
	// 渲染进程加载即 OOM（2026-09 白屏事故）。两个根必须同源解析，各拼一次路径会漂移成
	// 「图片写进了 A 目录、协议从 B 目录读」。
	const imageGenRoots = resolveImageGenStorageRoots();
	const imageBlobStore = new ImageBlobStore({ getBlobsPath: () => imageGenRoots.blobs });
	void imageBlobStore.ensureDir();
	const imageSessionStore = new ImageSessionStore({
		getStorePath: () => imageGenRoots.sessions,
		blobs: imageBlobStore,
	});
	// pideck-img:// 必须在 app ready 后注册（scheme 特权声明在文件底部 ready 前完成）
	registerImageGenImageProtocol(imageBlobStore);
	registerImageGenIpc({
		imageGen: new ImageGenService({
			getProviderCredentials: async (provider) => {
				const creds = await imageGenConfigStore.getCredentials(provider);
				if (!creds) return null;
				return { baseUrl: creds.baseUrl, apiKey: creds.apiKey, extraParams: creds.extraParams, referenceMode: creds.provider.referenceMode, apiStyle: creds.provider.apiStyle };
			},
			log: (message, ...args) => appLogger.info("imagegen", message, ...args),
		}),
		imageGenConfig: imageGenConfigStore,
		log: (message, ...args) => appLogger.info("imagegen", message, ...args),
		readImageBlob: (ref) => imageBlobStore.readPayload(ref),
		// 生图记录落盘：user 提示词 + assistant 图片两条消息写入 pi 会话文件，
		// 让「不走 pi/dsh 直连 API」的生图结果也进会话历史（重启后可见）。
		// DSH 会话无 pi 会话文件且 host 无消息追加 API，跳过（生图仍正常返回）。
		// agentManager/sessionCatalog 在此处尚未初始化，闭包延迟引用（IPC 调用时已就绪）。
		persistImageGen: async ({ sessionId, provider, model, prompt, image, size, referenceImages }) => {
			const entry = sessionCatalog?.get(sessionId);
			if (!entry || entry.backend === "dsh") return;
			// 标题更新不依赖会话文件：生图 draft 会话不启动 pi agent，无 filePath，
			// 但仍要把占位标题（Chat agent）换成首行提示词，否则历史/侧栏永远停在占位名；
			// 用户已手动改过名（非占位标题）则不覆盖。
			const project = projectStore.get(entry.projectId);
			if (project && isDefaultAgentTitle(entry.title, project, mainCopy as never)) {
				const firstLine = prompt.split(/\r?\n/, 1)[0]?.trim() ?? "";
				if (firstLine) {
					// 自动命名只取首行，不在存储层硬截断；标题展示由侧栏窗口负责钳制，
					// hover 时滚动展示全文。否则 "(fork)" 或英文单词可能被写成残片。
					// 生图没有扩展模型命名链路，首行提示词只算 fallback 所有权。
					await sessionCatalog.applyAutomaticTitle(sessionId, firstLine, "fallback");
					mainWindow?.webContents.send(ipcChannels.sessionsCatalogRefreshed, { projectId: entry.projectId });
				}
			}
			// 生图独立持久化：imagegen 后端会话（可能残留无意义的 pi filePath）与无 pi 会话文件的
			// 纯生图草稿，都落盘到 ImageSession 独立存储（PiDeck userData 下的 imagegen/sessions），
			// 不再依赖 pi 会话文件；并把会话提升为 active，防重启时 staleDrafts 清理丢入口——
			// 否则生图历史重启即失（2026 用户反馈）。只有非 imagegen 且有 filePath 才写 pi 文件。
			if (entry.backend === "imagegen" || !entry.filePath) {
				await imageSessionStore.append(sessionId, [
					{
						id: randomUUID(),
						agentId: "",
						role: "user",
						text: prompt,
						timestamp: Date.now(),
						// 参考图随 user 消息落盘：恢复时时间线里能看到参考图
						images: (referenceImages ?? []).map((ref) => ({
							type: "image" as const,
							data: ref.data,
							mimeType: ref.mimeType,
						})),
					},
					{
						id: randomUUID(),
						agentId: "",
						role: "assistant",
						text: "",
						stopReason: "stop",
						timestamp: Date.now(),
						images: [{ type: "image" as const, data: image.data, mimeType: image.mimeType }],
						// 历史恢复靠这个标记区分生图结果与普通图片附件（渲染层 ImageGenMessage）；
						// 结构即 shared/types/imagegen 的 ImageGenMeta，渲染层读取时自行收窄
						meta: { imageGen: { status: "complete", prompt, size } },
					},
				]);
				await sessionCatalog.promoteToActive(sessionId);
				return;
			}
			await agentManager?.appendLocalMessagesToSession(entry.filePath, [
				{
					role: "user",
					// 参考图随 user 消息落盘：重启恢复历史时时间线里能看到参考图
					content: [
						{ type: "text", text: prompt },
						...(referenceImages ?? []).map((ref) => ({
							type: "image" as const,
							source: {
								type: "base64" as const,
								media_type: ref.mimeType,
								data: ref.data,
							},
						})),
					],
				},
				{
					role: "assistant",
					content: [
						{
							type: "image",
							source: {
								type: "base64",
								media_type: image.mimeType,
								data: image.data,
							},
						},
					],
					extra: {
						api: "openai-images",
						provider,
						model,
						// 历史恢复依赖这个标记区分生图结果与普通图片附件，
						// 否则重启后会退回普通图片渲染，丢失复制/保存操作。
						imageGen: { status: "complete", prompt, size },
					},
				},
			]);
			// 生图消息不走 Agent 消息流，refreshAutoTitle 不会触发，标题更新已在 filePath 判断前完成。
		},
	});

	registerSessionIpc({
		projectStore,
		settingsStore,
		sessionScanner,
		sessionCatalog,
		sessionRuntimeCoordinator,
		agentManager,
		configManager,
		codexSessionImporter,
		claudeSessionImporter,
		qoderSessionImporter,
		openCodeSessionImporter,
		zcodeSessionImporter,
		workbuddySessionImporter,
		cursorSessionImporter,
		kimiSessionImporter,
		kimiWorkSessionImporter,
		minimaxSessionImporter,
		directorySessionImporter,
		appLogger,
		terminalManager,
		mainCopy: mainCopy as (key: string, params?: Record<string, string | number>) => string,
		getMainWindow: () => mainWindow,
		emitSessionRuntimeEvent,
		emitSessionRuntimeDetach,
		createAnonymousSession,
		stopSessionRuntime,
		emitReplacementState,
		readCatalogSessionReferenceMessages,
		// 无 pi 会话文件（纯生图草稿）历史读取回退：ImageSession 独立存储
		readImageSessionMessages: (sessionId) => imageSessionStore.readMessages(sessionId),
		copyCatalogSession,
		exportCatalogSessionHtml,
		replaceAgentSession,
		// C1：DSH 后端专用 IPC 依赖按后端分组（注册表化铺路；未来新增后端各自提供一份）
		dshBackend: {
			listDshModels: () => dshHost.listModels(),
			discoverDshModels: (input) => dshHost.discoverModels(input),
			listDshProviders: () => dshHost.listProviders(),
			listDshAgentPresets: () => dshHost.listAgentPresets(),
			getDshDefaultModel: () => Promise.resolve(dshHost.getDefaultModelSelection()),
			getDshStatus: () => dshHost.getStatus(),
			// AgentRuntimeProvider 阶段 1：runtime 安装态门控（未安装时 UI 走安装引导、
			// 新建 dsh 会话在 sessionIpc 边界被拒）。
			getDshRuntimeStatus: () => dshRuntimeStatus.getStatus(),
			canCreateDshSession: () => dshRuntimeStatus.canCreateDshSession(),
			// 安装/导入/卸载后必须重探测并广播：否则 UI 还停在旧状态，
			// 用户会看到「刚装完但仍提示未安装」。
			installDshRuntime: async () => {
				// 同版本重装时 host 可能仍持有 runtime 内 .node 原生模块的 DLL 句柄，
				// 落位 rm 必报 EPERM：与卸载同一套路，先停会话 + dispose host 释放锁。
				const wasRunning = await stopDshHostForRuntimeDiskOperation();
				const result = await dshRuntimeInstaller.installFromIndex();
				dshRuntimeStatus.refresh();
				if (result.ok) await startDshHostAfterRuntimeDiskOperation(wasRunning);
				// 与手动导入同一套文案映射：在线安装的失败原因（尤其是「发布源没有
				// 配套版本」）必须可读，否则用户只会看到「点了安装没反应」。
				if (!result.ok) return { ok: false, error: dshRuntimeErrorCopy(result.error) };
				return result;
			},
			importDshRuntime: async (filePath: string) => {
				const wasRunning = await stopDshHostForRuntimeDiskOperation();
				const result = await dshRuntimeInstaller.installFromLocalFile(filePath);
				dshRuntimeStatus.refresh();
				if (result.ok) await startDshHostAfterRuntimeDiskOperation(wasRunning);
				// 失败时把内部错误码映射为用户可读文案（配置页直接展示 error 字段）。
				// 只映射已知校验码；未知错误（如磁盘满、权限）保留原始信息以便排查。
				if (!result.ok) return { ok: false, error: dshRuntimeErrorCopy(result.error) };
				return result;
			},
			uninstallDshRuntime: async () => {
				// 卸载会删掉 host 正在用的 runtime 目录：Windows 上 host 的 .node 原生模块
				// 已映射成 DLL 句柄，进程存活时删目录必报 EPERM（文件被占用）。所以先停
				// 活跃会话、杀掉 host 释放文件锁，再删；删完若原本在用 DSH 就把 host 拉回
				// 来（删失败时旧目录还在，重启 fork 仍走旧 runtime，用户可稍后重试卸载）。
				const wasRunning = await stopDshHostForRuntimeDiskOperation();
				const result = await dshRuntimeInstaller.uninstall();
				dshRuntimeStatus.refresh();
				await startDshHostAfterRuntimeDiskOperation(wasRunning);
				return result;
			},
			describeDshSettings: () => dshHost.describeSettings(),
			updateDshSettings: (ns, patch, expectedRevision) => dshHost.updateSettings(ns, patch, expectedRevision),
			mutateDshSettings: (ns, ops, expectedRevision) => dshHost.mutateSettings(ns, ops, expectedRevision),
			describeDshCredentials: (refs) => dshHost.describeCredentials(refs),
			setDshCredential: (ref, value) => dshHost.setCredential(ref, value),
			unsetDshCredential: (ref) => dshHost.unsetCredential(ref),
			readDshCredential: (ref) => dshHost.readCredentialValue(ref),
			openDshDocument: () => dshHost.openDocument(),
			stopDshHost: () => stopDshHostManually(),
			startDshHost: () => startDshHostManually(),
			restartDshHost: async () => {
				// 切换 DSH_HOME 前先停掉全部活跃 DSH 会话（host 侧会话仍在 $DSH_HOME
				// 持久化，catalog 保留 dshSessionId，重新打开会话时 attach 恢复），
				// 避免旧目录的 mux 悬挂在已 dispose 的 transport 上；再重启 host。
				// D16：restart 后校验 host 真正拉起（boot 完成），失败返回 false 而非恒 true。
				await dshAgentManager.stopAll();
				await dshHost.restart();
				try {
					await dshHost.ensureStarted();
					return dshHost.isHostProcessRunning() && dshHost.isHostReady();
				} catch {
					return false;
				}
			},
			readDshHistoryPage: (dshSessionId, beforeSeq, options) => dshAgentManager.readHistoryPage(dshSessionId, beforeSeq, options),
			readDshProcessEvents: (agentId, dshSessionId) => dshAgentManager.readProcessEvents(agentId, dshSessionId),
			readDshSystemPrompt: (agentId, dshSessionId) => dshAgentManager.readSystemPrompt(agentId, dshSessionId),
			readDshMessageFullText: (agentId, messageId) => dshAgentManager.readMessageFullText(agentId, messageId),
			resolveDshSessionFilePath: async (sessionId) => {
				// F5：DSH 会话没有 pi 会话文件，「复制会话文件路径」按 catalog 的
				// dshSessionId + 项目 cwd 推导 host 持久化路径。
				const entry = sessionCatalog.get(sessionId);
				if (!entry?.dshSessionId) return undefined;
				const project = projectStore.get(entry.projectId);
				if (!project?.path) return undefined;
			readAcpMessages: (acpSessionId) => acpAgentManager.readMessagesByAcpSessionId(acpSessionId),
				return dshAgentManager.resolveSessionFilePath(project.path, entry.dshSessionId);
			},
			searchDshSessions: (query) => dshHost.searchSessions(query),
			createDshGoal: (agentId, objective, maxGoalRounds) => dshAgentManager.createGoal(agentId, objective, maxGoalRounds),
			runDshGoalAction: (agentId, action) => dshAgentManager.goalAction(agentId, action),
			cancelDshQueuedMessage: (agentId, itemId) => dshAgentManager.cancelQueuedMessage(agentId, itemId),
			listDshSubagents: (agentId) => dshAgentManager.listSubagents(agentId),
			listDshSkills: (agentId) => dshAgentManager.listSkills(agentId),
			readDshSubagentHistory: (agentId, childSessionId, beforeSeq, maxMessages) => dshAgentManager.readSubagentHistory(agentId, childSessionId, beforeSeq, maxMessages),
			listDshOrphans: async () => {
				// G3/D11：host 持久化会话中，catalog 无 dshSessionId 映射的视为孤儿
				// （被删除映射的记录、匿名会话残留等）。wire 无删除 API，仅用于提示。
				const hostIds = await dshHost.listSessionIds();
				const known = new Set(
					sessionCatalog
						.listEntries()
						.map((entry) => entry.dshSessionId)
						.filter((id): id is string => Boolean(id)),
				);
				return hostIds.filter((id) => !known.has(id));
			},
			// 跨工具兼容（2026-12）：dsh-web 等其他工具创建的 host 根会话（含标题/cwd）；
			// 已映射进 catalog 的在 IPC 层（sessionIpc）过滤，配置页只显示「待导入」。
			listDshForeignSessions: () => dshHost.listForeignSessions(),
			// 外部会话导入：把 host 会话映射进 catalog（status=active，侧栏可见可加载）。
			// 幂等：同 dshSessionId 重复导入被 SessionCatalog.createDraft 吸收（只更新标题/归属）。
			importDshForeignSession: async (dshSessionId) => {
				const record = await importForeignSession(foreignSyncDeps, dshSessionId);
				notifyDshCatalogRefreshed([record.projectId]);
				void appLogger.info("session", "Foreign DSH session imported", {
					dshSessionId,
					projectId: record.projectId,
					title: record.title,
				});
				return record;
			},
			// 外部会话全量同步：catalog 未映射的磁盘根会话全部导入（不启动 host）。
			// 配置页「全部导入」与启动自动同步共用此入口。
			syncDshForeignSessions: () => runDshForeignSync(),
			// G14：DSH 归档/恢复（目录移动 + manifest，与 pi 归档同语义，不销毁数据）
			archiveDshSession: (dshSessionId, cwd, title) => dshHost.archiveSession(dshSessionId, cwd, title),
			unarchiveDshSession: (dshSessionId) => dshHost.unarchiveSession(dshSessionId),
			listArchivedDshSessions: () => dshHost.listArchivedSessions(),
			deleteArchivedDshSession: (dshSessionId) => dshHost.deleteArchivedSession(dshSessionId),
			// G13 深化：动态 Cordis 插件管理（进程内临时扩展，define/run/stop/undefine）
			listDshDynamicPlugins: () => dshHost.listDynamicPlugins(),
			listDshStaticPlugins: () => dshHost.listStaticPlugins(),
			uninstallDshUserPlugin: (input) => dshHost.uninstallUserPlugin(input),
			// 用户插件市场搜索/安装/清单（安装服务视角；host 侧无此能力，主进程直连 npm 与市场 API）
			searchDshPluginMarket: (keyword) => {
				if (!dshPluginInstallService) throw new Error("DSH plugin install service is not available");
				return dshPluginInstallService.searchPlugins(keyword);
			},
			installDshUserPlugin: (spec) => {
				if (!dshPluginInstallService) throw new Error("DSH plugin install service is not available");
				return dshPluginInstallService.installUserPlugin(spec);
			},
			listDshUserPlugins: () => {
				if (!dshPluginInstallService) return Promise.resolve([]);
				return dshPluginInstallService.listUserPlugins();
			},
			installDshPlugin: (input) => dshHost.installDynamicPlugin(input),
			runDshPlugin: (input) => dshHost.runDynamicPlugin(input),
			stopDshPlugin: (input) => dshHost.stopDynamicPlugin(input),
			uninstallDshPlugin: (input) => dshHost.uninstallDynamicPlugin(input),
			isDshAgent: (agentId) => dshAgentManager?.list().some((tab) => tab.id === agentId) === true,
			forkDshAgentSession: async (target, entryId) => {
				// DSH fork：runtime 已原地换绑到新会话（agentId 不变，焦点会话 id 不变），
				// 这里只需把 catalog 的 dshSessionId 同步为新 fork 会话，重启后 attach 正确。
				const result = await dshAgentManager.forkSession(target.agentId, entryId);
				const tab = dshAgentManager.list().find((candidate) => candidate.id === target.agentId);
				if (tab?.sessionId) {
					await sessionCatalog.attachRuntime({
						sessionId: target.sessionId,
						dshSessionId: tab.sessionId,
						promoteToActive: true,
					});
				}
				return { ...result };
			},
			cloneDshAgentSession: async (target) => {
				// DSH clone：fork 无锚点（完整副本），runtime 换绑到新会话，语义同 fork。
				const result = await dshAgentManager.cloneSession(target.agentId);
				const tab = dshAgentManager.list().find((candidate) => candidate.id === target.agentId);
				if (tab?.sessionId) {
					await sessionCatalog.attachRuntime({
						sessionId: target.sessionId,
						dshSessionId: tab.sessionId,
						promoteToActive: true,
					});
				}
				return { ...result };
			},
		},
	});

	// ── 启动预扫描（2026-08 展开项目卡顿优化）──
	// 延迟 3s 启动、项目间错开 1.5s 逐个调度后台扫描：预热 catalog 缓存，
	// 用户首次展开项目时直接命中缓存回显，不再同步全量扫描卡 UI。
	// 错开 + 协调器去重/冷却（sessionIpc 内）保证不与用户触发的扫描并发重扫。
	const prewarmTimer = setTimeout(() => {
		const projects = projectStore.list();
		projects.forEach((project, index) => {
			const timer = setTimeout(() => {
				scheduleCatalogBackgroundScan(project.id, async () => {
					try {
						const settings = settingsStore.get();
						let projectPath = project.path;
						if (settings.wslEnabled && settings.wslDistro) {
							projectPath = projectPath.replace(/^([A-Za-z]):\\/, (_: string, drive: string) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, "/");
						}
						const summaries = await sessionScanner.list(projectPath);
						await sessionCatalog.mergeScanned(project.id, summaries, settings.wslEnabled ? { wslDistro: settings.wslDistro, wslUser: settings.wslUser } : {});
					} catch (error) {
						void appLogger.warn("session", "Catalog prewarm scan failed", {
							projectId: project.id,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				});
			}, index * 1500);
			timer.unref?.();
		});
	}, 3000);
	prewarmTimer.unref?.();

	registerGitIpc({
		appLogger,
		mainCopy: mainCopy as (key: string, params?: Record<string, string | number>) => string,
		gitService,
		gitRefsWatcher: gitRefsWatcher,
		getMainWindow: () => mainWindow,
		piLocator,
		projectStore,
		settingsStore,
		worktreeService,
	});

	// Phase 3.7 拆出 systemIpc 后这些可选依赖必须显式注入；
	// 漏传 extensionManager 会导致 pi:update-check / pi:update 根本不注册。
	if (!piModelCapabilityCache) throw new Error("Pi model capability cache is unavailable after settings load");
	// 模型目录更新器：设置页手动更新与 UpdateService 第三路定时检查共用同一实例。
	// 覆盖层目录须在 catalog 初次读取前登记（getPiAiCatalogIndex 首次调用即锁定索引）；
	// app 已 ready 后 app.getPath("userData") 才可靠，故在此提前构造。
	setPiAiCatalogUserDataDir(app.getPath("userData"));
	const catalogUpdater = new PiAiCatalogUpdater({
		userDataDir: app.getPath("userData"),
		// 目录更新/检测复用应用更新的源偏好（settings.updateSource）：
		// github → raw 直连优先；atomgit 等 → AtomGit OpenAPI 优先，两者互为兜底。
		source: () => settingsStore.get().updateSource,
	});
	// 内置扩展热更新：版本号不跟 PiDeck 应用版本走（见 resources/extensions/extensions-manifest.json），
	// 打包态 resources 只读，更新写进 userData 覆盖层，路径解析侧覆盖层优先 → 重启会话即生效。
	const builtInExtensionRoots = resolveBuiltInExtensionRoots();
	const builtInExtensionsUpdater = new BuiltInExtensionsUpdater({
		userDataDir: app.getPath("userData"),
		builtinExtensionsDir: resolveBuiltInExtensionsDir(builtInExtensionRoots),
		// vendored 运行时依赖（node_modules/undici 等）的源目录：覆盖层上层没有 node_modules，
		// 缺了它 pi 会因扩展裸导入解析不到而启动失败（2026-09-15 线上事故）。
		vendorNodeModulesDir: resolveVendorNodeModulesDir(builtInExtensionRoots),
		// 与模型目录/应用更新共用 settings.updateSource：默认 AtomGit，切 GitHub 后 raw 直连优先。
		source: () => settingsStore.get().updateSource,
	});
	// 旧覆盖层（没有 vendored 依赖的版本写的）启动自愈，不能要求用户先点一次「更新」
	builtInExtensionsUpdater.ensureOverlayVendorDependencies();
	// 后台更新检查：Windows / 支持自动升级的发行物走 electron-updater；
	// macOS 当前未签 Developer ID，不能承诺稳定的替换/重启，因此只检测 Release 并交给用户手动安装。
	// 两条路径都由同一个 UpdateService 快照推送渲染层，设置页能明确表达能力边界。
	// AtomGit 镜像源对 query string 返回 404，而 electron-updater 检查必带 noCache 参数：
	// 在 updater 首次发起请求前注册 webRequest 剥除器（幂等）。注意必须挂在
	// electron-updater 的独立 partition session（"electron-updater"）上，而不是 defaultSession
	// —— updater 的 ElectronHttpExecutor 用 session.fromPartition("electron-updater") 发请求，
	// 挂在 defaultSession 会拦不到（0.7.5 曾因此漏修）。
	installAtomgitNoCacheBypass(() => session.fromPartition(UPDATER_PARTITION_NAME, { cache: false }));
	const updateServiceBase = {
		settingsStore,
		// 更新通道（dev/stable，启动时已判定）：dev 强制 GitHub 源 + allowPrerelease（见 UpdateService.applyUpdateSource）。
		channel: updateChannel,
		checkPiUpdate: () => extensionManager.checkPiUpdate(),
		// 模型目录：复用设置页同一检查链路（GitHub main 分支 manifest 比对），结果并入更新快照。
		checkCatalogUpdate: () => catalogUpdater.checkRemote(),
		sendToRenderer: (snapshot: import("../shared/types").AppUpdateStatusSnapshot) => {
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send(ipcChannels.appUpdateStatusChanged, snapshot);
			}
		},
		log: (level: "info" | "warn", message: string, details?: Record<string, unknown>) => {
			if (level === "warn") void appLogger.warn("update", message, details ?? {});
			else void appLogger.info("update", message, details ?? {});
		},
		getCurrentVersion: () => app.getVersion(),
	};
	// quitAndInstall 会调用 app.quit；该标记让 closeToTray 放行真正的退出。
	let updateInstallSetQuitting = false;
	if (process.platform === "darwin") {
		const checkMacManualUpdate = createMacManualUpdateChecker({ channel: updateChannel });
		updateService = new UpdateService({
			...updateServiceBase,
			deliveryMode: "manual",
			// latestReleaseUrl（镜像源）由 UpdateService 按设置传入；null = 官方 GitHub。
			checkManualAppUpdate: (latestReleaseUrl?: string) => checkMacManualUpdate(app.getVersion(), latestReleaseUrl),
		});
	} else {
		updateService = new UpdateService({
			...updateServiceBase,
			deliveryMode: "automatic",
			autoUpdater: createRealAutoUpdater(),
			// closeToTray 会吞掉普通窗口关闭；安装器必须等待真实主进程退出。
			prepareForInstall: () => {
				updateInstallSetQuitting = !isQuitting;
				isQuitting = true;
			},
			// 同步失败或 watchdog 超时才会走这里；正常 quitAndInstall 会直接结束进程。
			rollbackInstallPreparation: () => {
				if (updateInstallSetQuitting) isQuitting = false;
				updateInstallSetQuitting = false;
			},
		});
	}
	updateService.start();
	registerCatalogIpc(catalogUpdater);
	// 快捷消息：唯一数据源是用户配置文件（可手工编辑），出厂清单来自随包资源文件。
	// 两个路径只在此处解析，避免“读 A 写 B”的漂移（与 extensions 覆盖层同源的教训）。
	const quickMessageStore = new QuickMessageStore({
		getConfigPath: () => join(app.getPath("userData"), QUICK_MESSAGES_FILE_NAME),
		getDefaultConfigPath: () => (app.isPackaged ? join(process.resourcesPath, QUICK_MESSAGES_DEFAULT_RESOURCE_NAME) : join(app.getAppPath(), "resources", QUICK_MESSAGES_DEFAULT_RESOURCE_NAME)),
		// 旧版本把清单存在 settings.json：仅作首次种子化来源，升级后用户的已改条目不能丢。
		getLegacyItems: () => settingsStore.get().quickMessages,
		log: (scope, message, detail) => void appLogger.info(scope, message, detail),
	});
	registerQuickMessagesIpc(quickMessageStore, (scope, message, detail) => void appLogger.info(scope, message, detail));
	// 回复快捷操作：最新回复尾部的建议条，规则可由用户编辑（userData/reply-actions.json），
	// 出厂规则来自随包资源 reply-actions.default.json（提交/推送/重试/继续等常用工程操作）。
	const replyActionRuleStore = new ReplyActionRuleStore({
		getConfigPath: () => join(app.getPath("userData"), REPLY_ACTIONS_FILE_NAME),
		getDefaultConfigPath: () => (app.isPackaged ? join(process.resourcesPath, REPLY_ACTIONS_DEFAULT_RESOURCE_NAME) : join(app.getAppPath(), "resources", REPLY_ACTIONS_DEFAULT_RESOURCE_NAME)),
		log: (scope, message, detail) => void appLogger.info(scope, message, detail),
	});
	registerReplyActionsIpc(replyActionRuleStore, (scope, message, detail) => void appLogger.info(scope, message, detail));
	registerBuiltInExtensionIpc(builtInExtensionsUpdater);
	// TokenDance 目录 store 是共享实例：渲染层目录展示与一键安装（写入配置）读同一份缓存。
	const tokendanceCatalogStore = new TokendanceCatalogStore({
		getCachePath: () => join(app.getPath("userData"), "tokendance-models.json"),
		log: (message, detail) => void appLogger.info("tokendance", message, detail),
	});
	registerSystemIpc({
		piLocator,
		settingsStore,
		configManager,
		projectResourceManager,
		agentManager,
		skillManager,
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
			const trustPath = project?.environment === "wsl" && process.platform === "win32" && settings.wslEnabled && settings.wslDistro ? toWslLinuxPath(projectRoot, { distro: settings.wslDistro }) : projectRoot;
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
		// 内置 TokenDance 模型目录（live fetch + userData 缓存；
		// 作为一键配置的数据源：目录模型写入 models.json 后由 pi 运行时自行解析）
		tokendanceCatalog: tokendanceCatalogStore,
		// 内置 TokenDance OAuth 授权（PKCE S256 headless；verifier 内存持有，重启失效）
		tokendanceAuth: new TokendanceAuthStore(),
		// 内置 TokenDance 充值：与模型调用同一个 API Key（从 models.json 解析，只在本进程使用），
		// 创建/查询都走既有用量探针传输层（Electron net，服从系统代理与超时/字节上界）。
		tokendancePayment: new TokendancePaymentStore({
			resolveEndpoint: () => configManager.resolveProviderEndpoint(TOKENDANCE_PROVIDER),
			request: usageProbeRequest,
		}),
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
		getMainWindow: () => mainWindow,
		// Logo 风格切换要同时刷托盘；Tray 实例归本文件持有，按 getter 注入避免 systemIpc 直接引用。
		getTray: () => tray,
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
			await petSystem?.reactToSettings(prev, next);
		},
		// CUA 开关：开启时启动进程内 MCP 端点并写入 pi 的 mcp.json，关闭时停端点并注销。
		reactToCuaSettings: async (prev, next) => {
			if (!cuaService || prev.cuaEnabled === next.cuaEnabled) return;
			if (next.cuaEnabled) {
				await cuaService.start();
			} else {
				await cuaService.stop();
			}
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
		setSessionCatalogIdentityContext: (ctx) => sessionCatalog.setIdentityContext(ctx),
		resolveWslEnvironment: async (distro, user, logger) => {
			const { resolveWslEnvironment: resolveWsl } = await import("./wsl/WslEnvironment");
			return resolveWsl(distro, user, logger);
		},
		configureSessionScannerWsl: (env) => sessionScanner.configureWsl(env),
		clearSessionScannerWsl: () => sessionScanner.clearWsl(),
		configureSkillManagerWsl: (env) => skillManager.configureWsl(env),
		// 技能正文读取：注入路径白名单上下文（全局技能目录 + 已注册项目根），
		// 由 readSkillContent 完成校验后读 SKILL.md；WSL 项目按主机路径读取。
		readSkillContent: (skillPath) =>
			readSkillContent(skillPath, {
				globalSkillPaths: skillManager.getLocations().map((location) => location.path),
				projectRootPaths: projectStore.list().map((project) => {
					const settings = settingsStore.get();
					if (process.platform === "win32" && project.environment === "wsl" && settings.wslEnabled && settings.wslDistro) {
						try {
							return toWindowsHostPath(project.path, { distro: settings.wslDistro });
						} catch {
							return project.path;
						}
					}
					return project.path;
				}),
			}),
		configurePromptManagerWsl: (env) => promptManager.configureWsl(env),
		configureExtensionManagerWsl: (env) => extensionManager.configureWsl(env),
		configureConfigManagerWsl: (env) => configManager.configureWsl(env),
		configureXuePromptManagerWsl: (env) => xuePromptManager.configureWsl(env),
		configureAgentManagerWsl: (env) => agentManager.configureWsl(env),
		// DSH host 同样需要 WSL 环境：它拿到的 workspace 路径必须是 Windows 主机路径
		// （WSL 模式下项目是 /mnt/...，host 的 realpath 会算到 C:\mnt 而报 ENOENT）。
		configureDshHostWsl: (env) => dshHost.configureWsl(env),
		sessionCommandIpcError,
		// 重启路径需要同步 isQuitting / 停服务，避免 closeToTray 吞掉 relaunch
		webServiceManager,
		terminalManager,
		isQuitting: {
			get value() {
				return isQuitting;
			},
			set value(next: boolean) {
				isQuitting = next;
			},
		},
		devBranch: isolateDevByGitBranch && !isSharedDevBranch(devGitBranch) ? devGitBranch : undefined,
		updateService: updateService ?? undefined,
	});

	registerStoreIpc({
		promptManager,
		skillManager,
		xuePromptManager,
		extensionManager,
		projectResourceManager,
		configManager,
		projectTrustPath: (projectRoot, projectId) => {
			const project = projectStore.get(projectId);
			const settings = settingsStore.get();
			if (project?.environment === "wsl" && process.platform === "win32" && settings.wslEnabled && settings.wslDistro) {
				try {
					return toWslLinuxPath(projectRoot, { distro: settings.wslDistro });
				} catch {
					return projectRoot;
				}
			}
			return projectRoot;
		},
		appLogger,
		mainCopy: mainCopy as (key: string, params?: Record<string, string | number>) => string,
	});

	// 外网访问（web:remote-access-*）：cloudflare 隧道 + tailscale serve 启停/状态
	registerWebRemoteAccessIpc({ remoteAccessManager });

	// 配置备份（config-backup:*）：恢复成功后重载 pideck 设置 + 刷新 pi 模型目录。
	registerBackupIpc({
		configBackupManager: configBackupManager!,
		appLogger,
		afterRestore: async () => {
			// 恢复写回的是磁盘文件：pideck 设置需重新 load 进内存（其它 store 仍持旧值，
			// UI 会提示重启生效）；pi 模型目录缓存刷新，避免恢复后仍用旧模型列表。
			await settingsStore.load();
			// 快捷键覆盖可能随备份一起被恢复：同步刷新主进程生效绑定，无需重启
			refreshShortcutBindings(settingsStore.get());
			// Logo 风格也可能随备份恢复：同步刷新窗口/Dock 图标
			applyWindowLogoStyle(settingsStore.get().logoStyle, () => mainWindow);
			void piModelCapabilityCache?.refresh().catch(() => undefined);
		},
	});

	registerTerminalIpc({
		appLogger,
		sessionRuntimeCoordinator,
		terminalManager,
		toSessionCommandIpcError: sessionCommandIpcError,
	});

	// ── 配置管理 ──────────────────────────────────────

	registerFilesIpc({
		fileSystemService,
		projectStore,
		settingsStore,
		appLogger,
		getMainWindow: () => mainWindow,
		openExternalUrl,
	});
	registerClipboardIpc({ appLogger });
	// 资源管理器右键菜单（HKCU）：菜单显示名跟随主进程 locale（可能随设置语言切换）
	registerShellMenuIpc({
		appLogger,
		menuTitle: mainCopy("shellMenu.openWithPiDeck"),
		quickTaskTitle: mainCopy("shellMenu.quickTask"),
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
	{ scheme: "pideck-bg", privileges: { secure: true, standard: true, corsEnabled: false, supportFetchAPI: true, stream: false } },
	{ scheme: "pideck-pet", privileges: { secure: true, standard: true, corsEnabled: false, supportFetchAPI: true, stream: false } },
	{ scheme: "pideck-sound", privileges: { secure: true, standard: true, corsEnabled: false, supportFetchAPI: true, stream: true } },
	// 生图历史图片：渲染层 <img> 直接加载落盘 blob，避免把 base64 搬回渲染进程堆
	{ scheme: "pideck-img", privileges: { secure: true, standard: true, corsEnabled: false, supportFetchAPI: true, stream: true } },
]);

app
	.whenReady()
	.then(async () => {
		// 未拿到同版本主实例锁时不要继续初始化，避免第二进程短暂闪窗。
		if (singleInstanceEnabled && !gotSingleInstanceLock) return;

		projectStore = new ProjectStore(() => mainCopy("dialog.chooseProjectFolder"));
		fileSystemService = new FileSystemService();
		sessionScanner = new SessionScanner(mainCopy);
		codexSessionImporter = new CodexSessionImporter(mainCopy);
		claudeSessionImporter = new ClaudeSessionImporter(mainCopy);
		qoderSessionImporter = new QoderSessionImporter(mainCopy);
		openCodeSessionImporter = new OpenCodeSessionImporter(mainCopy);
		zcodeSessionImporter = new ZCodeSessionImporter(mainCopy);
		workbuddySessionImporter = new WorkBuddySessionImporter(mainCopy);
		cursorSessionImporter = new CursorSessionImporter(mainCopy);
		kimiSessionImporter = new KimiSessionImporter(mainCopy);
		kimiWorkSessionImporter = new KimiWorkSessionImporter(mainCopy);
		minimaxSessionImporter = new MinimaxSessionImporter(mainCopy);
		// 外置目录会话导入：不复制会话文件，只把选定目录里的会话挂到当前项目（catalog 归属改写）。
		// 候选来自 SessionScanner 的全量清单（list() 不带项目参数）——项目目录改名后，
		// 那批会话仍然躺在 sessions 树里，只是项目过滤把它们排除了。
		directorySessionImporter = new DirectorySessionImporter({
			listSessions: () => sessionScanner.list(),
			readSessionName: (filePath) => sessionScanner.inferSessionNameFromFile(filePath),
			readDirectoryShape: async (dir) => {
				const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
				return {
					hasJsonl: entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")),
					// sessions 根形态：--D--Users-me-old-- 这样的 encoded 分组目录
					hasEncodedGroups: entries.some((entry) => entry.isDirectory() && /^--.*--$/.test(entry.name.trim())),
				};
			},
			listKnownFilePaths: () =>
				new Set(
					sessionCatalog
						.listEntries()
						.filter((entry) => Boolean(entry.filePath))
						.map((entry) => normalizeSessionPathKey(entry.filePath!)),
				),
			// 第四个参数是导入选项：manualAssignment 把归属钉在当前项目（旧目录项目扫描抢不回去）。
			mergeScanned: (projectId, summaries, options) => sessionCatalog.mergeScanned(projectId, summaries, undefined, options),
			// 原目录是否还在磁盘上（判定「目录被移动/改名」）；stat 失败按不存在处理。
			pathExists: async (path) => {
				try {
					await stat(path);
					return true;
				} catch {
					return false;
				}
			},
			// 会话扫描根：用于识别「用户选到了 ~/.pi 这类会话树祖先目录」，在弹窗里提示改选。
			readSessionRoots: () => sessionScanner.getSessionScanRoots(),
			onError: (sourcePath, error) => {
				void appLogger?.warn("session", "Directory session import failed", {
					sourcePath,
					error: error instanceof Error ? error.message : String(error),
				});
			},
		});
		settingsStore = new SettingsStore();
		// 安全管理：配置 owner + 策略快照写入（供 pi-deck-security-gate 扩展消费）
		securityStore = new SecurityStore({
			settingsStore,
			log: (domain, message, details) => void appLogger?.info(domain, message, details),
		});
		appLogger = new AppLogger();
		setAppLogger(appLogger);
		// 冷启动里程碑（1/2）：主进程 ready。sinceModuleLoadMs 从 index.ts 模块加载起算；
		// processUptimeMs 从 Electron 进程创建起算（含二进制启动），差值即 ready 前主进程耗时。
		void appLogger.info("app", "Cold start milestone: app ready", {
			sinceModuleLoadMs: Date.now() - bootAnchorMs,
			processUptimeMs: Math.round(process.uptime() * 1000),
		});
		// userData 更名迁移（pi-desktop → PiDeck）在 setPath 前同步执行，当时还没有日志器；
		// 结果在此补记，失败/回退路径必须可从日志诊断。
		if (userDataNameMigrationResult?.kind === "migrated") {
			void appLogger.info("migration", "userData directory renamed to PiDeck", {
				from: userDataNameMigrationResult.oldPath,
				to: userDataNameMigrationResult.userDataPath,
				sessionDirs: userDataNameMigrationResult.migratedSessionDirs.length,
			});
		} else if (userDataNameMigrationResult?.kind === "failed") {
			void appLogger.warn("migration", "userData rename failed; continuing on legacy dir, retry next launch", {
				reason: userDataNameMigrationResult.reason,
			});
		}
		rpcLogger = new RpcLogger();
		// 用量统计：pi-tracker 的 <agentDir>/analytics/usage.jsonl
		// + dsh-bill 的 <DSH_HOME>/dsh-bill/records.jsonl（采集由插件负责，此处只读）。
		// DSH_HOME 与 DshHost 同一套解析（设置覆盖 > ~/.dsh > 应用私有目录）。
		usageStatsService = new UsageStatsService({
			agentDir: join(app.getPath("home"), ".pi", "agent"),
			getDshHomeDir: () => resolveDshHomeDir(settingsStore.get().dshHomeDir ?? "", app.getPath("userData")),
			logger: {
				info: (message) => void appLogger?.info("usage-stats", message),
				warn: (message) => void appLogger?.warn("usage-stats", message),
			},
		});
		gitService = new GitService();
		gitRefsWatcher = new GitRefsWatcher({ logger: appLogger });
		// C12：退出清理登记（before-quit 统一 runAll；disposeAll 同时清空事件订阅）
		quitCleanup.register("git-refs-watcher", () => gitRefsWatcher.disposeAll());
		worktreeService = new WorktreeService(mainCopy);
		piLocator = new PiLocator(mainCopy);
		// 认证助手（见 AGENTS.md「认证例外通道」）：每次操作现解析 pi 入口，
		// 用户改自定义 pi 路径/代理后无需重启即可生效。
		piAuthService = new PiAuthService({
			resolveLaunch: () =>
				resolvePiAuthHostLaunch({
					settings: settingsStore.get(),
					locator: piLocator as PiLocator,
					userDataPath: app.getPath("userData"),
					appPath: app.getAppPath(),
					resourcesPath: process.resourcesPath,
					isPackaged: app.isPackaged,
				}),
			logger: {
				debug: (message) => void appLogger?.debug("pi-auth", message),
				info: (message) => void appLogger?.info("pi-auth", message),
				warn: (message) => void appLogger?.warn("pi-auth", message),
				error: (message) => void appLogger?.error("pi-auth", message),
			},
		});
		// 登录流程推送：弹框开着时才有接收方，窗口没了就静默丢弃（主进程仍会把结果落地）。
		piAuthService.setFlowSink((update) => {
			if (!mainWindow || mainWindow.isDestroyed()) return;
			mainWindow.webContents.send(ipcChannels.piAuthFlowUpdate, update);
		});
		// C12：退出清理登记（before-quit 统一 runAll）——登录子进程必须随之回收。
		quitCleanup.register("pi-auth", () => piAuthService?.dispose());
		// 提示词增强助手（见 AGENTS.md「提示词增强例外通道」）：常驻单进程，复用认证
		// 同一套 pi 入口解析；用户改自定义 pi 路径后下次增强生效（resolveLaunch 现求值）。
		enhancePromptService = new EnhancePromptService({
			resolveLaunch: () =>
				resolvePiAuthHostLaunch({
					settings: settingsStore.get(),
					locator: piLocator as PiLocator,
					userDataPath: app.getPath("userData"),
					appPath: app.getAppPath(),
					resourcesPath: process.resourcesPath,
					isPackaged: app.isPackaged,
					helperFilename: PI_ENHANCE_HOST_FILENAME,
				}),
			logger: {
				debug: (message) => void appLogger?.debug("enhance", message),
				info: (message) => void appLogger?.info("enhance", message),
				warn: (message) => void appLogger?.warn("enhance", message),
				error: (message) => void appLogger?.error("enhance", message),
			},
		});
		// C12：增强助手是常驻子进程，退出时必须回收。
		quitCleanup.register("enhance-prompt", () => enhancePromptService?.dispose());
		// DSH 用量链路（backend="dsh"）：配置落 $DSH_HOME/usage-probes.json、凭据从
		// $DSH_HOME/.credentials.yaml 读，与 pi 侧链路（~/.pi/agent）完全同构、互不干扰。
		// DSH_HOME 解析与 DshHost 同一套（设置覆盖 > ~/.dsh > 应用私有目录），getter 每次求值，
		// 用户改设置立即生效；readCredential 环境层优先、文件层兜底（与 DshHost 相同优先级）。
		configManager = new ConfigManager(undefined, mainCopy, {
			getHomeDir: () => resolveDshHomeDir(settingsStore.get().dshHomeDir ?? "", app.getPath("userData")),
			readCredential: async (ref) => {
				const envValue = process.env[ref]?.trim();
				if (envValue) return envValue;
				try {
					const filePath = join(resolveDshHomeDir(settingsStore.get().dshHomeDir ?? "", app.getPath("userData")), ".credentials.yaml");
					return credentialValueFromDocument(await readFile(filePath, "utf8"), ref);
				} catch {
					return undefined;
				}
			},
		});
		// 配置备份：pi 配置文件 + pideck 设置的快照（手动模式：仅首次使用自动建 first-run，
		// 之后备份/恢复都由用户在设置页手动触发）。
		// 依赖注入生效目录与 userData，WSL 切换后跟随 configManager.getConfigDir()。
		configBackupManager = new ConfigBackupManager({
			getConfigDir: () => configManager.getConfigDir(),
			getUserDataDir: () => app.getPath("userData"),
			getAppVersion: () => app.getVersion(),
			onError: (message, detail) => void appLogger?.warn("backup", message, { detail }),
		});
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
			if (!project) return null;
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
		const promptStoreUpdater = new PromptStoreUpdater({
			userDataDir: app.getPath("userData"),
			// 随包根与 skills/xueprompts.db 同一约定：dev 读 app.getAppPath()/resources，
			// 打包读 process.resourcesPath —— extraResources 的 `to` 已经把目录铺到
			// <app>/resources/<to>，这里再拼一层 "resources" 会指向不存在的路径。
			builtinPromptsDir: app.isPackaged ? join(process.resourcesPath, "prompts") : join(app.getAppPath(), "resources", "prompts"),
			// 与内置扩展/模型目录共用 settings.updateSource：默认 AtomGit，切 GitHub 后 raw 直连优先。
			source: () => settingsStore.get().updateSource,
		});
		const skillStoreUpdater = new SkillStoreUpdater({
			userDataDir: app.getPath("userData"),
			// 与 SkillManager.installTemplate 的 root 解析严格对齐：打包态 process.resourcesPath
			// 已是 <app>/resources，再拼一层会变成 <app>/resources/resources/skills。
			builtinSkillsDir: app.isPackaged ? join(process.resourcesPath, "skills") : join(app.getAppPath(), "resources", "skills"),
			source: () => settingsStore.get().updateSource,
		});
		registerContentStoreIpc(promptStoreUpdater, PROMPTS_STORE_CHANNELS);
		registerContentStoreIpc(skillStoreUpdater, SKILLS_STORE_CHANNELS);
		xuePromptManager = new XuePromptManager(
			undefined,
			// 官方模板覆盖层叠加：热更新后商店列表/详情立即显示覆盖层版本
			() => promptStoreUpdater.resolveEffectiveOverlayDir(),
		);
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
		// 启动时自动安装内置 usage-probe 技能模板到用户全局技能目录：
		// pi 只扫 ~/.pi/agent/skills、~/.agents/skills，不读 pideck 打包资源目录（resources/skills），
		// 必须落到用户目录，用户才能在聊天里 /skill:usage-probe 让 AI 引导写用量探针配置。
		// fire-and-forget：安装失败不阻塞启动，仅记日志（手动入口 configInstallUsageSkill 仍可兑底）。
		void skillManager.installUsageProbeTemplate().then((result) => {
			if (result.success) {
				void appLogger?.info("skill", "Usage probe skill template auto-installed", { path: result.path });
			} else {
				void appLogger?.warn("skill", "Usage probe skill template auto-install failed", { error: result.error });
			}
		});
		// 生图技能同样启动时自动落到用户全局技能目录（pi 只扫 ~/.pi/agent/skills 等，不读 resources/），
		// 否则用户无法 /skill:image-gen 触发生图。fire-and-forget，失败不阻塞启动。
		void skillManager.installImageGenTemplate().then((result) => {
			if (result.success) {
				void appLogger?.info("skill", "Image-gen skill template auto-installed", { path: result.path });
			} else {
				void appLogger?.warn("skill", "Image-gen skill template auto-install failed", { error: result.error });
			}
		});
		// 环境诊断技能启动时自动落到用户全局技能目录，用户可 /skill:pideck-doctor 让 pi 读诊断报告排障。
		// fire-and-forget，失败不阻塞启动。
		void skillManager.installPideckDoctorTemplate().then((result) => {
			if (result.success) {
				void appLogger?.info("skill", "Pideck-doctor skill template auto-installed", { path: result.path });
			} else {
				void appLogger?.warn("skill", "Pideck-doctor skill template auto-install failed", { error: result.error });
			}
		});
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
			// 包安装的扩展：整包停用写在 packages 条目过滤里（不在顶层 extensions 数组），
			// 必须单独查——否则开关写成功了、刷新后仍显示启用，开关弹回。
			if (extensionManagerNativePackages && isPackageSource(extension.source)) {
				const pkg = extensionManagerNativePackages.find((entry) => packageSourceOf(entry) === extension.source);
				if (pkg && isEntryDisabled(pkg)) return false;
			}
			return projectResourceEnabled({ entries, value: extension.path ?? extension.source, baseDir: extension.path ? dirname(extension.path) : "" });
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
					if (!project) return null;
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
				const settings = settingsStore.get();
				if (process.platform === "win32" && project.environment === "wsl" && settings.wslEnabled && settings.wslDistro) {
					try {
						return toWindowsHostPath(project.path, { distro: settings.wslDistro });
					} catch {
						return project.path;
					}
				}
				return project.path;
			},
			{
				getProjectTrustDecision: async (project) => {
					const settings = settingsStore.get();
					const cwd = process.platform === "win32" && project.environment === "wsl" && settings.wslEnabled && settings.wslDistro ? toWslLinuxPath(project.path, { distro: settings.wslDistro }) : project.path;
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
			(id) => projectStore.get(id),
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
		// C12：退出清理登记（before-quit 统一 runAll，新增资源不再改 before-quit）
		quitCleanup.register("pi-agents", () => agentManager?.stopAll());

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
		// GUI 扩展桥端点：关掉监听，释放端口（桥随 pi 子进程一起结束）
		quitCleanup.register("gui-bridge", () => stopBridgeServer());
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
			// G10：DSH 会话 HTML 导出目录（应用数据目录内，AGENTS.md 路径安全约束）
			() => join(app.getPath("userData"), "exports"),
			// 新会话无标题时的兜底标题（i18n；与外部会话导入兜底一致）
			() => mainCopy("session.dshUntitled"),
			rpcLogLiveBroadcaster,
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
		webServiceManager = new WebServiceManager({
			// 令牌持久化回写：manager 内自动生成/轮换/手动修改后落盘，重启沿用同一令牌。
			persistToken: (state) => {
				void settingsStore.update({ webServiceToken: state.token, webServiceTokenGeneratedAt: state.generatedAt, webServiceTokenExpiresIn: state.expiresIn }).catch((error) => appLogger.error("[WebService] persist token failed", error));
			},
			// dev 模式（electron-vite dev 不产出 out/renderer 构建物）下，静态资源
			// 代理到 vite dev server，外部 Web 端加载重构后的 React 版页面并支持热更新；
			// 打包/正式构建走 out/renderer 构建产物，此值为空。
			devRendererUrl: shouldUseDevRendererUrl() ? process.env.ELECTRON_RENDERER_URL : undefined,
			// 订阅 pi agent 事件流：供 Web SSE 端点转发给浏览器（与 FeishuBridge 同源机制）。
			subscribePiEvents: (handler) => agentManager.addLocalEventListener((agentId, event) => handler(agentId, event as never)),
			// agentId → sessionId 路由：pi 事件只有 agentId，SSE 连接按 session 订阅。
			getSessionIdForAgent: (agentId) => sessionRuntimeCoordinator.getSessionId(agentId),
			listProjects: () => projectStore.list(),
			createProject: (path) => projectStore.add(path, undefined, settingsStore.get().wslEnabled ? "wsl" : "windows"),
			deleteProject: async (projectId) => {
				if (!projectStore.get(projectId) || projectStore.get(projectId)?.kind === "chat") return false;
				const childIds = projectStore.listWorktreeChildren(projectId).map((child) => child.id);
				await projectStore.remove(projectId);
				for (const id of [projectId, ...childIds]) {
					await sessionCatalog.removeByProjectId(id).catch(() => 0);
				}
				return true;
			},
			listModels: async (force?: boolean) => {
				const snapshot = force ? await piModelCapabilityCache?.refresh() : await piModelCapabilityCache?.ensure();
				return snapshot?.models ?? (force ? refreshModelList(piLocator, settingsStore, configManager) : fetchModelList(piLocator, settingsStore, configManager));
			},
			listSessions: (projectId) => {
				const project = projectStore.get(projectId);
				return sessionScanner.list(project?.path);
			},
			listCatalogSessions: async (projectId) => {
				if (!projectId) {
					return sessionCatalog
						.listEntries()
						.map((entry) => sessionCatalog.getRecord(entry.id))
						.filter((record): record is SessionRecord => Boolean(record));
				}
				const project = projectStore.get(projectId);
				if (!project) throw new Error(mainCopy("project.notFound"));
				let projectPath = project.path;
				const settings = settingsStore.get();
				if (settings.wslEnabled && settings.wslDistro) {
					projectPath = projectPath.replace(/^([A-Za-z]):\\/, (_: string, drive: string) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, "/");
				}
				const summaries = await sessionScanner.list(projectPath);
				const { wslEnabled, wslDistro, wslUser } = settings;
				const records = await sessionCatalog.mergeScanned(projectId, summaries, wslEnabled ? { wslDistro, wslUser } : {});
				const bindings = sessionRuntimeCoordinator.attachCatalogRuntimes(records);
				for (const binding of bindings) {
					const tab = agentManager.list().find((candidate) => candidate.id === binding.agentId);
					if (tab) emitSessionRuntimeEvent(tab.id, ipcChannels.agentsState, tab);
				}
				return records;
			},
			createSessionDraft: async (input) => {
				const project = projectStore.get(input.projectId);
				if (!project) throw new Error(mainCopy("project.notFound"));
				const draft = await sessionCatalog.createDraft({
					projectId: input.projectId,
					title: input.title?.trim() || mainCopy("session.newTitle"),
					environment: settingsStore.get().wslEnabled ? "wsl" : "native",
					model: input.model ? createSessionModelPreference(input.model.provider, input.model.modelId, input.model.modelName) : undefined,
					thinkingLevel: input.thinkingLevel,
				});
				// standby 补热：与桌面 IPC（sessionIpc createDraft）同款——Web 建草稿即「马上要开聊」，
				// 趁用户输入空窗后台预热 pi 进程；首条消息经 activateRuntime 认领实现秒级启动。
				// fire-and-forget；ensure 幂等且受 standbyRuntimeEnabled 设置闸。
				if (draft.backend !== "dsh") agentManager.ensureStandbyAgent(draft.projectId);
				return draft;
			},
			createAnonymousSession,
			updateSessionRecord: async (sessionId, patch) => {
				const entry = sessionCatalog.get(sessionId);
				if (!entry) throw new Error(mainCopy("session.notFound"));
				const title = patch.title?.trim();
				if (title && title !== entry.title) {
					// Keep the same manual-over-auto ordering as the IPC domain handler.
					await sessionCatalog.claimTitleOwnership(sessionId);
					const target = sessionRuntimeCoordinator.getTarget(sessionId);
					if (target) {
						const renamed = await sessionRuntimeCoordinator.renameRuntime(target, title);
						if (!renamed.ok) throw sessionCommandIpcError(renamed.error);
					} else if (entry.filePath) {
						await sessionScanner.rename(entry.filePath, title);
					}
				}
				return sessionCatalog.update(sessionId, {
					...patch,
					...(patch.model ? { model: createSessionModelPreference(patch.model.provider, patch.model.modelId, patch.model.modelName) } : {}),
					title: title || undefined,
				});
			},
			deleteSessionRecord: async (sessionId) => {
				const entry = sessionCatalog.get(sessionId);
				if (!entry) return false;
				// Web 删除与桌面 IPC 同一策略：先解绑再删 catalog，agent 后台停。
				await sessionRuntimeCoordinator.releaseRuntimeForDelete(sessionId);
				if (entry.filePath) await sessionScanner.delete(entry.filePath);
				// DSH 没有 session.delete：与 pi 端同语义删除——把 host 会话目录移入系统回收站
				// （可恢复；trashPath 失败时抛错由 IPC 呈现，拒绝静默硬删；目录已不在=幂等成功）。
				// cwd 取项目目录（DSH workspace 编码同源）；项目被移除过则扫 sessions 树兑底。
				if (entry.backend === "dsh" && entry.dshSessionId) {
					const project = projectStore.get(entry.projectId);
					await dshHost.deleteSession(entry.dshSessionId, project?.path ?? "");
					// 记下墓碑：host 目录已移出 sessions 树，避免刷新把残留索引/回收站路径再导回侧栏。
					await sessionCatalog.rememberDismissedDshSession(entry.dshSessionId);
				}
				await sessionCatalog.removeWithDescendants(sessionId);
				return true;
			},
			copySessionRecord: (sessionId) => copyCatalogSession(sessionId),
			exportSessionRecordHtml: (sessionId) => exportCatalogSessionHtml(sessionId),
			readSessionReferenceMessages: (sessionId) => readCatalogSessionReferenceMessages(sessionId),
			readSessionMessages: async (sessionId) => {
				const entry = sessionCatalog.get(sessionId);
				// DSH 会话没有 pi 会话文件：读 host 历史事件流的一页（有界），
				// 与分页路径同源；未挂载 DSH 后端时返回空窗口。
				if (entry?.backend === "dsh" && entry.dshSessionId && dshAgentManager) {
					const page = await dshAgentManager.readHistoryPage(entry.dshSessionId, undefined, { maxMessages: 1000 });
					return { messages: page.messages, total: page.total, windowStart: 0, truncated: false };
				}
				if (!entry?.filePath) return { messages: [], total: 0, windowStart: 0, truncated: false };
				// 有界加载窗口（9 轮 + 条目预算），不是全量历史：全量下发在大会话上会同时顶爆
				// 主进程与渲染层（#213）。更早历史请走分页接口（Web：/messages/page）。
				const window = await agentManager.readSessionLoadWindow(entry.filePath, sessionId, { projectId: entry.projectId });
				return { ...window, truncated: window.windowStart > 0 };
			},
			readSessionMessagePage: async (sessionId, before, pageSize) => {
				const entry = sessionCatalog.get(sessionId);
				// DSH 会话没有 pi 会话文件：历史浏览走 host 的 session.history 事件流翻页
				// （游标 = 事件 seq），与 pi 的磁盘分页同形状（messages/total/nextBefore）。
				if (entry?.backend === "dsh" && entry.dshSessionId && dshAgentManager) {
					return dshAgentManager.readHistoryPage(entry.dshSessionId, before, { turnCount: pageSize });
				}
				if (!entry?.filePath) return { messages: [], total: 0, nextBefore: null };
				return agentManager.readSessionDisplayTurnPage(entry.filePath, sessionId, before, pageSize, undefined, { projectId: entry.projectId });
			},
			sendSessionPrompt: async (input) => {
				const result = await sessionRuntimeCoordinator.send(input);
				if (result.agentId) {
					const tab = agentManager.list().find((candidate) => candidate.id === result.agentId);
					if (tab) emitSessionRuntimeEvent(tab.id, ipcChannels.agentsState, tab);
				}
				return result;
			},
			listSessionRuntimes: () => sessionRuntimeCoordinator.listRuntimes(),
			listPendingUiRequests: () => sessionRuntimeCoordinator.listPendingUiRequests(),
			respondToUi: (input) => sessionRuntimeCoordinator.respondToUi(input),
			// S6.3：Web 端 DSH 工具面板（goals/subagents/skills）——与桌面 IPC 同源
			listDshSubagents: (agentId) => dshAgentManager.listSubagents(agentId),
			readDshSubagentHistory: (agentId, childSessionId, beforeSeq, maxMessages) => dshAgentManager.readSubagentHistory(agentId, childSessionId, beforeSeq, maxMessages),
			listDshSkills: (agentId) => dshAgentManager.listSkills(agentId),
			// S6.5：Web 端 DSH 插件管理（动态 Cordis 插件，与桌面配置页同源）
			listDshDynamicPlugins: () => dshHost.listDynamicPlugins(),
			listDshStaticPlugins: () => dshHost.listStaticPlugins(),
			uninstallDshUserPlugin: (input) => dshHost.uninstallUserPlugin(input),
			installDshPlugin: (input) => dshHost.installDynamicPlugin(input),
			runDshPlugin: (input) => dshHost.runDynamicPlugin(input),
			stopDshPlugin: (input) => dshHost.stopDynamicPlugin(input),
			uninstallDshPlugin: (input) => dshHost.uninstallDynamicPlugin(input),
			listSessionRuntimeModels: (target) => sessionRuntimeCoordinator.listRuntimeModels(target),
			stopSessionRuntime: stopSessionRuntime,
			abortSessionRuntime: (target) => sessionRuntimeCoordinator.abortRuntime(target),
			restartSessionRuntime: async (target) => {
				terminalManager.closeAgent(target.agentId);
				const result = await sessionRuntimeCoordinator.restartRuntime(target);
				if (result.ok) {
					if (!result.value.session.noSession) emitSessionRuntimeDetach(target);
					// 与桌面 IPC 同规约：新 runtime 的消息窗口在绑定前 flush 会被丢弃，
					// 重启后必须重下发（id 已由会话级身份延续保持稳定，不触发整窗 remount）。
					emitReplacementState(result.value.runtime, true);
				}
				return result;
			},
			compactSessionRuntime: (target, prompt) => sessionRuntimeCoordinator.compactRuntime(target, prompt),
			getSessionRuntimeState: (target) => sessionRuntimeCoordinator.getRuntimeState(target),
			listSessionRuntimeCommands: (target) => sessionRuntimeCoordinator.listRuntimeCommands(target),
			exportSessionRuntimeHtml: (target) => sessionRuntimeCoordinator.exportRuntimeHtml(target),
			editSessionRuntimeMessage: (target, messageId, newText) => sessionRuntimeCoordinator.editRuntimeMessage(target, messageId, newText),
			deleteSessionRuntimeMessage: (target, messageId) => sessionRuntimeCoordinator.deleteRuntimeMessage(target, messageId),
			listRewindCheckpoints: (target, params) => sessionRuntimeCoordinator.listRewindCheckpoints(target, params),
			getRewindCheckpointDiff: (target, checkpointId) => sessionRuntimeCoordinator.getRewindCheckpointDiff(target, checkpointId),
			restoreRewindCheckpoint: (target, checkpointId, scope) => sessionRuntimeCoordinator.restoreRewindCheckpoint(target, checkpointId, scope),
			prepareSessionRuntimeResend: (target, messageId) => sessionRuntimeCoordinator.prepareRuntimeResend(target, messageId),
			setSessionRuntimeModel: (target, provider, modelId, modelName) => sessionRuntimeCoordinator.setRuntimeModel(target, provider, modelId, modelName),
			setSessionRuntimeThinking: (target, level) => sessionRuntimeCoordinator.setRuntimeThinking(target, level),
			setSessionRuntimePermission: (target, preset) => sessionRuntimeCoordinator.setRuntimePermission(target, preset),
			cloneSessionRuntime: async (target) => {
				const validated = sessionRuntimeCoordinator.validateTarget(target);
				if (!validated.ok) return validated;
				try {
					return {
						ok: true as const,
						value: await replaceAgentSession(target.agentId, () => agentManager.cloneSession(target.agentId), { markForked: true }),
					};
				} catch (error) {
					return {
						ok: false as const,
						error: {
							code: "SESSION_COMMAND_FAILED" as const,
							debugDetails: error instanceof Error ? error.message : String(error),
						},
					};
				}
			},
			getForkMessages: (target) => sessionRuntimeCoordinator.getRuntimeForkMessages(target),
			forkRuntimeSession: (target, entryId) => sessionRuntimeCoordinator.forkRuntimeSession(target, entryId),
			// 会话活动监控（第二批 strips）：与桌面 sessionIpc.ts 同源同闸门
			listSessionFileChanges: (sessionId) => {
				const entry = sessionCatalog.get(sessionId);
				// DSH/生图会话无 pi 会话文件，文件汇总无意义
				if (!entry?.filePath || entry.backend === "dsh" || entry.backend === "imagegen") return Promise.resolve([]);
				return agentManager.readSessionFileChanges(entry.filePath);
			},
			listSessionSubagents: async (sessionId) => {
				const entry = sessionCatalog.get(sessionId);
				if (!entry?.filePath) return [];
				// 锚点对账要在读取侧做（liveRuntimeStartedAt，同桌面 sessionIpc）：
				// 运行中子代理只剩 start 锚点（record 完成时才写），不传对账时间会一律
				// 合成 stopped，面板误显「已停止」（issue #300）。
				const liveTarget = sessionRuntimeCoordinator.getTarget(sessionId);
				const liveTab = liveTarget ? agentManager.list().find((tab) => tab.id === liveTarget.agentId) : undefined;
				let records = await agentManager.readSessionSubagentRecords(entry.filePath, { liveRuntimeStartedAt: liveTab?.createdAt });
				// 与桌面同款对账：无活 runtime 时把残留 running 降级（终态通知未落盘）；
				// 活 runtime 按本代启动时间降级上一代派发的 running。
				if (!liveTarget) {
					if (!sessionRuntimeCoordinator.isActivating(sessionId)) {
						records = downgradeStaleRunning(records);
					}
				} else {
					if (liveTab?.createdAt) {
						records = downgradeRunningStartedBefore(records, liveTab.createdAt);
					}
				}
				return records;
			},
			listSessionTodo: (sessionId) => {
				const entry = sessionCatalog.get(sessionId);
				// DSH/生图会话无 pi 会话文件，无 todo 快照
				if (!entry?.filePath || entry.backend === "dsh" || entry.backend === "imagegen") return Promise.resolve(undefined);
				return agentManager.readSessionTodo(entry.filePath);
			},
		});
		// P1-P3 工作区路由（git/files/prompts）：只读能力注入，未装配的服务自动 503
		webServiceManager.workspaceRoutes = new WebWorkspaceRoutes({
			listProjects: () => projectStore.list(),
			git: {
				isGitRepo: (cwd) => gitService.isGitRepo(cwd),
				getBranches: (cwd) => gitService.getBranches(cwd),
				getStatus: (cwd) => gitService.getStatus(cwd),
				getWorkspaceFileDiff: (cwd, group, filePath, maxBytes) => gitService.getWorkspaceFileDiff(cwd, group, filePath, maxBytes),
				getCommitLog: (cwd, options) => gitService.getCommitLog(cwd, options),
			},
			files: {
				listTree: (root, maxDepth, directory) => fileSystemService.listTree(root, maxDepth, directory),
			},
			// 提示词库只在 SQLite 库可用时注入（缺库时路由返回 503，前端隐藏入口）
			prompts: xuePromptManager
				? {
						list: (opts) => xuePromptManager.list(opts),
						detail: (slug, category) => xuePromptManager.detail(slug, category),
					}
				: undefined,
			// 技能/扩展资产面板（第二批）：与桌面设置页同源；列表脱敏在路由层做
			assets: {
				listSkills: () => skillManager.list(),
				toggleSkill: (skillPath, enabled) => skillManager.toggle(skillPath, enabled),
				listExtensions: () => extensionManager.list(),
				setExtensionEnabled: (source, enabled, scope) => extensionManager.setEnabled(source, enabled, scope),
			},
		});
		// C12：退出清理登记（before-quit 统一 runAll）
		quitCleanup.register("theme-schedule", () => clearThemeScheduleTimer());
		quitCleanup.register("update-check", () => updateService?.stop());
		quitCleanup.register("web-service", () => webServiceManager?.stop());
		// 外网访问编排器：状态推送直达主窗口；渠道随 Web 服务启停收敛
		remoteAccessManager = new RemoteAccessManager({
			logger: appLogger,
			getWebServiceStatus: () => webServiceManager.getStatus(),
			// 隧道参数每次 start 取最新设置；修改后重启隧道生效
			getTunnelOptions: () => {
				const s = settingsStore.get();
				return { protocol: s.webRemoteCloudflaredProtocol ?? "http2", extraArgs: s.webRemoteCloudflaredExtraArgs };
			},
			pushState: (state) => {
				const win = mainWindow;
				if (win && !win.isDestroyed()) win.webContents.send(ipcChannels.webRemoteAccessChanged, state);
			},
		});
		quitCleanup.register("web-remote-access", () => remoteAccessManager?.dispose());
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
			() => settingsStore.get(),
		);
		// C12：退出清理登记（before-quit 统一 runAll）
		quitCleanup.register("terminal", () => terminalManager?.closeAll());

		await settingsStore.load();
		// 快捷键覆盖从磁盘载入后立即刷新主进程生效绑定（此后 settings:update 路径实时刷新）
		refreshShortcutBindings(settingsStore.get());
		// Logo 风格：启动时按已加载设置刷新窗口/Dock 图标（此后 settings:update 路径实时刷新）
		applyWindowLogoStyle(settingsStore.get().logoStyle, () => mainWindow);
		piModelCapabilityCache = new PiModelCapabilityCache({
			// 模型能力水合分两档（详见 docs/pi-model-capability-plan.md）：
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
			initialSessionSettings.wslEnabled ? { wslDistro: initialSessionSettings.wslDistro, wslUser: initialSessionSettings.wslUser } : {},
			// 会话路径统一绝对化：pi 的 sessionDir 配置为相对路径（如 ".pi/sessions"）时，
			// get_state 返回的 sessionFile 是相对 cwd 的；与扫描器绝对路径 originKey 不一致
			// 会导致同一会话在侧栏出现两条记录。加载与写入边界都经此归一化。
			(projectId, filePath, environment) => {
				const project = projectStore.get(projectId);
				if (!project) return filePath;
				return toAbsoluteSessionPath(filePath, project.path, environment);
			},
			// 占位标题回填 + 会话头有效性校验：未打开过的 pi 会话也能在侧栏显示首条消息标题
			// （不再永远 Untitled）；同一次有界读头部顺带校验首条记录是否带 type 头，
			// 把 pi-subagents transcript 等无 type 头的产物挡在 catalog 之外（#168）。
			(filePath, options) => sessionScanner.inferSessionNameAndValidity(filePath, options),
		);
		automationStore = new AutomationStore(join(app.getPath("userData"), "automation.json"));
		const automationStorePreload = automationStore.load();
		await Promise.all([sessionCatalog.load(), automationStorePreload]);

		// ── 旧禁用记录 → pi 原生配置迁移（计划 A3/A5）──
		// 启动期一次性执行：旧列表一旦被清理，原生过滤就是唯一生效来源。
		// 失败/未解析时保留旧记录并记日志（下次启动幂等重试），不静默打开用户禁用的资源。
		piResourceStateStore = new PiResourceStateStore(join(app.getPath("userData"), "pi-native-resources.json"));
		piResourceConfigService = new PiResourceConfigService(
			{
				globalSettingsPath: () => join(configManager.getConfigDir(), "settings.json"),
				resolveProject: async (projectId) => {
					const project = projectStore.get(projectId);
					if (!project || project.kind === "chat") return null;
					const root = project.path;
					const settings = settingsStore.get();
					const trustPath = process.platform === "win32" && project.environment === "wsl" && settings.wslEnabled && settings.wslDistro ? toWslLinuxPath(root, { distro: settings.wslDistro }) : root;
					return { root, trusted: (await configManager.getProjectTrustDecision(trustPath)) === true };
				},
			},
			piResourceStateStore,
			{ projectTrust: async (projectId, _root) => (await configManager.getProjectTrustDecision(projectStore.get(projectId)?.path ?? "")) === true },
		);
		/** 刷新技能/模板状态投影缓存（迁移完成、或用户切开关后调用）。 */
		const readNativeEntries = async (key: "skills" | "prompts" | "extensions"): Promise<string[] | null> => {
			try {
				const file = await readPiConfigFile(join(configManager.getConfigDir(), "settings.json"));
				const value = file.data[key];
				return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
			} catch {
				return null;
			}
		};
		const refreshSkillProjection = async (): Promise<void> => {
			skillManagerNativeEntries = await readNativeEntries("skills");
		};
		const refreshPromptProjection = async (): Promise<void> => {
			promptManagerNativeEntries = await readNativeEntries("prompts");
		};
		const refreshExtensionProjection = async (): Promise<void> => {
			try {
				const file = await readPiConfigFile(join(configManager.getConfigDir(), "settings.json"));
				const extensions = file.data.extensions;
				const packages = file.data.packages;
				extensionManagerNativeEntries = Array.isArray(extensions) ? extensions.filter((item): item is string => typeof item === "string") : [];
				extensionManagerNativePackages = Array.isArray(packages) ? packages.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item)) : [];
			} catch {
				extensionManagerNativeEntries = null;
				extensionManagerNativePackages = null;
			}
		};
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
					resources.push({ kind: "extensions", name: item.source, value: item.path ?? item.source, scope: item.scope === "project" ? "project" : "user" });
				}
				const skills = await skillManager?.list().catch(() => null);
				for (const skill of skills?.skills ?? []) {
					if (skill.sourceId !== "pi-global" && skill.sourceId !== "agents-global") continue;
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
		// 多后端网关装配：pi + dsh + acp（DSH 在窗口创建后后台预热，失败时按需重试；
		// ACP 无预热——每次 create 即 spawn 对应 CLI，工具表为空时 create 直接报错）。
		// Coordinator 与事件桥接均面向合成器，新增后端只需追加网关实例。
		acpAgentManager = new AcpAgentManager({
			piLocator,
			getProject: (projectId) => projectStore.get(projectId),
			getTools: () => settingsStore.get().acpTools ?? [],
			// ACP 会话标题（session_info_update）写回 catalog：ACP 无本地文件，标题在 agent 侧。
			onTitleChanged: (deckSessionId, title) => {
				const entry = sessionCatalog?.get(deckSessionId);
				if (!entry || entry.title === title) return;
				void sessionCatalog
					.update(entry.id, { title })
					.then(() => {
						if (mainWindow && !mainWindow.isDestroyed()) {
							mainWindow.webContents.send(ipcChannels.sessionsCatalogRefreshed, { projectId: entry.projectId });
						}
					})
					.catch((error: unknown) => {
						void appLogger.warn("session", "ACP title sync to catalog failed", { deckSessionId, title, error: error instanceof Error ? error.message : String(error) });
					});
			},
			logger: appLogger,
		});
		quitCleanup.register("acp", async () => {
			await acpAgentManager?.stopAll();
		});
		compositeAgentGateway = new CompositeAgentGateway([agentManager, dshAgentManager, acpAgentManager]);
		sessionRuntimeCoordinator = new SessionRuntimeCoordinator(sessionCatalog, compositeAgentGateway, sendAgentPromptWithIntegrations, appLogger);
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
				const isSuccess = run.status === "succeeded";
				const appName = app.getName();
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
			notifySessionCatalogChanged: (projectId) => notifyDshCatalogRefreshed([projectId]),
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
		agentManager.setAutomaticTitleChangedHandler((agentId, title, source) => {
			const sessionId = sessionRuntimeCoordinator?.getSessionId(agentId);
			if (!sessionId) return;
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
			if (sourceChannel === ipcChannels.agentsState && Array.isArray(payload)) {
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
				if (!forwarded && sourceChannel === ipcChannels.agentsUiRequest) {
					cancelUnboundUiRequest(payload);
				}
			}
		});

		// 根据已加载的 WSL 设置配置会话扫描器，使其能同时扫描 WSL 中的 pi 会话目录
		const syncWslConfig = async () => {
			const { wslEnabled, wslDistro, wslUser } = settingsStore.get();
			if (wslEnabled && wslDistro && wslUser) {
				const { resolveWslEnvironment: resolveWsl2 } = await import("./wsl/WslEnvironment");
				const wslEnv = await resolveWsl2(wslDistro, wslUser, {
					warn: (msg: string, detail: unknown) => console.warn("[PiDeck] " + String(msg), detail),
				});
				await sessionScanner.configureWsl(wslEnv);
				agentManager.configureWsl(wslEnv);
				// DSH host 是 Windows 原生进程：WSL 项目的 workspace 路径与会话目录编码
				// 都要按主机路径算，否则 workspace.resolve 失败、会话建不出来。
				dshHost.configureWsl(wslEnv);
				skillManager.configureWsl(wslEnv);
				promptManager.configureWsl(wslEnv);
				extensionManager.configureWsl(wslEnv);
				if (configManager) configManager.configureWsl(wslEnv);
				if (xuePromptManager) xuePromptManager.configureWsl(wslEnv);
				// 窗口已起来后再异步探测 WSL which，点会话时 resolveCommand 才能命中 wsl:// 缓存。
				void piLocator.warmWslCommand(wslDistro, wslUser).catch((error) => {
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
		};

		// 先注册 IPC 并创建窗口：WSL 探测 / pi settings / 代理 / Web 服务都可能卡住或抛错，
		// 不能挡在 createWindow 前面（打包便携版表现为「启动没反应」，dev 因热路径较短不易复现）。
		// GUI 扩展桥端点：只绑 127.0.0.1，起不来就静默跳过（桥不工作，pi 与 PiDeck 照常）。
		// 必须在任何 Agent spawn 之前启动，否则首个 agent 拿不到 PIDECK_BRIDGE_URL。
		// 放在 registerIpc 之前：端点与 IPC 注册无依赖，早启动早就绪。
		void getBridgeServer()
			.start()
			.then((info) => {
				if (!info) return;
				void appLogger?.info("app", "GUI bridge endpoint ready", { baseUrl: info.baseUrl });
			})
			.catch((error: unknown) => {
				void appLogger?.warn("app", "GUI bridge endpoint startup failed", error);
			});
		registerIpc();
		registerFeishuIpc({
			getMainWindow: () => mainWindow,
			feishuBridgeRef,
			agentManager,
			projectStore,
			sessionRuntimeCoordinator,
			feishuSessionRuntimeBindings,
			getCurrentLocale: currentFeishuLocale,
		});
		// 配置备份（手动模式）：仅在备份目录为空（首次使用）时自动建一份 first-run，
		// 之后不再自动备份。同步快，不挡首帧；失败仅记录，不阻断启动。
		configBackupManager?.ensureInitialBackups();
		await createWindow();
		// Quick tasks should not wait for unrelated WSL/proxy startup probes. The controller
		// retains validated intent until the renderer subscribes or requests its snapshot.
		const coldStartTarget = extractFocusTargetFromArgv(process.argv);
		await quickTaskChrome.applyLaunchTarget(coldStartTarget);
		setupTray();
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
			// 自动更新完成前 warmup 因 outdated 被跳过：装好且默认后端是 dsh 时补一次预热。
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

		// 窗口已可用后再按需预热 DSH：默认后端是 dsh 且 runtime 可用才后台 boot，
		// 避免纯 pi 用户空转 utilityProcess（约 200MB），也避免 runtime 不在时 boot 必然失败。
		// 用户手动停止过 DSH（dshManualStopped）时也跳过——不弹错误，用户下次显式启动即可。
		// 发送/历史/配置路径仍由 ensureStarted 兜底。
		startDshHostInBackground(dshHost, appLogger, {
			enabled: dshWarmupEnabled(),
		});

		// 模型 capability cache 的 hydration 在 syncWslConfig 后启动，确保它与 PiProcess
		// 使用同一套 WSL HOME/config 目录；不阻塞首帧。
		void syncWslConfig()
			.then(async () => {
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
		});
		void ensureAllPiSettingsDefaults().catch((error) => {
			console.error("Failed to ensure pi settings defaults:", error);
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

		sendTelemetryHeartbeat();

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
				});
		}
		// 设置里的开发诊断：热启停，不必改环境变量重启。默认关，生产零开销。
		if (settingsStore.get().developerDiagnostics) {
			void diagnosticsMonitor?.setEnabled(true).catch((error) => {
				console.error("Failed to start developer diagnostics:", error);
			});
		}

		// 项目列表可能位于杀软/同步盘较慢的 userData；窗口先显示，随后异步加载，避免 packaged app 打开时白屏等待。
		// 必须在冷启动跳转目标解析之前开始（并等它完成）：否则 findByPath 命中空项目表，
		// 已收录目录也会被当成新目录弹「添加为项目」（实测右键打开两次都走了 add 链路）。
		const projectStoreLoadPromise = projectStore.load();
		projectStoreReady = projectStoreLoadPromise.catch(() => undefined);
		void projectStoreLoadPromise
			.then(async () => {
				// load() 已丢掉 e2e 临时项目；对应 catalog 映射一并清掉，侧栏会话不会再挂回来。
				const knownProjectIds = new Set(projectStore.list().map((project) => project.id));
				const orphanProjectIds = new Set(
					sessionCatalog
						.listEntries()
						.map((entry) => entry.projectId)
						.filter((projectId) => !knownProjectIds.has(projectId)),
				);
				for (const projectId of orphanProjectIds) {
					await sessionCatalog.removeByProjectId(projectId).catch(() => 0);
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
			agentManager,
			settingsStore,
			getMainWindow: () => mainWindow,
			resolveSessionId: (agentId) => sessionRuntimeCoordinator.getSessionId(agentId),
			translate: (key, params) => mainCopy(key, params),
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

		// 声音提醒：纯主进程判定（settled/error 边沿/waiting 请求）+ 渲染层播放。
		// 与宠物系统同构，独立开关，不依赖宠物是否启用。
		registerSoundProtocol();
		registerSoundIpc();
		soundAlertService = new SoundAlertService({
			agentManager,
			settingsStore,
			getMainWindow: () => mainWindow,
			log: (domain, message, details) => void appLogger.info(domain, message, details),
		});
		soundAlertService.attach();
		// 退出清理登记（before-quit 统一 runAll）
		quitCleanup.register("sound-alert", () => {
			soundAlertService?.detach();
			soundAlertService = null;
		});

		// 应用公告：无服务器拉取（仓库 announcements.json，jsDelivr → 内置镜像 → raw 兜底），
		// 2h 周期 + 启动抖动；快照变化推给主窗口，已读集合持久化在 userData。
		announcementService = new AnnouncementService({
			userDataDir: app.getPath("userData"),
			appVersion: app.getVersion(),
			log: (domain, message, details) => void appLogger.info(domain, message, details),
			onSnapshot: (state) => {
				// 推送前判空 + isDestroyed：窗口销毁后 send 会抛
				const win = mainWindow;
				if (win && !win.isDestroyed()) win.webContents.send(ipcChannels.announcementChanged, state);
			},
		});
		announcementService.start();
		registerAnnouncementIpc(() => announcementService);
		// 退出清理登记（before-quit 统一 runAll）：停定时器，避免退出阶段仍触发拉取
		quitCleanup.register("announcement", () => {
			announcementService?.stop();
			announcementService = null;
		});

		// CUA（Computer Use Agent）：观察屏幕 + 注入鼠标/键盘输入，供 pi Agent 通过
		// `pideck-cua` MCP（主进程内 StreamableHTTP 端点）调用。默认关闭（cuaEnabled=false）：
		// 只有开启时才监听本地端点并写入 ~/.pi/agent/mcp.json，关闭时零副作用（不监听、不改 pi 配置）。
		// 真实输入注入另有「每次操作审批门 + 全局/会话杀开关」双重兜底（见 cua/CuaGate.ts）。
		cuaService = new CuaService({
			getMainWindow: () => mainWindow,
			log: (domain, message, details) => void appLogger.info(domain, message, details),
			// 免审批设置实时读取：改设置即时生效，无需重启 CUA 服务。
			getAutoApprove: () => settingsStore.get().cuaAutoApprove,
		});
		if (settingsStore.get().cuaEnabled) {
			void cuaService.start().catch((error) => {
				void appLogger.warn("cua", "CUA service start failed", error);
			});
		}
		quitCleanup.register("cua", async () => {
			// runAll 会逐项 await：返回 dispose 的 Promise 保证退出前 host 关闭 + mcp.json 反注册完成（早前 `void` 掉 Promise，退出竞态）。
			await cuaService?.dispose();
			cuaService = null;
		});

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
				mainWindow.show();
				mainWindow.focus();
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
	const homes = [app.getPath("home")];
	const wslSettings = settingsStore.get();
	if (wslSettings.wslEnabled && wslSettings.wslDistro && wslSettings.wslUser) {
		homes.push(`\\\\wsl$\\${wslSettings.wslDistro}\\home\\${wslSettings.wslUser}`);
	}
	for (const home of homes) {
		for (const name of legacyNames) {
			await removeStalePiDeckExtension(name, home).catch(() => undefined);
		}
	}
}

/**
 * 补齐 pi 全局 settings.json 的推荐默认项。
 * 仅添加缺失的 key，不覆盖用户已有配置。
 * 适用于新安装 pi 或配置精简的用户。
 */
/** 补齐指定 configDir 下 settings.json 的缺失默认项 */
async function ensurePiSettingsDefaults(configDir: string, piVersionHint?: string): Promise<void> {
	const filePath = join(configDir, "settings.json");
	let current: Record<string, unknown> = {};
	try {
		const raw = await readFile(filePath, "utf8");
		current = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		/* 文件不存在或解析失败，使用空对象 */
	}

	let changed = false;
	const defaults: Record<string, unknown> = {
		theme: "dark",
		hideThinkingBlock: false,
		defaultProjectTrust: "ask",
		compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
		retry: { enabled: true, maxRetries: 3 },
	};

	if (piVersionHint && !current.lastChangelogVersion) {
		current.lastChangelogVersion = piVersionHint;
		changed = true;
	}

	for (const [key, defaultValue] of Object.entries(defaults)) {
		if (!(key in current)) {
			current[key] = defaultValue;
			changed = true;
		}
	}

	if (changed) {
		await mkdir(configDir, { recursive: true });
		await writeFile(filePath, JSON.stringify(current, null, 2), "utf8");
		console.log("[PiDeck] Ensured pi settings defaults at:", filePath);
	}
}

/** 对当前环境和 WSL 环境（如果启用）都补齐 settings.json 默认项 */
async function ensureAllPiSettingsDefaults(): Promise<void> {
	const s = settingsStore.get();
	let piVersion = "";
	if (piLocator) {
		piVersion = (await piLocator.check(undefined, s.wslEnabled, s.wslDistro, s.wslUser).catch(() => null))?.version ?? "";
	}

	// Windows 本地
	const winDir = join(app.getPath("home"), ".pi", "agent");
	await ensurePiSettingsDefaults(winDir, piVersion).catch(() => {});

	// WSL（如果已配置）
	if (s.wslEnabled && s.wslDistro && s.wslUser) {
		const wslDir = join(`\\\\wsl$\\${s.wslDistro}\\home\\${s.wslUser}`, ".pi", "agent");
		await ensurePiSettingsDefaults(wslDir, piVersion).catch(() => {});
	}
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
