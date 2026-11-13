import { app, net, session, shell, type BrowserWindow } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { AppManualUpdateRelease, AppUpdateStatusSnapshot, UpdateChannel } from "../../shared/types/app";
import type { BuiltInExtensionPathRoots } from "../extensions/builtInExtensions";
import { resolveBuiltInExtensionsDir, resolveVendorNodeModulesDir } from "../extensions/builtInExtensions";
import { BuiltInExtensionsUpdater } from "../extensions/builtInExtensionsUpdater";
import type { ExtensionManager } from "../extensions/ExtensionManager";
import { openSystemPath } from "../fs/openPath";
import type { AppLogger } from "../logging/AppLogger";
import { setPiAiCatalogUserDataDir } from "../pi/piAiBuiltinCatalog";
import { PiAiCatalogUpdater } from "../pi/PiAiCatalogUpdater";
import type { SettingsStore } from "../settings/SettingsStore";
import { installAtomgitNoCacheBypass, UPDATER_PARTITION_NAME } from "../update/atomgitNoCacheBypass";
import { createRealAutoUpdater } from "../update/createAutoUpdater";
import { resolveAppUpdateDeliveryPlan } from "../update/deliveryPlan";
import { downloadInstallerAsset, type InstallerDownloadProgress } from "../update/installerDownload";
import { detectMacDeveloperIdSignature } from "../update/macCodeSignature";
import { createManualUpdateChecker } from "../update/macManualUpdate";
import { resolveManualUpdateTarget } from "../update/manualUpdateSelection";
import { UpdateService } from "../update/UpdateService";

/**
 * 本块真正用到的装配输入。`updateService` 是 index.ts 的模块级 `let`（检查更新 IPC、退出清理
 * 与 systemStack 都读它），所以这里不持有第二份：构造经 `assign` 回填 owner。
 * `isQuitting` / `mainWindow` / `extensionManager` 走 getter：它们的写入点在别处，
 * 闭包里必须读到调用时的当前值。
 */
export interface AppUpdateContext {
	readonly appLogger: AppLogger;
	readonly getExtensionManager: () => ExtensionManager;
	readonly getIsQuitting: () => boolean;
	readonly getMainWindow: () => BrowserWindow | null;
	/** 内置扩展磁盘根（index.ts 的唯一解析入口，热更新器与 -e 注入路径必须同源）。 */
	readonly resolveBuiltInExtensionRoots: () => BuiltInExtensionPathRoots;
	/** 安装前把主进程置为真退出（closeToTray 会吞掉普通窗口关闭）。 */
	readonly setIsQuitting: (value: boolean) => void;
	readonly settingsStore: SettingsStore;
	readonly updateChannel: UpdateChannel;
	readonly assign: (patch: AppUpdateServicePatch) => void;
}

/** 写点：启动装配时给初值（index.ts 侧同名变量类型本就含 `null`）。 */
export interface AppUpdateServicePatch {
	readonly updateService?: UpdateService | null;
}

/** 装配出的同批实例：index.ts 紧接着用它们注册 contentStack（目录/内置扩展更新 IPC）。 */
export interface AppUpdateServices {
	readonly catalogUpdater: PiAiCatalogUpdater;
	readonly builtInExtensionsUpdater: BuiltInExtensionsUpdater;
}

/**
 * 启动装配（自 index.ts 的 `registerIpc()` 装配体就地外移，语句顺序与搬迁前一致）：
 * 模型目录更新器 → 内置扩展热更新器与覆盖层自愈 → AtomGit noCache 剥除器 →
 * UpdateService（manual / automatic 两条交付分支）→ start()。
 * 交付模式按设备能力判定，两条路径都由同一个 UpdateService 快照推送渲染层。
 */
