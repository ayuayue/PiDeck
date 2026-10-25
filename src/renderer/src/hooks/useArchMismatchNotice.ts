import { useEffect } from "react";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { ARCH_MISMATCH_DISMISSED_KEY, buildLatestReleaseUrl, shouldShowArchMismatchNotice } from "../utils/archMismatchNotice";

/**
 * 启动时检测「x64 包跑在 Apple Silicon 转译层下」（Rosetta 2）并提示换装 arm64 原生包。
 *
 * 背景（2026-10 用户反馈）：Release 页 x64 dmg 无架构后缀，M 系列用户当成默认包安装，
 * 整个 Chromium/V8 全程 Rosetta 转译，表现为「应用很卡」。修复分两半：
 * ① 打包侧 mac artifactName 显式带 ${arch}（package.json），x64 产物不再无后缀；
 * ② 本 hook 兜底已装错的存量用户。
 *
 * 用户点「不再提示」后写 localStorage 永久关闭（本机一直用 x64 包是合法选择）；
 * 检测链路任何失败都静默——提示功能绝不能影响启动。
 */
export function useArchMismatchNotice(): void {
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				if (localStorage.getItem(ARCH_MISMATCH_DISMISSED_KEY) === "1") return;
				const status = await desktopApi.system.getArchStatus();
				if (cancelled) return;
				if (!shouldShowArchMismatchNotice(status, localStorage.getItem(ARCH_MISMATCH_DISMISSED_KEY) === "1")) return;
				const info = await desktopApi.app.info();
				if (cancelled) return;
				const latestUrl = buildLatestReleaseUrl(info.releasesUrl);
				showNotice(t("app.archMismatchBody"), 15000, "warning", t("app.archMismatchTitle"), {
					// 主按钮：直达最新发布页，用户自己选带 arm64 后缀的 dmg
					action: {
						label: t("app.archMismatchAction"),
						onClick: () => {
							void desktopApi.app.openExternal(latestUrl, true);
						},
					},
					// 次按钮：永久不再提示
					cancel: {
						label: t("app.archMismatchDismiss"),
						onClick: () => {
							localStorage.setItem(ARCH_MISMATCH_DISMISSED_KEY, "1");
						},
					},
				});
			} catch {
				// 静默：架构提示失败不影响任何功能
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);
}
