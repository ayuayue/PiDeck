import { app, type BrowserWindow } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { isLocalProject } from "../../shared/projectLocation";
import { AcpAgentManager } from "../acp/AcpAgentManager";
import { AcpSessionArchive } from "../acp/AcpSessionArchive";
import { createAcpModelRateAnnotator } from "../acp/acpModelRates";
import { withAcpConfigDefault } from "../acp/acpToolConfig";
import { buildAcpMcpServers, type AgentMemoryMount } from "../agentMemory/agentMemoryMounts";
import type { ImageBlobStore } from "../imagegen/ImageBlobStore";
import type { AppLogger } from "../logging/AppLogger";
import { notifyAskPending as notifyAgentAskPending, type AgentToastDeps } from "../notifications/agentToast";
import type { PiLocator } from "../pi/PiLocator";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SessionCatalog } from "../sessions/SessionCatalog";
import { resolveAcpProxySettings } from "../sessions/sessionProxyPolicy";
import type { SettingsStore } from "../settings/SettingsStore";

/**
 * ACP 后端装配（自 index.ts 的 whenReady 装配体就地外移，行为零变化）。
 *
 * 多后端网关装配：pi + dsh + acp（DSH 在窗口创建后后台预热，失败时按需重试）。
 * ACP 是 opt-in（settings.acpEnabled，默认 false）：网关常驻注册，开关是运行时读的（deps.isEnabled），
 * 关闭时 create 直接拒绝——保证「未开启的构建不 spawn 任何 ACP CLI」，
 * 又让设置页开关立即生效（不必重启）。
 * 不按启动时的开关决定是否注册：合成器的事件订阅（onOutput）与能力并集在启动时一次成形，
 * 启动后才补注册的网关收不到事件转发，ACP 时间线会静默无输出；
 * 而 AcpAgentManager 构造函数不 spawn 任何进程，常驻注册本身零运行时成本。
 * 开启后每次 create 即 spawn 对应 CLI，无预热。
 *
 * 退出清理登记留在 index.ts（runAll 的执行次序即登记位置）。
 */
export interface AcpAgentsContext {
	readonly agentToastDeps: () => AgentToastDeps;
	readonly annotateAcpConfigOptions: ReturnType<typeof createAcpModelRateAnnotator>;
	readonly appLogger: AppLogger;
	readonly createAgentMemoryMount: (cwd?: string) => AgentMemoryMount;
	readonly getAcpImageBlobStore: () => ImageBlobStore | null;
	readonly getMainWindow: () => BrowserWindow | null;
	readonly getSessionCatalog: () => SessionCatalog;
	readonly piLocator: PiLocator;
	readonly projectStore: ProjectStore;
	readonly settingsStore: SettingsStore;
	readonly assign: (patch: { acpAgentManager: AcpAgentManager }) => void;
}

export function startAcpAgents(ctx: AcpAgentsContext): void {
	const { agentToastDeps, annotateAcpConfigOptions, appLogger, createAgentMemoryMount, getAcpImageBlobStore, getMainWindow, getSessionCatalog, piLocator, projectStore, settingsStore, assign } = ctx;

	const acpAgentManager = new AcpAgentManager({
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
			const mainWindow = getMainWindow();
			if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ipcChannels.acpSessionConfigChanged, { agentId: tab.id, options: annotateAcpConfigOptions(options) ?? [] });
		},
		// 图片物化落盘：ACP 消息里的 base64 图复用生图 blob 存储（ref 形态回填消息；
		// imagegen 装配在另一段完成，经模块级 ref 延迟取实例）。
		imageStore: {
			put: (data, mimeType) => getAcpImageBlobStore()?.put(data, mimeType) ?? Promise.resolve(null),
		},
		// ACP 会话标题（session_info_update）写回 catalog：ACP 无本地文件，标题在 agent 侧。
		onTitleChanged: (deckSessionId, title) => {
			const entry = getSessionCatalog()?.get(deckSessionId);
			if (!entry || entry.title === title) return;
			// session_info_update.title 是 agent 侧命名而非用户手动：走 applyAgentTitle
			// （同源 last-wins、不覆盖用户改名、拒收标记脏名）。此前直接 update() 会把 CLI
			// 标题锁成 manual 终态，用户改名在下一个回合就被 CLI 拉回。
			void getSessionCatalog()
				.applyAgentTitle(deckSessionId, title)
				.then((applied) => {
					if (!applied) return;
					const mainWindow = getMainWindow();
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
	assign({ acpAgentManager });
}
