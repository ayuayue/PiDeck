import type { AppInfo } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { useAtomValue } from "jotai";
import { updateStatusAtom } from "../../../atoms/update-atoms";
import { Button } from "../../ui-shadcn/button";
import { Progress } from "../../ui-shadcn/progress";

type AppUpdateCardProps = {
	/** 当前 PiDeck 版本（设置里显示 vX.Y.Z）。 */
	appVersion: string;
	/** 当前运行平台；macOS 无签名发行物使用手动更新交付。 */
	platform: AppInfo["platform"];
	/** 由主进程统一提供的受信任 Release 页面地址。 */
	releasesUrl: string;
	/** 检查中（主进程快照 phase=checking 的渲染层派生，按钮 loading 用）。 */
	checking: boolean;
	onCheckUpdate: () => void;
	onDownloadUpdate: () => void;
	onInstallUpdate: () => void;
};

function formatSpeed(bytesPerSecond?: number): string {
	if (!bytesPerSecond || bytesPerSecond <= 0) return "";
	const units = ["B/s", "KB/s", "MB/s"];
	let value = bytesPerSecond;
	let index = 0;
	while (value >= 1024 && index < units.length - 1) {
		value /= 1024;
		index += 1;
	}
	return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

/**
 * 版本与更新卡片（快照驱动，无本地状态副本）。
 *
 * 状态优先级（对齐 Netcatty 设置卡片）：
 *   downloading（进度条）> installing（等待退出）> ready（重启并安装）> error（重试/打开 Release）
 *   > checking（loading）> available（自动下载关闭时手动下载）
 *   > idle + hasUpdate（发现新版本）> idle + 已检查（已是最新）。
 */
export function AppUpdateCard(props: AppUpdateCardProps) {
	const updateStatus = useAtomValue(updateStatusAtom);
	const app = updateStatus?.app ?? null;
	const download = app?.download ?? null;
	const phase = download?.phase ?? "idle";
	const autoDownload = updateStatus?.autoDownload !== false;
	const isManualDelivery = updateStatus?.deliveryMode === "manual" || props.platform === "darwin";

	const openRelease = () => {
		const releaseBaseUrl = props.releasesUrl.replace(/\/$/, "");
		const version = app?.latestVersion?.replace(/^v/i, "");
		const releaseUrl = version
			? `${releaseBaseUrl}/tag/v${encodeURIComponent(version)}`
			: releaseBaseUrl;
		void desktopApi.app.openExternal(releaseUrl, true);
	};

	return (
		<div className="mb-3 rounded-md border border-border-subtle bg-panel px-3 py-2">
			<div className="flex items-center justify-between">
				<span className="text-body">
					{t("app.updateCardVersion", { version: props.appVersion })}
				</span>
				<Button
					variant="secondary"
					size="sm"
					onClick={props.onCheckUpdate}
					loading={props.checking || phase === "checking"}
				>
					{t("settings.checkUpdate")}
				</Button>
			</div>

			{/* downloading：进度条 + 速度 */}
			{download && download.phase === "downloading" && (
				<div className="mt-2 space-y-1">
					<div className="flex items-center justify-between text-caption text-muted-foreground">
						<span>
							{t("settings.updateDownloading", { version: download.version ?? "" })}
						</span>
						<span>
							{download.percent != null ? `${download.percent.toFixed(1)}%` : ""}
							{formatSpeed(download.bytesPerSecond) ? ` · ${formatSpeed(download.bytesPerSecond)}` : ""}
						</span>
					</div>
					<Progress value={download.percent ?? 0} aria-label={t("settings.updateDownloading", { version: "" })} />
				</div>
			)}

			{/* installing：已向主进程请求退出，等待 electron-updater 接管安装。 */}
			{download && download.phase === "installing" && (
				<div className="mt-2 flex items-center gap-2">
					<p className="text-caption text-muted-foreground">
						{t("settings.updateInstalling", { version: download.version ?? app?.latestVersion ?? "" })}
					</p>
				</div>
			)}

			{/* ready：可重启安装；若上一次请求未能启动安装器，保留包和重试入口。 */}
			{download && download.phase === "ready" && (
				<div className="mt-2 flex items-center justify-between gap-2">
					<p className={`text-caption ${download.error ? "text-destructive" : "text-success"}`}>
						{download.error
							? t("settings.updateInstallFailed", { error: download.error })
							: t("settings.updateReadyToInstall", { version: download.version ?? app?.latestVersion ?? "" })}
					</p>
					<Button variant="default" size="sm" onClick={props.onInstallUpdate}>
						{t("settings.updateInstallNow")}
					</Button>
				</div>
			)}

			{/* error：失败可重试 */}
			{download && download.phase === "error" && (
				<div className="mt-2 flex flex-col gap-1">
					<p className="text-caption text-destructive">
						{t("settings.updateErrorDetail", { error: download.error ?? t("common.unknown") })}
					</p>
					<div className="flex gap-2">
						<Button variant="ghost" size="sm" onClick={props.onCheckUpdate}>
							{t("settings.checkUpdateRetry")}
						</Button>
						<Button variant="ghost" size="sm" onClick={openRelease}>
							{t("update.openRelease")}
						</Button>
					</div>
				</div>
			)}

			{/* available：macOS 无签名发行物只能跳转 Release 手动安装 */}
			{download && download.phase === "available" && isManualDelivery && (
				<div className="mt-2 flex items-center justify-between gap-2">
					<p className="text-caption text-accent">
						{t("settings.updateManualAvailable", { version: download.version ?? "" })}
					</p>
					<Button variant="secondary" size="sm" onClick={openRelease}>
						{t("update.openRelease")}
					</Button>
				</div>
			)}

			{/* available：自动下载关闭时手动下载 */}
			{download && download.phase === "available" && !isManualDelivery && !autoDownload && (
				<div className="mt-2 flex items-center justify-between gap-2">
					<p className="text-caption text-accent">
						{t("settings.updateAvailable", { version: download.version ?? "" })}
					</p>
					<div className="flex gap-2">
						<Button variant="secondary" size="sm" onClick={props.onDownloadUpdate}>
							{t("settings.updateDownloadNow")}
						</Button>
						<Button variant="ghost" size="sm" onClick={openRelease}>
							{t("update.openRelease")}
						</Button>
					</div>
				</div>
			)}

			{/* idle + hasUpdate（已提示过/已跳过版本时仅展示信息） */}
			{phase === "idle" && app?.hasUpdate && (
				<div className="mt-2 flex items-center justify-between gap-2">
					<p className="text-caption text-accent">
						{t("settings.updateAvailable", { version: app.latestVersion ?? "" })}
					</p>
					<Button variant="ghost" size="sm" onClick={openRelease}>
						{t("update.openRelease")}
					</Button>
				</div>
			)}

			{/* 已是最新（成功检查且无更新） */}
			{phase === "idle" && app && !app.hasUpdate && updateStatus?.lastCheckAt && (
				<p className="mt-2 text-caption text-success">
					{t("settings.updateUpToDate")}
				</p>
			)}
		</div>
	);
}
