import { app, type BrowserWindow, Menu, nativeImage, Notification, Tray } from "electron";
import { join } from "node:path";
import type { AppSettings } from "../../shared/types";
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";
import { isLocalProject } from "../../shared/projectLocation";
import iconPath from "../../../build/icon.png?asset";
import { openSystemPath } from "../fs/openPath";
import { resolveLogoImage } from "../appWindowLogo";
import { startTrayRegistrationVerify, type TrayRegistrationVerify } from "../tray/trayRegistrationVerify";
import { buildTrayMenuTemplate, TRAY_RECENT_PROJECTS_LIMIT } from "../tray/trayMenuTemplate";
import type { FloatingController } from "../floating/FloatingController";
import type { ProjectStore } from "../projects/ProjectStore";
import type { QuitCleanupRegistry } from "../lifecycle/QuitCleanupRegistry";
import type { AppLogger } from "../logging/AppLogger";
import type { UpdateService } from "../update/UpdateService";

/** 跳转目标：与 index.ts 的 queueFocusTarget 参数同一形状（会话 / 已收录项目 / 新目录）。 */
export type FocusTarget = { sessionId: string } | { projectId: string } | { projectPath: string };

/** 托盘菜单文案/动作来源；托盘自身持有 tray 实例，其余单例仍由 index.ts 拥有。 */
export interface TrayDeps {
	appLogger(): AppLogger | null;
	settings(): AppSettings;
	projectStore(): ProjectStore;
	quitCleanup(): QuitCleanupRegistry;
	updateService(): UpdateService | null;
	floatingController(): FloatingController | null;
	restartApp(): void;
	markQuitting(): void;
	translate(key: MainProcessTranslationKey, params?: Record<string, string | number>): string;
	focusMainWindow(): void;
	queueFocusTarget(target: FocusTarget): void;
	getMainWindow(): BrowserWindow | null;
	revealMainWindow(window: BrowserWindow): void;
}

let tray: Tray | null = null;
/** Linux 托盘注册验收器（见 tray/trayRegistrationVerify.ts），退出清理里与 tray 一起停 */
let trayRegistrationVerify: TrayRegistrationVerify | null = null;

/** 托盘实例（registerIpc 的 shell/托盘相关 handler 需要）；未建托盘时为 null。 */
export function getTray(): Tray | null {
	return tray;
}

export function refreshTrayContextMenu(deps: TrayDeps): void {
	if (!tray) return;
	// 项目取非聊天项目前 N（ProjectStore.list 已按置顶/最近打开排序）；菜单在项目集变化时重建（broadcastVisibleProjects / projectsIpc 回调）。
	// 托盘菜单项带 path（供「在资源管理器中打开」一类动作）：远端项目没有本机 path，只列本机项目。
	const recentProjects = deps
		.projectStore()
		.list()
		.filter(isLocalProject)
		.filter((p) => p.kind !== "chat")
		.slice(0, TRAY_RECENT_PROJECTS_LIMIT)
		.map((p) => ({ id: p.id, name: p.name, path: p.path }));
	tray.setContextMenu(
		Menu.buildFromTemplate(
			buildTrayMenuTemplate(deps.translate, app.getVersion(), recentProjects, {
				showWindow: deps.focusMainWindow,
				checkUpdate: () => checkForUpdatesFromTray(deps),
				openProject: (projectId) => {
					// 与桌宠/通知同一条跳转链路：窗口置前 + renderer 按 projectId 切项目
					deps.queueFocusTarget({ projectId });
					deps.focusMainWindow();
				},
				openDataDir: () => {
					void openSystemPath(app.getPath("userData"));
				},
				openLogsDir: () => {
					void openSystemPath(join(app.getPath("userData"), "logs"));
				},
				restart: deps.restartApp,
				quit: () => {
					deps.markQuitting();
					app.quit();
				},
				toggleFloatingBall: (visible) => {
					if (visible) {
						void deps.floatingController()?.show();
					} else {
						deps.floatingController()?.hide();
					}
				},
				exitFloatingBall: () => {
					void deps.floatingController()?.exit();
				},
				isFloatingBallActive: () => deps.floatingController()?.isActive() ?? false,
			}),
		),
	);
}

/**
 * 托盘「检查更新」：走 UpdateService.checkNow（与渲染层手动检测同一链路，结果状态也同步给窗口 UI），
 * 完成后用系统通知告知结果；点击通知聚焦主窗口（渲染层已有更新横幅/下载入口）。
 */
