/**
 * electron-updater 真实封装（只在 Electron 主进程构造）。
 *
 * 为什么单独一层：electron-updater 依赖 Electron 运行时（app.getVersion 等），
 * 不能在 node --test 进程内 import；UpdateService 只依赖 AutoUpdaterLike 接口，
 * 测试注入 fake，真实实例由 index.ts 装配时经本模块创建。
 *
 * 事件映射（对齐 Netcatty/electron-updater 用法）：
 *   - autoDownload=true（默认）：checkForUpdates 检测到新版本后自动开始下载，
 *     无需用户二次操作——满足「检测到就后台下载，不弹窗打扰」的产品语义；
 *   - autoInstallOnAppQuit=false：下载完成不自动装，等用户点「重启并安装」。
 */

import { app } from "electron";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AutoUpdaterLike, AutoUpdaterEventHandlers } from "./autoUpdaterTypes";
import { UPDATE_REPO_OWNER, UPDATE_REPO } from "./releaseRepo";

export type { AutoUpdaterLike, AutoUpdaterEventHandlers } from "./autoUpdaterTypes";

/** 测试/镜像源覆盖：dev 构建或 E2E 指向本地 generic feed 时经环境变量注入。 */
export const UPDATE_FEED_URL_ENV = "PIDEK_UPDATE_FEED_URL";

/** 兜底更新缓存目录名，与 electron-builder 默认规则（name + "-updater"）对齐。 */
export const DEFAULT_UPDATER_CACHE_DIR_NAME = "pi-desktop-updater";

/** 自动生成的兜底配置文件文件名，存放在应用 userData 目录中。 */
export const FALLBACK_APP_UPDATE_CONFIG_FILENAME = "pideck-fallback-app-update.yml";

/**
 * 生成兜底的 app-update.yml 内容。
 *
 * 为什么需要：Windows 便携版（target: portable）由 electron-builder 打包时，
 * 默认不会在 resources 目录下生成 app-update.yml（该文件由 nsis 安装包专享）。
 * electron-updater 在 downloadUpdate 阶段必须通过 configOnDisk 读取 updaterCacheDirName，
 * 缺失会导致 ENOENT: no such file or directory, open '...resources/app-update.yml' 错误。
 * 在此动态生成合法的 GitHub provider 兜底配置。
 */
export function generateFallbackAppUpdateConfigYaml(options?: {
	owner?: string;
	repo?: string;
	updaterCacheDirName?: string;
}): string {
	const owner = options?.owner ?? UPDATE_REPO_OWNER;
	const repo = options?.repo ?? UPDATE_REPO;
	const cacheDirName = options?.updaterCacheDirName ?? DEFAULT_UPDATER_CACHE_DIR_NAME;
	return `owner: ${owner}\nrepo: ${repo}\nprovider: github\nupdaterCacheDirName: ${cacheDirName}\n`;
}

/**
 * 解析当前环境下 electron-updater 默认寻找的 app-update.yml 路径。
 * - 打包环境：resources/app-update.yml
 * - 开发环境：dev-app-update.yml
 */
export function resolveDefaultAppUpdateConfigPath(
	isPackaged: boolean,
	resourcesPath: string,
	appPath: string,
): string {
	return isPackaged
		? join(resourcesPath, "app-update.yml")
		: join(appPath, "dev-app-update.yml");
}

export type EnsureAppUpdateConfigDeps = {
	isPackaged: boolean;
	resourcesPath: string;
	appPath: string;
	userDataPath: string;
	existsSync: (path: string) => boolean;
	mkdirSync: (path: string, options: { recursive: boolean }) => unknown;
	writeFileSync: (path: string, content: string, encoding: BufferEncoding) => void;
	owner?: string;
	repo?: string;
	updaterCacheDirName?: string;
};

/**
 * 检查默认配置是否存在；若缺失（如 Windows 便携版），在 userData 中创建兜底配置文件并返回其路径。
 * 若默认配置已存在，返回 null。
 */
