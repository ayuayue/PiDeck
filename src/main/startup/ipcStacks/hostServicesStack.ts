import { app, shell } from "electron";
import type { BrowserWindow } from "electron";
import { join } from "node:path";
import type { AutomationStore } from "../../automation/AutomationStore";
import type { AgentProfileStore } from "../../agents/AgentProfileStore";
import type { FavoritesStore } from "../../favorites/FavoritesStore";
import type { SessionGroupStore } from "../../sessionGroups/sessionGroupStore";
import type { AutomationRunCoordinator } from "../../automation/AutomationRunCoordinator";
import type { SettingsStore } from "../../settings/SettingsStore";
import { isRemoteProject } from "../../../shared/projectLocation";
import type { MainProcessTranslationKey } from "../../../shared/i18n/mainProcessCopy";
import type { ProjectStore } from "../../projects/ProjectStore";
import type { AgentManager } from "../../pi/AgentManager";
import type { AcpAgentManager } from "../../acp/AcpAgentManager";
import { resolveAgentMemoryDir } from "../../agentMemory/agentMemoryMounts";
import { clearAgentMemoryIndex, readAgentMemoryStatus } from "../../agentMemory/agentMemoryStatus";
import { migrateAgentMemoryProjectKeys } from "../../agentMemory/agentMemoryMigration";
import { deleteAgentMemoryEntries, deleteAgentMemoryEntry, readAgentMemoryEntries, readStandingEntry, restoreAgentMemoryEntry, writeStandingEntry } from "../../agentMemory/agentMemoryEntries";
import { renameDevice } from "../../../../resources/agent-memory/sync.mjs";
import { exportAgentMemoryBundle, importAgentMemoryBundle, previewAgentMemoryBundle } from "../../agentMemory/agentMemoryBundle";
import { registerAgentMemoryIpc } from "../../ipc/agentMemoryIpc";
import type { PiLocator } from "../../pi/PiLocator";
import type { SessionCatalog } from "../../sessions/SessionCatalog";
import type { SessionRuntimeCoordinator } from "../../sessions/SessionRuntimeCoordinator";
import type { SecurityStore } from "../../security/SecurityStore";
import type { GitService } from "../../git/GitService";
import type { WorktreeService } from "../../git/WorktreeService";
import { readEffectiveBuiltInExtensionsVersion } from "../../extensions/builtInExtensions";
import type { BuiltInExtensionPathRoots } from "../../extensions/builtInExtensions";
import type { ProjectResourceManager } from "../../projects/ProjectResourceManager";
import type { ResourceImportManager } from "../../resourceImport/ResourceImportManager";
import { registerProjectsIpc } from "../../ipc/projectsIpc";
import type { RemoteHostConnectionService } from "../../remote/RemoteHostConnectionService";
import { registerHostPluginsIpc } from "../../ipc/hostPluginsIpc";
import { registerPiDeckMcpIpc } from "../../ipc/piDeckMcpIpc";
import { PiDeckMcpService } from "../../mcp/PiDeckMcpService";
import { PiDeckMcpAcpSessions } from "../../mcp/piDeckMcpAcpSessions";
import { HostPluginSessions } from "../../plugins/HostPluginSessions";
import { HostPluginService } from "../../plugins/HostPluginService";
import { BillionContextService } from "../../localServices/billionContextService";
import { LocalServiceRegistry } from "../../localServices/LocalServiceRegistry";
import { createLocalServiceCli, killLocalServiceProcess } from "../../localServices/localServiceCli";
import { registerScratchPadIpc } from "../../ipc/scratchPadIpc";
import { registerPasteFilesIpc } from "../../ipc/pasteFilesIpc";
import { registerSecurityIpc } from "../../ipc/securityIpc";
import { registerResourceImportIpc } from "../../ipc/resourceImportIpc";
import { registerNoticeHistoryIpc } from "../../ipc/noticeHistoryIpc";
import { NoticeHistoryStore } from "../../notices/NoticeHistoryStore";
import type { AppLogger } from "../../logging/AppLogger";
import type { QuitCleanupRegistry } from "../../lifecycle/QuitCleanupRegistry";
import type { RemoteProjectIpcHandle } from "../../ipc/remoteProjectIpc";
import type { RemoteProjectTransferJobIpcHandle } from "../../ipc/remoteProjectTransferJobIpc";

/**
 * hostServices 域 IPC 装配（自 index.ts 的 registerIpc 逐段外移，行为零变化）。
 *
 * ctx 只承载该段真正用到的实例与闭包：模块级单例按值传入（均在 registerIpc 之前完成单次赋值，
 * 读的是同一实例）；少数会在启动后续被替换的绑定（mainWindow / petSystem / tray）走 getter，
 * 保证闭包里读到的是当前值。调用顺序与搬迁前完全一致。
 */
