import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { app, type BrowserWindow } from "electron";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import { ipcChannels } from "../../shared/ipc";
import type { UpdateChannel } from "../../shared/types/app";
import { resolveBuildOrigin } from "../buildIdentity";
import { ConfigBackupManager } from "../config/ConfigBackupManager";
import { ConfigManager } from "../config/ConfigManager";
import { credentialValueFromDocument } from "../dsh/dshCredentials";
import { resolveDshHomeDir } from "../dsh/DshHost";
import { FileSystemService } from "../fs/FileSystemService";
import { GitRefsWatcher } from "../git/GitRefsWatcher";
import { GitService } from "../git/GitService";
import { WorktreeService } from "../git/WorktreeService";
import type { QuitCleanupRegistry } from "../lifecycle/QuitCleanupRegistry";
import { AppLogger } from "../logging/AppLogger";
import { RpcLogger } from "../logging/RpcLogger";
import { setAppLogger } from "../logging/sharedLogger";
import { PiAuthService } from "../pi/auth/PiAuthService";
import { resolvePiAuthHostLaunch } from "../pi/auth/piAuthHostLaunch";
import type { EnhancePromptService } from "../pi/enhance/EnhancePromptService";
import { PiLocator } from "../pi/PiLocator";
import { ProjectStore } from "../projects/ProjectStore";
import type { UserDataNameMigration } from "../projects/userDataNameMigration";
import { createRemoteReferenceWriteGuard } from "../remote/RemoteReferenceWriteGuard";
import type { RemoteHostConnectionService } from "../remote/RemoteHostConnectionService";
import { ClaudeSessionImporter } from "../sessions/ClaudeSessionImporter";
import { CodexSessionImporter } from "../sessions/CodexSessionImporter";
import { CodeBuddySessionImporter, WorkBuddySessionImporter } from "../sessions/codebuddyFamilySessionImporter";
import { CursorSessionImporter } from "../sessions/CursorSessionImporter";
import { DirectorySessionImporter } from "../sessions/DirectorySessionImporter";
import { normalizeSessionPathKey } from "../sessions/directorySessionImport";
import { KimiSessionImporter } from "../sessions/KimiSessionImporter";
import { KimiWorkSessionImporter } from "../sessions/KimiWorkSessionImporter";
import { MinimaxSessionImporter } from "../sessions/MinimaxSessionImporter";
import { OpenCodeSessionImporter } from "../sessions/OpenCodeSessionImporter";
import { QoderSessionImporter } from "../sessions/QoderSessionImporter";
import type { SessionCatalog } from "../sessions/SessionCatalog";
import { SessionScanner } from "../sessions/SessionScanner";
import { ZCodeSessionImporter } from "../sessions/ZCodeSessionImporter";
import { SecurityStore } from "../security/SecurityStore";
import { SettingsStore } from "../settings/SettingsStore";
import { UsageStatsService } from "../usageStats/UsageStatsService";
import type { WebServiceManager } from "../web/WebServiceManager";

/**
 * 本块真正用到的装配输入。可变单例（mainWindow / sessionCatalog / remoteHostServiceResolver /
 * webServiceManager）走 getter：它们在本块之后才装配，闭包里必须读到调用时的当前实例；
 * 一次性值（通道、计时锚点、迁移结果）直接传值。
 */
