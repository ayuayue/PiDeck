import { app, type BrowserWindow } from "electron";
import { join } from "node:path";
import { ipcChannels } from "../../shared/ipc";
import { resolveDshRuntimeIndexUrl } from "../../shared/types/dshRuntimeManifest";
import { createNetDownloader, createTarExtractor, fetchDshRuntimeIndex } from "../dsh/runtime/dshRuntimeIo";
import { DSH_BUNDLED_RUNTIME_DIRNAME, DshRuntimeManager, readBundledRuntime, readDeclaredDshVersion } from "../dsh/runtime/DshRuntimeManager";
import { DshRuntimeInstaller } from "../dsh/runtime/DshRuntimeInstaller";
import { DshRuntimeStatusService } from "../dsh/runtime/DshRuntimeStatus";
import { resolveDshRuntimeReleaseTag } from "../dsh/runtime/dshRuntimeReleaseTarget";
import type { AppLogger } from "../logging/AppLogger";
import type { SettingsStore } from "../settings/SettingsStore";

/**
 * DSH runtime 装配（阶段 2；自 index.ts 的 whenReady 装配体就地外移，行为零变化）：
 * 管理器（外部 runtime 落在 userData/runtimes/dsh/<version>）→ 安装态服务 → 安装编排器。
 */
export interface DshRuntimeContext {
	readonly appLogger: AppLogger;
	readonly getMainWindow: () => BrowserWindow | null;
	readonly settingsStore: SettingsStore;
	readonly assign: (patch: { dshRuntimeManager: DshRuntimeManager; dshRuntimeStatus: DshRuntimeStatusService; dshRuntimeInstaller: DshRuntimeInstaller }) => void;
}

export function startDshRuntime(ctx: DshRuntimeContext): void {
	const { appLogger, getMainWindow, settingsStore, assign } = ctx;

	// DSH runtime 管理器（阶段 2）：外部 runtime 落在 userData/runtimes/dsh/<version>。
	// 暂存目录与版本目录同级，便于整体清理；两者都在 userData 内，卸载应用时一并带走。
	const dshRuntimeManager = new DshRuntimeManager({
		layout: {
			runtimesRoot: join(app.getPath("userData"), "runtimes", "dsh"),
			tempRoot: join(app.getPath("userData"), "runtimes", ".tmp"),
		},
		appVersion: () => app.getVersion(),
		download: createNetDownloader((scope, message, detail) => void appLogger.warn(scope, message, detail)),
		extract: createTarExtractor((scope, message, detail) => void appLogger.warn(scope, message, detail)),
		log: (scope, message, detail) => void appLogger.info(scope, message, detail),
	});
	// 「本版本配套哪个 dsh runtime」只有一个事实源：状态服务的门控与安装器的挑版本
	// 必须同源，否则会出现「门控要 0.2.0-rc.2、安装器装 0.1.5-rc.1 并报成功」的死循环。
	const declaredDshVersion = () => readDeclaredDshVersion(app.getAppPath());
	// DSH runtime 安装态服务先于 DshHost 装配（探测只依赖 appPath，不 fork host）。
	// 探测顺序：外部已装 runtime 优先 → 兼容旧版 full/存量包时才回退 app 内置。
	// 官方 lite 包与 dev 都把 runtime 获取统一到 userData 外部目录，未安装时从同一份
	// Release 索引下载；这样开发环境验证的就是用户实际走的远程安装链路。
	// allowBundledFallback 仅保留给显式 full/存量包兼容，不再按 app.isPackaged 区分；
	// 新的 dev/lite 默认关闭，避免项目 node_modules 或残留资源绕过远程安装。
	const dshRuntimeStatus = new DshRuntimeStatusService(
		() => app.getAppPath(),
		(scope, message, detail) => void appLogger.info(scope, message, detail),
		() => {
			const active = dshRuntimeManager.resolveActive();
			return active ? { nodeModules: active.nodeModules, runtimeVersion: active.manifest.runtimeVersion } : undefined;
		},
		// dev 不把项目 node_modules 当成「已安装 runtime」；统一走外部 Release 下载。
		() => false,
		// 保留构造位次供旧调用方兼容；安装入口现在由状态服务统一开放，不读取打包态。
		() => app.isPackaged,
		// 声明的配套 dsh 版本（package.json）：与已装 runtime 比对得出 updateAvailable，
		// 升级 app 后旧 runtime 仍「兼容」会被一直选用，UI 需要这个信号提示更新。
		declaredDshVersion,
	);
	dshRuntimeStatus.subscribe((status) => {
		const mainWindow = getMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send(ipcChannels.dshRuntimeStatusChanged, status);
		}
	});
	// runtime 安装编排：索引拉取 + 选版本 + 落位，进度统一广播给渲染层。
	// 索引地址默认指向与 app update 同一仓库的 release 资产，settings 可覆盖为镜像。
	const dshRuntimeInstaller = new DshRuntimeInstaller({
		manager: dshRuntimeManager,
		// 优先级：环境变量（本地/内网验证用，免改设置）> 设置项（镜像）> 当前 latest 应用 Release。
		// 禁止独立 dsh-runtime tag：会抢走 GitHub /releases/latest。
		indexUrl: () =>
			resolveDshRuntimeIndexUrl({
				indexUrl: process.env.DSH_RUNTIME_INDEX_URL || settingsStore.get().dshRuntimeIndexUrl,
				updateSource: settingsStore.get().updateSource,
			}),
		updateSource: () => settingsStore.get().updateSource,
		releaseTag: () =>
			resolveDshRuntimeReleaseTag({
				explicitTag: process.env.PIDECK_RELEASE_TAG,
				isPackaged: app.isPackaged,
				appVersion: app.getVersion(),
			}),
		appVersion: () => app.getVersion(),
		// 与状态服务同源：安装只认这个配套版本，索引里没有就报错而不是退装旧版。
		declaredVersion: declaredDshVersion,
		fetchIndex: fetchDshRuntimeIndex,
		// dev 与官方 lite 包统一走远程 Release；只给显式 full/存量包保留离线兼容入口。
		// 通过显式环境变量开启，避免开发机或新包因残留资源误绕过远程下载链路。
		bundledRuntime: () => (process.env.PIDECK_DSH_ALLOW_BUNDLED_RUNTIME === "1" ? readBundledRuntime(process.resourcesPath ? join(process.resourcesPath, DSH_BUNDLED_RUNTIME_DIRNAME) : undefined, app.getVersion()) : undefined),
		onProgress: (progress) => {
			const mainWindow = getMainWindow();
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.webContents.send(ipcChannels.dshRuntimeInstallProgress, progress);
			}
		},
		log: (scope, message, detail) => void appLogger.info(scope, message, detail),
	});
	assign({ dshRuntimeManager, dshRuntimeStatus, dshRuntimeInstaller });
}
