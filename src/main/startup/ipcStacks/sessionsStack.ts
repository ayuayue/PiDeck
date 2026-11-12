import type { BrowserWindow } from "electron";
import type { ImageSessionStore } from "../../imagegen/ImageSessionStore";
import type { VideoSessionStore } from "../../videogen/VideoSessionStore";
import type { AcpAgentManager } from "../../acp/AcpAgentManager";
import type { AgentProfileStore } from "../../agents/AgentProfileStore";
import type { DshAgentManager } from "../../dsh/DshAgentManager";
import type { DshHost } from "../../dsh/DshHost";
import type { DshPluginInstallService } from "../../dsh/DshPluginInstallService";
import type { DshRuntimeInstaller } from "../../dsh/runtime/DshRuntimeInstaller";
import type { DshRuntimeStatusService } from "../../dsh/runtime/DshRuntimeStatus";
import type { DshForeignSyncDeps } from "../../dsh/dshForeignSync";
import type { createDshSessionSkillLoader } from "../../dsh/dshSessionSkillLoader";
import { importForeignSession } from "../../dsh/dshForeignSync";
import { registerSessionIpc } from "../../ipc/sessionIpc";
import type { SessionIndexService } from "../../sessions/SessionIndexService";
import type { SessionScanner } from "../../sessions/SessionScanner";
import type { SshSessionLocator } from "../../../shared/projectLocation";
import type { RemoteSessionArchive } from "../../remote/RemoteSessionArchive";
import type { RemoteSessionDelete } from "../../remote/RemoteSessionDelete";
import type { SessionSearchResult } from "../../../shared/types/session";

type SessionIpcDeps = Parameters<typeof registerSessionIpc>[0];

/**
 * sessions 域 IPC 装配（自 index.ts 的 registerIpc 逐段外移，行为零变化）。
 *
 * ctx 只承载该段真正用到的实例与闭包：模块级单例按值传入（均在 registerIpc 之前完成单次赋值，
 * 读的是同一实例）；会在启动后续被替换的绑定（mainWindow / sessionIndexService / dshRuntime*）
 * 走 getter，保证闭包里读到的是当前值。调用顺序与搬迁前完全一致。
 */
// `emitLiveSnapshot` 由本段就地组合（pi / DSH 各发一次），其余 deps 一律由 ctx 提供。
export interface SessionsStackContext extends Omit<SessionIpcDeps, "emitLiveSnapshot"> {
	readonly acpAgentManager: AcpAgentManager;
	readonly agentProfileStore: AgentProfileStore | null;
	readonly dshAgentManager: DshAgentManager;
	readonly dshHost: DshHost;
	readonly dshRuntimeErrorCopy: (error: string) => string;
	readonly foreignSyncDeps: DshForeignSyncDeps;
	readonly getDshPluginInstallService: () => DshPluginInstallService | undefined;
	readonly getDshRuntimeInstaller: () => DshRuntimeInstaller;
	readonly getDshRuntimeStatus: () => DshRuntimeStatusService;
	readonly getDshSessionSkillLoader: () => ReturnType<typeof createDshSessionSkillLoader>;
	readonly getMainWindow: () => BrowserWindow | null;
	readonly getSessionIndexService: () => SessionIndexService | null;
	readonly imageSessionStore: ImageSessionStore;
	readonly mainCopy: SessionIpcDeps["mainCopy"];
	readonly notifyCatalogRefreshed: (projectIds: Iterable<string>) => void;
	readonly projectPathsForContentSearch: () => string[];
	readonly remoteSessionArchive: RemoteSessionArchive | undefined;
	readonly remoteSessionDelete: RemoteSessionDelete | undefined;
	readonly runDshForeignSync: () => Promise<{ imported: number; skipped: number }>;
	readonly sessionMessageSearchInFile: (sessionPath: string, query: string) => Promise<SessionSearchResult | null>;
	readonly startDshHostAfterRuntimeDiskOperation: (wasRunning: boolean) => Promise<void>;
	readonly stopDshHostForRuntimeDiskOperation: () => Promise<boolean>;
	readonly stopDshHostManually: () => Promise<boolean>;
	readonly startDshHostManually: () => Promise<boolean>;
	readonly videoSessionStore: VideoSessionStore;
	readonly wslSessionScannerFor: (identity: { distro: string; user: string }) => Promise<SessionScanner>;
}

