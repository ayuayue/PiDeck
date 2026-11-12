import { app, ipcMain, protocol } from "electron";
import type { BrowserWindow } from "electron";
import { join } from "node:path";
import { registerSessionShareExportIpc } from "../../ipc/sessionShareExportIpc";
import { SessionShareExportService } from "../../sessions/SessionShareExportService";
import { createSessionShareSourceLoader } from "../../sessions/sessionShareSource";
import { createPiSessionShareReader } from "../../pi/piSessionShareReader";
import type { SshSessionLocator } from "../../../shared/projectLocation";
import { isRemoteProject } from "../../../shared/projectLocation";
import { ipcChannels } from "../../../shared/ipc";
import type { MainProcessTranslationKey } from "../../../shared/i18n/mainProcessCopy";
import type { ProjectStore } from "../../projects/ProjectStore";
import type { AgentManager } from "../../pi/AgentManager";
import { isDefaultAgentTitle } from "../../pi/agentUtils";
import type { DshAgentManager } from "../../dsh/DshAgentManager";
import type { SessionCatalog } from "../../sessions/SessionCatalog";
import type { RemoteHostConnectionService } from "../../remote/RemoteHostConnectionService";
import { REMOTE_MODEL_CATALOG_CODES, createRemoteModelCatalog } from "../../remote/RemotePiModelCatalog";
import { createRemoteSessionHistoryReader } from "../../remote/RemoteSessionHistoryReader";
import { createRemoteSessionArchive } from "../../remote/RemoteSessionArchive";
import { createRemoteSessionDelete } from "../../remote/RemoteSessionDelete";
import { createRemoteSessionHistoryWriter } from "../../remote/RemoteSessionHistoryWriter";
import type { RemoteSessionMessageMutationPort } from "../../remote/RemoteSessionHistoryWriter";
import { REMOTE_SESSION_EXPORT_LIMITS, exportRemoteSessionHtml } from "../../remote/RemoteSessionHtmlExport";
import { createRemoteSessionScanner } from "../../sessions/RemoteSessionScanner";
import type { RemoteSessionCommandTransportPort } from "../../sessions/RemoteSessionScanner";
import { registerVideoGenIpc } from "../../ipc/videogenIpc";
import { VideoGenConfigStore } from "../../videogen/VideoGenConfigStore";
import { VideoBlobStore } from "../../videogen/VideoBlobStore";
import { VideoSessionStore } from "../../videogen/VideoSessionStore";
import { VideoJobStore } from "../../videogen/VideoJobStore";
import { VideoJobRunner } from "../../videogen/VideoJobRunner";
import { registerVideoGenProtocol } from "../../videogen/VideoGenProtocol";
import type { VideoGenJobSnapshot } from "../../../shared/types/videogen";
import type { AppLogger } from "../../logging/AppLogger";
import type { SessionMessagePage } from "../../../shared/types/session";
import type { RemoteModelCatalog } from "../../remote/RemotePiModelCatalog";
import type { RemoteSessionArchive } from "../../remote/RemoteSessionArchive";
import type { RemoteSessionDelete } from "../../remote/RemoteSessionDelete";

/**
 * mediaSession 域 IPC 装配（自 index.ts 的 registerIpc 逐段外移，行为零变化）。
 *
 * ctx 只承载该段真正用到的实例与闭包：模块级单例按值传入（均在 registerIpc 之前完成单次赋值，
 * 读的是同一实例）；少数会在启动后续被替换的绑定（mainWindow / petSystem / tray）走 getter，
 * 保证闭包里读到的是当前值。调用顺序与搬迁前完全一致。
 */
