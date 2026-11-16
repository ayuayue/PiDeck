/**
 * preload app 域：应用级：设置/更新/日志与诊断、提示音、公告、模型目录。
 *
 * 组装口 `src/preload/index.ts` 只做 spread；方法体 / 参数名 / 通道引用与拆分前逐字一致。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { subscribe } from "./ipcHelpers";
import type { AppInfo, AppLogLevel, AppUpdateStatusSnapshot, CustomSoundInfo, FeedbackEnvironment, FeedbackProjectContext, MirrorHealthResult, SoundAlertPlayEvent, SoundImportResult, UpdateChannelInfo, WebNetworkAddress } from "../../shared/types";
import type { AnnouncementState } from "../../shared/types/announcement";
import type { CatalogCheckResult, CatalogUpdateResult, CatalogUpdateStatus } from "../../shared/types/catalog";

export const appApi = {
	app: {
		info: () => ipcRenderer.invoke(ipcChannels.appInfo) as Promise<AppInfo>,
		networkAddresses: () => ipcRenderer.invoke(ipcChannels.appNetworkAddresses) as Promise<WebNetworkAddress[]>,
		preferredSystemLanguages: () => ipcRenderer.invoke(ipcChannels.appPreferredSystemLanguages) as Promise<string[]>,
		/** 手动触发一次更新检查（检测结果经 onUpdateStatus 快照推送；不弹窗）。 */
		checkUpdate: () => ipcRenderer.invoke(ipcChannels.appCheckUpdate) as Promise<void>,
		/** 当前构建所属更新通道（stable/dev，编译期判定）与应用版本。 */
		getChannel: () => ipcRenderer.invoke(ipcChannels.appGetChannel) as Promise<UpdateChannelInfo>,
		/** 手动下载已检测到的新版本（自动下载关闭时用）。 */
		downloadUpdate: () => ipcRenderer.invoke(ipcChannels.appDownloadUpdate) as Promise<void>,
		/** 重启并安装已下载的更新（退出 → 静默替换 → 自动重启新版）。 */
		installUpdate: () => ipcRenderer.invoke(ipcChannels.appInstallUpdate) as Promise<void>,
		/** 订阅后台更新检查快照（角标 + toast + 设置页卡片）。 */
		onUpdateStatus: (callback: (snapshot: AppUpdateStatusSnapshot) => void) => subscribe(ipcChannels.appUpdateStatusChanged, callback),
		/** 获取当前更新状态快照（手动检测完成后刷新角标用）。 */
		getUpdateStatus: () => ipcRenderer.invoke(ipcChannels.appUpdateStatusChanged) as Promise<AppUpdateStatusSnapshot | null>,
		/** 记录已提示过的版本（每版本只提示一次）。 */
		notifyUpdateSeen: (kind: "app" | "pi", version: string) => ipcRenderer.invoke(ipcChannels.appUpdateNotifySeen, kind, version) as Promise<void>,
		/** 跳过某版本（该版本不再主动提示）。 */
		skipUpdateVersion: (version: string) => ipcRenderer.invoke(ipcChannels.appUpdateSkipVersion, version) as Promise<void>,
		/** 探测内置更新镜像可用性与速度（设置页「更新源」）。 */
		checkUpdateMirrors: () => ipcRenderer.invoke(ipcChannels.appCheckUpdateMirrors) as Promise<MirrorHealthResult[]>,
		feedbackEnvironment: () => ipcRenderer.invoke(ipcChannels.appFeedbackEnvironment) as Promise<FeedbackEnvironment>,
		/** 问题反馈「新建会话分析」：读取项目根 AGENTS.md（截断）与项目级技能列表。 */
		getFeedbackProjectContext: (projectId: string) => ipcRenderer.invoke(ipcChannels.appFeedbackProjectContext, projectId) as Promise<FeedbackProjectContext>,
		openExternal: (url: string, forceSystem?: boolean) => ipcRenderer.invoke(ipcChannels.appOpenExternal, url, forceSystem) as Promise<void>,
		/** 拉取更新日志正文（带本地缓存）；markdown=null 时用 pageUrl 降级为浏览器打开。
		 *  forceRefresh=true 跳过缓存 TTL 强制拉最新（「刷新」按钮）。 */
		getChangelog: (language?: "zh" | "en", forceRefresh?: boolean) => ipcRenderer.invoke(ipcChannels.appGetChangelog, language, forceRefresh) as Promise<import("../../shared/types").ChangelogPayload>,
		onOpenInBrowser: (callback: (url: string) => void) => subscribe(ipcChannels.appOpenInBrowser, callback),
		onOpenSettings: (callback: () => void) => subscribe(ipcChannels.appOpenSettings, callback),
		/** 全局快捷键命中广播（新建会话/搜索会话）；回调收到 ShortcutId，渲染层自行判断是否执行 */
		onShortcutTriggered: (callback: (id: import("../../shared/shortcuts").ShortcutId) => void) => subscribe(ipcChannels.appShortcutTriggered, callback),
		restart: () => ipcRenderer.invoke(ipcChannels.appRestart) as Promise<void>,
		quit: () => ipcRenderer.invoke(ipcChannels.appQuit) as Promise<void>,
		// 打开 PiDeck 数据目录（配置/会话/诊断），文件管理器由主进程按平台选择
		openDataDir: () => ipcRenderer.invoke(ipcChannels.appOpenDataDir) as Promise<{ ok: boolean; error?: string }>,
		rendererLog: (level: AppLogLevel, scope: string, message: string, detail?: unknown) => ipcRenderer.invoke(ipcChannels.rendererLog, level, scope, message, detail) as Promise<void>,
		minimizeWindow: () => ipcRenderer.invoke(ipcChannels.appWindowMinimize) as Promise<void>,
		toggleMaximizeWindow: () => ipcRenderer.invoke(ipcChannels.appWindowToggleMaximize) as Promise<boolean>,
		isWindowMaximized: () => ipcRenderer.invoke(ipcChannels.appWindowIsMaximized) as Promise<boolean>,
		onWindowMaximizedChange: (callback: (maximized: boolean) => void) => subscribe(ipcChannels.appWindowMaximizedChanged, callback),
		// 缩放快捷键在主进程改 zoomFactor 后推送新比例，渲染层据此同步设置态
		onZoomFactorChange: (callback: (zoomFactor: number) => void) => subscribe(ipcChannels.appZoomFactorChanged, callback),
		toggleAlwaysOnTopWindow: () => ipcRenderer.invoke(ipcChannels.appWindowToggleAlwaysOnTop) as Promise<boolean>,
		isWindowAlwaysOnTop: () => ipcRenderer.invoke(ipcChannels.appWindowIsAlwaysOnTop) as Promise<boolean>,
		closeWindow: () => ipcRenderer.invoke(ipcChannels.appWindowClose) as Promise<void>,
		toggleDevTools: () => ipcRenderer.invoke(ipcChannels.appToggleDevTools) as Promise<boolean>,
	},
	sounds: {
		/** 订阅主进程推送的声音提醒播放事件（完成/出错/等待输入） */
		onPlay: (callback: (event: SoundAlertPlayEvent) => void) => subscribe(ipcChannels.soundsPlay, callback),
		/** 列出自定义音频（userData/sounds/），设置页下拉选项用 */
		listCustom: () => ipcRenderer.invoke(ipcChannels.soundsListCustom) as Promise<CustomSoundInfo[]>,
		/** 弹选择框导入自定义音频；取消/非法/超限返回结构化错误 */
		importCustom: () => ipcRenderer.invoke(ipcChannels.soundsImportCustom) as Promise<SoundImportResult>,
		/** 删除自定义音频文件 */
		removeCustom: (name: string) => ipcRenderer.invoke(ipcChannels.soundsRemoveCustom, name) as Promise<boolean>,
	},
	announcements: {
		/** 拉取当前公告快照（主进程返回缓存态，不触发网络请求） */
		list: () => ipcRenderer.invoke(ipcChannels.announcementList) as Promise<AnnouncementState>,
		/** 手动刷新公告（设置页/入口按钮；主进程防重入，并发调用安全） */
		refresh: () => ipcRenderer.invoke(ipcChannels.announcementRefresh) as Promise<AnnouncementState>,
		/** 标记单条公告已读（幂等） */
		markRead: (id: string) => ipcRenderer.invoke(ipcChannels.announcementMarkRead, id) as Promise<boolean>,
		/** 全部已读 */
		markAllRead: () => ipcRenderer.invoke(ipcChannels.announcementMarkAllRead) as Promise<boolean>,
		/**
		 * 记录已弹过提醒的公告 id（批量幂等）。与 markRead 分离：关掉 toast 不等于已读。
		 * 持久化在主进程，保证「每条公告只弹一次」跨重启/崩溃重载成立。
		 */
		markNotified: (ids: readonly string[]) => ipcRenderer.invoke(ipcChannels.announcementMarkNotified, ids) as Promise<boolean>,
		/** 订阅公告快照推送（定时拉取/已读变更后触发）；返回退订函数，组件卸载必须调用 */
		onChanged: (callback: (state: AnnouncementState) => void) => subscribe(ipcChannels.announcementChanged, callback),
	},
	// ── 模型目录（pi-ai-catalog）：查询状态 / 检查更新 / 从 GitHub 更新 / 还原 / 恢复备份 ──
	catalog: {
		status: () => ipcRenderer.invoke(ipcChannels.catalogUpdateStatus) as Promise<CatalogUpdateStatus>,
		check: (branch: "main" | "dev") => ipcRenderer.invoke(ipcChannels.catalogUpdateCheck, branch) as Promise<CatalogCheckResult>,
		updateFromGithub: (branch: "main" | "dev") => ipcRenderer.invoke(ipcChannels.catalogUpdateFromGithub, branch) as Promise<CatalogUpdateResult>,
		restore: () => ipcRenderer.invoke(ipcChannels.catalogUpdateRestore) as Promise<CatalogUpdateResult>,
		restorePrevious: () => ipcRenderer.invoke(ipcChannels.catalogUpdateRestorePrevious) as Promise<CatalogUpdateResult>,
		/** 用系统默认程序打开当前生效的目录文件（覆盖层优先，否则内置） */
		openFile: () => ipcRenderer.invoke(ipcChannels.catalogOpenFile) as Promise<void>,
	},
};
