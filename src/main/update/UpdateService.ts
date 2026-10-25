/**
 * 主进程后台更新检查服务。
 *
 * automatic（Windows 安装版 / Linux x64 AppImage 等可自升级发行物）：electron-updater
 * 负责检查、下载和 quitAndInstall；manual（macOS 无签名、Linux arm64、Linux deb/tar.gz）：
 * 检查 GitHub/AtomGit Release 后按当前设备匹配安装包，由 ManualUpdateDelivery 负责
 * 一键下载与打开，绝不承诺无法稳定完成的应用内替换。
 *
 * 更新通道（deps.channel）：dev 构建无论设置 updateSource 为何都强制官方 GitHub
 * 源并开启 prerelease（镜像只分发 stable 产物，dev 的 0.8.0-beta.* 仅存在于
 * GitHub Releases）；stable 语义与历史行为一致。
 *
 * 生命周期：start() 装配启动调度与事件订阅；stop() 在退出路径清理（配对清理）。
 */

import type { AppSettings } from "../../shared/types/settings";
import type { AppUpdateDeliveryMode, AppUpdateDeliveryReason, AppUpdateDownloadState, AppUpdateStatusSnapshot, UpdateChannel } from "../../shared/types/app";
import type { PiUpdateCheckResult } from "../../shared/types";
import type { CatalogCheckResult, CatalogUpdateResult } from "../../shared/types/catalog";
import type { SettingsStore } from "../settings/SettingsStore";
import { normalizeUpdateSource, normalizeCustomMirrorHost, updateSourceFeedUrl, updateSourceLatestReleaseUrl } from "./updateSources";
import type { AutoUpdaterLike } from "./autoUpdaterTypes";
import type { ManualReleaseCheckResult } from "./macManualUpdate";
import { ManualUpdateDelivery, type ManualUpdateDeliveryDeps } from "./manualUpdateDelivery";

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
	/** 内置模型目录（pi-ai-catalog）远端检查（PiAiCatalogUpdater.checkRemote 注入）。 */
	checkCatalogUpdate?: () => Promise<CatalogCheckResult>;
	/**
	 * 后台检查发现目录新版本时自动拉取（设置 `catalogAutoUpdate`，默认开）。
	 * 与设置页「更新到最新」是同一入口（下载 → manifest 校验 → 备份 → 原子替换）。
	 */
	updateCatalog?: () => Promise<CatalogUpdateResult>;
	/** 推送给渲染层（mainWindow.webContents.send 注入）。 */
	sendToRenderer?: (snapshot: AppUpdateStatusSnapshot) => void;
	log?: (level: "info" | "warn", message: string, details?: Record<string, unknown>) => void;
	getCurrentVersion: () => string;
	/** 当前发行物的更新交付能力；省略时保持既有自动升级默认值。 */
	deliveryMode?: AppUpdateDeliveryMode;
	/** 更新通道：dev 强制 GitHub 源 + allowPrerelease；省略视为 stable（历史行为）。 */
	channel?: UpdateChannel;
	/** automatic 模式的 electron-updater 封装（真实实例见 createAutoUpdater；测试传 fake）。 */
	autoUpdater?: AutoUpdaterLike;
	/** 安装前的主进程退出准备（例如关闭到托盘开启时先置 isQuitting）。 */
	prepareForInstall?: () => void;
	/** 安装器未能启动时撤销 prepareForInstall 的临时退出状态。 */
	rollbackInstallPreparation?: () => void;
	/** 等待 Electron 退出并交给安装器的超时；超时后恢复可重试状态。 */
	installExitTimeoutMs?: number;
	/** manual 模式的纯检查器（macOS 无签名 / Linux 无法自更新等只检查，不下载/安装）。
	 * 参数 latestReleaseUrl 为镜像源 URL（null = 官方 GitHub），由 UpdateService 按设置传入。 */
	checkManualAppUpdate?: (latestReleaseUrl?: string) => Promise<ManualReleaseCheckResult>;
	/** manual 模式的设备推荐目标原因（UI 说明文案选择依据）。 */
	deliveryReason?: AppUpdateDeliveryReason;
	/**
	 * manual 模式：下载设备匹配的安装包（流式 + digest 校验后落到系统下载目录）。
	 * 装配层注入真实实现；测试注入 fake。
	 */
	downloadManualUpdate?: ManualUpdateDeliveryDeps["downloadManualUpdate"];
	/** manual 模式：打开已下载的安装包（mac 挂载 dmg；其他平台在文件夹中定位）。 */
	openManualInstaller?: ManualUpdateDeliveryDeps["openManualInstaller"];
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
	private readonly deliveryReason: AppUpdateDeliveryReason;
	private readonly channel: UpdateChannel;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private installWatchdog: ReturnType<typeof setTimeout> | null = null;
	private installPreparationApplied = false;
	private disposed = false;
	private running = false;
	private unsubscribeUpdater: (() => void) | null = null;
	private lastApp: AppCheckResult | null = null;
	private lastPi: PiCheckResult | null = null;
	private lastCatalog: CatalogCheckResult | null = null;
	private download: AppUpdateDownloadState = emptyDownloadState();
	/** manual 交付的检查/下载/打开状态机；automatic 模式为 null。 */
	private readonly manualDelivery: ManualUpdateDelivery | null;

	constructor(deps: UpdateServiceDeps) {
		this.deps = deps;
		this.deliveryMode = deps.deliveryMode ?? "automatic";
		this.deliveryReason = deps.deliveryReason ?? (this.deliveryMode === "manual" ? "unsupported" : "automatic");
		this.channel = deps.channel ?? "stable";
		this.manualDelivery =
			this.deliveryMode === "manual"
				? new ManualUpdateDelivery({
						downloadManualUpdate: deps.downloadManualUpdate,
						openManualInstaller: deps.openManualInstaller,
						onChange: () => this.pushSnapshot(),
						log: deps.log,
					})
				: null;
		if (this.deliveryMode === "automatic") this.subscribeAutoUpdater();
		else this.getManualChecker(); // Fail at composition time instead of silently disabling manual checks.
	}

	/** 启动后台调度：延迟首查 + 固定周期续查（带抖动）。 */
	start(options?: { startDelayMs?: number; intervalMs?: number }): void {
		if (this.disposed) return;
		this.applyAutoDownloadPreference();
		this.applyUpdateSource();
		this.scheduleNext(options?.startDelayMs ?? DEFAULT_START_DELAY_MS, options?.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS);
	}

	/** 立即执行一轮检查（自动调度 / 手动「检测更新」共用；经 checkUpdate IPC）。 */
	async checkNow(): Promise<void> {
		const currentDownload = this.getDownloadState();
		// 下载/安装进行中不重新检查：覆盖状态会让进度条或「打开安装包」入口消失。
		if (this.running || currentDownload.phase === "installing" || currentDownload.phase === "downloading") return;
		this.running = true;
		this.applyAutoDownloadPreference();
		// 已下载的更新保持 ready，不能因手动检测而让安装入口消失。
		if (currentDownload.phase !== "ready") {
			if (this.manualDelivery) this.manualDelivery.markChecking();
			else {
				this.download = { ...this.download, phase: "checking", error: undefined, errorKind: undefined };
				this.pushSnapshot();
			}
		}
		try {
			const [appResult, piResult, catalogResult] = await Promise.allSettled([this.checkApp(), this.checkPi(), this.checkCatalog()]);
			if (appResult.status === "fulfilled") this.lastApp = appResult.value;
			if (appResult.status === "rejected") {
				const error = toErrorMessage(appResult.reason);
				// electron-updater 通常也会发 error 事件，但直接 reject 时仍要有可见状态。
				if (this.manualDelivery) this.manualDelivery.setCheckError(error);
				else if (this.download.phase !== "ready") this.setDownloadError(error);
				void this.deps.log?.("warn", "App update check failed", { error });
			}
			if (piResult.status === "fulfilled") this.lastPi = piResult.value;
			if (piResult.status === "rejected") {
				const error = toErrorMessage(piResult.reason);
				void this.deps.log?.("warn", "Pi CLI update check failed", { error });
			}
			if (catalogResult.status === "fulfilled") this.lastCatalog = catalogResult.value;
			if (catalogResult.status === "rejected") {
				const error = toErrorMessage(catalogResult.reason);
				void this.deps.log?.("warn", "Catalog update check failed", { error });
			}
			// 检测到新版本就按设置自动拉取（设置页手动更新的同一条链路）；
			// 内部已兜底，失败不会影响本轮 app/pi 两路结果。
			await this.autoApplyCatalogUpdate();
			// 检查时间持久化（低频写，2h 一次），供 UI 显示上次检查时间。
			await this.deps.settingsStore.update({ updateLastCheckAt: Date.now() }).catch(() => undefined);
			this.pushSnapshot();
		} finally {
			this.running = false;
		}
	}

	/** 手动下载已检测到的更新：manual 下载设备匹配安装包；automatic 交给 electron-updater。 */
	async downloadNow(): Promise<void> {
		if (this.manualDelivery) {
			await this.manualDelivery.download();
			return;
		}
		if (this.download.phase === "installing") {
			void this.deps.log?.("warn", "Ignored download request while update installation is starting");
			return;
		}
		const version = this.lastApp?.hasUpdate ? (this.download.version ?? this.lastApp.latestVersion) : undefined;
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
			errorKind: undefined,
		};
		this.pushSnapshot();
		try {
			await this.getAutoUpdater().downloadUpdate();
		} catch (error) {
			this.setDownloadError(toErrorMessage(error));
		}
	}

	/** 安装/打开已下载的更新：automatic 重启安装；manual 只打开安装包，不退出应用。 */
	installNow(): void {
		if (this.manualDelivery) {
			this.manualDelivery.open();
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
	 * dev 通道覆盖设置恒用官方 GitHub 源并允许 prerelease：AtomGit 镜像只分发
	 * stable 产物，dev 的 0.8.0-beta.* 仅存在于 GitHub Releases；stable 显式重置
	 * false（声明式保障，防 electron-updater 按版本段推断的残留）。
	 */
	applyUpdateSource(): void {
		if (this.deliveryMode !== "automatic") return;
		const settings = this.deps.settingsStore.get();
		const effectiveSource = this.channel === "dev" ? "github" : normalizeUpdateSource(settings.updateSource);
		this.getAutoUpdater().setFeedUrl(updateSourceFeedUrl(effectiveSource));
		// dev 恒 true；stable 恒 false（显式重置，防设置残留）。
		this.getAutoUpdater().setAllowPrerelease(this.channel === "dev");
	}

	/** 记录「已提示过该版本」（渲染层 toast 展示后调用，实现每版本只提示一次）。 */
	async notifySeen(kind: "app" | "pi", version: string): Promise<void> {
		const patch: Partial<AppSettings> = kind === "app" ? { updateNotifiedVersion: version } : { updatePiNotifiedVersion: version };
		await this.deps.settingsStore.update(patch).catch(() => undefined);
		this.pushSnapshot();
	}

	/** 跳过某个 PiDeck 版本（该版本不再主动提示，手动检测仍可查看）。 */
	async skipVersion(version: string): Promise<void> {
		if (!version) return;
		await this.deps.settingsStore.update({ updateSkippedVersion: version }).catch(() => undefined);
		this.pushSnapshot();
	}

	/**
	 * 用一次真实的 Pi CLI 版本检查结果覆盖快照里的 pi 节点，并立即推送。
	 *
	 * 为什么需要单独入口：pi 的更新检查有两条入口——后台每 2h 一轮的 checkNow，以及
	 * 设置页的「检测 Pi 更新」（同时是应用内「更新 pi」完成后的复核）。后者不进本服务，
	 * 不同步就会让侧栏设置按钮的圆点一直停在「pi 有新版本」，与设置页刚显示的
	 * 「已是最新版本」自相矛盾（实测：应用内升到 1.4.0 后圆点要等下一轮 2h 检查才消失）。
	 *
	 * 调用方必须在真正跑过 `pi --version` 之后调用；这里只做状态收口，不再探测。
	 */
	applyPiCheckResult(result: PiUpdateCheckResult): void {
		this.lastPi = {
			currentVersion: result.currentVersion,
			latestVersion: result.latestVersion,
			hasUpdate: result.hasUpdate,
			error: result.error,
		};
		this.pushSnapshot();
	}

	/** 当前快照（从持久化状态 + 最近一次检查/下载状态组装）。 */
	getSnapshot(): AppUpdateStatusSnapshot {
		const settings = this.deps.settingsStore.get();
		const manualState = this.manualDelivery?.getState();
		const download = manualState?.download ?? this.download;
		// 检查中的首次请求或直接失败时还没有 lastApp；仍需保留 app 节点，
		// 否则渲染层收不到 checking/error 状态，用户会看到一次无反馈的点击。
		const hasAppState = this.lastApp !== null || download.phase !== "idle";
		return {
			lastCheckAt: settings.updateLastCheckAt,
			deliveryMode: this.deliveryMode,
			deliveryReason: this.deliveryReason,
			autoDownload: this.deliveryMode === "automatic" ? settings.autoDownloadUpdates !== false : null,
			app: hasAppState
				? {
						latestVersion: this.lastApp?.latestVersion,
						hasUpdate: this.lastApp?.hasUpdate ?? false,
						skippedVersion: settings.updateSkippedVersion,
						notifiedVersion: settings.updateNotifiedVersion,
						download,
						recommendedDownload: manualState?.recommendedDownload ?? null,
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
			catalog: this.lastCatalog
				? {
						localVersion: this.lastCatalog.ok ? this.lastCatalog.localVersion : null,
						latestVersion: this.lastCatalog.ok ? this.lastCatalog.remoteVersion : undefined,
						hasUpdate: this.lastCatalog.ok ? this.lastCatalog.hasUpdate : false,
						error: this.lastCatalog.ok ? undefined : this.lastCatalog.message,
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
		// 退出/换版本时中止手动下载；进度回调与 catch 都靠 controller 身份判迟到的结果。
		this.manualDelivery?.stop();
		this.unsubscribeUpdater?.();
		this.unsubscribeUpdater = null;
	}

	private subscribeAutoUpdater(): void {
		const autoUpdater = this.getAutoUpdater();
		this.unsubscribeUpdater = autoUpdater.onEvents({
			onChecking: () => {
				// 已完整下载的包必须优先保留，后续定时检查不能吞掉「重启并安装」入口。
				if (this.download.phase === "ready" || this.isInstallInProgress()) return;
				this.download = { ...this.download, phase: "checking", error: undefined, errorKind: undefined };
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
		this.installWatchdog = setTimeout(
			() => {
				this.installWatchdog = null;
				if (!this.isInstallInProgress()) return;
				this.restoreAfterInstallFailure("The update installer did not start before PiDeck finished waiting to exit.");
			},
			Math.max(0, timeoutMs),
		);
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
		if (this.manualDelivery) {
			const settings = this.deps.settingsStore.get();
			// dev 通道强制官方 GitHub 源：镜像 latestReleaseUrl 指向 stable latest，不适用 dev prerelease（checker 内部走 releases 列表）。
			const source = this.channel === "dev" ? "github" : normalizeUpdateSource(settings.updateSource);
			const releaseUrl = updateSourceLatestReleaseUrl(source);
			const result = await this.getManualChecker()(releaseUrl ?? undefined);
			this.lastApp = { latestVersion: result.latestVersion, hasUpdate: result.hasUpdate };
			// 状态机（ready 保留、目标版本变化重置）在 ManualUpdateDelivery 内收口。
			this.manualDelivery.applyCheckResult(result);
			this.pushSnapshot();
			return this.lastApp;
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

	/** 内置模型目录远端检查：未注入时跳过（不产生快照节点，不视为错误）。 */
	private async checkCatalog(): Promise<CatalogCheckResult | null> {
		if (!this.deps.checkCatalogUpdate) return null;
		return this.deps.checkCatalogUpdate();
	}

	/**
	 * 检测到目录新版本后自动更新（设置 `catalogAutoUpdate` 为 false 时关闭，默认开）。
	 *
	 * 自动与手动共用 PiAiCatalogUpdater.update：下载双源兜底、manifest 校验不过不上盘、
	 * 写覆盖层前备份上一版，所以「自动」只是省掉一次点击，不降低任何安全边界。
	 * 失败时保留「有更新」快照（用户仍可在设置页手动重试）；成功则改写快照为已生效。
	 */
	private async autoApplyCatalogUpdate(): Promise<void> {
		const checked = this.lastCatalog;
		if (!this.deps.updateCatalog || !checked?.ok || !checked.hasUpdate) return;
		if (this.deps.settingsStore.get().catalogAutoUpdate === false) return;
		try {
			const applied = await this.deps.updateCatalog();
			if (!applied.ok) {
				void this.deps.log?.("warn", "Catalog auto update failed", { code: applied.code, message: applied.message });
				return;
			}
			if (!applied.updated) {
				// 两条源都确认没有可写入的更新（远端不高于当前生效版本）：上一轮的「有更新」
				// 已经不可兑现（检查走的源与能写入的源不一致，或另一实例刚更新过），
				// 保留它只会让设置页常驻一条点了也只回「已是最新」的提示——改用同一链路重取结论。
				void this.deps.log?.("info", "Catalog auto update skipped: no newer catalog", { remote: checked.remoteVersion, skipped: applied.skipped, remoteVersion: applied.remoteVersion, localVersion: applied.localVersion });
				await this.refreshCatalogSnapshot();
				return;
			}
			this.lastCatalog = { ok: true, remoteVersion: checked.remoteVersion, localVersion: checked.remoteVersion, hasUpdate: false };
			void this.deps.log?.("info", "Catalog auto updated", { version: checked.remoteVersion });
		} catch (error) {
			// 自动更新绝不能把后台检查变成失败：只记日志，快照保持「有更新」。
			void this.deps.log?.("warn", "Catalog auto update failed", { error: toErrorMessage(error) });
		}
	}

	/**
	 * 用同一条检查链路重取目录结论并推送快照。
	 *
	 * 设置页的「更新到最新 / 还原 / 恢复上一个覆盖版」直接调 PiAiCatalogUpdater，
	 * 不经过本服务；不回写快照的话，渲染层的「有新版本」提示与侧栏红点会一直留到下一轮
	 * 定时检查（默认 2h），看上去就是「更新成功了但状态没变」。
	 */
	async refreshCatalogSnapshot(): Promise<void> {
		if (!this.deps.checkCatalogUpdate) return;
		try {
			this.lastCatalog = await this.deps.checkCatalogUpdate();
		} catch (error) {
			void this.deps.log?.("warn", "Catalog update check failed", { error: toErrorMessage(error) });
			return;
		}
		this.pushSnapshot();
	}

	private getAutoUpdater(): AutoUpdaterLike {
		if (!this.deps.autoUpdater) {
			throw new Error("UpdateService automatic delivery requires an autoUpdater.");
		}
		return this.deps.autoUpdater;
	}

	private getManualChecker(): (latestReleaseUrl?: string) => Promise<ManualReleaseCheckResult> {
		if (!this.deps.checkManualAppUpdate) {
			throw new Error("UpdateService manual delivery requires a checkManualAppUpdate function.");
		}
		return this.deps.checkManualAppUpdate;
	}

	private pushSnapshot(): void {
		this.deps.sendToRenderer?.(this.getSnapshot());
	}

	/** 将 updater 的 reject/事件错误统一折叠为渲染层可展示的快照状态。 */
	private setDownloadError(error: string, preferredKind?: "check" | "download"): void {
		// 正在下包才叫下载失败；检查阶段（含手动交付只查不装）是检查失败。
		const errorKind = preferredKind ?? (this.download.phase === "downloading" ? "download" : "check");
		this.download = { ...this.download, phase: "error", error, errorKind };
		this.pushSnapshot();
	}

	/** 当前生效的下载状态：manual 由 ManualUpdateDelivery 持有，automatic 由 electron-updater 事件驱动。 */
	private getDownloadState(): AppUpdateDownloadState {
		return this.manualDelivery?.getState().download ?? this.download;
	}

	private scheduleNext(delayMs: number, intervalMs: number): void {
		if (this.disposed) return;
		const jitter = Math.floor(Math.random() * DEFAULT_JITTER_MAX_MS);
		const timer = setTimeout(
			() => {
				void this.checkNow().finally(() => {
					this.scheduleNext(intervalMs, intervalMs);
				});
			},
			Math.max(0, delayMs + jitter),
		);
		// 调度器不能成为 Electron 退出/Node 测试进程无法结束的唯一活跃句柄。
		timer.unref?.();
		this.timer = timer;
	}
}
