import { useEffect, useRef } from "react";
import { useSetAtom } from "jotai";
import type { PiDesktopApi } from "../../../preload";
import { updateStatusAtom } from "../atoms/update-atoms";
import { t } from "../i18n";
import { showNotice, type NoticeActions } from "../utils/notice";

export type BackgroundUpdateWatchOptions = {
	api: PiDesktopApi;
	/** 打开设置页（toast 动作跳转「版本与更新」）。 */
	openSettings: () => void;
};

/**
 * 后台更新状态订阅（electron-updater 快照驱动，无弹窗打扰）。
 *
 * 通知规则（对齐 Netcatty 语义）：
 *   - 自动下载开启：下载完成后 toast 引导至设置页；设置页在确认草稿安全后才允许安装；
 *   - 下载失败或安装器未能启动：toast 错误并跳转设置页重试；
 *   - 检查失败（含 macOS 只查不装）：toast「检查更新失败」，不说成下载失败；
 *   - Pi CLI：hasUpdate 且未提示过 → toast 一次并立即 notifySeen（入口在设置页）。
 * 本地 ref 兜一层去重，防快照重发/异步标记竞态导致重复 toast。
 */
export function useBackgroundUpdateWatch(options: BackgroundUpdateWatchOptions): void {
	const { api, openSettings } = options;
	const setUpdateStatus = useSetAtom(updateStatusAtom);
	const notifiedRef = useRef<{ app?: string; pi?: string; ready?: string; error?: string }>({});

	useEffect(() => {
		// 初始拉取当前快照（挂载晚于主进程首查时也能拿到状态）。
		void api.app.getUpdateStatus().then((snapshot) => {
			if (snapshot) setUpdateStatus(snapshot);
		});

		const settingsAction: NoticeActions = {
			action: { label: t("update.viewInSettings"), onClick: openSettings },
		};

		const unsubscribe = api.app.onUpdateStatus((snapshot) => {
			setUpdateStatus(snapshot);

			const appStatus = snapshot?.app;
			const download = appStatus?.download;
			const autoDownload = snapshot?.autoDownload !== false;
			const isManualDelivery = snapshot?.deliveryMode === "manual";

			if (appStatus?.hasUpdate && download?.phase === "ready" && download.error) {
				// 安装器未能接管时，保留 ready 包供重试，同时把用户带回唯一的受保护安装入口。
				const errorKey = `${appStatus.latestVersion ?? ""}:${download.error}`;
				if (notifiedRef.current.error !== errorKey) {
					notifiedRef.current.error = errorKey;
					showNotice(t("update.installFailedDetail", { error: download.error }), 0, "error", t("update.installFailedTitle"), settingsAction);
				}
				return;
			}

			if (appStatus?.hasUpdate && download?.phase === "ready") {
				// 下载完成后只跳转设置页：设置页负责未保存草稿确认，再由用户明确安装/打开。
				// 不复用 notifiedVersion：manual 模式下「发现新版本」已标记过，下载完成仍需提示一次。
				const version = download.version ?? appStatus.latestVersion ?? "";
				if (version && notifiedRef.current.ready !== version) {
					notifiedRef.current.ready = version;
					void api.app.notifyUpdateSeen("app", version);
					showNotice(t(isManualDelivery ? "update.manualReadyToast" : "update.readyToInstall", { version }), 0, "info", t("update.readyToInstallTitle"), settingsAction);
				}
				return;
			}

			if (download?.phase === "error") {
				// 检查失败和下载失败文案分开：macOS 只查不装，不能说成「下载失败」。
				const isDownloadError = download.errorKind === "download";
				const errorKey = `${appStatus?.latestVersion ?? ""}:${download.errorKind ?? "check"}:${download.error ?? ""}`;
				if (notifiedRef.current.error !== errorKey && !errorKey.endsWith(":")) {
					notifiedRef.current.error = errorKey;
					showNotice(
						t(isDownloadError ? "update.downloadFailedDetail" : "update.checkFailedDetail", {
							error: download.error ?? "",
						}),
						0,
						"error",
						t(isDownloadError ? "update.downloadFailedTitle" : "update.checkFailedTitle"),
						settingsAction,
					);
				}
				return;
			}

			if (download?.phase === "available" && (isManualDelivery || !autoDownload)) {
				// macOS 无签名发行物和关闭自动下载时均提示新版本；前者只提供 Release 手动安装。
				const version = download.version ?? "";
				if (version && appStatus?.skippedVersion !== version && appStatus?.notifiedVersion !== version && notifiedRef.current.app !== version) {
					notifiedRef.current.app = version;
					void api.app.notifyUpdateSeen("app", version);
					showNotice(isManualDelivery ? t("update.availableManualToast", { version }) : t("update.availableToast", { version }), 8000, "info", t("update.availableToastTitle"), settingsAction);
				}
				return;
			}

			const piStatus = snapshot?.piCli;
			if (piStatus?.hasUpdate && piStatus.latestVersion && piStatus.latestVersion !== piStatus.notifiedVersion && notifiedRef.current.pi !== piStatus.latestVersion) {
				notifiedRef.current.pi = piStatus.latestVersion;
				// 立即标记已提示（主进程持久化），重启后同一版本不再打扰。
				void api.app.notifyUpdateSeen("pi", piStatus.latestVersion);
				showNotice(t("settings.piUpdateAvailable"), 8000, "info");
			}
		});

		return () => unsubscribe();
	}, [api, openSettings, setUpdateStatus]);
}