export interface HostServicesStackContext {
	readonly acpAgentManager: AcpAgentManager;
	readonly agentManager: AgentManager;
	readonly agentProfileStore: AgentProfileStore | null;
	readonly appLogger: AppLogger;
	readonly automationRunCoordinator: AutomationRunCoordinator | null;
	readonly automationStore: AutomationStore | null;
	readonly setCleanupPasteFiles: (value: (() => Promise<number>) | undefined) => void;
	readonly favoritesStore: FavoritesStore | null;
	readonly gitService: GitService;
	readonly mainCopy: (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;
	readonly getMainWindow: () => BrowserWindow | null;
	readonly piLocator: PiLocator;
	readonly projectResourceManager: ProjectResourceManager;
	readonly projectStore: ProjectStore;
	readonly quitCleanup: QuitCleanupRegistry;
	readonly resolveBuiltInExtensionRoots: () => BuiltInExtensionPathRoots;
	readonly resourceImportManager: ResourceImportManager;
	readonly securityStore: SecurityStore;
	readonly sessionCatalog: SessionCatalog;
	readonly sessionGroupStore: SessionGroupStore | null;
	readonly sessionRuntimeCoordinator: SessionRuntimeCoordinator;
	readonly settingsStore: SettingsStore;
	readonly worktreeService: WorktreeService;
	readonly remoteHostService: import("../../remote/RemoteHostConnectionService").RemoteHostConnectionService | undefined;
	readonly remoteProjectIpc: RemoteProjectIpcHandle;
	readonly remoteProjectTransfers: RemoteProjectTransferJobIpcHandle;
}

export function registerHostServicesStack(ctx: HostServicesStackContext): void {
	const {
		acpAgentManager,
		agentManager,
		agentProfileStore,
		appLogger,
		automationRunCoordinator,
		automationStore,
		favoritesStore,
		gitService,
		mainCopy,
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
		remoteHostService,
		remoteProjectIpc,
		remoteProjectTransfers,
	} = ctx;

	const localServices = new LocalServiceRegistry([
		new BillionContextService({
			cli: createLocalServiceCli({
				command: "bili",
				// pi 子进程同一套环境清洗：代理/自定义 PATH 都跟着 PiDeck 设置走。
				env: () => (piLocator ? piLocator.createProcessEnv() : undefined),
			}),
			kill: (pid) => killLocalServiceProcess(pid),
		}),
	]);
	const hostPlugins = new HostPluginService(
		app.getPath("userData"),
		sessionCatalog,
		join(__dirname, "../preload/hostPlugin.js"),
		localServices,
		(projectId) => {
			const project = projectStore?.get(projectId);
			if (!project) return undefined;
			// 目录只用于「这条会话属于哪个项目」的展示；ssh 项目拿不到本机路径，给远端路径。
			return { name: project.name, directory: "locator" in project ? project.locator.remotePath : project.path };
		},
		() => sessionGroupStore ?? undefined,
	);
	const unregisterHostPlugins = registerHostPluginsIpc(hostPlugins, () => ctx.getMainWindow());
	const mcpWarning = (code: string) => {
		void appLogger.warn("pideck-mcp", "Optional MCP operation rejected", { code });
	};
	const piDeckMcp = new PiDeckMcpService({
		configPath: join(app.getPath("userData"), "pideck-mcp.json"),
		projects: () => projectStore.list().map(({ id, name }) => ({ id, name })),
		sessions: new HostPluginSessions(sessionCatalog),
		// 宿主级只读视图（settings_get / extensions_list）：settingsStore 在启动后段才装配，
		// 闭包在请求时才求值，未就绪返回 null 而不是抛错。
		settings: () => settingsStore?.get() ?? null,
		builtInExtensionsVersion: () => readEffectiveBuiltInExtensionsVersion(resolveBuiltInExtensionRoots()),
		// 运行时面：coordinator 在 whenReady 里早于 registerIpc 赋值，但闭包仍在请求时才求值，
		// 与 settings 同样不假设装配顺序。
		runtimes: () => sessionRuntimeCoordinator.listRuntimes(),
		abortRuntime: (target) => sessionRuntimeCoordinator.abortRuntime(target),
		// 智能体目录：agentProfileStore 在启动后段（见下方 load 段）才装配，闭包在请求时求值。
		// 未就绪时读返回空列表/undefined，写统一报 operation-failed（工具层映射为安全错误码）。
		agents: {
			list: () => agentProfileStore?.list() ?? [],
			get: (agentId) => agentProfileStore?.get(agentId),
			create: async (input) => {
				if (!agentProfileStore) throw new Error("operation-failed");
				return agentProfileStore.create(input);
			},
			update: async (agentId, patch) => {
				if (!agentProfileStore) throw new Error("operation-failed");
				return agentProfileStore.update(agentId, patch);
			},
			delete: async (agentId) => {
				if (!agentProfileStore) throw new Error("operation-failed");
				return agentProfileStore.delete(agentId);
			},
			bindSession: async (input) => {
				if (!agentProfileStore) throw new Error("operation-failed");
				return agentProfileStore.bindSession(input);
			},
		},
		// 定时任务：automationStore / runCoordinator 在启动后段才装配，闭包在请求时求值。
		// 读接口按 projectId 过滤；写接口未就绪时统一报 operation-failed（工具层映射为安全错误码）。
		automation: {
			listTasks: (projectId) => automationStore?.getSnapshot().tasks.filter((task) => task.projectId === projectId) ?? [],
			getTask: (taskId) => automationStore?.getSnapshot().tasks.find((task) => task.id === taskId),
			listRuns: (projectId) => automationStore?.listRuns().filter((run) => run.projectId === projectId) ?? [],
			getRun: (runId) => automationStore?.getRun(runId),
			createTask: async (input) => {
				if (!automationStore) throw new Error("operation-failed");
				return automationStore.createTask(input);
			},
			updateTask: async (taskId, patch) => {
				if (!automationStore) throw new Error("operation-failed");
				return automationStore.updateTask(taskId, patch);
			},
			deleteTask: async (taskId) => {
				if (!automationStore) throw new Error("operation-failed");
				return automationStore.deleteTask(taskId);
			},
			runNow: async (taskId) => {
				if (!automationRunCoordinator) throw new Error("operation-failed");
				return automationRunCoordinator.runNow(taskId);
			},
			abortRun: async (runId) => {
				if (!automationRunCoordinator) throw new Error("operation-failed");
				return automationRunCoordinator.abortRun(runId);
			},
		},
		// 收藏：favoritesStore 在启动后段才装配，闭包在请求时求值；未就绪时读为空、写报 operation-failed。
		favorites: {
			list: () => favoritesStore?.list() ?? [],
			get: (favoriteId) => favoritesStore?.list().find((entry) => entry.id === favoriteId),
			add: async (input) => {
				if (!favoritesStore) throw new Error("operation-failed");
				return favoritesStore.add(input);
			},
			remove: async (favoriteId) => {
				if (!favoritesStore) return false;
				return favoritesStore.remove(favoriteId);
			},
		},
		// ACP 调用端口：catalog/coordinator/ACP manager 都在启动后段装配，闭包按请求时求值；未开启时工具不注册。
		acp: new PiDeckMcpAcpSessions({
			catalog: sessionCatalog,
			runtime: sessionRuntimeCoordinator,
			readMessages: (acpSessionId) => (acpAgentManager ? acpAgentManager.readMessagesWithArchive(acpSessionId) : Promise.resolve([])),
			settings: () => settingsStore?.get() ?? null,
			getRuntimeMessages: (sessionId) => sessionRuntimeCoordinator.getRuntimeMessages(sessionId)?.value ?? [],
		}),
		warn: mcpWarning,
	});
	const unregisterPiDeckMcp = registerPiDeckMcpIpc(piDeckMcp, () => ctx.getMainWindow(), mcpWarning);
	quitCleanup.register("pideck-mcp", async () => {
		unregisterPiDeckMcp();
		await piDeckMcp.dispose();
	});
	// 智能体记忆的设置页视图：状态/清空索引/导出/导入。记忆根目录与 MCP 服务器用的是同一个
	// （userData/memory），所以这里算出来的体积与索引规模就是 Agent 侧看到的真实值。
	const agentMemoryRoot = () => resolveAgentMemoryDir(app.getPath("userData"));
	// 项目键算法换过一版（slug → slug + 路径哈希）：启动时把旧的 projects/<旧键>/ 改名到新键，
	// 否则老用户的项目记忆会失联。幂等、尽力而为；不在 PiDeck 项目列表里的路径，
	// 会在对应会话启动时由 MCP 服务器自己补迁。
	const memoryMigration = migrateAgentMemoryProjectKeys(
		agentMemoryRoot(),
		projectStore.list().map((project) => ("locator" in project ? project.locator.remotePath : project.path)),
	);
	if (memoryMigration.skipped.length > 0) mcpWarning(`agent-memory: 项目记忆目录迁移跳过 ${memoryMigration.skipped.length} 个：${memoryMigration.skipped.join(", ")}`);
	const unregisterAgentMemoryIpc = registerAgentMemoryIpc({
		getWindow: () => ctx.getMainWindow(),
		readStatus: () => readAgentMemoryStatus(agentMemoryRoot()),
		clearIndex: () => clearAgentMemoryIndex(agentMemoryRoot()),
		exportBundle: (selection) => exportAgentMemoryBundle({ root: agentMemoryRoot(), getWindow: () => ctx.getMainWindow(), selection }),
		previewBundle: (filePath) => previewAgentMemoryBundle({ root: agentMemoryRoot(), getWindow: () => ctx.getMainWindow(), filePath }),
		importBundle: (options) => importAgentMemoryBundle({ root: agentMemoryRoot(), getWindow: () => ctx.getMainWindow(), ...options }),
		// 项目名只用于展示：记忆键由会话 cwd 派生，要靠项目路径反查一次才认得出来。
		listEntries: () =>
			readAgentMemoryEntries({
				root: agentMemoryRoot(),
				// ssh 项目没有本机路径，用远端路径派生同一个键（与会话 cwd 的派生口径一致）。
				projects: () => projectStore.list().map((project) => ({ name: project.name, path: "locator" in project ? project.locator.remotePath : project.path })),
			}),
		deleteEntry: (input) => deleteAgentMemoryEntry(agentMemoryRoot(), input),
		deleteEntries: (items) => deleteAgentMemoryEntries(agentMemoryRoot(), items),
		restoreEntry: (input) => restoreAgentMemoryEntry(agentMemoryRoot(), input),
		// 打开记忆根目录：showItemInFolder 是 fire-and-forget（Linux 上 openPath 会永不 settle，#396），
		// 包一层 Promise 让信封形态保持一致；失败只告警，不让设置页弹错误。
		revealRoot: async () => {
			try {
				shell.showItemInFolder(agentMemoryRoot());
			} catch (error) {
				mcpWarning(error instanceof Error ? error.message : String(error));
			}
		},
		readStanding: () => readStandingEntry(agentMemoryRoot()),
		writeStanding: (content) => writeStandingEntry(agentMemoryRoot(), content),
		renameDevice: (name) => renameDevice(agentMemoryRoot(), name),
		warn: mcpWarning,
	});
	quitCleanup.register("agent-memory-ipc", () => {
		unregisterAgentMemoryIpc();
	});
	quitCleanup.register("host-plugins", () => {
		unregisterHostPlugins();
		hostPlugins.dispose();
	});
	// 插件不随包：只扫描用户自己装的那些（内置示例已改为 docs/examples 下的可安装包）。
	void hostPlugins.initialize().catch(() => appLogger.warn("host-plugins", "Optional plugin host initialization failed"));
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
		getMainWindow: () => ctx.getMainWindow(),
		userDataDir: app.getPath("userData"),
		// 项目关闭时退订它的目录订阅；连接/窗口级清理分别在 onDisconnect 与 quitCleanup 里。
		onProjectRemoved: async (projectId, removed) => {
			remoteProjectTransfers.closeProject(projectId);
			await remoteProjectIpc.closeProject(projectId);
			if (removed && isRemoteProject(removed)) await remoteHostService?.retireProjectSession(removed.locator.hostId, removed.locator.remotePath);
		},
		resolveWslEnvironment: async (distro, user) => {
			const { resolveWslEnvironment } = await import("../../wsl/WslEnvironment");
			return resolveWslEnvironment(distro, user, {
				warn: (msg: string, detail: Record<string, unknown>) => void appLogger?.warn("wsl", msg, detail),
			});
		},
	});
	registerResourceImportIpc(resourceImportManager);

	registerScratchPadIpc({ appLogger });

	// 通知历史落盘：showNotice 单点记录后推送主进程，重启可回灌（渲染层环形缓冲只服务当次会话）
	const noticeHistoryStore = new NoticeHistoryStore({
		getFilePath: () => join(app.getPath("userData"), "notice-history.json"),
		log: (level, message, detail) => {
			if (level === "error") void appLogger.error("notice-history", message, detail);
			else void appLogger.info("notice-history", message, detail);
		},
	});
	registerNoticeHistoryIpc(noticeHistoryStore);
	// C12：退出前 flush 防抖窗口内的尾巴——store 写盘是防抖合并（500ms），不冲盘就退出
	// 会丢最后几条通知历史；runAll 会 await 异步清理，写盘完成才放行退出。
	quitCleanup.register("notice-history", async () => {
		await noticeHistoryStore.flush();
	});

	// 粘贴大文本 → 落盘文件（受管目录，路径校验 + 启动清理）
	ctx.setCleanupPasteFiles(
		registerPasteFilesIpc({
			projectStore,
			settingsStore,
			appLogger,
		}),
	);

	// 安全管理：配置读写 + 会话等级覆盖（SecurityStore 负责持久化与策略快照）
	registerSecurityIpc({
		securityStore,
		log: (domain, message, details) => void appLogger.info(domain, message, details),
	});
}
