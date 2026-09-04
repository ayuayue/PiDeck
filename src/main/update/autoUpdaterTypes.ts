/**
 * UpdateService 依赖的 electron-updater 最小接口（测试可注入 fake；真实实现见 createAutoUpdater）。
 * 与 electron-updater 官方类型解耦：类型收窄为业务需要的事件/方法子集。
 */

export type AutoUpdaterProgress = {
	percent: number;
	bytesPerSecond: number;
	transferred: number;
	total: number;
};

export type AutoUpdaterEventHandlers = {
	/** checkForUpdates 开始（electron-updater 的 checking-for-update）。 */
	onChecking?: () => void;
	/** 检测到新版本（version = 目标版本；willDownload = autoDownload 已开启，下载会自动开始）。 */
	onUpdateAvailable?: (version: string, willDownload: boolean) => void;
	onDownloadProgress?: (progress: AutoUpdaterProgress) => void;
	/** 下载完成（version = 已下载的版本）。 */
	onUpdateDownloaded?: (version: string) => void;
	/** 检查通过且无新版本。 */
	onUpdateNotAvailable?: () => void;
	onError?: (error: string) => void;
};

export type AutoUpdaterLike = {
	/** 是否自动下载（设置页「自动下载更新」开关；需在 checkForUpdates 前设置）。 */
	setAutoDownload: (enabled: boolean) => void;
	isAutoDownload: () => boolean;
	/** 检查更新。autoDownload=true 时检测到新版本内部自动开始下载（事件驱动）。 */
	checkForUpdates: () => Promise<void>;
	/** 手动下载已检测到的新版本（autoDownload=false 时用）。 */
	downloadUpdate: () => Promise<void>;
	/** 重启并安装已下载的更新（退出 → 静默替换 → 重启新版）。 */
	quitAndInstall: () => void;
	/** 注册事件监听，返回退订函数（组件/服务停止时配对清理）。 */
	onEvents: (handlers: AutoUpdaterEventHandlers) => () => void;
};
