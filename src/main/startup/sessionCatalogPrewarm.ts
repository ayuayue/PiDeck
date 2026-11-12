import type { AppLogger } from "../logging/AppLogger";
import type { ExtensionManager } from "../extensions/ExtensionManager";
import type { ProjectStore } from "../projects/ProjectStore";
import type { SessionCatalog } from "../sessions/SessionCatalog";
import type { SessionScanner } from "../sessions/SessionScanner";
import type { SettingsStore } from "../settings/SettingsStore";
import { scheduleCatalogBackgroundScan } from "../ipc/sessionIpc";
import { isLocalProject } from "../../shared/projectLocation";
import { resolveProjectWslIdentity } from "../wsl/WslProjectEnvironment";

/**
 * 启动预扫描（自 index.ts 的 registerIpc 就地外移，行为零变化）：延迟 3s 起、项目间错开 1.5s，
 * 逐个调度后台扫描预热 catalog 缓存，把 `pi --version` / `pi list` 子进程移出首次打开扩展页的关键路径。
 *
 * 全是读装配：扫描器、扩展管理器走 getter（3s 后回调里读到的是当前实例），不写任何模块级单例。
 */
export interface SessionCatalogPrewarmContext {
	readonly appLogger: AppLogger;
	readonly getExtensionManager: () => ExtensionManager;
	readonly getSessionScanner: () => SessionScanner;
	readonly projectStore: ProjectStore;
	readonly sessionCatalog: SessionCatalog;
	readonly settingsStore: SettingsStore;
	readonly wslSessionScannerFor: (identity: { distro: string; user: string }) => Promise<SessionScanner>;
}

export function startPrewarm(ctx: SessionCatalogPrewarmContext): void {
	const { appLogger, getExtensionManager, getSessionScanner, projectStore, sessionCatalog, settingsStore, wslSessionScannerFor } = ctx;

	// ── 启动预扫描（2026-08 展开项目卡顿优化）──
	// 延迟 3s 启动、项目间错开 1.5s 逐个调度后台扫描：预热 catalog 缓存，
	// 用户首次展开项目时直接命中缓存回显，不再同步全量扫描卡 UI。
	// 错开 + 协调器去重/冷却（sessionIpc 内）保证不与用户触发的扫描并发重扫。
	const prewarmTimer = setTimeout(() => {
		const projects = projectStore.list();
		projects.forEach((project, index) => {
			const timer = setTimeout(() => {
				scheduleCatalogBackgroundScan(project.id, async () => {
					// 本机 scanner 不能扫远端项目（远端会话扫描属 Phase 4）。
					if (!isLocalProject(project)) return;
					try {
						const settings = settingsStore.get();
						const wsl = resolveProjectWslIdentity(project, settings);
						let projectPath = project.path;
						if (wsl !== undefined) {
							projectPath = projectPath.replace(/^([A-Za-z]):\\/, (_: string, drive: string) => `/mnt/${drive.toLowerCase()}/`).replace(/\\/g, "/");
						}
						const scanner = wsl !== undefined ? await wslSessionScannerFor(wsl) : getSessionScanner();
						const summaries = await scanner.list(projectPath);
						await sessionCatalog.mergeScanned(project.id, summaries, wsl !== undefined ? { wslDistro: wsl.distro, wslUser: wsl.user } : {});
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
		// 扩展页关键路径预热：提前探测 pi 版本（--no-approve 判定依赖该缓存），把
		// `pi --version` 子进程移出首次 extensions:list。尽力而为——warmPiVersionProbe
		// 内部已吞错记日志，此处再兜一层同步异常，失败绝不会影响启动与 catalog 预热。
		try {
			void getExtensionManager()?.warmPiVersionProbe();
			// 扩展列表预热：把首次 `pi list` 子进程与磁盘扫描移出用户打开扩展页的关键路径。
			// 与版本探测一样尽力而为（失败只记日志，不影响启动）；列表缓存自身的 in-flight
			// 去重保证用户随后真正发起的 extensions:list 不会重复起进程。
			void getExtensionManager()
				?.list(false)
				.catch((error) => {
					void appLogger.warn("extension", "extension list prewarm failed", { error: error instanceof Error ? error.message : String(error) });
				});
		} catch (error) {
			void appLogger.warn("extension", "pi version prewarm failed", { error: error instanceof Error ? error.message : String(error) });
		}
	}, 3000);
	prewarmTimer.unref?.();
}
