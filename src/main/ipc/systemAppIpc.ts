/**
 * 应用信息 / 更新 / 外部链接 / 重启 / 窗口控制 IPC 域（自 systemIpc.ts 拆出：handler 体、通道、
 * 日志与文案逐字未改）。通道：app:info / app:network-addresses / app:preferred-system-languages /
 * app:check-update / app:get-channel / app:download-update / app:install-update /
 * app:update-status-changed / app:update-notify-seen / app:update-skip-version /
 * app:check-update-mirrors / app:feedback-environment / app:open-external / app:get-changelog /
 * app:restart / app:quit / app:open-data-dir / app:window-* / app:toggle-dev-tools。
 */
import { app, ipcMain } from "electron";
import { join } from "node:path";
import { ipcChannels } from "../../shared/ipc";
import type { AppInfo, ChangelogPayload } from "../../shared/types";
import { DSH_BUNDLED_RUNTIME_DIRNAME, readBundledRuntime, readDeclaredDshVersion } from "../dsh/runtime/DshRuntimeManager";
import type { ChangelogLanguage } from "../update/ChangelogService";
import { ChangelogService } from "../update/ChangelogService";
import type { MirrorHealthResult } from "../update/mirrorHealth";
import { probeAllMirrors } from "../update/mirrorHealth";
import { resolveBuildOrigin } from "../buildIdentity";
import { isDevChannelBuild, resolveUpdateChannel } from "../update/channelIdentity";
import { REMOTE_FEATURE_AVAILABLE } from "../remote/remoteFeaturePolicy";
import { UPDATE_REPO, UPDATE_REPO_OWNER } from "../update/releaseRepo";
import { normalizeUpdateSource } from "../update/updateSources";
import { resolveAppTimes } from "../utils/appInfoTimes";
import { readBuiltinPiAiCatalogVersion } from "../pi/piAiBuiltinCatalog";
import { openSystemPath } from "../fs/openPath";
import { listWebNetworkAddresses } from "../web/WebNetwork";
import { toggleMainWindowDevTools } from "../devTools";
import type { AgentManager } from "../pi/AgentManager";
import type { AppLogger } from "../logging/AppLogger";
import type { PiLocator } from "../pi/PiLocator";
import type { SettingsStore } from "../settings/SettingsStore";

export type SystemAppIpcDeps = {
	settingsStore: SettingsStore;
	piLocator: PiLocator;
	appLogger: AppLogger;
	agentManager: AgentManager;
	getMainWindow: () => Electron.BrowserWindow | null;
	/** Open external URL */
	openExternalUrl: (url: string, forceSystem?: boolean) => Promise<void>;
	/** Releases URL */
	RELEASES_URL?: string;
	/** 开发态 git 分支名（多 worktree 并行区分窗口）；正式包/共享分支为空。 */
	devBranch?: string;
	/** DSH 运行时管理器（读取启用中的 runtime 版本，随包 bundled manifest 兜底）。 */
	dshRuntimeManager?: import("../dsh/runtime/DshRuntimeManager").DshRuntimeManager;
	/** 后台更新检查服务（定时检查快照推送 / 已提示 / 跳过版本 / 立即检查 / 下载 / 安装）。 */
	updateService?: {
		getSnapshot: () => import("../../shared/types").AppUpdateStatusSnapshot;
		notifySeen: (kind: "app" | "pi", version: string) => Promise<void>;
		skipVersion: (version: string) => Promise<void>;
		checkNow: () => Promise<void>;
		downloadNow: () => Promise<void>;
		installNow: () => void;
	};
	/** Is quitting flag (for restart) */
	isQuitting?: { value: boolean };
	/** Web service manager for restart */
	webServiceManager?: { stop: () => Promise<void> };
	/** Terminal manager for restart */
	terminalManager?: { closeAll: () => void };
};