export function startAppUpdate(ctx: AppUpdateContext): AppUpdateServices {
	const { appLogger, settingsStore, updateChannel } = ctx;

	// 模型目录更新器：设置页手动更新与 UpdateService 第三路定时检查共用同一实例。
	// 覆盖层目录须在 catalog 初次读取前登记（getPiAiCatalogIndex 首次调用即锁定索引）；
	// app 已 ready 后 app.getPath("userData") 才可靠，故在此提前构造。
	setPiAiCatalogUserDataDir(app.getPath("userData"));
	const catalogUpdater = new PiAiCatalogUpdater({
		userDataDir: app.getPath("userData"),
		// 目录更新/检测复用应用更新的源偏好（settings.updateSource）：
		// github → raw 直连优先；atomgit 等 → AtomGit OpenAPI 优先，两者互为兜底。
		source: () => settingsStore.get().updateSource,
	});
	// 内置扩展热更新：版本号不跟 PiDeck 应用版本走（见 resources/extensions/extensions-manifest.json），
	// 打包态 resources 只读，更新写进 userData 覆盖层，路径解析侧覆盖层优先 → 重启会话即生效。
	const builtInExtensionRoots = ctx.resolveBuiltInExtensionRoots();
	const builtInExtensionsUpdater = new BuiltInExtensionsUpdater({
		userDataDir: app.getPath("userData"),
		builtinExtensionsDir: resolveBuiltInExtensionsDir(builtInExtensionRoots),
		// vendored 运行时依赖（node_modules/undici 等）的源目录：覆盖层上层没有 node_modules，
		// 缺了它 pi 会因扩展裸导入解析不到而启动失败（2026-09-15 线上事故）。
		vendorNodeModulesDir: resolveVendorNodeModulesDir(builtInExtensionRoots),
		// 与模型目录/应用更新共用 settings.updateSource：默认 AtomGit，切 GitHub 后 raw 直连优先。
		source: () => settingsStore.get().updateSource,
	});
	// 旧覆盖层（没有 vendored 依赖的版本写的）启动自愈，不能要求用户先点一次「更新」
	builtInExtensionsUpdater.ensureOverlayVendorDependencies();
	// 后台更新检查：Windows / 支持自动升级的发行物走 electron-updater；
	// macOS 当前未签 Developer ID，不能承诺稳定的替换/重启，因此只检测 Release 并交给用户手动安装。
	// 两条路径都由同一个 UpdateService 快照推送渲染层，设置页能明确表达能力边界。
	// AtomGit 镜像源对 query string 返回 404，而 electron-updater 检查必带 noCache 参数：
	// 在 updater 首次发起请求前注册 webRequest 剥除器（幂等）。注意必须挂在
	// electron-updater 的独立 partition session（"electron-updater"）上，而不是 defaultSession
	// —— updater 的 ElectronHttpExecutor 用 session.fromPartition("electron-updater") 发请求，
	// 挂在 defaultSession 会拦不到（0.7.5 曾因此漏修）。
	installAtomgitNoCacheBypass(() => session.fromPartition(UPDATER_PARTITION_NAME, { cache: false }));
	const updateServiceBase = {
		settingsStore,
		// 更新通道（dev/stable，启动时已判定）：dev 开启 allowPrerelease，更新源仍跟随设置（见 UpdateService.applyUpdateSource）。
		channel: updateChannel,
		checkPiUpdate: () => ctx.getExtensionManager().checkPiUpdate(),
		// 模型目录：复用设置页同一检查链路（GitHub main 分支 manifest 比对），结果并入更新快照。
		checkCatalogUpdate: () => catalogUpdater.checkRemote(),
		// 目录自动更新：检测到新版本后由 UpdateService 按设置（catalogAutoUpdate，默认开）自动拉取，
		// 与设置页「更新到最新」按钮共用同一 updater（含校验与备份）。
		updateCatalog: () => catalogUpdater.update(),
		sendToRenderer: (snapshot: AppUpdateStatusSnapshot) => {
			const mainWindow = ctx.getMainWindow();
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send(ipcChannels.appUpdateStatusChanged, snapshot);
			}
		},
		log: (level: "info" | "warn", message: string, details?: Record<string, unknown>) => {
			if (level === "warn") void appLogger.warn("update", message, details ?? {});
			else void appLogger.info("update", message, details ?? {});
		},
		getCurrentVersion: () => app.getVersion(),
	};
	// quitAndInstall 会调用 app.quit；该标记让 closeToTray 放行真正的退出。
	let updateInstallSetQuitting = false;
	// 交付模式按设备能力判定：Linux arm64 / deb / tar.gz 没有可靠的应用内替换链路，
	// 与 macOS 无签名发行物一样走 manual（检查更新 + 一键下载设备匹配安装包）；
	// macOS Developer ID 签名包由运行时 codesign 探测识别，走 electron-updater 自动替换。
	const appUpdateDelivery = resolveAppUpdateDeliveryPlan({
		platform: process.platform,
		arch: process.arch,
		isAppImage: Boolean(process.env.APPIMAGE),
		macDeveloperIdSigned: detectMacDeveloperIdSignature({ isPackaged: app.isPackaged }),
	});
	const manualUpdateTarget = resolveManualUpdateTarget({
		platform: process.platform,
		arch: process.arch,
		isPortable: process.env.PORTABLE_EXECUTABLE_DIR !== undefined,
		isAppImage: Boolean(process.env.APPIMAGE),
		execPath: process.execPath,
		runningUnderArm64Translation: app.runningUnderARM64Translation === true,
	});
	let updateService: UpdateService;
	if (appUpdateDelivery.mode === "manual") {
		const checkManualUpdate = createManualUpdateChecker({ channel: updateChannel, target: manualUpdateTarget });
		updateService = new UpdateService({
			...updateServiceBase,
			deliveryMode: "manual",
			deliveryReason: appUpdateDelivery.reason,
			// latestReleaseUrl（镜像源）由 UpdateService 按设置传入；null = 官方 GitHub。
			checkManualAppUpdate: (latestReleaseUrl?: string) => checkManualUpdate(app.getVersion(), latestReleaseUrl),
			// 手动交付的安装包落到系统下载目录；文件名/digest 来自检查阶段匹配的 release 资产。
			downloadManualUpdate: (release: AppManualUpdateRelease, options: { signal?: AbortSignal; onProgress?: (progress: InstallerDownloadProgress) => void }) =>
				downloadInstallerAsset({
					assetName: release.assetName,
					assetUrl: release.assetUrl,
					digestSha256: release.digestSha256,
					targetDir: app.getPath("downloads"),
					netFetch: (url, init) => net.fetch(url, init),
					signal: options.signal,
					onProgress: options.onProgress,
				}),
			// macOS 打开 dmg 让用户拖入 Applications；其他平台只定位文件，绝不自动运行未知安装包。
			openManualInstaller: async (filePath: string) => {
				if (process.platform === "darwin") {
					const error = await openSystemPath(filePath);
					if (error) throw new Error(error);
					return;
				}
				shell.showItemInFolder(filePath);
			},
		});
	} else {
		updateService = new UpdateService({
			...updateServiceBase,
			deliveryMode: "automatic",
			autoUpdater: createRealAutoUpdater(),
			// closeToTray 会吞掉普通窗口关闭；安装器必须等待真实主进程退出。
			prepareForInstall: () => {
				updateInstallSetQuitting = !ctx.getIsQuitting();
				ctx.setIsQuitting(true);
			},
			// 同步失败或 watchdog 超时才会走这里；正常 quitAndInstall 会直接结束进程。
			rollbackInstallPreparation: () => {
				if (updateInstallSetQuitting) ctx.setIsQuitting(false);
				updateInstallSetQuitting = false;
			},
		});
	}
	// 模块级 let 的唯一 owner 仍是 index.ts：检查更新 IPC / 退出清理 / systemStack 都读它。
	ctx.assign({ updateService });
	updateService.start();

	return { catalogUpdater, builtInExtensionsUpdater };
}
