import {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	Menu,
	nativeImage,
	nativeTheme,
	net,
	protocol,
	session,
	shell,
	Tray,
} from "electron";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { is } from "@electron-toolkit/utils";
import { PetSystem, type PetSystemDeps } from "./pet";
import {
	applyLinuxDisplayBackendWorkaround,
	isUsingLinuxXWaylandWorkaround,
} from "./linuxDisplayBackend";
import {
	readElectronChromiumSandboxPreference,
	readPetEnabledPreference,
	readSingleInstancePreference,
} from "./settings/SettingsStore";
import { acquireVersionSingleInstance, type FocusPayload } from "./singleInstance";
import { isDevToolsShortcut, toggleMainWindowDevTools } from "./devTools";
import {
	DEFAULT_DEV_USER_DATA_NAME,
	isSharedDevBranch,
	readDevGitBranch,
	resolveDevUserDataDirName,
	sanitizeDevBranchSegment,
} from "./devIsolation";
import { resolvePackagedUserDataDir } from "./portableUserData";
import { extractFocusTargetFromArgv } from "./utils/focusTarget";
import type { Project, StartupWindowMode } from "../shared/types";
// 使用 ?asset 后缀导入图标，electron-vite 会在构建时将其复制到输出目录并提供正确的运行时路径
// 这解决了打包后 build/ 目录不在 asar 中导致托盘图标丢失的问题
import iconPath from "../../build/icon.png?asset";

// 构建标记：npm run dist:win:dev 打包时由 vite define 注入 true（构建期替换，非运行时环境变量）。
declare const __PIDECK_DEV_BUILD__: boolean;

// 开发态（electron-vite dev）或 dev 构建（dist:win:dev）统一使用 -dev 配置目录，
// 避免与正式版（pi-desktop / phids）的数据、单实例锁和通知归属互相污染。
const isDevBuild = !app.isPackaged || __PIDECK_DEV_BUILD__;

// E2E（Playwright 驱动）静默运行：窗口显示但不抢焦点、不最大化铺满屏，
// 避免打断用户在其他软件的输入。fixture 通过 env PIDECK_E2E=1 标识。
const isE2E = process.env.PIDECK_E2E === "1";

// 开发态与正式版隔离 userData。
// 否则 npm run dev 会与已安装的 PiDeck 共用数据/锁，表现为「开发启动被复用到正式版窗口」。
// 未打包的 npm run dev：功能分支再按 git 分支名拆目录（pi-desktop-dev-<branch>），
// 避免多个 worktree 同时启动共用 catalog / 单实例锁 / DSH home。main/dev 仍用历史目录。
// 打包的 dist:win:dev 仍固定 pi-desktop-dev（与脚本约定一致，复用现有开发配置）。
// 必须在读取 settings / 版本单实例锁之前设置。
const isolateDevByGitBranch = !app.isPackaged;
const devGitBranch = isolateDevByGitBranch ? readDevGitBranch() : undefined;
const devUserDataDirName = isolateDevByGitBranch
	? resolveDevUserDataDirName(devGitBranch)
	: DEFAULT_DEV_USER_DATA_NAME;
if (isDevBuild) {
	// 显式固定目录名：dev 构建的 productName 是 phidsDev，
	// 默认 userData 会落在 %APPDATA%\PiDeckDev，必须指回 dev 配置目录以复用现有配置。
	// 例外：命令行显式传入 --user-data-dir（e2e 隔离、多实例调试）时尊重该路径，
	// 否则 e2e 会读到本机真实开发数据（settings/projects 全部污染测试断言）。
	const explicitUserDataDirArg = process.argv.find((arg) => arg.startsWith("--user-data-dir="));
	const explicitUserDataDir = explicitUserDataDirArg?.slice("--user-data-dir=".length);
	if (explicitUserDataDir) {
		// Chromium accepts this switch independently, but Electron's app storage
		// APIs need the same path before settings and single-instance state load.
		app.setPath("userData", explicitUserDataDir);
	} else {
		app.setPath("userData", join(app.getPath("appData"), devUserDataDirName));
	}
} else {
	// 正式版：安装包仍用历史 %APPDATA%/pi-desktop；Windows 便携 exe 改落到
	// PORTABLE_EXECUTABLE_DIR/data，避免与安装版抢同一把版本单实例锁
	// （次实例会 app.exit(0)，用户看到「启动没反应」）。
	// 必须在读取 settings / 版本单实例锁之前设置。
	app.setPath("userData", resolvePackagedUserDataDir({ appData: app.getPath("appData") }));
}

// Linux XWayland 兼容层：仅当桌面宠物启用时才强制 ozone-platform=x11（#108，
// 强制 XWayland 在部分 GNOME/Wayland 环境会导致主窗口不可见）。
// ozone 平台一经启动不可更改，整个生命周期统一使用启动时快照。
// 注意必须放在 dev userData 覆盖之后，否则 dev 模式会误读正式版的 petEnabled。
const petEnabledAtLaunch = readPetEnabledPreference();
applyLinuxDisplayBackendWorkaround(petEnabledAtLaunch);

// Chromium 沙箱开关必须在 app.ready 前生效。
// 默认关闭：Windows 上部分安全软件/旧 GPU 驱动会在沙箱初始化时触发原生断点（0x80000003）。
// 用户可在「开发设置」中开启 electronChromiumSandbox，重启后走 Chromium 默认沙箱。
const electronChromiumSandboxEnabled = readElectronChromiumSandboxPreference();
if (!electronChromiumSandboxEnabled) {
	// 关闭沙箱时显式附带 no-sandbox，避免部分环境仍按默认策略启用。
	app.commandLine.appendSwitch("no-sandbox");
}

// V8 老生代堆上限（渲染进程 + 主进程 + worker 一并生效）：
// Chromium 默认上限 ≈ 物理内存 60%（8GB 机器 ≈ 4.8GB），V8 没有压力就不主动收缩，
// 会话消息/代码块高亮等大对象把堆撑大后 committed 空间长期不归还 OS（内存采样实测：
// V8 总 55MB → 210MB 不回落，RSS 基线随每次操作抬升）。
// 设 384MB：留 2 倍于实测 JS used 峰值（~185MB）的余量，超限即强制 GC 收缩。
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=384");

// Windows 系统通知必须设置 AppUserModelID，否则通知不显示、点击事件不触发。
// dev 与正式版使用不同 AppID，避免通知中心归属混淆（与 dev userData 隔离思路一致）。
if (process.platform === "win32") {
	const devAppId =
		devUserDataDirName === DEFAULT_DEV_USER_DATA_NAME
			? "com.ayuayue.pi-desktop-dev"
			: `com.ayuayue.pi-desktop-dev.${sanitizeDevBranchSegment(devGitBranch ?? "detached")}`;
	app.setAppUserModelId(isDevBuild ? devAppId : "com.ayuayue.pi-desktop");
}

// 注册 pideck:// 自定义协议：系统通知点击（toast activationType="protocol"）通过该协议唤起应用，
// 唤起实例的 argv 携带 pideck://session/<id> URL，主进程据此跳转对应会话。
// 仅 packaged 应用注册：dev 模式跑的是 electron 二进制，注册会把协议关联劫持到 electron.exe，
// 覆盖已安装正式版的关联；dev 模式下通知点击依赖 Electron 原生 click 事件聚焦即可。
// 安装包内 electron-builder 的 protocols 配置也会在安装时写入注册表，此处是运行时兜底。
if (app.isPackaged) {
	app.setAsDefaultProtocolClient("pideck");
}