export function ensureAppUpdateConfig(deps: EnsureAppUpdateConfigDeps): string | null {
	const defaultPath = resolveDefaultAppUpdateConfigPath(
		deps.isPackaged,
		deps.resourcesPath,
		deps.appPath,
	);
	if (deps.existsSync(defaultPath)) {
		return null;
	}
	const fallbackPath = join(deps.userDataPath, FALLBACK_APP_UPDATE_CONFIG_FILENAME);
	const yamlContent = generateFallbackAppUpdateConfigYaml({
		owner: deps.owner,
		repo: deps.repo,
		updaterCacheDirName: deps.updaterCacheDirName,
	});
	try {
		deps.mkdirSync(deps.userDataPath, { recursive: true });
		deps.writeFileSync(fallbackPath, yamlContent, "utf8");
		return fallbackPath;
	} catch {
		return null;
	}
}

/**
 * 判断是否应禁用差量下载（differential download）。
 *
 * 业务规则：
 * 1. Windows 便携版或无默认配置时：用户本地没有历史 NSIS 安装包及缓存，
 *    尝试差量下载只会造成无意义的 blockmap 请求失败和额外开销，直接下载完整安装包最可靠。
 * 2. E2E 测试环境同样禁用差量下载。
 */
export function shouldDisableDifferentialDownload(options: {
	isPortable?: boolean;
	hasDefaultConfig?: boolean;
	isE2E?: boolean;
}): boolean {
	if (options.isE2E) return true;
	if (options.isPortable) return true;
	if (options.hasDefaultConfig === false) return true;
	return false;
}

/**
 * 创建真实 electron-updater 包装。
 * @param options.environment 测试注入的 feed URL（development 构建可用）。
 */
