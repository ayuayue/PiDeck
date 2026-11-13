import { app } from "electron";
import { hostname } from "node:os";
import type { AppSettings, SessionRecord } from "../../shared/types";
import { CloudSyncManager } from "../cloudSync/CloudSyncManager";
import { resolveDshHomeDir } from "../dsh/DshHost";
import type { ExtensionManager } from "../extensions/ExtensionManager";
import type { QuitCleanupRegistry } from "../lifecycle/QuitCleanupRegistry";
import type { AppLogger } from "../logging/AppLogger";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SessionCatalog } from "../sessions/SessionCatalog";
import type { SettingsStore } from "../settings/SettingsStore";

/**
 * 云同步装配（自 index.ts 的 whenReady 装配体就地外移，行为零变化）：
 * 构造 → `assign` 回填模块级槽位 → initialize → 退出清理登记。
 *
 * 主进程唯一持有密码/派生 key/Provider 凭据，扫描与恢复都走主进程。
 */
export interface CloudSyncContext {
	readonly appLogger: AppLogger;
	readonly broadcastCloudSyncStateChanged: () => void;
	readonly extensionManager: ExtensionManager;
	readonly projectStore: ProjectStore;
	readonly quitCleanup: QuitCleanupRegistry;
	readonly sessionCatalog: SessionCatalog;
	readonly settingsStore: SettingsStore;
	readonly assign: (patch: { cloudSyncManager: CloudSyncManager }) => void;
}

export async function startCloudSync(ctx: CloudSyncContext): Promise<void> {
	const { appLogger, broadcastCloudSyncStateChanged, extensionManager, projectStore, quitCleanup, sessionCatalog, settingsStore, assign } = ctx;

	// 云同步编排：主进程唯一持有密码/派生 key/Provider 凭据；扫描与恢复都走主进程。
	const cloudSyncManager = new CloudSyncManager({
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
	assign({ cloudSyncManager });
	await cloudSyncManager.initialize();
	// C12：退出清理登记（before-quit 统一 runAll；cloud-sync 定时器与适配器随进程结束回收）
	quitCleanup.register("cloud-sync", () => cloudSyncManager?.dispose());
}
