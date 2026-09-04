/**
 * 主进程后台更新检查服务。
 *
 * automatic（Windows / 可自动升级发行物）：electron-updater 负责检查、下载和
 * quitAndInstall；manual（当前无 Developer ID 签名的 macOS）：仅检查 GitHub
 * Release，UI 引导用户手动下载，绝不承诺无法稳定完成的应用内替换。
 *
 * 生命周期：start() 装配启动调度与事件订阅；stop() 在退出路径清理（配对清理）。
 */

import type { AppSettings } from "../../shared/types/settings";
import type {
	AppUpdateDeliveryMode,
	AppUpdateDownloadState,
	AppUpdateStatusSnapshot,
} from "../../shared/types/app";
import type { PiUpdateCheckResult } from "../../shared/types";
import type { SettingsStore } from "../settings/SettingsStore";
import { normalizeUpdateSource, normalizeCustomMirrorHost, updateSourceFeedUrl, updateSourceLatestReleaseUrl } from "./updateSources";
import type { AutoUpdaterLike } from "./autoUpdaterTypes";

export type AppCheckResult = { latestVersion: string; hasUpdate: boolean };

type PiCheckResult = {
	currentVersion?: string;
	latestVersion?: string;
	hasUpdate: boolean;
	error?: string;
};

export type UpdateServiceDeps = {
	settingsStore: Pick<SettingsStore, "get" | "update">;
	/** Pi CLI 版本检查（extensionManager.checkPiUpdate 注入）。 */
	checkPiUpdate?: () => Promise<PiUpdateCheckResult>;
	/** 推送给渲染层（mainWindow.webContents.send 注入）。 */
	sendToRenderer?: (snapshot: AppUpdateStatusSnapshot) => void;
	log?: (level: "info" | "warn", message: string, details?: Record<string, unknown>) => void;
	getCurrentVersion: () => string;
	/** 当前发行物的更新交付能力；省略时保持既有自动升级默认值。 */
	deliveryMode?: AppUpdateDeliveryMode;
	/** automatic 模式的 electron-updater 封装（真实实例见 createAutoUpdater；测试传 fake）。 */
	autoUpdater?: AutoUpdaterLike;
	/** 安装前的主进程退出准备（例如关闭到托盘开启时先置 isQuitting）。 */
	prepareForInstall?: () => void;
	/** 安装器未能启动时撤销 prepareForInstall 的临时退出状态。 */
	rollbackInstallPreparation?: () => void;
	/** 等待 Electron 退出并交给安装器的超时；超时后恢复可重试状态。 */
	installExitTimeoutMs?: number;
	/** manual 模式的纯检查器（macOS 无签名发行物只检查，不下载/安装）。
	 * 参数 latestReleaseUrl 为镜像源 URL（null = 官方 GitHub），由 UpdateService 按设置传入。 */
	checkManualAppUpdate?: (latestReleaseUrl?: string) => Promise<AppCheckResult>;
};

/** 默认检查周期：2h（静态 GitHub Release URL 与 updater 均适合低频轮询）。 */
export const DEFAULT_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000;
/** 启动后首次检查延迟（ms）：不拖慢首帧，也不会让用户长时间不知道是否有更新。 */
export const DEFAULT_START_DELAY_MS = 10 * 1000;
/** 抖动上界（ms）：打散用户检查时刻，避免同一时段集中请求发布源。 */
export const DEFAULT_JITTER_MAX_MS = 30 * 1000;
/** 安装器接管前 Electron 应退出；超时说明 quitAndInstall 未能完成退出流程。 */
export const DEFAULT_INSTALL_EXIT_TIMEOUT_MS = 60 * 1000;

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	// 跨 realm 的 Error（如测试 VM / 某些插件边界）不满足 instanceof，仍优先保留 message。
	if (typeof error === "object" && error !== null && "message" in error) {
		const message = error.message;
		if (typeof message === "string") return message;
	}
	return String(error);
}

function emptyDownloadState(): AppUpdateDownloadState {
	return { phase: "idle" };
}

export class UpdateService {
	private readonly deps: UpdateServiceDeps;
	private readonly deliveryMode: AppUpdateDeliveryMode;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private installWatchdog: ReturnType<typeof setTimeout> | null = null;
	private installPreparationApplied = false;
	private disposed = false;
	private running = false;
	private unsubscribeUpdater: (() => void) | null = null;
	private lastApp: AppCheckResult | null = null;
	private lastPi: PiCheckResult | null = null;
	private download: AppUpdateDownloadState = emptyDownloadState();

	constructor(deps: UpdateServiceDeps) {
		this.deps = deps;
		this.deliveryMode = deps.deliveryMode ?? "automatic";
		if (this.deliveryMode === "automatic") this.subscribeAutoUpdater();
		else this.getManualChecker(); // Fail at composition time instead of silently disabling macOS checks.
	}