export interface CoreServicesContext {
	/** index.ts 的本地化入口（每调用现求值，不做启动期快照）。 */
	readonly mainCopy: (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;
	/** index.ts 的侧车工厂：增强/输入预测/记忆学习三个实例共用同一套协议装配。 */
	readonly createCompletionHelperService: (namespace: "enhance" | "agent-invoke" | "suggest" | "agent-memory") => EnhancePromptService;
	readonly quitCleanup: QuitCleanupRegistry;
	readonly bootAnchorMs: number;
	readonly updateChannel: UpdateChannel;
	readonly userDataNameMigrationResult: UserDataNameMigration | null;
	readonly devDirectoryMigration: { readonly migrations: readonly UserDataNameMigration[] };
	readonly getMainWindow: () => BrowserWindow | null;
	/** 引用写入门（INV-1 / INV-12 写入侧）：项目表与会话目录共用同一道门，由 index.ts 先于本块构造。 */
	readonly referenceWriteGuard: ReturnType<typeof createRemoteReferenceWriteGuard>;
	readonly getSessionCatalog: () => SessionCatalog;
	readonly getRemoteHostServiceResolver: () => (() => Promise<RemoteHostConnectionService> | undefined) | undefined;
	readonly getWebServiceManager: () => WebServiceManager | undefined;
}

/** 装配出的单例：调用方（index.ts）仍是模块级 `let` 的唯一 owner，这里只交出初值。 */
export interface CoreServices {
	readonly projectStore: ProjectStore;
	readonly fileSystemService: FileSystemService;
	readonly sessionScanner: SessionScanner;
	readonly codexSessionImporter: CodexSessionImporter;
	readonly claudeSessionImporter: ClaudeSessionImporter;
	readonly qoderSessionImporter: QoderSessionImporter;
	readonly openCodeSessionImporter: OpenCodeSessionImporter;
	readonly zcodeSessionImporter: ZCodeSessionImporter;
	readonly workbuddySessionImporter: WorkBuddySessionImporter;
	readonly codebuddySessionImporter: CodeBuddySessionImporter;
	readonly cursorSessionImporter: CursorSessionImporter;
	readonly kimiSessionImporter: KimiSessionImporter;
	readonly kimiWorkSessionImporter: KimiWorkSessionImporter;
	readonly minimaxSessionImporter: MinimaxSessionImporter;
	readonly directorySessionImporter: DirectorySessionImporter;
	readonly settingsStore: SettingsStore;
	readonly securityStore: SecurityStore;
	readonly appLogger: AppLogger;
	readonly rpcLogger: RpcLogger;
	readonly usageStatsService: UsageStatsService;
	readonly gitService: GitService;
	readonly gitRefsWatcher: GitRefsWatcher;
	readonly worktreeService: WorktreeService;
	readonly piLocator: PiLocator;
	readonly piAuthService: PiAuthService;
	readonly enhancePromptService: EnhancePromptService;
	readonly promptSuggestionService: EnhancePromptService;
	readonly agentMemoryLearnService: EnhancePromptService;
	readonly configManager: ConfigManager;
	readonly configBackupManager: ConfigBackupManager | undefined;
}

/**
 * 启动装配（自 index.ts 的 `app.whenReady()` 装配体就地外移，语句顺序与搬迁前一致）：
 * 项目表/文件/会话扫描与 11 个外部会话导入器 → 设置/安全 → 日志 → 用量/Git/pi 定位与认证 →
 * 增强三侧车 → pi 配置与备份。退出清理（quitCleanup）登记也在原位置，顺序即 before-quit 执行序。
 */
export function startCoreServices(ctx: CoreServicesContext): CoreServices {
	const { mainCopy, quitCleanup } = ctx;
	// 先声明后赋值：导入器的失败回调、安全门/认证的日志回调都在 appLogger 装配之前构造，
	// 与原模块级 `let appLogger` 同一时序（回调触发时已赋值）。
	let appLogger: AppLogger;

	// 引用写入门由 index.ts 构造后传入（会话目录装配也用它），与搬迁前同一道实例。
	const projectStore = new ProjectStore(() => mainCopy("dialog.chooseProjectFolder"), { referenceGuard: ctx.referenceWriteGuard });
	// Agent 记忆（pideck-agent-memory）：注册时机与 CUA 同一处——settingsStore 已就绪后再按开关决定，
	// 避免「先无条件写用户 mcp.json，再等设置加载」这类顺序依赖。
	const fileSystemService = new FileSystemService();
	const sessionScanner = new SessionScanner(mainCopy);
	const codexSessionImporter = new CodexSessionImporter(mainCopy);
	const claudeSessionImporter = new ClaudeSessionImporter(mainCopy);
	const qoderSessionImporter = new QoderSessionImporter(mainCopy);
	const openCodeSessionImporter = new OpenCodeSessionImporter(mainCopy);
	const zcodeSessionImporter = new ZCodeSessionImporter(mainCopy);
	const workbuddySessionImporter = new WorkBuddySessionImporter(mainCopy);
	const codebuddySessionImporter = new CodeBuddySessionImporter(mainCopy);
	const cursorSessionImporter = new CursorSessionImporter(mainCopy);
	const kimiSessionImporter = new KimiSessionImporter(mainCopy);
	const kimiWorkSessionImporter = new KimiWorkSessionImporter(mainCopy);
	const minimaxSessionImporter = new MinimaxSessionImporter(mainCopy);
	// 外置目录会话导入：不复制会话文件，只把选定目录里的会话挂到当前项目（catalog 归属改写）。
	// 候选来自 SessionScanner 的全量清单（list() 不带项目参数）——项目目录改名后，
	// 那批会话仍然躺在 sessions 树里，只是项目过滤把它们排除了。
	const directorySessionImporter = new DirectorySessionImporter({
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
				ctx
					.getSessionCatalog()
					.listEntries()
					.filter((entry) => Boolean(entry.filePath))
					.map((entry) => normalizeSessionPathKey(entry.filePath!)),
			),
		// 第四个参数是导入选项：manualAssignment 把归属钉在当前项目（旧目录项目扫描抢不回去）。
		mergeScanned: (projectId, summaries, options) => ctx.getSessionCatalog().mergeScanned(projectId, summaries, undefined, options),
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
	const settingsStore = new SettingsStore();
	// 设置写盘尾随合并的收尾（2027-02 性能治理）：退出时立即落盘在途的 150ms 合并窗口，
	// 防止「改完设置立刻退出」丢失最后一笔（窗口 unref 不拖退出）。
	quitCleanup.register("settings-flush", () => settingsStore.flushPendingSave());
	// 安全管理：配置 owner + 策略快照写入（供 pi-deck-security-gate 扩展消费）
	const securityStore = new SecurityStore({
		settingsStore,
		log: (domain, message, details) => void appLogger?.info(domain, message, details),
		// 远端会话的安全门读的是远端副本：快照一变就热推到已连接主机（尽力而为，失败不影响本机）。
		onSnapshotWritten: (bytes) => {
			const pending = ctx.getRemoteHostServiceResolver()?.();
			if (pending === undefined) return;
			pending.then((service) => service.pushSecurityPolicySnapshotToReadyHosts(bytes)).catch(() => undefined);
		},
		// 配置变更（桌面设置页 / 会话菜单 / Web 端 API 任一来源）：
		// 桌面渲染层刷新等级菜单，Web 端经 /api/events 立即拿到新快照。
		onConfigChanged: () => {
			const mainWindow = ctx.getMainWindow();
			if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ipcChannels.securityConfigChanged);
			ctx.getWebServiceManager()?.notifySecurityChanged();
		},
	});
	appLogger = new AppLogger();
	setAppLogger(appLogger);
	// 冷启动里程碑（1/2）：主进程 ready。sinceModuleLoadMs 从 index.ts 模块加载起算；
	// processUptimeMs 从 Electron 进程创建起算（含二进制启动），差值即 ready 前主进程耗时。
	void appLogger.info("app", "Cold start milestone: app ready", {
		sinceModuleLoadMs: Date.now() - ctx.bootAnchorMs,
		processUptimeMs: Math.round(process.uptime() * 1000),
	});
	// 构建身份（通道 + 来源）：支持排障时一眼看出这个包是本机打包还是发布产物。
	// 与更新界面的「本地构建」徽章同源（systemIpc 的 update:get-channel）。
	void appLogger.info("app", "Build identity", {
		channel: ctx.updateChannel,
		buildOrigin: resolveBuildOrigin(),
		packaged: app.isPackaged,
	});
	// userData 更名迁移（pi-desktop → PiDeck）在 setPath 前同步执行，当时还没有日志器；
	// 结果在此补记，失败/回退路径必须可从日志诊断。
	for (const result of [ctx.userDataNameMigrationResult, ...ctx.devDirectoryMigration.migrations]) {
		if (result?.kind === "migrated") {
			void appLogger.info("migration", "userData directory renamed to PiDeck", { from: result.oldPath, to: result.userDataPath, sessionDirs: result.migratedSessionDirs.length });
		} else if (result?.kind === "failed") {
			void appLogger.warn("migration", "userData migration incomplete; retry next launch", { userDataPath: result.userDataPath, reason: result.reason });
		} else if (result?.kind === "skipped" && result.reason === "collision") {
			void appLogger.warn("migration", "Legacy and PiDeck directories coexist; preserving both without merging", { userDataPath: result.userDataPath });
		}
	}
	const rpcLogger = new RpcLogger();
	// 用量统计：pi-tracker 的 <agentDir>/analytics/usage.jsonl
	// + dsh-bill 的 <DSH_HOME>/dsh-bill/records.jsonl（采集由插件负责，此处只读）。
	// DSH_HOME 与 DshHost 同一套解析（设置覆盖 > ~/.dsh > 应用私有目录）。
	const usageStatsService = new UsageStatsService({
		agentDir: join(app.getPath("home"), ".pi", "agent"),
		getDshHomeDir: () => resolveDshHomeDir(settingsStore.get().dshHomeDir ?? "", app.getPath("userData")),
		logger: {
			info: (message) => void appLogger?.info("usage-stats", message),
			warn: (message) => void appLogger?.warn("usage-stats", message),
		},
	});
	const gitService = new GitService();
	const gitRefsWatcher = new GitRefsWatcher({ logger: appLogger });
	// C12：退出清理登记（before-quit 统一 runAll；disposeAll 同时清空事件订阅）
	quitCleanup.register("git-refs-watcher", () => gitRefsWatcher.disposeAll());
	const worktreeService = new WorktreeService(mainCopy);
	const piLocator = new PiLocator(mainCopy);
	// 认证助手（见 AGENTS.md「认证例外通道」）：每次操作现解析 pi 入口，
	// 用户改自定义 pi 路径/代理后无需重启即可生效。
	const piAuthService = new PiAuthService({
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
		const mainWindow = ctx.getMainWindow();
		if (!mainWindow || mainWindow.isDestroyed()) return;
		mainWindow.webContents.send(ipcChannels.piAuthFlowUpdate, update);
	});
	// C12：退出清理登记（before-quit 统一 runAll）——登录子进程必须随之回收。
	quitCleanup.register("pi-auth", () => piAuthService?.dispose());
	// 提示词增强助手（见 AGENTS.md「提示词增强例外通道」）：常驻单进程，复用认证
	// 同一套 pi 入口解析；用户改自定义 pi 路径后下次增强生效（resolveLaunch 现求值）。
	const enhancePromptService = ctx.createCompletionHelperService("enhance");
	// C12：增强助手是常驻子进程，退出时必须回收。
	quitCleanup.register("enhance-prompt", () => enhancePromptService?.dispose());
	// 输入预测：与增强同协议、独立进程；启动期只装配，首次预测才拉起侧车。
	const promptSuggestionService = ctx.createCompletionHelperService("suggest");
	quitCleanup.register("prompt-suggestion", () => promptSuggestionService?.dispose());
	// 记忆学习循环：只在用户开启开关后才会被调用（见 registerIpc 里的回合结算钩子），
	// 这里只装配实例——侧车进程仍然是首次真正需要时才拉起。
	const agentMemoryLearnService = ctx.createCompletionHelperService("agent-memory");
	quitCleanup.register("agent-memory-learn", () => agentMemoryLearnService?.dispose());
	// DSH 用量链路（backend="dsh"）：配置落 $DSH_HOME/usage-probes.json、凭据从
	// $DSH_HOME/.credentials.yaml 读，与 pi 侧链路（~/.pi/agent）完全同构、互不干扰。
	// DSH_HOME 解析与 DshHost 同一套（设置覆盖 > ~/.dsh > 应用私有目录），getter 每次求值，
	// 用户改设置立即生效；readCredential 环境层优先、文件层兜底（与 DshHost 相同优先级）。
	const configManager = new ConfigManager(undefined, mainCopy, {
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
	const configBackupManager = new ConfigBackupManager({
		getConfigDir: () => configManager.getConfigDir(),
		getUserDataDir: () => app.getPath("userData"),
		getAppVersion: () => app.getVersion(),
		onError: (message, detail) => void appLogger?.warn("backup", message, { detail }),
	});

	return {
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
	};
}