export function registerSystemAppIpc(deps: SystemAppIpcDeps): void {
	const { settingsStore, piLocator, appLogger, agentManager, getMainWindow, openExternalUrl: doOpenExternalUrl, RELEASES_URL, devBranch, dshRuntimeManager, updateService, isQuitting, webServiceManager, terminalManager } = deps;

	/**
	 * 解析「关于」面板要展示的 DSH 运行时版本：优先用户已激活/安装的 runtime（resolveActive），
	 * 无则回退到随包 bundled runtime 清单；两者都没有（如 dev 模式未接 dsh-runtime）返回 undefined。
	 */
	function resolveDshRuntimeVersion(manager: SystemAppIpcDeps["dshRuntimeManager"]): string | undefined {
		const active = manager?.resolveActive();
		if (active?.manifest.runtimeVersion) return active.manifest.runtimeVersion;
		const bundled = readBundledRuntime(join(typeof process.resourcesPath === "string" ? process.resourcesPath : "", DSH_BUNDLED_RUNTIME_DIRNAME), app.getVersion());
		if (bundled?.manifest.runtimeVersion) return bundled.manifest.runtimeVersion;
		// 兜底：版本依赖（package.json 声明的 @deepseek-ai/dsh）。无论用户是否安装 runtime、
		// dev 还是打包态（asar 内 package.json 可读），都能给出「本版本配套」的 dsh 版本。
		return readDeclaredDshVersion(app.getAppPath());
	}

	// ── 应用信息 ─────────────────────────────────────────────────────

	// appInfo 现在包含 pi / DSH runtime / pi-ai 目录版本探测（pi 需要 spawn 一次进程），
	// 结果按进程生命周期缓存：并发请求共享同一 in-flight promise，失败也缓存，
	// 避免每次打开/启动反复 spawn `pi --version` 拖慢路径。
	let appInfoPromise: Promise<AppInfo> | undefined;

	const resolveAppInfo = (): Promise<AppInfo> => {
		appInfoPromise ??= (async () => {
			let piVersion: string | undefined;
			try {
				// 与设置页/反馈环境一致：用当前设置的 WSL 配置探测 pi CLI 版本
				const settings = settingsStore.get();
				const status = await piLocator.check(settings.customPiPath, settings.wslEnabled, settings.wslDistro, settings.wslUser);
				piVersion = status.version;
			} catch (error) {
				appLogger.warn("appInfo", "pi version probe failed", { error });
			}
			const times = resolveAppTimes({
				isPackaged: app.isPackaged,
				resourcesPath: typeof process.resourcesPath === "string" ? process.resourcesPath : "",
				appPath: app.getAppPath(),
				execPath: process.execPath,
			});
			return {
				version: app.getVersion(),
				releasesUrl: RELEASES_URL ?? `https://github.com/${UPDATE_REPO_OWNER}/${UPDATE_REPO}/releases`,
				platform: process.platform,
				// 数据目录直接取实际生效路径：便携版（exe 同级 data/）、安装版、dev 模式（-dev 后缀）由主进程统一解析
				userDataDir: app.getPath("userData"),
				homeDir: app.getPath("home"),
				devBranch: devBranch,
				piVersion,
				dshRuntimeVersion: resolveDshRuntimeVersion(dshRuntimeManager),
				piAiVersion: readBuiltinPiAiCatalogVersion(),
				electronVersion: process.versions.electron ?? "",
				chromeVersion: process.versions.chrome ?? "",
				nodeVersion: process.versions.node,
				...times,
			};
		})();
		return appInfoPromise;
	};

	ipcMain.handle(ipcChannels.appInfo, resolveAppInfo);

	ipcMain.handle(ipcChannels.appNetworkAddresses, () => listWebNetworkAddresses());

	ipcMain.handle(ipcChannels.appPreferredSystemLanguages, () => {
		try {
			return app.getPreferredSystemLanguages();
		} catch {
			return [];
		}
	});

	// ── 应用更新（electron-updater 事件驱动；结果统一经 app:update-status-changed 快照推送）──

	ipcMain.handle(ipcChannels.appCheckUpdate, async () => {
		await updateService?.checkNow();
	});
	// 当前更新通道（编译期判定）：version 与 getAppInfo 同源（都是 app.getVersion()），
	// 不复用 appInfoPromise —— 那份缓存含 pi --version spawn，只为取版本不值得连带。
	ipcMain.handle(ipcChannels.appGetChannel, () => ({
		channel: resolveUpdateChannel(),
		currentVersion: app.getVersion(),
		// 构建身份：未打包 dev 或 dev 通道包为 true，stable 安装包恒 false（仅表示构建身份）。
		devBuild: isDevChannelBuild(),
		// 远端能力与更新通道正交；渲染层只读这一项决定是否展示入口。
		remoteAvailable: REMOTE_FEATURE_AVAILABLE,
		// 来源与通道正交：本地打包的 stable 包在更新界面上与官方发布包同形，靠这个字段区分。
		buildOrigin: resolveBuildOrigin(),
	}));
	ipcMain.handle(ipcChannels.appDownloadUpdate, async () => {
		await updateService?.downloadNow();
	});
	ipcMain.handle(ipcChannels.appInstallUpdate, async () => {
		updateService?.installNow();
	});
	// 后台更新检查快照：主进程定时检查后主动推送（渲染层角标/每版本一次提示）；
	// 渲染层也可主动拉取当前快照（如手动检测完成后刷新角标）。
	ipcMain.handle(ipcChannels.appUpdateStatusChanged, () => updateService?.getSnapshot() ?? null);
	ipcMain.handle(ipcChannels.appUpdateNotifySeen, async (_event, kind: unknown, version: unknown) => {
		if (!updateService) return;
		// 输入校验：kind 只允许 app/pi，version 必须是字符串，否则拒绝（渲染层数据不可信）。
		if (kind !== "app" && kind !== "pi") return;
		if (typeof version !== "string" || !version) return;
		await updateService.notifySeen(kind, version);
	});
	ipcMain.handle(ipcChannels.appUpdateSkipVersion, async (_event, version: unknown) => {
		if (!updateService) return;
		if (typeof version !== "string" || !version) return;
		await updateService.skipVersion(version);
	});

	// 内置更新镜像体检：并行探测各镜像 latest.yml + Range 分片（设置页「更新源」自动体检；
	// 纯网络只读操作、无状态，不依赖 updateService，失败由镜像上报，不向外抛）。
	ipcMain.handle(ipcChannels.appCheckUpdateMirrors, async (): Promise<MirrorHealthResult[]> => {
		return probeAllMirrors();
	});

	// ── 反馈环境 ─────────────────────────────────────────────────────

	ipcMain.handle(ipcChannels.appFeedbackEnvironment, async () => {
		const settings = settingsStore.get();
		const pi = await piLocator.check(settings.customPiPath, settings.wslEnabled, settings.wslDistro, settings.wslUser);
		return {
			appVersion: app.getVersion(),
			platform: process.platform,
			arch: process.arch,
			electronVersion: process.versions.electron ?? "",
			chromeVersion: process.versions.chrome ?? "",
			nodeVersion: process.versions.node,
			pi,
		};
	});

	// ── 外部链接 / 重启 / 窗口控制 ──────────────────────────────────

	ipcMain.handle(ipcChannels.appOpenExternal, async (_event, url: string, forceSystem?: boolean) => {
		await doOpenExternalUrl(url, forceSystem);
	});

	/**
	 * 拉取更新日志正文（「关于」弹框与更新卡片两处共用）。
	 *
	 * 入参 language 只做白名单收窄：渲染层来的数据一律不可信，非法值按中文处理。
	 * 失败（全部源挂掉/内容校验不过）不抛错，返回 markdown=null + pageUrl，由 UI
	 * 降级为「在浏览器打开」——更新日志拿不到不该打断用户，更不该弹错误。
	 */
	ipcMain.handle(ipcChannels.appGetChangelog, async (_event, language?: unknown, forceRefresh?: unknown): Promise<ChangelogPayload> => {
		const lang: ChangelogLanguage = language === "en" ? "en" : "zh";
		const refresh = forceRefresh === true;
		// 每次调用读最新更新源：用户可在设置里随时切换，服务实例需随之重建源顺序。
		// 缓存目录挂 userData：TTL 内秒开零网络，网络失败时也能拿旧缓存兜底。
		const service = new ChangelogService({
			source: () => normalizeUpdateSource(settingsStore.get().updateSource),
			cacheDir: join(app.getPath("userData"), "changelog-cache"),
		});
		// pageUrl 先算好：无论拉取成功与否，降级入口都要有地址可用。
		const pageUrl = service.changelogPageUrl(lang);
		try {
			const result = await service.getChangelog(lang, { forceRefresh: refresh });
			if (!result) {
				void appLogger.info("changelog", "All sources failed and no cached copy exists", { lang });
				return {
					markdown: null,
					source: null,
					versionCount: 0,
					pageUrl,
					fetchedAt: null,
					fromCache: false,
					stale: false,
				};
			}
			return {
				markdown: result.markdown,
				source: result.source,
				versionCount: result.versionCount,
				pageUrl,
				fetchedAt: result.fetchedAt,
				fromCache: result.fromCache,
				stale: result.stale,
			};
		} catch (error) {
			// getChangelog 内部已吞掉单源错误，走到这里属意外异常：只记日志，仍降级返回。
			void appLogger.warn("changelog", "Failed to fetch changelog", {
				lang,
				error: error instanceof Error ? error.message : String(error),
			});
			return {
				markdown: null,
				source: null,
				versionCount: 0,
				pageUrl,
				fetchedAt: null,
				fromCache: false,
				stale: false,
			};
		}
	});

	ipcMain.handle(ipcChannels.appRestart, async () => {
		if (isQuitting) isQuitting.value = true;
		await webServiceManager?.stop();
		terminalManager?.closeAll();
		agentManager?.stopAll();
		app.relaunch();
		app.quit();
	});

	// 与托盘「退出 PiDeck」同语义：先置 isQuitting，再 app.quit()。
	// 不能复用 appWindowClose——开启 closeToTray 时 win.close() 只 hide，崩溃页再藏起来用户就退不掉。
	ipcMain.handle(ipcChannels.appQuit, () => {
		if (isQuitting) isQuitting.value = true;
		app.quit();
	});

	// 打开数据目录：userData 目录必然已存在，无需 mkdir；shell.openPath 是 Electron 跨平台 API，
	// 会自动选择系统文件管理器（Windows 资源管理器 / macOS Finder / Linux xdg-open），
	// 不手拼平台命令，避免 Windows 路径空格/分隔符问题。
	ipcMain.handle(ipcChannels.appOpenDataDir, async (): Promise<{ ok: boolean; error?: string }> => {
		const error = await openSystemPath(app.getPath("userData"));
		return error ? { ok: false, error } : { ok: true };
	});

	const mainWindow = getMainWindow();

	ipcMain.handle(ipcChannels.appWindowMinimize, () => {
		const win = getMainWindow();
		if (!win || win.isDestroyed()) return;
		win.minimize();
	});
	/**
	 * 最大化态以本进程跟踪为准，不用「调用后立刻 isMaximized()」。
	 * Windows + 无边框上 maximize/unmaximize 后同步读 isMaximized() 常仍是旧值；
	 * 若再把该旧值经 IPC/事件推回渲染层，会与按钮意图互踩 → 表现为要点两次。
	 */
	const wiredMaximizeWindows = new WeakSet<Electron.BrowserWindow>();
	const maximizedByWindow = new WeakMap<Electron.BrowserWindow, boolean>();
	const emitMaximizedState = (win: Electron.BrowserWindow, maximized: boolean) => {
		if (win.isDestroyed()) return;
		maximizedByWindow.set(win, maximized);
		win.webContents.send(ipcChannels.appWindowMaximizedChanged, maximized);
	};
	const wireMaximizeEvents = (win: Electron.BrowserWindow) => {
		if (wiredMaximizeWindows.has(win)) return;
		wiredMaximizeWindows.add(win);
		maximizedByWindow.set(win, win.isMaximized());
		// 信事件名，不信事件回调里再读 isMaximized()（同一帧可能仍为旧值）。
		win.on("maximize", () => emitMaximizedState(win, true));
		win.on("unmaximize", () => emitMaximizedState(win, false));
	};
	const readMaximized = (win: Electron.BrowserWindow): boolean => maximizedByWindow.get(win) ?? win.isMaximized();
	ipcMain.handle(ipcChannels.appWindowToggleMaximize, () => {
		const win = getMainWindow();
		if (!win || win.isDestroyed()) return false;
		wireMaximizeEvents(win);
		const nextMaximized = !readMaximized(win);
		if (nextMaximized) win.maximize();
		else win.unmaximize();
		// 先写入意图态并推送：不依赖异步事件到达顺序，一次点击即可对齐图标。
		emitMaximizedState(win, nextMaximized);
		return nextMaximized;
	});
	ipcMain.handle(ipcChannels.appWindowIsMaximized, () => {
		const win = getMainWindow();
		if (!win || win.isDestroyed()) return false;
		wireMaximizeEvents(win);
		return readMaximized(win);
	});
	{
		const win = getMainWindow();
		if (win && !win.isDestroyed()) wireMaximizeEvents(win);
	}
	ipcMain.handle(ipcChannels.appWindowToggleAlwaysOnTop, () => {
		const win = getMainWindow();
		if (!win || win.isDestroyed()) return false;
		const next = !win.isAlwaysOnTop();
		win.setAlwaysOnTop(next, "floating");
		return next;
	});
	// 供渲染层初始化置顶按钮态：读真实状态而非硬编码 false，
	// 避免「窗口实际置顶、按钮却显示关」的错位（用户反馈的开关需切换一次才正常）。
	ipcMain.handle(ipcChannels.appWindowIsAlwaysOnTop, () => {
		const win = getMainWindow();
		if (!win || win.isDestroyed()) return false;
		return win.isAlwaysOnTop();
	});
	ipcMain.handle(ipcChannels.appWindowClose, () => {
		const win = getMainWindow();
		if (!win || win.isDestroyed()) return;
		win.close();
	});

	// ── 开发者控制台 ───────────────────────────────────────────────

	ipcMain.handle(ipcChannels.appToggleDevTools, () => toggleMainWindowDevTools(getMainWindow()));
}
