import { app, shell, type BrowserWindow } from "electron";
import { join } from "node:path";
import { ipcChannels } from "../../shared/ipc";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import { DshAgentManager } from "../dsh/DshAgentManager";
import { DshHost } from "../dsh/DshHost";
import { DshPluginInstallService } from "../dsh/DshPluginInstallService";
import type { DshRuntimeStatusService } from "../dsh/runtime/DshRuntimeStatus";
import type { AppLogger } from "../logging/AppLogger";
import { RpcLogLiveBroadcaster } from "../logging/RpcLogLiveBroadcaster";
import type { RpcLogger } from "../logging/RpcLogger";
import { notifyAskPending as notifyAgentAskPending, type AgentToastDeps } from "../notifications/agentToast";
import type { PiLocator } from "../pi/PiLocator";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SessionCatalog } from "../sessions/SessionCatalog";
import { aggregateDshProxyMode, buildHostProxyEnvPatch, resolveDshHostProxyMode, resolveEffectiveSessionProxyMode } from "../sessions/sessionProxyPolicy";
import type { SettingsStore } from "../settings/SettingsStore";

/**
 * DSH 后端装配（自 index.ts 的 whenReady 装配体就地外移，行为零变化）：
 * DshHost → 插件安装服务 → 实时 RPC 日志广播器 → DshAgentManager。
 *
 * `assign` 只回填本文件里的模块级槽位（dshHost / dshPluginInstallService / dshAgentManager /
 * rpcLogLiveBroadcaster），后续所有调用方继续读同一份实例。退出清理登记留在 index.ts：
 * runAll 的执行次序即登记位置（见 tests/beforeQuitCleanupAwait.test.mjs、tests/rpcLogViewer.test.mjs）。
 */
export interface DshAgentsContext {
	readonly agentToastDeps: () => AgentToastDeps;
	readonly appLogger: AppLogger;
	readonly getDshRuntimeStatus: () => DshRuntimeStatusService;
	readonly getMainWindow: () => BrowserWindow | null;
	readonly getSessionCatalog: () => SessionCatalog;
	readonly mainCopy: (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;
	readonly piLocator: PiLocator;
	readonly projectStore: ProjectStore;
	readonly resolveSessionExportDir: () => string;
	readonly rpcLogger: RpcLogger;
	readonly settingsStore: SettingsStore;
	readonly assign: (patch: { dshHost: DshHost; dshPluginInstallService: DshPluginInstallService; dshAgentManager: DshAgentManager; rpcLogLiveBroadcaster: RpcLogLiveBroadcaster }) => void;
}

export function startDshAgents(ctx: DshAgentsContext): void {
	const { agentToastDeps, appLogger, getDshRuntimeStatus, getMainWindow, getSessionCatalog, mainCopy, piLocator, projectStore, resolveSessionExportDir, rpcLogger, settingsStore, assign } = ctx;
	const currentMainWindow = () => getMainWindow();
	const sessionCatalog = () => getSessionCatalog();

	// DSH host 实例先装配；是否后台预热看 defaultAgentBackend（见 createWindow 后）。
	// 发送/历史/配置链路仍走 ensureStarted 幂等兜底，不用 DSH 的用户不常驻 host。
	// DSH_HOME 可用设置 dshHomeDir 覆盖（用户自己的 ~/.dsh 等），空串 = 应用私有目录。
	const dshHost = new DshHost(
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
			const dshOverrides = (sessionCatalog()?.listEntries() ?? [])
				.filter((entry) => entry.backend === "dsh")
				.map((entry) => {
					const effectiveMode = resolveEffectiveSessionProxyMode(entry.proxy?.mode, entry.model?.provider, entry.model?.modelId, settings.piProxyProviders, settings.piProxyModels);
					return effectiveMode === "follow" ? undefined : ({ mode: effectiveMode } as import("../../shared/types/session").SessionProxyOverride);
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
		() => getDshRuntimeStatus().resolveAppRoot(),
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
	const dshPluginInstallService = new DshPluginInstallService({
		getDshHomeDir: () => dshHost.getHomeDir(),
		getUserDataDir: () => app.getPath("userData"),
		resolveRuntimeNodeModules: () => {
			const appRoot = getDshRuntimeStatus().resolveAppRoot();
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
			const mainWindow = currentMainWindow();
			if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
		},
	});
	const dshAgentManager = new DshAgentManager(
		dshHost,
		(projectId) => projectStore.get(projectId),
		// 审批自动放行：运行时读取设置（即时生效，无需重启 host），见 settings.ts dshApprovalAutoAllow。
		() => settingsStore.get().dshApprovalAutoAllow === true,
		// DSH host 会话标题变化（attach 初值 / session/title 事件 / rename）写回 catalog：
		// DSH 会话没有 pi 会话文件，标题只存在于 host（dsh-session-title fold），
		// 不写回则侧栏/重启后一直显示 draft 占位名（如「pi-desktop DSH」）。
		// 更新后推送 catalog-refreshed，渲染层 useProjectSync 静默重拉刷新侧栏标题。
		(dshSessionId, title) => {
			const entry = sessionCatalog()?.findByDshSessionId(dshSessionId);
			if (!entry || entry.title === title) return;
			void sessionCatalog()
				.update(entry.id, { title })
				.then(() => {
					// 窗口只在回调入口取一次：与原来读模块级 mainWindow 同一时机（tests/rpcLogViewer 按这个形态断言）。
					const mainWindow = currentMainWindow();
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
	assign({ dshHost, dshPluginInstallService, dshAgentManager, rpcLogLiveBroadcaster });
}
