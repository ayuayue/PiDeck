import { app } from "electron";
import { join } from "node:path";
import { ipcChannels } from "../../../shared/ipc";
import { isRemoteProject } from "../../../shared/projectLocation";
import type { PiResourceManagerPool } from "../../config/PiResourceManagerPool";
import type { BuiltInExtensionPathRoots } from "../../extensions/builtInExtensions";
import { registerRemoteGitReadIpc } from "../../ipc/remoteGitReadIpc";
import { registerRemoteHostIpc } from "../../ipc/remoteHostIpc";
import { registerRemoteHostRebindIpc } from "../../ipc/remoteHostRebindIpc";
import { registerRemotePiModelIpc } from "../../ipc/remotePiModelIpc";
import { registerRemoteProjectEntryIpc } from "../../ipc/remoteProjectEntryIpc";
import { registerRemoteProjectFileIpc } from "../../ipc/remoteProjectFileIpc";
import { registerRemoteProjectIpc } from "../../ipc/remoteProjectIpc";
import { registerRemoteProjectTransferJobIpc } from "../../ipc/remoteProjectTransferJobIpc";
import { registerRemoteProjectTrustIpc } from "../../ipc/remoteProjectTrustIpc";
import { registerRemoteSessionIpc } from "../../ipc/remoteSessionIpc";
import { registerWslHostIpc } from "../../ipc/wslHostIpc";
import { QuitCleanupRegistry } from "../../lifecycle/QuitCleanupRegistry";
import type { AgentManager } from "../../pi/AgentManager";
import { createRemotePiModelProbe } from "../../pi/RemotePiModelProbe";
import type { ProjectStore } from "../../projects/ProjectStore";
import { createRemoteFactsHub } from "../../remote/RemoteFactsNotifications";
import { createRemoteHostConnectionService, type RemoteHostConnectionService } from "../../remote/RemoteHostConnectionService";
import { openRemoteHostCatalogView } from "../../remote/RemoteHostCatalogView";
import { createRemoteProjectTrustHostFacts } from "../../remote/RemoteProjectTrustHostFacts";
import { createRemoteProjectTrustService, type RemoteProjectTrustService } from "../../remote/RemoteProjectTrustService";
import { ROOT_POOL_DEFAULT_POLICY } from "../../remote/RemoteRootSessionPool";
import type { RemoteSftpProbe } from "../../remote/RemoteSftpAdapter";
import { loadRemoteSftpBinaryIdentity, type RemoteSftpBinaryIdentity } from "../../remote/RemoteSftpBinary";
import { createRemoteSftpCapabilityCache } from "../../remote/RemoteSftpCapabilityCache";
import { createRemoteSftpCapabilityProbe } from "../../remote/RemoteSftpCapabilityProbe";
import { createRemoteSftpDirectoryReader } from "../../remote/RemoteSftpDirectoryReader";
import { createSshClientRuntime, resolvePosixSshClient, type SshClientRuntime } from "../../remote/SshClientRuntime";
import { buildPinnedSshInvocation } from "../../remote/SshVerifiedConnection";
import { REMOTE_FEATURE_AVAILABLE } from "../../remote/remoteFeaturePolicy";
import { matchRemoteSessionProject } from "../../remote/remoteSessionProjectMatch";
import type { SessionCatalog } from "../../sessions/SessionCatalog";
import type { RemoteSessionCommandTransportPort } from "../../sessions/RemoteSessionScanner";
import type { SettingsStore } from "../../settings/SettingsStore";
import type { RemoteTerminalSessionManager } from "../../terminal/RemoteTerminalSessionManager";
import { createWslHostReferenceRegistry } from "../../wsl/WslHostReferences";

/**
 * remote 域 IPC 装配（自 index.ts 的 registerIpc 逐段外移，行为零变化）。
 *
 * 这一域原本就有「连接服务 / trust 决策表」两个懒单例，且它们的解析器要回填给模块级绑定
 * （AgentManager 的远端运行时端口比 registerIpc 更早构造）：因此 ctx 用 setter 把解析器与
 * rebind 句柄交回 index.ts，用 getter 取那些在启动后续才被替换的绑定（终端管理器、资源池、
 * 短命令传输端口）。调用顺序与搬迁前完全一致。
 */
