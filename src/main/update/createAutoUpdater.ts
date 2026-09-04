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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AutoUpdaterLike, AutoUpdaterEventHandlers } from "./autoUpdaterTypes";
import { UPDATE_REPO_OWNER, UPDATE_REPO } from "./releaseRepo";

export type { AutoUpdaterLike, AutoUpdaterEventHandlers } from "./autoUpdaterTypes";

/** 测试/镜像源覆盖：dev 构建或 E2E 指向本地 generic feed 时经环境变量注入。 */
export const UPDATE_FEED_URL_ENV = "PIDEK_UPDATE_FEED_URL";

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
	const feedUrl = options?.feedUrl ?? process.env[UPDATE_FEED_URL_ENV];
	// 显式传入（如 E2E/受控测试）与环境变量 feed 为最高优先级：
	// 后续 settings.applyUpdateSource() 的运行时切换不得覆盖它（否则测试/调试会被设置项压掉）。
	const feedOverride = feedUrl ?? null;
	if (feedUrl) {
		// generic provider 为本地 E2E / 受控镜像源：开发态默认禁用 updater，
		// 必须显式开启 forceDevUpdateConfig 才会真的请求该 feed。
		autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
		autoUpdater.forceDevUpdateConfig = true;
		if (process.env.PIDECK_E2E === "1") {
			// electron-updater 下载时还会从 updateConfigPath 读取 updaterCacheDirName。
			// 测试运行的 out/main 不含 dev-app-update.yml，因此在隔离 userData 生成最小配置，
			// 不污染源码/正式包，也避免依赖真实发布配置。
			const configPath = join(app.getPath("userData"), "pideck-e2e-app-update.yml");
			mkdirSync(app.getPath("userData"), { recursive: true });
			writeFileSync(
				configPath,
				`provider: generic\nurl: ${feedUrl}\nupdaterCacheDirName: pideck-e2e-updater\n`,
				"utf8",
			);
			autoUpdater.updateConfigPath = configPath;
			// 本地 E2E 不存在上一版本安装器/blockmap；验证完整文件校验下载即可。
			autoUpdater.disableDifferentialDownload = true;
		}
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
