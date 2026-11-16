// 主窗口创建：窗口构造、启动尺寸/呈现态、渲染层加载与主窗口事件接线（自 index.ts 原样搬出）。
// 宿主单例与启动装配仍归 index.ts，这里只经 MainWindowDeps 读写建窗真正用到的那几项。
import { app, BrowserWindow, nativeTheme, screen, session } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { is } from "@electron-toolkit/utils";
import type { ShortcutInput } from "../../shared/shortcuts";
import { composeAppTitle } from "../../shared/appTitle";
import { ipcChannels } from "../../shared/ipc";
import { classifyRendererNoise, RendererNoiseAggregator, toRendererNoiseLog } from "../../shared/rendererNoise";
import { resolveAppColorScheme } from "../../shared/themeSchedule";
import type { AppLogLevel, AppSettings, StartupWindowMode } from "../../shared/types";
import type { UpdateChannel } from "../../shared/types/app";
import type { DataEnvMode } from "../../shared/types/dataEnv";
import iconPath from "../../../build/icon.png?asset";
import { isShortcutInput } from "../appShortcuts";
import { resolveLogoImage } from "../appWindowLogo";
import { readDataEnvDecision, validateStartupDataEnv, writeDataEnvDecision } from "../dataEnv/dataEnvMarker";
import { KEEP_DEV_HTTP_CACHE_ENV, clearDevRendererCache } from "../devRendererCache";
import { isSharedDevBranch } from "../devIsolation";
import { toggleMainWindowDevTools } from "../devTools";
import { applyE2EWindowPlacement, type E2EWindowPlacement } from "../e2eWindowMode";
import type { FloatingController } from "../floating/FloatingController";
import type { AppLogger } from "../logging/AppLogger";
import type { QuickTaskWindowChrome } from "../quickTask/quickTaskWindowChrome";
import type { SettingsStore } from "../settings/SettingsStore";
import { rendererHeapAdditionalArguments } from "../v8HeapLimits";
import type { MainWindowVisualIntent } from "../windowReveal";
import type { RendererCrashRecoveryGuard } from "../window/rendererCrashRecovery";
import { constrainWindowBoundsToWorkArea, MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, readLastWindowBounds, type LastWindowBounds } from "../windowState";

/**
 * createWindow 用到的宿主状态。
 * 单例与开关（settings / logger / 退出标志 / mainWindow）都必须经 getter 逐次读取：
 * 建窗可能发生在 whenReady 装配前后（版本单实例 focus 激活），读的时候才取才是原语义。
 */
export interface MainWindowDeps {
	getSettings(): AppSettings;
	createWindowOptions(): ReturnType<SettingsStore["createWindowOptions"]>;
	getAppLogger(): AppLogger;
	getIsQuitting(): boolean;
	setIsQuitting(quitting: boolean): void;
	setMainWindow(window: BrowserWindow): void;
	setMainWindowVisualIntent(intent: MainWindowVisualIntent): void;
	getFloatingController(): FloatingController | null;
	/** 启动期只读常量（窗口侧不改写）。 */
	isE2E: boolean;
	e2eWindowPlacement: E2EWindowPlacement;
	isolateDevByGitBranch: boolean;
	devGitBranch: string | undefined;
	petEnabledAtLaunch: boolean;
	updateChannel: UpdateChannel;
	devDataMode: DataEnvMode | null;
	bootAnchorMs: number;
	quickTaskChrome: QuickTaskWindowChrome;
	rendererCrashGuard: RendererCrashRecoveryGuard;
	handleWindowZoomShortcut: (input: ShortcutInput) => boolean;
	/** index.ts 内的装配 helper：窗口之外另有使用者，仍归 index.ts。 */
	prepareMainPreloadPath(): Promise<string>;
	openExternalUrl(url: string, forceSystem?: boolean): Promise<void>;
	configureBrowserPanelWebviewHost(window: BrowserWindow): void;
	shouldShowMainWindowImmediately(): boolean;
	resolveStartupWindowBounds(mode: StartupWindowMode): { width: number; height: number };
	applyStartupWindowMode(window: BrowserWindow, mode: StartupWindowMode, showImmediately: boolean): void;
	shouldUseDevRendererUrl(): boolean;
	applyNativeThemeSource(settings: AppSettings): void;
	printStartupInfo(): void;
	trackMainWindowVisualIntent(window: BrowserWindow): void;
	rearmStandbyAgentOnFocus(): void;
	syncSelectionToolShortcut(): void;
	flushSelectionShortcutConflictNotice(): void;
	flushPendingFocusTargetOnLoad(): void;
}

