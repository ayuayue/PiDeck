import { useCallback, useState } from "react";
import type { AppSettings, PiInstallStatus, Project } from "../../../../shared/types";
import { desktopApi as api } from "../../desktopApi";
import { t } from "../../i18n";
import type { NoticeKind } from "../../utils/notice";

/** pi 环境面板的最小切片（设置写入会联动代理/WSL 检测提示） */
export interface SettingsUpdaterPiUpdate {
	setPiProxyNoticeTone: (tone: "info" | "error") => void;
	setPiProxyNotice: (notice: string) => void;
	setPiStatus: (status: PiInstallStatus) => void;
}

export interface SettingsUpdaterDeps {
	showToast: (message: string, duration?: number, kind?: NoticeKind) => void;
	piUpdate: SettingsUpdaterPiUpdate;
	onSettingsApplied: (next: AppSettings) => void;
	onProjectsChanged: (projects: Project[]) => void;
	activeProjectId: string | undefined;
	refreshProjectSessions: (projectId: string, silent?: boolean) => Promise<unknown>;
	webServiceEnabled: boolean;
}

/**
 * 设置写入域：updateSettings（按 patch 字段路由 toast/联动动作）与 restartWebService。
 * webServiceChanging 状态由本 hook 持有——它只服务于写入/重启期间的按钮禁用态。
 */
export function useSettingsUpdater({ showToast, piUpdate, onSettingsApplied, onProjectsChanged, activeProjectId, refreshProjectSessions, webServiceEnabled }: SettingsUpdaterDeps) {
	const [webServiceChanging, setWebServiceChanging] = useState(false);

	const updateSettings = useCallback(
		async (patch: Partial<AppSettings>) => {
			const changesWebService = "webServiceEnabled" in patch || "webServiceHost" in patch || "webServicePort" in patch || "webServiceRequiresAuth" in patch;
			if (changesWebService) {
				setWebServiceChanging(true);
				showToast(patch.webServiceEnabled === false ? t("app.webStopping") : t("app.webApplying"));
			}
			try {
				const next = await api.settings.update(patch);
				onSettingsApplied(next);
				let notice = t("app.settingsSaved");
				if ("piProxyEnabled" in patch || "piProxyUrl" in patch || "piProxyBypass" in patch || "piProxyModels" in patch) {
					notice = next.piProxyEnabled ? t("app.shellProxySaved") : t("app.shellProxyDisabled");
					piUpdate.setPiProxyNoticeTone("info");
					piUpdate.setPiProxyNotice(next.piProxyEnabled ? t("app.shellProxySaved") : "");
				}
				if ("desktopProxyEnabled" in patch || "desktopProxyUrl" in patch || "desktopProxyBypass" in patch) {
					notice = next.desktopProxyEnabled ? t("app.webProxySaved") : t("app.webProxyDisabled");
				}
				if ("sendShortcut" in patch) {
					notice = t("app.sendShortcutSaved");
				}
				if ("webServiceEnabled" in patch || "webServiceHost" in patch || "webServicePort" in patch || "webServiceRequiresAuth" in patch) {
					notice = next.webServiceEnabled ? t("app.webServiceStarted", { port: next.webServicePort }) : t("app.webServiceStopped");
				}
				if ("useNativeTitleBar" in patch) {
					notice = t("app.titleBarSaved");
				}
				// Chromium 沙箱依赖启动参数与 webPreferences，保存后必须整应用重启才生效。
				if ("electronChromiumSandbox" in patch) {
					notice = t("app.settingsSaved"); // sandbox 需重启
				}
				// 单实例锁在进程启动时申请，修改后需重启才切换多开/复用行为。
				if ("singleInstance" in patch) {
					notice = t("app.settingsSaved"); // 单实例需重启
				}
				// 启动窗口预设仅在下次 createWindow 时应用。
				if ("startupWindowMode" in patch) {
					notice = t("app.settingsSaved"); // 启动窗口需重启
				}
				// WSL/Windows pi 源切换：重新检测 pi 环境、刷新项目和会话列表
				if ("wslEnabled" in patch || "wslDistro" in patch || "wslUser" in patch) {
					// WSL 配置变更后强制重探：否则切换 distro/用户名仍会命中旧的 wsl:// 绝对路径缓存
					void api.pi
						.check(true)
						.then((next) => piUpdate.setPiStatus(next))
						.catch(() => undefined);
					void api.projects
						.list()
						.then((projects) => onProjectsChanged(projects))
						.catch(() => undefined);
					if (activeProjectId) {
						void refreshProjectSessions(activeProjectId, true).catch(() => undefined);
					}
				}
				showToast(notice);
				return true;
			} catch (error) {
				onSettingsApplied(await api.settings.get());
				showToast(error instanceof Error ? error.message : String(error));
				return false;
			} finally {
				if (changesWebService) setWebServiceChanging(false);
			}
		},
		[showToast, piUpdate, onSettingsApplied, onProjectsChanged, activeProjectId, refreshProjectSessions],
	);

	const restartWebService = useCallback(async () => {
		if (!webServiceEnabled || webServiceChanging) return;
		setWebServiceChanging(true);
		showToast(t("settings.webRestarting"));
		try {
			await api.settings.restartWebService();
			showToast(t("settings.webRestarted"));
		} catch (error) {
			showToast(error instanceof Error ? error.message : String(error));
		} finally {
			setWebServiceChanging(false);
		}
	}, [showToast, webServiceEnabled, webServiceChanging]);

	return { updateSettings, restartWebService, webServiceChanging };
}