	/** 启动后台调度：延迟首查 + 固定周期续查（带抖动）。 */
	start(options?: { startDelayMs?: number; intervalMs?: number }): void {
		if (this.disposed) return;
		this.applyAutoDownloadPreference();
		this.applyUpdateSource();
		this.scheduleNext(
			options?.startDelayMs ?? DEFAULT_START_DELAY_MS,
			options?.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
		);
	}

	/** 立即执行一轮检查（自动调度 / 手动「检测更新」共用；经 checkUpdate IPC）。 */
	async checkNow(): Promise<void> {
		if (this.running || this.download.phase === "installing") return;
		this.running = true;
		this.applyAutoDownloadPreference();
		// 已下载的更新保持 ready，不能因手动检测而让安装入口消失。
		if (this.download.phase !== "ready") {
			this.download = { ...this.download, phase: "checking", error: undefined };
			this.pushSnapshot();
		}
		try {
			const [appResult, piResult] = await Promise.allSettled([
				this.checkApp(),
				this.checkPi(),
			]);
			if (appResult.status === "fulfilled") this.lastApp = appResult.value;
			if (appResult.status === "rejected") {
				const error = toErrorMessage(appResult.reason);
				// electron-updater 通常也会发 error 事件，但直接 reject 时仍要有可见状态。
				if (this.download.phase !== "ready") this.setDownloadError(error);
				void this.deps.log?.("warn", "App update check failed", { error });
			}
			if (piResult.status === "fulfilled") this.lastPi = piResult.value;
			// 检查时间持久化（低频写，2h 一次），供 UI 显示上次检查时间。
			await this.deps.settingsStore
				.update({ updateLastCheckAt: Date.now() })
				.catch(() => undefined);
			this.pushSnapshot();
		} finally {
			this.running = false;
		}
	}

	/** 手动下载已检测到的更新（仅 automatic + autoDownload=false 时使用）。 */
	async downloadNow(): Promise<void> {
		if (this.deliveryMode === "manual") {
			void this.deps.log?.("warn", "In-app download is unavailable for manual update delivery");
			return;
		}
		if (this.download.phase === "installing") {
			void this.deps.log?.("warn", "Ignored download request while update installation is starting");
			return;
		}
		const version = this.lastApp?.hasUpdate
			? this.download.version ?? this.lastApp.latestVersion
			: undefined;
		if (!version) {
			this.setDownloadError("No application update is available to download.");
			return;
		}
		// electron-updater 的第一条 progress 事件可能较晚；先切状态让手动入口立即有反馈。
		this.download = {
			...this.download,
			phase: "downloading",
			version,
			percent: this.download.percent ?? 0,
			error: undefined,
		};
		this.pushSnapshot();
		try {
			await this.getAutoUpdater().downloadUpdate();
		} catch (error) {
			this.setDownloadError(toErrorMessage(error));
		}
	}

	/** 重启并安装已下载的更新（渲染层「重启并安装」按钮 → quitAndInstall）。 */
	installNow(): void {
		if (this.deliveryMode === "manual") {
			void this.deps.log?.("warn", "In-app install is unavailable for manual update delivery");
			return;
		}
		if (this.download.phase === "installing") {
			void this.deps.log?.("warn", "Ignored duplicate install request while installer is starting");
			return;
		}
		if (this.download.phase !== "ready") {
			void this.deps.log?.("warn", "Ignored install request without a downloaded update");
			return;
		}

		try {
			// closeToTray 会吞掉普通窗口关闭；安装器必须先显式进入真实退出态。
			this.deps.prepareForInstall?.();
			this.installPreparationApplied = true;
			this.download = { ...this.download, phase: "installing", error: undefined };
			this.pushSnapshot();
			void this.deps.log?.("info", "User confirmed install; quit and install");
			this.getAutoUpdater().quitAndInstall();
			this.armInstallWatchdog();
		} catch (error) {
			this.restoreAfterInstallFailure(toErrorMessage(error));
		}
	}

	/** 应用「自动下载更新」偏好（设置保存后立即调用；manual 模式不适用）。 */
	applyAutoDownloadPreference(): void {
		if (this.deliveryMode !== "automatic") return;
		const enabled = this.deps.settingsStore.get().autoDownloadUpdates !== false;
		this.getAutoUpdater().setAutoDownload(enabled);
	}

	/**
	 * 切换更新源（设置保存后立即调用）：镜像 → generic feed URL；
	 * 回 GitHub → setFeedUrl(null) 恢复原生 provider。
	 */
	applyUpdateSource(): void {
		if (this.deliveryMode !== "automatic") return;
		const settings = this.deps.settingsStore.get();
		const source = normalizeUpdateSource(settings.updateSource);
		const feedUrl = updateSourceFeedUrl(
			source,
			source === "custom"
				? normalizeCustomMirrorHost(settings.customUpdateSourceUrl ?? "")
				: null,
		);
		this.getAutoUpdater().setFeedUrl(feedUrl);
	}