// 按「应用版本」隔离的单实例：同版本复用窗口，不同版本可并行。
// 不用 Electron requestSingleInstanceLock：它按 userData 全局互斥，会导致 0.6.7 与 0.6.8 无法同开。
// focus 回调稍后挂到 focusMainWindow（定义在文件后部），避免顶层 TDZ。
// payload 携带次实例的 argv，可解析「点击系统通知」激活时携带的跳转目标。
let focusExistingWindow: ((payload?: FocusPayload) => void) | null = null;
const singleInstanceEnabled = readSingleInstancePreference();
const versionSingleInstance = acquireVersionSingleInstance(
	singleInstanceEnabled,
	app.getVersion(),
	(payload) => {
		focusExistingWindow?.(payload);
	},
);
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
import {
	mainProcessT,
	normalizeMainProcessLocale,
	type MainProcessLocale,
	type MainProcessTranslationKey,
} from "../shared/i18n/mainProcessCopy";
import {
	buildSessionOriginKey,
	canonicalizeSessionPath,
	looksLikePiSessionFileStem,
	toAbsoluteSessionPath,
} from "../shared/sessionIdentity";
import type {
	AgentTab,
	AgentUiRequest,
	AppSettings,
	AppUpdateAsset,
	AppUpdateDownloadProgress,
	AppLogLevel,
	AppLogQuery,
	AppUpdateDownloadResult,
	AvailableModel,
	ExternalEditor,
	ExternalEditorId,
	ExternalEditorSetting,
	AppUpdateInfo,
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
	CreatePiPromptTemplateInput,
	CreatePiSkillInput,
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
import { shouldAutoRegisterForeignCwd } from "./projects/projectPathPolicy";
import { defaultPathCheck } from "./projects/projectPresence";
import { FileSystemService } from "./fs/FileSystemService";
import { AgentManager } from "./pi/AgentManager";
import { PiProcess } from "./pi/PiProcess";
import { PiModelCapabilityCache, watchPiConfigDirectory } from "./pi/PiModelCapabilityCache";
// 生图消息不走 Agent 消息流，改名前需判断标题是否仍是占位名
import { isDefaultAgentTitle } from "./pi/agentUtils";
import { CompositeAgentGateway } from "./agents/CompositeAgentGateway";
import { DshHost, resolveDshHomeDir } from "./dsh/DshHost";
import { DshRuntimeStatusService } from "./dsh/runtime/DshRuntimeStatus";
import {
	DshRuntimeManager,
	DSH_BUNDLED_RUNTIME_DIRNAME,
	readBundledRuntime,
} from "./dsh/runtime/DshRuntimeManager";
import { DshRuntimeInstaller } from "./dsh/runtime/DshRuntimeInstaller";
import { createNetDownloader, createTarExtractor, fetchDshRuntimeIndex } from "./dsh/runtime/dshRuntimeIo";
import { credentialValueFromDocument } from "./dsh/dshCredentials";
import { DshAgentManager } from "./dsh/DshAgentManager";
import { startDshHostInBackground } from "./dsh/startDshHostInBackground";
import {
	importForeignSession,
	knownForeignSessionIds,
	syncForeignSessions,
	type DshForeignSyncDeps,
} from "./dsh/dshForeignSync";
import { PiLocator } from "./pi/PiLocator";
import { testPiProxy } from "./pi/PiProxyTester";
import { SessionScanner } from "./sessions/SessionScanner";
import { resolveLaunchDefaultOptions, isModelInModelsConfig } from "./sessions/launchDefaults";
import {
	SessionCatalog,
	canAttachRuntimeMetadata,
} from "./sessions/SessionCatalog";
import { aggregateDshProxyMode, buildHostProxyEnvPatch, resolveDshHostProxyMode, resolveEffectiveSessionProxyMode } from "./sessions/sessionProxyPolicy";
import {
	SessionRuntimeCoordinator,
	type SessionRuntimeBinding,
} from "./sessions/SessionRuntimeCoordinator";
import { IdleAgentReleaser } from "./sessions/IdleAgentReleaser";
import { SessionCommandIpcError } from "./sessions/SessionCommandIpcError";
import { appendSessionForkSuffix } from "./sessions/sessionForkTitle";
import { CodexSessionImporter } from "./sessions/CodexSessionImporter";
import { ClaudeSessionImporter } from "./sessions/ClaudeSessionImporter";
import { OpenCodeSessionImporter } from "./sessions/OpenCodeSessionImporter";
import { SettingsStore } from "./settings/SettingsStore";
import { SecurityStore } from "./security/SecurityStore";
import { applyDesktopProxy } from "./settings/DesktopProxy";
import { GitService } from "./git/GitService";
import { WorktreeService } from "./git/WorktreeService";
import { ConfigManager } from "./config/ConfigManager";
import { TerminalSessionManager } from "./terminal/TerminalSessionManager";
import { TelemetryService } from "./telemetry/TelemetryService";
import { PromptManager } from "./prompts/PromptManager";
import { XuePromptManager } from "./prompts/XuePromptManager";
import { SkillManager } from "./skills/SkillManager";
import { readSkillContent } from "./skills/readSkillContent";
import { ExtensionManager } from "./extensions/ExtensionManager";
import { createPiProcessExtensionResolvers } from "./extensions/piProcessExtensionResolvers";
import { ProjectResourceManager } from "./projects/ProjectResourceManager";
import { toWindowsHostPath } from "./wsl/WslPaths";
import { registerProjectsIpc } from "./ipc/projectsIpc";
import { registerUsageStatsIpc } from "./ipc/usageStatsIpc";
import { UsageStatsService } from "./usageStats/UsageStatsService";
import { readLastWindowBounds, saveLastWindowBounds } from "./windowState";
import { createRendererCrashRecoveryGuard } from "./window/rendererCrashRecovery";
import {
	registerBackgroundImageProtocol,
	registerBackgroundsIpc,
} from "./ipc/backgroundsIpc";
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
import { ImageGenConfigStore } from "./imagegen/ImageGenConfigStore";
import { VisionBridgeConfigManager } from "./settings/visionBridgeConfig";
import { registerSessionIpc, scheduleCatalogBackgroundScan } from "./ipc/sessionIpc";
import { registerSystemIpc } from "./ipc/systemIpc";
import { registerCatalogIpc } from "./ipc/catalogIpc";
import { setPiAiCatalogUserDataDir } from "./pi/piAiBuiltinCatalog";
import { PiAiCatalogUpdater } from "./pi/PiAiCatalogUpdater";
import { fetchModelList, refreshModelCatalogIfStale, refreshModelList } from "./pi/modelListCache";
import { registerFilesIpc } from "./ipc/filesIpc";
import { registerClipboardIpc } from "./ipc/clipboardIpc";
import {
	BROWSER_PANEL_PARTITION as BROWSER_PANEL_PARTITION_SHARED,
	isAllowedBrowserPanelUrl as isAllowedBrowserPanelUrlShared,
} from "./browser/browserSecurity";
import { WebServiceManager } from "./web/WebServiceManager";
import { preparePreloadPath } from "./preloadPath";
import { AppLogger } from "./logging/AppLogger";
import { setAppLogger } from "./logging/sharedLogger";
import { RpcLogger } from "./logging/RpcLogger";
import { registerEditorsIpc } from "./ipc/editorsIpc";
import {
	detectExternalEditors,
	listConfiguredExternalEditors,
	mergeDetectedExternalEditors,
	openProjectInEditor,
	validateExternalEditorCommand,
} from "./editors/EditorDetector";
import {
	FeishuBridge,
	type SessionRuntimeBindingGateway,
} from "./feishu/FeishuBridge";
import {
	feishuT,
	normalizeFeishuLocale,
	type FeishuLocale,
} from "./feishu/FeishuI18n";
import { wantsFeishuDoc } from "./feishu/docActions";
import { resolveFeishuFileSendIntent } from "./feishu/fileIntent";
import {
	listBots,
	getBot,
	addBot as addFeishuBot,
	removeBot as removeFeishuBot,
	updateBot as updateFeishuBot,
	getDecryptedBotAppSecret,
	getSessionBotId,
	setSessionBotId,
	setFeishuConfigDefaultBotName,
} from "./feishu/FeishuConfig";
import { startMemoryProfile, isMemoryProfileEnabled, type MemoryProfileHandle } from "./memory/MemoryMonitor";
import { DiagnosticsMonitor } from "./diagnostics/DiagnosticsMonitor";
import { EnvironmentDoctor } from "./health/EnvironmentDoctor";
import { LogBundleExporter } from "./health/LogBundleExporter";
import { QuitCleanupRegistry } from "./lifecycle/QuitCleanupRegistry";
import type { FeishuChatBinding } from "../shared/types";
import { checkAppUpdate as checkForAppUpdate, UPDATE_REPO, UPDATE_REPO_OWNER } from "./update/appUpdateCheck";
import { UpdateService } from "./update/UpdateService";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
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
let codexSessionImporter: CodexSessionImporter;
let claudeSessionImporter: ClaudeSessionImporter;
let openCodeSessionImporter: OpenCodeSessionImporter;
let settingsStore: SettingsStore;
let securityStore: SecurityStore;
let worktreeService: WorktreeService;
let gitService: GitService;
let piLocator: PiLocator;
let agentManager: AgentManager;
/** 全局模型 capability snapshot；仅在启动/配置变更时临时拉起 Pi。 */
let piModelCapabilityCache: PiModelCapabilityCache | undefined;
/** DSH 深融合宿主与后端网关；窗口创建后后台预热，发送链路仍可按需兜底。 */
let dshHost: DshHost;
/** DSH runtime 安装态服务（AgentRuntimeProvider 阶段 1）：installed 门控 UI/新建会话。 */
let dshRuntimeStatus: DshRuntimeStatusService;
/** DSH runtime 生命周期管理（阶段 2）：外部 runtime 的扫描/下载/安装/回收。 */
let dshRuntimeManager: DshRuntimeManager;
/** DSH runtime 安装编排（阶段 2）：索引选版本 + 进度广播。 */
let dshRuntimeInstaller: DshRuntimeInstaller;
let dshAgentManager: DshAgentManager;
/** 多后端合成网关（pi + dsh + 未来后端）；启动装配后赋值，供发送链路按 agentId 路由。 */
let compositeAgentGateway: CompositeAgentGateway | undefined;
let configManager: ConfigManager;
let promptManager: PromptManager;
let xuePromptManager: XuePromptManager;
let skillManager: SkillManager;
let extensionManager: ExtensionManager;
/** 后台更新检查服务（启动延迟 + 2h 周期，无配额方案）；null = 未初始化。 */
let updateService: UpdateService | null = null;
let projectResourceManager: ProjectResourceManager;
let webServiceManager: WebServiceManager;
let terminalManager: TerminalSessionManager;
let petSystem: PetSystem | null = null;
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
let feishuBridge: FeishuBridge | null = null;
let usageStatsService: UsageStatsService | null = null;
/** 粘贴文件启动清理（registerIpc 阶段赋值；whenReady 后 fire-and-forget 执行） */
let cleanupPasteFiles: (() => Promise<number>) | undefined;

/** 退出清理登记表（C12）：常驻资源创建处登记，before-quit 统一顺序执行。 */
const quitCleanup = new QuitCleanupRegistry();

// ── DSH 外部会话同步（dshForeignSync 编排；本文件只做依赖装配）────────────
// 清单来自磁盘只读扫描（不启动 host）；目标项目按会话自己的 cwd 建/挂，无 cwd 才兑底。
// 标题优先官方 session_projcache；cwd 末段只作占位，下次扫描有投影名会覆盖。
// 依赖闭包延迟引用模块级实例（registerIpc/whenReady 阶段才赋值），调用时已就绪。
const foreignSyncDeps: DshForeignSyncDeps = {
	listForeignSessions: () => dshHost.listForeignSessions(),
	findProjectByPath: (cwd) => projectStore.findByPath(cwd),
	// 会话自带工作目录但侧栏还没有该项目：按该目录注册，打开会话时 cwd 才对得上。
	// 已删记录 / e2e 临时目录 / 磁盘不存在：拒绝注册，避免「删了重启又回来」。
	shouldRegisterCwd: async (cwd) => shouldAutoRegisterForeignCwd(cwd, {
		dismissedPaths: projectStore.listDismissedPaths(),
		pathExists: await defaultPathCheck(cwd),
	}),
	ensureProjectForCwd: (cwd) => projectStore.add(
		cwd,
		undefined,
		settingsStore.get().wslEnabled ? "wsl" : "windows",
	),
	ensureFallbackProject: () =>
		projectStore.ensureExternalSessionsProject(mainCopy("project.externalSessions")),
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
	const visible = s.wslEnabled
		? projectStore.list().filter((p) => p.kind === "chat" || p.environment === "wsl")
		: projectStore.list().filter((p) => p.kind === "chat" || !p.environment || p.environment === "windows");
	// 这里只广播 store 清单；渲染层接到事件后会再调用 projects:list 附加实时 presence。
	// 直接把未检测版本写进 atom 会短暂抹掉 missing 标记，使失效目录看起来又恢复正常。
	window.webContents.send(ipcChannels.projectsChanged, visible);
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
	const result = await syncForeignSessions(
		foreignSyncDeps,
		knownForeignSessionIds(sessionCatalog.listEntries()),
	);
	if (result.imported > 0 || result.skipped > 0) {
		// skipped>0 也可能是纠正归属（从兑底拆到各自目录），侧栏要重拉。
		notifyDshCatalogRefreshed(
			sessionCatalog.listEntries()
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
}

function emitSessionRuntimeEvent(
	agentId: string,
	sourceChannel: string,
	payload: unknown,
): boolean {
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
	if (payload && typeof payload === "object" && !Array.isArray(payload)) {
		const tab = payload as Partial<AgentTab>;
		if (typeof tab.sessionPath === "string" && tab.sessionPath) {
			const entry = sessionCatalog.get(runtimeBinding.sessionId);
			if (
				canAttachRuntimeMetadata(entry, tab) &&
				(entry?.filePath !== tab.sessionPath || entry.piSessionId !== tab.sessionId)
			) {
				// 仅 pi JSONL 走文件配对。DSH 的 sessionPath 是 zstd，canAttach 已拒绝；
				// host id 由 Coordinator activate/dispatch 回写 dshSessionId。
				void sessionCatalog.attachRuntime({
					sessionId: runtimeBinding.sessionId,
					filePath: tab.sessionPath,
					piSessionId: tab.sessionId,
				}).catch(() => undefined);
			}
		}
	}
	sendSessionRuntimeEnvelope(event);
	const tab = payload && typeof payload === "object" && !Array.isArray(payload)
		? payload as Partial<AgentTab>
		: undefined;
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

async function createAnonymousSession(
	input: CreateAnonymousSessionInput,
): Promise<CreateAnonymousSessionResult> {
	const project = projectStore.get(input.projectId);
	if (!project) throw new Error(mainCopy("project.notFound"));

	// Resolve pi-configured defaults so the composer bar shows the effective
	// model / thinking level even before the anonymous Agent is fully started.
	let model = input.model;
	let thinkingLevel = input.thinkingLevel;
	try {
		const [settingsResult, modelsResult] = await Promise.all([
			configManager.getSettingsConfig(),
			configManager.getModelsConfig(),
		]);
		// 渲染层/引导页显式传入的模型（欢迎页偏好等）也可能指向已删除条目：
		// 校验仍存在于 models.json，不存在则丢弃交给解析器兜底（lastUsed → 显式默认 → 第一个可用）。
		if (model && !isModelInModelsConfig(modelsResult.parsed, model)) {
			model = undefined;
		}
		// 缺省填充与引导页展示共用同一解析器（launchDefaults，含「最后一次使用」优先）：
		// 保证「预选的默认」与「创建时真正套用的默认」永远同源。
		const defaults = resolveLaunchDefaultOptions({
			backend: "pi",
			settings: settingsResult.parsed,
			models: modelsResult.parsed,
			lastUsedModel: settingsStore.get().lastUsedModel,
		});
		if (!model) {
			model = defaults.model;
		}
		if (!thinkingLevel) {
			thinkingLevel = defaults.thinkingLevel;
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

async function activateAnonymousRuntime(
	session: SessionRecord,
	project: Project,
	input: CreateAnonymousSessionInput,
): Promise<AgentTab> {
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
		if (input.model) {
			const result = await sessionRuntimeCoordinator.setRuntimeModel(runtime, input.model.provider, input.model.modelId);
			if (!result.ok) throw new Error(result.error.code);
		}
		if (input.thinkingLevel) {
			const result = await sessionRuntimeCoordinator.setRuntimeThinking(runtime, input.thinkingLevel);
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
async function stopAgentFromMonitor(
	agentId: string,
): Promise<SessionCommandResult<SessionRuntimeTarget | undefined>> {
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
	const result = await agentManager.cloneSessionFile(entry.projectId, entry.filePath, entry.environment) as {
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
	});
	return { cancelled: false, targetSessionId: copied.id };
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

async function replaceAgentSession(
	agentId: string,
	replace: () => Promise<unknown>,
	options?: { markForked?: boolean },
): Promise<AgentSessionReplacementResult & { targetSessionId?: string }> {
	const originBinding = sessionRuntimeCoordinator.getRuntimeBinding(agentId);
	const originEntry = originBinding
		? sessionCatalog.get(originBinding.sessionId)
		: undefined;
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
			return result && typeof result === "object" && !Array.isArray(result)
				? result as AgentSessionReplacementResult
				: {};
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
			});
			return target.id;
		},
		canRestoreOrigin: () => {
			const tab = agentManager.list().find((candidate) => candidate.id === agentId);
			if (!originKey || !tab?.sessionPath) return false;
			return buildSessionOriginKey({
				source: tab.sessionSource ?? "pi",
				environment: tab.sessionEnvironment ?? "native",
				filePath: tab.sessionPath,
				wslDistro: tab.wslDistro,
				wslUser: tab.wslUser,
				importedSourceId: tab.importedSourceId,
			}) === originKey;
		},
		onDetached: emitSessionRuntimeDetach,
		onAttached: (binding) => emitReplacementState(binding, true),
		onRestored: (binding) => emitReplacementState(binding, false),
	});
}

function cancelUnboundUiRequest(payload: unknown): void {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
	const request = payload as Partial<AgentUiRequest>;
	if (
		typeof request.agentId !== "string" ||
		typeof request.requestId !== "string" ||
		request.completed === true ||
		!(["select", "confirm", "input", "editor", "batch_ask"] as const).some(
			(method) => method === request.method,
		)
	) {
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
		});
		return { sessionId: draft.id };
	},
	async activateRuntime(sessionId) {
		const activated = await sessionRuntimeCoordinator.activateRuntime(sessionId);
		if (!activated.ok) throw sessionCommandIpcError(activated.error);
		const tab = agentManager.list().find((candidate) => candidate.id === activated.value.agentId);
		if (!tab) throw sessionCommandIpcError({
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
		const environment = input.agent.sessionEnvironment ?? (
			settingsStore.get().wslEnabled ? "wsl" : "native"
		);
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
			sessionId = sessionCatalog.listEntries().find((candidate) => (
				candidate.filePath &&
				buildSessionOriginKey({
					source: candidate.source,
					environment: candidate.environment,
					filePath: candidate.filePath,
					wslDistro: candidate.wslDistro,
					wslUser: candidate.wslUser,
					importedSourceId: candidate.importedSourceId,
				}) === targetOrigin
			))?.id;
		}
		if (!sessionId) {
			const draft = await sessionCatalog.createDraft({
				projectId: input.projectId,
				title: input.agent.title || "Feishu session",
				environment,
				source,
			});
			sessionId = draft.id;
		}
		await sessionCatalog.attachRuntime(input.agent.sessionPath ? {
			sessionId,
			filePath: input.agent.sessionPath,
			piSessionId: input.agent.sessionId,
		} : {
			sessionId,
			piSessionId: input.agent.sessionId,
		});
		const runtimeGeneration = sessionRuntimeCoordinator.bindExistingAgent(
			sessionId,
			input.agent.id,
		);
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
	nativeTheme.themeSource = settings.theme === "system"
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
		const delay = msUntilNextThemeBoundary(
			new Date(),
			settings.themeScheduleLightStart,
			settings.themeScheduleDarkStart,
		);
		themeScheduleTimer = setTimeout(() => {
			applyNativeThemeSource(settingsStore.get());
		}, delay);
	}
}

const RELEASES_URL = `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO}/releases`;
const POSTHOG_PROJECT_KEY =
	process.env.POSTHOG_PROJECT_KEY ??
	"phc_xgJ8gFUMgExZEEPzZ7VRa7698ENcaDRquWZVGYb2dCFK";
const POSTHOG_HOST = process.env.POSTHOG_HOST ?? "https://us.i.posthog.com";


function emitUpdateProgress(progress: AppUpdateDownloadProgress) {
	if (!mainWindow || mainWindow.isDestroyed()) return;
	mainWindow.webContents.send(ipcChannels.appUpdateProgress, progress);
}

async function downloadUpdateAsset(asset: AppUpdateAsset): Promise<AppUpdateDownloadResult> {
	if (!asset.url || !/^https:\/\//i.test(asset.url)) {
		void appLogger.warn("update", "Rejected invalid update download URL", {
			assetName: asset.name,
			url: asset.url,
		});
		throw new Error(mainCopy("update.invalidDownloadUrl"));
	}

	const safeName = basename(asset.name).replace(/[<>:"/\\|?*]+/g, "-");
	const downloadDir = join(app.getPath("userData"), "updates");
	await mkdir(downloadDir, { recursive: true });
	const filePath = join(downloadDir, safeName);
	const startedAt = Date.now();
	let receivedBytes = 0;
	let totalBytes = asset.size > 0 ? asset.size : undefined;

	// 使用 Electron net 下载可继承 Chromium 的 TLS/代理能力；进度通过 IPC 推送给 renderer。
	return new Promise((resolve, reject) => {
			void appLogger.info("update", "Download update asset started", { assetName: asset.name, url: asset.url });
		const request = net.request({ method: "GET", url: asset.url });
		request.setHeader("User-Agent", `pi-desktop/${app.getVersion()}`);
		request.on("redirect", (_statusCode, _method, redirectUrl) => {
			// GitHub browser_download_url 通常会 302 到对象存储,必须显式跟随重定向。
			request.followRedirect();
			void appLogger.debug("update", "Follow update download redirect", { redirectUrl });
		});
		request.on("response", (response) => {
			if (response.statusCode < 200 || response.statusCode >= 300) {
				const publicError = new Error(mainCopy("update.downloadFailed"));
				void appLogger.warn("update", "Update download returned an error status", {
					assetName: asset.name,
					statusCode: response.statusCode,
				});
				emitUpdateProgress({ assetName: asset.name, receivedBytes, totalBytes, state: "failed", error: publicError.message });
				reject(publicError);
				return;
			}

			const contentLength = Number(response.headers["content-length"]);
			if (Number.isFinite(contentLength) && contentLength > 0) totalBytes = contentLength;
			const output = createWriteStream(filePath);
			response.on("data", (chunk: Buffer) => {
				receivedBytes += chunk.length;
				output.write(chunk);
				const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
				emitUpdateProgress({
					assetName: asset.name,
					receivedBytes,
					totalBytes,
					percent: totalBytes ? Math.min(100, (receivedBytes / totalBytes) * 100) : undefined,
					bytesPerSecond: receivedBytes / elapsedSeconds,
					state: "downloading",
				});
			});
			response.on("end", () => output.end());
			output.on("finish", () => {
				output.close(() => {
					emitUpdateProgress({ assetName: asset.name, receivedBytes, totalBytes, percent: 100, state: "completed", filePath });
					void appLogger.info("update", "Download update asset completed", { assetName: asset.name, filePath, receivedBytes });
					resolve({ filePath, assetName: asset.name });
				});
			});
			output.on("error", (error) => {
				void appLogger.warn("update", "Failed to write update package", {
					assetName: asset.name,
					error: error.message,
				});
				const publicError = new Error(mainCopy("update.downloadFailed"));
				emitUpdateProgress({ assetName: asset.name, receivedBytes, totalBytes, state: "failed", error: publicError.message });
				reject(publicError);
			});
		});
		request.on("error", (error) => {
			void appLogger.warn("update", "Update download request failed", {
				assetName: asset.name,
				error: error.message,
			});
			const publicError = new Error(mainCopy("update.downloadFailed"));
			emitUpdateProgress({ assetName: asset.name, receivedBytes, totalBytes, state: "failed", error: publicError.message });
			reject(publicError);
		});
		request.end();
	});
}

async function installDownloadedUpdate(filePath: string) {
	// Windows/Linux 不同包类型的真正静默自更新风险较高；这里交给系统打开安装包或文件位置。
	// 便携版用户通常下载 zip/AppImage/tar.gz 后需要替换当前目录,避免在运行中覆盖自身可执行文件。
	await appLogger.info("update", "Open downloaded update package", { filePath });
	const openError = await shell.openPath(filePath);
	if (openError) {
		await appLogger.warn("update", "Failed to open downloaded update package", {
			filePath,
			error: openError,
		});
		throw new Error(mainCopy("update.openFailed"));
	}
}

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
	tray.setContextMenu(Menu.buildFromTemplate([
		{
			label: mainCopy("tray.showWindow"),
			click: () => {
				if (mainWindow && !mainWindow.isDestroyed()) {
					mainWindow.show();
					mainWindow.focus();
				}
			},
		},
		{ type: "separator" },
		{
			// 托盘重启与系统设置 IPC 的 appRestart 保持同一套清理语义
			label: mainCopy("tray.restart"),
			click: restartApp,
		},
		{ type: "separator" },
		{
			label: mainCopy("tray.quit"),
			click: () => {
				isQuitting = true;
				app.quit();
			},
		},
	]));
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
 * 页面加载期间（冷启动/窗口重建）点击通知的跳转目标：直接 send 会在 preload/React
 * 监听注册前丢失，先存入 pending，由两条路径兜底送达：
 * 1. did-finish-load 后 flush 一次（窗口重建/旧 renderer 兼容的尽力而为）；
 * 2. renderer 挂载后经 pet:get-focus-target-pending 主动拉取（取走即清空，保证送达）。
 */
let pendingFocusTarget: { sessionId: string } | null = null;

/** 窗口就绪（存在且未在加载）直接推送；否则入 pending 队列。 */
function queueFocusTarget(sessionId: string) {
	if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
		mainWindow.webContents.send(ipcChannels.petFocusAgentTarget, { sessionId });
		return;
	}
	pendingFocusTarget = { sessionId };
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
	const activateSession = () => {
		if (!target) return;
		let sessionId = target.sessionId;
		if (!sessionId && target.agentId && sessionRuntimeCoordinator) {
			sessionId = sessionRuntimeCoordinator.getSessionId(target.agentId);
		}
		if (sessionId) queueFocusTarget(sessionId);
	};
	if (mainWindow && !mainWindow.isDestroyed()) {
		focusMainWindow();
		activateSession();
		return;
	}
	void app.whenReady().then(() => {
		if (mainWindow && !mainWindow.isDestroyed()) {
			focusMainWindow();
			activateSession();
			return;
		}
		if (settingsStore) {
			void createWindow()
				.then(() => {
					activateSession();
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
	// iconPath 由 electron-vite 的 ?asset 后缀自动解析，打包后也能正确定位
	const icon = nativeImage.createFromPath(iconPath);
	tray = new Tray(icon.resize({ width: 16, height: 16 }));
	tray.setToolTip("PiDeck");
	// C12：退出清理登记（before-quit 统一 runAll）
	quitCleanup.register("tray", () => {
		tray?.destroy();
		tray = null;
	});

	// 双击托盘图标恢复窗口（Windows 常见交互）
	tray.on("double-click", () => {
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.show();
			mainWindow.focus();
		}
	});

	refreshTrayContextMenu();
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
	const effectiveInstallationType =
		process.platform === "win32" && isPortableEnv ? "portable" : persistentInstallationType;

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
		console.log("%c  PORTABLE_EXECUTABLE_DIR: %c${isPortableEnv ? '✅ Set' : '❌ Not set'}", "color: #6b7280;", "color: ${isPortableEnv ? '#10b981' : '#ef4444'};");
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
		browserPanelSession.webRequest.onBeforeRequest(
			(details, callback) => {
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
		// 转发 DevTools 快捷键到主窗口开关，避免焦点在内置浏览器面板时 F12 无响应。
		guest.on("before-input-event", (event, input) => {
			if (!isDevToolsShortcut(input)) return;
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
	const isDark = resolveAppColorScheme({
		theme: windowThemeSettings.theme,
		themeScheduleLightStart: windowThemeSettings.themeScheduleLightStart,
		themeScheduleDarkStart: windowThemeSettings.themeScheduleDarkStart,
		systemPrefersDark: nativeTheme.shouldUseDarkColors,
	}) === "dark";
	const backgroundColor = isDark ? "#121212" : "#f8f8f5";

	// 按外观设置的启动预设调整初始尺寸；隐藏态先 maximize/fullscreen，减少首帧跳动。
	// startupWindowMode="last"：读上次关闭时的窗口大小；读不到（首次启动/记录损坏）顺延默认 maximized
	const requestedMode = settingsStore.get().startupWindowMode ?? "last";
	let effectiveStartupMode = requestedMode;
	let startupBounds: { width: number; height: number };
	if (requestedMode === "last") {
		const last = readLastWindowBounds(app.getPath("userData"));
		if (last) {
			startupBounds = last;
		} else {
			effectiveStartupMode = "maximized";
			startupBounds = resolveStartupWindowBounds("maximized");
		}
	} else {
		startupBounds = resolveStartupWindowBounds(requestedMode);
	}

	mainWindow = new BrowserWindow({
		show: showMainWindowImmediately,
		backgroundColor,
		width: startupBounds.width,
		height: startupBounds.height,
		minWidth: 880,
		minHeight: 640,
		// 多 worktree 并行 dev：标题带分支名，任务栏/Alt-Tab 一眼区分窗口
		title: isolateDevByGitBranch && !isSharedDevBranch(devGitBranch)
			? `PiDeck · ${devGitBranch}`
			: "PiDeck",
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
		},
	});
	const createdWindow = mainWindow;
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
		// 向开发者工具输出启动信息
		printStartupInfo();
	}

	// 窗口保持隐藏时先按启动预设调整（maximize/fullscreen），再加载页面；
	// 避免 ready-to-show 后再调整造成首帧布局跳变。
	applyStartupWindowMode(
		mainWindow,
		effectiveStartupMode,
		showMainWindowImmediately,
	);

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
	});
	mainWindow.webContents.on(
		"did-fail-load",
		(_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
			void appLogger.error("app", "Main window load failed", {
				errorCode,
				errorDescription,
				validatedURL,
				isMainFrame,
			});
		},
	);
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
	// 子进程（含 GPU/utility）异常退出：Mac 上偶发“整窗闪一下”，需要留下 reason/exitCode。
	app.on("child-process-gone", (_event, details) => {
		void appLogger.error("process", "Child process gone", {
			...details,
			platform: process.platform,
			arch: process.arch,
		});
	});
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
	mainWindow.webContents.on(
		"console-message",
		(event) => {
			if (!["warning", "error"].includes(event.level)) return;
			void appLogger.warn("app", "Main window renderer console error", {
				level: event.level,
				message: event.message,
				line: event.lineNumber,
				sourceId: event.sourceId,
			});
		},
	);

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
	windowForState.on("close", () => {
		if (!windowForState.isDestroyed()) {
			const normal = windowForState.isMaximized() || windowForState.isFullScreen()
				? windowForState.getNormalBounds()
				: windowForState.getBounds();
			saveLastWindowBounds(app.getPath("userData"), { width: normal.width, height: normal.height });
		}
	});

	// 关闭窗口时根据设置决定：隐藏到托盘还是正常退出
	mainWindow.on("close", (event) => {
		if (!isQuitting && settingsStore.get().closeToTray) {
			event.preventDefault();
			mainWindow?.hide();
		} else if (!isQuitting) {
			// 如果没有启用托盘，关闭窗口时直接退出应用
			isQuitting = true;
			app.quit();
		}
	});

	// 监听浏览器标准快捷键打开开发者工具（F12 / Ctrl+Shift+I / Ctrl+Shift+J，
	// macOS 变体与开关逻辑集中在 devTools.ts，主窗口/webview/设置 IPC 共用）
	mainWindow.webContents.on("before-input-event", (event, input) => {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		if (isDevToolsShortcut(input)) {
			event.preventDefault();
			toggleMainWindowDevTools(mainWindow);
		}
	});

	const devRendererUrl = shouldUseDevRendererUrl()
		? process.env.ELECTRON_RENDERER_URL
		: undefined;
	if (devRendererUrl) {
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
function applyStartupWindowMode(
	window: BrowserWindow,
	mode: StartupWindowMode,
	showImmediately: boolean,
) {
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
async function restartDshHostAfterRuntimeChange(): Promise<void> {
	if (!dshHost.isStarted()) return;
	try {
		// 与 restartDshHost IPC 同一顺序：先停活跃会话（host 侧会话仍持久化，
		// 重开时 attach 恢复），避免旧 mux 悬挂在已 dispose 的 transport 上。
		await dshAgentManager.stopAll();
		await dshHost.restart();
		await dshHost.ensureStarted();
	} catch (error) {
		void appLogger?.warn("dsh-runtime", "restart host after runtime change failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function mainCopy(
	key: MainProcessTranslationKey,
	params?: Record<string, string | number>,
): string {
	return mainProcessT(currentMainProcessLocale(), key, params);
}

/**
 * 把 DSH runtime 导入/安装的内部错误码翻译为用户可读文案。
 * 错误码是 DshRuntimeManager.verifyStagedRuntime 的返回值契约（tests 亦断言裸码），
 * 因此这里只做「码 → 文案」映射，不修改下层返回值。
 */
function dshRuntimeErrorCopy(error: string): string {
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

function registerFeishuIpc() {
	/** Bot 配置变更后主动推送给 renderer，保证多个页面/弹窗中的 Bot 列表实时同步。 */
	function broadcastBotsChanged() {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		mainWindow.webContents.send(ipcChannels.feishuBotsChanged, listBots());
	}

	// 临时连接（不保存 bot 配置），用于添加 Bot 时先验证凭证可用性
	ipcMain.handle(ipcChannels.feishuConnectTemp, async (_event, input: FeishuConnectInput) => {
		const appId = input.appId?.trim() ?? "";
		const appSecret = input.appSecret?.trim() ?? "";
		console.log("[Feishu] 收到临时连接请求", JSON.stringify({ appId: appId ? appId.slice(0, 8) + "..." : "", name: input.name, hasSecret: Boolean(appSecret) }));
		try {
			if (!appId || !appSecret) {
				return { success: false, message: feishuT(currentFeishuLocale(), "bridge.configRequired") };
			}
			if (feishuBridge) {
				feishuBridge.stop();
			}
			// 临时构造 botConfig，不做持久化；明文 secret 只传给当前 bridge，不写入磁盘。
			const botConfig: FeishuBotConfig = {
				id: "temp-" + randomUUID(),
				name: input.name?.trim() || feishuT(currentFeishuLocale(), "bridge.tempBotName"),
				enabled: true,
				appId,
				appSecret,
				defaultUserOpenId: input.defaultUserOpenId,
			};
			feishuBridge = new FeishuBridge(
				botConfig,
				agentManager,
				() => mainWindow,
				() => projectStore.list(),
				feishuSessionRuntimeBindings,
				appSecret,
				currentFeishuLocale(),
			);
			await feishuBridge.start();
			const status = feishuBridge.getStatus();
			console.log("[Feishu] 临时连接成功，状态:", JSON.stringify(status));
			return {
				success: true,
				message: feishuT(currentFeishuLocale(), "connection.success"),
				botInfo: { id: botConfig.id, name: botConfig.name },
			};
		} catch (error) {
			const detail = error instanceof Error ? (error as Error & { cause?: unknown }).cause ?? error.message : String(error);
			const message = error instanceof Error ? error.message : String(error);
			console.error("[Feishu] 临时连接失败:", detail);
			return { success: false, message, detail: String(detail) };
		}
	});

	// 连接飞书（保存 bot）
	ipcMain.handle(ipcChannels.feishuConnect, async (_event, input: FeishuConnectInput) => {
		console.log("[Feishu] 收到连接请求", JSON.stringify({ appId: input.appId?.slice(0, 8) + "...", name: input.name }));
		try {
			if (feishuBridge) {
				console.log("[Feishu] 停止旧 bridge 状态:", JSON.stringify(feishuBridge.getStatus()));
				feishuBridge.stop();
			}

			// 先建立临时配置，不持久化；连接成功后再存盘
			const plainAppSecret = input.appSecret;
			const tempId = "pending-" + randomUUID();

			feishuBridge = new FeishuBridge(
				{
					id: tempId,
					name: input.name || feishuT(currentFeishuLocale(), "bridge.defaultBotName"),
					enabled: true,
					appId: input.appId,
					appSecret: "",
					defaultUserOpenId: input.defaultUserOpenId,
				},
				agentManager,
				() => mainWindow,
				() => projectStore.list(),
				feishuSessionRuntimeBindings,
				plainAppSecret,
				currentFeishuLocale(),
			);
			await feishuBridge.start();

			// 连接成功后再持久化
			const botConfig = addFeishuBot({
				name: input.name || feishuT(currentFeishuLocale(), "bridge.defaultBotName"),
				appId: input.appId,
				appSecret: input.appSecret,
				defaultUserOpenId: input.defaultUserOpenId,
			});
			feishuBridge.updateBotConfig({ id: botConfig.id });

			console.log("[Feishu] 连接成功，状态:", JSON.stringify(feishuBridge.getStatus()));
			void appLogger.info("feishu", "Feishu connected", { botId: botConfig.id, name: botConfig.name });
			broadcastBotsChanged();
			return { success: true, message: feishuT(currentFeishuLocale(), "connection.success") };
		} catch (error) {
			const detail = error instanceof Error ? (error as Error & { cause?: unknown }).cause ?? error.message : String(error);
			const message = error instanceof Error ? error.message : String(error);
			console.error("[Feishu] 连接失败:", detail);
			void appLogger.error("feishu", "Feishu connect failed", error);
			// 返回详细错误信息（包含原始错误说明），供前端展示
			return { success: false, message, detail: String(detail) };
		}
	});

	// 断开连接
	ipcMain.handle(ipcChannels.feishuDisconnect, async () => {
		console.log("[Feishu] 收到断开请求");
		if (feishuBridge) {
			console.log("[Feishu] 停止 bridge，此前状态:", JSON.stringify(feishuBridge.getStatus()));
			feishuBridge.stop();
			feishuBridge = null;
			console.log("[Feishu] bridge 已置 null");
		}
		void appLogger.info("feishu", "Feishu disconnected");
		return { success: true };
	});

	// 查询状态
	ipcMain.handle(ipcChannels.feishuStatusRequest, async () => {
		if (feishuBridge) {
			const s = feishuBridge.getStatus();
			console.log("[Feishu] 状态查询:", JSON.stringify(s));
			return s;
		}
		console.log("[Feishu] 状态查询: bridge 为 null，返回 disconnected");
		return { status: "disconnected", activeBindings: 0 } as FeishuBridgeStatus;
	});

	// Bot 列表
	ipcMain.handle(ipcChannels.feishuBotsList, async () => {
		return listBots();
	});

	// 添加 Bot
	ipcMain.handle(ipcChannels.feishuBotAdd, async (_event, input: FeishuConnectInput) => {
		// 同 feishuConnect，但可以添加多个 Bot
		try {
			const botConfig = addFeishuBot({
				name: input.name || feishuT(currentFeishuLocale(), "bridge.defaultBotName"),
				appId: input.appId,
				appSecret: input.appSecret,
				defaultUserOpenId: input.defaultUserOpenId,
			});
			void appLogger.info("feishu", "Feishu bot added", { botId: botConfig.id, name: botConfig.name });
			broadcastBotsChanged();
			return { success: true, bot: { ...botConfig, appSecret: "" } };
		} catch (error) {
			void appLogger.warn("feishu", "Failed to add Feishu bot", {
				error: error instanceof Error ? error.message : String(error),
			});
			return { success: false, error: feishuT(currentFeishuLocale(), "bridge.botAddFailed") };
		}
	});

	// 删除 Bot
	ipcMain.handle(ipcChannels.feishuBotRemove, async (_event, botId: string) => {
		if (feishuBridge) {
			feishuBridge.stop();
			feishuBridge = null;
		}
		const result = removeFeishuBot(botId);
		if (result) {
			broadcastBotsChanged();
		}
		void appLogger.info("feishu", "Feishu bot removed", { botId });
		return result;
	});

	// 更新 Bot 配置
	ipcMain.handle(ipcChannels.feishuBotConfig, async (_event, botId: string, patch: Partial<FeishuBotConfig>) => {
		const updated = updateFeishuBot(botId, patch);
		void appLogger.info("feishu", "Feishu bot config updated", { botId, keys: Object.keys(patch) });
		// 只热更新当前在线 Bot；修改其它 Bot 配置不应污染正在运行的 bridge。
		if (feishuBridge && feishuBridge.getStatus().status === "connected" && feishuBridge.getStatus().botId === botId) {
			feishuBridge.updateBotConfig(patch);
			console.log("[飞书] 配置已热更新:", Object.keys(patch).join(", "));
		}
		if (updated) {
			broadcastBotsChanged();
		}
		return updated ? { ...updated, appSecret: "" } : undefined;
	});

	// 返回解密后的 Secret，仅用于用户主动复制/查看凭证。
	ipcMain.handle(ipcChannels.feishuBotSecret, async (_event, botId: string) => {
		return getDecryptedBotAppSecret(botId);
	});

	// 测试连接
	ipcMain.handle(ipcChannels.feishuTestConnection, async (_event, appId: string, appSecret: string) => {
		// 创建临时 bridge 实例来测试连接
		const testBridge = new FeishuBridge(
			{
				id: "test",
				name: "测试",
				enabled: true,
				appId,
				appSecret: "", // 将在 testConnection 中传入
			},
			agentManager,
			() => mainWindow,
			() => projectStore.list(),
			feishuSessionRuntimeBindings,
			undefined,
			currentFeishuLocale(),
		);
		return testBridge.testConnection(appId, appSecret);
	});

	// 绑定列表
	ipcMain.handle(ipcChannels.feishuBindingsList, async () => {
		if (feishuBridge) {
			return feishuBridge.listBindings();
		}
		return [];
	});

	// 移除绑定
	ipcMain.handle(ipcChannels.feishuBindingRemove, async (_event, chatId: string) => {
		if (feishuBridge) {
			// 先查 binding 拿到 sessionId，移除后清理 session-bot 映射，
			// 使 FeishuLinkIndicator 等 UI 同步更新断开状态。
			const bindings = feishuBridge.listBindings();
			const binding = bindings.find((b) => b.chatId === chatId);
			const result = feishuBridge.removeBinding(chatId);
			if (result && binding) {
				setSessionBotId(binding.sessionId, undefined);
			}
			return result;
		}
		return false;
	});

	// 更新绑定
	ipcMain.handle(ipcChannels.feishuBindingUpdate, async (_event, chatId: string, patch: Partial<FeishuChatBinding>) => {
		if (feishuBridge) {
			return feishuBridge.updateBinding(chatId, patch);
		}
		return undefined;
	});

	// 通过已保存的 Bot ID 连接（自动解密 Secret）
	ipcMain.handle(ipcChannels.feishuConnectByBot, async (_event, botId: string) => {
		try {
			if (feishuBridge) {
				feishuBridge.stop();
			}
			const botConfig = getBot(botId);
			if (!botConfig) {
				return { success: false, message: feishuT(currentFeishuLocale(), "bridge.botMissing") };
			}
			feishuBridge = new FeishuBridge(
				botConfig,
				agentManager,
				() => mainWindow,
				() => projectStore.list(),
				feishuSessionRuntimeBindings,
				undefined,
				currentFeishuLocale(),
			);
			await feishuBridge.start();
			void appLogger.info("feishu", "Feishu connected by saved bot", { botId, name: botConfig.name });
			return { success: true, message: feishuT(currentFeishuLocale(), "connection.success") };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { success: false, message };
		}
	});

	// 获取稳定 Session 绑定的飞书 Bot ID，并一次性迁移旧 runtime agentId 键。
	ipcMain.handle(ipcChannels.feishuSessionBotGet, async (_event, sessionId: string) => {
		const current = getSessionBotId(sessionId);
		if (current) return current;
		const target = sessionRuntimeCoordinator.getTarget(sessionId);
		if (!target || target.agentId === sessionId) return null;
		const legacy = getSessionBotId(target.agentId);
		if (!legacy) return null;
		setSessionBotId(sessionId, legacy);
		setSessionBotId(target.agentId, undefined);
		return legacy;
	});

	// 设置稳定 Session 使用的飞书 Bot ID。主进程始终重新解析当前 runtime，避免旧 agentId 操作替换后的会话。
	ipcMain.handle(ipcChannels.feishuSessionBotSet, async (_event, sessionId: string, botId: string | null) => {
		let target = sessionRuntimeCoordinator.getTarget(sessionId);
		if (!botId) {
			setSessionBotId(sessionId, undefined);
			if (target && target.agentId !== sessionId) setSessionBotId(target.agentId, undefined);
			// 取消当前会话的飞书关联：移除绑定但不停止 Agent 进程
			if (feishuBridge && feishuBridge.getStatus().status === "connected") {
				feishuBridge.removeBindingBySessionId(sessionId);
			}
			return { success: true };
		}
		const status = feishuBridge?.getStatus();
		if (!feishuBridge || status?.status !== "connected") {
			return { success: false, message: feishuT(currentFeishuLocale(), "session.bridgeUnavailable") };
		}
		if (status.botId !== botId) {
			return { success: false, message: feishuT(currentFeishuLocale(), "session.botMismatch") };
		}
		// 会话尚未启动 runtime（仅浏览过历史会话）：先启动 Agent 再建立飞书镜像，
		// 让「点会话连接飞书」在未启动 Agent 时也能成功；与桌面端启动走同一 activateRuntime 链路。
		if (!target) {
			try {
				await feishuSessionRuntimeBindings.activateRuntime(sessionId);
				target = sessionRuntimeCoordinator.getTarget(sessionId);
			} catch (error) {
				void appLogger.warn("feishu", "auto-start runtime for Feishu bind failed", {
					sessionId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		if (!target) {
			return { success: false, message: feishuT(currentFeishuLocale(), "session.runtimeUnavailable") };
		}
		const tab = agentManager.list().find((item) => item.id === target.agentId);
		if (!tab) {
			return { success: false, message: feishuT(currentFeishuLocale(), "session.runtimeUnavailable") };
		}
		const chatId = await feishuBridge.ensureSessionMirrorForSession(
			sessionId,
			target.agentId,
			tab.title,
			tab.sessionPath,
		);
		if (!chatId) {
			return { success: false, message: feishuT(currentFeishuLocale(), "session.bindFailed") };
		}
		setSessionBotId(sessionId, botId);
		if (target.agentId !== sessionId) setSessionBotId(target.agentId, undefined);
		return { success: true, chatId };
	});
}

async function sendAgentPromptWithIntegrations(
	input: SendPromptInput,
): Promise<SendPromptResult> {
	// 多后端路由：非 pi 后端（dsh/未来新增后端）不经过 pi 专属的飞书/扩展链路，
	// 按 agentId 交给合成网关路由到所属后端网关（pi 后端继续走下方集成链路）。
	const gateway = compositeAgentGateway;
	const agentTab = gateway?.list().find((item) => item.id === input.agentId);
	if (gateway && agentTab && agentTab.backend !== "pi") {
		return gateway.sendPrompt(input);
	}
	const bridge = feishuBridge;
	const bridgeConnected = bridge?.getStatus().status === "connected";
	const hasFeishuBinding = bridgeConnected && bridge.hasSessionBinding(input.agentId);
	const docTitle = bridgeConnected ? wantsFeishuDoc(input.message) : undefined;
	const sessionChatId = bridgeConnected ? bridge.getSessionChatId(input.agentId) : undefined;
	let agentInstruction: string | undefined;
	const buildFeishuActionInstruction = (chatId?: string) => [
		"当前会话已连接飞书聊天。严禁调用 lark-cli、飞书 IM API 或搜索群聊来发送文件；不要询问 chat_id。需要把本地文件发到当前飞书聊天时，最终回答末尾独立一行写 [SEND_FILE:本地文件路径]，PiDeck 会按当前会话绑定自动上传。",
		chatId ? `当前绑定的飞书 chat_id: ${chatId}。这是只读上下文，用于确认当前会话绑定；发送文件仍必须用 [SEND_FILE:本地文件路径]。` : undefined,
	].filter(Boolean).join("\n");

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
	const result = await agentManager.sendPrompt(
		agentInstruction
			? { ...input, agentMessage: `${agentInstruction}\n\n${input.message}` }
			: input,
	);
	void appLogger.info("agent", "Prompt sent", {
		agentId: input.agentId,
		messageLength: input.message.length,
		imageCount: input.images?.length ?? 0,
		streamingBehavior: input.streamingBehavior,
	});
	return result;
}

function registerIpc() {
	// 用量统计：业务在 UsageStatsService，handler 薄层只校验/适配
	registerUsageStatsIpc(ipcMain, usageStatsService);

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

	registerScratchPadIpc({ appLogger });

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

	// 生图：凭据来自独立 userData/imagegen.json，不读 pi models.json
	const imageGenConfigStore = new ImageGenConfigStore({
		getConfigPath: () => join(app.getPath("userData"), "imagegen.json"),
		log: (message, ...args) => appLogger.info("imagegen", message, ...args),
	});
	// 生图 session 独立存储：无 pi 会话文件的纯生图草稿把历史落盘到这里（重启可恢复），
	// 不依赖 pi 会话文件也不进 pi 的 sessions 目录（PiDeck userData/imagegen/sessions）。
	const imageSessionStore = new ImageSessionStore({
		getStorePath: () => join(app.getPath("userData"), "imagegen", "sessions"),
	});
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
					await sessionCatalog.update(sessionId, {
						title: firstLine,
					});
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
					content: [{
						type: "image",
						source: {
							type: "base64",
							media_type: image.mimeType,
							data: image.data,
						},
					}],
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
		openCodeSessionImporter,
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
				const result = await dshRuntimeInstaller.installFromIndex();
				dshRuntimeStatus.refresh();
				if (result.ok) await restartDshHostAfterRuntimeChange();
				return result;
			},
			importDshRuntime: async (filePath: string) => {
				const result = await dshRuntimeInstaller.installFromLocalFile(filePath);
				dshRuntimeStatus.refresh();
				if (result.ok) await restartDshHostAfterRuntimeChange();
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
				const wasRunning = dshHost.isStarted() || dshHost.isHostProcessRunning();
				if (wasRunning) {
					try {
						// 会话只在 boot 完成后才存在（isStarted 为真时停）；进程存活就杀。
						if (dshHost.isStarted()) await dshAgentManager.stopAll();
						await dshHost.restart();
					} catch (error) {
						// 停 host 失败不阻塞卸载：rmSync 自带重试，锁仍在则返回结构化错误。
						void appLogger?.warn("dsh-runtime", "stop host before uninstall failed", {
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
				const result = await dshRuntimeInstaller.uninstall();
				dshRuntimeStatus.refresh();
				if (wasRunning) {
					try {
						await dshHost.ensureStarted();
					} catch (error) {
						void appLogger?.warn("dsh-runtime", "restart host after runtime uninstall failed", {
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
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
			readDshHistoryPage: (dshSessionId, beforeSeq, pageSize) =>
				dshAgentManager.readHistoryPage(dshSessionId, beforeSeq, pageSize),
			readDshProcessEvents: (agentId, dshSessionId) =>
				dshAgentManager.readProcessEvents(agentId, dshSessionId),
			readDshSystemPrompt: (agentId, dshSessionId) =>
				dshAgentManager.readSystemPrompt(agentId, dshSessionId),
			readDshMessageFullText: (agentId, messageId) =>
				dshAgentManager.readMessageFullText(agentId, messageId),
			resolveDshSessionFilePath: async (sessionId) => {
				// F5：DSH 会话没有 pi 会话文件，「复制会话文件路径」按 catalog 的
				// dshSessionId + 项目 cwd 推导 host 持久化路径。
				const entry = sessionCatalog.get(sessionId);
				if (!entry?.dshSessionId) return undefined;
				const project = projectStore.get(entry.projectId);
				if (!project?.path) return undefined;
				return dshAgentManager.resolveSessionFilePath(project.path, entry.dshSessionId);
			},
			searchDshSessions: (query) => dshHost.searchSessions(query),
			createDshGoal: (agentId, objective, maxGoalRounds) =>
				dshAgentManager.createGoal(agentId, objective, maxGoalRounds),
			runDshGoalAction: (agentId, action) => dshAgentManager.goalAction(agentId, action),
			listDshSubagents: (agentId) => dshAgentManager.listSubagents(agentId),
			listDshSkills: (agentId) => dshAgentManager.listSkills(agentId),
			readDshSubagentHistory: (agentId, childSessionId, beforeSeq, maxMessages) =>
				dshAgentManager.readSubagentHistory(agentId, childSessionId, beforeSeq, maxMessages),
			listDshOrphans: async () => {
				// G3/D11：host 持久化会话中，catalog 无 dshSessionId 映射的视为孤儿
				// （被删除映射的记录、匿名会话残留等）。wire 无删除 API，仅用于提示。
				const hostIds = await dshHost.listSessionIds();
				const known = new Set(
					sessionCatalog.listEntries()
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
			installDshPlugin: (input) => dshHost.installDynamicPlugin(input),
			runDshPlugin: (input) => dshHost.runDynamicPlugin(input),
			stopDshPlugin: (input) => dshHost.stopDynamicPlugin(input),
			uninstallDshPlugin: (input) => dshHost.uninstallDynamicPlugin(input),
			isDshAgent: (agentId) =>
				dshAgentManager?.list().some((tab) => tab.id === agentId) === true,
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
							projectPath = projectPath
								.replace(/^([A-Za-z]):\\/, (_: string, drive: string) => `/mnt/${drive.toLowerCase()}/`)
								.replace(/\\/g, "/");
						}
						const summaries = await sessionScanner.list(projectPath);
						await sessionCatalog.mergeScanned(
							project.id,
							summaries,
							settings.wslEnabled ? { wslDistro: settings.wslDistro, wslUser: settings.wslUser } : {},
						);
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
		piLocator,
		projectStore,
		settingsStore,
		worktreeService,
	});

	// Phase 3.7 拆出 systemIpc 后这些可选依赖必须显式注入；
	// 漏传 extensionManager 会导致 pi:update-check / pi:update 根本不注册。
	if (!piModelCapabilityCache) throw new Error("Pi model capability cache is unavailable after settings load");
	// 后台更新检查：启动延迟 + 每 2h 自动检测 PiDeck 与 Pi CLI（无配额方案，无需认证）。
	// 快照经 app:update-status-changed 推送渲染层（齿轮角标 + 每版本一次提示判定）。
	updateService = new UpdateService({
		settingsStore,
		checkPiUpdate: () => extensionManager.checkPiUpdate(),
		sendToRenderer: (snapshot) => {
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send(ipcChannels.appUpdateStatusChanged, snapshot);
			}
		},
		log: (level, message, details) => {
			if (level === "warn") void appLogger.warn("update", message, details ?? {});
			else void appLogger.info("update", message, details ?? {});
		},
		getCurrentVersion: () => app.getVersion(),
		getInstallationType: () => settingsStore.get().installationType ?? "installed",
	});
	updateService.start();
	// 模型目录更新：覆盖层目录须在 catalog 初次读取前登记（getPiAiCatalogIndex 首次
	// 调用即锁定索引）；updater 在 ready 后构造，此时 app.getPath("userData") 才可靠。
	setPiAiCatalogUserDataDir(app.getPath("userData"));
	registerCatalogIpc(new PiAiCatalogUpdater({ userDataDir: app.getPath("userData") }));
	registerSystemIpc({
		piLocator,
		settingsStore,
		configManager,
		agentManager,
		skillManager,
		appLogger,
		rpcLogger,
		sessionRuntimeCoordinator,
		// G17：RPC 日志按 backend 分流（DSH 走 DshAgentManager 领域调用记录）
		isDshAgent: (agentId) =>
			dshAgentManager?.list().some((tab) => tab.id === agentId) === true,
		setDshRpcLogging: (agentId, enabled) => dshAgentManager.setRpcLogging(agentId, enabled),
		isDshRpcLogging: (agentId) => dshAgentManager.isRpcLogging(agentId),
		diagnosticsMonitor: diagnosticsMonitor ?? undefined,
		environmentDoctor: environmentDoctor ?? undefined,
		logBundleExporter: logBundleExporter ?? undefined,
		// 进程监控停止 agent：按 agentId 走完整会话停止链路（含 detach 推送）
		stopAgentFromMonitor,
		getDshHostPid: () => dshHost.getHostPid(),
		providerMigration: {
			configManager,
			dshHost,
		},
		modelCapabilityCache: piModelCapabilityCache,
		listDshMonitorSessions: () => dshAgentManager.list().map((tab) => ({ title: tab.title })),
		stopDshHostFromMonitor,
		getMainWindow: () => mainWindow,
		mainCopy: mainCopy as (key: string, params?: Record<string, string | number>) => string,
		// 适配层：registerSystemIpc 的旧签名 (installationType?) → 新无配额检查 (options)。
		checkForAppUpdate: (installationType?: string) =>
			checkForAppUpdate({
				owner: UPDATE_REPO_OWNER,
				repo: UPDATE_REPO,
				currentVersion: app.getVersion(),
				installationType:
					installationType === "portable" ? "portable" : installationType === "installed" ? "installed" : undefined,
			}),
		downloadUpdateAsset,
		installDownloadedUpdate,
		openExternalUrl,
		extensionManager,
		// 设置变更副作用（代理 / 主题 / 飞书语言 / WSL / 宠物 / Web 服务）
		applyDesktopProxy,
		testPiProxy,
		applyWebServiceSettings: (settings) => webServiceManager.applySettings(settings),
		restartWebService: (settings) => webServiceManager.restart(settings),
		reactToPetSettings: async (prev, next) => {
			await petSystem?.reactToSettings(prev, next);
		},
		applyNativeThemeSource,
		refreshTrayContextMenu,
		// 语言变更时按当前主进程 locale 重算，忽略 systemIpc 传入的占位参数
		setFeishuLocale: () => {
			feishuBridge?.setLocale(currentFeishuLocale());
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
		readSkillContent: (skillPath) => readSkillContent(skillPath, {
			globalSkillPaths: skillManager.getLocations().map((location) => location.path),
			projectRootPaths: projectStore.list().map((project) => {
				const settings = settingsStore.get();
				if (
					process.platform === "win32" &&
					project.environment === "wsl" &&
					settings.wslEnabled &&
					settings.wslDistro
				) {
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
		RELEASES_URL,
		devBranch: isolateDevByGitBranch && !isSharedDevBranch(devGitBranch) ? devGitBranch : undefined,
		updateService: updateService ?? undefined,
	});

	registerStoreIpc({
		promptManager,
		skillManager,
		xuePromptManager,
		extensionManager,
		appLogger,
		mainCopy: mainCopy as (key: string, params?: Record<string, string | number>) => string,
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

// 换肤背景图/宠物雪碧图协议：自定义 scheme 必须在 ready 前注册特权声明（secure 以便渲染层 CSS/图片引用）
protocol.registerSchemesAsPrivileged([
	{ scheme: "pideck-bg", privileges: { secure: true, standard: true, corsEnabled: false, supportFetchAPI: true, stream: false } },
	{ scheme: "pideck-pet", privileges: { secure: true, standard: true, corsEnabled: false, supportFetchAPI: true, stream: false } },
]);

app.whenReady().then(async () => {
	// 未拿到同版本主实例锁时不要继续初始化，避免第二进程短暂闪窗。
	if (singleInstanceEnabled && !gotSingleInstanceLock) return;

	projectStore = new ProjectStore(() => mainCopy("dialog.chooseProjectFolder"));
	fileSystemService = new FileSystemService();
	sessionScanner = new SessionScanner(mainCopy);
	codexSessionImporter = new CodexSessionImporter(mainCopy);
	claudeSessionImporter = new ClaudeSessionImporter(mainCopy);
	openCodeSessionImporter = new OpenCodeSessionImporter(mainCopy);
	settingsStore = new SettingsStore();
	// 安全管理：配置 owner + 策略快照写入（供 pi-deck-security-gate 扩展消费）
	securityStore = new SecurityStore({
		settingsStore,
		log: (domain, message, details) => void appLogger?.info(domain, message, details),
	});
	appLogger = new AppLogger();
	setAppLogger(appLogger);
	rpcLogger = new RpcLogger();
	// 用量统计：pi-tracker 的 <agentDir>/analytics/usage.jsonl
	// + dsh-bill 的 <DSH_HOME>/dsh-bill/records.jsonl（采集由插件负责，此处只读）。
	// DSH_HOME 与 DshHost 同一套解析（设置覆盖 > ~/.dsh > 应用私有目录）。
	usageStatsService = new UsageStatsService({
		agentDir: join(app.getPath("home"), ".pi", "agent"),
		getDshHomeDir: () =>
			resolveDshHomeDir(settingsStore.get().dshHomeDir ?? "", app.getPath("userData")),
		logger: {
			info: (message) => void appLogger?.info("usage-stats", message),
			warn: (message) => void appLogger?.warn("usage-stats", message),
		},
	});
	gitService = new GitService();
	worktreeService = new WorktreeService(mainCopy);
	piLocator = new PiLocator(mainCopy);
	// DSH 用量链路（backend="dsh"）：配置落 $DSH_HOME/usage-probes.json、凭据从
	// $DSH_HOME/.credentials.yaml 读，与 pi 侧链路（~/.pi/agent）完全同构、互不干扰。
	// DSH_HOME 解析与 DshHost 同一套（设置覆盖 > ~/.dsh > 应用私有目录），getter 每次求值，
	// 用户改设置立即生效；readCredential 环境层优先、文件层兜底（与 DshHost 相同优先级）。
	configManager = new ConfigManager(undefined, mainCopy, {
		getHomeDir: () =>
			resolveDshHomeDir(settingsStore.get().dshHomeDir ?? "", app.getPath("userData")),
		readCredential: async (ref) => {
			const envValue = process.env[ref]?.trim();
			if (envValue) return envValue;
			try {
				const filePath = join(
					resolveDshHomeDir(settingsStore.get().dshHomeDir ?? "", app.getPath("userData")),
					".credentials.yaml",
				);
				return credentialValueFromDocument(await readFile(filePath, "utf8"), ref);
			} catch {
				return undefined;
			}
		},
	});
	promptManager = new PromptManager(undefined, mainCopy);
	xuePromptManager = new XuePromptManager();
	skillManager = new SkillManager(undefined, mainCopy);
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
	);
	projectResourceManager = new ProjectResourceManager(
		(projectId) => projectStore.get(projectId),
		mainCopy,
		(project) => {
			const settings = settingsStore.get();
			if (
				process.platform === "win32" &&
				project.environment === "wsl" &&
				settings.wslEnabled &&
				settings.wslDistro
			) {
				try {
					return toWindowsHostPath(project.path, { distro: settings.wslDistro });
				} catch {
					return project.path;
				}
			}
			return project.path;
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
			void piModelCapabilityCache?.ensure()
				.then((snapshot) => snapshot ? undefined : refreshModelList(piLocator, settingsStore, configManager))
				.catch(() => undefined);
		},
		securityStore,
		// spawn pi 前预检修复会话文件（旧版私有 sessionName 头行会让 pi 拒绝加载，见 #114）
		(filePath) => sessionScanner.repairCorruptSessionHeader(filePath),
		// 飞书绑定会话：spawn 时注入 PIDECK_FEISHU_LINKED，ask_question 切换为禁用提示版。
		// 闭包延迟读 feishuBridge（连接成功后才创建），spawn 时 binding 已先于 runtime 建立。
		(key) => Boolean(key && feishuBridge?.hasSessionBinding(key)),
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
				const models =
					snapshot && snapshot.models.length > 0
						? snapshot.models
						: await fetchModelList(piLocator, settingsStore, configManager);
				return models.some((m) => m.provider === provider && m.id === modelId);
			} catch {
				// 目录查询失败（pi 缺失/CLI 异常等）时退回旧行为：不标 needsRestart，
				// 保持错误形态不变，避免把可诊断错误变成误导性的“重启即可”。
				return false;
			}
		},
	);
	// C12：退出清理登记（before-quit 统一 runAll，新增资源不再改 before-quit）
	quitCleanup.register("pi-agents", () => agentManager?.stopAll());
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
	// DSH runtime 安装态服务先于 DshHost 装配（探测只依赖 appPath，不 fork host）。
	// 探测顺序：外部已装 runtime 优先 → 回退 app 内置（dev 模式 = 项目 node_modules 的
	// @deepseek-ai 开发依赖，已随 npm install 存在，直接可用无需安装/下载），
	// 两边都没有才是 notInstalled。状态变更经 dsh-runtime:status-changed 广播给渲染层。
	// allowBundledFallback 只在开发态开启：**打包版不内置 runtime**（build 用 runtime:pack:lite，
	// 随包目录留空）——减小安装体积，需要 DSH 的用户在打包版里按引导下载安装；
	// 开发态则直接复用项目 node_modules（零下载、零安装，符合「dev 不需要装 runtime」的诉求）。
	dshRuntimeStatus = new DshRuntimeStatusService(
		() => app.getAppPath(),
		(scope, message, detail) => void appLogger.info(scope, message, detail),
		() => {
			const active = dshRuntimeManager.resolveActive();
			return active
				? { nodeModules: active.nodeModules, runtimeVersion: active.manifest.runtimeVersion }
				: undefined;
		},
		() => !app.isPackaged,
		() => app.isPackaged,
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
		// 优先级：环境变量（本地/内网验证用，免改设置）> 设置项（镜像）> 默认 Release 资产。
		indexUrl: () =>
			process.env.DSH_RUNTIME_INDEX_URL ||
			settingsStore.get().dshRuntimeIndexUrl ||
			`https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO}/releases/download/dsh-runtime/dsh-runtime-releases.json`,
		appVersion: () => app.getVersion(),
		fetchIndex: fetchDshRuntimeIndex,
		// 随包 runtime（resources/dsh-runtime/）：有就本地解压，不必联网。
		// dev 模式下 process.resourcesPath 指向 Electron 自己的 resources，
		// 没有该子目录 → 读不到 → 自然回退到在线/手动导入。
		bundledRuntime: () =>
			readBundledRuntime(
				process.resourcesPath ? join(process.resourcesPath, DSH_BUNDLED_RUNTIME_DIRNAME) : undefined,
				app.getVersion(),
			),
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
					const effectiveMode = resolveEffectiveSessionProxyMode(
						entry.proxy?.mode,
						entry.model?.provider,
						entry.model?.modelId,
						settings.piProxyProviders,
						settings.piProxyModels,
					);
					return effectiveMode === "follow" ? undefined : { mode: effectiveMode } as import("../shared/types/session").SessionProxyOverride;
				});
			const mode = aggregateDshProxyMode(dshOverrides);
			// 全局开关兜底：所有 DSH 会话都 follow（无显式覆盖、无名单命中）时，仍应让 host
			// 跟随全局 pi 代理开关——否则用户在设置页只开全局开关，DSH 永远直连（与 pi 会话
			// 「名单空时跟随全局」语义不一致）。名单非空时不做兜底（见 resolveDshHostProxyMode）。
			const settingsSnapshot = settingsStore.get();
			const hasProxyList =
				(settingsSnapshot.piProxyModels?.length ?? 0) > 0 ||
				(settingsSnapshot.piProxyProviders?.length ?? 0) > 0;
			const finalMode = resolveDshHostProxyMode(mode, {
				piProxyEnabled: settingsSnapshot.piProxyEnabled,
				hasList: hasProxyList,
			});
			return buildHostProxyEnvPatch(finalMode, {
				url: settingsSnapshot.piProxyUrl,
				bypass: settingsSnapshot.piProxyBypass,
			});
		},
		// 外部 runtime 根目录（未安装时返回 undefined，回退 app 内置 node_modules）。
		() => dshRuntimeStatus.resolveAppRoot(),
		// 永久删除归档目录：统一走系统回收站（与 pi 会话删除同语义，可恢复；拒绝静默硬删）。
		async (path) => { await shell.trashItem(path); },
	);
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
			void sessionCatalog.update(entry.id, { title }).then(() => {
				// index.ts 作用域用模块级 mainWindow（本文件没有 getMainWindow 助手）
				if (mainWindow && !mainWindow.isDestroyed()) {
					mainWindow.webContents.send(ipcChannels.sessionsCatalogRefreshed, { projectId: entry.projectId });
				}
			}).catch((error: unknown) => {
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
	);
	// C12/E15：DSH 退出清理——先停全部活跃会话（清 mux/订阅/pending）再 dispose host，
	// 顺序保证避免 host 先被杀导致会话清理路径访问已死 transport。
	quitCleanup.register("dsh", async () => {
		await dshAgentManager?.stopAll();
		await dshHost?.dispose();
	});
	// DSH 外部会话自动导入改到 projectStore.load 之后（见下方 scheduleDshForeignAutoImport）：
	// 必须走只读磁盘扫描，不能依赖 host-ready——否则会与 dsh-web 抢同一份 DSH_HOME。
	webServiceManager = new WebServiceManager({
		// dev 模式（electron-vite dev 不产出 out/renderer 构建物）下，静态资源
		// 代理到 vite dev server，外部 Web 端加载重构后的 React 版页面并支持热更新；
		// 打包/正式构建走 out/renderer 构建产物，此值为空。
		devRendererUrl: shouldUseDevRendererUrl()
			? process.env.ELECTRON_RENDERER_URL
			: undefined,
		// 订阅 pi agent 事件流：供 Web SSE 端点转发给浏览器（与 FeishuBridge 同源机制）。
		subscribePiEvents: (handler) => agentManager.addLocalEventListener(
			(agentId, event) => handler(agentId, event as never),
		),
		// agentId → sessionId 路由：pi 事件只有 agentId，SSE 连接按 session 订阅。
		getSessionIdForAgent: (agentId) => sessionRuntimeCoordinator.getSessionId(agentId),
		listProjects: () => projectStore.list(),
		createProject: (path) => projectStore.add(
			path,
			undefined,
			settingsStore.get().wslEnabled ? "wsl" : "windows",
		),
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
			const snapshot = force
				? await piModelCapabilityCache?.refresh()
				: await piModelCapabilityCache?.ensure();
			return snapshot?.models ?? (force
				? refreshModelList(piLocator, settingsStore, configManager)
				: fetchModelList(piLocator, settingsStore, configManager));
		},
		listSessions: (projectId) => {
			const project = projectStore.get(projectId);
			return sessionScanner.list(project?.path);
		},
		getSessionRuntimeMessages: (sessionId) =>
			sessionRuntimeCoordinator.getRuntimeMessages(sessionId),
		listCatalogSessions: async (projectId) => {
			if (!projectId) {
				return sessionCatalog.listEntries()
					.map((entry) => sessionCatalog.getRecord(entry.id))
					.filter((record): record is SessionRecord => Boolean(record));
			}
			const project = projectStore.get(projectId);
			if (!project) throw new Error(mainCopy("project.notFound"));
			let projectPath = project.path;
			const settings = settingsStore.get();
			if (settings.wslEnabled && settings.wslDistro) {
				projectPath = projectPath
					.replace(/^([A-Za-z]):\\/, (_: string, drive: string) => `/mnt/${drive.toLowerCase()}/`)
					.replace(/\\/g, "/");
			}
			const summaries = await sessionScanner.list(projectPath);
			const { wslEnabled, wslDistro, wslUser } = settings;
			const records = await sessionCatalog.mergeScanned(
				projectId,
				summaries,
				wslEnabled ? { wslDistro, wslUser } : {},
			);
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
			return sessionCatalog.createDraft({
				projectId: input.projectId,
				title: input.title?.trim() || mainCopy("session.newTitle"),
				environment: settingsStore.get().wslEnabled ? "wsl" : "native",
				model: input.model,
				thinkingLevel: input.thinkingLevel,
			});
		},
		createAnonymousSession,
		updateSessionRecord: async (sessionId, patch) => {
			const entry = sessionCatalog.get(sessionId);
			if (!entry) throw new Error(mainCopy("session.notFound"));
			const title = patch.title?.trim();
			if (title && title !== entry.title) {
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
		readSessionReferenceMessages: (sessionId) =>
			readCatalogSessionReferenceMessages(sessionId),
		readSessionMessages: async (sessionId) => {
			const entry = sessionCatalog.get(sessionId);
			// DSH 会话没有 pi 会话文件：全量读走 host 历史事件流（一次拉最大页），
			// 与分页路径同源；未挂载 DSH 后端时返回空数组。
			if (entry?.backend === "dsh" && entry.dshSessionId && dshAgentManager) {
				const page = await dshAgentManager.readHistoryPage(entry.dshSessionId, undefined, 1000);
				return page.messages;
			}
			if (!entry?.filePath) return [];
			const content = await sessionScanner.readSessionRawText(entry.filePath);
			return agentManager.readSessionDisplayMessages(entry.filePath, sessionId, content);
		},
		readSessionMessagePage: async (sessionId, before, pageSize) => {
			const entry = sessionCatalog.get(sessionId);
			// DSH 会话没有 pi 会话文件：历史浏览走 host 的 session.history 事件流翻页
			// （游标 = 事件 seq），与 pi 的磁盘分页同形状（messages/total/nextBefore）。
			if (entry?.backend === "dsh" && entry.dshSessionId && dshAgentManager) {
				return dshAgentManager.readHistoryPage(entry.dshSessionId, before, pageSize ?? 100);
			}
			if (!entry?.filePath) return { messages: [], total: 0, nextBefore: null };
			return agentManager.readSessionDisplayTurnPage(entry.filePath, sessionId, before, pageSize);
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
		readDshSubagentHistory: (agentId, childSessionId, beforeSeq, maxMessages) =>
			dshAgentManager.readSubagentHistory(agentId, childSessionId, beforeSeq, maxMessages),
		listDshSkills: (agentId) => dshAgentManager.listSkills(agentId),
		// S6.5：Web 端 DSH 插件管理（动态 Cordis 插件，与桌面配置页同源）
		listDshDynamicPlugins: () => dshHost.listDynamicPlugins(),
		listDshStaticPlugins: () => dshHost.listStaticPlugins(),
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
				emitReplacementState(result.value.runtime, false);
			}
			return result;
		},
		compactSessionRuntime: (target, prompt) =>
			sessionRuntimeCoordinator.compactRuntime(target, prompt),
		getSessionRuntimeState: (target) =>
			sessionRuntimeCoordinator.getRuntimeState(target),
		listSessionRuntimeCommands: (target) =>
			sessionRuntimeCoordinator.listRuntimeCommands(target),
		exportSessionRuntimeHtml: (target) =>
			sessionRuntimeCoordinator.exportRuntimeHtml(target),
		editSessionRuntimeMessage: (target, messageId, newText) =>
			sessionRuntimeCoordinator.editRuntimeMessage(target, messageId, newText),
		deleteSessionRuntimeMessage: (target, messageId) =>
			sessionRuntimeCoordinator.deleteRuntimeMessage(target, messageId),
		listRewindCheckpoints: (target, params) =>
			sessionRuntimeCoordinator.listRewindCheckpoints(target, params),
		getRewindCheckpointDiff: (target, checkpointId) =>
			sessionRuntimeCoordinator.getRewindCheckpointDiff(target, checkpointId),
		restoreRewindCheckpoint: (target, checkpointId, scope) =>
			sessionRuntimeCoordinator.restoreRewindCheckpoint(target, checkpointId, scope),
		prepareSessionRuntimeResend: (target, messageId) =>
			sessionRuntimeCoordinator.prepareRuntimeResend(target, messageId),
		setSessionRuntimeModel: (target, provider, modelId) =>
			sessionRuntimeCoordinator.setRuntimeModel(target, provider, modelId),
		setSessionRuntimeThinking: (target, level) =>
			sessionRuntimeCoordinator.setRuntimeThinking(target, level),
		setSessionRuntimePermission: (target, preset) =>
			sessionRuntimeCoordinator.setRuntimePermission(target, preset),
		cloneSessionRuntime: async (target) => {
			const validated = sessionRuntimeCoordinator.validateTarget(target);
			if (!validated.ok) return validated;
			try {
				return {
					ok: true as const,
					value: await replaceAgentSession(
						target.agentId,
						() => agentManager.cloneSession(target.agentId),
						{ markForked: true },
					),
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
	});
	// C12：退出清理登记（before-quit 统一 runAll）
	quitCleanup.register("theme-schedule", () => clearThemeScheduleTimer());
	quitCleanup.register("update-check", () => updateService?.stop());
	quitCleanup.register("web-service", () => webServiceManager?.stop());
	terminalManager = new TerminalSessionManager(
		(agentId) => {
			// 多后端：pi 与 DSH runtime 各持自己的 tab 表，终端工作目录必须经合成网关
			// 按 agentId 解析。只查 pi agentManager 会让 DSH 会话的终端在创建时抛
			// `Agent not found`，表现为「DSH 后端终端打不开」（渲染层静默吞掉该错误）。
			const tab = compositeAgentGateway
				?.list()
				.find((candidate) => candidate.id === agentId);
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
	piModelCapabilityCache = new PiModelCapabilityCache({
		createProcess: () => new PiProcess(
			process.cwd(),
			{
				...settingsStore.get(),
				// 全局 picker 用离线目录范围：不跑技能或网络刷新；但不能一刀切禁用扩展——
				// 扩展通过 pi.registerProvider 贡献的模型（如 antigravity 插件）必须显示在
				// 选择器中（issue #181），与 CLI 默认行为一致。用户禁用的扩展仍经
				// createPiProcessExtensionResolvers 白名单过滤，泄漏不进来。
				piRpcOffline: true,
				piRpcNoSkills: true,
			},
			piLocator,
			// 与 AgentManager 同一套扩展解析（内置注入 + 禁用白名单），
			// 保证「选择器看到的模型」与「运行时实际加载的扩展」同源。
			createPiProcessExtensionResolvers(
				process.cwd(),
				settingsStore.get(),
			),
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
		initialSessionSettings.wslEnabled
			? { wslDistro: initialSessionSettings.wslDistro, wslUser: initialSessionSettings.wslUser }
			: {},
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
		(filePath) => sessionScanner.inferSessionNameAndValidity(filePath),
	);
	await sessionCatalog.load();
	// 多后端网关装配：pi + dsh（DSH 在窗口创建后后台预热，失败时按需重试）。
	// Coordinator 与事件桥接均面向合成器，新增后端只需追加网关实例。
	compositeAgentGateway = new CompositeAgentGateway([agentManager, dshAgentManager]);
	sessionRuntimeCoordinator = new SessionRuntimeCoordinator(
		sessionCatalog,
		compositeAgentGateway,
		sendAgentPromptWithIntegrations,
		appLogger,
	);
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
	// pi 运行时标题（首轮自动改名 / session_info_changed / rename）写回 catalog：
	// 侧栏 SessionTree 与 Tab 栏读的是 SessionRecord.title，不是 AgentTab.title。
	// DSH 已有同语义的 onTitleChanged；pi 以前只 emitState，回话后 UI 仍停在「新会话」。
	agentManager.setTitleChangedHandler((agentId, title) => {
		const sessionId = sessionRuntimeCoordinator?.getSessionId(agentId);
		if (!sessionId) return;
		const entry = sessionCatalog.get(sessionId);
		// pi 默认 sessionName 是文件名时间戳：不能盖掉「新会话」或用户已有标题。
		if (!entry || entry.title === title) return;
		if (looksLikePiSessionFileStem(title)) return;
		void sessionCatalog.update(sessionId, { title }).then(() => {
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send(ipcChannels.sessionsCatalogRefreshed, {
					projectId: entry.projectId,
				});
			}
		}).catch((error: unknown) => {
			void appLogger.warn("session", "Pi title sync to catalog failed", {
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
			skillManager.configureWsl(null);
			promptManager.configureWsl(null);
			extensionManager.configureWsl(null);
			if (configManager) configManager.configureWsl(null);
			if (xuePromptManager) xuePromptManager.configureWsl(null);
		}
	};

	// 先注册 IPC 并创建窗口：WSL 探测 / pi settings / 代理 / Web 服务都可能卡住或抛错，
	// 不能挡在 createWindow 前面（打包便携版表现为「启动没反应」，dev 因热路径较短不易复现）。
	registerIpc();
	registerFeishuIpc();
	await createWindow();
	setupTray();
	// 粘贴文件启动清理：删除超过保留期的落盘文件（fire-and-forget，不挡首帧）
	void cleanupPasteFiles?.().catch((error: unknown) => {
		void appLogger.warn("app", "Paste file cleanup failed during startup", error);
	});
	// 窗口已可用后再按需预热 DSH：默认后端是 dsh 且 runtime 可用才后台 boot，
	// 避免纯 pi 用户空转 utilityProcess（约 200MB），也避免 runtime 不在时 boot 必然失败。
	// 发送/历史/配置路径仍由 ensureStarted 兜底。
	startDshHostInBackground(dshHost, appLogger, {
		enabled:
			settingsStore.get().defaultAgentBackend === "dsh" && dshRuntimeStatus.canCreateDshSession(),
	});

	// 模型 capability cache 的 hydration 在 syncWslConfig 后启动，确保它与 PiProcess
	// 使用同一套 WSL HOME/config 目录；不阻塞首帧。
	void syncWslConfig().then(async () => {
		// 冷启动先刷 pi 模型目录缓存（models-store.json）再 hydration：PiDeck 的 RPC
		// 进程都带 --offline，pi 启动时的自动目录网络刷新被跳过；目录若不主动刷新
		// 只能靠 TUI 更新，可能长期滞后（官方 provider 新模型导致「列表有、Agent
		// 快照没有」的选择失败，2026-08 deepseek 场景）。目录过期才刷（mtime 节流），
		// 过期时刷新失败也不挡启动——下次冷启动再试，watcher 兜底失效已发布快照。
		// watcher 必须在这两步之后安装：否则启动目录刷新或 Pi 初始化期间的文件事件
		// 会立刻 invalidate 正在进行的 hydration，造成同一启动周期重复 spawn 临时 Pi。
		await refreshModelCatalogIfStale(
			piLocator,
			settingsStore,
			configManager.getConfigDir(),
		).then((result) => {
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
	}).catch((error) => {
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

	// 🆕 自动连接：如果已有 Bot 配置，自动启动飞书连接
	autoConnectFeishu();

	sendTelemetryHeartbeat();

	// 内存分析模式（PIDECK_MEMORY_PROFILE=1）：尽早开始采样，覆盖窗口创建/加载全过程。
	// 采样失败不阻塞启动（诊断工具降级为不可用）。
	if (isMemoryProfileEnabled()) {
		void startMemoryProfile(() => agentManager.hasActiveStreaming()).then((handle) => {
			memoryProfileHandle = handle;
			quitCleanup.register("memory-profile", () => memoryProfileHandle?.stop());
		}).catch((error) => {
			console.error("Failed to start memory profile:", error);
		});
	}
	// 设置里的开发诊断：热启停，不必改环境变量重启。默认关，生产零开销。
	if (settingsStore.get().developerDiagnostics) {
		void diagnosticsMonitor?.setEnabled(true).catch((error) => {
			console.error("Failed to start developer diagnostics:", error);
		});
	}

	// 冷启动通知唤起：应用未运行时点击系统通知，本进程即为唯一实例（无次实例 .focus 流转），
	// argv 携带 pideck:// URL，窗口就绪后跳转对应会话。
	// 页面仍在加载时直接 send 会丢（preload/React 监听未注册），故走 pending 队列：
	// did-finish-load 补发一次 + renderer 挂载后主动拉取（见 queueFocusTarget 注释）。
	// catalog 可能尚未加载完，renderer 侧监听会小间隔重试直到能解析到会话记录。
	const coldStartTarget = extractFocusTargetFromArgv(process.argv);
	if (coldStartTarget?.sessionId) {
		queueFocusTarget(coldStartTarget.sessionId);
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

	// 项目列表可能位于杀软/同步盘较慢的 userData；窗口先显示，随后异步加载，避免 packaged app 打开时白屏等待。
	void projectStore
		.load()
		.then(async () => {
			// load() 已丢掉 e2e 临时项目；对应 catalog 映射一并清掉，侧栏会话不会再挂回来。
			const knownProjectIds = new Set(projectStore.list().map((project) => project.id));
			const orphanProjectIds = new Set(
				sessionCatalog.listEntries()
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

	// 启动后异步检查 RPC 超时时间，如果小于 600 秒则自动修正为 600 秒
	// 避免用户配置的过小超时（如 30 秒）导致启动或命令执行频繁超时
	setTimeout(() => {
		void settingsStore.ensureRpcTimeoutMinimum().catch((error) => {
			void appLogger.warn("settings", "Failed to ensure rpcTimeout minimum", error);
		});
	}, 0);

	// macOS dock 点击或任务栏点击时恢复窗口
	app.on("activate", () => {
		if (mainWindow) {
			mainWindow.show();
			mainWindow.focus();
		} else {
			void createWindow().catch((error) => {
				void appLogger.error("app", "Failed to create window on activate", error);
			});
		}
	});
}).catch((error) => {
	// 打包启动链无窗口时用户只能看到「没反应」；必须落盘并尽力弹出错误框。
	console.error("Application startup failed:", error);
	void appLogger?.error("app", "Application startup failed", error);
	void import("electron").then(({ dialog }) => {
		dialog.showErrorBox(
			"PiDeck failed to start",
			error instanceof Error ? (error.stack ?? error.message) : String(error),
		);
	}).catch(() => undefined);
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
	const legacyNames = [
		...BUILT_IN_EXTENSIONS,
		"pi-deck-project-trust.ts",
		"pi-deck-file-capture.ts",
	];
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
	} catch { /* 文件不存在或解析失败，使用空对象 */ }

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
		console.log('[PiDeck] Ensured pi settings defaults at:', filePath);
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

app.on("before-quit", () => {
	isQuitting = true;
	// 退出清理统一走登记表（C12）：各常驻资源在创建处 register，这里只负责顺序执行。
	// 新增资源不再改 before-quit；单项失败由 registry 记日志不阻塞其余清理。
	void quitCleanup.runAll();
});

app.on("window-all-closed", () => {
	// macOS 关闭所有窗口不退出；其他平台如果启用 closeToTray 也不退出
	if (process.platform === "darwin") return;
	if (!isQuitting) return;
	app.quit();
});