export function checkForUpdatesFromTray(deps: TrayDeps): void {
	void (async () => {
		try {
			const updateService = deps.updateService();
			if (updateService) {
				await updateService.checkNow();
				const snapshot = updateService.getSnapshot();
				const latest = snapshot.app?.latestVersion;
				if (snapshot.app?.hasUpdate && latest) {
					notifyFromTray(deps, deps.translate("tray.updateAvailableTitle"), deps.translate("tray.updateAvailableBody", { version: latest }));
					return;
				}
			}
			notifyFromTray(deps, deps.translate("tray.upToDateTitle"), deps.translate("tray.upToDateBody", { version: app.getVersion() }));
		} catch (error) {
			const appLogger = deps.appLogger();
			void appLogger?.warn("update", "Tray update check failed", { error: error instanceof Error ? error.message : String(error) });
			notifyFromTray(deps, deps.translate("update.checkFailed"), "");
		}
	})();
}

/** 托盘通知：点击即聚焦主窗口（更新/最新两种结果都引导回窗口）。 */
export function notifyFromTray(deps: TrayDeps, title: string, body: string): void {
	const notification = new Notification({ title, body, silent: false });
	notification.on("click", () => deps.focusMainWindow());
	notification.show();
}

export function setupTray(deps: TrayDeps): void {
	// 托盘图标跟随设置里的「Logo 风格」；resolveLogoImage 按风格选 build/icon.png 或 icon-pi-tui.png
	// （均由 electron-vite 的 ?asset 后缀解析，打包后也能正确定位）；custom 风格读设置里的自定义图。
	// 资源缺失时降级回 classic iconPath：托盘必须建得出来——closeToTray 开启时它是唯一的唤回入口。
	const trayLogoSettings = deps.settings();
	const icon = resolveLogoImage(trayLogoSettings.logoStyle, trayLogoSettings.logoCustomImage)?.image ?? nativeImage.createFromPath(iconPath);

	/** 创建托盘实例；首次创建与自愈重建共用同一条路径，避免两处行为漂移。 */
	const createTrayInstance = (): Tray => {
		const instance = new Tray(icon.resize({ width: 16, height: 16 }));
		instance.setToolTip("PiDeck");
		// 双击托盘图标恢复窗口（Windows 常见交互）；走统一唤起口，最小化时也会回到原呈现态
		instance.on("double-click", () => {
			const mainWindow = deps.getMainWindow();
			if (mainWindow && !mainWindow.isDestroyed()) deps.revealMainWindow(mainWindow);
		});
		return instance;
	};

	tray = createTrayInstance();
	refreshTrayContextMenu(deps);
	// 项目集变化（增删/重命名/最近打开排序）经 ProjectStore.onChanged 统一派发，重建托盘「最近项目」区。
	const stopTrayProjectListener = deps.projectStore().onChanged(() => refreshTrayContextMenu(deps));

	// C12：退出清理登记（before-quit 统一 runAll）——验收器必须一起停，
	// 否则退出阶段还会把已销毁的 tray 再重建一次。
	deps.quitCleanup().register("tray", () => {
		stopTrayProjectListener();
		trayRegistrationVerify?.stop();
		trayRegistrationVerify = null;
		tray?.destroy();
		tray = null;
	});

	// Linux/GNOME 托盘注册诊断（见 tray/trayRegistrationVerify.ts）：Electron 43.3.0–43.4.1 的 SNI
	// multiplexer 只认 well-known destination，宿主按 unique name 读属性必失败并永久放弃图标
	// （closeToTray 默认开启时，用户点 X 隐藏后就再无唤回入口）。Electron ≥ 43.5.0 已修复
	// （issue #521 / electron#53215，见 docs/electron-playbook.md §Linux 托盘）。
	// 这里只验收并记日志，不做重建 —— 重建换名并不能改变宿主的读法，实测无效。
	if (process.platform === "linux") {
		trayRegistrationVerify = startTrayRegistrationVerify({
			onUnregistered: (detail) => {
				const appLogger = deps.appLogger();
				void appLogger?.warn("app", "tray verify: unregistered, see docs/electron-playbook.md §Linux 托盘", detail);
			},
			onLog: (message, detail) => {
				const appLogger = deps.appLogger();
				void appLogger?.info("app", message, detail);
			},
		});
	}
}