export async function createMainWindow(deps: MainWindowDeps): Promise<BrowserWindow> {
	// 建窗依赖分两类：不可变（const / 函数声明）一次取用，调用点与搬迁前逐字一致；
	// 可变单例（settingsStore / appLogger / isQuitting / mainWindow …）逐次经 getter 读，保持「用时才取」的原语义。
	const { isE2E, e2eWindowPlacement, isolateDevByGitBranch, devGitBranch, petEnabledAtLaunch, updateChannel, devDataMode, bootAnchorMs } = deps;
	const { quickTaskChrome, rendererCrashGuard, handleWindowZoomShortcut } = deps;
	const { prepareMainPreloadPath, openExternalUrl, configureBrowserPanelWebviewHost, shouldShowMainWindowImmediately } = deps;
	const { resolveStartupWindowBounds, applyStartupWindowMode, shouldUseDevRendererUrl, applyNativeThemeSource } = deps;
	const { printStartupInfo, trackMainWindowVisualIntent, rearmStandbyAgentOnFocus, syncSelectionToolShortcut } = deps;
	const { flushSelectionShortcutConflictNotice, flushPendingFocusTargetOnLoad } = deps;
	applyNativeThemeSource(deps.getSettings());
	const windowOptions = deps.createWindowOptions();
	// 窗口首帧图标必须在这里定：启动阶段的 applyWindowLogoStyle 早于建窗执行（那时 mainWindow 还是 null），
	// 只靠那一处会永远落回 build/icon.png —— 冷启动时任务栏/Alt-Tab 图标跟不住 logoStyle。
	const initialWindowLogo = resolveLogoImage(deps.getSettings().logoStyle, deps.getSettings().logoCustomImage);
	const showMainWindowImmediately = shouldShowMainWindowImmediately();
	const sourcePreloadPath = join(__dirname, "../preload/index.js");
	const mainPreloadPath = await prepareMainPreloadPath();
	void deps.getAppLogger().info("app", "Main window preload configured", {
		sourcePreloadPath,
		preloadPath: mainPreloadPath,
		sourceExists: existsSync(sourcePreloadPath),
		exists: existsSync(mainPreloadPath),
		appPath: app.getAppPath(),
		userDataPath: app.getPath("userData"),
		packaged: app.isPackaged,
		isDev: is.dev,
		electronRendererUrl: process.env.ELECTRON_RENDERER_URL ? "set" : "unset",
	});

	// 根据用户的主题设置选择窗口背景色，避免系统标题栏与暗色主题间出现浅色条带。
	// 色值与 foundation.css 的 light/dark 基底保持一致（暖白 / 暖黑）。
	const windowThemeSettings = deps.getSettings();
	const isDark =
		resolveAppColorScheme({
			theme: windowThemeSettings.theme,
			themeScheduleLightStart: windowThemeSettings.themeScheduleLightStart,
			themeScheduleDarkStart: windowThemeSettings.themeScheduleDarkStart,
			systemPrefersDark: nativeTheme.shouldUseDarkColors,
		}) === "dark";
	const backgroundColor = isDark ? "#121212" : "#f8f8f5";

	// 按外观设置的启动预设调整初始尺寸；隐藏态先 maximize/fullscreen，减少首帧跳动。
	// startupWindowMode="last"：读上次关闭时的窗口几何（位置/尺寸/是否最大化）；
	// 读不到（首次启动/记录损坏）顺延默认 maximized。上次是最大化时先按记录的 normal 几何
	// 建窗再 maximize，还原后回到原位置。
	const requestedMode = deps.getSettings().startupWindowMode ?? "last";
	let effectiveStartupMode = requestedMode;
	let startupBounds: LastWindowBounds;
	if (requestedMode === "last") {
		const last = readLastWindowBounds(app.getPath("userData"));
		if (last) {
			startupBounds = last;
			// 全屏优先于最大化：两条记录同时存在时（全屏必然也是最大化）要回到全屏。
			if (last.fullscreen) effectiveStartupMode = "fullscreen";
			else if (last.maximized) effectiveStartupMode = "maximized";
		} else {
			effectiveStartupMode = "maximized";
			startupBounds = resolveStartupWindowBounds("maximized");
		}
	} else {
		startupBounds = resolveStartupWindowBounds(requestedMode);
	}

	// 有记录位置时以该位置所在显示器为恢复目标（多屏下回到原来那块屏）；无位置（预设模式 /
	// 旧版只存宽高的记录）以主显示器为确定目标并居中。纯逻辑负责裁尺寸、钳位置。
	const targetDisplay = typeof startupBounds.x === "number" && typeof startupBounds.y === "number" ? screen.getDisplayMatching({ x: startupBounds.x, y: startupBounds.y, width: startupBounds.width, height: startupBounds.height }) : screen.getPrimaryDisplay();
	const startupWindowBounds = constrainWindowBoundsToWorkArea(startupBounds, targetDisplay.workArea);

	const mainWindow = new BrowserWindow({
		show: showMainWindowImmediately,
		backgroundColor,
		x: startupWindowBounds.x,
		y: startupWindowBounds.y,
		width: startupWindowBounds.width,
		height: startupWindowBounds.height,
		minWidth: MIN_WINDOW_WIDTH,
		minHeight: MIN_WINDOW_HEIGHT,
		// 多 worktree 并行 dev：标题带分支名，任务栏/Alt-Tab 一眼区分窗口；
		// 显示名称走 composeAppTitle 与渲染层 document.title 同源（后者会覆盖此处的初值）
		title: composeAppTitle(deps.getSettings().appDisplayName, isolateDevByGitBranch && !isSharedDevBranch(devGitBranch) ? devGitBranch : undefined),
		icon: initialWindowLogo?.image ?? iconPath,
		frame: windowOptions.frame,
		titleBarStyle: windowOptions.titleBarStyle,
		...(windowOptions.trafficLightPosition ? { trafficLightPosition: windowOptions.trafficLightPosition } : {}),
		webPreferences: {
			preload: mainPreloadPath,
			sandbox: false,
			contextIsolation: true,
			nodeIntegration: false,
			webviewTag: true,
			// E2E 窗口在屏幕外/无系统焦点时也必须持续渲染：否则定时器与合成被动节流，用例会随机超时。
			...(isE2E ? { backgroundThrottling: false } : {}),
			// 渲染进程 V8 堆上限：必须覆盖 Chromium 透传的全局 `--js-flags`（#213）
			additionalArguments: rendererHeapAdditionalArguments(),
		},
	});
	const createdWindow = mainWindow;
	deps.setMainWindow(createdWindow);
	// Windows 建窗时可能裁掉工作区外的不可见 resize border；构造参数不足以精确还原贴边外框。
	// 显示/最大化前显式设置已解析的几何，避免重启后高度再次被原生建窗流程缩短。
	createdWindow.setBounds(startupWindowBounds);
	// E2E：挪到屏幕外再显示（默认），避免每个用例的新窗口弹到用户桌面最前；失败保持原摆放。
	applyE2EWindowPlacement(createdWindow, e2eWindowPlacement);
	configureBrowserPanelWebviewHost(createdWindow);
	let hasShownMainWindow = false;
	function showMainWindowOnce() {
		if (createdWindow.isDestroyed() || hasShownMainWindow) return;
		hasShownMainWindow = true;
		if (isE2E) {
			// E2E 静默：showInactive 显示但不激活，不抢用户焦点
			createdWindow.showInactive();
		} else {
			createdWindow.show();
			createdWindow.focus();
		}
		// 冷启动里程碑（2/2）：首窗可见（ready-to-show / did-finish-load / 3s 兜底三路共用此口）。
		void deps.getAppLogger()?.info("app", "Cold start milestone: first window shown", {
			sinceModuleLoadMs: Date.now() - bootAnchorMs,
			processUptimeMs: Math.round(process.uptime() * 1000),
		});
		// 向开发者工具输出启动信息
		printStartupInfo();
	}

	// 窗口保持隐藏时先按启动预设调整（maximize/fullscreen），再加载页面；
	// 避免 ready-to-show 后再调整造成首帧布局跳变。
	applyStartupWindowMode(mainWindow, effectiveStartupMode, showMainWindowImmediately);
	// 记住本窗口的呈现态：唤起（托盘/通知/宠物）时由 revealMainWindow 重新施加。
	const mainWindowVisualIntent = effectiveStartupMode === "fullscreen" ? "fullscreen" : effectiveStartupMode === "maximized" ? "maximized" : "normal";
	deps.setMainWindowVisualIntent(mainWindowVisualIntent);
	trackMainWindowVisualIntent(createdWindow);

	// 所有 target="_blank" 或 window.open 的链接统一经同一入口处理，遵守用户设置的打开方式。
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		void openExternalUrl(url);
		return { action: "deny" };
	});
	mainWindow.webContents.on("did-start-loading", () => {
		void deps.getAppLogger().info("app", "Main window load started", {
			url: mainWindow?.webContents.getURL(),
		});
	});
	// 聚焦补热 standby：见 rearmStandbyAgentOnFocus 注释（节流 + ensure 幂等，热路径无感）。
	mainWindow.on("focus", () => rearmStandbyAgentOnFocus());
	mainWindow.webContents.on("did-finish-load", () => {
		void deps.getAppLogger().info("app", "Main window load finished", {
			url: mainWindow?.webContents.getURL(),
		});
		// 恢复用户设置的窗口缩放；在 did-finish-load 后应用，避免早期设置被覆盖。
		mainWindow?.webContents.setZoomFactor(deps.getSettings().zoomFactor);
		// 系统级划词快捷键在建窗前注册失败（常见于另一个 PiDeck 实例占用）时重试并补发提示；
		// renderer 若尚未订阅 toast，后续 focus 会再兜底一次（通知去重）。
		syncSelectionToolShortcut();
		flushSelectionShortcutConflictNotice();
		// 加载期排队的通知跳转目标补发一次（renderer 挂载后还会主动拉取，幂等兜底）
		flushPendingFocusTargetOnLoad();
		// —— 数据环境通知（规格 §6：首帧后与渲染层对齐目录归属）——
		// dev 打包首启未决策 → 请渲染层弹数据模式选择（本会话临时落共用目录运行）；
		// 未打包 dev 恒走开发隔离目录，不弹。
		if (updateChannel === "dev" && app.isPackaged && devDataMode === null) {
			mainWindow?.webContents.send(ipcChannels.dataEnvDecisionRequired);
		}
		// 目录标记与通道匹配校验（存量无标记 → ok 不打扰）：stable 包落在 channel-dev 目录才 mismatch。
		const markerInDataDir = readDataEnvDecision(app.getPath("userData"));
		if (markerInDataDir && validateStartupDataEnv(updateChannel, markerInDataDir) === "mismatch") {
			mainWindow?.webContents.send(ipcChannels.dataEnvMismatchDetected, { dataModeInDir: markerInDataDir.dataMode });
		}
		// 共用目录存量标记补写（向后兼容：无标记视为 shared，首启补一次，之后只在缺失时写）。
		if (updateChannel === "stable" && markerInDataDir === null) {
			writeDataEnvDecision(app.getPath("userData"), "shared", app.getVersion());
		}
	});
	mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
		void deps.getAppLogger().error("app", "Main window load failed", {
			errorCode,
			errorDescription,
			validatedURL,
			isMainFrame,
		});
	});
	mainWindow.webContents.on("render-process-gone", (_event, details) => {
		const level: AppLogLevel = details.reason === "clean-exit" ? "info" : "error";
		void deps.getAppLogger().log(level, "app", "Main window renderer process gone", {
			...details,
			platform: process.platform,
			arch: process.arch,
		});
		// 黑屏治理：非正常崩溃自动 reload 恢复；clean-exit（正常退出）、用户主动退出
		// 与崩溃风暴（窗口期内超限）不恢复。reload 前检查窗口/webContents 仍存活。
		const isQuitting = deps.getIsQuitting();
		if (isQuitting || !rendererCrashGuard.shouldAutoReload(details.reason)) return;
		void deps.getAppLogger().warn("app", "Auto-reloading main window after renderer crash", {
			reason: details.reason,
			exitCode: details.exitCode,
			recoveriesInWindow: rendererCrashGuard.recoveriesInWindow(),
		});
		if (mainWindow && !mainWindow.isDestroyed()) {
			try {
				mainWindow.webContents.reload();
			} catch (error) {
				// reload 抛异常（webContents 已销毁等竞态）：记日志，留给用户手动处理
				void deps.getAppLogger().error("app", "Auto-reload failed", error);
			}
		}
	});
	// 子进程（含 GPU/utility）异常退出监听已提到模块级 app.on（见 before-quit 附近）：
	// 注册在 createWindow 内会随窗口重建（macOS activate）重复叠监听器。
	mainWindow.webContents.on("preload-error", (_event, preloadPath, error) => {
		void deps.getAppLogger().error("app", "Main window preload failed", {
			preloadPath,
			message: error.message,
			stack: error.stack,
		});
	});
	mainWindow.webContents.on("dom-ready", () => {
		void mainWindow?.webContents
			.executeJavaScript("Boolean(window.piDesktop)", true)
			.then((hasPiDesktop) => {
				void deps.getAppLogger().info("app", "Main window preload API availability", {
					hasPiDesktop,
					url: mainWindow?.webContents.getURL(),
				});
			})
			.catch((error) => {
				void deps.getAppLogger().warn("app", "Main window preload API check failed", error);
			});
	});
	// 渲染层 console 噪音聚合（issue #376）：良性事件（ResizeObserver loop）由 renderer 自己的
	// 全局处理器统一落盘，这里直接跳过——否则同一事件两条管道各写一遍。非良性首条即时写盘，
	// 窗口内重复折叠成一条降档汇总（循环报错不再把「最近 7 天报错」统计灌满）。
	const rendererConsoleNoise = new RendererNoiseAggregator();
	mainWindow.webContents.on("console-message", (event) => {
		if (!["warning", "error"].includes(event.level)) return;
		// 良性噪音：renderer 的 window.onerror 已按同一聚合器写一条 ×N 的 info，此处不重复落盘。
		if (classifyRendererNoise(event.message).benign) return;
		// 渲染层 console 镜像只作排查线索，不参与健康统计：这里聚集的是第三方/框架的原始输出
		// （KaTeX strict 警告、React 开发期提示等，实测 40k+ 行/天），按 error/warn 记会让
		// EnvironmentDoctor 的「最近 7 天报错 / 警告明细」被噪音填满。降一档：error → warn、
		// warning → info（仍按天写进日志文件，可检索）。真正的渲染层故障由 main.tsx 的
		// rendererLog 显式上报（uncaught error / unhandled rejection），那条链路仍是 error。
		const level: AppLogLevel = event.level === "error" ? "warn" : "info";
		const detail = { level: event.level, message: event.message, line: event.lineNumber, sourceId: event.sourceId };
		for (const flush of rendererConsoleNoise.record(`console|${event.level}|${event.message.slice(0, 120)}`, level, "Main window renderer console error", { detail })) {
			const log = toRendererNoiseLog(flush);
			void deps.getAppLogger().log(log.level, "app", log.message, log.detail);
		}
	});

	mainWindow.once("ready-to-show", showMainWindowOnce);
	mainWindow.webContents.once("did-finish-load", showMainWindowOnce);
	setTimeout(showMainWindowOnce, 3000);
	if (showMainWindowImmediately) {
		showMainWindowOnce();
	}

	// 窗口大小记忆：关闭/退出前保存 normal bounds（最大化/全屏时取恢复后的尺寸），
	// 供下次 startupWindowMode="last" 启动使用；隐藏到托盘不记录（窗口未关闭）。
	// 注意：mainWindow 在 index.ts 是模块级可空变量，此处用创建后的局部引用确保非空
	const windowForState = createdWindow;
	windowForState.on("close", () => quickTaskChrome.saveWorkbenchBoundsOnClose(windowForState));
	// 聚合器无定时器：窗口销毁时补齐尾部计数（「刷了一路却一条没写」会丢诊断）
	windowForState.on("closed", () => {
		for (const flush of rendererConsoleNoise.flushAll()) {
			const log = toRendererNoiseLog(flush);
			void deps.getAppLogger().log(log.level, "app", log.message, log.detail);
		}
	});

	// 关闭窗口时根据设置决定：隐藏到托盘还是正常退出
	mainWindow.on("close", (event) => {
		const isQuitting = deps.getIsQuitting();
		if (!isQuitting && quickTaskChrome.interceptClose(event)) return;
		if (!isQuitting && deps.getSettings().floatingBallEnabled) {
			// 悬浮球开启时，关闭主窗口 = 隐藏到悬浮球（不退出）
			event.preventDefault();
			mainWindow?.hide();
			void deps.getFloatingController()?.show();
		} else if (!isQuitting && deps.getSettings().closeToTray) {
			event.preventDefault();
			mainWindow?.hide();
		} else if (!isQuitting) {
			// 如果没有启用托盘，关闭窗口时直接退出应用
			deps.setIsQuitting(true);
			app.quit();
		}
	});

	// 监听全局快捷键（打开设置 / 开发者工具 / 新建会话 / 搜索会话，键位见 shared/shortcuts.ts，
	// 可设置页自定义）；devTools 组合键的 macOS 变体与开关逻辑集中在 devTools.ts，
	// 主窗口/webview/设置 IPC 共用。新建/搜索是渲染层 UI 动作（引导页/命令面板），
	// 这里只做命中与广播，由渲染层按焦点状态决定是否执行（输入框聚焦时忽略）。
	mainWindow.webContents.on("before-input-event", (event, input) => {
		if (!mainWindow || mainWindow.isDestroyed()) return;
		if (isShortcutInput("openSettings", input)) {
			event.preventDefault();
			// 快捷键可能命中在窗口隐藏（托盘）期间：先唤起窗口，再让渲染层打开设置页
			if (!mainWindow.isVisible()) mainWindow.show();
			mainWindow.webContents.send(ipcChannels.appOpenSettings);
			return;
		}
		// 窗口缩放：主进程直接改 zoomFactor 并持久化，只回推新比例同步设置态
		if (handleWindowZoomShortcut(input)) {
			event.preventDefault();
			return;
		}
		if (isShortcutInput("openNewSession", input)) {
			event.preventDefault();
			mainWindow.webContents.send(ipcChannels.appShortcutTriggered, "openNewSession");
			return;
		}
		if (isShortcutInput("openSearch", input)) {
			event.preventDefault();
			mainWindow.webContents.send(ipcChannels.appShortcutTriggered, "openSearch");
			return;
		}
		// 会话内查找：与 openSearch（跨会话）分开，默认 Ctrl/Cmd+Shift+F；由聚焦的会话栏
		// 自己响应（分屏时只作用于用户正在看的那一栏），主进程不持有会话上下文。
		if (isShortcutInput("findInSession", input)) {
			event.preventDefault();
			mainWindow.webContents.send(ipcChannels.appShortcutTriggered, "findInSession");
			return;
		}
		if (isShortcutInput("openCommandPalette", input)) {
			event.preventDefault();
			mainWindow.webContents.send(ipcChannels.appShortcutTriggered, "openCommandPalette");
			return;
		}
		// 模型/思考强度循环：目标是「当前聚焦会话」，由渲染层按聚焦栏定位会话并复用
		// 模型选择器的应用链路（main 不持有会话上下文，也不复刻 pi 的 scoped models）。
		if (isShortcutInput("cycleModel", input)) {
			event.preventDefault();
			mainWindow.webContents.send(ipcChannels.appShortcutTriggered, "cycleModel");
			return;
		}
		if (isShortcutInput("cycleThinking", input)) {
			event.preventDefault();
			mainWindow.webContents.send(ipcChannels.appShortcutTriggered, "cycleThinking");
			return;
		}
		// 快捷消息浮层：目标是「当前聚焦会话」的输入框底栏，主进程只负责转发广播，
		// 由渲染层按聚焦栏定位会话并唤出浮层（main 不持有会话上下文，见 renderer 的
		// useQuickMessagePopover / ownsQuickMessageShortcut）。
		// 注意本项不受「输入框聚焦时不触发」约束：它的用途就是打字途中插口令。
		if (isShortcutInput("openQuickMessages", input)) {
			event.preventDefault();
			mainWindow.webContents.send(ipcChannels.appShortcutTriggered, "openQuickMessages");
			return;
		}
		// 语音输入开关：与快捷消息同理，输入框聚焦时仍然生效——录音恰恰发生在打字现场。
		if (isShortcutInput("toggleVoiceRecording", input)) {
			event.preventDefault();
			mainWindow.webContents.send(ipcChannels.appShortcutTriggered, "toggleVoiceRecording");
			return;
		}
		// Ctrl(+Shift)+Tab 循环切换会话标签页：Tab 顺序在渲染层 atoms，主进程只命中广播。
		// 输入框聚焦时仍生效（浏览器同款惯例，Ctrl+Tab 无文本编辑含义）。
		if (isShortcutInput("cycleSessionTabs", input)) {
			event.preventDefault();
			mainWindow.webContents.send(ipcChannels.appShortcutTriggered, "cycleSessionTabs");
			return;
		}
		if (isShortcutInput("cycleSessionTabsReverse", input)) {
			event.preventDefault();
			mainWindow.webContents.send(ipcChannels.appShortcutTriggered, "cycleSessionTabsReverse");
			return;
		}
		// Cmd/Ctrl+W 关闭当前会话标签页：与 Ctrl+Tab 同链路；「回答中先弹确认、确认后停止并关闭」
		// 由渲染层判定（main 不持有会话上下文）。
		if (isShortcutInput("closeSessionTab", input)) {
			event.preventDefault();
			mainWindow.webContents.send(ipcChannels.appShortcutTriggered, "closeSessionTab");
			return;
		}
		if (isShortcutInput("toggleDevTools", input)) {
			event.preventDefault();
			toggleMainWindowDevTools(mainWindow);
		}
	});

	const devRendererUrl = shouldUseDevRendererUrl() ? process.env.ELECTRON_RENDERER_URL : undefined;
	if (devRendererUrl) {
		// Vite 预构建 chunk 是 immutable 强缓存，重新预构建后同一 URL 内容会变但缓存键不变，
		// 渲染层会拿到旧模块去 import 已被删除的 chunk（504）→ 动态 import 失败；dev 加载前先清一次。
		await clearDevRendererCache({
			session: session.defaultSession,
			keepHttpCacheFlag: process.env[KEEP_DEV_HTTP_CACHE_ENV],
			onLog: (outcome, detail) => void deps.getAppLogger().info("app", `dev renderer http cache ${outcome}`, detail),
		});
		mainWindow.loadURL(devRendererUrl);
	} else {
		mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
	}
	return createdWindow;
}