export function registerSessionsStack(ctx: SessionsStackContext): void {
	const {
		acpAgentManager,
		agentManager,
		agentProfileStore,
		appLogger,
		claudeSessionImporter,
		codebuddySessionImporter,
		codexSessionImporter,
		configManager,
		copyCatalogSession,
		createAnonymousSession,
		cursorSessionImporter,
		directorySessionImporter,
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
		getDshPluginInstallService,
		getDshRuntimeInstaller,
		getDshRuntimeStatus,
		getDshSessionSkillLoader,
		getMainWindow,
		getSessionIndexService,
		dshAgentManager,
		imageSessionStore,
		mainCopy,
		kimiSessionImporter,
		kimiWorkSessionImporter,
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
		runDshForeignSync,
		sessionCatalog,
		sessionForkCommands,
		sessionMessageSearchInFile,
		sessionRuntimeCoordinator,
		sessionScanner,
		settingsStore,
		startDshHostAfterRuntimeDiskOperation,
		stopDshHostForRuntimeDiskOperation,
		stopSessionRuntime,
		terminalManager,
		validationCatalogModels,
		videoSessionStore,
		visibleSessions,
		workbuddySessionImporter,
		wslSessionScannerFor,
		zcodeSessionImporter,
	} = ctx;

	registerSessionIpc({
		projectStore,
		settingsStore,
		sessionScanner,
		resolveWslSessionScanner: (identity) => wslSessionScannerFor(identity),
		sessionCatalog,
		// 会话 ↔ 智能体绑定：绑定的会话每次发送注入角色设定（pi/acp 隐藏 agentMessage，
		// dsh 退化为可见前缀，由 sessionIpc 的 composeAgentInstruction 统一组合）。
		resolveSessionAgentInstruction: (sessionId) => agentProfileStore?.getBoundAgent(sessionId)?.systemPrompt,
		sessionRuntimeCoordinator,
		agentManager,
		configManager,
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
		appLogger,
		terminalManager,
		mainCopy: mainCopy as (key: string, params?: Record<string, string | number>) => string,
		getMainWindow,
		visibleSessions,
		// live 补帧按 agentId 路由：pi 与 DSH 各有自己的流式缓冲，未知 id 各自 no-op。
		emitLiveSnapshot: (agentId) => {
			agentManager.emitLiveSnapshot(agentId);
			dshAgentManager.emitLiveSnapshot(agentId);
		},
		emitSessionRuntimeEvent,
		emitSessionRuntimeDetach,
		emitSessionActivating,
		emitSessionActivationFailed,
		emitSessionActivationCancelled,
		createAnonymousSession,
		stopSessionRuntime,
		emitReplacementState,
		readCatalogSessionReferenceMessages,
		// 无 pi 会话文件（纯生图草稿）历史读取回退：ImageSession 独立存储
		readImageSessionMessages: (sessionId) => imageSessionStore.readMessages(sessionId),
		readRemoteSessionHistoryPage,
		// videogen 后端会话历史回退：VideoSession 独立存储（同生图策略）
		readVideoSessionMessages: (sessionId) => videoSessionStore.readMessages(sessionId),
		copyCatalogSession,
		exportCatalogSessionHtml,
		exportRemoteCatalogSessionHtml,
		archiveRemoteSession: remoteSessionArchive ? (input: { hostId: string; locator: SshSessionLocator }) => remoteSessionArchive.moveIntoArchive(input) : undefined,
		unarchiveRemoteSession: remoteSessionArchive
			? async (input: { hostId: string; originalPath: string; archivedPath: string }) => {
					await remoteSessionArchive.moveBack(input);
				}
			: undefined,
		deleteArchivedRemoteSession: remoteSessionDelete ? (input: { hostId: string; archivedPath: string }) => remoteSessionDelete.deleteArchived(input) : undefined,
		replaceAgentSession,
		// 模型存在性校验数据源：与模型选择器同源（capability 快照 ∪ CLI 缓存），否则
		// auth 渠道模型被判为不存在并静默换成配置默认模型（issue #340）。
		validationCatalogModels,
		// fork/clone 统一命令层：重发/编辑 fork 化（mutationFork/branchMode）与 Web HTTP 同源
		sessionForkCommands,
		// 跨会话正文搜索适配闭包：roots 解析（全局根 + 全局 settings sessionDir + 各项目
		// 项目级 sessionDir）+ sidecar 调用；搜索前先增量 refresh（stat 全目录毫秒级）保证
		// 新会话可搜；任何失败返回 null，渲染层回退标题过滤，搜索入口永不报错。未就绪
		// （冷启动首建索引/预热中）直接降级，不把渲染层请求挂到 boot 结束（首建可达数十秒）；
		// refresh 失败但进程仍活着时继续用现有索引搜一次（transient 失败不该让本次搜索静默无内容）。
		sessionContentSearch: async (query) => {
			const sessionIndexService = getSessionIndexService();
			if (!sessionIndexService) return null;
			const roots = await sessionScanner.resolveContentSearchRoots(projectPathsForContentSearch());
			if (roots.length === 0) return null;
			if (!sessionIndexService.isReady(roots)) {
				// 本次降级标题过滤，但后台必须有人建索引：首次安装/roots 刚变更时
				// 没有别处会预热，否则内容搜索会一直空着（就绪后下一次输入自然生效）
				sessionIndexService.warmup(roots);
				return null;
			}
			const refreshed = await sessionIndexService.refresh(roots);
			if (!refreshed.ok && !sessionIndexService.isReady(roots)) return null;
			const result = await sessionIndexService.search(roots, query);
			return result.ok ? result.value : null;
		},
		// 会话内查找（Ctrl+Shift+F / 会话头部放大镜）：只扫一个会话文件、命中按时间线
		// 返回。降级口径收口在 sessionMessageSearchInFile（与 Web 搜索弹层共用）。
		sessionMessageSearch: async (sessionPath, query) => {
			return sessionMessageSearchInFile(sessionPath, query);
		},
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
			getDshRuntimeStatus: () => getDshRuntimeStatus().getStatus(),
			canCreateDshSession: () => getDshRuntimeStatus().canCreateDshSession(),
			// 安装/导入/卸载后必须重探测并广播：否则 UI 还停在旧状态，
			// 用户会看到「刚装完但仍提示未安装」。
			installDshRuntime: async () => {
				// 同版本重装时 host 可能仍持有 runtime 内 .node 原生模块的 DLL 句柄，
				// 落位 rm 必报 EPERM：与卸载同一套路，先停会话 + dispose host 释放锁。
				const wasRunning = await stopDshHostForRuntimeDiskOperation();
				const result = await getDshRuntimeInstaller().installFromIndex();
				getDshRuntimeStatus().refresh();
				if (result.ok) await startDshHostAfterRuntimeDiskOperation(wasRunning);
				// 与手动导入同一套文案映射：在线安装的失败原因（尤其是「发布源没有
				// 配套版本」）必须可读，否则用户只会看到「点了安装没反应」。
				if (!result.ok) return { ok: false, error: dshRuntimeErrorCopy(result.error) };
				return result;
			},
			importDshRuntime: async (filePath: string) => {
				const wasRunning = await stopDshHostForRuntimeDiskOperation();
				const result = await getDshRuntimeInstaller().installFromLocalFile(filePath);
				getDshRuntimeStatus().refresh();
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
				const result = await getDshRuntimeInstaller().uninstall();
				getDshRuntimeStatus().refresh();
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
			stopDshHost: () => ctx.stopDshHostManually(),
			startDshHost: () => ctx.startDshHostManually(),
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
			// 打开 DSH 历史会话时补录 catalog 模型（host 投影冷读，不激活）：catalog 缺 model
			// 时底栏会回退全局部署默认，看起来像「别的会话的模型也被改了」。
			readDshSessionModel: (dshSessionId) => dshAgentManager.readSessionModelSelection(dshSessionId),
			// ACP 异步读口：runtime 投影 → 内存快照 → 磁盘归档逐级回退（sessionIpc 的
			// readAcpMessages 依赖已按 Promise 契约声明）。归档读失败内部降级空数组。
			readAcpMessages: (acpSessionId) => acpAgentManager.readMessagesWithArchive(acpSessionId),
			readDshProcessEvents: (agentId, dshSessionId) => dshAgentManager.readProcessEvents(agentId, dshSessionId),
			readSessionFacts: (sessionPath) => agentManager.readSessionFacts(sessionPath),
			readSessionOutline: (sessionPath, limit) => agentManager.readSessionOutline(sessionPath, limit),
			readDshMessageFullText: (agentId, messageId) => dshAgentManager.readMessageFullText(agentId, messageId),
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
			// 会话内查找（Ctrl/Cmd+Shift+F）的 DSH 分支：DSH 会话没有 pi JSONL，
			// 由 DshAgentManager 把 host 历史投影成消息后做词元匹配（与 pi 的 Go sidecar 同语义）。
			searchDshSessionMessages: (dshSessionId, query) => dshAgentManager.searchSessionMessages(dshSessionId, query),
			createDshGoal: (agentId, objective, maxGoalRounds) => dshAgentManager.createGoal(agentId, objective, maxGoalRounds),
			runDshGoalAction: (agentId, action) => dshAgentManager.goalAction(agentId, action),
			cancelDshQueuedMessage: (agentId, itemId) => dshAgentManager.cancelQueuedMessage(agentId, itemId),
			listDshSubagents: (agentId) => dshAgentManager.listSubagents(agentId),
			listDshSkills: (agentId) => dshAgentManager.listSkills(agentId),
			// 草稿 DSH 会话：会话启动前读技能目录（懒建/复用 host 会话，不启动 agent）。
			listDshSessionSkills: (sessionId) => getDshSessionSkillLoader()(sessionId),
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
				notifyCatalogRefreshed([record.projectId]);
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
				const dshPluginInstallService = getDshPluginInstallService();
				if (!dshPluginInstallService) throw new Error("DSH plugin install service is not available");
				return dshPluginInstallService.searchPlugins(keyword);
			},
			installDshUserPlugin: (spec) => {
				const dshPluginInstallService = getDshPluginInstallService();
				if (!dshPluginInstallService) throw new Error("DSH plugin install service is not available");
				return dshPluginInstallService.installUserPlugin(spec);
			},
			listDshUserPlugins: () => {
				const dshPluginInstallService = getDshPluginInstallService();
				if (!dshPluginInstallService) return Promise.resolve([]);
				return dshPluginInstallService.listUserPlugins();
			},
			installDshPlugin: (input) => dshHost.installDynamicPlugin(input),
			runDshPlugin: (input) => dshHost.runDynamicPlugin(input),
			stopDshPlugin: (input) => dshHost.stopDynamicPlugin(input),
			uninstallDshPlugin: (input) => dshHost.uninstallDynamicPlugin(input),
			isDshAgent: (agentId) => dshAgentManager?.list().some((tab) => tab.id === agentId) === true,
			// fork/clone 已收口 sessionForkCommands（桌面/Web 共用），这里不再单独提供
		},
	});
}