export interface MediaSessionStackContext {
	readonly agentManager: AgentManager;
	readonly appLogger: AppLogger;
	readonly dshAgentManager: DshAgentManager;
	readonly mainCopy: (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;
	readonly getMainWindow: () => BrowserWindow | null;
	readonly projectStore: ProjectStore;
	readonly remoteCommandTransport: RemoteSessionCommandTransportPort | undefined;
	readonly setRemoteSessionMessageMutation: (value: RemoteSessionMessageMutationPort | undefined) => void;
	readonly resolveSessionExportDir: () => string;
	readonly resolveVideoGenStorageRoots: () => { sessions: string; blobs: string; jobs: string };
	readonly sessionCatalog: SessionCatalog;
	readonly remoteFeatureEnabled: boolean;
	readonly remoteHostServiceIfEnabled: () => Promise<import("../../remote/RemoteHostConnectionService").RemoteHostConnectionService> | undefined;
	readonly runPinnedRemoteCommand: ({ hostId, remoteCommand }: { hostId: string; remoteCommand: string }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface MediaSessionStackResult {
	readonly readRemoteSessionHistoryPage: ((input: { hostId: string; locator: SshSessionLocator; before?: number }) => Promise<SessionMessagePage>) | undefined;
	readonly remotePiModelCatalog: RemoteModelCatalog | undefined;
	readonly remoteModelCatalogForProject: ((projectId: string, sessionId: string, force: boolean) => Promise<import("../../../shared/types").ModelListReport | null>) | undefined;
	readonly exportRemoteCatalogSessionHtml: ((sessionId: string) => Promise<Record<string, unknown> & { path: string }>) | undefined;
	readonly remoteSessionArchive: RemoteSessionArchive | undefined;
	readonly remoteSessionDelete: RemoteSessionDelete | undefined;
	readonly videoSessionStore: VideoSessionStore;
}

export function registerMediaSessionStack(ctx: MediaSessionStackContext): MediaSessionStackResult {
	const { agentManager, appLogger, dshAgentManager, mainCopy, projectStore, remoteCommandTransport, resolveSessionExportDir, resolveVideoGenStorageRoots, sessionCatalog, remoteFeatureEnabled, remoteHostServiceIfEnabled, runPinnedRemoteCommand } = ctx;

	/**
	 * 远端会话根判定（远端读取与远端归档共用）：走**与扫描/登记同一份**实现。
	 * pi 的 user-level `settings.json` 可以把会话根换掉，各自再拼一次 `<home>/.pi/agent/sessions` 就会在
	 * 那些机器上读/写错文件（那是「读到了别人的历史」级别的问题，不是少一点）。
	 */
	const resolveRemoteSessionRoot = async (hostId: string): Promise<{ ok: true; root: string } | { ok: false; code: string }> => {
		const port = await remoteHostServiceIfEnabled();
		if (port === undefined) return { ok: false, code: "REMOTE_CONNECTION_SERVICE_UNAVAILABLE" };
		return await createRemoteSessionScanner({ port, catalog: sessionCatalog, transport: remoteCommandTransport }).resolveSessionRoot(hostId);
	};

	/**
	 * 远端会话历史的有界窗口读取（Phase 4 远端历史）。
	 *
	 * 传输是既有 **pinned SSH 短命令**：每次读取都重新过 `buildPinnedSshInvocation`（pin 文件/指纹、路由
	 * 摘要、严格配置复查），命令里只有窗口上界与已校验的绝对路径——没有 helper op、没有第二条控制通道。
	 * 实验开关关掉时端口不装配：ssh locator 记录会得到稳定码 `REMOTE_SESSION_HISTORY_UNAVAILABLE`，
	 * 而不是落回本机路径读出一个空页。
	 *
	 * 相对身份（扫描登记时 `remotePath` 就是相对会话根路径）走**与扫描/登记同一份**会话根判定：
	 * pi 的 user-level `settings.json` 可以把会话根换掉，这里再拼一次 `<home>/.pi/agent/sessions` 就会在
	 * 那些机器上读错文件。
	 */
	const readRemoteSessionHistoryPage = remoteFeatureEnabled
		? async (input: { hostId: string; locator: SshSessionLocator; before?: number }) => {
				const reader = createRemoteSessionHistoryReader({
					transport: { readRemoteWindow: runPinnedRemoteCommand },
					resolveSessionRoot: resolveRemoteSessionRoot,
					project: (rawMessages, activeEntryIds) => agentManager.projectRemoteHistoryMessages(rawMessages, activeEntryIds),
					logger: { warn: (message, details) => appLogger.warn("session", message, details) },
				});
				return await reader.readPage(input);
			}
		: undefined;

	/**
	 * 远端主机上的 pi 模型目录（与本机 `pi --list-models` 逐字对称）。
	 *
	 * 为什么不是「问运行中的远端 pi 进程」：那样会话没激活就没有目录（用户必须先盲发一条消息），
	 * 而且目录会随 runtime 重启/空闲回收一起消失。这里就是「远端算好、传回来、缓存住」：
	 * 同一条 pinned SSH 短命令跑一次 `pi --list-models`，本机同一个纯函数解析，按主机缓存。
	 */
	const remotePiModelCatalog = remoteFeatureEnabled
		? createRemoteModelCatalog({
				resolveFacts: async (hostId: string) => {
					const port = await remoteHostServiceIfEnabled();
					if (!port) throw new Error("REMOTE_CONNECTION_SERVICE_UNAVAILABLE");
					const facts = await port.remotePiRuntimeFacts(hostId);
					return { piPath: facts.piPath, nodePath: facts.nodePath };
				},
				run: runPinnedRemoteCommand,
			})
		: undefined;

	/**
	 * 按项目取远端模型目录：非远端项目返回 null（调用方据此走本机目录）。
	 * 失败返回失败报告而不是空成功报告——空列表和「拿不到」在 UI 上必须是两种状态。
	 */
	const remoteModelCatalogForProject = remotePiModelCatalog
		? async (projectId: string, sessionId: string, force: boolean): Promise<import("../../../shared/types").ModelListReport | null> => {
				// 位置真相优先取**会话自己的 locator**（host rebind 会改写它），项目 locator 只做兜底——
				// 两者错位时按项目取值会让选择器给出另一台主机的模型。
				const sessionLocator = sessionId.length > 0 ? sessionCatalog.getLocator(sessionId) : undefined;
				const project = projectStore.get(projectId);
				const projectLocator = project !== undefined && isRemoteProject(project) ? project.locator : undefined;
				const locator = sessionLocator?.kind === "ssh" ? { hostId: sessionLocator.hostId } : projectLocator;
				if (locator === undefined) return null;
				const result = await remotePiModelCatalog.load({ hostId: locator.hostId, force });
				// 两种失败在 UI 上是两条不同的引导：空目录 = 去远端配置页加 provider；
				// 命令失败 = 查远端 pi / 连接。压成一个码会让「空」的引导永远不可达。
				if (!result.ok) return { models: [], ok: false, reason: result.code === REMOTE_MODEL_CATALOG_CODES.empty ? "empty" : "cli-failed", version: null, detail: result.code, source: "none", at: Date.now() };
				return { models: result.models, ok: true, reason: null, version: null, detail: "", source: "remote", at: Date.now() };
			}
		: undefined;

	/**
	 * 远端会话的 HTML 导出（**只读远端 + 本机写文件**）。
	 *
	 * 与 `readRemoteSessionHistoryPage` 同一个读端口、同一个实验开关：开关关掉时这条链整体不装配，
	 * ssh 记录的导出因此得到稳定码 `REMOTE_SESSION_EXPORT_UNAVAILABLE`，而不是落回本机导出（本机导出
	 * 需要本机会话文件 + 一个临时本机 pi 进程，对远端记录两样都不成立）。
	 *
	 * 上游 `sessions:catalog-export-html` 必须在 `getLocalFilePath` 守卫**之前**分流到本函数：那个守卫对
	 * ssh locator 抛 UNSUPPORTED_PROJECT_LOCATION，先调它则远端导出一律失败。
	 */
	const exportRemoteCatalogSessionHtml = readRemoteSessionHistoryPage
		? async (sessionId: string): Promise<Record<string, unknown> & { path: string }> => {
				const entry = sessionCatalog.get(sessionId);
				const locator = sessionCatalog.getLocator(sessionId);
				// 走到这里却没有 ssh locator（记录被并发删掉/换位置）= 稳定码，不猜路径。
				if (!entry || locator?.kind !== "ssh") throw new Error(mainCopy("session.notFound"));
				return await exportRemoteSessionHtml({
					sessionId,
					title: entry.title,
					hostId: locator.hostId,
					locator,
					readPage: readRemoteSessionHistoryPage,
					resolveExportDir: resolveSessionExportDir,
					copy: {
						footer: mainCopy("session.exportRemoteFooter"),
						partialNotice: mainCopy("session.exportRemotePartialNotice", { pages: REMOTE_SESSION_EXPORT_LIMITS.maxPages, messages: REMOTE_SESSION_EXPORT_LIMITS.maxMessages }),
					},
					logger: {
						info: (message, details) => {
							void appLogger.info("session", message, details);
						},
						warn: (message, details) => {
							void appLogger.warn("session", message, details);
						},
					},
				});
			}
		: undefined;

	/**
	 * 远端会话归档 / 取消归档（P4.5b）：把远端会话文件 `mv` 进 / 出**它自己所在目录旁的** `.pideck-archive/`。
	 *
	 * 与远端历史读同一条 pinned SSH 短命令通道（同一 pin/指纹/路由校验、同一会话根判定），零新增 helper op；
	 * 实验开关关掉时端口不装配（`remoteSessionArchive === undefined`）⇒ 远端归档分支得到稳定码
	 * `REMOTE_SESSION_ARCHIVE_UNAVAILABLE`，而不是落回本机路径分支。
	 * 本机侧的归档索引与 catalog 记录由 sessionIpc 的远端分支负责（这里只管远端文件）。
	 */
	const remoteSessionArchive = remoteFeatureEnabled
		? createRemoteSessionArchive({
				transport: { runRemoteCommand: runPinnedRemoteCommand },
				resolveSessionRoot: resolveRemoteSessionRoot,
			})
		: undefined;

	/**
	 * 远端归档会话永久删除（Phase 5）：pinned SSH 上的固定 Node 脚本，只 unlink 本机归档索引指向的
	 * 那一个 .pideck-archive/*.jsonl（脚本内做 canonical containment + 身份复核）。远端 Node 路径与
	 * 写入守卫同源（remotePiRuntimeFacts），不新增 helper op；实验开关关掉时不装配 ⇒ 请求得到
	 * REMOTE_SESSION_DELETE_UNAVAILABLE（fail closed，绝不落回本机路径）。
	 */
	const remoteSessionDelete = remoteFeatureEnabled
		? createRemoteSessionDelete({
				transport: { runRemoteCommand: runPinnedRemoteCommand },
				resolveNodePath: async (hostId) => {
					const port = await remoteHostServiceIfEnabled();
					if (!port) throw new Error("REMOTE_CONNECTION_SERVICE_UNAVAILABLE");
					return (await port.remotePiRuntimeFacts(hostId)).nodePath;
				},
			})
		: undefined;

	/**
	 * 远端会话的**受控改写**（P4.5c）：编辑消息 / 删除消息（写墓碑）/ 准备重发（截断该消息及其后继）。
	 *
	 * 与远端历史读、远端归档**同一条** pinned SSH 短命令通道（同一 `runPinnedRemoteCommand`：每次都
	 * 重新过 pin/指纹/路由摘要/严格配置，同一 `resolveRemoteSessionRoot`：会话根只有一个来源），
	 * 零新增 helper op。实验开关关掉时端口不装配 ⇒ 协调器的 ssh 分支得到稳定码
	 * `REMOTE_SESSION_HISTORY_WRITER_UNAVAILABLE`，而**不会**落回本机路径分支（本机路径入口对 ssh
	 * locator 抛稳定码，落回只会得到“本地文件缺失”这种错误原因）。
	 */
	ctx.setRemoteSessionMessageMutation(
		remoteFeatureEnabled
			? createRemoteSessionHistoryWriter({
					transport: { runRemoteCommand: runPinnedRemoteCommand },
					resolveSessionRoot: resolveRemoteSessionRoot,
					resolveNodePath: async (hostId) => {
						const port = await remoteHostServiceIfEnabled();
						if (!port) throw new Error("REMOTE_CONNECTION_SERVICE_UNAVAILABLE");
						return (await port.remotePiRuntimeFacts(hostId)).nodePath;
					},
					project: (rawMessages, activeEntryIds) => agentManager.projectRemoteHistoryMessages(rawMessages, activeEntryIds),
				})
			: undefined,
	);

	// ── 生视频域：与生图平行的独立信任域（userData/videogen.json），异步任务生命周期在 VideoJobRunner ──
	const videoGenConfigStore = new VideoGenConfigStore({
		getConfigPath: () => join(app.getPath("userData"), "videogen.json"),
		log: (message, ...args) => appLogger.info("videogen", message, ...args),
	});
	const videoGenRoots = resolveVideoGenStorageRoots();
	const videoBlobStore = new VideoBlobStore({ getBlobsPath: () => videoGenRoots.blobs });
	void videoBlobStore.ensureDir();
	const videoSessionStore = new VideoSessionStore({
		getStorePath: () => videoGenRoots.sessions,
		blobs: videoBlobStore,
	});
	const videoJobStore = new VideoJobStore({
		getJobsPath: () => videoGenRoots.jobs,
		log: (message, ...args) => appLogger.info("videogen", message, ...args),
	});
	// pideck-video:// 必须在 app ready 后注册；视频产物只经协议流式吐给 <video>，不进 IPC
	registerVideoGenProtocol(videoBlobStore);
	const sendVideoGenEvent = (snapshot: VideoGenJobSnapshot) => {
		const window = ctx.getMainWindow();
		if (window && !window.isDestroyed()) {
			window.webContents.send(ipcChannels.videogenEvent, snapshot);
		}
	};
	const videoJobRunner = new VideoJobRunner({
		loadJobs: () => videoJobStore.load(),
		saveJobs: (jobs) => videoJobStore.save(jobs),
		getCredentials: async (providerId) => {
			const creds = await videoGenConfigStore.getCredentials(providerId);
			if (!creds) return null;
			return { baseUrl: creds.baseUrl, apiKey: creds.apiKey, protocol: creds.protocol, name: creds.provider.name };
		},
		putVideo: (response) => videoBlobStore.putFromResponse(response),
		persistMessages: (sessionId, messages) => videoSessionStore.append(sessionId, messages),
		emit: sendVideoGenEvent,
		log: (message, ...args) => appLogger.info("videogen", message, ...args),
	});
	registerVideoGenIpc({
		submit: async (request) => {
			const result = await videoJobRunner.submit(request);
			// 与生图同策略：任务受理即把会话提升为 active + 首行命名，防 staleDrafts 清理丢入口
			if (result.ok && request.sessionId) {
				const entry = sessionCatalog?.get(request.sessionId);
				if (entry) {
					const project = projectStore.get(entry.projectId);
					if (project && isDefaultAgentTitle(entry.title, project, mainCopy as never)) {
						const firstLine = request.prompt.split(/\r?\n/, 1)[0]?.trim() ?? "";
						if (firstLine) {
							await sessionCatalog.applyAutomaticTitle(request.sessionId, firstLine, "fallback");
							ctx.getMainWindow()?.webContents.send(ipcChannels.sessionsCatalogRefreshed, { projectId: entry.projectId });
						}
					}
					await sessionCatalog.promoteToActive(request.sessionId);
				}
			}
			return result;
		},
		cancel: (jobId) => videoJobRunner.cancel(jobId),
		getConfig: () => videoGenConfigStore.getConfig(),
		saveConfig: (input) => videoGenConfigStore.saveConfig(input),
		listJobs: (sessionId) => videoJobRunner.listJobsForSession(sessionId),
		log: (message, ...args) => appLogger.info("videogen", message, ...args),
	});
	// 重启恢复：24h 窗口内未终态的任务继续轮询（终态立即结清旧任务）
	void videoJobRunner.resume();

	registerSessionShareExportIpc(
		ipcMain,
		new SessionShareExportService({
			load: createSessionShareSourceLoader({ catalog: sessionCatalog, projects: projectStore, pi: createPiSessionShareReader(mainCopy), dsh: dshAgentManager }),
			resolveExportDir: resolveSessionExportDir,
			home: () => app.getPath("home"),
			copy: () => ({ footer: mainCopy("sessionShare.footer"), partialNotice: mainCopy("sessionShare.partialNotice"), warning: mainCopy("sessionShare.warning") }),
		}),
	);
	return { readRemoteSessionHistoryPage, remotePiModelCatalog, remoteModelCatalogForProject, exportRemoteCatalogSessionHtml, remoteSessionArchive, remoteSessionDelete, videoSessionStore };
}