	/** 记录「已提示过该版本」（渲染层 toast 展示后调用，实现每版本只提示一次）。 */
	async notifySeen(kind: "app" | "pi", version: string): Promise<void> {
		const patch: Partial<AppSettings> =
			kind === "app" ? { updateNotifiedVersion: version } : { updatePiNotifiedVersion: version };
		await this.deps.settingsStore.update(patch).catch(() => undefined);
		this.pushSnapshot();
	}

	/** 跳过某个 PiDeck 版本（该版本不再主动提示，手动检测仍可查看）。 */
	async skipVersion(version: string): Promise<void> {
		if (!version) return;
		await this.deps.settingsStore.update({ updateSkippedVersion: version }).catch(() => undefined);
		this.pushSnapshot();
	}

	/** 当前快照（从持久化状态 + 最近一次检查/下载状态组装）。 */
	getSnapshot(): AppUpdateStatusSnapshot {
		const settings = this.deps.settingsStore.get();
		// 检查中的首次请求或直接失败时还没有 lastApp；仍需保留 app 节点，
		// 否则渲染层收不到 checking/error 状态，用户会看到一次无反馈的点击。
		const hasAppState = this.lastApp !== null || this.download.phase !== "idle";
		return {
			lastCheckAt: settings.updateLastCheckAt,
			deliveryMode: this.deliveryMode,
			autoDownload:
				this.deliveryMode === "automatic" ? settings.autoDownloadUpdates !== false : null,
			app: hasAppState
				? {
						latestVersion: this.lastApp?.latestVersion,
						hasUpdate: this.lastApp?.hasUpdate ?? false,
						skippedVersion: settings.updateSkippedVersion,
						notifiedVersion: settings.updateNotifiedVersion,
						download: this.download,
					}
				: null,
			piCli: this.lastPi
				? {
						currentVersion: this.lastPi.currentVersion,
						latestVersion: this.lastPi.latestVersion,
						hasUpdate: this.lastPi.hasUpdate,
						notifiedVersion: settings.updatePiNotifiedVersion,
						error: this.lastPi.error,
					}
				: null,
		};
	}