export function createRealAutoUpdater(options?: {
	feedUrl?: string;
	isAutoDownloadEnabled?: () => boolean;
}): AutoUpdaterLike {
	// 延迟 require：模块顶层 import electron-updater 会在纯 Node 测试进程崩。
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { autoUpdater } = require("electron-updater") as {
		autoUpdater: import("electron-updater").AppUpdater;
	};

	// 1. 挂载兜底配置（必须在 setFeedURL 之前，避免 updateConfigPath setter 将 clientPromise 置空）
	const defaultAppUpdateConfigPath = resolveDefaultAppUpdateConfigPath(
		app.isPackaged,
		process.resourcesPath,
		app.getAppPath(),
	);
	const hasDefaultConfig = existsSync(defaultAppUpdateConfigPath);

	if (process.env.PIDECK_E2E === "1") {
		// E2E 隔离环境配置
		const feedUrl = options?.feedUrl ?? process.env[UPDATE_FEED_URL_ENV];
		const configPath = join(app.getPath("userData"), "pideck-e2e-app-update.yml");
		mkdirSync(app.getPath("userData"), { recursive: true });
		writeFileSync(
			configPath,
			`provider: generic\nurl: ${feedUrl}\nupdaterCacheDirName: pideck-e2e-updater\n`,
			"utf8",
		);
		autoUpdater.updateConfigPath = configPath;
	} else if (!hasDefaultConfig) {
		// Windows 便携版或缺失 app-update.yml 的打包体：自动在 userData 生成兜底配置
		const fallbackConfigPath = ensureAppUpdateConfig({
			isPackaged: app.isPackaged,
			resourcesPath: process.resourcesPath,
			appPath: app.getAppPath(),
			userDataPath: app.getPath("userData"),
			existsSync,
			mkdirSync,
			writeFileSync,
			owner: UPDATE_REPO_OWNER,
			repo: UPDATE_REPO,
		});
		if (fallbackConfigPath) {
			autoUpdater.updateConfigPath = fallbackConfigPath;
		}
	}

	const isPortable = process.platform === "win32" && process.env.PORTABLE_EXECUTABLE_DIR !== undefined;
	if (
		shouldDisableDifferentialDownload({
			isPortable,
			hasDefaultConfig,
			isE2E: process.env.PIDECK_E2E === "1",
		})
	) {
		// 便携版无本地旧安装器缓存，直接完整下载，避免 blockmap 404 与差量下载错误
		autoUpdater.disableDifferentialDownload = true;
	}

	const feedUrl = options?.feedUrl ?? process.env[UPDATE_FEED_URL_ENV];
	// 显式传入（如 E2E/受控测试）与环境变量 feed 为最高优先级：
	// 后续 settings.applyUpdateSource() 的运行时切换不得覆盖它（否则测试/调试会被设置项压掉）。
	const feedOverride = feedUrl ?? null;
	if (feedUrl) {
		// generic provider 为本地 E2E / 受控镜像源：开发态默认禁用 updater，
		// 必须显式开启 forceDevUpdateConfig 才会真的请求该 feed。
		autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
		autoUpdater.forceDevUpdateConfig = true;
	}
	autoUpdater.autoDownload = options?.isAutoDownloadEnabled?.() ?? true;
	autoUpdater.autoInstallOnAppQuit = false;
	// 日志走 PiDeck 自己的日志体系（UpdateService.log），关掉 electron-updater 默认 logger。
	autoUpdater.logger = null;
	// 当前生效的镜像 feed URL（null = 官方 GitHub）；setFeedUrl 在此之上往返切换。
	let currentFeedUrl: string | null = feedOverride;

	return {
		setAutoDownload: (enabled: boolean) => {
			autoUpdater.autoDownload = enabled;
		},
		isAutoDownload: () => autoUpdater.autoDownload !== false,
		setFeedUrl: (url: string | null) => {
			// 显式/env feed 覆盖优先：设置项切换只作用于默认链路，不受测试注入影响。
			if (feedOverride) return;
			if (url === currentFeedUrl) return;
			currentFeedUrl = url;
			// 用户在设置页显式切换更新源 = 想真实检查：dev 构建同样激活 updater，
			// 否则 electron-updater 直接返回 null，用户只会看到「未激活」错误。
			// 默认 github 源不会走到这里（currentFeedUrl 初始即 null，直接 early-return），
			// 所以 dev 下不切源仍保持不检查，不打扰日常开发。
			autoUpdater.forceDevUpdateConfig = true;
			if (url) {
				// 镜像源：generic provider 整体接管检查+下载（baseUrl 已含 releases/latest/download）。
				autoUpdater.setFeedURL({ provider: "generic", url });
			} else {
				// 官方源恢复：显式重建 GitHub provider，等价于 app-update.yml 原生配置。
				// （electron-updater 的 setFeedURL 是运行时安全的：clientPromise 直接替换，无需重启。）
				autoUpdater.setFeedURL({ provider: "github", owner: UPDATE_REPO_OWNER, repo: UPDATE_REPO });
			}
		},
		checkForUpdates: async () => {
			const result = await autoUpdater.checkForUpdates();
			// electron-updater 在未激活（dev 未切镜像源）时默认静默返回 null。把它提升为错误，
			// 避免 UpdateService 把「根本未检查」误报成「已是最新」；文案给出可操作指引。
			if (!result) {
				throw new Error(
					"更新检查未激活：开发模式下默认不检查，请在设置中选择镜像更新源后重试",
				);
			}
		},
		downloadUpdate: () => autoUpdater.downloadUpdate().then(() => undefined),
		quitAndInstall: () => autoUpdater.quitAndInstall(false, true),
		onEvents: (handlers: AutoUpdaterEventHandlers) => {
			const onChecking = () => handlers.onChecking?.();
			const onAvailable = (info: { version?: string }) =>
				handlers.onUpdateAvailable?.(info.version ?? "", autoUpdater.autoDownload !== false);
			const onProgress = (progress: {
				percent?: number;
				bytesPerSecond?: number;
				transferred?: number;
				total?: number;
			}) =>
				handlers.onDownloadProgress?.({
					percent: progress.percent ?? 0,
					bytesPerSecond: progress.bytesPerSecond ?? 0,
					transferred: progress.transferred ?? 0,
					total: progress.total ?? 0,
				});
			const onDownloaded = (info: { version?: string }) =>
				handlers.onUpdateDownloaded?.(info.version ?? "");
			const onNotAvailable = () => handlers.onUpdateNotAvailable?.();
			const onErrorEvent = (error: Error) =>
				handlers.onError?.(error instanceof Error ? error.message : String(error));
			autoUpdater.on("checking-for-update", onChecking);
			autoUpdater.on("update-available", onAvailable);
			autoUpdater.on("download-progress", onProgress);
			autoUpdater.on("update-downloaded", onDownloaded);
			autoUpdater.on("update-not-available", onNotAvailable);
			autoUpdater.on("error", onErrorEvent);
			return () => {
				autoUpdater.off("checking-for-update", onChecking);
				autoUpdater.off("update-available", onAvailable);
				autoUpdater.off("download-progress", onProgress);
				autoUpdater.off("update-downloaded", onDownloaded);
				autoUpdater.off("update-not-available", onNotAvailable);
				autoUpdater.off("error", onErrorEvent);
			};
		},
	};
}
