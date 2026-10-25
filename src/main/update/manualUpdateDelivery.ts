/**
 * 手动交付更新的下载/打开状态机。
 *
 * 从 UpdateService 拆出：manual 模式没有 electron-updater，状态完全由本地检查结果 +
 * 下载进度驱动。单独成类让「检查结果如何落成 available/ready」「下载单飞与退出中止」
 * 「打开安装包不回退 ready」三件事可独立推理，也让 UpdateService 保持只做装配与自动链路。
 *
 * 外部只通过 getState() 读快照；每次状态变更经 deps.onChange 通知宿主 push 快照。
 */

import type { AppManualUpdateRelease, AppUpdateDownloadState } from "../../shared/types/app";
import type { InstallerDownloadProgress } from "./installerDownload";
import type { ManualReleaseCheckResult } from "./macManualUpdate";

export type ManualUpdateDeliveryState = {
	download: AppUpdateDownloadState;
	recommendedDownload: AppManualUpdateRelease | null;
};

export type ManualUpdateDeliveryDeps = {
	/** 装配层注入：流式下载 + digest 校验后返回落盘路径。 */
	downloadManualUpdate?: (release: AppManualUpdateRelease, options: { signal?: AbortSignal; onProgress?: (progress: InstallerDownloadProgress) => void }) => Promise<string>;
	/** 装配层注入：打开已下载安装包（mac 挂载 dmg / 其他平台定位文件）。 */
	openManualInstaller?: (filePath: string) => Promise<void>;
	/** 状态变化后通知宿主（UpdateService.pushSnapshot）。 */
	onChange: () => void;
	log?: (level: "info" | "warn", message: string, details?: Record<string, unknown>) => void;
};

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class ManualUpdateDelivery {
	private downloadState: AppUpdateDownloadState = { phase: "idle" };
	private recommended: AppManualUpdateRelease | null = null;
	/** 校验通过后才写入；open() 只打开这个内部路径。 */
	private installerPath: string | null = null;
	/** 进行中的下载：并发防护 + 退出时 abort。 */
	private controller: AbortController | null = null;
	private disposed = false;

	constructor(private readonly deps: ManualUpdateDeliveryDeps) {}

	getState(): ManualUpdateDeliveryState {
		return { download: this.downloadState, recommendedDownload: this.recommended };
	}

	/** 检查阶段进入 checking；已下载/下载中/安装中不被检查覆盖。 */
	markChecking(): void {
		if (this.downloadState.phase === "ready" || this.downloadState.phase === "downloading" || this.downloadState.phase === "installing") return;
		this.downloadState = { ...this.downloadState, phase: "checking", error: undefined, errorKind: undefined };
		this.deps.onChange();
	}

	/**
	 * 应用一轮检查结果：
	 * - 同版本已下载 → 保留 ready（用户仍可打开安装包），只刷新推荐信息；
	 * - 有新版本 → available（目标版本变化时丢掉旧安装包路径）；
	 * - 无更新 → idle。
	 */
	applyCheckResult(result: ManualReleaseCheckResult): void {
		const readyVersion = this.downloadState.phase === "ready" ? this.downloadState.version : undefined;
		if (readyVersion && (!result.hasUpdate || readyVersion === result.latestVersion)) {
			if (result.recommendedDownload) this.recommended = result.recommendedDownload;
			return;
		}
		if (result.hasUpdate) {
			this.recommended = result.recommendedDownload ?? null;
			this.installerPath = null;
			this.downloadState = { phase: "available", version: result.latestVersion };
			return;
		}
		this.recommended = null;
		this.installerPath = null;
		this.downloadState = { phase: "idle" };
	}

	/** 检查失败：保留已下载的 ready 包；否则进入 error（errorKind=check，UI 显示重试检测）。 */
	setCheckError(error: string): void {
		if (this.downloadState.phase === "ready") return;
		this.downloadState = { ...this.downloadState, phase: "error", error, errorKind: "check" };
		this.deps.onChange();
	}

	/** 单飞下载推荐安装包；进度/完成/失败都经 onChange 推快照。 */
	async download(): Promise<void> {
		if (this.controller || this.downloadState.phase === "installing") {
			void this.deps.log?.("warn", "Ignored manual download request while another download is in progress");
			return;
		}
		const release = this.recommended;
		if (!release) {
			this.setDownloadError("No installer matches this device. Open the release page to choose manually.");
			return;
		}
		if (!this.deps.downloadManualUpdate) {
			this.setDownloadError("Manual update downloads are not configured for this build.");
			return;
		}
		const controller = new AbortController();
		this.controller = controller;
		this.installerPath = null;
		this.downloadState = { phase: "downloading", version: release.version, percent: 0, error: undefined, errorKind: undefined };
		this.deps.onChange();
		try {
			const installerPath = await this.deps.downloadManualUpdate(release, {
				signal: controller.signal,
				onProgress: (progress) => {
					// stop()/新一轮检查会 abort 并替换 controller：迟到进度不得覆盖新状态。
					if (this.disposed || this.controller !== controller) return;
					this.downloadState = {
						phase: "downloading",
						version: release.version,
						percent: progress.percent,
						bytesPerSecond: progress.bytesPerSecond,
						transferred: progress.transferred,
						total: progress.total,
					};
					this.deps.onChange();
				},
			});
			if (this.disposed || this.controller !== controller) return;
			this.installerPath = installerPath;
			this.downloadState = { phase: "ready", version: release.version, percent: 100 };
			void this.deps.log?.("info", "Manual update package downloaded", { version: release.version, assetName: release.assetName });
			this.deps.onChange();
		} catch (error) {
			if (this.disposed || this.controller !== controller) return;
			this.setDownloadError(toErrorMessage(error));
		} finally {
			if (this.controller === controller) this.controller = null;
		}
	}

	/** 打开已下载安装包；失败保持 ready + error，允许重试。 */
	open(): void {
		if (this.downloadState.phase !== "ready" || !this.installerPath) {
			void this.deps.log?.("warn", "Ignored manual installer request without a downloaded package");
			return;
		}
		if (!this.deps.openManualInstaller) {
			this.setReadyError("Opening the downloaded installer is not configured for this build.");
			return;
		}
		const filePath = this.installerPath;
		void this.deps
			.openManualInstaller(filePath)
			.then(() => {
				if (this.disposed) return;
				this.downloadState = { ...this.downloadState, phase: "ready", percent: 100, error: undefined };
				void this.deps.log?.("info", "Opened manual update package", { filePath });
				this.deps.onChange();
			})
			.catch((error: unknown) => {
				if (this.disposed) return;
				this.setReadyError(`Could not open the downloaded installer: ${toErrorMessage(error)}`);
			});
	}

	/** 退出路径：中止进行中的下载（迟到结果由 controller/disposed 双闸丢弃）。 */
	stop(): void {
		this.disposed = true;
		this.controller?.abort();
		this.controller = null;
	}

	private setDownloadError(error: string): void {
		// 手动下载没有「检查失败」分支：进入这里就是下载失败，UI 显示重试下载。
		this.downloadState = { ...this.downloadState, phase: "error", error, errorKind: "download" };
		this.deps.onChange();
	}

	private setReadyError(error: string): void {
		this.downloadState = { ...this.downloadState, phase: "ready", percent: 100, error };
		void this.deps.log?.("warn", "Could not open manual update package", { error });
		this.deps.onChange();
	}
}