	/** 退出路径清理定时器与 updater 事件订阅（配对清理）。 */
	stop(): void {
		this.disposed = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.installWatchdog) {
			clearTimeout(this.installWatchdog);
			this.installWatchdog = null;
		}
		this.unsubscribeUpdater?.();
		this.unsubscribeUpdater = null;
	}

	private subscribeAutoUpdater(): void {
		const autoUpdater = this.getAutoUpdater();
		this.unsubscribeUpdater = autoUpdater.onEvents({
			onChecking: () => {
				// 已完整下载的包必须优先保留，后续定时检查不能吞掉「重启并安装」入口。
				if (this.download.phase === "ready" || this.isInstallInProgress()) return;
				this.download = { ...this.download, phase: "checking", error: undefined };
				this.pushSnapshot();
			},
			onUpdateAvailable: (version, willDownload) => {
				if (this.isInstallInProgress()) return;
				this.lastApp = { latestVersion: version, hasUpdate: true };
				this.download = {
					phase: willDownload ? "downloading" : "available",
					version,
					percent: willDownload ? 0 : undefined,
				};
				this.pushSnapshot();
			},
			onDownloadProgress: (progress) => {
				if (this.isInstallInProgress()) return;
				this.download = {
					phase: "downloading",
					version: this.download.version,
					percent: progress.percent,
					bytesPerSecond: progress.bytesPerSecond,
					transferred: progress.transferred,
					total: progress.total,
				};
				this.pushSnapshot();
			},
			onUpdateDownloaded: (version) => {
				if (this.isInstallInProgress()) return;
				if (version && this.lastApp) this.lastApp = { ...this.lastApp, latestVersion: version };
				this.download = { phase: "ready", version: version || this.download.version, percent: 100 };
				void this.deps.log?.("info", "Update downloaded, ready to install", {
					version: version || this.download.version,
				});
				this.pushSnapshot();
			},
			onUpdateNotAvailable: () => {
				// 已下载版本优先于下一轮检查结果，避免 ready 状态被无更新事件覆盖。
				if (this.download.phase === "ready" || this.isInstallInProgress()) return;
				this.lastApp = { latestVersion: this.deps.getCurrentVersion(), hasUpdate: false };
				this.download = emptyDownloadState();
				this.pushSnapshot();
			},
			onError: (error) => {
				// quitAndInstall 已开始时，迟到的检查事件不能覆盖「正在退出安装」状态。
				if (this.isInstallInProgress()) {
					void this.deps.log?.("warn", "Auto updater emitted an error while installation was starting", { error });
					return;
				}
				// 完成下载后即使后续检查失败，用户仍必须能安装已就绪的版本。
				if (this.download.phase === "ready") {
					void this.deps.log?.("warn", "Auto updater check failed after download", { error });
					return;
				}
				this.setDownloadError(error);
				void this.deps.log?.("warn", "Auto updater error", { error });
			},
		});
	}

	private isInstallInProgress(): boolean {
		return this.download.phase === "installing";
	}

	private armInstallWatchdog(): void {
		if (this.installWatchdog) clearTimeout(this.installWatchdog);
		const timeoutMs = this.deps.installExitTimeoutMs ?? DEFAULT_INSTALL_EXIT_TIMEOUT_MS;
		this.installWatchdog = setTimeout(() => {
			this.installWatchdog = null;
			if (!this.isInstallInProgress()) return;
			this.restoreAfterInstallFailure(
				"The update installer did not start before PiDeck finished waiting to exit.",
			);
		}, Math.max(0, timeoutMs));
		// 不能让失败的安装尝试成为主进程唯一的活跃句柄。
		this.installWatchdog.unref?.();
	}

	/** 安装器同步失败或退出超时时恢复窗口关闭语义，保留已下载包供用户重试。 */
	private restoreAfterInstallFailure(error: string): void {
		if (this.installWatchdog) {
			clearTimeout(this.installWatchdog);
			this.installWatchdog = null;
		}
		this.download = { ...this.download, phase: "ready", percent: 100, error };
		if (this.installPreparationApplied) {
			this.installPreparationApplied = false;
			try {
				this.deps.rollbackInstallPreparation?.();
			} catch (rollbackError) {
				void this.deps.log?.("warn", "Failed to restore app state after update install failure", {
					error: toErrorMessage(rollbackError),
				});
			}
		}
		void this.deps.log?.("warn", "Update installation did not start", { error });
		this.pushSnapshot();
	}

	private async checkApp(): Promise<AppCheckResult> {
		if (this.deliveryMode === "manual") {
			const settings = this.deps.settingsStore.get();
			const source = normalizeUpdateSource(settings.updateSource);
			const releaseUrl = updateSourceLatestReleaseUrl(
				source,
				source === "custom"
					? normalizeCustomMirrorHost(settings.customUpdateSourceUrl ?? "")
					: null,
			);
			const result = await this.getManualChecker()(releaseUrl ?? undefined);
			this.lastApp = result;
			this.download = result.hasUpdate
				? { phase: "available", version: result.latestVersion }
				: emptyDownloadState();
			this.pushSnapshot();
			return result;
		}
		// electron-updater：autoDownload=true 时检测到新版本会自动继续下载，
		// 进度经事件回到 checkApp 所在 checkNow 之外（onEvents 已注册）分发。
		await this.getAutoUpdater().checkForUpdates();
		return this.lastApp ?? { latestVersion: this.deps.getCurrentVersion(), hasUpdate: false };
	}

	private async checkPi(): Promise<PiCheckResult> {
		if (!this.deps.checkPiUpdate) return { hasUpdate: false };
		const result = await this.deps.checkPiUpdate();
		return {
			currentVersion: result.currentVersion,
			latestVersion: result.latestVersion,
			hasUpdate: result.hasUpdate,
			error: result.error,
		};
	}

	private getAutoUpdater(): AutoUpdaterLike {
		if (!this.deps.autoUpdater) {
			throw new Error("UpdateService automatic delivery requires an autoUpdater.");
		}
		return this.deps.autoUpdater;
	}

	private getManualChecker(): (latestReleaseUrl?: string) => Promise<AppCheckResult> {
		if (!this.deps.checkManualAppUpdate) {
			throw new Error("UpdateService manual delivery requires a checkManualAppUpdate function.");
		}
		return this.deps.checkManualAppUpdate;
	}

	private pushSnapshot(): void {
		this.deps.sendToRenderer?.(this.getSnapshot());
	}

	/** 将 updater 的 reject/事件错误统一折叠为渲染层可展示的快照状态。 */
	private setDownloadError(error: string): void {
		this.download = { ...this.download, phase: "error", error };
		this.pushSnapshot();
	}

	private scheduleNext(delayMs: number, intervalMs: number): void {
		if (this.disposed) return;
		const jitter = Math.floor(Math.random() * DEFAULT_JITTER_MAX_MS);
		const timer = setTimeout(() => {
			void this.checkNow().finally(() => {
				this.scheduleNext(intervalMs, intervalMs);
			});
		}, Math.max(0, delayMs + jitter));
		// 调度器不能成为 Electron 退出/Node 测试进程无法结束的唯一活跃句柄。
		timer.unref?.();
		this.timer = timer;
	}
}