export interface RemoteStackContext {
	readonly agentManager: AgentManager;
	readonly getMainWindow: () => import("electron").BrowserWindow | null;
	readonly getPiResourcePool: () => PiResourceManagerPool | undefined;
	readonly getRemoteCommandTransport: () => RemoteSessionCommandTransportPort | undefined;
	readonly getRemoteTerminalManager: () => RemoteTerminalSessionManager | undefined;
	readonly projectStore: ProjectStore;
	readonly quitCleanup: QuitCleanupRegistry;
	readonly resolveBuiltInExtensionRoots: () => BuiltInExtensionPathRoots;
	readonly sessionCatalog: SessionCatalog;
	readonly setRemoteCommandTransport: (value: RemoteSessionCommandTransportPort) => void;
	readonly setRemoteHostRebindIpc: (value: { resumePendingAtStartup: () => Promise<void> } | undefined) => void;
	readonly setRemoteHostServiceResolver: (value: () => Promise<RemoteHostConnectionService> | undefined) => void;
	readonly setRemoteProjectTrustService: (value: RemoteProjectTrustService | undefined) => void;
	readonly settingsStore: SettingsStore;
}

export interface RemoteStackHandles {
	readonly getRemoteHostService: () => RemoteHostConnectionService | undefined;
	readonly remoteFeatureEnabled: boolean;
	readonly remoteGitReads: ReturnType<typeof registerRemoteGitReadIpc>;
	readonly remoteHostServiceIfEnabled: () => Promise<RemoteHostConnectionService> | undefined;
	readonly remoteProjectEntries: ReturnType<typeof registerRemoteProjectEntryIpc>;
	readonly remoteProjectIpc: ReturnType<typeof registerRemoteProjectIpc>;
	readonly remoteProjectTextPort: ReturnType<typeof registerRemoteProjectFileIpc>;
	readonly remoteProjectTransfers: ReturnType<typeof registerRemoteProjectTransferJobIpc>;
	readonly runPinnedRemoteCommand: (input: { hostId: string; remoteCommand: string }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export function registerRemoteStack(ctx: RemoteStackContext): RemoteStackHandles {
	const { agentManager, projectStore, quitCleanup, sessionCatalog, settingsStore } = ctx;
	let remoteProjectTrustService: RemoteProjectTrustService | undefined;

	// 远端能力与更新通道正交：正式包和 dev 包都装配；同一策略位由
	// update:get-channel 的 remoteAvailable 下发给渲染层，避免主/渲染判据漂移。
	// 各远端 IPC 仍保留 enabled=false 的 fail-closed 分支，供测试和后续下线策略使用。
	const remoteFeatureEnabled = REMOTE_FEATURE_AVAILABLE;
	let remoteHostService: import("../../remote/RemoteHostConnectionService").RemoteHostConnectionService | undefined;
	/**
	 * 已解析的 OpenSSH 客户端（SSH 路由校验与每个 ssh/scp 子进程共用同一份）。
	 *
	 * 懒且单实例：`ssh -G` 形状自检把「我们用的是哪个客户端」当成整条连接的信锚，
	 * 两处各自发现一次就有可能与实际启动的进程不是同一个客户端。失败不缓存（用户可能刚装好客户端）。
	 */
	let remoteSshClientPending: Promise<SshClientRuntime> | undefined;
	const remoteSshClientIfEnabled = (): Promise<SshClientRuntime> => {
		remoteSshClientPending ??= process.platform === "win32" ? Promise.resolve(createSshClientRuntime()) : resolvePosixSshClient();
		remoteSshClientPending.catch(() => {
			remoteSshClientPending = undefined;
		});
		return remoteSshClientPending;
	};
	/** Discover the verified client once; failed construction can be retried. */
	let remoteHostServicePending: Promise<import("../../remote/RemoteHostConnectionService").RemoteHostConnectionService> | undefined;
	const remoteHostServiceIfEnabled = (): Promise<import("../../remote/RemoteHostConnectionService").RemoteHostConnectionService> | undefined => {
		if (!remoteFeatureEnabled) return undefined;
		remoteHostServicePending ??= (async () => {
			// Windows resolves its client internally; elsewhere the client must be discovered and proven
			// capable before we let it answer route checks. Failing here is a stable code, not a crash.
			const client = await remoteSshClientIfEnabled();
			// The service resolves the host's own node itself (login shell), so no nodePath is pinned here.
			const service = createRemoteHostConnectionService({
				userDataDir: app.getPath("userData"),
				client,
				rootPooling: ROOT_POOL_DEFAULT_POLICY,
				// 内置扩展快照的来源：与本地 `-e` 注入同一份「当前生效」字节（覆盖层优先，整份校验）。
				builtInExtensionRoots: ctx.resolveBuiltInExtensionRoots(),
				onDisconnect: (hostId) => {
					ctx.getRemoteTerminalManager()?.closeHost(hostId);
					// helper 的 watcher 已随会话一起死：丢掉登记，不把旧 watchId 当有效。
					remoteProjectFacts?.onHostDisconnected(hostId);
				},
				// Push every transition to the window: `connect()` only returns the state it reached, so
				// anything afterwards (degradation, reconnect, the shutdown after ready) is invisible without
				// this, and the UI ends up showing a stale state.
				onStateChange: ({ hostId, state }) => {
					const mainWindow = ctx.getMainWindow();
					if (!mainWindow || mainWindow.isDestroyed()) return;
					mainWindow.webContents.send(ipcChannels.remoteHostStateChanged, { hostId, state: state.state });
				},
				// helper 1.24.0 的变更事件：只标脏事实，不触发装载（重读仍由读的人决定）。
				onHelperEvent: (entry) => remoteProjectFacts?.onHelperEvent(entry),
				// root 会话退休（TTL/LRU/latched/显式）与主机断开是两件事：只清这个 root 的登记，不关终端。
				onRootRetired: (entry) => remoteProjectFacts?.onRootRetired(entry),
			});
			remoteHostService = service;
			quitCleanup.register("remote-host", () => remoteHostService?.dispose());
			return service;
		})();
		// A failed build must not be cached forever: let the next attempt re-probe (the user may have just
		// installed a client). The pending promise is dropped on failure only.
		remoteHostServicePending.catch(() => {
			remoteHostServicePending = undefined;
		});
		return remoteHostServicePending;
	};
	// AgentManager 比 registerIpc 更早装配（它在下面的 whenReady 里构造），拿到的远端运行时端口只能
	// 按需回调这个解析器：门禁表达式与连接服务单例都只允许有一份（见 remoteRuntimePort 的注释）。
	// 未登记（本函数还没跑到）/门禁关闭时，端口一律 REMOTE_FEATURE_DISABLED，绝不回退本机。
	ctx.setRemoteHostServiceResolver(remoteHostServiceIfEnabled);
	// 远端项目 trust 决策表（P4.4b）：持久化段指向 SettingsStore（随配置备份），主机事实指向已确认 pin 的
	// 只读目录入口（不新增 SSH 通道、不复制路径归一化）。装配处只此一份：远端运行时端口与 trust 域共用它。
	const remoteProjectTrust = createRemoteProjectTrustService({
		settings: {
			read: () => settingsStore.get().remoteProjectTrust,
			// 专用写入入口：决策不得经通用 `settings:update` 通道（那会让渲染层构造的记录替换整张表）。
			write: (records) => settingsStore.replaceRemoteProjectTrust(records),
		},
		hostFacts: createRemoteProjectTrustHostFacts({ userDataDir: app.getPath("userData") }),
	});
	// 远端会话的 trust 解析发生在 AgentManager 的端口里（它比本函数先构造），所以实例挂在模块级变量上：
	// 那里的 `resolveTrust` 闭包在**真正 spawn 时**才求值，不会拿到一个当时还不存在的对象。
	remoteProjectTrustService = remoteProjectTrust;
	ctx.setRemoteProjectTrustService(remoteProjectTrust);
	const remoteHostIpc = registerRemoteHostIpc({
		enabled: remoteFeatureEnabled,
		userDataDir: app.getPath("userData"),
		// 主机退役时同时清掉它的 trust 决策（与 pin 清理同一位置、同一重试语义）。
		list: () => openRemoteHostCatalogView(app.getPath("userData"), { onHostRetired: (hostId) => remoteProjectTrustService?.forgetHost(hostId) ?? Promise.resolve() }),
		service: remoteHostServiceIfEnabled,
		// 移除连接与列表共用同一组退役清理：pin 删除后 trust 决策也要跟着清。
		onHostRetired: (hostId) => remoteProjectTrustService?.forgetHost(hostId) ?? Promise.resolve(),
		// The add-host flow holds a pin store across two IPC calls (offer, then the user's answer), so its
		// lifetime is the process, not a call. Registering disposal here keeps the broker's timers from
		// outliving the app.
		registerCleanup: (cleanup) => quitCleanup.register("remote-host-stores", cleanup),
	});
	// 重新绑定（rebind）：与 remoteHostIpc 共用同一对 store/pin 实例；通道没有消费者之前不建。
	const remoteHostRebindIpc = registerRemoteHostRebindIpc({
		enabled: remoteFeatureEnabled,
		userDataDir: app.getPath("userData"),
		openStores: remoteHostIpc.openStores,
		projectStore: () => projectStore,
		sessionCatalog: () => sessionCatalog,
		// §5.5：执行前断开来源；失败直接上报（此时 tx 还没写任何东西）。
		disconnect: async (hostId) => {
			const service = await remoteHostServiceIfEnabled();
			await service?.disconnect(hostId, "shutdown");
		},
		registerCleanup: (cleanup) => quitCleanup.register("remote-host-rebind", cleanup),
	});
	ctx.setRemoteHostRebindIpc(remoteHostRebindIpc);
	// 远端项目域（登记/回答/列表/读取/搜索）与 hosts 域分开注册：同一个连接服务端口，不同域的 handler。
	// 远端 trust 域（决策表的清单/写入/撤销）同样分开：它不动 SSH，只读写桌面配置 + 已确认的 pin 事实。
	// WSL 连接档案：只读写本机清单；移除前扫描项目/会话的 wslHostId 引用（字段在第 11/12 步接入）。
	registerWslHostIpc({
		userDataDir: app.getPath("userData"),
		references: createWslHostReferenceRegistry({
			projectsFile: join(app.getPath("userData"), "projects.json"),
			sessionCatalogFile: join(app.getPath("userData"), "session-catalog.json"),
		}),
		// 档案被改名/换 distro/移除后，资源池里对应实例必须失效；闭包在 registerIpc 执行时取值，
		// 池在稍后构造（晚绑定），调用发生在用户操作档案时，因此一定能拿到实例。
		onProfileChanged: () => ctx.getPiResourcePool()?.invalidate(),
	});
	/**
	 * 目录事实层的失效入口（W3）：项目域注册时才创建，文本保存的注册在它之前，因此用晚绑定转发。
	 * 只标脏、不装载——一次保存不会额外产生任何远端往返。
	 */
	let remoteProjectFacts:
		| {
				afterWrite(projectId: string, paths: readonly string[]): void;
				onHelperEvent(entry: { hostId: string; watchId: string; paths: readonly string[]; sessionKey: string }): void;
				onHostDisconnected(hostId: string): void;
				onRootRetired(entry: { hostId: string; root: string; sessionKey: string }): void;
		  }
		| undefined;
	/** 目录与 Git 共用的事实变化通知出口（T4）：订阅按 sender + project，事件只标脏。 */
	const remoteFactsEvents = createRemoteFactsHub(ipcChannels.remoteProjectFactsChanged);
	let remoteSftpBinary: Promise<RemoteSftpBinaryIdentity | undefined> | undefined;
	const resolveRemoteSftpBinary = (): Promise<RemoteSftpBinaryIdentity | undefined> => (remoteSftpBinary ??= loadRemoteSftpBinaryIdentity({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }));
	const remoteSftpCapabilityCache = createRemoteSftpCapabilityCache<RemoteSftpProbe>();
	const remoteSftpCapabilityProbe = createRemoteSftpCapabilityProbe();
	const remoteSftpDirectoryReader = createRemoteSftpDirectoryReader({
		binary: resolveRemoteSftpBinary,
		cache: remoteSftpCapabilityCache,
		probe: remoteSftpCapabilityProbe,
	});
	registerRemoteProjectTrustIpc({ enabled: remoteFeatureEnabled, trust: () => remoteProjectTrustService });
	const remoteProjectIpc = registerRemoteProjectIpc({
		enabled: remoteFeatureEnabled,
		userDataDir: app.getPath("userData"),
		service: remoteHostServiceIfEnabled,
		factsEvents: remoteFactsEvents,
		directoryReader: remoteSftpDirectoryReader,
		// 远端项目登记端口（Phase 3 第二段）：canonical 值已由 IPC 层校验/确认，这里只做持久化
		// 与按 projectId 取 locator。只暴露 ssh 项目，本机项目不经过这条入口。
		projects: {
			enroll: async ({ hostId, canonicalRemotePath }) => {
				const project = await projectStore.addRemote({ hostId, canonicalRemotePath });
				return { projectId: project.id };
			},
			locator: (projectId) => {
				const project = projectStore.get(projectId);
				return project && isRemoteProject(project) ? project.locator : undefined;
			},
		},
	});
	remoteProjectFacts = remoteProjectIpc;
	quitCleanup.register("remote-project-ipc", () => remoteProjectIpc.dispose());
	const remoteGitReads = registerRemoteGitReadIpc({
		enabled: remoteFeatureEnabled,
		service: remoteHostServiceIfEnabled,
		factsEvents: remoteFactsEvents,
		// T4：目录与 Git 状态共用同一份工作区事实 owner（缓存实例、generation、失效矩阵都只一份）。
		// Git 写成功/结果未知 → owner 把该仓库 status 与整树一起标脏，只发一条通知。
		workspace: {
			facts: remoteProjectIpc.gitStatusFacts,
			afterGitWrite: remoteProjectIpc.afterGitWrite,
			invalidateStatuses: remoteProjectIpc.invalidateStatuses,
		},
		trusted: async (target) => (await remoteProjectTrustService?.trustOverride({ hostId: target.hostId, remoteRoot: target.remotePath })) === "approve",
		locator: (projectId) => {
			const project = projectStore.get(projectId);
			return project && isRemoteProject(project) ? project.locator : undefined;
		},
	});
	quitCleanup.register("remote-git-reads", remoteGitReads.dispose);
	// T6 收尾：目录页的 Git ignore 修饰接在 Git IPC 之后（仓库归因与能力门控都在那边）。
	remoteProjectIpc.setIgnoreProbe((projectId, paths) => remoteGitReads.probeIgnore(projectId, paths));
	const remoteProjectTextPort = registerRemoteProjectFileIpc({
		enabled: remoteFeatureEnabled,
		service: remoteHostServiceIfEnabled,
		locator: (projectId) => {
			const project = projectStore.get(projectId);
			return project && isRemoteProject(project) ? project.locator : undefined;
		},
		// T4：一次文件写只走一份 owner 的失效矩阵（目录矩阵 + 全部已缓存仓库 status，一条通知）。
		afterWrite: (projectId, paths) => {
			remoteProjectFacts?.afterWrite(projectId, paths);
		},
	});
	const remoteProjectTransfers = registerRemoteProjectTransferJobIpc({
		enabled: remoteFeatureEnabled,
		service: remoteHostServiceIfEnabled,
		locator: (projectId) => {
			const project = projectStore.get(projectId);
			return project && isRemoteProject(project) ? project.locator : undefined;
		},
		binary: resolveRemoteSftpBinary,
		cache: remoteSftpCapabilityCache,
		probe: remoteSftpCapabilityProbe,
		// T4：上传下载完成/结果未知同样走单一 owner（目录 + Git status 一次标脏）。
		afterWrite: (projectId, paths) => {
			remoteProjectFacts?.afterWrite(projectId, paths);
		},
		afterUnknown: (projectId) => {
			remoteProjectIpc.invalidateTree(projectId);
		},
	});
	quitCleanup.register("remote-project-transfer-jobs", remoteProjectTransfers.dispose);
	// 文件管理（Phase 5 文件面）：8 条 new/rename/delete/trash 通道 + 独立 entry 令牌表 + sender 写单飞。
	// 与文本保存 IPC 各自持有令牌表；窗口销毁时两个模块各自撤销自己的表（冻结语义：两类令牌都不可再用）。
	const remoteProjectEntries = registerRemoteProjectEntryIpc({
		enabled: remoteFeatureEnabled,
		service: remoteHostServiceIfEnabled,
		locator: (projectId) => {
			const project = projectStore.get(projectId);
			return project && isRemoteProject(project) ? project.locator : undefined;
		},
		// 写成功后只标脏目录事实与 Git status（T4 单一 owner）：一次写不产生任何远端往返。
		afterWrite: (projectId, paths) => {
			remoteProjectIpc.afterWrite(projectId, paths);
		},
	});
	quitCleanup.register("remote-project-entries", remoteProjectEntries.dispose);
	/**
	 * 远端短命令的统一执行入口（会话读取/写入/归档/扫描四条链共用）：每次重新过 `buildPinnedSshInvocation`
	 * （pin 文件/指纹、路由摘要、严格配置复查）。超时归传输层：`SshClientRuntime.run` 的 execFile 自带
	 * 30 s 上限与 256 KiB 输出上限（远端历史窗口上界 128 KiB 就是为后者留的余量）。
	 *
	 * 定义在装配点之前（而不是就地定义）：会话扫描/登记也走它（R1a），而它们的装配代码在下面靠前的位置。
	 */
	const runPinnedRemoteCommand = async ({ hostId, remoteCommand }: { hostId: string; remoteCommand: string }) => {
		const client = await remoteSshClientIfEnabled();
		const invocation = await buildPinnedSshInvocation(app.getPath("userData"), hostId, "ssh-batch", { client, remoteCommand });
		const result = await client.run(invocation.executable, invocation.args);
		// stderr 也要回传：pi 对未知旗标的抱怨随版本在 stdout 或 stderr（模型目录的降级判据要用它），
		// 丢掉就等于把「不认这个旗标」误判成「远端没有模型」。
		return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr ?? "" };
	};
	/** 同一入口的端口形状：远端会话扫描/根解析/登记用它换掉 helper 会话（不切 host 的活动 root）。 */
	ctx.setRemoteCommandTransport({ runRemoteCommand: runPinnedRemoteCommand });

	// 远端 Session 只读发现与登记（Phase 3 第三段）。通道名由装配注入（与 contentStoreIpc 的 ChannelGroup 同一先例）。
	// 该主机上的 ssh 项目清单（id + 远端根）：项目归属与项目级扫描根**同一个来源**，只收窄一次。
	const remoteProjectCandidates = (hostId: string) => projectStore.list().flatMap((project) => (isRemoteProject(project) && project.locator.hostId === hostId ? [{ id: project.id, remotePath: project.locator.remotePath }] : []));
	registerRemoteSessionIpc({
		enabled: remoteFeatureEnabled,
		service: remoteHostServiceIfEnabled,
		// R1a：扫描 / 根解析 / register / title 走一次性 pinned SSH 短命令（与读/写/归档同一条通道），
		// 不再借 helper 会话 —— 否则每次刷新会话列表都会把用户项目的活动 root 切走再连回来。
		transport: () => ctx.getRemoteCommandTransport(),
		catalog: () => sessionCatalog,
		// 归属必须按**会话所在目录**判定：取该主机上的 ssh 项目作候选，用 pi 的目录编码与会话路径第一段比对。
		// 判不出来（多候选且都没命中）⇒ undefined，由 scanner 以既有稳定码 REMOTE_SESSION_PROJECT_UNRESOLVED
		// fail-closed —— 绝不猜。曾经的写法取「该主机上第一个 ssh 项目」，同主机两个项目时会把会话登记到
		// 错误项目名下。列表刷新与侧栏投影另由 catalog IPC 和 sessionRecordToSummary 负责。
		projectIdForHost: (hostId, remoteSessionId) => matchRemoteSessionProject(remoteProjectCandidates(hostId), remoteSessionId),
		// 项目级扫描根（项目自己的 `.pi/settings.json` 里的 sessionDir）与 `project:` 身份也用这份清单。
		projectCandidates: remoteProjectCandidates,
		channels: { scan: ipcChannels.remoteSessionScan, register: ipcChannels.remoteSessionRegister, title: ipcChannels.remoteSessionTitle },
	});
	// 远端 Pi 模型目录（Phase 5 row 819）：host → ProjectStore 远端项目 → 窄 AgentManager 查找 live remote
	// agentId → 已有 getAvailableModels RPC 一次有界请求。渲染层只能传 hostId；门禁与其它 remote 域同源。
	const remotePiModelProbe = createRemotePiModelProbe({
		projectIdsForHost: (hostId) => projectStore.list().flatMap((project) => (isRemoteProject(project) && project.locator.hostId === hostId ? [project.id] : [])),
		findLiveAgentId: (projectIds) => agentManager?.findLiveRemoteAgentId(projectIds),
		getAvailableModels: (agentId) => agentManager.getAvailableModels(agentId),
	});
	registerRemotePiModelIpc({ enabled: remoteFeatureEnabled, probe: remotePiModelProbe });
	return {
		getRemoteHostService: () => remoteHostService,
		remoteFeatureEnabled,
		remoteGitReads,
		remoteHostServiceIfEnabled,
		remoteProjectEntries,
		remoteProjectIpc,
		remoteProjectTextPort,
		remoteProjectTransfers,
		runPinnedRemoteCommand,
	};
}
